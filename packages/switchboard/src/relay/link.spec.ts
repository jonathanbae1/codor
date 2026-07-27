import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { SessionInitiator, generateTunnelKeypair } from '@codor/tunnel';

import { RelayLink, type RelaySocket } from './link.js';
import { RelayStore } from './store.js';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'relay-link-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const b64 = (b: Uint8Array) => Buffer.from(b).toString('base64');
const prefixConn = (connId: number, payload: Uint8Array) => {
  const out = new Uint8Array(4 + payload.length);
  new DataView(out.buffer).setUint32(0, connId, false);
  out.set(payload, 4);
  return out;
};
const readConn = (bytes: Uint8Array) => new DataView(bytes.buffer, bytes.byteOffset, 4).getUint32(0, false);

function fakeSocket() {
  const sent: Uint8Array[] = [];
  const handlers: { message?: (d: Uint8Array, b: boolean) => void; open?: () => void; close?: () => void } = {};
  const socket: RelaySocket = {
    send: (data) => sent.push(typeof data === 'string' ? new TextEncoder().encode(data) : data),
    close: () => handlers.close?.(),
    onMessage: (cb) => (handlers.message = cb),
    onOpen: (cb) => (handlers.open = cb),
    onClose: (cb) => (handlers.close = cb),
    onError: () => {},
  };
  return { socket, sent, deliver: (d: Uint8Array) => handlers.message?.(d, true), open: () => handlers.open?.() };
}

function enabledStore() {
  const store = new RelayStore(dir);
  store.enable('ws://relay.test');
  return store;
}

describe('RelayLink backoff', () => {
  it('grows exponentially 1s→60s and caps, plus jitter', () => {
    const store = enabledStore();
    const link = new RelayLink({ store, loopbackPort: 1, isDeviceActive: () => true, jitter: () => 0, dialSession: () => fakeSocket().socket });
    expect(link.backoffDelay(0)).toBe(1000);
    expect(link.backoffDelay(1)).toBe(2000);
    expect(link.backoffDelay(2)).toBe(4000);
    expect(link.backoffDelay(5)).toBe(32000);
    expect(link.backoffDelay(6)).toBe(60000); // 64s capped to 60s
    expect(link.backoffDelay(20)).toBe(60000);
    const jittered = new RelayLink({ store, loopbackPort: 1, isDeviceActive: () => true, jitter: () => 0.5, dialSession: () => fakeSocket().socket });
    expect(jittered.backoffDelay(0)).toBe(1500); // base + 0.5*1000
  });
});

describe('RelayLink handshake admission', () => {
  it('completes the KK handshake for an active device and refuses a revoked one', () => {
    const store = enabledStore();
    const clientStatic = generateTunnelKeypair();
    store.addDevice({ device_id: 'dev-1', client_static_pub: b64(clientStatic.publicKey) });

    // --- active device: msg1 → msg2 is returned ---
    let active = true;
    const relay = fakeSocket();
    const link = new RelayLink({
      store,
      loopbackPort: 1,
      isDeviceActive: () => active,
      dialSession: () => relay.socket,
    });
    link.start();
    relay.open();

    const initiator = new SessionInitiator({ clientStatic, hostStaticPub: store.hostStatic.publicKey, sessionId: store.sessionIdBytes });
    relay.deliver(prefixConn(5, initiator.start())); // msg1
    expect(relay.sent).toHaveLength(1);
    expect(readConn(relay.sent[0])).toBe(5);
    const msg2 = relay.sent[0].subarray(4);
    // The initiator accepts msg2 and produces msg3 → handshake is real, not a stub.
    expect(() => initiator.receiveMsg2(msg2)).not.toThrow();

    // --- revoked device: a fresh connection's msg1 yields no msg2 ---
    active = false;
    const other = new SessionInitiator({ clientStatic, hostStaticPub: store.hostStatic.publicKey, sessionId: store.sessionIdBytes });
    relay.deliver(prefixConn(9, other.start()));
    expect(relay.sent.some((m) => readConn(m) === 9)).toBe(false); // refused, silent
  });

  it('refuses an unknown kid (device not in the store)', () => {
    const store = enabledStore();
    const relay = fakeSocket();
    const link = new RelayLink({ store, loopbackPort: 1, isDeviceActive: () => true, dialSession: () => relay.socket });
    link.start();
    relay.open();
    const stranger = new SessionInitiator({ clientStatic: generateTunnelKeypair(), hostStaticPub: store.hostStatic.publicKey, sessionId: store.sessionIdBytes });
    relay.deliver(prefixConn(3, stranger.start()));
    expect(relay.sent).toHaveLength(0);
  });
});
