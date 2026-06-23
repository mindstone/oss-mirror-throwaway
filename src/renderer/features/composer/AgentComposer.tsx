import {
  memo,
  useCallback,
  useRef,
  useMemo,
  useState,
  useEffect,
  type ChangeEvent,
  type FormEvent,
  type KeyboardEvent,
  type ClipboardEvent,
  type DragEvent,
  type RefObject,
  type ReactNode,
  type SyntheticEvent
} from 'react';
import { Mic, Square, SendHorizontal, FileText, Folder, Sparkles, Paperclip, ListPlus, Network } from 'lucide-react';
import type { QueueMode } from '@renderer/features/agent-session/hooks/useMessageQueue';
import { cn } from '@renderer/lib/utils';
import { Button, IconButton, Spinner, Tooltip } from '@renderer/components/ui';
import { useAudioInputDevice } from '@renderer/features/voice/hooks/useAudioInputDevice';
import { resolveComposerSubmitMode } from './utils/resolveComposerSubmitMode';
import type { MentionedFileCandidate } from './types';
import { AttachmentThumbnailStrip } from './components/AttachmentThumbnailStrip';
import { ComposerContextChip } from './components/ComposerContextChip';
import { TipTapPromptEditor, type TipTapPromptEditorHandle } from './components/TipTapPromptEditor';
import { isComposerFlagEnabled } from './featureFlags';
import type { MarkdownToDocOptions } from './utils/promptDoc';
import type { FileAttachment } from './hooks/useFileAttachments';
import { isSkillPath } from '@renderer/utils/skillUtils';
import { getClipboardAttachmentPasteMode } from './utils/clipboardPaste';
import styles from './AgentComposer.module.css';

/**
 * Search mode configuration for @-keyword commands.
 * When user types "@skills " (with space), the composer enters "skills search mode".
 * Pre-computed class names avoid runtime string manipulation.
 */
const SEARCH_MODES = {
  skills: {
    trigger: '@skills ',
    label: '@skills',
    placeholder: 'Describe what you need help with...',
  },
  files: {
    trigger: '@files ',
    label: '@files',
    placeholder: 'Describe what you\'re looking for...',
  },
  conversations: {
    trigger: '@conversations ',
    label: '@conversations',
    placeholder: 'Describe what you discussed...',
  },
  chiefDesigner: {
    trigger: '@CHIEF_DESIGNER ',
    label: '@CHIEF_DESIGNER',
    placeholder: 'Describe the UI or UX decision you want Chief Designer to review...',
  },
  designSystemReviewer: {
    trigger: '@DESIGN_SYSTEM_REVIEWER ',
    label: '@DESIGN_SYSTEM_REVIEWER',
    placeholder: 'Describe the design intent or implementation you want translated into the right component, variant, and tokens...',
  },
  designContext: {
    trigger: '@designContext ',
    label: '@designContext',
    placeholder: 'Describe the product or UX decision you want grounded in personas, journeys, and research...',
  },
} as const;

type SearchModeConfig = typeof SEARCH_MODES[keyof typeof SEARCH_MODES];

type ComposerContextTokenKind = 'mode' | 'file' | 'directory' | 'conversation';

type ComposerContextToken = {
  id: string;
  label: string;
  kind: ComposerContextTokenKind;
  startIndex: number;
  endIndex: number;
};

const FILE_MENTION_AT_START_REGEX = /^@`([^`]+)`/;
const CONVERSATION_MENTION_AT_START_REGEX = /^@\[([^\]]+)\]\(rebel:\/\/conversation\/[^)]+\)/;

function getPathDisplayName(path: string): string {
  const normalized = path.replace(/[\\/]+$/, '');
  const parts = normalized.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? normalized;
}


function extractLeadingContextTokens(text: string, files: MentionedFileCandidate[]): {
  tokens: ComposerContextToken[];
  hiddenEndIndex: number;
  modeConfig: SearchModeConfig | null;
} {
  const tokens: ComposerContextToken[] = [];
  const leadingWhitespaceLength = text.length - text.trimStart().length;
  let cursor = leadingWhitespaceLength;
  let modeConfig: SearchModeConfig | null = null;

  for (const config of Object.values(SEARCH_MODES)) {
    if (text.slice(cursor).startsWith(config.trigger)) {
      tokens.push({
        id: `mode-${config.trigger}`,
        label: config.trigger.trim(),
        kind: 'mode',
        startIndex: cursor,
        endIndex: cursor + config.trigger.length,
      });
      modeConfig = config;
      cursor += config.trigger.length;
      break;
    }
  }

  while (cursor < text.length) {
    const remaining = text.slice(cursor);
    const conversationMatch = remaining.match(CONVERSATION_MENTION_AT_START_REGEX);
    if (conversationMatch) {
      const tokenText = conversationMatch[0];
      const title = conversationMatch[1] ?? 'Conversation';
      const trailingSpaceLength = text[cursor + tokenText.length] === ' ' ? 1 : 0;
      tokens.push({
        id: `conversation-${cursor}-${title}`,
        label: title,
        kind: 'conversation',
        startIndex: cursor,
        endIndex: cursor + tokenText.length + trailingSpaceLength,
      });
      cursor += tokenText.length + trailingSpaceLength;
      continue;
    }

    const fileMatch = remaining.match(FILE_MENTION_AT_START_REGEX);
    if (fileMatch) {
      const tokenText = fileMatch[0];
      const relativePath = fileMatch[1] ?? '';
      const file = files.find((candidate) => candidate.relativePath === relativePath);
      const trailingSpaceLength = text[cursor + tokenText.length] === ' ' ? 1 : 0;
      tokens.push({
        id: `file-${cursor}-${relativePath}`,
        label: file?.name ?? getPathDisplayName(relativePath),
        kind: file?.kind ?? 'file',
        startIndex: cursor,
        endIndex: cursor + tokenText.length + trailingSpaceLength,
      });
      cursor += tokenText.length + trailingSpaceLength;
      continue;
    }

    break;
  }

  return {
    tokens,
    hiddenEndIndex: tokens[tokens.length - 1]?.endIndex ?? leadingWhitespaceLength,
    modeConfig,
  };
}

/**
 * Attachment menu button - dropdown with file attachment and mind map options
 */
type AttachmentMenuButtonProps = {
  onSelectFiles?: () => void;
  onOpenCanvas?: () => void;
  canAddMore: boolean;
  maxAttachments: number;
};

const AttachmentMenuButton = ({ onSelectFiles, onOpenCanvas, canAddMore, maxAttachments }: AttachmentMenuButtonProps) => {
  const [isOpen, setIsOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  // Close menu when clicking outside or pressing Escape
  useEffect(() => {
    if (!isOpen) return;
    const handleClickOutside = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setIsOpen(false);
      }
    };
    const handleKeyDown = (e: globalThis.KeyboardEvent) => {
      if (e.key === 'Escape') {
        setIsOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [isOpen]);

  const handleSelectFiles = () => {
    onSelectFiles?.();
    setIsOpen(false);
  };

  const handleOpenCanvas = () => {
    onOpenCanvas?.();
    setIsOpen(false);
  };

  return (
    <div ref={menuRef} className={styles.attachButtonWrapper}>
      <IconButton
        size="xs"
        variant="ghost"
        className={styles.attachButton}
        onClick={() => setIsOpen(!isOpen)}
        aria-label="Add attachment"
        aria-expanded={isOpen}
        aria-haspopup="menu"
      >
        <Paperclip size={16} aria-hidden />
      </IconButton>
      {isOpen && (
        <div className={styles.attachMenu} role="menu">
          {onSelectFiles && (
            <button
              type="button"
              className={styles.attachMenuItem}
              onClick={handleSelectFiles}
              disabled={!canAddMore}
              role="menuitem"
            >
              <Paperclip size={16} className={styles.attachMenuIcon} aria-hidden />
              {canAddMore ? 'Attach file' : `Max ${maxAttachments} files`}
            </button>
          )}
          {onOpenCanvas && (
            <button
              type="button"
              className={styles.attachMenuItem}
              onClick={handleOpenCanvas}
              disabled={!canAddMore}
              role="menuitem"
            >
              <Network size={16} className={styles.attachMenuIcon} aria-hidden />
              {canAddMore ? 'Create mind map' : 'Max attachments'}
            </button>
          )}
        </div>
      )}
    </div>
  );
};

export type AgentComposerProps = {
  commandInputRef: RefObject<HTMLTextAreaElement | null>;
  textPrompt: string;
  placeholder: string;
  isEditing: boolean;
  isBusy: boolean;
  isStopping: boolean;
  isTextPending: boolean;
  isPreparingMentionContext?: boolean;
  mentionPopoverContent: ReactNode;
  currentMentionedFiles: MentionedFileCandidate[];
  maxAttachmentCount: number;
  primaryButtonDisabled: boolean;
  // Stop functionality (optional - passed by InteractionStrip wrapper)
  processingTurnId?: string | null;
  onStopActiveTurn?: () => Promise<void> | void;
  // Edit mode cancel (optional - shown as hint when editing)
  onCancelEdit?: () => void;
  // Transcription mic props
  isTranscribing: boolean;
  isTranscribeProcessing: boolean;
  onToggleTranscription: () => void;
  // Hide internal mic button when external mic is used (unified layout)
  hideInternalMic?: boolean;
  onChange: (event: ChangeEvent<HTMLTextAreaElement>) => void;
  onChangeValue?: (value: string, selectionStart: number | null) => void;
  onReplaceTextPrompt?: (value: string) => void;
  onKeyDown: (event: KeyboardEvent<HTMLTextAreaElement>) => void;
  onSubmit: (mode?: QueueMode) => void | Promise<void>;
  onRefreshMentionContext: (value: string, caretPosition: number | null) => void;
  /**
   * Stage 4 of `docs/plans/260501_composer_tiptap_atmention_bugfix.md` —
   * IME-guard parity. Forwarded to `TipTapPromptEditor.onCompositionEnd`,
   * which fires when the editor's `compositionend` DOM event fires. The
   * parent uses it to flush its IME-deferred mention-context debounce. Only
   * relevant on the rich-input path; ignored by the legacy textarea path.
   */
  onCompositionEnd?: () => void;
  // Optional callback when composer receives focus (used for cache warming)
  onComposerFocus?: () => void;
  // File attachment props (optional - passed when file attachments enabled)
  attachments?: FileAttachment[];
  onRemoveAttachment?: (id: string) => void;
  onPasteFile?: (clipboardData: DataTransfer) => Promise<boolean>;
  onSelectFiles?: (files: FileList) => Promise<number>;
  isDragging?: boolean;
  onDragEnter?: (e: DragEvent) => void;
  onDragLeave?: (e: DragEvent) => void;
  onDragOver?: (e: DragEvent) => void;
  onDrop?: (e: DragEvent) => Promise<void>;
  maxAttachments?: number;
  canAddMore?: boolean;
  /** Callback to open the mind map canvas */
  onOpenCanvas?: () => void;
  /** Custom action buttons. `null` = no buttons (input-only mode). `undefined` = default Send/Queue/Stop buttons. */
  renderActions?: ReactNode | null;
  /** Wrapper element type. 'form' (default) wraps in a <form> with onSubmit. 'div' wraps in a plain <div>. */
  wrapperElement?: 'form' | 'div';
  /** Number of pending conversation annotations (reflects in Send button label) */
  annotationCount?: number;
  /**
   * Chrome ownership for the input shell.
   * - `standalone` (default): the composer draws its own border/background/focus ring.
   * - `embedded`: a parent surface (e.g. `InteractionStrip.inputContainer`) draws the input chrome and
   *   the composer's shell stays transparent. Use this when the composer is placed inside a parent
   *   that already provides the visible input box.
   */
  chromeMode?: 'standalone' | 'embedded';
  /**
   * Optional ref to the TipTap-based prompt editor. Wired up only when the
   * `composer.tiptap` feature flag is on (see `featureFlags.ts`). The parent uses this handle to
   * insert mention chips imperatively from `useMentionAutocomplete`'s suggestion adapter, replace
   * the markdown content on session switch, and bridge focus from external consumers. When the
   * flag is off, the legacy textarea path runs and this ref stays `null`.
   */
  tiptapEditorRef?: RefObject<TipTapPromptEditorHandle | null>;
  resolveOperatorMention?: MarkdownToDocOptions['resolveOperatorMention'];
};

const AgentComposerComponent = ({
  commandInputRef,
  textPrompt,
  placeholder,
  isEditing,
  isBusy,
  isStopping,
  isTextPending,
  isPreparingMentionContext = false,
  mentionPopoverContent,
  currentMentionedFiles,
  primaryButtonDisabled,
  processingTurnId = null,
  onStopActiveTurn,
  onCancelEdit,
  isTranscribing,
  isTranscribeProcessing,
  onToggleTranscription,
  hideInternalMic = false,
  onChange,
  onChangeValue,
  onReplaceTextPrompt,
  onKeyDown,
  onSubmit,
  onRefreshMentionContext,
  onCompositionEnd,
  onComposerFocus,
  // File attachment props
  attachments = [],
  onRemoveAttachment,
  onPasteFile,
  onSelectFiles,
  isDragging = false,
  onDragEnter,
  onDragLeave,
  onDragOver,
  onDrop,
  maxAttachments = 5,
  canAddMore = true,
  onOpenCanvas,
  renderActions,
  wrapperElement = 'form',
  annotationCount = 0,
  chromeMode = 'standalone',
  tiptapEditorRef,
  resolveOperatorMention,
}: AgentComposerProps) => {
  const isRichInputEnabled = isComposerFlagEnabled('tiptap');
  const fileInputRef = useRef<HTMLInputElement>(null);
  const { deviceLabel } = useAudioInputDevice();

  const handleSubmit = useCallback(
    (event: FormEvent) => {
      event.preventDefault();
      // Default behavior:
      // - Normal typing while busy: queue (less destructive)
      // - Editing/re-run: always send now (edits are not queueable)
      void onSubmit(resolveComposerSubmitMode({ isBusy, isEditing }));
    },
    [onSubmit, isBusy, isEditing]
  );

  const handleSendNowClick = useCallback(
    (event: SyntheticEvent) => {
      event.preventDefault();
      void onSubmit('sendNow');
    },
    [onSubmit]
  );

  const handleStop = useCallback(
    (event: FormEvent) => {
      event.preventDefault();
      if (onStopActiveTurn) {
        void onStopActiveTurn();
      }
    },
    [onStopActiveTurn]
  );

  const handlePaste = useCallback(
    (event: ClipboardEvent<HTMLTextAreaElement>) => {
      if (!onPasteFile) return;
      // We must decide synchronously whether to hijack paste; otherwise the
      // browser inserts clipboard text before attachment handling runs.
      const pasteMode = getClipboardAttachmentPasteMode(event.clipboardData);
      if (pasteMode === 'attachment-only') {
        event.preventDefault();
        void onPasteFile(event.clipboardData);
        return;
      }
      if (pasteMode === 'mixed') {
        void onPasteFile(event.clipboardData);
      }
    },
    [onPasteFile]
  );

  const handleAttachClick = useCallback(() => {
    fileInputRef.current?.click();
  }, []);

  const handleFileInputChange = useCallback(
    async (event: ChangeEvent<HTMLInputElement>) => {
      const files = event.target.files;
      if (files && files.length > 0 && onSelectFiles) {
        await onSelectFiles(files);
      }
      // Reset input so the same file can be selected again
      event.target.value = '';
    },
    [onSelectFiles]
  );

  // Determine if we should show Stop button (busy with no text typed and no annotations)
  // or Send/Interrupt button (idle, or busy with text/annotations)
  const hasAnnotations = annotationCount > 0;
  const showStopButton = Boolean(isBusy && processingTurnId && onStopActiveTurn && !textPrompt.trim() && !hasAnnotations);
  const hasTextWhileBusyAndNotEditing = Boolean(!isEditing && isBusy && textPrompt.trim() && !hasAnnotations);

  const primaryButtonLabel = (() => {
    if (isPreparingMentionContext) {
      return (
        <>
          <Spinner size="sm" decorative />
          Preparing context…
        </>
      );
    }
    if (isTextPending) {
      return (
        <>
          <Spinner size="sm" decorative />
          Sending…
        </>
      );
    }
    if (isStopping) {
      return (
        <>
          <Spinner size="sm" decorative />
          Stopping…
        </>
      );
    }
    if (showStopButton) {
      return (
        <>
          <Square size={16} aria-hidden />
          Stop
        </>
      );
    }
    // Annotations take priority — they always send immediately (not queueable)
    if (hasAnnotations) {
      const suffix = isEditing ? ' & re-run' : '';
      return `Send + ${annotationCount} comment${annotationCount !== 1 ? 's' : ''}${suffix}`;
    }
    if (hasTextWhileBusyAndNotEditing) {
      return (
        <>
          <ListPlus size={16} aria-hidden />
          Queue
        </>
      );
    }
    if (isEditing) return 'Save & re-run';
    return 'Send';
  })();

  const transcribeMicClassName = cn(
    styles.transcribeMic,
    isTranscribing && styles.transcribeMicRecording,
    isTranscribeProcessing && styles.transcribeMicProcessing
  );

  const {
    tokens: contextTokens,
    hiddenEndIndex,
    modeConfig,
  } = useMemo(
    () => extractLeadingContextTokens(textPrompt, currentMentionedFiles),
    [currentMentionedFiles, textPrompt]
  );

  const displayTextPrompt = contextTokens.length > 0
    ? textPrompt.slice(hiddenEndIndex)
    : textPrompt;
  const toStoredPrompt = useCallback(
    (displayValue: string) => {
      if (contextTokens.length === 0) return displayValue;
      return `${textPrompt.slice(0, hiddenEndIndex)}${displayValue}`;
    },
    [contextTokens.length, hiddenEndIndex, textPrompt]
  );
  const toStoredCaret = useCallback(
    (displayCaret: number | null) => {
      if (contextTokens.length === 0 || displayCaret === null) return displayCaret;
      return hiddenEndIndex + displayCaret;
    },
    [contextTokens.length, hiddenEndIndex]
  );

  // The rich editor owns chip rendering inline, so placeholder visibility should be determined by
  // editor emptiness, not by whether the stored prompt contains mention tokens. The legacy textarea
  // path still suppresses placeholder while its leading context-chip rail is visible to avoid
  // helper text appearing behind the overlay.
  const effectivePlaceholder = isRichInputEnabled || contextTokens.length === 0 ? placeholder : '';

  const handleTextAreaChange = useCallback(
    (event: ChangeEvent<HTMLTextAreaElement>) => {
      if (contextTokens.length === 0 || !onChangeValue) {
        onChange(event);
        return;
      }

      const displayValue = event.target.value;
      onChangeValue(
        displayValue.length > 0 ? toStoredPrompt(displayValue) : '',
        displayValue.length > 0 ? toStoredCaret(event.target.selectionStart) : 0
      );
    },
    [contextTokens.length, onChange, onChangeValue, toStoredCaret, toStoredPrompt]
  );

  const handleRemoveContextToken = useCallback((token: ComposerContextToken) => {
    if (!onReplaceTextPrompt) return;

    const nextValue = `${textPrompt.slice(0, token.startIndex)}${textPrompt.slice(token.endIndex)}`;
    onReplaceTextPrompt(nextValue);

    requestAnimationFrame(() => {
      const textarea = commandInputRef.current;
      if (!textarea) return;
      textarea.focus();
      textarea.setSelectionRange(0, 0);
    });
  }, [commandInputRef, onReplaceTextPrompt, textPrompt]);

  const refreshMentionContext = useCallback(
    (event: SyntheticEvent<HTMLTextAreaElement>) => {
      const target = event.currentTarget;
      onRefreshMentionContext(toStoredPrompt(target.value), toStoredCaret(target.selectionStart ?? target.value.length));
    },
    [onRefreshMentionContext, toStoredCaret, toStoredPrompt]
  );

  const handleFocus = useCallback(
    (event: SyntheticEvent<HTMLTextAreaElement>) => {
      refreshMentionContext(event);
      onComposerFocus?.();
    },
    [refreshMentionContext, onComposerFocus]
  );

  const handleKeyUp = useCallback(
    (event: KeyboardEvent<HTMLTextAreaElement>) => {
      if (event.key.length === 1) return;
      onRefreshMentionContext(
        toStoredPrompt(event.currentTarget.value),
        toStoredCaret(event.currentTarget.selectionStart ?? event.currentTarget.value.length)
      );
    },
    [onRefreshMentionContext, toStoredCaret, toStoredPrompt]
  );

  const inputArea = (
    <>
      <div className={styles.textEntryField}>
        {/* File attachments thumbnail strip */}
        {attachments.length > 0 && onRemoveAttachment && (
          <AttachmentThumbnailStrip
            attachments={attachments}
            onRemove={onRemoveAttachment}
            maxAttachments={maxAttachments}
          />
        )}
        <div className={styles.textInputWrapper}>
          <div
            className={cn(
              styles.inputShell,
              chromeMode === 'embedded' ? styles.inputShellEmbedded : styles.inputShellStandalone
            )}
          >
            <div className={styles.contextInputRow}>
              {!isRichInputEnabled && contextTokens.length > 0 && (
                <div className={styles.contextChipRail} aria-label="Selected context">
                  {contextTokens.map((token) => (
                    <ComposerContextChip
                      key={token.id}
                      label={token.label}
                      kind={token.kind}
                      onRemove={onReplaceTextPrompt ? () => handleRemoveContextToken(token) : undefined}
                    />
                  ))}
                </div>
              )}
              {isRichInputEnabled ? (
                <TipTapPromptEditor
                  ref={tiptapEditorRef}
                  commandInputRef={commandInputRef}
                  value={textPrompt}
                  onChange={(nextValue, caretIndex) => {
                    onChangeValue?.(nextValue, caretIndex);
                  }}
                  placeholder={effectivePlaceholder}
                  ariaLabel="Command input"
                  testId="composer-input"
                  onKeyDown={(event) =>
                    onKeyDown(event as unknown as KeyboardEvent<HTMLTextAreaElement>)
                  }
                  onFocus={() => {
                    onComposerFocus?.();
                  }}
                  onTransaction={(nextValue, caretIndex) => {
                    onRefreshMentionContext(nextValue, caretIndex);
                  }}
                  onCompositionEnd={onCompositionEnd}
                  onPasteCapture={(event) => {
                    if (!onPasteFile || !event.clipboardData) return false;
                    const pasteMode = getClipboardAttachmentPasteMode(event.clipboardData);
                    if (pasteMode === 'attachment-only') {
                      void onPasteFile(event.clipboardData);
                      return true;
                    }
                    if (pasteMode === 'mixed') {
                      void onPasteFile(event.clipboardData);
                    }
                    return false;
                  }}
                  resolveOperatorMention={resolveOperatorMention}
                />
              ) : (
                <textarea
                  ref={commandInputRef}
                  className={styles.textInput}
                  placeholder={effectivePlaceholder}
                  aria-label={modeConfig ? `${modeConfig.label} mode input` : 'Command input'}
                  data-testid="composer-input"
                  value={displayTextPrompt}
                  onChange={handleTextAreaChange}
                  onKeyDown={onKeyDown}
                  onKeyUp={handleKeyUp}
                  onSelect={refreshMentionContext}
                  onClick={refreshMentionContext}
                  onFocus={handleFocus}
                  onPaste={handlePaste}
                  rows={1}
                />
              )}
            </div>
            {/* Hidden file input for file selection (images, PDFs, documents, text files) */}
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
            {/* Attachment menu button */}
            {(onSelectFiles || onOpenCanvas) && (
              <AttachmentMenuButton
                onSelectFiles={onSelectFiles ? handleAttachClick : undefined}
                onOpenCanvas={onOpenCanvas}
                canAddMore={canAddMore}
                maxAttachments={maxAttachments}
              />
            )}
            {/* Internal mic button (hidden when external mic is used in unified layout) */}
            {!hideInternalMic && (
              <Tooltip content={deviceLabel} placement="top">
                <IconButton
                  size="xs"
                  variant="ghost"
                  className={transcribeMicClassName}
                  onClick={onToggleTranscription}
                  disabled={isTranscribeProcessing}
                  aria-label={
                    isTranscribeProcessing
                      ? 'Processing transcription'
                      : isTranscribing
                        ? 'Stop transcription'
                        : 'Transcribe voice to text'
                  }
                  aria-busy={isTranscribeProcessing}
                >
                  {isTranscribeProcessing ? (
                    <Spinner size="xs" decorative />
                  ) : isTranscribing ? (
                    <Square size={16} aria-hidden />
                  ) : (
                    <Mic size={16} aria-hidden />
                  )}
                </IconButton>
              </Tooltip>
            )}
          </div>
        </div>
        {/* Drop zone indicator */}
        {isDragging && (
          <div className={styles.dropZone}>
            <Paperclip size={24} />
            <span>Drop file here</span>
          </div>
        )}
        {mentionPopoverContent}
        {!isRichInputEnabled && currentMentionedFiles.length > 0 ? (
          <div className={styles.attachmentsPanel} aria-live="polite">
            <ul className={styles.attachmentsList}>
              {currentMentionedFiles.map((file) => {
                const isSkill = isSkillPath(file.relativePath);
                const IconComponent = isSkill ? Sparkles : file.kind === 'directory' ? Folder : FileText;
                return (
                  <li key={file.key} className={styles.attachmentItem}>
                    <div className={styles.attachmentPrimary}>
                      <IconComponent size={16} aria-hidden />
                      <span className={styles.attachmentName}>
                        {file.name}{file.kind === 'directory' ? '/' : ''}
                      </span>
                    </div>
                    <div className={styles.attachmentPath}>{file.relativePath}</div>
                  </li>
                );
              })}
            </ul>
          </div>
        ) : null}
      </div>
      {/* Edit mode cancel hint */}
      {isEditing && onCancelEdit && (
        <button
          type="button"
          className={styles.cancelEditLink}
          onClick={onCancelEdit}
          aria-label="Cancel edit (Escape)"
        >
          Cancel <span className={styles.cancelEditHint}>Esc</span>
        </button>
      )}
    </>
  );

  const defaultActions = renderActions === undefined ? (
    <>
      {showStopButton ? (
        <div className={styles.sendButtonContainer}>
          <Tooltip content="Stop (Esc Esc)" placement="top">
            <Button
              type="button"
              size="lg"
              variant="secondary"
              onClick={handleStop}
              disabled={isStopping}
              className={cn(styles.sendButton, styles.stopButton)}
              data-testid="stop-turn-button"
              aria-label={isStopping ? 'Stopping current response' : 'Stop current response'}
            >
              {primaryButtonLabel}
            </Button>
          </Tooltip>
        </div>
      ) : hasTextWhileBusyAndNotEditing ? (
        <div className={styles.dualButtonContainer}>
          <Button
            type="submit"
            size="lg"
            disabled={primaryButtonDisabled}
            data-testid="send-queue-button"
          >
            {primaryButtonLabel}
          </Button>
          <Tooltip content="Send now & interrupt" placement="top">
            <Button
              type="button"
              size="lg"
              variant="secondary"
              onClick={handleSendNowClick}
              disabled={primaryButtonDisabled}
              data-testid="send-now-button"
              aria-label="Send now and interrupt current task"
            >
              <SendHorizontal size={16} aria-hidden />
            </Button>
          </Tooltip>
        </div>
      ) : (
        <div className={styles.sendButtonContainer}>
          <Button type="submit" size="lg" disabled={primaryButtonDisabled} className={styles.sendButton} data-testid="composer-send-button">
            {primaryButtonLabel}
          </Button>
        </div>
      )}
    </>
  ) : renderActions;

  const wrapperClassName = cn(styles.textEntry, isDragging && styles.textEntryDragging);
  const dragProps = {
    onDragEnter,
    onDragLeave,
    onDragOver,
    onDrop,
  };

  if (wrapperElement === 'div') {
    return (
      <div className={wrapperClassName} {...dragProps}>
        {inputArea}
        {defaultActions}
      </div>
    );
  }

  return (
    <form className={wrapperClassName} onSubmit={handleSubmit} {...dragProps}>
      {inputArea}
      {defaultActions}
    </form>
  );
};

export const AgentComposer = memo(AgentComposerComponent);
AgentComposer.displayName = 'AgentComposer';
