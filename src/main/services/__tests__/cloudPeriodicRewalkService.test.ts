/**
 * SYNTHESIS S4.3 (260619_cloud-symlink-indexing) — `createCloudPeriodicRewalkScheduler`.
 *
 * Pins the binding revisions from the S4.3 cross-family review:
 *  - R6: flag-OFF neutrality — with `isEnabled()` false the tick does NO work
 *    (no target derivation, no probe, no re-walk).
 *  - R1: the tick AWAITS settled `probeHealth` verdicts before deciding; a healthy
 *    verdict drives exactly one coalesced re-walk, an all-degraded tick drives none.
 *  - Single-flight + trailing-coalesce on the re-walk (copied from
 *    cloudRecoveryReindex.ts): a trigger mid-flight collapses to one trailing run.
 *  - dispose() stops the timer and prevents further ticks/re-walks (idempotent).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  createCloudPeriodicRewalkScheduler,
  CLOUD_PERIODIC_REWALK_INTERVAL_MS,
  type CloudPeriodicRewalkDeps,
} from '../cloudPeriodicRewalkService';
import type { CloudHealthVerdict, ReadlinkResolvedTarget } from '@core/services/cloudLivenessProbe';

const TARGET_A = '/cloud/A' as ReadlinkResolvedTarget;
const TARGET_B = '/cloud/B' as ReadlinkResolvedTarget;

function makeDeps(overrides: Partial<CloudPeriodicRewalkDeps> = {}): {
  deps: CloudPeriodicRewalkDeps;
  isEnabled: ReturnType<typeof vi.fn>;
  getCloudTargets: ReturnType<typeof vi.fn>;
  probeHealth: ReturnType<typeof vi.fn>;
  rewalk: ReturnType<typeof vi.fn>;
} {
  const isEnabled = vi.fn(() => true);
  const getCloudTargets = vi.fn(() => [TARGET_A] as readonly ReadlinkResolvedTarget[]);
  const probeHealth = vi.fn(async (_t: ReadlinkResolvedTarget): Promise<CloudHealthVerdict> => 'healthy');
  const rewalk = vi.fn(async () => {});
  const deps: CloudPeriodicRewalkDeps = {
    isEnabled,
    getCloudTargets,
    probeHealth,
    rewalk,
    intervalMs: 1000,
    ...overrides,
  };
  // Apply overrides to the spies too, so callers can assert on the exact fn passed.
  return {
    deps,
    isEnabled: (overrides.isEnabled ?? isEnabled) as ReturnType<typeof vi.fn>,
    getCloudTargets: (overrides.getCloudTargets ?? getCloudTargets) as ReturnType<typeof vi.fn>,
    probeHealth: (overrides.probeHealth ?? probeHealth) as ReturnType<typeof vi.fn>,
    rewalk: (overrides.rewalk ?? rewalk) as ReturnType<typeof vi.fn>,
  };
}

describe('createCloudPeriodicRewalkScheduler', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  describe('flag-OFF neutrality (R6)', () => {
    it('does NO work when the flag is off — no target derivation, probe, or re-walk', async () => {
      const { deps, getCloudTargets, probeHealth, rewalk } = makeDeps({ isEnabled: vi.fn(() => false) });
      const scheduler = createCloudPeriodicRewalkScheduler(deps);
      await scheduler.__runTickForTests();
      expect(getCloudTargets).not.toHaveBeenCalled();
      expect(probeHealth).not.toHaveBeenCalled();
      expect(rewalk).not.toHaveBeenCalled();
    });

    it('the started timer is inert with the flag off across many intervals', async () => {
      const { deps, rewalk } = makeDeps({ isEnabled: vi.fn(() => false) });
      const scheduler = createCloudPeriodicRewalkScheduler(deps);
      scheduler.start();
      await vi.advanceTimersByTimeAsync(deps.intervalMs * 5);
      expect(rewalk).not.toHaveBeenCalled();
      scheduler.dispose();
    });

    it('second guard: no cloud targets ⇒ no probe, no re-walk (flag on)', async () => {
      const { deps, probeHealth, rewalk } = makeDeps({ getCloudTargets: vi.fn(() => []) });
      const scheduler = createCloudPeriodicRewalkScheduler(deps);
      await scheduler.__runTickForTests();
      expect(probeHealth).not.toHaveBeenCalled();
      expect(rewalk).not.toHaveBeenCalled();
    });
  });

  describe('tick → re-walk (R1: settled verdicts)', () => {
    it('probes every target and re-walks once when ≥1 is healthy', async () => {
      const probeHealth = vi.fn(async (t: ReadlinkResolvedTarget): Promise<CloudHealthVerdict> =>
        t === TARGET_A ? 'degraded' : 'healthy',
      );
      const { deps, rewalk } = makeDeps({
        getCloudTargets: vi.fn(() => [TARGET_A, TARGET_B]),
        probeHealth,
      });
      const scheduler = createCloudPeriodicRewalkScheduler(deps);
      await scheduler.__runTickForTests();
      expect(probeHealth).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(0);
      expect(rewalk).toHaveBeenCalledTimes(1);
    });

    it('does NOT re-walk when every target is degraded/unknown (retain, retry next tick)', async () => {
      const probeHealth = vi.fn(async (t: ReadlinkResolvedTarget): Promise<CloudHealthVerdict> =>
        t === TARGET_A ? 'degraded' : 'unknown',
      );
      const { deps, rewalk } = makeDeps({
        getCloudTargets: vi.fn(() => [TARGET_A, TARGET_B]),
        probeHealth,
      });
      const scheduler = createCloudPeriodicRewalkScheduler(deps);
      await scheduler.__runTickForTests();
      await vi.advanceTimersByTimeAsync(0);
      expect(rewalk).not.toHaveBeenCalled();
    });

    it('re-reads the flag AFTER the probe settles — a flip-to-off mid-probe cancels the re-walk', async () => {
      let enabled = true;
      const probeHealth = vi.fn(async (): Promise<CloudHealthVerdict> => {
        enabled = false; // flag flips off while the probe is settling
        return 'healthy';
      });
      const { deps, rewalk } = makeDeps({ isEnabled: () => enabled, probeHealth });
      const scheduler = createCloudPeriodicRewalkScheduler(deps);
      await scheduler.__runTickForTests();
      await vi.advanceTimersByTimeAsync(0);
      expect(rewalk).not.toHaveBeenCalled();
    });
  });

  describe('single-flight + trailing-coalesce', () => {
    it('coalesces a mid-flight trigger to exactly one trailing re-walk', async () => {
      let resolveFirst!: () => void;
      const rewalk = vi.fn(() => new Promise<void>((resolve) => { resolveFirst = resolve; }));
      const { deps } = makeDeps({ rewalk });
      const scheduler = createCloudPeriodicRewalkScheduler(deps);

      await scheduler.__runTickForTests(); // schedules re-walk #1 (in flight)
      await vi.advanceTimersByTimeAsync(0);
      expect(rewalk).toHaveBeenCalledTimes(1);

      await scheduler.__runTickForTests(); // healthy again, but #1 still in flight → coalesce
      await vi.advanceTimersByTimeAsync(0);
      expect(rewalk).toHaveBeenCalledTimes(1);

      resolveFirst(); // #1 finishes → exactly ONE trailing re-walk
      await vi.advanceTimersByTimeAsync(0);
      expect(rewalk).toHaveBeenCalledTimes(2);
    });

    it('suppresses a coalesced trailing re-walk if the flag flips off mid-flight (R6)', async () => {
      let enabled = true;
      let resolveFirst!: () => void;
      const rewalk = vi.fn(() => new Promise<void>((resolve) => { resolveFirst = resolve; }));
      const { deps } = makeDeps({ isEnabled: () => enabled, rewalk });
      const scheduler = createCloudPeriodicRewalkScheduler(deps);

      await scheduler.__runTickForTests(); // re-walk #1 in flight
      await vi.advanceTimersByTimeAsync(0);
      expect(rewalk).toHaveBeenCalledTimes(1);

      await scheduler.__runTickForTests(); // healthy again → pendingRerun set (coalesced)
      await vi.advanceTimersByTimeAsync(0);
      expect(rewalk).toHaveBeenCalledTimes(1);

      enabled = false; // flag flips off while #1 is still in flight
      resolveFirst(); // #1 finishes → the trailing re-walk must be SUPPRESSED
      await vi.advanceTimersByTimeAsync(0);
      expect(rewalk).toHaveBeenCalledTimes(1);
    });

    it('a throwing re-walk does not break the scheduler', async () => {
      const rewalk = vi
        .fn<() => Promise<void>>()
        .mockRejectedValueOnce(new Error('boom'))
        .mockResolvedValue(undefined);
      const { deps } = makeDeps({ rewalk });
      const scheduler = createCloudPeriodicRewalkScheduler(deps);
      await scheduler.__runTickForTests();
      await vi.advanceTimersByTimeAsync(0);
      expect(rewalk).toHaveBeenCalledTimes(1);
      await scheduler.__runTickForTests();
      await vi.advanceTimersByTimeAsync(0);
      expect(rewalk).toHaveBeenCalledTimes(2);
    });
  });

  describe('triggerRewalk (S4.2 flip push)', () => {
    it('schedules exactly one coalesced re-walk when the flag is on', async () => {
      const { deps, rewalk } = makeDeps();
      const scheduler = createCloudPeriodicRewalkScheduler(deps);
      scheduler.triggerRewalk('flag-flip');
      await vi.advanceTimersByTimeAsync(0);
      expect(rewalk).toHaveBeenCalledTimes(1);
    });

    it('is a NO-OP when the flag is off (R6 — flip-OFF must not leak a re-walk)', async () => {
      const { deps, rewalk } = makeDeps({ isEnabled: vi.fn(() => false) });
      const scheduler = createCloudPeriodicRewalkScheduler(deps);
      scheduler.triggerRewalk('flag-flip');
      await vi.advanceTimersByTimeAsync(0);
      expect(rewalk).not.toHaveBeenCalled();
    });

    it('shares the single-flight with the periodic tick (a push mid-tick-rewalk coalesces to one trailing run)', async () => {
      let resolveFirst!: () => void;
      const rewalk = vi.fn(() => new Promise<void>((resolve) => { resolveFirst = resolve; }));
      const { deps } = makeDeps({ rewalk });
      const scheduler = createCloudPeriodicRewalkScheduler(deps);

      await scheduler.__runTickForTests(); // tick schedules re-walk #1 (in flight)
      await vi.advanceTimersByTimeAsync(0);
      expect(rewalk).toHaveBeenCalledTimes(1);

      scheduler.triggerRewalk('flag-flip'); // push mid-flight → coalesced, not a 2nd concurrent run
      await vi.advanceTimersByTimeAsync(0);
      expect(rewalk).toHaveBeenCalledTimes(1);

      resolveFirst(); // #1 finishes → exactly one trailing re-walk
      await vi.advanceTimersByTimeAsync(0);
      expect(rewalk).toHaveBeenCalledTimes(2);
    });

    it('is a no-op after dispose', async () => {
      const { deps, rewalk } = makeDeps();
      const scheduler = createCloudPeriodicRewalkScheduler(deps);
      scheduler.dispose();
      scheduler.triggerRewalk('flag-flip');
      await vi.advanceTimersByTimeAsync(0);
      expect(rewalk).not.toHaveBeenCalled();
    });
  });

  describe('lifecycle', () => {
    it('start() drives ticks on the interval; dispose() stops them (idempotent)', async () => {
      const { deps, rewalk } = makeDeps();
      const scheduler = createCloudPeriodicRewalkScheduler(deps);
      scheduler.start();
      scheduler.start(); // idempotent — must not double-arm the timer

      await vi.advanceTimersByTimeAsync(deps.intervalMs);
      await vi.advanceTimersByTimeAsync(0);
      expect(rewalk).toHaveBeenCalledTimes(1);

      scheduler.dispose();
      scheduler.dispose(); // idempotent
      await vi.advanceTimersByTimeAsync(deps.intervalMs * 3);
      await vi.advanceTimersByTimeAsync(0);
      expect(rewalk).toHaveBeenCalledTimes(1); // no further ticks after dispose
    });

    it('a tick after dispose() is a no-op', async () => {
      const { deps, probeHealth, rewalk } = makeDeps();
      const scheduler = createCloudPeriodicRewalkScheduler(deps);
      scheduler.dispose();
      await scheduler.__runTickForTests();
      expect(probeHealth).not.toHaveBeenCalled();
      expect(rewalk).not.toHaveBeenCalled();
    });

    it('exposes the 5-minute v1 interval constant', () => {
      expect(CLOUD_PERIODIC_REWALK_INTERVAL_MS).toBe(300_000);
    });
  });
});
