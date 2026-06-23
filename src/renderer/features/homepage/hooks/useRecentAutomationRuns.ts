/**
 * useRecentAutomationRuns — Lightweight hook for surfacing recent automation
 * runs that have output worth reviewing on the homepage Today stream.
 *
 * Loads automation state via IPC and subscribes to live updates.
 * Filters for runs completed today with reviewable status.
 *
 * Note: "importance" filtering is intentionally loose for now —
 * surfaces all completed runs with output. Will be refined later.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { AutomationDefinition, AutomationRun, AutomationStoreState } from '@shared/types';
import { normalizeAutomationStoreStateFromBoundary } from '@shared/utils/automationBoundaryNormalization';
import { useAsyncData } from '@renderer/hooks/useAsyncData';

export interface RecentAutomationItem {
  /** Unique ID for the run */
  runId: string;
  /** Human-readable automation name */
  name: string;
  /** The automation definition ID */
  automationId: string;
  /** Session ID for viewing the full output */
  sessionId: string;
  /** When the run completed (epoch ms) */
  completedAt: number;
  /** Whether the run failed */
  failed: boolean;
  /** Whether security blocks occurred */
  hadBlocks: boolean;
  /** Error message if failed */
  error?: string;
}

const RECENCY_WINDOW_MS = 4 * 60 * 60 * 1000; // 4 hours

/** Surface completed runs from the last few hours (success or failure) */
function isReviewableRun(run: AutomationRun): boolean {
  if (!run.completedAt || !run.sessionId) return false;

  const validStatuses = ['success', 'completed_with_blocks', 'failure'];
  if (!validStatuses.includes(run.status)) return false;

  // Only runs completed within the last 4 hours
  const age = Date.now() - run.completedAt;
  if (age > RECENCY_WINDOW_MS) return false;

  return true;
}

function runToItem(
  run: AutomationRun,
  definitions: AutomationDefinition[],
): RecentAutomationItem | null {
  if (!run.completedAt || !run.sessionId) return null;

  const definition = definitions.find((d) => d.id === run.automationId);
  const name = definition?.name ?? 'Automation';

  return {
    runId: run.id,
    name,
    automationId: run.automationId,
    sessionId: run.sessionId,
    completedAt: run.completedAt,
    failed: run.status === 'failure',
    hadBlocks: (run.blockedActions?.length ?? 0) > 0,
    error: run.error ?? undefined,
  };
}

/**
 * Build a change-detection key from reviewable runs. Only triggers re-renders
 * when a run enters/leaves the reviewable window or changes status — not on
 * every high-frequency projection broadcast from running automations.
 */
const buildRecentRunsKey = (state: AutomationStoreState): string => {
  return state.runs
    .filter(isReviewableRun)
    .map(r => `${r.id}:${r.status}`)
    .sort()
    .join(',');
};

export interface UseRecentAutomationRunsResult {
  items: RecentAutomationItem[];
  isLoading: boolean;
}

export function useRecentAutomationRuns(enabled = true): UseRecentAutomationRunsResult {
  const [subscriptionState, setSubscriptionState] = useState<AutomationStoreState | null>(null);

  const fetcher = useCallback(async () => {
    const state = await window.automationsApi.state();
    return normalizeAutomationStoreStateFromBoundary(state);
  }, []);

  const {
    data: fetchedState,
    loading: fetchLoading,
    refresh,
  } = useAsyncData({
    fetcher,
    autoLoad: true,
    initialLoading: true,
    enabled,
  });

  const state = subscriptionState ?? fetchedState;
  const isLoading = fetchLoading && !subscriptionState;

  const lastStateKeyRef = useRef<string>('');

  // Subscribe to live automation state updates (only when enabled).
  // On re-enable: clear stale subscription overlay and force a fresh fetch
  // to catch any automation runs that completed while the surface was hidden.
  useEffect(() => {
    if (!enabled) return;
    setSubscriptionState(null);
    lastStateKeyRef.current = '';
    void refresh();
    const unsubscribe = window.api.onAutomationState((next) => {
      const normalizedNext = normalizeAutomationStoreStateFromBoundary(next);
      const nextKey = buildRecentRunsKey(normalizedNext);
      if (nextKey === lastStateKeyRef.current) return;
      lastStateKeyRef.current = nextKey;
      setSubscriptionState(normalizedNext);
    });
    return unsubscribe;
  }, [enabled, refresh]);

  const items = useMemo(() => {
    if (!state) return [];

    // Only show user-created automations — system/built-in automations are not surfaced
    const userDefinitionIds = new Set(
      state.definitions.filter((d) => !d.isSystem).map((d) => d.id),
    );

    const reviewableRuns = state.runs
      .filter((run) => userDefinitionIds.has(run.automationId) && isReviewableRun(run))
      .sort((a, b) => (b.completedAt ?? 0) - (a.completedAt ?? 0));

    return reviewableRuns
      .map((run) => runToItem(run, state.definitions))
      .filter((item): item is RecentAutomationItem => item !== null);
  }, [state]);

  return { items, isLoading };
}
