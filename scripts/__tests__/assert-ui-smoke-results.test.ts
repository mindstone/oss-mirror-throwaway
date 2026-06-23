import { describe, expect, it } from 'vitest';
import {
  classifyPhase,
  computeVerdict,
  parseLogContent,
  type PhaseOutcome,
} from '../ci/assert-ui-smoke-results';

// ── Fixtures mirroring the real droid output shapes observed in CI ──

/** The 20-byte baseline no-op that triggered the false alarm on run 27407524386. */
const NOOP_OUTPUT = 'Plan is up-to-date.\n';

function jsonPhase(steps: object[], consoleErrors: string[] = []): string {
  return [
    'preamble chatter from the droid...',
    '=== SMOKE_TEST_JSON_START ===',
    JSON.stringify({ steps, raw_console_errors: consoleErrors }, null, 2),
    '=== SMOKE_TEST_JSON_END ===',
    '',
    '=== UI SMOKE TEST RESULTS ===',
    'OVERALL: PASS',
    '=== END RESULTS ===',
  ].join('\n');
}

const PASS_STEP = { name: 'Journey 1', category: 'regression', rendered: true, status: 'PASS', detail: 'all good', screenshot: null };
const FINAL_STEP = { name: 'Final', category: 'final', rendered: true, status: 'PASS', detail: 'ok' };
const BASELINE_STEP = { name: 'Baseline 1', category: 'baseline', rendered: true, status: 'PASS', detail: 'ok' };
/** A complete baseline phase: all three numbered checks passing + rendered. */
const BASELINE_STEPS = [
  { name: 'Baseline 1: App renders', category: 'baseline', rendered: true, status: 'PASS', detail: 'ok' },
  { name: 'Baseline 2: Core tab navigation', category: 'baseline', rendered: true, status: 'PASS', detail: 'all 5 tabs' },
  { name: 'Baseline 3: No console errors', category: 'baseline', rendered: true, status: 'PASS', detail: 'clean' },
];

const GATE = { baselineGatePhase: 'Baseline' } as const;
const BASELINE_KEYS: { requiredBaselineCheckKeys: string[] } = { requiredBaselineCheckKeys: ['1', '2', '3'] };

describe('parseLogContent', () => {
  it('classifies a degenerate "Plan is up-to-date." no-op as inconclusive (not failure)', () => {
    expect(parseLogContent(NOOP_OUTPUT, 'Baseline', 0).status).toBe('inconclusive');
  });

  it('classifies a missing/empty output as inconclusive', () => {
    expect(parseLogContent('', 'Baseline', -1).status).toBe('inconclusive');
  });

  it('classifies a LONG no-op message (>50 chars, exit 0) as inconclusive, not a pass', () => {
    const longNoop = 'Plan is up-to-date. Everything already looks fine and there is nothing further to do here at all today.';
    expect(longNoop.length).toBeGreaterThan(50);
    expect(parseLogContent(longNoop, 'Baseline', 0).status).toBe('inconclusive');
  });

  it('does NOT classify a clean exit with vague prose as a pass (fail-closed on ambiguity)', () => {
    expect(parseLogContent('The smoke run finished and the dev server was stopped.', 'Baseline', 0).status).toBe(
      'inconclusive',
    );
  });

  it('parses a well-formed JSON block as parsed results', () => {
    expect(parseLogContent(jsonPhase([PASS_STEP, FINAL_STEP]), 'Regression', 0).status).toBe('parsed');
  });

  it('treats malformed JSON between markers as a failure, not a no-op', () => {
    expect(parseLogContent('=== SMOKE_TEST_JSON_START ===\n{ not json ]\n=== SMOKE_TEST_JSON_END ===', 'Regression', 0).status).toBe('failure');
  });

  it('detects a free-text OVERALL: FAIL as a failure', () => {
    expect(parseLogContent('=== UI SMOKE TEST RESULTS ===\nOVERALL: FAIL (1 failed)\n=== END RESULTS ===', 'Regression', 0).status).toBe('failure');
  });

  it('does NOT swallow a real failure that co-occurs with a no-op phrase', () => {
    expect(parseLogContent('Plan is up-to-date. The app crashed during Settings.', 'Baseline', 0).status).toBe('failure');
    expect(parseLogContent('nothing to do; final check failed', 'Regression', 0).status).toBe('failure');
  });

  it('detects raw ERRORS: console-error prose as a failure (the dup-key bug signal — round-3 F1)', () => {
    expect(parseLogContent('ERRORS: Encountered two children with the same key, mcp_transition-1781084493570--', 'Regression', 0).status).toBe('failure');
    expect(parseLogContent('Settings showed an error and could not load after clicking the tab.', 'Regression', 0).status).toBe('failure');
  });

  it('does NOT treat "No console errors" prose as a failure', () => {
    // No structured result, but the only error mention is negated → not a failure.
    expect(parseLogContent('No console errors were observed during the run.', 'Regression', 0).status).not.toBe('failure');
  });

  it('does NOT let a negated fail phrase cancel a separate real failure (round-4 F2)', () => {
    expect(parseLogContent('The app did not fail to launch. Settings failed.', 'Regression', 0).status).toBe('failure');
  });

  it('treats a summary block with error prose but no explicit FAIL line as a failure (round-4 F3)', () => {
    const out = '=== UI SMOKE TEST RESULTS ===\nConsole errors: ERRORS: could not load Settings\nOVERALL: PASS\n=== END RESULTS ===';
    expect(parseLogContent(out, 'Regression', 0).status).toBe('failure');
  });

  it('does NOT flag a benign summary whose only error mention is the negated check label', () => {
    const out = '=== UI SMOKE TEST RESULTS ===\nConsole errors: PASS - No console errors\nOVERALL: PASS\n=== END RESULTS ===';
    expect(parseLogContent(out, 'Regression', 0).status).toBe('freeTextPass');
  });
});

describe('classifyPhase', () => {
  it('marks a phase with a FAIL step as fail', () => {
    const parse = parseLogContent(jsonPhase([{ ...PASS_STEP, status: 'FAIL', detail: 'broke' }]), 'Regression', 0);
    expect(classifyPhase(parse, ['regression']).classification).toBe('fail');
  });

  it('marks a phase with console errors as fail (the 2026-06-10 dup-key bug shape)', () => {
    const parse = parseLogContent(
      jsonPhase([PASS_STEP, FINAL_STEP], ['Encountered two children with the same key, mcp_transition-1781084493570--']),
      'Regression',
      0,
    );
    const outcome = classifyPhase(parse, ['regression', 'final']);
    expect(outcome.classification).toBe('fail');
    expect(outcome.failures.join(' ')).toContain('console error');
  });

  it('marks a healthy parsed phase as pass with parsedSteps=true', () => {
    const outcome = classifyPhase(parseLogContent(jsonPhase([PASS_STEP, FINAL_STEP]), 'Regression', 0), ['regression', 'final']);
    expect(outcome.classification).toBe('pass');
    expect(outcome.parsedSteps).toBe(true);
  });

  it('marks an explicit free-text pass as pass with parsedSteps=false', () => {
    const outcome = classifyPhase(parseLogContent('=== UI SMOKE TEST RESULTS ===\nOVERALL: PASS\n=== END RESULTS ===', 'Baseline', 0), ['baseline']);
    expect(outcome.classification).toBe('pass');
    expect(outcome.parsedSteps).toBe(false);
  });

  it('fails a parsed result with zero steps — "no steps reported"', () => {
    const emptyJson = '=== SMOKE_TEST_JSON_START ===\n{"steps": [], "raw_console_errors": []}\n=== SMOKE_TEST_JSON_END ===';
    const outcome = classifyPhase(parseLogContent(emptyJson, 'Custom', 0), []);
    expect(outcome.classification).toBe('fail');
    expect(outcome.failures.join(' ')).toContain('no steps reported');
  });

  it('fails a parsed phase missing a required category (droid ran but skipped baseline)', () => {
    expect(classifyPhase(parseLogContent(jsonPhase([PASS_STEP]), 'Baseline', 0), ['baseline']).classification).toBe('fail');
  });

  it('passes an inconclusive parse through as inconclusive', () => {
    expect(classifyPhase(parseLogContent(NOOP_OUTPUT, 'Baseline', 0), ['baseline']).classification).toBe('inconclusive');
  });

  it('FAILS a baseline phase that omits a required numbered check (round-4 F1 — partial coverage)', () => {
    // Only "Baseline 1" present → missing Baseline 2 (tab nav) + 3 (console).
    const outcome = classifyPhase(parseLogContent(jsonPhase([BASELINE_STEP]), 'Baseline', 0), ['baseline'], BASELINE_KEYS);
    expect(outcome.classification).toBe('fail');
    expect(outcome.failures.join(' ')).toContain('baseline coverage incomplete');
  });

  it('PASSES a baseline phase that reports all three numbered checks', () => {
    const outcome = classifyPhase(parseLogContent(jsonPhase(BASELINE_STEPS), 'Baseline', 0), ['baseline'], BASELINE_KEYS);
    expect(outcome.classification).toBe('pass');
  });
});

function outcome(
  name: string,
  classification: PhaseOutcome['classification'],
  { failures = [], parsedSteps = classification === 'pass' }: { failures?: string[]; parsedSteps?: boolean } = {},
): PhaseOutcome {
  return {
    phaseName: name,
    classification,
    failures,
    reason: classification === 'inconclusive' ? `${name}: no usable output` : undefined,
    parsedSteps,
    stats: { passed: 0, failed: 0, skipped: 0, total: parsedSteps ? 1 : 0 },
  };
}

describe('computeVerdict (default mode — baseline gate)', () => {
  it('PASSES when baseline is a parsed pass and regression passed', () => {
    const v = computeVerdict([outcome('Baseline', 'pass'), outcome('Regression', 'pass')], GATE);
    expect(v.verdict).toBe('pass');
    expect(v.exitCode).toBe(0);
  });

  it('PASSES with an incomplete-coverage warning when baseline passed but regression was a no-op', () => {
    const v = computeVerdict([outcome('Baseline', 'pass'), outcome('Regression', 'inconclusive')], GATE);
    expect(v.verdict).toBe('pass');
    expect(v.text).toContain('Regression coverage incomplete');
  });

  it('INCONCLUSIVE when baseline no-ops (after retry) even if regression passed — NO substitution', () => {
    const v = computeVerdict([outcome('Baseline', 'inconclusive'), outcome('Regression', 'pass')], GATE);
    expect(v.verdict).toBe('inconclusive');
    expect(v.exitCode).toBe(1);
    expect(v.text).toContain('baseline coverage');
    expect(v.text).not.toContain('TEST FAIL');
  });

  it('INCONCLUSIVE when baseline is only a free-text pass with no parsed steps (deletion-trap guard)', () => {
    const v = computeVerdict(
      [outcome('Baseline', 'pass', { parsedSteps: false }), outcome('Regression', 'pass')],
      GATE,
    );
    expect(v.verdict).toBe('inconclusive');
    expect(v.text).toContain('unstructured pass');
  });

  it('FAILS when any phase reported a real failure', () => {
    const v = computeVerdict(
      [outcome('Baseline', 'pass'), outcome('Regression', 'fail', { failures: ['Regression: 1 step(s) FAILED'] })],
      GATE,
    );
    expect(v.verdict).toBe('fail');
    expect(v.text).toContain('TEST FAIL');
  });

  it('FAILS even when baseline no-ops alongside a regression failure — inconclusive never masks a fail', () => {
    const v = computeVerdict(
      [outcome('Baseline', 'inconclusive'), outcome('Regression', 'fail', { failures: ['Regression: console error(s)'] })],
      GATE,
    );
    expect(v.verdict).toBe('fail');
  });

  it('INCONCLUSIVE when every phase is a no-op', () => {
    const v = computeVerdict([outcome('Baseline', 'inconclusive'), outcome('Regression', 'inconclusive')], GATE);
    expect(v.verdict).toBe('inconclusive');
    expect(v.exitCode).toBe(1);
  });
});

describe('computeVerdict (custom dispatch mode — no baseline gate)', () => {
  it('any passing phase greens; fail fails; all-inconclusive is inconclusive', () => {
    expect(computeVerdict([outcome('Custom', 'pass')]).verdict).toBe('pass');
    expect(computeVerdict([outcome('Custom', 'fail', { failures: ['Custom: boom'] })]).verdict).toBe('fail');
    expect(computeVerdict([outcome('Custom', 'inconclusive')]).verdict).toBe('inconclusive');
  });
});

// End-to-end: drive the full parse → classify → verdict pipeline with the real
// shapes from recent CI runs, asserting each lands on the intended verdict.
describe('end-to-end verdict against real run shapes', () => {
  function run(baselineOut: string, regressionOut: string) {
    const b = classifyPhase(parseLogContent(baselineOut, 'Baseline', 0), ['baseline'], BASELINE_KEYS);
    const r = classifyPhase(parseLogContent(regressionOut, 'Regression', 0), ['regression', 'final']);
    return computeVerdict([b, r], GATE);
  }

  it('baseline parsed PASS (all 3 checks) + regression PASS → PASS (steady state after a successful retry)', () => {
    expect(run(jsonPhase(BASELINE_STEPS), jsonPhase([PASS_STEP, FINAL_STEP])).verdict).toBe('pass');
  });

  it('27407524386 (today, persistent baseline no-op) + regression PASS → INCONCLUSIVE', () => {
    expect(run(NOOP_OUTPUT, jsonPhase([PASS_STEP, FINAL_STEP])).verdict).toBe('inconclusive');
  });

  it('27338023786 (06-11): both phases no-op → INCONCLUSIVE', () => {
    expect(run(NOOP_OUTPUT, NOOP_OUTPUT).verdict).toBe('inconclusive');
  });

  it('27266703882 (06-10): baseline PASS + regression dup-key console errors → FAIL', () => {
    const regression = jsonPhase([PASS_STEP, FINAL_STEP], ['Encountered two children with the same key, mcp_transition-1781084493570--']);
    expect(run(jsonPhase(BASELINE_STEPS), regression).verdict).toBe('fail');
  });
});
