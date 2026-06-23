/**
 * App-Install Integrity Service (macOS-focused, desktop-only).
 *
 * Detects the two install hazards that strand users on an old build and make
 * auto-update "crash"/"not install" (the bricked-beta pattern):
 *   1. duplicate app bundles (e.g. `Mindstone Rebel Beta.app` +
 *      `Mindstone Rebel Beta 2.app`, same `CFBundleIdentifier`), and
 *   2. App Translocation (Gatekeeper running from a read-only randomised path).
 *
 * Behaviour is **warn-only**: we log, emit a Sentry breadcrumb + warning
 * message, persist a small JSON for the diagnostic bundle, and (for true
 * duplicates only) show a one-time native dialog. We NEVER delete/move bundles
 * or alter the update flow — wrong detection must not be able to trap a user.
 *
 * The classification is pure and unit-tested in
 * `@core/services/diagnostics/appInstallIntegrity`; this file only gathers the
 * Electron/macOS-specific inputs.
 *
 * Privacy: persisted/logged/Sentry-bound paths are run through
 * `normalizeUserPaths` (a `~/Applications/<name>/…` copy would otherwise leak a
 * home dir). The local native dialog keeps the real paths so the user can
 * actually find the extra copy.
 */

import { app, shell } from 'electron';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createScopedLogger } from '@core/logger';
import { getErrorReporter } from '@core/errorReporter';
import { getDataPath } from '@core/utils/dataPaths';
import { normalizeUserPaths } from '@core/utils/logRedaction';
import { mapWithConcurrencyLimit } from '@core/utils/concurrencyLimit';
import { ignoreBestEffortCleanup } from '@shared/utils/intentionalSwallow';
import { isAutomatedOrHeadlessContext } from '../utils/testIsolation';
import { resolveRunningAppBundlePath } from './appInstallProvenance';
import { showStartupMessageBox } from '../startup/startupDialog';
import {
  classifyAppInstallIntegrity,
  isAppTranslocatedPath,
  isForgeOutDirBundlePath,
  type AppInstallIntegrityResult,
  type DiscoveredBundle,
} from '@core/services/diagnostics/appInstallIntegrity';

const log = createScopedLogger({ service: 'appInstallIntegrity' });
const execFileAsync = promisify(execFile);

const PLUTIL_TIMEOUT_MS = 4000;
/** Cap on the number of `.app` bundles whose Info.plist we read at startup. */
const MAX_APPS_SCANNED = 150;
/** Parallelism for the plutil reads (bounded so startup stays cheap). */
const PLIST_READ_CONCURRENCY = 8;
const STATE_FILENAME = 'app-install-integrity.json';
const DISMISS_FILENAME = 'app-install-integrity-dismissed.json';

export interface PersistedAppInstallIntegrity extends AppInstallIntegrityResult {
  generatedAt: number;
  platform: NodeJS.Platform;
  /** How many sibling `.app` candidates we inspected. */
  candidatesScanned: number;
  /** Total `.app` bundles found before the MAX_APPS_SCANNED cap. */
  candidatesFound: number;
  /** True when the cap dropped some candidates (so a miss is diagnosable). */
  candidatesTruncated: boolean;
}

function redactPath(p: string): string {
  return normalizeUserPaths(p);
}

/**
 * Read bundle id + short version from an `.app`'s Info.plist with a SINGLE
 * `plutil` invocation (no shell; bounded timeout). One spawn per app — half the
 * process churn of extracting each key separately, which matters when scanning
 * every app at startup. Missing/unreadable plist → nulls (the observable signal).
 */
async function readBundleInfo(
  appBundlePath: string,
): Promise<{ bundleId: string | null; shortVersion: string | null }> {
  const plistPath = path.join(appBundlePath, 'Contents', 'Info.plist');
  try {
    const { stdout } = await execFileAsync(
      'plutil',
      ['-convert', 'json', '-o', '-', plistPath],
      { timeout: PLUTIL_TIMEOUT_MS },
    );
    const parsed = JSON.parse(stdout) as Record<string, unknown>;
    const bundleId = typeof parsed.CFBundleIdentifier === 'string' ? parsed.CFBundleIdentifier : null;
    const shortVersion =
      typeof parsed.CFBundleShortVersionString === 'string' ? parsed.CFBundleShortVersionString : null;
    return { bundleId, shortVersion };
  } catch (err) {
    ignoreBestEffortCleanup(err, {
      operation: 'appInstallIntegrity.readBundleInfo',
      reason: 'Info.plist missing/unreadable/unparseable; null bundle id degrades gracefully',
    });
    return { bundleId: null, shortVersion: null };
  }
}

/**
 * Discover candidate `.app` bundles in the standard install dirs.
 *
 * We scan EVERY top-level `*.app` (not just name-matched siblings) and let the
 * classifier match purely on `CFBundleIdentifier`. This is deliberately broad:
 * a duplicate that was renamed has a different filename but keeps its bundle id,
 * so the only reliable signal is the id — e.g. an old `Rebel.app` sitting next
 * to a renamed `Mindstone Rebel.app` (same id) is a real updater hazard a
 * name-prefilter would miss, as are `… copy.app` / `… old.app` duplicates. Cost
 * is bounded by MAX_APPS_SCANNED and PLIST_READ_CONCURRENCY; runs once at
 * startup, off the critical path.
 */
async function discoverCandidateBundles(
  runningBundlePath: string,
): Promise<{ bundles: DiscoveredBundle[]; scanned: number; found: number; truncated: boolean }> {
  const dirs = [path.join('/', 'Applications'), path.join(os.homedir(), 'Applications')];
  const candidatePaths = new Set<string>();
  // Always include the running bundle (the classifier excludes it from dupes).
  candidatePaths.add(runningBundlePath);

  for (const dir of dirs) {
    let entries: string[] = [];
    try {
      entries = await fs.readdir(dir);
    } catch (err) {
      // Dir may not exist (e.g. no ~/Applications); skip it.
      ignoreBestEffortCleanup(err, {
        operation: 'appInstallIntegrity.readdir',
        reason: 'Install dir unreadable/absent; skipped',
      });
      continue;
    }
    for (const name of entries) {
      if (name.toLowerCase().endsWith('.app')) candidatePaths.add(path.join(dir, name));
    }
  }

  const allCandidates = Array.from(candidatePaths);
  const found = allCandidates.length;
  const limited = allCandidates.slice(0, MAX_APPS_SCANNED);
  const truncated = found > limited.length;
  if (truncated) {
    log.warn(
      { found, cap: MAX_APPS_SCANNED },
      'App-install integrity: more .app bundles than the scan cap; some not inspected',
    );
  }

  const read = await mapWithConcurrencyLimit(
    limited,
    PLIST_READ_CONCURRENCY,
    async (candidate): Promise<DiscoveredBundle> => {
      let canonical = candidate;
      try {
        canonical = await fs.realpath(candidate);
      } catch (err) {
        // Use the raw path if realpath fails (e.g. permissions); still useful.
        ignoreBestEffortCleanup(err, {
          operation: 'appInstallIntegrity.realpath',
          reason: 'realpath failed; falling back to the raw candidate path',
        });
      }
      const { bundleId, shortVersion } = await readBundleInfo(canonical);
      return { path: canonical, bundleId, shortVersion };
    },
  );

  // Two raw paths (e.g. a symlink) can realpath to the same bundle — dedupe so
  // `scanned` is honest and we don't double-feed the classifier.
  const seen = new Set<string>();
  const bundles: DiscoveredBundle[] = [];
  for (const b of read) {
    if (seen.has(b.path)) continue;
    seen.add(b.path);
    bundles.push(b);
  }
  return { bundles, scanned: bundles.length, found, truncated };
}

async function atomicWriteJson(filePath: string, value: unknown): Promise<void> {
  const tmp = `${filePath}.${process.pid}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(value, null, 2), 'utf-8');
  await fs.rename(tmp, filePath);
}

/**
 * Gather + classify + persist + report app-install integrity. macOS-only for
 * now (the duplicate/translocation hazards are macOS bundle concerns); on other
 * platforms this is a no-op returning null. Never throws.
 */
export async function runAppInstallIntegrityCheck(): Promise<AppInstallIntegrityResult | null> {
  if (process.platform !== 'darwin') return null;
  try {
    // Canonical (realpath'd) running `.app` path — shared with the relocation
    // service so the two install-hygiene guards can't diverge (see appInstallProvenance).
    const runningBundlePath = await resolveRunningAppBundlePath();
    if (!runningBundlePath) {
      log.info('Could not resolve running .app bundle; skipping integrity check');
      return null;
    }

    const isTranslocated = isAppTranslocatedPath(runningBundlePath);
    const { bundles, scanned, found, truncated } = await discoverCandidateBundles(runningBundlePath);
    const runningBundleId =
      bundles.find((b) => b.path === runningBundlePath)?.bundleId ??
      (await readBundleInfo(runningBundlePath)).bundleId;

    // Real paths — used locally by the dialog so the user can find the copy.
    const result = classifyAppInstallIntegrity({
      runningBundlePath,
      runningBundleId,
      discovered: bundles,
      isTranslocated,
    });

    // Redacted paths for anything that leaves the machine (persisted JSON read
    // into the diagnostic bundle / Sentry; logs).
    const redactedRunning = redactPath(result.runningBundlePath);
    const redactedDupes = result.duplicateBundlePaths.map(redactPath);

    // A developer running `npm run package:run` legitimately has a copy in
    // /Applications with the same bundle id — that "duplicate" is expected and
    // not a real-user incident. Keep detection + the persisted JSON (diagnostics
    // stay intact) but don't send Sentry noise from dev machines. Never matches a
    // real install (see isForgeOutDirBundlePath), so real bricked-beta reports
    // are unaffected.
    const localDevBuild = isForgeOutDirBundlePath(
      result.runningBundlePath,
      process.platform,
      process.arch,
    );

    const persisted: PersistedAppInstallIntegrity = {
      ...result,
      runningBundlePath: redactedRunning,
      duplicateBundlePaths: redactedDupes,
      generatedAt: Date.now(),
      platform: process.platform,
      candidatesScanned: scanned,
      candidatesFound: found,
      candidatesTruncated: truncated,
    };

    try {
      await atomicWriteJson(path.join(getDataPath(), STATE_FILENAME), persisted);
    } catch (err) {
      log.warn({ err }, 'Failed to persist app-install-integrity.json');
    }

    if (result.status === 'ok') {
      log.info({ candidatesScanned: scanned, candidatesFound: found }, 'App-install integrity OK');
    } else if (localDevBuild) {
      // Expected dev-build collision (package:run vs the developer's installed
      // copy) — not a real-user incident. Detection + persisted JSON above are
      // kept; just skip the Sentry noise. Can never fire for a real install.
      log.info(
        {
          localDevBuild: true,
          status: result.status,
          duplicateCount: result.duplicateCount,
          duplicateBundlePaths: redactedDupes,
          runningBundlePath: redactedRunning,
        },
        'App-install integrity issue on a local dev build (package:run); Sentry report skipped',
      );
    } else {
      log.warn(
        {
          status: result.status,
          duplicateCount: result.duplicateCount,
          duplicateBundlePaths: redactedDupes,
          isTranslocated: result.isTranslocated,
          runningBundlePath: redactedRunning,
          candidatesScanned: scanned,
          candidatesFound: found,
          candidatesTruncated: truncated,
        },
        'App-install integrity issue detected',
      );
      try {
        const reporter = getErrorReporter();
        reporter.addBreadcrumb({
          category: 'app-install',
          message: `app install integrity: ${result.status}`,
          level: 'warning',
          data: { duplicateCount: result.duplicateCount, isTranslocated: result.isTranslocated },
        });
        reporter.captureMessage('app install integrity issue', {
          level: 'warning',
          tags: {
            'appInstall.status': result.status,
            'appInstall.duplicateCount': result.duplicateCount,
            'appInstall.translocated': result.isTranslocated,
            'appInstall.platform': process.platform,
          },
          fingerprint: ['app-install-integrity', result.status],
          contexts: {
            appInstall: {
              runningBundlePath: redactedRunning,
              runningBundleId: result.runningBundleId,
              duplicateBundlePaths: redactedDupes,
              isTranslocated: result.isTranslocated,
              candidatesScanned: scanned,
              candidatesTruncated: truncated,
            },
          },
        });
      } catch (err) {
        log.warn({ err }, 'Failed to report app-install integrity to Sentry');
      }
    }

    return result;
  } catch (err) {
    ignoreBestEffortCleanup(err, {
      operation: 'appInstallIntegrity.runCheck',
      reason: 'Integrity check is best-effort; return null on any unexpected failure',
      severity: 'warn',
    });
    return null;
  }
}

/** Stable key for a set of duplicate paths, so we warn once per unique set. */
function dismissKey(paths: string[]): string {
  return [...paths].sort().join(' ');
}

/**
 * Show a one-time native warning when true duplicate bundles exist. Skipped for
 * translocation-only (transient/common), for automated/headless contexts (no
 * user to dismiss the modal → would wedge the boot), for local developer
 * (`package:run`) builds (the duplicate is the developer's own installed copy,
 * expected and not actionable), and when the same duplicate set was already
 * dismissed. Awaits app readiness. Never throws.
 */
export async function presentDuplicateBundleWarningIfNeeded(
  result: AppInstallIntegrityResult | null,
): Promise<void> {
  if (!result || result.duplicateCount === 0) return;
  // Proven pre-whenReady early-return (beta-critical): never run a native modal
  // in automation/headless — a parent-less `[NSAlert runModal]` would wedge the
  // packaged-app E2E launch. KEPT as-is; the dialog also routes through
  // showStartupMessageBox below (defense-in-depth + the lint-enforced convention).
  if (isAutomatedOrHeadlessContext()) return;
  // Don't nag a developer running `npm run package:run`: the running app is the
  // forge build in `<repo>/out/...`, colliding with their own installed copy.
  // Never matches a real install, so real bricked-beta warnings are unaffected.
  if (isForgeOutDirBundlePath(result.runningBundlePath, process.platform, process.arch)) {
    log.info('Duplicate-bundle warning skipped for local dev build (package:run)');
    return;
  }
  try {
    const dismissPath = path.join(getDataPath(), DISMISS_FILENAME);
    const key = dismissKey(result.duplicateBundlePaths);

    let dismissed: { key?: string } = {};
    try {
      dismissed = JSON.parse(await fs.readFile(dismissPath, 'utf-8')) as { key?: string };
    } catch (err) {
      ignoreBestEffortCleanup(err, {
        operation: 'appInstallIntegrity.readDismissal',
        reason: 'No prior dismissal file; treat as not-yet-dismissed',
      });
    }
    if (dismissed.key === key) {
      log.info('Duplicate-bundle warning already dismissed for this set; skipping');
      return;
    }

    await app.whenReady();

    const plural = result.duplicateCount > 1;
    const extraList = result.duplicateBundlePaths.map((p) => `  • ${p}`).join('\n');
    const choice = await showStartupMessageBox({
      type: 'warning',
      title: plural ? 'Rebel has doppelgängers' : 'Rebel has a doppelgänger',
      message: plural
        ? 'Rebel is running, but there are other copies of it on this Mac.'
        : 'Rebel is running, but there’s another copy of it on this Mac.',
      detail:
        'Extra copies confuse the updater, so updates can quietly fail and leave you stuck on an old version. ' +
        'Keep one copy, move the rest to the Trash, then reopen Rebel.\n\n' +
        `${plural ? 'Extra copies' : 'Extra copy'}:\n${extraList}`,
      buttons: ['Open Applications Folder', 'Not now'],
      defaultId: 0,
      cancelId: 1,
    });

    if (choice.response === 0) {
      await shell.openPath('/Applications');
    }

    try {
      await atomicWriteJson(dismissPath, { key, dismissedAt: Date.now() });
    } catch (err) {
      log.warn({ err }, 'Failed to persist duplicate-bundle dismissal');
    }
  } catch (err) {
    log.warn({ err }, 'presentDuplicateBundleWarningIfNeeded threw (non-fatal)');
  }
}
