/**
 * Quantified E2E flake observability for the macOS `test-e2e` release job.
 *
 * Parses a Playwright JSON report (`--reporter=json` /
 * PLAYWRIGHT_JSON_OUTPUT_NAME) and classifies every spec by outcome, so a spec
 * that only passes on retry is RECORDED and ticketed rather than silently
 * greened. This is the load-bearing half of the de-flake plan: `retries:1`
 * collapses the "1% per-spec flake → ~30% job-fail" arithmetic, but retries
 * without observability just make red *quieter* — which is how the team learned
 * to ship through red in the first place.
 *
 * Deliberate: see docs/plans/260617_deflake-ci-for-blocking-gates/PLAN.md
 * (Stage 1) and the gate-readiness predicate in docs/project/CI_PIPELINE.md
 * (§ "E2E flake policy & gate-readiness").
 *
 * ─────────────────────────────────────────────────────────────────────────
 * Classification (mirrors Playwright's own JSONReportTest.status)
 * ─────────────────────────────────────────────────────────────────────────
 *   - `expected`   — passed on the first attempt (clean).
 *   - `flaky`      — failed at least one attempt but PASSED on retry. Shippable
 *                    for THIS run, but does NOT count toward the consecutive-
 *                    green streak; the flaky spec is ticketed.
 *   - `unexpected` — failed all attempts → a real regression → the job is red.
 *   - `skipped`    — not run (skip / fixme).
 *
 * ─────────────────────────────────────────────────────────────────────────
 * Per-run verdict (the quantified escalation predicate)
 * ─────────────────────────────────────────────────────────────────────────
 *   - 0 unexpected + 0 flaky  → CLEAN GREEN   (counts toward the green streak)
 *   - 0 unexpected + ≥1 flaky → SHIPPABLE-BUT-FLAKY (flaky specs ticketed;
 *                                does NOT count toward the streak)
 *   - ≥1 unexpected           → RED
 *
 * This summarizer is NON-GATING by design (always exit 0): the Playwright job's
 * own pass/fail conclusion already reds the run on an `unexpected` spec. This
 * step's job is to make the flaky set *visible and machine-readable* (run
 * summary + a one-line JSON to stdout that a downstream ledger/Slack notifier
 * can consume) so the rolling gate-readiness signal can be computed. It is also
 * robust to a missing/corrupt report (warn, exit 0) — a crashed run must not
 * turn this observability step into a second failure source.
 */

import fs from 'node:fs';

/** Playwright JSONReportTest.status — the authoritative per-spec classification. */
export type SpecOutcome = 'expected' | 'flaky' | 'unexpected' | 'skipped';

/** A single classified spec (file + title + outcome + attempt count). */
export interface ClassifiedSpec {
  file: string;
  title: string;
  outcome: SpecOutcome;
  /** Number of attempts the worst test in this spec needed (1 = no retry). */
  attempts: number;
}

/** The full machine-readable summary emitted to stdout (one line) + used by the run summary. */
export interface E2eFlakeSummary {
  expected: number;
  flaky: number;
  unexpected: number;
  skipped: number;
  total: number;
  /** Per-run verdict from the quantified escalation predicate. */
  verdict: 'clean-green' | 'shippable-but-flaky' | 'red';
  flakySpecs: ClassifiedSpec[];
  unexpectedSpecs: ClassifiedSpec[];
}

/**
 * Classify a parsed Playwright JSON report into a flake summary. Pure — no fs,
 * no side effects — so it is directly unit-testable.
 *
 * A spec is the unit of classification. Playwright already computes the
 * per-test status (`expected`/`flaky`/`unexpected`/`skipped`); a spec can hold
 * several parameterised tests (projects/repeats), so we roll the tests up to a
 * spec outcome by worst-case severity: unexpected > flaky > expected > skipped.
 * (A spec with one flaky and one clean test is still "flaky" — the flake is
 * real and must be tracked.)
 */
export function classifyReport(report: unknown): E2eFlakeSummary {
  const specs: ClassifiedSpec[] = [];

  const walk = (suite: PwSuite | undefined): void => {
    if (!suite || typeof suite !== 'object') return;
    for (const spec of suite.specs ?? []) {
      if (!spec || typeof spec !== 'object') continue;
      const file = typeof spec.file === 'string' ? spec.file : suite.file ?? '<unknown file>';
      const title = typeof spec.title === 'string' ? spec.title : '<unknown title>';
      const { outcome, attempts } = rollUpSpec(spec);
      specs.push({ file, title, outcome, attempts });
    }
    for (const child of suite.suites ?? []) walk(child);
  };

  const root = report as { suites?: PwSuite[] } | null | undefined;
  for (const suite of root?.suites ?? []) walk(suite);

  const expected = specs.filter((s) => s.outcome === 'expected').length;
  const flakySpecs = specs.filter((s) => s.outcome === 'flaky');
  const unexpectedSpecs = specs.filter((s) => s.outcome === 'unexpected');
  const skipped = specs.filter((s) => s.outcome === 'skipped').length;

  const verdict: E2eFlakeSummary['verdict'] =
    unexpectedSpecs.length > 0 ? 'red' : flakySpecs.length > 0 ? 'shippable-but-flaky' : 'clean-green';

  return {
    expected,
    flaky: flakySpecs.length,
    unexpected: unexpectedSpecs.length,
    skipped,
    total: specs.length,
    verdict,
    flakySpecs,
    unexpectedSpecs,
  };
}

// ── Minimal structural views of the Playwright JSON report (we read defensively
// rather than importing the @playwright/test types, so a malformed report from a
// crashed run degrades to "skipped"/empty instead of throwing). ──
interface PwTestResult {
  retry?: unknown;
}
interface PwTest {
  status?: unknown;
  results?: PwTestResult[];
}
interface PwSpec {
  file?: unknown;
  title?: unknown;
  tests?: PwTest[];
}
interface PwSuite {
  file?: string;
  specs?: PwSpec[];
  suites?: PwSuite[];
}

const SEVERITY: Record<SpecOutcome, number> = { unexpected: 3, flaky: 2, expected: 1, skipped: 0 };

/** Roll a spec's parameterised tests up to a single worst-case spec outcome + attempt count. */
function rollUpSpec(spec: PwSpec): { outcome: SpecOutcome; attempts: number } {
  let outcome: SpecOutcome = 'skipped';
  let attempts = 1;
  for (const test of spec.tests ?? []) {
    const status = normalizeStatus(test.status);
    if (SEVERITY[status] > SEVERITY[outcome]) outcome = status;
    // `retry` is 0-indexed (attempt N has retry N-1); attempts = maxRetry + 1.
    for (const r of test.results ?? []) {
      const retry = typeof r.retry === 'number' && Number.isFinite(r.retry) ? r.retry : 0;
      attempts = Math.max(attempts, retry + 1);
    }
  }
  return { outcome, attempts };
}

function normalizeStatus(status: unknown): SpecOutcome {
  if (status === 'expected' || status === 'flaky' || status === 'unexpected' || status === 'skipped') {
    return status;
  }
  // Unknown/missing status from a malformed report → treat as skipped (lowest
  // severity) so it can never manufacture a false flaky/red. A genuinely failed
  // run still reds via the Playwright job's own non-zero exit.
  return 'skipped';
}

/** Render the human-readable run-summary markdown for $GITHUB_STEP_SUMMARY. */
export function renderSummaryMarkdown(s: E2eFlakeSummary): string {
  const lines: string[] = [];
  const badge =
    s.verdict === 'clean-green' ? '✅ CLEAN GREEN' : s.verdict === 'shippable-but-flaky' ? '⚠️ SHIPPABLE-BUT-FLAKY' : '❌ RED';
  lines.push('### E2E flake report (macOS)');
  lines.push('');
  lines.push(`**${badge}** — ${s.expected} expected · ${s.flaky} flaky · ${s.unexpected} unexpected · ${s.skipped} skipped (of ${s.total} specs)`);
  if (s.verdict === 'shippable-but-flaky') {
    lines.push('');
    lines.push(
      '> Flaky = passed only on retry. Shippable for this run but does NOT count toward the consecutive-green streak; ticket the flaky specs. See CI_PIPELINE.md § "E2E flake policy & gate-readiness".',
    );
  }
  if (s.unexpectedSpecs.length > 0) {
    lines.push('');
    lines.push('**Unexpected (failed all attempts → red):**');
    for (const spec of s.unexpectedSpecs) lines.push(`- \`${spec.file}\` — ${spec.title}`);
  }
  if (s.flakySpecs.length > 0) {
    lines.push('');
    lines.push('**Flaky (passed only on retry → ticket, does not count toward streak):**');
    for (const spec of s.flakySpecs) lines.push(`- \`${spec.file}\` — ${spec.title} (${spec.attempts} attempts)`);
  }
  return lines.join('\n');
}

/** Render the one-line machine-readable JSON consumed by a downstream ledger/notifier. */
export function renderMachineLine(s: E2eFlakeSummary): string {
  return JSON.stringify({
    kind: 'e2e-flake-summary',
    verdict: s.verdict,
    expected: s.expected,
    flaky: s.flaky,
    unexpected: s.unexpected,
    skipped: s.skipped,
    total: s.total,
    flakySpecs: s.flakySpecs.map((spec) => ({ file: spec.file, title: spec.title })),
    unexpectedSpecs: s.unexpectedSpecs.map((spec) => ({ file: spec.file, title: spec.title })),
  });
}

/** Render a one-line Slack-thread message (consumed by scripts/ci/slack-notify.sh). */
export function renderSlackLine(s: E2eFlakeSummary, runUrl?: string): string {
  const where = runUrl ? ` (<${runUrl}|run>)` : '';
  if (s.verdict === 'clean-green') {
    return `:white_check_mark: macOS E2E clean green — ${s.expected}/${s.total} specs, 0 flaky, 0 unexpected${where}`;
  }
  if (s.verdict === 'shippable-but-flaky') {
    const names = s.flakySpecs.map((spec) => spec.title).join(', ');
    return `:warning: macOS E2E shippable-but-flaky — ${s.flaky} spec(s) passed only on retry (does not count toward green streak): ${names}${where}`;
  }
  const names = s.unexpectedSpecs.map((spec) => spec.title).join(', ');
  return `:x: macOS E2E red — ${s.unexpected} spec(s) failed all attempts: ${names}${where}`;
}

// ──────────────────────────────────────────────────────────────────────────
// CLI
// ──────────────────────────────────────────────────────────────────────────

/**
 * `summarize-e2e-results.ts [reportPath] [--slack-line]`
 *
 * reportPath defaults to PLAYWRIGHT_JSON_OUTPUT_NAME, then `e2e-results.json`.
 * Always exits 0 (observability, not a gate). Writes the human summary to
 * $GITHUB_STEP_SUMMARY when set; prints the one-line machine JSON to stdout
 * (last line, so a caller can `tail -1`); diagnostics go to stderr.
 *
 * `--slack-line` instead prints ONLY the one-line Slack-thread text (using
 * $RUN_URL when set) and nothing else, so a CI step can pipe it straight into
 * scripts/ci/slack-notify.sh without reconstructing the message in bash.
 */
function main(argv: string[]): void {
  const slackLineOnly = argv.includes('--slack-line');
  const reportPath = argv.find((a) => !a.startsWith('--')) || process.env.PLAYWRIGHT_JSON_OUTPUT_NAME || 'e2e-results.json';

  let summary: E2eFlakeSummary;
  if (!fs.existsSync(reportPath)) {
    warn(`E2E flake summary: report not found at "${reportPath}" — the run likely crashed before reporting. Treating as no observability data (non-gating).`);
    summary = emptySummary();
  } else {
    try {
      summary = classifyReport(JSON.parse(fs.readFileSync(reportPath, 'utf-8')));
    } catch (e) {
      warn(`E2E flake summary: report at "${reportPath}" is not valid JSON (${(e as Error).message}) — non-gating, emitting empty summary.`);
      summary = emptySummary();
    }
  }

  if (slackLineOnly) {
    process.stdout.write(renderSlackLine(summary, process.env.RUN_URL) + '\n');
    process.exit(0);
  }
  emit(summary);
  process.exit(0);
}

/** Write the human summary to the step summary (if available) + the machine line to stdout. */
function emit(summary: E2eFlakeSummary): void {
  const stepSummaryPath = process.env.GITHUB_STEP_SUMMARY;
  if (stepSummaryPath) {
    try {
      fs.appendFileSync(stepSummaryPath, renderSummaryMarkdown(summary) + '\n');
    } catch (e) {
      warn(`E2E flake summary: failed to write $GITHUB_STEP_SUMMARY (${(e as Error).message}) — continuing.`);
    }
  }
  // The machine-readable one-liner is the LAST stdout line so callers can `tail -1`
  // (release.yml "E2E flake summary" step captures it that way, then parses .verdict).
  // IMPORTANT — keep this the ONLY thing written to stdout: route ALL other logging
  // through warn() (stderr). A stray stdout line above this would be clipped/misparsed
  // by the `tail -1` capture. (Flagged by Phase-7 holistic review as a latent fragility.)
  process.stdout.write(renderMachineLine(summary) + '\n');
}

/**
 * A degenerate summary for a missing/corrupt report. No data → no flaky/
 * unexpected specs → clean-green by counts (the Playwright job's own non-zero
 * conclusion is what actually reds a crashed run; this step is non-gating). The
 * ::warning:: emitted by the caller is the observable signal that a run crashed
 * before reporting.
 */
function emptySummary(): E2eFlakeSummary {
  return { expected: 0, flaky: 0, unexpected: 0, skipped: 0, total: 0, verdict: 'clean-green', flakySpecs: [], unexpectedSpecs: [] };
}

function warn(msg: string): void {
  // ::warning:: surfaces in the GitHub Actions run UI without failing the step.
  console.error(`::warning::${msg}`);
}

// Only run the CLI when invoked directly, not when imported by tests.
const invokedDirectly =
  typeof process !== 'undefined' &&
  Array.isArray(process.argv) &&
  /summarize-e2e-results(\.ts|\.js|\.mjs)?$/.test(process.argv[1] ?? '');
if (invokedDirectly) {
  main(process.argv.slice(2));
}
