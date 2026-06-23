import { useCallback, useState } from 'react';
import { Notice } from '@renderer/components/ui';

export type EfficiencyModeOfferCardProps = {
  onEnable: () => void | Promise<void>;
  onDismiss: () => void | Promise<void>;
};

/**
 * One-time in-flow Notice on Home offering Efficiency Mode to users whose
 * device reports low RAM. Calm, factual, no shaming. Two CTAs: Turn on /
 * Not now. Dismissed via existing `dismissedAnnouncements` so it never
 * returns once the user has decided.
 *
 * The two CTAs are disabled while their handlers are in flight so a
 * double-click can't race the settings save (which would otherwise risk a
 * stale full-settings payload clobbering the Efficiency Mode invariant on
 * the server). Errors swallow and re-enable the buttons so the user can
 * retry; we deliberately don't surface a toast because the Notice itself
 * is a low-stakes, dismissible card.
 *
 * See `docs/plans/260524_performance_mode.md`.
 */
export function EfficiencyModeOfferCard({ onEnable, onDismiss }: EfficiencyModeOfferCardProps) {
  const [pending, setPending] = useState<'enable' | 'dismiss' | null>(null);

  const handleEnable = useCallback(async () => {
    if (pending) return;
    setPending('enable');
    try {
      await onEnable();
    } finally {
      setPending(null);
    }
  }, [onEnable, pending]);

  const handleDismiss = useCallback(async () => {
    if (pending) return;
    setPending('dismiss');
    try {
      await onDismiss();
    } finally {
      setPending(null);
    }
  }, [onDismiss, pending]);

  return (
    <Notice
      tone="info"
      placement="inline"
      data-testid="home-efficiency-mode-offer"
      actions={[
        {
          label: 'Turn on',
          onClick: () => { void handleEnable(); },
          loading: pending === 'enable',
          disabled: pending !== null && pending !== 'enable',
        },
        {
          label: 'Not now',
          onClick: () => { void handleDismiss(); },
          loading: pending === 'dismiss',
          disabled: pending !== null && pending !== 'dismiss',
        },
      ]}
    >
      Looks like Rebel is running on a machine that would appreciate a quieter
      mode. Efficiency Mode pauses animations and proactive nudges. Knowledge
      work is unchanged.
    </Notice>
  );
}
