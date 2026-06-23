/**
 * App-install integrity classification (pure, cross-surface).
 *
 * Detects two macOS install hazards that break Squirrel.Mac auto-update and
 * leave users stranded on an old build (the "bricked beta" pattern):
 *
 *  1. **Duplicate bundles** — more than one copy of the SAME app on disk
 *     (e.g. `Mindstone Rebel Beta.app` AND `Mindstone Rebel Beta 2.app`),
 *     identified by a shared `CFBundleIdentifier` at different filesystem paths.
 *     The updater swaps one bundle while the user launches the other, so updates
 *     appear to "not install". (Sentry REBEL-68D "The command is disabled and
 *     cannot be executed", REBEL-681 install-timeout cluster.)
 *
 *  2. **App Translocation** — Gatekeeper running the app from a randomised
 *     read-only `/private/var/folders/.../AppTranslocation/...` path (typically
 *     because it was launched from the DMG/Downloads without being moved to
 *     Applications). Updates can't write back to a translocated bundle.
 *
 * Matching on bundle id (NOT app name) is deliberate: the stable
 * `Mindstone Rebel.app` and the beta `Mindstone Rebel Beta.app` have DIFFERENT
 * bundle ids and legitimately coexist, so they must never flag each other.
 *
 * This module is pure (no electron / fs) so it is unit-testable and safe in
 * core. The electron-specific gathering lives in
 * `src/main/services/appInstallIntegrityService.ts`.
 */

import { posix as posixPath } from 'node:path';

/** A `.app` bundle discovered on disk. */
export interface DiscoveredBundle {
  /** Canonical (realpath'd) absolute path to the `.app` directory. */
  path: string;
  /** `CFBundleIdentifier` from the bundle's Info.plist, or null if unreadable. */
  bundleId: string | null;
  /** `CFBundleShortVersionString`, or null if unreadable. */
  shortVersion: string | null;
}

export interface AppInstallIntegrityInput {
  /** Canonical (realpath'd) `.app` path of the currently running app. */
  runningBundlePath: string;
  /** `CFBundleIdentifier` of the running app, or null if it couldn't be read. */
  runningBundleId: string | null;
  /** All `.app` bundles discovered by the scan (may include the running one). */
  discovered: DiscoveredBundle[];
  /** Whether the running app path is under macOS App Translocation. */
  isTranslocated: boolean;
}

export type AppInstallIntegrityStatus =
  | 'ok'
  | 'duplicates'
  | 'translocated'
  | 'translocated_and_duplicates';

export interface AppInstallIntegrityResult {
  runningBundlePath: string;
  runningBundleId: string | null;
  isTranslocated: boolean;
  /** Canonical paths of OTHER bundles sharing the running app's bundle id. */
  duplicateBundlePaths: string[];
  duplicateCount: number;
  status: AppInstallIntegrityStatus;
}

/** Trailing-slash-insensitive path normaliser (does not touch case). */
function normalizeBundlePath(p: string): string {
  return p.replace(/\/+$/, '');
}

/**
 * macOS App Translocation marker. Gatekeeper mounts a randomised read-only
 * copy under `.../AppTranslocation/<uuid>/d/<App>.app` when an app is launched
 * from a quarantined location without being moved to Applications.
 */
export function isAppTranslocatedPath(appPath: string): boolean {
  return appPath.includes('/AppTranslocation/');
}

/**
 * Is the running app a **local developer build** launched straight from the
 * `electron-forge package` output tree? `npm run package:run` builds to and runs
 * from `<repo>/out/<productName>-<platform>-<arch>/<productName>.app` (see
 * `scripts/resolve-packaged-app.ts` `packageDir`/`appPath` and `forge.config.cjs`
 * `appName`). This is a deliberately NARROW, POSITIVE signal of a dev build:
 * every DISTRIBUTED channel runs from a standard install instead — stable/beta
 * from `/Applications`, alpha from `~/Applications` (`package-alpha-distribution`
 * rewrites the bundle id + renames the `.app`), translocated copies from
 * `/private/var/.../AppTranslocation/...`. So this never matches a real end-user
 * install, and using it to suppress the install-hygiene nags (duplicate-bundle +
 * move-to-Applications dialogs) for developers cannot suppress a genuine
 * bricked-beta warning for a real user.
 *
 * Accepted residual edge (verified safe-by-construction in review): it WOULD
 * match a real distributed app a user somehow placed at a path shaped exactly
 * like `…/out/<productName>-<platform>-<arch>/<productName>.app` — unreachable
 * via any supported install path, so accepted rather than guarded further.
 *
 * macOS-only and **fails CLOSED**: any odd/empty/non-`.app` input, a non-darwin
 * platform, or a forge output-template change returns `false` (keep showing the
 * warning), so the safe direction on uncertainty is "nag", never "silently
 * suppress". `arch`/`platform` must be the values the app is RUNNING under
 * (`process.arch`/`process.platform`) so they match forge's build-time naming.
 */
export function isForgeOutDirBundlePath(
  runningBundlePath: string,
  platform: NodeJS.Platform,
  arch: string,
): boolean {
  if (platform !== 'darwin') return false;
  if (typeof runningBundlePath !== 'string' || runningBundlePath.length === 0) return false;
  // realpath (what the Electron seam feeds us) preserves these basenames unless a
  // path COMPONENT is itself a symlink, so basename matching is robust to the repo
  // living behind a symlinked ancestor (e.g. `~/dev` → /Volumes, `/private`-prefix).
  const normalized = normalizeBundlePath(runningBundlePath);
  const appBase = posixPath.basename(normalized);
  if (!appBase.toLowerCase().endsWith('.app')) return false;
  const productName = appBase.slice(0, -'.app'.length);
  if (productName.length === 0) return false;
  const parentDir = posixPath.basename(posixPath.dirname(normalized));
  const grandparentDir = posixPath.basename(posixPath.dirname(posixPath.dirname(normalized)));
  return grandparentDir === 'out' && parentDir === `${productName}-${platform}-${arch}`;
}

/**
 * Classify install integrity from already-gathered inputs. Pure.
 *
 * A "duplicate" is any discovered bundle whose `bundleId` equals the running
 * app's `bundleId` but whose canonical path differs. If the running bundle id
 * is unknown we cannot safely assert duplicates (we'd risk false positives), so
 * we report none.
 */
export function classifyAppInstallIntegrity(
  input: AppInstallIntegrityInput,
): AppInstallIntegrityResult {
  const { runningBundleId, discovered, isTranslocated } = input;
  const runningBundlePath = normalizeBundlePath(input.runningBundlePath);

  const duplicateBundlePaths = runningBundleId
    ? Array.from(
        new Set(
          discovered
            .filter(
              (b) =>
                b.bundleId !== null &&
                b.bundleId === runningBundleId &&
                normalizeBundlePath(b.path) !== runningBundlePath,
            )
            .map((b) => normalizeBundlePath(b.path)),
        ),
      )
    : [];

  const hasDuplicates = duplicateBundlePaths.length > 0;
  const status: AppInstallIntegrityStatus =
    isTranslocated && hasDuplicates
      ? 'translocated_and_duplicates'
      : hasDuplicates
        ? 'duplicates'
        : isTranslocated
          ? 'translocated'
          : 'ok';

  return {
    runningBundlePath,
    runningBundleId,
    isTranslocated,
    duplicateBundlePaths,
    duplicateCount: duplicateBundlePaths.length,
    status,
  };
}
