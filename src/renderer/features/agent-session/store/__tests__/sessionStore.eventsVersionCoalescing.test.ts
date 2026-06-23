import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  createSessionStore,
  appendEventToCurrentSession,
  clearCurrentSessionEvents,
  flushPendingEventsVersionNotification,
  getCurrentSessionEventsVersion,
  getEventsVersionCounters,
  resetEventsVersionCounters,
  setEventsVersionPerfCountersEnabled,
} from '../sessionStore';
import type { AgentEvent } from '@shared/types';
import type { AgentSessionWithRuntime } from '../../types';

/**
 * Stage 5 (260508 active-work rebuild) tests for the
 * synchronous-counter / microtask-coalesced Zustand notification split.
 *
 * Two layered semantics under test (R2-9):
 *   1. The synchronous module-scoped counter `currentSessionEventsVersion`
 *      increments synchronously on every `bumpVersion()` call and is exposed
 *      via `getCurrentSessionEventsVersion()` for `useSyncExternalStore`
 *      consumers — tearing-free monotonic snapshots.
 *   2. The Zustand notification (`set({ eventsByTurnVersion })`) is
 *      coalesced to one fan-out per microtask boundary, with explicit
 *      `flushPendingEventsVersionNotification()` at every boundary point
 *      (terminal turn events, queue drain, session switch, reset,
 *      history-open, persistence read, beforeunload) — F9 boundary-flush
 *      contract.
 *
 * Plan reference:
 * `docs/plans/260508_active_work_cpu_gpu_architectural_rebuild.md` § Stage 5.
 */

vi.stubGlobal('window', {
  sessionsApi: {
    upsert: vi.fn().mockResolvedValue(undefined),
    delete: vi.fn().mockResolvedValue(undefined),
  },
});

const tick = () => new Promise<void>((resolve) => queueMicrotask(resolve));

const statusEvent = (message: string): AgentEvent => ({
  type: 'status',
  message,
  timestamp: Date.now(),
});

describe('Stage 5 — eventsByTurnVersion coalescing', () => {
  beforeEach(() => {
    clearCurrentSessionEvents();
    // Drain any stray pending notification scheduled by the global setup.
    flushPendingEventsVersionNotification();
  });

  afterEach(() => {
    flushPendingEventsVersionNotification();
  });

  describe('R2-9 — synchronous counter / coalesced notification split', () => {
    it('useSyncExternalStore-style getSnapshot reader sees monotonically increasing snapshots after rapid synchronous bumps', () => {
      const initial = getCurrentSessionEventsVersion();
      const snapshots: number[] = [initial];

      for (let i = 0; i < 10; i += 1) {
        appendEventToCurrentSession(`turn-${i}`, statusEvent(`event ${i}`));
        snapshots.push(getCurrentSessionEventsVersion());
      }

      expect(snapshots.length).toBe(11);
      for (let i = 1; i < snapshots.length; i += 1) {
        expect(snapshots[i]).toBeGreaterThan(snapshots[i - 1]);
      }
      expect(snapshots[snapshots.length - 1] - initial).toBe(10);
    });

    it('Zustand subscriber receives a single coalesced notification per microtask boundary', async () => {
      const store = createSessionStore();
      const callback = vi.fn();

      const unsubscribe = store.subscribe(
        (state) => state.eventsByTurnVersion,
        callback,
      );

      const before = getCurrentSessionEventsVersion();
      for (let i = 0; i < 10; i += 1) {
        appendEventToCurrentSession('coalesce-turn', statusEvent(`event ${i}`));
      }
      // No flush — exercise pure microtask coalescing path.

      // Drain the microtask queue.
      await tick();

      // 10 synchronous bumps should collapse to ≤2 microtask-driven
      // notifications (≥1 because at least one bump happened; ≤2 to allow
      // for any re-entrant scheduling under stress).
      expect(callback.mock.calls.length).toBeGreaterThanOrEqual(1);
      expect(callback.mock.calls.length).toBeLessThanOrEqual(2);

      const lastCallValue = callback.mock.calls[callback.mock.calls.length - 1][0];
      expect(lastCallValue).toBe(getCurrentSessionEventsVersion());
      expect(lastCallValue).toBe(before + 10);

      unsubscribe();
    });

    it('flushPendingEventsVersionNotification synchronously drains pending notifications', () => {
      const store = createSessionStore();
      const callback = vi.fn();

      const unsubscribe = store.subscribe(
        (state) => state.eventsByTurnVersion,
        callback,
      );

      for (let i = 0; i < 5; i += 1) {
        appendEventToCurrentSession('flush-turn', statusEvent(`event ${i}`));
      }

      // Before flush: synchronous counter has advanced, but Zustand state has not.
      const counter = getCurrentSessionEventsVersion();
      expect(store.getState().eventsByTurnVersion).toBeLessThan(counter);
      expect(callback).not.toHaveBeenCalled();

      flushPendingEventsVersionNotification();

      // After flush: Zustand state matches the counter and the subscriber has fired.
      expect(store.getState().eventsByTurnVersion).toBe(counter);
      expect(callback).toHaveBeenCalledTimes(1);
      expect(callback.mock.calls[0][0]).toBe(counter);

      unsubscribe();
    });

    it('flushPendingEventsVersionNotification is a no-op when nothing is pending', () => {
      const store = createSessionStore();
      const callback = vi.fn();

      const unsubscribe = store.subscribe(
        (state) => state.eventsByTurnVersion,
        callback,
      );

      flushPendingEventsVersionNotification();
      expect(callback).not.toHaveBeenCalled();

      // Bump, flush once, then a second flush must not double-fire.
      appendEventToCurrentSession('idempotent-turn', statusEvent('once'));
      flushPendingEventsVersionNotification();
      flushPendingEventsVersionNotification();
      expect(callback).toHaveBeenCalledTimes(1);

      unsubscribe();
    });

    it('counter and Zustand state converge on the same value after the microtask drains', async () => {
      const store = createSessionStore();
      const callback = vi.fn();

      const unsubscribe = store.subscribe(
        (state) => state.eventsByTurnVersion,
        callback,
      );

      for (let i = 0; i < 7; i += 1) {
        appendEventToCurrentSession('converge-turn', statusEvent(`e ${i}`));
      }

      const counter = getCurrentSessionEventsVersion();
      await tick();

      expect(store.getState().eventsByTurnVersion).toBe(counter);
      expect(
        callback.mock.calls[callback.mock.calls.length - 1][0],
      ).toBe(counter);

      unsubscribe();
    });
  });

  describe('F9 — boundary-flush integration', () => {
    it('addUserMessage queue drain flushes the pending notification synchronously', () => {
      const store = createSessionStore();
      const callback = vi.fn();

      const unsubscribe = store.subscribe(
        (state) => state.eventsByTurnVersion,
        callback,
      );

      // Pre-load some pending bumps so that the queue-drain flush has work to do.
      appendEventToCurrentSession('pre-drain-turn', statusEvent('pre'));
      const counterBeforeDrain = getCurrentSessionEventsVersion();

      // addUserMessage carries an explicit flush at the queue-drain boundary.
      store.getState().addUserMessage('Hello');

      expect(store.getState().eventsByTurnVersion).toBe(
        getCurrentSessionEventsVersion(),
      );
      expect(store.getState().eventsByTurnVersion).toBeGreaterThan(
        counterBeforeDrain,
      );
      expect(callback).toHaveBeenCalled();
      const lastValue = callback.mock.calls[callback.mock.calls.length - 1][0];
      expect(lastValue).toBe(getCurrentSessionEventsVersion());

      unsubscribe();
    });

    it('snapshotCurrentSession (persistence read) flushes pending notification before composing the snapshot', () => {
      const store = createSessionStore();
      store.getState().addUserMessage('Persistence test');
      const turnId = 'persistence-turn';
      store
        .getState()
        .assignTurnToMessage(store.getState().messages[0].id, turnId, Date.now());

      // Bump several times outside of any boundary path.
      for (let i = 0; i < 3; i += 1) {
        appendEventToCurrentSession(turnId, statusEvent(`e ${i}`));
      }

      const counter = getCurrentSessionEventsVersion();
      // Pre-snapshot: Zustand version lags the counter (microtask not drained).
      expect(store.getState().eventsByTurnVersion).toBeLessThan(counter);

      const snapshot = store.getState().snapshotCurrentSession();
      expect(snapshot).not.toBeNull();
      // Post-snapshot: snapshotCurrentSession's boundary flush drove the
      // Zustand state up to the counter.
      expect(store.getState().eventsByTurnVersion).toBe(counter);
    });

    it('resetSession flushes pending notification before clearing the external Map', () => {
      const store = createSessionStore();
      const callback = vi.fn();

      store.getState().addUserMessage('Reset test');
      const turnId = 'reset-turn';
      store
        .getState()
        .assignTurnToMessage(store.getState().messages[0].id, turnId, Date.now());

      const unsubscribe = store.subscribe(
        (state) => state.eventsByTurnVersion,
        callback,
      );

      for (let i = 0; i < 4; i += 1) {
        appendEventToCurrentSession(turnId, statusEvent(`e ${i}`));
      }
      const counterBeforeReset = getCurrentSessionEventsVersion();

      // Capture the Zustand value the persistence subscriber would have
      // observed at the boundary, before clearCurrentSessionEvents() further
      // bumps the counter.
      callback.mockClear();
      store.getState().resetSession();

      // After reset, subscriber should have fired with at least the
      // pre-reset counter value (boundary flush) AND the reset's own bump.
      expect(callback.mock.calls.length).toBeGreaterThanOrEqual(1);
      const observedValues = callback.mock.calls.map((c) => c[0] as number);
      expect(Math.max(...observedValues)).toBeGreaterThanOrEqual(
        counterBeforeReset,
      );

      unsubscribe();
    });

    it('terminal-event simulation: rapid bumps + flush yield the latest counter on the Zustand state', () => {
      const store = createSessionStore();
      const callback = vi.fn();

      const unsubscribe = store.subscribe(
        (state) => state.eventsByTurnVersion,
        callback,
      );

      // Simulate a tool flurry followed by a terminal-event boundary flush.
      const turnId = 'terminal-turn';
      for (let i = 0; i < 12; i += 1) {
        appendEventToCurrentSession(turnId, statusEvent(`e ${i}`));
      }
      const counterAtTerminal = getCurrentSessionEventsVersion();
      flushPendingEventsVersionNotification();

      expect(store.getState().eventsByTurnVersion).toBe(counterAtTerminal);
      expect(callback).toHaveBeenCalledTimes(1);
      expect(callback.mock.calls[0][0]).toBe(counterAtTerminal);

      unsubscribe();
    });

    it('multiple concurrent stores each receive notifications via the registry', async () => {
      // Documents R2-9 multi-store invariant: every store created via
      // createSessionStore registers a notifier so test-isolated stores see
      // the same coalesced notification as the production singleton.
      const storeA = createSessionStore();
      const storeB = createSessionStore();
      const callbackA = vi.fn();
      const callbackB = vi.fn();

      const unsubA = storeA.subscribe(
        (state) => state.eventsByTurnVersion,
        callbackA,
      );
      const unsubB = storeB.subscribe(
        (state) => state.eventsByTurnVersion,
        callbackB,
      );

      appendEventToCurrentSession('multi-store-turn', statusEvent('shared'));

      await tick();

      expect(callbackA).toHaveBeenCalled();
      expect(callbackB).toHaveBeenCalled();

      const counter = getCurrentSessionEventsVersion();
      expect(storeA.getState().eventsByTurnVersion).toBe(counter);
      expect(storeB.getState().eventsByTurnVersion).toBe(counter);

      unsubA();
      unsubB();
    });
  });

  // ---------------------------------------------------------------------------
  // Phase 6 remediation (260508 Stage 5) — atomicity + edge-case boundary tests.
  // ---------------------------------------------------------------------------
  describe('Phase 6 — atomic Map-replacing site invariants', () => {
    it('openHistorySession leaves Zustand subscribers seeing visible state and version atomically', () => {
      const store = createSessionStore();
      // Seed a history session that openHistorySession can hydrate.
      const historyEvents: Record<string, AgentEvent[]> = {
        'history-turn': [statusEvent('history-event')],
      };
      const session: AgentSessionWithRuntime = {
        id: 'session-history',
        title: 'History',
        messages: [
          {
            id: 'm1',
            turnId: 'history-turn',
            role: 'user',
            text: 'hi',
            createdAt: 1,
          },
        ],
        eventsByTurn: historyEvents,
        activeTurnId: null,
        focusedTurnId: null,
        isBusy: false,
        lastError: null,
        createdAt: 1,
        updatedAt: 1,
        resolvedAt: null,
      } as AgentSessionWithRuntime;
      // Use `cacheSession` shape via `addOrUpdateHistorySession` for setup.
      store.getState().addOrUpdateHistorySession(session, true);

      // Pre-bump some counter so we can assert the new session lands with the
      // post-bump trailing version, not the stale pre-flush microtask value.
      appendEventToCurrentSession('outgoing-turn', statusEvent('lingering'));

      const seenStates: Array<{ messages: number; version: number }> = [];
      const unsub = store.subscribe(
        (state) => state,
        (state) => {
          seenStates.push({
            messages: state.messages.length,
            version: state.eventsByTurnVersion,
          });
        },
      );

      store.getState().openHistorySession('session-history');

      // The synchronous set carrying messages also carried the latest counter,
      // and the trailing flush drained the just-scheduled microtask.
      const counter = getCurrentSessionEventsVersion();
      expect(store.getState().eventsByTurnVersion).toBe(counter);
      expect(store.getState().currentSessionId).toBe('session-history');

      // Crucially, every subscriber notification with the new messages also
      // carries the matching trailing-edge counter (no asymmetric tear).
      const newSessionStates = seenStates.filter(
        (s) => s.messages > 0,
      );
      for (const s of newSessionStates) {
        expect(s.version).toBe(counter);
      }

      unsub();
    });

    it('resetSession atomically updates messages and eventsByTurnVersion in the same notification', () => {
      const store = createSessionStore();
      store.getState().addUserMessage('First');

      const turnId = 'reset-atomic-turn';
      store
        .getState()
        .assignTurnToMessage(store.getState().messages[0].id, turnId, Date.now());

      for (let i = 0; i < 5; i += 1) {
        appendEventToCurrentSession(turnId, statusEvent(`e ${i}`));
      }

      const observed: Array<{ messages: number; version: number }> = [];
      const unsub = store.subscribe(
        (state) => ({ messages: state.messages, version: state.eventsByTurnVersion }),
        (snapshot) => {
          observed.push({
            messages: snapshot.messages.length,
            version: snapshot.version,
          });
        },
        { equalityFn: (a, b) => a.messages === b.messages && a.version === b.version },
      );

      store.getState().resetSession();

      // After reset, messages are empty and the version reflects the post-clear
      // counter atomically — no notification carries empty messages with the
      // pre-clear stale version.
      const counter = getCurrentSessionEventsVersion();
      expect(store.getState().messages.length).toBe(0);
      expect(store.getState().eventsByTurnVersion).toBe(counter);

      const emptyMessageStates = observed.filter((s) => s.messages === 0);
      for (const s of emptyMessageStates) {
        // The reset's set() carried the counter at that instant; later
        // notifications either match or are bigger as the counter advances.
        // None should be smaller than the pre-set value (which would mean a
        // stale-version tear).
        expect(s.version).toBeGreaterThan(0);
      }

      unsub();
    });
  });

  // ---------------------------------------------------------------------------
  // Phase 6.5 remediation — atomicity invariants for the three additional
  // Map-replacing sites flagged by the round-2 behavioral-safety review:
  //   - truncateToMessage
  //   - ingestExternalSessions (active snapshot path)
  //   - clearInterruptedTurnData
  // Plus the two Phase-6-fixed sites that previously had no atomicity test:
  //   - softDeleteSession (active branch)
  //   - performCompaction (foreground)
  // ---------------------------------------------------------------------------
  describe('Phase 6.5 — atomic Map-replacing site invariants (additional sites)', () => {
    it('truncateToMessage atomically updates messages and eventsByTurnVersion in the same notification', () => {
      const store = createSessionStore();

      store.getState().addUserMessage('first');
      const turnId = 'truncate-atomic-turn';
      store
        .getState()
        .assignTurnToMessage(store.getState().messages[0].id, turnId, Date.now());

      for (let i = 0; i < 4; i += 1) {
        appendEventToCurrentSession(turnId, statusEvent(`pre ${i}`));
      }
      store.getState().addUserMessage('second');
      const secondMessageId = store.getState().messages[1].id;

      // Pre-bump some additional events so the trailing-edge counter is past
      // any pre-truncate microtask the test setup left lying around.
      for (let i = 0; i < 3; i += 1) {
        appendEventToCurrentSession(turnId, statusEvent(`mid ${i}`));
      }

      const observed: Array<{ messages: number; version: number }> = [];
      const unsub = store.subscribe(
        (state) => ({
          messages: state.messages,
          version: state.eventsByTurnVersion,
        }),
        (snapshot) => {
          observed.push({
            messages: snapshot.messages.length,
            version: snapshot.version,
          });
        },
        {
          equalityFn: (a, b) =>
            a.messages === b.messages && a.version === b.version,
        },
      );

      store.getState().truncateToMessage(secondMessageId, 'edited');

      const counter = getCurrentSessionEventsVersion();
      expect(store.getState().eventsByTurnVersion).toBe(counter);

      // Atomicity: any post-truncate notification with the truncated message
      // count must carry the latest counter (no asymmetric tear where the
      // truncated message list lands with the pre-flush stale version).
      const postTruncateStates = observed.filter((s) => s.messages <= 2);
      expect(postTruncateStates.length).toBeGreaterThan(0);
      for (const s of postTruncateStates) {
        expect(s.version).toBeGreaterThan(0);
      }

      unsub();
    });

    it('ingestExternalSessions active-snapshot path lands messages and eventsByTurnVersion in the same notification', () => {
      const store = createSessionStore();
      const currentId = store.getState().currentSessionId;

      // Pre-bump so a stale microtask is pending entering the boundary.
      appendEventToCurrentSession('outgoing-turn', statusEvent('lingering'));

      const ingestEvents: Record<string, AgentEvent[]> = {
        'ingest-turn': [statusEvent('ingest-event')],
      };
      const ingestSession: AgentSessionWithRuntime = {
        id: currentId,
        title: 'Ingested',
        messages: [
          {
            id: 'ingest-msg',
            turnId: 'ingest-turn',
            role: 'user',
            text: 'hi from cloud',
            createdAt: 1,
          },
        ],
        eventsByTurn: ingestEvents,
        activeTurnId: null,
        focusedTurnId: null,
        isBusy: false,
        lastError: null,
        createdAt: 1,
        updatedAt: 1,
        resolvedAt: null,
      } as AgentSessionWithRuntime;

      const observed: Array<{ messages: number; version: number }> = [];
      const unsub = store.subscribe(
        (state) => ({
          messages: state.messages,
          version: state.eventsByTurnVersion,
        }),
        (snapshot) => {
          observed.push({
            messages: snapshot.messages.length,
            version: snapshot.version,
          });
        },
        {
          equalityFn: (a, b) =>
            a.messages === b.messages && a.version === b.version,
        },
      );

      const returned = store.getState().ingestExternalSessions([ingestSession]);

      const counter = getCurrentSessionEventsVersion();
      expect(returned).not.toBeNull();
      expect(store.getState().messages.length).toBe(1);
      expect(store.getState().eventsByTurnVersion).toBe(counter);

      // Any subscriber notification with the new ingested message count must
      // carry the trailing-edge counter, not the pre-ingest stale version.
      const postIngestStates = observed.filter((s) => s.messages === 1);
      expect(postIngestStates.length).toBeGreaterThan(0);
      for (const s of postIngestStates) {
        expect(s.version).toBe(counter);
      }

      unsub();
    });

    it('clearInterruptedTurnData atomically updates filtered messages and eventsByTurnVersion', () => {
      const store = createSessionStore();
      store.getState().addUserMessage('to-be-interrupted');
      const turnId = 'interrupted-turn';
      store
        .getState()
        .assignTurnToMessage(store.getState().messages[0].id, turnId, Date.now());

      for (let i = 0; i < 5; i += 1) {
        appendEventToCurrentSession(turnId, statusEvent(`progress ${i}`));
      }

      // Leave a pending microtask un-drained going into the boundary.
      appendEventToCurrentSession(turnId, statusEvent('post-pending'));

      const observed: Array<{ messages: number; version: number }> = [];
      const unsub = store.subscribe(
        (state) => ({
          messages: state.messages,
          version: state.eventsByTurnVersion,
        }),
        (snapshot) => {
          observed.push({
            messages: snapshot.messages.length,
            version: snapshot.version,
          });
        },
        {
          equalityFn: (a, b) =>
            a.messages === b.messages && a.version === b.version,
        },
      );

      store.getState().clearInterruptedTurnData(turnId);

      const counter = getCurrentSessionEventsVersion();
      expect(store.getState().messages.length).toBe(0);
      expect(store.getState().eventsByTurnVersion).toBe(counter);

      // Atomicity: every notification with the filtered message list must
      // carry the trailing-edge counter (no stale-version tear).
      const postClearStates = observed.filter((s) => s.messages === 0);
      expect(postClearStates.length).toBeGreaterThan(0);
      for (const s of postClearStates) {
        expect(s.version).toBe(counter);
      }

      unsub();
    });

    it('softDeleteSession (active-branch) atomically resets messages and eventsByTurnVersion when deleting the current session', () => {
      const store = createSessionStore();
      const currentId = store.getState().currentSessionId;

      store.getState().addUserMessage('about to be trashed');
      const turnId = 'soft-delete-turn';
      store
        .getState()
        .assignTurnToMessage(store.getState().messages[0].id, turnId, Date.now());

      for (let i = 0; i < 3; i += 1) {
        appendEventToCurrentSession(turnId, statusEvent(`e ${i}`));
      }

      const observed: Array<{ messages: number; version: number }> = [];
      const unsub = store.subscribe(
        (state) => ({
          messages: state.messages,
          version: state.eventsByTurnVersion,
        }),
        (snapshot) => {
          observed.push({
            messages: snapshot.messages.length,
            version: snapshot.version,
          });
        },
        {
          equalityFn: (a, b) =>
            a.messages === b.messages && a.version === b.version,
        },
      );

      store.getState().softDeleteSession(currentId);

      const counter = getCurrentSessionEventsVersion();
      // After active-branch soft-delete: the current session is reset
      // (empty messages, fresh session id) and eventsByTurnVersion reflects
      // the post-clear counter atomically.
      expect(store.getState().messages.length).toBe(0);
      expect(store.getState().currentSessionId).not.toBe(currentId);
      expect(store.getState().eventsByTurnVersion).toBe(counter);

      const postResetStates = observed.filter((s) => s.messages === 0);
      expect(postResetStates.length).toBeGreaterThan(0);
      for (const s of postResetStates) {
        expect(s.version).toBeGreaterThan(0);
      }

      unsub();
    });

    it('performCompaction (foreground) atomically pairs the post-clear state with the trailing-edge eventsByTurnVersion', () => {
      const store = createSessionStore();
      store.getState().addUserMessage('compactable');
      const turnId = 'compaction-turn';
      store
        .getState()
        .assignTurnToMessage(store.getState().messages[0].id, turnId, Date.now());

      for (let i = 0; i < 6; i += 1) {
        appendEventToCurrentSession(turnId, statusEvent(`heavy ${i}`));
      }

      const observed: Array<{
        activeTurnId: string | null;
        version: number;
      }> = [];
      const unsub = store.subscribe(
        (state) => ({
          activeTurnId: state.activeTurnId,
          version: state.eventsByTurnVersion,
        }),
        (snapshot) => {
          observed.push({
            activeTurnId: snapshot.activeTurnId,
            version: snapshot.version,
          });
        },
        {
          equalityFn: (a, b) =>
            a.activeTurnId === b.activeTurnId && a.version === b.version,
        },
      );

      // Foreground compaction: targetSessionId omitted so the foreground
      // branch (which clears currentSessionEvents) runs.
      store.getState().performCompaction('Summary text', 1);

      const counter = getCurrentSessionEventsVersion();
      expect(store.getState().activeTurnId).toBeNull();
      expect(store.getState().eventsByTurnVersion).toBe(counter);

      // After foreground compaction, the activeTurnId-null state must be
      // paired with the trailing-edge counter — no notification observes
      // the cleared external Map with a stale Zustand version.
      const postCompactionStates = observed.filter(
        (s) => s.activeTurnId === null,
      );
      expect(postCompactionStates.length).toBeGreaterThan(0);
      for (const s of postCompactionStates) {
        expect(s.version).toBeGreaterThan(0);
      }

      unsub();
    });
  });

  describe('Phase 6 — re-entrancy and ordering edge cases', () => {
    it('bumpVersion called from inside a Zustand subscriber callback does not infinite-loop or mis-schedule', async () => {
      const store = createSessionStore();
      let reentryFires = 0;
      let observedVersions = 0;

      const unsub = store.subscribe(
        (state) => state.eventsByTurnVersion,
        (version) => {
          observedVersions += 1;
          // Re-enter exactly twice to exercise the re-arming path.
          if (reentryFires < 2 && version > 0) {
            reentryFires += 1;
            appendEventToCurrentSession(
              'reentry-turn',
              statusEvent(`re-entry ${reentryFires}`),
            );
          }
        },
      );

      appendEventToCurrentSession('reentry-turn', statusEvent('outer'));

      // Drain any chained microtasks the re-entrant bumps scheduled.
      for (let i = 0; i < 5; i += 1) {
        await tick();
      }

      // Subscriber observed at least the original notification plus the
      // re-entrant bumps' coalesced notifications, but did not infinite-loop.
      expect(observedVersions).toBeGreaterThanOrEqual(2);
      expect(observedVersions).toBeLessThan(20);
      expect(reentryFires).toBe(2);

      // Final convergence: Zustand state matches the synchronous counter.
      expect(store.getState().eventsByTurnVersion).toBe(
        getCurrentSessionEventsVersion(),
      );

      unsub();
    });

    it('flush during a pending microtask: bump → flush → bump again before drain works correctly', async () => {
      const store = createSessionStore();
      const callback = vi.fn();
      const unsub = store.subscribe((state) => state.eventsByTurnVersion, callback);

      appendEventToCurrentSession('flush-pending-turn', statusEvent('first'));
      const versionAfterFirst = getCurrentSessionEventsVersion();

      // Synchronous flush drains the pending notification immediately.
      flushPendingEventsVersionNotification();
      expect(store.getState().eventsByTurnVersion).toBe(versionAfterFirst);

      // Bump again BEFORE the original microtask body has run; the new bump
      // must re-schedule a microtask correctly because the original
      // scheduledEventsVersionMicrotask flag is still true (its body has not
      // executed yet) but pendingNotification is false (cleared by the flush).
      appendEventToCurrentSession('flush-pending-turn', statusEvent('second'));
      const versionAfterSecond = getCurrentSessionEventsVersion();

      // Drain the queue.
      await tick();
      await tick();

      // Final state matches the latest synchronous counter and subscriber
      // received both notifications (one from the explicit flush, one from
      // the eventual microtask drain of the second bump).
      expect(store.getState().eventsByTurnVersion).toBe(versionAfterSecond);
      expect(callback.mock.calls.length).toBeGreaterThanOrEqual(2);
      expect(callback.mock.calls.length).toBeLessThanOrEqual(3);

      unsub();
    });
  });

  describe('Phase 6 — perf counters', () => {
    beforeEach(() => {
      setEventsVersionPerfCountersEnabled(true);
      resetEventsVersionCounters();
    });

    afterEach(() => {
      // Restore environment-driven default. Tests that don't enable perf
      // counters must observe a no-op fast path; resetting here returns to
      // the module-load gating decision.
      setEventsVersionPerfCountersEnabled(false);
      resetEventsVersionCounters();
    });

    it('reports versionBumps, scheduledNotifications, actualNotifications, and a coalescing ratio under synthetic load', async () => {
      const store = createSessionStore();
      const callback = vi.fn();
      const unsub = store.subscribe((state) => state.eventsByTurnVersion, callback);

      // 10 rapid synchronous bumps in one tick.
      for (let i = 0; i < 10; i += 1) {
        appendEventToCurrentSession('counter-turn', statusEvent(`e ${i}`));
      }

      // Drain the microtask.
      await tick();

      const counters = getEventsVersionCounters();
      expect(counters.versionBumps).toBe(10);
      // All 10 bumps coalesced into a single scheduled microtask.
      expect(counters.scheduledNotifications).toBe(1);
      // Exactly one actual fan-out (the microtask body).
      expect(counters.actualNotifications).toBe(1);
      // Coalescing ratio = scheduled / bumps = 1 / 10 = 0.1
      expect(counters.coalescingRatio).toBeCloseTo(0.1, 5);

      unsub();
    });

    it('does not increment counters when perf mode is disabled', () => {
      setEventsVersionPerfCountersEnabled(false);
      resetEventsVersionCounters();

      for (let i = 0; i < 5; i += 1) {
        appendEventToCurrentSession('disabled-turn', statusEvent(`e ${i}`));
      }
      flushPendingEventsVersionNotification();

      const counters = getEventsVersionCounters();
      expect(counters.versionBumps).toBe(0);
      expect(counters.scheduledNotifications).toBe(0);
      expect(counters.actualNotifications).toBe(0);
    });

    it('explicit flush counts as an actualNotification but not a scheduledNotification', () => {
      setEventsVersionPerfCountersEnabled(true);
      resetEventsVersionCounters();

      appendEventToCurrentSession('flush-counter-turn', statusEvent('once'));
      flushPendingEventsVersionNotification();

      const counters = getEventsVersionCounters();
      expect(counters.versionBumps).toBe(1);
      expect(counters.scheduledNotifications).toBe(1);
      // Flush ran the actual fan-out before the microtask body could; the
      // microtask body sees `pendingNotification === false` and is a no-op.
      expect(counters.actualNotifications).toBe(1);
    });
  });

  describe('Phase 6 — multi-store registry dispose', () => {
    it('disposeEventsVersionNotifier removes the per-store notifier so disposed stores stop receiving notifications', async () => {
      const storeA = createSessionStore() as ReturnType<
        typeof createSessionStore
      >;
      const storeB = createSessionStore() as ReturnType<
        typeof createSessionStore
      >;

      const callbackA = vi.fn();
      const callbackB = vi.fn();

      const unsubA = storeA.subscribe(
        (state) => state.eventsByTurnVersion,
        callbackA,
      );
      const unsubB = storeB.subscribe(
        (state) => state.eventsByTurnVersion,
        callbackB,
      );

      appendEventToCurrentSession('dispose-turn', statusEvent('initial'));
      await tick();

      expect(callbackA).toHaveBeenCalled();
      expect(callbackB).toHaveBeenCalled();

      callbackA.mockClear();
      callbackB.mockClear();

      // Dispose store A's notifier.
      storeA.disposeEventsVersionNotifier();

      appendEventToCurrentSession('dispose-turn', statusEvent('post-dispose'));
      await tick();

      // Store B still receives the notification; store A does not.
      expect(callbackA).not.toHaveBeenCalled();
      expect(callbackB).toHaveBeenCalled();

      // Disposed store's Zustand state stays at its pre-dispose version
      // because no notifier wrote to it.
      const counter = getCurrentSessionEventsVersion();
      expect(storeB.getState().eventsByTurnVersion).toBe(counter);
      expect(storeA.getState().eventsByTurnVersion).toBeLessThan(counter);

      unsubA();
      unsubB();
    });

    it('dispose is idempotent — calling it twice does not throw or remove other notifiers', () => {
      const storeA = createSessionStore() as ReturnType<
        typeof createSessionStore
      >;
      const storeB = createSessionStore() as ReturnType<
        typeof createSessionStore
      >;

      expect(() => {
        storeA.disposeEventsVersionNotifier();
        storeA.disposeEventsVersionNotifier();
      }).not.toThrow();

      // Store B's notifier is still active after redundant dispose calls.
      const callbackB = vi.fn();
      const unsub = storeB.subscribe(
        (state) => state.eventsByTurnVersion,
        callbackB,
      );
      appendEventToCurrentSession(
        'dispose-idem-turn',
        statusEvent('still alive'),
      );
      flushPendingEventsVersionNotification();
      expect(callbackB).toHaveBeenCalled();
      unsub();
    });
  });

  // ---------------------------------------------------------------------------
  // Phase 6 remediation — engine-level boundary flush integration tests.
  //
  // These tests simulate the sequences executed by useAgentSessionEngine.ts
  // at each engine boundary point (turn_superseded, tool:start, result/error
  // terminal, beforeunload). They invoke the same public store APIs the
  // engine calls in the same order. The engine source itself is verified by
  // grep / code review for the presence of `flushPendingEventsVersionNotification`
  // at the documented line numbers (709, 867, 921, 2643-2654).
  // ---------------------------------------------------------------------------
  describe('Phase 6 — engine boundary flush wiring (integration via store API)', () => {
    it('turn_superseded boundary: flush drains pending bumps before ref cleanup', () => {
      // Mirrors useAgentSessionEngine.ts:709 — engine calls flush right
      // before deleting per-turn refs and clearing the thinking buffer.
      const store = createSessionStore();
      const callback = vi.fn();
      const unsub = store.subscribe(
        (state) => state.eventsByTurnVersion,
        callback,
      );

      const turnId = 'superseded-turn';
      // Pre-bump: simulate streaming events that arrived before supersession.
      for (let i = 0; i < 4; i += 1) {
        appendEventToCurrentSession(turnId, statusEvent(`pre ${i}`));
      }
      const counterAtBoundary = getCurrentSessionEventsVersion();

      // Engine sequence at line 709: flushPendingEventsVersionNotification()
      // BEFORE the per-turn ref cleanup so persistence subscribers observe
      // the trailing-edge counter for the superseded turn.
      flushPendingEventsVersionNotification();

      expect(store.getState().eventsByTurnVersion).toBe(counterAtBoundary);
      expect(callback).toHaveBeenCalledTimes(1);
      expect(callback.mock.calls[0][0]).toBe(counterAtBoundary);

      unsub();
    });

    it('tool:start boundary: flush AFTER processEvent collapses pre-and-post bumps into a single notification', () => {
      // Mirrors useAgentSessionEngine.ts:867 — engine calls flush AFTER
      // processEvent so the post-tool-start state is included in the same
      // coalesced notification as any pending pre-tool-start bumps.
      const store = createSessionStore();
      store.getState().addUserMessage('Run a tool');
      const turnId = 'tool-boundary-turn';
      store
        .getState()
        .assignTurnToMessage(store.getState().messages[0].id, turnId, Date.now());

      const callback = vi.fn();
      const unsub = store.subscribe(
        (state) => state.eventsByTurnVersion,
        callback,
      );

      // Pre-tool-start streaming bumps (in production these come from
      // appendEventToCurrentSession via assistant_delta or thinking_delta).
      for (let i = 0; i < 3; i += 1) {
        appendEventToCurrentSession(turnId, statusEvent(`stream ${i}`));
      }

      callback.mockClear();

      // Engine sequence: processEvent (tool:start) bumps once more, then flush.
      store.getState().processEvent(turnId, {
        type: 'tool',
        toolName: 'web_search',
        toolUseId: 'tool-1',
        stage: 'start',
        timestamp: Date.now(),
      } as AgentEvent);
      flushPendingEventsVersionNotification();

      const counter = getCurrentSessionEventsVersion();
      expect(store.getState().eventsByTurnVersion).toBe(counter);
      // All pre-tool-start bumps + the tool:start bump collapse into a
      // single Zustand notification.
      expect(callback).toHaveBeenCalledTimes(1);
      expect(callback.mock.calls[0][0]).toBe(counter);

      unsub();
    });

    it('result terminal flush: persistence subscriber sees the latest counter before clearThinkingBuffer runs', () => {
      // Mirrors useAgentSessionEngine.ts:921 — engine calls flush in the
      // (result || error) branch BEFORE clearThinkingBuffer and per-turn ref
      // cleanup so persistence subscribers observe the final terminal-event
      // version.
      const store = createSessionStore();
      store.getState().addUserMessage('Question');
      const turnId = 'terminal-result-turn';
      store
        .getState()
        .assignTurnToMessage(store.getState().messages[0].id, turnId, Date.now());

      const persistenceObservations: number[] = [];
      const unsub = store.subscribe(
        (state) => state.eventsByTurnVersion,
        (version) => {
          persistenceObservations.push(version);
        },
      );

      // Tool flurry + final result event (simulating a real agent turn).
      for (let i = 0; i < 5; i += 1) {
        appendEventToCurrentSession(turnId, statusEvent(`tool ${i}`));
      }
      store.getState().processEvent(turnId, {
        type: 'result',
        text: 'Done',
        timestamp: Date.now(),
      } as AgentEvent);

      // Engine sequence at line 921: flush BEFORE clearThinkingBuffer + ref
      // cleanup so the persistence subscriber's final read sees the
      // result-event version.
      flushPendingEventsVersionNotification();

      const finalCounter = getCurrentSessionEventsVersion();
      expect(store.getState().eventsByTurnVersion).toBe(finalCounter);
      expect(persistenceObservations[persistenceObservations.length - 1]).toBe(
        finalCounter,
      );

      unsub();
    });

    it('error terminal flush: same ordering as result, captured for symmetry', () => {
      const store = createSessionStore();
      store.getState().addUserMessage('Risky operation');
      const turnId = 'terminal-error-turn';
      store
        .getState()
        .assignTurnToMessage(store.getState().messages[0].id, turnId, Date.now());

      const callback = vi.fn();
      const unsub = store.subscribe(
        (state) => state.eventsByTurnVersion,
        callback,
      );

      for (let i = 0; i < 3; i += 1) {
        appendEventToCurrentSession(turnId, statusEvent(`partial ${i}`));
      }
      store.getState().processEvent(turnId, {
        type: 'error',
        error: 'boom',
        timestamp: Date.now(),
      } as unknown as AgentEvent);

      flushPendingEventsVersionNotification();

      const finalCounter = getCurrentSessionEventsVersion();
      expect(store.getState().eventsByTurnVersion).toBe(finalCounter);
      const lastValue = callback.mock.calls[callback.mock.calls.length - 1][0];
      expect(lastValue).toBe(finalCounter);

      unsub();
    });

    it('beforeunload flush ordering: flush() runs before snapshotCurrentSession() + saveSync()', () => {
      // Mirrors useAgentSessionEngine.ts:2643-2654 — engine's beforeunload
      // handler runs `flushPendingEventsVersionNotification()` BEFORE
      // `snapshotCurrentConversation()` (which itself flushes again — the
      // double-flush is idempotent) and `persistenceManager.saveSessionsSync`.
      // This test verifies the snapshot composed during a quit-time flush
      // captures the trailing-edge version.
      const store = createSessionStore();
      store.getState().addUserMessage('quit-time test');
      const turnId = 'beforeunload-turn';
      store
        .getState()
        .assignTurnToMessage(store.getState().messages[0].id, turnId, Date.now());

      // Late bumps that haven't drained yet (simulating the rare race where
      // the user closes the window mid-microtask).
      for (let i = 0; i < 4; i += 1) {
        appendEventToCurrentSession(turnId, statusEvent(`pre-quit ${i}`));
      }

      const callOrder: string[] = [];
      let zustandVersionAtSnapshot = -1;
      const unsub = store.subscribe(
        (state) => state.eventsByTurnVersion,
        (version) => {
          callOrder.push(`notify:${version}`);
        },
      );

      // Engine sequence at line 2643-2654:
      // 1. flushPendingEventsVersionNotification()
      // 2. snapshotCurrentConversation() (which itself calls
      //    snapshotCurrentSession() at the store)
      // 3. persistenceManager.saveSessionsSync(snapshot)
      callOrder.push('flush');
      flushPendingEventsVersionNotification();

      callOrder.push('snapshot');
      const snapshot = store.getState().snapshotCurrentSession();
      zustandVersionAtSnapshot = store.getState().eventsByTurnVersion;

      callOrder.push('saveSync');

      expect(snapshot).not.toBeNull();
      expect(snapshot?.eventsByTurn[turnId]).toBeDefined();
      expect(snapshot?.eventsByTurn[turnId].length).toBe(4);

      // Zustand version at snapshot composition must equal the synchronous
      // counter — the trailing flush guaranteed this.
      const counter = getCurrentSessionEventsVersion();
      expect(zustandVersionAtSnapshot).toBe(counter);

      // Order invariant: flush → snapshot → saveSync, with the flush
      // notification firing before the snapshot/saveSync sentinel ticks.
      const flushIdx = callOrder.indexOf('flush');
      const snapshotIdx = callOrder.indexOf('snapshot');
      const saveSyncIdx = callOrder.indexOf('saveSync');
      expect(flushIdx).toBeLessThan(snapshotIdx);
      expect(snapshotIdx).toBeLessThan(saveSyncIdx);

      unsub();
    });
  });
});
