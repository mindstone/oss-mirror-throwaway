import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { StateDB } from '../state.ts';

const dirs: string[] = [];

function tmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'state-inflight-race-'));
  dirs.push(dir);
  return dir;
}

function seedPendingIssue(db: StateDB, sentryId: string): void {
  db.upsertIssue({
    sentry_id: sentryId,
    sentry_url: `https://sentry.io/issues/${sentryId}`,
    title: `Issue ${sentryId}`,
    status: 'pending',
    max_retries: 2,
  });
}

afterEach(() => {
  while (dirs.length > 0) {
    const dir = dirs.pop();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('dispatch-time in-flight dedup race guard', () => {
  it('dispatches exactly one same-fingerprint row and defers the other', async () => {
    const db = new StateDB(path.join(tmpDir(), 'state.db'));
    try {
      seedPendingIssue(db, 'SENTRY-RACE-A');
      seedPendingIssue(db, 'SENTRY-RACE-B');
      const fingerprintHash = 'a11ce3f5b3df4a01';

      const [a, b] = await Promise.all([
        Promise.resolve().then(() =>
          db.markDispatched('SENTRY-RACE-A', 0, 'sentry-SENTRY-RACE-A', {
            fingerprintHash,
            inFlightWindowHours: 6,
          }),
        ),
        Promise.resolve().then(() =>
          db.markDispatched('SENTRY-RACE-B', 1, 'sentry-SENTRY-RACE-B', {
            fingerprintHash,
            inFlightWindowHours: 6,
          }),
        ),
      ]);

      expect([a, b].sort()).toEqual(['deferred', 'dispatched']);

      const rowA = db.getIssue('SENTRY-RACE-A');
      const rowB = db.getIssue('SENTRY-RACE-B');
      expect(rowA?.status === 'dispatched' || rowA?.status === 'deferred').toBe(true);
      expect(rowB?.status === 'dispatched' || rowB?.status === 'deferred').toBe(true);

      const dispatched = [rowA, rowB].find((row) => row?.status === 'dispatched');
      const deferred = [rowA, rowB].find((row) => row?.status === 'deferred');
      expect(dispatched).toBeDefined();
      expect(deferred).toBeDefined();

      expect(dispatched?.fingerprint_hash).toBe(fingerprintHash);
      expect(deferred?.fingerprint_hash).toBe(fingerprintHash);
      expect(deferred?.last_error).toBe(
        `inflight-dedup:fingerprint=${fingerprintHash}:active=${dispatched?.sentry_id}`,
      );
    } finally {
      db.close();
    }
  });
});
