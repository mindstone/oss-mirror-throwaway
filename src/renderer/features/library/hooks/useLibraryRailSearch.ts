import { useCallback, useMemo, useState } from 'react';
import type { FileNode } from '@shared/types';
import { useTimeoutRef } from '@renderer/hooks/useTimeoutRef';
import { flattenFileTree } from '@renderer/utils/librarySearch';
import { searchLibrary, type LibrarySearchOutcome } from '@renderer/features/library/search/engine';
import type { FlatLibraryEntry, LibrarySearchResult } from '@renderer/features/library/search/types';
import { getRelativeLibraryPath } from '../utils/pathUtils';
import type { SkillsScanResult } from './useSkillsIndex';

const RAIL_SEARCH_DEBOUNCE_MS = 120;
const LIBRARY_RAIL_SEARCH_LIMIT = 100_000;
const isDevelopmentMode = Boolean(
  import.meta.env.DEV
  || (typeof process !== 'undefined' && (process.env.NODE_ENV === 'development' || process.env.NODE_ENV === 'test'))
);

export type LibraryRailSearchMatch = {
  node: FileNode & { kind: 'file' };
  parentRelativePath: string;
  matches: Array<[number, number]>;
};

type FilteredRailTreeResult = {
  nodes: FileNode[];
  expandedDirectories: Record<string, boolean>;
  hasMatches: boolean;
  matches: LibraryRailSearchMatch[];
  searchOutcome: LibrarySearchOutcome;
  truncated: boolean;
  truncationReason: 'engine-cap' | null;
};

const warnMalformedSkillsData = (message: string, error?: unknown): void => {
  if (!isDevelopmentMode) {
    return;
  }

  if (error) {
    console.warn(`[useLibraryRailSearch] ${message}`, error);
    return;
  }

  console.warn(`[useLibraryRailSearch] ${message}`);
};

function getParentRelativePath(filePath: string, libraryRootAbsolute: string): string {
  const relativePath = getRelativeLibraryPath(filePath, libraryRootAbsolute).replace(/\\/g, '/');
  const normalizedRelativePath = relativePath.replace(/^\/+/, '');
  const lastSlashIndex = normalizedRelativePath.lastIndexOf('/');
  if (lastSlashIndex <= 0) {
    return '';
  }
  return normalizedRelativePath.slice(0, lastSlashIndex);
}

function attachSkillMetadata(
  entries: FlatLibraryEntry[],
  skillsData: SkillsScanResult | null | undefined,
): FlatLibraryEntry[] {
  if (!skillsData) {
    return entries;
  }

  if (!Array.isArray(skillsData.groups)) {
    warnMalformedSkillsData('Expected skillsData.groups to be an array; skipping skill metadata join.');
    return entries;
  }

  try {
    const skillMetaByDirectoryPath = new Map<string, FlatLibraryEntry['skillMeta']>();
    for (const group of skillsData.groups) {
      if (!group || typeof group !== 'object' || !group.categories || typeof group.categories !== 'object') {
        continue;
      }

      for (const skills of Object.values(group.categories)) {
        if (!Array.isArray(skills)) {
          continue;
        }

        for (const skill of skills) {
          if (!skill || typeof skill !== 'object') {
            continue;
          }

          const absolutePath = typeof skill.absolutePath === 'string' ? skill.absolutePath : '';
          if (!absolutePath) {
            continue;
          }

          const directoryPath = absolutePath.replace(/[/\\]SKILL\.md$/, '');
          if (directoryPath === absolutePath) {
            continue;
          }

          const name = typeof skill.name === 'string' ? skill.name : '';
          if (!name) {
            continue;
          }

          skillMetaByDirectoryPath.set(directoryPath, {
            name,
            description: typeof skill.frontmatter?.description === 'string'
              ? skill.frontmatter.description
              : undefined,
          });
        }
      }
    }

    for (const entry of entries) {
      if (entry.node.kind !== 'directory') {
        continue;
      }
      const skillMeta = skillMetaByDirectoryPath.get(entry.node.path);
      if (skillMeta) {
        entry.skillMeta = skillMeta;
      }
    }

    return entries;
  } catch (error) {
    warnMalformedSkillsData('Failed to join skill metadata onto rail-search entries; returning name-only entries.', error);
    return entries;
  }
}

function buildFlatLibraryEntries(
  nodes: FileNode[] | null | undefined,
  skillsData: SkillsScanResult | null | undefined,
): FlatLibraryEntry[] {
  if (!nodes || nodes.length === 0) {
    return [];
  }

  return attachSkillMetadata(flattenFileTree(nodes), skillsData);
}

export function buildAncestorPathMap(
  nodes: FileNode[] | null | undefined,
): Map<string, string[]> {
  const ancestorsByNodePath = new Map<string, string[]>();
  if (!nodes || nodes.length === 0) {
    return ancestorsByNodePath;
  }

  const visitNodes = (nodeList: FileNode[] | undefined, ancestors: string[]) => {
    if (!nodeList || nodeList.length === 0) {
      return;
    }

    for (const node of nodeList) {
      ancestorsByNodePath.set(node.path, ancestors);
      if (node.kind === 'directory' && node.children) {
        visitNodes(node.children, [...ancestors, node.path]);
      }
    }
  };

  visitNodes(nodes, []);
  return ancestorsByNodePath;
}

export const railSearchInternals = {
  buildAncestorPathMap,
} as const;

function deriveExpandedDirectoriesFromSearchResults(
  ancestorsByPath: ReadonlyMap<string, string[]>,
  results: ReadonlyArray<LibrarySearchResult>,
): Record<string, boolean> {
  const expandedDirectories: Record<string, boolean> = {};
  if (ancestorsByPath.size === 0 || results.length === 0) {
    return expandedDirectories;
  }

  for (const result of results) {
    const ancestors = ancestorsByPath.get(result.node.path);
    if (!ancestors) {
      continue;
    }
    for (const ancestorPath of ancestors) {
      expandedDirectories[ancestorPath] = true;
    }
  }

  return expandedDirectories;
}

function filterTreeNodesByMatchedPaths(
  nodes: FileNode[] | null | undefined,
  matchedNodePaths: ReadonlySet<string>,
): FileNode[] {
  if (!nodes || nodes.length === 0 || matchedNodePaths.size === 0) {
    return [];
  }

  const visitNodes = (nodeList: FileNode[] | undefined): FileNode[] => {
    if (!nodeList || nodeList.length === 0) {
      return [];
    }

    const filteredNodes: FileNode[] = [];

    for (const node of nodeList) {
      if (node.kind === 'directory') {
        const filteredChildren = visitNodes(node.children);
        const directoryMatches = matchedNodePaths.has(node.path);
        if (directoryMatches || filteredChildren.length > 0) {
          filteredNodes.push({
            ...node,
            children: filteredChildren,
          });
        }
        continue;
      }

      if (matchedNodePaths.has(node.path)) {
        filteredNodes.push(node);
      }
    }

    return filteredNodes;
  };

  return visitNodes(nodes);
}

function isFileSearchResult(
  result: LibrarySearchResult,
): result is LibrarySearchResult & { node: FileNode & { kind: 'file' } } {
  return result.node.kind === 'file';
}

function mapSearchOutcomeToRailResult(
  nodes: FileNode[] | null | undefined,
  ancestorPathMap: ReadonlyMap<string, string[]>,
  searchOutcome: LibrarySearchOutcome,
  libraryRootAbsolute: string,
): FilteredRailTreeResult {
  const fileMatches = searchOutcome.results
    .filter(isFileSearchResult)
    .map((result) => ({
      node: result.node,
      parentRelativePath: getParentRelativePath(result.node.path, libraryRootAbsolute),
      matches: result.matches,
    }));

  const matchedNodePaths = new Set(searchOutcome.results.map((result) => result.node.path));
  return {
    nodes: filterTreeNodesByMatchedPaths(nodes, matchedNodePaths),
    expandedDirectories: deriveExpandedDirectoriesFromSearchResults(ancestorPathMap, searchOutcome.results),
    hasMatches: fileMatches.length > 0,
    matches: fileMatches,
    searchOutcome,
    truncated: searchOutcome.truncated,
    truncationReason: searchOutcome.truncationReason,
  };
}

type UseLibraryRailSearchArgs = {
  nodes: FileNode[] | null | undefined;
  expandedDirectories: Record<string, boolean>;
  libraryRootAbsolute: string;
  skillsData?: SkillsScanResult | null;
};

type UseLibraryRailSearchResult = {
  query: string;
  setQuery: (nextQuery: string) => void;
  clearQuery: () => void;
  isSearchActive: boolean;
  debouncedQuery: string;
  filteredNodes: FileNode[] | null;
  effectiveExpandedDirectories: Record<string, boolean>;
  hasMatches: boolean;
  matches: LibraryRailSearchMatch[];
  searchOutcome: LibrarySearchOutcome | null;
  truncated: boolean;
  truncationReason: 'engine-cap' | null;
};

export function useLibraryRailSearch({
  nodes,
  expandedDirectories,
  libraryRootAbsolute,
  skillsData,
}: UseLibraryRailSearchArgs): UseLibraryRailSearchResult {
  const [query, setQueryState] = useState('');
  const [debouncedQuery, setDebouncedQuery] = useState('');
  const debounceTimeout = useTimeoutRef();

  const setQuery = useCallback((nextQuery: string) => {
    setQueryState(nextQuery);
    debounceTimeout.set(() => {
      setDebouncedQuery(nextQuery);
    }, RAIL_SEARCH_DEBOUNCE_MS);
  }, [debounceTimeout]);

  const clearQuery = useCallback(() => {
    debounceTimeout.clear();
    setQueryState('');
    setDebouncedQuery('');
  }, [debounceTimeout]);

  const normalizedQuery = debouncedQuery.trim().toLowerCase();
  const isSearchActive = normalizedQuery.length > 0;
  const flatEntries = useMemo(
    () => buildFlatLibraryEntries(nodes, skillsData),
    [nodes, skillsData],
  );
  const ancestorPathMap = useMemo(
    () => railSearchInternals.buildAncestorPathMap(nodes),
    [nodes],
  );

  const filteredResult = useMemo(() => {
    if (!isSearchActive) {
      return null;
    }
    const searchOutcome = searchLibrary(normalizedQuery, flatEntries, {
      surface: 'rail',
      limit: LIBRARY_RAIL_SEARCH_LIMIT,
    });
    return mapSearchOutcomeToRailResult(nodes, ancestorPathMap, searchOutcome, libraryRootAbsolute);
  }, [ancestorPathMap, flatEntries, isSearchActive, libraryRootAbsolute, nodes, normalizedQuery]);

  const effectiveExpandedDirectories = useMemo(() => {
    if (!isSearchActive || !filteredResult) {
      return expandedDirectories;
    }
    return {
      ...expandedDirectories,
      ...filteredResult.expandedDirectories,
    };
  }, [expandedDirectories, filteredResult, isSearchActive]);

  return {
    query,
    setQuery,
    clearQuery,
    isSearchActive,
    debouncedQuery,
    filteredNodes: isSearchActive && filteredResult ? filteredResult.nodes : null,
    effectiveExpandedDirectories,
    hasMatches: filteredResult?.hasMatches ?? true,
    matches: isSearchActive && filteredResult ? filteredResult.matches : [],
    searchOutcome: isSearchActive && filteredResult ? filteredResult.searchOutcome : null,
    truncated: filteredResult?.truncated ?? false,
    truncationReason: filteredResult?.truncationReason ?? null,
  };
}
