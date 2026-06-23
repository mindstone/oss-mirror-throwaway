import { buildStructuredBundleFromDiagnostics, formatStructuredBundleAsMarkdown } from '../utils/diagnosticBundle';

jest.mock('@rebel/cloud-client', () => ({
  hashForBreadcrumb: (input: string) => `hash:${input}`,
  createLogger: () => ({ debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() }),
  useSessionStore: {
    getState: () => ({
      sessions: [
        {
          id: 'session-2',
          updatedAt: 200,
          cloudUpdatedAt: 250,
          doneAt: null,
          deletedAt: null,
        },
        {
          id: 'session-1',
          updatedAt: 100,
          cloudUpdatedAt: undefined,
          doneAt: 123,
          deletedAt: null,
        },
      ],
    }),
  },
}));

describe('diagnosticBundle', () => {
  it('builds a structured bundle with required desktop-mirrored sections', () => {
    const bundle = buildStructuredBundleFromDiagnostics({
      deviceInfo: {
        platform: 'ios',
        platformVersion: '17.0',
        appVersion: '1.2.3',
        runtimeVersion: '54.0.0',
      },
      filteredLogs: '{"level":30,"msg":"ok"}',
      logLineCount: 1,
      queueSnapshot: {
        pendingCount: 1,
        processingCount: 0,
        countsByType: { 'text-message': 1 },
        countsByErrorCategory: {},
        maxAttempts: 0,
        oldestAgeMs: 250,
        queueFull: false,
        limitedConnectivity: false,
        authExpired: false,
      },
      continuityState: {
        connectionState: 'connected',
        knownSessionCount: 2,
        appliedSeqSessionCount: 1,
        lastTombstoneSyncAt: null,
      },
      catchUpHistory: [{ sessionIdHash: 'hash:session-1', appliedSeq: 12 }],
    }, '2026-04-19T12:00:00.000Z');

    expect(bundle.manifest.schemaVersion).toBe(1);
    expect(bundle.manifest.generatedAt).toBe('2026-04-19T12:00:00.000Z');
    expect(bundle.sessionsIndex.count).toBe(2);
    expect(bundle.sessionsIndex.sessions[0]).toEqual(
      expect.objectContaining({ updatedAt: 200, cloudUpdatedAt: 250 }),
    );
    expect(bundle.logs.lineCount).toBe(1);
    expect(bundle.sessionsIndex.sessions[0].sessionIdHash).toMatch(/^[a-z0-9]+$/);
    expect(bundle.queueSnapshot?.pendingCount).toBe(1);
    expect(bundle.continuityState?.connectionState).toBe('connected');
    // `catchUpHistory` is typed `unknown[]` on the production bundle type; cast at
    // the assertion boundary to read the entry shape (test-only, no prod change).
    expect((bundle.catchUpHistory?.[0] as { appliedSeq?: number } | undefined)?.appliedSeq).toBe(12);
  });

  it('preserves the public API generatedAt optional argument', () => {
    const bundle = buildStructuredBundleFromDiagnostics({
      deviceInfo: { platform: 'ios', platformVersion: '17.0', appVersion: '1.2.3', runtimeVersion: '54.0.0' },
      filteredLogs: '',
      logLineCount: 0,
    }, '2026-04-19T12:00:00.000Z');
    expect(bundle.manifest.generatedAt).toBe('2026-04-19T12:00:00.000Z');
  });

  it('formats a readable markdown fallback from structured data', () => {
    const markdown = formatStructuredBundleAsMarkdown({
      manifest: {
        schemaVersion: 1,
        generatedAt: '2026-04-19T12:00:00.000Z',
        source: 'mobile',
        app: {
          version: '1.2.3',
          platform: 'ios',
          platformVersion: '17.0',
          runtimeVersion: '54.0.0',
        },
      },
      health: {
        status: 'degraded',
        checks: {
          logCollection: { status: 'warn', detail: 'Recent logs unavailable.' },
          outboxQueue: { status: 'pass', detail: 'pending=0, processing=0, maxAttempts=0' },
          continuityConnection: { status: 'warn', detail: 'connectionState=reconnecting' },
        },
      },
      sessionsIndex: {
        count: 1,
        totalInHistory: 1,
        sessions: [
          {
            sessionIdHash: 'hash:session-1',
            updatedAt: 100,
            isActive: false,
            isDeleted: false,
          },
        ],
      },
      logs: {
        mainNdjson: '{"level":30,"msg":"ok"}',
        lineCount: 1,
      },
    });

    expect(markdown).toContain('# Mindstone Rebel Mobile Diagnostics');
    expect(markdown).toContain('## Health Checks');
    expect(markdown).toContain('## Sessions Index');
    expect(markdown).toContain('## Recent Logs');
  });
});
