import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type SwitchTimingProbe = typeof import('../switchTimingProbe');

const importProbe = async (performanceMode: boolean): Promise<SwitchTimingProbe> => {
  vi.resetModules();
  vi.unstubAllEnvs();
  vi.stubEnv('VITE_PERFORMANCE', performanceMode ? 'true' : '');
  return import('../switchTimingProbe');
};

describe('switchTimingProbe', () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    warnSpy.mockRestore();
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  const perfLines = (): string[] =>
    (warnSpy.mock.calls as Array<[unknown, ...unknown[]]>)
      .map(([message]) => message)
      .filter((message): message is string =>
        typeof message === 'string' && message.startsWith('[SWITCH-PERF'),
      );

  it('no-ops outside VITE_PERFORMANCE=true', async () => {
    const probe = await importProbe(false);

    probe.beginSwitchTiming('session-disabled');
    probe.markEngineOpenDone('session-disabled', { wasCacheHit: true });
    probe.markPrimitiveStart('session-disabled');
    probe.markPrimitiveResolved('session-disabled', 'stable', true);
    probe.finishSwitchTiming('session-disabled');
    probe.markPaintAfterReveal('session-disabled');
    probe.abandonSwitchTimingIfMatches('session-disabled', 'failed');

    expect(perfLines()).toEqual([]);
  });

  it('emits one reveal line with expected buckets in performance mode', async () => {
    const probe = await importProbe(true);

    probe.beginSwitchTiming('session-normal-123456');
    probe.markEngineOpenDone('session-normal-123456', { wasCacheHit: true });
    probe.markPrimitiveStart('session-normal-123456');
    probe.markPrimitiveResolved('session-normal-123456', 'stable', true);
    probe.finishSwitchTiming('session-normal-123456');

    expect(perfLines()).toHaveLength(1);
    expect(perfLines()[0]).toContain('outcome=reveal');
    expect(perfLines()[0]).toContain('cache=HIT');
    expect(perfLines()[0]).toContain('primReason=stable');
    expect(perfLines()[0]).toContain('landed=true');
  });

  it('emits primitive diagnostics when supplied', async () => {
    const probe = await importProbe(true);

    probe.beginSwitchTiming('session-prim-123456');
    probe.markPrimitiveStart('session-prim-123456');
    probe.markPrimitiveResolved('session-prim-123456', 'stable', true, {
      primTotalMs: 321.4,
      msToFirstTerminalRow: 10,
      msToFirstAtBottomGeometry: 20,
      msToFirstStableFrame: 130,
      msToHoldStart: 150,
      finalHoldMs: 180,
      maxFrameGapMs: 30,
      framesOverGapThreshold: 0,
      resetsGeometryGap: 2,
      resetsTerminalRowMissing: 3,
      resetsQuiescenceFailed: 4,
      resetsResumedFromBlock: 0,
      activityScrollHeightChanges: 5,
      activityVirtualizerOnChange: 6,
      finalMessageCount: 7,
      finalTerminalIndex: 8,
    });
    probe.finishSwitchTiming('session-prim-123456');

    expect(perfLines()).toHaveLength(2);
    expect(perfLines()[1]).toContain('[SWITCH-PERF-PRIM]');
    expect(perfLines()[1]).toContain('primMs=321.4');
    expect(perfLines()[1]).toContain('resetsGeom=2');
    expect(perfLines()[1]).toContain('activityOnChange=6');
  });

  it('supersedes an in-flight span and only lets the replacement reveal', async () => {
    const probe = await importProbe(true);

    probe.beginSwitchTiming('session-A-123456');
    probe.markEngineOpenDone('session-A-123456', { wasCacheHit: false });
    probe.beginSwitchTiming('session-B-123456');
    probe.finishSwitchTiming('session-A-123456');
    probe.markEngineOpenDone('session-B-123456', { wasCacheHit: true });
    probe.finishSwitchTiming('session-B-123456');

    expect(perfLines()).toHaveLength(2);
    expect(perfLines()[0]).toContain('outcome=superseded');
    expect(perfLines()[1]).toContain('outcome=reveal');
    expect(perfLines()[1]).toContain('cache=HIT');
  });

  it('clears primitive result fields when a primitive retries for the same session', async () => {
    const probe = await importProbe(true);

    probe.beginSwitchTiming('session-retry-123456');
    probe.markPrimitiveStart('session-retry-123456');
    probe.markPrimitiveResolved('session-retry-123456', 'aborted', false);
    probe.markPrimitiveStart('session-retry-123456');
    probe.abandonSwitchTimingIfMatches('session-retry-123456', 'failed');

    expect(perfLines()).toHaveLength(1);
    expect(perfLines()[0]).not.toContain('primReason=aborted');
    expect(perfLines()[0]).not.toContain('landed=false');
  });

  it('emits paint timing once after reveal', async () => {
    const probe = await importProbe(true);

    probe.beginSwitchTiming('session-paint-123456');
    probe.finishSwitchTiming('session-paint-123456');
    probe.markPaintAfterReveal('session-paint-123456');
    probe.markPaintAfterReveal('session-paint-123456');

    expect(perfLines()).toHaveLength(2);
    expect(perfLines()[1]).toContain('[SWITCH-PERF-PAINT]');
    expect(perfLines()[1]).toContain('reveal→paint=');
  });

  it('does not throw when diagnostic logging fails in performance mode', async () => {
    const probe = await importProbe(true);
    warnSpy.mockImplementation(() => {
      throw new Error('console unavailable');
    });

    expect(() => {
      probe.beginSwitchTiming('session-log-a-123456');
      probe.beginSwitchTiming('session-log-b-123456');
      probe.finishSwitchTiming('session-log-b-123456');
    }).not.toThrow();
  });
});

// ── switch-scoped long-task attribution ────────────────────────────
//
// These tests inject a fake PerformanceObserver onto globalThis BEFORE
// importing the probe module, so the lazy install picks up the mock.

type LongTaskEntryInit = {
  startTime: number;
  duration: number;
  attribution?: Array<{
    containerType?: string;
    containerSrc?: string;
    containerName?: string;
  }>;
};

type LoafEntryInit = {
  startTime: number;
  duration: number;
  blockingDuration?: number;
  forcedStyleAndLayoutDuration?: number;
  scripts?: Array<{
    sourceURL?: string;
    sourceFunctionName?: string;
    invoker?: string;
  }>;
};

interface FakeObserver {
  callback: (list: { getEntries: () => PerformanceEntry[] }) => void;
  observed: boolean;
  options: PerformanceObserverInit | null;
}

const SAVED_PERF_OBS_SENTINEL = Symbol('saved-perf-obs');

interface GlobalWithSaved {
  [SAVED_PERF_OBS_SENTINEL]?: { value: typeof PerformanceObserver | undefined };
}

function savePerformanceObserverOnce(): void {
  const g = globalThis as unknown as GlobalWithSaved;
  if (!g[SAVED_PERF_OBS_SENTINEL]) {
    g[SAVED_PERF_OBS_SENTINEL] = {
      value: (globalThis as unknown as { PerformanceObserver?: typeof PerformanceObserver })
        .PerformanceObserver,
    };
  }
}

function restorePerformanceObserver(): void {
  const g = globalThis as unknown as GlobalWithSaved;
  const saved = g[SAVED_PERF_OBS_SENTINEL];
  if (!saved) return;
  const target = globalThis as unknown as { PerformanceObserver?: typeof PerformanceObserver };
  if (saved.value === undefined) {
    target.PerformanceObserver = undefined;
  } else {
    target.PerformanceObserver = saved.value;
  }
}

describe('switchTimingProbe — long-task attribution', () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;
  let nowSpy: ReturnType<typeof vi.spyOn>;
  let currentTime: number;
  let activeObservers: FakeObserver[];

  const installMockObserver = (
    { observeThrows = false }: { observeThrows?: boolean } = {},
  ): void => {
    savePerformanceObserverOnce();
    activeObservers = [];
    class MockPerfObs {
      callback: FakeObserver['callback'];
      observed = false;
      options: PerformanceObserverInit | null = null;
      constructor(cb: FakeObserver['callback']) {
        this.callback = cb;
        activeObservers.push(this as unknown as FakeObserver);
      }
      observe(opts: PerformanceObserverInit): void {
        if (observeThrows) throw new Error('longtask unsupported');
        this.observed = true;
        this.options = opts;
      }
      disconnect(): void {
        /* no-op */
      }
      takeRecords(): PerformanceEntry[] {
        return [];
      }
    }
    (globalThis as unknown as { PerformanceObserver: typeof PerformanceObserver }).PerformanceObserver =
      MockPerfObs as unknown as typeof PerformanceObserver;
  };

  const removePerformanceObserver = (): void => {
    savePerformanceObserverOnce();
    (globalThis as unknown as { PerformanceObserver?: typeof PerformanceObserver }).PerformanceObserver =
      undefined;
  };

  const fireLongTasks = (entries: LongTaskEntryInit[]): void => {
    const list = {
      getEntries: () =>
        entries.map((e) => ({
          startTime: e.startTime,
          duration: e.duration,
          entryType: 'longtask',
          name: 'self',
          toJSON: () => ({}),
          attribution: e.attribution,
        }) as unknown as PerformanceEntry),
    };
    for (const o of activeObservers) {
      o.callback(list);
    }
  };

  const fireLoafs = (entries: LoafEntryInit[]): void => {
    const list = {
      getEntries: () =>
        entries.map((e) => ({
          startTime: e.startTime,
          duration: e.duration,
          entryType: 'long-animation-frame',
          name: 'long-animation-frame',
          toJSON: () => ({}),
          blockingDuration: e.blockingDuration,
          forcedStyleAndLayoutDuration: e.forcedStyleAndLayoutDuration,
          scripts: e.scripts,
        }) as unknown as PerformanceEntry),
    };
    for (const o of activeObservers) {
      if (o.options?.type === 'long-animation-frame') {
        o.callback(list);
      }
    }
  };

  const importProbeWithEnv = async (
    performanceMode: boolean,
  ): Promise<typeof import('../switchTimingProbe')> => {
    vi.resetModules();
    vi.unstubAllEnvs();
    vi.stubEnv('VITE_PERFORMANCE', performanceMode ? 'true' : '');
    return import('../switchTimingProbe');
  };

  beforeEach(() => {
    currentTime = 1000;
    activeObservers = [];
    nowSpy = vi.spyOn(performance, 'now').mockImplementation(() => currentTime);
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    warnSpy.mockRestore();
    nowSpy.mockRestore();
    restorePerformanceObserver();
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  const longLines = (): string[] =>
    (warnSpy.mock.calls as Array<[unknown, ...unknown[]]>)
      .map(([m]) => m)
      .filter((m): m is string =>
        typeof m === 'string' && m.startsWith('[SWITCH-PERF-LONG]'),
      );

  const loafLines = (): string[] =>
    (warnSpy.mock.calls as Array<[unknown, ...unknown[]]>)
      .map(([m]) => m)
      .filter((m): m is string =>
        typeof m === 'string' && m.startsWith('[SWITCH-PERF-LOAF]'),
      );

  it('does not install observer when VITE_PERFORMANCE is disabled', async () => {
    installMockObserver();
    const probe = await importProbeWithEnv(false);
    probe.beginSwitchTiming('session-off-12345678');
    expect(activeObservers).toHaveLength(0);
    expect(longLines()).toEqual([]);
  });

  it('installs PerformanceObserver lazily on first beginSwitchTiming', async () => {
    installMockObserver();
    const probe = await importProbeWithEnv(true);

    expect(activeObservers).toHaveLength(0);
    probe.beginSwitchTiming('session-lazy-12345678');
    expect(activeObservers.length).toBeGreaterThanOrEqual(1);
    expect(activeObservers.some((o) => o.options?.type === 'longtask')).toBe(true);

    // Subsequent begins must NOT install another observer (module-level, idempotent).
    const installedCount = activeObservers.length;
    probe.beginSwitchTiming('session-lazy-22345678');
    expect(activeObservers).toHaveLength(installedCount);
  });

  it('fails closed when PerformanceObserver is undefined', async () => {
    removePerformanceObserver();
    const probe = await importProbeWithEnv(true);

    expect(() => {
      probe.beginSwitchTiming('session-noobs-12345678');
      currentTime = 1500;
      probe.finishSwitchTiming('session-noobs-12345678');
      currentTime = 1600;
      probe.markPaintAfterReveal('session-noobs-12345678');
    }).not.toThrow();

    expect(longLines()).toEqual([]);
  });

  it('fails closed when PerformanceObserver.observe throws', async () => {
    installMockObserver({ observeThrows: true });
    const probe = await importProbeWithEnv(true);

    expect(() => {
      probe.beginSwitchTiming('session-throws-12345678');
      currentTime = 1500;
      probe.finishSwitchTiming('session-throws-12345678');
      currentTime = 1600;
      probe.markPaintAfterReveal('session-throws-12345678');
    }).not.toThrow();

    expect(longLines()).toEqual([]);
  });

  it('emits LONG line on paint with overlap-filtered counts and durations', async () => {
    installMockObserver();
    const probe = await importProbeWithEnv(true);

    currentTime = 1000;
    probe.beginSwitchTiming('session-long-12345678');

    fireLongTasks([
      // Inside window: starts at 1050, lasts 120ms → ends 1170. relStart=50.
      {
        startTime: 1050,
        duration: 120,
        attribution: [{ containerType: 'window', containerSrc: '', containerName: 'main' }],
      },
      // Inside window: starts at 1300, lasts 200ms → ends 1500. relStart=300.
      {
        startTime: 1300,
        duration: 200,
        attribution: [{ containerType: 'window', containerSrc: '', containerName: 'main' }],
      },
      // Outside window: ends before clickAt.
      { startTime: 900, duration: 50 },
      // Outside window: starts after paintAt.
      { startTime: 1600, duration: 80 },
    ]);

    currentTime = 1500;
    probe.finishSwitchTiming('session-long-12345678');
    currentTime = 1550;
    probe.markPaintAfterReveal('session-long-12345678');

    const lines = longLines();
    expect(lines).toHaveLength(1);
    const line = lines[0]!;
    expect(line).toContain('sessionId=session-');
    expect(line).toContain('count=2');
    expect(line).toContain('sumMs=320.0');
    expect(line).toContain('maxMs=200.0');
    expect(line).toContain('firstStartMs=50.0');
    // containerName 'main' → scrubbed category 'script' + labelPath 'main'.
    expect(line).toContain('attribs=script(main)×2');
  });

  it('emits LONG line on abandon outcomes without a paint mark', async () => {
    installMockObserver();
    const probe = await importProbeWithEnv(true);

    currentTime = 2000;
    probe.beginSwitchTiming('session-abnd-12345678');
    fireLongTasks([
      {
        startTime: 2050,
        duration: 100,
        attribution: [{ containerType: 'window', containerSrc: '', containerName: 'app' }],
      },
    ]);
    currentTime = 2200;
    probe.abandonSwitchTimingIfMatches('session-abnd-12345678', 'cancelled');

    const lines = longLines();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('count=1');
    expect(lines[0]).toContain('sumMs=100.0');
    expect(lines[0]).toContain('attribs=script(app)×1');
  });

  it('skips LONG line when no long task overlaps the span window', async () => {
    installMockObserver();
    const probe = await importProbeWithEnv(true);

    currentTime = 3000;
    probe.beginSwitchTiming('session-noov-12345678');
    fireLongTasks([
      // Long task in the distant past — ends well before clickAt=3000.
      { startTime: 2700, duration: 50 },
    ]);
    currentTime = 3100;
    probe.finishSwitchTiming('session-noov-12345678');
    currentTime = 3150;
    probe.markPaintAfterReveal('session-noov-12345678');

    expect(longLines()).toEqual([]);
  });

  it('does not emit LONG on reveal until paint fires', async () => {
    installMockObserver();
    const probe = await importProbeWithEnv(true);

    currentTime = 4000;
    probe.beginSwitchTiming('session-noearly-1234');
    fireLongTasks([{ startTime: 4050, duration: 200 }]);
    currentTime = 4300;
    probe.finishSwitchTiming('session-noearly-1234');

    // After reveal but BEFORE paint: no LONG line yet.
    expect(longLines()).toEqual([]);

    currentTime = 4400;
    probe.markPaintAfterReveal('session-noearly-1234');
    // Now LONG should appear, covering click→paint.
    const lines = longLines();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('count=1');
  });

  it('emits LOAF line with script attribution when supported', async () => {
    installMockObserver();
    (
      globalThis as unknown as {
        PerformanceObserver: typeof PerformanceObserver & { supportedEntryTypes?: string[] };
      }
    ).PerformanceObserver.supportedEntryTypes = ['longtask', 'long-animation-frame'];
    const probe = await importProbeWithEnv(true);

    currentTime = 5000;
    probe.beginSwitchTiming('session-loaf-12345678');
    fireLoafs([
      {
        startTime: 5050,
        duration: 220,
        blockingDuration: 160,
        forcedStyleAndLayoutDuration: 45,
        scripts: [
          {
            sourceURL: 'http://localhost:5173/src/renderer/components/MessageItem.tsx?t=123',
            sourceFunctionName: 'MessageItem',
          },
        ],
      },
    ]);
    currentTime = 5300;
    probe.finishSwitchTiming('session-loaf-12345678');
    currentTime = 5400;
    probe.markPaintAfterReveal('session-loaf-12345678');

    expect(loafLines()).toHaveLength(1);
    expect(loafLines()[0]).toContain('count=1');
    expect(loafLines()[0]).toContain('blockingMs=160.0');
    expect(loafLines()[0]).toContain('forcedStyleMs=45.0');
    expect(loafLines()[0]).toContain('MessageItem.tsx:MessageItem');
  });

  it('fails closed when LOAF is unsupported', async () => {
    installMockObserver();
    (
      globalThis as unknown as {
        PerformanceObserver: typeof PerformanceObserver & { supportedEntryTypes?: string[] };
      }
    ).PerformanceObserver.supportedEntryTypes = ['longtask'];
    const probe = await importProbeWithEnv(true);

    probe.beginSwitchTiming('session-no-loaf-12345678');
    currentTime = 5100;
    probe.finishSwitchTiming('session-no-loaf-12345678');
    currentTime = 5200;
    probe.markPaintAfterReveal('session-no-loaf-12345678');

    expect(loafLines()).toEqual([]);
  });
});
