import type { ReactNode } from 'react';

import type { ComputerSessionView } from '../app/computer-sessions.js';

export type ComputerStatusTone = 'connected' | 'reconnecting' | 'repair';

export interface ComputerStatus {
  label: 'Connected' | 'Reconnecting' | 'Repair required';
  tone: ComputerStatusTone;
}

/** The only status mapping used by the switcher and recovery escape hatch. */
export function computerStatus(computer: ComputerSessionView): ComputerStatus {
  if (computer.authRefused) return { label: 'Repair required', tone: 'repair' };
  if (computer.connected) return { label: 'Connected', tone: 'connected' };
  return { label: 'Reconnecting', tone: 'reconnecting' };
}

/** Counts actionable units, deliberately excluding the active computer. */
export function computerActionableCount(computers: ComputerSessionView[]): number {
  return computers
    .filter((computer) => !computer.active)
    .reduce((total, computer) => total + computer.unread + (computer.attention ? 1 : 0) + computer.working, 0);
}

function activity(computer: ComputerSessionView): string[] {
  return [
    computer.unread > 0 ? `${computer.unread} unread` : undefined,
    computer.attention ? 'Needs attention' : undefined,
    computer.working > 0 ? `${computer.working} working` : undefined,
  ].filter((value): value is string => value !== undefined);
}

/**
 * A compact, full-width computer choice. Optional children are kept outside the
 * switch button so rename/Forget never create nested interactive controls.
 */
export function ComputerChoice({
  computer,
  onSelect,
  disabled = false,
  testid,
  onDoubleClick,
  children,
}: {
  computer: ComputerSessionView;
  onSelect: () => void;
  disabled?: boolean;
  testid?: string;
  onDoubleClick?: () => void;
  children?: ReactNode;
}): ReactNode {
  const status = computerStatus(computer);
  const details = activity(computer);
  const accessibleName = [
    computer.label,
    computer.active ? 'Active' : undefined,
    status.label,
    ...details,
  ].filter((value): value is string => value !== undefined).join(', ');

  return (
    <div className="nx-computer-choice-row">
      <button
        type="button"
        className={`nx-computer-choice is-${status.tone}`}
        data-testid={testid}
        data-computer-choice="true"
        aria-label={accessibleName}
        aria-current={computer.active ? 'true' : undefined}
        disabled={disabled}
        onClick={onSelect}
        onDoubleClick={onDoubleClick}
      >
        <span className="nx-computer-choice-copy">
          <span className="nx-computer-choice-top">
            <span className="nx-computer-choice-label">{computer.label}</span>
            {computer.active ? <span className="nx-computer-choice-active">Active</span> : null}
          </span>
          <span className={`nx-computer-choice-status is-${status.tone}`} data-testid={`computer-connection-${computer.id}`}>
            <span className={`nx-computer-choice-dot is-${status.tone}`} aria-hidden="true" />
            {status.label}
          </span>
          {details.length > 0 ? (
            <span className="nx-computer-choice-activity" aria-label={details.join(', ')}>
              {computer.unread > 0 ? <span data-testid={`computer-unread-${computer.id}`}>{computer.unread} unread</span> : null}
              {computer.attention ? <span data-testid={`computer-attention-${computer.id}`}>Needs attention</span> : null}
              {computer.working > 0 ? <span data-testid={`computer-working-${computer.id}`}>{computer.working} working</span> : null}
            </span>
          ) : null}
        </span>
      </button>
      {children ? <span className="nx-computer-choice-actions">{children}</span> : null}
    </div>
  );
}
