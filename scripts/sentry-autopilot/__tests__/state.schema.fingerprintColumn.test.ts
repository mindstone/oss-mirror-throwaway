import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { StateDB } from '../state.ts';

type BetterSqliteDatabase = {
  exec(sql: string): void;
  close(): void;
};

const require = createRequire(import.meta.url);
const BetterSqlite3 = require('better-sqlite3') as new (dbPath: string) => BetterSqliteDatabase;

const dirs: string[] = [];

function tmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'state-schema-fingerprint-'));
  dirs.push(dir);
  return dir;
}

function issueColumns(db: StateDB): string[] {
  const rows = (db as unknown as { db: { prepare: (sql: string) => { all: () => unknown[] } } }).db
    .prepare('PRAGMA table_info(issues)')
    .all();
  return rows
    .map((row) => (row && typeof row === 'object' ? (row as Record<string, unknown>).name : undefined))
    .filter((name): name is string => typeof name === 'string');
}

function issueIndexes(db: StateDB): string[] {
  const rows = (db as unknown as { db: { prepare: (sql: string) => { all: () => unknown[] } } }).db
    .prepare('PRAGMA index_list(issues)')
    .all();
  return rows
    .map((row) => (row && typeof row === 'object' ? (row as Record<string, unknown>).name : undefined))
    .filter((name): name is string => typeof name === 'string');
}

function createLegacyDbWithoutFingerprint(dbPath: string): void {
  const sqlite = new BetterSqlite3(dbPath);
  sqlite.exec(`
    CREATE TABLE issues (
      sentry_id         TEXT PRIMARY KEY,
      sentry_url        TEXT NOT NULL,
      title             TEXT NOT NULL,
      error_type        TEXT,
      is_user_reported  BOOLEAN DEFAULT FALSE,
      occurrences       INTEGER DEFAULT 0,
      users             INTEGER DEFAULT 0,
      status            TEXT NOT NULL DEFAULT 'pending',
      dispatch_count    INTEGER DEFAULT 0,
      max_retries       INTEGER DEFAULT 2,
      confidence        REAL,
      outcome           TEXT,
      original_outcome  TEXT,
      root_cause        TEXT,
      plan_summary      TEXT,
      diagnosis         TEXT,
      is_bug            INTEGER,
      failure_kind      TEXT,
      last_error        TEXT,
      commit_hash       TEXT,
      plan_file         TEXT,
      linear_issue_id   TEXT,
      tmux_session      TEXT,
      worktree_slot     INTEGER,
      user_description  TEXT,
      user_email        TEXT,
      user_name         TEXT,
      pending_actions   TEXT,
      last_release_skip_comment_key TEXT,
      last_linear_dedup_comment_key TEXT,
      verification_status TEXT,
      verification_details TEXT,
      branch_name       TEXT,
      pr_url            TEXT,
      pushed_at         DATETIME,
      created_at        DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at        DATETIME DEFAULT CURRENT_TIMESTAMP,
      dispatched_at     DATETIME,
      completed_at      DATETIME
    );

    CREATE TABLE run_log (
      id                INTEGER PRIMARY KEY AUTOINCREMENT,
      run_type          TEXT NOT NULL,
      started_at        DATETIME DEFAULT CURRENT_TIMESTAMP,
      completed_at      DATETIME,
      status            TEXT NOT NULL DEFAULT 'completed',
      issues_found      INTEGER DEFAULT 0,
      issues_dispatched INTEGER DEFAULT 0,
      issues_skipped    INTEGER DEFAULT 0,
      error             TEXT
    );

    CREATE TABLE escalations (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id          INTEGER NOT NULL,
      kind            TEXT NOT NULL,
      context         TEXT NOT NULL,
      created_at      DATETIME DEFAULT CURRENT_TIMESTAMP,
      acknowledged_at DATETIME
    );
  `);
  sqlite.close();
}

afterEach(() => {
  while (dirs.length > 0) {
    const dir = dirs.pop();
    if (dir) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
});

describe('StateDB schema migration: fingerprint_hash + index', () => {
  it('creates fingerprint_hash column and active-fingerprint index in a fresh DB', () => {
    const dir = tmpDir();
    const db = new StateDB(path.join(dir, 'state.db'));
    try {
      expect(issueColumns(db)).toContain('fingerprint_hash');
      expect(issueIndexes(db)).toContain('idx_issues_fingerprint_active');
    } finally {
      db.close();
    }
  });

  it('migrates a legacy DB shape without fingerprint_hash and remains idempotent', () => {
    const dir = tmpDir();
    const dbPath = path.join(dir, 'state.db');
    createLegacyDbWithoutFingerprint(dbPath);

    const firstOpen = new StateDB(dbPath);
    try {
      expect(issueColumns(firstOpen)).toContain('fingerprint_hash');
      expect(issueIndexes(firstOpen)).toContain('idx_issues_fingerprint_active');
    } finally {
      firstOpen.close();
    }

    const secondOpen = new StateDB(dbPath);
    try {
      expect(issueColumns(secondOpen)).toContain('fingerprint_hash');
      expect(issueIndexes(secondOpen)).toContain('idx_issues_fingerprint_active');
    } finally {
      secondOpen.close();
    }
  });
});
