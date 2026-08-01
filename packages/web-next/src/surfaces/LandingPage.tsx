import {
  ArrowRight,
  Bot,
  Check,
  Copy,
  GitBranch,
  Globe2,
  Laptop,
  LockKeyhole,
  Network,
  Pause,
  Pencil,
  Play,
  Search,
  Server,
  ShieldCheck,
  Smartphone,
  Terminal,
  Users,
} from 'lucide-react';
import { useEffect, useMemo, useState, type ReactNode } from 'react';

import { PAIRING_TIME_COPY, SESSION_COPY } from '../app/connection-state.js';
import { Chip, Button, StatusPill } from '../primitives/primitives.js';
import { harnessLabel, harnessMark } from '../room/harness-marks.js';
import { exchangeBrowserPairingCode, pairThroughRelay, tryTrustedBrowserPairing } from '@runtime/crypto.js';
import { relayUrlConfigured } from '@runtime/relay-mode.js';

import { PairingCodeInput } from './PairingCodeInput.js';

const INSTALL_COMMAND = 'npx @richhardry/codor setup';
const DEMO_INTERVAL_MS = 2_400;
const FINAL_PHASE = 6;

const HARNESSES = [
  'claude-code',
  'codex',
  'cursor',
  'gemini',
  'opencode',
  'grok',
  'copilot',
  'antigravity',
] as const;

interface DemoTool {
  icon: 'search' | 'edit' | 'terminal';
  label: ReactNode;
}

interface DemoTurn {
  actor: string;
  accent: 'user' | 'green' | 'indigo';
  time: string;
  message: ReactNode;
  tools?: DemoTool[];
}

const DEMO_TURNS: DemoTurn[] = [
  {
    actor: 'Richard',
    accent: 'user',
    time: '9:41 PM',
    message: <>Ship the relay onboarding, but make sure a filtered network still gets one code that works everywhere.</>,
  },
  {
    actor: 'Fable 5',
    accent: 'green',
    time: '9:42 PM',
    message: <>I’ll trace the setup path and make the failover symmetric before changing the first-run flow.</>,
    tools: [
      { icon: 'search', label: <>Searched <code>RelayLink</code> and setup call sites</> },
      { icon: 'terminal', label: <>Read 6 files across the host runtime and CLI</> },
    ],
  },
  {
    actor: 'GPT 5.6',
    accent: 'indigo',
    time: '9:46 PM',
    message: <>The cached winner is safe, but a cold start still retries only the canonical hostname. The alias needs the same failure path.</>,
    tools: [
      { icon: 'search', label: <>Reviewed connect failure vs mid-session drop</> },
    ],
  },
  {
    actor: 'Fable 5',
    accent: 'green',
    time: '9:49 PM',
    message: <>Fixed. The winner is scoped to its configured relay, and setup now asks the running daemon for the universal offer.</>,
    tools: [
      {
        icon: 'edit',
        label: <><span className="nx-stat-add">+42</span> <span className="nx-stat-del">−8</span> <code>packages/switchboard/src/relay/link.ts</code></>,
      },
      {
        icon: 'edit',
        label: <><span className="nx-stat-add">+31</span> <span className="nx-stat-del">−4</span> <code>packages/cli/src/setup.ts</code></>,
      },
    ],
  },
  {
    actor: 'GPT 5.6',
    accent: 'indigo',
    time: '9:53 PM',
    message: <>I drove both failures. Canonical blocked → alias opens. Cached alias blocked → canonical recovers. Custom relays never inherit the fallback.</>,
    tools: [
      { icon: 'terminal', label: <><code>pnpm test --filter relay-link</code></> },
      { icon: 'terminal', label: <>58 tests passed in the relay-focused gate</> },
    ],
  },
  {
    actor: 'Fable 5',
    accent: 'green',
    time: '9:54 PM',
    message: <>Clean. One command, one code, and the same private channel from localhost, Tailscale, or codor.app.</>,
  },
];

function prefersReducedMotion(): boolean {
  return window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
}

function DemoToolRow({ tool }: { tool: DemoTool }) {
  const Icon = tool.icon === 'edit' ? Pencil : tool.icon === 'search' ? Search : Terminal;
  return (
    <div className="nx-tool is-ok">
      <Icon className="nx-tool-icon" size={14} aria-hidden="true" />
      <span className="nx-tool-label">{tool.label}</span>
      <span className="nx-tool-mark is-ok"><Check size={13} aria-hidden="true" /></span>
    </div>
  );
}

function CollaborationDemo() {
  const reduced = useMemo(prefersReducedMotion, []);
  const [phase, setPhase] = useState(reduced ? FINAL_PHASE : 0);
  const [paused, setPaused] = useState(false);

  useEffect(() => {
    if (reduced || paused || phase >= FINAL_PHASE) return;
    const timer = window.setTimeout(() => setPhase((current) => Math.min(FINAL_PHASE, current + 1)), DEMO_INTERVAL_MS);
    return () => window.clearTimeout(timer);
  }, [paused, phase, reduced]);

  const shown = phase >= FINAL_PHASE ? DEMO_TURNS : DEMO_TURNS.slice(0, Math.max(1, phase + 1));
  const activeActor = phase >= FINAL_PHASE ? undefined : shown.at(-1)?.actor;

  return (
    <section className="nx-landing-story nx-demo-story" aria-labelledby="landing-demo-title">
      <div className="nx-story-copy">
        <p className="nx-landing-kicker">One continuous conversation</p>
        <h2 id="landing-demo-title">The whole team sees the work.</h2>
        <p>
          Agents don’t hand you disconnected summaries. They share a channel, inspect each other’s changes,
          run tools, and leave the actual evidence in the room.
        </p>
      </div>

      <div className="nx-demo" data-testid="landing-demo">
        <header className="nx-demo-windowbar">
          <div className="nx-window-dots" aria-hidden="true"><span /><span /><span /></div>
          <div className="nx-demo-channel"><strong># relay-onboarding</strong><span>3 members</span></div>
          <Button
            type="button"
            variant="quiet"
            className="nx-demo-control"
            disabled={reduced || phase >= FINAL_PHASE}
            aria-label={paused ? 'Resume demo' : phase >= FINAL_PHASE ? 'Demo complete' : 'Pause demo'}
            onClick={() => setPaused((current) => !current)}
          >
            {paused ? <Play size={14} aria-hidden="true" /> : <Pause size={14} aria-hidden="true" />}
            {paused ? 'Resume' : phase >= FINAL_PHASE ? 'Complete' : 'Pause'}
          </Button>
        </header>

        <div className="nx-demo-app">
          <aside className="nx-demo-roster" aria-label="Channel members" tabIndex={0}>
            <p>Members</p>
            {[
              { name: 'Richard', accent: 'user' as const, role: 'You' },
              { name: 'Fable 5', accent: 'green' as const, role: activeActor === 'Fable 5' ? 'working' : 'ready' },
              { name: 'GPT 5.6', accent: 'indigo' as const, role: activeActor === 'GPT 5.6' ? 'reviewing' : 'ready' },
            ].map((member) => (
              <div className={`nx-demo-member ${activeActor === member.name ? 'is-active' : ''}`} key={member.name}>
                <Chip name={member.name} accent={member.accent} size={30} presence="live" surface="raised" />
                <span><strong>{member.name}</strong><small>{member.role}</small></span>
              </div>
            ))}
          </aside>

          <div className="nx-demo-transcript">
            <div className="nx-demo-transcript-head">
              <span>Today</span>
              <StatusPill tone="live">Live</StatusPill>
            </div>
            <ol className="nx-demo-thread" aria-live="polite" aria-atomic="false">
              {shown.map((turn, index) => (
                <li key={`${turn.actor}-${turn.time}`} className={`nx-turn ${index === shown.length - 1 ? 'is-latest' : ''}`}>
                  <Chip name={turn.actor} accent={turn.accent} size={34} presence={index === shown.length - 1 ? 'live' : undefined} />
                  <div className="nx-turn-main">
                    <div className="nx-turn-meta">
                      <strong className="nx-turn-author">{turn.actor}</strong>
                      <time className="nx-turn-time">{turn.time}</time>
                    </div>
                    <div className="nx-prose"><p>{turn.message}</p></div>
                    {turn.tools && <div className="nx-run">{turn.tools.map((tool, toolIndex) => <DemoToolRow key={`${turn.actor}-${String(toolIndex)}`} tool={tool} />)}</div>}
                  </div>
                </li>
              ))}
            </ol>
            <p className="nx-demo-result" data-testid="landing-demo-result">
              <Check size={15} aria-hidden="true" />
              {phase >= FINAL_PHASE ? 'Both paths fixed · 58 tests passed' : 'Review in progress'}
            </p>
          </div>
        </div>
      </div>
    </section>
  );
}

function HarnessRail() {
  return (
    <div className="nx-harness-wrap">
      <div className="nx-harness-rail" aria-label="Supported coding harnesses" tabIndex={0}>
        {HARNESSES.map((id) => (
          <span className="nx-harness-logo" key={id} title={harnessLabel(id)}>
            {harnessMark(id, 28)}
            <span>{harnessLabel(id)}</span>
          </span>
        ))}
      </div>
      <p className="nx-subscription-line">Works with your Claude and ChatGPT subscriptions too</p>
    </div>
  );
}

function ProductStories() {
  return (
    <div className="nx-product-stories">
      <section className="nx-landing-story is-split" aria-labelledby="inspect-title">
        <div className="nx-story-copy">
          <p className="nx-landing-kicker">Work you can inspect</p>
          <h2 id="inspect-title">Not a typing indicator. The real trail.</h2>
          <p>Open the command, file edit, test run, or review that moved the work forward. Nothing gets flattened into “done.”</p>
          <ul className="nx-story-list">
            <li><Check size={15} aria-hidden="true" /> Tool calls stay attached to the turn</li>
            <li><Check size={15} aria-hidden="true" /> Diffs show additions and deletions</li>
            <li><Check size={15} aria-hidden="true" /> Review passes live beside implementation</li>
          </ul>
        </div>
        <div className="nx-diff-preview" aria-label="Example file review">
          <header><GitBranch size={15} aria-hidden="true" /><span>relay-onboard</span><strong>2 files changed</strong></header>
          <div className="nx-diff-file"><Pencil size={14} aria-hidden="true" /><code>relay/link.ts</code><span><b>+42</b> <i>−8</i></span></div>
          <pre aria-label="Code diff" tabIndex={0}><span className="is-context">  const primary = configuredUrl;</span>{'\n'}<span className="is-del">- const target = primary;</span>{'\n'}<span className="is-add">+ const target = cachedWinner ?? primary;</span>{'\n'}<span className="is-add">+ const alternate = relayAlias(primary);</span>{'\n'}<span className="is-context">  socket = dial(target);</span></pre>
          <footer><ShieldCheck size={15} aria-hidden="true" /> Reviewed by GPT 5.6</footer>
        </div>
      </section>

      <section className="nx-landing-story is-split is-reverse" aria-labelledby="anywhere-title">
        <div className="nx-story-copy">
          <p className="nx-landing-kicker">Pick up anywhere</p>
          <h2 id="anywhere-title">Your computer stays the host.</h2>
          <p>
            Keep repositories and keys on the machine you chose. Open the same channel on localhost, across your
            Tailscale network, or through codor.app when you step away.
          </p>
        </div>
        <div className="nx-network-preview" aria-label="Private Codor connection diagram">
          <div className="nx-network-node is-host"><Server aria-hidden="true" /><strong>Your computer</strong><span>keys + repos</span></div>
          <div className="nx-network-path"><span /><LockKeyhole aria-hidden="true" /><small>end-to-end encrypted</small><span /></div>
          <div className="nx-network-devices">
            <span><Laptop aria-hidden="true" /> Browser</span>
            <span><Smartphone aria-hidden="true" /> Phone</span>
            <span><Terminal aria-hidden="true" /> CLI</span>
          </div>
        </div>
      </section>

      <section className="nx-landing-story nx-agent-story" aria-labelledby="team-title">
        <div className="nx-story-copy">
          <p className="nx-landing-kicker">A room for the whole team</p>
          <h2 id="team-title">Start with one agent. Bring in another when the work needs it.</h2>
          <p>Fable can build, GPT can challenge the edge cases, and you keep the final word—without copying context between tabs.</p>
        </div>
        <div className="nx-agent-handoff" aria-label="Agent collaboration handoff">
          <article><Chip name="Richard" accent="user" size={40} presence="live" /><span><strong>You set the direction</strong><small>one request in the shared channel</small></span></article>
          <ArrowRight aria-hidden="true" />
          <article><Chip name="Fable 5" accent="green" size={40} presence="live" /><span><strong>Fable ships the change</strong><small>tools, edits, and tests included</small></span></article>
          <ArrowRight aria-hidden="true" />
          <article><Chip name="GPT 5.6" accent="indigo" size={40} presence="live" /><span><strong>GPT 5.6 reviews it</strong><small>findings return to the same room</small></span></article>
        </div>
      </section>

      <section className="nx-landing-story nx-privacy-story" aria-labelledby="private-title">
        <div className="nx-privacy-icon"><LockKeyhole size={26} aria-hidden="true" /></div>
        <div className="nx-story-copy">
          <p className="nx-landing-kicker">Private by architecture</p>
          <h2 id="private-title">The relay can connect you. It cannot read you.</h2>
          <p>Codor’s relay holds no channel keys and forwards encrypted payloads only. No Codor account is required, and every paired browser gets its own revocable authority.</p>
        </div>
        <div className="nx-privacy-facts">
          <span><LockKeyhole aria-hidden="true" /><strong>End-to-end encrypted</strong><small>keys remain with your devices</small></span>
          <span><Network aria-hidden="true" /><strong>Network-flexible</strong><small>local, Tailscale, or blind relay</small></span>
          <span><Users aria-hidden="true" /><strong>No account required</strong><small>pair with a single-use code</small></span>
        </div>
      </section>
    </div>
  );
}

export function LandingPage() {
  const queryCode = useMemo(() => new URL(window.location.href).searchParams.get('code') ?? '', []);
  const [pairing, setPairing] = useState(false);
  const [failure, setFailure] = useState<string>();
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    // Trusted same-origin enrollment only makes sense on a self-hosted,
    // switchboard-served SPA. The hosted app's origin is the relay (no switchboard
    // to trust), so skip the probe there rather than fire a cross-purpose request.
    if (relayUrlConfigured()) return undefined;
    let current = true;
    void tryTrustedBrowserPairing().then(
      (paired) => { if (current && paired) window.location.replace('/'); },
      () => undefined,
    );
    return () => { current = false; };
  }, []);

  return (
    <main className="nx-landing" data-testid="landing-page">
      <nav className="nx-landing-nav" aria-label="Landing navigation">
        <a className="nx-landing-brand" href="/" aria-label="Codor home">
          <span className="nx-landing-mark" aria-hidden="true" />
          <strong>Codor</strong>
        </a>
        <div className="nx-landing-nav-actions">
          <a href="#conversation">See it work</a>
          <a className="nx-nav-cta" href="#get-started">Get started</a>
        </div>
      </nav>

      <section className="nx-landing-hero" aria-labelledby="landing-title">
        <div className="nx-landing-intro">
          <p className="nx-landing-kicker"><span className="nx-live-dot" aria-hidden="true" /> Your agents, together</p>
          <h1 id="landing-title">Fable 5 and GPT 5.6 on the same team? <mark>That's just unfair</mark></h1>
          <p className="nx-landing-lede">
            One private channel where you direct the work, coding agents share context, and every tool call, edit,
            test, and review stays visible.
          </p>
          <HarnessRail />
        </div>

        <div className="nx-setup-shell" id="get-started">
          <div className="nx-setup-heading">
            <span><Globe2 size={16} aria-hidden="true" /> Your private Codor</span>
            <strong>Two steps. No account.</strong>
          </div>
          <div className="nx-setup" aria-label="Set up Codor in two steps">
            <article className="nx-setup-step">
              <span className="nx-step-number">1</span>
              <div className="nx-step-copy">
                <h2>Install and start Codor</h2>
                <p>Run this once on the computer that holds your projects.</p>
                <div className="nx-command">
                  <Terminal size={17} aria-hidden="true" />
                  <code>{INSTALL_COMMAND}</code>
                  <button
                    type="button"
                    aria-label="Copy install command"
                    onClick={() => {
                      void navigator.clipboard.writeText(INSTALL_COMMAND).then(() => {
                        setCopied(true);
                        window.setTimeout(() => setCopied(false), 1_600);
                      }).catch(() => setCopied(false));
                    }}
                  ><Copy size={15} aria-hidden="true" /></button>
                </div>
                <span className="nx-copy-status" role="status">{copied ? 'Copied' : ''}</span>
              </div>
            </article>

            <article className="nx-setup-step">
              <span className="nx-step-number">2</span>
              <div className="nx-step-copy">
                <h2>Pair this browser</h2>
                <p>Enter the single-use code printed by setup. It expires after ten minutes.</p>
                <PairingCodeInput
                  initialCode={queryCode}
                  busy={pairing}
                  error={failure}
                  onSubmit={(code) => {
                    // A device-network problem must never be blamed on the code.
                    if (typeof navigator !== 'undefined' && !navigator.onLine) {
                      setFailure(SESSION_COPY['device-offline'].body);
                      return;
                    }
                    setPairing(true);
                    setFailure(undefined);
                    const relayUrl = relayUrlConfigured();
                    // pairThroughRelay carries its own abortable deadline, so a dead
                    // room (host never joins) rejects here instead of hanging forever.
                    const flow = relayUrl
                      ? pairThroughRelay(code, relayUrl).then(() => window.location.replace('/'))
                      : exchangeBrowserPairingCode(code).then((url) => window.location.assign(url.toString()));
                    void flow.catch(() => {
                      setPairing(false);
                      // Offline AT rejection time is a device problem, not a bad code.
                      if (typeof navigator !== 'undefined' && !navigator.onLine) {
                        setFailure(SESSION_COPY['device-offline'].body);
                        return;
                      }
                      setFailure(
                        relayUrl
                          // Pairing-time host-never-joins/code-bad (incl. the dead-room
                          // case): a fresh code, not re-pair. Single-sourced copy.
                          ? PAIRING_TIME_COPY['code-bad'].body
                          : 'Pairing code not found. Run setup again for a fresh code.',
                      );
                    });
                  }}
                />
                <a className="nx-pair-link" href="/pair">Have a full pairing link?</a>
              </div>
            </article>
          </div>
          <p className="nx-setup-foot"><ShieldCheck size={15} aria-hidden="true" /> Use it on localhost, over Tailscale, or through the encrypted relay.</p>
        </div>
      </section>

      <div id="conversation"><CollaborationDemo /></div>
      <ProductStories />

      <section className="nx-final-cta" aria-labelledby="final-cta-title">
        <span className="nx-final-mark" aria-hidden="true" />
        <p className="nx-landing-kicker">Your channel is waiting</p>
        <h2 id="final-cta-title">Put the unfair team to work.</h2>
        <a href="#get-started">Set up Codor <ArrowRight size={16} aria-hidden="true" /></a>
      </section>

      <footer className="nx-landing-footer">
        <span>Codor</span>
        <span className="nx-footer-private"><LockKeyhole size={13} aria-hidden="true" /> Private and self-hosted</span>
        <a href="https://github.com/rjx18/codor">Source and documentation</a>
      </footer>
    </main>
  );
}
