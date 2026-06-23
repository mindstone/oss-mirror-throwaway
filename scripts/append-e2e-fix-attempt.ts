/**
 * Append a structured entry to the E2E fix-attempt log.
 *
 * Why this exists
 * ---------------
 * `docs/project/WHY_E2E_TESTS_ARE_HARD_TO_FIX.md` used to carry every fix attempt as a
 * verbose prose entry; the section grew to ~1.4k lines and buried the durable, reusable
 * content (TL;DR + Known Hard Problems). The per-attempt log now lives as terse NDJSON in
 * `docs/project/e2e_fix_attempts.ndjson` (full original prose is in git history). This script
 * is the sanctioned way to append a new record so the format stays consistent and the log
 * stays low-friction to keep up to date.
 *
 * Usage:
 *   # individual flags (date defaults to today):
 *   npx tsx scripts/append-e2e-fix-attempt.ts \
 *     --title "Short title" --outcome PARTIAL \
 *     --symptom "what failed" --fix "what was tried" --insight "key lesson"
 *
 *   # or pass a JSON object (fields below); n/date are filled if omitted:
 *   npx tsx scripts/append-e2e-fix-attempt.ts --json '{"title":"...","outcome":"SUCCESS","insight":"..."}'
 *
 *   # view the most recent entries (default 5):
 *   npx tsx scripts/append-e2e-fix-attempt.ts --list 8
 *
 * Outcome must be one of: SUCCESS | PARTIAL | FAILED | SUPERSEDED | PENDING | INVESTIGATION.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LOG_PATH = path.join(ROOT, 'docs', 'project', 'e2e_fix_attempts.ndjson');

const OUTCOMES = ['SUCCESS', 'PARTIAL', 'FAILED', 'SUPERSEDED', 'PENDING', 'INVESTIGATION'] as const;
type Outcome = (typeof OUTCOMES)[number];

export interface FixAttempt {
  n: number;
  date: string;
  title: string;
  symptom?: string;
  fix?: string;
  outcome: Outcome;
  insight?: string;
  files?: string[];
  planning_doc?: string;
}

export function readLog(logPath = LOG_PATH): FixAttempt[] {
  if (!existsSync(logPath)) return [];
  return readFileSync(logPath, 'utf8')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as FixAttempt);
}

export function nextN(entries: readonly FixAttempt[]): number {
  return entries.reduce((max, e) => Math.max(max, e.n), 0) + 1;
}

/** Serialize one record with a stable key order so the file reads consistently. */
export function serializeEntry(e: FixAttempt): string {
  const ordered: Record<string, unknown> = {
    n: e.n,
    date: e.date,
    title: e.title,
    symptom: e.symptom,
    fix: e.fix,
    outcome: e.outcome,
    insight: e.insight,
    files: e.files,
    planning_doc: e.planning_doc,
  };
  for (const key of Object.keys(ordered)) {
    if (ordered[key] === undefined) delete ordered[key];
  }
  return JSON.stringify(ordered);
}

function parseArgs(argv: readonly string[]): Map<string, string> {
  const out = new Map<string, string>();
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg.startsWith('--')) {
      const key = arg.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--')) {
        out.set(key, next);
        i += 1;
      } else {
        out.set(key, 'true');
      }
    }
  }
  return out;
}

function todayIso(): string {
  // Local date as YYYY-MM-DD. Date.now() is fine in a normal CLI script (only Workflow
  // scripts forbid it). Kept simple — month/day granularity matches existing entries.
  const d = new Date();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${mm}-${dd}`;
}

function buildEntry(args: Map<string, string>, existing: readonly FixAttempt[]): FixAttempt {
  let fields: Partial<FixAttempt> = {};
  const json = args.get('json');
  if (json !== undefined && json !== 'true') {
    fields = JSON.parse(json) as Partial<FixAttempt>;
  } else {
    const files = args.get('files');
    fields = {
      title: args.get('title'),
      symptom: args.get('symptom'),
      fix: args.get('fix'),
      outcome: args.get('outcome') as Outcome | undefined,
      insight: args.get('insight'),
      planning_doc: args.get('planning_doc'),
      files: files ? files.split(',').map((f) => f.trim()).filter(Boolean) : undefined,
    };
  }

  if (!fields.title || fields.title.trim().length === 0) {
    throw new Error('Missing required field: title (--title or json.title)');
  }
  if (!fields.outcome || !OUTCOMES.includes(fields.outcome)) {
    throw new Error(`Missing/invalid outcome — must be one of: ${OUTCOMES.join(' | ')}`);
  }

  return {
    n: typeof fields.n === 'number' ? fields.n : nextN(existing),
    date: fields.date ?? todayIso(),
    title: fields.title.trim(),
    symptom: fields.symptom,
    fix: fields.fix,
    outcome: fields.outcome,
    insight: fields.insight,
    files: fields.files,
    planning_doc: fields.planning_doc,
  };
}

export function main(argv: readonly string[], logPath = LOG_PATH): number {
  const args = parseArgs(argv);
  const entries = readLog(logPath);

  const listArg = args.get('list');
  if (listArg !== undefined) {
    const count = listArg === 'true' ? 5 : Math.max(1, Number.parseInt(listArg, 10) || 5);
    for (const e of entries.slice(-count)) {
      process.stdout.write(`#${e.n} (${e.date}) [${e.outcome}] ${e.title}\n`);
      if (e.insight) process.stdout.write(`    insight: ${e.insight}\n`);
    }
    return 0;
  }

  const entry = buildEntry(args, entries);
  const needsLeadingNewline = existsSync(logPath) && !readFileSync(logPath, 'utf8').endsWith('\n');
  const line = `${needsLeadingNewline ? '\n' : ''}${serializeEntry(entry)}\n`;
  writeFileSync(logPath, line, { flag: 'a' });
  process.stdout.write(`Appended #${entry.n} (${entry.date}) [${entry.outcome}] ${entry.title}\n`);
  return 0;
}

const invokedDirectly = process.argv[1] === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  try {
    process.exit(main(process.argv.slice(2)));
  } catch (err) {
    process.stderr.write(`[append-e2e-fix-attempt] ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  }
}
