import * as FileSystem from 'expo-file-system/legacy';
import {
  useAuthStore,
  useOfflineQueueStore,
  useSessionStore,
  QueueFullError,
  createLogger,
  asCloudMeetingSessionId,
  classifyUploadFailureCategory,
} from '@rebel/cloud-client';
import type { QueueItem, QueueConsumerResult } from '@rebel/cloud-client';
import {
  createMeetingManifest,
  deleteMeetingSession,
  getMeetingChunkPath,
  listMeetingChunkIndices,
  listMeetingManifests,
  readMeetingManifest,
  type MeetingChunkQueueMetadata,
  type MeetingManifest,
  updateMeetingManifest,
} from '../utils/meetingManifest';
import {
  createCloudMeetingSession as requestCreateCloudMeetingSession,
  rotateCreateMeetingSessionIdempotencyKey,
} from '../api/meetingSessionApi';
import { recordContinuityBreadcrumb } from '../utils/continuityBreadcrumbs';
import {
  buildMeetingChunkOrphanBreadcrumb,
  resolveMeetingChunkOrphanSignal,
} from '../utils/meetingChunkOrphanContinuity';
import { useActiveRecordingStore } from '../stores/activeRecordingStore';

const log = createLogger('meetingChunkConsumer');
const orphanCompanionBreadcrumbs = new Set<string>();

function getChunkQueueKey(meetingSessionId: string, chunkIndex: number): string {
  return `${meetingSessionId}:${chunkIndex}`;
}

function buildChunkIdempotencyKey(meetingSessionId: string, chunkIndex: number): string {
  return `meeting-chunk:${meetingSessionId}:${chunkIndex}`;
}

async function ensureManifest(metadata: MeetingChunkQueueMetadata): Promise<MeetingManifest> {
  const existing = await readMeetingManifest(metadata.meetingSessionId);
  if (existing) {
    if (existing.nextChunkIndex <= metadata.chunkIndex) {
      const updated = await updateMeetingManifest(metadata.meetingSessionId, (current) => ({
        ...current,
        nextChunkIndex: Math.max(current.nextChunkIndex, metadata.chunkIndex + 1),
      }));
      if (updated) return updated;
    }
    return existing;
  }

  const created = await createMeetingManifest(
    metadata.meetingSessionId,
    metadata.meetingTitle,
    metadata.meetingStartTime,
  );
  const updated = await updateMeetingManifest(metadata.meetingSessionId, (current) => ({
    ...current,
    nextChunkIndex: Math.max(current.nextChunkIndex, metadata.chunkIndex + 1),
  }));
  return updated || {
    ...created,
    nextChunkIndex: Math.max(created.nextChunkIndex, metadata.chunkIndex + 1),
  };
}

async function createCloudMeetingSession(
  cloudUrl: string,
  token: string,
  manifest: MeetingManifest,
  metadataMeetingSessionId: string,
): Promise<string> {
  const createResult = await requestCreateCloudMeetingSession({
    cloudUrl,
    token,
    localMeetingSessionId: manifest.localId,
    meetingTitle: manifest.meetingTitle,
    meetingStartTime: manifest.startTime,
    companionSessionId: manifest.companionSessionId ?? useActiveRecordingStore.getState().companionSessionId,
  });
  if (!createResult.ok) {
    if (createResult.kind === 'auth_expired') {
      throw new Error('AUTH_EXPIRED');
    }
    if (createResult.kind === 'idempotency_conflict') {
      rotateCreateMeetingSessionIdempotencyKey(manifest.localId);
      throw new Error('IDEMPOTENCY_CONFLICT');
    }
    throw new Error(`SESSION_CREATE_FAILED_${createResult.status ?? 'UNKNOWN'}`);
  }

  const updated = await updateMeetingManifest(manifest.localId, (current) => ({
    ...current,
    cloudSessionId: createResult.sessionId,
  }));

  const activeRecordingState = useActiveRecordingStore.getState();
  if (activeRecordingState.meetingSessionId === metadataMeetingSessionId) {
    // Cloud-id provenance boundary: the cloud created this session id.
    activeRecordingState.setCloudSessionId(asCloudMeetingSessionId(createResult.sessionId));
  }

  return updated?.cloudSessionId || createResult.sessionId;
}

/**
 * Result of a chunk upload / finalize HTTP call.
 *
 * - `defer`          — attempt-neutral retry (does not increment attempts).
 *   Used for the intentional `>=500` and finalize-`409` special-cases.
 * - `permanentError` — genuinely-permanent failure (terminalizes immediately).
 * - `temporaryError` — retryable, attempt-incrementing failure (`'temporary'`).
 *   Carries transient 4xx (404 deploy-window/version-skew, 408, 425, 429) so
 *   they are retried with backoff instead of destroying the recording
 *   (REBEL-6BJ / FOX-3516). Distinct from `defer` precisely because it MUST
 *   increment attempts and eventually terminalize via the 10-attempt cap.
 * - `authError`      — needs re-auth.
 */
type MeetingChunkHttpResult = {
  ok: boolean;
  defer?: boolean;
  permanentError?: string;
  temporaryError?: string;
  authError?: boolean;
};

async function uploadChunkToCloud(
  cloudUrl: string,
  token: string,
  cloudSessionId: string,
  payloadUri: string,
  metadata: MeetingChunkQueueMetadata,
): Promise<MeetingChunkHttpResult> {
  const uploadResponse = await FileSystem.uploadAsync(
    `${cloudUrl}/api/meeting/session/${cloudSessionId}/chunk`,
    payloadUri,
    {
      httpMethod: 'POST',
      uploadType: FileSystem.FileSystemUploadType.BINARY_CONTENT,
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': metadata.mimeType || 'audio/mp4',
        'X-Chunk-Index': String(metadata.chunkIndex),
        'X-Idempotency-Key': buildChunkIdempotencyKey(
          metadata.meetingSessionId,
          metadata.chunkIndex,
        ),
      },
    },
  );

  if (uploadResponse.status === 401) {
    return { ok: false, authError: true };
  }
  // Idempotency conflict — intentional permanent (server already has this chunk
  // under a conflicting key); semantics preserved.
  if (uploadResponse.status === 409) {
    return { ok: false, permanentError: 'Chunk idempotency conflict on server' };
  }
  // Intentional attempt-neutral defer for 5xx; semantics preserved.
  if (uploadResponse.status >= 500) {
    return { ok: false, defer: true };
  }
  // Residual non-2xx (not 401/409/5xx): use the shared permanent-whitelist
  // classifier. `403 -> authError` (cloud bearer/pairing expired); transient
  // 4xx (404 deploy-window/version-skew, 408, 425, 429) -> retryable
  // `temporaryError`; genuinely-permanent 4xx (400/413/415/422) ->
  // `permanentError`. Replaces the old blanket `>=400 -> permanentError`.
  if (uploadResponse.status >= 400) {
    const error = `Chunk upload failed (${uploadResponse.status})`;
    const category = classifyUploadFailureCategory(uploadResponse.status);
    if (category === 'auth') {
      return { ok: false, authError: true };
    }
    if (category === 'permanent') {
      return { ok: false, permanentError: error };
    }
    return { ok: false, temporaryError: error };
  }
  return { ok: true };
}

async function finalizeCloudMeetingSession(
  cloudUrl: string,
  token: string,
  cloudSessionId: string,
  totalChunks: number,
  companionSessionId?: string,
): Promise<MeetingChunkHttpResult> {
  const body: Record<string, unknown> = { totalChunks };
  if (companionSessionId) body.companionSessionId = companionSessionId;
  const response = await fetch(`${cloudUrl}/api/meeting/session/${cloudSessionId}/finalize`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  if (response.status === 401) return { ok: false, authError: true };
  // Intentional attempt-neutral defer for finalize-409 and 5xx; preserved.
  if (response.status === 409) return { ok: false, defer: true };
  if (response.status >= 500) return { ok: false, defer: true };
  // Residual non-2xx (not 401/409/5xx): shared permanent-whitelist classifier.
  // `403 -> authError` (cloud bearer/pairing expired); transient 4xx (404
  // deploy-window/version-skew, 408, 425, 429) -> retryable `temporaryError`;
  // genuinely-permanent 4xx (400/413/415/422) -> `permanentError`. Replaces the
  // old blanket `>=400 -> permanentError`.
  if (response.status >= 400) {
    const error = `Finalize failed (${response.status})`;
    const category = classifyUploadFailureCategory(response.status);
    if (category === 'auth') {
      return { ok: false, authError: true };
    }
    if (category === 'permanent') {
      return { ok: false, permanentError: error };
    }
    return { ok: false, temporaryError: error };
  }

  return { ok: true };
}

function normalizeChunkMetadata(item: QueueItem): MeetingChunkQueueMetadata | null {
  const raw = item.metadata as Partial<MeetingChunkQueueMetadata> | undefined;
  if (!raw) return null;
  if (!raw.meetingSessionId || typeof raw.meetingSessionId !== 'string') return null;
  if (!Number.isInteger(raw.chunkIndex) || (raw.chunkIndex as number) < 0) return null;
  if (typeof raw.meetingStartTime !== 'number') return null;

  return {
    meetingSessionId: raw.meetingSessionId,
    chunkIndex: raw.chunkIndex as number,
    meetingTitle: typeof raw.meetingTitle === 'string' ? raw.meetingTitle : undefined,
    meetingStartTime: raw.meetingStartTime as number,
    mimeType: typeof raw.mimeType === 'string' ? raw.mimeType : 'audio/mp4',
    isFinalChunk: raw.isFinalChunk === true,
    totalChunks: typeof raw.totalChunks === 'number' ? raw.totalChunks : undefined,
  };
}

function maybeRecordOrphanCompanionBreadcrumb(meetingSessionId: string, companionSessionId?: string): void {
  const sessionState = useSessionStore.getState();
  const signal = resolveMeetingChunkOrphanSignal({
    meetingSessionId,
    companionSessionId,
    knownSessionIds: new Set(sessionState.sessions.map((session) => session.id)),
    currentSessionId: sessionState.currentSession?.id,
    emittedKeys: orphanCompanionBreadcrumbs,
  });
  if (!signal) return;

  orphanCompanionBreadcrumbs.add(signal.dedupeKey);
  recordContinuityBreadcrumb(buildMeetingChunkOrphanBreadcrumb(signal.normalizedCompanionSessionId));
}

/**
 * Recover crash-orphaned meeting chunks:
 * if chunk files exist on disk but are not represented in the queue snapshot,
 * re-enqueue them as `meeting-chunk` items.
 */
export async function recoverMissingMeetingChunksFromManifests(): Promise<number> {
  let queueState;
  try {
    queueState = useOfflineQueueStore.getState();
  } catch {
    return 0;
  }

  if (!queueState.isInitialized) return 0;

  const existingChunkKeys = new Set<string>();
  for (const item of queueState.items) {
    if (item.type !== 'meeting-chunk') continue;
    const metadata = normalizeChunkMetadata(item);
    if (!metadata) continue;
    existingChunkKeys.add(getChunkQueueKey(metadata.meetingSessionId, metadata.chunkIndex));
  }

  const manifests = await listMeetingManifests();
  let recoveredCount = 0;

  for (const manifest of manifests) {
    const chunkIndices = await listMeetingChunkIndices(manifest.localId);
    for (const chunkIndex of chunkIndices) {
      if (chunkIndex <= manifest.lastAckedChunkIndex) continue;

      const chunkKey = getChunkQueueKey(manifest.localId, chunkIndex);
      if (existingChunkKeys.has(chunkKey)) continue;

      const chunkUri = getMeetingChunkPath(manifest.localId, chunkIndex);
      const chunkInfo = await FileSystem.getInfoAsync(chunkUri);
      if (!chunkInfo.exists) continue;

      const totalChunks = manifest.totalChunks;
      const isFinalChunk = Boolean(
        typeof totalChunks === 'number'
        && chunkIndex === totalChunks - 1,
      );

      try {
        await queueState.enqueueOrThrow(
          'meeting-chunk',
          chunkUri,
          'm4a',
          {
            meetingSessionId: manifest.localId,
            chunkIndex,
            meetingTitle: manifest.meetingTitle,
            meetingStartTime: manifest.startTime,
            mimeType: 'audio/mp4',
            isFinalChunk,
            totalChunks,
          } satisfies MeetingChunkQueueMetadata,
        );
        existingChunkKeys.add(chunkKey);
        recoveredCount += 1;
      } catch (err) {
        if (err instanceof QueueFullError) {
          log.warn('Queue full during meeting chunk recovery, skipping remaining chunks', {
            manifestId: manifest.localId,
            chunkIndex,
            queueSize: err.maxSize,
          });
          break; // Stop trying to recover more chunks for this manifest
        }
        throw err;
      }
    }
  }

  if (recoveredCount > 0) {
    log.info('Recovered orphaned meeting chunk queue items', { recoveredCount });
  }

  return recoveredCount;
}

export function createMeetingChunkConsumer(): (
  item: QueueItem,
  payloadUri: string | null,
  signal?: AbortSignal,
) => Promise<QueueConsumerResult> {
  return async (item: QueueItem, payloadUri: string | null, signal?: AbortSignal): Promise<QueueConsumerResult> => {
    const metadata = normalizeChunkMetadata(item);
    if (!metadata) {
      return {
        success: false,
        error: 'Invalid meeting chunk metadata',
        errorCategory: 'permanent',
      };
    }

    if (!payloadUri) {
      return {
        success: false,
        error: 'Meeting chunk payload missing',
        errorCategory: 'permanent',
      };
    }

    const { cloudUrl, token } = useAuthStore.getState();
    if (!cloudUrl || !token) {
      return {
        success: false,
        error: 'Not connected to cloud',
        errorCategory: 'auth',
      };
    }

    const manifest = await ensureManifest(metadata);

    // Enforce contiguous upload order by waiting for prior chunk ACKs.
    if (metadata.chunkIndex > manifest.lastAckedChunkIndex + 1) {
      return {
        success: false,
        error: 'Waiting for prior chunk acknowledgement',
        errorCategory: 'defer',
      };
    }

    const cloudSessionId = manifest.cloudSessionId
      || await createCloudMeetingSession(
        cloudUrl,
        token,
        manifest,
        metadata.meetingSessionId,
      ).catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err);
        if (message === 'AUTH_EXPIRED') {
          return 'AUTH_EXPIRED';
        }
        if (message === 'IDEMPOTENCY_CONFLICT') {
          return 'IDEMPOTENCY_CONFLICT';
        }
        return null;
      });

    if (cloudSessionId === 'AUTH_EXPIRED') {
      return {
        success: false,
        error: 'Authentication expired',
        errorCategory: 'auth',
      };
    }
    if (cloudSessionId === 'IDEMPOTENCY_CONFLICT') {
      return {
        success: false,
        error: "Couldn't reuse existing recording — please stop and start a new one",
        errorCategory: 'temporary',
      };
    }
    if (!cloudSessionId) {
      return {
        success: false,
        error: 'Failed to create cloud meeting session',
        errorCategory: 'temporary',
      };
    }

    // Already acknowledged locally (retry replay). Allow the queue item to clear.
    if (metadata.chunkIndex <= manifest.lastAckedChunkIndex) {
      if (metadata.isFinalChunk && metadata.totalChunks && manifest.lastAckedChunkIndex + 1 >= metadata.totalChunks) {
        maybeRecordOrphanCompanionBreadcrumb(metadata.meetingSessionId, manifest.companionSessionId);
        const finalizeResult = await finalizeCloudMeetingSession(
          cloudUrl,
          token,
          cloudSessionId,
          metadata.totalChunks,
          manifest.companionSessionId,
        );
        if (finalizeResult.authError) {
          return {
            success: false,
            error: 'Authentication expired',
            errorCategory: 'auth',
          };
        }
        if (finalizeResult.defer) {
          return {
            success: false,
            error: 'Finalize pending',
            errorCategory: 'defer',
          };
        }
        if (finalizeResult.temporaryError) {
          return {
            success: false,
            error: finalizeResult.temporaryError,
            errorCategory: 'temporary',
          };
        }
        if (!finalizeResult.ok) {
          return {
            success: false,
            error: finalizeResult.permanentError || 'Finalize failed',
            errorCategory: 'permanent',
          };
        }

        // Mark manifest as finalized so the main cleanup path can handle it.
        // Don't delete the session here — if the app crashes before the queue
        // removes this item, a replay with no manifest could create duplicates.
        await updateMeetingManifest(metadata.meetingSessionId, (current) => ({
          ...current,
          finalizedAt: Date.now(),
        }));
      }

      return { success: true };
    }

    // Check abort before upload to avoid orphaned HTTP requests
    if (signal?.aborted) {
      return { success: false, error: 'Processing aborted', errorCategory: 'timeout' };
    }

    const uploadResult = await uploadChunkToCloud(
      cloudUrl,
      token,
      cloudSessionId,
      payloadUri,
      metadata,
    );

    // Check abort after upload — if already committed server-side, return success to clean up
    if (signal?.aborted && uploadResult.ok) {
      log.info('Signal aborted after successful upload, returning success to clean up', {
        meetingSessionId: metadata.meetingSessionId,
        chunkIndex: metadata.chunkIndex,
      });
      return { success: true };
    }

    if (uploadResult.authError) {
      return {
        success: false,
        error: 'Authentication expired',
        errorCategory: 'auth',
      };
    }
    if (uploadResult.defer) {
      // Intentional & pre-existing asymmetry: the upload path maps the helper's
      // attempt-neutral upload-`defer` (5xx) to queue-level `'temporary'`
      // (attempt-incrementing), whereas the finalize path returns `'defer'`
      // (attempt-neutral). This is not a bug — both are bounded (the queue caps
      // at 10 attempts and a ~48h stale sweep), so neither can retry forever.
      return {
        success: false,
        error: 'Chunk upload deferred',
        errorCategory: 'temporary',
      };
    }
    if (uploadResult.temporaryError) {
      return {
        success: false,
        error: uploadResult.temporaryError,
        errorCategory: 'temporary',
      };
    }
    if (!uploadResult.ok) {
      return {
        success: false,
        error: uploadResult.permanentError || 'Chunk upload failed',
        errorCategory: 'permanent',
      };
    }

    const updatedManifest = await updateMeetingManifest(metadata.meetingSessionId, (current) => ({
      ...current,
      cloudSessionId,
      lastAckedChunkIndex: Math.max(current.lastAckedChunkIndex, metadata.chunkIndex),
      nextChunkIndex: Math.max(current.nextChunkIndex, metadata.chunkIndex + 1),
      isStopped: metadata.isFinalChunk ? true : current.isStopped,
      totalChunks: metadata.totalChunks ?? current.totalChunks,
    }));

    if (metadata.isFinalChunk) {
      const totalChunks = metadata.totalChunks
        ?? updatedManifest?.totalChunks
        ?? metadata.chunkIndex + 1;
      const lastAckedChunkIndex = updatedManifest?.lastAckedChunkIndex ?? metadata.chunkIndex;

      if (lastAckedChunkIndex + 1 < totalChunks) {
        return {
          success: false,
          error: 'Final chunk uploaded, waiting for prior chunk acknowledgements',
          errorCategory: 'defer',
        };
      }

      const finalizeResult = await finalizeCloudMeetingSession(
        cloudUrl,
        token,
        cloudSessionId,
        totalChunks,
        updatedManifest?.companionSessionId ?? manifest.companionSessionId,
      );
      maybeRecordOrphanCompanionBreadcrumb(
        metadata.meetingSessionId,
        updatedManifest?.companionSessionId ?? manifest.companionSessionId,
      );

      if (finalizeResult.authError) {
        return {
          success: false,
          error: 'Authentication expired',
          errorCategory: 'auth',
        };
      }
      if (finalizeResult.defer) {
        return {
          success: false,
          error: 'Finalize deferred',
          errorCategory: 'defer',
        };
      }
      if (finalizeResult.temporaryError) {
        return {
          success: false,
          error: finalizeResult.temporaryError,
          errorCategory: 'temporary',
        };
      }
      if (!finalizeResult.ok) {
        return {
          success: false,
          error: finalizeResult.permanentError || 'Finalize failed',
          errorCategory: 'permanent',
        };
      }

      await updateMeetingManifest(metadata.meetingSessionId, (current) => ({
        ...current,
        finalizedAt: Date.now(),
      }));

      // Clean up finalized meeting session from disk
      try {
        await deleteMeetingSession(metadata.meetingSessionId);
      } catch (err) {
        log.warn('Failed to clean up finalized meeting session from disk', {
          error: err instanceof Error ? err.message : String(err),
          meetingSessionId: metadata.meetingSessionId,
        });
      }
    }

    return { success: true };
  };
}
