/**
 * Stage 2 regression test for autopilot-claude-runtime-fixes.
 *
 * Background
 * ----------
 * `nonEmpty()` in `reporter.ts` was typed `(value: string | undefined)` but
 * called against fields like `outcome.blockers_to_auto_commit` and
 * `outcome.risks` that aren't declared on `SessionOutcome` — they reach the
 * reporter via the outcome schema's per-branch `.catchall(z.unknown())`.
 * When a runner emits one of those as a non-string (object, array, number),
 * `value.trim()` threw `value.trim is not a function` and the entire
 * `linear.create_issue` operation failed silently. Observed in cron.log on
 * 2026-06-06 during a droid-mode session — pre-existing, manifests under
 * any runner.
 *
 * What this test guards against
 * -----------------------------
 * `nonEmpty()` returns `undefined` for non-string inputs rather than
 * throwing, while preserving its existing string-input semantics
 * (returns `undefined` for empty/whitespace, otherwise the trimmed string).
 *
 * The reporter doesn't export `nonEmpty()` directly. We exercise it through
 * its only effective consumer surface — the linear handoff body — by
 * constructing an outcome that places non-string values on the catchall
 * fields and asserting the body renders without throwing.
 */

import { describe, expect, it } from 'vitest';

import type { AutopilotConfig } from '../config.ts';
import { __testing__ as reporterInternals } from '../reporter.ts';
import type { IssueRow } from '../state.ts';
import type { SessionOutcome } from '../session-manager.ts';

const { buildLinearDescriptionPure } = reporterInternals;
const buildLinearHandoffBody = buildLinearDescriptionPure;

function makeConfig(): AutopilotConfig {
  return {
    sentryAuthToken: 'token',
    sentryOrg: 'mindstone',
    sentryProject: 'rebel',
    linearApiKey: 'lin-key',
    slackWebhook: undefined,
    phase: 'shadow',
    verifyMode: 'disabled',
    pushMode: 'disabled',
    pendingMode: 'disabled',
    stateDir: '/tmp/test-state',
    maxConcurrent: 1,
    maxHourly: 1,
    maxDaily: 1,
    maxRetries: 2,
    sessionTimeoutSeconds: 60,
    bootstrapLookbackHours: 24,
    repoRoot: '/tmp/test-repo',
    cli: 'droid',
    cursorModel: 'composer-2.5',
    claudeModel: 'claude-opus-4-8',
  };
}

function makeIssue(): IssueRow {
  return {
    sentry_id: '7521700556',
    sentry_url: 'https://sentry.io/issues/7521700556',
    title: 'TypeError: Cannot read properties of undefined',
    error_type: 'exception',
    is_user_reported: false,
    occurrences: 12,
    users: 4,
    status: 'completed',
    dispatch_count: 1,
    max_retries: 2,
    confidence: 88,
    outcome: 'plan_created',
    last_error: null,
    commit_hash: null,
    plan_file: 'plan.md',
    linear_issue_id: null,
    tmux_session: 'sentry-7521700556',
    worktree_slot: 0,
    user_description: null,
    pending_actions: null,
    verification_status: null,
    verification_details: null,
    branch_name: null,
    pr_url: null,
    pushed_at: null,
    created_at: '2026-06-06T18:00:00Z',
    updated_at: '2026-06-06T18:30:00Z',
    dispatched_at: '2026-06-06T18:00:00Z',
    completed_at: '2026-06-06T18:30:00Z',
  };
}

const STRING_OUTCOME: SessionOutcome = {
  outcome: 'plan_created',
  confidence: 88,
  is_bug: true,
  shadow_would_commit: false,
  plan_file: 'plan.md',
  reason: 'Recommend follow-up review',
  // String catchall values — the legacy happy path.
  ...({
    blockers_to_auto_commit: 'Multi-file change touches a shared classifier',
    risks: 'Behavioural drift on edge cases',
  } as unknown as SessionOutcome),
};

describe('reporter nonEmpty — defensive against non-string catchall values', () => {
  it('renders without throwing when blockers/risks arrive as objects', () => {
    // Real-world failure mode: the runner emits structured objects on the
    // catchall fields rather than prose strings.
    const outcome: SessionOutcome = {
      outcome: 'plan_created',
      confidence: 60,
      is_bug: true,
      shadow_would_commit: false,
      plan_file: 'plan.md',
      reason: 'Needs review',
      ...({
        blockers_to_auto_commit: { items: ['auth touched', 'shared schema'] },
        risks: ['high blast radius', 'no e2e coverage'],
      } as unknown as SessionOutcome),
    };

    expect(() => buildLinearHandoffBody(makeIssue(), outcome, makeConfig())).not.toThrow();

    const body = buildLinearHandoffBody(makeIssue(), outcome, makeConfig());
    expect(typeof body).toBe('string');
    expect(body.length).toBeGreaterThan(0);
  });

  it('renders without throwing when blockers/risks arrive as numbers or null', () => {
    const outcome: SessionOutcome = {
      outcome: 'plan_created',
      confidence: 70,
      is_bug: true,
      shadow_would_commit: false,
      plan_file: 'plan.md',
      reason: 'Numeric anomaly',
      ...({
        blockers_to_auto_commit: 42,
        risks: null,
      } as unknown as SessionOutcome),
    };

    expect(() => buildLinearHandoffBody(makeIssue(), outcome, makeConfig())).not.toThrow();
  });

  it('preserves string-input semantics — non-empty trimmed strings still render in the body', () => {
    const body = buildLinearHandoffBody(makeIssue(), STRING_OUTCOME, makeConfig());

    expect(body).toContain('Multi-file change touches a shared classifier');
    expect(body).toContain('Behavioural drift on edge cases');
  });

  it('returns falsy for empty / whitespace strings (existing semantics preserved)', () => {
    const outcome: SessionOutcome = {
      outcome: 'plan_created',
      confidence: 50,
      is_bug: true,
      shadow_would_commit: false,
      plan_file: 'plan.md',
      reason: 'Empty fields',
      ...({
        blockers_to_auto_commit: '   ',
        risks: '',
      } as unknown as SessionOutcome),
    };

    const body = buildLinearHandoffBody(makeIssue(), outcome, makeConfig());

    // Empty/whitespace-only inputs are dropped — we render the body without
    // injecting empty "Blockers:" / "Risks:" headers.
    expect(body).not.toMatch(/blockers.*\n\n/i);
    expect(body).not.toMatch(/risks.*\n\n\n/i);
  });
});
