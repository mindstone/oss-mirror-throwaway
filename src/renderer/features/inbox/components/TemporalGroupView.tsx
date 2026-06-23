import { memo, useMemo, useState, useCallback, useRef, useEffect } from 'react';
import { Sparkles, Rocket, Plug, MessageSquare, Zap, Trash2 } from 'lucide-react';
import { Button } from '@renderer/components/ui';
import { tracking } from '@renderer/src/tracking';
import type { InboxItem, InboxHistoryEntry } from '@shared/types';
import { deriveInboxStatus, isPriorityPinnedToToday } from '@rebel/shared';
import { getInboxZeroMessage } from '../utils/quadrant';
import {
  groupByTemporal,
  TEMPORAL_GROUP_META,
  type TemporalGroup,
  type ConcreteTemporalGroup,
} from '../utils/temporalGroup';
import { getTemporalGroup, computeTemporalBoundaries } from '@rebel/shared';
import { filterInboxViewItems } from '../utils/filterInboxViewItems';
import { useInboxKeyboardShortcuts } from '../hooks/useInboxKeyboardShortcuts';

import { sortInboxItems } from '../utils/sortInboxItems';
import { InboxItemCard } from './InboxItemCard';
import { RebelHandledSection } from './RebelHandledSection';
import type { ViewMode } from './InboxFilterDropdown';
import styles from './TemporalGroupView.module.css';

export type TemporalGroupViewProps = {
  items: InboxItem[];
  history: InboxHistoryEntry[];
  loading: boolean;
  busySessionIds?: Set<string>;
  viewMode?: ViewMode;
  activeTemporalTab: TemporalGroup;
  onExecute: (item: InboxItem, context: string | undefined, pinAfter: boolean) => void;
  onDone?: (itemId: string) => void;
  onDismiss?: (itemId: string) => void;
  onRestore?: (itemId: string) => void;
  onOpenFile?: (filePath: string) => void;
  onOpenSession?: (sessionId: string) => void;
  onOpenDetail?: (itemId: string, context?: string) => void;
  onSetPriority?: (itemId: string, urgent: boolean, important: boolean) => void;
  onSetSchedule?: (itemId: string, group: ConcreteTemporalGroup) => void;
  calendarMatchedIds?: Set<string>;
  archivedCount?: number;
  searchQuery?: string;
  selectedTags?: Set<string>;
  selectedIds?: Set<string>;
  onToggleSelect?: (id: string) => void;
  onSelectAll?: (ids: string[]) => void;
  onClearSelection?: () => void;
  /** Pre-computed filtered view items (avoids duplicate computation with parent). */
  preFilteredViewItems?: InboxItem[];
  /** Pre-computed temporal groups (avoids duplicate computation with parent). */
  preTemporalGroups?: Map<ConcreteTemporalGroup, InboxItem[]>;
  autoDoneByItemId?: Record<string, boolean>;
  onAutoDoneChange?: (itemId: string, value: boolean) => void;
  hasConnectedTools?: boolean;
  hasEverHadItems?: boolean;
  onNavigateToConnectors?: () => void;
};

const TemporalGroupViewComponent = ({
  items,
  history,
  loading,
  busySessionIds,
  viewMode = 'active',
  activeTemporalTab,
  onExecute,
  onDone,
  onDismiss,
  onRestore,
  onOpenFile,
  onOpenSession,
  onOpenDetail,
  onSetPriority,
  onSetSchedule,
  calendarMatchedIds,
  archivedCount,
  searchQuery: controlledSearchQuery,
  selectedTags: controlledSelectedTags,
  selectedIds: controlledSelectedIds,
  onToggleSelect,
  onSelectAll,
  onClearSelection,
  preFilteredViewItems,
  preTemporalGroups,
  autoDoneByItemId,
  onAutoDoneChange,
  hasConnectedTools = false,
  hasEverHadItems = false,
  onNavigateToConnectors,
}: TemporalGroupViewProps) => {
  const [expandedItemId, setExpandedItemId] = useState<string | null>(null);

  const searchQuery = controlledSearchQuery ?? '';
  const EMPTY_TAGS = useMemo(() => new Set<string>(), []);
  const selectedTags = controlledSelectedTags ?? EMPTY_TAGS;

  const ACTIVE_STATUSES = useMemo(() => new Set(['active', 'executing']), []);
  const activeItems = useMemo(() => items.filter(item => ACTIVE_STATUSES.has(deriveInboxStatus(item))), [items, ACTIVE_STATUSES]);
  const nonActiveItems = useMemo(() => items.filter(item => !ACTIVE_STATUSES.has(deriveInboxStatus(item))), [items, ACTIVE_STATUSES]);
  const effectiveArchivedCount = archivedCount ?? nonActiveItems.length;

  const rebelHandledItems = useMemo(() => {
    if (viewMode !== 'active') return [];
    const now = new Date();
    const todayMs = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
    return items.filter(i =>
      i.archived && i.autoCompleted && i.archivedAt != null && i.archivedAt >= todayMs
    );
  }, [items, viewMode]);

  const viewItems = useMemo(
    () => preFilteredViewItems ?? filterInboxViewItems(items, viewMode, searchQuery, selectedTags),
    [preFilteredViewItems, items, viewMode, searchQuery, selectedTags],
  );

  const temporalGroups = useMemo(
    () => preTemporalGroups ?? groupByTemporal(viewItems),
    [preTemporalGroups, viewItems],
  );

  const hasActiveFilters = searchQuery.trim().length > 0 || selectedTags.size > 0;
  const isEmpty = viewMode === 'active' ? activeItems.length === 0
    : viewMode === 'archived' ? effectiveArchivedCount === 0
    : viewMode === 'done' ? (viewItems.length === 0 && history.length === 0)
    : viewItems.length === 0;
  const isFilteredEmpty = hasActiveFilters && viewItems.length === 0 && !isEmpty;
  const inboxZeroMessage = useMemo(() => getInboxZeroMessage(), []);


  const itemsById = useMemo(() => {
    const map = new Map<string, InboxItem>();
    for (const item of items) map.set(item.id, item);
    return map;
  }, [items]);

  const [departingIds, setDepartingIds] = useState<Set<string>>(new Set());

  const handleExecuteClick = useCallback((itemId: string, pinAfter: boolean, context?: string) => {
    const item = itemsById.get(itemId);
    if (!item) return;
    if (!pinAfter) {
      setDepartingIds(prev => new Set([...prev, itemId]));
      setTimeout(() => {
        setDepartingIds(prev => {
          if (!prev.has(itemId)) return prev;
          const next = new Set(prev);
          next.delete(itemId);
          return next;
        });
      }, 450);
    }
    onExecute(item, context, pinAfter);
  }, [onExecute, itemsById]);

  const isRestoringView = viewMode === 'archived' || viewMode === 'dismissed' || viewMode === 'done';

  const handleToggleExpand = useCallback((itemId: string) => {
    setExpandedItemId(prev => prev === itemId ? null : itemId);
  }, []);

  const currentTabItems = useMemo(() => {
    const raw = activeTemporalTab === 'all' ? viewItems : (temporalGroups.get(activeTemporalTab) ?? []);
    return sortInboxItems(raw);
  }, [temporalGroups, activeTemporalTab, viewItems]);

  const containerRef = useRef<HTMLDivElement>(null);
  const [focusedItemId, setFocusedItemId] = useState<string | null>(null);

  const visibleItemIds = useMemo(() => {
    return currentTabItems.map(item => item.id);
  }, [currentTabItems]);

  const EMPTY_SELECTION = useMemo(() => new Set<string>(), []);
  const selectedIds = controlledSelectedIds ?? EMPTY_SELECTION;
  const selectionActive = selectedIds.size > 0;

  const handleNavigateDown = useCallback(() => {
    if (visibleItemIds.length === 0) return;
    setFocusedItemId(prev => {
      const idx = prev ? visibleItemIds.indexOf(prev) : -1;
      const next = idx < visibleItemIds.length - 1 ? idx + 1 : 0;
      return visibleItemIds[next] ?? null;
    });
  }, [visibleItemIds]);

  const handleNavigateUp = useCallback(() => {
    if (visibleItemIds.length === 0) return;
    setFocusedItemId(prev => {
      const idx = prev ? visibleItemIds.indexOf(prev) : -1;
      const next = idx > 0 ? idx - 1 : visibleItemIds.length - 1;
      return visibleItemIds[next] ?? null;
    });
  }, [visibleItemIds]);

  const temporalBoundaries = useMemo(() => computeTemporalBoundaries(), []);
  const itemTemporalGroupMap = useMemo(() => {
    const map = new Map<string, ConcreteTemporalGroup>();
    for (const item of viewItems) {
      map.set(
        item.id,
        getTemporalGroup(item, temporalBoundaries, { calendarMatchedIds, itemId: item.id }),
      );
    }
    return map;
  }, [viewItems, temporalBoundaries, calendarMatchedIds]);

  const handleScheduleCycleFocused = useCallback(() => {
    if (!focusedItemId || !onSetSchedule) return;
    const focusedItem = viewItems.find(i => i.id === focusedItemId);
    if (focusedItem && isPriorityPinnedToToday(focusedItem)) return;
    const currentGroup = itemTemporalGroupMap.get(focusedItemId);
    const CYCLE: ConcreteTemporalGroup[] = ['due-today', 'due-this-week', 'upcoming'];
    const idx = currentGroup ? CYCLE.indexOf(currentGroup) : -1;
    const nextGroup = CYCLE[(idx + 1) % CYCLE.length];
    onSetSchedule(focusedItemId, nextGroup);
  }, [focusedItemId, onSetSchedule, itemTemporalGroupMap, viewItems]);

  useInboxKeyboardShortcuts({
    containerRef,
    focusedItemId,
    expandedItemId,
    selectedIds,
    isActive: true,
    onExecuteFocused: useCallback(() => {
      if (focusedItemId) handleExecuteClick(focusedItemId, true);
    }, [focusedItemId, handleExecuteClick]),
    onDoneFocused: useCallback(() => {
      if (focusedItemId) onDone?.(focusedItemId);
    }, [focusedItemId, onDone]),
    onDismissFocused: useCallback(() => {
      if (focusedItemId) onDismiss?.(focusedItemId);
    }, [focusedItemId, onDismiss]),
    onScheduleCycleFocused: handleScheduleCycleFocused,
    onToggleSelectFocused: useCallback(() => {
      if (focusedItemId && onToggleSelect) onToggleSelect(focusedItemId);
    }, [focusedItemId, onToggleSelect]),
    onSelectAll: useCallback(() => {
      if (onSelectAll) onSelectAll(visibleItemIds);
    }, [onSelectAll, visibleItemIds]),
    onCollapseExpand: useCallback(() => setExpandedItemId(null), []),
    onClearSelection: useCallback(() => { onClearSelection?.(); }, [onClearSelection]),
    onNavigateUp: handleNavigateUp,
    onNavigateDown: handleNavigateDown,
  });

  useEffect(() => {
    if (!focusedItemId || !containerRef.current) return;
    const card = containerRef.current.querySelector<HTMLElement>(
      `[data-item-id="${CSS.escape(focusedItemId)}"]`
    );
    if (card) {
      card.focus();
      card.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }
  }, [focusedItemId]);

  useEffect(() => {
    setFocusedItemId(prev => {
      if (prev && !visibleItemIds.includes(prev)) return null;
      return prev;
    });
  }, [visibleItemIds]);

  const doneSessionMap = useMemo(() => {
    if (viewMode !== 'done') return new Map<string, string>();
    const map = new Map<string, string>();
    for (const entry of history) {
      if (!map.has(entry.id)) map.set(entry.id, entry.sessionId);
    }
    return map;
  }, [viewMode, history]);

  const isDoneView = viewMode === 'done';

  const renderItemCard = useCallback((item: InboxItem) => (
    <InboxItemCard
      key={item.id}
      item={item}
      isDeparting={departingIds.has(item.id)}
      executionStatus={
        !item.executingSessionId ? 'idle'
        : busySessionIds?.has(item.executingSessionId) ? 'running'
        : 'queued'
      }
      isExpanded={expandedItemId === item.id}
      onToggleExpand={() => handleToggleExpand(item.id)}
      onOpenDetail={onOpenDetail}
      onExecute={handleExecuteClick}
      onDone={isRestoringView ? undefined : onDone}
      onDismiss={isRestoringView ? undefined : onDismiss}
      onRestore={isRestoringView ? onRestore : undefined}
      onOpenFile={onOpenFile}
      onOpenSession={onOpenSession}
      onSetPriority={onSetPriority}
      onSetSchedule={isRestoringView ? undefined : onSetSchedule}
      currentTemporalGroup={itemTemporalGroupMap.get(item.id)}
      isArchived={isRestoringView}
      isDone={isDoneView}
      doneSessionId={doneSessionMap.get(item.id)}
      isSelected={selectedIds.has(item.id)}
      onToggleSelect={onToggleSelect ? () => onToggleSelect(item.id) : undefined}
      selectionActive={selectionActive}
      autoDone={autoDoneByItemId?.[item.id]}
      onAutoDoneChange={onAutoDoneChange}
    />
  ), [departingIds, busySessionIds, expandedItemId, handleToggleExpand, onOpenDetail, handleExecuteClick, onDone, onDismiss, onRestore, onOpenFile, onOpenSession, onSetPriority, onSetSchedule, isRestoringView, itemTemporalGroupMap, isDoneView, doneSessionMap, selectedIds, onToggleSelect, selectionActive, autoDoneByItemId, onAutoDoneChange]);

  // Smart-group accordion rendering removed — all items render flat now.

  const showLoading = loading;

  const getEmptyState = () => {
    if (viewMode === 'active') {
      return { Icon: Sparkles, title: 'Action Zero', message: inboxZeroMessage, className: styles.emptyIconActive };
    } else if (viewMode === 'done') {
      return { Icon: Rocket, title: 'Nothing completed yet', message: "Finished items show up here — yours and Rebel's", className: styles.emptyIconArchived };
    }
    return { Icon: Trash2, title: 'Nothing deleted', message: 'Deleted actions show up here briefly in case you need the trail.', className: styles.emptyIconArchived };
  };

  if (showLoading) {
    return <div className={styles.loadingState}>Gathering items…</div>;
  }

  const doneHasHistory = viewMode === 'done' && history.length > 0;

  if (isFilteredEmpty && !doneHasHistory) {
    return (
      <div className={styles.emptyState}>
        <p className={styles.noSearchResults}>No items match your filters</p>
      </div>
    );
  }

  if (isEmpty && viewMode === 'active' && !hasEverHadItems && !hasConnectedTools) {
    return (
      <div className={styles.emptyState}>
        <div className={`${styles.emptyStateIcon} ${styles.emptyIconActive}`}>
          <Plug size={48} strokeWidth={1.5} />
        </div>
        <p className={styles.emptyStateTitle}>Your action board</p>
        <p className={styles.emptyStateMessage}>
          Connect your calendar, email, or other tools — Rebel captures the follow-ups and tasks so you don&apos;t have to.
        </p>
        {onNavigateToConnectors && (
          <Button
            variant="outline"
            className={styles.emptyStateCta}
            onClick={() => {
              tracking.inbox.emptyStateCtaClicked('connect-tools');
              onNavigateToConnectors();
            }}
          >
            <Plug size={16} aria-hidden="true" />
            Connect your tools
          </Button>
        )}
        <div className={styles.emptyStateHints}>
          <div className={styles.emptyStateHint}>
            <MessageSquare size={14} aria-hidden="true" />
            <span>Actions also appear from conversations</span>
          </div>
          <div className={styles.emptyStateHint}>
            <Zap size={14} aria-hidden="true" />
            <span>And from automations you set up</span>
          </div>
        </div>
      </div>
    );
  }

  if (isEmpty && viewMode === 'active' && !hasEverHadItems && hasConnectedTools) {
    return (
      <div className={styles.emptyState}>
        <p className={styles.emptyStateTitle}>Gathering your action items</p>
        <p className={styles.emptyStateMessage}>
          Rebel is going through your connected tools to surface tasks, follow-ups, and anything that needs your attention. This can take a few minutes.
        </p>
        <div className={styles.gatheringState} aria-hidden="true">
          <div className={styles.skeletonCard}>
            <div className={styles.skeletonHeader}>
              <div className={`${styles.skeletonLine} ${styles.skeletonLineShort}`} />
              <div className={`${styles.skeletonLine} ${styles.skeletonLineBadge}`} />
            </div>
            <div className={`${styles.skeletonLine} ${styles.skeletonLineLong}`} />
            <div className={`${styles.skeletonLine} ${styles.skeletonLineMedium}`} />
          </div>
          <div className={styles.skeletonCard}>
            <div className={styles.skeletonHeader}>
              <div className={`${styles.skeletonLine} ${styles.skeletonLineMedium}`} />
              <div className={`${styles.skeletonLine} ${styles.skeletonLineBadge}`} />
            </div>
            <div className={`${styles.skeletonLine} ${styles.skeletonLineLong}`} />
          </div>
          <div className={`${styles.skeletonCard} ${styles.skeletonCardFaded}`}>
            <div className={styles.skeletonHeader}>
              <div className={`${styles.skeletonLine} ${styles.skeletonLineShort}`} />
            </div>
            <div className={`${styles.skeletonLine} ${styles.skeletonLineMedium}`} />
          </div>
        </div>
      </div>
    );
  }

  if (isEmpty) {
    const { Icon, title, message, className } = getEmptyState();
    return (
      <div className={styles.emptyState}>
        <div className={`${styles.emptyStateIcon} ${className}`}>
          <Icon size={48} strokeWidth={1.5} />
        </div>
        <p className={styles.emptyStateTitle}>{title}</p>
        <p className={styles.emptyStateMessage}>{message}</p>
      </div>
    );
  }

  const currentMeta = TEMPORAL_GROUP_META[activeTemporalTab];

  return (
    <div className={styles.container} ref={containerRef}>
      {currentTabItems.length === 0 && !doneHasHistory && (
        <p className={styles.tabEmpty}>{currentMeta.emptyMessage || 'No items here yet.'}</p>
      )}
      {currentTabItems.length > 0 && (
        <div className={styles.cardList}>
          {currentTabItems.map(renderItemCard)}
        </div>
      )}

      {viewMode === 'done' && history.length > 0 && (
        <div className={styles.executedList}>
          {history.map(entry => (
            <div key={`${entry.id}-${entry.executedAt}`} className={styles.executedCard}>
              <div className={styles.executedCardHeader}>
                <span className={styles.executedCardTitle}>{entry.title}</span>
                <span className={styles.executedCardTime}>
                  {new Date(entry.executedAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}
                </span>
              </div>
              {entry.text && <p className={styles.executedCardText}>{entry.text}</p>}
              <button
                className={styles.executedCardButton}
                onClick={() => onOpenSession?.(entry.sessionId)}
              >
                Open conversation
              </button>
            </div>
          ))}
        </div>
      )}

      {viewMode === 'active' && (
        <RebelHandledSection items={rebelHandledItems} onOpenSession={onOpenSession} />
      )}
    </div>
  );
};

export const TemporalGroupView = memo(TemporalGroupViewComponent);
TemporalGroupView.displayName = 'TemporalGroupView';
