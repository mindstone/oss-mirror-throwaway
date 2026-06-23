/**
 * Playwright globalTeardown for E2E tests
 *
 * Kills any orphaned test processes after the suite completes.
 * Uses shared cross-platform cleanup helper that handles both Unix and Windows.
 *
 * See: docs/plans/partway/260220_e2e_test_isolation_hardening.md (Stages 6-7)
 */

import { cleanupOrphanedTestProcesses } from './e2e-process-cleanup';

async function globalTeardown(): Promise<void> {
  console.log(`[E2E globalTeardown] Cleaning up at ${new Date().toISOString()}`);
  cleanupOrphanedTestProcesses('globalTeardown');
}

export default globalTeardown;
