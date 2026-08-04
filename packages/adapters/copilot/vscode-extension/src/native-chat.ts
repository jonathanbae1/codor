import { randomUUID } from 'node:crypto';

export const MAX_HISTORY_CHARS = 256 * 1024;
export const MAX_EXPORT_CHARS = 4 * 1024 * 1024;
export const DEFAULT_POLL_MS = 200;
export const DEFAULT_TURN_MS = 30 * 60_000;
export const MAX_APPROVAL_ATTEMPTS = 3;

export interface NativeTurnRequest {
  prompt: string;
  model?: string;
  history?: Array<{ role: 'user' | 'assistant'; text: string }>;
}

export type NativeStreamEvent =
  | { type: 'started'; turn_id: string }
  | { type: 'part'; index: number; revision: number; part: unknown; text_delta?: string }
  | { type: 'done'; result: unknown; response: unknown[] }
  | { type: 'error'; message: string };

export interface NativeChatHost {
  executeCommand<T = unknown>(command: string, ...args: unknown[]): Promise<T>;
  exportSnapshot(turnId: string): Promise<unknown>;
  delay(ms: number, signal: AbortSignal): Promise<void>;
}

interface ExportedRequest {
  response: unknown[];
  result?: unknown;
}

interface WaitingPart {
  index: number;
  stateKey: string;
}

interface ApprovalLifecycle {
  stateKey: string;
  waiting: boolean;
  attempts: number;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function latestRequest(snapshot: unknown): ExportedRequest | undefined {
  const root = record(snapshot);
  const requests = Array.isArray(root?.requests) ? root.requests : [];
  const candidate = record(requests.at(-1));
  if (candidate === undefined) return undefined;
  const responseValue = record(candidate.response)?.entireResponse;
  const response = Array.isArray(record(responseValue)?.value)
    ? record(responseValue)!.value as unknown[]
    : Array.isArray(candidate.response)
      ? candidate.response
      : [];
  return {
    response,
    ...('result' in candidate && candidate.result !== undefined && { result: candidate.result }),
  };
}

function textOf(part: unknown): string | undefined {
  if (typeof part === 'string') return part;
  const source = record(part);
  if (source === undefined) return undefined;
  if (typeof source.value === 'string') return source.value;
  if (typeof source.text === 'string') return source.text;
  const markdown = record(source.markdown);
  return typeof markdown?.value === 'string' ? markdown.value : undefined;
}

function boundedHistory(history: NativeTurnRequest['history']): Array<{ request: string; response: string }> {
  if (history === undefined) return [];
  const pairs: Array<{ request: string; response: string }> = [];
  let used = 0;
  for (let index = history.length - 1; index >= 0 && pairs.length < 20; index -= 1) {
    const assistant = history[index];
    const user = history[index - 1];
    if (assistant?.role !== 'assistant' || user?.role !== 'user') continue;
    const size = assistant.text.length + user.text.length;
    if (used + size > MAX_HISTORY_CHARS) break;
    pairs.unshift({ request: user.text, response: assistant.text });
    used += size;
    index -= 1;
  }
  return pairs;
}

function stateKey(source: Record<string, unknown>): string {
  const state = source.state ?? source.status;
  if (typeof state === 'string') return state;
  if (state !== undefined) return JSON.stringify(state);
  return JSON.stringify({ kind: source.kind, toolId: source.toolId });
}

function waitingPart(value: unknown, index: number): WaitingPart | undefined {
  const source = record(value);
  if (source?.kind !== 'toolInvocation') return undefined;
  const stateText = JSON.stringify(source.state ?? source.status ?? source).toLowerCase();
  if (!stateText.includes('waitingforconfirmation') && !stateText.includes('waitingforpostapproval')) {
    return undefined;
  }
  return { index, stateKey: stateKey(source) };
}

function cleanError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.slice(0, 1000) || 'VS Code Copilot turn failed';
}

function noOpApprovalError(index: number): Error {
  return new Error(
    `VS Code Copilot Allow did not advance native tool part ${String(index)} after `
    + `${String(MAX_APPROVAL_ATTEMPTS)} attempts; reload the companion extension or inspect the VS Code chat`,
  );
}

// harn:assume vscode-copilot-native-agent-auto-approves-and-streams-evidence ref=vscode-copilot-native-chat-runtime
export class NativeChatRunner {
  constructor(
    private readonly host: NativeChatHost,
    private readonly pollMs = DEFAULT_POLL_MS,
    private readonly turnMs = DEFAULT_TURN_MS,
  ) {}

  async run(
    request: NativeTurnRequest,
    emit: (event: NativeStreamEvent) => void,
    outerSignal: AbortSignal,
  ): Promise<void> {
    const turnId = randomUUID();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(new Error('Copilot turn timed out')), this.turnMs);
    const abort = () => controller.abort(outerSignal.reason);
    outerSignal.addEventListener('abort', abort, { once: true });
    const revisions: string[] = [];
    const approvals = new Map<number, ApprovalLifecycle>();
    let openSettled = false;
    let openError: unknown;

    try {
      if (controller.signal.aborted) throw controller.signal.reason;
      await this.host.executeCommand('workbench.action.chat.newChat');
      emit({ type: 'started', turn_id: turnId });
      // /autoApprove is scoped to this newly-created chat. It is deliberately
      // part of the request rather than a user setting or a global command.
      void this.host.executeCommand('workbench.action.chat.open', {
        query: `/autoApprove\n${request.prompt}`,
        mode: 'agent',
        ...(request.model !== undefined && {
          modelSelector: { vendor: 'copilot', id: request.model },
        }),
        previousRequests: boundedHistory(request.history),
        blockOnResponse: true,
      }).then(
        () => { openSettled = true; },
        (error: unknown) => {
          openSettled = true;
          openError = error;
        },
      );

      for (;;) {
        if (controller.signal.aborted) throw controller.signal.reason;
        const snapshot = await this.host.exportSnapshot(turnId);
        const encoded = JSON.stringify(snapshot);
        if (encoded.length > MAX_EXPORT_CHARS) throw new Error('Copilot export exceeded its bound');
        if (openSettled && openError !== undefined) throw openError;
        const latest = latestRequest(snapshot);
        if (latest !== undefined) {
          for (let index = 0; index < latest.response.length; index += 1) {
            const part = latest.response[index];
            const next = JSON.stringify(part);
            const previous = revisions[index];
            if (next === previous) continue;
            revisions[index] = next;
            const previousText = previous === undefined ? undefined : textOf(JSON.parse(previous));
            const nextText = textOf(part);
            const textDelta = previousText !== undefined
              && nextText?.startsWith(previousText)
              ? nextText.slice(previousText.length)
              : previous === undefined
                ? nextText
                : undefined;
            emit({
              type: 'part',
              index,
              part,
              revision: previous === undefined ? 0 : 1,
              ...(textDelta !== undefined && textDelta !== '' && { text_delta: textDelta }),
            });
          }
          if (latest.result !== undefined) {
            emit({ type: 'done', result: latest.result, response: latest.response });
            return;
          }

          // Process one pending native part per poll. The export after Allow is
          // the proof that the actual part/state lifecycle advanced; using the
          // tool name or prompt here would collapse repeated identical tools.
          let pending: WaitingPart | undefined;
          for (let index = 0; index < latest.response.length; index += 1) {
            const current = waitingPart(latest.response[index], index);
            const previous = approvals.get(index);
            if (current === undefined) {
              if (previous?.waiting === true) {
                approvals.set(index, {
                  stateKey: previous.stateKey,
                  waiting: false,
                  attempts: previous.attempts,
                });
              }
              continue;
            }
            if (
              previous === undefined
              || previous.waiting === false
              || previous.stateKey !== current.stateKey
            ) {
              approvals.set(index, { stateKey: current.stateKey, waiting: true, attempts: 0 });
            }
            const lifecycle = approvals.get(index)!;
            if (lifecycle.attempts >= MAX_APPROVAL_ATTEMPTS) throw noOpApprovalError(index);
            pending = current;
            lifecycle.attempts += 1;
            break;
          }
          if (pending !== undefined) {
            try {
              await this.host.executeCommand('workbench.action.chat.acceptTool');
            } catch (error) {
              throw new Error(
                `VS Code Copilot Allow failed for native tool part ${String(pending.index)}; `
                + `reload the companion extension or inspect the VS Code chat: ${cleanError(error)}`,
              );
            }
          }
        }
        await this.host.delay(this.pollMs, controller.signal);
      }
    } catch (error) {
      if (controller.signal.aborted) {
        await this.host.executeCommand('workbench.action.chat.cancel').catch(() => undefined);
      }
      emit({ type: 'error', message: cleanError(error) });
    } finally {
      clearTimeout(timeout);
      outerSignal.removeEventListener('abort', abort);
    }
  }
}
// harn:end vscode-copilot-native-agent-auto-approves-and-streams-evidence

export function collectResponseText(parts: unknown[]): string {
  return parts.map((part) => textOf(part) ?? '').join('');
}
