/**
 * Tests for the STATE-BASED, RESTARTABLE Moonshine ONNX `dispose()` lifecycle
 * (PLAN.md Stage 4 + Phase-6 Stage-4-review refinement,
 * docs/plans/260622_teardown-lifecycle-contract/).
 *
 * Verifies the spike-mandated guards AND the Stage-4-review fixes:
 *   - releases both sessions; getMoonshineLiveSessionCount() === 0 after disposal
 *   - double-dispose is a safe no-op (null-check guard, NOT a permanent flag)
 *   - waits for an in-flight run before releasing; awaits an in-flight load
 *   - F4: dispose during the audioToFloat32() / use window does NOT release
 *     mid-use; load/transcribe attempted WHILE disposing waits cleanly (admission
 *     gate); reload-after-dispose works (restartable — services-only path)
 *   - fail-open: a release error is swallowed (never thrown out of the roster)
 *
 * The real ORT native binding is mocked — we drive the public load path
 * (`transcribeWithMoonshine`) with a fake InferenceSession so `modelState` is
 * populated, then exercise `dispose()`. The fake REJECTS run()/release() after
 * release (matching real ORT "Session already disposed.", per the spike) so the
 * tests catch use-after-release rather than silently passing on a stale mock.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ── Fake ORT InferenceSession ────────────────────────────────────────────────

/**
 * Tracks release() calls, throws on double-release, and (matching real ORT, per
 * the spike) REJECTS run()/release() once released — so a test that releases
 * underneath a live run will surface the lossy "Session already disposed." path
 * instead of passing on a stale fake.
 */
class FakeSession {
  released = 0;
  isReleased = false;
  releaseError: Error | null = null;
  // Decoder needs a KV-cache-shaped input name so the warn path is quiet.
  inputNames = ['input_ids', 'past_key_values.0.decoder.key'];

  constructor(public readonly kind: 'encoder' | 'decoder') {}

  async run(_feeds: Record<string, unknown>): Promise<Record<string, unknown>> {
    if (this.isReleased) {
      throw new Error('Session already disposed.');
    }
    if (this.kind === 'encoder') {
      return { last_hidden_state: { data: new Float32Array(4), dims: [1, 1, 4] } };
    }
    // Decoder: return logits whose argmax is the eosTokenId (2) so the
    // autoregressive loop breaks on the very first step.
    const logits = new Float32Array(8).fill(0);
    logits[2] = 100; // argmax → token 2 (eos)
    return { logits: { data: logits, dims: [1, 1, 8] } };
  }

  async release(): Promise<void> {
    this.released++;
    if (this.isReleased) {
      // Real ORT throws on a double-release; our null-check guard should prevent
      // dispose() from ever reaching here twice.
      throw new Error('Session already disposed.');
    }
    this.isReleased = true;
    if (this.releaseError) {
      throw this.releaseError;
    }
  }
}

let encoderSession: FakeSession;
let decoderSession: FakeSession;

const createMock = vi.fn(async (modelPath: string) =>
  modelPath.includes('encoder') ? encoderSession : decoderSession,
);

class FakeTensor {
  constructor(
    public readonly type: string,
    public readonly data: unknown,
    public readonly dims: number[],
  ) {}
}

const fakeOrt = {
  InferenceSession: { create: createMock },
  Tensor: FakeTensor,
};

vi.mock('@core/utils/loadNativeModule', () => ({
  loadNativeModule: vi.fn(() => fakeOrt),
}));

vi.mock('../localSttModelManager', () => ({
  localSttModelManager: {
    getModelPath: vi.fn(() => '/fake/moonshine-base'),
    getStatus: vi.fn(async () => ({ installed: true })),
  },
}));

vi.mock('audio-decode', () => ({
  default: vi.fn(async () => ({
    numberOfChannels: 1,
    sampleRate: 16000,
    getChannelData: () => new Float32Array(1600),
  })),
}));

const config = JSON.stringify({
  num_hidden_layers: 1,
  num_key_value_heads: 1,
  head_dim: 4,
  decoder_start_token_id: 1,
  eos_token_id: 2,
});
const tokenizer = JSON.stringify({
  model: { vocab: { hello: 5 } },
  added_tokens: [{ id: 2, content: '<eos>' }],
  decoder: { type: 'sentencepiece' },
});

vi.mock('fs', () => ({
  existsSync: vi.fn(() => true),
  readFileSync: vi.fn((p: string) => (p.includes('tokenizer') ? tokenizer : config)),
}));

vi.mock('@core/logger', () => ({
  createScopedLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
  }),
}));

// ── Helpers ────────────────────────────────────────────────────────────────

async function freshModule() {
  vi.resetModules();
  encoderSession = new FakeSession('encoder');
  decoderSession = new FakeSession('decoder');
  createMock.mockClear();
  createMock.mockImplementation(async (modelPath: string) =>
    modelPath.includes('encoder') ? encoderSession : decoderSession,
  );
  return import('../moonshineTranscriber');
}

async function loadSessions(mod: typeof import('../moonshineTranscriber')) {
  // Drives ensureModelsLoaded() via the public transcribe path.
  await mod.transcribeWithMoonshine(Buffer.from('fake-wav'), 'audio/wav');
}

describe('moonshineTranscriber.dispose', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.resetModules();
  });

  it('releases both sessions and reports 0 live sessions after disposal', async () => {
    const mod = await freshModule();
    await loadSessions(mod);
    expect(mod.getMoonshineLiveSessionCount()).toBe(2);

    await mod.dispose();

    expect(encoderSession.released).toBe(1);
    expect(decoderSession.released).toBe(1);
    expect(mod.getMoonshineLiveSessionCount()).toBe(0);
  });

  it('is a safe no-op on double-dispose (does not throw, does not re-release)', async () => {
    const mod = await freshModule();
    await loadSessions(mod);

    await mod.dispose();
    await expect(mod.dispose()).resolves.toBeUndefined();

    // Second dispose sees modelState === null (null-check guard, not a permanent
    // flag) → release() not called again.
    expect(encoderSession.released).toBe(1);
    expect(decoderSession.released).toBe(1);
  });

  it('is restartable: a transcription after dispose() reloads fresh sessions and works (services-only path)', async () => {
    const mod = await freshModule();
    await loadSessions(mod);
    const firstEncoder = encoderSession;

    await mod.dispose();
    expect(mod.getMoonshineLiveSessionCount()).toBe(0);
    expect(firstEncoder.isReleased).toBe(true);

    // Swap in fresh fake sessions for the reload — the disposed ones reject run().
    encoderSession = new FakeSession('encoder');
    decoderSession = new FakeSession('decoder');
    createMock.mockImplementation(async (modelPath: string) =>
      modelPath.includes('encoder') ? encoderSession : decoderSession,
    );

    // A later transcription must reload cleanly (no permanent terminal flag).
    const result = await mod.transcribeWithMoonshine(Buffer.from('fake-wav'), 'audio/wav');
    expect(typeof result.text).toBe('string');
    expect(mod.getMoonshineLiveSessionCount()).toBe(2);
    // The reload used the NEW sessions, not the released ones.
    expect(encoderSession).not.toBe(firstEncoder);
    expect(encoderSession.isReleased).toBe(false);
  });

  it('does NOT release mid-use: a dispose racing the audioToFloat32() window waits for the use to finish', async () => {
    const mod = await freshModule();
    await loadSessions(mod); // first load populates modelState

    // Gate audio preprocessing so a transcription is parked AFTER acquiring
    // modelState (inFlightUseCount incremented) but BEFORE generate() — the exact
    // window the Stage-4 review (F1) flagged.
    let releasePreprocess: () => void = () => undefined;
    const preprocessGate = new Promise<void>((resolve) => {
      releasePreprocess = resolve;
    });
    const decodeMock = (await import('audio-decode')).default as unknown as ReturnType<typeof vi.fn>;
    decodeMock.mockImplementationOnce(async () => {
      await preprocessGate;
      return {
        numberOfChannels: 1,
        sampleRate: 16000,
        getChannelData: () => new Float32Array(1600),
      };
    });

    const inFlight = mod.transcribeWithMoonshine(Buffer.from('fake-wav'), 'audio/wav');
    // Yield so the transcription acquires state + increments inFlightUseCount,
    // then parks in audioToFloat32().
    await new Promise((r) => setTimeout(r, 0));

    const disposePromise = mod.dispose();
    // dispose() must wait — the session is in use (mid-preprocess), not released.
    await new Promise((r) => setTimeout(r, 10));
    expect(decoderSession.released).toBe(0);
    expect(encoderSession.released).toBe(0);

    // Let preprocessing + generate() finish, then dispose releases cleanly.
    releasePreprocess();
    await expect(inFlight).resolves.toBeDefined();
    await disposePromise;

    expect(encoderSession.released).toBe(1);
    expect(decoderSession.released).toBe(1);
  });

  it('admission gate: a transcription started WHILE disposing waits for dispose then reloads (no leak, no unhandled rejection)', async () => {
    const mod = await freshModule();
    await loadSessions(mod);
    const firstEncoder = encoderSession;

    // Gate the FIRST session's release so dispose() is parked mid-disposal.
    let releaseRelease: () => void = () => undefined;
    const releaseGate = new Promise<void>((resolve) => {
      releaseRelease = resolve;
    });
    const originalRelease = encoderSession.release.bind(encoderSession);
    encoderSession.release = vi.fn(async () => {
      await releaseGate;
      return originalRelease();
    });

    const disposePromise = mod.dispose();
    // Let dispose reach the gated release.
    await new Promise((r) => setTimeout(r, 0));

    // Prepare fresh sessions for the reload the admission-gated transcription does.
    const reloadEncoder = new FakeSession('encoder');
    const reloadDecoder = new FakeSession('decoder');
    createMock.mockClear(); // forget the first load's calls so we can assert the gate holds
    createMock.mockImplementation(async (modelPath: string) =>
      modelPath.includes('encoder') ? reloadEncoder : reloadDecoder,
    );

    // Start a transcription WHILE dispose is in flight — the admission gate must
    // make it wait for dispose to finish, not race the release of modelState.
    const racing = mod.transcribeWithMoonshine(Buffer.from('fake-wav'), 'audio/wav');
    await new Promise((r) => setTimeout(r, 10));
    // It must NOT have started a load yet (still waiting on the in-flight dispose).
    expect(createMock).not.toHaveBeenCalled();

    // Finish the dispose; the racing transcription then proceeds on a clean reload.
    releaseRelease();
    await disposePromise;
    await expect(racing).resolves.toBeDefined();

    // The racing transcription reloaded fresh sessions — it did NOT use the
    // released ones (no use-after-release).
    expect(firstEncoder.isReleased).toBe(true);
    expect(mod.getMoonshineLiveSessionCount()).toBe(2);
  });

  it('no-ops when nothing was ever loaded', async () => {
    const mod = await freshModule();
    await expect(mod.dispose()).resolves.toBeUndefined();
    expect(createMock).not.toHaveBeenCalled();
    expect(mod.getMoonshineLiveSessionCount()).toBe(0);
  });

  it('fails open when a session release() throws (does not propagate)', async () => {
    const mod = await freshModule();
    await loadSessions(mod);
    encoderSession.releaseError = new Error('native release blew up');

    await expect(mod.dispose()).resolves.toBeUndefined();
    // Decoder still released despite the encoder error; live count reflects 0.
    expect(decoderSession.released).toBe(1);
    expect(mod.getMoonshineLiveSessionCount()).toBe(0);
  });

  it('waits for an in-flight transcription before releasing (does not release underneath a live run)', async () => {
    const mod = await freshModule();
    await loadSessions(mod);

    // Make the decoder run hang until we let it resolve, simulating an in-flight run.
    let releaseRun: () => void = () => undefined;
    const runGate = new Promise<void>((resolve) => {
      releaseRun = resolve;
    });
    const originalRun = decoderSession.run.bind(decoderSession);
    decoderSession.run = vi.fn(async (feeds: Record<string, unknown>) => {
      await runGate;
      return originalRun(feeds);
    });

    // Start a second transcription that will block in the decoder.
    const inFlight = mod.transcribeWithMoonshine(Buffer.from('fake-wav'), 'audio/wav');
    // Yield so the in-flight run reaches the gate and increments the counter.
    await new Promise((r) => setTimeout(r, 0));

    const disposePromise = mod.dispose();
    // dispose() must NOT have released yet — it's waiting for the in-flight run.
    await new Promise((r) => setTimeout(r, 10));
    expect(decoderSession.released).toBe(0);

    // Let the in-flight run finish, then dispose should proceed to release.
    releaseRun();
    await inFlight;
    await disposePromise;

    expect(decoderSession.released).toBe(1);
    expect(encoderSession.released).toBe(1);
  });

  it('awaits an in-flight model load before releasing (no leaked session)', async () => {
    const mod = await freshModule();

    // Gate the decoder session creation so a load is mid-flight when dispose runs.
    let releaseCreate: () => void = () => undefined;
    const createGate = new Promise<void>((resolve) => {
      releaseCreate = resolve;
    });
    createMock.mockImplementation(async (modelPath: string) => {
      if (modelPath.includes('decoder')) {
        await createGate;
      }
      return modelPath.includes('encoder') ? encoderSession : decoderSession;
    });

    // Start a transcription that stalls during model load.
    const loading = mod.transcribeWithMoonshine(Buffer.from('fake-wav'), 'audio/wav');
    await new Promise((r) => setTimeout(r, 0));

    const disposePromise = mod.dispose();
    await new Promise((r) => setTimeout(r, 10));
    // Load not finished → modelState not yet set → nothing released yet.
    expect(encoderSession.released).toBe(0);

    // Finish the load, then both dispose + the load-driven transcription settle.
    releaseCreate();
    await loading;
    await disposePromise;

    // dispose awaited the load and then released the now-loaded sessions.
    expect(encoderSession.released).toBe(1);
    expect(decoderSession.released).toBe(1);
    expect(mod.getMoonshineLiveSessionCount()).toBe(0);
  });
});
