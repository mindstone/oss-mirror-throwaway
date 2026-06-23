import type { LibraryFilter, LibraryLens } from '../types/lens';
import { classifyLibraryItem, type ClassifiableItem } from './classifyLibraryItem';
import { isDescendantPath, normalizeLibraryPath } from './pathUtils';

export interface RevealClassification {
  filter: LibraryFilter;
  label: string;
  lens: LibraryLens;
}

export interface RevealClassificationInput extends ClassifiableItem {
  path: string;
}

function isInKnownSpace(path: string, spaceRoots: readonly string[]): boolean {
  const normalizedPath = normalizeLibraryPath(path);
  if (!normalizedPath) return false;
  return spaceRoots.some((root) => isDescendantPath(normalizedPath, root));
}

export function getRevealClassification(
  item: RevealClassificationInput,
  spaceRoots: readonly string[] = [],
): RevealClassification {
  const kind = classifyLibraryItem(item);
  if (kind === 'skill') {
    return {
      filter: 'skills',
      label: 'Show in Skills',
      lens: { filter: 'skills', view: 'folders' },
    };
  }
  if (kind === 'memory') {
    return {
      filter: 'memory',
      label: 'Show in Memory',
      lens: { filter: 'memory', view: 'folders' },
    };
  }
  if (isInKnownSpace(item.path, spaceRoots)) {
    return {
      filter: 'spaces',
      label: 'Show in Spaces',
      lens: { filter: 'spaces', view: 'folders' },
    };
  }
  return {
    filter: 'everything',
    label: 'Show in Folders',
    lens: { filter: 'everything', view: 'folders' },
  };
}
