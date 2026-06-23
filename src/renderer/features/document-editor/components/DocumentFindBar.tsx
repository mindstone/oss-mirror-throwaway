import { useCallback, useEffect, useRef, useState, memo } from 'react';
import { ChevronUp, ChevronDown, X } from 'lucide-react';
import { Button } from '@renderer/components/ui';
import { findAllTextMatchesInDoc } from '@renderer/features/library/extensions/tiptapAnnotationExtension';
import type { TipTapMarkdownEditorRef } from '@renderer/features/library/components/TipTapMarkdownEditor';
import styles from './UnifiedDocumentEditor.module.css';

/**
 * Match represents a single hit, in whichever coordinate system applies to
 * the active surface:
 *  - Markdown (TipTap):  `from`/`to` are native ProseMirror positions.
 *  - Plain text (textarea): `from`/`to` are character offsets into the
 *    textarea value (which equals `content`).
 *
 * A unified shape lets the navigation logic stay branch-free outside of the
 * single point where we hand off to either `scrollToAnnotation` or
 * `setSelectionRange`.
 */
interface FindMatch {
  from: number;
  to: number;
}

interface DocumentFindBarProps {
  content: string | null;
  isMarkdownFile: boolean;
  /**
   * Imperative ref to the TipTap markdown editor. Used to locate matches in
   * the rendered ProseMirror document and navigate to them — searching the
   * raw markdown source produces wrong positions because syntax characters,
   * frontmatter, and the persisted annotation comment block don't appear in
   * the rendered doc (Sentry REBEL-5CK).
   */
  editorRef: React.RefObject<TipTapMarkdownEditorRef | null>;
  textareaRef: React.RefObject<HTMLTextAreaElement | null>;
  onClose: () => void;
}

const DocumentFindBarComponent = ({
  content,
  isMarkdownFile,
  editorRef,
  textareaRef,
  onClose,
}: DocumentFindBarProps) => {
  const [findQuery, setFindQuery] = useState('');
  const [findIndex, setFindIndex] = useState(0);
  const [findMatches, setFindMatches] = useState<FindMatch[]>([]);
  const findInputRef = useRef<HTMLInputElement>(null);
  const highlightedEditorRef = useRef<TipTapMarkdownEditorRef | null>(null);

  useEffect(() => {
    findInputRef.current?.focus();
  }, []);

  useEffect(() => {
    if (!findQuery) {
      setFindMatches([]);
      setFindIndex(0);
      if (isMarkdownFile) {
        highlightedEditorRef.current?.clearFindHighlights();
        highlightedEditorRef.current = null;
      }
      return;
    }

    if (isMarkdownFile) {
      // Search the rendered ProseMirror document so positions reflect what
      // the user actually sees. The editor may not be mounted yet on the
      // first render; in that case fall back to "no matches" until the
      // content prop changes (which happens once the editor is ready).
      const editor = editorRef.current?.getEditor();
      if (!editor || editor.isDestroyed) {
        setFindMatches([]);
        setFindIndex(0);
        return;
      }
      const pmMatches = findAllTextMatchesInDoc(editor.state.doc, findQuery);
      setFindMatches(pmMatches);
      setFindIndex(0);
      highlightedEditorRef.current = editorRef.current;
      highlightedEditorRef.current?.setFindHighlights(pmMatches, 0);
      // Mirror FindBar.tsx's applyFindHighlights → scrollRangeIntoView: a
      // visual highlight alone never moves the viewport, so the first match
      // stays off-screen and the first DOWN click appears to skip to match 2.
      // Scroll the first match into view as soon as we have one.
      if (pmMatches.length > 0) {
        editorRef.current?.scrollToAnnotation(pmMatches[0].from, pmMatches[0].to);
      }
      return;
    }

    if (!content) {
      setFindMatches([]);
      setFindIndex(0);
      return;
    }

    const matches: FindMatch[] = [];
    const query = findQuery.toLowerCase();
    const lowerContent = content.toLowerCase();
    let pos = 0;

    while ((pos = lowerContent.indexOf(query, pos)) !== -1) {
      matches.push({ from: pos, to: pos + findQuery.length });
      pos += 1;
    }

    setFindMatches(matches);
    setFindIndex(0);
  }, [findQuery, content, isMarkdownFile, editorRef]);

  useEffect(() => {
    return () => {
      if (isMarkdownFile) {
        highlightedEditorRef.current?.clearFindHighlights();
        highlightedEditorRef.current = null;
      }
    };
  }, [isMarkdownFile]);

  const goToMatch = useCallback((index: number) => {
    if (findMatches.length === 0) return;

    const wrappedIndex = ((index % findMatches.length) + findMatches.length) % findMatches.length;
    const match = findMatches[wrappedIndex];
    setFindIndex(wrappedIndex);

    if (isMarkdownFile && editorRef.current) {
      highlightedEditorRef.current = editorRef.current;
      editorRef.current.setFindHighlights(findMatches, wrappedIndex);
      // `scrollToAnnotation` expects native ProseMirror positions (no +1
      // offset) and handles focus + selection + scrolling. Despite the name,
      // it's the right primitive for any "select a PM range" call.
      editorRef.current.scrollToAnnotation(match.from, match.to);
    } else if (textareaRef.current) {
      textareaRef.current.focus();
      textareaRef.current.setSelectionRange(match.from, match.to);
    }
    // F2 (REBEL-5WF, follow-up): for non-markdown files in read-only preview
    // mode the textarea isn't mounted (`textareaRef.current === null`), so
    // navigation is a silent no-op even though a match count is shown. A real
    // fix (CSS Custom Highlight API over the <MessageMarkdown> preview surface,
    // or suppressing the bar in the parent) lives outside this component and is
    // tracked separately — see plan Stage 2 notes.
  }, [findMatches, isMarkdownFile, editorRef, textareaRef]);

  const handleFindKeyDown = useCallback((e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter' && findMatches.length > 0) {
      e.preventDefault();
      goToMatch(e.shiftKey ? findIndex - 1 : findIndex + 1);
    }
  }, [findMatches.length, findIndex, goToMatch]);

  const handleClose = useCallback(() => {
    setFindQuery('');
    if (isMarkdownFile && editorRef.current) {
      highlightedEditorRef.current?.clearFindHighlights();
      highlightedEditorRef.current = null;
      editorRef.current.focus();
    } else {
      textareaRef.current?.focus();
    }
    onClose();
  }, [isMarkdownFile, editorRef, textareaRef, onClose]);

  // Navigation requires either the TipTap editor (markdown) or a mounted
  // textarea (plain-text editing mode). When neither is available — e.g. a
  // non-markdown file rendered as a read-only <MessageMarkdown> preview — the
  // match count is still accurate but the nav arrows would silently do nothing.
  // Disable them visibly so the user isn't misled (REBEL-5WF F2).
  const canNavigate = isMarkdownFile || textareaRef.current !== null;

  return (
    <div className={styles.findBar}>
      <input
        ref={findInputRef}
        type="text"
        className={styles.findInput}
        value={findQuery}
        onChange={(e) => setFindQuery(e.target.value)}
        onKeyDown={handleFindKeyDown}
        placeholder="Find in file..."
        autoComplete="off"
        spellCheck={false}
      />
      <span className={styles.findCount}>
        {findMatches.length > 0
          ? `${findIndex + 1} of ${findMatches.length}`
          : findQuery
            ? 'No matches'
            : ''}
      </span>
      <Button
        variant="ghost"
        size="sm"
        className={styles.findNavButton}
        onClick={() => goToMatch(findIndex - 1)}
        disabled={findMatches.length === 0 || !canNavigate}
        title="Previous match (Shift+Enter)"
      >
        <ChevronUp size={14} />
      </Button>
      <Button
        variant="ghost"
        size="sm"
        className={styles.findNavButton}
        onClick={() => goToMatch(findIndex + 1)}
        disabled={findMatches.length === 0 || !canNavigate}
        title="Next match (Enter)"
      >
        <ChevronDown size={14} />
      </Button>
      <Button
        variant="ghost"
        size="sm"
        className={styles.findCloseButton}
        onClick={handleClose}
        title="Close (Escape)"
      >
        <X size={14} />
      </Button>
    </div>
  );
};

export const DocumentFindBar = memo(DocumentFindBarComponent);
