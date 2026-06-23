/**
 * Shared text-processing helpers for ratchet/code-health scripts that need
 * to reason about TypeScript source without pulling in a full AST parser.
 *
 * Origin: 260523 follow-up sweep, closer-round-2 Stage 4. Three reviewers
 * (Opus, Gemini, Completeness) converged on the same structural finding:
 * raw regex counting against file content trips on string literals, comment
 * text, and lint-fixture files. This module is the shared fix.
 */

const PRODUCTION_PATH_EXCLUSIONS = [
  '__tests__',
  '.test.',
  '.spec.',
  '.stories.',
  '__lint_fixtures__',
];

/**
 * Heuristic check for whether a file path looks like production source vs
 * a test, story, or lint-fixture file. Used by ratchet scripts that want
 * to count escape hatches only in production code.
 *
 * The check is path-segment based and tolerates both POSIX and Windows
 * separators.
 */
export function isProductionSourcePath(filePath: string): boolean {
  const normalized = filePath.replace(/\\/g, '/');
  return !PRODUCTION_PATH_EXCLUSIONS.some(segment => normalized.includes(segment));
}

/**
 * Strip comment content from TypeScript / JavaScript source, replacing
 * comment text with spaces so line numbers and column positions are
 * preserved. Useful for ratchet scripts that count code-level occurrences
 * of a pattern (e.g. `z.unknown()`) without false positives from doc
 * comments that mention the literal token.
 *
 * Handles:
 *   - `// line` comments through end of line
 *   - block comments
 *   - string literals (single, double, backtick) — pattern characters
 *     inside strings are preserved (we only mask comments)
 *
 * Does NOT handle:
 *   - Nested template-literal interpolations (treated as part of the
 *     template string content; this is conservative and safe for our
 *     counting use case)
 *   - JSX comment forms — irrelevant for the .ts files we scan in IPC
 *   - **Regex literals whose body ends in an escaped slash**, e.g.
 *     `/^https?:\/\//i`. The character-based tokenizer here does not
 *     track regex-literal context, so when it reaches the trailing
 *     escaped-slash+terminator sequence (`\`, `/`, `/`), it interprets
 *     the last two `/` characters as the start of a `//` line comment
 *     and masks the remainder of the line. **Consequence:** if a
 *     future contributor adds (for example) `as any` or `z.unknown()`
 *     on the same line after such a regex, the ratchet would silently
 *     UNDER-count that directive. (Note: regex literals where the
 *     escaped slashes are surrounded by other characters — e.g.
 *     `/foo\/\/bar/` produces source chars `\`, `/`, `\`, `/` with no
 *     adjacent `//` pair — do NOT fire this bug; only the
 *     "escaped-slash-immediately-before-terminator" shape does.) The
 *     260523 round-4 review audited the affected production files and
 *     confirmed zero current-state miscount, but the trap is real.
 *     Proper fix when this becomes worth the dependency cost: migrate
 *     this helper to the TypeScript compiler API
 *     (`ts.createSourceFile` + scanner), which tracks
 *     regex/template/string context natively.
 *
 * Bug shape this prevents: regex matching the literal string
 * `z.unknown()` inside a `// JsonValueSchema replaces z.unknown() ...`
 * doc comment, which caused a false-positive ratchet failure during the
 * 260523 sweep Stage 1.
 */
export function stripComments(source: string): string {
  const result: string[] = [];
  let i = 0;
  const len = source.length;

  while (i < len) {
    const ch = source[i];
    const next = i + 1 < len ? source[i + 1] : '';

    if (ch === '/' && next === '/') {
      // Line comment: replace with spaces up to (but not including) newline.
      result.push('  ');
      i += 2;
      while (i < len && source[i] !== '\n') {
        result.push(' ');
        i += 1;
      }
      continue;
    }

    if (ch === '/' && next === '*') {
      // Block comment: replace with spaces, preserve newlines so line
      // numbers stay aligned for downstream consumers.
      result.push('  ');
      i += 2;
      while (i < len) {
        if (source[i] === '*' && i + 1 < len && source[i + 1] === '/') {
          result.push('  ');
          i += 2;
          break;
        }
        result.push(source[i] === '\n' ? '\n' : ' ');
        i += 1;
      }
      continue;
    }

    if (ch === '"' || ch === "'" || ch === '`') {
      const quote = ch;
      result.push(ch);
      i += 1;
      while (i < len) {
        const c = source[i];
        if (c === '\\' && i + 1 < len) {
          result.push(c, source[i + 1]);
          i += 2;
          continue;
        }
        result.push(c);
        i += 1;
        if (c === quote) break;
        if (c === '\n' && quote !== '`') break;
      }
      continue;
    }

    result.push(ch);
    i += 1;
  }

  return result.join('');
}
