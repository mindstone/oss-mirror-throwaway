#!/usr/bin/env npx tsx
/**
 * Husky pre-push fast-tier contract smoke test (260419 prepush postmortem A3).
 *
 * Hard-asserts the **primary invariant** that the 260419 regression broke:
 *
 *   `VITEST_FAST=1` MUST precede every `vitest related --run` invocation
 *   inside `.husky/pre-push`.
 *
 * Why it matters: `vitest.config.ts` only filters `**\/*.integration.*`
 * out of the test scope when `VITEST_FAST=1` is set. The 260419 fix
 * commit (`7780344bb`) reintroduced `xargs -0 env VITEST_FAST=1 ...`; an
 * accidental rewrite of that line that drops the env flag would silently
 * re-enable live-API integration tests in the pre-push hook and cause
 * 404s on developers' own pushes. This check fails fast and loud.
 *
 * Defense in depth: this script also documents, but does not hard-fail
 * on, the related fast-tier invariants the same hook depends on. They
 * are flagged as comments + soft warnings so that the next editor of
 * `.husky/pre-push` sees the full surface and does not accidentally
 * regress one of them. If you regress one of these, CI / local pre-push
 * still runs — the soft signal is for human review during PR.
 *
 * Related invariants (defense-in-depth, not hard-failed by this script):
 *   - **Branch filter**: `current_branch=$(git rev-parse --abbrev-ref HEAD ...)`
 *     and the `case` statements that derive `is_beta` / `is_production` /
 *     `skip_tests` from the commit message + branch name. Removing these
 *     breaks tier selection.
 *   - **File-type filter**: the `git show --name-only ... -- '*.ts' '*.tsx'`
 *     pattern restricting `vitest related` to TypeScript files. Without
 *     it, `vitest related` would attempt to resolve markdown / JSON / etc
 *     and emit confusing errors.
 *   - **`merged_files` subshell pattern**: the `for merge_hash in ...; do
 *     merged_raw="$merged_raw\n$(git diff ...)"; done` block that collects
 *     upstream-merged files for Tier 2 / Tier 3. A regression here would
 *     silently drop upstream mock-drift coverage.
 *   - **Spec-test exclusion grep**: `grep -vE '\.(test|spec)\.(ts|tsx)$'`
 *     — `vitest related` against test files is a no-op + adds noise.
 *
 * Pattern reference: see `scripts/check-husky-hooks-path.ts` for the
 * canonical "validate:fast smoke check" shape this script follows.
 *
 * Run via: `npx tsx scripts/check-husky-pre-push-fast-tier.ts`
 * Wired into `npm run validate:fast`.
 *
 * @see docs-private/postmortems/260419_prepush_live_api_integration_test_404_postmortem.md
 * @see docs/plans/260419_prepush_followups_roadmap.md
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HOOK_PATH = path.join(ROOT, '.husky', 'pre-push');

/**
 * Result of evaluating a `.husky/pre-push` source string.
 *
 * `ok=true` ⇒ primary invariant holds (every `vitest related --run`
 * invocation is preceded by `VITEST_FAST=1` on the same logical line /
 * pipeline). Any `softWarnings` are advisory — they flag related
 * defense-in-depth invariants that look weakened but do not fail this
 * gate.
 */
export interface FastTierCheckResult {
  ok: boolean;
  /** Hard-fail diagnostic messages. Non-empty when `ok=false`. */
  errors: readonly string[];
  /** Soft advisory messages flagging related-invariant drift. */
  softWarnings: readonly string[];
  /** Number of `vitest related --run` occurrences detected. */
  vitestRelatedOccurrences: number;
  /** Number of those occurrences that were correctly preceded by VITEST_FAST=1. */
  vitestRelatedFastGated: number;
}

/**
 * Pure source-string evaluator (exported for unit tests).
 *
 * Strategy:
 *   1. Find every line containing `vitest related --run` (the primary
 *      pre-push test invocation).
 *   2. For each such line, verify that **the same line** also contains
 *      `VITEST_FAST=1` somewhere before the `vitest` token. We deliberately
 *      check the same line rather than nearby lines because the pre-push
 *      hook uses a `xargs -0 env VITEST_FAST=1 npx vitest related --run`
 *      pipeline — the env-var setter sits on the same logical command
 *      line as the vitest invocation. Splitting them is the regression
 *      we are guarding against.
 *   3. Soft-warn (no hard fail) when other defense-in-depth markers are
 *      missing.
 *
 * Edge cases:
 *   - Comment lines (`# ...`) starting with `#` are ignored when matching.
 *     A comment that mentions `vitest related --run` is documentation,
 *     not a real invocation.
 *   - Multi-statement lines using `&&` / `;` / `|` are matched as one
 *     line; the same-line check still applies.
 */
export function checkFastTierContract(source: string): FastTierCheckResult {
  const lines = source.split('\n');
  const errors: string[] = [];
  const softWarnings: string[] = [];

  let vitestRelatedOccurrences = 0;
  let vitestRelatedFastGated = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trimStart();
    // Skip pure comment lines — they are documentation about the
    // command, not the command itself.
    if (trimmed.startsWith('#')) continue;

    if (line.includes('vitest related --run')) {
      vitestRelatedOccurrences++;
      const vitestIdx = line.indexOf('vitest related --run');
      // Look for VITEST_FAST=1 anywhere before the vitest token on the
      // same line. The xargs/env pipeline puts it earlier on the same
      // command pipeline (logical line).
      const beforeVitest = line.slice(0, vitestIdx);
      if (beforeVitest.includes('VITEST_FAST=1')) {
        vitestRelatedFastGated++;
      } else {
        errors.push(
          `.husky/pre-push:${i + 1}: 'vitest related --run' is not preceded by 'VITEST_FAST=1' on the same line — this is the 260419 regression class. Pre-push will execute live-API integration tests.`,
        );
      }
    }
  }

  // Defense-in-depth soft warnings (advisory only).
  if (!source.includes('git rev-parse --abbrev-ref HEAD')) {
    softWarnings.push(
      "Soft: '.husky/pre-push' no longer reads the current branch via 'git rev-parse --abbrev-ref HEAD' — branch-filter-driven tier selection (Tier 1/2/3) may be broken.",
    );
  }
  if (!/'\*\.ts'\s+'\*\.tsx'/.test(source) && !source.includes("'*.ts' '*.tsx'")) {
    softWarnings.push(
      "Soft: '.husky/pre-push' no longer restricts file collection to '*.ts' / '*.tsx' — vitest related may attempt to resolve non-TS files.",
    );
  }
  if (!/for\s+merge_hash\s+in/.test(source)) {
    softWarnings.push(
      "Soft: '.husky/pre-push' no longer iterates 'for merge_hash in ...' to collect upstream-merged files — Tier 2/3 mock-drift coverage may be silently dropped.",
    );
  }
  if (!source.includes('(test|spec)') || !/grep\s+-vE/.test(source)) {
    softWarnings.push(
      "Soft: '.husky/pre-push' no longer excludes '*.(test|spec).(ts|tsx)' from the related-tests scope — vitest related against test files is a no-op + noise.",
    );
  }

  if (vitestRelatedOccurrences === 0) {
    errors.push(
      ".husky/pre-push contains no 'vitest related --run' invocation — the fast-tier related-tests gate has been removed entirely. If this is intentional, remove or update this check; otherwise restore the invocation with VITEST_FAST=1.",
    );
  }

  return {
    ok: errors.length === 0,
    errors,
    softWarnings,
    vitestRelatedOccurrences,
    vitestRelatedFastGated,
  };
}

function readHookOrFail(hookPath: string): string {
  try {
    return fs.readFileSync(hookPath, 'utf8');
  } catch (err) {
    console.error(`❌ Failed to read .husky/pre-push at ${hookPath}`);
    console.error(`   ${err instanceof Error ? err.message : err}`);
    process.exit(1);
  }
}

export function main(): void {
  console.log('🪝 Husky pre-push fast-tier contract check');
  console.log('==========================================\n');

  const source = readHookOrFail(HOOK_PATH);
  const result = checkFastTierContract(source);

  for (const w of result.softWarnings) {
    console.warn(`⚠️  ${w}`);
  }

  if (!result.ok) {
    console.error('');
    for (const e of result.errors) {
      console.error(`❌ ${e}`);
    }
    console.error('');
    console.error('   Fast-tier invariant broken. The 260419 regression class');
    console.error('   re-enables live-API integration tests in pre-push.');
    console.error('   Restore VITEST_FAST=1 ahead of every vitest related --run.');
    console.error('');
    console.error('   See: docs-private/postmortems/260419_prepush_live_api_integration_test_404_postmortem.md');
    process.exit(1);
  }

  console.log(
    `✅ All ${result.vitestRelatedOccurrences} 'vitest related --run' invocation(s) are gated by VITEST_FAST=1.`,
  );
  if (result.softWarnings.length > 0) {
    console.log(
      `   (${result.softWarnings.length} defense-in-depth advisory note(s) above — not blocking.)`,
    );
  }
}

// Only invoke main when executed as a script (not when imported by tests).
const invokedDirectly = process.argv[1] === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  main();
}
