/**
 * Performance benchmark for `computeDiff` on a 10k-line synthetic input.
 *
 * Gated by the `RUN_PERF_TESTS=1` env var — this suite is skipped by
 * default because its timing assertions are hardware-dependent and flake
 * easily in CI under load.
 *
 * Baseline recorded on: Apple M-series MacBook Pro (darwin 25.3.0),
 * Node 24.7.0, 36 GB RAM, 2026-04-17.
 *
 *   - `computeDiff` on the 10k-line corpus:       ~4 ms typical
 *     (observed 4.2 ms in the run that set this baseline).
 *   - `computeDiffAsync` (with default yield):    ~4 ms typical
 *     (observed 3.8 ms; scheduling overhead is in the sub-ms noise
 *     floor for this input size).
 *
 * The 10k-line synthetic fixture built by `build10kLineCorpusCase()`
 * contains 20 well-separated modifications and is intentionally
 * friendly to jsdiff's Myers LCS (the common-subsequence dominates).
 * For worst-case inputs (many short, adversarial edits) expect order-
 * of-magnitude higher latency.
 *
 * The assertions below use generous upper bounds (1 s) so they catch
 * only catastrophic regressions (order-of-magnitude slowdowns, e.g., an
 * accidental O(n^2) path). Tune these down only if CI / reference
 * hardware becomes stable enough.
 *
 * To run locally:
 *
 *   RUN_PERF_TESTS=1 npx vitest run packages/shared/src/__tests__/diff.perf.test.ts
 */

import { describe, expect, it } from 'vitest';
import { computeDiff, computeDiffAsync } from '../diff';
import { build10kLineCorpusCase } from './diffCorpus';

const RUN_PERF_TESTS = process.env.RUN_PERF_TESTS === '1';
const describePerf = RUN_PERF_TESTS ? describe : describe.skip;

describePerf('computeDiff perf — 10k-line synthetic corpus', () => {
  it('sync diff completes in under 1 s on a 10k-line input', () => {
    const { before, after, expectedStats } = build10kLineCorpusCase();
    const start = performance.now();
    const result = computeDiff(before, after);
    const elapsed = performance.now() - start;
    // eslint-disable-next-line no-console -- perf gate output is the whole point of this test
    console.log(`[perf] computeDiff(10k-line): ${elapsed.toFixed(1)} ms`);
    expect(result.stats).toEqual(expectedStats);
    expect(elapsed).toBeLessThan(1000);
  });

  it('async diff completes in under 1 s on a 10k-line input', async () => {
    const { before, after, expectedStats } = build10kLineCorpusCase();
    const start = performance.now();
    const result = await computeDiffAsync(before, after);
    const elapsed = performance.now() - start;
    // eslint-disable-next-line no-console -- perf gate output is the whole point of this test
    console.log(`[perf] computeDiffAsync(10k-line): ${elapsed.toFixed(1)} ms`);
    expect(result.stats).toEqual(expectedStats);
    expect(elapsed).toBeLessThan(1000);
  });
});
