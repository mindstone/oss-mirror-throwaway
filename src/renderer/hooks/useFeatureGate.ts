import { useCallback, useEffect, useMemo, useState } from 'react';
import type { LicenseTier } from '@shared/ipc/schemas/auth';

export type FeatureKey = 'spaces:create-additional';

type FeatureGateState = {
  licenseTier: LicenseTier;
  isFeatureEnabled: (feature: FeatureKey) => boolean;
};

type AuthApiWithConfigEvents = Window['authApi'] & {
  onAuthConfigReceived?: (callback: () => void) => () => void;
};

const FEATURE_REQUIREMENTS: Record<FeatureKey, LicenseTier> = {
  'spaces:create-additional': 'teams',
};

const LICENSE_TIER_RANK: Record<LicenseTier, number> = {
  free: 0,
  teams: 1,
};

export function useFeatureGate(): FeatureGateState {
  const [licenseTier, setLicenseTier] = useState<LicenseTier>('free');

  useEffect(() => {
    let isMounted = true;

    const refreshLicenseTier = async () => {
      try {
        const config = await window.authApi.getConfig();
        if (!isMounted) {
          return;
        }
        setLicenseTier(config?.licenseTier ?? 'free');
      } catch {
        if (!isMounted) {
          return;
        }
        setLicenseTier('free');
      }
    };

    void refreshLicenseTier();

    const authApiWithConfigEvents = window.authApi as AuthApiWithConfigEvents;
    const unsubscribe = typeof authApiWithConfigEvents.onAuthConfigReceived === 'function'
      ? authApiWithConfigEvents.onAuthConfigReceived(() => {
          void refreshLicenseTier();
        })
      : window.api.onAuthConfigReceived(() => {
          void refreshLicenseTier();
        });

    return () => {
      isMounted = false;
      unsubscribe();
    };
  }, []);

  const isFeatureEnabled = useCallback(
    (feature: FeatureKey) => {
      const requiredTier = FEATURE_REQUIREMENTS[feature];
      return LICENSE_TIER_RANK[licenseTier] >= LICENSE_TIER_RANK[requiredTier];
    },
    [licenseTier]
  );

  return useMemo(
    () => ({
      licenseTier,
      isFeatureEnabled,
    }),
    [isFeatureEnabled, licenseTier]
  );
}
