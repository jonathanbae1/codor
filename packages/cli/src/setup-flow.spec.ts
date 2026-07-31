import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { RelayStore, type PairingOffer } from '@codor/switchboard';

import { SetupFlow } from './setup-flow.js';
import { runSetup, type SetupOverrides } from './setup.js';

const flow = () => new SetupFlow([
  { title: 'Check this computer' },
  { title: 'Prepare private files' },
  { title: 'Choose access', kind: 'choice' },
  { title: 'Start Codor' },
  { title: 'Create pairing code' },
]);

describe('step metadata', () => {
  it('stores an optional per-step description from the descriptor', () => {
    const f = new SetupFlow([{ title: 'Install Codor', description: 'Set up Codor in a stable location.' }]);
    expect(f.steps[0]!.description).toBe('Set up Codor in a stable location.');
  });
});

describe('running a step at most once', () => {
  it('marks a pending active step as needing a run, and a done step as not', () => {
    const f = flow();
    expect(f.activeNeedsRun).toBe(true);
    f.markRunning(0);
    f.markDone(0, { checked: true });
    expect(f.activeNeedsRun).toBe(false);
  });

  it('memoizes the exact result object of a completed step', () => {
    const f = flow();
    const offer = { code: 'ABCD-2345' };
    f.markDone(4, offer);
    expect(f.steps[4]!.result).toBe(offer);
  });
});

describe('Next advances only a settled step and never re-runs', () => {
  it('cannot advance while the active step is pending or running', () => {
    const f = flow();
    expect(f.canNext).toBe(false);
    f.markRunning(0);
    expect(f.canNext).toBe(false);
  });

  it('advances the cursor once the active step is done', () => {
    const f = flow();
    f.markDone(0);
    expect(f.canNext).toBe(true);
    f.next();
    expect(f.cursor).toBe(1);
  });

  it('advancing forward over an already-completed step leaves it done', () => {
    const f = flow();
    f.markDone(0);
    f.markDone(1);
    f.next(); // -> 1
    f.next(); // -> 2 is a choice, still pending; cannot go further
    expect(f.cursor).toBe(2);
    expect(f.steps[0]!.state).toBe('done');
    expect(f.steps[1]!.state).toBe('done');
    expect(f.activeNeedsRun).toBe(true); // the choice step still needs deciding
  });
});

describe('Back moves the cursor only', () => {
  it('returns to a completed step without changing its state or result', () => {
    const f = flow();
    const result = { token: 'made' };
    f.markDone(0);
    f.markDone(1, result);
    f.next(); // -> 1
    f.back(); // -> 0
    expect(f.cursor).toBe(0);
    expect(f.steps[1]!.state).toBe('done');
    expect(f.steps[1]!.result).toBe(result);
    // Nothing about step 0 was reset either.
    expect(f.steps[0]!.state).toBe('done');
    expect(f.activeNeedsRun).toBe(false);
  });

  it('cannot go back from the first step', () => {
    const f = flow();
    expect(f.canBack).toBe(false);
    f.back();
    expect(f.cursor).toBe(0);
  });

  it('a completed step returned to and advanced from again is not re-run', () => {
    const f = flow();
    f.markDone(0);
    f.next();  // -> 1
    f.markDone(1);
    f.back();  // -> 0, still done
    f.next();  // -> 1, still done, activeNeedsRun false
    expect(f.cursor).toBe(1);
    expect(f.activeNeedsRun).toBe(false);
  });
});

describe('Retry is the only re-run, and only on a failed step', () => {
  it('is offered only when the active step has failed', () => {
    const f = flow();
    expect(f.canRetry).toBe(false);
    f.markRunning(0);
    expect(f.canRetry).toBe(false);
    f.markDone(0);
    expect(f.canRetry).toBe(false);
    f.markFailed(0, 'boom');
    expect(f.canRetry).toBe(true);
  });

  it('resets a failed step to pending so its work runs again, and clears its error and logs', () => {
    const f = flow();
    f.markRunning(0);
    f.log(0, 'attempting');
    f.markFailed(0, 'launchctl bootstrap failed');
    f.retry();
    expect(f.steps[0]!.state).toBe('pending');
    expect(f.steps[0]!.error).toBeUndefined();
    expect(f.steps[0]!.logs).toEqual([]);
    expect(f.activeNeedsRun).toBe(true);
  });

  it('does nothing on a step that has not failed', () => {
    const f = flow();
    f.markDone(0, 'result');
    f.retry();
    expect(f.steps[0]!.state).toBe('done');
    expect(f.steps[0]!.result).toBe('result');
  });
});

describe('completion', () => {
  it('is reached only when every step is done and the cursor rests on the last', () => {
    const f = flow();
    for (let index = 0; index < 5; index += 1) {
      f.markDone(index);
      if (index < 4) f.next();
    }
    expect(f.cursor).toBe(4);
    expect(f.complete).toBe(true);
  });

  it('is not complete while an earlier step is still pending', () => {
    const f = flow();
    f.markDone(0);
    f.next();
    expect(f.complete).toBe(false);
  });
});

// A POSIX runSetup harness with mocked service commands + probe, so the full flow
// runs to the pairing step without a real daemon. relayOffer is injected to control
// the universal-mint path.
function posixOverrides(root: string, relayOffer?: SetupOverrides['relayOffer']): SetupOverrides {
  const repoRoot = join(root, 'repo');
  mkdirSync(join(repoRoot, 'packages', 'cli', 'dist'), { recursive: true });
  mkdirSync(join(repoRoot, 'packages', 'web-next', 'dist'), { recursive: true });
  mkdirSync(join(repoRoot, 'packaging', 'systemd'), { recursive: true });
  writeFileSync(join(repoRoot, 'packages', 'cli', 'dist', 'index.js'), '', 'utf8');
  writeFileSync(join(repoRoot, 'packages', 'web-next', 'dist', 'index.html'), '', 'utf8');
  writeFileSync(
    join(repoRoot, 'packaging', 'systemd', 'codor.service'),
    'WorkingDirectory=/x\nEnvironmentFile=/x\nExecStart=/usr/bin/node\n',
    'utf8',
  );
  return {
    exec: () => '',
    home: join(root, 'home'),
    nodePath: join(root, 'node'),
    platform: 'linux',
    randomToken: () => 'a'.repeat(64),
    renderQr: () => '[qr]',
    repoRoot,
    probe: async () => true,
    sleep: async () => undefined,
    which: () => undefined,
    relayOffer,
  };
}

const runPosix = async (root: string, opts: { noRelay?: boolean; relayOffer?: SetupOverrides['relayOffer'] }): Promise<string[]> => {
  const out: string[] = [];
  await runSetup({
    dryRun: false,
    yes: true,
    access: 'localhost',
    noRelay: opts.noRelay,
    env: { HOME: join(root, 'home'), PATH: '/usr/bin' },
    out: (line) => out.push(line),
    overrides: posixOverrides(root, opts.relayOffer),
  });
  return out;
};

const universalOffer: PairingOffer = {
  endpoint: 'https://sw.test',
  pairing_token: 'tok',
  pairing_code: 'AB23-CD45',
  expires_at: 'later',
  switchboard_sign_pub: 'sp',
  doors: 'both',
};

describe('runSetup relay-on-by-default (P6b)', () => {
  it('enables the relay and mints a universal first code through the daemon by default', async () => {
    const root = mkdtempSync(join(tmpdir(), 'codor-setup-relay-'));
    try {
      let hit = false;
      const out = await runPosix(root, { relayOffer: async () => { hit = true; return universalOffer; } });
      const text = out.join('\n');
      expect(hit).toBe(true); // minted through the daemon offers API
      expect(text).toContain('AB23-CD45');
      expect(text).toMatch(/works at codor\.app/);
      expect(new RelayStore(join(root, 'home', '.codor')).enabled).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('with noRelay leaves the relay off and mints a local-only code without calling the daemon', async () => {
    const root = mkdtempSync(join(tmpdir(), 'codor-setup-norelay-'));
    try {
      let hit = false;
      const out = await runPosix(root, { noRelay: true, relayOffer: async () => { hit = true; return universalOffer; } });
      expect(hit).toBe(false); // opt-out never reaches the daemon
      expect(out.join('\n')).toMatch(/network only/);
      expect(new RelayStore(join(root, 'home', '.codor')).enabled).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('degrades to a labelled local-only code when the relay is enabled but the offer is unavailable', async () => {
    const root = mkdtempSync(join(tmpdir(), 'codor-setup-degrade-'));
    try {
      const out = await runPosix(root, { relayOffer: async () => undefined });
      expect(out.join('\n')).toMatch(/network only/);
      expect(new RelayStore(join(root, 'home', '.codor')).enabled).toBe(true); // enabled, but offer degraded
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
