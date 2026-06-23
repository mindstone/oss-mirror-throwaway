/**
 * Stage E — Reporter.executePrOpen GitHub REST API tests.
 *
 * The PR creator hits two endpoints:
 *   1. `GET /repos/{owner}/{repo}/pulls?head=<owner>:<branch>&state=open`
 *      — idempotency probe: if a PR already exists for this head we return
 *      its URL without POSTing.
 *   2. `POST /repos/{owner}/{repo}/pulls` — create the PR otherwise.
 *
 * Covers:
 *   - Missing credentials throw before any HTTP call.
 *   - Idempotency probe finds an existing PR → returns url, no POST.
 *   - Idempotency probe is empty → POST happens; success returns the new url.
 *   - POST 4xx (non-422) surfaces as a PermanentHttpError via classifyHttpError.
 *   - POST 5xx surfaces as a TransientHttpError so the drainer retries.
 *   - POST 422 with head-related body → TransientHttpError (branch not on
 *     origin yet — common when pr_open is enqueued before the bugfixer's
 *     push lands).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AutopilotConfig } from '../config.ts';
import { Reporter } from '../reporter.ts';
import type { IssueRow } from '../state.ts';

function makeConfig(overrides: Partial<AutopilotConfig> = {}): AutopilotConfig {
  return {
    sentryAuthToken: 'test-token',
    sentryOrg: 'mindstone',
    sentryProject: 'rebel',
    linearApiKey: undefined,
    slackWebhook: undefined,
    githubToken: 'ghp_TEST_TOKEN',
    repoFullName: 'mindstone/rebel-app',
    phase: 'shadow',
    verifyMode: 'enforce',
    pushMode: 'pr',
    pendingMode: 'enforce',
    stateDir: '/tmp/sentry-autopilot-pr-tests',
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
    ...overrides,
  };
}

function makeIssue(): IssueRow {
  const now = new Date().toISOString();
  return {
    sentry_id: 'SENTRY-PR',
    sentry_url: 'https://sentry.io/issues/SENTRY-PR',
    title: 'PR creation test issue',
    error_type: 'exception',
    is_user_reported: false,
    occurrences: 1,
    users: 1,
    status: 'completed',
    dispatch_count: 1,
    max_retries: 2,
    confidence: 95,
    outcome: 'auto_committed',
    last_error: null,
    commit_hash: 'abc1234',
    plan_file: null,
    linear_issue_id: null,
    tmux_session: null,
    worktree_slot: null,
    user_description: null,
    pending_actions: null,
    verification_status: 'pass',
    verification_details: null,
    branch_name: 'autopilot/sentry-PR',
    pr_url: null,
    pushed_at: null,
    created_at: now,
    updated_at: now,
    dispatched_at: null,
    completed_at: now,
  };
}

const PAYLOAD = {
  branch_name: 'autopilot/sentry-PR',
  base: 'dev' as const,
  title: '[Autopilot] PR creation test (SENTRY-PR)',
  body: '> Opened by the Sentry → CHIEF_BUGFIXER autopilot.\n\nDiagnosis here.',
};

type FetchStub = (url: string | URL | Request, init?: RequestInit) => Promise<Response>;

function installFetchStub(stub: FetchStub): void {
  vi.stubGlobal('fetch', vi.fn(stub));
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('Reporter.executePrOpen', () => {
  let reporter: Reporter;

  beforeEach(() => {
    reporter = new Reporter(makeConfig());
  });

  it('throws when githubToken is missing', async () => {
    reporter = new Reporter(makeConfig({ githubToken: undefined }));
    await expect(reporter.executePrOpen(makeIssue(), PAYLOAD)).rejects.toThrow(/githubToken/);
  });

  it('throws when repoFullName is missing', async () => {
    reporter = new Reporter(makeConfig({ repoFullName: undefined }));
    await expect(reporter.executePrOpen(makeIssue(), PAYLOAD)).rejects.toThrow(/repoFullName/);
  });

  it('returns the existing PR URL when the idempotency probe finds an open PR', async () => {
    const calls: string[] = [];
    installFetchStub(async (url, init) => {
      const u = String(url);
      const method = init?.method ?? 'GET';
      calls.push(`${method} ${u}`);
      if (method === 'GET' && u.includes('/pulls?head=')) {
        return new Response(
          JSON.stringify([{ html_url: 'https://github.com/mindstone/rebel-app/pull/42' }]),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }
      throw new Error(`Unexpected ${method} to ${u}`);
    });

    const result = await reporter.executePrOpen(makeIssue(), PAYLOAD);
    expect(result.url).toBe('https://github.com/mindstone/rebel-app/pull/42');
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatch(
      /^GET https:\/\/api\.github\.com\/repos\/mindstone\/rebel-app\/pulls\?head=mindstone:autopilot%2Fsentry-PR&state=open$/,
    );
  });

  it('POSTs a new PR when no existing one matches the head', async () => {
    const calls: Array<{ method: string; url: string; body?: unknown }> = [];
    installFetchStub(async (url, init) => {
      const u = String(url);
      const method = init?.method ?? 'GET';
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      calls.push({ method, url: u, body });
      if (method === 'GET') {
        return new Response('[]', {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      // POST → return a new PR
      return new Response(
        JSON.stringify({ html_url: 'https://github.com/mindstone/rebel-app/pull/99' }),
        { status: 201, headers: { 'Content-Type': 'application/json' } },
      );
    });

    const result = await reporter.executePrOpen(makeIssue(), PAYLOAD);
    expect(result.url).toBe('https://github.com/mindstone/rebel-app/pull/99');
    expect(calls).toHaveLength(2);
    expect(calls[0].method).toBe('GET');
    expect(calls[1].method).toBe('POST');
    expect(calls[1].url).toBe('https://api.github.com/repos/mindstone/rebel-app/pulls');
    expect(calls[1].body).toMatchObject({
      title: PAYLOAD.title,
      body: PAYLOAD.body,
      head: 'autopilot/sentry-PR',
      base: 'dev',
    });
  });

  it('treats POST 422 with head-error body as transient (branch not on origin yet)', async () => {
    installFetchStub(async (url, init) => {
      const method = init?.method ?? 'GET';
      if (method === 'GET') {
        return new Response('[]', { status: 200 });
      }
      return new Response(
        JSON.stringify({
          message: 'Validation Failed',
          errors: [{ resource: 'PullRequest', field: 'head', code: 'invalid' }],
        }),
        { status: 422 },
      );
    });

    await expect(reporter.executePrOpen(makeIssue(), PAYLOAD)).rejects.toThrow(
      /branch likely not on origin yet/,
    );
  });

  it('surfaces non-422 POST 4xx as a permanent error', async () => {
    installFetchStub(async (url, init) => {
      const method = init?.method ?? 'GET';
      if (method === 'GET') return new Response('[]', { status: 200 });
      return new Response('{"message":"Forbidden"}', { status: 403 });
    });

    await expect(reporter.executePrOpen(makeIssue(), PAYLOAD)).rejects.toThrow(
      /GitHub PR create failed \(403/,
    );
  });

  it('surfaces 5xx POST errors as transient', async () => {
    installFetchStub(async (url, init) => {
      const method = init?.method ?? 'GET';
      if (method === 'GET') return new Response('[]', { status: 200 });
      return new Response('Service unavailable', { status: 503 });
    });

    await expect(reporter.executePrOpen(makeIssue(), PAYLOAD)).rejects.toThrow(
      /503/,
    );
  });

  it('throws when GitHub returns a 2xx but with malformed body', async () => {
    installFetchStub(async (url, init) => {
      const method = init?.method ?? 'GET';
      if (method === 'GET') return new Response('[]', { status: 200 });
      return new Response('{}', { status: 201 });
    });

    await expect(reporter.executePrOpen(makeIssue(), PAYLOAD)).rejects.toThrow(
      /html_url/,
    );
  });
});

describe('Reporter.probePrOpen', () => {
  it('returns null when credentials are missing (lets executor decide)', async () => {
    const reporter = new Reporter(
      makeConfig({ githubToken: undefined, repoFullName: undefined }),
    );
    const result = await reporter.probePrOpen('autopilot/sentry-PR');
    expect(result).toBeNull();
  });

  it('returns null when GitHub responds with an empty array', async () => {
    installFetchStub(async () => new Response('[]', { status: 200 }));
    const reporter = new Reporter(makeConfig());
    const result = await reporter.probePrOpen('autopilot/sentry-PR');
    expect(result).toBeNull();
  });

  it('returns the existing URL when GitHub responds with a hit', async () => {
    installFetchStub(
      async () =>
        new Response(
          JSON.stringify([{ html_url: 'https://github.com/mindstone/rebel-app/pull/7' }]),
          { status: 200 },
        ),
    );
    const reporter = new Reporter(makeConfig());
    const result = await reporter.probePrOpen('autopilot/sentry-PR');
    expect(result).toBe('https://github.com/mindstone/rebel-app/pull/7');
  });
});
