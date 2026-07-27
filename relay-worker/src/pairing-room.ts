import type { Env } from './index.js';

/**
 * Pairing rendezvous room (PLAN §4.1). Phase 1 stub — reserve/roles/forwarding,
 * attempts/churn/alarm/burn semantics and close codes land in Phase 3.
 */
export class PairingRoom {
  constructor(_state: DurableObjectState, _env: Env) {}

  async fetch(_request: Request): Promise<Response> {
    return new Response('not implemented', { status: 501 });
  }
}
