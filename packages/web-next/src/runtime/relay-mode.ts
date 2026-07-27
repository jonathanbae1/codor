// Relay transport selection. On startup, if a browser is paired through the
// blind relay, this constructs and connects the single TunnelClient, registers
// its fetch with the origin router, and exposes the connection extras
// (relay origin + tunnel socketFactory) the app threads into ws.ts/api.ts.
// Absent a relay record, everything stays on the direct local/tailnet path.
import { relayAccessOrigin, storedRelayRecord } from './crypto.js';
import { setRelayTransport } from './relay-transport.js';
import { TunnelClient, type TunnelState } from './relay.js';

let tunnel: TunnelClient | undefined;
let httpOrigin: string | undefined;
let wsOrigin: string | undefined;

/** Initialize relay mode if a relay record exists. Returns whether relay mode is active. */
export async function initRelayMode(): Promise<boolean> {
  if (tunnel) return true;
  const record = await storedRelayRecord();
  if (!record) return false;
  tunnel = new TunnelClient(record);
  httpOrigin = relayAccessOrigin(record.relay_url);
  wsOrigin = httpOrigin.replace(/^http/, 'ws');
  setRelayTransport({ origin: httpOrigin, fetch: tunnel.fetch });
  tunnel.connect();
  // Wait (bounded) for the session so the app's device auth tunnels successfully
  // rather than racing an unconnected mux; if the relay is down, proceed and the
  // app's own reconnect/offline handling takes over.
  await Promise.race([tunnel.whenReady(), new Promise((resolve) => setTimeout(resolve, 8_000))]);
  return true;
}

export function relayActive(): boolean {
  return tunnel !== undefined;
}

declare global {
  interface Window {
    __CODOR_RELAY_URL?: string;
  }
}

/**
 * The relay URL when relay pairing is INTENDED — the hosted codor.app bakes
 * VITE_CODOR_RELAY_URL; e2e sets window.__CODOR_RELAY_URL at runtime. Undefined
 * on a self-hosted switchboard (local pairing), so no default is returned here.
 */
export function relayUrlConfigured(): string | undefined {
  const runtime = typeof window !== 'undefined' ? window.__CODOR_RELAY_URL : undefined;
  const built = (import.meta.env as { VITE_CODOR_RELAY_URL?: string }).VITE_CODOR_RELAY_URL;
  return runtime || built || undefined;
}

/** The origin relay-paired switchboard access + REST are keyed on (undefined when direct). */
export function relayAccessOriginActive(): string | undefined {
  return httpOrigin;
}

/** connect() extras: route the app WebSocket through the tunnel socketFactory. */
export function relayConnectExtras(): { origin?: string; socketFactory?: (url: string) => WebSocket } {
  return tunnel ? { origin: wsOrigin, socketFactory: tunnel.socketFactory } : {};
}

export function relayTunnelState(): TunnelState | undefined {
  return tunnel?.state;
}

/** Subscribe to tunnel session state changes (presence). */
export function onRelayStateChange(listener: (state: TunnelState) => void): void {
  if (tunnel) tunnel.onStateChange = listener;
}
