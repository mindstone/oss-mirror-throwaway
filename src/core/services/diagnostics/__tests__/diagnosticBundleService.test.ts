import { describe, it, expect } from 'vitest';
import { fnvHashBase36, fnvHashHex } from '@rebel/shared';
import { assembleCloudLegacyDiagnostics, assembleCloudSelfDiagnostics, assembleDesktopBundle, assembleMobileBundle, capSelfDiagnosticsPayload, redactMcpConfigForDiagnostics, redactSettingsForDiagnostics } from '../diagnosticBundleService';
import type { AssembleDesktopBundleInput } from '../diagnosticBundleService';

function desktopInput(
  overrides: Partial<Omit<AssembleDesktopBundleInput, 'collectors'>> & {
    collectors?: Partial<AssembleDesktopBundleInput['collectors']>;
  } = {},
): AssembleDesktopBundleInput {
  return {
    settings: {} as any,
    logger: { warn: () => {} },
    options: { includeFullLogs: false, includeErrorsOnly: false, includeChiefOfStaff: false, includeSentryScope: false },
    paths: { userData: '/u', logs: '/u/logs', sessions: '/u/sessions', sentry: '/u/sentry' },
    appInfo: { version: '1', platform: 'darwin', arch: 'arm64', isPackaged: false, electronVersion: 'e', nodeVersion: 'n' },
    now: () => Date.parse('2026-01-01T00:00:00.000Z'),
    ...overrides,
    collectors: {
      runSystemHealthCheck: async () => ({ status: 'healthy', checks: {} }),
      resolveMcpConfigPath: () => null,
      readMcpConfig: async () => ({}),
      gatherRecentSessions: async () => [],
      countTotalSessions: async () => 0,
      gatherContinuityDiagnostics: async () => [],
      captureRamSnapshot: () => ({ ok: true }),
      gatherSentryScope: async () => null,
      gatherChiefOfStaffReadme: async () => null,
      gatherElectronStoreFiles: async () => ({}),
      exportRecentLogs: async () => ({ files: [], totalLines: 0, timeWindow: { start: 'a', end: 'b' } }),
      gatherTurnLogs: async () => [],
      getPerfStatsIfNotable: () => undefined,
      ...overrides.collectors,
    },
  };
}

describe('diagnostics bundle service orchestration', () => {
  it('assembles desktop bundles without adding a manifest source discriminator', async () => {
    const assembled = await assembleDesktopBundle({ settings: { coreDirectory: '/Users/alice/core' } as any, logger: { warn: () => {} }, options: { includeFullLogs: false, includeErrorsOnly: false, includeChiefOfStaff: false, includeSentryScope: false }, paths: { userData: '/u', logs: '/u/logs', sessions: '/u/sessions', sentry: '/u/sentry' }, appInfo: { version: '1', platform: 'darwin', arch: 'arm64', isPackaged: false, electronVersion: 'e', nodeVersion: 'n' }, now: () => Date.parse('2026-01-01T00:00:00.000Z'), collectors: { runSystemHealthCheck: async () => ({ status: 'healthy', checks: {} }), resolveMcpConfigPath: () => null, readMcpConfig: async () => ({}), gatherRecentSessions: async () => [], countTotalSessions: async () => 0, gatherContinuityDiagnostics: async () => [], captureRamSnapshot: () => ({ ok: true }), gatherSentryScope: async () => null, gatherChiefOfStaffReadme: async () => null, gatherElectronStoreFiles: async () => ({}), exportRecentLogs: async () => ({ files: [], totalLines: 0, timeWindow: { start: 'a', end: 'b' } }), gatherTurnLogs: async () => [], getPerfStatsIfNotable: () => undefined } });
    expect(assembled.manifest.generated).toBe('2026-01-01T00:00:00.000Z');
    expect('source' in assembled.manifest).toBe(false);
    expect(assembled.files.has('manifest.json')).toBe(true);
  });

  it('applies per-section toggles to desktop diagnostic events and manifest states', async () => {
    const assembled = await assembleDesktopBundle(desktopInput({
      options: {
        includeFullLogs: false,
        includeErrorsOnly: false,
        includeChiefOfStaff: false,
        includeSentryScope: false,
        diagnosticSections: { provider_reachability: false },
      },
      collectors: {
        gatherDiagnosticEvents: async () => [
          { v: 1, ts: 1, surface: 'desktop', kind: 'provider_reachability_change', data: {} },
          { v: 1, ts: 2, surface: 'desktop', kind: 'health_check_timing', data: {} },
        ],
      },
    }));

    expect(assembled.manifest.sections?.provider_reachability).toBe('omitted_by_user_toggle');
    expect(assembled.manifest.sections?.health_timing).toBe('included');
    expect(assembled.files.get('events.jsonl')).not.toContain('provider_reachability_change');
    expect(assembled.files.get('events.jsonl')).toContain('health_check_timing');
  });

  it('preserves legacy includeEnrichedDiagnostics precedence when section overrides are absent', async () => {
    const assembled = await assembleDesktopBundle(desktopInput({
      options: {
        includeFullLogs: false,
        includeErrorsOnly: false,
        includeChiefOfStaff: false,
        includeSentryScope: false,
        includeEnrichedDiagnostics: false,
      },
      collectors: {
        gatherDiagnosticEvents: async () => [
          { v: 1, ts: 1, surface: 'desktop', kind: 'health_check_timing', data: {} },
        ],
      },
    }));

    expect(assembled.manifest.sections?.health_timing).toBe('omitted_by_option');
    expect(assembled.files.has('events.jsonl')).toBe(false);
  });

  it('lets explicit section overrides opt back in over legacy includeEnrichedDiagnostics=false', async () => {
    const assembled = await assembleDesktopBundle(desktopInput({
      options: {
        includeFullLogs: false,
        includeErrorsOnly: false,
        includeChiefOfStaff: false,
        includeSentryScope: false,
        includeEnrichedDiagnostics: false,
        diagnosticSections: { provider_reachability: true },
      },
      collectors: {
        gatherDiagnosticEvents: async () => [
          { v: 1, ts: 1, surface: 'desktop', kind: 'provider_reachability_change', data: {} },
          { v: 1, ts: 2, surface: 'desktop', kind: 'health_check_timing', data: {} },
        ],
      },
    }));

    expect(assembled.manifest.sections?.provider_reachability).toBe('included');
    expect(assembled.manifest.sections?.health_timing).toBe('omitted_by_option');
    expect(assembled.files.get('events.jsonl')).toContain('provider_reachability_change');
    expect(assembled.files.get('events.jsonl')).not.toContain('health_check_timing');
  });

  it('co-locates the all-unreachable verdict alongside the raw provider-reachability probe data', async () => {
    const probe = (errorCode?: 'timeout' | 'dns') =>
      ({
        status: 'unreachable' as const,
        ...(errorCode ? { errorCode } : {}),
        checkedAt: 1,
        cachedAt: 1,
        expiresAt: 999_999_999_999,
        stale: false,
      });
    const assembled = await assembleDesktopBundle(
      desktopInput({
        collectors: {
          refreshProviderReachability: async () => ({
            snapshotPresent: true,
            lastRefreshAt: 1,
            providers: { anthropic: probe('timeout'), openai: probe('dns') },
          }),
        },
      }),
    );

    const raw = assembled.files.get('provider-reachability.json');
    expect(raw).toBeTruthy();
    const parsed = JSON.parse(raw as string);
    // Raw probe evidence is preserved...
    expect(parsed.snapshotPresent).toBe(true);
    expect(parsed.providers.anthropic.status).toBe('unreachable');
    // ...and the derived support verdict is embedded next to it.
    expect(parsed.verdict.verdict).toBe('all_unreachable');
    expect(parsed.verdict.unreachableProviders.sort()).toEqual(['anthropic', 'openai']);
    expect(assembled.manifest.sections?.provider_reachability).toBe('included');
  });

  it('distinguishes reader_unavailable, unavailable, empty, and included section states', async () => {
    const desktop = await assembleDesktopBundle(desktopInput({
      options: { includeFullLogs: true, includeErrorsOnly: false, includeChiefOfStaff: false, includeSentryScope: false },
      collectors: {
        exportRecentLogs: async () => ({ files: [{ filename: 'main.log', content: '{"level":40,"msg":"warn"}', lineCount: 1, sizeBytes: 25 }], totalLines: 1, timeWindow: { start: 'a', end: 'b' } }),
        gatherDiagnosticEvents: async () => {
          throw new Error('reader unavailable');
        },
      },
    }));
    expect(desktop.manifest.sections?.recent_logs).toBe('included');
    expect(desktop.manifest.sections?.recent_events).toBe('reader_unavailable');
    expect(desktop.manifest.sections?.continuity_trail).toBe('empty');

    const cloud = await assembleCloudSelfDiagnostics({
      deviceScopeKey: 'device',
      checks: [],
      sessions: [],
      appInfo: { version: '1', platform: 'linux', nodeVersion: 'v', uptimeSec: 1 },
      collectors: {
        readContinuityStateMap: async () => ({}),
        listTombstones: () => [],
        getOutboxSnapshot: () => null,
        getCatchUpHistoryForDevice: () => [],
        getRecentLogs: () => [],
      },
    });
    expect(cloud.manifest.sections?.pre_turn_worker).toBe('unavailable');
    expect(cloud.manifest.sections?.recent_logs).toBe('empty');
  });
  it('Stage 1 drain behaviour preservation: bundle assembly does not throw when health-check collector throws, and silently omits health.json (Stage 1 of 260525_no-empty-drain-and-extend converted bare catch {} to ignoreBestEffortCleanup; documented silent-omission contract for this section is preserved per FOLLOW-UP F2)', async () => {
    const desktop = await assembleDesktopBundle(desktopInput({
      options: { includeFullLogs: false, includeErrorsOnly: false, includeChiefOfStaff: false, includeSentryScope: false },
      collectors: {
        runSystemHealthCheck: async () => {
          throw new Error('health check exploded — typical permission denied');
        },
      },
    }));
    expect(desktop.manifest.contents['health.json']).toBeUndefined();
    expect(Object.keys(desktop.manifest.contents).length).toBeGreaterThan(0);
  });
  it('redacts settings and MCP config for desktop assembly', () => {
    expect(JSON.stringify(redactSettingsForDiagnostics({ apiKey: 'secret', coreDirectory: '/Users/alice/core' } as any))).toContain('REDACTED');
    expect(JSON.stringify(redactMcpConfigForDiagnostics({ env: { API_KEY: 'secret' }, command: '/Users/alice/bin/tool' }))).toContain('~');
  });

  it('redacts pending approval content in pending-tool-approvals.json export', async () => {
    const assembled = await assembleDesktopBundle(desktopInput({
      collectors: {
        gatherElectronStoreFiles: async () => ({
          'pending-tool-approvals.json': [
            {
              toolUseId: 'memory-secret-1',
              originalSessionId: 'session-1',
              content: 'sk-ant-very-secret-token',
              contentPreview: 'also sensitive',
              summary: 'summary with sk-ant-secret-derivative',
            },
          ],
        }),
      },
    }));

    const pendingApprovalsFile = assembled.files.get('pending-tool-approvals.json');
    expect(pendingApprovalsFile).toBeDefined();
    expect(pendingApprovalsFile).not.toContain('sk-ant-very-secret-token');
    expect(pendingApprovalsFile).not.toContain('also sensitive');
    expect(pendingApprovalsFile).not.toContain('summary with sk-ant-secret-derivative');
    expect(pendingApprovalsFile).toContain('***REDACTED***');
  });
  it('redacts approval content fields from pending-tool-approvals store export', async () => {
    const assembled = await assembleDesktopBundle(desktopInput({
      collectors: {
        gatherElectronStoreFiles: async () => ({
          'pending-tool-approvals.json': {
            pendingApprovals: [
              {
                toolUseID: 'tool-1',
                input: {
                  rawPayload: 'super-secret-raw-payload',
                },
              },
            ],
            pendingMemoryApprovals: [
              {
                toolUseId: 'memory-1',
                content: 'very-sensitive-content',
                contentPreview: 'preview-sensitive',
                summary: 'summary-sensitive',
              },
            ],
          },
        }),
      },
    }));

    const pendingApprovalsRaw = assembled.files.get('pending-tool-approvals.json');
    expect(pendingApprovalsRaw).toBeDefined();
    expect(pendingApprovalsRaw).not.toContain('very-sensitive-content');
    expect(pendingApprovalsRaw).not.toContain('preview-sensitive');
    expect(pendingApprovalsRaw).not.toContain('summary-sensitive');
    expect(pendingApprovalsRaw).not.toContain('super-secret-raw-payload');

    const pendingApprovals = JSON.parse(pendingApprovalsRaw!);
    expect(pendingApprovals.pendingMemoryApprovals[0].content).toBe('***REDACTED***');
    expect(pendingApprovals.pendingMemoryApprovals[0].contentPreview).toBe('***REDACTED***');
    expect(pendingApprovals.pendingMemoryApprovals[0].summary).toBe('***REDACTED***');
    expect(pendingApprovals.pendingApprovals[0].input.rawPayload).toBe('***REDACTED***');
  });
  it('assembles cloud self diagnostics with hex hashes and source cloud', async () => {
    const bundle = await assembleCloudSelfDiagnostics({ deviceScopeKey: 'device', checks: [{ id: 'disk', status: 'warn' }], sessions: [{ id: 'session-1', updatedAt: 1, cloudUpdatedAt: 2, maxSeq: 3 }], appInfo: { version: '1', platform: 'linux', nodeVersion: 'v', uptimeSec: 10 }, now: () => Date.parse('2026-01-01T00:00:00.000Z'), collectors: { readContinuityStateMap: async () => ({ 'session-1': { state: 'cloud_active' } }), listTombstones: () => [{ sessionId: 'session-1', deletedAt: 4, deletedBy: 'user' }], getOutboxSnapshot: () => null, getCatchUpHistoryForDevice: () => [], getRecentLogs: () => [{ msg: 'ok' }] } });
    expect(bundle.manifest.source).toBe('cloud');
    expect(bundle.health.status).toBe('degraded');
    expect(bundle.sessionsIndex.sessions[0].sessionIdHash).toBe(fnvHashHex('session-1'));
  });
  it('caps oversized cloud self diagnostics payloads under the configured max', () => {
    const capped = capSelfDiagnosticsPayload({ manifest: { schemaVersion: 1, generatedAt: 'g', source: 'cloud', app: { version: '1', platform: 'linux', nodeVersion: 'v' }, limits: { maxBytes: 100, rateLimit: '1/min per device' } }, health: { status: 'healthy', failedChecks: [], warnChecks: [], checkCount: 0, uptimeSec: 1 }, sessionsIndex: { count: 100, totalInHistory: 100, sessions: Array.from({ length: 100 }, (_, i) => ({ sessionIdHash: String(i), updatedAt: i, hasTombstone: false })) }, logs: { mainNdjson: 'x'.repeat(6 * 1024 * 1024), lineCount: 1 } });
    expect(capped.manifest.truncated).toBeDefined();
    expect(capped.logs.truncated).toBe(true);
  });
  it('assembles legacy cloud diagnostics without a manifest wrapper', async () => {
    const bundle = await assembleCloudLegacyDiagnostics({ checks: [{ id: 'ok', status: 'pass' }], dataDir: '/data', appInfo: { version: '1', platform: 'linux', nodeVersion: 'v', uptime: 1 }, now: () => 1, collectors: { getRecentLogs: () => [{ token: `sk-ant-${'a'.repeat(40)}` }], countSessions: async () => 2, getDiskInfo: async () => ({ diskAvailableMB: 1 }), getPushTokenCount: () => 3 } });
    expect(bundle.environment).toEqual(expect.objectContaining({ dataDir: '/data', sessionCount: 2, pushTokenCount: 3 }));
    expect(bundle).not.toHaveProperty('manifest');
  });
  it('assembles mobile bundles with base36 hashes and source mobile', () => {
    const bundle = assembleMobileBundle({ deviceInfo: { platform: 'ios', platformVersion: '17', appVersion: '1', runtimeVersion: 'r' }, filteredLogs: 'ok', logLineCount: 1 }, { generatedAt: 'g', collectors: { getSessions: () => [{ id: 'session-1', updatedAt: 1, doneAt: null, deletedAt: null }], getAppVersion: () => '1', getPlatform: () => 'ios', getPlatformVersion: () => '17', getRuntimeVersion: () => 'r' } });
    expect(bundle.manifest.source).toBe('mobile');
    expect(bundle.sessionsIndex.sessions[0].sessionIdHash).toBe(fnvHashBase36('session-1'));
  });
  it('marks mobile health degraded for queue and connection warnings', () => {
    const bundle = assembleMobileBundle({ deviceInfo: {}, filteredLogs: '', logLineCount: 0, queueSnapshot: { pendingCount: 1, processingCount: 0, maxAttempts: 0, queueFull: false, limitedConnectivity: false, authExpired: false }, continuityState: { connectionState: 'disconnected', knownSessionCount: 0, appliedSeqSessionCount: 0 } }, { collectors: { getSessions: () => [], getAppVersion: () => '1', getPlatform: () => 'ios', getPlatformVersion: () => '17', getRuntimeVersion: () => 'r' } });
    expect(bundle.health.status).toBe('degraded');
    expect(bundle.health.checks.logCollection.status).toBe('warn');
  });
  it('preserves optional mobile catch-up history only when non-empty', () => {
    const empty = assembleMobileBundle({ deviceInfo: {}, filteredLogs: 'ok', logLineCount: 1, catchUpHistory: [] }, { collectors: { getSessions: () => [], getAppVersion: () => '1', getPlatform: () => 'ios', getPlatformVersion: () => '17', getRuntimeVersion: () => 'r' } });
    expect(empty.catchUpHistory).toBeUndefined();
  });
  it('mobile recent_events flows through bundle when source has events and section enabled', () => {
    const events = [
      { ts: 1, surface: 'mobile' as const, source: 'continuity_breadcrumb', family: 'session-merge', message: 'complete' },
      { ts: 2, surface: 'mobile' as const, source: 'continuity_breadcrumb', family: 'outbox', message: 'retry-exhausted', level: 'error' as const },
    ];
    const bundle = assembleMobileBundle(
      { deviceInfo: {}, filteredLogs: 'ok', logLineCount: 1, recentEvents: events },
      { collectors: { getSessions: () => [], getAppVersion: () => '1', getPlatform: () => 'ios', getPlatformVersion: () => '17', getRuntimeVersion: () => 'r' } },
    );
    expect(bundle.recentEvents).toEqual(events);
    expect(bundle.manifest.sections?.recent_events).toBe('included');
  });
  it('mobile recent_events resolves to empty when source returned [] (buffer was consulted but had nothing)', () => {
    const bundle = assembleMobileBundle(
      { deviceInfo: {}, filteredLogs: 'ok', logLineCount: 1, recentEvents: [] },
      { collectors: { getSessions: () => [], getAppVersion: () => '1', getPlatform: () => 'ios', getPlatformVersion: () => '17', getRuntimeVersion: () => 'r' } },
    );
    expect(bundle.recentEvents).toBeUndefined();
    expect(bundle.manifest.sections?.recent_events).toBe('empty');
  });
  it('mobile recent_events resolves to unavailable when source omitted recentEvents (buffer not consulted / failed)', () => {
    const bundle = assembleMobileBundle(
      { deviceInfo: {}, filteredLogs: 'ok', logLineCount: 1 },
      { collectors: { getSessions: () => [], getAppVersion: () => '1', getPlatform: () => 'ios', getPlatformVersion: () => '17', getRuntimeVersion: () => 'r' } },
    );
    expect(bundle.recentEvents).toBeUndefined();
    expect(bundle.manifest.sections?.recent_events).toBe('unavailable');
  });
  it('mobile recent_events respects per-section disable', () => {
    const events = [{ ts: 1, surface: 'mobile' as const, source: 'continuity_breadcrumb', family: 'session-merge', message: 'complete' }];
    const bundle = assembleMobileBundle(
      { deviceInfo: {}, filteredLogs: 'ok', logLineCount: 1, recentEvents: events },
      {
        options: { diagnosticSections: { recent_events: false } },
        collectors: { getSessions: () => [], getAppVersion: () => '1', getPlatform: () => 'ios', getPlatformVersion: () => '17', getRuntimeVersion: () => 'r' },
      },
    );
    expect(bundle.recentEvents).toBeUndefined();
    expect(bundle.manifest.sections?.recent_events).toBe('omitted_by_user_toggle');
  });
  it('cloud cost_summary resolves to included with surfaceContext when collector returns non-empty waterfall', async () => {
    const bundle = await assembleCloudSelfDiagnostics({
      deviceScopeKey: 'device',
      checks: [],
      sessions: [],
      appInfo: { version: '1', platform: 'linux', nodeVersion: 'v', uptimeSec: 1 },
      collectors: {
        readContinuityStateMap: async () => ({}),
        listTombstones: () => [],
        getOutboxSnapshot: () => null,
        getCatchUpHistoryForDevice: () => [],
        getRecentLogs: () => [],
        getCostWaterfallByOutcome: async () => ({
          buckets: { success: { totalUsd: 1.23, count: 5, lastTs: 0 } },
          total: { totalUsd: 1.23, count: 5 },
          orphans: { resolutionLost: 0, resolutionUnmatched: 0 },
        }),
      },
    });
    expect(bundle.manifest.sections?.cost_summary).toBe('included');
    expect(bundle.costWaterfall?.surfaceContext).toBe('cloud');
    expect(bundle.costWaterfall?.waterfall).toBeDefined();
  });

  it('cloud cost_summary resolves to empty when ledger has no entries', async () => {
    const bundle = await assembleCloudSelfDiagnostics({
      deviceScopeKey: 'device',
      checks: [],
      sessions: [],
      appInfo: { version: '1', platform: 'linux', nodeVersion: 'v', uptimeSec: 1 },
      collectors: {
        readContinuityStateMap: async () => ({}),
        listTombstones: () => [],
        getOutboxSnapshot: () => null,
        getCatchUpHistoryForDevice: () => [],
        getRecentLogs: () => [],
        getCostWaterfallByOutcome: async () => ({ total: { totalUsd: 0, count: 0 } }),
      },
    });
    expect(bundle.manifest.sections?.cost_summary).toBe('empty');
    expect(bundle.costWaterfall).toBeUndefined();
  });

  it('cloud cost_summary resolves to reader_unavailable when collector throws', async () => {
    const bundle = await assembleCloudSelfDiagnostics({
      deviceScopeKey: 'device',
      checks: [],
      sessions: [],
      appInfo: { version: '1', platform: 'linux', nodeVersion: 'v', uptimeSec: 1 },
      collectors: {
        readContinuityStateMap: async () => ({}),
        listTombstones: () => [],
        getOutboxSnapshot: () => null,
        getCatchUpHistoryForDevice: () => [],
        getRecentLogs: () => [],
        getCostWaterfallByOutcome: async () => { throw new Error('ledger unreadable'); },
      },
    });
    expect(bundle.manifest.sections?.cost_summary).toBe('reader_unavailable');
    expect(bundle.costWaterfall).toBeUndefined();
  });

  it('cloud cost_summary stays unavailable when collector is absent (legacy callers)', async () => {
    const bundle = await assembleCloudSelfDiagnostics({
      deviceScopeKey: 'device',
      checks: [],
      sessions: [],
      appInfo: { version: '1', platform: 'linux', nodeVersion: 'v', uptimeSec: 1 },
      collectors: {
        readContinuityStateMap: async () => ({}),
        listTombstones: () => [],
        getOutboxSnapshot: () => null,
        getCatchUpHistoryForDevice: () => [],
        getRecentLogs: () => [],
      },
    });
    expect(bundle.manifest.sections?.cost_summary).toBe('unavailable');
  });

  it('keeps desktop raw IDs while cloud and mobile hash session IDs', async () => {
    const sessionId = 'session-parity';
    const desktop = await assembleDesktopBundle({ settings: {} as any, logger: { warn: () => {} }, options: { includeFullLogs: false, includeErrorsOnly: false, includeChiefOfStaff: false, includeSentryScope: false }, paths: { userData: '/u', logs: '/u/logs', sessions: '/u/sessions', sentry: '/u/sentry' }, appInfo: { version: '1', platform: 'darwin', arch: 'arm64', isPackaged: false, electronVersion: 'e', nodeVersion: 'n' }, collectors: { runSystemHealthCheck: async () => ({ status: 'healthy', checks: {} }), resolveMcpConfigPath: () => null, readMcpConfig: async () => ({}), gatherRecentSessions: async () => [{ id: sessionId, title: 'raw', createdAt: 1, updatedAt: 2, origin: 'manual', totalMessageCount: 0, turnCount: 0, recentMessages: [] }], countTotalSessions: async () => 1, gatherContinuityDiagnostics: async () => [], captureRamSnapshot: () => ({}), gatherSentryScope: async () => null, gatherChiefOfStaffReadme: async () => null, gatherElectronStoreFiles: async () => ({}), exportRecentLogs: async () => ({ files: [], totalLines: 0, timeWindow: { start: 'a', end: 'b' } }), gatherTurnLogs: async () => [], getPerfStatsIfNotable: () => undefined } });
    const desktopIndex = JSON.parse(desktop.files.get('sessions-index.json')!);
    expect(desktopIndex.sessions[0].id).toBe(sessionId);
  });
});
