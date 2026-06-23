import { describe, expect, it } from 'vitest';
import { evaluateLiveApiRun } from '../check-live-api-ran';

describe('evaluateLiveApiRun (explicit live-API run guard)', () => {
  it('fails when zero non-pending cells ran (the keyless silent-green case)', () => {
    // Every cell skipped because no TEST_*_API_KEY was set: numPending > 0, ran == 0.
    const verdict = evaluateLiveApiRun({
      numPassedTests: 0,
      numFailedTests: 0,
      numPendingTests: 9,
    });
    expect(verdict.ok).toBe(false);
    expect(verdict.ran).toBe(0);
    expect(verdict.skipped).toBe(9);
    // Actionable, points at the capture step.
    expect(verdict.message).toMatch(/capture-live-api-keys/);
  });

  it('passes when at least one cell ran (single-provider-key partial run)', () => {
    // Only the anthropic key was set: its cells passed, the other providers skipped.
    const verdict = evaluateLiveApiRun({
      numPassedTests: 3,
      numFailedTests: 0,
      numPendingTests: 6,
    });
    expect(verdict.ok).toBe(true);
    expect(verdict.ran).toBe(3);
    expect(verdict.skipped).toBe(6);
  });

  it('passes (ran > 0) even when a live cell failed — a real failure is not a silent skip', () => {
    const verdict = evaluateLiveApiRun({
      numPassedTests: 2,
      numFailedTests: 1,
      numPendingTests: 6,
    });
    // The guard only enforces "something ran"; vitest's own non-zero exit surfaces the failure.
    expect(verdict.ok).toBe(true);
    expect(verdict.ran).toBe(3);
  });

  it('treats missing counters as zero (defensive against a sparse report)', () => {
    const verdict = evaluateLiveApiRun({});
    expect(verdict.ok).toBe(false);
    expect(verdict.ran).toBe(0);
    expect(verdict.skipped).toBe(0);
  });
});
