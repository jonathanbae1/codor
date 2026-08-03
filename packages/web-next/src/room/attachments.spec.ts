// @vitest-environment happy-dom
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const transport = vi.hoisted(() => ({ fetch: vi.fn() }));
vi.mock('@runtime/relay-transport.js', () => ({ relayFetch: transport.fetch }));

import {
  loadAttachmentObjectUrl,
  uploadAttachment,
  useAttachmentDownload,
  useAttachmentObjectUrl,
  useNearViewport,
} from './attachments.js';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const bytes = (values: number[], type: string): Response =>
  new Response(new Uint8Array(values), { status: 200, headers: { 'content-type': type } });

describe('hosted attachment transport', () => {
  const createObjectURL = vi.fn<(blob: Blob) => string>();
  const revokeObjectURL = vi.fn<(url: string) => void>();

  beforeEach(() => {
    transport.fetch.mockReset();
    createObjectURL.mockReset();
    revokeObjectURL.mockReset();
    Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: createObjectURL });
    Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: revokeObjectURL });
  });

  it('uploads the exact File body and bearer authorization through relayFetch', async () => {
    transport.fetch.mockResolvedValueOnce(new Response(JSON.stringify({
      id: 'abc', name: 'pixel.png', mime: 'image/png', size: 4,
    }), { status: 200, headers: { 'content-type': 'application/json' } }));
    const file = new File([new Uint8Array([0, 1, 254, 255])], 'pixel.png', { type: 'image/png' });

    await expect(uploadAttachment('same room', 'secret', file)).resolves.toMatchObject({ id: 'abc', size: 4 });
    expect(transport.fetch).toHaveBeenCalledWith('/api/rooms/same%20room/attachments?name=pixel.png', {
      method: 'POST',
      headers: { authorization: 'Bearer secret', 'content-type': 'image/png' },
      body: expect.any(Uint8Array),
    });
    const init = transport.fetch.mock.calls[0]?.[1] as RequestInit;
    expect([...(init.body as Uint8Array)]).toEqual([0, 1, 254, 255]);
  });

  it('creates an exact-byte raster object URL without putting the token in a URL', async () => {
    transport.fetch.mockResolvedValueOnce(bytes([137, 80, 78, 71], 'image/png'));
    createObjectURL.mockReturnValueOnce('blob:raster');

    const resource = await loadAttachmentObjectUrl('room', 'image', 'image/png', 'signed-token');
    expect(transport.fetch).toHaveBeenCalledWith('/api/rooms/room/attachments/image', {
      headers: { authorization: 'Bearer signed-token' },
    });
    expect(resource?.url).toBe('blob:raster');
    const blob = createObjectURL.mock.calls[0]?.[0];
    expect(blob?.type).toBe('image/png');
    expect([...new Uint8Array(await blob!.arrayBuffer())]).toEqual([137, 80, 78, 71]);
    resource?.revoke();
    resource?.revoke();
    expect(revokeObjectURL).toHaveBeenCalledTimes(1);
  });

  it('keeps failures and unexpected executable response types inert', async () => {
    transport.fetch
      .mockResolvedValueOnce(new Response('no', { status: 404 }))
      .mockResolvedValueOnce(bytes([1], 'text/html'))
      .mockResolvedValueOnce(bytes([2], 'image/svg+xml'));

    await expect(loadAttachmentObjectUrl('r', 'missing', 'image/png', 't')).resolves.toBeUndefined();
    await expect(loadAttachmentObjectUrl('r', 'wrong-image', 'image/png', 't')).resolves.toBeUndefined();
    await expect(loadAttachmentObjectUrl('r', 'script', 'image/svg+xml', 't')).resolves.toBeUndefined();
    expect(createObjectURL).not.toHaveBeenCalled();
  });

  it('allows non-raster downloads only from the server inert octet-stream response', async () => {
    transport.fetch.mockResolvedValueOnce(bytes([60, 115, 118, 103, 62], 'application/octet-stream'));
    createObjectURL.mockReturnValueOnce('blob:download');
    await expect(loadAttachmentObjectUrl('r', 'svg', 'image/svg+xml', 't')).resolves.toMatchObject({ url: 'blob:download' });
    expect(createObjectURL.mock.calls[0]?.[0].type).toBe('application/octet-stream');
  });

  it('revokes object URLs on replacement and unmount', async () => {
    transport.fetch.mockImplementation(async () => bytes([1, 2], 'image/png'));
    createObjectURL.mockReturnValueOnce('blob:first').mockReturnValueOnce('blob:second');
    const host = document.createElement('div');
    const root = createRoot(host);
    const Consumer = (props: { id: string }) => {
      const url = useAttachmentObjectUrl('room', props.id, 'image/png', 'token');
      return createElement('span', undefined, url);
    };

    await act(async () => {
      root.render(createElement(Consumer, { id: 'one' }));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(host.textContent).toBe('blob:first');
    await act(async () => {
      root.render(createElement(Consumer, { id: 'two' }));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:first');
    expect(host.textContent).toBe('blob:second');
    await act(async () => { root.unmount(); });
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:second');
  });

  it('does not fetch a raster until its viewport gate opens', async () => {
    let intersect: IntersectionObserverCallback | undefined;
    class FakeIntersectionObserver {
      readonly root = null;
      readonly rootMargin = '800px 0px';
      readonly thresholds = [0];
      constructor(callback: IntersectionObserverCallback) { intersect = callback; }
      observe() {}
      unobserve() {}
      disconnect() {}
      takeRecords(): IntersectionObserverEntry[] { return []; }
    }
    vi.stubGlobal('IntersectionObserver', FakeIntersectionObserver);
    transport.fetch.mockResolvedValue(bytes([1], 'image/png'));
    createObjectURL.mockReturnValue('blob:near');
    const host = document.createElement('div');
    const root = createRoot(host);
    const Consumer = () => {
      const [nearRef, near] = useNearViewport();
      const url = useAttachmentObjectUrl('room', 'image', 'image/png', 'token', near);
      return createElement('span', { ref: nearRef }, url);
    };

    await act(async () => { root.render(createElement(Consumer)); });
    expect(transport.fetch).not.toHaveBeenCalled();
    await act(async () => {
      intersect?.([{ isIntersecting: true } as IntersectionObserverEntry], {} as IntersectionObserver);
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(transport.fetch).toHaveBeenCalledTimes(1);
    expect(host.textContent).toBe('blob:near');
    await act(async () => { root.unmount(); });
    vi.unstubAllGlobals();
  });

  it('falls back to eager raster loading without IntersectionObserver', async () => {
    vi.stubGlobal('IntersectionObserver', undefined);
    transport.fetch.mockResolvedValue(bytes([1], 'image/png'));
    createObjectURL.mockReturnValue('blob:fallback');
    const host = document.createElement('div');
    const root = createRoot(host);
    const Consumer = () => {
      const [nearRef, near] = useNearViewport();
      const url = useAttachmentObjectUrl('room', 'image', 'image/png', 'token', near);
      return createElement('span', { ref: nearRef }, url);
    };

    await act(async () => {
      root.render(createElement(Consumer));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(transport.fetch).toHaveBeenCalledTimes(1);
    expect(host.textContent).toBe('blob:fallback');
    await act(async () => { root.unmount(); });
    vi.unstubAllGlobals();
  });

  it('fetches a document only on click, coalesces duplicate clicks, and revokes after download', async () => {
    let resolveFetch: ((response: Response) => void) | undefined;
    transport.fetch.mockReturnValue(new Promise<Response>((resolve) => { resolveFetch = resolve; }));
    createObjectURL.mockReturnValue('blob:document');
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);
    const host = document.createElement('div');
    const root = createRoot(host);
    const Consumer = () => {
      const resource = useAttachmentDownload('room', 'document', 'text/plain', 'token', 'notes.txt');
      return createElement('button', { onClick: () => { void resource.download(); } }, 'Download');
    };

    await act(async () => { root.render(createElement(Consumer)); });
    expect(transport.fetch).not.toHaveBeenCalled();
    await act(async () => {
      host.querySelector('button')?.click();
      host.querySelector('button')?.click();
    });
    expect(transport.fetch).toHaveBeenCalledTimes(1);
    await act(async () => {
      resolveFetch?.(bytes([1, 2, 3], 'application/octet-stream'));
      await new Promise((resolve) => setTimeout(resolve, 0));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(click).toHaveBeenCalledTimes(1);
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:document');
    await act(async () => { root.unmount(); });
    click.mockRestore();
  });
});
