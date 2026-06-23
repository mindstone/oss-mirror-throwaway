/**
 * Deterministic source-capture prefilter kernel
 * (`docs/plans/260614_automation-cost-efficiency/` Part B, Stage 1 — the 90/10 test).
 *
 * SCRIPT half of the script/LLM boundary. Replaces the LLM's mechanical
 * "scan every connector, list everything, dedup by reading frontmatter" loop
 * with a deterministic enumerate → exclude-exact-dupe → flag-near-dupe pass that
 * emits a curated candidate manifest. The LLM then deep-reads / captures /
 * summarises ONLY the manifest.
 *
 * Recall-preserving guarantees (see types.ts):
 *  - EXACT compound-key matches (`source_system:source_account:source_uid`)
 *    are the ONLY items excluded from the manifest.
 *  - Near-dupes are FLAGGED, never dropped — the LLM is the precision gate.
 *  - Every enumerated item (and every enumeration failure) appears in the
 *    observability record. Nothing is silently dropped.
 *
 * Pure + DI: all side effects (MCP calls, frontmatter scan, clock) are injected.
 * No electron / network / fs imports → runs unchanged on desktop, cloud, mobile.
 */

import {
  type CandidateSource,
  CandidateSourceSchema,
  type CapturedSourceRecord,
  type ManifestCandidate,
  type PrefilterObservabilityItem,
  type SourceCapturePrefilterDeps,
  type SourceCapturePrefilterInput,
  type SourceCapturePrefilterResult,
} from './types';

/** Build the exact dedup key. Kept here so producers + consumers can't diverge. */
export function compoundKey(
  source_system: string,
  source_account: string,
  source_uid: string,
): string {
  return `${source_system}:${source_account}:${source_uid}`;
}

/** Lowercase + collapse whitespace + strip punctuation for near-dupe title matching. */
export function normalizeTitle(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Epoch millis of an ISO date/timestamp, or null if unparseable. */
function dateToMs(date: string | undefined): number | null {
  if (!date) return null;
  // Date-only strings parse as UTC midnight, which is what we want for windowing.
  const ms = Date.parse(date);
  return Number.isFinite(ms) ? ms : null;
}

/** Calendar day (`YYYY-MM-DD`) of an ISO date/timestamp, or null if unparseable. */
function isoDay(date: string | undefined): string | null {
  if (!date) return null;
  // Already a date-only string.
  if (/^\d{4}-\d{2}-\d{2}$/.test(date)) return date;
  const parsed = new Date(date);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed.toISOString().slice(0, 10);
}

function normalizeParticipants(participants: readonly string[] | undefined): Set<string> {
  const set = new Set<string>();
  for (const p of participants ?? []) {
    const n = p.trim().toLowerCase();
    if (n) set.add(n);
  }
  return set;
}

function participantOverlap(a: Set<string>, b: Set<string>): boolean {
  if (a.size === 0 || b.size === 0) return false;
  for (const x of a) {
    if (b.has(x)) return true;
  }
  return false;
}

/**
 * Near-dupe heuristic: a candidate is a likely (but not exact) duplicate of a
 * captured source when, on the SAME calendar day, their normalised titles
 * overlap (one contains the other) AND there is participant overlap. Deliberately
 * conservative — the goal is to FLAG plausible dupes for the LLM, never to drop.
 * Returns the captured record's compound key on a match, else null.
 */
export function findNearDuplicate(
  candidate: CandidateSource,
  captured: readonly CapturedSourceRecord[],
): string | null {
  const candDay = isoDay(candidate.date);
  const candTitle = normalizeTitle(candidate.title);
  if (!candTitle) return null;
  const candParticipants = normalizeParticipants(candidate.participants);

  for (const rec of captured) {
    const recDay = isoDay(rec.date);
    // Same-day requirement (both must have a resolvable day and match).
    if (!candDay || !recDay || candDay !== recDay) continue;
    const recTitle = normalizeTitle(rec.title ?? '');
    if (!recTitle) continue;
    const titleMatch =
      candTitle === recTitle ||
      candTitle.includes(recTitle) ||
      recTitle.includes(candTitle);
    if (!titleMatch) continue;
    // Require participant overlap to avoid flagging generic recurring titles.
    const recParticipants = normalizeParticipants(rec.participants);
    if (!participantOverlap(candParticipants, recParticipants)) continue;
    return rec.compoundKey;
  }
  return null;
}

/**
 * Run the deterministic source-capture prefilter.
 *
 * Steps:
 *  1. ENUMERATE — call each connector list tool via `mcpCall`; extract candidates.
 *     Failures become `enumeration_failed` observability rows (no silent drop).
 *  2. SCAN — load already-captured frontmatter (exact compound keys + metadata).
 *  3. EXCLUDE — drop candidates whose compound key EXACTLY matches a captured one.
 *  4. FLAG — surface (not drop) near-dupes, annotated with `flaggedDuplicateOf`.
 *  5. EMIT — the manifest (passed + flagged) and a full observability record.
 */
export async function runSourceCapturePrefilter(
  input: SourceCapturePrefilterInput,
  deps: SourceCapturePrefilterDeps,
): Promise<SourceCapturePrefilterResult> {
  const { mcpCall, scanCapturedFrontmatter, logger } = deps;
  const startedAt = deps.clock.now();

  // ── 1. Enumerate ──────────────────────────────────────────────────────────
  const candidates: CandidateSource[] = [];
  const observabilityItems: PrefilterObservabilityItem[] = [];
  let scriptedToolCallCount = 0;
  let enumerationFailed = 0;

  for (const spec of input.specs) {
    scriptedToolCallCount += 1;
    const outcome = await mcpCall(spec);
    if (!outcome.ok) {
      enumerationFailed += 1;
      observabilityItems.push({
        id: spec.specId,
        source_system: spec.source_system,
        source_account: spec.source_account,
        disposition: 'enumeration_failed',
        error: outcome.error,
      });
      logger.warn(
        { specId: spec.specId, packageId: spec.package_id, toolId: spec.tool_id, error: outcome.error },
        'source-capture prefilter: connector enumeration failed (source not scanned)',
      );
      continue;
    }
    let extracted: CandidateSource[] = [];
    try {
      extracted = spec
        .extract(outcome.result)
        // Validate + normalise each extracted candidate (defaults participants []).
        .map((c) => CandidateSourceSchema.parse(c));
    } catch (err) {
      enumerationFailed += 1;
      const error = err instanceof Error ? err.message : String(err);
      observabilityItems.push({
        id: spec.specId,
        source_system: spec.source_system,
        source_account: spec.source_account,
        disposition: 'enumeration_failed',
        error: `extract failed: ${error}`,
      });
      logger.warn(
        { specId: spec.specId, error },
        'source-capture prefilter: candidate extraction failed (source not scanned)',
      );
      continue;
    }
    candidates.push(...extracted);
  }

  // ── 2. Scan already-captured frontmatter ────────────────────────────────────
  const captured = await scanCapturedFrontmatter();
  const capturedKeys = new Set(captured.map((c) => c.compoundKey));

  // ── 3 + 4. Window-scope; exclude exact dupes; flag near-dupes; pass the rest ─
  const manifest: ManifestCandidate[] = [];
  let passed = 0;
  let flaggedNearDupe = 0;
  let excludedExactDupe = 0;
  let outOfWindow = 0;
  const windowStartMs = input.windowStartMs ?? null;

  for (const candidate of candidates) {
    // Activity-window scope: drop candidates dated strictly before the window
    // start (mirrors "activity since [LAST_EXECUTED_SUCCESS]"). Undated
    // candidates are KEPT (recall-preserving — let the LLM decide).
    if (windowStartMs !== null) {
      const candMs = dateToMs(candidate.date);
      if (candMs !== null && candMs < windowStartMs) {
        outOfWindow += 1;
        observabilityItems.push({
          id: candidate.id,
          source_system: candidate.source_system,
          source_account: candidate.source_account,
          disposition: 'out_of_window',
        });
        continue;
      }
    }

    const key = compoundKey(
      candidate.source_system,
      candidate.source_account,
      candidate.source_uid,
    );
    if (capturedKeys.has(key)) {
      excludedExactDupe += 1;
      observabilityItems.push({
        id: candidate.id,
        source_system: candidate.source_system,
        source_account: candidate.source_account,
        disposition: 'excluded_exact_dupe',
        matchedKey: key,
      });
      continue;
    }

    const nearKey = findNearDuplicate(candidate, captured);
    if (nearKey) {
      flaggedNearDupe += 1;
      manifest.push({ ...candidate, disposition: 'flagged_near_dupe', flaggedDuplicateOf: nearKey });
      observabilityItems.push({
        id: candidate.id,
        source_system: candidate.source_system,
        source_account: candidate.source_account,
        disposition: 'flagged_near_dupe',
        matchedKey: nearKey,
      });
      continue;
    }

    passed += 1;
    manifest.push({ ...candidate, disposition: 'passed' });
    observabilityItems.push({
      id: candidate.id,
      source_system: candidate.source_system,
      source_account: candidate.source_account,
      disposition: 'passed',
    });
  }

  const result: SourceCapturePrefilterResult = {
    manifest,
    observability: {
      enumerated: candidates.length,
      passed,
      flaggedNearDupe,
      excludedExactDupe,
      outOfWindow,
      enumerationFailed,
      scriptedToolCallCount,
      items: observabilityItems,
    },
  };

  logger.info(
    {
      enumerated: candidates.length,
      passed,
      flaggedNearDupe,
      excludedExactDupe,
      outOfWindow,
      enumerationFailed,
      scriptedToolCallCount,
      capturedKeyCount: capturedKeys.size,
      elapsedMs: deps.clock.now() - startedAt,
    },
    'source-capture prefilter complete',
  );

  return result;
}

/**
 * Render the manifest into a compact, prompt-injectable block. Excluded exact
 * dupes are intentionally absent (the LLM should not re-capture them); flagged
 * near-dupes are present with an explicit advisory so the LLM resolves them.
 */
export function renderManifestForPrompt(result: SourceCapturePrefilterResult): string {
  const { manifest, observability } = result;
  const lines: string[] = [];
  lines.push('## Curated candidate manifest (deterministic prefilter)');
  lines.push('');
  lines.push(
    `A deterministic prefilter has already enumerated your connected sources and ` +
      `removed exact duplicates of sources you have already captured. You do NOT need ` +
      `to scan connectors to discover sources — work ONLY from the list below.`,
  );
  lines.push('');
  lines.push(
    `Enumerated ${observability.enumerated} candidate(s): ` +
      `${observability.passed} new, ${observability.flaggedNearDupe} flagged as possible duplicates, ` +
      `${observability.excludedExactDupe} excluded as exact duplicates already captured, ` +
      `${observability.outOfWindow} excluded as older than the activity window.` +
      (observability.enumerationFailed > 0
        ? ` ${observability.enumerationFailed} connector(s) FAILED to enumerate — for those sources only, ` +
          `fall back to scanning the connector yourself.`
        : ''),
  );
  lines.push('');

  if (manifest.length === 0) {
    lines.push('_No new candidate sources. Proceed to the Actions steps (freshness check, etc.)._');
  } else {
    for (const c of manifest) {
      const flag =
        c.disposition === 'flagged_near_dupe'
          ? ` [POSSIBLE DUPLICATE of ${c.flaggedDuplicateOf} — verify before capturing; do not double-capture]`
          : '';
      const parts = [
        `- **${c.title}**`,
        `(${c.source_system}`,
        c.date ? `, ${c.date}` : '',
        `)`,
      ].join('');
      lines.push(`${parts}${flag}`);
      lines.push(
        `  - source_system: ${c.source_system} | source_account: ${c.source_account} | source_uid: ${c.source_uid}`,
      );
      if (c.participants.length > 0) {
        lines.push(`  - participants: ${c.participants.join(', ')}`);
      }
      if (c.url) lines.push(`  - url: ${c.url}`);
    }
  }

  if (observability.enumerationFailed > 0) {
    lines.push('');
    lines.push('### Connectors that failed to enumerate (scan these yourself):');
    for (const item of observability.items.filter((i) => i.disposition === 'enumeration_failed')) {
      lines.push(`- ${item.source_system} (${item.id}): ${item.error ?? 'unknown error'}`);
    }
  }

  return lines.join('\n');
}
