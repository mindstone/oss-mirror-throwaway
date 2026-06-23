#!/usr/bin/env npx tsx
/**
 * CI Validation: every validate:fast-wired gate script must be type-checked.
 *
 * Kills the "a new validate:fast gate script ships silently un-type-checked"
 * class by construction. `tsconfig.node.json`'s `include` is an explicit
 * allowlist, so a `scripts/*.ts` wired into validate:fast but absent from
 * `include` is invisible to `tsc -p tsconfig.node.json` — the Scripts TS-error
 * ratchet FALSE-PASSES (the file is outside the project). The 2026-06-13
 * parallel recs-drain repeatedly hit this: several new check scripts landed
 * un-type-checked, one (`check-tsconfig-strict-flags.test.ts`) carrying a real
 * `string[]`-vs-`string` error that slipped straight through. Recorded as the
 * deferred "(b)" option in docs/project/CODE_HEALTH_TOOLS.md.
 *
 * Approach (mirrors the rot-proof skip-capable-gate-strictness meta-gate):
 *   1. Enumerate the AUTHORITATIVE wired-script set by parsing
 *      scripts/run-validate-fast.ts STEPS commands as TEXT (not by importing the
 *      module) and resolving `npm run <name>` through package.json — same parse
 *      shape as resolveValidateFastScripts() in check-skip-capable-gate-strictness.ts.
 *      Deliberate (small) duplication: importing STEPS would pull run-validate-fast.ts
 *      and its transitive `scripts/checks/*` chain into this gate's type-check scope,
 *      which is exactly the un-type-checked legacy backlog this gate exists to fence.
 *   2. Compute the type-checked set by expanding tsconfig.node.json `include`
 *      minus `exclude` (fast-glob). Coverage == DIRECT include membership: each
 *      gate script must be an explicit project root, not accidentally pulled in
 *      via some import chain.
 *   3. Ratchet against scripts/typecheck-coverage-baseline.json (the grandfathered
 *      legacy backlog — large; drained over time, NOT bulk-fixed here because that
 *      feeds the Scripts TS-error ratchet owned elsewhere):
 *        (a) NEW uncovered wired script (not in baseline) → FAIL: add it to
 *            tsconfig.node.json `include`.
 *        (b) baseline entry no longer uncovered (now covered, or no longer wired)
 *            → FAIL: shrink the baseline (ratchet-down; the set only gets smaller).
 *
 * Run:               npx tsx scripts/check-typecheck-coverage.ts
 * Regenerate baseline: npx tsx scripts/check-typecheck-coverage.ts --write-baseline
 * Wired into: validate:fast (scripts/run-validate-fast.ts)
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import fg from 'fast-glob';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TSCONFIG = 'tsconfig.node.json';
const RUNNER_FILE = 'scripts/run-validate-fast.ts';
const BASELINE_FILE = 'scripts/typecheck-coverage-baseline.json';

const SCRIPT_TOKEN = /scripts\/[A-Za-z0-9_./-]+\.ts/g;
const STEP_COMMAND = /command:\s*'([^']+)'/g;
const NPM_RUN_TOKEN = /npm run ([\w:.-]+)/g;

/**
 * The authoritative set of `scripts/*.ts` files wired into validate:fast.
 * Parses run-validate-fast.ts STEPS commands as text and resolves `npm run <name>`
 * through package.json. Resolution is **transitive** (a body may itself `npm run`
 * another script) and **lifecycle-aware** (npm runs `pre<name>`/`post<name>` around
 * `<name>`, and run-validate-fast preserves those hooks) — both are false-pass
 * vectors if missed: a new un-type-checked script wired via a hook or a nested
 * `npm run` must still be fenced. Cycle-guarded via `visited`.
 *
 * Honest residual: orchestrators other than `npm run` (e.g. `run-s`/`npm-run-all`)
 * are not expanded — the repo convention is `npm run`; revisit if that changes.
 * Exported for unit testing.
 */
export function enumerateWiredScripts(
  runnerSource: string,
  pkgScripts: Readonly<Record<string, string | undefined>>,
): string[] {
  const found = new Set<string>();
  const visited = new Set<string>();

  const scanCommand = (cmd: string): void => {
    for (const tok of cmd.matchAll(SCRIPT_TOKEN)) found.add(tok[0]);
    for (const m of cmd.matchAll(NPM_RUN_TOKEN)) expandNpmScript(m[1]);
  };
  function expandNpmScript(name: string): void {
    if (visited.has(name)) return;
    visited.add(name);
    for (const hook of [`pre${name}`, name, `post${name}`]) {
      const body = pkgScripts[hook];
      if (body) scanCommand(body);
    }
  }

  for (const m of runnerSource.matchAll(STEP_COMMAND)) scanCommand(m[1].trim());
  return [...found].sort();
}

interface TsconfigShape {
  readonly include?: readonly string[];
  readonly exclude?: readonly string[];
}

function loadPackageJsonScripts(): Record<string, string | undefined> {
  const parsed = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')) as {
    scripts?: Record<string, string | undefined>;
  };
  return parsed.scripts ?? {};
}

/**
 * Parse tsconfig.node.json. It is strict JSON today (no comments/trailing commas);
 * keep this a plain JSON.parse so a future JSONC drift fails loudly here rather
 * than silently mis-reading the allowlist.
 */
function loadTsconfig(): TsconfigShape {
  return JSON.parse(fs.readFileSync(path.join(ROOT, TSCONFIG), 'utf8')) as TsconfigShape;
}

/** Files matched by `include` minus `exclude`, as repo-relative posix paths. */
export function computeCoveredSet(tsconfig: TsconfigShape): Set<string> {
  const include = [...(tsconfig.include ?? [])];
  const exclude = [...(tsconfig.exclude ?? [])];
  if (include.length === 0) return new Set();
  const matched = fg.sync(include, {
    cwd: ROOT,
    ignore: exclude,
    onlyFiles: true,
    dot: false,
    // tsconfig include globs are repo-relative posix; fast-glob returns the same.
  });
  return new Set(matched);
}

export interface CoverageResult {
  readonly wired: readonly string[];
  readonly uncovered: readonly string[];
  readonly baseline: readonly string[];
  /** Uncovered wired scripts not grandfathered — the recurrence guard. */
  readonly newlyUncovered: readonly string[];
  /** Baseline entries no longer uncovered (now covered or unwired) — ratchet-down. */
  readonly staleBaseline: readonly string[];
}

export function evaluateCoverage(
  wired: readonly string[],
  covered: ReadonlySet<string>,
  baseline: readonly string[],
): CoverageResult {
  const uncovered = wired.filter((s) => !covered.has(s)).sort();
  const uncoveredSet = new Set(uncovered);
  const baselineSet = new Set(baseline);
  const newlyUncovered = uncovered.filter((s) => !baselineSet.has(s));
  const staleBaseline = baseline.filter((s) => !uncoveredSet.has(s)).sort();
  return { wired, uncovered, baseline, newlyUncovered, staleBaseline };
}

function loadBaseline(): string[] {
  const p = path.join(ROOT, BASELINE_FILE);
  if (!fs.existsSync(p)) return [];
  return JSON.parse(fs.readFileSync(p, 'utf8')) as string[];
}

function loadWiredScripts(): string[] {
  const runnerSource = fs.readFileSync(path.join(ROOT, RUNNER_FILE), 'utf8');
  return enumerateWiredScripts(runnerSource, loadPackageJsonScripts());
}

function computeResult(): CoverageResult {
  const covered = computeCoveredSet(loadTsconfig());
  return evaluateCoverage(loadWiredScripts(), covered, loadBaseline());
}

function main(argv: readonly string[]): number {
  if (argv.includes('--write-baseline')) {
    const wired = loadWiredScripts();
    const covered = computeCoveredSet(loadTsconfig());
    const uncovered = wired.filter((s) => !covered.has(s)).sort();

    // Shrink-only by MECHANICS, not just convention: refuse to write a baseline
    // that ADDS entries (a new un-type-checked wired script) unless the operator
    // explicitly opts in. Otherwise `--write-baseline` could silently absorb the
    // very gap this gate exists to fence (Codex review SHOULD #2).
    const existing = new Set(loadBaseline());
    const additions = uncovered.filter((s) => !existing.has(s));
    if (additions.length > 0 && !argv.includes('--allow-baseline-growth')) {
      process.stderr.write(
        `[check-typecheck-coverage] refusing to GROW the baseline by ${additions.length} ` +
          `entr${additions.length === 1 ? 'y' : 'ies'}:\n` +
          additions.map((s) => `  - ${s}`).join('\n') +
          `\n\nThese are NEW un-type-checked validate:fast-wired scripts. Add each to ${TSCONFIG} ` +
          `"include" (and fix its errors to zero) instead of grandfathering. If a grandfather is ` +
          `genuinely unavoidable, rerun with --allow-baseline-growth (and justify it in review).\n`,
      );
      return 1;
    }

    fs.writeFileSync(
      path.join(ROOT, BASELINE_FILE),
      `${JSON.stringify(uncovered, null, 2)}\n`,
      'utf8',
    );
    const removed = [...existing].filter((s) => !uncovered.includes(s)).length;
    process.stdout.write(
      `[check-typecheck-coverage] wrote ${uncovered.length} grandfathered entr${
        uncovered.length === 1 ? 'y' : 'ies'
      } to ${BASELINE_FILE} (${removed} removed${
        additions.length ? `, ${additions.length} added via --allow-baseline-growth` : ''
      }).\n`,
    );
    return 0;
  }

  const result = computeResult();

  if (result.wired.length === 0) {
    process.stderr.write(
      '[check-typecheck-coverage] FAIL: resolved 0 validate:fast-wired scripts — ' +
        'parser drift in scripts/run-validate-fast.ts STEPS?\n',
    );
    return 1;
  }

  const problems: string[] = [];
  if (result.newlyUncovered.length > 0) {
    problems.push(
      `${result.newlyUncovered.length} validate:fast-wired script(s) are NOT type-checked ` +
        `(absent from ${TSCONFIG} "include") and not grandfathered:\n` +
        result.newlyUncovered.map((s) => `  - ${s}`).join('\n') +
        `\n\nFix: add each to the "include" array in ${TSCONFIG} so \`tsc -p ${TSCONFIG}\` ` +
        `checks it (otherwise it ships un-type-checked and the Scripts ratchet false-passes). ` +
        `Then fix any real errors to zero. Do NOT add it to the baseline.`,
    );
  }
  if (result.staleBaseline.length > 0) {
    problems.push(
      `${result.staleBaseline.length} ${BASELINE_FILE} entr${
        result.staleBaseline.length === 1 ? 'y is' : 'ies are'
      } no longer un-type-checked (now covered, or no longer wired). ` +
        `The baseline only shrinks — remove ${
          result.staleBaseline.length === 1 ? 'it' : 'them'
        }:\n` +
        result.staleBaseline.map((s) => `  - ${s}`).join('\n') +
        `\n\nFix: rerun \`npx tsx scripts/check-typecheck-coverage.ts --write-baseline\`.`,
    );
  }

  if (problems.length > 0) {
    process.stderr.write(`[check-typecheck-coverage] FAIL\n\n${problems.join('\n\n')}\n`);
    return 1;
  }

  process.stdout.write(
    `[check-typecheck-coverage] PASS: ${result.wired.length} validate:fast-wired scripts; ` +
      `${result.wired.length - result.uncovered.length} type-checked, ` +
      `${result.uncovered.length} grandfathered (baseline-tracked legacy backlog).\n`,
  );
  return 0;
}

// Only run when invoked directly (not when imported by the unit test).
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(main(process.argv.slice(2)));
}
