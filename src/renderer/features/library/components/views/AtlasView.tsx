import { useMemo } from 'react';
import { AlertCircle, Map } from 'lucide-react';
import { Button } from '@renderer/components/ui';
import { cn } from '@renderer/lib/utils';
import type { LibraryFilter } from '../../types/lens';
import { classifyLibraryItem } from '../../utils/classifyLibraryItem';
import { getRelativeLibraryPath, normalizeLibraryPath } from '../../utils/pathUtils';
import { useSemanticSearch } from '../../hooks/useSemanticSearch';
import { LibraryLensEmptyState } from '../LibraryLensEmptyState';
import { AtlasCanvas } from '../../../atlas/components/AtlasCanvas';
import { useAtlasProjection } from '../../../atlas/hooks/useAtlasProjection';
import { useAtlasSemanticSearch } from '../../../atlas/hooks/useAtlasSemanticSearch';
import { useAtlasSpaces } from '../../../atlas/hooks/useAtlasSpaces';
import styles from './AtlasView.module.css';

type AtlasProjectionState = ReturnType<typeof useAtlasProjection>;
type AtlasProjectionNode = NonNullable<AtlasProjectionState['nodes']>[number];

export interface AtlasViewProps {
  filter: LibraryFilter;
  searchQuery: string;
  coreDirectory?: string | null;
  className?: string;
  projectionOverride?: Partial<AtlasProjectionState>;
  onOpenPath?: (path: string) => void;
  onRetry?: () => void;
  onStartConversation?: (message: string, filePaths: string[]) => void;
}

function getNodeRelativePath(node: AtlasProjectionNode, libraryRootAbsolute?: string | null): string {
  if (typeof node.relativePath === 'string' && node.relativePath.trim().length > 0) {
    return normalizeLibraryPath(node.relativePath);
  }
  const normalizedRoot = normalizeLibraryPath(libraryRootAbsolute ?? '');
  return getRelativeLibraryPath(node.path, normalizedRoot || undefined);
}

function buildFilterPathSet(
  filter: LibraryFilter,
  nodes: readonly AtlasProjectionNode[],
  systemPaths: ReadonlySet<string>,
  libraryRootAbsolute?: string | null,
): Set<string> {
  const nodePaths = nodes.map((node) => node.path);
  if (filter === 'everything') {
    return new Set(nodePaths);
  }

  if (filter === 'spaces') {
    return new Set(nodePaths.filter((path) => !systemPaths.has(path)));
  }

  const targetKind = filter === 'skills' ? 'skill' : 'memory';
  return new Set(
    nodes
      .filter((node) => classifyLibraryItem({
        path: node.path,
        fullPath: node.path,
        relativePath: getNodeRelativePath(node, libraryRootAbsolute),
      }) === targetKind)
      .map((node) => node.path),
  );
}

function intersectSets(base: ReadonlySet<string>, overlay: ReadonlySet<string>): Set<string> {
  const intersection = new Set<string>();
  for (const value of base) {
    if (overlay.has(value)) {
      intersection.add(value);
    }
  }
  return intersection;
}

export function AtlasView({
  filter,
  searchQuery,
  coreDirectory,
  className,
  projectionOverride,
  onOpenPath,
  onRetry,
  onStartConversation,
}: AtlasViewProps) {
  const liveProjection = useAtlasProjection({ includeEmbeddings: true });
  const { indexStatus } = useSemanticSearch();
  const projection = projectionOverride
    ? { ...liveProjection, ...projectionOverride }
    : liveProjection;

  const nodes = useMemo(() => projection.nodes ?? [], [projection.nodes]);
  const clusters = projection.clusters ?? [];
  const totalFileCount = projection.totalFileCount ?? nodes.length;
  const isLoading = Boolean(projection.isLoading);
  const neighborsLoading = Boolean(projection.neighborsLoading);
  const projectionError = projection.error ?? null;
  const normalizedQuery = searchQuery.trim().toLowerCase();
  const nodePaths = useMemo(() => nodes.map((node) => node.path), [nodes]);

  const {
    spaceColorMap,
    spaceNameMap,
    systemPaths,
  } = useAtlasSpaces(nodePaths, coreDirectory ?? null);

  const {
    matchPaths: semanticMatchPaths,
    neighborPaths: semanticNeighborPaths,
    hasSemanticResults,
  } = useAtlasSemanticSearch({
    nodes,
    searchQuery,
  });

  const filterPaths = useMemo(
    () => buildFilterPathSet(filter, nodes, systemPaths, coreDirectory),
    [coreDirectory, filter, nodes, systemPaths],
  );

  const keywordMatches = useMemo(() => {
    if (!normalizedQuery) return null;
    const matches = new Set<string>();
    for (const node of nodes) {
      const haystackName = node.name.toLowerCase();
      const haystackPath = node.relativePath.toLowerCase();
      if (haystackName.includes(normalizedQuery) || haystackPath.includes(normalizedQuery)) {
        matches.add(node.path);
      }
    }
    return matches;
  }, [nodes, normalizedQuery]);

  const queryPaths = useMemo(() => {
    if (!normalizedQuery) return null;
    if (hasSemanticResults && semanticMatchPaths.size > 0) {
      const combined = new Set<string>(semanticMatchPaths);
      for (const neighborPath of semanticNeighborPaths) {
        combined.add(neighborPath);
      }
      return combined;
    }
    return keywordMatches ?? new Set<string>();
  }, [hasSemanticResults, keywordMatches, normalizedQuery, semanticMatchPaths, semanticNeighborPaths]);

  const visiblePaths = useMemo(() => {
    if (!queryPaths) return new Set(filterPaths);
    return intersectSets(filterPaths, queryPaths);
  }, [filterPaths, queryPaths]);

  const hiddenPaths = useMemo(() => {
    const hidden = new Set<string>();
    for (const path of nodePaths) {
      if (!visiblePaths.has(path)) {
        hidden.add(path);
      }
    }
    return hidden;
  }, [nodePaths, visiblePaths]);

  const hasQueryNoResults = Boolean(normalizedQuery) && visiblePaths.size === 0;
  const hasSparseGraph = visiblePaths.size < 2;
  const retry = onRetry ?? (() => projection.refetch?.());

  if (filter === 'plugins') {
    return <LibraryLensEmptyState mode="filter-mismatch" filter={filter} view="atlas" />;
  }

  if (isLoading && nodes.length === 0) {
    return <LibraryLensEmptyState mode="loading" filter={filter} view="atlas" />;
  }

  if (projectionError && nodes.length === 0) {
    return (
      <div className={cn(styles.statusRoot, className)}>
        <LibraryLensEmptyState
          mode="error"
          filter={filter}
          view="atlas"
          errorMessage={projectionError}
          onRetry={retry}
        />
      </div>
    );
  }

  if (!isLoading && nodes.length === 0) {
    // Default to first-map copy while index status is loading/unknown. Only claim
    // the Library is empty once the index has reported a known zero file count.
    const knownEmptyLibrary = indexStatus !== null && indexStatus.totalFiles === 0;
    const mode = knownEmptyLibrary ? 'empty-library' : 'atlas-indexing';
    return <LibraryLensEmptyState mode={mode} filter={filter} view="atlas" />;
  }

  if (hasQueryNoResults) {
    return (
      <LibraryLensEmptyState
        mode="search-no-results"
        filter={filter}
        view="atlas"
        query={searchQuery}
      />
    );
  }

  if (hasSparseGraph) {
    return <LibraryLensEmptyState mode="atlas-sparse" filter={filter} view="atlas" />;
  }

  return (
    <section className={cn(styles.root, className)}>
      <header className={styles.header}>
        <div className={styles.headerInfo}>
          <Map size={14} />
          <span>{visiblePaths.size} mapped file{visiblePaths.size === 1 ? '' : 's'}</span>
        </div>
        {projectionError ? (
          <Button type="button" variant="outline" size="sm" onClick={retry}>
            <AlertCircle size={14} />
            Retry
          </Button>
        ) : null}
      </header>

      <div className={styles.canvasFrame}>
        {neighborsLoading ? (
          <div className={styles.relationshipsIndicator} role="status" aria-live="polite">
            <span className={styles.relationshipsSpinner} aria-hidden="true" />
            <span>Computing relationships…</span>
          </div>
        ) : null}
        <AtlasCanvas
          nodes={nodes}
          clusters={clusters}
          totalFileCount={totalFileCount}
          is3D
          onNodeClick={(node) => onOpenPath?.(node.path)}
          searchQuery={searchQuery}
          spaceColorMap={spaceColorMap}
          spaceNameMap={spaceNameMap}
          semanticMatchPaths={semanticMatchPaths}
          semanticNeighborPaths={semanticNeighborPaths}
          hasSemanticResults={hasSemanticResults}
          hiddenPaths={hiddenPaths}
          onStartConversation={onStartConversation}
        />
      </div>
    </section>
  );
}
