import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execSync, spawnSync } from 'node:child_process';
import { _electron as electron, expect, type ElectronApplication, type Page } from '@playwright/test';
import { createSignedSlackPayload, type SlackMockServer } from './helpers/slackMockServer';

// =============================================================================
// Mock Infrastructure Exports (Stage 3)
// See: docs/plans/partway/260126_e2e_test_architecture_overhaul.md
// =============================================================================

export {
  enableLlmMocking,
  disableLlmMocking,
  mockResponse,
  mockResponseWithTools,
  mockStreamingResponse,
} from './mocks/llm-mock';
export type { MockErrorType, MockOptions, MockResponse, MockToolCall } from './mocks/llm-mock';
export { startSlackMockServer } from './helpers/slackMockServer';
export type { SlackMockCall, SlackMockServer } from './helpers/slackMockServer';

// Import types for internal use in launchWithMocking
import { enableLlmMocking, type MockResponse } from './mocks/llm-mock';
import { enableVoiceMocking, type VoiceMockOptions } from './mocks/voice-mock';

export {
  enableVoiceMocking,
  disableVoiceMocking,
  VoiceMockPresets,
} from './mocks/voice-mock';
export type { VoiceMockOptions } from './mocks/voice-mock';

export function signSlackPayload(args: {
  body: unknown;
  signingSecret: string;
  timestamp?: number;
}): { headers: Record<string, string>; signedBody: string } {
  const signed = createSignedSlackPayload({
    payload: args.body as Record<string, unknown>,
    signingSecret: args.signingSecret,
    timestamp: args.timestamp,
  });
  return {
    headers: signed.headers,
    signedBody: signed.rawBody,
  };
}

export async function triggerCloudWebhook(args: {
  event: unknown;
  mockServer: Pick<SlackMockServer, 'baseUrl'>;
  webhookUrl: string;
  signingSecret: string;
}): Promise<unknown> {
  const response = await fetch(`${args.mockServer.baseUrl}/__test/send-event`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      event: args.event,
      signingSecret: args.signingSecret,
      webhookUrl: args.webhookUrl,
    }),
  });
  return response.json() as Promise<unknown>;
}

export const PROJECT_ROOT = process.cwd();
const buildChannel = process.env.BUILD_CHANNEL || 'stable';
const isBeta = buildChannel === 'beta';
export const APP_NAME = isBeta ? 'Mindstone Rebel Beta' : 'Mindstone Rebel';
export const ARCH = process.arch === 'arm64' ? 'arm64' : 'x64';
export const PLATFORM = process.platform;

/**
 * Get the path to the packaged Electron app executable.
 * Supports macOS (darwin), Windows (win32), and Linux.
 */
export function getAppPath(): string {
  const platformArch = `${PLATFORM === 'win32' ? 'win32' : PLATFORM}-${ARCH}`;
  const appDir = path.join(PROJECT_ROOT, 'out', `${APP_NAME}-${platformArch}`);

  switch (PLATFORM) {
    case 'darwin':
      return path.join(appDir, `${APP_NAME}.app`, 'Contents', 'MacOS', APP_NAME);
    case 'win32':
      return path.join(appDir, `${APP_NAME}.exe`);
    case 'linux':
      return path.join(appDir, 'mindstone-rebel');
    default:
      throw new Error(`Unsupported platform: ${PLATFORM}`);
  }
}

/**
 * Get the first window from the Electron app with platform-aware timeout.
 * Windows CI runners need longer timeouts due to slower Electron startup.
 *
 * This replaces direct `app.firstWindow()` calls which use Playwright's
 * default 30s timeout — insufficient for Windows CI.
 * See: WHY_E2E_TESTS_ARE_HARD_TO_FIX.md Entry #16
 */
export async function getFirstWindow(app: ElectronApplication): Promise<Page> {
  const timeout = PLATFORM === 'win32' ? 90000 : 30000;
  return app.firstWindow({ timeout });
}

/**
 * CI-aware, env-overridable budget for `electronApp.firstWindow()` waits.
 *
 * A *fixed* long first-window timeout is the 260531 voice-session-routing
 * regression class: adequate on a fresh runner, false on the tired-runner
 * release lane (the spec runs after 100+ prior tests). This helper is the
 * canonical shape (same as `E2E_STARTUP_PROBE_TIMEOUT_MS` and the original
 * voice-session-routing fix): generous on CI, snappier locally, always
 * overridable via `E2E_FIRST_WINDOW_TIMEOUT_MS` when triaging.
 *
 * Enforced by `scripts/check-e2e-timeout-budget.ts` — fixed `firstWindow`
 * literals above the threshold fail validate:fast unless CI-aware,
 * env-overridable, or explicitly justified. Prefer this helper over a literal.
 */
export function firstWindowTimeoutMs(): number {
  const override = Number(process.env.E2E_FIRST_WINDOW_TIMEOUT_MS);
  if (Number.isFinite(override) && override > 0) return override;
  return process.env.CI ? 240_000 : 60_000;
}

/**
 * Get the path to the app's user data directory (where settings are stored).
 * For packaged apps, this uses the app name from package.json (mindstone-rebel).
 */
function getAppSupportDir(): string {
  switch (PLATFORM) {
    case 'darwin':
      return path.join(os.homedir(), 'Library', 'Application Support', 'mindstone-rebel');
    case 'win32':
      return path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'mindstone-rebel');
    case 'linux':
      return path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'mindstone-rebel');
    default:
      throw new Error(`Unsupported platform: ${PLATFORM}`);
  }
}

/**
 * Get the path to Electron's development profile directory.
 * Used when running in dev mode (not packaged).
 */
function getElectronDevProfileDir(): string {
  switch (PLATFORM) {
    case 'darwin':
      return path.join(os.homedir(), 'Library', 'Application Support', 'Electron');
    case 'win32':
      return path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'Electron');
    case 'linux':
      return path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'Electron');
    default:
      throw new Error(`Unsupported platform: ${PLATFORM}`);
  }
}

export const APP_PATH = getAppPath();

/**
 * Check if the packaged app exists at the expected path.
 */
export function appExists(): boolean {
  return fs.existsSync(APP_PATH);
}

/**
 * Get a human-readable skip message for when the app isn't found.
 */
export function getAppNotFoundMessage(): string {
  return `Packaged app not found at ${APP_PATH}. Run "npm run package" before running Electron Playwright tests.`;
}

/**
 * Get the escape hatch keyboard shortcut for the current platform.
 * macOS uses Meta (Cmd), Windows/Linux use Control.
 */
export function getEscapeHatchShortcut(): string {
  return PLATFORM === 'darwin' ? 'Meta+Shift+Alt+KeyE' : 'Control+Shift+Alt+KeyE';
}

// ============================================================================
// Isolated UserData Testing Infrastructure (Stage 2)
// See: docs/plans/finished/251226_isolated_user_data_testing.md
// ============================================================================

export interface IsolatedUserData {
  /** Absolute path to the isolated userData directory */
  path: string;
  /** Cleanup function to remove the temporary directory */
  cleanup: () => void;
}

/**
 * Creates a unique isolated userData directory for testing.
 * Uses fs.mkdtempSync for atomic unique directory creation.
 * Returns the path and a cleanup function.
 *
 * @param testName - Optional test name to include in the directory name for debugging
 */
export function createIsolatedUserData(testName?: string): IsolatedUserData {
  // Use fs.mkdtempSync for atomic unique directory creation
  const prefix = testName ? `rebel-e2e-${testName}-` : 'rebel-e2e-';
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), prefix));

  return {
    path: userDataPath,
    cleanup: () => {
      // Retry loop for Windows file lock issues
      // Windows can take longer to release file locks, especially for Cache files
      const maxAttempts = process.platform === 'win32' ? 5 : 3;
      const delayMs = process.platform === 'win32' ? 500 : 100;
      
      for (let attempt = 0; attempt < maxAttempts; attempt++) {
        try {
          fs.rmSync(userDataPath, { recursive: true, force: true });
          return;
        } catch (e) {
          if (attempt < maxAttempts - 1) {
            // Wait before retry (Windows file locks)
            // Using a simple sync delay since this is test cleanup
            const start = Date.now();
            while (Date.now() - start < delayMs) {
              // Busy wait - acceptable in test cleanup
            }
          } else {
            // On final failure, just log warning - don't fail the test
            // Windows CI cleanup failures shouldn't block test results
            console.warn(`Failed to cleanup test userData after ${maxAttempts} attempts: ${userDataPath}`, e);
          }
        }
      }
    }
  };
}

/**
 * Normalize paths for comparison (handles symlinks, case, /var vs /private/var).
 * Used for robust path equality checks across platforms.
 */
function normalizePath(p: string): string {
  try {
    // Resolve symlinks (macOS /var -> /private/var)
    const resolved = fs.realpathSync(p);
    // Normalize separators and case for Windows
    return path.normalize(resolved).toLowerCase();
  } catch {
    return path.normalize(p).toLowerCase();
  }
}

// ============================================================================
// SAFETY: Real userData paths that tests must NEVER write to
// ============================================================================
const REAL_USER_DATA_PATHS = [
  path.join(os.homedir(), 'Library', 'Application Support', 'mindstone-rebel'),
  path.join(os.homedir(), 'AppData', 'Roaming', 'mindstone-rebel'), // Windows
  path.join(os.homedir(), '.config', 'mindstone-rebel') // Linux
];

function isRealUserDataPath(p: string): boolean {
  const normalized = normalizePath(p);
  return REAL_USER_DATA_PATHS.some((real) => normalized === normalizePath(real));
}

export interface LaunchOptions {
  /** Use packaged app (APP_PATH) if true, or local build (out/main) if false. Defaults to true. */
  usePackagedApp?: boolean;
  /** Additional command-line arguments to pass to the app */
  additionalArgs?: string[];
  /** Additional environment variables to pass to the app (merged with process.env) */
  additionalEnv?: Record<string, string>;
  /** If true (default), pre-seeds minimal settings so the app skips first-run onboarding. */
  skipOnboarding?: boolean;
}

const DEFAULT_E2E_WINDOW_BOUNDS = { width: 1280, height: 800 };

async function trySetDeterministicWindowBounds(electronApp: ElectronApplication): Promise<void> {
  const startTime = Date.now();
  
  // FAST PATH: Always use fast path since this function is only called from test code.
  // The isVisible() check can loop for up to 60s in CI where windows render offscreen.
  // Note: process.env.REBEL_E2E_TEST_MODE is set on the Electron process, not the test process,
  // so checking it here doesn't work. Since this function is only called from launchWithIsolatedUserData(),
  // which is exclusively used by tests, we always use the fast path.
  // See: docs/plans/obsolete/260121_e2e_performance_root_causes.md
  const fastPath = true;
  
  if (fastPath) {
    // Fast path: just find any non-destroyed window and set bounds immediately
    const didSet = await electronApp
      .evaluate(({ BrowserWindow }, bounds) => {
        const win = BrowserWindow.getAllWindows().find((w) => !w.isDestroyed());
        if (!win) return false;
        win.setBounds(bounds);
        return true;
      }, DEFAULT_E2E_WINDOW_BOUNDS)
      .catch(() => false);
    
    const elapsed = Date.now() - startTime;
    if (didSet) {
      console.log(`[E2E] [timing] Window bounds set (fast path): ${elapsed}ms`);
    } else {
      console.warn(`[E2E] [timing] Window bounds failed (fast path, no window found): ${elapsed}ms`);
    }
    return;
  }
  
  // SLOW PATH: Original behavior - wait for visible window (used when not in test mode)
  // CI-only flakes often come from different window metrics (layout shifts, overlays intercepting clicks).
  // We set a deterministic size early for all launches.
  const maxAttempts = 50;
  const delayMs = 200;
  const perAttemptTimeoutMs = 1000;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const didSet = await Promise.race([
      electronApp
        .evaluate(({ BrowserWindow }, bounds) => {
          const win = BrowserWindow.getAllWindows().find((w) => !w.isDestroyed() && w.isVisible());
          if (!win) return false;
          win.setBounds(bounds);
          return true;
        }, DEFAULT_E2E_WINDOW_BOUNDS)
        .catch(() => false),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), perAttemptTimeoutMs))
    ]);

    if (didSet) {
      const elapsed = Date.now() - startTime;
      console.log(`[E2E] [timing] Window bounds set (slow path, attempt ${attempt + 1}): ${elapsed}ms`);
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }

  const elapsed = Date.now() - startTime;
  console.warn(`[E2E] [timing] Failed to set deterministic BrowserWindow bounds after ${elapsed}ms (continuing anyway)`);
}

/**
 * Launch Electron app with isolated userData.
 * CRITICAL: Verifies isolation before returning.
 *
 * @param isolated - The isolated userData from createIsolatedUserData()
 * @param options - Launch options (packaged vs local build)
 * @throws Error if isolation verification fails (prevents tests from running against real userData)
 */
export async function launchWithIsolatedUserData(
  isolated: IsolatedUserData,
  options: LaunchOptions = {}
): Promise<ElectronApplication> {
  const launchStartTime = Date.now();
  console.log(`[E2E] [timing] launchWithIsolatedUserData: starting...`);
  
  const {
    usePackagedApp = true,
    additionalArgs = [],
    additionalEnv = {},
    skipOnboarding = true
  } = options;

  if (skipOnboarding) {
    writeMinimalSettings(isolated.path, {
      claudeApiKey: process.env.TEST_CLAUDE_API_KEY,
      openaiApiKey: process.env.TEST_OPENAI_API_KEY,
      elevenlabsApiKey: process.env.TEST_ELEVENLABS_API_KEY,
    });
  } else {
    // REBEL_TEST_MODE=1 triggers ensureRebelTestMode.ts which auto-seeds
    // { onboardingCompleted: true } when app-settings.json is missing.
    // Write a minimal file to prevent that, preserving the onboarding flow.
    const settingsPath = path.join(isolated.path, 'app-settings.json');
    if (!fs.existsSync(settingsPath)) {
      fs.writeFileSync(settingsPath, JSON.stringify({ onboardingCompleted: false }, null, 2));
      console.log('[E2E] Wrote onboardingCompleted:false to prevent REBEL_TEST_MODE auto-seeding');
    }
  }

  // Make the userData path visible in the process command line so that
  // pgrep -f / Win32 CommandLine queries can discover the parent Electron
  // process if app.close() and app.evaluate(app.exit) both fail to land in
  // safeCloseApp. Without this, the path is only in env
  // (REBEL_USER_DATA, REBEL_TEST_USER_DATA_DIR), which cleanup helpers
  // cannot see. The flag is already recognised and idempotent with the env
  // vars in src/main/startup/ensureRebelTestMode.ts (line 38).
  //
  // The primary orphan class this addresses is the parent Electron itself
  // when shutdown fails — NOT Super-MCP, which attaches detached:false
  // when REBEL_E2E_TEST_MODE=1 (see superMcpHttpManager.ts:1383) and dies
  // with Electron in test mode.
  //
  // See: docs/project/WHY_E2E_TESTS_ARE_HARD_TO_FIX.md Known Hard Problem #1
  // and Fix Attempt #27.
  const cleanupMarkerArg = `--rebel-test-user-data-dir=${isolated.path}`;
  const argsWithMarker = [cleanupMarkerArg, ...additionalArgs];
  console.log(
    `[E2E] [orphan-cleanup] event=argv-marker-added ` +
    `userDataBasename=${path.basename(isolated.path)}`
  );

  const launchConfig = usePackagedApp
    ? { executablePath: APP_PATH, args: argsWithMarker }
    : { args: ['out/main/index.js', ...argsWithMarker] };

  const electronLaunchStart = Date.now();
  const electronApp = await electron.launch({
    ...launchConfig,
    env: {
      ...process.env,
      ...additionalEnv,
      REBEL_E2E_TEST_MODE: '1',
      // REBEL_E2E_TEST_MODE enables Playwright-specific test hooks/readiness helpers.
      // REBEL_TEST_MODE activates the existing --rebel-test-mode preload flag so
      // sessionStorage.guestMode=true is set on DOMContentLoaded before React reads
      // it, eliminating the enableGuestMode() timing race. It also disables several
      // benign-for-tests desktop integrations (auto-updates, notifications, dock
      // badge, coaching, protocol handler, and voice hotkey).
      REBEL_TEST_MODE: '1',
      // Pin all data-path env vars to the isolated directory so no shell env leaks through.
      // getDataPath() checks REBEL_USER_DATA before app.getPath('userData'), so we must override it.
      REBEL_USER_DATA: isolated.path,
      REBEL_TEST_USER_DATA_DIR: isolated.path,
      // Prevent accidental weakening of the temp-dir guardrail
      REBEL_TEST_ALLOW_NON_TEMP_USERDATA: ''
    }
  });
  console.log(`[E2E] [timing] electron.launch(): ${Date.now() - electronLaunchStart}ms`);

  // CRITICAL: Verify isolation is active AND that the cleanup marker survived.
  //
  // Both probes (userData path + process.argv) are wrapped in a single
  // Promise.race timeout. If the main process hangs at startup, BOTH evaluate
  // calls would otherwise hang unbounded — stalling Playwright's global timeout
  // and producing the exact orphan we're trying to prevent. The combined race
  // ensures we abort locally with a specific error and force-close the app.
  //
  // The argv probe (cleanup marker) turns assumption A2 in the planning doc
  // (docs/plans/260428_kw_ci_knip_and_e2e_orphan_fixes.md) into a permanent
  // runtime invariant. Without the marker, pgrep -f / Win32 CommandLine
  // queries cannot discover orphaned Electron processes, and the cascade
  // documented in WHY_E2E_TESTS_ARE_HARD_TO_FIX.md Known Hard Problem #1
  // silently re-emerges.
  //
  // Timeout budget: CI runners are documented (perf-timing-signals.spec.ts:84-85)
  // as having a 6s startup envelope before raising a perf warning. A 5s probe
  // was therefore guaranteed to trip on the unlucky CI run — see
  // docs-private/investigations/260514_e2e_macos_startup_probe_timeout_and_artifact_loss.md.
  // 30s on CI sits well above the documented startup envelope and well below
  // every affected spec's 300_000 ms describe-level timeout, so a genuinely
  // hung main process still trips the abort with plenty of headroom for
  // safeCloseApp + the worker teardown. Locally we use 10s — most dev
  // machines beat that handily but the bigger window absorbs occasional load.
  // Override via `E2E_STARTUP_PROBE_TIMEOUT_MS` when triaging.
  // Fake-media Chromium switches (--use-fake-device-for-media-stream etc.) push
  // the browser-process init to ~6-7s on macOS and keep the main Node event loop
  // saturated past that — so a single hard `Promise.race` on electronApp.evaluate
  // false-positives as a "hang" when the loop is merely busy, not stuck. See
  // WHY_E2E_TESTS_ARE_HARD_TO_FIX.md Entry #28 + the inv7 diagnosis
  // (docs/plans/260604_fix-chronic-macos-e2e-failures). Detect those flags and
  // give the probe the CI-sized budget locally too.
  const usesFakeMedia = argsWithMarker.some(
    (a) => a.includes('fake-device-for-media-stream') || a.includes('fake-ui-for-media-stream')
  );
  // CONTRACT: the CI default below must stay STRICTLY ABOVE the documented CI
  // startup perf budget (warnThreshold in perf-timing-signals.spec.ts) —
  // enforced by scripts/check-e2e-startup-safety-budget.ts (validate:fast).
  const STARTUP_PROBE_TIMEOUT_MS = process.env.CI
    ? Number(process.env.E2E_STARTUP_PROBE_TIMEOUT_MS) || 30_000
    : Number(process.env.E2E_STARTUP_PROBE_TIMEOUT_MS) || (usesFakeMedia ? 30_000 : 10_000);

  // For fake-media launches, await firstWindow() BEFORE the isolation probe.
  //
  // Why: the probe issues `electronApp.evaluate` (getPath/argv) against the MAIN
  // process. Under the fake-media Chromium switches on macOS the main process does
  // not service those evaluate calls for the full budget while it grinds through
  // pre-firstWindow init — the retry-poll alone could NOT recover it (the loop is
  // not merely busy for ~7s; it stays unserviceable). The decisive contrast:
  // voice-failure-ux uses the SAME fake-media flags but reaches firstWindow fine
  // because it goes through launchWithMocking which awaits firstWindow() early;
  // voice-session-routing calls this helper directly, so its pre-firstWindow probe
  // starves. Once a window EXISTS the main loop is provably alive and turning over,
  // and the two evaluate calls return instantly. So for fake-media we gate on a
  // window first, then run the (unchanged) probe — which now resolves quickly.
  //
  // Safety is preserved: a firstWindow timeout is treated identically to the
  // probe-exhausted path (force-close + SAFETY ABORT throw) — i.e. a genuinely
  // hung startup still aborts before the orphan cascade. The non-fake-media path is
  // unchanged (probes pre-firstWindow as before). The isolation checks below
  // (userData match, cleanup-marker-in-argv, real-path guard) still run and still
  // abort on any violation.
  if (usesFakeMedia) {
    try {
      await electronApp.firstWindow({ timeout: STARTUP_PROBE_TIMEOUT_MS });
    } catch (err) {
      try {
        await safeCloseApp(electronApp, 15000, isolated.path);
      } catch {
        /* best-effort */
      }
      throw new Error(
        `SAFETY ABORT: fake-media startup hang (firstWindow timeout after ${STARTUP_PROBE_TIMEOUT_MS}ms; ` +
        `${(err as Error)?.message ?? String(err)}). ` +
        `Main process likely hung at startup; aborting before orphan cascade.`
      );
    }
  }

  // Retry-poll the probe rather than a single hard race. A queued evaluate that
  // can't be serviced because the main loop is busy with startup work will lose a
  // short per-attempt race; we retry until the *overall* budget elapses. Only a
  // genuinely hung main process (never frees the loop) exhausts the budget and
  // trips the SAFETY ABORT — so the orphan-cascade guard is preserved while a
  // slow-but-alive startup is tolerated.
  const PROBE_ATTEMPT_TIMEOUT_MS = 5_000;
  const probeDeadline = Date.now() + STARTUP_PROBE_TIMEOUT_MS;
  let probeResult: [string, string[]] | null = null;
  let lastProbeErr: unknown = new Error('startup-probe-timeout');
  while (Date.now() < probeDeadline) {
    const attempt = Promise.all([
      electronApp.evaluate(({ app }) => app.getPath('userData')),
      electronApp.evaluate(() => process.argv),
    ]) as Promise<[string, string[]]>;
    // Swallow a late rejection from an attempt that loses the per-attempt race so
    // it doesn't surface as an unhandled rejection after we've moved on.
    attempt.catch(() => {});
    try {
      probeResult = await Promise.race([
        attempt,
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('probe-attempt-timeout')), PROBE_ATTEMPT_TIMEOUT_MS)
        ),
      ]);
      break;
    } catch (err) {
      lastProbeErr = err;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
  if (!probeResult) {
    // Budget exhausted across all attempts — main process is genuinely hung.
    // Force-close the (possibly hung) app before throwing — preserves the
    // exact orphan we'd otherwise be creating.
    try {
      await safeCloseApp(electronApp, 15000, isolated.path);
    } catch {
      /* best-effort */
    }
    throw new Error(
      `SAFETY ABORT: startup probe failed (startup-probe-timeout after ${STARTUP_PROBE_TIMEOUT_MS}ms; ` +
      `last=${(lastProbeErr as Error)?.message ?? String(lastProbeErr)}). ` +
      `Main process likely hung at startup; aborting before orphan cascade.`
    );
  }
  const [actualPath, argv] = probeResult;
  const normalizedExpected = normalizePath(isolated.path);
  const normalizedActual = normalizePath(actualPath);

  // Check 1: Verify we got the path we asked for
  if (normalizedActual !== normalizedExpected) {
    await safeCloseApp(electronApp, 15000, isolated.path);
    throw new Error(
      `SAFETY ABORT: userData isolation failed!\n` +
        `Expected: ${isolated.path} (normalized: ${normalizedExpected})\n` +
        `Actual: ${actualPath} (normalized: ${normalizedActual})\n` +
        `Real user settings may be at risk. Aborting.`
    );
  }

  // Check 1b: Confirm the cleanup marker landed in argv intact.
  // Exact-match (not startsWith) so a duplicate marker in additionalArgs
  // can't false-positive past this gate.
  if (!argv.includes(cleanupMarkerArg)) {
    await safeCloseApp(electronApp, 15000, isolated.path);
    throw new Error(
      `SAFETY ABORT: cleanup marker ${cleanupMarkerArg} not in argv. ` +
      `Argv: ${JSON.stringify(argv)}. Orphan cleanup will silently fail.`
    );
  }

  // Check 2: Double-check we're NOT using a real userData path
  if (isRealUserDataPath(actualPath)) {
    await safeCloseApp(electronApp, 15000, isolated.path);
    throw new Error(
      `SAFETY ABORT: Test is using REAL userData path!\n` +
        `Path: ${actualPath}\n` +
        `Tests must NEVER use the real userData directory. Something is very wrong.`
    );
  }

  await trySetDeterministicWindowBounds(electronApp);

  const totalElapsed = Date.now() - launchStartTime;
  console.log(`[E2E] [timing] launchWithIsolatedUserData: complete in ${totalElapsed}ms`);
  
  return electronApp;
}

/**
 * Launch app for E2E tests with AUTOMATIC isolation.
 * This is the recommended way to launch - no need to manage IsolatedUserData manually.
 *
 * Automatically:
 * - Creates a unique temp directory
 * - Sets REBEL_TEST_USER_DATA_DIR
 * - Verifies isolation
 * - Returns cleanup function
 *
 * @param testName - Test name for directory naming (helps with debugging)
 * @param options - Launch options (packaged vs local build, additional args)
 * @returns Object with electronApp, cleanup function, and userDataPath
 */
export async function launchIsolatedApp(
  testName: string,
  options: LaunchOptions = {}
): Promise<{ electronApp: ElectronApplication; cleanup: () => void; userDataPath: string }> {
  const isolated = createIsolatedUserData(testName);

  try {
    const electronApp = await launchWithIsolatedUserData(isolated, options);
    return {
      electronApp,
      cleanup: isolated.cleanup,
      userDataPath: isolated.path
    };
  } catch (e) {
    // Clean up on launch failure
    isolated.cleanup();
    throw e;
  }
}

// =============================================================================
// Launch with Mocking (Stage 3.3)
// See: docs/plans/partway/260126_e2e_test_architecture_overhaul.md
// =============================================================================

/**
 * Options for launching an Electron app with LLM and voice mocking enabled.
 */
export interface LaunchWithMockingOptions extends LaunchOptions {
  /** Array of mock responses for pattern-matched prompts */
  mockResponses?: MockResponse[];
  /** Default response when no pattern matches. Default: 'This is a mock response from the E2E test infrastructure.' */
  defaultMockResponse?: string;
  /** Enable voice mocking. Pass true for minimal defaults, or VoiceMockOptions for custom config. */
  voiceMocking?: boolean | VoiceMockOptions;
  /** Enable debug logging for mocks. Also enabled if DEBUG_MOCKS=1 env var is set. */
  debugMocks?: boolean;
}

/**
 * Launch Electron app with automatic LLM (and optionally voice) mocking enabled.
 *
 * This is the recommended way to launch for most E2E tests. It combines
 * `launchIsolatedApp()` with mock enablement, ensuring mocks are installed
 * before any UI interaction can trigger a turn.
 *
 * Benefits:
 * - Tests complete in <30s instead of 60-150s with live LLM calls
 * - Deterministic responses for reliable assertions
 * - No external API dependencies (no flakiness from network issues)
 * - No API costs during test runs
 *
 * Usage:
 * ```typescript
 * const { electronApp, cleanup } = await launchWithMocking('my-test', {
 *   mockResponses: [
 *     mockResponse(/hello/i, 'Hello! How can I help you today?'),
 *     mockResponseWithTools(/read file/i, 'I found the file content...', [
 *       { name: 'Read', detail: 'Reading /path/to/file.ts' }
 *     ]),
 *   ],
 *   defaultMockResponse: 'I understand your request.',
 *   voiceMocking: true, // Enable with defaults
 * });
 * ```
 *
 * @param testName - Test name for directory naming (helps with debugging)
 * @param options - Launch options including mock configuration
 * @returns Object with electronApp, cleanup function, and userDataPath
 */
export async function launchWithMocking(
  testName: string,
  options: LaunchWithMockingOptions = {}
): Promise<{ electronApp: ElectronApplication; cleanup: () => void; userDataPath: string }> {
  const {
    mockResponses = [],
    defaultMockResponse,
    voiceMocking,
    debugMocks,
    ...launchOpts
  } = options;

  // Seed a dummy Claude API key when mocking is active and no real key is set.
  // This satisfies the auth validation gate (which disables the send button when
  // apiKey is null) while the mock intercepts agent:turn before any real API call.
  // Pattern precedent: voice-failure-ux.spec.ts seeds a fake openaiApiKey similarly.
  //
  // Also set REBEL_E2E_MOCK_MODE so writeMinimalSettings() won't enable rebelCore
  // (which would route through the real Anthropic client, bypassing the IPC mock).
  const savedKey = process.env.TEST_CLAUDE_API_KEY;
  const savedMockMode = process.env.REBEL_E2E_MOCK_MODE;
  if (!savedKey) {
    process.env.TEST_CLAUDE_API_KEY = 'YOUR_TEST_CLAUDE_API_KEY_HERE';
  }
  process.env.REBEL_E2E_MOCK_MODE = '1';

  // Launch the app with isolation
  let result: { electronApp: ElectronApplication; cleanup: () => void; userDataPath: string };
  try {
    result = await launchIsolatedApp(testName, launchOpts);
  } finally {
    // Restore original env state so other tests aren't affected
    if (!savedKey) {
      delete process.env.TEST_CLAUDE_API_KEY;
    }
    if (!savedMockMode) {
      delete process.env.REBEL_E2E_MOCK_MODE;
    } else {
      process.env.REBEL_E2E_MOCK_MODE = savedMockMode;
    }
  }

  try {
    // Wait for the first window before installing mocks.
    // Handler registration (index.ts:4064-4350) is synchronous and completes before
    // window creation (index.ts:4468). Without this wait, enableLlmMocking() can run
    // during the async init phase and get silently overwritten by registerAgentHandlers().
    await result.electronApp.firstWindow({ timeout: firstWindowTimeoutMs() });

    await enableLlmMocking(result.electronApp, {
      responses: mockResponses,
      defaultResponse: defaultMockResponse ?? 'This is a mock response from the E2E test infrastructure.',
      debug: debugMocks ?? process.env.DEBUG_MOCKS === '1',
    });

    // Enable voice mocking if requested
    if (voiceMocking) {
      const voiceOpts: VoiceMockOptions = typeof voiceMocking === 'object' ? voiceMocking : {};
      await enableVoiceMocking(result.electronApp, {
        ...voiceOpts,
        debug: debugMocks ?? process.env.DEBUG_MOCKS === '1',
      });
    }

    return result;
  } catch (e) {
    // Clean up on mock setup failure
    // Fix: must close the app process, not just cleanup the userData directory
    // (reviewers noted this could leave orphaned Electron/Super-MCP processes)
    try {
      await safeCloseApp(result.electronApp, 5000, result.userDataPath);
    } catch {
      // Ignore close errors during cleanup
    }
    result.cleanup();
    throw e;
  }
}

/**
 * Kill a process and all its children (process tree).
 * Uses platform-specific commands to ensure child processes are terminated.
 * 
 * @param pid - Process ID to kill
 * @param userDataPath - Optional path to the isolated userData directory for orphan detection
 */
function killProcessTree(pid: number, userDataPath?: string): void {
  try {
    if (PLATFORM === 'win32') {
      // Windows: taskkill with /T kills the process tree
      execSync(`taskkill /pid ${pid} /t /f`, { stdio: 'ignore' });
      console.log(`[E2E] Killed process tree (Windows taskkill): PID ${pid}`);
    } else {
      // macOS/Linux: Try multiple approaches for reliability
      // 1. Try process group kill (kills all processes in the group)
      try {
        process.kill(-pid, 'SIGKILL');
      } catch {
        // Process group kill may fail if process isn't a group leader
      }
      // 2. Try pkill to kill children by parent PID
      try {
        execSync(`pkill -KILL -P ${pid}`, { stdio: 'ignore' });
      } catch {
        // pkill may fail if no children exist - that's fine
      }
      // 3. Kill the main process directly
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        // Process may already be dead
      }
      console.log(`[E2E] Killed process tree (Unix): PID ${pid}`);
      
      // 4. userData-based orphan detection for Super-MCP children.
      // In E2E test mode, Super-MCP is spawned with detached: false (see
      // superMcpHttpManager.ts:1383) and dies with the parent. This branch covers
      // (a) any child that survived parent kill (e.g. zombie state where parent kill
      // didn't propagate) and (b) future codepaths where Super-MCP is detached:true.
      // Uses userData path in argv (--config <userData>/mcp/...) for discovery.
      if (userDataPath) {
        try {
          const basename = path.basename(userDataPath); // e.g., "rebel-e2e-smoke-xxxxx"
          const pgrepResult = spawnSync('pgrep', ['-f', basename], { encoding: 'utf8' });
          
          if (pgrepResult.status === 0 && pgrepResult.stdout) {
            const orphanPids = pgrepResult.stdout
              .split('\n')
              .filter(Boolean)
              .map(Number)
              .filter((orphanPid) => !isNaN(orphanPid) && orphanPid > 0);
            
            let killedCount = 0;
            for (const orphanPid of orphanPids) {
              // Skip self and the main Electron PID (already handled above)
              if (orphanPid === process.pid || orphanPid === pid) {
                continue;
              }
              
              // Safety: Verify it's actually a Super-MCP process
              const psResult = spawnSync('ps', ['-p', String(orphanPid), '-o', 'command='], { encoding: 'utf8' });
              const cmdline = psResult.stdout || '';
              
              if (!cmdline.includes('super-mcp') && !cmdline.includes('super-mcp-router.json')) {
                continue;
              }
              
              console.log(`[E2E] Killing orphaned Super-MCP process: PID ${orphanPid}`);
              
              // Kill the process GROUP first (Super-MCP may have children)
              try {
                process.kill(-orphanPid, 'SIGKILL');
              } catch {
                // Process group kill may fail if not a group leader
              }
              
              // Then kill the process directly as fallback
              try {
                process.kill(orphanPid, 'SIGKILL');
                killedCount++;
              } catch {
                // Process may already be dead
              }
            }
            
            if (killedCount > 0) {
              console.log(`[E2E] Killed ${killedCount} orphaned Super-MCP process(es) via userData path`);
            }
          } else {
            console.log(
              `[E2E] [orphan-cleanup] event=killProcessTree-userdata-no-children ` +
              `userDataBasename=${basename} pid=${pid} ` +
              `pgrepStatus=${pgrepResult.status}. Parent PID was directly killed above; ` +
              `if it persisted, cleanupOrphanedTestProcesses (broad rebel-e2e- scan) is the ` +
              `next safety net.`
            );
          }
        } catch (orphanErr) {
          // Non-fatal: log warning and continue
          console.warn(`[E2E] userData-based orphan cleanup failed: ${orphanErr}`);
        }
      }
    }
  } catch (e) {
    // Process may already be dead or we don't have permission
    console.warn(`[E2E] killProcessTree failed for PID ${pid}: ${e}`);
  }
}

/**
 * Safely close an Electron app with timeout fallback and process tree kill.
 * 
 * On CI (especially Windows), app.close() can hang if background processes
 * (e.g., Super-MCP, GPU embedding backend) don't shut down cleanly.
 * 
 * This helper ensures teardown completes by:
 * 1. Attempting graceful app.close() with timeout
 * 2. If that fails, attempting app.evaluate(app.exit(0)) with timeout
 * 3. If that also fails, killing the entire process tree via OS commands
 * 
 * @param app - The Playwright ElectronApplication to close.
 * @param timeoutMs - How long to wait for graceful shutdown stages. Default 15000ms.
 * @param userDataPath - Required: the isolated userData path passed to
 *   launchWithIsolatedUserData(). Used for orphan-cleanup discovery (see
 *   killProcessTree and Known Hard Problem #1 in WHY_E2E_TESTS_ARE_HARD_TO_FIX.md).
 *   Pass `undefined` only if you didn't launch via this harness's isolated-userdata
 *   helper — extremely rare.
 */
export async function safeCloseApp(
  app: ElectronApplication,
  timeoutMs = 15000,
  userDataPath: string | undefined,
): Promise<void> {
  if (!app) return;

  // Capture PID early before any close attempts might make it unavailable.
  // NOTE: the `?.` only guards a null RETURN — Playwright's `app.process()`
  // itself THROWS (`Cannot read properties of undefined (reading '_object')`)
  // when the underlying connection is already torn down (e.g. the app closed
  // during a prior 150s send-timeout). Optional chaining cannot catch a throw
  // on the call, so wrap it: a throw means the process is already gone.
  let pid: number | undefined;
  try {
    pid = app.process()?.pid;
  } catch {
    // App/connection already closed — treat the process as gone (pid undefined).
    pid = undefined;
  }
  
  let timeoutHandle: NodeJS.Timeout | undefined;
  let timedOut = false;
  
  // Attach catch to app.close() to prevent unhandled rejection if it loses the race
  const closePromise = app.close().catch((err) => {
    if (!timedOut) throw err; // Re-throw if we didn't time out (real error)
    // Otherwise swallow - we already handled via timeout path
  });
  
  const timeoutPromise = new Promise<void>((_, reject) => {
    timeoutHandle = setTimeout(() => {
      timedOut = true;
      reject(new Error('App close timeout'));
    }, timeoutMs);
  });
  
  try {
    await Promise.race([closePromise, timeoutPromise]);
  } catch (e) {
    console.warn(`[E2E] App close timed out or failed: ${e}. Attempting force quit...`);
    
    // Stage 2: Try app.evaluate(app.exit(0)) with its own timeout
    let evaluateSucceeded = false;
    try {
      await Promise.race([
        app.evaluate(({ app: electronApp }) => {
          electronApp.exit(0);
        }),
        new Promise<void>((_, reject) => 
          setTimeout(() => reject(new Error('app.evaluate timeout')), 5000)
        )
      ]);
      evaluateSucceeded = true;
    } catch {
      console.warn('[E2E] app.evaluate(exit) also failed or timed out.');
    }
    
    // Stage 3: Kill process tree if we have a PID and evaluate didn't work
    if (!evaluateSucceeded && pid) {
      console.warn(`[E2E] Falling back to process tree kill for PID ${pid}`);
      killProcessTree(pid, userDataPath);
    } else if (!evaluateSucceeded && !pid) {
      console.warn('[E2E] No PID available for process tree kill. Process may be orphaned.');
    }
  } finally {
    // Always clear the timeout to prevent it from holding the event loop
    if (timeoutHandle) clearTimeout(timeoutHandle);
  }
  
  // Post-cleanup verification: Check for remaining orphaned processes (diagnostic only)
  // Only run on Unix platforms where pgrep is available
  if (userDataPath && PLATFORM !== 'win32') {
    try {
      const basename = path.basename(userDataPath);
      const pgrepResult = spawnSync('pgrep', ['-f', basename], { encoding: 'utf8' });
      
      if (pgrepResult.status === 0 && pgrepResult.stdout) {
        const remainingPids = pgrepResult.stdout
          .split('\n')
          .filter(Boolean)
          .map(Number)
          .filter((orphanPid) => !isNaN(orphanPid) && orphanPid > 0 && orphanPid !== process.pid);
        
        if (remainingPids.length > 0) {
          console.warn(`[E2E] WARNING: Orphaned processes still running after cleanup: ${remainingPids.join(', ')}`);
        }
      }
    } catch {
      // Non-fatal: verification is best-effort
    }
  }
}

// ============================================================================
// API Key Seeding Options
// See: docs/plans/finished/260113_e2e_test_api_key_seeding.md
// ============================================================================

/**
 * Options for seeding API keys into app settings.
 * Used with writeMinimalSettings() to configure Claude and voice APIs for tests.
 */
export interface WriteMinimalSettingsOptions {
  /** Claude API key for authentication */
  claudeApiKey?: string;
  /** OpenAI API key for voice transcription (OpenAI Whisper provider) */
  openaiApiKey?: string;
  /** ElevenLabs API key for voice transcription (ElevenLabs Scribe provider) */
  elevenlabsApiKey?: string;
  /** Voice transcription provider to use */
  voiceProvider?: 'openai-whisper' | 'elevenlabs-scribe';
}

// ============================================================================
// Auth & Onboarding Bypass Utilities
// See: docs/plans/finished/251231_e2e_auth_skip_fix.md
// ============================================================================

/**
 * Activate guest mode for E2E tests.
 *
 * With REBEL_TEST_MODE=1, the preload sets sessionStorage.guestMode=true on
 * DOMContentLoaded. This function now only needs to:
 * 1. Suppress the PermissionOnboardingDialog (requires localStorage, can't be pre-launch)
 * 2. Verify guest mode was activated by the preload (canary assertion)
 *
 * See WHY_E2E entry #26 for the full history of this function's evolution.
 * @param window - Playwright Page object for the Electron window
 */
export async function enableGuestMode(window: Page): Promise<void> {
  // Wait for DOM to be ready before evaluating
  await window.waitForLoadState('domcontentloaded', { timeout: 60000 });

  // Suppress PermissionOnboardingDialog — it auto-opens on fresh profiles and blocks clicks.
  // Also verify that preload-level guest mode is active (canary assertion).
  const guestModeActive = await window.evaluate(() => {
    localStorage.setItem('permission-onboarding-shown', 'true');
    return sessionStorage.getItem('guestMode') === 'true';
  });

  if (!guestModeActive) {
    // Preload-level guest mode failed to activate. Fall back to manual injection
    // and log a warning so CI diagnostics catch it.
    console.warn('[E2E] WARNING: Preload guest mode not active — falling back to manual injection. Check REBEL_TEST_MODE=1 flag propagation.');
    await window.evaluate(() => {
      sessionStorage.setItem('guestMode', 'true');
      window.dispatchEvent(new Event('guestModeChange'));
    });
  }
}

/**
 * Simulate authenticated state to bypass AuthGate without enabling guest mode.
 * 
 * This is needed for testing flows that require authenticated (non-guest) users,
 * such as the init-from-config onboarding step which is hidden in guest mode.
 * 
 * Uses the same IPC channel that the real auth service uses to broadcast state
 * changes, sent via electronApp.evaluate() from the main process context.
 * 
 * Includes retry mechanism to handle useEffect listener attachment race.
 * 
 * @param electronApp - Playwright ElectronApplication handle
 * @param window - Playwright Page object for the Electron window
 * @param options - Optional user details for the simulated auth state
 */
export async function enableSimulatedAuth(
  electronApp: ElectronApplication,
  window: Page,
  options?: { email?: string; userName?: string; userId?: string }
): Promise<void> {
  const authState = {
    isAuthenticated: true,
    user: {
      id: options?.userId ?? 'test-user-id',
      name: options?.userName ?? 'Test User',
      email: options?.email ?? '[external-email]',
      image: null,
    },
    isLoading: false,
  };

  const hasE2EBridge = await window.evaluate(() => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const api = (window as any).e2eApi;
    return typeof api?.getReadiness === 'function';
  });

  if (hasE2EBridge) {
    await window.waitForFunction(
      () => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const api = (window as any).e2eApi;
        const snapshot = api?.getReadiness?.();
        return snapshot?.phase && snapshot.phase !== 'booting';
      },
      undefined,
      { timeout: 30000 }
    );
  }

  // Wait for React to mount (either login screen or app shell)
  await window.waitForSelector(
    '[data-testid="login-screen-overlay"], .app-wrapper',
    { timeout: 30000 }
  );

  // Retry mechanism for useEffect listener race (increased timing for CI)
  const MAX_ATTEMPTS = 10;
  const DELAY_MS = 500;

  console.log('[E2E] Simulating authenticated state...');

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    // Send auth:state-changed IPC from main process context
    await electronApp.evaluate(({ BrowserWindow }, state) => {
      for (const win of BrowserWindow.getAllWindows()) {
        if (!win.isDestroyed()) {
          win.webContents.send('auth:state-changed', state);
        }
      }
    }, authState);

    await window.waitForTimeout(DELAY_MS);

    // Check if login screen is hidden (errors mean "not yet succeeded")
    try {
      if (hasE2EBridge) {
        const phase = await window.evaluate(() => {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const api = (window as any).e2eApi;
          return api?.getReadiness?.()?.phase ?? null;
        });

        if (phase && phase !== 'booting' && phase !== 'login') {
          console.log(`[E2E] Auth simulation succeeded after ${attempt + 1} attempt(s) (phase=${phase})`);
          break;
        }
      } else {
        const loginVisible = await window.locator('[data-testid="login-screen-overlay"]').isVisible();
        if (!loginVisible) {
          console.log(`[E2E] Auth simulation succeeded after ${attempt + 1} attempt(s)`);
          break;
        }
      }
    } catch {
      // Transient error - continue retrying
    }
  }

  // HARD FAIL if auth simulation didn't work (don't swallow errors)
  if (hasE2EBridge) {
    await window.waitForFunction(
      () => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const api = (window as any).e2eApi;
        const phase = api?.getReadiness?.()?.phase;
        return phase && phase !== 'login';
      },
      undefined,
      { timeout: 5000 }
    );
  } else {
    await window.waitForSelector('[data-testid="login-screen-overlay"]', {
      state: 'hidden',
      timeout: 5000
    });
  }
}

/**
 * Pre-seed minimal settings to skip onboarding.
 * Must be called BEFORE launching the app.
 * 
 * Use this for tests that don't need to test the onboarding flow itself.
 * 
 * @param isolatedPath - Path to the isolated userData directory
 * @param options - Optional API key seeding options
 */
export function writeMinimalSettings(
  isolatedPath: string,
  options: WriteMinimalSettingsOptions = {}
): void {
  if (isRealUserDataPath(isolatedPath)) {
    throw new Error(
      `SAFETY ABORT: Refusing to write settings into real userData path: ${isolatedPath}`
    );
  }

  const settingsPath = path.join(isolatedPath, 'app-settings.json');
  let existing: unknown = {};

  if (fs.existsSync(settingsPath)) {
    try {
      existing = JSON.parse(fs.readFileSync(settingsPath, 'utf-8')) as unknown;
    } catch {
      existing = {};
    }
  }

  const existingObj =
    typeof existing === 'object' && existing !== null
      ? (existing as Record<string, unknown>)
      : ({} as Record<string, unknown>);

  const now = Date.now();
  
  // Create a workspace directory within the isolated path for tests that need one
  const workspaceDir = path.join(isolatedPath, 'test-workspace');
  if (!fs.existsSync(workspaceDir)) {
    fs.mkdirSync(workspaceDir, { recursive: true });
  }

  // Build claude settings if API key is provided
  // Include complete defaults to avoid partial object issues - normalizeSettings uses
  // shallow fallback (settings.claude ?? defaults) so partial objects can break agent execution.
  // Reference: src/shared/utils/settingsUtils.ts line ~65
  const CLAUDE_DEFAULTS = {
    apiKey: null,
    oauthToken: null,
    authMethod: 'api-key',
    // Keep in sync with PREFERRED_PLANNING_MODEL from src/shared/utils/modelNormalization.ts
    model: 'claude-opus-4-8',
    permissionMode: 'bypassPermissions',
    executablePath: null,
    planMode: false,
    extendedContext: true,
    thinkingEffort: 'high'
  };
  const claudeSettings = options.claudeApiKey
    ? {
        ...CLAUDE_DEFAULTS,
        ...(existingObj.claude as Record<string, unknown> ?? {}),
        apiKey: options.claudeApiKey,
        authMethod: 'api-key',
      }
    : existingObj.claude;

  // Build voice settings if any voice keys are provided
  // Include complete defaults to avoid partial object issues
  const VOICE_DEFAULTS = {
    provider: 'openai-whisper',
    openaiApiKey: null,
    elevenlabsApiKey: null,
    model: 'gpt-4o-mini-transcribe-2025-12-15',
    ttsVoice: 'nova',
    activationHotkey: 'CommandOrControl+Shift+;',
    activationHotkeyVoiceMode: true
  };
  const hasVoiceKeys = options.openaiApiKey || options.elevenlabsApiKey;
  const voiceSettings = hasVoiceKeys
    ? {
        ...VOICE_DEFAULTS,
        ...(existingObj.voice as Record<string, unknown> ?? {}),
        provider: options.voiceProvider ?? (options.openaiApiKey ? 'openai-whisper' : 'elevenlabs-scribe'),
        openaiApiKey: options.openaiApiKey ?? null,
        elevenlabsApiKey: options.elevenlabsApiKey ?? null,
      }
    : existingObj.voice;
  
  const settings = {
    ...existingObj,
    onboardingCompleted: true,
    onboardingFirstCompletedAt:
      typeof existingObj.onboardingFirstCompletedAt === 'number'
        ? existingObj.onboardingFirstCompletedAt
        : now,
    onboardingChecklist: existingObj.onboardingChecklist ?? { step: 1 },
    // Set coreDirectory so agent runs don't fail with "Core directory is not configured"
    coreDirectory: existingObj.coreDirectory ?? workspaceDir,
    // Disable semantic indexing to prevent embedding model initialization crashes
    // E2E isolated userData has no cached models, causing GPU worker "Failed to fetch" errors
    // that cascade into app crashes ~12s after launch. See: docs/plans/finished/260127_e2e_embedding_crash_fix.md
    indexingEnabled: false,
    // Disable background memory update turns that interfere with test isolation.
    // Memory turns are fire-and-forget (invisible to resetAppState) and can cause
    // app crashes or state interference between tests. See WHY_E2E entry #23.
    memoryUpdateEnabled: false,
    // Pre-dismiss announcement banners that use position:fixed and block header clicks.
    // Without this, fixed overlays (z-index 9998) intercept pointer events on buttons
    // like new-chat-button. See WHY_E2E entry #25.
    dismissedAnnouncements: {
      ...(existingObj.dismissedAnnouncements as Record<string, boolean> ?? {}),
    },
    // Add claude and voice settings if provided
    ...(claudeSettings && { claude: claudeSettings }),
    ...(voiceSettings && { voice: voiceSettings }),
    experimental: {
      ...(existingObj.experimental as Record<string, unknown> ?? {}),
    },
  };
  fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2));

  // Log what was seeded
  const claudeSeeded = options.claudeApiKey ? 'yes' : 'no';
  const voiceSeeded = hasVoiceKeys ? 'yes' : 'no';
  console.log(`[E2E] Seeded settings: claude=${claudeSeeded}, voice=${voiceSeeded}, indexing=disabled`);
  console.log(`[E2E] Wrote minimal settings to: ${settingsPath}`);
}

/**
 * Wait for Super-MCP to be ready (router.isRunning = true).
 * 
 * Super-MCP startup is deferred during first-run onboarding. After onboarding
 * completes, there's a 30-second timeout that shows a StartupRecoveryDialog
 * if Super-MCP hasn't started. This function polls until Super-MCP is ready,
 * preventing tests from being blocked by that dialog.
 * 
 * IMPORTANT: After confirming Super-MCP is ready via IPC, this function also
 * dismisses any StartupRecoveryDialog that may have appeared due to timing.
 * The dialog can appear if the renderer's React state wasn't updated before
 * the 30s timeout fired, even though Super-MCP was actually running.
 * 
 * @param window - Playwright Page object for the Electron window
 * @param timeoutMs - Maximum time to wait (default: 60s for slow CI)
 */
export async function waitForSuperMcpReady(window: Page, timeoutMs = 60000): Promise<void> {
  const pollIntervalMs = 1000;
  const startTime = Date.now();
  
  console.log(`[E2E] Waiting for Super-MCP to be ready (timeout: ${timeoutMs}ms)...`);
  
  while (Date.now() - startTime < timeoutMs) {
    const isRunning = await window.evaluate(async () => {
      try {
        // @ts-expect-error - settingsApi is exposed via preload
        const summary = await window.settingsApi.mcpSummary({ skipMetadata: true });
        return summary?.router?.isRunning ?? false;
      } catch {
        return false;
      }
    });
    
    if (isRunning) {
      const elapsedMs = Date.now() - startTime;
      console.log(`[E2E] Super-MCP is ready (took ${elapsedMs}ms)`);
      
      // Dismiss StartupRecoveryDialog if it appeared due to timing race.
      // The dialog shows after 30s if the renderer's mcpSummary state wasn't
      // updated in time, even though Super-MCP is actually running.
      await dismissStartupRecoveryDialogIfPresent(window);
      
      return;
    }
    
    await window.waitForTimeout(pollIntervalMs);
  }
  
  // Timeout reached - log warning but don't fail
  // The test may still work if Super-MCP starts soon after
  console.warn(`[E2E] Super-MCP not ready after ${timeoutMs}ms, continuing anyway...`);
}

/**
 * Wait for MCP tools to be available (at least one tool registered).
 * 
 * Use this after waitForSuperMcpReady() when tests need to use MCP tools.
 * Super-MCP may be running (router.isRunning = true) but tools may not be
 * fully loaded yet due to async initialization.
 * 
 * @param window - Playwright Page object for the Electron window
 * @param timeoutMs - Maximum time to wait (default: 30s)
 * @param minToolCount - Minimum number of tools to wait for (default: 1)
 */
export async function waitForMcpToolsAvailable(
  window: Page,
  timeoutMs = 30000,
  minToolCount = 1
): Promise<void> {
  const pollIntervalMs = 1000;
  const startTime = Date.now();
  
  console.log(`[E2E] Waiting for MCP tools to be available (min: ${minToolCount}, timeout: ${timeoutMs}ms)...`);
  
  let lastStatus = '';
  
  while (Date.now() - startTime < timeoutMs) {
    const result = await window.evaluate(async () => {
      try {
        // @ts-expect-error - settingsApi is exposed via preload
        const summary = await window.settingsApi.mcpSummary({ skipMetadata: false });
        
        const isRunning = summary?.router?.isRunning ?? false;
        const serverCount = summary?.router?.upstreamServers?.length ?? 0;
        const serverNames = summary?.router?.upstreamServers?.map(
          (s: { name?: string }) => s.name
        ) ?? [];
        
        // Router must be running before we count tools
        if (!isRunning) {
          return { toolCount: 0, status: 'router not running' };
        }
        
        // Sum toolCount from all upstream servers (handle null/undefined)
        const total = summary.router.upstreamServers?.reduce(
          (acc: number, server: { toolCount?: number | null }) => 
            acc + (server.toolCount || 0),
          0
        ) ?? 0;
        
        return { 
          toolCount: total, 
          status: `${serverCount} servers (${serverNames.join(', ')}), ${total} tools`
        };
      } catch (e) {
        return { toolCount: 0, status: `error: ${e}` };
      }
    });
    
    // Log status changes to help debug
    if (result.status !== lastStatus) {
      console.log(`[E2E] MCP status: ${result.status}`);
      lastStatus = result.status;
    }
    
    if (result.toolCount >= minToolCount) {
      const elapsedMs = Date.now() - startTime;
      console.log(`[E2E] MCP tools available: ${result.toolCount} tools (took ${elapsedMs}ms)`);
      return;
    }
    
    await window.waitForTimeout(pollIntervalMs);
  }
  
  // Timeout reached - log final status for debugging
  console.log(`[E2E] MCP tools timeout - final status: ${lastStatus}`);
  throw new Error(`MCP tools not available after ${timeoutMs}ms (${lastStatus})`);
}

/**
 * Wait for the main app shell to be fully ready after onboarding completes.
 * 
 * This function uses a progressive retry approach to handle initialization race conditions:
 * - Settings load asynchronously via IPC, causing `shouldRenderMainApp` to be initially false
 * - There's a 100ms artificial delay in the React state transition
 * - CI environments can have variable performance causing timing issues
 * 
 * The function polls for app readiness indicators with diagnostic logging on failure.
 * 
 * @param window - Playwright Page object for the Electron window
 * @param timeoutMs - Maximum time to wait (default: 60s for CI resilience)
 */
export async function waitForMainAppReady(window: Page, timeoutMs = 60000): Promise<void> {
  const startTime = Date.now();
  console.log('[E2E] [timing] waitForMainAppReady: starting...');

  // Reduce flakiness from animations/transitions affecting Playwright actionability.
  // Kept test-side to avoid production/test divergence.
  await window
    .evaluate(() => {
      const existing = document.getElementById('e2e-disable-animations');
      if (existing) return;

      const style = document.createElement('style');
      style.id = 'e2e-disable-animations';
      style.textContent = `
        *, *::before, *::after {
          transition: none !important;
          animation: none !important;
          scroll-behavior: auto !important;
        }
      `;
      document.head.appendChild(style);
    })
    .catch(() => {
      // Best-effort only.
    });

  // Stage 3: Prefer deterministic readiness bridge when available.
  const hasE2EBridge = await window.evaluate(() => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const api = (window as any).e2eApi;
    return typeof api?.getReadiness === 'function';
  });

  if (hasE2EBridge) {
    const startTime = Date.now();
    const checkInterval = 500;

    console.log('[E2E] Using e2e readiness bridge (window.e2eApi.getReadiness)');

    while (Date.now() - startTime < timeoutMs) {
      const readiness = await window.evaluate(() => {
        try {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const api = (window as any).e2eApi;
          return api?.getReadiness?.() ?? null;
        } catch {
          return null;
        }
      });

      if (readiness?.startupRecoveryDialogVisible) {
        await dismissStartupRecoveryDialogIfPresent(window);
      }

      if (readiness?.appReady) {
        const elapsed = Date.now() - startTime;
        console.log(
          `[E2E] [timing] waitForMainAppReady: complete in ${elapsed}ms (e2eApi, phase=${readiness.phase})`
        );
        return;
      }

      const elapsed = Date.now() - startTime;
      if (elapsed > 0 && elapsed % 5000 < checkInterval) {
        console.log(
          `[E2E] Still waiting (${Math.round(elapsed / 1000)}s): ` +
            `phase=${readiness?.phase ?? 'unknown'}, ` +
            `blockingReason=${readiness?.blockingReason ?? 'unknown'}, ` +
            `startupRecoveryDialogVisible=${readiness?.startupRecoveryDialogVisible ?? 'unknown'}`
        );
      }

      await window.waitForTimeout(checkInterval);
    }

    const finalReadiness = await window.evaluate(() => {
      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const api = (window as any).e2eApi;
        return api?.getReadiness?.() ?? null;
      } catch {
        return null;
      }
    });

    console.error('[E2E] TIMEOUT: App failed to become ready (e2e readiness bridge)');
    console.error('[E2E] Final readiness:', JSON.stringify(finalReadiness, null, 2));

    throw new Error(
      `App not ready after ${timeoutMs}ms (e2e readiness bridge). ` +
        `phase=${finalReadiness?.phase ?? 'unknown'}, ` +
        `blockingReason=${finalReadiness?.blockingReason ?? 'unknown'}, ` +
        `startupRecoveryDialogVisible=${finalReadiness?.startupRecoveryDialogVisible ?? 'unknown'}`
    );
  }

  // Legacy fallback (DOM heuristic polling) when bridge isn't present.
  const legacyStartTime = Date.now();
  const checkInterval = 500;

  // Progressive wait with diagnostics
  while (Date.now() - legacyStartTime < timeoutMs) {
    const state = await window.evaluate(() => {
      const startupRecoveryDialogByTestId = !!document.querySelector(
        '[data-testid="startup-recovery-dialog"]'
      );

      // Check for StartupRecoveryDialog by looking for its distinctive h2 titles
      // This is more reliable than checking for generic dialog elements
      const h2Elements = Array.from(document.querySelectorAll('h2'));
      const hasStartupRecoveryDialog =
        startupRecoveryDialogByTestId ||
        h2Elements.some((h2) =>
          h2.textContent?.includes('Startup is taking longer') ||
          h2.textContent?.includes('Tools failed to start')
        );

      return {
        hasAppWrapper: !!document.querySelector('.app-wrapper'),
        hasAppWrapperVisible: !!document.querySelector('.app-wrapper.visible'),
        hasAppShell: !!document.querySelector('.app-shell.visible'),
        hasBrandHome: !!document.querySelector('[data-testid="brand-home"]'),
        hasLoginScreen: !!document.querySelector('[data-testid="login-screen-content"]'),
        hasLoginOverlay: !!document.querySelector('[data-testid="login-screen-overlay"]'),
        hasOnboardingWizard: !!document.querySelector('[data-testid="onboarding-wizard"], .onboarding-wizard'),
        hasOnboardingWelcomeContent: !!document.querySelector('[data-testid="onboarding-welcome-content"]'),
        hasLoadingSplash: !!document.querySelector('.app-loading-splash'),
        hasStartupRecoveryDialog,
        rootClasses: document.documentElement.className,
      };
    });

    // Dismiss StartupRecoveryDialog if it appeared (blocks all UI interaction)
    // This dialog shows after 30s if Super-MCP isn't detected; we need to dismiss it
    // to proceed with tests. Only call the helper when dialog is detected to avoid
    // the 500ms isVisible timeout overhead on every iteration.
    if (state.hasStartupRecoveryDialog) {
      await dismissStartupRecoveryDialogIfPresent(window);
      // After dismissing, continue the loop to re-check state
      continue;
    }

    // Success: app wrapper visible AND main UI loaded
    if (state.hasAppWrapperVisible && (state.hasBrandHome || state.hasAppShell)) {
      const elapsed = Date.now() - startTime;
      console.log(`[E2E] [timing] waitForMainAppReady: complete in ${elapsed}ms (legacy DOM polling)`);
      return;
    }

    // Log progress every 5 seconds
    const elapsed = Date.now() - legacyStartTime;
    if (elapsed > 0 && elapsed % 5000 < checkInterval) {
      console.log(
        `[E2E] Still waiting (${Math.round(elapsed / 1000)}s): ` +
          `wrapper=${state.hasAppWrapper}, visible=${state.hasAppWrapperVisible}, ` +
          `shell=${state.hasAppShell}, home=${state.hasBrandHome}, ` +
          `login=${state.hasLoginScreen}, loginOverlay=${state.hasLoginOverlay}, ` +
          `onboarding=${state.hasOnboardingWizard}, onboardingWelcome=${state.hasOnboardingWelcomeContent}, ` +
          `loading=${state.hasLoadingSplash}, recoveryDialog=${state.hasStartupRecoveryDialog}`
      );
    }

    await window.waitForTimeout(checkInterval);
  }

  // Timeout - capture diagnostic info
  const finalState = await window.evaluate(() => {
    const body = document.body;

    const ariaModalDialogs = Array.from(
      document.querySelectorAll('[role="dialog"][aria-modal], [role="dialog"][aria-modal="true"]')
    );

    const dialogDebug = ariaModalDialogs
      .slice(0, 2)
      .map((el) => (el as HTMLElement).outerHTML?.slice(0, 500) ?? '')
      .filter(Boolean);

    const bodyTextPreview = (document.body?.innerText ?? '').replace(/\s+/g, ' ').slice(0, 500);

    const startupRecoveryDialogByTestId = !!document.querySelector(
      '[data-testid="startup-recovery-dialog"]'
    );

    // Check for StartupRecoveryDialog in final state too
    const h2Elements = Array.from(document.querySelectorAll('h2'));
    const hasStartupRecoveryDialog =
      startupRecoveryDialogByTestId ||
      h2Elements.some((h2) =>
        h2.textContent?.includes('Startup is taking longer') ||
        h2.textContent?.includes('Tools failed to start')
      );

    return {
      hasAppWrapper: !!document.querySelector('.app-wrapper'),
      hasAppWrapperVisible: !!document.querySelector('.app-wrapper.visible'),
      hasAppShell: !!document.querySelector('.app-shell.visible'),
      hasBrandHome: !!document.querySelector('[data-testid="brand-home"]'),
      hasLoginScreen: !!document.querySelector('[data-testid="login-screen-content"]'),
      hasLoginOverlay: !!document.querySelector('[data-testid="login-screen-overlay"]'),
      hasOnboardingWizard: !!document.querySelector('[data-testid="onboarding-wizard"], .onboarding-wizard'),
      hasOnboardingWelcomeContent: !!document.querySelector('[data-testid="onboarding-welcome-content"]'),
      hasLoadingSplash: !!document.querySelector('.app-loading-splash'),
      hasStartupRecoveryDialog,
      ariaModalDialogCount: ariaModalDialogs.length,
      dialogDebug,
      bodyTextPreview,
      bodyHtml: body?.innerHTML?.slice(0, 500) || 'empty',
    };
  });

  console.error('[E2E] TIMEOUT: App failed to become ready');
  console.error('[E2E] Final state:', JSON.stringify(finalState, null, 2));

  throw new Error(
    `App not ready after ${timeoutMs}ms. ` +
      `State: wrapper=${finalState.hasAppWrapper}, visible=${finalState.hasAppWrapperVisible}, ` +
      `shell=${finalState.hasAppShell}, home=${finalState.hasBrandHome}, ` +
      `login=${finalState.hasLoginScreen}, loginOverlay=${finalState.hasLoginOverlay}, ` +
      `onboarding=${finalState.hasOnboardingWizard}, onboardingWelcome=${finalState.hasOnboardingWelcomeContent}, ` +
      `loading=${finalState.hasLoadingSplash}, recoveryDialog=${finalState.hasStartupRecoveryDialog}`
  );
}

/**
 * Dismiss the StartupRecoveryDialog if it's visible.
 * 
 * This dialog appears after 30s if the renderer believes Super-MCP isn't running.
 * Due to a race condition between direct IPC checks and React state updates,
 * the dialog can appear even when Super-MCP is actually running.
 * 
 * The dialog has two buttons: "Continue Waiting" and "Start in Safe Mode".
 * We click "Continue Waiting" to dismiss it without entering Safe Mode.
 * 
 * This function is exported so tests can call it at strategic points during
 * long-running operations (like multi-turn conversations) where the dialog
 * might appear mid-test.
 * 
 * @param window - Playwright Page object for the Electron window
 */
export async function dismissStartupRecoveryDialogIfPresent(window: Page): Promise<void> {
  try {
    const dialogByTestId = window.locator('[data-testid="startup-recovery-dialog"]');
    const testIdVisible = await dialogByTestId.isVisible({ timeout: 250 }).catch(() => false);

    if (testIdVisible) {
      console.log('[E2E] StartupRecoveryDialog detected (testid), dismissing...');
      const dismissButton = dialogByTestId.locator('button:has-text("Continue Waiting"), button:has-text("Dismiss")');
      await dismissButton.click({ timeout: 2000 });
      // Wait for dialog to close
      await expect(dialogByTestId).not.toBeVisible({ timeout: 5000 });
      console.log('[E2E] StartupRecoveryDialog dismissed');
      return;
    }

    // Look for the dialog by its distinctive content
    const dialogTitle = window.locator('h2:has-text("Startup is taking longer than expected"), h2:has-text("Tools failed to start")');
    const isVisible = await dialogTitle.isVisible({ timeout: 500 }).catch(() => false);
    
    if (isVisible) {
      console.log('[E2E] StartupRecoveryDialog detected, dismissing...');
      // Click "Continue Waiting" or "Dismiss" to close the dialog
      const dismissButton = window.locator('button:has-text("Continue Waiting"), button:has-text("Dismiss")');
      await dismissButton.click({ timeout: 2000 });
      // Wait for dialog to close
      await expect(dialogTitle).not.toBeVisible({ timeout: 5000 });
      console.log('[E2E] StartupRecoveryDialog dismissed');
    }
  } catch {
    // Dialog not present or couldn't be dismissed - that's fine
  }
}

/**
 * Create a test space folder and verify it's accessible with retries.
 * 
 * This is critical for Windows CI where there can be timing issues between
 * creating a folder and it being accessible (due to AV scanning, filesystem
 * sync delays, etc.).
 * 
 * @param _app - ElectronApplication instance (unused but kept for API consistency)
 * @param basePath - Base directory for test spaces (e.g., TEST_SPACE_BASE)
 * @returns The path to the created and verified space folder
 */
export async function createVerifiedTestSpaceFolder(
  _app: ElectronApplication,
  basePath: string
): Promise<string> {
  const spaceFolder = path.join(basePath, `test-space-${Date.now()}`);
  fs.mkdirSync(spaceFolder, { recursive: true });
  
  // Verify folder is accessible with retries (critical on Windows)
  // Windows CI can have delays due to AV scanning, filesystem sync, etc.
  const maxAttempts = 10;
  const delayMs = 100;
  
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      fs.accessSync(spaceFolder, fs.constants.R_OK | fs.constants.W_OK);
      console.log(`[E2E] Created and verified test space folder (attempt ${attempt}): ${spaceFolder}`);
      return spaceFolder;
    } catch {
      if (attempt === maxAttempts) {
        throw new Error(`[E2E] Space folder not accessible after ${maxAttempts} attempts: ${spaceFolder}`);
      }
      await new Promise(resolve => setTimeout(resolve, delayMs));
    }
  }
  
  // TypeScript requires this but it's unreachable
  return spaceFolder;
}

// ============================================================================
// Fake Microphone Testing Infrastructure
// Uses Chromium flags to simulate microphone input for voice recording tests.
// ============================================================================

export interface FakeMicrophoneLaunchOptions extends LaunchOptions {
  /** Path to a .wav audio file to use as fake microphone input */
  audioFilePath?: string;
}

/**
 * Launch Electron app with fake microphone support for voice recording tests.
 * 
 * Uses Chromium flags:
 * - --use-fake-device-for-media-stream: Enables fake media devices
 * - --use-fake-ui-for-media-stream: Auto-grants microphone permission
 * - --use-file-for-fake-audio-capture: Uses specified audio file as mic input
 * 
 * @param testName - Test name for directory naming
 * @param options - Launch options including optional audio file path
 * @returns Object with electronApp, cleanup function, and userDataPath
 */
export async function launchWithFakeMicrophone(
  testName: string,
  options: FakeMicrophoneLaunchOptions = {}
): Promise<{ electronApp: ElectronApplication; cleanup: () => void; userDataPath: string }> {
  const { audioFilePath, ...launchOptions } = options;
  
  const chromiumArgs = [
    '--use-fake-device-for-media-stream',
    '--use-fake-ui-for-media-stream',
  ];
  
  if (audioFilePath) {
    // Verify file exists
    if (!fs.existsSync(audioFilePath)) {
      throw new Error(`[E2E] Audio file not found for fake microphone: ${audioFilePath}`);
    }
    chromiumArgs.push(`--use-file-for-fake-audio-capture=${audioFilePath}`);
  }
  
  return launchIsolatedApp(testName, {
    ...launchOptions,
    additionalArgs: [...(launchOptions.additionalArgs ?? []), ...chromiumArgs]
  });
}

// ============================================================================
// Sequenced Test Suite Infrastructure
// See: docs/plans/finished/260122_e2e_test_consolidation.md
// ============================================================================

/**
 * Reset app state between tests in a sequenced suite.
 * 
 * This function prepares the app for the next test without restarting:
 * 1. Dismisses any blocking dialogs (StartupRecoveryDialog)
 * 2. Closes any open modals via Escape
 * 3. Ensures agent is idle (stops any active turn)
 * 4. Clears sidebar search if visible
 * 5. Starts a fresh chat
 * 
 * @param window - Playwright Page object for the Electron window
 * @param testName - Name of the test (for logging)
 */
export async function resetAppState(window: Page, testName: string): Promise<void> {
  const startTime = Date.now();
  console.log(`[E2E] [reset] [${testName}] Starting app state reset`);
  
  // 0. Dismiss fixed-position announcement banners
  // These use position:fixed; top:0; z-index:9998 and block clicks on header buttons.
  const dismissBannerBtn = window.locator('button[aria-label="Dismiss banner"]');
  if (await dismissBannerBtn.isVisible({ timeout: 500 }).catch(() => false)) {
    await dismissBannerBtn.click();
    await dismissBannerBtn.waitFor({ state: 'hidden', timeout: 2000 }).catch(() => {});
    console.log(`[E2E] [reset] [${testName}] Dismissed announcement banner`);
  }

  // 1. Dismiss any blocking dialogs
  console.log(`[E2E] [reset] [${testName}] Step 1: Dismissing dialogs`);
  await dismissStartupRecoveryDialogIfPresent(window);
  
  // 2. Close any open modals (Settings, Scratchpad, etc)
  console.log(`[E2E] [reset] [${testName}] Step 2: Closing modals (Escape)`);
  await window.keyboard.press('Escape');
  await window.waitForTimeout(100);
  
  // 3. Ensure agent is idle (no active turn)
  // Note: The stop button can be visible but disabled when isStopping=true (stop already requested).
  // We must handle both states: enabled (can click) and disabled (just wait for idle).
  console.log(`[E2E] [reset] [${testName}] Step 3: Checking agent idle state`);
  const stopButton = window.locator('[data-testid="stop-turn-button"]');
  const enabledStopButton = window.locator('[data-testid="stop-turn-button"]:not([disabled])');
  
  if (await stopButton.isVisible({ timeout: 1000 }).catch(() => false)) {
    // Check if button is enabled (clickable) or disabled (already stopping)
    // Short timeout (500ms) for visibility check - just need to detect current state
    if (await enabledStopButton.isVisible({ timeout: 500 }).catch(() => false)) {
      console.log(`[E2E] [reset] [${testName}] Agent active - stopping turn`);
      // Longer timeout (1000ms) for click - gives Playwright time to retry if element is momentarily unstable
      await enabledStopButton.click({ timeout: 1000 }).catch((err) => {
        // Button may have become disabled between check and click - that's OK, we'll wait for idle below
        console.log(`[E2E] [reset] [${testName}] Stop button click failed (likely became disabled): ${err.message}`);
      });
    } else {
      console.log(`[E2E] [reset] [${testName}] Stop button disabled (already stopping), waiting for idle`);
    }
    // Always wait for the button to disappear (agent becomes idle)
    await expect(stopButton).not.toBeVisible({ timeout: 30_000 });
    console.log(`[E2E] [reset] [${testName}] Agent now idle`);
  }
  
  // 4. Clear sidebar search if visible
  console.log(`[E2E] [reset] [${testName}] Step 4: Clearing sidebar search`);
  const searchInput = window.locator('[data-testid="session-search-input"]');
  if (await searchInput.isVisible({ timeout: 1000 }).catch(() => false)) {
    await searchInput.clear();
  }
  
  // 5. Start fresh chat
  console.log(`[E2E] [reset] [${testName}] Step 5: Starting new chat`);
  const newChatButton = window.locator('[data-testid="new-chat-button"]');
  if (await newChatButton.isVisible({ timeout: 1000 }).catch(() => false)) {
    await newChatButton.click();
  }
  
  // 6. Ensure navigation tabs are visible (FlowPanelsShell mounted)
  console.log(`[E2E] [reset] [${testName}] Step 6: Verifying nav tabs visible`);
  const navTab = window.locator('[id^="flow-tab-"]').first();
  await expect(navTab).toBeVisible({ timeout: 10000 });
  
  const elapsed = Date.now() - startTime;
  console.log(`[E2E] [reset] [${testName}] Complete in ${elapsed}ms`);
}

// ============================================================================
// Shared Test Utilities (Stage 2.1)
// Extracted from sequence-b.spec.ts and sequence-c.spec.ts
// See: docs/plans/partway/260126_e2e_test_architecture_overhaul.md
// ============================================================================

/**
 * Switch from voice to text input mode.
 * 
 * Checks if the "Switch to text mode" button is visible and clicks it if so.
 * Then waits for the text input to appear.
 * 
 * @param window - Playwright Page object for the Electron window
 */
export async function switchToTextMode(window: Page): Promise<void> {
  const textModeButton = window.locator('button[aria-label="Switch to text mode"]');
  const isVisible = await textModeButton.isVisible().catch(() => false);
  if (isVisible) {
    await textModeButton.click();
  }
  await expect(window.locator('[data-testid="composer-input"]')).toBeVisible({
    timeout: 5000
  });
}

/**
 * Read the composer input's current text, handling both the legacy <textarea>
 * (uses `value`) and the TipTap contentEditable div (uses `textContent`).
 *
 * When the `composer.tiptap` feature flag is on, `[data-testid="composer-input"]`
 * resolves to a contentEditable `<div>`, so Playwright's `inputValue()` throws
 * "Node is not an <input>, <textarea> or <select> element".
 *
 * For TipTap, the visible `textContent` only shows rendered chip labels, not the
 * underlying markdown (e.g. mention links). Use `{ raw: true }` when you need the
 * raw markdown value that the parent component's state holds (e.g. to match
 * `@[name](rebel://...)` mention syntax).
 */
export async function getComposerText(
  window: Page,
  options?: { raw?: boolean },
): Promise<string> {
  const composer = window.locator('[data-testid="composer-input"]');
  const tagName = await composer.evaluate(el => el.tagName.toLowerCase());

  if (tagName === 'textarea' || tagName === 'input') {
    return composer.inputValue();
  }

  if (options?.raw) {
    // The TipTap editor root has data-testid="composer-input-root". The editor
    // instance is accessible via the ProseMirror view on the contentEditable div.
    // However, the simplest reliable path is reading from the React state: the
    // parent `AgentComposer` passes `textPrompt` as the `value` prop and reads
    // markdown back via `onChange`. The commandInputRef shim exposes a JS `value`
    // getter. We can reach it through the DOM's __reactFiber$ internals, but
    // that's brittle. Instead, we look for the serialised markdown that the
    // TipTap `@tiptap/markdown` extension caches on each transaction.
    return composer.evaluate((el) => {
      // ProseMirror view is accessible on the contentEditable element
      const pmView = (el as unknown as { pmViewDesc?: { view?: { state?: {
        doc?: { textBetween?: (from: number, to: number, blockSeparator: string) => string;
          content?: { size?: number } };
      } } } }).pmViewDesc?.view;
      if (pmView?.state?.doc) {
        const doc = pmView.state.doc;
        const size = doc.content?.size ?? 0;
        if (size > 0 && doc.textBetween) {
          return doc.textBetween(0, size, '\n');
        }
      }
      // Fallback to textContent
      return (el.textContent ?? '').replace(/\n$/, '');
    });
  }

  // TipTap contentEditable — textContent gives us the visible text.
  // Trim trailing newlines that ProseMirror paragraph nodes produce.
  const text = await composer.textContent() ?? '';
  return text.replace(/\n$/, '');
}

/**
 * Assert the composer input's text content, handling both the legacy <textarea>
 * (uses `value`) and the TipTap contentEditable div (uses `textContent`).
 *
 * When the `composer.tiptap` feature flag is on, `[data-testid="composer-input"]`
 * resolves to a contentEditable `<div>`, so Playwright's `toHaveValue()` throws
 * "Not an input element". This helper detects the element type at runtime and
 * picks the right assertion strategy.
 */
export async function expectComposerText(
  window: Page,
  expected: string,
  options?: { timeout?: number },
): Promise<void> {
  const composer = window.locator('[data-testid="composer-input"]');
  const timeout = options?.timeout ?? 5000;

  const tagName = await composer.evaluate(el => el.tagName.toLowerCase());

  if (tagName === 'textarea' || tagName === 'input') {
    await expect(composer).toHaveValue(expected, { timeout });
  } else if (expected === '') {
    // TipTap renders empty state as an empty <p> or placeholder; textContent
    // may be '' or '\n'. Treat any whitespace-only content as empty.
    await expect(composer).toHaveText(/^\s*$/, { timeout });
  } else {
    await expect(composer).toHaveText(expected, { timeout });
  }
}

/**
 * Send a message and wait for the assistant's response.
 * 
 * CRITICAL: This function includes the Pattern 3 fix - it waits for the stop button
 * to disappear before reading the response text. This ensures streaming is complete
 * and the response text is stable.
 * 
 * @param window - Playwright Page object for the Electron window
 * @param message - The message to send
 * @param timeoutMs - Maximum time to wait for response (default: 150s)
 * @returns The response text from the assistant
 */
export async function sendMessageAndWaitForResponse(
  window: Page,
  message: string,
  timeoutMs = 150000
): Promise<string> {
  const startTime = Date.now();
  const msgPreview = message.substring(0, 50).replace(/\n/g, ' ');
  
  await dismissStartupRecoveryDialogIfPresent(window);
  await waitForMainAppReady(window);
  await switchToTextMode(window);

  const assistantMessages = window.locator('article.agent-turn-message[data-role="assistant"], article.agent-turn-message[data-role="result"]');
  const assistantCount = await assistantMessages.count();
  // Only read the last message ID if assistant messages exist — getAttribute auto-waits
  // on empty locators, causing a 30s delay in empty conversations.
  const lastMessageIdBefore = assistantCount > 0
    ? await assistantMessages.last().getAttribute('data-message-id').catch(() => null)
    : null;
  
  const totalMessages = await window.locator('article.agent-turn-message').count();
  console.log(`[E2E] [diag] sendMessage: "${msgPreview}..." lastMessageIdBefore=${lastMessageIdBefore}, totalMessages=${totalMessages}`);

  const textInput = window.locator('[data-testid="composer-input"]');
  await textInput.click();
  await textInput.fill(message);

  const sendButton = window.locator('[data-testid="composer-send-button"], [data-testid="send-now-button"]');
  await expect(sendButton).toBeEnabled({ timeout: 10000 });
  await sendButton.click();
  
  console.log(`[E2E] [diag] sendMessage: message sent, waiting for response (timeout=${timeoutMs}ms)`);

  await dismissStartupRecoveryDialogIfPresent(window);
  await waitForMainAppReady(window);

  let newMessage: typeof assistantMessages | null = null;
  
  await expect(async () => {
    // Check for error banner — fail with diagnostic message instead of timing out
    const errorBanner = window.locator('[data-testid="error-banner"]');
    const errorVisible = await errorBanner.isVisible().catch(() => false);
    if (errorVisible) {
      const errorText = await errorBanner.textContent().catch(() => 'unknown error');
      throw new Error(`Agent error detected: ${errorText}`);
    }

    const currentAssistantMessages = window.locator('article.agent-turn-message[data-role="assistant"], article.agent-turn-message[data-role="result"]');
    const count = await currentAssistantMessages.count();
    
    if (count === 0) {
      throw new Error('No assistant messages found yet');
    }
    
    const lastMessage = currentAssistantMessages.last();
    const lastId = await lastMessage.getAttribute('data-message-id');
    
    const isNew = lastId && lastId !== lastMessageIdBefore;
    
    if (isNew) {
      newMessage = lastMessage;
      return;
    }
    
    throw new Error(`Waiting for new message (lastId=${lastId} matches old=${lastMessageIdBefore})`);
  }).toPass({ timeout: timeoutMs, intervals: [500, 1000] });

  if (!newMessage) {
    throw new Error('Failed to find new message despite poll passing');
  }
  
  await expect(newMessage).toBeVisible({ timeout: 10000 });

  const elapsed = Date.now() - startTime;
  console.log(`[E2E] [diag] sendMessage: response received in ${elapsed}ms`);

  // CRITICAL: Pattern 3 fix - Wait for streaming to complete by checking stop button disappears
  // This ensures the response text is stable before we read it.
  // See: docs/plans/partway/260126_e2e_test_architecture_overhaul.md (Stage 4.1, Pattern 3)
  await expect(window.locator('[data-testid="stop-turn-button"]')).not.toBeVisible({ timeout: 30000 });

  const responseText = (await newMessage.textContent()) ?? '';
  return responseText;
}

/**
 * Create a temporary test workspace directory with sample files.
 * 
 * Creates the following structure:
 * - test-file.txt
 * - readme.md
 * - test-folder/nested-file.txt
 * - skills/SKILL.md
 * - skills/memory-helper/SKILL.md
 * - editable-file.txt
 * 
 * @returns Path to the created workspace directory
 */
export async function createTestWorkspace(): Promise<string> {
  const tempDir = path.join(os.tmpdir(), `mindstone-test-${Date.now()}`);
  await fs.promises.mkdir(tempDir, { recursive: true });

  await fs.promises.writeFile(
    path.join(tempDir, 'test-file.txt'),
    'Test content for workspace E2E tests'
  );
  await fs.promises.writeFile(
    path.join(tempDir, 'readme.md'),
    '# Test Project\n\nThis is a test workspace.'
  );

  await fs.promises.mkdir(path.join(tempDir, 'test-folder'), { recursive: true });
  await fs.promises.writeFile(
    path.join(tempDir, 'test-folder', 'nested-file.txt'),
    'Nested file content'
  );

  await fs.promises.mkdir(path.join(tempDir, 'skills'), { recursive: true });
  await fs.promises.writeFile(
    path.join(tempDir, 'skills', 'SKILL.md'),
    '# Test Skill\n\nThis is a test skill.'
  );

  await fs.promises.writeFile(
    path.join(tempDir, 'editable-file.txt'),
    'Original content for editing test.\nThis line should be preserved.'
  );

  const memorySkillDir = path.join(tempDir, 'skills', 'memory-helper');
  await fs.promises.mkdir(memorySkillDir, { recursive: true });
  await fs.promises.writeFile(
    path.join(memorySkillDir, 'SKILL.md'),
    `---
name: Memory Helper
description: A skill related to memory operations
---

# Memory Helper SKILL

This skill helps manage memory and remembering important information.
`
  );

  return tempDir;
}

/**
 * Clean up a test workspace directory.
 * 
 * Only removes directories that contain 'mindstone-test-' or 'mindstone-fileops-'
 * in their path as a safety measure.
 * 
 * @param dir - Path to the workspace directory to clean up
 */
export async function cleanupTestWorkspace(dir: string): Promise<void> {
  if (dir && (dir.includes('mindstone-test-') || dir.includes('mindstone-fileops-'))) {
    await fs.promises.rm(dir, { recursive: true, force: true });
  }
}

/**
 * Write app settings with a workspace (coreDirectory) configured.
 * 
 * This is used for tests that need a workspace configured but don't need
 * to test the full onboarding flow.
 * 
 * @param isolatedPath - Path to the isolated userData directory
 * @param workspacePath - Path to the workspace directory
 */
export function writeWorkspaceSettings(isolatedPath: string, workspacePath: string): void {
  const settingsPath = path.join(isolatedPath, 'app-settings.json');
  const settings = {
    onboardingCompleted: true,
    onboardingFirstCompletedAt: Date.now(),
    onboardingChecklist: { step: 1 },
    coreDirectory: workspacePath
  };
  fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
}

/**
 * Navigate to the Library (workspace) panel.
 * 
 * Dismisses any dialogs, clicks the library tab, and waits for the drawer to appear.
 * 
 * @param window - Playwright Page object for the Electron window
 */
export async function navigateToWorkspace(window: Page): Promise<void> {
  await dismissStartupRecoveryDialogIfPresent(window);
  const workspaceTab = window.locator('#flow-tab-library');
  await expect(workspaceTab).toBeVisible({ timeout: 5000 });
  await workspaceTab.click();
  await expect(window.locator('[data-testid="library-drawer"]')).toBeVisible({ timeout: 5000 });
}

type LibraryFilter = 'spaces' | 'skills' | 'memory' | 'everything';
type LibraryView = 'folders' | 'cards' | 'atlas';

const LIBRARY_FILTER_LABEL: Record<LibraryFilter, string> = {
  spaces: 'Spaces',
  skills: 'Skills',
  memory: 'Memory',
  everything: 'Everything',
};

const LIBRARY_VIEW_LABEL: Record<LibraryView, string> = {
  folders: 'Folders',
  cards: 'Cards',
  atlas: 'Atlas',
};

/**
 * Set the Library lens (filter + view) via chip controls.
 * Waits for the aria-live sentence to reflect the selected lens.
 */
export async function setLibraryLens(
  window: Page,
  lens: { filter?: LibraryFilter; view?: LibraryView },
): Promise<void> {
  await dismissStartupRecoveryDialogIfPresent(window);

  if (lens.filter) {
    const filterChip = window.locator(`[data-testid="library-filter-chip-${lens.filter}"]`);
    await expect(filterChip).toBeVisible({ timeout: 5000 });
    await filterChip.click();
    await expect(filterChip).toHaveAttribute('aria-checked', 'true');
  }

  if (lens.view) {
    const viewChip = window.locator(`[data-testid="library-view-chip-${lens.view}"]`);
    await expect(viewChip).toBeVisible({ timeout: 5000 });
    await viewChip.click();
    await expect(viewChip).toHaveAttribute('aria-checked', 'true');
  }

  const sentence = window.locator('[data-testid="library-lens-sentence"]');
  await expect(sentence).toHaveCount(1);
  if (lens.filter && lens.view) {
    await expect(sentence).toContainText(
      `Showing ${LIBRARY_FILTER_LABEL[lens.filter]} as ${LIBRARY_VIEW_LABEL[lens.view]}`,
      { timeout: 5000 },
    );
  }
}

/**
 * Expand the first folder group in the Library tree.
 * 
 * Useful for tests that need to interact with files in the workspace tree.
 * 
 * @param window - Playwright Page object for the Electron window
 */
export async function expandFirstFolderGroup(window: Page): Promise<void> {
  const librarySurface = window.locator('[data-testid="library-surface"]');
  await expect(librarySurface).toBeVisible({ timeout: 5000 });
  
  const groupHeaders = librarySurface.locator('button').filter({ hasText: /items?|Empty/ });
  const firstHeader = groupHeaders.first();
  
  if (await firstHeader.isVisible({ timeout: 5000 }).catch(() => false)) {
    await firstHeader.click();
    await window.waitForTimeout(300);
  }
}

/**
 * Ensure the session history sidebar is open (visible).
 * 
 * The sidebar may be collapsed by default in E2E test environments
 * (isolated userData → empty localStorage → DEFAULT_FLOW_PANELS_STATE.history = false).
 * This clicks the history nozzle toggle button to open it if needed.
 */
export async function ensureSessionSidebarOpen(window: Page): Promise<void> {
  const sidebar = window.locator('[data-testid="session-sidebar"]');
  if (await sidebar.isVisible({ timeout: 1000 }).catch(() => false)) {
    return; // Already open
  }
  console.log('[E2E] Opening session sidebar (was collapsed)');
  const toggleButton = window.locator('button[aria-label="Show conversation history sidebar"]');
  await expect(toggleButton).toBeVisible({ timeout: 5000 });
  await toggleButton.click();
  await expect(sidebar).toBeVisible({ timeout: 5000 });
  console.log('[E2E] Session sidebar opened');
}

/**
 * Programmatically clear all pending approvals (tool, memory, and in-memory metadata)
 * via the E2E API. This is faster and more reliable than UI-based drawer cleanup.
 * Requires the app to be launched with REBEL_E2E_TEST_MODE=1.
 */
export async function clearPendingApprovals(window: Page): Promise<void> {
  const result = await window.evaluate(async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const api = (window as any).e2eApi;
    if (api?.clearPendingApprovals) {
      return await api.clearPendingApprovals();
    }
    return { success: false, reason: 'e2eApi.clearPendingApprovals not available' };
  });
  if (!result?.success) {
    console.warn('[E2E] clearPendingApprovals: API not available or failed, falling back to no-op');
    return;
  }
  // Trigger renderer re-fetch: usePendingApprovals re-syncs on window focus.
  // A blur/focus cycle forces the hooks to re-fetch from (now empty) main-process stores.
  await window.evaluate(() => {
    window.dispatchEvent(new Event('blur'));
    window.dispatchEvent(new Event('focus'));
  });
  // Brief wait for the re-fetch to complete
  await window.waitForTimeout(200);
}

/**
 * Programmatically clear all persisted sessions and renderer session caches.
 *
 * This helper is intentionally opt-in: some session-management describes seed
 * sessions in beforeAll and then consume them across tests. Call it only from
 * describes whose tests create their own sessions per test.
 */
export async function clearAllSessions(window: Page): Promise<void> {
  await window.evaluate(async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const api = (window as any).e2eApi;
    if (!api?.clearAllSessions) {
      throw new Error('e2eApi.clearAllSessions not available');
    }
    await api.clearAllSessions();
  });

  // By construction, assert the sidebar dropped to its clean baseline. The store
  // reset always re-creates a single fresh "New Agent Run" current session (you
  // can't have zero sessions), so the baseline is AT MOST one entry — never the
  // accumulated pile this helper exists to clear. Asserting <=1 (not ==0)
  // tolerates that unavoidable current session while still guaranteeing no
  // stale sessions survive (the actual flakiness source).
  await expect
    .poll(() => window.locator('[data-testid="session-sidebar"] [data-session-id]').count(), {
      timeout: 10000,
    })
    .toBeLessThanOrEqual(1);
}

// ============================================================================
// Approval Injection Helpers
// Persist approvals to main-process store AND broadcast to renderer.
// This matches production behavior (unlike raw webContents.send which only
// fires the renderer event without persisting to the store).
// ============================================================================

/**
 * Inject a tool safety approval request via the E2E API.
 * Persists to the main-process pending approvals store and broadcasts the IPC event.
 */
export async function injectToolApproval(window: Page, request: Record<string, unknown>): Promise<void> {
  await window.evaluate(async (req) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const api = (window as any).e2eApi;
    if (api?.injectToolApproval) {
      return await api.injectToolApproval(req);
    }
    throw new Error('e2eApi.injectToolApproval not available');
  }, request);
  // Brief wait for the broadcast to reach renderer hooks
  await window.waitForTimeout(150);
}

/**
 * Inject a memory write approval request via the E2E API.
 * Persists to the main-process pending memory approvals store and broadcasts the IPC event.
 */
export async function injectMemoryApproval(window: Page, request: Record<string, unknown>): Promise<void> {
  await window.evaluate(async (req) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const api = (window as any).e2eApi;
    if (api?.injectMemoryApproval) {
      return await api.injectMemoryApproval(req);
    }
    throw new Error('e2eApi.injectMemoryApproval not available');
  }, request);
  // Brief wait for the broadcast to reach renderer hooks
  await window.waitForTimeout(150);
}

// ============================================================================
// Domain Seeding Helpers (I.1 + I.2)
// See: docs/plans/260404_test_infrastructure_investments.md
// ============================================================================

/**
 * Seed a single inbox item using the renderer inbox API.
 *
 * The minimum required field for `inbox:add` is `title`.
 */
export async function seedInboxItem(
  page: Page,
  item: { title: string; text?: string; sourceType?: string; [key: string]: unknown }
): Promise<void> {
  await page.evaluate(async (data) => {
    // @ts-expect-error - inboxApi is exposed via preload contextBridge
    await window.inboxApi.add(data);
  }, item);
}

/**
 * Seed a single automation using the renderer automations API.
 *
 * The payload should include a valid `schedule` shape accepted by `automations:upsert`.
 */
export async function seedAutomation(
  page: Page,
  automation: {
    name?: string;
    schedule?: { type: string; [key: string]: unknown };
    [key: string]: unknown;
  }
): Promise<void> {
  await page.evaluate(async (data) => {
    // @ts-expect-error - automationsApi is exposed via preload contextBridge
    await window.automationsApi.upsert(data);
  }, automation);
}

/**
 * Seed multiple inbox items with deterministic titles and body text.
 */
export async function seedMultipleInboxItems(
  page: Page,
  count: number,
  options?: { prefix?: string }
): Promise<void> {
  const prefix = options?.prefix ?? 'Test Item';
  for (let i = 0; i < count; i++) {
    await seedInboxItem(page, {
      title: `${prefix} ${i + 1}`,
      text: `Test inbox item body ${i + 1}`,
    });
  }
}

// ============================================================================
// Network Simulation Helpers (I.3)
// See: docs/plans/260404_test_infrastructure_investments.md
// ============================================================================

/**
 * Simulate network offline/online state by overriding navigator.onLine
 * and dispatching the corresponding browser event.
 */
export async function simulateNetworkState(page: Page, online: boolean): Promise<void> {
  await page.evaluate((isOnline) => {
    Object.defineProperty(navigator, 'onLine', {
      value: isOnline,
      writable: true,
      configurable: true,
    });
    window.dispatchEvent(new Event(isOnline ? 'online' : 'offline'));
  }, online);
}

// ============================================================================
// Hero Choice & Coaching Seed Helpers (I.8)
// See: docs/plans/260404_test_infrastructure_investments.md
//
// These use electronApp.evaluate() to call test-only IPC handlers in the
// main process, gated behind REBEL_E2E_TEST_MODE === '1'.
// ============================================================================

/**
 * Seed a hero choice result into the hero choice store.
 * Triggers a 'hero-choice:updated' broadcast so the homepage refreshes.
 *
 * Calls the e2e:seed-hero-choice IPC handler via window.e2eApi,
 * registered in main process under the REBEL_E2E_TEST_MODE guard.
 */
export async function seedHeroChoice(
  page: Page,
  result: {
    chosenCandidate: { title: string; description?: string; prompt?: string; [key: string]: unknown };
    candidates?: Array<{ title: string; [key: string]: unknown }>;
    [key: string]: unknown;
  },
): Promise<void> {
  await page.evaluate(async (data) => {
    // @ts-expect-error - e2eApi is exposed via preload in test mode
    await window.e2eApi?.seedHeroChoice(data);
  }, result);
}

/**
 * Seed a coaching evaluation into the coaching store.
 * Triggers a 'coaching:reflection' broadcast so the homepage refreshes.
 *
 * Calls the e2e:seed-coaching IPC handler via window.e2eApi,
 * registered in main process under the REBEL_E2E_TEST_MODE guard.
 */
export async function seedCoachingEvaluation(
  page: Page,
  evaluation: {
    sessionId: string;
    evaluatedAt: number;
    primaryInsight: { title: string; body: string; category?: string; [key: string]: unknown };
    state: 'pending' | 'reviewed' | 'dismissed';
    [key: string]: unknown;
  },
): Promise<void> {
  await page.evaluate(async (data) => {
    // @ts-expect-error - e2eApi is exposed via preload in test mode
    await window.e2eApi?.seedCoaching(data);
  }, evaluation);
}
