/**
 * App-install provenance (macOS, desktop-only).
 *
 * Single source of truth for "is the running app a local developer build?" —
 * shared by the install-hygiene startup nags so they don't each re-implement the
 * decision (and can't diverge on how they resolve the running bundle path):
 *   - the duplicate-bundle ("doppelgänger") warning (`appInstallIntegrityService`)
 *   - the move-to-Applications relocation offer (`appRelocationService`)
 *
 * Both nags exist for REAL end users in an updater-broken state; neither should
 * fire for a developer running `npm run package:run`, which launches the app
 * straight from the `electron-forge package` output tree (`<repo>/out/...`). The
 * positive "running from the forge out/ tree" signal lives in the pure core
 * classifier (`@core/services/diagnostics/appInstallIntegrity` →
 * `isForgeOutDirBundlePath`); this module supplies the Electron-specific input
 * (the canonical running `.app` path) and fails closed.
 */

import { app } from 'electron';
import fs from 'node:fs/promises';
import { createScopedLogger } from '@core/logger';
import { ignoreBestEffortCleanup } from '@shared/utils/intentionalSwallow';
import { isForgeOutDirBundlePath } from '@core/services/diagnostics/appInstallIntegrity';

const log = createScopedLogger({ service: 'appInstallProvenance' });

/** Resolve the `.app` bundle directory that contains an executable path. */
function bundlePathForExe(exePath: string): string | null {
  // …/Mindstone Rebel Beta.app/Contents/MacOS/Mindstone Rebel Beta → …/Mindstone Rebel Beta.app
  const marker = '.app/';
  const idx = exePath.indexOf(marker);
  if (idx === -1) return exePath.endsWith('.app') ? exePath : null;
  return exePath.slice(0, idx + marker.length - 1);
}

/**
 * Canonical (realpath'd) `.app` bundle path of the currently running app, or
 * null if it can't be resolved. Realpath matters: a developer's repo commonly
 * lives behind a symlinked ancestor (`~/dev` → /Volumes, `/private`-prefix), and
 * both consumers must see the SAME canonical path so their dev-build guards can't
 * diverge. Best-effort: falls back to the raw exe path if realpath fails.
 */
export async function resolveRunningAppBundlePath(): Promise<string | null> {
  const exePath = app.getPath('exe');
  let canonicalExe = exePath;
  try {
    canonicalExe = await fs.realpath(exePath);
  } catch (err) {
    ignoreBestEffortCleanup(err, {
      operation: 'appInstallProvenance.realpathExe',
      reason: 'realpath of running exe failed; using the raw exe path',
    });
  }
  return bundlePathForExe(canonicalExe);
}

/**
 * True iff the running app is a local developer build launched from the
 * `electron-forge package` output tree (`npm run package:run`). macOS-only and
 * fails CLOSED (returns false ⇒ keep showing install-hygiene nags) when the
 * bundle path can't be resolved. See `isForgeOutDirBundlePath` for why this never
 * matches a real distributed install (R2 safety property).
 */
export async function isRunningFromLocalForgeBuild(): Promise<boolean> {
  if (process.platform !== 'darwin') return false;
  try {
    const bundlePath = await resolveRunningAppBundlePath();
    if (!bundlePath) {
      log.info('Could not resolve running .app bundle; treating as NOT a local dev build');
      return false;
    }
    return isForgeOutDirBundlePath(bundlePath, process.platform, process.arch);
  } catch (err) {
    // Fail CLOSED: on any unexpected error (e.g. app.getPath throws) assume this
    // is NOT a dev build, so the install-hygiene nags still fire for real users.
    ignoreBestEffortCleanup(err, {
      operation: 'appInstallProvenance.isRunningFromLocalForgeBuild',
      reason: 'Unexpected error determining local-forge-build; failing closed (NOT a dev build) so real-user nags still fire',
      severity: 'warn',
    });
    return false;
  }
}
