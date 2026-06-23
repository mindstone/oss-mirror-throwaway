/**
 * useDocumentOutline
 *
 * Shared hook for document outline (table of contents) — tracks scroll
 * position and cursor selection to keep the outline panel's active heading
 * in sync with the editor. Used by both LibraryEditorPanel and
 * DocumentPreviewDrawer.
 *
 * Design decisions:
 * - Depends on `documentPath` (not content) to avoid tearing down listeners
 *   on every keystroke.
 * - Uses ProseMirror `doc.descendants()` for selection-based tracking (cursor).
 * - Uses `querySelectorAll('h1-h6')` for scroll-based tracking (viewport).
 * - Suppresses scroll updates during programmatic navigation to prevent
 *   selection → scroll → wrong-highlight race conditions.
 * - Uses debouncing for selection updates and throttling for scroll updates.
 * - Highlights first heading when cursor is above all headings.
 * - Makes scroll threshold responsive to viewport height.
 *
 * @see docs/plans/obsolete/260209_document_outline_sync_review.md
 */

import { useState, useCallback, useEffect, useRef } from 'react';
import type { Editor } from '@tiptap/core';
import { extractHeadings, type MarkdownHeading } from '../utils/markdownHeadings';
import type { TipTapMarkdownEditorRef } from '../components/TipTapMarkdownEditor';

/**
 * Safely access the editor's ProseMirror EditorView.
 *
 * In TipTap v3, `editor.view` returns a Proxy when the editor hasn't been
 * mounted to the DOM yet. The proxy throws when you access properties like
 * `.dom`. This helper probes `.dom` inside a try-catch to detect the proxy,
 * returning `null` instead of letting the throw propagate.
 */
function safeEditorView(editor: Editor) {
  try {
    const view = editor.view;
    // Probe .dom to verify the view is real (not the pre-mount proxy).
    // The proxy throws here; a mounted view returns the DOM element.
    void view.dom;
    return view;
  } catch {
    return null;
  }
}

interface UseDocumentOutlineOptions {
  /** TipTap editor instance (from onEditorReady or state) */
  tiptapEditor: Editor | null;
  /** Ref to the TipTapMarkdownEditor imperative handle */
  tiptapEditorRef: React.RefObject<TipTapMarkdownEditorRef | null>;
  /** Content to extract headings from (should be stripped of frontmatter/annotations) */
  editorContentForOutline: string;
  /** Unique document identifier — effect re-runs when this changes */
  documentPath: string | null | undefined;
  /** Whether the current file is markdown */
  isMarkdownFile: boolean;
  /** Whether the editor is in edit mode (affects which scroll container is active) */
  isEditing?: boolean;
  /**
   * Optional external scroll container ref — used by DocumentPreviewDrawer where
   * the scroll container (.doc-preview__outline-main) is outside TipTap's DOM.
   */
  externalScrollRef?: React.RefObject<HTMLDivElement | null>;
}

interface UseDocumentOutlineReturn {
  /** Whether the outline panel is open */
  outlineOpen: boolean;
  /** Toggle outline visibility */
  setOutlineOpen: React.Dispatch<React.SetStateAction<boolean>>;
  /** Index of the currently active heading (null = none) */
  currentHeadingIndex: number | null;
  /** Navigate to a heading in the document */
  handleGoToHeading: (heading: MarkdownHeading) => void;
}

/**
 * Duration (ms) to suppress scroll-based updates after programmatic navigation.
 * This prevents the scroll event from overriding the heading set by click.
 */
const PROGRAMMATIC_NAV_COOLDOWN = 250;

/**
 * Debounce delay (ms) for selection-update events.
 * Prevents excessive ProseMirror tree walks during rapid cursor movement.
 */
const SELECTION_DEBOUNCE = 50;

/**
 * Throttle interval (ms) for scroll events.
 * ~16 FPS — smooth enough without excessive React re-renders.
 */
const SCROLL_THROTTLE = 60;

export function useDocumentOutline({
  tiptapEditor,
  tiptapEditorRef,
  editorContentForOutline,
  documentPath,
  isMarkdownFile,
  isEditing,
  externalScrollRef,
}: UseDocumentOutlineOptions): UseDocumentOutlineReturn {
  const [outlineOpen, setOutlineOpen] = useState(false);
  const [currentHeadingIndex, setCurrentHeadingIndex] = useState<number | null>(null);

  // Flag to suppress scroll updates during programmatic navigation
  const isNavigatingRef = useRef(false);

  // Reset heading when document changes or isn't markdown
  useEffect(() => {
    setCurrentHeadingIndex(null);
  }, [documentPath, isMarkdownFile]);

  // ─── Navigate to heading ─────────────────────────────────────────────
  const handleGoToHeading = useCallback((heading: MarkdownHeading) => {
    const editor = tiptapEditorRef.current?.getEditor() ?? tiptapEditor;
    if (!editor) return;
    const view = safeEditorView(editor);
    if (!view) return;

    const allHeadings = extractHeadings(editorContentForOutline);
    const headingIdx = allHeadings.findIndex(
      h => h.lineIndex === heading.lineIndex && h.text === heading.text
    );
    if (headingIdx < 0) return;

    // Suppress scroll updates during programmatic navigation
    isNavigatingRef.current = true;
    setTimeout(() => { isNavigatingRef.current = false; }, PROGRAMMATIC_NAV_COOLDOWN);

    // Edit mode: ProseMirror-based navigation (precise)
    if (isEditing && tiptapEditorRef.current) {
      let count = 0;
      let targetPos: number | null = null;
      editor.state.doc.descendants((node, pos) => {
        if (targetPos !== null) return false;
        if (node.type.name === 'heading') {
          if (count === headingIdx) {
            targetPos = pos;
            return false;
          }
          count++;
        }
      });

      if (targetPos !== null) {
        tiptapEditorRef.current.focus();
        tiptapEditorRef.current.setSelection(targetPos, targetPos);
        setCurrentHeadingIndex(headingIdx);
        return;
      }
    }

    // Preview mode (or fallback): DOM-based scrolling
    const headingEls = view.dom.querySelectorAll('h1, h2, h3, h4, h5, h6');
    const targetEl = headingEls[headingIdx] as HTMLElement | undefined;
    if (!targetEl) return;

    // Find the actual scroll container
    let scrollContainer: Element | null = null;
    let walkNode: Element | null = targetEl.parentElement;
    while (walkNode) {
      if (walkNode.scrollHeight > walkNode.clientHeight) {
        const style = window.getComputedStyle(walkNode);
        if (style.overflowY === 'auto' || style.overflowY === 'scroll') {
          scrollContainer = walkNode;
          break;
        }
      }
      walkNode = walkNode.parentElement;
    }

    const container = scrollContainer ?? externalScrollRef?.current;
    if (container) {
      const containerRect = container.getBoundingClientRect();
      const targetRect = targetEl.getBoundingClientRect();
      const targetY = targetRect.top - containerRect.top - 80;
      container.scrollTo({
        top: container.scrollTop + targetY,
        behavior: 'smooth',
      });
    } else {
      targetEl.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
    setCurrentHeadingIndex(headingIdx);
  }, [editorContentForOutline, tiptapEditor, tiptapEditorRef, isEditing, externalScrollRef]);

  // ─── Scroll & selection sync ──────────────────────────────────────────
  useEffect(() => {
    if (!tiptapEditor || !documentPath || !isMarkdownFile) {
      return;
    }

    let isActive = true; // Guard against stale updates after cleanup

    // ── Selection-based tracking (cursor position in edit mode) ──
    // Walks ProseMirror doc tree — uses early exit once past cursor.
    let selectionTimer: ReturnType<typeof setTimeout> | null = null;
    const updateFromSelection = () => {
      if (!isActive) return;
      if (selectionTimer) clearTimeout(selectionTimer);
      selectionTimer = setTimeout(() => {
        selectionTimer = null;
        if (!isActive || !tiptapEditor || tiptapEditor.isDestroyed) return;
        // Guard: editor.state internally accesses editor.view.state in TipTap v3,
        // which throws if <EditorContent> hasn't mounted yet.
        if (!safeEditorView(tiptapEditor)) return;
        const { from } = tiptapEditor.state.selection;
        let bestIndex: number | null = null;
        let count = 0;
        let pastCursor = false;
        tiptapEditor.state.doc.descendants((node, pos) => {
          if (pastCursor) return false; // Early exit
          if (node.type.name === 'heading') {
            if (pos <= from) {
              bestIndex = count;
              if (pos + node.nodeSize > from) {
                pastCursor = true;
                return false;
              }
            } else {
              pastCursor = true;
              return false;
            }
            count++;
          }
        });
        // Highlight first heading when above all headings
        if (bestIndex === null && count > 0) {
          bestIndex = 0;
        }
        setCurrentHeadingIndex(bestIndex);
      }, SELECTION_DEBOUNCE);
    };

    // ── Scroll-based tracking (viewport heading detection) ──
    const findScrollParent = (el: Element, stopAt?: Element | null): Element | null => {
      let node: Element | null = el.parentElement;
      while (node && node !== stopAt) {
        const style = window.getComputedStyle(node);
        if (style.overflowY === 'auto' || style.overflowY === 'scroll') return node;
        node = node.parentElement;
      }
      return null;
    };

    const externalEl = externalScrollRef?.current ?? null;

    const updateFromScroll = () => {
      if (!isActive || isNavigatingRef.current) return;
      const view = safeEditorView(tiptapEditor);
      if (!view) return;

      // Use external scroll ref or find the scroll parent
      const referenceEl = externalEl ?? findScrollParent(view.dom) ?? null;
      if (!referenceEl) return;

      const containerRect = referenceEl.getBoundingClientRect();
      // Responsive threshold: 15% of viewport height, capped at 100px
      const threshold = containerRect.top + Math.min(100, window.innerHeight * 0.15);

      const headingEls = view.dom.querySelectorAll('h1, h2, h3, h4, h5, h6');
      let bestIndex: number | null = null;
      for (let i = headingEls.length - 1; i >= 0; i--) {
        const rect = headingEls[i].getBoundingClientRect();
        if (rect.top <= threshold) {
          bestIndex = i;
          break;
        }
      }
      // Highlight first heading when above all headings
      if (bestIndex === null && headingEls.length > 0) {
        bestIndex = 0;
      }
      setCurrentHeadingIndex(bestIndex);
    };

    // Throttled scroll handler
    let scrollTimer: ReturnType<typeof setTimeout> | null = null;
    const handleScroll = () => {
      if (scrollTimer || isNavigatingRef.current) return;
      scrollTimer = setTimeout(() => {
        scrollTimer = null;
        updateFromScroll();
      }, SCROLL_THROTTLE);
    };

    // Listen for cursor changes (safe — doesn't access editor.view)
    tiptapEditor.on('selectionUpdate', updateFromSelection);

    // DOM-dependent setup: finding the scroll container and attaching scroll
    // listeners requires editor.view.dom, which is only available after
    // <EditorContent> mounts. Defer to the next animation frame so the
    // React render cycle that includes <EditorContent> can complete first.
    let tiptapScrollEl: Element | null = null;
    const rafId = requestAnimationFrame(() => {
      if (!isActive) return;

      const view = safeEditorView(tiptapEditor);
      tiptapScrollEl = view?.dom
        ? findScrollParent(view.dom, externalEl)
        : null;

      // Initial sync
      updateFromScroll();

      // Listen on scroll containers
      if (externalEl) {
        externalEl.addEventListener('scroll', handleScroll, { passive: true });
      }
      if (tiptapScrollEl && tiptapScrollEl !== externalEl) {
        tiptapScrollEl.addEventListener('scroll', handleScroll, { passive: true });
      }
    });

    return () => {
      isActive = false;
      cancelAnimationFrame(rafId);
      tiptapEditor.off('selectionUpdate', updateFromSelection);
      if (selectionTimer) clearTimeout(selectionTimer);
      if (externalEl) {
        externalEl.removeEventListener('scroll', handleScroll);
      }
      if (tiptapScrollEl && tiptapScrollEl !== externalEl) {
        tiptapScrollEl.removeEventListener('scroll', handleScroll);
      }
      if (scrollTimer) clearTimeout(scrollTimer);
    };
    // Depend on documentPath (not content) to avoid listener churn.
    // isEditing triggers re-run so we pick up new scroll containers on mode switch.
  }, [tiptapEditor, documentPath, isMarkdownFile, isEditing, externalScrollRef]);

  return {
    outlineOpen,
    setOutlineOpen,
    currentHeadingIndex,
    handleGoToHeading,
  };
}
