/**
 * Plaud Sync Service
 *
 * Background polling service that syncs recordings from Plaud cloud.
 * Downloads MP3s, transcribes via Whisper API, generates title via LLM,
 * and saves to memory space - all without invoking an agent.
 */

import path from 'node:path';
import fs from 'node:fs/promises';
import { app } from 'electron';
import axios from 'axios';
import FormData from 'form-data';
import type { MeetingSourceInput } from '@core/meetingSource';
import { defaultPlaudTitle } from '@core/meetingSource/builders';
import { saveMeetingSource } from '@core/meetingSource/saveMeetingSource';
import { createScopedLogger } from '@core/logger';
import { buildSaveMeetingSourceDeps } from '@main/services/meetingBot/saveMeetingSourceDeps';
import { getPlaudConfigDir, isPlaudConnected, ensureValidToken } from './plaudAuthService';
import { fetchAllPlaudFiles, fetchPlaudFileDetails, downloadAudioFile, fileExists } from './plaudApiClient';
import {
  selectPlaudTranscriptSource,
  formatPlaudTranscriptFromSourceList,
} from './plaudTranscriptSelector';
import type { PlaudSyncState, PlaudSyncResult, PlaudFileMetadata } from './types';
import { addInboxItem } from '../inboxStore';
import { findTranscriptByStableId, getUniqueFilePath } from '../meetingBot/transcriptStorage';
import { getSettings } from '@core/services/settingsStore';
import { getProviderKey } from '@shared/utils/providerKeys';
import { callBehindTheScenesWithAuth } from '../behindTheScenesClient';
import { scanSpaces, getSpaceDisplayName, type SpaceInfo } from '../spaceService';
import { hasValidAuth } from '@main/utils/authEnvUtils';
import { transcribeWithLocalModel, isModelReady } from '../localSttService';
import { appendCostEntry } from '@core/services/costLedgerService';
import { getTracker } from '@core/tracking';
import { calculateSttCost } from '@shared/utils/sttPricingCalculator';
import {
  chunkAudioFile,
  isChunkingRequired,
  checkFfmpegAvailable,
  MAX_FILE_SIZE_BYTES,
  type ChunkResult,
} from '@core/services/audioChunking';
import { fireAndForget } from '@shared/utils/fireAndForget';

const log = createScopedLogger({ service: 'plaud-sync' });

/**
 * Sanitize axios errors to prevent API key leakage in logs.
 * Axios errors include config.headers (with Authorization) which contains secrets.
 */
const sanitizeAxiosError = (error: unknown): Record<string, unknown> => {
  if (!error || typeof error !== 'object') {
    return { message: String(error) };
  }
  const err = error as Record<string, unknown>;
  return {
    message: err.message,
    name: err.name,
    code: err.code,
    // Exclude config/request which contain secrets
    stack: err.stack,
  };
};

const _DEFAULT_SYNC_INTERVAL_MINUTES = 15;
const STALE_FILE_DAYS = 7;
const AUTH_NOTIFICATION_THROTTLE_MS = 24 * 60 * 60 * 1000; // 24 hours
const CHUNK_RETRY_ATTEMPTS = 2; // Retry each chunk once on timeout
const MIN_RECORDING_DURATION_MS = 60 * 1000; // 60 seconds minimum to transcribe
const MAX_RETRY_ATTEMPTS = 5; // Abandon after this many PERMANENT failures
const ABANDONED_REEXAMINE_MS = 24 * 60 * 60 * 1000; // Re-examine abandoned files after 24h

/**
 * Classify whether an error is transient (network/timeout) or permanent (auth/not-found).
 * Only permanent errors count toward the abandonment cap. Transient errors retry indefinitely
 * because network outages should not permanently lose recordings.
 */
export function isTransientError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return true; // Unknown errors default to transient (safe side)
  const error = err as { message?: string; code?: string; name?: string };
  const message = (error.message ?? '').toLowerCase();
  const code = (error.code ?? '').toUpperCase();

  // Network-level failures (DNS, connection refused/reset, socket hang-up)
  if (message.includes('fetch failed')) return true;
  if (message.includes('socket hang up')) return true;
  if (message.includes('network')) return true;
  if (['ECONNRESET', 'ECONNREFUSED', 'ECONNABORTED', 'ETIMEDOUT', 'EPIPE', 'ENETUNREACH', 'EAI_AGAIN'].includes(code)) return true;

  // Timeout errors (API processing took too long)
  if (message.includes('timeout')) return true;
  if (code === 'ERR_CANCELED') return true;

  // Server-side transient errors (5xx, rate limits)
  if (message.includes('500') || message.includes('502') || message.includes('503') || message.includes('504')) return true;
  if (message.includes('429') || message.includes('rate limit')) return true;

  return false;
}

// Sync state
let syncInterval: ReturnType<typeof setInterval> | null = null;
let syncInProgress = false;

// Month abbreviations for folder structure
const MONTH_ABBREVS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// Dependencies injected at initialization
export type PlaudSyncDeps = {
  getSyncIntervalMinutes: () => number;
};

let deps: PlaudSyncDeps | null = null;

/**
 * Initialize the sync service with dependencies.
 */
export function initializePlaudSyncService(dependencies: PlaudSyncDeps): void {
  deps = dependencies;
  log.info('Plaud sync service initialized');
}

/**
 * Get staging directory path.
 */
function getStagingDir(): string {
  return path.join(app.getPath('userData'), 'plaud', 'pending');
}

/**
 * Get sync state file path.
 */
function getSyncStatePath(): string {
  return path.join(getPlaudConfigDir(), 'sync-state.json');
}

/**
 * Load sync state from disk.
 */
async function loadSyncState(): Promise<PlaudSyncState> {
  try {
    const data = await fs.readFile(getSyncStatePath(), 'utf8');
    const state = JSON.parse(data);
    // Ensure arrays/objects exist (migration for existing state)
    state.processedFileIds = state.processedFileIds ?? [];
    state.failureCounts = state.failureCounts ?? {};
    state.notifiedFileIds = state.notifiedFileIds ?? [];
    state.abandonedFileIds = state.abandonedFileIds ?? [];
    state.abandonedAt = state.abandonedAt ?? {};
    return state;
  } catch {
    return {
      lastSyncTime: null,
      processedFileIds: [],
      failureCounts: {},
      notifiedFileIds: [],
      abandonedFileIds: [],
    };
  }
}

/**
 * Save sync state to disk.
 */
async function saveSyncState(state: PlaudSyncState): Promise<void> {
  const configDir = getPlaudConfigDir();
  await fs.mkdir(configDir, { recursive: true });
  await fs.writeFile(getSyncStatePath(), JSON.stringify(state, null, 2), 'utf8');
}

/**
 * Re-examine abandoned files older than ABANDONED_REEXAMINE_MS.
 * Moves them back to the retry queue so transient outages don't permanently lose recordings.
 */
async function reexamineAbandonedFiles(syncState: PlaudSyncState): Promise<void> {
  const abandonedIds = syncState.abandonedFileIds ?? [];
  const abandonedAt = syncState.abandonedAt ?? {};
  if (abandonedIds.length === 0) return;

  const now = Date.now();
  const reexamined: string[] = [];

  for (const fileId of abandonedIds) {
    const abandonedTime = abandonedAt[fileId] ? new Date(abandonedAt[fileId]).getTime() : 0;
    // If no timestamp (legacy state) or older than 24h, re-examine
    if (!abandonedTime || (now - abandonedTime > ABANDONED_REEXAMINE_MS)) {
      reexamined.push(fileId);
    }
  }

  if (reexamined.length > 0) {
    syncState.abandonedFileIds = abandonedIds.filter(id => !reexamined.includes(id));
    for (const fileId of reexamined) {
      delete abandonedAt[fileId];
      syncState.failureCounts[fileId] = 0;
    }
    syncState.abandonedAt = abandonedAt;
    log.info({ reexamined, count: reexamined.length }, 'Re-examining previously abandoned recordings after 24h cooldown');
    await saveSyncState(syncState);
  }
}

/**
 * Clean up staging files older than STALE_FILE_DAYS.
 */
async function cleanupStaleStagingFiles(): Promise<void> {
  const stagingDir = getStagingDir();
  const cutoffMs = Date.now() - STALE_FILE_DAYS * 24 * 60 * 60 * 1000;

  try {
    const files = await fs.readdir(stagingDir);
    for (const file of files) {
      const filePath = path.join(stagingDir, file);
      const stat = await fs.stat(filePath);
      if (stat.mtimeMs < cutoffMs) {
        await fs.unlink(filePath);
        log.info({ file }, 'Cleaned up stale staging file');
      }
    }
  } catch {
    // Staging dir may not exist yet
  }
}

/**
 * Check if staging files exist for a given file ID.
 */
async function stagingFilesExist(fileId: string): Promise<boolean> {
  const stagingDir = getStagingDir();
  const audioPath = path.join(stagingDir, `${fileId}.mp3`);
  const metaPath = path.join(stagingDir, `${fileId}.meta.json`);
  return (await fileExists(audioPath)) || (await fileExists(metaPath));
}

/**
 * Handle interrupted sync from previous run.
 * If inProgressFileId is set but staging files are gone, assume skill completed successfully.
 */
async function handleInterruptedSync(syncState: PlaudSyncState): Promise<void> {
  if (!syncState.inProgressFileId) return;

  const fileId = syncState.inProgressFileId;
  const hasStaging = await stagingFilesExist(fileId);

  if (!hasStaging && !syncState.processedFileIds.includes(fileId)) {
    // Staging files gone but not in processedFileIds - skill completed before state was saved
    log.info({ fileId }, 'Detected completed interrupted sync - staging files gone, marking as processed');
    syncState.processedFileIds.push(fileId);
  } else if (hasStaging) {
    log.info({ fileId }, 'Detected interrupted sync - staging files exist, will retry');
  }

  // Clear inProgressFileId regardless
  syncState.inProgressFileId = undefined;
  await saveSyncState(syncState);
}

/**
 * Check auth and notify user if expired (throttled to once per 24h).
 * Returns true if auth is valid, false if expired.
 */
async function checkAuthWithThrottledNotification(syncState: PlaudSyncState): Promise<boolean> {
  try {
    await ensureValidToken();
    return true;
  } catch (err) {
    const errMessage = err instanceof Error ? err.message : String(err);
    const isAuthError = errMessage.includes('401') || 
                        errMessage.includes('refresh') || 
                        errMessage.includes('expired') ||
                        errMessage.includes('Unauthorized');

    if (isAuthError) {
      // Check if we should notify (throttled to once per 24h)
      const lastNotified = syncState.lastAuthNotificationAt 
        ? new Date(syncState.lastAuthNotificationAt).getTime() 
        : 0;
      const now = Date.now();

      if (now - lastNotified > AUTH_NOTIFICATION_THROTTLE_MS) {
        log.warn('Plaud auth expired, notifying user');
        addInboxItem({
          title: 'Plaud connection expired',
          text: 'Your Plaud connection has expired. Please reconnect in Settings > Meetings to continue syncing recordings.',
          source: {
            kind: 'text',
            label: 'Plaud',
          },
          category: 'system',
        });
        syncState.lastAuthNotificationAt = new Date().toISOString();
        await saveSyncState(syncState);
      } else {
        log.debug('Plaud auth expired but notification throttled');
      }
    }

    return false;
  }
}

/**
 * Format date for display.
 */
function formatDate(isoDate: string): string {
  const date = new Date(isoDate);
  return date.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
  });
}

/**
 * Check if transcription is available based on current settings.
 * Returns { available: true } or { available: false, reason: string }
 */
async function checkTranscriptionAvailability(): Promise<{ available: true } | { available: false; reason: string }> {
  const settings = getSettings();
  const provider = settings.voice.provider;

  if (provider === 'local-parakeet' || provider === 'local-moonshine') {
    const modelId = provider === 'local-moonshine' ? 'moonshine-base' : 'parakeet-v3';
    const modelReady = await isModelReady(modelId);
    if (!modelReady) {
      return { available: false, reason: 'Local transcription model not installed. Download it in Settings > Agents & Voice.' };
    }
    return { available: true };
  }

  if (provider === 'elevenlabs-scribe') {
    // ElevenLabs Scribe supports up to 3GB / 10 hours - plenty for Plaud recordings
    if (!settings.voice.elevenlabsApiKey) {
      return { available: false, reason: 'ElevenLabs API key required. Add it in Settings > Agents.' };
    }
    return { available: true };
  }

  // OpenAI Whisper - need OpenAI API key
  if (!getProviderKey(settings, 'openai')) {
    return { available: false, reason: 'OpenAI API key required. Add it in Settings > Agents.' };
  }
  return { available: true };
}

/**
 * Transcribe an MP3 file using the configured STT provider with fallback chain.
 * Tries: configured provider → OpenAI Whisper → local Parakeet
 * Returns the transcript text, or throws if all providers fail.
 */
async function transcribeAudio(audioPath: string, durationMs?: number): Promise<string> {
  const settings = getSettings();
  const provider = settings.voice.provider;
  
  const stats = await fs.stat(audioPath);
  const fileSize = stats.size;

  log.info({ audioPath, fileSize, provider }, 'Transcribing Plaud audio');

  const errors: string[] = [];

  const trackPlaudStt = (actualProvider: string, model: string, source: string): void => {
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
        provider: actualProvider,
        source,
        inputSizeBytes: fileSize,
      });
    } catch {
      // Fire-and-forget: never affect transcription
    }
  };

  // Try configured provider first
  try {
    const result = await transcribeWithProvider(audioPath, fileSize, provider, settings);
    if (result) {
      const model = provider === 'elevenlabs-scribe' ? 'scribe_v2'
        : provider === 'local-parakeet' ? 'parakeet-v3'
        : provider === 'local-moonshine' ? 'moonshine-base' : 'whisper-1';
      trackPlaudStt(provider, model, 'plaud');
      return result;
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.warn({ provider, err: msg }, 'Primary transcription provider failed');
    errors.push(`${provider}: ${msg}`);
  }

  // Fallback to OpenAI Whisper if not already the primary
  if (provider !== 'openai-whisper' && getProviderKey(settings, 'openai')) {
    try {
      log.info('Falling back to OpenAI Whisper');
      const result = await transcribeWithProvider(audioPath, fileSize, 'openai-whisper', settings);
      if (result) {
        trackPlaudStt('openai-whisper', 'whisper-1', 'plaud');
        return result;
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.warn({ err: msg }, 'OpenAI Whisper fallback failed');
      errors.push(`openai-whisper: ${msg}`);
    }
  }

  // Fallback to local Parakeet if available
  if (provider !== 'local-parakeet') {
    const modelReady = await isModelReady();
    if (modelReady) {
      try {
        log.info('Falling back to local Parakeet model');
        const audioBuffer = await fs.readFile(audioPath);
        const result = await transcribeWithLocalModel(audioBuffer, 'audio/mpeg');
        if (result.text) {
          trackPlaudStt('local-parakeet', 'parakeet-v3', 'plaud');
          return result.text;
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log.warn({ err: msg }, 'Local Parakeet fallback failed');
        errors.push(`local-parakeet: ${msg}`);
      }
    }
  }

  throw new Error(`All transcription providers failed: ${errors.join('; ')}`);
}

/**
 * Transcribe with a specific provider.
 * Returns null if provider is not configured/available (missing API key, model not ready).
 * Throws if provider is configured but transcription fails.
 */
async function transcribeWithProvider(
  audioPath: string,
  fileSize: number,
  provider: string,
  settings: ReturnType<typeof getSettings>
): Promise<string | null> {
  if (provider === 'local-parakeet' || provider === 'local-moonshine') {
    const modelId = provider === 'local-moonshine' ? 'moonshine-base' : undefined;
    const modelReady = await isModelReady(modelId);
    if (!modelReady) return null;
    const audioBuffer = await fs.readFile(audioPath);
    const result = await transcribeWithLocalModel(audioBuffer, 'audio/mpeg');
    return result.text;
  }

  if (provider === 'elevenlabs-scribe') {
    const apiKey = settings.voice.elevenlabsApiKey;
    if (!apiKey) return null;
    return await transcribeWithElevenLabs(audioPath, apiKey, fileSize);
  }

  // OpenAI Whisper (provider === 'openai-whisper' or fallback)
  if (provider === 'openai-whisper' || provider === 'openai') {
    const apiKey = getProviderKey(settings, 'openai');
    if (!apiKey) return null;

    if (!isChunkingRequired(fileSize)) {
      const audioBuffer = await fs.readFile(audioPath);
      return await transcribeSingleFile(audioBuffer, apiKey, 'audio/mpeg');
    }

    const canChunk = await checkFfmpegAvailable();
    if (!canChunk) {
      const sizeMB = (fileSize / 1024 / 1024).toFixed(1);
      throw new Error(`Recording is ${sizeMB}MB, exceeds ${MAX_FILE_SIZE_BYTES / (1024 * 1024)}MB limit. Install ffmpeg for chunking.`);
    }

    return await transcribeChunkedAudio(audioPath, apiKey);
  }

  // Unknown provider
  return null;
}

/**
 * Split a large audio file into chunks using core audioChunking and transcribe each chunk.
 * Uses parallel transcription (max 4 concurrent) with per-chunk retry.
 */
async function transcribeChunkedAudio(audioPath: string, apiKey: string): Promise<string> {
  let chunkResult: ChunkResult | undefined;
  try {
    // Use core audioChunking module for splitting
    chunkResult = await chunkAudioFile(audioPath);
    const chunkPaths = chunkResult.chunkPaths;

    log.info({ chunkCount: chunkPaths.length }, 'Audio split into chunks, transcribing in parallel');

    // Transcribe chunks with limited concurrency to avoid rate limits
    const MAX_CONCURRENT = 4;
    const transcripts: string[] = new Array(chunkPaths.length);
    let nextIndex = 0;
    let activeCount = 0;
    let failed = false; // Stop scheduling new chunks after first error
    let resolveAll: () => void;
    let rejectAll: (err: Error) => void;
    const allDone = new Promise<void>((resolve, reject) => {
      resolveAll = resolve;
      rejectAll = reject;
    });

    const processNext = async (): Promise<void> => {
      while (nextIndex < chunkPaths.length && activeCount < MAX_CONCURRENT && !failed) {
        const i = nextIndex++;
        activeCount++;
        const chunkPath = chunkPaths[i];

        // Process chunk asynchronously with retry
        fireAndForget((async () => {
          try {
            const chunkBuffer = await fs.readFile(chunkPath);
            log.info({ chunk: i + 1, total: chunkPaths.length, size: chunkBuffer.length }, 'Transcribing chunk');
            
            let lastErr: Error | undefined;
            for (let attempt = 0; attempt <= CHUNK_RETRY_ATTEMPTS; attempt++) {
              try {
                if (attempt > 0) {
                  const delayMs = attempt * 5000;
                  log.info({ chunk: i + 1, attempt: attempt + 1, delayMs }, 'Retrying chunk transcription');
                  await new Promise(r => setTimeout(r, delayMs));
                }
                const transcript = await transcribeSingleFile(chunkBuffer, apiKey, 'audio/mpeg');
                log.info({ chunk: i + 1, total: chunkPaths.length }, 'Chunk transcription complete');
                transcripts[i] = transcript;
                lastErr = undefined;
                break;
              } catch (err) {
                lastErr = err instanceof Error ? err : new Error(String(err));
                const sanitized = sanitizeAxiosError(err);
                log.warn({ err: sanitized, chunk: i + 1, attempt: attempt + 1, maxAttempts: CHUNK_RETRY_ATTEMPTS + 1 }, 'Chunk transcription attempt failed');
              }
            }
            if (lastErr) {
              throw lastErr;
            }
          } catch (err) {
            failed = true;
            const sanitized = sanitizeAxiosError(err);
            log.error({ err: sanitized, chunk: i + 1 }, 'Chunk transcription failed after retries');
            rejectAll(err instanceof Error ? err : new Error(String(err)));
            return;
          } finally {
            activeCount--;
          }

          // Start next chunk or resolve if all done (only if not failed)
          if (!failed) {
            if (nextIndex < chunkPaths.length) {
              fireAndForget(processNext(), 'plaud.plaudSyncService.line566');
            } else if (activeCount === 0) {
              resolveAll();
            }
          }
        })(), 'plaud.plaudSyncService.line527');
      }
    };

    // Start initial batch
    fireAndForget(processNext(), 'plaud.plaudSyncService.line576');
    await allDone;

    // Concatenate all transcripts in order
    const fullTranscript = transcripts.join('\n\n');
    log.info({ chunkCount: chunkPaths.length, totalLength: fullTranscript.length }, 'Chunked transcription complete');
    
    return fullTranscript;
  } finally {
    // Clean up all chunk temp files via core cleanup
    await chunkResult?.cleanup();
  }
}

/**
 * Transcribe a single audio buffer using the Whisper API.
 */
async function transcribeSingleFile(
  audioBuffer: Buffer,
  apiKey: string,
  contentType: string
): Promise<string> {
  const settings = getSettings();

  const form = new FormData();
  form.append('file', audioBuffer, {
    filename: 'recording.mp3',
    contentType,
  });
  form.append('model', 'whisper-1');

  // Include language hint - default to English for Plaud (in-person meetings)
  // to avoid misdetection (e.g., Welsh for English speakers)
  const voiceInputLanguage = settings.voice.voiceInputLanguage;
  const effectiveLanguage = voiceInputLanguage && voiceInputLanguage !== 'auto' 
    ? voiceInputLanguage 
    : 'en';
  form.append('language', effectiveLanguage);
  log.debug({ effectiveLanguage, configuredLanguage: voiceInputLanguage }, 'Using language hint for Plaud transcription');

  // Include vocabulary hints
  const vocabulary = settings.voice.transcriptionVocabulary;
  if (vocabulary && vocabulary.length > 0) {
    const prompt = `The following terms may appear: ${vocabulary.join(', ')}.`;
    form.append('prompt', prompt);
  }

  const formBuffer = form.getBuffer();
  const formHeaders = form.getHeaders();
  formHeaders['content-length'] = String(formBuffer.length);

  // Generous timeout: 10 min base + 3 min per 10MB (accounts for upload + processing)
  const timeoutMs = 10 * 60 * 1000 + Math.ceil(audioBuffer.length / (10 * 1024 * 1024)) * 3 * 60 * 1000;

  log.info({ bytes: audioBuffer.length, timeoutMs }, 'Sending to Whisper API');

  const response = await axios.post(
    'https://api.openai.com/v1/audio/transcriptions',
    formBuffer,
    {
      headers: {
        ...formHeaders,
        Authorization: `Bearer ${apiKey}`,
      },
      maxBodyLength: Infinity,
      maxContentLength: Infinity,
      timeout: timeoutMs,
    }
  );

  const transcript = response.data.text || '';
  log.info({ transcriptLength: transcript.length }, 'Transcription complete');
  return transcript;
}

/**
 * Transcribe audio using ElevenLabs Scribe API.
 * ElevenLabs supports up to 3GB / 10 hours, so no chunking needed for Plaud recordings.
 * Streams file from disk to avoid loading large recordings fully into memory.
 */
async function transcribeWithElevenLabs(audioPath: string, apiKey: string, fileSize?: number): Promise<string> {
  const settings = getSettings();
  const { createReadStream } = await import('node:fs');

  const form = new FormData();
  form.append('file', createReadStream(audioPath), {
    filename: 'recording.mp3',
    contentType: 'audio/mpeg',
  });
  form.append('model_id', settings.voice.model || 'scribe_v1');

  const voiceInputLanguage = settings.voice.voiceInputLanguage;
  const effectiveLanguage = voiceInputLanguage && voiceInputLanguage !== 'auto' 
    ? voiceInputLanguage 
    : 'en';
  form.append('language_code', effectiveLanguage);
  log.debug({ effectiveLanguage, configuredLanguage: voiceInputLanguage }, 'Using language hint for ElevenLabs Plaud transcription');

  const actualSize = fileSize ?? (await fs.stat(audioPath)).size;
  const sizeMB = actualSize / (1024 * 1024);

  // Generous timeout: 20 min base + 5 min per 10MB (upload + server-side processing)
  // A 72MB file gets ~56 min; a 200MB file gets ~120 min
  const timeoutMs = 20 * 60 * 1000 + Math.ceil(sizeMB / 10) * 5 * 60 * 1000;

  log.info({ sizeMB: sizeMB.toFixed(1), timeoutMs, timeoutMin: (timeoutMs / 60000).toFixed(1) }, 'Sending to ElevenLabs Scribe API');

  try {
    const response = await axios.post(
      'https://api.elevenlabs.io/v1/speech-to-text',
      form,
      {
        headers: {
          ...form.getHeaders(),
          'xi-api-key': apiKey,
        },
        maxBodyLength: Infinity,
        maxContentLength: Infinity,
        timeout: timeoutMs,
      }
    );

    const transcript = response.data.text || '';
    log.info({ transcriptLength: transcript.length }, 'ElevenLabs transcription complete');
    return transcript;
  } catch (err) {
    log.error({ err: sanitizeAxiosError(err) }, 'ElevenLabs transcription failed');
    throw err;
  }
}

/**
 * Generate a smart title for a recording using LLM.
 * Falls back to date-based title if LLM fails or no API key.
 */
async function generateSmartTitle(transcript: string, startAt: string): Promise<string> {
  const settings = getSettings();
  
  if (!hasValidAuth(settings)) {
    log.debug('No valid auth, using fallback title');
    return generateFallbackTitle(startAt);
  }

  // Take first ~2000 chars of transcript for title generation
  const transcriptPreview = transcript.slice(0, 2000);
  
  const prompt = `Based on this meeting transcript excerpt, generate a concise, descriptive title (3-6 words).
Good titles describe the main topic, purpose, or participants.

Examples:
- "Q1 Budget Review"
- "Product Roadmap Planning"
- "Interview with Sarah Chen"
- "Weekly Team Standup"

Transcript:
${transcriptPreview}

Reply with ONLY the title, no quotes or explanation.`;

  try {
    const response = await callBehindTheScenesWithAuth(
      settings,
      {
        messages: [{ role: 'user', content: prompt }],
        maxTokens: 50,
        timeout: 15000,
      },
      { category: 'metadata' }
    );

    const content = response.content?.[0];
    if (content?.type === 'text' && content.text) {
      const title = content.text.trim().replace(/^["']|["']$/g, '');
      if (title && title.length > 0 && title.length < 100) {
        log.debug({ title }, 'Generated smart title');
        return title;
      }
    }
  } catch (err) {
    log.warn({ err: sanitizeAxiosError(err) }, 'Failed to generate smart title, using fallback');
  }

  return generateFallbackTitle(startAt);
}

/**
 * Generate a fallback title from the recording date.
 */
function generateFallbackTitle(startAt: string): string {
  return defaultPlaudTitle(
    {
      kind: 'plaud',
      transcript: {
        fileId: 'fallback-title',
        startAt,
        durationMs: 0,
        rawTranscript: '',
      },
      fallbackTitleStrategy: async () => '',
    },
    () => new Date(),
  );
}

/**
 * Determine which space to save the recording to.
 */
async function determineTargetSpace(coreDirectory: string): Promise<SpaceInfo | null> {
  // Read-only: routing a Plaud recording to an existing space must not
  // mutate frontmatter. See docs/plans/260411_shared_space_maintenance.md
  // Stage 3 Refinement.
  let spaces: SpaceInfo[] = [];
  try {
    spaces = await scanSpaces(coreDirectory, { skipAutoFix: true });
  } catch (error) {
    log.warn({ error }, 'Failed to scan spaces');
  }

  // Always route to Chief of Staff. Content-aware distribution to other spaces
  // happens later via the transcript-distribution-ready automation.
  const chiefOfStaff = spaces.find(s => s.type === 'chief-of-staff');
  if (chiefOfStaff) return chiefOfStaff;

  if (spaces.length === 0) {
    for (const dirName of ['Chief-of-Staff', 'chief-of-staff']) {
      const chiefOfStaffPath = path.join(coreDirectory, dirName);
      try {
        const stat = await fs.stat(chiefOfStaffPath);
        if (stat.isDirectory()) {
          return {
            name: 'Chief of Staff',
            path: dirName,
            absolutePath: chiefOfStaffPath,
            type: 'chief-of-staff',
          } as SpaceInfo;
        }
      } catch {
        // Directory doesn't exist, try next
      }
    }
  }

  log.error({ coreDirectory }, 'No Chief-of-Staff space found — cannot save Plaud recording');
  return null;
}

/**
 * Generate filename with date prefix and sanitized title.
 */
function generateFilename(
  date: Date,
  title: string
): { subfolder: string; filename: string } {
  const year = String(date.getFullYear());
  const yy = year.slice(-2);
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const monthAbbrev = MONTH_ABBREVS[date.getMonth()];
  const day = String(date.getDate()).padStart(2, '0');
  const hours = String(date.getHours()).padStart(2, '0');
  const minutes = String(date.getMinutes()).padStart(2, '0');

  const safeTitle = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 50);

  const subfolder = path.join(year, `${month}-${monthAbbrev}`, day);
  const filename = `${yy}${month}${day}_${hours}${minutes}_meeting_plaud_${safeTitle}.md`;

  return { subfolder, filename };
}

/** Result of saving a Plaud recording */
interface SavePlaudResult {
  filePath: string;
  alreadyExists: boolean;
  /** True if transcript was staged for review instead of saved directly */
  staged?: boolean;
  /** The intended final destination path (set when staged, so callers can defer events) */
  destinationPath?: string;
}

function mapKernelFailureReasonToError(reason: string): string {
  switch (reason) {
    case 'no_workspace':
      return 'No workspace configured';
    case 'no_target_space':
      return 'No suitable space found for Plaud recording';
    case 'cos_unavailable':
      return 'Staging required but Chief-of-Staff space is unavailable. Please configure a Chief-of-Staff space.';
    case 'guard_error':
      return 'Transcript sensitivity guard failed';
    case 'dedup_lookup_error':
      return 'Failed to check for existing transcript';
    case 'content_build_error':
      return 'Failed to build transcript content';
    case 'fs_error':
      return 'Failed to write transcript file';
    default:
      return 'Unknown transcript save failure';
  }
}

function createPlaudSaveMeetingSourceDeps() {
  return buildSaveMeetingSourceDeps({
    determineTargetSpace: async (_participantCount, coreDirectory) => {
      const target = await determineTargetSpace(coreDirectory);
      if (!target) {
        return null;
      }
      return {
        spacePath: target.path,
        absolutePath: target.absolutePath,
        spaceName: getSpaceDisplayName(target),
        sharing: target.sharing,
        description: target.description,
      };
    },
    findTranscriptByStableId,
    formatTranscriptMarkdown: () => '',
    formatExternalTranscriptMarkdown: () => '',
    generateFilename: (title, date) => generateFilename(date, title),
    getUniqueFilePath,
    linkTranscriptToExistingPrep: async () => undefined,
  });
}

/**
 * Save a Plaud recording to the appropriate space.
 * Checks for existing transcript by source_uid to prevent duplicates.
 */
async function savePlaudRecording(
  transcript: string,
  metadata: PlaudFileMetadata
): Promise<SavePlaudResult> {
  const input: MeetingSourceInput = {
    kind: 'plaud',
    transcript: {
      fileId: metadata.id,
      startAt: metadata.start_at,
      durationMs: metadata.duration,
      rawTranscript: transcript,
    },
    fallbackTitleStrategy: async () => generateSmartTitle(transcript, metadata.start_at),
  };

  const result = await saveMeetingSource(input, createPlaudSaveMeetingSourceDeps());
  if (result.kind === 'saved') {
    return {
      filePath: result.filePath,
      alreadyExists: result.alreadyExists,
    };
  }

  if (result.kind === 'staged') {
    return {
      filePath: result.destinationPath,
      alreadyExists: false,
      staged: true,
      destinationPath: result.destinationPath,
    };
  }

  throw new Error(result.error?.message ?? mapKernelFailureReasonToError(result.reason));
}

/**
 * Run a single sync cycle.
 */
export async function syncPlaudRecordings(): Promise<PlaudSyncResult> {
  if (!deps) {
    log.warn('Plaud sync service not initialized');
    return { synced: 0, errors: 0 };
  }

  if (syncInProgress) {
    log.debug('Sync already in progress, skipping');
    return { synced: 0, errors: 0 };
  }

  const connected = await isPlaudConnected();
  if (!connected) {
    log.debug('Plaud not connected, skipping sync');
    return { synced: 0, errors: 0 };
  }

  syncInProgress = true;
  log.info('Starting Plaud sync');

  try {
    // Load sync state
    const syncState = await loadSyncState();

    // Handle any interrupted sync from previous run BEFORE cleaning up stale files
    // (otherwise we might delete staging files for an interrupted sync and incorrectly mark as processed)
    await handleInterruptedSync(syncState);

    // Re-examine abandoned files that have been abandoned for >24h
    await reexamineAbandonedFiles(syncState);

    // Clean up stale staging files (after handling interrupted syncs)
    await cleanupStaleStagingFiles();

    // Check auth before proceeding (with throttled notification)
    const authValid = await checkAuthWithThrottledNotification(syncState);
    if (!authValid) {
      log.warn('Plaud auth invalid, skipping sync');
      return { synced: 0, errors: 0 };
    }

    // Fetch all files from Plaud (with pagination)
    const files = await fetchAllPlaudFiles();
    log.info({ fileCount: files.length }, 'Fetched all files from Plaud');

    // Filter to unprocessed files (also skip abandoned ones)
    const abandonedIds = syncState.abandonedFileIds ?? [];
    const newFiles = files.filter((f) => 
      !syncState.processedFileIds.includes(f.id) && !abandonedIds.includes(f.id)
    );
    if (newFiles.length === 0) {
      log.info('No new recordings to sync');
      syncState.lastSyncTime = new Date().toISOString();
      await saveSyncState(syncState);
      return { synced: 0, errors: 0 };
    }

    log.info({ newFileCount: newFiles.length }, 'New recordings to process');

    // Note: We no longer check transcription availability upfront because 
    // transcribeAudio() has a fallback chain (configured → OpenAI → local).
    // This lets us proceed even if the primary provider is unavailable.

    // Ensure staging directory exists
    const stagingDir = getStagingDir();
    await fs.mkdir(stagingDir, { recursive: true });

    let processed = 0;
    let errors = 0;

    // Process each file SEQUENTIALLY
    for (const file of newFiles) {
      // Skip recordings shorter than minimum duration (likely accidental/empty)
      if (file.duration < MIN_RECORDING_DURATION_MS) {
        const durationSec = Math.round(file.duration / 1000);
        log.info({ fileId: file.id, durationSec, minDurationSec: MIN_RECORDING_DURATION_MS / 1000 }, 'Skipping short recording');
        syncState.processedFileIds.push(file.id);
        await saveSyncState(syncState);
        continue;
      }

      const audioPath = path.join(stagingDir, `${file.id}.mp3`);
      const metaPath = path.join(stagingDir, `${file.id}.meta.json`);

      try {
        // Always fetch file details first — this gives us source_list (Plaud's
        // server-side transcript) plus a fresh presigned_url for the local-STT
        // fallback. The marginal API cost is tiny vs the STT we're trying to
        // skip, and it lets the selector decide before we touch any files.
        const fileDetails = await fetchPlaudFileDetails(file.id);
        if (fileDetails.id !== file.id) {
          log.warn(
            {
              listedFileId: file.id,
              detailsFileId: fileDetails.id,
            },
            'Plaud file details ID mismatch; skipping this file for now',
          );
          continue;
        }
        const decision = selectPlaudTranscriptSource(fileDetails, file);

        if (decision.kind === 'not_ready') {
          // Plaud has segments but coverage is below threshold — assume the
          // server-side transcript is still being produced. Defer to the next
          // sync without marking processed and without counting as an error.
          log.info(
            { fileId: file.id, reason: decision.reason, coverageRatio: decision.coverageRatio },
            'Plaud transcript not ready; deferring to next sync',
          );
          continue;
        }

        const metaExists = await fileExists(metaPath);
        if (!metaExists) {
          // Sentinel: write .meta.json BEFORE setting inProgressFileId so
          // handleInterruptedSync sees the staging file and retries on next
          // run if we crash before saveSyncState marks success.
          await fs.writeFile(
            metaPath,
            JSON.stringify(
              {
                id: file.id,
                name: file.name,
                created_at: file.created_at,
                start_at: file.start_at,
                duration: file.duration,
                serial_number: file.serial_number,
              },
              null,
              2,
            ),
          );
        }

        let transcript: string;
        let plaudSupplied = false;

        if (decision.kind === 'plaud_complete') {
          syncState.inProgressFileId = file.id;
          await saveSyncState(syncState);

          transcript = formatPlaudTranscriptFromSourceList(decision.segments);
          plaudSupplied = true;

          log.info(
            {
              fileId: file.id,
              segmentCount: decision.segments.length,
              coverageRatio: decision.coverageRatio,
            },
            'Using Plaud server-side transcript; skipping audio download and local STT',
          );
        } else {
          // 'invalid' or 'fallback_local' — existing local-STT path.
          if (decision.kind === 'invalid') {
            log.warn(
              { fileId: file.id, reason: decision.reason },
              'Plaud source_list malformed; falling back to local STT',
            );
          }

          const audioExists = await fileExists(audioPath);
          if (!audioExists) {
            await downloadAudioFile(fileDetails.presigned_url, audioPath);
          }

          syncState.inProgressFileId = file.id;
          await saveSyncState(syncState);

          const localTranscript = await transcribeAudio(audioPath, file.duration);
          if (!localTranscript) {
            throw new Error('Transcription failed - OpenAI API key may not be configured');
          }
          transcript = localTranscript;
        }

        const metadata: PlaudFileMetadata = JSON.parse(await fs.readFile(metaPath, 'utf8'));

        // Both branches converge here so the FOX-3043 sensitivity-guard /
        // CoS-staging invariant holds regardless of which transcript source
        // was used. See plaudSavePlaudRecordingFailClosed.test.ts.
        const saveResult = await savePlaudRecording(transcript, metadata);
        if (saveResult.staged) {
          log.info({ fileId: file.id }, 'Transcript staged for review by kernel');
        }

        if (plaudSupplied) {
          // Emit a zero-cost ledger entry on the Plaud-supplied branch so the
          // savings are visible in usage analytics. Local-STT path emits its
          // own cost via transcribeAudio()'s tracker.
          try {
            appendCostEntry({
              ts: Date.now(),
              cost: 0,
              cat: 'stt',
              m: 'plaud-supplied',
              outcome: { kind: 'auxiliary_success' },
            });
            getTracker().track('STT Transcription Completed', {
              costUsd: 0,
              model: 'plaud-supplied',
              durationMs: file.duration ?? null,
              provider: 'plaud-supplied',
              source: 'plaud',
              inputSizeBytes: null,
            });
          } catch {
            // Fire-and-forget tracking must never affect sync success.
          }
        }

        // Step G: Clean up staging files
        await fs.unlink(audioPath).catch(() => {});
        await fs.unlink(metaPath).catch(() => {});

        // Step H: Mark as processed
        syncState.processedFileIds.push(file.id);
        syncState.inProgressFileId = undefined;
        delete syncState.failureCounts[file.id];
        await saveSyncState(syncState);
        processed++;

        log.info({ fileId: file.id, plaudSupplied }, 'Successfully processed Plaud recording');
      } catch (err) {
        const errMessage = err instanceof Error ? err.message : String(err);
        const transient = isTransientError(err);
        log.error({ err: sanitizeAxiosError(err), fileId: file.id, transient }, 'Failed to process recording');
        errors++;

        // Clear inProgressFileId but don't mark as processed
        syncState.inProgressFileId = undefined;

        // Only count permanent (non-transient) errors toward abandonment.
        // Transient errors (network outages, timeouts) retry indefinitely
        // because they resolve on their own once connectivity returns.
        const failureCount = transient
          ? (syncState.failureCounts[file.id] || 0)
          : (syncState.failureCounts[file.id] || 0) + 1;
        syncState.failureCounts[file.id] = failureCount;

        const notifiedIds = syncState.notifiedFileIds ?? [];
        const abandonedIds = syncState.abandonedFileIds ?? [];
        const alreadyWarned = notifiedIds.includes(file.id);

        // After MAX_RETRY_ATTEMPTS permanent failures, abandon (with 24h re-examination)
        if (failureCount >= MAX_RETRY_ATTEMPTS) {
          log.warn({ fileId: file.id, failureCount }, 'Abandoning recording after max permanent failures (will re-examine after 24h)');
          if (!abandonedIds.includes(file.id)) {
            abandonedIds.push(file.id);
            syncState.abandonedFileIds = abandonedIds;
            const abandonedAt = syncState.abandonedAt ?? {};
            abandonedAt[file.id] = new Date().toISOString();
            syncState.abandonedAt = abandonedAt;
          }
          addInboxItem({
            title: 'Failed to import Plaud recording',
            text: `Recording from ${formatDate(file.start_at)} failed after ${MAX_RETRY_ATTEMPTS} attempts: ${errMessage.slice(0, 100)}. Will re-examine in 24 hours.`,
            source: {
              kind: 'text',
              label: 'Plaud Error',
            },
            category: 'system',
          });
          // Clean up staging files for abandoned recordings
          await fs.unlink(audioPath).catch(() => {});
          await fs.unlink(metaPath).catch(() => {});
        } else if (failureCount >= 2 && !alreadyWarned) {
          // Warn once after 2 permanent failures (but keep retrying)
          notifiedIds.push(file.id);
          syncState.notifiedFileIds = notifiedIds;
          addInboxItem({
            title: 'Plaud recording import struggling',
            text: `Recording from ${formatDate(file.start_at)} has failed ${failureCount} times. Will retry ${MAX_RETRY_ATTEMPTS - failureCount} more times.`,
            source: {
              kind: 'text',
              label: 'Plaud',
            },
            category: 'system',
          });
        }

        await saveSyncState(syncState);
      }
    }

    // Update last sync time
    syncState.lastSyncTime = new Date().toISOString();
    await saveSyncState(syncState);

    log.info({ processed, errors }, 'Plaud sync complete');
    return { synced: processed, errors };
  } finally {
    syncInProgress = false;
  }
}

/**
 * Start periodic sync timer.
 * Performs a health check first to verify auth is valid.
 */
export async function startPeriodicSync(): Promise<void> {
  if (!deps) {
    log.warn('Cannot start periodic sync - service not initialized');
    return;
  }

  // Stop existing timer
  stopPeriodicSync();

  const connected = await isPlaudConnected();
  if (!connected) {
    log.info('Plaud not connected, skipping periodic sync setup');
    return;
  }

  // Arm the timer regardless of current auth state. syncPlaudRecordings
  // re-evaluates auth on every tick via checkAuthWithThrottledNotification
  // and bails the tick gracefully if invalid, so the timer self-heals when
  // the user reconnects or a transient refresh failure clears.
  // See REBEL-5K0: a one-shot startup auth gate left the sync service dead
  // until app restart with no in-process recovery path.

  const intervalMinutes = deps.getSyncIntervalMinutes();
  if (intervalMinutes <= 0) {
    log.info('Auto-sync disabled (interval <= 0)');
    return;
  }

  const intervalMs = intervalMinutes * 60 * 1000;

  syncInterval = setInterval(() => {
    void syncPlaudRecordings().catch((err) => {
      log.warn({ err: sanitizeAxiosError(err) }, 'Periodic sync failed');
    });
  }, intervalMs);

  log.info({ intervalMinutes }, 'Started periodic Plaud sync');

  // Run first sync immediately (no agent needed, so no Super-MCP dependency)
  fireAndForget(syncPlaudRecordings(), 'plaud.plaudSyncService.line1287');
}

/**
 * Stop periodic sync timer.
 */
export function stopPeriodicSync(): void {
  if (syncInterval) {
    clearInterval(syncInterval);
    syncInterval = null;
    log.info('Stopped periodic Plaud sync');
  }
}

/**
 * Check if sync is in progress.
 */
export function isSyncInProgress(): boolean {
  return syncInProgress;
}

/**
 * Get the last sync time.
 */
export async function getLastSyncTime(): Promise<string | null> {
  const state = await loadSyncState();
  return state.lastSyncTime;
}

/**
 * Trigger a manual sync.
 */
export async function triggerManualSync(): Promise<PlaudSyncResult> {
  log.info('Manual sync triggered');
  return syncPlaudRecordings();
}

/**
 * Re-transcribe an existing Plaud meeting file.
 * Finds the source_uid in frontmatter, fetches audio from Plaud, re-transcribes,
 * and updates the file in place.
 *
 * NOTE: Manual retranscribe always forces local STT (Whisper / ElevenLabs /
 * Parakeet) and does NOT consult Plaud's server-side `source_list`. Users
 * invoke this when they want to redo the transcription — typically because
 * they were unhappy with the previous result, which often was the Plaud
 * server-side transcript itself. Falling back to the same Plaud transcript
 * here would defeat the purpose. See PLAN Amendment L.
 */
export async function retranscribePlaudMeeting(filePath: string): Promise<{ success: boolean; error?: string }> {
  log.info({ filePath }, 'Starting re-transcription of Plaud meeting');

  try {
    // Read the existing file
    const content = await fs.readFile(filePath, 'utf-8');
    
    // Extract source_uid from frontmatter (format: plaud_<id>)
    const sourceUidMatch = content.match(/source_uid:\s*plaud_([a-f0-9]+)/);
    if (!sourceUidMatch) {
      return { success: false, error: 'File does not contain a valid Plaud source_uid' };
    }
    const plaudFileId = sourceUidMatch[1];
    log.info({ plaudFileId }, 'Found Plaud file ID');

    // Check transcription availability
    const transcriptionCheck = await checkTranscriptionAvailability();
    if (!transcriptionCheck.available) {
      return { success: false, error: transcriptionCheck.reason };
    }

    // Ensure auth is valid
    const connected = await isPlaudConnected();
    if (!connected) {
      return { success: false, error: 'Plaud not connected' };
    }
    await ensureValidToken();

    // Fetch file details to get presigned URL
    const fileDetails = await fetchPlaudFileDetails(plaudFileId);
    log.info({ duration: fileDetails.duration }, 'Fetched Plaud file details');

    // Download audio to staging
    const stagingDir = getStagingDir();
    await fs.mkdir(stagingDir, { recursive: true });
    const audioPath = path.join(stagingDir, `retranscribe_${plaudFileId}.mp3`);
    
    await downloadAudioFile(fileDetails.presigned_url, audioPath);
    log.info({ audioPath }, 'Downloaded audio for re-transcription');

    // Transcribe
    const transcript = await transcribeAudio(audioPath, fileDetails.duration ?? undefined);
    if (!transcript) {
      await fs.unlink(audioPath).catch(() => {});
      return { success: false, error: 'Transcription failed' };
    }
    log.info({ transcriptLength: transcript.length }, 'Re-transcription complete');

    // Clean up audio file
    await fs.unlink(audioPath).catch(() => {});

    // Extract frontmatter and title from existing content
    const frontmatterMatch = content.match(/^---\n([\s\S]*?)\n---/);
    const titleMatch = content.match(/^# (.+)$/m);
    
    if (!frontmatterMatch) {
      return { success: false, error: 'Could not parse existing frontmatter' };
    }

    const existingTitle = titleMatch ? titleMatch[1] : 'Re-transcribed Meeting';
    
    // Update stored_at in frontmatter
    let frontmatter = frontmatterMatch[1];
    frontmatter = frontmatter.replace(/stored_at: .+/, `stored_at: ${new Date().toISOString().split('T')[0]}`);
    
    // Rebuild the file with new transcript
    const newContent = `---
${frontmatter}
---

# ${existingTitle}

*Recorded in-person with Plaud*

## Full Content

${transcript}
`;

    await fs.writeFile(filePath, newContent, 'utf-8');
    log.info({ filePath }, 'Re-transcribed meeting saved');

    return { success: true };
  } catch (err) {
    const errMessage = err instanceof Error ? err.message : String(err);
    log.error({ err: sanitizeAxiosError(err), filePath }, 'Re-transcription failed');
    return { success: false, error: errMessage };
  }
}
