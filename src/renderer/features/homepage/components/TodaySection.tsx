/**
 * TodaySection - "Needs your attention today" prioritised stream
 *
 * Renders max 5 visible cards total, including structural nudges and
 * prioritised stream items from useTodayStream.
 *
 * Enhanced loading states show per-connector progress ("Checking your calendar...").
 * Enhanced empty states show action-oriented CTAs for connecting tools.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Calendar, Inbox, Zap, Users, ChevronRight, Plug, MessageCircle, X, CheckCircle2, Trash2, Info } from 'lucide-react';
import { Button, IconTile, InlineToggle, SectionHeader, Tooltip, useToast, type IconTileTone } from '@renderer/components/ui';
import { useSessionStore } from '../../agent-session/store/sessionStore';
import { tracking } from '@renderer/src/tracking';
import { useTodayStream, markMeetingPrepped, type TodayItem } from '../hooks/useTodayStream';
import { getTimeUntilMeeting, formatMeetingTime, isMeetingSoon } from '../utils/meetingFormatters';
import { useTranscriptionMic } from '@renderer/features/composer/hooks/useTranscriptionMic';
import { VoiceMicButton } from '../../inbox/components/VoiceMicButton';
import { ActionDeleteReasonDialog, type ActionDeleteReason } from '../../inbox/components/ActionDeleteReasonDialog';
import { useAppContext } from '@renderer/contexts/AppContext';
import type { HomepageUserState } from '../hooks/useHomepageState';
import type { UseMeetingCacheResult } from '../../usecases/hooks/useMeetingCache';
import type { UseHomepageInboxResult } from '../hooks/useHomepageInboxItems';
import type { FirstRunActionsPassState } from '@shared/types';
import { FocusDiscoveryCard, getFocusNudgeDismissCount } from './FocusDiscoveryCard';
import styles from './TodaySection.module.css';

/** Three user-added connectors is the baseline; five is enough to stop nudging. */
const CONNECTOR_BASELINE_COUNT = 3;
const CONNECTOR_NUDGE_MAX_COUNT = 5;
const MAX_TODAY_VISIBLE_CARDS = 5;

interface TodaySectionProps {
  userState: HomepageUserState;
  onStartMeetingPrep: (prompt: string) => string;
  onOpenFile?: (path: string) => void;
  /** Open an existing session by ID */
  onOpenSession?: (sessionId: string) => void;
  /** Navigate to Inbox tab (tasks surface) */
  onNavigateToInbox?: () => void;
  /** Navigate to the Team panel (optionally to a specific Role URL) */
  onNavigateToTeam?: (target: string) => void;
  /** Number of connected external connectors */
  connectedConnectorCount?: number;
  /** Number of user-added connectors (excluding system/internal MCP servers) */
  userAddedConnectorCount?: number;
  /** Connected connector categories used to choose a truthful first action */
  connectorActionAvailability?: ConnectorActionAvailability;
  /** Navigate to connector setup in settings */
  onNavigateToConnectors?: () => void;
  /** Whether the new-user onboarding intro should remain visible in Today */
  onboardingActivationIncomplete?: boolean;
  /** Whether a valid onboarding coach session exists to resume */
  hasAvailableOnboardingCoachSession?: boolean;
  /** Start or resume the onboarding intro from Home */
  onStartOnboardingIntro?: () => void;
  /** Meeting cache data (owned by HomepagePanel to avoid duplicate fetching) */
  meetingCache: UseMeetingCacheResult;
  /** Inbox items data (owned by HomepagePanel to avoid duplicate fetching) */
  inboxResult: UseHomepageInboxResult;
  /** One-off first-run action pass status, persisted in settings. */
  firstRunActionsPass?: FirstRunActionsPassState;
  /** When false, pauses internal data sources (automation subscription) */
  enabled?: boolean;
  /** Whether Focus feature is enabled (hides nudge when true) */
  focusEnabled?: boolean;
  /** Enables Focus via settings save + navigates to Focus surface */
  onEnableFocus?: () => Promise<void>;
}

export interface ConnectorActionAvailability {
  hasEmail: boolean;
  hasMessaging: boolean;
  hasDocsOrWork: boolean;
}

const typeIcons = {
  meeting: Calendar,
  inbox: Inbox,
  automation: Zap,
  role: Users,
} as const;

const typeIconTones: Record<TodayItem['type'], IconTileTone> = {
  meeting: 'meeting',
  inbox: 'inbox',
  automation: 'automation',
  role: 'role',
};

/** Button lifecycle: idle → prepping (animated) → ready ("Review") → navigates away */
type CardCtaState =
  | { phase: 'idle' }
  | { phase: 'prepping'; sessionId: string }
  | { phase: 'ready'; sessionId: string };

/** Fallback timeout: if prep doesn't complete within 3 min, transition to ready anyway */
const PREP_TIMEOUT_MS = 180_000;

/**
 * Module-level map: TodayItem.id → sessionId started for that item.
 * Survives component remounts (navigation away + back) within the same app session.
 * Resets on full app reload, which is fine — stale sessions are irrelevant after restart.
 */
const activeItemSessions = new Map<string, string>();

function resolveStarterAction({
  hasCalendarContext,
  connectedConnectorCount,
}: {
  hasCalendarContext: boolean;
  connectedConnectorCount: number;
}): {
  title: string;
  description: string;
  prompt: string;
  icon: typeof Calendar;
  tone: IconTileTone;
} {
  if (hasCalendarContext) {
    return {
      title: 'Prep your next meeting',
      description: 'Let Rebel pull the context together while the rest of Today catches up.',
      prompt: 'Prep me for my next upcoming meeting. Use the meeting-prep skill and connected calendar context.',
      icon: Calendar,
      tone: 'meeting',
    };
  }

  if (connectedConnectorCount > 0) {
    return {
      title: 'Try a quick task',
      description: 'Give Rebel a rough request and it will turn it into useful work.',
      prompt: 'Help me turn a rough work request into a clear next step. Ask one question if you need context.',
      icon: Zap,
      tone: 'automation',
    };
  }

  return {
    title: 'Draft a quick message',
    description: 'Tell Rebel what you need to say, and it will turn it into a clear note.',
    prompt: 'Draft a concise work message from a rough idea. Ask me what I need to say, then turn it into a clear email, follow-up, or Slack-style note.',
    icon: Inbox,
    tone: 'inbox',
  };
}

function TodayItemCard({
  item,
  onStartMeetingPrep,
  onOpenFile,
  onOpenSession,
  onNavigateToTeam,
  onDismiss,
  onDismissAnimationEnd,
  onAutoHide,
  isDismissing,
  isSuggestion,
}: {
  item: TodayItem;
  onStartMeetingPrep: (prompt: string) => string;
  onOpenFile?: (path: string) => void;
  onOpenSession?: (sessionId: string) => void;
  onNavigateToTeam?: (target: string) => void;
  onDismiss?: (item: TodayItem) => void;
  /** Fires when the dismiss CSS animation finishes — parent uses this to remove from stream */
  onDismissAnimationEnd?: (item: TodayItem) => void;
  /** Silently remove from homepage when user navigates to view content */
  onAutoHide?: (item: TodayItem) => void;
  isDismissing?: boolean;
  isSuggestion?: boolean;
}) {
  const Icon = typeIcons[item.type];
  const [ctaState, setCtaState] = useState<CardCtaState>(() => {
    const existingSessionId = activeItemSessions.get(item.id);
    if (!existingSessionId) return { phase: 'idle' };
    const summary = useSessionStore.getState().sessionSummaries.find(
      (s) => s.id === existingSessionId,
    );
    if (summary && !summary.isBusy && (summary.messageCount ?? 0) >= 2) {
      return { phase: 'ready', sessionId: existingSessionId };
    }
    return { phase: 'prepping', sessionId: existingSessionId };
  });

  // Subscribe to session state — only when we're tracking a prepping session.
  // A background session starts with isBusy=false before the first event arrives,
  // so we also check messageCount to avoid a false "ready" on the initial state.
  // Ready = not busy AND has at least 2 messages (user prompt + agent response).
  const preppingSessionId = ctaState.phase === 'prepping' ? ctaState.sessionId : null;
  const isSessionReady = useSessionStore((s) => {
    if (!preppingSessionId) return false;
    const summary = s.sessionSummaries.find((sum) => sum.id === preppingSessionId);
    if (!summary) return false;
    return !summary.isBusy && (summary.messageCount ?? 0) >= 2;
  });

  // Transition prepping → ready when the session finishes
  const ctaSessionId = 'sessionId' in ctaState ? ctaState.sessionId : null;
  useEffect(() => {
    if (ctaState.phase === 'prepping' && isSessionReady) {
      setCtaState({ phase: 'ready', sessionId: ctaState.sessionId });
    }
  }, [ctaState.phase, ctaSessionId, isSessionReady]); // eslint-disable-line react-hooks/exhaustive-deps -- ctaSessionId captures ctaState.sessionId; ctaState itself excluded to avoid re-running on every phase change

  // Fallback: if session doesn't finish within timeout, show "Review" anyway
  // so users aren't stuck on an infinite "Prepping..." state.
  useEffect(() => {
    if (ctaState.phase !== 'prepping') return;
    const tid = setTimeout(() => {
      setCtaState((prev) =>
        prev.phase === 'prepping' ? { phase: 'ready', sessionId: prev.sessionId } : prev
      );
    }, PREP_TIMEOUT_MS);
    return () => clearTimeout(tid);
  }, [ctaState.phase]);

  // -- Context input state (expand/collapse + text) --
  const canAddContext = item.ctaAction === 'meeting-prep' && ctaState.phase === 'idle';
  const isInboxItem = !!item.originalItemId;
  const [isExpanded, setIsExpanded] = useState(false);
  const titleRef = useRef<HTMLParagraphElement>(null);
  const metaRef = useRef<HTMLParagraphElement>(null);
  const [isTruncated, setIsTruncated] = useState(false);
  const canExpand = canAddContext || isInboxItem || isTruncated || isExpanded;
  const [context, setContext] = useState('');
  const [autoDone, setAutoDone] = useState(false);
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const contextInputRef = useRef<HTMLTextAreaElement>(null);
  const { showToast } = useAppContext();

  // Reset local state when the underlying item changes (stream reorder)
  const prevItemIdRef = useRef(item.id);
  useEffect(() => {
    if (prevItemIdRef.current !== item.id) {
      prevItemIdRef.current = item.id;
      setIsExpanded(false);
      setContext('');
    }
  }, [item.id]);

  // Voice transcription for context input
  const handleTranscript = useCallback((text: string) => {
    setContext(prev => prev ? `${prev} ${text}` : text);
  }, []);

  const handleTranscriptionError = useCallback((message: string) => {
    showToast({ title: message, variant: 'error' });
  }, [showToast]);

  // Build prompt with context appended
  const buildPromptWithContext = useCallback((extraContext?: string) => {
    const trimmed = (extraContext ?? context).trim();
    if (!trimmed || !item.ctaPrompt) return item.ctaPrompt ?? '';
    return `${item.ctaPrompt}\n\nAdditional context from user: ${trimmed}`;
  }, [context, item.ctaPrompt]);

  const fireMeetingPrepAction = useCallback((prompt: string) => {
    const sessionId = onStartMeetingPrep(prompt);
    if (item.type === 'meeting' && item.originalItemId) {
      markMeetingPrepped(item.originalItemId);
    }
    activeItemSessions.set(item.id, sessionId);
    setCtaState({ phase: 'prepping', sessionId });
    setContext('');
    setIsExpanded(false);
  }, [item, onStartMeetingPrep]);

  // Double-tap while recording: execute with transcript as context.
  const handleTranscriptAndSend = useCallback((text: string) => {
    if (item.ctaAction !== 'meeting-prep' || !item.ctaPrompt) return;
    const fullContext = (context ? `${context} ${text}` : text).trim();
    const fullPrompt = buildPromptWithContext(fullContext);
    queueMicrotask(() => fireMeetingPrepAction(fullPrompt));
  }, [context, item.ctaAction, item.ctaPrompt, buildPromptWithContext, fireMeetingPrepAction]);

  const {
    isRecording,
    isProcessing: isTranscribeProcessing,
    toggleRecording,
    stopAndSend,
    audioLevel,
  } = useTranscriptionMic({
    currentSessionId: item.originalItemId || item.id,
    onTranscript: handleTranscript,
    onTranscriptAndSend: handleTranscriptAndSend,
    onError: handleTranscriptionError,
  });

  // Collapse when card transitions away from idle; stop any active recording
  useEffect(() => {
    if (ctaState.phase !== 'idle') {
      setIsExpanded(false);
      setContext('');
    }
  }, [ctaState.phase]);

  // Collapse on dismiss
  useEffect(() => {
    if (isDismissing) {
      setIsExpanded(false);
      setContext('');
    }
  }, [isDismissing]);

  const markInboxItemCompleted = useCallback(() => {
    if (item.type === 'inbox' && item.originalItemId) {
      window.inboxApi.setStatus({
        itemId: item.originalItemId,
        status: 'completed',
        completedBy: 'user',
      }).catch((err) => {
        console.warn('[Homepage] Failed to mark inbox item completed:', item.originalItemId, err);
      });
    }
  }, [item.type, item.originalItemId]);

  const handleInboxDone = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    if (!item.originalItemId) return;
    window.inboxApi.setStatus({
      itemId: item.originalItemId,
      status: 'completed',
      completedBy: 'user',
    }).catch((err) => {
      console.warn('[Homepage] Failed to mark done:', item.originalItemId, err);
    });
    onAutoHide?.(item);
  }, [item, onAutoHide]);

  const handleInboxDelete = useCallback((reason?: ActionDeleteReason) => {
    if (!item.originalItemId) return;
    window.inboxApi.setStatus({
      itemId: item.originalItemId,
      status: 'dismissed',
      dismissedReasonCategory: reason?.category,
      dismissedReason: reason?.text?.trim() || undefined,
    }).catch((err) => {
      console.warn('[Homepage] Failed to dismiss:', item.originalItemId, err);
    });
    onAutoHide?.(item);
  }, [item, onAutoHide]);

  const requestInboxDelete = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    setDeleteDialogOpen(true);
  }, []);

  const handleCta = useCallback(() => {
    if (isTranscribeProcessing) return;

    if (ctaState.phase === 'prepping' || ctaState.phase === 'ready') {
      onOpenSession?.(ctaState.sessionId);
      if (autoDone) {
        markInboxItemCompleted();
        onAutoHide?.(item);
        activeItemSessions.delete(item.id);
      }
      return;
    }

    // phase === 'idle'
    tracking.homepage.todayCardCtaClicked(item.type, item.ctaAction ?? 'unknown', item.id);
    if (item.ctaAction === 'open-file' && item.ctaPath && onOpenFile) {
      onOpenFile(item.ctaPath);
      if (autoDone) {
        markInboxItemCompleted();
        onAutoHide?.(item);
      }
    } else if (item.type === 'role' && item.ctaAction === 'navigate' && item.ctaPath && onNavigateToTeam) {
      onNavigateToTeam(item.ctaPath);
      onAutoHide?.(item);
    } else if (item.ctaAction === 'navigate' && item.ctaPath && onOpenSession) {
      onOpenSession(item.ctaPath);
      if (autoDone) {
        markInboxItemCompleted();
        onAutoHide?.(item);
      }
    } else if (item.ctaAction === 'meeting-prep' && item.ctaPrompt) {
      if (isRecording) {
        toggleRecording();
      }
      if (autoDone) markInboxItemCompleted();
      fireMeetingPrepAction(buildPromptWithContext());
    }
  }, [item, buildPromptWithContext, fireMeetingPrepAction, markInboxItemCompleted, onOpenFile, onOpenSession, onNavigateToTeam, onAutoHide, ctaState, isRecording, isTranscribeProcessing, toggleRecording, autoDone]);

  // Toggle expand on card body click
  const handleCardBodyClick = useCallback(() => {
    if (!canExpand) return;
    setIsExpanded(prev => {
      const next = !prev;
      if (next && canAddContext) {
        requestAnimationFrame(() => contextInputRef.current?.focus());
      }
      return next;
    });
  }, [canExpand, canAddContext]);

  // Stop propagation from context row so clicks on mic/input don't toggle expand
  const handleContextRowClick = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
  }, []);

  const handleDismiss = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    tracking.homepage.todayCardDismissed(item.type, item.id);
    onDismiss?.(item);
  }, [item, onDismiss]);

  // Build meta text
  let meta = '';
  if (item.type === 'meeting' && item.startTime && item.endTime) {
    const timeUntil = getTimeUntilMeeting(item.startTime, item.endTime);
    const timeRange = formatMeetingTime(item.startTime, item.endTime);
    meta = timeUntil ? `${timeUntil} · ${timeRange}` : timeRange;
  } else if (item.subtitle) {
    meta = item.subtitle;
  }

  // Only meetings get the visual "urgent" treatment (orange border + meta).
  // Inbox/automation urgency is handled via list priority order, not colour.
  const isUrgent = item.type === 'meeting' && item.startTime
    ? isMeetingSoon(item.startTime, 30)
    : false;

  // Detect whether title or meta text is truncated (overflow hidden with ellipsis)
  useEffect(() => {
    const checkTruncation = () => {
      const titleEl = titleRef.current;
      const metaEl = metaRef.current;
      const titleOverflows = titleEl ? titleEl.scrollWidth > titleEl.clientWidth : false;
      const metaOverflows = metaEl
        ? metaEl.scrollWidth > metaEl.clientWidth || metaEl.scrollHeight > metaEl.clientHeight
        : false;
      setIsTruncated(titleOverflows || metaOverflows);
    };
    checkTruncation();
    window.addEventListener('resize', checkTruncation);
    return () => window.removeEventListener('resize', checkTruncation);
  }, [item.title, meta]);

  // Build hover tooltip with richer detail
  const tooltipContent = useMemo(() => {
    const parts: string[] = [item.title];
    if (meta) parts.push(meta);
    return parts.join('\n');
  }, [item.title, meta]);

  // Determine button label and state
  let ctaLabel: React.ReactNode;
  const isDisabled = false;
  let dataState: string = 'idle';

  if (ctaState.phase === 'prepping') {
    ctaLabel = (
      <>
        Prepping
        <span className={styles.ctaDots} />
      </>
    );
    dataState = 'prepping';
  } else if (ctaState.phase === 'ready') {
    ctaLabel = 'Review';
    dataState = 'ready';
  } else {
    ctaLabel = item.ctaLabel;
  }

  const handleAnimationEnd = useCallback(() => {
    if (isDismissing) {
      onDismissAnimationEnd?.(item);
    }
  }, [isDismissing, onDismissAnimationEnd, item]);

  const micDisabled = isTranscribeProcessing || (!isRecording && ctaState.phase !== 'idle');

  return (
    <div className={styles.card} data-testid="today-card" data-urgent={isUrgent} data-dismissing={isDismissing || undefined} data-suggestion={isSuggestion || undefined} data-expanded={isExpanded || undefined} data-expandable={canExpand || undefined} onAnimationEnd={handleAnimationEnd}>
      <IconTile icon={Icon} tone={typeIconTones[item.type]} />
      <Tooltip content={tooltipContent} placement="top" disabled={!isTruncated || isExpanded}>
        <div
          className={styles.cardBody}
          onClick={handleCardBodyClick}
          role={canExpand ? 'button' : undefined}
          tabIndex={canExpand ? 0 : undefined}
          aria-expanded={canExpand ? isExpanded : undefined}
          onKeyDown={canExpand ? (e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              handleCardBodyClick();
            }
          } : undefined}
        >
          <p ref={titleRef} className={styles.cardTitle}>{item.title}</p>
          {meta && (
            <p ref={metaRef} className={styles.cardMeta} data-urgent={isUrgent} data-type={item.type}>{meta}</p>
          )}
        </div>
      </Tooltip>
      <Button
        type="button"
        variant="secondary"
        size="xs"
        className={styles.cardCta}
        onClick={handleCta}
        disabled={isDisabled}
        data-state={dataState}
      >
        {ctaLabel}
      </Button>
      {onDismiss && (
        <Tooltip content="Hide" placement="top" delayShow={300}>
          <button
            type="button"
            className={styles.cardDismiss}
            onClick={handleDismiss}
            aria-label="Dismiss"
          >
            <X size={10} />
          </button>
        </Tooltip>
      )}
      {isExpanded && canAddContext && (
        <div className={styles.cardContextRow} onClick={handleContextRowClick} onKeyDown={(e) => e.stopPropagation()}>
          <VoiceMicButton
            isRecording={isRecording}
            isProcessing={isTranscribeProcessing}
            disabled={micDisabled}
            audioLevel={audioLevel}
            onToggle={toggleRecording}
            onStopAndSend={stopAndSend}
          />
          <textarea
            ref={contextInputRef}
            className={styles.cardContextInput}
            placeholder={item.contextPlaceholder || 'Add context...'}
            value={context}
            rows={1}
            onChange={(e) => {
              setContext(e.target.value);
              const el = e.target;
              el.style.height = 'auto';
              el.style.overflowY = 'hidden';
              const max = 120;
              if (el.scrollHeight > max) {
                el.style.height = `${max}px`;
                el.style.overflowY = 'auto';
              } else {
                el.style.height = `${el.scrollHeight}px`;
              }
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                handleCta();
              }
              if (e.key === 'Escape') {
                setIsExpanded(false);
                setContext('');
              }
            }}
          />
        </div>
      )}
      {isExpanded && isInboxItem && (
        <div className={styles.cardActions} onClick={handleContextRowClick}>
          <Tooltip content="Remove this item — tap Undo to restore" delayShow={400}>
            <Button
              type="button"
              size="xs"
              variant="ghost"
              className={`${styles.cardActionButton} ${styles.cardActionDelete}`}
              onClick={requestInboxDelete}
            >
              <Trash2 size={12} /> Delete
            </Button>
          </Tooltip>
          <Tooltip content={autoDone ? 'Rebel will move this to Done automatically after handling it' : 'When on, Rebel moves this to Done automatically after handling it'} delayShow={500}>
            <InlineToggle
              checked={autoDone}
              className={styles.autoDoneToggle}
              label="Auto-mark done"
              onCheckedChange={setAutoDone}
              stopPropagation
            />
          </Tooltip>
          <Tooltip content="Mark as completed and move to Done" delayShow={400}>
            <Button
              type="button"
              size="xs"
              variant="outline"
              className={`${styles.cardActionButton} ${styles.cardActionDone}`}
              onClick={handleInboxDone}
            >
              <CheckCircle2 size={12} /> Done
            </Button>
          </Tooltip>
        </div>
      )}
      <ActionDeleteReasonDialog
        open={deleteDialogOpen}
        itemTitle={item.title}
        onOpenChange={setDeleteDialogOpen}
        onConfirm={(reason) => {
          setDeleteDialogOpen(false);
          handleInboxDelete(reason);
        }}
      />
    </div>
  );
}

/**
 * Per-connector loading indicator — shows what's being checked.
 */
function LoadingIndicator({
  icon: Icon,
  label,
  done,
}: {
  icon: typeof Calendar;
  label: string;
  done: boolean;
}) {
  return (
    <div className={styles.loadingRow} data-done={done}>
      <div className={styles.loadingRowIcon} data-done={done}>
        <Icon size={14} />
      </div>
      <span className={styles.loadingRowLabel}>{label}</span>
      {!done && <span className={styles.loadingDots} />}
    </div>
  );
}

const DISMISSED_STORAGE_KEY = 'rebel:homepage:dismissedTodayItems';

function loadDismissedIds(): Set<string> {
  try {
    const raw = localStorage.getItem(DISMISSED_STORAGE_KEY);
    if (!raw) return new Set();
    const parsed = JSON.parse(raw);

    // Legacy v0 (string[]) and v1 ({ date, ids }) formats
    if (Array.isArray(parsed)) return new Set(parsed.filter((v): v is string => typeof v === 'string'));
    if (parsed?.date && Array.isArray(parsed?.ids)) {
      const set = new Set((parsed.ids as unknown[]).filter((v): v is string => typeof v === 'string'));
      saveDismissedIds(set);
      return set;
    }

    // Current format: plain string array under "ids" key (no date gating)
    if (parsed?.ids && Array.isArray(parsed.ids)) {
      return new Set((parsed.ids as unknown[]).filter((v): v is string => typeof v === 'string'));
    }

    return new Set();
  } catch {
    return new Set();
  }
}

const MAX_DISMISSED_IDS = 200;

function saveDismissedIds(ids: Set<string>): void {
  try {
    let arr = [...ids];
    if (arr.length > MAX_DISMISSED_IDS) {
      arr = arr.slice(-MAX_DISMISSED_IDS);
    }
    localStorage.setItem(DISMISSED_STORAGE_KEY, JSON.stringify({ ids: arr }));
  } catch {
    // Non-critical — worst case items reappear next session
  }
}

const NUDGE_DISMISSED_KEY = 'rebel:homepage:connectorNudgeDismissedAt';
const NUDGE_COOLDOWN_MS = 7 * 24 * 60 * 60 * 1000;

function isConnectorNudgeDismissed(): boolean {
  try {
    const raw = localStorage.getItem(NUDGE_DISMISSED_KEY);
    if (!raw) return false;
    const dismissedAt = Number(raw);
    return Date.now() - dismissedAt < NUDGE_COOLDOWN_MS;
  } catch {
    return false;
  }
}

function dismissConnectorNudge(): void {
  try {
    localStorage.setItem(NUDGE_DISMISSED_KEY, String(Date.now()));
  } catch {
    // Non-critical
  }
}

export function TodaySection({
  userState,
  onStartMeetingPrep,
  onOpenFile,
  onOpenSession,
  onNavigateToInbox,
  onNavigateToTeam,
  connectedConnectorCount = 0,
  userAddedConnectorCount = 0,
  onNavigateToConnectors,
  onboardingActivationIncomplete = false,
  hasAvailableOnboardingCoachSession = false,
  onStartOnboardingIntro,
  meetingCache,
  inboxResult,
  firstRunActionsPass,
  enabled = true,
  focusEnabled = false,
  onEnableFocus,
}: TodaySectionProps) {
  const [dismissedIds, setDismissedIds] = useState<Set<string>>(loadDismissedIds);
  const [dismissingIds, setDismissingIds] = useState<Set<string>>(new Set());
  const { items, suggestions, totalCount, isLoading, isEmpty, sourceStatus } = useTodayStream({ dismissedIds, meetingCache, inboxResult, enabled });
  const { showToast, dismissToast } = useToast();

  // Focus nudge: show when Focus is disabled, user has meetings, dismiss count < 3
  const [focusNudgeDismissed, setFocusNudgeDismissed] = useState(
    () => getFocusNudgeDismissCount() >= 3,
  );
  const showFocusNudge =
    !onboardingActivationIncomplete &&
    !focusEnabled &&
    !focusNudgeDismissed &&
    meetingCache.meetings.length > 0 &&
    !!onEnableFocus;

  // Connector nudge: useful through early setup, then retires once the user has
  // enough sources for Rebel to spend this attention budget elsewhere.
  const [nudgeDismissed, setNudgeDismissed] = useState(isConnectorNudgeDismissed);
  const forceConnectorSetupDuringOnboarding = onboardingActivationIncomplete;
  const showConnectorNudge = forceConnectorSetupDuringOnboarding || (!nudgeDismissed && userAddedConnectorCount < CONNECTOR_NUDGE_MAX_COUNT);
  const nudgeTier: 'zero' | 'below-baseline' | 'enrichment' =
    userAddedConnectorCount === 0
      ? 'zero'
      : userAddedConnectorCount < CONNECTOR_BASELINE_COUNT
        ? 'below-baseline'
        : 'enrichment';
  const nudgeTrackedRef = useRef(false);
  const showOnboardingActivationCard = onboardingActivationIncomplete && !!onStartOnboardingIntro;
  const showRenderedConnectorNudge = showConnectorNudge && !!onNavigateToConnectors;
  const showRenderedFocusNudge = showFocusNudge && !!onEnableFocus;
  const [firstUsefulActionState, setFirstUsefulActionState] = useState<CardCtaState>({ phase: 'idle' });
  const [firstUsefulActionDismissed, setFirstUsefulActionDismissed] = useState(false);
  const hasStreamContent = items.length > 0 || suggestions.length > 0;
  const firstRunPassRunning = firstRunActionsPass?.status === 'running';
  const firstRunPassChecking = firstRunPassRunning;
  const firstRunPassFailed = firstRunActionsPass?.status === 'failed'
    || firstRunActionsPass?.sourceResults?.some((source) => source.status === 'failed') === true;
  const firstRunPassSettledEmpty =
    firstRunActionsPass?.status === 'completed' &&
    (firstRunActionsPass.itemsCreated ?? 0) === 0 &&
    !hasStreamContent &&
    connectedConnectorCount > 0;
  const keepStarterActionAfterEmptyPass = firstRunPassSettledEmpty && onboardingActivationIncomplete;
  const hasCalendarContext = meetingCache.meetings.length > 0;
  const starterAction = resolveStarterAction({
    hasCalendarContext,
    connectedConnectorCount,
  });
  const showFirstUsefulActionCard = !firstRunPassRunning && (!firstRunPassSettledEmpty || keepStarterActionAfterEmptyPass) && !firstUsefulActionDismissed && !hasStreamContent && (
    onboardingActivationIncomplete ||
    isLoading ||
    userState.kind === 'new-loading' ||
    userState.kind === 'new-no-data'
  );
  const connectorComesFirst = userAddedConnectorCount === 0;
  const firstUsefulActionSessionId = 'sessionId' in firstUsefulActionState ? firstUsefulActionState.sessionId : null;
  const firstUsefulActionReady = useSessionStore((s) => {
    if (!firstUsefulActionSessionId) return false;
    const summary = s.sessionSummaries.find((sum) => sum.id === firstUsefulActionSessionId);
    if (!summary) return false;
    return !summary.isBusy && (summary.messageCount ?? 0) >= 2;
  });

  useEffect(() => {
    if (showConnectorNudge && !nudgeTrackedRef.current) {
      nudgeTrackedRef.current = true;
      tracking.homepage.connectorNudgeShown(nudgeTier, userAddedConnectorCount);
    }
  }, [showConnectorNudge, nudgeTier, userAddedConnectorCount]);

  useEffect(() => {
    if (firstUsefulActionState.phase === 'prepping' && firstUsefulActionReady && firstUsefulActionSessionId) {
      setFirstUsefulActionState({ phase: 'ready', sessionId: firstUsefulActionSessionId });
    }
  }, [firstUsefulActionState.phase, firstUsefulActionReady, firstUsefulActionSessionId]);

  useEffect(() => {
    if (firstUsefulActionState.phase !== 'prepping') return;
    const tid = setTimeout(() => {
      setFirstUsefulActionState((prev) =>
        prev.phase === 'prepping' ? { phase: 'ready', sessionId: prev.sessionId } : prev
      );
    }, PREP_TIMEOUT_MS);
    return () => clearTimeout(tid);
  }, [firstUsefulActionState.phase]);

  const handleFirstUsefulAction = useCallback(() => {
    if (firstUsefulActionState.phase === 'prepping' || firstUsefulActionState.phase === 'ready') {
      onOpenSession?.(firstUsefulActionState.sessionId);
      return;
    }

    const sessionId = onStartMeetingPrep(starterAction.prompt);
    setFirstUsefulActionState({ phase: 'prepping', sessionId });
  }, [firstUsefulActionState, starterAction.prompt, onOpenSession, onStartMeetingPrep]);

  const mutateDismissedIds = useCallback((mutator: (next: Set<string>) => void) => {
    setDismissedIds((prev) => {
      const persisted = loadDismissedIds();
      const next = new Set([...prev, ...persisted]);
      mutator(next);
      saveDismissedIds(next);
      return next;
    });
  }, []);

  // Safety timeouts: if the CSS animationend event doesn't fire (reduced motion,
  // component remount, etc.), we force-complete the dismiss after the animation
  // duration + buffer so the item never lingers in the stream.
  const dismissSafetyTimeouts = useRef(new Map<string, ReturnType<typeof setTimeout>>());

  // Silent auto-hide: when user clicks to view content, remove from homepage
  // without animation or toast (user is navigating away, they won't see it).
  // When they return, the slot is freed for the next item.
  const handleAutoHide = useCallback((item: TodayItem) => {
    tracking.homepage.todayCardAutoHidden(item.type, item.id);
    mutateDismissedIds((next) => {
      next.add(item.id);
    });
  }, [mutateDismissedIds]);

  const finalizeDismiss = useCallback((itemId: string) => {
    const timeout = dismissSafetyTimeouts.current.get(itemId);
    if (timeout) {
      clearTimeout(timeout);
      dismissSafetyTimeouts.current.delete(itemId);
    }
    mutateDismissedIds((next) => {
      next.add(itemId);
    });
    setDismissingIds((prev) => {
      if (!prev.has(itemId)) return prev;
      const next = new Set(prev);
      next.delete(itemId);
      return next;
    });
  }, [mutateDismissedIds]);

  const handleDismiss = useCallback((item: TodayItem) => {
    const { id: itemId, type: itemType } = item;

    // Trigger slide-out animation
    setDismissingIds((prev) => {
      const next = new Set(prev);
      next.add(itemId);
      return next;
    });

    // Persist immediately so a crash/refresh during the animation can't resurrect the card
    const persisted = loadDismissedIds();
    persisted.add(itemId);
    saveDismissedIds(persisted);

    tracking.homepage.todayCardDismissed(itemType, itemId);

    // Safety net: force-complete if animationend doesn't fire (500ms > 350ms animation)
    const timeout = setTimeout(() => {
      dismissSafetyTimeouts.current.delete(itemId);
      finalizeDismiss(itemId);
    }, 500);
    dismissSafetyTimeouts.current.set(itemId, timeout);

    // Show toast immediately (don't gate on animation completion)
    const description = itemType === 'inbox' ? 'Still in your Actions' : undefined;
    const toastId = showToast({
      title: 'Hidden from homepage',
      description,
      duration: 8000,
      action: {
        label: 'Undo',
        onClick: () => {
          const t = dismissSafetyTimeouts.current.get(itemId);
          if (t) {
            clearTimeout(t);
            dismissSafetyTimeouts.current.delete(itemId);
          }
          tracking.homepage.todayCardUndoDismiss(itemType, itemId);
          mutateDismissedIds((next) => {
            next.delete(itemId);
          });
          setDismissingIds((prev) => {
            if (!prev.has(itemId)) return prev;
            const next = new Set(prev);
            next.delete(itemId);
            return next;
          });
          dismissToast(toastId);
        },
      },
    });
  }, [showToast, dismissToast, mutateDismissedIds, finalizeDismiss]);

  // Fires when the CSS cardDismiss animation finishes — cancels the safety
  // timeout and finalizes the dismiss (updates React state).
  const handleDismissComplete = useCallback((item: TodayItem) => {
    finalizeDismiss(item.id);
  }, [finalizeDismiss]);

  // Per-connector loading state — shown alone only when no structural cards can
  // give the user useful next steps yet.
  if ((firstRunPassChecking || isLoading) && (userState.kind === 'new-loading' || !hasStreamContent) && !showOnboardingActivationCard && !showRenderedConnectorNudge && !showRenderedFocusNudge && !showFirstUsefulActionCard) {
    return (
      <section className={styles.section}>
        <SectionHeader
          title="Needs your attention today"
          subtitle={firstRunPassChecking
            ? 'Checking your calendar and Actions for useful next steps.'
            : 'Getting to know your day...'}
        />
        <div className={styles.loadingContainer} role="status" aria-live="polite">
          <LoadingIndicator
            icon={Calendar}
            label={firstRunPassChecking || sourceStatus.meetingsLoading ? 'Checking your calendar' : 'Calendar checked'}
            done={!firstRunPassChecking && !sourceStatus.meetingsLoading}
          />
          <LoadingIndicator
            icon={Inbox}
            label={firstRunPassChecking || sourceStatus.inboxLoading ? 'Pulling action items' : 'Actions checked'}
            done={!firstRunPassChecking && !sourceStatus.inboxLoading}
          />
        </div>
      </section>
    );
  }

  // Empty state — action-oriented, adapts by connector status.
  // Skip the empty state if the connector nudge card will show (it provides its own CTA).
  if ((isEmpty || firstRunPassSettledEmpty || (firstRunPassFailed && !hasStreamContent)) && !showOnboardingActivationCard && !showRenderedConnectorNudge && !showRenderedFocusNudge && !showFirstUsefulActionCard) {
    return (
      <section className={styles.section}>
        <SectionHeader title="Needs your attention today" />
        <div className={styles.emptyState}>
          {firstRunPassFailed ? (
            <>
              <p className={styles.emptyText}>
                Couldn&apos;t finish the first setup check. Rebel will still add cards here as new meetings, messages, or follow-ups need attention.
              </p>
            </>
          ) : firstRunPassSettledEmpty ? (
            <>
              <p className={styles.emptyText}>
                Nothing urgent yet. Rebel will add cards here when meetings, messages, or follow-ups need attention.
              </p>
            </>
          ) : userState.kind === 'new-no-connectors' ? (
            <>
              <Plug size={20} className={styles.emptyIcon} />
              <p className={styles.emptyText}>
                Connect your calendar and I&apos;ll prep you for your next meeting in 30 seconds.
              </p>
              {onNavigateToConnectors && (
                <Button
                  variant="secondary"
                  size="sm"
                  className={styles.emptyCta}
                  onClick={() => { tracking.homepage.todayEmptyCtaClicked(userState.kind); onNavigateToConnectors(); }}
                >
                  Connect tools
                </Button>
              )}
            </>
          ) : connectedConnectorCount > 0 ? (
            <>
              <p className={styles.emptyText}>
                Nothing urgent right now. Your meetings and action items will appear here as your day unfolds.
              </p>
            </>
          ) : (
            <>
              <p className={styles.emptyText}>
                Connect your calendar and email to see what needs your attention.
              </p>
              {onNavigateToConnectors && (
                <Button
                  variant="secondary"
                  size="sm"
                  className={styles.emptyCta}
                  onClick={() => { tracking.homepage.todayEmptyCtaClicked(userState.kind); onNavigateToConnectors(); }}
                >
                  Connect tools
                </Button>
              )}
            </>
          )}
        </div>
      </section>
    );
  }

  const structuralCardCount =
    (showOnboardingActivationCard ? 1 : 0) +
    (showRenderedConnectorNudge ? 1 : 0) +
    (showRenderedFocusNudge ? 1 : 0) +
    (showFirstUsefulActionCard ? 1 : 0);

  const streamCardBudget = Math.max(0, MAX_TODAY_VISIBLE_CARDS - structuralCardCount);
  const displayItems = items.slice(0, streamCardBudget);
  const displaySuggestions = suggestions.slice(0, Math.max(0, streamCardBudget - displayItems.length));
  const remainingSlotsAfterContent = Math.max(
    0,
    streamCardBudget - displayItems.length - displaySuggestions.length,
  );
  const loadingPreviewCardCount = Math.min(2, remainingSlotsAfterContent);
  const showLoadingPreview = !hasStreamContent && (firstRunPassChecking || isLoading) && loadingPreviewCardCount > 0;
  const showFirstRunSettledEmptyNote = firstRunPassSettledEmpty && !hasStreamContent && !isLoading && !firstRunPassChecking;

  const hasDisplayedItems = displayItems.length > 0 || displaySuggestions.length > 0 || showOnboardingActivationCard || showRenderedConnectorNudge || showRenderedFocusNudge || showFirstUsefulActionCard;
  const subtitle = firstRunPassChecking
    ? 'Checking your calendar and Actions for useful next steps.'
    : hasDisplayedItems
    ? 'Your meetings, action items, and automations, sorted by what matters most.'
    : 'Nothing urgent right now.';

  const connectorNudgeTitle = userAddedConnectorCount === 0
    ? 'Connect your tools'
    : userAddedConnectorCount < CONNECTOR_BASELINE_COUNT
      ? 'Add at least three connectors'
      : 'Add more connectors';
  const connectorNudgeCopy = userAddedConnectorCount === 0
    ? 'Connectors give Rebel context from the work apps you choose, so it can spot useful next steps.'
    : userAddedConnectorCount < CONNECTOR_BASELINE_COUNT
      ? 'People get better results when Rebel can compare signals from at least three connected tools.'
      : 'You have the basics. More connectors give Rebel a wider view, so suggestions get more specific.';
  const shouldNumberActivationCards = showOnboardingActivationCard && showRenderedConnectorNudge;
  const onboardingActivationTitle = hasAvailableOnboardingCoachSession
    ? 'Continue your intro with Rebel'
    : connectorComesFirst
      ? 'Tell Rebel what matters'
      : 'Start here';
  const onboardingActivationStep = connectorComesFirst ? 2 : 1;
  const connectorNudgeStep = connectorComesFirst ? 1 : 2;
  const numberedOnboardingActivationTitle = shouldNumberActivationCards
    ? `${onboardingActivationStep}. ${onboardingActivationTitle}`
    : onboardingActivationTitle;
  const numberedConnectorNudgeTitle = shouldNumberActivationCards
    ? `${connectorNudgeStep}. ${connectorNudgeTitle}`
    : connectorNudgeTitle;
  const firstUsefulActionLabel = firstUsefulActionState.phase === 'idle'
    ? (hasCalendarContext ? 'Prep' : 'Try')
    : firstUsefulActionState.phase === 'ready'
      ? 'Review'
      : (
          <>
            Prepping
            <span className={styles.ctaDots} />
          </>
        );
  const firstUsefulActionDataState = firstUsefulActionState.phase === 'idle' ? 'idle' : firstUsefulActionState.phase;
  const connectorNudgeCard = showRenderedConnectorNudge ? (
    <div className={styles.card} data-testid="today-card" data-urgent={false}>
      <IconTile icon={Plug} tone="connector" className={styles.setupStepIconTile} />
      <div className={styles.cardBody}>
        <p className={styles.cardTitle}>{numberedConnectorNudgeTitle}</p>
        <p className={styles.cardMeta} data-type="connector-nudge">
          {connectorNudgeCopy}
        </p>
      </div>
      <Button
        type="button"
        variant="secondary"
        size="xs"
        className={styles.cardCta}
        onClick={() => {
          tracking.homepage.connectorNudgeClicked(nudgeTier, userAddedConnectorCount);
          onNavigateToConnectors();
        }}
      >
        {userAddedConnectorCount === 0 ? 'Connect' : 'Add'}
      </Button>
      {!forceConnectorSetupDuringOnboarding && (
        <button
          type="button"
          className={styles.cardDismiss}
          onClick={(e) => {
            e.stopPropagation();
            tracking.homepage.connectorNudgeDismissed(nudgeTier, userAddedConnectorCount);
            dismissConnectorNudge();
            setNudgeDismissed(true);
          }}
          aria-label="Dismiss"
        >
          <X size={10} />
        </button>
      )}
    </div>
  ) : null;

  return (
    <section className={styles.section}>
      <SectionHeader title="Needs your attention today" subtitle={subtitle} />
      <div className={styles.cardList}>
        {connectorComesFirst && connectorNudgeCard}
        {/* Onboarding activation — persistent, non-dismissible, and intentionally part of Today */}
        {showOnboardingActivationCard && (
          <div className={styles.card} data-testid="today-card" data-urgent={false}>
            <IconTile icon={MessageCircle} tone="connector" className={styles.setupStepIconTile} />
            <div className={styles.cardBody}>
              <p className={styles.cardTitle}>
                {numberedOnboardingActivationTitle}
              </p>
              <p className={styles.cardMeta} data-type="onboarding">
                Chat with Rebel for a few minutes so it can prioritise what matters.
              </p>
            </div>
            <Button
              type="button"
              variant="secondary"
              size="xs"
              className={styles.cardCta}
              data-testid="onboarding-activation-cta"
              onClick={onStartOnboardingIntro}
            >
              {hasAvailableOnboardingCoachSession ? 'Continue' : 'Start'}
            </Button>
          </div>
        )}
        {!connectorComesFirst && connectorNudgeCard}
        {showFirstUsefulActionCard && (
          <div className={styles.card} data-testid="today-card" data-urgent={false}>
            <IconTile icon={starterAction.icon} tone={starterAction.tone} className={styles.mutedIconTile} />
            <div className={styles.cardBody}>
              <p className={styles.cardTitle}>{starterAction.title}</p>
              <p className={styles.cardMeta} data-type="meeting">
                {starterAction.description}
              </p>
            </div>
            <Button
              type="button"
              variant="secondary"
              size="xs"
              className={styles.cardCta}
              data-state={firstUsefulActionDataState}
              onClick={handleFirstUsefulAction}
            >
              {firstUsefulActionLabel}
            </Button>
            <button
              type="button"
              className={styles.cardDismiss}
              onClick={(e) => {
                e.stopPropagation();
                setFirstUsefulActionDismissed(true);
              }}
              aria-label="Dismiss"
            >
              <X size={10} />
            </button>
          </div>
        )}
        {showLoadingPreview && (
          <div
            className={styles.loadingPreview}
            role="status"
            aria-live="polite"
            aria-busy={firstRunPassChecking || isLoading || undefined}
            aria-label="Your personalised cards will appear here soon."
          >
            <div className={styles.loadingPreviewHeader}>
              <span className={styles.loadingPreviewTitle}>
                Your personalised cards will appear here soon.
              </span>
            </div>
            {Array.from({ length: loadingPreviewCardCount }, (_, index) => (
              <div
                key={`skeleton-${index}`}
                className={`${styles.card} ${styles.skeletonCard}`}
                data-testid="today-card-skeleton"
                aria-hidden="true"
              >
                <div className={`${styles.skeletonBlock} ${styles.skeletonIcon}`} />
                <div className={styles.cardBody}>
                  <div className={`${styles.skeletonBlock} ${styles.skeletonTitle}`} />
                  <div className={`${styles.skeletonBlock} ${styles.skeletonMeta}`} />
                </div>
                <div className={`${styles.skeletonBlock} ${styles.skeletonCta}`} />
              </div>
            ))}
          </div>
        )}
        {!showLoadingPreview && isLoading && (displayItems.length > 0 || displaySuggestions.length > 0 || showOnboardingActivationCard || showRenderedConnectorNudge || showRenderedFocusNudge || showFirstUsefulActionCard) && (
          <div className={styles.inlineLoading} role="status" aria-live="polite" aria-label="Still checking for more items">
            <LoadingIndicator
              icon={Calendar}
              label={sourceStatus.meetingsLoading ? 'Checking your calendar' : 'Calendar checked'}
              done={!sourceStatus.meetingsLoading}
            />
            <LoadingIndicator
              icon={Inbox}
              label={sourceStatus.inboxLoading ? 'Pulling action items' : 'Actions checked'}
              done={!sourceStatus.inboxLoading}
            />
          </div>
        )}
        {showFirstRunSettledEmptyNote && (
          <div className={`${styles.card} ${styles.infoCard}`} role="status" aria-live="polite" data-testid="today-card" data-urgent={false}>
            <IconTile icon={Info} tone="neutral" className={styles.mutedIconTile} />
            <div className={styles.cardBody}>
              <p className={styles.cardTitle}>Still pulling context</p>
              <p className={styles.cardMeta} data-type="status-note">
                Rebel hasn&apos;t pulled enough from your connected tools yet. Calendar cards, Actions, and follow-ups will appear here once there&apos;s useful context to work with.
              </p>
            </div>
          </div>
        )}
        {firstRunPassFailed && !isLoading && (
          <div className={`${styles.card} ${styles.infoCard}`} role="status" aria-live="polite" data-testid="today-card" data-urgent={false}>
            <IconTile icon={Info} tone="neutral" className={styles.mutedIconTile} />
            <div className={styles.cardBody}>
              <p className={styles.cardTitle}>Still getting connected</p>
              <p className={styles.cardMeta} data-type="status-note">
                Rebel hasn&apos;t received useful calendar or Action data yet. You can keep going; cards will appear here as your tools finish syncing.
              </p>
            </div>
          </div>
        )}
        {/* Focus nudge — show when Focus is disabled but calendar data exists */}
        {showRenderedFocusNudge && (
          <FocusDiscoveryCard
            meetingCount={meetingCache.meetings.length}
            onEnableFocus={onEnableFocus}
            onDismiss={() => setFocusNudgeDismissed(true)}
          />
        )}
        {/* Urgent items — above threshold */}
        {displayItems.map((item) => (
          <TodayItemCard
            key={item.id}
            item={item}
            onStartMeetingPrep={onStartMeetingPrep}
            onOpenFile={onOpenFile}
            onOpenSession={onOpenSession}
            onNavigateToTeam={onNavigateToTeam}
            onDismiss={handleDismiss}
            onDismissAnimationEnd={handleDismissComplete}
            onAutoHide={handleAutoHide}
            isDismissing={dismissingIds.has(item.id)}
          />
        ))}
        {/* Suggestions — below threshold, de-emphasised */}
        {displaySuggestions.length > 0 && (
          <>
            {displaySuggestions.map((item) => (
              <TodayItemCard
                key={item.id}
                item={item}
                onStartMeetingPrep={onStartMeetingPrep}
                onOpenFile={onOpenFile}
                onOpenSession={onOpenSession}
                onNavigateToTeam={onNavigateToTeam}
                onDismiss={handleDismiss}
                onDismissAnimationEnd={handleDismissComplete}
                onAutoHide={handleAutoHide}
                isDismissing={dismissingIds.has(item.id)}
                isSuggestion
              />
            ))}
          </>
        )}
      </div>
      {totalCount > displayItems.length + displaySuggestions.length && (displayItems.length > 0 || displaySuggestions.length > 0) && onNavigateToInbox && (
        <Button variant="ghost" size="sm" className={styles.showAll} onClick={() => { tracking.homepage.todayShowAllClicked(totalCount); onNavigateToInbox(); }}>
          View all actions <ChevronRight size={14} />
        </Button>
      )}
    </section>
  );
}
