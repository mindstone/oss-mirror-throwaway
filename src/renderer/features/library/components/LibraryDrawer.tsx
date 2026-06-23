import type React from 'react';
import { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react';
import type { AppSettings, RendererLogPayload } from '@shared/types';
import { addRecentFile, getRecentFiles } from '@renderer/utils/librarySearch';
import { UnifiedDocumentEditor } from '@renderer/features/document-editor';
import type { UnifiedDocumentEditorHandle, UnifiedDocumentEditorProps } from '@renderer/features/document-editor';
import { EditorWithNavigatorLayout } from '@renderer/features/document-editor/components/EditorWithNavigatorLayout';
import { useEditorKiosk } from '@renderer/features/document-editor/hooks/useEditorKiosk';
import { LibraryNavigatorProvider, type LibraryNavigatorHandle, useLibraryNavigator } from '../providers/LibraryNavigatorProvider';
import { LibraryNavigator } from './LibraryNavigator';
import { LibraryDialogs } from './LibraryDialogs';
import { RenameFileDialog } from './RenameFileDialog';
import { getRelativeLibraryPath } from '../utils/pathUtils';
import { getFileName } from '@renderer/utils/stringUtils';
import { tracking } from '@renderer/src/tracking';
import type { LibraryDocumentState } from '../types';
import type { ChromeMode, ChromeModeOwner } from '@renderer/features/flow-panels/chromeMode';
import styles from './LibrarySplitLayout.module.css';

// ---------------------------------------------------------------------------
// Small adapter that resolves skill example paths from LibraryNavigatorProvider
// context and passes them down. Must be rendered inside LibraryNavigatorProvider.
// Replaces the old EditorWithSkillExamples wrapper.
// ---------------------------------------------------------------------------
type EditorWithSkillContextProps = UnifiedDocumentEditorProps & {
  activeDocumentRelativePath: string | null;
};

const EditorWithSkillContext = forwardRef<UnifiedDocumentEditorHandle, EditorWithSkillContextProps>(
  function EditorWithSkillContext({ activeDocumentRelativePath, ...rest }, ref) {
    const { getSkillExamplePaths, getSkillQualityData, getSkillMetadata } = useLibraryNavigator();
    const skillExamplePaths = activeDocumentRelativePath
      ? getSkillExamplePaths(activeDocumentRelativePath)
      : undefined;
    const skillQualityData = activeDocumentRelativePath
      ? getSkillQualityData(activeDocumentRelativePath)
      : undefined;
    const skillMetadata = activeDocumentRelativePath
      ? getSkillMetadata(activeDocumentRelativePath)
      : undefined;

    return (
      <UnifiedDocumentEditor
        ref={ref}
        {...rest}
        skillMetadata={skillMetadata}
        skillExamplePaths={skillExamplePaths}
        skillQualityScore={skillQualityData?.qualityScore}
        skillQualityBand={skillQualityData?.qualityBand}
        skillQualityTopImprovement={skillQualityData?.qualityTopImprovement}
      />
    );
  },
);

const STORAGE_KEY = 'library-split-width';
const STORAGE_KEY_FOCUS = 'library:navigator-width-focus';
const DEFAULT_SPLIT_PERCENT = 50;
const DEFAULT_FOCUS_SPLIT_PERCENT = 22;
const MIN_NAVIGATOR_WIDTH = 240;
const MIN_FOCUS_NAVIGATOR_WIDTH = 160;
const MIN_EDITOR_WIDTH = 300;
const MAX_FOCUS_NAVIGATOR_PERCENT = 45;

function readStoredWidthPercent(
  storageKey: string,
  fallbackPercent: number,
  {
    minPercent,
    maxPercent,
  }: {
    minPercent: number;
    maxPercent: number;
  },
): number {
  if (typeof window === 'undefined') return fallbackPercent;
  try {
    const stored = localStorage.getItem(storageKey);
    if (!stored) {
      return fallbackPercent;
    }
    const parsed = parseFloat(stored);
    if (!Number.isFinite(parsed)) {
      return fallbackPercent;
    }
    return Math.max(minPercent, Math.min(maxPercent, parsed));
  } catch {
    return fallbackPercent;
  }
}

function isEditableElement(element: Element | null): boolean {
  if (!element) return false;
  const tagName = element.tagName;
  if (tagName === 'INPUT' || tagName === 'TEXTAREA' || tagName === 'SELECT') {
    return true;
  }
  if ((element as HTMLElement).isContentEditable) {
    return true;
  }
  const role = element.getAttribute('role');
  return role === 'textbox' || role === 'searchbox' || role === 'combobox';
}

function hasOpenModalDialog(activeElement: Element | null): boolean {
  if (activeElement instanceof HTMLElement) {
    if (activeElement.closest('[role="dialog"], [role="alertdialog"], dialog')) {
      return true;
    }
  }
  return Boolean(
    document.querySelector(
      'dialog[open], [role="dialog"][aria-modal="true"], [role="alertdialog"][aria-modal="true"]',
    ),
  );
}

import type { SkillImproveQualityContext } from '../utils/skillQualityUtils';

interface LibraryDrawerProps {
  open: boolean;
  settings: AppSettings | null;
  refreshSettings?: () => Promise<void>;
  showToast: (options: { title: string }) => void;
  emitLog: (
    payload: Omit<RendererLogPayload, 'source' | 'breadcrumbs'> & { breadcrumbs?: RendererLogPayload['breadcrumbs'] }
  ) => void;
  onUseSkill?: (skillRelativePath: string) => void;
  onCreateSkill?: () => void;
  onCreateMemory?: () => void;
  onAddSpace?: () => void;
  onManageSpaces?: () => void;
  canCreateAdditionalSpaces?: boolean;
  createActionPending?: boolean;
  onPersonaliseSkill?: (skillRelativePath: string) => void;
  onShareSkill?: (skillRelativePath: string) => void;
  onImproveSkill?: (skillRelativePath: string, qualityContext?: SkillImproveQualityContext) => void;
  onEditorOpen?: (filePath?: string) => void;
  onEditorClose?: () => void;
  onOpenQuickOpen?: () => void;
  chromeMode?: ChromeMode;
  requestChromeMode?: (owner: ChromeModeOwner, mode?: ChromeMode) => void;
  releaseChromeMode?: (owner: ChromeModeOwner) => void;
  /** When true, editor is positioned as a floating panel (absolute positioned) rather than inline split */
  floatingEditorMode?: boolean;
  onOpenSession?: (sessionId: string) => void;
  /**
   * Callback when user wants to send annotations to Rebel.
   *
   * The third argument carries the per-message `onCommit` closure built
   * by `DocumentFooter` — fired when the resulting `QueuedMessage`
   * actually dispatches to the runtime, at which point it clears the
   * snapshotted staged annotation ids. May be sync or async: the queue
   * supports async `onCommit` callbacks with rejection isolation (sync
   * throws and rejected promises are both caught and logged). The queue
   * does NOT await the callback — it is fire-and-forget. Sequential
   * composition of multiple stashed callbacks happens in App.tsx before
   * hand-off. See
   * docs/plans/260417_centralize_annotations_and_fix_document_send_clear.md.
   */
  onSendAnnotations?: (
    message: string,
    options?: { target: 'file-conversation' | 'last-active' | 'new'; sessionId?: string; displayMessage?: string },
    onCommit?: () => void | Promise<void>,
  ) => void;
  /** Current active session ID for routing options */
  currentSessionId?: string | null;
  /** Current active session title for display */
  currentSessionTitle?: string | null;
  /** Start a new conversation with files attached (for Atlas) */
  onStartConversation?: (message: string, filePaths: string[]) => void;
  /** Share a library file publicly via cloud share link */
  onShareFile?: (filePath: string) => void;
}

export interface LibraryDrawerHandle {
  openFile: (filePath: string) => Promise<void>;
  closeEditor: () => void;
  /** Returns the file path currently open in the Library editor, or null */
  getEditorFilePath: () => string | null;
  /** Navigate to a folder in the workspace tree (switches lens to Everything × Folders, expands path, scrolls to folder) */
  navigateToFolder: (folderRelativePath: string) => void;
  /** Reset to opening state: close editor, restore default browse lens, clear search/filters */
  resetToOpeningState: () => void;
}

export const LibraryDrawer = forwardRef<LibraryDrawerHandle, LibraryDrawerProps>(
  ({
    open,
    settings,
    refreshSettings,
    showToast,
    emitLog,
    onUseSkill,
    onCreateSkill,
    onCreateMemory,
    onAddSpace,
    onManageSpaces,
    canCreateAdditionalSpaces,
    createActionPending,
    onPersonaliseSkill,
    onShareSkill,
    onImproveSkill,
    onEditorOpen,
    onEditorClose,
    onOpenQuickOpen,
    chromeMode = 'normal',
    requestChromeMode,
    releaseChromeMode,
    floatingEditorMode,
    onOpenSession,
    onSendAnnotations,
    currentSessionId,
    currentSessionTitle,
    onStartConversation,
    onShareFile,
  }, ref) => {
    const [recentFiles, setRecentFiles] = useState<string[]>(getRecentFiles());

    // Unified editor ref and pending-open buffer (the editor component is
    // conditionally rendered, so the ref may not be available on the first open call)
    const editorRef = useRef<UnifiedDocumentEditorHandle>(null);
    const pendingOpenRef = useRef<string | null>(null);

    // Track whether the editor pane should be visible and what path is active.
    // activeEditorPath feeds the navigator-provider shim so the tree can
    // highlight the open file. It's set in handleOpenFile and cleared in handleCloseEditor.
    const [editorHasDocuments, setEditorHasDocuments] = useState(false);
    const [activeEditorPath, setActiveEditorPath] = useState<string | null>(null);

    // Resize state
    const containerRef = useRef<HTMLDivElement>(null);
    const [navigatorWidth, setNavigatorWidth] = useState<number>(() => readStoredWidthPercent(
      STORAGE_KEY,
      DEFAULT_SPLIT_PERCENT,
      { minPercent: 20, maxPercent: 80 },
    ));
    const [focusNavigatorWidthPercent, setFocusNavigatorWidthPercent] = useState<number>(() => readStoredWidthPercent(
      STORAGE_KEY_FOCUS,
      DEFAULT_FOCUS_SPLIT_PERCENT,
      { minPercent: 10, maxPercent: MAX_FOCUS_NAVIGATOR_PERCENT },
    ));
    const [isResizing, setIsResizing] = useState(false);
    const resizeStartRef = useRef<{ x: number; width: number; mode: 'off' | 'wide' } | null>(null);

    // Ref to store the navigator handle for folder navigation
    const navigatorHandleRef = useRef<LibraryNavigatorHandle | null>(null);
    const handleNavigatorReady = useCallback((handle: LibraryNavigatorHandle) => {
      navigatorHandleRef.current = handle;
    }, []);

    const {
      level: editorKioskLevel,
      isActive: editorKioskActive,
      cycleLevel: cycleEditorKioskLevel,
      clearLevel: clearEditorKioskLevel,
    } = useEditorKiosk({
      editorOpen: editorHasDocuments,
      librarySurfaceActive: open,
    });

    useEffect(() => {
      if (editorKioskActive) {
        requestChromeMode?.('kiosk', 'reduced');
        return;
      }
      releaseChromeMode?.('kiosk');
    }, [editorKioskActive, releaseChromeMode, requestChromeMode]);

    useEffect(() => {
      if (editorKioskLevel === 'off') return undefined;

      const handleEscapeFromLibrarySurface = (event: KeyboardEvent) => {
        if (event.key !== 'Escape' || event.defaultPrevented) return;
        const activeElement = document.activeElement;
        if (isEditableElement(activeElement)) return;
        if (hasOpenModalDialog(activeElement)) return;

        event.preventDefault();
        event.stopPropagation();
        clearEditorKioskLevel();
      };

      window.addEventListener('keydown', handleEscapeFromLibrarySurface);
      return () => window.removeEventListener('keydown', handleEscapeFromLibrarySurface);
    }, [clearEditorKioskLevel, editorKioskLevel]);

    // Rename dialog state
    const [renameDialogOpen, setRenameDialogOpen] = useState(false);

    // Track when Library is opened (regardless of how user navigated here)
    useEffect(() => {
      if (open) {
        tracking.library.opened();
      }
    }, [open]);

    // Shim for LibraryNavigatorProvider — provides the active path so the
    // navigator tree can highlight the open file and warn about unsaved changes.
    // The unified editor owns content/saving state internally; the navigator
    // only needs the path (and isDirty is always false since the editor auto-saves).
    //
    // IMPORTANT: `path` must be absolute because LibraryNavigatorProvider compares it
    // against tree node paths (which are absolute). When a file is opened from
    // conversation context, `activeEditorPath` may be relative — resolve it here.
    const editorDocumentShim: LibraryDocumentState | null = useMemo(() => {
      if (!activeEditorPath) return null;
      const isAbsolute = activeEditorPath.startsWith('/') || /^[A-Za-z]:/.test(activeEditorPath);
      const absolutePath = isAbsolute || !settings?.coreDirectory
        ? activeEditorPath
        : `${settings.coreDirectory.replace(/\/+$/, '')}/${activeEditorPath}`;
      return {
        path: absolutePath,
        name: getFileName(activeEditorPath),
        relativePath: getRelativeLibraryPath(absolutePath, settings?.coreDirectory) || activeEditorPath,
        content: '',
        originalContent: '',
        isDirty: false,
        saving: false,
        error: null,
      };
    }, [activeEditorPath, settings?.coreDirectory]);

    // Sync libraryEditorOpen state when returning to Library with an already-open editor.
    // This fixes the styling issue where the editor panel loses its border/position
    // after navigating away to Conversations and back.
    const prevOpenRef = useRef(open);
    useEffect(() => {
      const wasJustOpened = open && !prevOpenRef.current;
      if (wasJustOpened && editorHasDocuments) {
        onEditorOpen?.(activeEditorPath ?? undefined);
      }
      prevOpenRef.current = open;
    }, [open, editorHasDocuments, onEditorOpen, activeEditorPath]);

    // Opens a file in the Library editor. Throws on failure so external callers
    // (e.g., conversation link clicks via App.tsx) can show user-friendly feedback.
    const handleOpenFile = useCallback(async (filePath: string) => {
      if (filePath.startsWith('http://') || filePath.startsWith('https://')) {
        window.appApi.openUrl(filePath).catch((error) => {
          console.error('Failed to open URL:', error);
        });
        return;
      }
      if (editorRef.current) {
        const ok = await editorRef.current.openDocument(filePath);
        // openDocument returns false when flush() rejects (the imperative
        // handle gates on flush before switching tabs). Toast + telemetry
        // already fired at the failure site. Abort the outer Library
        // state switch so unsaved edits stay put — Class A Batch 1.
        if (!ok) return;
      } else {
        pendingOpenRef.current = filePath;
      }

      onEditorOpen?.(filePath);
      setActiveEditorPath(filePath);
      setEditorHasDocuments(true);
      addRecentFile(filePath);
      setRecentFiles(getRecentFiles());
    }, [onEditorOpen]);

    // Open pending document once the unified editor mounts.
    // openDocument now returns Promise<boolean> (Class A Batch 1) but at
    // mount-time there is no prior document loaded, so flush() is a
    // no-op and abort cannot happen. Intentional fire-and-forget; any
    // failure surfaces inside the editor itself.
    useEffect(() => {
      if (editorHasDocuments && editorRef.current && pendingOpenRef.current) {
        void editorRef.current.openDocument(pendingOpenRef.current);
        pendingOpenRef.current = null;
      }
    }, [editorHasDocuments]);

    // Fire-and-forget wrapper for internal Library callers (tree clicks, search, etc.)
    // where errors are displayed within the unified editor.
    const handleOpenFileSafe = useCallback(async (filePath: string) => {
      try {
        await handleOpenFile(filePath);
      } catch {
        // Error is displayed within the unified editor
      }
    }, [handleOpenFile]);

    // Keep activeEditorPath in sync with internal editor-tab switches (DocumentTabBar).
    // Only updates the path — sidebar collapse is already handled by handleOpenFile.
    const handleActiveDocumentChange = useCallback((path: string | null) => {
      setActiveEditorPath(path);
    }, []);

    // Wrap closeEditor to also trigger onEditorClose callback and reset focus mode
    const handleCloseEditor = useCallback(async () => {
      const ok = await editorRef.current?.closeAllDocuments();
      // closeAllDocuments returns:
      //   - true: flush succeeded, close proceeded
      //   - false: flush rejected, abort outer state clear (Class A Batch 1)
      //   - undefined: no editor mounted (ref null) — nothing to flush,
      //     so proceed with the outer state clear.
      if (ok === false) return;
      setEditorHasDocuments(false);
      setActiveEditorPath(null);
      clearEditorKioskLevel();
      releaseChromeMode?.('kiosk');
      onEditorClose?.();
    }, [clearEditorKioskLevel, onEditorClose, releaseChromeMode]);

    useEffect(() => () => {
      releaseChromeMode?.('kiosk');
    }, [releaseChromeMode]);

    const handleBackToSkills = useCallback(() => {
      navigatorHandleRef.current?.resetToOpeningState();
    }, []);

    const handleRevealInTree = useCallback((path: string) => {
      clearEditorKioskLevel();
      navigatorHandleRef.current?.revealInTree(path);
    }, [clearEditorKioskLevel]);

    // File operations from editor panel context menu
    const openRenameDialog = useCallback(() => {
      if (!editorRef.current?.getActiveDocumentPath()) return;
      setRenameDialogOpen(true);
    }, []);

    const handleRenameFile = useCallback(async (newName: string) => {
      const currentPath = editorRef.current?.getActiveDocumentPath();
      if (!currentPath) {
        throw new Error('No file is open');
      }
      const result = await window.libraryApi.renameItem({
        itemPath: currentPath,
        newName
      });
      showToast({ title: `Renamed to: ${newName}` });
      await handleOpenFile(result.path);
    }, [showToast, handleOpenFile]);

    const handleDeleteFromEditor = useCallback(async () => {
      const currentPath = editorRef.current?.getActiveDocumentPath();
      if (!currentPath) return;
      const fileName = getFileName(currentPath);
      const confirmed = window.confirm(`Are you sure you want to delete "${fileName}"? This cannot be undone.`);
      if (!confirmed) return;

      try {
        await window.libraryApi.deleteItem({ itemPath: currentPath });
        showToast({ title: `Deleted: ${fileName}` });
        handleCloseEditor();
      } catch (error) {
        showToast({ title: `Failed to delete: ${error instanceof Error ? error.message : String(error)}` });
      }
    }, [showToast, handleCloseEditor]);

    const handleMoveFromEditor = useCallback(async () => {
      const currentPath = editorRef.current?.getActiveDocumentPath();
      if (!currentPath || !settings?.coreDirectory) return;

      try {
        const chosenDir = await window.settingsApi.chooseDirectoryInDirectory({
          baseDir: settings.coreDirectory,
        });
        if (!chosenDir) return;

        const moveResult = await window.libraryApi.moveItem({
          itemPath: currentPath,
          targetDirectoryPath: chosenDir
        });

        if (moveResult.moved) {
          const destName = getFileName(chosenDir) || 'selected folder';
          showToast({ title: `Moved to: ${destName}` });
          await handleOpenFile(moveResult.path);
        }
      } catch (error) {
        showToast({ title: `Failed to move: ${error instanceof Error ? error.message : String(error)}` });
      }
    }, [settings?.coreDirectory, showToast, handleOpenFile]);

    // Resize handlers
    const handleResizeMouseDown = useCallback((e: React.MouseEvent) => {
      e.preventDefault();
      const container = containerRef.current;
      if (!container) return;
      const resizeMode = editorKioskLevel === 'wide' ? 'wide' : 'off';
      const startingWidth = resizeMode === 'wide'
        ? focusNavigatorWidthPercent
        : navigatorWidth;

      setIsResizing(true);
      resizeStartRef.current = {
        x: e.clientX,
        width: startingWidth,
        mode: resizeMode,
      };
      document.body.style.cursor = 'col-resize';
      document.body.style.userSelect = 'none';
    }, [editorKioskLevel, focusNavigatorWidthPercent, navigatorWidth]);

    const resetResizeWidth = useCallback((mode: 'off' | 'wide') => {
      if (mode === 'wide') {
        setFocusNavigatorWidthPercent(DEFAULT_FOCUS_SPLIT_PERCENT);
        try {
          localStorage.setItem(STORAGE_KEY_FOCUS, String(DEFAULT_FOCUS_SPLIT_PERCENT));
        } catch { /* ignore */ }
        return;
      }

      setNavigatorWidth(DEFAULT_SPLIT_PERCENT);
      try {
        localStorage.setItem(STORAGE_KEY, String(DEFAULT_SPLIT_PERCENT));
      } catch { /* ignore */ }
    }, []);

    const handleResizeDoubleClick = useCallback((event: React.MouseEvent) => {
      event.preventDefault();
      const resizeMode = editorKioskLevel === 'wide' ? 'wide' : 'off';
      resetResizeWidth(resizeMode);
    }, [editorKioskLevel, resetResizeWidth]);

    const handleResizeContextMenu = useCallback((event: React.MouseEvent) => {
      event.preventDefault();
      const resizeMode = editorKioskLevel === 'wide' ? 'wide' : 'off';
      resetResizeWidth(resizeMode);
    }, [editorKioskLevel, resetResizeWidth]);

    useEffect(() => {
      const handleMouseMove = (e: MouseEvent) => {
        if (!resizeStartRef.current || !containerRef.current) return;

        const container = containerRef.current;
        const containerRect = container.getBoundingClientRect();
        const containerWidth = containerRect.width;
        if (containerWidth <= 0) return;

        const deltaX = e.clientX - resizeStartRef.current.x;
        const deltaPercent = (deltaX / containerWidth) * 100;
        const newPercent = resizeStartRef.current.width + deltaPercent;

        if (resizeStartRef.current.mode === 'wide') {
          const minPercent = (MIN_FOCUS_NAVIGATOR_WIDTH / containerWidth) * 100;
          const maxPercent = Math.max(minPercent, MAX_FOCUS_NAVIGATOR_PERCENT);
          const clampedPercent = Math.max(minPercent, Math.min(maxPercent, newPercent));
          setFocusNavigatorWidthPercent(clampedPercent);
          return;
        }

        const minPercent = (MIN_NAVIGATOR_WIDTH / containerWidth) * 100;
        const maxPercent = ((containerWidth - MIN_EDITOR_WIDTH) / containerWidth) * 100;
        const clampedPercent = Math.max(minPercent, Math.min(maxPercent, newPercent));
        setNavigatorWidth(clampedPercent);
      };

      const handleMouseUp = () => {
        const resizeSession = resizeStartRef.current;
        if (resizeSession) {
          resizeStartRef.current = null;
          setIsResizing(false);
          document.body.style.cursor = '';
          document.body.style.userSelect = '';

          try {
            if (resizeSession.mode === 'wide') {
              localStorage.setItem(STORAGE_KEY_FOCUS, String(focusNavigatorWidthPercent));
            } else {
              localStorage.setItem(STORAGE_KEY, String(navigatorWidth));
            }
          } catch { /* ignore */ }
        }
      };

      if (isResizing) {
        document.addEventListener('mousemove', handleMouseMove);
        document.addEventListener('mouseup', handleMouseUp);
      }

      return () => {
        document.removeEventListener('mousemove', handleMouseMove);
        document.removeEventListener('mouseup', handleMouseUp);
      };
    }, [focusNavigatorWidthPercent, isResizing, navigatorWidth]);

    useEffect(() => {
      const container = containerRef.current;
      if (!container) return undefined;
      if (editorKioskLevel !== 'wide') {
        container.style.removeProperty('--editor-navigator-rail-width');
        container.style.removeProperty('--library-kiosk-rail-width');
        return undefined;
      }
      const apply = () => {
        const containerRect = container.getBoundingClientRect();
        if (containerRect.width <= 0) return;
        const flowBody = container.closest('.flow-body') as HTMLElement | null;
        const flowBodyLeft = flowBody ? flowBody.getBoundingClientRect().left : 0;
        const splitLeftInFlowBody = containerRect.left - flowBodyLeft;
        const railWidthPx = (focusNavigatorWidthPercent / 100) * containerRect.width;
        // The editor's CSS formula is `left: calc(32px + var(--library-kiosk-rail-width))`.
        // We want editor.left === rail.right (in flow-body coords) + 16px gap.
        // → var = (splitLeftInFlowBody + railWidthPx) + 16 - 32 = splitLeftInFlowBody + railWidthPx - 16.
        const varValue = Math.max(0, splitLeftInFlowBody + railWidthPx - 16);
        container.style.setProperty('--editor-navigator-rail-width', `${varValue}px`);
        container.style.setProperty('--library-kiosk-rail-width', `${varValue}px`);
      };
      apply();
      const observer = new ResizeObserver(apply);
      observer.observe(container);
      return () => {
        observer.disconnect();
        container.style.removeProperty('--editor-navigator-rail-width');
        container.style.removeProperty('--library-kiosk-rail-width');
      };
    }, [editorKioskLevel, focusNavigatorWidthPercent]);

    useImperativeHandle(
      ref,
      () => ({
        openFile: handleOpenFile,
        closeEditor: handleCloseEditor,
        getEditorFilePath: () => editorRef.current?.getActiveDocumentPath() ?? activeEditorPath ?? null,
        navigateToFolder: (folderRelativePath: string) => {
          navigatorHandleRef.current?.navigateToFolder(folderRelativePath);
        },
        resetToOpeningState: () => {
          navigatorHandleRef.current?.resetToOpeningState();
        }
      }),
      [handleCloseEditor, handleOpenFile, activeEditorPath]
    );

    return (
      <LibraryNavigatorProvider
        open={open}
        settings={settings}
        refreshSettings={refreshSettings}
        showToast={showToast as React.ComponentProps<typeof LibraryNavigatorProvider>['showToast']}
        emitLog={emitLog}
        editorDocument={editorDocumentShim}
        loadWorkspaceFile={handleOpenFileSafe}
        closeEditor={handleCloseEditor}
        onBrowseLensInteraction={clearEditorKioskLevel}
        recentFiles={recentFiles}
        setRecentFiles={setRecentFiles}
        onUseSkill={onUseSkill}
        onCreateSkill={onCreateSkill}
        onCreateMemory={onCreateMemory}
        onAddSpace={onAddSpace}
        onManageSpaces={onManageSpaces}
        canCreateAdditionalSpaces={canCreateAdditionalSpaces}
        createActionPending={createActionPending}
        onOpenSession={onOpenSession}
        onNavigatorReady={handleNavigatorReady}
        onStartConversation={onStartConversation}
        onShareFile={onShareFile}
      >
        <EditorWithNavigatorLayout
          navigator={(
            <>
              <LibraryNavigator kioskLevel={editorKioskLevel} />
              <LibraryDialogs />
            </>
          )}
          editor={(
            <EditorWithSkillContext
              ref={editorRef}
              activeDocumentRelativePath={editorDocumentShim?.relativePath ?? null}
              showToast={showToast}
              onNavigateToFolder={(path) => navigatorHandleRef.current?.navigateToFolder(path)}
              onClose={handleCloseEditor}
              onBackToSkills={handleBackToSkills}
              onUseSkill={onUseSkill}
              onPersonaliseSkill={onPersonaliseSkill}
              onShareSkill={onShareSkill}
              onImproveSkill={onImproveSkill}
              onSendAnnotations={onSendAnnotations}
              currentSessionId={currentSessionId}
              currentSessionTitle={currentSessionTitle}
              editorKioskLevel={editorKioskLevel}
              chromeMode={chromeMode}
              onToggleKioskMode={cycleEditorKioskLevel}
              onRestoreChromeMode={clearEditorKioskLevel}
              onRename={openRenameDialog}
              onDelete={handleDeleteFromEditor}
              onMoveTo={handleMoveFromEditor}
              onOpenFile={handleOpenFile}
              onOpenQuickOpen={onOpenQuickOpen}
              onRevealInTree={handleRevealInTree}
              onActiveDocumentChange={handleActiveDocumentChange}
            />
          )}
          containerRef={containerRef}
          editorHasDocuments={editorHasDocuments}
          kioskLevel={editorKioskLevel}
          navigatorWidthPercent={navigatorWidth}
          focusNavigatorWidthPercent={focusNavigatorWidthPercent}
          floatingEditorMode={Boolean(floatingEditorMode)}
          isResizing={isResizing}
          onResizeMouseDown={handleResizeMouseDown}
          onResizeDoubleClick={handleResizeDoubleClick}
          onResizeContextMenu={handleResizeContextMenu}
          testId="library-drawer"
          navigatorTestId="library-navigator-pane"
          resizeHandleTestId="library-resize-handle"
          classNames={{
            splitLayout: styles.splitLayout,
            navigatorPane: styles.navigatorPane,
            resizeHandle: styles.resizeHandle,
            editorPane: styles.editorPane,
          }}
        />
        <RenameFileDialog
          isOpen={renameDialogOpen}
          onClose={() => setRenameDialogOpen(false)}
          currentName={activeEditorPath ? getFileName(activeEditorPath) : ''}
          onRename={handleRenameFile}
        />
      </LibraryNavigatorProvider>
    );
  }
);

LibraryDrawer.displayName = 'LibraryDrawer';
