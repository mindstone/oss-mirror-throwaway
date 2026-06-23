/**
 * Plugin Source Validator
 *
 * Validates the TSX `source` field of a `/plugins/create` request before it
 * reaches `pluginService.createOrUpdate`. Catches three specific failure modes
 * the LLM-driven plugin pipeline has produced in the wild:
 *
 *   1. Hallucinated placeholder script bodies (e.g.
 *      `<script>/* dashboard logic preserved *\/</script>`) that compile fine
 *      but produce a non-interactive plugin.
 *   2. Inline `onclick` / `onchange` / `onsubmit` / `oninput` references to
 *      handlers that are never defined in the source.
 *   3. Updates that are dramatically smaller than the previous version
 *      without an explicit opt-out comment — symptom of silent content drop.
 *
 * Returns `null` on pass, or a single rejection-reason string on fail. The
 * caller (bridge `/plugins/create` handler) surfaces this verbatim as the
 * HTTP-400 body so the agent reads it as a tool error and can self-correct.
 *
 * See: docs/plans/260527_plugin_agent_experience_overhaul.md — Stage 2
 * Origin: rebel://conversation/5e18e066-3835-4402-8eec-f992d4c6d564
 */

interface HallucinationPattern {
  pattern: RegExp;
  label: string;
}

const HALLUCINATION_PATTERNS: HallucinationPattern[] = [
  {
    // <script>... whose entire body is a comment claiming the JS is preserved.
    pattern:
      /<script[^>]*>\s*\/\*[^*]*(?:preserved|original|see source|TODO|removed for brevity|goes here)[^*]*\*\/\s*<\/script>/i,
    label: 'script body is a placeholder comment',
  },
  {
    // Free-floating "logic preserved" / "content preserved" placeholder
    // comments even when not wrapped in an empty <script> tag.
    pattern: /\/\*\s*(?:dashboard|original|full)\s+(?:logic|content|js)\s+preserved/i,
    label: 'contains a "logic preserved" placeholder comment',
  },
];

// Authors can opt out of the size-sanity guard for a deliberate rewrite.
const SIZE_REWRITE_OPT_OUT_PATTERN = /\/\*\s*intentional\s+rewrite/i;

// Reject updates that drop ≥30% of the previous source length without the
// opt-out comment. 30% is empirical: it catches "stripped <script> body" cases
// (which typically drop 30-80%) while accepting normal refactors.
const SIZE_SHRINK_THRESHOLD = 0.7;

// Absolute floor below which size-sanity is skipped. For very small plugins
// (≤500 chars) the 30% relative threshold is too sensitive — removing a single
// 200-char line from a 500-char plugin would trip it. The size guard exists
// to catch silent content drop, which only matters at meaningful magnitude.
const SIZE_SANITY_MIN_BYTES = 500;

// Match function refs inside inline event handlers. We extract the function
// name (group 1) for the handler-completeness check.
//
// Captures `onclick="fn(args)"`, `onclick='fn(args)'`, `onclick={fn(args)}`,
// etc. for these handler kinds: click | change | submit | input | mouseover
// | mouseout | focus | blur | keydown | keyup. We deliberately exclude
// `onload` / `onerror` because those are commonly used with non-function
// values like inline expressions.
const INLINE_HANDLER_PATTERN =
  /on(?:click|change|submit|input|mouseover|mouseout|focus|blur|keydown|keyup)\s*=\s*["'{]\s*([a-zA-Z_$][a-zA-Z0-9_$]*)\s*\(/g;

/**
 * Check whether `fnName` is defined somewhere in the source. Matches:
 *   - `function fnName(`
 *   - `const fnName = ...`
 *   - `let fnName = ...`
 *   - `var fnName = ...`
 *   - `fnName: function`  (object-method shorthand)
 *   - `fnName = function`  (assignment to a property)
 *   - `async function fnName(`
 */
function isHandlerDefined(source: string, fnName: string): boolean {
  // Escape regex metacharacters in fnName defensively — the inline-handler
  // regex restricts to a safe identifier character class, but escape anyway.
  const escaped = fnName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const definitionPattern = new RegExp(
    `(?:` +
      `(?:async\\s+)?function\\s+${escaped}\\s*\\(` + // function decl
      `|(?:const|let|var)\\s+${escaped}\\s*=` + // const/let/var assignment
      `|\\b${escaped}\\s*:\\s*(?:async\\s+)?function` + // object-method shorthand
      `|\\b${escaped}\\s*=\\s*(?:async\\s+)?function` + // assignment to property
      `|\\b${escaped}\\s*=\\s*\\(?[^=]*=>` + // arrow function assignment
    `)`,
  );
  return definitionPattern.test(source);
}

/**
 * Validate plugin TSX source.
 *
 * @param source       — the TSX source the agent is trying to write
 * @param existing     — the previously stored source for this plugin id, or
 *                       undefined on first create. Required for the size-
 *                       sanity check; first creates skip that check.
 * @returns `null` on pass, or a rejection reason string on fail.
 */
export function validatePluginSource(
  source: string,
  existing: string | undefined,
): string | null {
  // 1. Hallucination patterns — return on first match (most informative).
  for (const { pattern, label } of HALLUCINATION_PATTERNS) {
    if (pattern.test(source)) {
      return `Source ${label}. Re-include the full implementation — do not summarise or omit JavaScript.`;
    }
  }

  // 2. Handler-completeness check. Inline onclick/onchange handlers must
  // reference a function defined somewhere in the source.
  //
  // Note: the regex matches inside comments and string literals too, which
  // produces occasional false positives. The error message is therefore worded
  // to acknowledge both cases — agents that hit a false positive should be
  // able to recognise it from the wording and not blindly strip script bodies.
  const handlerRefs = new Set<string>();
  for (const match of source.matchAll(INLINE_HANDLER_PATTERN)) {
    handlerRefs.add(match[1]);
  }
  const missing = [...handlerRefs].filter((fn) => !isHandlerDefined(source, fn));
  if (missing.length > 0) {
    const plural = missing.length > 1;
    const names = missing.map((n) => `\`${n}\``).join(', ');
    return (
      `Source contains inline onclick/onchange handler${plural ? 's' : ''} referencing ` +
      `${names}, but ${plural ? 'those functions are' : 'that function is'} not defined ` +
      `anywhere in the source. ` +
      `Most common cause: the original <script> body was summarised or stripped — ` +
      `re-include the full handler implementation${plural ? 's' : ''}. ` +
      `False-positive cause (rare): the match came from a comment or string literal — ` +
      `rename the referenced identifier or remove the dead reference.`
    );
  }

  // 3. Size-sanity guard for updates only.
  // Skip on first create (existing === undefined). Skip on tiny plugins
  // (≤ SIZE_SANITY_MIN_BYTES) where small edits can spuriously look like big
  // drops. Skip when the source carries the `/* intentional rewrite */`
  // opt-out comment.
  if (
    existing !== undefined &&
    existing.length > SIZE_SANITY_MIN_BYTES &&
    source.length < existing.length * SIZE_SHRINK_THRESHOLD &&
    !SIZE_REWRITE_OPT_OUT_PATTERN.test(source)
  ) {
    const shrinkPct = Math.round((1 - source.length / existing.length) * 100);
    return (
      `Source is ${shrinkPct}% shorter than the previous version. If you intentionally ` +
      `rewrote it, add the comment \`/* intentional rewrite — original content replaced */\` ` +
      `near the top to confirm. Otherwise, re-include the missing content.`
    );
  }

  return null;
}
