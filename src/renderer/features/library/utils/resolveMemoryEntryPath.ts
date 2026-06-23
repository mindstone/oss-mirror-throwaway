import type { SpaceInfo } from '@shared/ipc/schemas/library';

export type ResolvedMemoryPath = {
  absolutePath: string;
  workspaceRelative: string;
  /** True when the originally-recorded relative path didn't resolve directly and a fallback candidate matched. */
  repaired: boolean;
  /** The relative path actually used (post-repair if applicable). */
  effectiveRelativePath: string;
};

type PathCandidate = {
  absolutePath: string;
  relativePath: string;
  fromRecorded: boolean;
};

const MEMORY_PATH_PREFIX = /^memory\//i;
const MAX_FALLBACK_SPACES = 5;

function toPortablePath(value: string): string {
  return value.replace(/\\/g, '/');
}

function trimTrailingSlashes(value: string): string {
  return value.replace(/\/+$/, '');
}

function trimLeadingSlashes(value: string): string {
  return value.replace(/^\/+/, '');
}

function joinPortablePath(basePath: string, relativePath: string): string {
  const normalizedBase = trimTrailingSlashes(toPortablePath(basePath));
  const normalizedRelative = trimLeadingSlashes(toPortablePath(relativePath));
  if (!normalizedBase) {
    return normalizedRelative;
  }
  if (!normalizedRelative) {
    return normalizedBase;
  }
  return `${normalizedBase}/${normalizedRelative}`;
}

function isAbsolutePath(candidate: string): boolean {
  return /^(?:[a-zA-Z]:[\\/]|\/|\\\\)/.test(candidate);
}

function toWorkspaceRelativePath(absolutePath: string, workspaceRoot: string): string | null {
  const normalizedAbsolute = toPortablePath(absolutePath);
  const normalizedRoot = trimTrailingSlashes(toPortablePath(workspaceRoot));
  if (!normalizedRoot) {
    return null;
  }

  const lowerAbsolute = normalizedAbsolute.toLowerCase();
  const lowerRoot = normalizedRoot.toLowerCase();

  if (lowerAbsolute === lowerRoot) {
    return '';
  }

  if (!lowerAbsolute.startsWith(`${lowerRoot}/`)) {
    return null;
  }

  return normalizedAbsolute.slice(normalizedRoot.length + 1);
}

function normalizeNameForMatch(candidate: string | undefined): string {
  if (!candidate) return '';
  return toPortablePath(candidate)
    .toLowerCase()
    .replace(/[-_/]+/g, ' ')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function matchesEntity(space: SpaceInfo, entity: string): boolean {
  const normalizedEntity = normalizeNameForMatch(entity);
  if (!normalizedEntity) {
    return false;
  }

  const candidateNames = new Set<string>([
    normalizeNameForMatch(space.displayName),
    normalizeNameForMatch(space.name),
    ...toPortablePath(space.path)
      .split('/')
      .map((segment) => normalizeNameForMatch(segment)),
  ]);

  candidateNames.delete('');
  return candidateNames.has(normalizedEntity);
}

function buildCandidates(params: {
  recordedFilePath: string;
  entity: string;
  libraryRootAbsolute: string;
  spaces: readonly SpaceInfo[];
}): PathCandidate[] {
  const candidates: PathCandidate[] = [];
  const seen = new Set<string>();
  const recorded = toPortablePath(params.recordedFilePath).trim();
  const root = toPortablePath(params.libraryRootAbsolute);

  const addRelativeCandidate = (relativePath: string, fromRecorded: boolean): void => {
    const normalizedRelative = trimLeadingSlashes(toPortablePath(relativePath)).trim();
    if (!normalizedRelative) return;

    const key = `relative:${normalizedRelative}`;
    if (seen.has(key)) return;
    seen.add(key);

    candidates.push({
      absolutePath: joinPortablePath(root, normalizedRelative),
      relativePath: normalizedRelative,
      fromRecorded,
    });
  };

  const addAbsoluteCandidate = (absolutePath: string, fromRecorded: boolean): void => {
    const normalizedAbsolute = toPortablePath(absolutePath).trim();
    if (!normalizedAbsolute) return;

    const key = `absolute:${normalizedAbsolute}`;
    if (seen.has(key)) return;
    seen.add(key);

    const relativeFromRoot = toWorkspaceRelativePath(normalizedAbsolute, root);
    candidates.push({
      absolutePath: normalizedAbsolute,
      relativePath: relativeFromRoot ?? normalizedAbsolute,
      fromRecorded,
    });
  };

  if (isAbsolutePath(recorded)) {
    addAbsoluteCandidate(recorded, true);
    const relativeFromRoot = toWorkspaceRelativePath(recorded, root);
    if (relativeFromRoot) {
      addRelativeCandidate(relativeFromRoot, true);
    }
  } else {
    addRelativeCandidate(recorded, true);
  }

  const recordedRelative = isAbsolutePath(recorded)
    ? (toWorkspaceRelativePath(recorded, root) ?? '')
    : trimLeadingSlashes(recorded);

  if (recordedRelative && MEMORY_PATH_PREFIX.test(recordedRelative)) {
    const matchingSpaces = params.spaces.filter((space) => matchesEntity(space, params.entity));
    const matchedPaths = new Set(matchingSpaces.map((space) => space.path));
    const fallbackSpaces = params.spaces
      .filter((space) => !matchedPaths.has(space.path))
      .slice(0, MAX_FALLBACK_SPACES);

    for (const space of [...matchingSpaces, ...fallbackSpaces]) {
      addRelativeCandidate(`${space.path}/${recordedRelative}`, false);
    }
  }

  if (recordedRelative) {
    const lowerRecorded = recordedRelative.toLowerCase();
    for (const space of params.spaces) {
      const normalizedSpacePath = trimLeadingSlashes(toPortablePath(space.path));
      const lowerSpacePath = normalizedSpacePath.toLowerCase();
      if (!lowerRecorded.startsWith(lowerSpacePath)) {
        continue;
      }
      if (recordedRelative === normalizedSpacePath || recordedRelative.startsWith(`${normalizedSpacePath}/`)) {
        continue;
      }
      const suffix = recordedRelative.slice(normalizedSpacePath.length).replace(/^\/+/, '');
      const normalizedCandidate = suffix
        ? `${normalizedSpacePath}/${suffix}`
        : normalizedSpacePath;
      addRelativeCandidate(normalizedCandidate, false);
    }
  }

  return candidates;
}

/**
 * Resolve the on-disk location of a memory entry whose recorded filePath may be
 * missing a space-directory prefix.
 */
export async function resolveMemoryEntryPath(params: {
  recordedFilePath: string;
  entity: string;
  libraryRootAbsolute: string;
  spaces: readonly SpaceInfo[];
}): Promise<ResolvedMemoryPath | null> {
  const recordedPath = params.recordedFilePath.trim();
  if (!recordedPath) {
    return null;
  }

  if (typeof window === 'undefined' || typeof window.libraryApi?.statFile !== 'function') {
    return null;
  }

  const candidates = buildCandidates(params);

  for (const candidate of candidates) {
    let statResult: { exists: boolean } | null = null;
    try {
      statResult = await window.libraryApi.statFile(candidate.absolutePath);
    } catch {
      statResult = null;
    }

    if (!statResult?.exists) {
      continue;
    }

    const workspaceRelative = toWorkspaceRelativePath(candidate.absolutePath, params.libraryRootAbsolute)
      ?? candidate.relativePath;

    return {
      absolutePath: candidate.absolutePath,
      workspaceRelative,
      repaired: !candidate.fromRecorded,
      effectiveRelativePath: workspaceRelative,
    };
  }

  return null;
}
