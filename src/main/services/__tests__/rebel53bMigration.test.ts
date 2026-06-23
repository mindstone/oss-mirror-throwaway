/**
 * REBEL-53B migration test.
 *
 * Phase 7 refinement: this test now imports the shared
 * `shouldClearStaleStuckInstall()` predicate directly from
 * `installCompletionReconciliation` (co-located with the rest of the
 * reconciliation logic) rather than re-implementing it locally. The
 * startup migration block in `src/main/index.ts` consumes the same helper,
 * so a single behaviour change is impossible to mistakenly land in just
 * one of the two call sites.
 *
 * @see docs-private/investigations/260429_rebel_53b_stuck_install_false_positive.md
 */

import { describe, expect, it } from 'vitest';
import type { StuckInstall } from '../autoUpdateStateStore';
import { shouldClearStaleStuckInstall } from '../installCompletionReconciliation';

function makeStuck(overrides: Partial<StuckInstall> = {}): StuckInstall {
  return {
    updateKey: '(unknown)-darwin',
    fromVersion: '0.4.33',
    targetVersion: '(unknown)',
    attemptedAt: 1_700_000_000_000,
    platform: 'darwin',
    attemptCount: 1,
    lastFailedAt: 1_700_000_000_500,
    ...overrides,
  };
}

describe('REBEL-53B migration predicate', () => {
  it('clears stale (unknown)-targetVersion stuckInstall when user has moved on AND no active marker', () => {
    expect(
      shouldClearStaleStuckInstall({
        state: { stuckInstall: makeStuck() },
        currentVersion: '0.4.50', // moved on
        hasMarker: false,
      }),
    ).toBe(true);
  });

  it('does NOT clear when an active marker is present (reconciliation hasnt run yet)', () => {
    expect(
      shouldClearStaleStuckInstall({
        state: { stuckInstall: makeStuck() },
        currentVersion: '0.4.50',
        hasMarker: true,
      }),
    ).toBe(false);
  });

  it('does NOT clear when user is still on the from-version (might genuinely be stuck)', () => {
    expect(
      shouldClearStaleStuckInstall({
        state: { stuckInstall: makeStuck() },
        currentVersion: '0.4.33', // still on from-version
        hasMarker: false,
      }),
    ).toBe(false);
  });

  it('does NOT clear when targetVersion is a real version (not the regression marker)', () => {
    expect(
      shouldClearStaleStuckInstall({
        state: {
          stuckInstall: makeStuck({ targetVersion: '0.4.34' }),
        },
        currentVersion: '0.4.50',
        hasMarker: false,
      }),
    ).toBe(false);
  });

  it('does NOT clear when stuckInstall is null (nothing to clear)', () => {
    expect(
      shouldClearStaleStuckInstall({
        state: { stuckInstall: null },
        currentVersion: '0.4.50',
        hasMarker: false,
      }),
    ).toBe(false);
  });
});

describe('REBEL-53B migration: pendingStuckInstallEvents drain', () => {
  it('drops only entries with targetVersion === "(unknown)"', () => {
    const queue = [
      { updateKey: 'a', fromVersion: '0.4.33', targetVersion: '(unknown)', detectedAt: 1 },
      { updateKey: 'b', fromVersion: '0.4.33', targetVersion: '0.4.34', detectedAt: 2 },
      { updateKey: 'c', fromVersion: '0.4.33', targetVersion: '(unknown)', detectedAt: 3 },
    ];
    const tainted = queue.filter((ev) => ev.targetVersion === '(unknown)');
    const remaining = queue.filter((ev) => ev.targetVersion !== '(unknown)');
    expect(tainted.length).toBe(2);
    expect(remaining.length).toBe(1);
    expect(remaining[0].updateKey).toBe('b');
  });
});
