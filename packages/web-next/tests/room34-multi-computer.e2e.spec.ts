import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';

const CONTROL = `http://127.0.0.1:${process.env.CODOR_NEXT_E2E_CONTROL_PORT ?? '28138'}`;
const SPA_ORIGIN = `http://127.0.0.1:${process.env.CODOR_NEXT_E2E_SPA_PORT ?? '28139'}`;
// The switchboard SERVES its own SPA here (direct/self-hosted topology, same-origin API).
const DIRECT_ORIGIN = `http://127.0.0.1:${process.env.CODOR_NEXT_E2E_API_PORT ?? '28137'}`;

async function control<T = unknown>(path: string): Promise<T> {
  const response = await fetch(`${CONTROL}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{}',
  });
  if (!response.ok) throw new Error(`control ${path} failed: ${response.status}`);
  return (await response.json()) as T;
}

async function pasteCode(page: Page, code: string): Promise<void> {
  await page.getByTestId('pairing-code-0').evaluate((element, pasted) => {
    const data = new DataTransfer();
    data.setData('text/plain', pasted);
    element.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: data }));
  }, code);
}

async function post(page: Page, text: string): Promise<void> {
  const input = page.getByTestId('composer-input');
  await input.fill(text);
  await expect(page.getByTestId('composer-send')).toBeEnabled({ timeout: 30_000 });
  await input.press('Enter');
  await expect(page.getByTestId('timeline')).toContainText(text, { timeout: 20_000 });
}

const menuItem = (page: Page, label: string) => page.locator('.nx-computer-menu li', { hasText: label });

/** All per-computer archive room keys in IndexedDB (computer:<id>:<gen>:room:*). */
async function archiveRoomKeys(page: Page): Promise<string[]> {
  return page.evaluate(() => new Promise<string[]>((resolve, reject) => {
    const open = indexedDB.open('codor-crypto-v1');
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const db = open.result;
      const keys: string[] = [];
      const cursor = db.transaction('state').objectStore('state').openKeyCursor();
      cursor.onsuccess = () => {
        const c = cursor.result;
        if (c) { keys.push(String(c.key)); c.continue(); }
        else { db.close(); resolve(keys.filter((k) => /^computer:.+:\d+:room:/.test(k))); }
      };
      cursor.onerror = () => reject(cursor.error);
    };
  }));
}

async function computerSessionId(page: Page, label: string): Promise<string> {
  return page.evaluate((wanted) => new Promise<string>((resolve, reject) => {
    const open = indexedDB.open('codor-crypto-v1');
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const db = open.result;
      const store = db.transaction('state').objectStore('state');
      const indexRequest = store.get('relay-index');
      indexRequest.onerror = () => reject(indexRequest.error);
      indexRequest.onsuccess = () => {
        const index = indexRequest.result as { computers: Array<{ id: string; gen: number; label: string }> };
        const computer = index.computers.find((entry) => entry.label === wanted);
        if (!computer) return reject(new Error(`missing ${wanted}`));
        const relayRequest = store.get(`computer:${computer.id}:${computer.gen}:relay`);
        relayRequest.onerror = () => reject(relayRequest.error);
        relayRequest.onsuccess = () => {
          db.close();
          resolve((relayRequest.result as { session_id: string }).session_id);
        };
      };
    };
  }), label);
}

test.describe('multi-computer pairing', () => {
  test('pair two computers, last-paired default, switch, post on each, forget one', async ({ page }) => {
    test.setTimeout(240_000);

    // Pair computer A (host A) — the only computer, so it's active straight in.
    await control('/relay-up');
    const a = await control<{ code: string; relayUrl: string }>('/relay-pair');
    await page.addInitScript((url) => {
      (window as unknown as { __CODOR_RELAY_URL?: string }).__CODOR_RELAY_URL = url;
      const NativeWebSocket = window.WebSocket;
      (window as unknown as { __relaySessionDials?: Record<string, number> }).__relaySessionDials = {};
      window.WebSocket = class extends NativeWebSocket {
        constructor(target: string | URL, protocols?: string | string[]) {
          super(target, protocols);
          const value = String(target);
          if (value.includes('/v1/session/')) {
            const counts = (window as unknown as { __relaySessionDials: Record<string, number> }).__relaySessionDials;
            counts[value] = (counts[value] ?? 0) + 1;
          }
        }
      };
    }, a.relayUrl);
    await page.goto(`${SPA_ORIGIN}/`);
    await expect(page.getByTestId('landing-page')).toBeVisible();
    await pasteCode(page, a.code);
    await page.getByTestId('pairing-code-submit').click();
    await expect(page.getByTestId('connection')).toHaveClass(/is-live/, { timeout: 30_000 });
    await expect(page.getByTestId('computer-current')).toHaveText(/Computer 1/);
    await page.evaluate(() => { (window as unknown as { __computerDocument?: string }).__computerDocument = 'same-document'; });

    // Add computer B (host B) through the switcher's "Add a computer".
    await control('/relay-up-b');
    const b = await control<{ code: string }>('/relay-pair-b');
    await page.getByTestId('computer-current').click();
    await page.getByTestId('computer-add').click();
    await page.getByTestId('computer-add-next').click();
    await pasteCode(page, b.code);
    await page.getByTestId('pairing-code-submit').click();

    // B is the LAST PAIRED → active in the SAME document, with A still warm.
    await expect(page.getByTestId('connection')).toHaveClass(/is-live/, { timeout: 30_000 });
    await expect(page.getByTestId('computer-current')).toHaveText(/Computer 2/);
    expect(await page.evaluate(() => (window as unknown as { __computerDocument?: string }).__computerDocument)).toBe('same-document');
    await page.getByTestId('computer-current').click();
    await expect(menuItem(page, 'Computer 1').locator('[data-testid^="computer-connection-"]')).toHaveText('Connected');
    await expect(menuItem(page, 'Computer 2').locator('[data-testid^="computer-connection-"]')).toHaveText('Connected');
    const popupA11y = await new AxeBuilder({ page }).include('.nx-computer-menu').analyze();
    expect(popupA11y.violations).toEqual([]);
    await page.getByTestId('computer-current').click();

    const initialDials = await page.evaluate(() => ({
      ...(window as unknown as { __relaySessionDials: Record<string, number> }).__relaySessionDials,
    }));
    expect(Object.values(initialDials)).toEqual([1, 1]); // two concurrent tunnel handshakes

    // Both hosts deliberately use `eng`; each generation still owns exactly its
    // own same-named key, never a shared global credential.
    const rooms = await archiveRoomKeys(page);
    const byComputer = new Map<string, Set<string>>();
    for (const k of rooms) {
      const m = /^(computer:[^:]+:\d+):room:(.+)$/.exec(k);
      if (m) (byComputer.get(m[1]) ?? byComputer.set(m[1], new Set()).get(m[1]))!.add(m[2]);
    }
    expect(byComputer.size).toBe(2); // two computers archived
    expect([...byComputer.values()].every((set) => [...set].includes('eng'))).toBe(true);

    // Post round-trips over computer B's tunnel (its owner is a human member).
    await post(page, '@richard hi from computer two');

    // Switch back to computer A → its own session, its own tunnel.
    await page.getByTestId('computer-current').click();
    await menuItem(page, 'Computer 1').getByRole('button').first().click();
    await expect(page.getByTestId('connection')).toHaveClass(/is-live/, { timeout: 30_000 });
    await expect(page.getByTestId('computer-current')).toHaveText(/Computer 1/);
    expect(await page.evaluate(() => (window as unknown as { __computerDocument?: string }).__computerDocument)).toBe('same-document');
    expect(await page.evaluate(() => ({
      ...(window as unknown as { __relaySessionDials: Record<string, number> }).__relaySessionDials,
    }))).toEqual(initialDials); // switching reused both warm relay sessions
    await expect(page.getByTestId('timeline')).not.toContainText('hi from computer two');
    // Post round-trips over computer A's tunnel.
    await post(page, '@viewer hi from computer one');

    // Inactive B continues consuming its socket into its own store and exposes
    // only aggregate badges in the switcher.
    await control('/computer-b-activity');
    await page.getByTestId('computer-current').click();
    await expect(menuItem(page, 'Computer 2').locator('[data-testid^="computer-working-"]')).toContainText('working', { timeout: 20_000 });
    await expect(menuItem(page, 'Computer 2').locator('[data-testid^="computer-unread-"]')).not.toHaveText('0');
    await page.getByTestId('computer-current').click();

    // Active A fails; recovery offers already-warm B. Choosing it neither reloads
    // nor starts another B relay handshake, and A's retry loop continues.
    const bSession = await computerSessionId(page, 'Computer 2');
    const bDialsBeforeRecovery = Object.entries(initialDials).find(([url]) => url.includes(bSession))?.[1];
    await control('/relay-down-a-only');
    await expect(page.getByTestId('recovery')).toBeVisible({ timeout: 20_000 });
    await page.getByRole('button', { name: /Computer 2, Connected/ }).click();
    await expect(page.getByTestId('computer-current')).toHaveText(/Computer 2/);
    await expect(page.getByTestId('connection')).toHaveClass(/is-live/);
    expect(await page.evaluate(() => (window as unknown as { __computerDocument?: string }).__computerDocument)).toBe('same-document');
    const bDialsAfterRecovery = await page.evaluate((session) => Object.entries(
      (window as unknown as { __relaySessionDials: Record<string, number> }).__relaySessionDials,
    ).find(([url]) => url.includes(session))?.[1], bSession);
    expect(bDialsAfterRecovery).toBe(bDialsBeforeRecovery);

    await control('/relay-up');
    await page.getByTestId('computer-current').click();
    await expect(menuItem(page, 'Computer 1').locator('[data-testid^="computer-connection-"]')).toHaveText('Connected', { timeout: 30_000 });

    // Forget computer B → it disappears, A stays active.
    await menuItem(page, 'Computer 2').getByRole('button', { name: 'Forget' }).click();
    await expect(page.getByTestId('connection')).toHaveClass(/is-live/, { timeout: 30_000 });
    await expect(page.getByTestId('computer-current')).toHaveText(/Computer 1/);
    await page.getByTestId('computer-current').click();
    await expect(menuItem(page, 'Computer 2')).toHaveCount(0);
  });

  test('a switchboard-served SPA renders no computer switcher (direct-path unchanged)', async ({ page }) => {
    test.setTimeout(120_000);
    // No __CODOR_RELAY_URL: the switchboard serves its own SPA (direct path).
    await page.goto(`${DIRECT_ORIGIN}/`);
    await page.waitForLoadState('domcontentloaded');
    // The switcher is hosted-only (relayUrlConfigured-gated) — it must never render
    // on a self-hosted, switchboard-served SPA.
    await expect(page.getByTestId('computer-switcher')).toHaveCount(0);
  });
});
