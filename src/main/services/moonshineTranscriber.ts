/**
 * Moonshine ONNX Transcriber
 *
 * Provides on-device transcription using Moonshine Base model via onnxruntime-node.
 * Cross-platform: same ONNX model files work on macOS and Windows.
 *
 * Architecture:
 * - Loads encoder + merged decoder ONNX models (HuggingFace ONNX export format)
 * - Encoder: audio waveform → hidden states
 * - Decoder: autoregressive token generation with KV cache
 * - Tokenizer: BPE token IDs → text via tokenizer.json vocab
 *
 * Models are lazy-loaded on first use and cached for subsequent calls.
 * Audio preprocessing reuses the same convertToWav approach as localSttService.
 */

import * as path from 'path';
import * as fs from 'fs';
import { createScopedLogger } from '@core/logger';
import { loadNativeModule } from '@core/utils/loadNativeModule';
import { ignoreBestEffortCleanup } from '@shared/utils/intentionalSwallow';
import { localSttModelManager } from './localSttModelManager';

// Audio decoding — same dependency as localSttService
import decode from 'audio-decode';

const log = createScopedLogger({ service: 'MoonshineTranscriber' });

// ─── ONNX Runtime Loading ────────────────────────────────────────────────────

// Lazy-loaded ONNX runtime reference
let ort: typeof import('onnxruntime-common') | null = null;

function getOrt(): typeof import('onnxruntime-common') {
  if (!ort) {
    try {
      ort = loadNativeModule<typeof import('onnxruntime-common')>('onnxruntime-node');
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      log.error({ err: message }, 'Failed to load onnxruntime-node native module');
      throw new Error(
        'Moonshine transcription is not available — onnxruntime-node failed to load. ' +
        'Please try using OpenAI Whisper or ElevenLabs instead.'
      );
    }
  }
  return ort;
}

// ─── Model State (lazy-loaded) ───────────────────────────────────────────────

interface ModelState {
  encoderSession: import('onnxruntime-common').InferenceSession;
  decoderSession: import('onnxruntime-common').InferenceSession;
  tokenVocab: Map<number, string>;
  decoderType: 'byte_level' | 'sentencepiece';
  decoderStartTokenId: number;
  eosTokenId: number;
  numLayers: number;
  numKvHeads: number;
  headDim: number;
  modelPath: string;
}

let modelState: ModelState | null = null;
let loadingPromise: Promise<ModelState> | null = null;

/**
 * Count of in-flight SESSION USES. Incremented the moment a caller ACQUIRES
 * `modelState` (i.e. when `ensureModelsLoaded()` returns it to a transcription)
 * and decremented only after that caller's `generate()` has fully completed —
 * NOT just the `generate()` window. This is the correct serialization unit: a
 * transcription owns the sessions from acquisition, through the `audioToFloat32()`
 * preprocessing await, into `generate()`. Counting only `generate()` would let a
 * `dispose()` observe zero in-flight, release the sessions, and then have the
 * waiting transcription enter `generate()` on a released session (the
 * `audioToFloat32()` window the Stage-4 review flagged, F1).
 *
 * `dispose()` waits (bounded) for this to reach 0 before releasing —
 * `InferenceSession.release()` REJECTS the in-flight `run()` it tears down
 * (lossy, though not a crash). See the ORT release spike,
 * `docs/plans/260622_teardown-lifecycle-contract/subagent_reports/260622_spike-ort-release.md`.
 */
let inFlightUseCount = 0;

/**
 * TRANSIENT lifecycle state for `dispose()` — NOT a permanent terminal flag.
 *
 * `disposing` is true only while a `dispose()` is in progress; it is cleared in
 * `dispose()`'s `finally`, so the service is fully usable again afterwards. The
 * restartability this gives (a later `ensureModelsLoaded()` reloads cleanly
 * because `modelState` is null) is exactly what makes wiring `dispose()` into the
 * shared `shutdownInternal()` safe on NON-exit paths — workspace rename /
 * services-only restart dispose moonshine and then the app keeps running and can
 * transcribe again (Stage-4 review F2). Idempotency comes from state, not a flag:
 * a second `dispose()` while one is in flight awaits the same `disposingPromise`;
 * a `dispose()` when nothing is loaded is a no-op; and per-session `release()` is
 * null-guarded so double-release never happens.
 */
let disposing = false;

/**
 * The in-flight `dispose()` promise, so concurrent `dispose()` calls and the
 * admission gate (`waitForDisposeToFinish`) can await the SAME disposal rather
 * than starting a second one or racing it.
 */
let disposingPromise: Promise<void> | null = null;

/**
 * Live count of in-MAIN-process onnxruntime InferenceSessions held by moonshine.
 *
 * Zero when no model is loaded (`modelState === null`); otherwise 2 — the
 * encoder + decoder sessions are loaded together in `ModelState`. These ORT
 * sessions own native runtime threads and run in the MAIN process (unlike the
 * embedding CPU/GPU paths, which are out-of-process), and nothing currently
 * disposes them at shutdown — making them a prime `Worker::JoinThread` suspect
 * for the residual macOS quit-deadlock. Synchronous, allocation-free read for
 * the native-liveness snapshot (see `nativeLivenessSnapshot.ts`).
 */
export function getMoonshineLiveSessionCount(): number {
  return modelState ? 2 : 0;
}

/**
 * Maximum time `dispose()` waits for an in-flight transcription to finish
 * before releasing underneath it. Kept WELL inside the shutdown roster's
 * per-service budget (`SERVICE_CLEANUP_TIMEOUT_MS = 3000` in
 * `gracefulShutdown.ts`) so this wait + the (fast, ones-of-ms) release cannot
 * exceed the service budget — the roster's `Promise.race` is the hard ceiling
 * regardless.
 */
const DISPOSE_INFLIGHT_WAIT_MS = 2000;
const DISPOSE_INFLIGHT_POLL_MS = 50;

/**
 * Admission gate: if a `dispose()` is in flight, await it so new work (a load or
 * a transcription) does not start UNDER an in-progress disposal — which would
 * race the release of `modelState` (Stage-4 review F1). Returns once no dispose
 * is in flight. After it resolves the caller proceeds on a clean state
 * (`modelState === null`, `disposing === false`), so the work RESTARTS rather
 * than racing — this is what makes the services-only / workspace-rename path
 * safe (F2): dispose, then transcribe again.
 */
async function waitForDisposeToFinish(): Promise<void> {
  // Loop in case a new dispose begins between iterations (defensive; dispose is
  // only triggered at shutdown / services-only, so this is at most one wait).
  while (disposing && disposingPromise) {
    try {
      await disposingPromise;
    } catch {
      // dispose() never rejects (fail-open), but be defensive: a settled
      // disposingPromise is enough to know disposal finished.
    }
  }
}

/**
 * Bounded, fail-open disposal of the 2 in-MAIN ORT InferenceSessions. Wired into
 * `gracefulShutdown.ts`'s `shutdownInternal()` (PLAN.md Stage 4) — which runs on
 * the normal-quit path AND on restartable, services-only paths (workspace
 * rename, services-only restart). `InferenceSession.release()` joins each
 * session's per-session ORT threadpool synchronously — the exact
 * `Worker::JoinThread` that otherwise hangs N-API env teardown at quit — so
 * doing it early, on a healthy event loop, prevents the macOS quit-deadlock
 * class (REBEL-6AM). The external watchdog stays the residual floor if a thread
 * is genuinely wedged mid-op past budget.
 *
 * STATE-BASED + RESTARTABLE — there is NO permanent terminal flag:
 * - **Idempotent / restartable via state.** `disposing` is transient (cleared in
 *   `finally`); after release `modelState` is null, so a later
 *   `ensureModelsLoaded()` reloads cleanly. A second `dispose()` while one is in
 *   flight awaits the same `disposingPromise`. A `dispose()` when nothing is
 *   loaded is a no-op. This is what makes the services-only / workspace-rename
 *   path safe — the app keeps running and can transcribe again afterwards (F2).
 * - **Await an in-flight load** so we never leak a just-created session that
 *   isn't yet in `modelState` (and so `getMoonshineLiveSessionCount()` reads
 *   reflect reality).
 * - **Wait-then-release** for an in-flight session USE (bounded). The use count
 *   brackets the FULL window (acquisition → `generate()` complete), not just
 *   `generate()`, so we cannot release under a transcription that is mid-
 *   preprocessing (F1). Releasing under a live `run()` REJECTS it (lossy); if the
 *   wait budget expires we release anyway (shutdown wins; the watchdog is floor).
 * - **Double-release guard via null-check** (NOT a permanent flag): we null
 *   `modelState` before releasing and release the local `state`; a second
 *   `dispose()` sees `modelState === null` and no-ops, so `release()` is never
 *   called twice on the same session.
 * - **Fail-open**: a release error is logged, never thrown out of the roster.
 *
 * NOTE on bounding (Stage-4 review F3): `await session.release()` evaluates the
 * SYNCHRONOUS native dispose before the await yields, so a wedged native join is
 * NOT bounded by the per-service `Promise.race` in `cleanupService` — the
 * external watchdog is the real floor for that case. The in-flight-use wait and
 * the await-load step ARE bounded; the synchronous native release is not.
 */
export async function dispose(): Promise<void> {
  // Idempotent via state: if a dispose is already in flight, join it.
  if (disposing && disposingPromise) {
    return disposingPromise;
  }

  disposing = true;
  disposingPromise = doDispose().finally(() => {
    disposing = false;
    disposingPromise = null;
  });
  return disposingPromise;
}

async function doDispose(): Promise<void> {
  // Await an in-flight model load before deciding what to release — `modelState`
  // is only assigned after both sessions resolve, so a mid-load dispose could
  // otherwise leak the just-created sessions.
  if (loadingPromise) {
    try {
      await loadingPromise;
    } catch (error) {
      // Load failed → nothing was assigned to modelState; nothing to release.
      ignoreBestEffortCleanup(error, {
        operation: 'moonshineTranscriber.dispose.awaitInFlightLoad',
        reason: 'in-flight model load failed; modelState was never assigned, so there is nothing to release',
      });
    }
  }

  const state = modelState;
  if (!state) {
    // Nothing loaded → safe no-op. `disposing` is cleared in dispose()'s finally,
    // so the service stays usable.
    return;
  }

  // Wait (bounded) for any in-flight session use (acquisition → generate complete)
  // to finish so we don't release underneath a live transcription.
  if (inFlightUseCount > 0) {
    const waitStart = Date.now();
    log.info({ inFlightUseCount }, 'Waiting for in-flight Moonshine transcription before releasing sessions');
    while (inFlightUseCount > 0 && Date.now() - waitStart < DISPOSE_INFLIGHT_WAIT_MS) {
      await new Promise((resolve) => setTimeout(resolve, DISPOSE_INFLIGHT_POLL_MS));
    }
    if (inFlightUseCount > 0) {
      log.warn(
        { inFlightUseCount, waitedMs: Date.now() - waitStart },
        'In-flight Moonshine transcription did not finish before budget; releasing anyway (will reject it)',
      );
    }
  }

  // Clear refs FIRST so a concurrent dispose() no-ops (null-check guards
  // double-release) and a late transcription request reloads fresh sessions
  // rather than racing the release of these.
  modelState = null;

  // Release both sessions, fail-open per session (release() can throw).
  for (const [label, session] of [
    ['encoder', state.encoderSession],
    ['decoder', state.decoderSession],
  ] as const) {
    try {
      await session.release();
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      log.warn({ err: message, session: label }, 'Failed to release Moonshine ONNX session during dispose');
    }
  }

  log.info('Moonshine ONNX sessions disposed');
}

// ─── Model Loading ───────────────────────────────────────────────────────────

/**
 * Load Moonshine ONNX models from disk (lazy, cached, coalesced).
 * Called automatically on first transcription request.
 * Concurrent callers share the same loading promise.
 */
async function ensureModelsLoaded(): Promise<ModelState> {
  // NOTE: the admission gate (await any in-flight dispose) lives in the CALLER
  // (`transcribeWithMoonshine`), reserved synchronously alongside the
  // `inFlightUseCount++`. It is NOT repeated here on purpose: this runs INSIDE
  // the use window, where `dispose()` is already waiting on `inFlightUseCount`,
  // so awaiting dispose here would deadlock (dispose waits for the use to finish;
  // the use waits for dispose). `transcribeWithMoonshine` is the only caller.
  const modelPath = localSttModelManager.getModelPath('moonshine-base');

  // Return cached state if path hasn't changed
  if (modelState && modelState.modelPath === modelPath) {
    return modelState;
  }

  // Coalesce concurrent load requests
  if (loadingPromise) {
    return loadingPromise;
  }

  loadingPromise = doLoadModels(modelPath).finally(() => {
    loadingPromise = null;
  });

  return loadingPromise;
}

async function doLoadModels(modelPath: string): Promise<ModelState> {

  const runtime = getOrt();
  const startTime = Date.now();

  log.info({ modelPath }, 'Loading Moonshine ONNX models');

  // Load model config
  const configPath = path.join(modelPath, 'config.json');
  if (!fs.existsSync(configPath)) {
    throw new Error(`Moonshine config.json not found at ${configPath}`);
  }
  const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));

  // Extract model dimensions from config
  // Moonshine config uses various keys depending on version
  const numLayers = config.decoder?.num_hidden_layers
    ?? config.num_decoder_layers
    ?? config.num_hidden_layers
    ?? 8;
  const numKvHeads = config.decoder?.num_key_value_heads
    ?? config.num_key_value_heads
    ?? 8;
  const headDim = config.decoder?.head_dim
    ?? config.head_dim
    ?? Math.floor((config.decoder?.hidden_size ?? config.hidden_size ?? 416) / (config.decoder?.num_attention_heads ?? config.num_attention_heads ?? 8));
  const decoderStartTokenId = config.decoder_start_token_id ?? 1;
  const eosTokenId = config.eos_token_id ?? 2;

  log.debug(
    { numLayers, numKvHeads, headDim, decoderStartTokenId, eosTokenId },
    'Moonshine model config loaded'
  );

  // Load tokenizer
  const tokenizerPath = path.join(modelPath, 'tokenizer.json');
  if (!fs.existsSync(tokenizerPath)) {
    throw new Error(`Moonshine tokenizer.json not found at ${tokenizerPath}`);
  }
  const { vocab, decoderType } = loadTokenizer(tokenizerPath);

  // Load ONNX sessions
  const encoderPath = path.join(modelPath, 'encoder_model.onnx');
  const decoderPath = path.join(modelPath, 'decoder_model_merged.onnx');

  if (!fs.existsSync(encoderPath)) {
    throw new Error(`Moonshine encoder not found at ${encoderPath}`);
  }
  if (!fs.existsSync(decoderPath)) {
    throw new Error(`Moonshine decoder not found at ${decoderPath}`);
  }

  const sessionOptions: import('onnxruntime-common').InferenceSession.SessionOptions = {
    executionProviders: ['cpu'],
  };

  const [encoderSession, decoderSession] = await Promise.all([
    runtime.InferenceSession.create(encoderPath, sessionOptions),
    runtime.InferenceSession.create(decoderPath, sessionOptions),
  ]);

  const elapsed = Date.now() - startTime;
  log.info(
    { elapsed, encoderInputs: encoderSession.inputNames.length, decoderInputs: decoderSession.inputNames.length },
    'Moonshine models loaded'
  );

  modelState = {
    encoderSession,
    decoderSession,
    tokenVocab: vocab,
    decoderType,
    decoderStartTokenId,
    eosTokenId,
    numLayers,
    numKvHeads,
    headDim,
    modelPath,
  };

  return modelState;
}

// ─── Tokenizer ───────────────────────────────────────────────────────────────

function loadTokenizer(tokenizerPath: string): {
  vocab: Map<number, string>;
  decoderType: 'byte_level' | 'sentencepiece';
} {
  const data = JSON.parse(fs.readFileSync(tokenizerPath, 'utf-8'));
  const vocab = new Map<number, string>();

  // Build reverse vocab (id → token string)
  if (data.model?.vocab) {
    for (const [token, id] of Object.entries(data.model.vocab)) {
      vocab.set(id as number, token);
    }
  }

  // Also include added_tokens (special tokens like <pad>, <eos>, etc.)
  if (data.added_tokens) {
    for (const token of data.added_tokens) {
      vocab.set(token.id, token.content);
    }
  }

  // Determine decoder type
  let decoderType: 'byte_level' | 'sentencepiece' = 'sentencepiece';
  const decoderConfig = data.decoder;
  if (decoderConfig) {
    const type = decoderConfig.type?.toLowerCase() ?? '';
    if (type.includes('bytelevel') || type === 'byte_level') {
      decoderType = 'byte_level';
    } else if (decoderConfig.decoders) {
      // Check nested decoders (Sequence type)
      for (const d of decoderConfig.decoders) {
        if (d.type?.toLowerCase()?.includes('bytelevel')) {
          decoderType = 'byte_level';
          break;
        }
      }
    }
  }

  log.debug({ vocabSize: vocab.size, decoderType }, 'Tokenizer loaded');
  return { vocab, decoderType };
}

/**
 * Decode token IDs to text using the loaded tokenizer vocabulary.
 */
function decodeTokens(tokens: number[], vocab: Map<number, string>, decoderType: 'byte_level' | 'sentencepiece'): string {
  const pieces = tokens.map(id => vocab.get(id) ?? '');
  const joined = pieces.join('');

  if (decoderType === 'byte_level') {
    return decodeByteLevelBpe(joined);
  }
  // SentencePiece style: ▁ = space
  return joined.replace(/▁/g, ' ').trim();
}

/**
 * ByteLevel BPE decoder (GPT-2 style):
 * Maps special unicode characters back to their original bytes, then decodes as UTF-8.
 */
function decodeByteLevelBpe(text: string): string {
  const unicodeToByte = buildUnicodeToByte();
  const bytes: number[] = [];

  for (const char of text) {
    const codePoint = char.codePointAt(0);
    const byte = codePoint !== undefined ? unicodeToByte.get(codePoint) : undefined;
    if (byte !== undefined) {
      bytes.push(byte);
    } else {
      // Not a byte-level encoded character — encode as UTF-8
      const encoded = new TextEncoder().encode(char);
      for (const b of encoded) bytes.push(b);
    }
  }

  return new TextDecoder('utf-8', { fatal: false }).decode(new Uint8Array(bytes));
}

/**
 * Build the unicode codepoint → byte reverse mapping used by ByteLevel BPE.
 */
function buildUnicodeToByte(): Map<number, number> {
  const map = new Map<number, number>();
  // Printable ASCII + extended
  const directRanges = [[33, 126], [161, 172], [174, 255]];
  const directSet = new Set<number>();

  for (const [start, end] of directRanges) {
    for (let i = start; i <= end; i++) {
      directSet.add(i);
      map.set(i, i); // Direct mapping: codepoint === byte
    }
  }

  // Bytes that don't map directly get shifted to 256+
  let offset = 0;
  for (let b = 0; b < 256; b++) {
    if (!directSet.has(b)) {
      map.set(256 + offset, b);
      offset++;
    }
  }

  return map;
}

// ─── Audio Preprocessing ─────────────────────────────────────────────────────

/**
 * Convert an audio buffer to 16kHz mono Float32Array.
 * Handles WAV, OGG, MP3, and other formats supported by audio-decode.
 */
async function audioToFloat32(audioBuffer: Buffer): Promise<Float32Array> {
  const audioData = await decode(audioBuffer);

  // Mix to mono if needed
  let mono: Float32Array;
  if (audioData.numberOfChannels === 1) {
    mono = audioData.getChannelData(0);
  } else {
    const ch0 = audioData.getChannelData(0);
    const ch1 = audioData.getChannelData(1);
    mono = new Float32Array(ch0.length);
    for (let i = 0; i < ch0.length; i++) {
      mono[i] = (ch0[i] + ch1[i]) / 2;
    }
  }

  // Resample to 16kHz if needed
  if (audioData.sampleRate !== 16000) {
    return resample(mono, audioData.sampleRate, 16000);
  }

  return mono;
}

/**
 * Linear interpolation resampling (same algorithm as localSttService).
 */
function resample(input: Float32Array, fromRate: number, toRate: number): Float32Array {
  const ratio = fromRate / toRate;
  const outputLength = Math.round(input.length / ratio);
  const output = new Float32Array(outputLength);

  for (let i = 0; i < outputLength; i++) {
    const srcIndex = i * ratio;
    const srcIndexFloor = Math.floor(srcIndex);
    const srcIndexCeil = Math.min(srcIndexFloor + 1, input.length - 1);
    const fraction = srcIndex - srcIndexFloor;
    output[i] = input[srcIndexFloor] * (1 - fraction) + input[srcIndexCeil] * fraction;
  }

  return output;
}

// ─── ONNX Inference ──────────────────────────────────────────────────────────

/**
 * Run the full encoder → decoder pipeline and return generated token IDs.
 */
async function generate(
  audioSamples: Float32Array,
  state: ModelState
): Promise<number[]> {
  const runtime = getOrt();
  const { encoderSession, decoderSession, decoderStartTokenId, eosTokenId, numLayers, numKvHeads, headDim } = state;

  // ── Encoder pass ───────────────────────────────────────────────────────
  const encoderInput = new runtime.Tensor('float32', audioSamples, [1, audioSamples.length]);
  const encoderOutput = await encoderSession.run({ input_values: encoderInput });
  const encoderHiddenStates = encoderOutput.last_hidden_state;

  if (!encoderHiddenStates) {
    throw new Error('Encoder did not produce last_hidden_state output');
  }

  // ── Decoder loop (autoregressive) ──────────────────────────────────────
  // Maximum tokens: ~6 tokens per second of audio, with a minimum of 50
  const audioDurationSec = audioSamples.length / 16000;
  const maxTokens = Math.max(50, Math.ceil(audioDurationSec * 6));

  const generatedTokens: number[] = [];

  // Initialize empty KV cache for all layers
  let pastKeyValues: Record<string, import('onnxruntime-common').Tensor> = {};
  for (let layer = 0; layer < numLayers; layer++) {
    for (const scope of ['decoder', 'encoder']) {
      for (const kind of ['key', 'value']) {
        const name = `past_key_values.${layer}.${scope}.${kind}`;
        pastKeyValues[name] = new runtime.Tensor(
          'float32',
          new Float32Array(0),
          [1, numKvHeads, 0, headDim]
        );
      }
    }
  }

  // Validate KV cache naming by checking decoder's expected inputs
  const decoderInputSet = new Set(decoderSession.inputNames);
  const samplePastKey = `past_key_values.0.decoder.key`;
  if (!decoderInputSet.has(samplePastKey)) {
    log.warn(
      { expected: samplePastKey, decoderInputs: decoderSession.inputNames },
      'Decoder input names do not match expected KV cache naming convention — inference may fail'
    );
  }

  for (let step = 0; step < maxTokens; step++) {
    const tokenId = step === 0 ? decoderStartTokenId : generatedTokens[generatedTokens.length - 1];

    const feeds: Record<string, import('onnxruntime-common').Tensor> = {
      input_ids: new runtime.Tensor('int64', BigInt64Array.from([BigInt(tokenId)]), [1, 1]),
      encoder_hidden_states: encoderHiddenStates as import('onnxruntime-common').Tensor,
      use_cache_branch: new runtime.Tensor('bool', [step > 0]),
      ...pastKeyValues,
    };

    const output = await decoderSession.run(feeds);

    // Extract logits and find argmax (greedy decoding)
    const logits = output.logits;
    if (!logits) {
      throw new Error('Decoder did not produce logits output');
    }

    const logitsData = logits.data as Float32Array;
    const vocabSize = logits.dims[logits.dims.length - 1];
    // Take the last token's logits (last vocabSize elements)
    const offset = logitsData.length - vocabSize;

    let maxIdx = 0;
    let maxVal = logitsData[offset];
    for (let i = 1; i < vocabSize; i++) {
      if (logitsData[offset + i] > maxVal) {
        maxVal = logitsData[offset + i];
        maxIdx = i;
      }
    }

    // Check for end of sequence
    if (maxIdx === eosTokenId) break;

    // Repetition guard: stop if same token repeats 3+ times consecutively
    if (generatedTokens.length >= 2 &&
        maxIdx === generatedTokens[generatedTokens.length - 1] &&
        maxIdx === generatedTokens[generatedTokens.length - 2]) {
      log.warn({ repeatedToken: maxIdx, step }, 'Repetition detected, stopping generation');
      break;
    }

    generatedTokens.push(maxIdx);

    // Update KV cache from decoder outputs
    const newPastKeyValues: Record<string, import('onnxruntime-common').Tensor> = {};
    for (const key of Object.keys(output)) {
      if (key.startsWith('present')) {
        // Map present_key_values.X.Y.Z → past_key_values.X.Y.Z
        const pastKey = key.replace(/^present/, 'past_key_values');
        newPastKeyValues[pastKey] = output[key] as import('onnxruntime-common').Tensor;
      }
    }
    pastKeyValues = newPastKeyValues;
  }

  return generatedTokens;
}

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Transcribe audio using the Moonshine ONNX model.
 * Models are lazy-loaded on first call.
 *
 * @param audioBuffer Raw audio data
 * @param mimeType Audio MIME type (e.g., 'audio/wav')
 * @returns Transcription result with text
 */
export async function transcribeWithMoonshine(
  audioBuffer: Buffer,
  mimeType: string
): Promise<{ text: string }> {
  const startTime = Date.now();

  log.info(
    { mimeType, bufferSize: audioBuffer.length, platform: process.platform },
    'Moonshine transcription requested'
  );

  // Check if model is installed
  const status = await localSttModelManager.getStatus('moonshine-base');
  if (!status.installed) {
    throw new Error(
      'Moonshine model not installed. Please download it in Settings → Agents & Voice → Voice & Audio.'
    );
  }

  // WebM is not supported by audio-decode — must be converted in renderer first
  if (mimeType.includes('webm')) {
    throw new Error(
      'WebM audio format is not supported by local transcription. ' +
      'Please ensure the renderer converts audio to WAV format.'
    );
  }

  // ── Admission gate + full session-use window (Stage-4 review F1) ──────────
  // Wait out any in-flight dispose, then RESERVE the use window (increment)
  // BEFORE doing any work (load / preprocess / generate). Two invariants make
  // this race-free:
  //   1. The final `disposing` check and the `inFlightUseCount++` are
  //      synchronous-adjacent (no await between them), so a dispose cannot start
  //      in that gap and release underneath us.
  //   2. The window brackets the LOAD too, so a dispose racing a mid-load (which
  //      awaits `loadingPromise`) still sees `inFlightUseCount > 0` afterwards and
  //      waits — closing the microtask-ordering race the use-after-`generate()`
  //      bracket alone left open.
  // dispose() waits (bounded) for this count to reach 0 before releasing —
  // releasing under a live run REJECTS it (lossy). Loop in case a new dispose
  // begins while we awaited the previous one.
  while (disposing) {
    await waitForDisposeToFinish();
  }
  inFlightUseCount++;
  try {
    // Load models (lazy, cached after first call) — inside the use window.
    const state = await ensureModelsLoaded();

    // Convert audio to 16kHz mono Float32
    let audioSamples: Float32Array;
    try {
      audioSamples = await audioToFloat32(audioBuffer);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      log.error({ err: message, mimeType }, 'Audio preprocessing failed');
      throw new Error(`Failed to preprocess audio: ${message}`);
    }

    log.debug(
      { samples: audioSamples.length, durationSec: (audioSamples.length / 16000).toFixed(1) },
      'Audio preprocessed'
    );

    // Run inference. The session use is tracked across this whole block so a
    // shutdown dispose() waits for it before releasing the sessions (release
    // underneath a live run rejects it — lossy). See dispose() above.
    const tokens = await generate(audioSamples, state);

    // Decode tokens to text
    const text = decodeTokens(tokens, state.tokenVocab, state.decoderType);

    const durationMs = Date.now() - startTime;
    log.info(
      { durationMs, textLength: text.length, tokenCount: tokens.length },
      'Moonshine transcription completed'
    );

    return { text };
  } finally {
    inFlightUseCount--;
  }
}
