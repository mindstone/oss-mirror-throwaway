// cloud-client/src/offlineQueue/OfflineQueue.ts

import type {
  QueueItem,
  QueueStorageAdapter,
  QueueConsumer,
  QueueConsumerResult,
  QueueItemStatus,
  QueueItemType,
  QueueFullRejection,
  QueueStateSnapshot,
  QueueTransitionEvent,
  DrainOptions,
  DrainSummary,
} from './types';
import { createLogger } from '../utils/logger';

const log = createLogger('OfflineQueue');

/** Defer delay in ms — short pause before re-checking deferred items (10s). */
export const DEFER_DELAY_MS = 10_000;
/** Base backoff delay in ms (first retry after 2s). */
export const BASE_BACKOFF_MS = 2_000;
/** Maximum backoff delay cap (60s). */
export const MAX_BACKOFF_MS = 60_000;
/** After this many consecutive failures, mark as permanent. */
export const MAX_ATTEMPTS_BEFORE_PERMANENT = 10;
/** Fairness budget per drain cycle for meeting chunk uploads. */
export const MEETING_CHUNK_DRAIN_BUDGET = 3;
/** Maximum number of items the queue will hold. New enqueues are rejected above this. */
export const QUEUE_MAX_SIZE = 200;
/** Default per-item processing timeout in ms (90s). */
export const DEFAULT_PROCESSING_TIMEOUT_MS = 90_000;
/** Default initial jitter in ms before drain starts (0 for tests; mobile passes ~2000). */
export const DRAIN_INITIAL_JITTER_MS = 0;
/** Threshold for stuck-processing sweep: items processing for >48h are marked permanent. */
const STUCK_PROCESSING_THRESHOLD_MS = 48 * 3600_000;
/** Number of recent error categories to track for stuck-drain detection. */
const RECENT_ERROR_WINDOW = 3;
/** One-hour threshold used for clock-jump heuristics. */
const CLOCK_JUMP_THRESHOLD_MS = 3600_000;
/** Attempt-neutral defer backoff progression: 10s -> 30s -> 60s cap. */
const NEUTRAL_DEFER_BACKOFF_STEPS_MS = [DEFER_DELAY_MS, 30_000, 60_000] as const;
type TimerHandle = ReturnType<typeof setTimeout>;

function isAttemptNeutralCategory(errorCategory: string | undefined): boolean {
  return errorCategory === 'defer' || errorCategory === 'session-state';
}

function isImmediatePermanentCategory(errorCategory: string | undefined): boolean {
  return errorCategory === 'permanent'
    || errorCategory === 'billing'
    || errorCategory === 'provider-auth';
}

/**
 * Compute exponential backoff: 2s → 4s → 8s → 16s → 32s → 60s cap.
 * `attempts` is 1-based (first failure = attempts 1).
 */
export function computeBackoff(attempts: number): number {
  const exponent = Math.min(attempts - 1, 5);
  const backoff = BASE_BACKOFF_MS * Math.pow(2, exponent);
  return Math.min(backoff, MAX_BACKOFF_MS);
}

export type QueueChangeListener<M extends Record<string, unknown> = Record<string, unknown>> = (
  items: QueueItem<M>[],
  state?: QueueStateSnapshot,
) => void;

/** Configuration options for OfflineQueue constructor. */
export interface OfflineQueueConfig {
  /** Random jitter in ms added before drain starts (default 0 for tests). */
  jitterMs?: number;
  /** Per-item processing timeout in ms (default 90_000). */
  processingTimeoutMs?: number;
  /** Optional timer injection for retry scheduling tests. */
  scheduleTimer?: (cb: () => void, ms: number) => TimerHandle;
  /** Optional paired clear function for injected retry scheduler timers. */
  clearScheduledTimer?: (timer: TimerHandle) => void;
  /** Optional clock injection for deterministic timing tests. */
  now?: () => number;
  /** Optional observability callback fired at key queue transitions. */
  onTransition?: (event: QueueTransitionEvent) => void;
}

/**
 * General-purpose offline queue. Enqueues items with file-URI payloads,
 * drains sequentially through a consumer callback, handles backoff and
 * permanent failure classification.
 *
 * Platform-agnostic: persistence is delegated to QueueStorageAdapter.
 */
export class OfflineQueue<M extends Record<string, unknown> = Record<string, unknown>> {
  private storage: QueueStorageAdapter;
  private consumer: QueueConsumer<M>;
  private items: QueueItem<M>[] = [];
  private draining = false;
  private initialized = false;
  private listeners: Set<QueueChangeListener<M>> = new Set();
  private jitterMs: number;
  private processingTimeoutMs: number;
  private scheduleTimer: (cb: () => void, ms: number) => TimerHandle;
  private clearScheduledTimer: (timer: TimerHandle) => void;
  private now: () => number;
  private scheduledDrainTimer: TimerHandle | null = null;
  private lastDrainIsOnline = false;
  /**
   * itemTypes scope of the most recent drain. The self-rearm preserves this
   * scope so a type-scoped (e.g. background meeting-chunk-only) drain never
   * re-arms an unscoped drain that would pull in excluded types (voice).
   */
  private lastDrainItemTypes: QueueItemType[] | undefined = undefined;
  private onTransition?: (event: QueueTransitionEvent) => void;

  // Queue-level state
  /** Timestamp when the queue last rejected an enqueue due to size cap, or null. */
  queueFullAt: number | null = null;
  /** Timestamp when stuck-drain detection flagged limited connectivity, or null. */
  limitedConnectivityAt: number | null = null;
  /** The cloud URL of the currently-active auth identity, or null. */
  boundCloudUrl: string | null = null;
  /** Recent consumer error categories for stuck-drain detection. */
  private recentErrorCategories: string[] = [];

  constructor(storage: QueueStorageAdapter, consumer: QueueConsumer<M>, config?: OfflineQueueConfig) {
    this.storage = storage;
    this.consumer = consumer;
    this.jitterMs = config?.jitterMs ?? DRAIN_INITIAL_JITTER_MS;
    this.processingTimeoutMs = config?.processingTimeoutMs ?? DEFAULT_PROCESSING_TIMEOUT_MS;
    this.scheduleTimer = config?.scheduleTimer ?? ((cb, ms) => setTimeout(cb, ms));
    this.clearScheduledTimer = config?.clearScheduledTimer ?? ((timer) => clearTimeout(timer));
    this.now = config?.now ?? Date.now;
    this.onTransition = config?.onTransition;
  }

  /**
   * Load persisted queue state and recover stale processing items.
   * Must be called before enqueue/drain.
   */
  async init(): Promise<void> {
    if (this.initialized) return;

    const loaded = (await this.storage.loadSnapshot()) as QueueItem<M>[];

    // Restart recovery: any items stuck in 'processing' (app killed mid-drain)
    // are normalized back to 'pending'. Also repair historical session-state
    // failures that were incorrectly terminalized before this category became
    // attempt-neutral.
    let staleCount = 0;
    let repairedAttemptNeutralCount = 0;
    const retryAt = this.now() + DEFER_DELAY_MS;
    this.items = loaded.map((item) => {
      let next = item;
      if (next.status === 'processing') {
        staleCount += 1;
        next = { ...next, status: 'pending' as QueueItemStatus };
      }
      if (next.isPermanentFailure && isAttemptNeutralCategory(next.errorCategory)) {
        repairedAttemptNeutralCount += 1;
        next = {
          ...next,
          status: 'pending' as QueueItemStatus,
          attempts: 0,
          nextRetryAt: retryAt,
          isPermanentFailure: false,
        };
      }
      return next;
    });

    if (staleCount > 0 || repairedAttemptNeutralCount > 0) {
      if (staleCount > 0) {
        log.info('Recovered stale processing items to pending', { count: staleCount });
      }
      if (repairedAttemptNeutralCount > 0) {
        log.info('Repaired terminalized attempt-neutral queue items', {
          count: repairedAttemptNeutralCount,
        });
      }
      await this.storage.saveSnapshot(this.items);
    }

    const indexedIds = new Set(this.items.map((item) => item.id));
    const payloadIds = await this.storage.listPayloadIds();
    const orphanIds = payloadIds.filter((id) => !indexedIds.has(id));
    if (orphanIds.length > 0) {
      log.warn('Found orphaned payload files, cleaning up', {
        count: orphanIds.length,
        ids: orphanIds,
      });
      for (const id of orphanIds) {
        await this.storage.deletePayload(id);
      }
    }

    this.initialized = true;
    this.notifyListeners();
    log.info('Queue initialized', { itemCount: this.items.length });
  }

  /**
   * Subscribe to queue state changes (items or draining status).
   * Returns an unsubscribe function.
   */
  subscribe(listener: QueueChangeListener<M>): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private notifyListeners(): void {
    const snapshot = [...this.items];
    const stateSnapshot: QueueStateSnapshot = {
      items: snapshot,
      queueFullAt: this.queueFullAt,
      limitedConnectivityAt: this.limitedConnectivityAt,
      authExpiredAt: this.getAuthExpiredAt(),
      boundCloudUrl: this.boundCloudUrl,
    };
    for (const listener of this.listeners) {
      listener(snapshot, stateSnapshot);
    }
  }

  private emitTransition(event: QueueTransitionEvent): void {
    if (!this.onTransition) return;
    try {
      this.onTransition(event);
    } catch (err) {
      log.warn('Queue transition callback threw', {
        message: event.message,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /** Derive authExpiredAt: latest enqueuedAt from items with auth error matching current identity. */
  private getAuthExpiredAt(): number | null {
    const authItems = this.authExpiredItems();
    if (authItems.length === 0) return null;
    return Math.max(...authItems.map((i) => i.enqueuedAt));
  }

  /**
   * Add a new item to the queue. If a payload URI is provided, saves the payload
   * file first (save-first pattern), then creates the queue item and persists the index.
   *
   * Returns a `QueueFullRejection` if the queue has reached its size cap.
   */
  async enqueue(
    type: QueueItemType,
    sourceUri: string | null,
    ext: string | null,
    metadata: M,
    enqueueBoundCloudUrl?: string,
  ): Promise<QueueItem<M> | QueueFullRejection> {
    // Queue size cap — reject without persisting
    if (this.items.length >= QUEUE_MAX_SIZE) {
      this.queueFullAt = this.now();
      log.warn('Queue full, rejecting enqueue', { currentSize: this.items.length, maxSize: QUEUE_MAX_SIZE, type });
      this.emitTransition({
        message: 'queue-full',
        level: 'warning',
        data: { totalSize: this.items.length, rejectedItemType: type },
      });
      this.notifyListeners();
      return { accepted: false, reason: 'queue-full', maxSize: QUEUE_MAX_SIZE };
    }

    const id = generateId();

    const item: QueueItem<M> = {
      id,
      type,
      status: 'pending',
      enqueuedAt: this.now(),
      attempts: 0,
      nextRetryAt: 0,
      isPermanentFailure: false,
      payloadExt: ext ?? undefined,
      metadata,
      boundCloudUrl: enqueueBoundCloudUrl ?? this.boundCloudUrl ?? undefined,
    };

    try {
      const payloadUri =
        sourceUri && ext
          ? await this.storage.savePayloadFromUri(id, sourceUri, ext)
          : undefined;
      item.payloadUri = payloadUri;
      this.items.push(item);
      await this.storage.saveSnapshot(this.items);
    } catch (err) {
      // Roll back: remove from in-memory queue, delete payload file
      this.items = this.items.filter((i) => i.id !== id);
      await this.storage.deletePayload(id).catch(() => {});
      log.error('Failed to enqueue item, rolled back', { err: err instanceof Error ? err.message : String(err), id });
      throw err;
    }

    this.notifyListeners();
    log.info('Enqueued item', { id, type });
    this.emitTransition({
      message: 'enqueue',
      data: { itemId: id, type, totalSize: this.items.length },
    });
    return item;
  }

  /**
   * Add a new item with a JSON payload (e.g., text-with-attachments).
   * Persists JSON via `saveJsonPayload`, not file-URI based `savePayloadFromUri`.
   *
   * Returns a `QueueFullRejection` if the queue has reached its size cap.
   */
  async enqueueWithJsonPayload(
    type: QueueItemType,
    jsonPayload: unknown,
    metadata: M,
    enqueueBoundCloudUrl?: string,
  ): Promise<QueueItem<M> | QueueFullRejection> {
    // Queue size cap — reject without persisting
    if (this.items.length >= QUEUE_MAX_SIZE) {
      this.queueFullAt = this.now();
      log.warn('Queue full, rejecting enqueue', { currentSize: this.items.length, maxSize: QUEUE_MAX_SIZE, type });
      this.emitTransition({
        message: 'queue-full',
        level: 'warning',
        data: { totalSize: this.items.length, rejectedItemType: type },
      });
      this.notifyListeners();
      return { accepted: false, reason: 'queue-full', maxSize: QUEUE_MAX_SIZE };
    }

    const id = generateId();

    const item: QueueItem<M> = {
      id,
      type,
      status: 'pending',
      enqueuedAt: this.now(),
      attempts: 0,
      nextRetryAt: 0,
      isPermanentFailure: false,
      boundCloudUrl: enqueueBoundCloudUrl ?? this.boundCloudUrl ?? undefined,
      metadata,
    };

    try {
      await this.storage.saveJsonPayload(id, jsonPayload);
      this.items.push(item);
      await this.storage.saveSnapshot(this.items);
    } catch (err) {
      // Roll back: remove from in-memory queue, delete JSON payload
      this.items = this.items.filter((i) => i.id !== id);
      await this.storage.deleteJsonPayload(id).catch(() => {});
      log.error('Failed to enqueue item with JSON payload, rolled back', { err: err instanceof Error ? err.message : String(err), id });
      throw err;
    }

    this.notifyListeners();
    log.info('Enqueued item with JSON payload', { id, type });
    this.emitTransition({
      message: 'enqueue',
      data: { itemId: id, type, totalSize: this.items.length },
    });
    return item;
  }

  /**
   * Load a JSON payload for a queue item. Delegates to storage adapter.
   */
  async loadJsonPayload<T = unknown>(id: string): Promise<T | null> {
    return this.storage.loadJsonPayload<T>(id);
  }

  /**
   * Bind the current auth identity. Items enqueued after this call are tagged
   * with the given cloudUrl. Drain skips items whose boundCloudUrl doesn't match.
   */
  bindAuthIdentity(cloudUrl: string | null): void {
    this.boundCloudUrl = cloudUrl;
    log.info('Auth identity bound', { cloudUrl: cloudUrl ?? '(none)' });
    this.logMismatchedIdentityItems();
    this.notifyListeners();
  }

  /** Warn when the active identity doesn't match queued items still on disk. */
  private logMismatchedIdentityItems(): void {
    if (!this.boundCloudUrl) return;

    const mismatchedItems = this.items.filter(
      (item) => item.boundCloudUrl && item.boundCloudUrl !== this.boundCloudUrl,
    );
    if (mismatchedItems.length === 0) return;

    const mismatchedCloudUrls = Array.from(
      new Set(mismatchedItems.map((item) => item.boundCloudUrl).filter((value): value is string => Boolean(value))),
    );

    log.warn('Queue has items bound to a different identity', {
      currentCloudUrl: this.boundCloudUrl,
      mismatchedCount: mismatchedItems.length,
      mismatchedCloudUrls,
      oldestMismatchedEnqueuedAt: Math.min(...mismatchedItems.map((item) => item.enqueuedAt)),
    });
  }

  /**
   * Returns items with `errorCategory === 'auth'` that belong to the current identity.
   */
  authExpiredItems(): QueueItem<M>[] {
    if (!this.boundCloudUrl) return [];
    return this.items.filter(
      (item) =>
        item.errorCategory === 'auth' &&
        item.boundCloudUrl === this.boundCloudUrl,
    );
  }

  /**
   * Process due items sequentially. Skips if offline or already draining (mutex).
   * Items with `nextRetryAt` in the future or `isPermanentFailure` are skipped.
   *
   * Returns a `DrainSummary` describing what happened. Background-drain
   * callers (`expo-background-fetch` etc.) use this to map to the correct
   * OS `BackgroundFetchResult`. Foreground callers that don't care about
   * the result can continue to ignore the return value.
   *
   * `options` is optional:
   *   - `maxDurationMs`     — bail out once elapsed exceeds this
   *   - `processingTimeoutMs` — per-item consumer timeout override
   *   - `itemTypes`         — restrict drain to specific types (used by
   *                           background drain to stay on idempotent items)
   */
  async drain(isOnline: boolean, options?: DrainOptions): Promise<DrainSummary> {
    this.lastDrainIsOnline = isOnline;
    this.lastDrainItemTypes = options?.itemTypes;
    const drainStartedAt = this.now();
    const maxDurationMs = options?.maxDurationMs;
    const perItemTimeoutMs = options?.processingTimeoutMs ?? this.processingTimeoutMs;
    const allowedTypes = options?.itemTypes;

    if (!isOnline) {
      this.rearmScheduledDrain();
      log.debug('Drain skipped: offline');
      return {
        attempted: 0, drained: 0, failed: 0, skipped: 0,
        terminalized: 0, authFailures: 0,
        authBlocked: false, durationMs: 0, budgetExceeded: false,
        skippedAlreadyDraining: false, skippedOffline: true,
      };
    }
    if (this.draining) {
      log.debug('Drain skipped: already draining');
      return {
        attempted: 0, drained: 0, failed: 0, skipped: 0,
        terminalized: 0, authFailures: 0,
        authBlocked: false, durationMs: 0, budgetExceeded: false,
        skippedAlreadyDraining: true, skippedOffline: false,
      };
    }

    let drainedCount = 0;
    let failedCount = 0;
    let skippedCount = 0;
    let attemptedCount = 0;
    let terminalizedCount = 0;
    let authFailuresCount = 0;
    let budgetExceeded = false;
    const identityMismatchCounts = new Map<string, number>();

    this.draining = true;
    this.notifyListeners();
    const pendingCountAtStart = this.items.filter((item) => item.status === 'pending' && !item.isPermanentFailure).length;
    log.info('Drain started', { itemCount: this.items.length, pendingCount: pendingCountAtStart });
    this.emitTransition({
      message: 'drain-start',
      data: { pendingCount: pendingCountAtStart, onlineStatus: isOnline },
    });

    try {
      // Jitter: random delay before processing to avoid thundering herd.
      // Background drains skip jitter to preserve their budget.
      if (this.jitterMs > 0 && maxDurationMs === undefined) {
        await new Promise((resolve) => setTimeout(resolve, Math.random() * this.jitterMs));
      }

      const now = this.now();

      // Age-based stale sweep. Runs before due-item processing so items that
      // have exceeded their active retry window do not keep cycling forever.
      // When a drain is type-scoped (background drains), only sweep items in
      // that same scope.
      terminalizedCount += this.sweepStaleItems(now, allowedTypes);

      // Clock-jump guard: recompute nextRetryAt for items with suspiciously future timestamps
      this.guardClockJumps(now);

      // Snapshot due items at drain start. New items enqueued during drain
      // will be picked up on the next drain cycle.
      const dueItems = this.items.filter(
        (item) =>
          item.status === 'pending' &&
          !item.isPermanentFailure &&
          item.nextRetryAt <= now &&
          (!allowedTypes || allowedTypes.includes(item.type)),
      );

      let meetingChunkProcessed = 0;
      let hadNetworkError = false;
      let hadNonNetworkSuccess = false;

      for (const dueItem of dueItems) {
        // Budget check: hard stop when maxDurationMs is set and elapsed exceeds it.
        if (maxDurationMs !== undefined && this.now() - drainStartedAt >= maxDurationMs) {
          budgetExceeded = true;
          log.info('Drain budget exceeded — stopping', {
            budgetMs: maxDurationMs,
            elapsedMs: this.now() - drainStartedAt,
            remainingDue: dueItems.length - attemptedCount,
          });
          break;
        }
        // Auth-identity filtering: skip items bound to a different identity
        if (dueItem.boundCloudUrl && dueItem.boundCloudUrl !== this.boundCloudUrl) {
          skippedCount += 1;
          const mismatchKey = dueItem.boundCloudUrl;
          identityMismatchCounts.set(mismatchKey, (identityMismatchCounts.get(mismatchKey) ?? 0) + 1);
          log.debug('Skipping item bound to different identity', {
            id: dueItem.id,
            itemCloudUrl: dueItem.boundCloudUrl,
            currentCloudUrl: this.boundCloudUrl,
          });
          continue;
        }

        if (dueItem.type === 'meeting-chunk') {
          if (meetingChunkProcessed >= MEETING_CHUNK_DRAIN_BUDGET) {
            skippedCount += 1;
            continue;
          }
          meetingChunkProcessed += 1;
        }

        // Re-check: item may have been removed during drain (e.g., user removed it).
        const current = this.items.find((i) => i.id === dueItem.id);
        if (!current || current.status !== 'pending') continue;

        attemptedCount += 1;

        // Mark as processing
        current.status = 'processing';
        current.processingStartedAt = this.now();
        await this.storage.saveSnapshot(this.items);
        this.notifyListeners();

        const hasPayload = Boolean(current.payloadUri || current.payloadExt);
        const payloadUri = hasPayload
          ? await this.storage.getPayloadUri(dueItem.id)
          : null;

        try {
          // Per-item processing timeout with AbortSignal for cancellation.
          // Background-drain callers pass a shorter `processingTimeoutMs`
          // via DrainOptions to fit within an iOS/Android budget.
          //
          // When a `maxDurationMs` budget is set, clamp the per-item timeout
          // to the remaining budget so a single slow item cannot push us past
          // the OS ceiling (iOS ~30s, Android varies). This is the second
          // line of defense after the pre-item budget check.
          let effectiveItemTimeoutMs = perItemTimeoutMs;
          if (maxDurationMs !== undefined) {
            const remaining = maxDurationMs - (this.now() - drainStartedAt);
            effectiveItemTimeoutMs = Math.max(1, Math.min(perItemTimeoutMs, remaining));
          }
          const controller = new AbortController();
          const result = await this.withProcessingTimeout(
            this.consumer(current as QueueItem<M>, payloadUri, controller.signal),
            controller,
            effectiveItemTimeoutMs,
          );

          if (result.success) {
            // Success: remove from queue + delete payload(s)
            this.items = this.items.filter((i) => i.id !== dueItem.id);
            if (hasPayload) {
              await this.storage.deletePayload(dueItem.id);
            }
            // Always attempt JSON payload cleanup (no-op if absent)
            await this.storage.deleteJsonPayload(dueItem.id);
            await this.storage.saveSnapshot(this.items);
            this.notifyListeners();
            log.info('Item processed successfully', { id: dueItem.id, type: dueItem.type });
            hadNonNetworkSuccess = true;
            drainedCount += 1;
          } else if (isAttemptNeutralCategory(result.errorCategory)) {
            // Attempt-neutral: reset to pending with short delay, do NOT increment attempts.
            // Continues to next item in the same drain cycle (prevents head-of-line blocking).
            const neutralDeferBackoffMs = nextNeutralDeferBackoffMs(current.neutralDeferBackoffMs);
            current.status = 'pending';
            current.nextRetryAt = this.now() + neutralDeferBackoffMs;
            current.lastError = result.error;
            current.errorCategory = result.errorCategory;
            current.neutralDeferBackoffMs = neutralDeferBackoffMs;
            await this.storage.saveSnapshot(this.items);
            this.notifyListeners();
            log.info('Item deferred, will re-check later', {
              id: dueItem.id,
              type: dueItem.type,
              errorCategory: result.errorCategory,
              nextRetryIn: neutralDeferBackoffMs,
            });
          } else {
            current.neutralDeferBackoffMs = undefined;
            const wasTerminalized = this.applyFailure(current, result.error, result.errorCategory);
            failedCount += 1;
            if (wasTerminalized) terminalizedCount += 1;
            if (result.errorCategory === 'auth') authFailuresCount += 1;
            // Track error category for stuck-drain detection
            if (result.errorCategory) {
              this.trackErrorCategory(result.errorCategory);
              if (result.errorCategory === 'network') hadNetworkError = true;
            }
          }
        } catch (err) {
          // Consumer threw: treat as transient failure
          const errorMessage = err instanceof Error ? err.message : String(err);
          current.neutralDeferBackoffMs = undefined;
          const wasTerminalized = this.applyFailure(current, errorMessage);
          failedCount += 1;
          if (wasTerminalized) terminalizedCount += 1;
          log.error('Consumer threw error', { id: dueItem.id, error: errorMessage });
        }
      }

      // Emit one warning per mismatched cloud URL per drain cycle.
      for (const [mismatchedCloudUrl, itemCount] of identityMismatchCounts.entries()) {
        log.warn('Skipping items bound to a different identity during drain', {
          boundCloudUrl: mismatchedCloudUrl,
          activeCloudUrl: this.boundCloudUrl,
          itemCount,
        });
        this.emitTransition({
          message: 'identity-mismatch',
          level: 'warning',
          data: { itemCount },
        });
      }

      // Stuck-drain detection: if ≥3 of the last 3 entries are 'network', flag limited connectivity
      this.updateLimitedConnectivity(hadNetworkError, hadNonNetworkSuccess);

      // Reset queueFullAt if items drained below cap
      if (this.queueFullAt !== null && this.items.length < QUEUE_MAX_SIZE) {
        this.queueFullAt = null;
      }
    } finally {
      this.draining = false;
      this.rearmScheduledDrain();
      this.notifyListeners();
      log.info('Drain completed', {
        remainingItems: this.items.length,
        drainedCount,
        failedCount,
        skippedCount,
      });
      this.emitTransition({
        message: 'drain-complete',
        data: { drainedCount, failedCount, skippedCount },
      });
    }
    return {
      attempted: attemptedCount,
      drained: drainedCount,
      failed: failedCount,
      skipped: skippedCount,
      terminalized: terminalizedCount,
      authFailures: authFailuresCount,
      authBlocked: false,
      durationMs: this.now() - drainStartedAt,
      budgetExceeded,
      skippedAlreadyDraining: false,
      skippedOffline: false,
    };
  }

  private rearmScheduledDrain(): void {
    if (this.scheduledDrainTimer) {
      this.clearScheduledTimer(this.scheduledDrainTimer);
      this.scheduledDrainTimer = null;
    }
    if (!this.lastDrainIsOnline) return;

    // Preserve the scope of the drain that armed us: a type-scoped (e.g.
    // background meeting-chunk-only) drain must not re-arm an unscoped drain
    // that would pull in excluded types (voice). By construction, not by
    // relying on the RN background timer-suspension as an implicit guard.
    const allowedTypes = this.lastDrainItemTypes;
    const now = this.now();
    let earliestRetryAt: number | null = null;
    for (const item of this.items) {
      if (item.status !== 'pending') continue;
      if (item.isPermanentFailure) continue;
      if (item.nextRetryAt <= now) continue;
      if (allowedTypes && !allowedTypes.includes(item.type)) continue;
      if (item.boundCloudUrl && item.boundCloudUrl !== this.boundCloudUrl) continue;
      earliestRetryAt = earliestRetryAt === null
        ? item.nextRetryAt
        : Math.min(earliestRetryAt, item.nextRetryAt);
    }
    if (earliestRetryAt === null) return;

    const scheduledOnline = this.lastDrainIsOnline;
    const scheduledItemTypes = allowedTypes;
    const delayMs = Math.max(0, earliestRetryAt - now);
    const timer = this.scheduleTimer(() => {
      this.scheduledDrainTimer = null;
      void this.drain(scheduledOnline, scheduledItemTypes ? { itemTypes: scheduledItemTypes } : undefined);
    }, delayMs);
    if (typeof (timer as { unref?: unknown }).unref === 'function') {
      (timer as { unref: () => void }).unref();
    }
    this.scheduledDrainTimer = timer;
  }

  /**
   * Wrap a consumer promise with a processing timeout.
   * On timeout, aborts the signal and returns a timeout failure result.
   * This prevents orphaned consumer promises from causing side effects.
   */
  private withProcessingTimeout(
    consumerPromise: Promise<QueueConsumerResult>,
    controller: AbortController,
    timeoutMs: number = this.processingTimeoutMs,
  ): Promise<QueueConsumerResult> {
    return new Promise<QueueConsumerResult>((resolve) => {
      const timer = setTimeout(() => {
        controller.abort();
        resolve({
          success: false,
          error: `Processing timed out after ${timeoutMs / 1000}s`,
          errorCategory: 'timeout',
        });
      }, timeoutMs);

      consumerPromise.then(
        (result) => {
          clearTimeout(timer);
          resolve(result);
        },
        (err) => {
          clearTimeout(timer);
          // Let the caller's catch handle thrown errors
          resolve({
            success: false,
            error: err instanceof Error ? err.message : String(err),
            errorCategory: 'temporary',
          });
        },
      );
    });
  }

  /**
   * Sweep items whose active retry window is older than 48 hours.
   * Manual retry refreshes `staleSweepAnchorAt`, while `enqueuedAt` remains
   * the original queue age for diagnostics and UI.
   */
  private sweepStaleItems(now: number, allowedTypes?: QueueItemType[]): number {
    let swept = 0;
    for (const item of this.items) {
      if (item.isPermanentFailure) continue;
      if (allowedTypes && !allowedTypes.includes(item.type)) continue;
      const staleSweepAnchorAt = item.staleSweepAnchorAt ?? item.enqueuedAt;
      if (now - staleSweepAnchorAt > STUCK_PROCESSING_THRESHOLD_MS) {
        item.status = 'pending';
        item.isPermanentFailure = true;
        item.errorCategory = 'timeout';
        item.lastError = 'Item could not be sent after 48 hours';
        this.emitTransition({
          message: 'item-permanent-failure',
          level: 'warning',
          data: {
            itemId: item.id,
            type: item.type,
            errorCategory: 'timeout',
            attempts: item.attempts ?? 0,
          },
        });
        swept += 1;
      }
    }
    if (swept > 0) {
      log.warn('Swept stale items to permanent failure', { count: swept });
      void this.storage.saveSnapshot(this.items).catch((err) => {
        log.error('Failed to persist queue state', {
          error: err instanceof Error ? err.message : String(err),
          operation: 'sweepStaleItems',
        });
      });
      this.notifyListeners();
    }
    return swept;
  }

  /**
   * Clock-jump guard: if an item's nextRetryAt is suspiciously far in the future
   * (more than MAX_BACKOFF_MS + 60s), clamp it to a safe retry window.
   * - Backward jump (>1h): re-anchor to now + retryDelay
   * - Forward jump / stale future timestamp: snap to now
   */
  private guardClockJumps(now: number): void {
    const threshold = now + MAX_BACKOFF_MS + 60_000;
    let fixed = 0;
    for (const item of this.items) {
      if (item.status !== 'pending' || item.isPermanentFailure) continue;
      if (item.nextRetryAt > threshold) {
        const oldNextRetryAt = item.nextRetryAt;
        const retryDelayMs = computeBackoff(Math.max(item.attempts, 1));

        if (item.enqueuedAt - now > CLOCK_JUMP_THRESHOLD_MS) {
          item.nextRetryAt = now + retryDelayMs;
          log.warn('Backward clock jump detected, re-anchored nextRetryAt', {
            id: item.id,
            enqueuedAt: item.enqueuedAt,
            oldNextRetryAt,
            newNextRetryAt: item.nextRetryAt,
            retryDelayMs,
          });
        } else {
          item.nextRetryAt = now;
          log.warn('Clock jump detected, snapped nextRetryAt to now', {
            id: item.id,
            oldNextRetryAt,
            newNextRetryAt: item.nextRetryAt,
          });
        }

        this.emitTransition({
          message: 'clock-jump-guard',
          level: 'info',
          data: {
            itemId: item.id,
            oldNextRetryAt,
            newNextRetryAt: item.nextRetryAt,
          },
        });
        fixed += 1;
      }
    }
    if (fixed > 0) {
      void this.storage.saveSnapshot(this.items).catch((err) => {
        log.error('Failed to persist queue state', {
          error: err instanceof Error ? err.message : String(err),
          operation: 'guardClockJumps',
        });
      });
    }
  }

  /** Track an error category for stuck-drain detection. */
  private trackErrorCategory(category: string): void {
    this.recentErrorCategories.push(category);
    if (this.recentErrorCategories.length > RECENT_ERROR_WINDOW) {
      this.recentErrorCategories = this.recentErrorCategories.slice(-RECENT_ERROR_WINDOW);
    }
  }

  /** Update limitedConnectivityAt based on recent error history. */
  private updateLimitedConnectivity(hadNetworkError: boolean, hadSuccess: boolean): void {
    if (hadSuccess) {
      // At least one item succeeded — connectivity is fine
      this.limitedConnectivityAt = null;
      return;
    }
    const recentNetworkErrors = this.recentErrorCategories
      .slice(-RECENT_ERROR_WINDOW)
      .filter((c) => c === 'network').length;
    if (recentNetworkErrors >= RECENT_ERROR_WINDOW) {
      if (this.limitedConnectivityAt === null) {
        this.limitedConnectivityAt = this.now();
        const pendingItems = this.items.filter((i) => i.status === 'pending');
        const enqueuedAtValues = this.items.map((i) => i.enqueuedAt);
        const oldestEnqueuedAt = enqueuedAtValues.length > 0 ? Math.min(...enqueuedAtValues) : null;
        log.warn('Stuck-drain detected: consecutive network errors', {
          recentErrorCategories: this.recentErrorCategories,
          pendingCount: pendingItems.length,
          oldestEnqueuedAt,
          boundCloudUrl: this.boundCloudUrl,
        });
        this.emitTransition({
          message: 'stuck-drain',
          level: 'warning',
          data: {
            errorCategories: [...this.recentErrorCategories],
            pendingCount: pendingItems.length,
            oldestEnqueuedAt,
          },
        });
      }
    } else if (!hadNetworkError) {
      this.limitedConnectivityAt = null;
    }
  }

  /**
   * Apply failure backoff to an item. Increments attempts, computes next retry time,
   * and marks as permanent failure after MAX_ATTEMPTS_BEFORE_PERMANENT.
   */
  private applyFailure(
    item: QueueItem<M>,
    error?: string,
    errorCategory?: string,
  ): boolean {
    const attempts = item.attempts + 1;
    const isPermanentFailure =
      attempts >= MAX_ATTEMPTS_BEFORE_PERMANENT
      || isImmediatePermanentCategory(errorCategory);
    const backoff = isPermanentFailure ? 0 : computeBackoff(attempts);

    item.status = 'pending';
    item.attempts = attempts;
    item.nextRetryAt = isPermanentFailure ? 0 : this.now() + backoff;
    item.lastError = error;
    item.errorCategory = errorCategory;
    item.isPermanentFailure = isPermanentFailure;

    // Persist for crash safety. Caller may also persist after this returns.
    void this.storage.saveSnapshot(this.items).catch((err) => {
      log.error('Failed to persist queue state', {
        error: err instanceof Error ? err.message : String(err),
        operation: 'applyFailure',
      });
    });
    this.notifyListeners();

    if (isPermanentFailure) {
      log.warn('Item marked as permanent failure', {
        id: item.id,
        type: item.type,
        attempts,
        errorCategory,
        lastError: error,
      });
      this.emitTransition({
        message: 'item-permanent-failure',
        level: 'warning',
        data: {
          itemId: item.id,
          type: item.type,
          errorCategory: errorCategory ?? null,
          attempts,
        },
      });
    } else {
      log.info('Item failed, will retry', {
        id: item.id,
        attempts,
        nextRetryIn: backoff,
        error,
      });
    }

    if (errorCategory === 'auth') {
      this.emitTransition({
        message: 'auth-expired',
        level: 'warning',
        data: { pendingCount: this.authExpiredItems().length },
      });
    }

    return isPermanentFailure;
  }

  /**
   * Manual retry: resets backoff, attempts, and permanent failure flag.
   * Item becomes immediately eligible for the next drain cycle.
   */
  async retryItem(id: string): Promise<void> {
    const item = this.items.find((i) => i.id === id);
    if (!item) return;

    item.status = 'pending';
    item.nextRetryAt = 0;
    item.attempts = 0;
    item.isPermanentFailure = false;
    item.processingStartedAt = undefined;
    item.staleSweepAnchorAt = this.now();
    item.lastError = undefined;
    item.errorCategory = undefined;
    item.neutralDeferBackoffMs = undefined;

    await this.storage.saveSnapshot(this.items);
    this.notifyListeners();
    log.info('Item retry reset', { id });
  }

  /** Remove a single item and its payload(s) — both media and JSON. */
  async removeItem(id: string): Promise<void> {
    const item = this.items.find((i) => i.id === id);
    if (!item) return;

    this.items = this.items.filter((i) => i.id !== id);
    await this.storage.deletePayload(id);
    await this.storage.deleteJsonPayload(id);
    await this.storage.saveSnapshot(this.items);
    this.notifyListeners();
    log.info('Item removed', { id });
  }

  /** Remove all items and their payloads (media + JSON). Used for privacy clear on logout. */
  async clearAll(): Promise<void> {
    const ids = this.items.map((i) => i.id);
    this.items = [];

    for (const id of ids) {
      await this.storage.deletePayload(id);
      await this.storage.deleteJsonPayload(id);
    }
    await this.storage.saveSnapshot(this.items);
    this.notifyListeners();
    log.info('Queue cleared', { removedCount: ids.length });
  }

  /** Get a snapshot of current queue items (defensive copy). */
  getItems(): QueueItem<M>[] {
    return [...this.items];
  }

  /** Whether a drain is currently in progress. */
  getIsDraining(): boolean {
    return this.draining;
  }

  /** Clear any queue-owned timers. */
  dispose(): void {
    if (!this.scheduledDrainTimer) return;
    this.clearScheduledTimer(this.scheduledDrainTimer);
    this.scheduledDrainTimer = null;
  }
}

function nextNeutralDeferBackoffMs(previousBackoffMs: number | undefined): number {
  if (previousBackoffMs === undefined) return NEUTRAL_DEFER_BACKOFF_STEPS_MS[0];
  const currentIndex = NEUTRAL_DEFER_BACKOFF_STEPS_MS.indexOf(
    previousBackoffMs as (typeof NEUTRAL_DEFER_BACKOFF_STEPS_MS)[number],
  );
  if (currentIndex < 0) return NEUTRAL_DEFER_BACKOFF_STEPS_MS[0];
  return NEUTRAL_DEFER_BACKOFF_STEPS_MS[Math.min(
    currentIndex + 1,
    NEUTRAL_DEFER_BACKOFF_STEPS_MS.length - 1,
  )];
}

function generateId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}
