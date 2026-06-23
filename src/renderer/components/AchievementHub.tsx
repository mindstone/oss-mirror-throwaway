/**
 * Achievement Hub
 * 
 * Unified modal for all achievements: time saved, streak, badges, and journey.
 * Single entry point from both streak and time-saved indicators.
 * 
 * Tabs:
 * - Overview: Hero time saved, streak, quick stats, recent badges
 * - Time Saved: Detailed weekly/all-time view with day-by-day chart and top sessions
 * - Badges: Full badge gallery by category
 * - Journey: 14-day onboarding journey progress
 */

import { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@renderer/components/ui/Dialog';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@renderer/components/ui/Tabs';
import { Tooltip } from '@renderer/components/ui/Tooltip';
import { MaturityBadge } from '@renderer/components/ui/MaturityBadge';
import { Flame, Trophy, Target, ChevronRight, Rocket, Zap } from 'lucide-react';
import { BADGE_DEFINITIONS, getBadgesByCategory, type BadgeCategory } from '@shared/badges';
import { DAILY_TASKS } from '@shared/onboardingJourney';
import type { TimeSavedAggregates, TopSessionInfo } from '@shared/types';
import type { AgentSessionSidebarEntry } from '@renderer/features/agent-session/types';
import { formatAbsoluteTimestamp } from '@renderer/utils/formatters';
import { tracking } from '@renderer/src/tracking';
import { FluencyTierCard } from './FluencyTierCard';
import { selectTimeSavedHeroState } from './achievementHubHeroState';
import './AchievementHub.css';

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

interface BadgeRecord {
  unlockedAt: number;
  notified: boolean;
}

interface StreakData {
  current: number;
  longest: number;
  lastActiveDate: string;
}

interface JourneyState {
  completedDays: number[];
  journeyStartedAt?: number;
}

interface AchievementHubProps {
  open: boolean;
  onClose: () => void;
  /** Initial tab to show */
  initialTab?: 'overview' | 'time' | 'badges' | 'journey';
  /** Session list for joining titles in time saved view */
  sessions?: AgentSessionSidebarEntry[];
  /** Navigate to a session by ID */
  onNavigateToSession?: (sessionId: string) => void;
  /** Navigate to The Spark to complete journey task */
  onNavigateToSpark?: () => void;
  /** Start a journey task conversation with the given prompt */
  onSelectJourneyTask?: (prompt: string) => void;
}

interface TopSessionWithMeta extends TopSessionInfo {
  title: string;
  costUsd: number | null;
  isDeleted: boolean;
  isUnknown: boolean;
}

// ─────────────────────────────────────────────────────────────────────────────
// Utilities
// ─────────────────────────────────────────────────────────────────────────────

const formatTimeCompact = (minutes: number): string => {
  if (minutes < 60) return `${Math.round(minutes)}m`;
  const totalRounded = Math.round(minutes);
  const hours = Math.floor(totalRounded / 60);
  const remainingMinutes = totalRounded % 60;
  if (remainingMinutes === 0) return `${hours}h`;
  return `${hours}h ${remainingMinutes}m`;
};

const formatTimeHero = (minutes: number): { value: number; unit: string } => {
  if (minutes < 60) return { value: Math.round(minutes), unit: 'min' };
  const hours = minutes / 60;
  if (hours < 10) {
    const rounded = Math.round(hours * 10) / 10;
    return { value: rounded, unit: rounded === 1 ? 'hour' : 'hours' };
  }
  const rounded = Math.round(hours);
  return { value: rounded, unit: rounded === 1 ? 'hour' : 'hours' };
};


const getTimeTranslation = (minutes: number): string => {
  const hours = minutes / 60;
  if (minutes < 30) return "Roughly a coffee break.";
  if (minutes < 60) return "About a meeting's worth.";
  if (hours < 2) return "A couple of meetings, roughly.";
  if (hours < 4) return "A few hours of deep work.";
  if (hours < 8) return "An afternoon of focused time.";
  if (hours < 16) return "Roughly a workday.";
  if (hours < 24) return "About two workdays.";
  if (hours < 40) return "Nearly a work week.";
  if (hours < 80) return "More than a full work week.";
  return "Multiple work weeks.";
};

const getAllTimeTranslation = (minutes: number): string => {
  const hours = minutes / 60;
  const weeks = hours / 40;
  if (hours < 1) return "Building up over time.";
  if (hours < 8) return "Working toward a full day.";
  if (hours < 24) return "Roughly a workday.";
  if (hours < 40) return "Nearly a work week.";
  if (weeks < 2) return "Over a work week.";
  if (weeks < 4) return "Multiple work weeks.";
  if (weeks < 8) return "About a month of work time.";
  if (weeks < 13) return "A quarter's worth of time.";
  if (weeks < 26) return "About half a year's worth.";
  if (weeks < 52) return "Nearly a year's worth.";
  return "Over a year's worth.";
};

const formatTrackingSince = (timestamp: number): string => {
  const date = new Date(timestamp);
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
};

const formatCostCompact = (costUsd: number): string => {
  if (costUsd < 0.01) return '<$0.01';
  return `$${costUsd.toFixed(2)}`;
};

const formatDayTitle = (dateStr: string): string => {
  const [year, month, day] = dateStr.split('-').map(Number);
  const date = new Date(year, month - 1, day);
  const dayName = date.toLocaleDateString('en-US', { weekday: 'long' });
  const formatted = date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  return `${dayName}, ${formatted}`;
};

const QUIPS = [
  "Based on typical manual effort.",
  "Estimates may vary.",
  "Your mileage may differ.",
  "Roughly speaking.",
  "Give or take.",
];

const getRandomQuip = (): string => QUIPS[Math.floor(Math.random() * QUIPS.length)];

const DAY_LABELS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

const CATEGORY_LABELS: Record<BadgeCategory, string> = {
  exploration: 'Exploration',
  mastery: 'Mastery',
  cumulative: 'Milestones',
  fun: 'Fun'
};

const CATEGORY_ORDER: BadgeCategory[] = ['exploration', 'mastery', 'cumulative', 'fun'];

const enrichTopSessions = (
  topSessions: TopSessionInfo[],
  sessions: AgentSessionSidebarEntry[]
): TopSessionWithMeta[] => {
  const sessionMap = new Map(sessions.map(s => [s.id, s]));
  return topSessions.map(ts => {
    const session = sessionMap.get(ts.sessionId);
    return {
      ...ts,
      title: session?.title || session?.preview || 'Untitled',
      costUsd: session?.totalCostUsd ?? null,
      isDeleted: session?.isDeleted ?? false,
      isUnknown: !session,
    };
  });
};

// ─────────────────────────────────────────────────────────────────────────────
// Hooks
// ─────────────────────────────────────────────────────────────────────────────

const useCountUp = (target: number, duration: number = 600, enabled: boolean = true) => {
  const [current, setCurrent] = useState(0);
  const [isComplete, setIsComplete] = useState(false);
  const startTimeRef = useRef<number | null>(null);
  const frameRef = useRef<number | undefined>(undefined);

  useEffect(() => {
    if (!enabled || target === 0) {
      setCurrent(target);
      setIsComplete(target > 0);
      return;
    }

    setCurrent(0);
    setIsComplete(false);
    startTimeRef.current = null;

    const animate = (timestamp: number) => {
      if (!startTimeRef.current) startTimeRef.current = timestamp;
      const elapsed = timestamp - startTimeRef.current;
      const progress = Math.min(elapsed / duration, 1);
      const eased = 1 - Math.pow(1 - progress, 4);
      setCurrent(target * eased);
      if (progress < 1) {
        frameRef.current = requestAnimationFrame(animate);
      } else {
        setCurrent(target);
        setIsComplete(true);
      }
    };

    frameRef.current = requestAnimationFrame(animate);
    return () => { if (frameRef.current) cancelAnimationFrame(frameRef.current); };
  }, [target, duration, enabled]);

  return { current, isComplete };
};

// ─────────────────────────────────────────────────────────────────────────────
// Sub-components
// ─────────────────────────────────────────────────────────────────────────────

type DayChartProps = {
  dailyTotals: Record<string, number>;
  selectedDay: string | null;
  onDayClick: (date: string | null) => void;
  highImpactDays?: Set<string>;
};

const DayByDayChart = ({ dailyTotals, selectedDay, onDayClick, highImpactDays }: DayChartProps) => {
  const sortedDates = Object.keys(dailyTotals).sort();
  
  return (
    <div className="achievement-hub__days">
      {sortedDates.map((date, i) => {
        const minutes = dailyTotals[date];
        const hasActivity = minutes > 0;
        const isSelected = selectedDay === date;
        const isHighImpact = highImpactDays?.has(date) ?? false;
        
        const dayButton = (
          <button
            key={date}
            type="button"
            className={`achievement-hub__day ${hasActivity ? 'achievement-hub__day--clickable' : ''} ${isSelected ? 'achievement-hub__day--selected' : ''}`}
            onClick={() => hasActivity && onDayClick(isSelected ? null : date)}
            disabled={!hasActivity}
          >
            <span className="achievement-hub__day-label">{DAY_LABELS[i]}</span>
            <span className={`achievement-hub__day-dot ${hasActivity ? 'achievement-hub__day-dot--active' : ''} ${isHighImpact ? 'achievement-hub__day-dot--high-impact' : ''}`} />
            {hasActivity && <span className="achievement-hub__day-value">{formatTimeCompact(minutes)}</span>}
          </button>
        );

        if (isHighImpact) {
          return (
            <Tooltip key={date} content="Includes high-impact work" delayShow={300}>
              {dayButton}
            </Tooltip>
          );
        }

        return dayButton;
      })}
    </div>
  );
};

type TopSessionsListProps = {
  topSessions: TopSessionWithMeta[];
  onNavigateToSession?: (sessionId: string) => void;
  onClose: () => void;
  title?: string;
  emptyMessage?: string;
  maxDisplay?: number;
};

const TopSessionsList = ({ 
  topSessions, 
  onNavigateToSession, 
  onClose,
  title = 'Top Conversations',
  emptyMessage,
  maxDisplay = 5,
}: TopSessionsListProps) => {
  const visibleSessions = topSessions
    .filter(s => !s.isDeleted && !s.isUnknown)
    .slice(0, maxDisplay);
  
  if (visibleSessions.length === 0) {
    if (emptyMessage) {
      return (
        <div className="achievement-hub__sessions">
          <h4 className="achievement-hub__section-title">{title}</h4>
          <p className="achievement-hub__empty">{emptyMessage}</p>
        </div>
      );
    }
    return null;
  }

  const handleClick = (session: TopSessionWithMeta) => {
    if (!onNavigateToSession) return;
    onClose();
    onNavigateToSession(session.sessionId);
  };

  return (
    <div className="achievement-hub__sessions">
      <h4 className="achievement-hub__section-title">{title}</h4>
      <ul className="achievement-hub__session-list">
        {visibleSessions.map(session => {
          const isHighImpact = session.highestImpact === 'critical' || session.highestImpact === 'high';
          const impactLabel = session.highestImpact === 'critical' ? 'Critical impact' : 'High impact';

          const tooltipContent = (
            <div className="achievement-hub__session-tooltip">
              <div className="achievement-hub__tooltip-title">{session.title}</div>
              {session.reasoning && (
                <div className="achievement-hub__tooltip-reasoning">{session.reasoning}</div>
              )}
              <div className="achievement-hub__tooltip-meta">
                <span>{formatAbsoluteTimestamp(session.latestTimestamp)}</span>
                {isHighImpact && (
                  <><span className="achievement-hub__tooltip-sep">·</span><span className="achievement-hub__tooltip-impact">{impactLabel}</span></>
                )}
                {session.costUsd != null && session.costUsd > 0 && (
                  <><span className="achievement-hub__tooltip-sep">·</span><span>{formatCostCompact(session.costUsd)}</span></>
                )}
              </div>
            </div>
          );

          return (
            <li key={session.sessionId}>
              <Tooltip content={tooltipContent} placement="left" delayShow={200}>
                <button
                  className="achievement-hub__session-item"
                  onClick={() => handleClick(session)}
                  disabled={!onNavigateToSession}
                  type="button"
                >
                  <span className="achievement-hub__session-title">{session.title}</span>
                  {isHighImpact && (
                    <span className="achievement-hub__session-impact">
                      <Zap size={12} />
                    </span>
                  )}
                  <span className="achievement-hub__session-time">~{formatTimeCompact(session.totalMinutes)}</span>
                  <ChevronRight size={14} className="achievement-hub__session-chevron" />
                </button>
              </Tooltip>
            </li>
          );
        })}
      </ul>
    </div>
  );
};

// ─────────────────────────────────────────────────────────────────────────────
// Main Component
// ─────────────────────────────────────────────────────────────────────────────

export function AchievementHub({ 
  open, 
  onClose, 
  initialTab = 'overview',
  sessions = [],
  onNavigateToSession,
  onNavigateToSpark,
  onSelectJourneyTask
}: AchievementHubProps) {
  // State
  const [activeTab, setActiveTab] = useState(initialTab);
  const [streak, setStreak] = useState<StreakData | null>(null);
  const openedAtRef = useRef<number>(0);
  const [badges, setBadges] = useState<Record<string, BadgeRecord>>({});
  const [journey, setJourney] = useState<JourneyState | null>(null);
  const [aggregates, setAggregates] = useState<TimeSavedAggregates | null>(null);
  const [aggregatesFetchError, setAggregatesFetchError] = useState<boolean>(false);
  const [trackingSince, setTrackingSince] = useState<number | null>(null);
  const [weekDailyTotals, setWeekDailyTotals] = useState<Record<string, number> | null>(null);
  const [weekTopSessions, setWeekTopSessions] = useState<TopSessionInfo[]>([]);
  const [animationReady, setAnimationReady] = useState(false);
  const [timeSubTab, setTimeSubTab] = useState<'week' | 'alltime'>('week');
  const [selectedDay, setSelectedDay] = useState<string | null>(null);
  const [dayTopSessions, setDayTopSessions] = useState<TopSessionInfo[]>([]);
  const [daySessionsLoading, setDaySessionsLoading] = useState(false);
  const daySessionsCache = useRef<Record<string, TopSessionInfo[]>>({});
  const currentRequestRef = useRef<string | null>(null);
  
  const quip = useMemo(() => getRandomQuip(), []);

  // Reset tab when modal opens and track open
  useEffect(() => {
    if (open) {
      setActiveTab(initialTab);
      setTimeSubTab('week');
      setSelectedDay(null);
      setDayTopSessions([]);
      daySessionsCache.current = {};
      openedAtRef.current = Date.now();
      
      // Track hub opened - map initialTab to source
      const sourceMap: Record<string, 'streak_indicator' | 'time_saved_indicator' | 'badge_toast' | 'spark'> = {
        overview: 'streak_indicator',
        time: 'time_saved_indicator',
        badges: 'badge_toast',
        journey: 'spark',
      };
      tracking.gamification.achievementHubOpened(sourceMap[initialTab] ?? 'streak_indicator');
    }
  }, [open, initialTab]);

  // Handle tab switch with tracking
  const handleTabChange = useCallback((newTab: string) => {
    const typedTab = newTab as 'overview' | 'time' | 'badges' | 'journey';
    tracking.gamification.achievementHubTabSwitched(typedTab, activeTab);
    setActiveTab(typedTab);
  }, [activeTab]);

  // Handle close with tracking
  const handleClose = useCallback(() => {
    const timeSpentMs = Date.now() - openedAtRef.current;
    tracking.gamification.achievementHubClosed(activeTab, timeSpentMs);
    onClose();
  }, [activeTab, onClose]);

  // Load all data when modal opens
  useEffect(() => {
    if (!open) {
      setAnimationReady(false);
      return;
    }

    // Clear stale state before fetching
    setAnimationReady(false);
    setStreak(null);
    setBadges({});
    setJourney(null);
    setAggregates(null);
    setAggregatesFetchError(false);
    setTrackingSince(null);
    setWeekDailyTotals(null);
    setWeekTopSessions([]);

    const loadData = async () => {
      // Use allSettled so a failure in one request (e.g. badges) doesn't blank
      // out the time-saved hero and read as `0 min` data loss. See
      // docs-private/investigations/260520_time_saved_zero_or_missing.md.
      const [
        streakResult,
        badgesResult,
        journeyResult,
        timeSavedResult,
        dailyTotalsResult,
        topSessionsResult,
      ] = await Promise.allSettled([
        window.api.getStreakData?.(),
        window.api.getBadges?.(),
        window.api.getOnboardingJourney?.(),
        window.api.getTimeSavedAggregates?.(),
        window.api.getWeekDailyTotals?.(),
        window.api.getWeekTopSessions?.(),
      ]);

      if (streakResult.status === 'fulfilled' && streakResult.value) setStreak(streakResult.value);
      if (badgesResult.status === 'fulfilled' && badgesResult.value) setBadges(badgesResult.value);
      if (journeyResult.status === 'fulfilled' && journeyResult.value) setJourney(journeyResult.value);

      if (timeSavedResult.status === 'fulfilled' && timeSavedResult.value) {
        const payload = timeSavedResult.value as
          | TimeSavedAggregates
          | { aggregates?: TimeSavedAggregates; trackingSince?: number | null };
        const aggregatesValue =
          ('aggregates' in payload && payload.aggregates ? payload.aggregates : payload) as TimeSavedAggregates;
        setAggregates(aggregatesValue);
        setTrackingSince(('trackingSince' in payload ? payload.trackingSince : null) ?? null);
        setAggregatesFetchError(false);
      } else if (timeSavedResult.status === 'rejected') {
        console.warn('Failed to fetch time saved aggregates:', timeSavedResult.reason);
        setAggregatesFetchError(true);
      }

      if (dailyTotalsResult.status === 'fulfilled' && dailyTotalsResult.value) {
        setWeekDailyTotals(dailyTotalsResult.value);
      }
      if (topSessionsResult.status === 'fulfilled' && topSessionsResult.value) {
        setWeekTopSessions(topSessionsResult.value);
      }

      setTimeout(() => setAnimationReady(true), 50);
    };

    void loadData();
  }, [open]);

  // Handle day selection
  const handleDayClick = useCallback((date: string | null) => {
    setSelectedDay(date);
    currentRequestRef.current = date;
    
    if (!date) {
      setDayTopSessions([]);
      setDaySessionsLoading(false);
      return;
    }
    
    if (daySessionsCache.current[date]) {
      setDayTopSessions(daySessionsCache.current[date]);
      setDaySessionsLoading(false);
      return;
    }
    
    setDaySessionsLoading(true);
    const fetchPromise = window.api.getTopSessionsForDay?.(date);
    if (!fetchPromise) {
      setDaySessionsLoading(false);
      return;
    }
    fetchPromise
      .then(sessions => {
        if (currentRequestRef.current !== date) return;
        daySessionsCache.current[date] = sessions;
        setDayTopSessions(sessions);
      })
      .catch((error) => {
        console.warn('Failed to fetch day sessions:', error);
        if (currentRequestRef.current !== date) return;
        setDayTopSessions([]);
      })
      .finally(() => {
        if (currentRequestRef.current === date) setDaySessionsLoading(false);
      });
  }, []);

  // Derived data
  const unlockedBadgeCount = Object.keys(badges).length;
  const journeyProgress = journey?.completedDays.length ?? 0;
  
  const enrichedWeekTopSessions = useMemo(() => enrichTopSessions(weekTopSessions, sessions), [weekTopSessions, sessions]);
  const enrichedDayTopSessions = useMemo(() => enrichTopSessions(dayTopSessions, sessions), [dayTopSessions, sessions]);
  const displayedSessions = selectedDay ? enrichedDayTopSessions : enrichedWeekTopSessions;
  const sessionsTitle = selectedDay ? formatDayTitle(selectedDay) : 'Top Conversations';
  
  // Count high-impact sessions this week
  const highImpactCount = useMemo(() => {
    return weekTopSessions.filter(s => s.highestImpact === 'critical' || s.highestImpact === 'high').length;
  }, [weekTopSessions]);
  
  // Identify which days have high-impact activity (for chart gold accent)
  const highImpactDays = useMemo(() => {
    const days = new Set<string>();
    for (const session of weekTopSessions) {
      if (session.highestImpact === 'critical' || session.highestImpact === 'high') {
        // Convert timestamp to local date string (YYYY-MM-DD)
        const d = new Date(session.latestTimestamp);
        const dateStr = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
        days.add(dateStr);
      }
    }
    return days;
  }, [weekTopSessions]);

  // Time calculations
  const weekMinutes = aggregates?.currentWeek?.totalMinutes ?? 0;
  const allTimeMinutes = aggregates?.allTime?.totalMinutes ?? 0;
  const weekHero = formatTimeHero(weekMinutes);
  const allTimeHero = formatTimeHero(allTimeMinutes);

  // Tri-state hero — see selectTimeSavedHeroState for the why behind each case.
  const heroState = selectTimeSavedHeroState(weekMinutes, allTimeMinutes, aggregatesFetchError);

  const { current: weekAnimated, isComplete: weekComplete } = useCountUp(weekHero.value, 600, animationReady && (activeTab === 'overview' || (activeTab === 'time' && timeSubTab === 'week')));
  const { current: allTimeAnimated, isComplete: allTimeComplete } = useCountUp(allTimeHero.value, 600, animationReady && activeTab === 'time' && timeSubTab === 'alltime');
  const { current: overviewAllTimeAnimated, isComplete: overviewAllTimeComplete } = useCountUp(
    allTimeHero.value,
    600,
    animationReady && activeTab === 'overview' && heroState.kind === 'allTime',
  );

  const weekDisplay = weekHero.value % 1 === 0 ? Math.round(weekAnimated) : weekAnimated.toFixed(1);
  const allTimeDisplay = allTimeHero.value % 1 === 0 ? Math.round(allTimeAnimated) : allTimeAnimated.toFixed(1);
  const overviewAllTimeDisplay = allTimeHero.value % 1 === 0
    ? Math.round(overviewAllTimeAnimated)
    : overviewAllTimeAnimated.toFixed(1);

  // Recent badges (last 4)
  const recentBadges = useMemo(() => {
    return Object.entries(badges)
      .sort(([, a], [, b]) => b.unlockedAt - a.unlockedAt)
      .slice(0, 4)
      .map(([id]) => BADGE_DEFINITIONS[id as keyof typeof BADGE_DEFINITIONS])
      .filter(Boolean);
  }, [badges]);

  return (
    <Dialog open={open} onOpenChange={(isOpen) => !isOpen && handleClose()}>
      <DialogContent className="achievement-hub-dialog">
        <DialogHeader onClose={handleClose}>
          <DialogTitle>Your Progress</DialogTitle>
        </DialogHeader>

        <Tabs value={activeTab} onValueChange={handleTabChange} className="achievement-hub-tabs">
          <TabsList className="achievement-hub-tab-list">
            <TabsTrigger value="overview" className="achievement-hub-tab">Overview</TabsTrigger>
            <TabsTrigger value="time" className="achievement-hub-tab">Time Saved</TabsTrigger>
            <TabsTrigger value="badges" className="achievement-hub-tab">Badges</TabsTrigger>
            <TabsTrigger value="journey" className="achievement-hub-tab">Journey</TabsTrigger>
          </TabsList>

          {/* ─────────────────────────────────────────────────────────────────
              OVERVIEW TAB
              ───────────────────────────────────────────────────────────────── */}
          <TabsContent value="overview" className="achievement-hub-content">
            <div className={`achievement-hub__fade ${animationReady ? 'achievement-hub__fade--visible' : ''}`}>
              {/* Hero time saved — four-state hero. See selectTimeSavedHeroState. */}
              {heroState.kind === 'weekly' && (
                <div className="achievement-hub__hero">
                  <span className="achievement-hub__eyebrow">Time saved this week</span>
                  <div className="achievement-hub__hero-value">
                    <span className={`achievement-hub__hero-number ${weekComplete ? 'achievement-hub__hero-number--landed' : ''}`}>
                      {weekDisplay}
                    </span>
                    <span className="achievement-hub__hero-unit">{weekHero.unit}</span>
                  </div>
                  <p className="achievement-hub__hero-context">{getTimeTranslation(weekMinutes)}</p>
                  {highImpactCount > 0 && (
                    <p className="achievement-hub__high-impact-count">
                      ⚡ {highImpactCount} that actually mattered
                    </p>
                  )}
                </div>
              )}

              {heroState.kind === 'allTime' && (
                <div className="achievement-hub__hero achievement-hub__hero--alltime">
                  <span className="achievement-hub__eyebrow">Time saved so far</span>
                  <div className="achievement-hub__hero-value">
                    <span className={`achievement-hub__hero-number ${overviewAllTimeComplete ? 'achievement-hub__hero-number--landed' : ''}`}>
                      {overviewAllTimeDisplay}
                    </span>
                    <span className="achievement-hub__hero-unit">{allTimeHero.unit}</span>
                  </div>
                  <p className="achievement-hub__hero-context">Nothing logged this week yet. Your total is still here.</p>
                </div>
              )}

              {heroState.kind === 'empty' && (
                <div className="achievement-hub__hero">
                  <span className="achievement-hub__eyebrow">Time saved</span>
                  <div className="achievement-hub__hero-value">
                    <span className="achievement-hub__hero-number achievement-hub__hero-number--landed achievement-hub__hero-number--phrase">
                      No time saved yet
                    </span>
                  </div>
                  <p className="achievement-hub__hero-context">
                    Once Rebel has enough activity to count, your saved time will appear here.
                  </p>
                </div>
              )}

              {heroState.kind === 'error' && (
                <div className="achievement-hub__hero achievement-hub__hero--error">
                  <span className="achievement-hub__eyebrow">Time saved</span>
                  <div className="achievement-hub__hero-value">
                    <span className="achievement-hub__hero-number achievement-hub__hero-number--landed achievement-hub__hero-number--phrase">
                      Couldn&rsquo;t load right now
                    </span>
                  </div>
                  <p className="achievement-hub__hero-context">
                    Your progress has not been reset. Try again in a moment.
                  </p>
                </div>
              )}

              {/* Quick stats row */}
              <div className="achievement-hub__stats-row">
                <div className="achievement-hub__stat">
                  <Flame size={18} className="achievement-hub__stat-icon achievement-hub__stat-icon--streak" />
                  <span className="achievement-hub__stat-value">{streak?.current ?? 0}</span>
                  <span className="achievement-hub__stat-label">streak</span>
                </div>
                <div className="achievement-hub__stat">
                  <Trophy size={18} className="achievement-hub__stat-icon achievement-hub__stat-icon--badge" />
                  <span className="achievement-hub__stat-value">{unlockedBadgeCount}</span>
                  <span className="achievement-hub__stat-label">badges</span>
                </div>
                <div className="achievement-hub__stat">
                  <Target size={18} className="achievement-hub__stat-icon achievement-hub__stat-icon--journey" />
                  <span className="achievement-hub__stat-value">{journeyProgress}/14</span>
                  <span className="achievement-hub__stat-label">journey</span>
                </div>
              </div>

              {/* Fluency Tier */}
              <div className="achievement-hub__tier-section">
                <FluencyTierCard compact />
              </div>

              {/* Recent badges */}
              {recentBadges.length > 0 && (
                <div className="achievement-hub__recent-badges">
                  <div className="achievement-hub__section-header">
                    <h4 className="achievement-hub__section-title">Recent Badges</h4>
                    <button 
                      className="achievement-hub__section-link"
                      onClick={() => setActiveTab('badges')}
                    >
                      View all <ChevronRight size={14} />
                    </button>
                  </div>
                  <div className="achievement-hub__badge-row">
                    {recentBadges.map(badge => (
                      <Tooltip key={badge.id} content={<><strong>{badge.name}</strong><br/>{badge.rebelVoice}</>} delayShow={200}>
                        <div className="achievement-hub__badge-item">
                          <span className="achievement-hub__badge-icon">{badge.icon}</span>
                        </div>
                      </Tooltip>
                    ))}
                  </div>
                </div>
              )}
            </div>
          </TabsContent>

          {/* ─────────────────────────────────────────────────────────────────
              TIME SAVED TAB
              ───────────────────────────────────────────────────────────────── */}
          <TabsContent value="time" className="achievement-hub-content">
            <div className="achievement-hub__time-subtabs">
              <button 
                className={`achievement-hub__time-subtab ${timeSubTab === 'week' ? 'achievement-hub__time-subtab--active' : ''}`}
                onClick={() => { setTimeSubTab('week'); setSelectedDay(null); }}
              >
                This Week
              </button>
              <button 
                className={`achievement-hub__time-subtab ${timeSubTab === 'alltime' ? 'achievement-hub__time-subtab--active' : ''}`}
                onClick={() => setTimeSubTab('alltime')}
              >
                All Time
              </button>
            </div>

            {timeSubTab === 'week' ? (
              <div className={`achievement-hub__fade ${animationReady ? 'achievement-hub__fade--visible' : ''}`}>
                {heroState.kind === 'weekly' && (
                  <div className="achievement-hub__hero achievement-hub__hero--compact">
                    <div className="achievement-hub__hero-value">
                      <span className={`achievement-hub__hero-number ${weekComplete ? 'achievement-hub__hero-number--landed' : ''}`}>
                        {weekDisplay}
                      </span>
                      <span className="achievement-hub__hero-unit">{weekHero.unit}</span>
                    </div>
                    <p className="achievement-hub__hero-context">{getTimeTranslation(weekMinutes)}</p>
                  </div>
                )}

                {heroState.kind === 'allTime' && (
                  <div className="achievement-hub__hero achievement-hub__hero--compact">
                    <div className="achievement-hub__hero-value">
                      <span className="achievement-hub__hero-number achievement-hub__hero-number--landed achievement-hub__hero-number--phrase">
                        No saved time logged this week
                      </span>
                    </div>
                    <p className="achievement-hub__hero-context">Your total is still here. This week&rsquo;s estimates need to be logged first.</p>
                  </div>
                )}

                {heroState.kind === 'empty' && (
                  <div className="achievement-hub__hero achievement-hub__hero--compact">
                    <div className="achievement-hub__hero-value">
                      <span className="achievement-hub__hero-number achievement-hub__hero-number--landed achievement-hub__hero-number--phrase">
                        No time saved yet
                      </span>
                    </div>
                    <p className="achievement-hub__hero-context">
                      Once Rebel has enough activity to count, your saved time will appear here.
                    </p>
                  </div>
                )}

                {heroState.kind === 'error' && (
                  <div className="achievement-hub__hero achievement-hub__hero--compact achievement-hub__hero--error">
                    <div className="achievement-hub__hero-value">
                      <span className="achievement-hub__hero-number achievement-hub__hero-number--landed achievement-hub__hero-number--phrase">
                        Couldn&rsquo;t load right now
                      </span>
                    </div>
                    <p className="achievement-hub__hero-context">
                      Your progress has not been reset. Try again in a moment.
                    </p>
                  </div>
                )}

                {weekDailyTotals && (
                  <DayByDayChart 
                    dailyTotals={weekDailyTotals}
                    selectedDay={selectedDay}
                    onDayClick={handleDayClick}
                    highImpactDays={highImpactDays}
                  />
                )}

                {daySessionsLoading ? (
                  <div className="achievement-hub__sessions">
                    <h4 className="achievement-hub__section-title">{sessionsTitle}</h4>
                    <p className="achievement-hub__loading">Loading achievements…</p>
                  </div>
                ) : (displayedSessions.length > 0 || selectedDay) && (
                  <TopSessionsList
                    topSessions={displayedSessions}
                    onNavigateToSession={onNavigateToSession}
                    onClose={onClose}
                    title={sessionsTitle}
                    emptyMessage={selectedDay ? 'No conversations this day' : undefined}
                    maxDisplay={selectedDay ? 3 : 5}
                  />
                )}

                <p className="achievement-hub__quip">{quip}</p>
              </div>
            ) : (
              <div className={`achievement-hub__fade ${animationReady ? 'achievement-hub__fade--visible' : ''}`}>
                <div className="achievement-hub__hero achievement-hub__hero--alltime">
                  <span className="achievement-hub__eyebrow">Total estimated</span>
                  <div className="achievement-hub__hero-value">
                    <span className={`achievement-hub__hero-number ${allTimeComplete ? 'achievement-hub__hero-number--landed' : ''}`}>
                      {allTimeDisplay}
                    </span>
                    <span className="achievement-hub__hero-unit">{allTimeHero.unit}</span>
                  </div>
                  {trackingSince && (
                    <span className="achievement-hub__hero-since">since {formatTrackingSince(trackingSince)}</span>
                  )}
                  <p className="achievement-hub__hero-context">{getAllTimeTranslation(allTimeMinutes)}</p>
                </div>

                <div className="achievement-hub__alltime-stats">
                  <div className="achievement-hub__alltime-stat">
                    <span className="achievement-hub__alltime-value">
                      {formatTimeCompact(aggregates?.currentMonth?.totalMinutes ?? 0)}
                    </span>
                    <span className="achievement-hub__alltime-label">This month</span>
                  </div>
                  <div className="achievement-hub__alltime-stat">
                    <span className="achievement-hub__alltime-value">
                      {aggregates?.allTime?.sessionCount ?? 0}
                    </span>
                    <span className="achievement-hub__alltime-label">Sessions</span>
                  </div>
                </div>

                <p className="achievement-hub__quip">{quip}</p>
              </div>
            )}
          </TabsContent>

          {/* ─────────────────────────────────────────────────────────────────
              BADGES TAB
              ───────────────────────────────────────────────────────────────── */}
          <TabsContent value="badges" className="achievement-hub-content">
            {unlockedBadgeCount === 0 && (
              <p className="achievement-hub__badges-empty">
                Start exploring to unlock your first badge. Each one marks a milestone in your AI journey.
              </p>
            )}
            <div className="achievement-hub__badge-gallery">
              {CATEGORY_ORDER.map(category => {
                const categoryBadges = getBadgesByCategory(category);
                // Filter out secret badges unless they're unlocked
                const visibleBadges = categoryBadges.filter(badge => !badge.isSecret || !!badges[badge.id]);
                if (visibleBadges.length === 0) return null;
                return (
                  <div key={category} className="achievement-hub__badge-category">
                    <h3 className="achievement-hub__category-title">{CATEGORY_LABELS[category]}</h3>
                    <div className="achievement-hub__badge-grid">
                      {visibleBadges.map(badge => {
                        const isUnlocked = !!badges[badge.id];
                        return (
                          <Tooltip 
                            key={badge.id} 
                            content={<><strong>{badge.name}</strong><br/>{isUnlocked ? badge.rebelVoice : badge.description}</>}
                            delayShow={200}
                          >
                            <div className={`achievement-hub__gallery-badge ${isUnlocked ? 'achievement-hub__gallery-badge--unlocked' : ''}`}>
                              <span className="achievement-hub__gallery-badge-icon">{badge.icon}</span>
                              <span className="achievement-hub__gallery-badge-name">{badge.name}</span>
                              {isUnlocked && <span className="achievement-hub__gallery-badge-check">✓</span>}
                            </div>
                          </Tooltip>
                        );
                      })}
                    </div>
                  </div>
                );
              })}
            </div>
          </TabsContent>

          {/* ─────────────────────────────────────────────────────────────────
              JOURNEY TAB
              ───────────────────────────────────────────────────────────────── */}
          <TabsContent value="journey" className="achievement-hub-content">
            <div className="achievement-hub__journey">
              <MaturityBadge level="labs" featureName="Journey" className="achievement-hub__journey-labs-badge" tooltip="This feature is very early and actively in progress. Click to share feedback." />
              <p className="achievement-hub__journey-intro">
                {journeyProgress >= 14
                  ? "You've completed the 14-day journey. The habits you've built will compound from here."
                  : "14 days to AI fluency. Each builds on the last. Complete today's task in The Spark."}
              </p>
              
              {journeyProgress >= 14 && (
                <div className="achievement-hub__journey-complete">
                  <span className="achievement-hub__journey-complete-icon">🎉</span>
                  <span>Journey Complete</span>
                </div>
              )}

              {/* Week 1 */}
              <div className="achievement-hub__journey-week">
                <h4 className="achievement-hub__journey-week-title">Week 1: Foundations</h4>
                <div className="achievement-hub__journey-list">
                  {[1, 2, 3, 4, 5, 6, 7].map(day => {
                    const task = DAILY_TASKS[day];
                    const isComplete = journey?.completedDays.includes(day);
                    const isCurrent = journeyProgress + 1 === day;
                    const isLocked = day > journeyProgress + 1;
                    const isClickable = isCurrent && (onSelectJourneyTask || onNavigateToSpark);
                    
                    const itemContent = (
                      <>
                        <div className="achievement-hub__journey-item-day">
                          {isComplete ? '✓' : day}
                        </div>
                        <div className="achievement-hub__journey-item-content">
                          <span className="achievement-hub__journey-item-title">{task.title}</span>
                          <span className="achievement-hub__journey-item-desc">{task.description}</span>
                        </div>
                        {isClickable && <Rocket size={16} className="achievement-hub__journey-item-rocket" />}
                      </>
                    );
                    
                    if (isClickable) {
                      return (
                        <Tooltip key={day} content={onSelectJourneyTask ? "Start today's task" : "Go to The Spark to complete today's task"} placement="right">
                          <button
                            type="button"
                            className={`achievement-hub__journey-item achievement-hub__journey-item--current achievement-hub__journey-item--clickable`}
                            onClick={() => {
                              handleClose();
                              if (onSelectJourneyTask) {
                                tracking.journey.dayStarted(day, task.title);
                                if (day === 1 || day === 4 || day === 6 || day === 7 || day === 14) {
                                  void window.api.completeJourneyDay?.(day);
                                }
                                onSelectJourneyTask(task.prompt);
                              } else {
                                onNavigateToSpark?.();
                              }
                            }}
                          >
                            {itemContent}
                          </button>
                        </Tooltip>
                      );
                    }
                    
                    return (
                      <div
                        key={day}
                        className={`achievement-hub__journey-item ${isComplete ? 'achievement-hub__journey-item--complete' : ''} ${isCurrent ? 'achievement-hub__journey-item--current' : ''} ${isLocked ? 'achievement-hub__journey-item--locked' : ''}`}
                      >
                        {itemContent}
                      </div>
                    );
                  })}
                </div>
              </div>

              {/* Week 2 */}
              <div className="achievement-hub__journey-week">
                <h4 className="achievement-hub__journey-week-title">Week 2: Advanced Patterns</h4>
                <div className="achievement-hub__journey-list">
                  {[8, 9, 10, 11, 12, 13, 14].map(day => {
                    const task = DAILY_TASKS[day];
                    const isComplete = journey?.completedDays.includes(day);
                    const isCurrent = journeyProgress + 1 === day;
                    const isLocked = day > journeyProgress + 1;
                    const isClickable = isCurrent && (onSelectJourneyTask || onNavigateToSpark);
                    
                    const itemContent = (
                      <>
                        <div className="achievement-hub__journey-item-day">
                          {isComplete ? '✓' : day}
                        </div>
                        <div className="achievement-hub__journey-item-content">
                          <span className="achievement-hub__journey-item-title">{task.title}</span>
                          <span className="achievement-hub__journey-item-desc">{task.description}</span>
                        </div>
                        {isClickable && <Rocket size={16} className="achievement-hub__journey-item-rocket" />}
                      </>
                    );
                    
                    if (isClickable) {
                      return (
                        <Tooltip key={day} content={onSelectJourneyTask ? "Start today's task" : "Go to The Spark to complete today's task"} placement="right">
                          <button
                            type="button"
                            className={`achievement-hub__journey-item achievement-hub__journey-item--current achievement-hub__journey-item--clickable`}
                            onClick={() => {
                              handleClose();
                              if (onSelectJourneyTask) {
                                tracking.journey.dayStarted(day, task.title);
                                if (day === 1 || day === 4 || day === 6 || day === 7 || day === 14) {
                                  void window.api.completeJourneyDay?.(day);
                                }
                                onSelectJourneyTask(task.prompt);
                              } else {
                                onNavigateToSpark?.();
                              }
                            }}
                          >
                            {itemContent}
                          </button>
                        </Tooltip>
                      );
                    }
                    
                    return (
                      <div
                        key={day}
                        className={`achievement-hub__journey-item ${isComplete ? 'achievement-hub__journey-item--complete' : ''} ${isCurrent ? 'achievement-hub__journey-item--current' : ''} ${isLocked ? 'achievement-hub__journey-item--locked' : ''}`}
                      >
                        {itemContent}
                      </div>
                    );
                  })}
                </div>
              </div>
            </div>
          </TabsContent>
        </Tabs>
      </DialogContent>
    </Dialog>
  );
}
