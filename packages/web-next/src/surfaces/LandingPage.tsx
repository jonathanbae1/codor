import {
  AudioLines,
  ArrowRight,
  Check,
  ChevronRight,
  Code2,
  Compass,
  Copy,
  Crown,
  Eye,
  FileImage,
  FileText,
  Gauge,
  GitCompareArrows,
  GitBranch,
  Globe2,
  Laptop,
  LoaderCircle,
  LockKeyhole,
  Mic,
  Monitor,
  Network,
  Palette,
  Pencil,
  Plus,
  RefreshCw,
  Search,
  Send,
  Server,
  ShieldCheck,
  Sparkles,
  Smartphone,
  Terminal,
  TestTube2,
  Upload,
  Users,
  type LucideIcon,
} from 'lucide-react';
import { useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react';

import { PAIRING_TIME_COPY, SESSION_COPY } from '../app/connection-state.js';
import { Chip, StatusPill, TypingDots } from '../primitives/primitives.js';
import { harnessLabel, harnessMark } from '../room/harness-marks.js';
import { exchangeBrowserPairingCode, pairThroughRelay, tryTrustedBrowserPairing } from '@runtime/crypto.js';
import { relayUrlConfigured } from '@runtime/relay-mode.js';

import { PairingCodeInput } from './PairingCodeInput.js';

const INSTALL_COMMAND = 'npx @richhardry/codor setup';
const DEMO_INTERVAL_MS = 1_550;
const FINAL_PHASE = 20;

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

const WORKFLOWS = [
  {
    label: 'Production pipeline',
    outcome: 'A clean handoff from plan → implementation → independent review.',
    layout: 'pipeline',
    routes: ['M18 50 H43', 'M57 50 H82'],
    roles: [
      { name: 'Fable 5', role: 'Plans + delegates', accent: 'green' as const, icon: Crown, harness: 'claude-code', slot: 'left', weight: 'lead' },
      { name: 'Opus', role: 'Owns implementation', accent: 'violet' as const, icon: Code2, harness: 'claude-code', slot: 'center', weight: 'primary' },
      { name: 'GPT 5.6 Sol', role: 'Independent gate', accent: 'indigo' as const, icon: ShieldCheck, harness: 'codex', slot: 'right', weight: 'support' },
    ],
  },
  {
    label: 'Design studio',
    outcome: 'Research and visual direction converge in a working prototype.',
    layout: 'studio',
    routes: ['M50 24 C42 36 28 51 22 70', 'M50 24 C58 36 72 51 78 70', 'M30 75 H70'],
    roles: [
      { name: 'GPT 5.6 Sol', role: 'Product direction', accent: 'indigo' as const, icon: Compass, harness: 'codex', slot: 'top', weight: 'lead' },
      { name: 'Opus', role: 'Visual system', accent: 'violet' as const, icon: Palette, harness: 'claude-code', slot: 'bottom-left', weight: 'primary' },
      { name: 'GPT 5.6 Luna', role: 'Interactive prototype', accent: 'green' as const, icon: Code2, harness: 'cursor', slot: 'bottom-right', weight: 'primary' },
    ],
  },
  {
    label: 'Review council',
    outcome: 'Three specialist reads feed one explicit ship decision.',
    layout: 'council',
    routes: ['M18 28 C26 48 38 62 50 77', 'M50 25 V77', 'M82 28 C74 48 62 62 50 77'],
    roles: [
      { name: 'Opus', role: 'Implementation read', accent: 'violet' as const, icon: Code2, harness: 'claude-code', slot: 'top-left', weight: 'primary' },
      { name: 'GPT 5.6 Sol', role: 'Security critique', accent: 'indigo' as const, icon: ShieldCheck, harness: 'codex', slot: 'top', weight: 'support' },
      { name: 'Luna', role: 'UX + regression read', accent: 'green' as const, icon: TestTube2, harness: 'gemini', slot: 'top-right', weight: 'support' },
      { name: 'Fable 5', role: 'Synthesizes verdict', accent: 'green' as const, icon: Crown, harness: 'claude-code', slot: 'bottom', weight: 'lead' },
    ],
  },
  {
    label: 'Incident room',
    outcome: 'Observe, repair, and verify in parallel under one commander.',
    layout: 'incident',
    routes: ['M50 50 L20 22', 'M50 50 L80 22', 'M50 50 V80', 'M80 22 C91 48 76 71 55 80'],
    roles: [
      { name: 'Fable 5', role: 'Incident commander', accent: 'green' as const, icon: Crown, harness: 'claude-code', slot: 'center', weight: 'lead' },
      { name: 'Luna', role: 'Logs + reproduction', accent: 'green' as const, icon: Search, harness: 'gemini', slot: 'top-left', weight: 'support' },
      { name: 'Opus', role: 'Live repair', accent: 'violet' as const, icon: Code2, harness: 'cursor', slot: 'top-right', weight: 'primary' },
      { name: 'GPT 5.6 Sol', role: 'Recovery verification', accent: 'indigo' as const, icon: Eye, harness: 'codex', slot: 'bottom', weight: 'support' },
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

function DemoToolRow({ tool, running = false }: { tool: DemoTool; running?: boolean }) {
  const Icon = tool.icon === 'edit' ? Pencil : tool.icon === 'search' ? Search : Terminal;
  return (
    <div className={`nx-tool ${running ? 'is-running' : 'is-ok'}`}>
      <Icon className="nx-tool-icon" size={14} aria-hidden="true" />
      <span className="nx-tool-label">{tool.label}</span>
      <span className={`nx-tool-mark ${running ? 'is-running' : 'is-ok'}`}>
        {running
          ? <LoaderCircle className="nx-spin" size={13} aria-label="running" />
          : <Check size={13} aria-label="done" />}
      </span>
    </div>
  );
}

function DemoTurn(props: {
  actor: string;
  accent: 'user' | 'green' | 'indigo' | 'violet';
  time: string;
  children: ReactNode;
}) {
  return (
    <li className="nx-turn nx-demo-turn">
      <Chip name={props.actor} accent={props.accent} size={34} />
      <div className="nx-turn-main">
        <div className="nx-turn-meta">
          <strong className="nx-turn-author">{props.actor}</strong>
          <time className="nx-turn-time">{props.time}</time>
        </div>
        {props.children}
      </div>
    </li>
  );
}

function DemoToolProgress(props: {
  tools: DemoTool[];
  step: number;
  summary: string;
}) {
  if (props.step < 0) return null;
  if (props.step >= props.tools.length) {
    return (
      <div className="nx-batch">
        <span className="nx-batch-line"><ChevronRight size={14} aria-hidden="true" />{props.summary}</span>
      </div>
    );
  }
  return (
    <div className="nx-run">
      {props.tools.slice(0, props.step + 1).map((tool, index) => (
        <DemoToolRow key={String(index)} tool={tool} running={index === props.step} />
      ))}
    </div>
  );
}

function DemoInteraction(props: {
  kind: 'Question' | 'Approval needed';
  prompt: string;
  detail?: string;
  options: string[];
  selected?: string;
  sent?: boolean;
}) {
  return (
    <div className="nx-ask nx-demo-ask">
      <div className="nx-ask-head"><span className="nx-ask-kind">{props.kind}</span></div>
      <p className="nx-ask-prompt">{props.prompt}</p>
      {props.detail && <pre className="nx-ask-detail">{props.detail}</pre>}
      <div className="nx-ask-options">
        {props.options.map((option) => (
          <button
            key={option}
            type="button"
            className={`nx-btn ${props.selected === option ? 'is-primary is-demo-clicked' : ''}`}
            aria-pressed={props.selected === option}
            tabIndex={-1}
          >{props.selected === option && <Check size={13} aria-hidden="true" />}{option}</button>
        ))}
        {props.kind === 'Question' && (
          <button type="button" className={`nx-btn is-primary ${props.sent ? 'is-demo-clicked' : ''}`} tabIndex={-1}>
            {props.sent ? <><Check size={13} aria-hidden="true" /> Sent</> : 'Send answer'}
          </button>
        )}
      </div>
      {props.sent && <p className="nx-ask-sent">Answered — the team is continuing…</p>}
    </div>
  );
}

function DemoTyping({ actor, accent }: { actor: string; accent: 'green' | 'indigo' | 'violet' }) {
  return (
    <div className="nx-demo-typing">
      <span className="nx-typing-agent">
        <Chip name={actor} accent={accent} size={24} />
        <TypingDots label={`@${actor} is working`} />
        <span className="nx-typing-elapsed" aria-hidden="true">working</span>
      </span>
    </div>
  );
}

function CollaborationDemo() {
  const reduced = useMemo(prefersReducedMotion, []);
  const [sectionRef, entered] = useEnteredViewport<HTMLElement>(0.28);
  const [phase, setPhase] = useState(reduced ? FINAL_PHASE : -1);
  const streamRef = useRef<HTMLDivElement>(null);
  const [overflowing, setOverflowing] = useState(false);

  useEffect(() => {
    if (reduced || !entered || phase >= FINAL_PHASE) return;
    if (phase < 0) {
      setPhase(0);
      return;
    }
    const timer = window.setTimeout(() => setPhase((current) => Math.min(FINAL_PHASE, current + 1)), DEMO_INTERVAL_MS);
    return () => window.clearTimeout(timer);
  }, [entered, phase, reduced]);

  useEffect(() => {
    const node = streamRef.current;
    if (!node || phase < 0) return;
    const frame = window.requestAnimationFrame(() => {
      setOverflowing(node.scrollHeight > node.clientHeight + 4);
      node.scrollTo({ top: node.scrollHeight, behavior: reduced ? 'auto' : 'smooth' });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [phase, reduced]);

  const workerTools: DemoTool[] = [
    { icon: 'search', label: <>Searched relay connection and setup call sites</> },
    { icon: 'terminal', label: <>Read 8 files across the host runtime and CLI</> },
    { icon: 'edit', label: <><span className="nx-stat-add">+34</span> <span className="nx-stat-del">−12</span> <code>relay/link.ts</code> and <code>setup.ts</code></> },
  ];
  const reviewTools: DemoTool[] = [
    { icon: 'search', label: <>Traced cached-winner scope and custom relay behavior</> },
    { icon: 'terminal', label: <><code>pnpm test --filter relay-link</code></> },
  ];

  const active = phase === 1
    ? { actor: 'Fable 5', accent: 'green' as const }
    : phase >= 5 && phase <= 10
      ? { actor: 'Opus', accent: 'violet' as const }
      : phase >= 12 && phase <= 16
        ? { actor: 'GPT 5.6', accent: 'indigo' as const }
        : phase >= 18 && phase <= 19
          ? { actor: 'Opus', accent: 'violet' as const }
          : undefined;

  return (
    <section ref={sectionRef} className={`nx-landing-story nx-demo-story ${entered ? 'is-entered' : ''}`} aria-labelledby="landing-demo-title">
      <div className="nx-story-copy">
        <p className="nx-landing-kicker">One continuous conversation</p>
        <h2 id="landing-demo-title">The whole team sees the work.</h2>
        <p>
          Your agents work through the problem together: asking the right questions, testing ideas, building the
          solution, and improving one another’s work without losing the thread.
        </p>
      </div>

      <div className="nx-demo-channel-head" data-testid="landing-demo-channel">
        <span className="nx-landing-mark" aria-hidden="true" />
        <span><small>Channel</small><strong># relay-onboarding</strong></span>
        <i aria-hidden="true" />
        <small>4 members</small>
      </div>

      <div
        ref={streamRef}
        className={`nx-demo-stream ${overflowing ? 'is-overflowing' : ''}`}
        data-testid="landing-demo"
        aria-live="polite"
        aria-atomic="false"
      >
        <ol className="nx-demo-thread">
          {phase >= 0 && (
            <DemoTurn actor="Richard" accent="user" time="9:41 PM">
              <div className="nx-prose"><p>Make the first Codor setup work on filtered networks too. Keep one pairing code for local and relay access, and have someone independently review the fallback before we ship.</p></div>
            </DemoTurn>
          )}
          {phase >= 2 && (
            <DemoTurn actor="Fable 5" accent="green" time="9:42 PM">
              <div className="nx-prose"><p>I’ll coordinate this. One choice before Opus starts: should the first pass optimize for the smallest patch, or include the recovery tests and rollout notes now?</p></div>
              {phase <= 3 && (
                <DemoInteraction
                  kind="Question"
                  prompt="What should the team include in this pass?"
                  options={['Smallest patch', 'Ship + independent review']}
                  selected={phase >= 3 ? 'Ship + independent review' : undefined}
                  sent={phase >= 3}
                />
              )}
            </DemoTurn>
          )}
          {phase >= 4 && (
            <DemoTurn actor="Fable 5" accent="green" time="9:43 PM">
              <div className="nx-prose"><p>Got it. Opus owns the implementation; GPT 5.6 will attack the network failover and the one-code invariant after the tests are green.</p></div>
            </DemoTurn>
          )}
          {phase >= 6 && (
            <DemoTurn actor="Opus" accent="violet" time="9:45 PM">
              <div className="nx-prose"><p>I’m tracing both entry paths before editing. The daemon already knows how to mint a universal offer, but setup bypasses it, while the relay link remembers a winning hostname without applying the same fallback on a cold start. I’ll join those paths instead of adding another pairing flow.</p></div>
              <DemoToolProgress tools={workerTools} step={phase >= 10 ? 3 : phase - 7} summary="Ran 3 tools · wrote 2 files +34 −12" />
            </DemoTurn>
          )}
          {phase >= 11 && (
            <DemoTurn actor="Opus" accent="violet" time="9:50 PM">
              <div className="nx-prose"><p>The implementation is in. Setup now asks the running daemon for its offer, so there is still exactly one grant behind both doors. Relay dialing tries the configured hostname, switches once on a pre-open failure, and caches only a winner scoped to that exact relay URL. Custom relays never inherit the hosted alias.</p></div>
            </DemoTurn>
          )}
          {phase >= 13 && (
            <DemoTurn actor="GPT 5.6" accent="indigo" time="9:52 PM">
              <div className="nx-prose"><p>I’m reviewing the failure boundaries, not just the happy path. The shared grant remains single-use, and mid-session drops correctly stay on the known winner. One gap: the cached-alias outage needs the reverse recovery leg, otherwise a network change can strand an existing host until restart.</p></div>
              <DemoToolProgress tools={reviewTools} step={phase >= 16 ? 2 : phase - 14} summary="Ran 2 tools · reviewed 1 fallback +18 −0" />
              {phase >= 16 && phase <= 17 && (
                <DemoInteraction
                  kind="Approval needed"
                  prompt="Apply the reverse-failover regression and rerun the relay gate?"
                  detail="pnpm test --filter relay-link"
                  options={['Allow', 'Ask for changes']}
                  selected={phase >= 17 ? 'Allow' : undefined}
                  sent={phase >= 17}
                />
              )}
            </DemoTurn>
          )}
          {phase >= 19 && (
            <DemoTurn actor="Opus" accent="violet" time="9:55 PM">
              <div className="nx-prose"><p>Added the reverse leg and reran the focused gate. Canonical blocked → alias opens; cached alias blocked → canonical recovers; a custom URL never leaves its own origin. The setup and relay-link suites are green.</p></div>
              <div className="nx-batch"><span className="nx-batch-line"><ChevronRight size={14} aria-hidden="true" />Ran 4 tools · wrote 1 file +22 −3</span></div>
            </DemoTurn>
          )}
          {phase >= 20 && (
            <DemoTurn actor="GPT 5.6" accent="indigo" time="9:57 PM">
              <div className="nx-prose"><p>Independent review is clean. The behavior is symmetric, the cached winner cannot leak across relay configurations, and the universal code still burns once at either door. This is ready to ship.</p></div>
            </DemoTurn>
          )}
        </ol>
        {active && <DemoTyping actor={active.actor} accent={active.accent} />}
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
    <section ref={sectionRef} className={`nx-landing-story is-split nx-workflow-story ${entered ? 'is-entered' : ''}`} aria-labelledby="workflow-title">
      <div className="nx-story-copy">
        <p className="nx-landing-kicker">Compose the team</p>
        <h2 id="workflow-title">Multi-agent workflows, with ease.</h2>
        <p>Choose who leads, who builds, and who challenges the result. Codor keeps the whole group in one conversation even when the shape of the team changes.</p>
      </div>
      <div className="nx-workflow-visual" aria-live="polite">
        <header>
          <span><Sparkles size={15} aria-hidden="true" /> Workflow {active + 1} of {WORKFLOWS.length}</span>
          <strong>{workflow.label}</strong>
        </header>
        <div className={`nx-workflow-map is-${workflow.layout}`} key={workflow.label}>
          <svg className="nx-workflow-links" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
            {workflow.routes.map((route, index) => {
              const routeId = `workflow-${workflow.layout}-${String(index)}`;
              const duration = 2.4 + index * 0.28;
              const delay = index * 0.44;
              return (
                <g key={routeId}>
                  <path id={routeId} d={route} />
                  <circle className="nx-workflow-packet" r="1.35" opacity="0">
                    <animate attributeName="opacity" values="0;1;1;0" keyTimes="0;0.12;0.88;1" dur={`${String(duration)}s`} begin={`${String(delay)}s`} repeatCount="indefinite" />
                    <animateMotion dur={`${String(duration)}s`} begin={`${String(delay)}s`} repeatCount="indefinite">
                      <mpath href={`#${routeId}`} />
                    </animateMotion>
                  </circle>
                </g>
              );
            })}
          </svg>
          {workflow.roles.map((member, index) => {
            const RoleIcon = member.icon;
            return (
              <article className={`nx-workflow-role is-${member.slot} is-${member.weight} is-${member.accent}`} key={`${workflow.label}-${member.name}`}>
                <span className="nx-workflow-harness" title={`${harnessLabel(member.harness)} harness`}>
                  {harnessMark(member.harness, 28)}
                  <i aria-hidden="true" />
                </span>
                <span><small><RoleIcon size={12} aria-hidden="true" /> {member.role}</small><strong>{member.name}</strong></span>
                <i className="nx-workflow-order" aria-hidden="true">{index + 1}</i>
              </article>
            );
          })}
        </div>
        <footer><Check size={15} aria-hidden="true" /> {workflow.outcome}</footer>
        <div className="nx-workflow-dots" aria-hidden="true">
          {WORKFLOWS.map((item, index) => <i className={index === active ? 'is-active' : ''} key={item.label} />)}
        </div>
      </div>
    </section>
  );
}

function ConnectivityMap() {
  return (
    <div className="nx-connectivity-map" aria-label="Devices connect privately to any Codor computer">
      <svg viewBox="0 0 600 360" preserveAspectRatio="none" aria-hidden="true">
        <path d="M191 117 C204 117 201 180 213 180" />
        <path d="M191 180 H213" />
        <path d="M191 243 C204 243 201 180 213 180" />
        <path d="M362 180 C374 180 371 117 384 117" />
        <path d="M362 180 H384" />
        <path d="M362 180 C374 180 371 243 384 243" />
      </svg>
      <div className="nx-connectivity-sources">
        <span><Monitor aria-hidden="true" /><strong>Desktop</strong></span>
        <span><Smartphone aria-hidden="true" /><strong>Mobile</strong></span>
        <span><Terminal aria-hidden="true" /><strong>CLI</strong></span>
      </div>
      <div className="nx-connectivity-core">
        <LockKeyhole aria-hidden="true" />
        <strong>E2E encrypted relay</strong>
        <small>or direct connection</small>
        <i aria-hidden="true" />
      </div>
      <div className="nx-connectivity-hosts">
        <span><Laptop aria-hidden="true" /><strong>Studio Mac</strong><small>relay-ui</small></span>
        <span><Server aria-hidden="true" /><strong>Workstation</strong><small>compiler</small></span>
        <span><Server aria-hidden="true" /><strong>GPU box</strong><small>evals</small></span>
      </div>
    </div>
  );
}

const VOICE_LEVELS = [
  [0.26, 0.42, 0.63, 0.35, 0.78, 0.48, 0.31, 0.69, 0.88, 0.52, 0.34, 0.61, 0.44, 0.72, 0.28],
  [0.38, 0.67, 0.43, 0.81, 0.52, 0.33, 0.74, 0.46, 0.59, 0.84, 0.39, 0.28, 0.66, 0.48, 0.36],
  [0.31, 0.48, 0.72, 0.54, 0.36, 0.82, 0.58, 0.29, 0.77, 0.43, 0.68, 0.51, 0.32, 0.62, 0.41],
  [0.44, 0.29, 0.58, 0.76, 0.47, 0.66, 0.38, 0.86, 0.49, 0.31, 0.73, 0.42, 0.57, 0.35, 0.52],
] as const;

function VoiceVisual() {
  const reduced = useMemo(prefersReducedMotion, []);
  const [visualRef, entered] = useEnteredViewport<HTMLDivElement>(0.45);
  const [frame, setFrame] = useState(0);

  useEffect(() => {
    if (reduced || !entered) return;
    const timer = window.setInterval(() => setFrame((current) => (current + 1) % VOICE_LEVELS.length), 170);
    return () => window.clearInterval(timer);
  }, [entered, reduced]);

  const levels = VOICE_LEVELS[frame] ?? VOICE_LEVELS[0];
  return (
    <div ref={visualRef} className="nx-feature-visual nx-voice-visual" aria-label="Voice control preview">
      <div className="nx-voice-recording"><span><Mic size={17} aria-hidden="true" /> Recording 0:08</span><i /></div>
      <div className="nx-voice-wave" aria-hidden="true">
        {levels.map((level, index) => (
          <i key={String(index)} style={{ '--voice-level': String(level) } as CSSProperties} />
        ))}
      </div>
      <div className="nx-voice-transcript"><AudioLines size={16} aria-hidden="true" /><span>“Ask Opus to tighten the mobile layout, then have GPT review it.”</span></div>
    </div>
  );
}

function ContextRing({ value }: { value: number }) {
  return (
    <span className="nx-landing-context" title={`${String(value)}% context window used`}>
      <svg viewBox="0 0 20 20" aria-hidden="true">
        <circle cx="10" cy="10" r="8" pathLength="100" />
        <circle className="is-progress" cx="10" cy="10" r="8" pathLength="100" strokeDasharray="100" strokeDashoffset={100 - value} />
      </svg>
      <small>{value}% context</small>
    </span>
  );
}

function LimitsVisual() {
  const members = [
    { name: 'Richard', detail: 'Owner', accent: 'user' as const, human: true, state: 'Owner', context: 0, fiveHour: 0, weekly: 0 },
    { name: 'Fable 5', detail: 'claude-code · opus', accent: 'green' as const, human: false, state: 'Idle', context: 32, fiveHour: 72, weekly: 18 },
    { name: 'GPT 5.6', detail: 'codex · gpt-5.6', accent: 'indigo' as const, human: false, state: 'Working', context: 68, fiveHour: 43, weekly: 61 },
  ];
  return (
    <div className="nx-feature-visual nx-limits-visual" aria-label="People and agents with live usage limits">
      <header>
        <strong>People &amp; agents</strong>
        <span><RefreshCw size={13} aria-hidden="true" /> Updated now</span>
        <button type="button" tabIndex={-1} aria-label="Add agent"><Plus size={14} aria-hidden="true" /></button>
      </header>
      <div className="nx-landing-roster">
        {members.map((member) => (
          <article className="nx-landing-member" key={member.name}>
            <div className="nx-landing-member-row">
              <Chip name={member.name} accent={member.accent} size={31} presence={member.human ? undefined : member.state === 'Working' ? 'live' : 'idle'} />
              <span className="nx-landing-member-id"><strong>@{member.name.toLowerCase().replace(/\s+/g, '')}</strong><small>{member.detail}</small></span>
              {member.human
                ? <span className="nx-landing-owner">Owner</span>
                : <StatusPill tone={member.state === 'Working' ? 'live' : 'neutral'}>{member.state}</StatusPill>}
              {!member.human && <ContextRing value={member.context} />}
            </div>
            {!member.human && (
              <div className="nx-landing-member-limits">
                <span><b>5h</b><i><em style={{ '--limit-width': `${String(member.fiveHour)}%` } as CSSProperties} /></i><small>{member.fiveHour}% left</small></span>
                <span><b>weekly</b><i><em style={{ '--limit-width': `${String(member.weekly)}%` } as CSSProperties} /></i><small>{member.weekly}% left</small></span>
              </div>
            )}
          </article>
        ))}
      </div>
    </div>
  );
}

function ReviewVisual() {
  const reduced = useMemo(prefersReducedMotion, []);
  const [visualRef, entered] = useEnteredViewport<HTMLDivElement>(0.45);
  const [active, setActive] = useState<'preview' | 'diff'>('preview');

  useEffect(() => {
    if (reduced || !entered) return;
    const timer = window.setInterval(() => setActive((current) => current === 'preview' ? 'diff' : 'preview'), 4_200);
    return () => window.clearInterval(timer);
  }, [entered, reduced]);

  return (
    <div ref={visualRef} className="nx-feature-visual nx-review-visual" aria-label="Preview gallery and diff viewer">
      <div className="nx-review-tabs" role="tablist" aria-label="Review views">
        <button type="button" role="tab" aria-selected={active === 'preview'} className={active === 'preview' ? 'is-active' : ''} onClick={() => setActive('preview')}><Eye size={13} aria-hidden="true" /> Preview</button>
        <button type="button" role="tab" aria-selected={active === 'diff'} className={active === 'diff' ? 'is-active' : ''} onClick={() => setActive('diff')}><GitCompareArrows size={13} aria-hidden="true" /> Diff</button>
      </div>
      {active === 'preview' ? (
        <div className="nx-review-gallery" role="tabpanel">
          <article className="nx-review-image-card"><div><span /><i /><b /></div><strong>mobile-reference.png</strong><small>Image · #527 · 164 KB</small></article>
          <article className="nx-review-doc-card"><FileText size={22} aria-hidden="true" /><strong>handoff.md</strong><small>Document · #531 · 8 KB</small><span>Download</span></article>
        </div>
      ) : (
        <div className="nx-review-diff" role="tabpanel">
          <aside className="nx-review-history">
            <header><GitBranch size={13} aria-hidden="true" /><strong>Git history</strong><small>12 commits</small></header>
            <span className="is-active"><b>Landing micro-motion</b><code>15b7a00</code><small>Richard · now</small></span>
            <span><b>Refine onboarding</b><code>e491fc3</code><small>Richard · 2h</small></span>
            <span><b>Relay entry</b><code>e450a3a</code><small>Richard · 3h</small></span>
          </aside>
          <div className="nx-review-patch">
            <header><code>LandingPage.tsx</code><span className="nx-stat-add">+84</span><span className="nx-stat-del">−31</span></header>
            <code className="is-meta">@@ -286,8 +286,14 @@</code>
            <code className="is-del">- The whole team sees the work.</code>
            <code className="is-add">+ The team works through it together.</code>
            <code className="is-add">+ Ran 3 tools · wrote 2 files</code>
            <code>  Independent review is clean.</code>
          </div>
        </div>
      )}
    </div>
  );
}

function AttachmentVisual() {
  return (
    <div className="nx-feature-visual nx-attachment-visual" aria-label="Automatic attachment sending">
      <div className="nx-attachment-drop"><Upload size={19} aria-hidden="true" /><span><strong>Drop files into the conversation</strong><small>Codor uploads and attaches them to your next message.</small></span></div>
      <div className="nx-attachment-files">
        <span><FileImage size={16} aria-hidden="true" /><b>mobile-reference.png</b><small>164 KB</small></span>
        <span><FileText size={16} aria-hidden="true" /><b>review-notes.md</b><small>8 KB</small></span>
      </div>
      <div className="nx-attachment-send"><span>Give these to Fable and ask for one pass.</span><i><Send size={14} aria-hidden="true" /></i></div>
    </div>
  );
}

function FeatureSection(props: {
  id: string;
  kicker: string;
  title: string;
  body: string;
  icon: LucideIcon;
  visual: ReactNode;
  reverse?: boolean;
}) {
  const Icon = props.icon;
  const [sectionRef, entered] = useEnteredViewport<HTMLElement>(0.25);
  return (
    <section ref={sectionRef} className={`nx-landing-story is-split nx-compact-feature ${entered ? 'is-entered' : ''} ${props.reverse ? 'is-reverse' : ''}`} aria-labelledby={props.id}>
      <div className="nx-story-copy">
        <p className="nx-landing-kicker"><Icon size={13} aria-hidden="true" /> {props.kicker}</p>
        <h2 id={props.id}>{props.title}</h2>
        <p>{props.body}</p>
      </div>
      {props.visual}
    </section>
  );
}

function ConnectivityStory() {
  const [sectionRef, entered] = useEnteredViewport<HTMLElement>(0.24);
  return (
    <section ref={sectionRef} className={`nx-landing-story is-split nx-connectivity-story ${entered ? 'is-entered' : ''}`} aria-labelledby="computers-title">
      <div className="nx-story-copy">
        <p className="nx-landing-kicker"><Network size={13} aria-hidden="true" /> Runs where you work</p>
        <h2 id="computers-title">Every computer. Every device. Still private.</h2>
        <p>
          Start agents on your laptop, workstation, or remote box. Use the same room from desktop, mobile, or
          terminal over a direct connection or the end-to-end encrypted relay. The relay connects the devices;
          it never receives your channel keys.
        </p>
        <div className="nx-connectivity-facts">
          <span><ShieldCheck size={14} aria-hidden="true" /> Relay sees ciphertext only</span>
          <span><Users size={14} aria-hidden="true" /> No Codor account required</span>
        </div>
      </div>
      <ConnectivityMap />
    </section>
  );
}

function ProductStories() {
  return (
    <div className="nx-product-stories">
      <WorkflowStory />
      <ConnectivityStory />

      <FeatureSection id="voice-title" kicker="Talk it through" title="Voice control that stays in the room." body="Record one thought or several takes, choose the agent, and send the transcript into the same conversation. Codor keeps the voice note beside the words it produced." icon={Mic} visual={<VoiceVisual />} />
      <FeatureSection id="limits-title" kicker="Always current" title="Limits update themselves." body="Account usage and context pressure refresh while the agents work, so you know who has room for the next task without checking every provider by hand." icon={Gauge} visual={<LimitsVisual />} reverse />
      <FeatureSection id="review-title" kicker="See the result" title="Preview the app. Inspect the diff." body="Keep the working UI and the files that changed together. Move from the browser preview to the exact additions and deletions without leaving the channel." icon={GitCompareArrows} visual={<ReviewVisual />} />
      <FeatureSection id="attachments-title" kicker="Context included" title="Attachments go with the ask." body="Drop screenshots, design references, logs, or notes into the composer. Codor uploads them once and attaches them to the message automatically." icon={Upload} visual={<AttachmentVisual />} reverse />
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
