import { describe, expect, it } from 'vitest';

import {
  ACTION_DRAIN_ORDER,
  deserializePendingActions,
  MAX_ATTEMPTS_PER_ACTION,
  PendingAction,
  PendingActions,
  serializePendingActions,
} from '../pending-actions.ts';

describe('PendingAction schema', () => {
  it('accepts a valid sentry_status action with defaults', () => {
    const parsed = PendingAction.parse({
      kind: 'sentry_status',
      payload: { status: 'resolved' },
      idempotency_key: 'sentry_status:abc:resolved',
      created_at: '2026-05-15T00:00:00.000Z',
    });
    expect(parsed.kind).toBe('sentry_status');
    expect(parsed.attempts).toBe(0);
    expect(parsed.last_error).toBeNull();
  });

  it('accepts a sentry_status action with archived_until_escalating substatus', () => {
    const parsed = PendingAction.parse({
      kind: 'sentry_status',
      payload: {
        status: 'ignored',
        status_details: {},
        substatus: 'archived_until_escalating',
      },
      idempotency_key: 'sentry_status:abc:ignored',
      created_at: '2026-05-15T00:00:00.000Z',
    });
    expect(parsed.kind).toBe('sentry_status');
    if (parsed.kind !== 'sentry_status') return;
    expect(parsed.payload.substatus).toBe('archived_until_escalating');
  });

  it('rejects a sentry_status with an unknown substatus value', () => {
    expect(() =>
      PendingAction.parse({
        kind: 'sentry_status',
        payload: { status: 'ignored', substatus: 'archived_for_a_while' },
        idempotency_key: 'sentry_status:abc:ignored',
        created_at: '2026-05-15T00:00:00.000Z',
      }),
    ).toThrow();
  });

  it('rejects an action with an unknown kind', () => {
    expect(() =>
      PendingAction.parse({
        kind: 'totally_unknown',
        payload: {},
        idempotency_key: 'x',
        created_at: '2026-05-15T00:00:00.000Z',
      }),
    ).toThrow();
  });

  it('rejects a pr_open with an invalid branch name', () => {
    expect(() =>
      PendingAction.parse({
        kind: 'pr_open',
        payload: {
          branch_name: 'feature/foo',
          base: 'dev',
          title: 'x',
          body: 'y',
        },
        idempotency_key: 'pr_open:foo',
        created_at: '2026-05-15T00:00:00.000Z',
      }),
    ).toThrow();
  });

  it('rejects a pr_open targeting main', () => {
    expect(() =>
      PendingAction.parse({
        kind: 'pr_open',
        payload: {
          branch_name: 'autopilot/sentry-foo',
          // @ts-expect-error — we are intentionally probing the runtime guard
          base: 'main',
          title: 'x',
          body: 'y',
        },
        idempotency_key: 'pr_open:foo',
        created_at: '2026-05-15T00:00:00.000Z',
      }),
    ).toThrow();
  });

  it('caps the array at 20 actions', () => {
    const action = {
      kind: 'slack_outcome' as const,
      payload: { text: 'hi' },
      idempotency_key: 'k',
      created_at: '2026-05-15T00:00:00.000Z',
    };
    const tooMany = Array.from({ length: 21 }, () => action);
    expect(() => PendingActions.parse(tooMany)).toThrow();
    const justRight = Array.from({ length: 20 }, () => action);
    expect(PendingActions.parse(justRight)).toHaveLength(20);
  });

  it('round-trips serialize / deserialize', () => {
    const actions: PendingAction[] = [
      {
        kind: 'slack_outcome',
        payload: { text: 'hello' },
        idempotency_key: 'a',
        attempts: 2,
        last_error: 'rate-limited',
        created_at: '2026-05-15T00:00:00.000Z',
      },
    ];
    const serialized = serializePendingActions(actions);
    expect(serialized).not.toBeNull();
    const round = deserializePendingActions(serialized);
    expect(round).toEqual(actions);
  });

  it('serializePendingActions returns null for empty input', () => {
    expect(serializePendingActions([])).toBeNull();
    expect(deserializePendingActions(null)).toEqual([]);
    expect(deserializePendingActions(undefined)).toEqual([]);
  });

  it('MAX_ATTEMPTS_PER_ACTION is 5', () => {
    expect(MAX_ATTEMPTS_PER_ACTION).toBe(5);
  });

  it('ACTION_DRAIN_ORDER puts sentry_status first and pr_open before slack_outcome', () => {
    expect(ACTION_DRAIN_ORDER[0]).toBe('sentry_status');
    const prIdx = ACTION_DRAIN_ORDER.indexOf('pr_open');
    const slackIdx = ACTION_DRAIN_ORDER.indexOf('slack_outcome');
    expect(prIdx).toBeGreaterThan(-1);
    expect(slackIdx).toBeGreaterThan(prIdx);
  });

  it('ACTION_DRAIN_ORDER places pr_merge immediately after pr_open', () => {
    const prOpenIdx = ACTION_DRAIN_ORDER.indexOf('pr_open');
    const prMergeIdx = ACTION_DRAIN_ORDER.indexOf('pr_merge');
    expect(prOpenIdx).toBeGreaterThan(-1);
    expect(prMergeIdx).toBeGreaterThan(prOpenIdx);
    expect(prMergeIdx).toBe(prOpenIdx + 1);
    // pr_merge still runs before slack_outcome so a successful merge is
    // visible in the Slack message.
    const slackIdx = ACTION_DRAIN_ORDER.indexOf('slack_outcome');
    expect(slackIdx).toBeGreaterThan(prMergeIdx);
  });

  it('accepts a valid pr_merge action', () => {
    const parsed = PendingAction.parse({
      kind: 'pr_merge',
      payload: { branch_name: 'autopilot/sentry-abc', merge_method: 'squash' },
      idempotency_key: 'pr_merge:abc:autopilot/sentry-abc',
      created_at: '2026-05-15T00:00:00.000Z',
    });
    expect(parsed.kind).toBe('pr_merge');
    if (parsed.kind !== 'pr_merge') return;
    expect(parsed.payload.merge_method).toBe('squash');
  });

  it('rejects pr_merge with non-autopilot branch name', () => {
    expect(() =>
      PendingAction.parse({
        kind: 'pr_merge',
        payload: { branch_name: 'feature/foo', merge_method: 'squash' },
        idempotency_key: 'pr_merge:foo',
        created_at: '2026-05-15T00:00:00.000Z',
      }),
    ).toThrow();
  });

  it('rejects pr_merge with merge_method other than squash', () => {
    expect(() =>
      PendingAction.parse({
        kind: 'pr_merge',
        payload: {
          branch_name: 'autopilot/sentry-abc',
          // @ts-expect-error — we are intentionally probing the runtime guard
          merge_method: 'rebase',
        },
        idempotency_key: 'pr_merge:abc',
        created_at: '2026-05-15T00:00:00.000Z',
      }),
    ).toThrow();
  });
});
