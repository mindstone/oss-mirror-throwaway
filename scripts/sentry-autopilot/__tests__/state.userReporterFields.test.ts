import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { StateDB } from '../state.ts';

const dirs: string[] = [];

function tmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'state-user-reporter-'));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  while (dirs.length > 0) {
    const dir = dirs.pop();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('StateDB persists user reporter fields', () => {
  let db: StateDB;

  beforeEach(() => {
    const dir = tmpDir();
    db = new StateDB(path.join(dir, 'state.db'));
  });

  it('round-trips user_email and user_name through an initial insert', () => {
    db.upsertIssue({
      sentry_id: 'SENTRY-REPORTER-1',
      sentry_url: 'https://sentry.io/issues/SENTRY-REPORTER-1',
      title: 'feedback issue',
      is_user_reported: true,
      user_description: 'thing broke when I clicked save',
      user_email: 'reporter@example.com',
      user_name: 'Ada Lovelace',
    });

    const stored = db.getIssue('SENTRY-REPORTER-1');
    expect(stored).not.toBeNull();
    expect(stored?.user_email).toBe('reporter@example.com');
    expect(stored?.user_name).toBe('Ada Lovelace');
    expect(stored?.user_description).toBe('thing broke when I clicked save');
    expect(stored?.is_user_reported).toBe(true);
  });

  it('defaults user_email and user_name to null when not provided', () => {
    db.upsertIssue({
      sentry_id: 'SENTRY-REPORTER-2',
      sentry_url: 'https://sentry.io/issues/SENTRY-REPORTER-2',
      title: 'no-reporter issue',
    });

    const stored = db.getIssue('SENTRY-REPORTER-2');
    expect(stored).not.toBeNull();
    expect(stored?.user_email).toBeNull();
    expect(stored?.user_name).toBeNull();
  });

  it('preserves user_email and user_name across a subsequent upsert that does not touch them', () => {
    db.upsertIssue({
      sentry_id: 'SENTRY-REPORTER-3',
      sentry_url: 'https://sentry.io/issues/SENTRY-REPORTER-3',
      title: 'feedback issue',
      is_user_reported: true,
      user_email: 'someone@example.com',
      user_name: 'Grace Hopper',
    });

    db.upsertIssue({
      sentry_id: 'SENTRY-REPORTER-3',
      sentry_url: 'https://sentry.io/issues/SENTRY-REPORTER-3',
      title: 'feedback issue (updated title)',
      occurrences: 5,
    });

    const stored = db.getIssue('SENTRY-REPORTER-3');
    expect(stored?.user_email).toBe('someone@example.com');
    expect(stored?.user_name).toBe('Grace Hopper');
    expect(stored?.occurrences).toBe(5);
    expect(stored?.title).toBe('feedback issue (updated title)');
  });

  it('overwrites user_email and user_name when explicitly updated', () => {
    db.upsertIssue({
      sentry_id: 'SENTRY-REPORTER-4',
      sentry_url: 'https://sentry.io/issues/SENTRY-REPORTER-4',
      title: 'feedback issue',
      user_email: 'old@example.com',
      user_name: 'Old Name',
    });

    db.upsertIssue({
      sentry_id: 'SENTRY-REPORTER-4',
      user_email: 'new@example.com',
      user_name: 'New Name',
    });

    const stored = db.getIssue('SENTRY-REPORTER-4');
    expect(stored?.user_email).toBe('new@example.com');
    expect(stored?.user_name).toBe('New Name');
  });

  it('surfaces user_email and user_name through listIssuesWithPendingActions normalization', () => {
    db.upsertIssue({
      sentry_id: 'SENTRY-REPORTER-5',
      sentry_url: 'https://sentry.io/issues/SENTRY-REPORTER-5',
      title: 'feedback issue',
      user_email: 'list@example.com',
      user_name: 'List User',
      pending_actions: JSON.stringify([
        {
          kind: 'slack_outcome',
          payload: { text: 'msg' },
          idempotency_key: 'a',
          attempts: 0,
          last_error: null,
          created_at: '2026-05-15T00:00:00.000Z',
        },
      ]),
    });

    const rows = db.listIssuesWithPendingActions();
    const match = rows.find((row) => row.sentry_id === 'SENTRY-REPORTER-5');
    expect(match).toBeDefined();
    expect(match?.user_email).toBe('list@example.com');
    expect(match?.user_name).toBe('List User');
  });
});
