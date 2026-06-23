/**
 * MentionHeroInput — A lightweight hero input with @mention autocomplete.
 *
 * Reusable across surfaces (Homepage, Automations, etc.) that need a
 * single-line-style prompt input with mention support, without the full
 * agent session machinery of ComposerWithState.
 *
 * Uses useMentionAutocomplete + MentionPopover (same system as the
 * main composer) but without the session/draft machinery.
 * Supports optional file attachments via the attachmentProps prop.
 */

import {
  useCallback,
  useEffect,
  useRef,
  useMemo,
  type KeyboardEvent,
  type ChangeEvent,
  type ClipboardEvent,
} from 'react';
import { ArrowRight, Loader2, Mic, Paperclip, Square } from 'lucide-react';
import { IconButton } from '@renderer/components/ui';
import {
  useMentionAutocomplete,
  findMentionTrigger,
  isCaretOnMentionChip,
} from '../hooks/useMentionAutocomplete';
import { MentionPopover } from './MentionPopover';
import { useAutoResizeTextarea } from '../hooks/useAutoResizeTextarea';
import { TipTapPromptEditor, type TipTapPromptEditorHandle } from './TipTapPromptEditor';
import { isComposerFlagEnabled } from '../featureFlags';
import { AttachmentThumbnailStrip } from '../components/AttachmentThumbnailStrip';
import type { VoiceMicButtonProps } from '@renderer/features/inbox/components/VoiceMicButton';
import type { FileAttachment } from '../hooks/useFileAttachments';
import type { UnifiedMentionResult, MentionFilterType } from '@renderer/features/mentions';
import type { FlatFileEntry } from '@renderer/utils/librarySearch';
import { getClipboardAttachmentPasteMode } from '../utils/clipboardPaste';
import { mentionResultToAttrs } from '../utils/mentionResultToAttrs';
import {
  createMentionContextScheduler,
  type MentionContextScheduler,
} from '../utils/mentionContextScheduler';
import styles from './MentionHeroInput.module.css';

/** Optional attachment support — presence of this prop enables file attachments */
export interface MentionHeroAttachmentProps {
  attachments: FileAttachment[];
  onAddFiles: (files: FileList) => Promise<void>;
  onRemoveAttachment: (id: string) => void;
  onPasteAttachment: (clipboardData: DataTransfer) => Promise<boolean>;
  canAddMore: boolean;
  isDragging: boolean;
  onDragEnter: (e: React.DragEvent) => void;
  onDragLeave: (e: React.DragEvent) => void;
  onDragOver: (e: React.DragEvent) => void;
  onDrop: (e: React.DragEvent) => void;
}

export interface MentionHeroInputProps {
  /** Current text value (controlled) */
  value: string;
  /** Called on every text change */
  onChange: (value: string) => void;
  /** Called when user submits (Enter or button click) */
  onSubmit: () => void;
  /** Input placeholder text */
  placeholder?: string;
  /** Accessible label for the textarea */
  ariaLabel?: string;
  /** data-testid for the textarea */
  testId?: string;
  /** data-testid for the submit button */
  submitTestId?: string;
  /** Submit button aria-label */
  submitAriaLabel?: string;
  /** Whether the submit button is disabled */
  submitDisabled?: boolean;

  /** Optional file attachment support (presence = enabled) */
  attachmentProps?: MentionHeroAttachmentProps;
  /** Optional voice affordance rendered as a leading icon button */
  voiceButtonProps?: VoiceMicButtonProps;

  // --- Mention system props ---
  /** Unified mention search function (files + conversations + commands) */
  mentionResultsForQuery: (query: string, filter?: MentionFilterType) => UnifiedMentionResult[];
  /** Trigger library index loading if needed */
  ensureLibraryIndex: () => void;
  /** Convert absolute path to library-relative path */
  getRelativeLibraryPath: (absolutePath: string) => string;
  /** Whether a workspace/library is configured */
  hasWorkspace: boolean;
  /** Whether conversation history is available for mentions */
  hasConversations: boolean;

  // --- Library state (for MentionPopover) ---
  coreDirectory: string | null | undefined;
  libraryIndex: FlatFileEntry[] | null;
  libraryIndexLoading: boolean;
  libraryIndexError: string | null;
  refreshLibraryIndex: () => Promise<void>;
}

export function MentionHeroInput({
  value,
  onChange,
  onSubmit,
  placeholder = 'Tell me what you need...',
  ariaLabel = 'Message input',
  testId,
  submitTestId,
  submitAriaLabel = 'Send message',
  submitDisabled,
  attachmentProps,
  voiceButtonProps,
  mentionResultsForQuery,
  ensureLibraryIndex,
  getRelativeLibraryPath,
  hasWorkspace,
  hasConversations,
  coreDirectory,
  libraryIndex,
  libraryIndexLoading,
  libraryIndexError,
  refreshLibraryIndex,
}: MentionHeroInputProps) {
  const isRichInputEnabled = isComposerFlagEnabled('tiptap');
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const tiptapEditorRef = useRef<TipTapPromptEditorHandle | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const mentionCaretRef = useRef<number | null>(null);
  const suppressMentionRefreshRef = useRef(false);
  /**
   * Stage 5 of `docs/plans/260501_composer_tiptap_atmention_bugfix.md` —
   * H8 ownership fix at the hero surface (parity with `ComposerWithState`).
   *
   * The single shared scheduler covers BOTH render paths:
   *   - legacy `<textarea>` path: `handleChange` → `scheduler.schedule(...)`.
   *   - rich `TipTapPromptEditor` path: `onChange` / `onTransaction` →
   *     `scheduler.schedule(...)` and `compositionend` → `flushDeferred()`.
   *
   * For the legacy textarea, `getEditor()` returns null so the scheduler's
   * IME guard and caret-on-chip checks are skipped automatically (the
   * factory's behaviour matrix); the first-`@` fast-path and debounce
   * still apply. For the rich path, the scheduler reads
   * `editor.view.composing` for IME state and `isCaretOnMentionChip` for
   * the FMM Row 27 suppression.
   */
  const schedulerRef = useRef<MentionContextScheduler | null>(null);
  const pickerOpenRef = useRef(false);
  const updateMentionContextRef = useRef<(value: string, caret: number | null) => void>(
    () => {},
  );

  // Use a ref to avoid stale closures in the setTextPrompt updater
  const valueRef = useRef(value);
  valueRef.current = value;

  // Auto-grow the legacy <textarea> path so the hero input expands with its
  // content (parity with the in-conversation composer). The rich-editor path
  // self-sizes via its own CSS bounds, so the hook is disabled there — on that
  // path `textareaRef` holds a textarea-shaped shim proxying to the editor DOM.
  useAutoResizeTextarea(textareaRef, value, !isRichInputEnabled);

  // Adapter: useMentionAutocomplete expects a (prev => next) updater function.
  // We bridge it to the controlled onChange prop.
  const setTextPrompt = useCallback(
    (updater: (prev: string) => string) => {
      const next = updater(valueRef.current);
      onChange(next);
    },
    [onChange],
  );

  const hasModels = useMemo(
    () => mentionResultsForQuery('', 'models').length > 0,
    [mentionResultsForQuery],
  );
  const {
    mentionState,
    updateMentionContext,
    insertMentionResult,
    navigateMentionUp,
    navigateMentionDown,
    selectCurrentMention,
    clearMentionState,
    setSelectedIndex,
    setManualFilter,
  } = useMentionAutocomplete({
    isTextMode: true,
    hasWorkspace,
    setTextPrompt,
    commandInputRef: textareaRef,
    mentionCaretRef,
    mentionResultsForQuery,
    ensureLibraryIndex,
    getRelativeLibraryPath,
    hasConversations,
    hasModels,
    insertMention: isRichInputEnabled
      ? (result, range) => {
          const editor = tiptapEditorRef.current;
          if (!editor) return false;
          const attrs = mentionResultToAttrs(result, getRelativeLibraryPath);
          suppressMentionRefreshRef.current = true;
          editor.insertMentionAtMarkdownRange(
            { from: range.startIndex, to: range.endIndex },
            attrs,
          );
          clearMentionState();
          requestAnimationFrame(() => {
            suppressMentionRefreshRef.current = false;
          });
          return true;
        }
      : undefined,
  });

  // Stage 5: shared parent-layer scheduler (mirrors ComposerWithState's H8 fix).
  // Refresh the live captures every render so the scheduler always sees the
  // latest hook bindings without needing to be reconstructed.
  updateMentionContextRef.current = updateMentionContext;
  pickerOpenRef.current = mentionState.active;
  if (!schedulerRef.current) {
    schedulerRef.current = createMentionContextScheduler({
      onFire: (value, caret) => updateMentionContextRef.current(value, caret),
      isPickerOpen: () => pickerOpenRef.current,
      getEditor: () => tiptapEditorRef.current?.getEditor() ?? null,
      // Production: defaults to `editor.view.composing`; legacy textarea
      // path skips the IME check (getEditor returns null).
      isCaretOnChip: (editor) => isCaretOnMentionChip(editor),
      detectFreshTrigger: (value, caret) => findMentionTrigger(value, caret) !== null,
    });
  }

  // Cancel any pending scheduled fire on unmount so a stale setTimeout
  // callback can't update React state on an unmounted component.
  useEffect(() => {
    return () => {
      schedulerRef.current?.cancel();
    };
  }, []);

  // --- Event handlers ---

  const handleChange = useCallback(
    (e: ChangeEvent<HTMLTextAreaElement>) => {
      const { value: newValue, selectionStart } = e.target;
      onChange(newValue);

      // Skip mention processing when no @ present (perf): cancel any pending
      // schedule and close the picker synchronously.
      if (!newValue.includes('@')) {
        schedulerRef.current?.cancel();
        clearMentionState();
        return;
      }

      // Stage 5: shared parent-layer scheduler (IME-aware debounce + first-`@`
      // fast-path; for the legacy textarea path the IME / caret-on-chip
      // guards are no-ops because there's no editor, so the scheduler
      // behaves like a 250ms debounce with first-`@` fast-path).
      schedulerRef.current?.schedule(newValue, selectionStart ?? newValue.length);
    },
    [onChange, clearMentionState],
  );

  /**
   * Stage 5: invoked by `TipTapPromptEditor`'s `compositionend` listener.
   * Flushes the scheduler's IME-deferred state so the picker opens shortly
   * after composition commits, even when no subsequent `onUpdate` fires
   * (the compose-and-pause sequence).
   */
  const flushDeferredMentionContext = useCallback(() => {
    schedulerRef.current?.flushDeferred();
  }, []);

  const handleKeyDown = useCallback(
    (e: KeyboardEvent<HTMLTextAreaElement>) => {
      // Mention navigation takes priority
      if (mentionState.active) {
        if (mentionState.results.length > 0) {
          if (e.key === 'ArrowDown') {
            e.preventDefault();
            navigateMentionDown();
            return;
          }
          if (e.key === 'ArrowUp') {
            e.preventDefault();
            navigateMentionUp();
            return;
          }
          if (e.key === 'Enter' || e.key === 'Tab') {
            e.preventDefault();
            selectCurrentMention();
            return;
          }
        }
        if (e.key === 'Escape') {
          e.preventDefault();
          clearMentionState();
          return;
        }
      }

      // Submit on Enter (without Shift)
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        onSubmit();
      }
    },
    [mentionState, navigateMentionDown, navigateMentionUp, selectCurrentMention, clearMentionState, onSubmit],
  );

  // Wrap setManualFilter to cancel pending debounced updateMentionContext calls
  // and pass fresh query from textarea (prevents race conditions). Stage 5
  // routes through the shared scheduler so the cancel covers both paths.
  const handleFilterChange = useCallback(
    (filter: MentionFilterType) => {
      schedulerRef.current?.cancel();
      const currentValue = valueRef.current;
      const caret = textareaRef.current?.selectionStart ?? currentValue.length;
      findMentionTrigger(currentValue, caret);
      setManualFilter(filter);
    },
    [setManualFilter],
  );

  // --- Attachment handlers ---

  const handlePaste = useCallback(
    (e: ClipboardEvent<HTMLTextAreaElement>) => {
      if (!attachmentProps) return;
      const { clipboardData } = e;
      if (!clipboardData) return;
      const pasteMode = getClipboardAttachmentPasteMode(clipboardData);
      if (pasteMode === 'attachment-only') {
        e.preventDefault();
        void attachmentProps.onPasteAttachment(clipboardData);
        return;
      }
      if (pasteMode === 'mixed') {
        void attachmentProps.onPasteAttachment(clipboardData);
      }
    },
    [attachmentProps],
  );

  const handlePaperclipClick = useCallback(() => {
    fileInputRef.current?.click();
  }, []);

  const handleFileInputChange = useCallback(
    (e: ChangeEvent<HTMLInputElement>) => {
      const { files } = e.target;
      if (files && files.length > 0 && attachmentProps) {
        void attachmentProps.onAddFiles(files);
      }
      // Reset so re-selecting the same file triggers onChange
      e.target.value = '';
    },
    [attachmentProps],
  );

  const showModelsTab = hasModels;

  // --- Mention popover ---

  const mentionPopover = useMemo(() => {
    if (!mentionState.active) return null;
    return (
      <MentionPopover
        isTextMode={true}
        mentionState={mentionState}
        coreDirectory={coreDirectory}
        libraryIndex={libraryIndex}
        libraryIndexLoading={libraryIndexLoading}
        libraryIndexError={libraryIndexError}
        getRelativeLibraryPath={getRelativeLibraryPath}
        refreshLibraryIndex={refreshLibraryIndex}
        insertMentionResult={insertMentionResult}
        setSelectedIndex={setSelectedIndex}
        hasConversations={hasConversations}
        showModelsTab={showModelsTab}
        onFilterChange={handleFilterChange}
      />
    );
  }, [
    mentionState,
    coreDirectory,
    libraryIndex,
    libraryIndexLoading,
    libraryIndexError,
    getRelativeLibraryPath,
    refreshLibraryIndex,
    insertMentionResult,
    setSelectedIndex,
    hasConversations,
    showModelsTab,
    handleFilterChange,
  ]);

  const isSubmitDisabled = submitDisabled ?? (!value.trim() && (!attachmentProps || attachmentProps.attachments.length === 0));

  const hasAttachments = attachmentProps && attachmentProps.attachments.length > 0;

  return (
    <div
      className={`${styles.heroInputContainer}${attachmentProps?.isDragging ? ` ${styles.heroInputContainerDragging}` : ''}`}
      onDragEnter={attachmentProps?.onDragEnter}
      onDragLeave={attachmentProps?.onDragLeave}
      onDragOver={attachmentProps?.onDragOver}
      onDrop={attachmentProps?.onDrop}
    >
      {/* Attachment thumbnails above the input row */}
      {hasAttachments && (
        <div className={styles.attachmentStripArea}>
          <AttachmentThumbnailStrip
            attachments={attachmentProps.attachments}
            onRemove={attachmentProps.onRemoveAttachment}
          />
        </div>
      )}

      <div className={styles.inputRow}>
        {voiceButtonProps && (
          <IconButton
            size="lg"
            variant="ghost"
            className={styles.leadingIconButton}
            active={voiceButtonProps.isRecording}
            onClick={voiceButtonProps.onToggle}
            disabled={voiceButtonProps.disabled}
            aria-label={voiceButtonProps.isRecording ? 'Stop recording' : 'Start voice input'}
            aria-pressed={voiceButtonProps.isRecording}
            data-testid="hero-voice-button"
          >
            {voiceButtonProps.isProcessing ? (
              <Loader2 size={16} className={styles.spinningIcon} />
            ) : voiceButtonProps.isRecording ? (
              <Square size={16} />
            ) : (
              <Mic size={18} />
            )}
          </IconButton>
        )}

        {isRichInputEnabled ? (
          <TipTapPromptEditor
            ref={tiptapEditorRef}
            commandInputRef={textareaRef}
            value={value}
            onChange={(nextValue, caretIndex) => {
              onChange(nextValue);
              if (suppressMentionRefreshRef.current) {
                return;
              }
              // Stage 5: route through the shared parent-layer scheduler
              // so the rich path inherits the IME guard, first-`@` fast-
              // path, and caret-on-chip suppression. When `@` is removed
              // entirely, cancel + clear synchronously so the picker
              // closes without waiting for debounce.
              if (nextValue.includes('@')) {
                schedulerRef.current?.schedule(nextValue, caretIndex);
              } else {
                schedulerRef.current?.cancel();
                clearMentionState();
              }
            }}
            placeholder={placeholder}
            ariaLabel={ariaLabel}
            testId={testId}
            className={styles.heroEditor}
            onKeyDown={(event) => handleKeyDown(event as unknown as KeyboardEvent<HTMLTextAreaElement>)}
            onTransaction={(nextValue, caretIndex) => {
              if (suppressMentionRefreshRef.current) {
                return;
              }
              // Selection-only and text-changing transactions share the
              // same scheduler instance, so duplicate work per
              // transaction is eliminated (cancel-and-reschedule).
              schedulerRef.current?.schedule(nextValue, caretIndex);
            }}
            onCompositionEnd={flushDeferredMentionContext}
            onPasteCapture={(event) => {
              if (!attachmentProps || !event.clipboardData) return false;
              const pasteMode = getClipboardAttachmentPasteMode(event.clipboardData);
              if (pasteMode === 'attachment-only') {
                void attachmentProps.onPasteAttachment(event.clipboardData);
                return true;
              }
              if (pasteMode === 'mixed') {
                void attachmentProps.onPasteAttachment(event.clipboardData);
              }
              return false;
            }}
          />
        ) : (
          <textarea
            ref={textareaRef}
            className={styles.heroInput}
            placeholder={placeholder}
            value={value}
            onChange={handleChange}
            onKeyDown={handleKeyDown}
            onPaste={attachmentProps ? handlePaste : undefined}
            aria-label={ariaLabel}
            data-testid={testId}
            rows={1}
          />
        )}
        {/* Paperclip button stays near submit on surfaces that support attachments */}
        {attachmentProps && (
          <IconButton
            size="lg"
            variant="ghost"
            className={styles.trailingIconButton}
            onClick={handlePaperclipClick}
            disabled={!attachmentProps.canAddMore}
            aria-label="Attach file"
          >
            <Paperclip size={18} />
          </IconButton>
        )}
        <button
          type="button"
          className={styles.heroInputSubmit}
          onClick={onSubmit}
          disabled={isSubmitDisabled}
          aria-label={submitAriaLabel}
          data-testid={submitTestId}
        >
          <ArrowRight size={20} />
        </button>

        {/* Hidden file input for file picker */}
        {attachmentProps && (
          <input
            ref={fileInputRef}
            type="file"
            accept="*/*"
            multiple
            className={styles.hiddenFileInput}
            onChange={handleFileInputChange}
            aria-hidden="true"
            tabIndex={-1}
          />
        )}
      </div>

      {/* Drop zone overlay */}
      {attachmentProps?.isDragging && (
        <div className={styles.dropZone}>
          <Paperclip size={24} />
          <span>Drop files here</span>
        </div>
      )}

      {/* Popover positioned below the input (not above, to avoid viewport clipping) */}
      {mentionPopover && (
        <div className={styles.mentionPopoverBelow}>{mentionPopover}</div>
      )}
    </div>
  );
}
