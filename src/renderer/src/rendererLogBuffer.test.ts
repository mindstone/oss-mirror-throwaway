import { afterEach, describe, expect, it } from 'vitest';
import {
  addToRendererLogBuffer,
  clearRendererLogBuffer,
  getRecentRendererLogs,
} from './rendererLogBuffer';

/**
 * Stage 4 (docs/plans/260621_monitoring-capture-surface) — the renderer
 * attaches NO logs to its Sentry events today. This buffer is the renderer
 * counterpart of src/core/logBuffer.ts; these tests pin its window/retention so
 * a renderer capture carries meaningful recent context.
 */
describe('rendererLogBuffer', () => {
  afterEach(() => clearRendererLogBuffer());

  it('retains entries within the ~5-minute window, oldest first', () => {
    const now = Date.now();
    addToRendererLogBuffer({ timestamp: now - 4 * 60_000, level: 'info', message: 'four-minutes-ago' });
    addToRendererLogBuffer({ timestamp: now - 30_000, level: 'warn', message: 'thirty-seconds-ago' });
    addToRendererLogBuffer({ timestamp: now - 1_000, level: 'error', message: 'one-second-ago' });

    const messages = getRecentRendererLogs().map((e) => e.message);
    expect(messages).toEqual(['four-minutes-ago', 'thirty-seconds-ago', 'one-second-ago']);
  });

  it('excludes entries older than the window', () => {
    const now = Date.now();
    addToRendererLogBuffer({ timestamp: now - 10 * 60_000, level: 'info', message: 'ten-minutes-ago' });
    addToRendererLogBuffer({ timestamp: now - 1_000, level: 'info', message: 'recent' });

    const messages = getRecentRendererLogs().map((e) => e.message);
    expect(messages).toContain('recent');
    expect(messages).not.toContain('ten-minutes-ago');
  });

  it('preserves the context payload for attachment', () => {
    const now = Date.now();
    addToRendererLogBuffer({
      timestamp: now - 500,
      level: 'error',
      message: 'with-context',
      context: { turnId: 'abc', code: 42 },
    });
    const [entry] = getRecentRendererLogs();
    expect(entry?.context).toEqual({ turnId: 'abc', code: 42 });
  });

  it('retains more than the old 200-entry main cap (up to 1000) and evicts beyond', () => {
    const now = Date.now();
    for (let i = 0; i < 1200; i++) {
      // All within the 5-minute window (1200 * 10ms = 12s).
      addToRendererLogBuffer({ timestamp: now - i * 10, level: 'info', message: `entry-${i}` });
    }
    // Bounded ring keeps at most 1000 entries.
    expect(getRecentRendererLogs().length).toBe(1000);
  });
});
