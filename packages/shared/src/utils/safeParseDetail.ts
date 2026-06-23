/**
 * Canonical guarded parser for agent-event tool/result `detail` (and `text`)
 * strings — the single source of truth for the "unbounded `JSON.parse(detail)`"
 * OOM class.
 *
 * Tool `detail` carries arbitrary tool output (file contents, search results,
 * large MCP payloads, agent-composed sub-agent prompts). On a big tool result
 * the string can reach hundreds of MB; an unguarded `JSON.parse(detail)`
 * materialises an equally large object graph and can push a process (especially
 * the renderer) over V8's heap ceiling, crash-looping it (REBEL-68T / 68P).
 *
 * `safeParseDetail` refuses to parse anything above a byte budget BEFORE calling
 * `JSON.parse`, and returns a discriminated result so call sites can preserve
 * their existing fallback behaviour. See
 * docs/plans/260616_detail-parse-class-kill/PLAN.md.
 *
 * Dependency-free by design: lives in `@rebel/shared`, which must not import
 * `@core` / `@shared` / electron. Re-exported from `src/shared/utils/` and the
 * renderer agent-session path so every surface routes through this one impl.
 */

/**
 * Default maximum `detail` size (in UTF-16 code units, i.e. `string.length`) we
 * are willing to hand to `JSON.parse`.
 *
 * 256 KiB chosen because: (a) the scalar/path/label/telemetry extractors below
 * only read a handful of small fields (paths, status, operator name, sub-agent
 * type) — a useful detail is always far smaller than this; (b) it is well under
 * the per-string sizes (hundreds of MB) seen in the OOM stacks; (c) it is
 * generous enough that legitimate small structured tool results never trip it.
 * `detail.length` overcounts bytes for multi-byte chars, which is the safe
 * direction (we reject sooner, never later).
 */
export const MAX_DETAIL_PARSE_BYTES = 256 * 1024;

/**
 * Larger budget (1 MiB) for the structured task / sub-agent-progress extractors
 * that feed visible UI (mission/task snapshots, sub-agent identity preview).
 * Generous for realistic snapshots, still ~100× under the OOM regime — so
 * realistic UI keeps structured progress; only pathological inputs degrade to
 * the truncation/regex/empty fallback.
 */
export const MAX_STRUCTURED_DETAIL_PARSE_BYTES = 1024 * 1024;

export type SafeParseDetailResult =
  | { ok: true; value: unknown }
  | { ok: false; reason: 'too-large' | 'malformed' };

// Throttle the too-large breadcrumb so a transcript full of huge details can't
// flood the log. console.warn is captured into the [Renderer] log stream (see
// AGENTS.md › Renderer console logs) and is process-neutral, so it works on
// every surface without wiring dependency-bearing telemetry infra here.
let lastTooLargeWarnAt = 0;
const TOO_LARGE_WARN_THROTTLE_MS = 5_000;

const warnTooLarge = (length: number, maxBytes: number): void => {
  const now = Date.now();
  if (now - lastTooLargeWarnAt < TOO_LARGE_WARN_THROTTLE_MS) {
    return;
  }
  lastTooLargeWarnAt = now;
  console.warn(
    `[safeParseDetail] declined to JSON.parse a ${length}-char detail (limit ${maxBytes}) to avoid OOM`
  );
};

/**
 * Parse a tool-event `detail` (or `text`) string, refusing to parse anything
 * larger than `opts.maxBytes` (default {@link MAX_DETAIL_PARSE_BYTES}).
 *
 * - `> maxBytes` → `{ ok: false, reason: 'too-large' }` WITHOUT ever calling
 *   `JSON.parse` (the size gate runs before the allocation).
 * - `JSON.parse` throws (malformed, or not a string) → `{ ok: false, reason:
 *   'malformed' }`.
 * - otherwise → `{ ok: true, value }`.
 *
 * Call sites map BOTH `{ ok: false }` reasons onto the same fallback they
 * already take on a parse failure: for ≤budget input behaviour is identical;
 * only pathological (>budget) input now degrades gracefully instead of risking
 * OOM. For valid but >budget JSON this is an accepted behaviour change
 * (structured extraction degrades to the fallback).
 */
export function safeParseDetail(
  detail: string,
  opts?: { maxBytes?: number }
): SafeParseDetailResult {
  const maxBytes = opts?.maxBytes ?? MAX_DETAIL_PARSE_BYTES;
  if (typeof detail !== 'string') {
    return { ok: false, reason: 'malformed' };
  }
  if (detail.length > maxBytes) {
    warnTooLarge(detail.length, maxBytes);
    return { ok: false, reason: 'too-large' };
  }
  try {
    return { ok: true, value: JSON.parse(detail) as unknown };
  } catch {
    return { ok: false, reason: 'malformed' };
  }
}

/**
 * Result of {@link safeParseDetailRecord}: like {@link SafeParseDetailResult},
 * but `ok: true` is guaranteed to carry a plain (non-null, non-array) object.
 */
export type SafeParseDetailRecordResult =
  | { ok: true; value: Record<string, unknown> }
  | { ok: false; reason: 'too-large' | 'malformed' };

/**
 * Record-shaped variant of {@link safeParseDetail} for the common call site that
 * immediately reads object properties off the parsed value.
 *
 * It returns `{ ok: true, value }` ONLY when the parsed JSON is a plain object
 * (non-null, non-array); a valid-but-wrong-shape value (`null`, `42`, `"str"`,
 * `[...]`) is reported as `{ ok: false, reason: 'malformed' }`.
 *
 * Why: before the OOM-class migration these sites parsed inside a `try/catch`
 * and dereferenced the result inside the same `try`, so a non-object value made
 * the property access throw a `TypeError` that fell through to the SAME fallback
 * as a `JSON.parse` failure. With `safeParseDetail` only catching parse errors,
 * that downstream shape error would now throw OUTSIDE any catch. Routing
 * non-object valid JSON to `{ ok: false }` here restores byte-for-byte parity:
 * the call site takes its existing parse-failure fallback, exactly as before.
 */
export function safeParseDetailRecord(
  detail: string,
  opts?: { maxBytes?: number }
): SafeParseDetailRecordResult {
  const result = safeParseDetail(detail, opts);
  if (!result.ok) {
    return result;
  }
  const { value } = result;
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
    return { ok: true, value: value as Record<string, unknown> };
  }
  // Valid JSON, but not a plain object — treat exactly like the old
  // downstream-TypeError fallback (same bucket as malformed).
  return { ok: false, reason: 'malformed' };
}
