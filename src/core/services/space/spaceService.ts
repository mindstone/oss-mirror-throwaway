/**
 * Space Service
 *
 * Centralized service for space creation, discovery, and management.
 * Provides consistent behavior between onboarding, settings, and future skill-based creation.
 */

import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import fm from 'front-matter';
import type { SpaceConfig, SpaceType, SpaceSharingLevel, SpaceStorageProvider } from '@shared/types';
import { logger } from '@core/logger';
import { getErrorReporter } from '@core/errorReporter';
import { toPortablePath, relativePortablePath } from '@core/utils/portablePath';
import { SpaceFrontmatterSchema, type SpaceFrontmatter } from '@core/services/promptTemplateService';
import { getSystemSettingsPath } from '@core/services/systemSettingsSync';
import { detectCloudStorage, getTimeoutForPath } from '@core/utils/cloudStorageUtils';
import { resolveSpaceSyncStatus, type SpaceSyncStatus } from '@core/services/cloudSymlinkIndexing';
import {
  workspaceFs,
  cloudLaneOptionForPath,
  type WorkspaceFsOptions,
  type WorkspaceFsOutcome,
  type WorkspaceStat,
  type WorkspaceDirent,
} from '@core/services/boundedWorkspaceFs';
import {
  HotPathCounterTracker,
  type HotPathCounters,
  type HotPathWindowedCounters,
} from '@core/services/perfCounters';
import { CoalescedCache } from '@core/utils/coalescedCache';
import {
  atomicWriteWithReValidate,
  type AtomicWriteFs,
  tryMechanicalFrontmatterRepair,
} from '@core/services/frontmatterRepair';
import { getCompanyNameFromPath } from '@core/services/spaceOrganisationHeuristics';
import {
  WriteOutsideWorkspaceError,
  assertSpaceWriteSafe,
  isProtectedRootName,
  type AssertSpaceWriteSafeOptions,
} from '@core/services/spaceWriteSafety';

// ── Hot-path counters — per-lane scanSpaces observability ───────────────
// See docs/plans/260420_perf_observability_and_low_risk_wins.md § Stage 1.
// Split by `skipAutoFix` mode: `readOnly` (skipAutoFix: true) is side-effect
// free and Stage 5 will cache it; `writable` (default) writes frontmatter
// auto-fixes so it CANNOT share a cache with `readOnly`.
const scanSpacesReadOnlyCounter = new HotPathCounterTracker();
const scanSpacesWritableCounter = new HotPathCounterTracker();

export interface ScanSpacesCounters {
  readOnly: HotPathCounters;
  writable: HotPathCounters;
}

export interface ScanSpacesWindowedCounters {
  readOnly: HotPathWindowedCounters;
  writable: HotPathWindowedCounters;
}

/** Read-only snapshot of both scanSpaces lanes' counters. */
export function getScanSpacesCounters(): ScanSpacesCounters {
  return {
    readOnly: scanSpacesReadOnlyCounter.snapshot(),
    writable: scanSpacesWritableCounter.snapshot(),
  };
}

/** Rolling-window + cumulative snapshots for both scanSpaces lanes. */
export function getScanSpacesWindowedCounters(): ScanSpacesWindowedCounters {
  return {
    readOnly: scanSpacesReadOnlyCounter.windowedSnapshot(),
    writable: scanSpacesWritableCounter.windowedSnapshot(),
  };
}

/** Test-only: zero both scanSpaces lanes' counters. */
export function _resetScanSpacesCountersForTesting(): void {
  scanSpacesReadOnlyCounter._resetForTesting();
  scanSpacesWritableCounter._resetForTesting();
  _resetSpaceScanCacheForTesting();
}

// ── Stage 5: scanSpaces read-only coalesced cache ────────────────────────
const SPACE_SCAN_CACHE_TTL_MS = 30_000;
const SPACE_SCAN_CACHE_MAX_ENTRIES = 16;
const NO_WORKSPACE_CACHE_KEY = '<no-workspace>';
const IS_PERF_MODE = process.env.REBEL_PERF_MODE === '1';
const spaceScanCacheInvalidationListeners = new Set<(workspacePath: string, reason?: string) => void>();

function getSpaceScanCacheKey(workspacePath: string): string {
  const trimmed = workspacePath?.trim?.() ?? '';
  if (!trimmed) {
    return NO_WORKSPACE_CACHE_KEY;
  }
  try {
    // path.resolve throws on strings containing NUL bytes (`\0`). Fall back to
    // the empty-workspace sentinel so invalidation/lookup never crashes on a
    // corrupted input — cache operations must be no-throw for all string inputs.
    return path.resolve(trimmed);
  } catch {
    return NO_WORKSPACE_CACHE_KEY;
  }
}

function isSpaceCoalesceDisabled(): boolean {
  return process.env.REBEL_DISABLE_SPACES_COALESCE === '1';
}

const scanSpacesReadOnlyCache = new CoalescedCache<SpaceInfo[]>({
  ttlMs: SPACE_SCAN_CACHE_TTL_MS,
  maxEntries: SPACE_SCAN_CACHE_MAX_ENTRIES,
  now: () => Date.now(),
  onHit: () => {
    scanSpacesReadOnlyCounter.recordHit();
  },
  onMiss: () => {
    scanSpacesReadOnlyCounter.recordMiss();
  },
  onInflight: () => {
    scanSpacesReadOnlyCounter.recordInflightJoin();
  },
  onError: (_key, err) => {
    scanSpacesReadOnlyCounter.recordFetchError();
    logger.warn(
      { err, reason: 'scan-spaces-readonly-cache-fetch-error' },
      'scanSpacesReadOnly cache fetcher rejected',
    );
  },
});

export function registerSpaceScanCacheInvalidationListener(
  listener: (workspacePath: string, reason?: string) => void,
): () => void {
  spaceScanCacheInvalidationListeners.add(listener);
  return () => {
    spaceScanCacheInvalidationListeners.delete(listener);
  };
}

/** Invalidate a single workspace read-only scan cache entry. */
export function invalidateSpaceScanCache(workspacePath: string, reason?: string): void {
  const key = getSpaceScanCacheKey(workspacePath);
  scanSpacesReadOnlyCache.invalidate(key);
  for (const listener of spaceScanCacheInvalidationListeners) {
    try {
      listener(workspacePath, reason);
    } catch (err) {
      logger.warn({ err, workspacePath, reason }, 'scanSpaces cache invalidation listener failed');
    }
  }
  if (IS_PERF_MODE) {
    logger.debug({ key, reason, profilerChannel: 'perf-summary' }, 'Invalidated scanSpaces read-only cache entry');
  }
}

/** Clear all read-only scan cache entries across workspaces. */
export function clearAllSpaceScanCaches(reason?: string): void {
  scanSpacesReadOnlyCache.clear();
  if (IS_PERF_MODE) {
    logger.debug({ reason, profilerChannel: 'perf-summary' }, 'Cleared all scanSpaces read-only caches');
  }
}

/** Test-only: clear all read-only scan cache entries. */
export function _resetSpaceScanCacheForTesting(): void {
  scanSpacesReadOnlyCache.clear();
}

export type SpaceScanAccessOperation = 'workspace-root-readdir' | 'workspace-work-readdir';

export class SpaceScanAccessError extends Error {
  public readonly kind = 'access' as const;
  public readonly path: string;
  public readonly operation: SpaceScanAccessOperation;
  public readonly code?: string;
  /**
   * True iff this scan was aborted because the workspace root/work dir hit a
   * `reconnecting` cloud mount (S4.1e Inv 4). Distinct from "missing root → []" and
   * "no spaces found → []": a degraded root surfaces as a typed scan-UNAVAILABLE error
   * (callers already tolerate SpaceScanAccessError) so a consumer never reads a spurious
   * `[]` as "no spaces". The `operation` stays in the existing enum (the IPC `operation`
   * field is unchanged); `reconnecting` is the dedicated distinguishing signal.
   */
  public readonly reconnecting: boolean;

  constructor(params: { path: string; operation: SpaceScanAccessOperation; code?: string; reconnecting?: boolean }) {
    const reconnecting = params.reconnecting === true;
    const locationLabel = params.operation === 'workspace-work-readdir' ? 'workspace work directory' : 'workspace root';
    const withCode = params.code ? ` (${params.code})` : '';
    const reason = reconnecting ? ' (reconnecting — try again in a moment)' : '';
    super(`Unable to read ${locationLabel}.${withCode}${reason}`);
    this.name = 'SpaceScanAccessError';
    this.path = params.path;
    this.operation = params.operation;
    this.code = params.code;
    this.reconnecting = reconnecting;
  }
}

export function isSpaceScanAccessError(error: unknown): error is SpaceScanAccessError {
  return error instanceof SpaceScanAccessError;
}

// Template file names
const CHIEF_OF_STAFF_TEMPLATE = 'README-template-for-Chief-of-Staff.md';
const GENERIC_SPACE_TEMPLATE = 'README-template-for-space.md';
const OPERATOR_SPACE_TEMPLATE = 'README-template-for-operator.md';
const README_MD = 'README.md';
const LEGACY_AGENTS_MD = 'AGENTS.md'; // For migration support

interface SpaceWriteOperationOptions {
  workspaceRoot?: string;
  writeSafetyOptions?: AssertSpaceWriteSafeOptions;
}

interface UpdateSpaceFrontmatterOptions extends SpaceWriteOperationOptions {
  atomicWriteFs?: AtomicWriteFs;
}

function inferWorkspaceRootForSpaceWrite(spacePath: string): string {
  const resolved = path.resolve(spacePath);
  const basename = path.basename(resolved);

  if (basename === README_MD || basename === LEGACY_AGENTS_MD) {
    return inferWorkspaceRootForSpaceWrite(path.dirname(resolved));
  }

  if (path.basename(path.dirname(resolved)).toLowerCase() === 'backups') {
    return inferWorkspaceRootForSpaceWrite(path.dirname(path.dirname(resolved)));
  }

  const parts = resolved.split(path.sep);
  const workIndex = parts.lastIndexOf('work');
  if (workIndex > 0 && parts.length > workIndex + 2) {
    const prefix = parts.slice(0, workIndex).join(path.sep);
    return prefix || path.sep;
  }

  return path.dirname(resolved);
}

function resolveWorkspaceRootForSpaceWrite(
  spacePath: string,
  options?: SpaceWriteOperationOptions,
): string {
  return options?.workspaceRoot ?? inferWorkspaceRootForSpaceWrite(spacePath);
}

async function assertSpaceWriteSafeForWrite(
  workspaceRoot: string,
  spacePath: string,
  options?: AssertSpaceWriteSafeOptions,
): Promise<string> {
  try {
    return await assertSpaceWriteSafe(workspaceRoot, spacePath, options);
  } catch (err) {
    if (err instanceof WriteOutsideWorkspaceError) {
      logger.error(
        {
          workspaceRoot,
          spacePath,
          resolvedRealPath: err.resolvedRealPath,
          reason: err.reason,
        },
        'Refused space write — path escapes workspace',
      );
      getErrorReporter().addBreadcrumb({
        category: 'space.write-safety',
        level: 'error',
        message: 'Refused space write — path escapes workspace',
        data: {
          workspaceRoot,
          spacePath,
          resolvedRealPath: err.resolvedRealPath,
          reason: err.reason,
        },
      });
    }
    throw err;
  }
}

/**
 * Validate that a space path is safe and doesn't escape the workspace.
 * 
 * Security checks:
 * 1. Rejects absolute paths (e.g., /etc/passwd, C:\Windows)
 * 2. Rejects path traversal attempts (e.g., ../sensitive-data)
 * 3. Ensures resolved path stays within workspace root
 * 
 * @param workspacePath - The root workspace directory (absolute path)
 * @param spacePath - The relative space path to validate
 * @returns The resolved absolute path if valid
 * @throws Error if path is invalid or escapes workspace
 */
export const validateSpacePath = (workspacePath: string, spacePath: string): string => {
  if (!workspacePath) {
    throw new Error('Workspace path is required');
  }
  if (!spacePath || typeof spacePath !== 'string') {
    throw new Error('Space path is required');
  }

  const trimmedPath = spacePath.trim();
  if (!trimmedPath) {
    throw new Error('Space path cannot be empty');
  }

  // Check 1: Reject absolute paths
  if (path.isAbsolute(trimmedPath)) {
    throw new Error('Space path must be relative to workspace');
  }

  // Check 2: Reject path traversal attempts
  // Normalize to forward slashes for consistent checking
  const normalizedForCheck = toPortablePath(trimmedPath);
  if (normalizedForCheck.includes('..')) {
    throw new Error('Path traversal is not permitted');
  }

  // Check 3: Resolve and verify path stays within workspace
  const root = path.resolve(workspacePath);
  const resolved = path.resolve(root, trimmedPath);

  // Reject workspace root itself (e.g., spacePath='.' would resolve to root)
  // This prevents catastrophic deletion of the entire workspace
  if (resolved === root) {
    throw new Error('Cannot operate on workspace root');
  }

  // Use root + path.sep to prevent prefix attacks (e.g., /workspace vs /workspaceX)
  if (!resolved.startsWith(root + path.sep)) {
    throw new Error('Space path escapes workspace directory');
  }

  return resolved;
};

export interface CreateSpaceOptions {
  /** Display name for the space */
  name: string;
  /** Type of space - determines template and behavior */
  type: SpaceType;
  /** Whether to create as symlink or direct folder */
  location: 'workspace' | 'symlink';
  /** For symlinks: absolute path to source folder */
  sourcePath?: string;
  /** Relative path within workspace (e.g., 'work/Mindstone/General') */
  targetPath?: string;
  /** Company name for work spaces */
  companyName?: string;
  /** Human-owned organisation grouping label */
  organisation?: string;
  /** Sharing level */
  sharing?: SpaceSharingLevel;
  /** Storage provider (for symlinks) */
  storageProvider?: SpaceStorageProvider;
  /** Description for the space (will be written to README frontmatter) */
  description?: string;
  /** Whether to create standard subfolders (memory, skills, scripts). Defaults to true. */
  createSubfolders?: boolean;
  /** Which subfolders to create (only used if createSubfolders is true) */
  selectedSubfolders?: string[];
  /** Memory trust level for the space (undefined = use global setting) */
  memoryTrust?: 'always_ask' | 'balanced' | 'always_write';
  /** Skip writing frontmatter to README.md (for add-existing mode where folder already has frontmatter) */
  skipFrontmatterWrite?: boolean;
  /** Associated email accounts for this Space */
  emails?: string[];
  /**
   * User-local account associations for this space.
   * Undefined preserves legacy README `emails`; [] is explicit local none.
   */
  associatedAccounts?: string[];
}

export interface SpaceInfo {
  /** Display name (folder name) */
  name: string;
  /** Relative path within workspace */
  path: string;
  /** Absolute path on disk */
  absolutePath: string;
  /** Space type from frontmatter or inferred */
  type: SpaceType;
  /** Whether this is a symlink */
  isSymlink: boolean;
  /** Whether README.md (or legacy AGENTS.md) exists in this space */
  hasReadme: boolean;
  /** True if space has legacy AGENTS.md (but no README.md) - should offer rename */
  hasLegacyAgentsMd?: boolean;
  /** True if space has BOTH README.md and AGENTS.md - needs manual resolution */
  hasBothConfigFiles?: boolean;
  /** Parsed frontmatter from README.md (if present) */
  frontmatter?: SpaceFrontmatter;
  /** Source path (for symlinks) */
  sourcePath?: string;
  /** Description from frontmatter */
  description?: string;
  /** Custom display name from frontmatter (e.g., "Mindstone - Exec") */
  displayName?: string;
  /** Sharing level from frontmatter */
  sharing?: string;
  /** Memory trust level (undefined = use global setting) */
  memoryTrust?: 'always_ask' | 'balanced' | 'always_write';
  /** Associated email accounts from frontmatter (for MCP matching) */
  emails?: string[];
  /** User-local associated accounts from settings (not README frontmatter) */
  associatedAccounts?: string[];
  /** Organisation name for this space (for skills that reference {COMPANY_NAME}) */
  organisationName?: string;
  /** Whether the space directory is writable. true = writable, false = read-only, undefined = not yet checked */
  writable?: boolean;
  /** Scan status: 'ok' means healthy, 'needs_attention' means broken frontmatter or missing description */
  status?: 'ok' | 'needs_attention';
  /** Human-readable message when status is 'needs_attention' */
  statusMessage?: string;
  /**
   * Cloud SYNC health (Stage 8) — distinct from `status` (config health). Populated
   * only for an ADMITTED cloud space (flag on + cloud symlink); otherwise omitted /
   * 'healthy' (inert). See `SpaceSyncStatus` in `cloudSymlinkIndexing.ts`.
   */
  syncStatus?: SpaceSyncStatus;
}

/**
 * Get the appropriate template file for a space type.
 */
export const getTemplateForSpaceType = (type: SpaceType): string => {
  switch (type) {
    case 'chief-of-staff':
      return CHIEF_OF_STAFF_TEMPLATE;
    case 'operator':
      return OPERATOR_SPACE_TEMPLATE;
    case 'personal':
    case 'company':
    case 'team':
    case 'project':
    case 'other':
    default:
      return GENERIC_SPACE_TEMPLATE;
  }
};

/** Result from reading space frontmatter with error details */
export interface FrontmatterReadResult {
  frontmatter?: SpaceFrontmatter;
  parseError?: string;
  /**
   * True iff the config read hit a `reconnecting` cloud mount (the bounded boundary
   * killed a wedged read). DISTINCT from "no config file" (absence): the scan lane
   * must RETAIN such a space + mark it degraded, never drop it (S4.1e Inv 3 / GPT F1).
   * Omitted on the local/healthy fast path → byte-identical for non-cloud callers.
   */
  reconnecting?: boolean;
}

// ── S4.1e: bounded read-lane adapter (scanSpacesReadOnly) ─────────────────
// Every fs read reachable from `_scanSpacesImpl` routes through the bounded
// `workspaceFs` boundary so a dead/slow cloud mount degrades to `reconnecting`
// (killable, never an unbounded hang) instead of wedging the app-wide-coalesced
// `scanSpacesReadOnly` promise. Design rationale (the reconnecting-as-RETURN-VALUE,
// never-thrown discriminant + bound-INSIDE-_scanSpacesImpl decision):
// see docs/plans/260622_libraryhandlers-read-lane/PLAN.md § Intent & Design Rationale #1, #2.
//
// `reconnecting` is NEVER thrown: `_scanSpacesImpl`'s broad per-candidate `catch`
// blocks DROP anything that throws, so a thrown reconnecting would silently drop a
// healthy-but-degraded cloud space (Inv 3 violation). It is a returned discriminant
// the candidate loop branches on BEFORE the generic catch — making "drop a
// reconnecting space" structurally unrepresentable.

/** A bounded scan read: a value, a `reconnecting` degrade, or a real fs error. */
type ScanRead<T> =
  | { readonly kind: 'value'; readonly value: T }
  | { readonly kind: 'reconnecting' }
  | { readonly kind: 'error'; readonly error: NodeJS.ErrnoException };

/** Map a boundary outcome to the scan-lane discriminant (no throw on reconnecting). */
function toScanRead<T>(outcome: WorkspaceFsOutcome<T>): ScanRead<T> {
  if (outcome.status === 'ok') return { kind: 'value', value: outcome.value };
  if (outcome.status === 'reconnecting') return { kind: 'reconnecting' };
  return { kind: 'error', error: outcome.error };
}

/**
 * Per-path cloud-lane override for ANY scan-lane read (root, work, every candidate read,
 * and the reads inside the shared helpers). MUST be derived from the PATH BEING READ and
 * applied to EVERY scan read — NOT just the root (S4.1e Stage 1 review F1).
 *
 * Why per-read: `classifyWorkspacePath` (the boundary's default) is CONTAINMENT-only, so a
 * PATTERN-cloud path that is NOT a configured containment space classifies `'local'` and
 * reaches bare fs → the exact dead-mount hang we're eliminating. A whole workspace living
 * under `~/Library/CloudStorage/GoogleDrive-…` that was never configured as a space is the
 * canonical miss: its ROOT readdir would be cloud-forced, but every DESCENDANT candidate
 * read (`stat`/`realpath`/config `access`/frontmatter `readFile`/structure `readdir`) would
 * fall back to containment → bare fs → hang. Deriving the option from each read's own path
 * routes a candidate that is containment-cloud OR pattern-cloud to the bounded cloud lane.
 * Genuinely-local paths return `undefined` (containment default applies → byte-identical).
 */
function cloudReadOption(p: string): WorkspaceFsOptions | undefined {
  return cloudLaneOptionForPath(p);
}

// ── S4.1f: bounded read helpers for the NON-scan write/create/rename/move/migrate paths ──
// The S4.1e scan lane uses the `ScanRead`/`toScanRead` return-value discriminant (it must
// retain-not-drop a degraded space INSIDE a broad candidate catch). The non-scan reads here
// are different: each already sits in a try/catch that branches on `err.code` (ENOENT vs
// EMFILE vs other) and many are CAS pre-write or destructive pre-step probes where a
// reconnecting/unknowable read must NEVER be mistaken for "absent → safe to write/delete"
// (the data-safety crux). So these helpers THROW (the same contract as the raw `fs.*` they
// replace), funneling the outcome→behaviour mapping through ONE place:
//   - `ok`           → the value.
//   - `error`        → re-throw the ORIGINAL `NodeJS.ErrnoException` (`.code` intact), so every
//                      existing `err.code === 'ENOENT'` / EMFILE branch is byte-preserved.
//   - `reconnecting` → throw a typed `SpaceFsReconnectingError`. A site whose catch defaults to
//                      "absent" (`.catch(()=>false)`, fail-open) MUST detect this (via
//                      `isSpaceFsReconnecting`) and FAIL CLOSED — never treat reconnecting as
//                      absence (that would silently corrupt/delete on a degraded cloud mount).
// Per-path `cloudReadOption(p)` carries each path's own pattern-cloud evidence; on cloud/mobile
// (no executor) every op is the bare-fsp LOCAL lane (S4.1e forceCloud-no-op), byte-identical.

/** Thrown by the S4.1f bounded helpers when a read hits a `reconnecting` cloud mount. */
class SpaceFsReconnectingError extends Error {
  public readonly kind = 'space-fs-reconnecting' as const;
  constructor(public readonly path: string) {
    super('This space is reconnecting — try again in a moment.');
    this.name = 'SpaceFsReconnectingError';
  }
}

/** True iff `e` is the typed reconnecting error from the S4.1f bounded helpers. */
function isSpaceFsReconnecting(e: unknown): e is SpaceFsReconnectingError {
  return e instanceof SpaceFsReconnectingError;
}

/** Throw on a non-`ok` outcome: `reconnecting`→typed error; `error`→original errno. */
function throwBoundedReadFailure(
  path: string,
  outcome: { status: 'reconnecting' } | { status: 'error'; error: NodeJS.ErrnoException },
): never {
  if (outcome.status === 'reconnecting') throw new SpaceFsReconnectingError(path);
  throw outcome.error;
}

async function boundedStat(p: string): Promise<WorkspaceStat> {
  const outcome = await workspaceFs.stat(p, cloudReadOption(p));
  if (outcome.status === 'ok') return outcome.value;
  return throwBoundedReadFailure(p, outcome);
}

async function boundedLstat(p: string): Promise<WorkspaceStat> {
  const outcome = await workspaceFs.lstat(p, cloudReadOption(p));
  if (outcome.status === 'ok') return outcome.value;
  return throwBoundedReadFailure(p, outcome);
}

async function boundedReadlink(p: string): Promise<string> {
  const outcome = await workspaceFs.readlink(p, cloudReadOption(p));
  if (outcome.status === 'ok') return outcome.value;
  return throwBoundedReadFailure(p, outcome);
}

async function boundedReaddir(p: string): Promise<string[]> {
  const outcome = await workspaceFs.readdir(p, cloudReadOption(p));
  if (outcome.status === 'ok') return outcome.value;
  return throwBoundedReadFailure(p, outcome);
}

async function boundedReaddirWithFileTypes(p: string): Promise<WorkspaceDirent[]> {
  const outcome = await workspaceFs.readdirWithFileTypes(p, cloudReadOption(p));
  if (outcome.status === 'ok') return outcome.value;
  return throwBoundedReadFailure(p, outcome);
}

async function boundedReadFileUtf8(p: string): Promise<string> {
  const outcome = await workspaceFs.readFile(p, 'utf-8', cloudReadOption(p));
  if (outcome.status === 'ok') return outcome.value;
  return throwBoundedReadFailure(p, outcome);
}

async function boundedReadFileBytes(p: string): Promise<Buffer> {
  const outcome = await workspaceFs.readFileBytes(p, cloudReadOption(p));
  if (outcome.status === 'ok') return outcome.value;
  return throwBoundedReadFailure(p, outcome);
}

/** Bounded existence/permission probe — `void` on accessible, throws on error/reconnecting
 *  (same contract as raw `fs.access`). `mode` = `fsSync.constants.*_OK` (default existence). */
async function boundedAccess(p: string, mode?: number): Promise<void> {
  const outcome = await workspaceFs.access(p, mode, cloudReadOption(p));
  if (outcome.status === 'ok') return;
  throwBoundedReadFailure(p, outcome);
}

/**
 * Read and parse frontmatter from a space config file (README.md or legacy AGENTS.md).
 * Returns both the parsed frontmatter and any parse error, so callers can distinguish
 * between "no frontmatter" (fixable) and "malformed YAML" (needs agent repair).
 */
export const readSpaceFrontmatterWithError = async (spacePath: string): Promise<FrontmatterReadResult> => {
  const readmePath = path.join(spacePath, README_MD);
  const legacyPath = path.join(spacePath, LEGACY_AGENTS_MD);

  let content: string;

  // Bounded reads (S4.1e): a dead cloud mount degrades to `reconnecting` (propagated
  // so the scan lane RETAINS the space) rather than hanging. A real fs error is
  // treated exactly as before — fall back to legacy, then to absence.
  const readmeRead = toScanRead(await workspaceFs.readFile(readmePath, 'utf-8', cloudReadOption(readmePath)));
  if (readmeRead.kind === 'reconnecting') {
    return { frontmatter: undefined, parseError: undefined, reconnecting: true };
  }
  if (readmeRead.kind === 'value') {
    content = readmeRead.value;
  } else {
    // README unreadable — fall back to legacy AGENTS.md.
    const legacyRead = toScanRead(await workspaceFs.readFile(legacyPath, 'utf-8', cloudReadOption(legacyPath)));
    if (legacyRead.kind === 'reconnecting') {
      return { frontmatter: undefined, parseError: undefined, reconnecting: true };
    }
    if (legacyRead.kind === 'value') {
      content = legacyRead.value;
      logger.info({ spacePath }, 'Reading from legacy AGENTS.md - consider renaming to README.md');
    } else {
      // No config file at all - frontmatter is undefined but no parse error
      return { frontmatter: undefined, parseError: undefined };
    }
  }

  try {
    const parsed = fm(content);

    if (!parsed.attributes || typeof parsed.attributes !== 'object') {
      return { frontmatter: undefined, parseError: undefined };
    }

    const result = SpaceFrontmatterSchema.safeParse(parsed.attributes);
    if (result.success) {
      return { frontmatter: result.data, parseError: undefined };
    }

    // Partial frontmatter - extract what we can with validation
    const attrs = parsed.attributes as Record<string, unknown>;
    const hasAnyKnownField =
      attrs.rebel_space_description ||
      attrs.display_name ||
      attrs.organisation_name ||
      attrs.space_type ||
      attrs.sharing ||
      attrs.sensitivity ||
      attrs.memoryTrust ||
      attrs.related_spaces ||
      attrs.owner ||
      attrs.emails ||
      attrs.personal_goals_last_reviewed ||
      attrs.company_values_last_reviewed;

    if (hasAnyKnownField) {
      // Validate enum values - only accept known valid values, otherwise undefined
      const validSpaceTypes = ['chief-of-staff', 'personal', 'company', 'team', 'project', 'operator', 'other'];
      const validSharing = ['private', 'restricted', 'team', 'company-wide', 'public'];
      const validSensitivity = ['standard', 'confidential', 'restricted'];
      const validMemoryTrust = ['always_ask', 'balanced', 'always_write'];

      return {
        frontmatter: {
          rebel_space_description:
            typeof attrs.rebel_space_description === 'string' ? attrs.rebel_space_description : '',
          display_name:
            typeof attrs.display_name === 'string' && attrs.display_name.trim()
              ? attrs.display_name.trim()
              : undefined,
          organisation_name:
            typeof attrs.organisation_name === 'string' && attrs.organisation_name.trim()
              ? attrs.organisation_name.trim()
              : undefined,
          space_type:
            typeof attrs.space_type === 'string' && validSpaceTypes.includes(attrs.space_type)
              ? (attrs.space_type as SpaceFrontmatter['space_type'])
              : undefined,
          sharing:
            typeof attrs.sharing === 'string' && validSharing.includes(attrs.sharing)
              ? (attrs.sharing as SpaceFrontmatter['sharing'])
              : undefined,
          sensitivity:
            typeof attrs.sensitivity === 'string' && validSensitivity.includes(attrs.sensitivity)
              ? (attrs.sensitivity as SpaceFrontmatter['sensitivity'])
              : undefined,
          memoryTrust:
            typeof attrs.memoryTrust === 'string' && validMemoryTrust.includes(attrs.memoryTrust)
              ? (attrs.memoryTrust as SpaceFrontmatter['memoryTrust'])
              : undefined,
          related_spaces: Array.isArray(attrs.related_spaces)
            ? attrs.related_spaces.filter((s) => typeof s === 'string')
            : undefined,
          owner: typeof attrs.owner === 'string' ? attrs.owner : undefined,
          emails: Array.isArray(attrs.emails) ? attrs.emails.filter((s) => typeof s === 'string') : undefined,
          personal_goals_last_reviewed:
            typeof attrs.personal_goals_last_reviewed === 'string' ? attrs.personal_goals_last_reviewed : undefined,
          company_values_last_reviewed:
            typeof attrs.company_values_last_reviewed === 'string' ? attrs.company_values_last_reviewed : undefined,
        },
        parseError: undefined,
      };
    }

    return { frontmatter: undefined, parseError: undefined };
  } catch (err) {
    // YAML parse error - return the error message for display
    const errorMessage = err instanceof Error ? err.message : String(err);
    logger.warn({ spacePath, error: errorMessage }, 'Failed to parse frontmatter in space README - space needs attention');
    return { frontmatter: undefined, parseError: errorMessage };
  }
};

/**
 * Read and parse frontmatter from a space config file (README.md or legacy AGENTS.md).
 * Returns undefined if file doesn't exist or has no valid frontmatter.
 */
export const readSpaceReadmeFrontmatter = async (spacePath: string): Promise<SpaceFrontmatter | undefined> => {
  const result = await readSpaceFrontmatterWithError(spacePath);
  return result.frontmatter;
};

/**
 * Read the body text of a space's README.md (everything after the frontmatter).
 *
 * Used by the memoryWriteHook to pass space exclusion-policy context to the
 * Safety Prompt for automation writes. See planning doc:
 * `docs/plans/260415_source_capture_automation_shared_space_safety.md`.
 *
 * Fail-open on any I/O or parse error (missing file, permission denied,
 * malformed YAML, etc.): returns `null`. Never throws.
 *
 * Returns `null` when:
 * - README.md is missing or unreadable
 * - file is empty (or whitespace-only)
 * - frontmatter is malformed
 * - there is no body after the frontmatter
 *
 * Returns the body text otherwise. If the file has no frontmatter, the full
 * content is returned (front-matter treats the whole file as body).
 *
 * Note: Unlike `readSpaceReadmeFrontmatter`, this helper does NOT fall back to
 * legacy `AGENTS.md` — it reads `README.md` only, by explicit design for the
 * Safety Prompt enrichment path.
 */
export const readSpaceReadmeBody = async (spacePath: string): Promise<string | null> => {
  if (!spacePath) {
    return null;
  }

  const readmePath = path.join(spacePath, README_MD);

  let content: string;
  try {
    // S4.1f: bounded read (read-only, fail-open). A reconnecting cloud mount → the catch's
    // `null` (same as today's missing/permission-denied fail-open — no write depends on it).
    content = await boundedReadFileUtf8(readmePath);
  } catch {
    // Missing file, permission denied, EISDIR, reconnecting, etc. — fail-open.
    return null;
  }

  if (!content || !content.trim()) {
    return null;
  }

  let body: string;
  try {
    body = fm(content).body;
  } catch {
    // Malformed YAML frontmatter — fail-open.
    return null;
  }

  if (!body || !body.trim()) {
    return null;
  }

  return body;
};

/** Result from auto-fix attempt */
interface AutoFixResult {
  success: boolean;
  error?: string;
}

/**
 * Add rebel_space_description to a space's README.md frontmatter.
 * This is used to auto-fix spaces that have no description.
 * Idempotent - will not write if description already exists.
 */
export const addDescriptionToFrontmatter = async (spacePath: string, folderName: string): Promise<AutoFixResult> => {
  const readmePath = path.join(spacePath, README_MD);
  const legacyPath = path.join(spacePath, LEGACY_AGENTS_MD);
  const workspaceRoot = resolveWorkspaceRootForSpaceWrite(spacePath);

  // Determine which file to modify
  let filePath = readmePath;
  let existingContent = '';
  let fileExists = false;

  // S4.1f: bounded CAS pre-read. A `reconnecting` cloud mount must NEVER be read as
  // "no file exists → create" — that would overwrite an unreachable existing README
  // (data loss). Fail closed: skip the auto-fix entirely while the mount is degraded.
  try {
    existingContent = await boundedReadFileUtf8(readmePath);
    fileExists = true;
  } catch (readmeErr) {
    if (isSpaceFsReconnecting(readmeErr)) {
      return { success: false, error: 'Cannot auto-fix: this space is reconnecting' };
    }
    // Try legacy AGENTS.md
    try {
      existingContent = await boundedReadFileUtf8(legacyPath);
      filePath = legacyPath;
      fileExists = true;
    } catch (legacyErr) {
      if (isSpaceFsReconnecting(legacyErr)) {
        return { success: false, error: 'Cannot auto-fix: this space is reconnecting' };
      }
      // No file exists - we'll create README.md
      filePath = readmePath;
    }
  }

  // Check if already has description (idempotent)
  if (fileExists) {
    try {
      const parsed = fm(existingContent);
      const attrs = parsed.attributes as Record<string, unknown> | undefined;
      if (attrs?.rebel_space_description && String(attrs.rebel_space_description).trim()) {
        // Already has description - nothing to do
        return { success: true };
      }
    } catch {
      // Parse error - don't try to auto-fix malformed YAML
      return { success: false, error: 'Cannot auto-fix: malformed YAML frontmatter' };
    }
  }

  try {
    await assertSpaceWriteSafeForWrite(workspaceRoot, spacePath);

    // Escape special characters in folder name for YAML safety
    // Escape backslashes first, then quotes
    const safeDescription = folderName.replace(/\\/g, '\\\\').replace(/"/g, '\\"');

    // Build new content
    let newContent: string;

    if (!fileExists || !existingContent.trim()) {
      // Create new file with minimal frontmatter
      newContent = `---\nrebel_space_description: "${safeDescription}"\n---\n\n# ${folderName}\n`;
    } else if (existingContent.startsWith('---')) {
      // Has frontmatter block - add description to it
      const fmEnd = existingContent.indexOf('\n---', 3);
      if (fmEnd === -1) {
        // Malformed frontmatter (no closing ---) - don't auto-fix
        return { success: false, error: 'Cannot auto-fix: malformed frontmatter (no closing ---)' };
      }
      const frontmatterBlock = existingContent.slice(4, fmEnd);
      const restOfContent = existingContent.slice(fmEnd + 4);
      newContent = `---\nrebel_space_description: "${safeDescription}"\n${frontmatterBlock}\n---${restOfContent}`;
    } else {
      // No frontmatter - prepend one
      newContent = `---\nrebel_space_description: "${safeDescription}"\n---\n\n${existingContent}`;
    }

    // Write the file
    await fs.writeFile(filePath, newContent, 'utf-8');
    logger.info({ spacePath, folderName }, 'Auto-added rebel_space_description to space frontmatter');
    return { success: true };
  } catch (err) {
    if (err instanceof WriteOutsideWorkspaceError) {
      throw err;
    }
    const errorMessage = err instanceof Error ? err.message : String(err);
    logger.error({ spacePath, error: errorMessage }, 'Failed to auto-fix space frontmatter');
    return { success: false, error: errorMessage };
  }
};

/**
 * Attempt mechanical frontmatter repair on the space's README (or legacy
 * AGENTS.md). Used by the scanSpaces writable auto-fix path and the daily
 * maintenance pipeline's pre-LLM mechanical step.
 *
 * Repair cases (see `@core/services/frontmatterRepair`):
 *   - Missing closing `---` delimiter — heuristically wrap when parseable.
 *   - Duplicate top-level keys — keep the LAST occurrence.
 *   - Mixed tabs / spaces — normalise tabs to 2-space indent.
 *
 * Body preservation: the helpers split on `---\n` and reattach body bytes
 * verbatim. Returns `true` iff the file on disk was successfully repaired
 * (i.e. a fix was applied AND the result parses). Returns `false` when:
 *   - the file has no frontmatter at all (out of scope here);
 *   - the mechanical layer can't produce a parseable result;
 *   - an I/O error occurs (logged, non-fatal).
 *
 * See docs/plans/260411_shared_space_maintenance.md (Stage 3).
 */
export const attemptMechanicalFrontmatterRepairOnDisk = async (
  spacePath: string,
): Promise<boolean> => {
  const readmePath = path.join(spacePath, README_MD);
  const legacyPath = path.join(spacePath, LEGACY_AGENTS_MD);

  // Read raw bytes — the atomic helper needs the exact original buffer
  // so it can roll back byte-for-byte if the post-rename re-validate
  // fails (S3-F6). `fs.readFile` with no encoding returns a Buffer.
  let filePath = readmePath;
  let originalBytes: Buffer;
  // S4.1f: bounded CAS pre-read. A `reconnecting` README read → `return false` IMMEDIATELY
  // (NO write, NO AGENTS.md fallback): review F3 — if README reconnects but the legacy file
  // happens to read and needs repair, falling through would `atomicWriteWithReValidate` a
  // file on a degraded space. A genuine (non-reconnecting) README failure keeps the legacy
  // fallback; a reconnecting legacy read also `return false`.
  try {
    originalBytes = await boundedReadFileBytes(readmePath);
  } catch (readmeErr) {
    if (isSpaceFsReconnecting(readmeErr)) {
      return false;
    }
    try {
      originalBytes = await boundedReadFileBytes(legacyPath);
      filePath = legacyPath;
    } catch {
      return false;
    }
  }
  const content = originalBytes.toString('utf8');

  let repair;
  try {
    repair = tryMechanicalFrontmatterRepair(content);
  } catch (err) {
    logger.warn(
      { spacePath, error: err instanceof Error ? err.message : String(err) },
      'mechanical frontmatter repair threw unexpectedly — skipping',
    );
    return false;
  }

  if (repair.rejectionReason) {
    // S3-F1: a safety guard (fidelity or body-plausibility) rejected the
    // candidate. The file on disk is unchanged; surface the reason so
    // downstream logs explain WHY the auto-fix didn't apply.
    logger.warn(
      {
        spacePath,
        rejectionReason: repair.rejectionReason,
        rejectionDetail: repair.rejectionDetail,
      },
      'mechanical frontmatter repair rejected by safety guard',
    );
    return false;
  }

  if (!repair.repaired || repair.newContent === content) {
    return false;
  }

  const workspaceRoot = resolveWorkspaceRootForSpaceWrite(spacePath);
  await assertSpaceWriteSafeForWrite(workspaceRoot, spacePath);

  // S3-F2: atomic tmp + fsync + rename + re-parse. A crash mid-write
  // leaves the original bytes on disk. Without this, a truncated README
  // could silently hide a space from the UI on next scan.
  const writeErrors: string[] = [];
  const writeOk = await atomicWriteWithReValidate(filePath, originalBytes, repair.newContent, {
    onError: (msg) => writeErrors.push(msg),
  });

  if (!writeOk) {
    logger.warn(
      { spacePath, filePath, errors: writeErrors },
      'Failed to write mechanical frontmatter repair (original preserved)',
    );
    return false;
  }

  logger.info(
    { spacePath, appliedFixes: repair.appliedFixes },
    'Mechanically repaired malformed space frontmatter',
  );
  return true;
};

/** Parse warning for a space path */
export interface SpaceParseWarning {
  path: string;
  message: string;
}

/**
 * Scan a directory for README.md files with parse issues (malformed YAML frontmatter).
 * This is used to detect and report spaces that won't appear because of YAML errors.
 */
export const scanForFrontmatterWarnings = async (
  workspacePath: string
): Promise<SpaceParseWarning[]> => {
  const warnings: SpaceParseWarning[] = [];
  if (!workspacePath) return warnings;
  
  const root = path.resolve(workspacePath);
  
  // Check common space locations for README.md files with parse issues
  const pathsToCheck: string[] = [];
  
  // Scan root for potential spaces. S4.1f: bounded ENUM/READ — this is a read-only
  // warning scan; a reconnecting/error read degrades to "can't read" (no warning), same
  // as today's catch. WorkspaceDirent booleans are PROPERTIES (no `()`).
  try {
    const rootContents = await boundedReaddirWithFileTypes(root);
    for (const entry of rootContents) {
      if (entry.isDirectory || entry.isSymbolicLink) {
        pathsToCheck.push(path.join(root, entry.name));
      }
    }
  } catch {
    // Can't read root (missing / reconnecting / error)
  }

  // Scan work/ subdirectories
  const workDir = path.join(root, 'work');
  try {
    const workContents = await boundedReaddirWithFileTypes(workDir);
    for (const company of workContents) {
      if (company.isDirectory || company.isSymbolicLink) {
        const companyPath = path.join(workDir, company.name);
        pathsToCheck.push(companyPath);

        // Also check subdirs of company
        try {
          const companyContents = await boundedReaddirWithFileTypes(companyPath);
          for (const subdir of companyContents) {
            if (subdir.isDirectory || subdir.isSymbolicLink) {
              pathsToCheck.push(path.join(companyPath, subdir.name));
            }
          }
        } catch {
          // Can't read company dir (missing / reconnecting / error)
        }
      }
    }
  } catch {
    // No work dir (missing / reconnecting / error)
  }

  // Check each path for README.md with parse issues
  for (const checkPath of pathsToCheck) {
    const readmePath = path.join(checkPath, README_MD);
    try {
      const content = await boundedReadFileUtf8(readmePath);
      // Try to parse frontmatter
      try {
        fm(content);
        // Parse succeeded - no warning needed
      } catch (parseErr) {
        // Parse failed - this README has issues
        const relativePath = path.relative(root, checkPath);
        const errorMsg = parseErr instanceof Error ? parseErr.message : String(parseErr);
        warnings.push({
          path: relativePath || checkPath,
          message: `README.md has malformed YAML frontmatter: ${errorMsg}`,
        });
      }
    } catch {
      // No README.md - not an issue
    }
  }
  
  return warnings;
};

/**
 * Serialize frontmatter attributes to YAML string.
 * Simple implementation that handles our specific field types.
 */
/**
 * Quote a YAML string value if it contains special characters.
 * YAML 1.1 (used by js-yaml/front-matter) has reserved indicators that need quoting:
 * - `*` at start = alias reference
 * - `@` at start = reserved indicator (causes parse error)
 * - `:`, `#`, newlines = special syntax
 * 
 * Note: Email wildcards are stored as bare domains (e.g., "acme.com" not "@acme.com")
 * so they don't require quoting. The * and @ checks remain as safety for any legacy data.
 */
const quoteYamlValue = (value: string): string => {
  // Quote strings with YAML special characters or reserved indicators
  if (value.startsWith('*') || value.startsWith('@') || value.includes('\n') || value.includes(':') || value.includes('#')) {
    return `"${value.replace(/"/g, '\\"')}"`;
  }
  return value;
};

const serializeFrontmatter = (attrs: Record<string, unknown>): string => {
  const lines: string[] = [];
  for (const [key, value] of Object.entries(attrs)) {
    if (value === undefined || value === null) continue;
    if (typeof value === 'string') {
      lines.push(`${key}: ${quoteYamlValue(value)}`);
    } else if (Array.isArray(value)) {
      lines.push(`${key}:`);
      for (const item of value) {
        // Quote array items that need it (legacy values might need quoting)
        const itemStr = typeof item === 'string' ? quoteYamlValue(item) : String(item);
        lines.push(`  - ${itemStr}`);
      }
    } else if (typeof value === 'boolean' || typeof value === 'number') {
      lines.push(`${key}: ${value}`);
    }
  }
  return lines.join('\n');
};

/**
 * List of frontmatter field names that are space-related (our fields).
 * When merging, our values take precedence for these fields.
 */
const SPACE_FRONTMATTER_FIELDS = [
  'rebel_space_description',
  'display_name',
  'organisation_name',
  'space_type',
  'sharing',
  'sensitivity',
  'memoryTrust',
  'related_spaces',
  'owner',
  'emails',
] as const;

/**
 * Merge frontmatter with existing README.md content safely.
 * 
 * This function is designed to safely integrate Rebel space frontmatter into
 * README.md files that may already exist (e.g., when connecting external folders
 * from cloud storage).
 * 
 * @param existingContent - The existing README.md content (null if file doesn't exist)
 * @param frontmatter - The SpaceFrontmatter to merge
 * @returns The merged README.md content
 * 
 * Behavior:
 * - If existingContent is null: Creates new README with frontmatter only
 * - If existingContent has NO frontmatter: Prepends our frontmatter block
 * - If existingContent HAS frontmatter: Merges fields (our space fields take precedence,
 *   user's custom fields are preserved), keeps body intact
 * - If frontmatter parsing fails (malformed YAML): Falls back to prepending behavior
 * 
 * Note: serializeFrontmatter only handles primitives (string, number, boolean) and
 * string arrays. Complex user frontmatter types (nested objects, dates) may be
 * lost during merge. This is acceptable for space READMEs which use simple types.
 */
export const mergeReadmeWithFrontmatter = (
  existingContent: string | null,
  frontmatter: SpaceFrontmatter
): string => {
  // Case 1: No existing content - create fresh README
  if (existingContent === null) {
    const serialized = serializeFrontmatter(frontmatter as Record<string, unknown>);
    return `---\n${serialized}\n---\n`;
  }

  // Try to parse existing content for frontmatter
  // If parsing fails (malformed YAML), fall back to prepending behavior
  let parsed: { attributes: Record<string, unknown>; body: string };
  try {
    parsed = fm<Record<string, unknown>>(existingContent);
  } catch {
    // Malformed frontmatter - treat as no frontmatter and prepend
    const serialized = serializeFrontmatter(frontmatter as Record<string, unknown>);
    return `---\n${serialized}\n---\n\n${existingContent}`;
  }

  const hasExistingFrontmatter = parsed.attributes && 
    typeof parsed.attributes === 'object' && 
    Object.keys(parsed.attributes).length > 0;

  // Case 2: Existing content has NO frontmatter - prepend our frontmatter block
  if (!hasExistingFrontmatter) {
    const serialized = serializeFrontmatter(frontmatter as Record<string, unknown>);
    // Preserve the entire existing content as the body
    return `---\n${serialized}\n---\n\n${existingContent}`;
  }

  // Case 3: Existing content HAS frontmatter - merge fields
  const existingAttrs = parsed.attributes;
  const mergedAttrs: Record<string, unknown> = { ...existingAttrs };

  // Our space-related fields take precedence
  for (const field of SPACE_FRONTMATTER_FIELDS) {
    const value = frontmatter[field];
    if (value !== undefined) {
      mergedAttrs[field] = value;
    }
  }

  // Serialize merged frontmatter
  const serialized = serializeFrontmatter(mergedAttrs);

  // Reconstruct the document preserving the body
  // parsed.body includes leading newline from original frontmatter block, so we handle that
  const body = parsed.body;
  return `---\n${serialized}\n---\n${body}`;
};

/**
 * Update frontmatter fields in a space's README.md.
 * Preserves existing frontmatter fields and body content.
 */
export const updateSpaceFrontmatter = async (
  spacePath: string,
  updates: Partial<SpaceFrontmatter>,
  options?: UpdateSpaceFrontmatterOptions,
): Promise<{ success: boolean; error?: string }> => {
  const readmePath = path.join(spacePath, README_MD);
  const workspaceRoot = resolveWorkspaceRootForSpaceWrite(spacePath, options);

  try {
    await assertSpaceWriteSafeForWrite(workspaceRoot, spacePath, options?.writeSafetyOptions);

    // Read existing content. S4.1f: bounded CAS pre-read — a `reconnecting` cloud mount
    // must NOT be read as "file doesn't exist → create", which would overwrite an
    // unreachable existing README (data loss). Fail closed on reconnecting.
    let content: string;
    let originalBytes: Buffer;
    try {
      originalBytes = await boundedReadFileBytes(readmePath);
      content = originalBytes.toString('utf-8');
    } catch (readErr) {
      if (isSpaceFsReconnecting(readErr)) {
        return { success: false, error: 'This space is reconnecting — try again in a moment.' };
      }
      // File doesn't exist, create with just the updates
      const frontmatter = serializeFrontmatter(updates as Record<string, unknown>);
      const newContent = `---\n${frontmatter}\n---\n\n# ${path.basename(spacePath)}\n`;
      const writeErrors: string[] = [];
      const atomicOptions: Parameters<typeof atomicWriteWithReValidate>[3] = {
        onError: (message) => writeErrors.push(message),
      };
      if (options?.atomicWriteFs) {
        atomicOptions.fs = options.atomicWriteFs;
      }
      const writeOk = await atomicWriteWithReValidate(readmePath, Buffer.alloc(0), newContent, atomicOptions);
      if (!writeOk) {
        const error = writeErrors.join('; ') || 'Atomic README write failed';
        logger.warn({ spacePath, readmePath, errors: writeErrors }, 'Failed atomic frontmatter write');
        return { success: false, error };
      }
      await assertSpaceWriteSafeForWrite(workspaceRoot, spacePath, options?.writeSafetyOptions);
      return { success: true };
    }

    // Parse existing frontmatter
    const parsed = fm<Record<string, unknown>>(content);
    const existingAttrs = parsed.attributes || {};

    // Merge updates (remove undefined values from updates)
    const mergedAttrs = { ...existingAttrs };
    for (const [key, value] of Object.entries(updates)) {
      if (value === undefined) {
        delete mergedAttrs[key];
      } else {
        mergedAttrs[key] = value;
      }
    }

    // Serialize back
    const newFrontmatter = serializeFrontmatter(mergedAttrs);
    const newContent = `---\n${newFrontmatter}\n---\n${parsed.body}`;

    const writeErrors: string[] = [];
    const atomicOptions: Parameters<typeof atomicWriteWithReValidate>[3] = {
      onError: (message) => writeErrors.push(message),
    };
    if (options?.atomicWriteFs) {
      atomicOptions.fs = options.atomicWriteFs;
    }
    const writeOk = await atomicWriteWithReValidate(readmePath, originalBytes, newContent, atomicOptions);
    if (!writeOk) {
      const error = writeErrors.join('; ') || 'Atomic README write failed';
      logger.warn({ spacePath, readmePath, errors: writeErrors }, 'Failed atomic frontmatter write');
      return { success: false, error };
    }
    await assertSpaceWriteSafeForWrite(workspaceRoot, spacePath, options?.writeSafetyOptions);
    logger.info({ updates }, `Updated frontmatter for space: ${spacePath}`);
    return { success: true };
  } catch (err) {
    if (err instanceof WriteOutsideWorkspaceError) {
      throw err;
    }
    const errorMsg = err instanceof Error ? err.message : 'Unknown error';
    logger.error({ spacePath, updates }, `Failed to update frontmatter: ${errorMsg}`);
    return { success: false, error: errorMsg };
  }
};

/**
 * Check if a space has a config file (README.md or legacy AGENTS.md).
 * Returns true if either exists.
 */
export const hasSpaceConfigFile = async (spacePath: string): Promise<boolean> => {
  const readmePath = path.join(spacePath, README_MD);
  const legacyPath = path.join(spacePath, LEGACY_AGENTS_MD);

  // S4.1f: bounded existence probes. A `reconnecting` cloud mount must NOT be mapped to
  // `false` (= "no config file") — the sole caller (`ensureChiefOfStaffSpace`) treats
  // `false` as "create the README", which would overwrite an unreachable existing one
  // (data loss). Re-throw reconnecting so the caller fails closed; a real fs error
  // (ENOENT/EACCES) still maps to `false` exactly as today.
  try {
    await boundedAccess(readmePath);
    return true;
  } catch (readmeErr) {
    if (isSpaceFsReconnecting(readmeErr)) throw readmeErr;
    try {
      await boundedAccess(legacyPath);
      return true;
    } catch (legacyErr) {
      if (isSpaceFsReconnecting(legacyErr)) throw legacyErr;
      return false;
    }
  }
};

/**
 * Result of checking config file state for a space.
 */
export interface ConfigFileState {
  /** Whether any config file exists (README.md or AGENTS.md) */
  hasConfigFile: boolean;
  /** Whether README.md exists */
  hasReadme: boolean;
  /** Whether legacy AGENTS.md exists (but no README.md) */
  hasLegacyAgentsMd: boolean;
  /** Whether BOTH README.md and AGENTS.md exist (needs manual resolution) */
  hasBothConfigFiles: boolean;
  /**
   * True iff a config-file probe hit a `reconnecting` cloud mount. DISTINCT from
   * "no config file": the scan lane must RETAIN such a space + mark it degraded, not
   * treat it as a plain folder (which `continue`s the candidate → drop, Inv 3 / GPT
   * F1). Omitted on the local/healthy fast path → byte-identical for non-cloud callers.
   */
  reconnecting?: boolean;
}

/**
 * Check the config file state for a space.
 * Detects README.md, legacy AGENTS.md, and the case where both exist.
 *
 * S4.1e: probes route through the bounded `workspaceFs` boundary. A `reconnecting`
 * cloud mount is PROPAGATED (`reconnecting: true`) so the scan lane retains+degrades
 * the space rather than mis-reading the dead mount as "no config file" (GPT F1).
 */
export const getConfigFileState = async (spacePath: string): Promise<ConfigFileState> => {
  const readmePath = path.join(spacePath, README_MD);
  const legacyPath = path.join(spacePath, LEGACY_AGENTS_MD);

  const readme = await workspaceFs.access(readmePath, undefined, cloudReadOption(readmePath));
  if (readme.status === 'reconnecting') {
    return { hasConfigFile: false, hasReadme: false, hasLegacyAgentsMd: false, hasBothConfigFiles: false, reconnecting: true };
  }
  const hasReadme = readme.status === 'ok';

  const legacy = await workspaceFs.access(legacyPath, undefined, cloudReadOption(legacyPath));
  if (legacy.status === 'reconnecting') {
    return { hasConfigFile: false, hasReadme: false, hasLegacyAgentsMd: false, hasBothConfigFiles: false, reconnecting: true };
  }
  const hasAgentsMd = legacy.status === 'ok';

  return {
    hasConfigFile: hasReadme || hasAgentsMd,
    hasReadme,
    hasLegacyAgentsMd: hasAgentsMd && !hasReadme,
    hasBothConfigFiles: hasReadme && hasAgentsMd,
  };
};

/**
 * Check if a path is a symlink.
 *
 * S4.1e: bounded `lstat`. Best-effort boolean — a `reconnecting`/`error` outcome →
 * `false` (as before). The symlink bit only affects per-space heuristics, not
 * retention: a reconnecting space is retained+degraded via the retention-critical
 * `stat`/`getConfigFileState` reads in `_scanSpacesImpl` (DA Q4 policy #3).
 */
export const isSymlink = async (targetPath: string): Promise<boolean> => {
  const outcome = await workspaceFs.lstat(targetPath, cloudReadOption(targetPath));
  return outcome.status === 'ok' && outcome.value.isSymbolicLink;
};

/**
 * Get symlink target if path is a symlink.
 *
 * S4.1e: bounded `lstat` + `readlink`. Best-effort — a `reconnecting`/`error`
 * outcome → `undefined` (as before).
 */
export const getSymlinkTarget = async (targetPath: string): Promise<string | undefined> => {
  const opt = cloudReadOption(targetPath);
  const statOutcome = await workspaceFs.lstat(targetPath, opt);
  if (statOutcome.status !== 'ok' || !statOutcome.value.isSymbolicLink) {
    return undefined;
  }
  const linkOutcome = await workspaceFs.readlink(targetPath, opt);
  return linkOutcome.status === 'ok' ? linkOutcome.value : undefined;
};

/**
 * Infer space type from path structure.
 * Case-insensitive matching for known space names.
 */
export const inferSpaceType = (relativePath: string): SpaceType => {
  const normalized = toPortablePath(relativePath);
  const normalizedLower = normalized.toLowerCase();

  if (normalizedLower === 'chief-of-staff' || normalizedLower === 'chief-of-staff/') {
    return 'chief-of-staff';
  }

  if (normalizedLower === 'personal' || normalizedLower === 'personal/') {
    return 'personal';
  }

  if (normalizedLower.startsWith('work/')) {
    // work/[Company]/[Space] - could be company or team
    const parts = normalized.split('/').filter(Boolean);
    if (parts.length >= 3) {
      return 'team'; // Default to team for specific spaces
    }
    return 'company';
  }

  return 'other';
};

/** Options for scanning spaces */
export interface ScanSpacesOptions {
  /** 
   * Skip auto-fix attempts (like adding description to frontmatter).
   * Use for read-only checks like health checks.
   */
  skipAutoFix?: boolean;
}

/**
 * Check whether a space directory is writable via a W_OK access probe.
 *
 * S4.1e: routed through the bounded `workspaceFs.access(path, W_OK)` boundary
 * (`mode`-aware op). The boundary's cloud lane kills + reclaims a wedged child and
 * resolves `reconnecting`, subsuming the bespoke `withAccessTimeout` race this used
 * to do — a dead cloud mount degrades to `undefined` ("unknown") instead of hanging.
 * The cloud-aware `getTimeoutForPath` budget is passed as the boundary's caller-facing
 * backstop. A real permission error (EACCES/EPERM/EROFS) → `false` as before.
 *
 * @param spacePath - The actual path to check write access on
 * @param cloudHintPath - Optional path used for cloud-aware timeout detection (e.g., symlink source path)
 * @returns true if writable, false if read-only (EACCES/EPERM/EROFS), undefined if unknown (reconnecting/other error)
 */
async function checkSpaceWritable(spacePath: string, cloudHintPath?: string): Promise<boolean | undefined> {
  const timeoutMs = getTimeoutForPath(cloudHintPath ?? spacePath);
  const outcome = await workspaceFs.access(spacePath, fsSync.constants.W_OK, {
    ...cloudLaneOptionForPath(cloudHintPath ?? spacePath),
    timeoutMs,
  });
  if (outcome.status === 'ok') {
    return true;
  }
  if (outcome.status === 'error') {
    const code = outcome.error?.code;
    if (code === 'EACCES' || code === 'EPERM' || code === 'EROFS') return false;
    return undefined; // other fs error — unknown
  }
  return undefined; // reconnecting — unknown
}

/**
 * Build a degraded-but-RETAINED {@link SpaceInfo} for a candidate whose scan reads hit
 * a `reconnecting` cloud mount (Inv 3 / F5). The space is NEVER dropped — we retain its
 * identity (name, relative + absolute path, inferred type) with `status:
 * 'needs_attention'` and `syncStatus: 'reconnecting'`, and best-effort last-known
 * fields (symlink/source) when those reads succeeded before the mount went dark. A
 * COLD scan of a first-time reconnecting space has no last-known frontmatter — that is
 * fine: retention is the invariant, populated fields are best-effort.
 *
 * Single shared builder so the root-level, work/company, dedupe, and final candidate
 * loops degrade consistently (DA Q4 reducer / F5).
 */
function buildDegradedSpace(params: {
  name: string;
  candidate: string;
  spacePath: string;
  isSymlink?: boolean;
  sourcePath?: string;
}): SpaceInfo {
  return {
    name: params.name,
    path: params.candidate,
    absolutePath: params.spacePath,
    type: inferSpaceType(params.candidate),
    isSymlink: params.isSymlink ?? false,
    hasReadme: false,
    sourcePath: params.sourcePath,
    writable: undefined, // unknowable while the mount is reconnecting
    status: 'needs_attention',
    statusMessage: 'This space is reconnecting — try again in a moment.',
    syncStatus: 'reconnecting',
  };
}

/**
 * Scan workspace for all spaces (folders with README.md containing rebel_space_description).
 */
const runScanSpacesReadOnlyUncached = async (workspacePath: string): Promise<SpaceInfo[]> => {
  scanSpacesReadOnlyCounter.recordUnderlyingFetchStart();
  try {
    return await _scanSpacesImpl(workspacePath, { skipAutoFix: true });
  } finally {
    scanSpacesReadOnlyCounter.recordUnderlyingFetchEnd();
  }
};

/**
 * Read-only scan lane (`skipAutoFix: true`) wrapped in a workspace-keyed coalesced cache.
 * This lane must stay side-effect free.
 */
export const scanSpacesReadOnly = async (workspacePath: string): Promise<SpaceInfo[]> => {
  scanSpacesReadOnlyCounter.recordRequest();

  // Kill switch: disable coalescing and fall back to uncached read-only scans.
  if (isSpaceCoalesceDisabled()) {
    scanSpacesReadOnlyCounter.recordMiss();
    try {
      return await runScanSpacesReadOnlyUncached(workspacePath);
    } catch (err) {
      scanSpacesReadOnlyCounter.recordFetchError();
      throw err;
    }
  }

  const key = getSpaceScanCacheKey(workspacePath);
  return scanSpacesReadOnlyCache.get(key, async () => runScanSpacesReadOnlyUncached(workspacePath));
};

/**
 * Scan workspace for all spaces (folders with README.md containing rebel_space_description).
 */
export const scanSpacesWithSideEffects = async (
  workspacePath: string,
  options?: Omit<ScanSpacesOptions, 'skipAutoFix'>,
): Promise<SpaceInfo[]> => {
  // Writable lane (default): retains the pre-Stage-5 behavior and is NEVER
  // coalesced because it may auto-fix frontmatter on disk.
  const counter = scanSpacesWritableCounter;
  counter.recordRequest();
  counter.recordUnderlyingFetchStart();

  try {
    return await _scanSpacesImpl(workspacePath, options);
  } catch (err) {
    counter.recordFetchError();
    throw err;
  } finally {
    counter.recordUnderlyingFetchEnd();
  }
};

/**
 * @deprecated Use `scanSpacesReadOnly` for read-only scans or
 * `scanSpacesWithSideEffects` for writable scans.
 */
export const scanSpaces = async (workspacePath: string, options?: ScanSpacesOptions): Promise<SpaceInfo[]> => {
  if (options?.skipAutoFix === true) {
    return scanSpacesReadOnly(workspacePath);
  }
  return scanSpacesWithSideEffects(workspacePath);
};

function toSpaceScanAccessError(
  scanPath: string,
  operation: SpaceScanAccessOperation,
  error: unknown,
): SpaceScanAccessError {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return new SpaceScanAccessError({
    path: scanPath,
    operation,
    code: typeof code === 'string' ? code : undefined,
  });
}

/** Real scan implementation. Extracted so the counter wrapper stays tiny. */
async function _scanSpacesImpl(
  workspacePath: string,
  options?: ScanSpacesOptions,
): Promise<SpaceInfo[]> {
  const spaces: SpaceInfo[] = [];

  // Normalise and short-circuit on empty/whitespace-only workspace paths. The
  // read-only cache keys both '' and '   ' to the same `<no-workspace>` sentinel;
  // without this trim, '   ' would slip through, path.resolve it against cwd,
  // hit the workspace-not-found branch, and cache an identical `[]` via a more
  // expensive path. Keeping the short-circuit aligned with the cache key avoids
  // the divergence and the spurious fs.access call.
  const trimmedWorkspacePath = workspacePath?.trim?.() ?? '';
  if (!trimmedWorkspacePath) {
    logger.warn('scanSpaces called with empty workspacePath');
    return spaces;
  }

  const root = path.resolve(trimmedWorkspacePath);

  // Whether the workspace root is itself cloud-classified (cloud-inside-cloud, e.g. a
  // Dropbox root holding Google-Drive symlinks). Pure-string match, no fs touch. Used
  // to make `resolveSpaceSyncStatus` cloud-root-safe: under a cloud root a readlink on
  // a symlinked space's inode could block on a dead FUSE mount, so it derives the
  // verdict key zero-I/O from the cached `sourcePath` instead.
  const rootIsCloud = detectCloudStorage(root).isCloud;

  // Check if workspace exists. A `reconnecting` ROOT is NOT "missing" — surface a typed
  // scan-unavailable error (Inv 4) so a consumer never reads a spurious `[]` as
  // "no spaces". A real fs error (ENOENT) → `[]` (missing root), exactly as before.
  // Per-path cloud option (F1): a pattern-cloud root forces the cloud lane.
  const rootAccess = await workspaceFs.access(root, undefined, cloudReadOption(root));
  if (rootAccess.status === 'reconnecting') {
    throw new SpaceScanAccessError({ path: root, operation: 'workspace-root-readdir', reconnecting: true });
  }
  if (rootAccess.status === 'error') {
    logger.warn({ root }, 'Workspace path does not exist');
    return spaces;
  }

  // Dynamically find known space locations (case-insensitive)
  const spaceCandidates: string[] = [];
  let rootContents: WorkspaceDirent[];
  {
    const rootReaddir = await workspaceFs.readdirWithFileTypes(root, cloudReadOption(root));
    if (rootReaddir.status === 'reconnecting') {
      throw new SpaceScanAccessError({ path: root, operation: 'workspace-root-readdir', reconnecting: true });
    }
    if (rootReaddir.status === 'error') {
      throw toSpaceScanAccessError(root, 'workspace-root-readdir', rootReaddir.error);
    }
    rootContents = rootReaddir.value;
  }

  // Scan root for Chief-of-Staff and Personal (case-insensitive). NOTE: WorkspaceDirent
  // booleans are PROPERTIES (`isDirectory`/`isSymbolicLink`), not methods (GPT F3).
  for (const entry of rootContents) {
    if (entry.isDirectory || entry.isSymbolicLink) {
      const nameLower = entry.name.toLowerCase();
      if (nameLower === 'chief-of-staff' || nameLower === 'personal') {
        spaceCandidates.push(entry.name);
      }
    }
  }

  // Also treat "space-like" root folders as candidates.
  // This supports setups with spaces like `General/` living at the workspace root.
  //
  // Heuristic: must have a config file (README.md or AGENTS.md) AND either:
  // - valid rebel_space_description frontmatter, OR
  // - a YAML parse error (needs repair), OR
  // - space structure folders (memory/skills/etc.) indicating it's intended as a space.
  const rootSpaceExclusions = new Set([
    'node_modules',
    'src',
    'docs',
    'resources',
    'scripts',
    'tests',
    'config',
    'skills', // workspace-root skills are handled separately
    'work', // handled by dedicated work/ scanning below
    'personal',
    'chief-of-staff',
  ]);

  for (const entry of rootContents) {
    if (!entry.isDirectory && !entry.isSymbolicLink) continue;
    if (entry.name.startsWith('.')) continue;

    const nameLower = entry.name.toLowerCase();
    if (isProtectedRootName(entry.name) || rootSpaceExclusions.has(nameLower)) continue;

    const candidatePath = path.join(root, entry.name);
    try {
      const configFileState = await getConfigFileState(candidatePath);
      // RECONNECTING (Inv 3): a dead-mount config probe is NOT "no config file".
      // Push the candidate so the final loop materialises it as a degraded-but-
      // RETAINED space — never silently drop a healthy-but-reconnecting cloud space.
      if (configFileState.reconnecting) {
        spaceCandidates.push(entry.name);
        continue;
      }
      if (!configFileState.hasConfigFile) continue;

      const readResult = await readSpaceFrontmatterWithError(candidatePath);
      if (readResult.reconnecting) {
        spaceCandidates.push(entry.name);
        continue;
      }
      const hasDescription = Boolean(readResult.frontmatter?.rebel_space_description?.trim());
      const hasParseError = Boolean(readResult.parseError);
      const structure = await checkForSpaceStructure(candidatePath);
      // RECONNECTING (Inv 3 / review F2): a dead-mount structure probe must NOT drop the
      // candidate — enqueue it so the retention loop materialises it degraded-but-retained.
      if (structure === 'reconnecting') {
        spaceCandidates.push(entry.name);
        continue;
      }

      if (hasDescription || hasParseError || structure) {
        spaceCandidates.push(entry.name);
      }
    } catch (error) {
      logger.warn({ err: error, candidatePath }, 'Skipping inaccessible root-level space candidate');
    }
  }

  // Scan work/ directory for company spaces. Per-path cloud option (F1): `work/` (and
  // each company below) derives its own option, so a pattern-cloud descendant routes
  // the bounded cloud lane even when the dir is not a configured containment space.
  const workDir = path.join(root, 'work');
  let workContents: WorkspaceDirent[] = [];
  {
    const workReaddir = await workspaceFs.readdirWithFileTypes(workDir, cloudReadOption(workDir));
    if (workReaddir.status === 'reconnecting') {
      // A reconnecting work/ root would hide configured company spaces if degraded to
      // `[]`; surface scan-unavailable instead (Inv 4, same class as the root).
      throw new SpaceScanAccessError({ path: workDir, operation: 'workspace-work-readdir', reconnecting: true });
    }
    if (workReaddir.status === 'error') {
      const code = workReaddir.error?.code;
      if (code !== 'ENOENT') {
        throw toSpaceScanAccessError(workDir, 'workspace-work-readdir', workReaddir.error);
      }
      // ENOENT → no work/ directory → leave workContents empty (as before).
    } else {
      workContents = workReaddir.value;
    }
  }
  for (const company of workContents) {
    if (company.isDirectory || company.isSymbolicLink) {
      const companyPath = path.join(workDir, company.name);
      try {
        // Check if it's a symlink that resolves to a directory
        const statRead = toScanRead(await workspaceFs.stat(companyPath, cloudReadOption(companyPath)));
        // RECONNECTING (Inv 3): a dead-mount company is NOT absent — retain it as a
        // candidate so the final loop materialises it degraded-but-retained.
        if (statRead.kind === 'reconnecting') {
          spaceCandidates.push(`work/${company.name}`);
          continue;
        }
        if (statRead.kind === 'error') {
          throw statRead.error; // preserve today's drop-on-fs-error (logged below)
        }
        const stat = statRead.value;
        if (stat.isDirectory) {
          // Check if the company directory itself is a space candidate
          // A directory is a space candidate if it has a config file (README.md or AGENTS.md)
          // with either valid frontmatter OR a parse error (needs_attention)
          const companyConfigState = await getConfigFileState(companyPath);
          if (companyConfigState.reconnecting) {
            spaceCandidates.push(`work/${company.name}`);
            continue;
          }
          if (companyConfigState.hasConfigFile) {
            const companyResult = await readSpaceFrontmatterWithError(companyPath);
            if (companyResult.reconnecting) {
              spaceCandidates.push(`work/${company.name}`);
              continue;
            }
            // Treat as space if: has description OR has parse error (needs repair)
            if (companyResult.frontmatter?.rebel_space_description || companyResult.parseError) {
              // Company directory is itself a space - add it and skip descending into children
              // This prevents work/AcmeConsulting/memory, work/AcmeConsulting/skills, etc. from being treated as spaces
              spaceCandidates.push(`work/${company.name}`);
            } else {
              // Has config file but no description and no parse error - might be container or needs auto-fix
              // Check if it has space structure (memory/skills folders) to distinguish
              const companyStructure = await checkForSpaceStructure(companyPath);
              // RECONNECTING (review F2): a dead-mount structure probe must NOT drop the
              // company — retain it as a candidate (degraded-but-retained downstream).
              if (companyStructure === 'reconnecting' || companyStructure) {
                // Looks like a space (or unknowable mount) that just needs description auto-fix
                spaceCandidates.push(`work/${company.name}`);
              } else {
                // Likely a container with plain README - check children
                const companyContents = toScanRead(await workspaceFs.readdirWithFileTypes(companyPath, cloudReadOption(companyPath)));
                if (companyContents.kind === 'reconnecting') {
                  // Reconnecting container — retain the company itself rather than
                  // dropping its (unenumerable) children.
                  spaceCandidates.push(`work/${company.name}`);
                  continue;
                }
                if (companyContents.kind === 'error') {
                  throw companyContents.error;
                }
                for (const space of companyContents.value) {
                  if (space.isDirectory || space.isSymbolicLink) {
                    spaceCandidates.push(`work/${company.name}/${space.name}`);
                  }
                }
              }
            }
          } else {
            // No config file - treat as container
            const companyContents = toScanRead(await workspaceFs.readdirWithFileTypes(companyPath, cloudReadOption(companyPath)));
            if (companyContents.kind === 'reconnecting') {
              spaceCandidates.push(`work/${company.name}`);
              continue;
            }
            if (companyContents.kind === 'error') {
              throw companyContents.error;
            }
            for (const space of companyContents.value) {
              if (space.isDirectory || space.isSymbolicLink) {
                spaceCandidates.push(`work/${company.name}/${space.name}`);
              }
            }
          }
        }
      } catch (error) {
        logger.warn({ err: error, companyPath }, 'Skipping inaccessible work/ company while scanning spaces');
      }
    }
  }

  // Track whether any writable-lane auto-fix actually mutated disk so we can
  // invalidate the read-only scan cache exactly once after the loop finishes
  // instead of paying the Map.delete + generation-bump overhead per space.
  // See docs/plans/260420_perf_observability_and_low_risk_wins.md (F14/F15).
  let anyAutoFixApplied = false;

  // REBEL-506 defence-in-depth: drop candidates whose canonical path resolves
  // to one we've already enumerated. This catches the self-recursion class
  // (a space symlinked or copied back into itself, such that scanning
  // surfaces both `Chief-of-Staff` and `work/Acme/Chief-of-Staff` pointing
  // to the same realpath). Without this, downstream walkers traverse the
  // same tree twice and can blow up on ENAMETOOLONG. The shared
  // safeWalkDirectory utility handles cycles inside a single walk; this
  // handles cycles BETWEEN candidates surfaced by scanSpaces.
  const seenCanonicalPaths = new Set<string>();
  const deduplicatedCandidates: string[] = [];
  for (const candidate of spaceCandidates) {
    const candidateAbsPath = path.join(root, candidate);
    const canonicalRead = toScanRead(await workspaceFs.realpath(candidateAbsPath, cloudReadOption(candidateAbsPath)));
    if (canonicalRead.kind !== 'value') {
      // Inaccessible / broken symlink (error) OR a reconnecting cloud mount — let the
      // existing per-candidate handling below classify/retain it. Don't drop here, and
      // don't dedup (a reconnecting realpath can't be compared — keeping it is safe).
      deduplicatedCandidates.push(candidate);
      continue;
    }
    const canonical = canonicalRead.value;
    if (seenCanonicalPaths.has(canonical)) {
      logger.warn(
        { candidate, canonical },
        'scanSpaces: dropping duplicate space candidate (same realpath)',
      );
      continue;
    }
    seenCanonicalPaths.add(canonical);
    deduplicatedCandidates.push(candidate);
  }

  // Check each candidate for README.md (or legacy AGENTS.md) with frontmatter
  for (const candidate of deduplicatedCandidates) {
    const spacePath = path.join(root, candidate);

    // Get space name from path (needed for the degraded-retain path too).
    const pathParts = candidate.split('/').filter(Boolean);
    const name = pathParts[pathParts.length - 1];

    try {
      // RETENTION-CRITICAL reads (Inv 3): a `reconnecting` outcome must NOT drop the
      // candidate — build a degraded-but-RETAINED SpaceInfo and `push` it. Reconnecting
      // is a returned discriminant, never thrown, so it can never reach the broad catch
      // below (which DROPS). A real fs `error` re-throws into that catch (today's drop).
      const statRead = toScanRead(await workspaceFs.stat(spacePath, cloudReadOption(spacePath)));
      if (statRead.kind === 'reconnecting') {
        spaces.push(buildDegradedSpace({ name, candidate, spacePath }));
        continue;
      }
      if (statRead.kind === 'error') {
        throw statRead.error;
      }
      if (!statRead.value.isDirectory) {
        continue;
      }

      const symlinkCheck = await isSymlink(spacePath);
      const sourcePath = symlinkCheck ? await getSymlinkTarget(spacePath) : undefined;

      // Check for README.md or legacy AGENTS.md and their states
      const configFileState = await getConfigFileState(spacePath);
      if (configFileState.reconnecting) {
        spaces.push(buildDegradedSpace({ name, candidate, spacePath, isSymlink: symlinkCheck, sourcePath }));
        continue;
      }

      // Determine space status and handle auto-fixes
      let status: 'ok' | 'needs_attention' = 'ok';
      let statusMessage: string | undefined;
      let frontmatter: SpaceFrontmatter | undefined;

      if (!configFileState.hasConfigFile) {
        // No README.md or AGENTS.md - this is just a folder, not a space candidate
        // Skip it (preserves existing behavior for non-space directories)
        continue;
      }

      // Read frontmatter with error details
      let readResult = await readSpaceFrontmatterWithError(spacePath);
      if (readResult.reconnecting) {
        spaces.push(buildDegradedSpace({ name, candidate, spacePath, isSymlink: symlinkCheck, sourcePath }));
        continue;
      }

      // Mechanical frontmatter repair (Stage 3) — when the YAML doesn't
      // parse AND we're not in read-only mode, try the deterministic
      // repair helpers (missing closing `---`, duplicate top-level keys,
      // mixed tabs/spaces) before marking the space as needs_attention.
      // Body bytes are preserved verbatim; LLM-grade repair is the daily
      // maintenance pipeline's job.
      // See docs/plans/260411_shared_space_maintenance.md (Stage 3).
      if (readResult.parseError && !options?.skipAutoFix) {
        const repaired = await attemptMechanicalFrontmatterRepairOnDisk(spacePath);
        if (repaired) {
          // Mechanical frontmatter repair mutates disk; the read-only scan
          // cache must be invalidated so subsequent readers don't serve pre-
          // repair frontmatter. Batched at loop exit to avoid redundant work.
          anyAutoFixApplied = true;
          readResult = await readSpaceFrontmatterWithError(spacePath);
        }
      }

      if (readResult.parseError) {
        // Malformed YAML and mechanical repair didn't (or couldn't) help.
        status = 'needs_attention';
        statusMessage = `Malformed YAML: ${readResult.parseError}`;
        frontmatter = undefined;
      } else if (!readResult.frontmatter?.rebel_space_description?.trim()) {
        // Missing description
        if (options?.skipAutoFix) {
          // Read-only mode - just mark as needs_attention
          status = 'needs_attention';
          statusMessage = 'Missing rebel_space_description';
          frontmatter = readResult.frontmatter;
        } else {
          // Try to auto-fix
          const fixResult = await addDescriptionToFrontmatter(spacePath, name);
          if (fixResult.success) {
            // Writable scans can write README frontmatter; cache invalidation is
            // batched post-loop so the read-only lane sees exactly one
            // invalidation per scan regardless of how many spaces auto-fixed.
            anyAutoFixApplied = true;
            // Successfully auto-fixed - re-read to get updated frontmatter
            const updatedResult = await readSpaceFrontmatterWithError(spacePath);
            frontmatter = updatedResult.frontmatter;
            status = 'ok';
          } else {
            // Auto-fix failed
            status = 'needs_attention';
            statusMessage = fixResult.error || 'Failed to auto-fix description';
            frontmatter = readResult.frontmatter;
          }
        }
      } else {
        // Valid frontmatter with description
        frontmatter = readResult.frontmatter;
        status = 'ok';
      }

      // Check write permission (use sourcePath for cloud-aware timeout detection on symlinked spaces)
      const writable = await checkSpaceWritable(spacePath, sourcePath ?? undefined);

      // Stage 8 — per-space cloud SYNC health (distinct from `status`/config health).
      // READLINK-ONLY + SYNC + flag-gated: `resolveSpaceSyncStatus` returns 'healthy'
      // (no signal) for a local space OR when the cloud-symlink-indexing flag is OFF,
      // so this is INERT by default. Only ADMITTED cloud spaces (flag on + symlink
      // into a cloud mount) can surface 'reconnecting'/'not_found'. We attach the
      // field only when it's non-'healthy' so the default/flag-off SpaceInfo is
      // byte-identical to today (no UI signal, no contract noise).
      let syncStatus: SpaceSyncStatus | undefined;
      if (symlinkCheck) {
        // Cloud-root-safe: under a cloud-classified workspace root, pass `rootIsCloud`
        // + the cached `sourcePath` so the resolver derives the verdict zero-I/O
        // instead of a readlink that could block on a dead FUSE mount.
        const resolved = resolveSpaceSyncStatus(spacePath, { rootIsCloud, sourcePath });
        if (resolved !== 'healthy') syncStatus = resolved;
      }

      const spaceInfo: SpaceInfo = {
        name,
        path: candidate,
        absolutePath: spacePath,
        type: frontmatter?.space_type ? (frontmatter.space_type as SpaceType) : inferSpaceType(candidate),
        isSymlink: symlinkCheck,
        hasReadme: configFileState.hasConfigFile,
        hasLegacyAgentsMd: configFileState.hasLegacyAgentsMd || undefined,
        hasBothConfigFiles: configFileState.hasBothConfigFiles || undefined,
        frontmatter,
        sourcePath,
        description: frontmatter?.rebel_space_description,
        displayName: frontmatter?.display_name,
        sharing: frontmatter?.sharing,
        memoryTrust: frontmatter?.memoryTrust,
        emails: frontmatter?.emails,
        organisationName: frontmatter?.organisation_name,
        writable,
        status,
        statusMessage,
        syncStatus,
      };

      spaces.push(spaceInfo);
    } catch (error) {
      logger.warn({ err: error, spacePath }, 'Skipping inaccessible space candidate');
    }
  }

  // Post-loop invalidation: any writable-lane auto-fix (mechanical YAML repair
  // OR description backfill) mutated at least one space's README, so the read-
  // only scan cache for this workspace may be stale. One invalidation per scan
  // covers every space touched above and keeps the API cheap under batch fixes.
  if (anyAutoFixApplied) {
    invalidateSpaceScanCache(workspacePath, 'scanSpaces:auto-fix');
  }

  return spaces;
}

/** Standard space structure folders that indicate a space-like directory */
const SPACE_STRUCTURE_FOLDERS = ['memory', 'skills', 'scripts', 'help-for-humans'];

/**
 * Check if a directory has space structure folders (memory, skills, etc.)
 * Used to distinguish spaces that need auto-fix from plain containers.
 *
 * S4.1e (review F2): returns a DISCRIMINANT, not a bare boolean. The structure probe
 * feeds the candidate-ENQUEUE heuristic (`hasDescription || hasParseError || hasStructure`),
 * so swallowing `reconnecting`→`false` could DROP a config-but-no-description candidate on
 * a dead mount BEFORE the retention loop ever sees it. Callers must treat `'reconnecting'`
 * as "retain + mark degraded" (enqueue), never "skip". A real fs `error` → `false` (the
 * structure folder genuinely isn't enumerable — today's behaviour).
 */
async function checkForSpaceStructure(dirPath: string): Promise<boolean | 'reconnecting'> {
  // Per-path cloud option (F1): a pattern-cloud dir routes the bounded cloud lane.
  const outcome = await workspaceFs.readdir(dirPath, cloudReadOption(dirPath));
  if (outcome.status === 'reconnecting') {
    return 'reconnecting';
  }
  if (outcome.status === 'error') {
    return false;
  }
  return outcome.value.some((name) => SPACE_STRUCTURE_FOLDERS.includes(name.toLowerCase()));
}

/** Suggested space info with readiness indicators */
export interface SuggestedSpaceInfo extends SpaceInfo {
  /** Readiness level: ready (has frontmatter), needs_configuration (has structure), not_configured (empty) */
  readiness: 'ready' | 'needs_configuration' | 'not_configured';
  /** What was detected in this folder */
  indicators: string[];
  /** User-facing hint explaining the state */
  hint: string;
}

/**
 * Build a SuggestedSpaceInfo for a given directory path.
 * Returns null if the path is not accessible or not a directory.
 */
const buildSuggestion = async (absolutePath: string, relativePath: string): Promise<SuggestedSpaceInfo | null> => {
  // S4.1f: read-only suggestion build — a reconnecting/error read degrades to `null`
  // (skip the candidate) via the outer catch. WorkspaceStat booleans are PROPERTIES.
  try {
    const stat = await boundedStat(absolutePath);
    if (!stat.isDirectory) {
      return null;
    }

    const name = path.basename(absolutePath);
    const indicators: string[] = [];
    const symlinkCheck = await isSymlink(absolutePath);
    const sourcePath = symlinkCheck ? await getSymlinkTarget(absolutePath) : undefined;
    const configFileState = await getConfigFileState(absolutePath);
    const frontmatter = configFileState.hasConfigFile ? await readSpaceReadmeFrontmatter(absolutePath) : undefined;

    // Check for space structure folders
    let _hasStructureFolders = false;
    try {
      const contents = await boundedReaddir(absolutePath);
      const structureFoldersFound = contents.filter(n =>
        SPACE_STRUCTURE_FOLDERS.includes(n.toLowerCase())
      );
      if (structureFoldersFound.length > 0) {
        _hasStructureFolders = true;
        indicators.push(`Has ${structureFoldersFound.join(', ')} folder${structureFoldersFound.length > 1 ? 's' : ''}`);
      }
    } catch {
      // Can't read directory contents
    }

    if (configFileState.hasConfigFile) {
      indicators.push('Has config file');
    }
    if (configFileState.hasLegacyAgentsMd) {
      indicators.push('Uses legacy AGENTS.md');
    }
    if (configFileState.hasBothConfigFiles) {
      indicators.push('Has both README.md and AGENTS.md');
    }
    if (symlinkCheck) {
      indicators.push('Linked folder');
    }

    // Only include folders with a config file (README.md or AGENTS.md)
    // This prevents suggesting random folders like memory/, scripts/, etc.
    if (!configFileState.hasConfigFile) {
      return null;
    }

    // Determine readiness level and hint
    let readiness: 'ready' | 'needs_configuration' | 'not_configured';
    let hint: string;

    if (frontmatter?.rebel_space_description) {
      readiness = 'ready';
      hint = 'Already configured. Add to track it as a space.';
    } else {
      readiness = 'needs_configuration';
      hint = 'Has config file but needs description. Adding will update it.';
    }

    // Skip containers: if this folder doesn't have frontmatter but has children with space indicators,
    // it's likely a container (e.g., work/Mindstone/ containing work/Mindstone/General/)
    if (readiness !== 'ready') {
      try {
        const children = await boundedReaddirWithFileTypes(absolutePath);
        for (const child of children) {
          if (!child.isDirectory && !child.isSymbolicLink) continue;
          if (child.name.startsWith('.') || child.name.startsWith('_')) continue;
          const childPath = path.join(absolutePath, child.name);
          const childFrontmatter = await readSpaceReadmeFrontmatter(childPath);
          if (childFrontmatter?.rebel_space_description) {
            // This folder has a child that's a configured space - it's a container, skip it
            logger.debug({ name, childName: child.name }, 'Skipping container folder (has space child)');
            return null;
          }
        }
      } catch {
        // Can't read children, proceed with suggestion
      }
    }

    return {
      name,
      path: relativePath,
      absolutePath,
      type: frontmatter?.space_type ? (frontmatter.space_type as SpaceType) : inferSpaceType(name),
      isSymlink: symlinkCheck,
      hasReadme: configFileState.hasConfigFile,
      hasLegacyAgentsMd: configFileState.hasLegacyAgentsMd || undefined,
      hasBothConfigFiles: configFileState.hasBothConfigFiles || undefined,
      frontmatter,
      sourcePath,
      description: frontmatter?.rebel_space_description,
      displayName: frontmatter?.display_name,
      sharing: frontmatter?.sharing,
      memoryTrust: frontmatter?.memoryTrust,
      emails: frontmatter?.emails,
      organisationName: frontmatter?.organisation_name,
      status: 'ok',
      readiness,
      indicators,
      hint,
    };
  } catch {
    return null;
  }
};

/**
 * Recursively scan a directory for potential spaces up to maxDepth levels.
 * Used for scanning work/ and similar container directories.
 */
// bounded-walker-pending: see docs/plans/260503_s9_bounded_walker_resource_budget.md
const scanWorkDirectory = async (
  dirPath: string,
  relativePath: string,
  maxDepth: number,
  excludedNames: Set<string>,
  suggestions: SuggestedSpaceInfo[]
): Promise<void> => {
  if (maxDepth <= 0) return;

  // S4.1f: read-only recursive scan — a reconnecting/error readdir degrades to "could not
  // scan" (skip this subtree) via the catch. WorkspaceDirent booleans are PROPERTIES.
  try {
    const contents = await boundedReaddirWithFileTypes(dirPath);
    for (const entry of contents) {
      // Skip hidden, underscore-prefixed, and excluded directories
      if (entry.name.startsWith('.') || entry.name.startsWith('_')) {
        continue;
      }
      if (excludedNames.has(entry.name.toLowerCase())) {
        continue;
      }
      if (!entry.isDirectory && !entry.isSymbolicLink) {
        continue;
      }
      
      const entryPath = path.join(dirPath, entry.name);
      const entryRelativePath = `${relativePath}/${entry.name}`;
      
      // Build suggestion for this entry
      const suggestion = await buildSuggestion(entryPath, entryRelativePath);
      if (suggestion) {
        suggestions.push(suggestion);
        // If this is a fully-configured space (has frontmatter), don't recurse into it
        // This prevents suggesting subfolders of existing spaces (e.g., work/Company/scripts)
        if (suggestion.readiness === 'ready') {
          continue;
        }
      }
      
      // Recurse into subdirectories (for container patterns like work/Company/Space)
      await scanWorkDirectory(entryPath, entryRelativePath, maxDepth - 1, excludedNames, suggestions);
    }
  } catch {
    logger.debug({ dirPath }, 'Could not scan directory');
  }
};

/**
 * Scan workspace for potential spaces NOT already tracked by scanSpaces().
 * 
 * This function looks for root-level directories/symlinks that:
 * 1. Are NOT Chief-of-Staff, Personal, or work (case-insensitive) - these are covered by scanSpaces()
 * 2. Returns all found directories with readiness indicators:
 *    - 'ready': Has valid frontmatter (rebel_space_description)
 *    - 'needs_configuration': Has space-like structure (memory/, skills/) but no frontmatter
 *    - 'not_configured': No space indicators detected
 * 
 * @param workspacePath - The workspace root directory
 * @returns Array of SuggestedSpaceInfo with readiness indicators
 */
export const scanSuggestedSpaces = async (workspacePath: string): Promise<SuggestedSpaceInfo[]> => {
  const suggestions: SuggestedSpaceInfo[] = [];

  if (!workspacePath) {
    logger.warn('scanSuggestedSpaces called with empty workspacePath');
    return suggestions;
  }

  const root = path.resolve(workspacePath);

  // Check if workspace exists. S4.1f: bounded — a reconnecting/error probe degrades to
  // "no suggestions" (read-only; same as today's missing-workspace fall-through).
  try {
    await boundedAccess(root);
  } catch {
    logger.warn({ root }, 'Workspace path does not exist (or is reconnecting)');
    return suggestions;
  }

  // Directories to exclude from root-level scanning
  // - chief-of-staff, personal: built-in spaces handled by scanSpaces()
  // - protected roots: bundled system files, not user spaces
  // - _archived-spaces: internal archive folder
  const excludedRootNames = new Set(['chief-of-staff', 'personal', '_archived-spaces']);
  
  // Directories to always exclude (build outputs, caches, etc.)
  const excludedEverywhere = new Set(['node_modules', 'dist', 'build', 'out', '__pycache__', 'tmp', 'temp']);

  try {
    const rootContents = await boundedReaddirWithFileTypes(root);

    for (const entry of rootContents) {
      // Skip hidden files/folders, underscore-prefixed, and excluded directories
      if (entry.name.startsWith('.') || entry.name.startsWith('_')) {
        continue;
      }
      const nameLower = entry.name.toLowerCase();
      if (isProtectedRootName(entry.name) || excludedRootNames.has(nameLower) || excludedEverywhere.has(nameLower)) {
        continue;
      }
      
      // Handle work/ specially - scan up to 3 levels deep
      // Supports: work/Company, work/Company/Space, work/Company/Space/SubSpace
      if (nameLower === 'work') {
        const workPath = path.join(root, entry.name);
        await scanWorkDirectory(workPath, 'work', 3, excludedEverywhere, suggestions);
        continue;
      }

      // Only process directories and symlinks
      if (!entry.isDirectory && !entry.isSymbolicLink) {
        continue;
      }

      const entryPath = path.join(root, entry.name);
      const suggestion = await buildSuggestion(entryPath, entry.name);
      if (suggestion) {
        suggestions.push(suggestion);
        logger.debug({ name: entry.name, readiness: suggestion.readiness }, 'Found potential space');
      }
    }
  } catch (error) {
    logger.error({ err: error, root }, 'Failed to read workspace root directory');
  }

  // Sort: ready first, then needs_configuration, then not_configured
  const readinessOrder = { ready: 0, needs_configuration: 1, not_configured: 2 };
  suggestions.sort((a, b) => readinessOrder[a.readiness] - readinessOrder[b.readiness]);

  logger.info({ count: suggestions.length }, 'Scanned for suggested spaces');
  return suggestions;
};

/**
 * Create a new space in the workspace.
 */
export const createSpace = async (
  workspacePath: string,
  options: CreateSpaceOptions
): Promise<SpaceInfo> => {
  const root = path.resolve(workspacePath);

  // Determine target path
  let targetRelativePath: string;
  if (options.targetPath) {
    targetRelativePath = options.targetPath;
  } else if (options.type === 'chief-of-staff') {
    targetRelativePath = 'Chief-of-Staff';
  } else if (options.type === 'personal') {
    targetRelativePath = 'Personal';
  } else if (options.companyName) {
    targetRelativePath = `work/${options.companyName}/${options.name}`;
  } else {
    targetRelativePath = options.name;
  }

  const targetPath = path.join(root, targetRelativePath);

  logger.info({ targetPath, options }, 'Creating space');
  await assertSpaceWriteSafeForWrite(root, targetPath);

  // Create the space directory
  if (options.location === 'symlink' && options.sourcePath) {
    // Validate source path. S4.1f: bounded — `options.sourcePath` is a user-provided folder
    // being LINKED as a space (the canonical Google-Drive-mount case). ENOENT→"does not
    // exist" (today's behaviour); a reconnecting/other error is re-thrown (NOT the ENOENT
    // branch) so we never create a dangling symlink into a degraded mount. isDirectory is
    // a PROPERTY.
    try {
      const sourceStat = await boundedStat(options.sourcePath);
      if (!sourceStat.isDirectory) {
        throw new Error(`Source path is not a directory: ${options.sourcePath}`);
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new Error(`Source path does not exist: ${options.sourcePath}`);
      }
      throw err;
    }

    // Ensure parent directory exists
    await fs.mkdir(path.dirname(targetPath), { recursive: true });

    // Check if target already exists. S4.1f: bounded — a `reconnecting`/non-ENOENT error
    // is re-thrown (NOT the ENOENT create branch), so we never create a symlink OVER an
    // unreachable existing target. isSymbolicLink is a PROPERTY.
    try {
      const existingStat = await boundedLstat(targetPath);
      if (existingStat.isSymbolicLink) {
        const existingTarget = await boundedReadlink(targetPath);
        if (existingTarget === options.sourcePath) {
          // Already correctly linked
          logger.info({ targetPath }, 'Symlink already exists with correct target');
        } else {
          throw new Error(`A symlink already exists at ${targetRelativePath} pointing to a different location`);
        }
      } else {
        throw new Error(`A file or folder already exists at ${targetRelativePath}`);
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        // Create symlink
        const linkType = process.platform === 'win32' ? 'junction' : 'dir';
        await fs.symlink(options.sourcePath, targetPath, linkType);
        logger.info({ targetPath, sourcePath: options.sourcePath, linkType }, 'Created symlink');
      } else {
        throw err;
      }
    }
  } else {
    // Create directory
    await fs.mkdir(targetPath, { recursive: true });
    logger.info({ targetPath }, 'Created directory');
  }

  // Create standard subdirectories (opt-out via createSubfolders option)
  // Default to true for backward compatibility
  const shouldCreateSubfolders = options.createSubfolders !== false;
  if (shouldCreateSubfolders) {
    await assertSpaceWriteSafeForWrite(root, targetPath);
    // Use selected subfolders if provided, otherwise default set
    const subfolders = options.selectedSubfolders?.length
      ? options.selectedSubfolders
      : ['skills', 'memory', 'scripts'];

    for (const subdir of subfolders) {
      const subdirPath = path.join(targetPath, subdir);
      try {
        await fs.mkdir(subdirPath, { recursive: true });
      } catch {
        // May already exist
      }
    }

    // Create memory/topics subdirectory if memory was created
    if (subfolders.includes('memory')) {
      try {
        await fs.mkdir(path.join(targetPath, 'memory', 'topics'), { recursive: true });
      } catch {
        // May already exist
      }
    }
  }

  // Write README with frontmatter to ensure space is discoverable by scanSpaces()
  // Skip for chief-of-staff - it has special template handling in ensureChiefOfStaffSpace()
  // Skip if skipFrontmatterWrite is set (add-existing mode - folder already has frontmatter)
  let hasReadme = false;
  const spaceDescription = options.description?.trim() || options.name;
  
  if (options.type !== 'chief-of-staff' && !options.skipFrontmatterWrite) {
    try {
      // Before writing frontmatter, attempt to migrate any legacy AGENTS.md to README.md
      // This ensures we preserve existing content rather than creating a parallel README.md
      // migrateLegacyAgentsMd is idempotent: returns {migrated:false} if already README.md or no file
      const migrationResult = await migrateLegacyAgentsMd(targetPath, { workspaceRoot: root });
      if (migrationResult.reconnecting) {
        // S4.1f (review F1): a `reconnecting` cloud mount during the legacy-migration probe
        // must ABORT the frontmatter write — NEVER create/write README.md over an
        // unreachable cloud space (silent data corruption). Fail closed (distinct from the
        // ordinary "both files exist → keep going" case below).
        throw new Error('Cannot configure this space — it is reconnecting. Try again in a moment.');
      }
      if (migrationResult.migrated) {
        logger.info({ targetPath }, 'Migrated AGENTS.md to README.md before writing frontmatter');
        invalidateSpaceScanCache(workspacePath, 'migrateLegacyAgentsMd:createSpace');
      } else if (migrationResult.backedUp) {
        invalidateSpaceScanCache(workspacePath, 'migrateLegacyAgentsMd:createSpace');
      } else if (!migrationResult.success) {
        // This happens when both README.md and AGENTS.md exist - needs manual resolution
        logger.warn({ targetPath, error: migrationResult.error }, 'Could not auto-migrate AGENTS.md - proceeding with README.md');
      }

      // Build updates object with only defined values to avoid overwriting existing frontmatter
      const updates: Partial<SpaceFrontmatter> = {
        rebel_space_description: spaceDescription,
      };
      if (
        options.type === 'personal' ||
        options.type === 'company' ||
        options.type === 'team' ||
        options.type === 'project' ||
        options.type === 'operator'
      ) {
        updates.space_type = options.type;
      }
      if (options.sharing !== undefined) {
        updates.sharing = options.sharing;
      }
      if (options.memoryTrust !== undefined) {
        updates.memoryTrust = options.memoryTrust;
      }
      const organisation = options.organisation?.trim();
      if (organisation) {
        updates.organisation_name = organisation;
      }
      if (options.emails !== undefined) {
        updates.emails = options.emails;
      }
      
      const updateResult = await updateSpaceFrontmatter(targetPath, updates, { workspaceRoot: root });
      hasReadme = updateResult.success;
      if (!updateResult.success) {
        logger.warn({ error: updateResult.error, targetPath }, 'Failed to write README frontmatter during space creation');
      } else {
        invalidateSpaceScanCache(workspacePath, 'updateSpaceFrontmatter:createSpace');
      }
    } catch (err) {
      // S4.1f (review F1): a `reconnecting` cloud mount is NOT a swallowable "non-fatal"
      // frontmatter hiccup — re-throw so the failure is surfaced (the space dir/symlink
      // may have been created, but we never silently write README over an unreachable
      // cloud space). Ordinary frontmatter-write exceptions stay non-fatal as before.
      if (isSpaceFsReconnecting(err) || (err instanceof Error && /reconnecting/i.test(err.message))) {
        throw err;
      }
      // Non-fatal: space was created, just couldn't write frontmatter
      logger.warn({ err, targetPath }, 'Exception writing README frontmatter during space creation');
    }
  } else if (options.skipFrontmatterWrite) {
    // For add-existing mode, the folder already has frontmatter, so just verify it exists
    const configState = await getConfigFileState(targetPath);
    hasReadme = configState.hasConfigFile;
    logger.info({ targetPath, hasReadme }, 'Skipped frontmatter write for add-existing mode');
  }

  return {
    name: options.name,
    path: targetRelativePath,
    absolutePath: targetPath,
    type: options.type,
    isSymlink: options.location === 'symlink',
    hasReadme,
    sourcePath: options.sourcePath,
    description: spaceDescription,
    organisationName: options.organisation?.trim() || undefined,
    sharing: options.sharing,
    memoryTrust: options.memoryTrust,
    emails: options.emails,
    associatedAccounts: options.associatedAccounts,
    status: 'ok',
  };
};

/**
 * Get a human-readable display name for a space.
 * Priority: frontmatter display_name > type-based defaults > folder name
 */
export const getSpaceDisplayName = (space: SpaceInfo): string => {
  // 1. Custom display name from frontmatter takes precedence (with whitespace protection)
  const trimmedDisplayName = space.displayName?.trim();
  if (trimmedDisplayName) {
    return trimmedDisplayName;
  }
  // 2. Type-based defaults for special spaces
  if (space.type === 'chief-of-staff') {
    return 'Private Space';
  }
  if (space.type === 'personal') {
    return 'Personal';
  }
  // 3. Folder name as fallback
  return space.name;
};

/**
 * Initialize README.md in a space from the appropriate template.
 * Also checks for legacy AGENTS.md to avoid overwriting existing config.
 */
export const initializeSpaceReadme = async (
  workspacePath: string,
  spacePath: string,
  type: SpaceType,
  variables?: Record<string, string>
): Promise<void> => {
  const root = path.resolve(workspacePath);
  const absoluteSpacePath = path.join(root, spacePath);
  const readmePath = path.join(absoluteSpacePath, README_MD);
  const legacyPath = path.join(absoluteSpacePath, LEGACY_AGENTS_MD);

  // Check if README.md or legacy AGENTS.md already exists. S4.1f: bounded idempotent
  // EXIST probes — a `reconnecting` cloud mount must NOT be read as "doesn't exist →
  // create", which would overwrite an unreachable existing README (data loss). Fail
  // closed: re-throw reconnecting so initialization aborts; a real ENOENT/error still
  // means "not present → proceed to create" exactly as today.
  try {
    await boundedAccess(readmePath);
    logger.info({ readmePath }, 'README.md already exists, skipping initialization');
    return;
  } catch (readmeErr) {
    if (isSpaceFsReconnecting(readmeErr)) throw readmeErr;
    // README.md doesn't exist, check for legacy AGENTS.md
    try {
      await boundedAccess(legacyPath);
      logger.info({ legacyPath }, 'Legacy AGENTS.md exists, skipping initialization (consider renaming to README.md)');
      return;
    } catch (legacyErr) {
      if (isSpaceFsReconnecting(legacyErr)) throw legacyErr;
      // Neither exists, proceed with creation
    }
  }

  // Get template path from the actual rebel-system location (AppData or submodule),
  // NOT from the workspace symlink, since the symlink may not exist yet during initial setup
  const templateName = getTemplateForSpaceType(type);
  const rebelSystemDir = getSystemSettingsPath();
  const templatePath = path.join(rebelSystemDir, 'templates', templateName);

  let templateContent: string;
  try {
    // workspace-fs-allow-local: bundled rebel-system template via getSystemSettingsPath() (app-data / submodule), never workspace/cloud content.
    templateContent = await fs.readFile(templatePath, 'utf-8');
  } catch (err) {
    logger.error({ err, templatePath }, 'Failed to read space template');
    throw new Error(`Template not found: ${templateName}. Ensure rebel-system is synced.`);
  }

  // Replace placeholders with provided variables
  let content = templateContent;
  if (variables) {
    for (const [key, value] of Object.entries(variables)) {
      const placeholder = `{${key.toUpperCase()}}`;
      content = content.replace(new RegExp(placeholder, 'g'), value);
    }
  }

  // Write the README.md file
  await assertSpaceWriteSafeForWrite(root, absoluteSpacePath);
  await fs.writeFile(readmePath, content, 'utf-8');
  logger.info({ readmePath }, 'Created README.md from template');
};

/**
 * Remove a space from the workspace.
 * 
 * This function is specifically for removing SYMLINKS (or Windows junctions).
 * For regular folders, use moveSpace() to move them out of the workspace.
 * 
 * @param removeSymlinkOnly - If true (default), only remove symlinks. If false, also removes regular directories.
 * @throws Error if space is not a symlink and removeSymlinkOnly is true
 */
export const removeSpace = async (
  workspacePath: string,
  spacePath: string,
  removeSymlinkOnly = true
): Promise<void> => {
  // Security: Validate path before any filesystem operations
  const absoluteSpacePath = validateSpacePath(workspacePath, spacePath);

  // Safety check - don't remove Chief-of-Staff
  // Use resolved path to prevent bypass via equivalent paths like 'Chief-of-Staff/.'
  const root = path.resolve(workspacePath);
  const chiefOfStaffPath = path.join(root, 'Chief-of-Staff');
  if (absoluteSpacePath.toLowerCase() === chiefOfStaffPath.toLowerCase()) {
    throw new Error('Cannot remove Chief-of-Staff space');
  }

  // Handle ENOENT gracefully - if the space is already gone, treat as success.
  // S4.1f: bounded destructive pre-step. ENOENT → already-removed (success); a
  // `reconnecting`/other error is re-thrown (NOT the ENOENT branch) so a degraded cloud
  // mount is NEVER read as "missing → remove" — the space is retained (data-loss guard).
  // We capture isSymbolicLink from THIS strict bounded lstat and reuse it below: the
  // best-effort `isSymlink()` scan helper swallows reconnecting→false, which on the
  // `removeSymlinkOnly=false` path would let `fs.rm` delete real content it thought was a
  // symlink (review F2). Strict-once is the only safe probe on a destructive path.
  let symlinkCheck: boolean;
  try {
    const lstat = await boundedLstat(absoluteSpacePath);
    symlinkCheck = lstat.isSymbolicLink;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      logger.info({ absoluteSpacePath }, 'Space already removed (ENOENT) - treating as success');
      return;
    }
    throw err;
  }

  if (symlinkCheck) {
    // Remove symlink/junction
    await assertSpaceWriteSafeForWrite(root, absoluteSpacePath);
    try {
      await fs.unlink(absoluteSpacePath);
      logger.info({ absoluteSpacePath }, 'Removed space symlink');
    } catch (unlinkErr) {
      // Windows junctions may fail with EPERM on unlink - try rmdir instead
      // (Windows junctions are directory reparse points)
      if ((unlinkErr as NodeJS.ErrnoException).code === 'EPERM' && process.platform === 'win32') {
        try {
          await fs.rmdir(absoluteSpacePath);
          logger.info({ absoluteSpacePath }, 'Removed Windows junction via rmdir');
        } catch (rmdirErr) {
          // If rmdir also fails, throw the original error
          logger.error({ err: rmdirErr, absoluteSpacePath }, 'Failed to remove Windows junction');
          throw unlinkErr;
        }
      } else if ((unlinkErr as NodeJS.ErrnoException).code === 'ENOENT') {
        // Race condition - another process removed it - treat as success
        logger.info({ absoluteSpacePath }, 'Space removed by another process - treating as success');
        return;
      } else {
        throw unlinkErr;
      }
    }
  } else if (!removeSymlinkOnly) {
    // Remove directory and contents
    await assertSpaceWriteSafeForWrite(root, absoluteSpacePath);
    await fs.rm(absoluteSpacePath, { recursive: true, force: true });
    logger.info({ absoluteSpacePath }, 'Removed space directory');
  } else {
    throw new Error('Space is not a symlink. Use moveSpace() to relocate regular folders.');
  }
};

/**
 * Result of a moveSpace operation.
 */
export interface MoveSpaceResult {
  /** New absolute path of the moved space */
  newPath: string;
  /** Whether a cross-device fallback (copy+delete) was used */
  wasCrossDevice: boolean;
}

/**
 * Move a space folder to a destination directory outside the workspace.
 * 
 * This is used when a user wants to stop tracking a regular folder (non-symlink)
 * as a space. The folder is moved out of the workspace so scanSpaces() won't find it.
 * 
 * @param workspacePath - The workspace root directory
 * @param spacePath - Relative path of the space within workspace
 * @param destinationDir - Absolute path to the destination directory (must be outside workspace)
 * @returns The new path and whether cross-device copy was used
 * @throws Error if space is a symlink, destination is inside workspace, or destination exists
 */
export const moveSpace = async (
  workspacePath: string,
  spacePath: string,
  destinationDir: string
): Promise<MoveSpaceResult> => {
  // Security: Validate source path
  const absoluteSpacePath = validateSpacePath(workspacePath, spacePath);
  const root = path.resolve(workspacePath);

  // Safety check - don't move Chief-of-Staff
  const chiefOfStaffPath = path.join(root, 'Chief-of-Staff');
  if (absoluteSpacePath.toLowerCase() === chiefOfStaffPath.toLowerCase()) {
    throw new Error('Cannot move Chief-of-Staff space');
  }

  // Reject symlinks - use removeSpace() for those. S4.1f (review F2): use a STRICT bounded
  // lstat, NOT the best-effort `isSymlink()` scan helper — the latter swallows
  // reconnecting→false ("not a symlink"), which would let the copy+delete move proceed on a
  // degraded mount. A reconnecting/error here re-throws (abort the move); a real ENOENT
  // surfaces below at the source stat. isSymbolicLink is a PROPERTY.
  const symlinkCheck = (await boundedLstat(absoluteSpacePath)).isSymbolicLink;
  if (symlinkCheck) {
    throw new Error('Cannot move a symlink. Use removeSpace() to remove symlinks.');
  }

  // Verify source is a directory (not a file). S4.1f: bounded — ENOENT→"does not exist";
  // a reconnecting/other error is re-thrown (NOT proceeding to move). isDirectory PROPERTY.
  try {
    const sourceStat = await boundedStat(absoluteSpacePath);
    if (!sourceStat.isDirectory) {
      throw new Error('Source path is not a directory');
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error('Source space does not exist');
    }
    throw err;
  }

  // Validate destination is outside workspace
  // Use case-insensitive comparison for Windows and macOS (case-insensitive filesystems)
  const resolvedDestDir = path.resolve(destinationDir);
  const rootLower = root.toLowerCase();
  const destLower = resolvedDestDir.toLowerCase();
  if (destLower.startsWith(rootLower + path.sep) || destLower === rootLower) {
    throw new Error('Destination must be outside the workspace. The folder would reappear on next scan.');
  }

  // Check destination directory exists. S4.1f: bounded — `resolvedDestDir` is a
  // user-chosen EXTERNAL folder that can itself be a cloud mount. ENOENT→"dest does not
  // exist"; reconnecting/other error re-thrown (NOT proceeding). isDirectory PROPERTY.
  try {
    const destStat = await boundedStat(resolvedDestDir);
    if (!destStat.isDirectory) {
      throw new Error('Destination path is not a directory');
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error('Destination directory does not exist');
    }
    throw err;
  }

  // Check if target path already exists. S4.1f: bounded — a `reconnecting`/non-ENOENT
  // error is re-thrown (`code !== 'ENOENT'` is true for the typed reconnecting error), so
  // a degraded dest mount is NEVER read as "ENOENT → ok-to-proceed" → no move over an
  // unreachable existing path.
  const spaceName = path.basename(absoluteSpacePath);
  const newPath = path.join(resolvedDestDir, spaceName);
  try {
    await boundedAccess(newPath);
    throw new Error(`A file or folder already exists at destination: ${newPath}`);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw err;
    }
    // ENOENT is expected - destination doesn't exist, which is what we want
  }

  // Try rename first (fast, atomic on same filesystem)
  let wasCrossDevice = false;
  await assertSpaceWriteSafeForWrite(root, absoluteSpacePath);
  try {
    await fs.rename(absoluteSpacePath, newPath);
    logger.info({ from: absoluteSpacePath, to: newPath }, 'Moved space via rename');
  } catch (err) {
    // EXDEV = cross-device link (different filesystem) - use copy + delete fallback
    if ((err as NodeJS.ErrnoException).code === 'EXDEV') {
      logger.info({ from: absoluteSpacePath, to: newPath }, 'Using copy+delete fallback for cross-device move');
      wasCrossDevice = true;
      
      // Copy recursively
      await assertSpaceWriteSafeForWrite(root, absoluteSpacePath);
      await fs.cp(absoluteSpacePath, newPath, { recursive: true, preserveTimestamps: true });
      
      // Verify copy succeeded before deleting. S4.1f: bounded post-copy CAS verify — THE
      // data-loss guard. A `reconnecting`/error read throws → caught → "copy failed" →
      // we do NOT reach the `fs.rm` below, so the original source is RETAINED. The
      // try/throw-BEFORE-rm shape is deliberately preserved.
      try {
        await boundedAccess(newPath);
      } catch {
        throw new Error('Cross-device copy failed - destination not accessible after copy');
      }

      // Delete original
      await assertSpaceWriteSafeForWrite(root, absoluteSpacePath);
      await fs.rm(absoluteSpacePath, { recursive: true, force: true });
      logger.info({ from: absoluteSpacePath, to: newPath }, 'Completed cross-device move via copy+delete');
    } else {
      throw err;
    }
  }

  return { newPath, wasCrossDevice };
};

/**
 * Reconcile settings.spaces[] with scanned spaces from disk.
 * 
 * This function is called from the workspace:scan-spaces handler to keep
 * settings synchronized with the filesystem state.
 * 
 * Behavior:
 * - Additions: New spaces found on disk are added to settings
 * - Removals: Spaces are removed from settings ONLY if lstat(path) returns ENOENT
 *   (not just "missing from scan" which could be transient)
 * - Updates: Frontmatter changes are merged, but enriched metadata (createdAt, etc.) is preserved
 * 
 * @param workspacePath - The workspace root directory
 * @param scannedSpaces - Array of SpaceInfo from scanSpaces()
 * @param currentSettings - Current settings.spaces array
 * @returns Updated spaces array to save to settings
 */
export const reconcileSpacesWithSettings = async (
  workspacePath: string,
  scannedSpaces: SpaceInfo[],
  currentSettings: SpaceConfig[] | undefined
): Promise<SpaceConfig[]> => {
  const root = path.resolve(workspacePath);
  const existingSpaces = currentSettings ?? [];
  
  // Build lookup map by normalized path
  const existingByPath = new Map<string, SpaceConfig>();
  for (const space of existingSpaces) {
    existingByPath.set(space.path.toLowerCase(), space);
  }
  
  const scannedByPath = new Map<string, SpaceInfo>();
  for (const space of scannedSpaces) {
    scannedByPath.set(space.path.toLowerCase(), space);
  }
  
  const result: SpaceConfig[] = [];
  const addedPaths: string[] = [];
  const removedPaths: string[] = [];
  const updatedPaths: string[] = [];

  // Process existing settings entries
  for (const existing of existingSpaces) {
    const normalizedPath = existing.path.toLowerCase();
    const scanned = scannedByPath.get(normalizedPath);
    
    if (scanned) {
      // Space exists in both - merge updates while preserving enriched metadata
      // SECURITY: Do NOT trust README frontmatter for 'type' if it differs from local settings.
      // A malicious README could set space_type: chief-of-staff to bypass safety controls.
      // Local settings are authoritative for type; only use scanned.type for initial detection.
      const typeToUse = existing.type === 'chief-of-staff'
        ? 'chief-of-staff' // Preserve Chief-of-Staff designation (cannot be demoted via README)
        : (existing.type ?? scanned.type); // Use existing type if set, otherwise use scanned for new spaces
      
      const updated: SpaceConfig = {
        ...existing,
        // Update from frontmatter (disk is authoritative for these EXCEPT type)
        name: scanned.name,
        type: typeToUse,
        isSymlink: scanned.isSymlink,
        sourcePath: scanned.sourcePath,
        hasReadme: scanned.hasReadme,
        description: scanned.description || existing.description,
        sharing: (scanned.sharing as SpaceSharingLevel | undefined) ?? existing.sharing,
        writable: scanned.writable,
        // Preserve enriched metadata from settings
        // createdAt, companyName, storageProvider are kept from settings
      };
      result.push(updated);
      updatedPaths.push(existing.path);
    } else {
      // Space in settings but not in scan - check if it still exists on disk.
      // S4.1f: bounded destructive pre-step. ONLY a real ENOENT removes the entry; a
      // `reconnecting` cloud mount (typed error, no `.code`) and any other error fall to
      // the "else → keep to be safe" branch, so a degraded cloud space is NEVER read as
      // "missing → remove" (data-loss / Inv 2 guard).
      const absolutePath = path.join(root, existing.path);
      try {
        await boundedLstat(absolutePath);
        // Path exists but wasn't picked up by scan (e.g., no frontmatter anymore)
        // Keep it in settings - user may want to re-add frontmatter
        result.push(existing);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
          // Path truly doesn't exist - remove from settings
          removedPaths.push(existing.path);
          logger.info({ spacePath: existing.path }, "Removed space from settings (no longer exists on disk)");
        } else {
          // Some other error (permissions, reconnecting, etc.) - keep entry to be safe
          result.push(existing);
          logger.warn({ err, spacePath: existing.path }, 'Could not verify space existence - keeping in settings');
        }
      }
    }
  }

  // Add new spaces found on disk (only if they have valid status)
  for (const scanned of scannedSpaces) {
    const normalizedPath = scanned.path.toLowerCase();
    if (!existingByPath.has(normalizedPath)) {
      // Only add spaces with ok status to settings
      // Broken spaces (needs_attention) should be visible in UI but not persisted
      if (scanned.status !== 'ok') {
        logger.info(
          { spacePath: scanned.path, status: scanned.status, statusMessage: scanned.statusMessage },
          'Skipping broken space - not adding to settings until fixed'
        );
        continue;
      }
      // New space - add to settings
      const newConfig = spaceInfoToConfig(
        scanned,
        getCompanyNameForNewSpace(scanned.path, existingSpaces)
      );
      result.push(newConfig);
      addedPaths.push(scanned.path);
      logger.info({ spacePath: scanned.path }, 'Added new space to settings (found on disk)');
    }
  }

  if (addedPaths.length > 0 || removedPaths.length > 0 || updatedPaths.length > 0) {
    logger.info(
      { 
        added: addedPaths.length, 
        removed: removedPaths.length, 
        updated: updatedPaths.length,
        addedPaths,
        removedPaths,
      },
      'Reconciled spaces with settings'
    );
  }

  return result;
};

function getCompanyNameForNewSpace(spacePath: string, existingSpaces: SpaceConfig[]): string | undefined {
  return getCompanyNameFromSiblingSpace(spacePath, existingSpaces)
    ?? getCompanyNameFromPath(spacePath);
}

function getCompanyNameFromSiblingSpace(spacePath: string, existingSpaces: SpaceConfig[]): string | undefined {
  const parentPath = getParentSpacePath(spacePath);
  if (!parentPath) {
    return undefined;
  }

  for (const existing of existingSpaces) {
    if (!existing.companyName) {
      continue;
    }
    if (getParentSpacePath(existing.path).toLowerCase() === parentPath.toLowerCase()) {
      return existing.companyName;
    }
  }

  return undefined;
}

function getParentSpacePath(spacePath: string): string {
  const normalizedPath = spacePath.replace(/\\/g, '/');
  const separatorIndex = normalizedPath.lastIndexOf('/');
  return separatorIndex === -1 ? '' : normalizedPath.slice(0, separatorIndex);
}

/**
 * Convert scanned SpaceInfo to SpaceConfig for settings storage.
 * 
 * SECURITY: Do NOT trust 'chief-of-staff' type from scanned frontmatter.
 * Only the app-created Chief-of-Staff (via ensureChiefOfStaff) should have that type.
 * A malicious space could claim space_type: chief-of-staff to bypass safety controls.
 */
export function spaceInfoToConfig(info: SpaceInfo, companyName?: string): SpaceConfig {
  // SECURITY: Only allow 'chief-of-staff' type if the path matches the known Chief-of-Staff path
  // This prevents arbitrary folders from claiming CoS type via README frontmatter
  const typeToUse = info.type === 'chief-of-staff' && info.path.toLowerCase() !== 'chief-of-staff'
    ? 'other' // Demote to 'other' if claiming chief-of-staff without being the real one
    : info.type;
  
  return {
    name: info.name,
    path: info.path,
    type: typeToUse,
    isSymlink: info.isSymlink,
    sourcePath: info.sourcePath,
    companyName,
    sharing: info.sharing as SpaceSharingLevel | undefined,
    createdAt: Date.now(),
    hasReadme: info.hasReadme,
    description: info.description,
    associatedAccounts: info.associatedAccounts,
    writable: info.writable,
  };
}

/**
 * Pure helper: given a README.md file body that already has a YAML frontmatter block,
 * insert `sharing: "private"` before the closing `---` if and only if no `sharing:`
 * key is already present. Preserves existing field order, formatting, and values.
 *
 * Returns the (possibly unchanged) body. Safe to run repeatedly — no-op when
 * `sharing:` already exists (any value: 'restricted', 'team', 'private', etc.).
 *
 * Used by FOX-3072 fix to repair Chief-of-Staff README.md files where frontmatter
 * exists but the `sharing` field is missing (causing secret-gate misfires).
 *
 * @internal Exported for testing
 */
export function backfillSharingPrivateIfMissing(body: string): { updated: boolean; content: string } {
  // Match a leading frontmatter block: starts with `---\n`, ends with `\n---\n` or `\n---` at EOF.
  // Tolerates optional BOM and trailing whitespace on fence lines.
  const fmRegex = /^(\uFEFF?---\s*\r?\n)([\s\S]*?)(\r?\n---\s*(?:\r?\n|$))/;
  const match = body.match(fmRegex);
  if (!match) {
    return { updated: false, content: body };
  }

  const [, openingFence, fmBody, closingFence] = match;
  // Check for an existing sharing: key on any line (YAML root-level only — don't inspect nested).
  // Root-level YAML keys are at the start of a line (no leading whitespace).
  const sharingLineRegex = /^sharing\s*:/m;
  if (sharingLineRegex.test(fmBody)) {
    return { updated: false, content: body };
  }

  // Insert `sharing: "private"` as the last line before the closing fence, preserving
  // any trailing newline convention the file already uses.
  const trimmedBody = fmBody.replace(/\r?\n+$/, '');
  const newFmBody = trimmedBody + '\nsharing: "private"';
  const rest = body.slice(match[0].length);
  const newContent = openingFence + newFmBody + closingFence + rest;
  return { updated: true, content: newContent };
}

/**
 * Optional settings-side effect for {@link ensureChiefOfStaffSpace}. Allows the function
 * to update `settings.spaces` after a frontmatter repair without introducing a direct
 * dependency on the Electron settings store (keeps spaceService platform-neutral and
 * easier to unit-test).
 */
export interface ChiefOfStaffSettingsOps {
  getSpaces: () => SpaceConfig[] | undefined;
  updateSpaces: (spaces: SpaceConfig[]) => void;
}

/**
 * Ensure Chief-of-Staff space exists with proper structure.
 * Creates the space if it doesn't exist, idempotently.
 *
 * FOX-3072: repairs partial frontmatter by backfilling `sharing: "private"` when missing,
 * preserving any intentional non-default value (`restricted`, legacy `team`, etc.). Also
 * updates the matching `settings.spaces` entry when `settingsOps` is provided, so the
 * `checkSpaceSharingConfig` health check and `isVerifiedChiefOfStaff` authority stay in
 * sync with the on-disk frontmatter.
 *
 * @param settingsOps Optional dependency injection for settings-side updates. When omitted,
 *   only the filesystem is repaired — callers that hold settings should pass the hooks.
 */
export const ensureChiefOfStaffSpace = async (
  workspacePath: string,
  variables?: Record<string, string>,
  settingsOps?: ChiefOfStaffSettingsOps
): Promise<SpaceInfo> => {
  const root = path.resolve(workspacePath);

  // Check if space exists (either case variant for case-sensitive filesystems).
  // S4.1f: bounded. A `reconnecting` cloud mount must NOT be swallowed to "not found →
  // create" (that could create/overwrite over an unreachable existing space) — re-throw
  // it so the whole ensure aborts; a real ENOENT/error still means "try next variant".
  // isDirectory is a PROPERTY.
  let exists = false;
  let actualDirName = 'Chief-of-Staff';
  for (const dirName of ['Chief-of-Staff', 'chief-of-staff']) {
    try {
      const stat = await boundedStat(path.join(root, dirName));
      if (stat.isDirectory) {
        exists = true;
        actualDirName = dirName;
        break;
      }
    } catch (err) {
      if (isSpaceFsReconnecting(err)) throw err;
      // Try next
    }
  }

  const chiefOfStaffPath = path.join(root, actualDirName);

  if (!exists) {
    await createSpace(workspacePath, {
      name: 'Chief-of-Staff',
      type: 'chief-of-staff',
      location: 'workspace',
      targetPath: 'Chief-of-Staff',
      sharing: 'private',
    });
    invalidateSpaceScanCache(workspacePath, 'ensureChiefOfStaffSpace:createSpace');
  }

  // Check if README.md (or legacy AGENTS.md) exists
  let hasReadme = await hasSpaceConfigFile(chiefOfStaffPath);
  if (!hasReadme) {
    // Initialize README.md from template
    await initializeSpaceReadme(workspacePath, 'Chief-of-Staff', 'chief-of-staff', variables);
    invalidateSpaceScanCache(workspacePath, 'ensureChiefOfStaffSpace:initializeSpaceReadme');
    hasReadme = true;
  }

  // Read frontmatter if present
  let frontmatter = await readSpaceReadmeFrontmatter(chiefOfStaffPath);

  // If README exists but lacks valid frontmatter, prepend default frontmatter
  if (hasReadme && !frontmatter) {
    logger.info({ chiefOfStaffPath }, 'Chief-of-Staff README.md exists but lacks frontmatter, adding default');
    const readmePath = path.join(chiefOfStaffPath, README_MD);
    try {
      // S4.1f: bounded CAS pre-read — a reconnecting/error read throws → caught below →
      // NO write (the prepend is skipped while the mount is degraded).
      const existingContent = await boundedReadFileUtf8(readmePath);
      const defaultFrontmatter = `---
rebel_space_description: "Router and cross-space context"
space_type: "chief-of-staff"
sharing: "private"
sensitivity: "standard"
---

`;
      await assertSpaceWriteSafeForWrite(root, chiefOfStaffPath);
      await fs.writeFile(readmePath, defaultFrontmatter + existingContent, 'utf-8');
      invalidateSpaceScanCache(workspacePath, 'ensureChiefOfStaffSpace:prepend-frontmatter');
      frontmatter = await readSpaceReadmeFrontmatter(chiefOfStaffPath);
      logger.info({ chiefOfStaffPath }, 'Successfully added frontmatter to Chief-of-Staff README.md');
    } catch (err) {
      logger.warn({ err, chiefOfStaffPath }, 'Failed to add frontmatter to Chief-of-Staff README.md');
    }
  } else if (hasReadme && frontmatter && !frontmatter.sharing) {
    // FOX-3072: frontmatter exists but `sharing` is missing. Backfill `sharing: "private"`
    // in-place without disturbing other fields. Intentional non-default values (e.g.
    // `restricted`, legacy `team`) are preserved — we only touch records that are literally
    // missing the key.
    logger.info({ chiefOfStaffPath }, 'Chief-of-Staff frontmatter missing sharing field, backfilling sharing: private');
    const readmePath = path.join(chiefOfStaffPath, README_MD);
    try {
      // S4.1f: bounded CAS pre-read — reconnecting/error throws → caught below → NO write.
      const existingContent = await boundedReadFileUtf8(readmePath);
      const { updated, content: newContent } = backfillSharingPrivateIfMissing(existingContent);
      if (updated) {
        await assertSpaceWriteSafeForWrite(root, chiefOfStaffPath);
        await fs.writeFile(readmePath, newContent, 'utf-8');
        invalidateSpaceScanCache(workspacePath, 'ensureChiefOfStaffSpace:backfill-sharing');
        frontmatter = await readSpaceReadmeFrontmatter(chiefOfStaffPath);
        logger.info({ chiefOfStaffPath }, 'Successfully backfilled sharing: private into Chief-of-Staff frontmatter');
      }
    } catch (err) {
      logger.warn({ err, chiefOfStaffPath }, 'Failed to backfill sharing field in Chief-of-Staff README.md');
    }
  }

  // FOX-3072: if `settings.spaces` has the CoS entry and its `sharing` differs from the
  // (possibly just-repaired) frontmatter, reconcile. This keeps `checkSpaceSharingConfig`
  // green and `isVerifiedChiefOfStaff` authoritative. Idempotent: no write when already aligned.
  const repairedSharing = frontmatter?.sharing;
  if (settingsOps && repairedSharing) {
    try {
      const currentSpaces = settingsOps.getSpaces();
      if (currentSpaces && currentSpaces.length > 0) {
        let mutated = false;
        const updated = currentSpaces.map((space) => {
          const isCoSEntry = space.type === 'chief-of-staff'
            && space.path.toLowerCase() === actualDirName.toLowerCase();
          if (isCoSEntry && space.sharing !== repairedSharing) {
            mutated = true;
            return { ...space, sharing: repairedSharing as SpaceSharingLevel };
          }
          return space;
        });
        if (mutated) {
          settingsOps.updateSpaces(updated);
          logger.info({ chiefOfStaffPath, sharing: repairedSharing },
            'Updated settings.spaces CoS entry sharing to match repaired frontmatter');
        }
      }
    } catch (err) {
      logger.warn({ err, chiefOfStaffPath }, 'Failed to sync settings.spaces CoS entry after frontmatter repair');
    }
  }

  return {
    name: 'Chief-of-Staff',
    path: 'Chief-of-Staff',
    absolutePath: chiefOfStaffPath,
    type: 'chief-of-staff',
    isSymlink: false,
    hasReadme,
    frontmatter,
    description: frontmatter?.rebel_space_description || 'Router and cross-space context',
    displayName: frontmatter?.display_name,
    sharing: frontmatter?.sharing,
    status: 'ok',
  };
};


/** Result of migrating a legacy AGENTS.md file */
export interface MigrationResult {
  /** Whether the operation completed without errors */
  success: boolean;
  /** Error message if success is false */
  error?: string;
  /** Whether AGENTS.md was migrated to README.md */
  migrated: boolean;
  /** Whether AGENTS.md was backed up (when both files existed) */
  backedUp?: boolean;
  /** Reason migration was skipped (if not migrated and not an error) */
  skipped?: 'already-readme' | 'no-agents-md' | 'symlink';
  /**
   * S4.1f (review F1): true iff migration was abandoned because a config-file probe hit a
   * `reconnecting` cloud mount. DISTINCT from an ordinary `{success:false}` — the caller
   * (`createSpace`) must NOT treat this as "legacy absent / migration failed, keep writing
   * README" (which would create a README over an unreachable cloud space). On reconnecting,
   * the caller ABORTS the frontmatter-write path.
   */
  reconnecting?: boolean;
}

/**
 * Generate a timestamp string for backup filenames: YYMMDDHHmmss
 */
const generateBackupTimestamp = (): string => {
  const now = new Date();
  const yy = String(now.getFullYear()).slice(-2);
  const MM = String(now.getMonth() + 1).padStart(2, '0');
  const dd = String(now.getDate()).padStart(2, '0');
  const HH = String(now.getHours()).padStart(2, '0');
  const mm = String(now.getMinutes()).padStart(2, '0');
  const ss = String(now.getSeconds()).padStart(2, '0');
  return `${yy}${MM}${dd}${HH}${mm}${ss}`;
};

/**
 * Ensure the backups directory exists in a space.
 */
const ensureBackupsDir = async (spacePath: string): Promise<string> => {
  const backupsDir = path.join(spacePath, 'backups');
  await fs.mkdir(backupsDir, { recursive: true });
  return backupsDir;
};

/**
 * Migrate a space's legacy AGENTS.md to README.md.
 * 
 * This is the new standard for space config files. The migration is safe:
 * - Uses COPYFILE_EXCL to prevent overwriting README.md if it appears during migration
 * - Skips symlinks (fallback code handles them fine)
 * - If both files exist: backs up BOTH to `{space}/backups/` with timestamp, then deletes AGENTS.md
 * - README.md wins (it's already the runtime behavior)
 * - Properly distinguishes "file missing" from "permission denied"
 * 
 * @param spacePath - Absolute path to the space directory
 * @returns Migration result with success flag, migration status, and any errors
 */
export async function migrateLegacyAgentsMd(
  spacePath: string,
  options?: SpaceWriteOperationOptions,
): Promise<MigrationResult> {
  const readmePath = path.join(spacePath, README_MD);
  const legacyPath = path.join(spacePath, LEGACY_AGENTS_MD);
  const workspaceRoot = resolveWorkspaceRootForSpaceWrite(spacePath, options);
  
  // Check if AGENTS.md exists (error-aware: only ENOENT means "doesn't exist").
  // S4.1f: bounded — a `reconnecting` cloud mount (typed error, no `.code`) falls to the
  // "real error" branch → skip migration (NOT the ENOENT "nothing to migrate" branch, and
  // never a blind migrate). isSymbolicLink is a PROPERTY.
  let agentsMdIsSymlink = false;
  try {
    const lstat = await boundedLstat(legacyPath);
    agentsMdIsSymlink = lstat.isSymbolicLink;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      // AGENTS.md doesn't exist - nothing to migrate
      return { success: true, migrated: false, skipped: 'no-agents-md' };
    }
    // EACCES, EPERM, reconnecting, etc. = real error, not "missing". Flag reconnecting
    // DISTINCTLY (review F1) so `createSpace` aborts the README write instead of treating
    // it as an ordinary migration failure and writing over an unreachable cloud space.
    const errorMsg = err instanceof Error ? err.message : 'Unknown error';
    logger.warn({ err, spacePath }, 'Cannot access AGENTS.md during migration check');
    return { success: false, error: errorMsg, migrated: false, reconnecting: isSpaceFsReconnecting(err) };
  }
  
  // Skip symlinks - the fallback code handles them fine, and migrating
  // a symlink could have unexpected effects (rename operates on the link, not target)
  if (agentsMdIsSymlink) {
    logger.debug({ spacePath }, 'Skipping migration: AGENTS.md is a symlink');
    return { success: true, migrated: false, skipped: 'symlink' };
  }
  
  // Check if README.md exists (error-aware). S4.1f: bounded — a reconnecting/non-ENOENT
  // error → `return {success:false}` (skip migration), NOT treated as "README missing".
  let readmeExists = false;
  try {
    await boundedAccess(readmePath);
    readmeExists = true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT') {
      // Can't access README.md but not because it's missing (EACCES/reconnecting/etc.).
      // Flag reconnecting distinctly (review F1) so the caller aborts the README write.
      const errorMsg = err instanceof Error ? err.message : 'Unknown error';
      logger.warn({ err, spacePath }, 'Cannot access README.md during migration check');
      return { success: false, error: errorMsg, migrated: false, reconnecting: isSpaceFsReconnecting(err) };
    }
    // ENOENT = README.md doesn't exist, which is fine
  }
  
  // If README.md already exists, back up BOTH files and delete AGENTS.md
  // README.md wins (it's already the runtime behavior)
  if (readmeExists) {
    await assertSpaceWriteSafeForWrite(workspaceRoot, spacePath, options?.writeSafetyOptions);
    const timestamp = generateBackupTimestamp();
    let backupsDir: string;
    let readmeBackup: string;
    let agentsBackup: string;
    
    // Create backups (this is the critical part - if this fails, abort)
    try {
      await assertSpaceWriteSafeForWrite(
        workspaceRoot,
        path.join(spacePath, 'backups'),
        options?.writeSafetyOptions,
      );
      backupsDir = await ensureBackupsDir(spacePath);
      readmeBackup = path.join(backupsDir, `README_${timestamp}.md`);
      agentsBackup = path.join(backupsDir, `AGENTS_${timestamp}.md`);
      
      await assertSpaceWriteSafeForWrite(workspaceRoot, readmeBackup, options?.writeSafetyOptions);
      await assertSpaceWriteSafeForWrite(workspaceRoot, agentsBackup, options?.writeSafetyOptions);
      await fs.copyFile(readmePath, readmeBackup);
      await fs.copyFile(legacyPath, agentsBackup);
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : 'Unknown error';
      logger.error({ err, spacePath }, 'Failed to back up files');
      return { success: false, error: errorMsg, migrated: false };
    }
    
    // Delete AGENTS.md (non-fatal if this fails - backups are safe, README.md wins at runtime)
    try {
      await assertSpaceWriteSafeForWrite(workspaceRoot, legacyPath, options?.writeSafetyOptions);
      await fs.unlink(legacyPath);
    } catch (err) {
      logger.warn({ err, spacePath }, 'Backed up both files but could not delete AGENTS.md');
    }
    
    logger.info(
      { spacePath, readmeBackup, agentsBackup },
      'Both files existed - backed up both to backups/, deleted AGENTS.md'
    );
    return { success: true, migrated: false, backedUp: true };
  }
  
  // Migrate: copy with EXCL flag (fails if README.md appears), then delete original
  // This prevents data loss if README.md is created between our check and the copy
  try {
    await assertSpaceWriteSafeForWrite(workspaceRoot, readmePath, options?.writeSafetyOptions);
    await fs.copyFile(legacyPath, readmePath, fsSync.constants.COPYFILE_EXCL);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'EEXIST') {
      // README.md appeared between our check and copy - back up both files
      try {
        const timestamp = generateBackupTimestamp();
        await assertSpaceWriteSafeForWrite(
          workspaceRoot,
          path.join(spacePath, 'backups'),
          options?.writeSafetyOptions,
        );
        const backupsDir = await ensureBackupsDir(spacePath);
        const readmeBackup = path.join(backupsDir, `README_${timestamp}.md`);
        const agentsBackup = path.join(backupsDir, `AGENTS_${timestamp}.md`);
        
        await assertSpaceWriteSafeForWrite(workspaceRoot, readmeBackup, options?.writeSafetyOptions);
        await assertSpaceWriteSafeForWrite(workspaceRoot, agentsBackup, options?.writeSafetyOptions);
        await fs.copyFile(readmePath, readmeBackup);
        await fs.copyFile(legacyPath, agentsBackup);
        await assertSpaceWriteSafeForWrite(workspaceRoot, legacyPath, options?.writeSafetyOptions);
        await fs.unlink(legacyPath);
        
        logger.info({ spacePath }, 'README.md appeared during migration - backed up both, deleted AGENTS.md');
        return { success: true, migrated: false, backedUp: true };
      } catch (backupErr) {
        const errorMsg = backupErr instanceof Error ? backupErr.message : 'Unknown error';
        logger.error({ err: backupErr, spacePath }, 'Failed to back up files after race');
        return { success: false, error: errorMsg, migrated: false };
      }
    }
    const errorMsg = err instanceof Error ? err.message : 'Unknown error';
    logger.error({ err, spacePath }, 'Failed to copy AGENTS.md to README.md');
    return { success: false, error: errorMsg, migrated: false };
  }
  
  // Copy succeeded, now delete the original AGENTS.md
  try {
    await assertSpaceWriteSafeForWrite(workspaceRoot, legacyPath, options?.writeSafetyOptions);
    await fs.unlink(legacyPath);
  } catch (err) {
    // Copy succeeded but couldn't delete original - this leaves "both files" state
    // which is handled gracefully by the app (README.md takes precedence)
    logger.warn({ err, spacePath }, 'Migrated AGENTS.md but could not delete original');
  }
  
  logger.info({ spacePath }, 'Migrated AGENTS.md to README.md');
  return { success: true, migrated: true };
}


// ============================================================================
// Space Rename Support
// ============================================================================

/**
 * Rewrite a path by replacing oldPrefix with newPrefix.
 * Handles:
 * - Exact match: oldPrefix → newPrefix
 * - Prefix match with boundary: oldPrefix/child → newPrefix/child
 *   (boundary = next char must be '/' or end-of-string to prevent /Chief matching /Chief-of-Staff)
 * - POSIX normalization (consistent / separators)
 * - Case-insensitive comparison on macOS/Windows
 * 
 * @param targetPath - The path to potentially rewrite
 * @param oldPrefix - The prefix to match and replace
 * @param newPrefix - The replacement prefix
 * @returns The rewritten path, or original if no match
 */
export const rewritePath = (targetPath: string, oldPrefix: string, newPrefix: string): string => {
  // Normalize to POSIX separators for consistent comparison
  const normalized = toPortablePath(targetPath);
  const normalizedOld = toPortablePath(oldPrefix);

  // Case-insensitive comparison on macOS/Windows, case-sensitive on Linux
  const compare =
    process.platform === 'linux'
      ? (a: string, b: string) => a === b
      : (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

  // Exact match
  if (compare(normalized, normalizedOld)) {
    return newPrefix;
  }

  // Prefix match with boundary check (next char must be '/' or end)
  if (compare(normalized.slice(0, normalizedOld.length), normalizedOld)) {
    const nextChar = normalized[normalizedOld.length];
    if (nextChar === '/' || nextChar === undefined) {
      return newPrefix + normalized.slice(normalizedOld.length);
    }
  }

  return targetPath; // No match - return original unchanged
};

/** Options for renaming a space */
export interface RenameSpaceOptions {
  /** Current workspace-relative path of the space */
  spacePath: string;
  /** New folder/symlink name */
  newName: string;
}

/** Result of a renameSpace operation */
export interface RenameSpaceResult {
  /** Whether the rename succeeded */
  success: boolean;
  /** The old workspace-relative path */
  oldPath: string;
  /** The new workspace-relative path */
  newPath: string;
  /** Which settings were migrated (for logging/UI) */
  settingsUpdated: string[];
  /** Any warnings (e.g., "Shared folder - consider keeping name consistent") */
  warnings?: string[];
  /** Error message if success is false */
  error?: string;
}

/**
 * Check if an error code indicates a retryable transient failure (Windows EBUSY/EPERM).
 */
const isRetryableError = (code: string | undefined): boolean =>
  code === 'EPERM' || code === 'EBUSY' || code === 'EACCES';

/**
 * Rename a file/folder with retry logic for Windows transient errors.
 */
const safeRename = async (
  oldPath: string,
  newPath: string,
  maxRetries = 5,
  options?: SpaceWriteOperationOptions,
): Promise<void> => {
  if (options) {
    const workspaceRoot = resolveWorkspaceRootForSpaceWrite(oldPath, options);
    // `fs.rename` modifies directory entries in the parent directories, not the
    // file/symlink contents themselves. When oldPath is a symlink, the realpath
    // check on it would dereference the link and fail when the target lives
    // outside the workspace (e.g. a symlink to a Google Drive folder). The real
    // security invariant is that the *containing* directories are inside the
    // workspace, so check parent dirs for symlinks and the path itself for
    // anything else.
    let oldPathIsSymlink = false;
    try {
      // S4.1f: bounded SYM detect. isSymbolicLink is a PROPERTY. A `reconnecting` cloud
      // mount is re-thrown (fail closed) rather than swallowed to `false` — otherwise the
      // write-safety check could be routed wrong AND a blind rename would run against a
      // degraded mount. A real ENOENT/error is still swallowed (the rename surfaces it).
      const stat = await boundedLstat(oldPath);
      oldPathIsSymlink = stat.isSymbolicLink;
    } catch (err) {
      if (isSpaceFsReconnecting(err)) throw err;
      // If oldPath doesn't exist, fs.rename will fail anyway; let the actual
      // rename surface that error rather than papering over it here.
    }
    const oldPathToCheck = oldPathIsSymlink ? path.dirname(oldPath) : oldPath;
    await assertSpaceWriteSafeForWrite(workspaceRoot, oldPathToCheck, options.writeSafetyOptions);
    await assertSpaceWriteSafeForWrite(workspaceRoot, newPath, options.writeSafetyOptions);
  }

  for (let i = 0; i < maxRetries; i++) {
    try {
      await fs.rename(oldPath, newPath);
      return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (!isRetryableError(code) || i === maxRetries - 1) {
        throw err;
      }
      // Exponential backoff: 100ms, 200ms, 400ms, 800ms, 1600ms
      await new Promise((resolve) => setTimeout(resolve, 100 * Math.pow(2, i)));
    }
  }
};

/**
 * Rename a space (folder or symlink) within the workspace.
 * 
 * Handles:
 * - Symlinks: renames the symlink itself (not the target)
 * - Folders: renames the folder
 * - Case-only renames: uses two-step rename via temp name on case-insensitive filesystems
 * - Windows EBUSY: retry pattern with exponential backoff
 * 
 * IMPORTANT: Caller is responsible for migrating settings paths after successful rename.
 * 
 * @param workspacePath - The workspace root directory
 * @param options - Rename options (spacePath, newName)
 * @returns Result with old/new paths
 */
export const renameSpace = async (
  workspacePath: string,
  options: RenameSpaceOptions
): Promise<RenameSpaceResult> => {
  const { spacePath, newName } = options;
  const warnings: string[] = [];
  const settingsUpdated: string[] = [];

  // Validate inputs
  if (!newName || !newName.trim()) {
    return {
      success: false,
      oldPath: spacePath,
      newPath: spacePath,
      settingsUpdated: [],
      error: 'New name cannot be empty',
    };
  }

  const trimmedName = newName.trim();

  // Validate name doesn't contain path separators or invalid chars
  if (trimmedName.includes('/') || trimmedName.includes('\\')) {
    return {
      success: false,
      oldPath: spacePath,
      newPath: spacePath,
      settingsUpdated: [],
      error: 'New name cannot contain path separators',
    };
  }

  // Security: Validate space path
  let absoluteOldPath: string;
  try {
    absoluteOldPath = validateSpacePath(workspacePath, spacePath);
  } catch (err) {
    return {
      success: false,
      oldPath: spacePath,
      newPath: spacePath,
      settingsUpdated: [],
      error: err instanceof Error ? err.message : 'Invalid space path',
    };
  }

  const root = path.resolve(workspacePath);

  // Safety check - don't rename Chief-of-Staff
  const chiefOfStaffPath = path.join(root, 'Chief-of-Staff');
  if (absoluteOldPath.toLowerCase() === chiefOfStaffPath.toLowerCase()) {
    return {
      success: false,
      oldPath: spacePath,
      newPath: spacePath,
      settingsUpdated: [],
      error: 'Cannot rename Chief-of-Staff space',
    };
  }

  // Compute new path
  const parentDir = path.dirname(absoluteOldPath);
  const absoluteNewPath = path.join(parentDir, trimmedName);
  const newRelativePath = relativePortablePath(root, absoluteNewPath);

  // Check if it's effectively a no-op (same path)
  if (absoluteOldPath === absoluteNewPath) {
    return {
      success: true,
      oldPath: spacePath,
      newPath: newRelativePath,
      settingsUpdated: [],
    };
  }

  // Check if target already exists (different from source)
  // For case-only renames on case-insensitive filesystems, lstat will succeed but point to same inode
  const isCaseOnlyRename = absoluteOldPath.toLowerCase() === absoluteNewPath.toLowerCase();

  if (!isCaseOnlyRename) {
    try {
      // S4.1f: bounded collision probe — a `reconnecting`/non-ENOENT error is re-thrown
      // (`code !== 'ENOENT'`), so a degraded dest mount is never read as "ENOENT → safe to
      // rename" over an unreachable existing target.
      await boundedLstat(absoluteNewPath);
      // Target exists and it's not a case-only rename
      return {
        success: false,
        oldPath: spacePath,
        newPath: newRelativePath,
        settingsUpdated: [],
        error: `A file or folder already exists at "${trimmedName}"`,
      };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw err;
      }
      // ENOENT = target doesn't exist, which is what we want
    }
  }

  // Detect if this is a symlink
  const symlinkCheck = await isSymlink(absoluteOldPath);
  if (symlinkCheck) {
    // Note: Symlinks pointing to shared folders (Google Drive) will have local-only name change
    const sourcePath = await getSymlinkTarget(absoluteOldPath);
    if (sourcePath) {
      const sourcePathLower = sourcePath.toLowerCase();
      if (
        sourcePathLower.includes('google') ||
        sourcePathLower.includes('dropbox') ||
        sourcePathLower.includes('onedrive') ||
        sourcePathLower.includes('icloud') ||
        sourcePathLower.includes('cloudstorage')
      ) {
        warnings.push(
          'This space links to a shared folder. Renaming only changes the local symlink name, not the shared folder.'
        );
      }
    }
  }

  // Perform the rename
  try {
    if (isCaseOnlyRename && process.platform !== 'linux') {
      // Case-only rename on case-insensitive filesystem (macOS/Windows)
      // Use two-step rename via temp name to avoid "file already exists" error
      const tempName = `${trimmedName}_rename_temp_${Date.now()}`;
      const tempPath = path.join(parentDir, tempName);

      await safeRename(absoluteOldPath, tempPath, 5, { workspaceRoot: root });
      try {
        await safeRename(tempPath, absoluteNewPath, 5, { workspaceRoot: root });
      } catch (err) {
        // Try to recover: rename temp back to original
        try {
          await safeRename(tempPath, absoluteOldPath, 5, { workspaceRoot: root });
        } catch {
          // Recovery failed - log but throw original error
          logger.error({ tempPath, absoluteOldPath }, 'Failed to recover from case-only rename failure');
        }
        throw err;
      }
      logger.info({ oldPath: absoluteOldPath, newPath: absoluteNewPath }, 'Renamed space (case-only, two-step)');
    } else {
      // Standard rename
      await safeRename(absoluteOldPath, absoluteNewPath, 5, { workspaceRoot: root });
      logger.info({ oldPath: absoluteOldPath, newPath: absoluteNewPath }, 'Renamed space');
    }
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    const message = err instanceof Error ? err.message : 'Unknown error';
    logger.error({ err, oldPath: absoluteOldPath, newPath: absoluteNewPath }, 'Failed to rename space');

    let userMessage = `Failed to rename space: ${message}`;
    if (code === 'EBUSY') {
      userMessage = 'The folder is in use. Close any applications using files in this space and try again.';
    } else if (code === 'EACCES' || code === 'EPERM') {
      userMessage = 'Permission denied. Check folder permissions and try again.';
    }

    return {
      success: false,
      oldPath: spacePath,
      newPath: newRelativePath,
      settingsUpdated: [],
      error: userMessage,
    };
  }

  return {
    success: true,
    oldPath: spacePath,
    newPath: newRelativePath,
    settingsUpdated,
    warnings: warnings.length > 0 ? warnings : undefined,
  };
};

/** Result of migrateSpacePathInSettings */
export interface MigrateSettingsResult {
  /** Which settings fields were updated */
  updated: string[];
}

/**
 * Migrate space path references in settings after a successful space rename.
 * 
 * Uses rewritePath() to update:
 * - settings.spaces[].path and .name
 * - settings.meetingBot.groupMeetingSpaceId
 * - settings.meetingBot.oneOnOneSpaceId
 * - settings.meetingBot.physicalMeetingSpaceId
 * - settings.spaceSafetyOverrides[].spacePath
 * 
 * @param settings - The current AppSettings object (will be mutated)
 * @param oldPath - The old workspace-relative path
 * @param newPath - The new workspace-relative path
 * @returns List of which settings were updated
 */
export const migrateSpacePathInSettings = (
  settings: {
    spaces?: Array<{ path: string; name: string }>;
    meetingBot?: {
      groupMeetingSpaceId?: string;
      oneOnOneSpaceId?: string;
      physicalMeetingSpaceId?: string;
    };
    spaceSafetyOverrides?: Array<{ spacePath: string; spaceName: string }>;
  },
  oldPath: string,
  newPath: string
): MigrateSettingsResult => {
  const updated: string[] = [];

  // Extract new folder name from path
  const newName = newPath.split('/').pop() || newPath;

  // 1. Migrate settings.spaces[].path and .name
  if (settings.spaces) {
    for (const space of settings.spaces) {
      const rewritten = rewritePath(space.path, oldPath, newPath);
      if (rewritten !== space.path) {
        space.path = rewritten;
        // Update name if this was an exact match (not a nested space)
        if (rewritten === newPath) {
          space.name = newName;
        }
        updated.push('spaces[].path');
      }
    }
  }

  // 2. Migrate meetingBot space IDs
  if (settings.meetingBot) {
    const bot = settings.meetingBot;

    if (bot.groupMeetingSpaceId) {
      const rewritten = rewritePath(bot.groupMeetingSpaceId, oldPath, newPath);
      if (rewritten !== bot.groupMeetingSpaceId) {
        bot.groupMeetingSpaceId = rewritten;
        updated.push('meetingBot.groupMeetingSpaceId');
      }
    }

    if (bot.oneOnOneSpaceId) {
      const rewritten = rewritePath(bot.oneOnOneSpaceId, oldPath, newPath);
      if (rewritten !== bot.oneOnOneSpaceId) {
        bot.oneOnOneSpaceId = rewritten;
        updated.push('meetingBot.oneOnOneSpaceId');
      }
    }

    if (bot.physicalMeetingSpaceId) {
      const rewritten = rewritePath(bot.physicalMeetingSpaceId, oldPath, newPath);
      if (rewritten !== bot.physicalMeetingSpaceId) {
        bot.physicalMeetingSpaceId = rewritten;
        updated.push('meetingBot.physicalMeetingSpaceId');
      }
    }
  }

  // 3. Migrate spaceSafetyOverrides[].spacePath
  if (settings.spaceSafetyOverrides) {
    for (const override of settings.spaceSafetyOverrides) {
      const rewritten = rewritePath(override.spacePath, oldPath, newPath);
      if (rewritten !== override.spacePath) {
        override.spacePath = rewritten;
        // Update name if this was an exact match
        if (rewritten === newPath) {
          override.spaceName = newName;
        }
        updated.push('spaceSafetyOverrides[].spacePath');
      }
    }
  }

  return { updated };
};

/** Summary of startup migration results */
export interface StartupMigrationSummary {
  /** Number of spaces migrated from AGENTS.md to README.md */
  migrated: number;
  /** Number of spaces where AGENTS.md was backed up (both files existed) */
  backedUp: number;
  /** Number of spaces where migration failed */
  failed: number;
  /** Paths of spaces that were migrated */
  migratedPaths: string[];
  /** Paths of spaces where AGENTS.md was backed up */
  backedUpPaths: string[];
  /** Paths of spaces where migration failed with error messages */
  failedPaths: { path: string; error: string }[];
}

/**
 * Migrate all legacy AGENTS.md files to README.md at startup.
 * 
 * This is a best-effort migration - failures don't block startup because
 * the fallback code will still read AGENTS.md files that couldn't be migrated.
 * 
 * @param workspacePath - The workspace root directory
 * @returns Summary of migration results for user notification
 */
export const migrateAllLegacyAgentsMd = async (
  workspacePath: string
): Promise<StartupMigrationSummary> => {
  const summary: StartupMigrationSummary = {
    migrated: 0,
    backedUp: 0,
    failed: 0,
    migratedPaths: [],
    backedUpPaths: [],
    failedPaths: [],
  };
  
  if (!workspacePath) {
    logger.warn('migrateAllLegacyAgentsMd called with empty workspacePath');
    return summary;
  }
  
  const root = path.resolve(workspacePath);
  
  // Scan for all spaces
  let spaces: SpaceInfo[];
  try {
    spaces = await scanSpacesReadOnly(workspacePath);
  } catch (err) {
    logger.error({ err, workspacePath }, 'Failed to scan spaces for migration');
    return summary;
  }
  
  // Also ensure Chief-of-Staff is checked (it's always included by scanSpaces, but be explicit)
  const hasChiefOfStaff = spaces.some(s => s.path.toLowerCase() === 'chief-of-staff');
  if (!hasChiefOfStaff) {
    // Add Chief-of-Staff to the list if it exists but wasn't scanned
    // Check both case variants for case-sensitive filesystems
    for (const dirName of ['Chief-of-Staff', 'chief-of-staff']) {
      try {
        // S4.1f: bounded EXIST probe — only ADDS the space to the migration list when
        // accessible; a reconnecting/error read → skip (no destructive action; the actual
        // per-space migration in `migrateLegacyAgentsMd` independently fails closed).
        await boundedAccess(path.join(root, dirName));
        spaces.unshift({
          name: 'Chief-of-Staff',
          path: dirName,
          absolutePath: path.join(root, dirName),
          type: 'chief-of-staff',
          isSymlink: false,
          hasReadme: false,
        });
        break;
      } catch {
        // Try next variant (missing / reconnecting / error)
      }
    }
  }
  
  // Migrate each space that has legacy AGENTS.md
  for (const space of spaces) {
    const configState = await getConfigFileState(space.absolutePath);
    
    // Only migrate if space has legacy AGENTS.md (with or without README.md)
    if (!configState.hasLegacyAgentsMd && !configState.hasBothConfigFiles) {
      continue;
    }
    
    const result = await migrateLegacyAgentsMd(space.absolutePath, { workspaceRoot: root });
    
    if (result.migrated) {
      summary.migrated++;
      summary.migratedPaths.push(space.path);
    } else if (result.backedUp) {
      summary.backedUp++;
      summary.backedUpPaths.push(space.path);
    } else if (!result.success) {
      summary.failed++;
      summary.failedPaths.push({ path: space.path, error: result.error || 'Unknown error' });
    }
    // If success but not migrated/backedUp, it was skipped (symlink, no agents.md, etc.) - don't count
  }
  
  // Log summary
  if (summary.migrated > 0 || summary.backedUp > 0 || summary.failed > 0) {
    logger.info(
      {
        migrated: summary.migrated,
        backedUp: summary.backedUp,
        failed: summary.failed,
        migratedPaths: summary.migratedPaths,
        backedUpPaths: summary.backedUpPaths,
      },
      'Completed startup migration of legacy AGENTS.md files'
    );
  }
  
  return summary;
};


// ============================================================================
// Space Link Resolution
// ============================================================================

/**
 * Resolve a space display name to a local SpaceInfo.
 *
 * Matches by display name (case-insensitive, trimmed), falling back to folder
 * name if the display name doesn't match. Logs a warning when multiple spaces
 * share the same display name.
 *
 * @param name - The display name to search for
 * @param coreDirectory - Workspace root directory
 * @returns The matching SpaceInfo, or null if no match found
 */
export const resolveSpaceByName = async (
  name: string,
  coreDirectory: string,
  preloadedSpaces?: SpaceInfo[]
): Promise<SpaceInfo | null> => {
  if (!name || !name.trim()) return null;

  const spaces = preloadedSpaces ?? await scanSpacesReadOnly(coreDirectory);
  const needle = name.trim().toLowerCase();

  // Pass 1: match by display name
  const displayMatches = spaces.filter(
    (s) => getSpaceDisplayName(s).trim().toLowerCase() === needle
  );

  if (displayMatches.length === 1) return displayMatches[0];

  if (displayMatches.length > 1) {
    logger.warn(
      { name, matchCount: displayMatches.length, paths: displayMatches.map((s) => s.path) },
      'Ambiguous space name: multiple spaces share the same display name'
    );
    return displayMatches[0];
  }

  // Pass 2: fall back to folder name
  const folderMatches = spaces.filter(
    (s) => s.name.toLowerCase() === needle
  );

  if (folderMatches.length === 1) return folderMatches[0];

  if (folderMatches.length > 1) {
    logger.warn(
      { name, matchCount: folderMatches.length, paths: folderMatches.map((s) => s.path) },
      'Ambiguous space name: multiple spaces share the same folder name'
    );
    return folderMatches[0];
  }

  return null;
};

/**
 * Resolve a space link target to an absolute path on disk.
 *
 * Validates:
 * - Space exists (by display name)
 * - Path stays within the space directory (no traversal)
 * - Target file/folder exists on disk
 * - Target type matches the link type (file vs folder)
 *
 * @param target - The parsed space link target
 * @param coreDirectory - Workspace root directory
 * @returns The resolved absolute path and space, or an error code
 */
export const resolveSpaceLink = async (
  target: { spaceName: string; filePath?: string; folderPath?: string },
  coreDirectory: string,
  preloadedSpaces?: SpaceInfo[]
): Promise<
  | { absolutePath: string; space: SpaceInfo }
  | { error: 'space-not-found' | 'file-not-found' | 'path-invalid' }
> => {
  const space = await resolveSpaceByName(target.spaceName, coreDirectory, preloadedSpaces);
  if (!space) return { error: 'space-not-found' };

  const relativePath = target.filePath || target.folderPath;

  // No sub-path → space root
  if (!relativePath) {
    return { absolutePath: space.absolutePath, space };
  }

  const absolutePath = path.join(space.absolutePath, relativePath);

  // Security: prevent path traversal — resolved path must be strictly inside
  // the space directory (prefix + separator check prevents /SpaceX matching /Space).
  if (
    !absolutePath.startsWith(space.absolutePath + path.sep) &&
    absolutePath !== space.absolutePath
  ) {
    return { error: 'path-invalid' };
  }

  // Verify the path exists. S4.1f: bounded read-only resolver — a reconnecting/error read
  // degrades to `file-not-found` (the link doesn't resolve; no write/delete follows).
  // isDirectory is a PROPERTY.
  try {
    const stat = await boundedStat(absolutePath);

    // Verify type matches the link intent
    if (target.filePath && stat.isDirectory) {
      return { error: 'path-invalid' };
    }
    if (target.folderPath && !stat.isDirectory) {
      return { error: 'path-invalid' };
    }
  } catch {
    return { error: 'file-not-found' };
  }

  return { absolutePath, space };
};

/**
 * Resolve a workspace-relative path by checking if the first segment matches a
 * known space display name. Handles cross-user link sharing where different
 * users have the same space mounted at different workspace-relative paths.
 *
 * For example, user A has `Exec/` at `Core/Exec/` while user B has it at
 * `Core/work/mindstone/Exec/`. A `rebel://library/Exec/memory/file.html` link
 * from user A won't resolve at `Core/Exec/` on user B's machine, but this
 * function finds the Exec space by display name and resolves against its
 * actual location.
 *
 * @param relativePath - Workspace-relative path (e.g. `Exec/memory/topics/file.html`)
 * @param coreDirectory - Workspace root directory
 * @param options - Optional preloaded spaces / lane-selection controls
 * @returns The resolved absolute path, or null if no space matches
 */
export interface ResolveViaSpaceNameOptions {
  preloadedSpaces?: SpaceInfo[];
  /**
   * If true, resolve through the read-only scan lane so path resolution in
   * pure read flows never triggers frontmatter auto-fixes.
   */
  useReadOnlyScan?: boolean;
}

export const resolveViaSpaceName = async (
  relativePath: string,
  coreDirectory: string,
  options?: ResolveViaSpaceNameOptions,
): Promise<string | null> => {
  const normalized = relativePath.replace(/\\/g, '/');
  const firstSlash = normalized.indexOf('/');
  if (firstSlash <= 0) return null;

  const firstSegment = normalized.slice(0, firstSlash);
  const rest = normalized.slice(firstSlash + 1);

  const preloadedSpaces = options?.preloadedSpaces
    ?? (options?.useReadOnlyScan ? await scanSpacesReadOnly(coreDirectory) : undefined);
  const space = await resolveSpaceByName(firstSegment, coreDirectory, preloadedSpaces);
  if (!space) return null;

  const resolved = path.join(space.absolutePath, rest);

  // Security: ensure the resolved path stays inside the space
  if (
    !resolved.startsWith(space.absolutePath + path.sep) &&
    resolved !== space.absolutePath
  ) {
    logger.warn(
      { relativePath, resolved, spaceRoot: space.absolutePath },
      'resolveViaSpaceName: path escapes space root',
    );
    return null;
  }

  logger.debug(
    { relativePath, spaceName: getSpaceDisplayName(space), resolved },
    'resolveViaSpaceName: resolved path via space name',
  );
  return resolved;
};

/**
 * Convert an absolute file path to a space link (reverse resolution).
 *
 * Uses `matchPathToSpace` to find which space the file belongs to, then
 * computes the workspace-relative path. Skips private spaces (chief-of-staff
 * or sharing=private) since those should not be shared externally.
 *
 * @param filePath - Absolute path to the file
 * @param coreDirectory - Workspace root directory
 * @returns The space name and relative path, or null if no match / private space
 */
export const filePathToSpaceLink = async (
  filePath: string,
  coreDirectory: string,
  preloadedSpaces?: SpaceInfo[]
): Promise<{ spaceName: string; relativePath: string } | null> => {
  if (!filePath) return null;

  const spaces = preloadedSpaces ?? await scanSpacesReadOnly(coreDirectory);

  const {
    matchPathToSpace,
    isShareableSpace,
    resolveMatchRoot,
    getCanonicalSpaceName,
  } = await import('../spacePathMatcher');

  const space = matchPathToSpace(filePath, spaces, coreDirectory);
  if (!space) return null;

  // Skip private spaces — not suitable for shareable links. `isShareableSpace`
  // is the single source of truth shared with `toBestFileLink` (renderer-side)
  // so desktop rendering and reverse-resolution always agree.
  if (!isShareableSpace(space)) return null;

  // Rebase from the actual matched root (sourcePath for symlinked spaces,
  // absolutePath otherwise) so symlinked-space file paths produce a valid
  // relative path rather than `../..` escape. Shared with `toBestFileLink`
  // — both surfaces compute the relative path identically now.
  const matchRoot = resolveMatchRoot(space, filePath);
  const relativePath = relativePortablePath(matchRoot, filePath);
  // Canonical space-name string — shared with `toBestFileLink` via
  // `getCanonicalSpaceName`. Previously this was `getSpaceDisplayName(space)`
  // inline; the helper replicates the same algorithm so renderer + main
  // agree byte-for-byte on the URL they emit for any given file.
  const spaceName = getCanonicalSpaceName(space);

  return { spaceName, relativePath };
};
// ============================================================================
// Memory Safety Cleanup - Stage 2: README.md memoryTrust field removal
// ============================================================================

/** Result of removing memoryTrust from a space's README.md */
export interface RemoveMemoryTrustResult {
  /** Whether the operation completed without errors */
  success: boolean;
  /** Whether memoryTrust was found and removed */
  removed: boolean;
  /** Reason the field was not removed (if not removed and not an error) */
  skipped?: 'no-readme' | 'no-frontmatter' | 'no-memorytrust';
  /** Error message if success is false */
  error?: string;
}

/**
 * Remove the memoryTrust field from a space's README.md frontmatter.
 * 
 * This is part of the memory safety architecture simplification (Stage 2).
 * The memoryTrust field in README.md was a security vulnerability because shared
 * files could override users' local safety preferences. Safety settings are now
 * stored locally only (in settings.spaceSafetyLevels).
 * 
 * The function is idempotent and designed to fail gracefully:
 * - If README.md doesn't exist: logs and returns success (no-op)
 * - If README.md has no frontmatter: logs and returns success (no-op)
 * - If memoryTrust doesn't exist: returns success (already clean)
 * - If write fails: logs warning and returns success=false with error
 * 
 * Security note: The security fix comes from IGNORING the memoryTrust field
 * in the resolution function (Stage 1), not from deleting it. This cleanup
 * is purely cosmetic to avoid confusion.
 * 
 * @param spacePath - Absolute path to the space directory
 * @returns Result with success flag and removal status
 */
export const removeMemoryTrustFromFrontmatter = async (
  spacePath: string,
  options?: SpaceWriteOperationOptions,
): Promise<RemoveMemoryTrustResult> => {
  const readmePath = path.join(spacePath, README_MD);
  const workspaceRoot = resolveWorkspaceRootForSpaceWrite(spacePath, options);
  
  // Read README.md content. S4.1f: bounded CAS pre-read — ENOENT→"no-readme" (success
  // no-op); a `reconnecting`/other error falls to the "other error" branch →
  // `{success:false}`, so a degraded mount NEVER proceeds to a write with stale content.
  let content: string;
  try {
    content = await boundedReadFileUtf8(readmePath);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      // README.md doesn't exist - nothing to clean
      logger.debug({ spacePath }, 'removeMemoryTrustFromFrontmatter: No README.md found');
      return { success: true, removed: false, skipped: 'no-readme' };
    }
    // Other error (permissions, reconnecting, etc.)
    const errorMsg = err instanceof Error ? err.message : 'Unknown error';
    logger.warn({ err, spacePath }, 'removeMemoryTrustFromFrontmatter: Failed to read README.md');
    return { success: false, removed: false, error: errorMsg };
  }
  
  // Check if content has frontmatter (starts with ---)
  if (!content.startsWith('---')) {
    logger.debug({ spacePath }, 'removeMemoryTrustFromFrontmatter: No frontmatter in README.md');
    return { success: true, removed: false, skipped: 'no-frontmatter' };
  }
  
  // Find the end of frontmatter
  const fmEndIndex = content.indexOf('\n---', 3);
  if (fmEndIndex === -1) {
    // Malformed frontmatter (no closing ---) - treat as no frontmatter
    logger.debug({ spacePath }, 'removeMemoryTrustFromFrontmatter: Malformed frontmatter (no closing ---)');
    return { success: true, removed: false, skipped: 'no-frontmatter' };
  }
  
  // Extract frontmatter block (excluding the --- delimiters)
  const frontmatterBlock = content.slice(4, fmEndIndex);
  const restOfContent = content.slice(fmEndIndex + 4); // +4 for '\n---'
  
  // Check if memoryTrust exists in frontmatter
  // Match lines like "memoryTrust: value" or "memoryTrust: 'value'" or "memoryTrust: \"value\""
  const memoryTrustPattern = /^memoryTrust:.*$/m;
  if (!memoryTrustPattern.test(frontmatterBlock)) {
    logger.debug({ spacePath }, 'removeMemoryTrustFromFrontmatter: No memoryTrust field found');
    return { success: true, removed: false, skipped: 'no-memorytrust' };
  }
  
  // Remove the memoryTrust line from frontmatter
  // Handle both "memoryTrust: value\n" and "memoryTrust: value" (at end)
  const cleanedFrontmatter = frontmatterBlock
    .replace(/^memoryTrust:.*\n?/m, '')
    // Clean up any trailing newline if memoryTrust was the last field
    .replace(/\n$/, '');
  
  // Reconstruct the file
  const newContent = `---\n${cleanedFrontmatter}\n---${restOfContent}`;
  
  // Write back to file
  try {
    await assertSpaceWriteSafeForWrite(workspaceRoot, spacePath, options?.writeSafetyOptions);
    await fs.writeFile(readmePath, newContent, 'utf-8');
    logger.info({ spacePath }, 'removeMemoryTrustFromFrontmatter: Removed memoryTrust field from README.md');
    return { success: true, removed: true };
  } catch (err) {
    if (err instanceof WriteOutsideWorkspaceError) {
      throw err;
    }
    const errorMsg = err instanceof Error ? err.message : 'Unknown error';
    logger.warn({ err, spacePath }, 'removeMemoryTrustFromFrontmatter: Failed to write README.md');
    return { success: false, removed: false, error: errorMsg };
  }
};

/** Summary of memoryTrust cleanup results */
export interface MemoryTrustCleanupSummary {
  /** Number of spaces where memoryTrust was removed */
  removed: number;
  /** Number of spaces where memoryTrust didn't exist (already clean) */
  alreadyClean: number;
  /** Number of spaces where cleanup failed */
  failed: number;
  /** Paths of spaces where memoryTrust was removed */
  removedPaths: string[];
  /** Paths of spaces where cleanup failed with error messages */
  failedPaths: { path: string; error: string }[];
}

/**
 * Clean up memoryTrust fields from all space README.md files.
 * 
 * This function should be called after the settings migration (Stage 1) has completed.
 * It iterates through all configured spaces and removes the memoryTrust field from
 * their README.md frontmatter.
 * 
 * The cleanup is:
 * - Fire-and-forget: Failures don't affect app operation
 * - Idempotent: Safe to run multiple times
 * - Non-blocking: Uses fire-and-forget pattern in index.ts
 * 
 * @param workspacePath - The workspace root directory
 * @param spaces - Array of space configs from settings (to know which spaces to clean)
 * @returns Summary of cleanup results for logging
 */
export const cleanupMemoryTrustFromAllSpaces = async (
  workspacePath: string,
  spaces: Array<{ path: string }>
): Promise<MemoryTrustCleanupSummary> => {
  const summary: MemoryTrustCleanupSummary = {
    removed: 0,
    alreadyClean: 0,
    failed: 0,
    removedPaths: [],
    failedPaths: [],
  };
  
  if (!workspacePath) {
    logger.warn('cleanupMemoryTrustFromAllSpaces: Empty workspace path');
    return summary;
  }
  
  const root = path.resolve(workspacePath);
  
  for (const space of spaces) {
    const absoluteSpacePath = path.join(root, space.path);
    
    const result = await removeMemoryTrustFromFrontmatter(absoluteSpacePath, { workspaceRoot: root });
    
    if (result.removed) {
      summary.removed++;
      summary.removedPaths.push(space.path);
    } else if (!result.success) {
      summary.failed++;
      summary.failedPaths.push({ path: space.path, error: result.error || 'Unknown error' });
    } else {
      // success but not removed = already clean (no readme, no frontmatter, or no memoryTrust)
      summary.alreadyClean++;
    }
  }
  
  // Log summary only if there were changes or failures
  if (summary.removed > 0 || summary.failed > 0) {
    logger.info(
      {
        removed: summary.removed,
        alreadyClean: summary.alreadyClean,
        failed: summary.failed,
        removedPaths: summary.removedPaths,
        failedPaths: summary.failedPaths.length > 0 ? summary.failedPaths : undefined,
      },
      'Completed memoryTrust cleanup from README.md files'
    );
  } else if (summary.alreadyClean > 0) {
    logger.debug({ alreadyClean: summary.alreadyClean }, 'All spaces already clean of memoryTrust');
  }
  
  return summary;
};

