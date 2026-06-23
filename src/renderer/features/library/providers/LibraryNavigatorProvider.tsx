import type React from 'react';
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { useFlowPanels } from '@renderer/features/flow-panels/FlowPanelsProvider';
import type { AppSettings, FileNode, MemoryHistoryEntry } from '@shared/types';
import type { SpaceInfo } from '@shared/ipc/schemas/library';
import type { LibraryDocumentState } from '../types';
import type { LibraryCommandShelfProps } from '../components/LibraryCommandShelf';
import type { LibraryTreeViewProps, LibraryDropTarget } from '../components/LibraryTreeView';
import type { LibraryRecentDrawerProps } from '../components/LibraryRecentDrawer';
import type { LibrarySearchResultsProps } from '../components/LibrarySearchResults';
import { useLibraryLens } from '../hooks/useLibraryLens';
import { useFilterFacets } from '../hooks/useFilterFacets';
import type { LibraryLens, LibrarySortOption } from '../types/lens';
import { useLibraryTree } from '../hooks/useLibraryTree';
import { useLibrarySearch } from '../hooks/useLibrarySearch';
import { useLibraryContentSearch } from '../hooks/useLibraryContentSearch';
import { useSkillsIndex, type SkillInfo, type SkillsScanResult } from '../hooks/useSkillsIndex';
import { useSemanticSearch } from '../hooks/useSemanticSearch';
import { usePendingMemoryApprovals, type PendingMemoryRequest } from '../hooks/usePendingMemoryApprovals';
import { useSpacesData } from '@renderer/hooks/useSpacesData';
import { clearRecentFiles, createPathMap, flattenFileTree } from '@renderer/utils/librarySearch';
import type { FlatFileEntry } from '@renderer/utils/librarySearch';
import { isEditableWorkspaceFile } from '@renderer/constants';
import { isPreviewablePath } from '@renderer/utils/documentUtils';
import { cn } from '@renderer/lib/utils';
import { tracking } from '@renderer/src/tracking';
import drawerStyles from '../components/LibraryDrawer.module.css';
import { getFileName } from '@renderer/utils/stringUtils';
import { normalizeLibraryPath, getParentDirectoryPath, isDescendantPath, getRelativeLibraryPath } from '../utils/pathUtils';
import { calculateProfileCompletion } from '../utils/profileCompletion';
import type { EmitLogFn } from '@renderer/contexts';
import type { ToastProps } from '@renderer/components/ui';
import { resolveModelSettings } from '@shared/utils/settingsUtils';
import { getRevealClassification } from '../utils/revealInClassifiedView';
import type { LibrarySearchOutcome } from '../search/engine';
import type { TreeCompleteness } from '../search/useTruncationSignal';
import type { FileTreeTruncationReason } from '@shared/ipc/contracts';

type CreateDialogState = { type: 'file' | 'folder'; parentNode?: FileNode } | null;

/**
 * Derived tree-completeness shared across every consumer (search, facets,
 * recents, reveal, empty states) — the single source of truth replacing the
 * per-consumer reads of the separate stats walk. See PLAN.md Stage 3.
 */
export type TreePartialState = {
  isPartialTree: TreeCompleteness;
  reasons: readonly FileTreeTruncationReason[];
  unavailableNodes: number;
};

/** Handle exposed by the provider for external access to navigation */
export type LibraryNavigatorHandle = {
  navigateToFolder: (folderRelativePath: string) => void;
  revealInTree: (filePath: string) => void;
  /** Reset to opening state: close editor, restore default browse lens, clear search/filters */
  resetToOpeningState: () => void;
};

type LibraryNavigatorProviderProps = {
  open: boolean;
  settings: AppSettings | null;
  refreshSettings?: () => Promise<void>;
  showToast: (options: Omit<ToastProps, 'id'>) => string;
  emitLog: EmitLogFn;
  editorDocument: LibraryDocumentState | null;
  loadWorkspaceFile: (filePath: string) => Promise<void>;
  closeEditor: () => void;
  onBrowseLensInteraction?: () => void;
  recentFiles: string[];
  setRecentFiles: React.Dispatch<React.SetStateAction<string[]>>;
  onUseSkill?: (skillRelativePath: string) => void;
  onCreateSkill?: () => void;
  onCreateMemory?: () => void;
  onAddSpace?: () => void;
  onManageSpaces?: () => void;
  canCreateAdditionalSpaces?: boolean;
  createActionPending?: boolean;
  onOpenSession?: (sessionId: string) => void;
  /** Ref callback to expose internal navigation functions to parent */
  onNavigatorReady?: (handle: LibraryNavigatorHandle) => void;
  /** Start a new conversation with files attached (for Atlas) */
  onStartConversation?: (message: string, filePaths: string[]) => void;
  /** Share a library file publicly via cloud share link */
  onShareFile?: (filePath: string) => void;
  children: React.ReactNode;
};

type RootDropZoneState = {
  visible: boolean;
  isActive: boolean;
  isInvalid: boolean;
  onDragOver: (event: React.DragEvent<HTMLDivElement>) => void;
  onDrop: (event: React.DragEvent<HTMLDivElement>) => void;
  onDragLeave: (event: React.DragEvent<HTMLDivElement>) => void;
};

// Match store-side cap to avoid renderer-side truncation below persisted history bounds.
const MEMORY_HISTORY_MAX_ENTRIES = 5000;
const MEMORY_HISTORY_PAGE_SIZE = 250;

type LibraryStatsSnapshot = { totalFiles: number; totalDirs: number; truncated: boolean };
export type LibraryStatsState = LibraryStatsSnapshot | null | 'pending' | 'failed';
type PendingLibraryStats = {
  generation: number;
  state: LibraryStatsSnapshot | 'failed';
};

function normalizePendingFolderPath(
  folderPath: string,
  libraryRootAbsolute: string,
): string {
  const normalizedInput = normalizeLibraryPath(folderPath);
  if (!normalizedInput) {
    return '';
  }

  const isAbsolute = /^(?:[a-zA-Z]:[\\/]|\/|\\\\)/.test(normalizedInput);
  if (!isAbsolute) {
    return normalizedInput.replace(/^[\\/]+/, '');
  }

  const normalizedRoot = normalizeLibraryPath(libraryRootAbsolute);
  if (!normalizedRoot || !isDescendantPath(normalizedInput, normalizedRoot)) {
    return normalizedInput;
  }

  if (normalizedInput === normalizedRoot) {
    return '';
  }

  const relative = getRelativeLibraryPath(normalizedInput, normalizedRoot);
  return normalizeLibraryPath(relative).replace(/^[\\/]+/, '');
}

export type FileSortOrder = LibrarySortOption;

type ChiefOfStaffState = {
  /** Absolute path to the Chief of Staff file (README.md or AGENTS.md) */
  filePath: string | null;
  /** Whether the overview explainer is currently shown in the navigator pane */
  overviewOpen: boolean;
  openOverview: () => void;
  closeOverview: () => void;
  openFolder: () => void;
  askInChat: () => void;
};

type LibraryNavigatorContextValue = {
  isOpen: boolean;
  settings: AppSettings | null;
  lens: LibraryLens;
  browseLens: LibraryLens;
  orientationTipDismissed: boolean;
  setBrowseLens: (next: LibraryLens | ((prev: LibraryLens) => LibraryLens)) => void;
  setEditorLensOverride: (next: LibraryLens | null) => void;
  dismissOrientationTip: () => void;
  loadWorkspaceFile: (filePath: string) => Promise<void>;
  commandShelfProps: LibraryCommandShelfProps;
  bodyState: {
    libraryLoading: boolean;
    libraryError: string | null;
    librarySearchQuery: string;
    librarySearchOutcome?: LibrarySearchOutcome | null;
    libraryTree: FileNode[] | null;
    flattenedFiles?: FlatFileEntry[];
    libraryStats?: LibraryStatsState;
    /** Single source of truth for tree completeness (Bug-2). Consumers read this, not libraryStats.truncated. */
    treePartialState: TreePartialState;
    treeGeneration?: number;
    libraryTreeEmptyMessage: string;
    // Global space filter
    selectedSpaceFilter: string | null;
    setSelectedSpaceFilter: (space: string | null) => void;
    // Skills index data for filter-aware cards/list renderers
    skillsData: SkillsScanResult | null;
    skillsLoading: boolean;
    skillsError: string | null;
    // Memory data for unified search
    memoryEntries: MemoryHistoryEntry[];
    memoryLoading: boolean;
    memoryError: string | null;
    pendingMemoryRequests: PendingMemoryRequest[];
    pendingMemoryLoading: boolean;
    savePendingMemoryRequest: (toolUseId: string) => Promise<void>;
    skipPendingMemoryRequest: (toolUseId: string) => Promise<void>;
    saveAllPendingMemoryRequests: () => Promise<void>;
    skipAllPendingMemoryRequests: () => Promise<void>;
    // Spaces data (Show: Spaces lens)
    spacesData: SpaceInfo[];
    spacesLoading: boolean;
    spacesError: boolean;
    spacesErrorMessage: string | null;
    // Content search
    contentSearchResults: import('../hooks/useLibraryContentSearch').ContentSearchResult[];
    contentSearchLoading: boolean;
    contentSearchError: string | null;
    contentSearchTotalMatches: number;
    contentSearchedFiles: number;
    contentSearchTruncated: boolean;
    contentSearchSelectedIndex: number;
    setContentSearchSelectedIndex: (index: number) => void;
    handleContentSearchSelectResult: (filePath: string, lineNumber?: number) => void;
    searchResultsProps: LibrarySearchResultsProps;
    treeViewProps: LibraryTreeViewProps;
    rootDropZoneState: RootDropZoneState;
    // File sorting and navigation
    fileSortOrder: FileSortOrder;
    setFileSortOrder: (order: LibrarySortOption) => void;
    libraryRootAbsolute: string;
    activePath: string | null;
    navigateToPath: (relativePath: string) => void;
    revealInClassifiedView: (filePath: string) => void;
    setActiveSpace: (spacePath: string) => void;
    renameSpace: (spacePath: string, displayName: string) => Promise<void>;
    deleteSpace: (spacePath: string, displayName: string) => Promise<void>;
    chiefOfStaff: ChiefOfStaffState;
    // Pending folder navigation path (for auto-expanding folders)
    pendingFolderNavigation: string | null;
  };
  recentDrawerProps: LibraryRecentDrawerProps;
  filesAccordion: {
    expanded: boolean;
    toggle: () => void;
  };
  contextMenuState: {
    contextMenu: { x: number; y: number; target: FileNode } | null;
    closeContextMenu: () => void;
    editInContext: () => void;
    createFileInContext: () => void;
    createFolderInContext: () => void;
    startRenaming: () => void;
    copyPath: () => void;
    copyRelativePath: () => void;
    copyAsMarkdownLink: () => void;
    revealInFinder: () => void;
    deleteItem: () => void;
    toggleFavorite: () => void;
    /** Share a file publicly via cloud — only available for files when cloud is active */
    sharePublicly: (() => void) | null;
  };
  /** Absolute paths of favorited/pinned files */
  favoriteFilePaths: string[];
  /** Toggle favorite status for a file path */
  toggleFileFavorite: (filePath: string) => void;
  /** Check if a file path is favorited */
  isFileFavorite: (filePath: string) => boolean;
  createDialogState: {
    createDialog: CreateDialogState;
    createDialogValue: string;
    setCreateDialogValue: (value: string) => void;
    confirmCreate: () => void;
    closeCreateDialog: () => void;
  };
  workspaceDrawerClassName: string;
  navigateToFolder: (folderRelativePath: string) => void;
  showToast: (options: Omit<ToastProps, 'id'>) => string;
  emitLog: EmitLogFn;
  onUseSkill?: (skillRelativePath: string) => void;
  onOpenSession?: (sessionId: string) => void;
  /** Look up example paths for a skill by its relative path */
  getSkillExamplePaths: (skillRelativePath: string) => string[] | undefined;
  /** Look up quality summary for a skill by its relative path */
  getSkillQualityData: (
    skillRelativePath: string
  ) =>
    | {
        qualityScore?: number;
        qualityBand?: 'seedling' | 'growing' | 'solid' | 'exemplary';
        qualityTopImprovement?: { dimension: string; suggestion: string };
      }
    | undefined;
  /** Look up canonical skill metadata for a relative path from the scanned skills index */
  getSkillMetadata: (
    skillRelativePath: string
  ) =>
    | {
        relativePath: string;
        frontmatter?: SkillInfo['frontmatter'];
        source: 'platform' | 'space' | 'workspace';
        sharing?: 'private' | 'restricted' | 'team' | 'company-wide' | 'public';
        storageProvider?: 'google_drive' | 'onedrive' | 'dropbox' | 'box' | 'icloud' | 'local' | 'other';
      }
    | undefined;
  /** Start a new conversation with files attached (for Atlas) */
  onStartConversation?: (message: string, filePaths: string[]) => void;
};

const LibraryNavigatorContext = createContext<LibraryNavigatorContextValue | null>(null);

export const LibraryNavigatorProvider = ({
  open,
  settings,
  refreshSettings,
  showToast,
  emitLog,
  editorDocument,
  loadWorkspaceFile,
  closeEditor,
  onBrowseLensInteraction,
  recentFiles,
  setRecentFiles,
  onUseSkill,
  onCreateSkill,
  onCreateMemory,
  onAddSpace,
  onManageSpaces,
  canCreateAdditionalSpaces,
  createActionPending = false,
  onOpenSession,
  onNavigatorReady,
  onStartConversation,
  onShareFile,
  children
}: LibraryNavigatorProviderProps) => {
  const libraryRootAbsolute = settings?.coreDirectory ?? '';

  const {
    tree: libraryTree,
    treeMetadata,
    setTree: setLibraryTree,
    loading: libraryLoading,
    error: libraryError,
    showHiddenFiles,
    setShowHiddenFiles,
    expandedDirectories,
    setExpandedDirectories,
    loadTree: loadLibraryTreeRaw
  } = useLibraryTree({ emitLog, coreDirectory: settings?.coreDirectory });

  const {
    skillsData,
    loading: skillsLoading,
    error: skillsError,
    refresh: refreshSkills
  } = useSkillsIndex({ enabled: open && Boolean(settings?.coreDirectory) });

  // Memory data for unified search
  const [memoryEntries, setMemoryEntries] = useState<MemoryHistoryEntry[]>([]);
  const [memoryLoading, setMemoryLoading] = useState(false);
  const [memoryError, setMemoryError] = useState<string | null>(null);
  const memoryLoadIdRef = useRef(0);
  const pendingMemoryApprovals = usePendingMemoryApprovals();

  const loadMemoryData = useCallback(async () => {
    const requestId = ++memoryLoadIdRef.current;
    setMemoryLoading(true);
    setMemoryError(null);
    try {
      const collectedEntries: MemoryHistoryEntry[] = [];
      const seenEntryIds = new Set<string>();
      let beforeTimestamp: number | undefined;
      let hasMore = true;
      let safetyIteration = 0;

      while (hasMore && collectedEntries.length < MEMORY_HISTORY_MAX_ENTRIES && safetyIteration < 25) {
        safetyIteration += 1;
        if (requestId !== memoryLoadIdRef.current) {
          return;
        }

        const remaining = MEMORY_HISTORY_MAX_ENTRIES - collectedEntries.length;
        const pageLimit = Math.min(MEMORY_HISTORY_PAGE_SIZE, remaining);
        const collectedBeforePage = collectedEntries.length;
        const result = await window.memoryApi.getHistory({
          limit: pageLimit,
          ...(beforeTimestamp != null ? { beforeTimestamp } : {}),
        });
        if (requestId !== memoryLoadIdRef.current) {
          return;
        }

        if (result.entries.length === 0) {
          break;
        }

        for (const entry of result.entries) {
          if (seenEntryIds.has(entry.id)) {
            continue;
          }
          seenEntryIds.add(entry.id);
          collectedEntries.push(entry);
          if (collectedEntries.length >= MEMORY_HISTORY_MAX_ENTRIES) {
            break;
          }
        }

        hasMore = result.hasMore;
        const oldestEntry = result.entries[result.entries.length - 1];
        if (!oldestEntry || !Number.isFinite(oldestEntry.timestamp)) {
          break;
        }
        const nextBeforeTimestamp = oldestEntry.timestamp;
        if (beforeTimestamp != null && nextBeforeTimestamp >= beforeTimestamp) {
          break;
        }
        if (collectedEntries.length === collectedBeforePage && beforeTimestamp != null) {
          break;
        }
        beforeTimestamp = nextBeforeTimestamp;
      }

      if (requestId !== memoryLoadIdRef.current) {
        return;
      }
      setMemoryEntries(collectedEntries);
    } catch (err) {
      if (requestId !== memoryLoadIdRef.current) {
        return;
      }
      // Memory loading is non-critical, just log and continue
      console.warn('Failed to load memory for unified search:', err);
      setMemoryError(err instanceof Error ? err.message : String(err));
      setMemoryEntries([]);
    } finally {
      if (requestId === memoryLoadIdRef.current) {
        setMemoryLoading(false);
      }
    }
  }, []);

  // Load memory when drawer opens
  useEffect(() => {
    if (open && settings?.coreDirectory) {
      void loadMemoryData();
    }
  }, [open, settings?.coreDirectory, loadMemoryData]);

  useEffect(() => {
    if (!open) {
      memoryLoadIdRef.current += 1;
      setMemoryLoading(false);
    }
  }, [open]);

  // Spaces data for the Show: Spaces lens.
  const {
    spaces: spacesData,
    loading: spacesLoading,
    error: spacesError,
    errorMessage: spacesErrorMessage,
    refresh: refreshSpaces,
  } = useSpacesData(settings?.coreDirectory);

  // Semantic search index status and controls
  const {
    indexStatus,
    refreshIndexStatus,
    startWatching: startIndexWatching,
    pauseWatching: pauseIndexWatching,
    reindex: reindexWorkspace,
    clearIndex: clearSearchIndex
  } = useSemanticSearch();

  // treeGenerationRef tracks the committed tree snapshot generation.
  const treeGenerationRef = useRef(0);
  // requestedTreeGenerationRef tracks the latest started tree refresh generation.
  const requestedTreeGenerationRef = useRef(0);
  // pendingLibraryStatsRef buffers stats until the matching tree generation commits.
  const pendingLibraryStatsRef = useRef<PendingLibraryStats | null>(null);
  const [treeGeneration, setTreeGeneration] = useState(0);
  // Workspace stats (accurate counts, not limited by tree display caps). This state is generation-locked:
  // libraryTree, flattenedFiles, and libraryStats must represent the same treeGeneration snapshot.
  const [libraryStats, setLibraryStats] = useState<LibraryStatsState>(null);

  const refreshLibraryStats = useCallback(async (generation: number, includeHidden: boolean) => {
    if (!open || !libraryRootAbsolute) {
      return;
    }

    try {
      const stats = await window.libraryApi.getStats({ includeHidden });
      if (generation < treeGenerationRef.current) {
        return;
      }
      pendingLibraryStatsRef.current = { generation, state: stats };
      if (generation === treeGenerationRef.current) {
        setLibraryStats(stats);
      }
    } catch (err) {
      emitLog({ level: 'warn', message: `Failed to fetch workspace stats: ${err}` });
      if (generation < treeGenerationRef.current) {
        return;
      }
      pendingLibraryStatsRef.current = { generation, state: 'failed' };
      if (generation === treeGenerationRef.current) {
        setLibraryStats('failed');
      }
    }
  }, [emitLog, libraryRootAbsolute, open]);

  const loadLibraryTree = useCallback(
    async (includeHiddenOverride?: boolean, options?: { resetExpanded?: boolean }) => {
      const includeHidden = includeHiddenOverride ?? showHiddenFiles;
      const generation = requestedTreeGenerationRef.current + 1;
      requestedTreeGenerationRef.current = generation;

      const loadPromise = loadLibraryTreeRaw(includeHiddenOverride, options);
      void refreshLibraryStats(generation, includeHidden);
      await loadPromise;

      if (generation !== requestedTreeGenerationRef.current) {
        return;
      }

      treeGenerationRef.current = generation;
      setTreeGeneration(generation);
      const pendingStats = pendingLibraryStatsRef.current;
      if (pendingStats && pendingStats.generation === generation) {
        setLibraryStats(pendingStats.state);
      } else {
        setLibraryStats('pending');
      }
    },
    [loadLibraryTreeRaw, refreshLibraryStats, showHiddenFiles],
  );

  // Poll index status every 2 seconds when drawer is open (matches old IndexStatusBar behavior)
  useEffect(() => {
    if (!open) return;
    
    const interval = setInterval(() => {
      void refreshIndexStatus();
    }, 2000);
    
    return () => clearInterval(interval);
  }, [open, refreshIndexStatus]);

  // Auto-refresh file tree and skills index when workspace files change
  // (only when drawer is open). Throttled to max once per 3 seconds to avoid
  // excessive refreshes when multiple writes land together.
  const lastAutoRefreshRef = useRef<number>(0);
  useEffect(() => {
    if (!open) return;

    const unsubscribe = window.api.onLibraryChanged(({ affectsTree }) => {
      const now = Date.now();
      // Throttle: skip if refreshed within last 3 seconds
      if (now - lastAutoRefreshRef.current < 3000) return;

      lastAutoRefreshRef.current = now;
      void refreshSkills();

      if (!affectsTree) {
        return;
      }

      // Skip if tree doesn't exist yet (initial load will handle it)
      if (!libraryTree) return;
      // Skip if already loading
      if (libraryLoading) return;

      // Preserve expanded state by not resetting directories
      void loadLibraryTree(undefined, { resetExpanded: false });
    });

    return () => unsubscribe();
  }, [open, libraryTree, libraryLoading, loadLibraryTree, refreshSkills]);

  const [selectedWorkspaceItem, setSelectedWorkspaceItem] = useState<FileNode | null>(null);
  const [focusedPath, setFocusedPath] = useState<string | null>(null);
  const [renamingItem, setRenamingItem] = useState<{ path: string; originalName: string } | null>(null);
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; target: FileNode } | null>(null);
  const [createDialog, setCreateDialog] = useState<CreateDialogState>(null);
  const [createDialogValue, setCreateDialogValue] = useState('');
  const [recentDrawerOpen, setRecentDrawerOpen] = useState(false);
  const [lastRefreshTimestamp, setLastRefreshTimestamp] = useState<number | null>(null);
  const [draggingNode, setDraggingNode] = useState<FileNode | null>(null);
  const [dropTarget, setDropTarget] = useState<LibraryDropTarget>(null);
  const [filesExpanded, setFilesExpanded] = useState(true); // Start expanded - show indexing status by default
  const [indexingPanelExpanded, setIndexingPanelExpanded] = useState(false);
  // Pending folder/file navigation - queued until tree is ready
  // Used for both folder navigation and reveal-in-tree transitions.
  const [pendingFolderNavigation, setPendingFolderNavigation] = useState<string | null>(null);

  // Reset state when Library closes to avoid stale data on reopen
  useEffect(() => {
    if (!open) {
      setIndexingPanelExpanded(false);
      setPendingFolderNavigation(null); // Clear pending navigation when drawer closes
    }
  }, [open]);
  const {
    browseLens,
    effectiveLens,
    orientationTipDismissed,
    setBrowseLens: setBrowseLensRaw,
    setEditorLensOverride,
    dismissOrientationTip,
  } = useLibraryLens();
  const setBrowseLens: LibraryNavigatorContextValue['setBrowseLens'] = useCallback((next) => {
    setBrowseLensRaw(next);
    onBrowseLensInteraction?.();
  }, [onBrowseLensInteraction, setBrowseLensRaw]);

  const resolveRevealRelativePath = useCallback((
    rawPath: string,
    source: 'direct' | 'pending',
  ): string | null => {
    const candidatePath = rawPath.trim();
    if (!candidatePath) return null;

    const isAbsolutePath = /^(?:[a-zA-Z]:[\\/]|\/|\\\\)/.test(candidatePath);
    if (!isAbsolutePath) {
      return candidatePath.replace(/^[\\/]+/, '');
    }

    const workspaceRoot = libraryRootAbsolute || null;
    if (!workspaceRoot || !isDescendantPath(candidatePath, workspaceRoot)) {
      emitLog({
        level: 'warn',
        message: '[library] Reveal target is outside workspace; ignoring',
        context: {
          path: candidatePath,
          workspaceRoot,
          source,
        },
        timestamp: Date.now(),
      });
      showToast({ title: "Can't reveal files outside your Library." });
      return null;
    }

    return getRelativeLibraryPath(candidatePath, workspaceRoot);
  }, [emitLog, libraryRootAbsolute, showToast]);
  // Global space filter - applies across Skills, Memory, and Files views
  const [selectedSpaceFilter, setSelectedSpaceFilter] = useState<string | null>(null);
  // Shared view sorting across lens views.
  const [fileSortOrder, setFileSortOrderState] = useState<LibrarySortOption>('name');
  const setFileSortOrder = useCallback((order: LibrarySortOption) => {
    setFileSortOrderState(order);
    if (order === 'name' || order === 'modified') {
      tracking.library.fileSortChanged(order);
    }
  }, []);
  // Profile editor state — when true, the Library body shows the ProfileEditor instead of the active view
  const [chiefOfStaffOverviewOpen, setChiefOfStaffOverviewOpen] = useState(false);
  const [, setProfileCompletionPercent] = useState(0);
  const wasOpenRef = useRef(false);
  const lastTreeLoadCoreDirectoryRef = useRef<string | null>(null);
  const onSearchSelectRef = useRef<((node: FileNode) => void) | null>(null);

  const libraryRootPath = useMemo(() => normalizeLibraryPath(libraryRootAbsolute), [libraryRootAbsolute]);
  const spaceRoots = useMemo(() => {
    const roots = new Set<string>();
    const addRoot = (candidate: unknown) => {
      if (typeof candidate !== 'string') return;
      const normalized = normalizeLibraryPath(candidate);
      if (normalized) {
        roots.add(normalized);
      }
    };
    for (const space of spacesData) {
      addRoot(space.absolutePath);
      addRoot(space.sourcePath);
    }
    return Array.from(roots);
  }, [spacesData]);

  // Handle cross-feature navigation (from The Spark)
  const { pendingLibraryNavigation, clearPendingLibraryNavigation } = useFlowPanels();

  useEffect(() => {
    const justOpened = open && !wasOpenRef.current;
    wasOpenRef.current = open;
    const activeCoreDirectory = libraryRootAbsolute || null;
    const coreDirectoryChanged = lastTreeLoadCoreDirectoryRef.current !== activeCoreDirectory;

    if (!open || (libraryLoading && !coreDirectoryChanged)) {
      return undefined;
    }

    // Skip if tree exists and drawer didn't just open (avoid redundant loads)
    if (libraryTree && !justOpened && !coreDirectoryChanged) {
      return undefined;
    }

    // Load tree immediately without delay. The loadLibraryTree function sets loading=true
    // at the start, which prevents the "No visible files" flash.
    // Reset expanded directories on initial load only.
    lastTreeLoadCoreDirectoryRef.current = activeCoreDirectory;
    void loadLibraryTree(undefined, { resetExpanded: true });

    return undefined;
    // Note: libraryLoading is intentionally excluded from deps to prevent re-triggering
    // the effect when loading state changes. The tree existence check handles reload prevention.
    // eslint-disable-next-line react-hooks/exhaustive-deps -- intentional: omitting libraryLoading so load completion does not retrigger tree reloads
  }, [open, libraryRootAbsolute, libraryTree, loadLibraryTree]);

  useEffect(() => {
    if (!open || !libraryRootAbsolute) {
      const nextGeneration = requestedTreeGenerationRef.current + 1;
      requestedTreeGenerationRef.current = nextGeneration;
      treeGenerationRef.current = nextGeneration;
      pendingLibraryStatsRef.current = null;
      setTreeGeneration(nextGeneration);
      setLibraryStats(null);
    }
  }, [libraryRootAbsolute, open]);

  // Apply pending workspace navigation (from cross-feature navigation)
  // This is split into two effects to handle the timing issue:
  // 1. First effect: Set lens/filter state and queue folder navigation
  // 2. Second effect (pendingFolderNavigation): Execute expansion after tree renders
  useEffect(() => {
    if (!open || !pendingLibraryNavigation) return;

    const nextLens: LibraryLens = {
      filter: pendingLibraryNavigation.lens.filter ?? browseLens.filter,
      view: pendingLibraryNavigation.lens.view ?? browseLens.view,
    };
    const filterChanged = nextLens.filter !== browseLens.filter;
    const viewChanged = nextLens.view !== browseLens.view;
    if (filterChanged || viewChanged) {
      tracking.library.lensChanged({
        filter: nextLens.filter,
        view: nextLens.view,
        axis: filterChanged && viewChanged ? 'both' : (filterChanged ? 'filter' : 'view'),
      });
    }
    setBrowseLens(nextLens);

    const pendingFolderPath = pendingLibraryNavigation.folderPath ?? null;
    const normalizedPendingFolderPath = pendingFolderPath
      ? (pendingLibraryNavigation.revealInTree
        ? resolveRevealRelativePath(pendingFolderPath, 'pending')
        : normalizePendingFolderPath(
          pendingFolderPath,
          libraryRootAbsolute,
        ))
      : null;

    if (pendingLibraryNavigation.revealInTree && pendingFolderPath && normalizedPendingFolderPath) {
      const classification = getRevealClassification(
        {
          path: pendingFolderPath,
          relativePath: normalizedPendingFolderPath,
        },
        spaceRoots,
      );
      setEditorLensOverride(classification.lens);
    }

    // Close ChiefOfStaffOverview when navigating (it would block the Files view)
    setChiefOfStaffOverviewOpen(false);

    // Apply space filter if specified
    if (pendingLibraryNavigation.spaceFilter !== undefined) {
      setSelectedSpaceFilter(pendingLibraryNavigation.spaceFilter || null);
    }

    // Handle folder navigation if specified - queue it for the pendingFolderNavigation effect
    if (normalizedPendingFolderPath) {
      setFilesExpanded(true);
      setPendingFolderNavigation(normalizedPendingFolderPath);
    }

    // Handle indexing panel expansion if specified (e.g., from Settings "Manage indexing" button)
    if (pendingLibraryNavigation.expandIndexingPanel) {
      setIndexingPanelExpanded(true);
      setFilesExpanded(true);
    }

    // Clear the pending cross-feature navigation
    clearPendingLibraryNavigation();
  }, [
    browseLens.filter,
    browseLens.view,
    clearPendingLibraryNavigation,
    libraryRootAbsolute,
    open,
    pendingLibraryNavigation,
    resolveRevealRelativePath,
    setBrowseLens,
    setEditorLensOverride,
    spaceRoots,
  ]);

  const normalizedRecentFiles = useMemo(() => recentFiles ?? [], [recentFiles]);

  // Single-snapshot invariant: libraryTree, flattenedFiles, and libraryStats are all
  // tied to treeGeneration. Consumers should read them from the same render frame.
  // Also derive flattenedFiles from this provider's libraryTree snapshot only (never
  // from a separate useLibraryIndex instance).
  const flattenedFiles = useMemo(() => {
    if (!libraryTree || libraryTree.length === 0) {
      return [];
    }
    return flattenFileTree(libraryTree);
  }, [libraryTree]);

  const filePathMap = useMemo(() => createPathMap(flattenedFiles), [flattenedFiles]);

  const facetTreeEntries = useMemo(
    () => flattenedFiles.map((entry) => ({
      path: entry.node.path,
      relativePath: getRelativeLibraryPath(entry.node.path, libraryRootAbsolute),
      kind: entry.node.kind,
      skillMeta: entry.skillMeta,
    })),
    [flattenedFiles, libraryRootAbsolute],
  );

  const recentFileNodes = useMemo(() => {
    return normalizedRecentFiles
      .map((filePath) => filePathMap.get(filePath))
      .filter((node): node is FileNode => Boolean(node))
      .slice(0, 10);
  }, [normalizedRecentFiles, filePathMap]);

  const hasRecentFiles = recentFileNodes.length > 0;

  // Single source of truth for tree completeness (Bug-2 safety invariant — every
  // consumer reads this, not the separate 1M-cap stats walk). `isPartialTree` is
  // 'unknown' until metadata arrives so empty states don't wrongly claim "complete".
  // treeMetadata is already generation-gated by useLibraryTree (only returned for
  // the current core directory), so it stays tied to the same snapshot as libraryTree.
  const treePartialState = useMemo<TreePartialState>(() => {
    if (!treeMetadata) {
      return { isPartialTree: 'unknown', reasons: [], unavailableNodes: 0 };
    }
    return {
      isPartialTree: treeMetadata.truncated,
      reasons: treeMetadata.reasons,
      unavailableNodes: treeMetadata.unavailableNodes,
    };
  }, [treeMetadata]);

  useEffect(() => {
    if (!hasRecentFiles && recentDrawerOpen) {
      setRecentDrawerOpen(false);
    }
  }, [hasRecentFiles, recentDrawerOpen]);

  const {
    query: librarySearchQuery,
    results: workspaceSearchResults,
    truncated: workspaceSearchTruncated,
    searchOutcome: librarySearchOutcome,
    selectedIndex: searchSelectedIndex,
    setSelectedIndex: setSearchSelectedIndex,
    handleQueryChange: handleWorkspaceSearchQueryChange,
    clearSearch: clearWorkspaceSearch
  } = useLibrarySearch({
    files: flattenedFiles,
    emitLog,
    onSelect: (result) => onSearchSelectRef.current?.(result.node),
  });

  // Content search (grep-like)
  const handleContentSearchSelectFile = useCallback((filePath: string, _lineNumber?: number) => {
    if (isEditableWorkspaceFile(filePath)) {
      // Track file open from search
      const ext = filePath.split('.').pop() ?? '';
      tracking.library.fileOpened(ext, 'search');
      void loadWorkspaceFile(filePath);
    }
  }, [loadWorkspaceFile]);

  const {
    query: _contentSearchQuery,
    results: contentSearchResults,
    loading: contentSearchLoading,
    error: contentSearchError,
    totalMatches: contentSearchTotalMatches,
    searchedFiles: contentSearchedFiles,
    truncated: contentSearchTruncated,
    selectedResultIndex: contentSearchSelectedIndex,
    setSelectedResultIndex: setContentSearchSelectedIndex,
    handleQueryChange: _handleContentSearchQueryChange,
    handleKeyDown: _handleContentSearchKeyDown,
    handleSelectResult: handleContentSearchSelectResult,
    clearSearch: _clearContentSearch,
  } = useLibraryContentSearch({
    emitLog,
    onSelectFile: handleContentSearchSelectFile,
  });

  // Unified search handlers - all scopes use the same query
  const handleSearchChange = useCallback((value: string) => {
    handleWorkspaceSearchQueryChange(value);
  }, [handleWorkspaceSearchQueryChange]);

  // Current search query (same for all scopes)
  const currentSearchQuery = librarySearchQuery;

  const toggleDirectoryExpansion = useCallback((path: string) => {
    setExpandedDirectories((prev) => {
      const next = { ...prev };
      if (next[path]) {
        delete next[path];
      } else {
        next[path] = true;
      }
      return next;
    });
  }, [setExpandedDirectories]);

  const expandDirectories = useCallback((paths: readonly string[]) => {
    if (paths.length === 0) return;
    setExpandedDirectories((prev) => {
      let didChange = false;
      const next = { ...prev };
      for (const path of paths) {
        if (!path || next[path]) continue;
        next[path] = true;
        didChange = true;
      }
      return didChange ? next : prev;
    });
  }, [setExpandedDirectories]);

  /**
   * IMPORTANT: Path format for workspace tree navigation
   * 
   * When navigating/highlighting files in the workspace tree, paths must match the format
   * used by `node.path` (from main process fileTreeService.ts), which uses NATIVE OS separators:
   * - macOS/Linux: forward slashes (/)
   * - Windows: backslashes (\)
   * 
   * This affects:
   * - `expandedDirectories` keys: must match `node.path` exactly for expansion to work
   * - `data-path` attributes: set from `node.path`, must match for querySelector to find elements
   * - CSS selectors: use `CSS.escape()` to handle special characters in paths
   * - Scroll container: `[data-testid="library-tree"]` IS the scrollable element (not its parent)
   * 
   * Use `joinWorkspaceAbsolute()` to build paths that match this format.
   */
  const joinWorkspaceAbsolute = useCallback((root: string, relativePath: string): string => {
    // Detect native separator from the root path (Windows uses backslash)
    const sep = root.includes('\\') ? '\\' : '/';
    const cleanRoot = root.replace(/[\\/]+$/, '');
    const segments = relativePath.split(/[/\\]+/).filter(Boolean);
    return [cleanRoot, ...segments].join(sep);
  }, []);

  const expandToPath = useCallback((relativePath: string) => {
    if (!libraryRootAbsolute || !relativePath) return;

    const segments = relativePath.split(/[/\\]+/).filter(Boolean);
    const pathsToExpand: Record<string, boolean> = {};

    // Build expansion keys using native separators to match node.path format
    const sep = libraryRootAbsolute.includes('\\') ? '\\' : '/';
    let currentPath = libraryRootAbsolute.replace(/[\\/]+$/, '');
    for (const segment of segments) {
      currentPath = `${currentPath}${sep}${segment}`;
      pathsToExpand[currentPath] = true;
    }

    setExpandedDirectories((prev) => ({ ...prev, ...pathsToExpand }));
  }, [libraryRootAbsolute, setExpandedDirectories]);

  // Scroll the tree to reveal a pending file/folder target.
  const scrollTreeToPath = useCallback((relativePath: string) => {
    if (!libraryRootAbsolute || !relativePath) return;
    
    // Build absolute path with native separators to match data-path attribute
    const absolutePath = joinWorkspaceAbsolute(libraryRootAbsolute, relativePath);
    
    const findAndScroll = () => {
      if (typeof document === 'undefined') return false;
      const scrollContainer = document.querySelector('[data-testid="library-tree"]') as HTMLElement | null;
      if (!scrollContainer) return false;

      const selector = `[data-path="${CSS.escape(absolutePath)}"]`;
      const el = scrollContainer.querySelector(selector) as HTMLElement | null;
      if (!el) return false;

      // Calculate position to center the element in the scroll container
      const containerRect = scrollContainer.getBoundingClientRect();
      const elRect = el.getBoundingClientRect();
      const scrollTop = scrollContainer.scrollTop + (elRect.top - containerRect.top) - (containerRect.height / 2) + (elRect.height / 2);
      scrollContainer.scrollTo({ top: Math.max(0, scrollTop), behavior: 'smooth' });
      return true;
    };
    
    // Wait for the tree to render with expanded nodes
    let attempts = 0;
    const maxAttempts = 10;
    const attemptScroll = () => {
      attempts++;
      if (findAndScroll()) return;
      if (attempts < maxAttempts) {
        setTimeout(attemptScroll, 100);
      }
    };
    
    window.requestAnimationFrame(() => {
      setTimeout(attemptScroll, 50);
    });
  }, [libraryRootAbsolute, joinWorkspaceAbsolute]);

  const handleSkillFolderNavigate = useCallback((folderRelativePath: string) => {
    try {
      // Switch to folders so the navigation target is visible.
      setBrowseLens({ filter: 'spaces', view: 'folders' });
      // Clear any active search query
      clearWorkspaceSearch();
      // Ensure the files accordion is expanded so the user can see the navigation result
      setFilesExpanded(true);
      // Queue the folder navigation - it will execute once the tree is loaded
      setPendingFolderNavigation(folderRelativePath);
    } catch (error) {
      console.error('Error navigating to folder:', error);
      showToast({ title: `Failed to navigate to folder: ${folderRelativePath}` });
    }
  }, [clearWorkspaceSearch, setBrowseLens, showToast]);

  const revealInTree = useCallback((filePath: string) => {
    const candidatePath = filePath.trim();
    if (!candidatePath) return;

    const targetRelativePath = resolveRevealRelativePath(candidatePath, 'direct');
    if (!targetRelativePath) {
      return;
    }

    const classification = getRevealClassification(
      {
        path: candidatePath,
        relativePath: targetRelativePath,
      },
      spaceRoots,
    );

    clearWorkspaceSearch();
    setChiefOfStaffOverviewOpen(false);
    setFilesExpanded(true);
    setEditorLensOverride(classification.lens);
    setPendingFolderNavigation(targetRelativePath);
  }, [clearWorkspaceSearch, resolveRevealRelativePath, setEditorLensOverride, spaceRoots]);

  const handleSetActiveSpace = useCallback((spacePath: string) => {
    if (!spacePath) return;
    setSelectedSpaceFilter(spacePath);
    handleSkillFolderNavigate(spacePath);
  }, [handleSkillFolderNavigate]);

  const handleRenameSpace = useCallback(async (spacePath: string, displayName: string) => {
    const matchingSpace = spacesData.find((space) => (
      space.path === spacePath || space.absolutePath === spacePath
    ));
    const targetSpacePath = matchingSpace?.path ?? spacePath;
    const initialName = displayName.trim() || matchingSpace?.displayName || matchingSpace?.name || 'Space';
    const nextName = window.prompt(`Rename "${initialName}"`, initialName)?.trim();
    if (!nextName || nextName === initialName) {
      return;
    }

    try {
      const result = await window.libraryApi.renameSpace({ spacePath: targetSpacePath, newName: nextName });
      if (!result.success) {
        throw new Error(result.error ?? 'Failed to rename space');
      }
      showToast({ title: `Renamed space to ${nextName}` });
      await Promise.all([
        loadLibraryTree(undefined, { resetExpanded: false }),
        refreshSpaces(),
      ]);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      emitLog({
        level: 'warn',
        message: 'Failed to rename space from Library cards',
        context: { spacePath: targetSpacePath, error: errorMessage },
        timestamp: Date.now(),
      });
      showToast({ title: `Couldn't rename space: ${errorMessage}` });
    }
  }, [emitLog, loadLibraryTree, refreshSpaces, showToast, spacesData]);

  const handleDeleteSpace = useCallback(async (spacePath: string, displayName: string) => {
    const matchingSpace = spacesData.find((space) => (
      space.path === spacePath || space.absolutePath === spacePath
    ));
    const targetSpacePath = matchingSpace?.path ?? spacePath;
    const label = displayName.trim() || matchingSpace?.displayName || matchingSpace?.name || targetSpacePath;
    const isSymlinkSpace = matchingSpace?.isSymlink ?? true;
    const confirmed = window.confirm(
      isSymlinkSpace
        ? `Remove space "${label}" from Spaces? This only removes the link in Rebel. Your files stay where they are.`
        : `Delete space "${label}" from your Library? This removes the folder and files inside it.`,
    );
    if (!confirmed) {
      return;
    }

    try {
      const result = await window.libraryApi.removeSpace({
        spacePath: targetSpacePath,
        removeSymlinkOnly: isSymlinkSpace,
      });
      if (!result.success) {
        throw new Error(result.error ?? 'Failed to remove space');
      }
      if (selectedSpaceFilter === targetSpacePath) {
        setSelectedSpaceFilter(null);
      }
      showToast({ title: `Removed space: ${label}` });
      await Promise.all([
        loadLibraryTree(undefined, { resetExpanded: false }),
        refreshSpaces(),
      ]);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      emitLog({
        level: 'warn',
        message: 'Failed to remove space from Library cards',
        context: { spacePath: targetSpacePath, error: errorMessage },
        timestamp: Date.now(),
      });
      showToast({ title: `Couldn't remove space: ${errorMessage}` });
    }
  }, [emitLog, loadLibraryTree, refreshSpaces, selectedSpaceFilter, showToast, spacesData]);

  // Reset to opening state: close editor, restore default browse lens (Show: Skills × Folders), clear search/filters
  const resetToOpeningState = useCallback(() => {
    closeEditor();
    setBrowseLens({ filter: 'skills', view: 'folders' });
    clearWorkspaceSearch();
    setSelectedSpaceFilter(null);
    setChiefOfStaffOverviewOpen(false);
    setFilesExpanded(true);
    setPendingFolderNavigation(null); // Clear any pending folder navigation
  }, [closeEditor, clearWorkspaceSearch, setBrowseLens]);

  // Expose navigation and reset functions to parent via callback
  useEffect(() => {
    if (onNavigatorReady) {
      onNavigatorReady({ 
        navigateToFolder: handleSkillFolderNavigate,
        revealInTree,
        resetToOpeningState
      });
    }
  }, [onNavigatorReady, handleSkillFolderNavigate, revealInTree, resetToOpeningState]);

  // Execute pending folder/file navigation once tree is ready.
  useEffect(() => {
    if (!pendingFolderNavigation) return;
    
    // Wait for drawer to open
    if (!open) return;
    
    // Wait for tree to load
    if (!libraryTree || libraryTree.length === 0) return;
    if (!libraryRootAbsolute) return;

    try {
      // Ensure files accordion is expanded
      setFilesExpanded(true);
      // Expand nested directories in the provider's expandedDirectories state.
      expandToPath(pendingFolderNavigation);
      scrollTreeToPath(pendingFolderNavigation);
      
      // Highlight the target item by setting it as selected
      // Look up in filePathMap to determine if it's a file or folder
      const absolutePath = joinWorkspaceAbsolute(libraryRootAbsolute, pendingFolderNavigation);
      const itemName = pendingFolderNavigation.split(/[/\\]/).pop() || pendingFolderNavigation;
      const existingNode = filePathMap.get(absolutePath);
      // If the reveal target isn't in the tree AND the tree is a partial view, be
      // honest: it may simply not be loaded rather than a directory we can reveal.
      // (Bug-2 — don't silently default a missing node to a directory.)
      if (!existingNode && treePartialState.isPartialTree === true) {
        showToast({ title: "That file isn't loaded in this partial Library. Try a smaller Library folder." });
        emitLog({
          level: 'info',
          message: '[library] Reveal target absent from partial tree',
          context: { path: absolutePath, reasons: treePartialState.reasons },
          timestamp: Date.now(),
        });
        // Be honest: the target genuinely isn't in this partial view. Stop the
        // reveal workflow rather than synthesizing a directory selection that
        // acts as though we found it. (Codex F1 — clear pending nav and bail
        // BEFORE the synthetic selection.) A present node (existingNode found)
        // still reveals normally below; a genuinely-absent path in a COMPLETE
        // tree keeps its prior behaviour.
        setPendingFolderNavigation(null);
        return;
      }
      const itemKind = existingNode?.kind ?? 'directory'; // Default to directory if not found
      setSelectedWorkspaceItem({ kind: itemKind, path: absolutePath, name: itemName });
    } catch (error) {
      console.error('[LibraryNav] Error during folder/file navigation:', error);
    }

    setPendingFolderNavigation(null);
  }, [pendingFolderNavigation, open, libraryTree, libraryRootAbsolute, expandToPath, scrollTreeToPath, joinWorkspaceAbsolute, filePathMap, treePartialState, showToast, emitLog]);

  // Per Lens Transition State Machine (F11): when the editor closes (no document
  // loaded), the editorLensOverride must be cleared so the user returns to the
  // browseLens they had before opening the file.
  useEffect(() => {
    if (editorDocument === null) {
      setEditorLensOverride(null);
    }
  }, [editorDocument, setEditorLensOverride]);

  const handleWorkspaceItemClick = useCallback(
    (node: FileNode, event?: React.MouseEvent) => {
      if (!node) return;
      if (event && (event.target as HTMLElement).tagName === 'INPUT') {
        return;
      }

      setSelectedWorkspaceItem(node);

      if (node.kind === 'directory') {
        toggleDirectoryExpansion(node.path);
        return;
      }
      if (isEditableWorkspaceFile(node.path) || isPreviewablePath(node.path)) {
        if (editorDocument && editorDocument.isDirty && editorDocument.path !== node.path) {
          const proceed = window.confirm('You have unsaved changes. Continue and open this file?');
          if (!proceed) {
            return;
          }
        }
        // Track file open from tree navigation
        const ext = node.path.split('.').pop() ?? '';
        tracking.library.fileOpened(ext, 'tree');
        void loadWorkspaceFile(node.path);
      } else {
        void window.appApi.openPath(node.path);
      }
    },
    [editorDocument, loadWorkspaceFile, toggleDirectoryExpansion]
  );

  // Update the ref so the search hook can call the latest handler
  onSearchSelectRef.current = handleWorkspaceItemClick;

  const handleSelectSearchResult = useCallback(
    (node: FileNode) => {
      handleWorkspaceItemClick(node);
    },
    [handleWorkspaceItemClick]
  );

  const handleHoverSearchResult = useCallback((index: number) => {
    setSearchSelectedIndex(index);
  }, [setSearchSelectedIndex]);

  const searchResultsProps = useMemo<LibrarySearchResultsProps>(() => ({
    results: workspaceSearchResults,
    truncated: workspaceSearchTruncated,
    isPartialTree: treePartialState.isPartialTree === true,
    selectedIndex: searchSelectedIndex,
    editorPath: editorDocument?.path ?? null,
    workspaceRoot: libraryRootAbsolute,
    query: librarySearchQuery,
    onSelectResult: handleSelectSearchResult,
    onHoverResult: handleHoverSearchResult,
  }), [
    editorDocument?.path,
    handleHoverSearchResult,
    handleSelectSearchResult,
    libraryRootAbsolute,
    librarySearchQuery,
    searchSelectedIndex,
    treePartialState.isPartialTree,
    workspaceSearchTruncated,
    workspaceSearchResults,
  ]);

  const openCreateDialog = useCallback((type: 'file' | 'folder', parentNode?: FileNode) => {
    setCreateDialog({ type, parentNode });
    setCreateDialogValue('');
  }, []);

  const closeCreateDialog = useCallback(() => {
    setCreateDialog(null);
    setCreateDialogValue('');
  }, []);

  const confirmCreate = useCallback(async () => {
    if (!createDialog || !createDialogValue.trim()) return;

    const name = createDialogValue.trim();
    const { type, parentNode } = createDialog;

    try {
      const parentPath = parentNode ? parentNode.path : undefined;

      let createdPath: string;
      if (type === 'file') {
        const result = await window.libraryApi.createFile({ parentPath, fileName: name });
        createdPath = result.path;
      } else {
        const result = await window.libraryApi.createFolder({ parentPath, folderName: name });
        createdPath = result.path;
      }

      if (parentNode && parentNode.kind === 'directory') {
        setExpandedDirectories((prev) => ({ ...prev, [parentNode.path]: true }));
      }

      setLibraryTree(null);
      closeCreateDialog();

      // Wait for tree to reload, then navigate to the new item
      await loadLibraryTree();

      // Navigate to the newly created item
      if (createdPath && libraryRootAbsolute) {
        const relativePath = getRelativeLibraryPath(createdPath, libraryRootAbsolute);
        if (relativePath) {
          setFilesExpanded(true);
          expandToPath(relativePath);
          scrollTreeToPath(relativePath);
        }
      }
    } catch (error) {
      showToast({ title: `Failed to create ${type}: ${error instanceof Error ? error.message : String(error)}` });
      emitLog({
        level: 'error',
        message: `Failed to create library ${type}`,
        context: { error: error instanceof Error ? error.message : String(error) },
        timestamp: Date.now()
      });
    }
  }, [closeCreateDialog, createDialog, createDialogValue, emitLog, expandToPath, loadLibraryTree, scrollTreeToPath, setExpandedDirectories, setLibraryTree, showToast, libraryRootAbsolute]);

  const handleConfirmCreate = useCallback(() => {
    void confirmCreate();
  }, [confirmCreate]);

  const createNewFile = useCallback(
    (parentNode?: FileNode) => {
      openCreateDialog('file', parentNode);
    },
    [openCreateDialog]
  );

  const createNewFolder = useCallback(
    (parentNode?: FileNode) => {
      openCreateDialog('folder', parentNode);
    },
    [openCreateDialog]
  );

  const handleCreateFile = useCallback(() => {
    const parentNode = selectedWorkspaceItem?.kind === 'directory' ? selectedWorkspaceItem : undefined;
    createNewFile(parentNode);
    tracking.library.createFileClicked();
  }, [createNewFile, selectedWorkspaceItem]);

  const handleCreateFolder = useCallback(() => {
    const parentNode = selectedWorkspaceItem?.kind === 'directory' ? selectedWorkspaceItem : undefined;
    createNewFolder(parentNode);
    tracking.library.createFolderClicked();
  }, [createNewFolder, selectedWorkspaceItem]);

  const handleToggleHiddenFiles = useCallback(() => {
    const next = !showHiddenFiles;
    setShowHiddenFiles(next);
    setLibraryTree(null);
    void loadLibraryTree(next);
  }, [loadLibraryTree, setShowHiddenFiles, setLibraryTree, showHiddenFiles]);

  const handleRefreshWorkspace = useCallback(() => {
    setLibraryTree(null);
    void loadLibraryTree();
  }, [loadLibraryTree, setLibraryTree]);

  const closeContextMenu = useCallback(() => {
    setContextMenu(null);
  }, []);

  const handleWorkspaceContextMenu = useCallback((event: React.MouseEvent, node: FileNode) => {
    event.preventDefault();
    event.stopPropagation();
    setContextMenu({ x: event.clientX, y: event.clientY, target: node });
  }, []);

  useEffect(() => {
    const handleClickOutside = () => {
      if (contextMenu) {
        closeContextMenu();
      }
    };

    if (contextMenu) {
      document.addEventListener('click', handleClickOutside);
      return () => document.removeEventListener('click', handleClickOutside);
    }
    return undefined;
  }, [contextMenu, closeContextMenu]);

  useEffect(() => {
    if (libraryTree) {
      setLastRefreshTimestamp(Date.now());
    }
  }, [libraryTree]);

  const handleTreeItemDragStart = useCallback(
    (event: React.DragEvent<HTMLDivElement>, node: FileNode) => {
      if (!libraryRootAbsolute || renamingItem?.path === node.path) {
        event.preventDefault();
        return;
      }
      event.stopPropagation();
      setDraggingNode(node);
      setDropTarget(null);
      event.dataTransfer.effectAllowed = 'move';
      event.dataTransfer.setData('text/plain', node.path);
    },
    [renamingItem?.path, libraryRootAbsolute]
  );

  const canDropOnNode = useCallback(
    (targetNode: FileNode) => {
      if (!draggingNode || !libraryRootPath) {
        return false;
      }
      if (targetNode.kind !== 'directory') {
        return false;
      }
      const targetNormalized = normalizeLibraryPath(targetNode.path);
      const draggedNormalized = normalizeLibraryPath(draggingNode.path);
      if (!targetNormalized || !draggedNormalized) {
        return false;
      }
      if (targetNormalized === draggedNormalized) {
        return false;
      }
      if (isDescendantPath(targetNormalized, draggedNormalized)) {
        return false;
      }
      const parentPath = getParentDirectoryPath(draggingNode.path, libraryRootPath);
      const parentNormalized = parentPath ? normalizeLibraryPath(parentPath) : null;
      if (parentNormalized && parentNormalized === targetNormalized) {
        return false;
      }
      return true;
    },
    [draggingNode, libraryRootPath]
  );

  const moveNodeToDestination = useCallback(
    async (source: FileNode, destinationPath: string) => {
      if (!destinationPath) {
        return;
      }
      const normalizedDestination = normalizeLibraryPath(destinationPath);
      const parentPath = getParentDirectoryPath(source.path, libraryRootPath);
      const parentNormalized = parentPath ? normalizeLibraryPath(parentPath) : null;
      if (parentNormalized && normalizedDestination === parentNormalized) {
        setDraggingNode(null);
        setDropTarget(null);
        return;
      }
      try {
        await window.libraryApi.moveItem({ itemPath: source.path, targetDirectoryPath: destinationPath });
        setLibraryTree(null);
        setExpandedDirectories((prev) => ({ ...prev, [destinationPath]: true }));
        void loadLibraryTree();
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        showToast({ title: `Failed to move item: ${message}` });
        emitLog({
          level: 'error',
          message: 'Failed to move library item',
          context: { sourcePath: source.path, destinationPath, error: message },
          timestamp: Date.now()
        });
      } finally {
        setDraggingNode(null);
        setDropTarget(null);
      }
    },
    [emitLog, loadLibraryTree, setExpandedDirectories, setLibraryTree, showToast, libraryRootPath]
  );

  const handleTreeItemDragOver = useCallback(
    (event: React.DragEvent<HTMLDivElement>, node: FileNode) => {
      if (!draggingNode) return;
      event.preventDefault();
      if (node.kind !== 'directory') {
        setDropTarget((current) => (current?.kind === 'directory' && current.path === node.path ? current : null));
        event.dataTransfer.dropEffect = 'none';
        return;
      }
      const valid = canDropOnNode(node);
      setDropTarget({ kind: 'directory', path: node.path, isValid: valid });
      event.dataTransfer.dropEffect = valid ? 'move' : 'none';
    },
    [canDropOnNode, draggingNode]
  );

  const handleTreeItemDrop = useCallback(
    (event: React.DragEvent<HTMLDivElement>, node: FileNode) => {
      if (!draggingNode) return;
      event.preventDefault();
      const valid = canDropOnNode(node);
      if (!valid) {
        setDropTarget(null);
        setDraggingNode(null);
        return;
      }
      void moveNodeToDestination(draggingNode, node.path);
    },
    [canDropOnNode, draggingNode, moveNodeToDestination]
  );

  const handleTreeItemDragLeave = useCallback(
    (event: React.DragEvent<HTMLDivElement>, node: FileNode) => {
      if (dropTarget?.kind !== 'directory' || dropTarget.path !== node.path) {
        return;
      }
      const nextTarget = event.relatedTarget as Node | null;
      if (nextTarget && event.currentTarget.contains(nextTarget)) {
        return;
      }
      setDropTarget(null);
    },
    [dropTarget]
  );

  const handleTreeItemDragEnd = useCallback(() => {
    setDraggingNode(null);
    setDropTarget(null);
  }, []);

  const rootDropZoneState = useMemo<RootDropZoneState>(() => ({
    visible: Boolean(draggingNode && libraryRootAbsolute),
    isActive: dropTarget?.kind === 'root' && dropTarget.isValid,
    isInvalid: dropTarget?.kind === 'root' && !dropTarget.isValid,
    onDragOver: (event) => {
      if (!draggingNode) return;
      event.preventDefault();
      const parentPath = getParentDirectoryPath(draggingNode.path, libraryRootPath);
      const parentNormalized = parentPath ? normalizeLibraryPath(parentPath) : null;
      const rootNormalized = libraryRootPath;
      const isValid = Boolean(parentNormalized && rootNormalized && parentNormalized !== rootNormalized);
      setDropTarget({ kind: 'root', isValid });
      event.dataTransfer.dropEffect = isValid ? 'move' : 'none';
    },
    onDrop: (event) => {
      if (!draggingNode) return;
      event.preventDefault();
      const parentPath = getParentDirectoryPath(draggingNode.path, libraryRootPath);
      const parentNormalized = parentPath ? normalizeLibraryPath(parentPath) : null;
      const rootNormalized = libraryRootPath;
      const isValid = Boolean(parentNormalized && rootNormalized && parentNormalized !== rootNormalized);
      setDropTarget(null);
      if (!isValid) {
        setDraggingNode(null);
        showToast({ title: 'Item is already in the Library root.' });
        return;
      }
      void moveNodeToDestination(draggingNode, libraryRootAbsolute);
    },
    onDragLeave: (event) => {
      const nextTarget = event.relatedTarget as Node | null;
      if (nextTarget && event.currentTarget.contains(nextTarget)) {
        return;
      }
      if (dropTarget?.kind === 'root') {
        setDropTarget(null);
      }
    }
  }), [
    draggingNode,
    dropTarget,
    libraryRootAbsolute,
    libraryRootPath,
    moveNodeToDestination,
    showToast,
  ]);

  // Use accurate stats when available, fall back to tree count during initial load
  const filesLabel = useMemo(() => {
    if (libraryStats && typeof libraryStats === 'object') {
      const total = libraryStats.totalFiles + libraryStats.totalDirs;
      const suffix = libraryStats.truncated ? '+' : '';
      return `${total.toLocaleString()}${suffix} items`;
    }
    if (libraryTree) {
      return `${flattenedFiles.length.toLocaleString()} items`;
    }
    return '— items';
  }, [libraryStats, libraryTree, flattenedFiles.length]);

  // Index status label - shows actual indexed count from semantic search
  const indexedFilesLabel = useMemo(() => {
    if (!indexStatus) return '— files';
    const { indexedFiles, pendingFiles, totalFiles, indexState } = indexStatus;
    if (pendingFiles > 0 && totalFiles > 0) {
      // Show percentage during indexing (avoids mismatch between total discovered vs indexable)
      // Use 1 decimal place for better sense of progress on large workspaces
      const progress = (((totalFiles - pendingFiles) / totalFiles) * 100).toFixed(1);
      return `Indexing… ${progress}%`;
    }
    if (indexState === 'not_started') {
      // When pre-loaded metadata is available, show the cached count
      // instead of "Not started" (index exists on disk, just loading)
      if (indexedFiles > 0) {
        return `${indexedFiles.toLocaleString()} files (loading)`;
      }
      return 'Not started';
    }
    if (indexState === 'paused' && indexedFiles > 0) {
      return `${indexedFiles.toLocaleString()} files (paused)`;
    }
    return `${indexedFiles.toLocaleString()} files`;
  }, [indexStatus]);

  const isIndexing = indexStatus?.pendingFiles ? indexStatus.pendingFiles > 0 : false;
  const isIndexWatching = indexStatus?.isWatching ?? false;

  // Index control handlers - UI already reflects state changes, no success toasts needed
  const handlePauseResumeIndex = useCallback(async () => {
    if (isIndexWatching) {
      await pauseIndexWatching();
    } else if (settings?.coreDirectory) {
      await startIndexWatching(settings.coreDirectory);
    }
  }, [isIndexWatching, pauseIndexWatching, startIndexWatching, settings?.coreDirectory]);

  const handleDeleteIndex = useCallback(async () => {
    const confirmed = window.confirm(
      'Are you sure you want to delete the search index? This will remove all indexed data and require a full reindex.'
    );
    if (!confirmed) return;

    const success = await clearSearchIndex();
    if (!success) {
      showToast({ title: 'Failed to clear search index' });
    }
  }, [clearSearchIndex, showToast]);

  const handleReindex = useCallback(async () => {
    const started = await reindexWorkspace(true); // force=true to clear and rebuild
    if (!started) {
      showToast({ title: 'Failed to start reindex - is a library selected?' });
    }
  }, [reindexWorkspace, showToast]);

  const handlePauseResumeEnhancement = useCallback(async () => {
    if (!indexStatus) return;
    try {
      if (indexStatus.enhancementPaused) {
        await window.searchApi.resumeEnhancement();
      } else if (indexStatus.enhancementRunning) {
        await window.searchApi.pauseEnhancement();
      }
      await refreshIndexStatus();
    } catch (error) {
      console.error('Failed to pause/resume enhancement:', error);
      showToast({ title: 'Failed to update enhancement' });
    }
  }, [indexStatus, refreshIndexStatus, showToast]);

  const handleStartEnhancement = useCallback(async () => {
    try {
      await window.searchApi.startEnhancement();
      await refreshIndexStatus();
    } catch (error) {
      console.error('Failed to start enhancement:', error);
      showToast({ title: 'Failed to start enhancement' });
    }
  }, [refreshIndexStatus, showToast]);

  const syncStatusLabel = useMemo(() => {
    if (libraryLoading) {
      return 'Syncing…';
    }
    if (!lastRefreshTimestamp) {
      return 'Not synced yet';
    }
    const delta = Date.now() - lastRefreshTimestamp;
    if (delta < 5000) {
      return 'Synced just now';
    }
    if (delta < 60_000) {
      const seconds = Math.floor(delta / 1000);
      return `Synced ${seconds}s ago`;
    }
    if (delta < 3_600_000) {
      const minutes = Math.floor(delta / 60_000);
      return `Synced ${minutes}m ago`;
    }
    const formatter = new Intl.DateTimeFormat([], {
      hour: '2-digit',
      minute: '2-digit'
    });
    return `Synced at ${formatter.format(lastRefreshTimestamp)}`;
  }, [lastRefreshTimestamp, libraryLoading]);

  const syncInlineLabel = libraryLoading
    ? 'Syncing…'
    : syncStatusLabel.startsWith('Synced')
      ? `Synced: ${syncStatusLabel.replace(/^Synced\s*/i, '').trim()}`
      : syncStatusLabel;

  const workspaceDirectoryLabel = settings?.coreDirectory ?? 'Not configured';

  const _closeContextMenuAnd = (fn: () => void) => () => {
    fn();
    closeContextMenu();
  };

  const formatPathForCopy = useCallback((value: string, isDirectory: boolean): string => {
    if (!value) return value;
    let result = value;
    if (isDirectory && !/[\\/]+$/.test(result)) {
      result = `${result}/`;
    }
    if (/\s/.test(result)) {
      const escaped = result.replace(/"/g, '\\"');
      return `"${escaped}"`;
    }
    return result;
  }, []);

  const copyTextToClipboard = useCallback(
    async (text: string) => {
      if (!text) return;
      const fallbackCopy = (value: string): boolean => {
        if (typeof document === 'undefined' || !document.body) {
          return false;
        }
        const textarea = document.createElement('textarea');
        textarea.value = value;
        textarea.setAttribute('readonly', '');
        textarea.style.position = 'fixed';
        textarea.style.opacity = '0';
        textarea.style.pointerEvents = 'none';
        textarea.style.top = '-9999px';
        textarea.style.left = '-9999px';
        document.body.appendChild(textarea);
        textarea.focus();
        textarea.select();
        let copiedResult = false;
        try {
          copiedResult = document.execCommand('copy');
        } catch {
          copiedResult = false;
        } finally {
          document.body.removeChild(textarea);
        }
        return copiedResult;
      };

      let copied = false;
      if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
        try {
          await navigator.clipboard.writeText(text);
          copied = true;
        } catch {
          copied = false;
        }
      }
      if (!copied) {
        copied = fallbackCopy(text);
      }
      if (copied) {
        showToast({ title: 'Copied to clipboard' });
      } else {
        showToast({ title: 'Unable to access the clipboard. Please try again.' });
      }
    },
    [showToast]
  );

  const startRenaming = useCallback(
    (node: FileNode) => {
      setRenamingItem({ path: node.path, originalName: node.name });
      closeContextMenu();
    },
    [closeContextMenu]
  );

  const confirmRename = useCallback(
    async (itemPath: string, newName: string) => {
      if (!newName || !newName.trim()) {
        setRenamingItem(null);
        return;
      }

      const trimmedName = newName.trim();
      const originalName = renamingItem?.originalName;

      if (trimmedName === originalName) {
        setRenamingItem(null);
        return;
      }

      try {
        await window.libraryApi.renameItem({ itemPath, newName: trimmedName });
        setRenamingItem(null);

        setLibraryTree(null);
        void loadLibraryTree();
      } catch (error) {
        showToast({ title: `Failed to rename: ${error instanceof Error ? error.message : String(error)}` });
        emitLog({
          level: 'error',
          message: 'Failed to rename library item',
          context: { error: error instanceof Error ? error.message : String(error) },
          timestamp: Date.now()
        });
        setRenamingItem(null);
      }
    },
    [emitLog, loadLibraryTree, renamingItem?.originalName, setLibraryTree, showToast]
  );

  const deleteItem = useCallback(
    async (node: FileNode) => {
      const itemType = node.kind === 'directory' ? 'folder' : 'file';
      const confirmMessage =
        node.kind === 'directory'
          ? `Are you sure you want to delete the folder "${node.name}" and all its contents? This cannot be undone.`
          : `Are you sure you want to delete "${node.name}"? This cannot be undone.`;

      const confirmed = window.confirm(confirmMessage);
      if (!confirmed) return;

      try {
        await window.libraryApi.deleteItem({ itemPath: node.path });

        if (editorDocument?.path === node.path) {
          closeEditor();
        }

        setLibraryTree(null);
        void loadLibraryTree();
      } catch (error) {
        showToast({ title: `Failed to delete ${itemType}: ${error instanceof Error ? error.message : String(error)}` });
        emitLog({
          level: 'error',
          message: 'Failed to delete library item',
          context: {
            path: node.path,
            kind: node.kind,
            error: error instanceof Error ? error.message : String(error)
          },
          timestamp: Date.now()
        });
      }
    },
    [closeEditor, editorDocument?.path, emitLog, loadLibraryTree, setLibraryTree, showToast]
  );

  // File favorites - derived from settings
  const favoriteFilePaths = useMemo(() => 
    settings?.favoriteFilePaths ?? [],
    [settings?.favoriteFilePaths]
  );

  const favoriteFilePathsSet = useMemo(() => 
    new Set(favoriteFilePaths),
    [favoriteFilePaths]
  );

  const isFileFavorite = useCallback((filePath: string) => 
    favoriteFilePathsSet.has(filePath),
    [favoriteFilePathsSet]
  );

  const toggleFileFavorite = useCallback(async (filePath: string) => {
    // Determine if this is a file or directory for tracking (needed for error toast)
    const node = filePathMap.get(filePath);
    const itemType: 'file' | 'directory' = node?.kind === 'directory' ? 'directory' : 'file';

    try {
      // Fetch fresh settings to avoid overwriting concurrent changes from other components
      // (e.g., model selector, safety levels) — see docs/plans/260402_settings_propagation_gap.md
      const current = await window.settingsApi.get();
      if (!current) return;

      const currentFavorites = current.favoriteFilePaths ?? [];
      const isFavorited = currentFavorites.includes(filePath);
    
      const newFavorites = isFavorited
        ? currentFavorites.filter(p => p !== filePath)
        : [...currentFavorites, filePath];

      await window.settingsApi.update({
        ...current,
        favoriteFilePaths: newFavorites
      });
      
      // Refresh settings to update UI
      if (refreshSettings) {
        await refreshSettings();
      }

      // Show toast feedback
      const itemName = getFileName(filePath);
      showToast({
        title: isFavorited ? `Removed "${itemName}" from favourites` : `Added "${itemName}" to favourites`,
        duration: 2000
      });

      // Track the action with item type
      const ext = itemType === 'file' ? (filePath.split('.').pop() ?? '') : undefined;
      tracking.library.filePinToggled(!isFavorited, itemType, ext);
    } catch (error) {
      showToast({
        title: 'Failed to update favourites',
        variant: 'error'
      });
      emitLog({
        level: 'error',
        message: 'Failed to toggle item favorite',
        context: { filePath, itemType, error: error instanceof Error ? error.message : String(error) },
        timestamp: Date.now()
      });
    }
  }, [refreshSettings, showToast, emitLog, filePathMap]);

  const clearRecentList = useCallback(() => {
    clearRecentFiles();
    setRecentFiles([]);
    setRecentDrawerOpen(false);
  }, [setRecentFiles]);

  const handleToggleRecentDrawer = useCallback(() => {
    setRecentDrawerOpen((prev) => !prev);
  }, []);

  const toggleFilesExpanded = useCallback(() => {
    setFilesExpanded((prev) => !prev);
  }, []);

  // Chief of Staff file detection
  // Two-phase approach:
  // 1. Optimistic path (sync): derived from settings so the banner renders immediately
  // 2. Confirmed path (async): resolved from tree once loaded, handles README vs AGENTS
  //    and case variants. Uses joinWorkspaceAbsolute for native-separator consistency.
  const optimisticChiefPath = useMemo(() => {
    if (!libraryRootAbsolute) return null;
    return joinWorkspaceAbsolute(libraryRootAbsolute, 'Chief-of-Staff/README.md');
  }, [libraryRootAbsolute, joinWorkspaceAbsolute]);

  const confirmedChiefPath = useMemo(() => {
    if (!libraryRootAbsolute || filePathMap.size === 0) return null;
    const variants = [
      joinWorkspaceAbsolute(libraryRootAbsolute, 'Chief-of-Staff/README.md'),
      joinWorkspaceAbsolute(libraryRootAbsolute, 'Chief-of-Staff/AGENTS.md'),
      joinWorkspaceAbsolute(libraryRootAbsolute, 'chief-of-staff/README.md'),
      joinWorkspaceAbsolute(libraryRootAbsolute, 'chief-of-staff/AGENTS.md'),
    ];
    return variants.find(p => filePathMap.has(p)) ?? null;
  }, [libraryRootAbsolute, filePathMap, joinWorkspaceAbsolute]);

  const chiefOfStaffFilePath = confirmedChiefPath ?? optimisticChiefPath;

  // Compute profile completion when Library opens or overview closes (user may have edited)
  const completionOpenRef = useRef(false);
  const completionOverviewRef = useRef(false);
  useEffect(() => {
    const wasOpen = completionOpenRef.current;
    const wasOverview = completionOverviewRef.current;
    completionOpenRef.current = open;
    completionOverviewRef.current = chiefOfStaffOverviewOpen;

    const justOpened = open && !wasOpen;
    const leftOverview = wasOverview && !chiefOfStaffOverviewOpen;

    if (!open) return;
    if (!(justOpened || leftOverview)) return;
    if (!chiefOfStaffFilePath) {
      setProfileCompletionPercent(0);
      return;
    }

    let cancelled = false;
    (async () => {
      try {
        const result = await window.libraryApi.readFile(chiefOfStaffFilePath);
        if (!cancelled) {
          setProfileCompletionPercent(calculateProfileCompletion(result.content, true));
        }
      } catch {
        if (!cancelled) setProfileCompletionPercent(calculateProfileCompletion(null, true));
      }
    })();

    return () => { cancelled = true; };
  }, [open, chiefOfStaffFilePath, chiefOfStaffOverviewOpen]);

  const openChiefOverview = useCallback(() => {
    if (!chiefOfStaffFilePath) return;
    clearWorkspaceSearch();
    setChiefOfStaffOverviewOpen(true);
    tracking.library.chiefOfStaffOpened();
    closeEditor();
  }, [chiefOfStaffFilePath, clearWorkspaceSearch, closeEditor]);

  const closeChiefOverview = useCallback(() => {
    setChiefOfStaffOverviewOpen(false);
    closeEditor();
  }, [closeEditor]);

  // Derive the actual CoS folder name from the confirmed path (handles case variants)
  const chiefFolderName = useMemo(() => {
    if (!confirmedChiefPath || !libraryRootAbsolute) return 'Chief-of-Staff';
    const sep = libraryRootAbsolute.includes('\\') ? '\\' : '/';
    const relative = confirmedChiefPath.slice(libraryRootAbsolute.length).replace(/^[\\/]+/, '');
    return relative.split(sep)[0] || 'Chief-of-Staff';
  }, [confirmedChiefPath, libraryRootAbsolute]);

  const openChiefFolder = useCallback(() => {
    // Close the explainer and reveal the folder in the tree (visible feedback).
    setChiefOfStaffOverviewOpen(false);
    handleSkillFolderNavigate(chiefFolderName);
  }, [handleSkillFolderNavigate, chiefFolderName]);

  const askChiefInChat = useCallback(() => {
    if (!chiefOfStaffFilePath || !onStartConversation) return;
    const prompt =
      "Help me set up my profile so you understand how I work. " +
      "Ask me up to 5 questions about my role, goals, communication preferences, " +
      "and working style — then update my profile based on my answers.";
    onStartConversation(prompt, [chiefOfStaffFilePath]);
  }, [chiefOfStaffFilePath, onStartConversation]);

  const { facets: filterFacets } = useFilterFacets({
    filter: effectiveLens.filter,
    skillsData,
    memoryEntries,
    spacesData,
    treeEntries: facetTreeEntries,
    isPartialTree: treePartialState.isPartialTree === true,
  });

  const commandShelfProps = useMemo<LibraryCommandShelfProps>(() => ({
    searchQuery: currentSearchQuery,
    onSearchChange: handleSearchChange,
    searchDisabled: libraryLoading || !libraryTree,
    lens: effectiveLens,
    facets: filterFacets,
    sortBy: fileSortOrder,
    setBrowseLens,
    onSortByChange: setFileSortOrder,
    orientationTipDismissed,
    dismissOrientationTip,
    revealedFoldersCount: pendingFolderNavigation ? 1 : 0,
    settings,
    selectedWorkspaceItem,
    showHiddenFiles,
    onToggleHiddenFiles: handleToggleHiddenFiles,
    onRefresh: handleRefreshWorkspace,
    refreshDisabled: libraryLoading,
    onCreateFile: handleCreateFile,
    onCreateFolder: handleCreateFolder,
    onCreateSkill,
    onCreateMemory,
    onAddSpace,
    onManageSpaces,
    canCreateAdditionalSpaces,
    createActionPending,
    hasRecentFiles,
    recentDrawerOpen,
    onToggleRecentDrawer: handleToggleRecentDrawer,
    workspaceDirectoryLabel,
    filesLabel,
    syncLabel: syncInlineLabel,
    // Index status and controls
    indexedFilesLabel,
    indexedFilesCount: indexStatus?.indexedFiles ?? 0,
    totalFilesCount: indexStatus?.totalFiles ?? 0,
    pendingFilesCount: indexStatus?.pendingFiles ?? 0,
    isIndexing,
    isIndexWatching,
    onPauseResumeIndex: handlePauseResumeIndex,
    onDeleteIndex: handleDeleteIndex,
    onReindex: handleReindex,
    // Enhancement progress (two-phase indexing)
    enhancementProgress: {
      totalChunks: indexStatus?.totalChunks ?? 0,
      enhancedChunks: indexStatus?.enhancedChunks ?? 0,
      isRunning: indexStatus?.enhancementRunning ?? false,
      isPaused: indexStatus?.enhancementPaused ?? false,
    },
    onPauseResumeEnhancement: handlePauseResumeEnhancement,
    onStartEnhancement: handleStartEnhancement,
    hasApiKey: Boolean(resolveModelSettings(settings ?? {}).apiKey),
    // Index completion info
    lastIndexedAt: indexStatus?.lastIndexedAt ?? null,
    indexState: indexStatus?.indexState ?? 'not_started',
    // Chief of Staff
    isChiefActive: Boolean(chiefOfStaffOverviewOpen),
    // External control for indexing panel expansion (from Settings navigation)
    indexingPanelExpanded,
    onIndexingPanelExpandedChange: setIndexingPanelExpanded,
  }), [
    canCreateAdditionalSpaces,
    chiefOfStaffOverviewOpen,
    createActionPending,
    currentSearchQuery,
    dismissOrientationTip,
    effectiveLens,
    filterFacets,
    fileSortOrder,
    filesLabel,
    handleCreateFile,
    handleCreateFolder,
    handleDeleteIndex,
    handlePauseResumeEnhancement,
    handlePauseResumeIndex,
    handleRefreshWorkspace,
    handleReindex,
    handleSearchChange,
    handleStartEnhancement,
    handleToggleHiddenFiles,
    handleToggleRecentDrawer,
    hasRecentFiles,
    indexStatus,
    indexedFilesLabel,
    indexingPanelExpanded,
    isIndexWatching,
    isIndexing,
    libraryLoading,
    libraryTree,
    onAddSpace,
    onManageSpaces,
    onCreateMemory,
    onCreateSkill,
    orientationTipDismissed,
    pendingFolderNavigation,
    recentDrawerOpen,
    selectedWorkspaceItem,
    setBrowseLens,
    setFileSortOrder,
    settings,
    showHiddenFiles,
    syncInlineLabel,
    workspaceDirectoryLabel,
  ]);

  // Sort tree nodes based on current sort order
  // Directories always appear first, then items are sorted by the selected order
  const sortedLibraryTree = useMemo(() => {
    if (!libraryTree) return null;
    const treeSortMode: 'name' | 'modified' = fileSortOrder === 'modified' ? 'modified' : 'name';
    
    const sortNodes = (nodes: FileNode[]): FileNode[] => {
      const sorted = [...nodes].sort((a, b) => {
        // Directories always come first
        if (a.kind === 'directory' && b.kind !== 'directory') return -1;
        if (a.kind !== 'directory' && b.kind === 'directory') return 1;
        
        if (treeSortMode === 'modified') {
          // Sort by modification date (newest first)
          const aTime = a.mtime ?? 0;
          const bTime = b.mtime ?? 0;
          if (bTime !== aTime) return bTime - aTime;
          // Fall back to name for stable sorting
          return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
        }
        
        // Default: sort by name (A-Z)
        return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
      });
      
      // Recursively sort children
      return sorted.map(node => {
        if (node.kind === 'directory' && node.children) {
          return { ...node, children: sortNodes(node.children) };
        }
        return node;
      });
    };
    
    return sortNodes(libraryTree);
  }, [libraryTree, fileSortOrder]);

  const handleCancelRename = useCallback(() => {
    setRenamingItem(null);
  }, []);

  const treeViewProps = useMemo<LibraryTreeViewProps>(() => ({
    nodes: sortedLibraryTree,
    expandedDirectories,
    selectedPath: selectedWorkspaceItem?.path ?? null,
    activePath: editorDocument?.path ?? null,
    focusedPath,
    renamingPath: renamingItem?.path ?? null,
    draggingNodePath: draggingNode?.path ?? null,
    dropTarget,
    libraryRootAbsolute,
    onSelectNode: handleWorkspaceItemClick,
    onSelectFile: handleWorkspaceItemClick,
    onFocusNode: setFocusedPath,
    onToggleExpand: toggleDirectoryExpansion,
    onExpandDirectories: expandDirectories,
    onContextMenu: handleWorkspaceContextMenu,
    onConfirmRename: confirmRename,
    onCancelRename: handleCancelRename,
    onDragStart: handleTreeItemDragStart,
    onDragOver: handleTreeItemDragOver,
    onDragLeave: handleTreeItemDragLeave,
    onDrop: handleTreeItemDrop,
    onDragEnd: handleTreeItemDragEnd,
    isFileFavorite,
    onToggleFileFavorite: toggleFileFavorite
  }), [
    confirmRename,
    draggingNode?.path,
    dropTarget,
    editorDocument?.path,
    expandedDirectories,
    focusedPath,
    handleCancelRename,
    handleTreeItemDragEnd,
    handleTreeItemDragLeave,
    handleTreeItemDragOver,
    handleTreeItemDragStart,
    handleTreeItemDrop,
    handleWorkspaceContextMenu,
    handleWorkspaceItemClick,
    expandDirectories,
    isFileFavorite,
    libraryRootAbsolute,
    renamingItem?.path,
    selectedWorkspaceItem?.path,
    sortedLibraryTree,
    toggleDirectoryExpansion,
    toggleFileFavorite,
  ]);

  const handleSelectRecentFile = useCallback((node: FileNode) => {
    handleWorkspaceItemClick(node);
    setRecentDrawerOpen(false);
  }, [handleWorkspaceItemClick]);

  const handleCloseRecentDrawer = useCallback(() => {
    setRecentDrawerOpen(false);
  }, []);

  const recentDrawerProps = useMemo<LibraryRecentDrawerProps>(() => ({
    open: recentDrawerOpen,
    files: recentFileNodes,
    editorPath: editorDocument?.path ?? null,
    onSelectFile: handleSelectRecentFile,
    onClose: handleCloseRecentDrawer,
    onClear: clearRecentList
  }), [
    clearRecentList,
    editorDocument?.path,
    handleCloseRecentDrawer,
    handleSelectRecentFile,
    recentDrawerOpen,
    recentFileNodes,
  ]);

  // Look up example paths for a skill by its relative path
  const getSkillExamplePaths = useCallback((skillRelativePath: string): string[] | undefined => {
    if (!skillsData?.groups) return undefined;
    const normalizedSkillRelativePath = normalizeLibraryPath(skillRelativePath);
    
    // Search through all groups and categories to find the skill
    for (const group of skillsData.groups) {
      for (const skills of Object.values(group.categories)) {
        for (const skill of skills) {
          if (normalizeLibraryPath(skill.relativePath) === normalizedSkillRelativePath) {
            return skill.examples;
          }
        }
      }
    }
    return undefined;
  }, [skillsData]);

  // Look up quality summary for a skill by its relative path
  const getSkillQualityData = useCallback((
    skillRelativePath: string
  ): {
    qualityScore?: number;
    qualityBand?: 'seedling' | 'growing' | 'solid' | 'exemplary';
    qualityTopImprovement?: { dimension: string; suggestion: string };
  } | undefined => {
    if (!skillsData?.groups) return undefined;
    const normalizedSkillRelativePath = normalizeLibraryPath(skillRelativePath);

    for (const group of skillsData.groups) {
      for (const skills of Object.values(group.categories)) {
        for (const skill of skills) {
          if (normalizeLibraryPath(skill.relativePath) === normalizedSkillRelativePath) {
            return {
              qualityScore: skill.qualityScore,
              qualityBand: skill.qualityBand,
              qualityTopImprovement: skill.qualityTopImprovement,
            };
          }
        }
      }
    }

    return undefined;
  }, [skillsData]);

  const getSkillMetadata = useCallback((
    skillRelativePath: string
  ): {
    relativePath: string;
    frontmatter?: SkillInfo['frontmatter'];
    source: 'platform' | 'space' | 'workspace';
    sharing?: 'private' | 'restricted' | 'team' | 'company-wide' | 'public';
    storageProvider?: 'google_drive' | 'onedrive' | 'dropbox' | 'box' | 'icloud' | 'local' | 'other';
  } | undefined => {
    if (!skillsData?.groups) return undefined;
    const normalizedSkillRelativePath = normalizeLibraryPath(skillRelativePath);

    for (const group of skillsData.groups) {
      for (const skills of Object.values(group.categories)) {
        for (const skill of skills) {
          if (normalizeLibraryPath(skill.relativePath) === normalizedSkillRelativePath) {
            return {
              relativePath: normalizeLibraryPath(skill.relativePath),
              frontmatter: skill.frontmatter,
              source: group.type,
              sharing: group.sharing,
              storageProvider: group.storageProvider,
            };
          }
        }
      }
    }

    return undefined;
  }, [skillsData]);

  const libraryTreeEmptyMessage = libraryRootAbsolute
    ? 'No visible files found in this Library.'
    : 'Select a Library directory to get started.';

  const chiefOfStaffState = useMemo(() => ({
    filePath: chiefOfStaffFilePath,
    overviewOpen: chiefOfStaffOverviewOpen,
    openOverview: openChiefOverview,
    closeOverview: closeChiefOverview,
    openFolder: openChiefFolder,
    askInChat: askChiefInChat,
  }), [
    askChiefInChat,
    chiefOfStaffFilePath,
    chiefOfStaffOverviewOpen,
    closeChiefOverview,
    openChiefFolder,
    openChiefOverview,
  ]);

  const bodyState = useMemo<LibraryNavigatorContextValue['bodyState']>(() => ({
    libraryLoading,
    libraryError,
    librarySearchQuery: currentSearchQuery,
    librarySearchOutcome,
    libraryTree,
    flattenedFiles,
    libraryStats,
    treePartialState,
    treeGeneration,
    libraryTreeEmptyMessage,
    // Global space filter
    selectedSpaceFilter,
    setSelectedSpaceFilter,
    // Skills data for filter-aware cards/list renderers
    skillsData,
    skillsLoading,
    skillsError,
    // Memory data for unified search
    memoryEntries,
    memoryLoading,
    memoryError,
    pendingMemoryRequests: pendingMemoryApprovals.requests,
    pendingMemoryLoading: pendingMemoryApprovals.isLoading,
    savePendingMemoryRequest: pendingMemoryApprovals.save,
    skipPendingMemoryRequest: pendingMemoryApprovals.skip,
    saveAllPendingMemoryRequests: pendingMemoryApprovals.saveAll,
    skipAllPendingMemoryRequests: pendingMemoryApprovals.skipAll,
    // Spaces data (Show: Spaces lens)
    spacesData,
    spacesLoading,
    spacesError,
    spacesErrorMessage: spacesErrorMessage ?? null,
    // Content search
    contentSearchResults,
    contentSearchLoading,
    contentSearchError,
    contentSearchTotalMatches,
    contentSearchedFiles,
    contentSearchTruncated,
    contentSearchSelectedIndex,
    setContentSearchSelectedIndex,
    handleContentSearchSelectResult,
    searchResultsProps,
    treeViewProps,
    rootDropZoneState,
    // File sorting and navigation
    fileSortOrder,
    setFileSortOrder,
    libraryRootAbsolute,
    activePath: editorDocument?.path ?? null,
    navigateToPath: handleSkillFolderNavigate,
    revealInClassifiedView: revealInTree,
    setActiveSpace: handleSetActiveSpace,
    renameSpace: handleRenameSpace,
    deleteSpace: handleDeleteSpace,
    chiefOfStaff: chiefOfStaffState,
    pendingFolderNavigation,
  }), [
    chiefOfStaffState,
    contentSearchError,
    contentSearchLoading,
    contentSearchResults,
    contentSearchSelectedIndex,
    contentSearchTotalMatches,
    contentSearchTruncated,
    contentSearchedFiles,
    currentSearchQuery,
    editorDocument?.path,
    flattenedFiles,
    fileSortOrder,
    handleContentSearchSelectResult,
    handleDeleteSpace,
    handleRenameSpace,
    handleSetActiveSpace,
    handleSkillFolderNavigate,
    libraryError,
    libraryLoading,
    librarySearchOutcome,
    libraryStats,
    libraryRootAbsolute,
    libraryTree,
    libraryTreeEmptyMessage,
    treePartialState,
    memoryEntries,
    memoryError,
    memoryLoading,
    pendingFolderNavigation,
    pendingMemoryApprovals.isLoading,
    pendingMemoryApprovals.requests,
    pendingMemoryApprovals.save,
    pendingMemoryApprovals.saveAll,
    pendingMemoryApprovals.skip,
    pendingMemoryApprovals.skipAll,
    revealInTree,
    rootDropZoneState,
    searchResultsProps,
    selectedSpaceFilter,
    setContentSearchSelectedIndex,
    setFileSortOrder,
    skillsData,
    skillsError,
    skillsLoading,
    spacesData,
    spacesError,
    spacesErrorMessage,
    spacesLoading,
    treeGeneration,
    treeViewProps,
  ]);

  const filesAccordion = useMemo(() => ({
    expanded: filesExpanded,
    toggle: toggleFilesExpanded,
  }), [filesExpanded, toggleFilesExpanded]);

  const contextMenuState = useMemo<LibraryNavigatorContextValue['contextMenuState']>(() => ({
    contextMenu,
    closeContextMenu,
    editInContext: () => {
      if (!contextMenu) return;
      if (contextMenu.target.kind === 'file') {
        handleWorkspaceItemClick(contextMenu.target);
      }
      closeContextMenu();
    },
    createFileInContext: () => {
      if (!contextMenu) return;
      createNewFile(contextMenu.target.kind === 'directory' ? contextMenu.target : undefined);
      closeContextMenu();
    },
    createFolderInContext: () => {
      if (!contextMenu) return;
      createNewFolder(contextMenu.target.kind === 'directory' ? contextMenu.target : undefined);
      closeContextMenu();
    },
    startRenaming: () => {
      if (!contextMenu) return;
      startRenaming(contextMenu.target);
    },
    copyPath: () => {
      if (!contextMenu) return;
      const isDir = contextMenu.target.kind === 'directory';
      const formatted = formatPathForCopy(contextMenu.target.path, isDir);
      void copyTextToClipboard(formatted);
      closeContextMenu();
    },
    copyRelativePath: () => {
      if (!contextMenu) return;
      const isDir = contextMenu.target.kind === 'directory';
      const relative = getRelativeLibraryPath(contextMenu.target.path, libraryRootAbsolute);
      const formatted = formatPathForCopy(relative, isDir);
      void copyTextToClipboard(formatted);
      closeContextMenu();
    },
    copyAsMarkdownLink: () => {
      if (!contextMenu) return;
      const name = contextMenu.target.name;
      const relative = getRelativeLibraryPath(contextMenu.target.path, libraryRootAbsolute);
      const markdownLink = `[${name}](${relative})`;
      void copyTextToClipboard(markdownLink);
      closeContextMenu();
    },
    revealInFinder: () => {
      if (!contextMenu) return;
      void window.appApi.revealPath(contextMenu.target.path);
      closeContextMenu();
    },
    deleteItem: () => {
      if (!contextMenu) return;
      void deleteItem(contextMenu.target);
      closeContextMenu();
    },
    toggleFavorite: () => {
      if (!contextMenu) return;
      void toggleFileFavorite(contextMenu.target.path);
      closeContextMenu();
    },
    sharePublicly: onShareFile && contextMenu?.target.kind === 'file' ? () => {
      if (!contextMenu) return;
      const relative = getRelativeLibraryPath(contextMenu.target.path, libraryRootAbsolute);
      if (relative) {
        onShareFile(relative);
      }
      closeContextMenu();
    } : null,
  }), [
    closeContextMenu,
    contextMenu,
    copyTextToClipboard,
    createNewFile,
    createNewFolder,
    deleteItem,
    formatPathForCopy,
    handleWorkspaceItemClick,
    libraryRootAbsolute,
    onShareFile,
    startRenaming,
    toggleFileFavorite,
  ]);

  const createDialogState = useMemo(() => ({
    createDialog,
    createDialogValue,
    setCreateDialogValue,
    confirmCreate: handleConfirmCreate,
    closeCreateDialog
  }), [
    closeCreateDialog,
    createDialog,
    createDialogValue,
    handleConfirmCreate,
    setCreateDialogValue,
  ]);

  const value = useMemo<LibraryNavigatorContextValue>(() => ({
    isOpen: open,
    settings,
    lens: effectiveLens,
    browseLens,
    orientationTipDismissed,
    setBrowseLens,
    setEditorLensOverride,
    dismissOrientationTip,
    loadWorkspaceFile,
    commandShelfProps,
    bodyState,
    recentDrawerProps,
    filesAccordion,
    contextMenuState,
    favoriteFilePaths,
    toggleFileFavorite,
    isFileFavorite,
    createDialogState,
    workspaceDrawerClassName: cn(drawerStyles.drawer, open && drawerStyles.drawerOpen),
    navigateToFolder: handleSkillFolderNavigate,
    showToast,
    emitLog,
    onUseSkill,
    onOpenSession,
    getSkillExamplePaths,
    getSkillQualityData,
    getSkillMetadata,
    onStartConversation
  }), [
    bodyState,
    browseLens,
    commandShelfProps,
    contextMenuState,
    createDialogState,
    dismissOrientationTip,
    effectiveLens,
    emitLog,
    favoriteFilePaths,
    filesAccordion,
    getSkillExamplePaths,
    getSkillMetadata,
    getSkillQualityData,
    handleSkillFolderNavigate,
    isFileFavorite,
    loadWorkspaceFile,
    onOpenSession,
    onStartConversation,
    onUseSkill,
    open,
    orientationTipDismissed,
    recentDrawerProps,
    setBrowseLens,
    setEditorLensOverride,
    settings,
    showToast,
    toggleFileFavorite,
  ]);

  return <LibraryNavigatorContext.Provider value={value}>{children}</LibraryNavigatorContext.Provider>;
};

export const useLibraryNavigator = () => {
  const context = useContext(LibraryNavigatorContext);
  if (!context) {
    throw new Error('useLibraryNavigator must be used within a LibraryNavigatorProvider');
  }
  return context;
};
