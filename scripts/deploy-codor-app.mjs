import { execFileSync, spawnSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// harn:assume codor-app-deploy-bakes-and-verifies-relay-dial-pair ref=hosted-relay-build-and-verify
const PRIMARY_RELAY = 'https://relay.codor.app';
const RELAY_ALIAS = 'https://codor-relay.junweixiong.workers.dev';
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const webDist = join(repoRoot, 'packages', 'web-next', 'dist');
const mode = process.argv[2] ?? '--deploy';

if (!['--deploy', '--build-only', '--verify-only'].includes(mode)) {
  throw new Error('usage: node scripts/deploy-codor-app.mjs [--deploy|--build-only|--verify-only]');
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: repoRoot,
    env: process.env,
    stdio: 'inherit',
    ...options,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} exited ${String(result.status)}`);
}

function javascriptFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return javascriptFiles(path);
    return entry.isFile() && entry.name.endsWith('.js') ? [path] : [];
  });
}

if (mode !== '--verify-only') {
  run('pnpm', ['--filter', '@codor/web-next...', 'build'], {
    env: {
      ...process.env,
      VITE_CODOR_RELAY_URL: PRIMARY_RELAY,
      VITE_CODOR_RELAY_ALIAS: RELAY_ALIAS,
    },
  });
}

const builtJavascript = javascriptFiles(webDist).map((path) => readFileSync(path, 'utf8')).join('\n');
for (const endpoint of [PRIMARY_RELAY, RELAY_ALIAS]) {
  if (!builtJavascript.includes(endpoint)) {
    throw new Error(`refusing codor.app deploy: built JavaScript is missing ${endpoint}`);
  }
}
process.stdout.write('codor.app relay build verified: canonical + alias\n');

if (mode === '--deploy') {
  const commitHash = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoRoot, encoding: 'utf8' }).trim();
  const commitMessage = execFileSync('git', ['log', '-1', '--pretty=%s'], { cwd: repoRoot, encoding: 'utf8' }).trim();
  const dirty = execFileSync('git', ['status', '--porcelain', '--untracked-files=no'], { cwd: repoRoot, encoding: 'utf8' }).trim();
  if (dirty) throw new Error('refusing codor.app deploy from a dirty tracked worktree');
  run('pnpm', [
    '--dir', 'relay-worker', 'exec', 'wrangler', 'pages', 'deploy', webDist,
    '--project-name', 'codor-app',
    '--branch', 'main',
    '--commit-hash', commitHash,
    '--commit-message', commitMessage,
    '--commit-dirty=false',
  ]);
}
// harn:end codor-app-deploy-bakes-and-verifies-relay-dial-pair
