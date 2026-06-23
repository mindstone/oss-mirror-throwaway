/**
 * 260618 quit-save lock-contention fix — genuine red→green regression suite.
 *
 * These tests use the REAL `createSessionLockManager` (temp dir, real
 * `Atomics.wait` busy-wait) rather than a cooperative fake, so they demonstrate
 * the ACTUAL production pathology and that the fix avoids it (Phase-5 review
 * MA1 / F2 — the fake-based tests in `lockedSessionPersistence.inProcessQueue.test.ts`
 * proved the fix's API shape but not the event-loop-freeze bug).
 *
 * The bug: a renderer `beforeunload` → `sessions:save-sync` → `upsertSessionsWithLocksSync`
 * synchronously busy-waits (`Atomics.wait`) for a session/index FILE lock. When a
 * SAME-PROCESS async writer holds that lock, its `release()` is a microtask on the
 * now-frozen loop and can never run → `LockAcquireTimeout` → the final snapshot is
 * dropped. The fix: detect an in-flight async writer (or pending deferred drain)
 * synchronously and re-route the snapshot through the async queue instead of
 * busy-waiting. Reachable only when MAIN survives the renderer teardown
 * (reload/HMR/window-close), so the deferred drain lands.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  upsertSessionsWithLocksSync,
  updateSessionWithReload,
  hasActiveAsyncLockedWriter,
  hasPendingLocalSessionDrain,
} from '../lockedSessionPersistence';
import {
  LockAcquireTimeout,
  createSessionLockManager,
  type SessionLockManager,
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
 * In-memory store; `getSession` can be made async-slow (`holdMs`) to model the
 * real reload-write hold inside the lock window (matching `makeSlowStore` in the
 * sibling test). The sync write is fast, mirroring production.
 */
function makeStore(holdMs = 0) {
  const sessions = new Map<string, AgentSession>();
  const persisted: string[][] = [];
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

async function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('waitFor timed out');
    await new Promise((r) => setTimeout(r, 5));
  }
}

describe('quit-save sync lock-contention fix (real lock manager)', () => {
  let tempDir: string | undefined;

  async function freshManager(): Promise<SessionLockManager> {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'quit-save-lock-'));
    return createSessionLockManager({
      locksDirectory: tempDir,
      isProcessAlive: () => true, // never treat held locks as stale during the test
      now: Date.now,
    });
  }

  afterEach(async () => {
    // Drain any deferred work so module counters return to 0 between tests.
    await waitFor(() => !hasPendingLocalSessionDrain()).catch(() => undefined);
    vi.restoreAllMocks();
    if (tempDir) {
      await fs.rm(tempDir, { recursive: true, force: true });
      tempDir = undefined;
    }
  });

  it('documents the bug: a SAME-PID held lock makes the sync acquire busy-wait and time out', async () => {
    const manager = await freshManager();
    // An async writer holds the per-session lock with THIS process's pid.
    const holder = await manager.acquirePerSession('S', {
      pid: process.pid,
      startedAt: Date.now(),
      ownerKind: 'desktop',
    });

    // The pre-fix sync save path called this directly: against a same-pid hold it
    // can only spin its budget (Atomics.wait freezes the loop the holder needs to
    // release on) and throw — i.e. the final save was dropped.
    const start = Date.now();
    expect(() =>
      manager.acquirePerSessionSync('S', {
        pid: process.pid,
        startedAt: Date.now(),
        ownerKind: 'desktop',
        maxRetryMs: 150,
      }),
    ).toThrow(LockAcquireTimeout);
    expect(Date.now() - start).toBeGreaterThanOrEqual(140);

    await holder.release();
  });

  it('GREEN: an in-flight async holder makes the sync save DEFER (no busy-wait) and the snapshot still persists', async () => {
    const manager = await freshManager();
    const { store, sessions } = makeStore(120); // getSession holds the lock window ~120ms
    sessions.set('S', makeSession('S'));

    // Start an async checkpoint that holds the per-session + index FILE locks.
    const holder = updateSessionWithReload({
      sessionId: 'S',
      store,
      lockManager: manager,
      ownerKind: 'desktop',
      update: (existing) => ({ ...(existing ?? makeSession('S')), title: 'from-checkpoint' }),
    });

    // Let the holder enter its lock window (counter > 0).
    await waitFor(() => hasActiveAsyncLockedWriter());

    // The quit-time sync save fires while the holder is mid-write.
    const finalSnapshot = { ...makeSession('S'), title: 'final-unload-snapshot' };
    const start = Date.now();
    const result = upsertSessionsWithLocksSync({
      sessions: [finalSnapshot],
      store,
      lockManager: manager,
      ownerKind: 'desktop',
    });

    // It must DEFER, return immediately (NOT busy-wait the ~200ms budget), and not throw.
    expect(result).toEqual({ mode: 'deferred' });
    expect(Date.now() - start).toBeLessThan(100);

    await holder;
    await waitFor(() => sessions.get('S')?.title === 'final-unload-snapshot');
    // The final unload snapshot persisted (R1) — it was NOT dropped.
    expect(sessions.get('S')?.title).toBe('final-unload-snapshot');
  });

  it('defers on the GLOBAL index lock too: an async holder of a DIFFERENT session id still forces deferral', async () => {
    const manager = await freshManager();
    const { store, sessions } = makeStore(120);
    sessions.set('OTHER', makeSession('OTHER'));

    const holder = updateSessionWithReload({
      sessionId: 'OTHER', // different id — only the shared global index.lock overlaps
      store,
      lockManager: manager,
      ownerKind: 'desktop',
      update: (existing) => existing ?? makeSession('OTHER'),
    });
    await waitFor(() => hasActiveAsyncLockedWriter());

    const result = upsertSessionsWithLocksSync({
      sessions: [{ ...makeSession('S'), title: 'final' }],
      store,
      lockManager: manager,
      ownerKind: 'desktop',
    });
    expect(result).toEqual({ mode: 'deferred' });

    await holder;
    await waitFor(() => sessions.get('S')?.title === 'final');
    expect(sessions.get('S')?.title).toBe('final');
  });

  it('TOCTOU (review F1): hasPendingLocalSessionDrain() stays true from defer until the deferred drain persists', async () => {
    const manager = await freshManager();
    const { store, sessions, persisted } = makeStore(80);
    sessions.set('S', makeSession('S'));

    const holder = updateSessionWithReload({
      sessionId: 'S',
      store,
      lockManager: manager,
      ownerKind: 'desktop',
      update: (existing) => existing ?? makeSession('S'),
    });
    await waitFor(() => hasActiveAsyncLockedWriter());

    const result = upsertSessionsWithLocksSync({
      sessions: [{ ...makeSession('S'), title: 'final' }],
      store,
      lockManager: manager,
      ownerKind: 'desktop',
    });
    expect(result).toEqual({ mode: 'deferred' });

    // SYNCHRONOUSLY true the instant the defer returns — the bracket is set
    // before the fire-and-forget, so there is no false-idle window for the cloud
    // forwarder even after the original holder releases (when the narrow
    // hasActiveAsyncLockedWriter() momentarily drops to 0).
    expect(hasPendingLocalSessionDrain()).toBe(true);

    await holder; // original holder fully settles (narrow counter → 0)
    // The deferred snapshot must still be accounted-for until it actually persists.
    if (!persisted.some((b) => b.includes('S') && sessions.get('S')?.title === 'final')) {
      expect(hasPendingLocalSessionDrain()).toBe(true);
    }
    await waitFor(() => sessions.get('S')?.title === 'final');
    await waitFor(() => !hasPendingLocalSessionDrain());
    expect(hasPendingLocalSessionDrain()).toBe(false);
  });

  it('R4: a DIFFERENT-process lock holder (no in-process writer) still uses the synchronous busy-wait path, NOT deferral', async () => {
    const manager = await freshManager();
    const { store } = makeStore(0);

    // A foreign process holds the per-session lock; no in-process async writer is
    // active, so the counter is 0 and deferral must NOT fire — cross-process
    // contention is still the file lock's job (R4).
    const foreign = await manager.acquirePerSession('S', {
      pid: process.pid + 1, // a different pid, kept "alive" by isProcessAlive: () => true
      startedAt: Date.now(),
      ownerKind: 'desktop',
    });

    expect(hasPendingLocalSessionDrain()).toBe(false);
    // The sync path takes the real busy-wait and throws LockAcquireTimeout (the
    // existing cross-process behavior) rather than silently deferring.
    expect(() =>
      upsertSessionsWithLocksSync({
        sessions: [makeSession('S')],
        store,
        lockManager: manager,
        ownerKind: 'desktop',
        maxRetryMs: 150,
      }),
    ).toThrow(LockAcquireTimeout);

    await foreign.release();
  });

  it('no contention: the sync fast path runs and returns the store outcome (R3 plumbing)', async () => {
    const manager = await freshManager();
    const { store, sessions } = makeStore(0);

    expect(hasPendingLocalSessionDrain()).toBe(false);
    const result = upsertSessionsWithLocksSync({
      sessions: [makeSession('S')],
      store,
      lockManager: manager,
      ownerKind: 'desktop',
    });
    expect(result.mode).toBe('sync');
    if (result.mode === 'sync') {
      expect(result.outcome.outcome).toBe('persisted');
    }
    expect(sessions.has('S')).toBe(true);
  });
});
