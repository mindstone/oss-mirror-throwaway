import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { collectSerdeStrictnessIssues } from '@shared/utils/sentrySerdeStrictness';

const sentryInitMock = vi.hoisted(() => vi.fn());
const sentrySetTagMock = vi.hoisted(() => vi.fn());
const sentrySetContextMock = vi.hoisted(() => vi.fn());

// Mutable platform/settings state so each test sets the OSS signal + telemetry
// settings explicitly (DI-3 carry-forward: an untyped partial getPlatformConfig
// mock returns isOss === undefined → falsy → enterprise, a silent trap).
const platformState = vi.hoisted(() => ({
  version: '1.0.0-test',
  isPackaged: false,
  isOss: false as boolean,
}));
const settingsState = vi.hoisted(
  () => ({ telemetry: undefined as undefined | { enabled: boolean; sentryDsn?: string } }),
);

vi.mock('@sentry/electron/main', () => ({
  IPCMode: { Classic: 'classic' },
  addBreadcrumb: vi.fn(),
  captureException: vi.fn(),
  captureMessage: vi.fn(),
  flush: vi.fn(),
  getClient: vi.fn(() => ({ on: vi.fn() })),
  init: sentryInitMock,
  setContext: sentrySetContextMock,
  setTag: sentrySetTagMock,
  setUser: vi.fn(),
  withScope: vi.fn(),
}));

vi.mock('@core/platform', () => ({
  getPlatformConfig: vi.fn(() => ({ ...platformState })),
}));

vi.mock('@core/services/settingsStore', () => ({
  getSettings: vi.fn(() => ({ ...settingsState })),
}));

vi.mock('../logBuffer', () => ({
  getRecentLogs: vi.fn(() => []),
}));

vi.mock('../utils/buildChannel', () => ({
  getBuildChannel: vi.fn(() => 'dev'),
}));

describe('main Sentry env parity', () => {
  let infoSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    vi.unstubAllEnvs();
    // Reset platform/settings to enterprise defaults each test.
    platformState.isOss = false;
    settingsState.telemetry = undefined;
    vi.stubEnv('VITEST', 'false');
    // Neutralise CI/E2E environment detection so resolveEnvironment() (src/main/sentry.ts)
    // falls through to the unpackaged default ('development', matching the mocked
    // getPlatformConfig isPackaged:false) deterministically. Without this, GitHub Actions
    // runners set CI/GITHUB_ACTIONS → 'ci-e2e', so the environment assertions below pass
    // locally but fail in the beta release workflow ("works on my machine" — same class as
    // the desktop credential-strip guard; see docs/plans/260607_oss-scrub-regression-class).
    vi.stubEnv('SENTRY_ENVIRONMENT', '');
    vi.stubEnv('CI', '');
    vi.stubEnv('GITHUB_ACTIONS', '');
    vi.stubEnv('REBEL_E2E_TEST_MODE', '');
    vi.stubEnv('REBEL_TEST_USER_DATA_DIR', '');
    infoSpy = vi.spyOn(console, 'info').mockImplementation(() => {});
  });

  afterEach(() => {
    infoSpy.mockRestore();
    vi.unstubAllEnvs();
  });

  it('does not call Sentry.init when SENTRY_DSN is unset', async () => {
    vi.stubEnv('SENTRY_DSN', '');

    const { initMainSentry, isMainSentryEnabled, getMainSentryDisabledReason } =
      await import('../sentry');

    initMainSentry();

    expect(sentryInitMock).not.toHaveBeenCalled();
    expect(sentrySetTagMock).not.toHaveBeenCalled();
    expect(sentrySetContextMock).not.toHaveBeenCalled();
    expect(isMainSentryEnabled()).toBe(false);
    // Truthful disabled-reason plumbing: a missing DSN is 'no-dsn', NOT a
    // dev-mode/SENTRY_ENABLED situation (drives the bug-report toast copy).
    expect(getMainSentryDisabledReason()).toBe('no-dsn');
    expect(infoSpy).toHaveBeenCalledWith(
      '[Sentry:Main] Disabled',
      expect.objectContaining({
        surface: 'main',
        reason: 'SENTRY_DSN env var not set',
      }),
    );
  });

  it('reports env-disabled when a DSN is present but SENTRY_ENABLED turns Sentry off', async () => {
    vi.stubEnv('SENTRY_DSN', 'https://public@example.invalid/1');
    vi.stubEnv('SENTRY_ENABLED', '0');

    const { initMainSentry, isMainSentryEnabled, getMainSentryDisabledReason } =
      await import('../sentry');

    initMainSentry();

    expect(sentryInitMock).not.toHaveBeenCalled();
    expect(isMainSentryEnabled()).toBe(false);
    expect(getMainSentryDisabledReason()).toBe('env-disabled');
    expect(infoSpy).toHaveBeenCalledWith(
      '[Sentry:Main] Disabled',
      expect.objectContaining({
        surface: 'main',
        reason: 'SENTRY_ENABLED disabled Sentry',
      }),
    );
  });

  it('calls Sentry.init with the env DSN when SENTRY_DSN is set', async () => {
    const testDsn = 'https://public@example.invalid/1';
    vi.stubEnv('SENTRY_DSN', testDsn);

    const { initMainSentry, isMainSentryEnabled, getMainSentryDisabledReason } =
      await import('../sentry');

    initMainSentry();

    expect(sentryInitMock).toHaveBeenCalledTimes(1);
    expect(sentryInitMock).toHaveBeenCalledWith(
      expect.objectContaining({
        dsn: testDsn,
        enabled: true,
        environment: 'development',
      }),
    );
    expect(isMainSentryEnabled()).toBe(true);
    expect(getMainSentryDisabledReason()).toBeNull();
    expect(infoSpy).toHaveBeenCalledWith(
      '[Sentry:Main] Enabled',
      expect.objectContaining({
        surface: 'main',
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
    platformState.isOss = true;
    settingsState.telemetry = undefined; // opt-in off / absent
    // Mindstone env DSN present — must be ignored on the OSS path.
    vi.stubEnv('SENTRY_DSN', 'https://mindstone@example.invalid/99');

    const { initMainSentry, isMainSentryEnabled } = await import('../sentry');

    initMainSentry();

    expect(sentryInitMock).not.toHaveBeenCalled();
    expect(isMainSentryEnabled()).toBe(false);
  });

  it('OSS + telemetry opt-in ON but no user DSN: does NOT init Sentry', async () => {
    platformState.isOss = true;
    settingsState.telemetry = { enabled: true }; // enabled but no DSN
    vi.stubEnv('SENTRY_DSN', 'https://mindstone@example.invalid/99');

    const { initMainSentry, isMainSentryEnabled } = await import('../sentry');

    initMainSentry();

    expect(sentryInitMock).not.toHaveBeenCalled();
    expect(isMainSentryEnabled()).toBe(false);
  });

  it('OSS + telemetry opt-in ON + user DSN: inits with the USER DSN, never the env DSN', async () => {
    const userDsn = 'https://[external-email]/1';
    const envDsn = 'https://mindstone@example.invalid/99';
    platformState.isOss = true;
    settingsState.telemetry = { enabled: true, sentryDsn: userDsn };
    vi.stubEnv('SENTRY_DSN', envDsn);

    const { initMainSentry, isMainSentryEnabled } = await import('../sentry');

    initMainSentry();

    expect(sentryInitMock).toHaveBeenCalledTimes(1);
    expect(sentryInitMock).toHaveBeenCalledWith(
      expect.objectContaining({ dsn: userDsn, enabled: true }),
    );
    // The env DSN must never reach Sentry.init on the OSS path.
    expect(JSON.stringify(sentryInitMock.mock.calls)).not.toContain(envDsn);
    expect(isMainSentryEnabled()).toBe(true);
  });

  it('installs a sweep-only beforeSendTransaction hook', async () => {
    const testDsn = 'https://public@example.invalid/1';
    vi.stubEnv('SENTRY_DSN', testDsn);

    const { initMainSentry } = await import('../sentry');
    initMainSentry();

    const initOptions = sentryInitMock.mock.calls[0]?.[0] as {
      beforeSendTransaction?: (event: Record<string, unknown>) => Record<string, unknown> | null;
    };
    expect(typeof initOptions.beforeSendTransaction).toBe('function');

    const beforeSendTransaction = initOptions.beforeSendTransaction as (event: Record<string, unknown>) => Record<string, unknown> | null;
    const result = beforeSendTransaction({
      message: 'email someone@example.com',
      request: {
        headers: {
          authorization: 'Bearer keep-this-token',
        },
      },
      tags: { hostile: 'main:\uD83D' },
    });

    expect(result).not.toBeNull();
    const normalized = result as Record<string, unknown>;
    expect(normalized.message).toBe('email someone@example.com');
    const request = normalized.request as { headers?: Record<string, unknown> };
    expect(request.headers?.authorization).toBe('Bearer keep-this-token');

    const issues = collectSerdeStrictnessIssues(JSON.stringify(normalized));
    expect(issues.loneSurrogateEscapes).toHaveLength(0);
    expect(issues.rawLoneSurrogates).toHaveLength(0);
  });
});
