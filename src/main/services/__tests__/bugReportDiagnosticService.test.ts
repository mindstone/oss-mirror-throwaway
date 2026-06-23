/**
 * Unit tests for bugReportDiagnosticService.
 *
 * Tests:
 * - Happy path gathering
 * - Individual step failures don't block others
 * - Timeout behavior
 * - Privacy filtering applied correctly
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { AppSettings } from '@shared/types';
import type { GatherDeterministicDiagnosticsDeps } from '../bugReportDiagnosticService';

// =============================================================================
// Mocks
// =============================================================================

vi.mock('@core/utils/dataPaths', () => ({
  getDataPath: () => '/mock/user-data',
  isPackaged: () => false,
}));

// Mock logFieldFilter — pass through for testing, but verify it's called
const mockFilterLogEntries = vi.fn((content: string) => `filtered:${content}`);
const mockExtractAnonymizedSessionMeta = vi.fn((session: Record<string, unknown>) => ({
  id: session.id ?? 'unknown',
  turnCount: 0,
  totalMessageCount: 0,
  errorEventCount: 0,
  toolFailureCount: 0,
  costUsd: undefined,
  createdAt: session.createdAt ?? 0,
  updatedAt: session.updatedAt ?? 0,
  origin: 'manual',
}));

// Pass-through spy: lets us assert sanitizeErrorPatterns runs error-pattern
// stems through the privacy gate (Stage C) without re-testing the gate itself.
const mockSanitizeLogMessage = vi.fn((value: string) => value);
vi.mock('@core/utils/logFieldFilter', () => ({
  filterLogEntries: (content: string) => mockFilterLogEntries(content),
  sanitizeLogMessage: (value: string) => mockSanitizeLogMessage(value),
  extractAnonymizedSessionMeta: (session: Record<string, unknown>) => mockExtractAnonymizedSessionMeta(session),
}));

// Direct mock functions for DI deps (no vi.mock needed for local services)
const mockExportRecentLogs = vi.fn();
const mockGenerateLogSummary = vi.fn();
const mockRunSystemHealthCheck = vi.fn();
const mockGetMcpRegistrationStatus = vi.fn();
const mockCloudOutboxGetStatus = vi.fn();
const mockCloudOutboxGetAll = vi.fn();
const mockWorkspaceGetLastSyncAt = vi.fn();
const mockWorkspaceGetLastPushedManifest = vi.fn();
const mockGetAllContinuityStates = vi.fn();
const mockGetLastSessionTombstoneSyncAt = vi.fn();
const mockGetProviderReachabilitySnapshot = vi.fn();
const mockRefreshProviderReachabilityCache = vi.fn(async (..._args: unknown[]) => undefined);

function makeTestDeps(): GatherDeterministicDiagnosticsDeps {
  return {
    exportRecentLogs: mockExportRecentLogs as unknown as GatherDeterministicDiagnosticsDeps['exportRecentLogs'],
    generateLogSummary: mockGenerateLogSummary as unknown as GatherDeterministicDiagnosticsDeps['generateLogSummary'],
    runSystemHealthCheck: mockRunSystemHealthCheck as unknown as GatherDeterministicDiagnosticsDeps['runSystemHealthCheck'],
    getMcpRegistrationStatus: mockGetMcpRegistrationStatus as unknown as GatherDeterministicDiagnosticsDeps['getMcpRegistrationStatus'],
  };
}

// Mock node:fs/promises
const mockReaddir = vi.fn();
const mockReadFile = vi.fn();
const mockStat = vi.fn();

vi.mock('node:fs/promises', () => ({
  default: {
    readdir: (...args: unknown[]) => mockReaddir(...args),
    readFile: (...args: unknown[]) => mockReadFile(...args),
    stat: (...args: unknown[]) => mockStat(...args),
  },
  readdir: (...args: unknown[]) => mockReaddir(...args),
  readFile: (...args: unknown[]) => mockReadFile(...args),
  stat: (...args: unknown[]) => mockStat(...args),
}));

vi.mock('../cloud/cloudOutbox', () => ({
  cloudOutbox: {
    getStatus: (...args: unknown[]) => mockCloudOutboxGetStatus(...args),
    getAll: (...args: unknown[]) => mockCloudOutboxGetAll(...args),
  },
}));

vi.mock('../cloud/cloudWorkspaceSync', () => ({
  cloudWorkspaceSync: {
    _getLastSyncAt: (...args: unknown[]) => mockWorkspaceGetLastSyncAt(...args),
    _getLastPushedManifest: (...args: unknown[]) => mockWorkspaceGetLastPushedManifest(...args),
  },
}));

vi.mock('../cloud/cloudContinuityMetadata', () => ({
  getAllContinuityStates: (...args: unknown[]) => mockGetAllContinuityStates(...args),
  getLastSessionTombstoneSyncAt: (...args: unknown[]) => mockGetLastSessionTombstoneSyncAt(...args),
}));

vi.mock('@core/services/diagnostics/providerReachabilitySnapshot', () => ({
  getProviderReachabilitySnapshot: (...args: unknown[]) => mockGetProviderReachabilitySnapshot(...args),
  refreshProviderReachabilityCache: (...args: unknown[]) => mockRefreshProviderReachabilityCache(...args),
}));

// =============================================================================
// Setup
// =============================================================================

const mockSettings: AppSettings = {} as AppSettings;

function makeHealthReport(status: 'healthy' | 'degraded' | 'critical' = 'healthy') {
  return {
    timestamp: Date.now(),
    platform: 'darwin',
    appVersion: '1.0.0',
    isPackaged: false,
    status,
    checks: {
      userDataWritable: { status: 'pass' },
      workspaceAccessible: { status: 'pass' },
      rebelSystemPresent: { status: 'pass' },
      systemPromptRenders: { status: 'pass' },
      systemPromptCoherence: { status: 'pass' },
      safetyPromptExists: { status: 'pass' },
      memoryPromptExists: { status: 'pass' },
      claudeApiKeyValid: { status: 'fail' },
      nodeBundleHealth: { status: 'warn' },
      msvcRuntimeHealth: { status: 'pass' },
      mcpConfigValid: { status: 'pass' },
      bundledServers: { status: 'pass' },
      superMcpHealth: { status: 'pass' },
      microphonePermission: { status: 'pass' },
    },
    recommendations: [],
  };
}

function makeExportedLogs() {
  return {
    files: [
      {
        filename: 'mindstone-rebel.log',
        content: '{"level":30,"msg":"ok","time":"2026-03-24T10:00:00Z"}',
        lineCount: 1,
      },
    ],
    totalLines: 1,
    timeWindow: {
      start: '2026-03-24T09:45:00Z',
      end: '2026-03-24T10:00:00Z',
    },
  };
}

function makeLogSummary() {
  return {
    timeWindow: { start: '2026-03-24T09:45:00Z', end: '2026-03-24T10:00:00Z' },
    files: [],
    errorPatterns: [
      {
        msg: 'Connection timeout',
        level: 50,
        count: 3,
        firstSeen: '2026-03-24T09:50:00Z',
        lastSeen: '2026-03-24T09:55:00Z',
        sampleEntry: { level: 50, msg: 'Connection timeout', preview: 'DANGEROUS' },
      },
    ],
    topicTags: ['mcp', 'errors'],
  };
}

// =============================================================================
// Import the module under test AFTER mocks
// =============================================================================

import { gatherDeterministicDiagnostics } from '../bugReportDiagnosticService';

// =============================================================================
// Tests
// =============================================================================

describe('gatherDeterministicDiagnostics', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default: all steps succeed
    mockRunSystemHealthCheck.mockResolvedValue(makeHealthReport());
    mockExportRecentLogs.mockResolvedValue(makeExportedLogs());
    mockGenerateLogSummary.mockReturnValue(makeLogSummary());
    mockGetMcpRegistrationStatus.mockReturnValue({
      lifecycle: 'completed',
      registered: ['RebelInbox', 'RebelDiagnostics'],
      gated: [{ id: 'RebelMeetings', code: 'feature_gate_meetingBotUnlocked' }],
      failed: [],
      capturedAt: '2026-03-27T10:00:00.000Z',
    });
    mockCloudOutboxGetStatus.mockReturnValue({ pending: 1, failed: 0 });
    mockCloudOutboxGetAll.mockReturnValue([
      {
        id: 'entry-1',
        sessionId: 'session-1',
        op: 'upsert',
        enqueuedAt: 1711286400000,
        attempts: 2,
        nextRetryAt: 1711286500000,
        status: 'pending',
        lastError: 'timeout',
      },
    ]);
    mockWorkspaceGetLastSyncAt.mockReturnValue(1711286400123);
    mockWorkspaceGetLastPushedManifest.mockReturnValue(new Map([
      ['notes/today.md', { mtime: 1711286400000, size: 128, hash: 'abcdef1234567890' }],
    ]));
    mockGetAllContinuityStates.mockReturnValue({
      'session-1': { state: 'cloud_active', lastCloudActivityAt: 1711286400000, cloudPinnedAt: undefined },
    });
    mockGetLastSessionTombstoneSyncAt.mockReturnValue(1711286400999);
    mockGetProviderReachabilitySnapshot.mockReturnValue({
      snapshotPresent: false,
      lastRefreshAt: null,
      providers: {},
    });
    // Session file reading defaults
    mockReaddir.mockImplementation((dirPath: string) => {
      if (typeof dirPath === 'string' && dirPath.includes('sessions')) {
        return Promise.resolve([
          { name: 'session-1.json', isFile: () => true },
          { name: 'index.json', isFile: () => true },
        ]);
      }
      return Promise.resolve([]);
    });
    mockReadFile.mockImplementation((filePath: string) => {
      if (typeof filePath === 'string' && filePath.includes('session-1.json')) {
        return Promise.resolve(JSON.stringify({
          id: 'session-1',
          createdAt: 1711200000000,
          updatedAt: 1711286400000,
          messages: [],
          eventsByTurn: {},
        }));
      }
      if (typeof filePath === 'string' && filePath.includes('clean-exit-flag.json')) {
        return Promise.resolve(JSON.stringify({ cleanExit: true }));
      }
      if (typeof filePath === 'string' && filePath.includes('auto-update-state.json')) {
        return Promise.resolve(JSON.stringify({ state: 'idle' }));
      }
      return Promise.reject(new Error('File not found'));
    });
    mockStat.mockResolvedValue({ mtimeMs: 1711286400000 });
  });

  it('gathers all diagnostics on happy path', async () => {
    const result = await gatherDeterministicDiagnostics(mockSettings, undefined, makeTestDeps());

    expect(result.gatheredAt).toBeDefined();

    // Health
    expect(result.health).not.toBeNull();
    const health = result.health;
    expect(health?.status).toBe('healthy');
    expect(health?.failedChecks).toContain('claudeApiKeyValid');
    expect(health?.warnChecks).toContain('nodeBundleHealth');

    // Filtered logs
    expect(result.filteredLogs).toHaveLength(1);
    expect(result.filteredLogs[0].filename).toBe('mindstone-rebel.log');
    expect(mockFilterLogEntries).toHaveBeenCalled();

    // Error patterns — sampleEntry should be stripped, and the msg stem must be
    // run through the privacy gate at the source (Stage C).
    expect(result.errorPatterns).toHaveLength(1);
    expect(result.errorPatterns[0].msg).toBe('Connection timeout');
    expect(result.errorPatterns[0]).not.toHaveProperty('sampleEntry');
    expect(mockSanitizeLogMessage).toHaveBeenCalledWith('Connection timeout');

    // Sessions
    expect(result.recentSessions).toHaveLength(1);
    expect(result.recentSessions[0].id).toBe('session-1');
    expect(mockExtractAnonymizedSessionMeta).toHaveBeenCalled();

    // Store stats
    expect(result.storeStats.cleanExitFlag).toEqual({ cleanExit: true });
    expect(result.storeStats.autoUpdateState).toEqual({ state: 'idle' });

    // Continuity quick stats
    expect(result.continuity).toBeDefined();
    expect(result.continuity?.outboxState.pending).toBe(1);
    expect(result.continuity?.workspaceSyncHistory.trackedFileCount).toBe(1);
    expect(result.continuity?.stateMachineTransitions.cloudActiveCount).toBe(1);
  });

  it('includes provider reachability when cached snapshot exists and section is enabled', async () => {
    const cachedSnapshot = {
      snapshotPresent: true,
      lastRefreshAt: 1711286400000,
      providers: {
        anthropic: {
          status: 'reachable',
          latencyMs: 42,
          checkedAt: 1711286400000,
          cachedAt: 1711286400000,
          expiresAt: 1711286430000,
          stale: false,
        },
      },
    };
    mockGetProviderReachabilitySnapshot.mockReturnValue(cachedSnapshot);

    const result = await gatherDeterministicDiagnostics(mockSettings, {
      diagnosticSections: { provider_reachability: true },
    }, makeTestDeps());

    expect(mockGetProviderReachabilitySnapshot).toHaveBeenCalledTimes(1);
    expect(result.providerReachability).toEqual(cachedSnapshot);
    expect(result.sectionStates?.provider_reachability).toBe('included');
  });

  it('omits provider reachability when section toggle is disabled', async () => {
    const result = await gatherDeterministicDiagnostics(mockSettings, {
      diagnosticSections: { provider_reachability: false },
    }, makeTestDeps());

    expect(mockGetProviderReachabilitySnapshot).not.toHaveBeenCalled();
    expect(result.providerReachability).toBeNull();
    expect(result.sectionStates?.provider_reachability).toBe('omitted_by_user_toggle');
  });

  it('marks provider reachability unavailable when cache is empty', async () => {
    const result = await gatherDeterministicDiagnostics(mockSettings, {
      diagnosticSections: { provider_reachability: true },
    }, makeTestDeps());

    expect(mockGetProviderReachabilitySnapshot).toHaveBeenCalledTimes(1);
    expect(result.providerReachability).toBeNull();
    expect(result.sectionStates?.provider_reachability).toBe('unavailable');
  });

  it('health check failure does not block other steps', async () => {
    mockRunSystemHealthCheck.mockRejectedValue(new Error('Health check exploded'));

    const result = await gatherDeterministicDiagnostics(mockSettings, undefined, makeTestDeps());

    expect(result.health).toBeNull();
    // Other steps still produce data
    expect(result.filteredLogs).toHaveLength(1);
    expect(result.recentSessions).toHaveLength(1);
    expect(result.storeStats.cleanExitFlag).toEqual({ cleanExit: true });
  });

  it('log export failure does not block other steps', async () => {
    mockExportRecentLogs.mockRejectedValue(new Error('Log export failed'));

    const result = await gatherDeterministicDiagnostics(mockSettings, undefined, makeTestDeps());

    expect(result.filteredLogs).toHaveLength(0);
    expect(result.errorPatterns).toHaveLength(0);
    // Other steps still produce data
    expect(result.health).not.toBeNull();
    expect(result.recentSessions).toHaveLength(1);
  });

  it('session gathering failure does not block other steps', async () => {
    mockReaddir.mockImplementation((dirPath: string) => {
      if (typeof dirPath === 'string' && dirPath.includes('sessions')) {
        return Promise.reject(new Error('Sessions dir gone'));
      }
      return Promise.resolve([]);
    });

    const result = await gatherDeterministicDiagnostics(mockSettings, undefined, makeTestDeps());

    expect(result.recentSessions).toHaveLength(0);
    // Other steps still produce data
    expect(result.health).not.toBeNull();
    expect(result.filteredLogs).toHaveLength(1);
  });

  it('store stats failure does not block other steps', async () => {
    mockReadFile.mockImplementation((filePath: string) => {
      if (typeof filePath === 'string' && filePath.includes('session-1.json')) {
        return Promise.resolve(JSON.stringify({
          id: 'session-1',
          createdAt: 1711200000000,
          updatedAt: 1711286400000,
          messages: [],
          eventsByTurn: {},
        }));
      }
      // All store files fail
      return Promise.reject(new Error('File not found'));
    });

    const result = await gatherDeterministicDiagnostics(mockSettings, undefined, makeTestDeps());

    expect(result.storeStats.cleanExitFlag).toBeNull();
    expect(result.storeStats.autoUpdateState).toBeNull();
    // Other steps still produce data
    expect(result.health).not.toBeNull();
    expect(result.filteredLogs).toHaveLength(1);
  });

  it('passes logWindowMinutes option through to exportRecentLogs', async () => {
    await gatherDeterministicDiagnostics(mockSettings, { logWindowMinutes: 30 }, makeTestDeps());

    expect(mockExportRecentLogs).toHaveBeenCalledWith({ logWindowMinutes: 30 });
  });

  it('skips index.json when reading session files', async () => {
    mockReaddir.mockImplementation((dirPath: string) => {
      if (typeof dirPath === 'string' && dirPath.includes('sessions')) {
        return Promise.resolve([
          { name: 'session-1.json', isFile: () => true },
          { name: 'index.json', isFile: () => true },
          { name: 'session-2.json', isFile: () => true },
        ]);
      }
      return Promise.resolve([]);
    });
    mockReadFile.mockImplementation((filePath: string) => {
      if (typeof filePath === 'string' && filePath.includes('session-1.json')) {
        return Promise.resolve(JSON.stringify({
          id: 'session-1',
          createdAt: 1711200000000,
          updatedAt: 1711286400000,
        }));
      }
      if (typeof filePath === 'string' && filePath.includes('session-2.json')) {
        return Promise.resolve(JSON.stringify({
          id: 'session-2',
          createdAt: 1711200000000,
          updatedAt: 1711200000000,
        }));
      }
      if (typeof filePath === 'string' && (filePath.includes('clean-exit-flag') || filePath.includes('auto-update-state'))) {
        return Promise.resolve('null');
      }
      return Promise.reject(new Error('Not found'));
    });

    const result = await gatherDeterministicDiagnostics(mockSettings, undefined, makeTestDeps());

    // Should have 2 sessions (index.json skipped)
    expect(result.recentSessions).toHaveLength(2);
  });

  it('limits recent sessions to MAX_RECENT_SESSIONS', async () => {
    const sessionEntries = Array.from({ length: 10 }, (_, i) => ({
      name: `session-${i}.json`,
      isFile: () => true,
    }));
    mockReaddir.mockImplementation((dirPath: string) => {
      if (typeof dirPath === 'string' && dirPath.includes('sessions')) {
        return Promise.resolve(sessionEntries);
      }
      return Promise.resolve([]);
    });
    mockReadFile.mockImplementation((filePath: string) => {
      const match = filePath.match(/session-(\d+)\.json/);
      if (match) {
        return Promise.resolve(JSON.stringify({
          id: `session-${match[1]}`,
          createdAt: 1711200000000,
          updatedAt: 1711200000000 + parseInt(match[1]) * 1000,
        }));
      }
      if (typeof filePath === 'string' && (filePath.includes('clean-exit-flag') || filePath.includes('auto-update-state'))) {
        return Promise.resolve('null');
      }
      return Promise.reject(new Error('Not found'));
    });

    const result = await gatherDeterministicDiagnostics(mockSettings, undefined, makeTestDeps());

    // Should be capped at 5
    expect(result.recentSessions.length).toBeLessThanOrEqual(5);
  });

  it('applies filterLogEntries to each exported log file', async () => {
    const multiFileLogs = {
      files: [
        { filename: 'app.log', content: '{"level":30,"msg":"a"}', lineCount: 1 },
        { filename: 'sessions/turn.log', content: '{"level":50,"msg":"b"}', lineCount: 1 },
      ],
      totalLines: 2,
      timeWindow: { start: 'start', end: 'end' },
    };
    mockExportRecentLogs.mockResolvedValue(multiFileLogs);

    const result = await gatherDeterministicDiagnostics(mockSettings, undefined, makeTestDeps());

    expect(mockFilterLogEntries).toHaveBeenCalledTimes(2);
    expect(result.filteredLogs).toHaveLength(2);
    expect(result.filteredLogs[0].filteredContent).toBe('filtered:{"level":30,"msg":"a"}');
    expect(result.filteredLogs[1].filteredContent).toBe('filtered:{"level":50,"msg":"b"}');
  });

  it('handles degraded health status correctly', async () => {
    mockRunSystemHealthCheck.mockResolvedValue(makeHealthReport('degraded'));

    const result = await gatherDeterministicDiagnostics(mockSettings, undefined, makeTestDeps());

    expect(result.health?.status).toBe('degraded');
  });

  it('returns valid structure when all steps fail', async () => {
    mockRunSystemHealthCheck.mockRejectedValue(new Error('fail'));
    mockExportRecentLogs.mockRejectedValue(new Error('fail'));
    mockReaddir.mockRejectedValue(new Error('fail'));
    mockReadFile.mockRejectedValue(new Error('fail'));

    const result = await gatherDeterministicDiagnostics(mockSettings, undefined, makeTestDeps());

    // Should still have valid structure with empty/null values
    expect(result.gatheredAt).toBeDefined();
    expect(result.health).toBeNull();
    expect(result.filteredLogs).toHaveLength(0);
    expect(result.errorPatterns).toHaveLength(0);
    expect(result.recentSessions).toHaveLength(0);
    expect(result.storeStats.cleanExitFlag).toBeNull();
    expect(result.storeStats.autoUpdateState).toBeNull();
  });

  // ── MCP Registration Status in diagnostics ──

  it('includes MCP registration status when lifecycle is not not_started', async () => {
    const result = await gatherDeterministicDiagnostics(mockSettings, undefined, makeTestDeps());

    expect(result.mcpRegistration).toBeDefined();
    expect(result.mcpRegistration?.lifecycle).toBe('completed');
    expect(result.mcpRegistration?.registered).toEqual(['RebelInbox', 'RebelDiagnostics']);
    expect(result.mcpRegistration?.gated).toEqual([{ id: 'RebelMeetings', code: 'feature_gate_meetingBotUnlocked' }]);
  });

  it('omits MCP registration status when lifecycle is not_started', async () => {
    mockGetMcpRegistrationStatus.mockReturnValue({
      lifecycle: 'not_started',
      registered: [],
      gated: [],
      failed: [],
      capturedAt: '',
    });

    const result = await gatherDeterministicDiagnostics(mockSettings, undefined, makeTestDeps());

    expect(result.mcpRegistration).toBeUndefined();
  });

  it('handles getMcpRegistrationStatus failure gracefully', async () => {
    mockGetMcpRegistrationStatus.mockImplementation(() => {
      throw new Error('MCP status unavailable');
    });

    const result = await gatherDeterministicDiagnostics(mockSettings, undefined, makeTestDeps());

    // Should not have MCP registration but other fields should be present
    expect(result.mcpRegistration).toBeUndefined();
    expect(result.health).not.toBeNull();
  });
});
