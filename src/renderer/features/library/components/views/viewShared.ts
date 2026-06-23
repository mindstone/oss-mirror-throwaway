import type { FileNode } from '@shared/types';
import type { SpaceInfo } from '@shared/ipc/schemas/library';
import { assertNever } from '@shared/utils/assertNever';
import { classifyLibraryItem } from '../../utils/classifyLibraryItem';
import { getRelativeLibraryPath, isDescendantPath, normalizeLibraryPath } from '../../utils/pathUtils';
import type { LibraryFilter, LibrarySortOption } from '../../types/lens';
import { matchesPlainText, normalizeSearchQuery } from '../../search/matchesPlainText';

export interface LibraryViewEntry {
  id: string;
  path: string;
  fullPath?: string;
  relativePath: string;
  name: string;
  kind: FileNode['kind'];
  mtime?: number;
  createdAt?: number;
  recentAt?: number;
  summary?: string;
  content?: string;
  skillMeta?: unknown;
  sourceNode?: FileNode;
}

export function buildSpaceRoots(spacesData?: SpaceInfo[]): string[] {
  if (!spacesData || spacesData.length === 0) return [];
  const roots = new Set<string>();
  const addRoot = (value: unknown) => {
    if (typeof value !== 'string') return;
    const normalized = normalizeLibraryPath(value);
    if (normalized) {
      roots.add(normalized);
    }
  };

  for (const space of spacesData) {
    addRoot(space.absolutePath);
    addRoot(space.sourcePath);
  }

  return Array.from(roots);
}

export function isInKnownSpace(path: string, spaceRoots: readonly string[]): boolean {
  if (spaceRoots.length === 0) return false;
  const normalized = normalizeLibraryPath(path);
  return spaceRoots.some((root) => isDescendantPath(normalized, root));
}

function isPluginPath(entry: Pick<LibraryViewEntry, 'path' | 'relativePath' | 'fullPath'>): boolean {
  const candidate = entry.relativePath ?? entry.fullPath ?? entry.path;
  if (typeof candidate !== 'string' || candidate.length === 0) return false;
  const normalized = normalizeLibraryPath(candidate);
  return normalized === 'plugins' || normalized.startsWith('plugins/') || normalized.includes('/plugins/');
}

export function matchesFilter(
  entry: Pick<LibraryViewEntry, 'path' | 'relativePath' | 'fullPath' | 'skillMeta'>,
  filter: LibraryFilter,
  spaceRoots: readonly string[],
): boolean {
  switch (filter) {
    case 'everything':
      return true;
    case 'spaces':
      return isInKnownSpace(entry.path, spaceRoots);
    case 'plugins':
      return isPluginPath(entry);
    case 'skills':
      return classifyLibraryItem(entry) === 'skill';
    case 'memory':
      return classifyLibraryItem(entry) === 'memory';
    default:
      return assertNever(filter);
  }
}

export function matchesSearch(entry: Pick<LibraryViewEntry, 'name' | 'relativePath' | 'summary'>, rawQuery: string): boolean {
  const query = normalizeSearchQuery(rawQuery);
  return (
    matchesPlainText(entry.name, query)
    || matchesPlainText(entry.relativePath, query)
    || matchesPlainText(entry.summary, query)
  );
}

export function sortEntries(entries: readonly LibraryViewEntry[], sortBy: LibrarySortOption): LibraryViewEntry[] {
  const sorted = [...entries];
  sorted.sort((left, right) => {
    switch (sortBy) {
      case 'name': {
        const byName = left.name.localeCompare(right.name, undefined, { sensitivity: 'base' });
        if (byName !== 0) return byName;
        return left.relativePath.localeCompare(right.relativePath, undefined, { sensitivity: 'base' });
      }
      case 'modified': {
        const leftValue = left.mtime ?? 0;
        const rightValue = right.mtime ?? 0;
        if (leftValue !== rightValue) return rightValue - leftValue;
        return left.name.localeCompare(right.name, undefined, { sensitivity: 'base' });
      }
      case 'created': {
        const leftValue = left.createdAt ?? left.mtime ?? 0;
        const rightValue = right.createdAt ?? right.mtime ?? 0;
        if (leftValue !== rightValue) return rightValue - leftValue;
        return left.name.localeCompare(right.name, undefined, { sensitivity: 'base' });
      }
      case 'recent': {
        const leftValue = left.recentAt ?? left.mtime ?? 0;
        const rightValue = right.recentAt ?? right.mtime ?? 0;
        if (leftValue !== rightValue) return rightValue - leftValue;
        return left.name.localeCompare(right.name, undefined, { sensitivity: 'base' });
      }
      default:
        return left.name.localeCompare(right.name, undefined, { sensitivity: 'base' });
    }
  });
  return sorted;
}

export function flattenTreeEntries(
  nodes: FileNode[] | null | undefined,
  libraryRootAbsolute: string,
): LibraryViewEntry[] {
  if (!nodes || nodes.length === 0) return [];
  const flattened: LibraryViewEntry[] = [];
  const stack: Array<FileNode> = [...nodes];

  while (stack.length > 0) {
    const node = stack.pop();
    if (!node) continue;
    flattened.push({
      id: node.path,
      path: node.path,
      fullPath: node.path,
      relativePath: getRelativeLibraryPath(node.path, libraryRootAbsolute),
      name: node.name,
      kind: node.kind,
      mtime: node.mtime,
      sourceNode: node,
    });
    if (node.kind === 'directory' && node.children && node.children.length > 0) {
      for (let index = node.children.length - 1; index >= 0; index -= 1) {
        stack.push(node.children[index]);
      }
    }
  }

  return flattened;
}
