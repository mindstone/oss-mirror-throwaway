/**
 * SelectionToolbar
 *
 * A Notion-style floating toolbar that appears when text is selected in the
 * TipTap editor. Provides quick access to Copy, Ask Rebel in New Chat, and Add Comment actions.
 *
 * Uses TipTap's BubbleMenu extension for positioning and show/hide logic.
 */

import { memo, useCallback } from 'react';
import type { Editor } from '@tiptap/react';
import type { EditorState } from '@tiptap/pm/state';
import { BubbleMenu } from '@tiptap/react/menus';
import { Copy, MessageSquarePlus, SquarePen } from 'lucide-react';
import { Button, Tooltip } from '@renderer/components/ui';
import styles from './SelectionToolbar.module.css';

export interface SelectionToolbarProps {
  /** The TipTap editor instance */
  editor: Editor | null;
  /** Callback when Ask Rebel is clicked - receives selected text */
  onReply?: (text: string) => void;
  /** Callback when Ask Rebel in New Chat is clicked - receives selected text */
  onReplyInNewChat?: (text: string) => void;
  /** Callback when Add Comment is clicked - receives selected text and position info */
  onAddComment?: (text: string, from: number, to: number) => void;
  /** Whether to show the Add Comment button (default: false) */
  showAddComment?: boolean;
  /** Toast notification function for feedback */
  showToast?: (options: { title: string }) => void;
}

// Performance optimization: Memoize static config objects outside component
const TIPPY_OPTIONS = {
  duration: [150, 100] as [number, number],
  placement: 'top' as const,
  offset: [0, 8] as [number, number],
  // CRITICAL: Don't hide on click - we need to interact with the toolbar buttons
  // Setting this to true was causing the toolbar to disappear in edit mode
  hideOnClick: false,
  // Allow interactions with the toolbar (clicking buttons, hovering, etc.)
  // This prevents the toolbar from hiding when mouse moves over it
  interactive: true,
};

// Performance optimization: shouldShow callback is static - no need to recreate
const shouldShowToolbar = ({ editor: ed, state }: { editor: Editor; state: EditorState }) => {
  const { from, to, empty } = state.selection;
  // Don't show on empty selection
  if (empty) return false;
  // Don't show if selection is too short (likely accidental)
  const text = ed.state.doc.textBetween(from, to, ' ').trim();
  if (text.length < 2) return false;
  return true;
};

const preserveEditorSelection = (event: { preventDefault: () => void }) => {
  event.preventDefault();
};

const SelectionToolbarComponent = ({
  editor,
  onReply: _onReply,
  onReplyInNewChat,
  onAddComment,
  showAddComment = false,
  showToast,
}: SelectionToolbarProps) => {
  // Get selected text from editor
  const getSelectedText = useCallback((): string => {
    if (!editor) return '';
    const { from, to } = editor.state.selection;
    return editor.state.doc.textBetween(from, to, ' ');
  }, [editor]);

  // Get selection positions
  const getSelectionRange = useCallback((): { from: number; to: number } => {
    if (!editor) return { from: 0, to: 0 };
    const { from, to } = editor.state.selection;
    return { from, to };
  }, [editor]);

  const handleCopy = useCallback(() => {
    const text = getSelectedText();
    if (!text) return;
    
    navigator.clipboard.writeText(text)
      .then(() => {
        showToast?.({ title: 'Copied to clipboard' });
      })
      .catch(() => {
        showToast?.({ title: 'Failed to copy' });
      });
  }, [getSelectedText, showToast]);

  const handleReplyInNewChat = useCallback(() => {
    const text = getSelectedText();
    if (!text || !onReplyInNewChat) return;
    onReplyInNewChat(text);
  }, [getSelectedText, onReplyInNewChat]);

  const handleAddComment = useCallback(() => {
    const text = getSelectedText();
    const { from, to } = getSelectionRange();
    if (!text || !onAddComment) return;
    onAddComment(text, from, to);
  }, [getSelectedText, getSelectionRange, onAddComment]);

  if (!editor) {
    return null;
  }

  return (
    <BubbleMenu
      editor={editor}
      // tippyOptions/shouldShow not in latest BubbleMenu types but still functional at runtime
      {...{ tippyOptions: TIPPY_OPTIONS, shouldShow: shouldShowToolbar } as Record<string, unknown>}
      className={styles.toolbar}
    >
      {/* Copy button */}
      <Tooltip content="Copy selected text" placement="top" delayShow={400}>
        <Button
          variant="ghost"
          size="sm"
          className={styles.toolbarButton}
          onMouseDown={preserveEditorSelection}
          onClick={handleCopy}
          aria-label="Copy"
        >
          <Copy size={14} className={styles.icon} />
          <span className={styles.label}>Copy</span>
        </Button>
      </Tooltip>

      {/* Ask Rebel in New Chat button */}
      {onReplyInNewChat && (
        <Tooltip content="Ask Rebel in a new chat" placement="top" delayShow={400}>
          <Button
            variant="ghost"
            size="sm"
            className={styles.toolbarButton}
            onMouseDown={preserveEditorSelection}
            onClick={handleReplyInNewChat}
            aria-label="Ask Rebel in New Chat"
          >
            <SquarePen size={14} className={styles.icon} />
            <span className={styles.label}>New Chat</span>
          </Button>
        </Tooltip>
      )}

      {/* Add Comment button (conditional) */}
      {showAddComment && onAddComment && (
        <Tooltip content="Add a comment on this selection" placement="top" delayShow={400}>
          <Button
            variant="ghost"
            size="sm"
            className={styles.toolbarButton}
            onMouseDown={preserveEditorSelection}
            onClick={handleAddComment}
            aria-label="Add Comment"
          >
            <MessageSquarePlus size={14} className={styles.icon} />
            <span className={styles.label}>Comment</span>
          </Button>
        </Tooltip>
      )}
    </BubbleMenu>
  );
};

SelectionToolbarComponent.displayName = 'SelectionToolbar';

export const SelectionToolbar = memo(SelectionToolbarComponent);
