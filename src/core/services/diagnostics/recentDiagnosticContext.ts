import { createScopedLogger } from '@core/logger';
import { captureKnownCondition } from '@core/sentry/captureKnownCondition';
import {
  flushDiagnosticEventsLedger,
  getDiagnosticEventsLedgerReader,
} from '@core/services/diagnosticEventsLedger';
import {
  MAX_DIAGNOSTIC_EVENTS,
  MAX_DIAGNOSTIC_EVENTS_BYTES,
  type DiagnosticEventEntry,
  type DiagnosticEventKind,
} from './manifest';
import {
  DEFAULT_RECENT_EVENTS_LIMIT,
  DEFAULT_WINDOW_HOURS,
  MAX_RECENT_EVENTS_LIMIT,
  MAX_WINDOW_HOURS,
  MIN_RECENT_EVENTS_LIMIT,
  MIN_WINDOW_HOURS,
} from './recentLogsConstants';
import { summarizeDiagnosticEvents } from './quickStats';
// Single source of truth for the IPC envelope's Zod schema lives in src/shared/diagnostics
// so the renderer can validate without pulling logger/Sentry/ledger transitive deps.
// Core's runtime return type uses the *strict* ledger discriminated union for per-entry
// `data` (see DiagnosticEventEntry from ./manifest), which is structurally a subtype of
// the shared loose passthrough schema -- so any value core returns parses cleanly through
// the shared IPC schema, but in-process callers keep strict per-kind data typing.
export {
  RecentDiagnosticContextSchema,
  type RecentDiagnosticContext as RecentDiagnosticContextEnvelope,
} from '@shared/diagnostics/recentDiagnosticContext';

const log = createScopedLogger({ service: 'recentDiagnosticContext' });

export interface RecentDiagnosticContext {
  windowHours: number;
  limit: number;
  nowMs: number;
  counts: Partial<Record<DiagnosticEventKind, number>> | null;
  lastTimes: Partial<Record<DiagnosticEventKind, number>> | null;
  entriesByKind: Partial<Record<DiagnosticEventKind, DiagnosticEventEntry[]>>;
  totalEvents: number;
  readerAvailable: boolean;
}

export interface GetRecentDiagnosticContextOpts {
  limit?: number;
  windowHours?: number;
  nowMs?: number;
}

interface EmptyShapeOpts {
  limit: number;
  windowHours: number;
  nowMs: number;
  readerAvailable: boolean;
}

export async function getRecentDiagnosticContext(
  opts: GetRecentDiagnosticContextOpts = {},
): Promise<RecentDiagnosticContext> {
  const limit = normalizeBoundedInt(
    opts.limit,
    DEFAULT_RECENT_EVENTS_LIMIT,
    MIN_RECENT_EVENTS_LIMIT,
    MAX_RECENT_EVENTS_LIMIT,
  );
  const windowHours = normalizeBoundedInt(
    opts.windowHours,
    DEFAULT_WINDOW_HOURS,
    MIN_WINDOW_HOURS,
    MAX_WINDOW_HOURS,
  );
  const nowMs = opts.nowMs ?? Date.now();

  try {
    await flushDiagnosticEventsLedger();

    const reader = getDiagnosticEventsLedgerReader();
    if (!reader) {
      return emptyShape({ windowHours, limit, nowMs, readerAvailable: false });
    }

    let events: DiagnosticEventEntry[];
    try {
      events = await reader.readRecent({
        limit: MAX_DIAGNOSTIC_EVENTS,
        maxBytes: MAX_DIAGNOSTIC_EVENTS_BYTES,
      });
    } catch (err) {
      log.warn({ err }, 'getRecentDiagnosticContext: reader.readRecent threw');
      captureKnownCondition(
        'bridge_recent_events_failure',
        { phase: 'reader_throw' },
        err instanceof Error ? err : new Error(String(err)),
      );
      return emptyShape({ windowHours, limit, nowMs, readerAvailable: false });
    }

    const windowStartMs = nowMs - windowHours * 3_600_000;
    const filtered = events.filter((event) => event.ts >= windowStartMs && event.ts <= nowMs);
    const { counts, lastTimes } = summarizeDiagnosticEvents(filtered);
    const entriesByKind = groupTrailingEventsByKind(filtered, limit);

    return {
      windowHours,
      limit,
      nowMs,
      counts,
      lastTimes,
      entriesByKind,
      totalEvents: filtered.length,
      readerAvailable: true,
    };
  } catch (err) {
    log.warn({ err }, 'getRecentDiagnosticContext: unexpected failure');
    captureKnownCondition(
      'bridge_recent_events_failure',
      { phase: 'helper_unexpected_catch' },
      err instanceof Error ? err : new Error(String(err)),
    );
    return emptyShape({ windowHours, limit, nowMs, readerAvailable: false });
  }
}

function normalizeBoundedInt(
  value: number | undefined,
  defaultValue: number,
  min: number,
  max: number,
): number {
  if (value === undefined || !Number.isFinite(value) || value < 0) {
    return defaultValue;
  }
  const intValue = Math.trunc(value);
  return Math.min(max, Math.max(min, intValue));
}

function emptyShape({
  windowHours,
  limit,
  nowMs,
  readerAvailable,
}: EmptyShapeOpts): RecentDiagnosticContext {
  return {
    windowHours,
    limit,
    nowMs,
    counts: null,
    lastTimes: null,
    entriesByKind: {},
    totalEvents: 0,
    readerAvailable,
  };
}

function groupTrailingEventsByKind(
  events: readonly DiagnosticEventEntry[],
  limit: number,
): RecentDiagnosticContext['entriesByKind'] {
  const entriesByKind: RecentDiagnosticContext['entriesByKind'] = {};
  for (const event of events) {
    const group = entriesByKind[event.kind] ?? [];
    group.push(event);
    entriesByKind[event.kind] = group;
  }
  for (const kind of Object.keys(entriesByKind) as DiagnosticEventKind[]) {
    const group = entriesByKind[kind];
    if (group) {
      entriesByKind[kind] = group.slice(-limit);
    }
  }
  return entriesByKind;
}
