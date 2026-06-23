/**
 * UnifiedDocumentEditor
 *
 * Unified document viewer/editor that merges LibraryEditorPanel and
 * DocumentPreviewDrawer into a single multi-tab component. Supports
 * text (markdown + plain), images, video, audio, tutorials, HTML,
 * skill files, annotations, find bar, and go-to-heading.
 *
 * Context-agnostic: all context differences handled via prop
 * presence/absence (no `if (context === 'library')` branches).
 *
 * @see docs/plans/finished/260224_unified_document_editor.md
 */

import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from 'react';
import { Loader2, AlertTriangle, Clock, Check, ShieldX } from 'lucide-react';
import { Button, Tooltip } from '@renderer/components/ui';
import { parseSkillContent, type SkillSourceType } from '@renderer/features/library/components/SkillCard';
import { SkillHistoryPanel } from '@renderer/features/library/components/SkillHistoryPanel';
import { useAuth } from '@renderer/features/auth/hooks/useAuth';
import { GoToHeadingDialog } from '@renderer/features/library/components/GoToHeadingDialog';
import { getCharPositionOfLine, type MarkdownHeading } from '@renderer/features/library/utils/markdownHeadings';
import { getSharedSkillDirectEditGuard } from '@renderer/features/library/utils/skillAttribution';
import { useDocumentTabs } from '../hooks/useDocumentTabs';
import { useDocumentFileIO, type DocumentWriteConflict } from '../hooks/useDocumentFileIO';
import { useMarkdownImageImport } from '../hooks/useMarkdownImageImport';
import type { EditorKioskLevel } from '../hooks/useEditorKiosk';
import { shouldHandleEditorShortcut } from '../utils/keyboardShortcutGate';
import { useAnnotatedMarkdownEditor } from '@renderer/features/library/hooks/useAnnotatedMarkdownEditor';
import { useDocumentActions } from '@renderer/features/library/hooks/useDocumentActions';
import { findTextInDoc } from '@renderer/features/library/extensions/tiptapAnnotationExtension';
import { DocumentTabBar } from './DocumentTabBar';
import { DocumentHeader } from './DocumentHeader';
import { DocumentFooter } from './DocumentFooter';
import { DocumentConflictBanner } from './DocumentConflictBanner';
import { DocumentRenderers } from './DocumentRenderers';
import { DocumentFindBar } from './DocumentFindBar';
import type { SendTarget } from '@renderer/features/library/components/SendToRebelDialog';
import { useAppContextSafe } from '@renderer/contexts/AppContext';
import type { ChromeMode } from '@renderer/features/flow-panels/chromeMode';
import { useFlowPanels } from '@renderer/features/flow-panels/FlowPanelsProvider';
import styles from './UnifiedDocumentEditor.module.css';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

import type { SkillQualityBand, SkillImproveQualityContext } from '../../library/utils/skillQualityUtils';
import type { SkillFrontmatter } from '../../library/hooks/useSkillsIndex';
import type { SpaceStorageProvider } from '@shared/types';

export interface UnifiedDocumentEditorProps {
  showToast?: (options: { title: string }) => void;
  onNavigateToFolder?: (path: string) => void;
  onClose?: () => void;
  /**
   * Fired when the last open tab is closed via the per-tab "X" (or any
   * `closeTab` path). Opt-in: the preview drawer passes this so closing the
   * final tab dismisses the drawer instead of reopening the committed doc.
   * Not wired by LibraryDrawer. See
   * docs/plans/260622_fix-preview-drawer-single-tab-close/PLAN.md.
   */
  onLastTabClosed?: () => void;
  /** Navigate back to the Skills browse (resets Library to opening state — default browse lens) */
  onBackToSkills?: () => void;
  onOpenInLibrary?: (path: string) => void;
  onUseSkill?: (path: string) => void;
  onPersonaliseSkill?: (path: string) => void;
  onShareSkill?: (path: string) => void;
  onImproveSkill?: (path: string, qualityContext?: SkillImproveQualityContext) => void;
  hasPersonalSupplement?: boolean;
  skillExamplePaths?: string[];
  skillQualityScore?: number;
  skillQualityBand?: SkillQualityBand;
  skillQualityTopImprovement?: {
    dimension: string;
    suggestion: string;
  };
  skillMetadata?: {
    relativePath: string;
    frontmatter?: SkillFrontmatter;
    source: SkillSourceType;
    sharing?: 'private' | 'restricted' | 'team' | 'company-wide' | 'public';
    storageProvider?: SpaceStorageProvider;
  };
  /**
   * Dialog-routed send path. The third argument carries the per-message
   * `onCommit` closure that `DocumentFooter` builds to clear staged
   * annotations on actual dispatch. May be sync or async: the queue
   * supports async `onCommit` callbacks with rejection isolation (sync
   * throws and rejected promises are both caught and logged). The queue
   * does NOT await the callback — it is fire-and-forget. Sequential
   * composition of multiple stashed callbacks happens in App.tsx before
   * hand-off. See
   * docs/plans/260417_centralize_annotations_and_fix_document_send_clear.md.
   */
  onSendAnnotations?: (
    message: string,
    options?: { target: SendTarget; sessionId?: string; displayMessage?: string },
    onCommit?: () => void | Promise<void>,
  ) => void;
  currentSessionId?: string | null;
  currentSessionTitle?: string | null;
  editorKioskLevel?: EditorKioskLevel;
  chromeMode?: ChromeMode;
  onToggleKioskMode?: () => void;
  onRestoreChromeMode?: () => void;
  onRename?: () => void;
  onDelete?: () => void;
  onMoveTo?: () => void;
  onOpenFile?: (path: string) => Promise<void>;
  onOpenQuickOpen?: () => void;
  onRevealInTree?: (path: string) => void;
  /** Fired when the active tab changes (including internal tab switches) */
  onActiveDocumentChange?: (path: string | null) => void;
}

export interface UnifiedDocumentEditorHandle {
  openDocument: (path: string) => Promise<boolean>;
  closeDocument: () => void;
  closeAllDocuments: () => Promise<boolean>;
  getActiveDocumentPath: () => string | null;
  getOpenTabCount: () => number;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getSkillInfo(
  path: string | null,
  content: string | null,
  skillMetadata: UnifiedDocumentEditorProps['skillMetadata'],
  qualityScore?: number,
  qualityBand?: SkillQualityBand,
  qualityTopImprovement?: { dimension: string; suggestion: string }
) {
  if (!path || !content || !skillMetadata) return null;
  const parsed = parseSkillContent(content);
  if (!parsed.isValid) return null;
  return {
    relativePath: skillMetadata.relativePath,
    source: skillMetadata.source,
    frontmatter: skillMetadata.frontmatter,
    sharing: skillMetadata.sharing,
    storageProvider: skillMetadata.storageProvider,
    qualityScore,
    qualityBand,
    qualityTopImprovement,
  };
}

function isEditorTextInputTarget(element: Element | null): boolean {
  if (!element) return false;

  if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
    return true;
  }

  if (element instanceof HTMLElement && element.isContentEditable) {
    return true;
  }

  return Boolean(
    element.closest('[data-testid="tiptap-markdown-editor"], [data-tiptap-editor]'),
  );
}

function escapeShouldStayInEditorInput(event: KeyboardEvent): boolean {
  const eventTarget = event.target instanceof Element ? event.target : null;
  const activeElement = document.activeElement instanceof Element ? document.activeElement : null;
  return isEditorTextInputTarget(eventTarget) || isEditorTextInputTarget(activeElement);
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

const UnifiedDocumentEditorComponent = forwardRef<
  UnifiedDocumentEditorHandle,
  UnifiedDocumentEditorProps
>(function UnifiedDocumentEditor(
  {
    showToast,
    onNavigateToFolder,
    onClose,
    onLastTabClosed,
    onBackToSkills,
    onOpenInLibrary,
    onUseSkill,
    onPersonaliseSkill,
    onShareSkill,
    onImproveSkill,
    hasPersonalSupplement,
    skillExamplePaths,
    skillMetadata,
    skillQualityScore,
    skillQualityBand,
    skillQualityTopImprovement,
    onSendAnnotations,
    currentSessionId,
    currentSessionTitle,
    editorKioskLevel = 'off',
    chromeMode = 'normal',
    onToggleKioskMode,
    onRestoreChromeMode,
    onRename,
    onDelete,
    onMoveTo,
    onOpenFile,
    onOpenQuickOpen,
    onRevealInTree,
    onActiveDocumentChange,
  },
  ref,
) {
  const rootRef = useRef<HTMLDivElement>(null);
  const outlineScrollRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const activeDocumentPathRef = useRef<string | null>(null);
  const { user } = useAuth();

  // Focus-based activation (Amendment 6)
  const [hasFocus, setHasFocus] = useState(false);
  const handleFocusCapture = useCallback(() => setHasFocus(true), []);
  const handleBlurCapture = useCallback((e: React.FocusEvent) => {
    if (rootRef.current && !rootRef.current.contains(e.relatedTarget as Node)) {
      setHasFocus(false);
    }
  }, []);

  // ── UI State ──
  const [showFindBar, setShowFindBar] = useState(false);
  const [showGoToHeading, setShowGoToHeading] = useState(false);
  const [showSkillCard, setShowSkillCard] = useState(true);
  const [isImageExpanded, setIsImageExpanded] = useState(false);
  const [showSkillHistory, setShowSkillHistory] = useState(false);
  const { activeSurface } = useFlowPanels();
  const flushDocumentRef = useRef<(() => Promise<void>) | null>(null);
  const commitAnnotationBlockRef = useRef<((content: string) => void) | null>(null);

  // ── Tabs ──
  const tabs = useDocumentTabs({
    onBeforeTabSwitch: async () => {
      await flushDocumentRef.current?.();
    },
    onTabsEmptiedByClose: onLastTabClosed,
  });
  activeDocumentPathRef.current = tabs.activeDocumentPath;

  const sharedSkillSaveProtection = useMemo(() => {
    if (!skillMetadata || skillMetadata.sharing === 'private') {
      return null;
    }

    const guard = getSharedSkillDirectEditGuard(skillMetadata.frontmatter, user);

    if (!guard) {
      return null;
    }

    return {
      skillRelativePath: skillMetadata.relativePath,
      authorLabel: guard.authorLabel,
      copy: guard.copy,
    };
  }, [skillMetadata, user]);

  // ── Skill version history eligibility ──
  // When opened from Library, skillMetadata is provided. When opened from a
  // conversation, we self-detect by probing the skill-history IPC + parsing
  // frontmatter from the loaded content.
  const [isDetectedSharedSkill, setIsDetectedSharedSkill] = useState(false);

  // ── Structured log sink ──
  // Used by flush-on-clear failures in useDocumentFileIO and by the
  // per-message `onCommit` closure in DocumentFooter. `useAppContextSafe`
  // returns null outside an AppProvider (tests, storybook) — we fall
  // back to `undefined` in that case; callsites then use their own
  // `console.error` fallback so nothing ever fails silently.
  const appContext = useAppContextSafe();
  const emitLog = appContext?.emitLog;

  // ── File I/O ──
  const fileIO = useDocumentFileIO({
    documentPath: tabs.activeDocumentPath,
    showToast,
    emitLog,
    sharedSkillSaveProtection,
    onAnnotationWriteCommitted: (content) => {
      commitAnnotationBlockRef.current?.(content);
    },
  });
  flushDocumentRef.current = () => fileIO.flush();

  // ── Annotated Markdown Editor ──
  const editorResult = useAnnotatedMarkdownEditor({
    content: fileIO.isEditing ? fileIO.editContent : fileIO.content,
    documentPath: tabs.activeDocumentPath,
    onContentChange: fileIO.handleAnnotationContentChange,
    isMarkdownFile: fileIO.isMarkdownFile,
    onEditorContentChange: fileIO.handleEditorBodyChange,
    onFlushAnnotationWriteNow: fileIO.flushAnnotationWriteNow,
    isEditing: fileIO.isEditing,
    externalScrollRef: outlineScrollRef,
  });
  commitAnnotationBlockRef.current = editorResult.annotations.commitAnnotationBlock;

  const handleTipTapChangeRef = useRef(editorResult.content.handleTipTapChange);
  handleTipTapChangeRef.current = editorResult.content.handleTipTapChange;
  const persistCurrentContentNowRef = useRef(fileIO.persistCurrentContentNow);
  persistCurrentContentNowRef.current = fileIO.persistCurrentContentNow;
  const showToastRef = useRef(showToast);
  showToastRef.current = showToast;

  const handleMarkdownImageMutation = useCallback(async (markdown: string) => {
    handleTipTapChangeRef.current(markdown);
    try {
      await persistCurrentContentNowRef.current();
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Could not save image change.';
      showToastRef.current?.({ title: message });
      throw err;
    }
  }, []);

  const markdownImageImport = useMarkdownImageImport({
    documentPath: tabs.activeDocumentPath,
    editor: editorResult.editor.instance,
    isEditing: (
      fileIO.isEditing &&
      fileIO.isMarkdownFile &&
      !fileIO.needsSharedSkillSaveConfirmation &&
      fileIO.conflictState === null
    ),
    persistCurrentContentNow: fileIO.persistCurrentContentNow,
    showToast,
  });

  // Register capture function so flush() and unmount cleanup can read
  // annotations directly from ProseMirror state. Intentionally NOT nulled
  // on cleanup — child cleanups run before parent, and the unmount flush
  // in useDocumentFileIO still needs the function. captureIntoContent
  // fails gracefully if the editor is already destroyed.
  useEffect(() => {
    fileIO.captureIntoContentRef.current = editorResult.annotations.captureIntoContent;
  }, [fileIO.captureIntoContentRef, editorResult.annotations.captureIntoContent]);

  // ── Document Actions ──
  const documentActions = useDocumentActions({
    content: fileIO.content,
    fileName: fileIO.fileName,
    absolutePath: fileIO.absolutePath,
    relativePath: fileIO.relativePath,
    showToast,
  });

  // ── Skill version history detection (conversation context fallback) ──
  useEffect(() => {
    if (skillMetadata || !tabs.activeDocumentPath) {
      setIsDetectedSharedSkill(false);
      return;
    }
    let cancelled = false;
    window.skillHistoryApi
      .getVersions({ skillWorkspacePath: tabs.activeDocumentPath })
      .then((result) => {
        if (!cancelled) setIsDetectedSharedSkill(result.success === true);
      })
      .catch(() => {
        if (!cancelled) setIsDetectedSharedSkill(false);
      });
    return () => { cancelled = true; };
  }, [skillMetadata, tabs.activeDocumentPath]);

  const detectedFrontmatter = useMemo(() => {
    if (skillMetadata || !isDetectedSharedSkill || !fileIO.content) return null;
    try {
      const parsed = parseSkillContent(fileIO.content);
      return parsed.isValid ? parsed.frontmatter : null;
    } catch {
      return null;
    }
  }, [skillMetadata, isDetectedSharedSkill, fileIO.content]);

  const historyEligible = useMemo(() => {
    if (!user) return false;
    if (skillMetadata) {
      if (!skillMetadata.sharing || skillMetadata.sharing === 'private') return false;
      if (skillMetadata.storageProvider !== 'google_drive') return false;
      const fm = skillMetadata.frontmatter;
      if (!fm) return false;
      if (fm.author_id === user.id) return true;
      if (!fm.author_id && fm.author_email?.trim().toLowerCase() === user.email?.trim().toLowerCase()) return true;
      if (fm.contributors?.includes(user.id)) return true;
      return false;
    }
    if (!isDetectedSharedSkill) return false;
    const fm = detectedFrontmatter;
    if (!fm) return true;
    if (fm.author_id === user.id) return true;
    if (!fm.author_id && fm.author_email?.trim().toLowerCase() === user.email?.trim().toLowerCase()) return true;
    if (fm.contributors?.includes(user.id)) return true;
    return false;
  }, [user, skillMetadata, isDetectedSharedSkill, detectedFrontmatter]);

  // ── Derived state ──
  const skillInfo = useMemo(
    () => getSkillInfo(
      tabs.activeDocumentPath,
      fileIO.content,
      skillMetadata,
      skillQualityScore,
      skillQualityBand,
      skillQualityTopImprovement
    ),
    [tabs.activeDocumentPath, fileIO.content, skillMetadata, skillQualityScore, skillQualityBand, skillQualityTopImprovement],
  );
  const isShowingSkillCard = !!(skillInfo && showSkillCard);

  const isTutorial = fileIO.fileCategory === 'tutorial';
  const isHtml = fileIO.fileCategory === 'html';
  const showOpenInBrowser = isTutorial || isHtml;
  const activeDocumentPath = tabs.activeDocumentPath;

  // Reset transient UI state when active document changes
  useEffect(() => {
    setShowSkillCard(true);
    setIsImageExpanded(false);
    setShowFindBar(false);
    setShowGoToHeading(false);
  }, [tabs.activeDocumentPath]);

  // Notify parent of active document changes (including internal tab switches)
  const onActiveDocumentChangeRef = useRef(onActiveDocumentChange);
  onActiveDocumentChangeRef.current = onActiveDocumentChange;
  useEffect(() => {
    onActiveDocumentChangeRef.current?.(tabs.activeDocumentPath);
  }, [tabs.activeDocumentPath]);

  // Centralized "flush then act" helper — ensures edit content + annotations
  // are persisted before any destructive action (tab close, editor close).
  const flushThenAct = useCallback(
    (action: () => void) => {
      // flush() rejects on write failure; toast + telemetry already
      // fired at the failure site. Aborting the destructive action
      // is the data-loss prevention contract — Class A Batch 1.
      // The TWO-ARG `.then(action, abortHandler)` form is critical:
      // a chained `.catch()` would also swallow any error THROWN
      // BY `action`, which we never want.
      void fileIO.flush().then(action, () => {/* aborted by failed flush */});
    },
    [fileIO],
  );

  // ── Imperative Handle ──
  useImperativeHandle(
    ref,
    () => ({
      openDocument: async (path: string) => {
        try {
          // Use flush() not persistAnnotationsNow: tabs.openDocument
          // routes through onBeforeTabSwitch → flush() (Stage 4), and
          // we need to gate BEFORE returning so outer callers
          // (LibraryDrawer.handleOpenFile) see the abort signal.
          // Once flush() resolves here, the subsequent onBeforeTabSwitch
          // call inside tabs.openDocument is a fast no-op (nothing
          // pending). Class A Batch 1.
          await fileIO.flush();
        } catch {
          // Toast + telemetry already fired inside flush().
          // Abort opening the next document to prevent data loss.
          return false;
        }
        tabs.openDocument(path);
        return true;
      },
      closeDocument: () => {
        if (tabs.activeTabId) {
          const tabId = tabs.activeTabId;
          flushThenAct(() => tabs.closeTab(tabId));
        }
      },
      closeAllDocuments: async () => {
        try {
          await fileIO.flush();
        } catch {
          // Toast + telemetry already fired inside flush().
          // Abort close-all so outer callers keep editor state intact — Class A Batch 1.
          return false;
        }
        tabs.closeAllTabs();
        return true;
      },
      getActiveDocumentPath: () => tabs.activeDocumentPath,
      getOpenTabCount: () => tabs.tabs.length,
    }),
    [tabs, flushThenAct, fileIO],
  );

  // ── Tab Interaction Handlers ──
  const handleTabMouseDown = useCallback(
    (e: React.MouseEvent, tabId: string) => {
      if (e.button === 1) {
        e.preventDefault();
        flushThenAct(() => tabs.closeTab(tabId));
      }
    },
    [tabs, flushThenAct],
  );

  const handleTabClose = useCallback(
    (tabId: string) => {
      flushThenAct(() => tabs.closeTab(tabId));
    },
    [tabs, flushThenAct],
  );

  const handleClose = useCallback(() => {
    flushThenAct(() => onClose?.());
  }, [flushThenAct, onClose]);

  const handleBackToSkills = useMemo(
    () => onBackToSkills ? () => flushThenAct(() => onBackToSkills()) : undefined,
    [flushThenAct, onBackToSkills],
  );

  // ── Link handling ──
  const handleOpenLinkedFile = useCallback(async (filePath: string) => {
    if (filePath.startsWith('http://') || filePath.startsWith('https://')) {
      window.appApi.openUrl(filePath).catch(() => {});
      return;
    }
    try {
      await fileIO.persistAnnotationsNow(editorResult.annotations.captureIntoContent);
    } catch {
      // Toast + telemetry already fired inside persistAnnotationsNow.
      // Abort navigation to prevent data loss — Class A Batch 1.
      return;
    }
    if (onOpenFile) {
      void onOpenFile(filePath);
    } else {
      tabs.openDocument(filePath);
    }
  }, [fileIO, editorResult.annotations.captureIntoContent, onOpenFile, tabs]);

  // ── Open in browser (tutorials/HTML) ──
  const handleOpenInBrowser = useCallback(() => {
    if (!tabs.activeDocumentPath) return;
    window.appApi.openPath(tabs.activeDocumentPath).catch(() => {
      showToast?.({ title: 'Could not open file in browser. The file may have been moved or deleted.' });
    });
  }, [tabs.activeDocumentPath, showToast]);

  // ── Open in Library ──
  const handleOpenInLibrary = useCallback(async () => {
    if (!tabs.activeDocumentPath || !onOpenInLibrary) return;
    try {
      await fileIO.persistAnnotationsNow(editorResult.annotations.captureIntoContent);
    } catch {
      // Toast + telemetry already fired. Abort navigation —
      // Class A Batch 1.
      return;
    }
    onOpenInLibrary(tabs.activeDocumentPath);
  }, [tabs.activeDocumentPath, fileIO, editorResult.annotations.captureIntoContent, onOpenInLibrary]);

  // ── Save ──
  const handleSave = useCallback(() => {
    void fileIO.save();
  }, [fileIO]);

  const handleRestoreSkillVersionApplied = useCallback((restoredDocumentPath: string, restoredContent: string) => {
    if (activeDocumentPathRef.current !== restoredDocumentPath) {
      return;
    }

    fileIO.applyExternalCommittedContent(restoredContent);
  }, [fileIO]);

  const handlePrepareForRestore = useCallback(() => {
    return fileIO.prepareForExternalCommit();
  }, [fileIO]);

  const handleRestoreAttemptAborted = useCallback(() => {
    fileIO.cancelExternalCommit();
  }, [fileIO]);

  // ── Go to heading ──
  const handleGoToHeading = useCallback((heading: MarkdownHeading) => {
    editorResult.outline.goToHeading(heading);
    if (!editorResult.editor.ref.current && textareaRef.current && fileIO.content) {
      const pos = getCharPositionOfLine(fileIO.content, heading.lineIndex);
      textareaRef.current.focus();
      textareaRef.current.setSelectionRange(pos, pos);
    }
  }, [editorResult.outline, editorResult.editor.ref, fileIO.content]);

  // ── `library:add-comment` event listener ──
  useEffect(() => {
    if (!fileIO.isMarkdownFile) return;

    const handleAddCommentEvent = (e: CustomEvent<{ text: string; documentPath?: string; hintOffset?: number }>) => {
      if (e.detail.documentPath !== tabs.activeDocumentPath) return;
      if (editorResult.annotations.editing) return;

      const sel = editorResult.annotations.selection;
      if (sel !== null && sel.coords !== null) {
        editorResult.selectionUi.handleAddFromToolbar(sel.text, sel.from, sel.to);
        return;
      }

      const view = editorResult.annotations.getEditorView();
      if (view) {
        const { from, to, empty } = view.state.selection;
        if (!empty) {
          const text = view.state.doc.textBetween(from, to, ' ');
          if (text.trim()) {
            editorResult.selectionUi.handleAddFromToolbar(text, from, to);
            return;
          }
        }
        const eventText = e.detail.text;
        if (eventText) {
          const match = findTextInDoc(view.state.doc, eventText, e.detail.hintOffset);
          if (match) {
            editorResult.selectionUi.handleAddFromToolbar(eventText, match.from, match.to);
            return;
          }
          showToast?.({ title: "Couldn't locate that text to comment on" });
        }
      }
    };

    window.addEventListener('library:add-comment', handleAddCommentEvent as EventListener);
    return () => window.removeEventListener('library:add-comment', handleAddCommentEvent as EventListener);
  }, [
    fileIO.isMarkdownFile,
    tabs.activeDocumentPath,
    editorResult.annotations.selection,
    editorResult.annotations.editing,
    editorResult.annotations.getEditorView,
    editorResult.annotations,
    editorResult.selectionUi.handleAddFromToolbar,
    editorResult.selectionUi,
    showToast,
  ]);

  // ── Keyboard Shortcuts (focus-based) ──
  // Note: Cmd+F is handled via the Edit menu accelerator → App.tsx routes
  // `document-editor:open-find` custom events to this component.
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (!hasFocus) return;

      // Gate: when a dialog-style modal is open, let the dialog handle the
      // event itself. Otherwise the capture-phase listener would close the
      // editor on Escape or save on Cmd+S while the dialog is still up.
      // See utils/keyboardShortcutGate.ts for why showFindBar / isImageExpanded
      // are NOT gated here (they're in-surface UI, handled below).
      if (!shouldHandleEditorShortcut({ showGoToHeading, showSkillHistory })) {
        return;
      }

      if (e.repeat) {
        return;
      }

      const mod = e.metaKey || e.ctrlKey;
      const isLibrarySurfaceActive = activeSurface === 'library';
      const canCycleKiosk = Boolean(
        onToggleKioskMode
        && tabs.activeDocumentPath,
      );
      const canUseLegacyKioskAlias = isLibrarySurfaceActive && canCycleKiosk;

      // Cmd+Shift+O — go to heading (markdown only)
      if (mod && e.shiftKey && e.key.toLowerCase() === 'o' && fileIO.isMarkdownFile && tabs.activeDocumentPath) {
        e.preventDefault();
        e.stopPropagation();
        setShowGoToHeading(true);
        return;
      }

      // Cmd+S — save
      if (mod && e.key.toLowerCase() === 's') {
        e.preventDefault();
        e.stopPropagation();
        void fileIO.save();
        return;
      }

      // Cmd+\ — cycle kiosk mode (off → wide → zen → off)
      if (mod && (e.key === '\\' || e.code === 'Backslash') && canCycleKiosk) {
        e.preventDefault();
        e.stopPropagation();
        onToggleKioskMode?.();
        return;
      }

      // Cmd+Shift+F — hidden alias for library editor kiosk (sessions owns this shortcut)
      if (
        mod
        && e.shiftKey
        && e.key.toLowerCase() === 'f'
        && canUseLegacyKioskAlias
      ) {
        e.preventDefault();
        e.stopPropagation();
        onToggleKioskMode?.();
        return;
      }

      // Cmd/Ctrl+P and Cmd/Ctrl+O — quick open file
      if (
        mod
        && !e.shiftKey
        && (e.key.toLowerCase() === 'p' || e.key.toLowerCase() === 'o')
        && onOpenQuickOpen
        && isLibrarySurfaceActive
      ) {
        e.preventDefault();
        e.stopPropagation();
        onOpenQuickOpen();
        return;
      }

      // Cmd/Ctrl+W — close active tab
      if (mod && !e.shiftKey && e.key.toLowerCase() === 'w') {
        e.preventDefault();
        e.stopPropagation();
        flushThenAct(() => tabs.closeActiveTab());
        return;
      }

      // Cmd/Ctrl+1..9 — switch to tab by index (1-based)
      if (mod && !e.shiftKey && /^[1-9]$/.test(e.key)) {
        e.preventDefault();
        e.stopPropagation();
        tabs.setActiveTabByIndex(Number(e.key));
        return;
      }

      // Escape — close find bar / close expanded image / restore chrome / close editor
      if (e.key === 'Escape') {
        if (showFindBar) {
          e.preventDefault();
          e.stopPropagation();
          setShowFindBar(false);
          return;
        }
        if (isImageExpanded) {
          e.preventDefault();
          e.stopPropagation();
          setIsImageExpanded(false);
          return;
        }
        if (escapeShouldStayInEditorInput(e)) {
          return;
        }
        const kioskActive = editorKioskLevel !== 'off';
        if (onRestoreChromeMode && (kioskActive || chromeMode === 'reduced')) {
          e.preventDefault();
          e.stopPropagation();
          onRestoreChromeMode();
          return;
        }
        handleClose();
      }
    };

    window.addEventListener('keydown', handler, true);
    return () => window.removeEventListener('keydown', handler, true);
  }, [
    hasFocus,
    tabs.activeDocumentPath,
    fileIO.isMarkdownFile,
    fileIO.save,
    onToggleKioskMode,
    onOpenQuickOpen,
    onRestoreChromeMode,
    chromeMode,
    editorKioskLevel,
    activeSurface,
    showFindBar,
    isImageExpanded,
    showGoToHeading,
    showSkillHistory,
    handleClose,
    flushThenAct,
    tabs,
    fileIO,
  ]);

  // Listen for find commands routed from App.tsx via the Edit menu
  useEffect(() => {
    const handleOpenFind = () => {
      if (tabs.activeDocumentPath) {
        setShowFindBar(true);
      }
    };

    window.addEventListener('document-editor:open-find', handleOpenFind);
    return () => window.removeEventListener('document-editor:open-find', handleOpenFind);
  }, [tabs.activeDocumentPath]);

  // ── Loading / Error / Pending Approval ──
  const isLoading = fileIO.loading || fileIO.imageState.loading || fileIO.mediaState.loading;
  const errorMessage = fileIO.error || fileIO.imageState.error || fileIO.mediaState.error;
  const hasError = errorMessage !== null;
  const hasPendingApproval = fileIO.pendingApproval !== null;
  const hasDocument = tabs.activeDocumentPath !== null;
  const conflictState: DocumentWriteConflict | null = fileIO.conflictState;

  const [approvalActionInProgress, setApprovalActionInProgress] = useState(false);

  const handleApprove = useCallback(async () => {
    setApprovalActionInProgress(true);
    try {
      await fileIO.approvePending();
    } finally {
      setApprovalActionInProgress(false);
    }
  }, [fileIO]);

  const handleDeny = useCallback(async () => {
    setApprovalActionInProgress(true);
    try {
      await fileIO.denyPending();
    } finally {
      setApprovalActionInProgress(false);
    }
  }, [fileIO]);

  // ── Media state setter (for renderers to report errors) ──
  const { setMediaState } = fileIO;

  // ── Render ──
  return (
    <div
      ref={rootRef}
      className={`${styles.panel} library-editor-panel`}
      data-testid="library-editor-panel"
      data-focus-mode={editorKioskLevel !== 'off'}
      data-kiosk-level={editorKioskLevel}
      onFocusCapture={handleFocusCapture}
      onBlurCapture={handleBlurCapture}
      tabIndex={-1}
    >
      {/* Tab bar */}
      {tabs.tabs.length >= 1 && (
        <DocumentTabBar
          tabs={tabs.tabs}
          activeTabId={tabs.activeTabId}
          onTabClick={tabs.setActiveTab}
          onTabClose={handleTabClose}
          onTabMouseDown={handleTabMouseDown}
          onOpenFileDialog={onOpenQuickOpen}
        />
      )}

      {/* Header — hidden when skill card is showing (it has its own header) */}
      {!isShowingSkillCard && (
        <DocumentHeader
          fileName={fileIO.fileName}
          documentPath={tabs.activeDocumentPath}
          absolutePath={fileIO.absolutePath}
          fileCategory={fileIO.fileCategory}
          isMarkdownFile={fileIO.isMarkdownFile}
          isEditing={fileIO.isEditing}
          isDirty={fileIO.isDirty}
          isSaving={fileIO.isSaving}
          justSaved={fileIO.justSaved}
          statusText={fileIO.statusText}
          documentActions={documentActions}
          content={fileIO.content}
          showToast={showToast}
          kioskModeEnabled={editorKioskLevel !== 'off'}
          kioskLevel={editorKioskLevel}
          onToggleKioskMode={onToggleKioskMode}
          relativePath={fileIO.relativePath}
          onRevealInTree={activeDocumentPath && onRevealInTree
            ? () => onRevealInTree(activeDocumentPath)
            : undefined}
          onNavigateToFolder={onNavigateToFolder}
          onOpenInLibrary={onOpenInLibrary ? handleOpenInLibrary : undefined}
          onClose={handleClose}
          onRename={onRename}
          onDelete={onDelete}
          onMoveTo={onMoveTo}
          showOpenInBrowser={showOpenInBrowser}
          onOpenInBrowser={handleOpenInBrowser}
          onViewHistory={historyEligible ? () => setShowSkillHistory(true) : undefined}
          onSave={handleSave}
          markdownImageUpload={fileIO.isMarkdownFile ? {
            canUpload: markdownImageImport.canImportImages,
            isUploading: markdownImageImport.isImportingImage,
            inputProps: markdownImageImport.fileInputProps,
          } : undefined}
        />
      )}

      {/* Find bar */}
      {showFindBar && (
        <DocumentFindBar
          content={fileIO.content}
          isMarkdownFile={fileIO.isMarkdownFile}
          editorRef={editorResult.editor.ref}
          textareaRef={textareaRef}
          onClose={() => setShowFindBar(false)}
        />
      )}

      {/* Content area */}
      <div className={styles.content}>
        {isLoading && (
          <div className={styles.loading}>
            <Loader2 className={styles.spinner} size={24} />
            <span>Loading {fileIO.fileCategory === 'image' ? 'image' : fileIO.fileCategory === 'video' ? 'video' : fileIO.fileCategory === 'audio' ? 'audio' : fileIO.fileCategory === 'pdf' ? 'PDF' : 'document'}…</span>
          </div>
        )}

        {hasPendingApproval && !isLoading && (() => {
          const approval = fileIO.pendingApproval;
          if (!approval) return null;
          return (
            <div className={styles.pendingApproval}>
              <div className={styles.pendingApprovalIcon}>
                <Clock size={28} aria-hidden />
              </div>
              <h3 className={styles.pendingApprovalTitle}>Pending your approval</h3>
              <p className={styles.pendingApprovalDescription}>
                Rebel wrote this file but it needs your approval before being saved to <strong>{approval.spaceName}</strong>.
              </p>
              {approval.summary && (
                <p className={styles.pendingApprovalSummary}>
                  {approval.summary}
                </p>
              )}
              <div className={styles.pendingApprovalActions}>
                <Tooltip content="Redirect to your private memory instead" placement="top" delayShow={300}>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={handleDeny}
                    disabled={approvalActionInProgress}
                  >
                    <ShieldX size={14} />
                    Keep Private
                  </Button>
                </Tooltip>
                <Tooltip content={`Allow this file in ${approval.spaceName}`} placement="top" delayShow={300}>
                  <Button
                    variant="default"
                    size="sm"
                    onClick={handleApprove}
                    disabled={approvalActionInProgress}
                  >
                    <Check size={14} />
                    Approve
                  </Button>
                </Tooltip>
              </div>
            </div>
          );
        })()}

        {hasError && !isLoading && !hasPendingApproval && (() => {
          const externalOpenPath = fileIO.mediaState.error ? fileIO.absolutePath : null;
          return (
            <div className={styles.error}>
              <AlertTriangle size={20} aria-hidden />
              <span>{errorMessage}</span>
              {externalOpenPath && (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => { void window.appApi.openPath(externalOpenPath); }}
                >
                  Open in default app
                </Button>
              )}
            </div>
          );
        })()}

        {!isLoading && !hasPendingApproval && hasDocument && conflictState && (
          <DocumentConflictBanner
            conflict={conflictState}
            onResolve={fileIO.resolveConflict}
          />
        )}

        {!isLoading && !hasError && !hasPendingApproval && hasDocument && (
          <DocumentRenderers
            fileCategory={fileIO.fileCategory}
            documentPath={tabs.activeDocumentPath}
            absolutePath={fileIO.absolutePath}
            fileName={fileIO.fileName}
            content={fileIO.content}
            isMarkdownFile={fileIO.isMarkdownFile}
            isEditing={fileIO.isEditing}
            editContent={fileIO.editContent}
            isSaving={fileIO.isSaving}
            imageState={fileIO.imageState}
            mediaState={fileIO.mediaState}
            setMediaState={setMediaState}
            showSkillCard={showSkillCard}
            onSetShowSkillCard={setShowSkillCard}
            isImageExpanded={isImageExpanded}
            onSetIsImageExpanded={setIsImageExpanded}
            skillInfo={skillInfo}
            editorResult={editorResult}
            outlineScrollRef={outlineScrollRef}
            textareaRef={textareaRef}
            onEditContentChange={fileIO.handleEditorBodyChange}
            onMarkdownImageMutation={handleMarkdownImageMutation}
            onMarkdownImageFiles={markdownImageImport.importFiles}
            onOpenFile={onOpenFile}
            onOpenLinkedFile={handleOpenLinkedFile}
            showToast={showToast}
            sharedSkillSaveProtection={fileIO.sharedSkillSaveProtection}
            needsSharedSkillSaveConfirmation={fileIO.needsSharedSkillSaveConfirmation}
            onConfirmSharedSkillDirectSave={fileIO.confirmSharedSkillDirectSave}
            onBeforeRestoreSkillVersion={handlePrepareForRestore}
            onRestoreAttemptAborted={handleRestoreAttemptAborted}
            onRestoreSkillVersionApplied={handleRestoreSkillVersionApplied}
            onUseSkill={onUseSkill}
            onPersonaliseSkill={onPersonaliseSkill}
            onShareSkill={onShareSkill}
            onImproveSkill={onImproveSkill}
            hasPersonalSupplement={hasPersonalSupplement}
            skillExamplePaths={skillExamplePaths}
            onClose={handleClose}
            onBackToSkills={handleBackToSkills}
            onOpenInBrowser={handleOpenInBrowser}
            onOpenInLibrary={onOpenInLibrary}
          />
        )}
      </div>

      {/* Footer — hidden when skill card is showing */}
      {!isShowingSkillCard && (
        <DocumentFooter
          content={fileIO.content}
          documentPath={tabs.activeDocumentPath}
          fileName={fileIO.fileName}
          isMarkdownFile={fileIO.isMarkdownFile}
          isEditing={fileIO.isEditing}
          statusText={fileIO.statusText}
          justSaved={fileIO.justSaved}
          hasAnnotations={editorResult.annotations.hasAnnotations}
          annotationList={editorResult.annotations.list}
          onRemoveAnnotation={editorResult.annotations.remove}
          onClearAnnotations={editorResult.annotations.clearAll}
          formatAnnotationMessage={editorResult.annotations.formatMessage}
          formatAnnotationDisplayMessage={editorResult.annotations.formatDisplayMessage}
          flushAnnotationWriteNow={editorResult.annotations.flushAnnotationWriteNow}
          editorRef={editorResult.editor.ref}
          onSendAnnotations={onSendAnnotations}
          currentSessionId={currentSessionId}
          currentSessionTitle={currentSessionTitle}
          showToast={showToast}
          emitLog={emitLog}
        />
      )}

      {/* Go to heading dialog */}
      {fileIO.isMarkdownFile && fileIO.content && (
        <GoToHeadingDialog
          open={showGoToHeading}
          onOpenChange={setShowGoToHeading}
          content={fileIO.content}
          onSelectHeading={handleGoToHeading}
        />
      )}

      {/* Skill version history (shared skills — works in both Library and conversation contexts) */}
      {historyEligible && (
        <SkillHistoryPanel
          open={showSkillHistory}
          onOpenChange={setShowSkillHistory}
          skillName={fileIO.fileName.replace(/\.md$/i, '')}
          documentPath={tabs.activeDocumentPath}
          skillWorkspacePath={skillMetadata?.relativePath ?? tabs.activeDocumentPath ?? ''}
          currentContent={fileIO.content ?? ''}
          hasUnsavedChanges={fileIO.isDirty}
          onOpenFilePath={handleOpenLinkedFile}
          onBeforeRestore={handlePrepareForRestore}
          onRestoreAttemptAborted={handleRestoreAttemptAborted}
          onRestoreVersionApplied={handleRestoreSkillVersionApplied}
        />
      )}
    </div>
  );
});

export const UnifiedDocumentEditor = UnifiedDocumentEditorComponent;
