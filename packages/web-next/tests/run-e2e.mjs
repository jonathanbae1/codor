// Build once, then run every browser spec in its own Playwright invocation.
// Each invocation owns a fresh harness daemon, databases, crypto vault, blob
// root, and four ports, so durable test state cannot cross a spec boundary.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const testsRoot = join(packageRoot, 'tests');
const portsPerSpec = 4;
const pnpm = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: packageRoot,
    stdio: 'inherit',
    ...options,
  });
  if (result.error) throw result.error;
  return result.status;
}

// harn:assume concurrent-browser-suites-do-not-collide ref=e2e-runner-port-selection
function readOverride(span) {
  const raw = process.env.CODOR_NEXT_E2E_PORT_BASE;
  if (raw === undefined) return undefined;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1 || value + span - 1 > 65_535) {
    throw new Error('CODOR_NEXT_E2E_PORT_BASE must leave room for every spec port');
  }
  return value;
}

function isFree(port) {
  return new Promise((resolve) => {
    const probe = createServer();
    probe.once('error', () => resolve(false));
    probe.once('listening', () => probe.close(() => resolve(true)));
    probe.listen(port, '127.0.0.1');
  });
}

async function rangeIsFree(base, span) {
  const ports = Array.from({ length: span }, (_, offset) => base + offset);
  const free = await Promise.all(ports.map((port) => isFree(port)));
  return free.every(Boolean);
}

async function selectBasePort(specCount) {
  const span = specCount * portsPerSpec;
  const override = readOverride(span);
  if (override !== undefined) {
    if (!(await rangeIsFree(override, span))) {
      throw new Error('CODOR_NEXT_E2E_PORT_BASE range is not currently free');
    }
    return override;
  }
  for (let base = 28_137; base + span - 1 < 60_000; base += span) {
    if (await rangeIsFree(base, span)) return base;
  }
  throw new Error('no free contiguous port range for the browser suite');
}
// harn:end concurrent-browser-suites-do-not-collide

function readCounts(reportPath, spec) {
  let stats;
  try {
    stats = JSON.parse(readFileSync(reportPath, 'utf8')).stats;
  } catch (error) {
    throw new Error(`${spec}: unreadable Playwright report (${String(error)})`);
  }
  if (!stats) throw new Error(`${spec}: Playwright report carried no stats`);
  const expected = stats.expected ?? 0;
  const unexpected = stats.unexpected ?? 0;
  const flaky = stats.flaky ?? 0;
  const skipped = stats.skipped ?? 0;
  return { expected, unexpected, flaky, skipped, total: expected + unexpected + flaky + skipped };
}

// harn:assume e2e-gate-covers-every-spec-file ref=isolated-e2e-spec-runner
const specs = readdirSync(testsRoot)
  .filter((name) => name === 'e2e.spec.ts' || name.endsWith('.e2e.spec.ts'))
  .sort();
if (specs.length === 0) throw new Error('no browser spec file matched the suite pattern');

if (run(pnpm, ['-r', 'build']) !== 0) {
  throw new Error('workspace build failed before browser tests');
}

const basePort = await selectBasePort(specs.length);
const lastPort = basePort + specs.length * portsPerSpec - 1;
process.stdout.write(`[e2e] ${String(specs.length)} spec files on ports ${String(basePort)}-${String(lastPort)}\n`);

const reportRoot = mkdtempSync(join(tmpdir(), 'codor-next-e2e-report-'));
const totals = { expected: 0, unexpected: 0, flaky: 0, skipped: 0, total: 0 };
const failed = [];

try {
  for (const [index, spec] of specs.entries()) {
    const apiPort = basePort + index * portsPerSpec;
    const reportPath = join(reportRoot, `${spec}.json`);
    process.stdout.write(
      `\n[e2e] ${spec} on ports ${String(apiPort)}-${String(apiPort + portsPerSpec - 1)}\n`,
    );
    // harn:assume playwright-spec-files-use-isolated-daemons ref=isolated-e2e-spec-ports
    const status = run(
      pnpm,
      ['exec', 'playwright', 'test', `tests/${spec}`, '--reporter=list,json'],
      {
        env: {
          ...process.env,
          CODOR_NEXT_E2E_API_PORT: String(apiPort),
          CODOR_NEXT_E2E_CONTROL_PORT: String(apiPort + 1),
          CODOR_NEXT_E2E_SPA_PORT: String(apiPort + 2),
          CODOR_NEXT_E2E_API_PORT_B: String(apiPort + 3),
          PLAYWRIGHT_JSON_OUTPUT_NAME: reportPath,
        },
      },
    );
    // harn:end playwright-spec-files-use-isolated-daemons

    const counts = readCounts(reportPath, spec);
    for (const key of Object.keys(totals)) totals[key] += counts[key];
    if (status !== 0) failed.push(spec);
    process.stdout.write(
      `[e2e] ${spec}: ${String(counts.total)} tests (${String(counts.expected)} passed,`
      + ` ${String(counts.unexpected)} failed, ${String(counts.flaky)} flaky,`
      + ` ${String(counts.skipped)} skipped)\n`,
    );
  }
} finally {
  rmSync(reportRoot, { recursive: true, force: true });
}

process.stdout.write(
  `\n[e2e] ${String(specs.length)} spec files, ${String(totals.total)} tests`
  + ` (${String(totals.expected)} passed, ${String(totals.unexpected)} failed,`
  + ` ${String(totals.flaky)} flaky, ${String(totals.skipped)} skipped)\n`,
);
if (failed.length > 0) {
  process.stdout.write(`[e2e] failed spec files: ${failed.join(', ')}\n`);
  process.exit(1);
}
// harn:end e2e-gate-covers-every-spec-file
