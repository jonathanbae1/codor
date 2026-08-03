// Client half of message attachments (richard #425): upload a file to the room's
// authenticated endpoint before it rides the post frame, and build served URLs for
// rendering. Kept in web-next (not @runtime/api) so the whole feature is one batch.

import { useEffect, useState } from 'react';

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
): string | undefined {
  const [url, setUrl] = useState<string>();
  useEffect(() => {
    let cancelled = false;
    let resource: AttachmentObjectUrl | undefined;
    setUrl(undefined);
    if (room === '' || id === '' || token === '') return undefined;
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
  }, [id, mime, room, token]);
  return url;
}
// harn:end hosted-attachments-follow-active-computer-tunnel

export function formatAttachmentSize(size: number): string {
  if (size < 1024) return `${String(size)} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}
