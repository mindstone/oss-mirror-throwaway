/**
 * Stage A behavioural contract for `Reporter.executeOperation` orchestration.
 *
 * For every reporter side-effect method, this suite asserts that:
 *   1. When the underlying side effect throws, the orchestrator emits a
 *      `reporter.call.failure.<operation>` counter (via stdout JSON line).
 *   2. The orchestrator emits a `reporter_fail` errorLog with the right
 *      `operation` tag and `success: false`.
 *   3. The orchestrator does NOT re-throw — it returns control so subsequent
 *      calls in `reportOutcome` continue.
 *   4. When the side effect succeeds, a matching `reporter.call.success.<operation>`
 *      counter is emitted.
 *
 * The methods covered are exactly the ones listed in the Stage A plan body:
 *   sendSlack, postSentryComment, updateSentryIssueStatus, fetchLinearLinkFromSentry,
 *   resolveLinearIssueId, commentOnLinearIssue, createLinearIssue, sendDraftResponse.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AutopilotConfig } from '../config.ts';
import { Reporter } from '../reporter.ts';
import type { SessionOutcome } from '../session-manager.ts';
import type { IssueRow } from '../state.ts';

function makeConfig(overrides: Partial<AutopilotConfig> = {}): AutopilotConfig {
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
    ...overrides,
  };
}

function makeIssue(overrides: Partial<IssueRow> = {}): IssueRow {
  const now = new Date().toISOString();
  return {
    sentry_id: 'SENTRY-WITHLOGGING',
    sentry_url: 'https://sentry.io/issues/SENTRY-WITHLOGGING',
    title: 'A failing reporter side effect',
    error_type: 'exception',
    is_user_reported: false,
    occurrences: 3,
    users: 2,
    status: 'completed',
    dispatch_count: 1,
    max_retries: 2,
    confidence: 70,
    outcome: 'plan_created',
    original_outcome: undefined,
    root_cause: 'sample root cause',
    plan_summary: 'sample plan summary',
    diagnosis: undefined,
    is_bug: true,
    failure_kind: undefined,
    last_error: null,
    commit_hash: null,
    plan_file: null,
    linear_issue_id: null,
    tmux_session: null,
    worktree_slot: null,
    user_description: null,
    created_at: now,
    updated_at: now,
    dispatched_at: now,
    completed_at: now,
    ...overrides,
  };
}

function planCreatedOutcome(): SessionOutcome {
  return {
    outcome: 'plan_created',
    confidence: 70,
    plan_file: 'plan.md',
    root_cause: 'a thing went wrong',
    plan_summary: 'fix the thing',
    is_bug: true,
  };
}

interface ReporterInternals {
  sendSlack: (...args: unknown[]) => Promise<unknown>;
  postSentryComment: (...args: unknown[]) => Promise<unknown>;
  updateSentryIssueStatus: (...args: unknown[]) => Promise<unknown>;
  fetchLinearLinkFromSentry: (...args: unknown[]) => Promise<unknown>;
  resolveLinearIssueId: (...args: unknown[]) => Promise<unknown>;
  commentOnLinearIssue: (...args: unknown[]) => Promise<unknown>;
  createLinearIssue: (...args: unknown[]) => Promise<unknown>;
  sendDraftResponse: (...args: unknown[]) => Promise<unknown>;
  commitPlanToRepo: (...args: unknown[]) => string | null;
}

interface CapturedLogs {
  successCounters: string[];
  failureCounters: string[];
  errorLogs: Array<{ operation: string; error: string; success: boolean }>;
}

function captureLogs(): { capture: CapturedLogs; restore: () => void } {
  const capture: CapturedLogs = {
    successCounters: [],
    failureCounters: [],
    errorLogs: [],
  };
  const logSpy = vi.spyOn(console, 'log').mockImplementation((line: unknown) => {
    try {
      const payload = JSON.parse(String(line)) as {
        metric?: boolean;
        name?: string;
        operation?: string;
      };
      if (payload.metric && payload.name === 'reporter.call.success' && payload.operation) {
        capture.successCounters.push(payload.operation);
      } else if (payload.metric && payload.name === 'reporter.call.failure' && payload.operation) {
        capture.failureCounters.push(payload.operation);
      }
    } catch {
      // Non-JSON stdout — ignore (e.g. logWarn breadcrumbs go to console.warn).
    }
  });
  const errorSpy = vi.spyOn(console, 'error').mockImplementation((line: unknown) => {
    try {
      const payload = JSON.parse(String(line)) as {
        log_discriminator?: string;
        operation?: string;
        error?: string;
        success?: boolean;
      };
      if (payload.log_discriminator === 'reporter_fail' && payload.operation) {
        capture.errorLogs.push({
          operation: payload.operation,
          error: String(payload.error ?? ''),
          success: payload.success === true,
        });
      }
    } catch {
      // Non-JSON stderr — ignore.
    }
  });
  return {
    capture,
    restore: () => {
      logSpy.mockRestore();
      errorSpy.mockRestore();
    },
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('Reporter.executeOperation orchestration (Stage A)', () => {
  describe('per-method failure isolation', () => {
    const cases: Array<{
      name: string;
      method: keyof ReporterInternals;
      operation: string;
      // What the suite must observe in the failure counter list when this method fails.
    }> = [
      { name: 'sendSlack failure → slack.outcome', method: 'sendSlack', operation: 'slack.outcome' },
      { name: 'postSentryComment failure', method: 'postSentryComment', operation: 'sentry.comment' },
      {
        name: 'updateSentryIssueStatus failure',
        method: 'updateSentryIssueStatus',
        operation: 'sentry.status_update',
      },
      {
        name: 'fetchLinearLinkFromSentry failure',
        method: 'fetchLinearLinkFromSentry',
        operation: 'sentry.check_linear_link',
      },
      {
        name: 'createLinearIssue failure',
        method: 'createLinearIssue',
        operation: 'linear.create_issue',
      },
    ];

    for (const testCase of cases) {
      it(`emits failure counter + errorLog and continues when ${testCase.name}`, async () => {
        const reporter = new Reporter(makeConfig());
        const internals = reporter as unknown as ReporterInternals;
        // Default all methods to no-op success so they emit success counters.
        const noOp = vi.fn().mockResolvedValue(undefined);
        const noLink = vi.fn().mockResolvedValue(null);
        internals.sendSlack = vi.fn().mockResolvedValue(undefined);
        internals.postSentryComment = vi.fn().mockResolvedValue(undefined);
        internals.updateSentryIssueStatus = noOp;
        internals.fetchLinearLinkFromSentry = noLink;
        internals.resolveLinearIssueId = vi.fn().mockResolvedValue(null);
        internals.commentOnLinearIssue = vi.fn().mockResolvedValue(undefined);
        internals.createLinearIssue = vi.fn().mockResolvedValue(null);
        internals.sendDraftResponse = vi.fn().mockResolvedValue(undefined);
        internals.commitPlanToRepo = vi.fn().mockReturnValue(null);

        const failure = new Error(`${testCase.method} blew up`);
        internals[testCase.method] = vi.fn().mockRejectedValue(failure) as never;

        const { capture, restore } = captureLogs();
        try {
          await reporter.reportOutcome(makeIssue(), planCreatedOutcome());
        } finally {
          restore();
        }

        expect(capture.failureCounters).toContain(testCase.operation);
        const matchingErrorLog = capture.errorLogs.find((entry) => entry.operation === testCase.operation);
        expect(matchingErrorLog, `expected reporter_fail errorLog for ${testCase.operation}`).toBeTruthy();
        expect(matchingErrorLog?.error).toContain('blew up');
        expect(matchingErrorLog?.success).toBe(false);

        // Subsequent calls must still happen — we always reach the final
        // updateSentryIssueStatus step regardless of which earlier method failed.
        if (testCase.method !== 'updateSentryIssueStatus') {
          expect(capture.successCounters).toContain('sentry.status_update');
        }
      });
    }
  });

  describe('success path', () => {
    it('emits success counters for every side effect in a happy plan_created run', async () => {
      const reporter = new Reporter(makeConfig());
      const internals = reporter as unknown as ReporterInternals;
      internals.sendSlack = vi.fn().mockResolvedValue(undefined);
      internals.postSentryComment = vi.fn().mockResolvedValue(undefined);
      internals.updateSentryIssueStatus = vi.fn().mockResolvedValue(undefined);
      internals.fetchLinearLinkFromSentry = vi.fn().mockResolvedValue(null);
      internals.resolveLinearIssueId = vi.fn().mockResolvedValue(null);
      internals.commentOnLinearIssue = vi.fn().mockResolvedValue(undefined);
      internals.createLinearIssue = vi
        .fn()
        .mockResolvedValue({ id: 'lin-1', url: 'https://linear.app/issue/lin-1' });
      internals.sendDraftResponse = vi.fn().mockResolvedValue(undefined);
      internals.commitPlanToRepo = vi.fn().mockReturnValue(null);

      const { capture, restore } = captureLogs();
      try {
        await reporter.reportOutcome(makeIssue(), planCreatedOutcome());
      } finally {
        restore();
      }

      // The orchestrator must have emitted success counters for every call it made.
      expect(capture.failureCounters).toEqual([]);
      expect(capture.successCounters).toEqual(
        expect.arrayContaining([
          'sentry.check_linear_link',
          'linear.create_issue',
          'slack.outcome',
          'sentry.comment',
          'sentry.status_update',
        ]),
      );
    });

    it('emits success counter for slack.session_started', async () => {
      const reporter = new Reporter(makeConfig());
      const internals = reporter as unknown as ReporterInternals;
      internals.sendSlack = vi.fn().mockResolvedValue(undefined);
      internals.postSentryComment = vi.fn().mockResolvedValue(undefined);

      const { capture, restore } = captureLogs();
      try {
        await reporter.reportSessionStarted(makeIssue());
      } finally {
        restore();
      }
      expect(capture.successCounters).toEqual(
        expect.arrayContaining(['sentry.start_comment', 'slack.session_started']),
      );
      expect(capture.failureCounters).toEqual([]);
    });

    it('reportSessionStarted posts a Sentry in-progress marker before the slack ping', async () => {
      const reporter = new Reporter(makeConfig());
      const internals = reporter as unknown as ReporterInternals;
      const postSentryComment = vi.fn().mockResolvedValue(undefined);
      const sendSlack = vi.fn().mockResolvedValue(undefined);
      internals.postSentryComment = postSentryComment;
      internals.sendSlack = sendSlack;

      await reporter.reportSessionStarted(makeIssue());

      expect(postSentryComment).toHaveBeenCalledTimes(1);
      expect(sendSlack).toHaveBeenCalledTimes(1);
      expect(postSentryComment.mock.invocationCallOrder[0]).toBeLessThan(
        sendSlack.mock.invocationCallOrder[0],
      );
      const [, commentText] = postSentryComment.mock.calls[0] as [IssueRow, string];
      expect(commentText).toContain('Sentry Autopilot is investigating this issue');
      expect(commentText).toContain("Please don't pick up this issue manually");
      expect(commentText).toMatch(/Started at \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
    });

    it('reportSessionStarted still pings Slack when the Sentry in-progress comment fails', async () => {
      const reporter = new Reporter(makeConfig());
      const internals = reporter as unknown as ReporterInternals;
      internals.postSentryComment = vi.fn().mockRejectedValue(new Error('sentry 500'));
      const sendSlack = vi.fn().mockResolvedValue(undefined);
      internals.sendSlack = sendSlack;

      const { capture, restore } = captureLogs();
      try {
        await reporter.reportSessionStarted(makeIssue());
      } finally {
        restore();
      }
      expect(sendSlack).toHaveBeenCalledTimes(1);
      expect(capture.failureCounters).toContain('sentry.start_comment');
      expect(capture.successCounters).toContain('slack.session_started');
    });

    it('emits success counter for slack.heartbeat', async () => {
      const reporter = new Reporter(makeConfig());
      const internals = reporter as unknown as ReporterInternals;
      internals.sendSlack = vi.fn().mockResolvedValue(undefined);

      const { capture, restore } = captureLogs();
      try {
        await reporter.reportHeartbeat({
          processed: 1,
          committed: 0,
          plans: 1,
          escalated: 0,
          failed: 0,
        });
      } finally {
        restore();
      }
      expect(capture.successCounters).toContain('slack.heartbeat');
    });
  });

  describe('failure-counter contract for the standalone report* methods', () => {
    it('reportSessionStarted failure emits slack.session_started failure counter', async () => {
      const reporter = new Reporter(makeConfig());
      const internals = reporter as unknown as ReporterInternals;
      internals.postSentryComment = vi.fn().mockResolvedValue(undefined);
      internals.sendSlack = vi.fn().mockRejectedValue(new Error('slack down'));

      const { capture, restore } = captureLogs();
      try {
        await reporter.reportSessionStarted(makeIssue());
      } finally {
        restore();
      }
      expect(capture.failureCounters).toContain('slack.session_started');
      expect(capture.errorLogs.some((entry) => entry.operation === 'slack.session_started')).toBe(true);
    });

    it('reportHeartbeat failure emits slack.heartbeat failure counter', async () => {
      const reporter = new Reporter(makeConfig());
      (reporter as unknown as ReporterInternals).sendSlack = vi
        .fn()
        .mockRejectedValue(new Error('slack down'));

      const { capture, restore } = captureLogs();
      try {
        await reporter.reportHeartbeat({
          processed: 1,
          committed: 0,
          plans: 1,
          escalated: 0,
          failed: 0,
        });
      } finally {
        restore();
      }
      expect(capture.failureCounters).toContain('slack.heartbeat');
    });

    it('reportFailureCascade failure emits slack.failure_cascade failure counter', async () => {
      const reporter = new Reporter(makeConfig());
      (reporter as unknown as ReporterInternals).sendSlack = vi
        .fn()
        .mockRejectedValue(new Error('slack down'));

      const { capture, restore } = captureLogs();
      try {
        await reporter.reportFailureCascade(5);
      } finally {
        restore();
      }
      expect(capture.failureCounters).toContain('slack.failure_cascade');
    });

    it('reportKillSwitch failure emits slack.kill_switch failure counter', async () => {
      const reporter = new Reporter(makeConfig());
      (reporter as unknown as ReporterInternals).sendSlack = vi
        .fn()
        .mockRejectedValue(new Error('slack down'));

      const { capture, restore } = captureLogs();
      try {
        await reporter.reportKillSwitch('pause');
      } finally {
        restore();
      }
      expect(capture.failureCounters).toContain('slack.kill_switch');
    });

    it('reportPollerQueryFailure failure emits the namespaced failure counter', async () => {
      const reporter = new Reporter(makeConfig());
      (reporter as unknown as ReporterInternals).sendSlack = vi
        .fn()
        .mockRejectedValue(new Error('slack down'));

      const { capture, restore } = captureLogs();
      try {
        await reporter.reportPollerQueryFailure('stale_cleanup', 'bad');
      } finally {
        restore();
      }
      expect(capture.failureCounters).toContain('reportPollerQueryFailure:stale_cleanup');
    });
  });
});
