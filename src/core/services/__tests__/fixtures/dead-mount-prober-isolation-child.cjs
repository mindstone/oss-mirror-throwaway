'use strict';

/**
 * Dead-mount prober-isolation probe child (fixture for
 * `../cloudLivenessProbe.deadMountIsolation.integration.test.ts`, Stage 12).
 *
 * ## What this proves
 * The load-bearing invariant of the whole cloud-symlink-indexing feature: when a
 * cloud mount goes dead, the off-thread (separate-OS-process) liveness PROBER stays
 * isolated from a fully-saturated MAIN libuv threadpool, so a healthy verdict is
 * still obtainable and the main process never has to issue an unbounded blocking
 * syscall against the dead mount. This is the consolidated dead-mount
 * hang-regression: it is the narrower invariant the Stage-0 spike proved (Spike 2/3b
 * — "a separate process is isolated and the parent stays responsive while a wedged
 * child is killed"), expressed as a deterministic CI regression test.
 *
 * ## Why this models the production prober
 * The production prober is an Electron `utilityProcess.fork` child (a separate OS
 * process → its OWN libuv threadpool) with the per-probe timeout + kill-and-respawn
 * living in the PARENT. The spike disproved `worker_thread` isolation (workers SHARE
 * the process-global pool and are un-killable when syscall-blocked). This fixture
 * reproduces the essential shape with a plain `child_process.fork`: the parent (this
 * file) saturates ITS OWN main pool with blockers (the dead-mount stand-in), then
 * forks a child to run the "probe" — and the child's pool op completes regardless,
 * because it lives in a different process with a different pool.
 *
 * ## Why ordering, not timing (CPU-speed-independent)
 * Same discipline as `threadpoolSaturation.integration.test.ts`: the assertion is
 * causal ordering ("did the forked child's probe complete while the parent's own
 * pool sentinel was still starved?"), never a wall-clock window. The parent parks
 * its pool with `BLOCKERS` `crypto.pbkdf2` ops + submits one main-thread `fs.stat`
 * sentinel that CANNOT run until a blocker frees a worker. It then forks a child that
 * does a pool op (`fs.stat` of a real file). If process isolation holds, the child's
 * probe completes BEFORE the parent's sentinel (the parent pool is still parked) —
 * proving the prober is not gated on the saturated main pool. Wall clock appears only
 * as a generous hang guard, never as the assertion.
 *
 * ## The dead-mount stand-in
 * A genuinely dead FUSE mount can't be created in CI. The faithful proxy (Stage-0
 * spike) is a parked libuv worker that never returns WITHOUT burning CPU; `pbkdf2`
 * burns CPU but is the only portable, dependency-free way to deterministically
 * occupy every pool worker for a bounded interval, and it is sufficient here because
 * the claim is purely "the child's pool is a DIFFERENT pool" — which holds whether
 * the main pool is parked by a blocking syscall or by a CPU-bound op. (The spike used
 * a blocking-FIFO proxy to ALSO prove killability of a wedged child; that is the
 * separate `runWithTimeout`/kill concern, unit-tested elsewhere — here we isolate the
 * pool-independence invariant.)
 *
 * Events are line-delimited JSON on stdout: `parent-blockers-started`,
 * `parent-sentinel-completed`, `child-probe-completed`, `child-spawn-failed`,
 * `timeout`. Dependency-free (`node:crypto`, `node:fs`, `node:child_process`,
 * `node:path`).
 */

const crypto = require('node:crypto');
const fs = require('node:fs');
const childProcess = require('node:child_process');

function emit(event) {
  process.stdout.write(`${JSON.stringify(event)}\n`);
}

const blockers = Number.parseInt(process.env.BLOCKERS ?? '', 10);
if (!Number.isFinite(blockers) || blockers <= 0) {
  emit({ ev: 'error', reason: 'BLOCKERS env must be a positive integer' });
  process.exit(1);
}

// Modest per-blocker cost (~100-300ms on a normal machine). The assertion is
// completion ORDER, not surviving a window, so the blockers need only outlast the
// fork+probe round-trip; finite so the process always terminates.
const PBKDF2_ITERATIONS = 700_000;
const PBKDF2_KEYLEN = 64;
const PBKDF2_DIGEST = 'sha512';

const SAFETY_TIMEOUT_MS = 15_000;

let completedBlockers = 0;
let sentinelDone = false;
let childProbeDone = false;
let finished = false;

const safetyTimer = setTimeout(() => {
  emit({ ev: 'timeout' });
  finished = true;
  process.exit(1);
}, SAFETY_TIMEOUT_MS);
safetyTimer.unref();

function maybeFinish() {
  if (finished) return;
  // Done once every blocker drained AND both the parent sentinel and the child
  // probe reported. Natural exit (clear the unref'd guard) so stdout flushes.
  if (sentinelDone && childProbeDone && completedBlockers >= blockers) {
    finished = true;
    clearTimeout(safetyTimer);
  }
}

// --- 1) Park the PARENT main pool with blockers (the dead-mount stand-in). ---
for (let i = 0; i < blockers; i += 1) {
  const index = i;
  crypto.pbkdf2(`blocker-${index}`, 'salt', PBKDF2_ITERATIONS, PBKDF2_KEYLEN, PBKDF2_DIGEST, () => {
    completedBlockers += 1;
    maybeFinish();
  });
}

// --- 2) Submit one main-thread sentinel pool op (starved behind the blockers). ---
fs.stat(__filename, () => {
  sentinelDone = true;
  emit({ ev: 'parent-sentinel-completed' });
  maybeFinish();
});

// --- 3) Fork a SEPARATE PROCESS to run the "probe" (its own libuv pool). ---
// The grandchild does a single pool op (fs.stat of a real file) and reports back.
// Inlined as `-e` so the fixture stays a single dependency-free file.
const probeSource = [
  'const fs = require("node:fs");',
  'fs.stat(process.argv[1], () => {',
  '  process.stdout.write("PROBE_OK\\n");',
  '  process.exit(0);',
  '});',
].join('\n');

const probeChild = childProcess.spawn(
  process.execPath,
  ['-e', probeSource, __filename],
  {
    // Minimal env (Windows essentials preserved). The child's pool size is
    // irrelevant to the claim — even a default-4 pool in a DIFFERENT process is
    // independent of the parent's parked pool.
    env: {
      ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
      ...(process.env.WINDIR ? { WINDIR: process.env.WINDIR } : {}),
      ...(process.env.ComSpec ? { ComSpec: process.env.ComSpec } : {}),
      PATH: process.env.PATH ?? '',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  },
);

let probeStdout = '';
probeChild.stdout.on('data', (chunk) => {
  probeStdout += chunk.toString('utf8');
});
probeChild.on('error', (err) => {
  emit({ ev: 'child-spawn-failed', reason: String(err && err.message ? err.message : err) });
  finished = true;
  clearTimeout(safetyTimer);
  process.exit(1);
});
probeChild.on('close', () => {
  if (probeStdout.includes('PROBE_OK')) {
    childProbeDone = true;
    emit({ ev: 'child-probe-completed' });
    maybeFinish();
  } else {
    emit({ ev: 'child-spawn-failed', reason: 'probe child did not report PROBE_OK' });
    finished = true;
    clearTimeout(safetyTimer);
    process.exit(1);
  }
});

emit({
  ev: 'parent-blockers-started',
  n: blockers,
  pool: process.env.UV_THREADPOOL_SIZE ?? null,
});
