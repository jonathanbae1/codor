import { defineWorkersConfig } from '@cloudflare/vitest-pool-workers/config';

// relay-worker runs under the Cloudflare Workers pool (miniflare/workerd), not
// the shared Node Vitest runtime. It is enumerated in the root
// vitest.workspace.ts as its own project so it loads this config.
export default defineWorkersConfig({
  test: {
    include: ['test/**/*.spec.ts'],
    poolOptions: {
      workers: {
        // Disabled: pool-workers 0.12.x's isolated-storage snapshot trips over
        // the SQLite DO .sqlite-shm/-wal sidecar files. Tests isolate instead by
        // using a distinct nameplate/session id per test.
        isolatedStorage: false,
        wrangler: { configPath: './wrangler.jsonc' },
      },
    },
  },
});
