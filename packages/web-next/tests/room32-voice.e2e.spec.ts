import { expect, test, type Page } from '@playwright/test';

// eng seeds the composer addressed to its default agent, so a successful
// dictation must land the transcript without clobbering that mention.
const ROOM = '/?room=eng&token=next-e2e-token';
const STUB_TRANSCRIPT = 'Voice dictation landed in the composer.';

const disabledCatalog = { enabled: false, selected: 'none', providers: [] };

// Headless Chromium's --use-fake-device flags don't yield a usable capture here
// (getUserMedia → NotSupportedError), so drive the mic + WebAudio boundary with a
// deterministic fake. Everything above it — the controller, WAV encode, the real
// /api/voice/transcribe call, and caret insertion — runs unchanged.
async function installFakeMedia(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const track = { stop() {}, kind: 'audio' };
    const stream = { getTracks: () => [track] };
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: { getUserMedia: () => Promise.resolve(stream) },
    });
    class FakeAudioContext {
      sampleRate = 24_000;
      destination = {};
      createMediaStreamSource() { return { connect() {}, disconnect() {} }; }
      createScriptProcessor() {
        const node: { onaudioprocess: ((e: unknown) => void) | null; connect: () => void; disconnect: () => void } = {
          onaudioprocess: null,
          connect() {
            setTimeout(() => node.onaudioprocess?.({
              inputBuffer: { getChannelData: () => new Float32Array(2_400) },
            }), 0);
          },
          disconnect() {},
        };
        return node;
      }
      close() { return Promise.resolve(); }
    }
    Object.assign(window, { AudioContext: FakeAudioContext, webkitAudioContext: FakeAudioContext });
  });
}

async function openRoom(page: Page): Promise<void> {
  await installFakeMedia(page);
  await page.context().grantPermissions(['microphone']);
  await page.goto(ROOM);
  await expect(page.getByTestId('timeline')).toBeVisible();
  await expect(page.getByTestId('composer-input')).toBeVisible();
}

test.describe('composer dictation', () => {
  test('records, transcribes, and inserts the transcript at the caret', async ({ page }) => {
    await openRoom(page);
    // Type an addressed draft (locks the seed and puts the caret at the end) so
    // the assertion is independent of whichever agent eng seeds by default.
    const input = page.getByTestId('composer-input');
    await input.fill('@fable ');

    const mic = page.getByTestId('composer-mic');
    await mic.click();
    await expect(mic).toHaveAttribute('aria-pressed', 'true');
    await expect(page.getByTestId('composer-mic-cancel')).toBeVisible();

    await page.waitForTimeout(1200); // capture a short utterance
    await mic.click(); // stop -> transcribe -> insert

    await expect(input).toHaveValue(`@fable ${STUB_TRANSCRIPT}`); // mention preserved, transcript at caret
    await expect(mic).toHaveAttribute('aria-pressed', 'false');
    await expect(page.getByTestId('composer-mic-cancel')).toHaveCount(0);
  });

  test('cancel releases the recording without transcribing or touching the draft', async ({ page }) => {
    await openRoom(page);
    const input = page.getByTestId('composer-input');
    await input.fill('@fable draft to keep');
    const seeded = await input.inputValue();

    let transcribeRequested = false;
    page.on('request', (request) => {
      if (request.url().includes('/api/voice/transcribe')) transcribeRequested = true;
    });

    const mic = page.getByTestId('composer-mic');
    await mic.click();
    await expect(mic).toHaveAttribute('aria-pressed', 'true');
    await page.getByTestId('composer-mic-cancel').click();

    await expect(mic).toHaveAttribute('aria-pressed', 'false');
    await expect(page.getByTestId('composer-mic-cancel')).toHaveCount(0);
    await page.waitForTimeout(300);
    expect(transcribeRequested).toBe(false);
    await expect(input).toHaveValue(seeded);
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
