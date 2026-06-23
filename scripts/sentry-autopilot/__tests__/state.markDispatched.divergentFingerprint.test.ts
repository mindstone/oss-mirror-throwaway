import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { StateDB } from '../state.ts';

const dirs: string[] = [];

function tmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'state-mark-dispatched-divergent-fingerprint-'));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  while (dirs.length > 0) {
    const dir = dirs.pop();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('StateDB.markDispatched divergent fingerprint handling', () => {
  it('uses stored fingerprint for guard and write when supplied hash diverges', () => {
    const db = new StateDB(path.join(tmpDir(), 'state.db'));
    const oldHash = 'oldhash';
    const newHash = 'newhash';

    try {
      db.upsertIssue({
        sentry_id: 'SENTRY-ACTIVE-OLD',
        sentry_url: 'https://sentry.io/issues/SENTRY-ACTIVE-OLD',
        title: 'Active old hash blocker',
        status: 'dispatched',
        fingerprint_hash: oldHash,
        worktree_slot: 0,
        tmux_session: 'sentry-SENTRY-ACTIVE-OLD',
        max_retries: 2,
      });
      db.upsertIssue({
        sentry_id: 'SENTRY-DEFERRED-OLD',
        sentry_url: 'https://sentry.io/issues/SENTRY-DEFERRED-OLD',
        title: 'Deferred old hash candidate',
        status: 'deferred',
        fingerprint_hash: oldHash,
        max_retries: 2,
      });

      const result = db.markDispatched('SENTRY-DEFERRED-OLD', 1, 'sentry-SENTRY-DEFERRED-OLD', {
        fingerprintHash: newHash,
        inFlightWindowHours: 6,
      });

      expect(result).toBe('deferred');
      const row = db.getIssue('SENTRY-DEFERRED-OLD');
      expect(row?.status).toBe('deferred');
      expect(row?.fingerprint_hash).toBe(oldHash);
      expect(row?.last_error).toBe(`inflight-dedup:fingerprint=${oldHash}:active=SENTRY-ACTIVE-OLD`);
    } finally {
      db.close();
    }
  });
});
