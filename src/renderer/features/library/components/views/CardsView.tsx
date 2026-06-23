import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type {
  FocusEvent as ReactFocusEvent,
  MouseEvent as ReactMouseEvent,
  ReactNode,
} from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import type { FileNode, MemoryHistoryEntry } from '@shared/types';
import type { SpaceInfo } from '@shared/ipc/schemas/library';
import { Badge, Button } from '@renderer/components/ui';
import { cn } from '@renderer/lib/utils';
import { assertNever } from '@shared/utils/assertNever';
import { formatRelativeTime } from '@rebel/shared';
import {
  Brain,
  Briefcase,
  ChevronDown,
  ChevronRight,
  Clock3,
  FolderOpen,
  Lock,
  Sparkles,
} from 'lucide-react';
import type { SkillsScanResult } from '../../hooks/useSkillsIndex';
import type { PendingMemoryRequest } from '../../hooks/usePendingMemoryApprovals';
import { useFilterGrouping } from '../../hooks/useFilterGrouping';
import { getRevealClassification } from '../../utils/revealInClassifiedView';
import { classifyLibraryItem } from '../../utils/classifyLibraryItem';
import {
  mapLibraryKindToEverythingFacet,
  mapSpaceTypeToFacet,
  normalizeFacetValue,
} from '../../utils/facets';
import { resolveMemoryEntryPath } from '../../utils/resolveMemoryEntryPath';
import type { LibraryFilter, LibrarySortOption } from '../../types/lens';
import { LibraryLensEmptyState } from '../LibraryLensEmptyState';
import { IncompleteLibraryHint } from '../IncompleteLibraryHint';
import { SkillCard } from '../SkillCard';
import { FilterCardsEmptyState } from './empty/FilterCardsEmptyState';
import { FileCard } from './FileCard';
import { PluginCard } from '@renderer/features/plugins/components/PluginCard';
import type { PluginAction } from '@renderer/features/plugins/components/PluginActionsMenu';
import {
  memoryHistoryToCardEntries,
  skillIndexToCardEntries,
  spacesToCardEntries,
  type MemoryCardEntry,
  type PluginCardEntry,
  type SkillCardEntry,
  type SpaceCardEntry,
} from './cardEntries';
import {
  buildSpaceRoots,
  flattenTreeEntries,
  sortEntries,
  type LibraryViewEntry,
} from './viewShared';
import { shouldIgnoreCardClick } from './cardClickGuard';
import { matchesPlainText, normalizeSearchQuery } from '../../search/matchesPlainText';
import styles from './CardsView.module.css';

type CardKind = ReturnType<typeof classifyLibraryItem>;
type CardsEntry = SkillCardEntry | MemoryCardEntry | SpaceCardEntry | PluginCardEntry | LibraryViewEntry;
type FileBackedCardEntry = SkillCardEntry | MemoryCardEntry | LibraryViewEntry;

type ListItemMetadata = {
  position: number;
  setSize: number;
};

type RenderCardMetadata = {
  keyPrefix?: string;
  listItem?: ListItemMetadata;
};

type RenderCard = (entry: CardsEntry, metadata?: RenderCardMetadata) => ReactNode;

const VIRTUALIZE_GRID_ENTRY_THRESHOLD = 200;
const GRID_MIN_COLUMN_PX = 260;
const GRID_GAP_PX = 12;
const GRID_ESTIMATED_ROW_HEIGHT = 230;
const GRID_OVERSCAN_ROWS = 8;
const MEMORY_HISTORY_VISIBLE_CAP = 5000;

type ContextMenuAction = {
  key: string;
  label: string;
  onSelect: () => void;
  danger?: boolean;
};

type ContextMenuState = {
  x: number;
  y: number;
  actions: ContextMenuAction[];
};

type CardsEntryGridProps = {
  entries: readonly CardsEntry[];
  renderCard: RenderCard;
  keyPrefix?: string;
  testId?: string;
};

function getListItemAccessibilityProps(listItem?: ListItemMetadata): {
  role?: 'listitem';
  'aria-posinset'?: number;
  'aria-setsize'?: number;
} {
  if (!listItem) {
    return {};
  }

  return {
    role: 'listitem',
    'aria-posinset': listItem.position,
    'aria-setsize': listItem.setSize,
  };
}

function focusCardByPath(container: HTMLElement, path: string): boolean {
  const cardNodes = container.querySelectorAll<HTMLElement>('[data-library-card-path]');
  for (const cardNode of cardNodes) {
    if (cardNode.dataset.libraryCardPath !== path) {
      continue;
    }
    cardNode.focus({ preventScroll: true });
    return true;
  }
  return false;
}

function findScrollableAncestor(node: HTMLElement | null): HTMLElement | null {
  if (!node || typeof window === 'undefined') return null;

  let current: HTMLElement | null = node.parentElement;
  while (current) {
    const style = window.getComputedStyle(current);
    const overflowY = style.overflowY || style.overflow;
    if (overflowY === 'auto' || overflowY === 'scroll') {
      return current;
    }
    current = current.parentElement;
  }

  return document.scrollingElement instanceof HTMLElement ? document.scrollingElement : null;
}

function CardsEntryGrid({
  entries,
  renderCard,
  keyPrefix = '',
  testId,
}: CardsEntryGridProps) {
  const shouldVirtualize = entries.length > VIRTUALIZE_GRID_ENTRY_THRESHOLD;
  const containerRef = useRef<HTMLDivElement | null>(null);
  const scrollElementRef = useRef<HTMLElement | null>(null);
  const [containerWidth, setContainerWidth] = useState(0);
  const focusedCardPathRef = useRef<string | null>(null);

  useEffect(() => {
    if (!shouldVirtualize) {
      scrollElementRef.current = null;
      return undefined;
    }

    const container = containerRef.current;
    if (!container) {
      return undefined;
    }

    scrollElementRef.current = findScrollableAncestor(container);
    setContainerWidth(container.getBoundingClientRect().width);

    if (typeof ResizeObserver === 'undefined') {
      return undefined;
    }

    const observer = new ResizeObserver((observedEntries) => {
      const width = observedEntries[0]?.contentRect.width;
      if (typeof width === 'number' && width > 0) {
        setContainerWidth(width);
      }
    });
    observer.observe(container);

    return () => observer.disconnect();
  }, [shouldVirtualize]);

  const handleFocusCapture = useCallback((event: ReactFocusEvent<HTMLDivElement>) => {
    const target = event.target;
    if (!(target instanceof HTMLElement)) {
      return;
    }
    const focusedCard = target.closest<HTMLElement>('[data-library-card-path]');
    const focusedPath = focusedCard?.dataset.libraryCardPath;
    if (focusedPath) {
      focusedCardPathRef.current = focusedPath;
    }
  }, []);

  const columnCount = useMemo(() => {
    if (!shouldVirtualize) return 1;
    const width = containerWidth > 0
      ? containerWidth
      : (containerRef.current?.getBoundingClientRect().width ?? GRID_MIN_COLUMN_PX);
    return Math.max(1, Math.floor((width + GRID_GAP_PX) / (GRID_MIN_COLUMN_PX + GRID_GAP_PX)));
  }, [containerWidth, shouldVirtualize]);

  useLayoutEffect(() => {
    const focusedPath = focusedCardPathRef.current;
    const container = containerRef.current;
    if (!focusedPath || !container) {
      return;
    }
    const activeElement = document.activeElement;
    if (activeElement instanceof Node && container.contains(activeElement)) {
      return;
    }
    focusCardByPath(container, focusedPath);
  }, [columnCount, entries, shouldVirtualize]);

  const rowCount = useMemo(
    () => (shouldVirtualize ? Math.ceil(entries.length / columnCount) : 0),
    [columnCount, entries.length, shouldVirtualize],
  );

  const rowVirtualizer = useVirtualizer({
    count: rowCount,
    getScrollElement: () => scrollElementRef.current,
    estimateSize: () => GRID_ESTIMATED_ROW_HEIGHT,
    overscan: GRID_OVERSCAN_ROWS,
    initialRect: {
      width: GRID_MIN_COLUMN_PX,
      height: GRID_ESTIMATED_ROW_HEIGHT * GRID_OVERSCAN_ROWS,
    },
    getItemKey: (index) => `${keyPrefix}virtual-row-${index}`,
    gap: GRID_GAP_PX,
  });

  if (!shouldVirtualize) {
    return (
      <div
        ref={containerRef}
        className={styles.grid}
        data-testid={testId}
        role="list"
        aria-label="Library cards"
        onFocusCapture={handleFocusCapture}
      >
        {entries.map((entry, index) => renderCard(entry, {
          keyPrefix,
          listItem: {
            position: index + 1,
            setSize: entries.length,
          },
        }))}
      </div>
    );
  }

  const virtualRows = rowVirtualizer.getVirtualItems();

  return (
    <div
      ref={containerRef}
      className={styles.gridVirtualized}
      data-testid={testId ?? 'cards-grid-virtualized'}
      role="list"
      aria-label="Library cards"
      onFocusCapture={handleFocusCapture}
    >
      <div className={styles.gridVirtualizedInner} style={{ height: rowVirtualizer.getTotalSize() }}>
        {virtualRows.map((virtualRow) => {
          const rowStart = virtualRow.index * columnCount;
          const rowEntries = entries.slice(rowStart, rowStart + columnCount);
          return (
            <div
              key={virtualRow.key}
              ref={rowVirtualizer.measureElement}
              data-index={virtualRow.index}
              className={styles.gridVirtualizedRow}
              style={{ transform: `translateY(${virtualRow.start}px)` }}
              role="presentation"
            >
              <div
                className={styles.gridVirtualizedRowGrid}
                style={{ gridTemplateColumns: `repeat(${columnCount}, minmax(0, 1fr))` }}
              >
                {rowEntries.map((entry, columnIndex) => renderCard(entry, {
                  keyPrefix,
                  listItem: {
                    position: rowStart + columnIndex + 1,
                    setSize: entries.length,
                  },
                }))}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

interface MemoryEntryCardProps {
  entry: MemoryCardEntry;
  onOpenPath?: (path: string) => void;
}

function MemoryEntryCard({ entry, onOpenPath }: MemoryEntryCardProps) {
  const timeLabel = formatRelativeTime(entry.createdAt, {
    capitalize: false,
    includeYesterday: false,
    absoluteDateAfterDays: 14,
  });
  const sourceLabel = entry.sourceSessionTitle?.trim() || entry.entity;

  return (
    <article
      className={cn(styles.memoryCard, styles.cardClickable)}
      tabIndex={-1}
      onClick={(event) => {
        if (shouldIgnoreCardClick(event)) {
          return;
        }
        onOpenPath?.(entry.path);
      }}
    >
      <header className={styles.memoryCardHeader}>
        <span className={styles.memoryCardTitle}>
          <Brain size={14} />
          {entry.name}
        </span>
        <Badge variant="muted" size="sm">Memory</Badge>
      </header>
      <p className={styles.memoryCardPath} title={entry.relativePath}>
        {entry.relativePath}
      </p>
      <p className={styles.memoryCardSnippet}>{entry.snippet}</p>
      <div className={styles.memoryCardMeta}>
        <span>{timeLabel}</span>
        <span>·</span>
        <span>{sourceLabel}</span>
      </div>
      <div className={styles.memoryCardTags}>
        {entry.tags.map((tag) => (
          <Badge key={`${entry.id}-${tag}`} variant="muted" size="sm">
            {tag}
          </Badge>
        ))}
      </div>
      <div className={styles.memoryCardActions}>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={(event) => {
            event.stopPropagation();
            onOpenPath?.(entry.path);
          }}
        >
          Open memory
        </Button>
      </div>
    </article>
  );
}

interface SpaceOverviewCardProps {
  entry: SpaceCardEntry;
  onSetActiveSpace?: (spacePath: string) => void;
}

function getSpaceTypeIcon(type: SpaceInfo['type']) {
  switch (type) {
    case 'chief-of-staff':
    case 'personal':
      return { icon: Lock, ariaLabel: 'Personal space' };
    case 'company':
    case 'team':
      return { icon: Briefcase, ariaLabel: 'Work space' };
    case 'project':
      return { icon: Sparkles, ariaLabel: 'Project space' };
    default:
      return { icon: FolderOpen, ariaLabel: 'Space' };
  }
}

function SpaceOverviewCard({
  entry,
  onSetActiveSpace,
}: SpaceOverviewCardProps) {
  const { icon: SpaceIcon, ariaLabel } = getSpaceTypeIcon(entry.sourceSpace.type);
  const lastActiveLabel = entry.lastActiveAt
    ? `Active ${formatRelativeTime(entry.lastActiveAt, { capitalize: false, absoluteDateAfterDays: 14 })}`
    : 'No recent activity yet';
  const filesLabel = entry.fileCount != null
    ? `${entry.fileCount} ${entry.fileCount === 1 ? 'file' : 'files'}`
    : 'Files unavailable';

  return (
    <article
      className={cn(styles.spaceCard, styles.cardClickable)}
      tabIndex={-1}
      onClick={(event) => {
        if (shouldIgnoreCardClick(event)) {
          return;
        }
        onSetActiveSpace?.(entry.relativePath);
      }}
    >
      <header className={styles.spaceCardHeader}>
        <span className={styles.spaceCardTitle}>
          <SpaceIcon size={14} aria-label={ariaLabel} role="img" />
          {entry.name}
        </span>
        <Badge variant="muted" size="sm">Space</Badge>
      </header>
      <div className={styles.spaceCardBody}>
        <p className={styles.spaceCardRole}>{entry.role}</p>
        <p className={styles.spaceCardDescription}>{entry.description}</p>
        <div className={styles.spaceCardMeta}>
          <Clock3 size={12} />
          <span>{lastActiveLabel}</span>
          <span>·</span>
          <span>{filesLabel}</span>
          {entry.storageLabel ? <Badge variant="muted" size="sm">{entry.storageLabel}</Badge> : null}
          {entry.sharingLabel ? <Badge variant="muted" size="sm">{entry.sharingLabel}</Badge> : null}
        </div>
      </div>
      <div className={styles.spaceCardActions}>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={(event) => {
            event.stopPropagation();
            onSetActiveSpace?.(entry.relativePath);
          }}
        >
          Open space
        </Button>
      </div>
    </article>
  );
}

function inferCardKind(entry: LibraryViewEntry): CardKind {
  return classifyLibraryItem({
    path: entry.path,
    relativePath: entry.relativePath,
    skillMeta: entry.skillMeta,
  });
}

function resolveFacetSelection(facet: string | undefined): string | null {
  const normalizedFacet = normalizeFacetValue(facet);
  if (!normalizedFacet || normalizedFacet === 'all') {
    return null;
  }
  return normalizedFacet;
}

function matchesSkillsFacet(entry: SkillCardEntry, facetSelection: string | null): boolean {
  if (!facetSelection) return true;
  return normalizeFacetValue(entry.category) === facetSelection;
}

function matchesMemoryFacet(entry: MemoryCardEntry, facetSelection: string | null): boolean {
  if (!facetSelection) return true;
  return normalizeFacetValue(entry.entity) === facetSelection;
}

function matchesSpacesFacet(entry: SpaceCardEntry, facetSelection: string | null): boolean {
  if (!facetSelection) return true;
  return mapSpaceTypeToFacet(entry.sourceSpace.type) === facetSelection;
}

function matchesEverythingFacet(entry: LibraryViewEntry, facetSelection: string | null): boolean {
  if (!facetSelection) return true;
  return mapLibraryKindToEverythingFacet(inferCardKind(entry)) === facetSelection;
}

function matchesSkillSearch(entry: SkillCardEntry, query: string): boolean {
  if (!query) return true;
  const normalized = query.toLowerCase();
  return (
    entry.name.toLowerCase().includes(normalized)
    || entry.relativePath.toLowerCase().includes(normalized)
    || entry.tags.some((tag) => tag.toLowerCase().includes(normalized))
    || (entry.frontmatter?.description?.toLowerCase().includes(normalized) ?? false)
  );
}

function matchesMemorySearch(entry: MemoryCardEntry, query: string): boolean {
  if (!query) return true;
  const normalized = query.toLowerCase();
  return (
    entry.name.toLowerCase().includes(normalized)
    || entry.relativePath.toLowerCase().includes(normalized)
    || entry.snippet.toLowerCase().includes(normalized)
    || entry.tags.some((tag) => tag.toLowerCase().includes(normalized))
  );
}

function matchesSpaceSearch(entry: SpaceCardEntry, query: string): boolean {
  if (!query) return true;
  const normalized = query.toLowerCase();
  return (
    entry.name.toLowerCase().includes(normalized)
    || entry.relativePath.toLowerCase().includes(normalized)
    || entry.role.toLowerCase().includes(normalized)
    || entry.description.toLowerCase().includes(normalized)
  );
}

function sortSkills(entries: readonly SkillCardEntry[], sortBy: LibrarySortOption): SkillCardEntry[] {
  const sourceWeight: Record<SkillCardEntry['source'], number> = {
    user: 0,
    'built-in': 1,
    community: 2,
  };
  const qualityBandWeight: Record<NonNullable<SkillCardEntry['qualityBand']>, number> = {
    seedling: 1,
    growing: 2,
    solid: 3,
    exemplary: 4,
  };

  return [...entries].sort((left, right) => {
    switch (sortBy) {
      case 'skill-most-used':
      case 'recent': {
        const byUsage = (right.usageCount ?? 0) - (left.usageCount ?? 0);
        if (byUsage !== 0) return byUsage;
        const byLastUsed = (right.lastUsedAt ?? 0) - (left.lastUsedAt ?? 0);
        if (byLastUsed !== 0) return byLastUsed;
        return left.name.localeCompare(right.name, undefined, { sensitivity: 'base' });
      }
      case 'skill-most-polished': {
        const byScore = (right.qualityScore ?? 0) - (left.qualityScore ?? 0);
        if (byScore !== 0) return byScore;
        const byBand = (qualityBandWeight[right.qualityBand ?? 'seedling'])
          - (qualityBandWeight[left.qualityBand ?? 'seedling']);
        if (byBand !== 0) return byBand;
        return left.name.localeCompare(right.name, undefined, { sensitivity: 'base' });
      }
      case 'skill-suggested': {
        const bySource = sourceWeight[left.source] - sourceWeight[right.source];
        if (bySource !== 0) return bySource;
        const byScore = (right.qualityScore ?? 0) - (left.qualityScore ?? 0);
        if (byScore !== 0) return byScore;
        const byUsage = (right.usageCount ?? 0) - (left.usageCount ?? 0);
        if (byUsage !== 0) return byUsage;
        const byLastUsed = (right.lastUsedAt ?? 0) - (left.lastUsedAt ?? 0);
        if (byLastUsed !== 0) return byLastUsed;
        return left.name.localeCompare(right.name, undefined, { sensitivity: 'base' });
      }
      case 'name':
      default:
        return left.name.localeCompare(right.name, undefined, { sensitivity: 'base' });
    }
  });
}

function getMemoryRelevanceScore(entry: MemoryCardEntry, query: string): number {
  if (!query) return 0;
  const normalized = query.toLowerCase();
  let score = 0;
  if (entry.snippet.toLowerCase().includes(normalized)) score += 3;
  if (entry.name.toLowerCase().includes(normalized)) score += 2;
  if (entry.tags.some((tag) => tag.toLowerCase().includes(normalized))) score += 1;
  return score;
}

function sortMemory(
  entries: readonly MemoryCardEntry[],
  sortBy: LibrarySortOption,
  query: string,
): MemoryCardEntry[] {
  return [...entries].sort((left, right) => {
    switch (sortBy) {
      case 'memory-relevance': {
        const byRelevance = getMemoryRelevanceScore(right, query) - getMemoryRelevanceScore(left, query);
        if (byRelevance !== 0) return byRelevance;
        return (right.createdAt ?? 0) - (left.createdAt ?? 0);
      }
      case 'name':
        return left.name.localeCompare(right.name, undefined, { sensitivity: 'base' });
      case 'recent':
      case 'created':
      default: {
        const leftValue = left.createdAt ?? 0;
        const rightValue = right.createdAt ?? 0;
        if (leftValue !== rightValue) return rightValue - leftValue;
        return left.name.localeCompare(right.name, undefined, { sensitivity: 'base' });
      }
    }
  });
}

function sortSpaces(entries: readonly SpaceCardEntry[], sortBy: LibrarySortOption): SpaceCardEntry[] {
  return [...entries].sort((left, right) => {
    switch (sortBy) {
      case 'space-last-active': {
        const byActive = (right.lastActiveAt ?? 0) - (left.lastActiveAt ?? 0);
        if (byActive !== 0) return byActive;
        return left.name.localeCompare(right.name, undefined, { sensitivity: 'base' });
      }
      case 'name':
      default:
        return left.name.localeCompare(right.name, undefined, { sensitivity: 'base' });
    }
  });
}

function isSkillCardEntry(entry: CardsEntry): entry is SkillCardEntry {
  return (entry as SkillCardEntry).kind === 'skill';
}

function isMemoryCardEntry(entry: CardsEntry): entry is MemoryCardEntry {
  return (entry as MemoryCardEntry).kind === 'memory';
}

function isSpaceCardEntry(entry: CardsEntry): entry is SpaceCardEntry {
  return (entry as SpaceCardEntry).kind === 'space';
}

function isPluginCardEntry(entry: CardsEntry): entry is PluginCardEntry {
  return (entry as PluginCardEntry).kind === 'plugin';
}

function matchesPluginSearch(entry: PluginCardEntry, query: string): boolean {
  if (query.length === 0) return true;
  return entry.searchHaystack.includes(query.toLowerCase());
}

function sortPlugins(entries: readonly PluginCardEntry[], sortBy: LibrarySortOption): PluginCardEntry[] {
  const arr = [...entries];
  arr.sort((left, right) => {
    if (sortBy === 'plugin-hero-first') {
      const heroDelta = Number(right.manifest.role === 'hero') - Number(left.manifest.role === 'hero');
      if (heroDelta !== 0) return heroDelta;
      return left.name.localeCompare(right.name, undefined, { sensitivity: 'base' });
    }
    if (sortBy === 'recent' || sortBy === 'modified') {
      const delta = (right.lastUpdatedAt ?? 0) - (left.lastUpdatedAt ?? 0);
      if (delta !== 0) return delta;
      return left.name.localeCompare(right.name, undefined, { sensitivity: 'base' });
    }
    return left.name.localeCompare(right.name, undefined, { sensitivity: 'base' });
  });
  return arr;
}

export interface CardsViewProps {
  filter: LibraryFilter;
  facet?: string;
  searchQuery: string;
  sortBy: LibrarySortOption;
  entries?: LibraryViewEntry[];
  tree?: FileNode[] | null;
  /**
   * Whether the file tree backing this view is a partial (truncated) snapshot.
   * Only qualifies the tree-derived ('everything') empty/search/filter states;
   * skills/memory/spaces/plugins come from separate indexes and stay
   * unqualified. Mirrors the Folders view's `isPartialTree` (Stage 3 honesty).
   */
  isPartialTree?: boolean;
  libraryRootAbsolute: string;
  skillsData?: SkillsScanResult | null;
  skillsLoading?: boolean;
  skillsError?: string | null;
  memoryEntries?: MemoryHistoryEntry[];
  spacesData?: SpaceInfo[];
  favoriteFilePaths?: string[];
  pendingMemoryRequests?: PendingMemoryRequest[];
  memoryLoading?: boolean;
  memoryError?: string | null;
  spacesLoading?: boolean;
  pluginEntries?: PluginCardEntry[];
  pluginsLoading?: boolean;
  pluginsError?: string | null;
  pendingPluginIds?: ReadonlySet<string>;
  loading?: boolean;
  error?: string | null;
  className?: string;
  onRetry?: () => void;
  onOpenPath?: (path: string) => void;
  onUseSkillPath?: (relativePath: string) => void;
  onRevealInClassifiedView?: (path: string) => void;
  onSetActiveSpace?: (spacePath: string) => void;
  onRenameSpace?: (spacePath: string, displayName: string) => void;
  onDeleteSpace?: (spacePath: string, displayName: string) => void;
  onPluginActiveChange?: (entry: PluginCardEntry, next: boolean) => void;
  onPluginAction?: (entry: PluginCardEntry, action: PluginAction) => void;
  onCreateSkill?: () => void;
  onCreateMemory?: () => void;
  onAddSpace?: () => void;
  onCreateFile?: () => void;
}

export function CardsView({
  filter,
  facet,
  searchQuery,
  sortBy,
  entries,
  tree,
  isPartialTree = false,
  libraryRootAbsolute,
  skillsData,
  skillsLoading = false,
  skillsError = null,
  memoryEntries = [],
  spacesData,
  favoriteFilePaths = [],
  pendingMemoryRequests = [],
  memoryLoading = false,
  memoryError = null,
  spacesLoading = false,
  pluginEntries,
  pluginsLoading = false,
  pluginsError = null,
  pendingPluginIds,
  loading = false,
  error = null,
  className,
  onRetry,
  onOpenPath,
  onUseSkillPath,
  onRevealInClassifiedView,
  onSetActiveSpace,
  onRenameSpace,
  onDeleteSpace,
  onPluginActiveChange,
  onPluginAction,
  onCreateSkill,
  onCreateMemory,
  onAddSpace,
  onCreateFile,
}: CardsViewProps) {
  const [collapsedGroups, setCollapsedGroups] = useState<Record<string, boolean>>({});
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const contextMenuRef = useRef<HTMLDivElement | null>(null);
  const scrollContainerRef = useRef<HTMLElement | null>(null);
  const scrollPositionsByFilterRef = useRef(new Map<LibraryFilter, number>());
  const previousFilterRef = useRef<LibraryFilter>(filter);
  const normalizedQuery = searchQuery.trim();
  const normalizedEverythingQuery = normalizeSearchQuery(normalizedQuery);
  const facetSelection = resolveFacetSelection(facet);
  const spaceRoots = useMemo(() => buildSpaceRoots(spacesData), [spacesData]);

  useLayoutEffect(() => {
    const rootElement = rootRef.current;
    if (!rootElement) {
      previousFilterRef.current = filter;
      return;
    }

    const scrollElement = scrollContainerRef.current ?? findScrollableAncestor(rootElement);
    if (!scrollElement) {
      previousFilterRef.current = filter;
      return;
    }
    scrollContainerRef.current = scrollElement;

    const previousFilter = previousFilterRef.current;
    if (previousFilter !== filter) {
      const restoredScrollTop = scrollPositionsByFilterRef.current.get(filter) ?? 0;
      scrollElement.scrollTop = restoredScrollTop;
    }

    previousFilterRef.current = filter;
  }, [filter]);

  useEffect(() => {
    const rootElement = rootRef.current;
    if (!rootElement) {
      return undefined;
    }

    const scrollElement = scrollContainerRef.current ?? findScrollableAncestor(rootElement);
    if (!scrollElement) {
      return undefined;
    }
    scrollContainerRef.current = scrollElement;

    const persistScrollTop = () => {
      scrollPositionsByFilterRef.current.set(filter, scrollElement.scrollTop);
    };
    persistScrollTop();

    scrollElement.addEventListener('scroll', persistScrollTop);
    return () => {
      scrollElement.removeEventListener('scroll', persistScrollTop);
      persistScrollTop();
    };
  }, [filter]);

  const everythingEntries = useMemo(
    () => {
      if (filter !== 'everything') {
        return [];
      }
      return (entries ?? flattenTreeEntries(tree, libraryRootAbsolute))
        .filter((entry) => entry.kind === 'file');
    },
    [entries, filter, libraryRootAbsolute, tree],
  );
  const skillEntries = useMemo(
    () => (filter === 'skills' ? skillIndexToCardEntries(skillsData) : []),
    [filter, skillsData],
  );
  const memoryCardEntries = useMemo(
    () => (
      filter === 'memory'
        ? memoryHistoryToCardEntries(memoryEntries, pendingMemoryRequests, libraryRootAbsolute)
        : []
    ),
    [filter, libraryRootAbsolute, memoryEntries, pendingMemoryRequests],
  );
  const spaceCardEntries = useMemo(
    () => (filter === 'spaces' ? spacesToCardEntries(spacesData, tree) : []),
    [filter, spacesData, tree],
  );
  const pluginCardEntries = useMemo<PluginCardEntry[]>(
    () => (filter === 'plugins' ? (pluginEntries ?? []) : []),
    [filter, pluginEntries],
  );

  const sourceEntryCount = useMemo(() => {
    switch (filter) {
      case 'skills':
        return skillEntries.length;
      case 'memory':
        return memoryCardEntries.length;
      case 'spaces':
        return spaceCardEntries.length;
      case 'plugins':
        return pluginCardEntries.length;
      case 'everything':
        return everythingEntries.length;
      default:
        return 0;
    }
  }, [
    memoryCardEntries.length,
    skillEntries.length,
    everythingEntries.length,
    filter,
    pluginCardEntries.length,
    spaceCardEntries.length,
  ]);
  const shouldShowMemoryCapHint = filter === 'memory' && memoryEntries.length >= MEMORY_HISTORY_VISIBLE_CAP;

  const filteredAndSortedEntries = useMemo<CardsEntry[]>(() => {
    if (filter === 'skills') {
      const filteredByFacet = skillEntries.filter((entry) => matchesSkillsFacet(entry, facetSelection));
      const filtered = filteredByFacet.filter((entry) => matchesSkillSearch(entry, normalizedQuery));
      return sortSkills(filtered, sortBy);
    }
    if (filter === 'memory') {
      const filteredByFacet = memoryCardEntries.filter((entry) => matchesMemoryFacet(entry, facetSelection));
      const filtered = filteredByFacet.filter((entry) => matchesMemorySearch(entry, normalizedQuery));
      return sortMemory(filtered, sortBy, normalizedQuery);
    }
    if (filter === 'spaces') {
      const filteredByFacet = spaceCardEntries.filter((entry) => matchesSpacesFacet(entry, facetSelection));
      const filtered = filteredByFacet.filter((entry) => matchesSpaceSearch(entry, normalizedQuery));
      return sortSpaces(filtered, sortBy);
    }
    if (filter === 'plugins') {
      const filtered = pluginCardEntries.filter((entry) => matchesPluginSearch(entry, normalizedQuery));
      return sortPlugins(filtered, sortBy);
    }

    const filteredByFacet = everythingEntries.filter((entry) => matchesEverythingFacet(entry, facetSelection));
    const filtered = filteredByFacet.filter((entry) => (
      matchesPlainText(entry.name, normalizedEverythingQuery)
      || matchesPlainText(entry.relativePath, normalizedEverythingQuery)
      || matchesPlainText(entry.summary, normalizedEverythingQuery)
    ));
    return sortEntries(filtered, sortBy);
  }, [
    everythingEntries,
    facetSelection,
    filter,
    memoryCardEntries,
    normalizedEverythingQuery,
    normalizedQuery,
    pluginCardEntries,
    skillEntries,
    sortBy,
    spaceCardEntries,
  ]);

  const favoritePathSet = useMemo(() => new Set(favoriteFilePaths), [favoriteFilePaths]);
  const supportsPinning = filter !== 'spaces' && filter !== 'plugins';
  const pinnedEntries = useMemo(
    () => supportsPinning
      ? filteredAndSortedEntries.filter(
          (entry) => !isSpaceCardEntry(entry) && !isPluginCardEntry(entry) && favoritePathSet.has(entry.path),
        )
      : [],
    [favoritePathSet, filteredAndSortedEntries, supportsPinning],
  );
  const unpinnedEntries = useMemo(
    () => supportsPinning
      ? filteredAndSortedEntries.filter(
          (entry) => isSpaceCardEntry(entry) || isPluginCardEntry(entry) || !favoritePathSet.has(entry.path),
        )
      : filteredAndSortedEntries,
    [favoritePathSet, filteredAndSortedEntries, supportsPinning],
  );

  const groupedEntries = useFilterGrouping(filter, unpinnedEntries);

  const openPath = useCallback((path: string) => {
    onOpenPath?.(path);
  }, [onOpenPath]);

  const handleOpenMemoryEntry = useCallback((entry: MemoryCardEntry) => {
    if (!onOpenPath) {
      return;
    }

    if (typeof window === 'undefined' || typeof window.libraryApi?.statFile !== 'function') {
      onOpenPath(entry.path);
      return;
    }

    void resolveMemoryEntryPath({
      recordedFilePath: entry.relativePath,
      entity: entry.entity,
      libraryRootAbsolute,
      spaces: spacesData ?? [],
    }).then((resolved) => {
      if (!resolved) {
        onOpenPath(entry.path);
        return;
      }

      onOpenPath(resolved.absolutePath);

      if (!resolved.repaired) {
        return;
      }

      console.warn('[library] Repaired memory entry path while opening card', {
        entryId: entry.id,
        recordedFilePath: entry.relativePath,
        repairedFilePath: resolved.effectiveRelativePath,
      });

      const repairEntryPath = window.memoryApi?.repairEntryPath;
      if (typeof repairEntryPath === 'function') {
        void repairEntryPath({
          entryId: entry.id,
          repairedFilePath: resolved.effectiveRelativePath,
        }).catch((error: unknown) => {
          console.warn('[library] Failed to persist repaired memory entry path', {
            entryId: entry.id,
            repairedFilePath: resolved.effectiveRelativePath,
            error,
          });
        });
      }
    }).catch((error: unknown) => {
      console.warn('[library] Failed to resolve memory entry path; opening recorded path', {
        entryId: entry.id,
        recordedFilePath: entry.relativePath,
        error,
      });
      onOpenPath(entry.path);
    });
  }, [libraryRootAbsolute, onOpenPath, spacesData]);

  const showRawCallbackCacheRef = useRef(new Map<string, () => void>());
  useEffect(() => {
    showRawCallbackCacheRef.current.clear();
  }, [openPath]);
  const getShowRawCallback = useCallback((path: string) => {
    const existing = showRawCallbackCacheRef.current.get(path);
    if (existing) return existing;
    const created = () => openPath(path);
    showRawCallbackCacheRef.current.set(path, created);
    return created;
  }, [openPath]);

  const useSkillCallbackCacheRef = useRef(new Map<string, () => void>());
  useEffect(() => {
    useSkillCallbackCacheRef.current.clear();
  }, [onUseSkillPath]);
  const getUseSkillCallback = useCallback((relativePath: string) => {
    if (!onUseSkillPath) return undefined;
    const existing = useSkillCallbackCacheRef.current.get(relativePath);
    if (existing) return existing;
    const created = () => onUseSkillPath(relativePath);
    useSkillCallbackCacheRef.current.set(relativePath, created);
    return created;
  }, [onUseSkillPath]);

  useEffect(() => {
    const activePaths = new Set(
      filteredAndSortedEntries
        .filter((entry): entry is LibraryViewEntry => !isPluginCardEntry(entry))
        .map((entry) => entry.path),
    );
    for (const cachedPath of showRawCallbackCacheRef.current.keys()) {
      if (!activePaths.has(cachedPath)) {
        showRawCallbackCacheRef.current.delete(cachedPath);
      }
    }

    const activeSkillRelativePaths = new Set<string>();
    for (const entry of filteredAndSortedEntries) {
      if (isPluginCardEntry(entry)) continue;
      if (isSkillCardEntry(entry)) {
        activeSkillRelativePaths.add(entry.relativePath);
        continue;
      }
      if (!isMemoryCardEntry(entry) && !isSpaceCardEntry(entry) && inferCardKind(entry) === 'skill') {
        activeSkillRelativePaths.add(entry.relativePath);
      }
    }

    for (const cachedRelativePath of useSkillCallbackCacheRef.current.keys()) {
      if (!activeSkillRelativePaths.has(cachedRelativePath)) {
        useSkillCallbackCacheRef.current.delete(cachedRelativePath);
      }
    }
  }, [filteredAndSortedEntries]);

  useEffect(() => {
    const groupKeys = new Set(groupedEntries.map((group) => group.key));
    setCollapsedGroups((previous) => {
      const next: Record<string, boolean> = {};
      let changed = false;

      for (const group of groupedEntries) {
        if (group.collapsible) {
          const collapsed = previous[group.key] ?? !group.defaultExpanded;
          next[group.key] = collapsed;
          if (previous[group.key] !== collapsed) {
            changed = true;
          }
        }
      }

      for (const key of Object.keys(previous)) {
        if (!groupKeys.has(key)) {
          changed = true;
        }
      }

      if (!changed && Object.keys(previous).length === Object.keys(next).length) {
        return previous;
      }
      return next;
    });
  }, [groupedEntries]);

  useEffect(() => {
    if (!contextMenu) return undefined;

    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setContextMenu(null);
      }
    };
    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (target instanceof Node && contextMenuRef.current?.contains(target)) {
        return;
      }
      setContextMenu(null);
    };

    document.addEventListener('keydown', handleEscape);
    document.addEventListener('pointerdown', handlePointerDown);
    return () => {
      document.removeEventListener('keydown', handleEscape);
      document.removeEventListener('pointerdown', handlePointerDown);
    };
  }, [contextMenu]);

  const toggleGroup = useCallback((groupKey: string) => {
    setCollapsedGroups((previous) => ({
      ...previous,
      [groupKey]: !previous[groupKey],
    }));
  }, []);

  const openContextMenu = useCallback((
    event: ReactMouseEvent<HTMLElement>,
    actions: ContextMenuAction[],
  ) => {
    if (actions.length === 0) return;
    event.preventDefault();
    event.stopPropagation();
    setContextMenu({
      x: event.clientX,
      y: event.clientY,
      actions,
    });
  }, []);

  const buildFileRevealAction = useCallback((entry: FileBackedCardEntry): ContextMenuAction => {
    const skillMeta = 'skillSource' in entry
      ? entry.skillSource
      : ('skillMeta' in entry ? entry.skillMeta : undefined);
    const reveal = getRevealClassification(
      {
        path: entry.path,
        relativePath: entry.relativePath,
        skillMeta,
      },
      spaceRoots,
    );
    return {
      key: 'reveal',
      label: reveal.label,
      onSelect: () => onRevealInClassifiedView?.(entry.path),
    };
  }, [onRevealInClassifiedView, spaceRoots]);

  const buildFileActions = useCallback((entry: FileBackedCardEntry): ContextMenuAction[] => {
    const actions: ContextMenuAction[] = [
      {
        key: 'open',
        label: 'Open',
        onSelect: () => openPath(entry.path),
      },
      buildFileRevealAction(entry),
    ];
    return actions;
  }, [buildFileRevealAction, openPath]);

  const buildSpaceActions = useCallback((entry: SpaceCardEntry): ContextMenuAction[] => {
    const actions: ContextMenuAction[] = [
      {
        key: 'open-space',
        label: 'Open space',
        onSelect: () => onSetActiveSpace?.(entry.relativePath),
      },
    ];
    if (onRenameSpace) {
      actions.push({
        key: 'rename-space',
        label: 'Rename',
        onSelect: () => onRenameSpace(entry.relativePath, entry.name),
      });
    }
    if (onDeleteSpace) {
      const deleteActionLabel = entry.sourceSpace.isSymlink
        ? 'Remove space…'
        : 'Delete space…';
      actions.push({
        key: 'delete-space',
        label: deleteActionLabel,
        onSelect: () => onDeleteSpace(entry.relativePath, entry.name),
        danger: true,
      });
    }
    return actions;
  }, [onDeleteSpace, onRenameSpace, onSetActiveSpace]);

  const renderCard = useCallback<RenderCard>((entry, metadata = {}) => {
    const keyPrefix = metadata.keyPrefix ?? '';
    const listItemAccessibilityProps = getListItemAccessibilityProps(metadata.listItem);

    if (isSkillCardEntry(entry)) {
      const actions = buildFileActions(entry);
      return (
        <div
          key={`${keyPrefix}${entry.id}`}
          onContextMenu={(event) => openContextMenu(event, actions)}
          data-testid="cards-entry-skill"
          data-library-card-path={entry.path}
          tabIndex={-1}
          {...listItemAccessibilityProps}
        >
          <SkillCard
            presentation="grid"
            content={entry.content}
            documentPath={entry.path}
            relativePath={entry.relativePath}
            fileName={entry.name}
            frontmatter={entry.frontmatter}
            skillSource={entry.skillSource}
            sharing={entry.sharing}
            storageProvider={entry.storageProvider}
            examplePaths={entry.examplePaths}
            qualityScore={entry.qualityScore}
            qualityBand={entry.qualityBand}
            qualityTopImprovement={entry.qualityTopImprovement}
            onShowRaw={getShowRawCallback(entry.path)}
            onUseSkill={getUseSkillCallback(entry.relativePath)}
            onOpenFilePath={openPath}
          />
        </div>
      );
    }

    if (isMemoryCardEntry(entry)) {
      const actions = buildFileActions(entry);
      return (
        <div
          key={`${keyPrefix}${entry.id}`}
          onContextMenu={(event) => openContextMenu(event, actions)}
          data-testid="cards-entry-memory"
          data-library-card-path={entry.path}
          tabIndex={-1}
          {...listItemAccessibilityProps}
        >
          <MemoryEntryCard
            entry={entry}
            onOpenPath={() => handleOpenMemoryEntry(entry)}
          />
        </div>
      );
    }

    if (isSpaceCardEntry(entry)) {
      const actions = buildSpaceActions(entry);
      return (
        <div
          key={`${keyPrefix}${entry.id}`}
          onContextMenu={(event) => openContextMenu(event, actions)}
          data-testid="cards-entry-space"
          data-library-card-path={entry.path}
          tabIndex={-1}
          {...listItemAccessibilityProps}
        >
          <SpaceOverviewCard
            entry={entry}
            onSetActiveSpace={onSetActiveSpace}
          />
        </div>
      );
    }

    if (isPluginCardEntry(entry)) {
      const isPending = pendingPluginIds?.has(entry.pluginId) ?? false;
      return (
        <div
          key={`${keyPrefix}${entry.id}`}
          data-testid="cards-entry-plugin"
          data-library-card-path={entry.id}
          tabIndex={-1}
          {...listItemAccessibilityProps}
        >
          <PluginCard
            manifest={entry.manifest}
            origin={entry.origin}
            spacePath={entry.spacePath}
            isActive={entry.isActive}
            isBuiltIn={entry.isBuiltIn}
            isPending={isPending}
            conflictFiles={entry.conflictFiles}
            onActiveChange={(next) => onPluginActiveChange?.(entry, next)}
            onAction={onPluginAction ? (action) => onPluginAction(entry, action) : undefined}
          />
        </div>
      );
    }

    const kind = inferCardKind(entry);
    switch (kind) {
      case 'skill': {
        const actions = buildFileActions(entry);
        return (
          <div
            key={`${keyPrefix}${entry.id}`}
            onContextMenu={(event) => openContextMenu(event, actions)}
            data-testid="cards-entry-skill-file"
            data-library-card-path={entry.path}
            tabIndex={-1}
            {...listItemAccessibilityProps}
          >
            <SkillCard
              presentation="grid"
              content={entry.content ?? `# ${entry.name}\n`}
              documentPath={entry.path}
              relativePath={entry.relativePath}
              fileName={entry.name}
              onShowRaw={getShowRawCallback(entry.path)}
              onUseSkill={getUseSkillCallback(entry.relativePath)}
              onOpenFilePath={openPath}
            />
          </div>
        );
      }
      case 'memory': {
        const actions = buildFileActions(entry);
        const fallbackMemoryEntry: MemoryCardEntry = {
          id: entry.id,
          kind: 'memory',
          name: entry.name,
          path: entry.path,
          relativePath: entry.relativePath,
          snippet: entry.summary ?? 'Memory file',
          createdAt: entry.mtime ?? 0,
          sourceSessionId: '',
          sourceTurnId: '',
          entity: 'Memory',
          visibility: 'private',
          tags: ['memory'],
        };
        return (
          <div
            key={`${keyPrefix}${entry.id}`}
            onContextMenu={(event) => openContextMenu(event, actions)}
            data-testid="cards-entry-memory-file"
            data-library-card-path={entry.path}
            tabIndex={-1}
            {...listItemAccessibilityProps}
          >
            <MemoryEntryCard
              entry={fallbackMemoryEntry}
              onOpenPath={openPath}
            />
          </div>
        );
      }
      case 'plain': {
        const actions = buildFileActions(entry);
        return (
          <div
            key={`${keyPrefix}${entry.id}`}
            onContextMenu={(event) => openContextMenu(event, actions)}
            data-testid="cards-entry-file"
            data-library-card-path={entry.path}
            tabIndex={-1}
            {...listItemAccessibilityProps}
          >
            <FileCard
              entry={entry}
              onOpenPath={openPath}
            />
          </div>
        );
      }
      default:
        return assertNever(kind);
    }
  }, [
    buildFileActions,
    buildSpaceActions,
    getShowRawCallback,
    getUseSkillCallback,
    handleOpenMemoryEntry,
    onPluginAction,
    onPluginActiveChange,
    onSetActiveSpace,
    openContextMenu,
    openPath,
    pendingPluginIds,
  ]);

  if (filter === 'skills' && skillsLoading && sourceEntryCount === 0) {
    return <LibraryLensEmptyState mode="loading" filter={filter} view="cards" />;
  }

  if (filter === 'skills' && skillsError && sourceEntryCount === 0) {
    return (
      <LibraryLensEmptyState
        mode="error"
        filter={filter}
        view="cards"
        errorMessage={skillsError}
        onRetry={onRetry}
      />
    );
  }

  if (filter === 'memory' && memoryLoading && sourceEntryCount === 0) {
    return <LibraryLensEmptyState mode="loading" filter={filter} view="cards" />;
  }

  if (filter === 'memory' && memoryError && sourceEntryCount === 0) {
    return (
      <LibraryLensEmptyState
        mode="error"
        filter={filter}
        view="cards"
        errorMessage={memoryError}
        onRetry={onRetry}
      />
    );
  }

  if (filter === 'spaces' && spacesLoading && sourceEntryCount === 0) {
    return <LibraryLensEmptyState mode="loading" filter={filter} view="cards" />;
  }

  if (filter === 'plugins' && pluginsLoading && sourceEntryCount === 0) {
    return <LibraryLensEmptyState mode="loading" filter={filter} view="cards" />;
  }

  if (filter === 'plugins' && pluginsError && sourceEntryCount === 0) {
    return (
      <LibraryLensEmptyState
        mode="error"
        filter={filter}
        view="cards"
        errorMessage={pluginsError}
        onRetry={onRetry}
      />
    );
  }

  if (loading && sourceEntryCount === 0) {
    return <LibraryLensEmptyState mode="loading" filter={filter} view="cards" />;
  }

  if (error && sourceEntryCount === 0) {
    return (
      <LibraryLensEmptyState
        mode="error"
        filter={filter}
        view="cards"
        errorMessage={error}
        onRetry={onRetry}
      />
    );
  }

  if (filteredAndSortedEntries.length === 0) {
    // Only the 'everything' filter is derived from the (possibly partial) file
    // tree; qualify ITS empty/search/filter states with the incomplete-Library
    // hint so a partial tree is never presented as authoritative "none".
    // skills/memory/spaces/plugins come from separate indexes — leave them
    // unqualified (matches the Folders view's tree-only honesty).
    const showTreePartialHint = isPartialTree && filter === 'everything';

    if (normalizedQuery.length > 0) {
      return (
        <>
          <LibraryLensEmptyState
            mode="search-no-results"
            filter={filter}
            view="cards"
            query={normalizedQuery}
          />
          <IncompleteLibraryHint show={showTreePartialHint} />
        </>
      );
    }

    if (facetSelection && sourceEntryCount > 0) {
      return (
        <>
          <LibraryLensEmptyState
            mode="filter-mismatch"
            filter={filter}
            view="cards"
          />
          <IncompleteLibraryHint show={showTreePartialHint} />
        </>
      );
    }

    return (
      <FilterCardsEmptyState
        filter={filter}
        isPartialTree={isPartialTree}
        onCreateSkill={onCreateSkill}
        onCreateMemory={onCreateMemory}
        onAddSpace={onAddSpace}
        onCreateFile={onCreateFile}
      />
    );
  }

  const shouldRenderGroupingHeaders = filter === 'skills' || filter === 'memory';
  const unpinnedSectionLabel = pinnedEntries.length > 0 ? 'Other items' : 'All items';

  return (
    <div ref={rootRef} className={cn(styles.root, className)}>
      {contextMenu ? (
        <div
          ref={contextMenuRef}
          className={styles.contextMenu}
          style={{ top: contextMenu.y, left: contextMenu.x }}
          role="menu"
          data-testid="cards-context-menu"
        >
          {contextMenu.actions.map((action) => (
            <Button
              key={action.key}
              type="button"
              variant="ghost"
              size="sm"
              className={cn(styles.contextMenuItem, action.danger && styles.contextMenuItemDanger)}
              onClick={() => {
                action.onSelect();
                setContextMenu(null);
              }}
            >
              {action.label}
            </Button>
          ))}
        </div>
      ) : null}

      {pinnedEntries.length > 0 ? (
        <section className={styles.section}>
          <header className={styles.sectionHeader}>
            <h3 className={styles.sectionTitle}>Pinned</h3>
            <span className={styles.sectionCount}>{pinnedEntries.length}</span>
          </header>
          <CardsEntryGrid
            entries={pinnedEntries}
            renderCard={renderCard}
            keyPrefix="pinned-"
            testId="cards-view-pinned-section"
          />
        </section>
      ) : null}

      {groupedEntries.map((group) => {
        const isCollapsed = group.collapsible ? (collapsedGroups[group.key] ?? false) : false;
        const showHeader = shouldRenderGroupingHeaders || pinnedEntries.length > 0;
        const sectionLabel = shouldRenderGroupingHeaders ? group.label : unpinnedSectionLabel;
        return (
          <section key={group.key} className={styles.section} data-testid={`cards-group-${group.key}`}>
            {showHeader ? (
              <header className={styles.sectionHeader}>
                {group.collapsible ? (
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className={styles.groupToggle}
                    onClick={() => toggleGroup(group.key)}
                    aria-expanded={!isCollapsed}
                  >
                    {isCollapsed ? <ChevronRight size={14} /> : <ChevronDown size={14} />}
                  </Button>
                ) : null}
                <h3 className={styles.sectionTitle}>{sectionLabel}</h3>
                <span className={styles.sectionCount}>{group.entries.length}</span>
              </header>
            ) : null}
            {!isCollapsed ? (
              <CardsEntryGrid
                entries={group.entries}
                renderCard={renderCard}
                keyPrefix={`${group.key}-`}
              />
            ) : null}
          </section>
        );
      })}

      {shouldShowMemoryCapHint ? (
        <div className={styles.memoryCapHintRow} data-testid="cards-memory-cap-hint">
          <Badge variant="muted" size="sm" className={styles.memoryCapHint}>
            Showing the most recent 5,000 memories. Search reaches across all of them.
          </Badge>
        </div>
      ) : null}
    </div>
  );
}
