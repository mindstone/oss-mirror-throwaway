/**
 * Tests for the per-case Codex profile drift warning dedup primitive.
 *
 * Regression coverage for the conflated-Set bug surfaced by Phase 7 review:
 * the legacy single Set<turnId> dedup would silently suppress whichever of
 * Case A / Case B arrived second across retries within the same turn, even
 * though the two cases describe distinct failure modes and operators need
 * both signals.
 *
 * Case A — `auth: 'codex-subscription'` rescued despite `workingProfileId === null`
 * Case B — Codex active+connected, route resolved to non-subscription auth
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@core/logger', () => {
  const mockLogger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
  return { createTurnSessionLogger: () => mockLogger, createScopedLogger: () => mockLogger };
});

vi.mock('../autoContinueCache', () => ({ cleanupAutoContinueCache: vi.fn() }));

import { agentTurnRegistry } from '../agentTurnRegistry';

describe('agentTurnRegistry — Codex profile drift warning per-case dedup', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    for (const turnId of ['turn-A', 'turn-B', 'turn-drift-1', 'turn-drift-2']) {
      try {
        agentTurnRegistry.cleanupTurn(turnId);
      } catch {
        /* ignore */
      }
    }
  });

  it('returns false for both cases by default', () => {
    expect(agentTurnRegistry.hasCodexProfileDriftWarningEmitted('turn-drift-1', 'caseA')).toBe(false);
    expect(agentTurnRegistry.hasCodexProfileDriftWarningEmitted('turn-drift-1', 'caseB')).toBe(false);
  });

  it('marks Case A independently of Case B', () => {
    agentTurnRegistry.markCodexProfileDriftWarningEmitted('turn-drift-1', 'caseA');

    expect(agentTurnRegistry.hasCodexProfileDriftWarningEmitted('turn-drift-1', 'caseA')).toBe(true);
    // Critical: Case A must NOT latch Case B (the regression).
    expect(agentTurnRegistry.hasCodexProfileDriftWarningEmitted('turn-drift-1', 'caseB')).toBe(false);
  });

  it('marks Case B independently of Case A', () => {
    agentTurnRegistry.markCodexProfileDriftWarningEmitted('turn-drift-1', 'caseB');

    expect(agentTurnRegistry.hasCodexProfileDriftWarningEmitted('turn-drift-1', 'caseB')).toBe(true);
    expect(agentTurnRegistry.hasCodexProfileDriftWarningEmitted('turn-drift-1', 'caseA')).toBe(false);
  });

  it('allows both cases to be marked on the same turn (both warnings fire)', () => {
    agentTurnRegistry.markCodexProfileDriftWarningEmitted('turn-drift-1', 'caseA');
    agentTurnRegistry.markCodexProfileDriftWarningEmitted('turn-drift-1', 'caseB');

    expect(agentTurnRegistry.hasCodexProfileDriftWarningEmitted('turn-drift-1', 'caseA')).toBe(true);
    expect(agentTurnRegistry.hasCodexProfileDriftWarningEmitted('turn-drift-1', 'caseB')).toBe(true);
  });

  it('mark is idempotent within a single case', () => {
    agentTurnRegistry.markCodexProfileDriftWarningEmitted('turn-drift-1', 'caseA');
    agentTurnRegistry.markCodexProfileDriftWarningEmitted('turn-drift-1', 'caseA');

    expect(agentTurnRegistry.hasCodexProfileDriftWarningEmitted('turn-drift-1', 'caseA')).toBe(true);
  });

  it('cleanupForRetry preserves both cases (one logical turn = at most one warning per case)', () => {
    agentTurnRegistry.markCodexProfileDriftWarningEmitted('turn-drift-1', 'caseA');
    agentTurnRegistry.markCodexProfileDriftWarningEmitted('turn-drift-1', 'caseB');

    agentTurnRegistry.cleanupForRetry('turn-drift-1');

    expect(agentTurnRegistry.hasCodexProfileDriftWarningEmitted('turn-drift-1', 'caseA')).toBe(true);
    expect(agentTurnRegistry.hasCodexProfileDriftWarningEmitted('turn-drift-1', 'caseB')).toBe(true);
  });

  it('cleanupTurn clears both cases (terminal cleanup)', () => {
    agentTurnRegistry.markCodexProfileDriftWarningEmitted('turn-drift-1', 'caseA');
    agentTurnRegistry.markCodexProfileDriftWarningEmitted('turn-drift-1', 'caseB');

    agentTurnRegistry.cleanupTurn('turn-drift-1');

    expect(agentTurnRegistry.hasCodexProfileDriftWarningEmitted('turn-drift-1', 'caseA')).toBe(false);
    expect(agentTurnRegistry.hasCodexProfileDriftWarningEmitted('turn-drift-1', 'caseB')).toBe(false);
  });

  it('tracks multiple turnIds independently per case', () => {
    agentTurnRegistry.markCodexProfileDriftWarningEmitted('turn-A', 'caseA');
    agentTurnRegistry.markCodexProfileDriftWarningEmitted('turn-B', 'caseB');

    expect(agentTurnRegistry.hasCodexProfileDriftWarningEmitted('turn-A', 'caseA')).toBe(true);
    expect(agentTurnRegistry.hasCodexProfileDriftWarningEmitted('turn-A', 'caseB')).toBe(false);
    expect(agentTurnRegistry.hasCodexProfileDriftWarningEmitted('turn-B', 'caseA')).toBe(false);
    expect(agentTurnRegistry.hasCodexProfileDriftWarningEmitted('turn-B', 'caseB')).toBe(true);
  });
});
