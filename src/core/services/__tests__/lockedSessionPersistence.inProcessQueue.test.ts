/**
 * 260618 RC-3 (library-scan-freeze diagnosis): the renderer `sessions:upsert`
 * path (`upsertSessionsWithLocks`) and periodic turn checkpoints
 * (`updateSessionWithReload`) used to race at the non-reentrant per-session
 * FILE lock when they targeted the same session id in the same process. The
 * loser spun for `maxRetryMs` (200ms) against a multi-second hold and timed
 * out with a `LockAcquireTimeout` naming its own pid as the holder; the
 * timed-out upsert was then silently dropped. The fix routes BOTH writer
 * families through the same per-session in-process queue
 * (`inProcessSessionUpdateTails`), making same-process file-lock contention
 * unrepresentable.
 *
 * These tests model the real lock's load-bearing property — non-reentrant
 * per-id mutual exclusion with a finite acquire budget — with a fake lock
 * manager, then:
 *   1. (red baseline) prove the lock manager itself reproduces the timeout
 *      when two writers contend the same key directly (no queue).
 *   2. (red→green discriminators) the two cross-family tests below — a
 *      `upsertSessionsWithLocks` (sessions:upsert) racing an
 *      `updateSessionWithReload` (periodic checkpoint) for the SAME id —
 *      FAIL when the upsert path is not enrolled in the queue (verified by
 *      temporarily bypassing the wrap) and PASS with the fix: no timeout,
 *      both writes land, the upsert is not dropped.
 *   3. cover the multi-session-id batch ordering (no cross-id deadlock) and
 *      the serialisation/independence invariants.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  hasActiveAsyncLockedWriter,
  upsertSessionsWithLocks,
  upsertSessionsWithLocksSync,
  updateSessionWithReload,
  runWithGlobalIndexSerialized,
  type GlobalIndexTelemetry,
  type GlobalIndexSlowInfo,
} from '../lockedSessionPersistence';
import {
  LockAcquireTimeout,
  type LockAcquireOptions,
  type SessionLockHandle,
  type SessionLockManager,
  type SyncSessionLockHandle,
} from '@core/utils/sessionFileLock';
import type {
  IncrementalSessionStore,
  SessionsSyncUpsertOutcome,
} from '../incrementalSessionStore';
import type { AgentSession } from '@shared/types';

function makeSession(id: string): AgentSession {
  return {
    id,
    title: `Session ${id}`,
    createdAt: 1,
    updatedAt: 2,
    messages: [],
    eventsByTurn: {},
    activeTurnId: null,
    isBusy: false,
    lastError: null,
    resolvedAt: null,
    origin: 'manual',
  } as unknown as AgentSession;
}

/**
 * Models the real per-session file lock: non-reentrant mutual exclusion keyed
 * by lock name, with a finite `maxRetryMs` acquire budget. If a second
 * acquirer for a held key cannot get in before the budget expires, it throws
 * `LockAcquireTimeout` — exactly the pre-fix bug.
 *
 * The global index lock is modelled as a single shared key so an index-lock
 * collision is observable too.
 */
class FakeLockManager implements SessionLockManager {
  /** Currently-held lock keys → the pid that holds it (for timeout payloads). */
  private readonly held = new Map<string, number>();
  /** Peak observed concurrency per key — must stay 1 once serialised. */
  readonly peakConcurrency = new Map<string, number>();
  readonly syncAcquireCalls: string[] = [];
  private readonly current = new Map<string, number>();

  constructor(private readonly allowSyncAcquires = false) {}

  private async tryAcquire(key: string, opts: LockAcquireOptions): Promise<SessionLockHandle> {
    const deadline = Date.now() + (opts.maxRetryMs ?? 200);
    for (;;) {
      if (!this.held.has(key)) {
        this.held.set(key, opts.pid);
        const next = (this.current.get(key) ?? 0) + 1;
        this.current.set(key, next);
        this.peakConcurrency.set(key, Math.max(this.peakConcurrency.get(key) ?? 0, next));
        return {
          release: async () => {
            this.held.delete(key);
            this.current.set(key, (this.current.get(key) ?? 1) - 1);
          },
        };
      }
      if (Date.now() >= deadline) {
        throw new LockAcquireTimeout({
          lockPath: key,
          existingPid: this.held.get(key),
          ageMs: opts.maxRetryMs ?? 200,
        });
      }
      // Yield to let the holder finish its async work and release.
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  }

  acquirePerSession(sessionId: string, opts: LockAcquireOptions): Promise<SessionLockHandle> {
    return this.tryAcquire(`session:${sessionId}`, opts);
  }

  acquireGlobalIndex(opts: LockAcquireOptions): Promise<SessionLockHandle> {
    return this.tryAcquire('index', opts);
  }

  acquirePerSessionSync(sessionId: string, opts: LockAcquireOptions): SyncSessionLockHandle {
    return this.tryAcquireSync(`session:${sessionId}`, opts);
  }

  acquireGlobalIndexSync(opts: LockAcquireOptions): SyncSessionLockHandle {
    return this.tryAcquireSync('index', opts);
  }

  isHeld(key: string): boolean {
    return this.held.has(key);
  }

  private tryAcquireSync(key: string, opts: LockAcquireOptions): SyncSessionLockHandle {
    this.syncAcquireCalls.push(key);
    if (!this.allowSyncAcquires) {
      throw new Error(`sync path not exercised in this test: ${key}`);
    }
    if (this.held.has(key)) {
      throw new LockAcquireTimeout({
        lockPath: key,
        existingPid: this.held.get(key),
        ageMs: opts.maxRetryMs ?? 200,
      });
    }
    this.held.set(key, opts.pid);
    const next = (this.current.get(key) ?? 0) + 1;
    this.current.set(key, next);
    this.peakConcurrency.set(key, Math.max(this.peakConcurrency.get(key) ?? 0, next));
    return {
      release: () => {
        this.held.delete(key);
        this.current.set(key, (this.current.get(key) ?? 1) - 1);
      },
    };
  }
}

/**
 * A store whose reload-upsert deliberately HOLDS for `holdMs` while the locks
 * are held — modelling the slow full-index reload-write on cloud-synced FS
 * (the 3.4s hold from the incident). Records every persisted batch.
 */
function makeSlowStore(holdMs: number) {
  const persisted: string[][] = [];
  const sessions = new Map<string, AgentSession>();
  // We need the reload to be slow *inside* the lock window. The production
  // upsert is synchronous, so we emulate the hold by blocking the event loop
  // is wrong (it would starve the other writer's retry loop). Instead we make
  // `getSession` async-slow (matching `waitForIdle`/async getSession), which is
  // where the real hold's awaited work sits, and keep the sync write fast.
  const store = {
    getSession: vi.fn(async (id: string): Promise<AgentSession | null> => {
      if (holdMs > 0) await new Promise((r) => setTimeout(r, holdMs));
      return sessions.get(id) ?? null;
    }),
    upsertSessionsSyncWithReload: vi.fn((batch: AgentSession[]): SessionsSyncUpsertOutcome => {
      for (const s of batch) sessions.set(s.id, s);
      persisted.push(batch.map((s) => s.id));
      return {
        outcome: 'persisted',
        persistedSessionIds: batch.map((s) => s.id),
        droppedTombstonedSessionIds: [],
      };
    }),
    waitForIdle: vi.fn(async () => undefined),
  };
  return { store: store as unknown as IncrementalSessionStore, persisted, sessions };
}

afterEach(() => {
  vi.clearAllMocks();
});

async function waitForCondition(
  predicate: () => boolean,
  description: string,
  timeoutMs = 2000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) {
      throw new Error(`Timed out waiting for ${description}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

describe('RC-3 in-process serialisation of all session writers', () => {
  it('RED BASELINE: two concurrent writers hitting the lock manager directly time out + drop', async () => {
    // Reproduce the pre-fix world: drive the file-lock dance directly, with no
    // shared in-process queue, for the SAME session id. The slow holder keeps
    // the per-session lock past the 200ms budget; the second writer times out.
    const lockManager = new FakeLockManager();
    const sessionId = 'sess-contended';
    const opts: LockAcquireOptions = {
      pid: 1336,
      startedAt: Date.now(),
      ownerKind: 'desktop',
      maxRetryMs: 200,
    };

    // Writer A acquires and holds for ~500ms (> the 200ms budget).
    const holder = (async () => {
      const lock = await lockManager.acquirePerSession(sessionId, opts);
      await new Promise((r) => setTimeout(r, 500));
      await lock.release();
    })();

    // Let A grab the lock first.
    await new Promise((r) => setTimeout(r, 10));

    // Writer B (the renderer upsert) tries the same id and should time out.
    const writerB = lockManager.acquirePerSession(sessionId, opts);

    await expect(writerB).rejects.toBeInstanceOf(LockAcquireTimeout);
    await holder;
  });

  it('GREEN: upsert (sessions:upsert) and reload-checkpoint serialise for the same id — no timeout, both land', async () => {
    // The reload-checkpoint's awaited getSession holds the in-process slot for
    // 400ms — far past the 200ms file-lock budget. Pre-fix this would have
    // collided at the file lock; post-fix the queue serialises them.
    const lockManager = new FakeLockManager();
    const { store, persisted } = makeSlowStore(400);
    const sessionId = 'sess-shared';
    const ownerKind = 'desktop' as const;

    const checkpoint = updateSessionWithReload({
      sessionId,
      store,
      lockManager,
      ownerKind,
      update: () => makeSession(sessionId),
      maxRetryMs: 200,
    });

    // Fire the upsert ~immediately after, while the checkpoint is mid-hold.
    await new Promise((r) => setTimeout(r, 10));
    const upsert = upsertSessionsWithLocks({
      sessions: [makeSession(sessionId)],
      store,
      lockManager,
      ownerKind,
      maxRetryMs: 200,
    });

    const [checkpointResult, upsertOutcome] = await Promise.all([checkpoint, upsert]);

    // Both writers completed; neither timed out, neither was dropped.
    expect(checkpointResult.updated).toBe(true);
    expect(upsertOutcome.outcome).toBe('persisted');
    // Serialised: the per-session file lock was never held by two writers at once.
    expect(lockManager.peakConcurrency.get(`session:${sessionId}`)).toBe(1);
    expect(lockManager.peakConcurrency.get('index')).toBe(1);
    // Both writes landed on disk.
    expect(persisted.flat().filter((id) => id === sessionId).length).toBe(2);
  });

  it('GREEN: the second writer is NOT silently dropped (it persists, returns persisted)', async () => {
    const lockManager = new FakeLockManager();
    const { store, persisted } = makeSlowStore(300);
    const sessionId = 'sess-no-drop';

    const first = updateSessionWithReload({
      sessionId,
      store,
      lockManager,
      ownerKind: 'desktop',
      update: () => makeSession(sessionId),
      maxRetryMs: 200,
    });
    await new Promise((r) => setTimeout(r, 5));
    const second = upsertSessionsWithLocks({
      sessions: [makeSession(sessionId)],
      store,
      lockManager,
      ownerKind: 'desktop',
      maxRetryMs: 200,
    });

    const outcome = await second;
    await first;

    // The upsert that would have been dropped pre-fix now persists.
    expect(outcome.outcome).toBe('persisted');
    expect(persisted.flat()).toContain(sessionId);
  });

  it('GREEN: many concurrent same-id upserts all serialise (peak file-lock concurrency stays 1)', async () => {
    const lockManager = new FakeLockManager();
    const { store, persisted } = makeSlowStore(50);
    const sessionId = 'sess-burst';

    const writers = Array.from({ length: 8 }, () =>
      upsertSessionsWithLocks({
        sessions: [makeSession(sessionId)],
        store,
        lockManager,
        ownerKind: 'desktop',
        maxRetryMs: 200,
      }),
    );

    const outcomes = await Promise.all(writers);
    expect(outcomes.every((o) => o.outcome === 'persisted')).toBe(true);
    expect(lockManager.peakConcurrency.get(`session:${sessionId}`)).toBe(1);
    expect(persisted.length).toBe(8);
  });

  it('GREEN: multi-session-id batches with overlapping/reversed id sets do not deadlock and all land', async () => {
    // batch1 = {A,B}, batch2 = {B,A} (reversed), batch3 = {B,C}. Overlapping
    // and reordered id sets are the cross-id deadlock hazard the packet flags.
    // Capturing predecessors synchronously before installing tails makes the
    // wait graph a DAG → no deadlock. All batches must complete + land.
    const lockManager = new FakeLockManager();
    const { store, persisted } = makeSlowStore(40);

    const batch = (ids: string[]) =>
      upsertSessionsWithLocks({
        sessions: ids.map(makeSession),
        store,
        lockManager,
        ownerKind: 'desktop',
        maxRetryMs: 200,
      });

    const results = await Promise.race([
      Promise.all([batch(['A', 'B']), batch(['B', 'A']), batch(['B', 'C'])]),
      // Guard: if a deadlock formed, fail fast rather than hang the suite.
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('deadlock: batches did not settle')), 5000),
      ),
    ]);

    expect((results as SessionsSyncUpsertOutcome[]).every((o) => o.outcome === 'persisted')).toBe(true);
    // No file-lock concurrency on any id.
    expect(lockManager.peakConcurrency.get('session:A')).toBe(1);
    expect(lockManager.peakConcurrency.get('session:B')).toBe(1);
    expect(lockManager.peakConcurrency.get('session:C')).toBe(1);
    // Every batch's write landed.
    expect(persisted.length).toBe(3);
  });

  it('GREEN: independent session ids run concurrently (queue does not over-serialise)', async () => {
    // The queue must only serialise writers that SHARE an id. Two different
    // ids must be able to overlap — proving we did not accidentally globalise
    // the queue across all sessions. We instrument the store's reload (the
    // in-lock work) to record concurrent presence keyed by id.
    const lockManager = new FakeLockManager();
    const sessions = new Map<string, AgentSession>();
    let activeInLock = 0;
    let peakActive = 0;
    const store = {
      getSession: vi.fn(async (id: string): Promise<AgentSession | null> => sessions.get(id) ?? null),
      upsertSessionsSyncWithReload: vi.fn(async (): Promise<SessionsSyncUpsertOutcome> => {
        // Not used directly; reload work is modelled in waitForIdle below.
        return { outcome: 'persisted', persistedSessionIds: [], droppedTombstonedSessionIds: [] };
      }),
      // waitForIdle is awaited at the very start of the in-lock critical
      // section, so it is a faithful place to observe concurrency.
      waitForIdle: vi.fn(async () => {
        activeInLock += 1;
        peakActive = Math.max(peakActive, activeInLock);
        await new Promise((r) => setTimeout(r, 60));
        activeInLock -= 1;
      }),
    };
    // The real upsert is synchronous; wrap to record + store.
    store.upsertSessionsSyncWithReload = vi.fn((): SessionsSyncUpsertOutcome => {
      return { outcome: 'persisted', persistedSessionIds: [], droppedTombstonedSessionIds: [] };
    }) as never;

    const a = updateSessionWithReload({
      sessionId: 'A',
      store: store as unknown as IncrementalSessionStore,
      lockManager,
      ownerKind: 'desktop',
      update: () => makeSession('A'),
    });
    const b = updateSessionWithReload({
      sessionId: 'B',
      store: store as unknown as IncrementalSessionStore,
      lockManager,
      ownerKind: 'desktop',
      update: () => makeSession('B'),
    });

    await Promise.all([a, b]);
    // Two different ids ran their in-lock work concurrently.
    expect(peakActive).toBe(2);
  });
});

/**
 * 260618 RC-3 F1 (GPT-5.5-high confirming round): RC-3 closed the same-SESSION
 * dropped-write class at the per-session FILE lock, but every locked write ALSO
 * acquires the shared GLOBAL `index.lock`, and independent-session writers run
 * concurrently (they share no per-session predecessor). They therefore still
 * contended at `index.lock` with the same 200ms budget: a writer holding
 * `index.lock` across a slow (>200ms) full-index reload-upsert timed out a
 * concurrent DIFFERENT-session writer's `index.lock` acquire, which was then
 * dropped — the exact same dropped-write class, one lock over.
 *
 * The fix serialises the global-index critical section in-process across ALL
 * locked writers (`runWithGlobalIndexSerialized`), so same-process `index.lock`
 * contention is unrepresentable, composed with the per-session queue WITHOUT a
 * deadlock (per-session OUTER, single global-index tail INNER — arrival-ordered
 * DAG). These tests model the global lock with the same `FakeLockManager` (the
 * `index` key is a single shared non-reentrant lock with the 200ms budget).
 */
describe('RC-3 F1 in-process serialisation of the GLOBAL index lock', () => {
  it('RED BASELINE: two DIFFERENT-session writers contend index.lock directly → the second times out', async () => {
    // Reproduce the pre-fix world at the global lock: drive `acquireGlobalIndex`
    // directly with no in-process global serialisation. Writer A (session A)
    // holds the global lock past the 200ms budget; writer B (session B) — a
    // genuinely independent id, so nothing serialises it in-process pre-fix —
    // times out acquiring the SAME global `index.lock`.
    const lockManager = new FakeLockManager();
    const opts: LockAcquireOptions = {
      pid: 4242,
      startedAt: Date.now(),
      ownerKind: 'desktop',
      maxRetryMs: 200,
    };

    const holder = (async () => {
      const lock = await lockManager.acquireGlobalIndex(opts);
      await new Promise((r) => setTimeout(r, 500)); // > 200ms budget
      await lock.release();
    })();

    await new Promise((r) => setTimeout(r, 10)); // let A grab index.lock first

    const writerB = lockManager.acquireGlobalIndex(opts);
    await expect(writerB).rejects.toBeInstanceOf(LockAcquireTimeout);
    await holder;
  });

  it('GREEN: DIFFERENT-session writers, one holding the global index slowly (>200ms), BOTH land — no LockAcquireTimeout', async () => {
    // The slow reload (`getSession` → holdMs) sits INSIDE the global-index
    // section. Pre-fix, writer B (independent id, runs concurrently) would hit
    // `acquireGlobalIndex` while A still held it across the 400ms hold and time
    // out after 200ms → dropped. Post-fix, B's global section waits on A's tail
    // and runs after release, so both persist. This is the discriminating case:
    // it would FAIL if `runWithGlobalIndexSerialized` were a no-op (B would
    // throw LockAcquireTimeout).
    const lockManager = new FakeLockManager();
    const { store, persisted } = makeSlowStore(400);
    const ownerKind = 'desktop' as const;

    // Writer A: session A, will be the slow global-index holder.
    const writerA = updateSessionWithReload({
      sessionId: 'sess-A',
      store,
      lockManager,
      ownerKind,
      update: () => makeSession('sess-A'),
      maxRetryMs: 200,
    });

    // Fire writer B (DIFFERENT session) ~immediately, while A is mid-hold.
    await new Promise((r) => setTimeout(r, 10));
    const writerB = upsertSessionsWithLocks({
      sessions: [makeSession('sess-B')],
      store,
      lockManager,
      ownerKind,
      maxRetryMs: 200,
    });

    const [aResult, bOutcome] = await Promise.all([writerA, writerB]);

    // Neither timed out; both writes landed.
    expect(aResult.updated).toBe(true);
    expect(bOutcome.outcome).toBe('persisted');
    // The global index lock was never held by two same-process writers at once.
    expect(lockManager.peakConcurrency.get('index')).toBe(1);
    // Both DIFFERENT-session writes are on disk — neither dropped.
    expect(persisted.flat()).toContain('sess-A');
    expect(persisted.flat()).toContain('sess-B');
  });

  it('GREEN: many concurrent DIFFERENT-session reload-checkpoints all serialise at the global index (peak index concurrency stays 1, none dropped)', async () => {
    // The burst the incident describes: independent sessions checkpointing at
    // once. We use the reload path (`updateSessionWithReload`) whose slow awaited
    // `getSession` (120ms) sits INSIDE the global-index section — so each writer
    // genuinely holds `index.lock` for ~120ms. With only the per-session queue,
    // all 8 reach `acquireGlobalIndex` concurrently (different ids) and, since
    // the serial drain (8 × 120ms ≈ 960ms) far exceeds the 200ms acquire budget,
    // the later arrivals time out and drop pre-fix. Post-fix they serialise
    // behind the in-process global-index tail and all land.
    const lockManager = new FakeLockManager();
    const { store, persisted } = makeSlowStore(120);

    const writers = Array.from({ length: 8 }, (_unused, i) =>
      updateSessionWithReload({
        sessionId: `burst-${i}`,
        store,
        lockManager,
        ownerKind: 'desktop',
        update: () => makeSession(`burst-${i}`),
        maxRetryMs: 200,
      }),
    );

    const results = await Promise.all(writers);
    expect(results.every((r) => r.updated)).toBe(true);
    expect(lockManager.peakConcurrency.get('index')).toBe(1);
    expect(persisted.length).toBe(8);
  });

  it('DEADLOCK-FREEDOM: per-session + global-index serialisation cannot wedge — independent + overlapping ids all settle within the guard', async () => {
    // Stress the composition: a mix of independent ids (A; D), overlapping
    // multi-id batches ({B,C} and {C,B} reversed), and same-id contention (two
    // writers on E) — all racing for the single global-index tail AND the
    // per-session queue at once. If the two in-process primitives could form a
    // hold-and-wait cycle, this hangs; the timeout guard then fails the test.
    // The slow hold (>0) keeps the global-index section occupied so the tail is
    // genuinely contended (not trivially uncontended).
    const lockManager = new FakeLockManager();
    const { store, persisted } = makeSlowStore(40);

    const upsert = (ids: string[]) =>
      upsertSessionsWithLocks({
        sessions: ids.map(makeSession),
        store,
        lockManager,
        ownerKind: 'desktop',
        maxRetryMs: 200,
      });
    const reload = (id: string) =>
      updateSessionWithReload({
        sessionId: id,
        store,
        lockManager,
        ownerKind: 'desktop',
        update: () => makeSession(id),
        maxRetryMs: 200,
      });

    const work = Promise.all([
      upsert(['A']),
      upsert(['B', 'C']),
      upsert(['C', 'B']), // reversed overlap with the previous batch
      reload('D'),
      reload('E'),
      reload('E'), // same-id contention on E
    ]);

    const guard = new Promise<never>((_resolve, reject) =>
      setTimeout(() => reject(new Error('DEADLOCK: writers did not settle within the guard window')), 5000),
    );

    await Promise.race([work, guard]);

    // Everything settled (no deadlock) and every write landed. peak global-index
    // concurrency must remain 1 throughout despite the contention.
    expect(lockManager.peakConcurrency.get('index')).toBe(1);
    expect(lockManager.peakConcurrency.get('session:A')).toBe(1);
    expect(lockManager.peakConcurrency.get('session:B')).toBe(1);
    expect(lockManager.peakConcurrency.get('session:C')).toBe(1);
    expect(lockManager.peakConcurrency.get('session:E')).toBe(1);
    const landed = persisted.flat();
    for (const id of ['A', 'B', 'C', 'D', 'E']) {
      expect(landed).toContain(id);
    }
  });

  it('GREEN: a REJECTED global-index section does not wedge the tail for the writer chained behind it', async () => {
    // The tail swallows a predecessor rejection (`.then(ok, err)`). Writer A's
    // global section throws (e.g. the store aborts mid-reload) while still
    // in-flight; writer B (different id) is fired immediately so it genuinely
    // chains behind A's rejecting tail. B must still acquire the global index
    // and persist rather than inheriting A's rejection or hanging forever.
    const lockManager = new FakeLockManager();
    const sessions = new Map<string, AgentSession>();
    let firstUpsert = true;
    const store = {
      getSession: vi.fn(async (id: string): Promise<AgentSession | null> => {
        // Hold the global-index section so B chains behind A's tail rather than
        // racing it (and so peak index concurrency is meaningfully observed).
        await new Promise((r) => setTimeout(r, 50));
        return sessions.get(id) ?? null;
      }),
      upsertSessionsSyncWithReload: vi.fn((batch: AgentSession[]): SessionsSyncUpsertOutcome => {
        if (firstUpsert) {
          firstUpsert = false;
          throw new Error('store aborted mid-write');
        }
        for (const s of batch) sessions.set(s.id, s);
        return {
          outcome: 'persisted',
          persistedSessionIds: batch.map((s) => s.id),
          droppedTombstonedSessionIds: [],
        };
      }),
      waitForIdle: vi.fn(async () => undefined),
    } as unknown as IncrementalSessionStore;

    // Attach A's rejection handler SYNCHRONOUSLY at creation so the rejection
    // is never momentarily unhandled (avoids a PromiseRejectionHandledWarning
    // that vitest surfaces as an error / false positive).
    let aError: unknown;
    const writerA = upsertSessionsWithLocks({
      sessions: [makeSession('reject-A')],
      store,
      lockManager,
      ownerKind: 'desktop',
      maxRetryMs: 200,
    }).catch((err) => {
      aError = err;
    });
    // Fire B while A is still mid-hold so B is chained behind A's tail.
    await new Promise((r) => setTimeout(r, 10));
    const writerB = upsertSessionsWithLocks({
      sessions: [makeSession('reject-B')],
      store,
      lockManager,
      ownerKind: 'desktop',
      maxRetryMs: 200,
    });

    // A's section rejects; B must still persist (not wedge, not time out).
    await writerA;
    expect((aError as Error)?.message).toBe('store aborted mid-write');
    const bOutcome = await Promise.race([
      writerB,
      new Promise<never>((_r, reject) =>
        setTimeout(() => reject(new Error('B wedged behind A rejected tail')), 3000),
      ),
    ]);
    expect((bOutcome as SessionsSyncUpsertOutcome).outcome).toBe('persisted');
    // A's failed section released the global lock (finally) → no leak, no
    // double-hold.
    expect(lockManager.peakConcurrency.get('index')).toBe(1);
  });
});

describe('Stage 1 sync quit-save deferral behind active async locked writers', () => {
  it('defers instead of taking the sync per-session lock when an async same-id writer is in flight, then persists the final snapshot', async () => {
    const lockManager = new FakeLockManager();
    const { store, persisted } = makeSlowStore(300);
    const sessionId = 'sync-contention-same-id';

    const checkpoint = updateSessionWithReload({
      sessionId,
      store,
      lockManager,
      ownerKind: 'desktop',
      update: () => makeSession(sessionId),
      maxRetryMs: 200,
    });

    await waitForCondition(
      () => hasActiveAsyncLockedWriter() && lockManager.isHeld(`session:${sessionId}`),
      'async writer to hold the per-session lock',
    );

    const startedAt = Date.now();
    const result = upsertSessionsWithLocksSync({
      sessions: [makeSession(sessionId)],
      store,
      lockManager,
      ownerKind: 'desktop',
      maxRetryMs: 200,
    });
    const elapsedMs = Date.now() - startedAt;

    expect(result).toEqual({ mode: 'deferred' });
    expect(elapsedMs).toBeLessThan(50);
    expect(lockManager.syncAcquireCalls).toEqual([]);

    await checkpoint;
    await waitForCondition(
      () => persisted.flat().filter((id) => id === sessionId).length === 2,
      'deferred same-id sync snapshot to persist',
    );
  });

  it('defers when an async different-id writer holds the global index lock, then persists the final snapshot', async () => {
    const lockManager = new FakeLockManager();
    const { store, persisted } = makeSlowStore(300);
    const holderId = 'global-holder';
    const saveId = 'sync-contention-different-id';

    const globalHolder = updateSessionWithReload({
      sessionId: holderId,
      store,
      lockManager,
      ownerKind: 'desktop',
      update: () => makeSession(holderId),
      maxRetryMs: 200,
    });

    await waitForCondition(
      () => hasActiveAsyncLockedWriter() && lockManager.isHeld('index'),
      'async writer to hold the global index lock',
    );

    const startedAt = Date.now();
    const result = upsertSessionsWithLocksSync({
      sessions: [makeSession(saveId)],
      store,
      lockManager,
      ownerKind: 'desktop',
      maxRetryMs: 200,
    });
    const elapsedMs = Date.now() - startedAt;

    expect(result).toEqual({ mode: 'deferred' });
    expect(elapsedMs).toBeLessThan(50);
    expect(lockManager.syncAcquireCalls).toEqual([]);

    await globalHolder;
    await waitForCondition(
      () => persisted.flat().includes(saveId),
      'deferred different-id sync snapshot to persist',
    );
  });

  it('reports the sync fast-path outcome when there is no active async writer', () => {
    const lockManager = new FakeLockManager(true);
    const { store, persisted } = makeSlowStore(0);
    const sessionId = 'sync-fast-path';

    expect(hasActiveAsyncLockedWriter()).toBe(false);
    const result = upsertSessionsWithLocksSync({
      sessions: [makeSession(sessionId)],
      store,
      lockManager,
      ownerKind: 'desktop',
      maxRetryMs: 200,
    });

    if (result.mode !== 'sync') {
      throw new Error(`Expected sync fast path, got ${result.mode}`);
    }
    expect(result.outcome.outcome).toBe('persisted');
    expect(lockManager.syncAcquireCalls).toEqual([`session:${sessionId}`, 'index']);
    expect(persisted.flat()).toContain(sessionId);
  });

  it('surfaces dropped sync fast-path outcomes so the IPC handler can report failure', () => {
    const lockManager = new FakeLockManager(true);
    const droppedStore = {
      ...makeSlowStore(0).store,
      upsertSessionsSyncWithReload: vi.fn((): SessionsSyncUpsertOutcome => ({
        outcome: 'dropped',
        reason: 'read-only',
      })),
    } as unknown as IncrementalSessionStore;

    const result = upsertSessionsWithLocksSync({
      sessions: [makeSession('sync-read-only-drop')],
      store: droppedStore,
      lockManager,
      ownerKind: 'desktop',
      maxRetryMs: 200,
    });

    expect(result).toEqual({
      mode: 'sync',
      outcome: { outcome: 'dropped', reason: 'read-only' },
    });
  });

  it('exposes active async locked writer bracketing for the full lock window', async () => {
    const lockManager = new FakeLockManager();
    const { store } = makeSlowStore(150);
    const sessionId = 'active-counter-bracket';

    expect(hasActiveAsyncLockedWriter()).toBe(false);
    const writer = updateSessionWithReload({
      sessionId,
      store,
      lockManager,
      ownerKind: 'desktop',
      update: () => makeSession(sessionId),
      maxRetryMs: 200,
    });

    await waitForCondition(
      () => hasActiveAsyncLockedWriter() && lockManager.isHeld(`session:${sessionId}`),
      'active async writer predicate to turn true while locks are held',
    );
    expect(hasActiveAsyncLockedWriter()).toBe(true);

    await writer;
    expect(hasActiveAsyncLockedWriter()).toBe(false);
  });
});

/**
 * 260618 RC-3 F1 review F2 + round-4 (observability): the global-index tail has a
 * process-wide blast radius — one slow/HUNG section stalls EVERY async locked
 * writer across ALL sessions. Round-4 found two must-fixes: (F1) the old
 * post-hoc/finally measurement never observed a NEVER-settling hang (the check
 * only ran after settlement), so we now arm a WATCHDOG timer per phase that fires
 * `onSlow({ stillRunning: true })` WHILE still stuck; (F2) a throwing `onSlow`
 * sink must be strictly best-effort — it must never skip the write, mask the
 * store/lock error, or flip a persisted write into a rejected result.
 *
 * These tests drive `runWithGlobalIndexSerialized` directly through the injected
 * telemetry seam. Instead of real timers we capture the armed watchdog callbacks
 * and fire them manually — fully deterministic, no real-time waits, no
 * log-Proxy spying.
 */
describe('RC-3 F1 F2 global-index watchdog telemetry + best-effort sink', () => {
  interface ArmedWatchdog { ms: number; fire: () => void; cleared: boolean }
  /**
   * A controllable clock + capturing onSlow sink + a MANUAL watchdog seam. Armed
   * watchdogs are recorded; `fireArmed()` invokes the still-armed (not-yet-cleared)
   * fire callbacks to simulate "threshold elapsed while still stuck".
   */
  function makeTelemetry(opts?: {
    slowWaitMs?: number;
    slowSectionMs?: number;
    onSlow?: (info: GlobalIndexSlowInfo) => void;
  }) {
    let nowMs = 0;
    const slow: GlobalIndexSlowInfo[] = [];
    const watchdogs: ArmedWatchdog[] = [];
    const telemetry: GlobalIndexTelemetry = {
      now: () => nowMs,
      slowWaitMs: opts?.slowWaitMs ?? 3000,
      slowSectionMs: opts?.slowSectionMs ?? 3000,
      setWatchdog: (ms, fire) => {
        const armed: ArmedWatchdog = { ms, fire, cleared: false };
        watchdogs.push(armed);
        return () => { armed.cleared = true; };
      },
      onSlow: opts?.onSlow ?? ((info) => slow.push(info)),
    };
    return {
      telemetry,
      slow,
      advance: (ms: number) => { nowMs += ms; },
      /** Fire every still-armed watchdog (simulates the threshold elapsing). */
      fireArmed: () => { for (const w of watchdogs) if (!w.cleared) w.fire(); },
      armedCount: () => watchdogs.filter((w) => !w.cleared).length,
    };
  }

  it('F1 WATCHDOG: a never-settling WAIT (hung predecessor) fires onSlow(stillRunning:true) WHILE still waiting', async () => {
    const tel = makeTelemetry();

    // Predecessor never settles — the classic high-blast-radius wedge.
    let releaseHolder!: () => void;
    const holderGate = new Promise<void>((resolve) => { releaseHolder = resolve; });
    const holder = runWithGlobalIndexSerialized(
      { opKind: 'reload-checkpoint', sessionIds: ['hung-holder'] },
      async () => { await holderGate; },
      tel.telemetry,
    );

    // Follower queues behind the (still-running) holder and never gets in.
    let followerSettled = false;
    const follower = runWithGlobalIndexSerialized(
      { opKind: 'upsert', sessionIds: ['A', 'B'] },
      async () => undefined,
      tel.telemetry,
    ).then(() => { followerSettled = true; });

    // Let the microtasks settle so the follower is genuinely parked on its WAIT
    // watchdog (the holder is inside its section, also armed on its SECTION).
    await Promise.resolve();
    await Promise.resolve();

    // Simulate the threshold elapsing while everything is still stuck.
    tel.advance(3000);
    tel.fireArmed();

    // The follower's WAIT watchdog fired in real time even though it never
    // entered the section; the holder's SECTION watchdog fired too.
    const waitWarn = tel.slow.find((s) => s.phase === 'wait' && s.stillRunning);
    expect(waitWarn).toBeDefined();
    expect(waitWarn?.opKind).toBe('upsert');
    expect(waitWarn?.sessionIds).toEqual(['A', 'B']);
    expect(waitWarn?.durationMs).toBe(3000); // threshold; "still stuck past this"
    expect(tel.slow.some((s) => s.phase === 'section' && s.stillRunning && s.opKind === 'reload-checkpoint')).toBe(true);
    // The follower is still NOT settled — telemetry observed the hang without
    // unblocking or aborting it.
    expect(followerSettled).toBe(false);

    // Clean up so the test doesn't leak a pending promise.
    releaseHolder();
    await Promise.all([holder, follower]);
  });

  it('F1 WATCHDOG: a slow-but-eventually-settled SECTION fires stillRunning:true then a closure with the true duration', async () => {
    const tel = makeTelemetry();

    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const op = runWithGlobalIndexSerialized(
      { opKind: 'reload-checkpoint', sessionIds: ['slow-one'] },
      async () => { await gate; },
      tel.telemetry,
    );
    await Promise.resolve();
    await Promise.resolve();

    // Threshold elapses while still holding → watchdog fires.
    tel.advance(3000);
    tel.fireArmed();
    // Then it takes another 2s and finally settles.
    tel.advance(2000);
    release();
    await op;

    const stuck = tel.slow.find((s) => s.phase === 'section' && s.stillRunning);
    expect(stuck).toBeDefined();
    expect(stuck?.durationMs).toBe(3000); // threshold at watchdog fire
    const closure = tel.slow.find((s) => s.phase === 'section' && !s.stillRunning);
    expect(closure).toBeDefined();
    expect(closure?.durationMs).toBe(5000); // true total held duration
    expect(closure?.opKind).toBe('reload-checkpoint');
    expect(closure?.sessionIds).toEqual(['slow-one']);
  });

  it('does NOT warn when wait + section both finish before the watchdog (timers cleared)', async () => {
    const tel = makeTelemetry();

    await runWithGlobalIndexSerialized(
      { opKind: 'upsert', sessionIds: ['fast'] },
      async () => { tel.advance(10); },
      tel.telemetry,
    );

    // Both watchdogs were cleared on settlement → firing them is a no-op.
    expect(tel.armedCount()).toBe(0);
    tel.fireArmed();
    expect(tel.slow).toHaveLength(0);
  });

  it('F2 BEST-EFFORT: a throwing onSlow in the SECTION watchdog still PERSISTS the write and returns the real outcome', async () => {
    // The watchdog fires while the (successful) section is still running and the
    // sink THROWS. The write must still land and the real persisted outcome must
    // be returned — telemetry must not perturb persistence.
    const tel = makeTelemetry({
      onSlow: () => { throw new Error('sink boom'); },
    });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });

    let persisted = false;
    const op = runWithGlobalIndexSerialized(
      { opKind: 'upsert', sessionIds: ['persist-me'] },
      async () => {
        await gate;
        persisted = true;
        return { outcome: 'persisted' as const, persistedSessionIds: ['persist-me'], droppedTombstonedSessionIds: [] };
      },
      tel.telemetry,
    );
    await Promise.resolve();
    await Promise.resolve();

    // Threshold elapses, the throwing sink fires — must be swallowed.
    tel.advance(3000);
    expect(() => tel.fireArmed()).not.toThrow();
    release();

    const result = await op; // must NOT reject from the sink throw
    expect(persisted).toBe(true);
    expect(result.outcome).toBe('persisted');
  });

  it('F2 BEST-EFFORT: a throwing onSlow on a FAILING section preserves the ORIGINAL operation error (not the sink error)', async () => {
    const tel = makeTelemetry({
      onSlow: () => { throw new Error('sink boom'); },
    });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });

    const op = runWithGlobalIndexSerialized(
      { opKind: 'upsert', sessionIds: ['will-fail'] },
      async () => { await gate; throw new Error('store aborted mid-write'); },
      tel.telemetry,
    );
    await Promise.resolve();
    await Promise.resolve();

    tel.advance(3000);
    expect(() => tel.fireArmed()).not.toThrow(); // section watchdog sink throws → swallowed
    release();

    // The caller sees the STORE error, never the sink error.
    await expect(op).rejects.toThrow('store aborted mid-write');
  });

  it('F2 BEST-EFFORT: a throwing onSlow in the WAIT watchdog does not skip the follower write', async () => {
    // Pre-fix hazard: a throwing sink in the wait phase rejected `run` BEFORE
    // operation() ran → the write was skipped. With the watchdog firing in a
    // timer callback (off the await chain) AND wrapped, the follower must still
    // run its operation and persist.
    const tel = makeTelemetry({
      onSlow: () => { throw new Error('wait sink boom'); },
    });

    let releaseHolder!: () => void;
    const holderGate = new Promise<void>((resolve) => { releaseHolder = resolve; });
    const holder = runWithGlobalIndexSerialized(
      { opKind: 'reload-checkpoint', sessionIds: ['holder'] },
      async () => { await holderGate; },
      tel.telemetry,
    );

    let followerRan = false;
    const follower = runWithGlobalIndexSerialized(
      { opKind: 'upsert', sessionIds: ['follower'] },
      async () => { followerRan = true; return { outcome: 'persisted' as const, persistedSessionIds: ['follower'], droppedTombstonedSessionIds: [] }; },
      tel.telemetry,
    );

    await Promise.resolve();
    await Promise.resolve();
    tel.advance(3000);
    expect(() => tel.fireArmed()).not.toThrow(); // follower's wait-watchdog sink throws → swallowed
    releaseHolder();

    const [, followerOutcome] = await Promise.all([holder, follower]);
    expect(followerRan).toBe(true);
    expect(followerOutcome.outcome).toBe('persisted');
  });

  it('the DEFAULT telemetry path (no injection) persists a fast op without warning — production wiring sanity', async () => {
    // Exercises the real default telemetry (Date.now + unref'd setTimeout +
    // log.warn). A fast op must compose cleanly and return persisted; the unref'd
    // timers must not hang the test.
    const lockManager = new FakeLockManager();
    const { store, persisted } = makeSlowStore(0);
    const outcome = await upsertSessionsWithLocks({
      sessions: [makeSession('default-fast')],
      store,
      lockManager,
      ownerKind: 'desktop',
      maxRetryMs: 200,
    });
    expect(outcome.outcome).toBe('persisted');
    expect(persisted.flat()).toContain('default-fast');
  });
});
