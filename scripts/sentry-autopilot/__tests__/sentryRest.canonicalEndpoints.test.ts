import { afterEach, describe, expect, it, vi } from 'vitest';

import type { AutopilotConfig } from '../config.ts';
import {
  fetchIssueEvents,
  fetchIssueHashes,
  fetchIssueLatestEvent,
  fetchReleases,
} from '../sentryRest.ts';

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

describe('Sentry REST canonical endpoint helpers', () => {
  it('fetches latest event, events, hashes, and releases with canonical URLs and auth headers', async () => {
    const calls: Array<{ url: string; headers: HeadersInit | undefined }> = [];
    installFetchStub(async (url, init) => {
      calls.push({ url: String(url), headers: init?.headers });
      if (String(url).includes('/events/latest/')) {
        return new Response(JSON.stringify({ id: 'event-latest' }), { status: 200 });
      }
      return new Response(JSON.stringify([{ id: 'list-item' }]), { status: 200 });
    });

    const config = makeConfig();

    await expect(fetchIssueLatestEvent('REBEL-123', config)).resolves.toEqual({ id: 'event-latest' });
    await expect(fetchIssueEvents('REBEL-123', config)).resolves.toEqual([{ id: 'list-item' }]);
    await expect(fetchIssueEvents('REBEL-123', config, { full: false, limit: 3 })).resolves.toEqual([
      { id: 'list-item' },
    ]);
    await expect(fetchIssueHashes('REBEL-123', config)).resolves.toEqual([{ id: 'list-item' }]);
    await expect(fetchReleases(config)).resolves.toEqual([{ id: 'list-item' }]);
    await expect(fetchReleases(config, { org: 'other-org', perPage: 7 })).resolves.toEqual([
      { id: 'list-item' },
    ]);

    expect(calls.map((call) => call.url)).toEqual([
      'https://us.sentry.io/api/0/issues/REBEL-123/events/latest/',
      'https://us.sentry.io/api/0/issues/REBEL-123/events/?full=true&limit=10',
      'https://us.sentry.io/api/0/issues/REBEL-123/events/?full=false&limit=3',
      'https://us.sentry.io/api/0/issues/REBEL-123/hashes/',
      'https://us.sentry.io/api/0/organizations/mindstone/releases/?per_page=20',
      'https://us.sentry.io/api/0/organizations/other-org/releases/?per_page=7',
    ]);
    for (const call of calls) {
      expect(call.headers).toMatchObject({
        Authorization: 'Bearer sentry-token',
        Accept: 'application/json',
      });
    }
  });

  it.each([
    { status: 401, statusText: 'Unauthorized' },
    { status: 404, statusText: 'Not Found' },
  ])('throws and does not swallow $status responses', async ({ status, statusText }) => {
    installFetchStub(async () => new Response('nope', { status, statusText }));

    await expect(fetchIssueLatestEvent('missing-id', makeConfig())).rejects.toThrow(
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

    await expect(fetchIssueEvents('rate-limited', makeConfig())).rejects.toThrow(
      /Sentry API rate limit exceeded; retry after 12s; limits: 12:error:organization; body: slow down/,
    );
  });

  it('preserves the shared remaining=0 handling for successful canonical endpoint responses', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    installFetchStub(async () =>
      new Response(JSON.stringify([{ id: 'last-page' }]), {
        status: 200,
        headers: {
          'Content-Type': 'application/json',
          'x-sentry-rate-limit-remaining': '0',
          'x-sentry-rate-limit-reset': '2026-06-07T15:00:00Z',
        },
      }),
    );

    const result = await fetchIssueHashes('last-page', makeConfig());

    expect(result).toEqual([{ id: 'last-page' }]);
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

    const promise = fetchReleases(makeConfig());
    const expectation = expect(promise).rejects.toThrow(
      'Sentry API request timed out after 30000ms: https://us.sentry.io/api/0/organizations/mindstone/releases/?per_page=20',
    );
    await vi.advanceTimersByTimeAsync(30_000);

    await expectation;
  });

  it('does not swallow fetch failures', async () => {
    installFetchStub(async () => {
      throw new Error('network down');
    });

    await expect(fetchIssueHashes('network-error', makeConfig())).rejects.toThrow('network down');
  });
});
