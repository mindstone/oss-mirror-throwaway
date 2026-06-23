import * as FileSystem from 'expo-file-system/legacy';
import { classifyUploadFailureCategory } from '@rebel/cloud-client';
import type { QueueItem, QueueConsumerResult } from '@rebel/cloud-client';
import {
  createQueueConsumer,
  type QueueCompletionEvent,
  type QueueConsumerMetadataBase,
} from './useQueueConsumer';
import { buildVoiceTranscriptionUrl } from '../utils/voiceTranscriptionUrl';

/** Metadata shape for voice-transcription queue items. */
export interface VoiceQueueMetadata extends QueueConsumerMetadataBase {
  mimeType: string;
  durationMs: number;
}

export type VoiceQueueCompletionEvent = QueueCompletionEvent;

// ---------------------------------------------------------------------------
// Transcript listener registry
// ---------------------------------------------------------------------------

/**
 * Callback type for transcript delivery. Fired by the queue consumer
 * when a voice recording is successfully transcribed.
 *
 * @param sessionId - The session the transcript belongs to
 * @param transcript - The transcribed text
 */
export type VoiceTranscriptListener = (sessionId: string, transcript: string) => void;
export type VoiceQueueCompletionListener = (event: VoiceQueueCompletionEvent) => void;

let _transcriptListener: VoiceTranscriptListener | null = null;
let _completionListener: VoiceQueueCompletionListener | null = null;

/**
 * Register a listener for transcript delivery from the queue consumer.
 * Only one listener at a time (last registration wins).
 * Used by the conversation screen to handle async transcript arrival.
 */
export function setVoiceTranscriptListener(listener: VoiceTranscriptListener): void {
  _transcriptListener = listener;
}

/**
 * Remove the transcript delivery listener.
 * Call on conversation screen unmount.
 */
export function clearVoiceTranscriptListener(): void {
  _transcriptListener = null;
}

export function setVoiceQueueCompletionListener(listener: VoiceQueueCompletionListener): void {
  _completionListener = listener;
}

export function clearVoiceQueueCompletionListener(): void {
  _completionListener = null;
}

function notifyVoiceQueueCompletion(event: VoiceQueueCompletionEvent): void {
  try {
    _completionListener?.(event);
  } catch {
    // Non-critical: never fail queue completion due to listener errors.
  }
}

type CloudVoiceErrorCategory = 'temporary' | 'billing' | 'auth' | 'network' | 'provider-error';

function isCloudVoiceErrorCategory(value: unknown): value is CloudVoiceErrorCategory {
  return value === 'temporary'
    || value === 'billing'
    || value === 'auth'
    || value === 'network'
    || value === 'provider-error';
}

function mapCloudVoiceErrorCategory(category: CloudVoiceErrorCategory): QueueConsumerResult['errorCategory'] {
  switch (category) {
    case 'temporary':
      return 'temporary';
    case 'network':
      return 'network';
    case 'auth':
      return 'provider-auth';
    case 'billing':
      return 'billing';
    case 'provider-error':
      return 'provider-error';
  }
}

function parseCloudVoiceError(body: string): {
  message: string;
  errorCategory: QueueConsumerResult['errorCategory'];
} | null {
  try {
    const parsed = JSON.parse(body) as {
      error?: { code?: unknown; message?: unknown };
      voiceErrorCategory?: unknown;
    };
    if (
      parsed.error?.code !== 'TRANSCRIPTION_FAILED'
      || !isCloudVoiceErrorCategory(parsed.voiceErrorCategory)
    ) {
      return null;
    }
    return {
      message: typeof parsed.error.message === 'string'
        ? parsed.error.message
        : 'Transcription failed',
      errorCategory: mapCloudVoiceErrorCategory(parsed.voiceErrorCategory),
    };
  } catch {
    return null;
  }
}

export function createVoiceQueueConsumer(): (
  item: QueueItem,
  payloadUri: string | null,
  signal?: AbortSignal,
) => Promise<QueueConsumerResult> {
  return createQueueConsumer<VoiceQueueMetadata>({
    loggerName: 'voiceQueueConsumer',
    sourceLabel: 'voice recording',
    sourcePresentParticiple: 'Voice queue item',
    getAttemptLogData: ({ metadata }) => ({
      durationMs: metadata.durationMs,
    }),
    buildTurnInput: async ({
      metadata,
      payloadUri,
      signal,
      sessionId,
      cloudUrl,
      token,
    }) => {
      if (!payloadUri) {
        return {
          success: false,
          error: 'Audio file not found',
          errorCategory: 'permanent',
        };
      }

      if (signal?.aborted) {
        return { success: false, error: 'Processing aborted', errorCategory: 'timeout' };
      }

      let transcript: string;
      try {
        const url = buildVoiceTranscriptionUrl(cloudUrl, {
          sessionId,
          durationMs: metadata.durationMs,
        });

        const response = await FileSystem.uploadAsync(url, payloadUri, {
          httpMethod: 'POST',
          uploadType: FileSystem.FileSystemUploadType.BINARY_CONTENT,
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': metadata.mimeType || 'audio/mp4',
          },
        });

        if (response.status === 401) {
          return {
            success: false,
            error: 'Authentication expired',
            errorCategory: 'auth',
          };
        }

        const structuredVoiceError = parseCloudVoiceError(response.body);
        if (structuredVoiceError) {
          return {
            success: false,
            error: structuredVoiceError.message,
            errorCategory: structuredVoiceError.errorCategory,
          };
        }

        // 5xx server errors get a friendlier "Server error" message but route
        // through the same shared classifier (which maps >=500 -> 'temporary').
        if (response.status >= 500) {
          return {
            success: false,
            error: `Server error (${response.status})`,
            errorCategory: classifyUploadFailureCategory(response.status),
          };
        }

        // Any other non-2xx status: use the shared permanent-whitelist
        // classifier. Transient 4xx (404 deploy-window/version-skew, 408, 425,
        // 429) -> 'temporary' (retryable); genuinely-permanent 4xx
        // (400/413/415/422) -> 'permanent'; any unusual non-2xx that isn't
        // >=400 falls through to the conservative 'temporary' default. This
        // replaces the old blanket `status >= 400 -> permanent` rule that
        // destroyed recordings on a transient 404 (REBEL-6BJ / FOX-3516).
        if (response.status < 200 || response.status >= 300) {
          return {
            success: false,
            error: `Upload failed (${response.status})`,
            errorCategory: classifyUploadFailureCategory(response.status),
          };
        }

        const body = JSON.parse(response.body) as { transcript?: string };
        if (!body.transcript?.trim()) {
          return { success: true };
        }

        transcript = body.transcript.trim();
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          success: false,
          error: message,
          errorCategory: 'network',
        };
      }

      try {
        _transcriptListener?.(sessionId, transcript);
      } catch {
        // Non-critical — do not fail queue processing due to listener errors.
      }

      return { prompt: transcript };
    },
    getSuccessLogData: ({ turnInput }) => ({
      transcriptLength: turnInput.prompt.length,
    }),
    onCompletion: notifyVoiceQueueCompletion,
  });
}
