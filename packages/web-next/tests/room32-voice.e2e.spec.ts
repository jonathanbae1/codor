import { expect, test, type Page } from '@playwright/test';

// eng seeds an agent roster, so a dictated message addresses its default agent
// (fixed here by typing a mention) and posts as one `@handle 🎤 "…"` message.
const ROOM = '/?room=eng&token=next-e2e-token';
// The agent-free files room has no dictation history and no agent chatter, so a
// "nothing posted" assertion there is clean (the shared harness accretes 🎤
// messages in eng across tests, so eng assertions key on unique per-call text).
const AGENTLESS = '/?room=files&token=next-e2e-token';
const disabledCatalog = { enabled: false, selected: 'none', providers: [] };

// Headless Chromium's fake-device flags don't yield a usable capture here, so the
// mic + WebAudio boundary is faked, emitting level frames on an interval so the
// waveform draws. Everything above it — session, encode, the real transcribe
// endpoint, and posting — runs unchanged.
async function installFakeMedia(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const stream = { getTracks: () => [{ stop() {} }] };
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: { getUserMedia: () => Promise.resolve(stream) },
    });
    class FakeAudioContext {
      sampleRate = 24_000;
      destination = {};
      createMediaStreamSource() { return { connect() {}, disconnect() {} }; }
      createScriptProcessor() {
        const node: { onaudioprocess: ((e: unknown) => void) | null; timer: number; connect: () => void; disconnect: () => void } = {
          onaudioprocess: null,
          timer: 0,
          connect() {
            node.timer = window.setInterval(() => node.onaudioprocess?.({
              inputBuffer: { getChannelData: () => new Float32Array(2_048).fill(0.4) },
            }), 40);
          },
          disconnect() { window.clearInterval(node.timer); },
        };
        return node;
      }
      close() { return Promise.resolve(); }
    }
    Object.assign(window, { AudioContext: FakeAudioContext, webkitAudioContext: FakeAudioContext });
  });
}

async function openRoom(page: Page, room: string = ROOM): Promise<void> {
  await installFakeMedia(page);
  await page.context().grantPermissions(['microphone']);
  await page.goto(room);
  await expect(page.getByTestId('timeline')).toBeVisible();
  await expect(page.getByTestId('composer-input')).toBeVisible();
}

/** Open the panel with a fixed recipient and record one take, leaving it added. */
async function recordTake(page: Page): Promise<void> {
  await page.getByTestId('dictation-record-another').click();
  await expect(page.getByTestId('dictation-add')).toBeVisible();
  await page.waitForTimeout(120); // let the fake emit a capture buffer
  await page.getByTestId('dictation-add').click();
}

test.describe('composer dictation takeover', () => {
  test('two takes post as one @recipient 🎤 message with both segment lines', async ({ page }) => {
    await openRoom(page);
    await page.getByTestId('composer-input').fill('@viewer');
    await page.getByTestId('composer-mic').click();
    await expect(page.getByTestId('composer-dictation-panel')).toBeVisible();

    await page.waitForTimeout(120); // take 1
    await page.getByTestId('dictation-add').click();
    await recordTake(page); // take 2

    await expect(page.getByTestId('dictation-segment-0')).toContainText(/dictation \d/);
    await expect(page.getByTestId('dictation-segment-1')).toContainText(/dictation \d/);
    const seg0 = (await page.getByTestId('dictation-segment-0').innerText()).match(/dictation \d+/)![0];
    const seg1 = (await page.getByTestId('dictation-segment-1').innerText()).match(/dictation \d+/)![0];

    await page.getByTestId('dictation-send').click();
    await expect(page.getByTestId('composer-input')).toBeVisible();
    await expect(page.getByTestId('composer-input')).toHaveValue('@viewer'); // typed draft untouched

    // One message carries both segment lines, the marker, and the mention.
    const voiceMsg = page.locator('[data-testid^="msg-"]', { hasText: seg0 });
    await expect(voiceMsg).toHaveCount(1);
    await expect(voiceMsg).toContainText('🎤');
    await expect(voiceMsg).toContainText(seg1);
    await expect(voiceMsg).toContainText('viewer'); // the addressed recipient's mention
  });

  test('Send while a take is still transcribing shows a waiting state, then posts', async ({ page }) => {
    await openRoom(page);
    await page.getByTestId('composer-input').fill('@viewer');
    await page.getByTestId('composer-mic').click();
    await page.waitForTimeout(120);
    await page.getByTestId('dictation-add').click(); // one take, now transcribing

    await page.getByTestId('dictation-send').click();
    await expect(page.getByTestId('dictation-waiting')).toBeVisible(); // visibly waiting
    await expect(page.getByTestId('dictation-send')).toBeDisabled(); // single-slot
    // The panel closes only on a successful post, so the composer returning proves it landed.
    await expect(page.getByTestId('composer-input')).toBeVisible();
  });

  test('cancel during recording posts nothing and never uploads', async ({ page }) => {
    await openRoom(page, AGENTLESS);
    let transcribeRequested = false;
    page.on('request', (request) => {
      if (request.url().includes('/api/voice/transcribe')) transcribeRequested = true;
    });
    await page.getByTestId('composer-mic').click();
    await expect(page.getByTestId('composer-dictation-panel')).toBeVisible();
    await page.waitForTimeout(120);
    await page.getByTestId('dictation-cancel').click();

    await expect(page.getByTestId('composer-input')).toBeVisible();
    await page.waitForTimeout(200);
    expect(transcribeRequested).toBe(false);
    await expect(page.locator('[data-testid^="msg-"]', { hasText: '🎤' })).toHaveCount(0);
  });

  test('discard-all after adding a take posts nothing', async ({ page }) => {
    await openRoom(page, AGENTLESS);
    await page.getByTestId('composer-mic').click();
    await page.waitForTimeout(120);
    await page.getByTestId('dictation-add').click(); // take is transcribing
    await page.getByTestId('dictation-discard').click();

    await expect(page.getByTestId('composer-input')).toBeVisible();
    await page.waitForTimeout(500); // any in-flight transcription must be ignored
    await expect(page.locator('[data-testid^="msg-"]', { hasText: '🎤' })).toHaveCount(0);
  });

  test('removing a segment excludes its text from the sent message', async ({ page }) => {
    await openRoom(page);
    await page.getByTestId('composer-input').fill('@viewer');
    await page.getByTestId('composer-mic').click();
    await page.waitForTimeout(120);
    await page.getByTestId('dictation-add').click();
    await recordTake(page); // two takes

    await expect(page.getByTestId('dictation-segment-0')).toContainText(/dictation \d/);
    await expect(page.getByTestId('dictation-segment-1')).toContainText(/dictation \d/);
    const removed = (await page.getByTestId('dictation-segment-0').innerText()).match(/dictation \d+/)![0];
    const kept = (await page.getByTestId('dictation-segment-1').innerText()).match(/dictation \d+/)![0];

    await page.getByTestId('dictation-segment-0-remove').click();
    await page.getByTestId('dictation-send').click();
    await expect(page.getByTestId('composer-input')).toBeVisible();

    const voiceMsg = page.locator('[data-testid^="msg-"]', { hasText: kept });
    await expect(voiceMsg).toHaveCount(1);
    await expect(voiceMsg).not.toContainText(removed);
    await expect(page.locator('[data-testid^="msg-"]', { hasText: removed })).toHaveCount(0);
  });

  test('renders no mic when the catalog reports dictation disabled', async ({ page }) => {
    await page.route('**/api/voice/providers', (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(disabledCatalog) }));
    await openRoom(page);
    await expect(page.getByTestId('composer-mic')).toHaveCount(0);
  });
});

test.describe('composer dictation on mobile', () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test('renders no mic in the mobile row when dictation is disabled', async ({ page }) => {
    await page.route('**/api/voice/providers', (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(disabledCatalog) }));
    await openRoom(page);
    await expect(page.getByTestId('composer-mic')).toHaveCount(0);
  });
});
