import { ChevronDown, Monitor } from 'lucide-react';
import { useEffect, useRef, useState, useSyncExternalStore } from 'react';

import { PAIRING_TIME_COPY, SESSION_COPY } from '../app/connection-state.js';
import {
  computerSessions,
  type ComputerSessionsSnapshot,
} from '../app/computer-sessions.js';
import { Button, Code, Modal } from '../primitives/primitives.js';
import { relayUrlConfigured } from '../runtime/relay-mode.js';
import { PairingCodeInput } from '../surfaces/PairingCodeInput.js';
import { computerActionableCount, computerStatus, ComputerChoice } from './ComputerChoice.js';

const EMPTY: ComputerSessionsSnapshot = { computers: [] };
const noSubscription = (): (() => void) => () => undefined;
const PAIR_COMMAND = 'codor pair';
const SWITCHER_DIALOG_ID = 'computer-switcher-dialog';
const SWITCHER_TRIGGER_ID = 'computer-switcher-trigger';

function aggregateLabel(count: number): string {
  return `${count} actionable update${count === 1 ? '' : 's'} on inactive computers`;
}

function fallbackCopy(value: string): boolean {
  if (typeof document === 'undefined' || typeof document.execCommand !== 'function') return false;
  const input = document.createElement('textarea');
  input.value = value;
  input.setAttribute('readonly', '');
  input.style.position = 'fixed';
  input.style.opacity = '0';
  document.body.append(input);
  input.select();
  let copied = false;
  try {
    copied = document.execCommand('copy');
  } catch {
    copied = false;
  }
  input.remove();
  return copied;
}

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
  const [addStep, setAddStep] = useState<1 | 2>(1);
  const [copied, setCopied] = useState(false);
  const [pairing, setPairing] = useState(false);
  const [error, setError] = useState<string>();
  const [renaming, setRenaming] = useState<string>();
  const rootRef = useRef<HTMLDivElement>(null);
  const popupRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const wasOpen = useRef(false);
  const wasAdding = useRef(false);

  useEffect(() => {
    if (!open) return undefined;
    wasOpen.current = true;
    popupRef.current?.querySelector<HTMLElement>('[data-computer-choice="true"]:not([disabled])')?.focus();
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopPropagation();
      setOpen(false);
    };
    const onPointerDown = (event: PointerEvent): void => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('keydown', onKeyDown, true);
    document.addEventListener('pointerdown', onPointerDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown, true);
      document.removeEventListener('pointerdown', onPointerDown);
    };
  }, [open]);

  useEffect(() => {
    if (!open && wasOpen.current) {
      wasOpen.current = false;
      triggerRef.current?.focus();
    }
  }, [open]);

  useEffect(() => {
    if (adding) {
      wasAdding.current = true;
      return;
    }
    if (wasAdding.current) {
      wasAdding.current = false;
      triggerRef.current?.focus();
    }
  }, [adding]);

  if (!relayUrl || !manager || list.computers.length === 0) return null;
  const active = list.computers.find((computer) => computer.active) ?? list.computers.at(-1);
  const status = active ? computerStatus(active) : undefined;
  const inactiveActivity = computerActionableCount(list.computers);

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

  const openAdd = (): void => {
    setOpen(false);
    setAdding(true);
    setAddStep(1);
    setCopied(false);
    setPairing(false);
    setError(undefined);
  };

  const closeAdd = (): void => {
    setAdding(false);
    setAddStep(1);
    setCopied(false);
    setPairing(false);
    setError(undefined);
  };

  const copyPairCommand = (): void => {
    if (fallbackCopy(PAIR_COMMAND)) {
      setCopied(true);
      setError(undefined);
      return;
    }
    if (typeof navigator === 'undefined' || !navigator.clipboard) {
      setError('Copy is unavailable here. Run codor pair manually on the other computer.');
      return;
    }
    void navigator.clipboard.writeText(PAIR_COMMAND).then(
      () => { setCopied(true); setError(undefined); },
      () => setError('Copy is unavailable here. Run codor pair manually on the other computer.'),
    );
  };

  return (
    <div className="nx-computer-switcher" data-testid="computer-switcher" ref={rootRef}>
      <button
        ref={triggerRef}
        type="button"
        id={SWITCHER_TRIGGER_ID}
        className="nx-computer-current"
        data-testid="computer-current"
        aria-label={active
          ? `Active computer ${active.label}, ${status?.label ?? 'status unavailable'}${inactiveActivity > 0 ? `, ${aggregateLabel(inactiveActivity)}` : ''}`
          : 'Choose a computer'}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={SWITCHER_DIALOG_ID}
        onClick={() => setOpen((value) => !value)}
      >
        <Monitor size={15} strokeWidth={1.8} aria-hidden="true" />
        <span className="nx-computer-current-label">{active?.label ?? 'This computer'}</span>
        {status ? <span className={`nx-computer-current-dot is-${status.tone}`} aria-hidden="true" /> : null}
        {inactiveActivity > 0 ? (
          <span
            className="nx-computer-activity-badge"
            data-testid="computer-activity-badge"
            aria-label={aggregateLabel(inactiveActivity)}
          >
            {inactiveActivity > 99 ? '99+' : inactiveActivity}
          </span>
        ) : null}
        <ChevronDown className="nx-computer-current-chevron" size={15} strokeWidth={1.8} aria-hidden="true" />
      </button>
      {open ? (
        <div
          ref={popupRef}
          id={SWITCHER_DIALOG_ID}
          className="nx-computer-menu"
          role="dialog"
          aria-labelledby={SWITCHER_TRIGGER_ID}
        >
          <div className="nx-computer-menu-heading">Paired computers</div>
          <ul>
            {list.computers.map((computer) => (
              <li key={computer.id} data-testid={`computer-${computer.id}`}>
                <ComputerChoice
                  computer={computer}
                  testid={`computer-switch-${computer.id}`}
                  disabled={!computer.active && !computer.ready}
                  onDoubleClick={() => setRenaming(computer.id)}
                  onSelect={() => {
                    if (!computer.active) void manager.activate(computer.id).then((activated) => {
                      if (activated) setOpen(false);
                    });
                  }}
                >
                  {renaming === computer.id ? (
                    <input
                      className="nx-computer-rename"
                      autoFocus
                      defaultValue={computer.label}
                      aria-label={`Rename ${computer.label}`}
                      data-testid={`computer-rename-${computer.id}`}
                      onBlur={(event) => {
                        void manager.rename(computer.id, event.target.value.trim() || computer.label)
                          .then(() => setRenaming(undefined));
                      }}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter') (event.target as HTMLInputElement).blur();
                        if (event.key === 'Escape') setRenaming(undefined);
                      }}
                    />
                  ) : null}
                  <button
                    type="button"
                    className="nx-computer-forget"
                    data-testid={`computer-forget-${computer.id}`}
                    onClick={() => {
                      void manager.forget(computer.id).then((keptMounted) => {
                        if (!keptMounted) window.location.assign('/');
                      });
                    }}
                  >
                    Forget
                  </button>
                </ComputerChoice>
              </li>
            ))}
          </ul>
          <Button variant="quiet" data-testid="computer-add" onClick={openAdd}>
            Add a computer
          </Button>
        </div>
      ) : null}
      {adding ? (
        <Modal label="Add a computer" onClose={closeAdd} testid="computer-add-modal">
          <h2 className="nx-dialog-title">Add a computer</h2>
          <p className="nx-dialog-body">Pair another computer through your existing private relay.</p>
          {addStep === 1 ? (
            <section className="nx-computer-add-step" data-testid="computer-add-step-1">
              <h3>1. Run codor pair</h3>
              <p>On the other computer, run this command and keep the terminal open:</p>
              <div className="nx-computer-pair-command">
                <Code>{PAIR_COMMAND}</Code>
                <Button type="button" variant="quiet" data-testid="computer-add-copy" onClick={copyPairCommand}>
                  {copied ? 'Copied' : 'Copy command'}
                </Button>
              </div>
              <p className="nx-field-note">The code is single-use, expires after ten minutes, and stays inside the existing private relay.</p>
              {error ? <p className="nx-code-error" role="alert">{error}</p> : null}
              <div className="nx-computer-add-actions">
                <Button type="button" variant="primary" data-testid="computer-add-next" onClick={() => { setError(undefined); setAddStep(2); }}>
                  Next: enter code
                </Button>
              </div>
            </section>
          ) : (
            <section className="nx-computer-add-step" data-testid="computer-add-step-2">
              <h3>2. Enter the eight-character code</h3>
              <p>Enter the single-use code printed by <Code>{PAIR_COMMAND}</Code> on the other computer.</p>
              <PairingCodeInput busy={pairing} error={error} submitLabel="Add this computer" onSubmit={add} />
              <Button type="button" variant="quiet" data-testid="computer-add-back" onClick={() => { setError(undefined); setAddStep(1); }}>
                Back
              </Button>
            </section>
          )}
        </Modal>
      ) : null}
    </div>
  );
}
