/**
 * Tests for the triage-skipped Sentry archive enqueue path.
 *
 * The autopilot poller skips:
 *   - low-impact issues (not fatal, ≤5 events/day, ≤1 user)
 *   - documented noise patterns (Chromium / macOS / errno / Squirrel)
 *
 * For everything except user bug reports, the dispatcher enqueues a
 * `sentry_status: archived_until_escalating` pending action so the issue
 * gets archived in Sentry on the next drain. User-reported issues are
 * exempt per docs/project/SENTRY_TRIAGE.md § User Bug Reports.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { AutopilotConfig } from '../config.ts';
import { enqueueArchivePendingAction } from '../dispatcher.ts';
import type { PolledIssue } from '../poller.ts';
import { StateDB } from '../state.ts';

const dirs: string[] = [];

function tmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dispatcher-archive-'));
  dirs.push(dir);
  return dir;
}

function makeConfig(stateDir: string): AutopilotConfig {
  return {
    sentryAuthToken: 'token',
    sentryOrg: 'mindstone',
    sentryProject: 'rebel',
    linearApiKey: undefined,
    slackWebhook: undefined,
    phase: 'shadow',
    verifyMode: 'disabled',
    pushMode: 'disabled',
    pendingMode: 'enforce',
    stateDir,
    maxConcurrent: 1,
    maxHourly: 1,
    maxDaily: 1,
    maxRetries: 2,
    sessionTimeoutSeconds: 60,
    bootstrapLookbackHours: 24,
    repoRoot: path.resolve(__dirname, '..', '..', '..'),
    cli: 'droid',
    cursorModel: 'composer-2.5',
  };
}

function makePolled(overrides: Partial<PolledIssue> = {}): PolledIssue {
  return {
    sentryId: 'SENTRY-NOISE',
    sentryUrl: 'https://sentry.io/issues/SENTRY-NOISE',
    title: 'partition_alloc::internal::OnNoMemoryInternal()',
    errorType: 'crash',
    isUserReported: false,
    occurrences: 3,
    users: 2,
    level: 'fatal',
    firstSeen: '2026-05-22T00:00:00Z',
    lastSeen: '2026-05-22T00:00:00Z',
    ...overrides,
  };
}

afterEach(() => {
  while (dirs.length > 0) {
    const dir = dirs.pop();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('enqueueArchivePendingAction', () => {
  let db: StateDB;
  let config: AutopilotConfig;

  beforeEach(() => {
    const dir = tmpDir();
    config = makeConfig(dir);
    db = new StateDB(path.join(dir, 'state.db'));
  });

  it('enqueues a sentry_status archive action for a non-user-reported skipped issue', () => {
    const issue = makePolled();
    db.upsertIssue({
      sentry_id: issue.sentryId,
      sentry_url: issue.sentryUrl,
      title: issue.title,
      error_type: issue.errorType,
      is_user_reported: issue.isUserReported,
      occurrences: issue.occurrences,
      users: issue.users,
      status: 'skipped',
      max_retries: config.maxRetries,
    });

    const result = enqueueArchivePendingAction(db, issue, 'triage_skipped');
    expect(result).toBe(true);

    const queue = db.getPendingActions(issue.sentryId);
    expect(queue).toHaveLength(1);
    const action = queue[0];
    expect(action.kind).toBe('sentry_status');
    if (action.kind !== 'sentry_status') return;
    expect(action.payload.status).toBe('ignored');
    expect(action.payload.substatus).toBe('archived_until_escalating');
    expect(action.idempotency_key).toBe(`sentry_status:${issue.sentryId}:ignored`);
  });

  it('does not enqueue when issue.isUserReported is true', () => {
    const issue = makePolled({ sentryId: 'SENTRY-USER', isUserReported: true });
    db.upsertIssue({
      sentry_id: issue.sentryId,
      sentry_url: issue.sentryUrl,
      title: issue.title,
      is_user_reported: true,
      status: 'skipped',
      max_retries: config.maxRetries,
    });
    expect(enqueueArchivePendingAction(db, issue, 'triage_skipped')).toBe(false);
    expect(db.getPendingActions(issue.sentryId)).toEqual([]);
  });

  it('does not enqueue when no row exists in state.db', () => {
    const issue = makePolled({ sentryId: 'SENTRY-NOROW' });
    expect(enqueueArchivePendingAction(db, issue, 'triage_skipped')).toBe(false);
  });

  it('does not enqueue when the row is in an active dispatched state', () => {
    const issue = makePolled({ sentryId: 'SENTRY-DISPATCHED' });
    db.upsertIssue({
      sentry_id: issue.sentryId,
      sentry_url: issue.sentryUrl,
      title: issue.title,
      status: 'dispatched',
      max_retries: config.maxRetries,
    });
    expect(enqueueArchivePendingAction(db, issue, 'triage_skipped')).toBe(false);
    expect(db.getPendingActions(issue.sentryId)).toEqual([]);
  });

  it('does not enqueue when the row is already completed', () => {
    const issue = makePolled({ sentryId: 'SENTRY-DONE' });
    db.upsertIssue({
      sentry_id: issue.sentryId,
      sentry_url: issue.sentryUrl,
      title: issue.title,
      status: 'completed',
      max_retries: config.maxRetries,
    });
    expect(enqueueArchivePendingAction(db, issue, 'triage_skipped')).toBe(false);
    expect(db.getPendingActions(issue.sentryId)).toEqual([]);
  });

  it('is idempotent — calling twice does not duplicate the action', () => {
    const issue = makePolled({ sentryId: 'SENTRY-IDEMPOTENT' });
    db.upsertIssue({
      sentry_id: issue.sentryId,
      sentry_url: issue.sentryUrl,
      title: issue.title,
      status: 'skipped',
      max_retries: config.maxRetries,
    });
    expect(enqueueArchivePendingAction(db, issue, 'triage_skipped')).toBe(true);
    expect(enqueueArchivePendingAction(db, issue, 'triage_skipped')).toBe(false);
    expect(db.getPendingActions(issue.sentryId)).toHaveLength(1);
  });

  it('preserves existing pending actions when enqueueing the archive action', () => {
    const issue = makePolled({ sentryId: 'SENTRY-COEXIST' });
    db.upsertIssue({
      sentry_id: issue.sentryId,
      sentry_url: issue.sentryUrl,
      title: issue.title,
      status: 'skipped',
      max_retries: config.maxRetries,
    });
    db.replacePendingActions(issue.sentryId, [
      {
        kind: 'sentry_comment',
        payload: { text: 'pre-existing comment' },
        idempotency_key: 'sentry_comment:abc',
        attempts: 0,
        last_error: null,
        created_at: '2026-05-22T00:00:00Z',
      },
    ]);

    expect(enqueueArchivePendingAction(db, issue, 'triage_skipped')).toBe(true);
    const queue = db.getPendingActions(issue.sentryId);
    expect(queue).toHaveLength(2);
    expect(queue.map((a) => a.kind).sort()).toEqual(['sentry_comment', 'sentry_status']);
  });
});
