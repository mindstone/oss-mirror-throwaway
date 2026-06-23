import { useEffect, useRef } from 'react';
import type { ActiveProvider, AppSettings } from '@shared/types';
import {
  diffDefaultModels,
  type ManagedDefaultModels,
} from '@shared/types/managedProvider';
import { useManagedDefaults } from './useManagedDefaults';

interface ToastApi {
  title: string;
  description?: string;
  duration?: number;
}

interface UseManagedTierModelChangeNotifierOptions {
  activeProvider: ActiveProvider | undefined;
  settings: AppSettings | null | undefined;
  showToast: (toast: ToastApi) => void;
  /**
   * Apply a snap-to-default mutation when the user's currently-selected model
   * was removed from the new tier defaults. Optional — when omitted, the hook
   * only surfaces the toast and relies on Stage G1 lockdown plus server-pushed
   * company-managed profile updates to converge the user's selection.
   */
  onSnap?: (next: ManagedDefaultModels) => void;
}

/**
 * Stage G5 — observes managed-tier default-model changes pushed via
 * `/api/config` and notifies the user when a model has been removed from
 * their tier. Mounted globally (App.tsx) so the toast surface is consistent
 * regardless of which screen the user is on.
 *
 * Fires exactly once per change event (debounced by `previousDefaultsRef`)
 * and only when `activeProvider === 'mindstone'`, so BYOK OpenRouter users
 * are unaffected. The toast text is intentionally generic — server-pushed
 * company-managed profiles + Stage G1 picker lockdown already drive the
 * selection back to a valid model, so this surface exists to explain the
 * change rather than to perform the snap.
 *
 * See docs/plans/260513a_subscription_consumer_audit_gaps.md (Stage G5).
 */
export function useManagedTierModelChangeNotifier(
  options: UseManagedTierModelChangeNotifierOptions,
): void {
  const { defaultModels } = useManagedDefaults();
  const previousDefaultsRef = useRef<ManagedDefaultModels | undefined>(undefined);
  const hasSeenInitialRef = useRef(false);
  const { activeProvider, showToast, onSnap } = options;

  useEffect(() => {
    if (!hasSeenInitialRef.current) {
      // Avoid bootstrap noise — the first observed snapshot is the baseline.
      previousDefaultsRef.current = defaultModels;
      hasSeenInitialRef.current = true;
      return;
    }

    const prev = previousDefaultsRef.current;
    const { added, removed } = diffDefaultModels(prev, defaultModels);
    previousDefaultsRef.current = defaultModels;

    if (added.length === 0 && removed.length === 0) return;
    if (activeProvider !== 'mindstone') return;
    if (removed.length === 0) return;

    showToast({
      title: 'Your Mindstone plan models were updated',
      description:
        "We've matched your model to your Mindstone plan defaults. You can pick from your plan's models any time in Settings.",
      duration: 8000,
    });

    if (onSnap && defaultModels) {
      onSnap(defaultModels);
    }
  }, [activeProvider, defaultModels, onSnap, showToast]);
}
