/**
 * Cloud Storage Detection Utility
 *
 * Shared utility for detecting cloud storage providers and adjusting
 * timeouts for filesystem operations. Cloud storage (OneDrive, Dropbox, etc.)
 * may have "Files On-Demand" or placeholder files that require network
 * hydration before access.
 *
 * @see docs/plans/finished/260128_onedrive_cloud_storage_handling.md
 */

import childProcess from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { toPortablePath } from '@core/utils/portablePath';
import { ignoreBestEffortCleanup } from '@shared/utils/intentionalSwallow';

export type CloudProvider = 'onedrive' | 'google_drive' | 'dropbox' | 'icloud' | 'box';

export interface CloudStorageInfo {
  isCloud: boolean;
  provider?: CloudProvider;
}

export type WorkspaceWriteAuthority = 'desktop_fs_authoritative' | 'cloud_authoritative';

export interface ResolveWorkspaceWriteAuthorityOptions {
  /**
   * Per-sync-cycle cache. Callers should provide one cache map for each sync
   * cycle so repeated sibling-path checks avoid duplicate realpath I/O.
   */
  cache?: Map<string, WorkspaceWriteAuthority>;
}

const CASE_INSENSITIVE_AUTHORITY_PLATFORMS = new Set(['darwin', 'win32']);

function normalizeWorkspaceAuthorityCacheKey(inputPath: string): string {
  const portable = toPortablePath(path.resolve(inputPath)).normalize('NFC');
  if (CASE_INSENSITIVE_AUTHORITY_PLATFORMS.has(process.platform)) {
    return portable.toLowerCase();
  }
  return portable;
}

function readCachedWorkspaceAuthority(
  cache: Map<string, WorkspaceWriteAuthority>,
  absolutePath: string,
): WorkspaceWriteAuthority | undefined {
  return cache.get(normalizeWorkspaceAuthorityCacheKey(absolutePath));
}

function isEnoentError(err: unknown): boolean {
  return typeof err === 'object'
    && err !== null
    && (err as NodeJS.ErrnoException).code === 'ENOENT';
}

function findExistingAncestorRealPath(absolutePath: string): string | null {
  let current = path.dirname(absolutePath);
  while (true) {
    try {
      return fs.realpathSync(current);
    } catch (err) {
      if (!isEnoentError(err)) {
        ignoreBestEffortCleanup(err, {
          operation: 'resolveWorkspaceWriteAuthority.findExistingAncestorRealPath',
          reason: 'stop-ancestor-search-on-non-enoent-realpath-error',
          owner: 'core.cloudStorageUtils',
        });
        return null;
      }
      const parent = path.dirname(current);
      if (parent === current) return null;
      current = parent;
    }
  }
}

function resolveRealPathForAuthority(
  absolutePath: string,
): { resolvedPath: string; usedParentFallback: boolean } {
  try {
    return {
      resolvedPath: fs.realpathSync(absolutePath),
      usedParentFallback: false,
    };
  } catch (err) {
    if (!isEnoentError(err)) {
      ignoreBestEffortCleanup(err, {
        operation: 'resolveWorkspaceWriteAuthority.resolveRealPathForAuthority',
        reason: 'fallback-to-input-path-on-non-enoent-realpath-error',
        owner: 'core.cloudStorageUtils',
      });
      // Best-effort fallback for permission / ELOOP anomalies:
      // stay deterministic and non-throwing for authority resolution.
      return {
        resolvedPath: absolutePath,
        usedParentFallback: false,
      };
    }

    const existingAncestor = findExistingAncestorRealPath(absolutePath);
    if (existingAncestor) {
      return {
        resolvedPath: existingAncestor,
        usedParentFallback: true,
      };
    }

    return {
      resolvedPath: path.dirname(absolutePath),
      usedParentFallback: true,
    };
  }
}

export function createWorkspaceWriteAuthorityCache(): Map<string, WorkspaceWriteAuthority> {
  return new Map();
}

/**
 * Detect if a path is in cloud storage and which provider.
 * Works on both macOS and Windows paths.
 */
export function detectCloudStorage(pathStr: string): CloudStorageInfo {
  const normalized = toPortablePath(pathStr).toLowerCase();

  // macOS File Provider mounts — PROVIDER-AGNOSTIC. Since macOS 12.3 every cloud
  // provider (Google Drive, Dropbox, OneDrive, Box, …) is forced to mount under
  // `~/Library/CloudStorage/<Provider>-<Account>` via the File Provider
  // framework. Match the directory regardless of provider so a NEW or unmapped
  // provider (and the modern `~/Library/CloudStorage/Dropbox-Team` layout, which
  // is NOT under `~/Dropbox`) is still treated as cloud — these are the
  // network-backed FUSE mounts whose `stat`/`readdir`/`realpath` block when the
  // provider is unresponsive (the turn-hang root). Attribute the known providers
  // for the provider enum; an unrecognised CloudStorage child is still cloud
  // (provider omitted). This is a pure string match (no I/O), so it is safe on
  // the readlink-only symlink-classification path that must never touch the
  // possibly-dead target. NOTE: this is distinct from `~/Library/Mobile
  // Documents/...` (iCloud Drive, handled below) and from in-place iCloud
  // `~/Documents`/`~/Desktop` (deliberately NOT cloud — see
  // `detectInPlaceCloudDocuments`).
  // Match ANY child of CloudStorage (`[^/]+`, not `[a-z]+`) so a provider folder
  // that begins with a digit / punctuation / non-ASCII still classifies as cloud
  // (GPT review F3) — the `isCloud` decision must not depend on attribution
  // succeeding. Provider attribution is a SEPARATE, deliberately-conservative
  // step: the FileProvider folder is `<Vendor>-<Account>` or a bare `<Vendor>`,
  // so we attribute only on the exact vendor token (the part before the first
  // `-`), never a loose `startsWith` — otherwise `Boxcryptor-…` would be
  // mislabeled `box` (GPT review F1), and since consumers tolerate an undefined
  // provider, a wrong attribution is worse than none.
  const cloudStorageMatch = /\/library\/cloudstorage\/([^/]+)/.exec(normalized);
  if (cloudStorageMatch) {
    const vendorToken = (cloudStorageMatch[1] ?? '').split('-')[0]?.trim();
    const KNOWN_CLOUDSTORAGE_VENDORS: Record<string, CloudProvider> = {
      googledrive: 'google_drive',
      dropbox: 'dropbox',
      onedrive: 'onedrive',
      box: 'box',
      icloud: 'icloud',
    };
    const provider = vendorToken ? KNOWN_CLOUDSTORAGE_VENDORS[vendorToken] : undefined;
    // Unknown vendor under CloudStorage → still a cloud FUSE mount; provider omitted.
    return provider ? { isCloud: true, provider } : { isCloud: true };
  }

  // OneDrive: /Users/.../OneDrive - Company/... or C:\Users\...\OneDrive\...
  if (/\/onedrive[^/]*(\/|$)/.test(normalized)) {
    return { isCloud: true, provider: 'onedrive' };
  }

  // Google Drive:
  // - Windows folder: C:\Users\...\Google Drive\...
  // - Windows virtual drive: G:\My Drive\... or G:\Shared drives\...
  // (macOS `~/Library/CloudStorage/GoogleDrive-…` is handled by the
  // provider-agnostic CloudStorage branch above.)
  if (
    /\/google drive(\/|$)/.test(normalized) ||
    /^[a-z]:\/(my drive|shared drives)(\/|$)/.test(normalized)
  ) {
    return { isCloud: true, provider: 'google_drive' };
  }

  // Dropbox (legacy `~/Dropbox/...` layout; the modern
  // `~/Library/CloudStorage/Dropbox-…` is handled by the CloudStorage branch).
  if (/\/dropbox(\/|$)/.test(normalized)) {
    return { isCloud: true, provider: 'dropbox' };
  }

  // iCloud:
  // - macOS: /Library/Mobile Documents/com~apple~CloudDocs/...
  // - Windows: /iCloudDrive/... or /iCloud Drive/...
  if (
    /\/library\/mobile documents\/com~apple~clouddocs/.test(normalized) ||
    /\/icloud ?drive(\/|$)/.test(normalized)
  ) {
    return { isCloud: true, provider: 'icloud' };
  }

  // Box: /Users/.../Box/... or /Users/.../Box Sync/...
  if (/\/box( sync)?(\/|$)/.test(normalized)) {
    return { isCloud: true, provider: 'box' };
  }

  return { isCloud: false };
}

/**
 * Decide whether to descend into a symlink while scanning/watching a workspace.
 *
 * The predicate MUST run on the symlink's **resolved target realpath**, not on
 * the symlink path or the workspace root: a symlink named `Company Memories`
 * sitting inside a local workspace resolves to e.g.
 * `~/Library/CloudStorage/GoogleDrive-…/Shared drives/Company Memories` — a
 * network-backed, dataless FUSE mount whose `readdir`/`stat`/`realpath` block
 * indefinitely. Following such a symlink hangs the Library scan and the chokidar
 * watcher (RC-1, docs/plans/260618_library-scan-freeze-investigation/PLAN.md).
 *
 * Returns `{ skip: true, provider }` when the resolved target is inside a known
 * cloud-storage mount, so the caller can both stop descending AND log which
 * provider it skipped. It is **cloud-specific on purpose**: the workspace also
 * contains `rebel-system → /Applications/…app/Contents/Resources/rebel-system`
 * (an outside-workspace symlink that MUST keep being followed for Skills /
 * AGENTS.md). `detectCloudStorage` returns `isCloud:false` for that path, so the
 * rebel-system symlink is preserved automatically — never implement this as
 * "skip all outside-workspace symlinks".
 */
export function shouldSkipCloudSymlinkTarget(
  resolvedTargetPath: string,
): { skip: boolean; provider?: CloudProvider } {
  const info = detectCloudStorage(resolvedTargetPath);
  return info.isCloud ? { skip: true, provider: info.provider } : { skip: false };
}

/**
 * Resolve write authority for a workspace path.
 *
 * - Cloud-synced storage (Google Drive / Dropbox / OneDrive / etc.) =>
 *   desktop_fs_authoritative (Drive/Desktop should deliver new files)
 * - Non-cloud paths => cloud_authoritative
 *
 * Resolves symlinks via `realpathSync`. For ENOENT paths, falls back to the
 * nearest existing ancestor's realpath so parent directories that don't exist
 * yet can still be classified correctly.
 */
export function resolveWorkspaceWriteAuthority(
  absPath: string,
  options: ResolveWorkspaceWriteAuthorityOptions = {},
): WorkspaceWriteAuthority {
  const absolutePath = path.resolve(absPath);
  const cache = options.cache;

  if (cache) {
    const cached = readCachedWorkspaceAuthority(cache, absolutePath);
    if (cached) return cached;
  }

  const { resolvedPath, usedParentFallback } = resolveRealPathForAuthority(absolutePath);
  const detectionPath = usedParentFallback ? resolvedPath : path.dirname(resolvedPath);
  const authority: WorkspaceWriteAuthority = detectCloudStorage(detectionPath).isCloud
    ? 'desktop_fs_authoritative'
    : 'cloud_authoritative';

  if (cache) {
    cache.set(normalizeWorkspaceAuthorityCacheKey(detectionPath), authority);
    cache.set(normalizeWorkspaceAuthorityCacheKey(absolutePath), authority);
  }

  return authority;
}

/**
 * Detect macOS "Desktop & Documents Folders in iCloud" (a.k.a. iCloud Drive
 * in-place sync of `~/Documents` / `~/Desktop`).
 *
 * WHY THIS IS A SEPARATE SIGNAL (do NOT fold it into `detectCloudStorage`):
 * When that feature is ON, a workspace at `~/Documents/<name>` is physically
 * local but iCloud may still hydrate / lazily download files, so fs probes can
 * take far longer than the 5s local budget (the real-world iCloud hydration ETIMEDOUT storm). We only
 * want that knowledge to widen the *fs timeout* (and the remediation copy) — we
 * must NOT make `detectCloudStorage('~/Documents/...')` return `isCloud:true`,
 * because that flag is consumed by behaviours where treating in-place Documents
 * as cloud is data-loss-shaped or wrong:
 *   - `migrationExportService` sets `shouldCopyContent:false` for cloud-backed
 *     spaces → the physically-local Documents bytes would NOT be copied on
 *     migrate (it would wait for iCloud to "re-deliver" them) → data loss.
 *   - `shouldSkipCloudSymlinkTarget` (RC-1 scan-hang guard) would skip every
 *     symlink inside a Documents workspace.
 *   - `resolveWorkspaceWriteAuthority` would defer pulled-file writes expecting
 *     external delivery.
 * The regression guards in `cloudStorageUtils.test.ts` pin `detectCloudStorage`
 * / `shouldSkipCloudSymlinkTarget` to `isCloud:false` for `~/Documents/...` so a
 * future "simplification" can't silently fold this into the provider enum.
 *
 * MECHANISM (verified on a real Mac, sibling-run handoff §1b): the
 * `com.apple.file-provider-domain-id` extended attribute on the `~/Documents` /
 * `~/Desktop` ROOT directory carries a value beginning
 * `com.apple.CloudDocs.iCloudDriveFileProvider/…` when the feature is ON. The
 * xattr lives on the ROOT ONLY — it is NOT inherited by subfolders — so we read
 * it on the home root, not on the workspace subfolder. Reading the xattr does
 * not trigger an iCloud download. Other DISPROVEN mechanisms (don't reintroduce):
 * firmlink / `realpath` (does not redirect), `SF_DATALESS` (no `st_flags` in
 * Node `fs.Stats`), `brctl status` (~7s, sandbox-restricted).
 *
 * Cheap-then-strict, fail-safe → `false`:
 *   (a) darwin only; non-darwin / any error → `false`;
 *   (b) string guard: the path must be under `~/Documents` or `~/Desktop`
 *       (no I/O otherwise);
 *   (c) confirm via the root's `com.apple.file-provider-domain-id` xattr,
 *       cached per-process by root path.
 */
const ICLOUD_FILE_PROVIDER_DOMAIN_PREFIX = 'com.apple.CloudDocs.iCloudDriveFileProvider';
const APPLE_DATA_ROOT_NAMES = ['Documents', 'Desktop'] as const;
/** Per-process cache of whether a given Apple-data root carries the iCloud xattr. */
const inPlaceCloudRootCache = new Map<string, boolean>();

/**
 * Determine which Apple-data root (`~/Documents` or `~/Desktop`) an absolute
 * path lives under, if any. Returns the absolute root path or `null`.
 */
function appleDataRootFor(absPath: string): string | null {
  const home = os.homedir();
  if (!home) return null;
  const normalized = path.resolve(absPath);
  for (const name of APPLE_DATA_ROOT_NAMES) {
    const root = path.join(home, name);
    if (normalized === root || normalized.startsWith(root + path.sep)) {
      return root;
    }
  }
  return null;
}

/**
 * Read the `com.apple.file-provider-domain-id` xattr on a root directory and
 * report whether it identifies the iCloud Drive file provider. Cached per
 * process; fail-safe → `false` on any error (xattr absent, command missing,
 * non-zero exit, etc.).
 */
function rootCarriesIcloudFileProviderDomain(rootPath: string): boolean {
  const cached = inPlaceCloudRootCache.get(rootPath);
  if (cached !== undefined) return cached;

  let result = false;
  try {
    // `xattr -p <name> <path>` prints the value (or errors if absent). We do not
    // pass `-l`/`-r`, so this never recurses into the tree and never hydrates.
    const value = childProcess.execFileSync(
      'xattr',
      ['-p', 'com.apple.file-provider-domain-id', rootPath],
      {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
        timeout: 2000,
      },
    );
    result = value.includes(ICLOUD_FILE_PROVIDER_DOMAIN_PREFIX);
  } catch (err) {
    // Absent xattr, missing `xattr` binary, timeout, or any other failure →
    // treat as not-in-place-iCloud. This must never throw on the health hot path.
    ignoreBestEffortCleanup(err, {
      operation: 'detectInPlaceCloudDocuments.readXattr',
      reason: 'icloud-file-provider-xattr-read-failed-fail-safe-false',
      owner: 'core.cloudStorageUtils',
    });
    result = false;
  }

  inPlaceCloudRootCache.set(rootPath, result);
  return result;
}

/**
 * Darwin-only: is `absPath` inside an iCloud-synced `~/Documents` / `~/Desktop`
 * (the "Desktop & Documents Folders in iCloud" feature)? See the block comment
 * above for the rationale and mechanism. Returns `false` off darwin and on any
 * error. Wired into `getTimeoutForPath` (extended fs budget) and the
 * `checkWorkspaceAccessible` remediation copy ONLY — never into
 * `detectCloudStorage`'s provider enum.
 *
 * @internal Exposed for testing; `_resetInPlaceCloudDocumentsCache` clears the
 *           per-process cache between tests.
 */
export function detectInPlaceCloudDocuments(absPath: string): boolean {
  if (process.platform !== 'darwin') return false;
  const root = appleDataRootFor(absPath);
  if (!root) return false;
  return rootCarriesIcloudFileProviderDomain(root);
}

/** Test-only: clear the per-process in-place-iCloud detection cache. */
export function _resetInPlaceCloudDocumentsCache(): void {
  inPlaceCloudRootCache.clear();
}

/** Default timeout for local filesystem operations (ms) */
export const FS_TIMEOUT_LOCAL_MS = 5000;

/** Extended timeout for cloud storage operations (ms) - hydration may be slow */
export const FS_TIMEOUT_CLOUD_MS = 15000;

/**
 * Get appropriate timeout for filesystem operations based on path.
 * Returns extended timeout for cloud storage paths AND for macOS in-place iCloud
 * `~/Documents` / `~/Desktop` workspaces (which are physically local but may
 * still hydrate slowly). The in-place-iCloud signal is intentionally kept out of
 * `detectCloudStorage` — see `detectInPlaceCloudDocuments`.
 */
export function getTimeoutForPath(pathStr: string): number {
  const { isCloud } = detectCloudStorage(pathStr);
  if (isCloud || detectInPlaceCloudDocuments(pathStr)) {
    return FS_TIMEOUT_CLOUD_MS;
  }
  return FS_TIMEOUT_LOCAL_MS;
}
