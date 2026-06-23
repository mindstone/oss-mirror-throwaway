import { useMemo, useState, useEffect, useCallback } from 'react';
import { Clock } from 'lucide-react';
import { Tooltip } from '@renderer/components/ui/Tooltip';
import type { TimeSavedStatus, ImpactLevel } from '@shared/types';
import { Zap } from 'lucide-react';
import './TimeSavedSummary.css';

type TimeSavedSummaryProps = {
  status: TimeSavedStatus;
};

const MIN_DISPLAY_THRESHOLD_MINUTES = 5;
const FIRST_TIME_TOOLTIP_DURATION_MS = 6000;

const FIRST_TIME_MESSAGE = "I'm tracking estimated time saved based on typical manual effort for similar tasks.";

const formatMinutes = (minutes: number): string => {
  if (minutes < 60) {
    return `${Math.round(minutes)} min`;
  }
  const hours = minutes / 60;
  if (hours < 10) {
    return `${hours.toFixed(1)}h`;
  }
  return `${Math.round(hours)}h`;
};

const formatDuration = (seconds: number): string => {
  if (seconds < 60) {
    return `${seconds}s`;
  }
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  if (remainingSeconds === 0) {
    return `${minutes}m`;
  }
  return `${minutes}m ${remainingSeconds}s`;
};

const isHighImpact = (impact: ImpactLevel | undefined): boolean => {
  return impact === 'critical' || impact === 'high';
};

const getImpactLabel = (impact: ImpactLevel | undefined): string => {
  switch (impact) {
    case 'critical': return 'Critical';
    case 'high': return 'High';
    case 'medium': return 'Medium';
    case 'low': return 'Low';
    case 'trivial': return 'Trivial';
    default: return '';
  }
};

const HIGH_IMPACT_QUIPS = [
  'The kind that moves the needle.',
  'This one counted.',
  'Worth the electrons.',
];

const getHighImpactQuip = (): string => {
  return HIGH_IMPACT_QUIPS[Math.floor(Math.random() * HIGH_IMPACT_QUIPS.length)];
};

export const TimeSavedSummary = ({ status }: TimeSavedSummaryProps) => {
  const { estimate } = status;
  const [isFirstTime, setIsFirstTime] = useState<boolean | null>(null);
  const [showFirstTimeTooltip, setShowFirstTimeTooltip] = useState(false);

  const shouldDisplay = useMemo(() => {
    if (status.status !== 'success' || !estimate) return false;
    return estimate.lowMinutes >= MIN_DISPLAY_THRESHOLD_MINUTES;
  }, [status.status, estimate]);

  // Check if this is the user's first time seeing a time-saved estimate
  useEffect(() => {
    if (!shouldDisplay) return;
    
    window.api.hasSeenFirstTimeSaved().then((hasSeen) => {
      if (!hasSeen) {
        setIsFirstTime(true);
        setShowFirstTimeTooltip(true);
        
        // Mark as seen and hide tooltip after delay
        const timer = setTimeout(() => {
          window.api.markFirstTimeSavedSeen();
          setShowFirstTimeTooltip(false);
          setIsFirstTime(false);
        }, FIRST_TIME_TOOLTIP_DURATION_MS);
        
        return () => clearTimeout(timer);
      } else {
        setIsFirstTime(false);
      }
    }).catch(() => {
      setIsFirstTime(false);
    });
  }, [shouldDisplay]);

  const handleClick = useCallback(() => {
    if (showFirstTimeTooltip) {
      window.api.markFirstTimeSavedSeen();
      setShowFirstTimeTooltip(false);
      setIsFirstTime(false);
    }
  }, [showFirstTimeTooltip]);

  // Display raw midpoint (unweighted) for per-turn summary.
  // Aggregates (weekly totals) use weighted values. This is intentional:
  // per-turn shows "what would this have taken manually" while aggregates
  // show "total value delivered" (impact-adjusted).
  const displayValue = useMemo(() => {
    if (!estimate) return '';
    const midpoint = (estimate.lowMinutes + estimate.highMinutes) / 2;
    return formatMinutes(midpoint);
  }, [estimate]);

  const standardTooltipContent = useMemo(() => {
    if (!estimate) return '';
    const range = `${formatMinutes(estimate.lowMinutes)} – ${formatMinutes(estimate.highMinutes)}`;
    const parts = [`Estimated manual effort: ${range}`];
    
    // High impact gets a quip instead of a label
    if (isHighImpact(estimate.impact)) {
      parts.push(getHighImpactQuip());
    } else if (estimate.impact && estimate.impact !== 'unknown' && estimate.impact !== 'medium') {
      parts.push(`Impact: ${getImpactLabel(estimate.impact)}`);
    }
    
    if (status.actualDurationSeconds) {
      parts.push(`Rebel took: ${formatDuration(status.actualDurationSeconds)}`);
    }
    if (estimate.reasoning) {
      parts.push(estimate.reasoning);
    }
    return parts.join('\n');
  }, [estimate, status.actualDurationSeconds]);

  if (!shouldDisplay || !estimate) {
    return null;
  }

  const tooltipContent = showFirstTimeTooltip ? FIRST_TIME_MESSAGE : standardTooltipContent;

  const showHighImpactBadge = isHighImpact(estimate.impact);
  const isLowImpact = estimate.impact === 'low' || estimate.impact === 'trivial';

  return (
    <Tooltip 
      content={tooltipContent} 
      placement="top" 
      delayShow={showFirstTimeTooltip ? 0 : 300}
    >
      <span 
        className={`time-saved-summary ${isFirstTime ? 'time-saved-summary--first-time' : ''} ${isLowImpact ? 'time-saved-summary--muted' : ''}`}
        onClick={handleClick}
        role={showFirstTimeTooltip ? 'button' : undefined}
        tabIndex={showFirstTimeTooltip ? 0 : undefined}
        aria-label={showHighImpactBadge ? `${displayValue} saved (high impact)` : `${displayValue} saved`}
      >
        <Clock className="time-saved-summary__icon" aria-hidden />
        <span className="time-saved-summary__value">{displayValue}</span>
        {showHighImpactBadge && (
          <Zap className="time-saved-summary__impact-badge" aria-label="High impact" />
        )}
      </span>
    </Tooltip>
  );
};
