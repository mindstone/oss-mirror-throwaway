/**
 * Cross-stage integration test — Phase 8 close-out (260508 plan).
 *
 * Proves the active-work CPU/GPU rebuild forms a coherent architecture: a
 * SINGLE primitive — `agentTurnRegistry.setActiveTurnController()` (Stage 1) —
 * drives all downstream consumers through the same notification path.
 *
 * Stages exercised in one synthetic turn lifecycle (main-process scope):
 *
 *   * **Stage 1 (registry)** — `setActiveTurnController` → `hasAnyActiveTurn`
 *     flips true; `subscribeTurnIdleStateChange` notifies once on the
 *     0 → 1 zero-crossing.
 *   * **Stage 2 + F16 (dispatcher)** — a real dispatch through
 *     `dispatchAgentEvent` records `eventsDispatchedTotal` and
 *     `eventsWithActiveSubscriberTotal` per event.type. R2-8 exemption
 *     lists keep `assistant_delta` / `thinking_delta` /
 *     `answer_phase_started` out of `getDeadEventTypes()`.
 *   * **Stage 6 (BackgroundConsumerLatch)** — transitions `armed → paused`
 *     synchronously on the registry zero-crossing, and `paused → armed`
 *     on `cleanupTurn`. Per-consumer isolation respected.
 *
 * Stages 3 (renderer body attribute) and 5 (renderer sessionStore boundary
 * flush) live in renderer-environment test files; covered there separately:
 *   * `src/renderer/features/flow-panels/__tests__/FlowPanelsShell.activeWork*.test.tsx`
 *   * `src/renderer/features/agent-session/store/__tests__/sessionStore.eventsVersionCoalescing.test.ts`
 *
 * Cleanup of the synthetic turn reverses all of the above in one sweep — the
 * unified-signal architecture's defining property.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { mockSchedulerLogger, mockTracker } = vi.hoisted(() => ({
  mockSchedulerLogger: {
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    trace: vi.fn(),
  },
  mockTracker: {
    track: vi.fn(),
    identify: vi.fn(),
    getAnonymousId: vi.fn(() => 'anon-test-id'),
    isAvailable: vi.fn(() => true),
  },
}));

 
vi.mock('@core/logger', () => ({
  createScopedLogger: () => mockSchedulerLogger,
  createTurnSessionLogger: () => mockSchedulerLogger,
}));

 
vi.mock('@core/tracking', () => ({
  getTracker: () => mockTracker,
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

 
vi.mock('@core/services/turnCheckpointService', () => ({
  getTurnCheckpointManager: vi.fn(() => null),
}));

import { agentTurnRegistry } from '@core/services/agentTurnRegistry';
import {
  createBackgroundConsumerLatch,
  _resetForTesting,
  _resetBackgroundConsumerLatchesForTesting,
} from '../visibilityAwareScheduler';
import {
  dispatchAgentEvent,
  getDispatcherCounters,
  resetDispatcherCounters,
  setDispatcherCountersEnabledForTests,
  getDeadEventTypes,
  KNOWN_NO_RENDERER_SUBSCRIBER,
  RENDERER_ONLY_LIFECYCLE_EVENTS,
} from '@core/services/agentEventDispatcher';
import { resetSessionSeqIndexForTests } from '@core/services/sessionSeqIndex';
import type { AgentEvent } from '@shared/types';

const trackedTurnIds = new Set<string>();
let counter = 0;

function nextTurnId(): string {
  counter += 1;
  const id = `cross-stage-integration-${counter}`;
  trackedTurnIds.add(id);
  return id;
}

function registerTurn(turnId: string): AbortController {
  const controller = new AbortController();
  agentTurnRegistry.setActiveTurnController(turnId, controller);
  return controller;
}

function createWindow() {
  const send = vi.fn();
  return {
    send,
    win: {
      id: 1,
      isDestroyed: () => false,
      webContents: {
        send,
        isDestroyed: () => false,
      },
    },
  };
}

const statusEvent: Extract<AgentEvent, { type: 'status' }> = {
  type: 'status',
  message: 'starting',
  timestamp: 1_000,
};

const assistantDeltaEvent: Extract<AgentEvent, { type: 'assistant_delta' }> = {
  type: 'assistant_delta',
  text: 'streaming chunk',
  timestamp: 2_000,
};

beforeEach(() => {
  vi.clearAllMocks();
  _resetForTesting();
  _resetBackgroundConsumerLatchesForTesting();
  resetSessionSeqIndexForTests();
  resetDispatcherCounters();
  setDispatcherCountersEnabledForTests(true);
});

afterEach(() => {
  _resetBackgroundConsumerLatchesForTesting();
  _resetForTesting();
  for (const turnId of trackedTurnIds) {
    try { agentTurnRegistry.cleanupTurn(turnId); } catch { /* ignore */ }
  }
  trackedTurnIds.clear();
  resetDispatcherCounters();
  setDispatcherCountersEnabledForTests(false);
  resetSessionSeqIndexForTests();
});

describe('Active-work cross-stage integration (Phase 8 close-out)', () => {
  it('a single agentTurnRegistry signal drives Stage 1 + Stage 6 (latch) coherently', () => {
    const indexerLatch = createBackgroundConsumerLatch('indexer-integration', { watchdogTimeoutMs: 30_000 });
    const embedderLatch = createBackgroundConsumerLatch('embedder-integration', { watchdogTimeoutMs: 30_000 });

    let listenerFireCount = 0;
    const unsubscribe = agentTurnRegistry.subscribeTurnIdleStateChange(() => {
      listenerFireCount += 1;
    });

    try {
      // Stage 1: idle baseline.
      expect(agentTurnRegistry.hasAnyActiveTurn()).toBe(false);
      expect(indexerLatch.getState()).toBe('armed');
      expect(embedderLatch.getState()).toBe('armed');
      expect(listenerFireCount).toBe(0);

      // Stage 1: synthetic active turn → registry zero-crossing 0 → 1.
      const turnId = nextTurnId();
      registerTurn(turnId);

      expect(agentTurnRegistry.hasAnyActiveTurn()).toBe(true);
      // Stage 6: BOTH latches paused on the SAME signal.
      expect(indexerLatch.getState()).toBe('paused');
      expect(embedderLatch.getState()).toBe('paused');
      // Stage 1: registry listener fired exactly once.
      expect(listenerFireCount).toBe(1);

      // Stage 1: cleanup zero-crossing 1 → 0.
      agentTurnRegistry.cleanupTurn(turnId);

      expect(agentTurnRegistry.hasAnyActiveTurn()).toBe(false);
      // Stage 6: BOTH latches armed on the SAME signal.
      expect(indexerLatch.getState()).toBe('armed');
      expect(embedderLatch.getState()).toBe('armed');
      // Stage 1: listener fired exactly twice (one zero-crossing each direction).
      expect(listenerFireCount).toBe(2);
    } finally {
      unsubscribe();
      indexerLatch.dispose();
      embedderLatch.dispose();
    }
  });

  it('Stage 2 + F16: dispatched generic event records both totals when window is alive (during active turn)', () => {
    const turnId = nextTurnId();
    const { win } = createWindow();
    registerTurn(turnId);

    dispatchAgentEvent(win, turnId, statusEvent);

    const counters = getDispatcherCounters();
    expect(counters.eventsDispatchedTotal.status).toBe(1);
    expect(counters.eventsWithActiveSubscriberTotal.status).toBe(1);
    expect(getDeadEventTypes()).not.toContain('status');
  });

  it('Stage 2 + F16 R2-8: assistant_delta during active turn does not flag dead even with no listener/subscriber', () => {
    const turnId = nextTurnId();
    const { win } = createWindow();
    registerTurn(turnId);

    dispatchAgentEvent(win, turnId, assistantDeltaEvent);

    const counters = getDispatcherCounters();
    expect(counters.eventsDispatchedTotal.assistant_delta).toBe(1);
    // assistant_delta is in KNOWN_NO_RENDERER_SUBSCRIBER — no consumer, no
    // increment, but the exemption set keeps it out of getDeadEventTypes().
    expect(counters.eventsWithActiveSubscriberTotal.assistant_delta).toBeUndefined();
    expect(getDeadEventTypes()).not.toContain('assistant_delta');

    // Sanity: contract integrity — the exemption arrays still cover what the
    // type-wall narrows on. If a future change removes either array entry, both
    // this integration test AND the unit-level F16 invariant test will fail.
    expect(KNOWN_NO_RENDERER_SUBSCRIBER).toContain('assistant_delta');
    expect(KNOWN_NO_RENDERER_SUBSCRIBER).toContain('thinking_delta');
    expect(RENDERER_ONLY_LIFECYCLE_EVENTS).toContain('answer_phase_started');
  });

  it('end-to-end: synthetic turn lifecycle reverses Stage 6 latch state AND records F16 counter consistently', () => {
    const latch = createBackgroundConsumerLatch('e2e-integration', { watchdogTimeoutMs: 30_000 });
    const turnId = nextTurnId();
    const { win } = createWindow();

    try {
      // Pre-turn: armed, no counters.
      expect(latch.getState()).toBe('armed');
      expect(getDispatcherCounters().eventsDispatchedTotal).toEqual({});

      // Begin turn: latch paused.
      registerTurn(turnId);
      expect(latch.getState()).toBe('paused');

      // Mid-turn: dispatch a generic event with the live window — F16 records
      // BOTH totals (active subscriber + dispatched).
      dispatchAgentEvent(win, turnId, statusEvent);
      let counters = getDispatcherCounters();
      expect(counters.eventsDispatchedTotal.status).toBe(1);
      expect(counters.eventsWithActiveSubscriberTotal.status).toBe(1);

      // End turn: latch armed; counters carry forward (cumulative).
      agentTurnRegistry.cleanupTurn(turnId);
      expect(latch.getState()).toBe('armed');

      counters = getDispatcherCounters();
      expect(counters.eventsDispatchedTotal.status).toBe(1);
      expect(counters.eventsWithActiveSubscriberTotal.status).toBe(1);
      expect(getDeadEventTypes()).toEqual([]);
    } finally {
      latch.dispose();
    }
  });
});
