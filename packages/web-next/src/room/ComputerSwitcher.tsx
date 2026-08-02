import { useState, useSyncExternalStore } from 'react';

import { PAIRING_TIME_COPY, SESSION_COPY } from '../app/connection-state.js';
import {
  computerSessions,
  type ComputerSessionsSnapshot,
} from '../app/computer-sessions.js';
import { Button, Modal } from '../primitives/primitives.js';
import { relayUrlConfigured } from '../runtime/relay-mode.js';
import { PairingCodeInput } from '../surfaces/PairingCodeInput.js';

const EMPTY: ComputerSessionsSnapshot = { computers: [] };
const noSubscription = (): (() => void) => () => undefined;

/** Functional hosted-only switcher over already-warm managed sessions. */
export function ComputerSwitcher(): React.ReactNode {
  const relayUrl = relayUrlConfigured();
  const manager = computerSessions();
  const list = useSyncExternalStore(
    manager?.subscribe ?? noSubscription,
    manager?.getSnapshot ?? (() => EMPTY),
    () => EMPTY,
  );
  const [open, setOpen] = useState(false);
  const [adding, setAdding] = useState(false);
  const [pairing, setPairing] = useState(false);
  const [error, setError] = useState<string>();
  const [renaming, setRenaming] = useState<string>();

  if (!relayUrl || !manager || list.computers.length === 0) return null;
  const active = list.computers.find((computer) => computer.active) ?? list.computers.at(-1);

  const add = (code: string): void => {
    if (typeof navigator !== 'undefined' && !navigator.onLine) {
      setError(SESSION_COPY['device-offline'].body);
      return;
    }
    setPairing(true);
    setError(undefined);
    void manager.add(code, relayUrl).then(
      (ready) => {
        setPairing(false);
        if (ready) setAdding(false);
        else setError(SESSION_COPY['agent-offline'].body);
      },
      () => {
        setPairing(false);
        setError(typeof navigator !== 'undefined' && !navigator.onLine
          ? SESSION_COPY['device-offline'].body
          : PAIRING_TIME_COPY['code-bad'].body);
      },
    );
  };

  return (
    <div className="nx-computer-switcher" data-testid="computer-switcher">
      <button
        type="button"
        className="nx-computer-current"
        data-testid="computer-current"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        {active?.label ?? 'This computer'}
      </button>
      {open ? (
        <div className="nx-computer-menu" role="menu">
          <ul>
            {list.computers.map((computer) => (
              <li key={computer.id} data-testid={`computer-${computer.id}`}>
                {renaming === computer.id ? (
                  <input
                    className="nx-computer-rename"
                    autoFocus
                    defaultValue={computer.label}
                    data-testid={`computer-rename-${computer.id}`}
                    onBlur={(event) => {
                      void manager.rename(computer.id, event.target.value.trim() || computer.label)
                        .then(() => setRenaming(undefined));
                    }}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter') (event.target as HTMLInputElement).blur();
                    }}
                  />
                ) : (
                  <button
                    type="button"
                    className="nx-computer-name"
                    data-testid={`computer-switch-${computer.id}`}
                    onDoubleClick={() => setRenaming(computer.id)}
                    onClick={() => {
                      if (!computer.active) void manager.activate(computer.id).then(() => setOpen(false));
                    }}
                  >
                    {computer.label}{computer.active ? ' ✓' : ''}
                  </button>
                )}
                <span data-testid={`computer-connection-${computer.id}`}>
                  {computer.connected ? 'Connected' : 'Reconnecting'}
                </span>
                {computer.unread > 0 ? (
                  <span data-testid={`computer-unread-${computer.id}`}>{computer.unread}</span>
                ) : null}
                {computer.attention ? (
                  <span data-testid={`computer-attention-${computer.id}`}>Attention</span>
                ) : null}
                {computer.working > 0 ? (
                  <span data-testid={`computer-working-${computer.id}`}>{computer.working} working</span>
                ) : null}
                <button
                  type="button"
                  className="nx-computer-forget"
                  data-testid={`computer-forget-${computer.id}`}
                  onClick={() => {
                    void manager.forget(computer.id).then(() => {
                      if (manager.getSnapshot().computers.length === 0) window.location.assign('/');
                    });
                  }}
                >
                  Forget
                </button>
              </li>
            ))}
          </ul>
          <Button variant="quiet" data-testid="computer-add" onClick={() => { setAdding(true); setOpen(false); }}>
            Add a computer
          </Button>
        </div>
      ) : null}
      {adding ? (
        <Modal label="Add a computer" onClose={() => { setAdding(false); setError(undefined); }} testid="computer-add-modal">
          <h2 className="nx-dialog-title">Add a computer</h2>
          <p className="nx-dialog-body">Enter the pairing code shown by Codor on the other computer.</p>
          <PairingCodeInput busy={pairing} error={error} submitLabel="Add this computer" onSubmit={add} />
        </Modal>
      ) : null}
    </div>
  );
}
