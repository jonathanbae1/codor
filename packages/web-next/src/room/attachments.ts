// Client half of message attachments (richard #425): upload a file to the room's
// authenticated endpoint before it rides the post frame, and build served URLs for
// rendering. Kept in web-next (not @runtime/api) so the whole feature is one batch.

import { useCallback, useEffect, useRef, useState } from 'react';

import { relayFetch } from '@runtime/relay-transport.js';

export interface UploadedAttachment {
  id: string;
  name: string;
  mime: string;
  size: number;
}

export const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;
export const MAX_ATTACHMENTS_PER_MESSAGE = 8;

/** Upload one file as a raw binary body; the server issues its id and metadata. */
export async function uploadAttachment(room: string, token: string, file: File): Promise<UploadedAttachment> {
  const body = new Uint8Array(await file.arrayBuffer());
  // harn:assume hosted-attachments-follow-active-computer-tunnel ref=hosted-attachment-transport
  const res = await relayFetch(
    `/api/rooms/${encodeURIComponent(room)}/attachments?name=${encodeURIComponent(file.name)}`,
    {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': file.type || 'application/octet-stream' },
      body,
    },
  );
  if (!res.ok) {
    const detail = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(detail.error ?? `upload failed (${String(res.status)})`);
  }
  return res.json() as Promise<UploadedAttachment>;
}

const attachmentEndpoint = (room: string, id: string): string =>
  `/api/rooms/${encodeURIComponent(room)}/attachments/${encodeURIComponent(id)}`;

// Mirrors the server's inline-render set: raster images only. Scriptable image
// types (svg) are served as downloads, so rendering them as <img> would break.
export const isImageAttachment = (mime: string): boolean =>
  /^image\/(png|jpe?g|gif|webp|avif)$/.test(mime);

export interface AttachmentObjectUrl {
  url: string;
  revoke(): void;
}

/** Fetch authenticated bytes through the active transport, then hand the DOM a
 * same-origin-free blob URL. Content-type verification keeps a bad or
 * unexpectedly scriptable response inert. */
export async function loadAttachmentObjectUrl(
  room: string,
  id: string,
  mime: string,
  token: string,
): Promise<AttachmentObjectUrl | undefined> {
  const response = await relayFetch(attachmentEndpoint(room, id), {
    headers: { authorization: `Bearer ${token}` },
  });
  if (!response.ok) return undefined;
  const contentType = response.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase();
  const expected = isImageAttachment(mime) ? mime.toLowerCase() : 'application/octet-stream';
  if (contentType !== expected) return undefined;
  const url = URL.createObjectURL(new Blob([await response.arrayBuffer()], { type: contentType }));
  let revoked = false;
  return {
    url,
    revoke: () => {
      if (revoked) return;
      revoked = true;
      URL.revokeObjectURL(url);
    },
  };
}

/** One bounded resource per mounted consumer; replacement and unmount both
 * deterministically revoke the previous object URL. */
export function useAttachmentObjectUrl(
  room: string,
  id: string,
  mime: string,
  token: string,
  enabled = true,
): string | undefined {
  const [url, setUrl] = useState<string>();
  useEffect(() => {
    let cancelled = false;
    let resource: AttachmentObjectUrl | undefined;
    setUrl(undefined);
    if (!enabled || room === '' || id === '' || token === '') return undefined;
    void loadAttachmentObjectUrl(room, id, mime, token)
      .then((loaded) => {
        resource = loaded;
        if (cancelled) loaded?.revoke();
        else setUrl(loaded?.url);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
      resource?.revoke();
    };
  }, [enabled, id, mime, room, token]);
  return url;
}

/** Transcript raster placeholders begin loading only when they enter a bounded
 * margin around the viewport. Old browsers without IntersectionObserver retain
 * a safe eager fallback instead of leaving images permanently blank. */
export function useNearViewport(): [(node: HTMLElement | null) => void, boolean] {
  const [node, setNode] = useState<HTMLElement | null>(null);
  const [near, setNear] = useState(() => typeof IntersectionObserver === 'undefined');
  const ref = useCallback((next: HTMLElement | null) => setNode(next), []);
  useEffect(() => {
    if (near || node === null) return undefined;
    if (typeof IntersectionObserver === 'undefined') {
      setNear(true);
      return undefined;
    }
    const observer = new IntersectionObserver((entries) => {
      if (!entries.some((entry) => entry.isIntersecting)) return;
      setNear(true);
      observer.disconnect();
    }, { rootMargin: '800px 0px' });
    observer.observe(node);
    return () => observer.disconnect();
  }, [near, node]);
  return [ref, near];
}

export interface AttachmentDownload {
  download(): Promise<void>;
  busy: boolean;
}

/** Fetch a non-renderable attachment only in response to an explicit operator
 * click, invoke a transient browser download, then revoke the URL. A pending
 * request is single-flight and late completions after replacement/unmount are
 * revoked without navigating. */
export function useAttachmentDownload(
  room: string,
  id: string,
  mime: string,
  token: string,
  name: string,
): AttachmentDownload {
  const [busy, setBusy] = useState(false);
  const generation = useRef(0);
  const pending = useRef<Promise<void>>();
  const resource = useRef<AttachmentObjectUrl>();
  const revokeTimer = useRef<number>();

  useEffect(() => {
    generation.current += 1;
    pending.current = undefined;
    setBusy(false);
    return () => {
      generation.current += 1;
      if (revokeTimer.current !== undefined) window.clearTimeout(revokeTimer.current);
      resource.current?.revoke();
      resource.current = undefined;
    };
  }, [id, mime, name, room, token]);

  const download = useCallback((): Promise<void> => {
    if (pending.current) return pending.current;
    if (resource.current) return Promise.resolve();
    const started = generation.current;
    setBusy(true);
    const run = loadAttachmentObjectUrl(room, id, mime, token)
      .then((loaded) => {
        if (loaded === undefined) return;
        if (generation.current !== started) {
          loaded.revoke();
          return;
        }
        resource.current = loaded;
        const anchor = document.createElement('a');
        anchor.href = loaded.url;
        anchor.download = name;
        anchor.style.display = 'none';
        document.body.append(anchor);
        anchor.click();
        anchor.remove();
        revokeTimer.current = window.setTimeout(() => {
          if (resource.current === loaded) resource.current = undefined;
          loaded.revoke();
          revokeTimer.current = undefined;
          if (generation.current === started) setBusy(false);
        }, 0);
      })
      .catch(() => undefined)
      .finally(() => {
        if (generation.current !== started) return;
        pending.current = undefined;
        if (resource.current === undefined && revokeTimer.current === undefined) setBusy(false);
      });
    pending.current = run;
    return run;
  }, [id, mime, name, room, token]);

  return { download, busy };
}
// harn:end hosted-attachments-follow-active-computer-tunnel

export function formatAttachmentSize(size: number): string {
  if (size < 1024) return `${String(size)} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}
