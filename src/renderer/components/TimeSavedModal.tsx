import { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@renderer/components/ui/Dialog';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@renderer/components/ui/Tabs';
import { Tooltip } from '@renderer/components/ui/Tooltip';
import type { TimeSavedAggregates, TopSessionInfo } from '@shared/types';
import type { AgentSessionSidebarEntry } from '@renderer/features/agent-session/types';
import { formatAbsoluteTimestamp } from '@renderer/utils/formatters';
import { selectTimeSavedHeroState } from './achievementHubHeroState';
import './TimeSavedModal.css';

type CelebrationMode = 'first-week' | undefined;

type TimeSavedModalProps = {
  open: boolean;
  onClose: () => void;
  celebrationMode?: CelebrationMode;
  /** Session list for joining titles/cost - passed from parent for efficiency */
  sessions?: AgentSessionSidebarEntry[];
  /** Navigate to a session by ID */
  onNavigateToSession?: (sessionId: string) => void;
};

const formatTimeCompact = (minutes: number): string => {
  if (minutes < 60) {
    return `${Math.round(minutes)}m`;
  }
  // Round total minutes first to avoid edge case like 119.5 -> 1h 60m
  const totalRounded = Math.round(minutes);
  const hours = Math.floor(totalRounded / 60);
  const remainingMinutes = totalRounded % 60;
  if (remainingMinutes === 0) {
    return `${hours}h`;
  }
  return `${hours}h ${remainingMinutes}m`;
};

const formatTimeHero = (minutes: number): { value: number; unit: string } => {
  if (minutes < 60) {
    return { value: Math.round(minutes), unit: 'min' };
  }
  const hours = minutes / 60;
  if (hours < 10) {
    return { value: Math.round(hours * 10) / 10, unit: hours === 1 ? 'hour' : 'hours' };
  }
  return { value: Math.round(hours), unit: 'hours' };
};

const getContextualTranslation = (minutes: number): string => {
  const hours = minutes / 60;
  
  if (minutes < 30) {
    return "Roughly a coffee break.";
  }
  if (minutes < 60) {
    return "About a meeting's worth.";
  }
  if (hours < 2) {
    return "A couple of meetings, roughly.";
  }
  if (hours < 4) {
    return "A few hours of deep work.";
  }
  if (hours < 8) {
    return "An afternoon of focused time.";
  }
  if (hours < 16) {
    return "Roughly a workday.";
  }
  if (hours < 24) {
    return "About two workdays.";
  }
  if (hours < 40) {
    return "Nearly a work week.";
  }
  if (hours < 80) {
    return "More than a full work week.";
  }
  if (hours < 168) {
    return "Multiple workdays.";
  }
  // 168+ hours = 7+ days
  return "About a full week.";
};

const getAllTimeTranslation = (minutes: number): string => {
  const hours = minutes / 60;
  const weeks = hours / 40; // work weeks
  
  if (hours < 1) {
    return "Building up over time.";
  }
  if (hours < 8) {
    return "Working toward a full day.";
  }
  if (hours < 24) {
    return "Roughly a workday.";
  }
  if (hours < 40) {
    return "Nearly a work week.";
  }
  if (weeks < 2) {
    return "Over a work week.";
  }
  if (weeks < 4) {
    return "Multiple work weeks.";
  }
  if (weeks < 8) {
    return "About a month of work time.";
  }
  if (weeks < 13) {
    return "A quarter's worth of time.";
  }
  if (weeks < 26) {
    return "About half a year's worth.";
  }
  if (weeks < 52) {
    return "Nearly a year's worth.";
  }
  return "Over a year's worth.";
};

const formatTrackingSince = (timestamp: number): string => {
  const date = new Date(timestamp);
  return date.toLocaleDateString('en-US', { 
    month: 'short', 
    day: 'numeric', 
    year: 'numeric' 
  });
};

const QUIPS = [
  "Based on typical manual effort.",
  "Estimates may vary.",
  "Your mileage may differ.",
  "Roughly speaking.",
  "Give or take.",
];

const getRandomQuip = (): string => {
  return QUIPS[Math.floor(Math.random() * QUIPS.length)];
};

const DAY_LABELS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

const formatDateForTooltip = (dateStr: string): string => {
  // dateStr is YYYY-MM-DD in local time
  const [year, month, day] = dateStr.split('-').map(Number);
  const date = new Date(year, month - 1, day);
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
};

const formatCostCompact = (costUsd: number): string => {
  if (costUsd < 0.01) return '<$0.01';
  if (costUsd < 1) return `$${costUsd.toFixed(2)}`;
  return `$${costUsd.toFixed(2)}`;
};

interface TopSessionWithMeta extends TopSessionInfo {
  title: string;
  costUsd: number | null;
  isDeleted: boolean;
  isUnknown: boolean;
}

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

type TopSessionsListProps = {
  topSessions: TopSessionWithMeta[];
  onNavigateToSession?: (sessionId: string) => void;
  onClose: () => void;
  title?: string;
  emptyMessage?: string;
  /** Max number of sessions to display (default: 5 for week, 3 for day) */
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
  // Filter out deleted and unknown sessions, then limit to maxDisplay
  // Unknown sessions are orphaned entries from deleted conversations or system automations
  // Backend over-fetches to ensure enough valid sessions remain after filtering
  const visibleSessions = topSessions
    .filter(s => !s.isDeleted && !s.isUnknown)
    .slice(0, maxDisplay);
  
  if (visibleSessions.length === 0) {
    if (emptyMessage) {
      return (
        <div className="time-saved-modal__top-sessions">
          <h4 className="time-saved-modal__section-title">{title}</h4>
          <p className="time-saved-modal__empty-message">{emptyMessage}</p>
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
    <div className="time-saved-modal__top-sessions">
      <h4 className="time-saved-modal__section-title">{title}</h4>
      <ul className="time-saved-modal__session-list">
        {visibleSessions.map(session => {
          // Build tooltip content with structured layout matching SessionTooltipContent
          // Use reasoning as a short summary title, reasoningDetail for expanded justification
          const tooltipContent = (
            <div className="time-saved-modal__session-tooltip">
              <div className="time-saved-modal__tooltip-title">{session.title}</div>
              {session.reasoning && (
                <div className="time-saved-modal__tooltip-reasoning">{session.reasoning}</div>
              )}
              {session.reasoningDetail && (
                <div className="time-saved-modal__tooltip-reasoning">{session.reasoningDetail}</div>
              )}
              <div className="time-saved-modal__tooltip-metadata">
                <span>{formatAbsoluteTimestamp(session.latestTimestamp)}</span>
                {session.costUsd != null && session.costUsd > 0 && (
                  <>
                    <span className="time-saved-modal__tooltip-separator">·</span>
                    <span>{formatCostCompact(session.costUsd)}</span>
                  </>
                )}
                <span className="time-saved-modal__tooltip-separator">·</span>
                <span>{session.entryCount} estimate{session.entryCount !== 1 ? 's' : ''}</span>
              </div>
            </div>
          );

          return (
            <li key={session.sessionId}>
              <Tooltip content={tooltipContent} placement="left" delayShow={200}>
                <button
                  className="time-saved-modal__session-item"
                  onClick={() => handleClick(session)}
                  disabled={!onNavigateToSession}
                  type="button"
                >
                  <span className="time-saved-modal__session-title">{session.title}</span>
                  <span className="time-saved-modal__session-time">
                    ~{formatTimeCompact(session.totalMinutes)}
                  </span>
                </button>
              </Tooltip>
            </li>
          );
        })}
      </ul>
    </div>
  );
};

const formatDayTitle = (dateStr: string): string => {
  const [year, month, day] = dateStr.split('-').map(Number);
  const date = new Date(year, month - 1, day);
  const dayName = date.toLocaleDateString('en-US', { weekday: 'long' });
  const formatted = date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  return `${dayName}, ${formatted}`;
};

type DayByDayChartProps = {
  dailyTotals: Record<string, number>;
  selectedDay: string | null;
  onDayClick: (date: string | null) => void;
};

const DayByDayChart = ({ dailyTotals, selectedDay, onDayClick }: DayByDayChartProps) => {
  const sortedDates = Object.keys(dailyTotals).sort();
  
  return (
    <div className="time-saved-modal__days">
      {sortedDates.map((date, i) => {
        const minutes = dailyTotals[date];
        const hasActivity = minutes > 0;
        const isSelected = selectedDay === date;
        
        const handleClick = () => {
          if (!hasActivity) return;
          // Toggle: clicking selected day deselects it
          onDayClick(isSelected ? null : date);
        };
        
        return (
          <button
            key={date}
            type="button"
            className={`time-saved-modal__day ${hasActivity ? 'time-saved-modal__day--clickable' : ''} ${isSelected ? 'time-saved-modal__day--selected' : ''}`}
            onClick={handleClick}
            disabled={!hasActivity}
            aria-pressed={isSelected}
            aria-label={`${DAY_LABELS[i]}, ${formatDateForTooltip(date)}${hasActivity ? `, ${formatTimeCompact(minutes)} saved` : ', no activity'}`}
          >
            <span className="time-saved-modal__day-label">{DAY_LABELS[i]}</span>
            <span className={`time-saved-modal__day-dot ${hasActivity ? 'time-saved-modal__day-dot--active' : ''}`} />
            {hasActivity ? (
              <span className="time-saved-modal__day-value">{formatTimeCompact(minutes)}</span>
            ) : (
              <span className="time-saved-modal__day-value time-saved-modal__day-value--empty">&nbsp;</span>
            )}
          </button>
        );
      })}
    </div>
  );
};

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
      if (!startTimeRef.current) {
        startTimeRef.current = timestamp;
      }
      
      const elapsed = timestamp - startTimeRef.current;
      const progress = Math.min(elapsed / duration, 1);
      
      // easeOutQuart for satisfying deceleration
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
    
    return () => {
      if (frameRef.current) {
        cancelAnimationFrame(frameRef.current);
      }
    };
  }, [target, duration, enabled]);

  return { current, isComplete };
};

export const TimeSavedModal = ({
  open,
  onClose,
  celebrationMode,
  sessions = [],
  onNavigateToSession,
}: TimeSavedModalProps) => {
  const [aggregates, setAggregates] = useState<TimeSavedAggregates | null>(null);
  const [trackingSince, setTrackingSince] = useState<number | null>(null);
  const [weekDailyTotals, setWeekDailyTotals] = useState<Record<string, number> | null>(null);
  const [weekTopSessions, setWeekTopSessions] = useState<TopSessionInfo[]>([]);
  const [aggregatesFetchError, setAggregatesFetchError] = useState(false);
  const [animationReady, setAnimationReady] = useState(false);
  const [activeTab, setActiveTab] = useState<'week' | 'alltime'>('week');
  const [selectedDay, setSelectedDay] = useState<string | null>(null);
  const [dayTopSessions, setDayTopSessions] = useState<TopSessionInfo[]>([]);
  const [daySessionsLoading, setDaySessionsLoading] = useState(false);
  const daySessionsCache = useRef<Record<string, TopSessionInfo[]>>({});
  const quip = useMemo(() => getRandomQuip(), []);
  
  const title = celebrationMode === 'first-week' ? 'Week One. In the Books.' : 'Your Time';

  useEffect(() => {
    if (open) {
      setAnimationReady(false);
      setActiveTab('week');
      setSelectedDay(null);
      setDayTopSessions([]);
      setAggregatesFetchError(false);
      daySessionsCache.current = {};
      
      // Fetch aggregates, daily totals, and top sessions in parallel
      Promise.allSettled([
        window.api.getTimeSavedAggregates(),
        window.api.getWeekDailyTotals(),
        window.api.getWeekTopSessions()
      ]).then(([aggregatesResult, dailyTotalsResult, topSessionsResult]) => {
        if (aggregatesResult.status === 'fulfilled') {
          setAggregates(aggregatesResult.value.aggregates);
          setTrackingSince(aggregatesResult.value.trackingSince);
          setAggregatesFetchError(false);
        } else {
          setAggregatesFetchError(true);
          console.error('Failed to fetch time saved aggregates:', aggregatesResult.reason);
        }
        if (dailyTotalsResult.status === 'fulfilled') {
          setWeekDailyTotals(dailyTotalsResult.value);
        }
        if (topSessionsResult.status === 'fulfilled') {
          setWeekTopSessions(topSessionsResult.value);
        }
        setTimeout(() => setAnimationReady(true), 50);
      }).catch((error) => {
        console.error('Failed to fetch time saved data:', error);
        setAggregatesFetchError(true);
      });
    } else {
      setAnimationReady(false);
    }
  }, [open]);

  // Track the current request to handle race conditions
  const currentRequestRef = useRef<string | null>(null);

  // Handle day selection - fetch sessions for that day (with cache)
  const handleDayClick = useCallback((date: string | null) => {
    setSelectedDay(date);
    currentRequestRef.current = date;
    
    if (!date) {
      setDayTopSessions([]);
      setDaySessionsLoading(false);
      return;
    }
    
    // Check cache first
    if (daySessionsCache.current[date]) {
      setDayTopSessions(daySessionsCache.current[date]);
      setDaySessionsLoading(false);
      return;
    }
    
    // Fetch from API
    setDaySessionsLoading(true);
    window.api.getTopSessionsForDay(date)
      .then(sessions => {
        // Only update if this is still the selected day (race condition guard)
        if (currentRequestRef.current !== date) return;
        daySessionsCache.current[date] = sessions;
        setDayTopSessions(sessions);
      })
      .catch(() => {
        if (currentRequestRef.current !== date) return;
        setDayTopSessions([]);
      })
      .finally(() => {
        if (currentRequestRef.current === date) {
          setDaySessionsLoading(false);
        }
      });
  }, []);

  // Reset day selection when switching tabs
  const handleTabChange = useCallback((tab: string) => {
    setActiveTab(tab as 'week' | 'alltime');
    if (tab === 'week') {
      setSelectedDay(null);
      setDayTopSessions([]);
    }
  }, []);

  // Enrich top sessions with title/cost from session list
  const enrichedWeekTopSessions = useMemo(() => {
    return enrichTopSessions(weekTopSessions, sessions);
  }, [weekTopSessions, sessions]);

  const enrichedDayTopSessions = useMemo(() => {
    return enrichTopSessions(dayTopSessions, sessions);
  }, [dayTopSessions, sessions]);

  // Determine which sessions to show and the title
  const displayedSessions = selectedDay ? enrichedDayTopSessions : enrichedWeekTopSessions;
  const sessionsTitle = selectedDay ? formatDayTitle(selectedDay) : 'Top Conversations';
  const sessionsEmptyMessage = selectedDay ? 'No conversations this day' : undefined;

  // Weekly view data
  const currentWeekMinutes = aggregates?.currentWeek.totalMinutes ?? 0;
  const allTimeMinutes = aggregates?.allTime.totalMinutes ?? 0;
  const weekHeroState = selectTimeSavedHeroState(currentWeekMinutes, allTimeMinutes, aggregatesFetchError);
  const weekHeroTime = formatTimeHero(currentWeekMinutes);
  const { current: weekAnimatedValue, isComplete: weekIsComplete } = useCountUp(
    weekHeroTime.value, 
    600, 
    animationReady && activeTab === 'week'
  );
  const weekContextualText = useMemo(() => getContextualTranslation(currentWeekMinutes), [currentWeekMinutes]);
  const weekDisplayValue = weekHeroTime.value % 1 === 0 
    ? Math.round(weekAnimatedValue)
    : weekAnimatedValue.toFixed(1);

  // All-time view data
  const allTimeHeroTime = formatTimeHero(allTimeMinutes);
  const { current: allTimeAnimatedValue, isComplete: allTimeIsComplete } = useCountUp(
    allTimeHeroTime.value, 
    600, 
    animationReady && activeTab === 'alltime'
  );
  const allTimeContextualText = useMemo(() => getAllTimeTranslation(allTimeMinutes), [allTimeMinutes]);
  const allTimeDisplayValue = allTimeHeroTime.value % 1 === 0 
    ? Math.round(allTimeAnimatedValue)
    : allTimeAnimatedValue.toFixed(1);

  const lastWeekTime = formatTimeCompact(aggregates?.lastWeek.totalMinutes ?? 0);
  const thisMonthTime = formatTimeCompact(aggregates?.currentMonth.totalMinutes ?? 0);

  return (
    <Dialog open={open} onOpenChange={(isOpen) => !isOpen && onClose()}>
      <DialogContent className="time-saved-modal">
        <DialogHeader onClose={onClose}>
          <DialogTitle>{title}</DialogTitle>
        </DialogHeader>
        
        <Tabs value={activeTab} onValueChange={handleTabChange}>
          <TabsList className="time-saved-modal__tabs">
            <TabsTrigger value="week">This Week</TabsTrigger>
            <TabsTrigger value="alltime">All Time</TabsTrigger>
          </TabsList>

          <TabsContent value="week">
            <div className={`time-saved-modal__content ${animationReady ? 'time-saved-modal__content--visible' : ''}`}>
              {weekHeroState.kind === 'weekly' && (
                <div className="time-saved-modal__hero">
                  <span className="time-saved-modal__eyebrow">Estimated time saved</span>
                  <div className="time-saved-modal__value-group">
                    <span className={`time-saved-modal__value ${weekIsComplete ? 'time-saved-modal__value--landed' : ''}`}>
                      {weekDisplayValue}
                    </span>
                    <span className="time-saved-modal__unit">{weekHeroTime.unit}</span>
                  </div>
                  <span className="time-saved-modal__label">this week</span>
                  <p className="time-saved-modal__context">{weekContextualText}</p>
                </div>
              )}

              {weekHeroState.kind === 'allTime' && (
                <div className="time-saved-modal__hero">
                  <span className="time-saved-modal__eyebrow">Estimated time saved</span>
                  <div className="time-saved-modal__value-group">
                    <span className="time-saved-modal__value time-saved-modal__value--landed time-saved-modal__value--phrase">
                      No saved time logged this week
                    </span>
                  </div>
                  <p className="time-saved-modal__context">Your total is still here. This week&rsquo;s estimates need to be logged first.</p>
                </div>
              )}

              {weekHeroState.kind === 'empty' && (
                <div className="time-saved-modal__hero">
                  <span className="time-saved-modal__eyebrow">Estimated time saved</span>
                  <div className="time-saved-modal__value-group">
                    <span className="time-saved-modal__value time-saved-modal__value--landed time-saved-modal__value--phrase">
                      No time saved yet
                    </span>
                  </div>
                  <p className="time-saved-modal__context">Once Rebel has enough activity to count, your saved time will appear here.</p>
                </div>
              )}

              {weekHeroState.kind === 'error' && (
                <div className="time-saved-modal__hero time-saved-modal__hero--error">
                  <span className="time-saved-modal__eyebrow">Estimated time saved</span>
                  <div className="time-saved-modal__value-group">
                    <span className="time-saved-modal__value time-saved-modal__value--landed time-saved-modal__value--phrase">
                      Couldn&rsquo;t load right now
                    </span>
                  </div>
                  <p className="time-saved-modal__context">Your progress has not been reset. Try again in a moment.</p>
                </div>
              )}
              
              {weekDailyTotals && (
                <DayByDayChart 
                  dailyTotals={weekDailyTotals} 
                  selectedDay={selectedDay}
                  onDayClick={handleDayClick}
                />
              )}
              
              {daySessionsLoading ? (
                <div className="time-saved-modal__top-sessions">
                  <h4 className="time-saved-modal__section-title">{sessionsTitle}</h4>
                  <p className="time-saved-modal__loading-message">Tallying the numbers…</p>
                </div>
              ) : (displayedSessions.length > 0 || selectedDay) && (
                <TopSessionsList
                  topSessions={displayedSessions}
                  onNavigateToSession={onNavigateToSession}
                  onClose={onClose}
                  title={sessionsTitle}
                  emptyMessage={sessionsEmptyMessage}
                  maxDisplay={selectedDay ? 3 : 5}
                />
              )}
              
              <div className="time-saved-modal__stats">
                <div className="time-saved-modal__stat">
                  <span className="time-saved-modal__stat-value">{lastWeekTime}</span>
                  <span className="time-saved-modal__stat-label">Last week</span>
                </div>
                <div className="time-saved-modal__stat">
                  <span className="time-saved-modal__stat-value">{aggregates?.currentWeek.sessionCount ?? 0}</span>
                  <span className="time-saved-modal__stat-label">Sessions</span>
                </div>
              </div>
              
              <p className="time-saved-modal__quip">{quip}</p>
            </div>
          </TabsContent>

          <TabsContent value="alltime">
            <div className={`time-saved-modal__content ${animationReady ? 'time-saved-modal__content--visible' : ''}`}>
              <div className="time-saved-modal__hero time-saved-modal__hero--alltime">
                <span className="time-saved-modal__eyebrow">Total estimated</span>
                <div className="time-saved-modal__value-group">
                  <span className={`time-saved-modal__value ${allTimeIsComplete ? 'time-saved-modal__value--landed' : ''}`}>
                    {allTimeDisplayValue}
                  </span>
                  <span className="time-saved-modal__unit">{allTimeHeroTime.unit}</span>
                </div>
                {trackingSince && (
                  <span className="time-saved-modal__label">since {formatTrackingSince(trackingSince)}</span>
                )}
                <p className="time-saved-modal__context">{allTimeContextualText}</p>
              </div>
              
              <div className="time-saved-modal__stats">
                <div className="time-saved-modal__stat">
                  <span className="time-saved-modal__stat-value">{thisMonthTime}</span>
                  <span className="time-saved-modal__stat-label">This month</span>
                </div>
                <div className="time-saved-modal__stat">
                  <span className="time-saved-modal__stat-value">{aggregates?.allTime.sessionCount ?? 0}</span>
                  <span className="time-saved-modal__stat-label">Sessions</span>
                </div>
              </div>
              
              <p className="time-saved-modal__quip">{quip}</p>
            </div>
          </TabsContent>
        </Tabs>
      </DialogContent>
    </Dialog>
  );
};
