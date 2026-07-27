// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  DictationController,
  DictationSession,
  encodeWav,
  fetchVoiceProviders,
  formatElapsed,
  startRecording,
  transcribeVoice,
  VOICE_SAMPLE_RATE,
  type DictationState,
  type DictationTake,
  type DictationTimers,
  type RecordingHandle,
  type StartRecording,
} from './voice.js';

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void; reject: (e: unknown) => void } {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function wavHeader(bytes: Uint8Array): {
  riff: string; wave: string; format: number; channels: number; sampleRate: number; bits: number;
} {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const tag = (offset: number): string =>
    String.fromCharCode(bytes[offset]!, bytes[offset + 1]!, bytes[offset + 2]!, bytes[offset + 3]!);
  return {
    riff: tag(0),
    wave: tag(8),
    format: view.getUint16(20, true),
    channels: view.getUint16(22, true),
    sampleRate: view.getUint32(24, true),
    bits: view.getUint16(34, true),
  };
}

describe('encodeWav', () => {
  it('writes a 24 kHz mono PCM16 RIFF/WAVE header', () => {
    const out = encodeWav(new Float32Array(24_000).fill(0.1), VOICE_SAMPLE_RATE);
    expect(wavHeader(out)).toEqual({
      riff: 'RIFF', wave: 'WAVE', format: 1, channels: 1, sampleRate: 24_000, bits: 16,
    });
  });

  it('resamples 48 kHz capture down to ~24 kHz mono', () => {
    const out = encodeWav(new Float32Array(48_000).fill(0), 48_000);
    const frames = (out.length - 44) / 2;
    expect(frames).toBe(24_000);
    expect(wavHeader(out).sampleRate).toBe(24_000);
  });
});

describe('formatElapsed', () => {
  it('formats seconds as m:ss', () => {
    expect(formatElapsed(5)).toBe('0:05');
    expect(formatElapsed(72)).toBe('1:12');
  });
});

describe('voice REST client', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('extracts the server error message on a failed transcription', async () => {
    vi.stubGlobal('fetch', () => Promise.resolve({
      ok: false, status: 502, json: () => Promise.resolve({ error: 'run `codex login`' }),
    } as unknown as Response));
    await expect(transcribeVoice('t', new Uint8Array([1]))).rejects.toThrow('run `codex login`');
  });

  it('falls back to a status message when the body has no error', async () => {
    vi.stubGlobal('fetch', () => Promise.resolve({
      ok: false, status: 503, json: () => Promise.reject(new Error('no body')),
    } as unknown as Response));
    await expect(transcribeVoice('t', new Uint8Array([1]))).rejects.toThrow('503');
  });

  it('returns the catalog on success', async () => {
    vi.stubGlobal('fetch', () => Promise.resolve({
      ok: true, status: 200,
      json: () => Promise.resolve({ enabled: true, selected: 'codex', providers: [] }),
    } as unknown as Response));
    await expect(fetchVoiceProviders('t')).resolves.toEqual({ enabled: true, selected: 'codex', providers: [] });
  });
});

describe('DictationController', () => {
  const manualTimers = (): DictationTimers & { fire: () => void } => {
    let pending: (() => void) | undefined;
    return {
      set: (fn) => { pending = fn; return 1; },
      clear: () => { pending = undefined; },
      fire: () => pending?.(),
    };
  };

  const handle = (wav = new Uint8Array([1, 2])): RecordingHandle & { stopped: boolean; cancelled: boolean } => {
    const h = {
      stopped: false,
      cancelled: false,
      async stop() { h.stopped = true; return wav; },
      cancel() { h.cancelled = true; },
    };
    return h;
  };

  const observe = () => {
    const states: DictationState[] = [];
    return {
      states,
      onState: (s: DictationState) => states.push(s),
      onTranscript: vi.fn(),
      onError: vi.fn(),
    };
  };

  it('records, transcribes, and delivers the transcript', async () => {
    const o = observe();
    const rec = handle();
    const controller = new DictationController({
      startRecording: async () => rec,
      transcribe: async () => 'hello world',
      onState: o.onState, onTranscript: o.onTranscript, onError: o.onError,
    });
    await controller.start();
    expect(controller.state).toBe('recording');
    await controller.stop();
    expect(o.states).toEqual(['recording', 'transcribing', 'idle']);
    expect(o.onTranscript).toHaveBeenCalledWith('hello world');
    expect(rec.stopped).toBe(true);
    expect(o.onError).not.toHaveBeenCalled();
  });

  it('cancels without transcribing and releases the mic', async () => {
    const o = observe();
    const rec = handle();
    const transcribe = vi.fn(async () => 'unused');
    const controller = new DictationController({
      startRecording: async () => rec, transcribe,
      onState: o.onState, onTranscript: o.onTranscript, onError: o.onError,
    });
    await controller.start();
    controller.cancel();
    expect(controller.state).toBe('idle');
    expect(rec.cancelled).toBe(true);
    expect(transcribe).not.toHaveBeenCalled();
    expect(o.onTranscript).not.toHaveBeenCalled();
  });

  it('surfaces a blocked microphone and stays idle', async () => {
    const o = observe();
    const denied = Object.assign(new Error('denied'), { name: 'NotAllowedError' });
    const controller = new DictationController({
      startRecording: async () => { throw denied; },
      transcribe: async () => 'x',
      onState: o.onState, onTranscript: o.onTranscript, onError: o.onError,
    });
    await controller.start();
    expect(controller.state).toBe('idle');
    expect(o.onError).toHaveBeenCalledWith(expect.stringMatching(/[Mm]icrophone access was blocked/));
  });

  it('returns to idle and surfaces a transcription failure, preserving no partial state', async () => {
    const o = observe();
    const controller = new DictationController({
      startRecording: async () => handle(),
      transcribe: async () => { throw new Error('endpoint said boom'); },
      onState: o.onState, onTranscript: o.onTranscript, onError: o.onError,
    });
    await controller.start();
    await controller.stop();
    expect(controller.state).toBe('idle');
    expect(o.onTranscript).not.toHaveBeenCalled();
    expect(o.onError).toHaveBeenCalledWith('endpoint said boom');
  });

  it('auto-stops at the recording cap and transcribes what it captured', async () => {
    const o = observe();
    const timers = manualTimers();
    const controller = new DictationController({
      startRecording: async () => handle(),
      transcribe: async () => 'auto transcript',
      onState: o.onState, onTranscript: o.onTranscript, onError: o.onError,
      timers,
    });
    await controller.start();
    timers.fire(); // simulate the 60 s cap elapsing
    await Promise.resolve();
    await Promise.resolve();
    expect(o.onTranscript).toHaveBeenCalledWith('auto transcript');
    expect(controller.state).toBe('idle');
  });
});

describe('capture level stream', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('emits the RMS of each capture buffer to onLevel', async () => {
    let node: { onaudioprocess: ((e: unknown) => void) | null; connect: () => void; disconnect: () => void } | undefined;
    const context = {
      sampleRate: 24_000,
      destination: {},
      createMediaStreamSource: () => ({ connect() {}, disconnect() {} }),
      createScriptProcessor: () => {
        node = { onaudioprocess: null, connect() {}, disconnect() {} };
        return node;
      },
      close: () => Promise.resolve(),
    };
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: { getUserMedia: () => Promise.resolve({ getTracks: () => [{ stop() {} }] }) },
    });
    vi.stubGlobal('AudioContext', function AudioContextMock() { return context; });

    const levels: number[] = [];
    await startRecording((level) => levels.push(level));
    const emit = (data: number[]) =>
      node?.onaudioprocess?.({ inputBuffer: { getChannelData: () => new Float32Array(data) } });

    emit([0.5, 0.5, 0.5, 0.5]); // RMS = 0.5
    emit([0, 0, 0, 0]); // silence
    emit([2, 2]); // clamped to 1
    expect(levels).toEqual([0.5, 0, 1]);
  });
});

describe('DictationSession', () => {
  const noopTimers: DictationTimers = { set: () => 0, clear: () => {} };
  const fakeStart: StartRecording = async () => ({
    async stop() { return new Uint8Array([1, 2]); },
    cancel() {},
  });

  const makeSession = (
    transcribe: (wav: Uint8Array) => Promise<string>,
    startRecording?: StartRecording,
  ) => {
    let takes: DictationTake[] = [];
    const session = new DictationSession({
      transcribe,
      startRecording: startRecording ?? fakeStart,
      onChange: (next) => { takes = next; },
      timers: noopTimers,
      now: () => 0,
    });
    return { session, takes: () => takes };
  };

  const record = async (session: DictationSession): Promise<void> => {
    await session.startTake();
    await session.addTake();
  };

  it('runs uploads strictly serially in take order', async () => {
    const d1 = deferred<string>();
    const d2 = deferred<string>();
    const calls: number[] = [];
    let n = 0;
    const transcribe = vi.fn(async () => { n += 1; calls.push(n); return n === 1 ? d1.promise : d2.promise; });
    const { session, takes } = makeSession(transcribe);

    await record(session);
    await record(session);
    expect(transcribe).toHaveBeenCalledTimes(1); // second upload must wait

    d1.resolve('first');
    await flush();
    expect(transcribe).toHaveBeenCalledTimes(2);

    d2.resolve('second');
    await flush();
    expect(takes().map((t) => t.text)).toEqual(['first', 'second']);
    expect(takes().every((t) => t.state === 'done')).toBe(true);
  });

  it('allows recording a new take while an earlier one transcribes', async () => {
    const d1 = deferred<string>();
    const { session, takes } = makeSession(async () => d1.promise);
    await record(session); // take-1 transcribing
    await session.startTake(); // take-2 recording, concurrently
    expect(takes().map((t) => t.state)).toEqual(['transcribing', 'recording']);
    d1.resolve('ok');
    await flush();
  });

  it('isolates a failed take from the others', async () => {
    let n = 0;
    const transcribe = vi.fn(async () => {
      n += 1;
      if (n === 1) throw new Error('provider boom');
      return 'good';
    });
    const { session, takes } = makeSession(transcribe);
    await record(session);
    await flush();
    await record(session);
    await flush();
    expect(takes()[0]).toMatchObject({ state: 'failed', error: 'provider boom' });
    expect(takes()[1]).toMatchObject({ state: 'done', text: 'good' });
  });

  it('marks an empty transcript as a failed take, never a silent segment', async () => {
    const { session, takes } = makeSession(async () => '   ');
    await record(session);
    await flush();
    expect(takes()[0]).toMatchObject({ state: 'failed', error: 'Nothing was transcribed' });
  });

  it('sendWhenReady waits for stragglers then resolves done texts in order', async () => {
    const d1 = deferred<string>();
    const d2 = deferred<string>();
    let n = 0;
    const { session } = makeSession(async () => { n += 1; return n === 1 ? d1.promise : d2.promise; });
    await record(session);
    await record(session);
    const sent = session.sendWhenReady();
    d2.resolve('beta'); // resolve out of order — result order still follows take order
    d1.resolve('alpha');
    await expect(sent).resolves.toEqual(['alpha', 'beta']);
  });

  it('discardAll posts nothing and ignores late results', async () => {
    const d1 = deferred<string>();
    const { session, takes } = makeSession(async () => d1.promise);
    await record(session);
    session.discardAll();
    const sent = session.sendWhenReady();
    await expect(sent).rejects.toThrow(/No dictation/);
    d1.resolve('too late');
    await flush();
    expect(takes()).toEqual([]);
  });

  it('removeTake drops a transcribing take and ignores its late result', async () => {
    const d1 = deferred<string>();
    const { session, takes } = makeSession(async () => d1.promise);
    await record(session);
    const id = takes()[0]!.id;
    session.removeTake(id);
    expect(takes()).toEqual([]);
    d1.resolve('ignored');
    await flush();
    expect(takes()).toEqual([]);
  });

  it('cancelTake discards the in-progress recording without transcribing', async () => {
    const transcribe = vi.fn(async () => 'unused');
    const { session, takes } = makeSession(transcribe);
    await session.startTake();
    session.cancelTake();
    expect(takes()).toEqual([]);
    expect(transcribe).not.toHaveBeenCalled();
  });
});
