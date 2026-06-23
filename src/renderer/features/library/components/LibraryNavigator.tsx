import { useCallback, useEffect, useMemo, useRef } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent } from 'react';
import { cn } from '@renderer/lib/utils';
import { Folder, Search, AlertCircle, FolderOpen, FileText, ScrollText, FilePlus } from 'lucide-react';
import { Button } from '@renderer/components/ui';
import { LibraryCommandShelf } from './LibraryCommandShelf';
import { LibraryRecentDrawer } from './LibraryRecentDrawer';
import { ProfileEditor } from './ProfileEditor';
import { LibraryRailSearch } from './LibraryRailSearch';
import { LibraryRailSearchResults } from './LibraryRailSearchResults';
import { LibrarySearchTruncationNotice } from './LibrarySearchTruncationNotice';
import { IncompleteLibraryHint } from './IncompleteLibraryHint';
import { LibraryTreeView } from './LibraryTreeView';
import { PendingMemorySection } from './PendingMemorySection';
import { LibraryViewDispatcher } from './views/LibraryViewDispatcher';
import { pluginsToCardEntries } from './views/cardEntries/pluginsToCardEntries';
import type { PluginCardEntry } from './views/cardEntries/pluginsToCardEntries';
import { usePluginsLensData } from '@renderer/features/plugins/hooks/usePluginsLensData';
import { usePluginActivation } from '@renderer/features/plugins/hooks/usePluginActivation';
import type { PluginAction } from '@renderer/features/plugins/components/PluginActionsMenu';
import type { EditorKioskLevel } from '@renderer/features/document-editor/hooks/useEditorKiosk';
import drawerStyles from './LibraryDrawer.module.css';
import { useLibraryNavigator } from '../providers/LibraryNavigatorProvider';
import { useLibraryRailSearch } from '../hooks/useLibraryRailSearch';
import { getFileName } from '@renderer/utils/stringUtils';
import type { FileNode } from '@shared/types';
import {
  useTruncationSignal,
  type TruncationSignal,
} from '@renderer/features/library/search/useTruncationSignal';
import {
  useNoticeDismissal,
  type TruncationDismissReason,
} from '@renderer/features/library/search/useNoticeDismissal';

/** Loading state component with animated indicator */
const LoadingState = () => (
  <div className={drawerStyles.stateCard}>
    <div className={drawerStyles.stateIconLoading}>
      <Folder size={24} />
    </div>
    <div className={drawerStyles.stateContent}>
      <h4 className={drawerStyles.stateTitle}>Loading Library</h4>
      <p className={drawerStyles.stateDescription}>
        Scanning your files and folders...
      </p>
    </div>
    <div className={drawerStyles.loadingBar}>
      <div className={drawerStyles.loadingBarProgress} />
    </div>
  </div>
);

/** Error state component with helpful message */
const ErrorState = ({ message }: { message: string }) => (
  <div className={cn(drawerStyles.stateCard, drawerStyles.stateCardError)}>
    <div className={drawerStyles.stateIconError}>
      <AlertCircle size={24} />
    </div>
    <div className={drawerStyles.stateContent}>
      <h4 className={drawerStyles.stateTitle}>Unable to Load Library</h4>
      <p className={drawerStyles.stateDescription}>{message}</p>
      <p className={drawerStyles.stateHint}>
        Try selecting a different folder or check folder permissions.
      </p>
    </div>
  </div>
);

/** Empty workspace state with onboarding guidance */
const EmptyState = ({ 
  message,
  onCreateFile,
  onCreateSkill
}: { 
  message: string;
  onCreateFile?: () => void;
  onCreateSkill?: () => void;
}) => (
  <div className={drawerStyles.stateCard}>
    <div className={drawerStyles.stateIconEmpty}>
      <FolderOpen size={28} />
    </div>
    <div className={drawerStyles.stateContent}>
      <h4 className={drawerStyles.stateTitle}>Your Library is Empty</h4>
      <p className={drawerStyles.stateDescription}>{message}</p>
      <div className={drawerStyles.stateFeatures}>
        <div className={drawerStyles.stateFeature}>
          <FileText size={16} className={drawerStyles.stateFeatureIcon} />
          <span>Create files and folders to organize your work</span>
        </div>
        <div className={drawerStyles.stateFeature}>
          <ScrollText size={16} className={drawerStyles.stateFeatureIcon} />
          <span>Add skills to teach the AI new capabilities</span>
        </div>
        <div className={drawerStyles.stateFeature}>
          <Search size={16} className={drawerStyles.stateFeatureIcon} />
          <span>Use the search bar above to find files by name or content</span>
        </div>
      </div>
      {(onCreateFile || onCreateSkill) && (
        <div className={drawerStyles.stateActions}>
          {onCreateFile && (
            <Button variant="outline" size="sm" onClick={onCreateFile}>
              <FilePlus size={16} />
              Create your first note
            </Button>
          )}
          {onCreateSkill && (
            <Button variant="outline" size="sm" onClick={onCreateSkill}>
              <ScrollText size={16} />
              Add a skill
            </Button>
          )}
        </div>
      )}
    </div>
  </div>
);



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

function findAncestorDirectoryPaths(
  nodes: FileNode[] | null | undefined,
  targetPath: string,
): string[] | null {
  if (!nodes || nodes.length === 0) return null;

  const search = (nodeList: FileNode[] | undefined, ancestors: string[]): string[] | null => {
    if (!nodeList || nodeList.length === 0) return null;
    for (const node of nodeList) {
      if (node.path === targetPath) {
        return ancestors;
      }
      if (node.kind === 'directory' && node.children) {
        const match = search(node.children, [...ancestors, node.path]);
        if (match) {
          return match;
        }
      }
    }
    return null;
  };

  return search(nodes, []);
}

function escapeSelectorValue(value: string): string {
  if (typeof CSS !== 'undefined' && typeof CSS.escape === 'function') {
    return CSS.escape(value);
  }
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function prefersReducedMotion(): boolean {
  return typeof window !== 'undefined'
    && typeof window.matchMedia === 'function'
    && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tagName = target.tagName.toLowerCase();
  if (tagName === 'input' || tagName === 'textarea' || tagName === 'select') {
    return true;
  }
  if (target.isContentEditable) {
    return true;
  }
  const role = target.getAttribute('role');
  return role === 'textbox' || role === 'searchbox' || role === 'combobox';
}

function createMissingPendingMemoryHandlerError(handlerName: string): Error {
  return new Error(
    `PendingMemorySection received no ${handlerName} handler — wiring regression`,
  );
}

function requirePendingMemoryHandler<TArgs extends unknown[]>(
  handlerName: string,
  handler: ((...args: TArgs) => Promise<void>) | undefined,
): (...args: TArgs) => Promise<void> {
  if (handler) return handler;
  return async () => {
    throw createMissingPendingMemoryHandlerError(handlerName);
  };
}

function getDismissReason(signal: TruncationSignal): TruncationDismissReason | null {
  if (signal.kind === 'engine-cap' || signal.kind === 'tree' || signal.kind === 'both') {
    return signal.kind;
  }
  return null;
}

type LibraryNavigatorProps = {
  kioskLevel?: EditorKioskLevel;
};

export const LibraryNavigator = ({ kioskLevel = 'off' }: LibraryNavigatorProps) => {
  const kioskRailRef = useRef<HTMLDivElement>(null);
  const railSearchInputRef = useRef<HTMLInputElement>(null);
  const lastAutoRevealedPathRef = useRef<string | null>(null);
  const wasWideKioskRef = useRef(false);

  const {
    isOpen,
    workspaceDrawerClassName,
    commandShelfProps,
    bodyState,
    recentDrawerProps,
    onUseSkill,
    onOpenSession,
    onStartConversation,
    favoriteFilePaths,
    loadWorkspaceFile,
    emitLog,
  } = useLibraryNavigator();

  const railState = useLibraryRailSearch({
    nodes: bodyState.treeViewProps.nodes,
    expandedDirectories: bodyState.treeViewProps.expandedDirectories,
    libraryRootAbsolute: bodyState.libraryRootAbsolute,
    skillsData: bodyState.skillsData,
  });

  const {
    libraryLoading,
    libraryError,
    librarySearchQuery,
    librarySearchOutcome,
    treePartialState,
    libraryTree,
    libraryTreeEmptyMessage,
    skillsData,
    skillsLoading,
    skillsError,
    memoryEntries,
    memoryLoading,
    memoryError,
    pendingMemoryRequests,
    savePendingMemoryRequest,
    skipPendingMemoryRequest,
    saveAllPendingMemoryRequests,
    skipAllPendingMemoryRequests,
    spacesData,
    spacesLoading,
    spacesError,
    spacesErrorMessage,
    revealInClassifiedView,
    setActiveSpace,
    renameSpace,
    deleteSpace,
    searchResultsProps,
    treeViewProps,
    fileSortOrder,
    libraryRootAbsolute,
    chiefOfStaff,
  } = bodyState;
  const treeNodes = treeViewProps.nodes;
  const treeExpandedDirectories = treeViewProps.expandedDirectories;
  const treeActivePath = treeViewProps.activePath;
  const onToggleTreeExpand = treeViewProps.onToggleExpand;
  const onExpandTreeDirectories = treeViewProps.onExpandDirectories;

  const focusKioskTree = useCallback(() => {
    const treeElement = kioskRailRef.current?.querySelector('[data-testid="library-tree"]') as HTMLElement | null;
    treeElement?.focus();
  }, []);

  const handleClearRailSearch = useCallback(() => {
    railState.clearQuery();
    railSearchInputRef.current?.focus();
  }, [railState]);

  const handleRailSearchEscape = useCallback(() => {
    railState.clearQuery();
    window.setTimeout(() => {
      focusKioskTree();
    }, 0);
  }, [focusKioskTree, railState]);

  const handleKioskRailKeyDown = useCallback((event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key !== '/') return;
    if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey) return;
    if (isEditableTarget(event.target)) return;
    event.preventDefault();
    railSearchInputRef.current?.focus();
    railSearchInputRef.current?.select();
  }, []);

  useEffect(() => {
    if (kioskLevel !== 'wide') {
      wasWideKioskRef.current = false;
      return;
    }
    if (railState.isSearchActive) {
      return;
    }

    const enteringWideKiosk = !wasWideKioskRef.current;
    wasWideKioskRef.current = true;
    const activePath = treeActivePath;
    if (!activePath) {
      if (enteringWideKiosk) {
        lastAutoRevealedPathRef.current = null;
      }
      return;
    }

    if (!enteringWideKiosk && lastAutoRevealedPathRef.current === activePath) {
      return;
    }
    lastAutoRevealedPathRef.current = activePath;

    const ancestorPaths = findAncestorDirectoryPaths(treeNodes, activePath);
    if (ancestorPaths && ancestorPaths.length > 0) {
      const collapsedAncestors = ancestorPaths.filter((path) => !treeExpandedDirectories[path]);
      if (collapsedAncestors.length > 0) {
        if (onExpandTreeDirectories) {
          onExpandTreeDirectories(collapsedAncestors);
        } else {
          for (const ancestorPath of collapsedAncestors) {
            onToggleTreeExpand(ancestorPath);
          }
        }
      }
    }

    const scrollBehavior: ScrollBehavior = prefersReducedMotion() ? 'auto' : 'smooth';
    let isCancelled = false;
    let attempts = 0;
    const maxAttempts = 10;

    const scrollActivePathIntoView = () => {
      if (isCancelled) return;
      const railElement = kioskRailRef.current;
      if (!railElement) return;

      const activeRow = railElement.querySelector<HTMLElement>(
        `[data-path="${escapeSelectorValue(activePath)}"]`,
      );
      if (activeRow) {
        activeRow.scrollIntoView({ block: 'nearest', behavior: scrollBehavior });
        return;
      }

      attempts += 1;
      if (attempts < maxAttempts) {
        window.setTimeout(scrollActivePathIntoView, 50);
      }
    };

    window.requestAnimationFrame(scrollActivePathIntoView);
    return () => {
      isCancelled = true;
    };
  }, [
    kioskLevel,
    onExpandTreeDirectories,
    onToggleTreeExpand,
    treeActivePath,
    treeExpandedDirectories,
    treeNodes,
    railState.isSearchActive,
  ]);

  const showRailEmptyState = railState.isSearchActive && !railState.hasMatches;
  const showShelfTruncationHint = kioskLevel === 'off'
    && Boolean(librarySearchQuery.trim())
    && Boolean(searchResultsProps.truncated);
  const treeCompleteness = treePartialState.isPartialTree;
  // Stage 8 — count cloud spaces currently reconnecting so search results that may
  // be drawn from a last-known index surface a calm "showing last-known files"
  // notice (where the user actually feels the degraded state). Inert (0) for
  // local-only spaces / a flag-off build, since `syncStatus` is then absent.
  const reconnectingSpaceCount = useMemo(
    () => spacesData.filter((s) => s.syncStatus === 'reconnecting').length,
    [spacesData],
  );
  const railTruncationSignal = useTruncationSignal({
    searchOutcome: railState.searchOutcome,
    treeCompleteness,
    reconnectingSpaceCount,
  });
  const mainTruncationSignal = useTruncationSignal({
    searchOutcome: librarySearchOutcome ?? null,
    treeCompleteness,
    reconnectingSpaceCount,
  });
  const railDismissReason = useMemo(() => getDismissReason(railTruncationSignal), [railTruncationSignal]);
  const mainDismissReason = useMemo(() => getDismissReason(mainTruncationSignal), [mainTruncationSignal]);
  const railNoticeDismissal = useNoticeDismissal(railDismissReason ?? 'engine-cap');
  const mainNoticeDismissal = useNoticeDismissal(mainDismissReason ?? 'engine-cap');
  // Stage 8 — the cloud-degraded notice is a LIVE status that auto-clears when the
  // mount recovers, so it is NOT dismissible (no persisted dismiss key) and shows
  // whenever a space in scope is reconnecting.
  const railShowCloudDegraded = railTruncationSignal.kind === 'cloud-degraded';
  const mainShowCloudDegraded = mainTruncationSignal.kind === 'cloud-degraded';
  const showRailTruncationNotice =
    railShowCloudDegraded || (railDismissReason !== null && !railNoticeDismissal.dismissed);
  const showMainTruncationNotice = kioskLevel === 'off'
    && (mainShowCloudDegraded || (mainDismissReason !== null && !mainNoticeDismissal.dismissed));
  const handleRailSearchSelectNode = useCallback((node: FileNode) => {
    treeViewProps.onSelectNode(node);
  }, [treeViewProps]);

  const isPluginsLensActive = commandShelfProps.lens.filter === 'plugins';
  const {
    entries: pluginLensEntries,
    isLoading: pluginsLoading,
    error: pluginsError,
  } = usePluginsLensData();
  const pluginActivation = usePluginActivation();
  const pluginCardEntries = useMemo<PluginCardEntry[]>(
    () => (isPluginsLensActive ? pluginsToCardEntries(pluginLensEntries) : []),
    [isPluginsLensActive, pluginLensEntries],
  );
  const handlePluginActiveChange = useCallback(
    (entry: PluginCardEntry, next: boolean) => {
      const promise = next
        ? pluginActivation.activate({
            manifest: entry.manifest,
            source: entry.pluginSource,
            spacePath: entry.spacePath,
          })
        : pluginActivation.deactivate(entry.pluginId, entry.spacePath);
      promise.catch((error: unknown) => {
        emitLog({
          level: 'warn',
          message: `Plugin toggle failed for "${entry.manifest.name}": ${error instanceof Error ? error.message : String(error)}`,
        });
      });
    },
    [emitLog, pluginActivation],
  );
  const handlePluginAction = useCallback(
    (entry: PluginCardEntry, action: PluginAction) => {
      switch (action) {
        case 'copyId': {
          const value = entry.spacePath ?? entry.pluginId;
          if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
            void navigator.clipboard.writeText(value).catch(() => undefined);
          }
          return;
        }
        case 'openFolder': {
          if (entry.spacePath) {
            const pluginDir = `${entry.spacePath}/plugins/${entry.pluginId}`;
            void window.appApi?.revealPath?.(pluginDir);
          }
          return;
        }
        default:
          emitLog({
            level: 'info',
            message: `Plugin action "${action}" requested for "${entry.manifest.name}" — handled in Settings → Plugins.`,
          });
      }
    },
    [emitLog],
  );

  const handleOpenPath = useCallback((path: string) => {
    const existingNode = findNodeByPath(treeViewProps.nodes, path);
    if (existingNode) {
      treeViewProps.onSelectNode(existingNode);
      return;
    }

    if (searchResultsProps.onSelectResult) {
      searchResultsProps.onSelectResult({
        path,
        name: getFileName(path),
        kind: 'file',
      });
      return;
    }

    loadWorkspaceFile(path).catch((error: unknown) => {
      emitLog({
        level: 'warn',
        message: `Failed to open Library path "${path}": ${error instanceof Error ? error.message : String(error)}`,
      });
    });
  }, [emitLog, loadWorkspaceFile, searchResultsProps, treeViewProps]);

  let mainContent;
  if (chiefOfStaff.overviewOpen && chiefOfStaff.filePath) {
    mainContent = (
      <ProfileEditor
        filePath={chiefOfStaff.filePath}
        onAsk={chiefOfStaff.askInChat}
        onOpenFolder={chiefOfStaff.openFolder}
        onBack={chiefOfStaff.closeOverview}
        onOpenReadme={() => {
          if (chiefOfStaff.filePath) {
            handleOpenPath(chiefOfStaff.filePath);
          }
        }}
        askDisabled={!onStartConversation}
      />
    );
  } else if (!libraryRootAbsolute && !libraryLoading) {
    mainContent = (
      <EmptyState
        message={libraryTreeEmptyMessage || 'Select a Library directory to get started.'}
        onCreateFile={commandShelfProps.onCreateFile}
        onCreateSkill={commandShelfProps.onCreateSkill}
      />
    );
  } else if (libraryLoading && libraryTree === null) {
    mainContent = <LoadingState />;
  } else if (libraryError && libraryTree === null) {
    mainContent = <ErrorState message={libraryError} />;
  } else {
    if (kioskLevel === 'wide') {
      mainContent = (
        <div
          ref={kioskRailRef}
          className={drawerStyles.kioskRail}
          data-testid="library-kiosk-rail"
          onKeyDown={handleKioskRailKeyDown}
        >
          <LibraryRailSearch
            query={railState.query}
            inputRef={railSearchInputRef}
            onQueryChange={railState.setQuery}
            onClear={handleClearRailSearch}
            onEscape={handleRailSearchEscape}
            truncationNotice={showRailTruncationNotice ? (
              <LibrarySearchTruncationNotice
                signal={railTruncationSignal}
                placement="embedded"
                onDismiss={railShowCloudDegraded ? undefined : railNoticeDismissal.dismiss}
                onManageSpaces={commandShelfProps.onManageSpaces}
              />
            ) : null}
          />
          {railState.isSearchActive ? (
            showRailEmptyState ? (
              <div className={drawerStyles.kioskRailEmptyState} data-testid="library-kiosk-rail-empty-state">
                <p>No files match "{railState.debouncedQuery.trim()}".</p>
                <IncompleteLibraryHint show={treeCompleteness === true} />
              </div>
            ) : (
              <LibraryRailSearchResults
                matches={railState.matches}
                activePath={treeActivePath}
                onSelectNode={handleRailSearchSelectNode}
                libraryRootAbsolute={libraryRootAbsolute}
              />
            )
          ) : (
            <div className={drawerStyles.kioskRailTree}>
              <LibraryTreeView
                {...treeViewProps}
                nodes={treeNodes}
                expandedDirectories={treeExpandedDirectories}
                density="compact"
              />
            </div>
          )}
        </div>
      );
    } else {
      const viewError = libraryError
        ?? (commandShelfProps.lens.filter === 'spaces' && spacesError
          ? (spacesErrorMessage ?? "Couldn't load Spaces.")
          : null);

      mainContent = (
        <>
          {showMainTruncationNotice ? (
            <div className={drawerStyles.mainTruncationNotice} data-testid="library-main-truncation-notice">
              <LibrarySearchTruncationNotice
                signal={mainTruncationSignal}
                placement="inline"
                onDismiss={mainShowCloudDegraded ? undefined : mainNoticeDismissal.dismiss}
                onManageSpaces={commandShelfProps.onManageSpaces}
              />
            </div>
          ) : null}
          <LibraryViewDispatcher
            view={commandShelfProps.lens.view}
            foldersProps={{
              filter: commandShelfProps.lens.filter,
              facet: commandShelfProps.lens.facet,
              searchQuery: librarySearchQuery,
              tree: treeViewProps.nodes ?? null,
              treeViewProps,
              spacesData,
              skillsData,
              memoryEntries,
              spacesError,
              spacesErrorMessage,
              favoriteFilePaths,
              loading: libraryLoading,
              error: viewError,
              isPartialTree: treeCompleteness === true,
              onRetry: commandShelfProps.onRefresh,
            }}
            cardsProps={{
              filter: commandShelfProps.lens.filter,
              facet: commandShelfProps.lens.facet,
              searchQuery: librarySearchQuery,
              sortBy: fileSortOrder,
              tree: treeViewProps.nodes ?? null,
              isPartialTree: treeCompleteness === true,
              libraryRootAbsolute,
              skillsData,
              skillsLoading,
              skillsError,
              memoryEntries,
              spacesData,
              favoriteFilePaths,
              pendingMemoryRequests,
              loading: libraryLoading,
              error: viewError,
              memoryLoading,
              memoryError,
              spacesLoading,
              pluginEntries: pluginCardEntries,
              pluginsLoading,
              pluginsError,
              pendingPluginIds: pluginActivation.pendingPluginIds,
              onPluginActiveChange: handlePluginActiveChange,
              onPluginAction: handlePluginAction,
              onRetry: commandShelfProps.onRefresh,
              onOpenPath: handleOpenPath,
              onUseSkillPath: onUseSkill,
              onRevealInClassifiedView: revealInClassifiedView
                ? (path) => revealInClassifiedView(path)
                : undefined,
              onSetActiveSpace: setActiveSpace
                ? (spacePath) => setActiveSpace(spacePath)
                : undefined,
              onRenameSpace: (spacePath, displayName) => {
                if (!renameSpace) return;
                renameSpace(spacePath, displayName).catch((error) => {
                  emitLog({
                    level: 'warn',
                    message: `Failed to rename space "${spacePath}": ${error instanceof Error ? error.message : String(error)}`,
                  });
                });
              },
              onDeleteSpace: (spacePath, displayName) => {
                if (!deleteSpace) return;
                deleteSpace(spacePath, displayName).catch((error) => {
                  emitLog({
                    level: 'warn',
                    message: `Failed to delete space "${spacePath}": ${error instanceof Error ? error.message : String(error)}`,
                  });
                });
              },
              onCreateSkill: commandShelfProps.onCreateSkill,
              onCreateMemory: commandShelfProps.onCreateMemory,
              onAddSpace: commandShelfProps.onAddSpace,
              onCreateFile: commandShelfProps.onCreateFile,
            }}
            atlasProps={{
              filter: commandShelfProps.lens.filter,
              searchQuery: librarySearchQuery,
              coreDirectory: libraryRootAbsolute,
              onOpenPath: handleOpenPath,
              onStartConversation,
              onRetry: commandShelfProps.onRefresh,
            }}
          />
        </>
      );
    }
  }

  const shouldShowPendingMemorySection = (
    kioskLevel === 'off'
    && commandShelfProps.lens.filter === 'memory'
    && pendingMemoryRequests.length > 0
  );

  return (
    <section className={workspaceDrawerClassName} aria-hidden={!isOpen} data-testid="library-surface">
      {kioskLevel === 'off' ? <LibraryCommandShelf {...commandShelfProps} /> : null}
      {shouldShowPendingMemorySection ? (
        <PendingMemorySection
          requests={pendingMemoryRequests}
          onSave={requirePendingMemoryHandler('save', savePendingMemoryRequest)}
          onSkip={requirePendingMemoryHandler('skip', skipPendingMemoryRequest)}
          onSaveAll={requirePendingMemoryHandler('save-all', saveAllPendingMemoryRequests)}
          onSkipAll={requirePendingMemoryHandler('skip-all', skipAllPendingMemoryRequests)}
          onViewConversation={onOpenSession}
        />
      ) : null}
      <div className={drawerStyles.body}>
        <div
          className={drawerStyles.bodyContent}
          data-testid="library-body-content"
          style={{ minHeight: 0, overflow: 'auto' }}
        >
          {mainContent}
          {showShelfTruncationHint ? (
            <p
              className={drawerStyles.searchFooterTruncationHint}
              data-testid="library-shelf-truncation-hint"
            >
              Searched first 100,000 files. Some matches may be missing.
            </p>
          ) : null}
        </div>
        <LibraryRecentDrawer {...recentDrawerProps} />
      </div>
    </section>
  );
};
