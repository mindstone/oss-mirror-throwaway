import path from 'pathe';
import { createScopedLogger } from '@core/logger';
import { matchPathToSpace, resolveMatchRoot, getCanonicalSpaceName } from '@core/services/spacePathMatcher';
import { toPortablePath } from '@core/utils/portablePath';
import { classifyUnmatchedPath } from '@core/services/safety/classifyUnmatchedPath';
import type { SpaceInfo } from '@shared/ipc/schemas/library';
import type { FileLocation } from '@rebel/shared';

const log = createScopedLogger({ service: 'fileLocation' });
const SPACE_CACHE_TTL_MS = 5_000;

interface SpaceCacheEntry {
  spaces: readonly SpaceInfo[];
  expiresAt: number;
}

const scannedSpacesCache = new Map<string, SpaceCacheEntry>();

export interface ResolveFileLocationOptions {
  coreDirectory?: string;
  absolutePath?: string;
  /**
   * Optional scanner hook for callers that want resolver-managed 5s caching.
   * Stage 1 keeps deterministic behavior by default: callers may pass explicit
   * `spaces` and omit this callback.
   */
  scanSpacesFn?: (coreDirectory: string) => Promise<readonly SpaceInfo[]>;
}

type FileLocationResolverErrorCode =
  | 'invalid-input'
  | 'missing-basename'
  | 'folder-only-path'
  | 'invalid-space-relative-path';

export class FileLocationResolverError extends Error {
  readonly code: FileLocationResolverErrorCode;
  readonly inputPath: string;

  constructor(code: FileLocationResolverErrorCode, inputPath: string, message: string) {
    super(message);
    this.name = 'FileLocationResolverError';
    this.code = code;
    this.inputPath = inputPath;
  }
}

function toTrimmedNonEmpty(value: string | undefined): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function normalizePathLike(value: string): string {
  const normalized = path.normalize(toPortablePath(value)).replace(/\/+/g, '/');
  if (normalized === '/') {
    return normalized;
  }
  return normalized.replace(/\/+$/, '');
}

function normalizeCoreDirectory(value: string | undefined): string | undefined {
  const trimmed = toTrimmedNonEmpty(value);
  if (!trimmed) {
    return undefined;
  }
  const normalized = normalizePathLike(trimmed);
  return normalized === '.' ? undefined : normalized;
}

function normalizeInputPath(inputPath: string): string {
  const normalized = normalizePathLike(inputPath);
  if (normalized === '') {
    return '.';
  }
  return normalized;
}

function isEscapingPath(value: string): boolean {
  const portable = normalizePathLike(toPortablePath(value));
  return portable === '..'
    || portable.startsWith('../')
    || portable.includes('/../')
    || portable.endsWith('/..');
}

function hasValidBasename(inputPath: string): boolean {
  const baseName = path.basename(inputPath);
  if (!baseName) {
    return false;
  }
  if (baseName === '/' || baseName === '.' || baseName === '..') {
    return false;
  }
  return baseName.trim().length > 0;
}

async function getSpacesSnapshot(
  spaces: readonly SpaceInfo[],
  coreDirectory: string | undefined,
  scanSpacesFn: ResolveFileLocationOptions['scanSpacesFn'],
): Promise<readonly SpaceInfo[]> {
  if (!scanSpacesFn || !coreDirectory) {
    return spaces;
  }

  const now = Date.now();
  const cached = scannedSpacesCache.get(coreDirectory);
  if (cached && cached.expiresAt > now) {
    return cached.spaces;
  }

  const scannedSpaces = await scanSpacesFn(coreDirectory);
  scannedSpacesCache.set(coreDirectory, {
    spaces: scannedSpaces,
    expiresAt: now + SPACE_CACHE_TTL_MS,
  });
  return scannedSpaces;
}

function buildInSpaceLocation(args: {
  normalizedInputPath: string;
  resolvedAbsolutePath: string | undefined;
  matchedSpace: SpaceInfo;
  coreDirectory: string | undefined;
  providedAbsolutePath: string | undefined;
}): FileLocation {
  const absolutePathForRelative = args.resolvedAbsolutePath
    ?? (path.isAbsolute(args.normalizedInputPath)
      ? args.normalizedInputPath
      : args.coreDirectory
        ? normalizePathLike(path.resolve(args.coreDirectory, args.normalizedInputPath))
        : undefined);

  const spaceWorkspacePath = normalizePathLike(args.matchedSpace.path);
  if (!spaceWorkspacePath || spaceWorkspacePath === '.') {
    throw new FileLocationResolverError(
      'invalid-space-relative-path',
      args.normalizedInputPath,
      `Cannot derive file location because space path is invalid: "${args.matchedSpace.path}"`,
    );
  }

  const spaceRelativePathCandidate = absolutePathForRelative
    ? normalizeInputPath(
      path.relative(
        normalizePathLike(resolveMatchRoot(args.matchedSpace, absolutePathForRelative)),
        absolutePathForRelative,
      ),
    )
    : normalizeInputPath(path.relative(spaceWorkspacePath, args.normalizedInputPath));

  if (!spaceRelativePathCandidate || spaceRelativePathCandidate === '.') {
    throw new FileLocationResolverError(
      'folder-only-path',
      args.normalizedInputPath,
      `File location resolver requires a file path, but received a space root path: "${args.normalizedInputPath}"`,
    );
  }
  if (isEscapingPath(spaceRelativePathCandidate)) {
    throw new FileLocationResolverError(
      'invalid-space-relative-path',
      args.normalizedInputPath,
      `Matched space produced an invalid relative path: "${spaceRelativePathCandidate}"`,
    );
  }
  if (!hasValidBasename(spaceRelativePathCandidate)) {
    throw new FileLocationResolverError(
      'missing-basename',
      args.normalizedInputPath,
      `Resolved space-relative path has no valid basename: "${spaceRelativePathCandidate}"`,
    );
  }

  const fileName = path.basename(spaceRelativePathCandidate);
  const workspaceRelativePath = path.posix.join(spaceWorkspacePath, spaceRelativePathCandidate);

  return {
    kind: 'in-space',
    spaceName: getCanonicalSpaceName(args.matchedSpace),
    spaceWorkspacePath,
    spaceRelativePath: spaceRelativePathCandidate,
    workspaceRelativePath,
    fileName,
    absolutePath: args.providedAbsolutePath ?? absolutePathForRelative,
  };
}

/**
 * Resolve canonical file location metadata from a candidate destination path.
 *
 * This resolver logs every fallback to `outside-workspace`; per-key warning
 * deduplication belongs to caller scope (Stage 2). The optional `scanSpacesFn`
 * hook is cache-backed (5s TTL) and opt-in to keep Stage 1 deterministic.
 */
export async function resolveFileLocation(
  workspaceRelativePath: string,
  spaces: readonly SpaceInfo[],
  opts: ResolveFileLocationOptions = {},
): Promise<FileLocation> {
  const trimmedInput = toTrimmedNonEmpty(workspaceRelativePath);
  if (!trimmedInput) {
    throw new FileLocationResolverError(
      'invalid-input',
      workspaceRelativePath,
      'File location resolver requires a non-empty path input.',
    );
  }

  const normalizedInputPath = normalizeInputPath(trimmedInput);
  if (normalizedInputPath === '.' || normalizedInputPath === './') {
    throw new FileLocationResolverError(
      'invalid-input',
      workspaceRelativePath,
      `File location resolver requires a file path, but received "${workspaceRelativePath}".`,
    );
  }

  const coreDirectory = normalizeCoreDirectory(opts.coreDirectory);
  const providedAbsolutePath = toTrimmedNonEmpty(opts.absolutePath)
    ? normalizePathLike(opts.absolutePath as string)
    : undefined;

  const spacesSnapshot = await getSpacesSnapshot(spaces, coreDirectory, opts.scanSpacesFn);
  const coreDirectoryForMatch = coreDirectory ?? '';

  let matchedSpace = matchPathToSpace(normalizedInputPath, spacesSnapshot, coreDirectoryForMatch);

  let resolvedAbsolutePath = providedAbsolutePath
    ?? (path.isAbsolute(normalizedInputPath) ? normalizedInputPath : undefined);

  if (!matchedSpace && coreDirectory) {
    const absoluteFromCore = normalizePathLike(path.resolve(coreDirectory, normalizedInputPath));
    if (!resolvedAbsolutePath) {
      resolvedAbsolutePath = absoluteFromCore;
    }
    matchedSpace = matchPathToSpace(absoluteFromCore, spacesSnapshot, coreDirectory);
  }

  if (matchedSpace) {
    return buildInSpaceLocation({
      normalizedInputPath,
      resolvedAbsolutePath,
      matchedSpace,
      coreDirectory,
      providedAbsolutePath,
    });
  }

  const fallbackClassificationPath = resolvedAbsolutePath ?? normalizedInputPath;
  const absolutePath = providedAbsolutePath
    ?? resolvedAbsolutePath
    ?? (coreDirectory
      ? normalizePathLike(path.resolve(coreDirectory, normalizedInputPath))
      : normalizePathLike(path.resolve(normalizedInputPath)));

  if (!hasValidBasename(absolutePath)) {
    throw new FileLocationResolverError(
      'missing-basename',
      workspaceRelativePath,
      `Resolved outside-workspace path has no valid basename: "${absolutePath}"`,
    );
  }

  const fileName = path.basename(absolutePath);
  const classification = isEscapingPath(normalizedInputPath)
    ? { classification: 'outside' as const, displayLabel: 'Outside workspace' }
    : classifyUnmatchedPath(fallbackClassificationPath, coreDirectory);

  log.warn(
    {
      pendingDestination: workspaceRelativePath,
      originalSpace: undefined,
      coreDirectory,
    },
    'FileLocation derivation fell back to outside-workspace',
  );

  return {
    kind: 'outside-workspace',
    absolutePath,
    fileName,
    outsideCategory: classification.classification,
  };
}
