import { useCallback, useState, useMemo, memo } from 'react';
import { Check, Database, MessageSquare, Send, X } from 'lucide-react';
import { Button, Tooltip } from '@renderer/components/ui';
import { formatTokenCount } from '@shared/utils/usageFormatters';
import { SendToRebelDialog, type SendTarget } from '@renderer/features/library/components/SendToRebelDialog';
import { AnnotationFormatExhaustionError } from '@rebel/shared';
import { classifySafeError } from '@shared/utils/documentIoErrorClassification';
import { EditorUnmountedError } from '@renderer/features/library/extensions/tiptapAnnotationExtension';
import type { EmitLogFn, EmitLogPayload } from '@renderer/contexts';
import styles from './UnifiedDocumentEditor.module.css';

const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad|iPod/.test(navigator.platform);

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface AnnotationItem {
  id: string;
  from: number;
  to: number;
  text: string;
  comment: string;
}

interface DocumentFooterProps {
  content: string | null;
  documentPath: string | null;
  fileName: string;
  isMarkdownFile: boolean;
  isEditing: boolean;
  statusText: string;
  justSaved: boolean;

  // Annotation state (from editorResult.annotations)
  hasAnnotations: boolean;
  annotationList: AnnotationItem[];
  onRemoveAnnotation: (id: string) => void;
  /**
   * Polymorphic clear:
   * - No args / undefined / empty array → clear ALL annotations (Clear-All button behaviour).
   * - Non-empty array of ids → clear ONLY those ids (used by the per-message `onCommit`
   *   closure on "Send to Rebel" to clear the snapshot of staged annotations only).
   *
   * Throws `EditorUnmountedError` synchronously when called on a dead editor — the
   * onCommit closure below catches and surfaces warn + toast per policy.
   */
  onClearAnnotations: (ids?: string[]) => void;
  formatAnnotationMessage: (documentPath: string) => string;
  formatAnnotationDisplayMessage?: (documentPath: string) => string;
  /**
   * Optional flush-on-clear hook. When the staged annotations are cleared
   * inside the per-message `onCommit` closure, this flushes the post-clear
   * file content to disk synchronously so the 500ms debounced writer
   * can't land AFTER the clear and resurrect the annotations. Rejects
   * on write failure — the onCommit closure catches and surfaces toast.
   */
  flushAnnotationWriteNow?: () => Promise<void>;

  // Editor ref for scrolling to annotations
  editorRef: React.RefObject<{
    focus: () => void;
    scrollToAnnotation: (from: number, to: number) => void;
  } | null>;

  // Send to rebel
  /**
   * Dialog-routed send path. The third argument carries the per-message
   * `onCommit` closure attached to the resulting `QueuedMessage` — fires
   * when the message actually dispatches to the runtime, not at Send
   * click. The closure may be sync or async: the queue supports async
   * `onCommit` callbacks with rejection isolation (sync throws and
   * rejected promises are both caught and logged). The queue does NOT
   * await the callback — it is fire-and-forget. Sequential composition
   * of multiple stashed callbacks happens in App.tsx before hand-off.
   * See docs/plans/260417_centralize_annotations_and_fix_document_send_clear.md.
   */
  onSendAnnotations?: (
    message: string,
    options?: { target: SendTarget; sessionId?: string; displayMessage?: string },
    onCommit?: () => void | Promise<void>,
  ) => void;
  currentSessionId?: string | null;
  currentSessionTitle?: string | null;

  showToast?: (options: { title: string }) => void;
  /**
   * Structured log sink. Used by the `onCommit` closure to emit warn/error
   * when clearing staged annotations on dispatch fails (dead editor, file
   * write failure). Required for observability — without it, we fall back
   * to `console.error` so the failure is never silent.
   */
  emitLog?: EmitLogFn;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

const DocumentFooterComponent = ({
  content,
  documentPath,
  fileName,
  isMarkdownFile,
  isEditing,
  statusText,
  justSaved,
  hasAnnotations,
  annotationList,
  onRemoveAnnotation,
  onClearAnnotations,
  formatAnnotationMessage,
  formatAnnotationDisplayMessage,
  flushAnnotationWriteNow,
  editorRef,
  onSendAnnotations,
  currentSessionId,
  currentSessionTitle,
  showToast,
  emitLog,
}: DocumentFooterProps) => {
  const [showAnnotationList, setShowAnnotationList] = useState(false);
  const [sendDialogOpen, setSendDialogOpen] = useState(false);

  // Defensive emitLog wrapper. `emitLog` is contracted to never throw,
  // but we mirror AnnotationOrchestrator's FIX E isolation so a
  // logging glitch (e.g. a corrupted breadcrumb buffer) can't swallow
  // the user-facing toast or abort a downstream disk flush in the
  // onCommit closure. Returns `true` when emitLog was attempted (so
  // callers skip their rich console fallback — we've already logged
  // the payload via the catch-path breadcrumb), `false` when emitLog
  // is undefined (caller's fallback runs as before).
  const safeEmitLog = useCallback(
    (entry: EmitLogPayload): boolean => {
      if (!emitLog) return false;
      try {
        emitLog(entry);
      } catch (logErr) {
        console.error('[DocumentFooter] emitLog threw during log emission', {
          errorClassifier: classifySafeError(logErr),
          attemptedLevel: entry.level,
          attemptedMessage: entry.message,
        });
      }
      return true;
    },
    [emitLog],
  );

  const estimatedTokens = useMemo(() => {
    if (!content) return 0;
    return Math.ceil(content.length / 4);
  }, [content]);

  const handleOpenSendDialog = useCallback(() => {
    if (!hasAnnotations || !documentPath || !onSendAnnotations) return;
    setSendDialogOpen(true);
  }, [hasAnnotations, documentPath, onSendAnnotations]);

  // Build the `onCommit` closure for a given Send click. The closure
  // captures a SNAPSHOT of the staged annotation ids — annotations
  // added between Send click and actual dispatch are NOT in the
  // snapshot and will survive the clear. Fail-loud on editor unmount
  // or file-write failure per AGENTS.md "silent failure is a bug".
  //
  // Async so the composed-onCommit in App.tsx can await the disk flush
  // before moving on to the next callback. The queue itself does NOT
  // await — `invokeOnCommitSafely` is fire-and-forget with rejection
  // isolation (sync throws and rejected promises are both caught and
  // logged, never propagated to the caller).
  const buildOnCommit = useCallback(
    (stagedIds: string[]): (() => Promise<void>) => {
      return async () => {
        try {
          // 1. Clear the PM extension state for exactly the staged ids.
          onClearAnnotations(stagedIds);
        } catch (err) {
          const errorClassifier = classifySafeError(err);
          if (err instanceof EditorUnmountedError) {
            if (!safeEmitLog({
              level: 'warn',
              message: 'Failed to clear annotations on dispatch — editor unmounted',
              context: {
                annotationCount: stagedIds.length,
                reason: 'editor-unmounted',
                errorClassifier,
              },
              timestamp: Date.now(),
            })) {
              console.warn('[DocumentFooter] Failed to clear annotations — editor unmounted', {
                annotationCount: stagedIds.length,
                errorClassifier,
              });
            }
            showToast?.({ title: "Comments couldn't be cleared — reopen the file" });
            // Editor is dead; no point flushing. Annotations remain on
            // disk; user can clear manually on next open.
            return;
          }
          if (!safeEmitLog({
            level: 'error',
            message: 'Unexpected error clearing annotations on dispatch',
            context: {
              annotationCount: stagedIds.length,
              errorClassifier,
            },
            timestamp: Date.now(),
          })) {
            console.error('[DocumentFooter] Unexpected error clearing annotations on dispatch', {
              annotationCount: stagedIds.length,
              errorClassifier,
            });
          }
          showToast?.({ title: "Comments couldn't be cleared — please reload the file" });
          return;
        }

        // 2. Flush the post-clear file content to disk immediately so
        //    the 500ms debounced writer can't land AFTER the clear
        //    and resurrect the annotations on a subsequent reload.
        //    Awaited so the composed-onCommit in App.tsx sequences
        //    multiple callbacks without racing disk writes.
        if (flushAnnotationWriteNow) {
          try {
            await flushAnnotationWriteNow();
          } catch (err) {
            const errorClassifier = classifySafeError(err);
            if (!safeEmitLog({
              level: 'error',
              message: 'Failed to flush annotation write on dispatch',
              context: {
                annotationCount: stagedIds.length,
                errorClassifier,
              },
              timestamp: Date.now(),
            })) {
              console.error('[DocumentFooter] Failed to flush annotation write on dispatch', {
                annotationCount: stagedIds.length,
                errorClassifier,
              });
            }
            showToast?.({ title: "Couldn't save cleared comments to disk — please reload the file" });
          }
        }
      };
    },
    [onClearAnnotations, flushAnnotationWriteNow, safeEmitLog, showToast],
  );

  const handleSendWithRouting = useCallback((target: SendTarget, sessionId?: string, clearCommentsNow?: boolean) => {
    if (!documentPath || !onSendAnnotations) return;

    // Snapshot staged ids BEFORE calling the formatter — the formatter
    // could theoretically throw AnnotationFormatExhaustionError, in
    // which case we abort the send and leave the annotations intact.
    const stagedIds = annotationList.map((a) => a.id);

    let message: string;
    try {
      message = formatAnnotationMessage(documentPath);
    } catch (err) {
      const errorClassifier = classifySafeError(err);
      if (err instanceof AnnotationFormatExhaustionError) {
        if (!safeEmitLog({
          level: 'error',
          message: 'Annotation formatter exhausted fence retries; aborting send',
          context: {
            annotationCount: stagedIds.length,
            reason: 'fence-collision-exhausted',
            errorClassifier,
          },
          timestamp: Date.now(),
        })) {
          console.error('[DocumentFooter] Annotation formatter exhausted fence retries', {
            annotationCount: stagedIds.length,
            errorClassifier,
          });
        }
        showToast?.({ title: "Couldn't format comments — try simplifying the text" });
        return;
      }
      throw err;
    }

    if (!message) {
      return;
    }

    const displayMessage = formatAnnotationDisplayMessage?.(documentPath) ?? message;

    // When the user opted to clear comments immediately (checkbox in
    // dialog, checked by default), clear now rather than deferring to
    // the onCommit dispatch path. This gives immediate visual feedback
    // and avoids subtle failures in the deferred path (text snapshot
    // mismatch, session-switch timing). The deferred onCommit is still
    // attached as a belt-and-braces fallback — it becomes a no-op if
    // the comments were already cleared here.
    if (clearCommentsNow) {
      try {
        onClearAnnotations(stagedIds);
      } catch (err) {
        const errorClassifier = classifySafeError(err);
        if (err instanceof EditorUnmountedError) {
          safeEmitLog({
            level: 'warn',
            message: 'Immediate annotation clear failed — editor unmounted',
            context: {
              annotationCount: stagedIds.length,
              errorClassifier,
            },
            timestamp: Date.now(),
          });
          showToast?.({ title: "Comments couldn't be cleared — reopen the file" });
        } else {
          throw err;
        }
      }
    }

    onSendAnnotations(message, { target, sessionId, displayMessage }, buildOnCommit(stagedIds));
  }, [documentPath, onSendAnnotations, formatAnnotationMessage, formatAnnotationDisplayMessage, annotationList, safeEmitLog, showToast, buildOnCommit, onClearAnnotations]);

  const handleSendDirect = useCallback(() => {
    if (!documentPath) return;

    const stagedIds = annotationList.map((a) => a.id);

    let message: string;
    try {
      message = formatAnnotationMessage(documentPath);
    } catch (err) {
      const errorClassifier = classifySafeError(err);
      if (err instanceof AnnotationFormatExhaustionError) {
        if (!safeEmitLog({
          level: 'error',
          message: 'Annotation formatter exhausted fence retries; aborting send',
          context: {
            annotationCount: stagedIds.length,
            reason: 'fence-collision-exhausted',
            errorClassifier,
          },
          timestamp: Date.now(),
        })) {
          console.error('[DocumentFooter] Annotation formatter exhausted fence retries', {
            annotationCount: stagedIds.length,
            errorClassifier,
          });
        }
        showToast?.({ title: "Couldn't format comments — try simplifying the text" });
        return;
      }
      throw err;
    }

    if (!message) {
      return;
    }

    const displayMessage = formatAnnotationDisplayMessage?.(documentPath) ?? message;

    window.dispatchEvent(new CustomEvent('library:send-annotations', {
      detail: {
        message,
        displayMessage,
        documentPath,
        documentTitle: fileName,
        onCommit: buildOnCommit(stagedIds),
      },
    }));
    showToast?.({ title: 'Comments sent to Rebel' });
  }, [documentPath, fileName, formatAnnotationMessage, formatAnnotationDisplayMessage, showToast, annotationList, safeEmitLog, buildOnCommit]);

  // Clear All button — wraps `onClearAnnotations()` in try/catch so the
  // newly-throwing clear API doesn't crash the React tree on a dead
  // editor. Matches the onCommit closure's fail-loud policy: warn log
  // + toast + annotations remain on disk.
  const handleClickClearAll = useCallback(() => {
    try {
      onClearAnnotations();
    } catch (err) {
      const errorClassifier = classifySafeError(err);
      if (err instanceof EditorUnmountedError) {
        if (!safeEmitLog({
          level: 'warn',
          message: 'Clear All failed — editor unmounted',
          context: {
            reason: 'editor-unmounted',
            errorClassifier,
          },
          timestamp: Date.now(),
        })) {
          console.warn('[DocumentFooter] Clear All failed — editor unmounted', {
            errorClassifier,
          });
        }
        showToast?.({ title: "Couldn't clear comments — reopen the file" });
        return;
      }
      throw err;
    }
  }, [onClearAnnotations, safeEmitLog, showToast]);

  const scrollToAnnotation = useCallback((ann: AnnotationItem) => {
    if (editorRef.current) {
      editorRef.current.focus();
      editorRef.current.scrollToAnnotation(ann.from, ann.to);
    }
    setShowAnnotationList(false);
  }, [editorRef]);

  const showAnnotationControls = isMarkdownFile && (isEditing || hasAnnotations);

  return (
    <>
      <footer className={styles.footer}>
        <div className={styles.footerStatus}>
          <span className={styles.shortcutHint}><kbd>{isMac ? '⌘' : 'Ctrl+'}F</kbd> Find</span>
          <span className={styles.shortcutHint}>
            <kbd>{isMac ? '⌘' : 'Ctrl+'}S</kbd>
            {justSaved && <Check size={12} strokeWidth={2} className={styles.savedCheck} />}
            {statusText}
          </span>
          {estimatedTokens > 0 && (
            <Tooltip content="Approximate token count (estimated at ~4 characters per token)" delayShow={300}>
              <span className={styles.shortcutHint}>
                <Database size={12} />
                ~{formatTokenCount(estimatedTokens)} tokens
              </span>
            </Tooltip>
          )}
        </div>
        <div className={styles.footerActions}>
          {showAnnotationControls && (
            <div className={styles.annotationControls}>
              <button
                className={styles.annotationCountButton}
                onClick={() => hasAnnotations && setShowAnnotationList(!showAnnotationList)}
                title={hasAnnotations ? 'Click to view comments' : 'Select text to add a comment'}
                disabled={!hasAnnotations}
              >
                <MessageSquare size={14} />
                {hasAnnotations
                  ? `${annotationList.length} comment${annotationList.length !== 1 ? 's' : ''}`
                  : 'Select text to comment'}
              </button>
              {showAnnotationList && (
                <div className={styles.annotationList}>
                  <div className={styles.annotationListHeader}>
                    <span>Comments</span>
                    <button className={styles.annotationListClose} onClick={() => setShowAnnotationList(false)}>
                      <X size={14} />
                    </button>
                  </div>
                  <div className={styles.annotationListItems}>
                    {annotationList.map((ann) => (
                      <div
                        key={ann.id}
                        className={styles.annotationItem}
                        onClick={() => scrollToAnnotation(ann)}
                        role="button"
                        tabIndex={0}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter' || e.key === ' ') {
                            e.preventDefault();
                            scrollToAnnotation(ann);
                          }
                        }}
                      >
                        <div className={styles.annotationItemText}>
                          &ldquo;{ann.text.length > 50 ? ann.text.slice(0, 50) + '...' : ann.text}&rdquo;
                        </div>
                        <div className={styles.annotationItemComment}>{ann.comment}</div>
                        <button
                          className={styles.annotationItemDelete}
                          onClick={(e) => { e.stopPropagation(); onRemoveAnnotation(ann.id); }}
                          title="Remove comment"
                        >
                          <X size={12} />
                        </button>
                      </div>
                    ))}
                  </div>
                </div>
              )}
              {hasAnnotations && (
                <Tooltip content="Send all comments to Rebel">
                  <button
                    className={styles.sendAnnotationsButton}
                    onClick={onSendAnnotations ? handleOpenSendDialog : handleSendDirect}
                  >
                    <Send size={14} />
                    Send to Rebel
                  </button>
                </Tooltip>
              )}
              {hasAnnotations && (
                <Button
                  variant="ghost"
                  size="sm"
                  className={styles.clearAnnotationsButton}
                  onClick={handleClickClearAll}
                  title="Clear all comments"
                >
                  <X size={14} />
                </Button>
              )}
            </div>
          )}
        </div>
      </footer>

      {/* Send to Rebel dialog */}
      <SendToRebelDialog
        open={sendDialogOpen}
        onOpenChange={setSendDialogOpen}
        filePath={documentPath ?? ''}
        fileName={fileName}
        annotationCount={annotationList.length}
        lastActiveSessionId={currentSessionId}
        lastActiveSessionTitle={currentSessionTitle}
        onSend={handleSendWithRouting}
      />
    </>
  );
};

export const DocumentFooter = memo(DocumentFooterComponent);
