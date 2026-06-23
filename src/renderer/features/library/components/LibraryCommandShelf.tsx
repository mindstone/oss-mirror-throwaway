import { useId, useState, useCallback, useEffect } from "react";
import { basename } from "pathe";
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
} from "@floating-ui/react";
import type { AppSettings, FileNode } from "@shared/types";
import { cn } from "@renderer/lib/utils";
import { Button } from "@renderer/components/ui";
import { Tooltip } from "@renderer/components/ui/Tooltip";
import {
  HelpCircle,
  FilePlus,
  FolderPlus,
  Eye,
  EyeOff,
  RefreshCw,
  Info,
  X,
  Sparkles,
  ScrollText,
  Pause,
  Play,
  Trash2,
  RotateCcw,
  Plus,
} from "lucide-react";
import type { LibraryFilter, LibraryLens, LibrarySortOption } from "../types/lens";
import type { FacetOption } from "../hooks/useFilterFacets";
import { LibraryLensBar, type LibraryLensOverflowAction } from "./LibraryLensBar";
import styles from "./LibraryCommandShelf.module.css";

export type LibraryCommandShelfProps = {
  searchQuery: string;
  onSearchChange: (value: string) => void;
  searchDisabled: boolean;
  lens: LibraryLens;
  facets?: readonly FacetOption[];
  sortBy: LibrarySortOption;
  setBrowseLens: (next: LibraryLens | ((prev: LibraryLens) => LibraryLens)) => void;
  onSortByChange: (nextSort: LibrarySortOption) => void;
  orientationTipDismissed: boolean;
  dismissOrientationTip: () => void;
  revealedFoldersCount?: number;
  settings: AppSettings | null;
  selectedWorkspaceItem: FileNode | null;
  showHiddenFiles: boolean;
  onToggleHiddenFiles: () => void;
  onRefresh: () => void;
  refreshDisabled: boolean;
  onCreateFile: () => void;
  onCreateFolder: () => void;
  onCreateSkill?: () => void;
  onCreateMemory?: () => void;
  onAddSpace?: () => void;
  // Opens Settings → Spaces; consumed by the Library cloud-degraded notice (not
  // the command shelf itself). Threaded here because the notice render sites in
  // LibraryNavigator read it off commandShelfProps. Optional ⇒ tooltip-only.
  onManageSpaces?: () => void;
  canCreateAdditionalSpaces?: boolean;
  createActionPending?: boolean;
  hasRecentFiles: boolean;
  recentDrawerOpen: boolean;
  onToggleRecentDrawer: () => void;
  workspaceDirectoryLabel: string;
  filesLabel: string;
  syncLabel: string;
  // Index status and controls
  indexedFilesLabel: string;
  indexedFilesCount: number;
  totalFilesCount: number;
  pendingFilesCount: number;
  isIndexing: boolean;
  isIndexWatching: boolean;
  onPauseResumeIndex: () => void;
  onDeleteIndex: () => void;
  onReindex: () => void;
  // Enhancement progress (two-phase indexing)
  enhancementProgress: {
    totalChunks: number;
    enhancedChunks: number;
    isRunning: boolean;
    isPaused: boolean;
  };
  onPauseResumeEnhancement: () => void;
  onStartEnhancement: () => void;
  hasApiKey: boolean;
  // Index completion info
  lastIndexedAt: number | null;
  indexState: 'not_started' | 'watching' | 'paused';
  // Chief of Staff
  isChiefActive: boolean;
  // External control for indexing panel expansion
  indexingPanelExpanded?: boolean;
  onIndexingPanelExpandedChange?: (expanded: boolean) => void;
};

/** Extract just the folder name from a full path */
const getDirectoryName = (path: string): string => {
  if (!path) return "No workspace";
  return basename(path) || path;
};

/** Format a timestamp into a human-readable relative time */
const formatLastIndexed = (timestamp: number | null): string => {
  if (!timestamp) return 'Never';
  
  const now = Date.now();
  const diff = now - timestamp;
  
  if (diff < 60_000) return 'Just now';
  if (diff < 3_600_000) {
    const minutes = Math.floor(diff / 60_000);
    return `${minutes}m ago`;
  }
  if (diff < 86_400_000) {
    const hours = Math.floor(diff / 3_600_000);
    return `${hours}h ago`;
  }
  
  // For older timestamps, show date and time
  const date = new Date(timestamp);
  const formatter = new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
  return formatter.format(date);
};

const formatLastIndexedTooltipTimestamp = (timestamp: number | null): string => {
  if (!timestamp) return 'Never';

  const date = new Date(timestamp);
  const formatter = new Intl.DateTimeFormat(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });

  return formatter.format(date);
};

/** Get search placeholder based on active filter */
const getSearchPlaceholder = (filter: LibraryFilter): string => {
  switch (filter) {
    case 'skills':
      return 'Search skills...';
    case 'memory':
      return 'Search memories...';
    case 'everything':
      return 'Search everything...';
    case 'spaces':
    default:
      return 'Search spaces...';
  }
};

type CreateButtonBehavior = {
  label: string;
  tooltip: string;
  mode: 'menu' | 'direct';
  onDirectCreate?: () => void;
};

const getCreateButtonBehavior = ({
  filter,
  onCreateSkill,
  onCreateMemory,
  onAddSpace,
  canCreateAdditionalSpaces,
}: {
  filter: LibraryFilter;
  onCreateSkill?: () => void;
  onCreateMemory?: () => void;
  onAddSpace?: () => void;
  canCreateAdditionalSpaces?: boolean;
}): CreateButtonBehavior => {
  switch (filter) {
    case 'skills':
      return {
        label: 'New skill',
        tooltip: 'Create a new skill',
        mode: 'direct',
        onDirectCreate: onCreateSkill,
      };
    case 'memory':
      return {
        label: 'Add memory',
        tooltip: 'Start a memory note in chat',
        mode: 'direct',
        onDirectCreate: onCreateMemory,
      };
    case 'spaces':
      if (canCreateAdditionalSpaces === false) {
        return {
          label: 'Add space',
          tooltip: 'Teams license required to add spaces. To get Rebel for your team, contact us at hello@mindstone.com',
          mode: 'direct',
        };
      }
      return {
        label: 'Add space',
        tooltip: 'Add a space',
        mode: 'direct',
        onDirectCreate: onAddSpace,
      };
    case 'everything':
    default:
      return {
        label: 'New',
        tooltip: 'Create a new file or folder',
        mode: 'menu',
      };
  }
};

export const LibraryCommandShelf = ({
  searchQuery,
  onSearchChange,
  searchDisabled,
  lens,
  facets,
  sortBy,
  setBrowseLens,
  onSortByChange,
  orientationTipDismissed,
  dismissOrientationTip,
  revealedFoldersCount,
  settings,
  selectedWorkspaceItem,
  showHiddenFiles,
  onToggleHiddenFiles,
  onRefresh,
  refreshDisabled,
  onCreateFile,
  onCreateFolder,
  onCreateSkill,
  onCreateMemory,
  onAddSpace,
  canCreateAdditionalSpaces = true,
  createActionPending = false,
  workspaceDirectoryLabel,
  indexedFilesLabel,
  indexedFilesCount,
  totalFilesCount,
  pendingFilesCount,
  isIndexing,
  isIndexWatching,
  onPauseResumeIndex,
  onDeleteIndex,
  onReindex,
  enhancementProgress,
  onPauseResumeEnhancement,
  onStartEnhancement,
  hasApiKey,
  lastIndexedAt,
  indexState,
  isChiefActive,
  indexingPanelExpanded,
  onIndexingPanelExpandedChange,
}: LibraryCommandShelfProps) => {
  // Fully controlled pattern: use prop directly, call callback on change
  const isInfoExpanded = indexingPanelExpanded ?? false;
  const setIsInfoExpanded = useCallback((expanded: boolean) => {
    onIndexingPanelExpandedChange?.(expanded);
  }, [onIndexingPanelExpandedChange]);
  const [showHelp, setShowHelp] = useState(false);
  const [isCreateMenuOpen, setIsCreateMenuOpen] = useState(false);
  const workspaceInfoTooltipId = useId();

  const { refs, floatingStyles, context } = useFloating({
    open: isCreateMenuOpen,
    onOpenChange: setIsCreateMenuOpen,
    placement: "bottom-end",
    middleware: [offset(4), flip({ padding: 8 }), shift({ padding: 8 })],
    whileElementsMounted: autoUpdate,
  });

  const click = useClick(context);
  const dismiss = useDismiss(context);
  const role = useRole(context, { role: "menu" });

  const { getReferenceProps, getFloatingProps } = useInteractions([
    click,
    dismiss,
    role,
  ]);

  const handleCreateSkill = useCallback(() => {
    onCreateSkill?.();
    setIsCreateMenuOpen(false);
  }, [onCreateSkill]);

  const handleCreateFile = useCallback(() => {
    onCreateFile();
    setIsCreateMenuOpen(false);
  }, [onCreateFile]);

  const handleCreateFolder = useCallback(() => {
    onCreateFolder();
    setIsCreateMenuOpen(false);
  }, [onCreateFolder]);

  const canCreate = Boolean(settings?.coreDirectory);
  const selectedDirectory =
    selectedWorkspaceItem?.kind === "directory"
      ? selectedWorkspaceItem
      : undefined;

  const newFileLabel = selectedDirectory
    ? `New file in ${selectedDirectory.name}`
    : "New file";
  const newFolderLabel = selectedDirectory
    ? `New folder in ${selectedDirectory.name}`
    : "New folder";
  const hiddenToggleLabel = showHiddenFiles
    ? "Hide hidden files"
    : "Show hidden files";
  const createButtonBehavior = getCreateButtonBehavior({
    filter: lens.filter,
    onCreateSkill,
    onCreateMemory,
    onAddSpace,
    canCreateAdditionalSpaces,
  });
  const createButtonUsesMenu = createButtonBehavior.mode === 'menu';
  const createActionAvailable = createButtonUsesMenu || Boolean(createButtonBehavior.onDirectCreate);
  const handleDirectCreate = useCallback(() => {
    setIsCreateMenuOpen(false);
    createButtonBehavior.onDirectCreate?.();
  }, [createButtonBehavior]);
  useEffect(() => {
    if (!createButtonUsesMenu && isCreateMenuOpen) {
      setIsCreateMenuOpen(false);
    }
  }, [createButtonUsesMenu, isCreateMenuOpen]);

  const libraryInfoTooltip = `${isInfoExpanded ? "Hide Library info" : "Show Library info & index controls"}${isIndexing ? ` (Currently indexing ${totalFilesCount > 0 ? Math.round(((totalFilesCount - pendingFilesCount) / totalFilesCount) * 100) : 0}%)` : ""}`;
  const overflowActions: readonly LibraryLensOverflowAction[] = [
    {
      id: 'info',
      label: 'Show Library info',
      icon: Info,
      onClick: () => setIsInfoExpanded(!isInfoExpanded),
      active: isInfoExpanded,
      tooltip: libraryInfoTooltip,
      indicator: isIndexing ? 'indexing' : undefined,
    },
    {
      id: 'refresh',
      label: 'Refresh files',
      icon: RefreshCw,
      onClick: onRefresh,
      disabled: refreshDisabled,
      tooltip: 'Refresh files',
      indicator: refreshDisabled ? 'spinning' : undefined,
    },
  ];

  const _directoryName = getDirectoryName(settings?.coreDirectory ?? "");

  return (
    <div className={styles.commandShelf}>
      {/* Help Panel for New Users */}
      {showHelp && (
        <div className={styles.helpPanel}>
          <div className={styles.helpPanelHeader}>
            <HelpCircle className={styles.helpPanelIcon} />
            <span className={styles.helpPanelTitle}>
              What is the Library?
            </span>
            <button
              type="button"
              className={styles.helpPanelClose}
              onClick={() => setShowHelp(false)}
              aria-label="Close help"
            >
              <X size={14} />
            </button>
          </div>
          <div className={styles.helpPanelContent}>
            <p className={styles.helpPanelText}>
              Your Library is your personal folder where you store files,
              documents, and custom <strong>Skills</strong> that the AI can use
              during conversations.
            </p>
            <ul className={styles.helpPanelList}>
              <li>
                <strong>Browse files</strong> — View and edit any file in your
                workspace
              </li>
              <li>
                <strong>Create skills</strong> — Teach the AI new capabilities
                with markdown files
              </li>
              <li>
                <strong>Organize content</strong> — The AI can read and
                reference your workspace files
              </li>
            </ul>
          </div>
        </div>
      )}

      {/* Expanded Info Panel */}
      {isInfoExpanded && (
        <div className={styles.infoPanel} id={workspaceInfoTooltipId}>
          <div className={styles.infoPanelRow}>
            <span className={styles.infoPanelLabel}>Location</span>
            <span
              className={styles.infoPanelValue}
              title={workspaceDirectoryLabel}
            >
              {workspaceDirectoryLabel}
            </span>
          </div>
          <div className={styles.infoPanelRow}>
            <span className={styles.infoPanelLabel}>Search index</span>
            <span
              className={cn(
                styles.infoPanelValue,
                isIndexing && styles.infoPanelValueActive,
              )}
            >
              <Tooltip
                content={
                  isIndexing ? (
                    <span>
                      {Math.max(0, totalFilesCount - pendingFilesCount).toLocaleString()} of {totalFilesCount.toLocaleString()} files processed
                      <br /><br />
                      Rebel indexes text and code files (.md, .txt, .ts, .py, etc.) so you can search across your workspace using <code>@files</code>.
                      <br /><br />
                      Not indexed: images, videos, archives, and sensitive files (like .env and credentials).
                    </span>
                  ) : (
                    <span>
                      {indexedFilesCount.toLocaleString()} files indexed
                      <br /><br />
                      Rebel indexes text and code files so you can search across your workspace using <code>@files</code>.
                      <br /><br />
                      Not indexed: images, videos, archives, and sensitive files.
                    </span>
                  )
                }
                placement="bottom"
                delayShow={300}
              >
                <span tabIndex={0}>
                  {indexedFilesLabel}
                </span>
              </Tooltip>
              {hasApiKey &&
                enhancementProgress.totalChunks > 0 &&
                !isIndexing &&
                (enhancementProgress.isRunning ||
                  enhancementProgress.isPaused ||
                  enhancementProgress.enhancedChunks ===
                    enhancementProgress.totalChunks) && (
                  <Tooltip
                    content={
                      enhancementProgress.enhancedChunks ===
                      enhancementProgress.totalChunks
                        ? "Enhanced: Your files have AI-generated contextual descriptions that improve semantic search. Queries like 'how does authentication work' now search by meaning, not just keywords. When new or edited files are detected, they'll be enhanced too."
                        : enhancementProgress.isPaused
                          ? "Enhancement is paused. Resume to continue adding AI-generated descriptions that improve semantic search. Uses API credits (Claude Haiku)."
                          : "Enhancing: Rebel is using AI to add contextual descriptions to your file chunks. This improves semantic search so queries like 'how do we handle authentication' work better. Runs in the background and uses API credits."
                    }
                    placement="bottom"
                    delayShow={300}
                  >
                    <span
                      className={styles.infoPanelValueSecondary}
                      tabIndex={0}
                      role="status"
                    >
                      {enhancementProgress.enhancedChunks ===
                      enhancementProgress.totalChunks
                        ? " · Enhanced"
                        : enhancementProgress.isPaused
                          ? ` · Enhancing ${Math.round((enhancementProgress.enhancedChunks / enhancementProgress.totalChunks) * 100)}% (paused)`
                          : ` · Enhancing ${Math.round((enhancementProgress.enhancedChunks / enhancementProgress.totalChunks) * 100)}%`}
                    </span>
                  </Tooltip>
                )}
            </span>
          </div>
          <div className={styles.infoPanelRow}>
            <span className={styles.infoPanelLabel}>Last indexed</span>
            <span className={styles.infoPanelValue}>
              {formatLastIndexed(lastIndexedAt)}
              {indexState === 'watching' && !isIndexing && (
                <Tooltip
                  content={
                    <span>
                      Last indexed: {formatLastIndexedTooltipTimestamp(lastIndexedAt)}
                      <br /><br />
                      Your index is up to date.
                      <br /><br />
                      When you add or delete files, Rebel automatically updates the index.
                    </span>
                  }
                  placement="bottom"
                  delayShow={300}
                >
                  <span
                    className={styles.infoPanelValueSecondary}
                    tabIndex={0}
                  >
                    {' · Up to date'}
                  </span>
                </Tooltip>
              )}
              {indexState === 'paused' && (
                <span className={styles.infoPanelValueSecondary}> · Paused</span>
              )}
            </span>
          </div>
          {/* Keyword tip - show when index has files */}
          {indexedFilesLabel.includes("files") && (
            <div className={styles.infoPanelTip}>
              <span>
                Tip: Use <code>@files</code> in your message to search across
                your workspace
              </span>
            </div>
          )}
          {/* Index control buttons */}
          <div className={styles.indexControls}>
            <Tooltip
              content={isIndexWatching ? "Pause indexing" : "Resume indexing"}
              placement="bottom"
            >
              <Button
                variant="ghost"
                size="sm"
                onClick={onPauseResumeIndex}
                className={styles.indexControlButton}
              >
                {isIndexWatching ? <Pause size={14} /> : <Play size={14} />}
                <span>{isIndexWatching ? "Pause" : "Resume"}</span>
              </Button>
            </Tooltip>
            <Tooltip
              content="Rebuild search index from scratch (does not affect enhancement)"
              placement="bottom"
            >
              <Button
                variant="ghost"
                size="sm"
                onClick={onReindex}
                disabled={isIndexing}
                className={styles.indexControlButton}
              >
                <RotateCcw size={14} />
                <span>Reindex</span>
              </Button>
            </Tooltip>
            <Tooltip content="Delete search index" placement="bottom">
              <Button
                variant="ghost"
                size="sm"
                onClick={onDeleteIndex}
                disabled={isIndexing}
                className={styles.indexControlButton}
              >
                <Trash2 size={14} />
                <span>Clear</span>
              </Button>
            </Tooltip>
            {/* Enhancement control - Start button when not running */}
            {hasApiKey &&
              enhancementProgress.totalChunks > 0 &&
              enhancementProgress.enhancedChunks <
                enhancementProgress.totalChunks &&
              !enhancementProgress.isRunning &&
              !enhancementProgress.isPaused &&
              (() => {
                const remaining =
                  enhancementProgress.totalChunks -
                  enhancementProgress.enhancedChunks;
                const costPerChunk = 0.0017;
                const estCost = remaining * costPerChunk;
                const costStr =
                  estCost < 0.01 ? "<$0.01" : `~$${estCost.toFixed(2)}`;

                return (
                  <Tooltip
                    content={
                      <span>
                        Add AI-generated descriptions to improve semantic search.
                        <br /><br />
                        Uses your API key to analyze {remaining.toLocaleString()} chunks with Claude Haiku (est. {costStr}).
                        Runs in background—you can pause anytime.
                      </span>
                    }
                    placement="bottom"
                  >
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={onStartEnhancement}
                      className={styles.indexControlButton}
                    >
                      <Sparkles size={14} />
                      <span>Enhance</span>
                    </Button>
                  </Tooltip>
                );
              })()}
            {/* Enhancement control - Pause/Resume when running */}
            {hasApiKey &&
              enhancementProgress.totalChunks > 0 &&
              enhancementProgress.enhancedChunks <
                enhancementProgress.totalChunks &&
              (enhancementProgress.isRunning || enhancementProgress.isPaused) &&
              (() => {
                const remaining =
                  enhancementProgress.totalChunks -
                  enhancementProgress.enhancedChunks;
                const costPerChunk = 0.0017;
                const estCost = remaining * costPerChunk;
                const costStr =
                  estCost < 0.01 ? "<$0.01" : `~$${estCost.toFixed(2)}`;

                return (
                  <Tooltip
                    content={
                      enhancementProgress.isPaused
                        ? `Resume enhancement (est. ${costStr} to complete)`
                        : `Pause enhancement (${remaining} chunks remaining, est. ${costStr})`
                    }
                    placement="bottom"
                  >
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={onPauseResumeEnhancement}
                      className={cn(
                        styles.indexControlButton,
                        enhancementProgress.isRunning &&
                          styles.indexControlButtonActive,
                      )}
                    >
                      {enhancementProgress.isPaused ? (
                        <Play size={14} />
                      ) : (
                        <Pause size={14} />
                      )}
                      <span>
                        {enhancementProgress.isPaused ? "Resume" : "Pause"}
                      </span>
                    </Button>
                  </Tooltip>
                );
              })()}
          </div>
          {/* View options */}
          <div className={styles.indexControls}>
            <Tooltip content={hiddenToggleLabel} placement="bottom">
              <Button
                variant="ghost"
                size="sm"
                onClick={onToggleHiddenFiles}
                className={cn(
                  styles.indexControlButton,
                  showHiddenFiles && styles.indexControlButtonActive,
                )}
                aria-pressed={showHiddenFiles}
              >
                {showHiddenFiles ? <EyeOff size={14} /> : <Eye size={14} />}
                <span>{showHiddenFiles ? "Hide hidden" : "Show hidden"}</span>
              </Button>
            </Tooltip>
          </div>
        </div>
      )}

      {/* Search and Actions Bar - hide when viewing Chief of Staff detail */}
      {!isChiefActive && (
        <div className={styles.toolbar}>
          <LibraryLensBar
            className={styles.lensBar}
            lens={lens}
            facets={facets}
            searchQuery={searchQuery}
            sortBy={sortBy}
            primaryActions={(
              <div className={styles.actionsGroup}>
                <Tooltip content={createButtonBehavior.tooltip} placement="bottom">
                  <span>
                    <Button
                      ref={createButtonUsesMenu ? refs.setReference : undefined}
                      variant="default"
                      size="sm"
                      disabled={!canCreate || !createActionAvailable || createActionPending}
                      className={styles.createPrimaryButton}
                      aria-label={createButtonBehavior.label}
                      aria-haspopup={createButtonUsesMenu ? 'menu' : undefined}
                      aria-expanded={createButtonUsesMenu ? isCreateMenuOpen : undefined}
                      data-testid="library-create-menu-button"
                      {...(createButtonUsesMenu ? getReferenceProps() : {})}
                      onClick={createButtonUsesMenu ? undefined : handleDirectCreate}
                    >
                      <Plus size={16} />
                      <span>{createButtonBehavior.label}</span>
                    </Button>
                  </span>
                </Tooltip>
                {createButtonUsesMenu && isCreateMenuOpen && (
                  <FloatingPortal>
                    <div
                      ref={refs.setFloating}
                      style={floatingStyles}
                      className={styles.createMenu}
                      role="menu"
                      {...getFloatingProps()}
                    >
                      {onCreateSkill && (
                        <button
                          type="button"
                          className={styles.createMenuItem}
                          role="menuitem"
                          data-testid="library-create-skill-option"
                          onClick={handleCreateSkill}
                        >
                          <ScrollText
                            size={14}
                            className={styles.createMenuItemIcon}
                          />
                          <span>New skill</span>
                        </button>
                      )}
                      <button
                        type="button"
                        className={styles.createMenuItem}
                        role="menuitem"
                        data-testid="library-create-file-option"
                        onClick={handleCreateFile}
                      >
                        <FilePlus size={14} className={styles.createMenuItemIcon} />
                        <span>{newFileLabel}</span>
                      </button>
                      <button
                        type="button"
                        className={styles.createMenuItem}
                        role="menuitem"
                        data-testid="library-create-folder-option"
                        onClick={handleCreateFolder}
                      >
                        <FolderPlus
                          size={14}
                          className={styles.createMenuItemIcon}
                        />
                        <span>{newFolderLabel}</span>
                      </button>
                    </div>
                  </FloatingPortal>
                )}
              </div>
            )}
            overflowActions={overflowActions}
            setBrowseLens={setBrowseLens}
            onSearchQueryChange={onSearchChange}
            onSortByChange={onSortByChange}
            orientationTipDismissed={orientationTipDismissed}
            dismissOrientationTip={dismissOrientationTip}
            revealedFoldersCount={revealedFoldersCount}
            searchPlaceholder={getSearchPlaceholder(lens.filter)}
            disabled={searchDisabled}
          />
        </div>
      )}
    </div>
  );
};
