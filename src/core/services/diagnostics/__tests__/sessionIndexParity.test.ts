import { describe, it, expect } from 'vitest';
import { fnvHashBase36, fnvHashHex } from '@rebel/shared';
import { assembleCloudSelfDiagnostics, assembleDesktopBundle, assembleMobileBundle } from '../diagnosticBundleService';

describe('diagnostics session-index parity', () => {
  it('cloud session IDs remain hex hashed', async () => {
    const bundle = await assembleCloudSelfDiagnostics({ deviceScopeKey: 'd', checks: [], sessions: [{ id: 'session', updatedAt: 1 }], appInfo: { version: '1', platform: 'linux', nodeVersion: 'v', uptimeSec: 1 }, collectors: { readContinuityStateMap: async () => null, listTombstones: () => [], getOutboxSnapshot: () => null, getCatchUpHistoryForDevice: () => [], getRecentLogs: () => [] } });
    expect(bundle.sessionsIndex.sessions[0].sessionIdHash).toBe(fnvHashHex('session'));
  });
  it('mobile session IDs remain base36 hashed', () => {
    const bundle = assembleMobileBundle({ deviceInfo: {}, filteredLogs: 'ok', logLineCount: 1 }, { collectors: { getSessions: () => [{ id: 'session', updatedAt: 1, doneAt: null, deletedAt: null }], getAppVersion: () => '1', getPlatform: () => 'ios', getPlatformVersion: () => '17', getRuntimeVersion: () => 'r' } });
    expect(bundle.sessionsIndex.sessions[0].sessionIdHash).toBe(fnvHashBase36('session'));
  });
  it('desktop session index keeps raw IDs and titles', async () => {
    const bundle = await assembleDesktopBundle({ settings: {} as any, logger: { warn: () => {} }, options: { includeFullLogs: false, includeErrorsOnly: false, includeChiefOfStaff: false, includeSentryScope: false }, paths: { userData: '/u', logs: '/u/logs', sessions: '/u/sessions', sentry: '/u/sentry' }, appInfo: { version: '1', platform: 'linux', arch: 'x64', isPackaged: false, electronVersion: 'e', nodeVersion: 'n' }, collectors: { runSystemHealthCheck: async () => ({ status: 'healthy', checks: {} }), resolveMcpConfigPath: () => null, readMcpConfig: async () => ({}), gatherRecentSessions: async () => [{ id: 'raw-id', title: 'Raw title', createdAt: 1, updatedAt: 2, origin: 'manual', totalMessageCount: 0, turnCount: 0, recentMessages: [] }], countTotalSessions: async () => 1, gatherContinuityDiagnostics: async () => [], captureRamSnapshot: () => ({}), gatherSentryScope: async () => null, gatherChiefOfStaffReadme: async () => null, gatherElectronStoreFiles: async () => ({}), exportRecentLogs: async () => ({ files: [], totalLines: 0, timeWindow: { start: 'a', end: 'b' } }), gatherTurnLogs: async () => [], getPerfStatsIfNotable: () => undefined } });
    const index = JSON.parse(bundle.files.get('sessions-index.json')!);
    expect(index.sessions[0]).toEqual(expect.objectContaining({ id: 'raw-id', title: 'Raw title' }));
  });
});
