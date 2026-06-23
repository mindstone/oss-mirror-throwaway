/**
 * useAutomationsAppState — lightweight automation state for App.tsx.
 *
 * Owns: sessionTypeFilter, setSessionTypeFilter, automationSessions.
 * Subscribes to `onAutomationState` IPC but only triggers React re-renders
 * when the derived automationSessions list meaningfully changes (different
 * session IDs, busy-state transitions, or terminal run snapshots), not on
 * every progress update.
 *
 * Split from useAutomations (Stage 6c) so that high-frequency automation:state
 * broadcasts (run progress, status updates) don't re-render App.tsx.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  AgentSession,
  AutomationRun,
  AutomationStoreState,
  SessionTypeFilter
} from '@shared/types';
import { normalizeAutomationStoreStateFromBoundary } from '@shared/utils/automationBoundaryNormalization';
import { useAsyncData } from '@renderer/hooks/useAsyncData';

type UseAutomationsAppStateResult = {
  sessionTypeFilter: SessionTypeFilter;
  automationSessions: AgentSession[];
  hasCompletedRuns: boolean;
  terminalRunStateKey: string;
  setSessionTypeFilter: (filter: SessionTypeFilter) => Promise<AutomationStoreState>;
};

const EMPTY_RUNS: AutomationRun[] = [];
const TERMINAL_RUN_STATUSES = new Set<AutomationRun['status']>([
  'success',
  'completed_with_blocks',
  'failure',
  'provider_not_ready',
  'blocked_by_security',
  'cancelled',
]);

const uniqueSessionsFromRuns = (runs: AutomationRun[]): AgentSession[] => {
  const map = new Map<string, AgentSession>();
  for (const run of runs) {
    if (run.session && run.session.id) {
      map.set(run.session.id, run.session);
    }
  }
  return Array.from(map.values());
};

/**
 * Build a change-detection key from runs that captures session identity,
 * busy-state transitions, and terminal run snapshots. Without the terminal
 * run fields, a completed automation can be ignored if the session ID and busy
 * flag are unchanged, leaving the sidebar without the final "done" session
 * snapshot for the All tab.
 */
export const sessionStateKeyFromRuns = (runs: AutomationRun[]): string => {
  if (runs.length === 0) return '';
  const parts: string[] = [];
  for (const run of runs) {
    const session = run.session;
    if (!session?.id) continue;
    const busy = session.isBusy || session.activeTurnId ? '1' : '0';
    parts.push(`${session.id}:${busy}:${run.status}:${run.completedAt ?? 0}`);
  }
  return parts.sort().join(',');
};

export const terminalRunStateKeyFromRuns = (runs: AutomationRun[]): string => {
  const parts: string[] = [];
  for (const run of runs) {
    if (!run.sessionId || !TERMINAL_RUN_STATUSES.has(run.status)) continue;
    parts.push(`${run.sessionId}:${run.status}:${run.completedAt ?? 0}`);
  }
  return parts.sort().join(',');
};

export const useAutomationsAppState = (): UseAutomationsAppStateResult => {
  const [subscriptionState, setSubscriptionState] = useState<AutomationStoreState | null>(null);
  const lastSessionKeyRef = useRef<string>('');
  const lastSessionTypeFilterRef = useRef<SessionTypeFilter>('all');

  const fetcher = useCallback(async () => {
    const state = await window.automationsApi.state();
    return normalizeAutomationStoreStateFromBoundary(state);
  }, []);

  const { data: fetchedState } = useAsyncData({
    fetcher,
    autoLoad: true,
    initialLoading: true,
  });

  // Merge fetched state with subscription updates (subscription takes precedence)
  const state = subscriptionState ?? fetchedState;

  // Subscribe to automation state updates
  useEffect(() => {
    const unsubscribe = window.api.onAutomationState((next) => {
      const normalizedNext = normalizeAutomationStoreStateFromBoundary(next);
      const nextSessionKey = sessionStateKeyFromRuns(normalizedNext.runs);
      const nextSessionTypeFilter = normalizedNext.sessionTypeFilter ?? 'all';

      if (
        nextSessionKey === lastSessionKeyRef.current &&
        nextSessionTypeFilter === lastSessionTypeFilterRef.current
      ) {
        return;
      }

      lastSessionKeyRef.current = nextSessionKey;
      lastSessionTypeFilterRef.current = nextSessionTypeFilter;
      setSubscriptionState(normalizedNext);
    });
    return unsubscribe;
  }, []);

  const setSessionTypeFilter = useCallback(async (filter: SessionTypeFilter) => {
    const snapshot = normalizeAutomationStoreStateFromBoundary(
      await window.automationsApi.setSessionTypeFilter(filter),
    );
    // State update handled by onAutomationState subscription
    return snapshot;
  }, []);

  const sessionTypeFilter = state?.sessionTypeFilter ?? 'all';
  const runs = state?.runs ?? EMPTY_RUNS;
  const terminalRunStateKey = useMemo(
    () => terminalRunStateKeyFromRuns(runs),
    [runs],
  );
  const hasCompletedRuns = useMemo(
    () => terminalRunStateKey.length > 0,
    [terminalRunStateKey]
  );

  // Derive sessions from runs
  const derivedSessions = useMemo(() => uniqueSessionsFromRuns(runs), [runs]);

  // PERF: Only update the returned automationSessions when session IDs, busy
  // state, or terminal run snapshots change. This prevents App.tsx re-renders
  // on every run-progress broadcast, while still propagating terminal state
  // changes so ingestExternalSessions can make completed automation sessions
  // visible in the sidebar's All tab.
  const sessionStateKey = useMemo(
    () => sessionStateKeyFromRuns(runs),
    [runs]
  );

  useEffect(() => {
    lastSessionKeyRef.current = sessionStateKey;
    lastSessionTypeFilterRef.current = sessionTypeFilter;
  }, [sessionStateKey, sessionTypeFilter]);

  const automationSessions = useMemo(() => {
    return derivedSessions.map(s => ({ ...s, origin: 'automation' as const }));
    // eslint-disable-next-line react-hooks/exhaustive-deps -- intentional: re-derive only when the session-state key changes
  }, [sessionStateKey]);

  return {
    sessionTypeFilter,
    automationSessions,
    hasCompletedRuns,
    terminalRunStateKey,
    setSessionTypeFilter,
  };
};
