import { describe, expect, it, vi } from 'vitest';

import {
  MAX_REQUEST_BIND_MS,
  NativeChatRunner,
  type NativeChatHost,
  type NativeStreamEvent,
} from './native-chat';

function snapshot(
  parts: unknown[],
  result?: unknown,
  request = 'work',
  requestId = 'request-1',
): unknown {
  return {
    requests: [{
      request,
      requestId,
      response: { entireResponse: { value: parts } },
      ...(result !== undefined && { result }),
    }],
  };
}

function snapshotRequests(
  requests: Array<{ request: string; requestId: string; parts: unknown[]; result?: unknown }>,
): unknown {
  return {
    requests: requests.map(({ request, requestId, parts, result }) => ({
      request,
      requestId,
      response: { entireResponse: { value: parts } },
      ...(result !== undefined && { result }),
    })),
  };
}

function realSnapshotRequests(
  requests: Array<{ request: string; requestId: string; parts: unknown[]; result?: unknown }>,
): unknown {
  return {
    requests: requests.map(({ request, requestId, parts, result }) => ({
      message: { text: request, parts: [] },
      requestId,
      response: parts,
      ...(result !== undefined && { result }),
    })),
  };
}

function textSnapshot(text: string, done = false, request = 'work', requestId = 'request-1'): unknown {
  return snapshot([{ value: text }], done ? { status: 'complete' } : undefined, request, requestId);
}

function tool(state: string, toolId = 'terminal', extra: Record<string, unknown> = {}): unknown {
  return {
    kind: 'toolInvocation',
    toolId,
    invocationMessage: 'Run terminal',
    pastTenseMessage: 'Ran terminal',
    state: { type: state, ...extra },
  };
}

// harn:assume vscode-copilot-native-agent-auto-approves-and-streams-evidence ref=vscode-copilot-native-chat-regression
describe('native VS Code Copilot chat runtime', () => {
  it('opens the exact native agent with chat-local /autoApprove and emits accumulated text deltas', async () => {
    const commands: Array<{ command: string; args: unknown[] }> = [];
    const snapshots = [
      realSnapshotRequests([
        { request: '/autoApprove', requestId: 'auto-1', parts: [] },
        { request: 'unrelated history', requestId: 'old-1', parts: [{ value: 'ignore me' }] },
        { request: 'work', requestId: 'work-1', parts: [{ value: 'Hel' }] },
      ]),
      realSnapshotRequests([
        { request: 'work', requestId: 'work-1', parts: [{ value: 'Hello' }], result: { status: 'complete' } },
      ]),
    ];
    const host: NativeChatHost = {
      async executeCommand(command, ...args) {
        commands.push({ command, args });
        return undefined;
      },
      exportSnapshot: async () => snapshots.shift() ?? realSnapshotRequests([
        { request: 'work', requestId: 'work-1', parts: [{ value: 'Hello' }], result: { status: 'complete' } },
      ]),
      delay: async () => undefined,
    };
    const events: NativeStreamEvent[] = [];
    await new NativeChatRunner(host, 0).run(
      {
        prompt: 'work',
        model: 'gpt-5.6-luna',
        history: [{ role: 'user', text: 'before' }, { role: 'assistant', text: 'after' }],
      },
      (event) => events.push(event),
      new AbortController().signal,
    );

    expect(commands.slice(0, 3)).toEqual([
      { command: 'workbench.action.chat.newChat', args: [] },
      {
        command: 'workbench.action.chat.open',
        args: [{ query: '/autoApprove', blockOnResponse: true }],
      },
      { command: 'workbench.action.chat.open', args: [expect.objectContaining({
        query: 'work',
        mode: 'agent',
        modelSelector: { vendor: 'copilot', id: 'gpt-5.6-luna' },
        previousRequests: [{ request: 'before', response: 'after' }],
        blockOnResponse: true,
      })] },
    ]);
    expect(events.filter((event) => event.type === 'part').map((event) =>
      event.type === 'part' ? event.text_delta : undefined)).toEqual(['Hel', 'lo']);
    expect(events.at(-1)?.type).toBe('done');
  });

  it('allows ordinary, hard-blocked, repeated-identical, pre, and post tool states by part lifecycle', async () => {
    let phase = 0;
    const commands: string[] = [];
    const host: NativeChatHost = {
      async executeCommand(command) {
        commands.push(command);
        if (command === 'workbench.action.chat.acceptTool') phase += 1;
        return undefined;
      },
      exportSnapshot: async () => {
        if (phase === 0) {
          return snapshot(
            [tool('WaitingForConfirmation', 'terminal', { preExecution: true })],
            undefined,
            'run the repeated command',
            'run-1',
          );
        }
        if (phase === 1) {
          return snapshot([
            tool('completed', 'terminal'),
            tool('WaitingForConfirmation', 'terminal', { hardBlocked: true }),
          ], undefined, 'run the repeated command', 'run-1');
        }
        if (phase === 2) {
          return snapshot([
            tool('completed', 'terminal'),
            tool('WaitingForPostApproval', 'terminal'),
          ], undefined, 'run the repeated command', 'run-1');
        }
        return snapshot([
          tool('completed', 'terminal'),
          tool('completed', 'terminal'),
        ], { status: 'complete' }, 'run the repeated command', 'run-1');
      },
      delay: async () => undefined,
    };
    const events: NativeStreamEvent[] = [];
    await new NativeChatRunner(host, 0).run(
      { prompt: 'run the repeated command' },
      (event) => events.push(event),
      new AbortController().signal,
    );

    expect(commands.filter((command) => command === 'workbench.action.chat.acceptTool')).toHaveLength(3);
    expect(events.at(-1)).toEqual(expect.objectContaining({ type: 'done' }));
  });

  it('fails boundedly with an actionable error when Allow does not advance the pending part', async () => {
    const accept = vi.fn(async () => undefined);
    const host: NativeChatHost = {
      async executeCommand(command) {
        if (command === 'workbench.action.chat.acceptTool') await accept();
        return undefined;
      },
      exportSnapshot: async () => snapshot([tool('WaitingForConfirmation')], undefined, 'blocked', 'blocked-1'),
      delay: async () => undefined,
    };
    const events: NativeStreamEvent[] = [];
    await new NativeChatRunner(host, 0).run(
      { prompt: 'blocked' },
      (event) => events.push(event),
      new AbortController().signal,
    );

    expect(accept).toHaveBeenCalledTimes(3);
    expect(events.at(-1)).toEqual({
      type: 'error',
      message: expect.stringContaining('Allow did not advance native tool part 0'),
    });
    expect(events.at(-1)).toEqual(expect.objectContaining({
      message: expect.stringContaining('reload the companion extension'),
    }));
  });

  it('fails closed when the focused chat changes before Allow', async () => {
    const accept = vi.fn(async () => undefined);
    let exports = 0;
    const host: NativeChatHost = {
      async executeCommand(command) {
        if (command === 'workbench.action.chat.acceptTool') await accept();
        return undefined;
      },
      exportSnapshot: async () => {
        exports += 1;
        if (exports === 1) {
          return snapshot([tool('WaitingForConfirmation')], undefined, 'work', 'work-1');
        }
        return snapshotRequests([
          { request: 'unrelated chat', requestId: 'other-1', parts: [tool('WaitingForConfirmation')] },
        ]);
      },
      delay: async () => undefined,
    };
    const events: NativeStreamEvent[] = [];
    await new NativeChatRunner(host, 0).run(
      { prompt: 'work' },
      (event) => events.push(event),
      new AbortController().signal,
    );

    expect(accept).not.toHaveBeenCalled();
    expect(events.at(-1)).toEqual(expect.objectContaining({
      type: 'error',
      message: expect.stringContaining('active chat no longer matches'),
    }));
  });

  it('fails boundedly when the real request never appears without sleeping', async () => {
    let now = 0;
    let exports = 0;
    const delay = vi.fn(async () => undefined);
    const host: NativeChatHost = {
      async executeCommand() {
        return undefined;
      },
      exportSnapshot: async () => {
        exports += 1;
        now = MAX_REQUEST_BIND_MS + 1;
        return { requests: [] };
      },
      delay,
    };
    const events: NativeStreamEvent[] = [];
    await new NativeChatRunner(host, 0, MAX_REQUEST_BIND_MS * 2, () => now).run(
      { prompt: 'never exported' },
      (event) => events.push(event),
      new AbortController().signal,
    );

    expect(exports).toBe(1);
    expect(delay).not.toHaveBeenCalled();
    expect(events.at(-1)).toEqual(expect.objectContaining({
      type: 'error',
      message: expect.stringContaining('active chat no longer matches'),
    }));
  });

  it('calls native cancel when the Codor request is aborted', async () => {
    const controller = new AbortController();
    const executeCommand = vi.fn(async () => undefined);
    const host: NativeChatHost = {
      executeCommand,
      exportSnapshot: async () => {
        controller.abort(new Error('stop'));
        return snapshot([], undefined, 'test', 'test-1');
      },
      delay: async () => undefined,
    };
    await new NativeChatRunner(host, 0).run(
      { prompt: 'test' },
      () => undefined,
      controller.signal,
    );
    expect(executeCommand).toHaveBeenCalledWith('workbench.action.chat.cancel');
  });
});
// harn:end vscode-copilot-native-agent-auto-approves-and-streams-evidence
