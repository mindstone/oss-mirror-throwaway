#!/usr/bin/env tsx
/**
 * ESLint warning ratchet — prevents new warnings from being introduced.
 *
 * Per-rule baselines reflect the current warning count for each named rule.
 * If a rule's count exceeds its baseline, the script fails.
 * When you fix warnings, lower the baseline!
 *
 * Catch-all policy: NO NEW RULES. Any warning emitted by a rule not in the
 * baseline map causes failure (forces explicit triage when new lint rules
 * start firing).
 *
 * The `null`-ruleId bucket is tracked separately as a single baseline.
 *
 * Usage: npx tsx scripts/check-eslint-warnings.ts [--repeat=N]
 */
import { fileURLToPath } from 'node:url';
import {
  createDefaultEslintRunner,
  runEslintAudit,
  type EslintAuditResult,
  type EslintRunner,
} from './lib/eslint-warning-audit';
import {
  SILENT_SWALLOW_RULE_ID,
  checkSilentSwallowSurfaceParity,
  formatSilentSwallowSurfaceParityReport,
} from './silent-swallow-budgets';

/**
 * Rules that are deliberately NOT count-ratcheted by this script and so must be
 * exempt from the "NO NEW RULES" catch-all below (otherwise their existing `warn`
 * population would trip the catch-all the moment their explicit baseline is
 * removed).
 *
 * `rebel-silent-swallow/no-silent-swallow`: its count baseline was retired in
 * Stage 3 (docs/plans/260612_silent-swallow-gate/PLAN.md, D1) because the hot
 * drift-reconciled number caused constant merge contention. It is now gated
 * per-change by the diff-scoped `validate:eslint-new-warnings`, with the
 * `npm run lint --max-warnings 3000` cap as the coarse mass-regression backstop
 * and silent-swallow-rule-presence.test.ts asserting the rule is still wired and
 * firing. So its pre-existing `warn`s here are expected and intentionally
 * untracked — NOT a "new rule" that needs triage.
 */
export const INTENTIONALLY_UNTRACKED_RULES: ReadonlySet<string> = new Set([
  SILENT_SWALLOW_RULE_ID,
]);

export interface RuleBaseline {
  ruleId: string;
  baseline: number;
}

export interface BaselineFailure {
  ruleId: string;
  observed: number;
  baseline: number;
  kind: 'regression' | 'new_rule';
}

export interface BaselineCheckResult {
  failed: boolean;
  failures: BaselineFailure[];
}

export interface MainOptions {
  runner?: EslintRunner;
  logger?: Pick<Console, 'error' | 'log' | 'warn'>;
  baselines?: ReadonlyArray<RuleBaseline>;
  surfaceParityAuditPaths?: readonly string[];
  args?: string[];
}

// 260614 (64→63): weekly ratchet sweep — count dropped one below baseline
// (the check's own below-baseline warn). Tightened to lock the gain.
// 260618 (63→62): source-search status-signaling removed two now-unused
// `semanticSearch` imports (bridge + plugin handler). Lock the gain.
export const BASELINE_NO_UNUSED_VARS = 62;
export const BASELINE_NO_EXPLICIT_ANY = 71;
// 260601: recalibrated to true current counts on the model-role tooltip branch's merge base
// (37→33, 25→24, 15→14 — all below the prior baselines, i.e. improvements/drift-down on surfaces
// this change does not touch). Below-baseline is advisory, not a failure, but locking the exact
// counts in keeps the ratchet tight.
// 260622: drift-down 33→31 (weekly trend-debt ratchet-tighten); lock in the improvement.
export const BASELINE_NO_NON_NULL_ASSERTION = 31;
export const BASELINE_NO_USE_BEFORE_DEFINE = 24;
// 260607 (OSS B6 Stage 1): +1 for the ambient `__REBEL_IS_OSS__` vite
// build-define global in src/renderer/env.d.ts. It uses the established dunder
// build-define convention (cf. __REBEL_VERSION__ / __BUILD_DATE__) which the
// UPPER_CASE naming-convention format flags on its trailing underscores. The
// name MUST match the literal injected by the renderer vite configs, so the
// dunder form is load-bearing, not stylistic.
export const BASELINE_NAMING_CONVENTION = 15;
// no-empty was promoted from `warn` to `error` in eslint.config.mjs after the
// 260525_no-empty-drain-and-extend sweep drained all 16 src/** sites. Once at
// error severity the rule no longer emits warnings, so this baseline is a
// belt-and-suspenders backstop: if anyone reverts the severity to `warn`, the
// 0-baseline still catches regressions in the warning ratchet.
export const BASELINE_NO_EMPTY = 0;
export const BASELINE_NO_CONSOLE = 0;
// NOTE (260612, docs/plans/260612_silent-swallow-gate/PLAN.md Stage 3): the
// silent-swallow COUNT baseline that used to live here (`BASELINE_SILENT_SWALLOW`,
// a single hot number + its per-surface map in silent-swallow-budgets.ts) was
// RETIRED. It was the source of constant merge contention (~47 commits / 30 days,
// a running drift-reconcile ledger that conflicted on nearly every concurrent
// branch). Silent-swallow is no longer count-ratcheted here: new swallows are
// caught per-change by `validate:eslint-new-warnings` (diff-scoped, Stage 1); the
// `npm run lint --max-warnings 3000` total cap (package.json `lint`) is the coarse
// mass-regression backstop and must NEVER be ratcheted down on drift; rule-presence
// (a disabled rule drops the count to 0, under any cap) is asserted by
// scripts/__tests__/silent-swallow-rule-presence.test.ts. The surface-PARITY guard
// (orthogonal to counts) stays — see checkSilentSwallowSurfaceParity below.
// DI-22 (260603): rebel-switch-exhaustiveness/no-bare-default-bypass promoted warn→error.
// At error severity the rule no longer emits warnings; 0-baseline backstops regressions if
// severity is ever reverted to warn.
export const BASELINE_SWITCH_EXHAUSTIVENESS = 0;
// Stages 6.1-6.4 of docs/plans/260522_compile-time-reliability/PLAN.md enabled
// the 4 type-aware rules below across src/main/** + src/core/** + cloud-service/src/**:
//   - @typescript-eslint/no-floating-promises  (203 baseline)
//   - @typescript-eslint/no-misused-promises   (34 baseline)
//   - @typescript-eslint/await-thenable        (25 baseline)
//   - @typescript-eslint/switch-exhaustiveness-check (28 baseline)
// All at `warn` severity in the broad block; the Stage 6.1 hot zone (5 files)
// has a narrow override block that promotes the first 3 to `error` for those
// files. The baselines absorb existing populations; DI-22/23/24/25 (paired
// promotion sweep) lower the count to 0 and promote to `error` codebase-wide
// during Stage 6.5's CI wiring sweep.
// NOTE: baselines below were measured pre-merge with origin/dev; re-measure
// after merging in if origin/dev's new code introduced additional violations
// in src/main/** + src/core/** + cloud-service/src/**.
// DI-22 (260603): @typescript-eslint/switch-exhaustiveness-check promoted warn→error.
// At error severity the rule no longer emits warnings; 0-baseline backstops regressions if
// severity is ever reverted to warn.
export const BASELINE_SWITCH_EXHAUSTIVENESS_TYPE_AWARE = 0;
// 205 → 183 (DI-23, 260606): cloud-service/src cleared (22 sites incl. sendJson chokepoint) + flipped to error in the cloud block.
// 183 → 151 (DI-23 Stage 3b, 260607): src/core/** cleared (25 sites, void→fireAndForget).
// 151 → 30 (DI-23 Stage 3c-1, 260607): src/main/services/** cleared (~121 sites, void→fireAndForget).
// 30 → 0 (DI-23 Stage 3c-2, 260607): src/main non-services cleared; broad src/main+src/core block flipped warn→error. no-floating-promises is now error across src/main+src/core+cloud-service — DI-23/24/25 complete.
export const BASELINE_NO_FLOATING_PROMISES = 0;
// 34 → 0 (DI-24, 260606): all no-misused-promises violations cleared across src/main + src/core + cloud-service; rule promoted warn→error.
export const BASELINE_NO_MISUSED_PROMISES = 0;
// 25 → 0 (DI-25, 260606): all await-thenable violations cleared across src/main + src/core + cloud-service; rule promoted warn→error. Ratchet now at zero.
export const BASELINE_AWAIT_THENABLE = 0;
// DI-26 (260607): custom typed rule rebel-result/no-unused-result — flags a
// discarded discriminated Result union ({ ok|success: false } failure arm) in
// src/main + src/core (result-object analog of no-floating-promises). The 11
// initial sites were drained: 10 void-opted as intentional best-effort/observe-mode
// discards, and 1 backend.set result now handled with a warning.
export const BASELINE_NO_UNUSED_RESULT = 0;
// BASELINE_NULL_RULE: tracks warnings with `ruleId === null`. These come from
// two sources:
//   (a) "Unused eslint-disable directive" — a directive whose target rule no
//       longer fires. A non-zero count means stale directives remain in the
//       tree (typical cause: a rule was removed/disabled but its disables
//       weren't cleaned up). Fix with `eslint --fix --fix-type directive`.
//   (b) Parser / config emissions without a ruleId (rare).
// Held at 0 to force same-commit cleanup of stale directives. If this trips,
// the failure message will not name a rule — look for unused-disable warnings
// in `npm run lint` output.
export const BASELINE_NULL_RULE = 0;

export const RULE_BASELINES: ReadonlyArray<RuleBaseline> = [
  {
    ruleId: '@typescript-eslint/no-unused-vars',
    baseline: BASELINE_NO_UNUSED_VARS,
  },
  {
    ruleId: '@typescript-eslint/no-explicit-any',
    baseline: BASELINE_NO_EXPLICIT_ANY,
  },
  {
    ruleId: '@typescript-eslint/no-non-null-assertion',
    baseline: BASELINE_NO_NON_NULL_ASSERTION,
  },
  {
    ruleId: '@typescript-eslint/no-use-before-define',
    baseline: BASELINE_NO_USE_BEFORE_DEFINE,
  },
  {
    ruleId: '@typescript-eslint/naming-convention',
    baseline: BASELINE_NAMING_CONVENTION,
  },
  { ruleId: 'no-empty', baseline: BASELINE_NO_EMPTY },
  { ruleId: 'no-console', baseline: BASELINE_NO_CONSOLE },
  {
    ruleId: 'rebel-switch-exhaustiveness/no-bare-default-bypass',
    baseline: BASELINE_SWITCH_EXHAUSTIVENESS,
  },
  {
    ruleId: '@typescript-eslint/switch-exhaustiveness-check',
    baseline: BASELINE_SWITCH_EXHAUSTIVENESS_TYPE_AWARE,
  },
  {
    ruleId: '@typescript-eslint/no-floating-promises',
    baseline: BASELINE_NO_FLOATING_PROMISES,
  },
  {
    ruleId: '@typescript-eslint/no-misused-promises',
    baseline: BASELINE_NO_MISUSED_PROMISES,
  },
  {
    ruleId: '@typescript-eslint/await-thenable',
    baseline: BASELINE_AWAIT_THENABLE,
  },
  {
    ruleId: 'rebel-result/no-unused-result',
    baseline: BASELINE_NO_UNUSED_RESULT,
  },
  { ruleId: 'null', baseline: BASELINE_NULL_RULE },
];

function sortFailure(a: BaselineFailure, b: BaselineFailure): number {
  if (a.kind !== b.kind) {
    return a.kind === 'regression' ? -1 : 1;
  }
  return a.ruleId.localeCompare(b.ruleId);
}

export function parseRepeatArg(args: string[]): number {
  const repeatArg = args.find((arg) => arg.startsWith('--repeat='));
  const unsupportedArg = args.find((arg) => !arg.startsWith('--repeat='));
  if (unsupportedArg) {
    throw new Error(`Unsupported argument: ${unsupportedArg}`);
  }
  if (!repeatArg) {
    return 1;
  }

  const rawRepeat = repeatArg.slice('--repeat='.length);
  const repeat = Number.parseInt(rawRepeat, 10);
  if (!Number.isFinite(repeat) || Number.isNaN(repeat) || repeat <= 0) {
    throw new Error(`Invalid --repeat value: ${rawRepeat}`);
  }
  return repeat;
}

export async function runRepeatedEslintAudit(
  runner: EslintRunner,
  repeat: number,
): Promise<EslintAuditResult> {
  if (!Number.isFinite(repeat) || repeat <= 0) {
    throw new Error(`Invalid repeat count: ${repeat}`);
  }

  const perRuleCounts = new Map<string, number>();
  let totalWarnings = 0;
  let warnings: EslintAuditResult['warnings'] = [];

  for (let runIndex = 0; runIndex < repeat; runIndex += 1) {
    const audit = await runEslintAudit(runner);
    if (audit.totalWarnings >= totalWarnings) {
      totalWarnings = audit.totalWarnings;
      warnings = audit.warnings;
    }

    for (const [ruleId, count] of audit.perRuleCounts.entries()) {
      perRuleCounts.set(ruleId, Math.max(perRuleCounts.get(ruleId) ?? 0, count));
    }
  }

  return {
    totalWarnings,
    perRuleCounts,
    warnings,
  };
}

export function checkBaselines(
  perRuleCounts: Map<string, number>,
  baselines: typeof RULE_BASELINES,
): {
  failed: boolean;
  failures: Array<{
    ruleId: string;
    observed: number;
    baseline: number;
    kind: 'regression' | 'new_rule';
  }>;
} {
  const failures: BaselineFailure[] = [];
  const baselineByRule = new Map<string, number>();

  for (const baseline of baselines) {
    baselineByRule.set(baseline.ruleId, baseline.baseline);
    const observed = perRuleCounts.get(baseline.ruleId) ?? 0;
    if (observed > baseline.baseline) {
      failures.push({
        ruleId: baseline.ruleId,
        observed,
        baseline: baseline.baseline,
        kind: 'regression',
      });
    }
  }

  for (const [ruleId, observed] of perRuleCounts.entries()) {
    if (observed <= 0) {
      continue;
    }
    if (baselineByRule.has(ruleId)) {
      continue;
    }
    // Intentionally-untracked rules (e.g. silent-swallow, gated diff-scoped
    // instead of by count — see INTENTIONALLY_UNTRACKED_RULES) are exempt from
    // the NO-NEW-RULES catch-all.
    if (INTENTIONALLY_UNTRACKED_RULES.has(ruleId)) {
      continue;
    }

    failures.push({
      ruleId,
      observed,
      baseline: 0,
      kind: 'new_rule',
    });
  }

  failures.sort(sortFailure);

  return {
    failed: failures.length > 0,
    failures,
  };
}

export function formatReport(params: {
  perRuleCounts: Map<string, number>;
  baselines: ReadonlyArray<RuleBaseline>;
  failures: ReadonlyArray<BaselineFailure>;
  totalWarnings: number;
}): string {
  const { perRuleCounts, baselines, failures, totalWarnings } = params;
  const lines: string[] = [];

  if (failures.length === 0) {
    lines.push(
      `ESLint warning ratchet passed (${totalWarnings} total warnings across tracked rules).`,
    );
  } else {
    lines.push('ESLint warning ratchet FAILED.');
    lines.push('');
    for (const failure of failures) {
      if (failure.kind === 'regression') {
        lines.push(
          `✘ ${failure.ruleId}: ${failure.observed} warnings (baseline ${failure.baseline})`,
        );
      } else {
        lines.push(
          `✘ ${failure.ruleId}: ${failure.observed} warnings (new rule not in baseline map)`,
        );
      }
    }
  }

  lines.push('');
  lines.push('Rule counts:');
  for (const baseline of baselines) {
    const observed = perRuleCounts.get(baseline.ruleId) ?? 0;
    const status = observed > baseline.baseline ? '✘' : '✔';
    lines.push(
      `${status} ${baseline.ruleId}: ${observed}/${baseline.baseline} warnings`,
    );

    if (observed < baseline.baseline) {
      lines.push(
        `⚠ ${baseline.ruleId}: ${observed} is below baseline ${baseline.baseline}; lower the baseline.`,
      );
    }
  }

  const baselineRuleIds = new Set(baselines.map((entry) => entry.ruleId));
  const untracked = [...perRuleCounts.entries()]
    .filter(([ruleId, count]) => (
      count > 0
      && !baselineRuleIds.has(ruleId)
      && !INTENTIONALLY_UNTRACKED_RULES.has(ruleId)
    ))
    .sort((a, b) => b[1] - a[1]);
  if (untracked.length > 0) {
    lines.push('');
    lines.push('Untracked warning rules (must be triaged):');
    for (const [ruleId, count] of untracked) {
      lines.push(`- ${ruleId}: ${count}`);
    }
  }

  return lines.join('\n');
}

export async function main(options: MainOptions = {}): Promise<void> {
  const logger = options.logger ?? console;
  const repeat = parseRepeatArg(options.args ?? process.argv.slice(2));
  const baselines = options.baselines ?? RULE_BASELINES;
  const runner = options.runner ?? createDefaultEslintRunner();
  const audit = await runRepeatedEslintAudit(runner, repeat);
  const baselineCheck = checkBaselines(audit.perRuleCounts, baselines);
  // A-F2: every audited surface must be classified (covered or exempt), so a
  // newly-added lint surface cannot be silently left uncovered by this rule.
  // (The silent-swallow COUNT baselines this script used to also enforce were
  // retired in Stage 3 — see the NOTE above BASELINE_NO_CONSOLE's neighbours.
  // Parity is orthogonal to counts and still wanted.)
  const surfaceParityCheck = checkSilentSwallowSurfaceParity(options.surfaceParityAuditPaths);
  const report = formatReport({
    perRuleCounts: audit.perRuleCounts,
    baselines,
    failures: baselineCheck.failures,
    totalWarnings: audit.totalWarnings,
  });
  const surfaceParityReport = formatSilentSwallowSurfaceParityReport(surfaceParityCheck);

  const fullReport = [report, surfaceParityReport].join('\n\n');

  if (baselineCheck.failed || surfaceParityCheck.failed) {
    logger.error(fullReport);
    process.exit(1);
  }

  logger.log(fullReport);
}

const invokedDirectly = process.argv[1] === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  main().catch((error: unknown) => {
    console.error('Unexpected error in check-eslint-warnings:', error);
    process.exit(1);
  });
}
