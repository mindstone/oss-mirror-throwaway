import { describe, it, expect } from 'vitest';
import { assembleDesktopBundle } from '../diagnosticBundleService';

describe('diagnostics desktop bundle memory bound', () => {
  it('keeps representative 1000-session + 50x5MB-log assembly under 600MB heap delta', async () => {
    const fiveMb = 'x'.repeat(5 * 1024 * 1024);
    const before = process.memoryUsage().heapUsed;
    const bundle = await assembleDesktopBundle({
      settings: {} as any,
      logger: { warn: () => {} },
      options: { includeFullLogs: false, includeErrorsOnly: false, includeChiefOfStaff: false, includeSentryScope: false, maxTurnLogs: 50, maxRecentSessions: 1000 },
      paths: { userData: '/u', logs: '/u/logs', sessions: '/u/sessions', sentry: '/u/sentry' },
      appInfo: { version: '1', platform: 'linux', arch: 'x64', isPackaged: false, electronVersion: 'e', nodeVersion: 'n' },
      collectors: {
        runSystemHealthCheck: async () => ({ status: 'healthy', checks: {} }),
        resolveMcpConfigPath: () => null,
        readMcpConfig: async () => ({}),
        gatherRecentSessions: async () => Array.from({ length: 1000 }, (_, i) => ({ id: `session-${i}`, title: `Session ${i}`, createdAt: i, updatedAt: i, origin: 'manual', totalMessageCount: 0, turnCount: 0, recentMessages: [] })),
        countTotalSessions: async () => 1000,
        gatherContinuityDiagnostics: async () => [],
        captureRamSnapshot: () => ({}),
        gatherSentryScope: async () => null,
        gatherChiefOfStaffReadme: async () => null,
        gatherElectronStoreFiles: async () => ({}),
        exportRecentLogs: async () => ({ files: [], totalLines: 0, timeWindow: { start: 'a', end: 'b' } }),
        gatherTurnLogs: async () => Array.from({ length: 50 }, (_, i) => ({ filename: `turn-${i}.log`, content: `${fiveMb}${i}`, sizeBytes: fiveMb.length })),
        getPerfStatsIfNotable: () => undefined,
      },
    });
    const after = process.memoryUsage().heapUsed;
    const turnLogBytes = Array.from(bundle.files.entries())
      .filter(([name]) => name.startsWith('logs/sessions/'))
      .reduce<number>((sum, [, content]) => sum + content.length, 0);
    expect(turnLogBytes).toBeGreaterThanOrEqual(250 * 1024 * 1024);
    expect(after - before).toBeLessThan(600 * 1024 * 1024);
  });
});
