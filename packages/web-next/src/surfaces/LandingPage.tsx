import {
  ArrowRight,
  Check,
  Copy,
  Globe2,
  Laptop,
  LockKeyhole,
  Mic,
  Monitor,
  Network,
  Paperclip,
  Pencil,
  Plus,
  Search,
  Send,
  Server,
  ShieldCheck,
  Sparkles,
  Smartphone,
  Terminal,
  Users,
} from 'lucide-react';
import { useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react';

import { PAIRING_TIME_COPY, SESSION_COPY } from '../app/connection-state.js';
import { Chip, StatusPill, TypingDots } from '../primitives/primitives.js';
import { harnessLabel, harnessMark } from '../room/harness-marks.js';
import { exchangeBrowserPairingCode, pairThroughRelay, tryTrustedBrowserPairing } from '@runtime/crypto.js';
import { relayUrlConfigured } from '@runtime/relay-mode.js';

import { PairingCodeInput } from './PairingCodeInput.js';

const INSTALL_COMMAND = 'npx @richhardry/codor setup';
const DEMO_INTERVAL_MS = 3_600;
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

const WORKFLOWS = [
  {
    label: 'Ship a production feature',
    outcome: 'Implementation and independent review land in one channel.',
    roles: [
      { name: 'Fable 5', role: 'Orchestrator', accent: 'green' as const },
      { name: 'Opus', role: 'Coder', accent: 'violet' as const },
      { name: 'GPT 5.6 Sol', role: 'Reviewer', accent: 'indigo' as const },
    ],
  },
  {
    label: 'Design a new product surface',
    outcome: 'The design intent survives all the way into the implementation.',
    roles: [
      { name: 'GPT 5.6 Sol', role: 'Orchestrator', accent: 'indigo' as const },
      { name: 'Opus', role: 'Designer', accent: 'violet' as const },
      { name: 'GPT 5.6 Luna', role: 'Coder', accent: 'green' as const },
    ],
  },
  {
    label: 'Harden a risky migration',
    outcome: 'Build, threat-model, and verification happen as one continuous run.',
    roles: [
      { name: 'Opus', role: 'Orchestrator', accent: 'violet' as const },
      { name: 'Fable 5', role: 'Implementer', accent: 'green' as const },
      { name: 'GPT 5.6 Sol', role: 'Security review', accent: 'indigo' as const },
    ],
  },
  {
    label: 'Turn research into working code',
    outcome: 'Evidence, architecture, and the shipped result stay connected.',
    roles: [
      { name: 'GPT 5.6 Luna', role: 'Researcher', accent: 'green' as const },
      { name: 'Fable 5', role: 'Architect', accent: 'indigo' as const },
      { name: 'Opus', role: 'Builder', accent: 'violet' as const },
    ],
  },
] as const;

function useEnteredViewport<T extends Element>(threshold = 0.35) {
  const ref = useRef<T>(null);
  const [entered, setEntered] = useState(false);

  useEffect(() => {
    if (entered || !ref.current) return;
    const observer = new IntersectionObserver(
      ([entry]) => { if (entry?.isIntersecting) setEntered(true); },
      { threshold },
    );
    observer.observe(ref.current);
    return () => observer.disconnect();
  }, [entered, threshold]);

  return [ref, entered] as const;
}

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
  const [sectionRef, entered] = useEnteredViewport<HTMLElement>(0.28);
  const [phase, setPhase] = useState(reduced ? FINAL_PHASE : -1);

  useEffect(() => {
    if (reduced || !entered || phase >= FINAL_PHASE) return;
    if (phase < 0) {
      setPhase(0);
      return;
    }
    const timer = window.setTimeout(() => setPhase((current) => Math.min(FINAL_PHASE, current + 1)), DEMO_INTERVAL_MS);
    return () => window.clearTimeout(timer);
  }, [entered, phase, reduced]);

  const shown = phase < 0 ? [] : phase >= FINAL_PHASE ? DEMO_TURNS : DEMO_TURNS.slice(0, phase + 1);
  const activeActor = phase < 0 || phase >= FINAL_PHASE ? undefined : shown.at(-1)?.actor;

  return (
    <section ref={sectionRef} className="nx-landing-story nx-demo-story" aria-labelledby="landing-demo-title">
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
          <span className={`nx-demo-walkthrough ${entered ? 'is-running' : ''}`}>
            <i aria-hidden="true" /> {phase >= FINAL_PHASE ? 'Shipped' : entered ? 'Live walkthrough' : 'Starts on scroll'}
          </span>
        </header>

        <div className="nx-demo-app">
          <aside className="nx-demo-roster" aria-label="Channel members" tabIndex={0}>
            <div className="nx-demo-workspace"><span className="nx-landing-mark" aria-hidden="true" /><strong>Codor</strong></div>
            <p>Channels</p>
            <nav aria-label="Demo channels">
              <span># eng</span>
              <span className="is-current"># relay-onboarding</span>
              <span># design</span>
            </nav>
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
              {shown.length === 0 && (
                <li className="nx-demo-empty">
                  <Sparkles size={18} aria-hidden="true" />
                  <span><strong>The room is ready.</strong> Scroll a little further to watch the team work.</span>
                </li>
              )}
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
              {phase >= FINAL_PHASE ? 'Both paths fixed · 58 tests passed' : entered ? 'Team working in the channel' : 'Waiting to enter the viewport'}
            </p>
            <div className="nx-demo-composer" aria-label="Message composer">
              <div className="nx-demo-composebox" role="textbox" aria-readonly="true" aria-label="Message relay-onboarding" tabIndex={0}>
                <span>Message #relay-onboarding</span>
                <div className="nx-demo-compose-tools" aria-hidden="true">
                  <Paperclip size={16} />
                  <Mic size={16} />
                  <span className="nx-demo-send"><Send size={14} /></span>
                </div>
              </div>
              <small><Plus size={12} aria-hidden="true" /> Add files, images, or context</small>
            </div>
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

function HeroActivity() {
  const activity = [
    { name: 'Fable 5', accent: 'green' as const, label: 'is orchestrating', className: 'is-fable' },
    { name: 'GPT 5.6', accent: 'indigo' as const, label: 'is reviewing', className: 'is-gpt' },
    { name: 'Opus', accent: 'violet' as const, label: 'is coding', className: 'is-opus' },
    { name: 'Luna', accent: 'green' as const, label: 'is researching', className: 'is-luna' },
  ];
  return (
    <div className="nx-hero-activity" aria-hidden="true">
      {activity.map((item) => (
        <span className={`nx-hero-typing ${item.className}`} key={item.name}>
          <Chip name={item.name} accent={item.accent} size={26} />
          <span><strong>{item.name}</strong> {item.label}</span>
          <TypingDots />
        </span>
      ))}
    </div>
  );
}

function WorkflowStory() {
  const reduced = useMemo(prefersReducedMotion, []);
  const [sectionRef, entered] = useEnteredViewport<HTMLElement>(0.3);
  const [active, setActive] = useState(0);

  useEffect(() => {
    if (reduced || !entered) return;
    const timer = window.setInterval(() => setActive((current) => (current + 1) % WORKFLOWS.length), 4_800);
    return () => window.clearInterval(timer);
  }, [entered, reduced]);

  const workflow = WORKFLOWS[active] ?? WORKFLOWS[0];
  return (
    <section ref={sectionRef} className="nx-landing-story nx-workflow-story" aria-labelledby="workflow-title">
      <div className="nx-story-copy">
        <p className="nx-landing-kicker">Compose the team</p>
        <h2 id="workflow-title">Multi-agent workflows, with ease.</h2>
        <p>Pick the agents and the roles. Codor keeps their context, evidence, and handoffs in one place while the team changes shape around the job.</p>
      </div>
      <div className="nx-workflow-visual" aria-live="polite">
        <header>
          <span><Sparkles size={15} aria-hidden="true" /> Workflow {active + 1} of {WORKFLOWS.length}</span>
          <strong>{workflow.label}</strong>
        </header>
        <div className="nx-workflow-pipeline" key={workflow.label}>
          {workflow.roles.map((member, index) => (
            <div className="nx-workflow-stage" key={`${workflow.label}-${member.name}`}>
              <article
                className="nx-workflow-role"
                style={{ '--workflow-index': index } as CSSProperties}
              >
                <Chip name={member.name} accent={member.accent} size={42} presence="live" surface="raised" />
                <span><small>{member.role}</small><strong>{member.name}</strong></span>
              </article>
              {index < workflow.roles.length - 1 && <span className="nx-workflow-connector" aria-hidden="true"><i /></span>}
            </div>
          ))}
        </div>
        <footer><Check size={15} aria-hidden="true" /> {workflow.outcome}</footer>
        <div className="nx-workflow-dots" aria-hidden="true">
          {WORKFLOWS.map((item, index) => <i className={index === active ? 'is-active' : ''} key={item.label} />)}
        </div>
      </div>
    </section>
  );
}

function ProductStories() {
  return (
    <div className="nx-product-stories">
      <WorkflowStory />

      <section className="nx-landing-story is-split nx-computers-story" aria-labelledby="computers-title">
        <div className="nx-story-copy">
          <p className="nx-landing-kicker">One place for every project</p>
          <h2 id="computers-title">All your computers. One Codor.</h2>
          <p>
            Pair your laptop, workstation, and remote box once. Switch between them without losing the room,
            the agents, or the thread you were following.
          </p>
        </div>
        <div className="nx-computer-preview" aria-label="Computer switcher preview">
          <header><span className="nx-landing-mark" aria-hidden="true" /><strong>Connected</strong><StatusPill tone="live">Live</StatusPill></header>
          <div className="nx-computer-layout">
            <div className="nx-computer-list">
              <article className="is-active"><Laptop aria-hidden="true" /><span><strong>Studio Mac</strong><small>relay-ui · 3 agents</small></span><i /></article>
              <article><Monitor aria-hidden="true" /><span><strong>Workstation</strong><small>compiler · 2 agents</small></span><i /></article>
              <article><Server aria-hidden="true" /><span><strong>GPU box</strong><small>evals · 1 agent</small></span><i /></article>
            </div>
            <div className="nx-computer-channel">
              <p><span># relay-ui</span><strong>Studio Mac</strong></p>
              <div><Chip name="Fable 5" accent="green" size={30} /><span><strong>Fable 5</strong><small>Landing pass is ready for review.</small></span></div>
              <div><Chip name="GPT 5.6" accent="indigo" size={30} /><span><strong>GPT 5.6</strong><small>Reviewing the mobile motion now.</small></span></div>
              <span className="nx-computer-cursor" aria-hidden="true"><ArrowRight size={13} /> switching host</span>
            </div>
          </div>
        </div>
      </section>

      <section className="nx-landing-story is-split is-reverse" aria-labelledby="anywhere-title">
        <div className="nx-story-copy">
          <p className="nx-landing-kicker">Pick up anywhere</p>
          <h2 id="anywhere-title">Leave your desk. Keep the room.</h2>
          <p>
            Your computer stays the host. Open the same live channel on localhost, across Tailscale, or through
            codor.app when you step away—without moving your repositories or keys.
          </p>
        </div>
        <div className="nx-network-preview" aria-label="Private Codor connection diagram">
          <div className="nx-network-node is-host"><Server aria-hidden="true" /><strong>Your computer</strong><span>keys + repos</span></div>
          <div className="nx-network-path"><span /><LockKeyhole aria-hidden="true" /><small>end-to-end encrypted</small><span /><i aria-hidden="true" /></div>
          <div className="nx-network-devices">
            <span><Laptop aria-hidden="true" /> Browser</span>
            <span><Smartphone aria-hidden="true" /> Phone</span>
            <span><Terminal aria-hidden="true" /> CLI</span>
          </div>
        </div>
      </section>

      <section className="nx-landing-story nx-privacy-story" aria-labelledby="private-title">
        <div className="nx-story-copy">
          <p className="nx-landing-kicker">Private by architecture</p>
          <h2 id="private-title">The relay can connect you. It cannot read you.</h2>
          <p>Codor’s relay holds no channel keys and forwards encrypted payloads only. No Codor account is required, and every paired browser gets its own revocable authority.</p>
        </div>
        <div className="nx-cipher-graphic" aria-label="Encrypted relay diagram">
          <span className="nx-cipher-device"><Laptop aria-hidden="true" /><small>Browser</small></span>
          <div className="nx-cipher-rail"><i /><i /><i /><span /></div>
          <span className="nx-cipher-relay"><Network aria-hidden="true" /><strong>Blind relay</strong><small>ciphertext only</small></span>
          <div className="nx-cipher-rail is-reverse"><i /><i /><i /><span /></div>
          <span className="nx-cipher-device"><Server aria-hidden="true" /><small>Your Codor</small></span>
        </div>
        <div className="nx-privacy-facts">
          <span><LockKeyhole aria-hidden="true" /><strong>End-to-end encrypted</strong><small>keys stay on your devices</small></span>
          <span><Users aria-hidden="true" /><strong>No account required</strong><small>pair with a single-use code</small></span>
          <span><ShieldCheck aria-hidden="true" /><strong>Independently revocable</strong><small>each browser has its own authority</small></span>
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
          <div className="nx-hero-title-stage">
            <HeroActivity />
            <h1 id="landing-title">Fable 5 and GPT 5.6 on the same team? <mark>That's just unfair</mark></h1>
          </div>
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
