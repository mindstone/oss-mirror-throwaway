import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const sentryCaptureExceptionMock = vi.hoisted(() => vi.fn(() => 'event-id'));
const sentryWithScopeMock = vi.hoisted(() =>
  vi.fn((callback: (scope: { addAttachment: () => void; setExtra: () => void }) => void) => {
    callback({ addAttachment: vi.fn(), setExtra: vi.fn() });
  }),
);

 
vi.mock('@sentry/electron/main', () => ({
  IPCMode: { Classic: 'classic' },
  addBreadcrumb: vi.fn(),
  captureException: sentryCaptureExceptionMock,
  captureMessage: vi.fn(),
  flush: vi.fn(),
  getClient: vi.fn(() => ({ on: vi.fn() })),
  init: vi.fn(),
  setContext: vi.fn(),
  setTag: vi.fn(),
  setUser: vi.fn(),
  withScope: sentryWithScopeMock,
}));

 
vi.mock('@core/platform', () => ({
  getPlatformConfig: vi.fn(() => ({ version: '1.0.0-test', isPackaged: false })),
}));

 
vi.mock('@shared/telemetry/sentryConfig', () => ({
  collectCommonSentryOptions: vi.fn(() => ({
    dsn: 'https://example.invalid/1',
    release: 'test-release',
    environment: 'test',
    enabled: true,
    tracesSampleRate: 0,
    profilesSampleRate: 0,
  })),
  describeSentryDsnForLog: vi.fn(() => 'example.invalid'),
}));

 
vi.mock('../logBuffer', () => ({
  getRecentLogs: vi.fn(() => []),
}));

 
vi.mock('../utils/buildChannel', () => ({
  getBuildChannel: vi.fn(() => 'test'),
}));

describe('desktop sentry error reporter adapter', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    vi.stubEnv('VITEST', 'false');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('passes CaptureContext fields through without wrapping under extra', async () => {
    const { captureMainException } = await import('../sentry');

    const error = new Error('boom');
    const context = {
      fingerprint: ['x', 'y'],
      level: 'warning' as const,
      tags: { foo: 'bar' },
      extra: { z: 1 },
    };

    captureMainException(error, context);

    expect(sentryCaptureExceptionMock).toHaveBeenCalledTimes(1);
    expect(sentryCaptureExceptionMock).toHaveBeenCalledWith(error, context);

    const calls = sentryCaptureExceptionMock.mock.calls as unknown as Array<[unknown, unknown?]>;
    const receivedContext = calls[0]?.[1] as
      | {
          extra?: Record<string, unknown>;
          fingerprint?: readonly string[];
          level?: string;
          tags?: Record<string, unknown>;
        }
      | undefined;

    expect(receivedContext?.fingerprint).toEqual(['x', 'y']);
    expect(receivedContext?.level).toBe('warning');
    expect(receivedContext?.tags).toEqual({ foo: 'bar' });
    expect(receivedContext?.extra).toMatchObject({ z: 1 });
    expect(receivedContext?.extra).not.toHaveProperty('fingerprint');
    expect(receivedContext?.extra).not.toHaveProperty('level');
    expect(receivedContext?.extra).not.toHaveProperty('tags');
  });
});
