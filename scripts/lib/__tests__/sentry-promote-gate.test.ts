import { describe, expect, it } from 'vitest';

import {
  buildBetaSentryRelease,
  buildBlockingIssuesQuery,
  evaluateSentryGate,
  type FetchSentry,
  type FetchSentryInit,
  type FetchSentryResult,
} from '../sentry-promote-gate';

// SAFETY: every test injects fetchSentry + env. No real Sentry/network.

const BETA_VERSION = '0.4.494282';
const RELEASE = `mindstone-rebel-beta@${BETA_VERSION}`;
const TOKEN = 'sntrys-test-token';

type RecordingFetch = FetchSentry & {
  calls: Array<{ url: string; init?: FetchSentryInit }>;
};

function makeFetch(rules: Array<[string, FetchSentryResult]>): RecordingFetch {
  const calls: Array<{ url: string; init?: FetchSentryInit }> = [];
  const fn = (async (url: string, init?: FetchSentryInit): Promise<FetchSentryResult> => {
    calls.push({ url, init });
    for (const [needle, result] of rules) {
      if (url.includes(needle)) return result;
    }
    return { ok: false, status: 500, error: `unstubbed: ${url}` };
  }) as RecordingFetch;
  fn.calls = calls;
  return fn;
}

function makeThrowingFetch(error: Error): RecordingFetch {
  const calls: Array<{ url: string; init?: FetchSentryInit }> = [];
  const fn = (async (url: string, init?: FetchSentryInit): Promise<FetchSentryResult> => {
    calls.push({ url, init });
    throw error;
  }) as RecordingFetch;
  fn.calls = calls;
  return fn;
}

function makeIssuesThrowingFetch(error: Error): RecordingFetch {
  const calls: Array<{ url: string; init?: FetchSentryInit }> = [];
  const fn = (async (url: string, init?: FetchSentryInit): Promise<FetchSentryResult> => {
    calls.push({ url, init });
    if (url.includes('/releases/')) return releaseObserved();
    if (url.includes('/issues/')) throw error;
    return { ok: false, status: 500, error: `unstubbed: ${url}` };
  }) as RecordingFetch;
  fn.calls = calls;
  return fn;
}

function env(value = TOKEN): (key: string) => string | undefined {
  return (key) => (key === 'SENTRY_AUTH_TOKEN' ? value : undefined);
}

function releaseObserved(): FetchSentryResult {
  return { ok: true, status: 200, json: { version: RELEASE } };
}

function issues(rows: unknown[]): FetchSentryResult {
  return { ok: true, status: 200, json: rows };
}

function issue(shortId = 'REBEL-123'): unknown {
  return {
    id: '4500000000000000',
    shortId,
    title: 'Fatal startup regression',
    level: 'fatal',
  };
}

function gate(fetchSentry: RecordingFetch, token = TOKEN) {
  return evaluateSentryGate(
    {
      fetchSentry,
      getEnv: env(token),
    },
    { betaPublishedVersion: BETA_VERSION }
  );
}

describe('Sentry promote gate helpers', () => {
  it('builds the beta release tag and blocking issue query used by the gate', () => {
    expect(buildBetaSentryRelease(BETA_VERSION)).toBe(RELEASE);
    expect(buildBlockingIssuesQuery(RELEASE)).toBe(`is:unresolved release:${RELEASE} level:[error,fatal]`);
  });
});

describe('evaluateSentryGate', () => {
  it('passes when the release is observed and no blocking issues match', async () => {
    const fetchSentry = makeFetch([
      ['/releases/', releaseObserved()],
      ['/issues/', issues([])],
    ]);

    const result = await gate(fetchSentry);

    expect(result).toEqual({
      sentryClean: true,
      releaseObserved: true,
      blockingIssues: 0,
      reasons: [
        'Sentry release tag is observed.',
        'No unresolved error/fatal issues matched the exact beta release in the Sentry issues window.',
        'This is pass-no-blocking-signal only: soak/exposure is NOT evaluated, and morning review remains the response window.',
      ],
    });
    expect(fetchSentry.calls).toHaveLength(2);
    expect(fetchSentry.calls[0]?.url).toBe(
      `https://us.sentry.io/api/0/projects/mindstone/rebel/releases/mindstone-rebel-beta%40${BETA_VERSION}/`
    );
    const issuesUrl = new URL(fetchSentry.calls[1]?.url ?? '');
    expect(issuesUrl.origin).toBe('https://us.sentry.io');
    expect(issuesUrl.pathname).toBe('/api/0/projects/mindstone/rebel/issues/');
    expect(issuesUrl.searchParams.get('query')).toBe(`is:unresolved release:${RELEASE} level:[error,fatal]`);
    expect(issuesUrl.searchParams.get('statsPeriod')).toBe('24h');
    expect(issuesUrl.searchParams.get('limit')).toBe('100');
    expect(fetchSentry.calls[1]?.init?.headers?.Authorization).toBe(`Bearer ${TOKEN}`);
  });

  it('blocks when the exact release is not observed, distinguishing no signal from safe', async () => {
    const fetchSentry = makeFetch([
      ['/releases/', { ok: false, status: 404, error: 'not found' }],
      ['/issues/', issues([])],
    ]);

    const result = await gate(fetchSentry);

    expect(result.sentryClean).toBe(false);
    expect(result.releaseObserved).toBe(false);
    expect(result.blockingIssues).toBeNull();
    expect(result.reasons.join('\n')).toContain('does not report the exact beta release tag');
    expect(result.reasons.join('\n')).toContain('no signal, not safety');
    expect(fetchSentry.calls).toHaveLength(1);
  });

  it('blocks when one or more unresolved error/fatal issues match the release', async () => {
    const fetchSentry = makeFetch([
      ['/releases/', releaseObserved()],
      ['/issues/', issues([issue('REBEL-999')])],
    ]);

    const result = await gate(fetchSentry);

    expect(result.sentryClean).toBe(false);
    expect(result.releaseObserved).toBe(true);
    expect(result.blockingIssues).toBe(1);
    expect(result.reasons.join('\n')).toContain('1 unresolved error/fatal issue');
    expect(result.reasons.join('\n')).toContain('one or more unresolved error/fatal issues blocks promotion');
  });

  it('fails closed when SENTRY_AUTH_TOKEN is missing or empty', async () => {
    const missingFetch = makeFetch([]);
    const missing = await evaluateSentryGate(
      {
        fetchSentry: missingFetch,
        getEnv: () => undefined,
      },
      { betaPublishedVersion: BETA_VERSION }
    );
    const emptyFetch = makeFetch([]);
    const empty = await gate(emptyFetch, '   ');

    expect(missing.sentryClean).toBeNull();
    expect(missing.releaseObserved).toBeNull();
    expect(missing.blockingIssues).toBeNull();
    expect(missing.reasons.join('\n')).toContain('Missing SENTRY_AUTH_TOKEN');
    expect(missingFetch.calls).toHaveLength(0);
    expect(empty.sentryClean).toBeNull();
    expect(emptyFetch.calls).toHaveLength(0);
  });

  it('fails closed on HTTP 401 from Sentry', async () => {
    const fetchSentry = makeFetch([
      ['/releases/', { ok: false, status: 401, error: 'unauthorized' }],
    ]);

    const result = await gate(fetchSentry);

    expect(result.sentryClean).toBeNull();
    expect(result.releaseObserved).toBeNull();
    expect(result.blockingIssues).toBeNull();
    expect(result.reasons.join('\n')).toContain('HTTP 401');
  });

  it('fails closed on HTTP 403 from Sentry', async () => {
    const fetchSentry = makeFetch([
      ['/releases/', { ok: false, status: 403, error: 'forbidden' }],
    ]);

    const result = await gate(fetchSentry);

    expect(result.sentryClean).toBeNull();
    expect(result.releaseObserved).toBeNull();
    expect(result.blockingIssues).toBeNull();
    expect(result.reasons.join('\n')).toContain('HTTP 403');
  });

  it('fails closed on HTTP 403 from the blocking issues query', async () => {
    const fetchSentry = makeFetch([
      ['/releases/', releaseObserved()],
      ['/issues/', { ok: false, status: 403, error: 'forbidden' }],
    ]);

    const result = await gate(fetchSentry);

    expect(result.sentryClean).toBeNull();
    expect(result.releaseObserved).toBe(true);
    expect(result.blockingIssues).toBeNull();
    expect(result.reasons.join('\n')).toContain('Sentry release tag is observed.');
    expect(result.reasons.join('\n')).toContain('Sentry blocking issues query failed with HTTP 403');
  });

  it('fails closed on a network error or timeout', async () => {
    const fetchSentry = makeThrowingFetch(new Error('network timeout'));

    const result = await gate(fetchSentry);

    expect(result.sentryClean).toBeNull();
    expect(result.releaseObserved).toBeNull();
    expect(result.blockingIssues).toBeNull();
    expect(result.reasons.join('\n')).toContain('network timeout');
  });

  it('fails closed on a network error from the blocking issues query', async () => {
    const fetchSentry = makeIssuesThrowingFetch(new Error('issues timeout'));

    const result = await gate(fetchSentry);

    expect(result.sentryClean).toBeNull();
    expect(result.releaseObserved).toBe(true);
    expect(result.blockingIssues).toBeNull();
    expect(result.reasons.join('\n')).toContain('Sentry release tag is observed.');
    expect(result.reasons.join('\n')).toContain('issues timeout');
  });

  it('fails closed on malformed or non-JSON Sentry responses', async () => {
    const fetchSentry = makeFetch([
      ['/releases/', { ok: false, error: 'invalid JSON response from Sentry' }],
    ]);

    const result = await gate(fetchSentry);

    expect(result.sentryClean).toBeNull();
    expect(result.releaseObserved).toBeNull();
    expect(result.blockingIssues).toBeNull();
    expect(result.reasons.join('\n')).toContain('invalid JSON response from Sentry');
  });

  it('fails closed when the release observation response has an unexpected shape', async () => {
    const fetchSentry = makeFetch([
      ['/releases/', { ok: true, status: 200, json: { slug: RELEASE } }],
    ]);

    const result = await gate(fetchSentry);

    expect(result.sentryClean).toBeNull();
    expect(result.releaseObserved).toBeNull();
    expect(result.blockingIssues).toBeNull();
    expect(result.reasons.join('\n')).toContain('unexpected response shape');
  });

  it('fails closed when the blocking issues response has an unexpected shape', async () => {
    const fetchSentry = makeFetch([
      ['/releases/', releaseObserved()],
      ['/issues/', { ok: true, status: 200, json: { data: [] } }],
    ]);

    const result = await gate(fetchSentry);

    expect(result.sentryClean).toBeNull();
    expect(result.releaseObserved).toBe(true);
    expect(result.blockingIssues).toBeNull();
    expect(result.reasons.join('\n')).toContain('blocking issues query returned an unexpected response shape');
  });

  it('fails closed when a blocking issues row has an unexpected shape', async () => {
    const fetchSentry = makeFetch([
      ['/releases/', releaseObserved()],
      ['/issues/', issues([{ level: 'fatal', title: 'Missing id and shortId' }])],
    ]);

    const result = await gate(fetchSentry);

    expect(result.sentryClean).toBeNull();
    expect(result.releaseObserved).toBe(true);
    expect(result.blockingIssues).toBeNull();
    expect(result.reasons.join('\n')).toContain('issue rows with an unexpected shape');
  });

  it('uses a relative stats window when no absolute start timestamp is provided', async () => {
    const fetchSentry = makeFetch([
      ['/releases/', releaseObserved()],
      ['/issues/', issues([])],
    ]);

    const result = await evaluateSentryGate(
      {
        fetchSentry,
        getEnv: env(),
      },
      { betaPublishedVersion: BETA_VERSION, statsPeriod: '14d' }
    );

    expect(result.sentryClean).toBe(true);
    const issuesUrl = new URL(fetchSentry.calls[1]?.url ?? '');
    expect(issuesUrl.searchParams.get('query')).toBe(`is:unresolved release:${RELEASE} level:[error,fatal]`);
    expect(issuesUrl.searchParams.get('statsPeriod')).toBe('14d');
    expect(issuesUrl.searchParams.has('start')).toBe(false);
  });

  it('uses an absolute start timestamp instead of statsPeriod when sinceIso is provided', async () => {
    const fetchSentry = makeFetch([
      ['/releases/', releaseObserved()],
      ['/issues/', issues([])],
    ]);
    const sinceIso = '2026-06-21T12:00:00.000Z';

    const result = await evaluateSentryGate(
      {
        fetchSentry,
        getEnv: env(),
      },
      { betaPublishedVersion: BETA_VERSION, statsPeriod: '14d', sinceIso }
    );

    expect(result.sentryClean).toBe(true);
    const issuesUrl = new URL(fetchSentry.calls[1]?.url ?? '');
    expect(issuesUrl.searchParams.get('query')).toBe(`is:unresolved release:${RELEASE} level:[error,fatal]`);
    expect(issuesUrl.searchParams.get('start')).toBe(sinceIso);
    expect(issuesUrl.searchParams.has('statsPeriod')).toBe(false);
  });
});
