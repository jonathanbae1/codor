import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { CryptoVault } from './../crypto/pairing.js';
import type { RelaySocket } from './link.js';
import { RelayPairingHost } from './pairing-host.js';
import { RelayStore } from './store.js';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'relay-ph-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function mockRoom() {
  const sends: (Uint8Array | string)[] = [];
  let closed = false;
  let msgCb: ((d: Uint8Array, b: boolean) => void) | undefined;
  const socket: RelaySocket = {
    send: (data) => sends.push(data),
    close: () => (closed = true),
    onMessage: (cb) => (msgCb = cb),
    onOpen: (cb) => cb(),
    onClose: () => {},
    onError: () => {},
  };
  return {
    socket,
    sends,
    isClosed: () => closed,
    joinClaimant: () => msgCb?.(new TextEncoder().encode(JSON.stringify({ type: 'peer-joined', role: 'claim' })), false),
    sendBadMsgB: () => msgCb?.(new Uint8Array(32).fill(0xff), true), // invalid ristretto point
    binaryCount: () => sends.filter((s) => typeof s !== 'string').length,
    failCount: () => sends.filter((s) => typeof s === 'string' && (JSON.parse(s) as { type?: string }).type === 'fail').length,
  };
}

function makeHost(room: ReturnType<typeof mockRoom>, timers: { fire: () => void }) {
  const host = new CryptoVault(join(dir, 'host'));
  const store = new RelayStore(join(dir, 'host'));
  store.enable('ws://relay.test');
  const pairingHost = new RelayPairingHost({
    store,
    pairing: host.pairing,
    identity: host.keys.publicIdentity(),
    reserveRoom: async () => ({ nameplate: 'AA' }),
    dialRoom: () => room.socket,
    setTimeoutFn: (cb) => {
      timers.fire = cb;
      return 1 as unknown as ReturnType<typeof setTimeout>;
    },
    clearTimeoutFn: () => {},
  });
  return { host, pairingHost };
}

describe('RelayPairingHost attempt + deadline bounds', () => {
  it('burns the pairing after three failed attempts, independent of the relay', async () => {
    const room = mockRoom();
    const timers = { fire: () => {} };
    const { host, pairingHost } = makeHost(room, timers);
    await pairingHost.pair();

    // Three claimants each send an invalid MSG_B (a spec-required failed attempt).
    for (let i = 0; i < 3; i++) {
      room.joinClaimant(); // → MSG_A
      room.sendBadMsgB(); // → fail
    }
    expect(room.failCount()).toBe(3);
    expect(room.isClosed()).toBe(true); // host burned the pairing itself

    // A malicious relay's fourth synthesized join gets no new MSG_A.
    const before = room.binaryCount();
    room.joinClaimant();
    expect(room.binaryCount()).toBe(before);
    host.close();
  });

  it('closes the pairing when the 10-minute deadline fires', async () => {
    const room = mockRoom();
    const timers = { fire: () => {} };
    const { host, pairingHost } = makeHost(room, timers);
    await pairingHost.pair();
    expect(room.isClosed()).toBe(false);
    timers.fire(); // deadline elapses
    expect(room.isClosed()).toBe(true);
    host.close();
  });
});
