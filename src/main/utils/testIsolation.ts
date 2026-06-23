/**
 * Test Isolation Helpers
 *
 * Centralized path helpers that redirect filesystem writes to an isolated
 * temporary directory when running E2E tests. This prevents tests from
 * corrupting a developer's real OAuth tokens, keychain entries, or other
 * persistent data.
 *
 * All helpers are FUNCTIONS (not module-level constants) so they evaluate
 * lazily — after the test harness has set the relevant env vars.
 *
 * Uses the canonical resolved path from ensureTestUserData.ts (not the raw
 * env var) so that REBEL_TEST_USER_DATA_DIR=auto works correctly.
 *
 * See: docs/plans/partway/260220_e2e_test_isolation_hardening.md
 */

import path from 'node:path';
import os from 'node:os';
import { isHeadlessCli } from '@core/utils/headlessCli';
import { testUserDataPath } from '../startup/ensureTestUserData';

/**
 * Get the resolved isolated temp directory path.
 * Prefers the canonical path from ensureTestUserData (handles auto, symlinks,
 * realpath resolution). Falls back to raw env var for non-Electron contexts
 * (e.g., unit tests that set the env directly).
 */
function getIsolatedDir(): string | null {
  return testUserDataPath ?? process.env.REBEL_TEST_USER_DATA_DIR ?? null;
}

/**
 * Check if the app is running inside an E2E test.
 *
 * Requires BOTH env vars to prevent accidental activation in production:
 * - `REBEL_E2E_TEST_MODE=1` — set by test-utils.ts on Electron launch
 * - `REBEL_TEST_USER_DATA_DIR` — the isolated temp directory path
 */
export function isE2eTestMode(): boolean {
  return (
    process.env.REBEL_E2E_TEST_MODE === '1' &&
    !!process.env.REBEL_TEST_USER_DATA_DIR
  );
}

/**
 * Check if the app is running as a --rebel-test instance (parallel test mode).
 *
 * This mode is a superset of E2E isolation: it uses a separate userData dir,
 * skips auto-updates, protocol handlers, global shortcuts, notifications,
 * automations, and boots into guest mode. Designed for running alongside
 * the user's daily-driver instance for automated UI smoke testing.
 *
 * Set by ensureRebelTestMode.ts (--rebel-test flag or REBEL_TEST_MODE=1 env).
 */
export function isRebelTestMode(): boolean {
  return process.env.REBEL_TEST_MODE === '1';
}

/**
 * "Running as the headless CLI" check — re-exported from the platform-agnostic core
 * SSOT (`@core/utils/headlessCli`). Re-exported here so the many main-side callers
 * that import from this module keep working unchanged. The startup gates that used to
 * also consult `app.commandLine.hasSwitch('headless-cli')` were migrated onto this
 * single definition and the (dead, inconsistent) switch belt retired — see the core
 * module's docstring.
 *
 * IMPORTANT: this module is reachable from a CORE entrypoint
 * (`agentTurnExecute.ts` → `openRouterTokenStorage.ts` → here), so it must stay
 * **electron-free** (enforced by `validate:transitive-electron-deps`); `headlessCli`
 * is pure env/argv with no platform deps.
 */
export { isHeadlessCli };

/**
 * Should startup NATIVE MODALS be suppressed because there's no human to dismiss
 * them? True for any automated/headless context: `--rebel-test`, E2E, or the
 * headless CLI. A parent-less `dialog.showMessageBox` at startup becomes an
 * app-modal `[NSAlert runModal]` on the shared Electron/Chromium main thread and
 * wedges the automated boot (the chronic-E2E launch hang). The startup-dialog
 * wrapper (`src/main/startup/startupDialog.ts`) keys on this.
 *
 * Deliberately uses the RAW `REBEL_E2E_TEST_MODE` env (not `isE2eTestMode()`,
 * which additionally requires `REBEL_TEST_USER_DATA_DIR`): for "is there a user
 * to click the dialog?" the raw flag is the correct, broader signal — a real
 * user never sets it. The stricter `isE2eTestMode()` is for DATA ISOLATION (a
 * different question) and stays as-is.
 */
export function isAutomatedOrHeadlessContext(): boolean {
  return (
    isRebelTestMode() ||
    process.env.REBEL_E2E_TEST_MODE === '1' ||
    isHeadlessCli()
  );
}

/**
 * Get the Super-MCP root directory.
 * In test mode, returns a path under the isolated temp dir.
 */
export function getSuperMcpDir(): string {
  const isolated = isE2eTestMode() ? getIsolatedDir() : null;
  if (isolated) {
    return path.join(isolated, '.super-mcp');
  }
  return path.join(os.homedir(), '.super-mcp');
}

/**
 * Get the Super-MCP OAuth tokens directory.
 * In test mode, returns a path under the isolated temp dir.
 */
export function getSuperMcpOAuthTokensDir(): string {
  return path.join(getSuperMcpDir(), 'oauth-tokens');
}

/**
 * Get the Claude Code projects directory (for agent transcripts).
 * In test mode, returns a path under the isolated temp dir.
 */
export function getClaudeProjectsDir(): string {
  const isolated = isE2eTestMode() ? getIsolatedDir() : null;
  if (isolated) {
    return path.join(isolated, '.claude', 'projects');
  }
  return path.join(os.homedir(), '.claude', 'projects');
}
