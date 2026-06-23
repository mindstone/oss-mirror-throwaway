/**
 * Prior-Turns Header Builder
 *
 * Stage 2 of `docs/plans/260525_cross_turn_awareness_layer1_layer2.md`.
 *
 * Renders the always-on `<prior_turns>...</prior_turns>` block prepended to
 * the user prompt for non-initial turns. Consumes Stage-1's
 * `readPriorTurns()` output and surfaces deterministic metadata only — tool
 * counts, deduped file paths, materialized-output pointers, deterministic
 * outcome class, and a compact `oneLineGist`.
 *
 * Hard requirements (per plan F2):
 *   - At most ONE `<prior_turns>` opening tag and ONE `</prior_turns>`
 *     closing tag in the rendered output. Risky strings come pre-transformed
 *     by `escapePriorTurnContent` (Stage 1) so embedded sentinel substrings
 *     can never close the wrapper early.
 *   - All embedded user-controlled content (file paths, queries, gist) is
 *     wrapped in fenced backticks per C11.
 *
 * Token budget (per D2): 1,200 tokens (~4,800 chars). When oversized, a
 * collapse strategy fires — most-recent-first, drop tool-call counts before
 * dropping file paths, and finally collapse to a 1-line per-turn fallback.
 */

import { escapePriorTurnContent, type TranscriptTurnSummary } from './priorTurnsReader';

/** Hard cap per D2 — roughly 1,200 tokens. */
const HEADER_MAX_CHARS = 4_800;

/** Top-N file paths surfaced per turn under "Files read". */
const FILES_TOP_N = 20;

/** Top-N external sources surfaced per turn under "External sources". */
const EXTERNAL_SOURCES_TOP_N = 8;

const HEADER_PROLOGUE = 'Turns in this session (oldest first):';
const HEADER_EPILOGUE =
  'Use inspect_prior_turns(turn_id) for a deterministic structured summary of any turn. Use get_tool_call(turn_id, tool_use_id) for the full I/O of one specific call. Before re-running a read/search/fetch, check whether it appears above; if so, prefer Read on the materialized file or rely on what the prior turn produced unless you have a concrete reason to redo it (e.g. file may have changed since).';

export interface BuildPriorTurnsHeaderInput {
  summaries: TranscriptTurnSummary[];
  /**
   * Current turn id used to filter out the in-flight turn from the rendered
   * header (race-avoidance — the in-flight turn's transcript is partially
   * written when its own header is built).
   *
   * Pass `undefined` (or omit) when the caller knows none of the supplied
   * summaries represent an in-flight turn — for example, the
   * AskUserQuestion-continuation path runs during the just-completed turn N
   * BEFORE turn N+1's id has been issued, so filtering on the prior turn's
   * id would incorrectly drop the most relevant summary.
   */
  currentTurnId: string | undefined;
}

export interface BuildPriorTurnsHeaderResult {
  /** Empty string when no eligible prior turns are present. Otherwise the full block ending with two newlines. */
  text: string;
  /** Byte size of `text`. Used by the meta surface for telemetry. */
  bytes: number;
  /** True when the collapse strategy fired to fit within `HEADER_MAX_CHARS`. */
  truncated: boolean;
  /** Number of turns rendered. */
  turnCount: number;
}

/**
 * Build the `<prior_turns>` block from a list of `TranscriptTurnSummary`.
 *
 * Always returns a result (`text` may be the empty string when there are no
 * eligible prior turns). Filters out the current turn (`currentTurnId`).
 */
export function buildPriorTurnsHeader(
  input: BuildPriorTurnsHeaderInput,
): BuildPriorTurnsHeaderResult {
  const eligible =
    input.currentTurnId === undefined
      ? input.summaries.slice()
      : input.summaries.filter(
          (summary) => summary.turnId !== input.currentTurnId,
        );

  if (eligible.length === 0) {
    return { text: '', bytes: 0, truncated: false, turnCount: 0 };
  }

  const turnLabels = assignDisplayLabels(eligible);

  let text = renderHeader(eligible, turnLabels, { collapseLevel: 0 });
  let truncated = false;

  if (text.length > HEADER_MAX_CHARS) {
    text = renderHeader(eligible, turnLabels, { collapseLevel: 1 });
    truncated = true;
  }
  if (text.length > HEADER_MAX_CHARS) {
    text = renderHeader(eligible, turnLabels, { collapseLevel: 2 });
  }
  if (text.length > HEADER_MAX_CHARS) {
    text = renderHeader(eligible, turnLabels, { collapseLevel: 3 });
  }
  if (text.length > HEADER_MAX_CHARS) {
    text = clampOversizeHeader(text);
    truncated = true;
  }

  return {
    text,
    bytes: Buffer.byteLength(text, 'utf8'),
    truncated,
    turnCount: eligible.length,
  };
}

/**
 * Final hard clamp invoked when the 3 collapse passes still don't fit the
 * cap. Truncates to the byte cap and appends a clear truncation marker plus
 * a clean `</prior_turns>\n\n` close so the wrapper grammar stays valid.
 */
function clampOversizeHeader(text: string): string {
  const closer = '\n…(truncated to fit)…\n</prior_turns>\n\n';
  const head = text.slice(0, Math.max(0, HEADER_MAX_CHARS - closer.length));
  return head + closer;
}

/**
 * Assign stable display labels (T1, T2, …) to summaries. The summaries are
 * already sorted oldest-first by the reader.
 */
function assignDisplayLabels(
  summaries: TranscriptTurnSummary[],
): Map<string, string> {
  const labels = new Map<string, string>();
  summaries.forEach((summary, index) => {
    labels.set(summary.turnId, `T${index + 1}`);
  });
  return labels;
}

/**
 * Collapse strategy:
 *   0 — full detail (gist, tool counts, files, external sources, materialized outputs, outcome).
 *   1 — drop tool counts; keep gist + files (top 10) + materialized outputs + outcome.
 *   2 — drop files entirely; keep gist + materialized outputs + outcome.
 *   3 — drop everything except gist + outcome.
 *
 * Most-recent-first ordering of collapse: when level >= 1, oldest turns
 * collapse first (newest turn keeps the most detail). When all turns are
 * collapsed equally and the result still doesn't fit, level 3 applies
 * uniformly.
 */
function renderHeader(
  summaries: TranscriptTurnSummary[],
  labels: Map<string, string>,
  options: { collapseLevel: 0 | 1 | 2 | 3 },
): string {
  const lines: string[] = [];
  lines.push('<prior_turns>');
  lines.push(HEADER_PROLOGUE);
  lines.push('');

  for (let i = 0; i < summaries.length; i++) {
    const summary = summaries[i];
    const isNewest = i === summaries.length - 1;
    const effectiveLevel = options.collapseLevel === 0
      ? 0
      : options.collapseLevel === 1
        ? (isNewest ? 0 : 1)
        : options.collapseLevel === 2
          ? (isNewest ? 1 : 2)
          : 3;

    appendTurnBlock(lines, summary, labels, effectiveLevel);
  }

  lines.push(HEADER_EPILOGUE);
  lines.push('</prior_turns>');

  return lines.join('\n') + '\n\n';
}

function appendTurnBlock(
  lines: string[],
  summary: TranscriptTurnSummary,
  labels: Map<string, string>,
  level: 0 | 1 | 2 | 3,
): void {
  const label = labels.get(summary.turnId) ?? summary.turnId;
  const gist = summary.oneLineGist
    ? `\`${escapePriorTurnContent(summary.oneLineGist)}\``
    : '(no assistant message)';
  lines.push(`[${label}] Goal: ${gist}`);

  if (level <= 0) {
    const tools = renderToolCounts(summary.toolCallCount);
    if (tools) lines.push(`  Tools: ${tools}`);
  }

  if (level <= 1 && summary.filePathsRead.length > 0) {
    const topN = level === 0 ? FILES_TOP_N : 10;
    const paths = summary.filePathsRead.slice(0, topN).map(
      (p) => `\`${escapePriorTurnContent(p)}\``,
    );
    const more =
      summary.filePathsRead.length > topN
        ? `, …(+${summary.filePathsRead.length - topN} more)`
        : '';
    lines.push(`  Files read (dedup): ${paths.join(', ')}${more}`);
  }

  if (level <= 1 && summary.externalSourcesHit.length > 0) {
    const topN = EXTERNAL_SOURCES_TOP_N;
    // The reader pre-escapes external-source strings; defensively escape again
    // here so the F2 invariant holds even if a future reader regression lets
    // a literal sentinel slip through. The transform is idempotent.
    const sources = summary.externalSourcesHit.slice(0, topN).map(
      (s) => `\`${escapePriorTurnContent(s)}\``,
    );
    const more =
      summary.externalSourcesHit.length > topN
        ? `, …(+${summary.externalSourcesHit.length - topN} more)`
        : '';
    lines.push(`  External sources: ${sources.join(', ')}${more}`);
  }

  if (level <= 2 && summary.materializedOutputs.length > 0) {
    lines.push('  Materialized outputs:');
    for (const path of summary.materializedOutputs) {
      lines.push(`    - \`${escapePriorTurnContent(path)}\``);
    }
  }

  lines.push(`  Outcome: ${renderOutcome(summary.outcomeClass)}`);
  lines.push('');
}

function renderToolCounts(counts: Record<string, number>): string {
  const entries = Object.entries(counts).sort((a, b) => b[1] - a[1]);
  if (entries.length === 0) return '';
  return entries
    .map(([toolName, count]) => `${count} ${escapePriorTurnContent(toolName)}`)
    .join(' · ');
}

function renderOutcome(outcome: TranscriptTurnSummary['outcomeClass']): string {
  switch (outcome) {
    case 'asked-user-question':
      return 'asked user a question via AskUserQuestion';
    case 'completed':
      return 'completed';
    case 'errored':
      return 'errored';
    case 'in-flight':
      return 'in flight';
    default: {
      const _exhaustive: never = outcome;
      return _exhaustive;
    }
  }
}
