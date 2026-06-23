import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  type CanaryCategory,
  type ReplayRow,
  categorize,
  determineVerdict,
  getArtifactPath,
  loadIssueIndex,
  main,
  renderReport,
  replayOne,
  safePathSegment,
} from '../canary/offline-replay.ts';

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');

const tempDirs: string[] = [];

function createTempDir(prefix = 'sentry-autopilot-canary-'): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function headCommit(): string {
  return execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
  }).trim();
}

afterEach(() => {
  vi.restoreAllMocks();
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (!dir) continue;
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // best-effort cleanup
    }
  }
});

interface FixtureRow {
  sentryId: string;
  completedAt: string;
  outcomeJson?: string | null; // string=write, null/undefined=skip (artifact_missing)
  unreadable?: boolean;
}

function makeFixtureArtifacts(artifactsRoot: string, rows: FixtureRow[]): void {
  for (const row of rows) {
    const artifactPath = getArtifactPath(artifactsRoot, row.sentryId);
    fs.mkdirSync(path.dirname(artifactPath), { recursive: true });
    if (row.unreadable) {
      fs.mkdirSync(artifactPath, { recursive: true });
      continue;
    }
    if (row.outcomeJson === null || row.outcomeJson === undefined) {
      continue;
    }
    fs.writeFileSync(artifactPath, row.outcomeJson);
  }
}

interface SyntheticIssueRow {
  sentryId: string;
  completedAt: string;
}

function makeSyntheticStateDb(stateDbPath: string, rows: SyntheticIssueRow[]): void {
  const require = createRequire(import.meta.url);
  const Database = require('better-sqlite3') as new (
    filename: string,
  ) => {
    exec(sql: string): void;
    prepare(sql: string): { run(values: Record<string, unknown>): void };
    close(): void;
  };
  const db = new Database(stateDbPath);
  db.exec(`
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
      created_at        DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at        DATETIME DEFAULT CURRENT_TIMESTAMP,
      dispatched_at     DATETIME,
      completed_at      DATETIME
    );
  `);
  const insert = db.prepare(
    `INSERT INTO issues (sentry_id, sentry_url, title, status, completed_at)
     VALUES (@sentry_id, @sentry_url, @title, 'completed', @completed_at)`,
  );
  for (const row of rows) {
    insert.run({
      sentry_id: row.sentryId,
      sentry_url: `https://sentry.io/issues/${row.sentryId}`,
      title: `Test ${row.sentryId}`,
      completed_at: row.completedAt,
    });
  }
  db.close();
}

function referenceSafePathSegment(value: string): string {
  const segment = value.replace(/[^A-Za-z0-9._-]/g, '_');
  if (segment && segment !== '.' && segment !== '..') {
    return segment;
  }
  return crypto.createHash('sha256').update(value).digest('hex').slice(0, 16);
}

function suppressStdio(): void {
  vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
}

function makeRow(category: CanaryCategory): ReplayRow {
  return {
    sentryId: `SENTRY-${category}`,
    completedAt: '2026-05-10 12:00:00',
    artifactPath: `/tmp/dummy/${category}/outcome.json`,
    category,
  };
}

describe('canary offline-replay', () => {
  // -------------------------------------------------------------------------
  // safePathSegment parity
  // -------------------------------------------------------------------------
  describe('safePathSegment parity with production', () => {
    const fixtures = [
      'FOX-3122',
      'FOX#3122',
      '',
      '.',
      '..',
      'a/b/c',
      'SENTRY-1',
      '日本語',
      'a'.repeat(300),
    ];

    for (const input of fixtures) {
      it(`matches reference algorithm for input ${JSON.stringify(input)}`, () => {
        expect(safePathSegment(input)).toBe(referenceSafePathSegment(input));
      });
    }
  });

  // -------------------------------------------------------------------------
  // categorize
  // -------------------------------------------------------------------------
  describe('categorize', () => {
    it('routes "Invalid discriminator value" → fail_parse_bad_discriminator', () => {
      expect(categorize(new Error('Invalid discriminator value'), {})).toBe(
        'fail_parse_bad_discriminator',
      );
    });

    it('routes "commit_hash ... does not exist in" → fail_parse_commit_not_in_repo', () => {
      expect(
        categorize(new Error('commit_hash "abc" does not exist in /repo'), {
          outcome: 'auto_committed',
          commit_hash: 'abc',
        }),
      ).toBe('fail_parse_commit_not_in_repo');
    });

    it('routes "plan_file ... Invalid literal value" → fail_parse_plan_file_literal', () => {
      expect(
        categorize(new Error('plan_file: Invalid literal value, expected "plan.md"'), {
          outcome: 'plan_created',
          plan_file: '../../etc/passwd',
        }),
      ).toBe('fail_parse_plan_file_literal');
    });

    it('falls back to plan_file !== "plan.md" detection when error text does not match', () => {
      expect(
        categorize(new Error('Some other zod error'), {
          outcome: 'plan_created',
          plan_file: 'wrong.md',
        }),
      ).toBe('fail_parse_plan_file_literal');
    });

    it('routes "String must contain at most ... character" → fail_parse_long_text_overflow', () => {
      expect(
        categorize(new Error('String must contain at most 8000 character(s)'), {}),
      ).toBe('fail_parse_long_text_overflow');
    });

    it('routes "Required" → fail_parse_missing_required_field', () => {
      expect(categorize(new Error('commit_hash: Required'), {})).toBe(
        'fail_parse_missing_required_field',
      );
    });

    it('falls through to fail_parse_other for unknown messages', () => {
      expect(categorize(new Error('completely novel error'), {})).toBe('fail_parse_other');
    });
  });

  // -------------------------------------------------------------------------
  // determineVerdict
  // -------------------------------------------------------------------------
  describe('determineVerdict', () => {
    it('0 failures → green', () => {
      const rows = [makeRow('pass_unchanged'), makeRow('pass_warn'), makeRow('pass_reclassified')];
      expect(determineVerdict(rows)).toBe('green');
    });

    it('1 fail_parse_long_text_overflow → yellow (non-production wording)', () => {
      const rows = [makeRow('pass_unchanged'), makeRow('fail_parse_long_text_overflow')];
      expect(determineVerdict(rows)).toBe('yellow');
    });

    it('1 fail_parse_bad_discriminator → red (production wording trips Red regardless of count)', () => {
      const rows = [makeRow('pass_unchanged'), makeRow('fail_parse_bad_discriminator')];
      expect(determineVerdict(rows)).toBe('red');
    });

    it('3 fail_parse_other → yellow', () => {
      const rows = [
        makeRow('fail_parse_other'),
        makeRow('fail_parse_other'),
        makeRow('fail_parse_other'),
      ];
      expect(determineVerdict(rows)).toBe('yellow');
    });

    it('4 fail_parse_other → red (>3 trips Red even without production wording)', () => {
      const rows = [
        makeRow('fail_parse_other'),
        makeRow('fail_parse_other'),
        makeRow('fail_parse_other'),
        makeRow('fail_parse_other'),
      ];
      expect(determineVerdict(rows)).toBe('red');
    });

    it('mixed: 2 fail_parse_other + 1 fail_parse_missing_required_field → red', () => {
      const rows = [
        makeRow('fail_parse_other'),
        makeRow('fail_parse_other'),
        makeRow('fail_parse_missing_required_field'),
      ];
      expect(determineVerdict(rows)).toBe('red');
    });

    it('ignores artifact_missing / artifact_unreadable from verdict computation', () => {
      const rows = [
        makeRow('pass_unchanged'),
        makeRow('artifact_missing'),
        makeRow('artifact_missing'),
        makeRow('artifact_unreadable'),
      ];
      expect(determineVerdict(rows)).toBe('green');
    });
  });

  // -------------------------------------------------------------------------
  // loadIssueIndex
  // -------------------------------------------------------------------------
  describe('loadIssueIndex', () => {
    it('returns rows ordered DESC by completed_at, filtered by since and limit', () => {
      const dbDir = createTempDir();
      const dbPath = path.join(dbDir, 'state.db');
      makeSyntheticStateDb(dbPath, [
        { sentryId: 'OLD-1', completedAt: '2026-05-01 09:00:00' },
        { sentryId: 'MID-1', completedAt: '2026-05-10 12:00:00' },
        { sentryId: 'NEW-1', completedAt: '2026-05-12 18:00:00' },
      ]);

      const rows = loadIssueIndex(dbPath, '2026-05-05', 10);
      expect(rows.map((r) => r.sentryId)).toEqual(['NEW-1', 'MID-1']);
      expect(rows[0]?.completedAt).toBe('2026-05-12 18:00:00');
    });

    it('respects the limit parameter', () => {
      const dbDir = createTempDir();
      const dbPath = path.join(dbDir, 'state.db');
      makeSyntheticStateDb(dbPath, [
        { sentryId: 'A', completedAt: '2026-05-10 09:00:00' },
        { sentryId: 'B', completedAt: '2026-05-10 10:00:00' },
        { sentryId: 'C', completedAt: '2026-05-10 11:00:00' },
      ]);

      const rows = loadIssueIndex(dbPath, '2026-01-01', 2);
      expect(rows.map((r) => r.sentryId)).toEqual(['C', 'B']);
    });
  });

  // -------------------------------------------------------------------------
  // replayOne — 10 per-fixture cases per § 8.1
  // -------------------------------------------------------------------------
  describe('replayOne per-fixture', () => {
    it('fixture 1 (auto_committed + HEAD commit) → pass_unchanged', () => {
      const artifactsRoot = createTempDir();
      const commit = headCommit();
      const fx: FixtureRow = {
        sentryId: 'FX-1',
        completedAt: '2026-05-10 12:00:00',
        outcomeJson: JSON.stringify({ outcome: 'auto_committed', commit_hash: commit }),
      };
      makeFixtureArtifacts(artifactsRoot, [fx]);
      const result = replayOne(
        { sentryId: fx.sentryId, completedAt: fx.completedAt },
        artifactsRoot,
        { repoRoot: REPO_ROOT, skipCommitValidation: false },
      );
      expect(result.category).toBe('pass_unchanged');
      expect(result.outcomeKind).toBe('auto_committed');
    });

    it('fixture 2 (plan_created + plan.md + is_bug:true) → pass_unchanged', () => {
      const artifactsRoot = createTempDir();
      const fx: FixtureRow = {
        sentryId: 'FX-2',
        completedAt: '2026-05-10 12:00:00',
        outcomeJson: JSON.stringify({
          outcome: 'plan_created',
          plan_file: 'plan.md',
          is_bug: true,
        }),
      };
      makeFixtureArtifacts(artifactsRoot, [fx]);
      const result = replayOne(
        { sentryId: fx.sentryId, completedAt: fx.completedAt },
        artifactsRoot,
        { repoRoot: REPO_ROOT, skipCommitValidation: false },
      );
      expect(result.category).toBe('pass_unchanged');
      expect(result.outcomeKind).toBe('plan_created');
    });

    it('fixture 2b (typed-valid plan_created + unknown extras) → pass_unchanged', () => {
      const artifactsRoot = createTempDir();
      const fx: FixtureRow = {
        sentryId: 'FX-2B',
        completedAt: '2026-05-10 12:00:00',
        outcomeJson: JSON.stringify({
          outcome: 'plan_created',
          plan_file: 'plan.md',
          is_bug: true,
          originating_commit: '9f8e7d6c5b4a3210',
          review_mode: 'light',
          debuggers_consulted: ['debugger-1', 'debugger-2'],
          sentry_short_id: 'REBEL-456',
          reviewer_results: [{ name: 'reviewer-gpt5.5-high', verdict: 'approve', confidence: 92 }],
        }),
      };
      makeFixtureArtifacts(artifactsRoot, [fx]);
      const result = replayOne(
        { sentryId: fx.sentryId, completedAt: fx.completedAt },
        artifactsRoot,
        { repoRoot: REPO_ROOT, skipCommitValidation: false },
      );
      expect(result.category).toBe('pass_unchanged');
      expect(result.outcomeKind).toBe('plan_created');
    });

    it('fixture 3 (not_a_bug + reason) → pass_unchanged', () => {
      const artifactsRoot = createTempDir();
      const fx: FixtureRow = {
        sentryId: 'FX-3',
        completedAt: '2026-05-10 12:00:00',
        outcomeJson: JSON.stringify({ outcome: 'not_a_bug', reason: 'works as designed' }),
      };
      makeFixtureArtifacts(artifactsRoot, [fx]);
      const result = replayOne(
        { sentryId: fx.sentryId, completedAt: fx.completedAt },
        artifactsRoot,
        { repoRoot: REPO_ROOT, skipCommitValidation: false },
      );
      expect(result.category).toBe('pass_unchanged');
      expect(result.outcomeKind).toBe('not_a_bug');
    });

    it('fixture 4 (escalated + reason) → pass_unchanged', () => {
      const artifactsRoot = createTempDir();
      const fx: FixtureRow = {
        sentryId: 'FX-4',
        completedAt: '2026-05-10 12:00:00',
        outcomeJson: JSON.stringify({ outcome: 'escalated', reason: 'needs human review' }),
      };
      makeFixtureArtifacts(artifactsRoot, [fx]);
      const result = replayOne(
        { sentryId: fx.sentryId, completedAt: fx.completedAt },
        artifactsRoot,
        { repoRoot: REPO_ROOT, skipCommitValidation: false },
      );
      expect(result.category).toBe('pass_unchanged');
      expect(result.outcomeKind).toBe('escalated');
    });

    it('fixture 5 (plan_created without is_bug) → pass_warn', () => {
      const artifactsRoot = createTempDir();
      const fx: FixtureRow = {
        sentryId: 'FX-5',
        completedAt: '2026-05-10 12:00:00',
        outcomeJson: JSON.stringify({ outcome: 'plan_created', plan_file: 'plan.md' }),
      };
      makeFixtureArtifacts(artifactsRoot, [fx]);
      const result = replayOne(
        { sentryId: fx.sentryId, completedAt: fx.completedAt },
        artifactsRoot,
        { repoRoot: REPO_ROOT, skipCommitValidation: false },
      );
      expect(result.category).toBe('pass_warn');
      expect(result.outcomeKind).toBe('plan_created');
    });

    it('fixture 6 (plan_created + is_bug:false) → pass_reclassified', () => {
      const artifactsRoot = createTempDir();
      const fx: FixtureRow = {
        sentryId: 'FX-6',
        completedAt: '2026-05-10 12:00:00',
        outcomeJson: JSON.stringify({
          outcome: 'plan_created',
          plan_file: 'plan.md',
          is_bug: false,
        }),
      };
      makeFixtureArtifacts(artifactsRoot, [fx]);
      const result = replayOne(
        { sentryId: fx.sentryId, completedAt: fx.completedAt },
        artifactsRoot,
        { repoRoot: REPO_ROOT, skipCommitValidation: false },
      );
      expect(result.category).toBe('pass_reclassified');
      expect(result.outcomeKind).toBe('plan_created');
    });

    it('fixture 7 (auto_committed + bogus 40-a commit_hash) → fail_parse_commit_not_in_repo (default)', () => {
      const artifactsRoot = createTempDir();
      const fx: FixtureRow = {
        sentryId: 'FX-7',
        completedAt: '2026-05-10 12:00:00',
        outcomeJson: JSON.stringify({
          outcome: 'auto_committed',
          commit_hash: 'a'.repeat(40),
        }),
      };
      makeFixtureArtifacts(artifactsRoot, [fx]);
      const result = replayOne(
        { sentryId: fx.sentryId, completedAt: fx.completedAt },
        artifactsRoot,
        { repoRoot: REPO_ROOT, skipCommitValidation: false },
      );
      expect(result.category).toBe('fail_parse_commit_not_in_repo');
      expect(result.error).toMatch(/does not exist in/i);
      expect(result.rawSnippet).toBeDefined();
    });

    it('fixture 7 (auto_committed + bogus commit_hash) → pass_unchanged when skipCommitValidation=true', () => {
      const artifactsRoot = createTempDir();
      const fx: FixtureRow = {
        sentryId: 'FX-7-skip',
        completedAt: '2026-05-10 12:00:00',
        outcomeJson: JSON.stringify({
          outcome: 'auto_committed',
          commit_hash: 'a'.repeat(40),
        }),
      };
      makeFixtureArtifacts(artifactsRoot, [fx]);
      const result = replayOne(
        { sentryId: fx.sentryId, completedAt: fx.completedAt },
        artifactsRoot,
        { repoRoot: REPO_ROOT, skipCommitValidation: true },
      );
      expect(result.category).toBe('pass_unchanged');
      expect(result.outcomeKind).toBe('auto_committed');
    });

    it('fixture 8 (outcome:"unknown_kind") → fail_parse_bad_discriminator', () => {
      const artifactsRoot = createTempDir();
      const fx: FixtureRow = {
        sentryId: 'FX-8',
        completedAt: '2026-05-10 12:00:00',
        outcomeJson: JSON.stringify({ outcome: 'unknown_kind' }),
      };
      makeFixtureArtifacts(artifactsRoot, [fx]);
      const result = replayOne(
        { sentryId: fx.sentryId, completedAt: fx.completedAt },
        artifactsRoot,
        { repoRoot: REPO_ROOT, skipCommitValidation: false },
      );
      expect(result.category).toBe('fail_parse_bad_discriminator');
      expect(result.error).toMatch(/Invalid discriminator value|No matching discriminator/i);
    });

    it('fixture 9 (auto_committed without commit_hash) → fail_parse_missing_required_field', () => {
      const artifactsRoot = createTempDir();
      const fx: FixtureRow = {
        sentryId: 'FX-9',
        completedAt: '2026-05-10 12:00:00',
        outcomeJson: JSON.stringify({ outcome: 'auto_committed' }),
      };
      makeFixtureArtifacts(artifactsRoot, [fx]);
      const result = replayOne(
        { sentryId: fx.sentryId, completedAt: fx.completedAt },
        artifactsRoot,
        { repoRoot: REPO_ROOT, skipCommitValidation: false },
      );
      expect(result.category).toBe('fail_parse_missing_required_field');
      expect(result.error).toMatch(/Required|expected \S+, received undefined/i);
    });

    it('fixture 10 (plan_created + plan_file:"../../../etc/passwd") → fail_parse_plan_file_literal', () => {
      const artifactsRoot = createTempDir();
      const fx: FixtureRow = {
        sentryId: 'FX-10',
        completedAt: '2026-05-10 12:00:00',
        outcomeJson: JSON.stringify({
          outcome: 'plan_created',
          plan_file: '../../../etc/passwd',
        }),
      };
      makeFixtureArtifacts(artifactsRoot, [fx]);
      const result = replayOne(
        { sentryId: fx.sentryId, completedAt: fx.completedAt },
        artifactsRoot,
        { repoRoot: REPO_ROOT, skipCommitValidation: false },
      );
      expect(result.category).toBe('fail_parse_plan_file_literal');
    });
  });

  // -------------------------------------------------------------------------
  // replayOne — artifact-side failures (not verdict-affecting)
  // -------------------------------------------------------------------------
  describe('replayOne artifact-side failures', () => {
    it('returns artifact_missing when no outcome.json exists', () => {
      const artifactsRoot = createTempDir();
      const result = replayOne(
        { sentryId: 'GHOST-1', completedAt: '2026-05-10 12:00:00' },
        artifactsRoot,
        { repoRoot: REPO_ROOT, skipCommitValidation: false },
      );
      expect(result.category).toBe('artifact_missing');
    });

    it('returns artifact_unreadable when artifact path is a directory', () => {
      const artifactsRoot = createTempDir();
      makeFixtureArtifacts(artifactsRoot, [
        { sentryId: 'EISDIR-1', completedAt: '2026-05-10 12:00:00', unreadable: true },
      ]);
      const result = replayOne(
        { sentryId: 'EISDIR-1', completedAt: '2026-05-10 12:00:00' },
        artifactsRoot,
        { repoRoot: REPO_ROOT, skipCommitValidation: false },
      );
      expect(result.category).toBe('artifact_unreadable');
      expect(result.error).toBeDefined();
    });

    it('returns fail_parse_other with JSON.parse: prefix for malformed JSON', () => {
      const artifactsRoot = createTempDir();
      makeFixtureArtifacts(artifactsRoot, [
        { sentryId: 'BAD-JSON-1', completedAt: '2026-05-10 12:00:00', outcomeJson: '{not-json' },
      ]);
      const result = replayOne(
        { sentryId: 'BAD-JSON-1', completedAt: '2026-05-10 12:00:00' },
        artifactsRoot,
        { repoRoot: REPO_ROOT, skipCommitValidation: false },
      );
      expect(result.category).toBe('fail_parse_other');
      expect(result.error).toMatch(/^JSON\.parse:/);
      expect(result.rawSnippet).toBe('{not-json');
    });
  });

  // -------------------------------------------------------------------------
  // renderReport
  // -------------------------------------------------------------------------
  describe('renderReport', () => {
    it('emits expected verdict header, summary table, generator trailer', () => {
      const rows: ReplayRow[] = [
        { ...makeRow('pass_unchanged'), outcomeKind: 'auto_committed' },
        { ...makeRow('pass_warn'), outcomeKind: 'plan_created' },
        {
          ...makeRow('fail_parse_long_text_overflow'),
          error: 'String must contain at most 8000 character(s)',
          rawSnippet: '{"outcome":"plan_created","diagnosis":"<too long>"}',
        },
      ];
      const args = {
        stateDb: '/tmp/state.db',
        artifactsRoot: '/tmp/artifacts',
        since: '2026-05-07',
        reportOut: '/tmp/report.md',
        skipCommitValidation: true,
        repoRoot: '/tmp/repo',
        limit: 10000,
      };
      const report = renderReport(args, rows, 'yellow');
      expect(report).toContain('# Sentry Autopilot Offline-Replay Canary Report');
      expect(report).toContain(':large_yellow_circle:');
      expect(report).toContain('YELLOW — proceed with operator awareness');
      expect(report).toContain('| pass_unchanged | 1 |');
      expect(report).toContain('**fail_parse_long_text_overflow**');
      expect(report).toContain('**Total replayed** | **3**');
      expect(report).toContain('Commit verification was skipped');
      expect(report).toContain(
        '*Generated by `scripts/sentry-autopilot/canary/offline-replay.ts`.*',
      );
    });

    it('falls back to <pre> when a raw snippet contains triple-backticks', () => {
      const rows: ReplayRow[] = [
        {
          ...makeRow('fail_parse_other'),
          error: 'something broke',
          rawSnippet: 'leading text ``` more content',
        },
      ];
      const args = {
        stateDb: '/tmp/state.db',
        artifactsRoot: '/tmp/artifacts',
        since: '2026-05-07',
        reportOut: '/tmp/report.md',
        skipCommitValidation: false,
        repoRoot: '/tmp/repo',
        limit: 10000,
      };
      const report = renderReport(args, rows, 'yellow');
      expect(report).toContain('<pre>leading text ``` more content</pre>');
    });
  });

  // -------------------------------------------------------------------------
  // main() CLI
  // -------------------------------------------------------------------------
  describe('main() CLI', () => {
    it('--help returns 0 and writes the help text', () => {
      const writes: string[] = [];
      vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
        writes.push(typeof chunk === 'string' ? chunk : chunk.toString());
        return true;
      });
      vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
      const code = main(['--help']);
      expect(code).toBe(0);
      expect(writes.join('')).toMatch(/sentry-autopilot offline-replay canary/);
    });

    it('returns 64 when --artifacts-root is missing', () => {
      suppressStdio();
      const code = main(['--state-db', '/tmp/x.db']);
      expect(code).toBe(64);
    });

    it('returns 64 when --state-db is missing', () => {
      suppressStdio();
      const code = main([
        '--artifacts-root',
        '/tmp',
        '--since',
        '2026-05-01',
        '--report-out',
        '/tmp/r.md',
      ]);
      expect(code).toBe(64);
    });

    it('returns 64 when --since is malformed (2026/05/14)', () => {
      suppressStdio();
      const code = main([
        '--state-db',
        '/tmp/x.db',
        '--artifacts-root',
        '/tmp',
        '--since',
        '2026/05/14',
        '--report-out',
        '/tmp/r.md',
      ]);
      expect(code).toBe(64);
    });

    it('returns 64 when --limit is not a positive integer', () => {
      suppressStdio();
      const dbDir = createTempDir();
      const dbPath = path.join(dbDir, 'state.db');
      makeSyntheticStateDb(dbPath, []);
      const code = main([
        '--state-db',
        dbPath,
        '--artifacts-root',
        dbDir,
        '--since',
        '2026-05-01',
        '--report-out',
        path.join(dbDir, 'r.md'),
        '--limit',
        'not-a-number',
      ]);
      expect(code).toBe(64);
    });

    it('returns 64 when --state-db does not exist', () => {
      suppressStdio();
      const artifactsRoot = createTempDir();
      const code = main([
        '--state-db',
        '/no/such/path/state.db',
        '--artifacts-root',
        artifactsRoot,
        '--since',
        '2026-05-01',
        '--report-out',
        path.join(artifactsRoot, 'r.md'),
      ]);
      expect(code).toBe(64);
    });

    it('returns 64 when --artifacts-root is not a directory', () => {
      suppressStdio();
      const dbDir = createTempDir();
      const dbPath = path.join(dbDir, 'state.db');
      makeSyntheticStateDb(dbPath, []);
      const filePath = path.join(dbDir, 'not-a-dir.txt');
      fs.writeFileSync(filePath, 'sentinel');
      const code = main([
        '--state-db',
        dbPath,
        '--artifacts-root',
        filePath,
        '--since',
        '2026-05-01',
        '--report-out',
        path.join(dbDir, 'r.md'),
      ]);
      expect(code).toBe(64);
    });
  });

  // -------------------------------------------------------------------------
  // End-to-end smoke test
  // -------------------------------------------------------------------------
  describe('end-to-end smoke', () => {
    it('replays a 10-fixture state.db + artifact tree and writes a Red verdict report', () => {
      suppressStdio();
      const baseDir = createTempDir();
      const stateDbPath = path.join(baseDir, 'state.db');
      const artifactsRoot = path.join(baseDir, 'artifacts');
      const reportPath = path.join(baseDir, 'reports', 'canary.md');
      fs.mkdirSync(artifactsRoot, { recursive: true });

      const commit = headCommit();

      const fixtures: Array<FixtureRow & { kind: string }> = [
        {
          sentryId: 'FX-1',
          completedAt: '2026-05-10 12:00:00',
          outcomeJson: JSON.stringify({ outcome: 'auto_committed', commit_hash: commit }),
          kind: 'pass_unchanged',
        },
        {
          sentryId: 'FX-2',
          completedAt: '2026-05-10 12:01:00',
          outcomeJson: JSON.stringify({
            outcome: 'plan_created',
            plan_file: 'plan.md',
            is_bug: true,
          }),
          kind: 'pass_unchanged',
        },
        {
          sentryId: 'FX-3',
          completedAt: '2026-05-10 12:02:00',
          outcomeJson: JSON.stringify({ outcome: 'not_a_bug', reason: 'works as designed' }),
          kind: 'pass_unchanged',
        },
        {
          sentryId: 'FX-4',
          completedAt: '2026-05-10 12:03:00',
          outcomeJson: JSON.stringify({ outcome: 'escalated', reason: 'needs human review' }),
          kind: 'pass_unchanged',
        },
        {
          sentryId: 'FX-5',
          completedAt: '2026-05-10 12:04:00',
          outcomeJson: JSON.stringify({ outcome: 'plan_created', plan_file: 'plan.md' }),
          kind: 'pass_warn',
        },
        {
          sentryId: 'FX-6',
          completedAt: '2026-05-10 12:05:00',
          outcomeJson: JSON.stringify({
            outcome: 'plan_created',
            plan_file: 'plan.md',
            is_bug: false,
          }),
          kind: 'pass_reclassified',
        },
        {
          sentryId: 'FX-7',
          completedAt: '2026-05-10 12:06:00',
          outcomeJson: JSON.stringify({
            outcome: 'auto_committed',
            commit_hash: 'a'.repeat(40),
          }),
          kind: 'fail_parse_commit_not_in_repo',
        },
        {
          sentryId: 'FX-8',
          completedAt: '2026-05-10 12:07:00',
          outcomeJson: JSON.stringify({ outcome: 'unknown_kind' }),
          kind: 'fail_parse_bad_discriminator',
        },
        {
          sentryId: 'FX-9',
          completedAt: '2026-05-10 12:08:00',
          outcomeJson: JSON.stringify({ outcome: 'auto_committed' }),
          kind: 'fail_parse_missing_required_field',
        },
        {
          sentryId: 'FX-10',
          completedAt: '2026-05-10 12:09:00',
          outcomeJson: JSON.stringify({
            outcome: 'plan_created',
            plan_file: '../../../etc/passwd',
          }),
          kind: 'fail_parse_plan_file_literal',
        },
      ];

      makeSyntheticStateDb(
        stateDbPath,
        fixtures.map((f) => ({ sentryId: f.sentryId, completedAt: f.completedAt })),
      );
      makeFixtureArtifacts(artifactsRoot, fixtures);

      const code = main([
        '--state-db',
        stateDbPath,
        '--artifacts-root',
        artifactsRoot,
        '--since',
        '2026-05-01',
        '--report-out',
        reportPath,
        '--repo-root',
        REPO_ROOT,
      ]);

      // Verdict should be Red — fixtures 7/8/9/10 are all production-wording failures.
      expect(code).toBe(2);
      expect(fs.existsSync(reportPath)).toBe(true);
      const report = fs.readFileSync(reportPath, 'utf8');
      expect(report).toContain(':large_red_circle:');
      expect(report).toContain('RED — halt deploy');
      expect(report).toContain('| pass_unchanged | 4 |');
      expect(report).toContain('| pass_warn (is_bug missing) | 1 |');
      expect(report).toContain('| pass_reclassified (plan_created → not_a_bug) | 1 |');
      expect(report).toContain('**fail_parse_commit_not_in_repo** | 1 |');
      expect(report).toContain('**fail_parse_bad_discriminator** | 1 |');
      expect(report).toContain('**fail_parse_missing_required_field** | 1 |');
      expect(report).toContain('**fail_parse_plan_file_literal** | 1 |');
      expect(report).toContain('**Total replayed** | **10**');
      expect(report).toContain('### fail_parse_commit_not_in_repo (1)');
      expect(report).toContain('### fail_parse_bad_discriminator (1)');
      expect(report).toContain('### fail_parse_missing_required_field (1)');
      expect(report).toContain('### fail_parse_plan_file_literal (1)');
      // Skip-validation default is false; the report should note commit verification was active.
      expect(report).toContain('Commit verification was active');
    });

    it('with --skip-commit-validation, fixture 7 passes and verdict reflects only 8/9/10', () => {
      suppressStdio();
      const baseDir = createTempDir();
      const stateDbPath = path.join(baseDir, 'state.db');
      const artifactsRoot = path.join(baseDir, 'artifacts');
      const reportPath = path.join(baseDir, 'reports', 'canary.md');
      fs.mkdirSync(artifactsRoot, { recursive: true });

      const fixtures: FixtureRow[] = [
        {
          sentryId: 'SK-7',
          completedAt: '2026-05-10 12:00:00',
          outcomeJson: JSON.stringify({
            outcome: 'auto_committed',
            commit_hash: 'a'.repeat(40),
          }),
        },
        {
          sentryId: 'SK-8',
          completedAt: '2026-05-10 12:01:00',
          outcomeJson: JSON.stringify({ outcome: 'unknown_kind' }),
        },
      ];

      makeSyntheticStateDb(
        stateDbPath,
        fixtures.map((f) => ({ sentryId: f.sentryId, completedAt: f.completedAt })),
      );
      makeFixtureArtifacts(artifactsRoot, fixtures);

      const code = main([
        '--state-db',
        stateDbPath,
        '--artifacts-root',
        artifactsRoot,
        '--since',
        '2026-05-01',
        '--report-out',
        reportPath,
        '--repo-root',
        REPO_ROOT,
        '--skip-commit-validation',
      ]);

      // Verdict is Red because fixture 8 is a production-wording failure.
      expect(code).toBe(2);
      const report = fs.readFileSync(reportPath, 'utf8');
      expect(report).toContain('| pass_unchanged | 1 |');
      expect(report).toContain('**fail_parse_bad_discriminator** | 1 |');
      expect(report).toContain('Commit verification was skipped');
      // Skip path should NOT produce a commit_not_in_repo row.
      expect(report).not.toContain('### fail_parse_commit_not_in_repo');
    });
  });
});
