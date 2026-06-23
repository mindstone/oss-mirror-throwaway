/**
 * RiskBadge — Shared risk level badge primitive.
 *
 * Renders a compact icon badge with tooltip indicating risk level.
 * Extracted from UnifiedApprovalCard for reuse across approval surfaces.
 */

import { memo, type FC } from 'react';
import { ShieldCheck, AlertCircle, AlertTriangle, ShieldQuestion } from 'lucide-react';
import { cn } from '@renderer/lib/utils';
import { Tooltip } from '@renderer/components/ui';
import styles from './RiskBadge.module.css';

export type RiskLevel = 'low' | 'medium' | 'high' | 'needs-review' | 'unknown';

interface RiskBadgeConfig {
  icon: typeof ShieldCheck;
  className: string;
  label: string;
}

function getRiskBadgeConfig(riskLevel: RiskLevel): RiskBadgeConfig {
  switch (riskLevel) {
    case 'low':
      return { icon: ShieldCheck, className: styles.low, label: 'Low risk' };
    case 'medium':
      return { icon: AlertCircle, className: styles.medium, label: 'Medium risk' };
    case 'high':
      return { icon: AlertTriangle, className: styles.high, label: 'High risk' };
    case 'needs-review':
      return { icon: AlertCircle, className: styles.medium, label: 'Needs review' };
    case 'unknown':
      return {
        icon: ShieldQuestion,
        className: styles.unknown,
        label: 'Unknown risk — unrated by safety evaluation',
      };
  }
}

export interface RiskBadgeProps {
  riskLevel: RiskLevel;
  className?: string;
}

const RiskBadgeComponent: FC<RiskBadgeProps> = ({ riskLevel, className }) => {
  const config = getRiskBadgeConfig(riskLevel);
  const Icon = config.icon;

  return (
    <Tooltip content={config.label} placement="top" delayShow={300}>
      <div className={cn(styles.badge, config.className, className)} aria-label={config.label}>
        <Icon size={12} />
      </div>
    </Tooltip>
  );
};

export const RiskBadge = memo(RiskBadgeComponent);
RiskBadge.displayName = 'RiskBadge';
