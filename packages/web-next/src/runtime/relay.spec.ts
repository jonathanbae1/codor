import { SessionResponder, generateTunnelKeypair } from '@codor/tunnel';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { TunnelClient, type TunnelRecord } from './relay.js';

const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString('base64');
const toArrayBuffer = (bytes: Uint8Array): ArrayBuffer => bytes.slice().buffer;

const clientStatic = generateTunnelKeypair();
const hostStatic = generateTunnelKeypair();
const SESSION_ID = '00'.repeat(32);
const record: TunnelRecord = {
  relay_url: 'wss://relay.test',
  session_id: SESSION_ID,
  client_static: { pub: b64(clientStatic.publicKey), priv: b64(clientStatic.secretKey) },
  host_static_pub: b64(hostStatic.publicKey),
};

/** A scriptable stand-in for the browser WebSocket the TunnelClient opens. */
class FakeWs {
  binaryType = 'blob';
  readyState = 0;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: ((event: { code: number; reason: string }) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  readonly sent: unknown[] = [];
  closed = false;
  send(data: unknown): void {
    this.sent.push(data);
  }
  close(): void {
    this.closed = true;
    this.readyState = 3;
    this.onclose?.({ code: 1000, reason: '' });
  }
  deliver(bytes: Uint8Array): void {
    this.onmessage?.({ data: toArrayBuffer(bytes) });
  }
}

function tracker() {
  const dialed: FakeWs[] = [];
  return {
    dialed,
    socketFactory: () => {
      const ws = new FakeWs();
      dialed.push(ws);
      return ws as unknown as WebSocket;
    },
  };
}

/** Drive the KK handshake to completion so the mux is live. */
function completeHandshake(ws: FakeWs): void {
  ws.onopen?.(); // sends msg1
  const msg1 = ws.sent.shift() as Uint8Array;
  const responder = new SessionResponder({
    hostStatic,
    sessionId: new Uint8Array(32),
    lookupClientStatic: () => clientStatic.publicKey,
  });
  ws.deliver(responder.receiveMsg1(msg1)); // msg2 → handshakeDone, mux + keepalive armed
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('TunnelClient resilience', () => {
  it('abandons and reconnects when the handshake never completes (#1)', () => {
    const { dialed, socketFactory } = tracker();
    const client = new TunnelClient(record, { handshakeMs: 10_000, socketFactory });
    client.connect();
    expect(dialed).toHaveLength(1);
    dialed[0]!.onopen?.(); // opens and sends msg1; the host swallows it — no msg2
    vi.advanceTimersByTime(10_000); // handshake deadline → fail → schedule reconnect
    vi.advanceTimersByTime(1_000); // reconnect backoff (starts at 500ms)
    expect(dialed.length).toBeGreaterThanOrEqual(2); // reconnected instead of stranding
    client.dispose();
  });

  it('detects a silently half-open session after handshake and reconnects (#2)', () => {
    const { dialed, socketFactory } = tracker();
    const client = new TunnelClient(record, { keepaliveMs: 1_000, handshakeMs: 10_000, socketFactory });
    client.connect();
    completeHandshake(dialed[0]!);
    expect(client.state).toBe('connected');
    // No pong ever answers the probes: immediate probe, one interval, then death.
    vi.advanceTimersByTime(2_000); // two intervals → onDead → fail
    vi.advanceTimersByTime(1_000); // reconnect backoff
    expect(dialed.length).toBeGreaterThanOrEqual(2);
    client.dispose();
  });

  it('closes abandoned sockets when the handshake keeps failing — no leak (#1)', () => {
    const { dialed, socketFactory } = tracker();
    const client = new TunnelClient(record, { handshakeMs: 1_000, socketFactory });
    client.connect();
    // Never complete a handshake; let deadline + backoff cycle repeatedly.
    vi.advanceTimersByTime(60_000);
    expect(dialed.length).toBeGreaterThan(2); // it kept reconnecting
    // The invariant that matters: abandoned sockets don't accumulate open — at
    // most the current one is still open, every earlier one was closed by fail().
    expect(dialed.filter((ws) => !ws.closed).length).toBeLessThanOrEqual(1);
    client.dispose();
  });

  it('dispose rejects in-flight fetches and closes live app sockets (#2)', async () => {
    const { dialed, socketFactory } = tracker();
    const client = new TunnelClient(record, { socketFactory });
    client.connect();
    completeHandshake(dialed[0]!);
    const pending = client.fetch('/api/rooms'); // in-flight
    const appSocket = client.socketFactory('wss://relay.test/ws?token=t');
    let appClosed = false;
    appSocket.onclose = () => {
      appClosed = true;
    };
    await Promise.resolve(); // let the app socket's optimistic open settle
    client.dispose();
    await expect(pending).rejects.toThrow(/disposed/);
    expect(appClosed).toBe(true);
  });

  it('rejects an in-flight tunneled fetch when the session drops (#3)', async () => {
    const { dialed, socketFactory } = tracker();
    const client = new TunnelClient(record, { handshakeMs: 10_000, socketFactory });
    client.connect();
    completeHandshake(dialed[0]!);
    const pending = client.fetch('/api/rooms'); // no response will ever arrive
    let settled = false;
    void pending.then(() => (settled = true), () => (settled = true));
    await Promise.resolve();
    expect(settled).toBe(false); // genuinely pending on the live session
    dialed[0]!.close(); // session drops
    await expect(pending).rejects.toThrow(/session lost/);
    client.dispose();
  });
});
