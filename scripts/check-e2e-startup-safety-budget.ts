#!/usr/bin/env npx tsx
/**
 * CI Validation: E2E safety-timeout vs CI perf-budget contract guard.
 *
 * Guards the regression class from
 * docs-private/postmortems/260531_ci_aware_startup_probe_timeout_per_85853eb_postmortem.md:
 * the E2E startup SAFETY abort timeout (STARTUP_PROBE_TIMEOUT_MS in
 * tests/e2e/test-utils.ts) was once 5000ms, while the documented CI startup
 * PERF budget (the warn threshold in tests/e2e/perf-timing-signals.spec.ts)
 * treated 6000ms on CI as within-envelope. A safety abort that fires *below*
 * the documented normal-startup envelope produces false `SAFETY ABORT:
 * startup-probe-timeout` failures on the tired-runner release lane.
 *
 * The prevention the postmortem recommends (Prevention, action 1):
 *   "Add a CI/test-infrastructure contract check that fails when E2E safety
 *    timeouts sit below the documented CI perf budget for the same lifecycle
 *    phase."
 *
 * This is that check. It is INTENTIONALLY DISTINCT from
 * scripts/check-e2e-timeout-budget.ts, which guards the opposite direction
 * (fixed `firstWindow({ timeout })` literals ABOVE 30_000ms, from a different
 * 260531 voice-session-routing postmortem). This script asserts the inverse
 * invariant for the startup lifecycle phase:
 *
 *     safetyTimeoutMs  >  perfBudgetMs       (strictly above)
 *
 * A safety abort must keep headroom over the documented normal-startup
 * envelope; if it is at or below the perf budget, a normal slow-but-fine
 * startup trips the abort.
 *
 * Extraction is FAIL-CLOSED: if an anchored extractor no longer matches its
 * source (the literal moved/renamed), the check FAILS loudly with an
 * actionable message rather than silently passing — the standard anti-rot
 * posture, so the guard can't rot into a permanent no-op.
 *
 * Run: npx tsx scripts/check-e2e-startup-safety-budget.ts
 * Wired into: npm run validate:fast (STEP check-e2e-startup-safety-budget).
 */

import * as fs from 'fs';
import * as path from 'path';

const ROOT = path.join(__dirname, '..');

/** Extracts a single ms value from a file, or fails closed with `reason`. */
export interface ValueExtractor {
  /** Repo-relative source file the value is read from (for messages). */
  readonly file: string;
  /** Pulls the ms value out of the file text; returns null if the anchor is gone. */
  readonly extract: (fileText: string) => number | null;
  /** Human description of what is being read (for fail-closed messages). */
  readonly label: string;
}

/** One lifecycle-phase contract: a safety timeout that must exceed a perf budget. */
export interface PhaseBudgetContract {
  /** Lifecycle phase name (e.g. "startup"). */
  readonly phase: string;
  /** The E2E safety-abort timeout for this phase (must be strictly greater). */
  readonly safety: ValueExtractor;
  /** The documented CI perf budget for this phase (the floor the safety must clear). */
  readonly perfBudget: ValueExtractor;
}

export type BudgetCheckOutcome =
  | { readonly kind: 'ok'; readonly phase: string; readonly safetyMs: number; readonly perfBudgetMs: number }
  | { readonly kind: 'violation'; readonly phase: string; readonly safetyMs: number; readonly perfBudgetMs: number }
  | { readonly kind: 'extract-failed'; readonly phase: string; readonly which: 'safety' | 'perfBudget'; readonly file: string; readonly label: string };

/**
 * Parse `N` or `N_NNN` (numeric-separator) ms literals. Returns null for
 * anything that is not a bare integer literal so a refactor to an expression
 * surfaces as a fail-closed extract failure rather than a wrong number.
 */
function parseMsLiteral(raw: string): number | null {
  const trimmed = raw.trim();
  // Bare integer literal with optional numeric separators in the canonical
  // positions only (between digits) — `_3000` / `3000_` / `30__00` are NOT
  // valid TS numeric literals and must not parse.
  if (!/^\d+(?:_\d+)*$/.test(trimmed)) return null;
  return Number(trimmed.replace(/_/g, ''));
}

/**
 * Strip `//` line comments and block comments so an anchored extractor cannot
 * be satisfied by COMMENTED-OUT old source (which would return a stale passing
 * literal and defeat the fail-closed posture). Naive but sufficient: the
 * extractors only match assignment sites, and our source files do not embed
 * `//` or `/* *​/` inside string literals on the guarded lines. (Codex review
 * SHOULD, recs7.)
 */
export function stripComments(sourceText: string): string {
  return sourceText
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

/**
 * STARTUP_PROBE_TIMEOUT_MS CI default in tests/e2e/test-utils.ts. The source
 * shape is:
 *   const STARTUP_PROBE_TIMEOUT_MS = process.env.CI
 *     ? Number(process.env.E2E_STARTUP_PROBE_TIMEOUT_MS) || 30_000
 *     : ...
 * We read the CI-branch fallback literal (the `|| <N>` after the CI env read).
 */
export function extractStartupProbeCiDefault(fileText: string): number | null {
  // Anchor on the CI ternary branch: `process.env.CI` ... `|| <literal>`.
  // `[^?:]*?` assumes a FLAT CI branch (no nested ternary before the `||`); a
  // nested-ternary refactor simply fails to match → fail-closed, never wrong.
  const m = stripComments(fileText).match(
    /STARTUP_PROBE_TIMEOUT_MS\s*=\s*process\.env\.CI\s*\?[^?:]*?\|\|\s*([0-9_]+)/,
  );
  if (!m) return null;
  return parseMsLiteral(m[1]);
}

/**
 * The documented CI startup perf warn budget in
 * tests/e2e/perf-timing-signals.spec.ts. Source shape:
 *   const warnThreshold = isCI ? 6000 : 3000;
 * We read the CI branch literal (the value between `?` and `:`).
 */
export function extractStartupPerfCiBudget(fileText: string): number | null {
  const m = stripComments(fileText).match(/warnThreshold\s*=\s*isCI\s*\?\s*([0-9_]+)\s*:/);
  if (!m) return null;
  return parseMsLiteral(m[1]);
}

/** The startup-phase contract wired against the real source files. */
export function startupPhaseContract(root: string = ROOT): PhaseBudgetContract {
  return {
    phase: 'startup',
    safety: {
      file: 'tests/e2e/test-utils.ts',
      label: 'STARTUP_PROBE_TIMEOUT_MS CI default (E2E startup safety-abort timeout)',
      extract: extractStartupProbeCiDefault,
    },
    perfBudget: {
      file: 'tests/e2e/perf-timing-signals.spec.ts',
      label: 'warnThreshold CI value (documented CI startup perf budget)',
      extract: extractStartupPerfCiBudget,
    },
  };
}

/**
 * Pure evaluation: for each contract, read both values and assert the safety
 * timeout is strictly greater than the perf budget. Reads files via `readFile`
 * so tests can inject synthetic source.
 */
export function evaluateBudgetContracts(
  contracts: readonly PhaseBudgetContract[],
  readFile: (relPath: string) => string,
): BudgetCheckOutcome[] {
  const outcomes: BudgetCheckOutcome[] = [];
  for (const contract of contracts) {
    const safetyMs = contract.safety.extract(readFile(contract.safety.file));
    if (safetyMs === null) {
      outcomes.push({ kind: 'extract-failed', phase: contract.phase, which: 'safety', file: contract.safety.file, label: contract.safety.label });
      continue;
    }
    const perfBudgetMs = contract.perfBudget.extract(readFile(contract.perfBudget.file));
    if (perfBudgetMs === null) {
      outcomes.push({ kind: 'extract-failed', phase: contract.phase, which: 'perfBudget', file: contract.perfBudget.file, label: contract.perfBudget.label });
      continue;
    }
    if (safetyMs > perfBudgetMs) {
      outcomes.push({ kind: 'ok', phase: contract.phase, safetyMs, perfBudgetMs });
    } else {
      outcomes.push({ kind: 'violation', phase: contract.phase, safetyMs, perfBudgetMs });
    }
  }
  return outcomes;
}

function main(): void {
  const contract = startupPhaseContract();
  const readFile = (relPath: string): string => fs.readFileSync(path.join(ROOT, relPath), 'utf8');
  const outcomes = evaluateBudgetContracts([contract], readFile);

  const extractFailures = outcomes.filter((o) => o.kind === 'extract-failed');
  const violations = outcomes.filter((o) => o.kind === 'violation');

  if (extractFailures.length > 0) {
    console.error('\n❌ check-e2e-startup-safety-budget: could not locate a guarded value (source shape drifted):\n');
    for (const f of extractFailures) {
      if (f.kind !== 'extract-failed') continue;
      console.error(`  [${f.phase}] ${f.which}: ${f.label}\n      expected in ${f.file} — update the anchored extractor in scripts/check-e2e-startup-safety-budget.ts`);
    }
    console.error(
      '\nThis guard fails CLOSED on purpose: if it cannot read the safety timeout or the perf\n' +
        'budget, it must not silently pass. Fix the extractor to match the new source shape.\n',
    );
    process.exit(1);
  }

  if (violations.length > 0) {
    console.error('\n❌ E2E safety timeout sits at/below the documented CI perf budget:\n');
    for (const v of violations) {
      if (v.kind !== 'violation') continue;
      console.error(`  [${v.phase}] safety abort = ${v.safetyMs}ms ≤ CI perf budget = ${v.perfBudgetMs}ms`);
    }
    console.error(
      '\nA safety-abort timeout must stay STRICTLY ABOVE the documented CI perf budget for the\n' +
        'same lifecycle phase, or a normal slow-but-fine run on a tired CI runner trips the abort\n' +
        '(the 260531 startup-probe regression: a 5000ms safety probe under a 6000ms CI startup\n' +
        'perf budget). Raise STARTUP_PROBE_TIMEOUT_MS (tests/e2e/test-utils.ts) or lower the perf\n' +
        'budget (warnThreshold in tests/e2e/perf-timing-signals.spec.ts) so safety > budget.\n' +
        '\nSee docs-private/postmortems/260531_ci_aware_startup_probe_timeout_per_85853eb_postmortem.md.\n',
    );
    process.exit(1);
  }

  for (const o of outcomes) {
    if (o.kind === 'ok') {
      console.log(`✔ [${o.phase}] safety abort ${o.safetyMs}ms > CI perf budget ${o.perfBudgetMs}ms`);
    }
  }
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`Failed to check E2E startup safety budget: ${message}\n`);
    process.exit(1);
  }
}
