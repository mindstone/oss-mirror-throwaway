// CORE-MOVE-EXEMPT: specified in 260516_image_asset_architecture.md Stage 7a
import { createScopedLogger } from '@core/logger';
import { getAssetStore } from '@core/assetStore';
import { uploadAsset, CloudClientError } from '@rebel/cloud-client/cloudClient';
import { getIncrementalSessionStore } from '@core/services/incrementalSessionStore';
import { recordAssetResolutionFailure } from '@core/services/assetResolutionObservability';
import type { AgentEvent, AgentSession, AssetResolutionReason, ImageRef } from '@shared/types';
import { hashSessionIdForBreadcrumb } from '@shared/utils/hashSessionIdForBreadcrumb';
import { fireAndForget } from '@shared/utils/fireAndForget';

const log = createScopedLogger({ service: 'assetUploadOutbox' });
const RETRY_BACKOFFS_MS = [1000, 5000, 25000, 125000, 625000] as const;

function classifyUploadFailureReason(statusCode?: number): AssetResolutionReason {
  if (statusCode === 413) {
    return 'quota-exceeded';
  }
  return 'upload-failed';
}

interface QueueItem {
  key: string;
  sessionId: string;
  assetId: string;
  attempt: number;
  nextRetryAt: number;
}

interface StopOptions {
  timeoutMs?: number;
}

export class AssetUploadOutbox {
  private queue: QueueItem[] = [];
  private readonly queuedKeys = new Set<string>();
  private inFlight = 0;
  private readonly maxConcurrent = 4;
  private isRunning = false;
  private isStopping = false;
  private unsubscribeAssetWritten?: () => void;
  private failedCount = 0;
  private queueTimeout?: NodeJS.Timeout;
  private stopPromise: Promise<void> | null = null;

  async start(): Promise<void> {
    if (this.isRunning) return;
    this.isRunning = true;
    this.isStopping = false;

    try {
      await this.bootstrapPendingUploads();
    } catch (err) {
      log.warn(
        { err: err instanceof Error ? err.message : String(err) },
        'Failed to scan pending image uploads on boot',
      );
    }

    const assetStore = getAssetStore();
    if (assetStore.onAssetWritten) {
      this.unsubscribeAssetWritten = assetStore.onAssetWritten((sessionId, assetId) => {
        this.enqueue(sessionId, assetId);
      });
    }

    this.processQueue();
  }

  async stop(options: StopOptions = {}): Promise<void> {
    if (!this.isRunning) return;
    if (this.stopPromise) return this.stopPromise;

    const timeoutMs = options.timeoutMs ?? 5000;
    this.isStopping = true;

    if (this.unsubscribeAssetWritten) {
      this.unsubscribeAssetWritten();
      this.unsubscribeAssetWritten = undefined;
    }
    if (this.queueTimeout) {
      clearTimeout(this.queueTimeout);
      this.queueTimeout = undefined;
    }

    const now = Date.now();
    for (const item of this.queue) {
      item.nextRetryAt = now;
    }
    this.processQueue();

    this.stopPromise = this.waitForDrain(timeoutMs).finally(() => {
      const finalStatus = this.getStatus();
      log.info(
        {
          pending: finalStatus.pending,
          uploading: finalStatus.uploading,
          failedCount: finalStatus.failedCount,
        },
        'Asset upload outbox shutdown state',
      );
      this.isRunning = false;
      this.isStopping = false;
      this.queue = [];
      this.queuedKeys.clear();
      if (this.queueTimeout) {
        clearTimeout(this.queueTimeout);
        this.queueTimeout = undefined;
      }
      this.stopPromise = null;
    });

    return this.stopPromise;
  }

  enqueue(sessionId: string, assetId: string): void {
    if (!this.isRunning || this.isStopping) {
      return;
    }
    const key = this.queueKey(sessionId, assetId);
    if (this.queuedKeys.has(key)) return;

    this.queuedKeys.add(key);
    this.queue.push({
      key,
      sessionId,
      assetId,
      attempt: 0,
      nextRetryAt: 0,
    });
    this.processQueue();
  }

  getStatus() {
    const pendingSnapshot = this.queue.length;
    const uploadingSnapshot = this.inFlight;
    const failedSnapshot = this.failedCount;
    return {
      pending: pendingSnapshot,
      uploading: uploadingSnapshot,
      failedCount: failedSnapshot,
    };
  }

  private processQueue(): void {
    if (!this.isRunning) return;
    if (this.queueTimeout) {
      clearTimeout(this.queueTimeout);
      this.queueTimeout = undefined;
    }

    while (this.inFlight < this.maxConcurrent) {
      const now = Date.now();
      const nextIndex = this.queue.findIndex((item) => item.nextRetryAt <= now);
      if (nextIndex === -1) {
        if (this.queue.length > 0) {
          const nextTime = Math.min(...this.queue.map((item) => item.nextRetryAt));
          this.queueTimeout = setTimeout(
            () => this.processQueue(),
            Math.max(10, nextTime - Date.now()),
          );
        }
        return;
      }

      const [item] = this.queue.splice(nextIndex, 1);
      this.inFlight += 1;
      fireAndForget(this.uploadItem(item).finally(() => {
        this.inFlight = Math.max(0, this.inFlight - 1);
        this.processQueue();
      }), 'assetUploadOutbox.line166');
    }
  }

  private async bootstrapPendingUploads(): Promise<void> {
    const sessionStore = getIncrementalSessionStore();
    const assetStore = getAssetStore();
    const sessions = sessionStore.listSessions({ includeInternal: true });

    for (const summary of sessions) {
      const session = await sessionStore.getSession(summary.id);
      if (!session || !session.eventsByTurn) continue;

      let listedAssetIds: string[];
      try {
        listedAssetIds = await assetStore.listSessionAssets({ sessionId: summary.id });
      } catch (err) {
        log.warn(
          {
            sessionIdHash: hashSessionIdForBreadcrumb(summary.id),
            err: err instanceof Error ? err.message : String(err),
          },
          'Skipping boot asset upload scan due to listSessionAssets error',
        );
        continue;
      }

      const listedAssetSet = new Set(listedAssetIds);
      let manifestStatuses: Record<string, 'pending' | 'uploaded' | 'missing'> = {};
      if (assetStore.listSessionAssetStatuses) {
        try {
          manifestStatuses = await assetStore.listSessionAssetStatuses(summary.id);
        } catch (err) {
          log.warn(
            {
              sessionIdHash: hashSessionIdForBreadcrumb(summary.id),
              err: err instanceof Error ? err.message : String(err),
            },
            'Boot asset upload scan could not read manifest statuses',
          );
        }
      }

      for (const assetId of listedAssetIds) {
        if (manifestStatuses[assetId] === 'pending') {
          this.enqueue(summary.id, assetId);
        }
      }

      const pendingFromSession = new Set<string>();
      const missingFromSession = new Set<string>();
      let sessionUpdated = false;
      this.forEachSessionImageRef(session, (ref) => {
        if (!listedAssetSet.has(ref.assetId)) {
          if (ref.uploadStatus !== 'missing') {
            ref.uploadStatus = 'missing';
            sessionUpdated = true;
            missingFromSession.add(ref.assetId);
          }
          return;
        }

        if (ref.uploadStatus === 'pending') {
          pendingFromSession.add(ref.assetId);
        }
      });

      for (const assetId of pendingFromSession) {
        this.enqueue(summary.id, assetId);
      }

      for (const missingAssetId of missingFromSession) {
        await this.safeMarkAssetFailed(summary.id, missingAssetId, 'missing-on-boot-recovery');
        recordAssetResolutionFailure({
          sessionId: summary.id,
          assetId: missingAssetId,
          reason: 'not-found',
          context: 'upload',
          metadata: {
            deadLetterReason: 'missing-on-boot-recovery',
          },
          log,
        });
      }

      if (sessionUpdated) {
        await sessionStore.upsertSession(session);
      }
    }
  }

  private async uploadItem(item: QueueItem): Promise<void> {
    const assetStore = getAssetStore();
    const redacted = this.redact(item.sessionId, item.assetId);
    try {
      const readResult = await assetStore.readAsset({ sessionId: item.sessionId, assetId: item.assetId });
      if (readResult.reason !== 'ok') {
        await this.handleTerminalFailure(item, `read-${readResult.reason}`);
        recordAssetResolutionFailure({
          sessionId: item.sessionId,
          assetId: item.assetId,
          reason: readResult.reason,
          context: 'upload',
          metadata: {
            ...redacted,
            deadLetterReason: `read-${readResult.reason}`,
          },
          log,
        });
        return;
      }

      await uploadAsset(item.sessionId, item.assetId, readResult.bytes, readResult.mimeType);

      await this.safeMarkAssetUploaded(item.sessionId, item.assetId);
      await this.updateSessionUploadStatus(item.sessionId, item.assetId, 'uploaded');
      this.queuedKeys.delete(item.key);
      log.info({ ...redacted }, 'Successfully uploaded asset');
    } catch (err: unknown) {
      if (err instanceof CloudClientError) {
        const cloudError = err as CloudClientError;
        const status = cloudError.statusCode;
        if (status && status >= 400 && status < 500 && status !== 408 && status !== 429) {
          await this.handleTerminalFailure(item, `upload-4xx-${status}`);
          recordAssetResolutionFailure({
            sessionId: item.sessionId,
            assetId: item.assetId,
            reason: classifyUploadFailureReason(status),
            context: 'upload',
            metadata: {
              ...redacted,
              status,
              err: cloudError.message,
              deadLetterReason: `upload-4xx-${status}`,
            },
            log,
          });
          return;
        }
      }

      if (item.attempt < RETRY_BACKOFFS_MS.length) {
        const retryDelayMs = this.isStopping ? 0 : RETRY_BACKOFFS_MS[item.attempt];
        item.nextRetryAt = Date.now() + retryDelayMs;
        item.attempt += 1;
        this.queue.push(item);
        log.warn(
          { ...redacted, attempt: item.attempt, retryDelayMs },
          'Upload failed, scheduled retry',
        );
      } else {
        await this.handleTerminalFailure(item, 'upload-retries-exhausted');
        recordAssetResolutionFailure({
          sessionId: item.sessionId,
          assetId: item.assetId,
          reason: 'upload-failed',
          context: 'upload',
          metadata: {
            ...redacted,
            deadLetterReason: 'upload-retries-exhausted',
            attempts: item.attempt,
          },
          log,
        });
      }
    }
  }

  private async safeMarkAssetUploaded(sessionId: string, assetId: string): Promise<void> {
    const assetStore = getAssetStore();
    if (!assetStore.markAssetUploaded) return;
    try {
      await assetStore.markAssetUploaded(sessionId, assetId);
    } catch (err) {
      log.warn(
        {
          sessionIdHash: hashSessionIdForBreadcrumb(sessionId),
          assetIdHash: hashSessionIdForBreadcrumb(assetId),
          err: err instanceof Error ? err.message : String(err),
        },
        'Failed to mark asset as uploaded in manifest',
      );
    }
  }

  private async safeMarkAssetFailed(
    sessionId: string,
    assetId: string,
    reason: string,
  ): Promise<void> {
    const assetStore = getAssetStore();
    if (!assetStore.markAssetFailed) return;
    try {
      await assetStore.markAssetFailed(sessionId, assetId, reason);
    } catch (err) {
      log.warn(
        {
          sessionIdHash: hashSessionIdForBreadcrumb(sessionId),
          assetIdHash: hashSessionIdForBreadcrumb(assetId),
          reason,
          err: err instanceof Error ? err.message : String(err),
        },
        'Failed to mark asset as failed in manifest',
      );
    }
  }

  private async handleTerminalFailure(
    item: QueueItem,
    reason: string,
  ): Promise<void> {
    this.failedCount += 1;
    this.queuedKeys.delete(item.key);
    await this.safeMarkAssetFailed(item.sessionId, item.assetId, reason);
    await this.updateSessionUploadStatus(item.sessionId, item.assetId, 'missing');
  }

  private async updateSessionUploadStatus(
    sessionId: string,
    assetId: string,
    uploadStatus: 'uploaded' | 'missing',
  ): Promise<void> {
    const store = getIncrementalSessionStore();
    const session = await store.getSession(sessionId);
    if (!session || !session.eventsByTurn) return;

    let updated = false;
    for (const events of Object.values(session.eventsByTurn)) {
      for (const event of events) {
        updated = this.updateEventImageRefStatus(event, assetId, uploadStatus) || updated;
      }
    }

    if (updated) {
      await store.upsertSession(session);
    }
  }

  private updateEventImageRefStatus(
    event: AgentEvent,
    assetId: string,
    uploadStatus: 'uploaded' | 'missing',
  ): boolean {
    if (event.type !== 'tool') return false;

    let updated = false;
    if (Array.isArray(event.imageRef)) {
      for (const maybeRef of event.imageRef) {
        if (maybeRef && maybeRef.assetId === assetId && maybeRef.uploadStatus !== uploadStatus) {
          maybeRef.uploadStatus = uploadStatus;
          updated = true;
        }
      }
    }

    if (Array.isArray(event.toolResult?.content)) {
      for (const block of event.toolResult.content) {
        if (!block || typeof block !== 'object' || !('imageRef' in block)) continue;
        const maybeRef = (block as { imageRef?: unknown }).imageRef;
        if (
          maybeRef
          && typeof maybeRef === 'object'
          && 'assetId' in maybeRef
          && (maybeRef as { assetId: string }).assetId === assetId
        ) {
          const typedRef = maybeRef as ImageRef;
          if (typedRef.uploadStatus !== uploadStatus) {
            typedRef.uploadStatus = uploadStatus;
            updated = true;
          }
        }
      }
    }

    return updated;
  }

  private forEachSessionImageRef(
    session: AgentSession,
    visitor: (ref: ImageRef) => void,
  ): void {
    for (const events of Object.values(session.eventsByTurn ?? {})) {
      for (const event of events) {
        if (event.type !== 'tool') continue;

        if (Array.isArray(event.imageRef)) {
          for (const maybeRef of event.imageRef) {
            if (maybeRef && typeof maybeRef.assetId === 'string') {
              visitor(maybeRef);
            }
          }
        }

        if (!Array.isArray(event.toolResult?.content)) continue;
        for (const block of event.toolResult.content) {
          if (!block || typeof block !== 'object' || !('imageRef' in block)) continue;
          const maybeRef = (block as { imageRef?: unknown }).imageRef;
          if (
            maybeRef
            && typeof maybeRef === 'object'
            && 'assetId' in maybeRef
            && typeof (maybeRef as { assetId?: unknown }).assetId === 'string'
          ) {
            visitor(maybeRef as ImageRef);
          }
        }
      }
    }
  }

  private async waitForDrain(timeoutMs: number): Promise<void> {
    const start = Date.now();
    while (this.queue.length > 0 || this.inFlight > 0) {
      if (Date.now() - start >= timeoutMs) {
        throw new Error(
          `Timed out draining asset upload outbox (pending=${this.queue.length}, uploading=${this.inFlight})`,
        );
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }

  private queueKey(sessionId: string, assetId: string): string {
    return `${sessionId}::${assetId}`;
  }

  private redact(sessionId: string, assetId: string): {
    sessionIdHash: string;
    assetIdHash: string;
  } {
    return {
      sessionIdHash: hashSessionIdForBreadcrumb(sessionId),
      assetIdHash: hashSessionIdForBreadcrumb(assetId),
    };
  }
}
