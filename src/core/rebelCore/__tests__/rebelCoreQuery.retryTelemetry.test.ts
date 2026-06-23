import { beforeEach, describe, expect, it, vi } from 'vitest';

const loggerMocks = vi.hoisted(() => ({
  info: vi.fn(),
  warn: vi.fn(),
  debug: vi.fn(),
  error: vi.fn(),
  trace: vi.fn(),
  fatal: vi.fn(),
}));

 
vi.mock('@core/logger', () => ({
  createScopedLogger: () => ({
    info: loggerMocks.info,
    warn: loggerMocks.warn,
    debug: loggerMocks.debug,
    error: loggerMocks.error,
    trace: loggerMocks.trace,
    fatal: loggerMocks.fatal,
  }),
  // logProviderRetryTelemetry now reads the active turn context to record a
  // scope-aware per-turn retry observation; no turn context in this unit test.
  getTurnContext: () => undefined,
}));

import { logProviderRetryTelemetry } from '../rebelCoreQuery';

describe('rebelCoreQuery retry telemetry', () => {
  beforeEach(() => {
    loggerMocks.info.mockClear();
    loggerMocks.warn.mockClear();
    loggerMocks.debug.mockClear();
    loggerMocks.error.mockClear();
    loggerMocks.trace.mockClear();
    loggerMocks.fatal.mockClear();
  });

  it('logs provider:retry-attempt with structured retry metadata', () => {
    logProviderRetryTelemetry(
      {
        attempt: 2,
        maxRetries: 3,
        provider: 'Anthropic',
        errorKind: 'server_error',
        delayMs: 2_000,
      },
      'executor',
    );

    expect(loggerMocks.warn).toHaveBeenCalledWith(
      {
        attempt: 2,
        maxRetries: 3,
        provider: 'Anthropic',
        errorKind: 'server_error',
        delayMs: 2_000,
        callsite: 'executor',
      },
      'provider:retry-attempt',
    );
  });

  it('logs provider:rate-limit-429 when retry errorKind is rate_limit', () => {
    logProviderRetryTelemetry(
      {
        attempt: 1,
        maxRetries: 3,
        provider: 'Anthropic',
        errorKind: 'rate_limit',
        delayMs: 1_000,
      },
      'planner',
    );

    expect(loggerMocks.warn).toHaveBeenCalledWith(
      {
        attempt: 1,
        maxRetries: 3,
        provider: 'Anthropic',
        callsite: 'planner',
      },
      'provider:rate-limit-429',
    );
  });

  it('logs provider:rate-limit-429 when retry errorKind contains 429', () => {
    logProviderRetryTelemetry(
      {
        attempt: 1,
        maxRetries: 3,
        provider: 'Anthropic',
        errorKind: 'http_429_retryable',
        delayMs: 1_000,
      },
      'fallback-executor',
    );

    expect(loggerMocks.warn).toHaveBeenCalledWith(
      {
        attempt: 1,
        maxRetries: 3,
        provider: 'Anthropic',
        callsite: 'fallback-executor',
      },
      'provider:rate-limit-429',
    );
  });

  it('does not throw for missing/malformed errorKind and logs unknown', () => {
    expect(() => {
      logProviderRetryTelemetry(
        {
          attempt: 1,
          maxRetries: 2,
          provider: 'anthropic',
          errorKind: undefined as any,
          delayMs: 100,
        },
        'planner',
      );
    }).not.toThrow();

    expect(loggerMocks.warn).toHaveBeenCalledWith(
      {
        attempt: 1,
        maxRetries: 2,
        provider: 'anthropic',
        errorKind: 'unknown',
        delayMs: 100,
        callsite: 'planner',
      },
      'provider:retry-attempt',
    );
  });
});
