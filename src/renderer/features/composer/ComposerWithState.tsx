import {
  forwardRef,
  memo,
  useCallback,
  useDeferredValue,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type KeyboardEvent
} from 'react';
import { AgentComposer } from './AgentComposer';
import type { QueueMode } from '@renderer/features/agent-session/hooks/useMessageQueue';
import { useFileAttachments, type FileAttachment } from './hooks/useFileAttachments';
import {
  useMentionAutocomplete,
  findMentionTrigger,
  isCaretOnMentionChip,
  type MentionState,
} from './hooks/useMentionAutocomplete';
import { useDraftPersistence } from './hooks/useDraftPersistence';
import { MentionPopover } from './components/MentionPopover';
import { isComposerFlagEnabled } from './featureFlags';
import { getSessionStoreState } from '@renderer/features/agent-session/store';
import { debounce } from '@shared/utils/debounce';
import type { UnifiedMentionResult, MentionFilterType } from '@renderer/features/mentions';
import type { MentionedFileCandidate } from './types';
import type { FlatFileEntry } from '@renderer/utils/librarySearch';
import type { TipTapPromptEditorHandle } from './components/TipTapPromptEditor';
import type { ComposerWireMarkdown } from './utils/composerMarkdown';
import { mentionResultToAttrs } from './utils/mentionResultToAttrs';
import { resolveAltEnterSubmitMode } from './utils/resolveComposerSubmitMode';
import type { MarkdownToDocOptions } from './utils/promptDoc';
import {
  createMentionContextScheduler,
  type MentionContextScheduler,
} from './utils/mentionContextScheduler';

/** Debounce delay for syncing draft to store (ms) - only syncs after typing STOPS.
 * This prevents sidebar re-renders from blocking typing entirely.
 * Set to 1000ms so sidebar only updates after a pause in typing.
 * Trade-off: sidebar draft preview lags; max 1s data loss on crash (acceptable). */
const DRAFT_SYNC_DEBOUNCE_MS = 1000;

const EMPTY_MENTIONED_FILES: MentionedFileCandidate[] = [];
// Floor for the editor's intrinsic content height (line-height × 1 line ≈ 19px).
// Vertical chrome (field height) comes from the surrounding row's padding, set in CSS.
const COMPOSER_MIN_HEIGHT_PX = 19;
// Max height for ~10 lines: 10 lines × 19px (14px font × 1.35 line-height).
const COMPOSER_MAX_HEIGHT_PX = 190;
const MAX_ATTACHMENT_COUNT = 5;

const getComposerMaxHeight = (): number => {
  return COMPOSER_MAX_HEIGHT_PX;
};

export interface ComposerHandle {
  getText: () => string;
  flushDraft: () => void;
  /**
   * Replace the composer's text. The argument MUST be a `ComposerWireMarkdown`
   * value minted via `toComposerWireMarkdown()` (or another sanctioned producer).
   * The brand enforces — at the type level, once, structurally — that NBSP-
   * family corruption from external sources (legacy localStorage drafts,
   * persisted-session rehydrate, edit-rerun bodies from the pre-fix window) is
   * cleaned at the boundary instead of leaking into parent state and
   * resurfacing through specific keystroke sequences. See
   * `docs-private/investigations/260505_composer_nbsp_recurrence.md` Stage 2.
   */
  setText: (value: ComposerWireMarkdown) => void;
  /**
   * Insert text at the current cursor. The argument MUST be `ComposerWireMarkdown`
   * for the same external-ingress reason as `setText`.
   */
  insertAtCursor: (text: ComposerWireMarkdown) => void;
  clear: () => void;
  focus: () => void;
  getTextareaRef: () => HTMLTextAreaElement | null;
  getMentionState: () => MentionState;
  getAttachments: () => FileAttachment[];
  addImageAttachment: (payload: import('@shared/types').ImageAttachmentPayload) => boolean;
  clearMentionState: () => void;
}

export interface ComposerWithStateProps {
  sessionId: string;
  placeholder?: string; // Optional - if provided, overrides default placeholder logic
  isEditing: boolean;
  isBusy: boolean;
  isStopping: boolean;
  isTextPending: boolean;
  isPreparingMentionContext: boolean;
  processingTurnId: string | null;
  
  hasWorkspace: boolean;
  hasConversations: boolean;
  hasOperators?: boolean;
  onOpenOperatorsPanel?: () => void;
  resolveOperatorMention?: MarkdownToDocOptions['resolveOperatorMention'];
  mentionResultsForQuery: (query: string, filter?: MentionFilterType) => UnifiedMentionResult[];
  ensureLibraryIndex: () => void;
  getRelativeLibraryPath: (absolutePath: string) => string;
  
  // Function to resolve mentioned files from text (computed internally with useDeferredValue)
  resolveMentionedFiles: (text: string) => MentionedFileCandidate[];
  
  onSubmit: (mode?: QueueMode) => void | Promise<void>;
  onStopActiveTurn: () => Promise<void> | void;
  onCancelEdit?: () => void;
  onKeyDown: (event: KeyboardEvent<HTMLTextAreaElement>) => void;
  showToast: (options: { title: string }) => void;
  
  // Callback to notify parent when text changes (for edit hint logic)
  onHasTextChange?: (hasText: boolean) => void;
  // Callback when user types manually (clears voice source attribution)
  onUserTyping?: () => void;
  // Callback when composer receives focus (used for cache warming)
  onComposerFocus?: () => void;
  // Callback when @mention popover opens (App.tsx guards first-time logic)
  onMentionPopoverOpened?: () => void;
  
  isTranscribing: boolean;
  isTranscribeProcessing: boolean;
  onToggleTranscription: () => void;
  
  coreDirectory: string | null | undefined;
  libraryIndex: FlatFileEntry[] | null;
  libraryIndexLoading: boolean;
  libraryIndexError: string | null;
  refreshLibraryIndex: () => Promise<void>;
  agentSessionsCount: number;
  /** Callback to open the mind map canvas */
  onOpenCanvas?: () => void;
  /** Number of pending conversation annotations (shown in Send button label) */
  annotationCount?: number;
  /** Callback to send annotations + composer text as a combined message */
  onSendAnnotations?: () => void;
  /**
   * Forwarded to `AgentComposer.chromeMode`. Use `'embedded'` when the parent (e.g.
   * `InteractionStrip.inputContainer`) already draws the visible input chrome, otherwise leave the
   * default so the composer draws its own.
   */
  chromeMode?: 'standalone' | 'embedded';
}

const ComposerWithStateComponent = forwardRef<ComposerHandle, ComposerWithStateProps>(
  (props, ref) => {
    const {
      sessionId,
      placeholder: placeholderProp,
      isEditing,
      isBusy,
      isStopping,
      isTextPending,
      isPreparingMentionContext,
      processingTurnId,
      hasWorkspace,
      hasConversations,
      hasOperators = false,
      onOpenOperatorsPanel,
      resolveOperatorMention,
      mentionResultsForQuery,
      ensureLibraryIndex,
      getRelativeLibraryPath,
      resolveMentionedFiles,
      onSubmit,
      onStopActiveTurn,
      onCancelEdit,
      onKeyDown: externalKeyDown,
      showToast,
      onHasTextChange,
      onUserTyping,
      onComposerFocus,
      onMentionPopoverOpened,
      isTranscribing,
      isTranscribeProcessing,
      onToggleTranscription,
      coreDirectory,
      libraryIndex,
      libraryIndexLoading,
      libraryIndexError,
      refreshLibraryIndex,
      onOpenCanvas,
      annotationCount = 0,
      onSendAnnotations,
      chromeMode,
    } = props;

    const isRichInputEnabled = isComposerFlagEnabled('tiptap');

    // === CORE STATE (moved from App.tsx) ===
    const [textPrompt, setTextPrompt] = useState('');
    const [composerMaxHeight, setComposerMaxHeight] = useState(() => getComposerMaxHeight());
    const textareaRef = useRef<HTMLTextAreaElement>(null);
    const tiptapEditorRef = useRef<TipTapPromptEditorHandle | null>(null);
    const mentionCaretRef = useRef<number | null>(null);
    const suppressMentionRefreshRef = useRef(false);
    /**
     * Stage 4 of `docs/plans/260501_composer_tiptap_atmention_bugfix.md` —
     * H8 ownership fix. A single shared scheduler covers both
     * `handleTextPromptValue` and `refreshMentionFromInput`; the latest
     * schedule wins (cancel-and-reschedule) so duplicate work per
     * transaction is eliminated. The scheduler is constructed lazily
     * inside the `if (!schedulerRef.current)` guard below to keep the
     * dependency-injected callbacks on a stable identity.
     */
    const schedulerRef = useRef<MentionContextScheduler | null>(null);
    /** Picker-open snapshot for the scheduler's first-`@` fast-path. Updated below. */
    const pickerOpenRef = useRef(false);

    // Ref to access current textPrompt without closure dependencies
    const textPromptRef = useRef(textPrompt);
    useEffect(() => {
      textPromptRef.current = textPrompt;
    }, [textPrompt]);

    // Defer mention resolution to avoid blocking input during typing
    const deferredTextPrompt = useDeferredValue(textPrompt);
    const currentMentionedFiles = useMemo(() => {
      // Early return: skip expensive file resolution if no @ trigger present.
      // Returns stable empty array to avoid downstream re-renders from new reference.
      if (!deferredTextPrompt || !deferredTextPrompt.includes('@')) return EMPTY_MENTIONED_FILES;
      return resolveMentionedFiles(deferredTextPrompt);
    }, [resolveMentionedFiles, deferredTextPrompt]);

    // Notify parent when text presence changes (for edit hint logic in App)
    // Uses ref guard to only fire callback on actual transitions (empty↔non-empty),
    // not on every keystroke. This prevents unnecessary App.tsx re-renders.
    const hasTextRef = useRef(false);
    useEffect(() => {
      const hasText = textPrompt.trim().length > 0;
      if (hasText !== hasTextRef.current) {
        hasTextRef.current = hasText;
        onHasTextChange?.(hasText);
      }
    }, [textPrompt, onHasTextChange]);

    // Handle window resize for max height
    useLayoutEffect(() => {
      if (typeof window === 'undefined') return undefined;
      const handleResize = () => setComposerMaxHeight(getComposerMaxHeight());
      handleResize();
      window.addEventListener('resize', handleResize);
      return () => window.removeEventListener('resize', handleResize);
    }, []);

    // === FILE ATTACHMENTS ===
    const {
      attachments: fileAttachments,
      addFromClipboard,
      addFromFileList,
      addImageAttachment,
      removeAttachment,
      clearAttachments,
      canAddMore,
      isDragging,
      handleDragEnter,
      handleDragLeave,
      handleDragOver,
      handleDrop
    } = useFileAttachments({ onError: (msg) => showToast({ title: msg }) });

    // === MENTION AUTOCOMPLETE ===
    const hasModels = useMemo(
      () => mentionResultsForQuery('', 'models').length > 0,
      [mentionResultsForQuery]
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
      setManualFilter
    } = useMentionAutocomplete({
      isTextMode: true,
      hasWorkspace,
      setTextPrompt: (updater) => setTextPrompt(updater),
      commandInputRef: textareaRef,
      mentionCaretRef,
      mentionResultsForQuery,
      ensureLibraryIndex,
      getRelativeLibraryPath,
      hasConversations,
      hasModels,
      hasOperators,
      onMentionPopoverOpened,
      // Stage 1 of `docs/plans/260429_composer_rich_chips_input.md`: only the `command` mention
      // kind goes through the rich-input chip path. Other kinds (file/conversation/model) fall
      // back to the legacy markdown-string mutation in `useMentionAutocomplete` so users can keep
      // picking them in the meantime; Stage 2 promotes them to chips.
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

    // === STAGE 4 — SHARED MENTION-CONTEXT SCHEDULER ===
    // The scheduler is built once per component instance via a ref so the
    // returned callback identities stay stable across re-renders (the
    // factory's deps read from refs / live captures, so no re-construction
    // is needed). Both call sites (`handleTextPromptValue` and
    // `refreshMentionFromInput`) share this single scheduler instance.
    //
    // See `utils/mentionContextScheduler.ts` for the behaviour matrix.
    const updateMentionContextRef = useRef<(value: string, caret: number | null) => void>(
      () => {},
    );
    updateMentionContextRef.current = updateMentionContext;
    pickerOpenRef.current = mentionState.active;
    if (!schedulerRef.current) {
      schedulerRef.current = createMentionContextScheduler({
        onFire: (value, caret) => updateMentionContextRef.current(value, caret),
        isPickerOpen: () => pickerOpenRef.current,
        getEditor: () => tiptapEditorRef.current?.getEditor() ?? null,
        // Production: read `editor.view.composing` directly (the IME-state
        // source of truth). The factory's default already does this; we
        // pass nothing here so the default applies.
        isCaretOnChip: (editor) => isCaretOnMentionChip(editor),
        detectFreshTrigger: (value, caret) => findMentionTrigger(value, caret) !== null,
      });
    }

    // === DRAFT PERSISTENCE (legacy localStorage) ===
    // Note: useDraftPersistence is now primarily for migration - Stage 8 will handle full migration
    const { clearDraft } = useDraftPersistence(sessionId, textPrompt, setTextPrompt);

    // === DRAFT SYNC TO STORE (throttled for performance) ===
    // This syncs draft text to the session store for crash resilience and multi-draft support.
    // Local state (textPrompt) is kept for immediate UI responsiveness while store writes are throttled.

    // Create throttled draft setter that captures sessionId at call time (CRITICAL for correctness)
    // This ensures debounced calls write to the correct session even after session switch
    const debouncedSetDraftRef = useRef<ReturnType<typeof debounce<[string, string]>> | null>(null);

    // Initialize debounced function once (stable across renders)
    // Using debounce instead of throttle so draft only syncs AFTER typing stops,
    // preventing sidebar re-renders from blocking input during active typing.
    if (!debouncedSetDraftRef.current) {
      debouncedSetDraftRef.current = debounce(
        (capturedSessionId: string, text: string) => {
          getSessionStoreState().setDraftForSession(capturedSessionId, text);
        },
        DRAFT_SYNC_DEBOUNCE_MS
      );
    }

    // NOTE: Draft sync to store is triggered in handleTextPromptChange (not useEffect)
    // to capture sessionId at actual keystroke time, not effect execution time.

    // === TEXTAREA RESIZE ===
    // Stage 7 of `docs/plans/260501_composer_tiptap_atmention_bugfix.md` —
    // H13: scope limited to height/style mutation only — never editor content.
    // The autoresize shim mutates the textarea/wrapper element's `style.height`
    // and `style.overflowY` only. NO content mutations, NO transactions on the
    // editor. When `textareaRef` resolves to the `commandInputRef` shim
    // exposed by `TipTapPromptEditor`, `textarea.style` proxies to
    // `editor.view.dom.style` — so these writes target only the editor's DOM
    // chrome, not its document. The CSS-level `min-height` / `max-height` /
    // `overflow-y: auto` bounds in `TipTapPromptEditor.module.css` cap the
    // visual size; the JS path reconciles `scrollHeight` so the surface grows
    // and shrinks with content.
    const resizeComposerTextarea = useCallback(
      (target?: HTMLTextAreaElement | null) => {
        const textarea = target ?? textareaRef.current;
        if (!textarea) return;
        textarea.style.height = 'auto';
        const scrollHeight = textarea.scrollHeight;
        const boundedHeight = Math.min(
          Math.max(scrollHeight, COMPOSER_MIN_HEIGHT_PX),
          composerMaxHeight
        );
        textarea.style.height = `${boundedHeight}px`;
        textarea.style.overflowY = scrollHeight > composerMaxHeight ? 'auto' : 'hidden';
      },
      [composerMaxHeight]
    );

    // Load draft from store when session changes
    // Note: This coexists with useDraftPersistence (localStorage-based) until Stage 8 migration.
    // Store-based draft takes precedence if available; otherwise localStorage draft is used.
    useEffect(() => {
      // Flush any pending throttled writes from the previous session to ensure
      // the last keystrokes are saved before we switch. This is safe because the
      // throttled function captures sessionId at call time, so it writes to the
      // previous session's draft, not the new one.
      debouncedSetDraftRef.current?.flush();

      // Load draft from store if available. Note: useDraftPersistence (localStorage)
      // runs its restore effect BEFORE this one (due to hook declaration order), but
      // store-based draft takes precedence, so we overwrite here if store has a draft.
      const draft = getSessionStoreState().draftsBySessionId[sessionId];
      // Always set text - either to stored draft or empty string to prevent cross-session bleed.
      // If localStorage had a draft (restored by useDraftPersistence), store draft overwrites it.
      // If neither has a draft, this clears any leftover text from the previous session.
      const draftText = draft?.text ?? '';
      setTextPrompt(draftText);

      // Position cursor at end and scroll textarea to bottom so pre-filled drafts
      // (e.g. "Ask Rebel in New Chat" with conversation context) are ready to type.
      if (draftText) {
        requestAnimationFrame(() => {
          const textarea = textareaRef.current;
          if (textarea) {
            const len = draftText.length;
            textarea.setSelectionRange(len, len);
            textarea.focus();
            resizeComposerTextarea(textarea);
            textarea.scrollTop = textarea.scrollHeight;
          }
        });
      }
       
    // eslint-disable-next-line react-hooks/exhaustive-deps -- intentionally only depend on sessionId; adding resizeComposerTextarea would cause infinite loops
    }, [sessionId]);

    // Flush throttle on unmount to ensure pending writes complete.
    // Stage 4: also cancel any pending mention-context schedule so a stale
    // setTimeout callback can't fire after unmount.
    useEffect(() => {
      return () => {
        debouncedSetDraftRef.current?.flush();
        schedulerRef.current?.cancel();
      };
    }, []);

    // Auto-resize textarea when text changes, coalesced via rAF to reduce layout thrashing.
    // Uses scrollHeight-vs-clientHeight to avoid forced reflow on most keystrokes:
    // - scrollHeight > clientHeight → content overflows, grow cheaply (one read + one write)
    // - clientHeight > MIN_HEIGHT → might be oversized, do expensive reset-and-remeasure
    // - already at minimum height → nothing to do
    const resizeRafRef = useRef<number | null>(null);
    useEffect(() => {
      if (resizeRafRef.current !== null) {
        cancelAnimationFrame(resizeRafRef.current);
      }
      resizeRafRef.current = requestAnimationFrame(() => {
        resizeRafRef.current = null;
        const textarea = textareaRef.current;
        if (!textarea) return;

        const scrollHeight = textarea.scrollHeight;
        const clientHeight = textarea.clientHeight;

        if (scrollHeight > clientHeight) {
          // Content overflows -- grow without resetting height (avoids forced reflow)
          const boundedHeight = Math.min(
            Math.max(scrollHeight, COMPOSER_MIN_HEIGHT_PX),
            composerMaxHeight
          );
          textarea.style.height = `${boundedHeight}px`;
          textarea.style.overflowY = scrollHeight > composerMaxHeight ? 'auto' : 'hidden';
        } else if (clientHeight > COMPOSER_MIN_HEIGHT_PX) {
          // Might be oversized -- reset to auto and re-measure (expensive but necessary)
          resizeComposerTextarea(textarea);
        }
        // else: already at minimum height, nothing to do
      });
      return () => {
        if (resizeRafRef.current !== null) {
          cancelAnimationFrame(resizeRafRef.current);
        }
      };
    }, [textPrompt, composerMaxHeight, resizeComposerTextarea]);

    // === IMPERATIVE HANDLE ===
    // Use refs for frequently-changing values to avoid recreating the handle
    const mentionStateRef = useRef(mentionState);
    mentionStateRef.current = mentionState;
    const fileAttachmentsRef = useRef(fileAttachments);
    fileAttachmentsRef.current = fileAttachments;

    useImperativeHandle(ref, () => ({
      getText: () => textPromptRef.current,
      flushDraft: () => {
        debouncedSetDraftRef.current?.flush();
      },

      setText: (value: ComposerWireMarkdown) => {
        setTextPrompt(value);
        clearMentionState();
        requestAnimationFrame(() => {
          const textarea = textareaRef.current;
          if (textarea) {
            textarea.focus();
            const len = value.length;
            textarea.setSelectionRange(len, len);
            resizeComposerTextarea(textarea);
          }
        });
      },

      insertAtCursor: (text: ComposerWireMarkdown) => {
        const textarea = textareaRef.current;
        const currentText = textPromptRef.current;
        const cursorPos = textarea?.selectionStart ?? currentText.length;
        const before = currentText.slice(0, cursorPos);
        const after = currentText.slice(cursorPos);
        const newText = before + text + after;
        const newCursorPos = cursorPos + text.length;

        setTextPrompt(newText);
        // Sync to store draft so inserted text persists on session switch
        debouncedSetDraftRef.current?.(sessionId, newText);
        requestAnimationFrame(() => {
          if (textarea) {
            textarea.setSelectionRange(newCursorPos, newCursorPos);
            textarea.focus();
          }
        });
      },

      clear: () => {
        // Cancel any pending throttled draft writes to prevent race conditions
        // where a trailing write could restore old text after clearing
        debouncedSetDraftRef.current?.cancel();
        // NOTE: We do NOT clear the store draft here. Store draft lifecycle is managed by:
        // - addUserMessage() clears draft atomically when message is sent
        // - softDeleteSession() clears draft when session is deleted
        // - resetSession() preserves draft in snapshot for crash resilience
        // Clearing store draft here caused bugs when clear() was called during session
        // switching with a stale sessionId closure (see draft loss bug fix).
        setTextPrompt('');
        clearMentionState();
        clearAttachments();
        clearDraft(); // localStorage (legacy)
      },

      focus: () => {
        requestAnimationFrame(() => {
          const textarea = textareaRef.current;
          if (textarea) {
            textarea.focus();
            const len = textarea.value.length;
            textarea.setSelectionRange(len, len);
          }
        });
      },

      getTextareaRef: () => textareaRef.current,
      getMentionState: () => mentionStateRef.current,
      getAttachments: () => fileAttachmentsRef.current,
      addImageAttachment,
      clearMentionState
    // Note: textPrompt, mentionState, fileAttachments accessed via refs to avoid recreating handle on every change
    }), [sessionId, addImageAttachment, clearMentionState, clearAttachments, clearDraft, resizeComposerTextarea]);

    // === EVENT HANDLERS ===
    const handleTextPromptValue = useCallback(
      (value: string, selectionStart: number | null) => {
        // Capture sessionId at actual keystroke time (CRITICAL for correctness)
        // This ensures trailing throttled calls write to the correct session even after session switch
        const sessionIdAtKeystroke = sessionId;
        setTextPrompt(value);
        // Notify parent that user is typing manually (clears voice source attribution)
        onUserTyping?.();
        // Sync to store - captures sessionId at keystroke time to prevent cross-session corruption.
        // When clearing the draft (text becomes empty), bypass debounce and sync immediately.
        // This prevents a race where snapshotCurrentSession() captures a stale draft
        // if the user navigates away within the debounce window (see draft reappearance bug).
        if (!value.trim()) {
          debouncedSetDraftRef.current?.cancel();
          getSessionStoreState().setDraftForSession(sessionIdAtKeystroke, value);
        } else {
          debouncedSetDraftRef.current?.(sessionIdAtKeystroke, value);
        }

        // Skip mention processing entirely when no @ trigger present (perf optimization)
        // This eliminates all mention-related work during normal typing (the common case)
        if (!value.includes('@')) {
          schedulerRef.current?.cancel();
          clearMentionState();
          return;
        }

        // Stage 4: shared parent-layer scheduler (IME-aware debounce + first-`@`
        // fast-path + caret-on-chip exclusion). One timer covers both this
        // call site and `refreshMentionFromInput` so duplicate work per
        // transaction is eliminated.
        schedulerRef.current?.schedule(value, selectionStart ?? value.length);
      },
      [sessionId, onUserTyping, clearMentionState]
    );

    const handleTextPromptChange = useCallback(
      (event: ChangeEvent<HTMLTextAreaElement>) => {
        handleTextPromptValue(event.target.value, event.target.selectionStart);
      },
      [handleTextPromptValue]
    );

    const replaceTextPrompt = useCallback(
      (value: string) => {
        const sessionIdAtChange = sessionId;
        setTextPrompt(value);
        onUserTyping?.();

        if (!value.trim()) {
          debouncedSetDraftRef.current?.cancel();
          getSessionStoreState().setDraftForSession(sessionIdAtChange, value);
        } else {
          debouncedSetDraftRef.current?.(sessionIdAtChange, value);
        }

        schedulerRef.current?.cancel();
        clearMentionState();
        requestAnimationFrame(() => resizeComposerTextarea(textareaRef.current));
      },
      [clearMentionState, onUserTyping, resizeComposerTextarea, sessionId]
    );

    const refreshMentionFromInput = useCallback(
      (value: string, caretPosition: number | null) => {
        if (suppressMentionRefreshRef.current) {
          return;
        }
        // Stage 4: route through the shared parent-layer scheduler so
        // selection-only transactions and text-changing transactions share
        // a single debounce timer. The scheduler internally handles IME
        // deferral, caret-on-chip suppression, and the first-`@` fast-path.
        schedulerRef.current?.schedule(value, caretPosition ?? value.length);
      },
      []
    );

    /**
     * Stage 4: invoked by `TipTapPromptEditor`'s `compositionend` listener.
     * Forces a flush of the scheduler's IME-deferred state so the picker
     * opens shortly after composition commits, even when no subsequent
     * `onUpdate` fires (the compose-and-pause sequence).
     */
    const flushDeferredMentionContext = useCallback(() => {
      schedulerRef.current?.flushDeferred();
    }, []);

    // Wrap onSubmit to trigger annotation send when annotations are pending
    const annotationAwareSubmit = useCallback((mode?: QueueMode) => {
      if (annotationCount > 0 && onSendAnnotations) {
        onSendAnnotations();
        return;
      }
      return onSubmit(mode);
    }, [annotationCount, onSendAnnotations, onSubmit]);

    const handleKeyDown = useCallback(
      (event: KeyboardEvent<HTMLTextAreaElement>) => {
        // Handle mention navigation first
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
            clearMentionState();
            return;
          }
        }

        // Alt/Option+Enter while busy = queue (same as the default Enter behavior).
        // This used to force send-now+interrupt, but that re-introduced exactly the
        // accidental-supersede footgun resolveComposerSubmitMode guards against
        // (silently superseding the active turn from the keyboard). Per the
        // 2026-06-06 product decision the keyboard always queues while busy;
        // send-now stays reachable via the explicit secondary button.
        const isAltEnter = event.altKey && !event.shiftKey && !event.metaKey && !event.ctrlKey && event.key === 'Enter';
        if (isAltEnter) {
          const altEnterMode = resolveAltEnterSubmitMode({ isBusy, hasText: !!textPromptRef.current.trim() });
          if (altEnterMode) {
            event.preventDefault();
            void annotationAwareSubmit(altEnterMode);
            return;
          }
        }

        // Intercept Enter to send annotations + text before the external handler
        // Skip when transcribing — Enter should stop recording first (handled by external handler)
        if (annotationCount > 0 && onSendAnnotations && !isTranscribing && event.key === 'Enter' && !event.shiftKey && !event.altKey) {
          event.preventDefault();
          onSendAnnotations();
          return;
        }

        // Delegate to external handler for submit, edit shortcuts, etc.
        externalKeyDown(event);
      },
      [
        mentionState,
        navigateMentionDown,
        navigateMentionUp,
        selectCurrentMention,
        clearMentionState,
        isBusy,
        isTranscribing,
        annotationAwareSubmit,
        annotationCount,
        onSendAnnotations,
        externalKeyDown
      ]
    );

    const handlePaste = useCallback(
      async (clipboardData: DataTransfer) => {
        return addFromClipboard(clipboardData);
      },
      [addFromClipboard]
    );

    // === MENTION POPOVER ===
    // Wrap setManualFilter to cancel pending debounced updateMentionContext calls
    // AND pass fresh query from textarea. This prevents two race conditions:
    // 1. Stale debounced update overwriting new filter results
    // 2. Filter change using stale query from debounced mentionState
    const handleFilterChange = useCallback(
      (filter: MentionFilterType) => {
        // Cancel any pending debounced mention-context update so the
        // filter change isn't immediately overwritten by stale results.
        schedulerRef.current?.cancel();
        // Compute fresh query from current textarea state
        const value = textPromptRef.current;
        const caret = mentionCaretRef.current ?? value.length;
        findMentionTrigger(value, caret);
        setManualFilter(filter);
      },
      [setManualFilter]
    );

    const showModelsTab = hasModels;

    const mentionPopoverContent = useMemo(() => {
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
          hasOperators={hasOperators}
          onOpenOperatorsPanel={onOpenOperatorsPanel}
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
      hasOperators,
      onOpenOperatorsPanel,
      showModelsTab,
      handleFilterChange,
    ]);

    // === COMPUTED VALUES ===
    // Use placeholder prop if provided, otherwise fall back to default logic
    const placeholder = placeholderProp ?? (isEditing
      ? 'Edit your message'
      : 'Ask Rebel, or type @ to add context');
    const hasAnnotations = annotationCount > 0;
    const primaryButtonDisabled = (!hasAnnotations && textPrompt.trim().length === 0) || isStopping || isTextPending || isPreparingMentionContext;

    return (
      <AgentComposer
        commandInputRef={textareaRef as React.RefObject<HTMLTextAreaElement>}
        textPrompt={textPrompt}
        placeholder={placeholder}
        isEditing={isEditing}
        isBusy={isBusy}
        isStopping={isStopping}
        isTextPending={isTextPending}
        isPreparingMentionContext={isPreparingMentionContext}
        mentionPopoverContent={mentionPopoverContent}
        currentMentionedFiles={currentMentionedFiles}
        maxAttachmentCount={MAX_ATTACHMENT_COUNT}
        primaryButtonDisabled={primaryButtonDisabled}
        processingTurnId={processingTurnId}
        onStopActiveTurn={onStopActiveTurn}
        onCancelEdit={onCancelEdit}
        isTranscribing={isTranscribing}
        isTranscribeProcessing={isTranscribeProcessing}
        onToggleTranscription={onToggleTranscription}
        hideInternalMic={true}
        onChange={handleTextPromptChange}
        onChangeValue={handleTextPromptValue}
        onReplaceTextPrompt={replaceTextPrompt}
        onKeyDown={handleKeyDown}
        onSubmit={annotationAwareSubmit}
        onRefreshMentionContext={refreshMentionFromInput}
        onCompositionEnd={flushDeferredMentionContext}
        onComposerFocus={onComposerFocus}
        attachments={fileAttachments}
        onRemoveAttachment={removeAttachment}
        onPasteFile={handlePaste}
        onSelectFiles={addFromFileList}
        isDragging={isDragging}
        onDragEnter={handleDragEnter}
        onDragLeave={handleDragLeave}
        onDragOver={handleDragOver}
        onDrop={handleDrop}
        maxAttachments={MAX_ATTACHMENT_COUNT}
        canAddMore={canAddMore}
        onOpenCanvas={onOpenCanvas}
        annotationCount={annotationCount}
        chromeMode={chromeMode}
        tiptapEditorRef={isRichInputEnabled ? tiptapEditorRef : undefined}
        resolveOperatorMention={resolveOperatorMention}
      />
    );
  }
);

ComposerWithStateComponent.displayName = 'ComposerWithState';

export const ComposerWithState = memo(ComposerWithStateComponent);
