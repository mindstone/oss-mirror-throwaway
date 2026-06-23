/**
 * Tests for 260421 Stage 4 — runtime-result error dispatch dedup registry primitive.
 *
 * Verifies the new `hasErrorResultDispatched` / `markErrorResultDispatched` /
 * `clearErrorResultDispatched` trio on `agentTurnRegistry` mirrors the existing
 * `ContextOverflow` pattern: per-turn flag, idempotent mark, explicit clear,
 * cleared by both `cleanupForRetry` and `cleanupTurn`, and strictly namespaced
 * (does NOT share storage with `ContextOverflow` or `ActionableError` flags).
 *
 * Why this matters: Stage 4's `agentMessageHandler.ts` guard keys off
 * `hasErrorResultDispatched(turnId)` to suppress duplicate runtime-result error
 * dispatch; retry paths (rate-limit fallback, billing fallback) depend on
 * `cleanupForRetry` clearing the flag so a retried turn that fails again can
 * dispatch a fresh error.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Mocks – declared before imports so vi.mock hoisting works correctly
// ---------------------------------------------------------------------------

vi.mock('@core/logger', () => {
  const mockLogger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  };
  return {
    createTurnSessionLogger: () => mockLogger,
    createScopedLogger: () => mockLogger,
  };
});

vi.mock('../autoContinueCache', () => ({
  cleanupAutoContinueCache: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Import under test (after mocks are set up)
// ---------------------------------------------------------------------------

import { agentTurnRegistry } from '../agentTurnRegistry';

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('agentTurnRegistry — runtime-result error dispatch dedup trio (260421 Stage 4)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    // The registry is a singleton — explicit teardown to prevent cross-test bleed.
    for (const turnId of ['turn-A', 'turn-B', 'turn-dedup-1', 'turn-dedup-2']) {
      agentTurnRegistry.clearErrorResultDispatched(turnId);
      agentTurnRegistry.clearContextOverflowDispatched(turnId);
      agentTurnRegistry.clearActionableErrorDispatched(turnId);
      try {
        agentTurnRegistry.cleanupTurn(turnId);
      } catch {
        /* ignore */
      }
    }
  });

  describe('basic flag semantics', () => {
    it('hasErrorResultDispatched returns false by default (flag not set)', () => {
      expect(agentTurnRegistry.hasErrorResultDispatched('turn-dedup-1')).toBe(false);
    });

    it('markErrorResultDispatched latches the flag; has returns true after', () => {
      agentTurnRegistry.markErrorResultDispatched('turn-dedup-1');
      expect(agentTurnRegistry.hasErrorResultDispatched('turn-dedup-1')).toBe(true);
    });

    it('markErrorResultDispatched is idempotent (calling twice is safe)', () => {
      agentTurnRegistry.markErrorResultDispatched('turn-dedup-1');
      agentTurnRegistry.markErrorResultDispatched('turn-dedup-1');
      expect(agentTurnRegistry.hasErrorResultDispatched('turn-dedup-1')).toBe(true);
    });

    it('clearErrorResultDispatched returns true when the flag was set, false otherwise', () => {
      expect(agentTurnRegistry.clearErrorResultDispatched('turn-dedup-1')).toBe(false);

      agentTurnRegistry.markErrorResultDispatched('turn-dedup-1');
      expect(agentTurnRegistry.clearErrorResultDispatched('turn-dedup-1')).toBe(true);

      // Second clear — already cleared, returns false
      expect(agentTurnRegistry.clearErrorResultDispatched('turn-dedup-1')).toBe(false);
    });

    it('after clearErrorResultDispatched, has returns false again', () => {
      agentTurnRegistry.markErrorResultDispatched('turn-dedup-1');
      agentTurnRegistry.clearErrorResultDispatched('turn-dedup-1');
      expect(agentTurnRegistry.hasErrorResultDispatched('turn-dedup-1')).toBe(false);
    });
  });

  describe('cleanup paths clear the flag', () => {
    it('cleanupForRetry clears the flag (so a retried turn can dispatch a fresh error)', () => {
      agentTurnRegistry.markErrorResultDispatched('turn-dedup-1');
      expect(agentTurnRegistry.hasErrorResultDispatched('turn-dedup-1')).toBe(true);

      agentTurnRegistry.cleanupForRetry('turn-dedup-1');

      expect(agentTurnRegistry.hasErrorResultDispatched('turn-dedup-1')).toBe(false);
    });

    it('cleanupTurn clears the flag (final teardown hygiene)', () => {
      agentTurnRegistry.markErrorResultDispatched('turn-dedup-1');
      expect(agentTurnRegistry.hasErrorResultDispatched('turn-dedup-1')).toBe(true);

      agentTurnRegistry.cleanupTurn('turn-dedup-1');

      expect(agentTurnRegistry.hasErrorResultDispatched('turn-dedup-1')).toBe(false);
    });

    it('preserves output-cap retry latch across cleanupForRetry and clears it on cleanupTurn', () => {
      const retryKey = 'turn-dedup-1|claude-sonnet-4-5|p1';
      agentTurnRegistry.markOutputCapRetryAttempted(retryKey);
      expect(agentTurnRegistry.hasOutputCapRetryAttempted(retryKey)).toBe(true);

      agentTurnRegistry.cleanupForRetry('turn-dedup-1');
      expect(agentTurnRegistry.hasOutputCapRetryAttempted(retryKey)).toBe(true);

      agentTurnRegistry.cleanupTurn('turn-dedup-1');
      expect(agentTurnRegistry.hasOutputCapRetryAttempted(retryKey)).toBe(false);
    });
  });

  describe('cross-turn independence', () => {
    it('tracks multiple turnIds independently', () => {
      agentTurnRegistry.markErrorResultDispatched('turn-A');

      expect(agentTurnRegistry.hasErrorResultDispatched('turn-A')).toBe(true);
      expect(agentTurnRegistry.hasErrorResultDispatched('turn-B')).toBe(false);

      agentTurnRegistry.markErrorResultDispatched('turn-B');

      expect(agentTurnRegistry.hasErrorResultDispatched('turn-A')).toBe(true);
      expect(agentTurnRegistry.hasErrorResultDispatched('turn-B')).toBe(true);

      // Clearing one does not affect the other
      agentTurnRegistry.clearErrorResultDispatched('turn-A');

      expect(agentTurnRegistry.hasErrorResultDispatched('turn-A')).toBe(false);
      expect(agentTurnRegistry.hasErrorResultDispatched('turn-B')).toBe(true);
    });
  });

  describe('namespace isolation — does NOT share storage with other per-turn flags', () => {
    it('markErrorResultDispatched does NOT latch contextOverflow or actionableError', () => {
      agentTurnRegistry.markErrorResultDispatched('turn-dedup-1');

      expect(agentTurnRegistry.hasErrorResultDispatched('turn-dedup-1')).toBe(true);
      expect(agentTurnRegistry.hasContextOverflowDispatched('turn-dedup-1')).toBe(false);
      expect(agentTurnRegistry.hasActionableErrorDispatched('turn-dedup-1')).toBe(false);
    });

    it('markContextOverflowDispatched does NOT latch errorResult', () => {
      agentTurnRegistry.markContextOverflowDispatched('turn-dedup-1');

      expect(agentTurnRegistry.hasContextOverflowDispatched('turn-dedup-1')).toBe(true);
      expect(agentTurnRegistry.hasErrorResultDispatched('turn-dedup-1')).toBe(false);
    });

    it('markActionableErrorDispatched does NOT latch errorResult', () => {
      agentTurnRegistry.markActionableErrorDispatched('turn-dedup-1');

      expect(agentTurnRegistry.hasActionableErrorDispatched('turn-dedup-1')).toBe(true);
      expect(agentTurnRegistry.hasErrorResultDispatched('turn-dedup-1')).toBe(false);
    });

    it('clearErrorResultDispatched does NOT affect other flags', () => {
      agentTurnRegistry.markErrorResultDispatched('turn-dedup-1');
      agentTurnRegistry.markContextOverflowDispatched('turn-dedup-1');
      agentTurnRegistry.markActionableErrorDispatched('turn-dedup-1');

      agentTurnRegistry.clearErrorResultDispatched('turn-dedup-1');

      expect(agentTurnRegistry.hasErrorResultDispatched('turn-dedup-1')).toBe(false);
      expect(agentTurnRegistry.hasContextOverflowDispatched('turn-dedup-1')).toBe(true);
      expect(agentTurnRegistry.hasActionableErrorDispatched('turn-dedup-1')).toBe(true);
    });
  });
});
