/**
 * Shared helper for vitest tests that lint a SYNTHETIC source string against
 * the project's `eslint.config.mjs` via `ESLint.lintText()` — i.e. tests that
 * pass an in-memory string + a fake filePath that does NOT exist on disk and
 * is NOT covered by any tsconfig include glob.
 *
 * Why this exists
 * ───────────────
 * Type-aware ESLint rules (e.g. `@typescript-eslint/no-floating-promises`)
 * call `parserServices.program.getTypeChecker()` during their `create()`
 * callback. If the synthetic filePath isn't in any tsconfig project, the
 * parser bails out before any rule runs — even purely syntactic ones — and
 * the fixture's intended guard (e.g. `no-restricted-syntax`) never fires.
 *
 * The fix is to disable type-aware parsing PLUS the four typed rules that
 * require parser-services. Syntactic rules continue to work, so the test
 * still catches the negative pattern it was written to verify.
 *
 * Source-of-truth alignment: the rule disables MUST match the carve-out in
 * `eslint.config.mjs` for `**\/__lint_fixtures__/**\/*.fixture.{ts,tsx,js}`
 * (currently `eslint.config.mjs:2922-2929`). If you add or remove a typed
 * rule from one place, mirror the change in the other.
 *
 * When NOT to use this helper
 * ───────────────────────────
 * - If your fixture file is a REAL on-disk file in `__lint_fixtures__/` and
 *   covered by the `eslint.config.mjs` carve-out: use `lintFiles` against
 *   the real path; ESLint's config will apply the override automatically.
 * - If your synthetic filePath IS already covered by a tsconfig include glob
 *   (e.g. `src/renderer/utils/...`): use `ESLint.lintText` directly with
 *   `overrideConfigFile`; type-aware parsing will succeed.
 *
 * In doubt, follow the patterns of the 3 callers:
 *   - `scripts/__tests__/check-as-agent-event-rule.test.ts`
 *   - `eslint-rules/__tests__/no-raw-bts-model-read.test.js`
 *   - `src/core/sentry/__tests__/sentryCaptureContractEslintRule.test.ts`
 */

import { ESLint, type Linter } from 'eslint';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..');
const CONFIG_PATH = path.join(REPO_ROOT, 'eslint.config.mjs');

export interface LintSyntheticOptions {
  /**
   * Path to attribute the source to. Should NOT exist on disk; should be
   * outside any tsconfig include glob. The path's directory affects which
   * `eslint.config.mjs` overrides apply, so pick one whose enclosing rules
   * mirror the surface you'd ship the rule against.
   */
  filePath: string;
  /** Source code to lint. */
  source: string;
}

/**
 * Lints a synthetic source string against the project's ESLint config WITHOUT
 * loading type-aware parser services. Returns the first (and only) lint
 * result.
 *
 * See file docstring for when to use this helper vs. `lintText` / `lintFiles`
 * directly.
 */
export async function lintSyntheticFixture(opts: LintSyntheticOptions): Promise<ESLint.LintResult> {
  const eslint = new ESLint({
    cwd: REPO_ROOT,
    overrideConfigFile: CONFIG_PATH,
    overrideConfig: {
      languageOptions: { parserOptions: { project: null, projectService: false } },
      // Mirror eslint.config.mjs:2922-2929 (the __lint_fixtures__ carve-out).
      rules: {
        '@typescript-eslint/no-floating-promises': 'off',
        '@typescript-eslint/no-misused-promises': 'off',
        '@typescript-eslint/await-thenable': 'off',
        '@typescript-eslint/switch-exhaustiveness-check': 'off',
      },
    } as Linter.Config,
  });
  const [result] = await eslint.lintText(opts.source, { filePath: opts.filePath });
  if (!result) {
    throw new Error(`ESLint.lintText returned no result for ${opts.filePath}`);
  }
  return result;
}
