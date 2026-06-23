/**
 * useAnnotatedMarkdownEditor
 *
 * Shared hook that encapsulates the full TipTap editor + annotation lifecycle
 * used by both LibraryEditorPanel and DocumentPreviewDrawer. Extracted to
 * eliminate ~500 LOC of near-identical annotation persistence, selection UI,
 * content preparation, and outline integration code across the two surfaces.
 *
 * This hook is I/O-agnostic: it accepts `content` as input and emits changes
 * via `onContentChange` / `onEditorContentChange`, letting each consumer wire
 * their own persistence strategy (auto-save callback vs. debounced disk write).
 *
 * @see docs/plans/finished/260223_unify_document_preview_and_library_editor.md
 */

import {
  useState,
  useRef,
  useEffect,
  useCallback,
  useMemo,
} from 'react';
import type { Editor } from '@tiptap/core';
import { useTipTapAnnotations, type Annotation, type SelectionState, type EditingState } from './useTipTapAnnotations';
import { useDocumentOutline } from './useDocumentOutline';
import type { TipTapMarkdownEditorRef } from '../components/TipTapMarkdownEditor';
import type { MarkdownHeading } from '../utils/markdownHeadings';
import {
  parseAnnotationsFromDocument,
  toStoredAnnotations,
  serializeAnnotations,
  stripAnnotationComment,
} from '../utils/annotationPersistence';
import {
  dispatchAddAnnotation,
  getAnnotations as getAnnotationsFromEditorState,
  findTextInDoc,
} from '../extensions/tiptapAnnotationExtension';
import { stripYamlFrontmatter } from '@renderer/utils/documentUtils';
import { extractYamlFrontmatterFields } from '@renderer/utils/documentUtils';

// ─── Types ──────────────────────────────────────────────────────────────────

export type FrontmatterFields = Record<string, string | string[] | number | boolean>;

export interface PendingCommentSelection {
  from: number;
  to: number;
  text: string;
  coords: { left: number; right: number; top: number; bottom: number };
}

export interface UseAnnotatedMarkdownEditorOptions {
  /** Current document content (source of truth from parent) */
  content: string | null;
  /** Current document path (used for ref tracking / change detection) */
  documentPath: string | null;
  /**
   * Callback when content changes due to annotation block updates.
   * Does NOT need to be memoized — the hook stores it in a ref internally.
   */
  onContentChange: (newContent: string) => void;
  /** Whether this is a markdown file */
  isMarkdownFile: boolean;
  /**
   * Optional callback for TipTap onChange (editor body text changes).
   * Does NOT need to be memoized — the hook stores it in a ref internally.
   */
  onEditorContentChange?: (markdownContent: string) => void;
  /**
   * Optional callback for the per-message `onCommit` flow to flush the
   * post-clear annotation state to disk without waiting for the 500ms
   * debounced write. Must reject the returned promise on failure — no
   * silent `.catch(() => ...)`. See `useDocumentFileIO.flushAnnotationWriteNow`.
   *
   * Does NOT need to be memoized — the hook stores it in a ref internally.
   */
  onFlushAnnotationWriteNow?: (newContent: string) => Promise<void>;
  /** Whether the editor is in editing mode (affects outline scroll container) */
  isEditing?: boolean;
  /** Optional external scroll ref for outline sync */
  externalScrollRef?: React.RefObject<HTMLDivElement | null>;
}

export interface UseAnnotatedMarkdownEditorResult {
  /** TipTap editor lifecycle */
  editor: {
    instance: Editor | null;
    ref: React.RefObject<TipTapMarkdownEditorRef | null>;
    onReady: (editor: Editor) => void;
  };

  /** Annotation state and CRUD (forwarded from useTipTapAnnotations) */
  annotations: {
    list: Annotation[];
    extension: ReturnType<typeof useTipTapAnnotations>['extension'];
    selection: SelectionState | null;
    editing: EditingState | null;
    hasAnnotations: boolean;
    add: (comment: string) => string | null;
    update: (id: string, comment: string) => void;
    remove: (id: string) => void;
    /**
     * Polymorphic clear. `undefined` or empty array clears all
     * annotations (backward-compat with the original "Clear All"
     * button). A non-empty array of ids clears only those annotations
     * — used by the per-message `onCommit` closure in `DocumentFooter`
     * to clear exactly the annotations staged at Send click, leaving
     * any post-staging annotations intact.
     */
    clearAll: (ids?: string[]) => void;
    clearSelection: () => void;
    clearEditing: () => void;
    formatMessage: (filePath: string) => string;
    formatDisplayMessage: (filePath: string) => string;
    getEditorView: () => Editor['view'] | null;
    /**
     * Notify hook after an external write completed (updates lastAnnotationBlockRef).
     * Call this from DPD's debounced write callback and persistAnnotationsNow.
     *
     * Semantics: `''` = "no annotations, don't reload". `null` would mean
     * "first load, trigger annotation load" — never pass null here.
     */
    commitAnnotationBlock: (writtenContent: string) => void;
    /**
     * Capture current annotations into content string (for flush paths).
     * Uses try/catch + view.dom probe for safety during unmount — if the
     * TipTap editor has already been destroyed, returns content unchanged.
     */
    captureIntoContent: (content: string) => string;
    /**
     * Scoped clear used by the per-message `onCommit` closure. Clears
     * only the annotations whose ids are in the snapshot, leaving any
     * annotations added after Send-click intact. Throws
     * `EditorUnmountedError` if the editor is dead — the caller is
     * expected to catch and surface a structured warn log + toast.
     */
    dispatchClearStagedAnnotations: (ids: string[]) => void;
    /**
     * Flush post-clear annotation state to disk immediately, bypassing
     * the 500ms annotation debounce. Rejects on write failure (no
     * silent `.catch`). Used by the per-message `onCommit` closure in
     * `DocumentFooter`. Returns `undefined` (resolved promise) if the
     * consumer didn't wire `onFlushAnnotationWriteNow` — matches the
     * existing "no-op when not available" convention on this hook.
     */
    flushAnnotationWriteNow: () => Promise<void>;
  };

  /** Selection UI state for annotation popovers */
  selectionUi: {
    mode: 'comment' | null;
    pendingSelection: PendingCommentSelection | null;
    handleAddFromToolbar: (text: string, from: number, to: number) => void;
    handleSubmit: (comment: string) => void;
    handleClose: () => void;
  };

  /** Content preparation for TipTap rendering */
  content: {
    /** Content stripped of frontmatter + annotations, ready for TipTap */
    displayContent: string;
    /** Content stripped for outline extraction */
    forOutline: string;
    /** onChange wrapper that preserves frontmatter + annotation block */
    handleTipTapChange: (markdown: string) => void;
    /** Parsed YAML frontmatter key-value pairs, or null if none present */
    frontmatterFields: FrontmatterFields | null;
  };

  /** Document outline integration */
  outline: {
    isOpen: boolean;
    setOpen: React.Dispatch<React.SetStateAction<boolean>>;
    currentHeadingIndex: number | null;
    goToHeading: (heading: MarkdownHeading) => void;
  };
}

// ─── Hook ───────────────────────────────────────────────────────────────────

export function useAnnotatedMarkdownEditor({
  content,
  documentPath,
  onContentChange,
  isMarkdownFile,
  onEditorContentChange,
  onFlushAnnotationWriteNow,
  isEditing,
  externalScrollRef,
}: UseAnnotatedMarkdownEditorOptions): UseAnnotatedMarkdownEditorResult {

  // ── 1. TipTap Editor State Management ──────────────────────────────────

  const [tiptapEditor, setTiptapEditor] = useState<Editor | null>(null);
  const tiptapEditorRef = useRef<TipTapMarkdownEditorRef | null>(null);

  const handleEditorReady = useCallback((editor: Editor) => {
    setTiptapEditor(editor);
  }, []);

  // Ref for imperative access in synchronous capture paths (unmount safety).
  const tiptapEditorRefForCapture = useRef<Editor | null>(null);
  tiptapEditorRefForCapture.current = tiptapEditor;

  // ── 11. Callback Ref Patterns ──────────────────────────────────────────
  // Stored in refs so consumers don't need to memoize. Used inside effects
  // and callbacks instead of depending on the callbacks directly.
  const onContentChangeRef = useRef(onContentChange);
  onContentChangeRef.current = onContentChange;

  const onEditorContentChangeRef = useRef(onEditorContentChange);
  onEditorContentChangeRef.current = onEditorContentChange;

  // Ref-stable access to the flush-on-clear callback so consumers can
  // pass an ad-hoc function without memoization — matches the pattern
  // used for `onContentChange` / `onEditorContentChange`.
  const onFlushAnnotationWriteNowRef = useRef(onFlushAnnotationWriteNow);
  onFlushAnnotationWriteNowRef.current = onFlushAnnotationWriteNow;

  // ── 2. Annotation Persistence Refs ─────────────────────────────────────

  const isSavingAnnotationsRef = useRef(false);
  const lastLoadedPathRef = useRef<string | null>(null);
  const lastEditorInstanceRef = useRef<Editor | null>(null);
  // CRITICAL: Initialize to `null` (not empty string).
  // `null` = "first load, trigger annotation load".
  // `''`   = "no annotations, don't reload".
  const lastAnnotationBlockRef = useRef<string | null>(null);

  // Reset tracking refs when document is cleared so annotations reload on reopen.
  useEffect(() => {
    if (!documentPath) {
      lastLoadedPathRef.current = null;
      lastEditorInstanceRef.current = null;
      lastAnnotationBlockRef.current = null;
    }
  }, [documentPath]);

  // ── Annotation CRUD from useTipTapAnnotations ──────────────────────────

  const {
    extension: annotationExtension,
    annotations,
    selection,
    editing,
    hasAnnotations,
    addAnnotation,
    updateAnnotation,
    removeAnnotation,
    clearAnnotations,
    dispatchClearStagedAnnotations,
    clearSelection,
    clearEditing,
    formatAnnotationsMessage,
    formatDisplayMessage,
    loadAnnotations,
    getEditorView,
  } = useTipTapAnnotations({ editor: tiptapEditor });

  // ── 3. Annotation Save Effect ──────────────────────────────────────────
  // Watches `annotations` array. When annotations change, serializes them
  // into an HTML comment block and notifies the consumer via onContentChange.

  const prevAnnotationsRef = useRef<Annotation[]>([]);
  const prevAnnotationCountRef = useRef<number>(0);

  useEffect(() => {
    // ── 5. Safety Net: re-add stripped annotation blocks ──
    if (prevAnnotationsRef.current === annotations) {
      if (
        isMarkdownFile &&
        content &&
        prevAnnotationCountRef.current > 0 &&
        !/<!-- rebel-annotations/.test(content)
      ) {
        const stored = toStoredAnnotations(prevAnnotationsRef.current);
        if (stored.length > 0) {
          const newContent = content + '\n\n' + serializeAnnotations(stored);
          const writtenBlock = newContent.match(/\n\n<!-- rebel-annotations[\s\S]*?-->\s*$/)?.[0] ?? '';
          // CRITICAL: Update ref BEFORE calling onContentChange to prevent
          // the load effect from re-triggering when the consumer updates content.
          lastAnnotationBlockRef.current = writtenBlock;
          isSavingAnnotationsRef.current = true;
          onContentChangeRef.current(newContent);
          setTimeout(() => { isSavingAnnotationsRef.current = false; }, 0);
        }
      }
      return;
    }

    if (isSavingAnnotationsRef.current) {
      prevAnnotationsRef.current = annotations;
      prevAnnotationCountRef.current = annotations.length;
      return;
    }
    if (!isMarkdownFile) return;
    if (!content) return;

    const currentCount = annotations.length;
    const prevCount = prevAnnotationCountRef.current;

    // Guard: when annotations are empty but the file still has persisted
    // annotations, this is a transient state (editor remounting on mode switch,
    // or initial load where the save effect runs before the loading effect).
    // Skip stripping — the loading effect will restore them.
    if (currentCount === 0) {
      const hasPersistedAnnotations = /\n\n<!-- rebel-annotations[\s\S]*?-->\s*$/.test(content);
      if (hasPersistedAnnotations) {
        prevAnnotationsRef.current = annotations;
        prevAnnotationCountRef.current = 0;
        return;
      }
    }

    if (currentCount === prevCount && currentCount > 0) {
      const prevAnns = prevAnnotationsRef.current;
      const hasChange = annotations.some((ann, i) => {
        const prev = prevAnns[i];
        if (!prev) return true;
        return ann.id !== prev.id ||
               ann.from !== prev.from ||
               ann.to !== prev.to ||
               ann.comment !== prev.comment;
      });
      if (!hasChange) {
        prevAnnotationsRef.current = annotations;
        return;
      }
    }

    isSavingAnnotationsRef.current = true;
    prevAnnotationsRef.current = annotations;
    prevAnnotationCountRef.current = currentCount;

    const stored = toStoredAnnotations(annotations);

    // LEP's includes-based optimization: only regex when we know the block exists.
    const hasExistingComment = content.includes('<!-- rebel-annotations');

    let newContent: string;

    if (hasExistingComment) {
      const commentMatch = content.match(/\n\n<!-- rebel-annotations[\s\S]*?-->\s*$/);
      const newComment = stored.length > 0
        ? '\n\n' + serializeAnnotations(stored)
        : '';

      if (commentMatch && commentMatch.index !== undefined) {
        newContent = content.slice(0, commentMatch.index) + newComment;
      } else {
        newContent = stored.length > 0
          ? content + '\n\n' + serializeAnnotations(stored)
          : content;
      }
    } else if (stored.length > 0) {
      newContent = content + '\n\n' + serializeAnnotations(stored);
    } else {
      isSavingAnnotationsRef.current = false;
      return;
    }

    if (newContent !== content) {
      // CRITICAL: Update lastAnnotationBlockRef synchronously BEFORE
      // onContentChange fires. This prevents the load effect from
      // re-triggering when the consumer updates `content` in response.
      const writtenBlock = newContent.match(/\n\n<!-- rebel-annotations[\s\S]*?-->\s*$/)?.[0] ?? '';
      lastAnnotationBlockRef.current = writtenBlock;

      onContentChangeRef.current(newContent);
    }

    setTimeout(() => {
      isSavingAnnotationsRef.current = false;
    }, 0);
  }, [annotations, isMarkdownFile, content]);

  // ── 4. Annotation Load Effect ──────────────────────────────────────────
  // When content, documentPath, or tiptapEditor change: parse annotations
  // from content, find positions in ProseMirror doc, dispatch loadAnnotations.

  useEffect(() => {
    if (!content || !documentPath || !isMarkdownFile || !tiptapEditor) {
      return;
    }

    const pathChanged = lastLoadedPathRef.current !== documentPath;
    const editorChanged = lastEditorInstanceRef.current !== tiptapEditor;
    const currentAnnotationBlock = content.match(/\n\n<!-- rebel-annotations[\s\S]*?-->\s*$/)?.[0] ?? '';
    const annotationsChanged = lastAnnotationBlockRef.current !== null
      && lastAnnotationBlockRef.current !== currentAnnotationBlock;

    if (!pathChanged && !editorChanged && !annotationsChanged) {
      return;
    }

    const stored = parseAnnotationsFromDocument(content);
    if (stored.length > 0) {
      const doc = tiptapEditor.state?.doc;
      if (!doc) return; // Editor not ready — DON'T update refs so we retry.

      // Editor is ready — commit refs so we don't re-run for the same content.
      lastLoadedPathRef.current = documentPath;
      lastEditorInstanceRef.current = tiptapEditor;
      lastAnnotationBlockRef.current = currentAnnotationBlock;

      const validAnnotations: Annotation[] = [];
      for (const ann of stored) {
        const pos = findTextInDoc(doc, ann.text, ann.textOffset);
        if (pos && pos.from >= 0 && pos.to > pos.from) {
          validAnnotations.push({
            id: ann.id,
            from: pos.from,
            to: pos.to,
            text: ann.text,
            comment: ann.comment,
            createdAt: ann.createdAt,
          });
        }
      }

      if (validAnnotations.length > 0) {
        isSavingAnnotationsRef.current = true;
        loadAnnotations(validAnnotations);
        setTimeout(() => {
          isSavingAnnotationsRef.current = false;
        }, 0);
      }
    } else {
      // No stored annotations — safe to commit refs (no doc needed).
      lastLoadedPathRef.current = documentPath;
      lastEditorInstanceRef.current = tiptapEditor;
      lastAnnotationBlockRef.current = currentAnnotationBlock;

      if (annotationsChanged) {
        isSavingAnnotationsRef.current = true;
        clearAnnotations();
        setTimeout(() => {
          isSavingAnnotationsRef.current = false;
        }, 0);
      }
    }
  }, [documentPath, content, isMarkdownFile, loadAnnotations, clearAnnotations, tiptapEditor]);

  // ── 6. captureAnnotationsIntoContent ───────────────────────────────────
  // LEP's SAFER pattern: try/catch + view.dom probe for unmount safety.
  // If TipTap's pre-mount proxy throws (editor not yet mounted or already
  // destroyed), returns content unchanged — graceful fallback.

  const captureAnnotationsIntoContent = useCallback((contentStr: string): string => {
    const editor = tiptapEditorRefForCapture.current;
    if (!editor || !isMarkdownFile) return contentStr;
    try {
      const view = editor.view;
      void view.dom; // Probe — throws if editor not mounted yet
      const currentAnnotations = getAnnotationsFromEditorState(view.state);
      if (currentAnnotations.length === 0) {
        return stripAnnotationComment(contentStr);
      }
      const stored = toStoredAnnotations(currentAnnotations);
      const stripped = stripAnnotationComment(contentStr);
      return stripped + '\n\n' + serializeAnnotations(stored);
    } catch {
      return contentStr;
    }
  }, [isMarkdownFile]);

  // ── 7. commitAnnotationBlock ───────────────────────────────────────────
  // Allows consumers to notify the hook after external persistence.
  // Parses the annotation block from writtenContent and updates the ref,
  // preventing false reload triggers in the load effect.

  const commitAnnotationBlock = useCallback((writtenContent: string) => {
    const match = writtenContent.match(/\n\n<!-- rebel-annotations[\s\S]*?-->\s*$/);
    lastAnnotationBlockRef.current = match?.[0] ?? '';
  }, []);

  // ── 8. Selection UI State ──────────────────────────────────────────────

  const [selectionUiMode, setSelectionUiMode] = useState<'comment' | null>(null);
  const [pendingCommentSelection, setPendingCommentSelection] = useState<PendingCommentSelection | null>(null);

  // Reset selection UI mode when selection clears or editing starts.
  // CRITICAL: Don't reset if pendingCommentSelection exists — handles the
  // race condition where clicking "Comment" clears the editor selection
  // before we can show the popover.
  useEffect(() => {
    const hasSelection = selection !== null && selection.coords !== null;

    if (!hasSelection && !pendingCommentSelection) {
      setSelectionUiMode(null);
    } else if (editing) {
      setSelectionUiMode(null);
    }
  }, [selection, editing, pendingCommentSelection]);

  const handleAddCommentFromToolbar = useCallback((text: string, from: number, to: number) => {
    const view = getEditorView();
    if (view) {
      const coords = view.coordsAtPos(from);
      if (coords) {
        setPendingCommentSelection({
          from,
          to,
          text,
          coords: {
            left: coords.left,
            right: coords.left,
            top: coords.top,
            bottom: coords.bottom,
          },
        });
        setSelectionUiMode('comment');
      }
    }
  }, [getEditorView]);

  // LEP's pattern: selectionSource = pendingCommentSelection ?? selection,
  // then clearSelection() after dispatch.
  const handleAnnotationSubmit = useCallback((comment: string) => {
    const selectionSource = pendingCommentSelection ?? selection;

    if (selectionSource) {
      const view = getEditorView();
      if (view) {
        dispatchAddAnnotation(view, {
          from: selectionSource.from,
          to: selectionSource.to,
          text: selectionSource.text,
          comment,
        });
      }
    } else {
      addAnnotation(comment);
    }
    setPendingCommentSelection(null);
    setSelectionUiMode(null);
    clearSelection();
  }, [pendingCommentSelection, selection, getEditorView, addAnnotation, clearSelection]);

  const handleAnnotationClose = useCallback(() => {
    clearSelection();
    setSelectionUiMode(null);
    setPendingCommentSelection(null);
  }, [clearSelection]);

  // ── 9. Content Preparation ─────────────────────────────────────────────

  const editorDisplayContent = useMemo(() => {
    if (!content) return '';
    return stripAnnotationComment(stripYamlFrontmatter(content));
  }, [content]);

  const editorContentForOutline = useMemo(() => {
    if (!content) return '';
    return stripAnnotationComment(stripYamlFrontmatter(content));
  }, [content]);

  const frontmatterFields = useMemo<FrontmatterFields | null>(() => {
    if (!content) return null;
    return extractYamlFrontmatterFields(content);
  }, [content]);

  // ── 10. TipTap onChange Wrapper ────────────────────────────────────────
  // LEP's ref-first pattern: uses lastAnnotationBlockRef.current for the
  // annotation block (always at least as fresh as state), content prop for
  // frontmatter. Does NOT re-parse from content to avoid stale closures.

  const contentRef = useRef(content);
  contentRef.current = content;

  // ── 10b. flushAnnotationWriteNow ───────────────────────────────────────
  // Used by the per-message `onCommit` closure in `DocumentFooter` to
  // flush the post-clear annotation state to disk without waiting for
  // the 500ms debounce. Captures the current annotation block from the
  // live editor (already reflects the scoped clear) and forwards to the
  // consumer's flush path.
  //
  // Fails loud: rejects on write failure so the caller sees the error.
  // If the consumer didn't wire `onFlushAnnotationWriteNow`, resolves to
  // `undefined` — matches the hook's "no-op when not wired" convention.
  const flushAnnotationWriteNow = useCallback(async (): Promise<void> => {
    const flush = onFlushAnnotationWriteNowRef.current;
    if (!flush) {
      return;
    }
    const currentContent = contentRef.current;
    if (!currentContent) {
      // Nothing to flush. The empty-content case can happen when the
      // editor just mounted or the document is being torn down —
      // either way there is no meaningful write to perform.
      return;
    }
    // Re-serialize the annotation block from ProseMirror state. The
    // capture function is unmount-safe: it returns the content
    // unchanged if the editor has already been destroyed.
    const newContent = captureAnnotationsIntoContent(currentContent);
    // Update the ref BEFORE the external flush so the load effect's
    // reconciliation doesn't see a mismatch when the consumer echoes
    // `newContent` back through `onContentChange`.
    const match = newContent.match(/\n\n<!-- rebel-annotations[\s\S]*?-->\s*$/);
    lastAnnotationBlockRef.current = match?.[0] ?? '';
    await flush(newContent);
  }, [captureAnnotationsIntoContent]);

  const handleTipTapChange = useCallback((markdown: string) => {
    const currentContent = contentRef.current;
    const frontmatter = currentContent?.match(/^---\n[\s\S]*?\n---\n/)?.[0] ?? '';
    const annotationBlock = lastAnnotationBlockRef.current
      ?? (currentContent?.match(/\n\n<!-- rebel-annotations[\s\S]*?-->\s*$/)?.[0] ?? null);
    let full = markdown;
    if (frontmatter) {
      full = frontmatter + full;
    }
    if (annotationBlock) {
      full = full + annotationBlock;
    }
    onEditorContentChangeRef.current?.(full);
  }, []);

  // ── 12. Outline Integration ────────────────────────────────────────────

  const {
    outlineOpen,
    setOutlineOpen,
    currentHeadingIndex,
    handleGoToHeading,
  } = useDocumentOutline({
    tiptapEditor,
    tiptapEditorRef,
    editorContentForOutline,
    documentPath,
    isMarkdownFile,
    isEditing,
    externalScrollRef,
  });

  // ── Return ─────────────────────────────────────────────────────────────

  return {
    editor: {
      instance: tiptapEditor,
      ref: tiptapEditorRef,
      onReady: handleEditorReady,
    },
    annotations: {
      list: annotations,
      extension: annotationExtension,
      selection,
      editing,
      hasAnnotations,
      add: addAnnotation,
      update: updateAnnotation,
      remove: removeAnnotation,
      clearAll: clearAnnotations,
      clearSelection,
      clearEditing,
      formatMessage: formatAnnotationsMessage,
      formatDisplayMessage,
      getEditorView,
      commitAnnotationBlock,
      captureIntoContent: captureAnnotationsIntoContent,
      dispatchClearStagedAnnotations,
      flushAnnotationWriteNow,
    },
    selectionUi: {
      mode: selectionUiMode,
      pendingSelection: pendingCommentSelection,
      handleAddFromToolbar: handleAddCommentFromToolbar,
      handleSubmit: handleAnnotationSubmit,
      handleClose: handleAnnotationClose,
    },
    content: {
      displayContent: editorDisplayContent,
      forOutline: editorContentForOutline,
      handleTipTapChange,
      frontmatterFields,
    },
    outline: {
      isOpen: outlineOpen,
      setOpen: setOutlineOpen,
      currentHeadingIndex,
      goToHeading: handleGoToHeading,
    },
  };
}
