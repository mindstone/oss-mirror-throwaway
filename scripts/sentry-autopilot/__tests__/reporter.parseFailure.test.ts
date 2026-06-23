import { afterEach, describe, expect, it, vi } from 'vitest';

import type { AutopilotConfig } from '../config.ts';
import { Reporter } from '../reporter.ts';
import type { SessionOutcome } from '../session-manager.ts';
import type { IssueRow } from '../state.ts';

function makeConfig(): AutopilotConfig {
  return {
    sentryAuthToken: 'test-token',
    sentryOrg: 'mindstone',
    sentryProject: 'rebel',
    linearApiKey: 'test-linear-key',
    slackWebhook: undefined,
    phase: 'shadow',
    verifyMode: 'disabled',
    pushMode: 'disabled',
    stateDir: '/tmp/sentry-autopilot-tests',
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

function makeIssue(): IssueRow {
  const now = new Date().toISOString();
  return {
    sentry_id: 'SENTRY-PARSE-FAILURE',
    sentry_url: 'https://sentry.io/issues/SENTRY-PARSE-FAILURE',
    title: 'Outcome parser exploded in harvest',
    error_type: 'exception',
    is_user_reported: false,
    occurrences: 3,
    users: 2,
    status: 'failed',
    dispatch_count: 1,
    max_retries: 2,
    confidence: null,
    outcome: 'failed',
    original_outcome: undefined,
    root_cause: undefined,
    plan_summary: undefined,
    diagnosis: undefined,
    is_bug: undefined,
    failure_kind: 'parse_failure',
    last_error: 'Failed to harvest outcome: Unexpected token',
    commit_hash: null,
    plan_file: null,
    linear_issue_id: null,
    tmux_session: null,
    worktree_slot: null,
    user_description: null,
    pending_actions: null,
    verification_status: null,
    verification_details: null,
    branch_name: null,
    pr_url: null,
    pushed_at: null,
    created_at: now,
    updated_at: now,
    dispatched_at: now,
    completed_at: now,
  };
}

interface ReporterInternals {
  sendSlack: (message: string) => Promise<void>;
  postSentryComment: (issue: IssueRow, text: string) => Promise<void>;
  fetchLinearLinkFromSentry: (issue: IssueRow) => Promise<{ issueIdentifier: string; url: string } | null>;
  createLinearIssue: (issue: IssueRow, outcome: SessionOutcome) => Promise<unknown>;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('Reporter parse-failure outcome messaging', () => {
  it('emits parse-failure Slack copy and skips Linear, Sentry comment, and Sentry status mutations', async () => {
    const reporter = new Reporter(makeConfig());
    const issue = makeIssue();
    const sendSlack = vi.fn().mockResolvedValue(undefined);
    const postSentryComment = vi.fn().mockResolvedValue(undefined);
    const fetchLinearLinkFromSentry = vi.fn().mockResolvedValue(null);
    const createLinearIssue = vi.fn().mockResolvedValue(null);
    const fetchSpy = vi.spyOn(globalThis, 'fetch');

    const internals = reporter as unknown as ReporterInternals;
    internals.sendSlack = sendSlack;
    internals.postSentryComment = postSentryComment;
    internals.fetchLinearLinkFromSentry = fetchLinearLinkFromSentry;
    internals.createLinearIssue = createLinearIssue;

    const outcome: SessionOutcome = {
      outcome: 'failed',
      failure_kind: 'parse_failure',
      error: 'Failed to harvest outcome: Unexpected token b in JSON at position 1',
      original_outcome: JSON.stringify({
        truncated_text: '{not-json',
        artifact_path: '/tmp/foo/outcome.json',
      }),
    };

    const result = await reporter.reportOutcome(issue, outcome);

    expect(result).toBeNull();

    expect(sendSlack).toHaveBeenCalledTimes(1);
    const message = sendSlack.mock.calls[0]?.[0];
    expect(typeof message).toBe('string');
    expect(message).toMatch(/parse failure/i);
    expect(message).toContain('parse_failure (terminal)');
    expect(message).toContain('/tmp/foo/outcome.json');
    expect(message).toContain('Inspect outcome.json + supervisor.log');

    expect(createLinearIssue).not.toHaveBeenCalled();
    expect(fetchLinearLinkFromSentry).not.toHaveBeenCalled();
    expect(postSentryComment).not.toHaveBeenCalled();

    const putCalls = fetchSpy.mock.calls.filter(([, init]) => (init as RequestInit | undefined)?.method === 'PUT');
    expect(putCalls).toHaveLength(0);
  });
});
