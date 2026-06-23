/**
 * AnnotatedTipTapEditor
 *
 * Shared component that renders TipTapMarkdownEditor wrapped with annotation
 * popovers (add + edit). Consumes UseAnnotatedMarkdownEditorResult from the
 * shared hook, eliminating ~100 LOC of near-identical rendering code across
 * DocumentPreviewDrawer and LibraryEditorPanel.
 *
 * @see docs/plans/finished/260223_unify_document_preview_and_library_editor.md
 */

import type { FC } from 'react';
import { TipTapMarkdownEditor } from './TipTapMarkdownEditor';
import { AnnotationPopover } from './AnnotationPopover';
import type { UseAnnotatedMarkdownEditorResult } from '../hooks/useAnnotatedMarkdownEditor';

export interface AnnotatedTipTapEditorProps {
  editorResult: UseAnnotatedMarkdownEditorResult;
  documentPath?: string;
  className?: string;
  /** Passed to TipTapMarkdownEditor's className (for nested .ProseMirror CSS rules). */
  editorClassName?: string;
  readOnly?: boolean;
  /** Controls which actions appear in the selection toolbar (e.g. 'copy,reply,add-comment'). */
  selectableContentActions?: string;
  placeholder?: string;
  showAddComment?: boolean;
  onLinkClick?: (url: string) => void;
  onReply?: (text: string) => void;
  onReplyInNewChat?: (text: string) => void;
  showToast?: (options: { title: string }) => void;
  onImageMutation?: (markdown: string) => void | Promise<void>;
  onImageFiles?: (files: File[], options?: { insertAt?: number }) => void | Promise<void>;
}

const noOp = () => {};

export const AnnotatedTipTapEditor: FC<AnnotatedTipTapEditorProps> = ({
  editorResult,
  documentPath,
  className,
  editorClassName,
  readOnly = false,
  selectableContentActions,
  placeholder = 'Start writing\u2026',
  showAddComment = true,
  onLinkClick,
  onReply,
  onReplyInNewChat,
  showToast,
  onImageMutation,
  onImageFiles,
}) => {
  const { editor, annotations, selectionUi, content } = editorResult;

  return (
    <div
      className={className}
      data-selectable-content={selectableContentActions}
      data-document-path={documentPath}
    >
      <TipTapMarkdownEditor
        ref={editor.ref}
        value={content.displayContent}
        onChange={readOnly ? noOp : content.handleTipTapChange}
        onLinkClick={onLinkClick}
        placeholder={placeholder}
        readOnly={readOnly}
        className={editorClassName}
        annotationExtension={annotations.extension}
        onEditorReady={editor.onReady}
        onReply={onReply}
        onReplyInNewChat={onReplyInNewChat}
        onAddComment={selectionUi.handleAddFromToolbar}
        showAddComment={showAddComment}
        showToast={showToast}
        documentPath={documentPath}
        onImageMutation={onImageMutation}
        onImageFiles={onImageFiles}
      />

      <AnnotationPopover
        isOpen={
          !annotations.editing &&
          selectionUi.mode === 'comment' &&
          ((annotations.selection !== null && annotations.selection.coords !== null) ||
            selectionUi.pendingSelection !== null)
        }
        coords={annotations.selection?.coords ?? selectionUi.pendingSelection?.coords ?? null}
        selectedText={annotations.selection?.text ?? selectionUi.pendingSelection?.text ?? ''}
        onSubmit={selectionUi.handleSubmit}
        onClose={selectionUi.handleClose}
        placeholder="What feedback do you have about this text?"
      />

      <AnnotationPopover
        isOpen={annotations.editing !== null}
        coords={annotations.editing?.coords ?? null}
        selectedText={annotations.editing?.annotation.text ?? ''}
        onSubmit={noOp}
        onClose={annotations.clearEditing}
        editingId={annotations.editing?.annotation.id}
        editingComment={annotations.editing?.annotation.comment}
        onUpdate={annotations.update}
        onDelete={annotations.remove}
      />
    </div>
  );
};

AnnotatedTipTapEditor.displayName = 'AnnotatedTipTapEditor';
