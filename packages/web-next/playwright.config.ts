import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { defineConfig } from '@playwright/test';

function readPort(name: string, fallback: number): number {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isInteger(value) || value < 1 || value > 65_535) {
    throw new Error(`${name} must be a valid TCP port`);
  }
  return value;
}

// harn:assume playwright-spec-files-use-isolated-daemons ref=isolated-e2e-playwright-config
const apiPort = readPort('CODOR_NEXT_E2E_API_PORT', 28_137);

export default defineConfig({
  testDir: './tests',
  testMatch: ['*.e2e.spec.ts'],
  outputDir: join(tmpdir(), 'codor-next-playwright'),
  workers: 1,
  use: {
    baseURL: `http://127.0.0.1:${String(apiPort)}`,
    // The reference desktop composition: all three islands visible.
    viewport: { width: 1440, height: 900 },
    // A fake mic + auto-granted permission so dictation captures headlessly.
    launchOptions: {
      args: ['--use-fake-device-for-media-capture', '--use-fake-ui-for-media-capture'],
    },
  },
  webServer: {
    // The suite runner builds the workspace once, then every spec invocation
    // starts and stops its own harness against its own derived port range.
    command: 'node tests/harness.mjs',
    url: `http://127.0.0.1:${String(apiPort)}/`,
    // Every run owns a fresh fixture database. Reusing an orphaned harness
    // silently couples runs through mutated messages, cursors, and adapter
    // queues, producing failures that cannot occur in a clean browser session.
    reuseExistingServer: false,
    stdout: 'pipe',
    stderr: 'pipe',
  },
});
// harn:end playwright-spec-files-use-isolated-daemons
