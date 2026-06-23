/**
 * Multi-process stress for the same-host sync lock's stale-takeover TOCTOU
 * guards (Phase-6 reviewer F1 rounds 1–2; the deterministic seam-based
 * versions live in same-host-sync-lock.test.ts). ALL multi-process stress
 * lives here, not in the unit suite: real races are inherently
 * probabilistic, and the unit suite sits in the pre-push tier via
 * `vitest related` (round-2 F2: a committed 10-iteration stress there flaked
 * ~10%/run on pre-fix code).
 *
 * 40 iterations × 3 real waiter processes racing one fabricated stale lock —
 * real kill-probes, real `ps`, real filesystem rename/link arbitration,
 * stderr PIPED (production-like; round 2 showed /dev/null stderr narrows the
 * race windows). Baselines: pre-round-3-fix, the reviewer's harness hit 2/30
 * double-holds (silent — the renameSync restore clobbered a fresh lock) and
 * the then-committed 10-iter unit stress flaked 2/21 suite runs.
 *
 * Assertions, strongest first:
 * - silentOverlaps === 0 (STRUCTURAL): a double-hold with NO `RESTORE
 *   COLLIDED` line in any waiter's stderr is the silent clobber class the
 *   linkSync restore kills by construction. Any silent double-hold = real
 *   regression, fail hard.
 * - overlaps ≤ 2 (BOUNDED RESIDUAL): a loud restore collision (displaced
 *   holder runs unserialized, loudly reported) is a DESIGNED-IN residual of
 *   rename-arbitrated takeover, not a bug — it needs a third waiter's wx
 *   inside the µs-scale recheck→rename→link windows. This harness is far
 *   more adversarial than production (25ms poll / 100ms holds / 3-way
 *   takeover scramble every iteration vs 2s poll / multi-minute holds /
 *   rare takeovers); observed post-fix rate ≈ 0–1 per 40 iterations.
 *   Asserting 0 here would re-commit exactly the probabilistic flake this
 *   file exists to avoid; the ≤2 bound still catches any regression that
 *   widens the window (pre-recheck rates were ~10× higher). Failure output
 *   prints full waiter stderr, so a trip is immediately classifiable as
 *   loud-residual vs silent-regression. If the bound trips on the designed-in
 *   loud residual, do NOT bump it — the recorded escalation is takeover-intent
 *   arbitration (a wx-created `.takeover` marker serializing the
 *   verify→rename section); see "Known residuals" in
 *   docs/project/PREPUSH_GATE_AND_RECEIPTS.md and the Stage-4 round-3/4
 *   implementer reports under docs/plans/260611_prepush-gate-speedup/.
 *   Note: this bound is a weak detector for the pre-rename RECHECK
 *   specifically — its deterministic pin is the "pre-rename recheck" test in
 *   the unit suite, which is the real guard against that refactor hazard.
 *
 * Named *.integration.test.ts so the fast tier (VITEST_FAST=1, pre-push
 * `vitest related`) skips it; full `npm test` runs it.
 */
import { describe, expect, it } from 'vitest';

import { runSyncLockStress } from './helpers/sync-lock-stress';

describe('same-host sync lock — takeover TOCTOU stress (integration)', () => {
  it(
    '40 iterations × 3 real waiters ⇒ zero SILENT double-holds, loud residual tightly bounded, no sidecar litter',
    { timeout: 300_000 },
    async () => {
      const summary = await runSyncLockStress(40);
      const silentDetails = summary.details.filter((d) => d.includes('SILENT'));
      expect(silentDetails).toEqual([]);
      expect(summary.silentOverlaps).toBe(0);
      expect(
        summary.overlaps,
        `loud-overlap detail (designed-in residual exceeded its bound):\n${summary.details.join('\n')}`,
      ).toBeLessThanOrEqual(2);
      expect(summary.totalWins).toBeGreaterThanOrEqual(40);
      expect(summary.staleSidecars).toBe(0);
    },
  );
});
