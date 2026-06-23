/**
 * Local Speech-to-Text Service
 *
 * Provides on-device transcription using platform-specific backends:
 * - macOS: FluidAudio CLI with Parakeet V3 CoreML model
 * - Windows: sherpa-onnx-node with ONNX Runtime
 *
 * Architecture:
 * - macOS: Spawns FluidAudio CLI as a subprocess, parses stdout for result
 * - Windows: Uses sherpa-onnx-node native module with async offline recognition
 * - Both: Converts audio to WAV format using pure JavaScript (no ffmpeg dependency)
 */

import { spawn, type ChildProcess } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { createScopedLogger } from '@core/logger';
import { isPackaged, getAppRoot } from '@core/utils/dataPaths';
import { loadNativeModule } from '@core/utils/loadNativeModule';
import { localSttModelManager, reportLocalSttError } from './localSttModelManager';

// Audio conversion - pure JavaScript, no ffmpeg needed
import decode from 'audio-decode';
// @ts-expect-error - wav-encoder doesn't have types
import * as wavEncoder from 'wav-encoder';

const log = createScopedLogger({ service: 'LocalSttService' });
const FLUID_AUDIO_INITIAL_TIMEOUT_MS = 120_000;
const FLUID_AUDIO_RETRY_TIMEOUT_MS = 240_000;
const FLUID_AUDIO_PROGRESS_LOG_INTERVAL_MS = 30_000;

/**
 * Get path to FluidAudio CLI binary
 * 
 * In development: Uses locally built CLI from tmp/parakeet-cli-test/
 * In production: CLI is bundled via forge.config.cjs packageAfterCopy hook
 * 
 * The CLI binary is a universal macOS binary (arm64 + x64) stored at:
 * - Source: resources/local-stt/fluidaudiocli-darwin
 * - Destination: process.resourcesPath/fluidaudiocli
 * 
 * The binary is automatically signed during the afterSign hook for notarization.
 */
const getCliPath = (): string => {
  if (isPackaged()) {
    // In packaged app, the CLI is in Resources directory
    const cliPath = path.join(process.resourcesPath, 'fluidaudiocli');
    if (!fs.existsSync(cliPath)) {
      // This shouldn't happen if forge.config.cjs is set up correctly
      throw new Error(
        'Local transcription CLI not found. The FluidAudio CLI may not have been bundled correctly.'
      );
    }
    return cliPath;
  } else {
    // In development, prefer locally built CLI, fall back to pre-built binary in resources
    const devCliPath = path.join(
      getAppRoot(),
      'tmp/parakeet-cli-test/FluidAudio/.build/arm64-apple-macosx/debug/fluidaudiocli'
    );
    if (fs.existsSync(devCliPath)) {
      return devCliPath;
    }
    const resourceCliPath = path.join(getAppRoot(), 'resources/local-stt/fluidaudiocli-darwin');
    if (fs.existsSync(resourceCliPath)) {
      return resourceCliPath;
    }
    throw new Error(
      'FluidAudio CLI not found for development. ' +
      'Build it with: cd tmp/parakeet-cli-test/FluidAudio && swift build'
    );
  }
};

interface TranscriptionResult {
  text: string;
  durationMs: number;
  confidence?: number;
}

/**
 * Check if buffer is already a WAV file by checking RIFF header
 */
function isWavBuffer(buffer: Buffer): boolean {
  if (buffer.length < 12) return false;
  // Check for RIFF....WAVE header
  return (
    buffer[0] === 0x52 && // R
    buffer[1] === 0x49 && // I
    buffer[2] === 0x46 && // F
    buffer[3] === 0x46 && // F
    buffer[8] === 0x57 && // W
    buffer[9] === 0x41 && // A
    buffer[10] === 0x56 && // V
    buffer[11] === 0x45    // E
  );
}

/**
 * Convert audio buffer to 16kHz mono WAV format using pure JavaScript
 * No ffmpeg dependency required!
 * 
 * If input is already WAV (from renderer-side conversion for local-parakeet),
 * we skip re-encoding and just write it to disk.
 * 
 * IMPORTANT: The audio-decode library does NOT support WebM container format.
 * WebM audio must be converted to WAV in the renderer before reaching here.
 */
async function convertToWav(audioBuffer: Buffer, mimeType: string): Promise<string> {
  const tmpDir = os.tmpdir();
  const outputPath = path.join(tmpDir, `rebel-stt-output-${Date.now()}.wav`);

  log.debug(
    { mimeType, bufferSize: audioBuffer.length, isWav: isWavBuffer(audioBuffer) },
    'convertToWav called'
  );

  // Fast path: if input is already WAV (from renderer conversion), just write it directly
  // This avoids double-conversion when renderer already converted WebM->WAV for local-parakeet
  if (mimeType === 'audio/wav' || mimeType.includes('wav') || isWavBuffer(audioBuffer)) {
    log.debug({ mimeType }, 'Input is already WAV, skipping conversion');
    await fs.promises.writeFile(outputPath, audioBuffer);
    return outputPath;
  }

  // WebM is NOT supported by audio-decode library - provide a clear error
  if (mimeType.includes('webm')) {
    log.error(
      { mimeType },
      'WebM audio format not supported by local transcription. ' +
      'Audio should be converted to WAV in the renderer before reaching here.'
    );
    throw new Error(
      'WebM audio format is not supported by local transcription. ' +
      'Please ensure the renderer converts audio to WAV format, or switch to a cloud provider.'
    );
  }

  try {
    log.debug({ mimeType }, 'Attempting to decode audio with audio-decode library');
    // Decode the input audio (supports OGG, MP3, WAV, etc. but NOT WebM)
    // Note: WebM should be converted to WAV in the renderer before reaching here
    const audioData = await decode(audioBuffer);
    log.debug(
      { sampleRate: audioData.sampleRate, channels: audioData.numberOfChannels, duration: audioData.duration },
      'Audio decoded successfully'
    );

    // Get channel data and convert to mono if needed
    let monoData: Float32Array;
    if (audioData.numberOfChannels === 1) {
      monoData = audioData.getChannelData(0);
    } else {
      // Mix down to mono by averaging channels
      const channel0 = audioData.getChannelData(0);
      const channel1 = audioData.getChannelData(1);
      monoData = new Float32Array(channel0.length);
      for (let i = 0; i < channel0.length; i++) {
        monoData[i] = (channel0[i] + channel1[i]) / 2;
      }
    }

    // Resample to 16kHz if needed
    const targetSampleRate = 16000;
    let resampledData: Float32Array;
    if (audioData.sampleRate !== targetSampleRate) {
      resampledData = resample(monoData, audioData.sampleRate, targetSampleRate);
    } else {
      resampledData = monoData;
    }

    // Encode as 16-bit PCM WAV
    const wavBuffer = await wavEncoder.encode({
      sampleRate: targetSampleRate,
      channelData: [resampledData],
    });

    // Write to file
    await fs.promises.writeFile(outputPath, Buffer.from(wavBuffer));

    return outputPath;
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    log.error({ err: message, mimeType }, 'Audio conversion failed');
    throw new Error(`Failed to convert audio: ${message}`);
  }
}

/**
 * Simple linear resampling
 * For production, consider using a higher-quality resampling algorithm
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

    // Linear interpolation
    output[i] = input[srcIndexFloor] * (1 - fraction) + input[srcIndexCeil] * fraction;
  }

  return output;
}

/**
 * Transcribe audio using platform-specific backend
 * - macOS: FluidAudio CLI with CoreML
 * - Windows: sherpa-onnx-node with ONNX Runtime
 */
export async function transcribeWithLocalModel(
  audioBuffer: Buffer,
  mimeType: string
): Promise<TranscriptionResult> {
  const startTime = Date.now();

  log.info(
    { mimeType, bufferSize: audioBuffer.length, platform: process.platform },
    'Local transcription requested'
  );

  // Check if model is installed
  const status = await localSttModelManager.getStatus();
  log.debug({ status }, 'Model status check');
  if (!status.installed) {
    log.warn({ status }, 'Local transcription model not installed');
    throw new Error(
      'Local transcription model not installed. Please download it in Settings → Agents & Voice → Voice & Audio.'
    );
  }

  // Platform-specific transcription
  if (process.platform === 'darwin') {
    return transcribeWithCoreMl(audioBuffer, mimeType, startTime);
  } else if (process.platform === 'win32') {
    return transcribeWithSherpaOnnx(audioBuffer, mimeType, startTime);
  } else {
    log.error({ platform: process.platform }, 'Unsupported platform for local transcription');
    throw new Error(`Local transcription not supported on ${process.platform}`);
  }
}

/**
 * The bundled fluidaudiocli binary was compiled with a macOS 14.0 (Sonoma) deployment
 * target. On older macOS versions the dynamic linker aborts with "Symbol not found"
 * from libswiftCore.dylib — a fatal renderer-process crash (Sentry REBEL-W, 282 events).
 *
 * Darwin kernel major version = macOS version + 9 (e.g. Darwin 23 = macOS 14).
 */
const FLUIDAUDIO_MIN_DARWIN_MAJOR = 23; // macOS 14.0

/**
 * Exported for unit testing; not intended as a public API.
 * @param darwinRelease - override for `os.release()` in tests
 */
export function checkMacOSCompatibility(darwinRelease?: string): void {
  if (process.platform !== 'darwin') return;
  const release = darwinRelease ?? os.release();
  const darwinMajor = parseInt(release.split('.')[0], 10);
  if (!isNaN(darwinMajor) && darwinMajor < FLUIDAUDIO_MIN_DARWIN_MAJOR) {
    const macOSMajor = darwinMajor - 9;
    // TODO(REBEL-W follow-up): Lower or remove this gate when fluidaudiocli
    // is rebuilt with a macOS 13+ deployment target.
    throw new Error(
      `Local transcription requires macOS 14 (Sonoma) or later. ` +
      `You're running macOS ${macOSMajor}. ` +
      `Please try using OpenAI Whisper or ElevenLabs in Settings \u2192 Agents & Voice \u2192 Voice & Audio.`
    );
  }
}

/**
 * macOS transcription using FluidAudio CLI with CoreML
 */
async function transcribeWithCoreMl(
  audioBuffer: Buffer,
  mimeType: string,
  startTime: number
): Promise<TranscriptionResult> {
  checkMacOSCompatibility();

  // Get CLI path
  let cliPath: string;
  try {
    cliPath = getCliPath();
  } catch (err: unknown) {
    log.error({ err: err instanceof Error ? err.message : String(err) }, 'Failed to get CLI path');
    throw err;
  }

  // Verify CLI exists and is executable
  if (!fs.existsSync(cliPath)) {
    throw new Error(`FluidAudio CLI not found at ${cliPath}`);
  }

  // Convert audio to WAV
  let wavPath: string;
  try {
    wavPath = await convertToWav(audioBuffer, mimeType);
    log.debug({ wavPath }, 'Converted audio to WAV');
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    log.error({ err: message }, 'Audio conversion failed');
    throw new Error(`Failed to convert audio: ${message}`);
  }

  try {
    // Run FluidAudio CLI
    const result = await runFluidAudioCli(cliPath, wavPath);
    const durationMs = Date.now() - startTime;

    log.info(
      { durationMs, textLength: result.text.length },
      'Local transcription completed (CoreML)'
    );

    return {
      text: result.text,
      durationMs,
      confidence: result.confidence,
    };
  } finally {
    // Clean up WAV file
    try {
      await fs.promises.unlink(wavPath);
    } catch {
      // Ignore cleanup errors
    }
  }
}

/**
 * Run the FluidAudio CLI and parse output.
 *
 * Emits structured Sentry telemetry on every terminal failure mode (spawn error,
 * non-zero exit, timeout) so users like [external-email] don't have to report
 * failures manually. Captures are additive: logging remains in place, and no
 * control-flow changes to the existing reject paths.
 *
 * `stderrTail` is capped at 500 chars. fluidaudiocli's stderr contains diagnostic
 * messages (model paths, CoreML compilation status, HuggingFace download
 * progress when the model is misplaced) — none of these include auth tokens or
 * user content, but we cap defensively in case future CLI versions log
 * something sensitive.
 *
 * Exported for unit testing of failure-mode telemetry; not intended as a
 * public API.
 */
export function runFluidAudioCli(
  cliPath: string,
  wavPath: string
): Promise<{ text: string; confidence?: number }> {
  return runFluidAudioCliWithRetry(cliPath, wavPath);
}

class FluidAudioTimeoutError extends Error {
  constructor(
    timeoutMs: number,
    readonly elapsedMs: number,
    readonly stderrTail: string,
    readonly attempt: number,
  ) {
    super(`Transcription timed out after ${Math.round(timeoutMs / 1000)} seconds`);
    this.name = 'FluidAudioTimeoutError';
  }
}

async function runFluidAudioCliWithRetry(
  cliPath: string,
  wavPath: string,
): Promise<{ text: string; confidence?: number }> {
  try {
    return await runFluidAudioCliAttempt({
      cliPath,
      wavPath,
      attempt: 1,
      timeoutMs: FLUID_AUDIO_INITIAL_TIMEOUT_MS,
      reportTimeout: false,
    });
  } catch (err) {
    if (!(err instanceof FluidAudioTimeoutError)) {
      throw err;
    }

    log.warn(
      { attempt: err.attempt, elapsedMs: err.elapsedMs, nextTimeoutMs: FLUID_AUDIO_RETRY_TIMEOUT_MS },
      'FluidAudio CLI timed out; retrying once with a longer timeout',
    );

    return runFluidAudioCliAttempt({
      cliPath,
      wavPath,
      attempt: 2,
      timeoutMs: FLUID_AUDIO_RETRY_TIMEOUT_MS,
      reportTimeout: true,
    });
  }
}

function runFluidAudioCliAttempt(args: {
  cliPath: string;
  wavPath: string;
  attempt: number;
  timeoutMs: number;
  reportTimeout: boolean;
}): Promise<{ text: string; confidence?: number }> {
  const { cliPath, wavPath, attempt, timeoutMs, reportTimeout } = args;
  const cliStartedAt = Date.now();
  // Capture modelPath once per invocation (not per event) — even if the model
  // manager path resolution throws in some future refactor, failing to capture
  // telemetry must never change control flow.
  let modelPath: string | undefined;
  try {
    modelPath = localSttModelManager.getModelPath();
  } catch {
    modelPath = undefined;
  }
  return new Promise((resolve, reject) => {
    let proc: ChildProcess | null = null;
    let timeoutId: ReturnType<typeof setTimeout> | null = null;
    let progressIntervalId: ReturnType<typeof setInterval> | null = null;
    let settled = false;

    const cleanup = () => {
      if (timeoutId) {
        clearTimeout(timeoutId);
        timeoutId = null;
      }
      if (progressIntervalId) {
        clearInterval(progressIntervalId);
        progressIntervalId = null;
      }
    };

    const settle = (resolver: () => void) => {
      if (!settled) {
        settled = true;
        cleanup();
        resolver();
      }
    };

    const cliDir = path.dirname(cliPath);
    log.info({ attempt, timeoutMs, cliPath }, 'Starting FluidAudio CLI transcription');
    proc = spawn(cliPath, ['transcribe', wavPath], {
      windowsHide: true,
      env: {
        ...process.env,
        // In dev mode, ESpeakNG.framework lives next to the CLI in resources/local-stt/.
        // In packaged builds RPATH already resolves it, so this is a harmless no-op.
        DYLD_FRAMEWORK_PATH: [cliDir, process.env.DYLD_FRAMEWORK_PATH]
          .filter(Boolean)
          .join(':'),
      },
    });

    let stdout = '';
    let stderr = '';

    proc.stdout?.on('data', (data) => {
      stdout += data.toString();
    });

    proc.stderr?.on('data', (data) => {
      stderr += data.toString();
    });

    proc.on('close', (code) => {
      settle(() => {
        if (code !== 0) {
          const stderrTail = stderr.slice(-500);
          log.error({ attempt, code, stderr: stderr.slice(-1000) }, 'FluidAudio CLI failed');
          reportLocalSttError(
            new Error(`FluidAudio CLI exited with code ${code}`),
            'cli-exit-nonzero',
            {
              modelPath,
              cliPath,
              elapsedMs: Date.now() - cliStartedAt,
              attempt,
              exitCode: code,
              stderrTail,
            }
          );
          reject(new Error(`Transcription failed (code ${code}): ${stderrTail}`));
          return;
        }

        // Parse the output - the transcription is on the last non-empty line of stdout
        const lines = stdout.trim().split('\n');
        const text = lines[lines.length - 1]?.trim() || '';

        if (!text) {
          log.warn({ stdout, stderr }, 'Empty transcription result');
        }

        // Try to extract confidence from stderr logs
        let confidence: number | undefined;
        const confidenceMatch = stderr.match(/Confidence:\s*([\d.]+)/);
        if (confidenceMatch) {
          confidence = parseFloat(confidenceMatch[1]);
        }

        log.info(
          { attempt, elapsedMs: Date.now() - cliStartedAt, textLength: text.length },
          'FluidAudio CLI transcription completed',
        );
        resolve({ text, confidence });
      });
    });

    proc.on('error', (err) => {
      settle(() => {
        log.error({ err: err.message }, 'Failed to spawn FluidAudio CLI');
        reportLocalSttError(err, 'cli-spawn-error', {
          modelPath,
          cliPath,
          elapsedMs: Date.now() - cliStartedAt,
          attempt,
          stderrTail: stderr.slice(-500),
        });
        reject(new Error(`Failed to start transcription: ${err.message}`));
      });
    });

    // Set a timeout generous enough to cover CoreML first-compilation on slower
    // hardware. The first transcription after app start compiles the .mlmodelc
    // files (~10–15 s on older Apple Silicon, longer under memory pressure);
    // subsequent calls are <1 s. Local models can still take longer on first
    // run under load, so the first attempt gets 120 s and the retry gets 240 s.
    progressIntervalId = setInterval(() => {
      log.info(
        { attempt, elapsedMs: Date.now() - cliStartedAt, timeoutMs, stderrTail: stderr.slice(-500) },
        'FluidAudio CLI transcription still running',
      );
    }, FLUID_AUDIO_PROGRESS_LOG_INTERVAL_MS);
    progressIntervalId.unref?.();

    timeoutId = setTimeout(() => {
      settle(() => {
        proc?.kill();
        const elapsedMs = Date.now() - cliStartedAt;
        const stderrTail = stderr.slice(-500);
        const timeoutErr = new FluidAudioTimeoutError(timeoutMs, elapsedMs, stderrTail, attempt);
        log.warn({ attempt, elapsedMs, timeoutMs, stderrTail }, 'FluidAudio CLI transcription timed out');
        if (reportTimeout) {
          reportLocalSttError(timeoutErr, 'cli-timeout', {
            modelPath,
            cliPath,
            elapsedMs,
            attempt,
            stderrTail,
          });
        }
        reject(timeoutErr);
      });
    }, timeoutMs);
    timeoutId.unref?.();
  });
}

/**
 * Windows transcription using sherpa-onnx-node with ONNX Runtime
 */
interface SherpaWaveData {
  samples: Float32Array;
  sampleRate: number;
}

interface SherpaRecognizerStream {
  acceptWaveform(input: SherpaWaveData): void;
}

interface SherpaRecognizer {
  createStream(): SherpaRecognizerStream;
  decodeAsync(stream: SherpaRecognizerStream): Promise<{ text?: string }>;
}

interface SherpaOnnxModule {
  OfflineRecognizer: {
    createAsync(config: unknown): Promise<SherpaRecognizer>;
  };
  readWave(wavPath: string, disableExternalV8Buffers: boolean): SherpaWaveData;
}

async function transcribeWithSherpaOnnx(
  audioBuffer: Buffer,
  mimeType: string,
  startTime: number
): Promise<TranscriptionResult> {
  // Convert audio to WAV first
  let wavPath: string;
  try {
    wavPath = await convertToWav(audioBuffer, mimeType);
    log.debug({ wavPath }, 'Converted audio to WAV for sherpa-onnx');
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    log.error({ err: message }, 'Audio conversion failed');
    throw new Error(`Failed to convert audio: ${message}`);
  }

  try {
    // Load sherpa-onnx-node (only available on Windows) via the shared
    // loadNativeModule helper (handles dev vs packaged asar.unpacked resolution).
    // NOTE: In dev mode, Windows Smart App Control may block the unsigned .node binary.
    // See docs/plans/260317_fox2829_windows_local_stt_investigation.md for workaround.
    let sherpa: SherpaOnnxModule;
    try {
      sherpa = loadNativeModule<SherpaOnnxModule>('sherpa-onnx-node');
    } catch (importErr: unknown) {
      log.error({ err: importErr instanceof Error ? importErr.message : String(importErr) }, 'Failed to load sherpa-onnx-node native module');
      throw new Error(
        'Local transcription is not available on this system. ' +
        'The sherpa-onnx native module failed to load. ' +
        'Please try using OpenAI Whisper or ElevenLabs instead.'
      );
    }
    
    const modelPath = localSttModelManager.getModelPath();
    
    // Create offline recognizer config
    const config = {
      featConfig: {
        sampleRate: 16000,
        featureDim: 80,
      },
      modelConfig: {
        transducer: {
          encoder: path.join(modelPath, 'encoder.int8.onnx'),
          decoder: path.join(modelPath, 'decoder.int8.onnx'),
          joiner: path.join(modelPath, 'joiner.int8.onnx'),
        },
        tokens: path.join(modelPath, 'tokens.txt'),
        numThreads: 4,
        debug: false,
      },
      decodingMethod: 'greedy_search',
    };

    // Create recognizer asynchronously (avoids blocking main thread during init)
    const recognizer = await sherpa.OfflineRecognizer.createAsync(config);
    
    // Read WAV file (false = disable external V8 buffers, which crash in Electron)
    const waveData = sherpa.readWave(wavPath, false);
    const stream = recognizer.createStream();
    // acceptWaveform takes a single object {samples, sampleRate}
    stream.acceptWaveform({ samples: waveData.samples, sampleRate: waveData.sampleRate });
    
    // Decode asynchronously (decodeAsync returns result directly, no getResult needed)
    const result = await recognizer.decodeAsync(stream);

    const durationMs = Date.now() - startTime;
    const text = result.text?.trim() || '';

    log.info(
      { durationMs, textLength: text.length },
      'Local transcription completed (sherpa-onnx)'
    );

    return {
      text,
      durationMs,
    };
  } finally {
    // Clean up WAV file
    try {
      await fs.promises.unlink(wavPath);
    } catch {
      // Ignore cleanup errors
    }
  }
}

/**
 * Check if the model is ready for transcription
 */
export async function isModelReady(modelId?: string): Promise<boolean> {
  const status = await localSttModelManager.getStatus(modelId);
  return status.installed;
}
