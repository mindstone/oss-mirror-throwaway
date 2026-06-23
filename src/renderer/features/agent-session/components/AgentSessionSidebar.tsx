import type { RefObject, MouseEvent as ReactMouseEvent, ReactNode } from "react";
import { memo, useState, useCallback, useRef, useLayoutEffect, useMemo, useEffect } from "react";
import type { AgentSessionSidebarEntry } from "../types";
import type { ConversationSearchResult, RecencyFilter, ConversationSearchAvailability } from "@renderer/utils/conversationSearch";
import { RECENCY_FILTER_LABELS } from "@renderer/utils/conversationSearch";
import type { DeepSearchResult } from "../hooks/useSessionSearch";
import { Tooltip } from "@renderer/components/ui/Tooltip";
import { Input } from "@renderer/components/ui/Input";
import { useToast } from "@renderer/components/ui";
import { Tabs, TabsList, TabsTrigger } from "@renderer/components/ui/Tabs";
import { SessionTooltipContent } from "./SessionTooltipContent";
import { formatHistoryTimestamp, stripMarkdown } from "@renderer/utils/formatters";
import { sessionKindBadgeLabel } from "@renderer/features/inbox/utils/backgroundTaskLabels";
import { isAutomationSession } from "@shared/sessionKind";
import {
  AGENT_SESSION_STATUS_LABEL,
  type AgentSessionSidebarStatus,
} from "@renderer/constants";
import { RECENCY_FILTER_MS } from "@renderer/utils/conversationSearch";
import { filterSessionList, resolveSidebarFilter, type SidebarFilter } from "../utils/filterSessionList";
import { buildFolderAwareList, type SidebarListEntry } from "../utils/buildFolderAwareList";
import { buildSessionRowActionsProps } from "../utils/sessionRowActions";
import { getFolderPinnedState, getFolderSessionIdsToSetActiveState } from "../utils/folderSessionState";
import {
  isDuplicateFolderName,
  MAX_FOLDER_NAME_LENGTH,
  SOFT_FOLDER_COUNT_WARNING_THRESHOLD,
} from "../utils/folderNameValidation";
import {
  useFolders,
  useFolderMembership,
  useFolderCollapseState,
  useFolderDoneCollapseState,
  useFolderActions,
} from "../store/folderStore";
import { tracking } from "@renderer/src/tracking";
import styles from "./AgentSessionSidebar.module.css";
import { Search, Star, Clock, Trash2, RotateCcw, Loader2, Sparkles, ArrowLeft, X, Video, MessagesSquare, FolderPlus, CloudOff } from "lucide-react";
import { SessionListItemActions } from "./SessionListItemActions";
import { FolderHeaderRow } from "./FolderHeaderRow";
import { DoneSubsectionRow } from "./DoneSubsectionRow";
import { MoveToFolderPopover } from "./MoveToFolderPopover";
import type { VirtualizedSessionListHandle } from "./VirtualizedSessionList";
import { VirtualizedSessionList } from "./VirtualizedSessionList";
import type { ContextMenuAnchor } from "./SessionActionsMenu";

/**
 * Isolated rename input — manages its own local state so parent re-renders
 * don't invalidate the session list's `renderEntry` callback.
 * Syncs edits upward on every keystroke via `onChange`.
 */
const SessionRenameInput = memo(({
  inputRef,
  initialValue,
  onChange,
  onKeyDown,
  onBlur,
  sessionId,
  originalTitle,
}: {
  inputRef: RefObject<HTMLInputElement | null>;
  initialValue: string;
  onChange: (value: string) => void;
  onKeyDown: (event: React.KeyboardEvent<HTMLInputElement>, originalTitle: string) => void;
  onBlur: (sessionId: string, originalTitle: string) => void;
  sessionId: string;
  originalTitle: string;
}) => {
  const [localValue, setLocalValue] = useState(initialValue);
  const handleChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    setLocalValue(e.target.value);
    onChange(e.target.value);
  }, [onChange]);
  return (
    <input
      ref={inputRef}
      type="text"
      className={styles.titleEditInput}
      value={localValue}
      onChange={handleChange}
      onKeyDown={(e) => onKeyDown(e, originalTitle)}
      onBlur={() => onBlur(sessionId, originalTitle)}
      onClick={(e) => e.stopPropagation()}
      aria-label="Edit conversation title"
    />
  );
});
SessionRenameInput.displayName = 'SessionRenameInput';

/** State for tracking which session has the context menu open */
interface ContextMenuState {
  sessionId: string;
  anchor: ContextMenuAnchor;
  /** Reference element for scroll ancestor detection */
  contextElement?: HTMLElement | null;
}

const STORAGE_KEY_SESSION_FILTER = "sidebar-session-filter";

type AgentSessionSidebarProps = {
  currentSessionId: string;
  sessions: AgentSessionSidebarEntry[];
  sessionSearchQuery: string;
  sessionSearchResults: ConversationSearchResult[];
  findSimilarSource?: { sessionId: string; title: string } | null;
  /** Whether search (IPC hybrid) is currently running */
  isSearching: boolean;
  /** Search backend availability (F4): 'ok' (incl. genuine no-match) vs warming-up / unavailable / error */
  searchStatus?: ConversationSearchAvailability;
  /** Re-run the current query after a transient backend failure (F4 "Try again") */
  onRetrySearch?: () => void;
  /** Deep search results from full-text search across all messages */
  sessionDeepSearchResults?: DeepSearchResult[];
  /** Whether deep search is currently running */
  isDeepSearching?: boolean;
  /** Trigger deep search (explicit opt-in via button) */
  onTriggerDeepSearch?: () => void;
  sessionSearchSelectedIndex: number;
  sessionSearchInputRef: RefObject<HTMLInputElement | null>;
  onSearchChange: (value: string) => void;
  onSearchKeyDown: (event: React.KeyboardEvent<HTMLInputElement>) => void;
  onSearchHover: (index: number) => void;
  onClearSearch: (options?: { rememberForBack?: boolean }) => void;
  onSelectSession: (sessionId: string, isHistory: boolean) => void;
  /** Soft delete - moves session to trash (used for non-trash sections) */
  onSoftDeleteSession: (
    sessionId: string,
    event: React.MouseEvent<HTMLButtonElement>,
  ) => void;
  /** Hard delete - permanently removes session (used only for Trash section) */
  onDeleteSession: (
    sessionId: string,
    event: React.MouseEvent<HTMLButtonElement>,
  ) => void;
  onTogglePin: (
    sessionId: string,
    event?: React.MouseEvent<HTMLButtonElement>,
    options?: { skipAutoSwitch?: boolean },
  ) => void;
  onToggleStar: (
    sessionId: string,
    event?: React.MouseEvent<HTMLButtonElement>,
  ) => void;
  onRestoreSession: (
    sessionId: string,
    event: React.MouseEvent<HTMLButtonElement>,
  ) => void;
  onEmptyTrash: () => void;
  /** Current session type filter: 'all', 'conversations', or 'automations' */
  sessionTypeFilter: 'all' | 'conversations' | 'automations';
  /** Callback when session type filter changes */
  onSessionTypeFilterChange: (filter: 'all' | 'conversations' | 'automations') => void;
  /** Current recency filter selection */
  recencyFilter: RecencyFilter;
  /** Callback to change recency filter */
  onRecencyFilterChange: (filter: RecencyFilter) => void;
  editingSessionId: string | null;
  editValue: string;
  editInputRef: RefObject<HTMLInputElement | null>;
  onStartRename: (sessionId: string, currentTitle: string) => void;
  onEditChange: (value: string) => void;
  onEditKeyDown: (
    event: React.KeyboardEvent<HTMLInputElement>,
    originalTitle: string,
  ) => void;
  onEditBlur: (sessionId: string, originalTitle: string) => void;
  /**
   * Optional widget slot rendered below search. Historically the tutorial
   * checklist ("Getting Started") widget — removed Feb 2026; App.tsx now
   * passes WhatsNewWidget here.
   */
  checklistWidget?: ReactNode;
  /** Session ID currently being animated out for deletion */
  deletingSessionId?: string | null;
  /** Find similar conversations callback */
  onFindSimilar?: (sessionId: string) => void;
  /** Copy conversation as markdown to clipboard */
  onCopyMarkdown?: (sessionId: string) => void;
  /** Export conversation to markdown callback */
  onExportMarkdown?: (sessionId: string) => void;
  /** Copy conversation link callback */
  onCopyLink?: (sessionId: string) => void;
  /** Share conversation via cloud share link callback */
  onShareConversation?: (sessionId: string) => void;
  /** Diagnose conversation callback */
  onDiagnose?: (sessionId: string) => void;
  /** Export conversation logs callback */
  onExportLogs?: (sessionId: string) => void;
  /** Last search query (for "Back to search" feature) */
  lastSearchQuery?: string;
  /** Restore search from last query */
  onRestoreSearch?: () => void;
  /** Set of session IDs that are indexed for semantic search */
  indexedSessionIds?: Set<string>;
  /** Session ID to reveal (scroll to) when sidebar opens */
  revealSessionId?: string | null;
  /** Callback when reveal is complete */
  onRevealComplete?: () => void;
  /** Optional slot for action buttons (filter, new chat) rendered in search header row */
  headerActions?: ReactNode;
};

const renderStatusLabel = (status: AgentSessionSidebarStatus) =>
  AGENT_SESSION_STATUS_LABEL[status];

const renderInlineStatusIcon = (status: AgentSessionSidebarStatus) => {
  if (status === "thinking") {
    return (
      <span
        className={styles.inlineSpinner}
        title={renderStatusLabel(status)}
        aria-hidden
      />
    );
  }
  // ready or idle: no icon
  return null;
};

const buildEntryClassName = (
  params: Partial<{
    isActive: boolean;
    isSelected: boolean;
    isCorrupted: boolean;
    isResolved: boolean;
  }>,
) =>
  [
    styles.sidebarEntry,
    params.isActive ? styles.entryActive : "",
    params.isSelected ? styles.entrySelected : "",
    params.isCorrupted ? styles.entryCorrupted : "",
    params.isResolved ? styles.entryResolved : "",
  ]
    .filter(Boolean)
    .join(" ");

export const AgentSessionSidebar = memo(
  ({
    currentSessionId,
    sessions,
    sessionSearchQuery,
    sessionSearchResults,
    findSimilarSource,
    isSearching,
    searchStatus = 'ok',
    onRetrySearch,
    sessionDeepSearchResults,
    isDeepSearching,
    onTriggerDeepSearch,
    sessionSearchSelectedIndex,
    sessionSearchInputRef,
    onSearchChange,
    onSearchKeyDown,
    onSearchHover,
    onClearSearch,
    onSelectSession,
    onSoftDeleteSession,
    onDeleteSession,
    onTogglePin,
    onToggleStar,
    onRestoreSession,
    onEmptyTrash,
    sessionTypeFilter: _sessionTypeFilter,
    onSessionTypeFilterChange: _onSessionTypeFilterChange,
    recencyFilter,
    onRecencyFilterChange,
    editingSessionId,
    editValue,
    editInputRef,
    onStartRename,
    onEditChange,
    onEditKeyDown,
    onEditBlur,
    checklistWidget,
    deletingSessionId,
    onFindSimilar,
    onCopyMarkdown,
    onExportMarkdown,
    onCopyLink,
    onShareConversation,
    onDiagnose,
    onExportLogs,
    lastSearchQuery,
    onRestoreSearch,
    indexedSessionIds,
    revealSessionId,
    onRevealComplete,
    headerActions,
  }: AgentSessionSidebarProps) => {
    const [activeFilter, setActiveFilter] = useState<SidebarFilter>(() => {
      try {
        // resolveSidebarFilter applies the read-time 'archived' → 'done'
        // migration (260614 done-state rename) and falls back to the default
        // tab for missing/invalid values.
        return resolveSidebarFilter(localStorage.getItem(STORAGE_KEY_SESSION_FILTER));
      } catch {
        return resolveSidebarFilter(null);
      }
    });

    const handleFilterChange = useCallback((value: string) => {
      const filter = value as SidebarFilter;
      setActiveFilter((prev) => {
        tracking.navigation.sidebarFilterChanged(filter, prev);
        return filter;
      });
      try { localStorage.setItem(STORAGE_KEY_SESSION_FILTER, filter); } catch { /* ignore */ }
    }, []);

    const { showToast } = useToast();

    // ── Folder state ──────────────────────────────────────────────────────────
    const folders = useFolders();
    const folderMembership = useFolderMembership();
    const folderCollapseState = useFolderCollapseState();
    const folderDoneCollapseState = useFolderDoneCollapseState();
    const {
      createFolder,
      renameFolder,
      deleteFolderWithUndo,
      moveSessionToFolder,
      removeSessionFromFolder,
      toggleFolderCollapse,
      toggleFolderDoneCollapse,
    } = useFolderActions();

    const [editingFolderId, setEditingFolderId] = useState<string | null>(null);
    const [isCreatingFolder, setIsCreatingFolder] = useState(false);
    const [draggingSessionId, setDraggingSessionId] = useState<string | null>(null);
    const [activeFolderDropTargetSessionId, setActiveFolderDropTargetSessionId] = useState<string | null>(null);
    const [newFolderName, setNewFolderName] = useState('');
    const newFolderInputRef = useRef<HTMLInputElement>(null);

    // "Move to folder" popover state
    const [moveToFolderState, setMoveToFolderState] = useState<{
      sessionId: string;
      anchor: { x: number; y: number };
    } | null>(null);

    useEffect(() => {
      if (isCreatingFolder) {
        requestAnimationFrame(() => newFolderInputRef.current?.focus());
      }
    }, [isCreatingFolder]);

    // Auto-expand folder when navigating to a session inside a collapsed folder.
    // One-time effect per navigation — does NOT prevent manual collapse.
    useEffect(() => {
      if (!currentSessionId) return;
      const folderId = folderMembership[currentSessionId];
      if (folderId && folderCollapseState[folderId]) {
        toggleFolderCollapse(folderId);
      }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- intentional: omitting folderMembership/folderCollapseState/toggleFolderCollapse; auto-expand fires once per navigation transition (currentSessionId change) so that subsequent manual collapse by the user isn't undone by collapse-state object identity churn
    }, [currentSessionId]);

    const newFolderNameDuplicate = useMemo(
      () => isDuplicateFolderName(newFolderName, folders),
      [newFolderName, folders],
    );

    const handleCreateFolderCommit = useCallback(() => {
      const trimmed = newFolderName.trim().slice(0, MAX_FOLDER_NAME_LENGTH);
      if (!trimmed) {
        setIsCreatingFolder(false);
        setNewFolderName('');
        return;
      }
      if (folders.length >= SOFT_FOLDER_COUNT_WARNING_THRESHOLD) {
        showToast({
          title:
            'You have a lot of folders. Consider organizing conversations into broader categories.',
          variant: 'warning',
        });
      }
      createFolder(trimmed);
      setIsCreatingFolder(false);
      setNewFolderName('');
    }, [newFolderName, createFolder, folders.length, showToast]);

    const handleCreateFolderKeyDown = useCallback((e: React.KeyboardEvent<HTMLInputElement>) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        handleCreateFolderCommit();
      } else if (e.key === 'Escape') {
        e.preventDefault();
        setIsCreatingFolder(false);
        setNewFolderName('');
      }
    }, [handleCreateFolderCommit]);

    const handleFolderRename = useCallback((folderId: string, newName: string) => {
      renameFolder(folderId, newName);
    }, [renameFolder]);

    const handleFolderDeleteRequest = useCallback((folderId: string) => {
      const result = deleteFolderWithUndo(folderId);
      if (!result) return;

      const { folderName, childCount, undo, commitDelete } = result;
      let undone = false;

      const description = childCount > 0
        ? `${childCount} conversation${childCount !== 1 ? 's' : ''} moved to the main list.`
        : undefined;

      showToast({
        title: `Folder "${folderName}" deleted`,
        description,
        duration: 8000,
        action: {
          label: 'Undo',
          onClick: () => { undone = true; undo(); },
        },
        onClose: () => { if (!undone) commitDelete(); },
      });
    }, [deleteFolderWithUndo, showToast]);

    const handleMoveToFolder = useCallback((sessionId: string, event: ReactMouseEvent<HTMLButtonElement>) => {
      setMoveToFolderState({
        sessionId,
        anchor: { x: event.clientX, y: event.clientY },
      });
    }, []);

    // ── Drag-and-drop ─────────────────────────────────────────────────────────
    const DRAG_DATA_FORMAT = 'text/x-rebel-session-id';

    const handleDragStart = useCallback((e: React.DragEvent, sessionId: string) => {
      e.dataTransfer.setData(DRAG_DATA_FORMAT, sessionId);
      e.dataTransfer.effectAllowed = 'move';
      setDraggingSessionId(sessionId);
    }, []);

    const handleDragEnd = useCallback(() => {
      setDraggingSessionId(null);
      setActiveFolderDropTargetSessionId(null);
    }, []);

    const handleFolderSessionDrop = useCallback((folderId: string, sessionId: string) => {
      setDraggingSessionId(null);
      setActiveFolderDropTargetSessionId(null);
      if (folderMembership[sessionId] === folderId) return;
      moveSessionToFolder(sessionId, folderId);
    }, [folderMembership, moveSessionToFolder]);

    const handleSidebarDragOver = useCallback((e: React.DragEvent) => {
      if (!e.dataTransfer.types.includes(DRAG_DATA_FORMAT)) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
    }, []);

    const handleSidebarDrop = useCallback((e: React.DragEvent) => {
      setDraggingSessionId(null);
      setActiveFolderDropTargetSessionId(null);
      const sessionId = e.dataTransfer.getData(DRAG_DATA_FORMAT);
      if (!sessionId) return;
      if (folderMembership[sessionId]) {
        removeSessionFromFolder(sessionId);
      }
    }, [folderMembership, removeSessionFromFolder]);

    const handleFolderChildDragOver = useCallback((e: React.DragEvent, folderId: string, childSessionId: string) => {
      if (!e.dataTransfer.types.includes(DRAG_DATA_FORMAT)) return;
      e.preventDefault();
      e.stopPropagation();
      const isAlreadyInFolder = draggingSessionId ? folderMembership[draggingSessionId] === folderId : false;
      e.dataTransfer.dropEffect = isAlreadyInFolder ? 'none' : 'move';
      setActiveFolderDropTargetSessionId(isAlreadyInFolder ? null : childSessionId);
    }, [draggingSessionId, folderMembership]);

    const handleFolderChildDragLeave = useCallback((e: React.DragEvent, childSessionId: string) => {
      if (!e.dataTransfer.types.includes(DRAG_DATA_FORMAT)) return;
      const nextTarget = e.relatedTarget as Node | null;
      if (nextTarget && e.currentTarget.contains(nextTarget)) return;
      setActiveFolderDropTargetSessionId((current) => current === childSessionId ? null : current);
    }, []);

    const handleFolderChildDrop = useCallback((e: React.DragEvent, folderId: string) => {
      if (!e.dataTransfer.types.includes(DRAG_DATA_FORMAT)) return;
      e.preventDefault();
      e.stopPropagation();
      const sessionId = e.dataTransfer.getData(DRAG_DATA_FORMAT);
      if (!sessionId) {
        setDraggingSessionId(null);
        return;
      }
      handleFolderSessionDrop(folderId, sessionId);
    }, [handleFolderSessionDrop]);

    // Context menu state for right-click on session entries
    const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);

    // Handler for right-click context menu on session entries
    const handleSessionContextMenu = useCallback((
      sessionId: string,
      event: React.MouseEvent<HTMLElement>
    ) => {
      // Don't show context menu if clicking on an input (e.g., rename field)
      const target = event.target as HTMLElement;
      if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable) {
        return;
      }
      event.preventDefault();
      setContextMenu({
        sessionId,
        anchor: { x: event.clientX, y: event.clientY },
        contextElement: event.currentTarget,
      });
    }, []);

    const handleContextMenuClose = useCallback(() => {
      setContextMenu(null);
    }, []);

    // Cloud continuity state per session (for "Keep in cloud" hover icon + menu action)
    const hasContinuityApi = !!window.cloudContinuityApi;
    const [continuityStates, setContinuityStates] = useState<Record<string, { state: string }>>({});

    useEffect(() => {
      if (!window.cloudContinuityApi) return;
      const fetchAll = () => {
        window.cloudContinuityApi.getAll().then(setContinuityStates).catch(() => {/* ignore */});
      };
      fetchAll();
      const unsubscribe = window.cloudApi?.onContinuityChanged?.(fetchAll);
      return () => { unsubscribe?.(); };
    }, []);

    const handleToggleCloudContinuity = useCallback((sessionId: string, _event: React.MouseEvent<HTMLButtonElement>) => {
      if (!window.cloudContinuityApi) return;
      const current = continuityStates[sessionId]?.state ?? 'local_only';
      const next = current === 'cloud_active' ? 'local_only' : 'cloud_active';
      window.cloudContinuityApi.setState({ sessionId, state: next as 'local_only' | 'cloud_active' });
    }, [continuityStates]);

    // Track session to reveal after search result click
    const pendingRevealSessionId = useRef<string | null>(null);
    const sidebarRef = useRef<HTMLElement>(null);

    const sessionListRef = useRef<VirtualizedSessionListHandle>(null);
    // Ref to the sidebarListContainer — shared scroll element for virtualized lists
    const listContainerRef = useRef<HTMLDivElement>(null);

    // Lookup map for sessions by ID (for tooltip enrichment)
    const sessionsByIdMap = useMemo(() => {
      const map = new Map<string, AgentSessionSidebarEntry>();
      for (const session of sessions) {
        map.set(session.id, session);
      }
      return map;
    }, [sessions]);

    const recencyCutoff = useMemo(() => {
      const filterMs = RECENCY_FILTER_MS[recencyFilter];
      return filterMs ? Date.now() - filterMs : null;
    }, [recencyFilter]);

    const { entries: flatFilteredEntries, starredCount } = useMemo(
      () => filterSessionList(sessions, activeFilter, recencyCutoff, currentSessionId),
      [sessions, activeFilter, recencyCutoff, currentSessionId]
    );

    const isSearchMode = Boolean(sessionSearchQuery) || sessionSearchResults.length > 0 || Boolean(findSimilarSource);
    const isTrashView = activeFilter === 'trash';
    const showFolderGrouping = !isSearchMode && !isTrashView && activeFilter !== 'all';

    const filteredEntries: SidebarListEntry[] = useMemo(() => {
      if (!showFolderGrouping || folders.length === 0) {
        return flatFilteredEntries.map((entry) => ({ type: 'session' as const, id: entry.id, entry }));
      }
      return buildFolderAwareList(flatFilteredEntries, folders, folderMembership, {
        collapseState: folderCollapseState,
        doneCollapseState: folderDoneCollapseState,
        revealSessionId,
        allEntries: sessions,
        // The inline "Done (N)" subsection is an Active-tab concept only.
        includeDoneSubsection: activeFilter === 'active',
      });
    }, [flatFilteredEntries, folders, folderMembership, folderCollapseState, folderDoneCollapseState, revealSessionId, showFolderGrouping, sessions, activeFilter]);

    const folderStateEntries = useMemo(() => sessions.map((session) => ({
      id: session.id,
      isActive: Boolean(session.isActive),
      isDeleted: session.isDeleted,
    })), [sessions]);

    const folderPinnedStates = useMemo(() => {
      const states: Record<string, ReturnType<typeof getFolderPinnedState>> = {};
      for (const folder of folders) {
        states[folder.id] = getFolderPinnedState(folderStateEntries, folderMembership, folder.id);
      }
      return states;
    }, [folders, folderStateEntries, folderMembership]);

    const toggleFolderActiveState = useCallback((folderId: string, nextActive: boolean) => {
      const sessionIds = getFolderSessionIdsToSetActiveState(
        folderStateEntries,
        folderMembership,
        folderId,
        nextActive,
      );
      for (const sessionId of sessionIds) {
        onTogglePin(sessionId, undefined, { skipAutoSwitch: true });
      }
    }, [folderStateEntries, folderMembership, onTogglePin]);

    const handleFolderDoneToggle = useCallback((
      folderId: string,
      event?: React.MouseEvent<HTMLButtonElement>,
    ) => {
      event?.preventDefault();
      event?.stopPropagation();
      const folderState = folderPinnedStates[folderId] ?? 'empty';
      if (folderState === 'empty') {
        return;
      }

      // Polarity note: Active = `doneAt == null`. In the Done tab the toggle
      // re-activates the folder; in the Active tab it marks done; the 'all' tab
      // toggles based on current folder state.
      const nextActive = activeFilter === 'done'
        ? true
        : activeFilter === 'active'
          ? false
          : folderState === 'done';

      toggleFolderActiveState(folderId, nextActive);
    }, [activeFilter, folderPinnedStates, toggleFolderActiveState]);

    const handleFolderAwareStarToggle = useCallback((
      entry: AgentSessionSidebarEntry,
      event?: React.MouseEvent<HTMLButtonElement>,
    ) => {
      const folderId = folderMembership[entry.id];
      if (folderId && !entry.isDeleted && !entry.isActive) {
        toggleFolderActiveState(folderId, true);
      }
      onToggleStar(entry.id, event);
    }, [folderMembership, onToggleStar, toggleFolderActiveState]);

    const deletedCount = useMemo(
      () => sessions.filter((e) => e.isDeleted).length,
      [sessions]
    );

    // Deduplicate deep search results at render time (ensures main results > deep priority)
    const deduplicatedDeepResults = useMemo(() => {
      if (!sessionDeepSearchResults?.length) return [];
      const mainSessionIds = new Set(sessionSearchResults.map((r) => r.sessionId));
      return sessionDeepSearchResults.filter(
        (r) => !mainSessionIds.has(r.sessionId)
      );
    }, [sessionDeepSearchResults, sessionSearchResults]);

    // When a search result is selected or revealSessionId prop changes, reveal it in the list
    useLayoutEffect(() => {
      const sessionId = revealSessionId ?? pendingRevealSessionId.current;
      if (!sessionId || !sidebarRef.current) return;
      pendingRevealSessionId.current = null;

      const entry = sessions.find((s) => s.id === sessionId);
      if (entry) {
        if (entry.isDeleted && activeFilter !== 'trash') {
          handleFilterChange('trash');
        } else if (!entry.isDeleted && activeFilter === 'trash') {
          handleFilterChange('all');
        }
        // If the entry is excluded by the recency filter, clear it so the
        // session becomes visible (e.g. navigating to an old search result).
        if (recencyCutoff != null && entry.timestamp < recencyCutoff && !entry.isDeleted) {
          onRecencyFilterChange('all');
        }
      }

      requestAnimationFrame(() => {
        if (sessionListRef.current?.isVirtualized) {
          const idx = sessionListRef.current.findIndex(sessionId);
          if (idx >= 0) {
            sessionListRef.current.scrollToIndex(idx);
            if (revealSessionId) onRevealComplete?.();
            return;
          }
        }
        const el = sidebarRef.current?.querySelector(`[data-session-id="${sessionId}"]`);
        if (el) {
          el.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        }
        if (revealSessionId) onRevealComplete?.();
      });
    }, [filteredEntries, revealSessionId, onRevealComplete, sessions, activeFilter, handleFilterChange, recencyCutoff, onRecencyFilterChange]);

    const handleListItemMouseLeave = useCallback((
      event: ReactMouseEvent<HTMLElement>,
    ) => {
      const active = document.activeElement as HTMLElement | null;
      if (active && event.currentTarget.contains(active)) {
        active.blur();
      }
    }, []);

    const renderFolderHeader = useCallback((listEntry: SidebarListEntry & { type: 'folder-header' }) => {
      return (
        <FolderHeaderRow
          key={listEntry.id}
          folder={listEntry.folder}
          allFolders={folders}
          childCount={listEntry.childCount}
          isCollapsed={listEntry.isCollapsed}
          isDone={
            activeFilter === 'done'
              ? true
              : activeFilter === 'active'
                ? false
                : folderPinnedStates[listEntry.folder.id] === 'done'
          }
          onToggleCollapse={toggleFolderCollapse}
          onToggleDone={handleFolderDoneToggle}
          onRename={handleFolderRename}
          onDelete={handleFolderDeleteRequest}
          isEditing={editingFolderId === listEntry.folder.id}
          onStartEdit={() => setEditingFolderId(listEntry.folder.id)}
          onCancelEdit={() => setEditingFolderId(null)}
          onSessionDrop={(sessionId) => handleFolderSessionDrop(listEntry.folder.id, sessionId)}
        />
      );
    }, [toggleFolderCollapse, handleFolderDoneToggle, handleFolderRename, handleFolderDeleteRequest, editingFolderId, folders, handleFolderSessionDrop, activeFilter, folderPinnedStates]);

    const renderSessionEntry = useCallback((entry: AgentSessionSidebarEntry, index: number, isMutedDone = false) => {
      const isCurrentSession = entry.id === currentSessionId;
      const isResolved = entry.isResolved;
      const isEditing = editingSessionId === entry.id;
      const inlineIcon = renderInlineStatusIcon(entry.status);
      const mainClass = [
        styles.entryMain,
        inlineIcon ? styles.entryMainWithIcon : "",
        isMutedDone ? styles.entryMutedDone : "",
      ].filter(Boolean).join(" ");
      const isDeleting = entry.id === deletingSessionId;
      const hasContent = entry.messageCount > 0 || entry.hasDraft || entry.isHistory;
      const isTrashEntry = entry.isDeleted;
      const isInFolder = showFolderGrouping && Boolean(folderMembership[entry.id]);

      const isDraggable = hasContent && !isEditing && !isTrashEntry;

      return (
        <div
          key={entry.id}
          data-session-id={entry.id}
          data-last-starred={index === starredCount - 1 && starredCount > 0 && starredCount < flatFilteredEntries.length && activeFilter !== 'starred' && folders.length === 0 ? 'true' : undefined}
          className={`${styles.listItem}${isDeleting ? ` ${styles.listItemDeleting}` : ''}${draggingSessionId === entry.id ? ` ${styles.sessionDragging}` : ''}`}
          draggable={isDraggable || undefined}
          onDragStart={isDraggable ? (e) => handleDragStart(e, entry.id) : undefined}
          onDragEnd={isDraggable ? handleDragEnd : undefined}
          onMouseLeave={handleListItemMouseLeave}
          onContextMenu={hasContent ? (e) => handleSessionContextMenu(entry.id, e) : undefined}
        >
          <Tooltip
            content={<SessionTooltipContent entry={entry} isSemanticIndexed={indexedSessionIds?.has(entry.id)} />}
            placement="right"
            delayShow={400}
            disabled={isEditing || entry.isCorrupted}
          >
            <button
              type="button"
              className={buildEntryClassName({
                isActive: isCurrentSession,
                isCorrupted: entry.isCorrupted,
                isResolved,
              })}
              aria-current={isCurrentSession ? "true" : undefined}
              onClick={() => !isEditing && onSelectSession(entry.id, entry.isHistory)}
              title={entry.isCorrupted ? "Conversation data is corrupted and cannot be opened" : undefined}
            >
              <div className={mainClass}>
                <div className={styles.entryTitleRow}>
                  {entry.hasUnreadResponse && entry.status !== 'thinking' && (
                    <span className={styles.unreadDot} aria-label="New response" />
                  )}
                  {inlineIcon}
                  {isEditing ? (
                    <SessionRenameInput
                      inputRef={editInputRef}
                      initialValue={editValue}
                      onChange={onEditChange}
                      onKeyDown={onEditKeyDown}
                      onBlur={onEditBlur}
                      sessionId={entry.id}
                      originalTitle={entry.title}
                    />
                  ) : (
                    <span className={styles.entryTitle}>
                      {(() => {
                        // Kind-based badge marks Rebel-generated (background) runs.
                        const kindBadge = sessionKindBadgeLabel(entry.id)
                          ?? (isAutomationSession(entry.id) ? "Automation" : null);
                        return kindBadge ? (
                          <span className={styles.kindBadge}>{kindBadge}</span>
                        ) : null;
                      })()}
                      {entry.isCorrupted && <span className={styles.corruptedIcon}>⚠️ </span>}
                      {entry.isMeetingCompanion && (
                        <span className={styles.meetingCompanionBadge} aria-label="Meeting companion">
                          <Video size={10} />
                        </span>
                      )}
                      {stripMarkdown(entry.title)}
                    </span>
                  )}
                </div>
                <div className={styles.entryMeta}>
                  <span className={styles.entryPreview}>{stripMarkdown(entry.preview)}</span>
                </div>
                {entry.hasCoaching && (
                  <span className={styles.recommendsChip} aria-label="Rebel has a recommendation">
                    <Sparkles size={10} className={styles.recommendsChipIcon} aria-hidden />
                    Rebel recommends
                  </span>
                )}
              </div>
              <div className={styles.entryTimeGroup}>
                <span className={styles.entryTime}>{formatHistoryTimestamp(entry.timestamp)}</span>
                <span className={styles.entryMessageCount}>
                  {entry.messageCount}
                  <MessagesSquare size={10} className={styles.messageCountIcon} aria-hidden />
                </span>
                {entry.timeSavedMinutes != null && entry.timeSavedMinutes >= 5 && (
                  <span className={styles.entryTimeSavedPill}>
                    ~{entry.timeSavedMinutes >= 60
                      ? entry.timeSavedMinutes % 60 < 10
                        ? `${Math.round(entry.timeSavedMinutes / 60)}h`
                        : `${Math.floor(entry.timeSavedMinutes / 60)}h ${Math.round(entry.timeSavedMinutes % 60)}m`
                      : `${Math.round(entry.timeSavedMinutes)}m`
                    } saved
                  </span>
                )}
              </div>
            </button>
          </Tooltip>
          {isTrashEntry ? (
            <div className={styles.actions}>
              <Tooltip content="Restore">
                <button
                  type="button"
                  className={`${styles.actionButton} ${styles.restoreButton}`}
                  onClick={(event) => { onRestoreSession(entry.id, event); (event.currentTarget as HTMLButtonElement).blur(); }}
                  aria-label={`Restore ${entry.title}`}
                >
                  <RotateCcw className={styles.actionIcon} aria-hidden />
                </button>
              </Tooltip>
              <Tooltip content="Delete permanently">
                <button
                  type="button"
                  className={`${styles.actionButton} ${styles.deleteButton}`}
                  onClick={(event) => { onDeleteSession(entry.id, event); (event.currentTarget as HTMLButtonElement).blur(); }}
                  aria-label={`Delete ${entry.title} permanently`}
                >
                  <Trash2 className={styles.actionIcon} aria-hidden />
                </button>
              </Tooltip>
            </div>
          ) : hasContent ? (
            <SessionListItemActions
              {...buildSessionRowActionsProps(
                {
                  sessionId: entry.id,
                  sessionTitle: entry.title,
                  isActive: Boolean(entry.isActive),
                  isStarred: Boolean(entry.isStarred),
                  isCloudActive: continuityStates[entry.id]?.state === 'cloud_active',
                  isInFolder,
                  hasContinuityApi,
                  isSearchContext: false,
                },
                {
                  onToggleStar: (_sessionId, event) => handleFolderAwareStarToggle(entry, event),
                  onTogglePin,
                  onToggleCloudContinuity: handleToggleCloudContinuity,
                  onRename: onStartRename,
                  onDelete: onSoftDeleteSession,
                  onFindSimilar,
                  onCopyMarkdown,
                  onExportMarkdown,
                  onCopyLink,
                  onShareConversation,
                  onDiagnose,
                  onExportLogs,
                  onMoveToFolder: handleMoveToFolder,
                  onRemoveFromFolder: (sessionId: string) => removeSessionFromFolder(sessionId),
                },
              )}
              contextAnchor={contextMenu?.sessionId === entry.id ? contextMenu?.anchor ?? null : null}
              onContextClose={handleContextMenuClose}
            />
          ) : null}
        </div>
      );
    }, [currentSessionId, editingSessionId, editValue, deletingSessionId, starredCount, flatFilteredEntries.length, activeFilter, indexedSessionIds, hasContinuityApi, continuityStates, editInputRef, contextMenu, draggingSessionId, onSelectSession, onTogglePin, onSoftDeleteSession, onDeleteSession, onRestoreSession, onStartRename, onEditChange, onEditKeyDown, onEditBlur, onFindSimilar, onCopyMarkdown, onExportMarkdown, onCopyLink, onShareConversation, onDiagnose, onExportLogs, handleFolderAwareStarToggle, handleToggleCloudContinuity, handleSessionContextMenu, handleContextMenuClose, handleListItemMouseLeave, handleMoveToFolder, handleDragStart, handleDragEnd, removeSessionFromFolder, folderMembership, showFolderGrouping, folders.length]);

    const renderEntry = useCallback((listEntry: SidebarListEntry, index: number) => {
      if (listEntry.type === 'folder-header') {
        return renderFolderHeader(listEntry);
      }
      if (listEntry.type === 'done-subheader') {
        return (
          <div key={listEntry.id} className={styles.doneSubheaderRow}>
            <DoneSubsectionRow
              folderId={listEntry.folderId}
              folderName={listEntry.folderName}
              doneCount={listEntry.doneCount}
              isCollapsed={listEntry.isCollapsed}
              onToggle={toggleFolderDoneCollapse}
            />
          </div>
        );
      }
      // Determine if this session is a child of a folder (indent it)
      const sessionFolderId = folderMembership[listEntry.entry.id];
      const isInFolder = showFolderGrouping && Boolean(sessionFolderId) && folders.some((f) => f.id === sessionFolderId);
      const node = renderSessionEntry(listEntry.entry, index, Boolean(listEntry.isMutedDone));
      if (isInFolder) {
        const canMoveDraggedSessionIntoFolder = draggingSessionId
          ? folderMembership[draggingSessionId] !== sessionFolderId
          : true;
        return (
          <div
            key={listEntry.id}
            className={`${styles.folderChildDropZone}${canMoveDraggedSessionIntoFolder && activeFolderDropTargetSessionId === listEntry.entry.id ? ` ${styles.folderChildDropZoneActive}` : ''}`}
            data-drop-label={`Drop into ${folders.find((folder) => folder.id === sessionFolderId)?.name ?? 'folder'}`}
            onDragOver={(e) => handleFolderChildDragOver(e, sessionFolderId, listEntry.entry.id)}
            onDragLeave={(e) => handleFolderChildDragLeave(e, listEntry.entry.id)}
            onDrop={(e) => handleFolderChildDrop(e, sessionFolderId)}
          >
            {node}
          </div>
        );
      }
      return node;
    }, [renderFolderHeader, renderSessionEntry, toggleFolderDoneCollapse, folderMembership, folders, showFolderGrouping, draggingSessionId, activeFolderDropTargetSessionId, handleFolderChildDragOver, handleFolderChildDragLeave, handleFolderChildDrop]);

    const renderSearchResults = () => {
      const hasNoResults = sessionSearchResults.length === 0;
      const hasDeepResults = deduplicatedDeepResults.length > 0;
      const showDeepSearchButton = !findSimilarSource && sessionSearchQuery.trim().length >= 3 && onTriggerDeepSearch;
      const findSimilarTitle = findSimilarSource ? stripMarkdown(findSimilarSource.title) : '';
      const findSimilarHeader = findSimilarSource ? (
        <div className={styles.findSimilarHeader}>
          <button
            type="button"
            className={styles.findSimilarBackLink}
            onClick={() => onClearSearch()}
          >
            <ArrowLeft size={12} aria-hidden />
            Back to all conversations
          </button>
          <span className={styles.findSimilarLabel} title={findSimilarTitle}>
            {findSimilarTitle.trim()
              ? `Similar to “${findSimilarTitle}”`
              : 'Similar to this conversation'}
          </span>
        </div>
      ) : null;

      const noResultsSettled = hasNoResults && !isSearching && !hasDeepResults && !isDeepSearching;

      // F4 — honest availability states, distinct from a genuine no-match. Never imply the
      // user's conversations are gone when search is merely warming up or erroring.

      // Unexpected backend failure → reassure + offer retry (recoverable).
      if (noResultsSettled && searchStatus === 'error') {
        return (
          <div className={styles.searchEmpty}>
            <CloudOff size={20} className={styles.searchStatusIcon} aria-hidden />
            <p role="status">Search is taking a breather.</p>
            <p className={styles.searchEmptyHint}>
              Your conversations are safe — search just isn't responding right now.
            </p>
            {onRetrySearch && (
              <button type="button" className={styles.deepSearchButton} onClick={onRetrySearch}>
                <RotateCcw size={14} aria-hidden />
                <span>Try again</span>
              </button>
            )}
          </div>
        );
      }

      // Index / embedding still warming up → it resolves itself, so no action button.
      if (noResultsSettled && (searchStatus === 'index_not_ready' || searchStatus === 'embedding_unavailable')) {
        return (
          <div className={styles.searchEmpty}>
            <div className={styles.semanticSearchingIndicator}>
              <Loader2 className={styles.semanticSpinner} aria-hidden />
              <span role="status">Getting search ready — full results in a moment.</span>
            </div>
          </div>
        );
      }

      // Genuine no-match (status ok): the only state that says "No conversations match".
      if (noResultsSettled && searchStatus === 'ok') {
        return (
          <>
            {findSimilarHeader}
            <div className={styles.searchEmpty}>
              <p>{findSimilarSource ? 'No similar conversations turned up.' : `No conversations match "${sessionSearchQuery}"`}</p>
              {showDeepSearchButton ? (
                <>
                  <Tooltip content="Scans every message in every conversation — slower but thorough" placement="bottom" delayShow={300}>
                    <button
                      type="button"
                      className={styles.deepSearchButton}
                      onClick={onTriggerDeepSearch}
                    >
                      <Search size={14} aria-hidden />
                      <span>Search all messages</span>
                    </button>
                  </Tooltip>
                  {recencyFilter !== 'all' && (
                    <p className={styles.deepSearchScopeNote}>within the last {RECENCY_FILTER_LABELS[recencyFilter]}</p>
                  )}
                </>
              ) : !findSimilarSource ? (
                <p className={styles.searchEmptyHint}>
                  Try a different word, or fewer letters.
                </p>
              ) : null}
            </div>
          </>
        );
      }

      // Show loading state if searching and no results yet
      if (hasNoResults && isSearching && !hasDeepResults && !isDeepSearching) {
        return (
          <>
            {findSimilarHeader}
            <div className={styles.searchEmpty}>
              <div className={styles.semanticSearchingIndicator}>
                <Loader2 className={styles.semanticSpinner} aria-hidden />
                <span>Searching...</span>
              </div>
            </div>
          </>
        );
      }
      
      // Show deep search loading state
      if (hasNoResults && !isSearching && isDeepSearching) {
        return (
          <>
            {findSimilarHeader}
            <div className={styles.searchEmpty}>
              <div className={styles.semanticSearchingIndicator}>
                <Loader2 className={styles.semanticSpinner} aria-hidden />
                <span>Searching all messages...</span>
              </div>
            </div>
          </>
        );
      }

      return (
        <>
          {findSimilarHeader}
          <div className={styles.searchResults}>
            <ul className={styles.sidebarList}>
              {/* F4: non-blocking availability note above results (e.g. title-floor matches are
                  showing while the index warms up, or backend hit a transient error). Never
                  implies the conversations are gone — results are still listed below. */}
              {searchStatus !== 'ok' && (
                <li className={styles.semanticSearchingRow}>
                  {searchStatus === 'error' ? (
                    <>
                      <CloudOff size={12} aria-hidden />
                      <span role="status">Showing what we have — search isn't fully responding.</span>
                      {onRetrySearch && (
                        <button type="button" className={styles.deepSearchButtonInline} onClick={onRetrySearch}>
                          <RotateCcw size={12} aria-hidden />
                          <span>Try again</span>
                        </button>
                      )}
                    </>
                  ) : (
                    <>
                      <Loader2 className={styles.semanticSpinnerSmall} aria-hidden />
                      <span role="status">Getting search ready. Showing title matches for now.</span>
                    </>
                  )}
                </li>
              )}
              {/* Fuse.js results (keyword matches) */}
              {sessionSearchResults.map((result, index) => {
              const isSelected = index === sessionSearchSelectedIndex;
              const isActive = result.sessionId === currentSessionId;
              const isEditing = editingSessionId === result.sessionId;
              // Look up full session entry for rich tooltip
              const sessionEntry = sessionsByIdMap.get(result.sessionId);
              return (
                <li
                  key={result.sessionId}
                  className={styles.listItem}
                  data-session-id={result.sessionId}
                  onMouseLeave={handleListItemMouseLeave}
                  onContextMenu={(e) => sessionEntry && handleSessionContextMenu(result.sessionId, e)}
                >
                  <Tooltip
                    content={sessionEntry ? <SessionTooltipContent entry={sessionEntry} isSemanticIndexed={indexedSessionIds?.has(result.sessionId)} /> : stripMarkdown(result.sessionTitle)}
                    placement="right"
                    delayShow={400}
                    disabled={isEditing}
                  >
                    <button
                      type="button"
                      className={buildEntryClassName({
                        isActive,
                        isSelected,
                        isResolved: result.isResolved,
                      })}
                      onClick={() => {
                        if (isEditing) return;
                        pendingRevealSessionId.current = result.sessionId;
                        onSelectSession(result.sessionId, result.isHistory);
                        onClearSearch({ rememberForBack: true });
                      }}
                      onMouseEnter={() => onSearchHover(index)}
                    >
                      <div className={styles.entryMain}>
                        {isEditing ? (
                          <input
                            ref={editInputRef}
                            type="text"
                            className={styles.titleEditInput}
                            value={editValue}
                            onChange={(e) => onEditChange(e.target.value)}
                            onKeyDown={(e) => onEditKeyDown(e, result.sessionTitle)}
                            onBlur={() => onEditBlur(result.sessionId, result.sessionTitle)}
                            onClick={(e) => e.stopPropagation()}
                            aria-label="Edit conversation title"
                          />
                        ) : (
                          <span className={styles.entryTitle}>
                            {(() => {
                              const kindBadge = sessionKindBadgeLabel(result.sessionId)
                                ?? (isAutomationSession(result.sessionId) ? "Automation" : null);
                              return kindBadge ? (
                                <span className={styles.kindBadge}>{kindBadge}</span>
                              ) : null;
                            })()}
                            {stripMarkdown(result.sessionTitle)}
                          </span>
                        )}
                        <div className={styles.entryMeta}>
                          <span className={styles.entryPreview}>
                            {result.isTitle
                              ? stripMarkdown(result.matchedText)
                              : `"${stripMarkdown(result.matchedText)}"`}
                          </span>
                        </div>
                        <span className={styles.entryMetadata}>
                          {result.messageCount} message
                          {result.messageCount !== 1 ? "s" : ""} ·{" "}
                          {formatHistoryTimestamp(result.sessionTimestamp)}
                        </span>
                      </div>
                    </button>
                  </Tooltip>
                  {sessionEntry && (
                    <SessionListItemActions
                      {...buildSessionRowActionsProps(
                        {
                          sessionId: result.sessionId,
                          sessionTitle: stripMarkdown(result.sessionTitle),
                          isActive: Boolean(sessionEntry.isActive),
                          isStarred: Boolean(sessionEntry.isStarred),
                          isCloudActive: continuityStates[result.sessionId]?.state === 'cloud_active',
                          isInFolder: Boolean(folderMembership[result.sessionId]),
                          hasContinuityApi,
                          isSearchContext: true,
                        },
                        {
                          onToggleStar: (_sessionId, event) => handleFolderAwareStarToggle(sessionEntry, event),
                          onTogglePin,
                          onToggleCloudContinuity: handleToggleCloudContinuity,
                          onRename: onStartRename,
                          onDelete: onSoftDeleteSession,
                          onFindSimilar,
                          onCopyMarkdown,
                          onExportMarkdown,
                          onCopyLink,
                          onShareConversation,
                          onDiagnose,
                          onExportLogs,
                          onMoveToFolder: handleMoveToFolder,
                          onRemoveFromFolder: (sessionId: string) => removeSessionFromFolder(sessionId),
                        },
                      )}
                      contextAnchor={contextMenu?.sessionId === result.sessionId ? contextMenu?.anchor ?? null : null}
                      onContextClose={handleContextMenuClose}
                    />
                  )}
                </li>
              );
            })}

            {/* Search loading indicator (inline, shows when results already exist) */}
            {isSearching && sessionSearchResults.length > 0 && (
              <li className={styles.semanticSearchingRow}>
                <Loader2 className={styles.semanticSpinnerSmall} aria-hidden />
                <span>Searching...</span>
              </li>
            )}

            {/* Deep search loading indicator (inline, shows when other results exist) */}
            {isDeepSearching && sessionSearchResults.length > 0 && (
              <li className={styles.semanticSearchingRow}>
                <Loader2 className={styles.semanticSpinnerSmall} aria-hidden />
                <span>Searching all messages...</span>
              </li>
            )}

            {/* Deep search results (full-text search across all messages) */}
            {deduplicatedDeepResults.length > 0 && (
              <>
                <li className={styles.semanticDivider}>
                  <Search size={12} className={styles.semanticDividerIcon} aria-hidden />
                  <span>Deep matches</span>
                </li>
                {deduplicatedDeepResults.map((result) => {
                  const isActive = result.sessionId === currentSessionId;
                  const sessionEntry = sessionsByIdMap.get(result.sessionId);
                  return (
                    <li
                      key={`deep-${result.sessionId}`}
                      className={styles.listItem}
                      data-session-id={result.sessionId}
                      onMouseLeave={handleListItemMouseLeave}
                      onContextMenu={(e) => sessionEntry && handleSessionContextMenu(result.sessionId, e)}
                    >
                      <Tooltip
                        content={sessionEntry ? <SessionTooltipContent entry={sessionEntry} isSemanticIndexed={indexedSessionIds?.has(result.sessionId)} /> : (result.title ?? 'Untitled')}
                        placement="right"
                        delayShow={400}
                      >
                        <button
                          type="button"
                          className={buildEntryClassName({
                            isActive,
                            isSelected: false,
                            isResolved: sessionEntry?.isResolved ?? false,
                          })}
                          onClick={() => {
                            pendingRevealSessionId.current = result.sessionId;
                            onSelectSession(result.sessionId, true);
                            onClearSearch({ rememberForBack: true });
                          }}
                        >
                          <div className={styles.entryMain}>
                            <span className={styles.entryTitle}>{result.title ?? 'Untitled'}</span>
                            <div className={styles.entryMeta}>
                              <span className={styles.entryPreview}>
                                "{stripMarkdown(result.matchPreview)}"
                              </span>
                            </div>
                            <span className={styles.entryMetadata}>
                              {result.matchCount} match{result.matchCount !== 1 ? "es" : ""}
                            </span>
                          </div>
                        </button>
                      </Tooltip>
                      {sessionEntry && (
                        <SessionListItemActions
                          {...buildSessionRowActionsProps(
                            {
                              sessionId: result.sessionId,
                              sessionTitle: result.title ?? 'Untitled',
                              isActive: Boolean(sessionEntry.isActive),
                              isStarred: Boolean(sessionEntry.isStarred),
                              isCloudActive: continuityStates[result.sessionId]?.state === 'cloud_active',
                              isInFolder: Boolean(folderMembership[result.sessionId]),
                              hasContinuityApi,
                              isSearchContext: true,
                            },
                            {
                              onToggleStar: (_sessionId, event) => handleFolderAwareStarToggle(sessionEntry, event),
                              onTogglePin,
                              onToggleCloudContinuity: handleToggleCloudContinuity,
                              onRename: onStartRename,
                              onDelete: onSoftDeleteSession,
                              onFindSimilar,
                              onCopyMarkdown,
                              onExportMarkdown,
                              onCopyLink,
                              onShareConversation,
                              onDiagnose,
                              onExportLogs,
                              onMoveToFolder: handleMoveToFolder,
                              onRemoveFromFolder: (sessionId: string) => removeSessionFromFolder(sessionId),
                            },
                          )}
                          contextAnchor={contextMenu?.sessionId === result.sessionId ? contextMenu?.anchor ?? null : null}
                          onContextClose={handleContextMenuClose}
                        />
                      )}
                    </li>
                  );
                })}
              </>
            )}

            {/* "Search all messages" button when there are results but user might want deeper search */}
            {showDeepSearchButton && !isDeepSearching && deduplicatedDeepResults.length === 0 && sessionSearchResults.length > 0 && (
              <li className={styles.deepSearchRow}>
                <Tooltip content="Scans every message in every conversation — slower but thorough" placement="bottom" delayShow={300}>
                  <button
                    type="button"
                    className={styles.deepSearchButtonInline}
                    onClick={onTriggerDeepSearch}
                  >
                    <Search size={12} aria-hidden />
                    <span>Search all messages</span>
                  </button>
                </Tooltip>
                {recencyFilter !== 'all' && (
                  <span className={styles.deepSearchScopeNote}>within the last {RECENCY_FILTER_LABELS[recencyFilter]}</span>
                )}
              </li>
            )}
            </ul>
            <div className={styles.searchFooter}>
              ↵ Open · ↑↓ Navigate · Esc Close
            </div>
          </div>
        </>
      );
    };

    return (
      <aside ref={sidebarRef} className={styles.sidebar} data-testid="session-sidebar">
        <div className={styles.searchBox}>
          <div className={styles.searchHeader}>
            <div className={styles.searchInputWrapper}>
              <Search size={14} className={styles.searchIcon} aria-hidden />
              <Input
                ref={sessionSearchInputRef}
                type="text"
                inputSize="sm"
                className={styles.searchInput}
                placeholder="Search conversations..."
                value={sessionSearchQuery}
                onChange={(event) => onSearchChange(event.target.value)}
                onKeyDown={onSearchKeyDown}
                data-testid="session-search-input"
              />
              {(sessionSearchQuery || sessionSearchResults.length > 0) && (
                <button
                  type="button"
                  className={styles.searchClear}
                  onClick={() => onClearSearch()}
                  aria-label={findSimilarSource ? 'Back to all conversations' : 'Clear search'}
                >
                  <X size={14} aria-hidden />
                </button>
              )}
            </div>
            {headerActions}
          </div>
          {sessionSearchQuery && sessionSearchResults.length > 0 && (
            <div className={styles.searchCount}>
              {sessionSearchResults.length} result
              {sessionSearchResults.length !== 1 ? "s" : ""}
            </div>
          )}
          {!sessionSearchQuery && lastSearchQuery && onRestoreSearch && (
            <button
              type="button"
              className={styles.backToSearchLink}
              onClick={onRestoreSearch}
            >
              <ArrowLeft size={12} aria-hidden />
              <span>Back to search</span>
            </button>
          )}
          {/* Active filter chips */}
          {recencyFilter !== 'all' && (
            <div className={styles.activeFilters}>
              <button
                type="button"
                className={styles.filterChip}
                onClick={() => onRecencyFilterChange('all')}
                aria-label={`Remove ${RECENCY_FILTER_LABELS[recencyFilter]} filter`}
              >
                <Clock size={12} aria-hidden />
                <span>{RECENCY_FILTER_LABELS[recencyFilter]}</span>
                <X size={12} className={styles.filterChipClose} aria-hidden />
              </button>
            </div>
          )}
        </div>
        {checklistWidget}
        <div className={styles.sidebarBody}>
          {sessionSearchQuery || sessionSearchResults.length > 0 || findSimilarSource ? (
            renderSearchResults()
          ) : (
            <>
              {activeFilter !== 'trash' && (
                <div className={styles.filterBar}>
                  <Tabs value={activeFilter} onValueChange={handleFilterChange}>
                    <TabsList aria-label="Filter conversations" className={styles.filterBarList}>
                      <TabsTrigger value="active" className={styles.filterBarTrigger}>Active</TabsTrigger>
                      <TabsTrigger value="starred" className={styles.filterBarTrigger} aria-label="Starred">
                        <Star size={14} />
                      </TabsTrigger>
                      <TabsTrigger value="done" className={styles.filterBarTrigger}>Done</TabsTrigger>
                      <TabsTrigger value="all" className={styles.filterBarTrigger}>All</TabsTrigger>
                    </TabsList>
                  </Tabs>
                </div>
              )}
              <div
                ref={listContainerRef}
                className={styles.sidebarListContainer}
                onDragOver={handleSidebarDragOver}
                onDrop={handleSidebarDrop}
              >
                {activeFilter === 'trash' && (
                  <div className={styles.trashHeader}>
                    <button
                      type="button"
                      className={styles.trashBackLink}
                      onClick={() => handleFilterChange('all')}
                    >
                      <ArrowLeft size={12} aria-hidden />
                      All conversations
                    </button>
                    <Tooltip content="Permanently delete all items in Trash" placement="bottom">
                      <button
                        type="button"
                        className={styles.emptyTrashButton}
                        onClick={onEmptyTrash}
                        aria-label="Empty trash"
                      >
                        <Trash2 size={12} aria-hidden />
                        Empty
                      </button>
                    </Tooltip>
                  </div>
                )}
                <VirtualizedSessionList
                  ref={sessionListRef}
                  entries={filteredEntries}
                  scrollContainerRef={listContainerRef}
                  data-testid="session-list"
                  renderEntry={renderEntry}
                />
                {activeFilter !== 'trash' && !isSearchMode && (
                  <>
                    {isCreatingFolder && (
                      <div className={styles.newFolderInputRow}>
                        <input
                          ref={newFolderInputRef}
                          type="text"
                          className={styles.newFolderInput}
                          value={newFolderName}
                          onChange={(e) =>
                            setNewFolderName(e.target.value.slice(0, MAX_FOLDER_NAME_LENGTH))
                          }
                          onKeyDown={handleCreateFolderKeyDown}
                          onBlur={handleCreateFolderCommit}
                          placeholder="Folder name…"
                          maxLength={MAX_FOLDER_NAME_LENGTH}
                          aria-label="New folder name"
                          aria-invalid={newFolderNameDuplicate || undefined}
                        />
                        {newFolderNameDuplicate && (
                          <p className={styles.folderNameDuplicateWarning} role="status">
                            A folder with this name already exists
                          </p>
                        )}
                      </div>
                    )}
                    <button
                      type="button"
                      className={styles.newFolderButton}
                      onClick={() => setIsCreatingFolder(true)}
                    >
                      <FolderPlus size={13} aria-hidden />
                      <span>New folder</span>
                    </button>
                  </>
                )}
                <div className="scroll-fade-bottom" aria-hidden />
              </div>
              {deletedCount > 0 && activeFilter !== 'trash' && (
                <button
                  type="button"
                  className={styles.trashFooterLink}
                  onClick={() => handleFilterChange('trash')}
                >
                  <Trash2 size={14} aria-hidden />
                  Trash ({deletedCount})
                </button>
              )}
            </>
          )}
        </div>

        {/* Move to folder popover */}
        {moveToFolderState && (
          <MoveToFolderPopover
            folders={folders}
            currentFolderId={folderMembership[moveToFolderState.sessionId] ?? null}
            anchor={moveToFolderState.anchor}
            onMoveToFolder={(folderId) => {
              moveSessionToFolder(moveToFolderState.sessionId, folderId);
            }}
            onRemoveFromFolder={() => {
              removeSessionFromFolder(moveToFolderState.sessionId);
            }}
            onCreateFolder={createFolder}
            onClose={() => setMoveToFolderState(null)}
          />
        )}

      </aside>
    );
  },
);

AgentSessionSidebar.displayName = "AgentSessionSidebar";
