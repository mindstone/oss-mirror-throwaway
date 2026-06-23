import { describe, it, expect } from 'vitest';
import { assembleCloudSelfDiagnostics, assembleDesktopBundle, assembleMobileBundle } from '../diagnosticBundleService';

describe('diagnostics manifest schema-shape parity', () => {
  it('desktop manifest uses generated and has no source discriminator', async () => {
    const bundle = await assembleDesktopBundle({ settings: {} as any, logger: { warn: () => {} }, options: { includeFullLogs: false, includeErrorsOnly: false, includeChiefOfStaff: false, includeSentryScope: false }, paths: { userData: '/u', logs: '/u/logs', sessions: '/u/sessions', sentry: '/u/sentry' }, appInfo: { version: '1', platform: 'linux', arch: 'x64', isPackaged: false, electronVersion: 'e', nodeVersion: 'n' }, collectors: { runSystemHealthCheck: async () => ({ status: 'healthy', checks: {} }), resolveMcpConfigPath: () => null, readMcpConfig: async () => ({}), gatherRecentSessions: async () => [], countTotalSessions: async () => 0, gatherContinuityDiagnostics: async () => [], captureRamSnapshot: () => ({}), gatherSentryScope: async () => null, gatherChiefOfStaffReadme: async () => null, gatherElectronStoreFiles: async () => ({}), exportRecentLogs: async () => ({ files: [], totalLines: 0, timeWindow: { start: 'a', end: 'b' } }), gatherTurnLogs: async () => [], getPerfStatsIfNotable: () => undefined } });
    expect(bundle.manifest.schemaVersion).toBe(1);
    expect(bundle.manifest.generated).toBeDefined();
    expect((bundle.manifest as any).source).toBeUndefined();
  });
  it('cloud self manifest keeps source cloud and generatedAt', async () => {
    const bundle = await assembleCloudSelfDiagnostics({ deviceScopeKey: 'd', checks: [], sessions: [], appInfo: { version: '1', platform: 'linux', nodeVersion: 'v', uptimeSec: 1 }, collectors: { readContinuityStateMap: async () => null, listTombstones: () => [], getOutboxSnapshot: () => null, getCatchUpHistoryForDevice: () => [], getRecentLogs: () => [] } });
    expect(bundle.manifest.schemaVersion).toBe(1);
    expect(bundle.manifest.source).toBe('cloud');
    expect(bundle.manifest.generatedAt).toBeDefined();
  });
  it('mobile manifest keeps source mobile and generatedAt', () => {
    const bundle = assembleMobileBundle({ deviceInfo: {}, filteredLogs: 'ok', logLineCount: 1 }, { generatedAt: 'g', collectors: { getSessions: () => [], getAppVersion: () => '1', getPlatform: () => 'ios', getPlatformVersion: () => '17', getRuntimeVersion: () => 'r' } });
    expect(bundle.manifest.schemaVersion).toBe(1);
    expect(bundle.manifest.source).toBe('mobile');
    expect(bundle.manifest.generatedAt).toBe('g');
  });
});
