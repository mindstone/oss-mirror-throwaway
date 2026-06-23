import * as React from 'react';
import { FlaskConical } from 'lucide-react';
import { Tooltip } from './Tooltip';
import styles from './MaturityBadge.module.css';

export type MaturityLevel = 'labs' | 'early' | 'beta';

export interface MaturityBadgeProps {
  /** The maturity level of the feature */
  level: MaturityLevel;
  /** Feature name for tracking/context when opening feedback */
  featureName?: string;
  /** Optional class name for custom styling */
  className?: string;
  /** Optional tooltip override (uses default maturity tooltip if not provided) */
  tooltip?: string;
}

/** Community forum URL for feedback */
const COMMUNITY_URL = 'https://rebels.mindstone.com';

const MATURITY_CONFIG: Record<MaturityLevel, { label: string; tooltip: string; icon?: 'flask' }> = {
  labs: {
    label: 'Labs',
    tooltip: 'Experimental feature. May not work as expected, and could be modified or removed in future versions.',
    icon: 'flask',
  },
  early: {
    label: 'Early',
    tooltip: "We're actively shaping this feature based on your feedback. Click to share your thoughts.",
  },
  beta: {
    label: 'Beta',
    tooltip: 'Beta feature. Works well but still being refined. Click to share feedback.',
    icon: 'flask',
  },
};

/**
 * Badge indicating feature maturity level (Early or Beta).
 * Shows tooltip on hover explaining what the level means.
 * Clicking opens the community forum for feedback.
 *
 * Uses a <span> with role="button" to avoid nested <button> issues when
 * placed inside tab buttons or other interactive elements.
 *
 * @example
 * <MaturityBadge level="early" featureName="The Spark" />
 * <MaturityBadge level="beta" featureName="Inbox" />
 */
export const MaturityBadge = React.forwardRef<HTMLSpanElement, MaturityBadgeProps>(
  ({ level, featureName: _featureName, className, tooltip }, ref) => {
    const config = MATURITY_CONFIG[level];

    const handleClick = (e: React.MouseEvent) => {
      e.stopPropagation();
      // Open community forum for feedback
      void window.appApi?.openUrl(COMMUNITY_URL);
    };

    const handleKeyDown = (e: React.KeyboardEvent) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        e.stopPropagation();
        void window.appApi?.openUrl(COMMUNITY_URL);
      }
    };

    const badge = (
      <span
        ref={ref}
        role="button"
        tabIndex={0}
        className={`${styles.badge} ${styles[`badge--${level}`]} ${className ?? ''}`.trim()}
        onClick={handleClick}
        onKeyDown={handleKeyDown}
        aria-label={`${config.label} feature - click to share feedback`}
      >
        {config.icon === 'flask' && <FlaskConical size={14} aria-hidden />}
        {!config.icon && config.label}
      </span>
    );

    return (
      <Tooltip content={tooltip ?? config.tooltip} placement="bottom" delayShow={200}>
        {badge}
      </Tooltip>
    );
  }
);

MaturityBadge.displayName = 'MaturityBadge';
