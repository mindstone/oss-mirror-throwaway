/**
 * Progress Indicator
 * 
 * Single button combining streak and time saved into one compact display.
 * Opens the AchievementHub modal (Your Progress).
 * 
 * Streak tiers:
 * - Tier 0 (0 days): Dimmed muted flame, no number
 * - Tier 1-3: Matches toolbar icon color (muted foreground)
 * - Personal best: Subtle violet accent
 */

import { Flame } from 'lucide-react';
import { Tooltip } from '@renderer/components/ui/Tooltip';
import { useStreakData, useTimeSavedData, formatTimeSavedCompact } from '@renderer/hooks/useProgressData';
import './ProgressIndicator.css';

type ProgressIndicatorProps = {
  onClick: () => void;
};

const getStreakTier = (streak: number): 0 | 1 | 2 | 3 => {
  if (streak === 0) return 0;
  if (streak < 7) return 1;
  if (streak < 14) return 2;
  return 3;
};

export const ProgressIndicator = ({ onClick }: ProgressIndicatorProps) => {
  const streakData = useStreakData();
  const timeSavedData = useTimeSavedData();
  
  const streak = streakData?.current ?? 0;
  const longest = streakData?.longest ?? 0;
  const isPersonalBest = streak > 0 && streak >= longest;
  const tier = getStreakTier(streak);
  
  const hasTimeSaved = !!timeSavedData;
  const timeDisplay = timeSavedData 
    ? formatTimeSavedCompact(timeSavedData.totalMinutes)
    : null;
  const streakBadge = streak > 99 ? '99+' : String(streak);

  const tooltipParts: string[] = [];
  if (streak > 0) {
    const bestSuffix = isPersonalBest ? ' (personal best!)' : '';
    tooltipParts.push(`${streak} day streak${bestSuffix}`);
  } else {
    tooltipParts.push('Start your streak today');
  }
  if (hasTimeSaved && timeDisplay) {
    tooltipParts.push(`${timeDisplay} saved this week`);
  }
  const tooltipContent = tooltipParts.join(' · ');

  const containerClasses = [
    'progress-indicator',
    isPersonalBest ? 'progress-indicator--personal-best' : '',
  ].filter(Boolean).join(' ');

  const iconClasses = [
    'progress-indicator__icon',
    `progress-indicator__icon--tier-${tier}`,
  ].join(' ');

  return (
    <Tooltip content={tooltipContent} placement="bottom" delayShow={300}>
      <button
        type="button"
        className={containerClasses}
        onClick={onClick}
        aria-label={tooltipContent}
      >
        <span className="progress-indicator__icon-stack" aria-hidden="true">
          <Flame className={iconClasses} />
          {streak > 0 && (
            <span className="progress-indicator__streak-mark">{streakBadge}</span>
          )}
        </span>
      </button>
    </Tooltip>
  );
};
