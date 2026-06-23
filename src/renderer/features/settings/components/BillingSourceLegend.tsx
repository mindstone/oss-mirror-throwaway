import { BillingBadge } from '@renderer/components/ui';

export function BillingSourceLegend() {
  return (
    <div
      role="group"
      aria-label="Billing source legend"
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: '8px',
        flexWrap: 'wrap',
        marginBottom: '12px',
      }}
    >
      <span style={{ fontSize: '12px', color: 'var(--color-text-muted)' }}>
        Billing:
      </span>
      <BillingBadge source="subscription" />
      <BillingBadge source="pool" />
      <BillingBadge source="pay-per-use" />
      <BillingBadge source="local" />
    </div>
  );
}
