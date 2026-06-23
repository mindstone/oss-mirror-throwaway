import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { PendingAction } from '../pending-actions.ts';
import { StateDB } from '../state.ts';

const dirs: string[] = [];

function tmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'state-mark-verify-'));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  while (dirs.length > 0) {
    const dir = dirs.pop();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('StateDB.markVerificationFailure', () => {
  let db: StateDB;

  beforeEach(() => {
    const dir = tmpDir();
    db = new StateDB(path.join(dir, 'state.db'));
  });

  function seedIssue(sentryId: string): void {
    db.upsertIssue({
      sentry_id: sentryId,
      sentry_url: `https://sentry.io/issues/${sentryId}`,
      title: 'test',
      status: 'in_progress',
      tmux_session: 'sentry-test',
      worktree_slot: 0,
    });
  }

  it('writes status=failed, failure_kind=verification_failure, verification_status=hard_mismatch', () => {
    seedIssue('SENTRY-VFAIL');
    db.markVerificationFailure('SENTRY-VFAIL', {
      details: { status: 'hard_mismatch', details: [{ check: 'plan_file_exists', passed: false }] },
      summary: 'plan file missing',
    });

    const row = db.getIssue('SENTRY-VFAIL');
    expect(row).toBeDefined();
    expect(row?.status).toBe('failed');
    expect(row?.failure_kind).toBe('verification_failure');
    expect(row?.verification_status).toBe('hard_mismatch');
    expect(row?.tmux_session).toBeNull();
    expect(row?.worktree_slot).toBeNull();
    expect(row?.completed_at).toBeTruthy();
    expect(row?.last_error).toContain('plan file missing');
    expect(row?.verification_details).toContain('plan_file_exists');
  });

  it('co-writes pending_actions atomically', () => {
    seedIssue('SENTRY-VFAIL-PENDING');
    const pending: PendingAction[] = [
      {
        kind: 'slack_outcome',
        payload: { text: 'verification failed' },
        idempotency_key: 'slack_outcome:abc',
        attempts: 0,
        last_error: null,
        created_at: '2026-05-15T00:00:00.000Z',
      },
    ];
    db.markVerificationFailure(
      'SENTRY-VFAIL-PENDING',
      { details: {}, summary: 'mismatch' },
      pending,
    );

    const queue = db.getPendingActions('SENTRY-VFAIL-PENDING');
    expect(queue).toHaveLength(1);
    expect(queue[0]?.kind).toBe('slack_outcome');
    expect(queue[0]?.idempotency_key).toBe('slack_outcome:abc');
  });

  it('throws if the issue does not exist', () => {
    expect(() =>
      db.markVerificationFailure('SENTRY-NOPE', { details: {}, summary: 'x' }),
    ).toThrowError(/issue not found/);
  });
});
