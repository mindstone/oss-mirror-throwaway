// @device-scoped: first-use onboarding dismissal is a local device preference.

import { useCallback, useEffect, useState } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';

export const ASK_SPARK_ONBOARDING_STORAGE_KEY = 'meeting.askSpark.onboardingDismissed';

export function useMeetingFirstUseOnboarding() {
  const [hasLoaded, setHasLoaded] = useState(false);
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    let cancelled = false;

    AsyncStorage.getItem(ASK_SPARK_ONBOARDING_STORAGE_KEY)
      .then((value) => {
        if (cancelled) return;
        setDismissed(value === 'true');
      })
      .catch(() => {
        if (cancelled) return;
        setDismissed(false);
      })
      .finally(() => {
        if (!cancelled) setHasLoaded(true);
      });

    return () => {
      cancelled = true;
    };
  }, []);

  const dismiss = useCallback(() => {
    setDismissed(true);
    void AsyncStorage.setItem(ASK_SPARK_ONBOARDING_STORAGE_KEY, 'true');
  }, []);

  return {
    showTip: hasLoaded && !dismissed,
    dismiss,
  };
}
