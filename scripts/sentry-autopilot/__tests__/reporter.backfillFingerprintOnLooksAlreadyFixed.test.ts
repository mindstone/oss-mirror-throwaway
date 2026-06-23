import { afterEach, describe, expect, it, vi } from 'vitest';

import type { AutopilotConfig } from '../config.ts';
import { Reporter } from '../reporter.ts';
import type { SessionOutcome } from '../session-manager.ts';
import type { IssueRow } from '../state.ts';
import { fingerprintLooseHash } from '../triage/fingerprint.ts';

function makeConfig(): AutopilotConfig {
  return {
    sentryAuthToken: 'sentry-token',
    sentryOrg: 'mindstone',
    sentryProject: 'rebel',
    linearApiKey: 'linear-token',
    slackWebhook: undefined,
    phase: 'shadow',
    verifyMode: 'disabled',
    pushMode: 'disabled',
    pendingMode: 'disabled',
    stateDir: '/tmp/sentry-autopilot-backfill-tests',
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
  const now = '2026-06-07T17:30:00Z';
  return {
    sentry_id: 'SENTRY-BACKFILL',
    sentry_url: 'https://sentry.io/issues/SENTRY-BACKFILL',
    title: 'Backfill fingerprint fixture',
    error_type: 'exception',
    is_user_reported: false,
    occurrences: 10,
    users: 3,
    status: 'completed',
    dispatch_count: 1,
    max_retries: 2,
    confidence: 92,
    outcome: null,
    last_error: null,
    commit_hash: null,
    plan_file: null,
    linear_issue_id: 'REBEL-123',
    tmux_session: null,
    worktree_slot: null,
    user_description: null,
    user_email: null,
    user_name: null,
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

function sentryDetailResponse(): Response {
  return new Response(
    JSON.stringify({
      latestEvent: {
        entries: [
          {
            data: {
              values: [
                {
                  stacktrace: {
                    frames: [
                      { filename: '/app/src/main.ts', function: 'handleError', lineno: 10 },
                      { filename: '/app/src/worker.ts', function: 'runWorker', lineno: 20 },
                      { filename: '/app/src/index.ts', function: 'main', lineno: 30 },
                    ],
                  },
                },
              ],
            },
          },
        ],
      },
    }),
    { status: 200, headers: { 'Content-Type': 'application/json' } },
  );
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('Reporter fingerprint backfill on already-fixed outcome', () => {
  it('appends autopilot-fingerprint to an existing Linear ticket that lacks it', async () => {
    const requests: Array<{ url: string; body: unknown }> = [];
    let linearCalls = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
        const body = init?.body ? JSON.parse(String(init.body)) : null;
        requests.push({ url: String(url), body });

        if (String(url).includes('/api/0/issues/SENTRY-BACKFILL/') && !String(url).includes('/comments/')) {
          return sentryDetailResponse();
        }
        if (String(url).includes('api.linear.app')) {
          linearCalls += 1;
        }
        if (String(url).includes('api.linear.app') && linearCalls === 1) {
          return new Response(JSON.stringify({ data: { issue: { description: 'Existing Linear body' } } }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          });
        }
        if (String(url).includes('api.linear.app') && linearCalls === 2) {
          return new Response(JSON.stringify({ data: { issueUpdate: { success: true } } }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          });
        }
        return new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } });
      }),
    );
    const outcome: SessionOutcome = {
      outcome: 'plan_created',
      confidence: 92,
      plan_file: 'plan.md',
      root_cause: 'The bug is already fixed on dev.',
      is_bug: true,
    };

    await new Reporter(makeConfig()).reportOutcome(makeIssue(), outcome, {
      status: 'skipped',
      details: [],
      metrics: {},
    });

    const expectedHash = fingerprintLooseHash([
      { filename: '/app/src/main.ts', function: 'handleError', lineno: 10 },
      { filename: '/app/src/worker.ts', function: 'runWorker', lineno: 20 },
      { filename: '/app/src/index.ts', function: 'main', lineno: 30 },
    ]);
    const updateRequest = requests.find(
      (request) =>
        String(request.url).includes('api.linear.app') &&
        typeof (request.body as { query?: unknown } | null)?.query === 'string' &&
        String((request.body as { query: string }).query).includes('issueUpdate'),
    );

    expect(updateRequest).toBeDefined();
    expect((updateRequest?.body as { variables: { id: string; input: { description: string } } }).variables.id).toBe(
      'REBEL-123',
    );
    expect(
      (updateRequest?.body as { variables: { input: { description: string } } }).variables.input.description,
    ).toBe(`Existing Linear body\nautopilot-fingerprint: ${expectedHash}`);
  });

  it('logs a structured warning and continues when Linear issueUpdate fails during backfill', async () => {
    const requests: Array<{ url: string; method?: string; body: unknown }> = [];
    let linearCalls = 0;
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
        const body = init?.body ? JSON.parse(String(init.body)) : null;
        requests.push({ url: String(url), method: init?.method, body });

        if (String(url).includes('/api/0/issues/SENTRY-BACKFILL/') && !String(url).includes('/comments/')) {
          return sentryDetailResponse();
        }
        if (String(url).includes('api.linear.app')) {
          linearCalls += 1;
        }
        if (String(url).includes('api.linear.app') && linearCalls === 1) {
          return new Response(JSON.stringify({ data: { issue: { description: 'Existing Linear body' } } }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          });
        }
        if (String(url).includes('api.linear.app') && linearCalls === 2) {
          throw new Error('Linear write exploded');
        }
        return new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } });
      }),
    );
    const outcome: SessionOutcome = {
      outcome: 'plan_created',
      confidence: 92,
      plan_file: 'plan.md',
      root_cause: 'The bug is already fixed on dev.',
      is_bug: true,
    };

    await expect(
      new Reporter(makeConfig()).reportOutcome(makeIssue(), outcome, {
        status: 'skipped',
        details: [],
        metrics: {},
      }),
    ).resolves.toBeNull();

    const parsedWarnings = warnSpy.mock.calls
      .map(([line]) => {
        try {
          return JSON.parse(String(line)) as Record<string, unknown>;
        } catch {
          return null;
        }
      })
      .filter((line): line is Record<string, unknown> => line !== null);
    expect(parsedWarnings).toContainEqual(
      expect.objectContaining({
        message: 'autopilot.backfill_fingerprint.failed',
        sentryId: 'SENTRY-BACKFILL',
        linearTicketId: 'REBEL-123',
        error: 'Linear issue update network error: Linear write exploded',
      }),
    );
    expect(
      requests.some(
        (request) =>
          String(request.url).includes('/api/0/issues/SENTRY-BACKFILL/comments/') && request.method === 'POST',
      ),
    ).toBe(true);
    expect(
      requests.some(
        (request) => String(request.url).includes('/api/0/issues/SENTRY-BACKFILL/') && request.method === 'PUT',
      ),
    ).toBe(true);
  });
});
