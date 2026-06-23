/**
 * cloudLivenessProbeService — PARENT lifecycle tests (Stage 2,
 * 260619_cloud-symlink-indexing).
 *
 * Tests the parent's timeout + kill + respawn + RS-F4 pending-drain logic
 * against a CONTROLLABLE mock child (utilityProcess.fork is mocked). No real
 * Drive, no real child process — the mock worker can reply healthy/unhealthy,
 * deliberately NOT reply (to exercise the parent timeout), or emit `exit`
 * (crash) mid-probe.
 *
 * Coverage:
 *  (a) healthy reply → 'healthy';
 *  (b) no-reply-within-timeout → child killed + 'degraded' + respawn-next-probe;
 *  (c) child crash/exit mid-probe → pending drain resolves 'degraded' (RS-F4);
 *  (d) backoff prevents a respawn storm (no respawn while cooling down);
 *  (e) missing worker path → fail-closed (degraded, never blocks, no spawn).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { PassThrough } from 'node:stream';
import type { ReadlinkResolvedTarget } from '@core/services/cloudLivenessProbe';

// ── Mock logger (hoisted so the vi.mock factory can reference it safely) ─────
const mockLogger = vi.hoisted(() => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
  trace: vi.fn(),
}));
vi.mock('@core/logger', () => ({
  createScopedLogger: () => mockLogger,
  logger: mockLogger,
}));

// ── Mock platform (dev, non-packaged) ──────────────────────────────────────
vi.mock('@core/platform', () => ({
  getPlatformConfig: vi.fn(() => ({
    isPackaged: false,
    appPath: '/mock/app/path',
    userDataPath: '/mock/userData',
  })),
}));

// ── Controllable mock worker ───────────────────────────────────────────────
interface MockWorker {
  stdout: PassThrough;
  stderr: PassThrough;
  on: ReturnType<typeof vi.fn>;
  postMessage: ReturnType<typeof vi.fn>;
  kill: ReturnType<typeof vi.fn>;
  /** Last `{ id, target, probeReaddir }` the parent posted. */
  lastMessage: { id: string; target: string; probeReaddir?: boolean } | null;
  /** Whether kill() was called. */
  killed: boolean;
  /** Simulate the child replying for a given id. */
  reply: (id: string, healthy: boolean) => void;
  /** Simulate the child exiting (crash or our kill). */
  emitExit: (code: number | null) => void;
}

let mockWorkers: MockWorker[] = [];
let autoReplyHealthy: boolean | null = true; // null = do NOT auto-reply (hang)

function createMockWorker(): MockWorker {
  const handlers = new Map<string, (arg: unknown) => void>();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const worker: MockWorker = {
    stdout,
    stderr,
    on: vi.fn((event: string, handler: (arg: unknown) => void) => {
      handlers.set(event, handler);
    }),
    postMessage: vi.fn((msg: { id: string; target: string; probeReaddir?: boolean }) => {
      worker.lastMessage = msg;
      if (autoReplyHealthy !== null) {
        // Reply on next microtask so the parent's pending map is populated first.
        queueMicrotask(() => worker.reply(msg.id, autoReplyHealthy as boolean));
      }
      // autoReplyHealthy === null → no reply (parent timeout fires).
    }),
    kill: vi.fn(() => {
      worker.killed = true;
      // Real utilityProcess emits 'exit' after kill(); simulate that so the
      // parent's exit handler runs (drains pending + arms cooldown).
      queueMicrotask(() => worker.emitExit(null));
    }),
    lastMessage: null,
    killed: false,
    reply: (id: string, healthy: boolean) => {
      handlers.get('message')?.({ id, healthy });
    },
    emitExit: (code: number | null) => {
      handlers.get('exit')?.(code);
    },
  };
  return worker;
}

// ── Mock electron utilityProcess (hoisted: vi.mock factory references it) ────
const forkMock = vi.hoisted(() => vi.fn());
const mockElectronModule = vi.hoisted(() => ({
  utilityProcess: { fork: vi.fn() },
}));
vi.mock('@core/lazyElectron', () => ({
  getElectronModule: () => mockElectronModule,
  onElectronAppEvent: vi.fn(),
}));

// ── Mock fs.existsSync for worker-path resolution ──────────────────────────
let workerFileExists = true;
vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
  return {
    ...actual,
    default: { ...actual, existsSync: vi.fn(() => workerFileExists) },
    existsSync: vi.fn(() => workerFileExists),
  };
});

// Import AFTER mocks.
import { CloudLivenessProbeService } from '../cloudLivenessProbeService';

const TARGET = '/mock/Library/CloudStorage/GoogleDrive-x/General' as ReadlinkResolvedTarget;
const TARGET_2 = '/mock/Library/CloudStorage/GoogleDrive-x/Exec' as ReadlinkResolvedTarget;

let service: CloudLivenessProbeService;

beforeEach(() => {
  vi.clearAllMocks();
  mockWorkers = [];
  autoReplyHealthy = true;
  workerFileExists = true;
  // Wire the hoisted fork mock to produce controllable mock workers. Set here
  // (not in the hoisted block) because createMockWorker is defined later.
  forkMock.mockImplementation(() => {
    const w = createMockWorker();
    mockWorkers.push(w);
    return w;
  });
  mockElectronModule.utilityProcess.fork = forkMock;
});

afterEach(() => {
  service?.dispose();
});

describe('cloudLivenessProbeService — parent lifecycle', () => {
  it('(a) healthy reply → "healthy" + caches verdict', async () => {
    service = new CloudLivenessProbeService();
    autoReplyHealthy = true;

    const verdict = await service.probeHealth(TARGET);
    expect(verdict).toBe('healthy');
    expect(forkMock).toHaveBeenCalledTimes(1);
    // Sync cache read returns the same verdict (no I/O).
    expect(service.getCachedVerdict(TARGET)).toBe('healthy');
  });

  it('unhealthy reply (child threw on dead target) → "degraded"', async () => {
    service = new CloudLivenessProbeService();
    autoReplyHealthy = false;

    const verdict = await service.probeHealth(TARGET);
    expect(verdict).toBe('degraded');
    expect(service.getCachedVerdict(TARGET)).toBe('degraded');
  });

  it('reuses the same persistent worker across probes', async () => {
    service = new CloudLivenessProbeService();
    autoReplyHealthy = true;

    await service.probeHealth(TARGET);
    await service.probeHealth(TARGET_2);
    expect(forkMock).toHaveBeenCalledTimes(1); // single long-lived child
  });

  it('(b) no reply within timeout → child SIGKILLed + "degraded"', async () => {
    vi.useFakeTimers();
    try {
      service = new CloudLivenessProbeService();
      autoReplyHealthy = null; // child never replies → parent timeout fires

      const probePromise = service.probeHealth(TARGET);
      expect(mockWorkers).toHaveLength(1);

      // Advance past the 200ms parent-side timeout.
      await vi.advanceTimersByTimeAsync(250);

      const verdict = await probePromise;
      expect(verdict).toBe('degraded');
      expect(mockWorkers[0].killed).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('(b cont.) respawns a fresh child on the next probe after a timeout-kill', async () => {
    vi.useFakeTimers();
    try {
      service = new CloudLivenessProbeService();
      autoReplyHealthy = null;

      const p1 = service.probeHealth(TARGET);
      await vi.advanceTimersByTimeAsync(250);
      await p1;
      expect(mockWorkers[0].killed).toBe(true);

      // Move past the respawn cooldown (5s) so the next probe is allowed to spawn.
      await vi.advanceTimersByTimeAsync(5000);

      autoReplyHealthy = true;
      const p2 = service.probeHealth(TARGET);
      await vi.advanceTimersByTimeAsync(1);
      const verdict = await p2;

      expect(verdict).toBe('healthy');
      expect(forkMock).toHaveBeenCalledTimes(2); // respawned
    } finally {
      vi.useRealTimers();
    }
  });

  it('(c) child crash/exit mid-probe → pending drain resolves "degraded" (RS-F4)', async () => {
    service = new CloudLivenessProbeService();
    autoReplyHealthy = null; // don't auto-reply; we crash the child ourselves

    const probePromise = service.probeHealth(TARGET);
    // Let the parent register the pending probe.
    await Promise.resolve();
    expect(service._debugState().pendingCount).toBe(1);

    // Child crashes (exit code 1) before replying.
    mockWorkers[0].emitExit(1);

    const verdict = await probePromise;
    expect(verdict).toBe('degraded');
    expect(service._debugState().pendingCount).toBe(0); // drained
  });

  it('(c cont.) drains MULTIPLE in-flight probes to degraded on one crash', async () => {
    service = new CloudLivenessProbeService();
    autoReplyHealthy = null;

    const p1 = service.probeHealth(TARGET);
    const p2 = service.probeHealth(TARGET_2);
    await Promise.resolve();
    expect(service._debugState().pendingCount).toBe(2);

    mockWorkers[0].emitExit(11); // SIGSEGV-ish crash

    await expect(p1).resolves.toBe('degraded');
    await expect(p2).resolves.toBe('degraded');
    expect(service._debugState().pendingCount).toBe(0);
  });

  it('(d) backoff prevents a respawn storm — degraded without spawning during cooldown', async () => {
    vi.useFakeTimers();
    try {
      service = new CloudLivenessProbeService();
      autoReplyHealthy = null;

      // First probe times out → kill → cooldown armed.
      const p1 = service.probeHealth(TARGET);
      await vi.advanceTimersByTimeAsync(250);
      await p1;
      expect(forkMock).toHaveBeenCalledTimes(1);
      expect(service._debugState().inCooldown).toBe(true);

      // Several probes DURING the cooldown must NOT spawn a new child.
      const during1 = await service.probeHealth(TARGET);
      const during2 = await service.probeHealth(TARGET_2);
      expect(during1).toBe('degraded');
      expect(during2).toBe('degraded');
      expect(forkMock).toHaveBeenCalledTimes(1); // no respawn storm
    } finally {
      vi.useRealTimers();
    }
  });

  it('(e) missing worker path → fail-closed "degraded", never spawns, never blocks', async () => {
    workerFileExists = false;
    service = new CloudLivenessProbeService();

    const verdict = await service.probeHealth(TARGET);
    expect(verdict).toBe('degraded');
    expect(forkMock).not.toHaveBeenCalled();
    expect(service._debugState().spawnFailedPermanently).toBe(true);

    // Permanent: a second probe also fails closed without spawning.
    expect(await service.probeHealth(TARGET)).toBe('degraded');
    expect(forkMock).not.toHaveBeenCalled();
  });

  it('(c+) kill() that throws and emits no exit still drains pending to degraded (no leak)', async () => {
    vi.useFakeTimers();
    try {
      service = new CloudLivenessProbeService();
      autoReplyHealthy = null; // child never replies → parent timeout fires

      // Make kill() throw WITHOUT emitting exit — simulates a zombie child whose
      // 'exit' event never arrives. Without the defensive drain this leaks.
      const probePromise = service.probeHealth(TARGET);
      mockWorkers[0].kill = vi.fn(() => {
        throw new Error('kill failed: already exited');
      });

      await vi.advanceTimersByTimeAsync(250); // timeout → killWorker → kill throws

      await expect(probePromise).resolves.toBe('degraded');
      expect(service._debugState().pendingCount).toBe(0);
      expect(service._debugState().inCooldown).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('(F1) reply after parent timeout is ALWAYS degraded — never caches healthy (settle-race)', async () => {
    vi.useFakeTimers();
    try {
      service = new CloudLivenessProbeService();
      autoReplyHealthy = null; // child never auto-replies; we drive the reply by hand

      const probePromise = service.probeHealth(TARGET);
      expect(mockWorkers).toHaveLength(1);
      const worker = mockWorkers[0];

      // Hold the `exit` event: kill() marks killed but does NOT emit exit, so we
      // can deliver a reply in the kill→exit window that the pre-fix code would
      // settle as healthy. (Pre-fix: timeout only called killWorker(), leaving
      // the pending id live → a late `healthy` reply poisoned the cache.)
      worker.kill = vi.fn(() => {
        worker.killed = true;
      });

      const postedId = worker.lastMessage?.id;
      expect(postedId).toBeTruthy();

      // Advance past the 200ms parent-side timeout. Post-fix this settles the
      // probe degraded + kills; pre-fix it only kills, leaving the id live.
      await vi.advanceTimersByTimeAsync(250);
      expect(worker.killed).toBe(true);

      // Late `healthy` reply for the timed-out id arrives in the kill→exit
      // window. Post-fix: no-op (pending already empty). Pre-fix: this would
      // settle the public promise healthy AND cache healthy — the bug.
      worker.reply(postedId as string, true);
      await Promise.resolve();

      // The public promise must resolve degraded (the timeout boundary wins).
      await expect(probePromise).resolves.toBe('degraded');
      // Cache must remain degraded — the late healthy reply is a no-op.
      expect(service.getCachedVerdict(TARGET)).toBe('degraded');
      expect(service._debugState().pendingCount).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('(F2) a stale child\'s late exit is ignored — does not clear the new worker or drain unrelated pending', async () => {
    vi.useFakeTimers();
    try {
      service = new CloudLivenessProbeService();
      autoReplyHealthy = null; // first probe times out

      // First probe → timeout. Make kill() throw WITHOUT emitting exit so the
      // service clears this.worker immediately (the kill()-throws path). The old
      // child is now "stale" but still alive enough to emit a late exit.
      const p1 = service.probeHealth(TARGET);
      const staleWorker = mockWorkers[0];
      staleWorker.kill = vi.fn(() => {
        throw new Error('kill failed: zombie');
      });
      await vi.advanceTimersByTimeAsync(250);
      await expect(p1).resolves.toBe('degraded');
      expect(service._debugState().hasWorker).toBe(false);

      // p1's timeout settled degraded and drained its pending. Let the respawn
      // cooldown lapse so the NEXT probe is allowed to spawn a fresh child (S4.2:
      // there is no per-target backoff re-probe anymore — the periodic re-walk
      // scheduler owns re-probing — so nothing fires on its own here).
      autoReplyHealthy = false;
      await vi.advanceTimersByTimeAsync(6000); // past the respawn cooldown
      await vi.advanceTimersByTimeAsync(1);
      expect(service._debugState().pendingCount).toBe(0); // no leftover pending

      // Now the TARGET_2 phase: the in-flight probe spawns a fresh (post-stale) child
      // and must NOT be drained by the STALE child's late exit.
      autoReplyHealthy = null;
      const p2 = service.probeHealth(TARGET_2);
      await Promise.resolve();
      expect(service._debugState().hasWorker).toBe(true);
      const freshWorker = mockWorkers[mockWorkers.length - 1];
      expect(freshWorker).not.toBe(staleWorker);
      expect(service._debugState().hasWorker).toBe(true);
      expect(service._debugState().pendingCount).toBe(1); // p2 still in flight

      // The STALE child now emits its late exit. It must be IGNORED: the fresh
      // worker stays live and p2's pending probe is NOT drained.
      staleWorker.emitExit(0);
      await Promise.resolve();
      expect(service._debugState().hasWorker).toBe(true); // fresh worker intact
      expect(service._debugState().pendingCount).toBe(1); // p2 NOT drained

      // The fresh child replies healthy → p2 resolves healthy as normal.
      freshWorker.reply(freshWorker.lastMessage?.id as string, true);
      await expect(p2).resolves.toBe('healthy');
    } finally {
      vi.useRealTimers();
    }
  });

  it('getCachedVerdict returns "unknown" before any probe (no I/O, sync)', () => {
    service = new CloudLivenessProbeService();
    expect(service.getCachedVerdict(TARGET)).toBe('unknown');
  });

  it('dispose() kills the child and drains pending to degraded', async () => {
    service = new CloudLivenessProbeService();
    autoReplyHealthy = null;

    const probePromise = service.probeHealth(TARGET);
    await Promise.resolve();
    expect(service._debugState().pendingCount).toBe(1);

    service.dispose();
    await expect(probePromise).resolves.toBe('degraded');

    // Post-dispose probes fail closed.
    expect(await service.probeHealth(TARGET)).toBe('degraded');
  });
});

// ───────────────────────────────────────────────────────────────────────────
// Stage 3 — recovery layer: TTL/backoff, auto-recovery, cold-start prewarm,
// flap-debounced display verdict, event-driven invalidation, dispose teardown.
// ───────────────────────────────────────────────────────────────────────────
describe('cloudLivenessProbeService — Stage 3 recovery layer', () => {
  it('healthy verdict has a longer TTL than degraded (raw cache un-debounced)', async () => {
    vi.useFakeTimers();
    try {
      service = new CloudLivenessProbeService();
      autoReplyHealthy = true;
      const p = service.probeHealth(TARGET);
      await vi.advanceTimersByTimeAsync(1);
      await p;
      expect(service.getCachedVerdict(TARGET)).toBe('healthy');

      // Still healthy at 30s (< 45s TTL)...
      await vi.advanceTimersByTimeAsync(30_000);
      expect(service.getCachedVerdict(TARGET)).toBe('healthy');
      // ...but expired to unknown past 45s.
      await vi.advanceTimersByTimeAsync(16_000);
      expect(service.getCachedVerdict(TARGET)).toBe('unknown');
    } finally {
      vi.useRealTimers();
    }
  });

  it('cold-start prewarm() probes given targets off-thread and populates the cache', async () => {
    vi.useFakeTimers();
    try {
      service = new CloudLivenessProbeService();
      autoReplyHealthy = true;

      service.prewarm([TARGET, TARGET_2]);
      await vi.advanceTimersByTimeAsync(1);

      // Both verdicts populated WITHIN this launch (DA-2: no dark Drive).
      expect(service.getCachedVerdict(TARGET)).toBe('healthy');
      expect(service.getCachedVerdict(TARGET_2)).toBe('healthy');
      // Single persistent child for both.
      expect(forkMock).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('prewarm() is a no-op on an empty list and after dispose', async () => {
    service = new CloudLivenessProbeService();
    service.prewarm([]);
    expect(forkMock).not.toHaveBeenCalled();

    service.dispose();
    service.prewarm([TARGET]);
    expect(forkMock).not.toHaveBeenCalled();
  });

  it('getDisplayVerdict debounces: shows degraded only after the time threshold (read-time eval)', async () => {
    vi.useFakeTimers();
    try {
      service = new CloudLivenessProbeService();
      autoReplyHealthy = false;

      // First degraded → display still NOT degraded (debounced: 1 sample, < 8s).
      const p1 = service.probeHealth(TARGET);
      await vi.advanceTimersByTimeAsync(1);
      await p1;
      expect(service.getCachedVerdict(TARGET)).toBe('degraded'); // raw = immediate truth
      expect(service.getDisplayVerdict(TARGET)).not.toBe('degraded'); // debounced

      // Past the DISPLAY_DEGRADE_AFTER_MS (8s) threshold → display flips to degraded.
      // This is the time-based settle (read-time evaluated, S4.2 B1) — it no longer
      // depends on a background re-probe supplying a second consecutive sample.
      await vi.advanceTimersByTimeAsync(8_001);
      expect(service.getDisplayVerdict(TARGET)).toBe('degraded');
    } finally {
      vi.useRealTimers();
    }
  });

  it('after a KNOWN-healthy mount degrades, the display stays healthy until the 8s threshold (R-MUST-1: no premature "reconnecting")', async () => {
    // The real UI scenario the read-time eval must preserve: a space whose display was
    // already 'healthy' must NOT flip to 'degraded' on the FIRST degraded observation
    // (the renderer maps any non-healthy display verdict to "reconnecting", so an early
    // flip would flash a false outage). It stays healthy within the 8s debounce window
    // and only settles to degraded after it — WITHOUT the deleted scheduleReprobe's
    // second sample (S4.2 B1 read-time eval).
    vi.useFakeTimers();
    try {
      service = new CloudLivenessProbeService();

      // Establish a KNOWN-healthy display baseline.
      autoReplyHealthy = true;
      const ph = service.probeHealth(TARGET);
      await vi.advanceTimersByTimeAsync(1);
      await ph;
      expect(service.getDisplayVerdict(TARGET)).toBe('healthy');

      // Lapse the reshow cooldown armed by the first healthy display (so this test
      // exercises the debounce, not the cooldown — both must hold healthy here).
      await vi.advanceTimersByTimeAsync(19_000);

      // Mount dies: ONE degraded observation. Raw cache flips immediately; the
      // DISPLAY stays healthy (debounced) within the 8s window.
      autoReplyHealthy = false;
      const pd = service.probeHealth(TARGET);
      await vi.advanceTimersByTimeAsync(1);
      await pd;
      expect(service.getCachedVerdict(TARGET)).toBe('degraded'); // raw = immediate truth
      expect(service.getDisplayVerdict(TARGET)).toBe('healthy');  // display NOT yet reconnecting

      // Past the 8s threshold (no further probe/sample) → display settles to degraded.
      await vi.advanceTimersByTimeAsync(8_001);
      expect(service.getDisplayVerdict(TARGET)).toBe('degraded');
    } finally {
      vi.useRealTimers();
    }
  });

  it('getDisplayVerdict clears on the first healthy verdict', async () => {
    vi.useFakeTimers();
    try {
      service = new CloudLivenessProbeService();

      // Drive it degraded, then past the 8s threshold → display degraded.
      autoReplyHealthy = false;
      const p1 = service.probeHealth(TARGET);
      await vi.advanceTimersByTimeAsync(1);
      await p1;
      await vi.advanceTimersByTimeAsync(8_001);
      expect(service.getDisplayVerdict(TARGET)).toBe('degraded');

      // One healthy verdict clears the display immediately.
      autoReplyHealthy = true;
      const p2 = service.probeHealth(TARGET);
      await vi.advanceTimersByTimeAsync(1);
      await p2;
      expect(service.getDisplayVerdict(TARGET)).toBe('healthy');
    } finally {
      vi.useRealTimers();
    }
  });

  it('getDisplayVerdict cooldown: a brief re-flap right after a clear does not immediately re-show degraded', async () => {
    vi.useFakeTimers();
    try {
      service = new CloudLivenessProbeService();

      // degraded then past 8s → display degraded; then healthy → cleared + cooldown armed.
      autoReplyHealthy = false;
      let p = service.probeHealth(TARGET);
      await vi.advanceTimersByTimeAsync(1);
      await p;
      await vi.advanceTimersByTimeAsync(8_001);
      expect(service.getDisplayVerdict(TARGET)).toBe('degraded');

      autoReplyHealthy = true;
      p = service.probeHealth(TARGET);
      await vi.advanceTimersByTimeAsync(1);
      await p;
      expect(service.getDisplayVerdict(TARGET)).toBe('healthy');

      // Immediately flaps non-healthy again (within the 18s cooldown). Two more
      // degraded samples, but the cooldown suppresses re-showing degraded.
      autoReplyHealthy = false;
      p = service.probeHealth(TARGET);
      await vi.advanceTimersByTimeAsync(1);
      await p;
      p = service.probeHealth(TARGET);
      await vi.advanceTimersByTimeAsync(1);
      await p;
      expect(service.getDisplayVerdict(TARGET)).toBe('healthy'); // cooldown still holds
    } finally {
      vi.useRealTimers();
    }
  });

  it('invalidateVerdict() drops the cache and kicks an immediate re-probe', async () => {
    vi.useFakeTimers();
    try {
      service = new CloudLivenessProbeService();
      autoReplyHealthy = true;
      const p = service.probeHealth(TARGET);
      await vi.advanceTimersByTimeAsync(1);
      await p;
      expect(service.getCachedVerdict(TARGET)).toBe('healthy');

      // Invalidate: cache drops to unknown synchronously...
      autoReplyHealthy = false; // the re-probe will reply degraded
      service.invalidateVerdict(TARGET);
      // ...and an immediate off-thread re-probe runs.
      await vi.advanceTimersByTimeAsync(1);
      expect(service.getCachedVerdict(TARGET)).toBe('degraded');
    } finally {
      vi.useRealTimers();
    }
  });

  it('invalidateVerdict() is a no-op after dispose', async () => {
    service = new CloudLivenessProbeService();
    service.dispose();
    const forkCallsBefore = forkMock.mock.calls.length;
    service.invalidateVerdict(TARGET);
    expect(forkMock.mock.calls.length).toBe(forkCallsBefore);
  });

  it('dispose() clears per-target recovery/display state and stops further probing', async () => {
    vi.useFakeTimers();
    try {
      service = new CloudLivenessProbeService();
      autoReplyHealthy = false;

      // Two degraded targets → two per-target recovery/display states.
      const p1 = service.probeHealth(TARGET);
      const p2 = service.probeHealth(TARGET_2);
      await vi.advanceTimersByTimeAsync(1);
      await Promise.all([p1, p2]);
      expect(service._debugState().recoveryCount).toBe(2);

      service.dispose();
      // Per-target state cleared on dispose.
      expect(service._debugState().recoveryCount).toBe(0);
      expect(service._debugRecoveryState(TARGET)).toBeNull();

      // No probe fires after dispose even if we advance the clock (S4.2: the
      // per-target backoff re-probe loop is gone; the periodic re-walk scheduler,
      // disposed separately, owns re-probing).
      const forkCallsAfterDispose = forkMock.mock.calls.length;
      await vi.advanceTimersByTimeAsync(200_000);
      expect(forkMock.mock.calls.length).toBe(forkCallsAfterDispose);
    } finally {
      vi.useRealTimers();
    }
  });
});
