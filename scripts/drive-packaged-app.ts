/**
 * Reusable helper for live-driving the packaged Mindstone Rebel app (ad-hoc agent
 * verification — NOT the E2E suite). Captures, in one place, the gotchas that bite
 * every hand-rolled driver:
 *
 *   - launch env + argv that satisfy BOTH the main-process test gate
 *     (REBEL_E2E_TEST_MODE) AND the preload `window.e2eApi` gate (--e2e-test-mode +
 *     --e2e-test-user-data-dir=), so the e2e seed hooks are reachable;
 *   - the `globalThis.__name` shim (tsx/esbuild `keepNames` injects __name() into
 *     evaluated function strings → ReferenceError inside win.evaluate without it);
 *   - a robust close: app.quit() → app.close() inside a watchdog, SIGKILL fallback,
 *     so the driver never leaves a leaked Electron process.
 *
 * Prereqs: `npm run package` first (a packaged build loads the renderer from disk —
 * no Vite dev server / forge watch to tear down). macOS/Linux/Windows binary resolved
 * via scripts/resolve-packaged-app.ts.
 *
 * Library use:
 *   import { launchPackagedApp } from './scripts/drive-packaged-app';
 *   const { app, win, close } = await launchPackagedApp();
 *   await win.evaluate(() => window.e2eApi.seedStagedCall({ blockedBy: 'eval_error' }));
 *   await win.screenshot({ path: '/tmp/x.png' });
 *   await close();
 *
 * CLI smoke (boots, optionally seeds a staged eval_error card, screenshots, exits):
 *   npx tsx scripts/drive-packaged-app.ts --screenshot /tmp/boot.png
 *   npx tsx scripts/drive-packaged-app.ts --seed-staged-call --screenshot /tmp/card.png
 *
 * CJS file (repo has no "type":"module"): run via `npx tsx`, no top-level await.
 */
import { _electron as electron, type ElectronApplication, type Page } from 'playwright';
import { resolvePackagedAppPaths } from './resolve-packaged-app';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

export interface LaunchedApp {
  app: ElectronApplication;
  win: Page;
  userDataDir: string;
  /** Robust close: quit→close in a 12s watchdog, SIGKILL fallback, cleans userDataDir. */
  close: () => Promise<void>;
}

/** The executable path of the packaged app for the current platform/arch/channel. */
export function resolvePackagedBinaryPath(): string {
  const p = resolvePackagedAppPaths();
  if (p.platform === 'darwin') return path.join(p.appPath, 'Contents', 'MacOS', p.productName);
  if (p.platform === 'win32') return p.exePath;
  return p.linuxExePath;
}

export async function launchPackagedApp(
  opts: {
    firstWindowTimeoutMs?: number;
    /**
     * Runs after the disposable temp profile dir is created, BEFORE launch.
     * Lets callers pre-seed the profile (e.g. write app-settings.json with a
     * coreDirectory pointing at a seeded temp workspace — the boot-smoke's
     * fsevents interception gate needs the workspace watcher to actually
     * start). ensureRebelTestMode only seeds settings when the file does not
     * already exist, so a pre-written app-settings.json wins.
     */
    prepareProfile?: (userDataDir: string) => void;
  } = {},
): Promise<LaunchedApp> {
  const bin = resolvePackagedBinaryPath();
  if (!fs.existsSync(bin)) {
    throw new Error(`Packaged binary not found at ${bin} — run \`npm run package\` first.`);
  }
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rebel-drive-'));
  // userDataBackupService writes snapshot backups to a SIBLING dir of the
  // profile (`<userData>-backups`, userDataBackupService.ts) — track it so
  // every teardown path removes it too (Stage 4 observed 37 leaked dirs).
  const backupsSiblingDir = `${userDataDir}-backups`;
  const removeTempDirs = (): void => {
    try { fs.rmSync(userDataDir, { recursive: true, force: true }); } catch { /* ignore */ }
    try { fs.rmSync(backupsSiblingDir, { recursive: true, force: true }); } catch { /* ignore */ }
  };
  try {
    opts.prepareProfile?.(userDataDir);
  } catch (err) {
    // A throwing prepareProfile would otherwise leak the just-created profile
    // dir (Stage 3 review F3) — nothing launched yet, so just remove and rethrow.
    removeTempDirs();
    throw err;
  }

  const app = await electron.launch({
    executablePath: bin,
    // argv: rebel-test isolation + the two flags the preload e2eApi gate checks.
    args: [
      `--rebel-test-user-data-dir=${userDataDir}`,
      '--e2e-test-mode',
      `--e2e-test-user-data-dir=${userDataDir}`,
    ],
    // Run from the disposable temp profile, NOT the repo root. Defense-in-depth:
    // any early-boot code that resolves a cwd-relative path before platform config
    // is ready (historically storeMigration's backup dir, which used to fall back to
    // `process.cwd()/backups` and litter the repo with `backups/connector-contributions-*.json`)
    // stays inside the temp profile that `close` removes. storeMigration no longer
    // resolves backups against cwd (absolute REBEL_USER_DATA — which we set to
    // userDataDir below — else os.tmpdir(); see src/core/utils/storeMigration.ts), so
    // this cwd anchoring is now belt-and-suspenders rather than load-bearing. (A packaged Electron app
    // resolves its own resources from the executable path, so cwd is free to move.)
    cwd: userDataDir,
    timeout: 0,
    env: {
      ...process.env,
      REBEL_TEST_MODE: '1',
      REBEL_E2E_TEST_MODE: '1',
      REBEL_USER_DATA: userDataDir,
      REBEL_TEST_USER_DATA_DIR: userDataDir,
      REBEL_TEST_ALLOW_NON_TEMP_USERDATA: '',
    },
  });

  // If post-launch setup throws (e.g. firstWindow times out because the packaged app
  // started but never opened a window), the `close` helper below has not been defined
  // yet — so a caller's catch block has nothing to clean up and would leak the Electron
  // process + temp profile. Tear them down here before rethrowing.
  const cleanupOnLaunchFailure = (): void => {
    try { app.process().kill('SIGKILL'); } catch { /* ignore */ }
    removeTempDirs();
  };

  let win: Page;
  try {
    // __name shim — for the current page AND any future navigation.
    const shim = '() => { if (typeof globalThis.__name === "undefined") { globalThis.__name = (fn) => fn; } }';
    await app.evaluate(() => {}); // ensure main is up
    win = await app.firstWindow({ timeout: opts.firstWindowTimeoutMs ?? 90_000 });
    await win.addInitScript(shim);
    await win.waitForLoadState('domcontentloaded');
    try {
      await win.evaluate(() => {
        const g = globalThis as unknown as { __name?: (fn: unknown) => unknown };
        if (typeof g.__name === 'undefined') g.__name = (fn) => fn;
      });
    } catch {
      /* best-effort; addInitScript covers reloads */
    }
  } catch (err) {
    cleanupOnLaunchFailure();
    throw err;
  }

  const close = async (): Promise<void> => {
    try {
      await Promise.race([
        (async () => {
          try { await app.evaluate(({ app: a }) => a.quit()); } catch { /* ignore */ }
          await app.close();
        })(),
        new Promise((_, reject) => setTimeout(() => reject(new Error('close-timeout')), 12_000)),
      ]);
    } catch {
      try { app.process().kill('SIGKILL'); } catch { /* ignore */ }
    } finally {
      removeTempDirs();
    }
  };

  return { app, win, userDataDir, close };
}

// --- CLI smoke ---------------------------------------------------------------
if (require.main === module) {
  const argv = process.argv.slice(2);
  const flag = (name: string): boolean => argv.includes(name);
  const val = (name: string): string | undefined => {
    const i = argv.indexOf(name);
    return i >= 0 ? argv[i + 1] : undefined;
  };

  void (async () => {
    const { win, close } = await launchPackagedApp();
    try {
      const ready = await win.evaluate(async () => {
        const e2e = (window as unknown as { e2eApi?: { getReadiness?: () => Promise<unknown> } }).e2eApi;
        return { hasE2eApi: !!e2e, readiness: e2e?.getReadiness ? await e2e.getReadiness() : null };
      });
      console.log('[drive] e2eApi reachable:', ready.hasE2eApi, '| readiness:', JSON.stringify(ready.readiness));

      if (flag('--seed-staged-call')) {
        const seed = await win.evaluate(async () => {
          const e2e = (window as unknown as {
            e2eApi?: { seedStagedCall?: (i: Record<string, unknown>) => Promise<{ success: boolean; id: string }> };
          }).e2eApi;
          if (!e2e?.seedStagedCall) return { error: 'seedStagedCall not exposed' };
          return e2e.seedStagedCall({ displayName: 'Send a Slack message', blockedBy: 'eval_error', riskLevel: 'high' });
        });
        console.log('[drive] seedStagedCall →', JSON.stringify(seed));
        // surface the approvals view so the seeded card renders
        try { await win.getByText('Actions', { exact: true }).first().click({ timeout: 4000 }); } catch { /* nav best-effort */ }
        await win.waitForTimeout(1200);
      }

      const shot = val('--screenshot');
      if (shot) { await win.screenshot({ path: shot, fullPage: true }); console.log('[drive] screenshot →', shot); }
    } finally {
      await close();
      console.log('[drive] closed cleanly');
    }
  })();
}
