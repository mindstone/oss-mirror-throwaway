import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  MAX_DIAGNOSTIC_EVENTS,
  MAX_DIAGNOSTIC_EVENTS_BYTES,
  DIAGNOSTIC_EVENT_SCHEMA_VERSION,
  type DiagnosticEventEntry,
} from '../manifest';
import {
  resetDiagnosticEventsLedgerForTests,
  setDiagnosticEventsLedgerReader,
} from '@core/services/diagnosticEventsLedger';
import { captureKnownCondition } from '@core/sentry/captureKnownCondition';
import { getRecentDiagnosticContext } from '../recentDiagnosticContext';

vi.mock('@core/sentry/captureKnownCondition', () => ({
  captureKnownCondition: vi.fn(),
}));

const NOW_MS = 1_000_000_000_000;

describe('getRecentDiagnosticContext', () => {
  beforeEach(() => {
    resetDiagnosticEventsLedgerForTests();
    vi.mocked(captureKnownCondition).mockClear();
  });

  it('returns an empty unavailable shape when no reader is registered', async () => {
    const context = await getRecentDiagnosticContext({ nowMs: NOW_MS });

    expect(context.readerAvailable).toBe(false);
    expect(context.totalEvents).toBe(0);
    expect(context.entriesByKind).toEqual({});
  });

  it('returns an empty available shape when the reader returns no events', async () => {
    installReader([]);

    const context = await getRecentDiagnosticContext({ nowMs: NOW_MS });

    expect(context).toMatchObject({
      readerAvailable: true,
      totalEvents: 0,
      counts: null,
      lastTimes: null,
      entriesByKind: {},
    });
  });

  it('returns an empty unavailable shape when reader.readRecent throws', async () => {
    const readerError = new Error('reader unavailable');
    setDiagnosticEventsLedgerReader({
      readRecent: vi.fn(async () => {
        throw readerError;
      }),
    });

    await expect(getRecentDiagnosticContext({ nowMs: NOW_MS })).resolves.toMatchObject({
      readerAvailable: false,
      totalEvents: 0,
      entriesByKind: {},
    });
    expect(captureKnownCondition).toHaveBeenCalledWith(
      'bridge_recent_events_failure',
      { phase: 'reader_throw' },
      readerError,
    );
  });

  it('returns an empty unavailable shape and emits known-condition when downstream summarisation throws', async () => {
    const downstreamError = new Error('summarise blew up');
    const quickStats = await import('../quickStats');
    const spy = vi.spyOn(quickStats, 'summarizeDiagnosticEvents').mockImplementation(() => {
      throw downstreamError;
    });

    installReader([cooldownEnter(NOW_MS - 1000)]);

    await expect(getRecentDiagnosticContext({ nowMs: NOW_MS })).resolves.toMatchObject({
      readerAvailable: false,
      totalEvents: 0,
      entriesByKind: {},
    });
    expect(captureKnownCondition).toHaveBeenCalledWith(
      'bridge_recent_events_failure',
      { phase: 'helper_unexpected_catch' },
      downstreamError,
    );
    spy.mockRestore();
  });

  it('groups the last limit entries per kind', async () => {
    installReader([
      cooldownEnter(100),
      cooldownEnter(200),
      cooldownEnter(300),
      abortEvent(400),
      abortEvent(500),
      knownCondition(600),
      knownCondition(700),
      knownCondition(800),
      knownCondition(900),
      knownCondition(1000),
      cooldownExit(1100),
    ]);

    const context = await getRecentDiagnosticContext({
      limit: 2,
      windowHours: 168,
      nowMs: 1200,
    });

    expect(context.entriesByKind['cooldown_enter']).toHaveLength(2);
    expect(context.entriesByKind['known_condition']).toHaveLength(2);
    expect(context.entriesByKind['abort_event']).toHaveLength(2);
    expect(context.entriesByKind['cooldown_exit']).toHaveLength(1);
  });

  it('returns the newest K entries per kind oldest-first, not the first K', async () => {
    installReader([10, 20, 30, 40, 50].map((ts) => cooldownEnter(ts)));

    const context = await getRecentDiagnosticContext({
      limit: 2,
      windowHours: 168,
      nowMs: 60,
    });

    expect(context.entriesByKind['cooldown_enter']?.map((event) => event.ts)).toEqual([40, 50]);
  });

  it('filters entries, counts, and lastTimes by the requested window', async () => {
    const hourMs = 3_600_000;
    const nowMs = 10 * hourMs;
    installReader([
      cooldownEnter(nowMs - 3 * hourMs),
      cooldownEnter(nowMs - hourMs),
      abortEvent(nowMs - 30_000),
    ]);

    const context = await getRecentDiagnosticContext({
      limit: 5,
      windowHours: 2,
      nowMs,
    });

    expect(context.entriesByKind['cooldown_enter']?.map((event) => event.ts)).toEqual([
      nowMs - hourMs,
    ]);
    expect(context.entriesByKind['abort_event']?.map((event) => event.ts)).toEqual([
      nowMs - 30_000,
    ]);
    expect(context.counts).toEqual({ cooldown_enter: 1, abort_event: 1 });
    expect(context.lastTimes).toEqual({ cooldown_enter: nowMs - hourMs, abort_event: nowMs - 30_000 });
    expect(context.totalEvents).toBe(2);
  });

  it('filters out future-stamped events from entries, counts, and lastTimes', async () => {
    installReader([
      cooldownEnter(500),
      cooldownEnter(999),
      cooldownEnter(1001),
      cooldownEnter(2000),
    ]);

    const context = await getRecentDiagnosticContext({
      limit: 5,
      windowHours: 1,
      nowMs: 1000,
    });

    expect(context.entriesByKind['cooldown_enter']?.map((event) => event.ts)).toEqual([500, 999]);
    expect(context.counts).toEqual({ cooldown_enter: 2 });
    expect(context.lastTimes).toEqual({ cooldown_enter: 999 });
    expect(context.totalEvents).toBe(2);
  });

  it('clamps limit and windowHours while defaulting negative values', async () => {
    installReader([cooldownEnter(1)]);

    await expect(getRecentDiagnosticContext({ limit: 99, nowMs: NOW_MS })).resolves.toMatchObject({
      limit: 20,
    });
    await expect(getRecentDiagnosticContext({ limit: 5.7, nowMs: NOW_MS })).resolves.toMatchObject({
      limit: 5,
    });
    await expect(getRecentDiagnosticContext({ limit: 0, nowMs: NOW_MS })).resolves.toMatchObject({
      limit: 1,
    });
    await expect(
      getRecentDiagnosticContext({ windowHours: 10_000, nowMs: NOW_MS }),
    ).resolves.toMatchObject({
      windowHours: 168,
    });
    await expect(getRecentDiagnosticContext({ windowHours: 0, nowMs: NOW_MS })).resolves.toMatchObject({
      windowHours: 1,
    });
    await expect(
      getRecentDiagnosticContext({ limit: -10, windowHours: -5, nowMs: NOW_MS }),
    ).resolves.toMatchObject({
      limit: 5,
      windowHours: 24,
    });
  });

  it('uses injected nowMs deterministically and reads the existing ledger caps', async () => {
    const readRecent = installReader([cooldownEnter(NOW_MS - 1)]);

    const context = await getRecentDiagnosticContext({ nowMs: NOW_MS });

    expect(context.nowMs).toBe(NOW_MS);
    expect(readRecent).toHaveBeenCalledWith({
      limit: MAX_DIAGNOSTIC_EVENTS,
      maxBytes: MAX_DIAGNOSTIC_EVENTS_BYTES,
    });
  });
});

function installReader(events: DiagnosticEventEntry[]) {
  const readRecent = vi.fn(async (_options: { limit: number; maxBytes: number }) => events);
  setDiagnosticEventsLedgerReader({ readRecent });
  return readRecent;
}

function cooldownEnter(ts: number): DiagnosticEventEntry {
  return {
    ...baseEvent(ts),
    kind: 'cooldown_enter',
    data: {
      scope: 'api',
      untilMs: ts + 1000,
      retryAfterProvided: false,
      durationMs: 1000,
    },
  };
}

function cooldownExit(ts: number): DiagnosticEventEntry {
  return {
    ...baseEvent(ts),
    kind: 'cooldown_exit',
    data: {
      scope: 'api',
      reason: 'success',
    },
  };
}

function abortEvent(ts: number): DiagnosticEventEntry {
  return {
    ...baseEvent(ts),
    kind: 'abort_event',
    data: {
      reason: 'user_cancel',
      durationBucketMs: 1_000,
    },
  };
}

function knownCondition(
  ts: number,
  level: Extract<DiagnosticEventEntry, { kind: 'known_condition' }>['data']['level'] = 'warning',
): DiagnosticEventEntry {
  return {
    ...baseEvent(ts),
    kind: 'known_condition',
    data: {
      condition: 'model_error',
      level,
    },
  };
}

function baseEvent(ts: number) {
  return {
    v: DIAGNOSTIC_EVENT_SCHEMA_VERSION,
    ts,
    surface: 'desktop' as const,
  };
}
