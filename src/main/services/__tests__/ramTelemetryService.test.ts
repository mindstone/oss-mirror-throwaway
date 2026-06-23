import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock electron
vi.mock('electron', () => ({
  app: {
    getAppMetrics: vi.fn(() => [
      {
        pid: 1000,
        type: 'Browser',
        memory: { workingSetSize: 200 * 1024 }, // 200MB in KB
        cpu: { percentCPUUsage: 5.5 },
      },
      {
        pid: 1001,
        type: 'GPU',
        memory: { workingSetSize: 100 * 1024 },
        cpu: { percentCPUUsage: 2.3 },
      },
      {
        pid: 1002,
        type: 'Tab',
        memory: { workingSetSize: 150 * 1024 },
        cpu: { percentCPUUsage: 10.1 },
      },
    ]),
  },
  BrowserWindow: {
    getAllWindows: vi.fn(() => []),
  },
  powerSaveBlocker: {
    start: vi.fn(() => 1),
    stop: vi.fn(),
    isStarted: vi.fn(() => false),
  },
}));

vi.mock('@core/logger', () => ({
  createScopedLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
  }),
}));

vi.mock('@core/services/agentTurnRegistry', () => ({
  agentTurnRegistry: {
    getDiagnostics: vi.fn(() => ({
      turnCount: 2,
      contextAccumulatorCount: 1,
      contextAccumulatorTotalEvents: 50,
      largestContextAccumulatorEvents: 30,
      securityDenialCount: 0,
      toolCallCount: 5,
    })),
  },
}));

import {
  captureRamSnapshot,
  cacheRendererSnapshot,
  getProcessLabel,
  sanitizeProcessName,
  buildProcessLabelMap,
  registerNamedPid,
  unregisterNamedPid,
  getNamedPidRegistryForTesting,
  clearNamedPidRegistryForTesting,
  getNamedPidLabel,
  type RamSnapshot,
} from '../ramTelemetryService';

describe('ramTelemetryService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('captures a complete snapshot with correct structure', () => {
    const snapshot = captureRamSnapshot();

    expect(snapshot.timestamp).toBeGreaterThan(0);
    expect(snapshot.mainProcess.heapUsedMB).toBeGreaterThanOrEqual(0);
    expect(snapshot.mainProcess.rssMB).toBeGreaterThanOrEqual(0);
    expect(snapshot.mainProcess.externalMB).toBeGreaterThanOrEqual(0);
    expect(snapshot.mainProcess.arrayBuffersMB).toBeGreaterThanOrEqual(0);
  });

  it('includes per-process breakdown from app.getAppMetrics()', () => {
    const snapshot = captureRamSnapshot();

    expect(snapshot.processes).toHaveLength(3);
    expect(snapshot.processes[0]).toEqual({
      pid: 1000,
      type: 'Browser',
      label: 'main',
      workingSetMB: 200,
      cpuPercent: 5.5,
    });
    expect(snapshot.processes[1].label).toBe('gpu');
    expect(snapshot.processes[2].label).toMatch(/renderer:/);
  });

  it('computes totals correctly', () => {
    const snapshot = captureRamSnapshot();
    expect(snapshot.totals.workingSetMB).toBe(200 + 100 + 150);
    expect(snapshot.totals.processCount).toBe(3);
  });

  it('includes registry diagnostics', () => {
    const snapshot = captureRamSnapshot();
    expect(snapshot.registry.activeTurns).toBe(2);
    expect(snapshot.registry.contextAccumulators).toBe(1);
    expect(snapshot.registry.contextTotalEvents).toBe(50);
  });

  it('includes power save blocker status', () => {
    const snapshot = captureRamSnapshot();
    expect(snapshot.powerSaveBlocker).toBeDefined();
    expect(typeof snapshot.powerSaveBlocker.active).toBe('boolean');
    expect(typeof snapshot.powerSaveBlocker.refCount).toBe('number');
  });

  it('returns null renderer snapshot when none cached', () => {
    const snapshot = captureRamSnapshot();
    expect(snapshot.rendererSnapshot).toBeNull();
  });

  it('returns cached renderer snapshot when fresh', () => {
    cacheRendererSnapshot({
      timestamp: Date.now(),
      heapUsedMB: 85,
      heapTotalMB: 120,
      loadedSessions: 5,
      loadedMessages: 200,
    });

    const snapshot = captureRamSnapshot();
    expect(snapshot.rendererSnapshot).not.toBeNull();
    expect(snapshot.rendererSnapshot!.heapUsedMB).toBe(85);
  });

  it('discards stale renderer snapshot (>10 minutes old)', () => {
    cacheRendererSnapshot({
      timestamp: Date.now() - 11 * 60 * 1000,
      heapUsedMB: 85,
      heapTotalMB: 120,
      loadedSessions: 5,
      loadedMessages: 200,
    });

    const snapshot = captureRamSnapshot();
    expect(snapshot.rendererSnapshot).toBeNull();
  });

  it('degrades gracefully when app.getAppMetrics() throws (fail-observable)', async () => {
    // Simulate a rare shutdown-race where Electron's app metrics call throws.
    // captureRamSnapshot must still emit a snapshot (processes: [], zeroed
    // totals) so `perfDiagnosticService.buildPerfDiagnosticPayload` can
    // continue per the fail-observable contract.
    const { app: mockApp } = (await import('electron')) as any;
    mockApp.getAppMetrics.mockImplementationOnce(() => {
      throw new Error('app.getAppMetrics unavailable during shutdown');
    });

    const snapshot = captureRamSnapshot();
    expect(snapshot.processes).toHaveLength(0);
    expect(snapshot.totals.workingSetMB).toBe(0);
    expect(snapshot.totals.processCount).toBe(0);
    // Other fields still populated (mainProcess, registry, blocker, renderer).
    expect(snapshot.mainProcess).toBeDefined();
    expect(snapshot.registry).toBeDefined();
    expect(snapshot.powerSaveBlocker).toBeDefined();
  });

  describe('utility process labeling with name', () => {
    it('labels utility process with name from getAppMetrics', async () => {
      const { app: mockApp } = await import('electron') as any;
      mockApp.getAppMetrics.mockReturnValueOnce([
        {
          pid: 2000,
          type: 'Utility',
          name: 'Embedding Worker',
          memory: { workingSetSize: 500 * 1024 },
          cpu: { percentCPUUsage: 1.0 },
        },
      ]);

      const snapshot = captureRamSnapshot();
      expect(snapshot.processes[0].label).toBe('embedding-worker:2000');
    });

    it('falls back to utility:PID when name is empty', async () => {
      const { app: mockApp } = await import('electron') as any;
      mockApp.getAppMetrics.mockReturnValueOnce([
        {
          pid: 2001,
          type: 'Utility',
          name: '',
          memory: { workingSetSize: 100 * 1024 },
          cpu: { percentCPUUsage: 0.5 },
        },
      ]);

      const snapshot = captureRamSnapshot();
      expect(snapshot.processes[0].label).toBe('utility:2001');
    });

    it('falls back to utility:PID when name is undefined', async () => {
      const { app: mockApp } = await import('electron') as any;
      mockApp.getAppMetrics.mockReturnValueOnce([
        {
          pid: 2002,
          type: 'Utility',
          memory: { workingSetSize: 100 * 1024 },
          cpu: { percentCPUUsage: 0.5 },
        },
      ]);

      const snapshot = captureRamSnapshot();
      expect(snapshot.processes[0].label).toBe('utility:2002');
    });
  });
});

describe('sanitizeProcessName', () => {
  it('converts to lowercase kebab-case', () => {
    expect(sanitizeProcessName('Embedding Worker')).toBe('embedding-worker');
  });

  it('handles multi-word names', () => {
    expect(sanitizeProcessName('Pre-Turn Context Worker')).toBe('pre-turn-context-worker');
  });

  it('handles names with special characters', () => {
    expect(sanitizeProcessName('Audio Service (v2)')).toBe('audio-service-v2');
  });

  it('trims whitespace', () => {
    expect(sanitizeProcessName('  Embedding Worker  ')).toBe('embedding-worker');
  });

  it('returns empty string for empty input', () => {
    expect(sanitizeProcessName('')).toBe('');
  });

  it('returns empty string for whitespace-only input', () => {
    expect(sanitizeProcessName('   ')).toBe('');
  });

  it('handles single-word names', () => {
    expect(sanitizeProcessName('Network')).toBe('network');
  });
});

describe('getProcessLabel', () => {
  const emptyMap = new Map<number, string>();

  it('returns "main" for Browser type', () => {
    expect(getProcessLabel('Browser', 1000, emptyMap)).toBe('main');
  });

  it('returns "gpu" for GPU type', () => {
    expect(getProcessLabel('GPU', 1001, emptyMap)).toBe('gpu');
  });

  it('returns sanitized name:PID for Utility with name', () => {
    expect(getProcessLabel('Utility', 2000, emptyMap, 'Embedding Worker')).toBe('embedding-worker:2000');
  });

  it('returns utility:PID for Utility without name', () => {
    expect(getProcessLabel('Utility', 2001, emptyMap)).toBe('utility:2001');
  });

  it('returns utility:PID for Utility with empty name', () => {
    expect(getProcessLabel('Utility', 2002, emptyMap, '')).toBe('utility:2002');
  });

  it('returns label from map for Tab type', () => {
    const map = new Map<number, string>([[3000, 'mainUI']]);
    expect(getProcessLabel('Tab', 3000, map)).toBe('mainUI');
  });

  it('returns label from map for Renderer type', () => {
    const map = new Map<number, string>([[3001, 'gpuWorker']]);
    expect(getProcessLabel('Renderer', 3001, map)).toBe('gpuWorker');
  });

  it('returns renderer:PID for unknown Renderer PID', () => {
    expect(getProcessLabel('Renderer', 9999, emptyMap)).toBe('renderer:9999');
  });

  it('returns lowercase type:PID for unknown types', () => {
    expect(getProcessLabel('Zygote', 5000, emptyMap)).toBe('zygote:5000');
  });

  it('handles Index Health Worker name', () => {
    expect(getProcessLabel('Utility', 4000, emptyMap, 'Index Health Worker')).toBe('index-health-worker:4000');
  });

  it('handles Pre-Turn Context Worker name', () => {
    expect(getProcessLabel('Utility', 4001, emptyMap, 'Pre-Turn Context Worker')).toBe('pre-turn-context-worker:4001');
  });
});

// ── Stage 4a: named-PID registry ─────────────────────────────────────

describe('namedPidRegistry (Stage 4a)', () => {
  beforeEach(() => {
    clearNamedPidRegistryForTesting();
  });

  it('registers a PID with a sanitized label and exposes it via getNamedPidLabel', () => {
    registerNamedPid(7777, 'Super MCP');

    // Registry stores the sanitized label for downstream consumers to read
    // directly (via `getNamedPidLabel`). `buildProcessLabelMap` intentionally
    // does NOT surface registry entries — see M3 collision rationale.
    expect(getNamedPidLabel(7777)).toBe('super-mcp');

    const registry = getNamedPidRegistryForTesting();
    expect(registry.has(7777)).toBe(true);
    expect(registry.get(7777)?.label).toBe('super-mcp');
    expect(typeof registry.get(7777)?.registeredAt).toBe('number');
  });

  it('unregisterNamedPid removes the entry so getNamedPidLabel returns null', () => {
    registerNamedPid(8888, 'super-mcp');
    expect(getNamedPidLabel(8888)).toBe('super-mcp');

    unregisterNamedPid(8888);
    expect(getNamedPidLabel(8888)).toBeNull();
    expect(getNamedPidRegistryForTesting().has(8888)).toBe(false);
  });

  it('last-registration-wins: re-registering the same PID overwrites the prior label', () => {
    registerNamedPid(9000, 'super-mcp');
    registerNamedPid(9000, 'Some Other Subprocess');

    expect(getNamedPidLabel(9000)).toBe('some-other-subprocess');
  });

  it('ignores empty / whitespace-only labels (no polluting blanks)', () => {
    registerNamedPid(9001, '   ');
    expect(getNamedPidRegistryForTesting().has(9001)).toBe(false);
    expect(getNamedPidLabel(9001)).toBeNull();

    registerNamedPid(9002, '');
    expect(getNamedPidRegistryForTesting().has(9002)).toBe(false);
  });

  it('Electron-window mapping wins when a PID appears in both (registry is NOT merged)', async () => {
    // Register the named PID first.
    registerNamedPid(1234, 'super-mcp');

    // Stand up a fake BrowserWindow that claims the same PID.
    const { BrowserWindow: mockBrowserWindow } = (await import('electron')) as any;
    mockBrowserWindow.getAllWindows.mockReturnValueOnce([
      {
        isDestroyed: () => false,
        isVisible: () => true,
        webContents: {
          getOSProcessId: () => 1234,
          getURL: () => 'file:///index.html',
        },
      },
    ]);

    const map = buildProcessLabelMap();
    // Electron-window label wins — the named-registry label is NOT used.
    expect(map.get(1234)).toBe('mainUI');
  });

  it('buildProcessLabelMap does NOT surface registry entries (M3 collision guard)', async () => {
    // Registry entry for PID 5050 must NOT appear in the label map.
    const { BrowserWindow: mockBrowserWindow } = (await import('electron')) as any;
    mockBrowserWindow.getAllWindows.mockReturnValueOnce([]);
    registerNamedPid(5050, 'super-mcp');

    const map = buildProcessLabelMap();
    expect(map.has(5050)).toBe(false);
  });

  it('getProcessLabel() falls back to the named registry for unknown types', () => {
    registerNamedPid(5555, 'super-mcp');
    // Type is something unrecognized (e.g., Electron could surface "Unknown"
    // briefly during teardown). The named registry should supply the label.
    expect(getProcessLabel('Unknown', 5555, new Map())).toBe('super-mcp');
  });

  it('getProcessLabel() for known Electron types does NOT consult the named registry', () => {
    registerNamedPid(6000, 'super-mcp');
    // Browser is a known Electron type — always returns 'main'.
    expect(getProcessLabel('Browser', 6000, new Map())).toBe('main');
    // GPU is a known Electron type — always returns 'gpu'.
    expect(getProcessLabel('GPU', 6000, new Map())).toBe('gpu');
  });

  it('sanitizeProcessName is applied to register labels', () => {
    registerNamedPid(7000, 'Super-MCP Router v2');
    expect(getNamedPidRegistryForTesting().get(7000)?.label).toBe('super-mcp-router-v2');
  });
});

// ── M3: PID-collision invariants between Electron and the named registry ─────

describe('PID-collision invariants (M3)', () => {
  beforeEach(() => {
    clearNamedPidRegistryForTesting();
  });

  it('Test A: BrowserWindow PID wins in buildProcessLabelMap over a registry entry with the same PID', async () => {
    const { BrowserWindow: mockBrowserWindow } = (await import('electron')) as any;
    mockBrowserWindow.getAllWindows.mockReturnValueOnce([
      {
        isDestroyed: () => false,
        isVisible: () => true,
        webContents: {
          getOSProcessId: () => 100,
          getURL: () => 'file:///index.html',
        },
      },
    ]);

    registerNamedPid(100, 'super-mcp');

    const map = buildProcessLabelMap();
    expect(map.get(100)).toBe('mainUI');
  });

  it('Test B: getProcessLabel for Tab returns the mainUI label from labelMap (not the registry value)', () => {
    // labelMap already contains the Electron-window mapping.
    const labelMap = new Map<number, string>([[100, 'mainUI']]);
    // A stale registry entry for the same PID must NOT override the labelMap.
    registerNamedPid(100, 'super-mcp');

    expect(getProcessLabel('Tab', 100, labelMap)).toBe('mainUI');
    expect(getProcessLabel('Renderer', 100, labelMap)).toBe('mainUI');
  });

  it('Test C: stale registry entry + NO BrowserWindow for that PID + Tab type falls back to renderer:PID (NOT the registry value)', async () => {
    // Simulates the hazard: super-mcp exited but its PID was never
    // unregistered (e.g. missed `exited` event), and that PID is later
    // reused by the OS for an Electron renderer. The stale registry entry
    // must NOT relabel the renderer row.
    const { BrowserWindow: mockBrowserWindow } = (await import('electron')) as any;
    mockBrowserWindow.getAllWindows.mockReturnValueOnce([]);

    registerNamedPid(100, 'super-mcp');

    // Go through the production flow: buildProcessLabelMap() → getProcessLabel().
    const labelMap = buildProcessLabelMap();
    expect(getProcessLabel('Tab', 100, labelMap)).toBe('renderer:100');
    expect(getProcessLabel('Renderer', 100, labelMap)).toBe('renderer:100');
  });
});

// ── M5: stale-entry pruning ──────────────────────────────────────────

describe('namedPidRegistry — stale-entry pruning (M5)', () => {
  beforeEach(() => {
    clearNamedPidRegistryForTesting();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('prunes entries older than NAMED_PID_MAX_AGE_MS on next read (via getNamedPidLabel)', () => {
    const start = new Date('2026-04-23T12:00:00Z').getTime();
    vi.setSystemTime(start);

    registerNamedPid(600, 'super-mcp');
    expect(getNamedPidLabel(600)).toBe('super-mcp');

    // Advance past 24h — entry should be pruned on next read.
    vi.setSystemTime(start + 24 * 60 * 60 * 1000 + 1000);
    expect(getNamedPidLabel(600)).toBeNull();
    expect(getNamedPidRegistryForTesting().has(600)).toBe(false);
  });

  it('leaves fresh entries alone', () => {
    const start = new Date('2026-04-23T12:00:00Z').getTime();
    vi.setSystemTime(start);

    registerNamedPid(601, 'super-mcp');

    // Advance 12h — well within the 24h ceiling.
    vi.setSystemTime(start + 12 * 60 * 60 * 1000);
    expect(getNamedPidLabel(601)).toBe('super-mcp');
    expect(getNamedPidRegistryForTesting().has(601)).toBe(true);
  });
});
