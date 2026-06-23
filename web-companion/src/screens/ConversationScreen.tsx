// web-companion/src/screens/ConversationScreen.tsx

import { useEffect, useEffectEvent, useCallback, useRef, useState, useMemo, type MouseEvent as ReactMouseEvent } from 'react';
import { useParams, useSearchParams, useNavigate } from 'react-router-dom';
import {
  useAuthStore,
  useSessionStore,
  useAgentTurn,
  useWebVoiceRecording,
  useWebFileAttachments,
  getSettings,
  createShareLink,
  getShareStatus,
  revokeShareLink,
  COUNCIL_REVIEW_PROMPT,
  isCouncilReviewAvailable,
  buildToolLabel,
  createMarkdownLinkHandler,
  type SessionMessage,
  type WebFileAttachment,
} from '@rebel/cloud-client';
import {
  ArrowLeftIcon,
  CheckCircleIcon,
  SendIcon,
  SquareIcon,
  ChevronDownIcon,
  LinkIcon,
  LoaderIcon,
  MicIcon,
  PaperclipIcon,
  XIcon,
  FileIcon,
  FileTextIcon,
  ImageIcon,
  KeyboardIcon,
  UsersIcon,
} from '../components/icons';
import { AgentActivityBubble } from '../components/AgentActivityBubble';
import { TurnToolActivity } from '../components/TurnToolActivity';
import { ConversationApprovalBanner } from '../components/ConversationApprovalBanner';
import { SafeWebMarkdown } from '../components/SafeWebMarkdown';
import { planConversationRouteSync } from './conversationRouteSync';
import styles from './ConversationScreen.module.css';
import { fireAndForget } from '../utils/fireAndForget';

const TOOL_STATUS_PATTERN = /^Using\s+(.+?)\.\.\.$/i;

// Module-level constant so SafeWebMarkdown's urlTransform useMemo gets a stable
// identity across renders. Preserves rebel:// anchor hrefs long enough for
// `handleLinkClick` (passed to SafeWebMarkdown via `onAnchorClick`) to route
// conversation/library/navigation clicks. See F4 amendment in
// docs/plans/260422_i10_followups_STAGED_PLAN.md (Stage 2) and the closed-API
// migration in docs/plans/260427_r1_stage2b_factory_refactor.md (Stage B).
const PRESERVE_REBEL_SCHEMES = ['rebel://'] as const;

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function MessageBubble({
  message,
  onAnchorClick,
}: {
  message: SessionMessage;
  onAnchorClick?: (event: ReactMouseEvent<HTMLAnchorElement>) => void;
}) {
  const isUser = message.role === 'user';
  if (message.isHidden) return null;

  return (
    <div
      className={`${styles.messageRow} ${isUser ? styles.userRow : styles.assistantRow}`}
      data-testid={isUser ? 'user-message' : 'assistant-message'}
    >
      <div className={`${styles.bubble} ${isUser ? styles.userBubble : styles.assistantBubble}`}>
        {isUser ? (
          <p className={styles.bubbleText}>{message.text}</p>
        ) : (
          <div className={styles.markdown}>
            <SafeWebMarkdown
              preserveSchemes={PRESERVE_REBEL_SCHEMES}
              onAnchorClick={onAnchorClick}
              anchorTarget="_blank"
            >
              {message.text}
            </SafeWebMarkdown>
          </div>
        )}
      </div>
      <span className={styles.messageTime}>
        {new Date(message.createdAt).toLocaleTimeString(undefined, {
          hour: '2-digit',
          minute: '2-digit',
        })}
      </span>
    </div>
  );
}

function AttachmentThumbnail({
  attachment,
  onRemove,
}: {
  attachment: WebFileAttachment;
  onRemove: (id: string) => void;
}) {
  const preview = useMemo(() => {
    if (attachment.type === 'image') {
      return `data:${attachment.mimeType};base64,${attachment.base64Data}`;
    }
    return null;
  }, [attachment]);

  const label = useMemo(() => {
    if (attachment.type === 'document') return 'PDF';
    if (attachment.type === 'textfile') {
      const ext = attachment.name.split('.').pop()?.toUpperCase();
      return ext || 'TXT';
    }
    return null;
  }, [attachment]);

  const ThumbnailIcon = attachment.type === 'document'
    ? FileIcon
    : attachment.type === 'textfile'
      ? FileTextIcon
      : ImageIcon;

  return (
    <div className={styles.thumbnail} title={attachment.name}>
      {preview ? (
        <img src={preview} alt={attachment.name} className={styles.thumbnailImage} draggable={false} />
      ) : (
        <div className={styles.thumbnailFile}>
          <ThumbnailIcon size={18} />
          {label && <span className={styles.thumbnailLabel}>{label}</span>}
        </div>
      )}
      <button
        type="button"
        className={styles.thumbnailRemove}
        onClick={() => onRemove(attachment.id)}
        aria-label={`Remove ${attachment.name}`}
      >
        <XIcon size={10} />
      </button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main screen
// ---------------------------------------------------------------------------

export function ConversationScreen() {
  const { id } = useParams<{ id: string }>();
  const [searchParams] = useSearchParams();
  const initialPrompt = searchParams.get('initialPrompt') ?? undefined;
  const composeMode = searchParams.get('compose');
  const navigate = useNavigate();
  const cloudUrl = useAuthStore((s) => s.cloudUrl);

  const currentSession = useSessionStore((s) => s.currentSession);
  const isLoadingSession = useSessionStore((s) => s.isLoadingSession);
  const sessionError = useSessionStore((s) => s.error);
  const completedStepsByTurnId = useSessionStore((s) => s.completedStepsByTurnId);

  const [input, setInput] = useState('');
  const [showScrollButton, setShowScrollButton] = useState(false);
  const [attachmentError, setAttachmentError] = useState<string | null>(null);
  const [isTextMode, setIsTextMode] = useState(false);
  const [shareState, setShareState] = useState<'idle' | 'loading' | 'copied'>('idle');
  const [toast, setToast] = useState<string | null>(null);

  // Refs — declared before any effect/callback that closes over them.
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const messagesContainerRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const toastTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => {
    if (isTextMode) {
      textareaRef.current?.focus();
    }
  }, [isTextMode]);

  useEffect(() => () => clearTimeout(toastTimerRef.current), []);

  const {
    isSending, streamingText, statusText, activeTurnId, optimisticMessages,
    completedSteps, thinkingHeadline,
    startTurn, handleStop, closeSocket,
  } = useAgentTurn();

  // File attachments
  const {
    attachments, addFiles, removeAttachment, clearAttachments, canAddMore,
    isDragging, dragHandlers,
  } = useWebFileAttachments({
    onError: (msg) => {
      setAttachmentError(msg);
      setTimeout(() => setAttachmentError(null), 4000);
    },
  });

  // Voice recording — transcript auto-submits as a turn
  const handleVoiceTranscript = useCallback(
    (transcript: string) => {
      if (!id) return;
      startTurn(id, transcript);
    },
    [id, startTurn],
  );

  const {
    isRecording, isTranscribing, audioLevel, error: voiceError, toggleRecording,
  } = useWebVoiceRecording(handleVoiceTranscript, id);

  // Council review availability (fetched once on mount)
  const [councilAvailable, setCouncilAvailable] = useState(false);
  useEffect(() => {
    let cancelled = false;
    // Best-effort — if settings fetch fails, leave the council-review button
    // disabled (degraded user-visible state). fireAndForget preserves the
    // best-effort semantics while surfacing the cause in DevTools.
    fireAndForget(
      getSettings().then((s) => {
        if (!cancelled) setCouncilAvailable(isCouncilReviewAvailable(s as Record<string, unknown>));
      }),
      'ConversationScreen:mount:getSettings',
    );
    return () => { cancelled = true; };
  }, []);

  const handleCouncilReview = useCallback(() => {
    if (!id || isSending) return;
    startTurn(id, COUNCIL_REVIEW_PROMPT, undefined, { councilMode: true });
  }, [id, isSending, startTurn]);

  const showToast = useCallback((message: string) => {
    setToast(message);
    clearTimeout(toastTimerRef.current);
    toastTimerRef.current = setTimeout(() => setToast(null), 2000);
  }, []);

  // Route library:// / rebel:// / file:// taps through the shared dispatcher.
  // Web-companion can meaningfully open conversation links (same router); other
  // schemes are out of reach here (no file system, no desktop shell) so we
  // surface a consistent toast instead of letting the browser try to navigate
  // to "library://foo" and silently fail. http(s) links are not intercepted
  // and use the browser's default handling (new tab via target=_blank).
  const linkDispatcher = useMemo(() => createMarkdownLinkHandler({
    onOpenFile: () => showToast('Open this link in the Rebel desktop app.'),
    onOpenImage: () => showToast('Open this link in the Rebel desktop app.'),
    onOpenFolder: () => showToast('Open this link in the Rebel desktop app.'),
    onOpenConversation: (sessionId) => {
      fireAndForget(navigate(`/conversations/${sessionId}`), 'ConversationScreen:linkHandler:navigate');
    },
    onNavigate: () => showToast('Open this link in the Rebel app.'),
    onOpenTutorial: () => showToast('Tutorials are only available in the Rebel desktop app.'),
    onBlocked: (_url, reason) => {
      switch (reason) {
        case 'invalid-rebel-url':
          showToast("That link doesn't look right.");
          break;
        case 'empty-path':
          showToast("That link doesn't point to anything.");
          break;
        case 'invalid-tutorial':
          showToast("That tutorial link doesn't look right.");
          break;
        case 'platform-unsupported':
          showToast('Open this link in the Rebel app.');
          break;
        // protocol-relative / unknown-scheme: silent — browser handles them fine.
        default:
          break;
      }
    },
  }), [navigate, showToast]);

  const handleLinkClick = useCallback((event: ReactMouseEvent<HTMLAnchorElement>) => {
    const href = event.currentTarget.getAttribute('href');
    if (!href) return;
    // http(s) and mailto etc. are not handled by our dispatcher — let the browser run.
    const lower = href.toLowerCase();
    const isAppScheme =
      lower.startsWith('library://') ||
      lower.startsWith('workspace://') ||
      lower.startsWith('rebel://') ||
      lower.startsWith('file://');
    if (!isAppScheme) return;
    event.preventDefault();
    linkDispatcher(href);
  }, [linkDispatcher]);

  // R1 Stage 2b (2026-04-27): the previous `markdownComponents` useMemo was
  // replaced by SafeWebMarkdown's typed escape hatches:
  // - `onAnchorClick={handleLinkClick}` for click dispatch (rebel://, library://, etc.)
  // - `anchorTarget="_blank"` for new-tab UX
  // The wrapper now renders the underlying <a> with target/rel applied.
  // See `docs/plans/260427_r1_stage2b_factory_refactor.md` Stage B.

  const handleShareConversation = useCallback(async () => {
    if (!currentSession?.id || shareState === 'loading') return;

    setShareState('loading');

    let shareId = '';

    try {
      const currentShare = await getShareStatus(currentSession.id);
      shareId = currentShare?.shareId?.trim() ?? '';

      if (!shareId) {
        if (currentShare) {
          await revokeShareLink(currentSession.id);
        }

        const createdShare = await createShareLink(currentSession.id);
        shareId = createdShare.shareId;
      }
    } catch {
      setShareState('idle');
      showToast('Failed to create share link');
      return;
    }

    if (!shareId) {
      setShareState('idle');
      showToast('Failed to create share link');
      return;
    }

    const baseUrl = (cloudUrl ?? window.location.origin).replace(/\/+$/, '');
    const shareUrl = `${baseUrl}/app/shared/${encodeURIComponent(shareId)}`;

    try {
      if (!navigator.clipboard?.writeText) {
        throw new Error('Clipboard unavailable');
      }

      await navigator.clipboard.writeText(shareUrl);
      setShareState('copied');
      showToast('Link copied');
    } catch {
      setShareState('idle');
      showToast('Failed to copy link');
    }
  }, [cloudUrl, currentSession?.id, shareState, showToast]);

  useEffect(() => {
    if (shareState !== 'copied') return;

    const timer = setTimeout(() => setShareState('idle'), 1600);
    return () => clearTimeout(timer);
  }, [shareState]);

  // Auto-clear attachment error
  useEffect(() => {
    if (!attachmentError) return;
    const timer = setTimeout(() => setAttachmentError(null), 4000);
    return () => clearTimeout(timer);
  }, [attachmentError]);

  const isNearBottomRef = useRef(true);

  const handleScroll = useCallback(() => {
    const el = messagesContainerRef.current;
    if (!el) return;
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    isNearBottomRef.current = distanceFromBottom < 100;
    setShowScrollButton(distanceFromBottom > 200);
  }, []);

  const scrollToBottom = useCallback((force = false) => {
    if (force || isNearBottomRef.current) {
      messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
    }
  }, []);

  const handleInputChange = useCallback((e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setInput(e.target.value);
    const el = e.target;
    el.style.height = 'auto';
    el.style.height = Math.min(el.scrollHeight, 120) + 'px';
  }, []);

  // Tracks which conversation id the auto-send initialPrompt fired for.
  // Previously a plain boolean `initialSentRef`, which wasn't reset across
  // route changes — if the user navigated from one `?initialPrompt=` URL to
  // another, the second auto-send would silently skip. Scoping to
  // `conversationId` fixes that latent bug (discovered during I10 follow-up
  // Q3 review; see AMD-8 in docs/plans/260422_i10_followups_STAGED_PLAN.md).
  const initialSentForIdRef = useRef<string | null>(null);

  // Non-reactive callbacks for the id-keyed lifecycle effect below. Wrapping
  // them with useEffectEvent lets the effect stay keyed to `[id]` while still
  // reading the latest `initialPrompt`, `composeMode`, `startTurn`, and
  // `closeSocket` without making them reactive — canonical React 19 pattern
  // for "run on X change, but read latest callbacks/state". Eliminates the
  // previous exhaustive-deps suppression without changing lifecycle behavior.
  // Decision logic lives in `planConversationRouteSync` (pure helper; unit
  // tested in `__tests__/conversationRouteSync.test.ts`) so this callback is
  // reduced to dispatch-by-kind.
  const syncConversationForRoute = useEffectEvent((conversationId: string) => {
    const plan = planConversationRouteSync({
      id: conversationId,
      initialPrompt,
      composeMode,
      lastSentForId: initialSentForIdRef.current,
    });

    switch (plan.kind) {
      case 'send':
        initialSentForIdRef.current = plan.nextSentForId;
        startTurn(plan.id, plan.prompt);
        return;
      case 'noop-already-sent':
        return;
      case 'compose-text':
        initialSentForIdRef.current = plan.nextSentForId;
        setIsTextMode(true);
        return;
      case 'fetch':
        initialSentForIdRef.current = plan.nextSentForId;
        fireAndForget(useSessionStore.getState().fetchSession(plan.id), 'ConversationScreen:routeSync:fetchSession');
        return;
    }
  });

  const cleanupConversationForRoute = useEffectEvent(() => {
    useSessionStore.getState().clearCurrentSession();
    closeSocket();
  });

  useEffect(() => {
    if (!id) return;
    syncConversationForRoute(id);
    return () => {
      cleanupConversationForRoute();
    };
  }, [id]);

  useEffect(() => {
    scrollToBottom();
  }, [optimisticMessages, streamingText, statusText, currentSession?.messages?.length, scrollToBottom]);

  const handleSend = useCallback(() => {
    if (!input.trim() || !id || isSending) return;
    const prompt = input.trim();
    setInput('');
    if (textareaRef.current) textareaRef.current.style.height = 'auto';

    const atts = attachments.length > 0 ? [...attachments] : undefined;
    clearAttachments();
    startTurn(id, prompt, atts);
  }, [input, id, isSending, startTurn, attachments, clearAttachments]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Enter' && !e.shiftKey && input.trim() && !isSending) {
        e.preventDefault();
        handleSend();
      }
    },
    [handleSend, input, isSending],
  );

  const onStop = useCallback(() => {
    const turnId = activeTurnId || currentSession?.activeTurnId;
    if (turnId) handleStop();
  }, [activeTurnId, currentSession?.activeTurnId, handleStop]);

  const openFilePicker = useCallback(() => {
    fileInputRef.current?.click();
  }, []);

  const handleFileSelected = useCallback(
    async (e: React.ChangeEvent<HTMLInputElement>) => {
      const files = e.target.files;
      if (files && files.length > 0) {
        await addFiles(files);
      }
      // Reset input so the same file can be selected again
      if (fileInputRef.current) fileInputRef.current.value = '';
    },
    [addFiles],
  );

  const serverMessages = useMemo(
    () => currentSession?.messages.filter((m) => !m.isHidden) ?? [],
    [currentSession?.messages],
  );
  const allMessages = useMemo(
    () =>
      optimisticMessages.length > 0
        ? [...serverMessages, ...optimisticMessages]
        : serverMessages,
    [serverMessages, optimisticMessages],
  );
  const lastAssistantMessageIdByTurnId = useMemo(() => {
    const map: Record<string, string> = {};

    allMessages.forEach((message) => {
      if ((message.role === 'assistant' || message.role === 'result') && message.turnId) {
        map[message.turnId] = message.id;
      }
    });

    return map;
  }, [allMessages]);

  const isBusy = isSending || currentSession?.isBusy;
  const hasActiveContent = isSending || optimisticMessages.length > 0 || streamingText.length > 0;

  const canRequestCouncilReview = useMemo(() => {
    if (isBusy || !councilAvailable) return false;
    const hasAssistantMessage = allMessages.some((m) => m.role === 'assistant' || m.role === 'result');
    if (!hasAssistantMessage) return false;
    const lastUserMsg = [...allMessages].reverse().find((m) => m.role === 'user');
    if (lastUserMsg?.text === COUNCIL_REVIEW_PROMPT) return false;
    return true;
  }, [isBusy, councilAvailable, allMessages]);
  const toolUsageStatus = useMemo(() => {
    const match = TOOL_STATUS_PATTERN.exec(statusText?.trim() ?? '');
    const toolName = match?.[1]?.trim();
    if (!toolName) return null;
    return buildToolLabel(toolName).label;
  }, [statusText]);
  const showActivityBubble = isSending && !streamingText && (
    completedSteps.length > 0 || Boolean(toolUsageStatus)
  );
  const hasText = input.trim().length > 0;
  const hasAttachments = attachments.length > 0;
  const isVoiceBusy = isRecording || isTranscribing;

  // Determine primary action button
  const showSendButton = hasText || hasAttachments;
  const showMicButton = !showSendButton && !isBusy && !isVoiceBusy;
  const showRecordingButton = isRecording;
  const showTranscribingIndicator = isTranscribing;
  const canShareConversation = Boolean(currentSession?.id);

  return (
    <div
      className={styles.container}
      {...dragHandlers}
    >
      {/* Top bar */}
      <div className={styles.topBar}>
        <button
          className={styles.backButton}
          onClick={() => navigate('/conversations')}
          aria-label="Back"
        >
          <ArrowLeftIcon size={20} />
        </button>
        <span className={styles.topTitle}>
          {currentSession?.title || 'New conversation'}
        </span>
        {canShareConversation && (
          <button
            type="button"
            className={`${styles.shareButton} ${shareState === 'copied' ? styles.shareButtonCopied : ''}`}
            onClick={handleShareConversation}
            disabled={shareState === 'loading'}
            aria-label={shareState === 'copied' ? 'Link copied' : 'Share conversation'}
            title={shareState === 'copied' ? 'Link copied' : 'Share conversation'}
          >
            {shareState === 'loading' ? (
              <LoaderIcon size={14} className={styles.shareLoadingIcon} />
            ) : shareState === 'copied' ? (
              <CheckCircleIcon size={16} />
            ) : (
              <LinkIcon size={16} />
            )}
          </button>
        )}
      </div>

      {/* Loading / Error */}
      {isLoadingSession && !currentSession && !hasActiveContent ? (
        <div className={styles.centered}>
          <div className="loading-spinner" />
        </div>
      ) : sessionError && !currentSession && !hasActiveContent ? (
        <div className={styles.centered}>
          <p className={styles.errorText}>{sessionError}</p>
          <button
            className={styles.retryButton}
            onClick={() => id && useSessionStore.getState().fetchSession(id)}
          >
            Retry
          </button>
        </div>
      ) : (
        <>
          {/* Messages */}
          <div className={styles.messages} ref={messagesContainerRef} onScroll={handleScroll}>
            {allMessages.length === 0 && !isSending && (
              <div className={styles.centered}>
                <p className={styles.emptyText}>No messages yet. What&apos;s on your mind?</p>
              </div>
            )}

            {allMessages.map((msg) => {
              const isTurnTailMessage =
                (msg.role === 'assistant' || msg.role === 'result')
                && Boolean(msg.turnId)
                && lastAssistantMessageIdByTurnId[msg.turnId] === msg.id;

              const turnEvents = isTurnTailMessage && msg.turnId
                ? currentSession?.toolEventsByTurn?.[msg.turnId]
                : undefined;

              const fallbackSteps = isTurnTailMessage && msg.turnId
                ? completedStepsByTurnId[msg.turnId]
                : undefined;

              return (
                <div key={msg.id} className={styles.messageWithToolActivity}>
                  <MessageBubble message={msg} onAnchorClick={handleLinkClick} />
                  {isTurnTailMessage && msg.turnId ? (
                    <TurnToolActivity
                      turnId={msg.turnId}
                      events={turnEvents}
                      fallbackSteps={fallbackSteps}
                      owningSessionId={id}
                    />
                  ) : null}
                </div>
              );
            })}

            {showActivityBubble && (
              <AgentActivityBubble
                statusText={statusText}
                completedSteps={completedSteps}
                thinkingHeadline={thinkingHeadline}
              />
            )}

            {streamingText && (
              <div
                className={`${styles.messageRow} ${styles.assistantRow}`}
                data-testid="assistant-message"
              >
                <div className={`${styles.bubble} ${styles.assistantBubble}`}>
                  <div className={styles.markdown}>
                    <SafeWebMarkdown
                      preserveSchemes={PRESERVE_REBEL_SCHEMES}
                      onAnchorClick={handleLinkClick}
                      anchorTarget="_blank"
                    >
                      {streamingText}
                    </SafeWebMarkdown>
                    <span className={styles.streamingCursor} />
                  </div>
                </div>
              </div>
            )}

            <div ref={messagesEndRef} />
          </div>

          {/* Drag-drop overlay */}
          {isDragging && (
            <div className={styles.dragOverlay}>
              <div className={styles.dragContent}>
                <PaperclipIcon size={32} />
                <p>Drop files here</p>
              </div>
            </div>
          )}

          {showScrollButton && (
            <button
              className={styles.scrollToBottom}
              onClick={() => scrollToBottom(true)}
              aria-label="Scroll to bottom"
            >
              <ChevronDownIcon size={20} />
            </button>
          )}

          {id && (
            <div className={styles.approvalBannerWrap}>
              <ConversationApprovalBanner sessionId={id} />
            </div>
          )}

          {/* Voice/attachment status banner */}
          {(voiceError || attachmentError || isTranscribing) && (
            <div className={`${styles.statusBanner} ${voiceError || attachmentError ? styles.statusBannerError : ''}`}>
              {isTranscribing && !voiceError && !attachmentError && (
                <span>Decoding your dulcet tones…</span>
              )}
              {(voiceError || attachmentError) && (
                <span>{voiceError || attachmentError}</span>
              )}
            </div>
          )}

          {/* Attachment thumbnails (text mode only) */}
          {isTextMode && hasAttachments && (
            <div className={styles.attachmentStrip} role="list" aria-label="Attached files">
              {attachments.map((att) => (
                <AttachmentThumbnail
                  key={att.id}
                  attachment={att}
                  onRemove={removeAttachment}
                />
              ))}
            </div>
          )}

          {/* Council review button */}
          {canRequestCouncilReview && (
            <div className={styles.councilReviewBar}>
              <button
                className={styles.councilReviewButton}
                onClick={handleCouncilReview}
                title="Second opinions from the council"
              >
                <UsersIcon size={14} />
                <span>Review</span>
              </button>
            </div>
          )}

          {/* Input area — voice-first by default, text mode via keyboard toggle */}
          {isTextMode ? (
            <div className={styles.inputBar}>
              <button
                className={styles.keyboardToggle}
                onClick={() => setIsTextMode(false)}
                aria-label="Switch to voice"
              >
                <MicIcon size={18} />
              </button>
              <input
                ref={fileInputRef}
                type="file"
                multiple
                accept="image/*,.pdf,.txt,.md,.json,.yaml,.yml,.xml,.csv,.js,.ts,.py,.html,.css,.sh"
                className={styles.hiddenFileInput}
                onChange={handleFileSelected}
                tabIndex={-1}
              />
              <button
                className={styles.attachButton}
                onClick={openFilePicker}
                disabled={!canAddMore || isSending}
                aria-label="Attach file"
                title={canAddMore ? 'Attach file' : 'Maximum files reached'}
              >
                <PaperclipIcon size={20} />
              </button>
              <textarea
                ref={textareaRef}
                className={styles.chatInput}
                data-testid="quick-input"
                value={input}
                onChange={handleInputChange}
                onKeyDown={handleKeyDown}
                placeholder={isRecording ? 'Listening…' : 'Message Rebel…'}
                rows={1}
                maxLength={10000}
                disabled={isSending || isRecording}
              />
              {isBusy ? (
                <button
                  className={styles.stopButton}
                  data-testid="stop-button"
                  onClick={onStop}
                  aria-label="Stop"
                >
                  <SquareIcon size={14} />
                </button>
              ) : showRecordingButton ? (
                <button
                  className={styles.micButton}
                  data-testid="mic-button"
                  data-recording="true"
                  onClick={toggleRecording}
                  aria-label="Stop recording"
                  style={{ '--audio-level': audioLevel } as React.CSSProperties}
                >
                  <MicIcon size={20} />
                </button>
              ) : showTranscribingIndicator ? (
                <div className={styles.transcribingIndicator} aria-label="Transcribing">
                  <div className="loading-spinner small" />
                </div>
              ) : showSendButton ? (
                <button
                  className={styles.chatSendButton}
                  data-testid="send-button"
                  onClick={handleSend}
                  disabled={!hasText && !hasAttachments}
                  aria-label="Send"
                >
                  <SendIcon size={20} />
                </button>
              ) : showMicButton ? (
                <button
                  className={styles.micButton}
                  data-testid="mic-button"
                  onClick={toggleRecording}
                  aria-label="Record voice message"
                >
                  <MicIcon size={20} />
                </button>
              ) : (
                <button
                  className={styles.chatSendButton}
                  data-testid="send-button"
                  onClick={handleSend}
                  disabled
                  aria-label="Send"
                >
                  <SendIcon size={20} />
                </button>
              )}
            </div>
          ) : (
            <div className={styles.voiceFirstBar}>
              {isBusy ? (
                <button
                  className={styles.voiceStopButton}
                  data-testid="stop-button"
                  onClick={onStop}
                  aria-label="Stop"
                >
                  <SquareIcon size={20} />
                </button>
              ) : isTranscribing ? (
                <div className={styles.voiceTranscribingState}>
                  <div className="loading-spinner" />
                  <span>Transcribing…</span>
                </div>
              ) : (
                <>
                  <button
                    className={`${styles.voiceMicLarge} ${isRecording ? styles.voiceMicLargeRecording : ''}`}
                    data-testid="mic-button"
                    onClick={toggleRecording}
                    aria-label={isRecording ? 'Stop recording' : 'Tap to speak'}
                    style={{ '--audio-level': isRecording ? audioLevel : 0 } as React.CSSProperties}
                  >
                    {isRecording ? <SquareIcon size={20} /> : <MicIcon size={28} />}
                  </button>
                  {!isRecording && (
                    <span className={styles.voiceHint}>Tap to speak</span>
                  )}
                  {isRecording && (
                    <span className={styles.voiceHintRecording}>Listening…</span>
                  )}
                  {!isRecording && (
                    <button
                      className={styles.keyboardToggle}
                      onClick={() => setIsTextMode(true)}
                      aria-label="Switch to typing"
                    >
                      <KeyboardIcon size={20} />
                    </button>
                  )}
                </>
              )}
            </div>
          )}
        </>
      )}

      {toast && <div className={styles.toast}>{toast}</div>}
    </div>
  );
}
