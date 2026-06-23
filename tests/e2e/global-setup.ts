/**
 * Playwright globalSetup for E2E tests
 *
 * Cleans up orphaned test processes ONCE before any workers start.
 * This is safe because no tests are running yet.
 *
 * Uses shared cross-platform cleanup helper that handles both Unix and Windows.
 *
 * See: docs/plans/partway/260220_e2e_test_isolation_hardening.md (Stage 7)
 */

import { cleanupOrphanedTestProcesses } from './e2e-process-cleanup';

async function globalSetup(): Promise<void> {
  console.log(`[E2E globalSetup] Starting cleanup at ${new Date().toISOString()}`);
  cleanupOrphanedTestProcesses('globalSetup');
}

export default globalSetup;
