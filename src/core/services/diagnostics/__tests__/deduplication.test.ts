import { describe, it, expect, vi } from 'vitest';
import { deduplicateLogs, formatTimeShort, getLogLevel, parseLogTimestamp, processLogEntry, truncateBreadcrumbs } from '../deduplication';

describe('diagnostics deduplication helpers', () => {
  it('parses NDJSON timestamps and ignores invalid lines', () => {
    expect(parseLogTimestamp('{"time":"2026-01-01T00:00:00.000Z"}')?.toISOString()).toBe('2026-01-01T00:00:00.000Z');
    expect(parseLogTimestamp('not-json')).toBeNull();
  });
  it('extracts pino numeric levels', () => {
    expect(getLogLevel('{"level":40}')).toBe(40);
    expect(getLogLevel('{"level":"warn"}')).toBeNull();
  });
  it('formats short time labels', () => {
    expect(formatTimeShort(new Date('2026-01-01T09:45:00.000Z'))).toMatch(/^\d{2}:\d{2}$/);
  });
  it('truncates long breadcrumb arrays with an omission marker', () => {
    expect(truncateBreadcrumbs([1, 2, 3, 4, 5, 6, 7])).toEqual([1, 2, 3, '...(2 more)...', 6, 7]);
  });
  it('processes log entries by truncating breadcrumbs only when present', () => {
    expect(JSON.parse(processLogEntry(JSON.stringify({ breadcrumbs: [1,2,3,4,5,6,7] }))).breadcrumbs).toContain('...(2 more)...');
    expect(processLogEntry('not-json')).toBe('not-json');
  });
  it('deduplicates consecutive messages while preserving non-consecutive repeats', () => {
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
    const lines = [
      { time: '2026-01-01T00:00:00.000Z', msg: 'same', level: 30 },
      { time: '2026-01-01T00:01:00.000Z', msg: 'same', level: 30 },
      { time: '2026-01-01T00:02:00.000Z', msg: 'other', level: 30 },
      { time: '2026-01-01T00:03:00.000Z', msg: 'same', level: 30 },
    ].map((entry) => JSON.stringify(entry));
    const result = deduplicateLogs(lines).map((line) => JSON.parse(line).msg);
    expect(result[0]).toContain('same (x2,');
    expect(result).toHaveLength(3);
  });
});
