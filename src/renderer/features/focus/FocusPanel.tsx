/**
 * FocusPanel — Strategic planning surface
 *
 * Layout (top to bottom):
 *   1. Control rail: Week/Month tabs (left) + period nav arrows (right)
 *   2. Overview band (full-width): CalendarStrip + WeekInsightsBar (or MonthLensCard)
 *   3. Two-column: Briefing narrative (left) + Goals rail (right)
 *      Goals rail shows inline time-alignment bars per goal
 *
 * @see docs/plans/260407_focus_goals_redesign.md
 * @see docs/plans/260409_focus_time_vs_goals_visualization.md
 */

import { useMemo, useState, useCallback } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { useMeetingCache } from '../usecases/hooks/useMeetingCache';
import { useFlowPanels } from '../flow-panels/FlowPanelsProvider';
import { useSpaceGoals } from './hooks/useSpaceGoals';
import { useGoalAlignment } from './hooks/useGoalAlignment';
import { CalendarStrip } from './components/CalendarStrip';
import { FocusNoCalendar } from './components/FocusNoCalendar';
import { GoalsSidebar } from './components/GoalsSidebar';
import { MonthLensCard } from './components/MonthLensCard';
import { MonthlyReviewCard } from './components/MonthlyReviewCard';
import { WeekInsightsBar } from './components/WeekInsightsBar';
import { WeeklyPrepCard } from './components/WeeklyPrepCard';
import { useFocusConversation } from './hooks/useFocusConversation';
import { getWeekBoundsForOffset, getMonthBoundsForOffset } from '../../../core/services/calendarTimeUtils';
import type { AnyAttachmentPayload } from '@shared/types/agent';
import { fireAndForget } from '@shared/utils/fireAndForget';
import styles from './FocusPanel.module.css';

// ─────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────

function getWeekLabel(offset: number): string {
  const now = new Date();
  const day = now.getDay();
  const monday = new Date(now);
  monday.setDate(now.getDate() - (day === 0 ? 6 : day - 1) + offset * 7);
  const sunday = new Date(monday);
  sunday.setDate(monday.getDate() + 6);

  const fmt = (d: Date) => d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
  if (offset === 0) return `This week · ${fmt(monday)} – ${fmt(sunday)}`;
  if (offset === -1) return `Last week · ${fmt(monday)} – ${fmt(sunday)}`;
  if (offset === 1) return `Next week · ${fmt(monday)} – ${fmt(sunday)}`;
  return `${fmt(monday)} – ${fmt(sunday)}`;
}

function getMonthLabel(offset: number): string {
  const now = new Date();
  const d = new Date(now.getFullYear(), now.getMonth() + offset, 1);
  const label = d.toLocaleDateString('en-GB', { month: 'long', year: 'numeric' });
  if (offset === 0) return `This month · ${label}`;
  if (offset === -1) return `Last month · ${label}`;
  return label;
}

// ─────────────────────────────────────────────────────────────
// Props
// ─────────────────────────────────────────────────────────────

interface FocusPanelProps {
  startFreshSession?: () => string;
  submitQueuedMessage?: (
    text: string,
    source?: 'text' | 'voice',
    attachments?: AnyAttachmentPayload[],
    options?: { targetSessionId?: string; existingMessageId?: string },
  ) => Promise<void> | void;
  onOpenConversation?: (sessionId: string) => void;
}

// ─────────────────────────────────────────────────────────────
// Component
// ─────────────────────────────────────────────────────────────

export function FocusPanel({ startFreshSession, submitQueuedMessage, onOpenConversation }: FocusPanelProps = {}) {
  const [activeTab, setActiveTab] = useState<'week' | 'month'>('week');
  const [weekOffset, setWeekOffset] = useState(0);
  const [monthOffset, setMonthOffset] = useState(0);

  const { activeSurface } = useFlowPanels();
  const isFocusActive = activeSurface === 'focus';

  const meetingCache = useMeetingCache(false, isFocusActive);
  const hasNoCalendar = !meetingCache.isLoading && meetingCache.populatedAt === null;

  const {
    spaceGoals,
    dismissedSpaces,
    spacesWithoutGoals,
    isLoading: goalsLoading,
    dismissSpace,
    restoreAllSpaces,
  } = useSpaceGoals(isFocusActive);

  const granularity = activeTab === 'week' ? 'week' as const : 'month' as const;
  const alignmentEnabled = isFocusActive && !hasNoCalendar;
  const { data: alignmentData } = useGoalAlignment(
    alignmentEnabled,
    granularity,
    dismissedSpaces.length,
    activeTab === 'week' ? weekOffset : undefined,
    activeTab === 'month' ? monthOffset : undefined,
  );

  const noopStart = useMemo(() => () => '', []);
  const noopSubmit = useMemo(() => () => {}, []);
  const canChat = Boolean(startFreshSession && submitQueuedMessage);
  const { startConversation } = useFocusConversation({
    startFreshSession: startFreshSession ?? noopStart,
    submitQueuedMessage: submitQueuedMessage ?? noopSubmit,
  });
  const startWeekConversation = useCallback(
    (prompt: string) => startConversation(prompt, 'week'),
    [startConversation],
  );
  const startMonthConversation = useCallback(
    (prompt: string) => startConversation(prompt, 'month'),
    [startConversation],
  );
  const startPrepConversation = useCallback(
    (prompt: string) => startConversation(prompt, 'prep-remaining'),
    [startConversation],
  );

  const continueConversation = useMemo(() => {
    if (!submitQueuedMessage || !onOpenConversation) return undefined;
    return (sessionId: string, message: string) => {
      fireAndForget(submitQueuedMessage(message, 'text', undefined, { targetSessionId: sessionId }), 'focusContinueConversation');
      onOpenConversation(sessionId);
    };
  }, [submitQueuedMessage, onOpenConversation]);

  // Period navigation
  const goBack = useCallback(() => {
    if (activeTab === 'week') setWeekOffset(o => o - 1);
    else setMonthOffset(o => o - 1);
  }, [activeTab]);

  const goForward = useCallback(() => {
    if (activeTab === 'week') setWeekOffset(o => o + 1);
    else setMonthOffset(o => o + 1);
  }, [activeTab]);

  const goToNow = useCallback(() => {
    if (activeTab === 'week') setWeekOffset(0);
    else setMonthOffset(0);
  }, [activeTab]);

  const periodLabel = activeTab === 'week' ? getWeekLabel(weekOffset) : getMonthLabel(monthOffset);
  const isCurrentPeriod = activeTab === 'week' ? weekOffset === 0 : monthOffset === 0;

  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;

  const weekBounds = useMemo(() => {
    const { start, end } = getWeekBoundsForOffset(weekOffset, tz);
    return { start: start.getTime(), end: end.getTime() };
  }, [weekOffset, tz]);

  const monthBounds = useMemo(() => {
    const { start, end } = getMonthBoundsForOffset(monthOffset, tz);
    return { start: start.getTime(), end: end.getTime() };
  }, [monthOffset, tz]);

  return (
    <div className={styles.container} data-testid="focus-panel">

      {/* ── Control rail: tabs + period nav ── */}
      <div className={styles.controlRail}>
        <div className={styles.tabGroup}>
          <button
            className={`${styles.tab} ${activeTab === 'week' ? styles.tabActive : ''}`}
            onClick={() => setActiveTab('week')}
            type="button"
          >
            Week
          </button>
          <button
            className={`${styles.tab} ${activeTab === 'month' ? styles.tabActive : ''}`}
            onClick={() => setActiveTab('month')}
            type="button"
          >
            Month
          </button>
        </div>
        <div className={styles.periodNav}>
          <button className={styles.periodArrow} onClick={goBack} type="button" aria-label="Previous period">
            <ChevronLeft size={16} />
          </button>
          <button
            className={`${styles.periodLabel} ${!isCurrentPeriod ? styles.periodLabelClickable : ''}`}
            onClick={!isCurrentPeriod ? goToNow : undefined}
            type="button"
            disabled={isCurrentPeriod}
          >
            {periodLabel}
          </button>
          <button className={styles.periodArrow} onClick={goForward} type="button" aria-label="Next period">
            <ChevronRight size={16} />
          </button>
        </div>
      </div>

      {/* ── Overview band (full-width) ── */}
      {activeTab === 'week' && (
        <div className={styles.overviewBand}>
          {hasNoCalendar ? (
            <FocusNoCalendar />
          ) : meetingCache.isLoading ? (
            <p className={styles.loadingText}>Loading calendar…</p>
          ) : (
            <>
              <CalendarStrip meetings={meetingCache.meetings} weekOffset={weekOffset} />
              <WeekInsightsBar
                meetings={meetingCache.meetings}
                weekOffset={weekOffset}
                onStartConversation={weekOffset >= 0 && canChat ? startWeekConversation : undefined}
                onStartPrepConversation={weekOffset >= 0 && canChat ? startPrepConversation : undefined}
              />
            </>
          )}
        </div>
      )}

      {activeTab === 'month' && (
        <div className={styles.overviewBand}>
          <MonthLensCard enabled={isFocusActive && activeTab === 'month'} monthOffset={monthOffset} />
        </div>
      )}

      {/* ── Main content: briefing + goals ── */}
      <div className={styles.mainGrid}>
        <div className={styles.narrativeColumn}>
          {activeTab === 'week' ? (
            <WeeklyPrepCard
              enabled={isFocusActive}
              isCurrentPeriod={weekOffset === 0}
              periodStart={weekBounds.start}
              periodEnd={weekBounds.end}
              onOpenConversation={onOpenConversation}
              onStartConversation={weekOffset === 0 && canChat ? startWeekConversation : undefined}
              onContinueConversation={weekOffset === 0 ? continueConversation : undefined}
            />
          ) : (
            <MonthlyReviewCard
              enabled={isFocusActive && activeTab === 'month'}
              isCurrentPeriod={monthOffset === 0}
              periodStart={monthBounds.start}
              periodEnd={monthBounds.end}
              onOpenConversation={onOpenConversation}
              onStartConversation={monthOffset === 0 && canChat ? startMonthConversation : undefined}
              onContinueConversation={monthOffset === 0 ? continueConversation : undefined}
            />
          )}
        </div>

        <div className={styles.goalsRail}>
          <GoalsSidebar
            spaceGoals={spaceGoals}
            spacesWithoutGoals={spacesWithoutGoals}
            dismissedCount={dismissedSpaces.length}
            isLoading={goalsLoading}
            onDismissSpace={dismissSpace}
            onRestoreAll={restoreAllSpaces}
            onStartConversation={isCurrentPeriod ? startConversation : undefined}
            alignmentData={alignmentData}
          />
        </div>
      </div>
    </div>
  );
}
