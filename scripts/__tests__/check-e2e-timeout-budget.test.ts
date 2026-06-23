import { describe, it, expect } from 'vitest';
import { findTimeoutBudgetViolations } from '../check-e2e-timeout-budget';

/**
 * Tests for the E2E lifecycle-wait timeout-budget guard (260531 voice-session
 * firstWindow regression class). Pure-function tests against synthetic source.
 */

describe('findTimeoutBudgetViolations', () => {
  it('flags a fixed firstWindow literal above the threshold', () => {
    const src = `window = await app.firstWindow({ timeout: 120_000 });`;
    const v = findTimeoutBudgetViolations(src, 'spec.ts');
    expect(v).toHaveLength(1);
    expect(v[0].valueMs).toBe(120_000);
  });

  it('flags a 60s fixed literal (the latent next-bottleneck)', () => {
    const src = `await electronApp.firstWindow({ timeout: 60_000 });`;
    const v = findTimeoutBudgetViolations(src, 'spec.ts');
    expect(v).toHaveLength(1);
  });

  it('does NOT flag a literal at or below the 30s threshold', () => {
    const src = `await app.firstWindow({ timeout: 30000 });`;
    expect(findTimeoutBudgetViolations(src, 'spec.ts')).toEqual([]);
  });

  it('does NOT flag a CI-aware expression variable', () => {
    const src = `await app.firstWindow({ timeout: firstWindowTimeoutMs() });`;
    expect(findTimeoutBudgetViolations(src, 'spec.ts')).toEqual([]);
  });

  it('does NOT flag a bare identifier (already abstracted)', () => {
    const src = `await app.firstWindow({ timeout: STARTUP_PROBE_TIMEOUT_MS });`;
    expect(findTimeoutBudgetViolations(src, 'spec.ts')).toEqual([]);
  });

  it('does NOT flag a process.env.CI inline expression', () => {
    const src = `await app.firstWindow({ timeout: process.env.CI ? 240_000 : 60_000 });`;
    expect(findTimeoutBudgetViolations(src, 'spec.ts')).toEqual([]);
  });

  it('respects an inline timeout-budget-ok justification on the same line', () => {
    const src = `await app.firstWindow({ timeout: 120_000 }); // timeout-budget-ok: fixed for X`;
    expect(findTimeoutBudgetViolations(src, 'spec.ts')).toEqual([]);
  });

  it('respects a timeout-budget-ok justification on the line above', () => {
    const src = [
      `// timeout-budget-ok: deliberate fixed budget for slow fixture`,
      `await app.firstWindow({ timeout: 120_000 });`,
    ].join('\n');
    expect(findTimeoutBudgetViolations(src, 'spec.ts')).toEqual([]);
  });

  it('catches a fixed arithmetic-product bypass (60 * 1000)', () => {
    const src = `await app.firstWindow({ timeout: 60 * 1000 });`;
    const v = findTimeoutBudgetViolations(src, 'spec.ts');
    expect(v).toHaveLength(1);
    expect(v[0].valueMs).toBe(60_000);
  });

  it('does NOT flag a product at/below threshold (e.g. 30 * 1000)', () => {
    const src = `await app.firstWindow({ timeout: 30 * 1000 });`;
    expect(findTimeoutBudgetViolations(src, 'spec.ts')).toEqual([]);
  });

  it('does NOT flag describe.configure or test.setTimeout budgets (out of scope)', () => {
    const src = [
      `test.describe.configure({ timeout: 300_000 });`,
      `test.setTimeout(660_000);`,
    ].join('\n');
    expect(findTimeoutBudgetViolations(src, 'spec.ts')).toEqual([]);
  });

  it('reports the correct line number', () => {
    const src = ['line one', 'line two', `await app.firstWindow({ timeout: 90_000 });`].join('\n');
    const v = findTimeoutBudgetViolations(src, 'spec.ts');
    expect(v[0].line).toBe(3);
  });
});
