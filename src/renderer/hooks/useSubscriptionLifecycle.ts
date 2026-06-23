import { useEffect, useRef } from 'react';
import { useSubscriptionState } from './useSubscriptionState';
import { tracking } from '@renderer/src/tracking';
import type { SubscriptionState } from '@shared/types';
import { isEntitledStatus } from '@shared/subscription/expectedSubscriptionState';

type ToastFn = (message: {
  title: string;
  description?: string;
  variant?: 'default' | 'success' | 'warning' | 'error' | 'info';
  duration?: number;
}) => void;

function isEntitled(state: SubscriptionState | null): boolean {
  if (!state) return false;
  return isEntitledStatus(state.status);
}

/**
 * Watches subscription state and surfaces user-visible notifications when it
 * changes in ways the user should know about. Designed to be the single
 * cross-cutting subscription-lifecycle hook called from App.tsx.
 *
 * Transitions surfaced:
 * - Entitled (`active` / `trialing`) -> `canceled` / `inactive`: toast prompting
 *   the user to either re-subscribe or fall back to another provider. We do
 *   NOT silently auto-switch providers — the user has to decide.
 * - `past_due` -> entitled: toast confirming payment recovered.
 * - Entering `past_due`: warning toast pointing at Settings.
 *
 * Returns the current subscription state for callers that want to render
 * additional UI on top.
 */
export function useSubscriptionLifecycle(showToast: ToastFn): {
  subscription: SubscriptionState | null;
  isActive: boolean;
  isPastDueWithinGrace: boolean;
} {
  const { subscription, isActive, isPastDueWithinGrace, phase } = useSubscriptionState();
  const previousRef = useRef<SubscriptionState | null>(null);
  const initializedRef = useRef(false);

  useEffect(() => {
    // Skip until the first successful fetch — we don't want to fire transition
    // toasts the first time the renderer boots and finds an existing state.
    if (phase !== 'ready') return;

    const previous = previousRef.current;
    const current = subscription;

    // First time we see a real result: just record it, no transition fire.
    if (!initializedRef.current) {
      initializedRef.current = true;
      previousRef.current = current;
      return;
    }

    if (previous === current) return;

    const wasEntitled = isEntitled(previous);
    const nowEntitled = isEntitled(current);
    const wasPastDue = previous?.status === 'past_due';
    const nowPastDue = current?.status === 'past_due';
    const nowEnded = !current || current.status === 'canceled' || current.status === 'inactive';

    // Active -> ended (canceled / inactive). User-visible, not silent.
    if (wasEntitled && nowEnded) {
      showToast({
        title: 'Your Mindstone subscription has ended',
        description: 'Switch to a different AI provider in Settings to keep using Rebel.',
        variant: 'warning',
        duration: 12000,
      });
      tracking.subscription.stateTransition({
        from: previous!.status,
        to: current?.status ?? 'none',
        tier: previous!.tier,
      });
    }

    // past_due -> entitled (payment recovered).
    else if (wasPastDue && nowEntitled) {
      showToast({
        title: 'Payment recovered',
        description: 'Your Mindstone subscription is active again.',
        variant: 'success',
        duration: 8000,
      });
      tracking.subscription.stateTransition({
        from: 'past_due',
        to: current!.status,
        tier: current!.tier,
      });
    }

    // entitled -> past_due (payment failed).
    else if (wasEntitled && nowPastDue) {
      showToast({
        title: 'Payment issue with your Mindstone subscription',
        description: 'Update your payment method in Settings to avoid losing access.',
        variant: 'warning',
        duration: 12000,
      });
      tracking.subscription.stateTransition({
        from: previous!.status,
        to: 'past_due',
        tier: current!.tier,
      });
    }

    previousRef.current = current;
  }, [subscription, phase, showToast]);

  return { subscription, isActive, isPastDueWithinGrace };
}
