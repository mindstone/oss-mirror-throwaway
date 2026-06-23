/**
 * AnnotationPopover
 *
 * Floating popover for adding/editing annotations on selected text.
 * Uses @floating-ui/react with a virtual reference element based on
 * selection coordinates from CodeMirror.
 */

import { useState, useRef, useCallback, useEffect, useMemo, type FC } from 'react';
import {
  useFloating,
  autoUpdate,
  offset,
  flip,
  shift,
  FloatingPortal,
  useDismiss,
  useInteractions,
} from '@floating-ui/react';
import { MessageSquarePlus, Plus, Check, X } from 'lucide-react';
import { Button } from '@renderer/components/ui/Button';
import styles from './AnnotationPopover.module.css';

export interface SelectionCoords {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

export interface AnnotationPopoverProps {
  /** Whether the popover is visible */
  isOpen: boolean;
  /** Coordinates of the selection (from view.coordsAtPos) */
  coords: SelectionCoords | null;
  /** The selected text */
  selectedText: string;
  /** Callback when user submits a new annotation */
  onSubmit: (comment: string) => void;
  /** Callback to close the popover */
  onClose: () => void;
  /** Optional placeholder text */
  placeholder?: string;
  /** Edit mode: existing annotation ID */
  editingId?: string;
  /** Edit mode: existing comment to pre-fill */
  editingComment?: string;
  /** Callback when user updates an existing annotation */
  onUpdate?: (id: string, comment: string) => void;
  /** Callback when user deletes the annotation being edited */
  onDelete?: (id: string) => void;
  /** Auto-focus the textarea when popover opens (default: false for library editor) */
  autoFocus?: boolean;
}

/**
 * Creates a virtual element for floating-ui based on selection coordinates.
 */
function createVirtualElement(coords: SelectionCoords) {
  return {
    getBoundingClientRect() {
      return {
        x: coords.left,
        y: coords.top,
        width: coords.right - coords.left,
        height: coords.bottom - coords.top,
        top: coords.top,
        left: coords.left,
        right: coords.right,
        bottom: coords.bottom,
      };
    },
  };
}

export const AnnotationPopover: FC<AnnotationPopoverProps> = ({
  isOpen,
  coords,
  selectedText,
  onSubmit,
  onClose,
  placeholder = 'Add your comment...',
  editingId,
  editingComment,
  onUpdate,
  onDelete,
  autoFocus = false,
}) => {
  const [comment, setComment] = useState('');
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const isEditMode = !!editingId;

  // Create virtual reference element from coords - memoized to update when coords change
  const virtualElement = useMemo(() => {
    if (!coords) return null;
    return createVirtualElement(coords);
  }, [coords]);

  const {
    refs,
    floatingStyles,
    context,
  } = useFloating({
    open: isOpen && coords !== null,
    onOpenChange: (open) => {
      if (!open) onClose();
    },
    placement: 'bottom-start',
    middleware: [
      offset(8),
      flip({
        fallbackAxisSideDirection: 'start',
        padding: 8,
      }),
      shift({ padding: 8 }),
    ],
    whileElementsMounted: autoUpdate,
  });

  // Set virtual element as position reference (not via elements.reference which requires real DOM)
  useEffect(() => {
    if (virtualElement) {
      refs.setPositionReference(virtualElement);
    }
  }, [virtualElement, refs]);

  const dismiss = useDismiss(context, {
    escapeKey: true,
    outsidePress: true,
  });

  const { getFloatingProps } = useInteractions([dismiss]);

  // Auto-focus textarea when popover opens (if enabled)
  // Note: Default is off for library editor to preserve text selection for copy.
  // Conversation annotations pass autoFocus=true since selection is already cleared.
  useEffect(() => {
    if (isOpen && autoFocus) {
      // Small delay to ensure popover is positioned before focusing
      const timer = setTimeout(() => {
        textareaRef.current?.focus();
      }, 50);
      return () => clearTimeout(timer);
    }
  }, [isOpen, autoFocus]);

  // Reset or pre-fill comment when popover opens/closes
  useEffect(() => {
    if (!isOpen) {
      setComment('');
    } else if (isEditMode && editingComment) {
      setComment(editingComment);
    }
  }, [isOpen, isEditMode, editingComment]);

  const handleSubmit = useCallback(() => {
    if (comment.trim()) {
      if (isEditMode && editingId && onUpdate) {
        onUpdate(editingId, comment.trim());
      } else {
        onSubmit(comment.trim());
      }
      setComment('');
    }
  }, [comment, isEditMode, editingId, onSubmit, onUpdate]);

  const handleDelete = useCallback(() => {
    if (editingId && onDelete) {
      onDelete(editingId);
    }
  }, [editingId, onDelete]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        handleSubmit();
      }
    },
    [handleSubmit]
  );

  if (!isOpen || !coords) {
    return null;
  }

  // Truncate selected text for preview
  const previewText =
    selectedText.length > 100
      ? `${selectedText.slice(0, 100)}...`
      : selectedText;

  return (
    <FloatingPortal>
      <div
        ref={refs.setFloating}
        style={floatingStyles}
        className={styles.popover}
        data-annotation-popover
        {...getFloatingProps()}
      >
        <div className={styles.header}>
          <div className={styles.headerTitle}>
            <MessageSquarePlus size={16} />
            <span>{isEditMode ? 'Edit Comment' : 'Add Comment'}</span>
          </div>
          <button
            className={styles.closeButton}
            onClick={onClose}
            aria-label="Close"
          >
            <X size={14} />
          </button>
        </div>

        <div className={styles.selectedTextPreview}>
          <span className={styles.quoteIcon}>"</span>
          <span className={styles.selectedText}>{previewText}</span>
          <span className={styles.quoteIcon}>"</span>
        </div>

        <div className={styles.inputArea}>
          <textarea
            ref={textareaRef}
            value={comment}
            onChange={(e) => setComment(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={placeholder}
            className={styles.textarea}
            rows={3}
          />
        </div>

        <div className={styles.footer}>
          <span className={styles.hint}>
            {navigator.platform.includes('Mac') ? '⌘' : 'Ctrl'}+Enter to submit
          </span>
          <div className={styles.actions}>
            {isEditMode && onDelete && (
              <Button
                variant="ghost"
                size="sm"
                onClick={handleDelete}
                className={styles.deleteButton}
              >
                Delete
              </Button>
            )}
            <Button
              variant="ghost"
              size="sm"
              onClick={onClose}
            >
              Cancel
            </Button>
            <Button
              size="sm"
              onClick={handleSubmit}
              disabled={!comment.trim()}
            >
              {isEditMode ? <Check size={14} /> : <Plus size={14} />}
              {isEditMode ? 'Save' : 'Add'}
            </Button>
          </div>
        </div>
      </div>
    </FloatingPortal>
  );
};

AnnotationPopover.displayName = 'AnnotationPopover';
