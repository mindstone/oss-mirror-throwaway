import { afterEach, describe, expect, it, vi } from 'vitest';

import type { AutopilotConfig } from '../config.ts';
import { fetchIssueDetail } from '../sentryRest.ts';

type FetchStub = (url: string | URL | Request, init?: RequestInit) => Promise<Response>;

function installFetchStub(stub: FetchStub): void {
  vi.stubGlobal('fetch', vi.fn(stub));
}

function makeConfig(): AutopilotConfig {
  return {
    sentryAuthToken: 'sentry-token',
    sentryOrg: 'mindstone',
    sentryProject: 'rebel',
    linearApiKey: undefined,
    slackWebhook: undefined,
    phase: 'shadow',
    verifyMode: 'disabled',
    pushMode: 'disabled',
    pendingMode: 'enforce',
    stateDir: '/tmp/sentry-autopilot',
    maxConcurrent: 1,
    maxHourly: 1,
    maxDaily: 1,
    maxRetries: 2,
    sessionTimeoutSeconds: 60,
    bootstrapLookbackHours: 24,
    repoRoot: '/tmp/repo',
    cli: 'droid',
    cursorModel: 'composer-2.5',
    claudeModel: 'claude-opus-4-8',
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('fetchIssueDetail', () => {
  it('fetches the issue detail endpoint with the Sentry bearer token', async () => {
    const calls: Array<{ url: string; headers: HeadersInit | undefined }> = [];
    installFetchStub(async (url, init) => {
      calls.push({ url: String(url), headers: init?.headers });
      return new Response(
        JSON.stringify({
          id: '12345',
          title: 'Detail issue',
          firstRelease: { version: 'v0.4.43' },
          lastRelease: { version: 'v0.4.45' },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    });

    const result = await fetchIssueDetail('12345', makeConfig());

    expect(result.id).toBe('12345');
    expect(result.firstRelease).toEqual({ version: 'v0.4.43' });
    expect(result.lastRelease).toEqual({ version: 'v0.4.45' });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('https://us.sentry.io/api/0/issues/12345/');
    expect(calls[0].headers).toMatchObject({
      Authorization: 'Bearer sentry-token',
      Accept: 'application/json',
    });
  });

  it.each([
    { status: 401, statusText: 'Unauthorized' },
    { status: 404, statusText: 'Not Found' },
  ])('throws and does not swallow $status responses', async ({ status, statusText }) => {
    installFetchStub(async () => new Response('nope', { status, statusText }));

    await expect(fetchIssueDetail('missing-id', makeConfig())).rejects.toThrow(
      `Sentry API request failed (${status} ${statusText})`,
    );
  });

  it('includes Sentry rate-limit headers in 429 errors', async () => {
    installFetchStub(async () =>
      new Response('slow down', {
        status: 429,
        statusText: 'Too Many Requests',
        headers: {
          'retry-after': '12',
          'x-sentry-rate-limits': '12:error:organization',
        },
      }),
    );

    await expect(fetchIssueDetail('rate-limited', makeConfig())).rejects.toThrow(
      /Sentry API rate limit exceeded; retry after 12s; limits: 12:error:organization; body: slow down/,
    );
  });

  it('preserves the shared remaining=0 handling for successful responses', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    installFetchStub(async () =>
      new Response(JSON.stringify({ id: 'last-page' }), {
        status: 200,
        headers: {
          'Content-Type': 'application/json',
          'x-sentry-rate-limit-remaining': '0',
          'x-sentry-rate-limit-reset': '2026-06-07T15:00:00Z',
        },
      }),
    );

    const result = await fetchIssueDetail('last-page', makeConfig());

    expect(result.id).toBe('last-page');
    expect(warn).toHaveBeenCalledWith(
      JSON.stringify({
        level: 'warn',
        component: 'sentry-autopilot-poller',
        message: 'Sentry API quota exhausted after current page; stopping pagination gracefully',
        reset: '2026-06-07T15:00:00Z',
      }),
    );
  });

  it('turns AbortError into the standard timeout error', async () => {
    vi.useFakeTimers();
    installFetchStub(async (_url, init) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          const error = new Error('aborted');
          error.name = 'AbortError';
          reject(error);
        });
      }),
    );

    const promise = fetchIssueDetail('timeout-id', makeConfig());
    const expectation = expect(promise).rejects.toThrow(
      'Sentry API request timed out after 30000ms: https://us.sentry.io/api/0/issues/timeout-id/',
    );
    await vi.advanceTimersByTimeAsync(30_000);

    await expectation;
  });

  it('does not swallow fetch failures', async () => {
    installFetchStub(async () => {
      throw new Error('network down');
    });

    await expect(fetchIssueDetail('network-error', makeConfig())).rejects.toThrow('network down');
  });
});
