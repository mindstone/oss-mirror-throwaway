/**
 * Launch the dev app in --rebel-test mode and manage its lifetime — the scripted
 * version of the Manual-CDP recipe in `.factory/commands/test-ui.md` (launch SSOT).
 *
 * What it does, in order:
 *   1. Preflight — runs `scripts/test-preflight.ts` (full mode) and fails fast on FAIL.
 *   2. Port guard — verifies the CDP port (and renderer port) are free; if held, prints
 *      the holder's pid/command and exits. NEVER kills anything it did not start.
 *   3. Seeds an isolated userData dir under os.tmpdir() with the rich settings blob
 *      (derived from tests/e2e/test-utils.ts writeMinimalSettings, via test-ui.md),
 *      or `{"onboardingCompleted": false}` with --seed-onboarding-incomplete.
 *   4. EPIPE-safe launch — `sh -c 'tail -f /dev/null | npm run dev -- -- --rebel-test ...'`
 *      (the run-app SKILL's verified pattern: stdin held open by the tail pipe, stdout/
 *      stderr drained to $TEST_DIR/dev.log via an inherited file descriptor, so the app
 *      survives this script exiting in --keep-alive mode).
 *   5. Polls http://127.0.0.1:<port>/json/list every 2s for a "type":"page" target
 *      (with early-exit if the launched process group dies), default timeout 120s.
 *   6. One-shot CDP eval via Playwright connectOverCDP: suppresses the permission
 *      onboarding dialog, verifies the guest-mode canary, reports whether the
 *      onboarding wizard is visible.
 *   7. Cleanup — on EVERY exit path (success, failure, SIGINT/SIGTERM) it kills ONLY
 *      the process group it spawned (npm → forge → vite + electron all share the
 *      detached child's pgid; this is the dev:stop equivalent scoped to our own tree).
 *      Exception: `--keep-alive` + successful readiness leaves the app running and
 *      prints PID/port/test-dir plus the exact kill command. A FAILED launch is
 *      always cleaned up, keep-alive or not.
 *
 * Usage:
 *   npx tsx scripts/ui-test/launch-rebel-test.ts                  # launch, verify, clean up
 *   npx tsx scripts/ui-test/launch-rebel-test.ts --keep-alive     # leave running for driving
 *   npx tsx scripts/ui-test/launch-rebel-test.ts --seed-onboarding-incomplete --keep-alive
 *
 * Flags:
 *   --keep-alive                  leave the app running; print PID + port + test dir; exit 0
 *   --cdp-port <n>                CDP port (default 9222)
 *   --renderer-port <n>           Vite renderer port (sets ELECTRON_RENDERER_PORT; default 5173
 *                                 or .env.local override) — use when the user's dev server holds 5173
 *   --test-dir <path>             isolated userData dir (default <os.tmpdir()>/rebel-ui-test)
 *   --seed-onboarding-incomplete  seed {"onboardingCompleted": false} instead of the rich blob
 *   --timeout-ms <n>              CDP readiness timeout (default 120000 — cold predev takes 55-90s)
 *
 * Exit codes: 0 ready (or clean managed run) · 1 preflight/port-guard fail · 2 launch/readiness fail
 * (on failure the last ~20 lines of dev.log are printed once).
 *
 * CJS file (repo has no "type":"module"): run via `npx tsx`, no top-level await.
 */
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { chromium } from 'playwright';

const execFileAsync = promisify(execFile);
const repoRoot = process.cwd();

// --- arg parsing ---------------------------------------------------------------
const argv = process.argv.slice(2);
const flag = (name: string): boolean => argv.includes(name);
const val = (name: string): string | undefined => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] !== undefined && !argv[i + 1].startsWith('--') ? argv[i + 1] : undefined;
};

const keepAlive = flag('--keep-alive');
const seedOnboardingIncomplete = flag('--seed-onboarding-incomplete');
const cdpPort = Number(val('--cdp-port') ?? 9222);
const rendererPortOverride = val('--renderer-port');
const timeoutMs = Number(val('--timeout-ms') ?? 120_000);
const testDir = path.resolve(val('--test-dir') ?? path.join(os.tmpdir(), 'rebel-ui-test'));
const logPath = path.join(testDir, 'dev.log');

const POLL_INTERVAL_MS = 2_000;

function log(message: string): void {
  console.log(`[launch-rebel-test] ${message}`);
}

// --- process-group lifecycle ---------------------------------------------------
let child: ChildProcess | null = null;
let cleanedUp = false;
let leaveRunning = false; // set true only on keep-alive success

async function listGroupPids(pgid: number): Promise<number[]> {
  try {
    const { stdout } = await execFileAsync('pgrep', ['-g', String(pgid)], { timeout: 2_000 });
    return stdout
      .split(/\s+/)
      .map((value) => Number(value))
      .filter((pid) => Number.isInteger(pid) && pid > 0);
  } catch {
    return []; // pgrep exits 1 when the group is empty
  }
}

function signalGroup(pgid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pgid, signal);
  } catch {
    /* group already gone */
  }
}

/** Kill ONLY the process tree this script spawned (npm/forge/vite/electron share the pgid). */
async function cleanup(): Promise<void> {
  if (cleanedUp || leaveRunning || !child?.pid) return;
  cleanedUp = true;
  const pgid = child.pid;
  signalGroup(pgid, 'SIGTERM');
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if ((await listGroupPids(pgid)).length === 0) {
      log('cleanup: process group exited after SIGTERM');
      return;
    }
    await sleep(250);
  }
  signalGroup(pgid, 'SIGKILL');
  log('cleanup: process group SIGKILLed (did not exit within 5s of SIGTERM)');
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

process.on('exit', () => {
  // Sync best-effort backstop; the async cleanup() normally ran already.
  if (!cleanedUp && !leaveRunning && child?.pid) signalGroup(child.pid, 'SIGKILL');
});
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    void cleanup().finally(() => process.exit(signal === 'SIGINT' ? 130 : 143));
  });
}

// --- failure reporting ---------------------------------------------------------
let tailPrinted = false;
function printLogTailOnce(): void {
  if (tailPrinted) return;
  tailPrinted = true;
  try {
    const lines = fs.readFileSync(logPath, 'utf8').split('\n');
    console.error(`--- last 20 lines of ${logPath} ---`);
    console.error(lines.slice(-20).join('\n'));
    console.error('--- end of log tail ---');
  } catch {
    console.error(`(no log available at ${logPath})`);
  }
}

async function fail(code: 1 | 2, message: string): Promise<never> {
  console.error(`[launch-rebel-test] FAIL: ${message}`);
  if (code === 2) printLogTailOnce();
  await cleanup();
  process.exit(code);
}

// --- preflight + port guard ----------------------------------------------------
async function runPreflight(): Promise<void> {
  const result = await new Promise<number>((resolve) => {
    const preflight = spawn('npx', ['tsx', 'scripts/test-preflight.ts'], {
      cwd: repoRoot,
      stdio: 'inherit',
    });
    preflight.on('exit', (code) => resolve(code ?? 1));
    preflight.on('error', () => resolve(1));
  });
  if (result !== 0) {
    await fail(1, 'preflight reported FAIL — fix the findings above before launching.');
  }
}

async function assertPortFree(port: number, what: string, hint: string): Promise<void> {
  let stdout = '';
  try {
    const result = await execFileAsync('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN'], { timeout: 2_000 });
    stdout = result.stdout;
  } catch {
    return; // lsof exits 1 when nothing listens (or probe unavailable) — treat as free
  }
  const holders = stdout
    .trim()
    .split('\n')
    .slice(1)
    .map((line) => {
      const cols = line.trim().split(/\s+/);
      return `pid ${cols[1]} (${cols[0]})`;
    });
  if (holders.length > 0) {
    await fail(1, `${what} port ${port} is already held by ${[...new Set(holders)].join('; ')}. ${hint}`);
  }
}

// --- settings seeding (blob derived from test-ui.md / tests/e2e writeMinimalSettings) ---
function readAnthropicKey(): string | undefined {
  if (process.env.ANTHROPIC_API_KEY) return process.env.ANTHROPIC_API_KEY;
  try {
    const envLocal = fs.readFileSync(path.join(repoRoot, '.env.local'), 'utf8');
    const match = envLocal.match(/^\s*(?:export\s+)?ANTHROPIC_API_KEY\s*=\s*["']?([^"'\n]+)["']?\s*$/m);
    return match?.[1];
  } catch {
    return undefined;
  }
}

function seedSettings(): void {
  fs.rmSync(testDir, { recursive: true, force: true });
  fs.mkdirSync(path.join(testDir, 'test-workspace'), { recursive: true });

  if (seedOnboardingIncomplete) {
    // ensureRebelTestMode.ts only seeds when app-settings.json is ABSENT — pre-writing
    // an incomplete blob defeats the onboarding bypass so the wizard renders.
    fs.writeFileSync(path.join(testDir, 'app-settings.json'), JSON.stringify({ onboardingCompleted: false }, null, 2));
    log(`seeded onboarding-incomplete settings in ${testDir}`);
    return;
  }

  const settings: Record<string, unknown> = {
    onboardingCompleted: true,
    onboardingFirstCompletedAt: Date.now(),
    onboardingChecklist: { step: 1 },
    coreDirectory: path.join(testDir, 'test-workspace'),
    indexingEnabled: false,
    memoryUpdateEnabled: false,
    dismissedAnnouncements: { 'event-series-apr-2026': true },
  };
  const apiKey = readAnthropicKey();
  if (apiKey) {
    settings.claude = {
      apiKey,
      oauthToken: null,
      authMethod: 'api-key',
      // Keep in sync with PREFERRED_PLANNING_MODEL (src/shared/utils/modelNormalization.ts) — same rule as tests/e2e/test-utils.ts writeMinimalSettings.
      model: 'claude-opus-4-8',
      permissionMode: 'bypassPermissions',
      executablePath: null,
      planMode: false,
      extendedContext: true,
      thinkingEffort: 'high',
    };
  }
  fs.writeFileSync(path.join(testDir, 'app-settings.json'), JSON.stringify(settings, null, 2));
  log(`seeded rich settings in ${testDir} (claude key: ${apiKey ? 'yes' : 'no'})`);
}

// --- CDP readiness + canary ----------------------------------------------------
async function cdpHasPageTarget(): Promise<boolean> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5_000);
    const response = await fetch(`http://127.0.0.1:${cdpPort}/json/list`, { signal: controller.signal });
    clearTimeout(timer);
    if (!response.ok) return false;
    const targets = (await response.json()) as Array<{ type?: string; url?: string }>;
    return targets.some((t) => t.type === 'page' && !(t.url ?? '').startsWith('devtools://'));
  } catch {
    return false;
  }
}

interface CanaryResult {
  guestMode: boolean;
  onboardingWizardVisible: boolean;
  title: string;
}

async function runCanaryOnce(graceDeadline: number): Promise<CanaryResult> {
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${cdpPort}`, { timeout: 15_000 });
  try {
    const pages = browser.contexts().flatMap((context) => context.pages());
    const page = pages.find((p) => !p.url().startsWith('devtools://'));
    if (!page) throw new Error('no non-DevTools page target found over CDP');
    // CDP-up precedes renderer-ready: the preload injects guestMode on DOMContentLoaded.
    // Poll document.readyState via evaluate (NOT waitForLoadState — Playwright can miss
    // lifecycle events when attaching mid-navigation, and forge/vite may rebuild-reload
    // the page right after first paint), then give the injection a grace window.
    const evaluateCanary = (): Promise<CanaryResult & { readyState: string }> =>
      page.evaluate(() => {
        localStorage.setItem('permission-onboarding-shown', 'true');
        return {
          readyState: document.readyState,
          guestMode: sessionStorage.getItem('guestMode') === 'true',
          onboardingWizardVisible: !!document.querySelector('[data-testid="onboarding-welcome-content"]'),
          title: document.title,
        };
      });
    let result = await evaluateCanary();
    while ((result.readyState === 'loading' || !result.guestMode) && Date.now() < graceDeadline) {
      await sleep(500);
      result = await evaluateCanary();
    }
    return result;
  } finally {
    await browser.close(); // connectOverCDP: disconnects only, does not kill the app
  }
}

/** Canary with reconnect-on-error: a vite rebuild can reload the page mid-eval. */
async function runCanary(): Promise<CanaryResult> {
  const graceDeadline = Date.now() + 45_000;
  let lastError: unknown = new Error('canary never ran');
  while (Date.now() < graceDeadline) {
    try {
      return await runCanaryOnce(graceDeadline);
    } catch (err) {
      lastError = err;
      await sleep(2_000);
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

// --- main ----------------------------------------------------------------------
void (async () => {
  const startedAt = Date.now();

  if (!Number.isInteger(cdpPort) || cdpPort < 1 || cdpPort > 65535) {
    await fail(1, `invalid --cdp-port: ${String(cdpPort)}`);
  }
  if (!testDir.startsWith(os.tmpdir() + path.sep)) {
    // Fail BEFORE seedSettings() rm -rf's the dir — the app's own guard
    // (ensureTestUserData.ts) only fires after the delete would have happened.
    await fail(1, `--test-dir ${testDir} is outside os.tmpdir() (${os.tmpdir()}) — refusing to delete/seed it.`);
  }

  await runPreflight();
  await assertPortFree(cdpPort, 'CDP', 'Pass --cdp-port <other> or stop YOUR OWN previous launch; never kill processes you did not start.');
  // Renderer port resolution mirrors vite.renderer.config.mjs / scripts/stop-dev.mjs:
  // shell env beats .env.local beats the 5173 default.
  let envLocalRendererPort: string | undefined;
  try {
    envLocalRendererPort = fs
      .readFileSync(path.join(repoRoot, '.env.local'), 'utf8')
      .match(/^ELECTRON_RENDERER_PORT\s*=\s*(\d+)/m)?.[1];
  } catch {
    /* no .env.local */
  }
  const rendererPort = Number(rendererPortOverride ?? process.env.ELECTRON_RENDERER_PORT ?? envLocalRendererPort ?? 5173);
  await assertPortFree(rendererPort, 'renderer (Vite)', 'Pass --renderer-port <other> to coexist with the running dev server.');

  seedSettings();

  // EPIPE-safe launch (run-app SKILL pattern): tail keeps stdin open; output drains to
  // an inherited file descriptor so it survives this script exiting in keep-alive mode.
  const logFd = fs.openSync(logPath, 'a');
  const devCommand =
    'tail -f /dev/null | npm run dev -- -- --rebel-test ' +
    '"--rebel-test-user-data-dir=$REBEL_UI_TEST_DIR" "--cdp-port=$REBEL_UI_CDP_PORT"';
  child = spawn('sh', ['-c', devCommand], {
    cwd: repoRoot,
    detached: true, // own pgid == child.pid → group kill reaches npm/forge/vite/electron only
    stdio: ['ignore', logFd, logFd],
    env: {
      ...process.env,
      REBEL_UI_TEST_DIR: testDir,
      REBEL_UI_CDP_PORT: String(cdpPort),
      REMOTE_DEBUGGING_PORT: String(cdpPort),
      ...(rendererPortOverride ? { ELECTRON_RENDERER_PORT: rendererPortOverride } : {}),
    },
  });
  fs.closeSync(logFd);
  child.unref();
  const pgid = child.pid;
  if (!pgid) await fail(2, 'spawn failed — no child pid');
  log(`launched dev process group ${pgid} (log: ${logPath}); polling CDP on ${cdpPort} every ${POLL_INTERVAL_MS / 1000}s (timeout ${timeoutMs / 1000}s)...`);

  // Readiness poll with early-exit when the launched tree dies (sh+tail linger, so a
  // group reduced to <=2 pids means npm/forge/electron are gone).
  const deadline = Date.now() + timeoutMs;
  let ready = false;
  while (Date.now() < deadline) {
    if (await cdpHasPageTarget()) {
      ready = true;
      break;
    }
    if ((await listGroupPids(pgid as number)).length <= 2) {
      await fail(2, 'dev process exited before CDP became ready.');
    }
    await sleep(POLL_INTERVAL_MS);
  }
  if (!ready && (await cdpHasPageTarget())) ready = true; // timeout-boundary recheck
  if (!ready) {
    await fail(2, `CDP page target not ready on port ${cdpPort} after ${timeoutMs / 1000}s.`);
  }
  const readyAfterS = ((Date.now() - startedAt) / 1000).toFixed(1);

  let canary: CanaryResult;
  try {
    canary = await runCanary();
  } catch (err) {
    await fail(2, `CDP canary eval failed: ${err instanceof Error ? err.message : String(err)}`);
    throw err; // unreachable; narrows type
  }
  log(`ready in ${readyAfterS}s — title="${canary.title}" guestMode=${String(canary.guestMode)} onboardingWizard=${String(canary.onboardingWizardVisible)}`);

  if (seedOnboardingIncomplete && !canary.onboardingWizardVisible) {
    log('WARNING: onboarding wizard not (yet) visible — screenshot the page to confirm wizard state.');
  }
  if (!seedOnboardingIncomplete && !canary.guestMode) {
    await fail(2, 'guest-mode canary failed (sessionStorage.guestMode !== "true") — see test-ui.md fallback injection.');
  }

  if (keepAlive) {
    leaveRunning = true;
    log(`keep-alive: app left running. pid(pgid)=${pgid} cdp-port=${cdpPort} test-dir=${testDir}`);
    log(`to stop it later (YOUR process tree): kill -- -${pgid}; wait ~5s; kill -9 -- -${pgid} 2>/dev/null || true`);
    process.exit(0);
  }

  await cleanup();
  log('clean run complete (launched, verified, cleaned up).');
  process.exit(0);
})().catch(async (err: unknown) => {
  console.error(`[launch-rebel-test] unexpected error: ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
  await cleanup();
  process.exit(2);
});
