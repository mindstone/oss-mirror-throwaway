/**
 * WeeklyPrepCard — Shows the latest Focus Weekly Prep automation result,
 * or a branded loading state while Rebel is generating one.
 *
 * Three states:
 *   1. **Complete** — latest successful prep (< 7 days old). Shows preview + "Continue conversation".
 *   2. **Generating** — automation running. Subtle pulse + rotating Rebel-voice quips.
 *   3. **Empty + auto-trigger** — no prep and no run in progress. Triggers the automation,
 *      then transitions to state 2.
 *
 * Auto-trigger fires at most once per mount to avoid loops.
 * The `onAutomationState` subscription keeps all states in sync.
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import { RefreshCw } from 'lucide-react';
import { tracking } from '../../../src/tracking';
import { SafeMarkdown } from '@renderer/components/SafeMarkdown';
import styles from './WeeklyPrepCard.module.css';

// ─────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────

interface PrepInfo {
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

interface WeeklyPrepCardProps {
  enabled: boolean;
  /** When false, shows a branded empty state and skips all automation effects. Default: true. */
  isCurrentPeriod?: boolean;
  periodStart?: number;
  periodEnd?: number;
  onOpenConversation?: (sessionId: string) => void;
  onStartConversation?: (prompt: string) => void;
  /** Send a message to an existing session and navigate to it */
  onContinueConversation?: (sessionId: string, message: string) => void;
}

// ─────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────

const FOCUS_PREP_AUTOMATION_ID = 'system-focus-weekly-prep';
const ONE_WEEK_MS = 7 * 24 * 60 * 60 * 1000;
const FAILURE_COOLDOWN_MS = 60 * 60 * 1000;
const QUIP_ROTATION_MS = 6_000;

/**
 * Prompt chips shown below the briefing in the complete state.
 * Same prompts as FocusChatCTA (minus "Goal strategy" — goals now have their own CTAs in GoalsSidebar).
 */
const FOCUS_PROMPTS = [
  { label: 'Plan my week', promptType: 'plan_week' as const, prompt: 'Help me plan my week. What should I focus on and when?' },
  { label: 'Priorities', promptType: 'priorities' as const, prompt: 'Based on my goals and calendar, what should I prioritise this week?' },
  { label: 'Meeting audit', promptType: 'meeting_audit' as const, prompt: 'Review my meetings this week. Which ones are essential, which could be shorter or async?' },
] as const;

type FocusPromptType = (typeof FOCUS_PROMPTS)[number]['promptType'];

/**
 * Rebel-voice quips shown while the weekly prep is being generated.
 * Cultural depth, dry wit, self-aware — matching BRAND_VOICE.md.
 */
const PREP_QUIPS = [
  'Reading your calendar. The calendar is reading me back.',
  'Classifying meetings by strategic value. Some are not taking it well.',
  'Forming opinions about your Wednesday. Give me a moment.',
  'Studying the week ahead. There are things to discuss.',
  'Surveying the terrain before committing to recommendations.',
  'Checking your goals against your calendar. The alignment is... interesting.',
  'Auditing recurring meetings. Some have been furniture for months.',
  'Separating the strategic from the ceremonial.',
  'Cross-referencing what you said matters with where your time actually goes.',
  'Drafting a honest assessment. Honesty takes a moment.',
  'Weighing your week like a sommelier noses a glass. Notes of ambition, traces of overcommitment.',
  'Consulting the primary sources. Your calendar does not lie, though it does exaggerate.',
] as const;

// ─────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────

function extractTextFromSession(session: {
  messages?: Array<{ role: string; text?: string }>;
  eventsByTurn?: Record<string, Array<{ type: string; text?: string }>>;
}): string {
  // 1. Try assistant message from messages array
  const assistantMsg = session.messages?.find((m) => m.role === 'assistant');
  if (assistantMsg?.text) {
    return assistantMsg.text.trim();
  }

  // 2. Legacy fallback — reconstruct from `assistant_delta` events for sessions
  // persisted before Stage 2 of the 260508 active-work CPU/GPU rebuild. Stage 2
  // (R2-3) stops appending `assistant_delta` to the main accumulator, so newer
  // sessions never reach this branch. Kept for backwards compatibility with
  // pre-Stage-2 stored automation sessions only — do not remove.
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
  const [index, setIndex] = useState(() => Math.floor(Math.random() * PREP_QUIPS.length));

  useEffect(() => {
    if (!active) return;
    const interval = setInterval(() => {
      setIndex((prev) => (prev + 1) % PREP_QUIPS.length);
    }, QUIP_ROTATION_MS);
    return () => clearInterval(interval);
  }, [active]);

  return PREP_QUIPS[index];
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

export function WeeklyPrepCard({ enabled, isCurrentPeriod = true, periodStart, periodEnd, onOpenConversation, onStartConversation, onContinueConversation }: WeeklyPrepCardProps) {
  const [cardState, setCardState] = useState<CardState>('loading');
  const [prep, setPrep] = useState<PrepInfo | null>(null);
  /** All successful preps (newest first) for temporal navigation */
  const [allPreps, setAllPreps] = useState<Array<{ sessionId: string; completedAt: number }>>([]);
  /** Current navigation index (0 = most recent) */
  const [navIndex, setNavIndex] = useState(0);
  const autoTriggered = useRef(false);
  const quip = useRotatingQuip(cardState === 'generating');

  // Reset navigation when the viewed period changes
  useEffect(() => { setNavIndex(0); }, [periodStart]);

  const checkForRunning = useCallback((runs: AutomationRunSnapshot[]) => {
    return runs.some(
      (r) => r.automationId === FOCUS_PREP_AUTOMATION_ID && r.status === 'running',
    );
  }, []);

  const findLatestRun = useCallback((runs: AutomationRunSnapshot[]) => {
    const prepRuns = runs
      .filter((r) => r.automationId === FOCUS_PREP_AUTOMATION_ID)
      .sort((a, b) => getRunTimestamp(b) - getRunTimestamp(a));

    return prepRuns[0] ?? null;
  }, []);

  // Find ALL successful preps (newest first) — no time limit
  const findAllPreps = useCallback(
    (runs: AutomationRunSnapshot[]) => {
      let filtered = runs.filter(
        (r): r is AutomationRunSnapshot & { sessionId: string } =>
          r.automationId === FOCUS_PREP_AUTOMATION_ID &&
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

  // Auto-trigger: only if no recent prep (< 7 days)
  const triggerPrepIfNeeded = useCallback(
    async (runs: AutomationRunSnapshot[]) => {
      if (autoTriggered.current) return;
      const preps = findAllPreps(runs);
      const hasRecent = preps.length > 0 && preps[0].completedAt > Date.now() - ONE_WEEK_MS;
      const isRunning = checkForRunning(runs);
      const latestRun = findLatestRun(runs);
      const hasRecentFailure =
        latestRun?.status === 'failure' &&
        getRunTimestamp(latestRun) > Date.now() - FAILURE_COOLDOWN_MS;
      if (hasRecent || isRunning || hasRecentFailure) return;

      autoTriggered.current = true;
      try {
        await window.automationsApi?.runNow?.(FOCUS_PREP_AUTOMATION_ID);
      } catch {
        // Card stays in generating state
      }
    },
    [findAllPreps, checkForRunning, findLatestRun],
  );

  const loadBriefingText = useCallback(async (sessionId: string): Promise<string> => {
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
      const preps = findAllPreps(runs);
      setAllPreps(preps);

      // Running automation takes priority — but only for current period.
      // Historical views should not show "generating" because a different period is running.
      if (isCurrentPeriod && checkForRunning(runs)) {
        setCardState('generating');
        return;
      }

      if (preps.length > 0) {
        const idx = Math.min(navIndex, preps.length - 1);
        const target = preps[idx];
        const preview = await loadBriefingText(target.sessionId);
        setPrep({ ...target, preview });
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
    [findAllPreps, checkForRunning, findLatestRun, loadBriefingText, navIndex, isCurrentPeriod],
  );

  useEffect(() => {
    if (!enabled) return;

    const loadInitial = async () => {
      try {
        const state = await window.automationsApi?.state?.();
        if (!state) return;

        void processState(state.runs);
        // Only auto-trigger for current period
        if (isCurrentPeriod) {
          void triggerPrepIfNeeded(state.runs);
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
  }, [enabled, isCurrentPeriod, processState, triggerPrepIfNeeded]);

  const handleClick = useCallback(() => {
    if (prep?.sessionId && onOpenConversation) {
      onOpenConversation(prep.sessionId);
    }
  }, [prep?.sessionId, onOpenConversation]);

  const handleRetry = useCallback(() => {
    autoTriggered.current = false;
    setCardState('generating');
    void Promise.resolve()
      .then(() => window.automationsApi?.runNow?.(FOCUS_PREP_AUTOMATION_ID))
      .catch(() => {
        setCardState('failed');
      });
  }, []);



  const handleChipClick = useCallback(
    (prompt: string, promptType: FocusPromptType) => {
      tracking.focus?.conversationStarted(promptType, 0, 0, false);
      onStartConversation?.(prompt);
    },
    [onStartConversation],
  );

  // Navigate to an older/newer prep
  const goToPrev = useCallback(async () => {
    const nextIdx = navIndex + 1;
    if (nextIdx >= allPreps.length) return;
    setNavIndex(nextIdx);
    const target = allPreps[nextIdx];
    const preview = await loadBriefingText(target.sessionId);
    setPrep({ ...target, preview });
  }, [navIndex, allPreps, loadBriefingText]);

  const goToNext = useCallback(async () => {
    const nextIdx = navIndex - 1;
    if (nextIdx < 0) return;
    setNavIndex(nextIdx);
    const target = allPreps[nextIdx];
    const preview = await loadBriefingText(target.sessionId);
    setPrep({ ...target, preview });
  }, [navIndex, allPreps, loadBriefingText]);

  const hasPrev = navIndex < allPreps.length - 1;
  const hasNext = navIndex > 0;

  // ── Loading (initial fetch) ──
  if (cardState === 'loading') return null;

  // ── Non-current period: branded empty state ──
  if (!isCurrentPeriod && cardState !== 'complete') {
    return (
      <div className={styles.card} data-testid="weekly-prep-card" data-state="empty">
        <div className={styles.header}>
          <span className={styles.label}>Weekly Briefing</span>
        </div>
        <p className={styles.statusHint} style={{ opacity: 1, fontSize: '0.82rem' }}>
          No briefing was generated for this week.
        </p>
      </div>
    );
  }

  // ── Generating ──
  if (cardState === 'generating') {
    return (
      <div className={styles.card} data-testid="weekly-prep-card-generating" data-state="generating">
        <div className={styles.header}>
          <span className={styles.label}>Weekly Briefing</span>
          <span className={styles.statusDot} />
        </div>
        <p className={styles.quip} key={quip}>{quip}</p>
        <p className={styles.statusHint}>Rebel is reading your week</p>
      </div>
    );
  }

  if (cardState === 'failed') {
    return (
      <div className={styles.card} data-testid="weekly-prep-card-failed" data-state="failed">
        <div className={styles.header}>
          <span className={styles.label}>Weekly Briefing</span>
          <span className={styles.time}>Paused</span>
        </div>
        <p className={styles.errorText}>The weekly prep hit a snag. These things happen.</p>
        <button className={styles.retryButton} onClick={handleRetry} type="button">
          Try again
        </button>
      </div>
    );
  }

  // ── Complete (prep is guaranteed non-null when cardState is 'complete') ──
  if (!prep) return null;

  return (
    <div
      className={styles.card}
      data-testid="weekly-prep-card"
      data-state="complete"
    >
      <div className={styles.header}>
        <span className={styles.label}>Weekly Briefing</span>
        <div className={styles.headerRight}>
          {allPreps.length > 1 && (
            <div className={styles.navArrows}>
              <button className={styles.navArrow} onClick={goToPrev} disabled={!hasPrev} type="button" aria-label="Previous week">&lsaquo;</button>
              <button className={styles.navArrow} onClick={goToNext} disabled={!hasNext} type="button" aria-label="Next week">&rsaquo;</button>
            </div>
          )}
          <span className={styles.time}>{getTimeAgo(prep.completedAt)}</span>
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
      {prep.preview && <BriefingText text={prep.preview} />}
      {onStartConversation && (
        <div className={styles.promptChips}>
          {FOCUS_PROMPTS.map(({ label, promptType, prompt }) => (
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
      {isCurrentPeriod && prep.sessionId && (
        <ContinueInput
          sessionId={prep.sessionId}
          onContinue={onContinueConversation}
          onOpen={onOpenConversation}
        />
      )}
    </div>
  );
}
