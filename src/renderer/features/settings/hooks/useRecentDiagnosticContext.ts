import { useCallback, useEffect, useMemo, useState } from 'react';
import type {
  DiagnosticEventEntry,
  DiagnosticEventKind,
  RecentDiagnosticContext,
} from '@shared/diagnostics/recentDiagnosticContext';

export type RecentDiagnosticContextStatus =
  | 'loading'
  | 'error'
  | 'empty'
  | 'readerUnavailable'
  | 'populated';

export interface UseRecentDiagnosticContextResult {
  status: RecentDiagnosticContextStatus;
  events: DiagnosticEventEntry[];
  logs: string;
  lastFetchedAt: number | null;
  refresh: () => Promise<void>;
  copyForSupport: () => Promise<boolean>;
  error: Error | null;
}

interface HookState {
  status: RecentDiagnosticContextStatus;
  context: RecentDiagnosticContext | null;
  events: DiagnosticEventEntry[];
  logs: string;
  lastFetchedAt: number | null;
  error: Error | null;
}

const EMPTY_LOGS = '';

export function useRecentDiagnosticContext(): UseRecentDiagnosticContextResult {
  const [state, setState] = useState<HookState>({
    status: 'loading',
    context: null,
    events: [],
    logs: EMPTY_LOGS,
    lastFetchedAt: null,
    error: null,
  });

  const refresh = useCallback(async () => {
    setState((prev) => ({
      ...prev,
      status: 'loading',
      error: null,
    }));

    try {
      const context = await window.diagnosticsApi.getRecentContext({});
      const logs = formatRecentDiagnosticEventsMarkdown(context);
      const events = flattenDiagnosticEvents(context);
      const lastFetchedAt = Date.now();

      setState({
        status: getStatusForContext(context),
        context,
        events,
        logs,
        lastFetchedAt,
        error: null,
      });
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      console.warn('Failed to load recent diagnostic activity', { err });
      setState({
        status: 'error',
        context: null,
        events: [],
        logs: EMPTY_LOGS,
        lastFetchedAt: Date.now(),
        error,
      });
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const copyForSupport = useCallback(async (): Promise<boolean> => {
    const capturedAt = new Date(state.lastFetchedAt ?? Date.now()).toISOString();
    const windowHours = state.context?.windowHours ?? 24;
    const body = getCopyBodyForStatus(state.status, state.logs, windowHours);
    const markdown = [
      '# Rebel recent activity for support',
      '',
      `Window: Last ${windowHours}h`,
      `Captured at: ${capturedAt}`,
      `Status: ${state.status}`,
      '',
      body,
    ].join('\n');

    try {
      await navigator.clipboard.writeText(markdown);
      return true;
    } catch (err) {
      console.warn('Failed to copy recent diagnostic activity', { err });
      return false;
    }
  }, [state.context?.windowHours, state.lastFetchedAt, state.logs, state.status]);

  return useMemo(
    () => ({
      status: state.status,
      events: state.events,
      logs: state.logs,
      lastFetchedAt: state.lastFetchedAt,
      refresh,
      copyForSupport,
      error: state.error,
    }),
    [
      copyForSupport,
      refresh,
      state.error,
      state.events,
      state.lastFetchedAt,
      state.logs,
      state.status,
    ],
  );
}

function getCopyBodyForStatus(
  status: RecentDiagnosticContextStatus,
  logs: string,
  windowHours: number,
): string {
  switch (status) {
    case 'loading':
      return 'Recent activity is still loading. Try again in a moment.';
    case 'error':
      return "Couldn't read recent activity for this report. The diagnostic ledger is currently unavailable.";
    case 'readerUnavailable':
      return "Recent activity isn't available on this surface — the diagnostic ledger isn't supported here.";
    case 'empty':
      return `All quiet. Nothing notable in the last ${windowHours}h.`;
    case 'populated':
      return logs;
    default: {
      const unhandled: never = status;
      return unhandled;
    }
  }
}

function getStatusForContext(context: RecentDiagnosticContext): RecentDiagnosticContextStatus {
  if (context.readerAvailable === false && context.totalEvents === 0) {
    return 'readerUnavailable';
  }
  if (context.totalEvents === 0) {
    return 'empty';
  }
  return 'populated';
}

function flattenDiagnosticEvents(context: RecentDiagnosticContext): DiagnosticEventEntry[] {
  return Object.values(context.entriesByKind)
    .flatMap((entries) => entries ?? [])
    .sort((left, right) => right.ts - left.ts);
}

function formatRecentDiagnosticEventsMarkdown(context: RecentDiagnosticContext): string {
  const lines: string[] = [`## Recent diagnostic events — last ${context.windowHours}h`, ''];
  const countKinds = sortedKinds(context.counts);

  if (context.totalEvents === 0 && countKinds.length === 0) {
    lines.push(`All quiet. Nothing notable in the last ${context.windowHours}h.`);
    return lines.join('\n');
  }

  lines.push('### Per-kind counts');
  lines.push('| Kind | Count | Last seen |');
  lines.push('| ---- | ----- | --------- |');
  for (const kind of countKinds) {
    lines.push(
      `| ${kind} | ${context.counts?.[kind] ?? 0} | ${formatTimestamp(context.lastTimes?.[kind])} |`,
    );
  }

  lines.push('');
  lines.push(`### Last ${context.limit} entries per kind`);

  const entryKinds = sortedKinds(context.entriesByKind);
  for (const kind of entryKinds) {
    const entries = context.entriesByKind[kind] ?? [];
    lines.push('');
    lines.push(`#### ${kind} (${context.counts?.[kind] ?? entries.length} in window)`);
    for (const event of entries) {
      lines.push(formatEventLine(event));
    }
  }

  return lines.join('\n');
}

function sortedKinds(record: Partial<Record<DiagnosticEventKind, unknown>> | null): DiagnosticEventKind[] {
  return Object.keys(record ?? {}).sort() as DiagnosticEventKind[];
}

function formatTimestamp(ts: number | undefined): string {
  return typeof ts === 'number' ? new Date(ts).toISOString() : '—';
}

function formatEventLine(event: DiagnosticEventEntry): string {
  return [
    `- ${formatTimestamp(event.ts)}`,
    `surface=${event.surface ?? 'unknown'}`,
    `tid=${event.tid ?? '—'}`,
    `sid=${event.sid ?? '—'}`,
    `data=${stringifyData(event.data ?? {})}`,
  ].join(' · ');
}

function stringifyData(data: unknown): string {
  try {
    return JSON.stringify(data ?? {}) ?? '{}';
  } catch {
    return JSON.stringify({ serialization: 'failed' });
  }
}
