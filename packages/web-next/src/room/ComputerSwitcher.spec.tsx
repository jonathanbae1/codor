// @vitest-environment happy-dom
import { createRoot } from 'react-dom/client';
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const harness = vi.hoisted(() => ({ manager: undefined as {
  subscribe: (listener: () => void) => () => void;
  getSnapshot: () => unknown;
  activate: ReturnType<typeof vi.fn>;
  add: ReturnType<typeof vi.fn>;
  forget: ReturnType<typeof vi.fn>;
  rename: ReturnType<typeof vi.fn>;
} | undefined }));
vi.mock('../runtime/relay-mode.js', () => ({ relayUrlConfigured: () => 'wss://relay.test' }));
vi.mock('../app/computer-sessions.js', () => ({ computerSessions: () => harness.manager }));

const { ComputerSwitcher } = await import('./ComputerSwitcher.js');

const view = (overrides: Record<string, unknown> = {}) => ({
  id: 'A',
  label: 'Desk',
  active: true,
  ready: true,
  connected: true,
  authRefused: false,
  unread: 0,
  attention: false,
  working: 0,
  ...overrides,
});

let host: HTMLDivElement | undefined;
let root: ReturnType<typeof createRoot> | undefined;

async function render(computers: unknown[]) {
  const snapshot = { activeId: 'A', computers };
  harness.manager = {
    subscribe: () => () => undefined,
    getSnapshot: () => snapshot,
    activate: vi.fn(async () => true),
    add: vi.fn(async () => true),
    forget: vi.fn(async () => true),
    rename: vi.fn(async () => undefined),
  };
  host = document.createElement('div');
  document.body.append(host);
  const mountedRoot = createRoot(host);
  root = mountedRoot;
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  await act(async () => { mountedRoot.render(<ComputerSwitcher />); });
}

beforeEach(() => {
  vi.restoreAllMocks();
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: { writeText: vi.fn().mockResolvedValue(undefined) },
  });
});

afterEach(async () => {
  await act(async () => { root?.unmount(); });
  host?.remove();
  harness.manager = undefined;
  delete (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
});

describe('ComputerSwitcher', () => {
  it('shows an aggregate inactive badge and uses repair status without an ARIA menu tree', async () => {
    await render([
      view(),
      view({ id: 'B', label: 'Laptop', active: false, unread: 2, attention: true, working: 1 }),
      view({ id: 'C', label: 'Offline', active: false, ready: false, connected: true, authRefused: true }),
    ]);
    const trigger = host!.querySelector('[data-testid="computer-current"]') as HTMLButtonElement;
    expect(trigger.getAttribute('aria-haspopup')).toBe('dialog');
    expect(trigger.getAttribute('aria-label')).toContain('4 actionable updates on inactive computers');
    expect(host!.querySelector('[data-testid="computer-activity-badge"]')?.textContent).toBe('4');

    await act(async () => { trigger.click(); });
    const popup = document.body.querySelector('.nx-computer-menu') as HTMLElement;
    expect(popup.parentElement).toBe(document.body);
    expect(popup.getAttribute('data-positioned')).toBe('true');
    expect(document.body.querySelector('[role="menu"]')).toBeNull();
    expect(document.body.querySelector('[role="dialog"]')).not.toBeNull();
    expect(document.body.querySelector('[data-testid="computer-connection-C"]')?.textContent).toBe('Repair required');
    expect((document.body.querySelector('[data-testid="computer-switch-C"]') as HTMLButtonElement).disabled).toBe(true);
  });

  it('cleans viewport listeners when the portaled popup closes', async () => {
    const addEventListener = vi.spyOn(window, 'addEventListener');
    const removeEventListener = vi.spyOn(window, 'removeEventListener');
    await render([view(), view({ id: 'B', label: 'Laptop', active: false })]);
    const trigger = host!.querySelector('[data-testid="computer-current"]') as HTMLButtonElement;
    await act(async () => { trigger.click(); });
    expect(addEventListener).toHaveBeenCalledWith('resize', expect.any(Function));
    expect(addEventListener).toHaveBeenCalledWith('scroll', expect.any(Function), true);
    await act(async () => { trigger.click(); });
    expect(removeEventListener).toHaveBeenCalledWith('resize', expect.any(Function));
    expect(removeEventListener).toHaveBeenCalledWith('scroll', expect.any(Function), true);
  });

  it('closes on Escape and returns focus to the trigger', async () => {
    await render([view(), view({ id: 'B', label: 'Laptop', active: false })]);
    const trigger = host!.querySelector('[data-testid="computer-current"]') as HTMLButtonElement;
    trigger.focus();
    await act(async () => { trigger.click(); });
    expect(document.activeElement).toBe(document.body.querySelector('[data-computer-choice="true"]'));
    await act(async () => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    expect(document.body.querySelector('[role="dialog"]')).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it('closes on an outside pointer and returns focus to the trigger', async () => {
    await render([view(), view({ id: 'B', label: 'Laptop', active: false })]);
    const trigger = host!.querySelector('[data-testid="computer-current"]') as HTMLButtonElement;
    await act(async () => { trigger.click(); });
    await act(async () => { document.body.dispatchEvent(new Event('pointerdown', { bubbles: true })); });
    expect(document.body.querySelector('[role="dialog"]')).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it('clears rename state when Escape closes and the popup is reopened', async () => {
    await render([view(), view({ id: 'B', label: 'Laptop', active: false })]);
    const trigger = host!.querySelector('[data-testid="computer-current"]') as HTMLButtonElement;
    await act(async () => { trigger.click(); });
    await act(async () => {
      document.body.querySelector('[data-testid="computer-switch-B"]')?.dispatchEvent(
        new MouseEvent('dblclick', { bubbles: true }),
      );
    });
    expect(document.body.querySelector('[data-testid="computer-rename-B"]')).not.toBeNull();
    await act(async () => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    expect(document.body.querySelector('[role="dialog"]')).toBeNull();
    await act(async () => { trigger.click(); });
    expect(document.body.querySelector('[data-testid="computer-rename-B"]')).toBeNull();
  });

  it('shows both Add Computer steps together with the unchanged code input', async () => {
    await render([view()]);
    const trigger = host!.querySelector('[data-testid="computer-current"]') as HTMLButtonElement;
    await act(async () => { trigger.click(); });
    await act(async () => { (document.body.querySelector('[data-testid="computer-add"]') as HTMLButtonElement).click(); });
    const modal = document.body.querySelector('[data-testid="computer-add-modal"]') as HTMLElement;
    expect(modal.contains(document.activeElement)).toBe(true);
    expect(document.body.querySelector('[data-testid="computer-add-step-1"]')).not.toBeNull();
    expect(document.body.textContent).toContain('codor pair');
    expect(document.body.textContent).toContain('single-use');
    expect(document.body.textContent).toContain('ten minutes');
    expect(document.body.textContent).toContain('private relay');
    expect(document.body.querySelector('[data-testid="computer-add-step-2"]')).not.toBeNull();
    expect(document.body.querySelector('[data-testid="pairing-code-0"]')).not.toBeNull();
    expect(document.body.querySelector('[data-testid="computer-add-next"]')).toBeNull();
    expect(document.body.querySelector('[data-testid="computer-add-back"]')).toBeNull();

    await act(async () => { (document.body.querySelector('[data-testid="computer-add-copy"]') as HTMLButtonElement).click(); });
    expect((navigator.clipboard.writeText as ReturnType<typeof vi.fn>)).toHaveBeenCalledWith('codor pair');
    expect(document.body.querySelector('[data-testid="computer-add-copy"]')?.textContent).toBe('Copied');
    expect(document.body.querySelectorAll('input[data-testid^="pairing-code-"]')).toHaveLength(8);
  });
});
