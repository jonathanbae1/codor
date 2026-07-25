#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, isAbsolute, join } from 'node:path';

const require = createRequire(import.meta.url);

const [command, ...args] = process.argv.slice(2);
if (command === undefined) {
  process.stderr.write('usage: test-env.mjs <command> [args...]\n');
  process.exit(2);
}

// Resolve a bare package bin name (e.g. "vitest") to its real entrypoint so
// it can run under `node` directly, bypassing the platform-specific
// node_modules/.bin shim (a .CMD file on Windows, which child_process.spawn
// refuses to execute without `shell: true`). Returns undefined for a bare
// command that names no such package (e.g. a system executable like `node`
// or `git`) — the caller falls back to spawning it directly, exactly as
// before this resolution existed. A command that already looks like a path
// (e.g. an absolute executable path a caller resolved itself) is spawned
// unchanged below and never reaches this function.
function resolveBinEntry(name) {
  let packageJsonPath;
  try {
    packageJsonPath = require.resolve(`${name}/package.json`);
  } catch {
    return undefined;
  }
  const pkg = require(packageJsonPath);
  const bin = typeof pkg.bin === 'string' ? pkg.bin : pkg.bin?.[name];
  return bin === undefined ? undefined : join(dirname(packageJsonPath), bin);
}

// harn:assume cli-tests-delete-inherited-codor-environment ref=cli-test-environment-wrapper
const env = { ...process.env };
const removed = Object.keys(env).filter((key) => key.startsWith('CODOR_')).sort();
for (const key of removed) delete env[key];
if (removed.length > 0) {
  process.stderr.write(`test-env: removed ${String(removed.length)} inherited CODOR_ variable(s): ${removed.join(', ')}\n`);
}

const looksLikePath = command.includes('/') || command.includes('\\') || isAbsolute(command);
const binEntry = looksLikePath ? undefined : resolveBinEntry(command);
const [spawnCommand, spawnArgs] = binEntry === undefined
  ? [command, args]
  : [process.execPath, [binEntry, ...args]];
const child = spawn(spawnCommand, spawnArgs, { stdio: 'inherit', env });
child.on('error', (error) => {
  process.stderr.write(`test-env: failed to spawn ${command}: ${error.message}\n`);
  process.exitCode = 1;
});
child.on('exit', (code, signal) => {
  if (signal !== null) {
    process.kill(process.pid, signal);
    return;
  }
  process.exitCode = code ?? 1;
});
// harn:end cli-tests-delete-inherited-codor-environment
