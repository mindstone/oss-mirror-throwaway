import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  safeParseDetail,
  safeParseDetailRecord,
  MAX_DETAIL_PARSE_BYTES,
  MAX_STRUCTURED_DETAIL_PARSE_BYTES,
} from '../safeParseDetail';
import { parseAuthRequiredSignal } from '@shared/utils/authRequiredSignal';
import { parseTasksFromDetail } from '../missionTaskExtraction';
import { humanizeToolActivity } from '../humanizeToolActivity';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('safeParseDetail', () => {
  it('parses ≤budget valid JSON → { ok: true, value }', () => {
    const result = safeParseDetail('{"a":1,"b":"x"}');
    expect(result).toEqual({ ok: true, value: { a: 1, b: 'x' } });
  });

  it('returns malformed for ≤budget invalid JSON', () => {
    const result = safeParseDetail('{not json');
    expect(result).toEqual({ ok: false, reason: 'malformed' });
  });

  it('returns malformed for a non-string input', () => {
    // @ts-expect-error — exercising the runtime guard for non-string callers.
    const result = safeParseDetail(123);
    expect(result).toEqual({ ok: false, reason: 'malformed' });
  });

  it('returns too-large for >budget input WITHOUT calling JSON.parse', () => {
    // A huge but VALID JSON string: if the guard parsed it we would get ok:true.
    // We additionally spy on JSON.parse to assert it is never invoked.
    const parseSpy = vi.spyOn(JSON, 'parse');
    const huge = `"${'a'.repeat(MAX_DETAIL_PARSE_BYTES + 10)}"`;
    expect(huge.length).toBeGreaterThan(MAX_DETAIL_PARSE_BYTES);

    const result = safeParseDetail(huge);

    expect(result).toEqual({ ok: false, reason: 'too-large' });
    expect(parseSpy).not.toHaveBeenCalled();
  });

  it('honours a custom { maxBytes } override (accepts above default, rejects above override)', () => {
    const between = `"${'a'.repeat(MAX_DETAIL_PARSE_BYTES + 10)}"`;
    expect(between.length).toBeLessThan(MAX_STRUCTURED_DETAIL_PARSE_BYTES);

    // Default budget rejects it…
    expect(safeParseDetail(between)).toEqual({ ok: false, reason: 'too-large' });
    // …but the structured budget accepts and parses it.
    const widened = safeParseDetail(between, { maxBytes: MAX_STRUCTURED_DETAIL_PARSE_BYTES });
    expect(widened.ok).toBe(true);

    // And the structured budget still rejects >1 MiB.
    const overStructured = `"${'a'.repeat(MAX_STRUCTURED_DETAIL_PARSE_BYTES + 10)}"`;
    expect(
      safeParseDetail(overStructured, { maxBytes: MAX_STRUCTURED_DETAIL_PARSE_BYTES })
    ).toEqual({ ok: false, reason: 'too-large' });
  });

  it('exposes the documented budget constants', () => {
    expect(MAX_DETAIL_PARSE_BYTES).toBe(256 * 1024);
    expect(MAX_STRUCTURED_DETAIL_PARSE_BYTES).toBe(1024 * 1024);
  });
});

describe('safeParseDetailRecord', () => {
  it('returns { ok: true, value } for a plain object', () => {
    const result = safeParseDetailRecord('{"a":1,"b":"x"}');
    expect(result).toEqual({ ok: true, value: { a: 1, b: 'x' } });
  });

  // Regression for F1: valid JSON that is NOT a plain object must take the SAME
  // fallback as a parse failure (pre-migration, downstream property access on
  // these values threw a TypeError inside the call site's try/catch). A throw
  // here would crash the migrated call sites that dereference value as a Record.
  it.each([
    ['null', 'null'],
    ['a number', '42'],
    ['an array', '[1,2,3]'],
    ['a string literal', '"s"'],
    ['a boolean', 'true'],
  ])('returns malformed (no throw) for valid-but-non-object JSON: %s', (_label, input) => {
    expect(() => safeParseDetailRecord(input)).not.toThrow();
    expect(safeParseDetailRecord(input)).toEqual({ ok: false, reason: 'malformed' });
  });

  it('returns malformed for ≤budget invalid JSON', () => {
    expect(safeParseDetailRecord('{not json')).toEqual({ ok: false, reason: 'malformed' });
  });

  it('returns too-large for >budget input WITHOUT calling JSON.parse', () => {
    const parseSpy = vi.spyOn(JSON, 'parse');
    const huge = `"${'a'.repeat(MAX_DETAIL_PARSE_BYTES + 10)}"`;
    expect(safeParseDetailRecord(huge)).toEqual({ ok: false, reason: 'too-large' });
    expect(parseSpy).not.toHaveBeenCalled();
  });

  it('honours a custom { maxBytes } override for record-shaped values', () => {
    const obj = `{"pad":"${'a'.repeat(MAX_DETAIL_PARSE_BYTES + 10)}"}`;
    expect(obj.length).toBeGreaterThan(MAX_DETAIL_PARSE_BYTES);
    expect(obj.length).toBeLessThan(MAX_STRUCTURED_DETAIL_PARSE_BYTES);
    // Default budget rejects…
    expect(safeParseDetailRecord(obj)).toEqual({ ok: false, reason: 'too-large' });
    // …structured budget accepts and returns the record.
    const widened = safeParseDetailRecord(obj, { maxBytes: MAX_STRUCTURED_DETAIL_PARSE_BYTES });
    expect(widened.ok).toBe(true);
  });
});

// Hot-site regression: a migrated call site fed `detail: "null"` must take its
// pre-migration fallback (no throw). humanizeToolActivity is the call site that
// lives in this package and dereferences record keys off the parsed detail.
describe('hot-site regression: humanizeToolActivity with non-object detail', () => {
  it.each(['null', '42', '[]', '"s"'])(
    'does not throw and falls back for read with detail %s',
    (detail) => {
      let label = '';
      expect(() => {
        label = humanizeToolActivity('read', detail);
      }).not.toThrow();
      // Falls back to the generic "Reading a file" (no basename extracted),
      // exactly as a parse failure would have done pre-migration.
      expect(label).toBe('Reading a file');
    }
  );

  it.each(['null', '42', '[]'])(
    'does not throw and falls back for an agent tool with detail %s',
    (detail) => {
      let label = '';
      expect(() => {
        label = humanizeToolActivity('agent', detail);
      }).not.toThrow();
      expect(label).toBe('Delegating to a sub-agent');
    }
  );
});

describe('wrapper-shaped regression: parseAuthRequiredSignal', () => {
  const buildAuthDetail = (padBytes: number) =>
    JSON.stringify({
      action: 'auth_required',
      package_id: 'slack',
      auth_tool: 'slack_auth',
      reason: 'not_connected',
      ...(padBytes > 0 ? { pad: 'x'.repeat(padBytes) } : {}),
    });

  const buildEndEvent = (detail: string) =>
    ({ type: 'tool', stage: 'end', detail, timestamp: 0 } as never);

  it('returns null for an over-budget detail without an unbounded parse', () => {
    const parseSpy = vi.spyOn(JSON, 'parse');
    const detail = buildAuthDetail(MAX_DETAIL_PARSE_BYTES);
    expect(detail.length).toBeGreaterThan(MAX_DETAIL_PARSE_BYTES);

    const result = parseAuthRequiredSignal(buildEndEvent(detail), 'turn-1');

    expect(result).toBeNull();
    expect(parseSpy).not.toHaveBeenCalled();
  });

  it('still parses an in-budget auth_required signal', () => {
    const result = parseAuthRequiredSignal(buildEndEvent(buildAuthDetail(0)), 'turn-1');
    expect(result).not.toBeNull();
    expect(result?.packageId).toBe('slack');
  });
});

describe('structured-extractor regression: parseTasksFromDetail (1 MiB budget)', () => {
  const buildSnapshot = (padBytes: number) =>
    JSON.stringify({
      tasks: [{ id: 't1', title: 'Do thing', status: 'in_progress' }],
      pad: 'x'.repeat(padBytes),
    });

  it('parses a >256 KiB but <1 MiB structured snapshot (structured budget keeps it)', () => {
    const detail = buildSnapshot(300 * 1024);
    expect(detail.length).toBeGreaterThan(MAX_DETAIL_PARSE_BYTES);
    expect(detail.length).toBeLessThan(MAX_STRUCTURED_DETAIL_PARSE_BYTES);

    const tasks = parseTasksFromDetail(detail, 'TaskList');
    expect(tasks).toHaveLength(1);
    expect(tasks[0]?.id).toBe('t1');
  });

  it('declines a >1 MiB snapshot (degrades to the empty fallback, no unbounded parse)', () => {
    const parseSpy = vi.spyOn(JSON, 'parse');
    const detail = buildSnapshot(MAX_STRUCTURED_DETAIL_PARSE_BYTES);
    expect(detail.length).toBeGreaterThan(MAX_STRUCTURED_DETAIL_PARSE_BYTES);

    const tasks = parseTasksFromDetail(detail, 'TaskList');
    expect(tasks).toEqual([]);
    expect(parseSpy).not.toHaveBeenCalled();
  });
});
