import { useMemo } from 'react';
import type { FileNode, MemoryHistoryEntry } from '@shared/types';
import type { SpaceInfo } from '@shared/ipc/schemas/library';
import { Badge } from '@renderer/components/ui';
import { cn } from '@renderer/lib/utils';
import type { LibraryFilter } from '../../types/lens';
import { LibraryLensEmptyState } from '../LibraryLensEmptyState';
import { IncompleteLibraryHint } from '../IncompleteLibraryHint';
import { LibraryTreeView, type LibraryTreeViewProps } from '../LibraryTreeView';
import type { SkillsScanResult } from '../../hooks/useSkillsIndex';
import { classifyLibraryItem } from '../../utils/classifyLibraryItem';
import {
  isNonMemoryAssetPath,
  mapLibraryKindToEverythingFacet,
  mapSpaceTypeToFacet,
  normalizeFacetValue,
} from '../../utils/facets';
import { getRelativeLibraryPath, normalizeLibraryPath } from '../../utils/pathUtils';
import {
  buildSpaceRoots,
  matchesFilter,
  matchesSearch,
} from './viewShared';
import { matchesPlainText, normalizeSearchQuery } from '../../search/matchesPlainText';
import styles from './FoldersView.module.css';

export interface FoldersViewProps {
  filter: LibraryFilter;
  facet?: string;
  searchQuery: string;
  tree: FileNode[] | null | undefined;
  treeViewProps: Omit<LibraryTreeViewProps, 'nodes'>;
  spacesData?: SpaceInfo[];
  skillsData?: SkillsScanResult | null;
  memoryEntries?: readonly MemoryHistoryEntry[];
  spacesError?: boolean;
  spacesErrorMessage?: string | null;
  favoriteFilePaths?: string[];
  loading?: boolean;
  error?: string | null;
  /** True when the file tree is a partial view (Bug-2) — surfaces an "incomplete Library" hint so absence isn't read as "none". */
  isPartialTree?: boolean;
  onRetry?: () => void;
  className?: string;
}

function filterTree(
  nodes: FileNode[] | null | undefined,
  matchesNode: (node: FileNode) => boolean,
): FileNode[] {
  if (!nodes || nodes.length === 0) return [];
  const filtered: FileNode[] = [];
  for (const node of nodes) {
    if (node.kind === 'directory') {
      const filteredChildren = filterTree(node.children, matchesNode);
      if (filteredChildren.length > 0 || matchesNode(node)) {
        filtered.push({
          ...node,
          children: filteredChildren,
        });
      }
      continue;
    }
    if (matchesNode(node)) {
      filtered.push(node);
    }
  }
  return filtered;
}

function findNodeByPath(
  nodes: FileNode[] | null | undefined,
  targetPath: string,
): FileNode | null {
  if (!nodes || nodes.length === 0) return null;
  const stack = [...nodes];
  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) continue;
    if (current.path === targetPath) return current;
    if (current.kind === 'directory' && current.children) {
      for (const child of current.children) {
        stack.push(child);
      }
    }
  }
  return null;
}

function resolveFacetSelection(facet: string | undefined): string | null {
  const normalizedFacet = normalizeFacetValue(facet);
  if (!normalizedFacet || normalizedFacet === 'all') {
    return null;
  }
  return normalizedFacet;
}

function normalizePathKey(path: string): string {
  return normalizeLibraryPath(path).toLowerCase();
}

function isAbsolutePath(candidate: string): boolean {
  return /^(?:[a-zA-Z]:[\\/]|\/|\\\\)/.test(candidate);
}

function joinWorkspacePath(root: string, relativePath: string): string {
  const normalizedRoot = root.replace(/[\\/]+$/, '');
  const normalizedRelative = relativePath.replace(/^[\\/]+/, '');
  return `${normalizedRoot}/${normalizedRelative}`;
}

function buildSkillCategoryByPath(
  skillsData: SkillsScanResult | null | undefined,
): Map<string, string> {
  const categoriesByPath = new Map<string, string>();
  if (!skillsData?.groups) {
    return categoriesByPath;
  }

  for (const group of skillsData.groups) {
    for (const [fallbackCategory, skills] of Object.entries(group.categories)) {
      for (const skill of skills) {
        const category = skill.category || fallbackCategory;
        const relativePath = normalizePathKey(skill.relativePath);
        categoriesByPath.set(relativePath, category);
      }
    }
  }

  return categoriesByPath;
}

function buildMemoryEntityByPath(
  memoryEntries: readonly MemoryHistoryEntry[] | undefined,
  libraryRootAbsolute: string,
): Map<string, string> {
  const entitiesByPath = new Map<string, string>();
  if (!memoryEntries || memoryEntries.length === 0) {
    return entitiesByPath;
  }

  for (const entry of memoryEntries) {
    if (isNonMemoryAssetPath(entry.filePath)) {
      continue;
    }

    const memoryPath = entry.filePath?.trim();
    if (!memoryPath) {
      continue;
    }

    const absolutePath = isAbsolutePath(memoryPath)
      ? memoryPath
      : (libraryRootAbsolute ? joinWorkspacePath(libraryRootAbsolute, memoryPath) : memoryPath);
    entitiesByPath.set(normalizePathKey(absolutePath), entry.entity);
  }

  return entitiesByPath;
}

function collectPinnedNodes(
  nodes: FileNode[] | null | undefined,
  favoriteFilePaths: readonly string[],
): FileNode[] {
  if (!nodes || nodes.length === 0 || favoriteFilePaths.length === 0) return [];
  const favorites = new Set(favoriteFilePaths);
  const pinned: FileNode[] = [];
  const stack = [...nodes];
  while (stack.length > 0) {
    const node = stack.pop();
    if (!node) continue;
    if (favorites.has(node.path)) {
      pinned.push(node);
    }
    if (node.kind === 'directory' && node.children) {
      for (const child of node.children) {
        stack.push(child);
      }
    }
  }
  return pinned;
}

type SpaceGroup = {
  key: string;
  title: string;
  tree: FileNode[] | null;
  unavailable: boolean;
};

export function FoldersView({
  filter,
  facet,
  searchQuery,
  tree,
  treeViewProps,
  spacesData,
  skillsData,
  memoryEntries,
  spacesError = false,
  spacesErrorMessage = null,
  favoriteFilePaths = [],
  loading = false,
  error = null,
  isPartialTree = false,
  onRetry,
  className,
}: FoldersViewProps) {
  const normalizedQuery = searchQuery.trim();
  const normalizedSearchQuery = normalizeSearchQuery(searchQuery);
  const facetSelection = resolveFacetSelection(facet);
  const spaceRoots = useMemo(() => buildSpaceRoots(spacesData), [spacesData]);
  const skillCategoryByPath = useMemo(
    () => buildSkillCategoryByPath(skillsData),
    [skillsData],
  );
  const memoryEntityByPath = useMemo(
    () => buildMemoryEntityByPath(memoryEntries, treeViewProps.libraryRootAbsolute),
    [memoryEntries, treeViewProps.libraryRootAbsolute],
  );
  const spaceFacetByRoot = useMemo(() => (
    (spacesData ?? []).flatMap((space) => {
      const facetForSpace = mapSpaceTypeToFacet(space.type);
      if (!facetForSpace) {
        return [];
      }
      return [{
        root: normalizePathKey(space.absolutePath),
        facet: facetForSpace,
      }];
    }).sort((left, right) => right.root.length - left.root.length)
  ), [spacesData]);

  const matchesNode = useMemo(() => (
    (node: FileNode): boolean => {
      const relativePath = getRelativeLibraryPath(node.path, treeViewProps.libraryRootAbsolute);
      const baseMatchesFilter = matchesFilter(
        {
          path: node.path,
          fullPath: node.path,
          relativePath,
        },
        filter,
        spaceRoots,
      );
      if (!baseMatchesFilter) {
        return false;
      }

      if (facetSelection) {
        switch (filter) {
          case 'skills': {
            if (node.kind !== 'file') return false;
            const category = skillCategoryByPath.get(normalizePathKey(relativePath));
            if (normalizeFacetValue(category) !== facetSelection) {
              return false;
            }
            break;
          }
          case 'memory': {
            if (node.kind !== 'file') return false;
            const entity = memoryEntityByPath.get(normalizePathKey(node.path));
            if (normalizeFacetValue(entity) !== facetSelection) {
              return false;
            }
            break;
          }
          case 'spaces': {
            const normalizedNodePath = normalizePathKey(node.path);
            const containingSpace = spaceFacetByRoot.find(({ root }) => (
              normalizedNodePath === root || normalizedNodePath.startsWith(`${root}/`)
            ));
            if (!containingSpace || containingSpace.facet !== facetSelection) {
              return false;
            }
            break;
          }
          case 'everything': {
            if (node.kind !== 'file') return false;
            const kindFacet = mapLibraryKindToEverythingFacet(classifyLibraryItem({
              path: node.path,
              relativePath,
            }));
            if (kindFacet !== facetSelection) {
              return false;
            }
            break;
          }
          case 'plugins':
            // The plugins lens renders a dedicated view (LibraryNavigator/CardsView/AtlasView);
            // no folder-facet filtering applies in the folder tree.
            break;
          default:
            // eslint-disable-next-line rebel-switch-exhaustiveness/no-bare-default-bypass -- tolerant default: all LibraryFilter members handled explicitly above; this guards a stale/persisted lens value at runtime (assertNever would risk crashing the view).
            break;
        }
      }

      return matchesSearch(
        {
          name: node.name,
          relativePath,
        },
        normalizedQuery,
      );
    }
  ), [
    facetSelection,
    filter,
    memoryEntityByPath,
    normalizedQuery,
    skillCategoryByPath,
    spaceFacetByRoot,
    spaceRoots,
    treeViewProps.libraryRootAbsolute,
  ]);

  const pinnedNodes = useMemo(() => {
    const pinned = collectPinnedNodes(tree, favoriteFilePaths);
    return pinned.filter((node) => matchesNode(node));
  }, [favoriteFilePaths, matchesNode, tree]);

  const defaultFilteredTree = useMemo(
    () => filterTree(tree, matchesNode),
    [matchesNode, tree],
  );

  const spaceGroups = useMemo<SpaceGroup[]>(() => {
    if (filter !== 'spaces' || !spacesData || spacesData.length === 0) return [];
    const groups: SpaceGroup[] = [];
    for (const space of spacesData) {
      if (facetSelection && mapSpaceTypeToFacet(space.type) !== facetSelection) {
        continue;
      }
      const matchingNode = findNodeByPath(tree, space.absolutePath);
      if (!matchingNode) {
        const { displayName, name } = space;
        const title = displayName ?? name;
        const passesQuery = matchesPlainText(title, normalizedSearchQuery);
        if (!passesQuery) continue;
        groups.push({
          key: space.absolutePath,
          title,
          tree: null,
          unavailable: true,
        });
        continue;
      }
      const filteredChildren = filterTree(matchingNode.children ?? [], (node) => matchesSearch(
        {
          name: node.name,
          relativePath: getRelativeLibraryPath(node.path, treeViewProps.libraryRootAbsolute),
        },
        normalizedQuery,
      ));
      const hasRawChildren = (matchingNode.children?.length ?? 0) > 0;
      if (filteredChildren.length === 0 && hasRawChildren) continue;
      groups.push({
        key: space.absolutePath,
        title: space.displayName || matchingNode.name || space.name,
        tree: filteredChildren,
        unavailable: false,
      });
    }
    return groups;
  }, [
    facetSelection,
    filter,
    normalizedQuery,
    normalizedSearchQuery,
    spacesData,
    tree,
    treeViewProps.libraryRootAbsolute,
  ]);

  const hasSourceTree = Boolean(tree && tree.length > 0);
  const hasSpacesFailure = filter === 'spaces' && spacesError;
  const hasUnavailableSpaces = filter === 'spaces'
    ? spaceGroups.some((group) => group.unavailable)
    : false;
  const hasVisibleContent = filter === 'spaces'
    ? spaceGroups.length > 0 || hasUnavailableSpaces
    : defaultFilteredTree.length > 0;

  if (filter === 'plugins') {
    return (
      <LibraryLensEmptyState
        mode="filter-mismatch"
        filter={filter}
        view="folders"
      />
    );
  }

  if (loading && !hasSourceTree) {
    return (
      <LibraryLensEmptyState
        mode="loading"
        filter={filter}
        view="folders"
      />
    );
  }

  if (hasSpacesFailure && spaceGroups.length === 0 && pinnedNodes.length === 0) {
    return (
      <LibraryLensEmptyState
        mode="error"
        filter={filter}
        view="folders"
        errorMessage={spacesErrorMessage ?? "Couldn't load Spaces."}
        onRetry={onRetry}
      />
    );
  }

  if (error && !hasSourceTree) {
    return (
      <LibraryLensEmptyState
        mode="error"
        filter={filter}
        view="folders"
        errorMessage={error}
        onRetry={onRetry}
      />
    );
  }

  if (!hasVisibleContent && pinnedNodes.length === 0) {
    const mode = normalizedQuery.length > 0
      ? 'search-no-results'
      : hasSourceTree
        ? 'filter-mismatch'
        : 'empty-library';

    return (
      <div className={cn(styles.root, className)}>
        <LibraryLensEmptyState
          mode={mode}
          filter={filter}
          view="folders"
          query={normalizedQuery}
        />
        <IncompleteLibraryHint show={isPartialTree} />
      </div>
    );
  }

  return (
    <div className={cn(styles.root, className)}>
      <IncompleteLibraryHint show={isPartialTree} />
      {pinnedNodes.length > 0 ? (
        <section className={styles.section}>
          <header className={styles.sectionHeader}>
            <h3 className={styles.sectionTitle}>Pinned</h3>
            <span className={styles.sectionCount}>{pinnedNodes.length}</span>
          </header>
          <div className={styles.treeSurface}>
            <LibraryTreeView {...treeViewProps} nodes={pinnedNodes} />
          </div>
        </section>
      ) : null}

      {filter === 'everything' && spaceRoots.length > 0 ? (
        <section className={styles.badgeSection} aria-label="Known spaces">
          <span className={styles.badgeLabel}>Spaces in this tree</span>
          <div className={styles.badgeRow}>
            {spacesData?.map((space) => (
              <Badge key={space.absolutePath} variant="muted" size="sm">
                {space.displayName || space.name}
              </Badge>
            ))}
          </div>
        </section>
      ) : null}

      {filter === 'spaces' ? (
        <section className={styles.section}>
          <header className={styles.sectionHeader}>
            <h3 className={styles.sectionTitle}>Your Spaces</h3>
            <span className={styles.sectionCount}>{spaceGroups.length}</span>
          </header>
          <div className={styles.groupList}>
            {spaceGroups.map((group) => (
              <article key={group.key} className={styles.groupCard}>
                <header className={styles.groupHeader}>
                  <span className={styles.groupTitle}>{group.title}</span>
                  {group.unavailable ? (
                    <Badge variant="muted" size="sm">Unavailable</Badge>
                  ) : (
                    <Badge variant="muted" size="sm">Space</Badge>
                  )}
                </header>
                <div className={styles.groupBody}>
                  {group.tree ? (
                    <LibraryTreeView {...treeViewProps} nodes={group.tree} />
                  ) : (
                    <p className={styles.unavailableMessage}>
                      This Space is configured, but Rebel could not list its folder right now.
                    </p>
                  )}
                </div>
              </article>
            ))}
          </div>
        </section>
      ) : (
        <section className={styles.section}>
          <header className={styles.sectionHeader}>
            <h3 className={styles.sectionTitle}>Folders</h3>
            <span className={styles.sectionCount}>{defaultFilteredTree.length}</span>
          </header>
          <div className={styles.treeSurface}>
            <LibraryTreeView {...treeViewProps} nodes={defaultFilteredTree} />
          </div>
        </section>
      )}
    </div>
  );
}
