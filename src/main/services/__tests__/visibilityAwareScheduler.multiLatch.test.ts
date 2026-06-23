/**
 * Stage 6 Phase 6 (260508): multi-consumer latch isolation, turn-supersession
 * registry contract, resume-latency invariant, and diagnostic-snapshot
 * accessor coverage.
 *
 * These tests are the Phase 6 remediation items that the originally-shipped
 * Stage 6 tests did not cover (per the Phase 5 review panel):
 *  - 3.3 Per-consumer isolation: two latches with distinct `consumerId`s
 *    maintain independent state machines while subscribed to the same
 *    `agentTurnRegistry`.
 *  - 3.4 Turn-supersession: the registry's zero-crossing semantics provide
 *    the resume debounce called for in the plan — supersession (controller
 *    A → A+B → B) must keep the active-turn count > 0 throughout, so the
 *    latch's turn-idle listener fires zero times during the supersession
 *    window.
 *  - 4.4 Resume-latency invariant: after `clearActiveTurnController` for the
 *    last turn, the latch transitions to `armed` and any pending waiters
 *    resolve synchronously after the registry notification (well within the
 *    plan's ≤500ms wall-clock metric).
 *  - 4.2 Diagnostic surface: `getBackgroundConsumerSnapshot()` returns a
 *    defensive snapshot of all live latches for incident triage.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { mockSchedulerLogger } = vi.hoisted(() => ({
  mockSchedulerLogger: {
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    trace: vi.fn(),
  },
}));

 
vi.mock('@core/logger', () => ({
  createScopedLogger: () => mockSchedulerLogger,
  createTurnSessionLogger: () => mockSchedulerLogger,
}));

 
vi.mock('@core/lazyElectron', () => ({
  getElectronModule: () => ({
    BrowserWindow: {
      getFocusedWindow: vi.fn().mockReturnValue(null),
    },
  }),
}));

 
vi.mock('@core/services/autoContinueCache', () => ({
  cleanupAutoContinueCache: vi.fn(),
}));

import { agentTurnRegistry } from '@core/services/agentTurnRegistry';
import {
  createBackgroundConsumerLatch,
  getBackgroundConsumerSnapshot,
  _resetForTesting,
  _resetBackgroundConsumerLatchesForTesting,
  _simulateWatchdogFireForTesting,
} from '../visibilityAwareScheduler';

const trackedTurnIds = new Set<string>();
let counter = 0;

function nextTurnId(): string {
  counter += 1;
  const id = `multi-latch-test-${counter}`;
  trackedTurnIds.add(id);
  return id;
}

function registerTurn(turnId: string): AbortController {
  const controller = new AbortController();
  agentTurnRegistry.setActiveTurnController(turnId, controller);
  return controller;
}

describe('Stage 6 Phase 6 — multi-latch isolation + supersession + resume latency', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    _resetForTesting();
    _resetBackgroundConsumerLatchesForTesting();
  });

  afterEach(() => {
    _resetBackgroundConsumerLatchesForTesting();
    _resetForTesting();
    for (const turnId of trackedTurnIds) {
      try { agentTurnRegistry.cleanupTurn(turnId); } catch { /* ignore */ }
    }
    trackedTurnIds.clear();
  });

  describe('per-consumer isolation (3.3)', () => {
    it('two latches with distinct consumerIds maintain independent state machines', () => {
      const indexerLatch = createBackgroundConsumerLatch('indexer', { watchdogTimeoutMs: 5_000 });
      const embedderLatch = createBackgroundConsumerLatch('embedder', { watchdogTimeoutMs: 5_000 });

      try {
        // 1. Both armed initially.
        expect(indexerLatch.getState()).toBe('armed');
        expect(embedderLatch.getState()).toBe('armed');

        // 2. Both pause on the same turn.
        const t1 = nextTurnId();
        registerTurn(t1);
        expect(indexerLatch.getState()).toBe('paused');
        expect(embedderLatch.getState()).toBe('paused');

        // 3. Indexer fires watchdog → degraded. Embedder remains paused.
        _simulateWatchdogFireForTesting(indexerLatch);
        expect(indexerLatch.getState()).toBe('degraded');
        expect(embedderLatch.getState()).toBe('paused');
        expect(indexerLatch.shouldDeferForTurnActive()).toBe(false);
        expect(embedderLatch.shouldDeferForTurnActive()).toBe(true);

        // 4. R2-7 logs are scoped per-consumer (the structured warn was
        // emitted via the indexer's scoped logger; the test mocks
        // createScopedLogger to a single shared mock — but the call site
        // for both is reachable). The key invariant is that the embedder
        // path didn't fire a degraded log (only the indexer did).
        const degradedEntryCount = mockSchedulerLogger.warn.mock.calls.filter(
          ([data, msg]) =>
            typeof msg === 'string' &&
            msg === 'Indexer/embedder degraded mode entered: active-turn signal stuck with no recent progress' &&
            data && typeof data === 'object' &&
            (data as { reason?: unknown }).reason === 'stuck_active_turn_signal',
        ).length;
        expect(degradedEntryCount).toBe(1);

        // 5. Cleanup the turn → indexer → armed-after-clear; embedder → armed.
        agentTurnRegistry.cleanupTurn(t1);
        expect(indexerLatch.getState()).toBe('armed-after-clear');
        expect(embedderLatch.getState()).toBe('armed');

        // 6. New turn engages — indexer suppresses (latch); embedder pauses.
        const t2 = nextTurnId();
        registerTurn(t2);
        expect(indexerLatch.getState()).toBe('armed');
        expect(embedderLatch.getState()).toBe('paused');
      } finally {
        indexerLatch.dispose();
        embedderLatch.dispose();
      }
    });

    it('disposing one latch does not affect the other', () => {
      const indexerLatch = createBackgroundConsumerLatch('indexer', { watchdogTimeoutMs: 5_000 });
      const embedderLatch = createBackgroundConsumerLatch('embedder', { watchdogTimeoutMs: 5_000 });

      try {
        const t1 = nextTurnId();
        registerTurn(t1);
        expect(indexerLatch.getState()).toBe('paused');
        expect(embedderLatch.getState()).toBe('paused');

        indexerLatch.dispose();

        // Embedder still paused; the registry mutation still drives its state.
        agentTurnRegistry.cleanupTurn(t1);
        expect(embedderLatch.getState()).toBe('armed');
      } finally {
        indexerLatch.dispose();
        embedderLatch.dispose();
      }
    });
  });

  describe('turn-supersession registry contract (3.4)', () => {
    it('supersession (A → A+B → B) keeps the active-turn count > 0 so the latch listener fires zero times', () => {
      // Subscribe a probe to the registry's turn-idle-state-change emitter
      // BEFORE any turn registration. This is the same wire the latch hangs
      // off of; if it fires zero times during supersession, we've proven the
      // no-debounce-needed invariant.
      let listenerFireCount = 0;
      const unsubscribe = agentTurnRegistry.subscribeTurnIdleStateChange(() => {
        listenerFireCount += 1;
      });

      try {
        // Phase 1: idle. Listener should not have fired yet.
        expect(listenerFireCount).toBe(0);

        // Phase 2: turn A starts → 0 → 1 transition. Listener fires once.
        const tA = nextTurnId();
        registerTurn(tA);
        expect(listenerFireCount).toBe(1);
        expect(agentTurnRegistry.hasAnyActiveTurn()).toBe(true);

        // Phase 3: supersession window. Turn B starts before A is cancelled.
        // Active count is 1 → 2 (no zero-crossing). Listener does NOT fire.
        const tB = nextTurnId();
        registerTurn(tB);
        expect(listenerFireCount).toBe(1);
        expect(agentTurnRegistry.hasAnyActiveTurn()).toBe(true);

        // Phase 4: A is cancelled. Active count is 2 → 1 (no zero-crossing).
        // Listener does NOT fire.
        agentTurnRegistry.cleanupTurn(tA);
        expect(listenerFireCount).toBe(1);
        expect(agentTurnRegistry.hasAnyActiveTurn()).toBe(true);

        // Phase 5: B finishes. Active count is 1 → 0. Listener fires once.
        agentTurnRegistry.cleanupTurn(tB);
        expect(listenerFireCount).toBe(2);
        expect(agentTurnRegistry.hasAnyActiveTurn()).toBe(false);
      } finally {
        unsubscribe();
      }
    });

    it('latch stays paused throughout supersession (no transient resume)', () => {
      const latch = createBackgroundConsumerLatch('test', { watchdogTimeoutMs: 5_000 });
      try {
        const tA = nextTurnId();
        registerTurn(tA);
        expect(latch.getState()).toBe('paused');

        const tB = nextTurnId();
        registerTurn(tB);
        expect(latch.getState()).toBe('paused');

        agentTurnRegistry.cleanupTurn(tA);
        expect(latch.getState()).toBe('paused');

        agentTurnRegistry.cleanupTurn(tB);
        expect(latch.getState()).toBe('armed');
      } finally {
        latch.dispose();
      }
    });
  });

  describe('resume-latency invariant (4.4)', () => {
    it('pending waiters resolve synchronously after registry notification (well under 500ms)', async () => {
      const latch = createBackgroundConsumerLatch('test', { watchdogTimeoutMs: 30_000 });
      try {
        const t1 = nextTurnId();
        registerTurn(t1);
        expect(latch.getState()).toBe('paused');

        let resolvedAt: number | null = null;
        const startedAt = Date.now();
        const waitPromise = latch.waitUntilResumeOrDegraded().then((result) => {
          resolvedAt = Date.now();
          return result;
        });

        // Drop the only active turn — the registry's notify path runs the
        // listener synchronously inside `cleanupTurn`, which transitions the
        // latch and fires the waiter. Awaiting one microtask is enough.
        agentTurnRegistry.cleanupTurn(t1);

        await expect(waitPromise).resolves.toEqual({ outcome: 'resumed' });
        expect(latch.getState()).toBe('armed');
        expect(resolvedAt).not.toBeNull();
        // The plan's success metric is ≤500ms wall-clock; in test-time terms
        // we assert "synchronously after the notification" which here means
        // a single microtask-flush boundary.
        expect((resolvedAt as unknown as number) - startedAt).toBeLessThan(500);
      } finally {
        latch.dispose();
      }
    });
  });

  describe('diagnostic snapshot accessor (4.2)', () => {
    it('reports per-consumer state, paused-since timestamp, and degraded flag', () => {
      const indexerLatch = createBackgroundConsumerLatch('indexer', { watchdogTimeoutMs: 5_000 });
      const embedderLatch = createBackgroundConsumerLatch('embedder', { watchdogTimeoutMs: 5_000 });
      try {
        // Both armed at start.
        let snap = getBackgroundConsumerSnapshot();
        expect(snap).toHaveLength(2);
        expect(snap.every((entry) => entry.state === 'armed')).toBe(true);
        expect(snap.every((entry) => entry.pausedSinceMs === null)).toBe(true);
        expect(snap.every((entry) => entry.isDegraded === false)).toBe(true);

        // Engage a turn → both pause.
        const t1 = nextTurnId();
        registerTurn(t1);
        snap = getBackgroundConsumerSnapshot();
        expect(snap.every((entry) => entry.state === 'paused')).toBe(true);
        expect(snap.every((entry) => entry.pausedSinceMs !== null)).toBe(true);

        // Indexer hits watchdog → degraded; embedder remains paused.
        _simulateWatchdogFireForTesting(indexerLatch);
        snap = getBackgroundConsumerSnapshot();
        const indexerEntry = snap.find((entry) => entry.consumerId === 'indexer');
        const embedderEntry = snap.find((entry) => entry.consumerId === 'embedder');
        expect(indexerEntry?.state).toBe('degraded');
        expect(indexerEntry?.isDegraded).toBe(true);
        expect(embedderEntry?.state).toBe('paused');
        expect(embedderEntry?.isDegraded).toBe(false);
      } finally {
        indexerLatch.dispose();
        embedderLatch.dispose();
      }
    });

    it('returns an empty array when no latches are live', () => {
      const snap = getBackgroundConsumerSnapshot();
      expect(snap).toEqual([]);
    });

    it('snapshot mutation does not affect internal state (defensive copy)', () => {
      const latch = createBackgroundConsumerLatch('indexer', { watchdogTimeoutMs: 5_000 });
      try {
        const snap = getBackgroundConsumerSnapshot();
        snap.push({
          consumerId: 'fake',
          state: 'degraded',
          pausedSinceMs: 0,
          isDegraded: true,
        });
        expect(getBackgroundConsumerSnapshot()).toHaveLength(1);
      } finally {
        latch.dispose();
      }
    });
  });
});
