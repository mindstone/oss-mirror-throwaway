import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const sentryInitMock = vi.hoisted(() => vi.fn());
const captureKnownConditionMock = vi.hoisted(() => vi.fn());

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
  captureKnownCondition: captureKnownConditionMock,
  recordKnownConditionLedgerOnly: vi.fn(),
}));

type BeforeSendHook = (event: Record<string, unknown>) => Record<string, unknown> | null;

const getBeforeSend = async (): Promise<{
  beforeSend: BeforeSendHook;
  threshold: number;
}> => {
  const { initMainSentry, SENTRY_EVENT_OVERSIZE_PROBE_THRESHOLD_BYTES } = await import('../sentry');
  initMainSentry();
  expect(sentryInitMock).toHaveBeenCalledTimes(1);
  const options = sentryInitMock.mock.calls[0]?.[0] as { beforeSend?: BeforeSendHook };
  expect(typeof options.beforeSend).toBe('function');
  return {
    beforeSend: options.beforeSend as BeforeSendHook,
    threshold: SENTRY_EVENT_OVERSIZE_PROBE_THRESHOLD_BYTES,
  };
};

describe('main sentry oversized-event probe', () => {
  let infoSpy: ReturnType<typeof vi.spyOn>;
  let logSpy: ReturnType<typeof vi.spyOn>;
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    vi.unstubAllEnvs();
    // src/main/sentry.ts swaps in an internal no-op SDK stub when VITEST=true.
    // Force the real branch so we can inspect captured init options.
    vi.stubEnv('VITEST', 'false');
    vi.stubEnv('SENTRY_DSN', 'https://public@example.invalid/1');
    // Neutralize CI/E2E env selection for deterministic init.
    vi.stubEnv('SENTRY_ENVIRONMENT', '');
    vi.stubEnv('CI', '');
    vi.stubEnv('GITHUB_ACTIONS', '');
    vi.stubEnv('REBEL_E2E_TEST_MODE', '');
    vi.stubEnv('REBEL_TEST_USER_DATA_DIR', '');
    infoSpy = vi.spyOn(console, 'info').mockImplementation(() => {});
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    infoSpy.mockRestore();
    logSpy.mockRestore();
    warnSpy.mockRestore();
    vi.unstubAllEnvs();
  });

  it('pins the exact threshold boundary (== threshold is NOT oversized; +1 is)', async () => {
    const { summarizeMainOversizedEvent } = await import('../sentry');
    // Build an event whose serialized form is exactly N bytes, then test at
    // thresholds N (== size -> null) and N-1 (size exceeds by one -> summary).
    const event = { message: 'x'.repeat(64) };
    const exactSize = Buffer.byteLength(JSON.stringify(event), 'utf8');
    expect(summarizeMainOversizedEvent(event, exactSize)).toBeNull();
    const summary = summarizeMainOversizedEvent(event, exactSize - 1);
    expect(summary).not.toBeNull();
    expect(summary?.eventSizeBytes).toBe(exactSize);
  });

  it('does nothing for events below the oversize threshold', async () => {
    const { beforeSend, threshold } = await getBeforeSend();
    const result = beforeSend({
      message: 'small event',
      extra: { tiny: 'ok' },
    });

    expect(result).not.toBeNull();
    expect(captureKnownConditionMock).not.toHaveBeenCalled();
    expect(
      warnSpy.mock.calls.some((call: unknown[]) =>
        String(call[0]).includes('Oversized outgoing event detected'),
      ),
    ).toBe(false);
    expect(threshold).toBeGreaterThan(100_000);
  });

  it('emits known-condition telemetry with section attribution and never logs values', async () => {
    const { beforeSend, threshold } = await getBeforeSend();
    const secretValue = 'secret-value-never-log-me';
    const largeNumericArray = Array.from({ length: 350_000 }, (_, idx) => idx % 10);
    const mediumNumericArray = Array.from({ length: 100_000 }, (_, idx) => idx % 7);
    const result = beforeSend({
      message: 'oversize event probe',
      breadcrumbs: Array.from({ length: 150 }, (_, idx) => ({
        category: 'log',
        message: `breadcrumb-${idx}`,
        data: { index: idx, sample: 'b'.repeat(128) },
      })),
      contexts: {
        systemHealth: {
          status: 'degraded',
          failedChecks: Array.from({ length: 80 }, (_, idx) => `check-${idx}`),
          note: 'c'.repeat(45_000),
        },
      },
      extra: {
        hugePayload: largeNumericArray,
        mediumPayload: mediumNumericArray,
        sensitiveToken: secretValue,
        tiny: true,
      },
    });

    expect(result).not.toBeNull();
    expect(captureKnownConditionMock).toHaveBeenCalledTimes(1);
    const [condition, contextArg, errorArg] = captureKnownConditionMock.mock.calls[0] as [
      string,
      { extra?: { eventSizeBytes: number; thresholdBytes: number; topSections: Array<{ section: string; sizeBytes: number }> } },
      unknown,
    ];
    expect(condition).toBe('sentry_oversized_event_detected');
    expect(errorArg).toBeInstanceOf(Error);

    const extra = contextArg.extra;
    expect(extra).toBeDefined();
    expect(extra?.eventSizeBytes).toBeGreaterThan(threshold);
    expect(extra?.thresholdBytes).toBe(threshold);

    const topSections = extra?.topSections ?? [];
    expect(topSections.length).toBeGreaterThan(0);
    expect(topSections[0]?.section).toBe('extra.hugePayload');
    expect(topSections.some((entry) => entry.section === 'breadcrumbs')).toBe(true);
    expect(topSections.some((entry) => entry.section === 'contexts')).toBe(true);
    for (let idx = 1; idx < topSections.length; idx += 1) {
      expect(topSections[idx - 1]!.sizeBytes).toBeGreaterThanOrEqual(topSections[idx]!.sizeBytes);
    }

    const warnDump = JSON.stringify(warnSpy.mock.calls);
    const conditionDump = JSON.stringify(contextArg);
    expect(warnDump).not.toContain(secretValue);
    expect(conditionDump).not.toContain(secretValue);
  });
});
