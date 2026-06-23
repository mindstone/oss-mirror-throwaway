import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import {
  __getLogErrorReporterForTests,
  createLogger,
  setLogEnabled,
  setLogErrorReporter,
  type LogErrorReporter,
} from '../utils/logger';

/**
 * Verifies the ErrorReporter bridge behaviour introduced in Stage 0.3 of
 * docs/plans/260418_cloud_continuity_robustness_and_observability.md.
 *
 * Invariants:
 *  - warn/error forwarded as breadcrumbs
 *  - debug/info NOT forwarded (avoids flooding the 100-breadcrumb cap)
 *  - breadcrumb category is `log.<tag>` so on-call can grep per scope
 *  - breadcrumb level is mapped (warn → warning, error → error)
 *  - addBreadcrumb throwing never propagates
 *  - unsetting the reporter stops forwarding
 */

describe('cloud-client logger — ErrorReporter bridge', () => {
  let addBreadcrumb: Mock<LogErrorReporter['addBreadcrumb']>;
  let reporter: LogErrorReporter;
  let consoleSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    addBreadcrumb = vi.fn<LogErrorReporter['addBreadcrumb']>();
    reporter = { addBreadcrumb };
    setLogErrorReporter(reporter);
    setLogEnabled(true);
    // Silence console output from the logger during tests
    consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'info').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    setLogErrorReporter(null);
    consoleSpy.mockRestore();
    vi.restoreAllMocks();
  });

  it('registers and exposes the reporter to tests', () => {
    expect(__getLogErrorReporterForTests()).toBe(reporter);
  });

  it('forwards warn-level log lines as breadcrumbs with warning level', () => {
    const log = createLogger('merge');
    log.warn('session merge dropped turn', { direction: 'cloud-push' });

    expect(addBreadcrumb).toHaveBeenCalledTimes(1);
    expect(addBreadcrumb).toHaveBeenCalledWith({
      category: 'log.merge',
      level: 'warning',
      message: 'session merge dropped turn',
      data: { direction: 'cloud-push' },
    });
  });

  it('forwards error-level log lines as breadcrumbs with error level', () => {
    const log = createLogger('outbox');
    log.error('retry exhausted', { attempts: 5 });

    expect(addBreadcrumb).toHaveBeenCalledTimes(1);
    expect(addBreadcrumb).toHaveBeenCalledWith({
      category: 'log.outbox',
      level: 'error',
      message: 'retry exhausted',
      data: { attempts: 5 },
    });
  });

  it('does NOT forward info-level lines (avoids breadcrumb flooding)', () => {
    const log = createLogger('scope');
    log.info('routine heartbeat', { ok: true });
    expect(addBreadcrumb).not.toHaveBeenCalled();
  });

  it('does NOT forward debug-level lines', () => {
    const log = createLogger('scope');
    log.debug('trace info', { step: 1 });
    expect(addBreadcrumb).not.toHaveBeenCalled();
  });

  it('swallows errors thrown by addBreadcrumb', () => {
    addBreadcrumb.mockImplementationOnce(() => {
      throw new Error('sentry offline');
    });
    const log = createLogger('scope');
    expect(() => log.error('will not throw', {})).not.toThrow();
  });

  it('stops forwarding after setLogErrorReporter(null)', () => {
    const log = createLogger('scope');
    setLogErrorReporter(null);
    log.warn('should not reach breadcrumb');
    expect(addBreadcrumb).not.toHaveBeenCalled();
  });

  it('skips forwarding when logging is globally disabled', () => {
    setLogEnabled(false);
    const log = createLogger('scope');
    log.error('should not reach breadcrumb either');
    expect(addBreadcrumb).not.toHaveBeenCalled();
    setLogEnabled(true);
  });
});
