import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Mirror the oversize-detection harness: stub the SDK so we can capture the
// init options and invoke the real `beforeSend` closure directly.
const sentryInitMock = vi.hoisted(() => vi.fn());

vi.mock('@sentry/electron/main', () => ({
  IPCMode: { Classic: 'classic' },
  addBreadcrumb: vi.fn(),
  captureException: vi.fn(),
  captureMessage: vi.fn(),
  flush: vi.fn(),
  getClient: vi.fn(() => ({ on: vi.fn() })),
  init: sentryInitMock,
  setContext: vi.fn(),
  setTag: vi.fn(),
  setUser: vi.fn(),
  withScope: vi.fn(),
}));

vi.mock('@core/platform', () => ({
  getPlatformConfig: vi.fn(() => ({
    version: '1.0.0-test',
    isPackaged: false,
    isOss: false,
  })),
}));

vi.mock('@core/services/settingsStore', () => ({
  getSettings: vi.fn(() => ({})),
}));

vi.mock('../logBuffer', () => ({
  getRecentLogs: vi.fn(() => []),
}));

vi.mock('../utils/buildChannel', () => ({
  getBuildChannel: vi.fn(() => 'dev'),
}));

vi.mock('@core/sentry/captureKnownCondition', () => ({
  captureKnownCondition: vi.fn(),
  recordKnownConditionLedgerOnly: vi.fn(),
}));

type BeforeSendHook = (event: Record<string, unknown>) => Record<string, unknown> | null;

const getBeforeSend = async (): Promise<BeforeSendHook> => {
  const { initMainSentry } = await import('../sentry');
  initMainSentry();
  expect(sentryInitMock).toHaveBeenCalledTimes(1);
  const options = sentryInitMock.mock.calls[0]?.[0] as { beforeSend?: BeforeSendHook };
  expect(typeof options.beforeSend).toBe('function');
  return options.beforeSend as BeforeSendHook;
};

// The substring matched by the message-content drop filter in beforeSend.
const DROPPED_MESSAGE = 'Failed query: insert into "rebel".users (...) — duplicate key';

describe('main sentry beforeSend — user bug report exemption', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    vi.unstubAllEnvs();
    // src/main/sentry.ts swaps in an internal no-op SDK stub when VITEST=true.
    // Force the real branch so we can inspect captured init options.
    vi.stubEnv('VITEST', 'false');
    vi.stubEnv('SENTRY_DSN', 'https://public@example.invalid/1');
    vi.stubEnv('SENTRY_ENVIRONMENT', '');
    vi.stubEnv('CI', '');
    vi.stubEnv('GITHUB_ACTIONS', '');
    vi.stubEnv('REBEL_E2E_TEST_MODE', '');
    vi.stubEnv('REBEL_TEST_USER_DATA_DIR', '');
    vi.spyOn(console, 'info').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it('does NOT drop a user-bug-report event whose message matches a content filter', async () => {
    const beforeSend = await getBeforeSend();
    const result = beforeSend({
      message: DROPPED_MESSAGE,
      tags: { source: 'user-bug-report' },
    });
    // Exempt: the report a user pasted (a backend error they're reporting) must survive.
    expect(result).not.toBeNull();
    expect((result as { message?: string }).message).toContain('Failed query: insert into "rebel"');
  });

  it('STILL drops a non-bug-report event with the same matching message', async () => {
    const beforeSend = await getBeforeSend();
    const result = beforeSend({
      message: DROPPED_MESSAGE,
      tags: { source: 'some-other-source' },
    });
    expect(result).toBeNull();
  });

  it('STILL drops the same message when there is no source tag at all', async () => {
    const beforeSend = await getBeforeSend();
    const result = beforeSend({ message: DROPPED_MESSAGE });
    expect(result).toBeNull();
  });
});
