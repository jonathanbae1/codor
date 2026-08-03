import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';

const CONTROL = `http://127.0.0.1:${process.env.CODOR_NEXT_E2E_CONTROL_PORT ?? '28138'}`;
const SPA_ORIGIN = `http://127.0.0.1:${process.env.CODOR_NEXT_E2E_SPA_PORT ?? '28139'}`;

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

test.use({ viewport: { width: 390, height: 844 } });

test.describe('computer switcher UI', () => {
  test('phone popup and Add Computer modal stay keyboard- and axe-safe', async ({ page }) => {
    test.setTimeout(120_000);
    await control('/relay-up');
    const { code, relayUrl } = await control<{ code: string; relayUrl: string }>('/relay-pair');
    await page.addInitScript((url) => {
      (window as unknown as { __CODOR_RELAY_URL?: string }).__CODOR_RELAY_URL = url;
    }, relayUrl);
    await page.goto(`${SPA_ORIGIN}/`);
    await expect(page.getByTestId('landing-page')).toBeVisible();
    await pasteCode(page, code);
    await page.getByTestId('pairing-code-submit').click();
    await expect(page.getByTestId('timeline')).toBeVisible({ timeout: 30_000 });

    // The switcher lives in the channel rail on phone widths, so enter that
    // surface using the existing mobile navigation first.
    await page.getByTestId('mobile-back').click();
    await expect(page.getByTestId('computer-current')).toBeVisible();
    await page.getByTestId('computer-current').click();
    const popup = page.locator('.nx-computer-menu');
    await expect(page.getByRole('dialog', { name: /Active computer/ })).toBeVisible();
    expect(await popup.evaluate((node) => node.parentElement === document.body)).toBe(true);
    const popupBox = await popup.boundingBox();
    expect(popupBox).not.toBeNull();
    expect(popupBox!.x).toBeGreaterThanOrEqual(0);
    expect(popupBox!.x + popupBox!.width).toBeLessThanOrEqual(390);
    expect(popupBox!.y).toBeGreaterThanOrEqual(0);
    expect(popupBox!.y + popupBox!.height).toBeLessThanOrEqual(844);
    const hit = await popup.evaluate((node) => {
      const box = node.getBoundingClientRect();
      const target = document.elementFromPoint(box.left + 8, box.top + 8);
      return target !== null && node.contains(target);
    });
    expect(hit).toBe(true);
    const popupA11y = await new AxeBuilder({ page }).include('.nx-computer-menu').analyze();
    expect(popupA11y.violations).toEqual([]);

    await page.getByTestId('computer-add').click();
    const modal = page.getByTestId('computer-add-modal');
    await expect(modal).toBeVisible();
    await expect(modal).toContainText('1. Run codor pair');
    await expect(modal).toContainText('2. Enter the eight-character code');
    await expect(modal).toContainText('single-use');
    await expect(modal).toContainText('ten minutes');
    await expect(modal).toContainText('existing private relay');
    await expect(modal.getByTestId('pairing-code-0')).toBeVisible();
    await expect(modal.getByTestId('computer-add-next')).toHaveCount(0);
    await expect(modal.getByTestId('computer-add-back')).toHaveCount(0);
    const modalA11y = await new AxeBuilder({ page }).include('[data-testid="computer-add-modal"]').analyze();
    expect(modalA11y.violations).toEqual([]);

    await modal.getByTestId('computer-add-copy').click();
    await expect(modal.getByTestId('computer-add-copy')).toHaveText('Copied');
    await page.keyboard.press('Escape');
    await expect(modal).toHaveCount(0);
  });
});
