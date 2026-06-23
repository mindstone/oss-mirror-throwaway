/**
 * Targeted-dispatch helper tests.
 *
 * `filterPendingForTarget` is the in-dispatcher guard that makes
 * `AUTOPILOT_TARGET_SENTRY_ID` deterministic for Layer 4 / Layer 5
 * controlled tests. When the env var is set, the dispatcher must:
 *   1. Dispatch ONLY the pre-seeded target row, never another `pending` row
 *      (even one that would normally win `is_user_reported DESC, created_at ASC`).
 *   2. Fail loud (throw) if the target row is absent — never silently no-op
 *      or fall back to "next available".
 *
 * When the env var is unset, behavior is unchanged: pass-through of the
 * full pending list in DB priority order.
 *
 * The poll-skip behavior in `main()` is verified separately by code review +
 * Layer 4 smoke; that path requires mocking SessionManager / Reporter / DB
 * which is out of scope for a focused unit test.
 */

import { describe, expect, it } from 'vitest';

import { filterPendingForTarget } from '../dispatcher.ts';
import type { IssueRow } from '../state.ts';

function makePending(sentryId: string, overrides: Partial<IssueRow> = {}): IssueRow {
  return {
    sentry_id: sentryId,
    sentry_url: `https://sentry.io/issues/${sentryId}/`,
    title: `Synthetic issue ${sentryId}`,
    error_type: 'exception',
    is_user_reported: false,
    occurrences: 1,
    users: 1,
    status: 'pending',
    dispatch_count: 0,
    max_retries: 1,
    confidence: null,
    outcome: null,
    last_error: null,
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
    created_at: '2026-05-22T00:00:00Z',
    updated_at: '2026-05-22T00:00:00Z',
    dispatched_at: null,
    completed_at: null,
    ...overrides,
  };
}

describe('filterPendingForTarget', () => {
  it('returns the full pending list unchanged when no target is set', () => {
    const pending = [makePending('A'), makePending('B'), makePending('C')];
    expect(filterPendingForTarget(pending, undefined)).toEqual(pending);
  });

  it('returns the full pending list unchanged when target is empty string', () => {
    const pending = [makePending('A'), makePending('B')];
    expect(filterPendingForTarget(pending, '')).toEqual(pending);
  });

  it('returns only the matching row when target is set', () => {
    const pending = [makePending('A'), makePending('TARGET'), makePending('C')];
    const result = filterPendingForTarget(pending, 'TARGET');
    expect(result).toHaveLength(1);
    expect(result[0].sentry_id).toBe('TARGET');
  });

  it('returns the matching row even when a user-reported row would normally preempt it', () => {
    // Real getPendingIssues() sorts by `is_user_reported DESC, created_at ASC`,
    // so 'NOISE' would naturally come first. Target mode must override that.
    const pending = [
      makePending('NOISE', { is_user_reported: true }),
      makePending('TARGET', { is_user_reported: false }),
    ];
    const result = filterPendingForTarget(pending, 'TARGET');
    expect(result).toHaveLength(1);
    expect(result[0].sentry_id).toBe('TARGET');
  });

  it('throws fail-loud when target set but no pending row matches', () => {
    const pending = [makePending('A'), makePending('B')];
    expect(() => filterPendingForTarget(pending, 'NOT_THERE')).toThrowError(
      /AUTOPILOT_TARGET_SENTRY_ID=NOT_THERE.*no matching pending row/i,
    );
  });

  it('throws fail-loud and lists available pending ids in the error message', () => {
    const pending = [makePending('ALPHA'), makePending('BETA')];
    let caught: Error | undefined;
    try {
      filterPendingForTarget(pending, 'GAMMA');
    } catch (error) {
      caught = error as Error;
    }
    expect(caught).toBeDefined();
    expect(caught?.message).toContain('ALPHA');
    expect(caught?.message).toContain('BETA');
  });

  it('throws fail-loud when pending list is empty and target is set', () => {
    expect(() => filterPendingForTarget([], 'TARGET')).toThrowError(
      /no matching pending row.*\(none\)/i,
    );
  });

  it('does not throw when pending list is empty and target is unset (idle tick)', () => {
    expect(filterPendingForTarget([], undefined)).toEqual([]);
  });
});
