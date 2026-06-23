import { describe, expect, it } from 'vitest';

import {
  DIAGNOSTIC_EVENT_SCHEMA_VERSION,
  type DiagnosticEventEntry,
} from '../manifest';
import type { RecentDiagnosticContext } from '../recentDiagnosticContext';
import { formatRecentDiagnosticEvents } from '../recentEventsFormatter';

describe('formatRecentDiagnosticEvents', () => {
  it('renders sorted per-kind sections for a 3+2+5 fixture', () => {
    const ctx = context({
      limit: 5,
      entriesByKind: {
        cooldown_enter: [cooldownEnter(100), cooldownEnter(200), cooldownEnter(300)],
        abort_event: [abortEvent(400), abortEvent(500)],
        known_condition: [
          knownCondition(600),
          knownCondition(700),
          knownCondition(800),
          knownCondition(900),
          knownCondition(1000),
        ],
      },
      counts: {
        cooldown_enter: 3,
        abort_event: 2,
        known_condition: 5,
      },
      lastTimes: {
        cooldown_enter: 300,
        abort_event: 500,
        known_condition: 1000,
      },
      totalEvents: 10,
    });

    const { markdown, entryCount } = formatRecentDiagnosticEvents(ctx);

    expect(entryCount).toBe(10);
    expect(markdown).toContain('### Per-kind counts');
    expect(markdown).toContain('### Last 5 entries per kind');
    expect(markdown).toContain('#### abort_event (2 in window)');
    expect(markdown).toContain('#### cooldown_enter (3 in window)');
    expect(markdown).toContain('#### known_condition (5 in window)');
    expect(markdown.indexOf('| abort_event | 2 |')).toBeLessThan(
      markdown.indexOf('| cooldown_enter | 3 |'),
    );
    expect(markdown.indexOf('| cooldown_enter | 3 |')).toBeLessThan(
      markdown.indexOf('| known_condition | 5 |'),
    );
  });

  it('renders a limit=2 context as a per-kind cap', () => {
    const ctx = context({
      limit: 2,
      entriesByKind: {
        cooldown_enter: [cooldownEnter(400), cooldownEnter(500)],
        known_condition: [knownCondition(900), knownCondition(1000)],
      },
      counts: {
        cooldown_enter: 5,
        known_condition: 5,
      },
      lastTimes: {
        cooldown_enter: 500,
        known_condition: 1000,
      },
      totalEvents: 10,
    });

    const { markdown } = formatRecentDiagnosticEvents(ctx);

    expect(markdown).toContain('### Last 2 entries per kind');
    expect(markdown.match(/kind":"cooldown_enter/g)).toBeNull();
    expect(markdown.match(/scope":"api/g)).toHaveLength(2);
    expect(markdown.match(/condition":"model_error/g)).toHaveLength(2);
  });

  it('renders the last K entries, not the first K entries', () => {
    const ctx = context({
      limit: 2,
      entriesByKind: {
        cooldown_enter: [cooldownEnter(40), cooldownEnter(50)],
      },
      counts: { cooldown_enter: 5 },
      lastTimes: { cooldown_enter: 50 },
      totalEvents: 5,
    });

    const { markdown } = formatRecentDiagnosticEvents(ctx);

    expect(markdown).toContain('1970-01-01T00:00:00.040Z');
    expect(markdown).toContain('1970-01-01T00:00:00.050Z');
    expect(markdown).not.toContain('1970-01-01T00:00:00.010Z');
    expect(markdown).not.toContain('1970-01-01T00:00:00.020Z');
  });

  it('renders the exact empty-state line when no counts exist', () => {
    const { markdown } = formatRecentDiagnosticEvents(
      context({
        windowHours: 24,
        counts: null,
        lastTimes: null,
        entriesByKind: {},
        totalEvents: 0,
      }),
    );

    expect(markdown).toContain('All quiet. Nothing notable in the last 24h.');
  });

  it('renders the ring-buffer explanation when counts exist but the window is empty', () => {
    const { markdown } = formatRecentDiagnosticEvents(
      context({
        counts: { cooldown_enter: 2 },
        lastTimes: { cooldown_enter: 100 },
        entriesByKind: {},
        totalEvents: 0,
      }),
    );

    expect(markdown).toContain(
      'Per-kind counts above span the ring buffer; no entries fell within the requested window.',
    );
  });

  it('renders timestamps in deterministic UTC ISO format', () => {
    const { markdown } = formatRecentDiagnosticEvents(
      context({
        entriesByKind: { abort_event: [abortEvent(1_700_000_000_000)] },
        counts: { abort_event: 1 },
        lastTimes: { abort_event: 1_700_000_000_000 },
        totalEvents: 1,
      }),
    );

    expect(markdown).toContain('2023-11-14T22:13:20.000Z');
  });

  it('defangs triple backticks in data JSON', () => {
    const event = {
      ...knownCondition(100),
      data: { description: 'sneaky ```code```' },
    } as unknown as DiagnosticEventEntry;

    const { markdown } = formatRecentDiagnosticEvents(
      context({
        entriesByKind: { known_condition: [event] },
        counts: { known_condition: 1 },
        lastTimes: { known_condition: 100 },
        totalEvents: 1,
      }),
    );

    expect(markdown).not.toContain('```');
    expect(markdown).toContain('`‍`‍`‍code`‍`‍`‍');
  });
});

function context(overrides: Partial<RecentDiagnosticContext>): RecentDiagnosticContext {
  return {
    windowHours: 24,
    limit: 5,
    nowMs: 2_000,
    counts: null,
    lastTimes: null,
    entriesByKind: {},
    totalEvents: 0,
    readerAvailable: true,
    ...overrides,
  };
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

function knownCondition(ts: number): DiagnosticEventEntry {
  return {
    ...baseEvent(ts),
    kind: 'known_condition',
    data: {
      condition: 'model_error',
      level: 'warning',
    },
  };
}

function baseEvent(ts: number) {
  return {
    v: DIAGNOSTIC_EVENT_SCHEMA_VERSION,
    ts,
    surface: 'desktop' as const,
    tid: 'turn_1',
    sid: 'session_1',
  };
}
