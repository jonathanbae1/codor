import { defineWorkersConfig } from '@cloudflare/vitest-pool-workers/config';

// relay-worker runs under the Cloudflare Workers pool (miniflare/workerd), not
// the shared Node Vitest runtime. It is enumerated in the root
// vitest.workspace.ts as its own project so it loads this config.
export default defineWorkersConfig({
  test: {
    include: ['test/**/*.spec.ts'],
    poolOptions: {
      workers: {
        wrangler: { configPath: './wrangler.jsonc' },
      },
    },
  },
});
