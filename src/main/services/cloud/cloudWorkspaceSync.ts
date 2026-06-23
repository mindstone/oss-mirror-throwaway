/**
 * Cloud Workspace Sync
 *
 * Bidirectional incremental workspace sync between desktop and cloud.
 * Desktop maintains a persistent local manifest, compares mtime to detect
 * changes, hashes only changed files, and pushes them to cloud via the
 * existing `POST /api/library/upload-file` endpoint during outbox drain.
 * Cloud-originated changes are pulled back with 3-way conflict detection.
 *
 * ## Design
 *
 * - **Desktop is authoritative for conflicts.** Both desktop and cloud can
 *   modify workspace files. A pull phase detects cloud-originated changes
 *   using manifest comparison (local hash vs cloud hash vs last-pushed hash).
 *   Conflicts are broadcast for user resolution.
 * - **Memory content (facts, topics, markdown) lives in the workspace directory.**
 *   Workspace manifest sync covers these files. No separate memory sync needed.
 * - **Persistent manifest** stored in `sessions/cloud-workspace-manifest.json`.
 *   Only files whose mtime changed since last push are re-hashed.
 * - **5-minute throttle.** `syncIfNeeded()` returns immediately if last sync
 *   was < 5 minutes ago.
 * - **.gitignore patterns are respected.** Common directories (node_modules,
 *   .git, etc.) are always skipped.
 * - **Symlinks are followed.** Directory symlinks (including those pointing
 *   outside the workspace, e.g. Google Drive, Dropbox, git submodules) are
 *   traversed so the cloud workspace mirrors the full local workspace.
 *   Cycle detection via visited realpaths prevents infinite recursion.
 *   Symlinks into sensitive directories (~/.ssh, ~/.aws, etc.) are blocked.
 * - **File size limits.** Files > 50MB are skipped entirely. Files 7–50MB
 *   are skipped with a warning (cloud body cap is 10MB, base64 expands ~33%).
 *   Only files < 7MB are pushed.
 * - **Event-loop yielding.** Walk yields every N files to avoid blocking
 *   the main process.
 *
 * ## Integration
 *
 * `cloudRouter.ts` calls `syncIfNeeded()` during `drainOutbox()` after session
 * delivery. Errors are logged but not thrown (fire-and-forget).
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as crypto from 'crypto';
import { createScopedLogger } from '@core/logger';
import { getBroadcastService } from '@core/broadcastService';
import { getErrorReporter } from '@core/errorReporter';
import { getSessionMutex } from '@core/services/sessionMutex';
import { appendDiagnosticEvent } from '@core/services/diagnosticEventsLedger';
import { toPortablePath } from '@core/utils/portablePath';
import { safeWalkDirectory, type SafeWalkResult, type SafeWalkTruncationReason } from '@core/utils/safeWalkDirectory';
import {
  createWorkspaceWriteAuthorityCache,
  resolveWorkspaceWriteAuthority,
} from '@core/utils/cloudStorageUtils';
import { getDataPath } from '../../utils/dataPaths';
import { toDiagnosticContinuityTransition } from '@shared/diagnostics/continuityTransition';
import { ALWAYS_SKIP_DIRS, ALWAYS_SKIP_NAMES, WORKSPACE_SYNC_TEMP_MARKER } from '@shared/workspaceConstants';
import { WORKSPACE_CONFLICT_MARKER } from '@shared/conflictPatterns';
import { DRIVE_AWARE_SYNC_DEFERRED_CHANNEL } from '@shared/ipc/broadcasts';
import { assertNever } from '@shared/utils/assertNever';
import { ignoreBestEffortCleanup } from '@shared/utils/intentionalSwallow';
import { isCloudServiceError } from './cloudRouterHelpers';
import {
  clearDriveSettleDeferral,
  evaluateDriveSettleDeferral,
  getActiveDriveSettleDeferrals,
  _resetDriveSettleDeferralsForTesting,
} from './driveSettleDeferral';
import { writeFileAtomicInTargetDirSync } from './cloudAtomicWrite';
import {
  clearPendingCloudUpdate,
  getPendingCloudUpdate,
  getPendingCloudUpdates,
  recordPendingCloudUpdate,
  updatePendingCloudUpdateCloudHash,
  _resetPendingCloudUpdatesForTesting,
} from './cloudPendingUpdateStore';
import {
  quarantineWorkspaceCloudConflict,
  _resetQuarantinedWorkspaceConflictsForTesting,
} from './cloudConflictQuarantine';
import {
  buildDriveAwareWorkspaceFingerprint,
  hasDriveAwareSyncNoticeBeenShown,
  markDriveAwareSyncNoticeShown,
} from './driveAwareSyncNoticeStore';
import {
  isExistingDirectory,
  isSuppressibleConflictCopy,
  isSuppressibleConflictDir,
  shouldSuppressConflictDirAncestor,
} from './workspaceSyncPolicy';

/** CloudServiceError codes that mean the host is unreachable — no point in
 * retrying the rest of a per-file batch when one file already proved the
 * server can't be reached. */
const HOST_UNREACHABLE_CODES = new Set([
  'CLOUD_UNREACHABLE',
  'DNS_NOT_PROPAGATED',
  'DNS_CACHE_STALE',
]);

const log = createScopedLogger({ service: 'cloudWorkspaceSync' });
const workspaceMutex = getSessionMutex();

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const SESSIONS_DIR = 'sessions';
const MANIFEST_FILENAME = 'cloud-workspace-manifest.json';

/** Throttle: minimum time between syncs (5 minutes). */
const SYNC_THROTTLE_MS = 5 * 60 * 1000;

/** syncSoon() trailing debounce: wait for this many ms of silence before syncing. */
const SYNC_SOON_DEBOUNCE_MS = 15_000;

/** syncSoon() max-wait: cap delay during sustained activity (e.g. npm install). */
const SYNC_SOON_MAX_WAIT_MS = 2 * 60 * 1000;

/** Files larger than this are skipped entirely. */
const MAX_FILE_SIZE = 50 * 1024 * 1024; // 50MB

/**
 * Files smaller than this are pushed via upload-file (base64).
 * Cloud body cap is 10MB; base64 expands ~33%, so 7MB raw ≈ 9.3MB encoded.
 */
const UPLOAD_SIZE_LIMIT = 7 * 1024 * 1024; // 7MB

/** Yield to event loop every N files during walk. */
const YIELD_EVERY_N_FILES = 100;
const WORKSPACE_TOCTOU_MAX_RETRIES = 1;

/**
 * Coarse OP-LEVEL deadline for the whole local-manifest walk (Stage 10).
 *
 * `buildLocalManifest` DELIBERATELY mirrors the full local workspace, including
 * directory symlinks into cloud storage (`skipCloudSymlinkTargets: false`), so
 * it cannot simply skip cloud the way background indexing does. On a HEALTHY
 * mount the walk is fast; on a DEAD/unresponsive cloud mount, even though each
 * cloud `readdir`/`realpath` syscall is individually bounded by the walker's
 * cloud budget (Stage 5), a deep dead subtree could otherwise drag the whole
 * walk on entry-by-entry without an overall cap. This deadline is plugged into
 * `safeWalkDirectory`'s `signal` so the walk aborts cleanly BETWEEN entries
 * once exceeded — `truncatedReasons` then carries `'aborted'`, the manifest is
 * reported incomplete, and `executeSyncCore` already skips all destructive
 * delete/repair operations on an incomplete manifest (fail-closed).
 *
 * ACCEPTED RESIDUAL (honest, coarse-by-design): `AbortSignal` only bounds the
 * cadence BETWEEN filesystem operations — it cannot interrupt a single kernel
 * syscall mid-flight (`Promise.race` / abort can't cancel in-flight I/O). The
 * walker bounds its OWN cloud `readdir`/`realpath` with the cloud budget, but
 * this method's `onFile` callback runs `fs.realpathSync`/`fs.statSync`/`hashFile`
 * directly on each file, and a single one of those stuck on a dead placeholder
 * could still block past the deadline until it settles. We accept that residual
 * here rather than route every per-file syscall through the off-thread prober:
 * sync runs rarely, off the turn-critical path, and a clean bounded abort with a
 * visible incomplete-manifest outcome is sufficient. The `UV_THREADPOOL_SIZE`
 * floor bounds the blast radius of any such parked worker. See Stage 10 in
 * docs/plans/260619_cloud-symlink-indexing/PLAN.md.
 */
const WORKSPACE_MANIFEST_WALK_TIMEOUT_MS = 60_000;
const PULL_FAILURE_INITIAL_BACKOFF_MS = 5 * 60 * 1000;
const PULL_FAILURE_MAX_BACKOFF_MS = 6 * 60 * 60 * 1000;
const PULL_FAILURE_MAX_BACKOFF_AFTER_IDENTICAL_FAILURES = 3;

/**
 * Short SHA-1 fingerprint for breadcrumb fields. Intentionally **not** FNV
 * (unlike the other `hashForBreadcrumb` helpers in this codebase) — this is
 * a workspace-directory fingerprint, not a session-ID hash, and the SHA-1
 * vs FNV distinction is preserved for backwards-compat with any existing
 * Sentry breadcrumb correlations. Renamed from `hashForBreadcrumb` to
 * disambiguate during the FNV centralisation
 * (see docs/plans/260501_fnv_hash_centralization.md, Variant B).
 */
function shortSha1Fingerprint(input: string): string {
  return crypto.createHash('sha1').update(input).digest('hex').slice(0, 8);
}

function recordWorkspaceSyncContinuityBreadcrumb(args: {
  data: Record<string, unknown>;
}): void {
  getErrorReporter().addBreadcrumb({
    category: 'continuity.continuity-state',
    level: 'warning',
    message: 'state-transition',
    data: args.data,
  });
  appendDiagnosticEvent(toDiagnosticContinuityTransition({
    family: 'workspace_sync',
    category: 'continuity.continuity-state',
    level: 'warning',
    message: 'state-transition',
    data: args.data,
  }));
}

function buildManifestFingerprint(manifest: WorkspaceManifest, paths: string[]): string {
  const hash = crypto.createHash('sha1');
  const normalizedPaths = [...new Set(paths)].sort();
  for (const relativePath of normalizedPaths) {
    hash.update(relativePath);
    const entry = manifest.get(relativePath);
    if (!entry) {
      hash.update('missing');
      continue;
    }
    hash.update(entry.hash);
    hash.update(String(entry.mtime));
    hash.update(String(entry.size));
  }
  return hash.digest('hex');
}

/** Max concurrent file uploads/deletes to cloud. */
const PUSH_CONCURRENCY = 5;


/**
 * Sensitive directory names that must never be synced to cloud, even if
 * reachable via symlink. Checked against the resolved target path's basename
 * and against each ancestor directory name during the walk.
 */
const SENSITIVE_PATH_PATTERNS: readonly string[] = [
  '.ssh',
  '.gnupg',
  '.gpg',
  '.aws',
  '.azure',
  '.kube',
  '.docker',
  '.npmrc',
  '.pypirc',
  '.netrc',
  'Keychains',
  '.credentials',
  '.config/gcloud',
  '.terraform',
];

/**
 * Returns true if the resolved real path passes through or into a sensitive
 * directory that should never be synced to cloud.
 */

// Manifest envelope + completeness gating — incomplete walks fail-closed on destructive ops. See docs/plans/260503_s9_bounded_walker_resource_budget.md.

export function isSensitivePath(realpath: string, homeDir?: string): boolean {
  const home = homeDir ?? os.homedir();
  for (const pattern of SENSITIVE_PATH_PATTERNS) {
    const sensitive = path.join(home, pattern);
    if (realpath === sensitive || realpath.startsWith(sensitive + path.sep)) {
      return true;
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ManifestEntry {
  mtime: number;
  size: number;
  hash: string;
}

export type WorkspaceManifest = Map<string, ManifestEntry>;

export interface LocalManifestResult {
  readonly manifest: WorkspaceManifest;
  readonly complete: boolean;
  readonly reasons: readonly SafeWalkTruncationReason[];
}

/** Minimal client interface for pushing files. */
export interface SyncClient {
  post(path: string, body: unknown): Promise<unknown>;
}

export interface PushResult {
  pushed: number;
  skipped: number;
  failed: number;
  /** Files skipped because the cloud host became unreachable mid-batch. */
  aborted?: number;
}

export interface PullResult {
  pulled: number;
  skipped: number;
  conflicts: number;
  conflictPaths: string[];
  newFiles: number;
  /** Files eligible for pull but deferred to a future sync cycle (bounded batch). */
  deferred: number;
  /** Files deferred so Drive/Desktop can deliver them first (REBEL-5QS). */
  deferredDriveSettle: number;
  /** Files force-pulled after drive-settle timeout/cycle cap. */
  forcedAfterSettle: number;
  /** Edited files skipped because the desktop cloud provider owns local writes. */
  deferredEditedCloud: number;
}

/**
 * Outcome of applying a single user-requested "pending cloud update" — the
 * deliberate fast-forward of one Drive/Dropbox/iCloud-owned file to the newer
 * version that exists only in Rebel's cloud (edited on phone/web). This is a
 * one-shot, user-initiated keep-cloud apply, NOT the auto pull loop.
 *
 * `reason` is a coarse, log/telemetry-friendly classification so the renderer
 * can show the right error toast without parsing the human message.
 */
export type ApplyPendingCloudUpdateResult =
  | { success: true }
  | {
    success: false;
    /** Stable, non-localised classification for branching/telemetry. */
    reason:
      | 'not_configured'
      | 'cloud_offline'
      | 'not_pending'
      | 'cloud_changed'
      | 'local_changed'
      | 'already_current'
      | 'path_unsafe'
      | 'cloud_read_failed'
      | 'local_read_failed'
      | 'write_failed';
    /** Plain, user-facing-safe message (no raw codes). */
    error: string;
  };

/** Cloud manifest envelope returned by POST /api/library/manifest. */
export interface CloudManifest {
  readonly entries: Readonly<Record<string, { hash: string; size: number }>>;
  readonly complete: boolean;
  readonly reasons: readonly string[];
}

type PullFailureTerminalCause =
  | 'dangling_symlink_parent'
  | 'parent_not_directory'
  | 'path_traversal'
  | 'cloud_invalid_path'
  | 'cloud_file_too_large';

type PullFailureTransientCause =
  | 'permission'
  | 'missing'
  | 'cloud_not_found'
  | 'host_unreachable'
  | 'cloud_http'
  | 'unknown';

type PullFailureClassification =
  | {
    disposition: 'terminal';
    cause: PullFailureTerminalCause;
    signature: string;
  }
  | {
    disposition: 'transient';
    cause: PullFailureTransientCause;
    signature: string;
    hostUnreachable: boolean;
  };

interface PullFailureMemoEntry {
  relativePath: string;
  cloudHash: string;
  cause: PullFailureTerminalCause | PullFailureTransientCause;
  classificationKind: PullFailureClassification['disposition'];
  failureSignature: string;
  consecutiveFailures: number;
  firstFailedAt: number;
  lastFailedAt: number;
  nextRetryAt: number;
  backoffMs: number;
  terminalWarned: boolean;
}

interface OversizedPushMemoEntry {
  relativePath: string;
  hash: string;
  size: number;
  firstSeenAt: number;
  lastSeenAt: number;
}

type PullFailureMemoConsultResult =
  | { action: 'allow' }
  | { action: 'suppress'; entry: PullFailureMemoEntry }
  | { action: 'file_exists_locally'; entry: PullFailureMemoEntry };

class PullPreflightError extends Error {
  constructor(
    public readonly code:
      | 'PULL_PATH_TRAVERSAL'
      | 'PULL_PARENT_DANGLING_SYMLINK'
      | 'PULL_PARENT_NOT_DIRECTORY',
    message: string,
  ) {
    super(message);
    this.name = 'PullPreflightError';
  }
}

/** Max files to pull per sync cycle — bounded batch size for progressive pull.
 * When more candidates exist, this many are pulled per cycle (sorted
 * alphabetically for determinism) and the rest are deferred to subsequent
 * cycles. This replaces the previous all-or-nothing safety gate that
 * permanently wedged workspaces with large backlogs (REBEL-57V, 546 files). */
const MAX_PULL_FILES = 50;

/** Text file extensions safe to pull via UTF-8 read. Binary files excluded. */
const TEXT_EXTENSIONS = new Set([
  '.md', '.txt', '.json', '.yaml', '.yml', '.csv', '.tsv',
  '.xml', '.html', '.htm', '.css', '.js', '.ts', '.jsx', '.tsx',
  '.py', '.rb', '.sh', '.bash', '.zsh', '.toml', '.ini', '.cfg',
  '.env', '.log', '.sql', '.graphql', '.gql', '.mdx', '.rst',
  '.tex', '.bib', '.org', '.wiki', '.adoc', '.svg',
]);

function errnoCode(err: unknown): string | undefined {
  if (!err || typeof err !== 'object') return undefined;
  const code = (err as { code?: unknown }).code;
  return typeof code === 'string' ? code : undefined;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function cloudStatusCode(err: unknown): number | undefined {
  if (!err || typeof err !== 'object') return undefined;
  const statusCode = (err as { statusCode?: unknown; status?: unknown }).statusCode
    ?? (err as { status?: unknown }).status;
  return typeof statusCode === 'number' ? statusCode : undefined;
}

function classifyPullFailure(err: unknown): PullFailureClassification {
  if (err instanceof PullPreflightError) {
    switch (err.code) {
      case 'PULL_PARENT_DANGLING_SYMLINK':
        return { disposition: 'terminal', cause: 'dangling_symlink_parent', signature: err.code };
      case 'PULL_PARENT_NOT_DIRECTORY':
        return { disposition: 'terminal', cause: 'parent_not_directory', signature: err.code };
      case 'PULL_PATH_TRAVERSAL':
        return { disposition: 'terminal', cause: 'path_traversal', signature: err.code };
      default:
        return assertNever(err.code);
    }
  }

  const code = errnoCode(err);
  if (code === 'ENOTDIR') {
    return { disposition: 'terminal', cause: 'parent_not_directory', signature: code };
  }
  if (code === 'EACCES' || code === 'EPERM') {
    return { disposition: 'transient', cause: 'permission', signature: code, hostUnreachable: false };
  }
  if (code === 'ENOENT') {
    return { disposition: 'transient', cause: 'missing', signature: code, hostUnreachable: false };
  }

  if (isCloudServiceError(err)) {
    if (HOST_UNREACHABLE_CODES.has(err.code)) {
      return { disposition: 'transient', cause: 'host_unreachable', signature: err.code, hostUnreachable: true };
    }
    const statusCode = cloudStatusCode(err);
    if (err.code === 'INVALID_PATH' || /path traversal|containment/i.test(err.message)) {
      return { disposition: 'terminal', cause: 'cloud_invalid_path', signature: `${err.code}:${statusCode ?? 'unknown'}` };
    }
    if (
      err.code === 'WORKSPACE_FILE_TOO_LARGE'
      || err.code === 'FILE_TOO_LARGE'
      || (statusCode === 413 && /too large/i.test(err.message))
    ) {
      return { disposition: 'terminal', cause: 'cloud_file_too_large', signature: `${err.code}:${statusCode ?? 'unknown'}` };
    }
    if (statusCode === 404) {
      return { disposition: 'transient', cause: 'cloud_not_found', signature: `${err.code}:${statusCode}`, hostUnreachable: false };
    }
    return { disposition: 'transient', cause: 'cloud_http', signature: `${err.code}:${statusCode ?? 'unknown'}`, hostUnreachable: false };
  }

  return { disposition: 'transient', cause: 'unknown', signature: `${code ?? 'unknown'}:${errorMessage(err)}`, hostUnreachable: false };
}

function nextPullFailureBackoffMs(consecutiveFailures: number): number {
  if (consecutiveFailures >= PULL_FAILURE_MAX_BACKOFF_AFTER_IDENTICAL_FAILURES) {
    return PULL_FAILURE_MAX_BACKOFF_MS;
  }
  return Math.min(
    PULL_FAILURE_INITIAL_BACKOFF_MS * (2 ** Math.max(0, consecutiveFailures - 1)),
    PULL_FAILURE_MAX_BACKOFF_MS,
  );
}

// ---------------------------------------------------------------------------
// .gitignore parsing (simple pattern matching)
// ---------------------------------------------------------------------------

/**
 * Parse a .gitignore file into a list of patterns.
 * Supports: plain names, directory patterns (trailing /), negation (!), wildcards (*).
 * Does NOT support full git globbing (**, ?, []).
 */
function parseGitignore(content: string): string[] {
  return content
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'));
}

/**
 * Check if a relative path matches any .gitignore pattern.
 * Simple matcher — covers the common cases but not full git spec.
 */
function matchesGitignore(relativePath: string, patterns: string[]): boolean {
  const parts = relativePath.split('/');
  const fileName = parts[parts.length - 1];

  for (const pattern of patterns) {
    // Negation — skip (we don't re-include)
    if (pattern.startsWith('!')) continue;

    const cleanPattern = pattern.replace(/\/$/, '');

    // Exact directory/file name match at any level
    if (parts.includes(cleanPattern)) return true;

    // Simple wildcard: *.ext
    if (cleanPattern.startsWith('*.')) {
      const ext = cleanPattern.slice(1); // e.g. '.log'
      if (fileName.endsWith(ext)) return true;
    }

    // Simple prefix match: dir/
    if (pattern.endsWith('/') && relativePath.startsWith(cleanPattern + '/')) return true;

    // Exact path match
    if (relativePath === cleanPattern) return true;
  }

  return false;
}

// ---------------------------------------------------------------------------
// Concurrency utility
// ---------------------------------------------------------------------------

/**
 * Map items through an async function with bounded concurrency.
 * Same pattern as `mapWithConcurrencyLimit` in super-mcp/src/handlers/healthCheck.ts.
 */
async function mapWithConcurrency<T, R>(
  items: T[],
  fn: (item: T) => Promise<R>,
  limit: number,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let nextIndex = 0;

  async function worker(): Promise<void> {
    while (nextIndex < items.length) {
      const i = nextIndex++;
      results[i] = await fn(items[i]);
    }
  }

  const workers = Array.from({ length: Math.min(limit, items.length) }, () => worker());
  await Promise.all(workers);
  return results;
}

// ---------------------------------------------------------------------------
// CloudWorkspaceSync class
// ---------------------------------------------------------------------------

export class CloudWorkspaceSync {
  private readonly dataPathOverride?: string;

  /** Last-pushed manifest (persisted to disk). */
  private lastPushedManifest: WorkspaceManifest = new Map();
  private loaded = false;
  private writeTimer: ReturnType<typeof setTimeout> | null = null;
  private lastSyncAt = 0;
  private syncInProgress = false;
  private syncStartedAt: number | null = null;

  /** Conflict paths already broadcast to the renderer (prevents repeat toasts). */
  private broadcastedConflictKeys = new Set<string>();

  // syncSoon() debounce state
  private syncSoonDebounceTimer: ReturnType<typeof setTimeout> | null = null;
  private syncSoonMaxWaitTimer: ReturnType<typeof setTimeout> | null = null;
  private pendingSyncClient: SyncClient | null = null;
  private pendingSyncDir: string | null = null;

  // Dirty-flag re-arm: when a watcher-driven sync is throttled, schedule retry.
  // Uses a generation counter so that a sync completing doesn't clear dirty state
  // set by watcher events that arrived after the sync's manifest snapshot.
  private dirtyGeneration = 0;
  private syncedThroughGeneration = 0;
  private dirtySyncTimer: ReturnType<typeof setTimeout> | null = null;
  private driveAwarePullCycle = 0;
  private pullFailureMemos = new Map<string, PullFailureMemoEntry>();
  private oversizedPushMemos = new Map<string, OversizedPushMemoEntry>();

  constructor(opts?: { dataPath?: string }) {
    this.dataPathOverride = opts?.dataPath;
  }

  private get filePath(): string {
    return path.join(this.dataPathOverride ?? getDataPath(), SESSIONS_DIR, MANIFEST_FILENAME);
  }

  private normalizeWorkspaceKey(coreDirectory: string): string {
    return path.resolve(coreDirectory);
  }

  private pullFailureMemoKey(coreDirectory: string, relativePath: string, cloudHash: string): string {
    return `${this.normalizeWorkspaceKey(coreDirectory)}::${relativePath}::${cloudHash}`;
  }

  private pullFailureMemoPrefix(coreDirectory: string, relativePath: string): string {
    return `${this.normalizeWorkspaceKey(coreDirectory)}::${relativePath}::`;
  }

  private clearPullFailureMemosForPath(coreDirectory: string, relativePath: string): void {
    const prefix = this.pullFailureMemoPrefix(coreDirectory, relativePath);
    for (const key of this.pullFailureMemos.keys()) {
      if (key.startsWith(prefix)) {
        this.pullFailureMemos.delete(key);
      }
    }
  }

  private clearPullFailureMemosForWorkspace(coreDirectory: string): void {
    const prefix = `${this.normalizeWorkspaceKey(coreDirectory)}::`;
    for (const key of this.pullFailureMemos.keys()) {
      if (key.startsWith(prefix)) {
        this.pullFailureMemos.delete(key);
      }
    }
  }

  private countPullFailureMemosForWorkspace(coreDirectory: string): number {
    const prefix = `${this.normalizeWorkspaceKey(coreDirectory)}::`;
    let count = 0;
    for (const key of this.pullFailureMemos.keys()) {
      if (key.startsWith(prefix)) {
        count++;
      }
    }
    return count;
  }

  private oversizedPushMemoKey(coreDirectory: string, relativePath: string, hash: string): string {
    return `${this.normalizeWorkspaceKey(coreDirectory)}::${relativePath}::${hash}`;
  }

  private oversizedPushMemoPrefix(coreDirectory: string, relativePath: string): string {
    return `${this.normalizeWorkspaceKey(coreDirectory)}::${relativePath}::`;
  }

  private clearOversizedPushMemosForPath(coreDirectory: string, relativePath: string): void {
    const prefix = this.oversizedPushMemoPrefix(coreDirectory, relativePath);
    for (const key of this.oversizedPushMemos.keys()) {
      if (key.startsWith(prefix)) {
        this.oversizedPushMemos.delete(key);
      }
    }
  }

  private shouldSuppressOversizedPush(params: {
    coreDirectory: string;
    relativePath: string;
    entry: ManifestEntry;
  }): boolean {
    if (params.entry.size <= UPLOAD_SIZE_LIMIT) {
      this.clearOversizedPushMemosForPath(params.coreDirectory, params.relativePath);
      return false;
    }

    const prefix = this.oversizedPushMemoPrefix(params.coreDirectory, params.relativePath);
    const key = this.oversizedPushMemoKey(params.coreDirectory, params.relativePath, params.entry.hash);
    for (const existingKey of this.oversizedPushMemos.keys()) {
      if (existingKey.startsWith(prefix) && existingKey !== key) {
        this.oversizedPushMemos.delete(existingKey);
      }
    }

    const nowMs = Date.now();
    const existing = this.oversizedPushMemos.get(key);
    if (existing) {
      existing.size = params.entry.size;
      existing.lastSeenAt = nowMs;
      return true;
    }

    this.oversizedPushMemos.set(key, {
      relativePath: params.relativePath,
      hash: params.entry.hash,
      size: params.entry.size,
      firstSeenAt: nowMs,
      lastSeenAt: nowMs,
    });
    log.warn(
      { path: params.relativePath, size: params.entry.size, limit: UPLOAD_SIZE_LIMIT, hash: params.entry.hash },
      'Skipping file exceeding upload size limit',
    );
    return true;
  }

  private buildEffectivePushSet(
    filesToPush: string[],
    coreDirectory: string,
    localManifest: WorkspaceManifest,
  ): string[] {
    const effectivePushSet: string[] = [];
    let oversizedSuppressed = 0;

    for (const relativePath of filesToPush) {
      const entry = localManifest.get(relativePath);
      if (entry && this.shouldSuppressOversizedPush({ coreDirectory, relativePath, entry })) {
        oversizedSuppressed++;
        continue;
      }
      effectivePushSet.push(relativePath);
    }

    if (oversizedSuppressed > 0) {
      log.debug(
        { total: filesToPush.length, suppressed: oversizedSuppressed, effective: effectivePushSet.length },
        'Workspace push oversized memo summary',
      );
    }

    return effectivePushSet;
  }

  private consultPullFailureMemo(params: {
    coreDirectory: string;
    relativePath: string;
    cloudHash: string;
    localPath: string;
    reason: 'edited' | 'new';
    nowMs: number;
  }): PullFailureMemoConsultResult {
    const prefix = this.pullFailureMemoPrefix(params.coreDirectory, params.relativePath);
    const key = this.pullFailureMemoKey(params.coreDirectory, params.relativePath, params.cloudHash);
    for (const existingKey of this.pullFailureMemos.keys()) {
      if (existingKey.startsWith(prefix) && existingKey !== key) {
        this.pullFailureMemos.delete(existingKey);
      }
    }

    const entry = this.pullFailureMemos.get(key);
    if (!entry) {
      return { action: 'allow' };
    }

    if (params.reason === 'new' && fs.existsSync(params.localPath)) {
      this.pullFailureMemos.delete(key);
      log.info(
        {
          path: params.relativePath,
          cloudHash: params.cloudHash,
          cause: entry.cause,
        },
        'Workspace pull failure memo cleared because file now exists locally',
      );
      return { action: 'file_exists_locally', entry };
    }

    if (entry.nextRetryAt <= params.nowMs) {
      log.info(
        {
          path: params.relativePath,
          cloudHash: params.cloudHash,
          cause: entry.cause,
          consecutiveFailures: entry.consecutiveFailures,
          backoffMs: entry.backoffMs,
        },
        'Workspace pull failure memo expired; retrying file',
      );
      return { action: 'allow' };
    }

    return { action: 'suppress', entry };
  }

  private recordPullFailureMemo(params: {
    coreDirectory: string;
    relativePath: string;
    cloudHash: string;
    classification: PullFailureClassification;
    err: unknown;
    nowMs: number;
  }): { entry: PullFailureMemoEntry; terminalWarnShouldEmit: boolean } {
    const key = this.pullFailureMemoKey(params.coreDirectory, params.relativePath, params.cloudHash);
    const existing = this.pullFailureMemos.get(key);
    const sameFailure = existing?.failureSignature === params.classification.signature;
    const consecutiveFailures = sameFailure ? existing.consecutiveFailures + 1 : 1;

    let backoffMs: number;
    switch (params.classification.disposition) {
      case 'terminal':
        backoffMs = PULL_FAILURE_MAX_BACKOFF_MS;
        break;
      case 'transient':
        backoffMs = nextPullFailureBackoffMs(consecutiveFailures);
        break;
      default:
        assertNever(params.classification);
    }

    const entry: PullFailureMemoEntry = {
      relativePath: params.relativePath,
      cloudHash: params.cloudHash,
      cause: params.classification.cause,
      classificationKind: params.classification.disposition,
      failureSignature: params.classification.signature,
      consecutiveFailures,
      firstFailedAt: existing?.firstFailedAt ?? params.nowMs,
      lastFailedAt: params.nowMs,
      nextRetryAt: params.nowMs + backoffMs,
      backoffMs,
      terminalWarned: existing?.terminalWarned ?? false,
    };

    const terminalWarnShouldEmit = params.classification.disposition === 'terminal' && !entry.terminalWarned;
    if (terminalWarnShouldEmit) {
      entry.terminalWarned = true;
    }
    this.pullFailureMemos.set(key, entry);

    log.info(
      {
        path: params.relativePath,
        cloudHash: params.cloudHash,
        cause: entry.cause,
        classification: entry.classificationKind,
        consecutiveFailures,
        backoffMs,
        nextRetryAt: entry.nextRetryAt,
        err: errorMessage(params.err),
      },
      'Workspace pull failure memo recorded',
    );

    return { entry, terminalWarnShouldEmit };
  }

  private preflightPullWritePath(coreDirectory: string, relativePath: string, localPath: string): void {
    const coreResolved = path.resolve(coreDirectory);
    const coreResolvedBase = coreResolved.endsWith(path.sep) ? coreResolved : `${coreResolved}${path.sep}`;
    if (!localPath.startsWith(coreResolvedBase) && localPath !== coreResolved) {
      throw new PullPreflightError('PULL_PATH_TRAVERSAL', 'Path traversal blocked in pull');
    }

    const parentDir = path.dirname(localPath);
    const relativeParent = path.relative(coreResolved, parentDir);
    if (!relativeParent || relativeParent === '.') {
      return;
    }

    let current = coreResolved;
    for (const segment of relativeParent.split(path.sep)) {
      if (!segment) continue;
      current = path.join(current, segment);

      let lst: fs.Stats;
      try {
        lst = fs.lstatSync(current);
      } catch (err) {
        if (errnoCode(err) === 'ENOENT') {
          ignoreBestEffortCleanup(err, {
            operation: 'cloudWorkspaceSync.preflightPullWritePath',
            reason: 'parent-disappeared-before-pull-write',
            owner: 'main.cloudWorkspaceSync',
          });
          return;
        }
        throw err;
      }

      if (lst.isSymbolicLink()) {
        try {
          const stat = fs.statSync(current);
          if (!stat.isDirectory()) {
            throw new PullPreflightError('PULL_PARENT_NOT_DIRECTORY', `Parent path is not a directory: ${current}`);
          }
        } catch (err) {
          if (err instanceof PullPreflightError) throw err;
          throw new PullPreflightError('PULL_PARENT_DANGLING_SYMLINK', `Parent path is a dangling symlink: ${current}`);
        }
        continue;
      }

      if (!lst.isDirectory()) {
        throw new PullPreflightError('PULL_PARENT_NOT_DIRECTORY', `Parent path is not a directory: ${current}`);
      }
    }
  }

  // ---- Persistence --------------------------------------------------------

  load(): void {
    if (this.loaded) return;
    try {
      if (fs.existsSync(this.filePath)) {
        const raw = fs.readFileSync(this.filePath, 'utf8');
        const parsed = JSON.parse(raw) as Record<string, ManifestEntry>;
        this.lastPushedManifest = new Map(
          Object.entries(parsed).filter(
            ([, e]) => e && typeof e.mtime === 'number' && typeof e.size === 'number' && typeof e.hash === 'string',
          ),
        );
        log.info({ count: this.lastPushedManifest.size }, 'Loaded workspace manifest');
      }
    } catch (err) {
      log.warn({ err }, 'Failed to load workspace manifest, starting fresh');
      this.lastPushedManifest = new Map();
    }
    this.loaded = true;
  }

  private scheduleDiskWrite(): void {
    if (this.writeTimer) clearTimeout(this.writeTimer);
    this.writeTimer = setTimeout(() => {
      this.writeTimer = null;
      this.writeToDisk();
    }, 1_000);
  }

  private writeToDisk(): void {
    try {
      const dir = path.dirname(this.filePath);
      fs.mkdirSync(dir, { recursive: true });
      const data = Object.fromEntries(this.lastPushedManifest);
      fs.writeFileSync(this.filePath, JSON.stringify(data), 'utf8');
    } catch (err) {
      log.warn({ err }, 'Failed to write workspace manifest');
    }
  }

  flush(): void {
    if (this.writeTimer) {
      clearTimeout(this.writeTimer);
      this.writeTimer = null;
    }
    if (this.loaded) this.writeToDisk();
  }

  // ---- Workspace Walk -----------------------------------------------------

  /**
   * Build a manifest of the local workspace by walking the directory tree.
   *
   * Uses mtime-first comparison: only files whose mtime changed since the
   * last pushed manifest are re-hashed. Files with unchanged mtime reuse
   * the existing hash from the last pushed manifest.
   *
   * Follows symlinks (including directory symlinks outside the workspace)
   * so the cloud mirrors the full local workspace. Respects .gitignore,
   * detects symlink cycles, skips large files, and yields to the event
   * loop periodically.
   */
  async buildLocalManifest(coreDirectory: string): Promise<LocalManifestResult> {
    this.load();
    const manifest: WorkspaceManifest = new Map();
    const extraReasons = new Set<SafeWalkTruncationReason>();

    // ENOENT = file/dir disappeared mid-walk (benign race) or broken symlink (benign).
    // Anything else (EACCES, EPERM, ELOOP, EBUSY, ...) is a real silent skip we MUST surface
    // as 'unreadable' so executeSyncCore fails closed instead of treating the entry as deleted.
    const recordIfUnreadable = (err: unknown): void => {
      if (err instanceof Error && (err as NodeJS.ErrnoException).code !== 'ENOENT') {
        extraReasons.add('unreadable');
      }
    };

    // Read .gitignore from workspace root
    let gitignorePatterns: string[] = [];
    try {
      const gitignorePath = path.join(coreDirectory, '.gitignore');
      if (fs.existsSync(gitignorePath)) {
        const content = fs.readFileSync(gitignorePath, 'utf8');
        gitignorePatterns = parseGitignore(content);
      }
    } catch { /* ignore */ }

    let fileCount = 0;

    // Stage 10 — coarse OP-LEVEL bound: a dead/unresponsive cloud mount reached
    // via a workspace symlink must NOT hang the whole sync forever. We give the
    // entire walk an overall deadline (a wedged subtree that drips entries can't
    // run unbounded), plumbed through `safeWalkDirectory`'s `signal`, which
    // checks `signal.aborted` between entries. On abort the walker records
    // `'aborted'` in `truncatedReasons` ⇒ `complete: false` ⇒ `executeSyncCore`
    // surfaces it (log + Sentry breadcrumb via `reportIncompleteLocalManifest`)
    // and skips all destructive delete/repair ops. See the
    // `WORKSPACE_MANIFEST_WALK_TIMEOUT_MS` block comment for the accepted
    // residual (single in-flight syscall can't be interrupted mid-kernel).
    const walkAbortController = new AbortController();
    let walkDeadlineHit = false;
    const walkTimer = setTimeout(() => {
      walkDeadlineHit = true;
      walkAbortController.abort();
    }, WORKSPACE_MANIFEST_WALK_TIMEOUT_MS);

    let walkResult: SafeWalkResult;
    try {
      walkResult = await safeWalkDirectory(coreDirectory, {
      signal: walkAbortController.signal,
      // Cloud sync DELIBERATELY mirrors the full local workspace, including
      // directory symlinks that point into cloud storage (Google Drive,
      // Dropbox, OneDrive). Opt out of the walker's default-on cloud-symlink
      // skip so those subtrees are still walked and synced. Sensitive-path
      // exclusion is handled below via `isSensitivePath`; cycle/depth/path
      // caps still apply. (RC-1's cloud-symlink skip targets incidental
      // scans, not this cloud mirror.)
      skipCloudSymlinkTargets: false,
      onDirectory: ({ name, absolutePath, isSymbolicLink }) => {
        const relativePath = toPortablePath(path.relative(coreDirectory, absolutePath));

        if (ALWAYS_SKIP_NAMES.has(name)) return false;
        if (name.includes(WORKSPACE_SYNC_TEMP_MARKER)) return false;
        if (name.endsWith('.pending.md')) return false;
        if (name.includes(WORKSPACE_CONFLICT_MARKER)) return false;
        if (ALWAYS_SKIP_DIRS.has(name)) return false;
        if (matchesGitignore(relativePath, gitignorePatterns)) return false;

        // REBEL-5QS: skip Drive/Dropbox folder conflict copies (`Project (1)/`)
        // only when their original sibling is present as a real directory.
        if (
          isSuppressibleConflictDir(name, (originalBasename) =>
            isExistingDirectory(path.join(path.dirname(absolutePath), originalBasename)),
          )
        ) {
          // Observability: a folder skip excludes a whole subtree from sync — louder than a file skip.
          log.debug({ dir: relativePath }, 'REBEL-5QS: excluding conflict-copy directory from workspace push (sibling original present)');
          return false;
        }

        if (isSymbolicLink) {
          try {
            const realpath = fs.realpathSync(absolutePath);
            if (isSensitivePath(realpath)) {
              log.debug({ path: relativePath, target: realpath }, 'Skipping symlink to sensitive path');
              return false;
            }
            log.debug({ path: relativePath, target: realpath }, 'Following directory symlink');
          } catch (err) {
            recordIfUnreadable(err);
            return false;
          }
        }

        return true;
      },
      onFile: async ({ name, absolutePath, viaSymlink }) => {
        if (ALWAYS_SKIP_NAMES.has(name)) return;
        if (name.includes(WORKSPACE_SYNC_TEMP_MARKER)) return;
        if (name.endsWith('.pending.md')) return;
        if (name.includes(WORKSPACE_CONFLICT_MARKER)) return;

        // REBEL-62A: skip Google-Drive/Dropbox conflict copies (`foo (1).md`)
        // whose original sibling exists on disk in the same directory. This
        // stops Drive's conflict artifacts from being uploaded to Fly and
        // re-propagated to the peer machine (the runaway `(1)(1)(1)…` fan-out).
        // Sibling-gated so a standalone `Report (1).md` (no `Report.md`) still
        // syncs. Files only — `onDirectory` is intentionally untouched.
        if (
          isSuppressibleConflictCopy(name, (originalBasename) =>
            fs.existsSync(path.join(path.dirname(absolutePath), originalBasename)),
          )
        ) {
          return;
        }

        const relativePath = toPortablePath(path.relative(coreDirectory, absolutePath));

        if (viaSymlink) {
          try {
            const realpath = fs.realpathSync(absolutePath);
            if (isSensitivePath(realpath)) {
              log.debug({ path: relativePath, target: realpath }, 'Skipping symlink to sensitive path');
              return;
            }
          } catch (err) {
            recordIfUnreadable(err);
            return;
          }
        }

        if (matchesGitignore(relativePath, gitignorePatterns)) return;

        let stat: fs.Stats;
        try {
          stat = fs.statSync(absolutePath);
        } catch (err) {
          recordIfUnreadable(err);
          return; // ENOENT = disappeared mid-walk (benign); anything else recorded above.
        }

        if (!stat.isFile()) return;
        if (stat.size > MAX_FILE_SIZE) return;

        const mtimeMs = Math.floor(stat.mtimeMs);
        const lastEntry = this.lastPushedManifest.get(relativePath);
        if (lastEntry && lastEntry.mtime === mtimeMs && lastEntry.size === stat.size) {
          manifest.set(relativePath, { mtime: mtimeMs, size: stat.size, hash: lastEntry.hash });
        } else {
          try {
            const hash = await this.hashFile(absolutePath);
            manifest.set(relativePath, { mtime: mtimeMs, size: stat.size, hash });
          } catch (err) {
            extraReasons.add('unreadable');
            log.debug({ path: relativePath, err: err instanceof Error ? err.message : String(err) }, 'Skipping unreadable file');
            return;
          }
        }

        fileCount++;
        if (fileCount % YIELD_EVERY_N_FILES === 0) {
          await new Promise<void>((resolve) => setImmediate(resolve));
        }
      },
      });
    } finally {
      clearTimeout(walkTimer);
    }

    if (walkDeadlineHit) {
      // Observable, not silent: the overall walk deadline fired (likely a dead/
      // unresponsive cloud mount). `walkResult.truncatedReasons` already carries
      // `'aborted'`, which flows into `reasons` below ⇒ `complete: false` ⇒
      // `executeSyncCore` reports it and skips destructive deletes. Surface a
      // distinct warning so the dead-mount case is greppable, not buried in the
      // generic incomplete-manifest path.
      log.warn(
        { coreDirectory, timeoutMs: WORKSPACE_MANIFEST_WALK_TIMEOUT_MS, files: manifest.size },
        'Workspace manifest walk hit overall deadline — cloud mount unresponsive; sync continues with partial (incomplete) manifest',
      );
    }

    const reasons = Object.freeze([
      ...new Set<SafeWalkTruncationReason>([...walkResult.truncatedReasons, ...extraReasons]),
    ]);
    log.info({ files: manifest.size, complete: reasons.length === 0, reasons }, 'Built local workspace manifest');
    return { manifest, complete: reasons.length === 0, reasons };
  }

  /**
   * Get files that differ between local manifest and last-pushed manifest.
   * Returns relative paths of files that are new, changed (hash differs),
   * or have changed size.
   */
  getChangedFiles(local: WorkspaceManifest): string[] {
    this.load();
    const changed: string[] = [];

    for (const [relativePath, entry] of local) {
      const lastEntry = this.lastPushedManifest.get(relativePath);
      if (!lastEntry || lastEntry.hash !== entry.hash) {
        changed.push(relativePath);
      }
    }

    return changed;
  }

  /**
   * Returns relative paths of files that were previously pushed to cloud
   * but are now missing from the cloud manifest — i.e. cloud lost them
   * (volume recreation, deploy, etc.). Only returns files that still exist
   * in the local manifest so they can be re-pushed.
   *
   * Skips zero-byte files: the cloud manifest endpoint intentionally excludes
   * them (stat.size === 0), so they'd be falsely detected as missing every cycle.
   */
  getCloudMissingFiles(local: WorkspaceManifest, cloudManifest: CloudManifest): string[] {
    this.load();
    const missing: string[] = [];

    for (const [relativePath] of this.lastPushedManifest) {
      const localEntry = local.get(relativePath);
      if (localEntry && localEntry.size > 0 && !Object.hasOwn(cloudManifest.entries, relativePath)) {
        missing.push(relativePath);
      }
    }

    return missing;
  }

  /**
   * Returns relative paths of files that exist in the last-pushed manifest
   * but are no longer present in the local manifest (deleted locally).
   */
  getDeletedFiles(local: WorkspaceManifest): string[] {
    this.load();
    const deleted: string[] = [];
    for (const relativePath of this.lastPushedManifest.keys()) {
      if (!local.has(relativePath)) {
        deleted.push(relativePath);
      }
    }
    return deleted;
  }

  /**
   * Delete files from cloud that were removed locally.
   * Verifies each file truly no longer exists on disk before deleting from cloud
   * (files may be absent from the manifest because they're too large or unreadable,
   * not because they were deleted).
   * Runs concurrently (up to PUSH_CONCURRENCY) with batch manifest update.
   * Returns count of successfully deleted files.
   */
  async deleteFiles(client: SyncClient, deletedFiles: string[], coreDirectory: string): Promise<{ deleted: number; pruned: number }> {
    type DeleteResult =
      | { status: 'deleted'; path: string }
      | { status: 'pruned'; path: string }
      | { status: 'skipped' }
      | { status: 'failed' };

    const results = await mapWithConcurrency(
      deletedFiles,
      async (relativePath): Promise<DeleteResult> => {
        const fullPath = path.join(coreDirectory, relativePath);
        if (fs.existsSync(fullPath)) {
          // File exists on disk but was excluded from the local manifest
          // (size limit, gitignore, etc.). Prune from lastPushedManifest
          // so it's not re-detected as "deleted" every sync cycle.
          return { status: 'pruned', path: relativePath };
        }
        try {
          await client.post('/api/library/delete-file', { path: relativePath });
          return { status: 'deleted', path: relativePath };
        } catch (err) {
          log.warn(
            { path: relativePath, err: err instanceof Error ? err.message : String(err) },
            'Failed to delete file from cloud',
          );
          return { status: 'failed' };
        }
      },
      PUSH_CONCURRENCY,
    );

    // Batch-update manifest with successful deletes and pruned entries
    let deleted = 0;
    let pruned = 0;
    for (const result of results) {
      if (result.status === 'deleted') {
        this.lastPushedManifest.delete(result.path);
        deleted++;
      } else if (result.status === 'pruned') {
        this.lastPushedManifest.delete(result.path);
        pruned++;
      }
    }

    if (deleted > 0 || pruned > 0) {
      this.scheduleDiskWrite();
    }

    if (pruned > 0) {
      log.info({ pruned }, 'Pruned stale manifest entries (files exist locally but excluded from manifest)');
    }

    return { deleted, pruned };
  }

  /**
   * Push changed files to cloud via the upload-file endpoint.
   *
   * Files < 7MB are read, base64-encoded, and POSTed concurrently (up to
   * PUSH_CONCURRENCY at a time). Manifest is batch-updated after all
   * operations complete to prevent corruption from partial writes.
   * Files 7–50MB are skipped with a warning.
   * Files > 50MB were already filtered during manifest build.
   */
  async pushChangedFiles(
    client: SyncClient,
    changedFiles: string[],
    coreDirectory: string,
    localManifest: WorkspaceManifest,
  ): Promise<PushResult> {
    type FileResult = { status: 'pushed'; path: string; entry: ManifestEntry }
      | { status: 'skipped' }
      | { status: 'failed' }
      | { status: 'aborted'; code: string };

    // Once one file proves the cloud host is unreachable, every queued upload
    // will hit the same 30s timeout — that's how a single sync cycle blocked
    // the workspace mutex for 4 minutes in the wild. Trip a one-shot abort
    // flag so workers not yet started skip immediately.
    let abortCode: string | null = null;

    const results = await mapWithConcurrency(
      changedFiles,
      async (relativePath): Promise<FileResult> => {
        if (abortCode) {
          return { status: 'aborted', code: abortCode };
        }

        const fullPath = path.join(coreDirectory, relativePath);
        const entry = localManifest.get(relativePath);

        if (!entry) {
          return { status: 'skipped' };
        }

        if (entry.size > UPLOAD_SIZE_LIMIT) {
          this.shouldSuppressOversizedPush({ coreDirectory, relativePath, entry });
          return { status: 'skipped' };
        }

        try {
          const content = fs.readFileSync(fullPath);
          const base64 = content.toString('base64');

          await client.post('/api/library/upload-file', {
            path: relativePath,
            content: base64,
            encoding: 'base64',
          });

          return { status: 'pushed', path: relativePath, entry };
        } catch (err) {
          if (isCloudServiceError(err) && HOST_UNREACHABLE_CODES.has(err.code)) {
            if (!abortCode) {
              abortCode = err.code;
              log.warn(
                { path: relativePath, code: err.code, total: changedFiles.length },
                'Workspace push: cloud host unreachable, aborting remainder of batch',
              );
            }
            return { status: 'aborted', code: err.code };
          }
          log.warn(
            { path: relativePath, err: err instanceof Error ? err.message : String(err) },
            'Failed to push file to cloud',
          );
          return { status: 'failed' };
        }
      },
      PUSH_CONCURRENCY,
    );

    // Batch-update manifest with all successful pushes
    let pushed = 0;
    let skipped = 0;
    let failed = 0;
    let aborted = 0;

    for (const result of results) {
      switch (result.status) {
        case 'pushed':
          this.lastPushedManifest.set(result.path, result.entry);
          pushed++;
          break;
        case 'skipped':
          skipped++;
          break;
        case 'failed':
          failed++;
          break;
        case 'aborted':
          aborted++;
          break;
      }
    }

    if (aborted > 0) {
      log.warn(
        { pushed, aborted, total: changedFiles.length, code: abortCode },
        'Workspace push: aborted batch due to unreachable cloud host; will retry next cycle',
      );
    }
    if (failed > 0) {
      log.warn({ pushed, failed, total: changedFiles.length }, 'Workspace push: some files failed, will retry next cycle');
    }

    if (pushed > 0) {
      this.scheduleDiskWrite();
    }

    return aborted > 0 ? { pushed, skipped, failed, aborted } : { pushed, skipped, failed };
  }

  /**
   * Shared sync implementation used by both syncIfNeeded() and forceSync().
   * Callers are responsible for the syncInProgress mutex.
   */
  private async executeSyncCore(
    client: SyncClient,
    coreDirectory: string,
    source: string,
    retryCount = 0,
  ): Promise<PushResult> {
    const startTime = Date.now();
    // Snapshot the dirty generation before we take the manifest snapshot.
    // Any watcher events arriving after this point will bump dirtyGeneration,
    // so we won't clear their dirty state when this sync completes.
    const coveredGeneration = this.dirtyGeneration;

    this.load();

    // Fetch cloud manifest BEFORE push so conflict detection sees cloud state
    // pre-overwrite. Without this, push could clobber cloud edits before we
    // detect the conflict (review finding: GPT-5.2, Opus-4.7, Kimi-K2.5).
    const cloudManifest = await this.fetchCloudManifest(client);

    // Build local manifest (mtime-first, re-hashes only changed files)
    const { manifest: localManifest, complete: localComplete, reasons: localReasons } =
      await this.buildLocalManifest(coreDirectory);

    if (!localComplete) {
      this.reportIncompleteLocalManifest(coreDirectory, localManifest, localReasons);
    }
    const cloudComplete = cloudManifest?.complete ?? false;
    if (cloudManifest && !cloudComplete) {
      this.reportIncompleteCloudManifest(coreDirectory, cloudManifest);
    }

    // Diff: find files that are new or changed, and files deleted locally
    const changedFiles = this.getChangedFiles(localManifest);
    const deletedFiles = localComplete ? this.getDeletedFiles(localManifest) : [];

    // Repair: detect files previously pushed but now missing from cloud
    // (cloud volume recreation, deploy loss, etc.)
    const cloudMissingFiles = localComplete && cloudComplete && cloudManifest
      ? this.getCloudMissingFiles(localManifest, cloudManifest)
      : [];
    if (cloudMissingFiles.length > 0) {
      log.warn({ count: cloudMissingFiles.length }, 'Detected files missing from cloud, will re-push');
    }

    // Push phase: upload local changes to cloud.
    // Exclude files where cloud also changed (conflict) — pushing would overwrite
    // the cloud version before pullChangedFiles can preserve it as a .conflict-cloud copy.
    const conflictFilteredChanges = cloudManifest
      ? changedFiles.filter((relativePath) => {
        const cloudEntry = cloudManifest.entries[relativePath];
        const lastPushed = this.lastPushedManifest.get(relativePath);
        if (!cloudEntry || !lastPushed) return true; // new file or no baseline — safe to push
        if (cloudEntry.hash === lastPushed.hash) return true; // cloud unchanged — safe to push
        // Cloud also changed — conflict. Skip push to preserve cloud version for conflict resolution.
        log.info({ path: relativePath }, 'Skipping push for conflicted file (cloud also changed)');
        return false;
      })
      : changedFiles;

    // Merge locally-changed files with cloud-missing files (dedup)
    const filesToPush = localComplete && cloudMissingFiles.length > 0
      ? [...new Set([...conflictFilteredChanges, ...cloudMissingFiles])]
      : conflictFilteredChanges;
    const effectivePushSet = this.buildEffectivePushSet(filesToPush, coreDirectory, localManifest);

    let pushResult: PushResult = { pushed: 0, skipped: 0, failed: 0 };
    let deletedCount = 0;
    let prunedCount = 0;
    if (effectivePushSet.length > 0 || deletedFiles.length > 0) {
      log.info(
        {
          changedFiles: conflictFilteredChanges.length,
          cloudMissing: cloudMissingFiles.length,
          effectivePushSet: effectivePushSet.length,
          deletedFiles: deletedFiles.length,
          source,
        },
        'Workspace sync: pushing changes',
      );
      pushResult = await this.pushChangedFiles(client, effectivePushSet, coreDirectory, localManifest);
      if (deletedFiles.length > 0) {
        const deleteResult = await this.deleteFiles(client, deletedFiles, coreDirectory);
        deletedCount = deleteResult.deleted;
        prunedCount = deleteResult.pruned;
      }
    }

    if (effectivePushSet.length > 0 && localComplete) {
      const { manifest: freshManifest, complete: freshComplete, reasons: freshReasons } =
        await this.buildLocalManifest(coreDirectory);
      if (!freshComplete) {
        this.reportIncompleteLocalManifest(coreDirectory, freshManifest, freshReasons);
      } else {
        const baselineFingerprint = buildManifestFingerprint(localManifest, effectivePushSet);
        const freshFingerprint = buildManifestFingerprint(freshManifest, effectivePushSet);
        if (baselineFingerprint !== freshFingerprint && retryCount < WORKSPACE_TOCTOU_MAX_RETRIES) {
          const fileCount = effectivePushSet.length;
          recordWorkspaceSyncContinuityBreadcrumb({
            data: {
              sessionIdHash: shortSha1Fingerprint(coreDirectory),
              from: 'cloud_active',
              to: 'cloud_active',
              reason: 'workspace-toctou-retry',
              direction: source,
              label: `files:${fileCount}`,
            },
          });
          log.info({ coreDirectory, fileCount, retryCount: retryCount + 1 }, 'Workspace TOCTOU detected, retrying with fresh manifest');
          return this.executeSyncCore(client, coreDirectory, `${source}:workspace-toctou-retry`, retryCount + 1);
        }
      }
    }

    // Pull phase: use pre-fetched manifest for conflict detection
    const pullResult = await this.pullChangedFiles(client, coreDirectory, cloudManifest);

    if (pullResult.conflictPaths.length > 0) {
      this.broadcastConflicts(pullResult.conflictPaths);
    }

    this.lastSyncAt = Date.now();

    // Mark all generations through coveredGeneration as synced.
    // If dirtyGeneration advanced during this sync (watcher events after our
    // manifest snapshot), the dirty timer stays armed for the next window.
    this.syncedThroughGeneration = coveredGeneration;
    if (this.dirtyGeneration <= coveredGeneration) {
      // No new dirty events since we started — safe to cancel retry timer
      if (this.dirtySyncTimer) {
        clearTimeout(this.dirtySyncTimer);
        this.dirtySyncTimer = null;
      }
    }

    log.info(
      { ...pushResult, deleted: deletedCount, pruned: prunedCount, cloudRepaired: cloudMissingFiles.length, localManifestComplete: localComplete, ...pullResult, source, duration: Date.now() - startTime },
      'Workspace sync complete',
    );

    return pushResult;
  }

  /**
   * Main entry point: throttled workspace sync.
   *
   * Returns a status indicating whether the sync actually ran:
   * - `'synced'` — sync completed successfully
   * - `'throttled'` — skipped because last sync was < 5 minutes ago
   * - `'in_progress'` — skipped because another sync is already running
   *
   * Builds local manifest, diffs against last-pushed, pushes changed files.
   */
  async syncIfNeeded(client: SyncClient, coreDirectory: string): Promise<'synced' | 'throttled' | 'in_progress'> {
    // Throttle check
    const msSinceLastSync = Date.now() - this.lastSyncAt;
    if (msSinceLastSync < SYNC_THROTTLE_MS) {
      log.debug({ msSinceLastSync, source: 'throttle' }, 'Workspace sync skipped');
      return 'throttled';
    }

    // Concurrent guard
    if (this.syncInProgress) {
      const waitedMs = this.syncStartedAt === null ? null : Math.max(0, Date.now() - this.syncStartedAt);
      log.info({ source: 'syncIfNeeded', waitedMs }, 'Workspace sync already in progress');
      return 'in_progress';
    }

    this.syncInProgress = true;
    this.syncStartedAt = Date.now();
    try {
      await workspaceMutex.withLock(
        `workspace:${coreDirectory}`,
        () => this.executeSyncCore(client, coreDirectory, 'syncIfNeeded'),
        { label: 'cloudWorkspaceSync.syncIfNeeded' },
      );
      return 'synced';
    } finally {
      this.syncInProgress = false;
      this.syncStartedAt = null;
    }
  }

  /**
   * Force an immediate workspace sync, bypassing the 5-minute throttle.
   * Still respects the `syncInProgress` mutex.
   *
   * Returns a `PushResult` with pushed/skipped/failed counts.
   */
  async forceSync(client: SyncClient, coreDirectory: string): Promise<PushResult> {
    if (this.syncInProgress) {
      const waitedMs = this.syncStartedAt === null ? null : Math.max(0, Date.now() - this.syncStartedAt);
      log.info({ source: 'forceSync', waitedMs }, 'Force sync requested but sync already in progress');
      return { pushed: 0, skipped: 0, failed: 0 };
    }

    this.syncInProgress = true;
    this.syncStartedAt = Date.now();
    try {
      this.clearPullFailureMemosForWorkspace(coreDirectory);
      return await workspaceMutex.withLock(
        `workspace:${coreDirectory}`,
        () => this.executeSyncCore(client, coreDirectory, 'forceSync'),
        { label: 'cloudWorkspaceSync.forceSync' },
      );
    } finally {
      this.syncInProgress = false;
      this.syncStartedAt = null;
    }
  }

  /**
   * Schedule a workspace sync after a short debounce.
   *
   * Uses a 15-second trailing debounce with a 2-minute max-wait (same pattern
   * as libraryBroadcaster). Respects the 5-minute throttle via `syncIfNeeded()`;
   * when throttled, schedules a one-shot retry at the next eligible window.
   *
   * Designed to be called on every workspace file change event from the watcher.
   * The last-provided client and coreDirectory win (should be stable).
   */
  syncSoon(client: SyncClient, coreDirectory: string): void {
    this.pendingSyncClient = client;
    this.pendingSyncDir = coreDirectory;

    // Reset trailing debounce on every call
    if (this.syncSoonDebounceTimer) {
      clearTimeout(this.syncSoonDebounceTimer);
    }

    // Start max-wait timer on the first event of a burst
    if (!this.syncSoonMaxWaitTimer) {
      this.syncSoonMaxWaitTimer = setTimeout(() => {
        this.flushSyncSoon();
      }, SYNC_SOON_MAX_WAIT_MS);
    }

    this.syncSoonDebounceTimer = setTimeout(() => {
      this.flushSyncSoon();
    }, SYNC_SOON_DEBOUNCE_MS);
  }

  /**
   * Pull files that were changed on cloud since the last push.
   *
   * Uses three-way comparison: local manifest, lastPushedManifest, cloud manifest.
   * - Cloud hash != local hash AND local hash == lastPushed hash → cloud edited → pull
   * - Cloud hash != local hash AND local hash != lastPushed hash → CONFLICT → skip + log
   * - Cloud file not in local manifest → new cloud file → pull (scoped to text files)
   *
   * Safety gates: bounded progressive pull (50 files/cycle), 7MB size limit, path traversal guard, text-only.
   */
  /**
   * Fetch the cloud workspace manifest. Returns null on failure.
   * Called before push so conflict detection sees cloud state pre-overwrite.
   */
  async fetchCloudManifest(client: SyncClient): Promise<CloudManifest | null> {
    try {
      const raw = await client.post('/api/library/manifest', {});
      if (!raw || typeof raw !== 'object') {
        log.warn('Cloud manifest response is invalid');
        return null;
      }
      // Discriminate on `complete: boolean`, NOT on `'entries' in raw` — a legacy response
      // for a workspace containing a top-level file literally named `entries` happens to be
      // shape-compatible with `{ entries: { hash, size } }` and would be misparsed as a new
      // envelope. Stripped-field scenarios (CDN/proxy/middleware that drops unknown fields)
      // also fall through to the legacy branch and fail closed there. See Phase 7 review.
      if (
        'complete' in raw &&
        typeof (raw as { complete?: unknown }).complete === 'boolean' &&
        'entries' in raw &&
        typeof (raw as { entries?: unknown }).entries === 'object' &&
        (raw as { entries?: unknown }).entries !== null
      ) {
        const env = raw as {
          entries: Record<string, { hash: string; size: number }>;
          complete: boolean;
          reasons?: unknown;
        };
        return {
          entries: env.entries,
          complete: env.complete,
          reasons: Object.freeze(
            Array.isArray(env.reasons)
              ? env.reasons.filter((r): r is string => typeof r === 'string')
              : [],
          ),
        };
      }
      // TODO(0.4.38): remove one-release legacy manifest fallback after 0.4.37 clients have aged out.
      // See docs/plans/260503_s9_bounded_walker_resource_budget.md § Stage 3 (wire contract).
      // Fail-closed: mark legacy/missing-envelope responses as incomplete so destructive ops
      // (cloud-missing repair) skip this cycle. Conflict detection and pull still operate on
      // the entries we received. This is safer than fail-open during rolling deploy windows.
      log.warn('Cloud manifest returned legacy/missing-envelope shape; marking incomplete to fail-close destructive ops');
      return {
        entries: raw as Record<string, { hash: string; size: number }>,
        complete: false,
        reasons: Object.freeze(['legacy-shape']),
      };
    } catch (err) {
      log.warn({ err: err instanceof Error ? err.message : String(err) }, 'Failed to fetch cloud manifest');
      return null;
    }
  }

  async pullChangedFiles(
    client: SyncClient,
    coreDirectory: string,
    cloudManifest?: CloudManifest | null,
  ): Promise<PullResult> {
    this.load();
    const authorityCache = createWorkspaceWriteAuthorityCache();
    const coreResolved = path.resolve(coreDirectory);
    const coreResolvedBase = coreResolved.endsWith(path.sep) ? coreResolved : `${coreResolved}${path.sep}`;
    const cycle = ++this.driveAwarePullCycle;
    let deferredDriveSettle = 0;
    let forcedAfterSettle = 0;
    let deferredEditedCloud = 0;
    let toastCheckedThisCycle = false;
    let loggedDeferralThisCycle = false;
    // Track whether the pending-cloud-update set changed this cycle, so we emit
    // exactly one broadcast at the end (the renderer surfaces the calm "newer
    // version ready" affordance without a manual refresh). See the convergence
    // sweep below + the edited-cloud defer branch.
    let pendingCloudUpdatesChanged = false;

    // Use pre-fetched manifest or fetch now
    if (!cloudManifest) {
      cloudManifest = await this.fetchCloudManifest(client);
    }
    if (!cloudManifest) {
      return {
        pulled: 0,
        skipped: 0,
        conflicts: 0,
        conflictPaths: [],
        newFiles: 0,
        deferred: 0,
        deferredDriveSettle: 0,
        forcedAfterSettle: 0,
        deferredEditedCloud: 0,
      };
    }

    for (const deferral of getActiveDriveSettleDeferrals(coreResolved)) {
      const localPath = path.resolve(coreResolved, deferral.relativePath);
      if (!localPath.startsWith(coreResolvedBase) && localPath !== coreResolved) {
        continue;
      }
      if (!fs.existsSync(localPath)) {
        continue;
      }

      clearDriveSettleDeferral(coreResolved, deferral.relativePath);
      log.info(
        {
          relPath: deferral.relativePath,
          cycle,
          ageMs: deferral.ageMs,
          deferralCount: deferral.deferralCount,
        },
        'drive-settle.delivered',
      );
    }

    for (const pendingUpdate of getPendingCloudUpdates(coreResolved)) {
      const localPath = path.resolve(coreResolved, pendingUpdate.relativePath);
      if (!localPath.startsWith(coreResolvedBase) && localPath !== coreResolved) {
        continue;
      }

      const cloudEntry = cloudManifest.entries[pendingUpdate.relativePath];

      // Cloud copy is gone entirely (deleted/never delivered): the pending
      // update no longer has anything to fast-forward to. Clear it; the record
      // self-heals from the next manifest fetch if the file reappears.
      if (!cloudEntry) {
        clearPendingCloudUpdate(coreResolved, pendingUpdate.relativePath);
        pendingCloudUpdatesChanged = true;
        log.info(
          {
            relPath: pendingUpdate.relativePath,
            cloudHash: pendingUpdate.cloudHash,
            nextCloudHash: null,
          },
          'pending-cloud-update.resolved-by-cloud-change',
        );
        continue;
      }

      if (!fs.existsSync(localPath)) {
        continue;
      }

      try {
        const localHash = await this.hashFile(localPath);

        // Local has caught up to the cloud copy (the OS sync engine finally
        // delivered it, or the user applied it): the pending update is done.
        if (localHash === cloudEntry.hash) {
          clearPendingCloudUpdate(coreResolved, pendingUpdate.relativePath);
          pendingCloudUpdatesChanged = true;
          log.info(
            {
              relPath: pendingUpdate.relativePath,
              cloudHash: pendingUpdate.cloudHash,
              baselineLocalHash: pendingUpdate.baselineLocalHash,
            },
            'pending-cloud-update.delivered',
          );
          continue;
        }

        // Cloud moved to a NEW hash while the local file still equals the
        // recorded baseline (i.e. local genuinely unchanged): this is the same
        // already-surfaced "newer version waiting" state, just pointing at a
        // newer cloud copy. COMPRESS — update the tracked cloud hash in place
        // (firstSeenAt + baseline stay stable) instead of clear+re-record,
        // which would oscillate and re-broadcast/re-toast every few minutes.
        // Crucially we do NOT set `pendingCloudUpdatesChanged` here: the path
        // was already in the broadcast set, so no new surfacing is needed.
        // Data-loss guard: the baseline is never advanced — apply still
        // re-reads cloud bytes and re-checks the local baseline before writing.
        if (cloudEntry.hash !== pendingUpdate.cloudHash && localHash === pendingUpdate.baselineLocalHash) {
          updatePendingCloudUpdateCloudHash({
            coreDirectory: coreResolved,
            relativePath: pendingUpdate.relativePath,
            cloudHash: cloudEntry.hash,
          });
          log.info(
            {
              relPath: pendingUpdate.relativePath,
              prevCloudHash: pendingUpdate.cloudHash,
              nextCloudHash: cloudEntry.hash,
            },
            'pending-cloud-update.cloud-hash-refreshed (compressed; no re-broadcast)',
          );
          continue;
        }

        // Cloud moved to a new hash AND local also diverged from the baseline
        // (local genuinely edited too): this is no longer a clean fast-forward.
        // Clear the stale pending record and let the main detector reclassify it
        // as a both-edited conflict (quarantine) this cycle. Never advance the
        // baseline to the edited local content.
        if (cloudEntry.hash !== pendingUpdate.cloudHash && localHash !== pendingUpdate.baselineLocalHash) {
          clearPendingCloudUpdate(coreResolved, pendingUpdate.relativePath);
          pendingCloudUpdatesChanged = true;
          log.info(
            {
              relPath: pendingUpdate.relativePath,
              cloudHash: pendingUpdate.cloudHash,
              nextCloudHash: cloudEntry.hash,
            },
            'pending-cloud-update.resolved-by-cloud-change (local also diverged; reclassify as conflict)',
          );
          continue;
        }
        // Otherwise (cloud hash unchanged, local still below cloud): leave the
        // pending record exactly as-is — nothing to surface, nothing to clear.
      } catch (err) {
        log.warn(
          { relPath: pendingUpdate.relativePath, err: err instanceof Error ? err.message : String(err) },
          'Failed checking pending cloud update convergence',
        );
      }
    }

    const pullCandidates: Array<{ relativePath: string; reason: 'edited' | 'new'; cloudHash: string; baselineHash?: string }> = [];
    const conflictPaths: string[] = [];
    let skipped = 0;
    let pullFailureMemoSuppressed = 0;
    let pullFailureMemoFailingFiles = 0;
    const cloudEntryPaths = Object.keys(cloudManifest.entries);
    const nowMs = Date.now();

    const localDirectoryExists = (relativeDir: string): boolean => {
      const localPath = path.resolve(coreDirectory, relativeDir);
      if (!localPath.startsWith(coreResolvedBase) && localPath !== coreResolved) {
        return false;
      }
      return isExistingDirectory(localPath);
    };

    for (const [relativePath, cloudEntry] of Object.entries(cloudManifest.entries)) {
      // Text-only guard: skip binary files to avoid UTF-8 corruption
      const ext = path.extname(relativePath).toLowerCase();
      if (ext && !TEXT_EXTENSIONS.has(ext)) {
        continue;
      }

      // Size guard
      if (cloudEntry.size > UPLOAD_SIZE_LIMIT) {
        skipped++;
        continue;
      }

      // REBEL-5QS: never pull files under a Drive/Dropbox folder conflict copy
      // (`Project (1)/notes.md`) when the original sibling directory exists in
      // the cloud manifest or as a real local directory. This runs before any
      // `/api/library/read` call so skipped conflict subtrees are never written.
      if (
        shouldSuppressConflictDirAncestor(relativePath, {
          manifestHasPrefix: (relativeDirPrefix) =>
            cloudEntryPaths.some((key) => key.startsWith(relativeDirPrefix)),
          localDirExists: localDirectoryExists,
        })
      ) {
        // Observability: a folder skip excludes a whole subtree from pull — louder than a file skip.
        log.debug({ path: relativePath }, 'REBEL-5QS: skipping pull of file under conflict-copy directory (sibling original present)');
        skipped++;
        continue;
      }

      // REBEL-62A: never pull a Drive/Dropbox conflict copy (`foo (1).md`) whose
      // original is present in the cloud manifest being iterated OR exists
      // locally. A peer that pulled it would re-write it and feed the fan-out.
      // Sibling-gated (standalone `Report (1).md` with no original still pulls);
      // must not read (`/api/library/read`) or write the skipped file.
      const basename = relativePath.split('/').pop() ?? relativePath;
      const dirPrefix = relativePath.includes('/')
        ? relativePath.slice(0, relativePath.lastIndexOf('/') + 1)
        : '';
      if (
        isSuppressibleConflictCopy(basename, (originalBasename) => {
          const originalRelPath = `${dirPrefix}${originalBasename}`;
          if (Object.prototype.hasOwnProperty.call(cloudManifest.entries, originalRelPath)) {
            return true;
          }
          return fs.existsSync(path.resolve(coreDirectory, originalRelPath));
        })
      ) {
        skipped++;
        continue;
      }

      const lastPushed = this.lastPushedManifest.get(relativePath);

      if (!lastPushed) {
        // File not in our pushed manifest. Only pull if it doesn't exist locally
        // (truly new from cloud). If it exists locally (e.g., not yet pushed, or
        // gitignored), skip to avoid overwriting local data.
        const localPath = path.resolve(coreDirectory, relativePath);
        const memoDecision = this.consultPullFailureMemo({
          coreDirectory,
          relativePath,
          cloudHash: cloudEntry.hash,
          localPath,
          reason: 'new',
          nowMs,
        });
        if (memoDecision.action === 'suppress') {
          pullFailureMemoSuppressed++;
          continue;
        }
        if (memoDecision.action === 'file_exists_locally') {
          skipped++;
          continue;
        }
        if (fs.existsSync(localPath)) {
          skipped++;
          continue;
        }
        pullCandidates.push({ relativePath, reason: 'new', cloudHash: cloudEntry.hash });
        continue;
      }

      // File exists in both manifests — check if cloud changed it
      if (cloudEntry.hash === lastPushed.hash) continue; // No change on cloud

      // Cloud hash differs from what we last pushed.
      // Check if we also changed it locally (conflict detection).
      // Read current local file hash to see if local also diverged.
      const localPath = path.resolve(coreDirectory, relativePath);
      if (!localPath.startsWith(coreResolvedBase) && localPath !== coreResolved) {
        log.warn({ path: relativePath }, 'Path traversal blocked in pull');
        skipped++;
        continue;
      }

      try {
        const localHash = await this.hashFile(localPath);
        if (localHash === cloudEntry.hash) continue; // Already in sync

        if (localHash === lastPushed.hash) {
          // Local unchanged since last push, cloud edited → safe to pull
          const memoDecision = this.consultPullFailureMemo({
            coreDirectory,
            relativePath,
            cloudHash: cloudEntry.hash,
            localPath,
            reason: 'edited',
            nowMs,
          });
          if (memoDecision.action === 'suppress') {
            pullFailureMemoSuppressed++;
            continue;
          }
          // Carry the classification baseline (the last-synced hash the `edited`
          // gate proved the local file still equalled) so the deferral branch can
          // detect an in-cycle local edit before recording a pending-update baseline
          // (TOCTOU data-loss guard — see the deferral branch in the pull loop).
          pullCandidates.push({ relativePath, reason: 'edited', cloudHash: cloudEntry.hash, baselineHash: lastPushed.hash });
        } else {
          // Both sides edited → conflict
          conflictPaths.push(relativePath);
          clearPendingCloudUpdate(coreResolved, relativePath);
          pendingCloudUpdatesChanged = true;

          try {
            const cloudResponse = await client.post('/api/library/read', { path: relativePath }) as { content: string };
            if (typeof cloudResponse?.content === 'string') {
              const fileExt = path.extname(localPath);
              const baseName = path.basename(localPath, fileExt);
              const conflictFileName = fileExt
                ? `${baseName}${WORKSPACE_CONFLICT_MARKER}${fileExt}`
                : `${baseName}${WORKSPACE_CONFLICT_MARKER}`;
              const conflictFilePath = path.join(path.dirname(localPath), conflictFileName);
              const writeAuthority = resolveWorkspaceWriteAuthority(path.dirname(localPath), { cache: authorityCache });
              const savedConflict = writeAuthority === 'desktop_fs_authoritative'
                ? quarantineWorkspaceCloudConflict({
                  coreDirectory,
                  relativePath,
                  localPath,
                  content: cloudResponse.content,
                })
                : (() => {
                  fs.writeFileSync(conflictFilePath, cloudResponse.content, 'utf8');
                  return {
                    localPath,
                    cloudCopyPath: conflictFilePath,
                    relativePath,
                  };
                })();
              log.info(
                {
                  path: relativePath,
                  conflictPath: writeAuthority === 'desktop_fs_authoritative'
                    ? savedConflict.cloudCopyPath
                    : toPortablePath(path.relative(coreDirectory, savedConflict.cloudCopyPath)),
                  quarantined: writeAuthority === 'desktop_fs_authoritative',
                },
                'Saved cloud conflict copy',
              );
            } else {
              log.warn({ path: relativePath }, 'Cloud conflict copy read returned non-string content');
            }
          } catch (err) {
            log.warn(
              { path: relativePath, err: err instanceof Error ? err.message : String(err) },
              'Failed to save cloud conflict copy',
            );
          }

          log.warn(
            { path: relativePath, localHash, cloudHash: cloudEntry.hash, lastPushedHash: lastPushed.hash },
            'Workspace conflict: both desktop and cloud edited this file, skipping pull',
          );
        }
      } catch {
        // Local file doesn't exist (deleted locally) — skip, don't pull back
        skipped++;
      }
    }

    if (pullCandidates.length === 0) {
      if (pullFailureMemoSuppressed > 0) {
        log.info(
          { failingFiles: this.countPullFailureMemosForWorkspace(coreDirectory), suppressed: pullFailureMemoSuppressed },
          'Workspace pull failure memo summary',
        );
      }
      return {
        pulled: 0,
        skipped,
        conflicts: conflictPaths.length,
        conflictPaths,
        newFiles: 0,
        deferred: 0,
        deferredDriveSettle,
        forcedAfterSettle,
        deferredEditedCloud,
      };
    }

    // Bounded progressive pull: when backlog exceeds MAX_PULL_FILES, pull a
    // deterministic batch (sorted alphabetically) and defer the rest to the
    // next sync cycle. This replaces the previous all-or-nothing safety gate
    // that permanently wedged workspaces with large backlogs (e.g. 546 files).
    let deferred = 0;
    let batch = pullCandidates;
    if (pullCandidates.length > MAX_PULL_FILES) {
      batch = [...pullCandidates].sort((a, b) => a.relativePath.localeCompare(b.relativePath)).slice(0, MAX_PULL_FILES);
      deferred = pullCandidates.length - MAX_PULL_FILES;
      log.info(
        { totalCandidates: pullCandidates.length, batchSize: batch.length, deferred, max: MAX_PULL_FILES },
        'Large pull backlog detected — pulling bounded batch, remaining deferred to next cycle',
      );
    }

    // Pull each file in the batch
    let pulled = 0;
    let newFiles = 0;
    let pullAbortCode: string | null = null;
    for (let batchIndex = 0; batchIndex < batch.length; batchIndex += 1) {
      const { relativePath, reason, cloudHash, baselineHash } = batch[batchIndex];
      if (pullAbortCode) {
        skipped += batch.length - batchIndex;
        break;
      }

      try {
        const localPath = path.resolve(coreDirectory, relativePath);
        if (!localPath.startsWith(coreResolvedBase) && localPath !== coreResolved) {
          throw new PullPreflightError('PULL_PATH_TRAVERSAL', 'Path traversal blocked in pull');
        }

        const writeAuthority = resolveWorkspaceWriteAuthority(path.dirname(localPath), { cache: authorityCache });
        let writeViaAtomicRename = false;

        if (reason === 'edited' && writeAuthority === 'desktop_fs_authoritative') {
          const currentLocalHash = await this.hashFile(localPath);
          if (currentLocalHash === cloudHash) {
            clearPendingCloudUpdate(coreResolved, relativePath);
            pendingCloudUpdatesChanged = true;
            log.info(
              { relPath: relativePath, cloudHash },
              'pending-cloud-update.already-delivered',
            );
            continue;
          }

          // TOCTOU data-loss guard: the candidate was classified `edited` because
          // the local file still equalled `lastPushed.hash` (unchanged since last
          // sync) at classification. If a re-read here no longer matches that
          // baseline, the user edited the file in the window between classification
          // and now — it is NOT a safe fast-forward. Recording this edited content
          // as the pending-update baseline would later let one-click apply see
          // current == baseline and clobber the edit with cloud bytes. Skip the
          // record (clearing any stale one) and let the next pull cycle reclassify
          // it as a both-edited conflict (quarantine). Never record an edit as baseline.
          if (baselineHash !== undefined && currentLocalHash !== baselineHash) {
            clearPendingCloudUpdate(coreResolved, relativePath);
            pendingCloudUpdatesChanged = true;
            log.warn(
              { relPath: relativePath },
              'pending-cloud-update.local-changed-in-cycle (skipping record; reclassify as conflict next cycle)',
            );
            continue;
          }

          // Pending-state compression: if this path already has a pending
          // record covering the SAME cloud hash (e.g. the convergence sweep
          // already refreshed it in place this cycle, or a prior cycle recorded
          // it), it was already surfaced. Re-recording would be idempotent, but
          // re-broadcasting/re-toasting it produces the every-few-minutes noise
          // the user reported. Skip the deferral bookkeeping entirely so we
          // neither re-broadcast (`pendingCloudUpdatesChanged`) nor re-toast.
          const existingPending = getPendingCloudUpdate(coreResolved, relativePath);
          const alreadySurfaced =
            existingPending !== null
            && existingPending.cloudHash === cloudHash
            && existingPending.baselineLocalHash === currentLocalHash;
          if (alreadySurfaced) {
            continue;
          }

          recordPendingCloudUpdate({
            coreDirectory: coreResolved,
            relativePath,
            cloudHash,
            baselineLocalHash: currentLocalHash,
          });
          deferredEditedCloud++;
          pendingCloudUpdatesChanged = true;
          if (!loggedDeferralThisCycle) {
            loggedDeferralThisCycle = true;
            log.info(
              { relPath: relativePath, cycle, cloudHash, baselineLocalHash: currentLocalHash },
              'Deferring edited cloud→desktop pull on provider-authoritative workspace',
            );
          }
          if (!toastCheckedThisCycle) {
            toastCheckedThisCycle = true;
            this.maybeBroadcastDriveAwareSyncToast(coreDirectory, relativePath, cycle, 0);
          }
          continue;
        }

        if (reason === 'new') {
          if (writeAuthority === 'desktop_fs_authoritative') {
            const settleDecision = evaluateDriveSettleDeferral({
              coreDirectory,
              relativePath,
              localPath,
            });

            if (settleDecision.action === 'delivered') {
              log.info(
                { relPath: relativePath, deferralCount: settleDecision.deferralCount, ageMs: settleDecision.ageMs },
                'drive-settle.delivered',
              );
              skipped++;
              continue;
            }

            if (settleDecision.action === 'defer') {
              deferredDriveSettle++;
              if (!loggedDeferralThisCycle) {
                loggedDeferralThisCycle = true;
                log.info(
                  { relPath: relativePath, cycle, ageMs: settleDecision.ageMs },
                  'Deferring cloud→desktop pull on Drive-synced workspace',
                );
              }
              if (!toastCheckedThisCycle) {
                toastCheckedThisCycle = true;
                this.maybeBroadcastDriveAwareSyncToast(coreDirectory, relativePath, cycle, settleDecision.ageMs);
              }
              continue;
            }

            forcedAfterSettle++;
            log.warn(
              { relPath: relativePath, deferralCount: settleDecision.deferralCount, ageMs: settleDecision.ageMs },
              'drive-settle.timeout',
            );
            if (fs.existsSync(localPath)) {
              clearDriveSettleDeferral(coreDirectory, relativePath);
              log.info(
                { relPath: relativePath, cycle },
                'drive-settle.delivered-before-force-write',
              );
              skipped++;
              continue;
            }
            writeViaAtomicRename = true;
          }
        }

        this.preflightPullWritePath(coreDirectory, relativePath, localPath);
        const response = await client.post('/api/library/read', { path: relativePath }) as { content: string };
        if (typeof response?.content !== 'string') {
          log.warn({ path: relativePath }, 'Cloud file read returned non-string content');
          skipped++;
          continue;
        }

        // Ensure parent directory exists
        const parentDir = path.dirname(localPath);
        if (!fs.existsSync(parentDir)) {
          fs.mkdirSync(parentDir, { recursive: true });
        }

        if (writeViaAtomicRename && fs.existsSync(localPath)) {
          clearDriveSettleDeferral(coreDirectory, relativePath);
          log.info(
            { relPath: relativePath, cycle },
            'drive-settle.delivered-before-atomic-write',
          );
          skipped++;
          continue;
        }

        if (writeViaAtomicRename) {
          try {
            writeFileAtomicInTargetDirSync(localPath, response.content, 'utf8');
          } catch (err) {
            log.warn(
              { path: relativePath, err: err instanceof Error ? err.message : String(err) },
              'Atomic cloud pull write failed',
            );
            throw err;
          }
          log.info({ path: relativePath }, 'Pulled cloud file via atomic rename');
        } else {
          fs.writeFileSync(localPath, response.content, 'utf8');
        }

        // Update manifest to prevent re-uploading on next push
        const stat = fs.statSync(localPath);
        const hash = await this.hashFile(localPath);
        this.recordPulledFile(relativePath, {
          mtime: Math.floor(stat.mtimeMs),
          size: stat.size,
          hash,
        });

        pulled++;
        if (reason === 'new') newFiles++;
        clearDriveSettleDeferral(coreDirectory, relativePath);
        clearPendingCloudUpdate(coreResolved, relativePath);
        pendingCloudUpdatesChanged = true;
        this.clearPullFailureMemosForPath(coreDirectory, relativePath);
        log.info({ path: relativePath, reason, size: response.content.length }, 'Pulled file from cloud');
      } catch (err) {
        const classification = classifyPullFailure(err);
        const { entry, terminalWarnShouldEmit } = this.recordPullFailureMemo({
          coreDirectory,
          relativePath,
          cloudHash,
          classification,
          err,
          nowMs: Date.now(),
        });
        pullFailureMemoFailingFiles = this.countPullFailureMemosForWorkspace(coreDirectory);

        switch (classification.disposition) {
          case 'terminal':
            if (terminalWarnShouldEmit) {
              log.warn(
                { path: relativePath, cause: classification.cause, cloudHash, backoffMs: entry.backoffMs, err: errorMessage(err) },
                'Workspace pull: terminal file failure memoized',
              );
            }
            break;
          case 'transient':
            if (classification.hostUnreachable) {
              pullAbortCode = classification.signature;
              log.warn(
                { path: relativePath, code: classification.signature, total: batch.length },
                'Workspace pull: cloud host unreachable, aborting remainder of batch',
              );
            }
            break;
          default:
            assertNever(classification);
        }

        if (reason === 'new') {
          clearDriveSettleDeferral(coreDirectory, relativePath);
        }
        skipped++;
      }
    }

    // Force manifest flush after a bounded batch so progress survives restarts
    if (pulled > 0 && deferred > 0) {
      this.flush();
    }

    if (pulled > 0) {
      log.info(
        { pulled, newFiles, conflicts: conflictPaths.length, skipped, deferred, deferredDriveSettle, forcedAfterSettle, deferredEditedCloud },
        'Cloud→desktop workspace pull complete',
      );
    }

    if (pullFailureMemoFailingFiles > 0 || pullFailureMemoSuppressed > 0) {
      log.info(
        {
          failingFiles: pullFailureMemoFailingFiles || this.countPullFailureMemosForWorkspace(coreDirectory),
          suppressed: pullFailureMemoSuppressed,
        },
        'Workspace pull failure memo summary',
      );
    }

    // One broadcast per cycle if the pending-cloud-update set changed (recorded,
    // delivered, superseded by a conflict, or resolved by a cloud change), so
    // the renderer surfaces/clears the calm "newer version ready" affordance
    // without a manual refresh. Emits the current (post-change) set.
    if (pendingCloudUpdatesChanged) {
      this.broadcastPendingCloudUpdates(coreResolved);
    }

    return {
      pulled,
      skipped,
      conflicts: conflictPaths.length,
      conflictPaths,
      newFiles,
      deferred,
      deferredDriveSettle,
      forcedAfterSettle,
      deferredEditedCloud,
    };
  }

  /**
   * Record a file that was just pulled from cloud, updating the local manifest
   * to prevent the next sync from re-uploading it.
   *
   * Used by the staged write applicator (Phase 3) after writing a cloud-originated
   * file to the local workspace.
   */
  recordPulledFile(relativePath: string, entry: ManifestEntry): void {
    this.load();
    this.lastPushedManifest.set(relativePath, entry);
    this.scheduleDiskWrite();
  }

  /**
   * Apply ONE recorded "pending cloud update" — the user explicitly asked to
   * fast-forward this file to the newer version that lives only in Rebel's cloud
   * (they edited it on phone/web; the OS sync engine has no copy to deliver to
   * this desktop, so the deferral logic recorded it instead of overwriting —
   * see REBEL-696 / the chief-designer brief 260619_111500).
   *
   * This is keep-cloud semantics, scoped to a single user click:
   *   read cloud bytes → verify they still match the flagged cloudHash →
   *   atomic write into the OS-synced workspace → record the new hash as
   *   last-synced (so push/pull don't churn it) → clear the pending record.
   *
   * `writeFileAtomicInTargetDirSync` is deliberate here: this is a one-shot,
   * user-initiated write, not the auto pull loop, so the atomic temp-then-rename
   * (which the OS sync engine treats as a clean replace) is correct.
   *
   * Hash-gating on `cloudHash` is load-bearing: if the cloud moved on since the
   * record was written, we must NOT silently apply a different version than the
   * user was told about — we return `cloud_changed` so the UI re-reads and the
   * stale card disappears (the convergence sweep clears the record).
   */
  async applyPendingCloudUpdate(
    client: SyncClient,
    coreDirectory: string,
    inputRelativePath: string,
  ): Promise<ApplyPendingCloudUpdateResult> {
    this.load();
    const coreResolved = path.resolve(coreDirectory);

    const normalizedRelativePath = toPortablePath(path.normalize(inputRelativePath))
      .replace(/^\/+/, '')
      .replace(/^\.\/+/, '');

    const pending = getPendingCloudUpdates(coreResolved).find(
      (entry) => entry.relativePath === normalizedRelativePath,
    );
    if (!pending) {
      log.info(
        { relPath: normalizedRelativePath },
        'apply-pending-cloud-update.no-record (already delivered or never flagged)',
      );
      return {
        success: false,
        reason: 'not_pending',
        error: 'That file is already up to date.',
      };
    }

    const localPath = path.resolve(coreResolved, pending.relativePath);

    // Path safety: same containment + symlinked-parent guard the auto pull uses.
    // The relativePath ultimately originates from a persisted JSON record, so we
    // re-validate at the write site rather than trusting it.
    try {
      this.preflightPullWritePath(coreResolved, pending.relativePath, localPath);
    } catch (err) {
      log.warn(
        { relPath: pending.relativePath, err: err instanceof Error ? err.message : String(err) },
        'apply-pending-cloud-update.path-unsafe',
      );
      return {
        success: false,
        reason: 'path_unsafe',
        error: "Couldn't update that file. Try again.",
      };
    }

    // Read the cloud bytes (same endpoint the pull loop uses).
    let cloudContent: string;
    try {
      const response = (await client.post('/api/library/read', { path: pending.relativePath })) as {
        content?: unknown;
      };
      if (typeof response?.content !== 'string') {
        log.warn({ relPath: pending.relativePath }, 'apply-pending-cloud-update.non-string-content');
        return {
          success: false,
          reason: 'cloud_read_failed',
          error: "Couldn't update that file. Try again.",
        };
      }
      cloudContent = response.content;
    } catch (err) {
      log.warn(
        { relPath: pending.relativePath, err: err instanceof Error ? err.message : String(err) },
        'apply-pending-cloud-update.cloud-read-failed',
      );
      return {
        success: false,
        reason: 'cloud_read_failed',
        error: "Couldn't update that file. Try again.",
      };
    }

    // We compare and write the SAME bytes throughout: hash the UTF-8 buffer we
    // are about to persist (`hashBuffer`), not the JS string. `hashBuffer`
    // produces the identical digest to `hashFile` (both stream/hash raw bytes),
    // so the cloud gate, the local gate, and the recorded last-synced hash all
    // speak one hashing model — no `hashContent`-vs-`hashFile` divergence that
    // could false-fire on a BOM / non-clean-UTF-8 round-trip.
    const cloudBytes = Buffer.from(cloudContent, 'utf8');
    const cloudContentHash = this.hashBuffer(cloudBytes);

    // Cloud-side gate: only apply if the cloud STILL holds exactly the version
    // we flagged. If it changed, the record is stale — clear it so the card
    // leaves and the user re-opens to see the newer version.
    if (cloudContentHash !== pending.cloudHash) {
      clearPendingCloudUpdate(coreResolved, pending.relativePath);
      // Broadcast so the renderer's toast-dedup set resets for this path; a later
      // legitimately-new pending update for the same file can then toast again.
      this.broadcastPendingCloudUpdates(coreResolved);
      log.info(
        { relPath: pending.relativePath, flaggedHash: pending.cloudHash, currentHash: cloudContentHash },
        'apply-pending-cloud-update.cloud-changed (stale record cleared)',
      );
      return {
        success: false,
        reason: 'cloud_changed',
        error: 'A newer version arrived. Open this again to update.',
      };
    }

    // Local-side gate (DATA-LOSS guard): the pending-update card promises a safe
    // one-click fast-forward — "nothing local to lose". That holds ONLY while the
    // local file is still the unchanged baseline that made this a pending update
    // rather than a conflict. There's a race window between background detection
    // (which records `baselineLocalHash`) and the user clicking "Update to
    // newest", during which the user could edit the local file. We re-check the
    // CURRENT local bytes against the recorded baseline RIGHT BEFORE the write,
    // using `hashFile` (the same function that produced `baselineLocalHash`).
    let currentLocalHash: string | null;
    try {
      currentLocalHash = await this.hashFile(localPath);
    } catch (err) {
      const code = errnoCode(err);
      if (code === 'ENOENT' || code === 'ENOTDIR') {
        // Local file is genuinely gone (deleted/moved) — there's no local edit
        // to lose, so applying simply re-creates it.
        currentLocalHash = null;
        log.info(
          { relPath: pending.relativePath, code },
          'apply-pending-cloud-update.local-missing (no local edit to lose; will re-create)',
        );
      } else {
        // Any OTHER read/hash failure (permission, transient I/O, a dataless
        // placeholder that failed to hydrate) is AMBIGUOUS: we cannot prove the
        // local file is still the unchanged baseline, so we must NOT overwrite
        // it. Fail closed — preserve the pending record so the user can retry,
        // and surface honestly rather than risk clobbering a local edit.
        log.warn(
          { relPath: pending.relativePath, err: err instanceof Error ? err.message : String(err) },
          'apply-pending-cloud-update.local-read-failed (cannot verify local baseline; refusing to overwrite)',
        );
        return {
          success: false,
          reason: 'local_read_failed',
          error: "Couldn't update that file. Try again.",
        };
      }
    }

    if (currentLocalHash !== null) {
      if (currentLocalHash === cloudContentHash) {
        // Local already equals the cloud version — the OS sync engine delivered
        // it (or the user already pulled it down). Nothing to apply; clear the
        // stale record so the card leaves.
        clearPendingCloudUpdate(coreResolved, pending.relativePath);
        // Broadcast so the renderer's toast-dedup set resets for this path; a later
        // legitimately-new pending update for the same file can then toast again.
        this.broadcastPendingCloudUpdates(coreResolved);
        log.info(
          { relPath: pending.relativePath, cloudHash: pending.cloudHash },
          'apply-pending-cloud-update.already-current (local already matches cloud; record cleared)',
        );
        return {
          success: false,
          reason: 'already_current',
          error: 'That file is already up to date.',
        };
      }

      if (currentLocalHash !== pending.baselineLocalHash) {
        // Local changed since the record was created AND differs from the cloud
        // version → this is now a genuine both-sides-changed conflict, NOT a safe
        // fast-forward. Do NOT overwrite. Quarantine the cloud bytes (same S4
        // helper the pull-loop conflict path uses) so the file surfaces in the
        // workspace-conflict list for a real 3-way resolve, then clear the
        // pending record (it's no longer a pending update).
        try {
          quarantineWorkspaceCloudConflict({
            coreDirectory: coreResolved,
            relativePath: pending.relativePath,
            localPath,
            content: cloudContent,
          });
        } catch (err) {
          // If we can't quarantine, we still must NOT overwrite the user's local
          // edit. Surface the failure honestly and leave the pending record so a
          // later sync re-evaluates; the user keeps their local copy.
          log.warn(
            { relPath: pending.relativePath, err: err instanceof Error ? err.message : String(err) },
            'apply-pending-cloud-update.local-changed-quarantine-failed (local edit preserved; not overwritten)',
          );
          return {
            success: false,
            reason: 'local_changed',
            error: "You've changed this file here too — review it in conflicts.",
          };
        }

        clearPendingCloudUpdate(coreResolved, pending.relativePath);
        // Surface the new conflict (it just left the pending list) so an open
        // dialog re-reads and the file appears under "Resolve file conflicts".
        this.broadcastConflicts([pending.relativePath]);
        this.broadcastPendingCloudUpdates(coreResolved);
        log.info(
          {
            relPath: pending.relativePath,
            baselineLocalHash: pending.baselineLocalHash,
            currentLocalHash,
            cloudHash: pending.cloudHash,
          },
          'apply-pending-cloud-update.local-changed (both sides edited; routed to conflict, not overwritten)',
        );
        return {
          success: false,
          reason: 'local_changed',
          error: "You've changed this file here too — review it in conflicts.",
        };
      }
    }

    // Atomic write into the OS-synced workspace.
    try {
      const parentDir = path.dirname(localPath);
      if (!fs.existsSync(parentDir)) {
        fs.mkdirSync(parentDir, { recursive: true });
      }
      writeFileAtomicInTargetDirSync(localPath, cloudContent, 'utf8');
    } catch (err) {
      log.warn(
        { relPath: pending.relativePath, err: err instanceof Error ? err.message : String(err) },
        'apply-pending-cloud-update.write-failed',
      );
      return {
        success: false,
        reason: 'write_failed',
        error: "Couldn't update that file. Try again.",
      };
    }

    // Record the applied version as last-synced so push (local != lastPushed)
    // and pull (cloud == lastPushed) both leave it alone, then clear the record.
    try {
      const stat = fs.statSync(localPath);
      this.recordPulledFile(pending.relativePath, {
        mtime: Math.floor(stat.mtimeMs),
        size: stat.size,
        hash: cloudContentHash,
      });
    } catch (err) {
      // The bytes are on disk; failing to update the manifest is recoverable
      // (next sync re-reconciles) but must be observable, not silent.
      log.warn(
        { relPath: pending.relativePath, err: err instanceof Error ? err.message : String(err) },
        'apply-pending-cloud-update.manifest-record-failed (bytes written; will reconcile on next sync)',
      );
    }

    clearPendingCloudUpdate(coreResolved, pending.relativePath);
    log.info(
      { relPath: pending.relativePath, cloudHash: pending.cloudHash },
      'apply-pending-cloud-update.applied',
    );

    // Nudge any open dialog to re-read so the applied card leaves the list.
    this.broadcastPendingCloudUpdates(coreResolved);

    return { success: true };
  }

  /**
   * Broadcast the current set of pending-cloud-update paths so the renderer can
   * surface a calm "newer version ready" toast and an open dialog can re-read.
   * Mirrors {@link broadcastConflicts} but on its own channel, because a pending
   * update is a DISTINCT, single-action state (not a three-way conflict) — see
   * the chief-designer brief 260619_111500. Always emits (even empty) so the UI
   * can clear: applying the last pending update should empty + close the dialog.
   */
  broadcastPendingCloudUpdates(coreDirectory: string): void {
    const paths = getPendingCloudUpdates(path.resolve(coreDirectory)).map((entry) => entry.relativePath);
    try {
      getBroadcastService().sendToAllWindows('cloud:workspace-pending-updates', { paths });
    } catch {
      log.warn('Failed to broadcast workspace pending cloud updates');
    }
  }

  /**
   * Clear syncSoon debounce timers and dirty-sync timer. Call on disconnect to prevent stale syncs.
   */
  clearSyncSoonTimers(): void {
    if (this.syncSoonDebounceTimer) {
      clearTimeout(this.syncSoonDebounceTimer);
      this.syncSoonDebounceTimer = null;
    }
    if (this.syncSoonMaxWaitTimer) {
      clearTimeout(this.syncSoonMaxWaitTimer);
      this.syncSoonMaxWaitTimer = null;
    }
    if (this.dirtySyncTimer) {
      clearTimeout(this.dirtySyncTimer);
      this.dirtySyncTimer = null;
    }
    // Reset dirty generation tracking — no pending work after disconnect
    this.dirtyGeneration = 0;
    this.syncedThroughGeneration = 0;
    this.pendingSyncClient = null;
    this.pendingSyncDir = null;
  }

  /**
   * Flush the syncSoon debounce: clear timers and trigger a throttled sync.
   *
   * Calls `syncIfNeeded()` (respects 5-min throttle) instead of `forceSync()`.
   * When throttled, sets a dirty flag and schedules a one-shot retry timer
   * so watcher-driven changes are never silently dropped — at most delayed
   * until the throttle window expires.
   */
  private flushSyncSoon(): void {
    if (this.syncSoonDebounceTimer) {
      clearTimeout(this.syncSoonDebounceTimer);
      this.syncSoonDebounceTimer = null;
    }
    if (this.syncSoonMaxWaitTimer) {
      clearTimeout(this.syncSoonMaxWaitTimer);
      this.syncSoonMaxWaitTimer = null;
    }

    const client = this.pendingSyncClient;
    const coreDir = this.pendingSyncDir;
    this.pendingSyncClient = null;
    this.pendingSyncDir = null;

    if (!client || !coreDir) return;

    log.info({ source: 'watcher' }, 'Workspace sync requested');

    // Bump dirty generation — this watcher-triggered sync attempt represents
    // a file change that needs to be covered by some sync execution.
    this.dirtyGeneration++;

    this.syncIfNeeded(client, coreDir).then((result) => {
      if (result === 'throttled' || result === 'in_progress') {
        // Sync didn't run — schedule a one-shot retry at the next eligible time.
        // Store client/dir for the retry (safe: these don't change across the session).
        this.pendingSyncClient = client;
        this.pendingSyncDir = coreDir;

        if (!this.dirtySyncTimer) {
          const retryInMs = Math.max(0, (this.lastSyncAt + SYNC_THROTTLE_MS) - Date.now());
          log.debug({ retryInMs }, 'Workspace sync deferred (throttled), scheduling retry');
          this.dirtySyncTimer = setTimeout(() => {
            this.dirtySyncTimer = null;
            // Only retry if there are uncovered dirty generations
            if (this.dirtyGeneration <= this.syncedThroughGeneration) return;
            const retryClient = this.pendingSyncClient;
            const retryDir = this.pendingSyncDir;
            if (!retryClient || !retryDir) return;
            this.syncIfNeeded(retryClient, retryDir).catch((err) => {
              log.warn({ err }, 'Dirty-flag retry workspace sync failed');
            });
          }, retryInMs);
        }
      }
      // If result === 'synced', generations were updated in executeSyncCore
    }).catch((err) => {
      log.warn({ err }, 'Debounced workspace sync failed');
    });
  }

  private broadcastConflicts(paths: string[]): void {
    const newPaths = paths.filter((p) => !this.broadcastedConflictKeys.has(p));
    if (newPaths.length === 0) return;

    for (const p of newPaths) this.broadcastedConflictKeys.add(p);

    try {
      getBroadcastService().sendToAllWindows('cloud:workspace-conflicts', { paths: newPaths });
    } catch {
      log.warn('Failed to broadcast workspace conflicts');
    }
  }

  private maybeBroadcastDriveAwareSyncToast(
    coreDirectory: string,
    relativePath: string,
    cycle: number,
    ageMs: number,
  ): void {
    if (hasDriveAwareSyncNoticeBeenShown(coreDirectory)) {
      return;
    }

    const workspaceFingerprint = buildDriveAwareWorkspaceFingerprint(coreDirectory);
    const timestamp = Date.now();

    try {
      getBroadcastService().sendToAllWindows(DRIVE_AWARE_SYNC_DEFERRED_CHANNEL, {
        workspaceFingerprint,
        timestamp,
        relPath: relativePath,
        cycle,
        ageMs,
      });
      markDriveAwareSyncNoticeShown(coreDirectory, timestamp);
    } catch (err) {
      log.warn(
        { err: err instanceof Error ? err.message : String(err), relPath: relativePath },
        'Failed to broadcast drive-aware sync deferral notice',
      );
    }
  }

  /**
   * Clear a conflict from the broadcast dedup set (e.g. after resolution).
   * If no path is provided, clears the entire set.
   */
  clearBroadcastedConflict(relativePath?: string): void {
    if (relativePath) {
      this.broadcastedConflictKeys.delete(relativePath);
    } else {
      this.broadcastedConflictKeys.clear();
    }
  }

  // ---- Internal -----------------------------------------------------------

  private reportIncompleteLocalManifest(
    coreDirectory: string,
    manifest: WorkspaceManifest,
    reasons: readonly SafeWalkTruncationReason[],
  ): void {
    log.warn({ reasons }, 'Workspace local manifest incomplete; skipping destructive operations');
    getErrorReporter().addBreadcrumb({
      category: 'cloud.workspace-sync',
      level: 'warning',
      message: 'manifest-incomplete-skipping-destructive-ops',
      data: {
        sessionIdHash: shortSha1Fingerprint(coreDirectory),
        reasons: reasons.join(','),
        entryCount: manifest.size,
      },
    });
  }

  private reportIncompleteCloudManifest(
    coreDirectory: string,
    cloudManifest: CloudManifest,
  ): void {
    log.warn({ reasons: cloudManifest.reasons }, 'Cloud manifest incomplete; skipping cloud-missing repair');
    getErrorReporter().addBreadcrumb({
      category: 'cloud.workspace-sync',
      level: 'warning',
      message: 'cloud-manifest-incomplete-skipping-repair',
      data: {
        sessionIdHash: shortSha1Fingerprint(coreDirectory),
        reasons: cloudManifest.reasons.join(','),
        entryCount: Object.keys(cloudManifest.entries).length,
      },
    });
  }

  /**
   * Hash a file using SHA-256 (truncated to first 16 hex chars for compactness).
   * This is for change detection, not security.
   */
  private async hashFile(filePath: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const hash = crypto.createHash('sha256');
      const stream = fs.createReadStream(filePath);
      stream.on('error', reject);
      stream.on('data', (chunk) => hash.update(chunk));
      stream.on('end', () => resolve(hash.digest('hex').slice(0, 16)));
    });
  }

  /**
   * Hash a buffer the SAME way `hashFile` hashes file bytes (sha256 over the raw
   * bytes, truncated to 16 hex chars), so a value produced here is directly
   * comparable to `hashFile` output, a manifest entry's `hash`, and a recorded
   * pending-update `cloudHash`/`baselineLocalHash`. Hashing the buffer we are
   * about to write (rather than the JS string) keeps one hashing model across
   * the cloud gate, the local gate, and the recorded last-synced hash.
   */
  private hashBuffer(bytes: Buffer): string {
    return crypto.createHash('sha256').update(bytes).digest('hex').slice(0, 16);
  }

  // ---- Testing ------------------------------------------------------------

  /**
   * Reset in-memory state (for tests only).
   */
  _resetForTesting(): void {
    this.lastPushedManifest = new Map();
    this.loaded = false;
    this.lastSyncAt = 0;
    this.syncInProgress = false;
    this.syncStartedAt = null;
    this.driveAwarePullCycle = 0;
    this.pullFailureMemos.clear();
    this.oversizedPushMemos.clear();
    if (this.writeTimer) {
      clearTimeout(this.writeTimer);
      this.writeTimer = null;
    }
    _resetDriveSettleDeferralsForTesting();
    _resetPendingCloudUpdatesForTesting();
    _resetQuarantinedWorkspaceConflictsForTesting();
    this.clearSyncSoonTimers();
  }

  /**
   * Expose last sync timestamp for testing.
   */
  _getLastSyncAt(): number {
    return this.lastSyncAt;
  }

  /**
   * Expose last pushed manifest for testing.
   */
  _getLastPushedManifest(): WorkspaceManifest {
    this.load();
    return this.lastPushedManifest;
  }
}

// ---------------------------------------------------------------------------
// Singleton export
// ---------------------------------------------------------------------------

export const cloudWorkspaceSync = new CloudWorkspaceSync();
