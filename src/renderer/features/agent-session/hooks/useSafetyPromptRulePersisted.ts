import { useEffect } from 'react';
import { useToast } from '@renderer/components/ui';

export function useSafetyPromptRulePersisted(): void {
  const { showToast } = useToast();

  useEffect(() => {
    const unsubscribe = window.safetyPromptSubscriptions?.onSafetyPromptRulePersisted?.((payload) => {
      showToast({
        title: `Rule saved (v${payload.version}). Similar actions won't ask again.`,
        variant: 'success',
        duration: 6000,
      });
    });

    return () => {
      unsubscribe?.();
    };
  }, [showToast]);
}
