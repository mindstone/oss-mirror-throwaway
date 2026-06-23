import { useEffect, forwardRef, useImperativeHandle, useCallback, useState, useRef, useMemo } from 'react';
import { useEditor, EditorContent } from '@tiptap/react';
import type { Editor, Extension } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
// Stage 9 of `docs/plans/260501_composer_tiptap_atmention_bugfix.md` — the
// library editor uses StarterKit defaults (full markdown semantics: headings,
// lists, marks, tables, links, code) via `@tiptap/markdown`'s `marked`-driven
// pipeline. The composer's wire-format fix is orthogonal: it overrides
// Document / Paragraph / HardBreak `renderMarkdown` and disables Link /
// Underline / TrailingNode in its own `createPromptEditorExtensions()` factory
// (see `src/renderer/features/composer/utils/composerEditorFactory.ts`).
// `MarkdownManager.registerExtension` is per-extension-instance, so the
// composer's overrides do NOT leak into this editor's extension array.
import { Markdown } from '@tiptap/markdown';
import { TableKit } from '@tiptap/extension-table';
import Link from '@tiptap/extension-link';
import Placeholder from '@tiptap/extension-placeholder';
import { SelectionToolbar } from './SelectionToolbar';
import {
  getAnnotations as getAnnotationsFromState,
  dispatchLoadAnnotations,
  annotationPluginKey,
  findTextInDoc,
  type Annotation,
} from '../extensions/tiptapAnnotationExtension';
import {
  clearTipTapFindHighlights,
  setTipTapFindHighlights,
  TipTapFindHighlightExtension,
  type TipTapFindHighlightRange,
} from '../extensions/tiptapFindHighlightExtension';
import {
  toStoredAnnotations,
} from '../utils/annotationPersistence';
import { TipTapImageExtension } from '../extensions/tiptapImageExtension';
import { decodeHtmlEntitiesInMarkdown } from '@renderer/utils/documentUtils';
import styles from './TipTapMarkdownEditor.module.css';

/**
 * Load markdown into a TipTap editor without ever throwing.
 *
 * `@tiptap/markdown` (marked) can occasionally emit a fragment that violates
 * the `doc = block+` schema (an empty/"holey" doc), which makes ProseMirror
 * throw — "Invalid content for node doc: <>" / "Content hole not allowed in a
 * leaf node spec" — during `setContent`. Because that throw escapes React's
 * render/commit, it crashes the whole renderer surface (REBEL-64W / REBEL-5KJ).
 *
 * This guards the **content-sync** ingestion path — the value-sync effect that
 * re-parses markdown via `setContent` on every external document change (the
 * frequently-exercised path). Guarding it makes that crash class
 * unrepresentable by construction, independent of the exact triggering input.
 * On failure we fall back to a valid document and PRESERVE the user's content
 * as a single plaintext paragraph (never silently blank non-empty input).
 *
 * (Initial construction loads markdown synchronously in `useEditor` to keep
 * readiness/annotation ordering intact — see the note there; a throw during
 * initial construction is not locally catchable and is a tracked residual.)
 */
export function loadMarkdownContentSafely(editor: Editor, markdown: string): void {
  try {
    editor.commands.setContent(markdown, { contentType: 'markdown' });
  } catch (err) {
    console.warn(
      '[TipTapMarkdownEditor] markdown produced schema-invalid content; falling back to plaintext (REBEL-64W/5KJ)',
      err,
    );
    const emptyDoc = { type: 'doc', content: [{ type: 'paragraph' }] };
    const fallbackDoc = markdown.trim().length > 0
      ? { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: markdown }] }] }
      : emptyDoc;
    try {
      editor.commands.setContent(fallbackDoc);
    } catch {
      // Last resort: a guaranteed-valid empty document.
      editor.commands.setContent(emptyDoc);
    }
  }
}

/**
 * Ref interface for TipTapMarkdownEditor
 * Compatible with InkMarkdownEditorRef for drop-in replacement
 */
export interface TipTapMarkdownEditorRef {
  /** Get the current document content as Markdown */
  getDoc: () => string;
  /** Alias for getDoc - get content as Markdown */
  getMarkdown: () => string;
  /** Focus the editor */
  focus: () => void;
  /** Set cursor/selection position (character offsets) */
  setSelection: (from: number, to?: number) => void;
  /** 
   * Scroll to and select a range by ProseMirror positions.
   * Unlike setSelection (which expects character offsets), this takes
   * native ProseMirror positions as used by annotations.
   */
  scrollToAnnotation: (from: number, to: number) => void;
  /** Set visible document-find highlights by native ProseMirror positions. */
  setFindHighlights: (ranges: TipTapFindHighlightRange[], activeIndex: number) => void;
  /** Clear visible document-find highlights. */
  clearFindHighlights: () => void;
  /** Get the underlying TipTap editor instance (for advanced usage) */
  getEditor: () => Editor | null;
}

interface TipTapMarkdownEditorProps {
  value: string;
  onChange: (md: string) => void;
  onLinkClick?: (url: string) => void;
  placeholder?: string;
  readOnly?: boolean;
  className?: string;
  /**
   * CodeMirror extensions - NOT SUPPORTED in TipTap editor.
   * Accepted for API compatibility with InkMarkdownEditor.
   * @deprecated Use annotationExtension prop instead
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- API-compat shim with InkMarkdownEditor; this editor ignores the prop and uses annotationExtension instead
  extensions?: any[];
  /** TipTap annotation extension (from useTipTapAnnotations hook) */
  annotationExtension?: Extension;
  /** Callback when editor is ready - provides the Editor instance */
  onEditorReady?: (editor: Editor) => void;
  /** Callback when user clicks Ask Rebel in the selection toolbar */
  onReply?: (text: string) => void;
  /** Callback when user clicks Ask Rebel in New Chat in the selection toolbar */
  onReplyInNewChat?: (text: string) => void;
  /** Callback when user clicks Add Comment in the selection toolbar */
  onAddComment?: (text: string, from: number, to: number) => void;
  /** Whether to show the Add Comment button in the selection toolbar */
  showAddComment?: boolean;
  /** Toast notification function for feedback */
  showToast?: (options: { title: string }) => void;
  /** Path to the document file. Used to resolve relative image paths via IPC. */
  documentPath?: string;
  /** Callback fired after image-node mutations with the current markdown body. */
  onImageMutation?: (markdown: string) => void | Promise<void>;
  /** Callback for image files pasted/dropped into the editor. */
  onImageFiles?: (files: File[], options?: { insertAt?: number }) => void | Promise<void>;
}

export function getImageFilesFromFileList(fileList: FileList | null): File[] {
  if (!fileList) return [];
  return Array.from(fileList).filter((file) => file.type.startsWith('image/'));
}

export function hasFilesInFileList(fileList: FileList | null): boolean {
  return Boolean(fileList && fileList.length > 0);
}

export function hasNonWhitespacePlainText(clipboardData: DataTransfer | null): boolean {
  return Boolean(clipboardData?.getData('text/plain').trim());
}

export function stripPastedImageTags(html: string): string {
  return html.replace(/<img\b[^>]*>/gi, '');
}

export const TipTapMarkdownEditor = forwardRef<TipTapMarkdownEditorRef, TipTapMarkdownEditorProps>(
  ({ value, onChange, onLinkClick, placeholder = 'Start writing...', readOnly = false, className, extensions, annotationExtension, onEditorReady, onReply, onReplyInNewChat, onAddComment, showAddComment = false, showToast, documentPath, onImageMutation, onImageFiles }, ref) => {
    const [isInitialized, setIsInitialized] = useState(false);
    const editorRef = useRef<Editor | null>(null);
    const onEditorReadyRef = useRef(onEditorReady);
    const onImageFilesRef = useRef(onImageFiles);
    // Ref so the image extension's right-click menu always sees the latest
    // showToast without re-creating the editor when its identity changes.
    const showToastRef = useRef(showToast);

    // Performance optimization: Store onChange in a ref to avoid recreating editor config
    const onChangeRef = useRef(onChange);

    // Synchronous ref updates so TipTap callbacks always use the latest closures.
    // (useEffect runs asynchronously after paint, creating a stale-closure window
    // where onUpdate could fire with an old onChange that captures stale content.)
    onEditorReadyRef.current = onEditorReady;
    onImageFilesRef.current = onImageFiles;
    onChangeRef.current = onChange;
    showToastRef.current = showToast;

    // Decode HTML entities in the incoming markdown value.
    // The @tiptap/markdown extension (via `marked`) preserves entities like &nbsp; as literal
    // text, which then appear visibly in the rendered document. Decoding at the component
    // boundary fixes this for all callers automatically.
    const decodedValue = useMemo(() => decodeHtmlEntitiesInMarkdown(value), [value]);

    const handleImageFiles = useCallback((files: File[], options?: { insertAt?: number }) => {
      const handler = onImageFilesRef.current;
      if (!handler || readOnly || files.length === 0) return false;
      void handler(files, options);
      return true;
    }, [readOnly]);

    const handleUnsupportedFilePasteOrDrop = useCallback(() => {
      showToast?.({ title: 'Use a PNG, JPEG, GIF, or WebP image.' });
    }, [showToast]);

    // Warn about unsupported CodeMirror extensions (annotations, etc.)
    useEffect(() => {
      if (extensions && extensions.length > 0) {
        console.warn(
          '[TipTapMarkdownEditor] CodeMirror extensions are not supported. ' +
          'Use the annotationExtension prop for TipTap-based annotations. ' +
          `Received ${extensions.length} extension(s).`
        );
      }
    }, [extensions]);

    // Build the extensions array, including annotation extension if provided
    // CRITICAL: This must only recalculate when placeholder or annotationExtension actually changes
    const editorExtensions = useMemo(() => {
      const baseExtensions = [
        StarterKit.configure({
          // Configure heading levels
          heading: {
            levels: [1, 2, 3, 4, 5, 6],
          },
          // Disable built-in Link — we configure it separately below
          // with custom options (openOnClick, HTMLAttributes, etc.)
          link: false,
          // Disable TrailingNode — its appendTransaction calls
          // doc.contentMatchAt() on every dispatch, which throws
          // "Called contentMatchAt on a node with invalid content"
          // when @tiptap/markdown produces doc children that don't
          // match the block+ content expression (REBEL-SJ/ZQ).
          trailingNode: false as never,
        }),
        Markdown.configure({
          // Enable GFM for task lists, tables, etc.
          markedOptions: {
            gfm: true,
          },
        }),
        Link.configure({
          openOnClick: false, // We handle clicks ourselves
          autolink: true,
          HTMLAttributes: {
            class: styles.link,
          },
        }),
        Placeholder.configure({
          placeholder,
        }),
        TipTapFindHighlightExtension,
        TableKit,
        TipTapImageExtension.configure({
          documentPath: documentPath ?? null,
          onImageMutation: () => {
            const currentEditor = editorRef.current;
            if (!currentEditor || currentEditor.isDestroyed) return undefined;
            return onImageMutation?.(currentEditor.getMarkdown());
          },
          showToast: (options: { title: string }) => showToastRef.current?.(options),
        }),
      ];

      // Add annotation extension if provided
      if (annotationExtension) {
        baseExtensions.push(annotationExtension);
      }

      return baseExtensions;
    }, [placeholder, annotationExtension, documentPath, onImageMutation]);

    // Performance optimization: Memoize editor config to prevent unnecessary reinitializations
    // Using refs for callbacks ensures the editor isn't recreated when callbacks change
    const editor = useEditor({
      extensions: editorExtensions,
      // NB: content is loaded synchronously at construction (not deferred to
      // onCreate) so that readiness/annotation/outline consumers — notified via
      // onMount → onEditorReady — always observe the fully-loaded document.
      // Deferring the load to onCreate breaks that ordering (onMount fires
      // first, with an empty doc) and silently drops persisted annotations;
      // see the lifecycle test + GPT stage-2 review F1. The content-sync
      // (update) path below is the one that re-parses on every external change,
      // so that is where the REBEL-64W/5KJ crash guard lives. A throw during
      // *initial* construction here is caught by the surface error boundary
      // (it is not locally catchable) — tracked as a residual; revisit with a
      // repro or a pre-validated-doc approach if init-time crashes recur.
      content: decodedValue,
      contentType: 'markdown',
      editable: !readOnly,
      onUpdate: ({ editor }) => {
        if (isInitialized) {
          const markdown = editor.getMarkdown();
          // Use ref to always call the latest onChange without recreating editor
          onChangeRef.current(markdown);
        }
      },
      onCreate: ({ editor }) => {
        editorRef.current = editor;
        setIsInitialized(true);
      },
      // CRITICAL: Use onMount (not onCreate) to notify the parent.
      // In TipTap v3, onCreate fires before <EditorContent> mounts the view
      // to the DOM, so editor.view.dom is not available yet. The onMount
      // callback fires after editor.mount(el) — at which point the view is
      // fully available and downstream hooks can safely access editor.view.
      onMount: ({ editor }) => {
        onEditorReadyRef.current?.(editor);
      },
      editorProps: {
        handlePaste: (_view, event) => {
          const clipboardData = event.clipboardData ?? null;
          if (hasNonWhitespacePlainText(clipboardData)) return false;
          const files = getImageFilesFromFileList(clipboardData?.files ?? null);
          if (files.length === 0 && hasFilesInFileList(clipboardData?.files ?? null)) {
            event.preventDefault();
            handleUnsupportedFilePasteOrDrop();
            return true;
          }
          if (files.length === 0) return false;
          event.preventDefault();
          return handleImageFiles(files);
        },
        handleDrop: (view, event) => {
          const fileList = event.dataTransfer?.files ?? null;
          const files = getImageFilesFromFileList(fileList);
          if (files.length === 0 && hasFilesInFileList(fileList)) {
            event.preventDefault();
            handleUnsupportedFilePasteOrDrop();
            return true;
          }
          if (files.length === 0) return false;
          event.preventDefault();
          const coords = view.posAtCoords({ left: event.clientX, top: event.clientY });
          return handleImageFiles(files, coords ? { insertAt: coords.pos } : undefined);
        },
        transformPastedHTML: stripPastedImageTags,
      },
    });

    // Keep ref in sync
    useEffect(() => {
      editorRef.current = editor;
    }, [editor]);

    // WORKAROUND: TipTap v3's useEditor does not reactively apply `editable` changes.
    // Its EditorInstanceManager.onRender overrides `editable` with the current editor
    // state (this.editor.isEditable) when updating options, so changing the readOnly
    // prop alone won't toggle editability. We explicitly call editor.setEditable()
    // whenever readOnly changes to ensure the DOM contentEditable attribute stays in sync.
    useEffect(() => {
      if (editor && !editor.isDestroyed) {
        const shouldBeEditable = !readOnly;
        if (editor.isEditable !== shouldBeEditable) {
          editor.setEditable(shouldBeEditable);
        }
      }
    }, [editor, readOnly]);

    // Expose methods via ref (compatible with InkMarkdownEditorRef)
    useImperativeHandle(
      ref,
      () => ({
        getDoc: () => editor?.getMarkdown() ?? '',
        getMarkdown: () => editor?.getMarkdown() ?? '',
        focus: () => {
          editor?.commands.focus();
        },
        setSelection: (from: number, to?: number) => {
          if (editor) {
            // Note: ProseMirror uses 1-based positions for start of doc
            const docSize = editor.state.doc.content.size;
            const clampedFrom = Math.max(1, Math.min(from + 1, docSize));
            const clampedTo = to !== undefined ? Math.max(1, Math.min(to + 1, docSize)) : clampedFrom;
            editor.commands.setTextSelection({ from: clampedFrom, to: clampedTo });
            editor.commands.scrollIntoView();
            // Explicitly scroll the editor's content area so the selection lands near the top (same as scrollToAnnotation)
            requestAnimationFrame(() => {
              const currentEditor = editorRef.current;
              if (!currentEditor || currentEditor.isDestroyed) return;
              try {
                const { view } = currentEditor;
                if (view) {
                  const coords = view.coordsAtPos(clampedFrom);
                  if (coords) {
                    const scrollContainer = view.dom.closest(`.${styles.content}`);
                    if (scrollContainer) {
                      const rect = scrollContainer.getBoundingClientRect();
                      const targetY = coords.top - rect.top - 80;
                      scrollContainer.scrollTo({
                        top: scrollContainer.scrollTop + targetY,
                        behavior: 'smooth',
                      });
                    }
                  }
                }
              } catch {
                // Editor view not yet mounted — skip scroll
              }
            });
          }
        },
        scrollToAnnotation: (from: number, to: number) => {
          if (editor) {
            // Annotations use ProseMirror positions directly (no +1 offset needed)
            const docSize = editor.state.doc.content.size;
            const clampedFrom = Math.max(1, Math.min(from, docSize));
            const clampedTo = Math.max(1, Math.min(to, docSize));
            
            // Set selection to highlight the annotated text
            editor.commands.setTextSelection({ from: clampedFrom, to: clampedTo });
            
            // Scroll the selection into view
            // Use a small delay to ensure the selection is set before scrolling
            // Use editorRef to avoid stale closure capturing a destroyed editor
            requestAnimationFrame(() => {
              const currentEditor = editorRef.current;
              // Guard against editor being destroyed during the animation frame
              if (!currentEditor || currentEditor.isDestroyed) return;
              
              // scrollIntoView and coordsAtPos both access editor.view internally,
              // which throws in TipTap v3 if EditorContent hasn't mounted yet.
              try {
                currentEditor.commands.scrollIntoView();
                
                // Also scroll the DOM element into view for better visibility
                const { view } = currentEditor;
                if (view) {
                  const coords = view.coordsAtPos(clampedFrom);
                  if (coords) {
                    // Find the scrollable container (.content has overflow-y: auto, not .editor)
                    const scrollContainer = view.dom.closest(`.${styles.content}`);
                    if (scrollContainer) {
                      const rect = scrollContainer.getBoundingClientRect();
                      const targetY = coords.top - rect.top - 100; // 100px from top for context
                      scrollContainer.scrollTo({
                        top: scrollContainer.scrollTop + targetY,
                        behavior: 'smooth',
                      });
                    }
                  }
                }
              } catch {
                // Editor view not yet mounted — skip scroll
              }
            });
          }
        },
        setFindHighlights: (ranges: TipTapFindHighlightRange[], activeIndex: number) => {
          if (editor && !editor.isDestroyed) {
            setTipTapFindHighlights(editor, ranges, activeIndex);
          }
        },
        clearFindHighlights: () => {
          if (editor && !editor.isDestroyed) {
            clearTipTapFindHighlights(editor);
          }
        },
        getEditor: () => editorRef.current,
      }),
      [editor]
    );

    // Track last value to prevent unnecessary re-renders
    const lastValueRef = useRef(value);
    
    // Handle external value changes
    // CRITICAL: When setContent is called, the editor state is replaced and plugin state
    // (including annotations) is lost. We need to preserve and restore annotations.
    useEffect(() => {
      if (editor && isInitialized) {
        // Skip if value reference hasn't changed (React optimization)
        if (lastValueRef.current === value) {
          return;
        }
        lastValueRef.current = value;
        
        const currentMarkdown = editor.getMarkdown();
        
        // Normalize both strings for comparison to avoid unnecessary setContent calls
        // due to minor formatting differences (trailing newlines, etc.)
        // Compare against decodedValue (not raw value) because the editor content
        // has already been decoded — comparing decoded vs undecoded would always
        // mismatch when entities are present, causing unnecessary setContent cycles.
        const normalizedCurrent = currentMarkdown.trim();
        const normalizedValue = decodedValue.trim();
        
        if (normalizedCurrent !== normalizedValue) {
          // Preserve cursor position
          const { from, to } = editor.state.selection;
          
          // CRITICAL: Preserve annotations before setContent destroys them
          // Check if annotation plugin is present
          const hasAnnotationPlugin = annotationPluginKey.getState(editor.state) !== undefined;
          const annotationsToRestore = hasAnnotationPlugin 
            ? getAnnotationsFromState(editor.state)
            : [];
          
          // Replace content (this destroys plugin state including annotations).
          // Guarded so a schema-invalid markdown fragment can't crash the
          // renderer on a content sync (REBEL-64W/5KJ).
          loadMarkdownContentSafely(editor, decodedValue);
          
          // Restore cursor position
          const newDocSize = editor.state.doc.content.size;
          if (from <= newDocSize) {
            editor.commands.setTextSelection({ from: Math.min(from, newDocSize), to: Math.min(to, newDocSize) });
          }
          
          // CRITICAL: Restore annotations after setContent with position recovery.
          // setContent destroys plugin state, so we search for each annotation's
          // text within the NEW ProseMirror document to get correct PM positions.
          // (Raw markdown offsets differ from PM positions due to node boundaries
          // and stripped syntax characters like #, **, etc.)
          if (annotationsToRestore.length > 0 && hasAnnotationPlugin) {
            const storedAnnotations = toStoredAnnotations(annotationsToRestore);
            const newDoc = editor.state.doc;

            const validAnnotations: Annotation[] = [];
            for (const stored of storedAnnotations) {
              const pos = findTextInDoc(newDoc, stored.text, stored.from ?? stored.textOffset);
              if (pos && pos.from >= 0 && pos.to > pos.from) {
                validAnnotations.push({
                  id: stored.id,
                  from: pos.from,
                  to: pos.to,
                  text: stored.text,
                  comment: stored.comment,
                  createdAt: stored.createdAt,
                });
              }
            }
            
            if (validAnnotations.length > 0) {
              try {
                dispatchLoadAnnotations(editor.view, validAnnotations);
              } catch {
                console.warn('[TipTapMarkdownEditor] Could not restore annotations — editor view not available');
              }
            }
          }
        }
      }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- intentional: value updates flow through decodedValue; adding value would cause cursor reset on every keystroke
    }, [editor, decodedValue, isInitialized]);

    // Handle link clicks
    const handleClick = useCallback(
      (e: React.MouseEvent<HTMLDivElement>) => {
        const target = e.target as HTMLElement;
        const link = target.closest('a');
        if (link && onLinkClick) {
          const href = link.getAttribute('href');
          if (href) {
            e.preventDefault();
            e.stopPropagation();
            onLinkClick(href);
          }
        }
      },
      [onLinkClick]
    );

    // Cleanup
    useEffect(() => {
      return () => {
        editor?.destroy();
      };
    }, [editor]);

    return (
      <div
        className={`${styles.editor} ${className ?? ''}`}
        onClick={handleClick}
        data-testid="tiptap-markdown-editor"
      >
        <EditorContent editor={editor} className={styles.content} />
        {/* Floating selection toolbar - appears when text is selected */}
        <SelectionToolbar
          editor={editor}
          onReply={onReply}
          onReplyInNewChat={onReplyInNewChat}
          onAddComment={onAddComment}
          showAddComment={showAddComment}
          showToast={showToast}
        />
      </div>
    );
  }
);

TipTapMarkdownEditor.displayName = 'TipTapMarkdownEditor';
