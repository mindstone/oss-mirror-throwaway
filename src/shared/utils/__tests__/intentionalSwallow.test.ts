import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(async () => {
  vi.restoreAllMocks();
  vi.resetModules();
});

describe('ignoreBestEffortCleanup', () => {
  it('emits through injected main-process sinks', async () => {
    const {
      ignoreBestEffortCleanup,
      setIntentionalSwallowSinks,
    } = await import('../intentionalSwallow');
    const log = vi.fn();
    const breadcrumb = vi.fn();
    const error = new Error('cleanup failed');

    setIntentionalSwallowSinks({ log, breadcrumb });
    ignoreBestEffortCleanup(error, {
      operation: 'test cleanup',
      reason: 'optional test cleanup can fail without changing outcome',
      owner: 'test',
      severity: 'warn',
    });

    expect(log).toHaveBeenCalledWith(
      'warn',
      'Intentionally swallowed best-effort failure: test cleanup',
      expect.objectContaining({
        operation: 'test cleanup',
        reason: 'optional test cleanup can fail without changing outcome',
        owner: 'test',
        severity: 'warn',
        errorName: 'Error',
        errorMessage: 'cleanup failed',
      }),
    );
    expect(breadcrumb).toHaveBeenCalledWith(
      'Intentionally swallowed best-effort failure: test cleanup',
      expect.objectContaining({
        operation: 'test cleanup',
        reason: 'optional test cleanup can fail without changing outcome',
      }),
    );
  });

  it('uses renderer-safe default sinks when no main sinks are injected', async () => {
    const debugSpy = vi.spyOn(console, 'debug').mockImplementation(() => {});
    const {
      ignoreBestEffortCleanup,
      setIntentionalSwallowSinks,
    } = await import('../intentionalSwallow');

    setIntentionalSwallowSinks(null);

    expect(() => {
      ignoreBestEffortCleanup('minor cleanup failure', {
        operation: 'renderer cleanup',
        reason: 'best-effort renderer disposal',
      });
    }).not.toThrow();
    expect(debugSpy).toHaveBeenCalledWith(
      'Intentionally swallowed best-effort failure: renderer cleanup',
      expect.objectContaining({
        operation: 'renderer cleanup',
        reason: 'best-effort renderer disposal',
        severity: 'debug',
        errorValue: 'minor cleanup failure',
      }),
    );
  });

  it('still attempts breadcrumb when injected log sink throws', async () => {
    const {
      ignoreBestEffortCleanup,
      setIntentionalSwallowSinks,
    } = await import('../intentionalSwallow');
    const breadcrumb = vi.fn();
    setIntentionalSwallowSinks({
      log: () => {
        throw new Error('log sink failed');
      },
      breadcrumb,
    });

    expect(() => {
      ignoreBestEffortCleanup(new Error('original cleanup failed'), {
        operation: 'faulty log sink cleanup',
        reason: 'log sink failure must not silence the breadcrumb channel',
      });
    }).not.toThrow();
    expect(breadcrumb).toHaveBeenCalledOnce();
  });

  it('does not throw when both sinks throw', async () => {
    const {
      ignoreBestEffortCleanup,
      setIntentionalSwallowSinks,
    } = await import('../intentionalSwallow');
    setIntentionalSwallowSinks({
      log: () => {
        throw new Error('log sink failed');
      },
      breadcrumb: () => {
        throw new Error('breadcrumb sink failed');
      },
    });

    expect(() => {
      ignoreBestEffortCleanup(new Error('original cleanup failed'), {
        operation: 'faulty both-sinks cleanup',
        reason: 'both sinks failing must not resurrect the cleanup error',
      });
    }).not.toThrow();
  });

  it('does not throw on hostile error or context inputs', async () => {
    const {
      ignoreBestEffortCleanup,
      setIntentionalSwallowSinks,
    } = await import('../intentionalSwallow');
    setIntentionalSwallowSinks(null);
    vi.spyOn(console, 'debug').mockImplementation(() => {});

    const hostileError: unknown = Object.create(null);
    const throwingToString: unknown = {
      toString: () => {
        throw new Error('toString blew up');
      },
    };
    const throwingGetter: unknown = Object.defineProperty({}, 'operation', {
      get: () => {
        throw new Error('getter blew up');
      },
    });

    expect(() => ignoreBestEffortCleanup(hostileError, {
      operation: 'hostile-error cleanup',
      reason: 'null-prototype error must not crash helper',
    })).not.toThrow();

    expect(() => ignoreBestEffortCleanup(throwingToString, {
      operation: 'throwing-toString cleanup',
      reason: 'errors with hostile toString must not crash helper',
    })).not.toThrow();

    expect(() => ignoreBestEffortCleanup(
      new Error('cleanup failure'),
      throwingGetter as never,
    )).not.toThrow();

    expect(() => ignoreBestEffortCleanup(
      new Error('cleanup failure'),
      null as never,
    )).not.toThrow();

    expect(() => ignoreBestEffortCleanup(
      new Error('cleanup failure'),
      {} as never,
    )).not.toThrow();
  });

  it('does not recurse when a sink itself calls the helper (reentry guard)', async () => {
    const {
      ignoreBestEffortCleanup,
      setIntentionalSwallowSinks,
    } = await import('../intentionalSwallow');

    let outerLogCalls = 0;
    let breadcrumbCalls = 0;

    setIntentionalSwallowSinks({
      log: () => {
        outerLogCalls += 1;
      },
      breadcrumb: () => {
        breadcrumbCalls += 1;
        ignoreBestEffortCleanup(new Error('nested cleanup'), {
          operation: 'nested-sink-cleanup',
          reason: 'a breadcrumb sink that itself swallows must not recurse into the helper',
        });
      },
    });

    expect(() => {
      ignoreBestEffortCleanup(new Error('outer cleanup'), {
        operation: 'reentry-guard-test',
        reason: 'verify reentry guard prevents recordMainBreadcrumb-style infinite recursion',
      });
    }).not.toThrow();

    expect(outerLogCalls).toBe(1);
    expect(breadcrumbCalls).toBe(1);
  });

  it('loads without resolving Node-only logger or Sentry modules', async () => {
    vi.doMock('@core/logger', () => {
      throw new Error('Cannot find module @core/logger');
    });
    vi.doMock('@sentry/electron/main', () => {
      throw new Error('Cannot find module @sentry/electron/main');
    });

    await expect(import('../intentionalSwallow')).resolves.toHaveProperty(
      'ignoreBestEffortCleanup',
    );
  });
});
