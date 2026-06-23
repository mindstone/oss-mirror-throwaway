/**
 * Reporter.executePrMerge + Reporter.probePrMerged tests.
 *
 * The auto-merge path:
 *   1. ACTION_DRAIN_ORDER drains pr_open immediately before pr_merge so the
 *      same drain pass that opens the PR also lands it.
 *   2. executePrOpen writes pr_url onto the IssueRow (drainer side effect).
 *   3. executePrMerge reads pr_url off the IssueRow, parses the PR number
 *      from its html_url, and PUTs `/repos/{owner}/{repo}/pulls/{n}/merge`
 *      with `{ merge_method: 'squash' }`.
 *   4. probePrMerged GETs the PR resource and returns whether `merged === true`.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AutopilotConfig } from '../config.ts';
import { parsePrNumberFromUrl, Reporter } from '../reporter.ts';
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
    stateDir: '/tmp/sentry-autopilot-prmerge-tests',
    maxConcurrent: 1,
    maxHourly: 1,
    maxDaily: 1,
    maxRetries: 2,
    sessionTimeoutSeconds: 60,
    bootstrapLookbackHours: 24,
    repoRoot: '/tmp/repo',
    cli: 'droid',
    cursorModel: 'composer-2.5',
    ...overrides,
  };
}

function makeIssue(prUrl: string | null = 'https://github.com/mindstone/rebel-app/pull/123'): IssueRow {
  const now = new Date().toISOString();
  return {
    sentry_id: 'SENTRY-MERGE',
    sentry_url: 'https://sentry.io/issues/SENTRY-MERGE',
    title: 'Merge test issue',
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
    branch_name: 'autopilot/sentry-MERGE',
    pr_url: prUrl,
    pushed_at: now,
    created_at: now,
    updated_at: now,
    dispatched_at: null,
    completed_at: now,
  };
}

const PAYLOAD = {
  branch_name: 'autopilot/sentry-MERGE' as const,
  merge_method: 'squash' as const,
};

type FetchStub = (url: string | URL | Request, init?: RequestInit) => Promise<Response>;

function installFetchStub(stub: FetchStub): void {
  vi.stubGlobal('fetch', vi.fn(stub));
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('parsePrNumberFromUrl', () => {
  it('extracts the PR number from a canonical github.com URL', () => {
    expect(parsePrNumberFromUrl('https://github.com/mindstone/rebel-app/pull/123')).toBe(123);
  });

  it('returns null for a malformed URL', () => {
    expect(parsePrNumberFromUrl('https://github.com/mindstone/rebel-app/issues/123')).toBeNull();
    expect(parsePrNumberFromUrl('not-a-url')).toBeNull();
    expect(parsePrNumberFromUrl('')).toBeNull();
  });

  it('handles trailing query / fragment', () => {
    expect(
      parsePrNumberFromUrl('https://github.com/mindstone/rebel-app/pull/45?diff=split'),
    ).toBe(45);
    expect(
      parsePrNumberFromUrl('https://github.com/mindstone/rebel-app/pull/9#issuecomment-1'),
    ).toBe(9);
  });
});

describe('Reporter.executePrMerge', () => {
  let reporter: Reporter;

  beforeEach(() => {
    reporter = new Reporter(makeConfig());
  });

  it('throws when githubToken is missing', async () => {
    reporter = new Reporter(makeConfig({ githubToken: undefined }));
    await expect(reporter.executePrMerge(makeIssue(), PAYLOAD)).rejects.toThrow(/githubToken/);
  });

  it('throws when repoFullName is missing', async () => {
    reporter = new Reporter(makeConfig({ repoFullName: undefined }));
    await expect(reporter.executePrMerge(makeIssue(), PAYLOAD)).rejects.toThrow(/repoFullName/);
  });

  it('throws transient when issue.pr_url is null (pr_open has not run)', async () => {
    await expect(reporter.executePrMerge(makeIssue(null), PAYLOAD)).rejects.toThrow(
      /pr_open has not populated it yet/,
    );
  });

  it('PUTs /pulls/{n}/merge with merge_method=squash and returns void on success', async () => {
    const calls: Array<{ method: string; url: string; body?: unknown }> = [];
    installFetchStub(async (url, init) => {
      const u = String(url);
      const method = init?.method ?? 'GET';
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      calls.push({ method, url: u, body });
      return new Response(JSON.stringify({ merged: true, sha: 'deadbeef' }), { status: 200 });
    });

    await reporter.executePrMerge(makeIssue(), PAYLOAD);
    expect(calls).toHaveLength(1);
    expect(calls[0].method).toBe('PUT');
    expect(calls[0].url).toBe('https://api.github.com/repos/mindstone/rebel-app/pulls/123/merge');
    expect(calls[0].body).toEqual({ merge_method: 'squash' });
  });

  it('treats 405 (not mergeable) as a permanent error', async () => {
    installFetchStub(async () =>
      new Response(JSON.stringify({ message: 'Pull Request is not mergeable' }), { status: 405 }),
    );
    await expect(reporter.executePrMerge(makeIssue(), PAYLOAD)).rejects.toThrow(/405/);
  });

  it('treats 409 (head SHA changed) as a permanent error', async () => {
    installFetchStub(async () =>
      new Response(JSON.stringify({ message: 'Head branch was modified' }), { status: 409 }),
    );
    await expect(reporter.executePrMerge(makeIssue(), PAYLOAD)).rejects.toThrow(/409/);
  });

  it('surfaces 5xx as transient (drainer retries)', async () => {
    installFetchStub(async () => new Response('Service unavailable', { status: 503 }));
    await expect(reporter.executePrMerge(makeIssue(), PAYLOAD)).rejects.toThrow(/503/);
  });
});

describe('Reporter.probePrMerged', () => {
  it('returns null when credentials are missing', async () => {
    const reporter = new Reporter(makeConfig({ githubToken: undefined }));
    expect(await reporter.probePrMerged('https://github.com/mindstone/rebel-app/pull/1')).toBeNull();
  });

  it('returns false when prUrl is missing (pr_open has not populated it yet)', async () => {
    const reporter = new Reporter(makeConfig());
    expect(await reporter.probePrMerged(null)).toBe(false);
  });

  it('returns null when PR URL is malformed (executor surfaces clear error)', async () => {
    const reporter = new Reporter(makeConfig());
    expect(await reporter.probePrMerged('https://github.com/foo/bar/issues/1')).toBeNull();
  });

  it('returns true when GitHub reports merged', async () => {
    installFetchStub(async () => new Response(JSON.stringify({ merged: true }), { status: 200 }));
    const reporter = new Reporter(makeConfig());
    expect(
      await reporter.probePrMerged('https://github.com/mindstone/rebel-app/pull/1'),
    ).toBe(true);
  });

  it('returns false when GitHub reports unmerged', async () => {
    installFetchStub(
      async () => new Response(JSON.stringify({ merged: false }), { status: 200 }),
    );
    const reporter = new Reporter(makeConfig());
    expect(
      await reporter.probePrMerged('https://github.com/mindstone/rebel-app/pull/1'),
    ).toBe(false);
  });
});
