import { describe, expect, it, vi } from 'vitest';

import {
  NativeChatRunner,
  type NativeChatHost,
  type NativeStreamEvent,
} from './native-chat';

function snapshot(parts: unknown[], result?: unknown): unknown {
  return {
    requests: [{
      response: { entireResponse: { value: parts } },
      ...(result !== undefined && { result }),
    }],
  };
}

function textSnapshot(text: string, done = false): unknown {
  return snapshot([{ value: text }], done ? { status: 'complete' } : undefined);
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
    const snapshots = [textSnapshot('Hel'), textSnapshot('Hello', true)];
    const host: NativeChatHost = {
      async executeCommand(command, ...args) {
        commands.push({ command, args });
        return undefined;
      },
      exportSnapshot: async () => snapshots.shift() ?? textSnapshot('Hello', true),
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

    expect(commands[1]).toEqual({
      command: 'workbench.action.chat.open',
      args: [expect.objectContaining({
        query: '/autoApprove\nwork',
        mode: 'agent',
        modelSelector: { vendor: 'copilot', id: 'gpt-5.6-luna' },
        previousRequests: [{ request: 'before', response: 'after' }],
        blockOnResponse: true,
      })],
    });
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
        if (phase === 0) return snapshot([tool('WaitingForConfirmation', 'terminal', { preExecution: true })]);
        if (phase === 1) {
          return snapshot([
            tool('completed', 'terminal'),
            tool('WaitingForConfirmation', 'terminal', { hardBlocked: true }),
          ]);
        }
        if (phase === 2) {
          return snapshot([
            tool('completed', 'terminal'),
            tool('WaitingForPostApproval', 'terminal'),
          ]);
        }
        return snapshot([
          tool('completed', 'terminal'),
          tool('completed', 'terminal'),
        ], { status: 'complete' });
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
      exportSnapshot: async () => snapshot([tool('WaitingForConfirmation')]),
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

  it('calls native cancel when the Codor request is aborted', async () => {
    const controller = new AbortController();
    const executeCommand = vi.fn(async () => undefined);
    const host: NativeChatHost = {
      executeCommand,
      exportSnapshot: async () => {
        controller.abort(new Error('stop'));
        return snapshot([]);
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
