/**
 * Pure sanitiser for corrupted composer drafts.
 *
 * Handles the NBSP-family entities that the pre-fix `@tiptap/markdown`
 * serialiser bled into wire markdown for empty paragraphs (and that already-saved
 * drafts on disk now carry). See FMM rows 1, 6, 9 in
 * `docs/plans/260501_composer_tiptap_atmention_bugfix.md`.
 *
 * Two-context behaviour (H9-amended, post-spike Gemini-Critical — preserves
 * word boundaries):
 *
 *   1. **Empty-paragraph sentinel** — NBSP variant occupying an otherwise-empty
 *      line (between `\n\n` boundaries, OR at start/end of input as the only
 *      content of a line) → strip to empty string. This is the bug-introduced
 *      `EMPTY_PARAGRAPH_MARKDOWN = '&nbsp;'` upstream constant.
 *
 *   2. **Inline NBSP-between-words** — NBSP variant adjacent to non-newline
 *      characters → replace with a single regular space `' '` (NOT empty
 *      string). Gluing words together (`'hello&nbsp;world'` → `'helloworld'`)
 *      loses semantic boundaries and corrupts user content.
 *
 * Variants matched (H9 broader regex coverage):
 *   - `&nbsp;` (lowercase named)
 *   - `&NBSP;` (uppercase named)
 *   - `&#160;` (decimal numeric)
 *   - `&#xA0;` / `&#XA0;` / `&#xa0;` / `&#Xa0;` (hex numeric, both cases)
 *   - `\u00a0` (literal NBSP char)
 *   - `&amp;nbsp;` (double-encoded — drafts that round-tripped through HTML escape)
 *
 * Idempotent: applying twice produces the same result as applying once.
 *
 * Pure: no logging, no metrics, no side effects. Logging happens at the
 * persistence boundaries per Stage 6 of the plan (see C2 amendment in the
 * planning doc — `markdownToDoc` stays pure and silent so per-keystroke cost
 * stays bounded; `sanitisedAt` short-circuit + structured logging live at
 * `useDraftPersistence` / `setDraftForSession` boundaries where session
 * metadata exists).
 */

// Single regex matching all NBSP-family variants (H9 coverage). The
// double-encoded `&amp;nbsp;` is matched first via alternation so the broader
// `&nbsp;` doesn't eat its `nbsp;` tail. Hex variants accept both cases.
const NBSP_VARIANT_RE =
  /&amp;nbsp;|&nbsp;|&NBSP;|&#160;|&#[xX][aA]0;|\u00a0/g;

// Sentinel-context: a NBSP variant occupying the entire content of an
// otherwise-empty line. Boundaries are start-of-input/end-of-input or
// surrounding `\n` characters. Multiple NBSP variants on the same line still
// count as sentinel-context (`&nbsp;&nbsp;` between `\n\n` is a single empty
// line).
const SENTINEL_LINE_RE =
  /(^|\n)((?:&amp;nbsp;|&nbsp;|&NBSP;|&#160;|&#[xX][aA]0;|\u00a0)+)(?=\n|$)/g;

/**
 * Apply the H9-amended sanitiser. Returns the cleaned string.
 *
 * - Sentinel-context NBSP variants (sole content of an otherwise-empty line,
 *   between `\n\n` boundaries or at start/end of input) → stripped (line
 *   becomes empty).
 * - All other NBSP variants → replaced with a single regular space `' '`.
 *
 * Idempotent and pure.
 */
export function sanitiseCorruptedDraftText(input: string): string {
  if (input.length === 0) return input;
  // Step 1: strip sentinel-context runs first. We replace the captured NBSP
  // run with empty string and keep the leading boundary (`^` or `\n`). The
  // lookahead (`(?=\n|$)`) makes the trailing boundary zero-width so adjacent
  // sentinel lines don't consume each other's separators.
  const stripped = input.replace(SENTINEL_LINE_RE, '$1');
  // Step 2: any remaining NBSP variants are inline (adjacent to non-newline
  // characters). Replace with a single regular space to preserve word
  // boundaries.
  return stripped.replace(NBSP_VARIANT_RE, ' ');
}

/**
 * Tally distinct NBSP-family corruption markers found in `input` for diagnostic
 * logging. Returns a stable shape with non-zero counts only — designed for
 * structured logs that must NOT include draft content (PII safe). Used at the
 * persistence/migration boundary to surface *what* kind of corruption was
 * sanitised without leaking the actual user text.
 *
 * Stage 6 of `docs/plans/260501_composer_tiptap_atmention_bugfix.md`.
 */
export function detectCorruptionMarkers(input: string): Record<string, number> {
  if (input.length === 0) return {};
  const tally: Record<string, number> = {};
  const variants: ReadonlyArray<readonly [string, RegExp]> = [
    ['amp;nbsp', /&amp;nbsp;/g],
    ['nbsp', /&nbsp;/g],
    ['NBSP', /&NBSP;/g],
    ['#160', /&#160;/g],
    ['hex-a0', /&#[xX][aA]0;/g],
    ['literal', /\u00a0/g],
  ];
  for (const [name, re] of variants) {
    const matches = input.match(re);
    if (matches && matches.length > 0) {
      tally[name] = matches.length;
    }
  }
  return tally;
}
