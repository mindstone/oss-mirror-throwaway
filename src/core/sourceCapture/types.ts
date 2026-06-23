/**
 * Types for the deterministic source-capture prefilter kernel
 * (`docs/plans/260614_automation-cost-efficiency/` Part B, Stage 1).
 *
 * The prefilter is the SCRIPT half of the script/LLM boundary: it enumerates
 * candidate sources across the user's connected accounts (calendar, fireflies,
 * email, slack, fathom, …), excludes EXACT already-captured items, FLAGS (never
 * drops) near-duplicates, and emits a curated candidate manifest plus an
 * observability record. The LLM then deep-reads / captures / summarises ONLY
 * the manifest — no mechanical connector scan.
 *
 * Design rules (recall-preserving):
 *  - Only EXACT `source_system:source_account:source_uid` matches are excluded.
 *  - Near-dupes are FLAGGED (`flaggedDuplicateOf`), passed through for the LLM
 *    to resolve — the LLM is the precision gate.
 *  - Nothing is silently dropped: every enumerated item appears in the
 *    observability record with a disposition (incl. `enumeration_failed`).
 *
 * Pure + DI: zero direct network / electron / filesystem imports. All side
 * effects arrive via injected deps, so the kernel is unit-testable with fakes.
 */

import { z } from 'zod';

/** Per-candidate disposition in the observability record. */
export const PrefilterDispositionSchema = z.enum([
  /** Surfaced in the manifest for the LLM to act on (not a duplicate). */
  'passed',
  /** Surfaced in the manifest BUT flagged as a likely duplicate for the LLM to resolve. */
  'flagged_near_dupe',
  /** Excluded from the manifest — exact compound-key match with an already-captured source. */
  'excluded_exact_dupe',
  /** A connector enumeration call failed; the source was NOT scanned. */
  'enumeration_failed',
  /** Dated before the activity window (not new since the last run) — excluded from the manifest. */
  'out_of_window',
]);
export type PrefilterDisposition = z.infer<typeof PrefilterDispositionSchema>;

/**
 * A single enumerated candidate source, normalised across connectors. The
 * connector-specific extractor (supplied by the caller) maps a raw `use_tool`
 * result into these fields.
 */
export const CandidateSourceSchema = z.object({
  /** Stable per-candidate id (connector source uid; falls back to a synthesised key). */
  id: z.string(),
  /** Connector family (`fireflies`, `gmail`, `slack`, `fathom`, `gcal`, …). */
  source_system: z.string(),
  /** Account the candidate was enumerated from (e.g. `[external-email]`). */
  source_account: z.string(),
  /** Connector-native stable id for the source (the dedup key component). */
  source_uid: z.string(),
  title: z.string(),
  /** ISO date (`YYYY-MM-DD`) or ISO timestamp; used for same-day near-dupe heuristics. */
  date: z.string().optional(),
  participants: z.array(z.string()).default([]),
  url: z.string().optional(),
});
export type CandidateSource = z.infer<typeof CandidateSourceSchema>;

/** A candidate as it appears in the manifest, with its disposition annotation. */
export const ManifestCandidateSchema = CandidateSourceSchema.extend({
  disposition: PrefilterDispositionSchema,
  /**
   * When `flagged_near_dupe`: the compound key (`system:account:uid`) of the
   * already-captured source this candidate likely duplicates. Advisory only —
   * the LLM resolves it.
   */
  flaggedDuplicateOf: z.string().optional(),
});
export type ManifestCandidate = z.infer<typeof ManifestCandidateSchema>;

/** Per-item observability entry (covers ALL enumerated items + enumeration failures). */
export const PrefilterObservabilityItemSchema = z.object({
  /** Candidate id, or the connector spec id for an `enumeration_failed` row. */
  id: z.string(),
  source_system: z.string(),
  source_account: z.string().optional(),
  disposition: PrefilterDispositionSchema,
  /** Compound key of the matched captured source (exact or near). */
  matchedKey: z.string().optional(),
  /** Failure reason for `enumeration_failed` rows. */
  error: z.string().optional(),
});
export type PrefilterObservabilityItem = z.infer<typeof PrefilterObservabilityItemSchema>;

/** Aggregate counts + per-item dispositions emitted by every prefilter run. */
export const PrefilterObservabilitySchema = z.object({
  enumerated: z.number().int().nonnegative(),
  passed: z.number().int().nonnegative(),
  flaggedNearDupe: z.number().int().nonnegative(),
  excludedExactDupe: z.number().int().nonnegative(),
  outOfWindow: z.number().int().nonnegative(),
  enumerationFailed: z.number().int().nonnegative(),
  /** Total `use_tool` (and other MCP) calls the prefilter made — for honest cost attribution. */
  scriptedToolCallCount: z.number().int().nonnegative(),
  items: z.array(PrefilterObservabilityItemSchema),
});
export type PrefilterObservability = z.infer<typeof PrefilterObservabilitySchema>;

/** The prefilter result: the curated manifest the LLM acts on + the audit record. */
export const SourceCapturePrefilterResultSchema = z.object({
  manifest: z.array(ManifestCandidateSchema),
  observability: PrefilterObservabilitySchema,
});
export type SourceCapturePrefilterResult = z.infer<typeof SourceCapturePrefilterResultSchema>;

/**
 * One connector enumeration step. The caller supplies the `use_tool` envelope
 * coordinates and an `extract` fn that maps the connector's raw result into
 * normalised candidates. Keeping extraction caller-supplied makes the kernel
 * connector-agnostic (no hard-coded knowledge of fireflies/gmail/slack shapes).
 */
export interface EnumerationSpec {
  /** Stable id for this enumeration step (used in `enumeration_failed` rows). */
  specId: string;
  source_system: string;
  source_account: string;
  /** `use_tool` package id (e.g. `GoogleWorkspace-jordan-acmecorp-com`, `fireflies`). */
  package_id: string;
  /** `use_tool` tool id (e.g. `list_meetings`, `list_messages`). */
  tool_id: string;
  /** Args passed through `use_tool`'s `args` field. */
  args: Record<string, unknown>;
  /**
   * Map the connector's raw `result` payload (already JSON-parsed from the
   * `use_tool` envelope) into normalised candidates. Pure — no I/O.
   */
  extract: (rawResult: unknown) => CandidateSource[];
}

/** A captured source already on disk (frontmatter-derived compound key + metadata for near-dupe checks). */
export interface CapturedSourceRecord {
  /** `source_system:source_account:source_uid`. */
  compoundKey: string;
  source_system: string;
  source_uid: string;
  title?: string;
  /** ISO date (`YYYY-MM-DD`) for same-day near-dupe heuristics. */
  date?: string;
  participants?: string[];
}

/**
 * Injected MCP caller. Returns the connector's raw `result` payload (the kernel
 * does NOT know about the `use_tool` envelope — the adapter unwraps it).
 * Resolves to `{ ok: false, error }` on failure so the kernel can record an
 * `enumeration_failed` disposition rather than throwing.
 */
export type PrefilterMcpCall = (
  spec: EnumerationSpec,
) => Promise<{ ok: true; result: unknown } | { ok: false; error: string }>;

/** Scan already-captured source frontmatter → captured records. */
export type ScanCapturedFrontmatter = () => Promise<CapturedSourceRecord[]>;

/** Minimal structured logger (Pino-compatible arg order: `(obj, msg)`). */
export interface PrefilterLogger {
  info: (obj: Record<string, unknown>, msg: string) => void;
  warn: (obj: Record<string, unknown>, msg: string) => void;
  debug: (obj: Record<string, unknown>, msg: string) => void;
}

/** Injected clock (epoch millis) — keeps the kernel deterministic in tests. */
export interface PrefilterClock {
  now: () => number;
}

/** Dependency-injection bundle for {@link runSourceCapturePrefilter}. */
export interface SourceCapturePrefilterDeps {
  mcpCall: PrefilterMcpCall;
  scanCapturedFrontmatter: ScanCapturedFrontmatter;
  clock: PrefilterClock;
  logger: PrefilterLogger;
}

/** Input to {@link runSourceCapturePrefilter}: the enumeration plan. */
export interface SourceCapturePrefilterInput {
  /** The connector enumeration steps to run (one per connector/account/list-tool). */
  specs: EnumerationSpec[];
  /**
   * Activity-window lower bound (epoch millis). Candidates dated strictly BEFORE
   * this are excluded from the manifest as `out_of_window` (mirrors the
   * production "activity since [LAST_EXECUTED_SUCCESS]" scan — the prefilter must
   * not surface the whole historical corpus, only what is new since the last
   * run). Candidates with no parseable date are KEPT (recall-preserving — let the
   * LLM judge). Omit / null to disable windowing (enumerate everything).
   */
  windowStartMs?: number | null;
}
