/**
 * Tests for the same-host advisory sync lock (PLAN.md Stage 4).
 *
 * No network, no git. STRICTLY DETERMINISTIC — this suite runs in the
 * pre-push tier (`vitest related` pulls it in whenever the lock module
 * changes), so probabilistic multi-process stress lives in
 * same-host-sync-lock.stress.integration.test.ts instead (round-2 review F2:
 * a committed 10-iteration stress here flaked ~10%/run). Real child
 * processes are used only for the SIGKILL/ESRCH and real-`ps` predicate
 * tests (formalizing the planner's 2026-06-11 spike) and the full-process
 * signal-disposition fixture — all deterministic. Zombie-state detection is
 * unit-tested via injected `ps` output rather than by manufacturing a real
 * zombie: a true zombie needs a SIGSTOPped intermediate parent that vitest
 * must then clean up — flaky under CI load and slow; the predicate's parsing
 * is the load-bearing logic and is covered exactly by injection (documented
 * choice per the stage spec).
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  LOCK_CMD_TOKEN,
  acquireSameHostSyncLock,
  evaluateLockStaleness,
  installLockWaitSignalHandlers,
  isHolderProcessLive,
  normalizeOriginUrl,
  syncLockPathForOrigin,
  type SyncLockInfo,
} from '../same-host-sync-lock';

const ORIGIN = '[external-email]:mindstone-ai/rebel-app.git';

/** Deterministic acquire defaults: zero jitter (random=0.5 ⇒ budget×1.0). */
const fastDeps = { random: () => 0.5 } as const;

function writeLockFile(path: string, info: Partial<SyncLockInfo>): void {
  const full: SyncLockInfo = {
    ownerId: 'test-owner-' + Math.random().toString(36).slice(2),
    pid: 1,
    cmdToken: LOCK_CMD_TOKEN,
    argv: ['--fixture'],
    host: 'testhost',
    acquiredAt: new Date().toISOString(),
    ...info,
  };
  writeFileSync(path, JSON.stringify(full));
}

/** Spawns a long-lived node child; resolves once it has a usable pid. */
function spawnIdleChild(extraArg?: string): Promise<ChildProcess> {
  return new Promise((resolve, reject) => {
    const args = ['-e', 'setInterval(() => {}, 1000)'];
    if (extraArg) args.push(extraArg);
    const child = spawn(process.execPath, args, { stdio: 'ignore' });
    child.once('spawn', () => resolve(child));
    child.once('error', reject);
  });
}

function waitForExit(child: ChildProcess): Promise<void> {
  return new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) return resolve();
    child.once('exit', () => resolve());
  });
}

let lockDir: string;

beforeEach(() => {
  lockDir = mkdtempSync(join(tmpdir(), 'sync-lock-test-'));
  vi.stubEnv('GIT_SAFE_SYNC_LOCK_DIR', lockDir);
});

afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(lockDir, { recursive: true, force: true });
});

describe('normalizeOriginUrl / lock path', () => {
  it('keys trivially-equivalent remote spellings to the same lock file', () => {
    const a = syncLockPathForOrigin('[external-email]:Org/Repo.git');
    const b = syncLockPathForOrigin('[external-email]:org/repo');
    const c = syncLockPathForOrigin('[external-email]:org/other-repo');
    expect(a).toBe(b);
    expect(a).not.toBe(c);
    expect(normalizeOriginUrl('https://github.com/Org/Repo.git/')).toBe(
      'https://github.com/org/repo',
    );
  });
});

describe('acquire/release roundtrip', () => {
  it('acquires uncontended, records our metadata, and releases cleanly', async () => {
    const result = await acquireSameHostSyncLock({
      originUrl: ORIGIN,
      argv: ['--test-run'],
      deps: fastDeps,
    });
    expect(result.acquired).toBe(true);
    if (!result.acquired) return;
    expect(result.note).toContain('uncontended');

    const onDisk = JSON.parse(readFileSync(result.handle.path, 'utf8')) as SyncLockInfo;
    expect(onDisk.ownerId).toBe(result.handle.ownerId);
    expect(onDisk.pid).toBe(process.pid);
    expect(onDisk.cmdToken).toBe(LOCK_CMD_TOKEN);
    expect(onDisk.argv).toEqual(['--test-run']);

    result.handle.release();
    expect(existsSync(result.handle.path)).toBe(false);
    // Idempotent: second release is a no-op, not an error.
    result.handle.release();
  });

  it('release is ownership-checked: never deletes a successor\'s lock', async () => {
    const result = await acquireSameHostSyncLock({ originUrl: ORIGIN, deps: fastDeps });
    expect(result.acquired).toBe(true);
    if (!result.acquired) return;

    // Simulate a stale takeover replacing our lock with a successor's.
    writeLockFile(result.handle.path, { ownerId: 'successor-owner', pid: process.pid });
    result.handle.release();
    const survivor = JSON.parse(readFileSync(result.handle.path, 'utf8')) as SyncLockInfo;
    expect(survivor.ownerId).toBe('successor-owner');
  });
});

describe('contention with a live holder', () => {
  it('second acquire waits and times out while the holder is live', async () => {
    const first = await acquireSameHostSyncLock({ originUrl: ORIGIN, deps: fastDeps });
    expect(first.acquired).toBe(true);
    if (!first.acquired) return;

    // The first holder is THIS vitest process, whose real ps command line
    // does not contain 'git-safe-sync' — inject ps so the holder looks like
    // a genuine live git-safe-sync (the wiring records the real CLI's pid).
    const logs: string[] = [];
    const second = await acquireSameHostSyncLock({
      originUrl: ORIGIN,
      maxWaitMs: 300,
      pollIntervalMs: 25,
      log: (m) => logs.push(m),
      deps: { ...fastDeps, runPs: () => `S    node ${LOCK_CMD_TOKEN} --fixture` },
    });
    expect(second.acquired).toBe(false);
    if (second.acquired) return;
    expect(second.reason).toBe('timeout');
    expect(second.waitedMs).toBeGreaterThanOrEqual(290);
    // Holder info printed: pid, lock path, recovery hint.
    const joined = logs.join('\n');
    expect(joined).toContain(`pid ${process.pid}`);
    expect(joined).toContain(first.handle.path);
    expect(joined).toMatch(/kill \d+ or delete the file \/ use --no-lock/);

    first.handle.release();
    const third = await acquireSameHostSyncLock({ originUrl: ORIGIN, deps: fastDeps });
    expect(third.acquired).toBe(true);
    if (third.acquired) third.handle.release();
  });
});

describe('liveness predicate (real processes — formalizes the planner spike)', () => {
  it('live child whose command contains the token ⇒ live (real ps)', async () => {
    const child = await spawnIdleChild(LOCK_CMD_TOKEN);
    try {
      expect(isHolderProcessLive({ pid: child.pid!, cmdToken: LOCK_CMD_TOKEN })).toBe(true);
    } finally {
      child.kill('SIGKILL');
      await waitForExit(child);
    }
  });

  it('live child WITHOUT the token ⇒ stale (real-ps PID-reuse path)', async () => {
    const child = await spawnIdleChild();
    try {
      expect(isHolderProcessLive({ pid: child.pid!, cmdToken: LOCK_CMD_TOKEN })).toBe(false);
    } finally {
      child.kill('SIGKILL');
      await waitForExit(child);
    }
  });

  it('SIGKILLed (reaped) child ⇒ stale via ESRCH', async () => {
    const child = await spawnIdleChild(LOCK_CMD_TOKEN);
    const pid = child.pid!;
    expect(isHolderProcessLive({ pid, cmdToken: LOCK_CMD_TOKEN })).toBe(true);
    child.kill('SIGKILL');
    await waitForExit(child); // 'exit' fires after Node reaps — pid is now ESRCH
    expect(isHolderProcessLive({ pid, cmdToken: LOCK_CMD_TOKEN })).toBe(false);
  });

  it('zombie stat ⇒ stale (injected ps — see header for why not a real zombie)', () => {
    expect(
      isHolderProcessLive(
        { pid: process.pid, cmdToken: LOCK_CMD_TOKEN },
        { runPs: () => `Z+   (node) <defunct> ${LOCK_CMD_TOKEN}` },
      ),
    ).toBe(false);
  });

  it('PID reuse (live pid, wrong cmdline) ⇒ stale (injected ps)', () => {
    expect(
      isHolderProcessLive(
        { pid: process.pid, cmdToken: LOCK_CMD_TOKEN },
        { runPs: () => 'S    /usr/bin/some-unrelated-daemon --serve' },
      ),
    ).toBe(false);
  });

  it('ps reports pid gone (null) ⇒ stale', () => {
    expect(
      isHolderProcessLive({ pid: process.pid, cmdToken: LOCK_CMD_TOKEN }, { runPs: () => null }),
    ).toBe(false);
  });

  it('nonsense pid ⇒ stale without probing', () => {
    expect(isHolderProcessLive({ pid: -5, cmdToken: LOCK_CMD_TOKEN })).toBe(false);
    expect(isHolderProcessLive({ pid: 1.5, cmdToken: LOCK_CMD_TOKEN })).toBe(false);
  });

  it('win32: skips the ps refinement (kill-probe only)', () => {
    expect(
      isHolderProcessLive(
        { pid: process.pid, cmdToken: LOCK_CMD_TOKEN },
        {
          platform: 'win32',
          runPs: () => {
            throw new Error('must not be called on win32');
          },
        },
      ),
    ).toBe(true);
  });
});

describe('unparseable lock content', () => {
  it('young empty lock ⇒ held (writer may be mid-crash); old ⇒ stale', () => {
    const lockPath = syncLockPathForOrigin(ORIGIN);
    writeFileSync(lockPath, '');
    expect(evaluateLockStaleness(lockPath).verdict).toBe('held');

    // Backdate mtime past the ~10s grace.
    const past = new Date(Date.now() - 60_000);
    utimesSync(lockPath, past, past);
    const verdict = evaluateLockStaleness(lockPath);
    expect(verdict.verdict).toBe('stale');
  });

  it('acquire takes over an old unparseable lock', async () => {
    const lockPath = syncLockPathForOrigin(ORIGIN);
    writeFileSync(lockPath, '{not json');
    const past = new Date(Date.now() - 60_000);
    utimesSync(lockPath, past, past);

    const result = await acquireSameHostSyncLock({
      originUrl: ORIGIN,
      maxWaitMs: 2_000,
      pollIntervalMs: 25,
      log: () => {},
      deps: fastDeps,
    });
    expect(result.acquired).toBe(true);
    if (result.acquired) {
      expect(result.note).toContain('stale takeover');
      result.handle.release();
    }
  });

  it('acquire keeps polling (then times out) on a YOUNG unparseable lock', async () => {
    const lockPath = syncLockPathForOrigin(ORIGIN);
    writeFileSync(lockPath, '');
    const result = await acquireSameHostSyncLock({
      originUrl: ORIGIN,
      maxWaitMs: 200,
      pollIntervalMs: 25,
      log: () => {},
      deps: fastDeps,
    });
    expect(result.acquired).toBe(false);
    if (!result.acquired) expect(result.reason).toBe('timeout');
    expect(existsSync(lockPath)).toBe(true); // never stolen inside the grace window
  });
});

describe('stale takeover', () => {
  it('takes over a dead-pid lock, logs the in-flight-push warning, cleans its sidecar', async () => {
    // A real exited child gives us a guaranteed-ESRCH pid.
    const child = await spawnIdleChild();
    const deadPid = child.pid!;
    child.kill('SIGKILL');
    await waitForExit(child);

    const lockPath = syncLockPathForOrigin(ORIGIN);
    writeLockFile(lockPath, { pid: deadPid });

    const logs: string[] = [];
    const result = await acquireSameHostSyncLock({
      originUrl: ORIGIN,
      maxWaitMs: 2_000,
      pollIntervalMs: 25,
      log: (m) => logs.push(m),
      deps: fastDeps,
    });
    expect(result.acquired).toBe(true);
    const joined = logs.join('\n');
    expect(joined).toContain(`previous holder (pid ${deadPid}) is gone`);
    expect(joined).toContain('git-push child may still be in flight');
    expect(joined).toContain('lost-race exit 40');
    // No sidecar litter.
    expect(readdirSync(lockDir).filter((f) => f.includes('.stale-'))).toEqual([]);
    if (result.acquired) result.handle.release();
  });

  it('takeover TOCTOU (deterministic): a fresh live lock appearing in the evaluate→rename window is restored, not displaced', async () => {
    // Phase-6 native reviewer F1: a waiter judges the path stale, but before
    // its rename another waiter completes takeover and a fresh winner
    // wx-creates a LIVE lock at the same path. The beforeTakeoverRename test
    // seam widens that window deterministically (in-process waiters cannot
    // interleave there otherwise — the evaluate→rename code has no await; the
    // real-interleaving version is the multi-process stress in
    // same-host-sync-lock.stress.integration.test.ts, kept OUT of this
    // pre-push-tier suite because real races are inherently probabilistic).
    const child = await spawnIdleChild();
    const deadPid = child.pid!;
    child.kill('SIGKILL');
    await waitForExit(child);

    const lockPath = syncLockPathForOrigin(ORIGIN);
    writeLockFile(lockPath, { ownerId: 'stale-owner', pid: deadPid });

    let swapped = false;
    const logs: string[] = [];
    const result = await acquireSameHostSyncLock({
      originUrl: ORIGIN,
      maxWaitMs: 400,
      pollIntervalMs: 25,
      log: (m) => logs.push(m),
      deps: {
        ...fastDeps,
        // The "newcomer" is THIS process — live, with the token on its
        // (injected) ps line. The dead pid still resolves stale via the real
        // kill-probe before runPs is consulted.
        runPs: (pid: number) => (pid === process.pid ? `S    node ${LOCK_CMD_TOKEN} newcomer` : null),
        beforeTakeoverRename: () => {
          if (swapped) return;
          swapped = true;
          // Simulate: another waiter completed its takeover and a fresh
          // winner wx-created a live lock — net effect at this path:
          writeLockFile(lockPath, { ownerId: 'newcomer-owner', pid: process.pid });
        },
      },
    });

    // The waiter must NOT displace the newcomer: identity check fails, lock
    // restored, waiter keeps waiting and times out on its short budget.
    expect(result.acquired).toBe(false);
    if (!result.acquired) expect(result.reason).toBe('timeout');
    const survivor = JSON.parse(readFileSync(lockPath, 'utf8')) as SyncLockInfo;
    expect(survivor.ownerId).toBe('newcomer-owner');
    const joined = logs.join('\n');
    expect(joined).toContain('takeover identity check failed');
    expect(joined).toContain('restored it');
    expect(readdirSync(lockDir).filter((f) => f.includes('.stale-'))).toEqual([]);
  });

  it('pre-rename recheck (deterministic): content changing between verdict and rename is caught WITHOUT displacement', async () => {
    // Round-4 reviewer F2: the recheck had no direct coverage, and the
    // integration stress bound mathematically cannot police it (deleting the
    // recheck would still pass the ≤2/40 bound essentially always at observed
    // rates). Pin it without a new seam: the `log` callback for the 'taking
    // over' line fires AFTER the stale verdict and BEFORE the recheck read,
    // so swapping the lock content inside that callback lands exactly in the
    // recheck's window. The waiter must skip the rename entirely — NO
    // identity-check-failed log, NO restore — and just re-evaluate + wait.
    // Mutation reasoning: with the recheck deleted, the swap is instead
    // caught by the post-rename sidecar verification, which logs 'takeover
    // identity check failed' — turning the not-contains assertion red.
    const child = await spawnIdleChild();
    const deadPid = child.pid!;
    child.kill('SIGKILL');
    await waitForExit(child);

    const lockPath = syncLockPathForOrigin(ORIGIN);
    writeLockFile(lockPath, { ownerId: 'stale-owner', pid: deadPid });

    let swapped = false;
    const logs: string[] = [];
    const result = await acquireSameHostSyncLock({
      originUrl: ORIGIN,
      maxWaitMs: 400,
      pollIntervalMs: 25,
      log: (m) => {
        logs.push(m);
        if (!swapped && m.includes('taking over')) {
          swapped = true;
          // Live newcomer lands between the stale verdict and the recheck.
          writeLockFile(lockPath, { ownerId: 'newcomer-owner', pid: process.pid });
        }
      },
      deps: {
        ...fastDeps,
        runPs: (pid: number) => (pid === process.pid ? `S    node ${LOCK_CMD_TOKEN} newcomer` : null),
      },
    });

    expect(result.acquired).toBe(false);
    if (!result.acquired) expect(result.reason).toBe('timeout');
    const survivor = JSON.parse(readFileSync(lockPath, 'utf8')) as SyncLockInfo;
    expect(survivor.ownerId).toBe('newcomer-owner');
    const joined = logs.join('\n');
    // The recheck — not the post-rename backstop — must have handled it:
    expect(joined).not.toContain('takeover identity check failed');
    expect(joined).not.toContain('RESTORE COLLIDED');
    expect(readdirSync(lockDir).filter((f) => f.includes('.stale-'))).toEqual([]);
  });

  it('restore collision (deterministic): a third lock wx-created during the vacancy is NOT clobbered, and the collision is loud', async () => {
    // Round-2 reviewer F1: the restore used rename(2), which silently
    // REPLACES an existing destination — a third waiter's fresh lock,
    // wx-created while the path was briefly vacant, got clobbered and the
    // RESTORE COLLIDED branch was dead code. With the linkSync restore the
    // collision is genuinely detected: the third lock survives and the
    // displaced holder is loudly reported. The beforeRestoreAttempt seam
    // occupies the vacancy deterministically.
    // NOTE: all multi-process stress lives in the .integration.test.ts —
    // this unit suite is in the pre-push tier (vitest related) and must stay
    // strictly deterministic (round-2 F2: committed stress flaked ~10%/run).
    const child = await spawnIdleChild();
    const deadPid = child.pid!;
    child.kill('SIGKILL');
    await waitForExit(child);

    const lockPath = syncLockPathForOrigin(ORIGIN);
    writeLockFile(lockPath, { ownerId: 'stale-owner', pid: deadPid });

    let swapped = false;
    let occupied = false;
    const logs: string[] = [];
    const result = await acquireSameHostSyncLock({
      originUrl: ORIGIN,
      maxWaitMs: 400,
      pollIntervalMs: 25,
      log: (m) => logs.push(m),
      deps: {
        ...fastDeps,
        runPs: (pid: number) => (pid === process.pid ? `S    node ${LOCK_CMD_TOKEN} occupant` : null),
        beforeTakeoverRename: () => {
          if (swapped) return;
          swapped = true;
          // Live newcomer appears in the evaluate→rename window — forces the
          // identity-mismatch (restore) path.
          writeLockFile(lockPath, { ownerId: 'newcomer-owner', pid: process.pid });
        },
        beforeRestoreAttempt: () => {
          if (occupied) return;
          occupied = true;
          // Third waiter's wx lands in the rename→restore vacancy.
          writeLockFile(lockPath, { ownerId: 'third-owner', pid: process.pid });
        },
      },
    });

    expect(result.acquired).toBe(false);
    if (!result.acquired) expect(result.reason).toBe('timeout');
    // The third waiter's lock must SURVIVE (a rename(2) restore silently
    // replaces it with the displaced newcomer's content — mutation-verified).
    const survivor = JSON.parse(readFileSync(lockPath, 'utf8')) as SyncLockInfo;
    expect(survivor.ownerId).toBe('third-owner');
    const joined = logs.join('\n');
    expect(joined).toContain('RESTORE COLLIDED');
    // The collision count surfaces in the result note → the caller's
    // lock-wait span note → the timing log: this is the documented telemetry
    // tripwire for the takeover residual (PREPUSH_GATE_AND_RECEIPTS.md).
    if (!result.acquired) expect(result.note).toContain('1 restore collision(s)');
    expect(readdirSync(lockDir).filter((f) => f.includes('.stale-'))).toEqual([]);
  });
});

describe('scoped lock-wait signal handlers (Phase-6 GPT F1)', () => {
  it('install adds exactly one SIGINT + one SIGTERM listener; uninstall restores the previous set', () => {
    const beforeInt = process.listeners('SIGINT');
    const beforeTerm = process.listeners('SIGTERM');
    const onSignal = vi.fn();
    const uninstall = installLockWaitSignalHandlers(onSignal);

    const addedTerm = process.listeners('SIGTERM').filter((l) => !beforeTerm.includes(l));
    const addedInt = process.listeners('SIGINT').filter((l) => !beforeInt.includes(l));
    expect(addedTerm).toHaveLength(1);
    expect(addedInt).toHaveLength(1);

    // Invoke the registered listeners directly (emitting real signals would
    // also fire vitest's own handlers).
    (addedTerm[0] as () => void)();
    expect(onSignal).toHaveBeenLastCalledWith('SIGTERM', 143);
    (addedInt[0] as () => void)();
    expect(onSignal).toHaveBeenLastCalledWith('SIGINT', 130);

    uninstall();
    expect(process.listeners('SIGTERM')).toEqual(beforeTerm);
    expect(process.listeners('SIGINT')).toEqual(beforeInt);
    uninstall(); // idempotent — must not remove anyone else's handlers
    expect(process.listeners('SIGTERM')).toEqual(beforeTerm);
  });

  it.skipIf(process.platform === 'win32')(
    'after uninstall, SIGTERM during a synchronous child section KILLS the process (default disposition restored)',
    { timeout: 15_000 },
    async () => {
      // Full-process regression for the swallowed-kill bug (GPT F1): a
      // process-lifetime handler cannot run during spawnSync, so SIGTERM is
      // silently dropped (process survives, exits 0). With scoped handlers
      // uninstalled before the synchronous section, the restored default
      // disposition must kill the process on delivery.
      const fixture = join(
        dirname(fileURLToPath(import.meta.url)),
        'fixtures',
        'sync-lock-signal-disposition-fixture.ts',
      );
      const child = spawn(process.execPath, ['--import', 'tsx', fixture], {
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let out = '';
      let killScheduled = false;
      child.stdout.on('data', (d: Buffer) => {
        out += d.toString();
        if (out.includes('READY') && !killScheduled) {
          killScheduled = true;
          // Small delay so the fixture is inside (or entering) spawnSync;
          // default disposition kills on delivery either way.
          setTimeout(() => child.kill('SIGTERM'), 150);
        }
      });
      const { code, signal } = await new Promise<{ code: number | null; signal: string | null }>(
        (r) => child.on('exit', (c, s) => r({ code: c, signal: s })),
      );
      expect(out).toContain('READY');
      expect(out).not.toContain('HANDLER_RAN');
      expect(signal).toBe('SIGTERM'); // died by default disposition — not swallowed (exit 0) or handled (exit 99)
      expect(code).toBeNull();
    },
  );
});

describe('fail-open behavior', () => {
  it('timeout result carries waitedMs and reason', async () => {
    writeLockFile(syncLockPathForOrigin(ORIGIN), { pid: process.pid });
    const result = await acquireSameHostSyncLock({
      originUrl: ORIGIN,
      maxWaitMs: 150,
      pollIntervalMs: 25,
      log: () => {},
      deps: { ...fastDeps, runPs: () => `S    node ${LOCK_CMD_TOKEN}` },
    });
    expect(result.acquired).toBe(false);
    if (result.acquired) return;
    expect(result.reason).toBe('timeout');
    expect(result.waitedMs).toBeGreaterThanOrEqual(140);
    expect(result.note).toContain('proceeding unserialized');
  });

  it('unexpected module error ⇒ acquired:false reason:error (never throws)', async () => {
    // Point the lock dir at a path UNDER A FILE so mkdirSync fails.
    const blocker = join(lockDir, 'blocker');
    writeFileSync(blocker, 'i am a file');
    vi.stubEnv('GIT_SAFE_SYNC_LOCK_DIR', join(blocker, 'nope'));

    const logs: string[] = [];
    const result = await acquireSameHostSyncLock({
      originUrl: ORIGIN,
      log: (m) => logs.push(m),
      deps: fastDeps,
    });
    expect(result.acquired).toBe(false);
    if (result.acquired) return;
    expect(result.reason).toBe('error');
    expect(logs.join('\n')).toContain('proceeding without lock');
  });
});
