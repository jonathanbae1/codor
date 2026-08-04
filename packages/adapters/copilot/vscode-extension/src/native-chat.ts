import { randomUUID } from 'node:crypto';

export const MAX_HISTORY_CHARS = 256 * 1024;
export const MAX_EXPORT_CHARS = 4 * 1024 * 1024;
export const DEFAULT_POLL_MS = 200;
export const DEFAULT_TURN_MS = 30 * 60_000;
export const MAX_APPROVAL_ATTEMPTS = 3;
export const MAX_REQUEST_BIND_MS = 30_000;

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
  requestId?: string;
  prompt?: string;
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

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined;
}

function nestedString(source: Record<string, unknown> | undefined, keys: string[]): string | undefined {
  if (source === undefined) return undefined;
  for (const key of keys) {
    const value = source[key];
    const direct = stringValue(value);
    if (direct !== undefined) return direct;
    const nested = nestedString(record(value), ['prompt', 'query', 'message', 'text', 'value']);
    if (nested !== undefined) return nested;
  }
  return undefined;
}

function exportedRequestId(candidate: Record<string, unknown>): string | undefined {
  const direct = stringValue(candidate.requestId) ?? stringValue(candidate.request_id);
  if (direct !== undefined) return direct;
  return nestedString(record(candidate.request), ['requestId', 'request_id', 'id']);
}

function exportedPrompt(candidate: Record<string, unknown>): string | undefined {
  return nestedString(candidate, ['request', 'prompt', 'query', 'message']);
}

function responseOf(candidate: Record<string, unknown>): unknown[] {
  const responseValue = record(candidate.response)?.entireResponse;
  if (Array.isArray(record(responseValue)?.value)) return record(responseValue)!.value as unknown[];
  return Array.isArray(candidate.response) ? candidate.response : [];
}

function exportedRequests(snapshot: unknown): ExportedRequest[] {
  const root = record(snapshot);
  const requests = Array.isArray(root?.requests) ? root.requests : [];
  return requests.flatMap((value) => {
    const candidate = record(value);
    if (candidate === undefined) return [];
    const requestId = exportedRequestId(candidate);
    const prompt = exportedPrompt(candidate);
    return [{
      ...(requestId !== undefined && { requestId }),
      ...(prompt !== undefined && { prompt }),
      response: responseOf(candidate),
      ...('result' in candidate && candidate.result !== undefined && { result: candidate.result }),
    }];
  });
}

function latestMatchingRequest(requests: ExportedRequest[], prompt: string): ExportedRequest | undefined {
  for (let index = requests.length - 1; index >= 0; index -= 1) {
    const candidate = requests[index];
    if (candidate.prompt === prompt && candidate.requestId !== undefined) return candidate;
  }
  return undefined;
}

function requestBindingError(): Error {
  return new Error(
    'VS Code Copilot active chat no longer matches the bridge-created request; '
    + 'focus the Codor-created chat or reload the companion extension',
  );
}

function missingRequestIdError(): Error {
  return new Error(
    'VS Code Copilot did not expose a stable request id for the bridge-created prompt; '
    + 'focus the Codor-created chat or reload the companion extension',
  );
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
    private readonly now: () => number = () => Date.now(),
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
    let boundRequestId: string | undefined;
    let openSettled = false;
    let openError: unknown;

    try {
      if (controller.signal.aborted) throw controller.signal.reason;
      await this.host.executeCommand('workbench.action.chat.newChat');
      // /autoApprove is scoped to this newly-created chat. It is deliberately
      // issued as its own silent slash command rather than being concatenated
      // with the real prompt (VS Code executes only the slash command text).
      await this.host.executeCommand('workbench.action.chat.open', {
        query: '/autoApprove',
        blockOnResponse: true,
      });
      emit({ type: 'started', turn_id: turnId });
      const bindDeadline = this.now() + Math.min(MAX_REQUEST_BIND_MS, this.turnMs);
      // The real prompt is a separate request so the exported request id can
      // identify it independently from the /autoApprove command. blockOnResponse
      // is intentionally tracked, not awaited, so export polling can stream.
      void this.host.executeCommand('workbench.action.chat.open', {
        query: request.prompt,
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
        const requests = exportedRequests(snapshot);
        let latest: ExportedRequest | undefined;
        if (boundRequestId !== undefined) {
          latest = requests.find((candidate) =>
            candidate.requestId === boundRequestId && candidate.prompt === request.prompt);
          if (latest === undefined) throw requestBindingError();
        } else {
          if (this.now() >= bindDeadline) throw requestBindingError();
          latest = latestMatchingRequest(requests, request.prompt);
          if (latest !== undefined) {
            boundRequestId = latest.requestId;
          } else {
            if (requests.some((candidate) =>
              candidate.prompt === request.prompt && candidate.requestId === undefined)) {
              throw missingRequestIdError();
            }
            const unrelatedPending = requests.some((candidate) =>
              candidate.prompt !== undefined
              && candidate.prompt !== request.prompt
              && candidate.prompt !== '/autoApprove'
              && candidate.response.some((part, index) => waitingPart(part, index) !== undefined));
            if (unrelatedPending) throw requestBindingError();
          }
        }
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
            break;
          }
          if (pending !== undefined) {
            // chat.export and chat.acceptTool both follow VS Code's focused
            // widget when no sessionResource can be supplied. Re-export the
            // exact request immediately before Allow so a changed chat fails
            // closed instead of approving an unrelated pending tool.
            const revalidatedSnapshot = await this.host.exportSnapshot(turnId);
            const revalidatedEncoded = JSON.stringify(revalidatedSnapshot);
            if (revalidatedEncoded.length > MAX_EXPORT_CHARS) {
              throw new Error('Copilot export exceeded its bound');
            }
            const revalidated = exportedRequests(revalidatedSnapshot).find((candidate) =>
              candidate.requestId === boundRequestId && candidate.prompt === request.prompt);
            if (revalidated === undefined) throw requestBindingError();
            const revalidatedPending = revalidated.response
              .map((part, index) => waitingPart(part, index))
              .find((value): value is WaitingPart => value !== undefined);
            if (
              revalidatedPending?.index === pending.index
              && revalidatedPending.stateKey === pending.stateKey
            ) {
              const lifecycle = approvals.get(pending.index)!;
              if (lifecycle.attempts >= MAX_APPROVAL_ATTEMPTS) throw noOpApprovalError(pending.index);
              lifecycle.attempts += 1;
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
