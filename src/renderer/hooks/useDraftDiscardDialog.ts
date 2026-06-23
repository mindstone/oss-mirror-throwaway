import { useCallback, useMemo, useState } from 'react';
import type { ComposerHandle } from '@renderer/features/composer/ComposerWithState';

/**
 * Pending draft discard state.
 * When set, shows a confirmation dialog before executing the action.
 */
export interface PendingDraftDiscard {
  /** The action to execute if user confirms discard */
  action: () => void;
  /** Preview text of the draft being discarded */
  draftText: string;
  /** Type of content being discarded - affects dialog copy */
  type: 'draft' | 'attachments';
}

/**
 * Options for the useDraftDiscardDialog hook.
 */
export interface UseDraftDiscardDialogOptions {
  /** Ref to the composer handle for checking/clearing draft content */
  composerRef: React.RefObject<ComposerHandle | null>;
  /** Callback to refocus the composer after cancel */
  focusComposer: () => void;
}

/**
 * Return type for the useDraftDiscardDialog hook.
 */
export interface UseDraftDiscardDialogResult {
  /** Current pending discard state, or null if no dialog is shown */
  pendingDraftDiscard: PendingDraftDiscard | null;
  /**
   * Check if there's a draft and prompt for confirmation if needed.
   * If no draft, the action executes immediately.
   * @deprecated Use checkAttachmentsBeforeAction for session switching - drafts now auto-persist
   */
  checkDraftBeforeAction: (action: () => void) => void;
  /**
   * Check if there are attachments and prompt for confirmation if needed.
   * If no attachments, the action executes immediately.
   * Use this for session switching since drafts auto-persist but attachments don't.
   */
  checkAttachmentsBeforeAction: (action: () => void) => void;
  /** Confirm and execute the pending action, clearing the draft */
  handleConfirm: () => void;
  /** Cancel and refocus the composer */
  handleCancel: () => void;
}

/**
 * Hook for managing draft discard confirmation dialog.
 *
 * When the user has unsaved text or attachments in the composer,
 * this hook provides a way to prompt for confirmation before
 * navigating away or starting a new session.
 *
 * @example
 * const { pendingDraftDiscard, checkDraftBeforeAction, handleConfirm, handleCancel } =
 *   useDraftDiscardDialog({ composerRef, focusComposer });
 *
 * // Wrap navigation actions to guard against accidental draft loss
 * const handleOpenSession = (sessionId: string) => {
 *   checkDraftBeforeAction(() => navigateToSession(sessionId));
 * };
 *
 * // Render the dialog when pendingDraftDiscard is set
 * {pendingDraftDiscard ? (
 *   <DraftDiscardDialog
 *     draftPreview={pendingDraftDiscard.draftText}
 *     onDiscard={handleConfirm}
 *     onCancel={handleCancel}
 *   />
 * ) : null}
 */
export function useDraftDiscardDialog({
  composerRef,
  focusComposer,
}: UseDraftDiscardDialogOptions): UseDraftDiscardDialogResult {
  const [pendingDraftDiscard, setPendingDraftDiscard] = useState<PendingDraftDiscard | null>(null);

  const checkDraftBeforeAction = useCallback(
    (action: () => void) => {
      const draft = composerRef.current?.getText()?.trim() ?? '';
      const attachments = composerRef.current?.getAttachments() ?? [];
      const hasAttachments = attachments.length > 0;
      if (draft.length > 0 || hasAttachments) {
        const draftText = draft || `${attachments.length} file${attachments.length === 1 ? '' : 's'} attached`;
        const type = draft.length > 0 ? 'draft' : 'attachments';
        setPendingDraftDiscard({ action, draftText, type });
      } else {
        action();
      }
    },
    [composerRef]
  );

  // Attachment-only check for session switching (drafts now auto-persist)
  const checkAttachmentsBeforeAction = useCallback(
    (action: () => void) => {
      const attachments = composerRef.current?.getAttachments() ?? [];
      const hasAttachments = attachments.length > 0;
      if (hasAttachments) {
        const draftText = `${attachments.length} file${attachments.length === 1 ? '' : 's'} attached`;
        setPendingDraftDiscard({ action, draftText, type: 'attachments' });
      } else {
        action();
      }
    },
    [composerRef]
  );

  const handleConfirm = useCallback(() => {
    if (pendingDraftDiscard) {
      composerRef.current?.clear();
      pendingDraftDiscard.action();
      setPendingDraftDiscard(null);
    }
  }, [composerRef, pendingDraftDiscard]);

  const handleCancel = useCallback(() => {
    setPendingDraftDiscard(null);
    // Refocus the input so user can continue typing
    requestAnimationFrame(() => {
      focusComposer();
    });
  }, [focusComposer]);

  // Return a stable object to avoid re-render cascades
  return useMemo(
    () => ({
      pendingDraftDiscard,
      checkDraftBeforeAction,
      checkAttachmentsBeforeAction,
      handleConfirm,
      handleCancel,
    }),
    [pendingDraftDiscard, checkDraftBeforeAction, checkAttachmentsBeforeAction, handleConfirm, handleCancel]
  );
}
