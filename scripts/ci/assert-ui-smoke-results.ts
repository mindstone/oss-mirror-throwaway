/**
 * Deterministic verdict for the Daily UI Smoke Test (.github/workflows/ui-smoke-test.yml).
 *
 * Extracted from a ~250-line inline Node heredoc so the verdict logic is
 * type-checked and unit-tested (scripts/__tests__/assert-ui-smoke-results.test.ts).
 *
 * ─────────────────────────────────────────────────────────────────────────
 * The defect this fixes
 * ─────────────────────────────────────────────────────────────────────────
 * The old logic returned the SAME `{ error }` shape for two unrelated outcomes:
 *   (a) "the droid produced no usable output" — a Droid-CLI/harness no-op; the
 *       test never actually ran (e.g. a 20-byte `Plan is up-to-date.` log);
 *   (b) "the droid ran and the test detected a real problem" — an app failure.
 * Both fed the final verdict identically, so an intermittent CLI no-op in ONE
 * phase failed the whole run even when the other phase comprehensively passed.
 * The result was a chronically red daily check (most failures were false alarms),
 * which trains people to ignore it — including the days it caught a real bug.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * The taxonomy
 * ─────────────────────────────────────────────────────────────────────────
 * Each phase is classified PASS / FAIL / INCONCLUSIVE, and the run verdict is:
 *   - any phase FAIL                       → TEST FAIL          (exit 1)
 *   - else baseline phase is a parsed PASS → TEST PASS          (exit 0)
 *   - else                                 → TEST INCONCLUSIVE  (exit 1)
 *
 * A phase FAILs only on a POSITIVE failure signal (a parsed step with
 * status:FAIL, console errors, a recognizable OVERALL/free-text FAIL, or failure
 * prose such as "crashed" / "ERRORS:"). This preserves every real-bug detection
 * path — INCONCLUSIVE never masks a FAIL. The distinct INCONCLUSIVE verdict still
 * exits non-zero (so a broken harness is noticed and Slack notifies) but is
 * labeled a harness problem, NOT a UI regression.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * Why no "regression substitutes for baseline" gate (Arbitrator decision, A+B)
 * ─────────────────────────────────────────────────────────────────────────
 * The baseline phase uniquely guarantees the five core tabs render via its own
 * rigid script; the regression phase is commit-driven and is NOT a structural
 * superset. Earlier we tried to let a passing regression "prove" baseline
 * coverage from emitted baseline-category steps, but three review rounds each
 * found a fresh false-negative on that surface (it trusts free-form LLM output).
 *
 * Instead we attack the root cause: the workflow RETRIES a phase once when its
 * first attempt is INCONCLUSIVE (most no-ops are transient — a manual re-run
 * passed). The deterministic green gate is simple and strict: the BASELINE phase
 * itself must be a parsed structured PASS. If baseline stays inconclusive after
 * retry, the run is INCONCLUSIVE — never greened on the regression phase alone.
 *
 * Retry-safety invariant (pinned by test): an `inconclusive` classification
 * carries ZERO failure signal — failure detection runs before the no-op return
 * and before the ambiguous-output fallthrough. So discarding an inconclusive
 * attempt-1 on retry can never drop a real FAIL.
 *
 * Fail-closed on ambiguity: only an EXPLICIT pass signal (structured JSON steps,
 * a summary block with no FAIL, or an `OVERALL: PASS` line) yields a pass.
 * Ambiguous prose / a bare clean exit code is INCONCLUSIVE, not PASS — so the
 * gate never greens on output it cannot actually confirm.
 */

import fs from 'node:fs';

export interface SmokeStep {
  name?: unknown;
  category?: unknown;
  rendered?: unknown;
  status?: unknown;
  detail?: unknown;
  screenshot?: unknown;
}

export interface SmokeResults {
  steps: SmokeStep[];
  raw_console_errors: string[];
}

/** Outcome of parsing a single phase's droid output log. */
export type PhaseParse =
  | { status: 'parsed'; phaseName: string; results: SmokeResults }
  | { status: 'freeTextPass'; phaseName: string }
  | { status: 'inconclusive'; phaseName: string; reason: string }
  | { status: 'failure'; phaseName: string; reason: string };

/** Final per-phase classification feeding the run verdict. */
export interface PhaseOutcome {
  phaseName: string;
  classification: 'pass' | 'fail' | 'inconclusive';
  /** Populated when classification === 'fail'. */
  failures: string[];
  /** Populated when classification === 'inconclusive'. */
  reason?: string;
  /** True iff this pass came from parsed structured steps (vs a free-text pass). */
  parsedSteps: boolean;
  stats: { passed: number; failed: number; skipped: number; total: number };
}

export type RunVerdict = 'pass' | 'fail' | 'inconclusive';

/**
 * Parse a single droid output string into a phase outcome. Pure — no fs, no
 * side effects — so it is directly unit-testable.
 *
 * Layer order is deliberate: explicit structured/marker results first; then
 * POSITIVE failure-signal detection (so a failure can never be swallowed as a
 * no-op or pass); then explicit free-text pass; everything else → inconclusive.
 */
export function parseLogContent(output: string, phaseName: string, exitCode: number): PhaseParse {
  const summaryMatch = output.match(/=== UI SMOKE TEST RESULTS ===([\s\S]*?)=== END RESULTS ===/);

  // Layer 1 — structured JSON between the explicit markers (the happy path).
  // This is the authoritative channel (it carries raw_console_errors and per-step
  // status), so it is NOT overridden by stray prose elsewhere in the log.
  const markerRegex = /=== SMOKE_TEST_JSON_START ===\s*\n([\s\S]*?)\n\s*=== SMOKE_TEST_JSON_END ===/g;
  const matches = [...output.matchAll(markerRegex)];
  if (matches.length > 0) {
    const jsonText = matches[matches.length - 1][1];
    try {
      const results = JSON.parse(jsonText);
      if (!Array.isArray(results.steps)) {
        return { status: 'failure', phaseName, reason: `${phaseName}: missing "steps" array in JSON` };
      }
      if (!Array.isArray(results.raw_console_errors)) results.raw_console_errors = [];
      normalizeSteps(results);
      return { status: 'parsed', phaseName, results };
    } catch (e) {
      return { status: 'failure', phaseName, reason: `${phaseName}: invalid JSON — ${(e as Error).message}` };
    }
  }

  // ── Positive failure-signal detection on unstructured prose ──
  // Computed up-front so it can gate EVERY downstream pass return (summary block,
  // bare OVERALL: PASS, no-op markers, ambiguous fallthrough). A failure signal
  // can never be swallowed as a pass/no-op (the retry-safety invariant). Failure
  // detection is residue-based: negated phrases ("did not fail", "no console
  // errors") are stripped first, then a real failure word in the REMAINDER still
  // counts — so "...did not fail to launch. Settings failed." is a failure.
  const hasFailureSignal = hasUnnegatedFailureSignal(output);

  // Layer 2 — free-text summary block.
  if (summaryMatch) {
    const summary = summaryMatch[1];
    const hasOverallFail = /^OVERALL:\s*FAIL/m.test(summary);
    const failLines = summary.split('\n').filter((l) => /FAIL\s*-/.test(l) && !/SKIP/.test(l));
    if (hasOverallFail || failLines.length > 0 || hasFailureSignal) {
      const reason = failLines.map((l) => l.trim()).join('; ') || (hasOverallFail ? 'OVERALL: FAIL' : 'failure signal in summary/output');
      return { status: 'failure', phaseName, reason: `${phaseName} FAIL (free-text): ${reason}` };
    }
    return { status: 'freeTextPass', phaseName };
  }

  // Layer 3 — any loose JSON object carrying a non-empty "steps" array.
  const looseJsonRegex = /\{[\s\S]{10,}?"steps"\s*:\s*\[[\s\S]*?\]\s*[\s\S]*?\}/g;
  const looseMatches = output.match(looseJsonRegex);
  if (looseMatches) {
    for (const block of looseMatches) {
      try {
        const parsed = JSON.parse(block);
        if (Array.isArray(parsed.steps) && parsed.steps.length > 0) {
          if (!Array.isArray(parsed.raw_console_errors)) parsed.raw_console_errors = [];
          normalizeSteps(parsed);
          return { status: 'parsed', phaseName, results: parsed };
        }
      } catch {
        /* keep scanning */
      }
    }
  }

  // Layer 4 — a bare OVERALL: PASS/FAIL line anywhere in the output. An explicit
  // PASS is still rejected as a failure if failure prose contradicts it (fail-closed).
  const overallMatch = output.match(/OVERALL:\s*(PASS|FAIL)/i);
  if (overallMatch) {
    if (overallMatch[1].toUpperCase() === 'FAIL' || hasFailureSignal) {
      return { status: 'failure', phaseName, reason: `${phaseName} FAIL (from raw output: OVERALL/failure prose)` };
    }
    return { status: 'freeTextPass', phaseName };
  }

  // Known Droid-CLI no-op phrases. Only inconclusive when there is no failure
  // signal — otherwise fall through to the failure return below.
  const NOOP_MARKERS =
    /\b(?:plan is up[- ]to[- ]date|nothing to do|no (?:changes|action|work) (?:needed|required|to (?:do|take))|already up[- ]to[- ]date|no tasks? (?:remaining|to run))\b/i;
  if (NOOP_MARKERS.test(output) && !hasFailureSignal) {
    return {
      status: 'inconclusive',
      phaseName,
      reason: `${phaseName}: droid emitted a known no-op message and no test results (likely a harness/CLI no-op, not an app failure)`,
    };
  }

  // A failure signal anywhere in unstructured prose → failure, regardless of
  // length (a short "...the app crashed during Settings." must not be swallowed).
  if (hasFailureSignal) {
    return { status: 'failure', phaseName, reason: `${phaseName} FAIL (inferred from natural-language output)` };
  }

  // Fail-closed: with no structured result and no explicit pass/fail signal, we
  // CANNOT confirm a pass. A bare clean exit code or vague prose is NOT enough —
  // classify inconclusive (the workflow retries; persistent → labeled harness
  // problem). `exitCode` is accepted for signature stability but intentionally
  // not used to manufacture a pass.
  void exitCode;
  return {
    status: 'inconclusive',
    phaseName,
    reason: `${phaseName}: no structured JSON and no explicit pass/fail signal (droid produced no usable result — likely a harness/CLI no-op, not an app failure)`,
  };
}

/**
 * Detect a real failure signal in unstructured prose. Residue-based: strip
 * NEGATED forms first ("did not fail", "no console errors", "without crashes"),
 * then look for a failure word in the remainder — so a benign negation can't
 * cancel a separate real failure elsewhere in the same log.
 *
 * Note: the error-DUMP form is matched case-sensitively as `ERRORS:` / `ERROR:`
 * (the exact upper-case form the workflow's console check emits) so it does NOT
 * collide with the benign lower-case "Console errors:" check label in summaries.
 */
function hasUnnegatedFailureSignal(output: string): boolean {
  const stripped = output.replace(
    /\b(?:0|no|zero|without|free\s+of|didn'?t|did\s+not|not)\s+(?:console\s+)?(?:fail(?:ed|ures?|ing|s)?|errors?|crash(?:ed|es)?|exceptions?|hang|hung|time[ds]?\s*out|broken|unresponsive)\b/gi,
    ' ',
  );
  return (
    /\bfail(?:ed|ures?|ing|s)?\b/i.test(stripped) ||
    /\b(?:crash(?:ed)?|exception|unresponsive|broken|hung|timed?\s*out)\b/i.test(stripped) ||
    /(?:^|\s)ERRORS?:/.test(stripped) || // case-sensitive: the raw error-dump form
    /\bcould\s+not\s+load\b|\bfailed\s+to\s+load\b|\berror\s+state\b|\bshowed?\s+an?\s+error\b/i.test(stripped)
  );
}

function normalizeSteps(results: SmokeResults): void {
  for (const step of results.steps) {
    if (typeof step.category === 'string') step.category = step.category.toLowerCase();
    if (typeof step.status === 'string') step.status = step.status.toUpperCase();
  }
}

/**
 * Turn a PhaseParse into a final PhaseOutcome, applying per-step / category /
 * console-error validation against parsed results.
 */
export function classifyPhase(
  parse: PhaseParse,
  requiredCategories: string[],
  opts: {
    /**
     * Numbered baseline checks (e.g. ['1','2','3'] for Baseline 1 app-render,
     * Baseline 2 five-tab nav, Baseline 3 console errors) that MUST each appear
     * as a passing, rendered `baseline`-category step. Closes the "one baseline
     * step greens the run" gap: a parsed baseline pass that omits the tab-nav
     * check is now a coverage failure, not a green. Keyed off the baseline
     * prompt's own rigid step naming ("Baseline N: ..."), which this repo owns.
     */
    requiredBaselineCheckKeys?: string[];
  } = {},
): PhaseOutcome {
  const phaseName = parse.phaseName;
  const emptyStats = { passed: 0, failed: 0, skipped: 0, total: 0 };

  if (parse.status === 'inconclusive') {
    return { phaseName, classification: 'inconclusive', failures: [], reason: parse.reason, parsedSteps: false, stats: emptyStats };
  }
  if (parse.status === 'failure') {
    return { phaseName, classification: 'fail', failures: [parse.reason], parsedSteps: false, stats: emptyStats };
  }
  if (parse.status === 'freeTextPass') {
    // An explicit-but-unstructured pass (summary block / OVERALL: PASS) has no
    // parsed steps, so it cannot satisfy the baseline parsed-pass gate.
    return { phaseName, classification: 'pass', failures: [], parsedSteps: false, stats: emptyStats };
  }

  // status === 'parsed' — inspect the structured results.
  const { results } = parse;
  const failures: string[] = [];

  // A parsed result with zero steps is a failure ("no steps reported"). Critical
  // for custom mode, which has no required categories and would otherwise green
  // an empty `steps: []`.
  if (results.steps.length === 0) {
    failures.push(`${phaseName}: no steps reported`);
  }

  for (const [i, step] of results.steps.entries()) {
    if (typeof step.name !== 'string' || typeof step.rendered !== 'boolean' || typeof step.status !== 'string') {
      failures.push(`${phaseName} step ${i} has invalid fields`);
    }
  }

  for (const cat of requiredCategories) {
    const steps = results.steps.filter((s) => s.category === cat);
    if (steps.length === 0) {
      failures.push(`${phaseName}: no "${cat}" steps found`);
    } else if (cat === 'baseline') {
      const unrendered = steps.filter((s) => !s.rendered);
      if (unrendered.length > 0) {
        failures.push(`${phaseName}: baseline steps not rendered: ${unrendered.map((s) => s.name).join(', ')}`);
      }
    }
  }

  // Baseline coverage completeness: every required numbered baseline check must
  // be present as a passing, rendered baseline step. Without this, a baseline
  // run that emits only "Baseline 1" would green while never exercising the
  // five-tab nav check (a baseline-only regression could slip through).
  if (opts.requiredBaselineCheckKeys && opts.requiredBaselineCheckKeys.length > 0) {
    const coveredKeys = new Set(
      results.steps
        .filter(
          (s) =>
            s.category === 'baseline' &&
            s.rendered === true &&
            typeof s.status === 'string' &&
            s.status.startsWith('PASS'),
        )
        .map((s) => (typeof s.name === 'string' ? s.name.match(/baseline\s*#?\s*0*(\d+)/i)?.[1] : undefined))
        .filter((k): k is string => typeof k === 'string'),
    );
    const missing = opts.requiredBaselineCheckKeys.filter((k) => !coveredKeys.has(k));
    if (missing.length > 0) {
      failures.push(
        `${phaseName}: baseline coverage incomplete — missing passing/rendered check(s): ${missing
          .map((k) => `Baseline ${k}`)
          .join(', ')}`,
      );
    }
  }

  const failedSteps = results.steps.filter((s) => s.status === 'FAIL');
  if (failedSteps.length > 0) {
    failures.push(
      `${phaseName}: ${failedSteps.length} step(s) FAILED: ${failedSteps
        .map((s) => `${s.name} — ${s.detail || 'no detail'}`)
        .join('; ')}`,
    );
  }

  if (results.raw_console_errors.length > 0) {
    failures.push(
      `${phaseName}: ${results.raw_console_errors.length} console error(s): ${results.raw_console_errors
        .slice(0, 3)
        .join('; ')}${results.raw_console_errors.length > 3 ? '...' : ''}`,
    );
  }

  const stats = { passed: 0, failed: 0, skipped: 0, total: 0 };
  for (const s of results.steps) {
    stats.total++;
    const status = typeof s.status === 'string' ? s.status : '';
    if (status.startsWith('PASS')) stats.passed++;
    else if (status === 'FAIL') stats.failed++;
    else if (status === 'SKIP') stats.skipped++;
  }

  if (failures.length > 0) {
    return { phaseName, classification: 'fail', failures, parsedSteps: true, stats };
  }
  return { phaseName, classification: 'pass', failures: [], parsedSteps: true, stats };
}

/**
 * Compute the run-level verdict from per-phase outcomes.
 *
 * `baselineGatePhase` (default mode = 'Baseline'): the run can only be green if
 * that phase is a parsed structured PASS — its rigid 5-tab script is the only
 * coverage guarantee we trust. When omitted (custom dispatch mode) any passing
 * phase greens the run.
 */
export function computeVerdict(
  outcomes: PhaseOutcome[],
  { baselineGatePhase }: { baselineGatePhase?: string } = {},
): { verdict: RunVerdict; text: string; exitCode: number } {
  const failed = outcomes.filter((o) => o.classification === 'fail');
  const passed = outcomes.filter((o) => o.classification === 'pass');
  const inconclusive = outcomes.filter((o) => o.classification === 'inconclusive');

  if (failed.length > 0) {
    const allFailures = failed.flatMap((o) => o.failures);
    const text = `TEST FAIL (${allFailures.length} issue(s)):\n${allFailures
      .map((f, i) => `  ${i + 1}. ${f}`)
      .join('\n')}`;
    return { verdict: 'fail', text, exitCode: 1 };
  }

  const inconclusiveReasons = (): string =>
    inconclusive.length
      ? `\nInconclusive phase(s):\n${(inconclusive.map((o) => o.reason).filter(Boolean) as string[])
          .map((r, i) => `  ${i + 1}. ${r}`)
          .join('\n')}`
      : '';

  if (baselineGatePhase) {
    const baseline = outcomes.find((o) => o.phaseName === baselineGatePhase);
    const baselineConfirmed = !!baseline && baseline.classification === 'pass' && baseline.parsedSteps;

    if (!baselineConfirmed) {
      const why =
        baseline && baseline.classification === 'pass' && !baseline.parsedSteps
          ? `${baselineGatePhase} produced only an unstructured pass (no parsed steps) — cannot confirm the core-tab checks actually ran`
          : `${baselineGatePhase} did not produce a confirmed pass (it was inconclusive after retry)`;
      const text =
        `TEST INCONCLUSIVE — smoke test could not confirm baseline coverage. ${why}. A baseline no-op is NOT greened on the regression phase alone (commit-driven journeys may skip whole tabs). This is a harness/coverage gap, NOT a detected UI regression.` +
        inconclusiveReasons();
      return { verdict: 'inconclusive', text, exitCode: 1 };
    }

    let text = `TEST PASS (${passed.map((o) => o.phaseName).join(' + ')} passed)`;
    if (inconclusive.length > 0) {
      text += `\nNote: ${inconclusive.length} phase(s) inconclusive (no usable droid output) — not counted as a failure:`;
      for (const o of inconclusive) text += `\n  - ${o.reason}`;
      if (inconclusive.some((o) => /regression/i.test(o.phaseName))) {
        text += '\n  ⚠ Regression coverage incomplete this run: baseline passed but commit-driven journeys did not run.';
      }
    }
    return { verdict: 'pass', text, exitCode: 0 };
  }

  // No baseline gate (custom dispatch mode): any pass greens; all-inconclusive
  // means the test could not execute.
  if (passed.length > 0) {
    let text = `TEST PASS (${passed.map((o) => o.phaseName).join(' + ')} passed)`;
    if (inconclusive.length > 0) {
      text += `\nNote: ${inconclusive.length} phase(s) inconclusive — not counted as a failure.`;
    }
    return { verdict: 'pass', text, exitCode: 0 };
  }

  const text =
    `TEST INCONCLUSIVE — smoke test could not execute (${inconclusive.length} phase(s) produced no usable output; this is a harness/CLI problem, NOT a detected UI regression):` +
    inconclusiveReasons();
  return { verdict: 'inconclusive', text, exitCode: 1 };
}

// ──────────────────────────────────────────────────────────────────────────
// CLI
// ──────────────────────────────────────────────────────────────────────────

interface PhaseSpec {
  logPath: string;
  phaseName: string;
  exitEnvKey: string;
  requiredCategories: string[];
}

function defaultSpecs(isCustom: boolean): PhaseSpec[] {
  return isCustom
    ? [{ logPath: '/tmp/ui-smoke-custom.log', phaseName: 'Custom', exitEnvKey: 'CUSTOM_EXIT_CODE', requiredCategories: [] }]
    : [
        { logPath: '/tmp/ui-smoke-baseline.log', phaseName: 'Baseline', exitEnvKey: 'BASELINE_EXIT_CODE', requiredCategories: ['baseline'] },
        { logPath: '/tmp/ui-smoke-regression.log', phaseName: 'Regression', exitEnvKey: 'REGRESSION_EXIT_CODE', requiredCategories: ['regression', 'final'] },
      ];
}

function readAndParse(spec: PhaseSpec): PhaseParse {
  if (!fs.existsSync(spec.logPath)) {
    return {
      status: 'inconclusive',
      phaseName: spec.phaseName,
      reason: `${spec.phaseName} output file not found (phase may not have run or timed out)`,
    };
  }
  const output = fs.readFileSync(spec.logPath, 'utf-8');

  // Persist the human-readable summary block for the artifact / step summary.
  const summaryMatch = output.match(/=== UI SMOKE TEST RESULTS ===([\s\S]*?)=== END RESULTS ===/);
  if (summaryMatch) {
    fs.writeFileSync(spec.logPath.replace('.log', '-summary.txt'), summaryMatch[0]);
  }

  const exitCode = parseInt(process.env[spec.exitEnvKey] || '-1', 10);
  return parseLogContent(output, spec.phaseName, exitCode);
}

/**
 * `--classify <logPath> <phaseName> <exitCode>`: print the parse status word
 * (parsed|freeTextPass|inconclusive|failure) and exit 0. Used by
 * run-smoke-phase.sh to decide whether to retry a phase (retry iff inconclusive).
 */
function classifyCli(argv: string[]): void {
  const [logPath, phaseName, exitCodeRaw] = argv;
  if (!logPath || !phaseName) {
    console.error('usage: --classify <logPath> <phaseName> <exitCode>');
    process.exit(2);
  }
  const exitCode = parseInt(exitCodeRaw || '-1', 10);
  const output = fs.existsSync(logPath) ? fs.readFileSync(logPath, 'utf-8') : '';
  console.log(parseLogContent(output, phaseName, exitCode).status);
  process.exit(0);
}

function main(): void {
  const verdictPath = '/tmp/smoke-verdict.txt';
  const isCustom = process.env.IS_CUSTOM_PROMPT === 'true';
  const specs = defaultSpecs(isCustom);

  console.log('=== DETERMINISTIC ASSERTION RESULTS ===');

  const outcomes = specs.map((spec) =>
    classifyPhase(readAndParse(spec), spec.requiredCategories, {
      requiredBaselineCheckKeys: spec.phaseName === 'Baseline' ? ['1', '2', '3'] : undefined,
    }),
  );

  for (const o of outcomes) {
    if (o.classification === 'inconclusive') console.log(`${o.phaseName}: INCONCLUSIVE — ${o.reason}`);
    else if (o.classification === 'fail') console.log(`${o.phaseName}: FAIL — ${o.failures.join('; ')}`);
    else console.log(`${o.phaseName}: PASS — ${o.stats.passed}/${o.stats.total} steps passed`);
  }

  const total = outcomes.reduce(
    (acc, o) => ({
      passed: acc.passed + o.stats.passed,
      failed: acc.failed + o.stats.failed,
      skipped: acc.skipped + o.stats.skipped,
      total: acc.total + o.stats.total,
    }),
    { passed: 0, failed: 0, skipped: 0, total: 0 },
  );
  console.log(`Total: ${total.passed} passed, ${total.failed} failed, ${total.skipped} skipped out of ${total.total}`);

  const { text, exitCode } = computeVerdict(outcomes, { baselineGatePhase: isCustom ? undefined : 'Baseline' });
  console.log(`\nVERDICT: ${text}`);
  console.log('=== END ASSERTION RESULTS ===');
  fs.writeFileSync(verdictPath, text);
  process.exit(exitCode);
}

// Only run the CLI when invoked directly, not when imported by tests.
const invokedDirectly =
  typeof process !== 'undefined' &&
  Array.isArray(process.argv) &&
  /assert-ui-smoke-results(\.ts|\.js|\.mjs)?$/.test(process.argv[1] ?? '');
if (invokedDirectly) {
  const argv = process.argv.slice(2);
  if (argv[0] === '--classify') classifyCli(argv.slice(1));
  else main();
}
