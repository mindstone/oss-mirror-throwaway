import { beforeEach, describe, expect, it, vi } from 'vitest';
import AdmZip from 'adm-zip';
import type { AppSettings } from '@shared/types';

const mockRunSystemHealthCheck = vi.fn();
const mockResolveMcpConfigPath = vi.fn();
const mockPayloadHistogramSnapshot = vi.fn();

 
vi.mock('@core/utils/dataPaths', () => ({
  getDataPath: () => '/tmp/rebel-log-export-payload-histogram-test',
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
    generatedAt: '2026-05-10T00:00:00.000Z',
  }),
}));

 
vi.mock('../cloud/cloudOutbox', () => ({
  cloudOutbox: {
    getStatus: () => ({ pending: 0, failed: 0 }),
    getAll: () => [],
  },
}));

 
vi.mock('../cloud/cloudWorkspaceSync', () => ({
  cloudWorkspaceSync: {
    _getLastSyncAt: () => null,
    _getLastPushedManifest: () => new Map(),
  },
}));

 
vi.mock('../cloud/cloudContinuityMetadata', () => ({
  getAllContinuityStates: () => ({}),
  getLastSessionTombstoneSyncAt: () => null,
}));

 
vi.mock('../cloud/cloudServiceClient', () => ({
  getPayloadHistogramSnapshot: (...args: unknown[]) => mockPayloadHistogramSnapshot(...args),
}));

import { generateDiagnosticZipBundle } from '../logExportService';

describe('generateDiagnosticZipBundle payload histogram', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRunSystemHealthCheck.mockResolvedValue({
      status: 'healthy',
      checks: {},
      recommendations: [],
    });
    mockResolveMcpConfigPath.mockReturnValue(null);
    mockPayloadHistogramSnapshot.mockReturnValue({
      payloadBytesP50: 512,
      payloadBytesP95: 4096,
      payloadBytesMax: 8192,
      windowStart: '2026-05-09T00:00:00.000Z',
      windowEnd: '2026-05-10T00:00:00.000Z',
      sampleCount: 7,
    });
  });

  it('writes continuity/payload-histogram.json to the diagnostic ZIP', async () => {
    const { buffer } = await generateDiagnosticZipBundle({} as AppSettings, {
      includeFullLogs: false,
      includeErrorsOnly: false,
      includeChiefOfStaff: false,
      includeSentryScope: false,
      maxTurnLogs: 0,
      maxRecentSessions: 0,
    });

    const zip = new AdmZip(buffer);
    expect(zip.getEntry('continuity/payload-histogram.json')).toBeTruthy();
  });

  it('uses the cloud service client histogram snapshot unchanged', async () => {
    const { buffer } = await generateDiagnosticZipBundle({} as AppSettings, {
      includeFullLogs: false,
      includeErrorsOnly: false,
      includeChiefOfStaff: false,
      includeSentryScope: false,
      maxTurnLogs: 0,
      maxRecentSessions: 0,
    });

    const zip = new AdmZip(buffer);
    const payloadHistogram = JSON.parse(zip.readAsText('continuity/payload-histogram.json'));

    expect(mockPayloadHistogramSnapshot).toHaveBeenCalledTimes(1);
    expect(payloadHistogram).toEqual({
      payloadBytesP50: 512,
      payloadBytesP95: 4096,
      payloadBytesMax: 8192,
      windowStart: '2026-05-09T00:00:00.000Z',
      windowEnd: '2026-05-10T00:00:00.000Z',
      sampleCount: 7,
    });
  });

  it('advertises the histogram entry in the manifest contents', async () => {
    const { buffer } = await generateDiagnosticZipBundle({} as AppSettings, {
      includeFullLogs: false,
      includeErrorsOnly: false,
      includeChiefOfStaff: false,
      includeSentryScope: false,
      maxTurnLogs: 0,
      maxRecentSessions: 0,
    });

    const zip = new AdmZip(buffer);
    const manifest = JSON.parse(zip.readAsText('manifest.json'));

    expect(manifest.contents['continuity/payload-histogram.json']).toEqual(
      expect.objectContaining({
        type: 'structured',
        description: 'Desktop cloud payload-size histogram (24h)',
      }),
    );
  });
});
