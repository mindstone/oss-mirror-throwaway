import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { computeThreadpoolSize, THREADPOOL_SIZE_FLOOR } from '../threadpoolSize';

/**
 * libuv-pool-saturation regression test (turn-hang Pathologist #1).
 *
 * ## What this proves
 * That a saturated libuv threadpool (default 4) actually STARVES a turn-critical
 * pool op, and that the production-computed buffer (>= FLOOR) RELIEVES it. This
 * is the mechanism-level net for the turn-hang bug: a dead cloud-storage mount's
 * blocking `stat`/`readdir`/`realpath` syscalls park every pool worker, so the
 * turn's own pre-dispatch fs/DNS work queues forever and the turn never reaches
 * the model. The buffer raises the worker count so a realistic cloud-symlink count
 * no longer wedges the turn path. See
 * `src/core/startup/threadpoolSize.ts` (the buffer) and the postmortem at
 * `docs-private/postmortems/260619_turn_pre_dispatch_hang_libuv_pool_exhaustion_postmortem.md`.
 *
 * ## Why a child process (mandatory)
 * libuv reads `UV_THREADPOOL_SIZE` exactly ONCE, at the first async threadpool op
 * (`uv_once`). The vitest process has already touched the pool, so the size cannot
 * be varied in-process — a fresh child is the only way to exercise different pool
 * sizes. The child env is deliberately minimal (no inherited `NODE_OPTIONS` /
 * `UV_THREADPOOL_SIZE`) so only the scenario's value takes effect.
 *
 * ## Why ordering, not timing
 * A pool op can only START when a worker is free. So "does `sentinel-completed`
 * arrive before the FIRST `blocker-completed`?" is exactly "was there a free
 * worker when the sentinel was submitted?" — i.e. is the buffer in force. This is
 * deterministic regardless of CI CPU/IO speed (no wall-clock window). Wall clock
 * appears ONLY as a generous child-level hang guard, never as the assertion.
 *
 * ## Tied to the production FLOOR (not the per-machine scaled value)
 * The buffered branch drives the child with `computeThreadpoolSize(1)` — which
 * collapses to `THREADPOOL_SIZE_FLOOR` on every machine (1*2=2 < FLOOR) — plus a
 * static `THREADPOOL_SIZE_FLOOR > BLOCKERS` guard, NOT a hardcoded size and NOT the
 * per-machine `computeThreadpoolSize(os.availableParallelism())` (which is at least the floor on
 * any multi-core box and would MASK a lowered floor). So lowering
 * `THREADPOOL_SIZE_FLOOR` below the blocker count (a tempting "simplification")
 * breaks this test on every machine, not just a 1-core one — the FLOOR, not CPU
 * count, is the load-bearing guarantee (a dead mount parks the same number of
 * syscalls regardless of cores). The end-to-end apply->protect chain is complete
 * without importing TS into the child: `applyThreadpoolSize.test.ts` already
 * proves `applyThreadpoolSizeAtBoot()` mutates `process.env.UV_THREADPOOL_SIZE` to
 * the computed buffer; this test proves a pool of that floor size protects the
 * turn op.
 *
 * ## Scope note
 * The full pre-dispatch-guard behaviour (guard emits a retryable terminal, latch
 * release, late-continuation suppression, no model call, stale cleanup) is covered
 * separately by `src/main/services/__tests__/agentTurnExecutor.preDispatchLivenessGuard.test.ts`,
 * so it is intentionally NOT rebuilt here. This test is purely the
 * mechanism + buffer proof.
 */

const CHILD_PATH = path.join(__dirname, 'fixtures', 'threadpool-saturation-child.cjs');

interface ChildEvent {
  readonly ev: string;
  readonly i?: number;
  readonly n?: number;
  readonly pool?: string | null;
  readonly reason?: string;
}

interface SaturationRun {
  readonly events: readonly ChildEvent[];
  readonly exitCode: number | null;
}

const liveChildren = new Set<ChildProcess>();

afterAll(() => {
  for (const child of liveChildren) {
    if (!child.killed) {
      try {
        child.kill();
      } catch {
        // Best-effort cleanup for integration process.
      }
    }
  }
  liveChildren.clear();
});

/**
 * Spawn the saturation child with a controlled pool size + blocker count, collect
 * its line-delimited JSON events in order, and resolve once it exits. Env is
 * sanitized to a minimal set so the parent's own `UV_THREADPOOL_SIZE` /
 * `NODE_OPTIONS` cannot leak in and skew the scenario.
 */
async function runSaturationChild(poolSize: number, blockers: number): Promise<SaturationRun> {
  const child = spawn(process.execPath, [CHILD_PATH], {
    env: {
      // Minimal, deliberately NOT `...process.env` — so a stray `NODE_OPTIONS` or
      // `UV_THREADPOOL_SIZE` in the parent can't leak in and skew the scenario.
      // We DO preserve Windows essentials (SystemRoot/WINDIR/ComSpec): a
      // near-empty env is a known Windows footgun (Node/crypto DLL loading needs
      // them). PATH lets node-level tooling resolve (F3, GPT stage review).
      ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
      ...(process.env.WINDIR ? { WINDIR: process.env.WINDIR } : {}),
      ...(process.env.ComSpec ? { ComSpec: process.env.ComSpec } : {}),
      PATH: process.env.PATH ?? '',
      UV_THREADPOOL_SIZE: String(poolSize),
      BLOCKERS: String(blockers),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  liveChildren.add(child);

  let stdout = '';
  let stderr = '';
  child.stdout?.on('data', (chunk: Buffer) => {
    stdout += chunk.toString('utf8');
  });
  child.stderr?.on('data', (chunk: Buffer) => {
    stderr += chunk.toString('utf8');
  });

  const exitCode = await new Promise<number | null>((resolve, reject) => {
    child.on('error', reject);
    child.on('close', (code) => resolve(code));
  });
  liveChildren.delete(child);

  if (stderr.trim().length > 0) {
    throw new Error(`Saturation child emitted stderr: ${stderr.trim()}`);
  }

  const events: ChildEvent[] = stdout
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as ChildEvent);

  return { events, exitCode };
}

/** Index of the first `blocker-completed` event, or -1 if none. */
function firstBlockerCompletedIndex(events: readonly ChildEvent[]): number {
  return events.findIndex((event) => event.ev === 'blocker-completed');
}

/** Index of the `sentinel-completed` event, or -1 if none. */
function sentinelCompletedIndex(events: readonly ChildEvent[]): number {
  return events.findIndex((event) => event.ev === 'sentinel-completed');
}

/**
 * Assert the child ran to NATURAL completion — every blocker + the sentinel
 * actually finished, exit 0, and the hang guard never fired. This is the
 * defence against a false green from a truncated/partial run or a fired
 * timeout (the hang guard exits NON-zero, so `exitCode === 0` also catches it
 * even if the `timeout` stdout line was truncated on exit).
 */
function assertNaturalCompletion(run: SaturationRun, expectedBlockers: number): void {
  const blockerCompletions = run.events.filter((e) => e.ev === 'blocker-completed').length;
  const sentinelCompletions = run.events.filter((e) => e.ev === 'sentinel-completed').length;
  expect(run.events.some((e) => e.ev === 'timeout')).toBe(false);
  expect(run.exitCode).toBe(0);
  expect(blockerCompletions).toBe(expectedBlockers);
  expect(sentinelCompletions).toBe(1);
}

const BLOCKERS = 9; // matches the field diagnostic (9 cloud symlinks)

describe('libuv threadpool saturation (mechanism + buffer)', () => {
  it('the FLOOR-sized pool lets the sentinel run before any blocker completes', async () => {
    // F1 (GPT stage review): pin the buffered branch to the FLOOR, not the
    // per-machine scaled value. `computeThreadpoolSize(os.availableParallelism())` is at least the floor on
    // any multi-core CI box, so it would stay green even if THREADPOOL_SIZE_FLOOR
    // were lowered to 4/8 — masking exactly the regression this test must catch.
    // `computeThreadpoolSize(1)` collapses to the FLOOR on every machine (1*2=2 <
    // FLOOR), so it exercises the FLOOR path by construction: lower the FLOOR below
    // BLOCKERS and this branch starves → the test fails everywhere, not just on a
    // 1-core runner. The FLOOR (not CPU count) is the load-bearing guarantee — a
    // dead mount parks the same number of syscalls regardless of cores.
    const flooredSize = computeThreadpoolSize(1);
    // Static guard: the FLOOR must exceed a realistic parked-symlink count. Fails
    // fast with a clear message if someone erodes the constant.
    expect(THREADPOOL_SIZE_FLOOR).toBeGreaterThan(BLOCKERS);
    expect(flooredSize).toBe(THREADPOOL_SIZE_FLOOR);
    // Sanity: this machine's real production value is also at least the floor.
    expect(computeThreadpoolSize(os.availableParallelism())).toBeGreaterThanOrEqual(
      THREADPOOL_SIZE_FLOOR,
    );

    const run = await runSaturationChild(flooredSize, BLOCKERS);
    assertNaturalCompletion(run, BLOCKERS);

    const sentinelIdx = sentinelCompletedIndex(run.events);
    const firstBlockerIdx = firstBlockerCompletedIndex(run.events);
    expect(sentinelIdx).toBeGreaterThanOrEqual(0);
    expect(firstBlockerIdx).toBeGreaterThanOrEqual(0);

    // A free worker existed -> the sentinel ran immediately -> it completed BEFORE
    // any blocker. This is the buffer's protective property.
    expect(sentinelIdx).toBeLessThan(firstBlockerIdx);
  });

  it('starved pool (pre-fix default 4) makes the sentinel wait behind a blocker', async () => {
    // Pre-fix libuv default. Blockers are held at 9 (SAME as the buffered branch —
    // matching the field diagnostic of 9 cloud symlinks) so the ONLY variable
    // between the two branches is the pool size: this isolates "the FLOOR is what
    // saves the turn" as the single cause. With pool 4 and 9 blockers, no free
    // worker remains AND the sentinel is queued behind the 5 extra blockers, so it
    // completes well after the first blocker — exactly the condition that wedged
    // the turn path. This negative control proves the test would have CAUGHT the
    // bug on the unbuffered code.
    const starvedSize = 4;

    const run = await runSaturationChild(starvedSize, BLOCKERS);
    assertNaturalCompletion(run, BLOCKERS);

    const sentinelIdx = sentinelCompletedIndex(run.events);
    const firstBlockerIdx = firstBlockerCompletedIndex(run.events);
    expect(sentinelIdx).toBeGreaterThanOrEqual(0);
    expect(firstBlockerIdx).toBeGreaterThanOrEqual(0);

    // No free worker -> the sentinel starved -> at least one blocker completed
    // first (freeing the worker the sentinel then used).
    expect(sentinelIdx).toBeGreaterThan(firstBlockerIdx);
  });
});
