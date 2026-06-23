import { z } from 'zod';
import { defineInvokeChannel } from '../schemas';

export const voiceChannels = {
  'voice:transcribe': defineInvokeChannel({
    channel: 'voice:transcribe',
    request: z.object({
      audio: z.any(),
      mimeType: z.string(),
      durationMs: z.number().optional(),
      /** Source of the recording for pending audio classification */
      source: z.enum(['voice-mode', 'inline-mic']),
      /** Session ID to bind transcript to (captured at recording start) */
      sessionId: z.string().optional(),
      /** WAV version of audio for pending file, converted in renderer via Web Audio API */
      pendingAudioWav: z.any().optional(),
    }),
    response: z.string(),
    description: 'Transcribe audio to text (saves to pending-audio/ before transcribing)',
  }),

  'voice:text-to-speech': defineInvokeChannel({
    channel: 'voice:text-to-speech',
    request: z.string(),
    response: z.any(),
    description: 'Convert text to speech audio',
  }),

  'voice:text-to-speech-with-timestamps': defineInvokeChannel({
    channel: 'voice:text-to-speech-with-timestamps',
    request: z.string(),
    response: z.object({
      audio: z.any(),
      alignment: z.object({
        characters: z.array(z.string()),
        characterStartTimesSeconds: z.array(z.number()),
        characterEndTimesSeconds: z.array(z.number()),
      }),
    }),
    description: 'Convert text to speech audio with character-level timestamps (ElevenLabs only)',
  }),

  'voice:save-pending-audio': defineInvokeChannel({
    channel: 'voice:save-pending-audio',
    request: z.object({
      audio: z.any(),
      mimeType: z.string(),
      source: z.enum(['voice-mode', 'inline-mic']),
      sessionId: z.string().optional(),
    }),
    response: z.object({ filePath: z.string() }),
    description: 'Save failed transcription audio to disk for later retry',
  }),

  'voice:get-pending-audio': defineInvokeChannel({
    channel: 'voice:get-pending-audio',
    request: z.void(),
    response: z.array(
      z.object({
        filePath: z.string(),
        createdAt: z.number(),
        source: z.enum(['voice-mode', 'inline-mic']),
        sessionId: z.string().optional(),
      })
    ),
    description: 'List pending audio files awaiting transcription',
  }),

  'voice:retry-pending-audio': defineInvokeChannel({
    channel: 'voice:retry-pending-audio',
    request: z.object({ filePath: z.string() }),
    response: z.object({
      success: z.boolean(),
      transcript: z.string().optional(),
      error: z.string().optional(),
      errorCategory: z.enum(['temporary', 'billing', 'auth', 'network', 'provider-error']).optional(),
    }),
    description: 'Retry transcription of a pending audio file',
  }),

  'voice:delete-pending-audio': defineInvokeChannel({
    channel: 'voice:delete-pending-audio',
    request: z.object({ filePath: z.string() }),
    response: z.void(),
    description: 'Delete a pending audio file after successful transcription',
  }),

  'voice:reveal-pending-audio': defineInvokeChannel({
    channel: 'voice:reveal-pending-audio',
    request: z.object({ filePath: z.string() }),
    response: z.void(),
    description: 'Reveal pending audio file in system file explorer',
  }),

  'voice:preview-tts': defineInvokeChannel({
    channel: 'voice:preview-tts',
    request: z.object({
      text: z.string(),
      provider: z.enum(['openai-whisper', 'elevenlabs-scribe']),
      voiceId: z.string(),
      apiKey: z.string(),
    }),
    response: z.any(),
    description: 'Preview TTS with specific voice settings (for testing voices before saving)',
  }),
} as const;
