/**
 * On-demand installer for the Recall Desktop SDK (the meeting recorder).
 *
 * In the open build the SDK is stripped from package.json, so the recorder is
 * default-missing and the user opts in. Historically the only path was a
 * copy-the-command dialog ("run `npm install …` in a terminal, then restart").
 * This service runs that exact pinned install from the main process so a
 * non-technical user can do it with one click — with progress, honest failure
 * surfacing, and a restart prompt (the copy-command stays as a fallback).
 *
 * Why this is safe / opt-in:
 *  - `--no-save` leaves package.json untouched → the public-mirror dependency
 *    strip is unchanged; the recorder stays default-missing.
 *  - The package name is a hardcoded constant referenced as a string (never a
 *    static `import … from '@recallai/desktop-sdk'`), so the OSS leak/parity
 *    gate (`mirror/check-recall-sdk-parity.ts`) is not tripped.
 *
 * Correctness notes (load-bearing — see plan 260618_recorder-install-button):
 *  - The SDK has an `install` lifecycle script (`setup.js`) that downloads the
 *    platform-native recorder from S3. So we MUST run with scripts enabled, and
 *    `require.resolve`/JS-presence is NOT a sufficient success signal — `setup.js`
 *    exits 0 with no payload on unsupported platforms (Linux) and can fail at the
 *    S3 step while still leaving the JS package on disk. Success therefore
 *    requires: npm exit 0 AND the platform-native executable present on disk.
 *  - We probe the install target via the FILESYSTEM at the discovered repo root,
 *    not `require.resolve`. Node caches positive module resolutions for the life
 *    of the process, so a `require.resolve` after a half-install would keep
 *    reporting "installed" even after we clean the directory up.
 */

import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import path from 'node:path';

import { createScopedLogger } from '@core/logger';
import { getPlatformConfig } from '@core/platform';
import { getErrorReporter } from '@core/errorReporter';
import {
  RECALL_DESKTOP_SDK_INSTALL_ARGS,
  RECALL_DESKTOP_SDK_PACKAGE_NAME,
} from '@shared/recallRecorder';
import { ignoreBestEffortCleanup } from '@shared/utils/intentionalSwallow';
import {
  findRepoRootFrom,
  resolveDefaultNpmRunner,
} from '../managedMcpInstallService';

const log = createScopedLogger({ component: 'recorder-installer' });

/** Generous ceiling — a cold native download/extract over a slow link is the long pole. */
const INSTALL_TIMEOUT_MS = 5 * 60 * 1000;
/** npm + the SDK's S3 download/extract logging blow past execFile's 1 MB default. */
const INSTALL_MAX_BUFFER_BYTES = 64 * 1024 * 1024;

/** Platform-native executable `setup.js` lays down next to `index.js` (mirrors index.js:62-68). */
const NATIVE_EXECUTABLE_BY_PLATFORM: Readonly<Record<string, string>> = {
  darwin: 'desktop_sdk_macos_exe',
  win32: 'agent-windows.exe',
};

export interface RecorderInstallResult {
  /** True only when npm succeeded AND the platform-native recorder is present on disk. */
  success: boolean;
  /** A usable recorder was already installed; nothing was run. */
  alreadyInstalled?: boolean;
  /** Recall ships no recorder for this OS (e.g. Linux); npm was not run. */
  unsupportedPlatform?: boolean;
  /** The user cancelled the install. Not a failure to surface — the UI returns to idle. */
  cancelled?: boolean;
  /** Friendly, non-technical failure message for the UI (never a raw npm dump). */
  error?: string;
}

const MESSAGES = {
  unsupportedPlatform:
    "The meeting recorder isn't available on this system yet — Recall only provides it for macOS and Windows.",
  notSourceCheckout:
    "Rebel couldn't find a place to install the recorder here. You can still install it yourself with the command below.",
  toolsMissing:
    "Rebel couldn't find the tools it needs to install the recorder. You can still run the command below yourself.",
  permissions:
    "Rebel doesn't have permission to install the recorder here. You can run the command below yourself instead.",
  timedOut:
    "Installing the recorder took too long and was stopped. Check your connection and try again.",
  downloadIncomplete:
    "The recorder didn't finish installing — the download may have been interrupted. Check your connection and try again.",
  generic:
    "Something went wrong installing the recorder. You can try again, or run the command below yourself.",
} as const;

interface InflightInstall {
  readonly promise: Promise<RecorderInstallResult>;
  readonly controller: AbortController;
}

// Module-level so the guard survives a renderer remount / a second window, and so
// `cancelRecorderInstall()` can reach the running child. UI-level state would not.
let inflight: InflightInstall | null = null;

/** True while an install is running (read by the `is-recorder-installing` IPC). */
export function isRecorderInstalling(): boolean {
  return inflight !== null;
}

/**
 * Abort the in-flight install (if any). The running `installRecorder()` promise
 * settles with a cancelled result and cleans up any partial install.
 */
export function cancelRecorderInstall(): boolean {
  if (!inflight) {
    return false;
  }
  log.info('Recorder install cancellation requested');
  inflight.controller.abort();
  return true;
}

/** Run (or join) a single on-demand recorder install. Concurrent calls share one run. */
export function installRecorder(): Promise<RecorderInstallResult> {
  if (inflight) {
    return inflight.promise;
  }
  const controller = new AbortController();
  const promise = runInstall(controller.signal).finally(() => {
    inflight = null;
  });
  inflight = { promise, controller };
  return promise;
}

function platformNativeExecutable(): string | undefined {
  return NATIVE_EXECUTABLE_BY_PLATFORM[process.platform];
}

/** Absolute path the SDK installs to under the repo root (root dependency, not hoisted elsewhere). */
function recorderPackageDir(repoRoot: string): string {
  return path.join(repoRoot, 'node_modules', ...RECALL_DESKTOP_SDK_PACKAGE_NAME.split('/'));
}

/**
 * A *usable* install: the JS package AND the platform-native executable are on
 * disk. Filesystem-only (no `require.resolve`) so the result is never poisoned
 * by Node's positive resolution cache and stays truthful after a cleanup.
 */
function isUsableRecorderInstall(repoRoot: string): boolean {
  const nativeExe = platformNativeExecutable();
  if (!nativeExe) {
    return false;
  }
  const packageDir = recorderPackageDir(repoRoot);
  return (
    existsSync(path.join(packageDir, 'package.json')) &&
    existsSync(path.join(packageDir, nativeExe))
  );
}

/** Remove a partial/broken install so the affordance reappears and Retry starts clean. */
async function cleanupPartialInstall(repoRoot: string): Promise<void> {
  const packageDir = recorderPackageDir(repoRoot);
  try {
    await rm(packageDir, { recursive: true, force: true });
    log.info({ packageDir }, 'Removed partial recorder install');
  } catch (error) {
    ignoreBestEffortCleanup(error, {
      operation: 'cleanupPartialInstall',
      reason: 'leftover partial recorder install is harmless; the failure is already surfaced to the user',
    });
  }
}

function runNpmInstall(
  executable: string,
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
  signal: AbortSignal,
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    execFile(
      executable,
      args,
      {
        cwd,
        env,
        encoding: 'utf8',
        timeout: INSTALL_TIMEOUT_MS,
        maxBuffer: INSTALL_MAX_BUFFER_BYTES,
        windowsHide: true,
        signal,
      },
      (error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      },
    );
  });
}

function mapInstallError(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code;
  const message = error instanceof Error ? error.message : String(error);
  if (code === 'ETIMEDOUT' || (error as { killed?: boolean } | null)?.killed) {
    return MESSAGES.timedOut;
  }
  if (code === 'EACCES' || code === 'EPERM' || code === 'EROFS' || /EACCES|EPERM|EROFS|permission/i.test(message)) {
    return MESSAGES.permissions;
  }
  if (code === 'ENOENT') {
    return MESSAGES.toolsMissing;
  }
  return MESSAGES.generic;
}

async function runInstall(signal: AbortSignal): Promise<RecorderInstallResult> {
  // 1. Preflight: Recall ships no native payload for platforms other than
  //    macOS/Windows. Running npm there only unpacks a non-functional JS-only
  //    package, so refuse up front rather than report a false success.
  if (!platformNativeExecutable()) {
    log.info({ platform: process.platform }, 'Recorder install skipped: unsupported platform');
    return { success: false, unsupportedPlatform: true, error: MESSAGES.unsupportedPlatform };
  }

  // 2. Discover the writable repo-root node_modules the runtime `require()`
  //    resolves from. NOT app.getAppPath() directly (that's out/main or the asar
  //    dir); we walk up from it to the repo root. __dirname is the fallback.
  let appPath: string | undefined;
  try {
    appPath = getPlatformConfig().appPath;
  } catch {
    appPath = undefined;
  }
  const repoRoot = findRepoRootFrom(appPath) ?? findRepoRootFrom(__dirname);
  if (!repoRoot) {
    log.warn('Recorder install skipped: no writable source checkout found');
    return { success: false, error: MESSAGES.notSourceCheckout };
  }

  // 3. Already usable? (Defensive — the affordance normally hides when installed.)
  if (isUsableRecorderInstall(repoRoot)) {
    return { success: true, alreadyInstalled: true };
  }

  // 4. Resolve npm (bundled node + npm-cli.js, falling back to system npm).
  let runner;
  try {
    runner = await resolveDefaultNpmRunner(log);
  } catch (error) {
    log.warn({ err: error }, 'Failed to resolve an npm runner for the recorder install');
    return { success: false, error: MESSAGES.toolsMissing };
  }

  // Prepend the runner's node dir to PATH so the SDK's `install` lifecycle
  // script (`node ./setup.js`) can find `node` even on a sparse PATH. Only when
  // the runner is an absolute path — a bare `npm`/`npm.cmd` fallback would yield
  // `path.dirname() === '.'`, which would wrongly add the install cwd to PATH.
  const env: NodeJS.ProcessEnv = { ...process.env };
  if (path.isAbsolute(runner.executable)) {
    const nodeDir = path.dirname(runner.executable);
    env.PATH = env.PATH ? `${nodeDir}${path.delimiter}${env.PATH}` : nodeDir;
  }

  const args = [...runner.prefixArgs, ...RECALL_DESKTOP_SDK_INSTALL_ARGS];
  log.info({ repoRoot, runner: runner.description }, 'Starting one-click recorder install');

  try {
    await runNpmInstall(runner.executable, args, repoRoot, env, signal);
  } catch (error) {
    if (signal.aborted) {
      log.info('Recorder install aborted by user');
      await cleanupPartialInstall(repoRoot);
      return { success: false, cancelled: true };
    }
    log.warn({ err: error }, 'Recorder install npm command failed');
    await cleanupPartialInstall(repoRoot);
    return { success: false, error: mapInstallError(error) };
  }

  // 5. Success gate: npm exited 0 — now require the platform-native binary on
  //    disk. If it's missing (e.g. the S3 download failed but JS unpacked, or
  //    the platform has no payload), clean up so the state doesn't get stuck
  //    "installed-but-broken", and report failure.
  if (isUsableRecorderInstall(repoRoot)) {
    log.info({ repoRoot }, 'Recorder install succeeded');
    return { success: true };
  }

  log.warn({ repoRoot }, 'npm exited 0 but the native recorder binary is missing; cleaning up');
  getErrorReporter().captureMessage('recorder install: npm ok but native artifact missing', {
    level: 'warning',
    tags: { area: 'recorder-install', platform: process.platform },
  });
  await cleanupPartialInstall(repoRoot);
  return { success: false, error: MESSAGES.downloadIncomplete };
}
