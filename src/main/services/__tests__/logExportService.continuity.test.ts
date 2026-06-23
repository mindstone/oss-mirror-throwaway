import { describe, it, expect, vi, beforeEach } from 'vitest';
import AdmZip from 'adm-zip';
import type { AppSettings } from '@shared/types';

const mockRunSystemHealthCheck = vi.fn();
const mockResolveMcpConfigPath = vi.fn();
const mockOutboxGetStatus = vi.fn();
const mockOutboxGetAll = vi.fn();
const mockWorkspaceLastSyncAt = vi.fn();
const mockWorkspaceManifest = vi.fn();
const mockGetAllContinuityStates = vi.fn();
const mockGetLastSessionTombstoneSyncAt = vi.fn();

vi.mock('@core/utils/dataPaths', () => ({
  getDataPath: () => '/tmp/rebel-log-export-test',
  getAppVersion: () => '1.2.3',
  isPackaged: () => false,
}));

vi.mock('../systemHealthService', () => ({
  runSystemHealthCheck: (...args: unknown[]) => mockRunSystemHealthCheck(...args),
  generateShareableReport: () => 'shareable-report',
}));

vi.mock('../mcpService', () => ({
  resolveMcpConfigPath: (...args: unknown[]) => mockResolveMcpConfigPath(...args),
}));

vi.mock('../ramTelemetryService', () => ({
  captureRamSnapshot: () => ({
    totals: { workingSetMB: 100, privateMB: 50, processCount: 3 },
    processes: [],
    generatedAt: new Date().toISOString(),
  }),
}));

vi.mock('../cloud/cloudOutbox', () => ({
  cloudOutbox: {
    getStatus: (...args: unknown[]) => mockOutboxGetStatus(...args),
    getAll: (...args: unknown[]) => mockOutboxGetAll(...args),
  },
}));

vi.mock('../cloud/cloudWorkspaceSync', () => ({
  cloudWorkspaceSync: {
    _getLastSyncAt: (...args: unknown[]) => mockWorkspaceLastSyncAt(...args),
    _getLastPushedManifest: (...args: unknown[]) => mockWorkspaceManifest(...args),
  },
}));

vi.mock('../cloud/cloudContinuityMetadata', () => ({
  getAllContinuityStates: (...args: unknown[]) => mockGetAllContinuityStates(...args),
  getLastSessionTombstoneSyncAt: (...args: unknown[]) => mockGetLastSessionTombstoneSyncAt(...args),
}));

import { generateDiagnosticZipBundle } from '../logExportService';

describe('generateDiagnosticZipBundle continuity enrichment', () => {
  beforeEach(() => {
    vi.clearAllMocks();

    mockRunSystemHealthCheck.mockResolvedValue({
      status: 'healthy',
      checks: { disk: { status: 'pass' } },
      recommendations: [],
    });
    mockResolveMcpConfigPath.mockReturnValue(null);
    mockOutboxGetStatus.mockReturnValue({ pending: 1, failed: 0 });
    mockOutboxGetAll.mockReturnValue([
      {
        id: 'entry-1',
        sessionId: 'session-a',
        op: 'upsert',
        enqueuedAt: 1711286400000,
        attempts: 2,
        nextRetryAt: 1711286500000,
        status: 'pending',
        lastError: 'timeout',
      },
    ]);
    mockWorkspaceLastSyncAt.mockReturnValue(1711286400123);
    mockWorkspaceManifest.mockReturnValue(new Map([
      ['notes/today.md', { mtime: 1711286400000, size: 123, hash: 'abcdef1234567890fedcba' }],
    ]));
    mockGetAllContinuityStates.mockReturnValue({
      'session-a': { state: 'cloud_active', lastCloudActivityAt: 1711286400000, cloudPinnedAt: undefined },
      'session-b': { state: 'local_only', lastCloudActivityAt: undefined, cloudPinnedAt: undefined },
    });
    mockGetLastSessionTombstoneSyncAt.mockReturnValue(1711286400999);
  });

  it('adds continuity files to ZIP and advertises continuity capability in manifest', async () => {
    const { buffer } = await generateDiagnosticZipBundle({} as AppSettings, {
      includeFullLogs: false,
      includeErrorsOnly: false,
      includeChiefOfStaff: false,
      includeSentryScope: false,
      maxTurnLogs: 0,
      maxRecentSessions: 5,
    });

    const zip = new AdmZip(buffer);
    const entries = zip.getEntries().map((entry) => entry.entryName);

    expect(entries).toContain('continuity/outbox-state.json');
    expect(entries).toContain('continuity/workspace-sync-history.json');
    expect(entries).toContain('continuity/state-machine-transitions.json');

    const outboxState = JSON.parse(zip.readAsText('continuity/outbox-state.json'));
    expect(outboxState.status.pending).toBe(1);
    expect(outboxState.entries).toHaveLength(1);
    expect(outboxState.entries[0].sessionIdHash).toMatch(/^[a-f0-9]{8}$/);

    const transitions = JSON.parse(zip.readAsText('continuity/state-machine-transitions.json'));
    expect(transitions.cloudActiveCount).toBe(1);
    expect(transitions.localOnlyCount).toBe(1);

    const manifest = JSON.parse(zip.readAsText('manifest.json'));
    expect(manifest.capabilities).toContain('continuity');
  });
});
