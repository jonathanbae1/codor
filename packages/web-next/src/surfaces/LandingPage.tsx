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
  Globe2,
  Laptop,
  LoaderCircle,
  LockKeyhole,
  Mic,
  Monitor,
  Network,
  Palette,
  Pencil,
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
import { Chip, TypingDots } from '../primitives/primitives.js';
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
    label: 'Ship a production feature',
    outcome: 'Implementation and independent review land in one channel.',
    layout: 'chain',
    roles: [
      { name: 'Fable 5', role: 'Orchestrator', accent: 'green' as const, icon: Crown, slot: 'left' },
      { name: 'Opus', role: 'Coder', accent: 'violet' as const, icon: Code2, slot: 'center' },
      { name: 'GPT 5.6 Sol', role: 'Reviewer', accent: 'indigo' as const, icon: ShieldCheck, slot: 'right' },
    ],
  },
  {
    label: 'Design a new product surface',
    outcome: 'The design intent survives all the way into the implementation.',
    layout: 'fanout',
    roles: [
      { name: 'GPT 5.6 Sol', role: 'Orchestrator', accent: 'indigo' as const, icon: Compass, slot: 'top' },
      { name: 'Opus', role: 'Designer', accent: 'violet' as const, icon: Palette, slot: 'bottom-left' },
      { name: 'GPT 5.6 Luna', role: 'Prototype', accent: 'green' as const, icon: Code2, slot: 'bottom-right' },
    ],
  },
  {
    label: 'Harden a risky migration',
    outcome: 'Build, threat-model, and verification happen as one continuous run.',
    layout: 'loop',
    roles: [
      { name: 'Opus', role: 'Implementer', accent: 'violet' as const, icon: Code2, slot: 'left' },
      { name: 'GPT 5.6 Sol', role: 'Security review', accent: 'indigo' as const, icon: ShieldCheck, slot: 'right' },
      { name: 'Fable 5', role: 'Gate', accent: 'green' as const, icon: TestTube2, slot: 'bottom' },
    ],
  },
  {
    label: 'Turn research into working code',
    outcome: 'Evidence, architecture, and the shipped result stay connected.',
    layout: 'hub',
    roles: [
      { name: 'Fable 5', role: 'Orchestrator', accent: 'green' as const, icon: Crown, slot: 'center' },
      { name: 'GPT 5.6 Luna', role: 'Researcher', accent: 'indigo' as const, icon: Search, slot: 'top-left' },
      { name: 'Opus', role: 'Builder', accent: 'violet' as const, icon: Code2, slot: 'top-right' },
      { name: 'GPT 5.6 Sol', role: 'Evaluator', accent: 'indigo' as const, icon: Eye, slot: 'bottom' },
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
    <section ref={sectionRef} className="nx-landing-story nx-demo-story" aria-labelledby="landing-demo-title">
      <div className="nx-story-copy">
        <p className="nx-landing-kicker">One continuous conversation</p>
        <h2 id="landing-demo-title">The whole team sees the work.</h2>
        <p>
          Your agents work through the problem together: asking the right questions, testing ideas, building the
          solution, and improving one another’s work without losing the thread.
        </p>
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
    <section ref={sectionRef} className="nx-landing-story is-split nx-workflow-story" aria-labelledby="workflow-title">
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
            {workflow.layout === 'chain' && <path d="M18 50 H82" />}
            {workflow.layout === 'fanout' && <><path d="M50 22 V43 L23 76" /><path d="M50 43 L77 76" /></>}
            {workflow.layout === 'loop' && <><path d="M20 38 C31 7 69 7 80 38" /><path d="M80 38 C70 78 30 78 20 38" /><path d="M50 68 V82" /></>}
            {workflow.layout === 'hub' && <><path d="M50 50 L21 22" /><path d="M50 50 L79 22" /><path d="M50 50 V82" /></>}
          </svg>
          {workflow.roles.map((member, index) => {
            const RoleIcon = member.icon;
            return (
              <article className={`nx-workflow-role is-${member.slot}`} key={`${workflow.label}-${member.name}`}>
                <Chip name={member.name} accent={member.accent} size={36} presence="live" surface="raised" />
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
        <path d="M142 60 C230 60 225 180 300 180" />
        <path d="M142 180 H300" />
        <path d="M142 300 C230 300 225 180 300 180" />
        <path d="M300 180 C375 180 370 85 458 85" />
        <path d="M300 180 H458" />
        <path d="M300 180 C375 180 370 275 458 275" />
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

function VoiceVisual() {
  return (
    <div className="nx-feature-visual nx-voice-visual" aria-label="Voice control preview">
      <div className="nx-voice-recording"><span><Mic size={17} aria-hidden="true" /> Recording 0:08</span><i /></div>
      <div className="nx-voice-wave" aria-hidden="true">
        {[18, 35, 62, 42, 76, 31, 54, 84, 47, 70, 29, 58, 38, 66, 24].map((height, index) => (
          <i key={String(index)} style={{ '--wave-height': `${String(height)}%`, '--wave-delay': `${String(index * 70)}ms` } as CSSProperties} />
        ))}
      </div>
      <div className="nx-voice-transcript"><AudioLines size={16} aria-hidden="true" /><span>“Ask Opus to tighten the mobile layout, then have GPT review it.”</span></div>
    </div>
  );
}

function LimitsVisual() {
  const rows = [
    { name: 'Fable 5', accent: 'green' as const, value: '68%', width: '68%' },
    { name: 'GPT 5.6', accent: 'indigo' as const, value: '41%', width: '41%' },
    { name: 'Opus', accent: 'violet' as const, value: '14%', width: '14%' },
  ];
  return (
    <div className="nx-feature-visual nx-limits-visual" aria-label="Automatically refreshed usage limits">
      <header><Gauge size={16} aria-hidden="true" /><strong>Live usage</strong><span><RefreshCw size={13} aria-hidden="true" /> Updated now</span></header>
      {rows.map((row) => (
        <div className="nx-limit-row" key={row.name}>
          <Chip name={row.name} accent={row.accent} size={30} />
          <span><strong>{row.name}</strong><i><b style={{ '--limit-width': row.width } as CSSProperties} /></i></span>
          <small>{row.value}</small>
        </div>
      ))}
    </div>
  );
}

function ReviewVisual() {
  return (
    <div className="nx-feature-visual nx-review-visual" aria-label="Preview and diff viewer">
      <header><span className="is-active"><Eye size={13} aria-hidden="true" /> Preview</span><span><GitCompareArrows size={13} aria-hidden="true" /> Diff</span></header>
      <div className="nx-review-canvas"><span className="nx-preview-nav" /><strong>codor.app</strong><p>Landing motion pass</p><i /></div>
      <footer>
        <span><FileText size={14} aria-hidden="true" /><code>LandingPage.tsx</code></span>
        <span className="nx-stat-add">+84</span><span className="nx-stat-del">−31</span>
      </footer>
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
  return (
    <section className={`nx-landing-story is-split nx-compact-feature ${props.reverse ? 'is-reverse' : ''}`} aria-labelledby={props.id}>
      <div className="nx-story-copy">
        <p className="nx-landing-kicker"><Icon size={13} aria-hidden="true" /> {props.kicker}</p>
        <h2 id={props.id}>{props.title}</h2>
        <p>{props.body}</p>
      </div>
      {props.visual}
    </section>
  );
}

function ProductStories() {
  return (
    <div className="nx-product-stories">
      <WorkflowStory />

      <section className="nx-landing-story is-split nx-connectivity-story" aria-labelledby="computers-title">
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
