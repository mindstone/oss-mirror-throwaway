/**
 * Stage C — escalations table tests (Appendix C).
 *
 * The escalations table is the operator's last-resort visibility channel
 * when Slack itself is failing. The dispatcher prints unacknowledged
 * escalations to stderr on startup; admin tooling acknowledges them once
 * handled.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { StateDB } from '../state.ts';

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
});

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sentry-autopilot-escalations-'));
  tempDirs.push(dir);
  return dir;
}

describe('StateDB escalations table', () => {
  let db: StateDB;

  beforeEach(() => {
    db = new StateDB(path.join(tempDir(), 'state.db'));
  });

  it('addEscalation inserts a row and returns its id', () => {
    const id = db.addEscalation(42, 'pending_drain_failed', { foo: 'bar' });
    expect(id).toBeGreaterThan(0);
  });

  it('listUnacknowledgedEscalations returns inserted rows in creation order', () => {
    db.addEscalation(1, 'a', { step: 1 });
    db.addEscalation(1, 'b', { step: 2 });
    const rows = db.listUnacknowledgedEscalations();
    expect(rows.map((r) => r.kind)).toEqual(['a', 'b']);
    expect(rows[0].context).toBe(JSON.stringify({ step: 1 }));
  });

  it('acknowledgeEscalation removes the row from the unacknowledged list', () => {
    const id = db.addEscalation(1, 'a', null);
    expect(db.listUnacknowledgedEscalations()).toHaveLength(1);
    db.acknowledgeEscalation(id);
    expect(db.listUnacknowledgedEscalations()).toHaveLength(0);
  });
});
