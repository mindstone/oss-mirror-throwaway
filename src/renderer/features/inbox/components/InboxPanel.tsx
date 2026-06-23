import { memo, useState, useCallback, useMemo, useRef, useEffect } from 'react';
import type { InboxHistoryEntry, InboxItem, InboxLayoutMode, SocialPlatform } from '@shared/types';
import { priorityToQuadrant, computeCalendarMatchedIds, getPriorityLabel, isPriorityPinnedToToday } from '@rebel/shared';
import type { PriorityLevel } from '@rebel/shared';
import { IconButton, Tooltip, useToast } from '@renderer/components/ui';
import { MCPNotificationCard } from './MCPNotificationCard';
import type { ContributionNotificationItem } from '@renderer/features/homepage/hooks/useContributionNotifications';
import { Info, Plug, StickyNote, FileStack } from 'lucide-react';
import { formatAcceleratorDisplay } from '@renderer/utils/acceleratorUtils';
import { tracking } from '@renderer/src/tracking';
import { useMentionContext } from '@renderer/contexts';
import type { FileAttachment } from '@renderer/features/composer/hooks/useFileAttachments';
import { useMeetingCache } from '@renderer/features/usecases/hooks/useMeetingCache';
import { InboxItemDetailModal } from './InboxItemDetailModal';
import { InboxFilterDropdown, type ViewMode } from './InboxFilterDropdown';
import { TemporalGroupView } from './TemporalGroupView';
import { InboxSearchCombobox } from './InboxSearchCombobox';
import { InboxSelectionBar } from './InboxSelectionBar';
import { StagedFilesStrip } from './StagedFilesStrip';
import { ActionDeleteReasonDialog, type ActionDeleteReason } from './ActionDeleteReasonDialog';
import { useStagedFiles } from '../hooks/useStagedFiles';
import { useUndoStack } from '../hooks/useUndoStack';
import { useInboxSelection } from '../hooks/useInboxSelection';
import type { ExecutionStatus } from '../hooks/useOptimisticExecution';
import { buildPublishAllToast } from '../utils/buildPublishAllToast';
import { buildActionToast } from '../utils/buildActionToast';
import { filterInboxViewItems } from '../utils/filterInboxViewItems';
import {
  groupByTemporal,
  TEMPORAL_GROUP_META,
  type TemporalGroup,
  type ConcreteTemporalGroup,
} from '../utils/temporalGroup';
import { getScheduleDueBy } from '@rebel/shared';
import styles from './InboxPanel.module.css';

type InboxConnectionStatus = 'loading' | 'connected' | 'disconnected';
type ActionSourceGroupId =
  | 'meetings'
  | 'conversations'
  | 'automations'
  | 'research'
  | 'documents'
  | 'email'
  | 'roles'
  | 'other';
type ActionTimeFilter = 'due-today' | 'due-this-week' | 'all';

const ACTION_TIME_FILTERS: Array<{
  id: ActionTimeFilter;
  label: string;
}> = [
  { id: 'due-today', label: 'Today' },
  { id: 'due-this-week', label: 'This week' },
  { id: 'all', label: 'All' },
];

const ACTION_PRIORITY_FILTERS: PriorityLevel[] = ['urgent', 'high', 'medium', 'low'];

const ACTION_SOURCE_GROUP_META: Record<ActionSourceGroupId, { label: string; order: number }> = {
  meetings: { label: 'Meetings', order: 0 },
  conversations: { label: 'Conversations', order: 1 },
  automations: { label: 'Automations', order: 2 },
  research: { label: 'Research', order: 3 },
  documents: { label: 'Documents', order: 4 },
  email: { label: 'Email', order: 5 },
  roles: { label: 'Team', order: 6 },
  other: { label: 'Other', order: 7 },
};

const MAX_SOURCE_GROUPS = 8;

function getActionSourceGroupId(item: InboxItem): ActionSourceGroupId {
  if (item.source?.kind === 'meeting' || item.category === 'meeting-action') return 'meetings';
  if (item.source?.kind === 'conversation') return 'conversations';
  if (item.source?.kind === 'automation') return 'automations';
  if (item.source?.kind === 'role') return 'roles';
  if (item.references?.some((reference) => reference.kind === 'email')) return 'email';
  if (item.source?.kind === 'workspace' || item.references?.some((reference) => reference.kind === 'workspace')) return 'documents';

  const sourceLabel = item.source?.label?.toLowerCase() ?? '';
  if (item.source?.kind === 'text' && /\b(research|analysis)\b/.test(sourceLabel)) return 'research';

  return 'other';
}

type InboxPanelProps = {
  items: InboxItem[];
  history: InboxHistoryEntry[];
  loading: boolean;
  busySessionIds?: Set<string>;
  internalConnectionStatus: InboxConnectionStatus;
  internalConnectionPending: boolean;
  canAutoConnectInternal: boolean;
  onConnectInternal: () => void;
  onOpenInboxSettings: () => void;
  /** Execute with Rebel. pinAfter=true keeps conversation active; false archives it. */
  onExecute: (item: InboxItem, context: string | undefined, pinAfter: boolean, attachments?: FileAttachment[]) => void;
  onShare: (item: InboxItem, platform: SocialPlatform, text: string) => void;
  onDone: (itemId: string) => void;
  onDismiss: (itemId: string, reason?: ActionDeleteReason) => void;
  onOpenSession: (sessionId: string) => void;
  onOpenFile?: (filePath: string) => void;
  onOpenFolder?: (folderPath: string) => void;
  onSetTags?: (itemId: string, tags: string[]) => void;
  onSetPriority?: (itemId: string, urgent: boolean, important: boolean) => void | Promise<boolean | void>;
  onSetSchedule?: (itemId: string, targetGroup: ConcreteTemporalGroup) => void | Promise<boolean | void>;
  /** Navigate to a session (used by staged file review) */
  onNavigateToSession?: (sessionId: string) => void;
  /** Send a message to a specific session (used by staged file review and approvals) */
  onSendMessageToSession?: (sessionId: string, message: string, receiptText?: string) => Promise<void>;
  /** Open the scratchpad modal */
  onOpenScratchpad?: () => void;
  /** Navigate to Settings > Connectors to add tools */
  onNavigateToConnectors?: () => void;
  /** Number of user-connected tools (calendar, email, etc.) */
  connectedConnectorCount?: number;
  // Layout mode — currently unused (grid/list toggle removed from UI).
  // Props kept for API compatibility so App.tsx doesn't need changes.
  /** @deprecated Grid/list toggle removed; always renders card view. */
  inboxLayoutMode?: InboxLayoutMode;
  /** @deprecated Grid/list toggle removed. */
  onInboxLayoutModeChange?: (mode: InboxLayoutMode) => void;
  archivedCount?: number;
  /** MCP contribution notification items to display in the inbox. */
  mcpNotifications?: ContributionNotificationItem[];
  /** Callback to dismiss (acknowledge) an MCP contribution notification on the drawer surface. */
  onDismissMcpNotification?: (contributionId: string, status: string) => void;
  /** Callback to navigate to the connector in Settings (for approved notifications). */
  onViewMcpConnector?: () => void;
  /** Callback to spawn a follow-up session for changes (for changes_requested notifications). */
  onMakeMcpChanges?: (notification: ContributionNotificationItem) => void;
};

const InboxPanelComponent = ({
  items,
  history,
  loading,
  busySessionIds,
  internalConnectionStatus,
  internalConnectionPending,
  canAutoConnectInternal,
  onConnectInternal,
  onOpenInboxSettings,
  onExecute,
  onDone,
  onDismiss,
  onOpenSession,
  onOpenFile,
  onSetTags,
  onSetPriority,
  onSetSchedule,
  onNavigateToSession,
  onSendMessageToSession,
  onOpenScratchpad,
  onNavigateToConnectors,
  connectedConnectorCount = 0,
  // inboxLayoutMode and onInboxLayoutModeChange accepted for API compat but unused
  archivedCount,
  mcpNotifications = [],
  onDismissMcpNotification,
  onViewMcpConnector,
  onMakeMcpChanges,
}: InboxPanelProps) => {
  // Mention props from context (eliminates prop drilling from App.tsx)
  const {
    mentionResultsForQuery,
    ensureLibraryIndex,
    getRelativeLibraryPath,
    hasWorkspace,
    hasConversations,
    coreDirectory,
    libraryIndex,
    libraryIndexLoading,
    libraryIndexError,
    refreshLibraryIndex,
  } = useMentionContext();
  const showActiveLoading = loading;
  const [detailItemId, setDetailItemId] = useState<string | null>(null);
  const [detailInitialContext, setDetailInitialContext] = useState<string | undefined>(undefined);
  const [deleteRequest, setDeleteRequest] = useState<
    | { kind: 'single'; itemId: string; title?: string; closeDetail?: boolean }
    | { kind: 'batch'; itemIds: string[]; title?: string }
    | null
  >(null);
  const [viewMode, setViewMode] = useState<ViewMode>('active');
  const [reviewPanelOpen, setReviewPanelOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedTags, setSelectedTags] = useState<Set<string>>(new Set());
  const [priorityFilter, setPriorityFilter] = useState<Set<PriorityLevel>>(new Set());
  const [activeTimeFilter, setActiveTimeFilter] = useState<ActionTimeFilter>('all');
  const [activeSourceGroup, setActiveSourceGroup] = useState<ActionSourceGroupId | null>(null);
  const handleToggleTag = useCallback((tag: string) => {
    setSelectedTags(prev => {
      const next = new Set(prev);
      if (next.has(tag)) next.delete(tag); else next.add(tag);
      return next;
    });
  }, []);
  const handleClearTags = useCallback(() => setSelectedTags(new Set()), []);
  const handleTogglePriority = useCallback((level: PriorityLevel) => {
    setPriorityFilter(prev => {
      const next = new Set(prev);
      if (next.has(level)) next.delete(level); else next.add(level);
      return next;
    });
  }, []);

  // Selection state for batch operations (hoisted before handleViewModeChange which clears it)
  const {
    selectedIds,
    toggleSelect,
    selectAll,
    clearSelection,
    pruneStale,
    selectionCount,
  } = useInboxSelection();

  // Prune stale selection IDs when items change (handles external deletes/archives)
  const itemIdSet = useMemo(() => new Set(items.map(i => i.id)), [items]);
  useEffect(() => {
    if (selectionCount > 0) pruneStale(itemIdSet);
  }, [itemIdSet, selectionCount, pruneStale]);

  // Trigger lightweight resolution check on panel mount.
  // Server enforces a 30-minute cooldown, so repeated mounts are cheap no-ops.
  useEffect(() => {
    window.inboxApi.checkResolution?.({}).catch(() => {/* best-effort */});
  }, []);

  const handleViewModeChange = useCallback((newMode: ViewMode) => {
    tracking.inbox.viewModeSwitched(newMode, viewMode);
    setViewMode(newMode);
    setSearchQuery('');
    setSelectedTags(new Set());
    setPriorityFilter(new Set());
    clearSelection();
  }, [viewMode, clearSelection]);

  // Compute available tags from view-appropriate items
  const allTags = useMemo(() => {
    const viewItems = filterInboxViewItems(items, viewMode, '', new Set());
    const tagSet = new Set<string>();
    for (const item of viewItems) {
      if (item.tags) item.tags.forEach(t => tagSet.add(t));
    }
    return Array.from(tagSet).sort();
  }, [items, viewMode]);
  // Calendar matching: boost items to Today when related meetings are happening today
  const { meetings: todaysMeetings } = useMeetingCache(true, true);
  const calendarMatchedIds = useMemo(
    () => computeCalendarMatchedIds(
      items.map(i => ({ id: i.id, title: i.title, tags: i.tags, source: i.source ?? undefined })),
      todaysMeetings,
    ),
    [items, todaysMeetings],
  );

  const baseViewItems = useMemo(
    () => filterInboxViewItems(items, viewMode, searchQuery, selectedTags, priorityFilter),
    [items, viewMode, searchQuery, selectedTags, priorityFilter],
  );
  const effectiveSourceGroup = viewMode === 'active' ? activeSourceGroup : null;
  const effectiveTimeFilter: ActionTimeFilter = viewMode === 'active' ? activeTimeFilter : 'all';

  const baseTemporalGroups = useMemo(
    () => groupByTemporal(baseViewItems, calendarMatchedIds),
    [baseViewItems, calendarMatchedIds],
  );

  const timeFilteredBaseItems = useMemo(() => {
    if (effectiveTimeFilter === 'all') {
      return baseViewItems;
    }
    return baseTemporalGroups.get(effectiveTimeFilter) ?? [];
  }, [baseTemporalGroups, baseViewItems, effectiveTimeFilter]);

  const sourceGroups = useMemo(() => {
    const counts = new Map<ActionSourceGroupId, number>();
    for (const item of timeFilteredBaseItems) {
      const groupId = getActionSourceGroupId(item);
      counts.set(groupId, (counts.get(groupId) ?? 0) + 1);
    }

    return Array.from(counts.entries())
      .map(([id, count]) => ({ id, count, ...ACTION_SOURCE_GROUP_META[id] }))
      .sort((a, b) => a.order - b.order)
      .slice(0, MAX_SOURCE_GROUPS);
  }, [timeFilteredBaseItems]);

  useEffect(() => {
    if (activeSourceGroup && !sourceGroups.some((group) => group.id === activeSourceGroup)) {
      setActiveSourceGroup(null);
    }
  }, [activeSourceGroup, sourceGroups]);

  const sourceFilteredItems = useMemo(
    () => effectiveSourceGroup
      ? timeFilteredBaseItems.filter(item => getActionSourceGroupId(item) === effectiveSourceGroup)
      : timeFilteredBaseItems,
    [effectiveSourceGroup, timeFilteredBaseItems],
  );

  const sourceFilteredTemporalGroups = useMemo(
    () => groupByTemporal(sourceFilteredItems, calendarMatchedIds),
    [sourceFilteredItems, calendarMatchedIds],
  );

  const filteredViewItems = sourceFilteredItems;

  const temporalGroups = useMemo(
    () => groupByTemporal(filteredViewItems, calendarMatchedIds),
    [calendarMatchedIds, filteredViewItems],
  );

  useEffect(() => {
    if (selectionCount > 0) {
      pruneStale(new Set(filteredViewItems.map(item => item.id)));
    }
  }, [filteredViewItems, pruneStale, selectionCount]);

  const showDisconnectedReminder = internalConnectionStatus === 'disconnected';

  // Stable ref for items — updated synchronously during render so callbacks always see fresh data
  const itemsRef = useRef(items);
  itemsRef.current = items;

  // Collapse page header when content is scrolled for more vertical space.
  // Guard: only collapse when the list overflow is large enough that hiding
  // the header won't make everything fit (which would snap scrollTop → 0
  // and re-show the header, creating an infinite layout feedback loop).
  const scrollRef = useRef<HTMLDivElement>(null);
  const headerRef = useRef<HTMLDivElement>(null);
  const noticeRef = useRef<HTMLDivElement>(null);
  const isScrolledRef = useRef(false);
  const [isScrolled, setIsScrolled] = useState(false);
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const onScroll = () => {
      if (el.scrollTop > 0) {
        if (!isScrolledRef.current) {
          const collapsibleHeight =
            (headerRef.current?.offsetHeight ?? 0) +
            (noticeRef.current?.offsetHeight ?? 0) +
            24; // flex gap allowance
          if (el.scrollHeight - el.clientHeight > collapsibleHeight) {
            isScrolledRef.current = true;
            setIsScrolled(true);
          }
        }
      } else if (el.scrollTop === 0 && isScrolledRef.current) {
        isScrolledRef.current = false;
        setIsScrolled(false);
      }
    };
    el.addEventListener('scroll', onScroll, { passive: true });
    return () => el.removeEventListener('scroll', onScroll);
  }, []);

  // Counts for filter tabs
  const activeCount = useMemo(() => filterInboxViewItems(items, 'active', '', new Set()).length, [items]);
  const doneCount = useMemo(() =>
    filterInboxViewItems(items, 'done', '', new Set()).length + history.length,
  [items, history]);
  const dismissedCount = useMemo(() =>
    filterInboxViewItems(items, 'dismissed', '', new Set()).length,
  [items]);
  const archivedItemCount = archivedCount ?? (doneCount + dismissedCount);

  // Toast for error feedback
  const { showToast: toast } = useToast();

  // Undo stack for post-action reversal (archive, delete, dismiss)
  const undoStack = useUndoStack();

  const executeUndoWithFeedback = useCallback(async (undoId: string) => {
    const ok = await undoStack.executeUndo(undoId);
    if (!ok) {
      toast({ title: 'Undo failed', description: 'The action could not be reversed. Please try manually.', variant: 'error' });
    }
  }, [undoStack, toast]);

  // Auto-done preferences — global default + per-item overrides, local state only (not persisted).
  const [globalAutoDone, setGlobalAutoDone] = useState(false);
  const [autoDoneOverrides, setAutoDoneOverrides] = useState<Record<string, boolean>>({});

  const handleToggleGlobalAutoDone = useCallback(() => {
    setGlobalAutoDone(prev => !prev);
    setAutoDoneOverrides({});
  }, []);

  const autoDoneByItemId = useMemo(() => {
    const result: Record<string, boolean> = {};
    for (const item of items) {
      result[item.id] = autoDoneOverrides[item.id] ?? globalAutoDone;
    }
    return result;
  }, [items, autoDoneOverrides, globalAutoDone]);

  const handleAutoDoneChange = useCallback((itemId: string, value: boolean) => {
    setAutoDoneOverrides(prev => ({ ...prev, [itemId]: value }));
  }, []);

  const requestBatchDismiss = useCallback(() => {
    const selectedItems = items.filter(i => selectedIds.has(i.id));
    if (selectedItems.length === 0) return;
    setDeleteRequest({
      kind: 'batch',
      itemIds: selectedItems.map(item => item.id),
      title: `${selectedItems.length} selected action${selectedItems.length > 1 ? 's' : ''}`,
    });
  }, [items, selectedIds]);

  // Batch dismiss: snapshot → dismiss all → toast with undo → clear selection
  const handleBatchDismiss = useCallback(async (itemIds: string[], reason?: ActionDeleteReason) => {
    const selectedItemIds = new Set(itemIds);
    const selectedItems = items.filter(i => selectedItemIds.has(i.id));
    if (selectedItems.length === 0) return;

    const undoId = undoStack.pushUndo('batch-dismiss', selectedItems, async () => {
      await Promise.allSettled(
        selectedItems.map(item => window.inboxApi.setStatus({ itemId: item.id, status: 'active' }))
      );
    });

    const results = await Promise.allSettled(selectedItems.map(item => onDismiss(item.id, reason)));
    const failCount = results.filter(r => r.status === 'rejected').length;
    clearSelection();
    if (failCount > 0) {
      toast({ title: `${failCount} item${failCount > 1 ? 's' : ''} failed to dismiss`, variant: 'error' });
    }

    const toastParams = buildActionToast({
      action: 'batch-dismiss',
      items: selectedItems,
      undoCallback: () => { void executeUndoWithFeedback(undoId); },
    });
    toast(toastParams);
  }, [items, onDismiss, clearSelection, undoStack, toast, executeUndoWithFeedback]);

  // Batch done: snapshot → mark all done → toast with undo → clear selection
  const handleBatchDone = useCallback(async () => {
    const selectedItems = items.filter(i => selectedIds.has(i.id));
    if (selectedItems.length === 0) return;

    const undoId = undoStack.pushUndo('batch-done', selectedItems, async () => {
      await Promise.allSettled(
        selectedItems.map(item => window.inboxApi.setStatus({ itemId: item.id, status: 'active' }))
      );
    });

    const results = await Promise.allSettled(selectedItems.map(item => onDone(item.id)));
    const failCount = results.filter(r => r.status === 'rejected').length;
    clearSelection();
    if (failCount > 0) {
      toast({ title: `${failCount} item${failCount > 1 ? 's' : ''} failed to update`, variant: 'error' });
    }

    const toastParams = buildActionToast({
      action: 'batch-done',
      items: selectedItems,
      undoCallback: () => { void executeUndoWithFeedback(undoId); },
    });
    toast(toastParams);
  }, [items, selectedIds, onDone, clearSelection, undoStack, toast, executeUndoWithFeedback]);

  // Batch set schedule: update all selected items → toast → clear selection (no undo — matches batch-priority parity)
  const handleBatchSetSchedule = useCallback(async (group: ConcreteTemporalGroup) => {
    const allSelected = items.filter(i => selectedIds.has(i.id));
    if (allSelected.length === 0) return;

    const schedulable = allSelected.filter(i => !isPriorityPinnedToToday(i));
    const skippedCount = allSelected.length - schedulable.length;

    if (schedulable.length > 0) {
      const dueBy = getScheduleDueBy(group);
      const results = await Promise.allSettled(
        schedulable.map(item => window.inboxApi.setDueBy({ itemId: item.id, dueBy }))
      );
      const failCount = results.filter(r => r.status === 'rejected').length;
      if (failCount > 0) {
        toast({ title: `${failCount} item${failCount > 1 ? 's' : ''} failed to reschedule`, variant: 'error' });
      }
    }

    clearSelection();

    const targetLabel = TEMPORAL_GROUP_META[group].label;
    if (schedulable.length > 0) {
      const toastParams = buildActionToast({
        action: 'batch-schedule',
        items: schedulable,
        targetLabel,
      });
      toast(toastParams);
    }
    if (skippedCount > 0) {
      toast({ title: `${skippedCount} urgent item${skippedCount > 1 ? 's' : ''} skipped`, description: 'Urgent items stay in Today' });
    }
  }, [items, selectedIds, clearSelection, toast]);

  // Batch set priority: update all selected items → toast → clear selection
  const handleBatchSetPriority = useCallback((level: PriorityLevel) => {
    if (!onSetPriority) return;
    const selectedItems = items.filter(i => selectedIds.has(i.id));
    if (selectedItems.length === 0) return;

    const { urgent, important } = priorityToQuadrant(level);
    for (const item of selectedItems) {
      onSetPriority(item.id, urgent, important);
    }
    clearSelection();

    toast({
      title: `Priority updated`,
      description: `${selectedItems.length} item${selectedItems.length > 1 ? 's' : ''} set to ${level}`,
    });
  }, [items, selectedIds, onSetPriority, clearSelection, toast]);

  // Wrap done to snapshot → set status → toast with undo
  const handleDoneWithToast = useCallback((itemId: string) => {
    const item = itemsRef.current.find((i: InboxItem) => i.id === itemId);

    const undoId = item
      ? undoStack.pushUndo('done', [item], async () => {
          await window.inboxApi.setStatus({ itemId, status: 'active' });
        })
      : undefined;

    onDone(itemId);

    if (item && undoId) {
      const toastParams = buildActionToast({
        action: 'done',
        items: [item],
        undoCallback: () => { void executeUndoWithFeedback(undoId); },
      });
      toast(toastParams);
    }
  }, [onDone, toast, undoStack, executeUndoWithFeedback]);

  // Wrap dismiss to snapshot → set status → toast with undo
  const handleDismissWithToast = useCallback((itemId: string, reason?: ActionDeleteReason) => {
    const item = itemsRef.current.find((i: InboxItem) => i.id === itemId);

    const undoId = item
      ? undoStack.pushUndo('dismiss', [item], async () => {
          await window.inboxApi.setStatus({ itemId, status: 'active' });
        })
      : undefined;

    onDismiss(itemId, reason);

    if (item && undoId) {
      const toastParams = buildActionToast({
        action: 'dismiss',
        items: [item],
        undoCallback: () => { void executeUndoWithFeedback(undoId); },
      });
      toast(toastParams);
    }
  }, [onDismiss, toast, undoStack, executeUndoWithFeedback]);

  const requestDismissWithReason = useCallback((itemId: string, closeDetail = false) => {
    const item = itemsRef.current.find((candidate: InboxItem) => candidate.id === itemId);
    setDeleteRequest({ kind: 'single', itemId, title: item?.title, closeDetail });
  }, []);

  const handleRestoreDeleted = useCallback((itemId: string) => {
    void window.inboxApi.setStatus({ itemId, status: 'active' })
      .then(() => {
        toast({ title: 'Restored' });
      })
      .catch(() => {
        toast({ title: 'Unable to restore action', variant: 'error' });
      });
  }, [toast]);

  const handleScheduleWithToast = useCallback((itemId: string, targetGroup: ConcreteTemporalGroup) => {
    const item = itemsRef.current.find((i: InboxItem) => i.id === itemId);
    const previousDueBy = item?.dueBy;
    const dueBy = getScheduleDueBy(targetGroup);
    const targetLabel = TEMPORAL_GROUP_META[targetGroup].label;

    const undoId = item
      ? undoStack.pushUndo('schedule', [item], async () => {
          await window.inboxApi.setDueBy({ itemId, dueBy: previousDueBy ?? null });
        })
      : undefined;

    void (async () => {
      try {
        if (onSetSchedule) {
          const ok = await onSetSchedule(itemId, targetGroup);
          if (ok === false) return;
        } else {
          await window.inboxApi.setDueBy({ itemId, dueBy });
        }

        if (item && undoId) {
          const toastParams = buildActionToast({
            action: 'schedule',
            items: [item],
            undoCallback: () => { void executeUndoWithFeedback(undoId); },
            targetLabel,
          });
          toast(toastParams);
        }
      } catch {
        toast({ title: 'Unable to update schedule', variant: 'error' });
      }
    })();
  }, [onSetSchedule, toast, undoStack, executeUndoWithFeedback]);

  // Load staged files for the strip
  const {
    files: stagedFiles,
    publish: publishStagedFile,
    discard: discardStagedFile,
    keepPrivate: keepStagedFilePrivate,
    publishAll: publishAllStagedFiles,
    discardAll: discardAllStagedFiles,
  } = useStagedFiles();

  const totalReviewCount = stagedFiles.length;

  // Auto-close when nothing left to review
  useEffect(() => {
    if (totalReviewCount === 0) {
      setReviewPanelOpen(false);
    }
  }, [totalReviewCount]);

  // Handle navigating to staged file session
  const handleNavigateToStagedSession = useCallback(
    (sessionId: string) => {
      if (onNavigateToSession) {
        onNavigateToSession(sessionId);
      }
    },
    [onNavigateToSession]
  );

  const handleOpenStagedFilePath = useCallback(
    (filePath: string) => {
      if (onOpenFile) {
        onOpenFile(filePath);
        return;
      }

      toast({
        title: 'Could not open file',
        description: 'File navigation is unavailable right now.',
        variant: 'error',
      });
    },
    [onOpenFile, toast]
  );

  // Handle approving a staged file (async for dialog feedback)
  const handlePublishStagedFile = useCallback(
    (id: string) => publishStagedFile(id),
    [publishStagedFile]
  );

  // Handle discarding a staged file (async for dialog feedback)
  const handleDiscardStagedFile = useCallback(
    (id: string) => discardStagedFile(id),
    [discardStagedFile]
  );

  // Handle approving all staged files
  const handlePublishAllStagedFiles = useCallback(async () => {
    const result = await publishAllStagedFiles();
    const toastParams = buildPublishAllToast(result);
    if (toastParams) toast(toastParams);
  }, [publishAllStagedFiles, toast]);

  // Handle discarding all staged files
  const handleDiscardAllStagedFiles = useCallback(() => {
    void discardAllStagedFiles();
  }, [discardAllStagedFiles]);

  // Detail modal handlers
  const handleOpenDetail = useCallback((itemId: string, context?: string) => {
    setDetailItemId(itemId);
    setDetailInitialContext(context?.trim() || undefined);
  }, []);

  const handleCloseDetail = useCallback(() => {
    setDetailItemId(null);
    setDetailInitialContext(undefined);
  }, []);

  const handleConfirmDelete = useCallback((reason?: ActionDeleteReason) => {
    const request = deleteRequest;
    setDeleteRequest(null);
    if (!request) return;
    if (request.kind === 'batch') {
      void handleBatchDismiss(request.itemIds, reason);
      return;
    }
    handleDismissWithToast(request.itemId, reason);
    if (request.closeDetail) handleCloseDetail();
  }, [deleteRequest, handleBatchDismiss, handleDismissWithToast, handleCloseDetail]);

  const handleDetailExecute = useCallback((itemId: string, pinAfter: boolean, context?: string, attachments?: FileAttachment[]) => {
    const item = itemsRef.current.find((i: InboxItem) => i.id === itemId);
    if (!item) return;
    onExecute(item, context, pinAfter, attachments);
    handleCloseDetail();
  }, [onExecute, handleCloseDetail]);

  const handleDetailDone = useCallback((itemId: string) => {
    handleDoneWithToast(itemId);
    handleCloseDetail();
  }, [handleDoneWithToast, handleCloseDetail]);

  const handleDetailDismiss = useCallback((itemId: string) => {
    requestDismissWithReason(itemId, true);
  }, [requestDismissWithReason]);

  const detailExecutionStatus: ExecutionStatus = useMemo(() => {
    if (!detailItemId) return 'idle';
    const item = items.find(i => i.id === detailItemId);
    if (!item?.executingSessionId) return 'idle';
    return busySessionIds?.has(item.executingSessionId) ? 'running' : 'queued';
  }, [detailItemId, items, busySessionIds]);

  const connectDisabled = !canAutoConnectInternal || internalConnectionPending;
  const showAddButton = showDisconnectedReminder && canAutoConnectInternal;

  const hasEverHadItems = doneCount > 0 || (archivedCount ?? 0) > 0 || activeCount > 0 || dismissedCount > 0;
  const hasConnectedTools = connectedConnectorCount > 0;
  const isFirstTimeEmpty = viewMode === 'active' && !hasEverHadItems;
  const showActionRail = !isFirstTimeEmpty && viewMode === 'active';
  const timeFilterCounts = useMemo(() => ({
    'due-today': sourceFilteredTemporalGroups.get('due-today')?.length ?? 0,
    'due-this-week': sourceFilteredTemporalGroups.get('due-this-week')?.length ?? 0,
    all: sourceFilteredItems.length,
  }), [sourceFilteredItems, sourceFilteredTemporalGroups]);
  const activeTemporalTabForView: TemporalGroup = effectiveTimeFilter;

  return (
    <div className={styles.panel} data-testid="inbox-panel">
      {showDisconnectedReminder && !isScrolled && (
        <div ref={noticeRef} className={styles.setupNotice} role="status">
          <Plug size={14} className={styles.setupNoticeIcon} aria-hidden="true" />
          <span className={styles.setupNoticeText}>Rebel can&apos;t add items yet</span>
          <Tooltip
            content={
              <span>
                Your Actions tab still works fine for viewing and managing items.
                <br /><br />
                Enable this to let Rebel save items for you during conversations
                (e.g., &quot;Add this to my actions&quot;).
              </span>
            }
            placement="bottom"
            delayShow={200}
          >
            <button
              type="button"
              className={styles.setupNoticeInfoButton}
              aria-label="Learn more about actions setup"
            >
              <Info size={12} />
            </button>
          </Tooltip>
          {showAddButton ? (
            <button
              type="button"
              className={styles.setupNoticeButton}
              onClick={onConnectInternal}
              disabled={connectDisabled}
            >
              {internalConnectionPending ? 'Enabling…' : 'Enable'}
            </button>
          ) : (
            <button
              type="button"
              className={styles.setupNoticeButton}
              onClick={onOpenInboxSettings}
            >
              Settings
            </button>
          )}
        </div>
      )}
      <div className={`${styles.actionBoard} ${!showActionRail ? styles.actionBoardSingle : ''}`}>
        {showActionRail && (
          <aside className={styles.actionSidebar} aria-label="Action filters">
            <div className={styles.sidebarSummary}>
              <div className={styles.sidebarCountRow}>
                <span className={styles.sidebarCount}>{activeCount}</span>
                <span className={styles.sidebarCountLabel}>open actions</span>
              </div>
              <p className={styles.sidebarSummaryText}>
                Rebel turns transcripts, connected apps, and automations into actions.
              </p>
            </div>

            <div className={styles.sidebarSection}>
              <span className={styles.sidebarSectionTitle}>Due</span>
              <div className={styles.sidebarFilterList} role="group" aria-label="Due filter">
                {ACTION_TIME_FILTERS.map((filter) => (
                  <button
                    key={filter.id}
                    type="button"
                    className={`${styles.sidebarFilterButton} ${activeTimeFilter === filter.id ? styles.sidebarFilterButtonActive : ''}`}
                    aria-pressed={activeTimeFilter === filter.id}
                    onClick={() => setActiveTimeFilter(filter.id)}
                  >
                    <span className={styles.sidebarFilterLabel}>
                      {filter.label}
                    </span>
                    <span className={styles.sidebarFilterCount}>{timeFilterCounts[filter.id]}</span>
                  </button>
                ))}
              </div>
            </div>

            {sourceGroups.length > 0 && (
              <div className={styles.sidebarSection}>
                <span className={styles.sidebarSectionTitle}>From</span>
                <div className={styles.sidebarFilterList} role="group" aria-label="Source filter">
                  <button
                    type="button"
                    className={`${styles.sidebarFilterButton} ${activeSourceGroup === null ? styles.sidebarFilterButtonActive : ''}`}
                    aria-pressed={activeSourceGroup === null}
                    onClick={() => setActiveSourceGroup(null)}
                  >
                    <span className={styles.sidebarFilterLabel}>
                      All sources
                    </span>
                    <span className={styles.sidebarFilterCount}>{timeFilteredBaseItems.length}</span>
                  </button>
                  {sourceGroups.map((group) => (
                    <button
                      key={group.id}
                      type="button"
                      className={`${styles.sidebarFilterButton} ${activeSourceGroup === group.id ? styles.sidebarFilterButtonActive : ''}`}
                      aria-pressed={activeSourceGroup === group.id}
                      onClick={() => setActiveSourceGroup(group.id)}
                    >
                      <span className={styles.sidebarFilterLabel}>
                        {group.label}
                      </span>
                      <span className={styles.sidebarFilterCount}>{group.count}</span>
                    </button>
                  ))}
                </div>
              </div>
            )}

            <div className={styles.sidebarSection}>
              <span className={styles.sidebarSectionTitle}>Priority</span>
              <div className={styles.sidebarFilterList} role="group" aria-label="Priority filter">
                {ACTION_PRIORITY_FILTERS.map((level) => {
                  const active = priorityFilter.has(level);
                  return (
                    <button
                      key={level}
                      type="button"
                      className={`${styles.sidebarFilterButton} ${active ? styles.sidebarFilterButtonActive : ''}`}
                      aria-pressed={active}
                      onClick={() => handleTogglePriority(level)}
                    >
                      <span className={styles.sidebarFilterLabel}>{getPriorityLabel(level)}</span>
                    </button>
                  );
                })}
              </div>
            </div>
          </aside>
        )}

        <div className={styles.actionMain}>
      <div className={`${styles.toolbar} ${isFirstTimeEmpty ? styles.toolbarHidden : ''}`}>
        {/* Row 1: Search — full width (matches Library pattern) */}
        <div className={styles.searchRow}>
          <InboxSearchCombobox
            searchQuery={searchQuery}
            onSearchQueryChange={setSearchQuery}
            selectedTags={selectedTags}
            onToggleTag={handleToggleTag}
            onClearTags={handleClearTags}
            allTags={allTags}
          />
        </div>

        {/* Row 2: Review pill + Temporal tabs + view filter + actions */}
        <div className={styles.controlsRow}>
          {totalReviewCount > 0 && (
            <button
              type="button"
              className={`${styles.reviewPill} ${reviewPanelOpen ? styles.reviewPillActive : ''}`}
              onClick={() => setReviewPanelOpen(prev => !prev)}
              aria-expanded={reviewPanelOpen}
              aria-label={`${totalReviewCount} items need review`}
            >
              <FileStack size={13} aria-hidden="true" />
              <span>{totalReviewCount} to review</span>
            </button>
          )}
          <InboxFilterDropdown
            viewMode={viewMode}
            onViewModeChange={handleViewModeChange}
            activeCount={activeCount}
            doneCount={doneCount}
            dismissedCount={dismissedCount}
            archivedCount={archivedItemCount}
            priorityFilter={priorityFilter}
            onTogglePriority={handleTogglePriority}
            globalAutoDone={globalAutoDone}
            onToggleGlobalAutoDone={handleToggleGlobalAutoDone}
          />

          {onOpenScratchpad && (
            <Tooltip
              content={`Scratchpad (${formatAcceleratorDisplay('CommandOrControl+Shift+N')})`}
              delayShow={300}
            >
              <IconButton
                size="xs"
                className={styles.scratchpadButton}
                onClick={onOpenScratchpad}
                aria-label="Open scratchpad"
              >
                <StickyNote size={16} aria-hidden="true" />
              </IconButton>
            </Tooltip>
          )}
        </div>
      </div>
      {selectionCount > 0 && (
        <InboxSelectionBar
          count={selectionCount}
          totalCount={filteredViewItems.length}
          onBatchDone={handleBatchDone}
          onBatchDismiss={requestBatchDismiss}
          onBatchSetPriority={onSetPriority ? handleBatchSetPriority : undefined}
          onBatchSetSchedule={handleBatchSetSchedule}
          onSelectAll={() => selectAll(filteredViewItems.map(i => i.id))}
          onClearSelection={clearSelection}
        />
      )}
      {reviewPanelOpen && totalReviewCount > 0 && (
        <div className={styles.reviewPanel}>
          {stagedFiles.length > 0 && (
            <StagedFilesStrip
              files={stagedFiles}
              onNavigateToSession={handleNavigateToStagedSession}
              onOpenFilePath={handleOpenStagedFilePath}
              onPublish={handlePublishStagedFile}
              onDiscard={handleDiscardStagedFile}
              onKeepPrivate={keepStagedFilePrivate}
              onPublishAll={handlePublishAllStagedFiles}
              onDiscardAll={handleDiscardAllStagedFiles}
              onSendMessageToSession={onSendMessageToSession}
            />
          )}
        </div>
      )}
      <div className={styles.scrollArea} ref={scrollRef} data-testid="inbox-item-list">
        {mcpNotifications.length > 0 && (
          <div data-testid="inbox-mcp-notifications">
            {mcpNotifications.map((item) => (
              <MCPNotificationCard
                key={item.key}
                state={item.state}
                connectorName={item.connectorName}
                reviewNotes={item.reviewNotes}
                prUrl={item.prUrl}
                onAcknowledge={onDismissMcpNotification
                  ? () => onDismissMcpNotification(item.contributionId, item.contributionStatus)
                  : undefined}
                onViewConnector={onViewMcpConnector
                  ? () => {
                      onViewMcpConnector();
                      onDismissMcpNotification?.(item.contributionId, item.contributionStatus);
                    }
                  : undefined}
                onMakeChanges={onMakeMcpChanges
                  ? () => {
                      onMakeMcpChanges(item);
                      onDismissMcpNotification?.(item.contributionId, item.contributionStatus);
                    }
                  : undefined}
                onOpenInGitHub={item.prUrl
                  ? () => { const prUrl = item.prUrl; if (prUrl) void window.appApi.openUrl(prUrl); }
                  : undefined}
              />
            ))}
          </div>
        )}
        <TemporalGroupView
          items={items}
          history={history}
          loading={showActiveLoading}
          busySessionIds={busySessionIds}
          viewMode={viewMode}
          activeTemporalTab={activeTemporalTabForView}
          searchQuery={searchQuery}
          selectedTags={selectedTags}
          preFilteredViewItems={filteredViewItems}
          preTemporalGroups={temporalGroups}
          onExecute={onExecute}
          onDone={handleDoneWithToast}
          onDismiss={requestDismissWithReason}
          onRestore={handleRestoreDeleted}
          onOpenFile={onOpenFile}
          onOpenSession={onOpenSession}
          onOpenDetail={handleOpenDetail}
          onSetPriority={onSetPriority}
          onSetSchedule={handleScheduleWithToast}
          calendarMatchedIds={calendarMatchedIds}
          archivedCount={archivedCount}
          selectedIds={selectedIds}
          onToggleSelect={toggleSelect}
          onSelectAll={selectAll}
          onClearSelection={clearSelection}
          autoDoneByItemId={autoDoneByItemId}
          onAutoDoneChange={handleAutoDoneChange}
          hasConnectedTools={hasConnectedTools}
          hasEverHadItems={hasEverHadItems}
          onNavigateToConnectors={onNavigateToConnectors}
        />
      </div>
      </div>
      </div>
      {detailItemId ? (
        <InboxItemDetailModal
          itemId={detailItemId}
          items={items}
          executionStatus={detailExecutionStatus}
          onExecute={handleDetailExecute}
          onDone={handleDetailDone}
          onDismiss={handleDetailDismiss}
          onClose={handleCloseDetail}
          onOpenFile={onOpenFile}
          onSetTags={onSetTags}
          initialContext={detailInitialContext}
          mentionResultsForQuery={mentionResultsForQuery}
          ensureLibraryIndex={ensureLibraryIndex}
          getRelativeLibraryPath={getRelativeLibraryPath}
          hasWorkspace={hasWorkspace}
          hasConversations={hasConversations}
          coreDirectory={coreDirectory}
          libraryIndex={libraryIndex}
          libraryIndexLoading={libraryIndexLoading}
          libraryIndexError={libraryIndexError}
          refreshLibraryIndex={refreshLibraryIndex}
        />
      ) : null}
      <ActionDeleteReasonDialog
        open={deleteRequest !== null}
        itemTitle={deleteRequest?.title}
        onOpenChange={(open) => {
          if (!open) setDeleteRequest(null);
        }}
        onConfirm={handleConfirmDelete}
      />
    </div>
  );
};

export const InboxPanel = memo(InboxPanelComponent);
InboxPanel.displayName = 'InboxPanel';
