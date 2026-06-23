/**
 * Multi-process stress harness for the same-host sync lock's stale-takeover
 * path (Phase-6 native reviewer F1: takeover TOCTOU). Each iteration: one
 * fabricated stale lock (real dead PID), three REAL waiter child processes
 * (real kill-probe, real ps, real filesystem races), short holds, tight poll.
 * A correctness violation = two waiters' hold intervals overlap.
 *
 * Shared by the 10-iteration unit test and the 30-iteration
 * .integration.test.ts (fast tier excludes integration; full `npm test` runs
 * both). Pre-fix baseline: the reviewer reproduced a 603ms double-hold in
 * 1/15 iterations of an equivalent harness.
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LOCK_CMD_TOKEN, syncLockPathForOrigin } from '../../same-host-sync-lock';

const HERE = dirname(fileURLToPath(import.meta.url));
const WAITER_FIXTURE = join(HERE, '..', 'fixtures', 'sync-lock-stress-waiter-git-safe-sync.ts');

interface WaiterEvent {
  t: number;
  pid: number;
  event: 'acquired' | 'released' | 'not-acquired';
  ownerId?: string;
}

export interface StressIterationResult {
  overlaps: number;
  /** Overlaps with NO `RESTORE COLLIDED` line in any waiter's stderr — the
   * silent double-hold class the linkSync restore kills by construction. */
  silentOverlaps: number;
  /** Count of loud `RESTORE COLLIDED` lines across waiters (the documented
   * bounded residual — someone runs unserialized but it is observable). */
  collisions: number;
  wins: number;
  staleSidecars: number;
  detail: string[];
}

export interface StressSummary {
  iterations: number;
  overlaps: number;
  silentOverlaps: number;
  collisions: number;
  totalWins: number;
  staleSidecars: number;
  details: string[];
}

async function makeDeadPid(): Promise<number> {
  const c = spawn(process.execPath, ['-e', 'process.exit(0)'], { stdio: 'ignore' });
  const pid = c.pid;
  await new Promise<void>((r) => c.on('exit', () => r()));
  if (pid === undefined) throw new Error('could not spawn dead-pid child');
  return pid;
}

async function runIteration(iter: number, waiters: number): Promise<StressIterationResult> {
  const lockDir = mkdtempSync(join(tmpdir(), `sync-lock-stress-${iter}-`));
  const env = { ...process.env, GIT_SAFE_SYNC_LOCK_DIR: lockDir };
  const origin = `git@example.com:sync-lock-stress/iter-${iter}.git`;

  // Compute the lock path under the scratch dir. Synchronous set/restore of
  // the env var is safe even with concurrent iterations (single-threaded JS,
  // no await between set and restore).
  const prevEnv = process.env.GIT_SAFE_SYNC_LOCK_DIR;
  process.env.GIT_SAFE_SYNC_LOCK_DIR = lockDir;
  const lockPath = syncLockPathForOrigin(origin);
  if (prevEnv === undefined) delete process.env.GIT_SAFE_SYNC_LOCK_DIR;
  else process.env.GIT_SAFE_SYNC_LOCK_DIR = prevEnv;

  writeFileSync(
    lockPath,
    JSON.stringify({
      ownerId: 'stale-fixture',
      pid: await makeDeadPid(),
      cmdToken: LOCK_CMD_TOKEN,
      argv: [],
      host: 'stress',
      acquiredAt: new Date().toISOString(),
    }),
  );

  const outs: string[] = [];
  const errs: string[] = [];
  const procs = Array.from({ length: waiters }, (_, i) => {
    outs.push('');
    errs.push('');
    // stderr is PIPED, not ignored: round-2 review showed /dev/null stderr
    // makes the lock module's pipe-write log calls near-free and artificially
    // NARROWS the takeover race windows vs production (where log lines go to
    // a real pipe/tty). Piping keeps the stress production-like and lets the
    // harness see the loud `RESTORE COLLIDED` evidence.
    const w = spawn(
      process.execPath,
      ['--import', 'tsx', WAITER_FIXTURE, origin, '6000', '100', '25'],
      { env, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    w.stdout.on('data', (d: Buffer) => {
      outs[i] += d.toString();
    });
    w.stderr.on('data', (d: Buffer) => {
      errs[i] += d.toString();
    });
    return w;
  });
  await Promise.all(procs.map((w) => new Promise<void>((r) => w.on('exit', () => r()))));

  const events: WaiterEvent[] = outs
    .flatMap((o) => o.split('\n'))
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l) as WaiterEvent);

  const holds: Array<{ pid: number; from: number; to: number }> = [];
  for (const pid of new Set(events.map((e) => e.pid))) {
    const acq = events.find((e) => e.pid === pid && e.event === 'acquired');
    if (!acq) continue;
    const rel = events.find((e) => e.pid === pid && e.event === 'released');
    holds.push({ pid, from: acq.t, to: rel ? rel.t : acq.t + 100 });
  }

  const detail: string[] = [];
  let overlaps = 0;
  const allStderr = errs.join('\n');
  const collisions = allStderr.split('\n').filter((l) => l.includes('RESTORE COLLIDED')).length;
  const sorted = [...holds].sort((a, b) => a.from - b.from);
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i].from < sorted[i - 1].to - 1) {
      // 1ms clock slack
      overlaps += 1;
      detail.push(
        `iter ${iter}: OVERLAP pid ${sorted[i - 1].pid} [${sorted[i - 1].from}-${sorted[i - 1].to}] vs ` +
          `pid ${sorted[i].pid} acquired ${sorted[i].from} (${sorted[i - 1].to - sorted[i].from}ms double-hold; ` +
          `${collisions > 0 ? `LOUD: ${collisions} RESTORE COLLIDED line(s)` : 'SILENT: no RESTORE COLLIDED line — clobber-class bug'})\n` +
          errs.map((e, w) => `  -- waiter ${w} stderr --\n${e.trim()}`).join('\n'),
      );
    }
  }
  const silentOverlaps = collisions > 0 ? 0 : overlaps;
  const staleSidecars = readdirSync(lockDir).filter((f) => f.includes('.stale-')).length;
  rmSync(lockDir, { recursive: true, force: true });
  return { overlaps, silentOverlaps, collisions, wins: holds.length, staleSidecars, detail };
}

/** Runs `iterations` stress iterations with bounded concurrency. */
export async function runSyncLockStress(
  iterations: number,
  opts: { waiters?: number; concurrency?: number } = {},
): Promise<StressSummary> {
  const waiters = opts.waiters ?? 3;
  const concurrency = opts.concurrency ?? 3;
  const summary: StressSummary = {
    iterations,
    overlaps: 0,
    silentOverlaps: 0,
    collisions: 0,
    totalWins: 0,
    staleSidecars: 0,
    details: [],
  };
  let next = 0;
  const workers = Array.from({ length: Math.min(concurrency, iterations) }, async () => {
    while (next < iterations) {
      const iter = next++;
      const r = await runIteration(iter, waiters);
      summary.overlaps += r.overlaps;
      summary.silentOverlaps += r.silentOverlaps;
      summary.collisions += r.collisions;
      summary.totalWins += r.wins;
      summary.staleSidecars += r.staleSidecars;
      summary.details.push(...r.detail);
    }
  });
  await Promise.all(workers);
  return summary;
}
