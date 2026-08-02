// Hosted relay composition delegates to the per-computer session manager.
// With no relay index the manager is absent and every direct/self-hosted caller
// continues using its page-origin singleton path unchanged.
import { computerSessions, initComputerSessions } from '../app/computer-sessions.js';
import type { TunnelState } from './relay.js';

/** Initialize hosted sessions if indexed relay computers exist. */
export async function initRelayMode(): Promise<boolean> {
  return await initComputerSessions() !== undefined;
}
export function relayActive(): boolean {
  return computerSessions() !== undefined;
}

// Dial-time URL config + candidate selection live in relay-dial.ts (P7);
// re-exported here so existing import sites keep working.
export { relayAliasConfigured, relayUrlConfigured } from './relay-dial.js';

/** The origin active relay-paired switchboard access + REST are keyed on. */
export function relayAccessOriginActive(): string | undefined {
  const extras = computerSessions()?.activeConnectExtras();
  return extras?.origin?.replace(/^ws/, 'http');
}

/** connect() extras for the active managed tunnel; empty on the direct path. */
export function relayConnectExtras(): { origin?: string; socketFactory?: (url: string) => WebSocket } {
  return computerSessions()?.activeConnectExtras() ?? {};
}

export function relayTunnelState(): TunnelState | undefined {
  return computerSessions()?.activeTunnelState();
}

/** Subscribe the legacy presence consumer to the currently active tunnel. */
export function onRelayStateChange(listener: (state: TunnelState) => void): void {
  computerSessions()?.onActiveTunnelState(listener);
}
