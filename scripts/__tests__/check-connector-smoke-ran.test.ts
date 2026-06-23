import { describe, expect, it } from 'vitest';
import { evaluateConnectorSmokeRun } from '../check-connector-smoke-ran';

describe('evaluateConnectorSmokeRun', () => {
  it('fails when zero cells ran (every cell skipped — credless explicit run)', () => {
    const verdict = evaluateConnectorSmokeRun({ numPassedTests: 0, numFailedTests: 0, numPendingTests: 6 });
    expect(verdict.ok).toBe(false);
    expect(verdict.ran).toBe(0);
    expect(verdict.skipped).toBe(6);
    expect(verdict.message).toMatch(/0 cells that actually ran/);
  });

  it('passes when at least one cell ran (a connected connector), others skipped', () => {
    const verdict = evaluateConnectorSmokeRun({ numPassedTests: 2, numFailedTests: 0, numPendingTests: 4 });
    expect(verdict.ok).toBe(true);
    expect(verdict.ran).toBe(2);
    expect(verdict.skipped).toBe(4);
  });

  it('passes (ran > 0) even if a run had a failure — a real failure is not a silent skip', () => {
    const verdict = evaluateConnectorSmokeRun({ numPassedTests: 1, numFailedTests: 1, numPendingTests: 4 });
    expect(verdict.ok).toBe(true);
    expect(verdict.ran).toBe(2);
  });

  it('treats missing counts as zero', () => {
    const verdict = evaluateConnectorSmokeRun({});
    expect(verdict.ok).toBe(false);
    expect(verdict.ran).toBe(0);
  });
});
