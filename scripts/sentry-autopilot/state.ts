import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

import type { FailureKind } from './outcome-schema.ts';
import {
  deserializePendingActions,
  serializePendingActions,
  type PendingAction,
} from './pending-actions.ts';

export type IssueStatus =
  | 'pending'
  | 'deferred'
  | 'dispatched'
  | 'in_progress'
  | 'completed'
  | 'failed'
  | 'escalated'
  | 'skipped';

export type IssueErrorType = 'exception' | 'feedback' | 'crash';

export interface IssueRow {
  sentry_id: string;
  sentry_url: string;
  title: string;
  error_type: IssueErrorType | null;
  is_user_reported: boolean;
  occurrences: number;
  users: number;
  status: IssueStatus;
  dispatch_count: number;
  max_retries: number;
  confidence: number | null;
  outcome: string | null;
  original_outcome?: string;
  root_cause?: string;
  plan_summary?: string;
  diagnosis?: string;
  is_bug?: boolean;
  failure_kind?: FailureKind;
  last_error: string | null;
  commit_hash: string | null;
  plan_file: string | null;
  linear_issue_id: string | null;
  tmux_session: string | null;
  worktree_slot: number | null;
  user_description: string | null;
  user_email: string | null;
  user_name: string | null;
  pending_actions: string | null;
  fingerprint_hash?: string | null;
  last_release_skip_comment_key?: string | null;
  last_linear_dedup_comment_key?: string | null;
  verification_status: string | null;
  verification_details: string | null;
  branch_name: string | null;
  pr_url: string | null;
  pushed_at: string | null;
  created_at: string;
  updated_at: string;
  dispatched_at: string | null;
  completed_at: string | null;
}

export interface RunLogRow {
  id: number;
  run_type: string;
  started_at: string;
  completed_at: string | null;
  status: string;
  issues_found: number;
  issues_dispatched: number;
  issues_skipped: number;
  error: string | null;
}

export interface HeartbeatStats {
  processed: number;
  committed: number;
  plans: number;
  escalated: number;
  failed: number;
}

/**
 * Operator-visible escalation row recorded when the pending-action drainer
 * (Stage C) exhausts retries on one or more actions, or when other
 * last-resort visibility channels need to surface a problem. The dispatcher
 * prints all unacknowledged escalations to stderr on startup; operators
 * acknowledge via admin tooling once handled.
 */
export interface EscalationRow {
  id: number;
  run_id: number;
  kind: string;
  context: string;
  created_at: string;
  acknowledged_at: string | null;
}

export interface CompletionMetadata {
  original_outcome?: string;
  root_cause?: string;
  plan_summary?: string;
  diagnosis?: string;
  is_bug?: boolean;
  failure_kind?: FailureKind;
}

export interface VerificationFailureRecord {
  /** Serializable JSON describing why verification failed. */
  details: unknown;
  /** Human-readable summary surfaced in `last_error`. */
  summary: string;
}

export interface MarkDispatchedOptions {
  fingerprintHash?: string | null;
  inFlightWindowHours?: number;
}

export type MarkDispatchedResult = 'dispatched' | 'deferred';

export interface QuietSentryCommentIssue {
  sentryId?: string;
  sentry_id?: string;
}

type SqlValue = string | number | null;
type SqlParams = Record<string, SqlValue>;

interface StatementRunResult {
  changes: number;
  lastInsertRowid: number | bigint;
}

interface PreparedStatement {
  get(params?: SqlParams | readonly SqlValue[] | SqlValue): unknown;
  all(params?: SqlParams | readonly SqlValue[] | SqlValue): unknown[];
  run(params?: SqlParams | readonly SqlValue[] | SqlValue): StatementRunResult;
}

interface DatabaseConnection {
  close(): void;
  exec(sql: string): void;
  pragma(source: string): unknown;
  prepare(sql: string): PreparedStatement;
  transaction<TArgs extends unknown[], TResult>(
    fn: (...args: TArgs) => TResult,
  ): (...args: TArgs) => TResult;
}

interface DatabaseConstructor {
  new (dbPath: string): DatabaseConnection;
}

const require = createRequire(import.meta.url);
const Database = require('better-sqlite3') as DatabaseConstructor;

const DEFAULT_MAX_CONCURRENT = 3;
const HOUSEKEEPING_INTERVALS_MS: Record<'stale_cleanup' | 'cross_day_patterns' | 'heartbeat', number> = {
  stale_cleanup: 6 * 60 * 60 * 1000,
  cross_day_patterns: 24 * 60 * 60 * 1000,
  heartbeat: 24 * 60 * 60 * 1000,
};

const ISSUE_COLUMNS = [
  'sentry_id',
  'sentry_url',
  'title',
  'error_type',
  'is_user_reported',
  'occurrences',
  'users',
  'status',
  'dispatch_count',
  'max_retries',
  'confidence',
  'outcome',
  'original_outcome',
  'root_cause',
  'plan_summary',
  'diagnosis',
  'is_bug',
  'failure_kind',
  'last_error',
  'commit_hash',
  'plan_file',
  'linear_issue_id',
  'tmux_session',
  'worktree_slot',
  'user_description',
  'user_email',
  'user_name',
  'pending_actions',
  'fingerprint_hash',
  'last_release_skip_comment_key',
  'last_linear_dedup_comment_key',
  'verification_status',
  'verification_details',
  'branch_name',
  'pr_url',
  'pushed_at',
  'created_at',
  'updated_at',
  'dispatched_at',
  'completed_at',
] as const satisfies readonly (keyof IssueRow)[];
const FAILURE_KINDS: ReadonlySet<FailureKind> = new Set([
  'parse_failure',
  'supervisor_failure',
  'bugfixer_failure',
  'reporter_failure',
  'verification_failure',
]);

type IssueColumn = (typeof ISSUE_COLUMNS)[number];

function assertKnownIssueColumn(column: string): asserts column is IssueColumn {
  if (!ISSUE_COLUMNS.includes(column as IssueColumn)) {
    throw new Error(`Unknown issue column: ${column}`);
  }
}

function toSqlValue(column: IssueColumn, value: IssueRow[IssueColumn] | undefined): SqlValue | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (column === 'is_user_reported' || typeof value === 'boolean') {
    return value ? 1 : 0;
  }

  return value;
}

function stringField(row: Record<string, unknown>, field: IssueColumn): string {
  const value = row[field];
  if (typeof value !== 'string') {
    throw new Error(`Invalid issue row: expected ${field} to be a string`);
  }
  return value;
}

function nullableStringField(row: Record<string, unknown>, field: IssueColumn): string | null {
  const value = row[field];
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value !== 'string') {
    throw new Error(`Invalid issue row: expected ${field} to be a string or null`);
  }
  return value;
}

function optionalStringField(row: Record<string, unknown>, field: IssueColumn): string | undefined {
  const value = row[field];
  if (value === null || value === undefined) {
    return undefined;
  }
  if (typeof value !== 'string') {
    throw new Error(`Invalid issue row: expected ${field} to be a string or null`);
  }
  return value;
}

function numberField(row: Record<string, unknown>, field: IssueColumn): number {
  const value = row[field];
  if (typeof value !== 'number') {
    throw new Error(`Invalid issue row: expected ${field} to be a number`);
  }
  return value;
}

function nullableNumberField(row: Record<string, unknown>, field: IssueColumn): number | null {
  const value = row[field];
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value !== 'number') {
    throw new Error(`Invalid issue row: expected ${field} to be a number or null`);
  }
  return value;
}

function optionalBooleanField(row: Record<string, unknown>, field: IssueColumn): boolean | undefined {
  const value = row[field];
  if (value === null || value === undefined) {
    return undefined;
  }
  if (typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'number') {
    if (value === 1) return true;
    if (value === 0) return false;
  }
  throw new Error(`Invalid issue row: expected ${field} to be a boolean-ish value`);
}

function normalizeIssueRow(row: unknown): IssueRow {
  if (!row || typeof row !== 'object') {
    throw new Error('Invalid issue row: expected an object');
  }

  const record = row as Record<string, unknown>;
  const errorType = nullableStringField(record, 'error_type');
  if (errorType !== null && errorType !== 'exception' && errorType !== 'feedback' && errorType !== 'crash') {
    throw new Error(`Invalid issue row: unexpected error_type "${errorType}"`);
  }

  const status = stringField(record, 'status');
  if (
    status !== 'pending' &&
    status !== 'deferred' &&
    status !== 'dispatched' &&
    status !== 'in_progress' &&
    status !== 'completed' &&
    status !== 'failed' &&
    status !== 'escalated' &&
    status !== 'skipped'
  ) {
    throw new Error(`Invalid issue row: unexpected status "${status}"`);
  }

  const failureKind = optionalStringField(record, 'failure_kind');
  if (failureKind && !FAILURE_KINDS.has(failureKind as FailureKind)) {
    throw new Error(`Invalid issue row: unexpected failure_kind "${failureKind}"`);
  }

  return {
    sentry_id: stringField(record, 'sentry_id'),
    sentry_url: stringField(record, 'sentry_url'),
    title: stringField(record, 'title'),
    error_type: errorType,
    is_user_reported: Boolean(record.is_user_reported),
    occurrences: numberField(record, 'occurrences'),
    users: numberField(record, 'users'),
    status,
    dispatch_count: numberField(record, 'dispatch_count'),
    max_retries: numberField(record, 'max_retries'),
    confidence: nullableNumberField(record, 'confidence'),
    outcome: nullableStringField(record, 'outcome'),
    original_outcome: optionalStringField(record, 'original_outcome'),
    root_cause: optionalStringField(record, 'root_cause'),
    plan_summary: optionalStringField(record, 'plan_summary'),
    diagnosis: optionalStringField(record, 'diagnosis'),
    is_bug: optionalBooleanField(record, 'is_bug'),
    failure_kind: failureKind as FailureKind | undefined,
    last_error: nullableStringField(record, 'last_error'),
    commit_hash: nullableStringField(record, 'commit_hash'),
    plan_file: nullableStringField(record, 'plan_file'),
    linear_issue_id: nullableStringField(record, 'linear_issue_id'),
    tmux_session: nullableStringField(record, 'tmux_session'),
    worktree_slot: nullableNumberField(record, 'worktree_slot'),
    user_description: nullableStringField(record, 'user_description'),
    user_email: nullableStringField(record, 'user_email'),
    user_name: nullableStringField(record, 'user_name'),
    pending_actions: nullableStringField(record, 'pending_actions'),
    fingerprint_hash: nullableStringField(record, 'fingerprint_hash'),
    last_release_skip_comment_key: nullableStringField(record, 'last_release_skip_comment_key'),
    last_linear_dedup_comment_key: nullableStringField(record, 'last_linear_dedup_comment_key'),
    verification_status: nullableStringField(record, 'verification_status'),
    verification_details: nullableStringField(record, 'verification_details'),
    branch_name: nullableStringField(record, 'branch_name'),
    pr_url: nullableStringField(record, 'pr_url'),
    pushed_at: nullableStringField(record, 'pushed_at'),
    created_at: stringField(record, 'created_at'),
    updated_at: stringField(record, 'updated_at'),
    dispatched_at: nullableStringField(record, 'dispatched_at'),
    completed_at: nullableStringField(record, 'completed_at'),
  };
}

function normalizeIssueRows(rows: unknown[]): IssueRow[] {
  return rows.map((row) => normalizeIssueRow(row));
}

function normalizeRunLogRow(row: unknown): RunLogRow {
  if (!row || typeof row !== 'object') {
    throw new Error('Invalid run_log row: expected an object');
  }

  const record = row as Record<string, unknown>;
  return {
    id: numberField(record, 'id' as IssueColumn),
    run_type: String(record.run_type),
    started_at: String(record.started_at),
    completed_at: typeof record.completed_at === 'string' ? record.completed_at : null,
    status: typeof record.status === 'string' ? record.status : 'completed',
    issues_found: Number(record.issues_found),
    issues_dispatched: Number(record.issues_dispatched),
    issues_skipped: Number(record.issues_skipped),
    error: typeof record.error === 'string' ? record.error : null,
  };
}

function parseSqliteTimestamp(timestamp: string): number {
  const normalized = timestamp.includes('T') ? timestamp : `${timestamp.replace(' ', 'T')}Z`;
  return Date.parse(normalized);
}

function assertSingleChange(result: StatementRunResult, action: string, sentryId: string): void {
  if (result.changes !== 1) {
    throw new Error(`Failed to ${action} issue ${sentryId}: expected one row to change, changed ${result.changes}`);
  }
}

function getExistingColumns(db: DatabaseConnection, tableName: string): Set<string> {
  const rows = db.prepare(`PRAGMA table_info(${tableName})`).all();
  const columns = new Set<string>();

  for (const row of rows) {
    if (row && typeof row === 'object' && typeof (row as Record<string, unknown>).name === 'string') {
      columns.add((row as Record<string, unknown>).name as string);
    }
  }

  return columns;
}

/**
 * Manages the Sentry Autopilot SQLite state database.
 */
export class StateDB {
  private readonly db: DatabaseConnection;
  private readonly maxConcurrent: number;

  /**
   * Opens the SQLite database, enables WAL mode, and creates schema if needed.
   */
  constructor(dbPath: string, options: { maxConcurrent?: number } = {}) {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    this.maxConcurrent = options.maxConcurrent ?? DEFAULT_MAX_CONCURRENT;
    this.db.pragma('journal_mode = WAL');
    // Wait up to 5s when another connection holds the write lock instead of
    // throwing SQLITE_BUSY. The drainer (Stage C) and dispatcher both touch
    // `issues` rows during a tick; WAL + busy_timeout is the standard SQLite
    // pattern for those overlaps. Asserted ≥5000 in
    // `__tests__/state.busyTimeout.test.ts`.
    this.db.pragma('busy_timeout = 5000');
    this.initializeSchema();
  }

  private initializeSchema(): void {
    const createSchema = this.db.transaction(() => {
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS issues (
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
          fingerprint_hash  TEXT,
          last_release_skip_comment_key TEXT,
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

        CREATE TABLE IF NOT EXISTS run_log (
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

        CREATE TABLE IF NOT EXISTS escalations (
          id              INTEGER PRIMARY KEY AUTOINCREMENT,
          run_id          INTEGER NOT NULL,
          kind            TEXT NOT NULL,
          context         TEXT NOT NULL,
          created_at      DATETIME DEFAULT CURRENT_TIMESTAMP,
          acknowledged_at DATETIME
        );

        CREATE INDEX IF NOT EXISTS idx_issues_status_created
          ON issues(status, is_user_reported, created_at);
        CREATE INDEX IF NOT EXISTS idx_issues_active_slot
          ON issues(status, worktree_slot);
        CREATE INDEX IF NOT EXISTS idx_run_log_type_started
          ON run_log(run_type, started_at);
        CREATE INDEX IF NOT EXISTS idx_escalations_unacknowledged
          ON escalations(acknowledged_at, created_at);
      `);

      const issueColumns = getExistingColumns(this.db, 'issues');
      const issueMigrations: Array<[string, string]> = [
        ['occurrences', 'ALTER TABLE issues ADD COLUMN occurrences INTEGER DEFAULT 0'],
        ['users', 'ALTER TABLE issues ADD COLUMN users INTEGER DEFAULT 0'],
        ['last_error', 'ALTER TABLE issues ADD COLUMN last_error TEXT'],
        ['original_outcome', 'ALTER TABLE issues ADD COLUMN original_outcome TEXT'],
        ['root_cause', 'ALTER TABLE issues ADD COLUMN root_cause TEXT'],
        ['plan_summary', 'ALTER TABLE issues ADD COLUMN plan_summary TEXT'],
        ['diagnosis', 'ALTER TABLE issues ADD COLUMN diagnosis TEXT'],
        ['is_bug', 'ALTER TABLE issues ADD COLUMN is_bug INTEGER'],
        ['failure_kind', 'ALTER TABLE issues ADD COLUMN failure_kind TEXT'],
        ['pending_actions', 'ALTER TABLE issues ADD COLUMN pending_actions TEXT'],
        ['fingerprint_hash', 'ALTER TABLE issues ADD COLUMN fingerprint_hash TEXT'],
        ['last_release_skip_comment_key', 'ALTER TABLE issues ADD COLUMN last_release_skip_comment_key TEXT'],
        ['last_linear_dedup_comment_key', 'ALTER TABLE issues ADD COLUMN last_linear_dedup_comment_key TEXT'],
        ['verification_status', 'ALTER TABLE issues ADD COLUMN verification_status TEXT'],
        ['verification_details', 'ALTER TABLE issues ADD COLUMN verification_details TEXT'],
        ['branch_name', 'ALTER TABLE issues ADD COLUMN branch_name TEXT'],
        ['pr_url', 'ALTER TABLE issues ADD COLUMN pr_url TEXT'],
        ['pushed_at', 'ALTER TABLE issues ADD COLUMN pushed_at DATETIME'],
        ['user_description', 'ALTER TABLE issues ADD COLUMN user_description TEXT'],
        ['user_email', 'ALTER TABLE issues ADD COLUMN user_email TEXT'],
        ['user_name', 'ALTER TABLE issues ADD COLUMN user_name TEXT'],
      ];
      for (const [column, sql] of issueMigrations) {
        if (!issueColumns.has(column)) {
          this.db.exec(sql);
        }
      }

      this.db.exec(`
        CREATE INDEX IF NOT EXISTS idx_issues_fingerprint_active
          ON issues(fingerprint_hash, status, updated_at)
          WHERE fingerprint_hash IS NOT NULL
      `);

      const runLogColumns = getExistingColumns(this.db, 'run_log');
      if (!runLogColumns.has('status')) {
        this.db.exec("ALTER TABLE run_log ADD COLUMN status TEXT NOT NULL DEFAULT 'completed'");
      }
    });

    createSchema();
  }

  /**
   * Returns a single issue by Sentry ID, or undefined when it is not tracked.
   */
  getIssue(sentryId: string): IssueRow | undefined {
    const row = this.db.prepare('SELECT * FROM issues WHERE sentry_id = ?').get(sentryId);
    return row ? normalizeIssueRow(row) : undefined;
  }

  /**
   * Inserts a new issue or updates the provided fields on an existing issue.
   */
  upsertIssue(issue: Partial<IssueRow> & { sentry_id: string }): IssueRow {
    const upsert = this.db.transaction((input: Partial<IssueRow> & { sentry_id: string }) => {
      const existing = this.getIssue(input.sentry_id);
      if (existing) {
        const params: SqlParams = { sentry_id: input.sentry_id };
        const assignments: string[] = [];

        for (const [column, value] of Object.entries(input)) {
          assertKnownIssueColumn(column);
          if (column === 'sentry_id') {
            continue;
          }

          const sqlValue = toSqlValue(column, value as IssueRow[IssueColumn] | undefined);
          if (sqlValue !== undefined) {
            params[column] = sqlValue;
            assignments.push(`${column} = @${column}`);
          }
        }

        if (assignments.length > 0) {
          this.db
            .prepare(
              `UPDATE issues
               SET ${assignments.join(', ')}, updated_at = CURRENT_TIMESTAMP
               WHERE sentry_id = @sentry_id`,
            )
            .run(params);
        }

        return this.getIssue(input.sentry_id);
      }

      if (!input.sentry_url || !input.title) {
        throw new Error(
          `Cannot insert issue ${input.sentry_id}: sentry_url and title are required for new rows`,
        );
      }

      const row: Partial<IssueRow> & { sentry_id: string; sentry_url: string; title: string } = {
        sentry_id: input.sentry_id,
        sentry_url: input.sentry_url,
        title: input.title,
        error_type: input.error_type ?? null,
        is_user_reported: input.is_user_reported ?? false,
        occurrences: input.occurrences ?? 0,
        users: input.users ?? 0,
        status: input.status ?? 'pending',
        dispatch_count: input.dispatch_count ?? 0,
        max_retries: input.max_retries ?? 2,
        confidence: input.confidence ?? null,
        outcome: input.outcome ?? null,
        original_outcome: input.original_outcome,
        root_cause: input.root_cause,
        plan_summary: input.plan_summary,
        diagnosis: input.diagnosis,
        is_bug: input.is_bug,
        failure_kind: input.failure_kind,
        last_error: input.last_error ?? null,
        commit_hash: input.commit_hash ?? null,
        plan_file: input.plan_file ?? null,
        linear_issue_id: input.linear_issue_id ?? null,
        tmux_session: input.tmux_session ?? null,
        worktree_slot: input.worktree_slot ?? null,
        user_description: input.user_description ?? null,
        user_email: input.user_email ?? null,
        user_name: input.user_name ?? null,
        pending_actions: input.pending_actions ?? null,
        fingerprint_hash: input.fingerprint_hash ?? null,
        verification_status: input.verification_status ?? null,
        verification_details: input.verification_details ?? null,
        branch_name: input.branch_name ?? null,
        pr_url: input.pr_url ?? null,
        pushed_at: input.pushed_at ?? null,
        dispatched_at: input.dispatched_at ?? null,
        completed_at: input.completed_at ?? null,
      };

      const columns: string[] = [];
      const params: SqlParams = {};
      for (const [column, value] of Object.entries(row)) {
        assertKnownIssueColumn(column);
        const sqlValue = toSqlValue(column, value as IssueRow[IssueColumn] | undefined);
        if (sqlValue !== undefined) {
          columns.push(column);
          params[column] = sqlValue;
        }
      }

      this.db
        .prepare(
          `INSERT INTO issues (${columns.join(', ')})
           VALUES (${columns.map((column) => `@${column}`).join(', ')})`,
        )
        .run(params);

      return this.getIssue(input.sentry_id);
    });

    const row = upsert(issue);
    if (!row) {
      throw new Error(`Failed to upsert issue ${issue.sentry_id}`);
    }
    return row;
  }

  /**
   * Returns pending issues in dispatch priority order.
   */
  getPendingIssues(): IssueRow[] {
    return normalizeIssueRows(
      this.db
        .prepare(
          `SELECT * FROM issues
           WHERE status IN ('pending', 'deferred')
           ORDER BY is_user_reported DESC,
                    CASE status WHEN 'pending' THEN 0 ELSE 1 END,
                    created_at ASC`,
        )
        .all(),
    );
  }

  /**
   * Returns issues currently occupying an active worktree/session slot.
   */
  getActiveIssues(): IssueRow[] {
    return normalizeIssueRows(
      this.db
        .prepare(
          `SELECT * FROM issues
           WHERE status IN ('dispatched', 'in_progress')
           ORDER BY dispatched_at ASC`,
        )
        .all(),
    );
  }

  /**
   * Returns the active (dispatched/in_progress) issue id for the same
   * fingerprint within the provided lookback window, excluding `sentryId`.
   */
  findActiveIssueByFingerprint(
    fingerprintHash: string,
    sentryId: string,
    windowHours: number,
  ): string | null {
    const row = this.db
      .prepare(
        `SELECT sentry_id FROM issues
         WHERE fingerprint_hash = @fingerprint_hash
           AND status IN ('dispatched', 'in_progress')
           AND updated_at > datetime('now', '-' || @window_hours || ' hours')
           AND sentry_id != @sentry_id
         ORDER BY updated_at DESC
         LIMIT 1`,
      )
      .get({
        fingerprint_hash: fingerprintHash,
        sentry_id: sentryId,
        window_hours: windowHours,
      });

    if (!row || typeof row !== 'object') {
      return null;
    }
    const match = (row as Record<string, unknown>).sentry_id;
    return typeof match === 'string' ? match : null;
  }

  /**
   * Returns the first free worktree slot, or null when all slots are active.
   */
  getAvailableSlot(): number | null {
    const activeSlots = new Set(
      this.getActiveIssues()
        .map((issue) => issue.worktree_slot)
        .filter((slot): slot is number => slot !== null),
    );

    for (let slot = 0; slot < this.maxConcurrent; slot += 1) {
      if (!activeSlots.has(slot)) {
        return slot;
      }
    }

    return null;
  }

  /**
   * Marks an issue as dispatched and reserves its worktree slot/session metadata.
   */
  markDispatched(
    sentryId: string,
    slot: number,
    tmuxSession: string,
    options: MarkDispatchedOptions = {},
  ): MarkDispatchedResult {
    const fingerprintHash = options.fingerprintHash?.trim() || null;
    const inFlightWindowHours = Math.max(1, options.inFlightWindowHours ?? 6);

    const mark = this.db.transaction(() => {
      const existingFingerprintRow = this.db
        .prepare(
          `SELECT fingerprint_hash
           FROM issues
           WHERE sentry_id = @sentry_id`,
        )
        .get({ sentry_id: sentryId }) as { fingerprint_hash: string | null } | undefined;
      const existingFingerprintHash =
        typeof existingFingerprintRow?.fingerprint_hash === 'string' &&
        existingFingerprintRow.fingerprint_hash.trim().length > 0
          ? existingFingerprintRow.fingerprint_hash
          : null;
      const effectiveFingerprintHash = existingFingerprintHash ?? fingerprintHash;

      const result = this.db
        .prepare(
          `UPDATE issues
           SET status = 'dispatched',
               worktree_slot = @slot,
               tmux_session = @tmux_session,
               dispatched_at = CURRENT_TIMESTAMP,
               completed_at = NULL,
               last_error = NULL,
               fingerprint_hash = COALESCE(fingerprint_hash, @effective_fingerprint_hash),
               updated_at = CURRENT_TIMESTAMP
           WHERE sentry_id = @sentry_id
             AND status IN ('pending', 'deferred')
             AND NOT EXISTS (
               SELECT 1 FROM issues
               WHERE worktree_slot = @slot
                 AND status IN ('dispatched', 'in_progress')
                 AND sentry_id != @sentry_id
             )
             AND (
               @effective_fingerprint_hash IS NULL OR NOT EXISTS (
                 SELECT 1 FROM issues active
                 WHERE active.fingerprint_hash = @effective_fingerprint_hash
                   AND active.status IN ('dispatched', 'in_progress')
                   AND active.updated_at > datetime('now', '-' || @inflight_window_hours || ' hours')
                   AND active.sentry_id != @sentry_id
               )
             )`,
        )
        .run({
          sentry_id: sentryId,
          slot,
          tmux_session: tmuxSession,
          effective_fingerprint_hash: effectiveFingerprintHash,
          inflight_window_hours: inFlightWindowHours,
        });

      if (result.changes === 1) {
        return 'dispatched' as const;
      }

      if (!effectiveFingerprintHash) {
        assertSingleChange(result, 'mark dispatched', sentryId);
      }

      const matchedSentryId = this.findActiveIssueByFingerprint(
        effectiveFingerprintHash as string,
        sentryId,
        inFlightWindowHours,
      );
      if (!matchedSentryId) {
        assertSingleChange(result, 'mark dispatched', sentryId);
      }

      const deferReason = `inflight-dedup:fingerprint=${effectiveFingerprintHash}:active=${matchedSentryId}`;
      const deferResult = this.db
        .prepare(
          `UPDATE issues
           SET status = 'deferred',
               last_error = @last_error,
               fingerprint_hash = COALESCE(fingerprint_hash, @effective_fingerprint_hash),
               worktree_slot = NULL,
               tmux_session = NULL,
               dispatched_at = NULL,
               updated_at = CURRENT_TIMESTAMP
           WHERE sentry_id = @sentry_id
             AND status IN ('pending', 'deferred')`,
        )
        .run({
          sentry_id: sentryId,
          last_error: deferReason,
          effective_fingerprint_hash: effectiveFingerprintHash,
        });
      assertSingleChange(deferResult, 'mark deferred', sentryId);
      return 'deferred' as const;
    });

    return mark();
  }

  /**
   * Marks an issue as completed and records the final outcome metadata.
   *
   * `pendingActions` (default empty) is serialized to the `pending_actions`
   * JSON column atomically with the terminal state change so a crash between
   * "row updated" and "actions executed" leaves a recoverable queue for the
   * next tick. The Stage C drainer consumes those actions.
   */
  markCompleted(
    sentryId: string,
    outcome: string,
    confidence?: number,
    commitHash?: string,
    planFile?: string,
    metadata: CompletionMetadata = {},
    pendingActions: readonly PendingAction[] = [],
  ): void {
    const pendingJson = serializePendingActions(pendingActions);
    const mark = this.db.transaction(() => {
      const result = this.db
        .prepare(
          `UPDATE issues
           SET status = 'completed',
               outcome = @outcome,
               original_outcome = COALESCE(original_outcome, @original_outcome),
               root_cause = @root_cause,
               plan_summary = @plan_summary,
               diagnosis = @diagnosis,
               is_bug = @is_bug,
               failure_kind = @failure_kind,
               confidence = @confidence,
               commit_hash = @commit_hash,
               plan_file = @plan_file,
               pending_actions = @pending_actions,
               tmux_session = NULL,
               worktree_slot = NULL,
               completed_at = CURRENT_TIMESTAMP,
               updated_at = CURRENT_TIMESTAMP
           WHERE sentry_id = @sentry_id`,
        )
        .run({
          sentry_id: sentryId,
          outcome,
          original_outcome: metadata.original_outcome ?? null,
          root_cause: metadata.root_cause ?? null,
          plan_summary: metadata.plan_summary ?? null,
          diagnosis: metadata.diagnosis ?? null,
          is_bug: metadata.is_bug === undefined ? null : metadata.is_bug ? 1 : 0,
          failure_kind: metadata.failure_kind ?? null,
          confidence: confidence ?? null,
          commit_hash: commitHash ?? null,
          plan_file: planFile ?? null,
          pending_actions: pendingJson,
        });
      assertSingleChange(result, 'mark completed', sentryId);
    });

    mark();
  }

  /**
   * Records a failed attempt, retrying by returning to pending until max_retries is reached.
   *
   * `pendingActions` (default empty) is co-written atomically — typically
   * empty on retryable failures (we'll re-harvest), but populated when the
   * caller wants to enqueue side effects (e.g. a Slack notice) even on the
   * terminal-failure branch.
   */
  markFailed(
    sentryId: string,
    error: string,
    pendingActions: readonly PendingAction[] = [],
  ): void {
    const pendingJson = serializePendingActions(pendingActions);
    const mark = this.db.transaction(() => {
      const issue = this.getIssue(sentryId);
      if (!issue) {
        throw new Error(`Cannot mark issue ${sentryId} failed: issue not found`);
      }

      const nextDispatchCount = issue.dispatch_count + 1;
      const nextStatus: IssueStatus = nextDispatchCount >= issue.max_retries ? 'failed' : 'pending';
      const result = this.db
        .prepare(
          `UPDATE issues
           SET status = @status,
               dispatch_count = @dispatch_count,
               last_error = @last_error,
               pending_actions = @pending_actions,
               tmux_session = NULL,
               worktree_slot = NULL,
               completed_at = CASE WHEN @status = 'failed' THEN CURRENT_TIMESTAMP ELSE completed_at END,
               updated_at = CURRENT_TIMESTAMP
           WHERE sentry_id = @sentry_id`,
        )
        .run({
          sentry_id: sentryId,
          status: nextStatus,
          dispatch_count: nextDispatchCount,
          last_error: error,
          pending_actions: pendingJson,
        });
      assertSingleChange(result, 'mark failed', sentryId);
    });

    mark();
  }

  /**
   * Records a terminal parse failure without consuming an additional retry attempt.
   *
   * Parse failure is terminal — no retry — so any per-issue reporting MUST be
   * routed via `pendingActions` (Stage C `planActions` enqueues at minimum a
   * `slack_outcome` and optionally a `sentry_comment`). Without that, once
   * `pendingMode=enforce` lands the parse-failure path becomes silently
   * invisible to operators.
   */
  markParseFailure(
    sentryId: string,
    error: string,
    originalOutcome: string,
    pendingActions: readonly PendingAction[] = [],
  ): void {
    const pendingJson = serializePendingActions(pendingActions);
    const mark = this.db.transaction(() => {
      const issue = this.getIssue(sentryId);
      if (!issue) {
        throw new Error(`Cannot mark issue ${sentryId} parse failed: issue not found`);
      }

      const result = this.db
        .prepare(
          `UPDATE issues
           SET status = 'failed',
               failure_kind = 'parse_failure',
               original_outcome = @original_outcome,
               last_error = @last_error,
               pending_actions = @pending_actions,
               tmux_session = NULL,
               worktree_slot = NULL,
               completed_at = CURRENT_TIMESTAMP,
               updated_at = CURRENT_TIMESTAMP
           WHERE sentry_id = @sentry_id`,
        )
        .run({
          sentry_id: sentryId,
          original_outcome: originalOutcome,
          last_error: error,
          pending_actions: pendingJson,
        });
      assertSingleChange(result, 'mark parse failure', sentryId);
    });

    mark();
  }

  /**
   * Records a terminal verification failure — the bugfixer's claimed outcome
   * did not match what the verifier found in the worktree (missing plan file,
   * commit absent, files_changed mismatch, etc.). No retry.
   *
   * `pendingActions` should typically include a `slack_outcome` (always) plus
   * a `linear_create_issue` / `linear_comment_existing` so the mismatch is
   * surfaced to a human; ordering is decided by the Stage C drainer.
   */
  markVerificationFailure(
    sentryId: string,
    verification: VerificationFailureRecord,
    pendingActions: readonly PendingAction[] = [],
  ): void {
    const pendingJson = serializePendingActions(pendingActions);
    const detailsJson = JSON.stringify(verification.details ?? null);
    const mark = this.db.transaction(() => {
      const issue = this.getIssue(sentryId);
      if (!issue) {
        throw new Error(`Cannot mark issue ${sentryId} verification failed: issue not found`);
      }

      const result = this.db
        .prepare(
          `UPDATE issues
           SET status = 'failed',
               failure_kind = 'verification_failure',
               verification_status = 'hard_mismatch',
               verification_details = @verification_details,
               last_error = @last_error,
               pending_actions = @pending_actions,
               tmux_session = NULL,
               worktree_slot = NULL,
               completed_at = CURRENT_TIMESTAMP,
               updated_at = CURRENT_TIMESTAMP
           WHERE sentry_id = @sentry_id`,
        )
        .run({
          sentry_id: sentryId,
          verification_details: detailsJson,
          last_error: verification.summary,
          pending_actions: pendingJson,
        });
      assertSingleChange(result, 'mark verification failure', sentryId);
    });

    mark();
  }

  /**
   * Stores a verification result (status + details) without changing the
   * issue's terminal status — used by `verifyMode=log_only` for soft
   * mismatches and pass results so we can backfill historical signal.
   */
  recordVerificationResult(
    sentryId: string,
    status: string,
    details: unknown,
  ): void {
    const detailsJson = JSON.stringify(details ?? null);
    const update = this.db.transaction(() => {
      this.db
        .prepare(
          `UPDATE issues
           SET verification_status = @status,
               verification_details = @details,
               updated_at = CURRENT_TIMESTAMP
           WHERE sentry_id = @sentry_id`,
        )
        .run({ sentry_id: sentryId, status, details: detailsJson });
    });
    update();
  }

  /**
   * Return every issue whose `pending_actions` column is non-null and
   * non-empty. Drainer + reconciler iterate these on each tick.
   */
  listIssuesWithPendingActions(): IssueRow[] {
    return normalizeIssueRows(
      this.db
        .prepare(
          `SELECT * FROM issues
           WHERE pending_actions IS NOT NULL
             AND pending_actions != ''
             AND pending_actions != '[]'
           ORDER BY updated_at ASC`,
        )
        .all(),
    );
  }

  /**
   * Read the current pending-actions queue for an issue (parsed). Returns []
   * when the column is NULL or empty.
   */
  getPendingActions(sentryId: string): PendingAction[] {
    const row = this.db
      .prepare('SELECT pending_actions FROM issues WHERE sentry_id = ?')
      .get(sentryId);
    if (!row || typeof row !== 'object') return [];
    const serialized = (row as Record<string, unknown>).pending_actions;
    return deserializePendingActions(typeof serialized === 'string' ? serialized : null);
  }

  /**
   * Remove a single pending action (by idempotency_key) from an issue's queue.
   *
   * Used by the Stage C drainer after the action's external side effect has
   * been confirmed done (either by the executor returning success OR by the
   * external probe reporting "already done").
   */
  removePendingAction(sentryId: string, idempotencyKey: string): void {
    const update = this.db.transaction(() => {
      const current = this.getPendingActions(sentryId);
      const filtered = current.filter((action) => action.idempotency_key !== idempotencyKey);
      if (filtered.length === current.length) {
        return; // nothing to remove; no-op
      }
      const serialized = serializePendingActions(filtered);
      this.db
        .prepare(
          `UPDATE issues
           SET pending_actions = @pending_actions,
               updated_at = CURRENT_TIMESTAMP
           WHERE sentry_id = @sentry_id`,
        )
        .run({ sentry_id: sentryId, pending_actions: serialized });
    });
    update();
  }

  /**
   * Record a failed drain attempt for an action: bumps `attempts` and writes
   * the error onto `last_error`. The action stays in the queue for the next
   * tick; if `attempts >= MAX_ATTEMPTS_PER_ACTION` (5) the drainer will stop
   * retrying and surface the permanent failure to operators.
   */
  recordPendingAttempt(sentryId: string, idempotencyKey: string, error: string): void {
    const update = this.db.transaction(() => {
      const current = this.getPendingActions(sentryId);
      const updated = current.map((action) =>
        action.idempotency_key === idempotencyKey
          ? { ...action, attempts: action.attempts + 1, last_error: error }
          : action,
      );
      if (updated.every((a, i) => a === current[i])) {
        return; // action not present; no-op
      }
      const serialized = serializePendingActions(updated);
      this.db
        .prepare(
          `UPDATE issues
           SET pending_actions = @pending_actions,
               updated_at = CURRENT_TIMESTAMP
           WHERE sentry_id = @sentry_id`,
        )
        .run({ sentry_id: sentryId, pending_actions: serialized });
    });
    update();
  }

  /**
   * Replace the entire pending-actions queue for an issue with the given
   * array (after Zod validation). Used by admin tooling (`pending-requeue`,
   * `pending-cancel`) for manual queue surgery.
   *
   * Production code paths should prefer `removePendingAction` and
   * `recordPendingAttempt` — those are surgical-by-key and preserve
   * concurrent invariants.
   */
  replacePendingActions(sentryId: string, actions: PendingAction[]): void {
    const serialized = serializePendingActions(actions);
    this.db
      .prepare(
        `UPDATE issues
         SET pending_actions = @pending_actions,
             updated_at = CURRENT_TIMESTAMP
         WHERE sentry_id = @sentry_id`,
      )
      .run({ sentry_id: sentryId, pending_actions: serialized });
  }

  /**
   * Enqueue a durable, idempotent Sentry comment without firing the inline
   * reporter path. Used by pre-dispatch skip gates where the state row may be
   * re-promoted on the next poll; the idempotency key, not row status, is the
   * anti-respam contract.
   */
  enqueueQuietSentryComment(
    issue: QuietSentryCommentIssue,
    _kind: string,
    body: string,
    idempotencyKey: string,
    now: string = new Date().toISOString(),
  ): boolean {
    const sentryId = issue.sentryId ?? issue.sentry_id;
    if (!sentryId) {
      return false;
    }

    const row = this.getIssue(sentryId);
    if (!row) {
      return false;
    }

    const existingQueue = this.getPendingActions(sentryId);
    if (existingQueue.some((action) => action.idempotency_key === idempotencyKey)) {
      return false;
    }

    const commentAction: PendingAction = {
      kind: 'sentry_comment',
      payload: { text: body },
      idempotency_key: idempotencyKey,
      attempts: 0,
      last_error: null,
      created_at: now,
    };

    this.replacePendingActions(sentryId, [...existingQueue, commentAction]);
    return true;
  }

  /**
   * Enqueue a release-gate skip comment at most once for a given
   * `(issue, currentRelease, issueRelease)` key. The pending queue is drained
   * after successful delivery, so queue-idempotency alone cannot prevent
   * re-posting on the next cron tick; the per-issue key column is the durable
   * anti-respam marker.
   */
  enqueueReleaseGateSkipComment(
    issue: QuietSentryCommentIssue,
    body: string,
    idempotencyKey: string,
    now: string = new Date().toISOString(),
  ): boolean {
    const sentryId = issue.sentryId ?? issue.sentry_id;
    if (!sentryId) {
      return false;
    }

    const enqueue = this.db.transaction(() => {
      const row = this.db
        .prepare(
          `SELECT pending_actions, last_release_skip_comment_key
           FROM issues
           WHERE sentry_id = ?`,
        )
        .get(sentryId) as
        | { pending_actions: string | null; last_release_skip_comment_key: string | null }
        | undefined;

      if (!row) {
        return false;
      }

      if (row.last_release_skip_comment_key === idempotencyKey) {
        return false;
      }

      const existingQueue = deserializePendingActions(row.pending_actions);
      const nextQueue = existingQueue.some((action) => action.idempotency_key === idempotencyKey)
        ? existingQueue
        : [
            ...existingQueue,
            {
              kind: 'sentry_comment',
              payload: { text: body },
              idempotency_key: idempotencyKey,
              attempts: 0,
              last_error: null,
              created_at: now,
            } satisfies PendingAction,
          ];

      this.db
        .prepare(
          `UPDATE issues
           SET pending_actions = @pending_actions,
               last_release_skip_comment_key = @last_release_skip_comment_key,
               updated_at = CURRENT_TIMESTAMP
           WHERE sentry_id = @sentry_id`,
        )
        .run({
          sentry_id: sentryId,
          pending_actions: serializePendingActions(nextQueue),
          last_release_skip_comment_key: idempotencyKey,
        });

      return true;
    });

    return enqueue();
  }

  /**
   * Enqueue a Linear-dedup skip comment at most once for a given
   * `(issue, matchedLinearId)` key. Mirrors enqueueReleaseGateSkipComment:
   * queue idempotency prevents in-flight duplicates, while the per-issue
   * stored key prevents re-posting after a successful drain empties the queue.
   */
  enqueueLinearDedupSkipComment(
    issue: QuietSentryCommentIssue,
    body: string,
    idempotencyKey: string,
    now: string = new Date().toISOString(),
  ): boolean {
    const sentryId = issue.sentryId ?? issue.sentry_id;
    if (!sentryId) {
      return false;
    }

    const enqueue = this.db.transaction(() => {
      const row = this.db
        .prepare(
          `SELECT pending_actions, last_linear_dedup_comment_key
           FROM issues
           WHERE sentry_id = ?`,
        )
        .get(sentryId) as
        | { pending_actions: string | null; last_linear_dedup_comment_key: string | null }
        | undefined;

      if (!row) {
        return false;
      }

      if (row.last_linear_dedup_comment_key === idempotencyKey) {
        return false;
      }

      const existingQueue = deserializePendingActions(row.pending_actions);
      const nextQueue = existingQueue.some((action) => action.idempotency_key === idempotencyKey)
        ? existingQueue
        : [
            ...existingQueue,
            {
              kind: 'sentry_comment',
              payload: { text: body },
              idempotency_key: idempotencyKey,
              attempts: 0,
              last_error: null,
              created_at: now,
            } satisfies PendingAction,
          ];

      this.db
        .prepare(
          `UPDATE issues
           SET pending_actions = @pending_actions,
               last_linear_dedup_comment_key = @last_linear_dedup_comment_key,
               updated_at = CURRENT_TIMESTAMP
           WHERE sentry_id = @sentry_id`,
        )
        .run({
          sentry_id: sentryId,
          pending_actions: serializePendingActions(nextQueue),
          last_linear_dedup_comment_key: idempotencyKey,
        });

      return true;
    });

    return enqueue();
  }

  /**
   * Append an operator-visible escalation row. Returns the inserted id.
   *
   * Used by the Stage C drainer when one or more pending actions exhaust
   * retries (`attempts >= MAX_ATTEMPTS_PER_ACTION`) without succeeding —
   * combined with a Slack post and a `~/sentry-autopilot/ESCALATION-<runId>`
   * marker file, this is the last-resort visibility channel when Slack
   * itself is also failing.
   */
  addEscalation(runId: number, kind: string, context: unknown): number {
    const contextJson = JSON.stringify(context ?? {});
    const insert = this.db.transaction(() => {
      const result = this.db
        .prepare(
          `INSERT INTO escalations (run_id, kind, context)
           VALUES (@run_id, @kind, @context)`,
        )
        .run({ run_id: runId, kind, context: contextJson });
      return Number(result.lastInsertRowid);
    });
    return insert();
  }

  /**
   * Returns all unacknowledged escalations in insertion order. The
   * dispatcher prints these to stderr at startup so operators see them
   * even when Slack is down.
   */
  listUnacknowledgedEscalations(): EscalationRow[] {
    const rows = this.db
      .prepare(
        `SELECT id, run_id, kind, context, created_at, acknowledged_at
         FROM escalations
         WHERE acknowledged_at IS NULL
         ORDER BY created_at ASC, id ASC`,
      )
      .all();
    return rows.map((row) => {
      if (!row || typeof row !== 'object') {
        throw new Error('Invalid escalation row: expected an object');
      }
      const record = row as Record<string, unknown>;
      return {
        id: typeof record.id === 'number' ? record.id : Number(record.id),
        run_id: typeof record.run_id === 'number' ? record.run_id : Number(record.run_id),
        kind: String(record.kind),
        context: String(record.context),
        created_at: String(record.created_at),
        acknowledged_at:
          typeof record.acknowledged_at === 'string' ? record.acknowledged_at : null,
      };
    });
  }

  /**
   * Mark an escalation acknowledged. Used by admin tooling once the
   * operator has handled the underlying issue.
   */
  acknowledgeEscalation(id: number): void {
    const update = this.db.transaction(() => {
      this.db
        .prepare(
          `UPDATE escalations
           SET acknowledged_at = CURRENT_TIMESTAMP
           WHERE id = @id`,
        )
        .run({ id });
    });
    update();
  }

  /**
   * Starts a dispatcher/housekeeping run and returns its run_log ID.
   */
  startRun(runType: string): number {
    const insert = this.db.transaction(() => {
      const result = this.db
        .prepare(
          `INSERT INTO run_log (
             run_type,
             status
           )
           VALUES (
             @run_type,
             'running'
           )`,
        )
        .run({ run_type: runType });

      return Number(result.lastInsertRowid);
    });

    return insert();
  }

  /**
   * Completes a previously started dispatcher/housekeeping run.
   */
  finishRun(
    runId: number,
    issuesFound: number,
    issuesDispatched: number,
    issuesSkipped: number,
    error?: string,
  ): void {
    const update = this.db.transaction(() => {
      this.db
        .prepare(
          `UPDATE run_log
           SET completed_at = CURRENT_TIMESTAMP,
               status = @status,
               issues_found = @issues_found,
               issues_dispatched = @issues_dispatched,
               issues_skipped = @issues_skipped,
               error = @error
           WHERE id = @id`,
        )
        .run({
          id: runId,
          status: error ? 'failed' : 'completed',
          issues_found: issuesFound,
          issues_dispatched: issuesDispatched,
          issues_skipped: issuesSkipped,
          error: error ?? null,
        });
    });

    update();
  }

  /**
   * Inserts a completed dispatcher/housekeeping run log row.
   */
  logRun(
    runType: string,
    issuesFound: number,
    issuesDispatched: number,
    issuesSkipped: number,
    error?: string,
  ): void {
    const insert = this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO run_log (
             run_type,
             completed_at,
             status,
             issues_found,
             issues_dispatched,
             issues_skipped,
             error
           )
           VALUES (
             @run_type,
             CURRENT_TIMESTAMP,
             @status,
             @issues_found,
             @issues_dispatched,
             @issues_skipped,
             @error
           )`,
        )
        .run({
          run_type: runType,
          status: error ? 'failed' : 'completed',
          issues_found: issuesFound,
          issues_dispatched: issuesDispatched,
          issues_skipped: issuesSkipped,
          error: error ?? null,
        });
    });

    insert();
  }

  /**
   * Counts dispatches completed during the requested rolling window.
   */
  countRecentDispatches(intervalHours: number): number {
    const interval = `-${Math.max(1, intervalHours)} hours`;
    const row = this.db
      .prepare(
        `SELECT COALESCE(SUM(issues_dispatched), 0) AS count
         FROM run_log
         WHERE run_type = 'hourly_poll'
           AND status = 'completed'
           AND completed_at >= datetime('now', @interval)`,
      )
      .get({ interval });

    if (!row || typeof row !== 'object') {
      return 0;
    }

    const count = (row as Record<string, unknown>).count;
    return typeof count === 'number' && Number.isFinite(count) ? count : 0;
  }

  /**
   * Returns aggregate outcome stats for the requested rolling window.
   */
  getHeartbeatStats(windowHours: number): HeartbeatStats {
    const interval = `-${Math.max(1, windowHours)} hours`;
    const processedRow = this.db
      .prepare(
        `SELECT COALESCE(SUM(issues_found), 0) AS count
         FROM run_log
         WHERE run_type = 'hourly_poll'
           AND status = 'completed'
           AND completed_at >= datetime('now', @interval)`,
      )
      .get({ interval });

    const processed =
      processedRow && typeof processedRow === 'object'
        ? Number((processedRow as Record<string, unknown>).count)
        : 0;

    const outcomes = this.db
      .prepare(
        `SELECT outcome, status, COUNT(*) AS count
         FROM issues
         WHERE (completed_at >= datetime('now', @interval) OR updated_at >= datetime('now', @interval))
           AND (status IN ('completed', 'failed', 'escalated') OR outcome IS NOT NULL)
         GROUP BY outcome, status`,
      )
      .all({ interval });

    const stats: HeartbeatStats = {
      processed: Number.isFinite(processed) ? processed : 0,
      committed: 0,
      plans: 0,
      escalated: 0,
      failed: 0,
    };

    for (const row of outcomes) {
      if (!row || typeof row !== 'object') {
        continue;
      }

      const record = row as Record<string, unknown>;
      const outcome = typeof record.outcome === 'string' ? record.outcome : null;
      const status = typeof record.status === 'string' ? record.status : null;
      const countValue = record.count;
      const count = typeof countValue === 'number' && Number.isFinite(countValue) ? countValue : 0;

      if (outcome === 'auto_committed' || outcome === 'commit_detected') {
        stats.committed += count;
      } else if (outcome === 'plan_created') {
        stats.plans += count;
      } else if (outcome === 'escalated' || status === 'escalated') {
        stats.escalated += count;
      } else if (status === 'failed' || outcome === 'failed') {
        stats.failed += count;
      }
    }

    return stats;
  }

  /**
   * Returns non-completed issues whose state has not changed for the requested number of days.
   */
  getStaleIssues(olderThanDays: number): IssueRow[] {
    const interval = `-${Math.max(0, olderThanDays)} days`;
    return normalizeIssueRows(
      this.db
        .prepare(
          `SELECT * FROM issues
           WHERE status != 'completed'
             AND updated_at <= datetime('now', @interval)
           ORDER BY updated_at ASC`,
        )
        .all({ interval }),
    );
  }

  /**
   * Returns skipped, never-dispatched issues that have persisted across enough hourly runs.
   */
  getSlowBurnPatterns(minRuns: number, lookbackDays: number): IssueRow[] {
    const interval = `-${Math.max(1, lookbackDays)} days`;
    return normalizeIssueRows(
      this.db
        .prepare(
          `SELECT i.* FROM issues i
           WHERE i.status = 'skipped'
             AND i.dispatch_count = 0
             AND (
               SELECT COUNT(*) FROM run_log r
               WHERE r.run_type = 'hourly_poll'
                 AND r.started_at >= i.created_at
                 AND r.started_at >= datetime('now', @interval)
             ) >= @min_runs
           ORDER BY i.is_user_reported DESC, i.created_at ASC`,
        )
        .all({ interval, min_runs: minRuns }),
    );
  }

  /**
   * Returns true when the named housekeeping task is due to run again.
   */
  shouldRunHousekeeping(type: 'stale_cleanup' | 'cross_day_patterns' | 'heartbeat'): boolean {
    const row = this.db
      .prepare(
        `SELECT * FROM run_log
         WHERE run_type = @run_type
         ORDER BY completed_at DESC, started_at DESC
         LIMIT 1`,
      )
      .get({ run_type: type });

    if (!row) {
      return true;
    }

    const run = normalizeRunLogRow(row);
    const timestamp = run.completed_at ?? run.started_at;
    const lastRun = parseSqliteTimestamp(timestamp);
    if (Number.isNaN(lastRun)) {
      return true;
    }

    return Date.now() - lastRun >= HOUSEKEEPING_INTERVALS_MS[type];
  }

  /**
   * Closes the SQLite database connection.
   */
  close(): void {
    this.db.close();
  }
}
