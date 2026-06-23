/**
 * Behavioural privacy contract test for the RENDERER Sentry breadcrumb hook
 * (rec e8590f9c9fb4f8d1; postmortem
 * docs-private/postmortems/260607_allowlist_log_breadcrumbs_scrub_server_name_4c77a28_postmortem.md).
 *
 * The renderer leg of the 158-day leak: `category: 'renderer.log'`
 * breadcrumbs (App.tsx renderer-log bridge) carried raw `payload.context`
 * scrubbed only by pattern redaction, so proprietary content under benign
 * keys shipped. The fix DROPS renderer-log breadcrumb `data` entirely (the
 * deny-by-default allowlist lives in @core and would cross the
 * renderer↔core boundary — see the comment in src/renderer/src/sentry.ts).
 * This test captures the real `Sentry.init` options (envParity pattern) and
 * drives the ACTUAL `beforeBreadcrumb` hook, asserting the final breadcrumb
 * the SDK would receive has NO data property at all for renderer.log.
 *
 * HONESTY / RESIDUAL: the value returned from `beforeBreadcrumb` is the
 * app-controlled final-payload boundary. SDK-internal mutation after the
 * hook returns (normalization, truncation, envelope serialization) is out
 * of app control and NOT covered here.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Breadcrumb } from '@sentry/core';

const electronSentryInitMock = vi.hoisted(() =>
  vi.fn((_options: unknown, reactInit?: (options: Record<string, unknown>) => void) => {
    reactInit?.({});
  }),
);
const reactSentryInitMock = vi.hoisted(() => vi.fn());

vi.mock('@sentry/electron/renderer', () => ({
  addBreadcrumb: vi.fn(),
  browserTracingIntegration: vi.fn(() => ({ name: 'browserTracing' })),
  captureException: vi.fn(),
  captureMessage: vi.fn(),
  feedbackIntegration: vi.fn(() => ({ name: 'feedback' })),
  init: electronSentryInitMock,
  setTag: vi.fn(),
  setUser: vi.fn(),
}));

vi.mock('@sentry/react', () => ({
  ErrorBoundary: 'SentryErrorBoundary',
  init: reactSentryInitMock,
}));

type BeforeBreadcrumbHook = (breadcrumb: Breadcrumb) => Breadcrumb | null;

/** Init renderer Sentry against the mocked SDK and return the REAL hook it registered. */
const captureBeforeBreadcrumb = async (): Promise<BeforeBreadcrumbHook> => {
  const { initRendererSentry } = await import('./sentry');
  initRendererSentry();
  expect(electronSentryInitMock).toHaveBeenCalledTimes(1);
  const options = electronSentryInitMock.mock.calls[0]?.[0] as {
    beforeBreadcrumb?: BeforeBreadcrumbHook;
  };
  expect(typeof options.beforeBreadcrumb).toBe('function');
  // The SAME hook must guard the React init leg — both clients receive
  // breadcrumbs, so a divergence here would reopen the leak on one client.
  const reactOptions = reactSentryInitMock.mock.calls[0]?.[0] as {
    beforeBreadcrumb?: BeforeBreadcrumbHook;
  };
  expect(reactOptions?.beforeBreadcrumb).toBe(options.beforeBreadcrumb);
  return options.beforeBreadcrumb as BeforeBreadcrumbHook;
};

describe('renderer Sentry beforeBreadcrumb privacy contract', () => {
  let infoSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    vi.unstubAllEnvs();
    vi.stubEnv('SENTRY_DSN', 'https://public@example.invalid/1');
    infoSpy = vi.spyOn(console, 'info').mockImplementation(() => {});
    vi.stubGlobal('window', {
      electronEnv: {
        appVersion: '1.0.0-test',
        buildChannel: 'dev',
      },
      location: { protocol: 'http:' },
      settingsApi: undefined,
    });
  });

  afterEach(() => {
    infoSpy.mockRestore();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("category 'renderer.log': data is dropped ENTIRELY — no key survives, redacted or not", async () => {
    const beforeBreadcrumb = await captureBeforeBreadcrumb();

    // Incident shape: proprietary content under benign keys riding the
    // renderer-log bridge's payload.context.
    const result = beforeBreadcrumb({
      category: 'renderer.log',
      level: 'info',
      message: 'meeting prep panel rendered',
      data: {
        sampleMeetings: [
          { title: 'Acme Corp acquisition sync', time: '2026-06-09T14:00:00Z' },
        ],
        providers: ['google-workspace'],
        headerNames: ['x-goog-meeting-token'],
        title: 'Project Falcon — confidential roadmap',
        query: 'salary bands engineering 2026',
        // Even operationally-shaped fields are dropped on the renderer leg:
        // the contract is delete-data, not allowlist (see module header).
        component: 'meetingPrepPanel',
        durationMs: 12,
      },
    });

    expect(result).not.toBeNull();
    // Deny-by-construction: the data property itself must be GONE.
    expect(result?.data).toBeUndefined();
    expect(Object.prototype.hasOwnProperty.call(result, 'data')).toBe(false);
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain('Acme Corp');
    expect(serialized).not.toContain('Project Falcon');
    expect(serialized).not.toContain('salary bands');
    expect(serialized).not.toContain('x-goog-meeting-token');
  });

  it('non-renderer.log categories: pattern redaction still runs over data (secrets scrubbed, keys kept)', async () => {
    const beforeBreadcrumb = await captureBeforeBreadcrumb();

    // NOTE: no `sk-*`-shaped fake keys here — the key-prefix drift gate
    // rejects them in test surfaces.
    const result = beforeBreadcrumb({
      category: 'ui.click',
      level: 'info',
      data: {
        target: 'button.send',
        authHeader: 'bearer fake-renderer-privacy-token-12345',
        contactEmail: '[external-email]',
        clickCount: 2,
      },
    });

    const data = result?.data as Record<string, unknown>;
    expect(data).toBeDefined();
    // Keys survive (pattern redaction, not the renderer-log drop)...
    expect(data).toHaveProperty('target');
    expect(data).toHaveProperty('authHeader');
    expect(data.clickCount).toBe(2);
    // ...values are scrubbed of secret/PII patterns.
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain('fake-renderer-privacy-token-12345');
    expect(serialized).not.toContain('[external-email]');
  });

  it('breadcrumb messages run through redactSensitiveString for every category', async () => {
    const beforeBreadcrumb = await captureBeforeBreadcrumb();

    const rendererLogResult = beforeBreadcrumb({
      category: 'renderer.log',
      message: 'profile loaded for [external-email]',
    });
    expect(rendererLogResult?.message).toBeDefined();
    expect(rendererLogResult?.message).not.toContain('[external-email]');

    const otherResult = beforeBreadcrumb({
      category: 'console',
      message: 'token refresh for [external-email] done',
    });
    expect(otherResult?.message).toBeDefined();
    expect(otherResult?.message).not.toContain('[external-email]');
  });

  it('breadcrumbs without data pass through (no synthesized data property)', async () => {
    const beforeBreadcrumb = await captureBeforeBreadcrumb();

    const result = beforeBreadcrumb({ category: 'renderer.log', message: 'plain note' });

    expect(result).not.toBeNull();
    expect(result?.data).toBeUndefined();
  });
});
