/**
 * The bootstrap is running — resolving access and loading the channel list,
 * which over the blind relay can take a keepalive cycle while a stale host
 * reconnects. Show a visible connecting state so the root is never a blank page
 * during that wait (a paired browser on the hosted origin used to stare at
 * nothing while the relay bootstrap retried).
 */
export function StartupConnecting() {
  return (
    <main className="nx-upgrade" data-testid="startup-connecting">
      <section className="nx-upgrade-card" aria-labelledby="startup-connecting-title" aria-busy="true">
        <p className="nx-eyebrow">Connecting</p>
        <h1 id="startup-connecting-title">Reaching your channels…</h1>
        <p role="status">
          Restoring the secure connection to your Codor and loading your channels.
          This can take a moment if the host is reconnecting.
        </p>
      </section>
    </main>
  );
}
