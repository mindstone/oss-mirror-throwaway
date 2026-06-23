import { afterEach, describe, expect, it } from 'vitest';
import { addToLogBuffer, clearLogBuffer, getRecentLogs } from '../logBuffer';

/**
 * Capture-context regression guard (docs/plans/260621_monitoring-capture-surface).
 *
 * The Sentry capture paths (src/main/sentry.ts) attach `getRecentLogs()` with
 * the DEFAULT window. Previously that default was 10 seconds — far too little
 * context, which is why nearly every serious incident had to be diagnosed from
 * the user's full .zip rather than the Sentry event. These tests pin the
 * enlarged window/retention so a future edit can't silently shrink it back.
 *
 * The first test is RED against the old 10s default and GREEN after the change.
 */
describe('logBuffer capture-context window', () => {
  afterEach(() => clearLogBuffer());

  it('retains logs older than 10s (the old window) up to several minutes', () => {
    const now = Date.now();
    addToLogBuffer({ timestamp: now - 4 * 60_000, level: 'info', message: 'four-minutes-ago' });
    addToLogBuffer({ timestamp: now - 30_000, level: 'warn', message: 'thirty-seconds-ago' });
    addToLogBuffer({ timestamp: now - 1_000, level: 'error', message: 'one-second-ago' });

    const messages = getRecentLogs().map((e) => e.message);

    // RED on the old 10s default (would drop the 30s + 4min entries).
    expect(messages).toContain('thirty-seconds-ago');
    expect(messages).toContain('four-minutes-ago');
    expect(messages).toContain('one-second-ago');
  });

  it('still excludes entries older than the window', () => {
    const now = Date.now();
    addToLogBuffer({ timestamp: now - 10 * 60_000, level: 'info', message: 'ten-minutes-ago' });
    addToLogBuffer({ timestamp: now - 1_000, level: 'info', message: 'recent' });

    const messages = getRecentLogs().map((e) => e.message);

    expect(messages).toContain('recent');
    expect(messages).not.toContain('ten-minutes-ago');
  });

  it('retains far more than 200 entries (the old cap)', () => {
    const now = Date.now();
    for (let i = 0; i < 900; i++) {
      addToLogBuffer({ timestamp: now - i * 100, level: 'info', message: `entry-${i}` });
    }
    // All 900 are within the 5-minute window (900 * 100ms = 90s) and under the
    // 1000-entry cap, so none should have been evicted.
    expect(getRecentLogs().length).toBe(900);
  });
});
