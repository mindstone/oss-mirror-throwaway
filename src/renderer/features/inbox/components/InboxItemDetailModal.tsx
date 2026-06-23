import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type KeyboardEvent,
} from 'react';
import { CheckCircle2, ExternalLink, Folder, Loader2, Mail, Play, Trash2 } from 'lucide-react';
import { formatDistanceToNow } from 'date-fns';
import {
  Button,
  Dialog,
  DialogBody,
  DialogContent,
  DialogHeader,
  DialogTitle,
  IconButton,
  Tooltip,
} from '@renderer/components/ui';
import { AgentComposer } from '@renderer/features/composer/AgentComposer';
import { MentionPopover } from '@renderer/features/composer/components/MentionPopover';
import type { MentionHeroInputProps } from '@renderer/features/composer/components/MentionHeroInput';
import type { TipTapPromptEditorHandle } from '@renderer/features/composer/components/TipTapPromptEditor';
import { isComposerFlagEnabled } from '@renderer/features/composer/featureFlags';
import {
  findMentionTrigger,
  useMentionAutocomplete,
} from '@renderer/features/composer/hooks/useMentionAutocomplete';
import { useFileAttachments, type FileAttachment } from '@renderer/features/composer/hooks/useFileAttachments';
import { useTranscriptionMic } from '@renderer/features/composer/hooks/useTranscriptionMic';
import type { MentionFilterType } from '@renderer/features/mentions';
import { mentionResultToAttrs } from '@renderer/features/composer/utils/mentionResultToAttrs';
import { useAppContext } from '@renderer/contexts/AppContext';
import { MessageMarkdown } from '@renderer/components/MessageMarkdown';
import { formatSourceBadge } from '@renderer/utils/formatSourceLabel';
import type { InboxItem, InboxReference, InboxSource } from '@shared/types';
import { deriveContextPlaceholder } from '@rebel/shared';
import { useOptimisticExecution, type ExecutionStatus } from '../hooks/useOptimisticExecution';
import { resolveInboxCtaLabel } from '../utils/resolveInboxCtaLabel';
import { VoiceMicButton } from './VoiceMicButton';
import styles from './InboxItemDetailModal.module.css';

const MENTION_DEBOUNCE_MS = 250;
const MAX_ATTACHMENT_COUNT = 5;
const COMPOSER_MIN_HEIGHT_PX = 44;
const COMPOSER_MAX_HEIGHT_PX = 200;

const normalizeContext = (value?: string): string | undefined => {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
};

const getPathTail = (pathValue: string): string => {
  const segments = pathValue.split(/[\\/]/);
  return segments[segments.length - 1] || pathValue;
};

const getSourceLabel = (source: InboxSource | null | undefined): string | null => {
  if (!source) return null;

  if (source.kind === 'role') {
    return formatSourceBadge(source.roleName || 'Role');
  }

  if (source.label) {
    return formatSourceBadge(source.label);
  }

  if (source.kind === 'workspace') {
    return formatSourceBadge(getPathTail(source.path));
  }

  if (source.kind === 'automation') {
    return formatSourceBadge(source.automationName || 'Automation');
  }

  if (source.kind === 'meeting') {
    return formatSourceBadge(source.meetingTitle || 'Meeting');
  }

  if (source.kind === 'conversation') {
    return formatSourceBadge('Conversation');
  }

  return formatSourceBadge('Source');
};

const getReferenceLabel = (reference: InboxReference): string => {
  if (reference.label) {
    return reference.label;
  }

  if (reference.kind === 'workspace') {
    return getPathTail(reference.path);
  }

  if (reference.kind === 'url') {
    try {
      return new URL(reference.url).hostname;
    } catch {
      return reference.url;
    }
  }

  if (reference.kind === 'email') {
    return reference.threadId;
  }

  // Future-proof: warn about unknown reference kinds
  console.warn(`Unknown inbox reference kind: ${(reference as { kind: string }).kind}`);
  return 'Reference';
};

export type InboxItemDetailModalMentionProps = Pick<
  MentionHeroInputProps,
  | 'mentionResultsForQuery'
  | 'ensureLibraryIndex'
  | 'getRelativeLibraryPath'
  | 'hasWorkspace'
  | 'hasConversations'
  | 'coreDirectory'
  | 'libraryIndex'
  | 'libraryIndexLoading'
  | 'libraryIndexError'
  | 'refreshLibraryIndex'
>;

export type InboxItemDetailModalProps = {
  itemId: string;
  items: InboxItem[];
  executionStatus?: ExecutionStatus;
  onExecute: (itemId: string, pinAfter: boolean, context?: string, attachments?: FileAttachment[]) => void;
  onDone?: (itemId: string) => void;
  onDismiss?: (itemId: string) => void;
  onClose: () => void;
  onOpenFile?: (path: string) => void;
  onSetTags?: (itemId: string, tags: string[]) => void;
  initialContext?: string;
} & InboxItemDetailModalMentionProps;

const InboxItemDetailModalComponent = ({
  itemId,
  items,
  executionStatus = 'idle',
  onExecute,
  onDone,
  onDismiss,
  onClose,
  onOpenFile,
  onSetTags,
  initialContext,
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
}: InboxItemDetailModalProps) => {
  const [context, setContext] = useState(initialContext ?? '');
  const isRichInputEnabled = isComposerFlagEnabled('tiptap');
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const tiptapEditorRef = useRef<TipTapPromptEditorHandle | null>(null);
  const mentionCaretRef = useRef<number | null>(null);
  const mentionDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const suppressMentionRefreshRef = useRef(false);
  const { showToast } = useAppContext();

  const {
    attachments: fileAttachments,
    addFromClipboard,
    addFromFileList,
    removeAttachment,
    canAddMore,
    isDragging,
    handleDragEnter,
    handleDragLeave,
    handleDragOver,
    handleDrop,
  } = useFileAttachments({ onError: (msg) => showToast({ title: msg }) });

  const item = useMemo(
    () => items.find((candidate) => candidate.id === itemId) ?? null,
    [items, itemId],
  );
  const hasDraft = Boolean(item?.draft?.trim());
  const sourceLabel = useMemo(() => getSourceLabel(item?.source), [item?.source]);

  // Tag editing state
  const [tagInput, setTagInput] = useState('');
  const handleAddTag = useCallback(() => {
    if (!item || !onSetTags) return;
    const newTag = tagInput.trim().toLowerCase();
    if (!newTag) return;
    const currentTags = item.tags ?? [];
    if (currentTags.includes(newTag)) { setTagInput(''); return; }
    onSetTags(item.id, [...currentTags, newTag]);
    setTagInput('');
  }, [item, onSetTags, tagInput]);
  const handleRemoveTag = useCallback((tag: string) => {
    if (!item || !onSetTags) return;
    onSetTags(item.id, (item.tags ?? []).filter(t => t !== tag));
  }, [item, onSetTags]);
  const handleTagKeyDown = useCallback((e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter' || e.key === ',') {
      e.preventDefault();
      handleAddTag();
    }
  }, [handleAddTag]);

  const hasModels = useMemo(
    () => mentionResultsForQuery('', 'models').length > 0,
    [mentionResultsForQuery],
  );

  const setTextPrompt = useCallback((updater: (prev: string) => string) => {
    setContext((prev) => updater(prev));
  }, []);

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

  const { isActive, markPending } = useOptimisticExecution(executionStatus);

  useEffect(() => {
    if (!item) {
      onClose();
    }
  }, [item, onClose]);

  useEffect(() => {
    setContext(initialContext ?? '');
    clearMentionState();
  }, [itemId, initialContext, clearMentionState]);

  useEffect(() => {
    ensureLibraryIndex();
  }, [itemId, ensureLibraryIndex]);

  useEffect(() => {
    return () => {
      if (mentionDebounceRef.current) {
        clearTimeout(mentionDebounceRef.current);
      }
    };
  }, []);

  // Auto-resize textarea as content changes
  const resizeRafRef = useRef<number | null>(null);
  useEffect(() => {
    if (resizeRafRef.current !== null) {
      cancelAnimationFrame(resizeRafRef.current);
    }
    resizeRafRef.current = requestAnimationFrame(() => {
      resizeRafRef.current = null;
      const textarea = textareaRef.current;
      if (!textarea) return;

      textarea.style.height = 'auto';
      const scrollHeight = textarea.scrollHeight;
      const bounded = Math.min(Math.max(scrollHeight, COMPOSER_MIN_HEIGHT_PX), COMPOSER_MAX_HEIGHT_PX);
      textarea.style.height = `${bounded}px`;
      textarea.style.overflowY = scrollHeight > COMPOSER_MAX_HEIGHT_PX ? 'auto' : 'hidden';
    });
    return () => {
      if (resizeRafRef.current !== null) {
        cancelAnimationFrame(resizeRafRef.current);
      }
    };
  }, [context]);

  const handleFilterChange = useCallback(
    (filter: MentionFilterType) => {
      if (mentionDebounceRef.current) {
        clearTimeout(mentionDebounceRef.current);
        mentionDebounceRef.current = null;
      }
      const currentValue = textareaRef.current?.value ?? context;
      const caret = textareaRef.current?.selectionStart ?? currentValue.length;
      findMentionTrigger(currentValue, caret);
      setManualFilter(filter);
    },
    [context, setManualFilter],
  );

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
        showModelsTab={hasModels}
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
    hasModels,
    handleFilterChange,
  ]);

  const clearContext = useCallback(() => {
    setContext('');
    clearMentionState();
  }, [clearMentionState]);

  const currentAttachments = useMemo(
    () => (fileAttachments.length > 0 ? fileAttachments : undefined),
    [fileAttachments],
  );

  const handlePasteFile = useCallback(
    async (clipboardData: DataTransfer) => addFromClipboard(clipboardData),
    [addFromClipboard],
  );

  const handleExecuteAction = useCallback(
    (pinAfter: boolean, contextOverride?: string) => {
      if (isActive) return;
      markPending();
      onExecute(itemId, pinAfter, normalizeContext(contextOverride ?? context) ?? undefined, currentAttachments);
      clearContext();
      onClose();
    },
    [isActive, markPending, onExecute, itemId, context, currentAttachments, clearContext, onClose],
  );

  const handlePrimarySubmit = useCallback(
    (contextOverride?: string) => {
      handleExecuteAction(true, contextOverride ?? context);
    },
    [context, handleExecuteAction],
  );

  const handleContextValueChange = useCallback(
    (value: string, selectionStart: number | null) => {
      setContext(value);

      if (!value.includes('@')) {
        if (mentionDebounceRef.current) {
          clearTimeout(mentionDebounceRef.current);
          mentionDebounceRef.current = null;
        }
        clearMentionState();
        return;
      }

      if (mentionDebounceRef.current) {
        clearTimeout(mentionDebounceRef.current);
      }

      mentionDebounceRef.current = setTimeout(() => {
        updateMentionContext(value, selectionStart ?? value.length);
      }, MENTION_DEBOUNCE_MS);
    },
    [updateMentionContext, clearMentionState],
  );

  const handleContextChange = useCallback(
    (event: ChangeEvent<HTMLTextAreaElement>) => {
      handleContextValueChange(event.target.value, event.target.selectionStart);
    },
    [handleContextValueChange],
  );

  const replaceContext = useCallback(
    (value: string) => {
      setContext(value);
      if (mentionDebounceRef.current) {
        clearTimeout(mentionDebounceRef.current);
        mentionDebounceRef.current = null;
      }
      clearMentionState();
    },
    [clearMentionState],
  );

  const handleContextKeyDown = useCallback(
    (event: KeyboardEvent<HTMLTextAreaElement>) => {
      if (mentionState.active) {
        if (mentionState.results.length > 0) {
          if (event.key === 'ArrowDown') {
            event.preventDefault();
            navigateMentionDown();
            return;
          }
          if (event.key === 'ArrowUp') {
            event.preventDefault();
            navigateMentionUp();
            return;
          }
          if (event.key === 'Enter' || event.key === 'Tab') {
            event.preventDefault();
            selectCurrentMention();
            return;
          }
        }

        if (event.key === 'Escape') {
          event.preventDefault();
          event.stopPropagation();
          clearMentionState();
          return;
        }
      }

      const isSubmitShortcut =
        event.key === 'Enter' && (event.metaKey || event.ctrlKey) && !event.shiftKey;

      if (isSubmitShortcut) {
        event.preventDefault();
        handlePrimarySubmit();
      }
    },
    [
      mentionState,
      navigateMentionDown,
      navigateMentionUp,
      selectCurrentMention,
      clearMentionState,
      handlePrimarySubmit,
    ],
  );

  const handleRefreshMentionContext = useCallback(
    (value: string, caretPosition: number | null) => {
      if (suppressMentionRefreshRef.current) {
        return;
      }
      updateMentionContext(value, caretPosition ?? value.length);
    },
    [updateMentionContext],
  );

  // Required by AgentComposer but won't fire: wrapperElement="div" prevents form
  // submission, and custom renderActions replaces default submit buttons.
  // Keyboard submit is handled by handleContextKeyDown -> handlePrimarySubmit.
  const handleComposerSubmit = useCallback(() => {
    handlePrimarySubmit();
  }, [handlePrimarySubmit]);

  const handleTranscript = useCallback((text: string) => {
    setContext((prev) => (prev ? `${prev} ${text}` : text));
  }, []);

  const handleTranscriptAndSend = useCallback(
    (text: string) => {
      const fullContext = (context ? `${context} ${text}` : text).trim();
      queueMicrotask(() => {
        handlePrimarySubmit(fullContext);
      });
    },
    [context, handlePrimarySubmit],
  );

  const handleTranscriptionError = useCallback(
    (message: string) => {
      showToast({ title: message, variant: 'error' });
    },
    [showToast],
  );

  const {
    isRecording,
    isProcessing: isTranscribeProcessing,
    toggleRecording,
    stopAndSend,
    audioLevel,
  } = useTranscriptionMic({
    currentSessionId: itemId,
    onTranscript: handleTranscript,
    onTranscriptAndSend: handleTranscriptAndSend,
    onError: handleTranscriptionError,
  });

  const handleSourceClick = useCallback(() => {
    if (item?.source?.kind === 'workspace' && onOpenFile) {
      onOpenFile(item.source.path);
    }
  }, [item, onOpenFile]);

  const handleReferenceClick = useCallback(
    (reference: InboxReference) => {
      if (reference.kind === 'workspace') {
        onOpenFile?.(reference.path);
        return;
      }

      if (reference.kind === 'url') {
        window.open(reference.url, '_blank', 'noopener');
        return;
      }

      // Email references and unknown kinds: no-op (no URL to open)
    },
    [onOpenFile],
  );

  const handleDone = useCallback(() => {
    if (isActive || !onDone) return;
    onDone(itemId);
    onClose();
  }, [isActive, onDone, itemId, onClose]);

  const handleDismiss = useCallback(() => {
    if (isActive || !onDismiss) return;
    onDismiss(itemId);
    onClose();
  }, [isActive, onDismiss, itemId, onClose]);

  if (!item) {
    return null;
  }

  const contextPlaceholder = deriveContextPlaceholder(item);
  const micDisabled = isTranscribeProcessing || (!isRecording && isActive);
  const canOpenSourceFile = item.source?.kind === 'workspace' && Boolean(onOpenFile);
  const timestampLabel = formatDistanceToNow(item.addedAt, { addSuffix: true });
  const ctaLabel = resolveInboxCtaLabel(item);

  return (
    <Dialog open={true} onOpenChange={(open) => !open && onClose()}>
      <DialogContent size="lg" className={styles.dialogContent} data-testid="inbox-item-detail-modal">
        <DialogHeader onClose={onClose} className={styles.header}>
          <DialogTitle className={styles.title}>{item.title}</DialogTitle>
          <div className={styles.headerMeta}>
            {sourceLabel && (
              canOpenSourceFile ? (
                <button
                  type="button"
                  className={`${styles.sourceBadge} ${styles.sourceBadgeButton}`}
                  onClick={handleSourceClick}
                  title={item.source?.kind === 'workspace' ? item.source.path : sourceLabel}
                >
                  {sourceLabel}
                </button>
              ) : (
                <span className={styles.sourceBadge}>{sourceLabel}</span>
              )
            )}
            <span className={styles.timestamp}>{timestampLabel}</span>
          </div>
          {/* Tags display + editor */}
          <div className={styles.tagsRow}>
            {(item.tags ?? []).map(tag => (
              <span key={tag} className={styles.tagPill}>
                {tag}
                {onSetTags && (
                  <button
                    type="button"
                    className={styles.tagRemoveButton}
                    onClick={() => handleRemoveTag(tag)}
                    aria-label={`Remove tag ${tag}`}
                  >
                    &times;
                  </button>
                )}
              </span>
            ))}
            {onSetTags && (
              <input
                type="text"
                className={styles.tagInput}
                placeholder="Add tag..."
                value={tagInput}
                onChange={(e) => setTagInput(e.target.value)}
                onKeyDown={handleTagKeyDown}
                onBlur={handleAddTag}
                aria-label="Add tag"
              />
            )}
          </div>
        </DialogHeader>

        <DialogBody className={styles.body}>
          {item.text.trim() && (
            <section className={styles.section}>
              <h3 className={styles.sectionTitle}>Details</h3>
              <div className={styles.markdownContent}>
                <MessageMarkdown
                  content={item.text}
                  onOpenFile={onOpenFile}
                  coreDirectory={coreDirectory ?? undefined}
                  showToast={showToast}
                />
              </div>
            </section>
          )}

          {item.clarifyingQuestion?.trim() && (
            <section className={styles.section}>
              <h3 className={styles.sectionTitle}>Clarifying question</h3>
              <div className={`${styles.markdownContent} ${styles.clarifyingQuestion}`}>
                <MessageMarkdown
                  content={item.clarifyingQuestion}
                  onOpenFile={onOpenFile}
                  coreDirectory={coreDirectory ?? undefined}
                  showToast={showToast}
                />
              </div>
            </section>
          )}

          {hasDraft && (
            <section className={styles.section}>
              <h3 className={styles.sectionTitle}>Draft</h3>
              <div className={styles.draftContent}>
                <MessageMarkdown
                  content={item.draft ?? ''}
                  onOpenFile={onOpenFile}
                  coreDirectory={coreDirectory ?? undefined}
                  showToast={showToast}
                />
              </div>
            </section>
          )}

          {item.references.length > 0 && (
            <section className={styles.section}>
              <h3 className={styles.sectionTitle}>References</h3>
              <div className={styles.references}>
                {item.references.map((reference, index) => {
                  const referenceLabel = getReferenceLabel(reference);

                  let ReferenceIcon = ExternalLink;
                  let chipStyleVariant = styles.referenceChipUrl;
                  let canOpen = true;
                  let titleText = '';

                  switch (reference.kind) {
                    case 'workspace':
                      ReferenceIcon = Folder;
                      chipStyleVariant = styles.referenceChipWorkspace;
                      canOpen = Boolean(onOpenFile);
                      titleText = reference.path;
                      break;
                    case 'url':
                      ReferenceIcon = ExternalLink;
                      chipStyleVariant = styles.referenceChipUrl;
                      titleText = reference.url;
                      break;
                    case 'email':
                      ReferenceIcon = Mail;
                      chipStyleVariant = styles.referenceChipUrl;
                      canOpen = false;
                      titleText = reference.threadId;
                      break;
                    default:
                      console.warn(`Unknown inbox reference kind: ${(reference as { kind: string }).kind}`);
                      canOpen = false;
                      break;
                  }

                  const chipClass = `${styles.referenceChip} ${chipStyleVariant} ${!canOpen ? styles.referenceChipDisabled : ''}`;

                  if (!canOpen) {
                    return (
                      <span
                        key={`ref-${reference.kind}-${index}`}
                        className={chipClass}
                        title={titleText}
                      >
                        <ReferenceIcon size={12} aria-hidden />
                        <span>{referenceLabel}</span>
                      </span>
                    );
                  }

                  return (
                    <button
                      key={`ref-${reference.kind}-${index}`}
                      type="button"
                      className={chipClass}
                      onClick={() => handleReferenceClick(reference)}
                      title={titleText}
                    >
                      <ReferenceIcon size={12} aria-hidden />
                      <span>{referenceLabel}</span>
                    </button>
                  );
                })}
              </div>
            </section>
          )}
        </DialogBody>

        <div className={styles.composerSection}>
          <div className={styles.composerRow}>
            <VoiceMicButton
              isRecording={isRecording}
              isProcessing={isTranscribeProcessing}
              disabled={micDisabled}
              audioLevel={audioLevel}
              onToggle={toggleRecording}
              onStopAndSend={stopAndSend}
            />
            <AgentComposer
              commandInputRef={textareaRef}
              textPrompt={context}
              placeholder={contextPlaceholder}
              isEditing={false}
              isBusy={isActive}
              isStopping={false}
              isTextPending={false}
              mentionPopoverContent={mentionPopover}
              currentMentionedFiles={[]}
              maxAttachmentCount={MAX_ATTACHMENT_COUNT}
              primaryButtonDisabled={isActive}
              isTranscribing={isRecording}
              isTranscribeProcessing={isTranscribeProcessing}
              onToggleTranscription={toggleRecording}
              hideInternalMic
              onChange={handleContextChange}
              onChangeValue={handleContextValueChange}
              onReplaceTextPrompt={replaceContext}
              onKeyDown={handleContextKeyDown}
              onSubmit={handleComposerSubmit}
              onRefreshMentionContext={handleRefreshMentionContext}
              attachments={fileAttachments}
              onRemoveAttachment={removeAttachment}
              onPasteFile={handlePasteFile}
              onSelectFiles={addFromFileList}
              isDragging={isDragging}
              onDragEnter={handleDragEnter}
              onDragLeave={handleDragLeave}
              onDragOver={handleDragOver}
              onDrop={handleDrop}
              maxAttachments={MAX_ATTACHMENT_COUNT}
              canAddMore={canAddMore}
              wrapperElement="div"
              tiptapEditorRef={isRichInputEnabled ? tiptapEditorRef : undefined}
              renderActions={
                <div className={styles.composerActions}>
                  <div className={styles.secondaryActions}>
                    {onDone && (
                      <Tooltip content="Mark as completed and move to Done" placement="top" delayShow={250}>
                        <IconButton
                          size="xs"
                          variant="ghost"
                          onClick={handleDone}
                          aria-label="Mark as done"
                          disabled={isActive}
                        >
                          <CheckCircle2 size={14} />
                        </IconButton>
                      </Tooltip>
                    )}
                    {onDismiss && (
                      <Tooltip content="Remove this item — tap Undo to restore" placement="top" delayShow={250}>
                        <IconButton
                          size="xs"
                          variant="ghost"
                          danger
                          onClick={handleDismiss}
                          aria-label="Delete item"
                          disabled={isActive}
                        >
                          <Trash2 size={14} />
                        </IconButton>
                      </Tooltip>
                    )}
                  </div>
                  <Button
                    onClick={() => handleExecuteAction(true)}
                    size="lg"
                    disabled={isActive}
                  >
                    {isActive ? (
                      <>
                        <Loader2 size={12} className={styles.spinner} />
                        <span>Prepping</span>
                      </>
                    ) : (
                      <><Play size={12} /> {ctaLabel}</>
                    )}
                  </Button>
                </div>
              }
            />
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
};

export const InboxItemDetailModal = memo(InboxItemDetailModalComponent);
InboxItemDetailModal.displayName = 'InboxItemDetailModal';
