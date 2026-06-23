#!/usr/bin/env npx tsx
/**
 * Batch triage pipeline for the postmortem-recommendations live queue
 * (Stage 5/6/7 mechanical pipeline of docs/plans/260611_recs-triage-system).
 *
 * Three subcommands — the no-hand-paste contract between LLM verdict batches
 * (Composer 2.5 via coding-agent-instructions/scripts/run-cursor.ts) and the
 * committed overrides file:
 *
 *   emit --kind type-routing [--batch-size 60] --out-dir <dir>
 *     Reads the generated index (regenerating it first if missing), selects
 *     open non-quarantined rows whose action_type is in the type-routing pool
 *     (review_focus | agent_instructions | workflow_improvement), orders them
 *     deterministically (first_recorded desc, bug_id, fingerprint — same as
 *     the index), chunks into batches, and writes per-batch input JSON files
 *     plus a manifest.json.
 *
 *   validate [--batch-input <file>] --verdicts <file>
 *     Verdict files are JSON: { batch_id, verdicts: [{ fingerprint, verdict:
 *     'absorb'|'wont-do'|'keep-open'|'implemented'|'rejected', target_doc?,
 *     principle_text?, reason?, evidence?, rejection_reason?, reason_kind? }] }.
 *     Checks: batch_id match; every input fingerprint verdicted exactly once;
 *     no extra/duplicate fingerprints; fingerprints exist in the live index;
 *     absorb requires target_doc + principle_text; wont-do requires reason;
 *     rejected requires rejection_reason + a typed reason_kind; implemented
 *     allows an optional evidence string (preserved as the entry's context
 *     comment); no existing override entry would be overwritten. Exit non-zero
 *     with precise per-fingerprint errors.
 *
 *     --batch-input is OPTIONAL (verdicts-only mode, added for the weekly
 *     scan-verify-close lane whose batches are researcher-produced rather than
 *     emitted): without it the verdict file itself defines the scope, so the
 *     batch-membership checks (batch_id match, extra/missing fingerprint) are
 *     skipped while every per-verdict check (live-index existence, duplicates,
 *     required metadata, overwrite guard) still runs.
 *
 *   apply [--batch-input <file>] --verdicts <file> [--require-validated] [--date YYMMDD]
 *     Re-runs the FULL validation internally (apply refuses to write anything
 *     when validation fails — --require-validated is the always-on default and
 *     is accepted for interface clarity). Appends override entries to
 *     docs-private/postmortems/_recommendations_overrides.yaml:
 *       absorb      -> status: absorbed, absorbed_into: <target_doc>,
 *                      last_revisited: <date> (+ principle_text preserved in
 *                      the entry's context comment — see note below)
 *       wont-do     -> status: wont-do, rejection_reason: <reason>,
 *                      reason_kind when inferable, last_revisited: <date>
 *       implemented -> status: implemented, last_revisited: <date>
 *                      (+ evidence preserved in the entry's context comment)
 *       rejected    -> status: rejected, rejection_reason, reason_kind
 *                      (explicit, never inferred), last_revisited: <date>
 *       keep-open   -> NO entry (the default state writes nothing)
 *     Then regenerates the index and runs the parity validation, failing loud
 *     (and restoring the previous overrides file) on any error.
 *
 *     Apply stays APPEND-ONLY by design: a fingerprint that already has any
 *     override entry (status or cluster-only) is refused by the overwrite
 *     guard. Status merges into existing entries are hand-curated in
 *     _recommendations_overrides.yaml, never pipelined.
 *
 * NOTE on principle_text placement: the overrides schema has no `note:` key —
 * unknown override keys are dropped by the loader AND warned on EVERY tracker
 * run (formatTrackerWarnings shows all unknown-override-key warnings), so a
 * literal note: field would be permanent stderr noise. The durable principle
 * text therefore lands in the entry's `#` context comment (the established
 * convention for human-readable context) and stays fully machine-readable in
 * the committed verdicts JSON artifact. The Stage-5 consolidation step reads
 * principle_text from the verdicts files, not from the overrides YAML.
 *
 * Tests: scripts/__tests__/recs-batch-pipeline.test.ts (temp copies only —
 * never the real overrides file).
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import { parse as parseYaml } from 'yaml';

import {
  GENERATED_PATH,
  OVERRIDES_PATH,
  parseExistingIndex,
  runTracker,
  type ManualOverride,
  type RecommendationReasonKind,
  type RecommendationRow,
} from './postmortem-recommendations-tracker';

const REPO_ROOT = path.resolve(__dirname, '..');

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

export const BATCH_KINDS = ['type-routing'] as const;
export type BatchKind = (typeof BATCH_KINDS)[number];

/** Open non-quarantined rows with these action_types form the type-routing pool. */
export const TYPE_ROUTING_ACTION_TYPES: ReadonlySet<string> = new Set([
  'review_focus',
  'agent_instructions',
  'workflow_improvement',
]);

export interface BatchInputRow {
  fingerprint: string;
  bug_id: string;
  action_type: string;
  priority: string;
  date: string;
  description: string;
  source_postmortem: string;
}

export interface BatchInputFile {
  batch_id: string;
  kind: BatchKind;
  rows: BatchInputRow[];
}

export interface BatchManifest {
  kind: BatchKind;
  generated_at: string;
  index_path: string;
  selected_row_count: number;
  batch_size: number;
  batches: Array<{ batch_id: string; file: string; row_count: number }>;
}

export const VERDICT_KINDS = ['absorb', 'wont-do', 'keep-open', 'implemented', 'rejected'] as const;
export type VerdictKind = (typeof VERDICT_KINDS)[number];

export const VALID_VERDICT_REASON_KINDS: ReadonlySet<string> = new Set([
  'target-gone',
  'superseded',
  'over-engineering',
  'covered-elsewhere',
  'other',
] satisfies RecommendationReasonKind[]);

export interface BatchVerdict {
  fingerprint: string;
  verdict: VerdictKind;
  target_doc?: string;
  principle_text?: string;
  reason?: string;
  /** Artifact evidence for implemented (and optionally rejected) verdicts — preserved in the entry's context comment. */
  evidence?: string;
  /** Explicit rejection_reason for rejected verdicts (distinct from wont-do's `reason`; matches the overrides key). */
  rejection_reason?: string;
  /** Explicit typed reason_kind for rejected verdicts — required, never inferred. */
  reason_kind?: RecommendationReasonKind;
}

export interface VerdictFile {
  batch_id: string;
  verdicts: BatchVerdict[];
}

export interface VerdictValidationIssue {
  /** Fingerprint the issue concerns; empty string for file-level issues. */
  fingerprint: string;
  reason:
    | 'batch-id-mismatch'
    | 'not-an-object'
    | 'invalid-verdict-entry'
    | 'invalid-verdict-kind'
    | 'duplicate-fingerprint'
    | 'extra-fingerprint'
    | 'missing-fingerprint'
    | 'not-in-live-index'
    | 'absorb-missing-target-doc'
    | 'absorb-missing-principle-text'
    | 'wont-do-missing-reason'
    | 'rejected-missing-rejection-reason'
    | 'rejected-missing-reason-kind'
    | 'invalid-reason-kind'
    | 'would-overwrite-existing-override';
  detail: string;
}

// ---------------------------------------------------------------------------
// Shared loading helpers
// ---------------------------------------------------------------------------

/**
 * Loads the live index rows from the generated artifact, regenerating it
 * first when missing (or when forceRegenerate). Fail-loud: tracker failures
 * throw rather than degrade to an empty corpus.
 */
export function loadLiveIndexRows({ forceRegenerate = false }: { forceRegenerate?: boolean } = {}): RecommendationRow[] {
  if (forceRegenerate || !fs.existsSync(GENERATED_PATH)) {
    const result = runTracker({ check: false });
    if (result.exitCode !== 0) {
      throw new Error(`index regeneration failed:\n${result.message}`);
    }
  }
  const text = fs.readFileSync(GENERATED_PATH, 'utf-8');
  const parsed = parseExistingIndex(text);
  if (parsed.rows.length === 0) {
    throw new Error(`generated index at ${path.relative(REPO_ROOT, GENERATED_PATH)} parsed to zero rows`);
  }
  return parsed.rows;
}

/** Fingerprints that already have a manual override entry (overwrite guard). */
export function loadExistingOverrideFingerprints(overridesPath: string): Set<string> {
  const text = fs.readFileSync(overridesPath, 'utf-8');
  const parsed = parseExistingIndex(text);
  return new Set(Object.keys(parsed.manual_overrides));
}

// ---------------------------------------------------------------------------
// emit
// ---------------------------------------------------------------------------

export function selectTypeRoutingRows(rows: RecommendationRow[]): RecommendationRow[] {
  return rows
    .filter((row) => row.status === 'open' && !row.is_quarantined && TYPE_ROUTING_ACTION_TYPES.has(row.action_type))
    .sort((a, b) => {
      const dateCmp = b.first_recorded.localeCompare(a.first_recorded);
      if (dateCmp !== 0) return dateCmp;
      const bugCmp = a.bug_id.localeCompare(b.bug_id);
      if (bugCmp !== 0) return bugCmp;
      return a.fingerprint.localeCompare(b.fingerprint);
    });
}

export function toBatchInputRow(row: RecommendationRow): BatchInputRow {
  return {
    fingerprint: row.fingerprint,
    bug_id: row.bug_id,
    action_type: row.action_type,
    priority: row.priority,
    date: row.first_recorded,
    description: row.description,
    source_postmortem: row.postmortem,
  };
}

export function chunkIntoBatches(rows: RecommendationRow[], kind: BatchKind, batchSize: number): BatchInputFile[] {
  if (!Number.isInteger(batchSize) || batchSize < 1) {
    throw new Error(`batch size must be a positive integer (got ${batchSize})`);
  }
  const batches: BatchInputFile[] = [];
  for (let i = 0; i < rows.length; i += batchSize) {
    const ordinal = String(batches.length + 1).padStart(3, '0');
    batches.push({
      batch_id: `${kind}-${ordinal}`,
      kind,
      rows: rows.slice(i, i + batchSize).map(toBatchInputRow),
    });
  }
  return batches;
}

export function emitBatches({
  kind,
  batchSize,
  outDir,
  rows,
}: {
  kind: BatchKind;
  batchSize: number;
  outDir: string;
  rows: RecommendationRow[];
}): BatchManifest {
  const selected = selectTypeRoutingRows(rows);
  const batches = chunkIntoBatches(selected, kind, batchSize);
  fs.mkdirSync(outDir, { recursive: true });

  const manifest: BatchManifest = {
    kind,
    generated_at: new Date().toISOString(),
    index_path: path.relative(REPO_ROOT, GENERATED_PATH),
    selected_row_count: selected.length,
    batch_size: batchSize,
    batches: [],
  };
  for (const batch of batches) {
    const filename = `${batch.batch_id}.input.json`;
    fs.writeFileSync(path.join(outDir, filename), JSON.stringify(batch, null, 2) + '\n', 'utf-8');
    manifest.batches.push({ batch_id: batch.batch_id, file: filename, row_count: batch.rows.length });
  }
  fs.writeFileSync(path.join(outDir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n', 'utf-8');
  return manifest;
}

// ---------------------------------------------------------------------------
// validate
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Parses verdict-file text. Tolerates a markdown code fence around the JSON
 * (a known Composer output hazard) but nothing else — anything that is not a
 * single JSON object fails loud.
 */
export function parseVerdictFileText(raw: string): VerdictFile {
  let text = raw.trim();
  const fenceMatch = text.match(/^```(?:json)?\s*\n([\s\S]*?)\n```\s*$/);
  if (fenceMatch) text = fenceMatch[1]!.trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new Error(`verdict file is not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!isRecord(parsed)) throw new Error('verdict file top-level must be a JSON object');
  if (typeof parsed.batch_id !== 'string' || parsed.batch_id.length === 0) {
    throw new Error('verdict file must have a non-empty string batch_id');
  }
  if (!Array.isArray(parsed.verdicts)) {
    throw new Error('verdict file must have a verdicts array');
  }
  return parsed as unknown as VerdictFile;
}

export function parseBatchInputFileText(raw: string): BatchInputFile {
  const parsed: unknown = JSON.parse(raw);
  if (!isRecord(parsed) || typeof parsed.batch_id !== 'string' || !Array.isArray(parsed.rows)) {
    throw new Error('batch input file must be a JSON object with batch_id and rows');
  }
  return parsed as unknown as BatchInputFile;
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

/**
 * Pure validation core — every check the apply step depends on. Returns an
 * empty array iff the verdict file is safe to apply.
 *
 * `batchInput` is optional (verdicts-only mode for researcher-produced
 * batches, e.g. the weekly scan-verify-close lane): when absent, the
 * batch-membership checks (batch-id-mismatch, extra/missing fingerprint) are
 * skipped; every per-verdict check still runs.
 */
export function validateVerdicts({
  batchInput,
  verdictFile,
  liveFingerprints,
  existingOverrideFingerprints,
}: {
  batchInput?: BatchInputFile;
  verdictFile: VerdictFile;
  liveFingerprints: ReadonlySet<string>;
  existingOverrideFingerprints: ReadonlySet<string>;
}): VerdictValidationIssue[] {
  const issues: VerdictValidationIssue[] = [];

  if (batchInput !== undefined && verdictFile.batch_id !== batchInput.batch_id) {
    issues.push({
      fingerprint: '',
      reason: 'batch-id-mismatch',
      detail: `verdict batch_id "${verdictFile.batch_id}" does not match input batch_id "${batchInput.batch_id}"`,
    });
  }

  const inputFingerprints = batchInput === undefined ? null : new Set(batchInput.rows.map((row) => row.fingerprint));
  const seen = new Set<string>();

  for (const [index, rawVerdict] of verdictFile.verdicts.entries()) {
    if (!isRecord(rawVerdict) || !nonEmptyString(rawVerdict.fingerprint)) {
      issues.push({
        fingerprint: '',
        reason: 'invalid-verdict-entry',
        detail: `verdicts[${index}] is not an object with a non-empty fingerprint`,
      });
      continue;
    }
    const verdict = rawVerdict as unknown as BatchVerdict;
    const fp = verdict.fingerprint;

    if (seen.has(fp)) {
      issues.push({
        fingerprint: fp,
        reason: 'duplicate-fingerprint',
        detail: `fingerprint "${fp}" is verdicted more than once`,
      });
      continue;
    }
    seen.add(fp);

    if (inputFingerprints !== null && !inputFingerprints.has(fp)) {
      issues.push({
        fingerprint: fp,
        reason: 'extra-fingerprint',
        detail: `fingerprint "${fp}" is not in batch input ${batchInput!.batch_id}`,
      });
    }

    if (!liveFingerprints.has(fp)) {
      issues.push({
        fingerprint: fp,
        reason: 'not-in-live-index',
        detail: `fingerprint "${fp}" does not exist in the live generated index`,
      });
    }

    if (!VERDICT_KINDS.includes(verdict.verdict)) {
      issues.push({
        fingerprint: fp,
        reason: 'invalid-verdict-kind',
        detail: `fingerprint "${fp}" has invalid verdict ${JSON.stringify(verdict.verdict)} (allowed: ${VERDICT_KINDS.join('|')})`,
      });
      continue;
    }

    if (verdict.verdict === 'absorb') {
      if (!nonEmptyString(verdict.target_doc)) {
        issues.push({
          fingerprint: fp,
          reason: 'absorb-missing-target-doc',
          detail: `fingerprint "${fp}" verdict absorb requires a non-empty target_doc`,
        });
      }
      if (!nonEmptyString(verdict.principle_text)) {
        issues.push({
          fingerprint: fp,
          reason: 'absorb-missing-principle-text',
          detail: `fingerprint "${fp}" verdict absorb requires a non-empty principle_text`,
        });
      }
    }

    if (verdict.verdict === 'wont-do' && !nonEmptyString(verdict.reason)) {
      issues.push({
        fingerprint: fp,
        reason: 'wont-do-missing-reason',
        detail: `fingerprint "${fp}" verdict wont-do requires a non-empty reason`,
      });
    }

    if (verdict.verdict === 'rejected') {
      if (!nonEmptyString(verdict.rejection_reason)) {
        issues.push({
          fingerprint: fp,
          reason: 'rejected-missing-rejection-reason',
          detail: `fingerprint "${fp}" verdict rejected requires a non-empty rejection_reason`,
        });
      }
      if (verdict.reason_kind === undefined) {
        issues.push({
          fingerprint: fp,
          reason: 'rejected-missing-reason-kind',
          detail: `fingerprint "${fp}" verdict rejected requires an explicit typed reason_kind (${[...VALID_VERDICT_REASON_KINDS].join('|')})`,
        });
      }
    }

    if (verdict.reason_kind !== undefined && !VALID_VERDICT_REASON_KINDS.has(verdict.reason_kind)) {
      issues.push({
        fingerprint: fp,
        reason: 'invalid-reason-kind',
        detail: `fingerprint "${fp}" has invalid reason_kind ${JSON.stringify(verdict.reason_kind)} (allowed: ${[...VALID_VERDICT_REASON_KINDS].join('|')})`,
      });
    }

    if (verdict.verdict !== 'keep-open' && existingOverrideFingerprints.has(fp)) {
      issues.push({
        fingerprint: fp,
        reason: 'would-overwrite-existing-override',
        detail: `fingerprint "${fp}" already has an entry in _recommendations_overrides.yaml — refusing to overwrite`,
      });
    }
  }

  if (inputFingerprints !== null) {
    for (const fp of inputFingerprints) {
      if (!seen.has(fp)) {
        issues.push({
          fingerprint: fp,
          reason: 'missing-fingerprint',
          detail: `input fingerprint "${fp}" has no verdict`,
        });
      }
    }
  }

  return issues;
}

// ---------------------------------------------------------------------------
// apply
// ---------------------------------------------------------------------------

export interface AppliedOverrideEntry {
  fingerprint: string;
  commentLines: string[];
  entry: ManualOverride;
}

const REASON_KIND_PATTERNS: ReadonlyArray<[RegExp, RecommendationReasonKind]> = [
  [/target[- ]gone|no longer exists?|file (was )?(removed|deleted)|obsolete|deprecated/i, 'target-gone'],
  [/supersed/i, 'superseded'],
  [/covered (else|by)|already (covered|exists?|implemented|enforced|handled)|duplicate/i, 'covered-elsewhere'],
  [/over-?engineer|overkill|not worth the (cost|complexity)/i, 'over-engineering'],
];

/** Best-effort reason_kind inference from a free-text wont-do reason. */
export function inferReasonKind(reason: string): RecommendationReasonKind | undefined {
  for (const [pattern, kind] of REASON_KIND_PATTERNS) {
    if (pattern.test(reason)) return kind;
  }
  return undefined;
}

/** Collapses whitespace runs (incl. newlines) so values stay one-line-safe. */
function singleLine(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function truncate(value: string, maxLength: number): string {
  return value.length <= maxLength ? value : `${value.slice(0, maxLength - 1)}…`;
}

/** Always-double-quoted YAML scalar — round-trips through both the real YAML
 * parser (parity gate) and the tracker's tolerant line parser. */
function yamlQuote(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

export function buildOverrideEntriesFromVerdicts({
  verdicts,
  rowsByFingerprint,
  date,
  batchId,
}: {
  verdicts: BatchVerdict[];
  rowsByFingerprint: ReadonlyMap<string, RecommendationRow>;
  date: string;
  batchId: string;
}): AppliedOverrideEntry[] {
  if (!/^\d{6}$/.test(date)) {
    throw new Error(`apply date must be YYMMDD (got ${JSON.stringify(date)})`);
  }
  const entries: AppliedOverrideEntry[] = [];
  for (const verdict of verdicts) {
    if (verdict.verdict === 'keep-open') continue; // default state — writes nothing
    const row = rowsByFingerprint.get(verdict.fingerprint);
    if (!row) {
      throw new Error(`verdict fingerprint "${verdict.fingerprint}" not found in live index (validation should have caught this)`);
    }
    const contextComment = `# ${row.bug_id} · ${row.action_type} · ${truncate(singleLine(row.description), 160)}`;

    if (verdict.verdict === 'absorb') {
      entries.push({
        fingerprint: verdict.fingerprint,
        commentLines: [
          contextComment,
          `# absorbed (batch ${batchId}): ${singleLine(verdict.principle_text!)}`,
        ],
        entry: {
          status: 'absorbed',
          last_revisited: date,
          absorbed_into: singleLine(verdict.target_doc!),
        },
      });
    } else if (verdict.verdict === 'implemented') {
      const evidenceSuffix = nonEmptyString(verdict.evidence) ? `: ${singleLine(verdict.evidence)}` : '';
      entries.push({
        fingerprint: verdict.fingerprint,
        commentLines: [contextComment, `# implemented (batch ${batchId})${evidenceSuffix}`],
        entry: {
          status: 'implemented',
          last_revisited: date,
        },
      });
    } else if (verdict.verdict === 'rejected') {
      const evidenceSuffix = nonEmptyString(verdict.evidence) ? `: ${singleLine(verdict.evidence)}` : '';
      entries.push({
        fingerprint: verdict.fingerprint,
        commentLines: [contextComment, `# rejected (batch ${batchId})${evidenceSuffix}`],
        entry: {
          status: 'rejected',
          last_revisited: date,
          rejection_reason: singleLine(verdict.rejection_reason!),
          // Explicit, validated upstream — rejected reason_kind is never inferred.
          reason_kind: verdict.reason_kind!,
        },
      });
    } else {
      const reason = singleLine(verdict.reason!);
      const reasonKind = inferReasonKind(reason);
      entries.push({
        fingerprint: verdict.fingerprint,
        commentLines: [contextComment, `# wont-do (batch ${batchId})`],
        entry: {
          status: 'wont-do',
          last_revisited: date,
          rejection_reason: reason,
          ...(reasonKind ? { reason_kind: reasonKind } : {}),
        },
      });
    }
  }
  return entries;
}

export function renderOverrideAppendBlock(entries: AppliedOverrideEntry[]): string {
  const lines: string[] = [];
  for (const { fingerprint, commentLines, entry } of entries) {
    for (const comment of commentLines) lines.push(`  ${comment}`);
    lines.push(`  ${yamlQuote(fingerprint)}:`);
    lines.push(`    status: ${entry.status}`);
    lines.push(`    last_revisited: ${yamlQuote(entry.last_revisited!)}`);
    if (entry.rejection_reason !== undefined) lines.push(`    rejection_reason: ${yamlQuote(entry.rejection_reason)}`);
    if (entry.absorbed_into !== undefined) lines.push(`    absorbed_into: ${yamlQuote(entry.absorbed_into)}`);
    if (entry.reason_kind !== undefined) lines.push(`    reason_kind: ${entry.reason_kind}`);
  }
  return lines.join('\n') + '\n';
}

/**
 * Appends an entry block INSIDE the `manual_overrides:` mapping. Guards the
 * structural assumption that the mapping is the file's final section (true
 * today): the last contentful line must be either `manual_overrides:` itself
 * or an indented line belonging to it.
 */
export function appendToOverridesText(overridesText: string, block: string): string {
  if (!/^manual_overrides:\s*$/m.test(overridesText)) {
    throw new Error('overrides file has no top-level `manual_overrides:` mapping');
  }
  const contentLines = overridesText.split('\n').filter((line) => line.trim().length > 0);
  const lastLine = contentLines[contentLines.length - 1] ?? '';
  if (!/^\s/.test(lastLine) && !/^manual_overrides:\s*$/.test(lastLine)) {
    throw new Error(
      `overrides file does not end inside the manual_overrides mapping (last contentful line: ${JSON.stringify(lastLine.slice(0, 80))}); refusing to append`,
    );
  }
  const base = overridesText.endsWith('\n') ? overridesText : `${overridesText}\n`;
  return base + block;
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function fail(message: string): never {
  process.stderr.write(`[recs-batch-pipeline] FAIL: ${message}\n`);
  process.exit(1);
}

function printIssues(issues: VerdictValidationIssue[]): void {
  process.stderr.write(`[recs-batch-pipeline] verdict validation FAILED with ${issues.length} error(s):\n`);
  for (const issue of issues) {
    process.stderr.write(`  - ${issue.reason}: ${issue.detail}\n`);
  }
}

interface ParsedArgs {
  command: string;
  flags: Map<string, string | true>;
}

function parseArgs(argv: string[]): ParsedArgs {
  const [command, ...rest] = argv;
  if (!command) {
    throw new Error('usage: recs-batch-pipeline.ts <emit|validate|apply> [flags]');
  }
  const flags = new Map<string, string | true>();
  for (let i = 0; i < rest.length; i++) {
    const flag = rest[i]!;
    if (!flag.startsWith('--')) throw new Error(`unexpected positional argument: ${flag}`);
    const next = rest[i + 1];
    if (next !== undefined && !next.startsWith('--')) {
      flags.set(flag, next);
      i++;
    } else {
      flags.set(flag, true);
    }
  }
  return { command, flags };
}

function requireStringFlag(flags: Map<string, string | true>, name: string): string {
  const value = flags.get(name);
  if (typeof value !== 'string' || value.length === 0) throw new Error(`${name} <value> is required`);
  return value;
}

function loadValidationContext(batchInputPath: string | undefined, verdictsPath: string) {
  const batchInput =
    batchInputPath === undefined ? undefined : parseBatchInputFileText(fs.readFileSync(batchInputPath, 'utf-8'));
  const verdictFile = parseVerdictFileText(fs.readFileSync(verdictsPath, 'utf-8'));
  const liveRows = loadLiveIndexRows();
  const liveFingerprints = new Set(liveRows.map((row) => row.fingerprint));
  const existingOverrideFingerprints = loadExistingOverrideFingerprints(OVERRIDES_PATH);
  return { batchInput, verdictFile, liveRows, liveFingerprints, existingOverrideFingerprints };
}

/** --batch-input is optional for validate/apply (verdicts-only mode). */
function optionalStringFlag(flags: Map<string, string | true>, name: string): string | undefined {
  const value = flags.get(name);
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || value.length === 0) throw new Error(`${name} requires a <value> when provided`);
  return value;
}

function cmdEmit(flags: Map<string, string | true>): number {
  const kindRaw = requireStringFlag(flags, '--kind');
  if (!BATCH_KINDS.includes(kindRaw as BatchKind)) {
    throw new Error(`--kind must be one of: ${BATCH_KINDS.join('|')} (got ${kindRaw})`);
  }
  const kind = kindRaw as BatchKind;
  const outDir = path.resolve(requireStringFlag(flags, '--out-dir'));
  const batchSizeRaw = flags.get('--batch-size');
  const batchSize = typeof batchSizeRaw === 'string' ? Number.parseInt(batchSizeRaw, 10) : 60;
  if (!Number.isInteger(batchSize) || batchSize < 1) {
    throw new Error(`--batch-size must be a positive integer (got ${String(batchSizeRaw)})`);
  }

  const rows = loadLiveIndexRows();
  const manifest = emitBatches({ kind, batchSize, outDir, rows });
  process.stdout.write(
    `[recs-batch-pipeline] emitted ${manifest.batches.length} batch(es) covering ${manifest.selected_row_count} row(s) (batch size ${batchSize}) to ${path.relative(REPO_ROOT, outDir)}\n`,
  );
  return 0;
}

function cmdValidate(flags: Map<string, string | true>): number {
  const batchInputFlag = optionalStringFlag(flags, '--batch-input');
  const batchInputPath = batchInputFlag === undefined ? undefined : path.resolve(batchInputFlag);
  const verdictsPath = path.resolve(requireStringFlag(flags, '--verdicts'));
  const { batchInput, verdictFile, liveFingerprints, existingOverrideFingerprints } = loadValidationContext(
    batchInputPath,
    verdictsPath,
  );

  const issues = validateVerdicts({ batchInput, verdictFile, liveFingerprints, existingOverrideFingerprints });
  if (issues.length > 0) {
    printIssues(issues);
    return 1;
  }

  const counts = Object.fromEntries(VERDICT_KINDS.map((kind) => [kind, 0])) as Record<VerdictKind, number>;
  for (const verdict of verdictFile.verdicts) counts[verdict.verdict] += 1;
  process.stdout.write(
    `[recs-batch-pipeline] OK: ${verdictFile.batch_id}${batchInput === undefined ? ' (verdicts-only)' : ''} — ` +
      `${verdictFile.verdicts.length} verdict(s): ` +
      VERDICT_KINDS.map((kind) => `${kind} ${counts[kind]}`).join(', ') +
      '\n',
  );

  // Non-fatal advisory: absorb targets that do not exist on disk.
  for (const verdict of verdictFile.verdicts) {
    if (verdict.verdict === 'absorb' && verdict.target_doc) {
      const targetPath = path.resolve(REPO_ROOT, verdict.target_doc);
      if (!fs.existsSync(targetPath)) {
        process.stdout.write(
          `[recs-batch-pipeline] WARN: absorb target_doc "${verdict.target_doc}" (${verdict.fingerprint}) does not exist on disk\n`,
        );
      }
    }
  }
  return 0;
}

function cmdApply(flags: Map<string, string | true>): number {
  const batchInputFlag = optionalStringFlag(flags, '--batch-input');
  const batchInputPath = batchInputFlag === undefined ? undefined : path.resolve(batchInputFlag);
  const verdictsPath = path.resolve(requireStringFlag(flags, '--verdicts'));
  const dateFlag = flags.get('--date');
  const date =
    typeof dateFlag === 'string'
      ? dateFlag
      : new Date().toISOString().slice(2, 10).replace(/-/g, '');

  // Always recheck internally — apply refuses to write when validation fails.
  // (--require-validated is accepted for interface clarity; it is the default
  // and only behavior.)
  const { batchInput, verdictFile, liveRows, liveFingerprints, existingOverrideFingerprints } = loadValidationContext(
    batchInputPath,
    verdictsPath,
  );
  const issues = validateVerdicts({ batchInput, verdictFile, liveFingerprints, existingOverrideFingerprints });
  if (issues.length > 0) {
    printIssues(issues);
    process.stderr.write('[recs-batch-pipeline] apply REFUSED: fix the verdict file and re-run validate first.\n');
    return 1;
  }

  const rowsByFingerprint = new Map(liveRows.map((row) => [row.fingerprint, row]));
  const entries = buildOverrideEntriesFromVerdicts({
    verdicts: verdictFile.verdicts as BatchVerdict[],
    rowsByFingerprint,
    date,
    batchId: verdictFile.batch_id,
  });
  if (entries.length === 0) {
    process.stdout.write(`[recs-batch-pipeline] ${verdictFile.batch_id}: all verdicts are keep-open — nothing to apply.\n`);
    return 0;
  }

  const originalText = fs.readFileSync(OVERRIDES_PATH, 'utf-8');
  const newText = appendToOverridesText(originalText, renderOverrideAppendBlock(entries));
  // Belt-and-braces: the appended file must still be parseable, duplicate-free YAML.
  parseYaml(newText, { uniqueKeys: true });
  fs.writeFileSync(OVERRIDES_PATH, newText, 'utf-8');

  const rollback = (why: string): never => {
    fs.writeFileSync(OVERRIDES_PATH, originalText, 'utf-8');
    runTracker({ check: false }); // restore the generated artifact to match
    fail(`${why}\n  Overrides file restored to its pre-apply state.`);
  };

  const regen = runTracker({ check: false });
  if (regen.exitCode !== 0) rollback(`post-apply regeneration failed:\n${regen.message}`);
  const parity = runTracker({ check: true });
  if (parity.exitCode !== 0) rollback(`post-apply parity validation failed:\n${parity.message}`);

  const statusCount = (status: string): number => entries.filter((e) => e.entry.status === status).length;
  process.stdout.write(
    `[recs-batch-pipeline] applied ${entries.length} override entr(ies) from ${verdictFile.batch_id} ` +
      `(${statusCount('absorbed')} absorbed, ${statusCount('wont-do')} wont-do, ` +
      `${statusCount('implemented')} implemented, ${statusCount('rejected')} rejected); regenerate + parity OK.\n`,
  );
  return 0;
}

function main(): number {
  let parsed: ParsedArgs;
  try {
    parsed = parseArgs(process.argv.slice(2));
    switch (parsed.command) {
      case 'emit':
        return cmdEmit(parsed.flags);
      case 'validate':
        return cmdValidate(parsed.flags);
      case 'apply':
        return cmdApply(parsed.flags);
      default:
        throw new Error(`unknown command "${parsed.command}" (expected emit|validate|apply)`);
    }
  } catch (err) {
    fail(err instanceof Error ? err.message : String(err));
  }
}

if (require.main === module) {
  process.exit(main());
}
