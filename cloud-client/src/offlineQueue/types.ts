// cloud-client/src/offlineQueue/types.ts

/**
 * Simplified 3-state lifecycle: pending → processing → removed on success.
 * Failures return to pending with backoff metadata.
 */
export type QueueItemStatus = 'pending' | 'processing';
export type QueueItemType =
  | 'voice-transcription'
  | 'text-message'
  | 'text-with-attachments'
  | 'meeting-recording'
  | 'meeting-chunk'
  | 'feedback';

/**
 * Canonical queue error categories. Includes known values plus a permissive
 * string fallback for forward compatibility with custom consumers.
 */
export type QueueErrorCategory =
  | 'auth'
  | 'network'
  | 'disk-full'
  | 'queue-full'
  | 'timeout'
  | 'defer'
  | 'permanent'
  | 'temporary'
  | 'session-state'
  | 'billing'
  | 'provider-auth'
  | 'provider-error'
  | (string & {});

/**
 * A single item in the offline queue. Generic metadata `M` allows consumers
 * to attach domain-specific data (e.g., sessionId, duration for voice).
 */
export interface QueueItem<M extends Record<string, unknown> = Record<string, unknown>> {
  id: string;
  type: QueueItemType;
  status: QueueItemStatus;
  enqueuedAt: number;
  attempts: number;
  nextRetryAt: number;
  lastError?: string;
  /**
   * Canonical error category values:
   * - `'auth'`      — 401/403, token expired or invalid
   * - `'network'`   — connectivity failure, DNS, TCP timeout
   * - `'disk-full'` — insufficient local storage
   * - `'queue-full'`— queue size cap reached (item was rejected, not persisted)
   * - `'timeout'`   — processing exceeded per-item timeout
   * - `'defer'`     — consumer requested short deferral (does not increment attempts)
   * - `'permanent'` — genuinely-unrecoverable failure: a specific 4xx where
   *   re-sending cannot help (400/413/415/422), or any consumer that returns it.
   *   NOT all 4xx. For media uploads the SSOT for status→category mapping is
   *   `classifyUploadFailureCategory` (./classifyUploadFailureCategory).
   * - `'temporary'` — retryable server/transport failure: 5xx AND transient 4xx
   *   (404/408/425/429); will retry with backoff
   * - `'session-state'` — target session is currently busy/unavailable (does not increment attempts)
   * - `'billing'` / `'provider-auth'` — non-retryable upstream voice provider failures
   * - `'provider-error'` — retryable upstream voice provider failure
   */
  errorCategory?: QueueErrorCategory;
  isPermanentFailure: boolean;
  /** Timestamp when item last transitioned to 'processing'. Advisory/diagnostic. */
  processingStartedAt?: number;
  /**
   * Timestamp that anchors the age-based stale sweep. This is optional for
   * snapshot compatibility; absent values fall back to `enqueuedAt`.
   * Manual retry refreshes this without changing the original queue age.
   */
  staleSweepAnchorAt?: number;
  /**
   * Runtime-only backoff for consecutive attempt-neutral deferrals
   * (`defer` / `session-state`). This must never contribute to attempts or
   * permanent-failure classification.
   */
  neutralDeferBackoffMs?: number;
  payloadUri?: string;
  payloadExt?: string;
  metadata: M;
  /** Cloud URL of the auth identity that enqueued this item. Used to prevent cross-account draining. */
  boundCloudUrl?: string;
}

/**
 * Versioned snapshot format for persisted queue index.
 * Version field enables future schema migration.
 */
export interface QueueSnapshot {
  version: 1;
  items: QueueItem[];
}

/**
 * Platform-specific storage adapter. Mobile implements with expo-file-system,
 * web could implement with IndexedDB, tests use in-memory mock.
 *
 * File URI-based payloads: the adapter works with file paths/URIs, not in-memory buffers.
 */
export interface QueueStorageAdapter {
  /** Persist the full queue index (atomic whole-file write). */
  saveSnapshot(items: QueueItem[]): Promise<void>;
  /** Load all queue items from persisted index. Returns empty array if none. */
  loadSnapshot(): Promise<QueueItem[]>;
  /** Copy/move a file from sourceUri to queue-managed storage. Returns the persisted URI. */
  savePayloadFromUri(id: string, sourceUri: string, ext: string): Promise<string>;
  /** Get the persisted file URI for a queue item's payload. */
  getPayloadUri(id: string): Promise<string | null>;
  /** Delete a queue item's payload file. */
  deletePayload(id: string): Promise<void>;
  /** List all payload IDs in storage (for orphan recovery). */
  listPayloadIds(): Promise<string[]>;

  /** Persist arbitrary JSON payload for a queue item (e.g., attachment blob). */
  saveJsonPayload(id: string, payload: unknown): Promise<void>;
  /** Load previously-saved JSON payload. Returns null if not found. */
  loadJsonPayload<T = unknown>(id: string): Promise<T | null>;
  /** Delete JSON payload file. No-op if not found. */
  deleteJsonPayload(id: string): Promise<void>;
}

/**
 * Result returned by a queue consumer after processing one item.
 */
export interface QueueConsumerResult {
  success: boolean;
  error?: string;
  errorCategory?: QueueErrorCategory;
}

/**
 * Consumer callback that processes a single queue item.
 * Receives the item metadata, a file URI for the payload (if any),
 * and an optional AbortSignal that fires when the processing timeout expires.
 * Consumers should check `signal.aborted` before critical mutations.
 */
export type QueueConsumer<M extends Record<string, unknown> = Record<string, unknown>> = (
  item: QueueItem<M>,
  payloadUri: string | null,
  signal?: AbortSignal,
) => Promise<QueueConsumerResult>;

/**
 * Returned by `enqueue()` when the queue has reached its size cap.
 * The item is NOT persisted — the caller should surface a user-visible warning.
 */
export interface QueueFullRejection {
  accepted: false;
  reason: 'queue-full';
  maxSize: number;
}

/**
 * Derived queue-level state snapshot passed to listeners alongside items.
 * Enables UI layers to observe queue health without polling.
 */
export interface QueueStateSnapshot {
  items: QueueItem[];
  queueFullAt: number | null;
  limitedConnectivityAt: number | null;
  authExpiredAt: number | null;
  boundCloudUrl: string | null;
}

type QueueTransitionInfoLevel = { level?: 'info' };
type QueueTransitionWarningLevel = { level?: 'warning' };

/**
 * Transition event emitted by OfflineQueue for observability hooks.
 * Discriminated by `message` so each event has a typed data payload.
 * Must not include user-content payloads (PII); IDs/types/counts only.
 */
export type QueueTransitionEvent =
  | ({ message: 'enqueue'; data: { itemId: string; type: QueueItemType; totalSize: number } } & QueueTransitionInfoLevel)
  | ({ message: 'drain-start'; data: { pendingCount: number; onlineStatus: boolean } } & QueueTransitionInfoLevel)
  | ({ message: 'drain-complete'; data: { drainedCount: number; failedCount: number; skippedCount: number } } & QueueTransitionInfoLevel)
  | ({
      message: 'item-permanent-failure';
      data: {
        itemId: string;
        type: QueueItemType;
        errorCategory: QueueErrorCategory | null;
        attempts: number;
      };
    } & QueueTransitionWarningLevel)
  | ({ message: 'auth-expired'; data: { pendingCount: number } } & QueueTransitionWarningLevel)
  | ({
      message: 'queue-full';
      data: { totalSize: number; rejectedItemType: QueueItemType };
    } & QueueTransitionWarningLevel)
  | ({ message: 'identity-mismatch'; data: { itemCount: number } } & QueueTransitionWarningLevel)
  | ({
      message: 'stuck-drain';
      data: { errorCategories: QueueErrorCategory[]; pendingCount: number; oldestEnqueuedAt: number | null };
    } & QueueTransitionWarningLevel)
  | ({
      message: 'clock-jump-guard';
      data: { itemId: string; oldNextRetryAt: number; newNextRetryAt: number };
    } & QueueTransitionInfoLevel);

/**
 * Options accepted by `OfflineQueue.drain()` to constrain background and
 * time-budgeted drain cycles.
 *
 * - `maxDurationMs`: hard stop — we bail out after this elapsed time even if
 *   items remain due. Used by iOS/Android background tasks with ~30s budgets.
 * - `processingTimeoutMs`: per-item override for the consumer timeout.
 *   Shorter than the default so one slow item doesn't burn the entire budget.
 * - `itemTypes`: restrict drain to specific item types. Background drains use
 *   this to only touch idempotent items (currently `meeting-chunk`).
 */
export interface DrainOptions {
  maxDurationMs?: number;
  processingTimeoutMs?: number;
  itemTypes?: QueueItemType[];
}

/**
 * Return value from `OfflineQueue.drain()`. Callers (e.g. the iOS/Android
 * background-fetch task) need to know whether there was work done and
 * whether we ran up against the budget, so they can return the correct
 * `BackgroundFetchResult` to the OS.
 */
export interface DrainSummary {
  attempted: number;
  drained: number;
  failed: number;
  skipped: number;
  /**
   * Subset of `failed` that were terminalized as permanent (max attempts or
   * permanent error category). Useful for OS background-fetch result mapping:
   * a drain that only terminalized items still made forward progress.
   */
  terminalized: number;
  /**
   * Count of drained items that failed with `errorCategory === 'auth'`.
   * Bumped when auth is the dominant failure mode. Used by background tasks
   * to distinguish transient auth from transient network.
   */
  authFailures: number;
  /** True if `drain()` refused because auth identity is missing/expired. */
  authBlocked: boolean;
  /** Total ms spent inside drain(), measured from entry to finally. */
  durationMs: number;
  /** True if `maxDurationMs` stopped us before processing all due items. */
  budgetExceeded: boolean;
  /** True if drain was skipped because another drain is already in flight. */
  skippedAlreadyDraining: boolean;
  /** True if drain was skipped because `isOnline=false`. */
  skippedOffline: boolean;
}
