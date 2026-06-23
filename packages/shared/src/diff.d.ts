// Minimal ambient module declaration for the `diff` package.
// We could install `@types/diff`, but only `diffLines` is consumed in
// packages/shared/src/diff.ts, so a small targeted declaration is sufficient
// and avoids monorepo-wide lockfile churn.

declare module 'diff' {
  export interface Change {
    value: string;
    added?: boolean;
    removed?: boolean;
    count?: number;
  }
  export interface DiffOptions {
    ignoreCase?: boolean;
    ignoreWhitespace?: boolean;
    newlineIsToken?: boolean;
    stripTrailingCr?: boolean;
  }
  export function diffLines(
    oldStr: string,
    newStr: string,
    options?: DiffOptions,
  ): Change[];
}
