/**
 * Voice Domain IPC Handlers
 *
 * Handles audio transcription and text-to-speech.
 */

import { app, shell, type BrowserWindow, type IpcMainInvokeEvent } from 'electron';
import path from 'node:path';
import fs from 'node:fs/promises';
import { logger } from '@core/logger';
import { transcribeAudio, textToSpeechStream, textToSpeechWithTimestamps, previewTextToSpeech, VoiceTranscriptionError } from '../services/audioService';
import type { AppSettings, VoiceTranscriptionPayload } from '@shared/types';
import { registerHandler } from './utils/registerHandler';
import { isLocalProvider } from '@shared/utils/voiceProviderUtils';

const PENDING_AUDIO_DIR = 'pending-audio';

type PendingAudioSource = 'voice-mode' | 'inline-mic';

interface PendingAudioFile {
  filePath: string;
  createdAt: number;
  source: PendingAudioSource;
  sessionId?: string;
}

function getPendingAudioDir(): string {
  return path.join(app.getPath('userData'), PENDING_AUDIO_DIR);
}

function validatePendingAudioPath(filePath: string): void {
  const pendingDir = getPendingAudioDir();
  const resolved = path.resolve(filePath);
  if (!resolved.startsWith(pendingDir + path.sep)) {
    throw new Error('Invalid file path: must be within pending-audio directory');
  }
}

function parseFilename(filename: string): { createdAt: number; source: PendingAudioSource; sessionId?: string } | null {
  // Format (old): 2024-12-26T15-30-00-000Z_voice-mode.webm
  // Format (new): 2024-12-26T15-30-00-000Z_voice-mode_abc123-uuid.webm
  // Positions: 0123456789012345678901234
  //            2024-12-26T15-30-00-000Z
  // Hyphens at: 4, 7 (date), 13, 16, 19 (time - need to convert)
  
  // Match both old format (no sessionId) and new format (with sessionId)
  // Session IDs are UUIDs (contain hyphens), so we capture everything after source until extension
  // Supported extensions: webm, wav, ogg (for OGG Opus from local STT)
  const match = filename.match(/^(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z)_(voice-mode|inline-mic)(?:_([^.]+))?\.(webm|wav|ogg)$/);
  if (!match) return null;

  const timestamp = match[1].replace(/-/g, (m, offset: number) => {
    // Replace hyphens back to colons/dots for valid ISO string, but only in time portion
    // Offsets 4 and 7 are date separators (keep as hyphen)
    // Offsets 13 and 16 are time separators (convert to colon)
    // Offset 19 is millisecond separator (convert to dot)
    if (offset === 13 || offset === 16) return ':';
    if (offset === 19) return '.';
    return m;
  });

  return {
    createdAt: new Date(timestamp).getTime(),
    source: match[2] as PendingAudioSource,
    sessionId: match[3], // undefined for old format files (backward compat)
  };
}

export interface VoiceHandlerDeps {
  getSettings: () => AppSettings;
  getWindowForEvent: (sender: Electron.WebContents) => BrowserWindow | null;
}

export function registerVoiceHandlers(deps: VoiceHandlerDeps): void {
  const { getSettings, getWindowForEvent } = deps;

  registerHandler(
    'voice:transcribe',
    async (
      _event: IpcMainInvokeEvent,
      payload: VoiceTranscriptionPayload & { source: PendingAudioSource; sessionId?: string }
    ) => {
      // Stage 3: Safe transcribe pattern
      // Save audio to disk BEFORE transcription so it survives crashes/failures.
      // On success, delete the file. On error, keep it for later retry.
      const dir = getPendingAudioDir();
      await fs.mkdir(dir, { recursive: true });

      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const originalExt = payload.mimeType.includes('webm') ? 'webm' : payload.mimeType.includes('ogg') ? 'ogg' : 'wav';
      const baseFilename = payload.sessionId
        ? `${timestamp}_${payload.source}_${payload.sessionId}`
        : `${timestamp}_${payload.source}`;

      // Save audio to pending file — use renderer-converted WAV for universal playability
      // when users reveal the file, fall back to raw format if renderer didn't provide WAV
      const rawBuffer = Buffer.from(payload.audio);
      let filePath: string;
      if (payload.pendingAudioWav) {
        filePath = path.join(dir, `${baseFilename}.wav`);
        await fs.writeFile(filePath, Buffer.from(payload.pendingAudioWav));
        logger.debug({ filePath, source: payload.source }, 'Saved pending audio as WAV (renderer-converted)');
      } else {
        filePath = path.join(dir, `${baseFilename}.${originalExt}`);
        await fs.writeFile(filePath, rawBuffer);
        logger.debug({ filePath, originalExt, source: payload.source }, 'No WAV from renderer — saved raw audio');
      }

      try {
        const transcript = await transcribeAudio(payload);

        // Success: delete the pending file (audio is no longer needed)
        try {
          await fs.unlink(filePath);
          logger.debug({ filePath }, 'Deleted pending audio after successful transcription');
        } catch (deleteError) {
          // Non-fatal - file will be orphaned but audio is transcribed
          logger.warn({ filePath, error: deleteError }, 'Failed to delete pending audio after successful transcription');
        }

        return transcript;
      } catch (error: unknown) {
        // Error: keep the pending file for later retry
        // Encode error category in message prefix so renderer can extract it
        // Format: [category]User-friendly message
        const errorMessage = error instanceof Error ? error.message : String(error);
        const errorCategory = error instanceof VoiceTranscriptionError ? error.category : undefined;
        logger.error({ error: errorMessage, errorCategory, filePath }, 'Voice transcription failed - audio saved for retry');
        if (errorCategory) {
          throw new Error(`[${errorCategory}]${errorMessage}`);
        }
        throw new Error(errorMessage);
      }
    }
  );

  registerHandler('voice:text-to-speech', async (event: IpcMainInvokeEvent, text: string) => {
    try {
      const settings = getSettings();
      const stream = await textToSpeechStream(text, settings);

      // Local provider returns null - TTS not supported
      if (stream === null) {
        logger.debug('TTS not available for current voice provider');
        return new ArrayBuffer(0); // Return empty buffer - renderer should handle gracefully
      }

      const win = getWindowForEvent(event.sender);
      const chunks: Buffer[] = [];

      return new Promise<ArrayBuffer>((resolve, reject) => {
        stream.on('data', (chunk: Buffer) => {
          chunks.push(chunk);
          // Send chunks to renderer for streaming playback
          if (win && !win.isDestroyed()) {
            win.webContents.send('voice:tts-chunk', chunk);
          }
        });

        stream.on('end', () => {
          const fullBuffer = Buffer.concat(chunks);
          resolve(
            fullBuffer.buffer.slice(fullBuffer.byteOffset, fullBuffer.byteOffset + fullBuffer.byteLength)
          );
        });

        stream.on('error', (error) => {
          logger.error({ err: error }, 'TTS stream error');
          reject(error);
        });
      });
    } catch (error: unknown) {
      const err = error as { message?: string };
      const errorMessage = err?.message || String(error);
      logger.error({ error: errorMessage }, 'Voice TTS IPC handler error');
      throw new Error(errorMessage);
    }
  });

  registerHandler('voice:text-to-speech-with-timestamps', async (_event: IpcMainInvokeEvent, text: string) => {
    try {
      const settings = getSettings();
      const result = await textToSpeechWithTimestamps(text, settings);

      // Convert Buffer to ArrayBuffer for IPC serialization
      const audioArrayBuffer = result.audio.buffer.slice(
        result.audio.byteOffset,
        result.audio.byteOffset + result.audio.byteLength
      );

      return {
        audio: audioArrayBuffer,
        alignment: result.alignment
      };
    } catch (error: unknown) {
      const err = error as { message?: string };
      const errorMessage = err?.message || String(error);
      logger.error({ error: errorMessage }, 'Voice TTS with timestamps IPC handler error');
      throw new Error(errorMessage);
    }
  });

  registerHandler(
    'voice:save-pending-audio',
    async (
      _event: IpcMainInvokeEvent,
      payload: { audio: ArrayBuffer; mimeType: string; source: PendingAudioSource; sessionId?: string }
    ) => {
      const dir = getPendingAudioDir();
      await fs.mkdir(dir, { recursive: true });

      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      // Derive extension from mimeType: audio/webm -> webm, audio/ogg -> ogg, else wav
      const ext = payload.mimeType.includes('webm') ? 'webm' : payload.mimeType.includes('ogg') ? 'ogg' : 'wav';
      // Include sessionId in filename if provided (new format)
      // Format: {timestamp}_{source}_{sessionId}.{ext}
      const filename = payload.sessionId
        ? `${timestamp}_${payload.source}_${payload.sessionId}.${ext}`
        : `${timestamp}_${payload.source}.${ext}`;
      const filePath = path.join(dir, filename);

      await fs.writeFile(filePath, Buffer.from(payload.audio));
      logger.info({ filePath, source: payload.source, sessionId: payload.sessionId }, 'Saved pending audio for later retry');

      return { filePath };
    }
  );

  registerHandler('voice:get-pending-audio', async () => {
    const dir = getPendingAudioDir();

    try {
      const files = await fs.readdir(dir);
      const pendingFiles: PendingAudioFile[] = [];

      for (const filename of files) {
        const parsed = parseFilename(filename);
        if (parsed) {
          pendingFiles.push({
            filePath: path.join(dir, filename),
            createdAt: parsed.createdAt,
            source: parsed.source,
            sessionId: parsed.sessionId, // undefined for legacy files
          });
        }
      }

      return pendingFiles.sort((a, b) => a.createdAt - b.createdAt);
    } catch (error) {
      // Directory doesn't exist yet = no pending files
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return [];
      }
      throw error;
    }
  });

  registerHandler(
    'voice:retry-pending-audio',
    async (_event: IpcMainInvokeEvent, payload: { filePath: string }) => {
      try {
        validatePendingAudioPath(payload.filePath);

        // Infer mimeType from file extension
        const mimeType = payload.filePath.endsWith('.webm') ? 'audio/webm' 
          : payload.filePath.endsWith('.ogg') ? 'audio/ogg' 
          : 'audio/wav';

        // Check for incompatible format: local providers + WebM
        // The audio-decode library used by local STT doesn't support WebM container.
        // These files were likely recorded when local STT was broken. User should re-record
        // or switch to a cloud provider to retry these specific recordings.
        const settings = getSettings();
        if (isLocalProvider(settings.voice.provider) && mimeType === 'audio/webm') {
          logger.warn(
            { filePath: payload.filePath, provider: settings.voice.provider, mimeType },
            'Cannot retry WebM audio with local STT - format not supported'
          );
          return {
            success: false,
            error: 'This recording is in WebM format which is not compatible with local transcription. ' +
                   'Please switch to a cloud provider (OpenAI or ElevenLabs) in Settings to retry, or delete and re-record.'
          };
        }

        const audio = await fs.readFile(payload.filePath);

        // We don't have the original recording duration, so use a generous assumed duration.
        // calculateSttTimeout() computes: max(15s, durationMs * 1.5), so 60s → 90s actual timeout.
        // This covers most voice recordings (STT APIs process faster than real-time).
        const ASSUMED_DURATION_MS = 60_000;

        const transcript = await transcribeAudio({
          audio: audio.buffer.slice(audio.byteOffset, audio.byteOffset + audio.byteLength),
          mimeType,
          durationMs: ASSUMED_DURATION_MS,
        });

        logger.info({ filePath: payload.filePath }, 'Successfully retried pending audio transcription');
        return { success: true, transcript };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const errorCategory = error instanceof VoiceTranscriptionError ? error.category : undefined;
        logger.warn({ filePath: payload.filePath, error: message, errorCategory }, 'Failed to retry pending audio');
        return { success: false, error: message, errorCategory };
      }
    }
  );

  registerHandler(
    'voice:delete-pending-audio',
    async (_event: IpcMainInvokeEvent, payload: { filePath: string }) => {
      validatePendingAudioPath(payload.filePath);
      try {
        await fs.unlink(payload.filePath);
        logger.info({ filePath: payload.filePath }, 'Deleted pending audio file after successful transcription');
      } catch (error) {
        // Ignore if file already deleted
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
          throw error;
        }
      }
    }
  );

  registerHandler(
    'voice:reveal-pending-audio',
    async (_event: IpcMainInvokeEvent, payload: { filePath: string }) => {
      validatePendingAudioPath(payload.filePath);
      shell.showItemInFolder(payload.filePath);
    }
  );

  registerHandler(
    'voice:preview-tts',
    async (
      _event: IpcMainInvokeEvent,
      payload: {
        text: string;
        provider: 'openai-whisper' | 'elevenlabs-scribe' | 'custom-openai';
        voiceId: string;
        apiKey: string;
        endpointUrl?: string;
      }
    ) => {
      const { text, provider, voiceId, apiKey, endpointUrl } = payload;
      
      try {
        const stream = await previewTextToSpeech(text, provider, voiceId, apiKey, endpointUrl);
        
        if (stream === null) {
          logger.debug('TTS preview not available');
          return new ArrayBuffer(0);
        }

        const chunks: Buffer[] = [];

        return new Promise<ArrayBuffer>((resolve, reject) => {
          stream.on('data', (chunk: Buffer) => {
            chunks.push(chunk);
            // Note: We don't emit 'voice:tts-chunk' for preview - the full buffer is returned
            // and decoded/played in the renderer. This avoids interference with normal TTS.
          });

          stream.on('end', () => {
            const fullBuffer = Buffer.concat(chunks);
            resolve(
              fullBuffer.buffer.slice(fullBuffer.byteOffset, fullBuffer.byteOffset + fullBuffer.byteLength)
            );
          });

          stream.on('error', (error) => {
            logger.error({ err: error }, 'TTS preview stream error');
            reject(error);
          });
        });
      } catch (error: unknown) {
        const err = error as { message?: string };
        const errorMessage = err?.message || String(error);
        logger.error({ error: errorMessage }, 'Voice TTS preview handler error');
        throw new Error(errorMessage);
      }
    }
  );
}

