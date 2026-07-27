// harn:assume relay-worker-stays-blind ref=blind-router
// Blind relay router (PLAN §4.1). Routes by request method and URL path ONLY.
// It MUST NOT read, parse, or log request or response bodies, and this package
// MUST keep zero runtime dependencies and no cryptographic code — the relay
// only ever forwards opaque ciphertext and holds no key material.
import { PairingRoom } from './pairing-room.js';
import { SessionRelay } from './session-relay.js';

export interface Env {
  PAIRING_ROOM: DurableObjectNamespace;
  SESSION_RELAY: DurableObjectNamespace;
}

const NOT_IMPLEMENTED = 501;

const PAIR_WS_ROUTE = /^\/v1\/pair\/([^/]+)\/ws$/;
const SESSION_WS_ROUTE = /^\/v1\/session\/([^/]+)\/ws$/;

export default {
  async fetch(request: Request): Promise<Response> {
    const { pathname } = new URL(request.url);
    const { method } = request;

    if (method === 'GET' && pathname === '/healthz') {
      return new Response('ok', { status: 200 });
    }

    // Pairing + session routing are implemented in Phases 3 and 4. The router
    // shape (path-only, no body access) is established here.
    if (method === 'POST' && pathname === '/v1/pair/rooms') {
      return new Response('not implemented', { status: NOT_IMPLEMENTED });
    }
    if (method === 'GET' && PAIR_WS_ROUTE.test(pathname)) {
      return new Response('not implemented', { status: NOT_IMPLEMENTED });
    }
    if (method === 'GET' && SESSION_WS_ROUTE.test(pathname)) {
      return new Response('not implemented', { status: NOT_IMPLEMENTED });
    }

    return new Response('not found', { status: 404 });
  },
} satisfies ExportedHandler<Env>;

export { PairingRoom, SessionRelay };
// harn:end relay-worker-stays-blind
