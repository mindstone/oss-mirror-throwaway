/**
 * Onboarding Journey Card
 * 
 * Shows daily task during the 14-day onboarding journey.
 * Includes Rebel's voice explaining why this journey matters.
 * Tracks completion via achievementsStore.
 */

import { useEffect, useState, useCallback, useRef } from 'react';
import { ChevronRight, Flame, Check, Trophy, PartyPopper, Rocket } from 'lucide-react';
import { useSettings } from '../settings';
import { Button, Tooltip } from '@renderer/components/ui';
import { DAILY_TASKS, getJourneyExplanation } from '@shared/onboardingJourney';
import { tracking } from '@renderer/src/tracking';
import styles from './OnboardingJourneyCard.module.css';

interface OnboardingJourneyCardProps {
  onSelectUseCase: (prompt: string) => void;
  /** Optional callback to open the Journey progress view */
  onOpenJourneyProgress?: () => void;
}

/**
 * Calculate current onboarding day from completion timestamp.
 * Day 1 is the day onboarding completed, Day 2 is the next calendar day, etc.
 */
function calculateOnboardingDay(completedAt: number | undefined): number | null {
  if (!completedAt) return null;
  
  const completedDate = new Date(completedAt);
  const today = new Date();
  
  // Reset to start of day for accurate day calculation
  completedDate.setHours(0, 0, 0, 0);
  today.setHours(0, 0, 0, 0);
  
  const msPerDay = 24 * 60 * 60 * 1000;
  const daysSinceCompletion = Math.floor((today.getTime() - completedDate.getTime()) / msPerDay);
  
  // Day 1 is completion day, so add 1
  return daysSinceCompletion + 1;
}

export function OnboardingJourneyCard({ onSelectUseCase, onOpenJourneyProgress }: OnboardingJourneyCardProps) {
  const { settings, saveSettingsWith } = useSettings();
  const [completedDays, setCompletedDays] = useState<number[]>([]);
  const [journeyComplete, setJourneyComplete] = useState(false);
  const [journeyLoaded, setJourneyLoaded] = useState(false);
  const [journeyStartedAt, setJourneyStartedAt] = useState<number | undefined>(undefined);
  const trackedDayRef = useRef<number | null>(null);
  
  // Calculate day dynamically from completion timestamp.
  // onboardingCompletedAt is a transient Phase 0 field that gets dropped by the startup migration.
  // onboardingFirstCompletedAt is the permanent timestamp — use it as the primary source.
  // Fallback to settings.onboardingDay during the reveal tour (before either timestamp is set).
  const calculatedDay = calculateOnboardingDay(
    settings?.onboardingFirstCompletedAt ?? settings?.onboardingCompletedAt ?? undefined
  );
  // If calendar day exceeds 14 but journey isn't complete, show the next incomplete day
  // so users stuck on earlier days still see their task card
  const nextIncompleteDay = completedDays.length < 14
    ? Array.from({ length: 14 }, (_, i) => i + 1).find(d => !completedDays.includes(d)) ?? null
    : null;
  const calendarDay = calculatedDay ?? settings?.onboardingDay ?? null;
  const day = calendarDay && calendarDay <= 14
    ? calendarDay
    : nextIncompleteDay;

  // Track day viewed (once per day, after journey data has loaded)
  useEffect(() => {
    if (journeyLoaded && day && day !== trackedDayRef.current && day <= 14) {
      trackedDayRef.current = day;
      const isTodayComplete = completedDays.includes(day);
      tracking.journey.dayViewed(day, completedDays.length, isTodayComplete);
    }
  }, [journeyLoaded, day, completedDays]);

  // Load journey state on mount
  useEffect(() => {
    const loadJourneyState = async () => {
      try {
        const journey = await window.api.getOnboardingJourney?.();
        if (journey) {
          setCompletedDays(journey.completedDays);
          setJourneyComplete(journey.completedDays.length >= 14);
          setJourneyStartedAt(journey.journeyStartedAt);
        }
      } catch {
        // Non-critical, ignore errors
      } finally {
        setJourneyLoaded(true);
      }
    };
    void loadJourneyState();
  }, []);

  // Listen for day completion events
  useEffect(() => {
    const cleanup = window.api.onJourneyDayCompleted?.((completedDay: number) => {
      setCompletedDays(prev => {
        if (prev.includes(completedDay)) return prev;
        const updated = [...prev, completedDay].sort((a, b) => a - b);
        if (updated.length >= 14) setJourneyComplete(true);
        
        // Track day completion
        const task = DAILY_TASKS[completedDay];
        if (task) {
          tracking.journey.dayCompleted(completedDay, task.title, updated.length);
        }
        
        return updated;
      });
    });
    return cleanup;
  }, []);

  // Handle manual day completion (for Day 7 and 14)
  const handleMarkComplete = useCallback(async () => {
    if (!day) return;
    try {
      await window.api.completeJourneyDay?.(day);
    } catch {
      // Non-critical
    }
  }, [day]);

  // Handle starting the journey for existing users who don't have onboardingCompletedAt
  const handleStartJourney = useCallback(async () => {
    // Set both: AppSettings (for renderer day calculation) and achievementsStore (for main process)
    // Do these independently so a failure in one doesn't block the other
    const now = Date.now();
    try {
      await saveSettingsWith((draft) => ({
        ...draft,
        onboardingCompletedAt: now,
        onboardingFirstCompletedAt: draft.onboardingFirstCompletedAt ?? now
      }));
    } catch {
      // Settings write failed, but still try to start journey
    }
    try {
      await window.api.startOnboardingJourney?.();
      // Update local state so banner disappears immediately
      setJourneyStartedAt(now);
    } catch {
      // Non-critical
    }
  }, [saveSettingsWith]);

  // Journey completed - show celebration
  if (journeyComplete) {
    return (
      <section className={styles.section}>
        <div data-tour="onboarding-journey">
        <div className={styles.celebrationCard}>
          <Trophy size={32} className={styles.trophyIcon} />
          <h2 className={styles.celebrationTitle}>Journey Complete</h2>
          <p className={styles.celebrationText}>
            14 days. You&apos;ve built real habits, not just tried features. 
            The compound returns start now.
          </p>
          <div className={styles.completedBadges}>
            {completedDays.slice(0, 7).map(d => (
              <span key={d} className={styles.completedDay}>{d}</span>
            ))}
            {completedDays.length > 7 && (
              <>
                <span className={styles.ellipsis}>...</span>
                {completedDays.slice(-3).map(d => (
                  <span key={d} className={styles.completedDay}>{d}</span>
                ))}
              </>
            )}
          </div>
        </div>
        </div>
      </section>
    );
  }

  // Show "Start Journey" banner for existing users who don't have a journey started
  // Conditions:
  // - Settings loaded (settings exists)
  // - Journey data loaded (journeyLoaded)
  // - No onboardingCompletedAt (missed the new onboarding flow)
  // - No onboardingDay (not in Phase 0 reveal tour, which sets onboardingDay before onboardingCompletedAt)
  // - Journey not already started in achievementsStore (journeyStartedAt would indicate it's started)
  // - Journey not complete
  const showStartBanner = settings && journeyLoaded && !settings.onboardingCompletedAt && !settings.onboardingDay && !journeyStartedAt && !journeyComplete;
  
  if (showStartBanner) {
    return (
      <section className={styles.section}>
        <div data-tour="onboarding-journey">
        <div className={styles.startJourneyBanner}>
          <div className={styles.startJourneyContent}>
            <Rocket size={24} className={styles.startJourneyIcon} />
            <div className={styles.startJourneyText}>
              <h2 className={styles.startJourneyTitle}>Your 14-day AI journey</h2>
              <p className={styles.startJourneyDescription}>
                Build lasting AI habits in just 5-10 minutes a day. Each day builds on the last.
              </p>
            </div>
          </div>
          <Tooltip content="Start a guided 14-day journey to build AI habits that stick" placement="bottom">
            <Button
              onClick={() => void handleStartJourney()}
              className={styles.startJourneyButton}
            >
              Start Journey
            </Button>
          </Tooltip>
        </div>
        </div>
      </section>
    );
  }
  
  if (!day || day > 14) return null;

  const task = DAILY_TASKS[day];
  if (!task) return null;

  const isTodayComplete = completedDays.includes(day);
  const progressPercent = Math.round((completedDays.length / 14) * 100);

  // Day 7: Week 1 celebration
  if (day === 7 && !isTodayComplete) {
    return (
      <section className={styles.section}>
        <div data-tour="onboarding-journey">
        <div className={styles.header}>
          <h2 className={styles.title}>Week 1 Complete!</h2>
          <span className={styles.dayBadge}>
            <span className={styles.badgeProgress} style={{ width: `${progressPercent}%` }} />
            <PartyPopper size={12} className={styles.flame} />
            <span className={styles.badgeText}>Day 7 of 14</span>
          </span>
        </div>

        <p className={styles.explanation}>
          One week down. You&apos;ve learned the foundations — context, memory, skills. 
          Now let&apos;s capture what&apos;s working before we level up.
        </p>

        <button
          type="button"
          className={styles.taskButton}
          onClick={() => {
            tracking.journey.dayStarted(7, task.title);
            void handleMarkComplete();
            onSelectUseCase(task.prompt);
          }}
        >
          <div className={styles.taskContent}>
            <h3 className={styles.taskTitle}>{task.title}</h3>
            <p className={styles.taskDescription}>{task.description}</p>
          </div>
          <ChevronRight size={18} className={styles.arrow} />
        </button>
        </div>
      </section>
    );
  }

  // Day 14: Graduation
  if (day === 14 && !isTodayComplete) {
    return (
      <section className={styles.section}>
        <div data-tour="onboarding-journey">
        <div className={styles.header}>
          <h2 className={styles.title}>Graduation Day</h2>
          <span className={styles.dayBadge}>
            <span className={styles.badgeProgress} style={{ width: `${progressPercent}%` }} />
            <Trophy size={12} className={styles.flame} />
            <span className={styles.badgeText}>Day 14 of 14</span>
          </span>
        </div>

        <p className={styles.explanation}>
          The grand finale. Today we capture everything you&apos;ve learned and build 
          your playbook for the next 90 days. You&apos;ve earned this.
        </p>

        <button
          type="button"
          className={styles.taskButton}
          onClick={() => {
            tracking.journey.dayStarted(14, task.title);
            void handleMarkComplete();
            onSelectUseCase(task.prompt);
          }}
        >
          <div className={styles.taskContent}>
            <h3 className={styles.taskTitle}>{task.title}</h3>
            <p className={styles.taskDescription}>{task.description}</p>
          </div>
          <Trophy size={18} className={styles.arrow} />
        </button>
        </div>
      </section>
    );
  }

  // Regular day (or completed special day)
  return (
    <section className={styles.section}>
      <div data-tour="onboarding-journey">
      <div className={styles.header}>
        <h2 className={styles.title}>Your 14-day journey</h2>
        {onOpenJourneyProgress ? (
          <Tooltip content="View full journey progress" placement="left">
            <button
              type="button"
              className={styles.dayBadgeButton}
              onClick={onOpenJourneyProgress}
            >
              <span 
                className={styles.badgeProgress} 
                style={{ width: `${progressPercent}%` }} 
              />
              {isTodayComplete ? (
                <Check size={12} className={styles.checkIcon} />
              ) : (
                <Flame size={12} className={styles.flame} />
              )}
              <span className={styles.badgeText}>Day {day} of 14</span>
            </button>
          </Tooltip>
        ) : (
          <span className={styles.dayBadge}>
            <span 
              className={styles.badgeProgress} 
              style={{ width: `${progressPercent}%` }} 
            />
            {isTodayComplete ? (
              <Check size={12} className={styles.checkIcon} />
            ) : (
              <Flame size={12} className={styles.flame} />
            )}
            <span className={styles.badgeText}>Day {day} of 14</span>
          </span>
        )}
      </div>

      <p className={styles.explanation}>
        {getJourneyExplanation(day)}
      </p>

      {isTodayComplete ? (
        <div className={styles.completedState}>
          <Check size={20} className={styles.completedCheck} />
          <span>Today&apos;s task complete</span>
        </div>
      ) : (
        <button
          type="button"
          className={styles.taskButton}
          onClick={() => {
            tracking.journey.dayStarted(day, task.title);
            // Days 1, 4, and 6 complete on click (UI-triggered tasks)
            // Day 1: "Context matters" — completes when user starts the task
            // Day 4: "Ran use case from The Spark", Day 6: "Viewed coaching insight"
            // Fire completion BEFORE navigation and optimistically update local state,
            // so the card shows "complete" even if the broadcast races with unmount.
            if (day === 1 || day === 4 || day === 6) {
              void window.api.completeJourneyDay?.(day);
              setCompletedDays(prev => {
                if (prev.includes(day)) return prev;
                return [...prev, day].sort((a, b) => a - b);
              });
            }
            onSelectUseCase(task.prompt);
          }}
        >
          <div className={styles.taskContent}>
            <h3 className={styles.taskTitle}>{task.title}</h3>
            <p className={styles.taskDescription}>{task.description}</p>
          </div>
          <ChevronRight size={18} className={styles.arrow} />
        </button>
      )}
      </div>
    </section>
  );
}
