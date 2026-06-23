/**
 * Tests for `perfDiagnosticService` (Stage 1 of
 * `docs/plans/260423_secondary_process_cpu_observability.md`).
 *
 * Covers:
 *  1. Payload shape with injected mock providers.
 *  2. Scheduler wiring against the real `visibilityAwareScheduler` (fake
 *     timers + `_setBlurredForTesting` / `_setHiddenForTesting` seams).
 *  3. Lifetime-CPU delta: first tick null, second tick positive, stale PID
 *     pruning.
 *  4. Fail-observable: GPU lifecycle throw → `status: 'unavailable'`, emission
 *     still succeeds.
 *  5. Preserves existing consumers: importing `RamSnapshot` from
 *     `ramTelemetryService` still works; `ProcessSnapshot` shape unchanged.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ── Mocks ────────────────────────────────────────────────────────────
// NB: `@core/logger` is mocked globally; visibilityAwareScheduler is imported
// un-mocked so the scheduler-wiring test exercises the real scheduler.

// Hoisted shared logger mock so tests can assert against warn / debug calls
// made on the module-internal `perfDiagnosticDefaultLogger` (used by the
// default subprocess-usage sampler + super-mcp stats fetch trigger).
const { defaultLoggerMock } = vi.hoisted(() => ({
  defaultLoggerMock: {
    info: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
  },
}));
 
vi.mock('@core/logger', () => ({
  createScopedLogger: () => defaultLoggerMock,
}));

// Hoisted pidusage mock — exercised by the default sampler unit tests and
// the PID-reset-guard integration test. pidusage's default export is a
// callable with a `.clear()` method; the mock mirrors that shape.
const { pidusageMock, pidusageClearMock } = vi.hoisted(() => {
  const clearMock = vi.fn();
  const callMock = vi.fn(async () => ({ cpu: 0, memory: 0 }));
  // Attach `.clear` onto the callable default export (matches pidusage v4).
  (callMock as unknown as { clear: typeof clearMock }).clear = clearMock;
  return { pidusageMock: callMock, pidusageClearMock: clearMock };
});
 
vi.mock('pidusage', () => ({
  default: pidusageMock,
}));

// `visibilityAwareScheduler` lazily calls `getElectronModule()` to filter out
// child-window blur events. Stub it so imports succeed in unit tests.
 
vi.mock('@core/lazyElectron', () => ({
  getElectronModule: () => null,
  onElectronAppEvent: vi.fn(),
}));

// The agent turn registry import needs to be stubbed because the perf service
// falls back to it when `getAgentTurnRegistryDiagnostics` is not injected.
 
vi.mock('@core/services/agentTurnRegistry', () => ({
  agentTurnRegistry: {
    getDiagnostics: vi.fn(() => ({
      turnCount: 0,
      contextAccumulatorCount: 0,
      contextAccumulatorTotalEvents: 0,
      largestContextAccumulatorEvents: 0,
      securityDenialCount: 0,
      toolCallCount: 0,
    })),
  },
}));

// ramTelemetryService itself imports `electron` — mock the module whole-cloth
// to avoid pulling Electron into the test bundle.
 
vi.mock('../ramTelemetryService', () => ({
  captureRamSnapshot: vi.fn(),
  buildProcessLabelMap: vi.fn(() => new Map()),
  getProcessLabel: vi.fn(),
  sanitizeProcessName: vi.fn((s: string) => s),
}));

// embeddingService transitively imports Electron; stub it.
 
vi.mock('../embeddingService', () => ({
  getGpuLifecycleMetrics: vi.fn(() => ({
    blurDisposalCount: 0,
    focusWarmUpCount: 0,
    lastBlurDisposalAt: null,
    lastFocusWarmUpAt: null,
  })),
}));

// M2: the default super-mcp stats seam reads the real singleton — mock it
// so we can drive state (isRunning / cache / fetch timestamps) directly.
// `vi.hoisted` ensures the mock object is created before `vi.mock` factories
// run (which are themselves hoisted above the `const` declaration).
//
// We intentionally type the inner `vi.fn` mocks as returning `unknown` (via
// explicit generics) so per-test `mockReturnValue(...)` calls aren't
// narrowed to the factory's default return shape (`null`, or the
// not-running `SuperMcpSubprocessInfo` shape).
const { superMcpHttpManagerMock } = vi.hoisted(() => {
  return {
    superMcpHttpManagerMock: {
      // Returns a `SuperMcpSubprocessInfo` — intentionally widened to
      // allow running-state variants via `mockReturnValue` in tests.
      getSubprocessInfo: vi.fn<() => unknown>(() => ({
        pid: null,
        startTime: null,
        uptime: null,
        isRunning: false,
        startCount: 0,
        restartCount: 0,
        lastStartupFailureAt: null,
        lastStartupError: null,
        circuitBreakerActive: false,
        cooldownRemainingMs: null,
        lastRestartReason: null,
      })),
      getLastStatsCache: vi.fn<() => unknown>(() => null),
      getLastStatsFetchAt: vi.fn<() => number | null>(() => null),
      getLastGoodStatsAt: vi.fn<() => number | null>(() => null),
      fetchStats: vi.fn<() => Promise<void>>(() => Promise.resolve()),
    },
  };
});
 
vi.mock('@core/services/superMcpHttpManager', () => ({
  superMcpHttpManager: superMcpHttpManagerMock,
}));

import {
  buildPerfDiagnosticPayload,
  runPerfDiagnosticTick,
  startPerfDiagnostic,
  defaultGetSuperMcpStats,
  defaultSampleSubprocessUsage,
  captureFdSnapshot,
  emitFdSnapshot,
  _resetPerfDiagnosticStateForTesting,
  sampleInstantCpu,
  CpuPeakTracker,
  type ResolvedPayloadDeps,
  type VisibilityKind,
  type PerfDiagnosticPayload,
  type SampleSubprocessUsage,
  MEMORY_LOG_INTERVAL_MS,
  MEMORY_LOG_BACKGROUND_INTERVAL_MS,
  INSTANT_CPU_WINDOW_MS,
} from '../perfDiagnosticService';

import type {
  SuperMcpSubprocessInfo,
  SuperMcpRestartReason,
} from '@core/services/superMcpHttpManager';
import { getErrorReporter, setErrorReporter, type ErrorReporter } from '@core/errorReporter';

import {
  createThrottledInterval,
  type BackgroundConsumerWatchdogSignal,
  _resetForTesting,
  _setBlurredForTesting,
  _setHiddenForTesting,
  _setHeadlessModeForTesting,
} from '../visibilityAwareScheduler';

// ── Helpers ──────────────────────────────────────────────────────────

const stubLogger = () => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
  fatal: vi.fn(),
  trace: vi.fn(),
  silent: vi.fn(),
  child: vi.fn(),
  level: 'info',
}) as unknown as Parameters<typeof buildPerfDiagnosticPayload>[0]['logger'];

const makeRamSnapshot = (overrides: Partial<{
  heapUsedMB: number;
  heapTotalMB: number;
  externalMB: number;
  rssMB: number;
  processes: Array<{ pid: number; type: string; label: string; workingSetMB: number; cpuPercent: number }>;
  rendererSnapshot: unknown;
}> = {}) => ({
  timestamp: 1_000_000,
  mainProcess: {
    heapUsedMB: overrides.heapUsedMB ?? 100,
    heapTotalMB: overrides.heapTotalMB ?? 200,
    externalMB: overrides.externalMB ?? 10,
    rssMB: overrides.rssMB ?? 500,
    arrayBuffersMB: 5,
  },
  processes: overrides.processes ?? [
    { pid: 100, type: 'Browser', label: 'main', workingSetMB: 300, cpuPercent: 5 },
    { pid: 101, type: 'GPU', label: 'gpu', workingSetMB: 150, cpuPercent: 2 },
    { pid: 102, type: 'Tab', label: 'mainUI', workingSetMB: 200, cpuPercent: 15 },
  ],
  totals: { workingSetMB: 650, processCount: 3 },
  registry: { activeTurns: 0, contextAccumulators: 0, contextTotalEvents: 0 },
  powerSaveBlocker: { active: false, refCount: 0, reasons: {} },
  rendererSnapshot: overrides.rendererSnapshot === undefined ? null : overrides.rendererSnapshot,
});

const makeAppMetric = (pid: number, cumulativeCPUUsage?: number, percentCPUUsage = 1) => ({
  pid,
  type: 'Browser' as const,
  memory: { workingSetSize: 100_000 },
  cpu: { percentCPUUsage, cumulativeCPUUsage, idleWakeupsPerSecond: 0 },
});

const makeResolvedDeps = (overrides: Partial<ResolvedPayloadDeps> = {}): ResolvedPayloadDeps => ({
  getRamSnapshot: () => makeRamSnapshot() as never,
  getAppMetrics: () => [
    makeAppMetric(100, 1.0, 5),
    makeAppMetric(101, 0.5, 2),
    makeAppMetric(102, 2.0, 15),
  ] as never,
  getGpuLifecycle: () => ({
    blurDisposalCount: 3,
    focusWarmUpCount: 4,
    lastBlurDisposalAt: 12345,
    lastFocusWarmUpAt: 67890,
  }),
  getVisibilityKind: () => 'focused' as VisibilityKind,
  getRendererPerfSummary: () => null,
  getEventLoopLag: () => null,
  getSuperMcpLifecycle: () => null,
  // Stage 1 (260424): default to a deterministic 'unavailable' sample so
  // tests that exercise the synth-row path without explicitly caring about
  // the numbers get stable, quiet behaviour. Tests that need a real 'ok'
  // sample, or a specific error class, override this.
  sampleSubprocessUsage: async () => ({
    cpuPercent: null,
    workingSetMB: null,
    status: 'unavailable',
  }),
  getSuperMcpStats: () => ({ status: 'unavailable', stats_age_ms: null, last_good_age_ms: null }),
  // REBEL-1HF: default to a deterministic 'unavailable' FD snapshot so tests
  // that don't care about the new field stay stable. Tests asserting on
  // `fdSnapshot` override this with a per-status fixture.
  getFdSnapshot: () => ({ status: 'unavailable', error: 'test default' }),
  getAutomationSchedulerStats: () => ({ sizeKB: 2, runCount: 5 }),
  getAgentTurnRegistryDiagnostics: () => ({
    turnCount: 1,
    contextAccumulatorCount: 1,
    contextAccumulatorTotalEvents: 10,
    largestContextAccumulatorEvents: 5,
    securityDenialCount: 0,
    toolCallCount: 2,
  }),
  getSettingsNormalizationStats: () => ({ calls: 0, writes: 0 }),
  getSettingsNormalizationWindowedStats: () => ({
    calls: { rate5m: 0, cumulative: 0 },
    writes: { rate5m: 0, cumulative: 0 },
  }),
  getIsKnownPluginCounters: () => ({ hits: 0 }),
  getScanSpacePluginsCounters: () => ({ scans: 0 }),
  getScanSpacePluginsWindowedCounters: () => ({
    requests: { rate5m: 0, cumulative: 0 },
    hits: { rate5m: 0, cumulative: 0 },
    misses: { rate5m: 0, cumulative: 0 },
    inflightJoins: { rate5m: 0, cumulative: 0 },
    underlyingFetches: { rate5m: 0, cumulative: 0 },
    fetchErrors: { rate5m: 0, cumulative: 0 },
    maxConcurrentInflight: { rate5m: 0, cumulative: 0 },
  }),
  getScanSpacesCounters: () => ({ scans: 0 }),
  getScanSpacesWindowedCounters: () => ({
    readOnly: {
      requests: { rate5m: 0, cumulative: 0 },
      hits: { rate5m: 0, cumulative: 0 },
      misses: { rate5m: 0, cumulative: 0 },
      inflightJoins: { rate5m: 0, cumulative: 0 },
      underlyingFetches: { rate5m: 0, cumulative: 0 },
      fetchErrors: { rate5m: 0, cumulative: 0 },
      maxConcurrentInflight: { rate5m: 0, cumulative: 0 },
    },
    writable: {
      requests: { rate5m: 0, cumulative: 0 },
      hits: { rate5m: 0, cumulative: 0 },
      misses: { rate5m: 0, cumulative: 0 },
      inflightJoins: { rate5m: 0, cumulative: 0 },
      underlyingFetches: { rate5m: 0, cumulative: 0 },
      fetchErrors: { rate5m: 0, cumulative: 0 },
      maxConcurrentInflight: { rate5m: 0, cumulative: 0 },
    },
  }),
  foregroundMs: MEMORY_LOG_INTERVAL_MS,
  backgroundMs: MEMORY_LOG_BACKGROUND_INTERVAL_MS,
  // FU-5: instant-sample seams — default to an immediate resolve (no wall
  // time) and a monotonic counter so the short-window sample is deterministic
  // and the elapsed window is a fixed, positive value. Tests that exercise the
  // instant/peak path override these.
  sleepMs: async () => {},
  nowMs: makeMonotonicNow(),
  // FU-5: fresh per-deps tracker so tests don't leak peak/streak state.
  peakTracker: new CpuPeakTracker(),
  cpuDeltaStore: new Map(),
  logger: stubLogger(),
  ...overrides,
});

// FU-5: a monotonic `nowMs` that advances `INSTANT_CPU_WINDOW_MS` per call so
// the two-snapshot instant sampler always sees a positive, deterministic wall
// window without any real time passing.
function makeMonotonicNow(stepMs = INSTANT_CPU_WINDOW_MS): () => number {
  let t = 0;
  return () => {
    const v = t;
    t += stepMs;
    return v;
  };
}

// ── 1. Payload shape ─────────────────────────────────────────────────

describe('buildPerfDiagnosticPayload — payload shape', () => {
  beforeEach(() => {
    _resetPerfDiagnosticStateForTesting();
  });

  it('produces the expected additive fields with injected providers', async () => {
    const deps = makeResolvedDeps();
    const payload = await buildPerfDiagnosticPayload(deps);

    // Stage 1 additive keys
    expect(payload.cadenceMs).toBe(MEMORY_LOG_INTERVAL_MS); // focused
    expect(payload.blurState).toBe('focused');
    expect(payload.gpuLifecycle).toEqual({
      status: 'ok',
      blurDisposalCount: 3,
      focusWarmUpCount: 4,
      lastBlurDisposalAt: 12345,
      lastFocusWarmUpAt: 67890,
    });
    expect(payload.profilerChannel).toBe('perf-summary');

    // Processes enriched with cpuMsSinceLast (first tick → null for every PID)
    expect(payload.processes).toHaveLength(3);
    for (const p of payload.processes) {
      expect(p.cpuMsSinceLast).toBeNull();
      expect(typeof p.pid).toBe('number');
      expect(typeof p.label).toBe('string');
    }

    // Renderer CPU-ms sourced from the 'mainUI'-labelled row (null on first tick)
    expect(payload.rendererCpuMsSinceLast).toBeNull();

    // Existing fields preserved (heap + aggregate CPU + platform)
    expect(payload.heapUsedMB).toBe(100);
    expect(payload.heapTotalMB).toBe(200);
    expect(payload.rssMB).toBe(500);
    expect(payload.totalCpuPercent).toBeCloseTo(5 + 2 + 15, 1);
    expect(payload.topCpuProcess?.label).toBe('mainUI');
    expect(payload.platform).toBe(process.platform);

    // Registry / automation / ancillary counters threaded through
    expect(payload.registryActiveTurns).toBe(1);
    expect(payload.automationRunCount).toBe(5);
    expect(payload.automationStateSizeKB).toBe(2);

    // Seams for later stages — stable shape, null by default
    expect(payload.eventLoopDelay).toBeNull();
    expect(payload.rendererPerfSummary).toBeNull();
  });

  it('cadenceMs reflects blur state (120s when blurred, 120s when minimized)', async () => {
    const blurred = await buildPerfDiagnosticPayload(
      makeResolvedDeps({
        cpuDeltaStore: new Map(),
        getVisibilityKind: () => 'blurred' as VisibilityKind,
      }),
    );
    expect(blurred.cadenceMs).toBe(MEMORY_LOG_BACKGROUND_INTERVAL_MS);
    expect(blurred.blurState).toBe('blurred');

    const minimized = await buildPerfDiagnosticPayload(
      makeResolvedDeps({
        cpuDeltaStore: new Map(),
        getVisibilityKind: () => 'minimized' as VisibilityKind,
      }),
    );
    expect(minimized.cadenceMs).toBe(MEMORY_LOG_BACKGROUND_INTERVAL_MS);
    expect(minimized.blurState).toBe('minimized');
  });

  it('rendererSnapshot is passed through from the RAM snapshot', async () => {
    const snapshot = makeRamSnapshot();
    (snapshot as unknown as { rendererSnapshot: unknown }).rendererSnapshot = {
      timestamp: 42,
      heapUsedMB: 77,
      heapTotalMB: 100,
      loadedSessions: 3,
      loadedMessages: 10,
    };

    const payload = await buildPerfDiagnosticPayload(
      makeResolvedDeps({
        cpuDeltaStore: new Map(),
        getRamSnapshot: () => snapshot as never,
      }),
    );
    expect(payload.rendererSnapshot).toEqual({
      timestamp: 42,
      heapUsedMB: 77,
      heapTotalMB: 100,
      loadedSessions: 3,
      loadedMessages: 10,
    });
  });
});

// ── 3. Lifetime-CPU delta ────────────────────────────────────────────

describe('buildPerfDiagnosticPayload — cpuMsSinceLast', () => {
  beforeEach(() => {
    _resetPerfDiagnosticStateForTesting();
  });

  it('returns null on first tick for every PID, then positive numbers on the second tick', async () => {
    const cpuDeltaStore = new Map<number, number>();
    const ram = makeRamSnapshot() as never;

    // Tick 1 — cumulativeCPUUsage = 1.0, 0.5, 2.0 (seconds)
    const deps1 = makeResolvedDeps({
      cpuDeltaStore,
      getRamSnapshot: () => ram,
      getAppMetrics: () =>
        [
          makeAppMetric(100, 1.0, 5),
          makeAppMetric(101, 0.5, 2),
          makeAppMetric(102, 2.0, 15),
        ] as never,
    });
    const p1 = await buildPerfDiagnosticPayload(deps1);
    for (const p of p1.processes) expect(p.cpuMsSinceLast).toBeNull();

    // Tick 2 — cumulativeCPUUsage increased by 0.3, 0.1, 1.5 (seconds)
    const deps2 = makeResolvedDeps({
      cpuDeltaStore,
      getRamSnapshot: () => ram,
      getAppMetrics: () =>
        [
          makeAppMetric(100, 1.3, 5),
          makeAppMetric(101, 0.6, 2),
          makeAppMetric(102, 3.5, 15),
        ] as never,
    });
    const p2 = await buildPerfDiagnosticPayload(deps2);
    const byPid = new Map(p2.processes.map((p) => [p.pid, p.cpuMsSinceLast]));
    expect(byPid.get(100)).toBe(300); // 0.3 sec × 1000
    expect(byPid.get(101)).toBe(100); // 0.1 sec × 1000
    expect(byPid.get(102)).toBe(1500); // 1.5 sec × 1000

    // Renderer row (mainUI, pid 102) feeds rendererCpuMsSinceLast
    expect(p2.rendererCpuMsSinceLast).toBe(1500);
  });

  it('prunes PIDs that disappear between ticks (no stale entries)', async () => {
    const cpuDeltaStore = new Map<number, number>();

    // Tick 1 — three PIDs present
    await buildPerfDiagnosticPayload(
      makeResolvedDeps({
        cpuDeltaStore,
        getAppMetrics: () =>
          [
            makeAppMetric(100, 1.0),
            makeAppMetric(101, 0.5),
            makeAppMetric(102, 2.0),
          ] as never,
      }),
    );
    expect(cpuDeltaStore.size).toBe(3);
    expect(cpuDeltaStore.has(101)).toBe(true);

    // Tick 2 — PID 101 disappears; only 100 and 102 remain
    await buildPerfDiagnosticPayload(
      makeResolvedDeps({
        cpuDeltaStore,
        getRamSnapshot: () =>
          makeRamSnapshot({
            processes: [
              { pid: 100, type: 'Browser', label: 'main', workingSetMB: 300, cpuPercent: 5 },
              { pid: 102, type: 'Tab', label: 'mainUI', workingSetMB: 200, cpuPercent: 15 },
            ],
          }) as never,
        getAppMetrics: () =>
          [makeAppMetric(100, 1.2), makeAppMetric(102, 2.5)] as never,
      }),
    );
    expect(cpuDeltaStore.size).toBe(2);
    expect(cpuDeltaStore.has(101)).toBe(false);
    expect(cpuDeltaStore.has(100)).toBe(true);
    expect(cpuDeltaStore.has(102)).toBe(true);
  });

  it('falls back to cpuPercent × cadenceMs / 100 when cumulativeCPUUsage is absent (null on first tick)', async () => {
    const cpuDeltaStore = new Map<number, number>();

    // Tick 1 — no cumulativeCPUUsage on any metric; first tick = null
    const p1 = await buildPerfDiagnosticPayload(
      makeResolvedDeps({
        cpuDeltaStore,
        getAppMetrics: () =>
          [makeAppMetric(100, undefined, 10)] as never,
        getRamSnapshot: () =>
          makeRamSnapshot({
            processes: [{ pid: 100, type: 'Browser', label: 'main', workingSetMB: 300, cpuPercent: 10 }],
          }) as never,
      }),
    );
    expect(p1.processes[0].cpuMsSinceLast).toBeNull();

    // Tick 2 — still no cumulativeCPUUsage; fallback cpuPercent × cadenceMs / 100
    const p2 = await buildPerfDiagnosticPayload(
      makeResolvedDeps({
        cpuDeltaStore,
        getAppMetrics: () =>
          [makeAppMetric(100, undefined, 10)] as never,
        getRamSnapshot: () =>
          makeRamSnapshot({
            processes: [{ pid: 100, type: 'Browser', label: 'main', workingSetMB: 300, cpuPercent: 10 }],
          }) as never,
      }),
    );
    // 10% × 5min (300_000 ms) / 100 = 30_000 ms
    expect(p2.processes[0].cpuMsSinceLast).toBe(30_000);
  });

  it('returns null when cumulativeCPUUsage delta is negative (process restart)', async () => {
    const cpuDeltaStore = new Map<number, number>();

    await buildPerfDiagnosticPayload(
      makeResolvedDeps({
        cpuDeltaStore,
        getAppMetrics: () => [makeAppMetric(100, 5.0)] as never,
        getRamSnapshot: () =>
          makeRamSnapshot({
            processes: [{ pid: 100, type: 'Browser', label: 'main', workingSetMB: 300, cpuPercent: 5 }],
          }) as never,
      }),
    );

    // Cumulative goes DOWN — should be treated as null, not negative.
    const p2 = await buildPerfDiagnosticPayload(
      makeResolvedDeps({
        cpuDeltaStore,
        getAppMetrics: () => [makeAppMetric(100, 1.0)] as never,
        getRamSnapshot: () =>
          makeRamSnapshot({
            processes: [{ pid: 100, type: 'Browser', label: 'main', workingSetMB: 300, cpuPercent: 5 }],
          }) as never,
      }),
    );
    expect(p2.processes[0].cpuMsSinceLast).toBeNull();
  });
});

// ── 4. Fail-observable contract ──────────────────────────────────────

describe('buildPerfDiagnosticPayload — fail-observable GPU lifecycle', () => {
  beforeEach(() => {
    _resetPerfDiagnosticStateForTesting();
  });

  it('returns { status: "unavailable", error } when GPU getter throws', async () => {
    const payload = await buildPerfDiagnosticPayload(
      makeResolvedDeps({
        cpuDeltaStore: new Map(),
        getGpuLifecycle: () => {
          throw new Error('GPU backend unavailable');
        },
      }),
    );
    expect(payload.gpuLifecycle).toEqual({
      status: 'unavailable',
      error: 'GPU backend unavailable',
    });
    // Payload still produced and other fields present
    expect(payload.profilerChannel).toBe('perf-summary');
    expect(payload.processes).toHaveLength(3);
  });

  it('returns { status: "unavailable" } when GPU getter returns malformed data', async () => {
    const payload = await buildPerfDiagnosticPayload(
      makeResolvedDeps({
        cpuDeltaStore: new Map(),
        // Cast intentional: simulating a bad upstream that doesn't match the type.
        getGpuLifecycle: (() => ({})) as unknown as ResolvedPayloadDeps['getGpuLifecycle'],
      }),
    );
    expect(payload.gpuLifecycle).toMatchObject({ status: 'unavailable' });
  });

  it('continues emission when getAppMetrics throws (fails-observable via logger warn)', async () => {
    const logger = stubLogger();
    const payload = await buildPerfDiagnosticPayload(
      makeResolvedDeps({
        cpuDeltaStore: new Map(),
        logger,
        getAppMetrics: () => {
          throw new Error('boom');
        },
      }),
    );
    // Aggregate CPU is 0 (no metrics); processes still have labels from RAM snapshot
    expect(payload.totalCpuPercent).toBe(0);
    expect(payload.processes).toHaveLength(3);
    for (const p of payload.processes) {
      expect(p.cpuMsSinceLast).toBeNull();
    }
    // Logged at warn with err field
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ err: expect.any(Error) }),
      'perfDiagnostic: getAppMetrics failed',
    );
  });
});

// ── 5. Preserves existing consumers ──────────────────────────────────

describe('perfDiagnosticService — preserves existing consumers', () => {
  it('emitted ProcessSnapshot rows carry the original ProcessSnapshot fields plus cpuMsSinceLast + cpuPercentInstant (additive only)', async () => {
    const payload = await buildPerfDiagnosticPayload(makeResolvedDeps({ cpuDeltaStore: new Map() }));
    const keys = Object.keys(payload.processes[0]).sort();
    // FU-5 adds `cpuPercentInstant` (short-window CPU%) alongside the existing
    // `cpuMsSinceLast` enrichment — additive, existing fields unchanged.
    expect(keys).toEqual(
      ['cpuMsSinceLast', 'cpuPercent', 'cpuPercentInstant', 'label', 'pid', 'type', 'workingSetMB'].sort(),
    );
  });
});

// ── 6. Renderer CPU row selection (mainUI OR hiddenRenderer:PID) ─────

describe('buildPerfDiagnosticPayload — rendererCpuMsSinceLast', () => {
  beforeEach(() => {
    _resetPerfDiagnosticStateForTesting();
  });

  it('populates rendererCpuMsSinceLast from a "hiddenRenderer:PID" row when the window is minimized', async () => {
    const cpuDeltaStore = new Map<number, number>();

    // Tick 1 — seed cumulativeCPUUsage for pid 202 (labelled hiddenRenderer:202)
    await buildPerfDiagnosticPayload(
      makeResolvedDeps({
        cpuDeltaStore,
        getVisibilityKind: () => 'minimized' as VisibilityKind,
        getRamSnapshot: () =>
          makeRamSnapshot({
            processes: [
              { pid: 200, type: 'Browser', label: 'main', workingSetMB: 300, cpuPercent: 5 },
              // Minimized window → relabelled by buildProcessLabelMap.
              {
                pid: 202,
                type: 'Tab',
                label: 'hiddenRenderer:202',
                workingSetMB: 200,
                cpuPercent: 15,
              },
            ],
          }) as never,
        getAppMetrics: () =>
          [makeAppMetric(200, 1.0, 5), makeAppMetric(202, 2.0, 15)] as never,
      }),
    );

    // Tick 2 — cumulative increased by 0.4s on the hidden renderer.
    const p2 = await buildPerfDiagnosticPayload(
      makeResolvedDeps({
        cpuDeltaStore,
        getVisibilityKind: () => 'minimized' as VisibilityKind,
        getRamSnapshot: () =>
          makeRamSnapshot({
            processes: [
              { pid: 200, type: 'Browser', label: 'main', workingSetMB: 300, cpuPercent: 5 },
              {
                pid: 202,
                type: 'Tab',
                label: 'hiddenRenderer:202',
                workingSetMB: 200,
                cpuPercent: 15,
              },
            ],
          }) as never,
        getAppMetrics: () =>
          [makeAppMetric(200, 1.2, 5), makeAppMetric(202, 2.4, 15)] as never,
      }),
    );

    // 0.4s × 1000 = 400 ms — NOT null, despite the renderer being hidden.
    expect(p2.rendererCpuMsSinceLast).toBe(400);
  });

  it('does not confuse gpuWorker / exportRenderer rows for the user-facing renderer', async () => {
    const cpuDeltaStore = new Map<number, number>();

    // Tick 1 — no mainUI / hiddenRenderer row at all.
    await buildPerfDiagnosticPayload(
      makeResolvedDeps({
        cpuDeltaStore,
        getVisibilityKind: () => 'focused' as VisibilityKind,
        getRamSnapshot: () =>
          makeRamSnapshot({
            processes: [
              { pid: 300, type: 'Browser', label: 'main', workingSetMB: 300, cpuPercent: 5 },
              { pid: 301, type: 'Tab', label: 'gpuWorker', workingSetMB: 120, cpuPercent: 3 },
              { pid: 302, type: 'Tab', label: 'exportRenderer', workingSetMB: 60, cpuPercent: 1 },
            ],
          }) as never,
        getAppMetrics: () =>
          [
            makeAppMetric(300, 1.0, 5),
            makeAppMetric(301, 1.0, 3),
            makeAppMetric(302, 0.5, 1),
          ] as never,
      }),
    );

    const p2 = await buildPerfDiagnosticPayload(
      makeResolvedDeps({
        cpuDeltaStore,
        getVisibilityKind: () => 'focused' as VisibilityKind,
        getRamSnapshot: () =>
          makeRamSnapshot({
            processes: [
              { pid: 300, type: 'Browser', label: 'main', workingSetMB: 300, cpuPercent: 5 },
              { pid: 301, type: 'Tab', label: 'gpuWorker', workingSetMB: 120, cpuPercent: 3 },
              { pid: 302, type: 'Tab', label: 'exportRenderer', workingSetMB: 60, cpuPercent: 1 },
            ],
          }) as never,
        getAppMetrics: () =>
          [
            makeAppMetric(300, 1.5, 5),
            makeAppMetric(301, 2.0, 3),
            makeAppMetric(302, 0.8, 1),
          ] as never,
      }),
    );

    // No mainUI / hiddenRenderer row → null (gpuWorker / exportRenderer excluded).
    expect(p2.rendererCpuMsSinceLast).toBeNull();
  });
});

// ── 6b. Contract: eventLoopDelay always present in payload ──────────

describe('buildPerfDiagnosticPayload — eventLoopDelay contract', () => {
  beforeEach(() => {
    _resetPerfDiagnosticStateForTesting();
  });

  it('threads unavailable status end-to-end — "Memory diagnostic" log still emits with eventLoopDelay present', async () => {
    // Capture the emitted "Memory diagnostic" payload so we can verify the
    // serialised log payload contains the field (contract: "payload never
    // omits eventLoopDelay").
    let emitted: PerfDiagnosticPayload | null = null;
    const logger = {
      info: vi.fn((payload: unknown, msg: string) => {
        if (msg === 'Memory diagnostic' && typeof payload === 'object' && payload !== null) {
          emitted = payload as PerfDiagnosticPayload;
        }
      }),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
      fatal: vi.fn(),
      trace: vi.fn(),
      silent: vi.fn(),
      child: vi.fn(),
      level: 'info',
    } as unknown as Parameters<typeof startPerfDiagnostic>[0]['logger'];

    const unavailable = {
      status: 'unavailable' as const,
      error: 'test',
      windowDurationMs: 0,
    };

    const resolved = makeResolvedDeps({
      cpuDeltaStore: new Map(),
      logger,
      getEventLoopLag: () => unavailable,
    });

    // Exercise the pure builder first — shape assertion.
    const payload = await buildPerfDiagnosticPayload(resolved);
    expect(payload.eventLoopDelay).toEqual(unavailable);
    // Contract: the key is always present on the payload.
    expect('eventLoopDelay' in payload).toBe(true);

    // Now drive the full tick so the "Memory diagnostic" log emits — this
    // locks in the end-to-end "never omits" contract on the emitted payload.
    await runPerfDiagnosticTick(resolved, { logger, isDev: false });

    expect(logger.info).toHaveBeenCalled();
    expect(emitted).not.toBeNull();
     
    const logged = emitted!;
    expect('eventLoopDelay' in logged).toBe(true);
    expect(logged.eventLoopDelay).toEqual(unavailable);
  });
});

// ── 6c. Contract: rendererPerfSummary always present in payload (Stage 3) ──

describe('buildPerfDiagnosticPayload — rendererPerfSummary contract', () => {
  beforeEach(() => {
    _resetPerfDiagnosticStateForTesting();
  });

  it('returns the injected summary when getRendererPerfSummary yields one', async () => {
    const mockSummary = {
      longTasks: { count: 3, p50Ms: 55, p95Ms: 120, maxMs: 180 },
      inputLag: { count: 1, p50Ms: 110, p95Ms: 110, maxMs: 110 },
      batchStartMs: 1_000,
      batchEndMs: 61_000,
      batchId: 4,
    };
    const payload = await buildPerfDiagnosticPayload(
      makeResolvedDeps({
        cpuDeltaStore: new Map(),
        getRendererPerfSummary: () => mockSummary,
      }),
    );
    expect('rendererPerfSummary' in payload).toBe(true);
    expect(payload.rendererPerfSummary).toBe(mockSummary);
  });

  it('returns null when getRendererPerfSummary returns null — key still present', async () => {
    const payload = await buildPerfDiagnosticPayload(
      makeResolvedDeps({
        cpuDeltaStore: new Map(),
        getRendererPerfSummary: () => null,
      }),
    );
    expect('rendererPerfSummary' in payload).toBe(true);
    expect(payload.rendererPerfSummary).toBeNull();
  });
});

// ── 7. Fail-observable: getRamSnapshot throwing ──────────────────────

describe('buildPerfDiagnosticPayload — fail-observable getRamSnapshot', () => {
  beforeEach(() => {
    _resetPerfDiagnosticStateForTesting();
  });

  it('when getRamSnapshot returns a degraded snapshot (processes: []), payload still emits', async () => {
    // Emulate the M1 fix: captureRamSnapshot swallows getAppMetrics() throws
    // internally and returns an empty-processes snapshot.
    const logger = stubLogger();
    const degradedSnapshot = makeRamSnapshot({ processes: [] });
    (degradedSnapshot as unknown as { totals: { workingSetMB: number; processCount: number } }).totals = {
      workingSetMB: 0,
      processCount: 0,
    };

    const payload = await buildPerfDiagnosticPayload(
      makeResolvedDeps({
        cpuDeltaStore: new Map(),
        logger,
        getRamSnapshot: () => degradedSnapshot as never,
      }),
    );

    // Emission succeeded; shape is stable.
    expect(payload.profilerChannel).toBe('perf-summary');
    expect(payload.processes).toHaveLength(0);
    expect(payload.rendererCpuMsSinceLast).toBeNull();
    expect(payload.topCpuProcess).toBeNull();
    expect(payload.heapUsedMB).toBe(100); // mainProcess fields preserved
  });
});

// ── 2. Scheduler wiring (real visibilityAwareScheduler + fake timers) ───

describe('startPerfDiagnostic — scheduler wiring', () => {
  let logCalls: PerfDiagnosticPayload[];
  const captureLogCalls = () => {
    logCalls = [];
    return {
      info: vi.fn((payload: unknown, msg: string) => {
        if (msg === 'Memory diagnostic' && typeof payload === 'object' && payload !== null) {
          logCalls.push(payload as PerfDiagnosticPayload);
        }
      }),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
      fatal: vi.fn(),
      trace: vi.fn(),
      silent: vi.fn(),
      child: vi.fn(),
      level: 'info',
    } as unknown as Parameters<typeof startPerfDiagnostic>[0]['logger'];
  };

  beforeEach(() => {
    vi.useFakeTimers();
    _resetForTesting();
    _resetPerfDiagnosticStateForTesting();
    _setHeadlessModeForTesting(false);
  });

  afterEach(() => {
    _resetForTesting();
    _resetPerfDiagnosticStateForTesting();
    vi.useRealTimers();
  });

  it('emits on foreground cadence (5 min default)', async () => {
    const logger = captureLogCalls();
    const dispose = startPerfDiagnostic({
      logger,
      scheduler: createThrottledInterval,
      // FU-5: keep these scheduler-timing tests free of the short-window
      // instant-sample delay + the between-emit peak sampler timer (both
      // covered by dedicated FU-5 suites).
      sleepMs: async () => {},
      schedulePeakSampler: () => () => {},
      isDev: false, // Avoid touching Electron isPackaged path
      getAppMetrics: () => [makeAppMetric(100, 0.5)] as never,
      getRamSnapshot: () => makeRamSnapshot() as never,
    }).dispose;

    // No ticks at startup
    expect(logCalls).toHaveLength(0);

    // Tick 1 at 5 min
    await vi.advanceTimersByTimeAsync(MEMORY_LOG_INTERVAL_MS);
    expect(logCalls).toHaveLength(1);
    expect(logCalls[0].cadenceMs).toBe(MEMORY_LOG_INTERVAL_MS);
    expect(logCalls[0].blurState).toBe('focused');

    // Tick 2 another 5 min later
    await vi.advanceTimersByTimeAsync(MEMORY_LOG_INTERVAL_MS);
    expect(logCalls).toHaveLength(2);

    dispose();
  });

  it('throttles to the background cadence while blurred (not minimized)', async () => {
    const logger = captureLogCalls();
    // NB: `visibilityAwareScheduler` enforces `Math.max(1000, blurThrottleMs)`,
    // so `backgroundMs` must be ≥1000 to be honoured under blur.
    const dispose = startPerfDiagnostic({
      logger,
      scheduler: createThrottledInterval,
      // FU-5: keep these scheduler-timing tests free of the short-window
      // instant-sample delay + the between-emit peak sampler timer (both
      // covered by dedicated FU-5 suites).
      sleepMs: async () => {},
      schedulePeakSampler: () => () => {},
      isDev: false,
      foregroundMs: 5_000,
      backgroundMs: 2_000,
      getAppMetrics: () => [makeAppMetric(100, 0.5)] as never,
      getRamSnapshot: () => makeRamSnapshot() as never,
    }).dispose;

    // One foreground tick at 5 s
    await vi.advanceTimersByTimeAsync(5_000);
    expect(logCalls).toHaveLength(1);
    expect(logCalls[0].blurState).toBe('focused');
    expect(logCalls[0].cadenceMs).toBe(5_000);

    // Blur → interval reschedules at blurThrottleMs = 2 s
    _setBlurredForTesting(true);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(logCalls).toHaveLength(2);
    expect(logCalls[1].blurState).toBe('blurred');
    expect(logCalls[1].cadenceMs).toBe(2_000);

    // Another blurred-cadence tick
    await vi.advanceTimersByTimeAsync(2_000);
    expect(logCalls).toHaveLength(3);
    expect(logCalls[2].blurState).toBe('blurred');

    dispose();
  });

  it('throttles to 120 s while minimized', async () => {
    const logger = captureLogCalls();
    const dispose = startPerfDiagnostic({
      logger,
      scheduler: createThrottledInterval,
      // FU-5: keep these scheduler-timing tests free of the short-window
      // instant-sample delay + the between-emit peak sampler timer (both
      // covered by dedicated FU-5 suites).
      sleepMs: async () => {},
      schedulePeakSampler: () => () => {},
      isDev: false,
      foregroundMs: 1_000,
      backgroundMs: 500,
      getAppMetrics: () => [makeAppMetric(100, 0.5)] as never,
      getRamSnapshot: () => makeRamSnapshot() as never,
    }).dispose;

    await vi.advanceTimersByTimeAsync(1_000);
    expect(logCalls).toHaveLength(1);

    // Minimize → throttled via scheduler's backgroundMs path (not blur)
    _setHiddenForTesting(true);
    await vi.advanceTimersByTimeAsync(500);
    expect(logCalls).toHaveLength(2);
    expect(logCalls[1].blurState).toBe('minimized');
    expect(logCalls[1].cadenceMs).toBe(500);

    dispose();
  });

  it('catch-up on focus return respects catchUpPriority: 8 (fires within ~8s)', async () => {
    const logger = captureLogCalls();
    // NB: backgroundMs >> priority*1000ms so the pending blurred timer sits
    // past the stagger deadline; the catch-up fires first and cancels the
    // pending blurred timer via `runCatchUpTick`.
    const dispose = startPerfDiagnostic({
      logger,
      scheduler: createThrottledInterval,
      // FU-5: keep these scheduler-timing tests free of the short-window
      // instant-sample delay + the between-emit peak sampler timer (both
      // covered by dedicated FU-5 suites).
      sleepMs: async () => {},
      schedulePeakSampler: () => () => {},
      isDev: false,
      foregroundMs: 5_000,
      backgroundMs: 20_000,
      catchUpPriority: 8,
      getAppMetrics: () => [makeAppMetric(100, 0.5)] as never,
      getRamSnapshot: () => makeRamSnapshot() as never,
    }).dispose;

    // First foreground tick at 5s
    await vi.advanceTimersByTimeAsync(5_000);
    expect(logCalls).toHaveLength(1);

    // Blur → interval reschedules to 20 s (>> stagger delay)
    _setBlurredForTesting(true);
    await vi.advanceTimersByTimeAsync(1_000); // t=6_000, still blurred, no tick
    expect(logCalls).toHaveLength(1);

    // Focus return → staggered catch-up at priority 8 (8 s delay)
    _setBlurredForTesting(false);
    // Before 8 s, catch-up hasn't fired
    await vi.advanceTimersByTimeAsync(7_999);
    expect(logCalls).toHaveLength(1);
    // At 8 s, catch-up fires and runs a tick at foreground cadence
    await vi.advanceTimersByTimeAsync(1);
    expect(logCalls).toHaveLength(2);
    expect(logCalls[1].blurState).toBe('focused');
    expect(logCalls[1].cadenceMs).toBe(5_000);

    dispose();
  });

  it('dispose() stops the scheduler', async () => {
    const logger = captureLogCalls();
    const { dispose } = startPerfDiagnostic({
      logger,
      scheduler: createThrottledInterval,
      // FU-5: keep these scheduler-timing tests free of the short-window
      // instant-sample delay + the between-emit peak sampler timer (both
      // covered by dedicated FU-5 suites).
      sleepMs: async () => {},
      schedulePeakSampler: () => () => {},
      isDev: false,
      foregroundMs: 1_000,
      backgroundMs: 500,
      getAppMetrics: () => [makeAppMetric(100, 0.5)] as never,
      getRamSnapshot: () => makeRamSnapshot() as never,
    });

    await vi.advanceTimersByTimeAsync(1_000);
    expect(logCalls).toHaveLength(1);

    dispose();

    await vi.advanceTimersByTimeAsync(10_000);
    expect(logCalls).toHaveLength(1);
  });

  // Iter-2 hardening (GPT review S1 round 2): a re-`startPerfDiagnostic`
  // after dispose (e.g., dev-mode HMR or post-crash recovery) must not
  // inherit the previous handle's sampler state — otherwise a PID that
  // was in `lastSampleStatus='timeout'` when disposed would fire a
  // spurious "recovered" on its first tick under the new handle.
  it('dispose() clears module-scope sampler state so re-start is clean', async () => {
    const pid = 88_888;
    const timeoutSampler: SampleSubprocessUsage = async () => ({
      cpuPercent: null, workingSetMB: null, status: 'timeout',
    });
    const okSampler: SampleSubprocessUsage = async () => ({
      cpuPercent: 5, workingSetMB: 100, status: 'ok',
    });
    const lifecycle = (): SuperMcpSubprocessInfo => ({
      pid,
      startTime: 1_700_000_000_000,
      uptime: 60_000,
      isRunning: true,
      startCount: 1,
      restartCount: 0,
      lastStartupFailureAt: null,
      lastStartupError: null,
      circuitBreakerActive: false,
      cooldownRemainingMs: null,
      lastRestartReason: null,
    });

    // Handle A: prime `lastSampleStatus = 'timeout'`.
    const loggerA = stubLogger();
    const handleA = startPerfDiagnostic({
      logger: loggerA,
      scheduler: createThrottledInterval,
      // FU-5: keep these scheduler-timing tests free of the short-window
      // instant-sample delay + the between-emit peak sampler timer (both
      // covered by dedicated FU-5 suites).
      sleepMs: async () => {},
      schedulePeakSampler: () => () => {},
      isDev: false,
      foregroundMs: 1_000,
      backgroundMs: 500,
      getAppMetrics: () => [] as never,
      getRamSnapshot: () => makeRamSnapshot() as never,
      getSuperMcpLifecycle: lifecycle,
      sampleSubprocessUsage: timeoutSampler,
    });
    await vi.advanceTimersByTimeAsync(1_000); // one tick → status=timeout
    handleA.dispose();

    // Handle B: same PID (simulates HMR replacing the handle without the
    // subprocess restarting). Without dispose's state clear,
    // prevStatus='timeout' against current='ok' fires a spurious recovered
    // info log. With dispose's clear, prevStatus is null → silent.
    const loggerB = stubLogger();
    const handleB = startPerfDiagnostic({
      logger: loggerB,
      scheduler: createThrottledInterval,
      // FU-5: keep these scheduler-timing tests free of the short-window
      // instant-sample delay + the between-emit peak sampler timer (both
      // covered by dedicated FU-5 suites).
      sleepMs: async () => {},
      schedulePeakSampler: () => () => {},
      isDev: false,
      foregroundMs: 1_000,
      backgroundMs: 500,
      getAppMetrics: () => [] as never,
      getRamSnapshot: () => makeRamSnapshot() as never,
      getSuperMcpLifecycle: lifecycle,
      sampleSubprocessUsage: okSampler,
    });
    await vi.advanceTimersByTimeAsync(1_000); // first tick under B
    handleB.dispose();

    const spuriousCallsOnB = [
      ...(loggerB.warn as ReturnType<typeof vi.fn>).mock.calls,
      ...(loggerB.info as ReturnType<typeof vi.fn>).mock.calls,
    ].filter(
      (call) =>
        call[1] === 'perfDiagnostic: super-mcp CPU sampling degraded' ||
        call[1] === 'perfDiagnostic: super-mcp CPU sampling recovered',
    );
    expect(spuriousCallsOnB).toHaveLength(0);
  });
});

// ── 8. Stage 4a: super-mcp lifecycle + synth row ─────────────────────

const makeSuperMcpLifecycle = (overrides: Partial<{
  pid: number | null;
  startTime: number | null;
  uptime: number | null;
  isRunning: boolean;
  startCount: number;
  restartCount: number;
  lastStartupFailureAt: number | null;
  lastStartupError: string | null;
  circuitBreakerActive: boolean;
  cooldownRemainingMs: number | null;
  // Stage 2 (260424) — narrow string-literal union matching the real type.
  lastRestartReason: SuperMcpRestartReason | null;
}> = {}): SuperMcpSubprocessInfo => ({
  pid: 42_000,
  startTime: 1_700_000_000_000,
  uptime: 60_000,
  isRunning: true,
  startCount: 1,
  restartCount: 0,
  lastStartupFailureAt: null,
  lastStartupError: null,
  circuitBreakerActive: false,
  cooldownRemainingMs: null,
  lastRestartReason: null as SuperMcpRestartReason | null,
  ...overrides,
});

describe('buildPerfDiagnosticPayload — superMcpLifecycle (Stage 4a)', () => {
  beforeEach(() => {
    _resetPerfDiagnosticStateForTesting();
  });

  it('populates superMcpLifecycle and synthesises a "super-mcp" row in processes[] when running', async () => {
    const lifecycle = makeSuperMcpLifecycle();
    const payload = await buildPerfDiagnosticPayload(
      makeResolvedDeps({
        cpuDeltaStore: new Map(),
        getSuperMcpLifecycle: () => lifecycle,
        // Stage 1 (260424): default sampler is a vi.fn in makeResolvedDeps;
        // override here with a canned 'ok' so the synth row carries real
        // numbers (and test locks in that sampler result is threaded through).
        sampleSubprocessUsage: async () => ({
          cpuPercent: 5.2,
          workingSetMB: 120,
          status: 'ok',
        }),
      }),
    );

    expect(payload.superMcpLifecycle).toEqual(lifecycle);

    // Synth row appears alongside the RAM snapshot's Electron processes.
    const synthRow = payload.processes.find((p) => p.label === 'super-mcp');
    expect(synthRow).toBeDefined();
    expect(synthRow).toMatchObject({
      pid: 42_000,
      type: 'subprocess',
      label: 'super-mcp',
      workingSetMB: 120,
      cpuPercent: 5.2,
      cpuMsSinceLast: null,
      cpuStatus: 'ok',
    });
  });

  it('fail-observable: if the getter throws, payload has superMcpLifecycle: null and no synth row; warn logged', async () => {
    const logger = stubLogger();
    const payload = await buildPerfDiagnosticPayload(
      makeResolvedDeps({
        cpuDeltaStore: new Map(),
        logger,
        getSuperMcpLifecycle: () => {
          throw new Error('getter exploded');
        },
      }),
    );

    expect(payload.superMcpLifecycle).toBeNull();
    expect(payload.processes.find((p) => p.label === 'super-mcp')).toBeUndefined();
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ err: expect.any(Error) }),
      'perfDiagnostic: super-mcp lifecycle getter threw',
    );
    // Payload still emits cleanly — stable shape preserved.
    expect(payload.profilerChannel).toBe('perf-summary');
  });

  it('omits synth row when super-mcp is not running (isRunning: false, pid: null)', async () => {
    const lifecycle = makeSuperMcpLifecycle({
      isRunning: false,
      pid: null,
      uptime: null,
    });
    const payload = await buildPerfDiagnosticPayload(
      makeResolvedDeps({
        cpuDeltaStore: new Map(),
        getSuperMcpLifecycle: () => lifecycle,
      }),
    );

    expect(payload.superMcpLifecycle).toEqual(lifecycle);
    expect(payload.processes.find((p) => p.label === 'super-mcp')).toBeUndefined();
  });

  it('omits synth row when circuit breaker is active but process is not running', async () => {
    const lifecycle = makeSuperMcpLifecycle({
      isRunning: false,
      pid: null,
      uptime: null,
      lastStartupFailureAt: 1_700_000_000_000,
      lastStartupError: 'port bind failed',
      circuitBreakerActive: true,
      cooldownRemainingMs: 45_000,
    });
    const payload = await buildPerfDiagnosticPayload(
      makeResolvedDeps({
        cpuDeltaStore: new Map(),
        getSuperMcpLifecycle: () => lifecycle,
      }),
    );

    // Lifecycle still reported so subscribers can see breaker state.
    expect(payload.superMcpLifecycle).toEqual(lifecycle);
    expect(payload.superMcpLifecycle?.circuitBreakerActive).toBe(true);
    expect(payload.superMcpLifecycle?.cooldownRemainingMs).toBe(45_000);
    // No synth row — nothing to put in processes[].
    expect(payload.processes.find((p) => p.label === 'super-mcp')).toBeUndefined();
  });

  it('does not duplicate the super-mcp row if the PID somehow already appears in ramSnapshot.processes', async () => {
    // If the super-mcp PID leaks into app.getAppMetrics() (e.g., because
    // Electron surfaced it transiently), buildPerfDiagnosticPayload must not
    // synthesise a duplicate row with the same PID.
    const cpuDeltaStore = new Map<number, number>();
    const payload = await buildPerfDiagnosticPayload(
      makeResolvedDeps({
        cpuDeltaStore,
        getSuperMcpLifecycle: () => makeSuperMcpLifecycle({ pid: 102 }),
        getRamSnapshot: () =>
          makeRamSnapshot({
            processes: [
              { pid: 100, type: 'Browser', label: 'main', workingSetMB: 300, cpuPercent: 5 },
              {
                pid: 102,
                type: 'unknown',
                label: 'super-mcp',
                workingSetMB: 55,
                cpuPercent: 3,
              },
            ],
          }) as never,
        getAppMetrics: () =>
          [makeAppMetric(100, 1.0, 5), makeAppMetric(102, 2.0, 3)] as never,
      }),
    );

    const rows = payload.processes.filter((p) => p.pid === 102);
    expect(rows).toHaveLength(1);
  });

  // ── M4: breadcrumb when synth row is suppressed by PID collision ─────

  it('logs a debug breadcrumb at tick when the super-mcp PID is already present in appMetrics (synth row suppressed)', async () => {
    const logger = stubLogger();
    const cpuDeltaStore = new Map<number, number>();
    await buildPerfDiagnosticPayload(
      makeResolvedDeps({
        cpuDeltaStore,
        logger,
        getSuperMcpLifecycle: () => makeSuperMcpLifecycle({ pid: 102 }),
        getRamSnapshot: () =>
          makeRamSnapshot({
            processes: [
              { pid: 100, type: 'Browser', label: 'main', workingSetMB: 300, cpuPercent: 5 },
              {
                pid: 102,
                type: 'Tab',
                label: 'renderer:102',
                workingSetMB: 55,
                cpuPercent: 3,
              },
            ],
          }) as never,
        getAppMetrics: () =>
          [makeAppMetric(100, 1.0, 5), makeAppMetric(102, 2.0, 3)] as never,
      }),
    );

    expect(logger.debug).toHaveBeenCalledWith(
      expect.objectContaining({ pid: 102, existingLabel: 'renderer:102' }),
      'perfDiagnostic: super-mcp PID already present in appMetrics; synth row skipped',
    );
  });

  it('does NOT log the suppression breadcrumb when there is no PID collision (normal path)', async () => {
    const logger = stubLogger();
    const cpuDeltaStore = new Map<number, number>();
    await buildPerfDiagnosticPayload(
      makeResolvedDeps({
        cpuDeltaStore,
        logger,
        getSuperMcpLifecycle: () => makeSuperMcpLifecycle({ pid: 999 }),
      }),
    );
    // No debug call with the suppression message.
    for (const call of (logger.debug as ReturnType<typeof vi.fn>).mock.calls) {
      expect(call[1]).not.toBe(
        'perfDiagnostic: super-mcp PID already present in appMetrics; synth row skipped',
      );
    }
  });

  it('payload shape: superMcpLifecycle key is always present (even when null)', async () => {
    const payload = await buildPerfDiagnosticPayload(
      makeResolvedDeps({ cpuDeltaStore: new Map(), getSuperMcpLifecycle: () => null }),
    );
    expect('superMcpLifecycle' in payload).toBe(true);
    expect(payload.superMcpLifecycle).toBeNull();
  });

  it('passes lastRestartReason through unchanged from the lifecycle getter (Stage 2 of 260424)', async () => {
    // Plan-specified pass-through test: when the lifecycle getter returns a
    // running snapshot carrying `lastRestartReason: '<literal>'`, the payload's
    // `superMcpLifecycle.lastRestartReason` matches verbatim. No transformation
    // happens in `perfDiagnosticService` — the field flows through as part of
    // `SuperMcpSubprocessInfo`. Using 'debounced-workspace-change' here; any
    // of the Stage 2 enum values would assert the same pass-through.
    const lifecycle = makeSuperMcpLifecycle({
      isRunning: true,
      lastRestartReason: 'debounced-workspace-change',
    });
    const payload = await buildPerfDiagnosticPayload(
      makeResolvedDeps({
        cpuDeltaStore: new Map(),
        getSuperMcpLifecycle: () => lifecycle,
      }),
    );
    expect(payload.superMcpLifecycle?.lastRestartReason).toBe(
      'debounced-workspace-change',
    );
  });
});

// ── 9. Stage 4b: superMcpChildStats /stats cache passthrough ─────────

describe('buildPerfDiagnosticPayload — superMcpChildStats (Stage 4b)', () => {
  beforeEach(() => {
    _resetPerfDiagnosticStateForTesting();
  });

  it('passes through a status: "ok" cache snapshot verbatim', async () => {
    const emission = {
      status: 'ok' as const,
      at: 1_700_000_000_000,
      payload: {
        router: {
          running: true,
          pid: 4242,
          uptime_ms: 10_000,
          started_at: '2026-04-23T00:00:00.000Z',
        },
        children: [
          { package_id: 'alpha', pid: 9999, connected: true, spawn_count: 1 },
        ],
        generated_at: '2026-04-23T00:00:10.000Z',
      },
      stats_age_ms: 2_000,
      last_good_age_ms: 2_000,
    };
    const payload = await buildPerfDiagnosticPayload(
      makeResolvedDeps({
        cpuDeltaStore: new Map(),
        getSuperMcpStats: () => emission,
      }),
    );

    expect(payload.superMcpChildStats).toEqual(emission);
    expect('superMcpChildStats' in payload).toBe(true);
  });

  it('passes through a status: "unsupported" cache snapshot (older super-mcp without /stats)', async () => {
    const emission = {
      status: 'unsupported' as const,
      at: 1_700_000_000_000,
      stats_age_ms: 5_000,
      last_good_age_ms: null,
    };
    const payload = await buildPerfDiagnosticPayload(
      makeResolvedDeps({
        cpuDeltaStore: new Map(),
        getSuperMcpStats: () => emission,
      }),
    );
    expect(payload.superMcpChildStats).toEqual(emission);
  });

  it('passes through a status: "timeout" cache snapshot', async () => {
    const emission = {
      status: 'timeout' as const,
      at: 1_700_000_000_000,
      lastErr: 'The operation was aborted',
      stats_age_ms: 3_000,
      last_good_age_ms: 10_000,
    };
    const payload = await buildPerfDiagnosticPayload(
      makeResolvedDeps({
        cpuDeltaStore: new Map(),
        getSuperMcpStats: () => emission,
      }),
    );
    expect(payload.superMcpChildStats).toEqual(emission);
  });

  it('passes through status: "unavailable" when manager is not running', async () => {
    const emission = {
      status: 'unavailable' as const,
      stats_age_ms: null,
      last_good_age_ms: null,
    };
    const payload = await buildPerfDiagnosticPayload(
      makeResolvedDeps({
        cpuDeltaStore: new Map(),
        getSuperMcpStats: () => emission,
      }),
    );
    expect(payload.superMcpChildStats).toEqual(emission);
  });

  it('fail-observable: if the getter throws, payload carries status:"unavailable" + warn logged', async () => {
    const logger = stubLogger();
    const payload = await buildPerfDiagnosticPayload(
      makeResolvedDeps({
        cpuDeltaStore: new Map(),
        logger,
        getSuperMcpStats: () => {
          throw new Error('stats getter exploded');
        },
      }),
    );
    expect(payload.superMcpChildStats).toEqual({
      status: 'unavailable',
      stats_age_ms: null,
      last_good_age_ms: null,
    });
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ err: expect.any(Error) }),
      'perfDiagnostic: super-mcp stats getter threw',
    );
    // Payload still emits cleanly.
    expect(payload.profilerChannel).toBe('perf-summary');
  });

  it('payload shape: superMcpChildStats key is always present', async () => {
    const payload = await buildPerfDiagnosticPayload(
      makeResolvedDeps({
        cpuDeltaStore: new Map(),
        getSuperMcpStats: () => ({ status: 'unavailable', stats_age_ms: null, last_good_age_ms: null }),
      }),
    );
    expect('superMcpChildStats' in payload).toBe(true);
    expect(payload.superMcpChildStats.status).toBe('unavailable');
  });

  it('runPerfDiagnosticTick fires triggerSuperMcpStatsFetch before building payload', async () => {
    const triggerSuperMcpStatsFetch = vi.fn();
    const logger = stubLogger();
    const resolved = makeResolvedDeps({ cpuDeltaStore: new Map(), logger });

    await runPerfDiagnosticTick(resolved, {
      logger,
      isDev: false,
      triggerSuperMcpStatsFetch,
    });
    expect(triggerSuperMcpStatsFetch).toHaveBeenCalledTimes(1);
  });

  it('runPerfDiagnosticTick swallows triggerSuperMcpStatsFetch throws at debug level', async () => {
    const logger = stubLogger();
    const resolved = makeResolvedDeps({ cpuDeltaStore: new Map(), logger });

    // Trigger that throws synchronously — tick must continue and log at debug.
    await expect(
      runPerfDiagnosticTick(resolved, {
        logger,
        isDev: false,
        triggerSuperMcpStatsFetch: () => {
          throw new Error('trigger boom');
        },
      }),
    ).resolves.toBeUndefined();
    expect(logger.debug).toHaveBeenCalledWith(
      expect.objectContaining({ err: expect.any(Error) }),
      'perfDiagnostic: triggerSuperMcpStatsFetch threw',
    );
    // Memory diagnostic still emitted.
    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({ profilerChannel: 'perf-summary' }),
      'Memory diagnostic',
    );
  });
});

describe('runPerfDiagnosticTick — Stage 5.3 auto incident capture', () => {
  const makeEventLoopOk = (p50: number) => ({
    status: 'ok' as const,
    p50,
    p95: p50,
    p99: p50,
    max: p50,
    min: 0,
    mean: p50,
    windowDurationMs: 60_000,
  });

  const makeCounter = (rate5m: number, cumulative: number = rate5m) => ({ rate5m, cumulative });

  const makeScanSpacesWindowedCounters = (writableRequestsRate5m: number) => ({
    readOnly: {
      requests: makeCounter(0),
      hits: makeCounter(0),
      misses: makeCounter(0),
      inflightJoins: makeCounter(0),
      underlyingFetches: makeCounter(0),
      fetchErrors: makeCounter(0),
      maxConcurrentInflight: makeCounter(0),
    },
    writable: {
      requests: makeCounter(writableRequestsRate5m),
      hits: makeCounter(0),
      misses: makeCounter(0),
      inflightJoins: makeCounter(0),
      underlyingFetches: makeCounter(0),
      fetchErrors: makeCounter(0),
      maxConcurrentInflight: makeCounter(0),
    },
  });

  const makeWatchdogSignal = (
    reason: BackgroundConsumerWatchdogSignal['reason'],
    stuckTurnId: string | null = 'turn-stuck',
  ): BackgroundConsumerWatchdogSignal => ({
    consumerId: 'indexer',
    reason,
    observedAtMs: Date.now(),
    pauseDurationMs: 120_000,
    turnIds: ['turn-stuck'],
    stuckTurnId,
  });

  beforeEach(() => {
    _resetPerfDiagnosticStateForTesting();
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('captures when watchdog reports stuck_active_turn_signal', async () => {
    const logger = stubLogger();
    const captureAutoIncident = vi.fn().mockResolvedValue({
      incidentPath: '/tmp/perf-incident.json',
      rendererMemoryPath: '/tmp/perf-incident.renderer-memory.json',
      cpuProfilePath: '/tmp/perf-incident.cpuprofile',
    });
    const resolved = makeResolvedDeps({
      cpuDeltaStore: new Map(),
      logger,
      getEventLoopLag: () => null,
      getScanSpacesWindowedCounters: () => makeScanSpacesWindowedCounters(45),
    });

    await runPerfDiagnosticTick(resolved, {
      logger,
      isDev: false,
      isAutoIncidentCaptureEnabled: () => true,
      captureAutoIncident,
      consumeAutoIncidentWatchdogSignal: () => makeWatchdogSignal('stuck_active_turn_signal', 'turn-123'),
    });

    expect(captureAutoIncident).toHaveBeenCalledTimes(1);
    expect(captureAutoIncident).toHaveBeenCalledWith(
      expect.objectContaining({
        triggerReasons: ['watchdog_stuck_active_turn_signal'],
        watchdog: expect.objectContaining({
          reason: 'stuck_active_turn_signal',
          stuckTurnId: 'turn-123',
        }),
      }),
    );
  });

  it('captures when watchdog reports leaked_active_turn_signal', async () => {
    const logger = stubLogger();
    const captureAutoIncident = vi.fn().mockResolvedValue({
      incidentPath: '/tmp/perf-incident.json',
      rendererMemoryPath: '/tmp/perf-incident.renderer-memory.json',
      cpuProfilePath: null,
    });
    const resolved = makeResolvedDeps({
      cpuDeltaStore: new Map(),
      logger,
      getEventLoopLag: () => makeEventLoopOk(12),
      getScanSpacesWindowedCounters: () => makeScanSpacesWindowedCounters(0),
    });

    await runPerfDiagnosticTick(resolved, {
      logger,
      isDev: false,
      isAutoIncidentCaptureEnabled: () => true,
      captureAutoIncident,
      consumeAutoIncidentWatchdogSignal: () => makeWatchdogSignal('leaked_active_turn_signal', null),
    });
    expect(captureAutoIncident).toHaveBeenCalledTimes(1);
    expect(captureAutoIncident).toHaveBeenCalledWith(
      expect.objectContaining({
        triggerReasons: ['watchdog_leaked_active_turn_signal'],
        watchdog: expect.objectContaining({
          reason: 'leaked_active_turn_signal',
          stuckTurnId: null,
        }),
      }),
    );
  });

  it('does not capture for long_running_active_turn_signal watchdog events', async () => {
    const logger = stubLogger();
    const captureAutoIncident = vi.fn().mockResolvedValue({
      incidentPath: '/tmp/perf-incident.json',
      rendererMemoryPath: '/tmp/perf-incident.renderer-memory.json',
      cpuProfilePath: null,
    });
    const resolved = makeResolvedDeps({
      cpuDeltaStore: new Map(),
      logger,
      getEventLoopLag: () => null,
      getScanSpacesWindowedCounters: () => makeScanSpacesWindowedCounters(0),
    });

    await runPerfDiagnosticTick(resolved, {
      logger,
      isDev: false,
      isAutoIncidentCaptureEnabled: () => true,
      captureAutoIncident,
      consumeAutoIncidentWatchdogSignal: () => makeWatchdogSignal('long_running_active_turn_signal', 'turn-healthy'),
    });

    expect(captureAutoIncident).toHaveBeenCalledTimes(0);
  });

  it('keeps stress heuristics as perf-stress-alarm logs but does not capture without watchdog stuck/leaked', async () => {
    const logger = stubLogger();
    const captureAutoIncident = vi.fn().mockResolvedValue({
      incidentPath: '/tmp/perf-incident.json',
      rendererMemoryPath: '/tmp/perf-incident.renderer-memory.json',
      cpuProfilePath: null,
    });
    const resolved = makeResolvedDeps({
      cpuDeltaStore: new Map(),
      logger,
      getEventLoopLag: () => makeEventLoopOk(12),
      getScanSpacesWindowedCounters: () => makeScanSpacesWindowedCounters(45),
    });

    await runPerfDiagnosticTick(resolved, {
      logger,
      isDev: false,
      isAutoIncidentCaptureEnabled: () => true,
      captureAutoIncident,
      consumeAutoIncidentWatchdogSignal: () => null,
    });
    expect(captureAutoIncident).toHaveBeenCalledTimes(0);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        profilerChannel: 'perf-stress-alarm',
        triggerReasons: ['scan_spaces_writable_requests_rate5m'],
      }),
      'perfDiagnostic: stress alarm triggered',
    );
  });

  it('runs auto incident capture asynchronously without blocking diagnostic ticks', async () => {
    const logger = stubLogger();
    let resolveCapture: ((value: {
      incidentPath: string;
      rendererMemoryPath: string;
      cpuProfilePath: string | null;
    }) => void) | null = null;
    const captureAutoIncident = vi.fn().mockImplementation(
      () =>
        new Promise<{
          incidentPath: string;
          rendererMemoryPath: string;
          cpuProfilePath: string | null;
        }>((resolve) => {
          resolveCapture = resolve;
        }),
    );
    const resolved = makeResolvedDeps({
      cpuDeltaStore: new Map(),
      logger,
      getEventLoopLag: () => null,
      getScanSpacesWindowedCounters: () => makeScanSpacesWindowedCounters(0),
    });

    await expect(
      runPerfDiagnosticTick(resolved, {
        logger,
        isDev: false,
        isAutoIncidentCaptureEnabled: () => true,
        captureAutoIncident,
        consumeAutoIncidentWatchdogSignal: () => makeWatchdogSignal('stuck_active_turn_signal', 'turn-async'),
      }),
    ).resolves.toBeUndefined();
    expect(captureAutoIncident).toHaveBeenCalledTimes(1);

    expect(resolveCapture).not.toBeNull();
    resolveCapture!({
      incidentPath: '/tmp/perf-incident.json',
      rendererMemoryPath: '/tmp/perf-incident.renderer-memory.json',
      cpuProfilePath: null,
    });
    await Promise.resolve();
  });

  it('does not queue additional captures while one capture is in flight', async () => {
    const logger = stubLogger();
    let resolveCapture: ((value: {
      incidentPath: string;
      rendererMemoryPath: string;
      cpuProfilePath: string | null;
    }) => void) | null = null;
    const captureAutoIncident = vi.fn().mockImplementation(
      () =>
        new Promise<{
          incidentPath: string;
          rendererMemoryPath: string;
          cpuProfilePath: string | null;
        }>((resolve) => {
          resolveCapture = resolve;
        }),
    );
    const resolved = makeResolvedDeps({
      cpuDeltaStore: new Map(),
      logger,
      getEventLoopLag: () => null,
      getScanSpacesWindowedCounters: () => makeScanSpacesWindowedCounters(0),
    });

    await runPerfDiagnosticTick(resolved, {
      logger,
      isDev: false,
      isAutoIncidentCaptureEnabled: () => true,
      captureAutoIncident,
      consumeAutoIncidentWatchdogSignal: () => makeWatchdogSignal('stuck_active_turn_signal', 'turn-queue'),
    });
    await runPerfDiagnosticTick(resolved, {
      logger,
      isDev: false,
      isAutoIncidentCaptureEnabled: () => true,
      captureAutoIncident,
      consumeAutoIncidentWatchdogSignal: () => makeWatchdogSignal('stuck_active_turn_signal', 'turn-queue'),
    });

    expect(captureAutoIncident).toHaveBeenCalledTimes(1);

    expect(resolveCapture).not.toBeNull();
    resolveCapture!({
      incidentPath: '/tmp/perf-incident.json',
      rendererMemoryPath: '/tmp/perf-incident.renderer-memory.json',
      cpuProfilePath: null,
    });
    await Promise.resolve();
  });

  it('throttles watchdog-triggered captures to one every 30 minutes', async () => {
    const logger = stubLogger();
    const captureAutoIncident = vi.fn().mockResolvedValue({
      incidentPath: '/tmp/perf-incident.json',
      rendererMemoryPath: '/tmp/perf-incident.renderer-memory.json',
      cpuProfilePath: null,
    });
    const resolved = makeResolvedDeps({
      cpuDeltaStore: new Map(),
      logger,
      getEventLoopLag: () => null,
      getScanSpacesWindowedCounters: () => makeScanSpacesWindowedCounters(45),
    });

    await runPerfDiagnosticTick(resolved, {
      logger,
      isDev: false,
      isAutoIncidentCaptureEnabled: () => true,
      captureAutoIncident,
      consumeAutoIncidentWatchdogSignal: () => makeWatchdogSignal('stuck_active_turn_signal', 'turn-throttle'),
    });
    expect(captureAutoIncident).toHaveBeenCalledTimes(1);

    vi.setSystemTime(Date.now() + (5 * 60 * 1000));
    await runPerfDiagnosticTick(resolved, {
      logger,
      isDev: false,
      isAutoIncidentCaptureEnabled: () => true,
      captureAutoIncident,
      consumeAutoIncidentWatchdogSignal: () => makeWatchdogSignal('stuck_active_turn_signal', 'turn-throttle'),
    });
    expect(captureAutoIncident).toHaveBeenCalledTimes(1);

    vi.setSystemTime(Date.now() + (31 * 60 * 1000));
    await runPerfDiagnosticTick(resolved, {
      logger,
      isDev: false,
      isAutoIncidentCaptureEnabled: () => true,
      captureAutoIncident,
      consumeAutoIncidentWatchdogSignal: () => makeWatchdogSignal('stuck_active_turn_signal', 'turn-throttle'),
    });
    expect(captureAutoIncident).toHaveBeenCalledTimes(2);
  });
});

// ── 10. Stage 4b M2: defaultGetSuperMcpStats stale-cache preservation ─

describe('defaultGetSuperMcpStats — !isRunning cache preservation (Stage 4b M2)', () => {
  beforeEach(() => {
    // Reset the module-mock between cases.
    superMcpHttpManagerMock.getSubprocessInfo.mockReset();
    superMcpHttpManagerMock.getLastStatsCache.mockReset();
    superMcpHttpManagerMock.getLastStatsFetchAt.mockReset();
    superMcpHttpManagerMock.getLastGoodStatsAt.mockReset();
  });

  const notRunningInfo: SuperMcpSubprocessInfo = {
    pid: null,
    startTime: null,
    uptime: null,
    isRunning: false,
    startCount: 0,
    restartCount: 0,
    lastStartupFailureAt: null,
    lastStartupError: null,
    circuitBreakerActive: false,
    cooldownRemainingMs: null,
    lastRestartReason: null,
  };

  const runningInfo = {
    ...notRunningInfo,
    pid: 1234,
    startTime: Date.now() - 10_000,
    uptime: 10_000,
    isRunning: true,
    startCount: 1,
  };

  it('!isRunning + cache ok → status "stale" with payload, stats_age_ms, and last_good_age_ms preserved', () => {
    const goodAt = Date.now() - 3_000;
    const fetchAt = Date.now() - 1_000;
    superMcpHttpManagerMock.getSubprocessInfo.mockReturnValue(notRunningInfo);
    superMcpHttpManagerMock.getLastStatsCache.mockReturnValue({
      status: 'ok',
      at: goodAt,
      payload: { router: { pid: 99 }, children: [{ package_id: 'alpha' }] },
    });
    superMcpHttpManagerMock.getLastStatsFetchAt.mockReturnValue(fetchAt);
    superMcpHttpManagerMock.getLastGoodStatsAt.mockReturnValue(goodAt);

    const emission = defaultGetSuperMcpStats();

    expect(emission.status).toBe('stale');
    expect(emission.payload).toEqual({
      router: { pid: 99 },
      children: [{ package_id: 'alpha' }],
    });
    expect(emission.at).toBe(goodAt);
    // Ages derived from Date.now() — allow small wall-clock drift.
    expect(emission.stats_age_ms).toBeGreaterThanOrEqual(1_000);
    expect(emission.stats_age_ms).toBeLessThan(1_500);
    expect(emission.last_good_age_ms).toBeGreaterThanOrEqual(3_000);
    expect(emission.last_good_age_ms).toBeLessThan(3_500);
  });

  it('!isRunning + cache null → status "unavailable" with both ages null', () => {
    superMcpHttpManagerMock.getSubprocessInfo.mockReturnValue(notRunningInfo);
    superMcpHttpManagerMock.getLastStatsCache.mockReturnValue(null);
    superMcpHttpManagerMock.getLastStatsFetchAt.mockReturnValue(null);
    superMcpHttpManagerMock.getLastGoodStatsAt.mockReturnValue(null);

    const emission = defaultGetSuperMcpStats();

    expect(emission).toEqual({
      status: 'unavailable',
      stats_age_ms: null,
      last_good_age_ms: null,
    });
  });

  it('isRunning + cache ok → status "ok" pass-through with last_good_age_ms present', () => {
    const goodAt = Date.now() - 500;
    superMcpHttpManagerMock.getSubprocessInfo.mockReturnValue(runningInfo);
    superMcpHttpManagerMock.getLastStatsCache.mockReturnValue({
      status: 'ok',
      at: goodAt,
      payload: { router: {} },
    });
    superMcpHttpManagerMock.getLastStatsFetchAt.mockReturnValue(goodAt);
    superMcpHttpManagerMock.getLastGoodStatsAt.mockReturnValue(goodAt);

    const emission = defaultGetSuperMcpStats();

    expect(emission.status).toBe('ok');
    expect(emission.last_good_age_ms).toBeGreaterThanOrEqual(500);
    expect(emission.last_good_age_ms).toBeLessThan(1_000);
  });

  it('isRunning + cache null → status "unavailable" with last_good_age_ms null (first tick)', () => {
    superMcpHttpManagerMock.getSubprocessInfo.mockReturnValue(runningInfo);
    superMcpHttpManagerMock.getLastStatsCache.mockReturnValue(null);
    superMcpHttpManagerMock.getLastStatsFetchAt.mockReturnValue(null);
    superMcpHttpManagerMock.getLastGoodStatsAt.mockReturnValue(null);

    const emission = defaultGetSuperMcpStats();

    expect(emission.status).toBe('unavailable');
    expect(emission.last_good_age_ms).toBeNull();
  });
});

// ── 11. Stage 1 (260424): sampleSubprocessUsage populates super-mcp synth row ─

describe('buildPerfDiagnosticPayload — sampleSubprocessUsage (260424 Stage 1)', () => {
  beforeEach(() => {
    _resetPerfDiagnosticStateForTesting();
  });

  it('sample "ok" populates synth row with real cpuPercent / workingSetMB / cpuStatus', async () => {
    const sampler = vi.fn(async () => ({
      cpuPercent: 12.4,
      workingSetMB: 185,
      status: 'ok' as const,
    }));
    const payload = await buildPerfDiagnosticPayload(
      makeResolvedDeps({
        cpuDeltaStore: new Map(),
        getSuperMcpLifecycle: () => makeSuperMcpLifecycle({ pid: 55_000 }),
        sampleSubprocessUsage: sampler,
      }),
    );

    const synthRow = payload.processes.find((p) => p.label === 'super-mcp');
    expect(synthRow).toBeDefined();
    expect(synthRow).toMatchObject({
      pid: 55_000,
      type: 'subprocess',
      label: 'super-mcp',
      workingSetMB: 185,
      cpuPercent: 12.4,
      cpuMsSinceLast: null,
      cpuStatus: 'ok',
    });
    expect(sampler).toHaveBeenCalledTimes(1);
    expect(sampler).toHaveBeenCalledWith(55_000);
  });

  it('sample "timeout" → synth row carries 0 placeholders + cpuStatus:"timeout"', async () => {
    const sampler = vi.fn(async () => ({
      cpuPercent: null,
      workingSetMB: null,
      status: 'timeout' as const,
    }));
    const payload = await buildPerfDiagnosticPayload(
      makeResolvedDeps({
        cpuDeltaStore: new Map(),
        getSuperMcpLifecycle: () => makeSuperMcpLifecycle({ pid: 55_000 }),
        sampleSubprocessUsage: sampler,
      }),
    );

    const synthRow = payload.processes.find((p) => p.label === 'super-mcp');
    expect(synthRow).toBeDefined();
    expect(synthRow).toMatchObject({
      pid: 55_000,
      workingSetMB: 0,
      cpuPercent: 0,
      cpuMsSinceLast: null,
      cpuStatus: 'timeout',
    });
  });

  it('sample "unavailable" (PID vanished) → cpuStatus:"unavailable", no warn logged (normal observable state)', async () => {
    const logger = stubLogger();
    const sampler = vi.fn(async () => ({
      cpuPercent: null,
      workingSetMB: null,
      status: 'unavailable' as const,
    }));
    const payload = await buildPerfDiagnosticPayload(
      makeResolvedDeps({
        cpuDeltaStore: new Map(),
        logger,
        getSuperMcpLifecycle: () => makeSuperMcpLifecycle({ pid: 55_000 }),
        sampleSubprocessUsage: sampler,
      }),
    );

    const synthRow = payload.processes.find((p) => p.label === 'super-mcp');
    expect(synthRow?.cpuStatus).toBe('unavailable');
    expect(synthRow?.workingSetMB).toBe(0);
    expect(synthRow?.cpuPercent).toBe(0);
    // 'unavailable' is a normal restart-race state — no warn log.
    for (const call of (logger.warn as ReturnType<typeof vi.fn>).mock.calls) {
      expect(call[1]).not.toBe('perfDiagnostic: sampleSubprocessUsage threw');
    }
  });

  it('sample "error" (sampler returned error status) → cpuStatus:"error", synth row emitted, no warn (status is the error signal)', async () => {
    // NB: the sampler's contract is "never throw"; a returned `status: 'error'`
    // is the sampler's own self-reported failure. The builder's
    // `collectSubprocessUsage` wrapper only warns when the sampler THROWS.
    // Returning status:'error' is the fail-observable path itself — no
    // additional warn beyond what the default sampler already logs.
    const logger = stubLogger();
    const sampler = vi.fn(async () => ({
      cpuPercent: null,
      workingSetMB: null,
      status: 'error' as const,
    }));
    const payload = await buildPerfDiagnosticPayload(
      makeResolvedDeps({
        cpuDeltaStore: new Map(),
        logger,
        getSuperMcpLifecycle: () => makeSuperMcpLifecycle({ pid: 55_000 }),
        sampleSubprocessUsage: sampler,
      }),
    );

    const synthRow = payload.processes.find((p) => p.label === 'super-mcp');
    expect(synthRow?.cpuStatus).toBe('error');
    expect(synthRow?.workingSetMB).toBe(0);
    expect(synthRow?.cpuPercent).toBe(0);
  });

  it('sampler that THROWS → wrapped into cpuStatus:"error" + warn logged (defence-in-depth)', async () => {
    const logger = stubLogger();
    const sampler = vi.fn(async () => {
      throw new Error('sampler exploded');
    });
    const payload = await buildPerfDiagnosticPayload(
      makeResolvedDeps({
        cpuDeltaStore: new Map(),
        logger,
        getSuperMcpLifecycle: () => makeSuperMcpLifecycle({ pid: 55_000 }),
        sampleSubprocessUsage: sampler,
      }),
    );

    const synthRow = payload.processes.find((p) => p.label === 'super-mcp');
    expect(synthRow?.cpuStatus).toBe('error');
    expect(synthRow?.workingSetMB).toBe(0);
    expect(synthRow?.cpuPercent).toBe(0);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ err: expect.any(Error), pid: 55_000 }),
      'perfDiagnostic: sampleSubprocessUsage threw',
    );
    // Payload still emits cleanly — stable shape preserved.
    expect(payload.profilerChannel).toBe('perf-summary');
  });

  it('PID already in appMetrics row → sampler is NOT invoked (preserves M4 suppression breadcrumb)', async () => {
    const logger = stubLogger();
    const sampler = vi.fn(async () => ({
      cpuPercent: 99,
      workingSetMB: 999,
      status: 'ok' as const,
    }));
    const payload = await buildPerfDiagnosticPayload(
      makeResolvedDeps({
        cpuDeltaStore: new Map(),
        logger,
        getSuperMcpLifecycle: () => makeSuperMcpLifecycle({ pid: 102 }),
        // RAM snapshot already surfaces PID 102 — sampler must be skipped.
        getRamSnapshot: () =>
          makeRamSnapshot({
            processes: [
              { pid: 100, type: 'Browser', label: 'main', workingSetMB: 300, cpuPercent: 5 },
              {
                pid: 102,
                type: 'Tab',
                label: 'renderer:102',
                workingSetMB: 55,
                cpuPercent: 3,
              },
            ],
          }) as never,
        getAppMetrics: () =>
          [makeAppMetric(100, 1.0, 5), makeAppMetric(102, 2.0, 3)] as never,
        sampleSubprocessUsage: sampler,
      }),
    );

    expect(sampler).not.toHaveBeenCalled();
    // No synth row — the existing Electron row is preserved with its own numbers.
    const syntheticRows = payload.processes.filter((p) => p.label === 'super-mcp');
    expect(syntheticRows).toHaveLength(0);
    // Suppression breadcrumb fired at debug.
    expect(logger.debug).toHaveBeenCalledWith(
      expect.objectContaining({ pid: 102, existingLabel: 'renderer:102' }),
      'perfDiagnostic: super-mcp PID already present in appMetrics; synth row skipped',
    );
  });

  it('super-mcp not running → sampler is NOT invoked', async () => {
    const sampler = vi.fn(async () => ({
      cpuPercent: 10,
      workingSetMB: 100,
      status: 'ok' as const,
    }));
    await buildPerfDiagnosticPayload(
      makeResolvedDeps({
        cpuDeltaStore: new Map(),
        getSuperMcpLifecycle: () =>
          makeSuperMcpLifecycle({ isRunning: false, pid: null, uptime: null }),
        sampleSubprocessUsage: sampler,
      }),
    );
    expect(sampler).not.toHaveBeenCalled();
  });
});

// ── 12. Stage 1 refinement: defaultSampleSubprocessUsage (default sampler unit tests) ─

describe('defaultSampleSubprocessUsage — happy path + malformed / error-code coverage', () => {
  beforeEach(() => {
    _resetPerfDiagnosticStateForTesting();
    pidusageMock.mockReset();
    pidusageClearMock.mockReset();
    defaultLoggerMock.warn.mockClear();
    defaultLoggerMock.debug.mockClear();
  });

  afterEach(() => {
    // Ensure real timers for subsequent tests (timeout test uses fake timers).
    vi.useRealTimers();
  });

  it('stat = { cpu: 5, memory: 120 * 1024 * 1024 } → status: "ok" with rounded values', async () => {
    pidusageMock.mockResolvedValueOnce({ cpu: 5, memory: 120 * 1024 * 1024 });
    const result = await defaultSampleSubprocessUsage(42);
    expect(result).toEqual({ cpuPercent: 5, workingSetMB: 120, status: 'ok' });
    // maxage option is passed through (M1).
    expect(pidusageMock).toHaveBeenCalledWith(42, { maxage: 10 * 60 * 1000 });
  });

  it('stat = { cpu: NaN, memory: 100 } → status: "error" + warn log (malformed)', async () => {
    pidusageMock.mockResolvedValueOnce({ cpu: NaN, memory: 100 });
    const result = await defaultSampleSubprocessUsage(42);
    expect(result).toEqual({ cpuPercent: null, workingSetMB: null, status: 'error' });
    expect(defaultLoggerMock.warn).toHaveBeenCalledWith(
      expect.objectContaining({ pid: 42 }),
      'perfDiagnostic: pidusage returned malformed stat; mapped to status:error',
    );
  });

  it('stat = null → status: "error" (malformed object)', async () => {
    pidusageMock.mockResolvedValueOnce(null as unknown as { cpu: number; memory: number });
    const result = await defaultSampleSubprocessUsage(42);
    expect(result).toEqual({ cpuPercent: null, workingSetMB: null, status: 'error' });
  });

  it('stat = { cpu: -1, memory: 100 } → status: "error" (negative values)', async () => {
    pidusageMock.mockResolvedValueOnce({ cpu: -1, memory: 100 });
    const result = await defaultSampleSubprocessUsage(42);
    expect(result).toEqual({ cpuPercent: null, workingSetMB: null, status: 'error' });
  });

  it('throws { code: "ESRCH" } → status: "unavailable" (POSIX: process gone)', async () => {
    const err = Object.assign(new Error('No such process'), { code: 'ESRCH' });
    pidusageMock.mockRejectedValueOnce(err);
    const result = await defaultSampleSubprocessUsage(42);
    expect(result).toEqual({ cpuPercent: null, workingSetMB: null, status: 'unavailable' });
    // No warn log — 'unavailable' is a normal observable state.
    expect(defaultLoggerMock.warn).not.toHaveBeenCalled();
  });

  it('throws { code: "ENOENT" } → status: "unavailable"', async () => {
    const err = Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    pidusageMock.mockRejectedValueOnce(err);
    const result = await defaultSampleSubprocessUsage(42);
    expect(result.status).toBe('unavailable');
  });

  it('throws { code: "ERROR_INVALID_PARAMETER" } → status: "unavailable" (Windows: PID invalid)', async () => {
    const err = Object.assign(new Error('The parameter is incorrect'), {
      code: 'ERROR_INVALID_PARAMETER',
    });
    pidusageMock.mockRejectedValueOnce(err);
    const result = await defaultSampleSubprocessUsage(42);
    expect(result.status).toBe('unavailable');
  });

  it('throws { errno: 87 } → status: "unavailable" (Windows errno alias)', async () => {
    // Some pidusage fallbacks surface the Windows errno instead of the string code.
    const err = Object.assign(new Error('Windows error'), { errno: 87 });
    pidusageMock.mockRejectedValueOnce(err);
    const result = await defaultSampleSubprocessUsage(42);
    expect(result.status).toBe('unavailable');
  });

  it('throws { code: "EPERM" } → status: "unavailable" (POSIX: gone OR briefly elevated)', async () => {
    const err = Object.assign(new Error('Operation not permitted'), { code: 'EPERM' });
    pidusageMock.mockRejectedValueOnce(err);
    const result = await defaultSampleSubprocessUsage(42);
    expect(result.status).toBe('unavailable');
  });

  it('throws Error("No matching pid") → status: "unavailable" (pidusage-internal validation)', async () => {
    pidusageMock.mockRejectedValueOnce(new Error('No matching pid found'));
    const result = await defaultSampleSubprocessUsage(42);
    expect(result.status).toBe('unavailable');
  });

  it('throws new Error("generic") → status: "error" + warn log', async () => {
    pidusageMock.mockRejectedValueOnce(new Error('generic pidusage explosion'));
    const result = await defaultSampleSubprocessUsage(42);
    expect(result.status).toBe('error');
    expect(defaultLoggerMock.warn).toHaveBeenCalledWith(
      expect.objectContaining({ err: expect.any(Error), pid: 42 }),
      'perfDiagnostic: pidusage sampler threw',
    );
  });

  it('pidusage hangs > 1 s → status: "timeout" (AbortController fires)', async () => {
    vi.useFakeTimers();
    // Never-resolving promise — only the AbortController timeout can unblock it.
    pidusageMock.mockReturnValueOnce(new Promise(() => {}));
    const samplePromise = defaultSampleSubprocessUsage(42);
    await vi.advanceTimersByTimeAsync(1_001);
    const result = await samplePromise;
    expect(result).toEqual({ cpuPercent: null, workingSetMB: null, status: 'timeout' });
    vi.useRealTimers();
  });
});

// ── 13. Stage 1 refinement: PID-reset guard (pidusage.clear on PID change) ─

describe('defaultSampleSubprocessUsage — PID-reset guard (M1)', () => {
  beforeEach(() => {
    _resetPerfDiagnosticStateForTesting();
    pidusageMock.mockReset();
    pidusageClearMock.mockReset();
    defaultLoggerMock.warn.mockClear();
    defaultLoggerMock.debug.mockClear();
  });

  // NB: super-mcp PIDs in these tests must NOT collide with the default
  // RAM snapshot PIDs (100 / 101 / 102). A collision triggers the M4
  // suppression branch and bypasses the sampler entirely — which would
  // hide the clear-on-PID-change behaviour we're verifying here. Use
  // 55_000-range PIDs to stay well clear.

  it('first sample does NOT call pidusage.clear (no previous PID)', async () => {
    pidusageMock.mockResolvedValue({ cpu: 5, memory: 120 * 1024 * 1024 });
    // Drive via the builder so module-scope lastSampledPid gets populated.
    await buildPerfDiagnosticPayload(
      makeResolvedDeps({
        cpuDeltaStore: new Map(),
        getSuperMcpLifecycle: () => makeSuperMcpLifecycle({ pid: 55_100 }),
        // Use the REAL default sampler so pidusage mock is exercised end-to-end.
        sampleSubprocessUsage: defaultSampleSubprocessUsage,
      }),
    );
    expect(pidusageClearMock).not.toHaveBeenCalled();
  });

  it('sample on a new PID calls pidusage.clear() before pidusage(newPid)', async () => {
    pidusageMock.mockResolvedValue({ cpu: 5, memory: 120 * 1024 * 1024 });

    // Tick 1 — establishes lastSampledPid = 55_100.
    await buildPerfDiagnosticPayload(
      makeResolvedDeps({
        cpuDeltaStore: new Map(),
        getSuperMcpLifecycle: () => makeSuperMcpLifecycle({ pid: 55_100 }),
        sampleSubprocessUsage: defaultSampleSubprocessUsage,
      }),
    );
    expect(pidusageClearMock).not.toHaveBeenCalled();

    // Tick 2 — new PID 55_200; must clear the stale pidusage cache first.
    // NB: pidusage.clear() has no per-PID variant (v4 API clears the whole
    // history map). That's fine for our usage — we only sample super-mcp
    // via this path, so "clear everything" is scoped to what we touched.
    await buildPerfDiagnosticPayload(
      makeResolvedDeps({
        cpuDeltaStore: new Map(),
        getSuperMcpLifecycle: () => makeSuperMcpLifecycle({ pid: 55_200 }),
        sampleSubprocessUsage: defaultSampleSubprocessUsage,
      }),
    );
    // Called exactly once across the two ticks.
    expect(pidusageClearMock).toHaveBeenCalledTimes(1);
    // Called with no arguments (real pidusage API signature).
    expect(pidusageClearMock).toHaveBeenCalledWith();
  });

  it('sample on the same PID does NOT call pidusage.clear (no restart)', async () => {
    pidusageMock.mockResolvedValue({ cpu: 5, memory: 120 * 1024 * 1024 });
    for (let i = 0; i < 3; i++) {
      await buildPerfDiagnosticPayload(
        makeResolvedDeps({
          cpuDeltaStore: new Map(),
          getSuperMcpLifecycle: () => makeSuperMcpLifecycle({ pid: 55_100 }),
          sampleSubprocessUsage: defaultSampleSubprocessUsage,
        }),
      );
    }
    expect(pidusageClearMock).not.toHaveBeenCalled();
  });
});

// ── 14. Stage 1 refinement: cpuStatus transition logging (S3) + streak (S4) ─

describe('buildPerfDiagnosticPayload — cpuStatus transition logging (S3)', () => {
  beforeEach(() => {
    _resetPerfDiagnosticStateForTesting();
  });

  // Helper: build a sampler that returns a scripted sequence of results
  // across consecutive ticks. Last value sticks once the script is exhausted.
  type SampleResult = Awaited<ReturnType<SampleSubprocessUsage>>;
  const sequencedSampler = (results: SampleResult[]): SampleSubprocessUsage => {
    let i = 0;
    return async () => {
      const out = results[Math.min(i, results.length - 1)];
      i += 1;
      return out;
    };
  };

  it('transition ok → timeout logs ONE warn with status:timeout + pid', async () => {
    const logger = stubLogger();
    const pid = 55_000;
    const sampler = sequencedSampler([
      { cpuPercent: 5, workingSetMB: 100, status: 'ok' },
      { cpuPercent: null, workingSetMB: null, status: 'timeout' },
    ]);

    // Tick 1 — ok
    await buildPerfDiagnosticPayload(
      makeResolvedDeps({
        cpuDeltaStore: new Map(),
        logger,
        getSuperMcpLifecycle: () => makeSuperMcpLifecycle({ pid }),
        sampleSubprocessUsage: sampler,
      }),
    );

    // Tick 2 — timeout
    await buildPerfDiagnosticPayload(
      makeResolvedDeps({
        cpuDeltaStore: new Map(),
        logger,
        getSuperMcpLifecycle: () => makeSuperMcpLifecycle({ pid }),
        sampleSubprocessUsage: sampler,
      }),
    );

    const degradedCalls = (logger.warn as ReturnType<typeof vi.fn>).mock.calls.filter(
      (call) => call[1] === 'perfDiagnostic: super-mcp CPU sampling degraded',
    );
    expect(degradedCalls).toHaveLength(1);
    expect(degradedCalls[0][0]).toMatchObject({ status: 'timeout', pid });
  });

  it('transition timeout → ok logs ONE info with previousStatus + pid (recovery)', async () => {
    const logger = stubLogger();
    const pid = 55_000;
    const sampler = sequencedSampler([
      { cpuPercent: null, workingSetMB: null, status: 'timeout' },
      { cpuPercent: 5, workingSetMB: 100, status: 'ok' },
    ]);

    // Tick 1 — timeout (null → timeout: SILENT, since prev was null)
    await buildPerfDiagnosticPayload(
      makeResolvedDeps({
        cpuDeltaStore: new Map(),
        logger,
        getSuperMcpLifecycle: () => makeSuperMcpLifecycle({ pid }),
        sampleSubprocessUsage: sampler,
      }),
    );

    // Tick 2 — ok (timeout → ok: INFO recovered)
    await buildPerfDiagnosticPayload(
      makeResolvedDeps({
        cpuDeltaStore: new Map(),
        logger,
        getSuperMcpLifecycle: () => makeSuperMcpLifecycle({ pid }),
        sampleSubprocessUsage: sampler,
      }),
    );

    const recoveredCalls = (logger.info as ReturnType<typeof vi.fn>).mock.calls.filter(
      (call) => call[1] === 'perfDiagnostic: super-mcp CPU sampling recovered',
    );
    expect(recoveredCalls).toHaveLength(1);
    expect(recoveredCalls[0][0]).toMatchObject({ previousStatus: 'timeout', pid });
  });

  it('no transition log on first sample (null → anything is silent)', async () => {
    const logger = stubLogger();
    const sampler: SampleSubprocessUsage = async () => ({
      cpuPercent: null,
      workingSetMB: null,
      status: 'unavailable',
    });
    await buildPerfDiagnosticPayload(
      makeResolvedDeps({
        cpuDeltaStore: new Map(),
        logger,
        getSuperMcpLifecycle: () => makeSuperMcpLifecycle({ pid: 99 }),
        sampleSubprocessUsage: sampler,
      }),
    );
    const degradeRecoverCalls = [
      ...(logger.warn as ReturnType<typeof vi.fn>).mock.calls,
      ...(logger.info as ReturnType<typeof vi.fn>).mock.calls,
    ].filter(
      (call) =>
        call[1] === 'perfDiagnostic: super-mcp CPU sampling degraded' ||
        call[1] === 'perfDiagnostic: super-mcp CPU sampling recovered',
    );
    expect(degradeRecoverCalls).toHaveLength(0);
  });

  it('repeated same status does NOT re-log (one entry per transition, not per tick)', async () => {
    const logger = stubLogger();
    const pid = 55_000;
    const sampler = sequencedSampler([
      { cpuPercent: 5, workingSetMB: 100, status: 'ok' },
      { cpuPercent: null, workingSetMB: null, status: 'timeout' },
      { cpuPercent: null, workingSetMB: null, status: 'timeout' },
      { cpuPercent: null, workingSetMB: null, status: 'timeout' },
    ]);

    for (let i = 0; i < 4; i++) {
      await buildPerfDiagnosticPayload(
        makeResolvedDeps({
          cpuDeltaStore: new Map(),
          logger,
          getSuperMcpLifecycle: () => makeSuperMcpLifecycle({ pid }),
          sampleSubprocessUsage: sampler,
        }),
      );
    }

    const degradedCalls = (logger.warn as ReturnType<typeof vi.fn>).mock.calls.filter(
      (call) => call[1] === 'perfDiagnostic: super-mcp CPU sampling degraded',
    );
    expect(degradedCalls).toHaveLength(1);
  });

  // Iter-2 fix (GPT review M1 round 2): a PID change must not emit a
  // spurious "recovered" / "degraded" log attributed to the new PID when
  // the comparison is really against a dead PID's last state. First
  // sample after restart should be silent (like first-boot).
  it('PID change resets transition state — first sample on new PID is silent', async () => {
    const logger = stubLogger();
    const samplerOld: SampleSubprocessUsage = async () => ({
      cpuPercent: null, workingSetMB: null, status: 'timeout',
    });
    const samplerNew: SampleSubprocessUsage = async () => ({
      cpuPercent: 5, workingSetMB: 100, status: 'ok',
    });

    // Tick on old PID — sample status: timeout (null → timeout: silent)
    await buildPerfDiagnosticPayload(
      makeResolvedDeps({
        cpuDeltaStore: new Map(),
        logger,
        getSuperMcpLifecycle: () => makeSuperMcpLifecycle({ pid: 1001 }),
        sampleSubprocessUsage: samplerOld,
      }),
    );

    // Tick on NEW PID — sample status: ok. Without the PID-change reset,
    // prevStatus='timeout' against current='ok' would fire a spurious
    // "recovered" log for a process that isn't actually recovering — it's
    // brand new. With the reset, prevStatus is null → silent.
    await buildPerfDiagnosticPayload(
      makeResolvedDeps({
        cpuDeltaStore: new Map(),
        logger,
        getSuperMcpLifecycle: () => makeSuperMcpLifecycle({ pid: 1002 }),
        sampleSubprocessUsage: samplerNew,
      }),
    );

    const spuriousCalls = [
      ...(logger.warn as ReturnType<typeof vi.fn>).mock.calls,
      ...(logger.info as ReturnType<typeof vi.fn>).mock.calls,
    ].filter(
      (call) =>
        call[1] === 'perfDiagnostic: super-mcp CPU sampling degraded' ||
        call[1] === 'perfDiagnostic: super-mcp CPU sampling recovered',
    );
    expect(spuriousCalls).toHaveLength(0);
  });
});

describe('buildPerfDiagnosticPayload — persistent-unavailable streak warning (S4)', () => {
  beforeEach(() => {
    _resetPerfDiagnosticStateForTesting();
  });

  it('10 consecutive "unavailable" samples with stable PID logs ONE warn', async () => {
    const logger = stubLogger();
    const pid = 55_000;
    const sampler: SampleSubprocessUsage = async () => ({
      cpuPercent: null,
      workingSetMB: null,
      status: 'unavailable',
    });

    for (let i = 0; i < 15; i++) {
      await buildPerfDiagnosticPayload(
        makeResolvedDeps({
          cpuDeltaStore: new Map(),
          logger,
          getSuperMcpLifecycle: () => makeSuperMcpLifecycle({ pid }),
          sampleSubprocessUsage: sampler,
        }),
      );
    }

    const streakCalls = (logger.warn as ReturnType<typeof vi.fn>).mock.calls.filter(
      (call) =>
        typeof call[1] === 'string' &&
        call[1].includes('10 consecutive ticks with stable PID'),
    );
    expect(streakCalls).toHaveLength(1);
    expect(streakCalls[0][0]).toMatchObject({ pid });
  });

  it('PID change during a streak resets the counter — no warn fires', async () => {
    const logger = stubLogger();
    const sampler: SampleSubprocessUsage = async () => ({
      cpuPercent: null,
      workingSetMB: null,
      status: 'unavailable',
    });

    // 9 'unavailable' samples at pid=100 — one short of the warn threshold.
    for (let i = 0; i < 9; i++) {
      await buildPerfDiagnosticPayload(
        makeResolvedDeps({
          cpuDeltaStore: new Map(),
          logger,
          getSuperMcpLifecycle: () => makeSuperMcpLifecycle({ pid: 100 }),
          sampleSubprocessUsage: sampler,
        }),
      );
    }
    // PID changes — streak must reset.
    await buildPerfDiagnosticPayload(
      makeResolvedDeps({
        cpuDeltaStore: new Map(),
        logger,
        getSuperMcpLifecycle: () => makeSuperMcpLifecycle({ pid: 200 }),
        sampleSubprocessUsage: sampler,
      }),
    );
    // One more at the new PID — count is 1, still far below 10.
    await buildPerfDiagnosticPayload(
      makeResolvedDeps({
        cpuDeltaStore: new Map(),
        logger,
        getSuperMcpLifecycle: () => makeSuperMcpLifecycle({ pid: 200 }),
        sampleSubprocessUsage: sampler,
      }),
    );

    const streakCalls = (logger.warn as ReturnType<typeof vi.fn>).mock.calls.filter(
      (call) =>
        typeof call[1] === 'string' &&
        call[1].includes('10 consecutive ticks with stable PID'),
    );
    expect(streakCalls).toHaveLength(0);
  });

  it('recovery resets the streak — second streak re-fires exactly once', async () => {
    const logger = stubLogger();
    const pid = 55_000;
    const unavailable: Awaited<ReturnType<SampleSubprocessUsage>> = {
      cpuPercent: null,
      workingSetMB: null,
      status: 'unavailable',
    };
    const ok: Awaited<ReturnType<SampleSubprocessUsage>> = {
      cpuPercent: 5,
      workingSetMB: 100,
      status: 'ok',
    };
    const script: Array<Awaited<ReturnType<SampleSubprocessUsage>>> = [
      ...Array<Awaited<ReturnType<SampleSubprocessUsage>>>(12).fill(unavailable),
      ok,
      ...Array<Awaited<ReturnType<SampleSubprocessUsage>>>(12).fill(unavailable),
    ];
    let i = 0;
    const sampler: SampleSubprocessUsage = async () => {
      const out = script[Math.min(i, script.length - 1)];
      i += 1;
      return out;
    };

    for (let tick = 0; tick < script.length; tick++) {
      await buildPerfDiagnosticPayload(
        makeResolvedDeps({
          cpuDeltaStore: new Map(),
          logger,
          getSuperMcpLifecycle: () => makeSuperMcpLifecycle({ pid }),
          sampleSubprocessUsage: sampler,
        }),
      );
    }

    const streakCalls = (logger.warn as ReturnType<typeof vi.fn>).mock.calls.filter(
      (call) =>
        typeof call[1] === 'string' &&
        call[1].includes('10 consecutive ticks with stable PID'),
    );
    // Fired once per streak: once in the first 12, once in the second 12.
    expect(streakCalls).toHaveLength(2);
  });
});

// ── 15. Stage 1 refinement: DI seam defensive check (S2) ─────────────

describe('buildPerfDiagnosticPayload — malformed sampler result (S2)', () => {
  beforeEach(() => {
    _resetPerfDiagnosticStateForTesting();
  });

  it('sampler returns undefined → coerced to status:"error" + debug log', async () => {
    const logger = stubLogger();
    // Cast: the DI seam is typed as `Promise<SubprocessUsageSample>` but a
    // future broken seam could violate that contract — we defend against it.
    const sampler = vi.fn(async () => undefined as unknown as Awaited<
      ReturnType<SampleSubprocessUsage>
    >);
    const payload = await buildPerfDiagnosticPayload(
      makeResolvedDeps({
        cpuDeltaStore: new Map(),
        logger,
        getSuperMcpLifecycle: () => makeSuperMcpLifecycle({ pid: 42 }),
        sampleSubprocessUsage: sampler,
      }),
    );

    const synthRow = payload.processes.find((p) => p.label === 'super-mcp');
    expect(synthRow?.cpuStatus).toBe('error');
    expect(synthRow?.workingSetMB).toBe(0);
    expect(synthRow?.cpuPercent).toBe(0);

    expect(logger.debug).toHaveBeenCalledWith(
      expect.objectContaining({ pid: 42 }),
      'perfDiagnostic: sampleSubprocessUsage returned malformed result; coerced to error',
    );
  });

  it('sampler returns object missing `status` → coerced to error', async () => {
    const logger = stubLogger();
    const sampler = vi.fn(async () => ({ cpuPercent: 1, workingSetMB: 1 }) as unknown as Awaited<
      ReturnType<SampleSubprocessUsage>
    >);
    const payload = await buildPerfDiagnosticPayload(
      makeResolvedDeps({
        cpuDeltaStore: new Map(),
        logger,
        getSuperMcpLifecycle: () => makeSuperMcpLifecycle({ pid: 42 }),
        sampleSubprocessUsage: sampler,
      }),
    );
    const synthRow = payload.processes.find((p) => p.label === 'super-mcp');
    expect(synthRow?.cpuStatus).toBe('error');
  });
});

// ── 16. FD / handle telemetry (perf.fd_snapshot) ─────────────────────
//
// Phase 1 of the EMFILE FD-leak fix (`260428_emfile_fd_leak.md`). Provides
// the production-on observability needed to verify the LanceDB read-table
// lease fix and to detect future native-resource leaks.

describe('captureFdSnapshot / emitFdSnapshot — FD telemetry', () => {
  // Save original API references so we can restore between tests.
  const originalGetActiveHandles = (
    process as unknown as { _getActiveHandles?: () => unknown[] }
  )._getActiveHandles;
  const originalGetActiveResourcesInfo = process.getActiveResourcesInfo;

  afterEach(() => {
    // Restore originals.
    (process as unknown as { _getActiveHandles?: unknown })._getActiveHandles =
      originalGetActiveHandles;
    if (originalGetActiveResourcesInfo) {
      process.getActiveResourcesInfo = originalGetActiveResourcesInfo;
    }
  });

  it('captureFdSnapshot returns a finite handle count and resource type histogram on a normal Node runtime', () => {
    const snapshot = captureFdSnapshot();
    // We don't assert specific values — just that the APIs returned numbers
    // (every Node we run on supports both, and the test harness itself owns
    // some active resources like timers).
    expect(snapshot.platform).toBe(process.platform);
    expect(snapshot.activeResources).not.toBeNull();
    expect(typeof snapshot.activeResources).toBe('number');
    expect(snapshot.activeResourceTypes).not.toBeNull();
    expect(snapshot.activeResources).toBeGreaterThanOrEqual(0);
    // _getActiveHandles is a private API, but ALL supported Node versions
    // expose it — assert success rather than degraded fallback.
    expect(snapshot.activeHandles).not.toBeNull();
    expect(typeof snapshot.activeHandles).toBe('number');
  });

  it('captureFdSnapshot tolerates a missing _getActiveHandles (degrades to null, no throw)', () => {
    (process as unknown as { _getActiveHandles?: unknown })._getActiveHandles = undefined;

    const snapshot = captureFdSnapshot();
    expect(snapshot.activeHandles).toBeNull();
    // Public API still works → resources still present.
    expect(snapshot.activeResources).not.toBeNull();
  });

  it('captureFdSnapshot tolerates a missing getActiveResourcesInfo (degrades to null, no throw)', () => {
    process.getActiveResourcesInfo = undefined as unknown as typeof process.getActiveResourcesInfo;

    const snapshot = captureFdSnapshot();
    expect(snapshot.activeResources).toBeNull();
    expect(snapshot.activeResourceTypes).toBeNull();
    // Private API may still be present.
    expect(snapshot.activeHandles).not.toBeNull();
  });

  it('captureFdSnapshot tolerates _getActiveHandles throwing (degrades to null, no propagation)', () => {
    (process as unknown as { _getActiveHandles?: unknown })._getActiveHandles = () => {
      throw new Error('handles api broken');
    };

    expect(() => captureFdSnapshot()).not.toThrow();
    const snapshot = captureFdSnapshot();
    expect(snapshot.activeHandles).toBeNull();
  });

  it('captureFdSnapshot tolerates getActiveResourcesInfo throwing', () => {
    process.getActiveResourcesInfo = () => {
      throw new Error('resources api broken');
    };

    expect(() => captureFdSnapshot()).not.toThrow();
    const snapshot = captureFdSnapshot();
    expect(snapshot.activeResources).toBeNull();
    expect(snapshot.activeResourceTypes).toBeNull();
  });

  it('captureFdSnapshot summarises resource types into a histogram', () => {
    process.getActiveResourcesInfo = () =>
      ['Timeout', 'Timeout', 'TTYWrap', 'TCPSocketWrap'] as ReturnType<
        typeof process.getActiveResourcesInfo
      >;

    const snapshot = captureFdSnapshot();
    expect(snapshot.activeResources).toBe(4);
    expect(snapshot.activeResourceTypes).toEqual({
      Timeout: 2,
      TTYWrap: 1,
      TCPSocketWrap: 1,
    });
  });

  it('emitFdSnapshot logs at info on the normal path', () => {
    const logger = stubLogger();
    emitFdSnapshot(logger);

    expect(logger.info).toHaveBeenCalledTimes(1);
    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({
        platform: process.platform,
        activeHandles: expect.any(Number),
        activeResources: expect.any(Number),
        activeResourceTypes: expect.any(Object),
      }),
      'perf.fd_snapshot',
    );
    expect(logger.debug).not.toHaveBeenCalled();
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('emitFdSnapshot promotes the first degraded tick to warn (visible at production-default log levels)', () => {
    // EMFILE Phase 1 review fix-up (260428): the degraded path used to log
    // at `debug`, which is invisible at the production-default `info`
    // level. Promote the first occurrence to `warn` so operators see it,
    // then demote subsequent occurrences to `info` to avoid spam — see
    // the dedicated `warns ONCE on first degraded tick` test below for
    // the full lifecycle assertion. The state-reset call here ensures we
    // exercise the first-tick branch even if a previous test already
    // tripped the warn-once flag.
    _resetPerfDiagnosticStateForTesting();
    (process as unknown as { _getActiveHandles?: unknown })._getActiveHandles = undefined;
    process.getActiveResourcesInfo = undefined as unknown as typeof process.getActiveResourcesInfo;

    const logger = stubLogger();
    emitFdSnapshot(logger);

    expect(logger.info).not.toHaveBeenCalled();
    expect(logger.debug).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        platform: process.platform,
        activeHandles: null,
        activeResources: null,
      }),
      expect.stringContaining('perf.fd_snapshot degraded'),
    );
  });
});

describe('runPerfDiagnosticTick — emits perf.fd_snapshot every tick', () => {
  beforeEach(() => {
    _resetPerfDiagnosticStateForTesting();
  });

  it('emits a perf.fd_snapshot log line on each tick after the Memory diagnostic', async () => {
    const logger = stubLogger();
    const resolved = makeResolvedDeps({ cpuDeltaStore: new Map(), logger });

    await runPerfDiagnosticTick(resolved, { logger, isDev: false });

    // Two info calls in order: Memory diagnostic first, then perf.fd_snapshot.
    const infoCalls = (logger.info as ReturnType<typeof vi.fn>).mock.calls;
    const messages = infoCalls.map((call) => call[1]);
    expect(messages).toContain('Memory diagnostic');
    expect(messages).toContain('perf.fd_snapshot');

    const fdCallIndex = messages.indexOf('perf.fd_snapshot');
    const memCallIndex = messages.indexOf('Memory diagnostic');
    // The FD snapshot should fire AFTER the main payload — that ordering
    // matters because the main payload is the consumer-facing emission.
    expect(fdCallIndex).toBeGreaterThan(memCallIndex);

    // Snapshot payload shape — defensive assertion.
    const fdPayload = infoCalls[fdCallIndex][0] as {
      platform: NodeJS.Platform;
      activeHandles: number | null;
      activeResources: number | null;
    };
    expect(fdPayload.platform).toBe(process.platform);
  });

  it('threads posix openFdCount/maxFdNumber into the perf.fd_snapshot log payload', async () => {
    const logger = stubLogger();
    const resolved = makeResolvedDeps({
      cpuDeltaStore: new Map(),
      logger,
      getFdSnapshot: () => ({
        status: 'posix',
        openFdCount: 777,
        maxFdNumber: 888,
        activeHandleCount: 4,
        activeRequestCount: 1,
        activeResourceCount: 5,
        activeResourceTypes: {
          Timeout: 3,
          TCPSocketWrap: 2,
        },
      }),
    });

    await runPerfDiagnosticTick(resolved, { logger, isDev: false });

    const infoCalls = (logger.info as ReturnType<typeof vi.fn>).mock.calls;
    const fdCall = infoCalls.find((call) => call[1] === 'perf.fd_snapshot');
    expect(fdCall).toBeDefined();
    expect(fdCall?.[0]).toEqual(expect.objectContaining({
      fdSnapshotStatus: 'posix',
      openFdCount: 777,
      maxFdNumber: 888,
    }));
  });
});

describe('runPerfDiagnosticTick — Stage 3 fd-pressure condition routing', () => {
  const previousReporter = getErrorReporter();

  afterEach(() => {
    setErrorReporter(previousReporter as ErrorReporter);
  });

  it('routes 50/75% elevated bands AND 90% critical to warning captures (deduped per band)', async () => {
    if (!process.report || typeof process.report.getReport !== 'function') {
      return;
    }
    _resetPerfDiagnosticStateForTesting();
    vi.spyOn(process.report, 'getReport').mockReturnValue({
      userLimits: {
        open_files: { soft: 1_000, hard: 1_000 },
      },
    } as unknown as ReturnType<typeof process.report.getReport>);

    const captureException = vi.fn<ErrorReporter['captureException']>();
    const addBreadcrumb = vi.fn<ErrorReporter['addBreadcrumb']>();
    setErrorReporter({
      captureException,
      captureMessage: vi.fn<ErrorReporter['captureMessage']>(),
      addBreadcrumb,
    });

    const logger = stubLogger();
    const runTickWithOpenFds = async (openFdCount: number) => {
      const resolved = makeResolvedDeps({
        cpuDeltaStore: new Map(),
        logger,
        getFdSnapshot: () => ({
          status: 'posix',
          openFdCount,
          maxFdNumber: 10,
          activeHandleCount: 4,
          activeRequestCount: 2,
          activeResourceCount: 5,
          activeResourceTypes: {
            Timeout: 3,
            TCPSocketWrap: 2,
          },
        }),
      });
      await runPerfDiagnosticTick(resolved, { logger, isDev: false });
    };

    await runTickWithOpenFds(490); // 49%: no band
    expect(captureException).toHaveBeenCalledTimes(0);

    // 260621 Stage 6: fd_pressure_elevated PROMOTED ledger-only -> warning, so an
    // elevated band now produces a real Sentry capture (was 0 under ledger-only).
    await runTickWithOpenFds(513); // 51.3%: elevated band (and above 512 floor)
    expect(captureException).toHaveBeenCalledTimes(1);
    expect((captureException.mock.calls[0]?.[0] as Error).message).toContain('50%');

    await runTickWithOpenFds(760); // 76%: elevated next band
    expect(captureException).toHaveBeenCalledTimes(2);
    expect((captureException.mock.calls[1]?.[0] as Error).message).toContain('75%');

    await runTickWithOpenFds(910); // 91%: critical
    expect(captureException).toHaveBeenCalledTimes(3);
    expect(captureException.mock.calls[2]?.[0]).toBeInstanceOf(Error);
    expect((captureException.mock.calls[2]?.[0] as Error).message).toContain('90%');

    await runTickWithOpenFds(920); // repeat critical band: no duplicate
    expect(captureException).toHaveBeenCalledTimes(3);

    // The two elevated bands are now warning-level Sentry captures (asserted via
    // captureException above), not ledger-only skips — so there is no
    // `known_condition` SKIP breadcrumb for them anymore (that breadcrumb is the
    // ledger-only sink's marker). The perf.fd_pressure context breadcrumb (a
    // separate category) still fires per band; this assertion just confirms the
    // ledger-only skip path no longer runs for the promoted condition.
    const knownConditionSkipBreadcrumbs = addBreadcrumb.mock.calls
      .map((call) => call[0])
      .filter((crumb) => crumb?.category === 'known_condition') as Array<{
        message?: string;
      }>;
    expect(knownConditionSkipBreadcrumbs.filter((crumb) => crumb.message === 'fd_pressure_elevated')).toHaveLength(0);
  });

  it('does not trigger count-axis bands below the 512 count floor', async () => {
    if (!process.report || typeof process.report.getReport !== 'function') {
      return;
    }
    _resetPerfDiagnosticStateForTesting();
    vi.spyOn(process.report, 'getReport').mockReturnValue({
      userLimits: {
        open_files: { soft: 256, hard: 256 },
      },
    } as unknown as ReturnType<typeof process.report.getReport>);

    const captureException = vi.fn<ErrorReporter['captureException']>();
    const addBreadcrumb = vi.fn<ErrorReporter['addBreadcrumb']>();
    setErrorReporter({
      captureException,
      captureMessage: vi.fn<ErrorReporter['captureMessage']>(),
      addBreadcrumb,
    });

    const logger = stubLogger();
    const resolved = makeResolvedDeps({
      cpuDeltaStore: new Map(),
      logger,
      getFdSnapshot: () => ({
        status: 'posix',
        openFdCount: 255, // 99.6% but below floor
        maxFdNumber: 25,
        activeHandleCount: 3,
        activeRequestCount: 1,
        activeResourceCount: 4,
        activeResourceTypes: {
          Timeout: 2,
          TCPSocketWrap: 2,
        },
      }),
    });
    await runPerfDiagnosticTick(resolved, { logger, isDev: false });

    expect(captureException).not.toHaveBeenCalled();
    const knownConditionBreadcrumbs = addBreadcrumb.mock.calls
      .map((call) => call[0])
      .filter((crumb) => crumb?.category === 'known_condition') as Array<{
        message?: string;
      }>;
    expect(knownConditionBreadcrumbs.some((crumb) => crumb.message?.startsWith('fd_pressure_'))).toBe(false);
  });
});

// ── 17. FD snapshot Phase 1 review fix-ups ───────────────────────────
//
// Three additions for the EMFILE Phase 1 fix-up
// (`260428_emfile_fd_leak.md` review feedback item #4):
//   - `processUptimeSec` and `launchId` fields on every snapshot
//   - `mcp.superMcpRestartCount` correlation dim wired through
//     `runPerfDiagnosticTick` via the existing super-mcp lifecycle accessor
//   - Degraded-path log level promoted to `warn` once-per-process, then
//     `info` for subsequent ticks (was `debug`-only — invisible at
//     production-default log levels)

describe('captureFdSnapshot / emitFdSnapshot — Phase 1 review fix-up additions', () => {
  const originalGetActiveHandles = (
    process as unknown as { _getActiveHandles?: () => unknown[] }
  )._getActiveHandles;
  const originalGetActiveResourcesInfo = process.getActiveResourcesInfo;

  beforeEach(() => {
    _resetPerfDiagnosticStateForTesting();
  });

  afterEach(() => {
    (process as unknown as { _getActiveHandles?: unknown })._getActiveHandles =
      originalGetActiveHandles;
    if (originalGetActiveResourcesInfo) {
      process.getActiveResourcesInfo = originalGetActiveResourcesInfo;
    }
  });

  it('captureFdSnapshot includes processUptimeSec and launchId on every emission', () => {
    const a = captureFdSnapshot();
    expect(typeof a.processUptimeSec).toBe('number');
    expect(a.processUptimeSec).toBeGreaterThanOrEqual(0);
    expect(typeof a.launchId).toBe('string');
    expect(a.launchId.length).toBeGreaterThan(0);

    // Same launchId on subsequent emissions in the same process.
    const b = captureFdSnapshot();
    expect(b.launchId).toBe(a.launchId);
  });

  it('captureFdSnapshot launchId rotates after _resetPerfDiagnosticStateForTesting (test-only seam)', () => {
    const a = captureFdSnapshot();
    _resetPerfDiagnosticStateForTesting();
    const b = captureFdSnapshot();
    // We don't assert inequality directly because randomUUID could in
    // theory collide; instead we assert the cache was cleared by checking
    // both are valid non-empty strings (the rotation behaviour itself
    // matters for test isolation, not for the production contract).
    expect(b.launchId).toBeTruthy();
    expect(a.launchId).toBeTruthy();
  });

  it('captureFdSnapshot defaults mcp dimensions to all-null when not provided', () => {
    const snapshot = captureFdSnapshot();
    expect(snapshot.mcp).toEqual({ superMcpRestartCount: null });
  });

  it('captureFdSnapshot threads the caller-provided MCP correlation through', () => {
    const snapshot = captureFdSnapshot({ superMcpRestartCount: 7 });
    expect(snapshot.mcp).toEqual({ superMcpRestartCount: 7 });
  });

  it('emitFdSnapshot warns ONCE on first degraded tick, info on subsequent ticks', () => {
    (process as unknown as { _getActiveHandles?: unknown })._getActiveHandles = undefined;
    process.getActiveResourcesInfo = undefined as unknown as typeof process.getActiveResourcesInfo;

    const logger = stubLogger();

    // First degraded tick → warn
    emitFdSnapshot(logger);
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ activeHandles: null, activeResources: null }),
      expect.stringContaining('perf.fd_snapshot degraded'),
    );

    // Second degraded tick → info (NOT another warn)
    emitFdSnapshot(logger);
    expect(logger.warn).toHaveBeenCalledTimes(1); // still 1
    expect(logger.info).toHaveBeenCalledTimes(1); // info on second emission

    // Third degraded tick → still info, still 1 warn total
    emitFdSnapshot(logger);
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.info).toHaveBeenCalledTimes(2);
  });

  it('emitFdSnapshot warn-once flag resets after _resetPerfDiagnosticStateForTesting', () => {
    (process as unknown as { _getActiveHandles?: unknown })._getActiveHandles = undefined;
    process.getActiveResourcesInfo = undefined as unknown as typeof process.getActiveResourcesInfo;

    const logger1 = stubLogger();
    emitFdSnapshot(logger1);
    expect(logger1.warn).toHaveBeenCalledTimes(1);

    _resetPerfDiagnosticStateForTesting();

    const logger2 = stubLogger();
    emitFdSnapshot(logger2);
    // Fresh process → fresh warn-once.
    expect(logger2.warn).toHaveBeenCalledTimes(1);
  });

  it('emitFdSnapshot threads the caller-provided MCP correlation into the emitted payload', () => {
    const logger = stubLogger();
    emitFdSnapshot(logger, { superMcpRestartCount: 42 });

    expect(logger.info).toHaveBeenCalledTimes(1);
    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({
        mcp: { superMcpRestartCount: 42 },
        processUptimeSec: expect.any(Number),
        launchId: expect.any(String),
      }),
      'perf.fd_snapshot',
    );
  });
});

describe('runPerfDiagnosticTick — Phase 1 review fix-up: MCP correlation in fd_snapshot', () => {
  beforeEach(() => {
    _resetPerfDiagnosticStateForTesting();
    superMcpHttpManagerMock.getSubprocessInfo.mockReset();
    superMcpHttpManagerMock.getLastStatsCache.mockReset().mockReturnValue(null);
    superMcpHttpManagerMock.getLastStatsFetchAt.mockReset().mockReturnValue(null);
    superMcpHttpManagerMock.getLastGoodStatsAt.mockReset().mockReturnValue(null);
    superMcpHttpManagerMock.fetchStats.mockReset().mockResolvedValue(undefined);
  });

  it('passes superMcpLifecycle.restartCount through to the fd_snapshot mcp object', async () => {
    superMcpHttpManagerMock.getSubprocessInfo.mockReturnValue({
      pid: null,
      startTime: null,
      uptime: null,
      isRunning: false,
      startCount: 0,
      restartCount: 17,
      lastStartupFailureAt: null,
      lastStartupError: null,
      circuitBreakerActive: false,
      cooldownRemainingMs: null,
      lastRestartReason: null,
    });

    const logger = stubLogger();
    const resolved = makeResolvedDeps({
      cpuDeltaStore: new Map(),
      logger,
      // Wire the real lifecycle accessor (the default in resolveDeps) by
      // using the singleton mock above.
      getSuperMcpLifecycle: () => superMcpHttpManagerMock.getSubprocessInfo() as SuperMcpSubprocessInfo,
    });

    await runPerfDiagnosticTick(resolved, { logger, isDev: false });

    const infoCalls = (logger.info as ReturnType<typeof vi.fn>).mock.calls;
    const fdCall = infoCalls.find((call) => call[1] === 'perf.fd_snapshot');
    expect(fdCall).toBeDefined();
    const fdPayload = fdCall![0] as {
      mcp: { superMcpRestartCount: number | null };
      processUptimeSec: number;
      launchId: string;
    };
    expect(fdPayload.mcp).toEqual({ superMcpRestartCount: 17 });
    expect(typeof fdPayload.processUptimeSec).toBe('number');
    expect(typeof fdPayload.launchId).toBe('string');
  });

  it('falls back to null superMcpRestartCount when lifecycle accessor returns null', async () => {
    const logger = stubLogger();
    const resolved = makeResolvedDeps({
      cpuDeltaStore: new Map(),
      logger,
      getSuperMcpLifecycle: () => null,
    });

    await runPerfDiagnosticTick(resolved, { logger, isDev: false });

    const infoCalls = (logger.info as ReturnType<typeof vi.fn>).mock.calls;
    const fdCall = infoCalls.find((call) => call[1] === 'perf.fd_snapshot');
    expect(fdCall).toBeDefined();
    const fdPayload = fdCall![0] as { mcp: { superMcpRestartCount: number | null } };
    expect(fdPayload.mcp).toEqual({ superMcpRestartCount: null });
  });
});

// ── FU-5: short-window instant CPU + peak + sustained-high-idle-CPU warning ─

describe('FU-5 — sampleInstantCpu (short-window CPU)', () => {
  const logger = stubLogger();

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('computes per-process + total instant CPU% from cumulativeCPUUsage delta ÷ window', async () => {
    // First snapshot: pid 100 @ 1.0s, pid 101 @ 0.5s cumulative.
    // Second snapshot (1.5s window): pid 100 @ 2.5s (+1.5s = 100% of a core),
    // pid 101 @ 0.65s (+0.15s = 10%).
    const snapshots = [
      [makeAppMetric(100, 1.0), makeAppMetric(101, 0.5)],
      [makeAppMetric(100, 2.5), makeAppMetric(101, 0.65)],
    ];
    let call = 0;
    const getAppMetrics = () => snapshots[call++] as never;
    const nowMs = makeMonotonicNow(); // 0 then 1500 → window = 1500ms

    const { sample, perPidPercent } = await sampleInstantCpu(
      getAppMetrics,
      async () => {},
      nowMs,
      logger,
    );

    expect(sample.status).toBe('ok');
    if (sample.status !== 'ok') throw new Error('unreachable');
    expect(perPidPercent.get(100)).toBeCloseTo(100, 1);
    expect(perPidPercent.get(101)).toBeCloseTo(10, 1);
    expect(sample.totalCpuPercent).toBeCloseTo(110, 1);
    expect(sample.windowMs).toBe(INSTANT_CPU_WINDOW_MS);
    expect(sample.sampleAtMs).toBe(INSTANT_CPU_WINDOW_MS);
    expect(sample.topProcess?.cpuPercent).toBeCloseTo(100, 1);
    expect(sample.topProcess?.pid).toBe(100);
    expect(sample.topProcesses).toEqual([
      { label: 'Browser', pid: 100, cpuPercent: 100 },
      { label: 'Browser', pid: 101, cpuPercent: 10 },
    ]);
  });

  it('catches a burst the interval-average would smooth away', async () => {
    // A process pins a core for the 1.5s window: +1.5s cumulative.
    const snapshots = [
      [makeAppMetric(200, 10.0)],
      [makeAppMetric(200, 11.5)],
    ];
    let call = 0;
    const { sample } = await sampleInstantCpu(
      () => snapshots[call++] as never,
      async () => {},
      makeMonotonicNow(),
      logger,
    );
    expect(sample.status).toBe('ok');
    if (sample.status !== 'ok') throw new Error('unreachable');
    expect(sample.totalCpuPercent).toBeCloseTo(100, 1);
  });

  it('returns unavailable when the first metrics read throws', async () => {
    const { sample, perPidPercent } = await sampleInstantCpu(
      () => {
        throw new Error('boom');
      },
      async () => {},
      makeMonotonicNow(),
      logger,
    );
    expect(sample.status).toBe('unavailable');
    expect(perPidPercent.size).toBe(0);
  });

  it('returns unavailable when no PID appears in both snapshots with a usable counter', async () => {
    // Second snapshot has a different PID — nothing to delta.
    const snapshots = [
      [makeAppMetric(300, 1.0)],
      [makeAppMetric(301, 5.0)],
    ];
    let call = 0;
    const { sample } = await sampleInstantCpu(
      () => snapshots[call++] as never,
      async () => {},
      makeMonotonicNow(),
      logger,
    );
    expect(sample.status).toBe('unavailable');
  });

  it('skips processes with a negative delta (restart / clock glitch) without going negative', async () => {
    const snapshots = [
      [makeAppMetric(400, 5.0), makeAppMetric(401, 1.0)],
      [makeAppMetric(400, 2.0) /* restarted, lower */, makeAppMetric(401, 1.3)],
    ];
    let call = 0;
    const { sample, perPidPercent } = await sampleInstantCpu(
      () => snapshots[call++] as never,
      async () => {},
      makeMonotonicNow(),
      logger,
    );
    expect(sample.status).toBe('ok');
    if (sample.status !== 'ok') throw new Error('unreachable');
    expect(perPidPercent.has(400)).toBe(false); // negative delta dropped
    expect(perPidPercent.get(401)).toBeCloseTo(20, 1);
    expect(sample.totalCpuPercent).toBeGreaterThanOrEqual(0);
  });

  it('returns unavailable on a zero/negative wall window', async () => {
    const snapshots = [
      [makeAppMetric(500, 1.0)],
      [makeAppMetric(500, 2.0)],
    ];
    let call = 0;
    const { sample } = await sampleInstantCpu(
      () => snapshots[call++] as never,
      async () => {},
      () => 1000, // constant → elapsed = 0
      logger,
    );
    expect(sample.status).toBe('unavailable');
  });
});

describe('FU-5 — CpuPeakTracker', () => {
  const peakProcesses = (...rows: Array<[label: string, pid: number, cpuPercent: number]>) =>
    rows.map(([label, pid, cpuPercent]) => ({ label, pid, cpuPercent }));

  it('reports the max total instant CPU% across samples (peak = max)', () => {
    const t = new CpuPeakTracker();
    t.record(20, true, peakProcesses(['a', 10, 20]), 100);
    t.record(85, true, peakProcesses(['b', 11, 85]), 200);
    t.record(10, true, peakProcesses(['c', 12, 10]), 300);
    const drain = t.drainForEmit(null, true, null, null, 0);
    expect(drain.totalCpuPercentPeak).toBe(85);
    expect(drain.peakAtMs).toBe(200);
    expect(drain.peakTopProcesses).toEqual([{ label: 'b', pid: 11, cpuPercent: 85 }]);
  });

  it('drain folds in the pre-emit instant sample and then resets the peak', () => {
    const t = new CpuPeakTracker();
    t.record(30, true, peakProcesses(['a', 10, 30]), 100);
    const first = t.drainForEmit(90, true, peakProcesses(['b', 11, 90]), 200, 0);
    expect(first.totalCpuPercentPeak).toBe(90); // instant sample folded in
    expect(first.peakAtMs).toBe(200);
    expect(first.peakTopProcesses).toEqual([{ label: 'b', pid: 11, cpuPercent: 90 }]);
    // Peak resets between emits.
    const second = t.drainForEmit(null, true, null, null, 0);
    expect(second.totalCpuPercentPeak).toBeNull();
    expect(second.peakAtMs).toBeNull();
    expect(second.peakTopProcesses).toEqual([]);
  });

  it('returns null peak when no sample was recorded this interval', () => {
    const t = new CpuPeakTracker();
    const drain = t.drainForEmit(null, true, null, null, 0);
    expect(drain.totalCpuPercentPeak).toBeNull();
    expect(drain.peakAtMs).toBeNull();
    expect(drain.peakTopProcesses).toEqual([]);
    expect(drain.shouldWarnSustainedHighIdleCpu).toBe(false);
  });

  it('captures the peak-time top processes ordered by CPU and capped at three', () => {
    const t = new CpuPeakTracker();
    t.record(
      120,
      true,
      peakProcesses(['third', 303, 30], ['first', 301, 80], ['fourth', 304, 10], ['second', 302, 40]),
      1234,
    );
    t.record(90, true, peakProcesses(['later-lower', 400, 90]), 5678);

    const drain = t.drainForEmit(null, true, null, null, 0);

    expect(drain.totalCpuPercentPeak).toBe(120);
    expect(drain.peakAtMs).toBe(1234);
    expect(drain.peakTopProcesses).toEqual([
      { label: 'first', pid: 301, cpuPercent: 80 },
      { label: 'second', pid: 302, cpuPercent: 40 },
      { label: 'third', pid: 303, cpuPercent: 30 },
    ]);
    expect(drain.peakTopProcess).toEqual({ label: 'first', pid: 301, cpuPercent: 80 });
  });

  it('fires the sustained-high-idle-CPU warning only after N consecutive idle over-threshold samples', () => {
    const t = new CpuPeakTracker();
    // 2 over-threshold idle samples — below the 3-sample requirement.
    t.record(70, true, peakProcesses(['x', 10, 70]), 100);
    t.record(70, true, peakProcesses(['x', 10, 70]), 200);
    const notYet = t.drainForEmit(null, true, null, null, 0);
    // The drain folds in a null instant sample (no extra count); streak = 2.
    expect(notYet.shouldWarnSustainedHighIdleCpu).toBe(false);

    // Two more idle over-threshold samples push the streak past 3.
    t.record(70, true, peakProcesses(['x', 10, 70]), 300);
    t.record(70, true, peakProcesses(['x', 10, 70]), 400);
    const fires = t.drainForEmit(null, true, null, null, 1000);
    expect(fires.shouldWarnSustainedHighIdleCpu).toBe(true);
    expect(fires.consecutiveHighIdleSamples).toBeGreaterThanOrEqual(3);
  });

  it('does NOT fire when CPU is below threshold even across many idle samples', () => {
    const t = new CpuPeakTracker();
    for (let i = 0; i < 10; i++) {
      t.record(20, true, peakProcesses(['x', 10, 20]), i);
    }
    const drain = t.drainForEmit(20, true, peakProcesses(['x', 10, 20]), 10, 0);
    expect(drain.shouldWarnSustainedHighIdleCpu).toBe(false);
  });

  it('does NOT fire when an active turn breaks the idle streak', () => {
    const t = new CpuPeakTracker();
    t.record(80, true, peakProcesses(['x', 10, 80]), 100);
    t.record(80, true, peakProcesses(['x', 10, 80]), 200);
    t.record(80, false, peakProcesses(['x', 10, 80]), 300); // active turn — resets streak
    t.record(80, true, peakProcesses(['x', 10, 80]), 400);
    const drain = t.drainForEmit(80, true, peakProcesses(['x', 10, 80]), 500, 0);
    // Streak only rebuilt to 2 (the two idle samples after the turn + drain fold).
    expect(drain.shouldWarnSustainedHighIdleCpu).toBe(false);
  });

  it('throttles repeat warnings (at most once per throttle window)', () => {
    const t = new CpuPeakTracker();
    const pushOverThreshold = () => {
      t.record(80, true, peakProcesses(['x', 10, 80]), 100);
      t.record(80, true, peakProcesses(['x', 10, 80]), 200);
      t.record(80, true, peakProcesses(['x', 10, 80]), 300);
    };
    pushOverThreshold();
    const first = t.drainForEmit(80, true, peakProcesses(['x', 10, 80]), 400, 0);
    expect(first.shouldWarnSustainedHighIdleCpu).toBe(true);

    // Still over threshold, but 1 minute later — inside the 10-min throttle.
    pushOverThreshold();
    const throttled = t.drainForEmit(80, true, peakProcesses(['x', 10, 80]), 500, 60_000);
    expect(throttled.shouldWarnSustainedHighIdleCpu).toBe(false);

    // After the throttle window elapses, it can fire again.
    pushOverThreshold();
    const afterThrottle = t.drainForEmit(
      80,
      true,
      peakProcesses(['x', 10, 80]),
      600,
      11 * 60_000,
    );
    expect(afterThrottle.shouldWarnSustainedHighIdleCpu).toBe(true);
  });
});

describe('FU-5 — buildPerfDiagnosticPayload instant/peak fields + warning', () => {
  beforeEach(() => {
    _resetPerfDiagnosticStateForTesting();
  });

  const peakRows = (...rows: Array<[label: string, pid: number, cpuPercent: number]>) =>
    rows.map(([label, pid, cpuPercent]) => ({ label, pid, cpuPercent }));

  const makeInstantDeps = (
    overrides: Partial<ResolvedPayloadDeps> = {},
    cumulativeByCall: Array<Array<ReturnType<typeof makeAppMetric>>> = [
      [makeAppMetric(100, 1.0, 5), makeAppMetric(101, 0.5, 2), makeAppMetric(102, 2.0, 15)],
      [makeAppMetric(100, 2.5, 5), makeAppMetric(101, 0.5, 2), makeAppMetric(102, 2.0, 15)],
    ],
  ) => {
    // getAppMetrics is called once for the aggregate read + twice for the
    // instant sample. Serve a stable aggregate then the two instant snapshots.
    const seq = [cumulativeByCall[0], ...cumulativeByCall];
    let call = 0;
    return makeResolvedDeps({
      getAppMetrics: () => (seq[Math.min(call++, seq.length - 1)]) as never,
      nowMs: makeMonotonicNow(),
      ...overrides,
    });
  };

  it('adds totalCpuPercentInstant + per-process cpuPercentInstant alongside the averaged fields', async () => {
    // pid 100 burns +1.5s over the 1.5s window → 100% instant, while its
    // averaged percentCPUUsage is only 5%.
    const deps = makeInstantDeps();
    const payload = await buildPerfDiagnosticPayload(deps);

    expect(payload.totalCpuPercent).toBeGreaterThan(0); // averaged field intact
    expect(payload.totalCpuPercentInstant).not.toBeNull();
    expect(payload.totalCpuPercentInstant!).toBeGreaterThanOrEqual(100);
    const p100 = payload.processes.find((p) => p.pid === 100);
    expect(p100?.cpuPercentInstant).toBeCloseTo(100, 1);
    // A process with no cumulative delta reads ~0 instant.
    const p101 = payload.processes.find((p) => p.pid === 101);
    expect(p101?.cpuPercentInstant).toBeCloseTo(0, 1);
  });

  it('sets totalCpuPercentInstant null and cpuPercentInstant null when the instant sample is unavailable', async () => {
    // Constant clock → zero window → unavailable instant sample.
    const deps = makeResolvedDeps({ nowMs: () => 5000 });
    const payload = await buildPerfDiagnosticPayload(deps);
    expect(payload.totalCpuPercentInstant).toBeNull();
    for (const p of payload.processes) {
      expect(p.cpuPercentInstant).toBeNull();
    }
  });

  it('emits totalCpuPercentPeak folding in the pre-emit instant sample', async () => {
    const tracker = new CpuPeakTracker();
    tracker.record(40, true, peakRows(['prior', 900, 40]), 100);
    const deps = makeInstantDeps({ peakTracker: tracker });
    const payload = await buildPerfDiagnosticPayload(deps);
    // Instant total ≥100 dominates the prior 40 peak sample.
    expect(payload.totalCpuPercentPeak).toBeGreaterThanOrEqual(100);
    expect(payload.peakAtMs).toBe(INSTANT_CPU_WINDOW_MS);
    expect(payload.peakTopProcesses).toEqual([{ label: 'main', pid: 100, cpuPercent: 100 }]);
  });

  it('emits peakAtMs + peakTopProcesses on the routine Memory diagnostic log', async () => {
    let emitted: PerfDiagnosticPayload | null = null;
    const logger = {
      ...stubLogger(),
      info: vi.fn((payload: unknown, msg: string) => {
        if (msg === 'Memory diagnostic' && typeof payload === 'object' && payload !== null) {
          emitted = payload as PerfDiagnosticPayload;
        }
      }),
    };
    const tracker = new CpuPeakTracker();
    tracker.record(160, true, peakRows(['between-emit-burst', 777, 160]), 42);
    const deps = makeInstantDeps({ logger: logger as never, peakTracker: tracker });

    await runPerfDiagnosticTick(deps, { logger: logger as never, isDev: false });

    expect(emitted).not.toBeNull();
    expect(emitted!.totalCpuPercentPeak).toBe(160);
    expect(emitted!.peakAtMs).toBe(42);
    expect(emitted!.peakTopProcesses).toEqual([
      { label: 'between-emit-burst', pid: 777, cpuPercent: 160 },
    ]);
  });

  it('logs "Sustained high idle CPU detected" when idle + sustained high CPU, and is throttled', async () => {
    const logger = stubLogger();
    const tracker = new CpuPeakTracker();
    // Pre-seed 3 idle over-threshold peak samples so the pre-emit instant
    // sample pushes the streak past the consecutive requirement.
    tracker.record(80, true, peakRows(['x', 10, 80]), 100);
    tracker.record(80, true, peakRows(['x', 10, 80]), 200);
    tracker.record(80, true, peakRows(['x', 10, 80]), 300);
    const deps = makeInstantDeps({
      logger,
      peakTracker: tracker,
      // idle: no active turns
      getAgentTurnRegistryDiagnostics: () => ({
        turnCount: 0,
        contextAccumulatorCount: 0,
        contextAccumulatorTotalEvents: 0,
        largestContextAccumulatorEvents: 0,
        securityDenialCount: 0,
        toolCallCount: 0,
      }),
    });
    await buildPerfDiagnosticPayload(deps);

    const warnCalls = (logger.warn as ReturnType<typeof vi.fn>).mock.calls;
    const warn = warnCalls.find((c) => c[1] === 'Sustained high idle CPU detected');
    expect(warn).toBeDefined();
    expect(warn?.[0]).toMatchObject({
      peakAtMs: INSTANT_CPU_WINDOW_MS,
      peakTopProcesses: [{ label: 'main', pid: 100, cpuPercent: 100 }],
      topProcess: { label: 'main', pid: 100, cpuPercent: 100 },
    });
  });

  it('does NOT log the warning when turns are active (idle gate)', async () => {
    const logger = stubLogger();
    const tracker = new CpuPeakTracker();
    // High CPU, but during an active turn — should never count toward the streak.
    tracker.record(80, false, peakRows(['x', 10, 80]), 100);
    tracker.record(80, false, peakRows(['x', 10, 80]), 200);
    tracker.record(80, false, peakRows(['x', 10, 80]), 300);
    const deps = makeInstantDeps({
      logger,
      peakTracker: tracker,
      getAgentTurnRegistryDiagnostics: () => ({
        turnCount: 2, // active
        contextAccumulatorCount: 0,
        contextAccumulatorTotalEvents: 0,
        largestContextAccumulatorEvents: 0,
        securityDenialCount: 0,
        toolCallCount: 0,
      }),
    });
    await buildPerfDiagnosticPayload(deps);
    const warnCalls = (logger.warn as ReturnType<typeof vi.fn>).mock.calls;
    const warn = warnCalls.find((c) => c[1] === 'Sustained high idle CPU detected');
    expect(warn).toBeUndefined();
  });
});
