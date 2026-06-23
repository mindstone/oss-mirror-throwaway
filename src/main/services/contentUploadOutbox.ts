// CORE-MOVE-EXEMPT: Desktop-only outbox driver for content uploads. Lives
// in src/main/ because it depends on the Electron-tier session store and
// the assetUploadOutbox-pattern in-memory queue. Cloud-service does not
// run an outbox — uploads are inbound on that surface.
//
// See docs/plans/260518_cloud_sync_reconciliation_hardening.md § Stage B1a.

import { createScopedLogger } from '@core/logger';
import { getContentStore } from '@core/contentStore';
import { uploadContent, CloudClientError } from '@rebel/cloud-client/cloudClient';
import { getIncrementalSessionStore } from '@core/services/incrementalSessionStore';
import { getErrorReporter } from '@core/errorReporter';
import type { AgentEvent, AgentSession, ContentRef } from '@shared/types';
import { hashSessionIdForBreadcrumb } from '@shared/utils/hashSessionIdForBreadcrumb';
import { fireAndForget } from '@shared/utils/fireAndForget';

const log = createScopedLogger({ service: 'contentUploadOutbox' });
const RETRY_BACKOFFS_MS = [1000, 5000, 25_000, 125_000, 625_000] as const;
const DEAD_LETTER_RETRY_BACKOFFS_MS = [900_000, 3_600_000, 21_600_000] as const;
const STUCK_AGE_THRESHOLD_MS = 7 * 24 * 60 * 60 * 1000;

type OutboxState =
  | 'pending'
  | 'uploading'
  | 'uploaded'
  | 'dead_letter_retryable'
  | 'dead_letter_terminal';

interface QueueItem {
  key: string;
  sessionId: string;
  contentId: string;
  attempt: number;
  deadLetterAttempt: number;
  nextRetryAt: number;
  state: Exclude<OutboxState, 'uploaded'>;
  firstQueuedAt: number;
}

interface StopOptions {
  timeoutMs?: number;
}

export class ContentUploadOutbox {
  private queue: QueueItem[] = [];
  private readonly queuedKeys = new Set<string>();
  private inFlight = 0;
  private readonly maxConcurrent = 4;
  private isRunning = false;
  private isStopping = false;
  private unsubscribeContentWritten?: () => void;
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
        'Failed to scan pending content uploads on boot',
      );
    }

    const contentStore = getContentStore();
    if (contentStore.onContentWritten) {
      this.unsubscribeContentWritten = contentStore.onContentWritten(
        (sessionId, contentId) => {
          this.enqueue(sessionId, contentId);
        },
      );
    }

    this.processQueue();
  }

  async stop(options: StopOptions = {}): Promise<void> {
    if (!this.isRunning) return;
    if (this.stopPromise) return this.stopPromise;

    const timeoutMs = options.timeoutMs ?? 5000;
    this.isStopping = true;

    if (this.unsubscribeContentWritten) {
      this.unsubscribeContentWritten();
      this.unsubscribeContentWritten = undefined;
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
        'Content upload outbox shutdown state',
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

  enqueue(sessionId: string, contentId: string, firstQueuedAt = Date.now()): void {
    if (!this.isRunning || this.isStopping) return;
    const key = this.queueKey(sessionId, contentId);
    if (this.queuedKeys.has(key)) return;

    this.queuedKeys.add(key);
    this.queue.push({
      key,
      sessionId,
      contentId,
      attempt: 0,
      deadLetterAttempt: 0,
      nextRetryAt: 0,
      state: 'pending',
      firstQueuedAt,
    });
    this.processQueue();
  }

  getStatus() {
    return {
      pending: this.queue.length,
      uploading: this.inFlight,
      failedCount: this.failedCount,
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
      this.maybeEscalateStuckUpload(item);
      fireAndForget(this.uploadItem(item).finally(() => {
        this.inFlight = Math.max(0, this.inFlight - 1);
        this.processQueue();
      }), 'contentUploadOutbox.line178');
    }
  }

  private maybeEscalateStuckUpload(item: QueueItem): void {
    const age = Date.now() - item.firstQueuedAt;
    if (age < STUCK_AGE_THRESHOLD_MS) return;
    if (item.state !== 'pending' && item.state !== 'dead_letter_retryable') return;

    try {
      getErrorReporter().addBreadcrumb?.({
        category: 'content-upload-outbox',
        message: 'content-upload-outbox:stuck',
        level: 'warning',
        data: {
          sessionIdHash: hashSessionIdForBreadcrumb(item.sessionId),
          contentIdHash: hashSessionIdForBreadcrumb(item.contentId),
          ageDays: Math.floor(age / (24 * 60 * 60 * 1000)),
          attempts: item.attempt,
          deadLetterAttempts: item.deadLetterAttempt,
          state: item.state,
        },
      });
    } catch (err) {
      log.warn(
        { err: err instanceof Error ? err.message : String(err) },
        'Failed to emit stuck-upload breadcrumb',
      );
    }
  }

  private async bootstrapPendingUploads(): Promise<void> {
    const sessionStore = getIncrementalSessionStore();
    const contentStore = getContentStore();
    const sessions = sessionStore.listSessions({ includeInternal: true });

    for (const summary of sessions) {
      const session = await sessionStore.getSession(summary.id);
      if (!session || !session.eventsByTurn) continue;

      let listedContentIds: string[];
      try {
        listedContentIds = await contentStore.listSessionContent({ sessionId: summary.id });
      } catch (err) {
        log.warn(
          {
            sessionIdHash: hashSessionIdForBreadcrumb(summary.id),
            err: err instanceof Error ? err.message : String(err),
          },
          'Skipping boot content upload scan due to listSessionContent error',
        );
        continue;
      }

      const listedContentSet = new Set(listedContentIds);
      let manifestStatuses: Record<string, 'pending' | 'uploaded' | 'missing'> = {};
      let manifestFirstQueuedAt: Record<string, number | undefined> = {};
      if (contentStore.listSessionContentUploadRecords) {
        try {
          const records = await contentStore.listSessionContentUploadRecords(summary.id);
          manifestStatuses = Object.fromEntries(
            Object.entries(records).map(([contentId, record]) => [contentId, record.uploadStatus]),
          );
          manifestFirstQueuedAt = Object.fromEntries(
            Object.entries(records).map(([contentId, record]) => [contentId, record.firstQueuedAt]),
          );
        } catch (err) {
          log.warn(
            {
              sessionIdHash: hashSessionIdForBreadcrumb(summary.id),
              err: err instanceof Error ? err.message : String(err),
            },
            'Boot content upload scan could not read manifest upload records',
          );
        }
      } else if (contentStore.listSessionContentStatuses) {
        try {
          manifestStatuses = await contentStore.listSessionContentStatuses(summary.id);
        } catch (err) {
          log.warn(
            {
              sessionIdHash: hashSessionIdForBreadcrumb(summary.id),
              err: err instanceof Error ? err.message : String(err),
            },
            'Boot content upload scan could not read manifest statuses',
          );
        }
      }

      for (const contentId of listedContentIds) {
        if (manifestStatuses[contentId] === 'pending') {
          this.enqueue(summary.id, contentId, manifestFirstQueuedAt[contentId] ?? Date.now());
        }
      }

      const pendingFromSession = new Set<string>();
      const missingFromSession = new Set<string>();
      let sessionUpdated = false;
      this.forEachSessionContentRef(session, (ref) => {
        if (!listedContentSet.has(ref.contentId)) {
          if (ref.uploadStatus !== 'missing') {
            ref.uploadStatus = 'missing';
            sessionUpdated = true;
            missingFromSession.add(ref.contentId);
          }
          return;
        }
        if (ref.uploadStatus === 'pending') {
          pendingFromSession.add(ref.contentId);
        }
      });

      for (const contentId of pendingFromSession) {
        this.enqueue(summary.id, contentId, manifestFirstQueuedAt[contentId] ?? Date.now());
      }

      for (const missingContentId of missingFromSession) {
        await this.safeMarkContentFailed(summary.id, missingContentId, 'missing-on-boot-recovery');
      }

      if (sessionUpdated) {
        await sessionStore.upsertSession(session);
      }
    }
  }

  private async uploadItem(item: QueueItem): Promise<void> {
    const contentStore = getContentStore();
    const redacted = this.redact(item.sessionId, item.contentId);
    item.state = 'uploading';
    try {
      const readResult = await contentStore.readContent({
        sessionId: item.sessionId,
        contentId: item.contentId,
      });
      if (readResult.reason !== 'ok') {
        await this.handleTerminalFailure(item, `read-${readResult.reason}`);
        return;
      }

      await uploadContent(
        item.sessionId,
        item.contentId,
        readResult.bytes,
        readResult.mimeType,
      );

      await this.safeMarkContentUploaded(item.sessionId, item.contentId);
      await this.updateSessionUploadStatus(item.sessionId, item.contentId, 'uploaded');
      this.queuedKeys.delete(item.key);
      log.info({ ...redacted }, 'Successfully uploaded content blob');
    } catch (err: unknown) {
      if (err instanceof CloudClientError) {
        const status = err.statusCode;
        if (status && status >= 400 && status < 500 && status !== 408 && status !== 429) {
          await this.handleTerminalFailure(item, `upload-4xx-${status}`);
          return;
        }
      }
      this.scheduleRetry(item, err);
    }
  }

  private scheduleRetry(item: QueueItem, err: unknown): void {
    const redacted = this.redact(item.sessionId, item.contentId);
    if (item.attempt < RETRY_BACKOFFS_MS.length) {
      const retryDelayMs = this.isStopping ? 0 : RETRY_BACKOFFS_MS[item.attempt];
      item.nextRetryAt = Date.now() + retryDelayMs;
      item.attempt += 1;
      item.state = 'pending';
      this.queue.push(item);
      log.warn(
        {
          ...redacted,
          attempt: item.attempt,
          retryDelayMs,
          err: err instanceof Error ? err.message : String(err),
        },
        'Content upload failed; scheduled retry',
      );
      return;
    }

    if (item.deadLetterAttempt < DEAD_LETTER_RETRY_BACKOFFS_MS.length) {
      const retryDelayMs = this.isStopping
        ? 0
        : DEAD_LETTER_RETRY_BACKOFFS_MS[item.deadLetterAttempt];
      item.nextRetryAt = Date.now() + retryDelayMs;
      item.deadLetterAttempt += 1;
      item.state = 'dead_letter_retryable';
      this.queue.push(item);
      log.warn(
        {
          ...redacted,
          deadLetterAttempt: item.deadLetterAttempt,
          retryDelayMs,
          err: err instanceof Error ? err.message : String(err),
        },
        'Content upload exhausted primary retries; entered dead_letter_retryable state',
      );
      return;
    }

    fireAndForget(this.handleTerminalFailure(item, 'upload-retries-exhausted'), 'contentUploadOutbox.line384');
  }

  private async safeMarkContentUploaded(
    sessionId: string,
    contentId: string,
  ): Promise<void> {
    const contentStore = getContentStore();
    if (!contentStore.markContentUploaded) return;
    try {
      await contentStore.markContentUploaded(sessionId, contentId);
    } catch (err) {
      log.warn(
        {
          sessionIdHash: hashSessionIdForBreadcrumb(sessionId),
          contentIdHash: hashSessionIdForBreadcrumb(contentId),
          err: err instanceof Error ? err.message : String(err),
        },
        'Failed to mark content as uploaded in manifest',
      );
    }
  }

  private async safeMarkContentFailed(
    sessionId: string,
    contentId: string,
    reason: string,
  ): Promise<void> {
    const contentStore = getContentStore();
    if (!contentStore.markContentFailed) return;
    try {
      await contentStore.markContentFailed(sessionId, contentId, reason);
    } catch (err) {
      log.warn(
        {
          sessionIdHash: hashSessionIdForBreadcrumb(sessionId),
          contentIdHash: hashSessionIdForBreadcrumb(contentId),
          reason,
          err: err instanceof Error ? err.message : String(err),
        },
        'Failed to mark content as failed in manifest',
      );
    }
  }

  private async handleTerminalFailure(item: QueueItem, reason: string): Promise<void> {
    this.failedCount += 1;
    item.state = 'dead_letter_terminal';
    this.queuedKeys.delete(item.key);
    await this.safeMarkContentFailed(item.sessionId, item.contentId, reason);
    await this.updateSessionUploadStatus(item.sessionId, item.contentId, 'missing');
    const redacted = this.redact(item.sessionId, item.contentId);
    log.warn(
      {
        ...redacted,
        reason,
        attempts: item.attempt,
        deadLetterAttempts: item.deadLetterAttempt,
      },
      'Content upload terminally failed',
    );

    // Stage B1a § MEDIUM #4: terminal upload failure is "data loss for this
    // contentRef" — emit a breadcrumb so the upstream Sentry batch retains
    // context, then capture a structured message so we get a fingerprinted
    // signal in production.
    try {
      const reporter = getErrorReporter();
      reporter.addBreadcrumb?.({
        category: 'content-upload-outbox',
        message: 'content-upload-outbox:terminal-failure',
        level: 'warning',
        data: {
          ...redacted,
          reason,
          attempts: item.attempt,
          deadLetterAttempts: item.deadLetterAttempt,
        },
      });
      reporter.captureMessage?.(
        'content-upload-outbox:terminal-failure',
        {
          level: 'warning',
          tags: { service: 'contentUploadOutbox', reason },
          extra: {
            ...redacted,
            attempts: item.attempt,
            deadLetterAttempts: item.deadLetterAttempt,
          },
        },
      );
    } catch (err) {
      log.warn(
        { err: err instanceof Error ? err.message : String(err) },
        'Failed to emit terminal-failure observability',
      );
    }
  }

  private async updateSessionUploadStatus(
    sessionId: string,
    contentId: string,
    uploadStatus: 'uploaded' | 'missing',
  ): Promise<void> {
    const store = getIncrementalSessionStore();
    const session = await store.getSession(sessionId);
    if (!session || !session.eventsByTurn) return;

    let updated = false;
    for (const events of Object.values(session.eventsByTurn)) {
      for (const event of events) {
        updated = this.updateEventContentRefStatus(event, contentId, uploadStatus) || updated;
      }
    }

    if (updated) {
      await store.upsertSession(session);
    }
  }

  private updateEventContentRefStatus(
    event: AgentEvent,
    contentId: string,
    uploadStatus: 'uploaded' | 'missing',
  ): boolean {
    if (event.type !== 'tool') return false;

    let updated = false;
    if (Array.isArray(event.contentRef)) {
      for (const maybeRef of event.contentRef) {
        if (
          maybeRef
          && maybeRef.contentId === contentId
          && maybeRef.uploadStatus !== uploadStatus
        ) {
          maybeRef.uploadStatus = uploadStatus;
          updated = true;
        }
      }
    }

    if (Array.isArray(event.toolResult?.content)) {
      for (const block of event.toolResult.content) {
        if (!block || typeof block !== 'object' || !('contentRef' in block)) continue;
        const maybeRef = (block as { contentRef?: unknown }).contentRef;
        if (
          maybeRef
          && typeof maybeRef === 'object'
          && 'contentId' in maybeRef
          && (maybeRef as { contentId?: unknown }).contentId === contentId
        ) {
          const typedRef = maybeRef as ContentRef;
          if (typedRef.uploadStatus !== uploadStatus) {
            typedRef.uploadStatus = uploadStatus;
            updated = true;
          }
        }
      }
    }

    return updated;
  }

  private forEachSessionContentRef(
    session: AgentSession,
    visitor: (ref: ContentRef) => void,
  ): void {
    for (const events of Object.values(session.eventsByTurn ?? {})) {
      for (const event of events) {
        if (event.type !== 'tool') continue;

        if (Array.isArray(event.contentRef)) {
          for (const maybeRef of event.contentRef) {
            if (maybeRef && typeof maybeRef.contentId === 'string') {
              visitor(maybeRef);
            }
          }
        }

        if (!Array.isArray(event.toolResult?.content)) continue;
        for (const block of event.toolResult.content) {
          if (!block || typeof block !== 'object' || !('contentRef' in block)) continue;
          const maybeRef = (block as { contentRef?: unknown }).contentRef;
          if (
            maybeRef
            && typeof maybeRef === 'object'
            && 'contentId' in maybeRef
            && typeof (maybeRef as { contentId?: unknown }).contentId === 'string'
          ) {
            visitor(maybeRef as ContentRef);
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
          `Timed out draining content upload outbox (pending=${this.queue.length}, uploading=${this.inFlight})`,
        );
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }

  private queueKey(sessionId: string, contentId: string): string {
    return `${sessionId}::${contentId}`;
  }

  private redact(sessionId: string, contentId: string): {
    sessionIdHash: string;
    contentIdHash: string;
  } {
    return {
      sessionIdHash: hashSessionIdForBreadcrumb(sessionId),
      contentIdHash: hashSessionIdForBreadcrumb(contentId),
    };
  }
}
