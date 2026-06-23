import { describe, it, expect, vi, afterEach } from 'vitest';
import type { BroadcastService } from '@core/broadcastService';
import type { ErrorReporter } from '@core/errorReporter';
import type { Logger as PinoLogger } from '@core/logger';
import type { CloudInstanceConfig } from '@shared/types/settings';
import type { CloudErrorCategory } from '../cloudErrorCategory';
import type { CloudHealthProbe, CloudHealthProbeResult } from '../cloudHealthProbe';
import {
  createCloudConnectionReconciler,
  type CloudInstanceSettingsAdapter,
  type ReconcilerWriter,
} from '../cloudConnectionReconciler';

class MemoryCloudInstanceSettingsAdapter implements CloudInstanceSettingsAdapter {
  constructor(private instance: CloudInstanceConfig | undefined) {}

  read(): CloudInstanceConfig | undefined {
    return this.instance;
  }

  async update(merge: Partial<CloudInstanceConfig>): Promise<void> {
    const latest = this.instance;
    if (!latest) return;
    this.instance = { ...latest, ...merge };
  }

  setCloudInstance(instance: CloudInstanceConfig): void {
    this.instance = instance;
  }
}

type Harness = {
  reconciler: ReturnType<typeof createCloudConnectionReconciler>;
  settings: MemoryCloudInstanceSettingsAdapter;
  probe: CloudHealthProbe;
  probeFn: ReturnType<typeof vi.fn<CloudHealthProbe['probe']>>;
  broadcastService: BroadcastService;
  logger: {
    debug: ReturnType<typeof vi.fn>;
    info: ReturnType<typeof vi.fn>;
    warn: ReturnType<typeof vi.fn>;
    error: ReturnType<typeof vi.fn>;
  };
  cooldown: {
    recordFailure: ReturnType<typeof vi.fn<(context?: { writer?: ReconcilerWriter; category?: CloudErrorCategory }) => void>>;
    recordSuccess: ReturnType<typeof vi.fn<(context?: { writer?: ReconcilerWriter; lastCategory?: CloudErrorCategory }) => void>>;
  };
};

const networkFetchFailed: CloudErrorCategory = { kind: 'network', subkind: 'fetch_failed' };
const authUnauthorized: CloudErrorCategory = { kind: 'auth', subkind: 'unauthorized' };

function cloudInstance(overrides: Partial<CloudInstanceConfig> = {}): CloudInstanceConfig {
  return {
    mode: 'cloud',
    cloudUrl: 'https://cloud.test',
    cloudToken: 'token',
    ...overrides,
  };
}

function createHarness(options: {
  initialCloudInstance?: CloudInstanceConfig;
  probeImpl?: CloudHealthProbe['probe'];
  cooldown?: Harness['cooldown'];
} = {}): Harness {
  const settings = new MemoryCloudInstanceSettingsAdapter(
    options.initialCloudInstance ?? cloudInstance({ lastKnownStatus: 'cold' }),
  );
  const probeFn = vi.fn<CloudHealthProbe['probe']>();
  probeFn.mockImplementation(options.probeImpl ?? (async () => ({ ok: true, status: 200 })));
  const probe: CloudHealthProbe = { probe: probeFn };
  const broadcastService: BroadcastService = {
    sendToAllWindows: vi.fn(),
    sendToFocusedWindow: vi.fn(),
  };
  const errorReporter: ErrorReporter = {
    captureException: vi.fn(),
    captureMessage: vi.fn(),
    addBreadcrumb: vi.fn(),
  };
  const logger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
  const cooldown = options.cooldown ?? {
    recordFailure: vi.fn(),
    recordSuccess: vi.fn(),
  };

  return {
    reconciler: createCloudConnectionReconciler({
      settings,
      broadcastService,
      errorReporter,
      logger: logger as unknown as PinoLogger,
      probe,
      cooldown,
    }),
    settings,
    probe,
    probeFn,
    broadcastService,
    logger,
    cooldown,
  };
}

function currentCloudInstance(settings: MemoryCloudInstanceSettingsAdapter): CloudInstanceConfig {
  const instance = settings.read();
  if (!instance) throw new Error('expected cloudInstance in test store');
  return instance;
}

afterEach(() => {
  vi.useRealTimers();
});

describe('createCloudConnectionReconciler', () => {
  describe('single-flight', () => {
    it('coalesces 5 concurrent reconcile() calls into 1 probe call', async () => {
      let resolveProbe: ((value: CloudHealthProbeResult) => void) | undefined;
      const { reconciler, probeFn } = createHarness({
        probeImpl: () =>
          new Promise<CloudHealthProbeResult>((resolve) => {
            resolveProbe = resolve;
          }),
      });

      const promises = Array.from({ length: 5 }, () => reconciler.reconcile({ writer: 'startup-health' }));

      expect(new Set(promises).size).toBe(1);
      expect(probeFn).toHaveBeenCalledTimes(1);

      resolveProbe?.({ ok: true, status: 200 });
      const outcomes = await Promise.all(promises);

      expect(outcomes.every((outcome) => outcome.result === 'success')).toBe(true);
      expect(probeFn).toHaveBeenCalledTimes(1);
    });

    it('lets a new reconcile() proceed after a prior one settles', async () => {
      const { reconciler, probeFn } = createHarness();

      await reconciler.reconcile({ writer: 'startup-health' });
      await reconciler.reconcile({ writer: 'manual-refresh' });

      expect(probeFn).toHaveBeenCalledTimes(2);
    });
  });

  describe('read-latest-merge', () => {
    it('re-reads latest cloudInstance before each write (no stale-snapshot clobber)', async () => {
      const { reconciler, settings } = createHarness({
        initialCloudInstance: cloudInstance({ provisionedAt: 1 }),
        probeImpl: async () => {
          const latest = currentCloudInstance(settings);
          settings.setCloudInstance({
            ...latest,
            provisionedAt: 999,
            providerMetadata: { survived: 'yes' },
          });
          return { ok: true, status: 200 };
        },
      });

      await reconciler.reconcile({ writer: 'startup-health' });

      expect(currentCloudInstance(settings).provisionedAt).toBe(999);
      expect(currentCloudInstance(settings).providerMetadata).toEqual({ survived: 'yes' });
    });

    it('skips the post-probe write when cloudInstance is deprovisioned during an in-flight reconcile', async () => {
      let resolveProbe: ((value: CloudHealthProbeResult) => void) | undefined;
      const { reconciler, settings, broadcastService, cooldown } = createHarness({
        initialCloudInstance: cloudInstance({ lastKnownStatus: 'error', lastSyncedAt: 123 }),
        probeImpl: () =>
          new Promise<CloudHealthProbeResult>((resolve) => {
            resolveProbe = resolve;
          }),
      });

      const reconcilePromise = reconciler.reconcile({ writer: 'manual-refresh' });
      settings.setCloudInstance({ mode: 'local' });
      resolveProbe?.({ ok: true, status: 200 });
      await reconcilePromise;

      expect(settings.read()).toEqual({ mode: 'local' });
      expect(cooldown.recordSuccess).not.toHaveBeenCalled();
      expect(broadcastService.sendToAllWindows).not.toHaveBeenCalled();
    });

    describe.each([
      ['pre-migration', cloudInstance({ provisionedAt: 10 })],
      ['partial new schema', cloudInstance({ provisionedAt: 20, errorCategory: networkFetchFailed })],
      [
        'full new schema',
        cloudInstance({
          provisionedAt: 30,
          errorCategory: networkFetchFailed,
          degradedSince: 40,
          lastWriter: 'manual-refresh',
        }),
      ],
    ] as const)('multi-state surrogate: %s', (_label, initialCloudInstance) => {
      it('preserves additive fields not owned by the reconciler when merging (e.g. provisionedAt)', async () => {
        const { reconciler, settings } = createHarness({ initialCloudInstance });

        await reconciler.reportSuccess({ writer: 'router-success' });

        expect(currentCloudInstance(settings).provisionedAt).toBe(initialCloudInstance.provisionedAt);
        expect(currentCloudInstance(settings).mode).toBe(initialCloudInstance.mode);
        expect(currentCloudInstance(settings).cloudUrl).toBe(initialCloudInstance.cloudUrl);
        expect(currentCloudInstance(settings).cloudToken).toBe(initialCloudInstance.cloudToken);
      });
    });
  });

  describe('asymmetric lastSyncedAt', () => {
    it('updates lastSyncedAt on success', async () => {
      vi.useFakeTimers();
      vi.setSystemTime(1_700_000_000_000);
      const { reconciler, settings } = createHarness({
        initialCloudInstance: cloudInstance({ lastSyncedAt: 123 }),
      });

      await reconciler.reconcile({ writer: 'manual-refresh' });

      expect(currentCloudInstance(settings).lastSyncedAt).toBe(1_700_000_000_000);
    });

    it('leaves lastSyncedAt unchanged on failure', async () => {
      vi.useFakeTimers();
      vi.setSystemTime(1_700_000_000_000);
      const { reconciler, settings } = createHarness({
        initialCloudInstance: cloudInstance({ lastSyncedAt: 123 }),
        probeImpl: async () => {
          throw new TypeError('fetch failed');
        },
      });

      await reconciler.reconcile({ writer: 'startup-health' });

      expect(currentCloudInstance(settings).lastSyncedAt).toBe(123);
    });
  });

  describe('auto-clear on success', () => {
    it('clears lastError, errorCategory, degradedSince when transitioning failure → success', async () => {
      const { reconciler, settings } = createHarness({
        initialCloudInstance: cloudInstance({
          lastKnownStatus: 'error',
          lastError: 'fetch failed',
          errorCategory: networkFetchFailed,
          degradedSince: 111,
        }),
      });

      await reconciler.reconcile({ writer: 'manual-refresh' });

      expect(currentCloudInstance(settings).lastError).toBeUndefined();
      expect(currentCloudInstance(settings).errorCategory).toBeUndefined();
      expect(currentCloudInstance(settings).degradedSince).toBeUndefined();
    });

    it('sets lastKnownStatus to running on success', async () => {
      const { reconciler, settings } = createHarness({
        initialCloudInstance: cloudInstance({ lastKnownStatus: 'error' }),
      });

      await reconciler.reconcile({ writer: 'manual-refresh' });

      expect(currentCloudInstance(settings).lastKnownStatus).toBe('running');
    });
  });

  describe('failure write', () => {
    it('writes errorCategory + lastError + lastKnownStatus=error on undici TypeError("fetch failed")', async () => {
      const { reconciler, settings } = createHarness({
        probeImpl: async () => {
          throw new TypeError('fetch failed');
        },
      });

      await reconciler.reconcile({ writer: 'startup-health' });

      expect(currentCloudInstance(settings).errorCategory).toEqual(networkFetchFailed);
      expect(currentCloudInstance(settings).lastError).toContain("Cloud instance isn't responding");
      expect(currentCloudInstance(settings).lastKnownStatus).toBe('error');
    });

    it('writes lastWriter for triage', async () => {
      const { reconciler, settings } = createHarness({
        probeImpl: async () => {
          throw new TypeError('fetch failed');
        },
      });

      await reconciler.reconcile({ writer: 'managed-status' });

      expect(currentCloudInstance(settings).lastWriter).toBe('managed-status');
    });

    it('categorizes a 2xx health response with non-ok body as reported_unhealthy', async () => {
      const { reconciler, settings } = createHarness({
        probeImpl: async () => ({ ok: false, status: 200, raw: { status: 'degraded' } }),
      });

      await reconciler.reconcile({ writer: 'startup-health' });

      expect(currentCloudInstance(settings).errorCategory).toEqual({
        kind: 'cloud_down',
        subkind: 'reported_unhealthy',
      });
      expect(currentCloudInstance(settings).lastError).toContain('reported itself as unhealthy');
    });

    it('logs novel error shapes that fall back to the unknown category', async () => {
      const { reconciler, settings, logger } = createHarness({
        probeImpl: async () => {
          throw new Error('Something unusual happened');
        },
      });

      await reconciler.reconcile({ writer: 'startup-health' });

      expect(currentCloudInstance(settings).errorCategory).toEqual({
        kind: 'unknown',
        rawMessage: 'Something unusual happened',
      });
      expect(logger.info).toHaveBeenCalledWith(
        expect.objectContaining({
          rawMessage: 'Something unusual happened',
          errName: 'Error',
        }),
        expect.stringContaining('novel error shape'),
      );
    });
  });

  describe('cooldown integration', () => {
    it('records failed reconcile outcomes with writer and category', async () => {
      const { reconciler, cooldown } = createHarness({
        probeImpl: async () => {
          throw new TypeError('fetch failed');
        },
      });

      await reconciler.reconcile({ writer: 'startup-health' });

      expect(cooldown.recordFailure).toHaveBeenCalledWith({
        writer: 'startup-health',
        category: networkFetchFailed,
      });
      expect(cooldown.recordSuccess).not.toHaveBeenCalled();
    });

    it('records successful outcomes with writer and prior category', async () => {
      const { reconciler, cooldown } = createHarness({
        initialCloudInstance: cloudInstance({
          lastKnownStatus: 'error',
          errorCategory: networkFetchFailed,
        }),
      });

      await reconciler.reportSuccess({ writer: 'focus' });

      expect(cooldown.recordSuccess).toHaveBeenCalledWith({
        writer: 'focus',
        lastCategory: networkFetchFailed,
      });
      expect(cooldown.recordFailure).not.toHaveBeenCalled();
    });
  });

  describe('broadcast-on-transition', () => {
    it('emits cloud:status-changed when lastKnownStatus changes', async () => {
      const { reconciler, broadcastService } = createHarness({
        initialCloudInstance: cloudInstance({ lastKnownStatus: 'cold' }),
      });

      await reconciler.reconcile({ writer: 'manual-refresh' });

      expect(broadcastService.sendToAllWindows).toHaveBeenCalledWith(
        'cloud:status-changed',
        expect.objectContaining({ lastKnownStatus: 'running', lastWriter: 'manual-refresh' }),
      );
    });

    it('emits cloud:status-changed when errorCategory.kind changes (e.g. network → auth)', async () => {
      const { reconciler, broadcastService, settings } = createHarness({
        initialCloudInstance: cloudInstance({
          lastKnownStatus: 'error',
          errorCategory: networkFetchFailed,
          lastError: 'fetch failed',
        }),
        probeImpl: async () => ({ ok: false, status: 401 }),
      });

      await reconciler.reconcile({ writer: 'managed-status' });

      expect(currentCloudInstance(settings).errorCategory).toEqual(authUnauthorized);
      expect(broadcastService.sendToAllWindows).toHaveBeenCalledWith(
        'cloud:status-changed',
        expect.objectContaining({ errorCategory: authUnauthorized }),
      );
    });

    it('does NOT broadcast when status reconciled twice with no change', async () => {
      const { reconciler, broadcastService } = createHarness({
        initialCloudInstance: cloudInstance({
          lastKnownStatus: 'error',
          errorCategory: networkFetchFailed,
          lastError: 'fetch failed',
        }),
      });

      await reconciler.reportSuccess({ writer: 'router-success' });
      await reconciler.reportSuccess({ writer: 'router-success' });

      expect(broadcastService.sendToAllWindows).toHaveBeenCalledTimes(1);
    });
  });

  describe('reportSuccess fast-path', () => {
    it('writes a success outcome without calling probe', async () => {
      const { reconciler, probeFn, settings } = createHarness({
        initialCloudInstance: cloudInstance({ lastKnownStatus: 'error' }),
      });

      await reconciler.reportSuccess({ writer: 'post-drain' });

      expect(probeFn).not.toHaveBeenCalled();
      expect(currentCloudInstance(settings).lastKnownStatus).toBe('running');
      expect(currentCloudInstance(settings).lastWriter).toBe('post-drain');
    });

    it('still triggers broadcast on transition from error → running', async () => {
      const { reconciler, broadcastService } = createHarness({
        initialCloudInstance: cloudInstance({ lastKnownStatus: 'error' }),
      });

      await reconciler.reportSuccess({ writer: 'post-drain' });

      expect(broadcastService.sendToAllWindows).toHaveBeenCalledWith(
        'cloud:status-changed',
        expect.objectContaining({ lastKnownStatus: 'running', lastWriter: 'post-drain' }),
      );
    });

    it('waits for an in-flight failing reconcile before writing success so failure cannot clobber it', async () => {
      let resolveProbe: ((value: CloudHealthProbeResult) => void) | undefined;
      const { reconciler, settings } = createHarness({
        initialCloudInstance: cloudInstance({ lastKnownStatus: 'running' }),
        probeImpl: () =>
          new Promise<CloudHealthProbeResult>((resolve) => {
            resolveProbe = resolve;
          }),
      });

      const reconcilePromise = reconciler.reconcile({ writer: 'startup-health' });
      const reportSuccessPromise = reconciler.reportSuccess({ writer: 'router-success' });

      resolveProbe?.({ ok: false, status: 503 });
      await reconcilePromise;
      await reportSuccessPromise;

      expect(currentCloudInstance(settings).lastKnownStatus).toBe('running');
      expect(currentCloudInstance(settings).lastError).toBeUndefined();
      expect(currentCloudInstance(settings).lastWriter).toBe('router-success');
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // Stage D: pressure observation persistence + broadcast
  // ─────────────────────────────────────────────────────────────────────────────

  describe('pressure observation', () => {
    describe('persistence via reconcile()', () => {
      it('writes lastPressureState + lastPressureCheckedAt when probe returns pressure', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(1_700_000_000_000);
        const { reconciler, settings } = createHarness({
          probeImpl: async () => ({
            ok: true,
            status: 200,
            pressure: { state: 'warning', oomRecent: false, recentRestart: true },
          }),
        });

        await reconciler.reconcile({ writer: 'startup-health' });

        const inst = currentCloudInstance(settings);
        expect(inst.lastPressureState).toBe('warning');
        expect(inst.lastPressureCheckedAt).toBe(1_700_000_000_000);
      });

      it('appends a pressure event to recentPressureEvents', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(1_700_000_005_000);
        const { reconciler, settings } = createHarness({
          probeImpl: async () => ({
            ok: true,
            status: 200,
            pressure: { state: 'critical', oomRecent: true, recentRestart: true },
          }),
        });

        await reconciler.reconcile({ writer: 'startup-health' });

        const events = currentCloudInstance(settings).recentPressureEvents ?? [];
        expect(events).toHaveLength(1);
        expect(events[0]).toEqual({
          state: 'critical',
          at: 1_700_000_005_000,
          oom: true,
          recentRestart: true,
        });
      });

      it('accumulates events across multiple reconcile() calls', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(1_000);
        const { reconciler, settings } = createHarness({
          probeImpl: async () => ({
            ok: true,
            status: 200,
            pressure: { state: 'ok', oomRecent: false, recentRestart: false },
          }),
        });

        await reconciler.reconcile({ writer: 'startup-health' });
        vi.setSystemTime(2_000);
        await reconciler.reconcile({ writer: 'manual-refresh' });

        const events = currentCloudInstance(settings).recentPressureEvents ?? [];
        expect(events).toHaveLength(2);
        expect(events[0].at).toBe(1_000);
        expect(events[1].at).toBe(2_000);
      });

      it('does NOT write pressure fields when probe returns no pressure', async () => {
        const { reconciler, settings } = createHarness({
          initialCloudInstance: cloudInstance({ lastPressureState: 'ok', lastPressureCheckedAt: 999 }),
          probeImpl: async () => ({ ok: true, status: 200 }),
        });

        await reconciler.reconcile({ writer: 'startup-health' });

        // Pre-existing pressure fields must remain unchanged (no-op when pressure absent)
        expect(currentCloudInstance(settings).lastPressureState).toBe('ok');
        expect(currentCloudInstance(settings).lastPressureCheckedAt).toBe(999);
      });
    });

    describe('persistence via reportSuccess()', () => {
      it('persists pressure observation supplied to reportSuccess()', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(1_700_000_010_000);
        const { reconciler, settings } = createHarness();

        await reconciler.reportSuccess({
          writer: 'router-success',
          pressureObservation: { state: 'warning', oomRecent: false, recentRestart: false },
        });

        const inst = currentCloudInstance(settings);
        expect(inst.lastPressureState).toBe('warning');
        expect(inst.lastPressureCheckedAt).toBe(1_700_000_010_000);
        expect(inst.recentPressureEvents).toHaveLength(1);
        expect(inst.recentPressureEvents![0].state).toBe('warning');
      });

      it('persists pressure observation supplied to reportFailure()', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(1_700_000_020_000);
        const { reconciler, settings } = createHarness();

        await reconciler.reportFailure({
          writer: 'auto-refresh',
          rawError: new TypeError('fetch failed'),
          pressureObservation: { state: 'critical', oomRecent: true, recentRestart: false },
        });

        const inst = currentCloudInstance(settings);
        expect(inst.lastPressureState).toBe('critical');
        expect(inst.recentPressureEvents).toHaveLength(1);
        expect(inst.recentPressureEvents![0].oom).toBe(true);
      });
    });

    describe('sliding-window pruning', () => {
      it('prunes events older than 7 days', async () => {
        const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;
        vi.useFakeTimers();

        // Seed the store with an event at t=0 (>7 days old relative to "now")
        const oldEventAt = 1_000;
        const { reconciler, settings } = createHarness({
          initialCloudInstance: cloudInstance({
            recentPressureEvents: [{ state: 'ok', at: oldEventAt, oom: false, recentRestart: false }],
          }),
          probeImpl: async () => ({
            ok: true,
            status: 200,
            pressure: { state: 'ok', oomRecent: false, recentRestart: false },
          }),
        });

        vi.setSystemTime(oldEventAt + SEVEN_DAYS_MS + 1);
        await reconciler.reconcile({ writer: 'startup-health' });

        const events = currentCloudInstance(settings).recentPressureEvents ?? [];
        // Only the new event should survive; the old one is pruned
        expect(events).toHaveLength(1);
        expect(events[0].at).toBe(oldEventAt + SEVEN_DAYS_MS + 1);
      });

      it('caps recentPressureEvents at 50 entries', async () => {
        vi.useFakeTimers();
        const now = Date.now();

        // Pre-seed 50 events (all recent enough to survive age pruning)
        const existingEvents = Array.from({ length: 50 }, (_, i) => ({
          state: 'ok' as const,
          at: now - (50 - i) * 1_000,
          oom: false,
          recentRestart: false,
        }));

        const { reconciler, settings } = createHarness({
          initialCloudInstance: cloudInstance({ recentPressureEvents: existingEvents }),
          probeImpl: async () => ({
            ok: true,
            status: 200,
            pressure: { state: 'warning', oomRecent: false, recentRestart: false },
          }),
        });

        vi.setSystemTime(now + 1_000);
        await reconciler.reconcile({ writer: 'startup-health' });

        const events = currentCloudInstance(settings).recentPressureEvents ?? [];
        expect(events).toHaveLength(50);
        // The newest event (warning) should be last; the oldest ok event dropped
        expect(events[events.length - 1].state).toBe('warning');
      });
    });

    describe('broadcast on pressure state transition', () => {
      it('emits cloud:pressure-state when lastPressureState changes', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(1_700_000_030_000);
        const { reconciler, broadcastService } = createHarness({
          initialCloudInstance: cloudInstance({ lastPressureState: 'ok' }),
          probeImpl: async () => ({
            ok: true,
            status: 200,
            pressure: { state: 'warning', oomRecent: false, recentRestart: false },
          }),
        });

        await reconciler.reconcile({ writer: 'startup-health' });

        expect(broadcastService.sendToAllWindows).toHaveBeenCalledWith(
          'cloud:pressure-state',
          expect.objectContaining({ state: 'warning', timestamp: 1_700_000_030_000 }),
        );
      });

      it('does NOT emit cloud:pressure-state when pressure state is unchanged', async () => {
        const { reconciler, broadcastService } = createHarness({
          initialCloudInstance: cloudInstance({ lastPressureState: 'warning' }),
          probeImpl: async () => ({
            ok: true,
            status: 200,
            pressure: { state: 'warning', oomRecent: false, recentRestart: false },
          }),
        });

        await reconciler.reconcile({ writer: 'startup-health' });

        const pressureCalls = (broadcastService.sendToAllWindows as ReturnType<typeof vi.fn>).mock.calls
          .filter((call) => call[0] === 'cloud:pressure-state');
        expect(pressureCalls).toHaveLength(0);
      });

      it('includes recentPressureEvents in cloud:pressure-state payload', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(1_700_000_040_000);
        const { reconciler, broadcastService } = createHarness({
          initialCloudInstance: cloudInstance({ lastPressureState: 'ok' }),
          probeImpl: async () => ({
            ok: true,
            status: 200,
            pressure: { state: 'critical', oomRecent: true, recentRestart: false },
          }),
        });

        await reconciler.reconcile({ writer: 'startup-health' });

        const pressureCall = (broadcastService.sendToAllWindows as ReturnType<typeof vi.fn>).mock.calls
          .find((call) => call[0] === 'cloud:pressure-state');
        expect(pressureCall).toBeDefined();
        const payload = pressureCall![1] as { recentPressureEvents: unknown[] };
        expect(Array.isArray(payload.recentPressureEvents)).toBe(true);
        expect(payload.recentPressureEvents).toHaveLength(1);
      });

      it('does NOT emit cloud:pressure-state when probe returns no pressure at all', async () => {
        const { reconciler, broadcastService } = createHarness({
          initialCloudInstance: cloudInstance({ lastPressureState: 'ok' }),
          probeImpl: async () => ({ ok: true, status: 200 }),
        });

        await reconciler.reconcile({ writer: 'startup-health' });

        const pressureCalls = (broadcastService.sendToAllWindows as ReturnType<typeof vi.fn>).mock.calls
          .filter((call) => call[0] === 'cloud:pressure-state');
        expect(pressureCalls).toHaveLength(0);
      });
    });

    describe('pressure-write-no-race', () => {
      it('interleaved reportSuccess(+pressure) after a failing in-flight reconcile does not clobber lastKnownStatus', async () => {
        // Scenario: reconcile() probe returns a failure, then reportSuccess({pressureObservation})
        // fires (e.g. from the router layer). The final lastKnownStatus must be 'running' (from
        // reportSuccess), not 'error' (from the earlier probe failure).
        let resolveProbe: ((value: CloudHealthProbeResult) => void) | undefined;
        const { reconciler, settings } = createHarness({
          initialCloudInstance: cloudInstance({ lastKnownStatus: 'running', lastPressureState: 'ok' }),
          probeImpl: () =>
            new Promise<CloudHealthProbeResult>((resolve) => {
              resolveProbe = resolve;
            }),
        });

        const reconcilePromise = reconciler.reconcile({ writer: 'startup-health' });
        // reportSuccess waits for the in-flight reconcile before writing
        const reportSuccessPromise = reconciler.reportSuccess({
          writer: 'router-success',
          pressureObservation: { state: 'warning', oomRecent: false, recentRestart: false },
        });

        // Settle the probe with a failure
        resolveProbe?.({ ok: false, status: 503 });
        await reconcilePromise;
        await reportSuccessPromise;

        const inst = currentCloudInstance(settings);
        // reportSuccess must win: status=running, error cleared
        expect(inst.lastKnownStatus).toBe('running');
        expect(inst.lastError).toBeUndefined();
        expect(inst.lastWriter).toBe('router-success');
        // Pressure from reportSuccess must also be persisted
        expect(inst.lastPressureState).toBe('warning');
      });

      it('pressure from probe is persisted independently of status when probe returns non-ok + pressure', async () => {
        const { reconciler, settings } = createHarness({
          initialCloudInstance: cloudInstance({ lastKnownStatus: 'running', lastPressureState: 'ok' }),
          probeImpl: async () => ({
            ok: false,
            status: 503,
            pressure: { state: 'critical', oomRecent: true, recentRestart: false },
          }),
        });

        await reconciler.reconcile({ writer: 'startup-health' });

        const inst = currentCloudInstance(settings);
        // Status must be error (probe returned non-ok)
        expect(inst.lastKnownStatus).toBe('error');
        // But pressure must still be captured
        expect(inst.lastPressureState).toBe('critical');
        expect(inst.recentPressureEvents).toHaveLength(1);
        expect(inst.recentPressureEvents![0].oom).toBe(true);
      });
    });
  });
});
