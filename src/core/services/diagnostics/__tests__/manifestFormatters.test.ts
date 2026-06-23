import { describe, it, expect } from 'vitest';
import { DIAGNOSTIC_MANIFEST_SCHEMA_VERSION } from '../manifest';
import {
  formatBundleReadme,
  formatDesktopBundleAsMarkdownReport,
  formatMobileBundleAsMarkdown,
} from '../manifestFormatters';
import type { AssembledDesktopBundle } from '../diagnosticBundleService';
import type { DiagnosticManifest } from '../manifest';
import { defaultDiagnosticSectionStates } from '@shared/diagnostics/diagnosticBundleSections';

function buildDesktopAssembled(overrides?: {
  files?: Map<string, string>;
  contents?: DiagnosticManifest['contents'];
}): AssembledDesktopBundle {
  const manifest: DiagnosticManifest = {
    schemaVersion: 1,
    generated: '2026-01-01T00:00:00.000Z',
    app: { version: '1', platform: 'darwin', arch: 'arm64', isPackaged: false, electronVersion: 'e', nodeVersion: 'n' },
    capabilities: ['health'],
    contents: overrides?.contents ?? {
      'health.json': { type: 'structured', description: 'health' },
      'settings.json': { type: 'config', description: 'settings (redacted)' },
      'recent-sessions/': { type: 'structured', description: '1 session excerpts' },
      'logs/sessions/': { type: 'logs', description: '1 turn-specific log files' },
      'rebel-system/README.md': { type: 'config', description: 'Chief of Staff system prompt' },
      'logs/main.ndjson': { type: 'logs', description: 'Main process logs' },
      'logs/errors.ndjson': { type: 'logs', description: 'Errors and warnings' },
      'events.jsonl': { type: 'structured', description: '3 diagnostic events' },
    },
    quickStats: { healthStatus: 'healthy', failedChecks: [], warnChecks: [], errorCountLast15m: 0, warnCountLast15m: 0, sessionCount: 0 },
    bundleParams: { logWindowMinutes: 15, maxTurnLogs: 1, maxRecentSessions: 1, truncated: false },
    sections: defaultDiagnosticSectionStates('included'),
    agentGuidance: 'guidance',
  };
  const files = overrides?.files ?? new Map<string, string>([
    ['health.json', '{"status":"healthy"}'],
    ['settings.json', '{"redacted":true}'],
    ['recent-sessions/abc.json', '{"messages":["secret content"]}'],
    ['logs/sessions/turn-1.log', 'session log content'],
    ['rebel-system/README.md', 'system prompt content'],
    ['logs/main.ndjson', '{"msg":"info"}'],
    ['logs/errors.ndjson', '{"msg":"warn","level":40}'],
    ['events.jsonl', '{"kind":"cooldown_enter"}'],
  ]);
  return { manifest, files, filename: 'mindstone-diagnostics-x.zip', truncated: false };
}

describe('diagnostics manifest formatters', () => {
  it('keeps schema version at one', () => {
    expect(DIAGNOSTIC_MANIFEST_SCHEMA_VERSION).toBe(1);
  });
  it('formats desktop bundle README with quick status', () => {
    const markdown = formatBundleReadme({ schemaVersion: 1, generated: '2026-01-01T00:00:00.000Z', app: { version: '1', platform: 'darwin', arch: 'arm64', isPackaged: false, electronVersion: '1', nodeVersion: '1' }, capabilities: ['health'], contents: { 'health.json': { type: 'structured', description: 'health' } }, quickStats: { healthStatus: 'healthy', failedChecks: [], warnChecks: [], errorCountLast15m: 0, warnCountLast15m: 0, sessionCount: 0 }, bundleParams: { logWindowMinutes: 15, maxTurnLogs: 1, maxRecentSessions: 1, truncated: false }, agentGuidance: 'guidance' }, { timeWindow: { start: 'a', end: 'b' }, files: [], errorPatterns: [], topicTags: [] });
    expect(markdown).toContain('# Mindstone Rebel Diagnostic Bundle');
    expect(markdown).toContain('health.json');
  });
  it('includes top error patterns and tags in desktop README', () => {
    const markdown = formatBundleReadme({ schemaVersion: 1, generated: 'g', app: { version: '1', platform: 'linux', arch: 'x64', isPackaged: true, electronVersion: 'e', nodeVersion: 'n' }, capabilities: [], contents: {}, quickStats: { healthStatus: 'degraded', failedChecks: [], warnChecks: ['disk'], errorCountLast15m: 1, warnCountLast15m: 2, sessionCount: 3 }, bundleParams: { logWindowMinutes: 15, maxTurnLogs: 1, maxRecentSessions: 1, truncated: false }, agentGuidance: 'guidance' }, { timeWindow: { start: 'a', end: 'b' }, files: [], topicTags: ['auth'], errorPatterns: [{ msg: 'boom', level: 50, count: 2, firstSeen: 'a', lastSeen: 'b' }] });
    expect(markdown).toContain('[ERROR]');
    expect(markdown).toContain('Detected topics: auth');
  });
  it('formats mobile markdown health and session sections', () => {
    const markdown = formatMobileBundleAsMarkdown({ manifest: { schemaVersion: 1, generatedAt: 'g', source: 'mobile', app: { version: '1', platform: 'ios', platformVersion: '17', runtimeVersion: 'r' } }, health: { status: 'healthy', checks: { logCollection: { status: 'pass', detail: 'ok' }, outboxQueue: { status: 'pass', detail: 'ok' }, continuityConnection: { status: 'pass', detail: 'ok' } } }, sessionsIndex: { count: 0, totalInHistory: 0, sessions: [] }, logs: { mainNdjson: '', lineCount: 0 } });
    expect(markdown).toContain('## Health Checks');
    expect(markdown).toContain('## Sessions Index');
  });
  it('formats mobile optional queue and continuity sections', () => {
    const markdown = formatMobileBundleAsMarkdown({ manifest: { schemaVersion: 1, generatedAt: 'g', source: 'mobile', app: { version: '1', platform: 'ios', platformVersion: '17', runtimeVersion: 'r' } }, health: { status: 'degraded', checks: { logCollection: { status: 'warn', detail: 'warn' }, outboxQueue: { status: 'pass', detail: 'ok' }, continuityConnection: { status: 'warn', detail: 'warn' } } }, sessionsIndex: { count: 0, totalInHistory: 0, sessions: [] }, logs: { mainNdjson: 'log', lineCount: 0 }, queueSnapshot: { pendingCount: 1, processingCount: 0, maxAttempts: 0, queueFull: false, limitedConnectivity: false, authExpired: false }, continuityState: { connectionState: 'connected', knownSessionCount: 1, appliedSeqSessionCount: 1, lastTombstoneSyncAt: null } });
    expect(markdown).toContain('## Queue Snapshot');
    expect(markdown).toContain('## Continuity State');
  });
  it('desktop MD report inlines structured files but redacts session content, turn logs, system prompts, and full main logs', () => {
    const assembled = buildDesktopAssembled();
    const md = formatDesktopBundleAsMarkdownReport(assembled, { timeWindow: { start: 'a', end: 'b' }, files: [], errorPatterns: [], topicTags: [] });

    expect(md).toContain('## Inline Diagnostic Files');
    expect(md).toContain('### `health.json`');
    expect(md).toContain('### `settings.json`');
    expect(md).toContain('### `events.jsonl`');
    expect(md).toContain('### `logs/errors.ndjson`');

    expect(md).not.toContain('secret content');
    expect(md).not.toContain('session log content');
    expect(md).not.toContain('system prompt content');
    expect(md).not.toContain('### `recent-sessions/abc.json`');
    expect(md).not.toContain('### `logs/sessions/turn-1.log`');
    expect(md).not.toContain('### `rebel-system/README.md`');
    expect(md).not.toContain('### `logs/main.ndjson`');
    expect(md).not.toContain('### `manifest.json`');
  });

  it('desktop MD report renders the section coverage table for fail-loud visibility', () => {
    const assembled = buildDesktopAssembled();
    assembled.manifest.sections = {
      ...defaultDiagnosticSectionStates('included'),
      cost_summary: 'reader_unavailable',
      provider_reachability: 'unavailable',
      recent_logs: 'omitted_by_user_toggle',
    };
    const md = formatDesktopBundleAsMarkdownReport(assembled, { timeWindow: { start: 'a', end: 'b' }, files: [], errorPatterns: [], topicTags: [] });
    expect(md).toContain('## Section Coverage');
    expect(md).toContain('| `cost_summary` | reader_unavailable |');
    expect(md).toContain('| `provider_reachability` | unavailable |');
    expect(md).toContain('| `recent_logs` | omitted_by_user_toggle |');
  });

  it('renders fenced mobile logs when line count is positive', () => {
    expect(formatMobileBundleAsMarkdown({ manifest: { schemaVersion: 1, generatedAt: 'g', source: 'mobile', app: { version: '1', platform: 'ios', platformVersion: '17', runtimeVersion: 'r' } }, health: { status: 'healthy', checks: { logCollection: { status: 'pass', detail: 'ok' }, outboxQueue: { status: 'pass', detail: 'ok' }, continuityConnection: { status: 'pass', detail: 'ok' } } }, sessionsIndex: { count: 0, totalInHistory: 0, sessions: [] }, logs: { mainNdjson: 'log', lineCount: 1 } })).toContain('```');
  });

  it('renders mobile Recent Events section when bundle has recentEvents', () => {
    const md = formatMobileBundleAsMarkdown({
      manifest: { schemaVersion: 1, generatedAt: 'g', source: 'mobile', app: { version: '1', platform: 'ios', platformVersion: '17', runtimeVersion: 'r' } },
      health: { status: 'healthy', checks: { logCollection: { status: 'pass', detail: 'ok' }, outboxQueue: { status: 'pass', detail: 'ok' }, continuityConnection: { status: 'pass', detail: 'ok' } } },
      sessionsIndex: { count: 0, totalInHistory: 0, sessions: [] },
      logs: { mainNdjson: '', lineCount: 0 },
      recentEvents: [
        { ts: 1700000000000, surface: 'mobile', source: 'continuity_breadcrumb', family: 'session-merge', message: 'complete', level: 'info' },
        { ts: 1700000060000, surface: 'mobile', source: 'continuity_breadcrumb', family: 'outbox', message: 'retry-exhausted', level: 'error' },
      ],
    });
    expect(md).toContain('## Recent Events (2)');
    expect(md).toContain('**session-merge** — complete');
    expect(md).toContain('**outbox** — retry-exhausted');
    expect(md).toContain('[error]');
  });

  it('omits mobile Recent Events section when no events present', () => {
    const md = formatMobileBundleAsMarkdown({
      manifest: { schemaVersion: 1, generatedAt: 'g', source: 'mobile', app: { version: '1', platform: 'ios', platformVersion: '17', runtimeVersion: 'r' } },
      health: { status: 'healthy', checks: { logCollection: { status: 'pass', detail: 'ok' }, outboxQueue: { status: 'pass', detail: 'ok' }, continuityConnection: { status: 'pass', detail: 'ok' } } },
      sessionsIndex: { count: 0, totalInHistory: 0, sessions: [] },
      logs: { mainNdjson: '', lineCount: 0 },
    });
    expect(md).not.toContain('## Recent Events');
  });

  it('renders Process Supervision, Cloud Outbox, Filesystem Pressure and Store File Sizes sections in desktop README when populated', () => {
    const markdown = formatBundleReadme(
      {
        schemaVersion: 1,
        generated: '2026-01-01T00:00:00.000Z',
        app: { version: '1', platform: 'darwin', arch: 'arm64', isPackaged: false, electronVersion: 'e', nodeVersion: 'n' },
        capabilities: ['health'],
        contents: { 'health.json': { type: 'structured', description: 'health' } },
        quickStats: {
          healthStatus: 'degraded',
          failedChecks: [],
          warnChecks: [],
          errorCountLast15m: 0,
          warnCountLast15m: 0,
          sessionCount: 0,
          processSupervision: {
            lastShutdownClean: false,
            totalCrashesAllTime: 5,
            crashesInLast24h: 1,
            crashesInLast7Days: 3,
            lastCrashAt: 1700000000000,
          },
          cloudOutbox: { pending: 7, oldestAgeMs: 90_000 },
          fsExhaustion: {
            sourceCounts: { graceful_fs_queue: 0, emfile_retry_final: 4, native_bypass: 0, log_event_handler: 0, console_message_relay: 0, diagnostics_snapshot_refresh: 0 },
            queueDepth: 2,
            queuePeak: 11,
            lastSource: 'emfile_retry_final',
            lastTaggedAt: 1700000123000,
          },
          storeBreakdown: {
            entries: [
              { name: 'cost-ledger.jsonl', bytes: 5_242_880, mtimeMs: 1700000000000 },
              { name: 'sessions.json', bytes: 1024, mtimeMs: 1700000000000 },
            ],
            totalBytes: 5_243_904,
            truncated: false,
          },
        },
        bundleParams: { logWindowMinutes: 15, maxTurnLogs: 1, maxRecentSessions: 1, truncated: false },
        agentGuidance: 'guidance',
      },
      { timeWindow: { start: 'a', end: 'b' }, files: [], errorPatterns: [], topicTags: [] },
    );
    expect(markdown).toContain('**Last Shutdown:** unclean');
    expect(markdown).toContain('Crashes (24h / 7d / total):** 1 / 3 / 5');
    expect(markdown).toContain('**Cloud Outbox:** 7 pending');
    expect(markdown).toContain('## Filesystem Pressure');
    expect(markdown).toContain('**Queue Depth (now / peak):** 2 / 11');
    expect(markdown).toContain('emfile_retry_final=4');
    expect(markdown).toContain('## Store File Sizes');
    expect(markdown).toContain('| `cost-ledger.jsonl` | 5.0 MB |');
  });

  it('omits the new sections from desktop README when not populated', () => {
    const markdown = formatBundleReadme(
      {
        schemaVersion: 1,
        generated: 'g',
        app: { version: '1', platform: 'linux', arch: 'x64', isPackaged: true, electronVersion: 'e', nodeVersion: 'n' },
        capabilities: [],
        contents: {},
        quickStats: { healthStatus: 'healthy', failedChecks: [], warnChecks: [], errorCountLast15m: 0, warnCountLast15m: 0, sessionCount: 0 },
        bundleParams: { logWindowMinutes: 15, maxTurnLogs: 1, maxRecentSessions: 1, truncated: false },
        agentGuidance: 'guidance',
      },
      { timeWindow: { start: 'a', end: 'b' }, files: [], errorPatterns: [], topicTags: [] },
    );
    expect(markdown).not.toContain('## Filesystem Pressure');
    expect(markdown).not.toContain('## Store File Sizes');
    expect(markdown).not.toContain('**Cloud Outbox:**');
    expect(markdown).not.toContain('**Last Shutdown:**');
  });

  it('renders mobile queue snapshot oldest-age line when present', () => {
    const markdown = formatMobileBundleAsMarkdown({
      manifest: { schemaVersion: 1, generatedAt: 'g', source: 'mobile', app: { version: '1', platform: 'ios', platformVersion: '17', runtimeVersion: 'r' } },
      health: { status: 'healthy', checks: { logCollection: { status: 'pass', detail: 'ok' }, outboxQueue: { status: 'pass', detail: 'ok' }, continuityConnection: { status: 'pass', detail: 'ok' } } },
      sessionsIndex: { count: 0, totalInHistory: 0, sessions: [] },
      logs: { mainNdjson: '', lineCount: 0 },
      queueSnapshot: { pendingCount: 2, processingCount: 0, maxAttempts: 0, queueFull: false, limitedConnectivity: false, authExpired: false, oldestAgeMs: 120_000 },
    });
    expect(markdown).toContain('Oldest queued age: 2m');
  });
});
