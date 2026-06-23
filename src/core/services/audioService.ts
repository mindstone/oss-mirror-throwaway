import axios from 'axios';
import FormData from 'form-data';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  getActiveVoiceProfile,
  type AppSettings,
  type VoiceTranscriptionPayload,
  type TtsWithTimestampsResponse,
  type VoiceErrorCategory,
} from '@shared/types';
import { createScopedLogger } from '@core/logger';
import { getErrorReporter } from '@core/errorReporter';
import { getSettings } from '@core/services/settingsStore';
import { redactSensitiveData } from '../utils/logRedaction';
import { getProviderKey } from '@shared/utils/providerKeys';
import { isLocalProvider } from '@shared/utils/voiceProviderUtils';
import { appendCostEntry } from '@core/services/costLedgerService';
import { getTracker } from '@core/tracking';
import { calculateSttCost } from '@shared/utils/sttPricingCalculator';
import { getPrompt, PROMPT_IDS } from '@core/services/promptFileService';
import {
  chunkAudioFile,
  isChunkingRequired,
  checkFfmpegAvailable as coreCheckFfmpegAvailable,
  MAX_FILE_SIZE_BYTES,
  TARGET_CHUNK_SIZE_BYTES,
  type ChunkResult,
} from '@core/services/audioChunking';
import type { CodexVoiceConfig } from './codexVoiceTypes';

const log = createScopedLogger({ service: 'audio' });

// Track auth errors already captured to Sentry this session (max 1 per provider+status).
// Prevents quota flooding from expired API keys while maintaining visibility (REBEL-ZJ).
const capturedAuthErrors = new Set<string>();

function isHttpAuthErrorStatus(status: number | undefined): status is 401 | 403 {
  return status === 401 || status === 403;
}

function captureAuthErrorOnce(provider: string, status: number, operation: string): void {
  const key = `${provider}:${status}:${operation}`;
  if (capturedAuthErrors.has(key)) return;
  capturedAuthErrors.add(key);
  getErrorReporter().captureException(
    new Error('Voice auth error — credentials may be invalid or expired'),
    {
      level: 'warning',
      tags: {
        area: 'voice',
        component: 'audio-service',
        operation,
        provider,
        condition: 'voice_auth_error',
      },
      fingerprint: ['voice-auth-error', provider, operation, String(status)],
      extra: { responseStatus: status, note: 'Session-capped: first occurrence only' },
    }
  );
}

// Allowlist of response header keys that are safe to echo back to Sentry. We
// intentionally avoid anything that could carry session, account, or device
// identifiers (e.g. set-cookie, openai-organization, x-account-*) — keeping
// only protocol-level diagnostics that help distinguish "token rejected" from
// "endpoint expects different scope/headers" without exposing user state.
const SAFE_DIAGNOSTIC_RESPONSE_HEADERS = new Set([
  'www-authenticate',
  'x-request-id',
  'cf-ray',
  'date',
  'content-type',
  'server',
]);

const capturedAuthDiagnostics = new Set<string>();

function pickSafeResponseHeaders(headers: Record<string, unknown> | undefined): Record<string, string> {
  if (!headers) return {};
  const safe: Record<string, string> = {};
  for (const [rawKey, rawValue] of Object.entries(headers)) {
    const key = rawKey.toLowerCase();
    if (!SAFE_DIAGNOSTIC_RESPONSE_HEADERS.has(key)) continue;
    if (typeof rawValue === 'string') safe[key] = rawValue;
    else if (Array.isArray(rawValue)) safe[key] = rawValue.filter((v) => typeof v === 'string').join(', ');
  }
  return safe;
}

interface CodexAuthDiagnosticContext {
  status: number;
  responseHeaders?: Record<string, unknown>;
  refreshAttempted: boolean;
  refreshSucceeded: boolean;
}

/**
 * One-shot session-capped diagnostic capture for Codex transcription auth
 * failures. Intended to disambiguate "tokens are stale" from "endpoint rejects
 * fresh tokens for this account" — both surface to the user as a 401/403, but
 * the structural cause (and the fix) is different. Body is intentionally NOT
 * captured; only response status and a small allowlist of protocol headers.
 */
function captureCodexTranscribeAuthDiagnosticOnce(
  provider: string,
  operation: string,
  ctx: CodexAuthDiagnosticContext
): void {
  const key = `${provider}:${operation}:diag:${ctx.refreshSucceeded ? 'after-refresh' : 'pre-refresh'}:${ctx.status}`;
  if (capturedAuthDiagnostics.has(key)) return;
  capturedAuthDiagnostics.add(key);
  const headline = ctx.refreshSucceeded
    ? `Codex transcription rejected after token refresh (${ctx.status}) — endpoint accepts the OAuth tokens for other surfaces but not for transcribe`
    : `Codex transcription auth error (${ctx.status}) — token refresh ${ctx.refreshAttempted ? 'failed' : 'not attempted'}`;
  getErrorReporter().captureException(new Error(headline), {
    level: 'warning',
    tags: {
      area: 'voice',
      component: 'audio-service',
      operation,
      provider,
      codexAuthState: ctx.refreshSucceeded ? 'confirmed-after-refresh' : 'refresh-failed',
    },
    extra: {
      responseStatus: ctx.status,
      responseHeaders: pickSafeResponseHeaders(ctx.responseHeaders),
      refreshAttempted: ctx.refreshAttempted,
      refreshSucceeded: ctx.refreshSucceeded,
      note: 'Session-capped diagnostic: first occurrence only. No request/response bodies captured.',
    },
  });
}

// ---------------------------------------------------------------------------
// Local transcriber callbacks (registered by desktop bootstrap per provider)
// ---------------------------------------------------------------------------
type LocalTranscriber = (buffer: Buffer, mimeType: string) => Promise<{ text: string }>;
const _localTranscribers = new Map<string, LocalTranscriber>();
let _codexVoiceConfig: CodexVoiceConfig | null = null;

/**
 * Register a local transcriber for a specific provider.
 * Desktop bootstrap calls this to wire up platform-specific STT engines.
 */
export function registerLocalTranscriber(providerId: string, fn: LocalTranscriber): void {
  _localTranscribers.set(providerId, fn);
}

/**
 * Backwards-compatible wrapper — registers a transcriber for 'local-parakeet'.
 * @deprecated Use registerLocalTranscriber(providerId, fn) instead.
 */
export function setLocalTranscriber(fn: LocalTranscriber): void {
  registerLocalTranscriber('local-parakeet', fn);
}

/** Register Codex voice config for ChatGPT backend STT fallback. */
export function setCodexVoiceConfig(config: CodexVoiceConfig | null): void {
  _codexVoiceConfig = config;
}

// Re-export canonical constants and checkFfmpegAvailable from core audioChunking.
// These replace the previous inline implementations.
const MAX_WHISPER_FILE_SIZE = MAX_FILE_SIZE_BYTES;
const TARGET_CHUNK_SIZE = TARGET_CHUNK_SIZE_BYTES;
const checkFfmpegAvailable = coreCheckFfmpegAvailable;

// Export for testing / backward compatibility
const STT_BASE_TIMEOUT_MS = 20_000;
const TTS_TIMEOUT_MS = 15_000;

export { MAX_WHISPER_FILE_SIZE, TARGET_CHUNK_SIZE, checkFfmpegAvailable };

type OpenAiCompatibleProviderTag = 'openai-whisper' | 'custom-openai';
type OpenAiCompatibleProviderLabel = 'OpenAI' | 'Custom';

interface OpenAiCompatibleTranscriptionConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
  vocabulary?: string[];
  language?: string;
  providerTag?: OpenAiCompatibleProviderTag;
  providerLabel?: OpenAiCompatibleProviderLabel;
  /** Optional previous transcript context for Whisper prompt conditioning */
  prompt?: string;
}

const normalizeBaseUrl = (baseUrl: string): string => baseUrl.replace(/\/+$/, '');

const resolveOpenAiCompatibleProviderMeta = (
  baseUrl: string
): { providerTag: OpenAiCompatibleProviderTag; providerLabel: OpenAiCompatibleProviderLabel } => {
  if (normalizeBaseUrl(baseUrl) === 'https://api.openai.com') {
    return { providerTag: 'openai-whisper', providerLabel: 'OpenAI' };
  }
  return { providerTag: 'custom-openai', providerLabel: 'Custom' };
};

const buildOpenAiCompatibleUrl = (baseUrl: string, pathSuffix: string): string => {
  return `${normalizeBaseUrl(baseUrl)}${pathSuffix}`;
};

export class VoiceTranscriptionError extends Error {
  readonly category: VoiceErrorCategory;
  constructor(message: string, category: VoiceErrorCategory) {
    super(message);
    this.name = 'VoiceTranscriptionError';
    this.category = category;
  }
}

/**
 * Transcribe a large audio file by splitting it into chunks using core audioChunking.
 * Chunks are transcribed sequentially and joined.
 */
async function transcribeChunkedWebm({
  audio,
  mimeType,
  durationMs,
  config,
}: {
  audio: ArrayBuffer;
  mimeType: string;
  durationMs: number;
  config: OpenAiCompatibleTranscriptionConfig;
}): Promise<string> {
  if (!config.apiKey) {
    throw new Error('Voice API key is not configured. Please add your API key in Settings.');
  }

  const { providerTag, providerLabel } =
    config.providerTag && config.providerLabel
      ? { providerTag: config.providerTag, providerLabel: config.providerLabel }
      : resolveOpenAiCompatibleProviderMeta(config.baseUrl);

  // Write input audio to a temp file for core chunking
  const inputPath = path.join(os.tmpdir(), `rebel-voice-input-${randomUUID()}.webm`);
  const buffer = Buffer.from(audio);
  await fs.writeFile(inputPath, buffer);

  let chunkResult: ChunkResult | undefined;
  try {
    // Use core audioChunking module to split the file
    chunkResult = await chunkAudioFile(inputPath, { durationMs });

    log.info(
      { chunkCount: chunkResult.chunkPaths.length, audioBytes: audio.byteLength, durationMs },
      'Audio split into chunks, transcribing sequentially'
    );

    // Transcribe each chunk sequentially
    const transcripts: string[] = [];
    const safeMimeType = mimeType.split(';')[0] || mimeType;
    const extension = safeMimeType.split('/')[1] ?? 'webm';

    for (let i = 0; i < chunkResult.chunkPaths.length; i++) {
      const chunkPath = chunkResult.chunkPaths[i];
      const chunkBuffer = await fs.readFile(chunkPath);
      const chunkSizeMB = (chunkBuffer.length / (1024 * 1024)).toFixed(1);

      // Warn if chunk exceeds safe size (due to ffmpeg keyframe variance)
      if (chunkBuffer.length > MAX_WHISPER_FILE_SIZE) {
        log.warn(
          { chunk: i + 1, chunkSizeMB, maxSizeMB: MAX_WHISPER_FILE_SIZE / (1024 * 1024) },
          'Chunk exceeds max size - transcription may fail'
        );
      }

      log.info({ chunk: i + 1, total: chunkResult.chunkPaths.length, chunkSizeMB }, 'Transcribing chunk');

      // Calculate per-chunk timeout from size ratio
      const estimatedChunkDurationMs = (chunkBuffer.length / audio.byteLength) * durationMs;
      const chunkTimeoutMs = Math.max(STT_BASE_TIMEOUT_MS, Math.ceil(estimatedChunkDurationMs * 2.5));

      // Build form for this chunk
      const form = new FormData();
      form.append('file', chunkBuffer, {
        filename: `audio_chunk_${i}.${extension}`,
        contentType: safeMimeType,
      });
      form.append('model', config.model);
      form.append('prompt', buildTranscriptionPrompt(config.vocabulary, config.prompt));

      // Include language hint if specified
      if (config.language && config.language !== 'auto') {
        form.append('language', config.language);
      }

      const formBuffer = form.getBuffer();
      const formHeaders = form.getHeaders();
      formHeaders['content-length'] = String(formBuffer.length);

      try {
        const response = await axios.post(
          buildOpenAiCompatibleUrl(config.baseUrl, '/v1/audio/transcriptions'),
          formBuffer,
          {
            headers: {
              ...formHeaders,
              Authorization: `Bearer ${config.apiKey}`,
            },
            maxBodyLength: Infinity,
            maxContentLength: Infinity,
            timeout: chunkTimeoutMs,
          }
        );

        if (typeof response.data?.text === 'string') {
          transcripts.push(response.data.text.trim());
          log.info({ chunk: i + 1, transcriptLength: response.data.text.length }, 'Chunk transcription complete');
        } else {
          // Unexpected response format - fail explicitly rather than silently skip
          throw new Error(`Unexpected ${providerLabel} transcription response for chunk ${i + 1}`);
        }
      } catch (error: unknown) {
        const err = error as AxiosErrorLike;
        const responseStatus = err.response?.status;
        const isRateLimit = responseStatus === 429;
        const isAuthError = responseStatus === 401 || responseStatus === 403;

        if (isRateLimit || isAuthError) {
          log.warn(
            {
              provider: providerTag,
              responseStatus,
              retryAfter: err.response?.headers?.['retry-after'],
              chunk: i + 1,
              total: chunkResult.chunkPaths.length,
            },
            isRateLimit ? 'Chunk transcription rate-limited (429)' : 'Chunk transcription auth error — check API key'
          );
          if (isHttpAuthErrorStatus(responseStatus)) captureAuthErrorOnce(providerTag, responseStatus, 'chunked-transcription');
        } else {
          log.error(
            {
              err: sanitizeAxiosError(error),
              chunk: i + 1,
              total: chunkResult.chunkPaths.length,
              provider: providerTag,
              responseStatus,
              code: err.code,
            },
            'Chunk transcription failed'
          );

          const sanitizedError = new Error(err.message || 'Chunk transcription failed');
          sanitizedError.name = err.name || 'AxiosError';
          sanitizedError.stack = err.stack;
          getErrorReporter().captureException(sanitizedError, {
            tags: {
              area: 'voice',
              component: 'audio-service',
              operation: 'chunked-transcription',
              provider: providerTag,
            },
            extra: {
              chunk: i + 1,
              totalChunks: chunkResult.chunkPaths.length,
              chunkSizeBytes: chunkBuffer.length,
              timeoutMs: chunkTimeoutMs,
              responseStatus,
              errorCode: err.code,
            },
          });
        }

        const { message, category } = buildNetworkAwareMessage('transcription', providerLabel, chunkTimeoutMs, err);
        throw new VoiceTranscriptionError(message, category);
      }
    }

    // Join transcripts with newline for better word boundary handling
    const fullTranscript = transcripts.join('\n');
    log.info(
      { chunkCount: chunkResult.chunkPaths.length, totalLength: fullTranscript.length },
      'Chunked transcription complete'
    );

    return fullTranscript;
  } finally {
    // Clean up chunk temp files and input temp file
    await chunkResult?.cleanup();
    await fs.unlink(inputPath).catch(() => {});
  }
}

const NETWORK_ERROR_CODES = new Set(['ENOTFOUND', 'ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'EAI_AGAIN']);

// ---------------------------------------------------------------------------
// Error classification for voice transcription failures
// ---------------------------------------------------------------------------

// VoiceErrorCategory is defined in @shared/types and re-exported here for existing consumers
export type { VoiceErrorCategory } from '@shared/types';

/**
 * Structured error for voice transcription failures.
 * Carries a user-friendly message and a machine-readable category so the UI
 * can tailor recovery actions (retry, open settings, check billing, etc.).
 *
 * Only thrown from STT paths. TTS paths continue using plain Errors.
 */


/**
 * Detect OpenAI-style quota exhaustion in a 429 response body.
 * OpenAI returns `{ error: { type: "insufficient_quota" } }` when billing
 * credits are exhausted — distinct from transient rate limits.
 * ElevenLabs 429s are always transient (no quota-via-429 pattern).
 */
function detectQuotaExhausted(data: Record<string, unknown> | string | undefined): boolean {
  if (!data || typeof data !== 'object') return false;
  const d = data as Record<string, unknown>;
  if (d.type === 'insufficient_quota' || d.code === 'insufficient_quota') return true;
  if (d.type === 'insufficient_funds' || d.code === 'insufficient_funds') return true;
  const nestedError = d.error;
  if (nestedError && typeof nestedError === 'object') {
    const e = nestedError as Record<string, unknown>;
    if (e.type === 'insufficient_quota' || e.code === 'insufficient_quota') return true;
    if (e.type === 'insufficient_funds' || e.code === 'insufficient_funds') return true;
  }
  return false;
}

// Re-export for testing
export { detectQuotaExhausted };

/**
 * Sanitize Axios errors before logging to prevent leaking sensitive data.
 * Axios errors include config.headers (with Authorization) and config.data (request body).
 */
function sanitizeAxiosError(error: unknown): Record<string, unknown> {
  if (!error || typeof error !== 'object') {
    return { message: String(error) };
  }
  const err = error as Record<string, unknown>;
  return {
    message: err.message,
    name: err.name,
    code: err.code,
    // Include stack for debugging but exclude config/request which contain secrets
    stack: err.stack
  };
};

/**
 * Safely extract and redact response data for logging.
 * Provider error messages may include API keys (e.g., "Incorrect API key: sk-...")
 */
const safeResponseData = (data: unknown): string | undefined => {
  if (data === undefined || data === null) return undefined;
  const str = typeof data === 'string' ? data : JSON.stringify(data);
  return redactSensitiveData(str);
};



/**
 * Truncate text to approximately N words from the end.
 * Used to cap Whisper prompt conditioning to avoid hallucination from overly long prompts.
 */
function truncateToLastNWords(text: string, maxWords: number): string {
  const words = text.split(/\s+/).filter(Boolean);
  if (words.length <= maxWords) return text.trim();
  return words.slice(-maxWords).join(' ');
}

/**
 * Build the prompt for OpenAI transcription requests.
 * Always includes a base instruction to prevent GPT-4o transcribe models from
 * "answering" spoken questions instead of transcribing them.
 * Appends custom vocabulary terms when configured.
 * When previousTranscript is provided, appends it as context (capped at ~100 words
 * to avoid Whisper hallucination from overly long prompts).
 */
function buildTranscriptionPrompt(vocabulary?: string[], previousTranscript?: string): string {
  const basePrompt = getPrompt(PROMPT_IDS.UTILITY_TRANSCRIPTION);
  let prompt = basePrompt;
  if (vocabulary && vocabulary.length > 0) {
    prompt = `${prompt} The following terms may appear: ${vocabulary.join(', ')}.`;
  }
  if (previousTranscript && previousTranscript.trim()) {
    prompt = `${prompt}\n\nPrevious context: ${truncateToLastNWords(previousTranscript, 100)}`;
  }
  return prompt;
}

/**
 * Calculate dynamic STT timeout based on recording duration.
 * For longer recordings, we need more time for the API to process.
 * Formula: max(baseTimeout, recordingDuration * 1.5)
 */
const calculateSttTimeout = (durationMs?: number): number => {
  if (!durationMs || durationMs <= 0) {
    return STT_BASE_TIMEOUT_MS;
  }
  // Allow 2.5x the recording duration, but never less than base timeout (REBEL-18N)
  return Math.max(STT_BASE_TIMEOUT_MS, Math.ceil(durationMs * 2.5));
};

type AxiosErrorLike = {
  code?: string;
  message?: string;
  name?: string;
  stack?: string;
  response?: {
    status?: number;
    data?: unknown;
    headers?: Record<string, unknown>;
  };
};

export function buildNetworkAwareMessage(
  operation: string,
  _providerLabel: string,
  _timeoutMs: number,
  error: AxiosErrorLike
): { message: string; category: VoiceErrorCategory } {
  const code = error.code;
  const status = error.response?.status;
  const data = error.response?.data as Record<string, unknown> | string | undefined;
  const capitalOp = operation.charAt(0).toUpperCase() + operation.slice(1);

  // Timeout (ECONNABORTED) — connected but request took too long
  if (!status && code === 'ECONNABORTED') {
    return {
      message: `${capitalOp} is taking too long. Try again in a moment.`,
      category: 'temporary',
    };
  }

  // Network errors — can't reach the server
  if (!status && code && NETWORK_ERROR_CODES.has(code)) {
    return {
      message: "Couldn't reach your voice provider. Check your internet connection and try again.",
      category: 'network',
    };
  }

  // 429 — distinguish billing quota exhaustion from transient rate limits
  if (status === 429) {
    if (detectQuotaExhausted(data)) {
      return {
        message: 'Your voice provider account has run out of credits. Check your billing to continue.',
        category: 'billing',
      };
    }
    return {
      message: 'Your voice provider is busy. Give it a moment and try again.',
      category: 'temporary',
    };
  }

  // 401/403 — auth / API key issue
  if (status === 401 || status === 403) {
    return {
      message: "Your voice API key isn't working. Check it in Settings.",
      category: 'auth',
    };
  }

  // 502/503/504 — temporary provider unavailability
  if (status === 502 || status === 503 || status === 504) {
    return {
      message: `The ${operation} service is temporarily unavailable. Try again shortly.`,
      category: 'temporary',
    };
  }

  // 500 — provider-side error
  if (status === 500) {
    return {
      message: `The ${operation} service ran into a problem. Try again shortly.`,
      category: 'provider-error',
    };
  }

  // Default — unknown provider error
  return {
    message: `The ${operation} service ran into a problem. Try again shortly.`,
    category: 'provider-error',
  };
};

interface OpenAiCompatibleTranscriptionRequest extends OpenAiCompatibleTranscriptionConfig {
  audio: ArrayBuffer;
  mimeType: string;
  timeout: number;
}

async function transcribeWithOpenAiCompatible({
  audio,
  mimeType,
  baseUrl,
  apiKey,
  model,
  vocabulary,
  language,
  timeout,
  providerTag,
  providerLabel,
  prompt: previousTranscript,
}: OpenAiCompatibleTranscriptionRequest): Promise<string> {
  const providerMeta =
    providerTag && providerLabel
      ? { providerTag, providerLabel }
      : resolveOpenAiCompatibleProviderMeta(baseUrl);
  const resolvedProviderTag = providerMeta.providerTag;
  const resolvedProviderLabel = providerMeta.providerLabel;
  const buffer = Buffer.from(audio);
  const safeMimeType = mimeType.split(';')[0] || mimeType;
  const extension = safeMimeType.split('/')[1] ?? 'webm';
  const form = new FormData();

  form.append('file', buffer, {
    filename: `audio.${extension}`,
    contentType: safeMimeType,
  });
  form.append('model', model);
  form.append('prompt', buildTranscriptionPrompt(vocabulary, previousTranscript));

  if (language && language !== 'auto') {
    form.append('language', language);
    log.debug({ language }, `Including language hint in ${resolvedProviderLabel} transcription request`);
  }

  const formBuffer = form.getBuffer();
  const formHeaders = form.getHeaders();
  formHeaders['content-length'] = String(formBuffer.length);

  let response;
  try {
    response = await axios.post(buildOpenAiCompatibleUrl(baseUrl, '/v1/audio/transcriptions'), formBuffer, {
      headers: {
        ...formHeaders,
        Authorization: `Bearer ${apiKey}`,
      },
      maxBodyLength: Infinity,
      maxContentLength: Infinity,
      timeout,
    });
  } catch (error: unknown) {
    const err = error as AxiosErrorLike;
    const responseStatus = err.response?.status;
    const isRateLimit = responseStatus === 429;
    const isAuthError = responseStatus === 401 || responseStatus === 403;

    if (isRateLimit || isAuthError) {
      // 429/401/403 are expected user-environment errors — log only, don't flood Sentry (REBEL-R0, REBEL-ZK)
      log.warn(
        {
          provider: resolvedProviderTag,
          responseStatus,
          retryAfter: err.response?.headers?.['retry-after'],
          audioBytes: audio.byteLength,
        },
        isRateLimit ? `${resolvedProviderLabel} transcription rate-limited (429)` : `${resolvedProviderLabel} transcription auth error — check API key`
      );
      if (isHttpAuthErrorStatus(responseStatus)) captureAuthErrorOnce(resolvedProviderTag, responseStatus, 'transcription');
    } else {
      log.error(
        {
          err: sanitizeAxiosError(error),
          provider: resolvedProviderTag,
          timeoutMs: timeout,
          responseStatus,
          responseData: safeResponseData(err.response?.data),
          code: err.code,
        },
        `${resolvedProviderLabel} transcription API error`
      );

      // Capture sanitized error to Sentry (avoid leaking API keys in error.config)
      const sanitizedError = new Error(err.message || `${resolvedProviderLabel} transcription failed`);
      sanitizedError.name = err.name || 'AxiosError';
      sanitizedError.stack = err.stack;
      getErrorReporter().captureException(sanitizedError, {
        tags: {
          area: 'voice',
          component: 'audio-service',
          operation: 'transcription',
          provider: resolvedProviderTag,
        },
        extra: {
          timeoutMs: timeout,
          audioBytes: audio.byteLength,
          responseStatus,
          errorCode: err.code,
        },
      });
    }

    const { message, category } = buildNetworkAwareMessage('transcription', resolvedProviderLabel, timeout, err);
    throw new VoiceTranscriptionError(message, category);
  }

  if (typeof response.data?.text !== 'string') {
    throw new VoiceTranscriptionError(`Unexpected ${resolvedProviderLabel} transcription response.`, 'provider-error');
  }

  return response.data.text.trim();
}

async function transcribeWithCodexBackend({
  audio,
  mimeType,
  timeout,
  config,
}: {
  audio: ArrayBuffer;
  mimeType: string;
  timeout: number;
  config: CodexVoiceConfig;
}): Promise<string> {
  const accessToken = await config.getAccessToken();
  if (!accessToken) {
    throw new VoiceTranscriptionError(
      'Your ChatGPT connection needs to be refreshed. Try disconnecting and reconnecting in Settings.',
      'auth'
    );
  }

  const buffer = Buffer.from(audio);
  const safeMimeType = mimeType.split(';')[0] || mimeType;
  const extension = safeMimeType.split('/')[1] ?? 'webm';
  const provider = 'openai-whisper-codex';

  const postTranscription = async (token: string) => {
    const form = new FormData();
    form.append('file', buffer, {
      filename: `audio.${extension}`,
      contentType: safeMimeType,
    });

    const formBuffer = form.getBuffer();
    const headers: Record<string, string> = {
      ...form.getHeaders(),
      Authorization: `Bearer ${token}`,
      'content-length': String(formBuffer.length),
    };

    const accountId = config.getAccountId();
    if (accountId) {
      headers['openai-organization'] = accountId;
    }

    return axios.post(config.transcribeEndpointUrl, formBuffer, {
      headers,
      maxBodyLength: Infinity,
      maxContentLength: Infinity,
      timeout,
    });
  };

  try {
    let response;

    try {
      response = await postTranscription(accessToken);
    } catch (error: unknown) {
      const err = error as AxiosErrorLike;
      const responseStatus = err.response?.status;

      // Treat 401 and 403 the same: both are auth failures that may be cured by
      // refreshing the OAuth token. Previously 403 skipped the refresh path
      // entirely and surfaced a "reconnect" message — misleading because
      // reconnecting reissues fresh tokens that produce the same 403, leaving
      // the user in a "the reconnect button is broken" loop (REBEL-5HP).
      if (isHttpAuthErrorStatus(responseStatus)) {
        log.warn(
          { provider, responseStatus, audioBytes: audio.byteLength },
          'ChatGPT transcription auth error, attempting token refresh'
        );
        const refreshedToken = await config.forceRefreshToken();
        if (!refreshedToken) {
          captureAuthErrorOnce(provider, responseStatus, 'codex-transcription');
          captureCodexTranscribeAuthDiagnosticOnce(provider, 'codex-transcription', {
            status: responseStatus,
            responseHeaders: err.response?.headers as Record<string, unknown> | undefined,
            refreshAttempted: true,
            refreshSucceeded: false,
          });
          throw new VoiceTranscriptionError(
            'Your ChatGPT connection expired. Please reconnect in Settings.',
            'auth'
          );
        }

        try {
          response = await postTranscription(refreshedToken);
        } catch (retryError: unknown) {
          const retryErr = retryError as AxiosErrorLike;
          const retryStatus = retryErr.response?.status;

          if (isHttpAuthErrorStatus(retryStatus)) {
            log.warn(
              { provider, responseStatus: retryStatus, audioBytes: audio.byteLength },
              'ChatGPT transcription auth error after token refresh — endpoint rejected fresh tokens'
            );
            captureAuthErrorOnce(provider, retryStatus, 'codex-transcription');
            captureCodexTranscribeAuthDiagnosticOnce(provider, 'codex-transcription', {
              status: retryStatus,
              responseHeaders: retryErr.response?.headers as Record<string, unknown> | undefined,
              refreshAttempted: true,
              refreshSucceeded: true,
            });
            // Reconnecting will not help here — the OAuth tokens are valid (we
            // just minted fresh ones) but this endpoint rejected them. Point
            // the user at the supported workaround (set an OpenAI API key)
            // instead of the Settings reconnect button that put them in this
            // loop in the first place.
            throw new VoiceTranscriptionError(
              'Voice transcription via your ChatGPT subscription is unavailable for this account. Set an OpenAI API key in Settings > AI & Models > Providers to continue.',
              'auth'
            );
          }

          throw retryError;
        }
      } else {
        throw error;
      }
    }

    if (typeof response.data?.text !== 'string') {
      const unexpectedResponseError = new Error('Unexpected ChatGPT transcription response.');
      log.error(
        {
          err: sanitizeAxiosError(unexpectedResponseError),
          provider,
          timeoutMs: timeout,
          audioBytes: audio.byteLength,
          responseData: safeResponseData(response.data),
        },
        'ChatGPT transcription returned an unexpected response'
      );
      getErrorReporter().captureException(unexpectedResponseError, {
        tags: { area: 'voice', component: 'audio-service', operation: 'codex-transcription' },
        extra: {
          provider,
          timeoutMs: timeout,
          audioBytes: audio.byteLength,
        },
      });
      throw new VoiceTranscriptionError('Unexpected ChatGPT transcription response.', 'provider-error');
    }

    const transcript = response.data.text.trim();
    log.info(
      { provider, audioBytes: audio.byteLength, timeoutMs: timeout, transcriptLength: transcript.length },
      'ChatGPT transcription completed'
    );
    return transcript;
  } catch (error: unknown) {
    if (error instanceof VoiceTranscriptionError) {
      throw error;
    }

    const err = error as AxiosErrorLike;
    const responseStatus = err.response?.status;
    const isRateLimit = responseStatus === 429;

    if (isRateLimit) {
      log.warn(
        {
          provider,
          responseStatus,
          retryAfter: err.response?.headers?.['retry-after'],
          audioBytes: audio.byteLength,
        },
        'ChatGPT transcription rate-limited (429)'
      );
    } else {
      log.error(
        {
          err: sanitizeAxiosError(error),
          provider,
          timeoutMs: timeout,
          audioBytes: audio.byteLength,
          responseStatus,
          responseData: safeResponseData(err.response?.data),
          code: err.code,
        },
        'ChatGPT transcription API error'
      );

      const sanitizedError = new Error(err.message || 'ChatGPT transcription failed');
      sanitizedError.name = err.name || 'AxiosError';
      sanitizedError.stack = err.stack;
      getErrorReporter().captureException(sanitizedError, {
        tags: { area: 'voice', component: 'audio-service', operation: 'codex-transcription' },
        extra: {
          provider,
          timeoutMs: timeout,
          audioBytes: audio.byteLength,
          responseStatus,
          errorCode: err.code,
        },
      });
    }

    const { message, category } = buildNetworkAwareMessage('transcription', 'ChatGPT', timeout, err);
    throw new VoiceTranscriptionError(message, category);
  }
}

type OpenAiCompatibleTtsRequest = {
  text: string;
  voice: string;
  baseUrl: string;
  apiKey: string;
  model: string;
  timeout: number;
  providerTag?: OpenAiCompatibleProviderTag;
  providerLabel?: OpenAiCompatibleProviderLabel;
};

async function ttsWithOpenAiCompatible({
  text,
  voice,
  baseUrl,
  apiKey,
  model,
  timeout,
  providerTag,
  providerLabel,
}: OpenAiCompatibleTtsRequest): Promise<NodeJS.ReadableStream> {
  const providerMeta =
    providerTag && providerLabel
      ? { providerTag, providerLabel }
      : resolveOpenAiCompatibleProviderMeta(baseUrl);
  const resolvedProviderTag = providerMeta.providerTag;
  const resolvedProviderLabel = providerMeta.providerLabel;

  log.debug(
    {
      textLength: text.length,
      voice,
      provider: resolvedProviderTag,
    },
    `Preparing ${resolvedProviderLabel} TTS streaming request`
  );

  try {
    const response = await axios.post(
      buildOpenAiCompatibleUrl(baseUrl, '/v1/audio/speech'),
      {
        model,
        voice,
        input: text,
        response_format: 'mp3',
      },
      {
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        responseType: 'stream',
        timeout,
      }
    );

    return response.data;
  } catch (error: unknown) {
    const err = error as AxiosErrorLike;
    const responseStatus = err.response?.status;
    const isAuthError = responseStatus === 401 || responseStatus === 403;

    if (isAuthError) {
      // 401/403 are user-environment errors — log only, don't flood Sentry (REBEL-ZJ)
      log.warn(
        { provider: resolvedProviderTag, responseStatus },
        'TTS auth error — check API key'
      );
      if (isHttpAuthErrorStatus(responseStatus)) {
        captureAuthErrorOnce(resolvedProviderTag, responseStatus, 'tts');
      }
    } else {
      log.error(
        {
          err: sanitizeAxiosError(error),
          provider: resolvedProviderTag,
          timeoutMs: timeout,
          responseData: safeResponseData(err.response?.data),
          responseStatus,
          code: err.code,
        },
        `${resolvedProviderLabel} TTS API error`
      );

      const sanitizedError = new Error(err.message || `${resolvedProviderLabel} TTS failed`);
      sanitizedError.name = err.name || 'AxiosError';
      sanitizedError.stack = err.stack;
      getErrorReporter().captureException(sanitizedError, {
        tags: {
          area: 'voice',
          component: 'audio-service',
          operation: 'tts',
          provider: resolvedProviderTag,
        },
        extra: {
          timeoutMs: timeout,
          textLength: text.length,
          responseStatus,
          errorCode: err.code,
        },
      });
    }

    const { message } = buildNetworkAwareMessage('text-to-speech', resolvedProviderLabel, timeout, err);
    throw new Error(message);
  }
}

/**
 * Fire-and-forget STT cost tracking. Never throws — errors are silently logged.
 */
function trackSttCompletion(
  provider: string,
  model: string,
  durationMs: number | undefined,
  inputSizeBytes: number,
  source: string
): void {
  try {
    const cost = calculateSttCost(model, durationMs);
    if (cost !== null && cost > 0) {
      appendCostEntry({
        ts: Date.now(),
        cost,
        cat: 'stt',
        m: model,
        outcome: { kind: 'auxiliary_success' },
      });
    }
    getTracker().track('STT Transcription Completed', {
      costUsd: cost ?? null,
      model,
      durationMs: durationMs ?? null,
      provider,
      source,
      inputSizeBytes,
    });
  } catch {
    // Fire-and-forget: never let tracking failures affect transcription
  }
}

/**
 * Transcribe audio using OpenAI Whisper, ElevenLabs Scribe, or local Parakeet
 */
export const transcribeAudio = async ({ audio, mimeType, durationMs, prompt }: VoiceTranscriptionPayload): Promise<string> => {
  const settings = getSettings();
  const provider = settings.voice.provider;
  const sttTimeoutMs = calculateSttTimeout(durationMs);

  // Local transcription (desktop only — requires registered local transcriber for the provider)
  if (isLocalProvider(provider)) {
    const localTranscriber = _localTranscribers.get(provider);
    if (!localTranscriber) {
      throw new Error('Local transcription is not available on this platform. Please switch to OpenAI or ElevenLabs in Settings.');
    }
    const buffer = Buffer.from(audio);
    const result = await localTranscriber(buffer, mimeType);
    const modelName = provider === 'local-moonshine' ? 'moonshine-base' : 'parakeet-v3';
    trackSttCompletion(provider, modelName, durationMs, audio.byteLength, 'voice-input');
    return result.text;
  }

  if (provider === 'openai-whisper') {
    const apiKey = getProviderKey(settings, 'openai');

    if (!apiKey && _codexVoiceConfig?.isConnected()) {
      if (isChunkingRequired(audio.byteLength)) {
        throw new VoiceTranscriptionError(
          'Recording is too long for your ChatGPT subscription. Set an OpenAI API key in Settings for longer recordings, or keep recordings under 60 seconds.',
          'provider-error'
        );
      }

      const codexResult = await transcribeWithCodexBackend({
        audio,
        mimeType,
        timeout: sttTimeoutMs,
        config: _codexVoiceConfig,
      });
      log.info(
        { provider: 'openai-whisper-codex', audioBytes: audio.byteLength, durationMs },
        'Used ChatGPT subscription fallback for transcription'
      );
      trackSttCompletion('openai-whisper-codex', 'chatgpt-transcribe', durationMs, audio.byteLength, 'voice-input');
      return codexResult;
    }

    if (!apiKey) {
      throw new Error('Voice API key is not configured. Please add your API key in Settings.');
    }

    // Check if file exceeds Whisper size limit and needs chunking
    if (isChunkingRequired(audio.byteLength)) {
      if (!durationMs) {
        throw new Error('Recording duration required for large audio files');
      }

      // Check if ffmpeg is available for chunking
      const ffmpegReady = await checkFfmpegAvailable();
      if (!ffmpegReady) {
        throw new Error(
          'Recording is too long. Please keep recordings under 60 seconds, or install ffmpeg for longer recordings.'
        );
      }

      log.info(
        { audioBytes: audio.byteLength, durationMs, maxSize: MAX_WHISPER_FILE_SIZE },
        'Large audio file detected, using chunked transcription'
      );

      const chunkedResult = await transcribeChunkedWebm({
        audio,
        mimeType,
        durationMs,
        config: {
          baseUrl: 'https://api.openai.com',
          apiKey,
          model: settings.voice.model,
          vocabulary: settings.voice.transcriptionVocabulary,
          language: settings.voice.voiceInputLanguage,
          prompt,
          providerTag: 'openai-whisper',
          providerLabel: 'OpenAI',
        },
      });
      trackSttCompletion('openai-whisper', settings.voice.model, durationMs, audio.byteLength, 'voice-input');
      return chunkedResult;
    }

    const singleResult = await transcribeWithOpenAiCompatible({
      audio,
      mimeType,
      baseUrl: 'https://api.openai.com',
      apiKey,
      model: settings.voice.model,
      vocabulary: settings.voice.transcriptionVocabulary,
      language: settings.voice.voiceInputLanguage,
      prompt,
      timeout: sttTimeoutMs,
      providerTag: 'openai-whisper',
      providerLabel: 'OpenAI',
    });
    trackSttCompletion('openai-whisper', settings.voice.model, durationMs, audio.byteLength, 'voice-input');
    return singleResult;
  }

  if (provider === 'custom-openai') {
    const profile = getActiveVoiceProfile(settings.voice);
    if (!profile) {
      throw new Error('No active custom voice profile selected. Please configure one in Settings > Voice.');
    }

    const sttBaseUrl = profile.sttBaseUrl?.trim();
    if (!sttBaseUrl) {
      throw new Error('Active custom voice profile is missing an STT endpoint URL.');
    }

    const sttModel = profile.sttModel?.trim();
    if (!sttModel) {
      throw new Error('Active custom voice profile is missing an STT model.');
    }

    const apiKey = profile.apiKey?.trim() || getProviderKey(settings, 'openai');
    if (!apiKey) {
      throw new Error('Voice API key is not configured. Please add your API key in Settings.');
    }

    log.info(
      {
        provider,
        profileId: profile.id,
        profileName: profile.name,
      },
      'Using custom voice profile for transcription'
    );

    if (isChunkingRequired(audio.byteLength)) {
      if (!durationMs) {
        throw new Error('Recording duration required for large audio files');
      }

      const ffmpegReady = await checkFfmpegAvailable();
      if (!ffmpegReady) {
        throw new Error(
          'Recording is too long. Please keep recordings under 60 seconds, or install ffmpeg for longer recordings.'
        );
      }

      log.info(
        {
          provider,
          profileId: profile.id,
          profileName: profile.name,
          audioBytes: audio.byteLength,
          durationMs,
          maxSize: MAX_WHISPER_FILE_SIZE,
        },
        'Large audio file detected, using chunked transcription'
      );

      const customChunkedResult = await transcribeChunkedWebm({
        audio,
        mimeType,
        durationMs,
        config: {
          baseUrl: sttBaseUrl,
          apiKey,
          model: sttModel,
          vocabulary: settings.voice.transcriptionVocabulary,
          language: settings.voice.voiceInputLanguage,
          prompt,
          providerTag: 'custom-openai',
          providerLabel: 'Custom',
        },
      });
      trackSttCompletion('custom-openai', sttModel, durationMs, audio.byteLength, 'voice-input');
      return customChunkedResult;
    }

    const customResult = await transcribeWithOpenAiCompatible({
      audio,
      mimeType,
      baseUrl: sttBaseUrl,
      apiKey,
      model: sttModel,
      vocabulary: settings.voice.transcriptionVocabulary,
      language: settings.voice.voiceInputLanguage,
      prompt,
      timeout: sttTimeoutMs,
      providerTag: 'custom-openai',
      providerLabel: 'Custom',
    });
    trackSttCompletion('custom-openai', sttModel, durationMs, audio.byteLength, 'voice-input');
    return customResult;
  }

  if (provider === 'elevenlabs-scribe') {
    const apiKey = settings.voice.elevenlabsApiKey;
    if (!apiKey) {
      throw new Error('Voice API key is not configured. Please add your API key in Settings.');
    }

    const buffer = Buffer.from(audio);
    const safeMimeType = mimeType.split(';')[0] || mimeType;
    const extension = safeMimeType.split('/')[1] ?? 'webm';
    const modelId = settings.voice.model || 'scribe_v2';
    
    log.debug(
      { 
        mimeType: safeMimeType, 
        extension, 
        bufferSize: buffer.length,
        modelId 
      }, 
      'Preparing ElevenLabs transcription request'
    );
    
    const form = new FormData();
    form.append('file', buffer, {
      filename: `audio.${extension}`,
      contentType: safeMimeType
    });
    form.append('model_id', modelId);

    // Disable tagging of non-speech audio events (mouse clicks, laughter, etc.)
    form.append('tag_audio_events', 'false');

    // Include language hint if explicitly specified (not 'auto')
    const voiceInputLanguage = settings.voice.voiceInputLanguage;
    if (voiceInputLanguage && voiceInputLanguage !== 'auto') {
      form.append('language_code', voiceInputLanguage);
      log.debug({ language: voiceInputLanguage }, 'Including language hint in ElevenLabs transcription request');
    }

    // Include custom vocabulary as keyterms if configured
    const vocabulary = settings.voice.transcriptionVocabulary;
    if (vocabulary && vocabulary.length > 0) {
      // ElevenLabs keyterms: max 100 terms, each ≤50 chars, max 5 words
      const validKeyterms = vocabulary
        .map(term => term.trim())
        .filter(term => {
          if (term.length === 0 || term.length > 50) return false;
          if (term.split(/\s+/).length > 5) return false;
          return true;
        })
        .slice(0, 100);
      
      if (validKeyterms.length > 0) {
        // Append each keyterm separately (multipart array encoding)
        for (const term of validKeyterms) {
          form.append('keyterms', term);
        }
        log.debug({ keytermCount: validKeyterms.length }, 'Including keyterms in ElevenLabs transcription request');
      }
    }

    // Get form buffer and length explicitly to avoid streaming issues in Electron
    const formBuffer = form.getBuffer();
    const formHeaders = form.getHeaders();
    formHeaders['content-length'] = String(formBuffer.length);

    const requestStartTime = Date.now();
    log.info(
      {
        mimeType: safeMimeType,
        extension,
        bufferSize: buffer.length,
        modelId,
        audioInputType: Object.prototype.toString.call(audio),
        bufferIsBuffer: Buffer.isBuffer(buffer),
        timeoutMs: sttTimeoutMs
      },
      'ElevenLabs STT request starting'
    );

    let response;
    try {
      response = await axios.post('https://api.elevenlabs.io/v1/speech-to-text', formBuffer, {
        headers: {
          ...formHeaders,
          'xi-api-key': apiKey
        },
        maxBodyLength: Infinity,
        maxContentLength: Infinity,
        timeout: sttTimeoutMs
      });
    } catch (error: unknown) {
      const err = error as AxiosErrorLike;
      const elapsedMs = Date.now() - requestStartTime;
      const responseStatus = err.response?.status;
      const isRateLimit = responseStatus === 429;
      const isAuthError = responseStatus === 401 || responseStatus === 403;

      if (isRateLimit || isAuthError) {
        // 429/401/403 are expected user-environment errors — warn only, don't flood Sentry (REBEL-R0, REBEL-ZK)
        log.warn(
          {
            provider: 'elevenlabs-scribe',
            responseStatus,
            retryAfter: err.response?.headers?.['retry-after'],
            audioBytes: audio.byteLength,
            elapsedMs,
          },
          isRateLimit
            ? 'ElevenLabs transcription rate-limited (429)'
            : 'ElevenLabs transcription auth error — check API key'
        );
        if (isHttpAuthErrorStatus(responseStatus)) captureAuthErrorOnce('elevenlabs-scribe', responseStatus, 'transcription');
      } else {
        log.error(
          {
            err: sanitizeAxiosError(error),
            provider: 'elevenlabs-scribe',
            timeoutMs: sttTimeoutMs,
            elapsedMs,
            responseData: safeResponseData(err.response?.data),
            responseStatus,
            code: err.code
          },
          'ElevenLabs transcription API error'
        );

        // Capture sanitized error to Sentry (avoid leaking API keys in error.config)
        const sanitizedError = new Error(err.message || 'ElevenLabs transcription failed');
        sanitizedError.name = err.name || 'AxiosError';
        sanitizedError.stack = err.stack;
        getErrorReporter().captureException(sanitizedError, {
          tags: {
            area: 'voice',
            component: 'audio-service',
            operation: 'transcription',
            provider: 'elevenlabs-scribe'
          },
          extra: {
            timeoutMs: sttTimeoutMs,
            recordingDurationMs: durationMs,
            audioBytes: audio.byteLength,
            elapsedMs,
            responseStatus,
            errorCode: err.code
          }
        });
      }

      const { message, category } = buildNetworkAwareMessage('transcription', 'ElevenLabs', sttTimeoutMs, err);
      throw new VoiceTranscriptionError(message, category);
    }

    const elapsedMs = Date.now() - requestStartTime;
    log.info(
      { elapsedMs, provider: 'elevenlabs-scribe' },
      'ElevenLabs STT request completed'
    );

    if (typeof response.data?.text !== 'string') {
      throw new Error('Unexpected ElevenLabs transcription response.');
    }

    trackSttCompletion('elevenlabs-scribe', modelId, durationMs, audio.byteLength, 'voice-input');
    return response.data.text.trim();
  }

  throw new Error(`Unsupported voice provider: ${provider}`);
};

/**
 * Preview text-to-speech with explicit voice settings (for testing voices before saving).
 * Returns null if provider doesn't support TTS.
 */
export const previewTextToSpeech = async (
  text: string,
  provider: 'openai-whisper' | 'elevenlabs-scribe' | 'custom-openai',
  voiceId: string,
  apiKey: string,
  endpointUrl?: string
): Promise<NodeJS.ReadableStream | null> => {
  if (provider === 'openai-whisper') {
    log.debug(
      { textLength: text.length, voice: voiceId, provider },
      'Preparing OpenAI TTS preview request'
    );

    try {
      const response = await axios.post(
        'https://api.openai.com/v1/audio/speech',
        {
          model: 'tts-1',
          voice: voiceId,
          input: text,
          response_format: 'mp3'
        },
        {
          headers: {
            'Authorization': `Bearer ${apiKey}`,
            'Content-Type': 'application/json'
          },
          responseType: 'stream',
          timeout: TTS_TIMEOUT_MS
        }
      );

      return response.data;
    } catch (error: unknown) {
      const err = error as AxiosErrorLike;
      log.error(
        {
          err: sanitizeAxiosError(error),
          provider: 'openai-whisper',
          responseStatus: err.response?.status,
          code: err.code
        },
        'OpenAI TTS preview error'
      );
      const { message } = buildNetworkAwareMessage('text-to-speech preview', 'OpenAI', TTS_TIMEOUT_MS, err);
      throw new Error(message);
    }
  }

  if (provider === 'custom-openai') {
    const ttsBaseUrl = endpointUrl?.trim();
    if (!ttsBaseUrl) {
      log.debug('TTS preview unavailable for custom-openai provider without endpoint configuration');
      return null;
    }

    log.debug(
      { textLength: text.length, voice: voiceId, provider },
      'Preparing Custom TTS preview request'
    );

    try {
      const response = await axios.post(
        buildOpenAiCompatibleUrl(ttsBaseUrl, '/v1/audio/speech'),
        {
          model: 'tts-1',
          voice: voiceId,
          input: text,
          response_format: 'mp3'
        },
        {
          headers: {
            'Authorization': `Bearer ${apiKey}`,
            'Content-Type': 'application/json'
          },
          responseType: 'stream',
          timeout: TTS_TIMEOUT_MS
        }
      );

      return response.data;
    } catch (error: unknown) {
      const err = error as AxiosErrorLike;
      log.error(
        {
          err: sanitizeAxiosError(error),
          provider: 'custom-openai',
          responseStatus: err.response?.status,
          code: err.code
        },
        'Custom TTS preview error'
      );
      const { message } = buildNetworkAwareMessage('text-to-speech preview', 'Custom', TTS_TIMEOUT_MS, err);
      throw new Error(message);
    }
  }

  if (provider === 'elevenlabs-scribe') {
    const modelId = 'eleven_multilingual_v2';
    
    log.debug(
      { textLength: text.length, voiceId, modelId, provider },
      'Preparing ElevenLabs TTS preview request'
    );
    
    try {
      const response = await axios.post(
        `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}/stream`,
        {
          text,
          model_id: modelId,
          voice_settings: {
            stability: 0.5,
            similarity_boost: 0.75
          }
        },
        {
          headers: {
            'xi-api-key': apiKey,
            'Content-Type': 'application/json'
          },
          responseType: 'stream',
          timeout: TTS_TIMEOUT_MS
        }
      );

      return response.data;
    } catch (error: unknown) {
      const err = error as AxiosErrorLike;
      log.error(
        {
          err: sanitizeAxiosError(error),
          provider: 'elevenlabs-scribe',
          responseStatus: err.response?.status,
          code: err.code
        },
        'ElevenLabs TTS preview error'
      );
      const { message } = buildNetworkAwareMessage('text-to-speech preview', 'ElevenLabs', TTS_TIMEOUT_MS, err);
      throw new Error(message);
    }
  }

  return null;
};

/**
 * Generate text-to-speech audio stream using OpenAI or ElevenLabs
 * Returns null for local-parakeet (TTS not supported)
 */
export const textToSpeechStream = async (text: string, settings: AppSettings): Promise<NodeJS.ReadableStream | null> => {
  const provider = settings.voice.provider;

  // Local providers don't support TTS - return null (caller should handle gracefully)
  if (isLocalProvider(provider)) {
    log.debug({ provider }, 'TTS not available for local provider');
    return null;
  }

  if (provider === 'openai-whisper') {
    const apiKey = getProviderKey(settings, 'openai');
    if (!apiKey) {
      throw new Error('Voice API key is not configured. Please add your API key in Settings.');
    }

    const voice = settings.voice.ttsVoice || 'nova';
    return ttsWithOpenAiCompatible({
      text,
      voice,
      baseUrl: 'https://api.openai.com',
      apiKey,
      model: 'tts-1',
      timeout: TTS_TIMEOUT_MS,
      providerTag: 'openai-whisper',
      providerLabel: 'OpenAI',
    });
  }

  if (provider === 'custom-openai') {
    const profile = getActiveVoiceProfile(settings.voice);
    if (!profile) {
      log.debug({ provider }, 'TTS not configured for custom-openai provider without an active profile');
      return null;
    }

    const ttsBaseUrl = profile.ttsBaseUrl?.trim();
    if (!ttsBaseUrl) {
      log.debug(
        {
          provider,
          profileId: profile.id,
          profileName: profile.name,
        },
        'TTS not configured for active custom-openai profile'
      );
      return null;
    }

    const apiKey = profile.apiKey?.trim() || getProviderKey(settings, 'openai');
    if (!apiKey) {
      throw new Error('Voice API key is not configured. Please add your API key in Settings.');
    }

    // Use profile's voice, or default to 'nova'. Don't inherit settings.voice.ttsVoice
    // because it may be an ElevenLabs voice ID (20+ char string) incompatible with OpenAI.
    const voice = profile.ttsVoice?.trim() || 'nova';
    const model = profile.ttsModel?.trim() || 'tts-1';

    log.info(
      {
        provider,
        profileId: profile.id,
        profileName: profile.name,
      },
      'Using custom voice profile for TTS'
    );

    return ttsWithOpenAiCompatible({
      text,
      voice,
      baseUrl: ttsBaseUrl,
      apiKey,
      model,
      timeout: TTS_TIMEOUT_MS,
      providerTag: 'custom-openai',
      providerLabel: 'Custom',
    });
  }

  if (provider === 'elevenlabs-scribe') {
    const apiKey = settings.voice.elevenlabsApiKey;
    if (!apiKey) {
      throw new Error('Voice API key is not configured. Please add your API key in Settings.');
    }

    // ElevenLabs voice IDs are 20+ character alphanumeric strings
    // If the ttsVoice looks like an OpenAI voice name (short, lowercase), use default Rachel
    const configuredVoice = settings.voice.ttsVoice;
    const isValidElevenLabsVoiceId = configuredVoice && configuredVoice.length >= 20;
    const voiceId = isValidElevenLabsVoiceId ? configuredVoice : '21m00Tcm4TlvDq8ikWAM';
    const modelId = 'eleven_multilingual_v2';
    
    log.debug(
      { 
        textLength: text.length, 
        voiceId,
        modelId,
        provider 
      }, 
      'Preparing ElevenLabs TTS streaming request'
    );
    
    try {
      const response = await axios.post(
        `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}/stream`,
        {
          text,
          model_id: modelId,
          voice_settings: {
            stability: 0.5,
            similarity_boost: 0.75
          }
        },
        {
          headers: {
            'xi-api-key': apiKey,
            'Content-Type': 'application/json'
          },
          responseType: 'stream',
          timeout: TTS_TIMEOUT_MS
        }
      );

      return response.data;
    } catch (error: unknown) {
      const err = error as AxiosErrorLike;
      const responseStatus = err.response?.status;
      const isAuthError = responseStatus === 401 || responseStatus === 403;

      if (isAuthError) {
        log.warn(
          { provider: 'elevenlabs-scribe', responseStatus },
          'ElevenLabs TTS auth error — check API key'
        );
        if (isHttpAuthErrorStatus(responseStatus)) {
          captureAuthErrorOnce('elevenlabs-scribe', responseStatus, 'tts');
        }
      } else {
        log.error(
          {
            err: sanitizeAxiosError(error),
            provider: 'elevenlabs-scribe',
            timeoutMs: TTS_TIMEOUT_MS,
            responseData: safeResponseData(err.response?.data),
            responseStatus,
            code: err.code
          },
          'ElevenLabs TTS API error'
        );

        const sanitizedError = new Error(err.message || 'ElevenLabs TTS failed');
        sanitizedError.name = err.name || 'AxiosError';
        sanitizedError.stack = err.stack;
        getErrorReporter().captureException(sanitizedError, {
          tags: {
            area: 'voice',
            component: 'audio-service',
            operation: 'tts',
            provider: 'elevenlabs-scribe'
          },
          extra: {
            timeoutMs: TTS_TIMEOUT_MS,
            textLength: text.length,
            responseStatus,
            errorCode: err.code
          }
        });
      }

      const { message } = buildNetworkAwareMessage('text-to-speech', 'ElevenLabs', TTS_TIMEOUT_MS, err);
      throw new Error(message);
    }
  }

  throw new Error(`Unsupported voice provider: ${provider}`);
};

/**
 * Generate text-to-speech audio with character-level timestamps (ElevenLabs only).
 * Returns both the audio buffer and alignment data for subtitle synchronization.
 */
export const textToSpeechWithTimestamps = async (
  text: string,
  settings: AppSettings
): Promise<TtsWithTimestampsResponse> => {
  const provider = settings.voice.provider;

  if (provider !== 'elevenlabs-scribe') {
    throw new Error('Text-to-speech with timestamps is only supported for ElevenLabs.');
  }

  const apiKey = settings.voice.elevenlabsApiKey;
  if (!apiKey) {
    throw new Error('Voice API key is not configured. Please add your API key in Settings.');
  }

  const voiceId = settings.voice.ttsVoice || '21m00Tcm4TlvDq8ikWAM';
  const modelId = 'eleven_multilingual_v2';

  log.debug(
    {
      textLength: text.length,
      voiceId,
      modelId,
      provider
    },
    'Preparing ElevenLabs TTS with timestamps request'
  );

  try {
    const response = await axios.post(
      `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}/with-timestamps`,
      {
        text,
        model_id: modelId,
        voice_settings: {
          stability: 0.5,
          similarity_boost: 0.75
        }
      },
      {
        headers: {
          'xi-api-key': apiKey,
          'Content-Type': 'application/json'
        },
        timeout: TTS_TIMEOUT_MS * 2 // Allow more time for longer texts
      }
    );

    const { audio_base64: audioBase64, alignment } = response.data;

    if (!audioBase64 || !alignment) {
      throw new Error('Unexpected ElevenLabs response: missing audio or alignment data.');
    }

    // Convert base64 audio to buffer
    const audioBuffer = Buffer.from(audioBase64, 'base64');

    log.info(
      {
        audioSize: audioBuffer.length,
        characterCount: alignment.characters?.length ?? 0,
        provider
      },
      'ElevenLabs TTS with timestamps completed'
    );

    return {
      audio: audioBuffer,
      alignment: {
        characters: alignment.characters,
        characterStartTimesSeconds: alignment.character_start_times_seconds,
        characterEndTimesSeconds: alignment.character_end_times_seconds
      }
    };
  } catch (error: unknown) {
    const err = error as AxiosErrorLike;
    const responseStatus = err.response?.status;
    const isAuthError = responseStatus === 401 || responseStatus === 403;

    if (isAuthError) {
      log.warn(
        { provider: 'elevenlabs-scribe', responseStatus },
        'ElevenLabs TTS with timestamps auth error — check API key'
      );
      if (isHttpAuthErrorStatus(responseStatus)) {
        captureAuthErrorOnce('elevenlabs-scribe', responseStatus, 'tts-with-timestamps');
      }
    } else {
      log.error(
        {
          err: sanitizeAxiosError(error),
          provider: 'elevenlabs-scribe',
          timeoutMs: TTS_TIMEOUT_MS * 2,
          responseData: safeResponseData(err.response?.data),
          responseStatus,
          code: err.code
        },
        'ElevenLabs TTS with timestamps API error'
      );

      const sanitizedError = new Error(err.message || 'ElevenLabs TTS with timestamps failed');
      sanitizedError.name = err.name || 'AxiosError';
      sanitizedError.stack = err.stack;
      getErrorReporter().captureException(sanitizedError, {
        tags: {
          area: 'voice',
          component: 'audio-service',
          operation: 'tts-with-timestamps',
          provider: 'elevenlabs-scribe'
        },
        extra: {
          timeoutMs: TTS_TIMEOUT_MS * 2,
          textLength: text.length,
          responseStatus,
          errorCode: err.code
        }
      });
    }

    const { message } = buildNetworkAwareMessage('text-to-speech', 'ElevenLabs', TTS_TIMEOUT_MS * 2, err);
    throw new Error(message);
  }
};
