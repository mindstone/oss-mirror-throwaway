import { useCallback, useEffect, useMemo } from 'react';
import type { AutomationProviderReadinessSummary } from '@shared/types';
import { useAsyncData } from '@renderer/hooks/useAsyncData';

const EMPTY_PROVIDER_READINESS_SUMMARY: AutomationProviderReadinessSummary = {
  readiness: 'ready',
  affectedAutomationCount: 0,
  affectedAutomationIds: [],
  blockedRunCount: 0,
  sinceMs: null,
  cause: null,
};

const countDistinctProviderWaitCauses = (summary: AutomationProviderReadinessSummary): number => {
  if (summary.readiness !== 'blocked') {
    return 0;
  }
  if (!summary.cause || summary.affectedAutomationCount <= 0) {
    return 0;
  }
  return 1;
};

export const useAutomationProviderReadinessSummary = (): {
  providerReadinessSummary: AutomationProviderReadinessSummary;
  providerWaitCauseCount: number;
} => {
  const fetcher = useCallback(async (): Promise<AutomationProviderReadinessSummary> => {
    const summary = await window.automationsApi.providerReadinessSummary();
    return summary ?? EMPTY_PROVIDER_READINESS_SUMMARY;
  }, []);

  const { data, refresh } = useAsyncData({
    fetcher,
    autoLoad: true,
    initialLoading: true,
  });

  useEffect(() => {
    const refreshSummary = () => {
      void refresh();
    };

    const unsubscribeAutomationState = window.api.onAutomationState(() => {
      refreshSummary();
    });
    const unsubscribeSettings = window.api.onSettingsExternalUpdate?.(() => {
      refreshSummary();
    }) ?? (() => undefined);

    return () => {
      unsubscribeAutomationState();
      unsubscribeSettings();
    };
  }, [refresh]);

  const providerReadinessSummary = data ?? EMPTY_PROVIDER_READINESS_SUMMARY;
  const providerWaitCauseCount = useMemo(
    () => countDistinctProviderWaitCauses(providerReadinessSummary),
    [providerReadinessSummary],
  );

  return {
    providerReadinessSummary,
    providerWaitCauseCount,
  };
};
