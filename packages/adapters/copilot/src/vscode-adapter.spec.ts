import { closeSync, mkdirSync, openSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { CopilotVscodeAdapter, vscodeCopilotBridgeAvailable } from './vscode-adapter.js';

const roots: string[] = [];

async function fixture(lines: unknown[]): Promise<{
  adapter: CopilotVscodeAdapter;
  close(): Promise<void>;
  discovery: string;
  requests: Array<{ url: string; authorization?: string; body?: unknown }>;
}> {
  const root = join(tmpdir(), `codor-vscode-${process.pid}-${Date.now()}-${Math.random()}`);
  roots.push(root);
  mkdirSync(root, { recursive: true });
  const requests: Array<{ url: string; authorization?: string; body?: unknown }> = [];
  const token = 'a'.repeat(64);
  const server = createServer(async (request, reply) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    const source = Buffer.concat(chunks).toString('utf8');
    requests.push({
      url: request.url ?? '',
      authorization: request.headers.authorization,
      ...(source !== '' && { body: JSON.parse(source) as unknown }),
    });
    if (request.headers.authorization !== `Bearer ${token}`) {
      reply.statusCode = 401;
      reply.end();
      return;
    }
    if (request.url === '/v1/models') {
      reply.setHeader('content-type', 'application/json');
      reply.end(JSON.stringify({ models: [{ id: 'gpt-5.6-luna' }, { id: 'gpt-4o-mini' }] }));
      return;
    }
    if (request.url === '/v1/turn') {
      reply.setHeader('content-type', 'application/x-ndjson');
      reply.end(lines.map((line) => JSON.stringify(line)).join('\n'));
      return;
    }
    reply.end(JSON.stringify({ ok: true }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('fixture did not listen');
  const discovery = join(root, 'bridge.json');
  const fd = openSync(discovery, 'wx', 0o600);
  writeFileSync(fd, JSON.stringify({
    protocol_version: 1,
    pid: process.pid,
    port: address.port,
    token,
    started_at: new Date().toISOString(),
  }));
  closeSync(fd);
  return {
    adapter: new CopilotVscodeAdapter(discovery),
    discovery,
    requests,
    close: () => new Promise((resolve, reject) =>
      server.close((error) => error ? reject(error) : resolve())),
  };
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

// harn:assume vscode-copilot-bridge-is-manual-local-and-credential-private ref=vscode-copilot-bridge-regression
// harn:assume vscode-copilot-native-agent-auto-approves-and-streams-evidence ref=vscode-copilot-adapter-regression
describe('VS Code Copilot adapter bridge', () => {
  it('discovers live models and maps the authenticated native stream without approval cards or round trips', async () => {
    const bridge = await fixture([
      { type: 'started', turn_id: 'turn-1' },
      { type: 'part', text_delta: 'hello' },
      {
        type: 'part',
        index: 1,
        part: {
          kind: 'toolInvocation',
          toolId: 'terminal',
          invocationMessage: 'Run tests',
          pastTenseMessage: 'Ran tests',
          state: { type: 'completed' },
        },
      },
      {
        type: 'done',
        result: { status: 'complete' },
        response: [{ value: 'hello' }],
      },
    ]);
    try {
      expect(await bridge.adapter.listModels()).toEqual({
        models: ['gpt-5.6-luna', 'gpt-4o-mini'],
        source: 'discovered',
      });
      const session = bridge.adapter.spawn({
        cwd: '/tmp',
        model: 'gpt-5.6-luna',
        policy: 'workspace-write',
      });
      const events = [];
      for await (const event of bridge.adapter.deliver(session, 'work')) events.push(event);
      expect(events).toContainEqual({
        type: 'run.item',
        item_type: 'text_delta',
        payload: { text: 'hello' },
      });
      expect(events.some((event) => event.type === 'approval.raised')).toBe(false);
      expect(events).toContainEqual(expect.objectContaining({
        type: 'run.item',
        item_type: 'tool_call',
        payload: expect.objectContaining({ tool: 'terminal', title: 'Run tests' }),
      }));
      expect(events).toContainEqual(expect.objectContaining({
        type: 'run.item',
        item_type: 'tool_result',
        payload: expect.objectContaining({ status: 'ok', output_text: 'Ran tests' }),
      }));
      expect(events.at(-1)).toEqual({
        type: 'run.completed',
        status: 'completed',
        final_text: 'hello',
      });
      expect(bridge.requests.some((request) => request.url.includes('/interaction'))).toBe(false);
      expect(bridge.requests.every((request) => request.authorization === `Bearer ${'a'.repeat(64)}`))
        .toBe(true);
    } finally {
      await bridge.close();
    }
  });

  it('requires the live bridge generation for the explicit cache revive and never attaches a native ref', async () => {
    const bridge = await fixture([]);
    try {
      const session = bridge.adapter.spawn({ cwd: '/tmp' });
      expect(bridge.adapter.canReviveSession(session)).toBe(true);
      expect(() => bridge.adapter.attach('native-ref')).toThrow('does not support native session attach');
      writeFileSync(bridge.discovery, JSON.stringify({
        protocol_version: 1,
        pid: process.pid,
        port: 1,
        token: 'b'.repeat(64),
        started_at: new Date().toISOString(),
      }));
      expect(bridge.adapter.canReviveSession(session)).toBe(false);
    } finally {
      await bridge.close();
    }
  });

  it('rejects thinking and fails safely when no valid discovery record exists', async () => {
    const missing = join(tmpdir(), `missing-${Date.now()}.json`);
    const adapter = new CopilotVscodeAdapter(missing);
    expect(vscodeCopilotBridgeAvailable(missing)).toBe(false);
    expect(() => adapter.spawn({ cwd: '/tmp', thinking: 'high' })).toThrow('does not support');
    await expect(adapter.listModels()).rejects.toThrow('bridge is unavailable');
  });
});
// harn:end vscode-copilot-native-agent-auto-approves-and-streams-evidence
// harn:end vscode-copilot-bridge-is-manual-local-and-credential-private
