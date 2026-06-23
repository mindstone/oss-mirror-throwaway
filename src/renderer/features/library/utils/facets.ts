import type { SpaceInfo } from '@shared/ipc/schemas/library';
import type { LibraryItemKind } from './classifyLibraryItem';

export type SpaceFacetId = 'personal' | 'work' | 'project';
export type EverythingFacetId = 'skills' | 'memory' | 'documents';

export function normalizeFacetValue(value: string | null | undefined): string | null {
  if (typeof value !== 'string') {
    return null;
  }
  const normalized = value.trim().toLowerCase();
  return normalized.length > 0 ? normalized : null;
}

export function mapSpaceTypeToFacet(type: SpaceInfo['type'] | undefined): SpaceFacetId | null {
  switch (type) {
    case 'chief-of-staff':
    case 'personal':
      return 'personal';
    case 'company':
    case 'team':
      return 'work';
    case 'project':
      return 'project';
    default:
      return null;
  }
}

export function mapLibraryKindToEverythingFacet(kind: LibraryItemKind): EverythingFacetId {
  switch (kind) {
    case 'skill':
      return 'skills';
    case 'memory':
      return 'memory';
    case 'plain':
    default:
      return 'documents';
  }
}

/**
 * Returns true when a memory-history entry's filePath points at something that
 * is NOT a curated memory file — e.g. source captures (memory/sources/...) or
 * skill files (any path containing a `skills/` segment). Such entries leak into
 * the memory view because the memory store records every write the agent does,
 * but conceptually they belong to other lenses.
 */
export function isNonMemoryAssetPath(filePath: string | null | undefined): boolean {
  const normalizedPath = filePath?.trim();
  if (!normalizedPath) {
    return false;
  }

  const segments = normalizedPath.toLowerCase().split(/[/\\]+/);
  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index];
    if (segment === 'skills') {
      return true;
    }
    if (
      segment === 'memory'
      && index + 1 < segments.length
      && segments[index + 1] === 'sources'
    ) {
      return true;
    }
  }
  return false;
}
