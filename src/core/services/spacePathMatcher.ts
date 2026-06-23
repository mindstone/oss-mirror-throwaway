/**
 * Space Path Matcher — pure path-matching logic extracted from memoryWriteHook
 * to break the spaceService↔memoryWriteHook circular dependency.
 *
 * Uses SpaceInfo from @shared (not from spaceService) to avoid import cycles.
 * Imports `pathe` (instead of `node:path`) so this module is usable in the
 * renderer — `toBestFileLink` pulls `matchPathToSpace` / `resolveMatchRoot`
 * into MessageMarkdown preprocessors and remark plugins.
 *
 * @see docs/plans/260330_strengthen_de_electronification.md — migrated from src/main/services/ (Stage 2b)
 * @see docs/plans/260418_finish_cross_surface_links_closeout.md — Stage 1
 */

import path from 'pathe';
import type { SpaceType } from '@shared/ipc/schemas/library';
import { toPortablePath } from '@core/utils/portablePath';

/** Minimal fields matchPathToSpace needs from any SpaceInfo-like object. */
interface SpacePathInfo {
  path: string;
  absolutePath: string;
  sourcePath?: string;
}

/** Minimal fields `resolveMatchRoot` needs — a subset of `SpacePathInfo`. */
interface MatchRootInfo {
  absolutePath: string;
  sourcePath?: string;
}

/**
 * Minimal fields `isShareableSpace` needs. Accepts both
 * `SpaceInfo` from `@shared/ipc/schemas/library` (has top-level `sharing`)
 * and the richer `SpaceInfo` from `src/main/services/spaceService.ts`
 * (has nested `frontmatter.sharing`). Structural typing makes both compile.
 */
interface ShareabilityInfo {
  type: SpaceType;
  sharing?: string;
  frontmatter?: { sharing?: string | undefined } | undefined;
}

/**
 * Minimal fields `getCanonicalSpaceName` needs — structural subset of both
 * the main-side `SpaceInfo` (spaceService.ts) and the shared-side `SpaceInfo`
 * (@shared/ipc/schemas/library). Both surfaces carry `displayName` as a
 * top-level string populated from frontmatter.
 */
interface SpaceNameInfo {
  name: string;
  displayName?: string | undefined;
  type: SpaceType;
}

function normalizePortablePathForMatch(inputPath: string): string {
  const portable = toPortablePath(inputPath).replace(/\/+/g, '/');
  const normalized = path.posix.normalize(portable);
  if (normalized === '.') return '';
  return normalized
    .replace(/^\.\//, '')
    .replace(/\/$/, '');
}

/**
 * Match file path to space using longest prefix match.
 * Supports both absolute and relative paths, including symlink targets.
 *
 * Generic over T so callers using different SpaceInfo definitions
 * (e.g., from spaceService vs @shared/ipc/schemas/library) all work.
 *
 * `spaces` accepts `readonly T[]` so renderer callers (`toBestFileLink`)
 * can pass their immutable cached snapshots without an unsafe cast. We
 * never mutate `spaces` internally, so widening is safe.
 */
export function matchPathToSpace<T extends SpacePathInfo>(filePath: string, spaces: readonly T[], coreDirectory: string): T | null {
  // Normalize path: backslashes, repeated slashes, leading './', trailing slashes
  const normalized = normalizePortablePathForMatch(filePath).toLowerCase();
  const coreNormalizedRaw = normalizePortablePathForMatch(coreDirectory);
  
  let bestMatch: T | null = null;
  let bestMatchLength = 0;
  
  for (const space of spaces) {
    const spacePathRaw = normalizePortablePathForMatch(space.path);
    const spacePath = spacePathRaw.toLowerCase();
    const absPath = normalizePortablePathForMatch(space.absolutePath).toLowerCase();
    
    // 1. Try matching against workspace-relative path directly (e.g., "work/Company/Space/...")
    //    This is the most common case when tool input contains relative paths
    if (normalized.startsWith(spacePath + '/') || normalized === spacePath) {
      if (spacePath.length > bestMatchLength) {
        bestMatch = space;
        bestMatchLength = spacePath.length;
      }
    }
    
    // 2. Try matching against absolute path (e.g., "/Users/.../workspace/work/...")
    if (normalized.startsWith(absPath + '/') || normalized === absPath) {
      if (absPath.length > bestMatchLength) {
        bestMatch = space;
        bestMatchLength = absPath.length;
      }
    }
    
    // 3. Try matching against coreDirectory-prefixed relative path
    //    (for paths like "/path/to/coreDir/work/Company/Space/...")
    const fullSpacePath = normalizePortablePathForMatch(path.posix.join(coreNormalizedRaw, spacePathRaw)).toLowerCase();
    if (normalized.startsWith(fullSpacePath + '/') || normalized === fullSpacePath) {
      if (fullSpacePath.length > bestMatchLength) {
        bestMatch = space;
        bestMatchLength = fullSpacePath.length;
      }
    }
    
    // 4. Try matching against sourcePath for symlinked spaces
    //    (e.g., "/Users/.../Library/CloudStorage/GoogleDrive-.../My Drive/personal/...")
    //    This handles the case where tools report the resolved symlink target path
    if (space.sourcePath) {
      // Resolve to absolute path in case sourcePath is relative (from fs.readlink on external symlinks)
      const resolvedSource = path.isAbsolute(space.sourcePath) 
        ? space.sourcePath 
        : path.resolve(space.absolutePath, '..', space.sourcePath);
      const sourceNormalized = normalizePortablePathForMatch(resolvedSource).toLowerCase();
      if (normalized.startsWith(sourceNormalized + '/') || normalized === sourceNormalized) {
        if (sourceNormalized.length > bestMatchLength) {
          bestMatch = space;
          bestMatchLength = sourceNormalized.length;
        }
      }
    }
  }
  
  return bestMatch;
}

/**
 * Resolve the root path against which a space-matched absolute path should be
 * rebased. When a space has a symlink `sourcePath` AND the absolute path is
 * under it, we rebase from `sourcePath` so space-relative URLs work for files
 * reported via the resolved target path (e.g., Google Drive mounts). Otherwise
 * we rebase from `absolutePath`.
 *
 * This is a sibling of `matchPathToSpace` rather than a change to its return
 * shape so existing consumers (memoryWriteHook, spaceService) stay untouched.
 *
 * @param space - the space found by `matchPathToSpace`
 * @param absolutePath - the input path after resolving relative-to-core, as a portable (forward-slash) path
 * @returns the portable path to use as the rebase root for `relativePortablePath`
 */
export function resolveMatchRoot<T extends MatchRootInfo>(space: T, absolutePath: string): string {
  if (!space.sourcePath) {
    return space.absolutePath;
  }
  const resolvedSource = path.isAbsolute(space.sourcePath)
    ? space.sourcePath
    : path.resolve(space.absolutePath, '..', space.sourcePath);
  const sourceNormalized = normalizePortablePathForMatch(resolvedSource);
  const pathNormalized = normalizePortablePathForMatch(absolutePath);
  const sourceLower = sourceNormalized.toLowerCase();
  const pathLower = pathNormalized.toLowerCase();
  if (pathLower === sourceLower || pathLower.startsWith(sourceLower + '/')) {
    return resolvedSource;
  }
  return space.absolutePath;
}

/**
 * Is this space safe to share externally via a `rebel://space/` link?
 *
 * Allowlist (not denylist) with an exhaustive switch so taxonomy drift
 * surfaces as a compile error. An explicit `sharing === 'private'` (either
 * at the top level or in nested frontmatter) denies regardless of type.
 *
 * Parity with `src/main/services/spaceService.ts:filePathToSpaceLink`:
 *   - deny `type === 'chief-of-staff'`
 *   - deny `frontmatter.sharing === 'private'` (or top-level `sharing === 'private'`)
 *   - allow everything else (team, company, project, personal, operator, other)
 *
 * Future fail-closed: unknown `type` values (added to SpaceType later) trigger
 * both a compile-time error (`assertNever`) and a runtime `false`.
 */
export function isShareableSpace(space: ShareabilityInfo): boolean {
  // Explicit deny — frontmatter marker (main-side SpaceInfo) or top-level marker (shared SpaceInfo)
  if (space.frontmatter?.sharing === 'private') return false;
  if (space.sharing === 'private') return false;

  switch (space.type) {
    case 'chief-of-staff':
      return false;
    case 'team':
    case 'company':
    case 'project':
    case 'personal':
    case 'operator':
    case 'other':
      return true;
    default: {
      // Exhaustive check — compile-time error if SpaceType grows beyond the
      // cases above. Runtime default also fails closed.
      const _exhaustive: never = space.type;
      void _exhaustive;
      return false;
    }
  }
}

/**
 * Canonical space-name string to embed in `rebel://space/{name}/...` URLs.
 *
 * Must stay in lock-step with `src/main/services/spaceService.ts:getSpaceDisplayName`
 * so the renderer-side `toBestFileLink` and the main-side `filePathToSpaceLink`
 * always emit the same string for the same space. Drift would produce two
 * URLs for the same file and break idempotent sharing.
 *
 * Algorithm (identical to `getSpaceDisplayName`):
 *   1. Frontmatter `displayName` (trimmed) — takes precedence when non-empty
 *   2. Type-based defaults:
 *      - `chief-of-staff` → 'Private Space' (note: not shareable, but included
 *        for parity; `isShareableSpace` gates URL emission upstream)
 *      - `personal` → 'Personal'
 *   3. Folder name (`space.name`) — fallback
 *
 * Downstream `resolveSpaceByName` matches display name first, then folder
 * name — so either works, but parity requires one canonical choice. We
 * follow `getSpaceDisplayName` because that's what `filePathToSpaceLink`
 * (share-link generation) has always used.
 */
/**
 * Attempt to correct an agent-generated file path that uses a bare space name
 * (e.g., "General/file.md") instead of the full workspace-relative space path
 * (e.g., "work/Mindstone/General/file.md").
 *
 * Only corrects when exactly one space matches the first path segment by name
 * (case-insensitive). Returns null on ambiguity (0 or 2+ matches) — fail-closed.
 *
 * @returns corrected path and matched space, or null if no unambiguous correction found
 */
export function tryCorrectAgentSpacePath<T extends SpacePathInfo & { name: string }>(
  filePath: string,
  spaces: readonly T[],
  coreDirectory: string,
): { correctedPath: string; matchedSpace: T } | null {
  // If normal matching already works, no correction needed
  if (matchPathToSpace(filePath, spaces, coreDirectory)) return null;

  const normalized = toPortablePath(filePath)
    .replace(/\/+/g, '/')
    .replace(/^\.\//, '')
    .replace(/\/$/, '');

  const firstSegment = normalized.split('/')[0];
  if (!firstSegment) return null;

  const nameMatches = spaces.filter(s =>
    s.name.toLowerCase() === firstSegment.toLowerCase(),
  );

  // Only correct when exactly one space matches — ambiguity means we can't pick safely
  if (nameMatches.length !== 1) return null;

  const space = nameMatches[0];
  const spacePath = toPortablePath(space.path).replace(/\/$/, '');

  // If the space path equals the first segment, normal matching should have worked.
  // Bail out to avoid infinite correction loops.
  if (spacePath.toLowerCase() === firstSegment.toLowerCase()) return null;

  const rest = normalized.substring(firstSegment.length); // includes leading /
  const correctedPath = spacePath + rest;

  // Verify the corrected path actually matches a space.
  // Use the verified match (longest-prefix), not the name-match — handles nested spaces.
  const verified = matchPathToSpace(correctedPath, spaces, coreDirectory);
  if (!verified) return null;

  return { correctedPath, matchedSpace: verified };
}

export function getCanonicalSpaceName(space: SpaceNameInfo): string {
  const trimmedDisplayName = space.displayName?.trim();
  if (trimmedDisplayName) {
    return trimmedDisplayName;
  }
  if (space.type === 'chief-of-staff') {
    return 'Private Space';
  }
  if (space.type === 'personal') {
    return 'Personal';
  }
  return space.name;
}
