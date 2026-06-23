import { useEffect, useRef } from 'react';
import { useToast } from '@renderer/components/ui';

export function useBtsStructuredOutputBypassedToast(): void {
  const { showToast } = useToast();
  const notifiedProfileIds = useRef<Set<string>>(new Set());

  useEffect(() => {
    const unsubscribe = window.btsSubscriptions?.onStructuredOutputBypassed?.((payload) => {
      if (notifiedProfileIds.current.has(payload.profileId)) return;
      notifiedProfileIds.current.add(payload.profileId);
      showToast({
        title: `${payload.profileName || 'Your safety model'} can't produce structured JSON — Rebel is using a fallback for these checks.`,
        description: 'Re-test in Settings → Models to clear this.',
        variant: 'warning',
        duration: 8000,
      });
    });

    return () => {
      unsubscribe?.();
    };
  }, [showToast]);
}
