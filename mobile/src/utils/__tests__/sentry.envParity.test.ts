const mockSentryInit = jest.fn();
const mockSentryWrap = jest.fn((component) => component);
const mockSentrySetTag = jest.fn();

jest.mock('@sentry/react-native', () => ({
  __esModule: true,
  init: mockSentryInit,
  setTag: mockSentrySetTag,
  setUser: jest.fn(),
  addBreadcrumb: jest.fn(),
  captureException: jest.fn(),
  captureMessage: jest.fn(),
  wrap: mockSentryWrap,
}));

jest.mock('expo-constants', () => ({
  __esModule: true,
  default: {
    expoConfig: {
      version: '1.0.0-test',
      runtimeVersion: 'runtime-test',
    },
  },
}));

describe('mobile Sentry env parity', () => {
  const originalEnv = process.env;
  let infoSpy: jest.SpyInstance;

  beforeEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
    process.env = { ...originalEnv };
    delete process.env.EXPO_PUBLIC_SENTRY_DSN;
    infoSpy = jest.spyOn(console, 'info').mockImplementation(() => {});
  });

  afterEach(() => {
    process.env = originalEnv;
    infoSpy.mockRestore();
  });

  it('does not call Sentry.init when EXPO_PUBLIC_SENTRY_DSN is unset', () => {
    const { initSentry, isSentryEnabled, wrapWithSentry } = require('../sentry');

    initSentry();
    const Component = () => null;
    const Wrapped = wrapWithSentry(Component);

    expect(mockSentryInit).not.toHaveBeenCalled();
    expect(mockSentryWrap).not.toHaveBeenCalled();
    expect(mockSentrySetTag).not.toHaveBeenCalled();
    expect(Wrapped).toBe(Component);
    expect(isSentryEnabled()).toBe(false);
    expect(infoSpy).toHaveBeenCalledWith(
      '[Sentry:Mobile] Disabled',
      expect.objectContaining({
        surface: 'mobile',
        reason: 'EXPO_PUBLIC_SENTRY_DSN env var not set',
      }),
    );
  });

  it('calls Sentry.init with the Expo public env DSN when set', () => {
    const testDsn = 'https://public@example.invalid/1';
    process.env.EXPO_PUBLIC_SENTRY_DSN = testDsn;

    const { initSentry, isSentryEnabled } = require('../sentry');

    initSentry();

    expect(mockSentryInit).toHaveBeenCalledTimes(1);
    expect(mockSentryInit).toHaveBeenCalledWith(
      expect.objectContaining({
        dsn: testDsn,
        environment: 'development',
        release: 'mindstone-rebel-mobile@1.0.0-test',
      }),
    );
    expect(isSentryEnabled()).toBe(true);
    expect(JSON.stringify(infoSpy.mock.calls)).not.toContain(testDsn);
  });

  it('beforeSend pins full redactSentryEvent semantics for mobile error events', () => {
    process.env.EXPO_PUBLIC_SENTRY_DSN = 'https://public@example.invalid/1';
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});

    const { initSentry } = require('../sentry');
    initSentry();

    const initOptions = mockSentryInit.mock.calls[0]?.[0] as {
      beforeSend?: (event: Record<string, unknown>) => Record<string, unknown> | null;
    };
    expect(typeof initOptions.beforeSend).toBe('function');

    const beforeSend = initOptions.beforeSend as (event: Record<string, unknown>) => Record<string, unknown> | null;
    const result = beforeSend({
      message: 'mobile someone@example.com:\uD83D',
      server_name: 'Alice-iPhone',
      user: {
        id: 'mobile-user',
        email: 'person@example.com',
        username: 'keep-me',
      },
      request: {
        headers: {
          authorization: 'Bearer keep-this-token',
        },
      },
      contexts: {
        auth: {
          client_secret: 'super-secret',
        },
      },
      tags: {
        hostile: 'tag:\uD83D',
      },
      exception: {
        values: [{
          type: 'Error',
          value: "EMFILE: too many open files, open '/Users/alice/workspace/mobile.log'",
        }],
      },
    });

    expect(result).not.toBeNull();
    const normalized = result as Record<string, unknown>;
    expect(normalized.message).toContain('***@***.***');
    expect(normalized.message).toContain('\uFFFD');
    const request = normalized.request as { headers?: Record<string, unknown> };
    expect(request.headers?.authorization).toBe('***REDACTED***');
    const user = normalized.user as Record<string, unknown>;
    expect(user.id).toBe('mobile-user');
    expect(user.email).toBe('person@example.com');
    expect(user.username).toBe('***REDACTED***');
    const contexts = normalized.contexts as { auth?: Record<string, unknown> };
    expect(contexts.auth?.client_secret).toBe('***REDACTED***');
    expect(normalized.server_name).toBeUndefined();
    const exception = normalized.exception as { values?: Array<{ value?: string }> };
    expect(exception.values?.[0]?.value).toContain("open '~/workspace/mobile.log'");
    expect(JSON.stringify(normalized)).not.toContain('\\ud83d');

    expect(warnSpy).toHaveBeenCalledWith(
      '[Sentry:Mobile] Replaced lone surrogates in outgoing error event',
      expect.objectContaining({
        replacementCount: expect.any(Number),
        replacementPaths: expect.any(Array),
        omittedPathCount: expect.any(Number),
      }),
    );

    warnSpy.mockRestore();
  });

  it('beforeSend redacts mobile dev-build frame home paths while preserving fingerprint fields', () => {
    process.env.EXPO_PUBLIC_SENTRY_DSN = 'https://public@example.invalid/1';

    const { initSentry } = require('../sentry');
    initSentry();

    const initOptions = mockSentryInit.mock.calls[0]?.[0] as {
      beforeSend?: (event: Record<string, unknown>) => Record<string, unknown> | null;
    };
    const beforeSend = initOptions.beforeSend as (event: Record<string, unknown>) => Record<string, unknown> | null;

    const fingerprint = ['mobile-dev-stacktrace', 'rebel-170'];
    const result = beforeSend({
      fingerprint,
      exception: {
        values: [{
          type: 'Error',
          value: 'mobile frame path repro',
          stacktrace: {
            frames: [{
              filename: '/Users/alice/workspace/mobile/index.ts',
              abs_path: '/Users/alice/workspace/mobile/index.ts',
              module: 'app/mobile/index',
              function: 'bootstrap',
            }],
          },
        }],
      },
    });

    expect(result).not.toBeNull();
    const normalized = result as Record<string, unknown>;
    expect(normalized.fingerprint).toEqual(fingerprint);

    const frame = (normalized.exception as {
      values?: Array<{ stacktrace?: { frames?: Array<{ filename?: string; abs_path?: string }> } }>;
    })?.values?.[0]?.stacktrace?.frames?.[0];
    expect(frame?.filename).toBe('~/workspace/mobile/index.ts');
    expect(frame?.abs_path).toBe('~/workspace/mobile/index.ts');
  });
});
