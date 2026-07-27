// Browser half of the Codor relay tunnel (PLAN §4.3/§4.4). Mirrors the
// switchboard RelayLink using the SAME shared @codor/tunnel primitives — the
// KK session handshake, the client-side StreamMux, and the app-WS message
// framing — so both ends stay byte-identical by construction. Real browser
// WebCrypto runs here (noble + globalThis.crypto).
import {
  MessageReassembler,
  MuxStream,
  SessionInitiator,
  StreamKind,
  StreamMux,
  frameMessage,
  type TunnelKeypair,
} from '@codor/tunnel';

const utf8 = (s: string) => new TextEncoder().encode(s);
const fromUtf8 = (b: Uint8Array) => new TextDecoder().decode(b);
const fromHex = (hex: string) => Uint8Array.from(hex.match(/.{2}/g)?.map((h) => parseInt(h, 16)) ?? []);
const fromB64 = (value: string) => {
  // Accepts base64url (how the browser stores keys) and standard base64.
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=');
  return Uint8Array.from(atob(padded), (c) => c.charCodeAt(0));
};
function concatBytes(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}

export type TunnelState = 'connecting' | 'connected' | 'disconnected';

export interface TunnelRecord {
  relay_url: string;
  session_id: string; // 64-hex
  client_static: { pub: string; priv: string }; // base64
  host_static_pub: string; // base64
}

/** Minimal WebSocket-shaped view the connector consumes from socketFactory. */
interface WebSocketLike {
  readyState: number;
  onopen: (() => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onclose: ((event: { code: number; reason: string }) => void) | null;
  onerror: ((event: unknown) => void) | null;
  send(data: string): void;
  close(): void;
}

const OPEN = 1;
const CLOSED = 3;

/** An app-WS mux stream presented as a browser-WebSocket-compatible object. */
class TunnelSocket implements WebSocketLike {
  readyState = 0; // CONNECTING
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: ((event: { code: number; reason: string }) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  /** Called when this socket reaches CLOSED so the owner can drop its reference. */
  onDetach?: () => void;
  private readonly reassembler = new MessageReassembler();

  constructor(private readonly stream: MuxStream) {
    stream.onData = (chunk) => {
      for (const message of this.reassembler.push(chunk)) this.onmessage?.({ data: fromUtf8(message) });
      stream.consume(chunk.length);
    };
    stream.onEnd = () => this.fireClose(1000, '');
    stream.onReset = (reason) => this.fireClose(4000, reason);
    // The host buffers app-WS writes until the loopback /ws opens, so opening
    // optimistically is safe; an auth failure arrives later as a RESET → close.
    queueMicrotask(() => {
      if (this.readyState !== 0) return;
      this.readyState = OPEN;
      this.onopen?.();
    });
  }

  send(data: string): void {
    if (this.readyState !== OPEN) return;
    this.stream.write(frameMessage(utf8(data)));
  }

  close(): void {
    if (this.readyState === CLOSED) return;
    try {
      this.stream.end();
    } catch {
      // already closed
    }
    this.fireClose(1000, '');
  }

  /** Force-close because the underlying session dropped (owner-driven). */
  terminate(): void {
    this.fireClose(4000, 'session-lost');
  }

  private fireClose(code: number, reason: string): void {
    if (this.readyState === CLOSED) return;
    this.readyState = CLOSED;
    this.onDetach?.();
    this.onclose?.({ code, reason });
  }
}

/**
 * Maintains the client session to the relay and exposes the two transports the
 * app already speaks: a WebSocket `socketFactory` (for /ws) and a `fetch`
 * (for /api). Reconnects with backoff; surfaces presence as TunnelState.
 */
export class TunnelClient {
  private ws?: WebSocket;
  private mux?: StreamMux;
  private channel?: ReturnType<SessionInitiator['channel']>;
  private stateValue: TunnelState = 'disconnected';
  private retryMs = 500;
  private disposed = false;
  private readonly liveSockets = new Set<TunnelSocket>();
  private readonly clientStatic: TunnelKeypair;
  private readonly hostStaticPub: Uint8Array;
  private readonly sessionIdBytes: Uint8Array;
  private readonly firstConnect: Promise<void>;
  private firstConnectResolve!: () => void;

  onStateChange?: (state: TunnelState) => void;

  constructor(private readonly record: TunnelRecord) {
    this.clientStatic = { publicKey: fromB64(record.client_static.pub), secretKey: fromB64(record.client_static.priv) };
    this.hostStaticPub = fromB64(record.host_static_pub);
    this.sessionIdBytes = fromHex(record.session_id);
    this.firstConnect = new Promise<void>((resolve) => {
      this.firstConnectResolve = resolve;
    });
  }

  get state(): TunnelState {
    return this.stateValue;
  }

  /** Resolves when the session first reaches 'connected' — auth/bootstrap waits on this. */
  whenReady(): Promise<void> {
    return this.firstConnect;
  }

  connect(): void {
    if (this.disposed || this.mux) return;
    this.setState('connecting');
    const base = this.record.relay_url.replace(/\/$/, '').replace(/^http/, 'ws');
    const ws = new WebSocket(`${base}/v1/session/${this.record.session_id}/ws?role=client`);
    ws.binaryType = 'arraybuffer';
    this.ws = ws;
    const initiator = new SessionInitiator({
      clientStatic: this.clientStatic,
      hostStaticPub: this.hostStaticPub,
      sessionId: this.sessionIdBytes,
    });
    let handshakeDone = false;
    ws.onopen = () => ws.send(initiator.start());
    ws.onmessage = (event) => {
      // The relay multiplexes JSON presence/control frames (§4.1) alongside the
      // binary handshake + mux ciphertext. With binaryType 'arraybuffer' a text
      // frame arrives as a string; treat only ArrayBuffer payloads as wire bytes.
      if (typeof event.data === 'string') {
        // The real relay keeps this socket OPEN when the host drops, so the only
        // signal is this notice — tear the session down so reconnect re-handshakes.
        let notice: { type?: string };
        try {
          notice = JSON.parse(event.data) as { type?: string };
        } catch {
          return;
        }
        if (notice.type === 'host-disconnected' || notice.type === 'unknown-conn') ws.close();
        return;
      }
      const bytes = new Uint8Array(event.data as ArrayBuffer);
      if (!handshakeDone) {
        ws.send(initiator.receiveMsg2(bytes));
        this.channel = initiator.channel();
        this.mux = new StreamMux({
          role: 'client',
          onPacket: (packet) => ws.send(this.channel!.seal(packet)),
          onStream: () => {},
        });
        handshakeDone = true;
        this.retryMs = 500;
        this.setState('connected');
        this.firstConnectResolve();
        return;
      }
      this.mux!.receivePacket(this.channel!.open(bytes));
    };
    // A failed connection fires BOTH onerror and onclose; settle once so a single
    // drop schedules exactly one reconnect (two would race two live sessions,
    // overwriting mux/channel and opening packets with the wrong key). Detaching
    // the handlers also stops a superseded socket's late events from firing.
    let settled = false;
    const fail = (): void => {
      if (settled) return;
      settled = true;
      ws.onopen = ws.onmessage = ws.onclose = ws.onerror = null;
      this.onDisconnect(ws);
    };
    ws.onclose = fail;
    ws.onerror = fail;
  }

  private onDisconnect(ws: WebSocket): void {
    // Ignore a drop from a socket we have already replaced — only the current
    // session's failure drives the reconnect.
    if (this.disposed || this.ws !== ws) return;
    this.mux = undefined;
    this.channel = undefined;
    // Surface a close on every live app-WS socket so the connector's OWN
    // reconnect re-opens a stream on the NEXT session — never silently
    // re-attach to a session the connector believes is still live.
    for (const socket of [...this.liveSockets]) socket.terminate();
    this.liveSockets.clear();
    this.setState('disconnected');
    const delay = this.retryMs;
    this.retryMs = Math.min(this.retryMs * 2, 10_000);
    setTimeout(() => this.connect(), delay);
  }

  private setState(state: TunnelState): void {
    if (this.stateValue === state) return;
    this.stateValue = state;
    this.onStateChange?.(state);
  }

  /** WebSocket factory for the connector: the ?token= query rides the app-WS OPEN. */
  socketFactory = (url: string): WebSocket => {
    const token = new URL(url).searchParams.get('token') ?? '';
    if (!this.mux) {
      // Not yet connected: hand back a socket that closes immediately so the
      // connector retries; connect() is driven separately.
      const dead = new TunnelSocket(new NullStream() as unknown as MuxStream);
      queueMicrotask(() => dead.close());
      return dead as unknown as WebSocket;
    }
    const socket = new TunnelSocket(this.mux.openStream(StreamKind.APP_WS, { token: utf8(token) }));
    socket.onDetach = () => this.liveSockets.delete(socket);
    this.liveSockets.add(socket);
    return socket as unknown as WebSocket;
  };

  /** fetch() over an HTTP tunnel stream (path+query target per §4.4). */
  fetch = async (input: string, init: RequestInit = {}): Promise<Response> => {
    if (!this.mux) throw new Error('tunnel not connected');
    const url = new URL(input, 'http://relay.local');
    const target = `${url.pathname}${url.search}`;
    const method = (init.method ?? 'GET').toUpperCase();
    const headers = normalizeHeaders(init.headers);
    const stream = this.mux.openStream(StreamKind.HTTP);
    return new Promise<Response>((resolve, reject) => {
      let status = 0;
      let responseHeaders: Record<string, string> = {};
      const chunks: Uint8Array[] = [];
      stream.onHead = (head) => {
        const h = head as { status: number; headers: Record<string, string> };
        status = h.status;
        responseHeaders = h.headers ?? {};
      };
      stream.onData = (chunk) => {
        chunks.push(chunk);
        stream.consume(chunk.length);
      };
      stream.onEnd = () => resolve(new Response(concatBytes(chunks) as unknown as BodyInit, { status, headers: responseHeaders }));
      stream.onReset = (reason) => reject(new Error(`tunnel http reset: ${reason}`));
      stream.sendHead({ method, target, headers });
      if (init.body !== undefined && init.body !== null) stream.write(bodyToBytes(init.body));
      stream.end();
    });
  };

  dispose(): void {
    this.disposed = true;
    this.mux?.close('disposed');
    this.ws?.close();
  }
}

/** A no-op stream for the not-yet-connected socketFactory fallback. */
class NullStream {
  onData?: (chunk: Uint8Array) => void;
  onEnd?: () => void;
  onReset?: (reason: string) => void;
  write(): void {}
  end(): void {}
  consume(): void {}
}

function normalizeHeaders(headers: RequestInit['headers']): Record<string, string> {
  const out: Record<string, string> = {};
  if (!headers) return out;
  if (headers instanceof Headers) headers.forEach((v, k) => (out[k] = v));
  else if (Array.isArray(headers)) for (const [k, v] of headers) out[k] = v;
  else Object.assign(out, headers);
  return out;
}

function bodyToBytes(body: BodyInit): Uint8Array {
  if (typeof body === 'string') return utf8(body);
  if (body instanceof Uint8Array) return body;
  if (body instanceof ArrayBuffer) return new Uint8Array(body);
  return utf8(String(body));
}
