// @vitest-environment happy-dom
import type { RoomSummary } from '@codor/protocol';
import { describe, expect, it, vi } from 'vitest';

import type { HostedComputerMaterial } from '@runtime/crypto.js';
import type { TunnelState } from '@runtime/relay.js';

import {
  ComputerSessionManager,
  type ComputerSessionDeps,
} from './computer-sessions.js';
import type { ConnectorOptions, RoomConnector } from './connector.js';

const material = (id: string, gen = 1): HostedComputerMaterial => ({
  computer: { id, gen, label: `Computer ${id}`, paired_at: `2026-08-0${gen}` },
  relay: {
    relay_url: 'wss://relay.test',
    session_id: id.repeat(64).slice(0, 64),
    client_static: { pub: id, priv: id },
    host_static_pub: id,
  },
  switchboard: {
    kind: 'switchboard',
    device_id: `switchboard-${id}`,
    sign_public_key: `sign-${id}`,
    encryption_public_key: `box-${id}`,
  },
});

const summary = (id: string, unread: number): RoomSummary => ({
  id: 'same-room',
  name: `Room on ${id}`,
  created_ts: '2026-08-01T00:00:00.000Z',
  working: id === 'B',
  attention: id === 'B',
  unread,
});

function harness() {
  let materials = [material('A'), material('B')];
  let activeId: string | undefined = 'A';
  const tunnelStarts: string[] = [];
  const connectorStarts: string[] = [];
  const tunnelDisposals: string[] = [];
  const connectorDisposals: string[] = [];
  const switches: string[] = [];

  const deps: ComputerSessionDeps = {
    load: async () => ({ materials, activeId }),
    makeTunnel: (loaded) => {
      const id = loaded.computer.id;
      const tunnel = {
        state: 'connected' as TunnelState,
        onStateChange: undefined as ((state: TunnelState) => void) | undefined,
        connect: () => { tunnelStarts.push(id); },
        whenReady: async () => undefined,
        fetch: async () => new Response(),
        socketFactory: () => ({}) as WebSocket,
        dispose: () => { tunnelDisposals.push(id); },
      };
      return tunnel;
    },
    authenticate: async (loaded) => `token-${loaded.computer.id}`,
    loadRooms: async (token) => [summary(token.slice(-1), token.endsWith('B') ? 7 : 1)],
    makeConnector: (options: ConnectorOptions): RoomConnector => {
      const id = options.token.slice(-1);
      connectorStarts.push(id);
      options.store!.getState().setConnected(true);
      let room = options.room;
      return {
        room: () => room,
        state: () => 'connected',
        switchRoom: (next) => { room = next; options.store!.getState().setActiveRoom(next); },
        post: () => undefined,
        act: () => undefined,
        disconnect: () => options.store!.getState().setConnected(false),
        reconnect: () => options.store!.getState().setConnected(true),
        dispose: () => { connectorDisposals.push(id); options.store!.getState().setConnected(false); },
      };
    },
    switchStored: async (id) => { switches.push(id); activeId = id; },
    pair: async () => {
      materials = [...materials, material('C')];
      activeId = 'C';
    },
    forget: async (id) => {
      materials = materials.filter((entry) => entry.computer.id !== id);
      if (activeId === id) activeId = materials.at(-1)?.computer.id;
    },
    rename: async (id, label) => {
      materials = materials.map((entry) => entry.computer.id === id
        ? { ...entry, computer: { ...entry.computer, label } }
        : entry);
    },
    sleep: () => new Promise(() => undefined),
  };
  return {
    deps,
    tunnelStarts,
    connectorStarts,
    tunnelDisposals,
    connectorDisposals,
    switches,
  };
}

describe('ComputerSessionManager', () => {
  it('keeps two isolated warm stacks and activates one without another handshake or disposal', async () => {
    const h = harness();
    const manager = new ComputerSessionManager(h.deps);
    expect(await manager.start()).toBe(true);

    expect(h.tunnelStarts.sort()).toEqual(['A', 'B']);
    expect(h.connectorStarts.sort()).toEqual(['A', 'B']);
    expect(manager.getSnapshot().computers).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'A', active: true, connected: true, unread: 1, attention: false, working: 0 }),
      expect.objectContaining({ id: 'B', active: false, connected: true, unread: 7, attention: true, working: 1 }),
    ]));

    expect(await manager.activate('B')).toBe(true);
    expect(h.switches).toEqual(['A', 'B']);
    expect(h.tunnelStarts.sort()).toEqual(['A', 'B']);
    expect(h.connectorStarts.sort()).toEqual(['A', 'B']);
    expect(h.tunnelDisposals).toEqual([]);
    expect(h.connectorDisposals).toEqual([]);
    expect(manager.active()).toMatchObject({ id: 'B', room: 'same-room', token: 'token-B' });
    manager.dispose();
  });

  it('adds, renames and forgets only the addressed session', async () => {
    const h = harness();
    const manager = new ComputerSessionManager(h.deps);
    await manager.start();

    expect(await manager.add('CODE', 'wss://relay.test')).toBe(true);
    expect(h.tunnelStarts.sort()).toEqual(['A', 'B', 'C']);
    expect(manager.active()?.id).toBe('C');

    await manager.rename('A', 'Desk');
    expect(manager.getSnapshot().computers.find((computer) => computer.id === 'A')?.label).toBe('Desk');

    await manager.forget('B');
    expect(h.tunnelDisposals).toEqual(['B']);
    expect(h.connectorDisposals).toEqual(['B']);
    expect(manager.getSnapshot().computers.map((computer) => computer.id).sort()).toEqual(['A', 'C']);
    expect(manager.active()?.id).toBe('C');
    manager.dispose();
  });

  it('keeps retry work alive after the active session misses its bounded boot wait', async () => {
    const h = harness();
    const authenticate = h.deps.authenticate;
    let releaseA: (() => void) | undefined;
    h.deps.authenticate = vi.fn(async (loaded, tunnel) => {
      if (loaded.computer.id === 'A') await new Promise<void>((resolve) => { releaseA = resolve; });
      return authenticate(loaded, tunnel);
    });
    h.deps.sleep = async () => undefined;
    (window as unknown as { __CODOR_SESSION_BOOT_MS?: number }).__CODOR_SESSION_BOOT_MS = 1;
    const manager = new ComputerSessionManager(h.deps);
    await manager.start();
    for (let i = 0; i < 8; i += 1) await Promise.resolve();

    expect(manager.getSnapshot().computers.find((computer) => computer.id === 'B')).toMatchObject({ ready: true, connected: true });
    expect(await manager.activate('B')).toBe(true);
    releaseA?.();
    await Promise.resolve();
    expect(h.tunnelDisposals).toEqual([]);
    manager.dispose();
    delete (window as unknown as { __CODOR_SESSION_BOOT_MS?: number }).__CODOR_SESSION_BOOT_MS;
  });
});
