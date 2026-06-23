import type { BillingSource } from '@shared/utils/billingSource';
import { Badge, type BadgeProps } from './Badge';
import { Tooltip } from './Tooltip';

type BillingBadgeConfig = {
  label: string;
  tooltip: string;
  variant: NonNullable<BadgeProps['variant']>;
};

const BILLING_BADGE_CONFIG: Record<BillingSource, BillingBadgeConfig> = {
  subscription: {
    variant: 'success',
    label: 'Subscription',
    tooltip: 'Included with your subscription plan.',
  },
  pool: {
    variant: 'info',
    label: 'Credits',
    tooltip: 'Billed from your account credits.',
  },
  'pay-per-use': {
    variant: 'muted',
    label: 'Pay-per-use',
    tooltip: 'Billed per request via your API key.',
  },
  local: {
    variant: 'secondary',
    label: 'Local',
    tooltip: 'Runs on your computer. No network. No bill.',
  },
};

export interface BillingBadgeProps extends Omit<BadgeProps, 'children' | 'variant'> {
  source: BillingSource;
}

export function BillingBadge({ source, size = 'sm', ...badgeProps }: BillingBadgeProps) {
  const config = BILLING_BADGE_CONFIG[source];

  return (
    <Tooltip content={config.tooltip}>
      <Badge
        {...badgeProps}
        variant={config.variant}
        size={size}
        aria-label={config.tooltip}
        data-billing-source={source}
        data-billing-variant={config.variant}
      >
        {config.label}
      </Badge>
    </Tooltip>
  );
}
