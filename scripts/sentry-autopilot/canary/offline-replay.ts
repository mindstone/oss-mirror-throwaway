#!/usr/bin/env npx tsx
/**
 * Sentry Autopilot offline-replay canary.
 *
 * Replays historical outcome.json artifacts (extracted from a state.db backup)
 * against the new strict schema (`parseOutcome`) and reports a Green/Yellow/Red
 * stoplight verdict to a markdown file. Tooling-only: no production state
 * mutation.
 *
 * See docs/plans/260514_sentry_autopilot_plan_1_v2_stage_5_implementation.md.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { parseArgs } from 'node:util';

import { parseOutcome, type Outcome } from '../outcome-schema.ts';
import { reclassifyOutcome } from '../session-manager.ts';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type CanaryCategory =
  | 'pass_unchanged'
  | 'pass_warn'
  | 'pass_reclassified'
  | 'fail_parse_bad_discriminator'
  | 'fail_parse_missing_required_field'
  | 'fail_parse_plan_file_literal'
  | 'fail_parse_commit_not_in_repo'
  | 'fail_parse_long_text_overflow'
  | 'fail_parse_other'
  | 'artifact_missing'
  | 'artifact_unreadable';

export interface ReplayRow {
  sentryId: string;
  completedAt: string;
  artifactPath: string;
  category: CanaryCategory;
  outcomeKind?: Outcome['outcome'];
  error?: string;
  rawSnippet?: string;
}

export interface CanaryArgs {
  stateDb: string;
  artifactsRoot: string;
  since: string;
  reportOut: string;
  skipCommitValidation: boolean;
  repoRoot: string;
  limit: number;
}

export type StoplightVerdict = 'green' | 'yellow' | 'red';

interface IssueIndexRow {
  sentryId: string;
  completedAt: string;
}

// ---------------------------------------------------------------------------
// Help text
// ---------------------------------------------------------------------------

const HELP_TEXT = `sentry-autopilot offline-replay canary

Usage:
  npx tsx scripts/sentry-autopilot/canary/offline-replay.ts \\
    --state-db <path> --artifacts-root <path> \\
    --since <yyyy-mm-dd> --report-out <path> \\
    [--skip-commit-validation] [--repo-root <path>] [--limit <N>]

Replays historical outcome.json artifacts against the new strict schema and
writes a stoplight verdict (Green / Yellow / Red) to <report-out>.

Required flags:
  --state-db <path>         Path to state.db backup (opened read-only)
  --artifacts-root <path>   Local copy of <stateDir>/artifacts/ tree
  --since <yyyy-mm-dd>      Replay window start (UTC, completed_at >= since)
  --report-out <path>       Markdown report destination

Optional flags:
  --skip-commit-validation  Skip git cat-file check for auto_committed outcomes
                            (useful when local repo doesn't have historical commits)
  --repo-root <path>        Git repo for commit verification (default: cwd)
  --limit <N>               Max issues to replay (default: 10000)
  --help                    Show this help and exit 0

Exit codes:
  0   Green verdict (0 parse failures; safe to enforce schema)
  1   Yellow verdict (1-3 known-class failures; ship with operator awareness)
  2   Red verdict (>3 failures OR any current-production-wording failure)
  64  Usage error (missing required flag, malformed input, etc.)
`;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Re-implementation of the production `safePathSegment` from
 * `session-manager.ts`. We deliberately re-implement here (rather than
 * importing) to avoid pulling the runtime entry point of session-manager
 * into the canary CLI. The canary test file asserts parity against a fixture
 * set of sentry-id shapes so the two cannot silently drift.
 */
export function safePathSegment(value: string): string {
  const segment = value.replace(/[^A-Za-z0-9._-]/g, '_');
  if (segment && segment !== '.' && segment !== '..') {
    return segment;
  }

  return crypto.createHash('sha256').update(value).digest('hex').slice(0, 16);
}

export function getArtifactPath(artifactsRoot: string, sentryId: string): string {
  return path.join(artifactsRoot, safePathSegment(sentryId), 'outcome.json');
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

function stripAnsi(value: string): string {
  return value.replace(/\u001b\[[0-9;]*m/g, '');
}

function takeSnippet(raw: string): string {
  return stripAnsi(raw).slice(0, 1000);
}

// ---------------------------------------------------------------------------
// loadIssueIndex
// ---------------------------------------------------------------------------

export function loadIssueIndex(
  stateDbPath: string,
  since: string,
  limit: number,
): IssueIndexRow[] {
  const require = createRequire(import.meta.url);
  const Database = require('better-sqlite3') as new (
    filename: string,
    options?: { readonly?: boolean; fileMustExist?: boolean },
  ) => {
    prepare(sql: string): {
      all(params: Record<string, unknown>): Array<{ sentry_id: string; completed_at: string }>;
    };
    close(): void;
  };

  const db = new Database(stateDbPath, { readonly: true, fileMustExist: true });
  const sinceSqlite = `${since} 00:00:00`;
  const rows = db
    .prepare(
      `SELECT sentry_id, completed_at
       FROM issues
       WHERE completed_at IS NOT NULL AND completed_at >= @since
       ORDER BY completed_at DESC
       LIMIT @limit`,
    )
    .all({ since: sinceSqlite, limit });
  db.close();
  return rows.map((r) => ({ sentryId: r.sentry_id, completedAt: r.completed_at }));
}

// ---------------------------------------------------------------------------
// categorize
// ---------------------------------------------------------------------------

export function categorize(error: Error, raw: unknown): CanaryCategory {
  const msg = error.message ?? String(error);

  // Match both Zod v3 ("Invalid discriminator value") and Zod v4
  // ("No matching discriminator", code "invalid_union") wording so the
  // canary stays correct across Zod major bumps.
  if (/Invalid discriminator value|No matching discriminator/i.test(msg)) {
    return 'fail_parse_bad_discriminator';
  }

  if (/commit_hash.*does not exist in|references commit.*does not exist in/i.test(msg)) {
    return 'fail_parse_commit_not_in_repo';
  }

  if (/plan_file.*expected "plan\.md"|plan_file.*Invalid literal value/i.test(msg)) {
    return 'fail_parse_plan_file_literal';
  }

  if (raw && typeof raw === 'object' && raw !== null) {
    const planFile = (raw as { plan_file?: unknown }).plan_file;
    if (typeof planFile === 'string' && planFile !== 'plan.md') {
      return 'fail_parse_plan_file_literal';
    }
  }

  if (/String must contain at most.*character/i.test(msg)) {
    return 'fail_parse_long_text_overflow';
  }

  // Zod v3: bare "Required". Zod v4: "Invalid input: expected <type>,
  // received undefined" (or code "invalid_type" / received "undefined").
  if (/\bRequired\b|expected \S+, received undefined/i.test(msg)) {
    return 'fail_parse_missing_required_field';
  }

  return 'fail_parse_other';
}

// ---------------------------------------------------------------------------
// replayOne
// ---------------------------------------------------------------------------

export function replayOne(
  row: IssueIndexRow,
  artifactsRoot: string,
  config: { repoRoot: string; skipCommitValidation: boolean },
): ReplayRow {
  const artifactPath = getArtifactPath(artifactsRoot, row.sentryId);

  const base = {
    sentryId: row.sentryId,
    completedAt: row.completedAt,
    artifactPath,
  };

  if (!fs.existsSync(artifactPath)) {
    return { ...base, category: 'artifact_missing' };
  }

  let raw: string;
  try {
    raw = fs.readFileSync(artifactPath, 'utf8');
  } catch (e) {
    return { ...base, category: 'artifact_unreadable', error: errorMessage(e) };
  }

  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(raw);
  } catch (e) {
    return {
      ...base,
      category: 'fail_parse_other',
      error: `JSON.parse: ${errorMessage(e)}`,
      rawSnippet: takeSnippet(raw),
    };
  }

  let outcome: Outcome;
  try {
    outcome = parseOutcome(parsedJson, {
      repoRoot: config.repoRoot,
      skipCommitValidation: config.skipCommitValidation,
    });
  } catch (e) {
    const err = e instanceof Error ? e : new Error(errorMessage(e));
    return {
      ...base,
      category: categorize(err, parsedJson),
      error: err.message,
      rawSnippet: takeSnippet(raw),
    };
  }

  const reclassified = reclassifyOutcome(outcome);
  let category: CanaryCategory;
  if (outcome.outcome === 'plan_created' && outcome.is_bug === undefined) {
    category = 'pass_warn';
  } else if (reclassified.outcome !== outcome.outcome) {
    category = 'pass_reclassified';
  } else {
    category = 'pass_unchanged';
  }

  return { ...base, category, outcomeKind: outcome.outcome };
}

// ---------------------------------------------------------------------------
// determineVerdict
// ---------------------------------------------------------------------------

export function determineVerdict(rows: ReplayRow[]): StoplightVerdict {
  const productionWording: CanaryCategory[] = [
    'fail_parse_bad_discriminator',
    'fail_parse_missing_required_field',
    'fail_parse_plan_file_literal',
    'fail_parse_commit_not_in_repo',
  ];
  const failures = rows.filter((r) => r.category.startsWith('fail_parse_'));
  if (failures.some((r) => productionWording.includes(r.category))) {
    return 'red';
  }
  if (failures.length === 0) {
    return 'green';
  }
  if (failures.length <= 3) {
    return 'yellow';
  }
  return 'red';
}

// ---------------------------------------------------------------------------
// renderReport
// ---------------------------------------------------------------------------

const CATEGORY_ORDER: CanaryCategory[] = [
  'pass_unchanged',
  'pass_warn',
  'pass_reclassified',
  'fail_parse_bad_discriminator',
  'fail_parse_missing_required_field',
  'fail_parse_plan_file_literal',
  'fail_parse_commit_not_in_repo',
  'fail_parse_long_text_overflow',
  'fail_parse_other',
  'artifact_missing',
  'artifact_unreadable',
];

const CATEGORY_LABELS: Record<CanaryCategory, string> = {
  pass_unchanged: 'pass_unchanged',
  pass_warn: 'pass_warn (is_bug missing)',
  pass_reclassified: 'pass_reclassified (plan_created → not_a_bug)',
  fail_parse_bad_discriminator: 'fail_parse_bad_discriminator',
  fail_parse_missing_required_field: 'fail_parse_missing_required_field',
  fail_parse_plan_file_literal: 'fail_parse_plan_file_literal',
  fail_parse_commit_not_in_repo: 'fail_parse_commit_not_in_repo',
  fail_parse_long_text_overflow: 'fail_parse_long_text_overflow',
  fail_parse_other: 'fail_parse_other',
  artifact_missing: 'artifact_missing',
  artifact_unreadable: 'artifact_unreadable',
};

const VERDICT_EMOJI: Record<StoplightVerdict, string> = {
  green: ':large_green_circle:',
  yellow: ':large_yellow_circle:',
  red: ':large_red_circle:',
};

const VERDICT_HEADLINE: Record<StoplightVerdict, string> = {
  green: 'GREEN — safe to enforce schema',
  yellow: 'YELLOW — proceed with operator awareness',
  red: 'RED — halt deploy; refine schema or prompt',
};

const VERDICT_RATIONALE: Record<StoplightVerdict, string> = {
  green:
    '0 parse failures across the replay window. Schema is safe to ship as parse-failure-terminal immediately.',
  yellow:
    '1–3 parse failures, none in current production-wording categories. Schema is safe to ship in **parse-only-with-warn mode** for the 3-day soak period; flip to terminal after soak.',
  red:
    '>3 failures OR ≥1 failure in a current production-wording category. Halt deploy until the schema or prompt is refined.',
};

function renderSnippetBlock(snippet: string | undefined): string {
  if (!snippet) {
    return '';
  }
  const lang = snippet.trimStart().startsWith('{') || snippet.trimStart().startsWith('[') ? 'json' : 'text';
  if (snippet.includes('```')) {
    return `- **Raw snippet**:\n  <pre>${snippet.replace(/&/g, '&amp;').replace(/</g, '&lt;')}</pre>`;
  }
  return `- **Raw snippet**:\n  \`\`\`${lang}\n${snippet}\n\`\`\``;
}

function renderSampleFailures(rows: ReplayRow[]): string {
  const failureCategories: CanaryCategory[] = [
    'fail_parse_bad_discriminator',
    'fail_parse_missing_required_field',
    'fail_parse_plan_file_literal',
    'fail_parse_commit_not_in_repo',
    'fail_parse_long_text_overflow',
    'fail_parse_other',
  ];

  const sections: string[] = [];
  for (const cat of failureCategories) {
    const matching = rows.filter((r) => r.category === cat);
    if (matching.length === 0) {
      continue;
    }
    sections.push(`### ${cat} (${matching.length})`);
    const sample = matching.slice(0, 5);
    for (const r of sample) {
      sections.push('');
      sections.push(`#### ${r.sentryId} — ${r.completedAt}`);
      sections.push(`- **Artifact**: \`${r.artifactPath}\``);
      sections.push(`- **Error**: \`${r.error ?? ''}\``);
      const snippet = renderSnippetBlock(r.rawSnippet);
      if (snippet) {
        sections.push(snippet);
      }
    }
    sections.push('');
  }

  if (sections.length === 0) {
    return '_No parse failures._';
  }
  return sections.join('\n');
}

function renderArtifactSection(rows: ReplayRow[]): string {
  const missing = rows.filter((r) => r.category === 'artifact_missing');
  const unreadable = rows.filter((r) => r.category === 'artifact_unreadable');
  if (missing.length === 0 && unreadable.length === 0) {
    return '';
  }

  const parts: string[] = ['## Artifact retention notes', ''];
  if (missing.length > 0) {
    parts.push(`### artifact_missing (${missing.length})`);
    parts.push('');
    parts.push('| Sentry ID | Completed at | Artifact path |');
    parts.push('|---|---|---|');
    for (const r of missing.slice(0, 20)) {
      parts.push(`| ${r.sentryId} | ${r.completedAt} | \`${r.artifactPath}\` |`);
    }
    if (missing.length > 20) {
      parts.push(`| _…and ${missing.length - 20} more_ | | |`);
    }
    parts.push('');
  }
  if (unreadable.length > 0) {
    parts.push(`### artifact_unreadable (${unreadable.length})`);
    parts.push('');
    parts.push('| Sentry ID | Completed at | Artifact path | Error |');
    parts.push('|---|---|---|---|');
    for (const r of unreadable.slice(0, 20)) {
      parts.push(`| ${r.sentryId} | ${r.completedAt} | \`${r.artifactPath}\` | \`${r.error ?? ''}\` |`);
    }
    if (unreadable.length > 20) {
      parts.push(`| _…and ${unreadable.length - 20} more_ | | | |`);
    }
    parts.push('');
  }
  parts.push(
    'These rows reflect operator-side artifact-retention gaps, not schema misfits. They are **not** counted toward the verdict.',
  );
  parts.push('');
  return parts.join('\n');
}

export function renderReport(args: CanaryArgs, rows: ReplayRow[], verdict: StoplightVerdict): string {
  const total = rows.length;
  const counts = new Map<CanaryCategory, number>();
  for (const cat of CATEGORY_ORDER) {
    counts.set(cat, 0);
  }
  for (const r of rows) {
    counts.set(r.category, (counts.get(r.category) ?? 0) + 1);
  }

  const pct = (n: number): string => (total === 0 ? '0.0%' : `${((n / total) * 100).toFixed(1)}%`);

  const summaryRows = CATEGORY_ORDER.map((cat) => {
    const n = counts.get(cat) ?? 0;
    const label = CATEGORY_LABELS[cat];
    const bolded = cat.startsWith('fail_parse_') && n > 0 ? `**${label}**` : label;
    return `| ${bolded} | ${n} | ${pct(n)} |`;
  });

  const out: string[] = [];
  out.push('# Sentry Autopilot Offline-Replay Canary Report');
  out.push('');
  out.push(`**Run timestamp**: ${new Date().toISOString()}`);
  out.push(`**State DB**: \`${args.stateDb}\``);
  out.push(`**Artifacts root**: \`${args.artifactsRoot}\``);
  out.push(`**Since**: ${args.since} (UTC)`);
  out.push(`**Repo root**: \`${args.repoRoot}\``);
  out.push(`**Skip commit validation**: \`${args.skipCommitValidation}\``);
  out.push(`**Limit**: ${args.limit}`);
  out.push('');
  out.push(`## Verdict: ${VERDICT_EMOJI[verdict]} ${VERDICT_HEADLINE[verdict]}`);
  out.push('');
  out.push(`> ${VERDICT_RATIONALE[verdict]}`);
  out.push('');
  out.push('## Summary');
  out.push('');
  out.push('| Category | Count | % of replayed |');
  out.push('|---|---:|---:|');
  out.push(...summaryRows);
  out.push(`| **Total replayed** | **${total}** | 100.0% |`);
  out.push('');
  out.push('## Sample failures');
  out.push('');
  out.push(renderSampleFailures(rows));

  const artifactSection = renderArtifactSection(rows);
  if (artifactSection) {
    out.push(artifactSection);
  }

  out.push('## Notes');
  out.push('');
  if (args.skipCommitValidation) {
    out.push(
      '- **Commit verification was skipped** (`--skip-commit-validation`). `auto_committed` outcomes were parsed without the `git cat-file -e <hash>^{commit}` runtime invariant. To re-verify, scp the historical worktree-side commits into a clone and re-run without the flag.',
    );
  } else {
    out.push(
      '- **Commit verification was active** for `auto_committed` outcomes. `commit_hash` was validated against `--repo-root` via `git cat-file -e <hash>^{commit}`.',
    );
  }
  out.push(
    "- **Replay fidelity**: the canary's parse path is byte-for-byte identical to production `harvestOutcome` (see `session-manager.ts` lines 357–361), modulo the `--skip-commit-validation` divergence flagged above.",
  );
  out.push('- **Stoplight protocol**:');
  out.push('  - **Green** → ship parse-failure-as-terminal immediately');
  out.push('  - **Yellow** → ship parse-only-with-warn for 3 days, then flip');
  out.push('  - **Red** → halt deploy; refine schema or prompt');
  out.push('');
  out.push('---');
  out.push('*Generated by `scripts/sentry-autopilot/canary/offline-replay.ts`.*');
  out.push('');
  return out.join('\n');
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

function usageError(message: string): number {
  process.stderr.write(`Error: ${message}\n\n`);
  process.stderr.write(HELP_TEXT);
  return 64;
}

function exitCodeFor(verdict: StoplightVerdict): number {
  if (verdict === 'green') return 0;
  if (verdict === 'yellow') return 1;
  return 2;
}

export function main(argv: string[]): number {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      options: {
        'state-db': { type: 'string' },
        'artifacts-root': { type: 'string' },
        since: { type: 'string' },
        'report-out': { type: 'string' },
        'skip-commit-validation': { type: 'boolean', default: false },
        'repo-root': { type: 'string' },
        limit: { type: 'string' },
        help: { type: 'boolean', default: false },
      },
      strict: true,
      allowPositionals: false,
    });
  } catch (e) {
    return usageError(errorMessage(e));
  }

  const values = parsed.values;

  if (values.help) {
    process.stdout.write(HELP_TEXT);
    return 0;
  }

  const stateDb = values['state-db'];
  const artifactsRoot = values['artifacts-root'];
  const since = values.since;
  const reportOut = values['report-out'];

  if (!stateDb) return usageError('--state-db is required');
  if (!artifactsRoot) return usageError('--artifacts-root is required');
  if (!since) return usageError('--since is required');
  if (!reportOut) return usageError('--report-out is required');

  if (!/^\d{4}-\d{2}-\d{2}$/.test(since)) {
    return usageError(`--since must match yyyy-mm-dd; got "${since}"`);
  }

  const limitStr = values.limit ?? '10000';
  const limit = Number.parseInt(limitStr, 10);
  if (!Number.isFinite(limit) || limit <= 0 || String(limit) !== limitStr) {
    return usageError(`--limit must be a positive integer; got "${limitStr}"`);
  }

  try {
    fs.accessSync(stateDb, fs.constants.R_OK);
  } catch {
    return usageError(`--state-db is not readable: ${stateDb}`);
  }

  let artifactsRootStat;
  try {
    artifactsRootStat = fs.statSync(artifactsRoot);
  } catch {
    return usageError(`--artifacts-root does not exist: ${artifactsRoot}`);
  }
  if (!artifactsRootStat.isDirectory()) {
    return usageError(`--artifacts-root is not a directory: ${artifactsRoot}`);
  }

  const repoRoot = values['repo-root'] ?? process.cwd();
  const skipCommitValidation = values['skip-commit-validation'] ?? false;

  const args: CanaryArgs = {
    stateDb,
    artifactsRoot,
    since,
    reportOut,
    skipCommitValidation,
    repoRoot,
    limit,
  };

  let rows: IssueIndexRow[];
  try {
    rows = loadIssueIndex(stateDb, since, limit);
  } catch (e) {
    process.stderr.write(`Error: failed to load issue index: ${errorMessage(e)}\n`);
    return 64;
  }

  const results: ReplayRow[] = rows.map((row) =>
    replayOne(row, artifactsRoot, { repoRoot, skipCommitValidation }),
  );

  const verdict = determineVerdict(results);
  const report = renderReport(args, results, verdict);

  fs.mkdirSync(path.dirname(path.resolve(reportOut)), { recursive: true });
  fs.writeFileSync(reportOut, report);

  const passCount = results.filter((r) => r.category.startsWith('pass_')).length;
  const failCount = results.filter((r) => r.category.startsWith('fail_parse_')).length;
  const missingCount = results.filter(
    (r) => r.category === 'artifact_missing' || r.category === 'artifact_unreadable',
  ).length;
  process.stdout.write(
    `Canary: ${verdict} — ${results.length} issues, ${passCount} ok, ${failCount} fail, ${missingCount} artifact-missing\n`,
  );

  return exitCodeFor(verdict);
}

// ---------------------------------------------------------------------------
// CLI shim
// ---------------------------------------------------------------------------

if (import.meta.url === `file://${process.argv[1]}`) {
  process.exit(main(process.argv.slice(2)));
}
