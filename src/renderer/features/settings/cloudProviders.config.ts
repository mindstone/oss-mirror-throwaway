/**
 * Cloud Provider Configuration
 *
 * Static metadata for each supported cloud provider, used by CloudTab
 * to render provider-specific UI (token input, help, cost, etc.).
 */

import type { AppSettings } from '@shared/types';
import type { CloudErrorHelpKey } from '../../../core/services/cloudErrorMapper';
import { rendererIsOss } from '../../src/rendererIsOss';

/**
 * Hardcoded EUR → USD conversion rate used for the Hetzner "approx $X"
 * display in the provider comparison card. We intentionally embed the
 * rate rather than fetching it at runtime — non-technical users just
 * need a ballpark. Drift is acknowledged by `pricingAsOf`.
 *
 * CONVERSION_RATE_AS_OF: 2026-04-19
 */
export const EUR_TO_USD_RATE = 1.08;

/**
 * Pricing data for a single BYOK provider. Embedded in the app to avoid
 * runtime fetches against pricing pages. `pricingAsOf` makes drift at
 * least visible. See `docs/plans/260419_cloud_setup_adaptive_sizing_and_honest_progress.md`
 * (Stage 4 — Provider Comparison Card + Hardcoded Pricing).
 */
export interface CloudProviderPricing {
  /** Storage cost per GB per month, in the provider's native currency. */
  storagePerGbPerMonth: number;
  /** Minimum matching server cost per month, in the provider's native currency. */
  serverMinPerMonth: number;
  /** Provider's native billing currency. */
  currency: 'USD' | 'EUR';
  /** ISO date string (YYYY-MM-DD) — when this data was last verified. */
  pricingAsOf: string;
}

export interface CloudProviderUIConfig {
  id: 'fly' | 'digitalocean' | 'hetzner' | 'mindstone';
  name: string;
  /** Whether this is a managed provider (no user token needed). Default: false */
  managed?: boolean;
  /** AppSettings key that must be truthy for this provider to be visible. */
  featureFlag?: keyof AppSettings;
  /**
   * Hardcoded hide flag for provider-selector UI surfaces. Used to temporarily
   * remove a provider from the picker without deleting its config — existing
   * users with an already-connected instance still get the correct name,
   * dashboard links, and error help via `getProviderConfig()`. To re-enable
   * a provider, simply remove `hidden: true` from its entry.
   */
  hidden?: boolean;
  /** Whether this provider supports OAuth (show "Connect" button instead of token input) */
  supportsOAuth?: boolean;
  /** Label for the OAuth connect button */
  oauthButtonLabel?: string;
  tokenLabel?: string;
  tokenPlaceholder?: string;
  tokenHelpUrl?: string;
  tokenHelpSteps?: string[];
  /**
   * Optional extra note rendered below the numbered token help steps.
   * Used for edge cases (e.g. Fly orgs that require SSO and so cannot use
   * personal access tokens).
   */
  tokenHelpNote?: string;
  costBlurb: string;
  cleanupUrl?: string;
  /** Maps error helpKeys to provider-specific URLs. */
  errorHelpLinks?: Partial<Record<NonNullable<CloudErrorHelpKey>, string>>;
  /**
   * Structured pricing for the provider comparison card. BYOK providers
   * (Fly / DO / Hetzner) populate this; the managed Mindstone provider
   * does not — its pricing is decided server-side.
   */
  pricing?: CloudProviderPricing;
  /**
   * One-sentence "best for" blurb shown in the comparison card. Dry,
   * calm — no marketing language.
   */
  bestForBlurb?: string;
}

const ALL_CLOUD_PROVIDERS: CloudProviderUIConfig[] = [
  {
    id: 'mindstone',
    name: 'Mindstone Cloud',
    managed: true,
    featureFlag: 'managedCloudEnabled',
    costBlurb: 'Managed by Mindstone. No account, no keys, no maintenance.',
  },
  {
    id: 'fly',
    name: 'Fly.io',
    tokenLabel: 'Fly.io access token',
    tokenPlaceholder: 'Paste your Fly.io token',
    tokenHelpUrl: 'https://fly.io/user/personal_access_tokens',
    tokenHelpSteps: [
      'Go to fly.io/user/personal_access_tokens',
      'Sign up or log in (free account)',
      'Click "Create token" and paste it here',
    ],
    tokenHelpNote: 'If your Fly organization requires SSO, personal access tokens won\u2019t work. Instead, run `fly tokens create org --org <your-org>` in a terminal and paste the output here.',
    costBlurb: 'Typical cost is around ~$0.15/GB/month on Fly\u2019s pay-as-you-go volume pricing. A payment method is required before creating volumes above 20 GB.',
    cleanupUrl: 'fly.io/dashboard',
    errorHelpLinks: {
      token_help: 'https://fly.io/user/personal_access_tokens',
      sso_token_help: 'https://fly.io/docs/flyctl/tokens-create-org/',
      provider_dashboard: 'https://fly.io/dashboard',
      provider_billing: 'https://fly.io/dashboard/personal/billing',
    },
    pricing: {
      storagePerGbPerMonth: 0.15,
      serverMinPerMonth: 1.94,
      currency: 'USD',
      pricingAsOf: '2026-04-19',
    },
    bestForBlurb: 'Simplest setup. Pay-as-you-go billing.',
  },
  {
    id: 'digitalocean',
    name: 'DigitalOcean',
    // TEMPORARY (2026-04-22): Hidden from the provider picker while we
    // investigate setup failures reported by users. Existing connected DO
    // instances are unaffected — this only gates the selector UI. Remove
    // `hidden: true` to re-enable once the underlying issues are fixed.
    hidden: true,
    supportsOAuth: true,
    oauthButtonLabel: 'Connect with DigitalOcean',
    tokenLabel: 'DigitalOcean API token',
    tokenPlaceholder: 'Paste your DigitalOcean token',
    tokenHelpUrl: 'https://cloud.digitalocean.com/account/api/tokens',
    tokenHelpSteps: [
      'Go to cloud.digitalocean.com/account/api/tokens',
      'Sign up or log in',
      'Click "Generate New Token" (read + write scope) and paste it here',
    ],
    costBlurb: 'Block storage costs ~$0.10/GB/month, on top of your droplet cost (from $6/mo).',
    cleanupUrl: 'cloud.digitalocean.com',
    errorHelpLinks: {
      token_help: 'https://cloud.digitalocean.com/account/api/tokens',
      provider_dashboard: 'https://cloud.digitalocean.com',
      provider_billing: 'https://cloud.digitalocean.com/account/billing',
      dns_setup: 'https://cloud.digitalocean.com/networking/domains',
    },
    pricing: {
      storagePerGbPerMonth: 0.10,
      serverMinPerMonth: 6,
      currency: 'USD',
      pricingAsOf: '2026-04-19',
    },
    bestForBlurb: 'Predictable monthly billing. Larger server options.',
  },
  {
    id: 'hetzner',
    name: 'Hetzner Cloud',
    // TEMPORARY (2026-04-22): Hidden from the provider picker while we
    // investigate setup failures reported by users. Existing connected
    // Hetzner instances are unaffected — this only gates the selector UI.
    // Remove `hidden: true` to re-enable once the underlying issues are fixed.
    hidden: true,
    tokenLabel: 'Hetzner Cloud API token',
    tokenPlaceholder: 'Paste your Hetzner token',
    tokenHelpUrl: 'https://console.hetzner.cloud/projects',
    tokenHelpSteps: [
      'Go to console.hetzner.cloud \u2192 your project \u2192 Security \u2192 API Tokens',
      'Sign up or log in',
      'Click "Generate API Token" (read/write) and paste it here',
    ],
    costBlurb: 'Volume storage costs \u20AC0.044/GB/month (EU billing), on top of your server cost (from \u20AC4.51/mo).',
    cleanupUrl: 'console.hetzner.cloud',
    errorHelpLinks: {
      token_help: 'https://console.hetzner.cloud/projects',
      provider_dashboard: 'https://console.hetzner.cloud',
      provider_billing: 'https://console.hetzner.cloud/projects',
      dns_setup: 'https://console.hetzner.cloud',
    },
    pricing: {
      storagePerGbPerMonth: 0.044,
      serverMinPerMonth: 4.51,
      currency: 'EUR',
      pricingAsOf: '2026-04-19',
    },
    bestForBlurb: 'Lowest cost. EU-based, billed in euros.',
  },
];

export const CLOUD_PROVIDERS: CloudProviderUIConfig[] = rendererIsOss()
  ? ALL_CLOUD_PROVIDERS.filter((provider) => provider.id !== 'mindstone')
  : ALL_CLOUD_PROVIDERS;

export function getVisibleCloudProviders(options: { isOss?: boolean } = {}): CloudProviderUIConfig[] {
  const isOss = options.isOss ?? rendererIsOss();
  return isOss ? ALL_CLOUD_PROVIDERS.filter((provider) => provider.id !== 'mindstone') : ALL_CLOUD_PROVIDERS;
}

/** Default BYOK provider (Fly) — used as fallback when no provider matches. */
const FLY_PROVIDER = ALL_CLOUD_PROVIDERS.find((p) => p.id === 'fly') ?? ALL_CLOUD_PROVIDERS[0];
if (!FLY_PROVIDER) {
  throw new Error('No cloud providers configured');
}

export function getProviderConfig(providerId?: string): CloudProviderUIConfig {
  return ALL_CLOUD_PROVIDERS.find((p) => p.id === providerId) ?? FLY_PROVIDER;
}

export function resolveHelpUrl(
  providerId: string | undefined,
  helpKey: NonNullable<CloudErrorHelpKey> | undefined,
  providerContext?: { orgSlug?: string },
): string | undefined {
  if (!helpKey) return undefined;
  const config = getProviderConfig(providerId);
  const baseUrl = config.errorHelpLinks?.[helpKey];
  if (!baseUrl) return undefined;

  // For Fly billing, swap in the resolved org slug so we deep-link to the
  // right page instead of `/personal/billing`, which is wrong for SSO orgs.
  if (helpKey === 'provider_billing' && providerId === 'fly' && providerContext?.orgSlug) {
    return `https://fly.io/dashboard/${encodeURIComponent(providerContext.orgSlug)}/billing`;
  }

  return baseUrl;
}

// ---------------------------------------------------------------------------
// Pricing helpers (Stage 4 — Provider Comparison Card)
// ---------------------------------------------------------------------------
//
// Non-technical users should not have to open three pricing pages to pick a
// provider. These helpers produce the numbers and strings rendered in the
// comparison card. All values are in the provider's native currency;
// Hetzner's EUR output is augmented with an approximate USD equivalent for
// the comparison to be usable by US users. See plan:
//   docs/plans/260419_cloud_setup_adaptive_sizing_and_honest_progress.md
//   (Stage 4)
// ---------------------------------------------------------------------------

/**
 * Compute monthly storage + minimum-server cost for a BYOK provider at the
 * given volume size.
 *
 * Returns `null` when the provider has no structured pricing data (e.g. the
 * managed Mindstone provider). Callers can render `—` in that case.
 */
export function estimateMonthlyCost(
  provider: CloudProviderUIConfig,
  volumeGb: number,
): { storage: number; server: number; currency: 'USD' | 'EUR' } | null {
  if (!provider.pricing) return null;
  if (!Number.isFinite(volumeGb) || volumeGb <= 0) return null;
  const { storagePerGbPerMonth, serverMinPerMonth, currency } = provider.pricing;
  return {
    storage: storagePerGbPerMonth * volumeGb,
    server: serverMinPerMonth,
    currency,
  };
}

/**
 * Format a numeric amount with its currency symbol, rounded to a sensible
 * number of decimals for small monthly-cost figures. Used by the comparison
 * card.
 *
 * Whole numbers render without decimals (so "$6" not "$6.00"). Fractional
 * amounts round to 2 decimals (so "$2.25", "$1.94", "€0.66").
 */
function formatCurrency(amount: number, currency: 'USD' | 'EUR'): string {
  const symbol = currency === 'USD' ? '$' : '\u20AC';
  const rounded = Math.round(amount * 100) / 100;
  const hasFraction = Math.abs(rounded - Math.round(rounded)) > 1e-9;
  const formatted = hasFraction ? rounded.toFixed(2) : `${Math.round(rounded)}`;
  return `${symbol}${formatted}`;
}

/**
 * Format the per-volume storage line shown in the comparison card, e.g.
 *   "~$2.25/mo for 15 GB"  (Fly / DO)
 *   "~€0.66/mo for 15 GB (approx $0.71)"  (Hetzner)
 *
 * When the provider has no pricing data OR `volumeGb` is not usable, returns
 * `"—"` — honesty over fabrication.
 */
export function formatPriceForProvider(
  provider: CloudProviderUIConfig,
  volumeGb: number | null,
): string {
  if (volumeGb == null || !Number.isFinite(volumeGb) || volumeGb <= 0) return '\u2014';
  const estimate = estimateMonthlyCost(provider, volumeGb);
  if (!estimate) return '\u2014';
  const native = `~${formatCurrency(estimate.storage, estimate.currency)}/mo for ${volumeGb} GB`;
  if (estimate.currency === 'EUR') {
    const approxUsd = formatCurrency(estimate.storage * EUR_TO_USD_RATE, 'USD');
    return `${native} (approx ${approxUsd})`;
  }
  return native;
}

/**
 * Format the minimum-server line shown in the comparison card, e.g.
 *   "from $1.94/mo"
 *   "from \u20AC4.51/mo (approx $4.87)"
 *
 * Returns `"—"` when the provider has no pricing data.
 */
export function formatServerMinForProvider(provider: CloudProviderUIConfig): string {
  if (!provider.pricing) return '\u2014';
  const { serverMinPerMonth, currency } = provider.pricing;
  const native = `from ${formatCurrency(serverMinPerMonth, currency)}/mo`;
  if (currency === 'EUR') {
    const approxUsd = formatCurrency(serverMinPerMonth * EUR_TO_USD_RATE, 'USD');
    return `${native} (approx ${approxUsd})`;
  }
  return native;
}

/**
 * Most-recent `pricingAsOf` across the supplied providers. Used by the
 * comparison-card footer ("Prices as of …"). Returns `null` when no
 * provider has pricing data.
 */
export function latestPricingAsOf(providers: CloudProviderUIConfig[]): string | null {
  const dates = providers
    .map((p) => p.pricing?.pricingAsOf)
    .filter((d): d is string => typeof d === 'string' && d.length > 0);
  const [first, ...rest] = dates;
  if (first === undefined) return null;
  // ISO YYYY-MM-DD strings sort lexicographically.
  return rest.reduce((max, cur) => (cur > max ? cur : max), first);
}
