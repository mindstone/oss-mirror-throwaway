/**
 * Stage A golden side-effect transcript test.
 *
 * For each of 4 representative outcomes, capture the ordered sequence of
 * reporter side-effect calls (operation name + payload hash) emitted by
 * `reportOutcome`, then assert against an inline Vitest snapshot. The point is
 * to catch silent reordering or accidentally-dropped calls during the Stage A
 * refactor and during all subsequent stages that touch the reporter.
 *
 * The "operation name" is the name of the private side-effect method being
 * called (e.g. `sendSlack`, `postSentryComment`). The "payload hash" is a short
 * deterministic sha256 prefix of the JSON-serialized argument list — enough to
 * detect payload drift without committing the full Slack/Sentry/Linear strings
 * to the snapshot.
 *
 * If a snapshot fails, inspect the diff: did the refactor add or remove a side
 * effect, reorder calls, or change a payload? Update the snapshot deliberately
 * (not on autopilot).
 */

import crypto from 'node:crypto';

import { afterEach, describe, expect, it, vi } from 'vitest';

import type { AutopilotConfig } from '../config.ts';
import { Reporter } from '../reporter.ts';
import type { SessionOutcome } from '../session-manager.ts';
import type { IssueRow } from '../state.ts';

interface TranscriptEntry {
  op: string;
  hash: string;
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

const SPIED_METHODS: Array<keyof ReporterInternals> = [
  'sendSlack',
  'postSentryComment',
  'updateSentryIssueStatus',
  'fetchLinearLinkFromSentry',
  'resolveLinearIssueId',
  'commentOnLinearIssue',
  'createLinearIssue',
  'sendDraftResponse',
];

function hashArgs(args: unknown[]): string {
  // Normalize args by stripping object identity / volatile fields. For the
  // existing reporter, args are strings, IssueRow, SessionOutcome, or Linear IDs.
  // We hash a JSON representation with sorted keys so the snapshot is stable.
  function normalize(value: unknown): unknown {
    if (value === null || value === undefined) return null;
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
      return value;
    }
    if (Array.isArray(value)) return value.map(normalize);
    if (typeof value === 'object') {
      const obj = value as Record<string, unknown>;
      const sortedKeys = Object.keys(obj).sort();
      const result: Record<string, unknown> = {};
      for (const key of sortedKeys) {
        // Strip volatile fields that change every run.
        if (key === 'created_at' || key === 'updated_at' || key === 'dispatched_at' || key === 'completed_at') {
          continue;
        }
        result[key] = normalize(obj[key]);
      }
      return result;
    }
    return String(value);
  }
  const serialized = JSON.stringify(normalize(args));
  return crypto.createHash('sha256').update(serialized).digest('hex').slice(0, 12);
}

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

function fixedIssue(overrides: Partial<IssueRow> = {}): IssueRow {
  // Fixed timestamps so the hash is stable across runs.
  const ts = '2026-05-15T00:00:00.000Z';
  return {
    sentry_id: 'SENTRY-GOLDEN',
    sentry_url: 'https://sentry.io/issues/SENTRY-GOLDEN',
    title: 'Golden transcript fixture',
    error_type: 'exception',
    is_user_reported: false,
    occurrences: 12,
    users: 5,
    status: 'completed',
    dispatch_count: 1,
    max_retries: 2,
    confidence: 80,
    outcome: 'plan_created',
    original_outcome: undefined,
    root_cause: 'root cause text',
    plan_summary: 'plan summary text',
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
    user_email: null,
    user_name: null,
    pending_actions: null,
    verification_status: null,
    verification_details: null,
    branch_name: null,
    pr_url: null,
    pushed_at: null,
    created_at: ts,
    updated_at: ts,
    dispatched_at: ts,
    completed_at: ts,
    ...overrides,
  };
}

function installSpies(reporter: Reporter): TranscriptEntry[] {
  const transcript: TranscriptEntry[] = [];
  const internals = reporter as unknown as ReporterInternals;

  function record(op: string, args: unknown[]): void {
    transcript.push({ op, hash: hashArgs(args) });
  }

  internals.sendSlack = vi.fn(async (...args: unknown[]) => {
    record('sendSlack', args);
    return undefined;
  });
  internals.postSentryComment = vi.fn(async (...args: unknown[]) => {
    record('postSentryComment', args);
    return undefined;
  });
  internals.updateSentryIssueStatus = vi.fn(async (...args: unknown[]) => {
    record('updateSentryIssueStatus', args);
    return undefined;
  });
  internals.fetchLinearLinkFromSentry = vi.fn(async (...args: unknown[]) => {
    record('fetchLinearLinkFromSentry', args);
    return null;
  });
  internals.resolveLinearIssueId = vi.fn(async (...args: unknown[]) => {
    record('resolveLinearIssueId', args);
    return null;
  });
  internals.commentOnLinearIssue = vi.fn(async (...args: unknown[]) => {
    record('commentOnLinearIssue', args);
    return undefined;
  });
  internals.createLinearIssue = vi.fn(async (...args: unknown[]) => {
    record('createLinearIssue', args);
    return { id: 'lin-fixture', url: 'https://linear.app/issue/lin-fixture' };
  });
  internals.sendDraftResponse = vi.fn(async (...args: unknown[]) => {
    record('sendDraftResponse', args);
    return undefined;
  });
  internals.commitPlanToRepo = vi.fn(() => null);

  // Suppress stdout/stderr metric noise for snapshot determinism.
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});

  return transcript;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('Reporter side-effect transcript (Stage A golden snapshots)', () => {
  it('plan_created (no existing Linear link, not user-reported)', async () => {
    const reporter = new Reporter(makeConfig());
    const transcript = installSpies(reporter);

    const outcome: SessionOutcome = {
      outcome: 'plan_created',
      confidence: 80,
      plan_file: 'plan.md',
      root_cause: 'root cause text',
      plan_summary: 'plan summary text',
      is_bug: true,
    };
    await reporter.reportOutcome(fixedIssue(), outcome);

    expect(transcript.map((entry) => entry.op)).toMatchInlineSnapshot(`
      [
        "fetchLinearLinkFromSentry",
        "createLinearIssue",
        "sendSlack",
        "postSentryComment",
        "updateSentryIssueStatus",
      ]
    `);
    expect(transcript).toMatchInlineSnapshot(`
      [
        {
          "hash": "a32ff090edf6",
          "op": "fetchLinearLinkFromSentry",
        },
        {
          "hash": "314c7e13b5b8",
          "op": "createLinearIssue",
        },
        {
          "hash": "6ee158d84da2",
          "op": "sendSlack",
        },
        {
          "hash": "cdf526bb525c",
          "op": "postSentryComment",
        },
        {
          "hash": "314c7e13b5b8",
          "op": "updateSentryIssueStatus",
        },
      ]
    `);
  });

  it('auto_committed (happy path; no Linear, no Sentry comment? — still posts)', async () => {
    const reporter = new Reporter(makeConfig());
    const transcript = installSpies(reporter);

    const outcome: SessionOutcome = {
      outcome: 'auto_committed',
      confidence: 95,
      commit_hash: 'abc123',
      root_cause: 'root cause text',
      plan_summary: 'plan summary text',
      is_bug: true,
    };
    await reporter.reportOutcome(fixedIssue({ commit_hash: 'abc123' }), outcome);

    expect(transcript.map((entry) => entry.op)).toMatchInlineSnapshot(`
      [
        "sendSlack",
        "postSentryComment",
        "updateSentryIssueStatus",
      ]
    `);
    expect(transcript).toMatchInlineSnapshot(`
      [
        {
          "hash": "50cfe517a63c",
          "op": "sendSlack",
        },
        {
          "hash": "756e8c3be419",
          "op": "postSentryComment",
        },
        {
          "hash": "bfee8b7a1253",
          "op": "updateSentryIssueStatus",
        },
      ]
    `);
  });

  it('escalated + user-reported → does NOT send user alert or draft (no committed fix to promise)', async () => {
    // After Stage 3 gating: user alerts and draft responses only fire on
    // outcome === 'auto_committed'. For escalated, we still report the outcome
    // and create Linear, but no draft goes out since there's nothing shipping.
    const reporter = new Reporter(makeConfig());
    const transcript = installSpies(reporter);

    const outcome: SessionOutcome = {
      outcome: 'escalated',
      confidence: 35,
      reason: 'autopilot ran out of confidence',
      root_cause: 'root cause text',
      plan_summary: 'plan summary text',
      is_bug: true,
    };
    await reporter.reportOutcome(fixedIssue({ is_user_reported: true }), outcome);

    expect(transcript.map((entry) => entry.op)).toMatchInlineSnapshot(`
      [
        "fetchLinearLinkFromSentry",
        "createLinearIssue",
        "sendSlack",
        "postSentryComment",
        "updateSentryIssueStatus",
      ]
    `);
    expect(transcript.some((entry) => entry.op === 'sendDraftResponse')).toBe(false);
  });

  it('auto_committed + user-reported → sends user alert AND draft response with reporter contact', async () => {
    // The positive case for Stage 3: fix landed on dev, reporter has contact
    // info, so we nudge a human (sendSlack alert) and send the draft response.
    const reporter = new Reporter(makeConfig());
    const transcript = installSpies(reporter);

    const outcome: SessionOutcome = {
      outcome: 'auto_committed',
      confidence: 95,
      commit_hash: 'abc123',
      root_cause: 'root cause text',
      plan_summary: 'plan summary text',
      is_bug: true,
    };
    await reporter.reportOutcome(
      fixedIssue({
        is_user_reported: true,
        commit_hash: 'abc123',
        user_email: 'reporter@example.com',
        user_name: 'Reporter Person',
      }),
      outcome,
    );

    expect(transcript.map((entry) => entry.op)).toMatchInlineSnapshot(`
      [
        "sendSlack",
        "sendSlack",
        "sendDraftResponse",
        "postSentryComment",
        "updateSentryIssueStatus",
      ]
    `);
    expect(transcript.filter((entry) => entry.op === 'sendSlack').length).toBeGreaterThanOrEqual(2);
    expect(transcript.some((entry) => entry.op === 'sendDraftResponse')).toBe(true);
  });

  it('parse_failure (terminal — Slack + no-op updateSentryIssueStatus; no Linear, no Sentry comment)', async () => {
    const reporter = new Reporter(makeConfig());
    const transcript = installSpies(reporter);

    const outcome: SessionOutcome = {
      outcome: 'failed',
      failure_kind: 'parse_failure',
      error: 'Failed to harvest outcome: Unexpected token',
      original_outcome: JSON.stringify({
        truncated_text: '{not-json',
        artifact_path: '/tmp/foo/outcome.json',
      }),
    };
    await reporter.reportOutcome(
      fixedIssue({ status: 'failed', failure_kind: 'parse_failure', last_error: 'parse boom' }),
      outcome,
    );

    expect(transcript.map((entry) => entry.op)).toMatchInlineSnapshot(`
      [
        "sendSlack",
        "updateSentryIssueStatus",
      ]
    `);
    expect(transcript).toMatchInlineSnapshot(`
      [
        {
          "hash": "b4e22a443f92",
          "op": "sendSlack",
        },
        {
          "hash": "7a4b56d8e5bb",
          "op": "updateSentryIssueStatus",
        },
      ]
    `);
  });
});
