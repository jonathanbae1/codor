import { useEffect, useRef, type ReactNode } from 'react';

import { SESSION_COPY, type SessionConnectionState } from '../app/connection-state.js';
import { useConnectionState } from '../app/use-connection-state.js';
import { forgetRelayPairing } from '../runtime/crypto.js';
import { relayActive } from '../runtime/relay-mode.js';

// Brief drops keep the in-room "Reconnecting…" pill; the full recovery screen only
// takes over after the session has been down long enough to be worth explaining.
// Overridable via window for e2e (same pattern as __CODOR_RELAY_URL).
const graceMs = (): number =>
  (typeof window !== 'undefined' && window.__CODOR_RECOVERY_GRACE_MS) || 6_000;

type RecoveryState = Exclude<SessionConnectionState, 'online'>;

function retryNow(): void {
  window.location.reload();
}

async function repair(): Promise<void> {
  // Forget ONLY the relay record (not the nuclear unpair) → reload into code entry.
  await forgetRelayPairing();
  window.location.assign('/');
}

function RecoveryCard({ state }: { state: RecoveryState }): ReactNode {
  const copy = SESSION_COPY[state];
  // The connector/tunnel stay MOUNTED beneath us, so their own backoff is the
  // auto-retry — there is no reload timer. The manual Retry-now forces a reload.
  const autoRetrying = state === 'agent-offline' || state === 'agent-offline-extended';
  // pairing-dead always warrants re-pair; the ambiguous extended state offers it
  // only in relay mode (a direct/tailnet browser has no relay record to forget —
  // re-pair there would be a bare reload that can't help a down local agent).
  const offerRepair = state === 'pairing-dead' || (state === 'agent-offline-extended' && relayActive());
  const cardRef = useRef<HTMLElement>(null);
  useEffect(() => {
    cardRef.current?.focus();
  }, []);

  return (
    <div className="nx-recovery-overlay" data-testid="recovery" data-recovery-state={state}>
      <section
        className="nx-upgrade-card"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="recovery-title"
        tabIndex={-1}
        ref={cardRef}
      >
        <p className="nx-eyebrow">{state === 'device-offline' ? 'Offline' : 'Reconnecting'}</p>
        <h1 id="recovery-title">{copy.title}</h1>
        <p>{copy.body}</p>
        {autoRetrying ? (
          <p className="nx-recovery-auto" data-testid="recovery-auto" aria-live="polite">
            Retrying automatically…
          </p>
        ) : null}
        <div className="nx-recovery-actions">
          <button
            type="button"
            className={state === 'pairing-dead' ? 'nx-btn' : 'nx-btn is-primary'}
            data-testid="recovery-retry"
            onClick={retryNow}
          >
            Retry now
          </button>
          {offerRepair ? (
            <button
              type="button"
              className={state === 'pairing-dead' ? 'nx-btn is-primary' : 'nx-btn'}
              data-testid="recovery-repair"
              onClick={() => { void repair(); }}
            >
              Re-pair this browser
            </button>
          ) : null}
        </div>
      </section>
    </div>
  );
}

/**
 * A true OVERLAY: the app (and its connector/tunnel) stay mounted at all times —
 * the recovery card renders ON TOP when the session is unreachable long enough to
 * warrant it, with the app beneath marked aria-hidden. Never unmounting the app is
 * what keeps the reconnect machinery alive (its backoff is the auto-retry) and the
 * down-clock running (so the escalation to the re-pair state is reachable). A live
 * session (or a brief drop within the grace) shows no overlay, so direct/tailnet
 * flows are visually unchanged unless they too go genuinely unreachable.
 */
export function RecoveryOverlay({ children }: { children: ReactNode }): ReactNode {
  const { state, downMs } = useConnectionState();
  const show = state !== 'online' && !(state === 'agent-offline' && downMs < graceMs());
  const beneathRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = beneathRef.current;
    if (!el) return;
    // `inert` (attribute-set for cross-version safety) makes the app truly
    // non-focusable beneath the modal — aria-hidden alone leaves it in tab order.
    if (show) el.setAttribute('inert', '');
    else el.removeAttribute('inert');
  }, [show]);
  return (
    <>
      <div ref={beneathRef} aria-hidden={show || undefined}>{children}</div>
      {show ? <RecoveryCard state={state as RecoveryState} /> : null}
    </>
  );
}
