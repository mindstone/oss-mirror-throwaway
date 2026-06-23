/**
 * Regression test for logger → ErrorReporter breadcrumb forwarding.
 *
 * Verifies that logger.ts uses getErrorReporter().addBreadcrumb() to forward
 * warn/error/fatal-level log events as breadcrumbs, and that the silent no-op
 * default reporter doesn't throw when no reporter is wired.
 *
 * @see docs/plans/260330_strengthen_de_electronification.md (Stage 1a removed @main/sentry import)
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import path from 'node:path';
import os from 'node:os';

// Opt out of the global no-op logger mock (vitest.setup.ts) — these tests
// exercise the real logger module's breadcrumb forwarding implementation.
vi.unmock('@core/logger');

const TEST_LOG_DIR = path.join(os.tmpdir(), 'mindstone-test-logger-breadcrumbs');

describe('logger breadcrumb forwarding via ErrorReporter', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  /**
   * Helper: set up mocks and return fresh module instances.
   * Uses vi.doMock to intercept dataPaths so the logger writes to a temp dir
   * instead of the real user data directory.
   */
  async function setup() {
    vi.doMock('@core/utils/dataPaths', () => ({
      getDataPath: () => TEST_LOG_DIR,
      getAppVersion: () => '0.0.0-test',
    }));

    // Import both modules fresh — they share the same errorReporter singleton
    // because vitest caches modules within a single test's import graph.
    const errorReporterMod = await import('@core/errorReporter');
    const loggerMod = await import('@core/logger');

    return { errorReporterMod, loggerMod };
  }

  it('forwards warn-level logs to ErrorReporter.addBreadcrumb', async () => {
    const { errorReporterMod, loggerMod } = await setup();

    const mockReporter = {
      captureException: vi.fn(),
      captureMessage: vi.fn(),
      addBreadcrumb: vi.fn(),
    };
    errorReporterMod.setErrorReporter(mockReporter);

    loggerMod.logAtLevel('warn', 'something went wrong', { detail: 'test' });

    expect(mockReporter.addBreadcrumb).toHaveBeenCalledWith(
      expect.objectContaining({
        category: 'log',
        level: 'warning',
        message: 'something went wrong',
      }),
    );
  });

  it('forwards error-level logs to ErrorReporter.addBreadcrumb', async () => {
    const { errorReporterMod, loggerMod } = await setup();

    const mockReporter = {
      captureException: vi.fn(),
      captureMessage: vi.fn(),
      addBreadcrumb: vi.fn(),
    };
    errorReporterMod.setErrorReporter(mockReporter);

    loggerMod.logAtLevel('error', 'critical failure');

    expect(mockReporter.addBreadcrumb).toHaveBeenCalledWith(
      expect.objectContaining({
        category: 'log',
        level: 'error',
        message: 'critical failure',
      }),
    );
  });

  it('forwards fatal-level logs to ErrorReporter.addBreadcrumb', async () => {
    const { errorReporterMod, loggerMod } = await setup();

    const mockReporter = {
      captureException: vi.fn(),
      captureMessage: vi.fn(),
      addBreadcrumb: vi.fn(),
    };
    errorReporterMod.setErrorReporter(mockReporter);

    loggerMod.logAtLevel('fatal', 'process dying');

    expect(mockReporter.addBreadcrumb).toHaveBeenCalledWith(
      expect.objectContaining({
        category: 'log',
        level: 'fatal',
        message: 'process dying',
      }),
    );
  });

  it('does not throw when no reporter is wired (default silent)', async () => {
    const { loggerMod } = await setup();

    // Default reporter is the silent no-op — should not throw at any level
    expect(() => loggerMod.logAtLevel('info', 'info test')).not.toThrow();
    expect(() => loggerMod.logAtLevel('warn', 'warn test')).not.toThrow();
    expect(() => loggerMod.logAtLevel('error', 'error test')).not.toThrow();
    expect(() => loggerMod.logAtLevel('fatal', 'fatal test')).not.toThrow();
  });
});
