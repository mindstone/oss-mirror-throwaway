// mobile/src/hooks/useMeetingRecordingConsumer.ts

/**
 * Meeting recording queue consumer — processes queued meeting recordings:
 * upload audio → poll for completion → dequeue on success.
 *
 * Key differences from voice consumer:
 * - No session pinning (meetings don't target a conversation session)
 * - No transcript listener or turn submission
 * - Uses the meeting recording-upload endpoint (not voice/transcribe)
 * - Polling pattern: after 202, poll status endpoint until complete/failed
 * - Defer pattern: returns errorCategory 'defer' when still processing,
 *   allowing voice items to process (prevents head-of-line blocking)
 * - Sets X-Idempotency-Key header for dedup
 */

import * as FileSystem from 'expo-file-system/legacy';
import {
  useAuthStore,
  createLogger,
  classifyUploadFailureCategory,
} from '@rebel/cloud-client';
import type { QueueItem, QueueConsumerResult } from '@rebel/cloud-client';

const log = createLogger('meetingRecordingConsumer');

/** Max time (ms) to consider a recording as orphaned/stuck (1 hour). */
const ORPHANED_PROCESSING_THRESHOLD_MS = 60 * 60 * 1000;

/** Metadata shape for meeting-recording queue items. */
export interface MeetingRecordingMetadata {
  meetingTitle?: string;
  meetingStartTime: number; // Unix ms
  mimeType: string;
  durationMs: number;
}

/**
 * Creates the meeting recording queue consumer callback. This is NOT a React hook —
 * it returns a plain async function suitable for queue consumption.
 */
export function createMeetingRecordingConsumer(): (
  item: QueueItem,
  payloadUri: string | null,
  signal?: AbortSignal,
) => Promise<QueueConsumerResult> {
  return async (item: QueueItem, payloadUri: string | null, _signal?: AbortSignal): Promise<QueueConsumerResult> => {
    const metadata = item.metadata as unknown as MeetingRecordingMetadata;
    const itemId = item.id;

    log.info('Processing meeting recording queue item', {
      id: itemId,
      meetingTitle: metadata.meetingTitle,
      durationMs: metadata.durationMs,
      attempt: item.attempts + 1,
    });

    // --- Validate payload exists ---
    if (!payloadUri) {
      log.error('No payload URI for meeting recording queue item', { id: itemId });
      return {
        success: false,
        error: 'Audio file not found',
        errorCategory: 'permanent',
      };
    }

    // --- Check auth ---
    const { cloudUrl, token } = useAuthStore.getState();
    if (!cloudUrl || !token) {
      log.warn('Not authenticated, deferring meeting recording queue item', { id: itemId });
      return {
        success: false,
        error: 'Not connected to cloud',
        errorCategory: 'auth',
      };
    }

    // --- Check if already uploaded (idempotency) ---
    // If this item was previously uploaded and is still processing, skip upload and poll status.
    const recordingId = await checkExistingUpload(cloudUrl, token, itemId);

    if (recordingId) {
      // Already uploaded — poll for status
      return pollRecordingStatus(cloudUrl, token, recordingId, itemId);
    }

    // --- Upload audio ---
    try {
      const url = `${cloudUrl}/api/meeting/recording-upload`;

      const response = await FileSystem.uploadAsync(url, payloadUri, {
        httpMethod: 'POST',
        uploadType: FileSystem.FileSystemUploadType.BINARY_CONTENT,
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': metadata.mimeType || 'audio/mp4',
          'X-Idempotency-Key': itemId,
          'X-Meeting-Title': encodeURIComponent(metadata.meetingTitle || ''),
          'X-Meeting-Start-Time': String(metadata.meetingStartTime),
        },
      });

      // Auth failure — needs re-pair
      if (response.status === 401) {
        log.warn('Auth failed during meeting recording upload', { id: itemId });
        return {
          success: false,
          error: 'Authentication expired',
          errorCategory: 'auth',
        };
      }

      // Payload too large — keep the friendly message; the shared classifier
      // confirms 413 -> 'permanent' (re-sending the same bytes won't help).
      if (response.status === 413) {
        log.warn('Meeting recording too large for upload', { id: itemId });
        return {
          success: false,
          error: 'Recording file too large',
          errorCategory: classifyUploadFailureCategory(response.status),
        };
      }

      // Transient server error — keep the friendly message; classifier maps
      // >=500 -> 'temporary'.
      if (response.status >= 500) {
        log.warn('Server error during meeting recording upload', {
          id: itemId,
          status: response.status,
        });
        return {
          success: false,
          error: `Server error (${response.status})`,
          errorCategory: classifyUploadFailureCategory(response.status),
        };
      }

      // Any other non-2xx (not 401/413/5xx): use the shared permanent-whitelist
      // classifier. Transient 4xx (404 deploy-window/version-skew, 408, 425,
      // 429) -> 'temporary' (retryable); genuinely-permanent 4xx
      // (400/415/422) -> 'permanent'. Replaces the old blanket
      // `status >= 400 -> permanent` rule that destroyed recordings on a
      // transient 404 (REBEL-6BJ / FOX-3516).
      if (response.status >= 400) {
        log.warn('Client error during meeting recording upload', {
          id: itemId,
          status: response.status,
        });
        return {
          success: false,
          error: `Upload failed (${response.status})`,
          errorCategory: classifyUploadFailureCategory(response.status),
        };
      }

      // Parse response — expect 200 (already complete) or 202 (processing)
      const body = JSON.parse(response.body) as {
        recordingId?: string;
        status?: string;
      };

      if (!body.recordingId) {
        log.error('Missing recordingId in upload response', { id: itemId });
        return {
          success: false,
          error: 'Invalid server response',
          errorCategory: 'temporary',
        };
      }

      // 200 = terminal state (idempotent replay)
      if (response.status === 200) {
        if (body.status === 'complete') {
          log.info('Meeting recording already processed (idempotent)', {
            id: itemId,
            recordingId: body.recordingId,
          });
          return { success: true };
        }
        if (body.status === 'failed') {
          log.warn('Meeting recording previously failed on server', {
            id: itemId,
            recordingId: body.recordingId,
            error: (body as Record<string, unknown>).error,
          });
          return {
            success: false,
            error: String((body as Record<string, unknown>).error || 'Server processing failed'),
            errorCategory: 'permanent',
          };
        }
      }

      // 202 = processing — poll for completion
      if (response.status === 202 || body.status === 'processing') {
        log.info('Meeting recording uploaded, processing started', {
          id: itemId,
          recordingId: body.recordingId,
        });
        // Defer: let other queue items process while cloud works
        return {
          success: false,
          errorCategory: 'defer',
        };
      }

      // Unexpected success status — treat as complete
      log.info('Meeting recording upload returned unexpected success status', {
        id: itemId,
        status: response.status,
        recordingId: body.recordingId,
      });
      return { success: true };
    } catch (err) {
      // Network error — transient
      const message = err instanceof Error ? err.message : String(err);
      log.error('Meeting recording upload failed', { id: itemId, error: message });
      return {
        success: false,
        error: message,
        errorCategory: 'network',
      };
    }
  };
}

/**
 * Check if a recording was already uploaded by querying the status endpoint
 * with the idempotency key. Returns the recordingId if found, null otherwise.
 */
async function checkExistingUpload(
  cloudUrl: string,
  token: string,
  itemId: string,
): Promise<string | null> {
  // The upload endpoint uses X-Idempotency-Key to dedup. On retry, we re-upload
  // and the server returns the existing recordingId. So we don't need a separate
  // pre-check — the upload itself is idempotent. However, if we got a 202 before
  // and are now re-processing (defer cycle), we can skip the upload.
  // This is handled by the consumer being called again — it will re-upload
  // and the server's idempotency check will return the existing status.
  return null;
}

/**
 * Poll the recording status endpoint. Returns appropriate QueueConsumerResult
 * based on the current processing status.
 */
async function pollRecordingStatus(
  cloudUrl: string,
  token: string,
  recordingId: string,
  itemId: string,
): Promise<QueueConsumerResult> {
  try {
    const statusUrl = `${cloudUrl}/api/meeting/recording-status/${recordingId}`;
    const response = await fetch(statusUrl, {
      headers: { Authorization: `Bearer ${token}` },
    });

    if (response.status === 401) {
      return {
        success: false,
        error: 'Authentication expired',
        errorCategory: 'auth',
      };
    }

    if (response.status === 404) {
      // Recording not found — may have been cleaned up. Permanent failure.
      log.warn('Recording not found on status check', { itemId, recordingId });
      return {
        success: false,
        error: 'Recording not found on server',
        errorCategory: 'permanent',
      };
    }

    if (!response.ok) {
      log.warn('Status check returned error', {
        itemId,
        recordingId,
        status: response.status,
      });
      return {
        success: false,
        error: `Status check failed (${response.status})`,
        errorCategory: 'temporary',
      };
    }

    const body = await response.json() as {
      status: string;
      error?: string;
      startedAt?: string; // ISO 8601 string from cloud
    };

    if (body.status === 'complete') {
      log.info('Meeting recording processing complete', { itemId, recordingId });
      return { success: true };
    }

    if (body.status === 'failed') {
      log.warn('Meeting recording processing failed on server', {
        itemId,
        recordingId,
        error: body.error,
      });
      return {
        success: false,
        error: body.error || 'Server processing failed',
        errorCategory: 'permanent',
      };
    }

    // Still processing — check for orphaned job (>1hr)
    const startedAtMs = body.startedAt ? new Date(body.startedAt).getTime() : 0;
    if (startedAtMs > 0 && Date.now() - startedAtMs > ORPHANED_PROCESSING_THRESHOLD_MS) {
      log.warn('Meeting recording processing appears orphaned', {
        itemId,
        recordingId,
        startedAt: body.startedAt,
        elapsedMs: Date.now() - startedAtMs,
      });
      return {
        success: false,
        error: 'Processing timed out (orphaned)',
        errorCategory: 'permanent',
      };
    }

    // Still processing — defer to let other items process
    log.info('Meeting recording still processing, deferring', { itemId, recordingId });
    return {
      success: false,
      errorCategory: 'defer',
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error('Status poll failed', { itemId, recordingId, error: message });
    return {
      success: false,
      error: message,
      errorCategory: 'network',
    };
  }
}
