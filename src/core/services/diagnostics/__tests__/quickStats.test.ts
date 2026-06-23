import { describe, it, expect } from 'vitest';
import { computeBundleParams, computeCapabilities, computeQuickStats, summarizeDiagnosticEvents } from '../quickStats';
import type { DiagnosticEventEntry } from '../manifest';

describe('diagnostics quick stats helpers', () => {
  it('maps failed and warning health checks into quick stats', () => {
    const stats = computeQuickStats({ healthReport: { status: 'critical', checks: { a: { status: 'fail' }, b: { status: 'warn' } } }, logSummary: null, sessionExcerpts: [] });
    expect(stats.failedChecks).toEqual(['a']);
    expect(stats.warnChecks).toEqual(['b']);
  });
  it('counts warning and error patterns', () => {
    const stats = computeQuickStats({ healthReport: null, sessionExcerpts: [{ id: 's' } as any], logSummary: { timeWindow: { start: 'a', end: 'b' }, files: [], topicTags: [], errorPatterns: [{ msg: 'e', level: 50, count: 2, firstSeen: 'a', lastSeen: 'b' }, { msg: 'w', level: 40, count: 3, firstSeen: 'a', lastSeen: 'b' }] } });
    expect(stats.errorCountLast15m).toBe(2);
    expect(stats.warnCountLast15m).toBe(3);
    expect(stats.sessionCount).toBe(1);
  });
  it('preserves perf stats only when supplied', () => {
    expect(computeQuickStats({ healthReport: null, logSummary: null, sessionExcerpts: [], perfStats: { slowStoreWritesSinceStart: 1, maxStoreWriteMs: 2, slowSpawnsSinceStart: 3, maxSpawnMs: 4, uptimeMinutes: 5, platform: 'win32' } }).perfStats?.platform).toBe('win32');
  });
  it('computes bundle params and capabilities from content presence', () => {
    expect(computeBundleParams({ logWindowMinutes: 15, maxTurnLogs: 1, maxRecentSessions: 2, truncated: true }).truncated).toBe(true);
    expect(computeCapabilities({ healthReport: { status: 'healthy', checks: {} }, contents: { 'logs/main.ndjson': { type: 'logs', description: 'logs' }, 'continuity/outbox-state.json': { type: 'structured', description: 'outbox' } }, turnLogs: [], sessionExcerpts: [] })).toEqual(['health', 'logs', 'continuity']);
  });

  describe('summarizeDiagnosticEvents', () => {
    it('returns null slots when input is undefined', () => {
      expect(summarizeDiagnosticEvents(undefined)).toEqual({ counts: null, lastTimes: null, engagedKinds: [] });
    });
    it('returns null slots when input is empty', () => {
      expect(summarizeDiagnosticEvents([])).toEqual({ counts: null, lastTimes: null, engagedKinds: [] });
    });
    it('tallies counts and tracks the most recent timestamp per kind', () => {
      const events: DiagnosticEventEntry[] = [
        { v: 1, ts: 100, surface: 'desktop', kind: 'cooldown_enter', data: { scope: 'api', untilMs: 200, retryAfterProvided: false, durationMs: 100 } },
        { v: 1, ts: 200, surface: 'desktop', kind: 'cooldown_enter', data: { scope: 'cloud', untilMs: 300, retryAfterProvided: false, durationMs: 100 } },
        { v: 1, ts: 150, surface: 'desktop', kind: 'cooldown_exit', data: { scope: 'api', reason: 'success' } },
        { v: 1, ts: 50, surface: 'desktop', kind: 'cooldown_enter', data: { scope: 'api', untilMs: 100, retryAfterProvided: false, durationMs: 50 } },
      ];
      const summary = summarizeDiagnosticEvents(events);
      expect(summary.counts).toEqual({ cooldown_enter: 3, cooldown_exit: 1 });
      expect(summary.lastTimes).toEqual({ cooldown_enter: 200, cooldown_exit: 150 });
      expect(summary.engagedKinds).toEqual([]);
    });
    it('handles a single-kind input cleanly', () => {
      const events: DiagnosticEventEntry[] = [
        { v: 1, ts: 100, surface: 'desktop', kind: 'mcp_transition', data: { transition: 'connect', restartCount: 0, consecutiveFailures: 0 } },
      ];
      const summary = summarizeDiagnosticEvents(events);
      expect(summary.counts).toEqual({ mcp_transition: 1 });
      expect(summary.lastTimes).toEqual({ mcp_transition: 100 });
      expect(summary.engagedKinds).toEqual([]);
    });
    it('deduplicates event kinds whose per-kind cap engaged in the read window', () => {
      const events: DiagnosticEventEntry[] = [
        { v: 1, ts: 100, surface: 'desktop', kind: 'events_per_kind_cap_engaged', data: { kind: 'continuity_transition', capLimit: 2000, droppedSinceLastWarning: 0 } },
        { v: 1, ts: 110, surface: 'desktop', kind: 'events_per_kind_cap_engaged', data: { kind: 'cooldown_exit', capLimit: 1500, droppedSinceLastWarning: 0 } },
        { v: 1, ts: 120, surface: 'desktop', kind: 'events_per_kind_cap_engaged', data: { kind: 'continuity_transition', capLimit: 2000, droppedSinceLastWarning: 0 } },
      ];
      const summary = summarizeDiagnosticEvents(events);
      expect(summary.engagedKinds).toEqual(['continuity_transition', 'cooldown_exit']);
    });
    it('threads counts and lastTimes through computeQuickStats', () => {
      const events: DiagnosticEventEntry[] = [
        { v: 1, ts: 1000, surface: 'desktop', kind: 'auth_event', data: { transition: 'refresh_failure', provider: 'google', errorCode: 'invalid_grant', needsReconnect: true, accountSlugHash: 'abc' } },
        { v: 1, ts: 1100, surface: 'desktop', kind: 'events_per_kind_cap_engaged', data: { kind: 'auth_event', capLimit: 1500, droppedSinceLastWarning: 0 } },
      ];
      const stats = computeQuickStats({ healthReport: null, logSummary: null, sessionExcerpts: [], diagnosticEvents: events });
      expect(stats.recentDiagnosticEventCounts).toEqual({ auth_event: 1, events_per_kind_cap_engaged: 1 });
      expect(stats.lastDiagnosticEventTimes).toEqual({ auth_event: 1000, events_per_kind_cap_engaged: 1100 });
      expect(stats.diagnosticEventCapEngagedKinds).toEqual(['auth_event']);
    });
    it('omits the optional manifest fields when no events were supplied', () => {
      const stats = computeQuickStats({ healthReport: null, logSummary: null, sessionExcerpts: [] });
      expect('recentDiagnosticEventCounts' in stats).toBe(false);
      expect('lastDiagnosticEventTimes' in stats).toBe(false);
      expect('diagnosticEventCapEngagedKinds' in stats).toBe(false);
    });
  });

  describe('snapshot fields (fsExhaustion, storeBreakdown, processSupervision, cloudOutbox)', () => {
    it('omits fsExhaustion when no pressure has been observed', () => {
      const stats = computeQuickStats({
        healthReport: null,
        logSummary: null,
        sessionExcerpts: [],
        fsExhaustion: {
          sourceCounts: { graceful_fs_queue: 0, emfile_retry_final: 0, native_bypass: 0, log_event_handler: 0, console_message_relay: 0, diagnostics_snapshot_refresh: 0 },
          queueDepth: 0,
          queuePeak: 0,
        },
      });
      expect(stats.fsExhaustion).toBeUndefined();
    });

    it('includes fsExhaustion when any source counter is non-zero', () => {
      const stats = computeQuickStats({
        healthReport: null,
        logSummary: null,
        sessionExcerpts: [],
        fsExhaustion: {
          sourceCounts: { graceful_fs_queue: 0, emfile_retry_final: 3, native_bypass: 0, log_event_handler: 0, console_message_relay: 0, diagnostics_snapshot_refresh: 0 },
          lastSource: 'emfile_retry_final',
          lastTaggedAt: 1700000000,
          queueDepth: 0,
          queuePeak: 5,
        },
      });
      expect(stats.fsExhaustion?.lastSource).toBe('emfile_retry_final');
      expect(stats.fsExhaustion?.sourceCounts.emfile_retry_final).toBe(3);
    });

    it('includes fsExhaustion when queue is non-idle even with zero counts', () => {
      const stats = computeQuickStats({
        healthReport: null,
        logSummary: null,
        sessionExcerpts: [],
        fsExhaustion: {
          sourceCounts: { graceful_fs_queue: 0, emfile_retry_final: 0, native_bypass: 0, log_event_handler: 0, console_message_relay: 0, diagnostics_snapshot_refresh: 0 },
          queueDepth: 4,
          queuePeak: 12,
        },
      });
      expect(stats.fsExhaustion?.queuePeak).toBe(12);
    });

    it('omits storeBreakdown when entries list is empty', () => {
      const stats = computeQuickStats({
        healthReport: null,
        logSummary: null,
        sessionExcerpts: [],
        storeBreakdown: { entries: [], totalBytes: 0, truncated: false },
      });
      expect(stats.storeBreakdown).toBeUndefined();
    });

    it('includes storeBreakdown when entries are present', () => {
      const stats = computeQuickStats({
        healthReport: null,
        logSummary: null,
        sessionExcerpts: [],
        storeBreakdown: { entries: [{ name: 'cost-ledger.jsonl', bytes: 100_000, mtimeMs: 1 }], totalBytes: 100_000, truncated: false },
      });
      expect(stats.storeBreakdown?.entries[0]?.name).toBe('cost-ledger.jsonl');
    });

    it('passes processSupervision through verbatim', () => {
      const supervision = { lastShutdownClean: false, totalCrashesAllTime: 3, crashesInLast24h: 1, crashesInLast7Days: 2, lastCrashAt: 1700000000 };
      const stats = computeQuickStats({ healthReport: null, logSummary: null, sessionExcerpts: [], processSupervision: supervision });
      expect(stats.processSupervision).toEqual(supervision);
    });

    it('passes cloudOutbox through verbatim', () => {
      const stats = computeQuickStats({
        healthReport: null,
        logSummary: null,
        sessionExcerpts: [],
        cloudOutbox: { pending: 5, oldestAgeMs: 60_000 },
      });
      expect(stats.cloudOutbox).toEqual({ pending: 5, oldestAgeMs: 60_000 });
    });
  });
});
