import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { generateLogSummary, generateTopicTags, parseLogLine } from '../logSummary';

describe('diagnostics log summary helpers', () => {
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z')); });
  afterEach(() => vi.useRealTimers());
  it('parses valid log lines and ignores invalid lines', () => {
    expect(parseLogLine('{"level":50,"msg":"boom","time":"2026-01-01T00:00:00.000Z"}')?.msg).toBe('boom');
    expect(parseLogLine('not-json')).toBeNull();
  });
  it('generates topic tags from messages and service fields', () => {
    expect(generateTopicTags([{ msg: 'mcp startup', level: 30, time: '2026-01-01T00:00:00.000Z', raw: { service: 'auth' } }])).toEqual(['auth', 'mcp', 'startup']);
  });
  it('summarises main log files with counts and time window', () => {
    const summary = generateLogSummary([{ filename: 'main.log', content: '{"level":50,"msg":"boom","time":"2026-01-01T00:00:00.000Z"}', lineCount: 1 }], []);
    expect(summary.files[0].errorCount).toBe(1);
    expect(summary.timeWindow.start).toBe('2026-01-01T00:00:00.000Z');
  });
  it('summarises turn logs under sessions paths', () => {
    const summary = generateLogSummary([], [{ filename: 'turn.log', content: '{"level":40,"msg":"warn","time":"2026-01-01T00:00:00.000Z"}', sizeBytes: 10 }]);
    expect(summary.files[0].name).toBe('sessions/turn.log');
    expect(summary.files[0].warnCount).toBe(1);
  });
  it('deduplicates error patterns by message', () => {
    const content = ['{"level":50,"msg":"same","time":"2026-01-01T00:00:00.000Z"}', '{"level":50,"msg":"same","time":"2026-01-01T00:01:00.000Z"}'].join('\n');
    expect(generateLogSummary([{ filename: 'main.log', content, lineCount: 2 }], []).errorPatterns[0].count).toBe(2);
  });
  it('redacts sample entries before inclusion', () => {
    const summary = generateLogSummary([{ filename: 'main.log', content: '{"level":50,"msg":"boom","apiKey":"sk-ant-abcdefghijklmnopqrstuvwxyz","time":"2026-01-01T00:00:00.000Z"}', lineCount: 1 }], []);
    expect(JSON.stringify(summary.errorPatterns[0].sampleEntry)).toContain('REDACTED');
  });
});
