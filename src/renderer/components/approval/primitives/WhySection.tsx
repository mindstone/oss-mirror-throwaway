/**
 * WhySection — Shared "why" explanation primitive.
 *
 * Renders an info callout explaining why approval is needed,
 * with an optional "Change in Settings" link.
 * Extracted from UnifiedApprovalCard's WHY section.
 */

import { memo, useCallback, type FC } from 'react';
import { Info } from 'lucide-react';
import { cn } from '@renderer/lib/utils';
import styles from './WhySection.module.css';

export interface WhySectionProps {
  /** Explanation text */
  reason: string;
  /** Show "Change in Settings" link */
  settingsLink?: boolean;
  /** Called when user clicks "Change in Settings" */
  onOpenSettings?: () => void;
  className?: string;
}

const WhySectionComponent: FC<WhySectionProps> = ({
  reason,
  settingsLink = false,
  onOpenSettings,
  className,
}) => {
  const handleSettingsClick = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      onOpenSettings?.();
    },
    [onOpenSettings],
  );

  return (
    <div className={cn(styles.section, className)}>
      <Info size={14} className={styles.icon} />
      <span className={styles.text}>
        {reason}
        {settingsLink && onOpenSettings && (
          <button
            type="button"
            className={styles.settingsLink}
            onClick={handleSettingsClick}
          >
            Change in Settings
          </button>
        )}
      </span>
    </div>
  );
};

export const WhySection = memo(WhySectionComponent);
WhySection.displayName = 'WhySection';
