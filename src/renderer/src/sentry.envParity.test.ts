import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { collectSerdeStrictnessIssues } from '@shared/utils/sentrySerdeStrictness';

const electronSentryInitMock = vi.hoisted(() =>
  vi.fn((_options: unknown, reactInit?: (options: Record<string, unknown>) => void) => {
    reactInit?.({});
  }),
);
const electronSetTagMock = vi.hoisted(() => vi.fn());
const electronSetUserMock = vi.hoisted(() => vi.fn());
const feedbackIntegrationMock = vi.hoisted(() => vi.fn(() => ({ name: 'feedback' })));
const browserTracingIntegrationMock = vi.hoisted(() => vi.fn(() => ({ name: 'browserTracing' })));
const reactSentryInitMock = vi.hoisted(() => vi.fn());

vi.mock('@sentry/electron/renderer', () => ({
  addBreadcrumb: vi.fn(),
  browserTracingIntegration: browserTracingIntegrationMock,
  captureException: vi.fn(),
  captureMessage: vi.fn(),
  feedbackIntegration: feedbackIntegrationMock,
  init: electronSentryInitMock,
  setTag: electronSetTagMock,
  setUser: electronSetUserMock,
}));

vi.mock('@sentry/react', () => ({
  ErrorBoundary: 'SentryErrorBoundary',
  init: reactSentryInitMock,
}));

describe('renderer Sentry env parity', () => {
  let infoSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    vi.unstubAllEnvs();
    infoSpy = vi.spyOn(console, 'info').mockImplementation(() => {});
    vi.stubGlobal('window', {
      electronEnv: {
        appVersion: '1.0.0-test',
        buildChannel: 'dev',
      },
      location: {
        protocol: 'http:',
      },
      settingsApi: undefined,
    });
  });

  afterEach(() => {
    infoSpy.mockRestore();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    // Clear the OSS build literal set by OSS cases so it can't leak (DI-3).
    delete (globalThis as Record<string, unknown>).__REBEL_IS_OSS__;
  });

  /**
   * Set the renderer OSS build signal + the LOCAL_ONLY telemetryConfig bridge.
   * DI-3 carry-forward: OSS tests must set the signal explicitly; default is
   * `undefined` → `rendererIsOss()` false → enterprise.
   */
  const setOssWindow = (telemetryConfig: unknown): void => {
    (globalThis as Record<string, unknown>).__REBEL_IS_OSS__ = true;
    vi.stubGlobal('window', {
      electronEnv: {
        appVersion: '1.0.0-test',
        buildChannel: 'dev',
        telemetryConfig,
      },
      location: { protocol: 'http:' },
      settingsApi: undefined,
    });
  };

  it('does not call Sentry.init or install integrations when SENTRY_DSN is unset', async () => {
    vi.stubEnv('SENTRY_DSN', '');
    vi.stubEnv('VITE_SENTRY_DSN', '');

    const { initRendererSentry, isSentryInitialized } = await import('./sentry');

    initRendererSentry();

    expect(electronSentryInitMock).not.toHaveBeenCalled();
    expect(reactSentryInitMock).not.toHaveBeenCalled();
    expect(feedbackIntegrationMock).not.toHaveBeenCalled();
    expect(browserTracingIntegrationMock).not.toHaveBeenCalled();
    expect(electronSetTagMock).not.toHaveBeenCalled();
    expect(electronSetUserMock).not.toHaveBeenCalled();
    expect(isSentryInitialized()).toBe(false);
    expect(infoSpy).toHaveBeenCalledWith(
      '[Sentry:Renderer] Disabled',
      expect.objectContaining({
        surface: 'renderer',
        reason: 'SENTRY_DSN env var not set',
      }),
    );
  });

  it('calls Electron and React Sentry.init with the env DSN when SENTRY_DSN is set', async () => {
    const testDsn = 'https://public@example.invalid/1';
    vi.stubEnv('SENTRY_DSN', testDsn);

    const { initRendererSentry, isSentryInitialized } = await import('./sentry');

    initRendererSentry();

    expect(electronSentryInitMock).toHaveBeenCalledTimes(1);
    expect(electronSentryInitMock).toHaveBeenCalledWith(
      expect.objectContaining({
        dsn: testDsn,
        enabled: true,
        environment: 'development',
      }),
      expect.any(Function),
    );
    expect(reactSentryInitMock).toHaveBeenCalledWith(
      expect.objectContaining({
        dsn: testDsn,
        enabled: true,
        environment: 'development',
      }),
    );
    expect(isSentryInitialized()).toBe(true);
    expect(infoSpy).toHaveBeenCalledWith(
      '[Sentry:Renderer] Enabled',
      expect.objectContaining({
        surface: 'renderer',
        environment: 'development',
        dsnHost: 'example.invalid',
      }),
    );
    expect(JSON.stringify(infoSpy.mock.calls)).not.toContain(testDsn);
  });

  // ---------------------------------------------------------------------------
  // OSS no-phone-home gate (B6.a / Stage 3a)
  // ---------------------------------------------------------------------------

  it('OSS + telemetry opt-in OFF: does NOT init Sentry even when env SENTRY_DSN is set', async () => {
    setOssWindow(null); // no telemetryConfig bridge → off
    vi.stubEnv('SENTRY_DSN', 'https://mindstone@example.invalid/99');

    const { initRendererSentry, isSentryInitialized } = await import('./sentry');

    initRendererSentry();

    expect(electronSentryInitMock).not.toHaveBeenCalled();
    expect(reactSentryInitMock).not.toHaveBeenCalled();
    expect(isSentryInitialized()).toBe(false);
  });

  it('OSS + opt-in ON but no user DSN: does NOT init Sentry', async () => {
    setOssWindow({ enabled: true }); // enabled, no DSN
    vi.stubEnv('SENTRY_DSN', 'https://mindstone@example.invalid/99');

    const { initRendererSentry, isSentryInitialized } = await import('./sentry');

    initRendererSentry();

    expect(electronSentryInitMock).not.toHaveBeenCalled();
    expect(isSentryInitialized()).toBe(false);
  });

  it('OSS + opt-in ON + user DSN: inits with the USER DSN, never the env DSN', async () => {
    const userDsn = 'https://[external-email]/1';
    const envDsn = 'https://mindstone@example.invalid/99';
    setOssWindow({ enabled: true, sentryDsn: userDsn });
    vi.stubEnv('SENTRY_DSN', envDsn);

    const { initRendererSentry, isSentryInitialized } = await import('./sentry');

    initRendererSentry();

    expect(electronSentryInitMock).toHaveBeenCalledTimes(1);
    expect(electronSentryInitMock).toHaveBeenCalledWith(
      expect.objectContaining({ dsn: userDsn, enabled: true }),
      expect.any(Function),
    );
    expect(reactSentryInitMock).toHaveBeenCalledWith(
      expect.objectContaining({ dsn: userDsn, enabled: true }),
    );
    expect(JSON.stringify(electronSentryInitMock.mock.calls)).not.toContain(envDsn);
    expect(isSentryInitialized()).toBe(true);
  });

  // ---------------------------------------------------------------------------
  // Runtime suppression bridge (--rebel-sentry-disabled → electronEnv.sentryDisabled)
  // Main passes the flag when SENTRY_ENABLED is explicitly false-ish at runtime
  // (e.g. CI packaged-app launches); renderer enablement is build-inlined, so
  // this is the only runtime kill-switch the renderer can see.
  // ---------------------------------------------------------------------------

  it('host suppression flag: does NOT init Sentry even when the build-inlined DSN is present', async () => {
    vi.stubEnv('SENTRY_DSN', 'https://mindstone@example.invalid/99');
    vi.stubGlobal('window', {
      electronEnv: {
        appVersion: '1.0.0-test',
        buildChannel: 'dev',
        sentryDisabled: true,
      },
      location: { protocol: 'file:' },
      settingsApi: undefined,
    });

    const { initRendererSentry, isSentryInitialized } = await import('./sentry');

    initRendererSentry();

    expect(electronSentryInitMock).not.toHaveBeenCalled();
    expect(reactSentryInitMock).not.toHaveBeenCalled();
    expect(browserTracingIntegrationMock).not.toHaveBeenCalled();
    expect(isSentryInitialized()).toBe(false);
    expect(infoSpy).toHaveBeenCalledWith(
      '[Sentry:Renderer] Disabled',
      expect.objectContaining({
        surface: 'renderer',
        reason: 'host disabled Sentry at runtime (--rebel-sentry-disabled)',
      }),
    );
  });

  it('host suppression flag wins over the OSS settings-driven telemetry path', async () => {
    (globalThis as Record<string, unknown>).__REBEL_IS_OSS__ = true;
    vi.stubGlobal('window', {
      electronEnv: {
        appVersion: '1.0.0-test',
        buildChannel: 'dev',
        sentryDisabled: true,
        telemetryConfig: { enabled: true, sentryDsn: 'https://[external-email]/1' },
      },
      location: { protocol: 'http:' },
      settingsApi: undefined,
    });

    const { initRendererSentry, isSentryInitialized } = await import('./sentry');

    initRendererSentry();

    expect(electronSentryInitMock).not.toHaveBeenCalled();
    expect(reactSentryInitMock).not.toHaveBeenCalled();
    expect(isSentryInitialized()).toBe(false);
  });

  it('isRendererSentrySuppressedByHost: true only for a literal boolean true', async () => {
    const { isRendererSentrySuppressedByHost } = await import('./sentry');

    expect(isRendererSentrySuppressedByHost({ sentryDisabled: true })).toBe(true);
    expect(isRendererSentrySuppressedByHost({ sentryDisabled: false })).toBe(false);
    expect(isRendererSentrySuppressedByHost({ sentryDisabled: undefined })).toBe(false);
    // Defensive across the contextBridge: a stringly value must not suppress.
    expect(isRendererSentrySuppressedByHost({ sentryDisabled: 'true' })).toBe(false);
    expect(isRendererSentrySuppressedByHost({})).toBe(false);
    expect(isRendererSentrySuppressedByHost(undefined)).toBe(false);
    expect(isRendererSentrySuppressedByHost(null)).toBe(false);
  });

  it('absent suppression flag (old main / dev) leaves env-driven init untouched', async () => {
    const testDsn = 'https://public@example.invalid/1';
    vi.stubEnv('SENTRY_DSN', testDsn);
    // beforeEach window stub has no sentryDisabled key — mirrors a main process
    // that predates the flag.

    const { initRendererSentry, isSentryInitialized } = await import('./sentry');

    initRendererSentry();

    expect(electronSentryInitMock).toHaveBeenCalledTimes(1);
    expect(isSentryInitialized()).toBe(true);
  });

  it('beforeSend pins full redactSentryEvent semantics for renderer error events', async () => {
    vi.stubEnv('SENTRY_DSN', 'https://public@example.invalid/1');
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const { initRendererSentry } = await import('./sentry');
    initRendererSentry();

    expect(electronSentryInitMock).toHaveBeenCalledTimes(1);
    const options = electronSentryInitMock.mock.calls[0]?.[0] as {
      beforeSend?: (event: Record<string, unknown>, hint?: unknown) => Record<string, unknown> | null;
    };
    expect(typeof options.beforeSend).toBe('function');

    const beforeSend = options.beforeSend as (event: Record<string, unknown>, hint?: unknown) => Record<string, unknown> | null;
    const result = beforeSend({
      message: 'hello someone@example.com bad:\uD83D',
      server_name: 'Alice-Workstation',
      extra: {
        oauth_code: 'fake-test-oauth-code-value-1234567890',
        detail: 'extra:\uD83D',
      },
      user: {
        id: 'u1',
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
          safeFlag: true,
        },
      },
      exception: {
        values: [{
          type: 'Error',
          value: 'EMFILE: open C:\\Users\\alice\\workspace\\index.txt',
        }],
      },
      tags: { hostile: 'tag:\uD83D' },
      breadcrumbs: [{ category: 'log', message: 'crumb:\uD83D' }],
    });

    expect(result).not.toBeNull();
    const normalized = result as Record<string, unknown>;
    expect((normalized.message as string)).toContain('***@***.***');

    const extra = normalized.extra as Record<string, unknown>;
    expect(extra.oauth_code).toBe('***REDACTED***');

    const user = normalized.user as Record<string, unknown>;
    expect(user.id).toBe('u1');
    expect(user.email).toBe('person@example.com');
    expect(user.username).toBe('***REDACTED***');

    const request = normalized.request as { headers?: Record<string, unknown> };
    expect(request.headers?.authorization).toBe('***REDACTED***');

    const contexts = normalized.contexts as { auth?: Record<string, unknown> };
    expect(contexts.auth?.client_secret).toBe('***REDACTED***');
    expect(contexts.auth?.safeFlag).toBe(true);
    expect(normalized.server_name).toBeUndefined();

    const exception = normalized.exception as { values?: Array<{ value?: string }> };
    expect(exception.values?.[0]?.value).toContain('~\\workspace\\index.txt');

    const issues = collectSerdeStrictnessIssues(JSON.stringify(normalized));
    expect(issues.loneSurrogateEscapes).toHaveLength(0);
    expect(issues.rawLoneSurrogates).toHaveLength(0);

    expect(warnSpy).toHaveBeenCalledWith(
      '[Sentry:Renderer] Replaced lone surrogates in outgoing error event',
      expect.objectContaining({
        replacementCount: expect.any(Number),
        replacementPaths: expect.any(Array),
        omittedPathCount: expect.any(Number),
      }),
    );
    const replacementSummary = warnSpy.mock.calls[0]?.[1] as { replacementCount?: number } | undefined;
    expect(replacementSummary?.replacementCount ?? 0).toBeGreaterThan(0);

    warnSpy.mockRestore();
  });

  it('beforeSend keeps REBEL-1C8 grouping inputs stable while normalizing exception home paths', async () => {
    // Stage 4 arbitration (UNIFY): pin the evidence-pack claim that REBEL-1C8
    // path redaction is grouping-safe while exception text is normalized.
    vi.stubEnv('SENTRY_DSN', 'https://public@example.invalid/1');
    const { initRendererSentry } = await import('./sentry');
    initRendererSentry();

    const options = electronSentryInitMock.mock.calls[0]?.[0] as {
      beforeSend?: (event: Record<string, unknown>, hint?: unknown) => Record<string, unknown> | null;
    };
    const beforeSend = options.beforeSend as (event: Record<string, unknown>, hint?: unknown) => Record<string, unknown> | null;

    const fingerprint = ['rebel-1c8', 'windows-emfile'];
    const result = beforeSend({
      fingerprint,
      exception: {
        values: [{
          type: 'Error',
          value: "EMFILE: too many open files, open 'C:\\Users\\alice\\workspace\\notes\\foo.md'",
          stacktrace: {
            frames: [{
              module: 'node:fs',
              function: 'open',
              context_line: 'throw err;',
            }],
          },
        }],
      },
    });

    expect(result).not.toBeNull();
    const normalized = result as Record<string, unknown>;
    expect(normalized.fingerprint).toEqual(fingerprint);

    const exception = normalized.exception as {
      values?: Array<{
        value?: string;
        stacktrace?: { frames?: Array<{ module?: string; function?: string; context_line?: string }> };
      }>;
    };
    expect(exception.values?.[0]?.value).toContain("open '~\\workspace\\notes\\foo.md'");

    const frame = exception.values?.[0]?.stacktrace?.frames?.[0];
    expect(frame?.module).toBe('node:fs');
    expect(frame?.function).toBe('open');
    expect(frame?.context_line).toBe('throw err;');
  });

  it('beforeSendTransaction is sweep-only (no extra/message redaction semantics)', async () => {
    vi.stubEnv('SENTRY_DSN', 'https://public@example.invalid/1');
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const { initRendererSentry } = await import('./sentry');
    initRendererSentry();

    expect(electronSentryInitMock).toHaveBeenCalledTimes(1);
    const options = electronSentryInitMock.mock.calls[0]?.[0] as {
      beforeSendTransaction?: (event: Record<string, unknown>) => Record<string, unknown> | null;
    };
    expect(typeof options.beforeSendTransaction).toBe('function');

    const beforeSendTransaction = options.beforeSendTransaction as (event: Record<string, unknown>) => Record<string, unknown> | null;
    const result = beforeSendTransaction({
      message: 'email someone@example.com',
      request: {
        headers: {
          authorization: 'Bearer keep-this-token',
        },
      },
      tags: { hostile: 'tx:\uD83D' },
    });

    expect(result).not.toBeNull();
    const normalized = result as Record<string, unknown>;
    // sweep-only: message must not be redacted on the transaction path
    expect(normalized.message).toBe('email someone@example.com');
    const request = normalized.request as { headers?: Record<string, unknown> };
    expect(request.headers?.authorization).toBe('Bearer keep-this-token');

    const issues = collectSerdeStrictnessIssues(JSON.stringify(normalized));
    expect(issues.loneSurrogateEscapes).toHaveLength(0);
    expect(issues.rawLoneSurrogates).toHaveLength(0);

    warnSpy.mockRestore();
  });
});
