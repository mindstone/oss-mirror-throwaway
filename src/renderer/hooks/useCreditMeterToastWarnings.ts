import { useEffect, useRef } from 'react';
import { formatHumanizedResetDate } from '@rebel/shared/utils/humanizeAgentError';
import { tracking } from '@renderer/src/tracking';
import type { ToastProps } from '@renderer/components/ui/Toast';
import type { ManagedProviderInfo } from '@shared/types/managedProvider';
import type { SubscriptionState } from '@shared/types';

const STORAGE_KEY_PREFIX = 'subscription:allowanceToastWarnings';
const TOAST_CHANNEL_NAME = 'rebel:allowanceToast';
const TOAST_THRESHOLDS = [
  { label: '75' as const, pct: 0.75 },
  { label: '90' as const, pct: 0.9 },
];

type AllowanceThresholdLabel = (typeof TOAST_THRESHOLDS)[number]['label'];
type AllowanceThresholdBroadcastPayload = {
  periodKey: string;
  threshold: AllowanceThresholdLabel;
};

function getPeriodKey(resetsAt: string | undefined): string {
  // Always normalise to YYYY-MM (UTC) so the dedupe survives server precision
  // drift (millis, timezone offsets, mid-month re-issues of the same period
  // ISO) and stays consistent with the calendar-month allowance reset
  // contract. The server can ship the same logical period with a slightly
  // different ISO string between refreshes — we should not re-toast the user.
  if (resetsAt) {
    const ms = Date.parse(resetsAt);
    if (!Number.isNaN(ms)) {
      const parsed = new Date(ms);
      const year = parsed.getUTCFullYear();
      const month = String(parsed.getUTCMonth() + 1).padStart(2, '0');
      return `${year}-${month}`;
    }
  }
  // Fallback when server has not yet shipped resetsAt: bucket by current
  // calendar month so the dedupe still resets each month rather than firing
  // on every refresh.
  const now = new Date();
  const year = now.getUTCFullYear();
  const month = String(now.getUTCMonth() + 1).padStart(2, '0');
  return `${year}-${month}`;
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
    // Quota exceeded or storage unavailable — toast dedup is a nice-to-have.
  }
}

function isAllowanceThresholdBroadcastPayload(
  value: unknown,
): value is AllowanceThresholdBroadcastPayload {
  if (!value || typeof value !== 'object') return false;
  const maybePayload = value as {
    periodKey?: unknown;
    threshold?: unknown;
  };
  if (typeof maybePayload.periodKey !== 'string') return false;
  return maybePayload.threshold === '75' || maybePayload.threshold === '90';
}

function getToastDescription(
  threshold: AllowanceThresholdLabel,
  resetsAt: string | undefined,
): string {
  const formattedResetDate = formatHumanizedResetDate(resetsAt);
  if (formattedResetDate) return `Resets on ${formattedResetDate}.`;
  return `You've reached ${threshold}% of this month's usage.`;
}

function toStorageKey(periodKey: string): string {
  return `${STORAGE_KEY_PREFIX}:${periodKey}`;
}

export function useCreditMeterToastWarnings(params: {
  managedProvider: ManagedProviderInfo | undefined;
  subscription: SubscriptionState | null;
  showToast: (msg: Omit<ToastProps, 'id'>) => string;
  openSettings: () => void;
}): void {
  const { managedProvider, subscription, showToast, openSettings } = params;
  const channelRef = useRef<BroadcastChannel | null>(null);
  const emittedByPeriodRef = useRef<Map<string, Set<AllowanceThresholdLabel>>>(new Map());

  useEffect(() => {
    if (typeof BroadcastChannel === 'undefined') return;
    try {
      const channel = new BroadcastChannel(TOAST_CHANNEL_NAME);
      channelRef.current = channel;
      channel.onmessage = (event: MessageEvent<unknown>) => {
        try {
          if (!isAllowanceThresholdBroadcastPayload(event.data)) return;
          const { periodKey, threshold } = event.data;
          const storageKey = toStorageKey(periodKey);
          const persisted = readEmitted(storageKey);
          if (!persisted.has(threshold)) {
            persisted.add(threshold);
            writeEmitted(storageKey, persisted);
          }
          const byPeriod = emittedByPeriodRef.current;
          let inMemory = byPeriod.get(periodKey);
          if (!inMemory) {
            inMemory = new Set<AllowanceThresholdLabel>();
            byPeriod.set(periodKey, inMemory);
          }
          inMemory.add(threshold);
        } catch {
          // Ignore malformed storage/channel payload handling errors.
        }
      };
    } catch {
      channelRef.current = null;
    }
    return () => {
      try {
        channelRef.current?.close();
      } catch {
        // BroadcastChannel close failures should never crash the renderer.
      } finally {
        channelRef.current = null;
      }
    };
  }, []);

  useEffect(() => {
    const creditUsedMonthly = managedProvider?.creditUsedMonthly;
    const creditLimitMonthly = managedProvider?.creditLimitMonthly;
    const resetsAt = managedProvider?.resetsAt;
    const tier = subscription?.tier;

    if (!tier) return;
    if (typeof creditLimitMonthly !== 'number' || creditLimitMonthly <= 0) return;
    if (
      typeof creditUsedMonthly !== 'number' ||
      !Number.isFinite(creditUsedMonthly) ||
      creditUsedMonthly < 0
    ) return;

    const ratio = creditUsedMonthly / creditLimitMonthly;
    // At ≥100% the dedicated Q7.1 exhaustion banner (Stage H2) owns the
    // surface — suppressing the threshold toast here avoids stacking a
    // weaker "75% / 90%" toast on top of the stronger exhaustion message
    // and prevents a stale 75/90 toast firing alongside a 100% banner if
    // the user reloads after exhaustion.
    if (ratio >= 1) return;
    const periodKey = getPeriodKey(resetsAt);
    const storageKey = toStorageKey(periodKey);
    const emitted = readEmitted(storageKey);

    const byPeriod = emittedByPeriodRef.current;
    let inMemory = byPeriod.get(periodKey);
    if (!inMemory) {
      inMemory = new Set<AllowanceThresholdLabel>();
      byPeriod.set(periodKey, inMemory);
    } else {
      for (const threshold of inMemory) {
        emitted.add(threshold);
      }
    }

    let dirty = false;
    for (const { label, pct } of TOAST_THRESHOLDS) {
      if (ratio < pct) continue;
      if (emitted.has(label)) continue;

      // Re-read storage before firing to avoid stale reads when another window
      // marks the threshold in between renders.
      const latest = readEmitted(storageKey);
      for (const threshold of latest) {
        emitted.add(threshold);
      }
      if (emitted.has(label)) continue;

      try {
        channelRef.current?.postMessage({ periodKey, threshold: label });
      } catch {
        // BroadcastChannel availability can change at runtime; no-op on failure.
      }

      if (label === '75') {
        showToast({
          title: "You've used 75% of your Mindstone allowance this month",
          description: getToastDescription('75', resetsAt),
          variant: 'warning',
          duration: 10000,
        });
      } else {
        showToast({
          title: "You've used 90% of your Mindstone allowance",
          description: getToastDescription('90', resetsAt),
          variant: 'warning',
          duration: 12000,
          action: { label: 'Add your own key', onClick: openSettings },
        });
      }

      tracking.subscription.allowanceThresholdHit({ threshold: label, tier });
      emitted.add(label);
      inMemory.add(label);
      dirty = true;
    }

    if (dirty) writeEmitted(storageKey, emitted);
  }, [
    managedProvider?.creditUsedMonthly,
    managedProvider?.creditLimitMonthly,
    managedProvider?.resetsAt,
    subscription?.tier,
    showToast,
    openSettings,
  ]);
}
