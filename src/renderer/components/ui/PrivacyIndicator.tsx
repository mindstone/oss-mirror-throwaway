import { useCallback, useRef } from 'react';
import { Lock, Globe } from 'lucide-react';
import { Tooltip } from './Tooltip';
import { getFilePrivacy, type FilePrivacy } from '@renderer/utils/documentUtils';
import { cn } from '@renderer/lib/utils';
import { tracking } from '@renderer/src/tracking';
import styles from './PrivacyIndicator.module.css';

export type PrivacyIndicatorProps = {
  /** File path to determine privacy from, OR pre-computed privacy value */
  filePath?: string;
  /** Pre-computed privacy value (use instead of filePath if already computed) */
  privacy?: FilePrivacy;
  /** Icon size in pixels (default: 14) */
  size?: number;
  /** Additional CSS class name */
  className?: string;
  /** Tooltip placement (default: 'top') */
  tooltipPlacement?: 'top' | 'bottom' | 'left' | 'right';
  /** Delay before showing tooltip in ms (default: 200) */
  tooltipDelay?: number;
  /** Source identifier for tracking (e.g., 'library_editor', 'file_tree') */
  source?: string;
};

/**
 * Privacy indicator showing whether a file is private (Lock icon) or shared (Globe icon).
 * Returns null if privacy is 'unknown'.
 * 
 * Tracks a 'Privacy Indicator Viewed' event once per mount when user hovers.
 */
export const PrivacyIndicator = ({
  filePath,
  privacy: privacyProp,
  size = 14,
  className,
  tooltipPlacement = 'top',
  tooltipDelay = 200,
  source = 'unknown',
}: PrivacyIndicatorProps) => {
  const privacy = privacyProp ?? (filePath ? getFilePrivacy(filePath) : 'unknown');
  const hasTrackedRef = useRef(false);

  const handleMouseEnter = useCallback(() => {
    if (hasTrackedRef.current || privacy === 'unknown') return;
    hasTrackedRef.current = true;
    tracking.privacy.indicatorViewed(privacy as 'private' | 'shared', source);
  }, [privacy, source]);

  if (privacy === 'unknown') return null;

  const isPrivate = privacy === 'private';
  const Icon = isPrivate ? Lock : Globe;
  const tooltipText = isPrivate
    ? 'Private — only you can see this'
    : 'Shared — visible to others with folder access';

  return (
    <Tooltip content={tooltipText} placement={tooltipPlacement} delayShow={tooltipDelay}>
      <span
        className={cn(
          styles.privacyIcon,
          isPrivate ? styles.privacyIconPrivate : styles.privacyIconShared,
          className
        )}
        onMouseEnter={handleMouseEnter}
      >
        <Icon size={size} aria-hidden />
      </span>
    </Tooltip>
  );
};
