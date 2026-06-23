import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent, ReactNode } from 'react';
import {
  useFloating,
  autoUpdate,
  offset,
  flip,
  shift,
  useClick,
  useDismiss,
  useRole,
  useInteractions,
  FloatingPortal,
} from '@floating-ui/react';
import {
  Brain,
  Files,
  FolderOpen,
  FolderTree,
  LayoutGrid,
  Map,
  MoreHorizontal,
  Puzzle,
  ScrollText,
  Search,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { Button, IconButton, Input, Select } from '@renderer/components/ui';
import { Tooltip } from '@renderer/components/ui/Tooltip';
import { cn } from '@renderer/lib/utils';
import { tracking } from '@renderer/src/tracking';
import type { FacetOption } from '../hooks/useFilterFacets';
import {
  FILTER_SPECS,
  VIEW_SPECS,
  type LibraryFilter,
  type LibraryLens,
  type LibrarySortOption,
  type LibraryView,
} from '../types/lens';
import {
  getDefaultSortForFilter,
  normalizeSortForFilter,
  useFilterAwareSort,
} from '../hooks/useFilterAwareSort';
import { normalizeFacetValue } from '../utils/facets';
import { LibraryFilterPopover } from './LibraryFilterPopover';
import styles from './LibraryLensBar.module.css';

// Signpost: this control's copy/ARIA/token intent is defined in
// `docs/plans/260522_library_lens_unification.md` (UI Brief + Picker Decision) and summarized in
// `docs/project/UI_OVERVIEW.md` / `docs/project/UI_CSS_ARCHITECTURE.md`.
// Order finalized in 260521 plan v3.1 design synthesis: plugins-after-spaces because
// plugins are owned-by-a-Space artefacts (peer to spaces in the IA hierarchy).
const FILTER_ORDER: readonly LibraryFilter[] = ['spaces', 'plugins', 'skills', 'memory', 'everything'];
const VIEW_ORDER: readonly LibraryView[] = ['folders', 'cards', 'atlas'];

const FILTER_ICONS: Record<LibraryFilter, LucideIcon> = {
  spaces: FolderOpen,
  plugins: Puzzle,
  skills: ScrollText,
  memory: Brain,
  everything: Files,
};

const VIEW_ICONS: Record<LibraryView, LucideIcon> = {
  folders: FolderTree,
  cards: LayoutGrid,
  atlas: Map,
};

type SegmentedOption<T extends string> = {
  id: T;
  label: string;
  icon?: LucideIcon;
  testId: string;
  ariaLabel: string;
  tooltip?: string;
};

export type LibraryLensOverflowAction = {
  id: string;
  label: string;
  icon: LucideIcon;
  onClick: () => void;
  disabled?: boolean;
  tooltip?: string;
  active?: boolean;
  indicator?: 'indexing' | 'spinning';
};

type LibrarySegmentedControlProps<T extends string> = {
  label: string;
  axisLabel: string;
  options: readonly SegmentedOption<T>[];
  value: T;
  onChange: (next: T) => void;
  disabled?: boolean;
  className?: string;
  frameClassName?: string;
};

function getNextIndex(
  index: number,
  optionCount: number,
  direction: 'previous' | 'next',
): number {
  if (optionCount <= 0) return 0;
  if (direction === 'next') {
    return (index + 1) % optionCount;
  }
  return (index - 1 + optionCount) % optionCount;
}

function LibrarySegmentedControl<T extends string>({
  label,
  axisLabel,
  options,
  value,
  onChange,
  disabled = false,
  className,
  frameClassName,
}: LibrarySegmentedControlProps<T>) {
  const buttonRefs = useRef<Array<HTMLButtonElement | null>>([]);

  const handleArrowNavigation = useCallback((next: number) => {
    const nextOption = options[next];
    if (!nextOption) return;
    onChange(nextOption.id);
    buttonRefs.current[next]?.focus();
  }, [onChange, options]);

  const handleKeyDown = useCallback((index: number, event: KeyboardEvent<HTMLButtonElement>) => {
    if (event.key === 'ArrowRight' || event.key === 'ArrowDown') {
      event.preventDefault();
      handleArrowNavigation(getNextIndex(index, options.length, 'next'));
      return;
    }

    if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') {
      event.preventDefault();
      handleArrowNavigation(getNextIndex(index, options.length, 'previous'));
      return;
    }

    if (event.key === 'Home') {
      event.preventDefault();
      handleArrowNavigation(0);
      return;
    }

    if (event.key === 'End') {
      event.preventDefault();
      handleArrowNavigation(options.length - 1);
    }
  }, [handleArrowNavigation, options.length]);

  return (
    <div className={cn(styles.axisGroup, className)}>
      <span className={styles.axisLabel}>{label}</span>
      <div
        className={cn(styles.segmentedFrame, frameClassName)}
        role="radiogroup"
        aria-label={axisLabel}
      >
        {options.map((option, index) => {
          const Icon = option.icon;
          const isActive = option.id === value;
          return (
            <Button
              key={option.id}
              ref={(node) => {
                buttonRefs.current[index] = node;
              }}
              type="button"
              variant="ghost"
              size="sm"
              role="radio"
              aria-label={option.ariaLabel}
              aria-checked={isActive}
              tabIndex={isActive ? 0 : -1}
              disabled={disabled}
              className={cn(styles.segmentedChip, isActive && styles.segmentedChipActive)}
              data-testid={option.testId}
              title={option.tooltip}
              onClick={() => onChange(option.id)}
              onKeyDown={(event) => handleKeyDown(index, event)}
            >
              {Icon ? <Icon size={14} className={styles.segmentedChipIcon} /> : null}
              <span>{option.label}</span>
            </Button>
          );
        })}
      </div>
    </div>
  );
}

function prefersReducedMotion(): boolean {
  if (typeof window === 'undefined' || !window.matchMedia) return false;
  try {
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch {
    return false;
  }
}

function getFacetFilterLabel(filter: LibraryFilter): string {
  switch (filter) {
    case 'skills':
      return 'skill category';
    case 'memory':
      return 'memory space';
    case 'spaces':
      return 'space type';
    case 'plugins':
      return 'space';
    case 'everything':
      return 'library item type';
    default:
      return 'results';
  }
}

export interface LibraryLensBarProps {
  lens: LibraryLens;
  facets?: readonly FacetOption[];
  searchQuery: string;
  sortBy: LibrarySortOption;
  primaryActions?: ReactNode;
  overflowActions?: readonly LibraryLensOverflowAction[];
  setBrowseLens: (next: LibraryLens | ((prev: LibraryLens) => LibraryLens)) => void;
  onSearchQueryChange: (nextQuery: string) => void;
  onSortByChange: (nextSort: LibrarySortOption) => void;
  orientationTipDismissed: boolean;
  dismissOrientationTip: () => void;
  revealedFoldersCount?: number;
  searchPlaceholder?: string;
  disabled?: boolean;
  className?: string;
}

export function LibraryLensBar({
  lens,
  facets = [],
  searchQuery,
  sortBy,
  primaryActions,
  overflowActions = [],
  setBrowseLens,
  onSearchQueryChange,
  onSortByChange,
  orientationTipDismissed,
  dismissOrientationTip,
  revealedFoldersCount,
  searchPlaceholder = 'Search this view…',
  disabled = false,
  className,
}: LibraryLensBarProps) {
  const [transientSuffix, setTransientSuffix] = useState<string | null>(null);
  const [isOverflowMenuOpen, setIsOverflowMenuOpen] = useState(false);

  const filterOptions = useMemo<readonly SegmentedOption<LibraryFilter>[]>(() => (
    FILTER_ORDER.map((filter) => ({
      id: filter,
      label: FILTER_SPECS[filter].label,
      icon: FILTER_ICONS[filter],
      testId: `library-filter-chip-${filter}`,
      ariaLabel: `Show ${FILTER_SPECS[filter].label}`,
    }))
  ), []);

  const viewOptions = useMemo<readonly SegmentedOption<LibraryView>[]>(() => (
    VIEW_ORDER.map((view) => ({
      id: view,
      label: VIEW_SPECS[view].label,
      icon: VIEW_ICONS[view],
      testId: `library-view-chip-${view}`,
      ariaLabel: `View as ${VIEW_SPECS[view].label}`,
    }))
  ), []);

  const { sortOptions } = useFilterAwareSort(lens.filter, lens.view, searchQuery);
  const supportedSortValues = useMemo(
    () => new Set<LibrarySortOption>(sortOptions.map((option) => option.value)),
    [sortOptions],
  );
  const previousFilterRef = useRef<LibraryFilter>(lens.filter);
  const previousViewRef = useRef<LibraryView>(lens.view);
  const hasInitializedRef = useRef(false);
  const hasVisibleFacets = facets.length > 1;
  const hasOverflowActions = overflowActions.length > 0;

  const {
    refs: overflowMenuRefs,
    floatingStyles: overflowMenuStyles,
    context: overflowMenuContext,
  } = useFloating({
    open: isOverflowMenuOpen,
    onOpenChange: setIsOverflowMenuOpen,
    placement: 'bottom-end',
    middleware: [offset(4), flip({ padding: 8 }), shift({ padding: 8 })],
    whileElementsMounted: autoUpdate,
  });
  const overflowMenuClick = useClick(overflowMenuContext);
  const overflowMenuDismiss = useDismiss(overflowMenuContext);
  const overflowMenuRole = useRole(overflowMenuContext, { role: 'menu' });
  const {
    getReferenceProps: getOverflowReferenceProps,
    getFloatingProps: getOverflowFloatingProps,
  } = useInteractions([
    overflowMenuClick,
    overflowMenuDismiss,
    overflowMenuRole,
  ]);

  const activeFacetValue = useMemo(() => {
    const selectedFacet = normalizeFacetValue(lens.facet);
    if (!selectedFacet || selectedFacet === 'all') {
      return 'all';
    }
    const matchingFacet = facets.find((facet) => normalizeFacetValue(facet.id) === selectedFacet);
    return matchingFacet?.id ?? 'all';
  }, [facets, lens.facet]);

  const resetFacet = useCallback(() => {
    setBrowseLens((previous) => {
      if (previous.facet === undefined) {
        return previous;
      }
      return { ...previous, facet: undefined };
    });
  }, [setBrowseLens]);
  const showLabel = FILTER_SPECS[lens.filter].label;
  const viewLabel = VIEW_SPECS[lens.view].label;
  const activeSort = normalizeSortForFilter(sortBy, lens.filter, lens.view, searchQuery);

  useEffect(() => {
    const previousFilter = previousFilterRef.current;
    const previousView = previousViewRef.current;
    const isFirstMount = !hasInitializedRef.current;
    const filterChanged = previousFilter !== lens.filter;
    const viewChanged = previousView !== lens.view;
    const contextChanged = isFirstMount || filterChanged || viewChanged;
    hasInitializedRef.current = true;

    if (!contextChanged) {
      return;
    }

    if (!isFirstMount && (filterChanged || viewChanged)) {
      resetFacet();
    }

    // Preserve invalid-sort normalization behavior in the dedicated effect below.
    const normalizedSort = normalizeSortForFilter(sortBy, lens.filter, lens.view, searchQuery);
    if (normalizedSort !== sortBy) {
      previousFilterRef.current = lens.filter;
      previousViewRef.current = lens.view;
      return;
    }

    const defaultSort = getDefaultSortForFilter(lens.filter, lens.view, searchQuery);
    if (defaultSort && defaultSort !== sortBy) {
      onSortByChange(defaultSort);
    }
    previousFilterRef.current = lens.filter;
    previousViewRef.current = lens.view;
  }, [lens.filter, lens.view, onSortByChange, resetFacet, searchQuery, sortBy]);

  useEffect(() => {
    if (!activeSort) return;
    if (activeSort !== sortBy) {
      onSortByChange(activeSort);
    }
  }, [activeSort, onSortByChange, sortBy]);

  const handleFilterChange = useCallback((filter: LibraryFilter) => {
    if (filter === lens.filter) return;
    setBrowseLens((previous) => ({ ...previous, filter, facet: undefined }));
    tracking.library.lensChanged({
      filter,
      view: lens.view,
      axis: 'filter',
    });
    if (!orientationTipDismissed) {
      dismissOrientationTip();
    }
  }, [dismissOrientationTip, lens.filter, lens.view, orientationTipDismissed, setBrowseLens]);

  const handleViewChange = useCallback((view: LibraryView) => {
    if (view === lens.view) return;
    setBrowseLens((previous) => ({ ...previous, view, facet: undefined }));
    tracking.library.lensChanged({
      filter: lens.filter,
      view,
      axis: 'view',
    });
    if (!orientationTipDismissed) {
      dismissOrientationTip();
    }
  }, [dismissOrientationTip, lens.filter, lens.view, orientationTipDismissed, setBrowseLens]);

  const handleFacetChange = useCallback((nextFacet: string) => {
    setBrowseLens((previous) => ({
      ...previous,
      facet: nextFacet === 'all' ? undefined : nextFacet,
    }));
  }, [setBrowseLens]);

  const handleOverflowActionClick = useCallback((action: LibraryLensOverflowAction) => {
    action.onClick();
    setIsOverflowMenuOpen(false);
  }, []);

  useEffect(() => {
    if (!hasOverflowActions && isOverflowMenuOpen) {
      setIsOverflowMenuOpen(false);
    }
  }, [hasOverflowActions, isOverflowMenuOpen]);

  useEffect(() => {
    if (lens.facet === undefined) return;
    if (activeFacetValue !== 'all') return;
    resetFacet();
  }, [activeFacetValue, lens.facet, resetFacet]);

  useEffect(() => {
    if (!revealedFoldersCount || revealedFoldersCount <= 0) {
      setTransientSuffix(null);
      return;
    }

    setTransientSuffix(
      `${revealedFoldersCount} more folder${revealedFoldersCount === 1 ? '' : 's'} revealed`,
    );

    const timeoutMs = prefersReducedMotion() ? 3000 : 3200;
    const timeoutId = window.setTimeout(() => {
      setTransientSuffix(null);
    }, timeoutMs);

    return () => window.clearTimeout(timeoutId);
  }, [revealedFoldersCount]);

  return (
    <div className={cn(styles.root, className)} data-testid="library-lens-bar">
      <div className={styles.axisRow}>
        <LibrarySegmentedControl
          label="Show"
          axisLabel="Show"
          options={filterOptions}
          value={lens.filter}
          onChange={handleFilterChange}
          disabled={disabled}
        />
        <LibrarySegmentedControl
          label="View as"
          axisLabel="View as"
          options={viewOptions}
          value={lens.view}
          onChange={handleViewChange}
          disabled={disabled}
        />
      </div>

      <div className={styles.controlsRow}>
        <div className={styles.searchField} data-testid="library-lens-search-field">
          <Search size={14} className={styles.searchIcon} aria-hidden />
          <Input
            inputSize="sm"
            value={searchQuery}
            onChange={(event) => onSearchQueryChange(event.currentTarget.value)}
            placeholder={searchPlaceholder}
            aria-label="Search library"
            className={cn(
              styles.searchInput,
              !hasVisibleFacets && styles.searchInputWithoutFilter,
            )}
            disabled={disabled}
            data-testid="library-lens-search-input"
          />
          {hasVisibleFacets ? (
            <LibraryFilterPopover
              facets={facets}
              activeFacetValue={activeFacetValue}
              filterLabel={getFacetFilterLabel(lens.filter)}
              onFacetChange={handleFacetChange}
              disabled={disabled}
            />
          ) : null}
        </div>
        {sortOptions.length > 0 && activeSort ? (
          <div className={styles.sortField}>
            <span className={styles.sortLabel}>Sort</span>
            <Select
              selectSize="sm"
              value={activeSort}
              aria-label="Sort library view"
              className={styles.sortSelect}
              disabled={disabled}
              data-testid="library-lens-sort-select"
              onChange={(event) => {
                const nextValue = event.currentTarget.value;
                if (!supportedSortValues.has(nextValue as LibrarySortOption)) return;
                onSortByChange(nextValue as LibrarySortOption);
              }}
            >
              {sortOptions.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </Select>
          </div>
        ) : null}
        {primaryActions || hasOverflowActions ? (
          <div className={styles.actionsSlot}>
            {primaryActions ? <div className={styles.primaryActionsSlot}>{primaryActions}</div> : null}
            {hasOverflowActions ? (
              <>
                {primaryActions ? <div className={styles.actionsDivider} aria-hidden /> : null}

                <div className={styles.overflowInlineActions}>
                  {overflowActions.map((action) => {
                    const Icon = action.icon;
                    const tooltip = action.tooltip ?? action.label;
                    const indicatorClassName = action.indicator === 'indexing'
                      ? styles.overflowActionIndexing
                      : action.indicator === 'spinning'
                        ? styles.overflowActionSpinning
                        : undefined;
                    return (
                      <Tooltip key={action.id} content={tooltip} placement="bottom">
                        <IconButton
                          variant="ghost"
                          size="lg"
                          onClick={action.onClick}
                          disabled={action.disabled}
                          active={action.active}
                          className={indicatorClassName}
                          aria-label={action.label}
                          data-testid={`library-overflow-inline-${action.id}`}
                        >
                          <Icon size={18} />
                        </IconButton>
                      </Tooltip>
                    );
                  })}
                </div>

                <div className={styles.overflowMenuSlot}>
                  <Tooltip content="More actions" placement="bottom">
                    <IconButton
                      ref={overflowMenuRefs.setReference}
                      variant="ghost"
                      size="lg"
                      aria-label="More actions"
                      aria-haspopup="menu"
                      aria-expanded={isOverflowMenuOpen}
                      data-testid="library-overflow-menu-trigger"
                      {...getOverflowReferenceProps()}
                    >
                      <MoreHorizontal size={18} />
                    </IconButton>
                  </Tooltip>
                  {isOverflowMenuOpen ? (
                    <FloatingPortal>
                      <div
                        ref={overflowMenuRefs.setFloating}
                        style={overflowMenuStyles}
                        className={styles.overflowMenu}
                        role="menu"
                        data-testid="library-overflow-menu"
                        {...getOverflowFloatingProps()}
                      >
                        {overflowActions.map((action) => {
                          const Icon = action.icon;
                          return (
                            <button
                              key={action.id}
                              type="button"
                              className={cn(
                                styles.overflowMenuItem,
                                action.active && styles.overflowMenuItemActive,
                              )}
                              role="menuitem"
                              disabled={action.disabled}
                              data-testid={`library-overflow-menu-item-${action.id}`}
                              onClick={() => handleOverflowActionClick(action)}
                            >
                              <Icon size={14} className={styles.overflowMenuItemIcon} />
                              <span className={styles.overflowMenuItemLabel}>{action.label}</span>
                              {action.indicator === 'indexing' ? (
                                <span className={styles.overflowMenuIndicator}>Indexing</span>
                              ) : null}
                            </button>
                          );
                        })}
                      </div>
                    </FloatingPortal>
                  ) : null}
                </div>
              </>
            ) : null}
          </div>
        ) : null}
      </div>

      <span
        role="status"
        aria-live="polite"
        aria-atomic="true"
        className={styles.screenReaderStatus}
        data-testid="library-lens-sentence"
      >
        Showing {showLabel} as {viewLabel}
        {transientSuffix ? ` — ${transientSuffix}` : ''}
      </span>
    </div>
  );
}
