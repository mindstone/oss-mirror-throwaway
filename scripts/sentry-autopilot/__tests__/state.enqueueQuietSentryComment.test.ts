import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { StateDB } from '../state.ts';

const dirs: string[] = [];

function tmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'quiet-sentry-comment-'));
  dirs.push(dir);
  return dir;
}

function seedIssue(db: StateDB, sentryId = 'SENTRY-COMMENT'): void {
  db.upsertIssue({
    sentry_id: sentryId,
    sentry_url: `https://sentry.io/issues/${sentryId}`,
    title: 'Quiet comment issue',
    status: 'skipped',
    max_retries: 2,
  });
}

let db: StateDB;

beforeEach(() => {
  const dir = tmpDir();
  db = new StateDB(path.join(dir, 'state.db'));
});

afterEach(() => {
  db.close();
  while (dirs.length > 0) {
    const dir = dirs.pop();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('StateDB.enqueueQuietSentryComment', () => {
  it('enqueues a sentry_comment pending action on first call', () => {
    seedIssue(db);

    const result = db.enqueueQuietSentryComment(
      { sentryId: 'SENTRY-COMMENT' },
      'release-gate-skip',
      'Autopilot skipped this issue.',
      'sentry_comment:SENTRY-COMMENT:release-gate-skip:v0.4.46-vs-v0.3.99',
      '2026-06-07T16:00:00Z',
    );

    expect(result).toBe(true);
    const queue = db.getPendingActions('SENTRY-COMMENT');
    expect(queue).toHaveLength(1);
    expect(queue[0]).toEqual({
      kind: 'sentry_comment',
      payload: { text: 'Autopilot skipped this issue.' },
      idempotency_key: 'sentry_comment:SENTRY-COMMENT:release-gate-skip:v0.4.46-vs-v0.3.99',
      attempts: 0,
      last_error: null,
      created_at: '2026-06-07T16:00:00Z',
    });
  });

  it('does not enqueue a duplicate for the same idempotency_key', () => {
    seedIssue(db);
    const key = 'sentry_comment:SENTRY-COMMENT:release-gate-skip:v0.4.46-vs-v0.3.99';

    expect(db.enqueueQuietSentryComment({ sentryId: 'SENTRY-COMMENT' }, 'release-gate-skip', 'first', key)).toBe(true);
    expect(db.enqueueQuietSentryComment({ sentryId: 'SENTRY-COMMENT' }, 'release-gate-skip', 'second', key)).toBe(false);

    const queue = db.getPendingActions('SENTRY-COMMENT');
    expect(queue).toHaveLength(1);
    expect(queue[0].kind).toBe('sentry_comment');
    if (queue[0].kind !== 'sentry_comment') return;
    expect(queue[0].payload.text).toBe('first');
  });

  it('preserves existing pending actions and appends in the shape the drainer expects', () => {
    seedIssue(db);
    db.replacePendingActions('SENTRY-COMMENT', [
      {
        kind: 'sentry_status',
        payload: { status: 'ignored', substatus: 'archived_until_escalating' },
        idempotency_key: 'sentry_status:SENTRY-COMMENT:ignored',
        attempts: 0,
        last_error: null,
        created_at: '2026-06-07T15:00:00Z',
      },
    ]);

    expect(
      db.enqueueQuietSentryComment(
        { sentry_id: 'SENTRY-COMMENT' },
        'release-gate-skip',
        'Autopilot skipped this issue.',
        'sentry_comment:SENTRY-COMMENT:release-gate-skip:v0.4.46-vs-v0.3.99',
      ),
    ).toBe(true);

    const queue = db.getPendingActions('SENTRY-COMMENT');
    expect(queue.map((action) => action.kind)).toEqual(['sentry_status', 'sentry_comment']);
    const comment = queue[1];
    expect(comment.kind).toBe('sentry_comment');
    if (comment.kind !== 'sentry_comment') return;
    expect(comment.payload).toEqual({ text: 'Autopilot skipped this issue.' });
    expect(comment.attempts).toBe(0);
    expect(comment.last_error).toBeNull();
  });
});

describe('StateDB.enqueueReleaseGateSkipComment', () => {
  it('stores the release-pair key transactionally with the pending comment', () => {
    seedIssue(db);
    const key = 'sentry_comment:SENTRY-COMMENT:release-gate-skip:v0.4.46-vs-v0.3.99';

    expect(
      db.enqueueReleaseGateSkipComment(
        { sentryId: 'SENTRY-COMMENT' },
        'Autopilot skipped this issue.',
        key,
        '2026-06-07T17:00:00Z',
      ),
    ).toBe(true);

    expect(db.getIssue('SENTRY-COMMENT')?.last_release_skip_comment_key).toBe(key);
    expect(db.getPendingActions('SENTRY-COMMENT')).toEqual([
      {
        kind: 'sentry_comment',
        payload: { text: 'Autopilot skipped this issue.' },
        idempotency_key: key,
        attempts: 0,
        last_error: null,
        created_at: '2026-06-07T17:00:00Z',
      },
    ]);
  });

  it('does not enqueue again when the stored release-pair key already matches', () => {
    seedIssue(db);
    const key = 'sentry_comment:SENTRY-COMMENT:release-gate-skip:v0.4.46-vs-v0.3.99';

    expect(db.enqueueReleaseGateSkipComment({ sentryId: 'SENTRY-COMMENT' }, 'first', key)).toBe(true);
    db.replacePendingActions('SENTRY-COMMENT', []);

    expect(db.enqueueReleaseGateSkipComment({ sentryId: 'SENTRY-COMMENT' }, 'second', key)).toBe(false);
    expect(db.getPendingActions('SENTRY-COMMENT')).toHaveLength(0);
    expect(db.getIssue('SENTRY-COMMENT')?.last_release_skip_comment_key).toBe(key);
  });
});

describe('StateDB.enqueueLinearDedupSkipComment', () => {
  it('stores the matched-ticket key transactionally with the pending comment', () => {
    seedIssue(db, 'SENTRY-LINEAR-COMMENT');
    const key = 'sentry_comment:SENTRY-LINEAR-COMMENT:linear-dedup:REBEL-123';

    expect(
      db.enqueueLinearDedupSkipComment(
        { sentryId: 'SENTRY-LINEAR-COMMENT' },
        'Autopilot: skipped — matches Linear ticket REBEL-123 (status=Done).',
        key,
        '2026-06-07T17:30:00Z',
      ),
    ).toBe(true);

    expect(db.getIssue('SENTRY-LINEAR-COMMENT')?.last_linear_dedup_comment_key).toBe(key);
    expect(db.getPendingActions('SENTRY-LINEAR-COMMENT')).toEqual([
      {
        kind: 'sentry_comment',
        payload: { text: 'Autopilot: skipped — matches Linear ticket REBEL-123 (status=Done).' },
        idempotency_key: key,
        attempts: 0,
        last_error: null,
        created_at: '2026-06-07T17:30:00Z',
      },
    ]);
  });

  it('does not enqueue again after the stored matched-ticket key already matches', () => {
    seedIssue(db, 'SENTRY-LINEAR-COMMENT');
    const key = 'sentry_comment:SENTRY-LINEAR-COMMENT:linear-dedup:REBEL-123';

    expect(db.enqueueLinearDedupSkipComment({ sentryId: 'SENTRY-LINEAR-COMMENT' }, 'first', key)).toBe(true);
    db.replacePendingActions('SENTRY-LINEAR-COMMENT', []);

    expect(db.enqueueLinearDedupSkipComment({ sentryId: 'SENTRY-LINEAR-COMMENT' }, 'second', key)).toBe(false);
    expect(db.getPendingActions('SENTRY-LINEAR-COMMENT')).toHaveLength(0);
    expect(db.getIssue('SENTRY-LINEAR-COMMENT')?.last_linear_dedup_comment_key).toBe(key);
  });

  it('posts again when the matched Linear ticket changes', () => {
    seedIssue(db, 'SENTRY-LINEAR-COMMENT');
    const firstKey = 'sentry_comment:SENTRY-LINEAR-COMMENT:linear-dedup:REBEL-123';
    const secondKey = 'sentry_comment:SENTRY-LINEAR-COMMENT:linear-dedup:REBEL-456';

    expect(db.enqueueLinearDedupSkipComment({ sentryId: 'SENTRY-LINEAR-COMMENT' }, 'first', firstKey)).toBe(true);
    db.replacePendingActions('SENTRY-LINEAR-COMMENT', []);

    expect(db.enqueueLinearDedupSkipComment({ sentryId: 'SENTRY-LINEAR-COMMENT' }, 'second', secondKey)).toBe(true);
    expect(db.getIssue('SENTRY-LINEAR-COMMENT')?.last_linear_dedup_comment_key).toBe(secondKey);
    expect(db.getPendingActions('SENTRY-LINEAR-COMMENT')).toHaveLength(1);
  });
});
