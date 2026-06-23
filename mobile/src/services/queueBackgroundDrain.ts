// mobile/src/services/queueBackgroundDrain.ts
//
// Background-fetch driven drain of the offline queue — so that items the
// user saved while the app was offline can upload even while the app is
// suspended. iOS's BGAppRefreshTask and Android's WorkManager-equivalent
// (via expo-background-fetch) give us a ~30s budget a few times per day.
//
// SCOPE (per planning doc, agreed with Operational lens + Devil's Advocate)
// -------------------------------------------------------------------------
// Only `meeting-chunk` items are drained in the background. They are
// idempotent via `X-Idempotency-Key` + manifest, so a duplicate upload
// is harmless. Text messages, voice transcripts, and text-with-attachments
// are NOT drained in the background — they'd need server-side idempotency
// tokens to be safe, and that's a larger piece of work.
//
// This is honest: the common scenario "I closed the app during a meeting,
// let those chunks finish uploading" is covered. The long tail "my queued
// text eventually sends while I'm not looking" is explicitly NOT claimed.
//
// BackgroundFetchResult mapping:
//   - NoData   — no eligible items, not paired, auth missing, or budget
//                exceeded with no progress
//   - NewData  — drained ≥ 1 item or terminalized ≥ 1 permanent failure
//   - Failed   — task threw, or the attempted items hit only transient
//                failures (signals the OS to back off)

import * as TaskManager from 'expo-task-manager';
import * as BackgroundFetch from 'expo-background-fetch';
import NetInfo from '@react-native-community/netinfo';
import { Platform } from 'react-native';
import {
  useAuthStore,
  useOfflineQueueStore,
  createLogger,
  hashForBreadcrumb,
  type DrainSummary,
  type QueueItem,
  type ContinuityErrorCategory,
} from '@rebel/cloud-client';
import { captureSentryMessage } from '../utils/sentry';
import { recordContinuityBreadcrumb } from '../utils/continuityBreadcrumbs';

const log = createLogger('queueBackgroundDrain');

/** Task name registered with expo-task-manager. */
export const QUEUE_BACKGROUND_DRAIN_TASK = 'rebel-queue-background-drain';

/**
 * Budget: total drain time. Kept well under iOS's ~30s to leave headroom
 * for startup, post-drain cleanup, and BackgroundFetchResult delivery.
 */
const DRAIN_BUDGET_MS = 20_000;

/** Per-item consumer timeout override — shorter than the default 90s. */
const PER_ITEM_TIMEOUT_MS = 15_000;

/** Minimum interval between background drains (seconds). iOS may increase this. */
const MINIMUM_INTERVAL_S = 15 * 60; // 15 minutes

/**
 * Throttle window for the "no forward progress" Sentry warning. Background
 * wakes can fire several times per hour; we only want to see one warning
 * per hour so Sentry doesn't fill up with duplicates. In-memory only; a
 * process restart resets the window, which is fine — we'd rather see a
 * duplicate warning after a crash than suppress a regression signal.
 */
const NO_PROGRESS_SENTRY_COOLDOWN_MS = 60 * 60 * 1000;
let lastNoProgressSentryAt = 0;

/**
 * Stuck-ack detection:
 * - If a queue item looks like a persisted-ack miss and has been waiting
 *   >10 minutes since its last attempt, emit `outbox:item-stuck-ack`.
 * - Per-item dedupe window is 1 hour to avoid re-emitting every background
 *   wake for the same stale item.
 */
const STUCK_ACK_AGE_THRESHOLD_MS = 10 * 60 * 1000;
const STUCK_ACK_ITEM_DEDUPE_TTL_MS = 60 * 60 * 1000;
const stuckAckEmittedAt = new Map<string, number>();

/** Test-only: reset in-memory throttles/caches used by this module. */
export function __resetNoProgressSentryThrottle(): void {
  lastNoProgressSentryAt = 0;
  stuckAckEmittedAt.clear();
}

/**
 * Decide the BackgroundFetchResult from a DrainSummary. Exported for unit
 * tests; wraps the mapping rules so they're testable without TaskManager.
 *
 * Rules (in order):
 *   - offline / already-draining / auth-blocked → NoData (do not penalize)
 *   - any successful drain OR any permanent-failure terminalization → NewData
 *     (both are "work done", and terminalizing a stuck item frees the queue)
 *   - nothing attempted → NoData
 *   - all attempts failed with auth errors → NoData (OS backoff is wrong
 *     signal; user needs to repair the session, not wait longer)
 *   - all attempts failed transiently → Failed (signal OS to back off)
 *   - fallback → NoData
 */
export function mapSummaryToFetchResult(
  summary: DrainSummary,
): BackgroundFetch.BackgroundFetchResult {
  if (summary.skippedOffline) return BackgroundFetch.BackgroundFetchResult.NoData;
  if (summary.skippedAlreadyDraining) return BackgroundFetch.BackgroundFetchResult.NoData;
  if (summary.authBlocked) return BackgroundFetch.BackgroundFetchResult.NoData;
  // Drained or terminalized permanent failures both count as forward progress.
  if (summary.drained > 0 || summary.terminalized > 0) {
    return BackgroundFetch.BackgroundFetchResult.NewData;
  }
  if (summary.attempted === 0) return BackgroundFetch.BackgroundFetchResult.NoData;
  // All attempted items hit failures. If every failure was auth, don't ask
  // the OS to back off — the user needs to repair.
  if (summary.failed > 0 && summary.authFailures === summary.failed) {
    return BackgroundFetch.BackgroundFetchResult.NoData;
  }
  if (summary.failed > 0) return BackgroundFetch.BackgroundFetchResult.Failed;
  return BackgroundFetch.BackgroundFetchResult.NoData;
}

function isAckMissingError(lastError: string | undefined): boolean {
  if (!lastError) return false;
  const normalized = lastError.toLowerCase();
  return (
    normalized.includes('persistence acknowledgement missing')
    || normalized.includes('persistence acknowledgment missing')
    || normalized.includes('turn_persisted')
  );
}

function mapToContinuityErrorCategory(
  queueErrorCategory: QueueItem['errorCategory'],
): ContinuityErrorCategory {
  switch (queueErrorCategory) {
    case 'auth':
      return 'auth';
    case 'network':
      return 'network';
    case 'timeout':
      return 'timeout';
    case 'session-state':
      return 'session-state';
    case 'temporary':
      // Persisted-ack missing retries are marked temporary in queue consumers.
      return 'timeout';
    default:
      return 'unknown';
  }
}

function emitStuckAckBreadcrumbs(items: QueueItem[], now: number): void {
  for (const [itemId, emittedAt] of stuckAckEmittedAt.entries()) {
    if (now - emittedAt >= STUCK_ACK_ITEM_DEDUPE_TTL_MS) {
      stuckAckEmittedAt.delete(itemId);
    }
  }

  for (const item of items) {
    if (item.status !== 'pending') continue;
    if (item.isPermanentFailure) continue;
    if (item.attempts <= 0) continue;
    if (!isAckMissingError(item.lastError)) continue;

    const lastAttemptAt = item.processingStartedAt ?? 0;
    if (lastAttemptAt <= 0) continue;

    const ageMs = now - lastAttemptAt;
    if (ageMs <= STUCK_ACK_AGE_THRESHOLD_MS) continue;

    const lastEmittedAt = stuckAckEmittedAt.get(item.id);
    if (lastEmittedAt !== undefined && now - lastEmittedAt < STUCK_ACK_ITEM_DEDUPE_TTL_MS) {
      continue;
    }

    recordContinuityBreadcrumb({
      family: 'outbox',
      message: 'item-stuck-ack',
      level: 'warning',
      data: {
        ageMs,
        attempts: item.attempts,
        errorCategory: mapToContinuityErrorCategory(item.errorCategory),
        itemKindHashed: hashForBreadcrumb(item.type),
      },
    });
    stuckAckEmittedAt.set(item.id, now);
  }
}

/**
 * Runs the drain. Exported for testability — the TaskManager registration
 * below calls this but tests can call it directly with injected deps.
 *
 * Cold-start safety: when the OS wakes the app headless, the module's
 * top-level `initOfflineQueueStore(...)` call in `_layout.tsx` does run,
 * but the `init()` method (which loads persisted items from disk) is
 * deferred to a React effect that never mounts in headless mode. We call
 * `init()` here to handle that, and swallow "already initialized" no-ops.
 */
export async function runBackgroundDrain(): Promise<BackgroundFetch.BackgroundFetchResult> {
  try {
    // Defensive credential reload — in background wake, JS context may not
    // retain cloud client configuration.
    await useAuthStore.getState().loadCredentials();
    const { isPaired, cloudUrl } = useAuthStore.getState();
    if (!isPaired || !cloudUrl) {
      log.info('Not paired — skipping background drain');
      return BackgroundFetch.BackgroundFetchResult.NoData;
    }

    // Connectivity pre-check. If we have no network, report NoData so the
    // OS schedules us again later rather than penalizing us with Failed.
    const netState = await NetInfo.fetch();
    const online = netState.isConnected !== false && netState.isInternetReachable !== false;
    if (!online) {
      log.info('Offline during background wake — skipping drain');
      return BackgroundFetch.BackgroundFetchResult.NoData;
    }

    // Resolve the store. On headless cold start, the top-level
    // `initOfflineQueueStore` call in `_layout.tsx` runs when the module
    // evaluates, so `useOfflineQueueStore.getState()` must succeed. If it
    // throws, initialization failed catastrophically.
    let queueState;
    try {
      queueState = useOfflineQueueStore.getState();
    } catch (err) {
      log.warn('Queue store not initialised during background drain', {
        error: err instanceof Error ? err.message : String(err),
      });
      captureSentryMessage('queue background drain: store not initialised', 'warning', {
        error: err instanceof Error ? err.message : String(err),
      });
      return BackgroundFetch.BackgroundFetchResult.NoData;
    }

    // Ensure persisted items are loaded. `init()` is idempotent — if it
    // already ran (foreground launch before we were backgrounded), it's
    // a cheap no-op; otherwise it loads snapshot+recovers stale items.
    try {
      await queueState.init();
    } catch (err) {
      log.error('Queue init() failed during background drain', {
        error: err instanceof Error ? err.message : String(err),
      });
      captureSentryMessage('queue background drain: init failed', 'error', {
        error: err instanceof Error ? err.message : String(err),
      });
      return BackgroundFetch.BackgroundFetchResult.Failed;
    }

    // Stage 1.6: ack-awareness scan. Background drain intentionally processes
    // idempotent meeting chunks only, but stale ack-missing items from turn
    // sends can sit in the queue for hours. Surface these explicitly.
    const now = Date.now();
    const currentQueueState = useOfflineQueueStore.getState();
    const queueItems = Array.isArray(currentQueueState.items) ? currentQueueState.items : [];
    emitStuckAckBreadcrumbs(queueItems, now);

    // Bind auth so items bound to this account are eligible.
    queueState.bindAuthIdentity(cloudUrl);

    let summary: DrainSummary;
    try {
      summary = await queueState.drain(true, {
        maxDurationMs: DRAIN_BUDGET_MS,
        processingTimeoutMs: PER_ITEM_TIMEOUT_MS,
        // Idempotent types only. Everything else is drained on foreground.
        itemTypes: ['meeting-chunk'],
      });
    } catch (err) {
      log.error('drain() threw — reporting Failed to OS', {
        error: err instanceof Error ? err.message : String(err),
      });
      captureSentryMessage('queue background drain: drain threw', 'error', {
        error: err instanceof Error ? err.message : String(err),
      });
      return BackgroundFetch.BackgroundFetchResult.Failed;
    }

    const result = mapSummaryToFetchResult(summary);
    log.info('Background drain complete', { summary, result });

    // Surface a warning to Sentry if the drain made zero progress despite
    // having items to work on. Helps us notice stuck-queue regressions.
    // Suppress the "every failure was auth" case — that's an expected state
    // (user needs to repair), not a drain regression. Throttle to 1/hour
    // to avoid filling Sentry with duplicates during sustained bad states.
    const noProgress =
      summary.attempted > 0 &&
      summary.drained === 0 &&
      summary.terminalized === 0 &&
      summary.authFailures < summary.failed;
    if (noProgress) {
      const now = Date.now();
      if (now - lastNoProgressSentryAt >= NO_PROGRESS_SENTRY_COOLDOWN_MS) {
        lastNoProgressSentryAt = now;
        captureSentryMessage('queue background drain: no forward progress', 'warning', {
          summary,
        });
      }
    }

    return result;
  } catch (err) {
    log.error('runBackgroundDrain failed', {
      error: err instanceof Error ? err.message : String(err),
    });
    captureSentryMessage('queue background drain: unexpected failure', 'error', {
      error: err instanceof Error ? err.message : String(err),
    });
    return BackgroundFetch.BackgroundFetchResult.Failed;
  }
}

// ---------------------------------------------------------------------------
// Task definition — MUST be at module top level (expo-task-manager requirement)
// ---------------------------------------------------------------------------

TaskManager.defineTask(QUEUE_BACKGROUND_DRAIN_TASK, async () => {
  log.info('Background drain task started');
  return runBackgroundDrain();
});

// ---------------------------------------------------------------------------
// Registration lifecycle
// ---------------------------------------------------------------------------
//
// Serialize register/unregister through a single pending promise so that a
// rapid pair → unpair (or the reverse) can't race: a cleanup that fires
// before the register's `isTaskRegisteredAsync` returns would otherwise see
// "not registered", early-out, and leave the task registered after unpair.
// The chain guarantees each call sees the post-state of the previous one.

let lifecycleChain: Promise<void> = Promise.resolve();

function enqueueLifecycle(fn: () => Promise<void>): Promise<void> {
  const next = lifecycleChain.then(fn, fn);
  lifecycleChain = next.catch(() => undefined);
  return next;
}

/**
 * Register the background drain task with the OS. Call when the user pairs.
 * Idempotent — safe to call multiple times. No-op if background fetch is
 * denied or restricted.
 */
export function registerQueueBackgroundDrain(): Promise<void> {
  return enqueueLifecycle(doRegisterQueueBackgroundDrain);
}

async function doRegisterQueueBackgroundDrain(): Promise<void> {
  // expo-background-fetch is iOS + Android; degrades to a no-op on web.
  if (Platform.OS !== 'ios' && Platform.OS !== 'android') return;

  try {
    const status = await BackgroundFetch.getStatusAsync();
    if (
      status === BackgroundFetch.BackgroundFetchStatus.Denied ||
      status === BackgroundFetch.BackgroundFetchStatus.Restricted
    ) {
      log.warn('Background fetch unavailable — cannot register queue drain', { status });
      return;
    }

    const alreadyRegistered = await TaskManager.isTaskRegisteredAsync(
      QUEUE_BACKGROUND_DRAIN_TASK,
    );
    if (alreadyRegistered) {
      log.debug('Queue background drain already registered');
      return;
    }

    await BackgroundFetch.registerTaskAsync(QUEUE_BACKGROUND_DRAIN_TASK, {
      minimumInterval: MINIMUM_INTERVAL_S,
      stopOnTerminate: false,
      startOnBoot: false,
    });
    log.info('Queue background drain registered', { minimumInterval: MINIMUM_INTERVAL_S });
  } catch (err) {
    log.warn('Failed to register queue background drain', {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * Unregister the background drain task. Call on unpair to stop the OS from
 * waking us to drain a queue bound to a different (stale) identity.
 */
export function unregisterQueueBackgroundDrain(): Promise<void> {
  return enqueueLifecycle(doUnregisterQueueBackgroundDrain);
}

async function doUnregisterQueueBackgroundDrain(): Promise<void> {
  if (Platform.OS !== 'ios' && Platform.OS !== 'android') return;

  try {
    const registered = await TaskManager.isTaskRegisteredAsync(QUEUE_BACKGROUND_DRAIN_TASK);
    if (!registered) {
      log.debug('Queue background drain not registered — nothing to unregister');
      return;
    }
    await BackgroundFetch.unregisterTaskAsync(QUEUE_BACKGROUND_DRAIN_TASK);
    log.info('Queue background drain unregistered');
  } catch (err) {
    log.warn('Failed to unregister queue background drain', {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
