#!/usr/bin/env npx tsx
/**
 * Deferred-cleanup ledger manager.
 *
 * Replaces the old per-push `check-cleanup-deadline` hard gate (which blocked
 * every developer's push for one owner's one-off cut-over, and in practice just
 * trained people to bump the date to unblock). Instead, deferred cleanup lives
 * in an append-friendly NDJSON ledger that is REVIEWED during the periodic Code
 * Health sweep — see docs/project/CODE_HEALTH_TOOLS.md. This script is the
 * read/write/validate helper, NOT a push gate; its only always-on guard is the
 * schema test (scripts/__tests__/deferred-cleanup.test.ts), which validates the
 * committed ledger so an agent can't corrupt the file.
 *
 * Each line of the ledger is one current-state record (with an embedded
 * `history` array of defer/done events) so the file is trivial to trawl:
 *   jq -c 'select(.status=="open")' docs/project/deferred-cleanup.ndjson
 *
 * Subcommands:
 *   add     --id --title --owner --deadline --plan --ease --value
 *           [--description --branch --commit --pr --link <repeatable>
 *            --tag <repeatable> --note]
 *   defer   --id --deadline --reason [--note]
 *   done    --id [--reason]
 *   note    --id --reason
 *   list    [--overdue] [--soon <days>] [--all] [--json] [--today YYYY-MM-DD]
 *   validate
 *
 * Run: npx tsx scripts/deferred-cleanup.ts <subcommand> [flags]
 * @see docs/project/CODE_HEALTH_TOOLS.md (periodic review step)
 */

import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';

export const DEFAULT_LEDGER_PATH = path.resolve(
  process.cwd(),
  'docs/project/deferred-cleanup.ndjson',
);

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const DEFAULT_SOON_DAYS = 7;

const isoDate = z
  .string()
  .regex(ISO_DATE, 'expected YYYY-MM-DD')
  .refine((s) => !Number.isNaN(new Date(`${s}T00:00:00Z`).getTime()), 'unparseable calendar date');

export const EaseSchema = z.enum(['trivial', 'easy', 'medium', 'hard']);
export const ValueSchema = z.enum(['low', 'medium', 'high']);

export const HistoryEntrySchema = z
  .object({
    ts: isoDate,
    action: z.enum(['created', 'deferred', 'done', 'note']),
    deadline: isoDate.optional(),
    reason: z.string().min(1).optional(),
  })
  .strict();

export const ProvenanceSchema = z
  .object({
    /** Where to find the full story — the plan/PLAN.md the cleanup was deferred from. Required. */
    plan: z.string().min(1),
    branch: z.string().min(1).optional(),
    commit: z.string().min(1).optional(),
    pr: z.string().min(1).optional(),
    links: z.array(z.string().min(1)).optional(),
    notes: z.string().min(1).optional(),
  })
  .strict();

export const CleanupRecordSchema = z
  .object({
    id: z.string().regex(/^[a-z0-9][a-z0-9-]*$/, 'id must be kebab-case'),
    title: z.string().min(1),
    description: z.string().min(1).optional(),
    owner: z.string().min(1),
    status: z.enum(['open', 'done']),
    created: isoDate,
    deadline: isoDate,
    ease: EaseSchema,
    value: ValueSchema,
    provenance: ProvenanceSchema,
    tags: z.array(z.string().min(1)).optional(),
    history: z.array(HistoryEntrySchema).min(1),
  })
  .strict();

export type CleanupRecord = z.infer<typeof CleanupRecordSchema>;

/** Canonical key order so rewrites produce clean diffs. */
const KEY_ORDER: (keyof CleanupRecord)[] = [
  'id',
  'title',
  'description',
  'owner',
  'status',
  'created',
  'deadline',
  'ease',
  'value',
  'provenance',
  'tags',
  'history',
];

export function serializeRecord(record: CleanupRecord): string {
  const ordered: Record<string, unknown> = {};
  for (const key of KEY_ORDER) {
    if (record[key] !== undefined) ordered[key] = record[key];
  }
  return JSON.stringify(ordered);
}

export interface ParseResult {
  records: CleanupRecord[];
  errors: string[];
}

/** Parse NDJSON text into validated records, collecting per-line errors. */
export function parseLedger(text: string): ParseResult {
  const records: CleanupRecord[] = [];
  const errors: string[] = [];
  const lines = text.split('\n');
  const seen = new Set<string>();
  lines.forEach((line, i) => {
    const trimmed = line.trim();
    if (trimmed === '') return;
    let raw: unknown;
    try {
      raw = JSON.parse(trimmed);
    } catch {
      errors.push(`line ${i + 1}: invalid JSON`);
      return;
    }
    const parsed = CleanupRecordSchema.safeParse(raw);
    if (!parsed.success) {
      const issues = parsed.error.issues
        .map((iss) => `${iss.path.join('.') || '(root)'}: ${iss.message}`)
        .join('; ');
      errors.push(`line ${i + 1}: ${issues}`);
      return;
    }
    if (seen.has(parsed.data.id)) {
      errors.push(`line ${i + 1}: duplicate id "${parsed.data.id}"`);
      return;
    }
    seen.add(parsed.data.id);
    records.push(parsed.data);
  });
  return { records, errors };
}

export function loadLedger(ledgerPath: string): ParseResult {
  if (!fs.existsSync(ledgerPath)) return { records: [], errors: [] };
  return parseLedger(fs.readFileSync(ledgerPath, 'utf8'));
}

export function writeLedger(ledgerPath: string, records: CleanupRecord[]): void {
  const body = records.map(serializeRecord).join('\n');
  fs.writeFileSync(ledgerPath, records.length ? `${body}\n` : '', 'utf8');
}

function daysUntil(deadline: string, today: string): number {
  const d = new Date(`${deadline}T00:00:00Z`).getTime();
  const t = new Date(`${today}T00:00:00Z`).getTime();
  return Math.floor((d - t) / 86_400_000);
}

export interface ListBuckets {
  overdue: CleanupRecord[];
  soon: CleanupRecord[];
  later: CleanupRecord[];
  done: CleanupRecord[];
}

const VALUE_RANK = { high: 0, medium: 1, low: 2 } as const;
const EASE_RANK = { trivial: 0, easy: 1, medium: 2, hard: 3 } as const;

/** Sort high-value / low-effort to the top, then by soonest deadline. */
function byPriority(a: CleanupRecord, b: CleanupRecord): number {
  return (
    VALUE_RANK[a.value] - VALUE_RANK[b.value] ||
    EASE_RANK[a.ease] - EASE_RANK[b.ease] ||
    a.deadline.localeCompare(b.deadline)
  );
}

export function bucketize(records: CleanupRecord[], today: string, soonDays: number): ListBuckets {
  const open = records.filter((r) => r.status === 'open');
  const overdue: CleanupRecord[] = [];
  const soon: CleanupRecord[] = [];
  const later: CleanupRecord[] = [];
  for (const r of open) {
    const dd = daysUntil(r.deadline, today);
    if (dd <= 0) overdue.push(r);
    else if (dd <= soonDays) soon.push(r);
    else later.push(r);
  }
  return {
    overdue: overdue.sort(byPriority),
    soon: soon.sort(byPriority),
    later: later.sort(byPriority),
    done: records.filter((r) => r.status === 'done'),
  };
}

// --------------------------------------------------------------------------
// Mutations
// --------------------------------------------------------------------------

export interface AddInput {
  id: string;
  title: string;
  owner: string;
  deadline: string;
  plan: string;
  ease: z.infer<typeof EaseSchema>;
  value: z.infer<typeof ValueSchema>;
  description?: string;
  branch?: string;
  commit?: string;
  pr?: string;
  links?: string[];
  tags?: string[];
  note?: string;
  today: string;
}

export function applyAdd(records: CleanupRecord[], input: AddInput): CleanupRecord[] {
  if (records.some((r) => r.id === input.id)) {
    throw new Error(`id "${input.id}" already exists`);
  }
  const provenance: z.infer<typeof ProvenanceSchema> = { plan: input.plan };
  if (input.branch) provenance.branch = input.branch;
  if (input.commit) provenance.commit = input.commit;
  if (input.pr) provenance.pr = input.pr;
  if (input.links?.length) provenance.links = input.links;
  if (input.note) provenance.notes = input.note;

  const record: CleanupRecord = {
    id: input.id,
    title: input.title,
    ...(input.description ? { description: input.description } : {}),
    owner: input.owner,
    status: 'open',
    created: input.today,
    deadline: input.deadline,
    ease: input.ease,
    value: input.value,
    provenance,
    ...(input.tags?.length ? { tags: input.tags } : {}),
    history: [
      {
        ts: input.today,
        action: 'created',
        deadline: input.deadline,
        ...(input.note ? { reason: input.note } : {}),
      },
    ],
  };
  return [...records, CleanupRecordSchema.parse(record)];
}

function mutate(records: CleanupRecord[], id: string, fn: (r: CleanupRecord) => CleanupRecord): CleanupRecord[] {
  const idx = records.findIndex((r) => r.id === id);
  if (idx === -1) throw new Error(`unknown id "${id}"`);
  const next = records.slice();
  next[idx] = CleanupRecordSchema.parse(fn(records[idx]));
  return next;
}

export function applyDefer(
  records: CleanupRecord[],
  id: string,
  newDeadline: string,
  reason: string,
  today: string,
): CleanupRecord[] {
  return mutate(records, id, (r) => ({
    ...r,
    deadline: newDeadline,
    history: [...r.history, { ts: today, action: 'deferred', deadline: newDeadline, reason }],
  }));
}

export function applyDone(records: CleanupRecord[], id: string, today: string, reason?: string): CleanupRecord[] {
  return mutate(records, id, (r) => ({
    ...r,
    status: 'done',
    history: [...r.history, { ts: today, action: 'done', ...(reason ? { reason } : {}) }],
  }));
}

export function applyNote(records: CleanupRecord[], id: string, reason: string, today: string): CleanupRecord[] {
  return mutate(records, id, (r) => ({
    ...r,
    history: [...r.history, { ts: today, action: 'note', reason }],
  }));
}

// --------------------------------------------------------------------------
// CLI
// --------------------------------------------------------------------------

interface Flags {
  positional: string[];
  options: Record<string, string | string[] | boolean>;
}

function parseArgs(argv: string[]): Flags {
  const positional: string[] = [];
  const options: Record<string, string | string[] | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith('--')) {
      positional.push(arg);
      continue;
    }
    const key = arg.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) {
      options[key] = true;
      continue;
    }
    i++;
    // repeatable flags accumulate into an array
    if (key === 'link' || key === 'tag') {
      const existing = options[key];
      options[key] = Array.isArray(existing) ? [...existing, next] : [next];
    } else {
      options[key] = next;
    }
  }
  return { positional, options };
}

function req(options: Flags['options'], key: string): string {
  const v = options[key];
  if (typeof v !== 'string' || v.length === 0) throw new Error(`missing required flag --${key}`);
  return v;
}

function asArray(v: string | string[] | boolean | undefined): string[] | undefined {
  if (v === undefined || typeof v === 'boolean') return undefined;
  return Array.isArray(v) ? v : [v];
}

function todayUtc(): string {
  return new Date().toISOString().slice(0, 10);
}

function fmtRecord(r: CleanupRecord, today: string): string {
  const dd = daysUntil(r.deadline, today);
  const when = dd < 0 ? `${-dd}d overdue` : dd === 0 ? 'due today' : `in ${dd}d`;
  const tags = r.tags?.length ? ` [${r.tags.join(', ')}]` : '';
  return (
    `  • ${r.id} — ${r.title}\n` +
    `      deadline ${r.deadline} (${when}) · owner ${r.owner} · value ${r.value} · ease ${r.ease}${tags}\n` +
    `      see ${r.provenance.plan}`
  );
}

function runCli(argv: string[]): number {
  const { positional, options } = parseArgs(argv);
  const subcommand = positional[0];
  const ledgerPath =
    typeof options.ledger === 'string' ? path.resolve(process.cwd(), options.ledger) : DEFAULT_LEDGER_PATH;
  const today = typeof options.today === 'string' ? options.today : todayUtc();

  if (!subcommand || options.help) {
    console.log(
      'Usage: deferred-cleanup <add|defer|done|note|list|validate> [flags]\n' +
        'See the file header for full flag docs.',
    );
    return subcommand ? 0 : 1;
  }

  if (subcommand === 'validate') {
    const { errors } = loadLedger(ledgerPath);
    if (errors.length) {
      console.error(`[deferred-cleanup] ${errors.length} invalid record(s) in ${ledgerPath}:`);
      for (const e of errors) console.error(`  - ${e}`);
      return 1;
    }
    console.log(`[deferred-cleanup] ledger valid: ${ledgerPath}`);
    return 0;
  }

  const { records, errors } = loadLedger(ledgerPath);
  if (errors.length && subcommand !== 'list') {
    console.error(`[deferred-cleanup] refusing to mutate an invalid ledger; run "validate" first:`);
    for (const e of errors) console.error(`  - ${e}`);
    return 1;
  }

  if (subcommand === 'list') {
    const soonDays = typeof options.soon === 'string' ? Number(options.soon) : DEFAULT_SOON_DAYS;
    const buckets = bucketize(records, today, soonDays);
    const overdueOnly = options.overdue === true;
    const wantJson = options.json === true;

    if (wantJson) {
      const out = overdueOnly
        ? buckets.overdue
        : options.all === true
          ? records
          : [...buckets.overdue, ...buckets.soon, ...buckets.later];
      console.log(JSON.stringify(out));
      return overdueOnly && buckets.overdue.length ? 2 : 0;
    }

    if (errors.length) {
      console.error(`[deferred-cleanup] WARNING: ${errors.length} invalid record(s) skipped (run "validate")`);
    }
    if (buckets.overdue.length) {
      console.log(`OVERDUE (${buckets.overdue.length}) — execute the cut-over or re-defer with rationale:`);
      for (const r of buckets.overdue) console.log(fmtRecord(r, today));
    }
    if (!overdueOnly) {
      if (buckets.soon.length) {
        console.log(`\nDUE SOON (${buckets.soon.length}):`);
        for (const r of buckets.soon) console.log(fmtRecord(r, today));
      }
      if (buckets.later.length && options.all === true) {
        console.log(`\nLATER (${buckets.later.length}):`);
        for (const r of buckets.later) console.log(fmtRecord(r, today));
      }
      if (options.all === true && buckets.done.length) {
        console.log(`\nDONE (${buckets.done.length}):`);
        for (const r of buckets.done) console.log(`  • ${r.id} — ${r.title}`);
      }
    }
    if (!buckets.overdue.length && !buckets.soon.length && !(options.all === true && buckets.later.length)) {
      console.log('No deferred-cleanup items due or overdue.');
    }
    // Non-zero on overdue so a periodic CI cron (if ever wired) can go red.
    return buckets.overdue.length ? 2 : 0;
  }

  let next: CleanupRecord[];
  switch (subcommand) {
    case 'add':
      next = applyAdd(records, {
        id: req(options, 'id'),
        title: req(options, 'title'),
        owner: req(options, 'owner'),
        deadline: req(options, 'deadline'),
        plan: req(options, 'plan'),
        ease: EaseSchema.parse(req(options, 'ease')),
        value: ValueSchema.parse(req(options, 'value')),
        description: typeof options.description === 'string' ? options.description : undefined,
        branch: typeof options.branch === 'string' ? options.branch : undefined,
        commit: typeof options.commit === 'string' ? options.commit : undefined,
        pr: typeof options.pr === 'string' ? options.pr : undefined,
        links: asArray(options.link),
        tags: asArray(options.tag),
        note: typeof options.note === 'string' ? options.note : undefined,
        today,
      });
      break;
    case 'defer':
      next = applyDefer(records, req(options, 'id'), req(options, 'deadline'), req(options, 'reason'), today);
      break;
    case 'done':
      next = applyDone(records, req(options, 'id'), today, typeof options.reason === 'string' ? options.reason : undefined);
      break;
    case 'note':
      next = applyNote(records, req(options, 'id'), req(options, 'reason'), today);
      break;
    default:
      console.error(`[deferred-cleanup] unknown subcommand "${subcommand}"`);
      return 1;
  }
  writeLedger(ledgerPath, next);
  console.log(`[deferred-cleanup] ${subcommand} ok — ${ledgerPath}`);
  return 0;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    process.exit(runCli(process.argv.slice(2)));
  } catch (err) {
    console.error(`[deferred-cleanup] ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}
