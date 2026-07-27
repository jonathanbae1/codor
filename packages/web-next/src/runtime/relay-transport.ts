// Origin-scoped fetch router for the relay tunnel. When the browser is paired
// through the blind relay, requests to the relay origin are tunnelled; every
// other origin (localhost, tailnet) stays on the direct path unchanged. Kept
// dependency-free so both api.ts and crypto.ts (the device-auth handshake) can
// route through it without an import cycle.
let relayTransport: { origin: string; fetch: (input: string, init?: RequestInit) => Promise<Response> } | undefined;

export function setRelayTransport(
  transport: { origin: string; fetch: (input: string, init?: RequestInit) => Promise<Response> } | undefined,
): void {
  relayTransport = transport;
}

/** fetch() that tunnels requests to the relay origin and passes everything else through. */
export function relayFetch(url: string, init?: RequestInit): Promise<Response> {
  if (relayTransport && new URL(url).origin === relayTransport.origin) return relayTransport.fetch(url, init);
  return fetch(url, init);
}
