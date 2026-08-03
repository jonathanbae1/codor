import { ChevronDown, Monitor } from 'lucide-react';
import { createPortal } from 'react-dom';
import { useEffect, useRef, useState, useSyncExternalStore, type CSSProperties } from 'react';

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
const PHONE_BREAKPOINT = 719;
const POPUP_GAP = 6;
const POPUP_MARGIN = 12;

interface PopupPosition {
  left: number;
  top: number;
  maxHeight: number;
}

type PopupStyle = CSSProperties & {
  '--nx-computer-menu-left'?: string;
  '--nx-computer-menu-top'?: string;
  '--nx-computer-menu-max-height'?: string;
};

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
  const [copied, setCopied] = useState(false);
  const [pairing, setPairing] = useState(false);
  const [error, setError] = useState<string>();
  const [renaming, setRenaming] = useState<string>();
  const popupRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const wasOpen = useRef(false);
  const wasAdding = useRef(false);
  const skipFocusRestore = useRef(false);
  const [popupPosition, setPopupPosition] = useState<PopupPosition>();

  const closePopup = (): void => {
    setOpen(false);
    setRenaming(undefined);
    setPopupPosition(undefined);
  };

  useEffect(() => {
    if (!open) return undefined;
    wasOpen.current = true;

    const updatePopupPosition = (): void => {
      const trigger = triggerRef.current;
      const popup = popupRef.current;
      if (!trigger || !popup) return;

      const viewport = window.visualViewport;
      const viewportWidth = Math.max(1, viewport?.width ?? window.innerWidth);
      const viewportHeight = Math.max(1, viewport?.height ?? window.innerHeight);
      if (viewportWidth <= PHONE_BREAKPOINT) {
        setPopupPosition({
          left: POPUP_MARGIN,
          top: POPUP_MARGIN,
          maxHeight: Math.max(1, viewportHeight - POPUP_MARGIN * 2),
        });
        return;
      }

      const triggerRect = trigger.getBoundingClientRect();
      const popupRect = popup.getBoundingClientRect();
      const popupWidth = popupRect.width || Math.min(340, viewportWidth - POPUP_MARGIN * 2);
      const popupHeight = popupRect.height || 1;
      const above = Math.max(1, triggerRect.top - POPUP_MARGIN - POPUP_GAP);
      const below = Math.max(1, viewportHeight - triggerRect.bottom - POPUP_MARGIN - POPUP_GAP);
      const opensAbove = popupHeight <= above || above >= below;
      const available = opensAbove ? above : below;
      const visibleHeight = Math.min(popupHeight, available);
      const left = Math.min(
        Math.max(POPUP_MARGIN, triggerRect.left),
        Math.max(POPUP_MARGIN, viewportWidth - popupWidth - POPUP_MARGIN),
      );
      const unclampedTop = opensAbove
        ? triggerRect.top - POPUP_GAP - visibleHeight
        : triggerRect.bottom + POPUP_GAP;
      const top = Math.min(
        Math.max(POPUP_MARGIN, unclampedTop),
        Math.max(POPUP_MARGIN, viewportHeight - POPUP_MARGIN - visibleHeight),
      );
      setPopupPosition({ left, top, maxHeight: available });
    };

    updatePopupPosition();
    popupRef.current?.querySelector<HTMLElement>('[data-computer-choice="true"]:not([disabled])')?.focus();
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopPropagation();
      closePopup();
    };
    const onPointerDown = (event: PointerEvent): void => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (triggerRef.current?.contains(target) || popupRef.current?.contains(target)) return;
      closePopup();
    };
    const onResize = (): void => updatePopupPosition();
    const onScroll = (): void => updatePopupPosition();
    document.addEventListener('keydown', onKeyDown, true);
    document.addEventListener('pointerdown', onPointerDown);
    window.addEventListener('resize', onResize);
    window.addEventListener('scroll', onScroll, true);
    window.visualViewport?.addEventListener('resize', onResize);
    window.visualViewport?.addEventListener('scroll', onScroll);
    return () => {
      document.removeEventListener('keydown', onKeyDown, true);
      document.removeEventListener('pointerdown', onPointerDown);
      window.removeEventListener('resize', onResize);
      window.removeEventListener('scroll', onScroll, true);
      window.visualViewport?.removeEventListener('resize', onResize);
      window.visualViewport?.removeEventListener('scroll', onScroll);
    };
  }, [open]);

  useEffect(() => {
    if (!open && wasOpen.current) {
      wasOpen.current = false;
      if (skipFocusRestore.current) {
        skipFocusRestore.current = false;
        return;
      }
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
    skipFocusRestore.current = true;
    closePopup();
    setAdding(true);
    setCopied(false);
    setPairing(false);
    setError(undefined);
  };

  const closeAdd = (): void => {
    setAdding(false);
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

  const popupStyle: PopupStyle | undefined = popupPosition ? {
    '--nx-computer-menu-left': `${popupPosition.left}px`,
    '--nx-computer-menu-top': `${popupPosition.top}px`,
    '--nx-computer-menu-max-height': `${popupPosition.maxHeight}px`,
  } : undefined;

  return (
    <div className="nx-computer-switcher" data-testid="computer-switcher">
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
        onClick={() => { if (open) closePopup(); else setOpen(true); }}
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
      {open && typeof document !== 'undefined' ? createPortal(
        <div
          ref={popupRef}
          id={SWITCHER_DIALOG_ID}
          className="nx-computer-menu"
          role="dialog"
          aria-labelledby={SWITCHER_TRIGGER_ID}
          data-positioned={popupPosition ? 'true' : 'false'}
          style={popupStyle}
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
                      if (activated) closePopup();
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
        </div>,
        document.body,
      ) : null}
      {adding ? (
        <Modal label="Add a computer" onClose={closeAdd} testid="computer-add-modal">
          <h2 className="nx-dialog-title">Add a computer</h2>
          <p className="nx-dialog-body">Pair another computer through your existing private relay.</p>
          <div className="nx-computer-add-grid">
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
            </section>
            <section className="nx-computer-add-step" data-testid="computer-add-step-2">
              <h3>2. Enter the eight-character code</h3>
              <p>Enter the single-use code printed by <Code>{PAIR_COMMAND}</Code> on the other computer.</p>
              <PairingCodeInput busy={pairing} error={error} submitLabel="Add this computer" onSubmit={add} />
            </section>
          </div>
        </Modal>
      ) : null}
    </div>
  );
}
