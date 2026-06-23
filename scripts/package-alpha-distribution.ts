#!/usr/bin/env npx tsx
/**
 * Produces a Drive-safe `.zip` for internal alpha distribution from the freshly-built
 * `.app` under `out/`. Use after `npm run package` (or via the combined
 * `npm run package:alpha-distribution` script).
 *
 * Why this exists:
 * - `npm run package` produces a locally ad-hoc-signed `.app` whose Electron frameworks
 *   rely on symlinks (e.g. `Foo.framework/Versions/Current` -> `A`).
 * - Uploading that `.app` directly to Google Drive strips all symlinks (Drive does not
 *   preserve them) and attaches `com.apple.FinderInfo` xattrs to every file, which
 *   destroys the bundle: dyld can't resolve frameworks, codesign refuses to re-sign
 *   ("resource fork, Finder information, or similar detritus not allowed"), and launchd
 *   refuses to spawn ("Launchd job spawn failed").
 * - Wrapping the `.app` inside a `.zip` (and uploading the zip) bypasses both problems:
 *   the zip is one opaque blob to Drive, and `ditto` preserves symlinks and macOS
 *   metadata round-trip.
 *
 * What this script does (in order):
 *   1. Resolves the freshly-built source `.app` under `out/`, sanity-checks its symlink
 *      count (catches "already round-tripped through Drive" inputs).
 *   2. Refuses to operate on a Developer ID-signed source — that's a CI-pipeline
 *      artifact; downgrading it ad-hoc would defeat its whole purpose.
 *   3. Copies to a unique temp work dir via `ditto` (preserves symlinks).
 *   4. Strips xattrs recursively (defensive; signing rejects FinderInfo).
 *   5. Mutates `CFBundleIdentifier` (for side-by-side install vs stable) and
 *      `CFBundleDisplayName` (so the Dock / Cmd-Tab show the alpha name). Leaves
 *      `CFBundleName` alone — Electron's main delegate derives helper-app paths from
 *      CFBundleName and the helper folders inside Contents/Frameworks/ are still
 *      named after the source channel (renaming them all + re-signing would be a much
 *      larger surgery; the DisplayName override is enough for recipient UX).
 *   6. Re-signs ad-hoc with Hardened Runtime + the CI entitlements file
 *      (`build/entitlements.mac.plist`) so the local alpha behaves like a real build
 *      at runtime (JIT, native modules, etc.).
 *   7. Verifies the signature.
 *   8. Drops in a `.command` shim that strips quarantine and opens the app, plus a brief
 *      README, then archives the whole folder to a `.zip` with `ditto -c -k --keepParent`.
 *
 * Output:
 *   dist/alpha/Mindstone-Rebel-Alpha-<version>-<YYMMDD-HHmm>-<arch>.zip
 *
 * Zip contents (single top-level folder):
 *   Mindstone Rebel Alpha <version>/
 *     Mindstone Rebel Alpha.app                         (CFBundleIdentifier=com.mindstone.rebel.alpha)
 *     Open Mindstone Rebel Alpha (first time).command   (installs to ~/Applications/, launches)
 *     READ ME FIRST.txt                                  (short recipient instructions)
 *
 * Recipient flow:
 *   1. Download zip from Drive, unzip (anywhere).
 *   2. Double-click `Open Mindstone Rebel Alpha (first time).command` once. The shim:
 *        - Copies the .app to `~/Applications/` (necessary because if the unzipped
 *          folder is iCloud-synced or cloud-mirrored — Desktop / Documents under
 *          "Desktop & Documents in iCloud Drive", Google Drive File Stream, Dropbox,
 *          OneDrive — the file provider attaches `com.apple.FinderInfo` /
 *          `com.apple.fileprovider.fpfs#P` xattrs that invalidate the ad-hoc signature.
 *          ~/Applications/ is the standard per-user app folder, not file-provider-
 *          monitored, and `xattr -cr` actually succeeds there).
 *        - Strips all xattrs at the installed location.
 *        - Opens the installed .app. macOS may prompt the first time — click Open.
 *   3. Subsequently: open the .app from ~/Applications/ directly, or re-run the
 *      .command to upgrade (it overwrites the existing install).
 *
 * Caveats:
 * - macOS-only. Bails on Linux/Windows.
 * - Local ad-hoc signature only — not Developer ID signed, not notarized. The proper
 *   distribution path is the CI release pipeline (push to `dev` with `[deploy-beta]` in
 *   the commit message). This script is strictly for internal alpha testers.
 * - Different `CFBundleIdentifier` means the alpha has its own
 *   `~/Library/Application Support/Mindstone Rebel Alpha/` directory. Testers will need
 *   to sign in / configure providers fresh (which is often what you want for an alpha).
 * - Auto-update is effectively disabled — the update manifest's bundle ID won't match,
 *   so checks fail silently.
 *
 * Exit codes:
 *   0 success
 *   1 packaged .app not found (run `npm run package` first)
 *   2 unsupported platform
 *   3 bundle symlink sanity check failed (source .app is already corrupted)
 *   4 codesign step failed
 *   5 ditto archive step failed
 *   6 source bundle has Developer ID signature — use the CI pipeline instead
 *   7 unexpected runtime error (uncaught exception in main())
 */
import { execFileSync, spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { REPO_ROOT, resolvePackagedAppPaths } from './resolve-packaged-app';

const DIST_ALPHA_DIR = path.join(REPO_ROOT, 'dist', 'alpha');
const ENTITLEMENTS_PATH = path.join(REPO_ROOT, 'build', 'entitlements.mac.plist');

const sourcePaths = resolvePackagedAppPaths();
const alphaProductName = sourcePaths.isBeta
  ? 'Mindstone Rebel Beta Alpha'
  : 'Mindstone Rebel Alpha';
const alphaBundleId = `${sourcePaths.bundleId}.alpha`;

const LOG_PREFIX = '[package-alpha-distribution]';

class FatalError extends Error {
  readonly exitCode: number;
  constructor(message: string, exitCode: number) {
    super(message);
    this.name = 'FatalError';
    this.exitCode = exitCode;
  }
}

function fatal(message: string, code: number): never {
  throw new FatalError(message, code);
}

function readPackageVersion(): string {
  const pkgPath = path.join(REPO_ROOT, 'package.json');
  let raw: string;
  try {
    raw = readFileSync(pkgPath, 'utf8');
  } catch (err) {
    fatal(`Could not read ${pkgPath}: ${(err as Error).message}`, 7);
  }
  let pkg: { version?: string };
  try {
    pkg = JSON.parse(raw);
  } catch (err) {
    fatal(`Could not parse ${pkgPath}: ${(err as Error).message}`, 7);
  }
  if (!pkg.version) fatal('package.json has no version field', 7);
  return pkg.version;
}

function timestampStamp(d: Date = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${String(d.getFullYear()).slice(2)}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
}

function resolveSourceApp(): string {
  if (sourcePaths.platform !== 'darwin') {
    fatal(`Unsupported platform: ${sourcePaths.platform}. This script is macOS-only.`, 2);
  }
  if (!existsSync(sourcePaths.appPath)) {
    fatal(
      `Packaged .app not found at:\n  ${sourcePaths.appPath}\n` +
        `Run \`npm run package\` first (arch=${sourcePaths.arch}, channel=${sourcePaths.channel}).`,
      1,
    );
  }
  return sourcePaths.appPath;
}

interface RunResult {
  status: number;
  stdout: string;
  stderr: string;
}

function run(cmd: string, args: string[], opts: { allowFail?: boolean; exitCode?: number } = {}): RunResult {
  const result = spawnSync(cmd, args, { encoding: 'utf8' });
  if (result.error) {
    if (opts.allowFail) return { status: 1, stdout: '', stderr: result.error.message };
    fatal(`Failed to spawn ${cmd}: ${result.error.message}`, opts.exitCode ?? 7);
  }
  const status = result.status ?? 1;
  const stdout = result.stdout ?? '';
  const stderr = result.stderr ?? '';
  if (status !== 0 && !opts.allowFail) {
    fatal(
      `${cmd} ${args.join(' ')} exited ${status}\nstdout: ${stdout}\nstderr: ${stderr}`,
      opts.exitCode ?? 4,
    );
  }
  return { status, stdout, stderr };
}

function countSymlinks(dir: string): number {
  try {
    const result = execFileSync('find', [dir, '-type', 'l'], { encoding: 'utf8' });
    return result.split('\n').filter((line) => line.length > 0).length;
  } catch (err) {
    fatal(`Failed to scan symlinks under ${dir}: ${(err as Error).message}`, 7);
  }
}

interface SignatureInfo {
  isDeveloperId: boolean;
}

function inspectSignature(appPath: string): SignatureInfo {
  const result = spawnSync('codesign', ['-dv', '--verbose=4', appPath], { encoding: 'utf8' });
  if (result.error) {
    fatal(`codesign -dv failed to spawn: ${result.error.message}`, 7);
  }
  const combined = (result.stdout ?? '') + (result.stderr ?? '');
  if ((result.status ?? 1) !== 0 && !/Signature=/i.test(combined)) {
    console.warn(
      `${LOG_PREFIX} codesign -dv produced no parseable signature info; assuming unsigned/ad-hoc.`,
    );
    return { isDeveloperId: false };
  }
  const isDeveloperId = /Authority=Developer ID Application:/i.test(combined);
  return { isDeveloperId };
}

function humanFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function writeOpener(openerPath: string, appBasename: string): void {
  // Why this shim always relocates rather than stripping xattrs in place:
  //   If the recipient unzips into an iCloud-synced folder (e.g. ~/Desktop or
  //   ~/Documents under "Desktop & Documents in iCloud Drive") or any other
  //   file-provider-monitored path (Google Drive File Stream, Dropbox, OneDrive),
  //   the provider attaches `com.apple.FinderInfo` and
  //   `com.apple.fileprovider.fpfs#P` xattrs to the .app. Those xattrs invalidate
  //   ad-hoc code signatures ("resource fork, Finder information, or similar
  //   detritus not allowed") and the provider re-attaches them immediately if
  //   stripped, so the strip-then-launch race is unwinnable in place.
  //   The only reliable fix is to copy the .app to a non-monitored location and
  //   launch from there. ~/Applications/ is the conventional per-user app
  //   directory; macOS handles it correctly and it's outside the iCloud
  //   Desktop/Documents sync scope.
  const script = `#!/bin/bash
set -euo pipefail
SRC_DIR="$(cd "$(dirname "$0")" && pwd)"
APP_NAME="${appBasename}"
SRC_APP="$SRC_DIR/$APP_NAME"
if [ ! -d "$SRC_APP" ]; then
  echo "Could not find $SRC_APP" >&2
  exit 1
fi
TARGET_DIR="$HOME/Applications"
TARGET_APP="$TARGET_DIR/$APP_NAME"
STAGING_APP="$TARGET_DIR/.$APP_NAME.installing.$$"
mkdir -p "$TARGET_DIR"
# Atomic-replace pattern: copy to staging, then swap. If ditto fails mid-copy, the
# existing install (if any) stays as a fallback.
rm -rf "$STAGING_APP"
echo "Installing to $TARGET_APP..."
ditto "$SRC_APP" "$STAGING_APP"
echo "Stripping macOS quarantine and other xattrs..."
xattr -cr "$STAGING_APP" 2>/dev/null || true
if [ -d "$TARGET_APP" ]; then
  rm -rf "$TARGET_APP"
fi
mv "$STAGING_APP" "$TARGET_APP"
echo "Launching..."
open "$TARGET_APP"
`;
  writeFileSync(openerPath, script, { encoding: 'utf8' });
  chmodSync(openerPath, 0o755);
}

function writeReadme(readmePath: string, version: string, timestamp: string): void {
  // Tone: dry, matter-of-fact, clear over clever (Rebel brand voice).
  const appBasename = `${alphaProductName}.app`;
  const openerBasename = `Open ${alphaProductName} (first time).command`;
  const content = `${alphaProductName} ${version} — built ${timestamp}

This is an internal alpha build. It is not signed with our Developer ID and not
notarized by Apple, so macOS Gatekeeper would normally refuse to open it.

First time:
  Double-click "${openerBasename}".
  It installs the app to ~/Applications/, strips macOS quarantine, and launches.
  macOS may show a dialog the first time — click Open to confirm.

After that:
  Open "${appBasename}" from your ~/Applications/ folder directly.

If the .command file doesn't run for some reason, do the same thing manually
in Terminal. \`cd\` into this unzipped folder first, then:

  cd "/path/to/this/unzipped/folder"
  mkdir -p ~/Applications
  ditto "${appBasename}" "$HOME/Applications/${appBasename}"
  xattr -cr "$HOME/Applications/${appBasename}"
  open "$HOME/Applications/${appBasename}"

Notes:
  - The shim copies the .app to ~/Applications/ because the folder you unzip into
    might be iCloud-synced or cloud-mirrored (Desktop, Documents, Google Drive
    File Stream, etc.). Those services attach metadata that breaks ad-hoc-signed
    app bundles. ~/Applications/ is the standard per-user app folder and isn't
    monitored. Run the .command again to upgrade — it will replace the existing
    install.
  - This alpha has its own bundle ID (${alphaBundleId}), so it
    coexists with stable / beta installs without confusing LaunchServices.
  - It also uses its own data directory
    (~/Library/Application Support/${alphaProductName}/), so you'll need to
    sign in to model providers from scratch. That's intentional — alpha state
    is meant to be ephemeral.
  - Don't rely on auto-update for this build. To upgrade, grab a newer zip
    from the same Drive folder and install it.

Questions: ask in #engineering on Slack.
`;
  writeFileSync(readmePath, content, { encoding: 'utf8' });
}

function mainBody(): void {
  const sourceApp = resolveSourceApp();
  const version = readPackageVersion();
  const timestamp = timestampStamp();
  const arch = process.arch;

  console.log(`${LOG_PREFIX} Source: ${sourceApp}`);
  console.log(`${LOG_PREFIX} Version: ${version}`);
  console.log(`${LOG_PREFIX} Timestamp: ${timestamp}`);
  console.log(`${LOG_PREFIX} Arch: ${arch}`);

  // Symlink sanity check on the source. A freshly-built electron-packager .app should
  // have many hundreds of symlinks. Below a low threshold means the source has likely
  // already been round-tripped through Drive (or similar) and we'd produce a broken
  // artifact.
  const sourceSymlinks = countSymlinks(sourceApp);
  console.log(`${LOG_PREFIX} Source bundle symlink count: ${sourceSymlinks}`);
  if (sourceSymlinks < 10) {
    fatal(
      `Source .app has only ${sourceSymlinks} symlinks — bundle looks corrupted ` +
        `(likely already round-tripped through Google Drive or similar). Re-run ` +
        `\`npm run package\` to rebuild a clean bundle.`,
      3,
    );
  }

  // Refuse to operate on Dev-ID-signed builds. Mutating Info.plist + re-signing ad-hoc
  // would silently downgrade the proper signature, which is exactly what you do not
  // want.
  const sourceSig = inspectSignature(sourceApp);
  if (sourceSig.isDeveloperId) {
    fatal(
      `Source .app appears to be Developer ID signed. This script is for unsigned ` +
        `local builds; mutating its bundle ID and re-signing ad-hoc would downgrade ` +
        `the proper signature. Use the CI release pipeline for Dev-ID distributions ` +
        `(push to \`dev\` with \`[deploy-beta]\`).`,
      6,
    );
  }

  mkdirSync(DIST_ALPHA_DIR, { recursive: true });

  // Unique work dir so concurrent invocations don't collide.
  const workDir = mkdtempSync(path.join(DIST_ALPHA_DIR, '.work-'));
  const folderInZip = `${alphaProductName} ${version}`;
  const folderDir = path.join(workDir, folderInZip);
  mkdirSync(folderDir, { recursive: true });

  const stagedAppBasename = `${alphaProductName}.app`;
  const stagedApp = path.join(folderDir, stagedAppBasename);
  const zipBasename = `${alphaProductName.replace(/ /g, '-')}-${version}-${timestamp}-${arch}.zip`;
  const zipPath = path.join(DIST_ALPHA_DIR, zipBasename);

  let zipCreated = false;
  let workDirCleanedUp = false;

  try {
    console.log(`${LOG_PREFIX} Copying .app to work dir via ditto (preserves symlinks)...`);
    run('ditto', [sourceApp, stagedApp]);

    console.log(`${LOG_PREFIX} Stripping extended attributes recursively...`);
    run('xattr', ['-cr', stagedApp]);

    const stagedSymlinks = countSymlinks(stagedApp);
    console.log(`${LOG_PREFIX} Staged bundle symlink count: ${stagedSymlinks}`);
    if (stagedSymlinks < 10) {
      fatal(`Staged .app has only ${stagedSymlinks} symlinks after ditto — investigate.`, 3);
    }

    // Info.plist mutation: change bundle ID + name so the alpha installs alongside
    // stable on the same Mac and shows its own labels everywhere. These three fields
    // have no Apple-format constraints (unlike CFBundleShortVersionString).
    const plistPath = path.join(stagedApp, 'Contents', 'Info.plist');
    if (!existsSync(plistPath)) {
      fatal(`Info.plist missing at ${plistPath} — staged bundle is malformed.`, 7);
    }
    // CFBundleName is intentionally left untouched. Electron's main delegate computes
    // helper-app paths from the main bundle's CFBundleName
    // (e.g. `<CFBundleName> Helper.app` -> `Mindstone Rebel Helper.app`); the helper
    // folders inside Contents/Frameworks/ are produced by electron-forge under the
    // source channel's name and we do not rename them. Mutating CFBundleName to
    // "Mindstone Rebel Alpha" makes Electron look for "Mindstone Rebel Alpha Helper.app"
    // which doesn't exist, and the app aborts with
    //   FATAL: Unable to find helper app (electron_main_delegate_mac.mm:65).
    // CFBundleDisplayName is what macOS shows in the Dock / Cmd-Tab / About window
    // when present, so setting it to the alpha name still gives recipients a
    // distinguishable label.
    console.log(`${LOG_PREFIX} Setting CFBundleIdentifier=${alphaBundleId} and CFBundleDisplayName=${alphaProductName}...`);
    run('plutil', ['-replace', 'CFBundleIdentifier', '-string', alphaBundleId, plistPath]);
    run('plutil', ['-replace', 'CFBundleDisplayName', '-string', alphaProductName, plistPath]);

    // Re-sign unconditionally — we just mutated Info.plist, which invalidates any prior
    // signature. Apply Hardened Runtime + the CI entitlements file so the alpha runs
    // with the same V8 JIT / native-module permissions as a proper build.
    if (!existsSync(ENTITLEMENTS_PATH)) {
      fatal(`Entitlements file not found at ${ENTITLEMENTS_PATH}.`, 7);
    }
    console.log(`${LOG_PREFIX} Re-signing ad-hoc with Hardened Runtime + entitlements...`);
    run('codesign', [
      '--force',
      '--deep',
      '--sign',
      '-',
      '--options',
      'runtime',
      '--entitlements',
      ENTITLEMENTS_PATH,
      stagedApp,
    ]);

    console.log(`${LOG_PREFIX} Verifying signature...`);
    run('codesign', ['--verify', '--deep', '--strict', '--verbose=2', stagedApp]);

    const openerPath = path.join(folderDir, `Open ${alphaProductName} (first time).command`);
    writeOpener(openerPath, stagedAppBasename);

    const readmePath = path.join(folderDir, 'READ ME FIRST.txt');
    writeReadme(readmePath, version, timestamp);

    if (existsSync(zipPath)) {
      rmSync(zipPath);
    }

    console.log(`${LOG_PREFIX} Archiving to zip via ditto (preserves symlinks)...`);
    // `--keepParent` makes the zip contain the staging dir as a top-level folder.
    // We deliberately omit `--sequesterRsrc` to avoid AppleDouble (`._*`) clutter in
    // the resulting zip — modern macOS unzip handles xattrs without it, and we already
    // ran `xattr -cr` above so there is nothing to sequester.
    const dittoArchive = spawnSync(
      'ditto',
      ['-c', '-k', '--keepParent', folderDir, zipPath],
      { encoding: 'utf8' },
    );
    if (dittoArchive.error) {
      fatal(`ditto archive failed to spawn: ${dittoArchive.error.message}`, 5);
    }
    if ((dittoArchive.status ?? 1) !== 0) {
      fatal(
        `ditto archive failed: status=${dittoArchive.status}\nstdout: ${dittoArchive.stdout}\nstderr: ${dittoArchive.stderr}`,
        5,
      );
    }
    zipCreated = true;

    // Post-archive sanity check: zip exists and is non-trivial.
    if (!existsSync(zipPath)) {
      fatal(`ditto reported success but ${zipPath} does not exist.`, 5);
    }
    const zipSize = statSync(zipPath).size;
    if (zipSize < 1024 * 1024) {
      // < 1 MB is implausibly small for an Electron app zip (~100-500 MB typical).
      fatal(`Produced zip is ${humanFileSize(zipSize)} — implausibly small. Aborting.`, 5);
    }

    // Cleanup work dir only on full success.
    rmSync(workDir, { recursive: true, force: true });
    workDirCleanedUp = true;

    console.log('');
    console.log('================================================================');
    console.log('  Alpha distribution zip ready');
    console.log('================================================================');
    console.log(`  Path: ${zipPath}`);
    console.log(`  Size: ${humanFileSize(zipSize)}`);
    console.log(`  Bundle ID: ${alphaBundleId}`);
    console.log('');
    console.log('  Upload to:');
    console.log('    Google Drive > Shared drives > Product > Testing-apps');
    console.log('');
    console.log('  Tell recipients:');
    console.log('    1. Download the zip, unzip.');
    console.log('    2. Inside the unzipped folder, double-click');
    console.log(`       "Open ${alphaProductName} (first time).command".`);
    console.log('       (macOS may prompt on first run — click Open.)');
    console.log(`       The shim installs the app to ~/Applications/ and launches it.`);
    console.log(`    3. Subsequent launches: open ${alphaProductName}.app from`);
    console.log('       ~/Applications/, or re-run the .command to upgrade.');
    console.log('================================================================');
  } catch (err) {
    // Cleanup partial zip on failure; leave work dir for inspection.
    if (zipCreated && existsSync(zipPath)) {
      try {
        rmSync(zipPath);
      } catch {
        // Best-effort.
      }
    } else if (!zipCreated && existsSync(zipPath)) {
      // Pre-existing zip we may have started writing to.
      try {
        rmSync(zipPath);
      } catch {
        // Best-effort.
      }
    }
    if (!workDirCleanedUp) {
      console.error(`${LOG_PREFIX} Leaving work dir for inspection: ${workDir}`);
    }
    throw err;
  }
}

function main(): void {
  try {
    mainBody();
  } catch (err) {
    if (err instanceof FatalError) {
      console.error(`${LOG_PREFIX} ERROR: ${err.message}`);
      process.exit(err.exitCode);
    }
    console.error(`${LOG_PREFIX} Unexpected error: ${(err as Error).stack ?? String(err)}`);
    process.exit(7);
  }
}

main();
