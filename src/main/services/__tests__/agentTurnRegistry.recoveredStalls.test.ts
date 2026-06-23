import { afterEach, describe, expect, it } from 'vitest';

import { agentTurnRegistry } from '@core/services/agentTurnRegistry';

/**
 * Stage 5 of `docs/plans/260503_kw_eval_infra_robustness.md`: tests for the
 * `recordWatchdogSelfResolution` / `getRecoveredStallsMs` API. The eval
 * harness reads this surface to surface `recoveredStalls` in the run summary
 * (so operators don't have to grep logs for "Watchdog self-resolved").
 *
 * These tests document the contract independently of agentTurnExecutor so
 * the registry surface keeps working even if the wiring in the executor is
 * later refactored.
 */

const turnIds: string[] = [];

afterEach(() => {
  for (const id of turnIds) {
    agentTurnRegistry.cleanupTurn(id);
  }
  turnIds.length = 0;
});

function newTurn(prefix: string): string {
  const id = `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  turnIds.push(id);
  return id;
}

describe('agentTurnRegistry recovered-stall telemetry (Stage 5, 260503)', () => {
  it('returns empty array for a turn with no self-resolutions', () => {
    const turnId = newTurn('s5-empty');
    expect(agentTurnRegistry.getRecoveredStallsMs(turnId)).toEqual([]);
  });

  it('records a single self-resolution and returns it', () => {
    const turnId = newTurn('s5-single');
    agentTurnRegistry.recordWatchdogSelfResolution(turnId, 12_345);
    expect(agentTurnRegistry.getRecoveredStallsMs(turnId)).toEqual([12_345]);
  });

  it('appends multiple self-resolutions in order (per-turn watchdog can fire repeatedly)', () => {
    const turnId = newTurn('s5-multi');
    agentTurnRegistry.recordWatchdogSelfResolution(turnId, 5_000);
    agentTurnRegistry.recordWatchdogSelfResolution(turnId, 7_500);
    agentTurnRegistry.recordWatchdogSelfResolution(turnId, 30_000);
    expect(agentTurnRegistry.getRecoveredStallsMs(turnId)).toEqual([5_000, 7_500, 30_000]);
  });

  it('isolates per-turn telemetry (no cross-turn leakage)', () => {
    const turnA = newTurn('s5-iso-a');
    const turnB = newTurn('s5-iso-b');
    agentTurnRegistry.recordWatchdogSelfResolution(turnA, 1_000);
    agentTurnRegistry.recordWatchdogSelfResolution(turnB, 2_000);
    agentTurnRegistry.recordWatchdogSelfResolution(turnA, 3_000);
    expect(agentTurnRegistry.getRecoveredStallsMs(turnA)).toEqual([1_000, 3_000]);
    expect(agentTurnRegistry.getRecoveredStallsMs(turnB)).toEqual([2_000]);
  });

  it('cleanupTurn clears the recorded values (no memory leak)', () => {
    const turnId = newTurn('s5-cleanup');
    agentTurnRegistry.recordWatchdogSelfResolution(turnId, 99);
    expect(agentTurnRegistry.getRecoveredStallsMs(turnId)).toEqual([99]);

    agentTurnRegistry.cleanupTurn(turnId);
    expect(agentTurnRegistry.getRecoveredStallsMs(turnId)).toEqual([]);
    // pop the id from the afterEach cleanup list since we already cleaned up
    turnIds.pop();
  });

  it('getRecoveredStallsMs returns a defensive copy — caller mutations do not leak into registry', () => {
    const turnId = newTurn('s5-defensive');
    agentTurnRegistry.recordWatchdogSelfResolution(turnId, 1_000);
    agentTurnRegistry.recordWatchdogSelfResolution(turnId, 2_000);

    const snapshot1 = agentTurnRegistry.getRecoveredStallsMs(turnId);
    snapshot1.push(99_999);
    snapshot1.shift();

    const snapshot2 = agentTurnRegistry.getRecoveredStallsMs(turnId);
    expect(snapshot2).toEqual([1_000, 2_000]);
  });

  it('record-then-read is synchronous within the same tick (executor onMessage contract)', () => {
    // Stage 5 ordering invariant: in agentTurnExecutor's onMessage callback,
    // we record self-resolution and the eval listener later reads. Both run
    // synchronously on the same stack frame in production, so a record made
    // earlier in a tick must be visible to a read later in the same tick.
    // This test pins that invariant — if someone accidentally introduces
    // microtask scheduling into record(), this test fails.
    const turnId = newTurn('s5-sync');
    agentTurnRegistry.recordWatchdogSelfResolution(turnId, 42);
    const same = agentTurnRegistry.getRecoveredStallsMs(turnId);
    expect(same).toEqual([42]);
  });
});
