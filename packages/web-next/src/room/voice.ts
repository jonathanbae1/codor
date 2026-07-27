// Client half of web dictation (Phase 3): discover the provider, capture mic
// audio, encode 24 kHz mono PCM16 WAV, and POST it to the room-agnostic
// transcribe endpoint. Kept in web-next (not @runtime/api) so the whole feature
// is one batch, mirroring attachments.ts. Framework-free so the encoder and the
// dictation state machine are unit-testable without a DOM or a network.

export interface VoiceProviderMetadata {
  id: string;
  label: string;
  available: boolean;
  reason?: string;
}
export interface VoiceCatalog {
  enabled: boolean;
  selected: string;
  providers: VoiceProviderMetadata[];
}

/** GET the operator-selected provider catalog (bearer auth, same origin). */
export async function fetchVoiceProviders(token: string): Promise<VoiceCatalog> {
  const res = await fetch('/api/voice/providers', {
    headers: { authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`voice catalog failed (${String(res.status)})`);
  return res.json() as Promise<VoiceCatalog>;
}

/** POST the WAV bytes as a raw body; returns the transcript or throws the
 *  server's `{ error }` message (same shape as uploadAttachment). */
export async function transcribeVoice(token: string, wav: Uint8Array): Promise<string> {
  const res = await fetch('/api/voice/transcribe', {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'audio/wav' },
    body: wav as BodyInit,
  });
  if (!res.ok) {
    const detail = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(detail.error ?? `transcription failed (${String(res.status)})`);
  }
  const { text } = (await res.json()) as { text: string };
  return text;
}

export const VOICE_SAMPLE_RATE = 24_000;
export const MAX_RECORDING_MS = 60_000;

/** Linear resample of mono Float32 PCM from one rate to another. */
function resample(input: Float32Array, from: number, to: number): Float32Array {
  if (from === to || input.length <= 1) return input;
  const outLength = Math.max(1, Math.round((input.length * to) / from));
  const out = new Float32Array(outLength);
  const step = (input.length - 1) / Math.max(1, outLength - 1);
  for (let i = 0; i < outLength; i += 1) {
    const pos = i * step;
    const low = Math.floor(pos);
    const high = Math.min(input.length - 1, low + 1);
    const frac = pos - low;
    out[i] = input[low]! * (1 - frac) + input[high]! * frac;
  }
  return out;
}

/** Encode mono Float32 PCM as a 24 kHz mono PCM16 RIFF/WAVE payload. */
export function encodeWav(mono: Float32Array, sampleRate: number): Uint8Array {
  const samples = resample(mono, sampleRate, VOICE_SAMPLE_RATE);
  const dataBytes = samples.length * 2;
  const buffer = new ArrayBuffer(44 + dataBytes);
  const view = new DataView(buffer);
  const tag = (offset: number, text: string): void => {
    for (let i = 0; i < text.length; i += 1) view.setUint8(offset + i, text.charCodeAt(i));
  };
  tag(0, 'RIFF');
  view.setUint32(4, 36 + dataBytes, true);
  tag(8, 'WAVE');
  tag(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, VOICE_SAMPLE_RATE, true);
  view.setUint32(28, VOICE_SAMPLE_RATE * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  tag(36, 'data');
  view.setUint32(40, dataBytes, true);
  for (let i = 0; i < samples.length; i += 1) {
    const clamped = Math.max(-1, Math.min(1, samples[i]!));
    view.setInt16(44 + i * 2, Math.round(clamped * (clamped < 0 ? 0x8000 : 0x7fff)), true);
  }
  return new Uint8Array(buffer);
}

/** A live capture; every terminal path releases the mic and closes the context. */
export interface RecordingHandle {
  stop(): Promise<Uint8Array>;
  cancel(): void;
}

/** Live input level in 0..1 (RMS of the latest capture buffer). */
export type LevelListener = (level: number) => void;
export type StartRecording = (onLevel?: LevelListener) => Promise<RecordingHandle>;

/** Root-mean-square amplitude of a PCM buffer, clamped to 0..1. */
function rms(samples: Float32Array): number {
  if (samples.length === 0) return 0;
  let sum = 0;
  for (let i = 0; i < samples.length; i += 1) sum += samples[i]! * samples[i]!;
  return Math.min(1, Math.sqrt(sum / samples.length));
}

/** Open the mic and capture mono PCM until stop()/cancel(), emitting a live RMS
 *  level per buffer (~12–23 Hz) for the waveform. Prefers a 24 kHz context, else
 *  captures at the device rate and resamples on encode. */
export const startRecording: StartRecording = async (onLevel) => {
  const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  const Ctor = window.AudioContext
    ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
  let context: AudioContext;
  try {
    context = new Ctor({ sampleRate: VOICE_SAMPLE_RATE });
  } catch {
    context = new Ctor();
  }
  const source = context.createMediaStreamSource(stream);
  // A 2048-sample buffer keeps the level cadence lively (~12 Hz at 24 kHz).
  const processor = context.createScriptProcessor(2048, 1, 1);
  const chunks: Float32Array[] = [];
  processor.onaudioprocess = (event) => {
    const frame = new Float32Array(event.inputBuffer.getChannelData(0));
    chunks.push(frame);
    onLevel?.(rms(frame));
  };
  source.connect(processor);
  processor.connect(context.destination);

  const release = (): void => {
    processor.disconnect();
    source.disconnect();
    processor.onaudioprocess = null;
    stream.getTracks().forEach((track) => track.stop());
    void context.close();
  };

  return {
    async stop() {
      const rate = context.sampleRate;
      release();
      const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
      const merged = new Float32Array(total);
      let offset = 0;
      for (const chunk of chunks) {
        merged.set(chunk, offset);
        offset += chunk.length;
      }
      return encodeWav(merged, rate);
    },
    cancel() {
      release();
    },
  };
}

function captureErrorMessage(error: unknown): string {
  const name = (error as { name?: string } | null)?.name;
  if (name === 'NotAllowedError' || name === 'SecurityError') {
    return 'Microphone access was blocked — enable it in your browser settings.';
  }
  if (name === 'NotFoundError') return 'No microphone was found.';
  return error instanceof Error ? error.message : 'Could not start recording.';
}

export type DictationState = 'idle' | 'recording' | 'transcribing';

export interface DictationTimers {
  set(fn: () => void, ms: number): unknown;
  clear(handle: unknown): void;
}

const defaultTimers: DictationTimers = {
  set: (fn, ms) => setTimeout(fn, ms),
  clear: (handle) => { clearTimeout(handle as ReturnType<typeof setTimeout>); },
};

export interface DictationOptions {
  transcribe: (wav: Uint8Array) => Promise<string>;
  onState: (state: DictationState) => void;
  onTranscript: (text: string) => void;
  onError: (message: string) => void;
  startRecording?: () => Promise<RecordingHandle>;
  timers?: DictationTimers;
}

/**
 * The push-to-talk state machine: idle → recording → transcribing → idle, with
 * a single capture in flight, a 60 s auto-stop, and every failure returning to
 * idle with the mic released. Framework-free; the React composer wires its
 * callbacks and an elapsed timer around it.
 */
export class DictationController {
  private stateValue: DictationState = 'idle';
  private handle: RecordingHandle | undefined;
  private autoStop: unknown;
  private readonly begin: () => Promise<RecordingHandle>;
  private readonly timers: DictationTimers;

  constructor(private readonly options: DictationOptions) {
    this.begin = options.startRecording ?? startRecording;
    this.timers = options.timers ?? defaultTimers;
  }

  get state(): DictationState {
    return this.stateValue;
  }

  /** Start when idle, stop when recording; a no-op mid-transcription. */
  async toggle(): Promise<void> {
    if (this.stateValue === 'idle') return this.start();
    if (this.stateValue === 'recording') return this.stop();
  }

  async start(): Promise<void> {
    if (this.stateValue !== 'idle') return;
    let handle: RecordingHandle;
    try {
      handle = await this.begin();
    } catch (error) {
      this.options.onError(captureErrorMessage(error));
      return;
    }
    this.handle = handle;
    this.setState('recording');
    this.autoStop = this.timers.set(() => { void this.stop(); }, MAX_RECORDING_MS);
  }

  async stop(): Promise<void> {
    if (this.stateValue !== 'recording' || !this.handle) return;
    this.clearAutoStop();
    const handle = this.handle;
    this.handle = undefined;
    let wav: Uint8Array;
    try {
      wav = await handle.stop();
    } catch (error) {
      this.fail(captureErrorMessage(error));
      return;
    }
    this.setState('transcribing');
    try {
      const text = await this.options.transcribe(wav);
      this.setState('idle');
      this.options.onTranscript(text);
    } catch (error) {
      this.setState('idle');
      this.options.onError(error instanceof Error ? error.message : 'Transcription failed.');
    }
  }

  cancel(): void {
    if (this.stateValue === 'idle') return;
    this.clearAutoStop();
    this.handle?.cancel();
    this.handle = undefined;
    this.setState('idle');
  }

  private fail(message: string): void {
    this.clearAutoStop();
    this.handle?.cancel();
    this.handle = undefined;
    this.setState('idle');
    this.options.onError(message);
  }

  private clearAutoStop(): void {
    if (this.autoStop !== undefined) {
      this.timers.clear(this.autoStop);
      this.autoStop = undefined;
    }
  }

  private setState(state: DictationState): void {
    this.stateValue = state;
    this.options.onState(state);
  }
}

/** Format elapsed seconds as m:ss for the recording indicator. */
export function formatElapsed(seconds: number): string {
  const minutes = Math.floor(seconds / 60);
  return `${String(minutes)}:${String(seconds % 60).padStart(2, '0')}`;
}

export type DictationTakeState = 'recording' | 'transcribing' | 'done' | 'failed';

export interface DictationTake {
  id: string;
  state: DictationTakeState;
  text?: string;
  error?: string;
  durationSeconds: number;
}

export interface DictationSessionOptions {
  transcribe: (wav: Uint8Array) => Promise<string>;
  onChange: (takes: DictationTake[]) => void;
  startRecording?: StartRecording;
  onLevel?: LevelListener;
  timers?: DictationTimers;
  now?: () => number;
}

const EMPTY_TRANSCRIPT_MESSAGE = 'Nothing was transcribed';

/**
 * The multi-take dictation layer: record → Add a take → it transcribes in a
 * strict serial queue while you record the next, then Send resolves every done
 * text in take order. Framework-free and fully injectable; the React panel
 * renders from each onChange snapshot.
 */
export class DictationSession {
  private takes: DictationTake[] = [];
  private recordingId: string | undefined;
  private recordingHandle: RecordingHandle | undefined;
  private recordingStartedAt = 0;
  private autoAdd: unknown;
  private queue: { id: string; wav: Uint8Array }[] = [];
  private processing = false;
  private generation = 0;
  private seq = 0;
  private pendingSend: { resolve: (texts: string[]) => void; reject: (error: Error) => void } | undefined;
  private readonly begin: StartRecording;
  private readonly timers: DictationTimers;
  private readonly now: () => number;

  constructor(private readonly options: DictationSessionOptions) {
    this.begin = options.startRecording ?? startRecording;
    this.timers = options.timers ?? defaultTimers;
    this.now = options.now ?? (() => Date.now());
  }

  /** A stable ordered snapshot; callers never see internal mutation. */
  snapshot(): DictationTake[] {
    return this.takes.map((take) => ({ ...take }));
  }

  private emit(): void {
    this.options.onChange(this.snapshot());
  }

  private update(id: string, patch: Partial<DictationTake>): void {
    const take = this.takes.find((candidate) => candidate.id === id);
    if (!take) return;
    Object.assign(take, patch);
    this.emit();
  }

  private clearAutoAdd(): void {
    if (this.autoAdd !== undefined) {
      this.timers.clear(this.autoAdd);
      this.autoAdd = undefined;
    }
  }

  /** Begin a new take. No-op while one is already recording (earlier takes may
   *  still be transcribing). */
  async startTake(): Promise<void> {
    if (this.recordingId !== undefined) return;
    const id = `take-${String(++this.seq)}`;
    this.recordingId = id;
    this.takes.push({ id, state: 'recording', durationSeconds: 0 });
    this.emit();
    let handle: RecordingHandle;
    try {
      handle = await this.begin(this.options.onLevel);
    } catch (error) {
      this.recordingId = undefined;
      this.update(id, { state: 'failed', error: captureErrorMessage(error) });
      this.maybeResolveSend();
      return;
    }
    // A cancel/discardAll during the await must not leave a live handle.
    if (this.recordingId !== id) {
      handle.cancel();
      return;
    }
    this.recordingHandle = handle;
    this.recordingStartedAt = this.now();
    this.autoAdd = this.timers.set(() => { void this.addTake(); }, MAX_RECORDING_MS);
  }

  /** Stop the current recording and enqueue it for transcription. */
  async addTake(): Promise<void> {
    const id = this.recordingId;
    const handle = this.recordingHandle;
    if (id === undefined || !handle) return;
    this.clearAutoAdd();
    this.recordingId = undefined;
    this.recordingHandle = undefined;
    const durationSeconds = Math.max(0, (this.now() - this.recordingStartedAt) / 1000);
    let wav: Uint8Array;
    try {
      wav = await handle.stop();
    } catch (error) {
      this.update(id, { state: 'failed', error: captureErrorMessage(error), durationSeconds });
      this.maybeResolveSend();
      return;
    }
    this.update(id, { state: 'transcribing', durationSeconds });
    this.queue.push({ id, wav });
    void this.pump();
  }

  /** Discard the in-progress recording only; added takes are untouched. */
  cancelTake(): void {
    const id = this.recordingId;
    if (id === undefined) return;
    this.clearAutoAdd();
    this.recordingHandle?.cancel();
    this.recordingHandle = undefined;
    this.recordingId = undefined;
    this.takes = this.takes.filter((take) => take.id !== id);
    this.emit();
    this.maybeResolveSend();
  }

  /** Remove any take; a late transcription result for it is ignored. */
  removeTake(id: string): void {
    if (id === this.recordingId) {
      this.cancelTake();
      return;
    }
    this.takes = this.takes.filter((take) => take.id !== id);
    this.emit();
    this.maybeResolveSend();
  }

  /** Stop everything and drop all takes; every late result is ignored. */
  discardAll(): void {
    this.clearAutoAdd();
    this.recordingHandle?.cancel();
    this.recordingHandle = undefined;
    this.recordingId = undefined;
    this.queue = [];
    this.generation += 1;
    this.takes = [];
    this.emit();
    this.maybeResolveSend();
  }

  /** Resolve with the done texts in take order once nothing is recording or
   *  transcribing; reject if nothing succeeded. Finalizes an in-progress
   *  recording first so Send can never hang on it. */
  sendWhenReady(): Promise<string[]> {
    if (this.recordingId !== undefined) void this.addTake();
    return new Promise((resolve, reject) => {
      this.pendingSend = { resolve, reject };
      this.maybeResolveSend();
    });
  }

  private async pump(): Promise<void> {
    if (this.processing) return;
    this.processing = true;
    while (this.queue.length > 0) {
      const next = this.queue.shift()!;
      const gen = this.generation;
      try {
        const text = await this.options.transcribe(next.wav);
        this.applyResult(gen, next.id, text.trim());
      } catch (error) {
        this.applyResult(gen, next.id, undefined, error);
      }
    }
    this.processing = false;
    this.maybeResolveSend();
  }

  private applyResult(gen: number, id: string, text?: string, error?: unknown): void {
    if (gen !== this.generation) return; // discarded since this upload started
    if (!this.takes.some((take) => take.id === id)) return; // removed
    if (error !== undefined) {
      this.update(id, {
        state: 'failed',
        error: error instanceof Error ? error.message : 'Transcription failed.',
      });
    } else if (text === undefined || text === '') {
      this.update(id, { state: 'failed', error: EMPTY_TRANSCRIPT_MESSAGE });
    } else {
      this.update(id, { state: 'done', text });
    }
    this.maybeResolveSend();
  }

  private maybeResolveSend(): void {
    if (!this.pendingSend) return;
    if (this.takes.some((take) => take.state === 'recording' || take.state === 'transcribing')) return;
    const texts = this.takes
      .filter((take) => take.state === 'done' && take.text !== undefined)
      .map((take) => take.text!);
    const pending = this.pendingSend;
    this.pendingSend = undefined;
    if (texts.length === 0) pending.reject(new Error('No dictation to send.'));
    else pending.resolve(texts);
  }
}
