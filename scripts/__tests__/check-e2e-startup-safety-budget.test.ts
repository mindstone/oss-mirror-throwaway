import { describe, it, expect } from 'vitest';
import {
  evaluateBudgetContracts,
  extractStartupPerfCiBudget,
  extractStartupProbeCiDefault,
  type PhaseBudgetContract,
} from '../check-e2e-startup-safety-budget';

/**
 * Tests for the E2E safety-timeout vs CI perf-budget contract guard
 * (rec #28, postmortem 260531_ci_aware_startup_probe_timeout). Pure-function
 * tests against synthetic source text — no real filesystem reads.
 */

describe('extractStartupProbeCiDefault', () => {
  it('reads the CI-branch fallback literal (numeric separator)', () => {
    const src = `
  const STARTUP_PROBE_TIMEOUT_MS = process.env.CI
    ? Number(process.env.E2E_STARTUP_PROBE_TIMEOUT_MS) || 30_000
    : Number(process.env.E2E_STARTUP_PROBE_TIMEOUT_MS) || (usesFakeMedia ? 30_000 : 10_000);
`;
    expect(extractStartupProbeCiDefault(src)).toBe(30_000);
  });

  it('reads a plain (no-separator) literal', () => {
    const src = `const STARTUP_PROBE_TIMEOUT_MS = process.env.CI ? Number(x) || 5000 : 10000;`;
    expect(extractStartupProbeCiDefault(src)).toBe(5000);
  });

  it('fails closed (null) when the anchor is gone', () => {
    const src = `const SOMETHING_ELSE = process.env.CI ? 30_000 : 10_000;`;
    expect(extractStartupProbeCiDefault(src)).toBeNull();
  });

  it('does NOT match a COMMENTED-OUT assignment (fail-closed vs stale literal)', () => {
    // Commented-out old code + renamed real constant: must fail closed, not
    // return the stale commented literal.
    const src = [
      `// const STARTUP_PROBE_TIMEOUT_MS = process.env.CI ? Number(x) || 30_000 : 10_000;`,
      `const RENAMED = process.env.CI ? Number(x) || 5000 : 10_000;`,
    ].join('\n');
    expect(extractStartupProbeCiDefault(src)).toBeNull();
  });

  it('does NOT match a block-commented assignment', () => {
    const src = `/* const STARTUP_PROBE_TIMEOUT_MS = process.env.CI ? Number(x) || 30_000 : 1; */`;
    expect(extractStartupProbeCiDefault(src)).toBeNull();
  });
});

describe('extractStartupPerfCiBudget', () => {
  it('reads the CI branch of warnThreshold', () => {
    const src = `    const warnThreshold = isCI ? 6000 : 3000;`;
    expect(extractStartupPerfCiBudget(src)).toBe(6000);
  });

  it('fails closed (null) when warnThreshold is renamed', () => {
    const src = `const someBudget = isCI ? 6000 : 3000;`;
    expect(extractStartupPerfCiBudget(src)).toBeNull();
  });
});

function contractFor(srcByFile: Record<string, string>): {
  contract: PhaseBudgetContract;
  readFile: (rel: string) => string;
} {
  const contract: PhaseBudgetContract = {
    phase: 'startup',
    safety: { file: 'safety.ts', label: 'safety', extract: extractStartupProbeCiDefault },
    perfBudget: { file: 'budget.ts', label: 'budget', extract: extractStartupPerfCiBudget },
  };
  return { contract, readFile: (rel) => srcByFile[rel] ?? '' };
}

const SAFETY = (ms: string) =>
  `const STARTUP_PROBE_TIMEOUT_MS = process.env.CI ? Number(x) || ${ms} : 10_000;`;
const BUDGET = (ms: string) => `const warnThreshold = isCI ? ${ms} : 3000;`;

describe('evaluateBudgetContracts', () => {
  it('passes when safety > perf budget (the healthy current state)', () => {
    const { contract, readFile } = contractFor({ 'safety.ts': SAFETY('30_000'), 'budget.ts': BUDGET('6000') });
    const out = evaluateBudgetContracts([contract], readFile);
    expect(out).toHaveLength(1);
    expect(out[0]).toEqual({ kind: 'ok', phase: 'startup', safetyMs: 30_000, perfBudgetMs: 6000 });
  });

  it('fails when safety < perf budget (the 260531 regression: 5000 under 6000)', () => {
    const { contract, readFile } = contractFor({ 'safety.ts': SAFETY('5000'), 'budget.ts': BUDGET('6000') });
    const out = evaluateBudgetContracts([contract], readFile);
    expect(out[0]).toEqual({ kind: 'violation', phase: 'startup', safetyMs: 5000, perfBudgetMs: 6000 });
  });

  it('fails when safety EQUALS perf budget (must be strictly above)', () => {
    const { contract, readFile } = contractFor({ 'safety.ts': SAFETY('6000'), 'budget.ts': BUDGET('6000') });
    const out = evaluateBudgetContracts([contract], readFile);
    expect(out[0].kind).toBe('violation');
  });

  it('fails closed when the safety anchor is gone', () => {
    const { contract, readFile } = contractFor({ 'safety.ts': 'const x = 30_000;', 'budget.ts': BUDGET('6000') });
    const out = evaluateBudgetContracts([contract], readFile);
    expect(out[0]).toMatchObject({ kind: 'extract-failed', which: 'safety', file: 'safety.ts' });
  });

  it('fails closed when the perf-budget anchor is gone', () => {
    const { contract, readFile } = contractFor({ 'safety.ts': SAFETY('30_000'), 'budget.ts': 'const y = 6000;' });
    const out = evaluateBudgetContracts([contract], readFile);
    expect(out[0]).toMatchObject({ kind: 'extract-failed', which: 'perfBudget', file: 'budget.ts' });
  });
});
