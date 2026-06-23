import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  assembleDesktopBundle,
  assembleMinimalDesktopBundle,
  type AssembleDesktopBundleInput,
  type MinimalDesktopBundleInput,
} from '../diagnosticBundleService';

/**
 * Stage 2 (260617_bricked-state-0448-electron42): the desktop diagnostics
 * bundle must NEVER hang, even when a collector's promise never resolves under
 * heap/IO pressure. These are the red→green proofs:
 *   RED (pre-fix): a non-resolving collector hung `assembleDesktopBundle`
 *   forever — these tests would time out.
 *   GREEN (post-fix): the per-collector + top-level deadline bound it; the
 *   affected section is `unavailable`, recorded in `manifest.timedOut`.
 */

function desktopInput(
  overrides: Partial<Omit<AssembleDesktopBundleInput, 'collectors'>> & {
    collectors?: Partial<AssembleDesktopBundleInput['collectors']>;
  } = {},
): AssembleDesktopBundleInput {
  const { collectors, ...rest } = overrides;
  return {
    settings: {} as never,
    logger: { warn: () => {} },
    options: { includeFullLogs: true, includeErrorsOnly: false, includeChiefOfStaff: false, includeSentryScope: false },
    paths: { userData: '/u', logs: '/u/logs', sessions: '/u/sessions', sentry: '/u/sentry' },
    appInfo: { version: '1', platform: 'darwin', arch: 'arm64', isPackaged: false, electronVersion: 'e', nodeVersion: 'n' },
    // Tight deadlines so fake timers drive the timeout quickly.
    collectorTimeoutMs: 1_000,
    deadlineMs: 5_000,
    ...rest,
    collectors: {
      runSystemHealthCheck: async () => ({ status: 'healthy', checks: {} }),
      resolveMcpConfigPath: () => null,
      readMcpConfig: async () => ({}),
      gatherRecentSessions: async () => [],
      countTotalSessions: async () => 0,
      gatherContinuityDiagnostics: async () => [],
      captureRamSnapshot: () => ({ ok: true }),
      gatherSentryScope: async () => null,
      gatherChiefOfStaffReadme: async () => null,
      gatherElectronStoreFiles: async () => ({}),
      exportRecentLogs: async () => ({ files: [], totalLines: 0, timeWindow: { start: 'a', end: 'b' } }),
      gatherTurnLogs: async () => [],
      getPerfStatsIfNotable: () => undefined,
      ...collectors,
    },
  };
}

const NEVER_RESOLVES = <T>(): Promise<T> => new Promise<T>(() => {
  /* intentionally never settles */
});

describe('assembleDesktopBundle deadline behaviour', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('resolves within the deadline when a collector never resolves; marks its section unavailable + records the timeout', async () => {
    const promise = assembleDesktopBundle(desktopInput({
      collectors: {
        // The prime hang suspect: unbounded session hydration that never returns.
        runSystemHealthCheck: () => NEVER_RESOLVES(),
      },
    }));
    // Advance well past the per-collector + top-level deadlines.
    await vi.advanceTimersByTimeAsync(6_000);
    const assembled = await promise;

    expect(assembled.files.has('manifest.json')).toBe(true);
    // The health collector owns health_timing — unavailable + recorded on timeout.
    expect(assembled.manifest.sections?.health_timing).toBe('unavailable');
    expect(assembled.manifest.timedOut).toContain('health_timing');
    // provider_reachability is now DECOUPLED from health (its own collector runs
    // first), so a hung health collector must NOT drag it to unavailable. With no
    // reachability collector provided here it stays at its default ('empty'), and
    // is not recorded as a health timeout.
    expect(assembled.manifest.sections?.provider_reachability).toBe('empty');
    expect(assembled.manifest.timedOut).not.toContain('provider_reachability');
    // No health.json written — collector was abandoned.
    expect(assembled.files.has('health.json')).toBe(false);
  });

  it('collects provider reachability even when the health collector hangs (decoupled — the "no connection?" answer survives)', async () => {
    const reachabilitySnapshot = {
      snapshotPresent: true,
      lastRefreshAt: 1,
      providers: { 'rebel-cloud': { status: 'unreachable', errorCode: 'timeout' } },
    };
    const promise = assembleDesktopBundle(desktopInput({
      collectors: {
        // Reachability resolves fast; health then hangs forever.
        refreshProviderReachability: async () => reachabilitySnapshot,
        runSystemHealthCheck: () => NEVER_RESOLVES(),
      },
    }));
    await vi.advanceTimersByTimeAsync(6_000);
    const assembled = await promise;

    // Reachability was gathered first and survives the later health-collector hang.
    expect(assembled.manifest.sections?.provider_reachability).toBe('included');
    expect(assembled.files.has('provider-reachability.json')).toBe(true);
    expect(assembled.manifest.timedOut).not.toContain('provider_reachability');
    // Health still times out independently.
    expect(assembled.manifest.sections?.health_timing).toBe('unavailable');
  });

  it('a hung reachability probe (it runs FIRST) marks its own section unavailable and cascades the deadline', async () => {
    // Reachability runs first; if IT hangs it owns the timeout (and, by the
    // documented deadline-trip cascade, short-circuits later collectors). The
    // per-provider 5s AbortController makes this rare in production, but pin the
    // contract so the cascade is intentional, not a surprise.
    const promise = assembleDesktopBundle(desktopInput({
      collectors: {
        refreshProviderReachability: () => NEVER_RESOLVES(),
      },
    }));
    await vi.advanceTimersByTimeAsync(6_000);
    const assembled = await promise;

    expect(assembled.manifest.sections?.provider_reachability).toBe('unavailable');
    expect(assembled.manifest.timedOut).toContain('provider_reachability');
    expect(assembled.files.has('provider-reachability.json')).toBe(false);
  });

  it('M1: a timed-out FULL bundle is marked partial=true (not silent success)', async () => {
    // The bug is a hang/TIMEOUT, not a throw — so the common failure mode is a
    // full bundle with timed-out sections. It MUST be reported partial so the
    // renderer warns the user, not "Diagnostic bundle downloaded".
    const promise = assembleDesktopBundle(desktopInput({
      collectors: {
        gatherContinuityDiagnostics: () => NEVER_RESOLVES(),
      },
    }));
    await vi.advanceTimersByTimeAsync(6_000);
    const assembled = await promise;
    expect(assembled.manifest.partial).toBe(true);
    expect(assembled.manifest.timedOut).toContain('continuity_trail');
  });

  it('produces a full bundle with no unavailable sections when all collectors are fast', async () => {
    const promise = assembleDesktopBundle(desktopInput({
      collectors: {
        exportRecentLogs: async () => ({
          files: [{ filename: 'main.log', content: '{"level":40,"msg":"warn"}', lineCount: 1, sizeBytes: 25 }],
          totalLines: 1,
          timeWindow: { start: 'a', end: 'b' },
        }),
      },
    }));
    await vi.advanceTimersByTimeAsync(10);
    const assembled = await promise;

    // Nothing timed out → no timedOut list (back-compat: field absent).
    expect(assembled.manifest.timedOut).toBeUndefined();
    expect(assembled.files.has('health.json')).toBe(true);
    // health-derived sections collected successfully (not timeout-unavailable).
    expect(assembled.manifest.sections?.recent_logs).toBe('included');
    expect(assembled.manifest.sections?.provider_reachability).not.toBe('unavailable');
  });

  it('distinguishes a collector that resolves [] (empty) from one that times out (unavailable + timedOut)', async () => {
    const promise = assembleDesktopBundle(desktopInput({
      options: {
        includeFullLogs: true,
        includeErrorsOnly: false,
        includeChiefOfStaff: false,
        includeSentryScope: false,
      },
      collectors: {
        // continuity resolves with nothing → empty (ran, found nothing)
        gatherContinuityDiagnostics: async () => [],
        // recent-logs collector never resolves → unavailable (timed out)
        exportRecentLogs: () => NEVER_RESOLVES(),
      },
    }));
    await vi.advanceTimersByTimeAsync(6_000);
    const assembled = await promise;

    expect(assembled.manifest.sections?.continuity_trail).toBe('empty');
    expect(assembled.manifest.sections?.recent_logs).toBe('unavailable');
    expect(assembled.manifest.timedOut).toContain('recent_logs');
    expect(assembled.manifest.timedOut).not.toContain('continuity_trail');
  });

  it('bounds the abandoned-promise residual: a hung collector aborts its signal so cancellable I/O can stop', async () => {
    let healthAborted = false;
    const promise = assembleDesktopBundle(desktopInput({
      collectors: {
        runSystemHealthCheck: (_settings, signal) =>
          new Promise(() => {
            signal?.addEventListener('abort', () => {
              healthAborted = true;
            });
          }),
      },
    }));
    await vi.advanceTimersByTimeAsync(6_000);
    await promise;
    expect(healthAborted).toBe(true);
  });

  it('bounds the abandoned-promise residual to <=1: once a collector times out, LATER heavy collectors are not invoked', async () => {
    let sessionsInvoked = false;
    let storeFilesInvoked = false;
    const promise = assembleDesktopBundle(desktopInput({
      collectors: {
        // First heavy collector hangs → trips the deadline.
        runSystemHealthCheck: () => NEVER_RESOLVES(),
        // These run AFTER health in assembleDesktopBundle order — must be skipped.
        gatherRecentSessions: async () => {
          sessionsInvoked = true;
          return [];
        },
        gatherElectronStoreFiles: async () => {
          storeFilesInvoked = true;
          return {};
        },
      },
    }));
    await vi.advanceTimersByTimeAsync(6_000);
    const assembled = await promise;
    expect(assembled.files.has('manifest.json')).toBe(true);
    // After the health timeout tripped the deadline, later heavy collectors
    // are short-circuited (their work factory is never called) — so at most one
    // abandoned promise (health) is left running.
    expect(sessionsInvoked).toBe(false);
    expect(storeFilesInvoked).toBe(false);
    // The skipped section-owning collectors are still marked unavailable.
    expect(assembled.manifest.sections?.auto_update_forensics).toBe('unavailable');
  });

  it('caps total assembly at the top-level deadline even when every collector is slow', async () => {
    // Every async collector sits just under its own per-collector deadline.
    const slow = <T>(value: T): Promise<T> =>
      new Promise<T>((resolve) => setTimeout(() => resolve(value), 900));
    const promise = assembleDesktopBundle(desktopInput({
      collectorTimeoutMs: 1_000,
      deadlineMs: 2_500,
      collectors: {
        runSystemHealthCheck: () => slow({ status: 'healthy', checks: {} }),
        gatherRecentSessions: () => slow([]),
        countTotalSessions: () => slow(0),
        gatherContinuityDiagnostics: () => slow([]),
        gatherElectronStoreFiles: () => slow({}),
        exportRecentLogs: () => slow({ files: [], totalLines: 0, timeWindow: { start: 'a', end: 'b' } }),
        gatherTurnLogs: () => slow([]),
      },
    }));
    // Advance past the top-level deadline; some collectors will be cut off.
    await vi.advanceTimersByTimeAsync(3_000);
    const assembled = await promise;
    expect(assembled.files.has('manifest.json')).toBe(true);
    // At least one collector should have been abandoned by the top-level ceiling.
    expect(assembled.manifest.timedOut?.length ?? 0).toBeGreaterThan(0);
  });
});

describe('assembleMinimalDesktopBundle', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  function minimalInput(
    collectors: Partial<MinimalDesktopBundleInput['collectors']> = {},
  ): MinimalDesktopBundleInput {
    return {
      appInfo: { version: '1', platform: 'darwin', arch: 'arm64', isPackaged: false, electronVersion: 'e', nodeVersion: 'n' },
      userDataPath: '/u',
      logger: { warn: () => {} },
      collectorTimeoutMs: 1_000,
      collectors: {
        readCheapStoreFiles: async () => ({}),
        exportRecentLogs: async () => ({ files: [], totalLines: 0, timeWindow: { start: 'a', end: 'b' } }),
        ...collectors,
      },
    };
  }

  it('uses ONLY the cheap collector set (readCheapStoreFiles, not the full store gather) and marks partial=true', async () => {
    // The full `gatherElectronStoreFiles` is NOT part of the minimal collector
    // interface — verified at the type level (MinimalDesktopBundleInput only
    // exposes exportRecentLogs + readCheapStoreFiles). Here we assert the cheap
    // reader is the one invoked.
    let cheapReaderInvoked = false;
    const promise = assembleMinimalDesktopBundle(minimalInput({
      readCheapStoreFiles: async () => {
        cheapReaderInvoked = true;
        return { 'clean-exit-flag.json': { clean: true }, 'auto-update-state.json': { state: 'idle' } };
      },
      exportRecentLogs: async () => ({
        files: [{ filename: 'main.log', content: '{"level":50,"msg":"err"}', lineCount: 1, sizeBytes: 24 }],
        totalLines: 1,
        timeWindow: { start: 'a', end: 'b' },
      }),
    }));
    await vi.advanceTimersByTimeAsync(10);
    const assembled = await promise;

    expect(cheapReaderInvoked).toBe(true);
    expect(assembled.manifest.partial).toBe(true);
    expect(assembled.files.has('clean-exit-flag.json')).toBe(true);
    expect(assembled.files.has('auto-update-state.json')).toBe(true);
    expect(assembled.files.has('logs/errors.ndjson')).toBe(true);
    expect(assembled.files.has('manifest.json')).toBe(true);
  });

  it('resolves even when its own cheap collectors hang (always-succeeds, partial)', async () => {
    const promise = assembleMinimalDesktopBundle(minimalInput({
      readCheapStoreFiles: () => NEVER_RESOLVES(),
      exportRecentLogs: () => NEVER_RESOLVES(),
    }));
    await vi.advanceTimersByTimeAsync(3_000);
    const assembled = await promise;

    expect(assembled.manifest.partial).toBe(true);
    expect(assembled.files.has('manifest.json')).toBe(true);
    expect(assembled.manifest.timedOut?.length ?? 0).toBeGreaterThan(0);
  });
});
