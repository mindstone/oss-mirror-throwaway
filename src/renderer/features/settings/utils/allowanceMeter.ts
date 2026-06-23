/**
 * Stage H1 — pure helpers for the managed-subscription allowance meter.
 *
 * Visual thresholds per docs/plans/260513a_subscription_consumer_audit_gaps.md:
 *   - neutral 0-75%
 *   - warning 75-90%
 *   - critical >90%
 *
 * Decisions Record #8: thresholds apply identically to Dash and Rogue. Do NOT
 * branch on `tier` — both share the same dollar allowance, the distinction is
 * model quality.
 */
export type AllowanceMeterState = 'neutral' | 'warning' | 'critical' | 'unavailable';

export function meterStateForRatio(ratio: number): Exclude<AllowanceMeterState, 'unavailable'> {
  if (!Number.isFinite(ratio)) return 'neutral';
  if (ratio > 0.9) return 'critical';
  if (ratio >= 0.75) return 'warning';
  return 'neutral';
}

/**
 * Format a USD-cents amount using the user's locale. Falls back to a plain
 * `$X.XX` format when the runtime rejects the currency code so the meter still
 * renders rather than throwing.
 */
export function formatUsdAmount(cents: number, currency: string): string {
  const amount = cents / 100;
  try {
    return new Intl.NumberFormat(undefined, {
      style: 'currency',
      currency,
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }).format(amount);
  } catch {
    return `$${amount.toFixed(2)}`;
  }
}

/**
 * Returns true only when both allowance credit fields are numeric and usable.
 * `undefined` means the server hasn't populated allowance data yet, so callers
 * should render the unavailable state instead of a potentially misleading 0%.
 */
export function isAllowanceAvailable(params: {
  creditLimitMonthly: number | undefined;
  creditUsedMonthly: number | undefined;
}): params is {
  creditLimitMonthly: number;
  creditUsedMonthly: number;
} {
  const { creditLimitMonthly, creditUsedMonthly } = params;
  if (typeof creditLimitMonthly !== 'number' || creditLimitMonthly <= 0) return false;
  if (typeof creditUsedMonthly !== 'number' || creditUsedMonthly < 0) return false;
  return true;
}

/**
 * Stage H6 — ordinal-day formatter for billing-renewal copy.
 *
 * Returns the day-of-month as an English ordinal (e.g. "1st", "14th", "22nd")
 * so renewal date copy reads naturally without leaking the full date a second
 * time. Returns null when the input is unparseable.
 *
 * Rule: 11th/12th/13th are special-cased; otherwise the last digit picks the
 * suffix (1→st, 2→nd, 3→rd, default→th).
 */
export function formatOrdinalDayOfMonth(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return null;
  // Read the day from UTC, not the user's local timezone. The renewal ISO
  // ships from Stripe in UTC; reading it via `.getDate()` would shift the day
  // for users east of UTC at the day boundary and silently desynchronise this
  // formatter from `getBillingAnchorDay()` (which keys H7 callout dismissal).
  const day = new Date(ms).getUTCDate();
  const mod100 = day % 100;
  if (mod100 >= 11 && mod100 <= 13) return `${day}th`;
  const mod10 = day % 10;
  if (mod10 === 1) return `${day}st`;
  if (mod10 === 2) return `${day}nd`;
  if (mod10 === 3) return `${day}rd`;
  return `${day}th`;
}

/**
 * Stage H7 — billing anchor day-of-month for one-time onboarding callout
 * dismissal key. Returns the day-of-month integer (1-31) so the dismissal
 * persists across normal monthly renewals (anchor day is stable) but re-fires
 * if the user re-subscribes on a different billing day.
 */
export function getBillingAnchorDay(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return null;
  // Use UTC day-of-month so the anchor stays stable across travel / DST /
  // timezone boundaries — H7 callout dismissal is keyed by this value, and a
  // user crossing the date line should not see the callout re-appear.
  return new Date(ms).getUTCDate();
}
