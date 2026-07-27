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

/** Open the mic and capture mono PCM until stop()/cancel(). Prefers a 24 kHz
 *  context, else captures at the device rate and resamples on encode. */
export async function startRecording(): Promise<RecordingHandle> {
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
  const processor = context.createScriptProcessor(4096, 1, 1);
  const chunks: Float32Array[] = [];
  processor.onaudioprocess = (event) => {
    chunks.push(new Float32Array(event.inputBuffer.getChannelData(0)));
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
