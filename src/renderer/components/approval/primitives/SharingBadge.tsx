/**
 * SharingBadge — Shared sharing level badge primitive.
 *
 * Renders a compact badge indicating sharing scope (private/restricted/company-wide/public).
 * Extracted from UnifiedApprovalCard for reuse across approval surfaces.
 */

import { memo, type FC } from 'react';
import { Lock, Users, Globe, HelpCircle } from 'lucide-react';
import { cn } from '@renderer/lib/utils';
import styles from './SharingBadge.module.css';

export type SharingLevel = 'private' | 'restricted' | 'company-wide' | 'public' | 'unclear';

interface SharingConfig {
  icon: typeof Lock;
  className: string;
  label: string;
}

function getSharingConfig(sharing: SharingLevel): SharingConfig {
  switch (sharing) {
    case 'private':
      return { icon: Lock, className: styles.private, label: 'Private' };
    case 'restricted':
      return { icon: Users, className: styles.shared, label: 'Restricted' };
    case 'company-wide':
      return { icon: Users, className: styles.shared, label: 'Company-wide' };
    case 'public':
      return { icon: Globe, className: styles.public, label: 'Public' };
    case 'unclear':
      return { icon: HelpCircle, className: styles.unclear, label: 'Unclear' };
  }
}

export interface SharingBadgeProps {
  sharing: SharingLevel;
  className?: string;
  labelOverride?: string;
}

const SharingBadgeComponent: FC<SharingBadgeProps> = ({ sharing, className, labelOverride }) => {
  const config = getSharingConfig(sharing);
  const Icon = config.icon;

  return (
    <span className={cn(styles.badge, config.className, className)}>
      <Icon size={10} />
      {labelOverride ?? config.label}
    </span>
  );
};

export const SharingBadge = memo(SharingBadgeComponent);
SharingBadge.displayName = 'SharingBadge';
