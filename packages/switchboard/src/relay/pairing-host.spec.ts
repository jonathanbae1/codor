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
  let opened = false;
  let msgCb: ((d: Uint8Array, b: boolean) => void) | undefined;
  const socket: RelaySocket = {
    // A real socket cannot send before it opens; throwing here keeps the fake
    // honest so an arm-before-open regression can't hide behind an accepted send.
    send: (data) => {
      if (!opened) throw new Error('send before open');
      sends.push(data);
    },
    close: () => (closed = true),
    onMessage: (cb) => (msgCb = cb),
    onOpen: (cb) => {
      opened = true;
      cb();
    },
    onClose: () => {},
    onError: () => {},
  };
  return {
    socket,
    sends,
    isClosed: () => closed,
    joinClaimant: () => msgCb?.(new TextEncoder().encode(JSON.stringify({ type: 'peer-joined', role: 'claim' })), false),
    answerPong: () => msgCb?.(new TextEncoder().encode('codor-pong'), false),
    sendBadMsgB: () => msgCb?.(new Uint8Array(32).fill(0xff), true), // invalid ristretto point
    binaryCount: () => sends.filter((s) => typeof s !== 'string').length,
    failCount: () => sends.filter((s) => {
      if (typeof s !== 'string' || s === 'codor-ping') return false; // skip keepalive probes
      try {
        return (JSON.parse(s) as { type?: string }).type === 'fail';
      } catch {
        return false;
      }
    }).length,
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

describe('RelayPairingHost keepalive (§4.1 room-socket probe)', () => {
  function keepaliveHost(room: ReturnType<typeof mockRoom>, capture: { tick: () => void }) {
    const host = new CryptoVault(join(dir, 'host'));
    const store = new RelayStore(join(dir, 'host'));
    store.enable('ws://relay.test');
    const pairingHost = new RelayPairingHost({
      store,
      pairing: host.pairing,
      identity: host.keys.publicIdentity(),
      reserveRoom: async () => ({ nameplate: 'AA' }),
      dialRoom: () => room.socket,
      setTimeoutFn: () => 1 as unknown as ReturnType<typeof setTimeout>,
      clearTimeoutFn: () => {},
      setIntervalFn: (cb) => {
        capture.tick = cb;
        return 2 as unknown as ReturnType<typeof setInterval>;
      },
      clearIntervalFn: () => {},
    });
    return { host, pairingHost };
  }

  it('pings the idle room socket and closes it after two unanswered pings', async () => {
    const room = mockRoom();
    const capture = { tick: () => {} };
    const { host, pairingHost } = keepaliveHost(room, capture);
    await pairingHost.pair();
    expect(room.sends.filter((s) => s === 'codor-ping')).toHaveLength(1); // immediate probe on arming
    capture.tick();
    expect(room.sends.filter((s) => s === 'codor-ping')).toHaveLength(2);
    expect(room.isClosed()).toBe(false);
    capture.tick(); // two unanswered → shutdown
    expect(room.isClosed()).toBe(true);
    host.close();
  });

  it('keeps the room socket alive while the relay answers pings', async () => {
    const room = mockRoom();
    const capture = { tick: () => {} };
    const { host, pairingHost } = keepaliveHost(room, capture);
    await pairingHost.pair();
    for (let i = 0; i < 5; i += 1) {
      capture.tick();
      room.answerPong();
    }
    expect(room.isClosed()).toBe(false);
    host.close();
  });

  it('does not false-positive death when the room socket opens after a delay', async () => {
    // A socket whose open is deferred and which (like a real one) throws on a
    // pre-open send. Arming the keepalive in the constructor would probe before
    // open, accumulate unanswered "sends", and kill a healthy room; arming on
    // open must avoid that.
    const sends: (Uint8Array | string)[] = [];
    let opened = false;
    let closed = false;
    let openCb: (() => void) | undefined;
    let msgCb: ((d: Uint8Array, b: boolean) => void) | undefined;
    let tick: (() => void) | undefined;
    const socket: RelaySocket = {
      send: (data) => {
        if (!opened) throw new Error('send before open');
        sends.push(data);
      },
      close: () => (closed = true),
      onMessage: (cb) => (msgCb = cb),
      onOpen: (cb) => (openCb = cb),
      onClose: () => {},
      onError: () => {},
    };
    const host = new CryptoVault(join(dir, 'host'));
    const store = new RelayStore(join(dir, 'host'));
    store.enable('ws://relay.test');
    const pairingHost = new RelayPairingHost({
      store,
      pairing: host.pairing,
      identity: host.keys.publicIdentity(),
      reserveRoom: async () => ({ nameplate: 'AA' }),
      dialRoom: () => socket,
      setTimeoutFn: () => 1 as unknown as ReturnType<typeof setTimeout>,
      clearTimeoutFn: () => {},
      setIntervalFn: (cb) => {
        tick = cb;
        return 2 as unknown as ReturnType<typeof setInterval>;
      },
      clearIntervalFn: () => {},
    });
    await pairingHost.pair();
    expect(tick).toBeUndefined(); // not armed before open — no probes, no false death
    expect(closed).toBe(false);
    opened = true;
    openCb!(); // socket finally opens → keepalive arms with an immediate probe
    expect(tick).toBeDefined();
    for (let i = 0; i < 5; i += 1) {
      tick!();
      msgCb!(new TextEncoder().encode('codor-pong'), false); // healthy traffic
    }
    expect(closed).toBe(false);
    host.close();
  });
});
