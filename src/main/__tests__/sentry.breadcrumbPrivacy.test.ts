/**
 * Behavioural privacy contract test for the MAIN-process Sentry breadcrumb
 * hook (rec e8590f9c9fb4f8d1; postmortem
 * docs-private/postmortems/260607_allowlist_log_breadcrumbs_scrub_server_name_4c77a28_postmortem.md).
 *
 * The 158-day leak shipped proprietary user content (calendar entry titles
 * and times under `sampleMeetings`, plus `providers` / `headerNames`) inside
 * `category: 'log'` breadcrumb `data` because the hook used generic
 * pattern/key redaction (`redactObjectDeep`) instead of the deny-by-default
 * log allowlist. The shipped static check
 * (scripts/check-sentry-breadcrumb-scrub.ts) pins the SOURCE SHAPE of the
 * branch; nothing executed the WIRING. This test captures the real
 * `Sentry.init` options (envParity pattern: mock the SDK module, run the
 * real init) and drives the ACTUAL `beforeBreadcrumb` hook with hostile
 * payloads, asserting on the final breadcrumb the SDK would receive.
 *
 * HONESTY / RESIDUAL: the value returned from `beforeBreadcrumb` is the
 * app-controlled final-payload boundary. Anything the Sentry SDK does to the
 * breadcrumb AFTER the hook returns (internal normalization, truncation,
 * envelope serialization) is out of app control and NOT covered here — there
 * is no app seam past this point.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Breadcrumb } from '@sentry/core';

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

type BeforeBreadcrumbHook = (breadcrumb: Breadcrumb) => Breadcrumb | null;

/** Init main Sentry against the mocked SDK and return the REAL hook it registered. */
const captureBeforeBreadcrumb = async (): Promise<BeforeBreadcrumbHook> => {
  const { initMainSentry } = await import('../sentry');
  initMainSentry();
  expect(sentryInitMock).toHaveBeenCalledTimes(1);
  const options = sentryInitMock.mock.calls[0]?.[0] as {
    beforeBreadcrumb?: BeforeBreadcrumbHook;
  };
  expect(typeof options.beforeBreadcrumb).toBe('function');
  return options.beforeBreadcrumb as BeforeBreadcrumbHook;
};

describe('main Sentry beforeBreadcrumb privacy contract', () => {
  let infoSpy: ReturnType<typeof vi.spyOn>;
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    vi.unstubAllEnvs();
    // src/main/sentry.ts swaps in a no-op SDK stub when VITEST === 'true'
    // (createStubSentryMain). Force the "real" branch so the vi.mock'd SDK —
    // and therefore the real init options — are exercised (envParity pattern).
    vi.stubEnv('VITEST', 'false');
    vi.stubEnv('SENTRY_DSN', 'https://public@example.invalid/1');
    // Neutralize CI/E2E detection for deterministic environment resolution.
    vi.stubEnv('SENTRY_ENVIRONMENT', '');
    vi.stubEnv('CI', '');
    vi.stubEnv('GITHUB_ACTIONS', '');
    vi.stubEnv('REBEL_E2E_TEST_MODE', '');
    vi.stubEnv('REBEL_TEST_USER_DATA_DIR', '');
    infoSpy = vi.spyOn(console, 'info').mockImplementation(() => {});
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    infoSpy.mockRestore();
    logSpy.mockRestore();
    vi.unstubAllEnvs();
  });

  it("category 'log': deny-by-default allowlist — hostile benign-key content is GONE, not just redacted", async () => {
    const beforeBreadcrumb = await captureBeforeBreadcrumb();

    // The incident shape: proprietary content under benign keys. A real
    // shipped Sentry event carried calendar entries/times (`sampleMeetings`)
    // plus `providers` and `headerNames` in a category:'log' breadcrumb.
    const result = beforeBreadcrumb({
      category: 'log',
      level: 'info',
      message: 'calendar scan complete',
      data: {
        // Incident payload (verbatim shape from the postmortem evidence)
        sampleMeetings: [
          { title: 'Acme Corp acquisition sync', time: '2026-06-09T14:00:00Z' },
          { title: '1:1 Greg / candidate interview (Jane Doe)', time: '2026-06-09T16:30:00Z' },
        ],
        providers: ['google-workspace', 'microsoft-365'],
        headerNames: ['x-goog-meeting-token', 'x-ms-tenant'],
        // Classic benign-key user content from the regression-test family
        title: 'Project Falcon — confidential roadmap',
        query: 'salary bands engineering 2026',
        filename: 'layoffs-draft-v2.docx',
        projectName: 'Stealth Acquisition Target',
        // Allowlisted operational fields that MUST survive (proves the hook
        // filters rather than nuking data wholesale)
        component: 'calendarService',
        durationMs: 412,
        count: 7,
        turnId: '7e0a4a4e-2f55-4a44-9c3e-1f1f6f8d2a10',
      },
    });

    expect(result).not.toBeNull();
    const data = result?.data as Record<string, unknown>;
    expect(data).toBeDefined();

    // Deny-by-default: every hostile key must be ABSENT from the final
    // breadcrumb — not present-with-redacted-values.
    for (const hostileKey of [
      'sampleMeetings',
      'providers',
      'headerNames',
      'title',
      'query',
      'filename',
      'projectName',
    ]) {
      expect(data, `hostile key '${hostileKey}' must be dropped`).not.toHaveProperty(hostileKey);
    }
    // Belt-and-braces: the content itself must not survive anywhere in the
    // final breadcrumb (catches a future "redact-in-place" regression that
    // keeps values under renamed keys).
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain('Acme Corp');
    expect(serialized).not.toContain('Jane Doe');
    expect(serialized).not.toContain('Project Falcon');
    expect(serialized).not.toContain('salary bands');
    expect(serialized).not.toContain('layoffs-draft');
    expect(serialized).not.toContain('Stealth Acquisition');
    expect(serialized).not.toContain('x-goog-meeting-token');

    // Allowlisted operational fields pass through unchanged.
    expect(data.component).toBe('calendarService');
    expect(data.durationMs).toBe(412);
    expect(data.count).toBe(7);
    expect(data.turnId).toBe('7e0a4a4e-2f55-4a44-9c3e-1f1f6f8d2a10');
  });

  it("category 'log': sanitized fields (msg/err) survive with content stripped", async () => {
    const beforeBreadcrumb = await captureBeforeBreadcrumb();

    const result = beforeBreadcrumb({
      category: 'log',
      level: 'error',
      data: {
        msg: 'Auto-title failed for "My secret project meeting notes"',
        secretPayload: 'raw user content',
      },
    });

    const data = result?.data as Record<string, unknown>;
    // `msg` is a SANITIZED_LOG_FIELDS member: kept, content-stripped.
    expect(typeof data.msg).toBe('string');
    expect(data.msg as string).not.toContain('My secret project meeting notes');
    expect(data).not.toHaveProperty('secretPayload');
  });

  it('non-log categories: pattern redaction still runs over data (secrets scrubbed, keys kept)', async () => {
    const beforeBreadcrumb = await captureBeforeBreadcrumb();

    // NOTE: no `sk-*`-shaped fake keys here — the key-prefix drift gate
    // rejects them in test surfaces.
    // Bearer tokens + emails exercise the same redactSensitiveString path.
    const bearerToken = 'bearer fake-breadcrumb-privacy-token-12345';
    const result = beforeBreadcrumb({
      category: 'http',
      level: 'info',
      data: {
        url: 'https://api.example.invalid/v1/messages',
        authHeader: bearerToken,
        contactEmail: '[external-email]',
        statusCode: 200,
      },
    });

    const data = result?.data as Record<string, unknown>;
    // Non-log categories keep their key structure — this is pattern
    // redaction, NOT the allowlist (the contract under test is the branch).
    expect(data).toHaveProperty('url');
    expect(data).toHaveProperty('authHeader');
    expect(data).toHaveProperty('statusCode');
    // ...but secret/PII patterns are scrubbed from the values.
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain('fake-breadcrumb-privacy-token-12345');
    expect(serialized).not.toContain('[external-email]');
    expect(data.statusCode).toBe(200);
  });

  it('breadcrumb messages run through redactSensitiveString for every category', async () => {
    const beforeBreadcrumb = await captureBeforeBreadcrumb();

    const logResult = beforeBreadcrumb({
      category: 'log',
      message: 'sync failed for user-id [external-email]',
    });
    expect(logResult?.message).toBeDefined();
    expect(logResult?.message).not.toContain('[external-email]');

    const otherResult = beforeBreadcrumb({
      category: 'console',
      message: 'token refresh for [external-email] done',
    });
    expect(otherResult?.message).toBeDefined();
    expect(otherResult?.message).not.toContain('[external-email]');
  });

  it('breadcrumbs without data pass through (no synthesized data property)', async () => {
    const beforeBreadcrumb = await captureBeforeBreadcrumb();

    const result = beforeBreadcrumb({ category: 'log', message: 'plain operational note' });

    expect(result).not.toBeNull();
    expect(result?.data).toBeUndefined();
  });
});
