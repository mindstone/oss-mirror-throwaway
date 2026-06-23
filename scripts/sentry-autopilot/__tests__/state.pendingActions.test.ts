import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { PendingAction } from '../pending-actions.ts';
import { StateDB } from '../state.ts';

const dirs: string[] = [];

function tmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'state-pending-actions-'));
  dirs.push(dir);
  return dir;
}

function makeAction(idempotencyKey: string, attempts = 0, lastError: string | null = null): PendingAction {
  return {
    kind: 'slack_outcome',
    payload: { text: 'msg' },
    idempotency_key: idempotencyKey,
    attempts,
    last_error: lastError,
    created_at: '2026-05-15T00:00:00.000Z',
  };
}

afterEach(() => {
  while (dirs.length > 0) {
    const dir = dirs.pop();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('StateDB pending-action utilities', () => {
  let db: StateDB;

  beforeEach(() => {
    const dir = tmpDir();
    db = new StateDB(path.join(dir, 'state.db'));
    db.upsertIssue({
      sentry_id: 'SENTRY-PENDING',
      sentry_url: 'https://sentry.io/issues/SENTRY-PENDING',
      title: 'test',
      status: 'completed',
    });
  });

  it('returns [] when pending_actions is null', () => {
    expect(db.getPendingActions('SENTRY-PENDING')).toEqual([]);
  });

  it('markCompleted co-writes the pending_actions queue atomically', () => {
    const pending = [makeAction('a'), makeAction('b')];
    db.markCompleted('SENTRY-PENDING', 'plan_created', 80, undefined, 'plan.md', {}, pending);
    const queue = db.getPendingActions('SENTRY-PENDING');
    expect(queue.map((a) => a.idempotency_key)).toEqual(['a', 'b']);
  });

  it('removePendingAction filters out the matching idempotency_key', () => {
    db.markCompleted(
      'SENTRY-PENDING',
      'plan_created',
      80,
      undefined,
      'plan.md',
      {},
      [makeAction('a'), makeAction('b'), makeAction('c')],
    );
    db.removePendingAction('SENTRY-PENDING', 'b');
    const queue = db.getPendingActions('SENTRY-PENDING');
    expect(queue.map((a) => a.idempotency_key)).toEqual(['a', 'c']);
  });

  it('removePendingAction is a no-op when the key is absent', () => {
    db.markCompleted(
      'SENTRY-PENDING',
      'plan_created',
      80,
      undefined,
      'plan.md',
      {},
      [makeAction('a')],
    );
    db.removePendingAction('SENTRY-PENDING', 'missing');
    expect(db.getPendingActions('SENTRY-PENDING')).toHaveLength(1);
  });

  it('recordPendingAttempt bumps attempts and writes last_error', () => {
    db.markCompleted(
      'SENTRY-PENDING',
      'plan_created',
      80,
      undefined,
      'plan.md',
      {},
      [makeAction('a'), makeAction('b')],
    );
    db.recordPendingAttempt('SENTRY-PENDING', 'a', 'rate-limited');
    db.recordPendingAttempt('SENTRY-PENDING', 'a', 'still rate-limited');
    const queue = db.getPendingActions('SENTRY-PENDING');
    const a = queue.find((entry) => entry.idempotency_key === 'a');
    expect(a?.attempts).toBe(2);
    expect(a?.last_error).toBe('still rate-limited');
    const b = queue.find((entry) => entry.idempotency_key === 'b');
    expect(b?.attempts).toBe(0);
    expect(b?.last_error).toBeNull();
  });
});
