/**
 * ProviderComparisonCard
 *
 * Compact, read-only comparison of BYOK cloud providers so non-technical
 * users don't have to open three pricing pages before picking one.
 *
 * Stage 4 of the adaptive-sizing plan. See:
 *   docs/plans/260419_cloud_setup_adaptive_sizing_and_honest_progress.md
 *
 * Rules of the road:
 *   - Pricing data lives in `cloudProviders.config.ts` and is *embedded*
 *     (no runtime fetch). `pricingAsOf` surfaces drift so stale numbers
 *     are at least visible.
 *   - Only BYOK providers (with a `pricing` field) are rendered.
 *     Managed providers (Mindstone) are skipped — their pricing is
 *     decided server-side.
 *   - Copy is calm and factual. No marketing, no emojis, no exclamation
 *     marks. "Recommended" not "Best!".
 *   - The recommended-size number comes from the sibling VolumeSizeControl
 *     (Stage 3); when sizing hasn't been measured yet (`null`) we render
 *     an em-dash rather than fabricating a number.
 */

import {
  formatPriceForProvider,
  formatServerMinForProvider,
  latestPricingAsOf,
  type CloudProviderUIConfig,
} from '../../../cloudProviders.config';

export interface ProviderComparisonCardProps {
  /**
   * BYOK providers to render. Managed providers (no `pricing` field) are
   * filtered out internally so callers can pass the whole list safely.
   */
  providers: CloudProviderUIConfig[];
  /**
   * Recommended volume size from the footprint measurement, in GB.
   * `null` when the footprint hasn't been measured yet — the table then
   * renders `"—"` for the storage column rather than inventing a number.
   */
  recommendedVolumeGb: number | null;
  /** Click handler for a provider row. Optional; rows become non-interactive when omitted. */
  onSelectProvider?: (id: string) => void;
  /** ID of the currently-selected provider, for row highlighting. */
  selectedProviderId?: string;
}

const EM_DASH = '\u2014';

// ---------------------------------------------------------------------------
// Styles — inline objects so the component is drop-in without a new CSS
// module. All values reference design tokens; no hex literals, no theme-
// specific colours. Highlight uses `color-mix` over the existing primary
// token (same approach used elsewhere in CloudTab.tsx).
// ---------------------------------------------------------------------------

const tableStyle: React.CSSProperties = {
  width: '100%',
  borderCollapse: 'separate',
  borderSpacing: 0,
  fontSize: '0.85rem',
  color: 'var(--color-text-primary)',
};

const theadCellStyle: React.CSSProperties = {
  textAlign: 'left',
  padding: 'var(--space-2) var(--space-3)',
  fontWeight: 500,
  fontSize: '0.75rem',
  letterSpacing: '0.03em',
  textTransform: 'uppercase',
  color: 'var(--color-text-secondary)',
  borderBottom: '1px solid var(--color-border-soft, var(--color-border))',
};

const tdBase: React.CSSProperties = {
  padding: 'var(--space-3)',
  borderTop: '1px solid var(--color-border-soft, var(--color-border))',
  verticalAlign: 'top',
  lineHeight: 1.4,
};

const containerStyle: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 'var(--space-2)',
  padding: 'var(--space-3)',
  border: '1px solid var(--color-border)',
  borderRadius: 'var(--radius-md, 10px)',
  background: 'var(--color-surface-1, var(--color-card, transparent))',
};

const captionStyle: React.CSSProperties = {
  padding: '0 var(--space-3) var(--space-1)',
  fontSize: '0.8rem',
  color: 'var(--color-text-secondary)',
};

const footerStyle: React.CSSProperties = {
  padding: 'var(--space-2) var(--space-3) 0',
  fontSize: '0.75rem',
  color: 'var(--color-text-secondary)',
};

function rowStyle(isSelected: boolean, clickable: boolean): React.CSSProperties {
  return {
    cursor: clickable ? 'pointer' : 'default',
    background: isSelected
      ? 'color-mix(in srgb, var(--color-primary) 10%, transparent)'
      : 'transparent',
    outline: isSelected
      ? '1px solid var(--color-primary)'
      : 'none',
    outlineOffset: '-1px',
    transition: 'background var(--motion-duration-fast, 150ms) ease',
  };
}

/**
 * Render one row per BYOK provider. Each row is clickable when
 * `onSelectProvider` is provided; keyboard activation (Enter/Space) is
 * also supported for row-level interactivity.
 */
export function ProviderComparisonCard({
  providers,
  recommendedVolumeGb,
  onSelectProvider,
  selectedProviderId,
}: ProviderComparisonCardProps) {
  // Only providers with structured pricing data participate in the
  // comparison. Managed providers (no `pricing` field) are rendered
  // elsewhere.
  const rows = providers.filter((p) => !!p.pricing);
  if (rows.length === 0) return null;

  const asOf = latestPricingAsOf(rows);
  const clickable = !!onSelectProvider;

  return (
    <div style={containerStyle} data-testid="cloud-provider-comparison-card">
      <p style={captionStyle}>
        Compare providers at a glance. Pick whichever fits your needs — you can switch later.
      </p>
      <div role="region" aria-label="Provider comparison">
        <table style={tableStyle}>
          <thead>
            <tr>
              <th scope="col" style={theadCellStyle}>Provider</th>
              <th scope="col" style={theadCellStyle}>
                Storage
                {recommendedVolumeGb != null ? ` (${recommendedVolumeGb} GB)` : ''}
              </th>
              <th scope="col" style={theadCellStyle}>Server</th>
              <th scope="col" style={theadCellStyle}>Best for</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((provider) => {
              const isSelected = selectedProviderId === provider.id;
              const storageText = formatPriceForProvider(provider, recommendedVolumeGb);
              const serverText = formatServerMinForProvider(provider);
              const blurb = provider.bestForBlurb ?? EM_DASH;

              const handleActivate = () => {
                if (onSelectProvider) onSelectProvider(provider.id);
              };
              const handleKey = (e: React.KeyboardEvent<HTMLTableRowElement>) => {
                if (!onSelectProvider) return;
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  onSelectProvider(provider.id);
                }
              };

              return (
                <tr
                  key={provider.id}
                  data-testid={`provider-comparison-row-${provider.id}`}
                  data-selected={isSelected ? 'true' : 'false'}
                  aria-selected={isSelected}
                  role={clickable ? 'button' : undefined}
                  tabIndex={clickable ? 0 : undefined}
                  onClick={clickable ? handleActivate : undefined}
                  onKeyDown={clickable ? handleKey : undefined}
                  style={rowStyle(isSelected, clickable)}
                >
                  <td style={{ ...tdBase, fontWeight: 500 }}>{provider.name}</td>
                  <td style={{ ...tdBase, fontVariantNumeric: 'tabular-nums' }}>{storageText}</td>
                  <td style={{ ...tdBase, fontVariantNumeric: 'tabular-nums', color: 'var(--color-text-secondary)' }}>
                    + {serverText}
                  </td>
                  <td style={{ ...tdBase, color: 'var(--color-text-secondary)' }}>{blurb}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {asOf && (
        <p style={footerStyle} data-testid="cloud-provider-comparison-asof">
          Prices as of {asOf}. Check provider for latest.
        </p>
      )}
    </div>
  );
}
