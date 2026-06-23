import { formatHumanizedResetDate } from '@rebel/shared';
import { Button } from '@renderer/components/ui';

type ManagedSubscriptionBillingMeta = {
  tier: string;
  resetsAt?: string;
};

type ManagedBillingErrorActionsProps = {
  managedSubscription: ManagedSubscriptionBillingMeta;
  onAddOwnKey: () => void;
  onDismiss: () => void;
};

export function getManagedBillingSecondaryLabel(resetsAt?: string): string {
  const formattedResetDate = formatHumanizedResetDate(resetsAt);
  return formattedResetDate ? `Wait until ${formattedResetDate}` : 'Dismiss';
}

export function ManagedBillingErrorActions({
  managedSubscription,
  onAddOwnKey,
  onDismiss,
}: ManagedBillingErrorActionsProps) {
  return (
    <>
      <Button
        variant="ghost"
        size="sm"
        className="error-banner-cta"
        onClick={onAddOwnKey}
        data-testid="error-banner-add-own-key"
      >
        Add your own key
      </Button>
      <Button
        variant="ghost"
        size="sm"
        className="error-banner-cta"
        onClick={onDismiss}
        data-testid="error-banner-wait-or-dismiss"
      >
        {getManagedBillingSecondaryLabel(managedSubscription.resetsAt)}
      </Button>
    </>
  );
}
