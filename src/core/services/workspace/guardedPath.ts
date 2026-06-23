import { createHash } from 'node:crypto';
import path from 'node:path';
import { createScopedLogger } from '@core/logger';
import { workspaceFs, cloudLaneOptionForPath } from '@core/services/boundedWorkspaceFs';
import {
  WORKSPACE_NOT_CONFIGURED_MESSAGE,
  WORKSPACE_PATH_TRAVERSAL_MESSAGE,
} from '@core/workspaceFileSystem';

const log = createScopedLogger({ service: 'workspace-guard' });

export type WorkspaceFileSystemErrorCode =
  | 'OutOfRoot'
  | 'BrokenSymlink'
  | 'StatFailed'
  | 'ListDirFailed'
  | 'RealpathFailed'
  /**
   * S4.1b — the guarded resolver's underlying `realpath`/`lstat` hit a cloud mount
   * that did not respond within the boundary budget (the killable child pool reclaimed
   * it). This is "cloud temporarily unavailable", NOT absence: callers MUST retain /
   * surface "reconnecting" / treat the node as unavailable — they must NOT interpret it
   * as a missing path (e.g. `exists()` MUST rethrow, never map it to `false`). Distinct
   * from `BrokenSymlink` (a genuinely-gone target) precisely so that distinction holds.
   */
  | 'CloudReconnecting'
  | 'NotConfigured';

export class WorkspaceFileSystemError extends Error {
  public readonly code: WorkspaceFileSystemErrorCode;

  constructor(
    code: WorkspaceFileSystemErrorCode,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = 'WorkspaceFileSystemError';
    this.code = code;
  }
}

export interface WorkspaceFileSystemConfig {
  workspaceRoot: string;
  allowOutOfRootSymlinks: boolean;
  surface?: 'electron' | 'cloud' | 'core';
}

export interface ResolveGuardedPathOptions extends WorkspaceFileSystemConfig {
  allowMissingLeaf?: boolean;
}

export function ensureWorkspaceRoot(workspaceRoot: string): string {
  if (typeof workspaceRoot !== 'string' || workspaceRoot.trim().length === 0) {
    throw new WorkspaceFileSystemError('NotConfigured', WORKSPACE_NOT_CONFIGURED_MESSAGE);
  }
  return path.resolve(workspaceRoot);
}

export function normalizeTargetPath(targetPath: string): string {
  if (typeof targetPath !== 'string') {
    throw new WorkspaceFileSystemError('OutOfRoot', WORKSPACE_PATH_TRAVERSAL_MESSAGE);
  }
  const trimmed = targetPath.trim();
  return trimmed.length > 0 ? trimmed : '.';
}

export function isPathInRoot(realPath: string, workspaceRoot: string): boolean {
  const relative = path.relative(path.resolve(workspaceRoot), path.resolve(realPath));
  if (relative === '') return true;
  return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

export function assertPathInRoot(realPath: string, workspaceRoot: string): void {
  if (!isPathInRoot(realPath, workspaceRoot)) {
    throw new WorkspaceFileSystemError('OutOfRoot', WORKSPACE_PATH_TRAVERSAL_MESSAGE);
  }
}

function isBrokenSymlinkError(error: NodeJS.ErrnoException): boolean {
  return error.code === 'ENOENT' || error.code === 'ENOTDIR';
}

function assertSafeMissingLeafName(candidatePath: string): void {
  const leafName = path.basename(candidatePath);
  if (leafName === '..' || path.isAbsolute(leafName)) {
    throw new WorkspaceFileSystemError('OutOfRoot', WORKSPACE_PATH_TRAVERSAL_MESSAGE);
  }
}

function fingerprintPathForLog(filePath: string): string {
  return createHash('sha256').update(filePath).digest('hex').slice(0, 8);
}

const WORKSPACE_GUARD_DEDUP_CAP = 16384;
const seenWorkspaceGuardOutOfRootKeys = new Set<string>();

// Suppresses repeat out-of-root guard debug logs for an already-seen
// `${surface}:${fingerprint}` key. The 8-hex fingerprint (see
// fingerprintPathForLog) is sized for log-volume control, not collision
// resistance — a rare fingerprint collision only means a distinct out-of-root
// path goes un-logged once. This is debug-only telemetry and never gates path
// validation (the allow/reject decision is made before this is consulted).
function shouldEmitOutOfRootGuardLog(surface: string, realPathFingerprint: string): boolean {
  const key = `${surface}:${realPathFingerprint}`;
  if (seenWorkspaceGuardOutOfRootKeys.has(key)) {
    return false;
  }
  if (seenWorkspaceGuardOutOfRootKeys.size >= WORKSPACE_GUARD_DEDUP_CAP) {
    const oldest = seenWorkspaceGuardOutOfRootKeys.values().next().value;
    if (oldest !== undefined) {
      seenWorkspaceGuardOutOfRootKeys.delete(oldest);
    }
  }
  seenWorkspaceGuardOutOfRootKeys.add(key);
  return true;
}

export function resetWorkspaceGuardLogDedupForTesting(): void {
  seenWorkspaceGuardOutOfRootKeys.clear();
}

export async function findClosestExistingPath(
  candidatePath: string,
  workspaceRoot: string,
): Promise<string> {
  const resolvedRoot = ensureWorkspaceRoot(workspaceRoot);
  let current = path.resolve(candidatePath);

  while (true) {
    // S4.1b: lstat via the bounded boundary (local lane = bare fs, byte-identical;
    // cloud lane = killable pool). `ok` → this ancestor exists; `error` keeps the
    // exact prior semantics (ENOENT → walk up, anything else → StatFailed);
    // `reconnecting` → cloud-unavailable (NOT "missing", so we never silently walk
    // PAST a dir that merely went unreachable).
    const outcome = await workspaceFs.lstat(current, cloudLaneOptionForPath(current));
    if (outcome.status === 'ok') {
      return current;
    }
    if (outcome.status === 'reconnecting') {
      throw new WorkspaceFileSystemError(
        'CloudReconnecting',
        `cloud mount unavailable while resolving "${path.basename(current)}"`,
      );
    }
    if (outcome.error.code !== 'ENOENT') {
      throw new WorkspaceFileSystemError('StatFailed', outcome.error.message, { cause: outcome.error });
    }

    if (current === resolvedRoot) {
      return resolvedRoot;
    }

    const parent = path.dirname(current);
    if (parent === current) {
      return resolvedRoot;
    }
    current = parent;
  }
}

/**
 * Resolve the real path for an in-workspace candidate.
 *
 * The candidate may be absolute or workspace-relative. Relative candidates are
 * resolved against `workspaceRoot`. Lexical out-of-root candidates are always
 * rejected; `allowOutOfRootSymlinks` only controls whether an in-root symlink
 * whose final realpath is outside the root is accepted.
 */
export async function getRealPathStrict(
  candidatePath: string,
  config: WorkspaceFileSystemConfig,
): Promise<string> {
  const workspaceRoot = ensureWorkspaceRoot(config.workspaceRoot);
  const absoluteCandidate = path.isAbsolute(candidatePath)
    ? path.resolve(candidatePath)
    : path.resolve(workspaceRoot, candidatePath);

  assertPathInRoot(absoluteCandidate, workspaceRoot);

  // S4.1b: both realpaths via the bounded boundary. This is the FIRST mount-touching
  // op in the guarded read path (it runs before the impl's stat/readdir), so it is the
  // real dead-cloud-mount hang vector. Local lane = bare fs (byte-identical canonical
  // result → symlink-escape `isPathInRoot` checks below are unchanged); cloud lane =
  // killable pool. Error mapping preserved exactly; `reconnecting` → CloudReconnecting.
  let realRoot: string;
  const rootOutcome = await workspaceFs.realpath(workspaceRoot, cloudLaneOptionForPath(workspaceRoot));
  if (rootOutcome.status === 'ok') {
    realRoot = rootOutcome.value;
  } else if (rootOutcome.status === 'reconnecting') {
    throw new WorkspaceFileSystemError('CloudReconnecting', 'cloud mount unavailable while resolving workspace root');
  } else {
    throw new WorkspaceFileSystemError('RealpathFailed', rootOutcome.error.message, { cause: rootOutcome.error });
  }

  let realPath: string;
  const candidateOutcome = await workspaceFs.realpath(absoluteCandidate, cloudLaneOptionForPath(absoluteCandidate));
  if (candidateOutcome.status === 'ok') {
    realPath = candidateOutcome.value;
  } else if (candidateOutcome.status === 'reconnecting') {
    throw new WorkspaceFileSystemError('CloudReconnecting', 'cloud mount unavailable while resolving workspace path');
  } else {
    const code = isBrokenSymlinkError(candidateOutcome.error) ? 'BrokenSymlink' : 'RealpathFailed';
    throw new WorkspaceFileSystemError(code, candidateOutcome.error.message, { cause: candidateOutcome.error });
  }

  if (!isPathInRoot(realPath, realRoot)) {
    if (config.allowOutOfRootSymlinks) {
      const surface = config.surface ?? 'core';
      const realPathFingerprint = fingerprintPathForLog(realPath);
      if (shouldEmitOutOfRootGuardLog(surface, realPathFingerprint)) {
        log.debug(
          {
            surface,
            wasOutOfRoot: true,
            candidateRelative: path.relative(workspaceRoot, absoluteCandidate) || '.',
            realPathFingerprint,
          },
          'workspace-guard: allowing in-root symlink with realpath outside workspace root',
        );
      }
      return realPath;
    }
    throw new WorkspaceFileSystemError('OutOfRoot', WORKSPACE_PATH_TRAVERSAL_MESSAGE);
  }

  return realPath;
}

async function resolveMissingLeafPath(
  candidatePath: string,
  options: ResolveGuardedPathOptions,
): Promise<string> {
  const workspaceRoot = ensureWorkspaceRoot(options.workspaceRoot);

  // S4.1b: lstat via the bounded boundary. `ok` → the leaf unexpectedly exists (a
  // symlink → refuse to write through it; otherwise unresolvable) — same as before.
  // `error` ENOENT/ENOTDIR → the leaf is genuinely missing (proceed to the write
  // carve-out); any other error → StatFailed. `reconnecting` → cloud-unavailable
  // (NOT "missing" → never let a dead mount be mistaken for a writable missing leaf).
  const leafOutcome = await workspaceFs.lstat(candidatePath, cloudLaneOptionForPath(candidatePath));
  if (leafOutcome.status === 'ok') {
    if (leafOutcome.value.isSymbolicLink) {
      throw new WorkspaceFileSystemError('BrokenSymlink', 'Refusing to write through a broken symlink');
    }
    throw new WorkspaceFileSystemError('BrokenSymlink', 'Unable to resolve existing workspace path');
  }
  if (leafOutcome.status === 'reconnecting') {
    throw new WorkspaceFileSystemError('CloudReconnecting', 'cloud mount unavailable while resolving workspace write path');
  }
  if (leafOutcome.error.code !== 'ENOENT' && leafOutcome.error.code !== 'ENOTDIR') {
    throw new WorkspaceFileSystemError('StatFailed', leafOutcome.error.message, { cause: leafOutcome.error });
  }

  assertSafeMissingLeafName(candidatePath);

  const closestExistingParent = await findClosestExistingPath(path.dirname(candidatePath), workspaceRoot);
  await getRealPathStrict(closestExistingParent, {
    ...options,
    workspaceRoot,
    allowOutOfRootSymlinks: false,
  });

  log.debug(
    {
      candidatePath,
      workspaceRoot,
      closestExistingParent,
      surface: options.surface ?? 'core',
    },
    'workspace-guard: allowing missing leaf for workspace write',
  );
  return candidatePath;
}

export async function resolveGuardedPath(
  targetPath: string,
  options: ResolveGuardedPathOptions,
): Promise<string> {
  const workspaceRoot = ensureWorkspaceRoot(options.workspaceRoot);
  const normalizedTarget = normalizeTargetPath(targetPath);
  if (path.isAbsolute(normalizedTarget)) {
    throw new WorkspaceFileSystemError('OutOfRoot', WORKSPACE_PATH_TRAVERSAL_MESSAGE);
  }

  const candidatePath = path.resolve(workspaceRoot, normalizedTarget);
  assertPathInRoot(candidatePath, workspaceRoot);

  const pathToCheck = options.allowMissingLeaf
    ? await findClosestExistingPath(candidatePath, workspaceRoot)
    : candidatePath;

  try {
    await getRealPathStrict(pathToCheck, options);
  } catch (error) {
    if (
      options.allowMissingLeaf &&
      error instanceof WorkspaceFileSystemError &&
      error.code === 'BrokenSymlink'
    ) {
      return resolveMissingLeafPath(candidatePath, options);
    }
    throw error;
  }

  return candidatePath;
}
