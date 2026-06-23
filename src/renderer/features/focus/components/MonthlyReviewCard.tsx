/**
 * MonthlyReviewCard — Shows the latest Focus Monthly Review automation result,
 * or a branded loading state while Rebel is generating one.
 *
 * Mirrors WeeklyPrepCard structure for the Month tab.
 * Auto-triggers the monthly review if no recent one exists (< 35 days).
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import { RefreshCw } from 'lucide-react';
import { tracking } from '../../../src/tracking';
import { SafeMarkdown } from '@renderer/components/SafeMarkdown';
import styles from './MonthlyReviewCard.module.css';

// ─────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────

interface ReviewInfo {
  sessionId: string;
  completedAt: number;
  preview: string;
}

type CardState = 'loading' | 'generating' | 'complete' | 'failed';

interface AutomationRunSnapshot {
  automationId: string;
  status: string;
  sessionId?: string | null;
  startedAt?: number | null;
  completedAt?: number | null;
  targetPeriodStart?: number;
}

interface MonthlyReviewCardProps {
  enabled: boolean;
  /** When false, shows a branded empty state and skips all automation effects. Default: true. */
  isCurrentPeriod?: boolean;
  periodStart?: number;
  periodEnd?: number;
  onOpenConversation?: (sessionId: string) => void;
  onStartConversation?: (prompt: string) => void;
  onContinueConversation?: (sessionId: string, message: string) => void;
}

// ─────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────

const MONTHLY_REVIEW_AUTOMATION_ID = 'system-focus-monthly-review';
const THIRTY_FIVE_DAYS_MS = 35 * 24 * 60 * 60 * 1000;
const FAILURE_COOLDOWN_MS = 60 * 60 * 1000;
const QUIP_ROTATION_MS = 6_000;

const MONTHLY_PROMPTS = [
  { label: 'Review my month', promptType: 'review_month' as const, prompt: 'Help me review my month. What patterns do you see in how I spent my time?' },
  { label: 'Goal progress', promptType: 'goal_progress' as const, prompt: 'How am I tracking against my goals this quarter? What needs to change?' },
  { label: 'Next month', promptType: 'plan_month' as const, prompt: 'Based on this month, what should I focus on next month?' },
] as const;

type MonthlyPromptType = (typeof MONTHLY_PROMPTS)[number]['promptType'];

const REVIEW_QUIPS = [
  'Reviewing thirty days of evidence. Some of it is flattering.',
  'Comparing your goals to your calendar. The calendar has a different story.',
  'Measuring patterns across four weeks. Patterns are patient.',
  'Auditing where the time actually went. Time keeps its own ledger.',
  'Looking for the signal in a month of noise.',
  'Assessing goal progress. Some goals have been quietly ambitious. Others, quietly absent.',
  'Tracing the arc of your month. Every arc has a thesis.',
  'Weighing meeting trends against stated priorities. The scales are honest.',
  'Excavating insights from 30 days of data. Archaeology takes a moment.',
  'Composing the retrospective. Hindsight demands both honesty and tact.',
] as const;

// ─────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────

function extractTextFromSession(session: {
  messages?: Array<{ role: string; text?: string }>;
  eventsByTurn?: Record<string, Array<{ type: string; text?: string }>>;
}): string {
  const assistantMsg = session.messages?.find((m) => m.role === 'assistant');
  if (assistantMsg?.text) {
    return assistantMsg.text.trim();
  }

  // Legacy fallback — reconstruct from `assistant_delta` events for sessions
  // persisted before Stage 2 of the 260508 active-work CPU/GPU rebuild.
  // Stage 2 (R2-3) stops appending `assistant_delta` to the main accumulator,
  // so newer sessions never reach this branch. Kept for backwards
  // compatibility with pre-Stage-2 stored sessions only — do not remove.
  if (session.eventsByTurn) {
    for (const events of Object.values(session.eventsByTurn)) {
      const deltas = events.flatMap((e) =>
        e.type === 'assistant_delta' && e.text ? [e.text] : [],
      );
      if (deltas.length > 0) {
        return deltas.join('').trim();
      }
    }
  }

  return '';
}

function ContinueInput({ sessionId, onContinue, onOpen }: {
  sessionId: string;
  onContinue?: (sessionId: string, message: string) => void;
  onOpen?: (sessionId: string) => void;
}) {
  const [value, setValue] = useState('');
  const handleSubmit = useCallback((e: React.FormEvent) => {
    e.preventDefault();
    const text = value.trim();
    if (text && onContinue) {
      onContinue(sessionId, text);
      setValue('');
    } else if (onOpen) {
      onOpen(sessionId);
    }
  }, [value, sessionId, onContinue, onOpen]);

  return (
    <form className={styles.continueForm} onSubmit={handleSubmit}>
      <input
        className={styles.continueInput}
        type="text"
        placeholder="Continue this conversation..."
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSubmit(e); } }}
      />
      <button className={styles.continueSend} type="submit" aria-label="Send">
        &rarr;
      </button>
    </form>
  );
}

function BriefingText({ text }: { text: string }) {
  const [expanded, setExpanded] = useState(false);
  const needsTruncation = text.split('\n').length > 10 || text.length > 600;

  return (
    <div className={styles.briefingWrapper}>
      <div className={`${styles.preview}${!expanded && needsTruncation ? ` ${styles.previewClamped}` : ''}`}>
        <SafeMarkdown className={styles.briefingMarkdown}>{text}</SafeMarkdown>
      </div>
      {needsTruncation && (
        <button
          className={styles.readMore}
          onClick={(e) => { e.stopPropagation(); setExpanded(!expanded); }}
          type="button"
        >
          {expanded ? 'Show less' : 'Read more'}
        </button>
      )}
    </div>
  );
}

function getTimeAgo(timestamp: number): string {
  const diff = Date.now() - timestamp;
  const hours = Math.floor(diff / (1000 * 60 * 60));
  if (hours < 1) return 'Just now';
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

function getRunTimestamp(run: AutomationRunSnapshot): number {
  return run.completedAt ?? run.startedAt ?? 0;
}

// ─────────────────────────────────────────────────────────────
// Hook: rotating quip index
// ─────────────────────────────────────────────────────────────

function useRotatingQuip(active: boolean): string {
  const [index, setIndex] = useState(() => Math.floor(Math.random() * REVIEW_QUIPS.length));

  useEffect(() => {
    if (!active) return;
    const interval = setInterval(() => {
      setIndex((prev) => (prev + 1) % REVIEW_QUIPS.length);
    }, QUIP_ROTATION_MS);
    return () => clearInterval(interval);
  }, [active]);

  return REVIEW_QUIPS[index];
}

function matchesPeriod(
  run: AutomationRunSnapshot,
  periodStart: number,
  periodEnd: number,
): boolean {
  if (run.targetPeriodStart != null) {
    return run.targetPeriodStart === periodStart;
  }
  const ts = run.completedAt ?? run.startedAt;
  return ts != null && ts >= periodStart && ts <= periodEnd;
}

// ─────────────────────────────────────────────────────────────
// Component
// ─────────────────────────────────────────────────────────────

export function MonthlyReviewCard({ enabled, isCurrentPeriod = true, periodStart, periodEnd, onOpenConversation, onStartConversation, onContinueConversation }: MonthlyReviewCardProps) {
  const [cardState, setCardState] = useState<CardState>('loading');
  const [review, setReview] = useState<ReviewInfo | null>(null);
  const [allReviews, setAllReviews] = useState<Array<{ sessionId: string; completedAt: number }>>([]);
  const [navIndex, setNavIndex] = useState(0);
  const autoTriggered = useRef(false);
  const quip = useRotatingQuip(cardState === 'generating');

  // Reset navigation when the viewed period changes
  useEffect(() => { setNavIndex(0); }, [periodStart]);

  const checkForRunning = useCallback((runs: AutomationRunSnapshot[]) => {
    return runs.some(
      (r) => r.automationId === MONTHLY_REVIEW_AUTOMATION_ID && r.status === 'running',
    );
  }, []);

  const findLatestRun = useCallback((runs: AutomationRunSnapshot[]) => {
    const reviewRuns = runs
      .filter((r) => r.automationId === MONTHLY_REVIEW_AUTOMATION_ID)
      .sort((a, b) => getRunTimestamp(b) - getRunTimestamp(a));

    return reviewRuns[0] ?? null;
  }, []);

  const findAllReviews = useCallback(
    (runs: AutomationRunSnapshot[]) => {
      let filtered = runs.filter(
        (r): r is AutomationRunSnapshot & { sessionId: string } =>
          r.automationId === MONTHLY_REVIEW_AUTOMATION_ID &&
          r.status === 'success' &&
          typeof r.sessionId === 'string' &&
          r.sessionId.length > 0,
      );
      if (periodStart != null && periodEnd != null) {
        filtered = filtered.filter(r => matchesPeriod(r, periodStart, periodEnd));
      }
      return filtered
        .sort((a, b) => (b.completedAt ?? 0) - (a.completedAt ?? 0))
        .map(r => ({ sessionId: r.sessionId, completedAt: r.completedAt ?? Date.now() }));
    },
    [periodStart, periodEnd],
  );

  const triggerReviewIfNeeded = useCallback(
    async (runs: AutomationRunSnapshot[]) => {
      if (autoTriggered.current) return;
      const reviews = findAllReviews(runs);
      const hasRecent = reviews.length > 0 && reviews[0].completedAt > Date.now() - THIRTY_FIVE_DAYS_MS;
      const isRunning = checkForRunning(runs);
      const latestRun = findLatestRun(runs);
      const hasRecentFailure =
        latestRun?.status === 'failure' &&
        getRunTimestamp(latestRun) > Date.now() - FAILURE_COOLDOWN_MS;
      if (hasRecent || isRunning || hasRecentFailure) return;

      autoTriggered.current = true;
      try {
        await window.automationsApi?.runNow?.(MONTHLY_REVIEW_AUTOMATION_ID);
      } catch {
        // Card stays in generating state
      }
    },
    [findAllReviews, checkForRunning, findLatestRun],
  );

  const loadPreview = useCallback(async (sessionId: string): Promise<string> => {
    try {
      const session = await window.sessionsApi?.get?.({ id: sessionId });
      if (!session) return '';
      return extractTextFromSession(session);
    } catch {
      return '';
    }
  }, []);

  const processState = useCallback(
    async (runs: AutomationRunSnapshot[]) => {
      const reviews = findAllReviews(runs);
      setAllReviews(reviews);

      // Running automation takes priority — but only for current period.
      // Historical views should not show "generating" because a different period is running.
      if (isCurrentPeriod && checkForRunning(runs)) {
        setCardState('generating');
        return;
      }

      if (reviews.length > 0) {
        const idx = Math.min(navIndex, reviews.length - 1);
        const target = reviews[idx];
        const preview = await loadPreview(target.sessionId);
        setReview({ ...target, preview });
        setCardState('complete');
        return;
      }

      if (isCurrentPeriod && findLatestRun(runs)?.status === 'failure') {
        setCardState('failed');
        return;
      }

      if (isCurrentPeriod) {
        setCardState('generating');
      }
    },
    [findAllReviews, checkForRunning, findLatestRun, loadPreview, navIndex, isCurrentPeriod],
  );

  useEffect(() => {
    if (!enabled) return;

    const loadInitial = async () => {
      try {
        const state = await window.automationsApi?.state?.();
        if (!state) return;
        void processState(state.runs);
        if (isCurrentPeriod) {
          void triggerReviewIfNeeded(state.runs);
        }
      } catch {
        if (isCurrentPeriod) {
          setCardState('generating');
        }
      }
    };

    void loadInitial();

    const unsubscribe = window.api?.onAutomationState?.((state) => {
      void processState(state.runs);
    });

    return () => unsubscribe?.();
  }, [enabled, isCurrentPeriod, processState, triggerReviewIfNeeded]);

  const handleClick = useCallback(() => {
    if (review?.sessionId && onOpenConversation) {
      onOpenConversation(review.sessionId);
    }
  }, [review?.sessionId, onOpenConversation]);

  const handleRetry = useCallback(() => {
    autoTriggered.current = false;
    setCardState('generating');
    void Promise.resolve()
      .then(() => window.automationsApi?.runNow?.(MONTHLY_REVIEW_AUTOMATION_ID))
      .catch(() => {
        setCardState('failed');
      });
  }, []);

  const handleChipClick = useCallback(
    (prompt: string, promptType: MonthlyPromptType) => {
      tracking.focus?.conversationStarted(promptType, 0, 0, false);
      onStartConversation?.(prompt);
    },
    [onStartConversation],
  );

  const goToPrev = useCallback(async () => {
    const nextIdx = navIndex + 1;
    if (nextIdx >= allReviews.length) return;
    setNavIndex(nextIdx);
    const target = allReviews[nextIdx];
    const preview = await loadPreview(target.sessionId);
    setReview({ ...target, preview });
  }, [navIndex, allReviews, loadPreview]);

  const goToNext = useCallback(async () => {
    const nextIdx = navIndex - 1;
    if (nextIdx < 0) return;
    setNavIndex(nextIdx);
    const target = allReviews[nextIdx];
    const preview = await loadPreview(target.sessionId);
    setReview({ ...target, preview });
  }, [navIndex, allReviews, loadPreview]);

  const hasPrev = navIndex < allReviews.length - 1;
  const hasNext = navIndex > 0;

  if (cardState === 'loading') return null;

  // ── Non-current period: branded empty state ──
  if (!isCurrentPeriod && cardState !== 'complete') {
    return (
      <div className={styles.card} data-testid="monthly-review-card" data-state="empty">
        <div className={styles.header}>
          <span className={styles.label}>Monthly Review</span>
        </div>
        <p className={styles.statusHint} style={{ opacity: 1, fontSize: '0.82rem' }}>
          No review was generated for this month.
        </p>
      </div>
    );
  }

  if (cardState === 'generating') {
    return (
      <div className={styles.card} data-testid="monthly-review-card-generating" data-state="generating">
        <div className={styles.header}>
          <span className={styles.label}>Monthly Briefing</span>
          <span className={styles.statusDot} />
        </div>
        <p className={styles.quip} key={quip}>{quip}</p>
        <p className={styles.statusHint}>Rebel is reviewing your month</p>
      </div>
    );
  }

  if (cardState === 'failed') {
    return (
      <div className={styles.card} data-testid="monthly-review-card-failed" data-state="failed">
        <div className={styles.header}>
          <span className={styles.label}>Monthly Briefing</span>
          <span className={styles.time}>Paused</span>
        </div>
        <p className={styles.errorText}>The monthly review hit a snag. These things happen.</p>
        <button className={styles.retryButton} onClick={handleRetry} type="button">
          Try again
        </button>
      </div>
    );
  }

  if (!review) return null;

  return (
    <div
      className={styles.card}
      data-testid="monthly-review-card"
      data-state="complete"
    >
      <div className={styles.header}>
        <span className={styles.label}>Monthly Briefing</span>
        <div className={styles.headerRight}>
          {allReviews.length > 1 && (
            <div className={styles.navArrows}>
              <button className={styles.navArrow} onClick={goToPrev} disabled={!hasPrev} type="button" aria-label="Previous month">&lsaquo;</button>
              <button className={styles.navArrow} onClick={goToNext} disabled={!hasNext} type="button" aria-label="Next month">&rsaquo;</button>
            </div>
          )}
          <span className={styles.time}>{getTimeAgo(review.completedAt)}</span>
          {isCurrentPeriod && (
            <button
              className={styles.reBriefButton}
              onClick={handleRetry}
              type="button"
              aria-label="Re-brief"
              title="Generate a fresh briefing"
            >
              <RefreshCw size={11} />
            </button>
          )}
        </div>
      </div>
      {review.preview && <BriefingText text={review.preview} />}
      {onStartConversation && (
        <div className={styles.promptChips}>
          {MONTHLY_PROMPTS.map(({ label, promptType, prompt }) => (
            <button
              key={promptType}
              className={styles.chip}
              onClick={() => handleChipClick(prompt, promptType)}
              type="button"
            >
              {label}
            </button>
          ))}
        </div>
      )}
      {isCurrentPeriod && review.sessionId && (
        <ContinueInput
          sessionId={review.sessionId}
          onContinue={onContinueConversation}
          onOpen={onOpenConversation}
        />
      )}
    </div>
  );
}
