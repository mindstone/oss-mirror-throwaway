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
  isAppCurrentlyBlurred,
  _resetForTesting,
  _resetBackgroundConsumerLatchesForTesting,
  _setBlurredForTesting,
  _simulateWatchdogFireForTesting,
  type BackgroundConsumerLatch,
} from '../visibilityAwareScheduler';

const trackedTurnIds = new Set<string>();
let counter = 0;

function nextTurnId(): string {
  counter += 1;
  const id = `gate-test-${counter}`;
  trackedTurnIds.add(id);
  return id;
}

function registerTurn(turnId: string): AbortController {
  const controller = new AbortController();
  agentTurnRegistry.setActiveTurnController(turnId, controller);
  return controller;
}

/**
 * Mirror of the Stage-6 gate predicate from `fileWatcherService.startProcessing`:
 *
 *   (pauseOnBlur && isAppCurrentlyBlurred()) ||
 *   (pauseOnTurnActive && shouldDeferForTurnActive())
 *
 * Where `shouldDeferForTurnActive` is the latch's `paused`-state check (which
 * already encodes the `!isInDegradedMode()` and `!armed-after-clear` logic).
 *
 * Re-implemented here as a pure function so the test exercises the same
 * boolean composition the consumer applies.
 */
function shouldGate(
  latch: BackgroundConsumerLatch,
  options: { pauseOnBlur: boolean; pauseOnTurnActive: boolean },
): boolean {
  const blurPart = options.pauseOnBlur && isAppCurrentlyBlurred();
  const turnPart = options.pauseOnTurnActive && latch.shouldDeferForTurnActive();
  return blurPart || turnPart;
}

describe('Stage 6 gate predicate composition', () => {
  let latch: BackgroundConsumerLatch | null = null;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    _resetForTesting();
    _resetBackgroundConsumerLatchesForTesting();
  });

  afterEach(() => {
    latch?.dispose();
    latch = null;
    _resetBackgroundConsumerLatchesForTesting();
    _resetForTesting();
    for (const turnId of trackedTurnIds) {
      try { agentTurnRegistry.cleanupTurn(turnId); } catch { /* ignore */ }
    }
    trackedTurnIds.clear();
    vi.useRealTimers();
  });

  it('false when both flags off, regardless of state', () => {
    latch = createBackgroundConsumerLatch('test', { watchdogTimeoutMs: 5_000 });

    expect(shouldGate(latch, { pauseOnBlur: false, pauseOnTurnActive: false })).toBe(false);

    const t1 = nextTurnId();
    registerTurn(t1);
    _setBlurredForTesting(true);

    expect(shouldGate(latch, { pauseOnBlur: false, pauseOnTurnActive: false })).toBe(false);
  });

  it('blur-only branch: true when pauseOnBlur && blurred', () => {
    latch = createBackgroundConsumerLatch('test', { watchdogTimeoutMs: 5_000 });

    expect(shouldGate(latch, { pauseOnBlur: true, pauseOnTurnActive: false })).toBe(false);

    _setBlurredForTesting(true);
    expect(shouldGate(latch, { pauseOnBlur: true, pauseOnTurnActive: false })).toBe(true);

    _setBlurredForTesting(false);
    expect(shouldGate(latch, { pauseOnBlur: true, pauseOnTurnActive: false })).toBe(false);
  });

  it('turn-active branch: true when pauseOnTurnActive && active turn (and latch not degraded)', () => {
    latch = createBackgroundConsumerLatch('test', { watchdogTimeoutMs: 5_000 });

    expect(shouldGate(latch, { pauseOnBlur: false, pauseOnTurnActive: true })).toBe(false);

    const t1 = nextTurnId();
    registerTurn(t1);
    expect(shouldGate(latch, { pauseOnBlur: false, pauseOnTurnActive: true })).toBe(true);

    agentTurnRegistry.cleanupTurn(t1);
    expect(shouldGate(latch, { pauseOnBlur: false, pauseOnTurnActive: true })).toBe(false);
  });

  it('turn-active branch: false while in degraded mode (signal still set)', () => {
    latch = createBackgroundConsumerLatch('test', { watchdogTimeoutMs: 1_000 });

    const t1 = nextTurnId();
    registerTurn(t1);
    expect(shouldGate(latch, { pauseOnBlur: false, pauseOnTurnActive: true })).toBe(true);

    _simulateWatchdogFireForTesting(latch);
    expect(latch.getState()).toBe('degraded');
    // Signal is still active but the latch has degraded → gate must report false.
    expect(agentTurnRegistry.hasAnyActiveTurn()).toBe(true);
    expect(shouldGate(latch, { pauseOnBlur: false, pauseOnTurnActive: true })).toBe(false);
  });

  it('turn-active branch: false in armed-after-clear (latch has not re-engaged)', () => {
    latch = createBackgroundConsumerLatch('test', { watchdogTimeoutMs: 1_000 });

    const t1 = nextTurnId();
    registerTurn(t1);
    _simulateWatchdogFireForTesting(latch);
    agentTurnRegistry.cleanupTurn(t1);
    expect(latch.getState()).toBe('armed-after-clear');

    // Even if we engage another turn, the latch suppresses pause for that
    // engagement so the gate should not fire.
    const t2 = nextTurnId();
    registerTurn(t2);
    expect(latch.getState()).toBe('armed');
    expect(shouldGate(latch, { pauseOnBlur: false, pauseOnTurnActive: true })).toBe(false);
  });

  it('OR composition: blur set takes precedence even when latch is degraded', () => {
    latch = createBackgroundConsumerLatch('test', { watchdogTimeoutMs: 1_000 });

    const t1 = nextTurnId();
    registerTurn(t1);
    _simulateWatchdogFireForTesting(latch);
    expect(latch.getState()).toBe('degraded');

    expect(shouldGate(latch, { pauseOnBlur: true, pauseOnTurnActive: true })).toBe(false);

    _setBlurredForTesting(true);
    expect(shouldGate(latch, { pauseOnBlur: true, pauseOnTurnActive: true })).toBe(true);
  });

  it('full truth table (all 16 rows) for {pauseOnBlur, pauseOnTurnActive, blurred, turnActive(non-degraded)}', () => {
    latch = createBackgroundConsumerLatch('test', { watchdogTimeoutMs: 5_000 });

    type Row = {
      pauseOnBlur: boolean;
      pauseOnTurnActive: boolean;
      blurred: boolean;
      turnActive: boolean;
      expected: boolean;
    };

    const rows: Row[] = [
      // pauseOnBlur=false, pauseOnTurnActive=false → never gates
      { pauseOnBlur: false, pauseOnTurnActive: false, blurred: false, turnActive: false, expected: false },
      { pauseOnBlur: false, pauseOnTurnActive: false, blurred: true, turnActive: false, expected: false },
      { pauseOnBlur: false, pauseOnTurnActive: false, blurred: false, turnActive: true, expected: false },
      { pauseOnBlur: false, pauseOnTurnActive: false, blurred: true, turnActive: true, expected: false },
      // pauseOnBlur=true, pauseOnTurnActive=false → only blurred matters
      { pauseOnBlur: true, pauseOnTurnActive: false, blurred: false, turnActive: false, expected: false },
      { pauseOnBlur: true, pauseOnTurnActive: false, blurred: true, turnActive: false, expected: true },
      { pauseOnBlur: true, pauseOnTurnActive: false, blurred: false, turnActive: true, expected: false },
      { pauseOnBlur: true, pauseOnTurnActive: false, blurred: true, turnActive: true, expected: true },
      // pauseOnBlur=false, pauseOnTurnActive=true → only turnActive matters
      { pauseOnBlur: false, pauseOnTurnActive: true, blurred: false, turnActive: false, expected: false },
      { pauseOnBlur: false, pauseOnTurnActive: true, blurred: true, turnActive: false, expected: false },
      { pauseOnBlur: false, pauseOnTurnActive: true, blurred: false, turnActive: true, expected: true },
      { pauseOnBlur: false, pauseOnTurnActive: true, blurred: true, turnActive: true, expected: true },
      // pauseOnBlur=true, pauseOnTurnActive=true → OR composition
      { pauseOnBlur: true, pauseOnTurnActive: true, blurred: false, turnActive: false, expected: false },
      { pauseOnBlur: true, pauseOnTurnActive: true, blurred: true, turnActive: false, expected: true },
      { pauseOnBlur: true, pauseOnTurnActive: true, blurred: false, turnActive: true, expected: true },
      { pauseOnBlur: true, pauseOnTurnActive: true, blurred: true, turnActive: true, expected: true },
    ];

    for (const row of rows) {
      // Reset state.
      _setBlurredForTesting(false);
      for (const turnId of trackedTurnIds) {
        try { agentTurnRegistry.cleanupTurn(turnId); } catch { /* ignore */ }
      }

      _setBlurredForTesting(row.blurred);
      let activeTurnId: string | null = null;
      if (row.turnActive) {
        activeTurnId = nextTurnId();
        registerTurn(activeTurnId);
      }

      expect(
        shouldGate(latch!, {
          pauseOnBlur: row.pauseOnBlur,
          pauseOnTurnActive: row.pauseOnTurnActive,
        }),
        JSON.stringify(row),
      ).toBe(row.expected);

      if (activeTurnId) {
        agentTurnRegistry.cleanupTurn(activeTurnId);
      }
    }
  });
});
