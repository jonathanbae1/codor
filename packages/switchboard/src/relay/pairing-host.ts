import {
  PairingChannel,
  PakeError,
  PakeHost,
  composeCode,
  formatCode,
  generateSecret,
  type PairingMessage,
} from '@codor/tunnel';

import type { PublicIdentity } from '../crypto/keys.js';
import type { PairingRequest, PairingResult, PairingService } from '../crypto/pairing.js';
import { dialWs, type RelaySocket } from './link.js';
import type { RelayStore } from './store.js';

// harn:assume relay-pairing-host ref=relay-pairing-host
// Host side of relay pairing (PLAN §4.2). It reserves a room, connects as host,
// runs a fresh PakeHost per claimant, and over the pairing AEAD channel bridges
// to the EXISTING PairingService: hello carries a token minted by issue(); the
// claimant's echoed token is verified and complete() enrolls the device into the
// same PairingResult as local pairing. Attempt/reset accounting preserves the
// online-guess bound; success burns the room.
const PAIRING_WINDOW_MS = 10 * 60 * 1000;
const MAX_ATTEMPTS = 3;

export interface RelayPairingHostDeps {
  store: RelayStore;
  pairing: PairingService;
  identity: PublicIdentity;
  reserveRoom?: (relayUrl: string) => Promise<{ nameplate: string }>;
  dialRoom?: (url: string) => RelaySocket;
  now?: () => number;
  randomSecret?: () => string;
  setTimeoutFn?: (callback: () => void, ms: number) => ReturnType<typeof setTimeout>;
  clearTimeoutFn?: (handle: ReturnType<typeof setTimeout>) => void;
  onError?: (error: unknown) => void;
}

async function defaultReserve(relayUrl: string): Promise<{ nameplate: string }> {
  const base = relayUrl.replace(/\/$/, '');
  const httpBase = base.replace(/^ws/, 'http');
  const response = await fetch(`${httpBase}/v1/pair/rooms`, { method: 'POST' });
  if (!response.ok) throw new Error(`relay pairing room reservation failed (${response.status})`);
  return (await response.json()) as { nameplate: string };
}

/** Drives one relay pairing session against the pairing room. */
export class RelayPairingHost {
  private readonly deps: Required<Omit<RelayPairingHostDeps, 'onError'>> & Pick<RelayPairingHostDeps, 'onError'>;

  constructor(deps: RelayPairingHostDeps) {
    this.deps = {
      reserveRoom: defaultReserve,
      dialRoom: dialWs,
      now: Date.now,
      randomSecret: generateSecret,
      setTimeoutFn: (cb, ms) => setTimeout(cb, ms),
      clearTimeoutFn: (handle) => clearTimeout(handle),
      ...deps,
    };
  }

  /** Reserve a room, show a code, and pair the first claimant that completes. */
  async pair(): Promise<{ code: string; expires_at: string }> {
    const { store } = this.deps;
    const secret = this.deps.randomSecret();
    const { nameplate } = await this.deps.reserveRoom(store.relayUrl);
    const code = formatCode(composeCode(nameplate, secret));
    const expiresAt = new Date(this.deps.now() + PAIRING_WINDOW_MS).toISOString();

    const wsBase = store.relayUrl.replace(/\/$/, '').replace(/^http/, 'ws');
    const socket = this.deps.dialRoom(`${wsBase}/v1/pair/${nameplate}/ws?role=host`);
    new RelayPairingSession(socket, nameplate, secret, this.deps);
    return { code, expires_at: expiresAt };
  }
}

type Phase = 'idle' | 'msgB' | 'tagC' | 'enroll' | 'done';

/** State machine for a single room session (one nameplate). */
class RelayPairingSession {
  private phase: Phase = 'idle';
  private pake?: PakeHost;
  private channel?: PairingChannel;
  private token?: string;
  private attempts = 0;
  private closed = false;
  private readonly deadline: ReturnType<typeof setTimeout>;

  constructor(
    private readonly socket: RelaySocket,
    private readonly nameplate: string,
    private readonly secret: string,
    private readonly deps: RelayPairingHost['deps'],
  ) {
    socket.onMessage((data, isBinary) => this.onMessage(data, isBinary));
    socket.onError((error) => this.deps.onError?.(error));
    socket.onClose(() => this.shutdown());
    // The host enforces the 10-minute pairing window itself: a malicious relay
    // cannot extend the guessing window by never burning the room.
    this.deadline = this.deps.setTimeoutFn(() => this.shutdown(), PAIRING_WINDOW_MS);
  }

  private sendText(value: unknown): void {
    this.socket.send(JSON.stringify(value));
  }

  private shutdown(): void {
    if (this.closed) return;
    this.closed = true;
    this.deps.clearTimeoutFn(this.deadline);
    this.socket.close();
  }

  /** Count a failed guess; the host burns the pairing after three, independent of the relay. */
  private failAttempt(): void {
    this.attempts += 1;
    this.sendText({ type: 'fail' });
    this.phase = 'idle';
    this.pake = undefined;
    if (this.attempts >= MAX_ATTEMPTS) this.shutdown();
  }

  private onMessage(data: Uint8Array, isBinary: boolean): void {
    if (this.closed) return;
    try {
      if (isBinary) this.onBinary(data);
      else this.onControl(JSON.parse(new TextDecoder().decode(data)) as { type?: string });
    } catch (error) {
      this.deps.onError?.(error);
    }
  }

  private onControl(msg: { type?: string }): void {
    // A fresh claimant joined: (re)start the PAKE and send MSG_A.
    if (msg.type === 'peer-joined' && this.attempts < MAX_ATTEMPTS) this.startAttempt();
  }

  private startAttempt(): void {
    this.pake = new PakeHost({ nameplate: this.nameplate, secret: this.secret });
    this.channel = undefined;
    this.token = undefined;
    this.phase = 'msgB';
    this.socket.send(this.pake.start());
  }

  private onBinary(data: Uint8Array): void {
    switch (this.phase) {
      case 'msgB':
        try {
          this.pake!.receiveMsgB(data);
        } catch (error) {
          // An invalid/identity point is a spec-required failed attempt (§4.2).
          if (error instanceof PakeError) return this.failAttempt();
          throw error;
        }
        this.phase = 'tagC';
        break;
      case 'tagC':
        this.handleClaimantConfirmation(data);
        break;
      case 'enroll':
        this.handleEnroll(this.channel!.open(data));
        break;
      case 'done':
        this.handleDone(this.channel!.open(data));
        break;
      default:
        break; // idle / stray binary
    }
  }

  private handleClaimantConfirmation(tagC: Uint8Array): void {
    let tagH: Uint8Array;
    try {
      tagH = this.pake!.receiveClaimantConfirmation(tagC);
    } catch (error) {
      // Wrong secret: count the attempt; burn after three.
      if (error instanceof PakeError) return this.failAttempt();
      throw error;
    }
    this.socket.send(tagH);
    this.channel = new PairingChannel(this.pake!.channel());
    const offer = this.deps.pairing.issue(this.deps.store.relayUrl);
    this.token = offer.pairing_token;
    const hello: PairingMessage = {
      type: 'hello',
      switchboard: this.deps.identity,
      session_id: this.deps.store.sessionId,
      host_static_pub: this.deps.store.hostStaticPubB64,
      pairing_token: offer.pairing_token,
      relay_url: this.deps.store.relayUrl,
      protocol: 1,
    };
    this.socket.send(this.channel.seal(hello));
    this.phase = 'enroll';
  }

  private handleEnroll(message: PairingMessage): void {
    if (message.type !== 'enroll') throw new Error(`expected enroll, got ${message.type}`);
    if (message.pairing_token !== this.token) throw new Error('pairing token mismatch');
    const result: PairingResult = this.deps.pairing.complete(this.token, message.request as PairingRequest);
    const request = message.request as PairingRequest;
    this.deps.store.addDevice({ device_id: request.device_id, client_static_pub: message.client_static_pub, label: request.label });
    const enrolled: PairingMessage = { type: 'enrolled', result };
    this.socket.send(this.channel!.seal(enrolled));
    this.phase = 'done';
  }

  private handleDone(message: PairingMessage): void {
    if (message.type !== 'done') throw new Error(`expected done, got ${message.type}`);
    this.sendText({ type: 'success' });
    this.phase = 'idle';
    // Success: stop the deadline and go inert; the relay burns the room.
    this.deps.clearTimeoutFn(this.deadline);
    this.closed = true;
  }
}
// harn:end relay-pairing-host
