import { describe, it, expect, vi, afterEach } from 'vitest';
import { deriveStatus, SUMMARY_STALE_TURN_THRESHOLD_MS } from '../useSessionHistoryView';

describe('deriveStatus', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns thinking when busy', () => {
    expect(deriveStatus(true, true)).toBe('thinking');
    expect(deriveStatus(true, false)).toBe('thinking');
  });

  it('returns ready when not busy but has messages', () => {
    expect(deriveStatus(false, true)).toBe('ready');
  });

  it('returns idle when not busy and no messages', () => {
    expect(deriveStatus(false, false)).toBe('idle');
  });

  it('returns thinking when busy with recent lastActivityAt', () => {
    const recentActivity = Date.now() - 60_000; // 1 minute ago
    expect(deriveStatus(true, true, recentActivity)).toBe('thinking');
    expect(deriveStatus(true, false, recentActivity)).toBe('thinking');
  });

  it('returns ready (not thinking) when busy but lastActivityAt exceeds stale timeout and has messages', () => {
    vi.useFakeTimers();
    const now = Date.now();
    vi.setSystemTime(now);

    const staleActivity = now - SUMMARY_STALE_TURN_THRESHOLD_MS - 1;
    expect(deriveStatus(true, true, staleActivity)).toBe('ready');
  });

  it('returns idle (not thinking) when busy but lastActivityAt exceeds stale timeout and no messages', () => {
    vi.useFakeTimers();
    const now = Date.now();
    vi.setSystemTime(now);

    const staleActivity = now - SUMMARY_STALE_TURN_THRESHOLD_MS - 1;
    expect(deriveStatus(true, false, staleActivity)).toBe('idle');
  });

  it('still returns thinking when lastActivityAt is exactly at the timeout boundary', () => {
    vi.useFakeTimers();
    const now = Date.now();
    vi.setSystemTime(now);

    const boundaryActivity = now - SUMMARY_STALE_TURN_THRESHOLD_MS;
    expect(deriveStatus(true, true, boundaryActivity)).toBe('thinking');
  });

  it('ignores staleness timestamp when not busy', () => {
    const staleActivity = Date.now() - SUMMARY_STALE_TURN_THRESHOLD_MS - 1;
    expect(deriveStatus(false, true, staleActivity)).toBe('ready');
    expect(deriveStatus(false, false, staleActivity)).toBe('idle');
  });

  it('treats missing lastActivityAt as non-stale (backwards compatibility)', () => {
    expect(deriveStatus(true, true, undefined)).toBe('thinking');
    expect(deriveStatus(true, false, undefined)).toBe('thinking');
  });
});
