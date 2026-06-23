import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { StateDB } from '../state.ts';

const dirs: string[] = [];

function tmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'state-busy-timeout-'));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  while (dirs.length > 0) {
    const dir = dirs.pop();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('StateDB pragmas', () => {
  it('sets busy_timeout >= 5000 to survive drainer + dispatcher overlap', () => {
    const dir = tmpDir();
    const db = new StateDB(path.join(dir, 'state.db'));
    try {
      const value = (db as unknown as { db: { pragma(query: string): unknown } }).db.pragma('busy_timeout');
      const rows = Array.isArray(value) ? value : [];
      const first = rows[0] as Record<string, unknown> | undefined;
      const timeout = first ? Number(first.timeout ?? first['busy_timeout'] ?? Object.values(first)[0]) : Number(value);
      expect(Number.isFinite(timeout)).toBe(true);
      expect(timeout).toBeGreaterThanOrEqual(5000);
    } finally {
      db.close();
    }
  });

  it('enables WAL journal mode', () => {
    const dir = tmpDir();
    const db = new StateDB(path.join(dir, 'state.db'));
    try {
      const value = (db as unknown as { db: { pragma(query: string): unknown } }).db.pragma('journal_mode');
      const rows = Array.isArray(value) ? value : [];
      const first = rows[0] as Record<string, unknown> | undefined;
      const mode = first ? String(first.journal_mode ?? Object.values(first)[0]) : String(value);
      expect(mode.toLowerCase()).toBe('wal');
    } finally {
      db.close();
    }
  });
});
