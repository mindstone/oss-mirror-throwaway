import { describe, it, expect } from 'vitest';
import { analyzePrivacyCiGate, countPrivacyExitBlocks, REQUIRED_PR_PATHS } from '../check-botqa-privacy-ci-gate';

const GOOD_WORKFLOW = `name: Eval Harness
on:
  schedule:
    - cron: '0 6 */3 * *'
  pull_request:
    paths:
      - 'evals/watchdog-judge.ts'
      - 'evals/botqa-transcript.ts'
      - 'evals/fixtures/botqa-transcript/**'
jobs:
  eval:
    runs-on: ubuntu-latest
    strategy:
      matrix:
        include:
          - eval:
              key: watchdog-judge
              script: watchdog-judge.ts
          - eval:
              key: botqa-transcript
              script: botqa-transcript.ts
`;

// Two privacy guards: single-run direct + multi-run via flag, plus an unrelated exit.
const GOOD_HARNESS = `
  const allPass = summary.privacyViolations === 0 && summary.accuracy >= 0.85;
  if (summary.privacyViolations > 0) {
    console.error('FAIL');
    process.exit(1);
  }
  const anyCritical = runs.some((r) => r.privacyViolations > 0 || r.wrong > 0);
  if (anyCritical) {
    process.exit(1);
  }
  if (unrelatedError) {
    process.exit(1);
  }
`;

function makeDeps(overrides: Partial<Parameters<typeof analyzePrivacyCiGate>[0]> = {}) {
  return {
    workflowYaml: GOOD_WORKFLOW,
    harnessSource: GOOD_HARNESS,
    fixtureCategories: ['transcript-answer', 'privacy', 'privacy', 'conciseness'],
    ...overrides,
  };
}

describe('analyzePrivacyCiGate', () => {
  it('PASSES on a well-formed workflow + harness + fixtures', () => {
    const result = analyzePrivacyCiGate(makeDeps());
    expect(result.exitCode).toBe(0);
    expect(result.errors).toHaveLength(0);
  });

  it('FAILS when a required PR path is removed', () => {
    const stripped = GOOD_WORKFLOW.replace("      - 'evals/botqa-transcript.ts'\n", '');
    const result = analyzePrivacyCiGate(makeDeps({ workflowYaml: stripped }));
    expect(result.exitCode).toBe(1);
    expect(result.errors.join('\n')).toMatch(/pull_request.paths is missing "evals\/botqa-transcript.ts"/);
  });

  it('FAILS when the botqa-transcript matrix entry is removed', () => {
    const noBotqa = GOOD_WORKFLOW.replace(
      /          - eval:\n              key: botqa-transcript\n              script: botqa-transcript.ts\n/,
      '',
    );
    const result = analyzePrivacyCiGate(makeDeps({ workflowYaml: noBotqa }));
    expect(result.exitCode).toBe(1);
    expect(result.errors.join('\n')).toMatch(/matrix.include no longer has a botqa-transcript entry/);
  });

  it('FAILS when a privacy hard-exit guard path is removed (only one remains)', () => {
    // Remove the multi-run guard; leave single-run + an unrelated exit.
    const oneGuard = `
      if (summary.privacyViolations > 0) { process.exit(1); }
      if (unrelated) { process.exit(1); }
      const allPass = summary.accuracy >= 0.85;
    `;
    const result = analyzePrivacyCiGate(makeDeps({ harnessSource: oneGuard }));
    expect(result.exitCode).toBe(1);
    expect(result.errors.join('\n')).toMatch(/privacy-violation→process.exit\(1\) guard/);
  });

  it('FAILS when both privacy hard-exit guards are removed', () => {
    const result = analyzePrivacyCiGate(
      makeDeps({ harnessSource: 'const allPass = summary.accuracy >= 0.85; if (x) { process.exit(1); }' }),
    );
    expect(result.exitCode).toBe(1);
    expect(result.errors.join('\n')).toMatch(/privacy-violation→process.exit\(1\) guard/);
  });

  it('FAILS when the aggregate accuracy floor is removed', () => {
    const noFloor = `
      if (summary.privacyViolations > 0) { process.exit(1); }
    `;
    const result = analyzePrivacyCiGate(makeDeps({ harnessSource: noFloor }));
    expect(result.exitCode).toBe(1);
    expect(result.errors.join('\n')).toMatch(/accuracy floor/);
  });

  it('FAILS when no privacy-category fixture exists', () => {
    const result = analyzePrivacyCiGate(
      makeDeps({ fixtureCategories: ['transcript-answer', 'conciseness'] }),
    );
    expect(result.exitCode).toBe(1);
    expect(result.errors.join('\n')).toMatch(/category.*privacy/i);
  });

  it('exposes the two required PR paths', () => {
    expect(REQUIRED_PR_PATHS).toContain('evals/botqa-transcript.ts');
    expect(REQUIRED_PR_PATHS).toContain('evals/fixtures/botqa-transcript/**');
  });
});

describe('countPrivacyExitBlocks — co-location (BLOCKER2 regression)', () => {
  it('counts a direct privacy if-guard', () => {
    expect(countPrivacyExitBlocks('if (summary.privacyViolations > 0) { process.exit(1); }')).toBe(1);
  });

  it('counts a flag-derived privacy if-guard (multi-run pattern)', () => {
    const src = 'const f = runs.some((r) => r.privacyViolations > 0); if (f) { process.exit(1); }';
    expect(countPrivacyExitBlocks(src)).toBe(1);
  });

  it('does NOT count an unrelated process.exit(1)', () => {
    expect(countPrivacyExitBlocks('if (somethingElse) { process.exit(1); }')).toBe(0);
  });

  it('does NOT count a privacy if-guard whose branch exits with a non-1 code', () => {
    expect(countPrivacyExitBlocks('if (summary.privacyViolations > 0) { process.exit(0); }')).toBe(0);
  });

  it('counts both the single-run and multi-run guards, ignoring unrelated exits', () => {
    const src = `
      if (summary.privacyViolations > 0) { process.exit(1); }
      const anyCritical = runs.some((r) => r.privacyViolations > 0);
      if (anyCritical) { process.exit(1); }
      if (unrelated) { process.exit(1); }
    `;
    expect(countPrivacyExitBlocks(src)).toBe(2);
  });
});
