/**
 * Shared contract for testing-guard check modules run by
 * scripts/check-testing-guards.ts (the consolidated `validate:testing-guards`
 * step — see docs/plans/260610_testing-recs-drain Amendment A1).
 *
 * Each check lives in its own module under scripts/checks/ (independently
 * unit-testable) and registers itself in the orchestrator's GUARDS list.
 * Keep modules side-effect-free at import time: all work happens in run().
 */

export interface GuardRunResult {
  /** True when the check passed (no failures). */
  readonly ok: boolean;
  /** One human-readable line per failure, including remediation hints. */
  readonly failures: readonly string[];
  /** One-line pass/fail context printed under the check label. */
  readonly summary: string;
}

export interface TestingGuardModule {
  /** Stable label printed by the orchestrator (also use it in remediation docs). */
  readonly name: string;
  run(): Promise<GuardRunResult>;
}
