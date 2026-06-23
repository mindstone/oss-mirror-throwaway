/**
 * Voice routes - Handle audio transcription
 */

import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { sendJson, readBody, log, sendRouteError, RouteError } from '../httpUtils';
import {
  transcribeAudio,
  textToSpeechStream,
  VoiceTranscriptionError,
} from '../../../src/core/services/audioService';
import { getSettings } from '../../../src/core/services/settingsStore';
import { isLocalProvider } from '../../../src/shared/utils/voiceProviderUtils';
import { getAudioDurationMs, isChunkingRequired } from '../../../src/core/services/audioChunking';
import type { VoiceErrorCategory } from '../../../src/shared/types';

function statusForVoiceErrorCategory(category: VoiceErrorCategory): number {
  switch (category) {
    case 'temporary':
    case 'network':
    case 'provider-error':
      return 503;
    case 'auth':
    case 'billing':
      return 424;
  }
}

/**
 * POST /api/voice/transcribe
 *
 * Transcribes audio from the request body.
 * Expects raw binary audio in the body with Content-Type header.
 * Optional query param: sessionId
 */
export async function handleVoiceTranscribe(
  req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<void> {
  if (req.method !== 'POST') return sendRouteError(res, undefined, new RouteError('METHOD_NOT_ALLOWED', { status: 405, message: 'Only POST' }));

  const settings = getSettings();
  if (isLocalProvider(settings.voice.provider)) {
    return sendRouteError(res, undefined, new RouteError('UNSUPPORTED_PROVIDER', { status: 400, message: 'Voice transcription requires a cloud provider. Local STT is only available on desktop and mobile apps.' }));
  }

  const contentType = req.headers['content-type'];
  if (!contentType || !contentType.startsWith('audio/')) {
    return sendRouteError(res, undefined, new RouteError('INVALID_CONTENT_TYPE', { status: 400, message: 'Content-Type must be an audio mime type' }));
  }

  // Parse query params for sessionId and optional client-provided durationMs hint
  const urlObj = new URL(req.url || '', `http://${req.headers.host || 'localhost'}`);
  const sessionId = urlObj.searchParams.get('sessionId') || undefined;
  const clientDurationMs = urlObj.searchParams.get('durationMs');
  const clientDurationHint = clientDurationMs ? parseInt(clientDurationMs, 10) : undefined;

  // Use a temp directory for uploads
  const tempDir = path.join('/tmp', 'rebel-voice-uploads');
  await fs.mkdir(tempDir, { recursive: true });

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const ext = contentType.includes('webm') ? 'webm' : contentType.includes('ogg') ? 'ogg' : 'wav';
  const filename = `${timestamp}_${Math.random().toString(36).slice(2)}.${ext}`;
  const filePath = path.join(tempDir, filename);

  log({ level: 'debug', msg: 'Receiving voice upload', contentType, filePath, sessionId });

  // Stream request body to file
  const fileHandle = await fs.open(filePath, 'w');
  const writeStream = fileHandle.createWriteStream();

  try {
    await new Promise<void>((resolve, reject) => {
      req.pipe(writeStream);
      writeStream.on('finish', resolve);
      writeStream.on('error', reject);
      req.on('error', reject);
    });

    // Derive audio duration server-side if the file is large enough to need chunking,
    // or use client-provided hint. This makes durationMs truly optional for clients.
    const audioStats = await fs.stat(filePath);
    let durationMs: number | undefined = clientDurationHint && Number.isFinite(clientDurationHint) && clientDurationHint > 0
      ? clientDurationHint
      : undefined;

    if (isChunkingRequired(audioStats.size) && !durationMs) {
      // Large file needs chunking — derive duration via ffprobe/fallback
      try {
        const detected = await getAudioDurationMs(filePath);
        durationMs = detected.durationMs;
        log({ level: 'info', msg: 'Server-side duration detection', durationMs, source: detected.source, fileSizeBytes: audioStats.size });
      } catch (err) {
        log({ level: 'warn', msg: 'Duration detection failed — chunked transcription may fail', error: (err as Error).message });
      }
    }

    // Read the file back into a buffer for transcribeAudio
    const audioBuffer = await fs.readFile(filePath);

    // Delete the temp file now that we have the buffer
    await fs.unlink(filePath).catch(() => {});

    // Call transcription service with server-derived duration
    const transcript = await transcribeAudio({
      audio: audioBuffer.buffer as ArrayBuffer,
      mimeType: contentType,
      durationMs,
    });

    log({ level: 'info', msg: 'Voice transcription success', sessionId, durationMs });
    return sendJson(res, 200, { transcript });

  } catch (error) {
    // Clean up on error
    await fs.unlink(filePath).catch(() => {});
    
    const err = error as Error;
    const voiceErrorCategory = error instanceof VoiceTranscriptionError
      ? error.category
      : undefined;
    const status = voiceErrorCategory
      ? statusForVoiceErrorCategory(voiceErrorCategory)
      : 500;
    log({
      level: 'error',
      msg: 'Voice transcription failed',
      error: err.message,
      voiceErrorCategory,
      status,
      sessionId,
    });
    return sendRouteError(res, undefined, new RouteError('TRANSCRIPTION_FAILED', {
      status,
      message: err.message,
      details: voiceErrorCategory ? { voiceErrorCategory } : undefined,
    }));
  }
}

/**
 * POST /api/voice/tts
 *
 * Converts text to speech audio using the user's configured voice provider.
 * Returns JSON with base64-encoded audio: { audioBase64: string }
 *
 * Request body (JSON): { text: string }
 * Max text length: 5000 characters.
 */
export async function handleVoiceTts(
  req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<void> {
  if (req.method !== 'POST') return sendRouteError(res, undefined, new RouteError('METHOD_NOT_ALLOWED', { status: 405, message: 'Only POST' }));

  let body: Record<string, unknown> | null;
  try {
    body = await readBody(req) as Record<string, unknown> | null;
  } catch {
    return sendRouteError(res, undefined, new RouteError('INVALID_JSON', { status: 400, message: 'Request body must be valid JSON' }));
  }

  if (!body || typeof body !== 'object') {
    return sendRouteError(res, undefined, new RouteError('INVALID_JSON', { status: 400, message: 'Request body must be a JSON object' }));
  }

  const text = typeof body.text === 'string' ? body.text.trim() : '';
  if (!text) {
    return sendRouteError(res, undefined, new RouteError('MISSING_TEXT', { status: 400, message: 'Request body must include a non-empty "text" field' }));
  }

  if (text.length > 5000) {
    return sendRouteError(res, undefined, new RouteError('TEXT_TOO_LONG', { status: 400, message: 'Text must be 5000 characters or fewer' }));
  }

  try {
    const settings = getSettings();

    if (isLocalProvider(settings.voice.provider)) {
      return sendRouteError(res, undefined, new RouteError('UNSUPPORTED_PROVIDER', { status: 400, message: 'Voice replies require a cloud provider (OpenAI or ElevenLabs). Please update your voice settings.' }));
    }

    const stream = await textToSpeechStream(text, settings);

    if (!stream) {
      return sendRouteError(res, undefined, new RouteError('TTS_UNAVAILABLE', { status: 400, message: 'Text-to-speech is not available for the current voice provider' }));
    }

    const audioChunks: Buffer[] = [];
    await new Promise<void>((resolve, reject) => {
      stream.on('data', (chunk: Buffer) => audioChunks.push(chunk));
      stream.on('end', () => resolve());
      stream.on('error', (err) => reject(err));
    });

    const audioBuffer = Buffer.concat(audioChunks);
    const audioBase64 = audioBuffer.toString('base64');

    sendJson(res, 200, { audioBase64 });

    log({ level: 'info', msg: 'Voice TTS success', textLength: text.length, audioBytes: audioBuffer.length });
  } catch (error) {
    const err = error as Error;
    log({ level: 'error', msg: 'Voice TTS failed', error: err.message });
    return sendRouteError(res, undefined, new RouteError('TTS_FAILED', { status: 500, message: err.message }));
  }
}
