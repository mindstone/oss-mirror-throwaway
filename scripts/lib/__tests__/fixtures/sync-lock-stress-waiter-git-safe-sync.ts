/**
 * Stress-test worker for same-host-sync-lock: tries to acquire the real lock
 * (real kill-probe, real `ps` — no injection), emits timestamped JSON events
 * on stdout, holds briefly, releases.
 *
 * The FILENAME contains 'git-safe-sync' deliberately: it appears in this
 * process's ps command line, so a winning waiter is seen as a LIVE holder by
 * losing waiters via the real liveness predicate (mirrors how the production
 * CLI carries the token via its script path).
 *
 * argv: <originUrl> <maxWaitMs> <holdMs> <pollIntervalMs>
 * Adapted from the Phase-6 reviewer's TOCTOU reproducer (originally a gitignored
 * scratch script; provenance: the Stage-4 reviewer reports under
 * docs/plans/260611_prepush-gate-speedup/subagent_reports/).
 */
import { acquireSameHostSyncLock } from '../../same-host-sync-lock';

async function main(): Promise<void> {
  const [origin, maxWaitStr, holdStr, pollStr] = process.argv.slice(2);
  const emit = (obj: Record<string, unknown>): void => {
    process.stdout.write(`${JSON.stringify({ t: Date.now(), pid: process.pid, ...obj })}\n`);
  };

  const res = await acquireSameHostSyncLock({
    originUrl: origin,
    maxWaitMs: Number(maxWaitStr ?? 5000),
    pollIntervalMs: Number(pollStr ?? 25),
    log: (m) => process.stderr.write(`[waiter ${process.pid}] ${m}\n`),
  });

  if (res.acquired) {
    emit({ event: 'acquired', ownerId: res.handle.ownerId, waitedMs: res.waitedMs, note: res.note });
    await new Promise((r) => setTimeout(r, Number(holdStr ?? 0)));
    res.handle.release();
    emit({ event: 'released', ownerId: res.handle.ownerId });
  } else {
    emit({ event: 'not-acquired', reason: res.reason, waitedMs: res.waitedMs });
  }
  process.exit(0);
}

main().catch((e) => {
  process.stderr.write(`${String(e)}\n`);
  process.exit(1);
});
