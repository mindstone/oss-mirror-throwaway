import type { IncrementalSessionStore, SessionsSyncUpsertOutcome } from './incrementalSessionStore';
import type { OwnerKind } from './superMcpOwnerRegistry';
import type { SessionLockManager, SessionLockHandle, SyncSessionLockHandle } from '@core/utils/sessionFileLock';
import type { AgentSession } from '@shared/types';
import { createScopedLogger } from '@core/logger';
import { ignoreBestEffortCleanup } from '@shared/utils/intentionalSwallow';

// Lazy logger: do NOT call createScopedLogger at module load. This module is
// transitively imported by many surfaces (e.g. sessionsHandlers), some of whose
// tests mock `@core/logger` with a partial mock that omits `createScopedLogger`.
// A module-load-time call would make those test files fail to even collect. The
// logger is only needed by the (rare) slow-telemetry warn path, so build it on
// first use.
let _log: ReturnType<typeof createScopedLogger> | undefined;
const getLog = (): ReturnType<typeof createScopedLogger> =>
  (_log ??= createScopedLogger({ service: 'lockedSessionPersistence' }));

const inProcessSessionUpdateTails = new Map<string, Promise<void>>();

// `activeAsyncLockedWriters` counts async writers currently inside their
// lock-hold window (incremented at the top of `*Unlocked`, decremented after
// all releases). `pendingDeferredLockedDrains` counts deferred quit-saves that
// `upsertSessionsWithLocksSync` has enqueued but whose async drain has not yet
// completed — bracketed SYNCHRONOUSLY at defer time (before the fire-and-forget)
// and cleared in `.finally()`. Keeping the deferred counter separate and
// synchronous closes the window the lock-hold counter alone leaves: the
// in-flight holder releases (activeAsyncLockedWriters → 0) BEFORE the deferred
// drain's own `*Unlocked` body starts and re-increments, so a consumer polling
// only the lock-hold counter can observe a false "idle" while the deferred local
// write is still queued (the cloud-outbox stale-read TOCTOU, Phase-5 review F1).
let activeAsyncLockedWriters = 0;
let pendingDeferredLockedDrains = 0;

/**
 * True while any async writer currently holds a session/index FILE lock.
 *
 * @internal Test seam — production code gates on the WIDER `hasPendingLocalSessionDrain()`
 * (see its doc + the counter comment above); this narrow lock-hold predicate is consumed
 * only by `__tests__/lockedSessionPersistence.{syncDefer,inProcessQueue}.test.ts` to wait
 * on / assert writer state. The default knip leg still tracks it, so it can't go fully dead.
 */
export function hasActiveAsyncLockedWriter(): boolean {
  return activeAsyncLockedWriters > 0;
}

/**
 * True while local session persistence has not settled: an async writer holds a
 * lock now, OR a deferred quit-save drain is enqueued-but-not-yet-complete.
 * Gating that must not act on possibly-stale on-disk state (the sync-save entry
 * decision; the cloud-outbox drain) MUST use this predicate, not the narrower
 * `hasActiveAsyncLockedWriter()` — see the counter comment above for the window
 * the narrow one leaves open.
 */
export function hasPendingLocalSessionDrain(): boolean {
  return activeAsyncLockedWriters > 0 || pendingDeferredLockedDrains > 0;
}

/**
 * 260618 RC-3 F1 (review F2 — observability): the global-index tail has a wider
 * blast radius than the per-session tail — a slow or never-settling global-index
 * section now stalls EVERY async locked writer across ALL sessions behind it.
 * We do NOT add a blind timeout around persistence (that has its own failure
 * mode), but we make a slow/hung global-index wait OBSERVABLE: warn (structured)
 * when EITHER the wait to enter the serialized section OR the section's own held
 * duration exceeds the threshold, with op-kind + session-id(s) for diagnosis.
 * Mirrors the slow-store-write telemetry pattern in `perfAccumulator.ts`.
 */
const GLOBAL_INDEX_SLOW_WAIT_MS = 3_000;
const GLOBAL_INDEX_SLOW_SECTION_MS = 3_000;

/**
 * Diagnostic context for a global-index section (op kind + the ids it touches).
 * @internal Exported for testing.
 */
export interface GlobalIndexOpContext {
  opKind: 'upsert' | 'reload-checkpoint';
  sessionIds: string[];
}

export type SyncSaveResult =
  | { mode: 'sync'; outcome: SessionsSyncUpsertOutcome }
  | { mode: 'deferred' };

/**
 * One slow-telemetry signal. `stillRunning: true` is the WATCHDOG fire — emitted
 * while the wait/section is STILL stuck (at the threshold), so a NEVER-settling
 * hang is observable in real time. `stillRunning: false` is the post-hoc closure
 * — emitted on settlement of a phase that the watchdog already flagged, carrying
 * the final measured duration. `durationMs` is the threshold for a watchdog fire
 * and the true elapsed time for a closure.
 */
export type GlobalIndexSlowInfo = {
  phase: 'wait' | 'section';
  stillRunning: boolean;
  durationMs: number;
  threshold: number;
} & GlobalIndexOpContext;

/**
 * Test/observability seam: an injectable clock + timer + slow-threshold reporter
 * so the watchdog/threshold/measurement logic is exercisable deterministically
 * (fake timers + a synced clock) without real-time waits. Defaults to `Date.now`,
 * the real (unref'd) timer, and the structured `log.warn` slow report.
 *
 * `onSlow` is invoked STRICTLY best-effort: a throw from it must never alter the
 * serialized operation's result or its thrown error (see the try/catch guards in
 * `runWithGlobalIndexSerialized`).
 * @internal Exported for testing.
 */
export interface GlobalIndexTelemetry {
  now: () => number;
  slowWaitMs: number;
  slowSectionMs: number;
  /** Arm a watchdog timer; returns a clear fn. Defaults to an unref'd setTimeout. */
  setWatchdog: (ms: number, fire: () => void) => () => void;
  onSlow: (info: GlobalIndexSlowInfo) => void;
}

const defaultGlobalIndexTelemetry: GlobalIndexTelemetry = {
  now: Date.now,
  slowWaitMs: GLOBAL_INDEX_SLOW_WAIT_MS,
  slowSectionMs: GLOBAL_INDEX_SLOW_SECTION_MS,
  setWatchdog: (ms, fire) => {
    const timer = setTimeout(fire, ms);
    // Never keep the process alive on account of a diagnostic timer.
    timer.unref?.();
    return () => clearTimeout(timer);
  },
  onSlow: (info) => {
    const isWait = info.phase === 'wait';
    const message = info.stillRunning
      ? (isWait
        ? 'STILL waiting to enter the serialized global-index section past threshold — an upstream global-index writer is hung/slow; ALL async session writers are queued behind it'
        : 'Global-index critical section STILL held past threshold — this write is hung/slow holding the in-process serializer (and the index.lock), stalling other session writers')
      : (isWait
        ? 'Slow wait to enter the serialized global-index section eventually completed'
        : 'Slow global-index critical section eventually completed');
    getLog().warn(
      {
        phase: info.phase,
        stillRunning: info.stillRunning,
        durationMs: info.durationMs,
        threshold: info.threshold,
        opKind: info.opKind,
        sessionIds: info.sessionIds,
      },
      message,
    );
  },
};

/** Invoke an `onSlow` sink strictly best-effort — a throwing sink must never
 * alter the serialized operation's result or its thrown error. Uses the
 * reentry-safe `ignoreBestEffortCleanup` so even a sink failure (and any failure
 * of the observability for THAT) cannot escape onto the persistence path. */
function emitSlowSafely(telemetry: GlobalIndexTelemetry, info: GlobalIndexSlowInfo): void {
  try {
    telemetry.onSlow(info);
  } catch (err) {
    ignoreBestEffortCleanup(err, {
      operation: 'lockedSessionPersistence.globalIndexSlowTelemetry',
      reason: 'onSlow slow-telemetry sink threw; telemetry is best-effort and must not perturb persistence',
      severity: 'warn',
    });
  }
}

/**
 * 260618 RC-3 F1 (GPT-5.5-high confirming round): a single in-process tail that
 * serialises the GLOBAL-INDEX critical section across ALL locked session
 * writers in this process.
 *
 * RC-3 serialised same-SESSION writers via `inProcessSessionUpdateTails`, but
 * every locked write ALSO acquires the shared global `index.lock` FILE lock —
 * and independent-session writers are intentionally allowed to run concurrently
 * (they share no per-session predecessor). They therefore contended on
 * `index.lock` with the same 200ms `maxRetryMs`: a writer holding `index.lock`
 * across a slow (400-600ms on cloud-synced userData) full-index reload-upsert
 * would time out a concurrent DIFFERENT-session writer's `index.lock` acquire,
 * which was then dropped/failed (`LockAcquireTimeout`) — the same dropped-write
 * class RC-3 closed for the per-session lock, still open at the global lock.
 *
 * This serialises the global-index critical section (FILE-lock acquire +
 * reload-upsert + release) in-process, so same-process `index.lock` contention
 * becomes unrepresentable — exactly mirroring what RC-3 did per-session, now for
 * the single global index. The `index.lock` FILE lock remains the genuine
 * cross-process guard. The only OTHER `acquireGlobalIndex` consumer,
 * `persistSessionFromCli`, runs in a SEPARATE process (the headless CLI; it
 * never boots the renderer that drives these writers — RC-3 F1b), so its
 * contention with these writers is cross-process and is the file lock's job,
 * not the in-process tail's.
 */
let globalIndexTail: Promise<void> = Promise.resolve();

/**
 * Returns the store's discriminated upsert outcome (Stage 2, 260612
 * recs-round5): a dropped write (read-only store, unrecoverable corrupt index,
 * version-forward index) is surfaced so callers like the `sessions:upsert`
 * handler do not report `{success:true}` — or fire embedding/cloud hooks — for
 * a write that never landed.
 *
 * 260618 RC-3 (library-scan-freeze diagnosis): this path is now serialised
 * through the SAME per-session in-process queue (`inProcessSessionUpdateTails`)
 * that already serialises `updateSessionWithReload`. Previously only
 * `updateSessionWithReload` was enrolled, so a renderer `sessions:upsert`
 * (this path) and a periodic turn checkpoint (`updateSessionWithReload`) for
 * the same session id raced at the per-session FILE lock — and because that
 * lock is non-reentrant with no same-pid awareness, the second in-process
 * writer spun for `maxRetryMs` (200ms) against a hold of up to several seconds
 * and timed out with a `LockAcquireTimeout` naming its own pid as the holder.
 * The timed-out upsert was then silently dropped (`sessions:upsert` →
 * `{success:false}`), losing renderer session metadata. Routing both writer
 * families through one queue makes same-process file-lock contention
 * unrepresentable; the file lock remains the genuine cross-process guard.
 */
export async function upsertSessionsWithLocks(args: {
  sessions: AgentSession[];
  store: IncrementalSessionStore;
  lockManager: SessionLockManager;
  ownerKind: OwnerKind;
  maxRetryMs?: number;
}): Promise<SessionsSyncUpsertOutcome> {
  if (args.sessions.length === 0) return { outcome: 'noop-empty-batch' };

  // Batch upserts span multiple session ids — enqueue on ALL of them (in
  // sorted order, matching the file-lock acquisition order below) so the
  // batch runs only after every in-process predecessor on each id it touches,
  // and later operations on those ids queue behind it.
  const sessionIds = getSortedSessionIds(args.sessions);
  return runInProcessSessionUpdate(sessionIds, () => upsertSessionsWithLocksUnlocked(args, sessionIds));
}

async function upsertSessionsWithLocksUnlocked(
  args: {
    sessions: AgentSession[];
    store: IncrementalSessionStore;
    lockManager: SessionLockManager;
    ownerKind: OwnerKind;
    maxRetryMs?: number;
  },
  sessionIds: string[],
): Promise<SessionsSyncUpsertOutcome> {
  activeAsyncLockedWriters += 1;
  const perSessionLocks: SessionLockHandle[] = [];

  try {
    try {
      for (const sessionId of sessionIds) {
        perSessionLocks.push(await args.lockManager.acquirePerSession(sessionId, lockOptions(args.ownerKind, args.maxRetryMs)));
      }
      // Serialise the global-index FILE-lock acquire + reload + release in-process
      // (RC-3 F1) so a concurrent DIFFERENT-session writer never spins on
      // `index.lock` past the acquire budget. Runs inside the per-session queue,
      // so the order is per-session OUTER, global-index tail INNER — no deadlock.
      return await runWithGlobalIndexSerialized({ opKind: 'upsert', sessionIds }, async () => {
        const indexLock = await args.lockManager.acquireGlobalIndex(lockOptions(args.ownerKind, args.maxRetryMs));
        try {
          return args.store.upsertSessionsSyncWithReload(args.sessions);
        } finally {
          await indexLock.release();
        }
      });
    } finally {
      for (const lock of perSessionLocks.reverse()) {
        await lock.release();
      }
    }
  } finally {
    activeAsyncLockedWriters -= 1;
  }
}

export async function updateSessionWithReload(args: {
  sessionId: string;
  store: Pick<IncrementalSessionStore, 'getSession' | 'upsertSessionsSyncWithReload'> & {
    waitForIdle?: () => Promise<void>;
  };
  lockManager: SessionLockManager;
  ownerKind: OwnerKind;
  update: (existing: AgentSession | null) => AgentSession | null;
  maxRetryMs?: number;
}): Promise<{ updated: boolean; session: AgentSession | null }> {
  return runInProcessSessionUpdate([args.sessionId], () => updateSessionWithReloadUnlocked(args));
}

async function updateSessionWithReloadUnlocked(args: {
  sessionId: string;
  store: Pick<IncrementalSessionStore, 'getSession' | 'upsertSessionsSyncWithReload'> & {
    waitForIdle?: () => Promise<void>;
  };
  lockManager: SessionLockManager;
  ownerKind: OwnerKind;
  update: (existing: AgentSession | null) => AgentSession | null;
  maxRetryMs?: number;
}): Promise<{ updated: boolean; session: AgentSession | null }> {
  activeAsyncLockedWriters += 1;
  let updatedSession: AgentSession | null = null;

  try {
    await args.store.waitForIdle?.();
    const perSessionLock = await args.lockManager.acquirePerSession(
      args.sessionId,
      lockOptions(args.ownerKind, args.maxRetryMs),
    );

    try {
      // Serialise the global-index critical section in-process (RC-3 F1). The
      // awaited reload (`getSession`) sits inside this window, so a slow reload on
      // cloud-synced FS no longer times out a concurrent DIFFERENT-session writer
      // at the `index.lock` FILE lock. Runs inside the per-session queue → order
      // is per-session OUTER, global-index tail INNER → no deadlock.
      const result = await runWithGlobalIndexSerialized({ opKind: 'reload-checkpoint', sessionIds: [args.sessionId] }, async () => {
        const indexLock = await args.lockManager.acquireGlobalIndex(
          lockOptions(args.ownerKind, args.maxRetryMs),
        );
        try {
          const existing = await args.store.getSession(args.sessionId);
          const next = args.update(existing);
          if (!next) {
            return { updatedSession: null };
          }
          // Stage 3: a non-persisted write (read-only drop, corrupt-index abort,
          // tombstoned id) must not be reported as an update — callers
          // (sessions:apply-turn-event-union, memory handlers, turn checkpoints)
          // faithfully believe this result.
          const outcome = args.store.upsertSessionsSyncWithReload([next]);
          if (outcome.outcome !== 'persisted') {
            return { updatedSession: null };
          }
          return { updatedSession: next };
        } finally {
          await indexLock.release();
        }
      });
      updatedSession = result.updatedSession;
    } finally {
      await perSessionLock.release();
    }
  } finally {
    activeAsyncLockedWriters -= 1;
  }

  return { updated: updatedSession !== null, session: updatedSession };
}

/**
 * Serialise an in-process session write behind any in-flight writers for the
 * same session id(s). All same-process writers for a given id run one at a
 * time, so the per-session FILE lock is only ever contended cross-process.
 *
 * Multi-id batches (e.g. a `sessions:save` covering several sessions) enrol on
 * EVERY id they touch. Deadlock-freedom: predecessors are captured
 * synchronously (no `await` between the `get`s and the `set`s, so the
 * single-threaded event loop installs each operation's tails atomically), and
 * an operation only ever waits on tails captured BEFORE it installed its own.
 * The wait graph is therefore a DAG ordered by arrival — no hold-and-wait
 * cycle can form regardless of how two batches' id sets overlap or order.
 */
async function runInProcessSessionUpdate<T>(
  sessionIds: string[],
  operation: () => Promise<T>,
): Promise<T> {
  // Dedupe + freeze the id set this operation gates on. Order is irrelevant to
  // correctness here (we await ALL predecessors before running), but the
  // caller already passes sorted ids to match the file-lock acquisition order.
  const ids = [...new Set(sessionIds)];

  // Capture predecessors and install our tail atomically (synchronous block).
  const predecessors = ids.map((id) => inProcessSessionUpdateTails.get(id) ?? Promise.resolve());
  const run = (async () => {
    // Wait for ALL prior in-process writers on every id we touch. `allSettled`
    // so a rejected predecessor never blocks us (each predecessor already owns
    // its own error handling).
    await Promise.allSettled(predecessors);
    return operation();
  })();
  const tail = run.then(() => undefined, () => undefined);
  for (const id of ids) {
    inProcessSessionUpdateTails.set(id, tail);
  }
  try {
    return await run;
  } finally {
    // Only clear the map entry if it's still ours — a later writer on the same
    // id may have already overwritten it with its own tail.
    for (const id of ids) {
      if (inProcessSessionUpdateTails.get(id) === tail) {
        inProcessSessionUpdateTails.delete(id);
      }
    }
  }
}

/**
 * 260618 RC-3 F1: serialise the global-index critical section in-process behind
 * any in-flight global-index holder. All same-process locked writers run their
 * global-index section (FILE-lock acquire + reload-upsert + release) one at a
 * time, so the global `index.lock` FILE lock is only ever contended
 * cross-process — never by a second same-process acquirer.
 *
 * Deadlock-freedom (composing with `runInProcessSessionUpdate`): this runs
 * STRICTLY INSIDE the `operation` passed to `runInProcessSessionUpdate`, so by
 * the time an operation waits on `globalIndexTail` it has already cleared the
 * per-session queue (it holds its per-session slots and waits on nothing
 * per-session). The two in-process resources are thus acquired in one fixed
 * order — per-session queue OUTER, the single global-index tail INNER — and an
 * operation holding the global-index tail never waits on a per-session slot.
 * With exactly one global-index resource acquired last, no hold-and-wait cycle
 * can form: the wait graph stays the same arrival-ordered DAG as the per-session
 * queue. The tail itself captures its predecessor and installs its own
 * successor in one synchronous block (no `await` between the read and the
 * write), so two writers can never observe the same predecessor and fork the
 * chain; `allSettled` keeps a rejected predecessor from wedging it.
 *
 * Observability (review F2 + round-4): because this tail's blast radius is
 * process-wide (one slow/HUNG section stalls every async session writer), each
 * phase (waiting to enter; holding the section) is guarded by a WATCHDOG timer
 * armed BEFORE the await and cleared on settlement — so a NEVER-settling hang is
 * reported in real time (`stillRunning: true`), not just after it finally
 * unblocks. A slow-but-eventually-settled phase additionally emits a closure
 * signal with the true duration. No timeout is imposed on persistence; we only
 * make a stall visible. Telemetry is STRICTLY best-effort: every `onSlow` is
 * wrapped (`emitSlowSafely`) so a throwing sink can never skip the write, mask
 * the store/lock error, or flip a persisted write into a rejected result. The
 * `telemetry` seam (injectable clock + timer + sink) makes this deterministically
 * testable with fake timers and no real-time waits.
 * @internal Exported for testing.
 */
export async function runWithGlobalIndexSerialized<T>(
  context: GlobalIndexOpContext,
  operation: () => Promise<T>,
  telemetry: GlobalIndexTelemetry = defaultGlobalIndexTelemetry,
): Promise<T> {
  const predecessor = globalIndexTail;
  const arrivedAt = telemetry.now();
  const run = (async () => {
    // WAIT phase: arm a watchdog so a hung predecessor (never releasing the
    // serializer) is observable WHILE we are still queued, not only afterwards.
    let waitWatchdogFired = false;
    const clearWaitWatchdog = telemetry.setWatchdog(telemetry.slowWaitMs, () => {
      waitWatchdogFired = true;
      emitSlowSafely(telemetry, { phase: 'wait', stillRunning: true, durationMs: telemetry.slowWaitMs, threshold: telemetry.slowWaitMs, ...context });
    });
    try {
      await predecessor;
    } finally {
      clearWaitWatchdog();
    }
    // Closure signal: if the watchdog flagged a slow wait, report the final
    // measured wait duration now that we have entered.
    if (waitWatchdogFired) {
      emitSlowSafely(telemetry, { phase: 'wait', stillRunning: false, durationMs: telemetry.now() - arrivedAt, threshold: telemetry.slowWaitMs, ...context });
    }

    // SECTION phase: arm a watchdog so a hung section (operation never settling
    // while holding the serializer + index.lock) is observable in real time.
    const sectionStart = telemetry.now();
    let sectionWatchdogFired = false;
    const clearSectionWatchdog = telemetry.setWatchdog(telemetry.slowSectionMs, () => {
      sectionWatchdogFired = true;
      emitSlowSafely(telemetry, { phase: 'section', stillRunning: true, durationMs: telemetry.slowSectionMs, threshold: telemetry.slowSectionMs, ...context });
    });
    try {
      return await operation();
    } finally {
      clearSectionWatchdog();
      // Closure signal on settlement (even on failure). Best-effort emit MUST
      // NOT mask the operation's own error or flip a persisted result.
      if (sectionWatchdogFired) {
        emitSlowSafely(telemetry, { phase: 'section', stillRunning: false, durationMs: telemetry.now() - sectionStart, threshold: telemetry.slowSectionMs, ...context });
      }
    }
  })();
  // Install our completion as the new tail BEFORE awaiting (synchronous, no
  // interleaving). Swallow rejection on the chain so a failed global-index
  // section never blocks the next writer; the caller still observes `run`.
  globalIndexTail = run.then(() => undefined, () => undefined);
  return run;
}

/**
 * 260618 quit-save lock-contention fix: this path is still synchronous at the
 * IPC boundary (`sessions:save-sync`), so it cannot await the async in-process
 * tails. It therefore uses a synchronous detector instead of blocking the event
 * loop behind a same-process async holder.
 *
 * Historical bug fixed here:
 *   - A periodic checkpoint (`updateSessionWithReload`) holds the per-session
 *     FILE lock asynchronously — AND, post RC-3 F1, holds the GLOBAL `index.lock`
 *     FILE lock across its global-index critical section (serialised in-process
 *     among the async writers via `globalIndexTail`).
 *   - The renderer `beforeunload` fires `sessions:save-sync`; main calls
 *     `upsertSessionsWithLocksSync` → `acquirePerSessionSync` AND
 *     `acquireGlobalIndexSync`, BOTH of which BUSY-WAIT the event loop
 *     (`sleepSync` → `Atomics.wait`, sessionFileLock.ts:209,326). The sync path
 *     is NOT part of the in-process `inProcessSessionUpdateTails` /
 *     `globalIndexTail` chains (a sync function cannot await a promise tail), so
 *     the in-process serialisation does not protect it.
 *   - The async holder's `release()` is JavaScript scheduled on that SAME, now
 *     blocked, event loop — so it can never run. After the `maxRetryMs` (200ms)
 *     budget the sync acquire throws `LockAcquireTimeout`, the quit-save returns
 *     `{success:false}`, and the FINAL renderer snapshot is DROPPED at quit.
 *   - This is reachable for BOTH locks: the per-session lock (an async holder of
 *     the SAME id) and the global `index.lock` (an async holder of ANY id —
 *     including a DIFFERENT session — because the global index is shared). So
 *     the shutdown gap is NOT limited to "the affected ids"; a slow async
 *     global-index holder for an unrelated session can wedge the sync quit-save.
 *   - This is a lost final save, NOT corruption (the file lock still prevents a
 *     simultaneous cross-process write).
 *
 * The async unlocked writers maintain `activeAsyncLockedWriters` for the full
 * window in which they could hold either FILE lock. When this sync path sees an
 * active async writer, it does NOT call `acquire*Sync` and therefore never
 * reaches `Atomics.wait` against a same-process holder. Instead it synchronously
 * enqueues the exact snapshot through `upsertSessionsWithLocks(...)`; that
 * installs the per-session/global tails before this function returns, then the
 * returned promise drains after the active writer releases. If no async writer
 * is active, this keeps the existing synchronous locked-write fast path and
 * returns the store outcome so callers can report genuine drops honestly.
 */
export function upsertSessionsWithLocksSync(args: {
  sessions: AgentSession[];
  store: IncrementalSessionStore;
  lockManager: SessionLockManager;
  ownerKind: OwnerKind;
  maxRetryMs?: number;
}): SyncSaveResult {
  if (args.sessions.length === 0) {
    return { mode: 'sync', outcome: { outcome: 'noop-empty-batch' } };
  }

  const perSessionLocks: SyncSessionLockHandle[] = [];
  const sessionIds = getSortedSessionIds(args.sessions);

  if (hasPendingLocalSessionDrain()) {
    // Contention (or a still-pending earlier deferral): do NOT busy-wait the
    // event loop behind a same-process async holder. Bracket the deferred drain
    // SYNCHRONOUSLY here (before the fire-and-forget) so `hasPendingLocalSessionDrain()`
    // stays true continuously from this point until the snapshot is persisted —
    // no false-idle window for the cloud forwarder. Enqueuing through
    // `upsertSessionsWithLocks` installs the PER-SESSION tail synchronously
    // (`runInProcessSessionUpdate` captures predecessors + installs the tail in one
    // synchronous block), which is the ordering guarantee that matters here: a
    // reloaded renderer's same-session writes queue behind this snapshot. (The
    // global-index tail installs only once the deferred op reaches
    // `runWithGlobalIndexSerialized`, after its per-session predecessors clear — it
    // serialises the shared index lock but is not part of this per-session ordering
    // guarantee.)
    pendingDeferredLockedDrains += 1;
    void upsertSessionsWithLocks(args)
      .then(
        (outcome) => {
          if (outcome.outcome !== 'persisted' && outcome.outcome !== 'noop-empty-batch') {
            getLog().warn(
              { sessionIds, outcome },
              'Deferred sync session save drained without persisting',
            );
          }
        },
        (err) => {
          getLog().warn(
            { err, sessionIds },
            'Deferred sync session save failed after async writer drained',
          );
        },
      )
      .finally(() => {
        pendingDeferredLockedDrains -= 1;
      });
    return { mode: 'deferred' };
  }

  try {
    for (const sessionId of sessionIds) {
      // eslint-disable-next-line no-restricted-syntax -- sync-acquire-after-holder-check-justified: the deferral branch above already drained same-process async holders, so this is a genuinely cross-process-only sync acquire (PM 260618_quit_save_sync_lock_contention).
      perSessionLocks.push(args.lockManager.acquirePerSessionSync(sessionId, lockOptions(args.ownerKind, args.maxRetryMs)));
    }
    // eslint-disable-next-line no-restricted-syntax -- sync-acquire-after-holder-check-justified: reached only after the same-process deferral branch above returned early; cross-process index lock only (PM 260618_quit_save_sync_lock_contention).
    const indexLock = args.lockManager.acquireGlobalIndexSync(lockOptions(args.ownerKind, args.maxRetryMs));
    try {
      const outcome = args.store.upsertSessionsSyncWithReload(args.sessions);
      return { mode: 'sync', outcome };
    } finally {
      indexLock.release();
    }
  } finally {
    for (const lock of perSessionLocks.reverse()) {
      lock.release();
    }
  }
}

function getSortedSessionIds(sessions: AgentSession[]): string[] {
  return [...new Set(sessions.map((session) => session.id))].sort();
}

function lockOptions(ownerKind: OwnerKind, maxRetryMs: number | undefined) {
  return {
    pid: process.pid,
    startedAt: Date.now(),
    ownerKind,
    ...(maxRetryMs === undefined ? {} : { maxRetryMs }),
  };
}
