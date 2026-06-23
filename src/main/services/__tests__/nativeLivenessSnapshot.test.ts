/**
 * Tests for the native-resource liveness snapshot
 * (Stage 1 of docs/plans/260622_pin-quit-deadlock-blocker/PLAN.md).
 *
 * Load-bearing contract: SYNCHRONOUS and FAIL-OPEN. Every accessor is read
 * inside its own try/catch — a throwing accessor contributes `null` for that
 * field and the rest of the snapshot still populates. The capture must never
 * throw on the quit/force-exit path.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

// Each native-resource holder is mocked so we can drive normal counts, a
// throwing accessor, and the all-unloaded (all-zero) case deterministically
// without standing up real fsevents/ORT/LanceDB/super-mcp.
vi.mock('../fseventsLeakGuard', () => ({ liveNativeInstanceCount: vi.fn(() => 0) }));
vi.mock('../moonshineTranscriber', () => ({ getMoonshineLiveSessionCount: vi.fn(() => 0) }));
vi.mock('../conversationIndexService', () => ({ getConversationLanceLiveConnectionCount: vi.fn(() => 0) }));
vi.mock('../fileIndexService', () => ({ getFileLanceLiveConnectionCount: vi.fn(() => 0) }));
vi.mock('../toolIndexService', () => ({ getToolLanceLiveConnectionCount: vi.fn(() => 0) }));
vi.mock('../embeddingService', () => ({
  getEmbeddingLivenessSnapshot: vi.fn(() => ({ workerAlive: false, gpuBackendAlive: false, disposed: true })),
}));
vi.mock('../superMcpHttpManager', () => ({
  superMcpHttpManager: { getState: vi.fn(() => ({ isRunning: false, process: null })) },
}));

import { getConversationLanceLiveConnectionCount } from '../conversationIndexService';
import { getEmbeddingLivenessSnapshot } from '../embeddingService';
import { getFileLanceLiveConnectionCount } from '../fileIndexService';
import { liveNativeInstanceCount } from '../fseventsLeakGuard';
import { getMoonshineLiveSessionCount } from '../moonshineTranscriber';
import { captureNativeLivenessSnapshot } from '../nativeLivenessSnapshot';
import { superMcpHttpManager } from '../superMcpHttpManager';
import { getToolLanceLiveConnectionCount } from '../toolIndexService';

const mockFsevents = vi.mocked(liveNativeInstanceCount);
const mockMoonshine = vi.mocked(getMoonshineLiveSessionCount);
const mockConvLance = vi.mocked(getConversationLanceLiveConnectionCount);
const mockFileLance = vi.mocked(getFileLanceLiveConnectionCount);
const mockToolLance = vi.mocked(getToolLanceLiveConnectionCount);
const mockEmbedding = vi.mocked(getEmbeddingLivenessSnapshot);
const mockGetState = vi.mocked(superMcpHttpManager.getState);

describe('captureNativeLivenessSnapshot', () => {
  // Re-establish the unloaded (all-zero / not-running) baseline before each
  // test so `.mockReturnValue`/`.mockImplementation` from a prior test cannot
  // leak (clearAllMocks clears call data but NOT implementations).
  beforeEach(() => {
    vi.clearAllMocks();
    mockFsevents.mockReturnValue(0);
    mockMoonshine.mockReturnValue(0);
    mockConvLance.mockReturnValue(0);
    mockFileLance.mockReturnValue(0);
    mockToolLance.mockReturnValue(0);
    mockEmbedding.mockReturnValue({ workerAlive: false, gpuBackendAlive: false, disposed: true });
    mockGetState.mockReturnValue({ isRunning: false, process: null } as never);
  });

  it('reports the live counts from every accessor when resources are loaded', () => {
    mockFsevents.mockReturnValue(3);
    mockMoonshine.mockReturnValue(2);
    mockConvLance.mockReturnValue(1);
    mockFileLance.mockReturnValue(2);
    mockToolLance.mockReturnValue(1);
    mockEmbedding.mockReturnValue({ workerAlive: true, gpuBackendAlive: false, disposed: false });
    mockGetState.mockReturnValue({
      isRunning: true,
      process: { pid: 4242 },
      port: 0,
      url: '',
      startTime: null,
      lastHealthCheck: null,
    } as never);

    expect(captureNativeLivenessSnapshot()).toEqual({
      fseventsLiveInstances: 3,
      moonshineSessions: 2,
      superMcpPid: 4242,
      superMcpRunning: true,
      lancedbConnections: { conversation: 1, file: 2, tool: 1 },
      embedding: { workerAlive: true, gpuBackendAlive: false, disposed: false },
    });
  });

  it('returns all-zero / not-running when nothing is loaded (resources never touched)', () => {
    // Mocks default to the unloaded state; assert distinctly from accessor failures.
    expect(captureNativeLivenessSnapshot()).toEqual({
      fseventsLiveInstances: 0,
      moonshineSessions: 0,
      superMcpPid: null,
      superMcpRunning: false,
      lancedbConnections: { conversation: 0, file: 0, tool: 0 },
      embedding: { workerAlive: false, gpuBackendAlive: false, disposed: true },
    });
  });

  it('fail-open: a throwing accessor yields null for THAT field while the others still populate', () => {
    mockMoonshine.mockImplementation(() => {
      throw new Error('ORT module read blew up');
    });
    mockFsevents.mockReturnValue(5);
    mockConvLance.mockReturnValue(1);
    mockFileLance.mockReturnValue(2);
    mockToolLance.mockReturnValue(1);

    const snap = captureNativeLivenessSnapshot();
    // The throwing field is null (NOT a silent zero) — distinct signal.
    expect(snap.moonshineSessions).toBeNull();
    // Every other field is unaffected.
    expect(snap.fseventsLiveInstances).toBe(5);
    expect(snap.lancedbConnections).toEqual({ conversation: 1, file: 2, tool: 1 });
  });

  it('fail-open: a single lancedb sub-accessor throwing nulls only that sub-field', () => {
    mockFileLance.mockImplementation(() => {
      throw new Error('file index state read failed');
    });
    mockConvLance.mockReturnValue(1);
    mockToolLance.mockReturnValue(1);

    const snap = captureNativeLivenessSnapshot();
    expect(snap.lancedbConnections).toEqual({ conversation: 1, file: null, tool: 1 });
  });

  it('fail-open: super-mcp getState throwing nulls both pid and running, and never throws', () => {
    mockGetState.mockImplementation(() => {
      throw new Error('super-mcp manager state read failed');
    });

    expect(() => captureNativeLivenessSnapshot()).not.toThrow();
    const snap = captureNativeLivenessSnapshot();
    expect(snap.superMcpPid).toBeNull();
    expect(snap.superMcpRunning).toBeNull();
  });

  it('never throws even when every accessor throws (the whole snapshot stays null-filled)', () => {
    const boom = () => {
      throw new Error('everything is on fire');
    };
    mockFsevents.mockImplementation(boom);
    mockMoonshine.mockImplementation(boom);
    mockConvLance.mockImplementation(boom);
    mockFileLance.mockImplementation(boom);
    mockToolLance.mockImplementation(boom);
    mockEmbedding.mockImplementation(boom);
    mockGetState.mockImplementation(boom);

    expect(() => captureNativeLivenessSnapshot()).not.toThrow();
    expect(captureNativeLivenessSnapshot()).toEqual({
      fseventsLiveInstances: null,
      moonshineSessions: null,
      superMcpPid: null,
      superMcpRunning: null,
      lancedbConnections: { conversation: null, file: null, tool: null },
      embedding: { workerAlive: null, gpuBackendAlive: null, disposed: null },
    });
  });
});
