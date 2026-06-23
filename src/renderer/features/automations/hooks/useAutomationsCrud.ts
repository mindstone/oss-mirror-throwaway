/**
 * useAutomationsCrud — CRUD operations and live data for the AutomationsPanel.
 *
 * Owns: definitions, runs, loading, error, refresh, upsert, delete, runNow.
 * Subscribes to `onAutomationState` IPC for live updates.
 *
 * Split from useAutomations (Stage 6c) so that CRUD state changes (which happen
 * on every automation:state broadcast) only re-render AutomationsPanel, not App.tsx.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  AutomationDefinition,
  AutomationDefinitionInput,
  AutomationRun,
  AutomationScheduleQuarantineEntry,
  AutomationStoreState
} from '@shared/types';
import {
  normalizeAutomationDefinitionFromBoundary,
  normalizeAutomationStoreStateFromBoundary,
} from '@shared/utils/automationBoundaryNormalization';
import { tracking } from '@renderer/src/tracking';
import { useAsyncData } from '@renderer/hooks/useAsyncData';

/**
 * Build a change-detection key that captures definition identity/freshness,
 * run statuses, and running-session busy state. Skips re-renders when only
 * session internals (messages, events) change during high-frequency projection
 * broadcasts.
 */
const buildCrudStateKey = (state: AutomationStoreState): string => {
  const defs = state.definitions
    .map(d => `${d.id}:${d.updatedAt}`)
    .sort()
    .join(',');
  const runs = state.runs
    .map(r => `${r.id}:${r.status}`)
    .sort()
    .join(',');
  const sessions = state.runs
    .filter((r): r is AutomationRun & { session: NonNullable<AutomationRun['session']> } =>
      r.status === 'running' && r.session != null)
    .map(r => `${r.session.id}:${r.session.isBusy ? '1' : '0'}`)
    .sort()
    .join(',');
  return `${defs}|${runs}|${sessions}`;
};

type UseAutomationsCrudResult = {
  definitions: AutomationDefinition[];
  runs: AutomationRun[];
  quarantined: AutomationScheduleQuarantineEntry[];
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
  upsertAutomation: (input: AutomationDefinitionInput) => Promise<AutomationDefinition>;
  deleteAutomation: (automationId: string) => Promise<AutomationStoreState>;
  runAutomationNow: (automationId: string) => Promise<AutomationRun | null>;
};

export const useAutomationsCrud = (): UseAutomationsCrudResult => {
  const [subscriptionState, setSubscriptionState] = useState<AutomationStoreState | null>(null);

  const fetcher = useCallback(async () => {
    const state = await window.automationsApi.state();
    return normalizeAutomationStoreStateFromBoundary(state);
  }, []);

  const {
    data: fetchedState,
    loading: fetchLoading,
    error,
    refresh,
  } = useAsyncData({
    fetcher,
    autoLoad: true,
    initialLoading: true,
  });

  // Merge fetched state with subscription updates (subscription takes precedence)
  const state = subscriptionState ?? fetchedState;
  const loading = fetchLoading && !subscriptionState;

  const lastStateKeyRef = useRef<string>('');

  // Subscribe to automation state updates with change-detection guard
  useEffect(() => {
    const unsubscribe = window.api.onAutomationState((next) => {
      const normalizedNext = normalizeAutomationStoreStateFromBoundary(next);
      const nextKey = buildCrudStateKey(normalizedNext);
      if (nextKey === lastStateKeyRef.current) return;
      lastStateKeyRef.current = nextKey;
      setSubscriptionState(normalizedNext);
    });
    return unsubscribe;
  }, []);

  const upsertAutomation = useCallback(async (input: AutomationDefinitionInput) => {
    const isNew = !input.id;
    const result = normalizeAutomationDefinitionFromBoundary(await window.automationsApi.upsert(input));

    if (isNew) {
      const isFirstAutomation = (state?.definitions.length ?? 0) === 0;
      tracking.automations.created(
        result.schedule.type,
        Boolean(result.filePath),
        result.catchUpIfMissed !== false,
        isFirstAutomation,
        result.id
      );
    } else {
      tracking.automations.updated(
        result.id,
        result.schedule.type,
        [],
        false
      );
    }

    return result;
  }, [state?.definitions.length]);

  const deleteAutomation = useCallback(async (automationId: string) => {
    const hadRuns = state?.runs.some(r => r.automationId === automationId) ?? false;

    const snapshot = normalizeAutomationStoreStateFromBoundary(
      await window.automationsApi.delete(automationId),
    );
    // State update handled by onAutomationState subscription

    tracking.automations.deleted(automationId, hadRuns);

    return snapshot;
  }, [state?.runs]);

  const runAutomationNow = useCallback(async (automationId: string) => {
    const existingRuns = state?.runs.filter(r => r.automationId === automationId) ?? [];
    const isFirstRun = existingRuns.length === 0;

    tracking.automations.runStarted(automationId, 'manual', isFirstRun);

    return window.automationsApi.runNow(automationId);
  }, [state?.runs]);

  const definitions = state?.definitions ?? [];
  const runs = state?.runs ?? [];
  const quarantined = state?.quarantined ?? [];

  return {
    definitions,
    runs,
    quarantined,
    loading,
    error,
    refresh,
    upsertAutomation,
    deleteAutomation,
    runAutomationNow,
  };
};

export type { AutomationDefinitionInput };
