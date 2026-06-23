/**
 * UserQuestionCard
 *
 * Progressive one-question-at-a-time stepper with clickable option cards.
 * Each question is shown in isolation. Single-select questions without
 * required option input auto-advance (intermediate steps) or auto-submit
 * (final step). Multi-select and requires-input questions wait for explicit submit.
 * Batch submission is preserved.
 *
 * @see docs/plans/260402_user_question_card_stepper_redesign.md
 */

import {
  memo,
  useState,
  useCallback,
  useRef,
  useEffect,
  type ChangeEvent,
  type KeyboardEvent,
} from 'react';
import {
  HelpCircle,
  Check,
  Send,
  SkipForward,
  X,
  Minus,
  ChevronLeft,
  ChevronRight,
  ChevronDown,
  Pencil,
  ExternalLink,
  Paperclip,
  Mic,
  Square,
  ShieldCheck,
  MessageCircleQuestion,
} from 'lucide-react';
import { cn } from '@renderer/lib/utils';
import { Button, IconButton, Spinner, Tooltip } from '@renderer/components/ui';
import type {
  AnyAttachmentPayload,
  UserQuestionBatch,
  UserQuestionAnswer,
  UserQuestionAnswerAttachment,
  UserQuestion,
} from '@shared/types';
import { isApprovalClarificationBatch } from '@shared/types/userQuestion';
import { AttachmentThumbnailStrip } from '@renderer/features/composer/components/AttachmentThumbnailStrip';
import {
  useFileAttachments,
  type FileAttachment,
} from '@renderer/features/composer/hooks/useFileAttachments';
import { useTranscriptionMic } from '@renderer/features/composer/hooks/useTranscriptionMic';
import styles from './UserQuestionCard.module.css';

export const AUTO_ADVANCE_DELAY_MS = 200;
export const SKIPPED_MARKER = '[Skipped]';
const SUPPLEMENTAL_UPLOAD_ACCEPT = [
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.webp',
  '.heic',
  '.heif',
  '.svg',
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  'image/heic',
  'image/heif',
  'image/svg+xml',
  '.pdf',
  '.doc',
  '.docx',
  '.xls',
  '.xlsx',
  '.ppt',
  '.pptx',
  '.rtf',
  '.txt',
  '.md',
  '.csv',
  '.json',
  '.xml',
].join(',');

// =============================================================================
// Types
// =============================================================================

export interface UserQuestionCardProps {
  /** The question batch to display */
  batch: UserQuestionBatch;
  /** Whether answers have been submitted */
  isAnswered: boolean;
  /** Submitted answers (when isAnswered is true) */
  answers?: UserQuestionAnswer[];
  /** Whether the batch was skipped (when isAnswered is true) */
  skipped?: boolean;
  /** Whether the batch was dismissed by the user (renderer-only, no IPC) */
  dismissed?: boolean;
  /** Submit handler */
  onSubmit: (
    batchId: string,
    answers: UserQuestionAnswer[],
    continuationAttachments?: AnyAttachmentPayload[],
  ) => Promise<void>;
  /** Dismiss handler — renderer-only, synchronous, no IPC */
  onDismiss: (batchId: string) => void;
  /** Minimize handler — collapses card to floating pill, restores composer */
  onMinimize?: (batchId: string) => void;
  /** Undo dismiss — restore batch to pending queue */
  onUndoDismiss: (batchId: string) => void;
  /** Whether a submission is in progress */
  isSubmitting: boolean;
  /** Submission error message */
  error?: string | null;
  /** Visual variant: 'inline' for conversation flow, 'footer' for input area replacement */
  variant?: 'inline' | 'footer';
  /** Custom icon for the header (defaults to HelpCircle). */
  headerIcon?: React.ReactNode;
  /** Custom header label (defaults to "Clarification question" or "Rebel has a question"). */
  headerLabel?: string;
  /** Optional CSS class applied to the header icon container for custom theming (e.g. celebratory). */
  headerIconClassName?: string;
}

interface QuestionSelections {
  selectedOptionIds: Set<string>;
  freeText: string;
  otherSelected: boolean;
  attachments: FileAttachment[];
}

// =============================================================================
// Helpers
// =============================================================================

export function createInitialSelections(questions: UserQuestion[]): Map<string, QuestionSelections> {
  const map = new Map<string, QuestionSelections>();
  for (const q of questions) {
    map.set(q.id, {
      selectedOptionIds: new Set(),
      freeText: '',
      otherSelected: false,
      attachments: [],
    });
  }
  return map;
}

function buildAnswerAttachmentMeta(attachment: FileAttachment): UserQuestionAnswerAttachment {
  return {
    id: attachment.id,
    name: attachment.name,
    type: attachment.type,
    mimeType: attachment.mimeType,
  };
}

function selectionUsesSupplementalInput(
  question: UserQuestion,
  selection?: QuestionSelections,
): boolean {
  if (!selection) return false;
  if (question.options.length === 0) return true;
  if (selection.otherSelected) return true;
  return question.options.some(
    (option) => option.requiresInput && selection.selectedOptionIds.has(option.id),
  );
}

export function buildAnswers(
  questions: UserQuestion[],
  sels: Map<string, QuestionSelections>,
): UserQuestionAnswer[] {
  return questions.map((q) => {
    const sel = sels.get(q.id);
    if (!sel) return { questionId: q.id, selectedOptionIds: [] };

    let freeText: string | undefined;
    let attachments: UserQuestionAnswerAttachment[] | undefined;
    if (sel.freeText === SKIPPED_MARKER) {
      freeText = SKIPPED_MARKER;
    } else {
      const usesSupplementalInput = selectionUsesSupplementalInput(q, sel);
      if (usesSupplementalInput && sel.freeText.trim()) {
        freeText = sel.freeText.trim();
      }
      if (usesSupplementalInput && sel.attachments.length > 0) {
        attachments = sel.attachments.map(buildAnswerAttachmentMeta);
      }
    }

    return {
      questionId: q.id,
      selectedOptionIds: Array.from(sel.selectedOptionIds),
      freeText,
      attachments,
    };
  });
}

/** Format an answer for read-only display */
export function formatAnswer(question: UserQuestion, answer: UserQuestionAnswer): string {
  const parts: string[] = [];
  for (const optId of answer.selectedOptionIds) {
    const option = question.options.find((o) => o.id === optId);
    if (option) parts.push(option.label);
  }
  if (answer.freeText) parts.push(`"${answer.freeText}"`);
  if (answer.attachments && answer.attachments.length > 0) {
    const attachmentNames = answer.attachments.map((attachment) => attachment.name).join(', ');
    parts.push(`Attached: ${attachmentNames}`);
  }
  return parts.join(', ') || '—';
}

/**
 * Decide whether a single-select option click should trigger the timed
 * auto-advance / auto-submit path.
 *
 * Returns `false` for multi-select (user may pick more) and for `requiresInput`
 * options (user still needs to type/paste). Also returns `false` for the
 * `url && !requiresInput` case: the option has just sent the user to another
 * tab (e.g. a provider's API keys page) and they have no way to bring the
 * value back if we auto-submit. Wait for explicit Submit instead.
 */
export function shouldAutoAdvanceAfterOptionSelect({
  multiSelect,
  requiresInput,
  hasUrl,
}: {
  multiSelect: boolean;
  requiresInput: boolean;
  hasUrl: boolean;
  /** Kept for call-site clarity; single-select without required input uses the same timed path for intermediate (advance) and final (submit). */
  isLastQuestion?: boolean;
}): boolean {
  if (hasUrl && !requiresInput) return false;
  return !multiSelect && !requiresInput;
}

interface SupplementalInputProps {
  sessionId: string;
  questionId: string;
  textValue: string;
  attachments: FileAttachment[];
  placeholder: string;
  ariaLabel: string;
  disabled: boolean;
  onTextChange: (questionId: string, value: string) => void;
  onAttachmentsChange: (questionId: string, attachments: FileAttachment[]) => void;
}

const SupplementalInput = ({
  sessionId,
  questionId,
  textValue,
  attachments: initialAttachments,
  placeholder,
  ariaLabel,
  disabled,
  onTextChange,
  onAttachmentsChange,
}: SupplementalInputProps) => {
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [transcriptionError, setTranscriptionError] = useState<string | null>(null);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [isUploading, setIsUploading] = useState(false);
  const {
    attachments,
    addFromFileList,
    removeAttachment,
    canAddMore,
  } = useFileAttachments({
    maxAttachments: 1,
    initialAttachments,
    onError: setUploadError,
    onAttachmentsChange: (nextAttachments) => onAttachmentsChange(questionId, nextAttachments),
  });

  const handleFileChange = useCallback(async (event: ChangeEvent<HTMLInputElement>) => {
    const files = event.target.files;
    setUploadError(null);
    if (files && files.length > 0) {
      setIsUploading(true);
      try {
        const addedCount = await addFromFileList(files);
        if (addedCount === 0) {
          setUploadError('That file could not be attached. Try PNG, JPEG, WebP, GIF, SVG, PDF, Office, or text files.');
        }
      } finally {
        setIsUploading(false);
      }
    }
    event.target.value = '';
  }, [addFromFileList]);

  const handleTextChange = useCallback((value: string) => {
    setTranscriptionError(null);
    onTextChange(questionId, value);
  }, [onTextChange, questionId]);

  const {
    isRecording,
    isProcessing: isTranscriptionProcessing,
    toggleRecording,
  } = useTranscriptionMic({
    currentSessionId: sessionId,
    onTranscript: (transcript) => {
      const nextValue = textValue.trim().length > 0
        ? `${textValue.trim()} ${transcript}`
        : transcript;
      setTranscriptionError(null);
      onTextChange(questionId, nextValue);
    },
    onError: setTranscriptionError,
    minDurationMs: 500,
    minBlobSizeBytes: 1000,
    onRecordingStarted: () => setTranscriptionError(null),
    onValidationFailed: (reason) => {
      const message = reason === 'too_short'
        ? 'Too short to catch. Hold the mic a little longer.'
        : reason === 'no_audio'
          ? 'No audio captured. Check your microphone permissions.'
          : "Couldn't make out any words. Try speaking closer to the mic.";
      setTranscriptionError(message);
    },
  });

  return (
    <div className={styles.supplementalInputGroup}>
      <div className={styles.supplementalInputShell}>
        <Tooltip content={isRecording ? 'Stop recording' : 'Start voice input'} placement="top">
          <IconButton
            size="xs"
            variant="ghost"
            active={isRecording}
            onClick={(event) => {
              event.stopPropagation();
              toggleRecording();
            }}
            disabled={disabled || isTranscriptionProcessing}
            aria-label={
              isTranscriptionProcessing
                ? 'Processing voice input'
                : isRecording
                  ? 'Stop recording'
                  : 'Start voice input'
            }
            aria-busy={isTranscriptionProcessing}
            aria-pressed={isRecording}
            className={cn(styles.supplementalIconButton, styles.supplementalMicButton)}
          >
            {isTranscriptionProcessing ? (
              <Spinner size="xs" decorative />
            ) : isRecording ? (
              <Square size={14} aria-hidden="true" />
            ) : (
              <Mic size={15} aria-hidden="true" />
            )}
          </IconButton>
        </Tooltip>
        <input
          type="text"
          className={styles.supplementalInput}
          value={textValue}
          onChange={(event) => handleTextChange(event.target.value)}
          placeholder={placeholder}
          aria-label={ariaLabel}
          autoFocus
          disabled={disabled}
        />
        <Tooltip content={canAddMore ? 'Upload file' : 'Only one file can be attached'} placement="top">
          <IconButton
            type="button"
            variant="ghost"
            size="xs"
            onClick={(event) => {
              event.stopPropagation();
              fileInputRef.current?.click();
            }}
            disabled={disabled || !canAddMore || isUploading}
            className={cn(styles.supplementalIconButton, styles.uploadButton)}
            aria-label={isUploading ? 'Uploading file' : 'Upload file'}
            aria-busy={isUploading}
          >
            {isUploading ? (
              <Spinner size="xs" decorative />
            ) : (
              <Paperclip size={15} aria-hidden="true" />
            )}
          </IconButton>
        </Tooltip>
        <input
          ref={fileInputRef}
          type="file"
          accept={SUPPLEMENTAL_UPLOAD_ACCEPT}
          className={styles.hiddenFileInput}
          onChange={(event) => {
            void handleFileChange(event);
          }}
          disabled={disabled}
        />
      </div>
      {transcriptionError && (
        <p className={styles.supplementalInputError} role="status">
          {transcriptionError}
        </p>
      )}
      {uploadError && (
        <p className={styles.supplementalInputError} role="status">
          {uploadError}
        </p>
      )}
      {attachments.length > 0 && (
        <div className={styles.supplementalAttachmentStrip}>
          <AttachmentThumbnailStrip
            attachments={attachments}
            onRemove={removeAttachment}
            maxAttachments={1}
          />
        </div>
      )}
    </div>
  );
};

// =============================================================================
// Component
// =============================================================================

const UserQuestionCardComponent = ({
  batch,
  isAnswered,
  answers,
  skipped,
  dismissed,
  onSubmit,
  onDismiss,
  onMinimize,
  onUndoDismiss,
  isSubmitting,
  error,
  variant = 'inline',
  headerIcon,
  headerLabel,
  headerIconClassName,
}: UserQuestionCardProps) => {
  const isFooter = variant === 'footer';
  const [currentQuestionIndex, setCurrentQuestionIndex] = useState(0);
  const [contextExpanded, setContextExpanded] = useState(false);
  const [selections, setSelections] = useState(() =>
    createInitialSelections(batch.questions),
  );

  const autoAdvanceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const optionRefs = useRef<Map<number, HTMLDivElement>>(new Map());
  const selectionsRef = useRef(selections);
  selectionsRef.current = selections;
  const isSubmittingRef = useRef(isSubmitting);
  isSubmittingRef.current = isSubmitting;

  const currentQuestion = batch.questions[currentQuestionIndex];
  const currentSelection = currentQuestion
    ? selections.get(currentQuestion.id)
    : undefined;
  const isLastQuestion = currentQuestionIndex === batch.questions.length - 1;
  const isSingleQuestionBatch = batch.questions.length === 1;
  const hasOptions = currentQuestion ? currentQuestion.options.length > 0 : false;
  const isApprovalClarification = isApprovalClarificationBatch(batch);
  const pendingHeaderLabel = headerLabel ?? (
    isApprovalClarification ? 'Clarification question' : 'Rebel has a question'
  );

  const questionHasAnswer = useCallback(
    (qId: string): boolean => {
      const sel = selections.get(qId);
      if (!sel) return false;
      if (sel.freeText === SKIPPED_MARKER) return true;
      const question = batch.questions.find((q) => q.id === qId);
      if (!question) return false;

      if (selectionUsesSupplementalInput(question, sel)) {
        return sel.freeText.trim().length > 0 || sel.attachments.length > 0;
      }

      if (sel.selectedOptionIds.size > 0) return true;
      return false;
    },
    [selections, batch.questions],
  );

  const hasRequiresInputSelected =
    !!currentQuestion &&
    currentQuestion.options.some(
      (o) => o.requiresInput && currentSelection?.selectedOptionIds.has(o.id),
    );

  const showNextButton =
    !!currentQuestion &&
    (currentQuestion.multiSelect ||
      !hasOptions ||
      !!currentSelection?.otherSelected ||
      hasRequiresInputSelected ||
      questionHasAnswer(currentQuestion.id));
  const isNextEnabled = !!currentQuestion && questionHasAnswer(currentQuestion.id);

  // ---------------------------------------------------------------------------
  // Timer management
  // ---------------------------------------------------------------------------

  const clearAutoAdvance = useCallback(() => {
    if (autoAdvanceTimerRef.current) {
      clearTimeout(autoAdvanceTimerRef.current);
      autoAdvanceTimerRef.current = null;
    }
  }, []);

  useEffect(() => () => clearAutoAdvance(), [clearAutoAdvance]);

  // ---------------------------------------------------------------------------
  // Submit / advance
  // ---------------------------------------------------------------------------

  const handleSubmitAll = useCallback(
    async (overrides?: Map<string, QuestionSelections>) => {
      if (isSubmittingRef.current) return;
      const activeSelections = overrides ?? selectionsRef.current;
      const builtAnswers = buildAnswers(
        batch.questions,
        activeSelections,
      );
      const continuationAttachments = Array.from(activeSelections.values())
        .flatMap((selection) => selection.attachments)
        .filter((attachment, index, allAttachments) =>
          allAttachments.findIndex((candidate) => candidate.id === attachment.id) === index,
        );
      await onSubmit(
        batch.batchId,
        builtAnswers,
        continuationAttachments.length > 0 ? continuationAttachments : undefined,
      );
    },
    [batch, onSubmit],
  );

  const advanceToNext = useCallback(() => {
    if (isLastQuestion) {
      void handleSubmitAll();
    } else {
      setCurrentQuestionIndex((i) => i + 1);
    }
  }, [isLastQuestion, handleSubmitAll]);

  // ---------------------------------------------------------------------------
  // Selection handlers (preserve v1 mutual-exclusion for multi-select + Other)
  // ---------------------------------------------------------------------------

  const handleOptionToggle = useCallback(
    (question: UserQuestion, optionId: string) => {
      setSelections((prev) => {
        const next = new Map(prev);
        const current = next.get(question.id);
        if (!current) return prev;

        const updated = {
          ...current,
          selectedOptionIds: new Set(current.selectedOptionIds),
          attachments: [...current.attachments],
        };
        if (updated.freeText === SKIPPED_MARKER) updated.freeText = '';

        if (question.multiSelect) {
          if (updated.selectedOptionIds.has(optionId))
            updated.selectedOptionIds.delete(optionId);
          else updated.selectedOptionIds.add(optionId);
          if (updated.selectedOptionIds.size > 0) updated.otherSelected = false;
        } else {
          if (!updated.selectedOptionIds.has(optionId)) updated.freeText = '';
          updated.selectedOptionIds = new Set([optionId]);
          updated.otherSelected = false;
        }

        if (!selectionUsesSupplementalInput(question, updated)) {
          updated.freeText = '';
          updated.attachments = [];
        }

        next.set(question.id, updated);
        return next;
      });
    },
    [],
  );

  const handleOtherToggle = useCallback(
    (questionId: string, multiSelect: boolean) => {
      const question = batch.questions.find((candidate) => candidate.id === questionId);
      if (!question) return;
      setSelections((prev) => {
        const next = new Map(prev);
        const current = next.get(questionId);
        if (!current) return prev;

        const updated = { ...current, attachments: [...current.attachments] };
        updated.otherSelected = !updated.otherSelected;
        if (updated.freeText === SKIPPED_MARKER) updated.freeText = '';
        if (!multiSelect) updated.selectedOptionIds = new Set();
        if (!updated.otherSelected && !selectionUsesSupplementalInput(question, updated)) {
          updated.freeText = '';
          updated.attachments = [];
        }

        next.set(questionId, updated);
        return next;
      });
    },
    [batch],
  );

  const handleOtherText = useCallback((questionId: string, text: string) => {
    setSelections((prev) => {
      const next = new Map(prev);
      const current = next.get(questionId);
      if (!current) return prev;
      next.set(questionId, { ...current, freeText: text, attachments: [...current.attachments] });
      return next;
    });
  }, []);

  const handleAttachmentsChange = useCallback((questionId: string, attachments: FileAttachment[]) => {
    setSelections((prev) => {
      const next = new Map(prev);
      const current = next.get(questionId);
      if (!current) return prev;
      next.set(questionId, { ...current, attachments });
      return next;
    });
  }, []);

  // ---------------------------------------------------------------------------
  // Stepper actions
  // ---------------------------------------------------------------------------

  const handleOptionClick = useCallback(
    (qId: string, optId: string) => {
      if (isSubmitting) return;
      const question = batch.questions.find((q) => q.id === qId);
      if (!question) return;

      const option = question.options.find((o) => o.id === optId);
      handleOptionToggle(question, optId);

      if (option?.url) {
        window.open(option.url, '_blank', 'noopener,noreferrer');
      }

      if (
        shouldAutoAdvanceAfterOptionSelect({
          multiSelect: question.multiSelect,
          requiresInput: !!option?.requiresInput,
          hasUrl: !!option?.url,
          isLastQuestion,
        })
      ) {
        clearAutoAdvance();
        autoAdvanceTimerRef.current = setTimeout(() => {
          if (isSubmittingRef.current) return;
          if (isLastQuestion) {
            void handleSubmitAll();
          } else {
            setCurrentQuestionIndex((i) => i + 1);
          }
        }, AUTO_ADVANCE_DELAY_MS);
      } else {
        clearAutoAdvance();
      }
    },
    [
      batch,
      isSubmitting,
      isLastQuestion,
      handleOptionToggle,
      clearAutoAdvance,
      handleSubmitAll,
    ],
  );

  const handleSomethingElseClick = useCallback(
    (qId: string) => {
      if (isSubmitting) return;
      const question = batch.questions.find((q) => q.id === qId);
      if (!question) return;
      clearAutoAdvance();
      handleOtherToggle(qId, question.multiSelect);
    },
    [batch, isSubmitting, handleOtherToggle, clearAutoAdvance],
  );

  const handleQuestionSkip = useCallback(() => {
    if (isSubmitting) return;
    clearAutoAdvance();

    const qId = currentQuestion.id;
    const skipSel: QuestionSelections = {
      selectedOptionIds: new Set(),
      freeText: SKIPPED_MARKER,
      otherSelected: false,
      attachments: [],
    };

    setSelections((prev) => {
      const next = new Map(prev);
      next.set(qId, skipSel);
      return next;
    });

    if (isLastQuestion) {
      const updated = new Map(selections);
      updated.set(qId, skipSel);
      void handleSubmitAll(updated);
    } else {
      setCurrentQuestionIndex((i) => i + 1);
    }
  }, [
    currentQuestion,
    isLastQuestion,
    selections,
    isSubmitting,
    clearAutoAdvance,
    handleSubmitAll,
  ]);

  const handleBack = useCallback(() => {
    clearAutoAdvance();
    setCurrentQuestionIndex((i) => Math.max(0, i - 1));
  }, [clearAutoAdvance]);

  const handleDismiss = useCallback(() => {
    clearAutoAdvance();
    onDismiss(batch.batchId);
  }, [batch.batchId, onDismiss, clearAutoAdvance]);

  const handleMinimize = useCallback(() => {
    clearAutoAdvance();
    onMinimize?.(batch.batchId);
  }, [batch.batchId, onMinimize, clearAutoAdvance]);

  // ---------------------------------------------------------------------------
  // Focus management
  // ---------------------------------------------------------------------------

  const setOptionRef = useCallback(
    (index: number) => (el: HTMLDivElement | null) => {
      if (el) optionRefs.current.set(index, el);
      else optionRefs.current.delete(index);
    },
    [],
  );

  const getFocusedOptionIndex = useCallback((): number => {
    const active = document.activeElement;
    for (const [i, el] of optionRefs.current.entries()) {
      if (el === active) return i;
    }
    return -1;
  }, []);

  // Collapse context when advancing to a new question
  useEffect(() => {
    setContextExpanded(false);
  }, [currentQuestionIndex]);

  useEffect(() => {
    if (isAnswered || !currentQuestion) return;
    const sel = selections.get(currentQuestion.id);
    if (sel?.otherSelected) return;

    requestAnimationFrame(() => {
      if (sel?.selectedOptionIds.size) {
        const firstId = Array.from(sel.selectedOptionIds)[0];
        const idx = currentQuestion.options.findIndex((o) => o.id === firstId);
        if (idx >= 0) {
          optionRefs.current.get(idx)?.focus();
          return;
        }
      }
      optionRefs.current.get(0)?.focus();
    });
    // Only fire on step transitions, not on every selection change
    // eslint-disable-next-line react-hooks/exhaustive-deps -- intentional: omitting selections/currentQuestion so focus only resets on question step transitions
  }, [currentQuestionIndex, isAnswered]);

  // ---------------------------------------------------------------------------
  // Keyboard navigation
  // ---------------------------------------------------------------------------

  const handleKeyDown = useCallback(
    (e: KeyboardEvent<HTMLDivElement>) => {
      if (isAnswered || !currentQuestion) return;

      const tag = (e.target as HTMLElement).tagName;

      if (tag === 'INPUT') {
        if (e.key === 'Enter') {
          e.preventDefault();
          if (questionHasAnswer(currentQuestion.id)) {
            clearAutoAdvance();
            advanceToNext();
          }
        } else if (e.key === 'Escape') {
          e.preventDefault();
          handleDismiss();
        }
        return;
      }

      if (tag === 'BUTTON') {
        if (e.key === 'Backspace' && currentQuestionIndex > 0) {
          e.preventDefault();
          handleBack();
        } else if (e.key === 'Escape') {
          e.preventDefault();
          handleDismiss();
        }
        return;
      }

      const totalCards = hasOptions ? currentQuestion.options.length + 1 : 0;

      switch (e.key) {
        case 'ArrowDown': {
          if (!totalCards) break;
          e.preventDefault();
          const cur = getFocusedOptionIndex();
          optionRefs.current
            .get(cur < 0 ? 0 : Math.min(cur + 1, totalCards - 1))
            ?.focus();
          break;
        }
        case 'ArrowUp': {
          if (!totalCards) break;
          e.preventDefault();
          const cur = getFocusedOptionIndex();
          optionRefs.current
            .get(cur < 0 ? 0 : Math.max(cur - 1, 0))
            ?.focus();
          break;
        }
        case 'Enter':
        case ' ': {
          const idx = getFocusedOptionIndex();
          if (idx < 0) break;
          e.preventDefault();
          if (idx < currentQuestion.options.length) {
            handleOptionClick(currentQuestion.id, currentQuestion.options[idx].id);
          } else if (idx === currentQuestion.options.length) {
            handleSomethingElseClick(currentQuestion.id);
          }
          break;
        }
        case 'Backspace': {
          if (currentQuestionIndex > 0) {
            e.preventDefault();
            handleBack();
          }
          break;
        }
        case 'Escape': {
          e.preventDefault();
          handleDismiss();
          break;
        }
      }
    },
    [
      isAnswered,
      currentQuestion,
      currentQuestionIndex,
      hasOptions,
      questionHasAnswer,
      clearAutoAdvance,
      advanceToNext,
      handleBack,
      handleDismiss,
      handleOptionClick,
      handleSomethingElseClick,
      getFocusedOptionIndex,
    ],
  );

  // ===========================================================================
  // Answered (read-only) state
  // ===========================================================================

  if (isAnswered) {
    const isSkipped = !!skipped;
    const answeredLabel = isApprovalClarification
        ? 'Clarification answered'
        : isSkipped
          ? 'Questions skipped'
          : 'Questions answered';
    const answeredAriaLabel = isApprovalClarification
        ? 'Clarification answered'
        : isSkipped
          ? 'Questions skipped'
          : 'Answered questions';
    return (
      <div
        data-testid="user-question-card"
        className={cn(
          styles.card,
          isApprovalClarification
              ? styles.cardApprovalAnswered
              : isSkipped
                ? styles.cardSkipped
                : styles.cardAnswered,
        )}
        role="region"
        aria-label={answeredAriaLabel}
      >
        <div className={styles.headerDivider}>
          <div className={styles.headerIcon}>
            {isSkipped ? (
              <SkipForward size={14} aria-hidden="true" />
            ) : isApprovalClarification ? (
              <MessageCircleQuestion size={14} aria-hidden="true" />
            ) : (
              <Check size={14} aria-hidden="true" />
            )}
          </div>
          <span className={styles.headerLabel}>{answeredLabel}</span>
          <span className={styles.headerLine} aria-hidden="true" />
        </div>

        {!isSkipped && (
          <div className={styles.answeredList}>
            {batch.questions.map((question) => {
              const answer = answers?.find((a) => a.questionId === question.id);
              const wasSkipped =
                answer?.freeText === SKIPPED_MARKER &&
                answer.selectedOptionIds.length === 0;
              return (
                <div key={question.id} className={styles.answeredRow}>
                  {question.header && (
                    <span className={styles.questionBadge}>
                      {question.header}
                    </span>
                  )}
                  <span className={styles.answeredQuestion}>
                    {question.question}
                  </span>
                  <span className={styles.answeredArrow} aria-hidden="true">
                    →
                  </span>
                  {wasSkipped ? (
                    <span className={styles.answeredSkipped}>Skipped</span>
                  ) : (
                    <span className={styles.answeredValue}>
                      {answer ? formatAnswer(question, answer) : '—'}
                    </span>
                  )}
                </div>
              );
            })}
          </div>
        )}

        {isApprovalClarification && !isSkipped && (
          <p className={styles.approvalReceiptNote}>
            Rebel will check your Safety Rules before sending or changing anything.
          </p>
        )}
      </div>
    );
  }

  // ===========================================================================
  // Dismissed (collapsed) state
  // ===========================================================================

  if (dismissed) {
    const dismissedLabel = isApprovalClarification ? 'Question hidden' : 'Questions dismissed';
    const showLabel = isApprovalClarification ? 'Show question' : 'Show questions';
    return (
      <div
        data-testid="user-question-card"
        className={cn(styles.card, styles.cardDismissed)}
        role="region"
        aria-label={dismissedLabel}
      >
        <div className={styles.headerDivider}>
          <div className={styles.headerIcon}>
            <X size={14} aria-hidden="true" />
          </div>
          <span className={styles.headerLabel}>{dismissedLabel}</span>
          <span className={styles.headerLine} aria-hidden="true" />
          <button
            type="button"
            className={styles.showQuestionsButton}
            onClick={() => onUndoDismiss(batch.batchId)}
          >
            {showLabel}
          </button>
        </div>
      </div>
    );
  }

  // ===========================================================================
  // Pending (interactive stepper) state
  // ===========================================================================

  if (!currentQuestion) return null;

  return (
    <div
      data-testid="user-question-card"
      className={cn(
        styles.card,
        isFooter && styles.cardFooter,
        isApprovalClarification && styles.cardApprovalClarification,
      )}
      role="form"
      aria-label={
        isSingleQuestionBatch
          ? pendingHeaderLabel
          : `${pendingHeaderLabel} — ${currentQuestionIndex + 1} of ${batch.questions.length}`
      }
      aria-describedby={error ? `uq-error-${batch.batchId}` : undefined}
      onKeyDown={handleKeyDown}
    >
      {/* Header — icon left-aligned, line extends right */}
      <div className={styles.headerDivider}>
        <Tooltip
          content={
            isApprovalClarification
              ? 'Answering this is not approval. Rebel still checks your Safety Rules before sending or changing anything.'
              : headerLabel ? headerLabel : "Asking a few quick questions helps Rebel give you a better, more personalized answer on the first try."
          }
          placement="top"
        >
          <div className={cn(styles.headerIcon, headerIconClassName)}>
            {headerIcon ?? (
              isApprovalClarification
                ? <ShieldCheck size={14} aria-hidden="true" />
                : <HelpCircle size={14} aria-hidden="true" />
            )}
          </div>
        </Tooltip>
        <span
          className={cn(
            styles.headerLabel,
            isApprovalClarification && styles.approvalHeaderLabel,
          )}
        >
          {pendingHeaderLabel}
        </span>
        {!isSingleQuestionBatch && (
          <span className={styles.progressIndicator} aria-live="polite">
            {currentQuestionIndex + 1} of {batch.questions.length}
          </span>
        )}
        <span className={styles.headerLine} aria-hidden="true" />
        {onMinimize && (
          <Tooltip content="Minimize — read the conversation first" placement="top">
            <button
              type="button"
              className={styles.minimizeButton}
              onClick={handleMinimize}
              aria-label="Minimize questions"
              disabled={isSubmitting}
            >
              <Minus size={14} aria-hidden="true" />
            </button>
          </Tooltip>
        )}
        <button
          type="button"
          className={styles.dismissButton}
          onClick={handleDismiss}
          aria-label={isApprovalClarification ? 'Hide question' : 'Dismiss all questions'}
          disabled={isSubmitting}
        >
          <X size={14} aria-hidden="true" />
        </button>
      </div>

      {/* Stepper content */}
      <div
        className={cn(
          styles.stepperContainer,
          isSubmitting && styles.stepperDisabled,
        )}
      >
        <div key={currentQuestionIndex} className={styles.stepContent}>
          <p className={styles.questionText}>{currentQuestion.question}</p>

          {isApprovalClarification && currentQuestion.context && (
            <p className={styles.approvalContextLine}>
              {currentQuestion.context}
            </p>
          )}

          {isApprovalClarification && (
            <p className={styles.approvalContextLine}>
              This only clarifies this request. Rebel checks your Safety Rules before acting.
            </p>
          )}

          {currentQuestion.context && !isApprovalClarification && (
            <div className={styles.contextSection}>
              <button
                type="button"
                className={styles.contextToggle}
                onClick={() => setContextExpanded((prev) => !prev)}
                aria-expanded={contextExpanded}
              >
                <ChevronDown
                  size={12}
                  className={cn(styles.contextChevron, contextExpanded && styles.contextChevronExpanded)}
                  aria-hidden="true"
                />
                {contextExpanded ? 'Hide details' : 'Show details'}
              </button>
              {contextExpanded && (
                <p className={styles.contextContent}>{currentQuestion.context}</p>
              )}
            </div>
          )}

          {hasOptions ? (
            <div
              className={styles.optionCardsGrid}
              role={currentQuestion.multiSelect ? 'group' : 'radiogroup'}
              aria-label={currentQuestion.question}
            >
              {currentQuestion.options.map((option, index) => {
                const isSelected =
                  currentSelection?.selectedOptionIds.has(option.id) ?? false;
                const showInput = isSelected && option.requiresInput;
                return (
                  <div
                    key={option.id}
                    ref={setOptionRef(index)}
                    role={currentQuestion.multiSelect ? 'checkbox' : 'radio'}
                    aria-checked={isSelected}
                    tabIndex={0}
                    className={cn(
                      styles.optionCard,
                      isSelected && styles.optionCardSelected,
                      showInput && styles.optionCardWithInput,
                    )}
                    onClick={() =>
                      handleOptionClick(currentQuestion.id, option.id)
                    }
                  >
                    <span className={styles.optionCardIndicator}>
                      {currentQuestion.multiSelect && isSelected ? (
                        <Check size={12} aria-hidden="true" />
                      ) : (
                        index + 1
                      )}
                    </span>
                    <span className={styles.optionCardContent}>
                      <span className={styles.optionCardLabel}>
                        {option.label}
                        {option.url && (
                          <ExternalLink
                            size={12}
                            className={styles.optionUrlIcon}
                            aria-hidden="true"
                          />
                        )}
                      </span>
                      {option.description && (
                        <span className={styles.optionCardDescription}>
                          {option.description}
                        </span>
                      )}
                      {showInput && (
                        <div
                          className={styles.optionSupplementalInput}
                          onClick={(event) => event.stopPropagation()}
                        >
                          <SupplementalInput
                            key={`${currentQuestion.id}-${option.id}`}
                            sessionId={batch.sessionId}
                            questionId={currentQuestion.id}
                            textValue={currentSelection?.freeText ?? ''}
                            attachments={currentSelection?.attachments ?? []}
                            onTextChange={handleOtherText}
                            onAttachmentsChange={handleAttachmentsChange}
                            placeholder={option.inputPlaceholder ?? 'Type or upload your answer...'}
                            ariaLabel={option.inputPlaceholder ?? `Input for: ${option.label}`}
                            disabled={isSubmitting}
                          />
                        </div>
                      )}
                    </span>
                  </div>
                );
              })}

              {/* "Something else" — transforms into input field when selected */}
              {currentSelection?.otherSelected ? (
                <div
                  ref={setOptionRef(currentQuestion.options.length)}
                  tabIndex={-1}
                  className={cn(styles.optionCard, styles.somethingElseCard, styles.optionCardSelected)}
                >
                  <SupplementalInput
                    key={`${currentQuestion.id}-other`}
                    sessionId={batch.sessionId}
                    questionId={currentQuestion.id}
                    textValue={currentSelection.freeText}
                    attachments={currentSelection.attachments}
                    onTextChange={handleOtherText}
                    onAttachmentsChange={handleAttachmentsChange}
                    placeholder="Type something else or upload a file..."
                    ariaLabel={`Custom answer for: ${currentQuestion.question}`}
                    disabled={isSubmitting}
                  />
                </div>
              ) : (
                <div
                  ref={setOptionRef(currentQuestion.options.length)}
                  role={currentQuestion.multiSelect ? 'checkbox' : 'radio'}
                  aria-checked={false}
                  tabIndex={0}
                  className={cn(styles.optionCard, styles.somethingElseCard)}
                  onClick={() => handleSomethingElseClick(currentQuestion.id)}
                >
                  <Pencil
                    size={14}
                    className={styles.somethingElseIcon}
                    aria-hidden="true"
                  />
                  <span className={styles.optionCardLabel}>
                    Something else
                  </span>
                </div>
              )}
            </div>
          ) : (
            <div className={styles.freeTextOnly}>
              <SupplementalInput
                key={`${currentQuestion.id}-free-text`}
                sessionId={batch.sessionId}
                questionId={currentQuestion.id}
                textValue={currentSelection?.freeText ?? ''}
                attachments={currentSelection?.attachments ?? []}
                onTextChange={handleOtherText}
                onAttachmentsChange={handleAttachmentsChange}
                placeholder={isApprovalClarification
                  ? 'Type the detail Rebel needs, or upload a file...'
                  : 'Type your answer or upload a file...'}
                ariaLabel={`Answer for: ${currentQuestion.question}`}
                disabled={isSubmitting}
              />
            </div>
          )}
        </div>
      </div>

      {/* Error */}
      {error && (
        <p
          className={styles.errorMessage}
          role="alert"
          id={`uq-error-${batch.batchId}`}
        >
          {error}
        </p>
      )}

      {/* Navigation */}
      <div className={styles.stepperNav}>
        <div className={styles.stepperNavLeft}>
          {currentQuestionIndex > 0 && (
            <Button
              variant="ghost"
              size="sm"
              onClick={handleBack}
              disabled={isSubmitting}
              className={styles.backButton}
              aria-label="Go back to previous question"
            >
              <ChevronLeft size={14} aria-hidden="true" />
              Back
            </Button>
          )}
          {!isApprovalClarification && !isSingleQuestionBatch && (
            <button
              type="button"
              className={styles.skipTextButton}
              onClick={handleQuestionSkip}
              disabled={isSubmitting}
            >
              Skip
            </button>
          )}
        </div>
        {showNextButton && (
          <Button
            variant="default"
            size="sm"
            disabled={!isNextEnabled || isSubmitting}
            onClick={() => {
              clearAutoAdvance();
              advanceToNext();
            }}
            className={styles.nextButton}
            aria-busy={isSubmitting}
            aria-label={
              isApprovalClarification && isLastQuestion
                ? 'Answer clarification'
                : isLastQuestion
                  ? 'Submit answers'
                  : 'Next question'
            }
          >
            {isSubmitting ? (
              'Submitting…'
            ) : isLastQuestion && !isApprovalClarification ? (
              <>
                Submit
                <Send size={14} aria-hidden="true" />
              </>
            ) : (
              <>
                Next
                <ChevronRight size={14} aria-hidden="true" />
              </>
            )}
          </Button>
        )}
      </div>
    </div>
  );
};

UserQuestionCardComponent.displayName = 'UserQuestionCard';
export const UserQuestionCard = memo(UserQuestionCardComponent);
