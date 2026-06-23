import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { StateDB } from '../state.ts';

const dirs: string[] = [];

function tmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'state-mark-dispatched-deferred-'));
  dirs.push(dir);
  return dir;
}

function seedIssue(db: StateDB, sentryId: string, status: 'pending' | 'deferred' | 'skipped'): void {
  db.upsertIssue({
    sentry_id: sentryId,
    sentry_url: `https://sentry.io/issues/${sentryId}`,
    title: `Issue ${sentryId}`,
    status,
    max_retries: 2,
  });
}

afterEach(() => {
  while (dirs.length > 0) {
    const dir = dirs.pop();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('StateDB.markDispatched status predicate', () => {
  it('dispatches a deferred row', () => {
    const db = new StateDB(path.join(tmpDir(), 'state.db'));
    try {
      seedIssue(db, 'SENTRY-DEFERRED', 'deferred');

      const result = db.markDispatched('SENTRY-DEFERRED', 0, 'sentry-SENTRY-DEFERRED');
      expect(result).toBe('dispatched');

      const row = db.getIssue('SENTRY-DEFERRED');
      expect(row?.status).toBe('dispatched');
      expect(row?.worktree_slot).toBe(0);
      expect(row?.tmux_session).toBe('sentry-SENTRY-DEFERRED');
    } finally {
      db.close();
    }
  });

  it('does not dispatch a skipped row', () => {
    const db = new StateDB(path.join(tmpDir(), 'state.db'));
    try {
      seedIssue(db, 'SENTRY-SKIPPED', 'skipped');

      expect(() => db.markDispatched('SENTRY-SKIPPED', 0, 'sentry-SENTRY-SKIPPED')).toThrow(
        /Failed to mark dispatched issue SENTRY-SKIPPED/,
      );
      expect(db.getIssue('SENTRY-SKIPPED')?.status).toBe('skipped');
    } finally {
      db.close();
    }
  });

  it('keeps pending-row dispatch behavior unchanged', () => {
    const db = new StateDB(path.join(tmpDir(), 'state.db'));
    try {
      seedIssue(db, 'SENTRY-PENDING', 'pending');

      const result = db.markDispatched('SENTRY-PENDING', 1, 'sentry-SENTRY-PENDING');
      expect(result).toBe('dispatched');
      expect(db.getIssue('SENTRY-PENDING')?.status).toBe('dispatched');
    } finally {
      db.close();
    }
  });
});
