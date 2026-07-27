import { expect, test } from '@playwright/test';

const CONTROL = `http://127.0.0.1:${process.env.CODOR_NEXT_E2E_CONTROL_PORT ?? '28138'}`;

async function control<T = unknown>(path: string): Promise<T> {
  const response = await fetch(`${CONTROL}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{}',
  });
  if (!response.ok) throw new Error(`control ${path} failed: ${response.status}`);
  return (await response.json()) as T;
}

async function pasteCode(page: import('@playwright/test').Page, code: string): Promise<void> {
  await page.getByTestId('pairing-code-0').evaluate((element, pasted) => {
    const data = new DataTransfer();
    data.setData('text/plain', pasted);
    element.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: data }));
  }, code);
}

test.describe('relay tunnel journey', () => {
  test('pairs through the relay in real Chromium, tunnels traffic, and recovers after the host drops', async ({ page }) => {
    test.setTimeout(180_000);
    // The switchboard mints a code through the (mock) blind relay.
    const { code, relayUrl } = await control<{ code: string; relayUrl: string }>('/relay-pair');
    // Relay-mode selection: the hosted SPA would bake this; e2e sets it at runtime.
    await page.addInitScript((url) => {
      (window as unknown as { __CODOR_RELAY_URL?: string }).__CODOR_RELAY_URL = url;
    }, relayUrl);

    await page.goto('/');
    await expect(page.getByTestId('landing-page')).toBeVisible();

    // Pair through the relay — real browser CPace PAKE runs here (webcrypto).
    await pasteCode(page, code);
    await page.getByTestId('pairing-code-submit').click();

    // Landed in the app over the tunnel — this required the KK session handshake
    // (webcrypto) plus tunnelled device auth to succeed first.
    await expect(page.getByTestId('timeline')).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId('connection')).toHaveClass(/is-live/, { timeout: 30_000 });

    // Post over the tunnel and see it echoed back over the tunnel.
    // Address a HUMAN member so the post satisfies the composer's "say who this
    // is for" guard without kicking off an agent run — the point here is the
    // client→server→client round trip over the tunnel, not agent behaviour.
    const input = page.getByTestId('composer-input');
    await input.fill('@viewer hello over the relay');
    // The composer only sends once the room has hydrated over the tunnel; the
    // send button enabling is that gate (connected AND hydrated AND non-empty).
    await expect(page.getByTestId('composer-send')).toBeEnabled({ timeout: 30_000 });
    await input.press('Enter');
    await expect(page.getByTestId('timeline')).toContainText('hello over the relay', { timeout: 20_000 });

    // Kill the tunnel host (agent offline) → the connection visibly drops.
    await control('/relay-down');
    await expect(page.getByTestId('connection')).toHaveClass(/is-error/, { timeout: 30_000 });

    // Restart the host → the reconnect layering re-opens on the new session.
    await control('/relay-up');
    await expect(page.getByTestId('connection')).toHaveClass(/is-live/, { timeout: 40_000 });

    // Still functional after recovery — a fresh app-WS stream on the NEW session.
    await input.fill('@viewer back after recovery');
    await expect(page.getByTestId('composer-send')).toBeEnabled({ timeout: 30_000 });
    await input.press('Enter');
    await expect(page.getByTestId('timeline')).toContainText('back after recovery', { timeout: 20_000 });
  });
});
