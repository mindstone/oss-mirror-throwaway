/**
 * Narrow ambient type declaration for the `diff` (jsdiff) package.
 *
 * `diff@5.2.2` ships without bundled `.d.ts` files, and we don't want to
 * add `@types/diff` as a separate dev-dep just to describe the single
 * function we consume. This declaration covers only the surface area
 * used by `./diff.ts`:
 *
 *   - `diffLines(oldStr, newStr, options?)` → returns a change-object
 *     array where each entry is either an unchanged run, an added run,
 *     or a removed run.
 *
 * Keep this narrow — if we start using more of jsdiff later, either
 * widen this declaration or switch to `@types/diff`.
 */

declare module 'diff' {
  export interface Change {
    /** Content of this run (lines joined, line endings preserved). */
    value: string;
    /** True when this run exists only on the new side. */
    added?: boolean;
    /** True when this run exists only on the old side. */
    removed?: boolean;
    /** Number of tokens (lines) in this run. */
    count?: number;
  }

  export interface DiffLinesOptions {
    /** When true, newline tokens are diffed separately from content. */
    newlineIsToken?: boolean;
    /** When true, leading/trailing whitespace is ignored during tokenization. */
    ignoreWhitespace?: boolean;
    /** When true, matches are case-insensitive. */
    ignoreCase?: boolean;
    /** When true, a trailing `\r` before `\n` is stripped before comparison. */
    stripTrailingCr?: boolean;
  }

  export function diffLines(
    oldStr: string,
    newStr: string,
    options?: DiffLinesOptions,
  ): Change[];
}
