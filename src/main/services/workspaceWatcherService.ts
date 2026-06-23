/**
 * Workspace Watcher Service
 *
 * Single chokidar instance for watching workspace file changes.
 * Emits events that multiple subscribers can listen to:
 * - libraryBroadcaster: UI refresh notifications
 * - fileWatcherService: semantic indexing queue
 *
 * This consolidation reduces file descriptor usage by ~50% compared to
 * having separate watchers for each concern.
 */

import { EventEmitter } from 'node:events';
import type { Stats } from 'node:fs';
import { statSync, readdirSync } from 'node:fs';
import { stat as statAsync } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { watch, type FSWatcher } from 'chokidar';
import { logger } from '@core/logger';
import { getErrorReporter } from '@core/errorReporter';
import { getPlatformConfig } from '@core/platform';
import { DEFAULT_SAFE_WALK_LIMITS } from '@core/utils/safeWalkDirectory';
import { walkToFirstCloudHopViaReadlink } from '@core/utils/readlinkChain';
import { runWithTimeout } from '@core/utils/withTimeout';
import {
  detectCloudStorage,
  detectInPlaceCloudDocuments,
  getTimeoutForPath,
} from '../utils/cloudStorageUtils';
import { fireAndForget } from '@shared/utils/fireAndForget';
import { ignoreBestEffortCleanup } from '@shared/utils/intentionalSwallow';

const MAX_WATCH_DEPTH = 12;
/**
 * One-shot guard for the packaged-darwin polling-fallback Sentry warning event
 * (review F2). The warn is a captured warning EVENT (not merely a breadcrumb),
 * so a re-ready / re-watch cycle must not re-emit it and spam Sentry. Module-level
 * (per-process) so it survives watcher restart but resets on relaunch.
 */
let warnedPollingFallbackOnce = false;
const WORKSPACE_PATH_CAP_WARNED_DIRECTORIES_MAX = 32;
const WORKSPACE_PATH_CAP_LOG_DIRECTORY_MAX_LENGTH = 200;
const workspacePathCapWarnedDirectories = new Set<string>();

/**
 * How long to wait for a bounded `stat` of a CLOUD-storage workspace root before
 * giving up and deferring the watch. We use the path-aware cloud budget
 * (`getTimeoutForPath`, 15s) so a slow-but-alive Drive mount still gets a fair
 * chance, while a genuinely DEAD mount can no longer block `start()` forever (a
 * synchronous `statSync` on a dead FUSE mount blocks in the kernel with no
 * timeout — the exact pool-parking I/O we are eliminating). Local roots keep the
 * cheap synchronous `statSync` and never pay this cost.
 */
const CLOUD_ROOT_STAT_TIMEOUT_MS = 15_000;

/**
 * After a cloud workspace root's bounded validate-stat times out (a likely-dead
 * mount), retry installing the watch on this cadence. The mount may come back
 * (network reconnect, Drive client restart) and the user expects file changes to
 * be picked up once it does — without a retry the watcher would stay dark until
 * the next workspace switch / app restart.
 */
const CLOUD_ROOT_RETRY_INTERVAL_MS = 60_000;

/**
 * FS error codes we treat as transient/expected from chokidar's internal lstat
 * passes (pre-existing branches log them, and unknown codes were previously
 * promoted to fatal-unhandled because EventEmitter.emit('error') threw with no
 * subscribers — see REBEL-1HK / REBEL-56E). We now never crash, but explicitly
 * report novel codes to Sentry so we keep regression visibility for new failure
 * modes that aren't in this allow-list.
 */
const KNOWN_TRANSIENT_WATCHER_ERROR_CODES = new Set([
  'ENOSPC',
  'EMFILE',
  'ENFILE',
  'ENAMETOOLONG',
  'EINVAL',
  'UNKNOWN',
  'EBUSY',
  'EPERM',
  'EACCES',
  'ENOENT',
]);

function maybeLogWorkspacePathCap(pathToIgnore: string): void {
  const parentDirectory = dirname(pathToIgnore);
  if (workspacePathCapWarnedDirectories.has(parentDirectory)) {
    return;
  }

  if (workspacePathCapWarnedDirectories.size >= WORKSPACE_PATH_CAP_WARNED_DIRECTORIES_MAX) {
    workspacePathCapWarnedDirectories.clear();
  }

  workspacePathCapWarnedDirectories.add(parentDirectory);
  logger.warn(
    { directory: parentDirectory.slice(0, WORKSPACE_PATH_CAP_LOG_DIRECTORY_MAX_LENGTH), capped: true },
    'workspace watcher path-length cap fired (recursive loop suspected)'
  );
}

/**
 * Unified ignore patterns - merged from libraryWatcherService and fileWatcherService.
 * This is the superset of both, ensuring consistent behavior.
 */
const WORKSPACE_IGNORE_PATTERNS: (string | RegExp | ((path: string) => boolean))[] = [
  // Version control
  '**/.git/**',
  '**/.svn/**',
  '**/.hg/**',

  // Dependencies
  '**/node_modules/**',
  '**/bower_components/**',
  '**/vendor/**',
  '**/packages/**',

  // Build outputs
  '**/dist/**',
  '**/build/**',
  '**/out/**',
  '**/.next/**',
  '**/.nuxt/**',
  '**/.output/**',
  '**/target/**',

  // Cache directories
  '**/.cache/**',
  '**/.parcel-cache/**',
  '**/.turbo/**',
  '**/.eslintcache',
  '**/.stylelintcache',
  '**/.*cache*',
  '**/.*_cache*',

  // Application data directories
  '**/.obsidian/**',
  '**/.leann/**',
  '**/.rebel/**',

  // Index/database files
  '**/*.idx',
  '**/*.index',

  // Test coverage
  '**/coverage/**',
  '**/.nyc_output/**',

  // Python
  '**/__pycache__/**',
  '**/.pytest_cache/**',
  '**/venv/**',
  '**/.venv/**',
  '**/env/**',
  '**/*.egg-info/**',

  // IDE/Editor
  '**/.idea/**',
  '**/.vscode/**',
  '**/*.swp',
  '**/*.swo',
  '**/*~',

  // OS files
  '**/.DS_Store',
  '**/Thumbs.db',
  '**/desktop.ini',

  // Lock files
  '**/package-lock.json',
  '**/yarn.lock',
  '**/pnpm-lock.yaml',
  '**/Gemfile.lock',
  '**/Cargo.lock',
  '**/poetry.lock',
  '**/composer.lock',

  // Logs
  '**/*.log',
  '**/logs/**',

  // Minified/compiled assets
  '**/*.min.js',
  '**/*.min.css',
  '**/*.map',
  '**/*.chunk.*',

  // Binary/media files
  '**/*.png',
  '**/*.jpg',
  '**/*.jpeg',
  '**/*.gif',
  '**/*.ico',
  '**/*.svg',
  '**/*.webp',
  '**/*.mp3',
  '**/*.mp4',
  '**/*.wav',
  '**/*.avi',
  '**/*.mov',
  '**/*.pdf',
  '**/*.zip',
  '**/*.tar',
  '**/*.gz',
  '**/*.rar',
  '**/*.7z',
  '**/*.exe',
  '**/*.dll',
  '**/*.so',
  '**/*.dylib',
  '**/*.woff',
  '**/*.woff2',
  '**/*.ttf',
  '**/*.eot',

  // Temporary files
  '**/*.tmp',
  '**/*.temp',
  '**/tmp/**',
  '**/temp/**',

  // Environment and secret files
  '**/.env',
  '**/.env.*',
  '**/.env.local',
  '**/.env.*.local',
  '**/*.pem',
  '**/*.key',
  '**/*.crt',
  '**/*.p12',
  '**/*.pfx',
  '**/id_rsa*',
  '**/id_ed25519*',
  '**/*.secret',
  '**/*.secrets',
  '**/credentials*',
  '**/secrets/**',
  '**/.secrets/**',

  // System-managed workspace symlink (prevents UI refresh storms during skill updates)
  '**/rebel-system',
  '**/rebel-system/**',

  // Maintenance lease files (REBEL-1HK / REBEL-567 cluster). On Windows OneDrive
  // workspaces these live under Documents\Mindstone Rebel\… and chokidar's
  // internal lstat/stat races OneDrive's Files-On-Demand placeholder hydration,
  // producing transient EINVAL/UNKNOWN/EBUSY that escape as fatal errors.
  '**/.rebel-maintenance.lock.json',
  '**/.rebel-maintenance.lock.json.*',

  // Structural path-length cap aligned with safeWalkDirectory's portable safety
  // budget. 900 is below PATH_MAX on supported platforms (macOS 1024, Linux
  // 4096, Windows 260 default), so recursive loops are short-circuited before
  // chokidar attempts deeper traversal. See REBEL-1HK / REBEL-56E and
  // docs-private/investigations/260506_enametoolong_chokidar_loop.md.
  (candidatePath: string) => {
    if (candidatePath.length <= DEFAULT_SAFE_WALK_LIMITS.MAX_PATH_LENGTH) {
      return false;
    }

    maybeLogWorkspacePathCap(candidatePath);
    return true;
  },
];

// Re-export for fileWatcherService's manual discovery
// WORKSPACE_IGNORE_PATTERNS is used internally only

/**
 * Canonicalise a watch path so the cloud-symlink matcher can compare a
 * precomputed symlink root against the candidate chokidar tests, regardless of
 * slash flavour or how many times the value has already been normalised.
 *
 * This mirrors chokidar's `anymatch`/`normalize-path(p, false)` (chokidar 3.6.0:
 * `anymatch/index.js` line 50) — collapse any run of `/` or `\` to a single `/` —
 * but with one deliberate strengthening: it is **idempotent**. We replicate the
 * logic locally rather than importing `normalize-path` because it is only a
 * transitive dependency (chokidar → anymatch → normalize-path) and would become a
 * phantom dependency on a chokidar major bump.
 *
 * Why idempotency matters (the bug this closes): chokidar feeds the `ignored`
 * function matcher a candidate that anymatch has ALREADY run through
 * `normalize-path`, so by the time it reaches us a `\\?\C:\…` path arrives as
 * `//?/C:/…` (forward slashes, double-slash prefix preserved). The precomputed
 * symlink root, however, is built from the raw OS-native path. `normalize-path`
 * itself is NOT idempotent on the win32 device-namespace prefixes (`\\?\`,
 * `\\?\UNC\`, `\\.\`): it preserves the `//` only when it sees BACKSLASHES, so a
 * second pass over the forward-slash form collapses `//?/` → `/?/`. If we mirrored
 * that non-idempotency, the candidate (`/?/…`, normalised twice) would fall out of
 * phase with the stored root (`//?/…`, normalised once) and a cloud symlink under
 * a `\\?\` / `\\?\UNC` / `\\.\` workspace root would still be traversed — the same
 * double-slash-collapse class as the original plain-UNC bug. By detecting the
 * device-namespace prefix on EITHER slash flavour we always emit `//?/…` / `//./…`
 * and both sides stay in phase.
 *
 * Plain UNC (`\\server\share`) still collapses to `/server/share` (one leading
 * slash) — which is why naive `toPortablePath` (`//server/share`, two leading
 * slashes) was out of phase originally. POSIX-absolute and drive-letter paths are
 * unaffected. See the workspaceWatcherService tests.
 */
function normalizeWatchPath(value: string): string {
  if (value === '\\' || value === '/') return '/';
  if (value.length <= 1) return value;

  let prefix = '';
  // Win32 device-namespace prefix — `\\?\`, `\\?\UNC\`, `\\.\` or any already
  // slash-normalised form (`//?/`, `//./`). Detect on either slash flavour so the
  // result is idempotent, and preserve a single canonical `//` prefix.
  if (
    value.length > 4 &&
    (value[0] === '\\' || value[0] === '/') &&
    (value[1] === '\\' || value[1] === '/') &&
    (value[2] === '?' || value[2] === '.') &&
    (value[3] === '\\' || value[3] === '/')
  ) {
    value = value.slice(2);
    prefix = '//';
  }

  return prefix + value.split(/[/\\]+/).join('/');
}

/**
 * The chokidar/anymatch contract for a FUNCTION `ignored` matcher. chokidar
 * watches with `{ alwaysStat: true, lstat: true }`, so for every candidate it
 * has an `lstat` and anymatch invokes our matcher as `(candidatePath, stats)`
 * (anymatch `matchPatterns`: `pattern(...[path].concat(args.slice(1)))`).
 * `stats.isSymbolicLink()` therefore reliably identifies a symlink at ANY depth,
 * which is what lets us catch NESTED cloud symlinks — not just top-level ones.
 */
type WatcherIgnoreMatcher = (candidatePath: string, stats?: Stats) => boolean;

/**
 * Classify a symlink as cloud-backed or local using ONLY `readlinkSync` — never
 * `realpathSync`/`stat` (which canonicalise/probe the chain and would block IN
 * the dead cloud mount, the exact I/O we are preventing chokidar from doing).
 *
 * `readlinkSync` reads the link's OWN inode (in the local parent directory) and
 * returns its raw target without touching the target. We then walk the chain
 * one hop at a time, checking the cloud pattern at EVERY hop: a Drive link may be
 * chained through an intermediate LOCAL alias
 * (`workspace/link → ~/DriveAlias → ~/Library/CloudStorage/GoogleDrive-…`), so an
 * absolute non-cloud first target does NOT prove the final destination is local
 * (GPT review F1). We stop when `readlinkSync` reports `EINVAL` ("not a symlink",
 * i.e. a real file/dir — the chain bottomed out locally) and FAIL CLOSED on any
 * other error (`ENOENT`/`EACCES`/`ELOOP`/timeout/etc.) or on exceeding the hop
 * cap.
 *
 * Returns:
 *  - `{ skip: true }`  — a hop matched a cloud-storage pattern, OR we could not
 *    prove the chain is local (fail-closed). EXCLUDE from the watch.
 *  - `{ skip: false }` — the chain provably bottomed out at a non-cloud local
 *    path. Keep watching (preserves `rebel-system → /Applications/…`,
 *    `Shared Notes → ~/Projects/…`).
 */
function classifySymlinkChainViaReadlink(symlinkPath: string): { skip: boolean } {
  // Stage-1 carry-forward: this is the SHARED `readlinkChain` walker
  // (`walkToFirstCloudHopViaReadlink`) — the watcher no longer carries its own
  // copy. Behaviour is byte-identical to the previous in-file classifier: a
  // proven cloud hop OR any non-EINVAL error / hop-cap (fail-closed
  // `unclassifiable`) ⇒ EXCLUDE; only a provable non-cloud terminus
  // (`local-terminus`) keeps the symlink watched (preserves
  // `rebel-system → /Applications/…`). The shared helper checks the cloud pattern
  // on BOTH the raw and parent-resolved target at every hop and NEVER touches the
  // (possibly dead) target — exactly as before.
  const result = walkToFirstCloudHopViaReadlink(symlinkPath);
  if (result.kind === 'local-terminus') return { skip: false }; // provably local → watch

  // S4.2 (260619_cloud-symlink-indexing): cloud symlinks are ALWAYS excluded from the
  // live chokidar watch. The Stage-6b live-watch admission override (admit a healthy
  // cloud subtree into the watch) is RETIRED — a dead admitted mount's internal
  // lstat/readdir parked libuv workers (the original hang class), and the boundary +
  // periodic re-walk now keep a healthy cloud space indexed without live-watching it.
  // A PROVEN cloud hop OR any fail-closed `unclassifiable` chain ⇒ EXCLUDE.
  return { skip: true };
}

/**
 * Build a chokidar `ignored` matcher that excludes symlinks — at ANY depth —
 * whose target is a known cloud-storage mount (Google Drive / OneDrive / Dropbox
 * / iCloud / Box), the symlink itself AND its entire subtree.
 *
 * WHY THIS MATTERS (root cause — docs/plans/260619_turn-hang-bugmode/PLAN.md):
 * chokidar watches with `followSymlinks: true` (a real product requirement —
 * users symlink external local folders into their workspace, and the
 * `rebel-system → /Applications/…` skills symlink MUST keep being followed). When
 * a symlink points into a chronically-unresponsive Google Drive FUSE mount,
 * chokidar's recursive `lstat`/`readdir` pass blocks IN THE KERNEL with no
 * timeout, parking all 4 libuv threadpool workers. That exhausts the shared pool,
 * starving the agent turn's own pre-dispatch fs reads (and DNS) → turns hang and
 * never reach the model. So the watcher must NEVER `stat`/descend into a cloud
 * mount, even via a nested symlink, even if cloud-detection enumeration fails.
 *
 * TWO-TIER detection, both via the SAME function matcher and the SAME
 * `readlinkSync`-only classifier — we NEVER call `realpathSync`/`stat` anywhere
 * on this path, because a `realpath` on a top-level symlink pointing at the dead
 * mount is itself one of the blocking calls we are removing (GPT review F1):
 *
 *   Tier 1 — TOP-LEVEL precompute (fast path). At start() we enumerate the
 *   workspace's direct children once and classify each symlink via the bounded
 *   `readlinkSync` chain classifier. Matching cloud roots are stored as
 *   normalised prefixes → a pure string compare per candidate thereafter.
 *
 *   Tier 2 — NESTED, runtime (catches what Tier 1 misses). When chokidar tests a
 *   candidate whose `stats.isSymbolicLink()` is true and it isn't already covered
 *   by a known cloud root, we classify it with the same `readlinkSync` chain
 *   classifier (never touches the dead mount). A cloud symlink is excluded AND
 *   its candidate path is memoised as a runtime cloud root (POSITIVE cache only)
 *   so its whole subtree matches by string without re-reading.
 *
 * FAIL CLOSED. If the top-level enumeration throws, or any symlink's chain cannot
 * be proven local (a `readlinkSync` hop throws anything but `EINVAL`, or the hop
 * cap is exceeded), we treat the symlink as cloud and EXCLUDE it. Rationale:
 * false-excluding a legitimate local symlink is recoverable and observable
 * (logged; some content simply isn't watched), whereas false-INCLUDING a cloud
 * symlink re-parks the libuv pool and bricks the whole app (the bug this fixes).
 * A clearly-local symlink (`rebel-system → /Applications/…`, `Shared Notes →
 * ~/Projects/…`) resolves through readlink hops to a non-cloud terminus
 * (`EINVAL`) → NOT excluded, so the carve-out for must-follow local symlinks is
 * preserved. (`rebel-system` is also covered by the static `rebel-system`
 * glob ignore in WORKSPACE_IGNORE_PATTERNS, so it never even reaches this
 * classifier.)
 *
 * POSITIVE-CACHE ONLY (GPT review F3). We memoise discovered cloud roots (a
 * symlink can only get MORE dangerous, and a stale positive entry just means a
 * harmless false-exclude until the next watcher restart). We deliberately do NOT
 * cache NEGATIVE ("local") decisions by candidate path: a symlink can be replaced
 * local→cloud while the watcher is alive, and a cached "local" would then let
 * chokidar follow it into a freshly-dead mount. Re-classifying local symlinks is
 * cheap (a couple of `readlinkSync` calls, never target I/O).
 *
 * Always returns a matcher (never `null`): even when there are zero precomputed
 * cloud roots, or top-level enumeration failed, the nested classifier must stay
 * active so cloud symlinks appearing at depth or after start() are still caught.
 *
 * A FUNCTION matcher (not glob strings) is used deliberately:
 *  - It sidesteps picomatch/anymatch backslash-as-escape handling entirely
 *    (Windows `G:\My Drive\…` and `C:\Users\…\Google Drive` globs would never
 *    match — the original Windows symptom).
 *  - It is UNC-robust: both the candidate and the precomputed symlink roots are
 *    canonicalised through the SAME `normalizeWatchPath` helper that mirrors
 *    anymatch's own `normalize-path`, so a `\\server\share\workspace\…` root
 *    (which normalize-path collapses to one leading slash) stays in phase with
 *    the candidate chokidar tests. Plain glob strings could not, because
 *    `toPortablePath` emitted `//server/share/…` (two leading slashes).
 *  - It is the only way to access the per-candidate `stats` for nested detection.
 */
/**
 * Result of building the cloud-symlink ignore matcher. Beyond the matcher
 * function, exposes the INSTALL-TIME (Tier-1) excluded-symlink count + the
 * top-level-enumeration-failed flag so `installWatcher` can emit one aggregate
 * Sentry breadcrumb (Stage 4 — turn-hang follow-ups). NOTE: `initialExcludedCount`
 * is the Tier-1 count only — the matcher's `normalizedCloudRoots` is private and
 * grows at runtime as Tier-2 discovers nested cloud symlinks, so we cannot expose
 * a live total without leaking mutable internal state; the runtime Tier-2 count is
 * deliberately OUT of this breadcrumb's scope.
 */
interface CloudSymlinkIgnoreMatcherResult {
  matcher: WatcherIgnoreMatcher;
  initialExcludedCount: number;
  topLevelEnumerationFailed: boolean;
}

function collectCloudSymlinkIgnoreMatcher(
  directory: string,
  options: { skipTopLevelEnumeration?: boolean } = {},
): CloudSymlinkIgnoreMatcherResult {
  // Normalised cloud-symlink PATHS. Seeded from the top-level precompute and
  // grown at runtime as Tier 2 discovers nested cloud symlinks. Once a path is
  // here, the candidate test is a pure string compare (no I/O). POSITIVE cache
  // only — see the function doc (GPT review F3).
  const normalizedCloudRoots: string[] = [];
  // When top-level enumeration fails (or is deliberately skipped for a cloud
  // root) we can't enumerate Tier-1 roots, but the nested classifier still runs
  // on every symlink — and fails closed.
  let topLevelEnumerationFailed = false;

  let entries: import('node:fs').Dirent[] = [];
  if (options.skipTopLevelEnumeration) {
    // CLOUD workspace ROOT (Stage 4b F1): the root itself may BE the dead Drive /
    // FileProvider mount, so a synchronous `readdirSync(root)` here would block in
    // the kernel with no timeout and park a libuv pool thread — the exact start-
    // path I/O we are eliminating (`start()` already routes the root stat through
    // a bounded async path). Skip the Tier-1 sync enumeration entirely; the Tier-2
    // runtime classifier (readlink-only, never touches the target) still runs on
    // every candidate and FAILS CLOSED, so nested cloud symlinks are still caught.
    topLevelEnumerationFailed = true;
    logger.info(
      { directory: directory.slice(0, WORKSPACE_PATH_CAP_LOG_DIRECTORY_MAX_LENGTH) },
      'Workspace watcher: skipping top-level cloud-symlink precompute for a cloud workspace root (avoids a synchronous readdir on a possibly-dead mount); the nested fail-closed classifier remains active',
    );
  } else {
    try {
      entries = readdirSync(directory, { withFileTypes: true });
    } catch (err) {
      topLevelEnumerationFailed = true;
      logger.warn(
        { err, directory: directory.slice(0, WORKSPACE_PATH_CAP_LOG_DIRECTORY_MAX_LENGTH) },
        'Workspace watcher: failed to enumerate top-level entries for cloud-symlink exclusion (failing closed — symlinks we cannot classify will be excluded)',
      );
      // Top-level enumeration is best-effort. Unlike before, losing it no longer
      // disables cloud exclusion: the nested Tier-2 classifier still runs on every
      // candidate and FAILS CLOSED, so a dead mount can't slip through.
      ignoreBestEffortCleanup(err, {
        operation: 'workspace_watcher_cloud_symlink_enumeration',
        reason:
          'top-level enumeration is best-effort; the nested per-candidate classifier still runs and fails closed, so cloud symlinks are excluded regardless',
      });
    }
  }

  // Tier 1: precompute the normalised cloud-symlink PATHS for top-level entries
  // using the readlink-only chain classifier (NO realpath — a top-level symlink
  // into the dead mount must not block us at start()).
  for (const entry of entries) {
    if (!entry.isSymbolicLink()) continue;
    const symlinkPath = join(directory, entry.name);
    if (classifySymlinkChainViaReadlink(symlinkPath).skip) {
      normalizedCloudRoots.push(normalizeWatchPath(symlinkPath));
      logger.info(
        { entryName: entry.name },
        'Workspace watcher: excluding cloud/unclassifiable top-level symlink target from watch',
      );
    }
  }

  // Tier-1 install-time count: the number of top-level cloud/unclassifiable
  // symlinks excluded at watcher install (the matcher will grow this set at
  // runtime via Tier-2, but that running total is out of the breadcrumb's scope).
  const initialExcludedCount = normalizedCloudRoots.length;

  const matcher: WatcherIgnoreMatcher = (candidatePath: string, stats?: Stats): boolean => {
    // anymatch already normalises the candidate via normalize-path before calling
    // us; we re-normalise (idempotent) so the predicate is also correct if invoked
    // with a raw OS-native path. Match the symlink itself OR any path beneath it,
    // anchoring on a '/' boundary so `…/Company Memories` never matches a sibling
    // like `…/Company Memories Backup`.
    const candidate = normalizeWatchPath(candidatePath);

    // Fast path: already-known cloud root (Tier 1 top-level OR a Tier-2
    // nested root discovered earlier) — pure string compare, no I/O.
    if (
      normalizedCloudRoots.some(
        (root) => candidate === root || candidate.startsWith(`${root}/`),
      )
    ) {
      return true;
    }

    // Tier 2: nested-symlink classification. chokidar hands us the lstat, so we
    // only do work for actual symlinks; plain files/dirs are never readlinked.
    if (!stats?.isSymbolicLink()) {
      return false;
    }

    // Classify via the readlink-only chain walk WITHOUT touching the (possibly
    // dead) target inode. `candidatePath` is the symlink's own path under the
    // workspace; readlink reads its inode in the local parent dir. We do NOT
    // negative-cache "local" results: a symlink can be replaced local→cloud while
    // the watcher is alive (GPT review F3), and re-classifying is cheap.
    const isCloud = classifySymlinkChainViaReadlink(candidatePath).skip;
    if (isCloud) {
      // Memoise as a runtime cloud root so the whole subtree matches by string
      // without re-reading the link for every descendant.
      normalizedCloudRoots.push(candidate);
      logger.info(
        { failedTopLevelEnumeration: topLevelEnumerationFailed },
        'Workspace watcher: excluding nested cloud/unclassifiable symlink target from watch',
      );
    }
    return isCloud;
  };

  return { matcher, initialExcludedCount, topLevelEnumerationFailed };
}

/**
 * Event types emitted by the workspace watcher.
 */
export interface WorkspaceWatcherEvents {
  'file:added': (filePath: string) => void;
  'file:changed': (filePath: string) => void;
  'file:removed': (filePath: string) => void;
  'dir:added': (dirPath: string) => void;
  'dir:removed': (dirPath: string) => void;
  'ready': () => void;
  'error': (error: Error) => void;
}

/**
 * Pure predicate: should we emit the packaged-darwin polling-fallback warning?
 *
 * True only when we are in a packaged macOS build AND chokidar resolved to its
 * `fs.watchFile` polling backend instead of native fsevents (`useFsEvents` is
 * false). That combination is the field signature of the
 * 260623_fsevents-interception-regression class (NODE_PATH shim hoisting too
 * late → chokidar can't `require('fsevents')` → degraded polling + a disarmed
 * quit-time leak guard) — telemetry-blind before this warning existed.
 *
 * In dev / non-packaged, polling is an expected/benign mode, so we stay silent.
 * Extracted as a pure function so the decision is unit-testable without driving
 * a real chokidar instance.
 */
export function shouldWarnPollingFallback(args: {
  platform: NodeJS.Platform;
  packaged: boolean;
  useFsEvents: boolean | undefined;
}): boolean {
  return args.platform === 'darwin' && args.packaged && args.useFsEvents === false;
}

/**
 * Typed event emitter for workspace watcher.
 */
declare interface WorkspaceWatcherService {
  on<K extends keyof WorkspaceWatcherEvents>(event: K, listener: WorkspaceWatcherEvents[K]): this;
  off<K extends keyof WorkspaceWatcherEvents>(event: K, listener: WorkspaceWatcherEvents[K]): this;
  emit<K extends keyof WorkspaceWatcherEvents>(event: K, ...args: Parameters<WorkspaceWatcherEvents[K]>): boolean;
}

class WorkspaceWatcherService extends EventEmitter {
  private watcher: FSWatcher | null = null;
  private currentDirectory: string | null = null;
  /**
   * Pending retry for a CLOUD workspace root whose bounded validate-stat timed
   * out (a likely-dead mount). Cleared whenever `start()` is called for a new
   * directory or `stop()` runs, so a stuck retry never fights a fresh request.
   * The target directory is captured in the timer's closure (no separate field).
   */
  private cloudRootRetryTimer: ReturnType<typeof setTimeout> | null = null;
  /**
   * Monotonic counter bumped on EVERY `start()` and `stop()`. A cloud-root async
   * validation captures the generation at dispatch and bails if it changed by the
   * time the (slow) stat resolves — so a late validation can never install,
   * defer, or retry a watch the user has already moved on from.
   */
  private startGeneration = 0;
  /**
   * The cloud directory currently being validated on the bounded async path OR
   * cooling down between a timed-out validation and its scheduled retry. Used to
   * DEDUPE repeated `start(sameCloudRoot)` calls (GPT review F3): re-driving would
   * launch another abandoned `fs.stat` against a possibly-dead mount, defeating
   * the "one lingering stat per retry cadence" residual bound. The marker stays
   * set THROUGH the retry cooldown (not just while the promise is awaited),
   * because the timed-out `fs.stat` may still be parked in libuv. It carries the
   * `generation` that set it so a STALE validation's `finally` can't clear a
   * NEWER attempt's marker. Cleared: by the retry timer right before it re-drives
   * `start()`; by a `start()`/`stop()` for a different request (generation bump +
   * explicit clear); and by a settled validation whose generation still matches.
   */
  private cloudValidationInFlight: { directory: string; generation: number } | null = null;

  /**
   * Start watching a workspace directory.
   * Emits events for file/directory changes that subscribers can listen to.
   *
   * Synchronous by contract (all callers fire-and-forget it). For a LOCAL root we
   * pre-validate with a cheap synchronous `statSync` as before. For a CLOUD root
   * we must NEVER block on a synchronous `statSync`: a dead Google Drive / FUSE
   * mount makes `statSync` block in the kernel with no timeout, parking a libuv
   * pool thread and (when several pile up) starving the agent turn's own fs reads
   * — the turn-hang root cause (docs/plans/260619_turn-hang-bugmode/PLAN.md). So a
   * cloud root is validated on a bounded ASYNC path instead, and the watch is
   * installed (or deferred + retried) once that resolves.
   */
  public start(directory: string): void {
    if (this.currentDirectory === directory && this.watcher) {
      logger.debug({ directory }, 'Workspace watcher already watching this directory');
      return;
    }

    // Cloud-ness is determined by PURE detection (string pattern match + a cheap,
    // bounded `file-provider-domain-id` xattr read) — neither blocks on a dead
    // FUSE mount the way `statSync` would. We deliberately do NOT `statSync` the
    // root before this branch (that is the bug). `detectInPlaceCloudDocuments`
    // also covers macOS in-place iCloud `~/Documents` / `~/Desktop` roots, which
    // `detectCloudStorage` intentionally reports as non-cloud. (The xattr read is
    // a bounded ≤2s event-loop pause on FIRST classification, then cached — not a
    // libuv-pool wedge; GPT review note.)
    const cloudInfo = detectCloudStorage(directory);
    const isCloudRoot = cloudInfo.isCloud || detectInPlaceCloudDocuments(directory);

    // DEDUPE (GPT review F3): if a bounded validation for THIS cloud root is
    // already in flight OR cooling down before its scheduled retry, do not
    // re-drive it — that would launch a second abandoned `fs.stat` against a
    // possibly-dead mount (the timed-out one may still be parked in libuv).
    // Leave the existing validation/retry (and its generation) untouched. The
    // retry timer itself clears this marker before it re-drives start().
    if (isCloudRoot && this.cloudValidationInFlight?.directory === directory) {
      logger.debug(
        { directory },
        'Workspace watcher: cloud-root validation already in flight / cooling down for this directory; not re-dispatching',
      );
      return;
    }

    // We are NOT deduping (this is a genuinely new/different request), so this
    // start() supersedes any pending cloud-root retry and any prior cooldown
    // dedupe marker (for a different directory, or the same directory we chose
    // to re-drive). Cancel the retry, drop the stale marker, and bump the
    // generation so any in-flight validation under the old generation goes inert.
    // (If THIS request is itself a cloud root, the marker is re-armed below.)
    this.clearCloudRootRetry();
    this.cloudValidationInFlight = null;
    const generation = ++this.startGeneration;

    if (!isCloudRoot) {
      // LOCAL root: cheap synchronous pre-validate (unchanged fast path).
      const decision = this.validateRootStat(directory, () => {
        try {
          const stat = statSync(directory);
          return { ok: true, isDirectory: stat.isDirectory() };
        } catch (error) {
          return { ok: false, error };
        }
      });
      if (decision === 'skip') return;
      this.installWatcher(directory, false);
      return;
    }

    // CLOUD root: log the diagnostic, then validate on a bounded ASYNC path so a
    // dead mount cannot block start() (and the libuv pool) indefinitely.
    logger.info(
      { directory, provider: cloudInfo.provider },
      'Workspace is in cloud storage - validating reachability on a bounded path before watching',
    );
    this.cloudValidationInFlight = { directory, generation };
    fireAndForget(
      this.validateCloudRootAndInstall(directory, generation),
      'workspaceWatcherService.validateCloudRootAndInstall',
    );
  }

  /**
   * Classify a root-directory stat outcome into "ok → install" or "skip". Shared
   * by the synchronous (local) and bounded-async (cloud) validate paths so the
   * accessibility-error handling stays identical. A non-accessibility error on
   * the synchronous path is rethrown (preserving the pre-fix contract); the async
   * path never rethrows (it logs + skips), so it passes a sentinel for that case.
   */
  private validateRootStat(
    directory: string,
    probe: () => { ok: true; isDirectory: boolean } | { ok: false; error: unknown },
  ): 'ok' | 'skip' {
    const result = probe();
    if (result.ok) {
      if (!result.isDirectory) {
        logger.warn({ directory }, 'Workspace watcher skipped: path is not a directory');
        return 'skip';
      }
      return 'ok';
    }
    const code = (result.error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'EPERM' || code === 'EACCES' || code === 'ENOTDIR') {
      logger.warn({ directory, code }, 'Workspace watcher skipped: directory not accessible');
      return 'skip';
    }
    throw result.error;
  }

  /**
   * Bounded-async validate of a CLOUD workspace root, then install the watcher.
   *
   * Uses `runWithTimeout` around an async `fs.stat` so a DEAD mount can no longer
   * wedge `start()`. Note (GPT review of withTimeout): `Promise.race` only stops
   * *awaiting* the syscall — the abandoned `fs.stat` may keep one pool thread
   * parked until the kernel returns. That residual is acceptable here precisely
   * because we have now RAISED the pool (Stage 4b threadpool buffer): one parked
   * validate-stat no longer threatens to exhaust the pool, and a dead mount that
   * never returns is bounded to a single lingering stat per retry cadence (not an
   * unbounded synchronous block on every `start()`).
   *
   * On timeout — OR any transient unhealthy-mount stat error (EIO/ETIMEDOUT/
   * ENOTCONN/…) — the watch is DEFERRED (observable warn) and a bounded retry is
   * scheduled (GPT review F6); the mount may reconnect, and the user expects
   * changes to be picked up once it does (recovery path), without needing a
   * workspace switch. A genuine accessibility error (ENOENT/EPERM/EACCES/ENOTDIR)
   * or a non-directory is a permanent SKIP (no retry).
   */
  private async validateCloudRootAndInstall(directory: string, generation: number): Promise<void> {
    type StatProbe = { ok: true; isDirectory: boolean } | { ok: false; error: unknown };
    const TIMED_OUT = Symbol('timed-out');
    const timeoutMs = Math.max(CLOUD_ROOT_STAT_TIMEOUT_MS, getTimeoutForPath(directory));
    const probe = await runWithTimeout<StatProbe | typeof TIMED_OUT>({
      timeoutMs,
      work: async () => {
        try {
          const stat = await statAsync(directory);
          return { ok: true, isDirectory: stat.isDirectory() };
        } catch (error) {
          return { ok: false, error };
        }
      },
      onTimeout: () => TIMED_OUT,
    });

    // A newer start()/stop() may have superseded this validation while we
    // awaited the (potentially slow) cloud stat. `startGeneration` is bumped on
    // EVERY start() and stop(), so a stale generation means another request has
    // taken over — we must NOT install, defer, retry, OR touch the in-flight
    // marker (a newer attempt now owns it), or we'd resurrect a watch the user
    // has moved on from / clear a newer attempt's dedupe marker.
    if (generation !== this.startGeneration) {
      logger.debug(
        { directory },
        'Workspace watcher: cloud-root validation superseded by a newer start()/stop(); discarding',
      );
      return;
    }

    if (probe.value === TIMED_OUT) {
      logger.warn(
        { directory, timeoutMs, retryInMs: CLOUD_ROOT_RETRY_INTERVAL_MS },
        'Workspace watcher deferred: cloud workspace root did not respond within the bounded budget (likely an unresponsive mount); will retry. File changes are not being watched until the mount responds.',
      );
      // KEEP the in-flight marker through the retry cooldown: the timed-out
      // `fs.stat` may still be parked in libuv, so a same-directory start()
      // before the retry fires must dedupe rather than launch another stat
      // (GPT review F3). The retry timer clears the marker before re-driving.
      this.scheduleCloudRootRetry(directory);
      return;
    }

    const result = probe.value;
    if (result.ok) {
      if (!result.isDirectory) {
        logger.warn({ directory }, 'Workspace watcher skipped: path is not a directory');
        this.clearCloudValidationInFlight(generation);
        return;
      }
      this.clearCloudValidationInFlight(generation);
      this.installWatcher(directory, true);
      return;
    }

    // Stat errored. Distinguish a permanent accessibility error (skip, no retry)
    // from a transient unhealthy-mount error (defer + retry — F6).
    const code = (result.error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'EPERM' || code === 'EACCES' || code === 'ENOTDIR') {
      logger.warn({ directory, code }, 'Workspace watcher skipped: directory not accessible');
      this.clearCloudValidationInFlight(generation);
      return;
    }
    logger.warn(
      { directory, code, retryInMs: CLOUD_ROOT_RETRY_INTERVAL_MS },
      'Workspace watcher deferred: cloud workspace root stat failed with a transient/unknown error (likely an unhealthy mount); will retry.',
    );
    // Same cooldown reasoning as the timeout branch — keep the marker.
    this.scheduleCloudRootRetry(directory);
  }

  /**
   * Clear the cloud-validation in-flight marker, but only if the CURRENT marker
   * was set by the given generation — so a stale validation's settle can never
   * clear a newer attempt's marker (GPT review F3 generation-blind-clear).
   */
  private clearCloudValidationInFlight(generation: number): void {
    if (this.cloudValidationInFlight?.generation === generation) {
      this.cloudValidationInFlight = null;
    }
  }

  /** Schedule a single bounded retry of a deferred cloud-root watch. */
  private scheduleCloudRootRetry(directory: string): void {
    this.clearCloudRootRetry();
    this.cloudRootRetryTimer = setTimeout(() => {
      this.cloudRootRetryTimer = null;
      // Clear the cooldown dedupe marker BEFORE re-driving so the retry's own
      // start() isn't deduped against itself; if the mount is still dead the new
      // validation re-arms the marker.
      this.cloudValidationInFlight = null;
      // Re-drive the full start() path: cloud-ness is re-detected and the bounded
      // validate runs again. If the mount is back, the watch installs; if still
      // dead, another retry is scheduled.
      logger.info({ directory }, 'Workspace watcher: retrying deferred cloud workspace root');
      this.start(directory);
    }, CLOUD_ROOT_RETRY_INTERVAL_MS);
    // Don't keep the event loop / app alive solely for this retry.
    this.cloudRootRetryTimer.unref?.();
  }

  /** Cancel any pending cloud-root retry. */
  private clearCloudRootRetry(): void {
    if (this.cloudRootRetryTimer) {
      clearTimeout(this.cloudRootRetryTimer);
      this.cloudRootRetryTimer = null;
    }
  }

  /**
   * Install the chokidar watcher for an already-validated directory. Extracted
   * from `start()` so both the synchronous (local) and bounded-async (cloud)
   * validate paths share one install routine.
   *
   * `isCloudRoot` is threaded through so the cloud-symlink matcher can skip its
   * synchronous top-level `readdirSync` precompute when the ROOT itself is a
   * cloud mount (Stage 4b F1) — that sync readdir would otherwise re-introduce a
   * dead-mount block on the install path that the bounded async root-stat just
   * removed. The nested fail-closed classifier stays active regardless.
   */
  private installWatcher(directory: string, isCloudRoot: boolean): void {
    fireAndForget(this.stop(), 'workspaceWatcherService.line293');
    workspacePathCapWarnedDirectories.clear();

    // Exclude symlinks — at ANY depth — that point into a cloud-storage mount so
    // chokidar never `stat`s/descends into their unbounded FUSE I/O and parks the
    // libuv threadpool (root cause —
    // docs/plans/260619_turn-hang-bugmode/PLAN.md; RC-1 lineage). The matcher
    // classifies via `readlinkSync` only (never `realpath`, never touching the
    // dead target) and FAILS CLOSED. It is always installed (the nested
    // classifier must stay active for symlinks appearing at depth or after
    // start()). rebel-system and other non-cloud outside-workspace symlinks are
    // preserved (a non-cloud chain terminus is kept watched). For a cloud ROOT we
    // skip the Tier-1 sync readdir precompute (it would block on a dead mount).
    const {
      matcher: cloudSymlinkIgnoreMatcher,
      initialExcludedCount,
      topLevelEnumerationFailed,
    } = collectCloudSymlinkIgnoreMatcher(directory, {
      skipTopLevelEnumeration: isCloudRoot,
    });
    const ignored = [...WORKSPACE_IGNORE_PATTERNS, cloudSymlinkIgnoreMatcher];

    // One aggregate breadcrumb at install (turn-hang follow-ups, Stage 4):
    // correlate cloud/unclassifiable-symlink exclusion pressure with the hang
    // signal — it rides on the NEXT Sentry event (e.g. a Stage-3 pre-dispatch
    // terminal). NOT a per-symlink loop. The count is the INSTALL-TIME (Tier-1)
    // total; the lazily-growing Tier-2 runtime count is deliberately out of scope
    // (see CloudSymlinkIgnoreMatcherResult). Watcher is desktop-only (cloud/mobile
    // have no chokidar workspace watcher) — no cross-surface parity counterpart by
    // construction, so this is not a CLOUD_CHANNEL_POLICIES parity gap.
    getErrorReporter().addBreadcrumb({
      category: 'workspace-watcher',
      level: 'info',
      message: '[cloud-symlink] excluded N cloud/unclassifiable symlinks at watcher install',
      data: {
        cloudSymlinkExcludedCountAtInstall: initialExcludedCount,
        topLevelEnumerationFailed,
      },
    });

    this.currentDirectory = directory;
    this.watcher = watch(directory, {
      ignored,
      persistent: true,
      ignoreInitial: true, // Subscribers handle their own initial state
      followSymlinks: true,
      depth: MAX_WATCH_DEPTH,
      interval: 1000, // fallback safety cap — only consumed by chokidar's fs.watchFile POLLING branch; inert under active fsevents. Caps idle-CPU blast radius (~10x) if fsevents resolution ever regresses again (see 260623_fsevents-interception-regression). NOT the primary watch mechanism.
      binaryInterval: 1000, // same rationale
      awaitWriteFinish: {
        stabilityThreshold: 300,
        pollInterval: 1000,
      },
      ignorePermissionErrors: true,
    });

    this.watcher
      .on('add', (filePath) => this.emit('file:added', filePath))
      .on('change', (filePath) => this.emit('file:changed', filePath))
      .on('unlink', (filePath) => this.emit('file:removed', filePath))
      .on('addDir', (dirPath) => this.emit('dir:added', dirPath))
      .on('unlinkDir', (dirPath) => this.emit('dir:removed', dirPath))
      .on('ready', () => {
        // Fail-open: a `getWatched()` throw here must never prevent the warn or
        // the 'ready' emit (review F3 — make the fail-open guarantee literally
        // complete). The polling-fallback warn does its own bounded `getWatched()`
        // inside warnIfPollingFallback()'s try/catch.
        try {
          const watchedPaths = this.watcher?.getWatched();
          const dirCount = watchedPaths ? Object.keys(watchedPaths).length : 0;
          logger.info({ directory, watchedDirectories: dirCount }, 'Workspace watcher ready');
        } catch (error) {
          logger.warn({ error, directory }, 'Workspace watcher ready (watched-dir count unavailable)');
        }
        this.warnIfPollingFallback();
        this.emit('ready');
      })
      .on('error', (error) => {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === 'ENOSPC') {
          logger.error(
            { err: error, directory },
            'Workspace watcher error: inotify limit reached (ENOSPC). On Linux, increase fs.inotify.max_user_watches'
          );
        } else if (code === 'EMFILE' || code === 'ENFILE') {
          logger.error(
            { err: error, directory },
            'Workspace watcher error: too many open files. Consider reducing workspace scope'
          );
        } else {
          logger.error({ err: error, directory, code }, 'Workspace watcher error');
          // Restore Sentry visibility for novel codes. The pre-fix path turned
          // these into fatal-unhandled (Sentry-captured) crashes; we no longer
          // crash, so report explicitly to keep regression visibility for codes
          // outside the known-transient FS-error set. Code-less errors (e.g.
          // JS-level TypeError or stream errors from chokidar internals) are
          // the most-novel case and must also be reported.
          if (!code || !KNOWN_TRANSIENT_WATCHER_ERROR_CODES.has(code)) {
            const sentryCode = code ?? 'NO_CODE';
            getErrorReporter().captureException(error, {
              level: 'warning',
              tags: { component: 'workspaceWatcher', code: sentryCode },
              extra: { directory },
              fingerprint: ['workspaceWatcher', 'watcherError', sentryCode],
            });
          }
        }
        // Re-emit only when subscribers exist. Node EventEmitter throws when
        // 'error' is emitted with zero listeners, which previously turned every
        // chokidar internal lstat ENAMETOOLONG / EINVAL / UNKNOWN into a fatal
        // unhandled exception (REBEL-1HK / REBEL-567 / REBEL-56E clusters). The
        // logger above always captures the error; the re-emit is for application
        // subscribers, not a fatal contract.
        if (this.listenerCount('error') > 0) {
          this.emit('error', error);
        }
      });

    logger.info({ directory }, 'Workspace watcher started');
  }

  /**
   * Fail-open diagnostics: on watcher ready in a packaged macOS build, warn if
   * chokidar fell back off native fsevents to `fs.watchFile` polling. That is the
   * field signature of the 260623_fsevents-interception-regression class (high
   * idle CPU + a disarmed quit-time leak guard) and was previously
   * telemetry-blind. "Silent failure is a bug" — this is the signal that would
   * have surfaced it in the field. NEVER throws: a diagnostics failure must not
   * break the watcher.
   *
   * "packaged" uses the authoritative `getPlatformConfig().isPackaged`
   * (`app.isPackaged`-backed) and fails open to SILENT if the config is
   * unavailable — `process.resourcesPath` is truthy in Electron dev too, so it
   * could otherwise fire a spurious warn in dev (review F1). The Sentry side
   * emits a one-shot-per-process captured WARNING EVENT (review F2).
   */
  private warnIfPollingFallback(): void {
    try {
      // chokidar stores the resolved options object at `this.options`
      // (node_modules/chokidar/index.js: `this.options = opts`); `useFsEvents` is
      // set false when it can't/ won't use the native backend.
      const useFsEvents = (this.watcher as unknown as { options?: { useFsEvents?: boolean } } | null)
        ?.options?.useFsEvents;
      // Authoritative packaged signal (review F1): `process.resourcesPath` is a
      // non-empty string in Electron DEV too, so it does NOT distinguish dev from
      // packaged and would let a dev darwin polling fallback fire a spurious warn +
      // Sentry event. `getPlatformConfig().isPackaged` is wired to `app.isPackaged`
      // (src/main/bootstrap.ts). FAIL-OPEN TO SILENT: if the platform config isn't
      // initialised for any reason, don't warn.
      let packaged: boolean;
      try {
        packaged = getPlatformConfig().isPackaged;
      } catch (error) {
        // Fail-open to SILENT: if the platform config isn't initialised we can't
        // tell dev from packaged, so we must not risk a spurious warn/Sentry
        // event. Record the swallow at debug (benign, quiet — typically only an
        // early-boot race) rather than warning the user.
        logger.debug({ error }, 'workspace watcher polling-fallback: isPackaged unavailable (fail-open silent)');
        return;
      }
      if (!shouldWarnPollingFallback({ platform: process.platform, packaged, useFsEvents })) {
        return;
      }

      const watchedPaths = this.watcher?.getWatched();
      const watchedDirectoryCount = watchedPaths ? Object.keys(watchedPaths).length : 0;
      const statWatcherCount = process
        .getActiveResourcesInfo()
        .filter((t) => t === 'StatWatcher').length;

      const diagnostics = { useFsEvents, watchedDirectoryCount, statWatcherCount };
      logger.warn(
        diagnostics,
        'workspace watcher fell back off native fsevents to polling (high CPU risk) — fsevents did not resolve in the packaged app',
      );

      // One-shot per process (review F2): the Sentry call below emits a captured
      // warning EVENT (not merely a breadcrumb), and a re-ready / re-watch cycle
      // must not re-emit it and spam Sentry. The logger.warn above is left to fire
      // every time (cheap, local, useful for repeated-fallback visibility).
      if (warnedPollingFallbackOnce) {
        return;
      }
      warnedPollingFallbackOnce = true;

      // Emit a one-shot captured WARNING EVENT (lazy-import the sentry seam,
      // mirroring fseventsLeakGuard.ts) — a genuine packaged-darwin fsevents
      // regression warrants an event, not just a breadcrumb. Fail-open: a
      // missing/failed seam must not break the watcher.
      import('../sentry')
        .then(({ captureMainMessage }) => {
          captureMainMessage(
            'workspace watcher fell back off native fsevents to polling (packaged darwin)',
            {
              level: 'warning',
              fingerprint: ['workspace-watcher-polling-fallback'],
              tags: { condition: 'workspace-watcher-polling-fallback' },
              extra: diagnostics,
            },
          );
        })
        .catch((error: unknown) => {
          logger.warn(
            { error },
            'workspace watcher polling-fallback Sentry report failed (fail-open)',
          );
        });
    } catch (error) {
      logger.warn({ error }, 'workspace watcher polling-fallback diagnostics failed (fail-open)');
    }
  }

  /**
   * Stop watching and clean up.
   * Note: Does NOT call removeAllListeners() - subscribers manage their own cleanup
   * via explicit off() calls. This allows subscribers to re-register after workspace change.
   */
  public async stop(): Promise<void> {
    workspacePathCapWarnedDirectories.clear();
    // Cancel any pending cloud-root retry and invalidate any in-flight cloud-root
    // async validation (generation bump + clear the in-flight marker). Idempotent
    // on the internal installWatcher()→stop() path (the retry is already cleared
    // at start(), and the generation bump there has already gated this install);
    // load-bearing on a genuine external teardown so a deferred/in-flight
    // dead-mount validation can't resurrect a watch after the workspace was
    // intentionally stopped.
    this.clearCloudRootRetry();
    this.cloudValidationInFlight = null;
    this.startGeneration += 1;

    // Capture the watcher we're tearing down. `start()` calls stop() detached
    // (fireAndForget) then synchronously installs a new watcher; if we cleared
    // `this.watcher`/`this.currentDirectory` unconditionally after awaiting the
    // OLD close(), we'd null the freshly-installed NEW state and silently kill a
    // just-restarted watcher (DI-23 review F2). Only clear state we still own.
    const watcher = this.watcher;
    if (watcher) {
      try {
        await watcher.close();
      } catch (err) {
        logger.warn({ err }, 'Error closing workspace watcher');
      }
      if (this.watcher !== watcher) {
        // A concurrent start() superseded us while close() was in flight — leave
        // its new watcher + currentDirectory intact.
        logger.debug('Workspace watcher: superseded by a concurrent start(); leaving new state intact');
        return;
      }
      this.watcher = null;
    }

    this.currentDirectory = null;
    logger.debug('Workspace watcher stopped');
  }

  // S4.2 (260619_cloud-symlink-indexing): `restartCurrent()` — force-reinstall the
  // watcher to rebuild the cloud-symlink `ignored` matcher — is REMOVED. It existed
  // ONLY to RETRACT a now-dead admitted cloud subtree from the live watch (the
  // de-admission hole the Stage-6b live-watch admission opened). Cloud is no longer
  // live-watched at all (the admission override in classifySymlinkChainViaReadlink is
  // gone — DROP-3), so there is no admitted cloud subtree to retract, and recovery
  // re-indexing of a healthy cloud space is driven by the periodic re-walk scheduler
  // (cloudPeriodicRewalkService) rather than a watcher reinstall.

  /**
   * Check if the watcher is active.
   */
  public isWatching(): boolean {
    return this.watcher !== null;
  }

  /**
   * Get the currently watched directory.
   */
  public getCurrentDirectory(): string | null {
    return this.currentDirectory;
  }
}

export const workspaceWatcherService = new WorkspaceWatcherService();
