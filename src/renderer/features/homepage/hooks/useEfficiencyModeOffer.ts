/**
 * Efficiency Mode one-time offer.
 *
 * Surfaces a calm in-flow Notice on Home when:
 *   - the user is onboarded,
 *   - their device reports low RAM (`navigator.deviceMemory` ≤ 4 GB —
 *     Chromium caps the value at 8 and rounds down to nearest power of 2,
 *     so this catches genuine 4-and-below devices and stays conservative
 *     for 8 GB borderline machines),
 *   - the master toggle isn't already on, and
 *   - the user has been in-app for at least the minimum uptime threshold
 *     (so we don't pounce in the first minute of a fresh launch).
 *
 * Dismissal lives in the existing `dismissedAnnouncements` map under
 * `efficiency-mode-offer`, so the offer never returns once dismissed.
 *
 * See `docs/plans/260524_performance_mode.md`.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { AppSettings } from '@shared/types';
import { tracking } from '../../../src/tracking';

type SaveSettingsWith = (updater: (current: AppSettings) => AppSettings) => Promise<void>;

export const EFFICIENCY_MODE_OFFER_ID = 'efficiency-mode-offer';
const MIN_UPTIME_MS = 30 * 60 * 1000;
const LOW_RAM_THRESHOLD_GB = 4;

export type UseEfficiencyModeOfferOptions = {
  settings: AppSettings | null;
  saveSettingsWith: SaveSettingsWith;
};

export type UseEfficiencyModeOfferResult = {
  showOffer: boolean;
  handleEnable: () => Promise<void>;
  handleDismiss: () => Promise<void>;
};

function getDeviceMemoryGB(): number | null {
  if (typeof navigator === 'undefined') return null;
  const value = (navigator as Navigator & { deviceMemory?: number }).deviceMemory;
  return typeof value === 'number' ? value : null;
}

export function useEfficiencyModeOffer({
  settings,
  saveSettingsWith,
}: UseEfficiencyModeOfferOptions): UseEfficiencyModeOfferResult {
  const mountTimeRef = useRef(Date.now());
  const [now, setNow] = useState<number>(() => Date.now());

  // Re-evaluate eligibility once the uptime threshold passes so the offer
  // can appear in a long-running session without waiting for another render.
  useEffect(() => {
    const elapsed = Date.now() - mountTimeRef.current;
    if (elapsed >= MIN_UPTIME_MS) return;
    const timer = setTimeout(() => setNow(Date.now()), MIN_UPTIME_MS - elapsed + 1000);
    return () => clearTimeout(timer);
  }, []);

  const deviceMemoryGB = useMemo(() => getDeviceMemoryGB(), []);

  const isEligible = useMemo(() => {
    if (!settings) return false;
    if (settings.efficiencyMode === 'on') return false;
    if (settings.dismissedAnnouncements?.[EFFICIENCY_MODE_OFFER_ID]) return false;
    if (!settings.onboardingCompleted) return false;
    if (deviceMemoryGB === null) return false;
    if (deviceMemoryGB > LOW_RAM_THRESHOLD_GB) return false;
    if (now - mountTimeRef.current < MIN_UPTIME_MS) return false;
    return true;
  }, [settings, deviceMemoryGB, now]);

  const handleEnable = useCallback(async () => {
    await saveSettingsWith((current) => ({
      ...current,
      efficiencyMode: 'on',
      dismissedAnnouncements: {
        ...current.dismissedAnnouncements,
        [EFFICIENCY_MODE_OFFER_ID]: true,
      },
    }));
    tracking.settings.efficiencyModeToggled(true, 'home_offer');
  }, [saveSettingsWith]);

  const handleDismiss = useCallback(async () => {
    await saveSettingsWith((current) => ({
      ...current,
      dismissedAnnouncements: {
        ...current.dismissedAnnouncements,
        [EFFICIENCY_MODE_OFFER_ID]: true,
      },
    }));
    tracking.settings.efficiencyModeOfferDismissed();
  }, [saveSettingsWith]);

  return {
    showOffer: isEligible,
    handleEnable,
    handleDismiss,
  };
}
