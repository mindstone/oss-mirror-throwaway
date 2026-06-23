/**
 * Stage C — `planActions()` pure-function tests.
 *
 * Verify the contract: for every outcome × user-reported × verification
 * permutation, `planActions` returns the expected `PendingAction[]` with
 * stable idempotency keys and ordering.
 *
 * Key invariants (folded from the planning doc Stage C audit):
 *   - parse_failure MUST emit `slack_outcome` at minimum (terminal — only
 *     visibility channel under `pendingMode=enforce`).
 *   - `auto_committed` / `not_a_bug` / `plan_created+already-fixed` /
 *     `plan_created+not-a-bug` produce a `sentry_status` action (resolved
 *     or ignored as appropriate); other outcomes do not.
 *   - `linear_create_issue` is emitted only when `shouldCreateLinearIssue`
 *     is true.
 *   - `is_user_reported=true` adds `slack_user_alert` (+ optional
 *     `slack_draft_response` when a draft file exists).
 *   - All actions carry `attempts=0`, `last_error=null`, a deterministic
 *     `idempotency_key` and the injected `now` timestamp.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import type { AutopilotConfig } from '../config.ts';
import { planActions } from '../reporter.ts';
import type { SessionOutcome } from '../session-manager.ts';
import type { IssueRow } from '../state.ts';
import type { VerificationResult } from '../verifier.ts';

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
});

function tempStateDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sentry-autopilot-planactions-'));
  tempDirs.push(dir);
  return dir;
}

function makeConfig(stateDir = tempStateDir()): AutopilotConfig {
  return {
    sentryAuthToken: 'token',
    sentryOrg: 'mindstone',
    sentryProject: 'rebel',
    linearApiKey: 'lin-key',
    slackWebhook: 'https://slack.example/webhook',
    phase: 'shadow',
    verifyMode: 'disabled',
    pushMode: 'disabled',
    pendingMode: 'mirror',
    stateDir,
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

function makeIssue(overrides: Partial<IssueRow> = {}): IssueRow {
  const ts = '2026-05-15T00:00:00.000Z';
  return {
    sentry_id: 'SENTRY-PLAN',
    sentry_url: 'https://sentry.io/issues/SENTRY-PLAN',
    title: 'planActions fixture',
    error_type: 'exception',
    is_user_reported: false,
    occurrences: 10,
    users: 3,
    status: 'completed',
    dispatch_count: 1,
    max_retries: 2,
    confidence: 80,
    outcome: null,
    original_outcome: undefined,
    root_cause: undefined,
    plan_summary: undefined,
    diagnosis: undefined,
    is_bug: undefined,
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

const NOW = '2026-05-15T12:34:56.000Z';

function defaultVerification(): VerificationResult {
  return { status: 'skipped', details: [], metrics: {} };
}

describe('planActions', () => {
  it('auto_committed → sentry_status(resolved) + sentry_comment + slack_outcome', () => {
    const outcome: SessionOutcome = {
      outcome: 'auto_committed',
      confidence: 95,
      commit_hash: 'abc1234',
      root_cause: 'fixed the off-by-one',
    };
    const actions = planActions({
      issue: makeIssue(),
      outcome,
      verification: defaultVerification(),
      config: makeConfig(),
      now: NOW,
    });
    expect(actions.map((a) => a.kind)).toEqual([
      'sentry_status',
      'sentry_comment',
      'slack_outcome',
    ]);
    const status = actions.find((a) => a.kind === 'sentry_status');
    expect(status?.payload).toEqual({ status: 'resolved' });
    expect(actions.every((a) => a.attempts === 0)).toBe(true);
    expect(actions.every((a) => a.last_error === null)).toBe(true);
    expect(actions.every((a) => a.created_at === NOW)).toBe(true);
  });

  it('plan_created (normal) → linear_create_issue + sentry_comment + slack_outcome (no sentry_status)', () => {
    const outcome: SessionOutcome = {
      outcome: 'plan_created',
      confidence: 70,
      plan_file: 'plan.md',
      root_cause: 'race condition',
      plan_summary: 'add a mutex',
      is_bug: true,
    };
    const actions = planActions({
      issue: makeIssue(),
      outcome,
      verification: defaultVerification(),
      config: makeConfig(),
      now: NOW,
    });
    expect(actions.map((a) => a.kind)).toEqual([
      'linear_create_issue',
      'sentry_comment',
      'slack_outcome',
    ]);
  });

  it('plan_created + already_fixed → sentry_status(resolved) + sentry_comment + slack_outcome (no Linear)', () => {
    const outcome: SessionOutcome = {
      outcome: 'plan_created',
      confidence: 90,
      plan_file: 'plan.md',
      root_cause: 'this bug is already fixed on dev',
      is_bug: true,
    };
    const actions = planActions({
      issue: makeIssue(),
      outcome,
      verification: defaultVerification(),
      config: makeConfig(),
      now: NOW,
    });
    expect(actions.map((a) => a.kind)).toEqual([
      'sentry_status',
      'sentry_comment',
      'slack_outcome',
    ]);
    expect(actions.find((a) => a.kind === 'sentry_status')?.payload).toEqual({
      status: 'resolved',
    });
  });

  it('plan_created + not_a_bug signals → sentry_status(ignored) + sentry_comment + slack_outcome', () => {
    const outcome: SessionOutcome = {
      outcome: 'plan_created',
      confidence: 60,
      plan_file: 'plan.md',
      root_cause: 'working as designed',
      is_bug: false,
    };
    const actions = planActions({
      issue: makeIssue(),
      outcome,
      verification: defaultVerification(),
      config: makeConfig(),
      now: NOW,
    });
    expect(actions.map((a) => a.kind)).toEqual([
      'sentry_status',
      'sentry_comment',
      'slack_outcome',
    ]);
    const status = actions.find((a) => a.kind === 'sentry_status');
    expect(status?.payload).toEqual({
      status: 'ignored',
      status_details: {},
      substatus: 'archived_until_escalating',
    });
  });

  it('not_a_bug → sentry_status(ignored) + sentry_comment + slack_outcome (no Linear)', () => {
    const outcome: SessionOutcome = {
      outcome: 'not_a_bug',
      reason: 'expected behaviour',
    };
    const actions = planActions({
      issue: makeIssue(),
      outcome,
      verification: defaultVerification(),
      config: makeConfig(),
      now: NOW,
    });
    expect(actions.map((a) => a.kind)).toEqual([
      'sentry_status',
      'sentry_comment',
      'slack_outcome',
    ]);
    expect(actions.find((a) => a.kind === 'sentry_status')?.payload).toEqual({
      status: 'ignored',
      status_details: {},
      substatus: 'archived_until_escalating',
    });
  });

  it('escalated → linear_create_issue + sentry_comment + slack_outcome', () => {
    const outcome: SessionOutcome = {
      outcome: 'escalated',
      confidence: 30,
      reason: 'autopilot ran out of confidence',
    };
    const actions = planActions({
      issue: makeIssue(),
      outcome,
      verification: defaultVerification(),
      config: makeConfig(),
      now: NOW,
    });
    expect(actions.map((a) => a.kind)).toEqual([
      'linear_create_issue',
      'sentry_comment',
      'slack_outcome',
    ]);
  });

  it('failed (parse_failure) → slack_outcome (MUST be present; terminal visibility channel)', () => {
    const outcome: SessionOutcome = {
      outcome: 'failed',
      failure_kind: 'parse_failure',
      error: 'unexpected token',
      original_outcome: JSON.stringify({ truncated_text: '{', artifact_path: '/tmp/x.json' }),
    };
    const actions = planActions({
      issue: makeIssue({ status: 'failed', failure_kind: 'parse_failure' }),
      outcome,
      verification: defaultVerification(),
      config: makeConfig(),
      now: NOW,
    });
    expect(actions.map((a) => a.kind)).toEqual(['slack_outcome']);
  });

  it('failed (generic, non-parse) → linear_create_issue + sentry_comment + slack_outcome', () => {
    // Non-parse failures still create a Linear issue so humans can pick up
    // the residual investigation (matches `shouldCreateLinearIssue`).
    const outcome: SessionOutcome = {
      outcome: 'failed',
      error: 'something blew up',
    };
    const actions = planActions({
      issue: makeIssue({ status: 'failed' }),
      outcome,
      verification: defaultVerification(),
      config: makeConfig(),
      now: NOW,
    });
    expect(actions.map((a) => a.kind)).toEqual([
      'linear_create_issue',
      'sentry_comment',
      'slack_outcome',
    ]);
  });

  it('is_user_reported + plan_created → does NOT add slack_user_alert (only auto_committed triggers it)', () => {
    // After Stage 3 gating: we only nudge humans to respond to the reporter
    // when we actually have a fix on dev. plan_created means the agent only
    // produced a plan, so no draft response is sent yet.
    const outcome: SessionOutcome = {
      outcome: 'plan_created',
      confidence: 70,
      plan_file: 'plan.md',
      root_cause: 'thing broke',
      is_bug: true,
    };
    const actions = planActions({
      issue: makeIssue({ is_user_reported: true }),
      outcome,
      verification: defaultVerification(),
      config: makeConfig(),
      now: NOW,
    });
    expect(actions.map((a) => a.kind)).toEqual([
      'linear_create_issue',
      'sentry_comment',
      'slack_outcome',
    ]);
    expect(actions.some((a) => a.kind === 'slack_user_alert')).toBe(false);
    expect(actions.some((a) => a.kind === 'slack_draft_response')).toBe(false);
  });

  it('is_user_reported + escalated + draft file present → does NOT add slack_user_alert or slack_draft_response', () => {
    // Even when a draft file happens to exist, escalated outcomes must not
    // surface a draft — we have no committed fix to promise the reporter.
    const config = makeConfig();
    const issue = makeIssue({ is_user_reported: true });
    const artifactDir = path.join(config.stateDir, 'artifacts', issue.sentry_id);
    fs.mkdirSync(artifactDir, { recursive: true });
    fs.writeFileSync(
      path.join(artifactDir, 'user_response_draft.md'),
      'Hi user, sorry about the issue.\n',
    );
    const outcome: SessionOutcome = {
      outcome: 'escalated',
      reason: 'needs human',
    };
    const actions = planActions({
      issue,
      outcome,
      verification: defaultVerification(),
      config,
      now: NOW,
    });
    expect(actions.map((a) => a.kind)).toEqual([
      'linear_create_issue',
      'sentry_comment',
      'slack_outcome',
    ]);
    expect(actions.some((a) => a.kind === 'slack_user_alert')).toBe(false);
    expect(actions.some((a) => a.kind === 'slack_draft_response')).toBe(false);
  });

  it('is_user_reported + auto_committed → adds slack_user_alert (no draft file)', () => {
    // The fix landed on dev, so it's time to nudge a human to respond to the
    // reporter. No draft file yet → just the alert, no slack_draft_response.
    const outcome: SessionOutcome = {
      outcome: 'auto_committed',
      confidence: 95,
      commit_hash: 'abc1234',
      root_cause: 'off-by-one in retry loop',
    };
    const actions = planActions({
      issue: makeIssue({
        is_user_reported: true,
        user_email: 'reporter@example.com',
        user_name: 'Reporter Person',
      }),
      outcome,
      verification: defaultVerification(),
      config: makeConfig(),
      now: NOW,
    });
    expect(actions.map((a) => a.kind)).toEqual([
      'sentry_status',
      'sentry_comment',
      'slack_outcome',
      'slack_user_alert',
    ]);
    const alert = actions.find((a) => a.kind === 'slack_user_alert');
    expect(alert?.payload.text).toContain('User-reported bug');
    expect(alert?.payload.text).toContain('Reporter Person <reporter@example.com>');
  });

  it('is_user_reported + auto_committed + draft file → adds slack_user_alert AND slack_draft_response with reporter line', () => {
    const config = makeConfig();
    const issue = makeIssue({
      is_user_reported: true,
      user_email: 'reporter@example.com',
      user_name: 'Reporter Person',
    });
    const artifactDir = path.join(config.stateDir, 'artifacts', issue.sentry_id);
    fs.mkdirSync(artifactDir, { recursive: true });
    fs.writeFileSync(
      path.join(artifactDir, 'user_response_draft.md'),
      'Hi Reporter, thanks for flagging — fix is on its way.\n',
    );
    const outcome: SessionOutcome = {
      outcome: 'auto_committed',
      confidence: 95,
      commit_hash: 'abc1234',
      root_cause: 'off-by-one',
    };
    const actions = planActions({
      issue,
      outcome,
      verification: defaultVerification(),
      config,
      now: NOW,
    });
    expect(actions.map((a) => a.kind)).toEqual([
      'sentry_status',
      'sentry_comment',
      'slack_outcome',
      'slack_user_alert',
      'slack_draft_response',
    ]);
    const alert = actions.find((a) => a.kind === 'slack_user_alert');
    expect(alert?.payload.text).toContain('*Reporter:* Reporter Person <reporter@example.com>');
    const draft = actions.find((a) => a.kind === 'slack_draft_response');
    expect(draft?.payload.text).toContain('*Reporter:* Reporter Person <reporter@example.com>');
    expect(draft?.payload.text).toContain('Hi Reporter, thanks for flagging');
  });

  it('is_user_reported + auto_committed with email only → reporter line shows email only', () => {
    const config = makeConfig();
    const issue = makeIssue({
      is_user_reported: true,
      user_email: 'reporter@example.com',
      user_name: null,
    });
    const artifactDir = path.join(config.stateDir, 'artifacts', issue.sentry_id);
    fs.mkdirSync(artifactDir, { recursive: true });
    fs.writeFileSync(
      path.join(artifactDir, 'user_response_draft.md'),
      'Hello, fix incoming.\n',
    );
    const outcome: SessionOutcome = {
      outcome: 'auto_committed',
      confidence: 95,
      commit_hash: 'abc1234',
    };
    const actions = planActions({
      issue,
      outcome,
      verification: defaultVerification(),
      config,
      now: NOW,
    });
    const alert = actions.find((a) => a.kind === 'slack_user_alert');
    expect(alert?.payload.text).toContain('*Reporter email:* reporter@example.com');
    expect(alert?.payload.text).not.toContain('*Reporter:*');
    const draft = actions.find((a) => a.kind === 'slack_draft_response');
    expect(draft?.payload.text).toContain('*Reporter email:* reporter@example.com');
  });

  it('is_user_reported + auto_committed with neither email nor name → no reporter line', () => {
    // Reporter contact info is optional — the widget may not have collected
    // it. We still want the human nudge, just without the contact line.
    const outcome: SessionOutcome = {
      outcome: 'auto_committed',
      confidence: 95,
      commit_hash: 'abc1234',
    };
    const actions = planActions({
      issue: makeIssue({
        is_user_reported: true,
        user_email: null,
        user_name: null,
      }),
      outcome,
      verification: defaultVerification(),
      config: makeConfig(),
      now: NOW,
    });
    const alert = actions.find((a) => a.kind === 'slack_user_alert');
    expect(alert).toBeDefined();
    expect(alert?.payload.text).not.toContain('*Reporter');
  });

  it('!is_user_reported + auto_committed → does NOT add slack_user_alert (even with contact info)', () => {
    // Defensive: contact info should only ever appear when is_user_reported
    // is true. If we somehow have stale fields without the flag, stay quiet.
    const outcome: SessionOutcome = {
      outcome: 'auto_committed',
      confidence: 95,
      commit_hash: 'abc1234',
    };
    const actions = planActions({
      issue: makeIssue({
        is_user_reported: false,
        user_email: 'stale@example.com',
        user_name: 'Stale Name',
      }),
      outcome,
      verification: defaultVerification(),
      config: makeConfig(),
      now: NOW,
    });
    expect(actions.some((a) => a.kind === 'slack_user_alert')).toBe(false);
    expect(actions.some((a) => a.kind === 'slack_draft_response')).toBe(false);
  });

  it('existingLinearIdentifier hint → emits linear_comment_existing instead of linear_create_issue', () => {
    const outcome: SessionOutcome = {
      outcome: 'plan_created',
      confidence: 60,
      plan_file: 'plan.md',
      root_cause: 'something',
      is_bug: true,
    };
    const actions = planActions({
      issue: makeIssue(),
      outcome,
      verification: defaultVerification(),
      config: makeConfig(),
      existingLinearIdentifier: 'FOX-1234',
      now: NOW,
    });
    expect(actions.map((a) => a.kind)).toEqual([
      'linear_comment_existing',
      'sentry_comment',
      'slack_outcome',
    ]);
    const comment = actions.find((a) => a.kind === 'linear_comment_existing');
    expect(comment?.payload.identifier_hint).toBe('FOX-1234');
  });

  it('hard_mismatch verification injects a verification line into slack_outcome', () => {
    const outcome: SessionOutcome = {
      outcome: 'plan_created',
      confidence: 60,
      plan_file: 'plan.md',
      root_cause: 'something',
      is_bug: true,
    };
    const verification: VerificationResult = {
      status: 'hard_mismatch',
      details: [
        {
          check: 'plan_file_exists',
          severity: 'hard',
          passed: false,
          observed: null,
          expected: 'plan.md',
          message: 'Plan file claimed but missing',
        },
      ],
      metrics: { checks_run: 1, hard_failures: 1, soft_failures: 0 },
    };
    const actions = planActions({
      issue: makeIssue(),
      outcome,
      verification,
      config: makeConfig(),
      now: NOW,
    });
    const slack = actions.find((a) => a.kind === 'slack_outcome');
    expect(slack?.payload.text).toMatch(/Verification:.*hard mismatch/);
  });

  it('idempotency keys are deterministic across calls with the same inputs', () => {
    const config = makeConfig();
    const issue = makeIssue();
    const outcome: SessionOutcome = {
      outcome: 'auto_committed',
      confidence: 90,
      commit_hash: 'def456',
      root_cause: 'fix',
    };
    const a1 = planActions({ issue, outcome, verification: defaultVerification(), config, now: NOW });
    const a2 = planActions({ issue, outcome, verification: defaultVerification(), config, now: NOW });
    expect(a1.map((a) => a.idempotency_key)).toEqual(a2.map((a) => a.idempotency_key));
  });

  it('does NOT enqueue pr_open when pushMode is "disabled" (Stage C default)', () => {
    const outcome: SessionOutcome = {
      outcome: 'auto_committed',
      confidence: 95,
      commit_hash: 'abc1234',
      branch_name: 'autopilot/sentry-PLAN',
    };
    const actions = planActions({
      issue: makeIssue(),
      outcome,
      verification: { status: 'pass', details: [], metrics: {} },
      config: { ...makeConfig(), pushMode: 'disabled' },
      now: NOW,
    });
    expect(actions.some((a) => a.kind === 'pr_open')).toBe(false);
  });

  it('does NOT enqueue pr_open when pushMode is "branch_only" (Stage E intermediate)', () => {
    const outcome: SessionOutcome = {
      outcome: 'auto_committed',
      confidence: 95,
      commit_hash: 'abc1234',
      branch_name: 'autopilot/sentry-PLAN',
    };
    const actions = planActions({
      issue: makeIssue(),
      outcome,
      verification: { status: 'pass', details: [], metrics: {} },
      config: { ...makeConfig(), pushMode: 'branch_only' },
      now: NOW,
    });
    expect(actions.some((a) => a.kind === 'pr_open')).toBe(false);
  });

  it('Stage E enqueues pr_open under pushMode=pr with passing verification + auto_committed', () => {
    const outcome: SessionOutcome = {
      outcome: 'auto_committed',
      confidence: 95,
      commit_hash: 'abc1234',
      branch_name: 'autopilot/sentry-PLAN',
    };
    const actions = planActions({
      issue: makeIssue(),
      outcome,
      verification: { status: 'pass', details: [], metrics: {} },
      config: {
        ...makeConfig(),
        pushMode: 'pr',
        verifyMode: 'enforce',
        githubToken: 'ghp_fake',
        repoFullName: 'mindstone/rebel-app',
      },
      now: NOW,
    });
    const prAction = actions.find((a) => a.kind === 'pr_open');
    expect(prAction).toBeDefined();
    if (prAction && prAction.kind === 'pr_open') {
      expect(prAction.payload.branch_name).toBe('autopilot/sentry-PLAN');
      expect(prAction.payload.base).toBe('dev');
      expect(prAction.payload.title).toMatch(/^\[Autopilot\] /);
      expect(prAction.payload.body).toMatch(/Sentry issue:/);
      expect(prAction.payload.body).toMatch(/autopilot disclaimer/i);
      expect(prAction.idempotency_key).toBe(
        'pr_open:SENTRY-PLAN:autopilot/sentry-PLAN',
      );
    }
  });

  it('does NOT enqueue pr_open under pushMode=pr when verification is hard_mismatch', () => {
    const outcome: SessionOutcome = {
      outcome: 'auto_committed',
      confidence: 95,
      commit_hash: 'abc1234',
      branch_name: 'autopilot/sentry-PLAN',
    };
    const actions = planActions({
      issue: makeIssue(),
      outcome,
      verification: { status: 'hard_mismatch', details: [], metrics: {} },
      config: {
        ...makeConfig(),
        pushMode: 'pr',
        verifyMode: 'enforce',
        githubToken: 'ghp_fake',
        repoFullName: 'mindstone/rebel-app',
      },
      now: NOW,
    });
    expect(actions.some((a) => a.kind === 'pr_open')).toBe(false);
  });

  it('does NOT enqueue pr_open for plan_created outcomes even under pushMode=pr', () => {
    const outcome: SessionOutcome = {
      outcome: 'plan_created',
      confidence: 82,
      plan_file: 'plan.md',
      branch_name: 'autopilot/sentry-PLAN',
    };
    const actions = planActions({
      issue: makeIssue(),
      outcome,
      verification: { status: 'pass', details: [], metrics: {} },
      config: {
        ...makeConfig(),
        pushMode: 'pr',
        verifyMode: 'enforce',
        githubToken: 'ghp_fake',
        repoFullName: 'mindstone/rebel-app',
      },
      now: NOW,
    });
    expect(actions.some((a) => a.kind === 'pr_open')).toBe(false);
  });

  it('does NOT enqueue pr_open when branch_name is missing on outcome', () => {
    const outcome: SessionOutcome = {
      outcome: 'auto_committed',
      confidence: 95,
      commit_hash: 'abc1234',
    };
    const actions = planActions({
      issue: makeIssue(),
      outcome,
      verification: { status: 'pass', details: [], metrics: {} },
      config: {
        ...makeConfig(),
        pushMode: 'pr',
        verifyMode: 'enforce',
        githubToken: 'ghp_fake',
        repoFullName: 'mindstone/rebel-app',
      },
      now: NOW,
    });
    expect(actions.some((a) => a.kind === 'pr_open')).toBe(false);
  });

  it('enqueues pr_merge alongside pr_open under the same gates', () => {
    const outcome: SessionOutcome = {
      outcome: 'auto_committed',
      confidence: 95,
      commit_hash: 'abc1234',
      branch_name: 'autopilot/sentry-PLAN',
    };
    const actions = planActions({
      issue: makeIssue(),
      outcome,
      verification: { status: 'pass', details: [], metrics: {} },
      config: {
        ...makeConfig(),
        pushMode: 'pr',
        verifyMode: 'enforce',
        githubToken: 'ghp_fake',
        repoFullName: 'mindstone/rebel-app',
      },
      now: NOW,
    });
    const prOpen = actions.find((a) => a.kind === 'pr_open');
    const prMerge = actions.find((a) => a.kind === 'pr_merge');
    expect(prOpen).toBeDefined();
    expect(prMerge).toBeDefined();
    if (prMerge && prMerge.kind === 'pr_merge') {
      expect(prMerge.payload.branch_name).toBe('autopilot/sentry-PLAN');
      expect(prMerge.payload.merge_method).toBe('squash');
      expect(prMerge.idempotency_key).toBe('pr_merge:SENTRY-PLAN:autopilot/sentry-PLAN');
    }
  });

  it('does NOT enqueue pr_merge when pr_open is gated out (verification mismatch)', () => {
    const outcome: SessionOutcome = {
      outcome: 'auto_committed',
      confidence: 95,
      commit_hash: 'abc1234',
      branch_name: 'autopilot/sentry-PLAN',
    };
    const actions = planActions({
      issue: makeIssue(),
      outcome,
      verification: { status: 'hard_mismatch', details: [], metrics: {} },
      config: {
        ...makeConfig(),
        pushMode: 'pr',
        verifyMode: 'enforce',
        githubToken: 'ghp_fake',
        repoFullName: 'mindstone/rebel-app',
      },
      now: NOW,
    });
    expect(actions.some((a) => a.kind === 'pr_merge')).toBe(false);
  });
});
