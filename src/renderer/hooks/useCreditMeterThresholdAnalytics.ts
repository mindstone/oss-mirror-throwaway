import { useEffect, useRef } from 'react';
import { tracking } from '@renderer/src/tracking';
import type { ManagedProviderInfo } from '@shared/types/managedProvider';
import type { SubscriptionState } from '@shared/types';

/**
 * Stage B3 — fire `Subscription Credit Meter Threshold Hit` once per period
 * when usage crosses the 80% or 95% threshold. Dedupe key includes the
 * current `resetsAt` so each fresh allowance window gets its own one-shot
 * emissions; when the server has not yet shipped `resetsAt` we fall back to
 * a month-bucket key so we still avoid hammering analytics on every refresh.
 *
 * Tier is logged for analytics segmentation only — it does NOT change the
 * thresholds. Per Decisions Record #8, Dash and Rogue share the same
 * dollar allowance; the meter and thresholds are identical for both tiers.
 *
 * Storage lives in `localStorage` (renderer-only UI dedup state, disposable),
 * matching the SETTINGS_CONFIGURATION_AND_ENVIRONMENT guidance.
 */

const STORAGE_KEY_PREFIX = 'subscription:creditMeterThresholds';
const ANALYTICS_THRESHOLDS = [
  { label: '80' as const, pct: 0.8 },
  { label: '95' as const, pct: 0.95 },
];

function buildStorageKey(resetsAt: string | undefined): string {
  if (resetsAt) return `${STORAGE_KEY_PREFIX}:${resetsAt}`;
  // Fallback when server has not yet shipped resetsAt: bucket by YYYY-MM so the
  // dedupe still resets each calendar month rather than firing on every refresh.
  const now = new Date();
  const year = now.getUTCFullYear();
  const month = String(now.getUTCMonth() + 1).padStart(2, '0');
  return `${STORAGE_KEY_PREFIX}:${year}-${month}`;
}

function readEmitted(key: string): Set<string> {
  if (typeof localStorage === 'undefined') return new Set();
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return new Set();
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? new Set(parsed.filter((v): v is string => typeof v === 'string')) : new Set();
  } catch {
    return new Set();
  }
}

function writeEmitted(key: string, set: Set<string>): void {
  if (typeof localStorage === 'undefined') return;
  try {
    localStorage.setItem(key, JSON.stringify(Array.from(set)));
  } catch {
    // Quota exceeded or storage unavailable — analytics dedup is a nice-to-have.
  }
}

export function useCreditMeterThresholdAnalytics(params: {
  managedProvider: ManagedProviderInfo | undefined;
  subscription: SubscriptionState | null;
}): void {
  const { managedProvider, subscription } = params;
  const lastEmittedKeyRef = useRef<string | null>(null);

  useEffect(() => {
    if (!managedProvider || !subscription) return;
    const { creditLimitMonthly, creditUsedMonthly, resetsAt } = managedProvider;
    if (!creditLimitMonthly || creditLimitMonthly <= 0) return;
    if (typeof creditUsedMonthly !== 'number' || creditUsedMonthly < 0) return;

    const tier = subscription.tier;
    const ratio = creditUsedMonthly / creditLimitMonthly;
    const storageKey = buildStorageKey(resetsAt);
    const emitted = readEmitted(storageKey);

    let dirty = false;
    for (const { label, pct } of ANALYTICS_THRESHOLDS) {
      if (ratio < pct) continue;
      if (emitted.has(label)) continue;
      tracking.subscription.creditMeterThresholdHit({ threshold: label, tier });
      emitted.add(label);
      dirty = true;
    }
    if (dirty) writeEmitted(storageKey, emitted);

    // Keep a ref so re-mounts within the same period don't re-read storage
    // unnecessarily on subsequent renders (purely an optimization hint).
    lastEmittedKeyRef.current = storageKey;
  }, [
    managedProvider,
    managedProvider?.creditUsedMonthly,
    managedProvider?.creditLimitMonthly,
    managedProvider?.resetsAt,
    subscription,
    subscription?.tier,
  ]);
}
