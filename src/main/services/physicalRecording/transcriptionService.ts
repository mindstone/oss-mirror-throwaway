/**
 * Transcription Service for Physical Recordings
 *
 * Handles transcription of audio from physical recording devices.
 * Uses core audioChunking for long recordings (Whisper API has 25MB limit).
 */

import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import axios from 'axios';
import FormData from 'form-data';
import { createScopedLogger } from '@core/logger';
import { getSettings } from '@core/services/settingsStore';
import { savePhysicalRecording } from './storageService';
import type { TranscriptSourceSystem } from '@shared/types/transcript';
import type { PhysicalRecordingMetadata } from './types';
import { getProviderKey } from '@shared/utils/providerKeys';
import { appendCostEntry } from '@core/services/costLedgerService';
import { getTracker } from '@core/tracking';
import { calculateSttCost } from '@shared/utils/sttPricingCalculator';
import { chunkAudioFile, isChunkingRequired, type ChunkResult } from '@core/services/audioChunking';

const log = createScopedLogger({ service: 'physical-transcription' });

const DEFAULT_SOURCE_SYSTEM = 'limitless';
const DEFAULT_DEVICE_NAME = 'Limitless Pendant';
const DEFAULT_AUDIO_MIME_TYPE = 'audio/wav';
const DEFAULT_SAMPLE_RATE = 32000; // Limitless outputs 32kHz mono
const BYTES_PER_SAMPLE = 2; // 16-bit audio

export interface TranscriptionOptions {
  sourceSystem?: TranscriptSourceSystem;
  deviceName?: string;
  audioMimeType?: string;
  sampleRate?: number;
}

interface TranscribeSingleOptions {
  audioMimeType: string;
  sampleRate: number;
  durationSeconds?: number;
}

/**
 * Transcribe audio from a physical recording.
 * Handles chunking for long recordings.
 *
 * @param audioBuffer - WAV audio buffer
 * @param duration - Duration in seconds
 * @param recordingStartTime - When the recording actually started (not transcription time)
 * @param title - Optional title for the recording
 */
export async function transcribePhysicalRecording(
  audioBuffer: Buffer,
  duration: number,
  recordingStartTime: Date,
  title?: string,
  options: TranscriptionOptions = {}
): Promise<{
  transcript: string;
  metadata: PhysicalRecordingMetadata;
  savedPath: string;
}> {
  const sourceSystem = options.sourceSystem ?? DEFAULT_SOURCE_SYSTEM;
  const deviceName = options.deviceName ?? DEFAULT_DEVICE_NAME;
  const audioMimeType = options.audioMimeType ?? DEFAULT_AUDIO_MIME_TYPE;
  const sampleRate = options.sampleRate ?? DEFAULT_SAMPLE_RATE;

  const settings = getSettings();
  const apiKey = getProviderKey(settings, 'openai');

  if (!apiKey) {
    throw new Error('OpenAI API key not configured. Please add your API key in Settings.');
  }

  log.info(
    {
      duration,
      bytes: audioBuffer.length,
      recordingStartTime: recordingStartTime.toISOString(),
      sourceSystem,
      audioMimeType,
    },
    'Starting transcription'
  );

  let transcript: string;

  // WAV-only chunking (for non-WAV formats like WebM, send directly).
  if (audioMimeType === DEFAULT_AUDIO_MIME_TYPE && isChunkingRequired(audioBuffer.length)) {
    log.info(
      { bytes: audioBuffer.length },
      'Audio exceeds Whisper limit, chunking...'
    );
    transcript = await transcribeChunkedViaCore(audioBuffer, apiKey, sampleRate);
  } else {
    if (audioMimeType !== DEFAULT_AUDIO_MIME_TYPE && isChunkingRequired(audioBuffer.length)) {
      log.info(
        { bytes: audioBuffer.length, audioMimeType },
        'Non-WAV audio exceeds Whisper size guideline; sending as a single file'
      );
    }

    transcript = await transcribeSingle(audioBuffer, apiKey, {
      audioMimeType,
      sampleRate,
      durationSeconds: duration,
    });
  }

  // Fire-and-forget STT cost tracking
  try {
    const durationMs = duration * 1000;
    const cost = calculateSttCost('whisper-1', durationMs);
    if (cost !== null && cost > 0) {
      appendCostEntry({
        ts: Date.now(),
        cost,
        cat: 'stt',
        m: 'whisper-1',
        outcome: { kind: 'auxiliary_success' },
      });
    }
    getTracker().track('STT Transcription Completed', {
      costUsd: cost ?? null,
      model: 'whisper-1',
      durationMs,
      provider: 'openai-whisper',
      source: sourceSystem,
      inputSizeBytes: audioBuffer.length,
    });
  } catch {
    // Never let tracking failures affect transcription
  }

  // Generate metadata using actual recording start time
  const recordingId = crypto.randomUUID();

  const metadata: PhysicalRecordingMetadata = {
    id: recordingId,
    title: title || generateDefaultTitle(recordingStartTime),
    startTime: recordingStartTime.toISOString(),
    duration,
    deviceName,
    reviewStatus: 'pending',
  };

  // Save the recording
  log.info({ recordingId, title: metadata.title }, 'Saving physical recording to disk');
  const saveResult = await savePhysicalRecording(transcript, metadata, audioBuffer, {
    sourceSystem,
    sourceUidPrefix: sourceSystem,
    filenameInfix: sourceSystem,
    deviceDescription: deviceName,
    sourceUrlPrefix: `urn:${sourceSystem}:recording`,
    audioMimeType,
  });
  const savedPath = saveResult.filePath;
  metadata.transcriptPath = savedPath;
  log.info({ recordingId, savedPath, staged: saveResult.staged }, 'Physical recording saved');
  if (saveResult.staged) {
    log.info({ recordingId }, 'Transcript staged for review by kernel');
  }

  log.info({ recordingId, savedPath, duration }, 'Transcription complete');

  return { transcript, metadata, savedPath };
}

/**
 * Transcribe a single audio buffer (under 25MB).
 */
async function transcribeSingle(audioBuffer: Buffer, apiKey: string, options: TranscribeSingleOptions): Promise<string> {
  const { audioMimeType, sampleRate, durationSeconds } = options;
  const settings = getSettings();

  const form = new FormData();
  const fileExtension = getAudioFileExtension(audioMimeType);
  form.append('file', audioBuffer, {
    filename: `recording.${fileExtension}`,
    contentType: audioMimeType,
  });
  form.append('model', 'whisper-1');

  // Include language hint if specified
  const voiceInputLanguage = settings.voice.voiceInputLanguage;
  if (voiceInputLanguage && voiceInputLanguage !== 'auto') {
    form.append('language', voiceInputLanguage);
  }

  // Include vocabulary hints
  const vocabulary = settings.voice.transcriptionVocabulary;
  if (vocabulary && vocabulary.length > 0) {
    const prompt = `The following terms may appear: ${vocabulary.join(', ')}.`;
    form.append('prompt', prompt);
  }

  const formBuffer = form.getBuffer();
  const formHeaders = form.getHeaders();
  formHeaders['content-length'] = String(formBuffer.length);

  // Timeout based on audio duration (allow 2x duration + 30s base)
  const durationMs = typeof durationSeconds === 'number'
    ? durationSeconds * 1000
    : audioMimeType === DEFAULT_AUDIO_MIME_TYPE
      ? (audioBuffer.length / (sampleRate * BYTES_PER_SAMPLE)) * 1000
      : 0;
  const timeoutMs = Math.max(30000, durationMs * 2 + 30000);

  log.info({ bytes: audioBuffer.length, timeoutMs, audioMimeType }, 'Sending to Whisper API');

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

  return response.data.text || '';
}

/**
 * Transcribe a large WAV audio buffer by splitting into chunks using core audioChunking.
 * Each chunk is transcribed sequentially via the Whisper API.
 */
async function transcribeChunkedViaCore(audioBuffer: Buffer, apiKey: string, sampleRate: number): Promise<string> {
  // Write buffer to temp file so core chunking can process it
  const inputPath = path.join(os.tmpdir(), `rebel-physical-input-${crypto.randomUUID()}.wav`);
  await fs.writeFile(inputPath, audioBuffer);

  let chunkResult: ChunkResult | undefined;
  try {
    chunkResult = await chunkAudioFile(inputPath, { sampleRate });

    log.info({ totalChunks: chunkResult.chunkPaths.length }, 'Split audio into chunks');

    // Transcribe each chunk sequentially
    const transcripts: string[] = [];
    for (let i = 0; i < chunkResult.chunkPaths.length; i++) {
      log.info({ chunk: i + 1, total: chunkResult.chunkPaths.length }, 'Transcribing chunk');
      const chunkBuffer = await fs.readFile(chunkResult.chunkPaths[i]);
      const chunkTranscript = await transcribeSingle(chunkBuffer, apiKey, {
        audioMimeType: DEFAULT_AUDIO_MIME_TYPE,
        sampleRate,
      });
      transcripts.push(chunkTranscript);
    }

    // Join transcripts with a space (Whisper handles sentence boundaries)
    return transcripts.join(' ').trim();
  } finally {
    await chunkResult?.cleanup();
    await fs.unlink(inputPath).catch(() => {});
  }
}

function getAudioFileExtension(audioMimeType: string): string {
  const normalizedMimeType = audioMimeType.toLowerCase();

  if (normalizedMimeType.includes('wav')) return 'wav';
  if (normalizedMimeType.includes('webm')) return 'webm';
  if (normalizedMimeType.includes('mpeg') || normalizedMimeType.includes('mp3')) return 'mp3';
  if (normalizedMimeType.includes('mp4') || normalizedMimeType.includes('m4a')) return 'm4a';
  if (normalizedMimeType.includes('ogg')) return 'ogg';

  const [, subtype = 'audio'] = normalizedMimeType.split('/');
  return subtype.replace(/[^a-z0-9]+/g, '') || 'audio';
}

/**
 * Generate a default title for a recording.
 */
function generateDefaultTitle(date: Date): string {
  const timeStr = date.toLocaleTimeString('en-US', {
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
  });
  return `Recording at ${timeStr}`;
}

export default { transcribePhysicalRecording };
