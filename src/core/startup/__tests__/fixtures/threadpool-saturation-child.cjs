'use strict';

/**
 * libuv-pool-saturation probe child (fixture for
 * `../threadpoolSaturation.integration.test.ts`).
 *
 * Spawned by the parent test with a controlled `UV_THREADPOOL_SIZE` (and
 * `BLOCKERS`) in its env. libuv reads `UV_THREADPOOL_SIZE` exactly ONCE, at the
 * first async threadpool op (`uv_once`), so the only way to vary the pool size
 * per scenario is a fresh child process — hence this fixture.
 *
 * It proves the shared-pool saturation MECHANISM by CAUSAL ORDERING, never by
 * wall-clock timing:
 *   1. Submit `BLOCKERS` `crypto.pbkdf2` "blocker" ops on the same synchronous
 *      tick. Each parks one pool worker for ~100-300ms (large-but-finite
 *      iterations, so the process always terminates).
 *   2. THEN, on that SAME tick, submit one "sentinel" `fs.stat` pool op against a
 *      real file (this file).
 *
 * Submission order is load-bearing: all blockers are submitted before the
 * sentinel so libuv hands its free workers to the blockers first. If a free
 * worker remains (pool size > blockers), the sentinel runs immediately and
 * `sentinel-completed` is emitted BEFORE the first `blocker-completed`. If the
 * pool is saturated (pool size <= blockers), the sentinel must wait for a
 * blocker to free a worker, so the first `blocker-completed` precedes
 * `sentinel-completed`. "Did the sentinel finish before any blocker?" is exactly
 * "was there a free worker?" — CPU-speed-independent.
 *
 * Events are line-delimited JSON on stdout: `blockers-started`,
 * `blocker-completed`, `sentinel-completed`, `timeout`. A generous child-level
 * safety timeout is a HANG GUARD ONLY (never the assertion): it emits `timeout`
 * and exits so a wedged child can never hang CI.
 *
 * Dependency-free (only `node:crypto`, `node:fs`); resolves nothing via cwd.
 */

const crypto = require('node:crypto');
const fs = require('node:fs');

function emit(event) {
  process.stdout.write(`${JSON.stringify(event)}\n`);
}

const blockers = Number.parseInt(process.env.BLOCKERS ?? '', 10);
if (!Number.isFinite(blockers) || blockers <= 0) {
  emit({ ev: 'error', reason: 'BLOCKERS env must be a positive integer' });
  process.exit(1);
}

// Modest per-blocker cost (~100-300ms on a normal machine; ~130ms locally).
// MARGIN: the assertion is completion ORDER, not surviving a time window, so the
// blockers need only outlast the sentinel's submission — kept modest so the
// starved branch (pool 4, 9 blockers -> ~ceil(9/4)=3 drain waves) finishes well
// under a second even on slower CI. Finite, so the process always terminates.
const PBKDF2_ITERATIONS = 700_000;
const PBKDF2_KEYLEN = 64;
const PBKDF2_DIGEST = 'sha512';

// Hang guard ONLY — never the assertion. If something wedges, emit `timeout`
// and exit NON-ZERO so CI never hangs AND the parent catches it via the exit
// code even if this diagnostic stdout line is truncated on exit (F2). Generous
// relative to the ~100-300ms blockers.
const SAFETY_TIMEOUT_MS = 10_000;

let completedBlockers = 0;
let sentinelDone = false;
let finished = false;

const safetyTimer = setTimeout(() => {
  emit({ ev: 'timeout' });
  finished = true;
  process.exit(1);
}, SAFETY_TIMEOUT_MS);
// Do not let the hang-guard timer itself keep the event loop alive once all
// real work is done.
safetyTimer.unref();

function maybeFinish() {
  if (finished) {
    return;
  }
  if (sentinelDone && completedBlockers >= blockers) {
    finished = true;
    // Natural exit (NOT process.exit) — clearing the unref'd hang-guard leaves no
    // pending handles, so the loop drains and the process exits 0 with stdout
    // fully flushed. process.exit() here could truncate the last event line (F4).
    clearTimeout(safetyTimer);
  }
}

// --- Same-tick submission. Submission order is load-bearing (see header). ---

// 1) Submit all blockers FIRST so libuv assigns its free workers to them.
for (let i = 0; i < blockers; i += 1) {
  const index = i;
  crypto.pbkdf2(
    `blocker-${index}`,
    'salt',
    PBKDF2_ITERATIONS,
    PBKDF2_KEYLEN,
    PBKDF2_DIGEST,
    () => {
      completedBlockers += 1;
      emit({ ev: 'blocker-completed', i: index });
      maybeFinish();
    },
  );
}

// 2) THEN submit the single sentinel pool op (a real file that exists).
fs.stat(__filename, () => {
  sentinelDone = true;
  emit({ ev: 'sentinel-completed' });
  maybeFinish();
});

// Emit the start marker after submission, before any completion can be read.
emit({
  ev: 'blockers-started',
  n: blockers,
  pool: process.env.UV_THREADPOOL_SIZE ?? null,
});
