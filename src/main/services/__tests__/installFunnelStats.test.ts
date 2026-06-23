import { afterEach, describe, expect, it, vi } from 'vitest';
import { setErrorReporter } from '@core/errorReporter';
import { createInstallFunnelStats, installFunnelStats } from '../installFunnelStats';

function createReporter(addBreadcrumb = vi.fn()) {
  return {
    addBreadcrumb,
    captureException: vi.fn(),
    captureMessage: vi.fn(),
  };
}

afterEach(() => {
  setErrorReporter(createReporter());
  installFunnelStats.resetForTesting();
});

describe('installFunnelStats', () => {
  it('emits structured breadcrumbs for start events', () => {
    const addBreadcrumb = vi.fn();
    const info = vi.fn();
    const warn = vi.fn();
    const stats = createInstallFunnelStats({
      errorReporter: createReporter(addBreadcrumb),
      logger: {
        info,
        warn,
      },
    });

    stats.start('detect-browsers', { browserId: 'chrome' });

    expect(addBreadcrumb).toHaveBeenCalledWith({
      category: 'app-bridge.install',
      level: 'info',
      message: 'install.detect-browsers.start',
      data: {
        browserId: 'chrome',
        pairSessionId: undefined,
      },
    });
    expect(info).toHaveBeenCalledWith(
      {
        event: 'install.detect-browsers.start',
        browserId: 'chrome',
        pairSessionId: undefined,
        extensionIdSuffix: undefined,
      },
      'App Bridge install funnel breadcrumb',
    );
    expect(warn).not.toHaveBeenCalled();
  });

  it('emits structured breadcrumbs for end events with a reason', () => {
    const addBreadcrumb = vi.fn();
    const info = vi.fn();
    const stats = createInstallFunnelStats({
      errorReporter: createReporter(addBreadcrumb),
      logger: {
        info,
        warn: vi.fn(),
      },
    });

    stats.end(
      'detect-browsers',
      { browserId: 'chrome', pairSessionId: 'pair-1' },
      { reason: 'ok' },
    );

    expect(addBreadcrumb).toHaveBeenCalledWith({
      category: 'app-bridge.install',
      level: 'info',
      message: 'install.detect-browsers.end',
      data: {
        browserId: 'chrome',
        pairSessionId: 'pair-1',
        extensionIdSuffix: undefined,
        reason: 'ok',
      },
    });
    expect(info).toHaveBeenCalledWith(
      {
        event: 'install.detect-browsers.end',
        browserId: 'chrome',
        pairSessionId: 'pair-1',
        extensionIdSuffix: undefined,
        reason: 'ok',
      },
      'App Bridge install funnel breadcrumb',
    );
  });

  it('looks up the current reporter lazily for singleton end events', () => {
    const addBreadcrumb = vi.fn();

    setErrorReporter(createReporter());
    installFunnelStats.start('detect-browsers', {});

    setErrorReporter(createReporter(addBreadcrumb));
    installFunnelStats.end(
      'detect-browsers',
      { browserId: 'chrome' },
      { reason: 'ok' },
    );

    expect(addBreadcrumb).toHaveBeenCalledWith({
      category: 'app-bridge.install',
      level: 'info',
      message: 'install.detect-browsers.end',
      data: {
        browserId: 'chrome',
        pairSessionId: undefined,
        extensionIdSuffix: undefined,
        reason: 'ok',
      },
    });
  });

  it('swallows telemetry failures and falls back to a warn log', () => {
    const info = vi.fn();
    const warn = vi.fn();
    const stats = createInstallFunnelStats({
      errorReporter: createReporter(
        vi.fn(() => {
          throw new Error('sentry offline');
        }),
      ),
      logger: {
        info,
        warn,
      },
    });

    expect(() =>
      stats.start('detect-browsers', { browserId: 'chrome' }),
    ).not.toThrow();
    expect(info).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(
      {
        event: 'install.detect-browsers.start',
        error: 'sentry offline',
      },
      'App Bridge install funnel telemetry failed',
    );
  });

  it('enforces a server-side diagnose cooldown', () => {
    let currentTime = 1_000;
    const stats = createInstallFunnelStats({
      errorReporter: createReporter(),
      logger: { info: vi.fn(), warn: vi.fn() },
      now: () => currentTime,
      diagnoseCooldownMs: 10_000,
    });

    expect(stats.consumeDiagnoseCooldown('chrome')).toEqual({
      allowed: true,
      remainingMs: 0,
    });
    expect(stats.consumeDiagnoseCooldown('chrome')).toEqual({
      allowed: false,
      remainingMs: 10_000,
    });

    currentTime += 10_000;

    expect(stats.consumeDiagnoseCooldown('chrome')).toEqual({
      allowed: true,
      remainingMs: 0,
    });
  });

  it('queries recent breadcrumbs and evicts old entries', () => {
    let currentTime = 0;
    const stats = createInstallFunnelStats({
      errorReporter: createReporter(),
      logger: { info: vi.fn(), warn: vi.fn() },
      now: () => currentTime,
      retentionMs: 50,
      maxBreadcrumbs: 2,
    });

    stats.end('detect-browsers', { browserId: 'chrome', pairSessionId: 'pair-1' }, { reason: 'ok' });
    currentTime = 10;
    stats.end('open-extensions-page', { browserId: 'chrome', pairSessionId: 'pair-1' }, { reason: 'open-failed' });
    currentTime = 20;
    stats.end('extract-extension', { browserId: 'chrome', pairSessionId: 'pair-1' }, { reason: 'extract-failed' });

    expect(
      stats.getRecentBreadcrumbs({
        browserId: 'chrome',
        pairSessionId: 'pair-1',
        sinceMs: 1_000,
      }),
    ).toEqual({
      count: 2,
      failureCount: 2,
      lastFailureReason: 'extract-failed',
    });

    currentTime = 100;

    expect(
      stats.getRecentBreadcrumbs({
        browserId: 'chrome',
        pairSessionId: 'pair-1',
        sinceMs: 1_000,
      }),
    ).toEqual({
      count: 0,
      failureCount: 0,
      lastFailureReason: null,
    });
  });
});
