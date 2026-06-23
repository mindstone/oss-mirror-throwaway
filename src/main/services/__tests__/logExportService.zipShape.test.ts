import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import AdmZip from 'adm-zip';
import type { AppSettings } from '@shared/types';

const mockRunSystemHealthCheck = vi.fn();
const mockResolveMcpConfigPath = vi.fn();

 
vi.mock('@core/utils/dataPaths', () => ({
  getDataPath: () => '/tmp/rebel-log-export-shape-test',
  getAppVersion: () => '1.2.3',
  isPackaged: () => false,
}));
 
vi.mock('../systemHealthService', () => ({
  runSystemHealthCheck: (...args: unknown[]) => mockRunSystemHealthCheck(...args),
  generateShareableReport: () => 'shareable-report',
}));
 
vi.mock('../mcpService', () => ({ resolveMcpConfigPath: (...args: unknown[]) => mockResolveMcpConfigPath(...args) }));
 
vi.mock('../ramTelemetryService', () => ({ captureRamSnapshot: () => ({ totals: { workingSetMB: 10, privateMB: 5, processCount: 1 }, processes: [], generatedAt: new Date().toISOString() }) }));
 
vi.mock('../perfAccumulator', () => ({ getPerfStatsIfNotable: () => null }));
 
vi.mock('../cloud/cloudOutbox', () => ({ cloudOutbox: { getStatus: () => ({ pending: 0, failed: 0 }), getAll: () => [] } }));
 
vi.mock('../cloud/cloudWorkspaceSync', () => ({ cloudWorkspaceSync: { _getLastSyncAt: () => null, _getLastPushedManifest: () => new Map() } }));
 
vi.mock('../cloud/cloudContinuityMetadata', () => ({ getAllContinuityStates: () => ({}), getLastSessionTombstoneSyncAt: () => null }));

import { generateDiagnosticZipBundle } from '../logExportService';

function sortedEntries(buffer: Buffer): Array<{ name: string; text: string }> {
  return new AdmZip(buffer).getEntries().map((entry) => ({ name: entry.entryName, text: entry.getData().toString('utf8') })).sort((a, b) => a.name.localeCompare(b.name));
}

describe('generateDiagnosticZipBundle ZIP shape', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
    vi.clearAllMocks();
    mockRunSystemHealthCheck.mockResolvedValue({ status: 'healthy', checks: { disk: { status: 'pass' } }, recommendations: [] });
    mockResolveMcpConfigPath.mockReturnValue(null);
  });
  afterEach(() => vi.useRealTimers());

  it('produces stable sorted ZIP entries across five consecutive runs', async () => {
    const outputs = [];
    for (let i = 0; i < 5; i++) {
      const { buffer } = await generateDiagnosticZipBundle({} as AppSettings, { includeFullLogs: false, includeErrorsOnly: false, includeChiefOfStaff: false, includeSentryScope: false, maxTurnLogs: 0, maxRecentSessions: 5 });
      outputs.push(sortedEntries(buffer));
    }
    expect(outputs.slice(1)).toEqual(outputs.slice(0, 4));
  });

  it('keeps the desktop manifest generated field and no source field', async () => {
    const { buffer } = await generateDiagnosticZipBundle({} as AppSettings, { includeFullLogs: false, includeErrorsOnly: false, includeChiefOfStaff: false, includeSentryScope: false, maxTurnLogs: 0, maxRecentSessions: 5 });
    const manifest = JSON.parse(new AdmZip(buffer).readAsText('manifest.json'));
    expect(manifest.generated).toBe('2026-01-01T00:00:00.000Z');
    expect(manifest.generatedAt).toBeUndefined();
    expect(manifest.source).toBeUndefined();
  });

  it('keeps expected desktop bundle file paths and README skeleton', async () => {
    const { buffer } = await generateDiagnosticZipBundle({} as AppSettings, { includeFullLogs: false, includeErrorsOnly: false, includeChiefOfStaff: false, includeSentryScope: false, maxTurnLogs: 0, maxRecentSessions: 5 });
    const zip = new AdmZip(buffer);
    const entries = zip.getEntries().map((entry) => entry.entryName).sort();
    expect(entries).toEqual(expect.arrayContaining(['README.md', 'health.json', 'manifest.json', 'ram-snapshot.json', 'sessions-index.json', 'settings.json']));
    expect(zip.readAsText('README.md')).toContain('# Mindstone Rebel Diagnostic Bundle');
  });
});
