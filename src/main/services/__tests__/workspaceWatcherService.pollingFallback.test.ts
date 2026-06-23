import { describe, expect, it } from 'vitest';
import { shouldWarnPollingFallback } from '../workspaceWatcherService';

/**
 * Stage 5 — predicate for the packaged-darwin polling-fallback warning
 * (260623_fsevents-interception-regression defense-in-depth).
 *
 * We warn ONLY when a packaged macOS build resolved chokidar onto the
 * `fs.watchFile` polling backend (`useFsEvents === false`) instead of native
 * fsevents — the field signature of the regression class (high idle CPU + a
 * disarmed quit-time leak guard). Dev / non-packaged / non-darwin / healthy
 * fsevents must all stay silent.
 */
describe('shouldWarnPollingFallback', () => {
  it('warns on packaged darwin when chokidar fell back off fsevents', () => {
    expect(
      shouldWarnPollingFallback({ platform: 'darwin', packaged: true, useFsEvents: false }),
    ).toBe(true);
  });

  it('stays silent on packaged darwin when fsevents is active (healthy path)', () => {
    expect(
      shouldWarnPollingFallback({ platform: 'darwin', packaged: true, useFsEvents: true }),
    ).toBe(false);
  });

  it('stays silent on non-darwin platforms even when packaged + polling', () => {
    expect(
      shouldWarnPollingFallback({ platform: 'win32', packaged: true, useFsEvents: false }),
    ).toBe(false);
    expect(
      shouldWarnPollingFallback({ platform: 'linux', packaged: true, useFsEvents: false }),
    ).toBe(false);
  });

  it('stays silent in non-packaged (dev) builds — polling is expected there', () => {
    expect(
      shouldWarnPollingFallback({ platform: 'darwin', packaged: false, useFsEvents: false }),
    ).toBe(false);
  });

  it('stays silent when useFsEvents is undefined (backend unknown — do not over-warn)', () => {
    expect(
      shouldWarnPollingFallback({ platform: 'darwin', packaged: true, useFsEvents: undefined }),
    ).toBe(false);
  });
});
