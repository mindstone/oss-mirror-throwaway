import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

/**
 * Consolidated dead-mount HANG-REGRESSION (260619_cloud-symlink-indexing, Stage 12).
 *
 * ## What this proves (the highest-value future-catch)
 * The load-bearing invariant of the whole feature: when a cloud mount goes DEAD, the
 * off-thread (separate-OS-process) liveness PROBER stays isolated from a fully
 * SATURATED main libuv threadpool — so the main process never has to issue an
 * unbounded blocking syscall against the dead mount, and a healthy verdict for OTHER
 * spaces (and the turn/DNS path) is still obtainable. This is the regression net for
 * the 0.4.48→0.4.49 hang class that this feature re-opens (admitting healthy cloud
 * spaces means a once-healthy space can go dead): if anyone ever moves the prober
 * back into the main process / a worker_thread, the isolation breaks and this test
 * goes red.
 *
 * ## Why this is the narrower invariant (per the Stage-0 spike)
 * A FULL turn-level test (real Drive going dead → turn still dispatches) is infeasible
 * deterministically. The Stage-0 spike (`subagent_reports/260619_225419_offthread-
 * isolation-spike.md`, Spike 2/3b) settled the mechanism: a `worker_thread` does NOT
 * isolate (shares the process-global libuv pool, un-killable when syscall-blocked); a
 * separate OS PROCESS DOES (its own pool; killable). The production prober is an
 * Electron `utilityProcess.fork` child for exactly this reason. This test asserts that
 * narrower, deterministic invariant: while the main pool is fully parked (a dead-mount
 * stand-in), a forked-process probe still completes — i.e. main-thread work proceeds
 * while a simulated dead-mount probe is parked OFF the main pool.
 *
 * ## Why a child process (mandatory) + ordering not timing
 * Same discipline as `src/core/startup/__tests__/threadpoolSaturation.integration.test.ts`:
 * libuv reads `UV_THREADPOOL_SIZE` exactly ONCE (`uv_once`), so a fresh child is the
 * only way to pin a saturated pool; the env is minimal so the parent's own pool size
 * can't leak in. The assertion is CAUSAL ORDERING — "did the forked-process probe
 * complete BEFORE the parent's own (starved) main-pool sentinel?" — which is exactly
 * "is the prober's pool independent of the saturated main pool?", deterministic
 * regardless of CI CPU speed. Wall clock appears ONLY as a generous hang guard.
 *
 * ## Determinism (no real Drive, no real sleeps)
 * The dead mount is a CPU-bound `pbkdf2` stand-in that parks every main-pool worker
 * for a bounded interval (a real dead FUSE mount can't be created in CI). No real
 * Drive, no `setTimeout`-based sleeps in the assertion path; the only timer is the
 * fixture's hang guard (never the assertion).
 */

const CHILD_PATH = path.join(__dirname, 'fixtures', 'dead-mount-prober-isolation-child.cjs');

interface ChildEvent {
  readonly ev: string;
  readonly n?: number;
  readonly pool?: string | null;
  readonly reason?: string;
}

interface IsolationRun {
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
        // Best-effort cleanup for the integration process.
      }
    }
  }
  liveChildren.clear();
});

/**
 * Spawn the isolation fixture with a controlled (deliberately SATURATED) main pool
 * size + blocker count, collect its line-delimited JSON events in order, and resolve
 * once it exits. Env is sanitized to a minimal set so the parent's own
 * `UV_THREADPOOL_SIZE` / `NODE_OPTIONS` cannot leak in and skew the scenario.
 */
async function runIsolationChild(poolSize: number, blockers: number): Promise<IsolationRun> {
  const child = spawn(process.execPath, [CHILD_PATH], {
    env: {
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
    throw new Error(`Isolation child emitted stderr: ${stderr.trim()}`);
  }

  const events: ChildEvent[] = stdout
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as ChildEvent);

  return { events, exitCode };
}

function indexOfEvent(events: readonly ChildEvent[], ev: string): number {
  return events.findIndex((e) => e.ev === ev);
}

// Saturate the main pool: blockers >= pool size with the pool pinned to the pre-fix
// default 4, so the parent's own main-thread sentinel is genuinely starved (the
// dead-mount condition).
const SATURATED_POOL = 4;
const BLOCKERS = 9; // matches the field diagnostic (9 cloud symlinks)

describe('dead-mount prober isolation (consolidated hang-regression)', () => {
  it('a separate-process probe completes while the main pool is fully saturated (dead-mount stand-in)', async () => {
    const run = await runIsolationChild(SATURATED_POOL, BLOCKERS);

    // Natural completion — no hang guard fired, clean exit.
    expect(run.events.some((e) => e.ev === 'timeout')).toBe(false);
    expect(run.events.some((e) => e.ev === 'child-spawn-failed')).toBe(false);
    expect(run.exitCode).toBe(0);

    const childProbeIdx = indexOfEvent(run.events, 'child-probe-completed');
    const parentSentinelIdx = indexOfEvent(run.events, 'parent-sentinel-completed');
    expect(childProbeIdx).toBeGreaterThanOrEqual(0);
    expect(parentSentinelIdx).toBeGreaterThanOrEqual(0);

    // THE INVARIANT: with the main pool saturated (4 workers, 9 blockers), the parent's
    // OWN main-thread sentinel cannot run until a blocker frees a worker — yet the
    // forked-process probe (its own libuv pool) completes FIRST. That ordering is only
    // possible because the prober's pool is independent of the saturated main pool: a
    // dead mount parking the main pool does NOT starve the off-thread probe. If the
    // prober ever moves back on-thread / into a worker_thread, this ordering inverts.
    expect(childProbeIdx).toBeLessThan(parentSentinelIdx);
  });
});
