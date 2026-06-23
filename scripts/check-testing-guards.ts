#!/usr/bin/env tsx
/**
 * Consolidated testing-guards orchestrator (`npm run validate:testing-guards`).
 *
 * validate:fast is already ~120 steps; all always-on testing-infrastructure
 * guards from docs/plans/260610_testing-recs-drain ship under this ONE step
 * (Amendment A1). Each guard lives in its own module under scripts/checks/
 * (independently unit-testable) and registers here; the orchestrator runs
 * them sequentially with per-check labels and aggregates the exit code.
 *
 * To add a guard: create scripts/checks/<yourCheck>.ts exporting a
 * TestingGuardModule (see scripts/checks/types.ts), add it to GUARDS below,
 * and add a unit test in scripts/__tests__/ (picked up by the desktop
 * project's scripts/__tests__ glob automatically).
 *
 * KNOWN LATENT BUG (2026-06-12, unowned-by-fix): the orphaned-tests guard can
 * SIGSEGV (exit 139) from a stack overflow when the checkout's path population
 * is slightly deeper than dev's — observed deterministically in a worktree
 * with ~6 extra test/report files while plain dev passed, i.e. dev sits near
 * the same cliff. It is recursion through NATIVE frames (never converts to a
 * catchable RangeError even at --stack-size=300; suspect the vitest-config
 * dynamic-import chain or V8 regex in checkOrphanedTests.ts), so the
 * orchestrator's try/catch below cannot contain it. `node --stack-size=4000`
 * clears it; NODE_OPTIONS disallows --stack-size, so there is no env
 * workaround for the pre-push hook. Full isolation evidence: Closer report in
 * docs/plans/260611_fix-mcp-equivalence-gate/subagent_reports/260611_224015_closer.md
 * (owner: docs/plans/260610_testing-recs-drain).
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { TestingGuardModule } from './checks/types';
import { orphanedTestsGuard } from './checks/checkOrphanedTests';
import { mockContractsGuard } from './checks/checkMockContracts';

export const GUARDS: readonly TestingGuardModule[] = [
  orphanedTestsGuard,
  mockContractsGuard,
];

export async function runTestingGuards(guards: readonly TestingGuardModule[] = GUARDS): Promise<number> {
  let failedCount = 0;
  for (const guard of guards) {
    process.stdout.write(`── testing-guard: ${guard.name} ──\n`);
    try {
      const result = await guard.run();
      process.stdout.write(`   ${result.summary}\n`);
      if (!result.ok) {
        failedCount += 1;
        for (const failure of result.failures) {
          process.stderr.write(`✘ [${guard.name}] ${failure}\n`);
        }
      }
    } catch (error) {
      // A guard that cannot run is a failure, not a skip — fail closed.
      failedCount += 1;
      const message = error instanceof Error ? (error.stack ?? error.message) : String(error);
      process.stderr.write(`✘ [${guard.name}] guard crashed: ${message}\n`);
    }
  }
  if (failedCount > 0) {
    process.stderr.write(`\ntesting-guards FAILED: ${failedCount}/${guards.length} check(s) red.\n`);
    return 1;
  }
  process.stdout.write(`\ntesting-guards passed (${guards.length} check(s)).\n`);
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runTestingGuards().then(
    (code) => process.exit(code),
    (error) => {
      process.stderr.write(`testing-guards orchestrator crashed: ${String(error)}\n`);
      process.exit(1);
    },
  );
}
