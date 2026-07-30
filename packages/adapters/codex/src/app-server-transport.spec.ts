import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';

import spawn from 'cross-spawn';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { spawnCodexAppServer } from './app-server-transport.js';

vi.mock('cross-spawn', () => ({ default: vi.fn() }));

function fakeChild(): ChildProcessWithoutNullStreams {
  const child = new EventEmitter() as EventEmitter & {
    stdin: PassThrough;
    stdout: PassThrough;
    stderr: PassThrough;
  };
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  return child as unknown as ChildProcessWithoutNullStreams;
}

// harn:assume codex-app-server-resolves-windows-command-shims ref=codex-app-server-portable-spawn-regression
describe('portable Codex app-server launcher', () => {
  beforeEach(() => {
    vi.mocked(spawn).mockReset();
  });

  it('passes the exact command, argv, and retained-child options', async () => {
    const child = fakeChild();
    vi.mocked(spawn).mockReturnValue(child);
    const env = { PATH: '/tools', CODOR_MEMBER_ID: 'member-codex' };

    const launched = spawnCodexAppServer({
      command: '/tools/codex',
      cwd: '/work',
      env,
    });

    expect(spawn).toHaveBeenCalledWith('/tools/codex', ['app-server'], {
      cwd: '/work',
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: false,
    });
    child.emit('spawn');
    await expect(launched).resolves.toBe(child);
    expect(child.listenerCount('error')).toBe(0);
  });

  it('rejects startup errors without waiting for a spawn event', async () => {
    const child = fakeChild();
    vi.mocked(spawn).mockReturnValue(child);
    const launched = spawnCodexAppServer({
      command: 'codex',
      cwd: '/work',
      env: { PATH: '/tools' },
    });

    child.emit('error', new Error('spawn codex ENOENT'));
    await expect(launched).rejects.toThrow('spawn codex ENOENT');
    expect(child.listenerCount('spawn')).toBe(0);
  });
});
// harn:end codex-app-server-resolves-windows-command-shims
