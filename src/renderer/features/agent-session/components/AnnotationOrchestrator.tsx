/**
 * AnnotationOrchestrator
 *
 * Owns all conversation annotation state, hooks, effects, and callbacks.
 * Renders AnnotationBar, TextSelectionMenuLayer, AnnotationPopover (x2),
 * and AnnotationIcons. Extracted from App.tsx to isolate annotation state
 * changes from the main render path.
 *
 * State communicated back to App.tsx:
 * - `onAnnotationActiveChange` fires when annotation popover or editing state changes
 *   (used by App.tsx hotkey guard for Cmd+Enter)
 */

import { memo, useCallback, useEffect, useLayoutEffect, useRef, useState, type MutableRefObject } from 'react';
import type { RefObject } from 'react';
import type { ToastMessage } from '@renderer/contexts';
import { useAppContextSafe } from '@renderer/contexts/AppContext';
import { AnnotationFormatExhaustionError } from '@rebel/shared';
import { useConversationAnnotations } from '../hooks/useConversationAnnotations';
import { useAnnotationHighlights } from '../hooks/useAnnotationHighlights';
import { AnnotationBar } from './AnnotationBar';
import { AnnotationIcons } from './AnnotationIcons';
import { AnnotationPopover } from '@renderer/features/library/components/AnnotationPopover';
import { TextSelectionMenuLayer, type SelectionData, type SelectionContext } from './TextSelectionMenu';
import type { ConversationPaneHandle } from './ConversationPane';
import type { ComposerHandle } from '@renderer/features/composer/ComposerWithState';
import { fireAndForget } from '@shared/utils/fireAndForget';

// ─── Props ──────────────────────────────────────────────────────────────────
export interface AnnotationOrchestratorProps {
  currentSessionId: string;
  agentSessionLogRef: RefObject<ConversationPaneHandle | null>;
  handleUserMessage: (...args: unknown[]) => Promise<void>;
  composerRef: RefObject<ComposerHandle | null>;
  clearComposerAfterSend: () => void;
  isBusy: boolean;
  showToast: (message: ToastMessage) => void;
  // Outbound
  onAnnotationActiveChange: (isActive: boolean) => void;
  onAnnotationCountChange: (count: number) => void;
  /** Mutable ref that the orchestrator writes its send function to, so the composer can call it */
  sendAnnotationsRef: MutableRefObject<(() => void) | null>;
  // Mention resolution (so annotation send path resolves @mentions in composer text)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- attachment payload union varies
  prepareMentionAttachments: (promptText: string) => Promise<any[]>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- attachment payload union varies
  prepareConversationAttachments: (text: string) => Promise<any[]>;
  // TextSelectionMenuLayer non-annotation callbacks (pass-through from App.tsx)
  onReply: (context: SelectionContext) => void;
  onReplyInNewChat: (context: SelectionContext) => void;
  onGenericAddComment: (text: string, documentPath?: string, hintOffset?: number) => void;
  onMenuOpenChange: (isOpen: boolean) => void;
}

// ─── Component ──────────────────────────────────────────────────────────────
export const AnnotationOrchestrator = memo(function AnnotationOrchestrator({
  currentSessionId,
  agentSessionLogRef,
  handleUserMessage,
  composerRef,
  clearComposerAfterSend,
  isBusy,
  showToast,
  onAnnotationActiveChange,
  onAnnotationCountChange,
  sendAnnotationsRef,
  prepareMentionAttachments,
  prepareConversationAttachments,
  onReply,
  onReplyInNewChat,
  onGenericAddComment,
  onMenuOpenChange,
}: AnnotationOrchestratorProps) {

  // ─── Structured log sink ────────────────────────────────────────────────
  // Used by the fence-collision exhaustion catch in
  // `handleSendConversationAnnotations` so the failure leaves a session
  // breadcrumb, not just a toast. `useAppContextSafe` returns null outside
  // an AppProvider (tests, storybook); in that case `emitLog` is undefined
  // and the catch still shows the toast without a log entry.
  const appContext = useAppContextSafe();
  const emitLog = appContext?.emitLog;

  // ─── Conversation annotations hook ──────────────────────────────────────
  // Conversation annotations - ephemeral comments on AI replies
  const {
    annotations: conversationAnnotations,
    hasAnnotations: hasConversationAnnotations,
    annotationCount: conversationAnnotationCount,
    addAnnotation: addConversationAnnotation,
    updateAnnotation: updateConversationAnnotation,
    removeAnnotation: removeConversationAnnotation,
    clearAnnotations: clearConversationAnnotations,
    formatAnnotationsMessage: formatConversationAnnotationsMessage,
    formatDisplayMessage: formatConversationDisplayMessage,
  } = useConversationAnnotations(currentSessionId);

  // ─── Annotation state ───────────────────────────────────────────────────
  // Annotation selection state - tracks current text selection for popover
  const [annotationSelection, setAnnotationSelection] = useState<{
    text: string;
    messageId: string;
    rect: DOMRect;
    startOffset: number;
    endOffset: number;
  } | null>(null);

  // Whether the annotation comment popover is open (user clicked "Add Comment" from menu)
  const [isAnnotationPopoverOpen, setIsAnnotationPopoverOpen] = useState(false);

  // Annotation editing state - tracks which annotation is being edited
  const [editingAnnotation, setEditingAnnotation] = useState<{
    id: string;
    text: string;
    comment: string;
    rect: DOMRect;
  } | null>(null);

  // Scroll container ref for annotation highlights (wraps ConversationPane's scroll element)
  const annotationScrollContainerRef = useRef<HTMLElement | null>(null);

  // ─── Annotation highlights ──────────────────────────────────────────────
  // Get message element by ID for annotation highlights
  const getMessageElement = useCallback((messageId: string): HTMLElement | null => {
    return document.querySelector(`[data-message-id="${messageId}"] [data-message-body]`);
  }, []);

  // Apply CSS Custom Highlight API for annotation highlights
  const { positions: annotationPositions } = useAnnotationHighlights({
    annotations: conversationAnnotations,
    getMessageElement,
    scrollContainerRef: annotationScrollContainerRef,
    enabled: hasConversationAnnotations,
  });

  // ─── Effects ────────────────────────────────────────────────────────────
  // Keep scroll container ref in sync with ConversationPane
  useEffect(() => {
    annotationScrollContainerRef.current = agentSessionLogRef.current?.getScrollElement() ?? null;
  });

  // UI-reset-on-session-change: pending annotations are session-scoped in the
  // store, so only reset transient popover/selection/editing state here.
  useEffect(() => {
    setAnnotationSelection(null);
    setIsAnnotationPopoverOpen(false);
    setEditingAnnotation(null);
  }, [currentSessionId]);

  // Report annotation active state back to App.tsx (for hotkey guard + auto-scroll pause).
  //
  // useLayoutEffect (NOT useEffect) is load-bearing: TextSelectionMenu emits its
  // own open/close via useLayoutEffect, and the "Add Comment" click closes the
  // selection menu and opens the annotation popover in the same React batch.
  // If this ran in useEffect, the parent's pause-source state would briefly
  // collapse to (menu=false, annotation=false) between the two commits, causing
  // pauseAutoScroll to flicker false→true and (in concert with the catch-up
  // effect on isSelectionMenuOpen falling-edge) trigger an unwanted scroll-to-
  // bottom mid-transition. Aligning timings here keeps both pause-source state
  // updates in the same commit. See:
  // docs-private/investigations/260509_annotation_save_jumps_to_bottom.md.
  useLayoutEffect(() => {
    onAnnotationActiveChange(isAnnotationPopoverOpen || editingAnnotation !== null);
  }, [isAnnotationPopoverOpen, editingAnnotation, onAnnotationActiveChange]);

  // Report annotation count changes so the composer can adjust its Send button
  useEffect(() => {
    onAnnotationCountChange(conversationAnnotationCount);
  }, [conversationAnnotationCount, onAnnotationCountChange]);

  // ─── Callbacks ──────────────────────────────────────────────────────────
  // Handle submitting a new annotation on selected text
  const handleSubmitAnnotation = useCallback((comment: string) => {
    if (!annotationSelection) return;
    addConversationAnnotation(
      annotationSelection.messageId,
      annotationSelection.text,
      comment,
      annotationSelection.startOffset,
      annotationSelection.endOffset
    );
    setAnnotationSelection(null);
    setIsAnnotationPopoverOpen(false);
    window.getSelection()?.removeAllRanges();
  }, [annotationSelection, addConversationAnnotation]);

  // Close the annotation popover
  const closeAnnotationPopover = useCallback(() => {
    setAnnotationSelection(null);
    setIsAnnotationPopoverOpen(false);
    window.getSelection()?.removeAllRanges();
  }, []);

  // Handle "Add Comment" action from TextSelectionMenuLayer
  const handleSelectionMenuComment = useCallback((selection: SelectionData) => {
    // Store selection and open comment popover
    setAnnotationSelection({
      text: selection.text,
      messageId: selection.messageId,
      rect: selection.rect,
      startOffset: selection.startOffset,
      endOffset: selection.endOffset,
    });
    setIsAnnotationPopoverOpen(true);
  }, []);

  // Handle updating an existing annotation
  const handleUpdateAnnotation = useCallback((id: string, comment: string) => {
    updateConversationAnnotation(id, comment);
    setEditingAnnotation(null);
  }, [updateConversationAnnotation]);

  // Handle deleting an annotation being edited
  const handleDeleteAnnotation = useCallback((id: string) => {
    removeConversationAnnotation(id);
    setEditingAnnotation(null);
  }, [removeConversationAnnotation]);

  // Handle sending all conversation annotations as a follow-up message (immediate send)
  // Combines formatted annotations with any text the user typed in the composer
  // Also resolves @mentions in the composer text and includes all attachments
  const handleSendConversationAnnotations = useCallback(async () => {
    if (!hasConversationAnnotations) return;

    // Fail-loud around the formatter: `AnnotationFormatExhaustionError`
    // means every fence-nonce retry collided (astronomically unlikely
    // at 128 bits of entropy). We refuse to ship a poisoned prompt or
    // silently drop the user's annotations — emit a structured log so
    // the failure leaves a session breadcrumb, show a toast, and abort
    // the send. See FIX 2 in the planning doc.
    let annotationsMessage: string;
    try {
      annotationsMessage = formatConversationAnnotationsMessage();
    } catch (err) {
      if (err instanceof AnnotationFormatExhaustionError) {
        // FIX E (final heavy review): isolate `emitLog` from the
        // user-facing toast. The log bridge is normally never-throws
        // by contract but we never want a logging glitch to swallow
        // the abort toast — if logging fails we fall back to a bare
        // console.error so the failure still leaves a breadcrumb.
        try {
          emitLog?.({
            level: 'error',
            message: 'Conversation annotation format exhausted fence retries',
            context: {
              sessionId: currentSessionId,
              annotationCount: conversationAnnotationCount,
              reason: 'fence-collision-exhausted',
            },
            timestamp: Date.now(),
          });
        } catch (logErr) {
          console.error(
            '[AnnotationOrchestrator] emitLog threw during exhaustion handler',
            logErr,
          );
        }
        showToast({ title: "Couldn't format comments — try simplifying the text" });
        return;
      }
      throw err;
    }
    if (!annotationsMessage) return;

    // Get any contextualizing message and attachments from the composer
    const composerText = composerRef.current?.getText()?.trim() ?? '';
    const fileAttachments = composerRef.current?.getAttachments() ?? [];

    // Combine: user's context message first (if any), then the annotations
    const outgoingMessage = composerText
      ? `${composerText}\n\n${annotationsMessage}`
      : annotationsMessage;
    const annotationsDisplayMessage = formatConversationDisplayMessage();
    const outgoingDisplayMessage = composerText
      ? `${composerText}\n\n${annotationsDisplayMessage}`
      : annotationsDisplayMessage;

    // Resolve mentions/references on the outgoing prompt so any preserved user context
    // stays in sync with the attachments.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- attachment payload union varies
    let allAttachments: any[] = [...fileAttachments];
    if (composerText) {
      try {
        const [mentionAttachments, conversationAttachments] = await Promise.all([
          prepareMentionAttachments(outgoingMessage),
          prepareConversationAttachments(outgoingMessage),
        ]);
        allAttachments = [...mentionAttachments, ...conversationAttachments, ...fileAttachments];
      } catch {
        // If mention resolution fails, still send with file attachments only.
      }
    }

    const sendAnnotationsPromise = (async () => {
      await handleUserMessage(
        outgoingMessage,
        'text',
        allAttachments.length > 0 ? allAttachments : undefined,
        {
          displayText: outgoingDisplayMessage,
          onCommit: clearConversationAnnotations,
        },
      );
    })().catch((err: unknown) => {
      // Immediate/pre-commit send failures reject from `submitQueuedMessage`.
      // Keep annotations intact (onCommit never fired), but make the failure
      // observable with the same structured-log + toast pattern as formatter
      // exhaustion above.
      try {
        emitLog?.({
          level: 'error',
          message: 'Conversation annotation send failed before commit',
          context: {
            sessionId: currentSessionId,
            annotationCount: conversationAnnotationCount,
            error: err instanceof Error ? err.message : String(err),
          },
          timestamp: Date.now(),
        });
      } catch (logErr) {
        console.error(
          '[AnnotationOrchestrator] emitLog threw during send failure handler',
          logErr,
        );
      }
      showToast({ title: "Couldn't send comments — they're still here" });
    });
    fireAndForget(sendAnnotationsPromise, 'annotationSend');
    clearComposerAfterSend();
    setAnnotationSelection(null);
    setIsAnnotationPopoverOpen(false);
    setEditingAnnotation(null);
  }, [clearComposerAfterSend, clearConversationAnnotations, composerRef, conversationAnnotationCount, currentSessionId, emitLog, formatConversationAnnotationsMessage, formatConversationDisplayMessage, handleUserMessage, hasConversationAnnotations, prepareConversationAttachments, prepareMentionAttachments, showToast]);

  // Expose the send function via ref so the composer's Send button can trigger it
  useEffect(() => {
    sendAnnotationsRef.current = hasConversationAnnotations ? handleSendConversationAnnotations : null;
    return () => { sendAnnotationsRef.current = null; };
  }, [sendAnnotationsRef, hasConversationAnnotations, handleSendConversationAnnotations]);

  // Handle clearing all annotations
  const handleClearAnnotations = useCallback(() => {
    clearConversationAnnotations();
    setAnnotationSelection(null);
    setIsAnnotationPopoverOpen(false);
    setEditingAnnotation(null);
  }, [clearConversationAnnotations]);

  // Handle clicking an annotation icon to edit it
  const handleClickAnnotationIcon = useCallback((annotationId: string, rect: DOMRect) => {
    const annotation = conversationAnnotations.find((a) => a.id === annotationId);
    if (annotation) {
      setAnnotationSelection(null); // Close any new annotation popover
      setEditingAnnotation({
        id: annotation.id,
        text: annotation.text,
        comment: annotation.comment,
        rect,
      });
    }
  }, [conversationAnnotations]);

  // ─── Render ─────────────────────────────────────────────────────────────
  return (
    <>
      {/* Annotation bar - shown above composer when user has pending annotations on AI replies */}
      {hasConversationAnnotations && (
        <AnnotationBar
          count={conversationAnnotationCount}
          onClear={handleClearAnnotations}
          disabled={isBusy}
        />
      )}
      {/* Text selection menu layer - self-contained, manages own state to avoid selection collapse */}
      <TextSelectionMenuLayer
        onReply={onReply}
        onReplyInNewChat={onReplyInNewChat}
        onComment={handleSelectionMenuComment}
        onGenericAddComment={onGenericAddComment}
        showToast={showToast}
        onMenuOpenChange={onMenuOpenChange}
      />
      {/* Annotation popover - for adding new annotations on selected text */}
      {/* Only shows when user clicks "Add Comment" from TextSelectionMenuLayer */}
      <AnnotationPopover
        isOpen={isAnnotationPopoverOpen && annotationSelection !== null && editingAnnotation === null}
        coords={annotationSelection?.rect ?? null}
        selectedText={annotationSelection?.text ?? ''}
        onSubmit={handleSubmitAnnotation}
        onClose={closeAnnotationPopover}
        placeholder="What's your feedback on this?"
        autoFocus
      />
      {/* Annotation popover - for editing existing annotations */}
      <AnnotationPopover
        isOpen={editingAnnotation !== null}
        coords={editingAnnotation?.rect ?? null}
        selectedText={editingAnnotation?.text ?? ''}
        onSubmit={() => {}}
        onClose={() => setEditingAnnotation(null)}
        editingId={editingAnnotation?.id}
        editingComment={editingAnnotation?.comment}
        onUpdate={handleUpdateAnnotation}
        onDelete={handleDeleteAnnotation}
        autoFocus
      />
      {/* Annotation icons - clickable indicators at the end of each highlight */}
      <AnnotationIcons
        positions={annotationPositions}
        scrollContainer={annotationScrollContainerRef.current}
        onClickAnnotation={handleClickAnnotationIcon}
      />
    </>
  );
});
