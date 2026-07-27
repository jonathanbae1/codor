import type { Env } from './index.js';

/**
 * Durable session rendezvous (PLAN §4.1). Phase 1 stub — connId assignment,
 * prefix routing, presence notices, cap, and auto-response keepalive land in
 * Phase 4.
 */
export class SessionRelay {
  constructor(_state: DurableObjectState, _env: Env) {}

  async fetch(_request: Request): Promise<Response> {
    return new Response('not implemented', { status: 501 });
  }
}
