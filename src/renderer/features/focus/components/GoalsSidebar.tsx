/**
 * GoalsSidebar — Space-grouped goals panel for Focus surface
 *
 * Read-only display of goals extracted from space README frontmatter,
 * grouped by space. Personal goals appear first with accent treatment.
 * Each space group has a "Review goals" chip that starts a conversation.
 *
 * No inline CRUD — goal editing happens through conversations with Rebel.
 *
 * @see docs/plans/260407_focus_goals_redesign.md — Stage 3
 */

import { useCallback, useMemo } from 'react';
import { useState } from 'react';
import { ChevronDown, ChevronRight, Info, Target, X } from 'lucide-react';
import type { SpaceGoals } from '../../../../core/services/spaceGoalsTypes';
import type { GoalAlignmentResult, GoalAlignmentEntry } from '../../../../core/services/goalAlignmentService';
import styles from './GoalsSidebar.module.css';

// ─────────────────────────────────────────────────────────────
// Props
// ─────────────────────────────────────────────────────────────

export interface GoalsSidebarProps {
  spaceGoals: SpaceGoals[];
  spacesWithoutGoals: Array<{ spaceName: string; spacePath: string }>;
  dismissedCount: number;
  isLoading: boolean;
  onDismissSpace: (spacePath: string) => void;
  onRestoreAll: () => void;
  onStartConversation?: (prompt: string) => void;
  alignmentData?: GoalAlignmentResult | null;
}

/** Build a lookup map from spaceName+goalText → alignment entry for fast access. */
function buildAlignmentMap(data: GoalAlignmentResult | null | undefined): Map<string, GoalAlignmentEntry> {
  const map = new Map<string, GoalAlignmentEntry>();
  if (!data) return map;
  for (const entry of data.goals) {
    map.set(`${entry.spaceName}::${entry.goalText}`, entry);
  }
  return map;
}

function formatApproxHours(hours: number): string {
  if (hours === 0) return '0h';
  const rounded = Math.round(hours);
  if (rounded === 0) return '<1h';
  return `~${rounded}h`;
}

// ─────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────

function formatReviewedAgo(isoDate: string | null): string | null {
  if (!isoDate) return null;
  const then = new Date(isoDate).getTime();
  if (isNaN(then)) return null;
  const days = Math.floor((Date.now() - then) / (1000 * 60 * 60 * 24));
  if (days < 0) return null;
  if (days === 0) return 'Reviewed today';
  if (days === 1) return 'Reviewed yesterday';
  if (days < 7) return `Reviewed ${days} days ago`;
  if (days < 14) return 'Reviewed last week';
  const weeks = Math.floor(days / 7);
  if (weeks < 8) return `Reviewed ${weeks} weeks ago`;
  const months = Math.floor(days / 30);
  return `Reviewed ${months} ${months === 1 ? 'month' : 'months'} ago`;
}

// ─────────────────────────────────────────────────────────────
// SpaceGoalGroup — goals for a single space
// ─────────────────────────────────────────────────────────────

interface SpaceGoalGroupProps {
  space: SpaceGoals;
  onDismiss?: () => void;
  alignmentMap?: Map<string, GoalAlignmentEntry>;
  totalMeetingHours?: number;
}

function SpaceGoalGroup({ space, onDismiss, alignmentMap, totalMeetingHours }: SpaceGoalGroupProps) {
  const reviewedLabel = formatReviewedAgo(space.lastReviewed);

  return (
    <div
      className={`${styles.spaceGroup} ${space.isPersonal ? styles.personalGroup : ''}`}
      data-testid={`space-goals-${space.spacePath}`}
    >
      <div className={styles.spaceHeader}>
        <div className={styles.spaceHeaderLeft}>
          <span className={styles.spaceName}>
            {space.isPersonal ? 'Personal Goals' : space.spaceName}
          </span>
          {reviewedLabel && (
            <span className={styles.reviewedLabel}>{reviewedLabel}</span>
          )}
        </div>
        {!space.isPersonal && onDismiss && (
          <button
            className={styles.dismissButton}
            onClick={(e) => { e.stopPropagation(); onDismiss(); }}
            aria-label={`Hide ${space.spaceName} goals`}
            type="button"
          >
            <X size={12} />
          </button>
        )}
      </div>

      <ul className={styles.goalList}>
        {space.goals.map((g, idx) => {
          const alignment = alignmentMap?.get(`${space.spaceName}::${g.goal}`);
          const hasAlignment = alignment && alignment.status === 'matched';
          const fillPercent = hasAlignment && totalMeetingHours && totalMeetingHours > 0
            ? Math.min(100, (alignment.alignedHours / totalMeetingHours) * 100)
            : 0;

          return (
            <li key={idx} className={styles.goalItem}>
              <div className={styles.goalTextRow}>
                <p className={styles.goalText}>{g.goal}</p>
                {alignment && alignment.status !== 'no_usable_keywords' && (
                  <span className={`${styles.alignmentHours} ${hasAlignment ? styles.alignmentHoursActive : ''}`}>
                    {formatApproxHours(alignment.alignedHours)}
                  </span>
                )}
              </div>
              {alignment && alignment.status !== 'no_usable_keywords' && totalMeetingHours && totalMeetingHours > 0 && (
                <div className={styles.alignmentBar} title={hasAlignment ? alignment.alignedMeetingTitles.join(', ') : undefined}>
                  <div
                    className={styles.alignmentBarFill}
                    style={{ width: `${fillPercent}%` }}
                  />
                </div>
              )}
              {g.why && (
                <p className={styles.goalWhy}>{g.why}</p>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────
// GoalsInput — Single consolidated input for goal conversations
// ─────────────────────────────────────────────────────────────

function GoalsInput({ onStartConversation }: { onStartConversation: (prompt: string) => void }) {
  const [inputValue, setInputValue] = useState('');

  const handleSubmit = useCallback((e: React.FormEvent) => {
    e.preventDefault();
    const text = inputValue.trim();
    onStartConversation(text || 'Help me review and update my goals');
    setInputValue('');
  }, [inputValue, onStartConversation]);

  return (
    <form className={styles.goalInputForm} onSubmit={handleSubmit}>
      <input
        className={styles.goalInput}
        type="text"
        placeholder="Review, update, or set goals..."
        value={inputValue}
        onChange={(e) => setInputValue(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSubmit(e); } }}
      />
      <button className={styles.goalInputSend} type="submit" aria-label="Send">
        &rarr;
      </button>
    </form>
  );
}

// ─────────────────────────────────────────────────────────────
// EmptySpacesHint — Expandable hint for spaces without goals
// ─────────────────────────────────────────────────────────────

function EmptySpacesHint({ spaces }: { spaces: Array<{ spaceName: string }> }) {
  const [expanded, setExpanded] = useState(false);
  const names = spaces.map(s => s.spaceName).join(', ');

  return (
    <div className={styles.emptyHint}>
      <button
        className={styles.emptyHintToggle}
        onClick={() => setExpanded(prev => !prev)}
        type="button"
      >
        <Info size={12} className={styles.emptyHintIcon} />
        <span>{spaces.length} {spaces.length === 1 ? 'space has' : 'spaces have'} no goals yet</span>
        <ChevronRight
          size={10}
          className={`${styles.emptyHintChevron} ${expanded ? styles.emptyHintChevronExpanded : ''}`}
        />
      </button>
      {expanded && (
        <div className={styles.emptyHintBody}>
          <p className={styles.emptyHintNames}>{names}</p>
          <p className={styles.emptyHintNote}>
            Tell me below if you'd like to set goals for any of these, or let me know they don't need them.
          </p>
        </div>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────
// GoalsSidebar Component
// ─────────────────────────────────────────────────────────────

export function GoalsSidebar({
  spaceGoals,
  spacesWithoutGoals,
  dismissedCount,
  isLoading,
  onDismissSpace,
  onRestoreAll,
  onStartConversation,
  alignmentData,
}: GoalsSidebarProps) {
  const [collapsed, setCollapsed] = useState(false);

  const totalGoals = spaceGoals.reduce((sum, s) => sum + s.goals.length, 0);
  const alignmentMap = useMemo(() => buildAlignmentMap(alignmentData), [alignmentData]);
  const totalMeetingHours = alignmentData?.totalMeetingHours ?? 0;
  const preppedMeetingCount = alignmentData?.preppedMeetingCount ?? 0;
  const totalMeetingCount = alignmentData?.totalMeetingCount ?? 0;

  const handleToggle = useCallback(() => {
    setCollapsed(prev => !prev);
  }, []);

  // Find personal space (always shown first if present)
  const personalSpace = spaceGoals.find(s => s.isPersonal);
  const otherSpaces = spaceGoals.filter(s => !s.isPersonal);

  return (
    <div className={styles.sidebar} data-testid="goals-sidebar">
      {/* Header with collapse toggle */}
      <div
        className={styles.header}
        onClick={handleToggle}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); handleToggle(); } }}
        aria-expanded={!collapsed}
        aria-label={collapsed ? 'Expand goals' : 'Collapse goals'}
      >
        <div className={styles.headerLeft}>
          <Target size={14} className={styles.titleIcon} />
          <p className={styles.title}>Goals</p>
          {totalGoals > 0 && (
            <span className={styles.goalCountBadge}>{totalGoals}</span>
          )}
        </div>
        <ChevronDown
          size={14}
          className={`${styles.chevron} ${!collapsed ? styles.chevronExpanded : ''}`}
        />
      </div>

      {/* Collapsible body */}
      {!collapsed && (
        <div className={styles.body}>
          {isLoading ? (
            <p className={styles.loadingText}>Loading goals…</p>
          ) : (
            <>
              {/* Personal goals group */}
              {personalSpace ? (
                <SpaceGoalGroup space={personalSpace} alignmentMap={alignmentMap} totalMeetingHours={totalMeetingHours} />
              ) : (
                <div className={`${styles.spaceGroup} ${styles.personalGroup}`}>
                  <div className={styles.spaceHeader}>
                    <span className={styles.spaceName}>Personal Goals</span>
                  </div>
                  <p className={styles.emptyBody}>
                    When I know your goals, I can tell you whether your calendar reflects them.
                  </p>
                </div>
              )}

              {otherSpaces.map(space => (
                <SpaceGoalGroup
                  key={space.spacePath}
                  space={space}
                  onDismiss={() => onDismissSpace(space.spacePath)}
                  alignmentMap={alignmentMap}
                  totalMeetingHours={totalMeetingHours}
                />
              ))}

              {spacesWithoutGoals.length > 0 && (
                <EmptySpacesHint spaces={spacesWithoutGoals} />
              )}

              {preppedMeetingCount > 0 && (
                <p className={styles.coverageIndicator}>
                  {preppedMeetingCount} of {totalMeetingCount} {totalMeetingCount === 1 ? 'meeting' : 'meetings'} prepped
                </p>
              )}

              {/* Single conversation input — hidden for non-current periods */}
              {onStartConversation && (
                <GoalsInput onStartConversation={onStartConversation} />
              )}

              {/* Dismissed spaces footer */}
              {dismissedCount > 0 && (
                <button
                  className={styles.dismissedFooter}
                  onClick={onRestoreAll}
                  type="button"
                >
                  {dismissedCount} {dismissedCount === 1 ? 'space' : 'spaces'} hidden · Show all
                </button>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}
