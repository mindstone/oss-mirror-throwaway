/**
 * Reporter.executeSentryStatus outbound-body tests.
 *
 * The reporter PUTs `/api/0/issues/{id}/` with a JSON body that Sentry
 * uses to infer substatus. Sentry's update route reads top-level
 * `substatus`; the response-side `statusDetails.ignoreUntilEscalating`
 * flag is NOT a valid request field. Issues sent without `substatus`
 * end up as `archived_forever` and never re-surface on volume escalation.
 *
 * This suite asserts the literal HTTP body so the substatus contract
 * cannot regress silently.
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
    githubToken: undefined,
    repoFullName: undefined,
    phase: 'shadow',
    verifyMode: 'enforce',
    pushMode: 'pr',
    pendingMode: 'enforce',
    stateDir: '/tmp/sentry-autopilot-status-tests',
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
    sentry_id: 'SENTRY-STATUS',
    sentry_url: 'https://sentry.io/issues/SENTRY-STATUS',
    title: 'status update test issue',
    error_type: 'exception',
    is_user_reported: false,
    occurrences: 1,
    users: 1,
    status: 'completed',
    dispatch_count: 1,
    max_retries: 2,
    confidence: 95,
    outcome: 'not_a_bug',
    last_error: null,
    commit_hash: null,
    plan_file: null,
    linear_issue_id: null,
    tmux_session: null,
    worktree_slot: null,
    user_description: null,
    pending_actions: null,
    verification_status: 'skipped',
    verification_details: null,
    branch_name: null,
    pr_url: null,
    pushed_at: null,
    created_at: now,
    updated_at: now,
    dispatched_at: null,
    completed_at: now,
  };
}

type FetchStub = (url: string | URL | Request, init?: RequestInit) => Promise<Response>;

interface CapturedRequest {
  method: string;
  url: string;
  body: unknown;
}

function installFetchStub(): { reqs: CapturedRequest[] } {
  const reqs: CapturedRequest[] = [];
  const stub: FetchStub = async (url, init) => {
    reqs.push({
      method: init?.method ?? 'GET',
      url: String(url),
      body: init?.body ? JSON.parse(String(init.body)) : null,
    });
    return new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
  vi.stubGlobal('fetch', vi.fn(stub));
  return { reqs };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('Reporter.executeSentryStatus outbound body', () => {
  let reporter: Reporter;

  beforeEach(() => {
    reporter = new Reporter(makeConfig());
  });

  it('ignored + archived_until_escalating sends top-level substatus', async () => {
    const { reqs } = installFetchStub();
    await reporter.executeSentryStatus(makeIssue(), {
      status: 'ignored',
      status_details: {},
      substatus: 'archived_until_escalating',
    });
    expect(reqs).toHaveLength(1);
    expect(reqs[0].method).toBe('PUT');
    expect(reqs[0].url).toContain('/api/0/issues/SENTRY-STATUS/');
    expect(reqs[0].body).toEqual({
      status: 'ignored',
      statusDetails: {},
      substatus: 'archived_until_escalating',
    });
  });

  it('resolved sends only the status field', async () => {
    const { reqs } = installFetchStub();
    await reporter.executeSentryStatus(makeIssue(), { status: 'resolved' });
    expect(reqs).toHaveLength(1);
    expect(reqs[0].body).toEqual({ status: 'resolved' });
  });

  it('omits substatus when not provided', async () => {
    const { reqs } = installFetchStub();
    await reporter.executeSentryStatus(makeIssue(), {
      status: 'ignored',
      status_details: { ignoreCount: 100 },
    });
    expect(reqs).toHaveLength(1);
    expect(reqs[0].body).toEqual({
      status: 'ignored',
      statusDetails: { ignoreCount: 100 },
    });
  });
});
