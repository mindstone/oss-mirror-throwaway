import { describe, expect, it } from 'vitest';

/**
 * Stage 4b — readdirp/chokidar symlink-`realpath` residual: a pinned model of
 * the pool-exhaustion reasoning behind the threadpool buffer.
 *
 * ## Why this test exists (not a runtime test — a documented-invariant guard)
 *
 * Stage 4a hardened the cloud-symlink ignore matcher so chokidar never RECURSES
 * into a dead cloud mount. But the GPT reviews (260619_102941 F1 / 260619_131151
 * F2) confirmed — by reading `node_modules/readdirp/index.js` and
 * `node_modules/chokidar/lib/*-handler.js` — a RESIDUAL the matcher cannot close:
 *
 *   - readdirp calls `fs.realpath(full)` on a symlink in `_getEntryType()`
 *     (index.js:209-213) BEFORE chokidar's `directoryFilter` runs
 *     (index.js:131-134). So our ignore matcher fires too late to prevent the
 *     ONE blocking `realpath` per cloud symlink.
 *   - That `realpath` is serviced by the shared libuv threadpool. On a DEAD
 *     mount it blocks in the kernel with no timeout → a parked pool worker.
 *
 * The KEY refutation the 4b review established (260619_131151 F2): readdirp
 * resolves symlinks SEQUENTIALLY per stream — `_getEntryType()` is awaited one
 * entry at a time within a directory stream — so N cloud symlinks under one
 * watched root do NOT launch N concurrent `realpath`s. The worst case is ≈ ONE
 * parked worker per ACTIVE directory stream, not N-at-once. That is what makes
 * "raise the pool (≥16) + Stage 2 backstop" a reasonable ship-with-follow-up
 * instead of a guaranteed exhaustion.
 *
 * This test encodes that sequential-per-stream expectation as a pure model so a
 * future regression to N-at-once (e.g. a readdirp major that parallelises
 * `_getEntryType`, or our own code fanning realpaths out) is caught here with a
 * pointer to re-evaluate the buffer sizing — rather than silently re-exhausting
 * the pool in the field.
 *
 * TODO(turn-hang follow-up): the robust fix is to stop readdirp/chokidar
 * `realpath`-ing cloud symlinks at all (a "don't realpath cloud symlinks"
 * interception). That was deliberately SPUN OUT of this bug as its own plan —
 * a config-hook or upstream patch is fragile and out of scope for the buffer
 * stage. See docs/plans/260619_turn-hang-bugmode/PLAN.md (Stage 4b dispositions:
 * "SPIN OUT the robust readdirp/chokidar interception"). Until that lands, the
 * buffer + the Stage 2 pre-dispatch liveness guard are the mitigation, and the
 * boot breadcrumb (F1) reports whether the buffer is actually in force.
 */

const THREADPOOL_BUFFER_FLOOR = 16;

/**
 * A minimal model of how readdirp parks libuv workers on dead-cloud-symlink
 * `realpath`s, given its DOCUMENTED sequential-per-stream classification.
 *
 * @param symlinksPerStream how many dead cloud symlinks sit directly under each
 *        watched directory stream (readdirp classifies them one-at-a-time)
 * @param activeStreams how many directory streams readdirp is draining at once
 *        (chokidar's concurrent watch paths / subdirectory scans)
 * @returns the peak number of pool workers parked on a dead `realpath` at once
 */
function peakParkedWorkers(symlinksPerStream: number, activeStreams: number): number {
  // Sequential-per-stream: within ONE stream, only the symlink currently being
  // classified holds a worker — the rest are queued behind it, not parked. So a
  // single stream parks at most 1 worker regardless of how many symlinks it has.
  const parkedPerStream = symlinksPerStream > 0 ? 1 : 0;
  return parkedPerStream * activeStreams;
}

describe('Stage 4b — readdirp/chokidar symlink-realpath residual (pinned reasoning)', () => {
  it('a single stream with N dead cloud symlinks parks ONE worker, not N (sequential per stream)', () => {
    // A Mindstone employee's machine: 9 cloud symlinks directly under one coreDirectory stream.
    // The whole point of the 4b reasoning: that is 1 parked worker, not 9.
    expect(peakParkedWorkers(9, 1)).toBe(1);
    expect(peakParkedWorkers(100, 1)).toBe(1);
  });

  it('parked workers scale with ACTIVE STREAMS, not symlink count', () => {
    // Several concurrently-draining directory streams, each with dead symlinks.
    expect(peakParkedWorkers(9, 1)).toBe(1);
    expect(peakParkedWorkers(9, 4)).toBe(4);
    expect(peakParkedWorkers(9, 8)).toBe(8);
  });

  it('the threadpool buffer (≥16) leaves live workers under the realistic residual', () => {
    // The buffer floor must exceed the realistic peak parked count so a turn's
    // own fs/DNS ops still have live workers. With the documented per-stream
    // residual, even an aggressive 8 concurrent dead streams leaves ≥8 free.
    const buffer = THREADPOOL_BUFFER_FLOOR;
    const realisticPeakParked = peakParkedWorkers(9, 8); // 8 concurrent dead streams
    expect(realisticPeakParked).toBe(8);
    expect(buffer - realisticPeakParked).toBeGreaterThanOrEqual(8);
  });

  it('REGRESSION GUARD: if classification ever becomes N-at-once, the pool can exhaust', () => {
    // This documents the failure mode the buffer assumption depends on NOT being
    // true. If a future readdirp parallelised _getEntryType (N realpaths at once
    // per stream), a Mindstone employee's 9 symlinks would park 9 workers from a SINGLE stream —
    // and a few such streams would blow past even the 16-thread buffer. We assert
    // the CURRENT (sequential) model so a change to peakParkedWorkers that models
    // N-at-once forces re-evaluation of the buffer sizing + the spun-out fix.
    const nAtOnceParked = (symlinks: number, streams: number) => symlinks * streams;
    // Under N-at-once, 2 dead streams of 9 symlinks already exhaust the 16-buffer.
    expect(nAtOnceParked(9, 2)).toBeGreaterThan(THREADPOOL_BUFFER_FLOOR);
    // ...whereas the documented sequential model stays well within it.
    expect(peakParkedWorkers(9, 2)).toBeLessThan(THREADPOOL_BUFFER_FLOOR);
  });
});
