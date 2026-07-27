import { once } from 'node:events';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { spawnCodexAppServer } from './app-server-transport.js';

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

// harn:assume codex-app-server-resolves-windows-command-shims ref=codex-app-server-windows-shim-regression
describe.skipIf(process.platform !== 'win32')('Codex app-server Windows command shim', () => {
  it('resolves codex.cmd from PATH and preserves piped app-server lifecycle', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'codor-codex-shim-'));
    dirs.push(dir);
    const node = process.execPath.replaceAll('"', '""');
    writeFileSync(
      join(dir, 'codex.cmd'),
      `@"${node}" -e "process.stdin.resume();process.stdin.on('end',function(){process.stdout.write(process.argv[1]||'')})" %*\r\n`,
    );

    const child = await spawnCodexAppServer({
      command: 'codex',
      cwd: dir,
      env: {
        ...process.env,
        PATH: `${dir}${delimiter}${process.env.PATH ?? ''}`,
      },
    });
    let stdout = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk;
    });
    const closed = once(child, 'close');
    child.stdin.end();
    const [code, signal] = await closed;

    expect({ code, signal, stdout }).toEqual({
      code: 0,
      signal: null,
      stdout: 'app-server',
    });
  });
});
// harn:end codex-app-server-resolves-windows-command-shims
