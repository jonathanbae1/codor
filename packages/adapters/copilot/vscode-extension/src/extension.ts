import { randomBytes, randomUUID } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

import * as vscode from 'vscode';

import {
  NativeChatRunner,
  type NativeChatHost,
  type NativeStreamEvent,
  type NativeTurnRequest,
} from './native-chat';

const PROTOCOL_VERSION = 1;
const MAX_REQUEST_BYTES = 512 * 1024;
const DISCOVERY_PATH = join(homedir(), '.codor', 'copilot-vscode-bridge.json');

interface ActiveTurn {
  id: string;
  controller: AbortController;
}

interface DiscoveryRecord {
  protocol_version: 1;
  pid: number;
  port: number;
  token: string;
  started_at: string;
}

function json(reply: ServerResponse, status: number, body: unknown): void {
  reply.statusCode = status;
  reply.setHeader('content-type', 'application/json; charset=utf-8');
  reply.end(JSON.stringify(body));
}

async function body(request: IncomingMessage): Promise<unknown> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += value.length;
    if (size > MAX_REQUEST_BYTES) throw new Error('request is too large');
    chunks.push(value);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') as unknown;
}

function atomicPrivateJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  const fd = openSync(temporary, 'wx', 0o600);
  try {
    writeFileSync(fd, JSON.stringify(value));
  } finally {
    closeSync(fd);
  }
  chmodSync(temporary, 0o600);
  renameSync(temporary, path);
}

function removeOwnedDiscovery(record: DiscoveryRecord): void {
  try {
    const current = JSON.parse(readFileSync(DISCOVERY_PATH, 'utf8')) as Partial<DiscoveryRecord>;
    if (current.pid === record.pid && current.token === record.token) rmSync(DISCOVERY_PATH);
  } catch {
    // Another window may own the current record, or shutdown may follow cleanup.
  }
}

function safeError(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 1000);
}

function createNativeHost(context: vscode.ExtensionContext): NativeChatHost {
  const exportRoot = vscode.Uri.joinPath(context.globalStorageUri, 'exports');
  return {
    executeCommand: <T>(command: string, ...args: unknown[]) =>
      Promise.resolve(vscode.commands.executeCommand<T>(command, ...args)),
    async exportSnapshot(turnId) {
      const uri = vscode.Uri.joinPath(exportRoot, `${turnId}.json`);
      await vscode.workspace.fs.createDirectory(exportRoot);
      await Promise.resolve(vscode.workspace.fs.delete(uri)).catch(() => undefined);
      try {
        await vscode.commands.executeCommand('workbench.action.chat.export', uri);
        const bytes = await vscode.workspace.fs.readFile(uri);
        return JSON.parse(Buffer.from(bytes).toString('utf8')) as unknown;
      } catch {
        return { requests: [] };
      } finally {
        await Promise.resolve(vscode.workspace.fs.delete(uri)).catch(() => undefined);
      }
    },
    delay(ms, signal) {
      return new Promise<void>((resolve, reject) => {
        if (signal.aborted) {
          reject(signal.reason);
          return;
        }
        const timer = setTimeout(resolve, ms);
        signal.addEventListener('abort', () => {
          clearTimeout(timer);
          reject(signal.reason);
        }, { once: true });
      });
    },
  };
}

function validTurn(value: unknown): NativeTurnRequest | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const source = value as Record<string, unknown>;
  if (typeof source.prompt !== 'string' || source.prompt.length === 0 || source.prompt.length > 256 * 1024) {
    return undefined;
  }
  if (source.model !== undefined && (typeof source.model !== 'string' || source.model.length > 256)) {
    return undefined;
  }
  const history = Array.isArray(source.history)
    ? source.history.flatMap((entry) => {
        if (typeof entry !== 'object' || entry === null) return [];
        const item = entry as Record<string, unknown>;
        return (item.role === 'user' || item.role === 'assistant') && typeof item.text === 'string'
          ? [{ role: item.role as 'user' | 'assistant', text: item.text }]
          : [];
      })
    : undefined;
  return {
    prompt: source.prompt,
    ...(typeof source.model === 'string' && { model: source.model }),
    ...(history !== undefined && { history }),
  };
}

// harn:assume vscode-copilot-bridge-is-manual-local-and-credential-private ref=vscode-copilot-loopback-runtime
function startBridge(context: vscode.ExtensionContext): Promise<{
  record: DiscoveryRecord;
  server: Server;
  dispose(): void;
}> {
  const token = randomBytes(32).toString('hex');
  const runner = new NativeChatRunner(createNativeHost(context));
  let active: ActiveTurn | undefined;

  const server = createServer(async (request, reply) => {
    reply.setHeader('x-content-type-options', 'nosniff');
    if (request.headers.authorization !== `Bearer ${token}`) {
      json(reply, 401, { error: 'unauthorized' });
      return;
    }
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    try {
      if (request.method === 'GET' && url.pathname === '/v1/health') {
        json(reply, 200, { protocol_version: PROTOCOL_VERSION, busy: active !== undefined });
        return;
      }
      if (request.method === 'GET' && url.pathname === '/v1/models') {
        const models = await vscode.lm.selectChatModels({ vendor: 'copilot' });
        json(reply, 200, {
          models: models.map((model) => ({
            id: model.id,
            name: model.name,
            family: model.family,
            version: model.version,
            max_input_tokens: model.maxInputTokens,
          })),
        });
        return;
      }
      if (request.method === 'POST' && url.pathname === '/v1/turn') {
        if (active !== undefined) {
          json(reply, 409, { error: 'the native Copilot bridge is busy' });
          return;
        }
        const turn = validTurn(await body(request));
        if (turn === undefined) {
          json(reply, 400, { error: 'invalid turn request' });
          return;
        }
        const state: ActiveTurn = { id: randomUUID(), controller: new AbortController() };
        active = state;
        reply.statusCode = 200;
        reply.setHeader('content-type', 'application/x-ndjson; charset=utf-8');
        const send = (event: NativeStreamEvent) => {
          if (event.type === 'started') state.id = event.turn_id;
          if (!reply.destroyed) reply.write(`${JSON.stringify(event)}\n`);
        };
        reply.on('close', () => {
          if (!reply.writableEnded) state.controller.abort(new Error('Codor disconnected'));
        });
        await runner.run(turn, send, state.controller.signal);
        if (!reply.destroyed) reply.end();
        if (active === state) active = undefined;
        return;
      }
      const cancel = url.pathname.match(/^\/v1\/turn\/([^/]+)\/cancel$/);
      if (request.method === 'POST' && cancel !== null) {
        if (active?.id !== cancel[1]) {
          json(reply, 404, { error: 'no such active turn' });
          return;
        }
        active.controller.abort(new Error('interrupted by Codor'));
        await Promise.resolve(
          vscode.commands.executeCommand('workbench.action.chat.cancel'),
        ).catch(() => undefined);
        json(reply, 200, { ok: true });
        return;
      }
      // There is intentionally no approval endpoint. Native Allow decisions
      // happen in NativeChatRunner inside this bridge-created chat.
      json(reply, 404, { error: 'not found' });
    } catch (error) {
      json(reply, 500, { error: safeError(error) });
    }
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      const address = server.address();
      if (address === null || typeof address === 'string') {
        reject(new Error('failed to bind the Copilot bridge'));
        return;
      }
      const record: DiscoveryRecord = {
        protocol_version: PROTOCOL_VERSION,
        pid: process.pid,
        port: address.port,
        token,
        started_at: new Date().toISOString(),
      };
      atomicPrivateJson(DISCOVERY_PATH, record);
      resolve({
        record,
        server,
        dispose() {
          active?.controller.abort(new Error('bridge stopped'));
          server.close();
          removeOwnedDiscovery(record);
        },
      });
    });
  });
}
// harn:end vscode-copilot-bridge-is-manual-local-and-credential-private

// harn:assume vscode-copilot-bridge-is-manual-local-and-credential-private ref=vscode-copilot-extension-manifest
export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const bridge = await startBridge(context);
  context.subscriptions.push(
    new vscode.Disposable(() => bridge.dispose()),
    vscode.commands.registerCommand('codor.copilotBridge.status', () =>
      vscode.window.showInformationMessage(
        `Codor Copilot Bridge is listening locally (protocol ${bridge.record.protocol_version}).`,
      )),
  );
}

export function deactivate(): void {
  // The context subscription owns shutdown and discovery cleanup.
}
// harn:end vscode-copilot-bridge-is-manual-local-and-credential-private
