/**
 * CoachSection - "What could I be doing differently?"
 *
 * One branded card with the Rebel mascot aligned to the header area.
 * ALL content (coaching insights + suggestions) flows through a single
 * carousel — one card visible at a time, left/right to navigate.
 *
 * Insight cards: session title (bold) + insight text (muted, 5-line clamp) + date + actions.
 * Suggestion cards: title (bold) + description (muted) + CTA.
 *
 * All functionality preserved: explore, dismiss, thumbs up/down, tracking.
 */

import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { ChevronRight, ChevronLeft, X, ThumbsUp, ThumbsDown, Trophy, Lightbulb, Calendar, Wrench, Zap, Brain, Settings, Loader2, Info } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { Button, Tooltip } from '@renderer/components/ui';
import { useCoachingInsights, type CoachingInsightWithContext } from '../../usecases/hooks/useCoachingInsights';
import { useUseCaseLibrary } from '../../usecases/hooks/useUseCaseLibrary';
import { updateCoachingState } from '../../agent-session/hooks/useSessionCoaching';
import { tracking } from '@renderer/src/tracking';
import { formatHistoryTimestamp } from '@renderer/utils/formatters';
import { useCoachContent, type CoachSuggestion } from '../hooks/useCoachContent';
import { useHeroChoice } from '../hooks/useHeroChoice';
import { useNavigationSafe } from '@renderer/contexts/NavigationContext';
import { fireAndForget } from '@shared/utils/fireAndForget';
import type { HeroChoiceCandidate, HeroChoiceCandidateType } from '../../../../core/heroChoiceTypes';
import type { HomepageUserState } from '../hooks/useHomepageState';
import type { InboxItem, SessionCoachingCategory } from '@shared/types';
import type { UseCaseRecordIpc } from '@shared/ipc/channels/useCaseLibrary';
import styles from './CoachSection.module.css';

/**
 * Priority order for coaching insight categories, derived from
 * act-rate analysis (Feb 2026). Lower number = shown first in carousel.
 * Categories with higher historical act rates get priority placement
 * since most users only see the first 1–2 cards.
 */
const INSIGHT_CATEGORY_PRIORITY: Record<SessionCoachingCategory, number> = {
  automation_insight: 0,                 // wins, learnings, insights redirected from inbox
  skill_opportunity: 1,                  // 63% act rate
  deeper_research: 2,                    // 50% act rate
  follow_up_action: 3,                   // 42% act rate
  skill_personalization_opportunity: 4,  // 25% act rate
  document_generation: 5,               // 14% act rate
  related_context: 6,                    // 0% act rate (limited data)
  cross_reference: 7,                    // no data yet
};

// Static suggestion dismissals use localStorage (device-local, low-value data).
// Use case dismissals go through the IPC store (persisted to disk, synced with
// the main process) because they are user-generated content worth preserving.
const DISMISSED_SUGGESTIONS_KEY = 'rebel:coach:dismissed-suggestions';

const loadDismissedSuggestions = (): Set<string> => {
  try {
    const raw = localStorage.getItem(DISMISSED_SUGGESTIONS_KEY);
    if (!raw) return new Set();
    return new Set(JSON.parse(raw) as string[]);
  } catch {
    return new Set();
  }
};

const saveDismissedSuggestions = (ids: Set<string>): void => {
  try {
    localStorage.setItem(DISMISSED_SUGGESTIONS_KEY, JSON.stringify([...ids]));
  } catch {
    // localStorage unavailable — silently ignore
  }
};

/** SVG mascot — crisper than the PNG, distinct from the onboarding variant */
const REBEL_MASCOT_URL = 'https://storage.googleapis.com/mindstone-public-assets/rebel/rebel6.svg';

interface CoachSectionProps {
  userState: HomepageUserState;
  coachingSessionIds: Set<string>;
  onAct: (prompt: string) => void;
  onDismiss: (sessionId: string) => void;
  onOpenSession?: (sessionId: string) => void;
  /** Inbox items with insight prefixes (win:, learning:, etc.) that belong in Coach */
  insightInboxItems?: InboxItem[];
}

const MAX_CAROUSEL_ITEMS = 7;
const MAX_INSIGHT_ITEMS = 7;
const MAX_BACKFILL_ITEMS = 7;
const MAX_PER_CATEGORY = 3;
const AGE_DECAY_THRESHOLD_MS = 2 * 24 * 60 * 60 * 1000; // 2 days
const AGE_DECAY_PRIORITY_PENALTY = 10;
const AUTO_ROTATE_INTERVAL_MS = 15_000;

const HERO_TYPE_CONFIG: Record<HeroChoiceCandidateType, { icon: LucideIcon; label: string; urgent?: boolean }> = {
  meeting_prep: { icon: Calendar, label: 'Meeting Prep', urgent: true },
  coaching: { icon: Lightbulb, label: 'Coaching' },
  improvement: { icon: Wrench, label: 'Improvement' },
  use_case: { icon: Zap, label: 'Workflow' },
  insight: { icon: Brain, label: 'Insight' },
};

/** Strip leading emoji characters and whitespace from a string. */
function stripLeadingEmoji(text: string): string {
  return text.replace(/^[\p{Emoji_Presentation}\p{Extended_Pictographic}\u200d\ufe0f]+\s*/gu, '').trim();
}

/**
 * Determine a contextual icon for an insight based on its title prefix.
 * Returns null for insights that don't match a recognised pattern.
 */
function getInsightIcon(title: string): typeof Trophy | null {
  const lower = stripLeadingEmoji(title).toLowerCase();
  if (lower.startsWith('win:')) return Trophy;
  if (lower.startsWith('learning:') || lower.startsWith('insight:') || lower.startsWith('takeaway:')
    || lower.startsWith('decision:') || lower.startsWith('highlight:')) return Lightbulb;
  return null;
}

/** Convert Title Case text to sentence case (only first word capitalised). */
function toSentenceCase(text: string): string {
  if (!text) return text;
  return text.replace(/(?<=\s)[A-Z](?=[a-z])/g, c => c.toLowerCase());
}

/** Unified carousel item — hero choice, prompt, insight, inbox-insight, suggestion, or use case */
type CarouselItem =
  | { kind: 'hero'; data: HeroChoiceCandidate }
  | { kind: 'hero-prompt'; data: null }
  | { kind: 'insight'; data: CoachingInsightWithContext }
  | { kind: 'inbox-insight'; data: InboxItem }
  | { kind: 'suggestion'; data: CoachSuggestion }
  | { kind: 'usecase'; data: UseCaseRecordIpc };

/**
 * Renders a single carousel card for a coaching insight.
 */
function InsightCardContent({
  insight,
  feedbackGiven,
  onAct,
  onDismiss,
  onViewSession,
  onThumbsUp,
  onThumbsDown,
}: {
  insight: CoachingInsightWithContext;
  feedbackGiven: 'up' | 'down' | null;
  onAct: () => void;
  onDismiss: () => void;
  onViewSession: () => void;
  onThumbsUp: () => void;
  onThumbsDown: () => void;
}) {
  const isAutomationInsight = insight.evaluation.primaryInsight.category === 'automation_insight';

  const ctaLabel =
    insight.evaluation.primaryInsight.category === 'skill_opportunity'
      ? 'Try this skill'
      : insight.evaluation.primaryInsight.category === 'skill_personalization_opportunity'
      ? 'Personalize this'
      : isAutomationInsight
      ? 'Learn more'
      : 'Explore this';

  const description = isAutomationInsight && insight.evaluation.primaryInsight.context
    ? insight.evaluation.primaryInsight.context
    : insight.evaluation.primaryInsight.insight;

  const sourceLabel = isAutomationInsight
    ? insight.evaluation.primaryInsight.sources?.[0]
    : undefined;

  const handleViewSession = isAutomationInsight ? undefined : onViewSession;

  const InsightIcon = isAutomationInsight ? getInsightIcon(insight.sessionTitle) : null;

  return (
    <>
      <div className={styles.cardItemHeader}>
        <p className={styles.cardItemTitle} title={stripLeadingEmoji(insight.sessionTitle)}>
          {InsightIcon && <InsightIcon size={12} className={styles.insightTypeIcon} />}
          {toSentenceCase(stripLeadingEmoji(insight.sessionTitle))}
        </p>
        <button
          type="button"
          className={styles.dismissBtn}
          onClick={onDismiss}
          aria-label="Not now"
        >
          <X size={14} />
        </button>
      </div>
      {sourceLabel && (
        <p className={styles.cardItemSource}>From {sourceLabel}</p>
      )}
      <p className={styles.cardItemDescription}>
        {description}
      </p>
      <div className={styles.cardItemFooter}>
        {handleViewSession ? (
          <button type="button" className={styles.dateLink} onClick={handleViewSession}>
            {formatHistoryTimestamp(insight.evaluation.evaluatedAt)}
          </button>
        ) : (
          <span className={styles.dateLink} style={{ cursor: 'default' }}>
            {formatHistoryTimestamp(insight.evaluation.evaluatedAt)}
          </span>
        )}
        <span className={styles.footerDivider} />
        <div className={styles.feedbackGroup}>
          <button
            type="button"
            className={styles.thumbBtn}
            onClick={onThumbsUp}
            aria-label="This was helpful"
            data-active={feedbackGiven === 'up'}
          >
            <ThumbsUp size={12} />
          </button>
          <button
            type="button"
            className={styles.thumbBtn}
            onClick={onThumbsDown}
            aria-label="Not helpful"
            data-active={feedbackGiven === 'down'}
          >
            <ThumbsDown size={12} />
          </button>
        </div>
        <Button variant="secondary" size="sm" className={`${styles.actionCta} ${styles.actionCtaPrimary}`} onClick={onAct}>
          {ctaLabel} <ChevronRight size={14} />
        </Button>
      </div>
    </>
  );
}

/**
 * Renders a single carousel card for a static suggestion.
 */
function SuggestionCardContent({
  suggestion,
  onAct,
  onDismiss,
}: {
  suggestion: CoachSuggestion;
  onAct: () => void;
  onDismiss: () => void;
}) {
  return (
    <>
      <div className={styles.cardItemHeader}>
        <p className={styles.cardItemTitle}>{toSentenceCase(suggestion.title)}</p>
        <button
          type="button"
          className={styles.dismissBtn}
          onClick={onDismiss}
          aria-label="Not now"
        >
          <X size={14} />
        </button>
      </div>
      <p className={styles.cardItemDescription}>{suggestion.description}</p>
      <div className={styles.cardItemFooter}>
        <Button variant="secondary" size="sm" className={`${styles.actionCta} ${styles.actionCtaPrimary}`} onClick={onAct}>
          {suggestion.ctaLabel} <ChevronRight size={14} />
        </Button>
      </div>
    </>
  );
}

/**
 * Renders a single carousel card for a use case from the library.
 */
function UseCaseCardContent({
  useCase,
  onAct,
  onDismiss,
}: {
  useCase: UseCaseRecordIpc;
  onAct: () => void;
  onDismiss: () => void;
}) {
  return (
    <>
      <div className={styles.cardItemHeader}>
        <p className={styles.cardItemTitle}>{toSentenceCase(useCase.title)}</p>
        <button
          type="button"
          className={styles.dismissBtn}
          onClick={onDismiss}
          aria-label="Not now"
        >
          <X size={14} />
        </button>
      </div>
      <p className={styles.cardItemDescription}>{useCase.description}</p>
      <div className={styles.cardItemFooter}>
        <Button variant="secondary" size="sm" className={`${styles.actionCta} ${styles.actionCtaPrimary}`} onClick={onAct}>
          Try this <ChevronRight size={14} />
        </Button>
      </div>
    </>
  );
}

/**
 * Renders a carousel card for an inbox item with an insight prefix
 * (win:, learning:, decision:, etc.) that should have been redirected
 * to Coach at write-time but ended up in the inbox.
 */
function InboxInsightCardContent({
  item,
  onAct,
  onDismiss,
}: {
  item: InboxItem;
  onAct: () => void;
  onDismiss: () => void;
}) {
  const cleanTitle = stripLeadingEmoji(item.title);
  const Icon = getInsightIcon(item.title);
  const sourceLabel = item.source && 'label' in item.source ? item.source.label : undefined;

  return (
    <>
      <div className={styles.cardItemHeader}>
        <p className={styles.cardItemTitle} title={cleanTitle}>
          {Icon && <Icon size={12} className={styles.insightTypeIcon} />}
          {toSentenceCase(cleanTitle)}
        </p>
        <button
          type="button"
          className={styles.dismissBtn}
          onClick={onDismiss}
          aria-label="Not now"
        >
          <X size={14} />
        </button>
      </div>
      {sourceLabel && (
        <p className={styles.cardItemSource}>From {sourceLabel}</p>
      )}
      {item.text && (
        <p className={styles.cardItemDescription}>{item.text}</p>
      )}
      <div className={styles.cardItemFooter}>
        <span className={styles.dateLink} style={{ cursor: 'default' }}>
          {formatHistoryTimestamp(item.addedAt)}
        </span>
        <span className={styles.footerDivider} />
        <Button variant="secondary" size="sm" className={`${styles.actionCta} ${styles.actionCtaPrimary}`} onClick={onAct}>
          Learn more <ChevronRight size={14} />
        </Button>
      </div>
    </>
  );
}

/**
 * Renders a single carousel card for a hero choice candidate.
 * Preserves the type badge + headline + body layout from the standalone HeroCard.
 */
function HeroCardContent({
  candidate,
  feedbackGiven,
  onAct,
  onDismiss,
  onThumbsUp,
  onThumbsDown,
  onOpenSettings,
}: {
  candidate: HeroChoiceCandidate;
  feedbackGiven: 'up' | 'down' | null;
  onAct: () => void;
  onDismiss: () => void;
  onThumbsUp: () => void;
  onThumbsDown: () => void;
  onOpenSettings: () => void;
}) {
  const typeConfig = HERO_TYPE_CONFIG[candidate.type];
  const TypeIcon = typeConfig.icon;

  return (
    <>
      <div className={styles.heroBadgeRow}>
        <div className={styles.typeBadge} data-type={candidate.type} data-urgent={typeConfig.urgent ? 'true' : undefined}>
          <TypeIcon size={12} />
          <span>{typeConfig.label}</span>
        </div>
        <button
          type="button"
          className={styles.settingsLink}
          onClick={onOpenSettings}
          aria-label="Recommendation settings"
        >
          <Settings size={12} />
        </button>
        <button
          type="button"
          className={styles.dismissBtn}
          onClick={onDismiss}
          aria-label="Dismiss recommendation"
        >
          <X size={14} />
        </button>
      </div>
      <div className={styles.cardItemHeader}>
        <p className={styles.cardItemTitle}>{stripLeadingEmoji(candidate.headline)}</p>
      </div>
      <p className={styles.cardItemDescription}>{stripLeadingEmoji(candidate.body)}</p>
      <div className={styles.cardItemFooter}>
        <div className={styles.feedbackGroup}>
          <button
            type="button"
            className={styles.thumbBtn}
            onClick={onThumbsUp}
            aria-label="This was helpful"
            data-active={feedbackGiven === 'up'}
          >
            <ThumbsUp size={12} />
          </button>
          <button
            type="button"
            className={styles.thumbBtn}
            onClick={onThumbsDown}
            aria-label="Not helpful"
            data-active={feedbackGiven === 'down'}
          >
            <ThumbsDown size={12} />
          </button>
        </div>
        <Button variant="secondary" size="sm" className={`${styles.actionCta} ${styles.actionCtaPrimary}`} onClick={onAct}>
          {candidate.actionLabel} <ChevronRight size={14} />
        </Button>
      </div>
    </>
  );
}

/**
 * Prompt card inviting the user to generate hero choice recommendations.
 * Follows the same layout as other carousel cards: header → description → footer with CTA.
 */
function HeroPromptCardContent({
  isGenerating,
  error,
  onGenerateOnce,
  onAlwaysGenerate,
  onOpenSettings,
}: {
  isGenerating: boolean;
  error: string | null;
  onGenerateOnce: () => void;
  onAlwaysGenerate: () => void;
  onOpenSettings: () => void;
}) {
  if (isGenerating) {
    return (
      <>
        <div className={styles.cardItemHeader}>
          <p className={styles.cardItemTitle}>Working on it...</p>
          <button
            type="button"
            className={styles.settingsLink}
            onClick={onOpenSettings}
            aria-label="Recommendation settings"
          >
            <Settings size={12} />
          </button>
        </div>
        <p className={styles.cardItemDescription}>
          Rebel is reading through your recent conversations, meetings, and goals to build a prioritized list of what deserves your attention right now.
        </p>
        <p className={styles.promptOutputHint}>
          You'll get 3–5 actionable recommendations with a next step for each.
        </p>
        <div className={styles.promptFooterRow}>
          <Tooltip content="Running this once uses your API key. If you turn on daily runs, Haiku is about $0.05/day, Sonnet about $0.60/day, and Opus about $3/day.">
            <button type="button" className={styles.promptCostButton} aria-label="Cost information">
              <span>Cost</span>
              <Info size={11} />
            </button>
          </Tooltip>
        </div>
        <div className={styles.promptSpinnerRow}>
          <Loader2 size={16} className={styles.spinnerIcon} />
        </div>
      </>
    );
  }

  return (
    <>
      <div className={styles.cardItemHeader}>
        <p className={styles.cardItemTitle}>Rebel's take on your priorities</p>
        <button
          type="button"
          className={styles.settingsLink}
          onClick={onOpenSettings}
          aria-label="Recommendation settings"
        >
          <Settings size={12} />
        </button>
      </div>
      <p className={styles.cardItemDescription}>
        Rebel reads through your recent conversations, meetings, and goals to build a short, prioritized list of what deserves your attention right now — and suggests a concrete next step for each.
      </p>
      {error ? (
        <p className={styles.promptOutputHint} role="alert">
          Couldn't generate recommendations — try again?
        </p>
      ) : (
        <p className={styles.promptOutputHint}>
          You'll get 3–5 actionable recommendations, refreshed each time you run it.
        </p>
      )}
      <div className={styles.promptFooterRow}>
        <Tooltip content="Running this once uses your API key. If you turn on daily runs, Haiku is about $0.05/day, Sonnet about $0.60/day, and Opus about $3/day.">
          <button type="button" className={styles.promptCostButton} aria-label="Cost information">
            <span>Cost</span>
            <Info size={11} />
          </button>
        </Tooltip>
        <div className={styles.promptActionGroup}>
          <Button variant="ghost" size="sm" className={styles.promptSecondaryCta} onClick={onAlwaysGenerate}>
            Run daily
          </Button>
          <Button variant="secondary" size="sm" className={`${styles.actionCta} ${styles.actionCtaPrimary}`} onClick={onGenerateOnce}>
            {error ? 'Try again' : 'Run once'} <ChevronRight size={14} />
          </Button>
        </div>
      </div>
    </>
  );
}

const DISMISSED_INBOX_INSIGHTS_KEY = 'rebel:coach:dismissed-inbox-insights';

const loadDismissedInboxInsights = (): Set<string> => {
  try {
    const raw = localStorage.getItem(DISMISSED_INBOX_INSIGHTS_KEY);
    if (!raw) return new Set();
    return new Set(JSON.parse(raw) as string[]);
  } catch {
    return new Set();
  }
};

const saveDismissedInboxInsights = (ids: Set<string>): void => {
  try {
    localStorage.setItem(DISMISSED_INBOX_INSIGHTS_KEY, JSON.stringify([...ids]));
  } catch {
    // localStorage unavailable — silently ignore
  }
};

export function CoachSection({
  userState,
  coachingSessionIds,
  onAct,
  onDismiss,
  onOpenSession,
  insightInboxItems = [],
}: CoachSectionProps) {
  const content = useCoachContent(userState);
  const { insights } = useCoachingInsights(coachingSessionIds);
  const { useCases, dismissUseCase } = useUseCaseLibrary(MAX_BACKFILL_ITEMS);
  const {
    pendingCandidates: heroCandidates,
    feedbackState: heroFeedbackState,
    isLoading: heroLoading,
    isGenerating: heroGenerating,
    generationError: heroGenerationError,
    runMode: heroRunMode,
    act: heroAct,
    dismiss: heroDismiss,
    giveFeedback: heroGiveFeedback,
    generateNow: heroGenerateNow,
    updateRunMode: heroUpdateRunMode,
  } = useHeroChoice();
  const navigation = useNavigationSafe();
  const [feedbackGiven, setFeedbackGiven] = useState<Record<string, 'up' | 'down'>>({});
  const [dismissedSuggestionIds, setDismissedSuggestionIds] = useState<Set<string>>(loadDismissedSuggestions);
  const [dismissedInboxInsightIds, setDismissedInboxInsightIds] = useState<Set<string>>(loadDismissedInboxInsights);
  const [isHovered, setIsHovered] = useState(false);

  // Build unified carousel:
  // 0. Hero prompt card (when run mode is 'ask' and no hero data exists)
  // 0b. Hero choice candidates (top priority — always shown first)
  // 1. Sort insights by category priority + age decay
  // 2. Enforce max MAX_PER_CATEGORY per insight category for variety
  // 3. Backfill with contextual suggestions, then generic use cases
  const carouselItems: CarouselItem[] = useMemo(() => {
    const heroItems: CarouselItem[] = heroCandidates.map(
      (c) => ({ kind: 'hero' as const, data: c })
    );

    // Inject prompt card when run mode is 'ask' and no hero candidates exist (or generating)
    const showPromptCard = heroRunMode === 'ask' && heroCandidates.length === 0 && !heroLoading;
    if (showPromptCard || heroGenerating) {
      heroItems.unshift({ kind: 'hero-prompt', data: null });
    }

    const now = Date.now();
    const sortedInsights = [...insights].sort((a, b) => {
      const ageA = now - a.evaluation.evaluatedAt;
      const ageB = now - b.evaluation.evaluatedAt;
      const decayA = ageA > AGE_DECAY_THRESHOLD_MS ? AGE_DECAY_PRIORITY_PENALTY : 0;
      const decayB = ageB > AGE_DECAY_THRESHOLD_MS ? AGE_DECAY_PRIORITY_PENALTY : 0;
      const pa = (INSIGHT_CATEGORY_PRIORITY[a.evaluation.primaryInsight.category] ?? 99) + decayA;
      const pb = (INSIGHT_CATEGORY_PRIORITY[b.evaluation.primaryInsight.category] ?? 99) + decayB;
      if (pa !== pb) return pa - pb;
      return b.evaluation.evaluatedAt - a.evaluation.evaluatedAt;
    });

    const categoryCounts = new Map<string, number>();
    const diverseInsights: CarouselItem[] = [];
    for (const data of sortedInsights) {
      if (diverseInsights.length >= MAX_INSIGHT_ITEMS) break;
      const cat = data.evaluation.primaryInsight.category;
      const count = categoryCounts.get(cat) ?? 0;
      if (count >= MAX_PER_CATEGORY) continue;
      categoryCounts.set(cat, count + 1);
      diverseInsights.push({ kind: 'insight', data });
    }

    // Merge inbox insight items (wins/learnings that weren't redirected at write-time)
    const inboxInsightItems: CarouselItem[] = insightInboxItems
      .filter(item => !dismissedInboxInsightIds.has(item.id))
      .sort((a, b) => b.addedAt - a.addedAt)
      .map(item => ({ kind: 'inbox-insight' as const, data: item }));

    // Combined insight pool sorted by relevance: wins > learnings > rest.
    // This applies across both coaching evaluations and inbox insights.
    const getTitle = (ci: CarouselItem): string => {
      if (ci.kind === 'insight') return ci.data.sessionTitle;
      if (ci.kind === 'inbox-insight') return ci.data.title;
      return '';
    };
    const titlePriority = (title: string): number => {
      const lower = stripLeadingEmoji(title).toLowerCase();
      if (lower.startsWith('win:')) return 0;
      if (lower.startsWith('learning:')) return 1;
      return 2;
    };
    const allInsights = [...diverseInsights, ...inboxInsightItems]
      .sort((a, b) => titlePriority(getTitle(a)) - titlePriority(getTitle(b)));
    const items: CarouselItem[] = allInsights.slice(0, MAX_INSIGHT_ITEMS);

    // Backfill with suggestions + use cases (capped at MAX_BACKFILL_ITEMS total)
    const backfillSlots = Math.min(MAX_BACKFILL_ITEMS, MAX_CAROUSEL_ITEMS - heroItems.length - items.length);
    let backfilled = 0;

    const staticFills = content.suggestions
      .filter(s => !dismissedSuggestionIds.has(s.id));
    for (const s of staticFills) {
      if (backfilled >= backfillSlots) break;
      items.push({ kind: 'suggestion', data: s });
      backfilled++;
    }

    for (const uc of useCases) {
      if (backfilled >= backfillSlots) break;
      items.push({ kind: 'usecase', data: uc });
      backfilled++;
    }

    return [...heroItems, ...items].slice(0, MAX_CAROUSEL_ITEMS);
  }, [heroCandidates, heroRunMode, heroLoading, heroGenerating, insights, useCases, content.suggestions, dismissedSuggestionIds, insightInboxItems, dismissedInboxInsightIds]);

  // Wait for hero choice to load before picking the initial index so hero
  // candidates (if any) are already in the carousel. Start at 0 when hero
  // items lead; otherwise randomize to keep the carousel fresh.
  const initialIndexPicked = useRef(false);
  const [currentIndex, setCurrentIndex] = useState(0);
  const [slideDirection, setSlideDirection] = useState<'next' | 'prev'>('next');
  useEffect(() => {
    if (heroLoading) return;
    if (carouselItems.length > 1 && !initialIndexPicked.current) {
      initialIndexPicked.current = true;
      const startsWithHero = carouselItems[0]?.kind === 'hero';
      setCurrentIndex(startsWithHero ? 0 : Math.floor(Math.random() * carouselItems.length));
    }
  }, [carouselItems, heroLoading]);

  // Auto-rotate: advance every AUTO_ROTATE_INTERVAL_MS, pause on hover/focus
  useEffect(() => {
    if (carouselItems.length <= 1 || isHovered) return;
    const timer = setInterval(() => {
      setCurrentIndex(prev => (prev + 1) % carouselItems.length);
    }, AUTO_ROTATE_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [carouselItems.length, isHovered]);

  const totalItems = carouselItems.length;

  // Clamp index when items change (e.g. after dismiss)
  const safeIndex = Math.min(currentIndex, Math.max(0, totalItems - 1));
  const currentItem = carouselItems[safeIndex];

  // ── Insight handlers ──────────────────────────────────

  const getInsightAgeHours = (insight: CoachingInsightWithContext): number =>
    Math.round((Date.now() - insight.evaluation.evaluatedAt) / (60 * 60 * 1000) * 10) / 10;

  const handleInsightAct = useCallback((insight: CoachingInsightWithContext) => {
    tracking.spark.coachingInsightActed(
      insight.evaluation.sessionId,
      insight.evaluation.primaryInsight.category,
      getInsightAgeHours(insight)
    );
    fireAndForget(updateCoachingState(insight.evaluation.sessionId, 'acted'), 'coachingInsightActed');
    onDismiss(insight.evaluation.sessionId);
    onAct(insight.evaluation.primaryInsight.continuationPrompt);
  }, [onAct, onDismiss]);

  const handleInsightDismiss = useCallback((insight: CoachingInsightWithContext) => {
    tracking.spark.coachingInsightDismissed(
      insight.evaluation.sessionId,
      insight.evaluation.primaryInsight.category,
      getInsightAgeHours(insight)
    );
    fireAndForget(updateCoachingState(insight.evaluation.sessionId, 'dismissed'), 'coachingInsightDismissed');
    onDismiss(insight.evaluation.sessionId);
    // After removal, clamp index
    setCurrentIndex((prev) => Math.min(prev, Math.max(0, totalItems - 2)));
  }, [onDismiss, totalItems]);

  const handleThumbsUp = useCallback((insight: CoachingInsightWithContext) => {
    tracking.spark.coachingFeedback(
      insight.evaluation.sessionId,
      insight.evaluation.primaryInsight.category,
      'helpful',
      getInsightAgeHours(insight)
    );
    setFeedbackGiven((prev) => ({ ...prev, [insight.evaluation.sessionId]: 'up' }));
  }, []);

  const handleThumbsDown = useCallback((insight: CoachingInsightWithContext) => {
    tracking.spark.coachingFeedback(
      insight.evaluation.sessionId,
      insight.evaluation.primaryInsight.category,
      'not_helpful',
      getInsightAgeHours(insight)
    );
    setFeedbackGiven((prev) => ({ ...prev, [insight.evaluation.sessionId]: 'down' }));
    fireAndForget(updateCoachingState(insight.evaluation.sessionId, 'dismissed'), 'coachingThumbsDownDismiss');
    onDismiss(insight.evaluation.sessionId);
    setCurrentIndex((prev) => Math.min(prev, Math.max(0, totalItems - 2)));
  }, [onDismiss, totalItems]);

  // ── Suggestion handlers ─────────────────────────────────

  const handleSuggestionAct = useCallback((suggestion: { id: string; title: string; prompt: string }) => {
    tracking.homepage.coachSuggestionActed(suggestion.id, suggestion.title);
    onAct(suggestion.prompt);
  }, [onAct]);

  const handleSuggestionDismiss = useCallback((suggestionId: string) => {
    tracking.homepage.coachSuggestionDismissed(suggestionId);
    setDismissedSuggestionIds((prev) => {
      const next = new Set(prev);
      next.add(suggestionId);
      saveDismissedSuggestions(next);
      return next;
    });
    setCurrentIndex((prev) => Math.min(prev, Math.max(0, totalItems - 2)));
  }, [totalItems]);

  // ── Inbox insight handlers ──────────────────────────────

  const handleInboxInsightAct = useCallback((item: InboxItem) => {
    const cleanTitle = stripLeadingEmoji(item.title);
    const textSnippet = item.text ? item.text.slice(0, 300) : '';
    tracking.homepage.coachSuggestionActed(item.id, cleanTitle);
    onAct(`Tell me more about this: "${cleanTitle}". ${textSnippet}`);
  }, [onAct]);

  const handleInboxInsightDismiss = useCallback((itemId: string) => {
    tracking.homepage.coachSuggestionDismissed(itemId);
    setDismissedInboxInsightIds((prev) => {
      const next = new Set(prev);
      next.add(itemId);
      saveDismissedInboxInsights(next);
      return next;
    });
    setCurrentIndex((prev) => Math.min(prev, Math.max(0, totalItems - 2)));
  }, [totalItems]);

  // ── Use case handlers ─────────────────────────────────

  const handleUseCaseAct = useCallback((useCase: UseCaseRecordIpc) => {
    tracking.homepage.coachSuggestionActed(useCase.id, useCase.title);
    onAct(useCase.prompt);
  }, [onAct]);

  const handleUseCaseDismiss = useCallback((useCaseId: string) => {
    tracking.homepage.coachSuggestionDismissed(useCaseId);
    dismissUseCase(useCaseId);
    setCurrentIndex((prev) => Math.min(prev, Math.max(0, totalItems - 2)));
  }, [dismissUseCase, totalItems]);

  // ── Hero choice handlers ─────────────────────────────

  const handleHeroAct = useCallback((candidate: HeroChoiceCandidate) => {
    tracking.heroChoice.acted(candidate.type, candidate.headline);
    heroAct(candidate.id);
    onAct(candidate.actionPrompt);
  }, [heroAct, onAct]);

  const handleHeroDismiss = useCallback((candidate: HeroChoiceCandidate) => {
    tracking.heroChoice.dismissed(candidate.type);
    heroDismiss(candidate.id);
    setCurrentIndex((prev) => Math.min(prev, Math.max(0, totalItems - 2)));
  }, [heroDismiss, totalItems]);

  const handleHeroThumbsUp = useCallback((candidate: HeroChoiceCandidate) => {
    tracking.heroChoice.feedback(candidate.type, 'helpful');
    heroGiveFeedback(candidate.id, 'helpful');
  }, [heroGiveFeedback]);

  const handleHeroThumbsDown = useCallback((candidate: HeroChoiceCandidate) => {
    tracking.heroChoice.feedback(candidate.type, 'not_helpful');
    heroGiveFeedback(candidate.id, 'not_helpful');
  }, [heroGiveFeedback]);

  const handleOpenHeroSettings = useCallback(() => {
    if (navigation) {
      fireAndForget(navigation.navigate({ type: 'settings', tab: 'agents', section: 'heroChoiceRunMode' }), 'navigateToHeroSettings');
    }
  }, [navigation]);

  const handleAlwaysSuggest = useCallback(() => {
    heroUpdateRunMode('automatic');
    heroGenerateNow();
  }, [heroUpdateRunMode, heroGenerateNow]);

  // ── Carousel navigation ───────────────────────────────

  const goToPrev = useCallback(() => {
    setSlideDirection('prev');
    setCurrentIndex((prev) => {
      const next = prev <= 0 ? totalItems - 1 : prev - 1;
      if (next !== prev) tracking.homepage.coachCarouselNavigated('prev', next, totalItems);
      return next;
    });
  }, [totalItems]);

  const goToNext = useCallback(() => {
    setSlideDirection('next');
    setCurrentIndex((prev) => {
      const next = (prev + 1) % totalItems;
      if (next !== prev) tracking.homepage.coachCarouselNavigated('next', next, totalItems);
      return next;
    });
  }, [totalItems]);

  const goToIndex = useCallback((index: number) => {
    setSlideDirection(index > currentIndex ? 'next' : 'prev');
    setCurrentIndex(index);
  }, [currentIndex]);

  // Keyboard navigation for the carousel region
  const handleCarouselKeyDown = useCallback((e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'ArrowLeft') {
      e.preventDefault();
      goToPrev();
    } else if (e.key === 'ArrowRight') {
      e.preventDefault();
      goToNext();
    }
  }, [goToPrev, goToNext]);

  // ── Render ────────────────────────────────────────────

  if (totalItems === 0) {
    return null;
  }

  const hasGeneratedHero = carouselItems.some(item => item.kind === 'hero');
  const hasPromptOnly = !hasGeneratedHero && carouselItems.some(item => item.kind === 'hero-prompt');
  const title = hasGeneratedHero
    ? 'Recommendations'
    : hasPromptOnly
      ? content.title
      : content.title;
  const subtitle = hasGeneratedHero
    ? 'Based on your recent conversations.'
    : totalItems > 0
      ? 'Things I\'ve noticed from your conversations that might be worth exploring.'
      : content.subtitle;

  return (
    <section className={styles.coachCard} data-size={content.size}>
      {/* Rebel mascot — aligned with header area. Hidden on load error (offline). */}
      <img
        src={REBEL_MASCOT_URL}
        alt=""
        aria-hidden="true"
        className={styles.mascot}
        onError={(e) => { (e.target as HTMLImageElement).style.display = 'none'; }}
      />

      <div className={styles.cardHeader}>
        <h2 className={styles.cardTitle}>{title}</h2>
        {subtitle && (
          <p className={styles.cardSubtitle}>{subtitle}</p>
        )}
      </div>

      {/* Unified carousel — one card at a time, navigable with arrow keys */}
      {currentItem && (
        <div
          className={styles.carouselArea}
          role="region"
          aria-roledescription="carousel"
          aria-label={`Coach suggestions, ${safeIndex + 1} of ${totalItems}`}
          onKeyDown={handleCarouselKeyDown}
          onMouseEnter={() => setIsHovered(true)}
          onMouseLeave={() => setIsHovered(false)}
          onFocus={() => setIsHovered(true)}
          onBlur={() => setIsHovered(false)}
          tabIndex={0}
        >
          <div
            className={styles.carouselCard}
            data-kind={currentItem.kind}
            data-direction={slideDirection === 'prev' ? 'prev' : undefined}
            data-urgent={currentItem.kind === 'hero' && HERO_TYPE_CONFIG[currentItem.data.type].urgent ? 'true' : undefined}
            role="group"
            aria-roledescription="slide"
            aria-label={`${safeIndex + 1} of ${totalItems}`}
            key={
              currentItem.kind === 'hero'
                ? `hero-${currentItem.data.id}`
                : currentItem.kind === 'hero-prompt'
                  ? 'hero-prompt'
                  : currentItem.kind === 'insight'
                    ? currentItem.data.evaluation.sessionId
                    : currentItem.kind === 'inbox-insight'
                      ? `inbox-${currentItem.data.id}`
                      : currentItem.data.id
            }
          >
            {currentItem.kind === 'hero-prompt' ? (
              <HeroPromptCardContent
                isGenerating={heroGenerating}
                error={heroGenerationError}
                onGenerateOnce={heroGenerateNow}
                onAlwaysGenerate={handleAlwaysSuggest}
                onOpenSettings={handleOpenHeroSettings}
              />
            ) : currentItem.kind === 'hero' ? (
              <HeroCardContent
                candidate={currentItem.data}
                feedbackGiven={
                  heroFeedbackState[currentItem.data.id] === 'helpful' ? 'up'
                    : heroFeedbackState[currentItem.data.id] === 'not_helpful' ? 'down'
                      : null
                }
                onAct={() => handleHeroAct(currentItem.data)}
                onDismiss={() => handleHeroDismiss(currentItem.data)}
                onThumbsUp={() => handleHeroThumbsUp(currentItem.data)}
                onThumbsDown={() => handleHeroThumbsDown(currentItem.data)}
                onOpenSettings={handleOpenHeroSettings}
              />
            ) : currentItem.kind === 'insight' ? (
              <InsightCardContent
                insight={currentItem.data}
                feedbackGiven={feedbackGiven[currentItem.data.evaluation.sessionId] ?? null}
                onAct={() => handleInsightAct(currentItem.data)}
                onDismiss={() => handleInsightDismiss(currentItem.data)}
                onViewSession={() => onOpenSession?.(currentItem.data.evaluation.sessionId)}
                onThumbsUp={() => handleThumbsUp(currentItem.data)}
                onThumbsDown={() => handleThumbsDown(currentItem.data)}
              />
            ) : currentItem.kind === 'inbox-insight' ? (
              <InboxInsightCardContent
                item={currentItem.data}
                onAct={() => handleInboxInsightAct(currentItem.data)}
                onDismiss={() => handleInboxInsightDismiss(currentItem.data.id)}
              />
            ) : currentItem.kind === 'usecase' ? (
              <UseCaseCardContent
                useCase={currentItem.data}
                onAct={() => handleUseCaseAct(currentItem.data)}
                onDismiss={() => handleUseCaseDismiss(currentItem.data.id)}
              />
            ) : (
              <SuggestionCardContent
                suggestion={currentItem.data}
                onAct={() => handleSuggestionAct({
                  id: currentItem.data.id,
                  title: currentItem.data.title,
                  prompt: currentItem.data.ctaPrompt,
                })}
                onDismiss={() => handleSuggestionDismiss(currentItem.data.id)}
              />
            )}
          </div>

          {totalItems > 1 && (
            <div className={styles.carouselNav}>
              <button
                type="button"
                className={styles.carouselBtn}
                onClick={goToPrev}
                aria-label="Previous"
              >
                <ChevronLeft size={14} />
              </button>
              <div className={styles.carouselDots} role="tablist" aria-label="Carousel navigation">
                {carouselItems.map((_, i) => (
                  <button
                    key={i}
                    type="button"
                    className={styles.carouselDot}
                    data-active={i === safeIndex ? 'true' : undefined}
                    onClick={() => goToIndex(i)}
                    role="tab"
                    aria-selected={i === safeIndex}
                    aria-label={`Card ${i + 1}`}
                  />
                ))}
              </div>
              <span className={styles.carouselIndicator} aria-live="polite" aria-atomic="true">
                {safeIndex + 1} of {totalItems}
              </span>
              <button
                type="button"
                className={styles.carouselBtn}
                onClick={goToNext}
                aria-label="Next"
              >
                <ChevronRight size={14} />
              </button>
            </div>
          )}
        </div>
      )}
    </section>
  );
}
