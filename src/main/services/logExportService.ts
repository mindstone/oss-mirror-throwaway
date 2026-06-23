/**
 * Log Export Service
 *
 * Desktop-specific diagnostics collectors, legacy markdown export, and AdmZip
 * packaging. Cross-surface bundle assembly lives in @core/services/diagnostics.
 */

import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import AdmZip from 'adm-zip';
import { fnvHashHex as hashForExport } from '@rebel/shared';
import type { AgentSession, AppSettings } from '@shared/types';
import { createScopedLogger } from '@core/logger';
import { getDataPath, getAppVersion, isPackaged } from '@core/utils/dataPaths';
import { mapWithConcurrencyLimit } from '@core/utils/concurrencyLimit';
import { withRetryOnEmfile } from '@core/utils/emfileRetry';
import { readFileLines, STOP_READING_FILE_LINES } from '@core/utils/readLines';
import {
  assembleDesktopBundle,
  assembleMinimalDesktopBundle,
  type AssembledDesktopBundle,
  type DesktopContinuityFile,
} from '@core/services/diagnostics/diagnosticBundleService';
import { formatDesktopBundleAsMarkdownReport } from '@core/services/diagnostics/manifestFormatters';
import { deduplicateLogs, getLogLevel, parseLogTimestamp } from '@core/services/diagnostics/deduplication';
import { generateLogSummary } from '@core/services/diagnostics/logSummary';
import { buildDesktopSessionExcerpt } from '@core/services/diagnostics/sessionIndexTypes';
import { hydrateSessionArraysOnly } from '@core/services/incrementalSessionStore';
import {
  MAX_TURN_LOGS,
  MAX_RECENT_SESSIONS,
  MAX_COST_LEDGER_ENTRIES,
  MAX_STORE_BREAKDOWN_ENTRIES,
  type DiagnosticBundleOptions,
  type SentryScopeSummary,
  type SessionExcerpt,
  type StoreBreakdownEntry,
  type StoreBreakdownSnapshot,
  type TurnLogFile,
} from '@core/services/diagnostics/manifest';
import {
  redactUrlParams,
  redactSensitiveData,
  sanitizeJsonForExport,
  redactChiefOfStaffReadme,
  redactSentryScope,
} from '../utils/logRedaction';
import { runSystemHealthCheck } from './systemHealthService';
import { resolveMcpConfigPath } from './mcpService';

export { generateLogSummary };

const log = createScopedLogger({ service: 'logExport' });

export interface LogExportOptions {
  logWindowMinutes: number;
  maxLinesPerFile: number;
  filterLevel?: 'all' | 'warn-and-error';
}

export interface DiagnosticSessionContext {
  recentSessions: Array<{ id: string; title: string | null; updatedAt: number }>;
}

export interface ExportedLogFile {
  filename: string;
  content: string;
  lineCount: number;
}

export interface ExportedLogs {
  files: ExportedLogFile[];
  totalLines: number;
  timeWindow: { start: string; end: string };
}

function applyFinalSanitization(content: string): string {
  return redactUrlParams(
    content
      .replace(/sk-ant-[a-zA-Z0-9_-]+/g, 'sk-ant-***REDACTED***')
      .replace(/sk-[a-zA-Z0-9_-]{20,}/g, 'sk-***REDACTED***')
      .replace(/"elevenlabsApiKey"\s*:\s*"[^"]+"/g, '"elevenlabsApiKey": "***REDACTED***"')
      .replace(/"(api[_-]?key|apiKey|token|secret)"\s*:\s*"[^"]+"/gi, '"$1": "***REDACTED***"')
      .replace(/Bearer\s+[A-Za-z0-9_.\-]{20,}/gi, 'Bearer ***REDACTED***')
      .replace(/\/Users\/[^/\s"]+/g, '~')
      .replace(/\/home\/[^/\s"]+/g, '~')
      .replace(/[A-Z]:\\Users\\[^\\"]+/gi, '~')
  );
}

async function readRecentLogLines(
  filePath: string,
  cutoffTime: Date,
  maxLines: number,
  filterLevel: 'all' | 'warn-and-error',
  signal?: AbortSignal,
): Promise<string[]> {
  try {
    await fs.access(filePath, fsSync.constants.R_OK);
  } catch {
    return [];
  }
  const matchingLines: string[] = [];
  await readFileLines(filePath, (line) => {
    // Stop the in-flight stream promptly when the bundle deadline fires (S1:
    // honour the signal during the read, not just between files).
    if (signal?.aborted) return STOP_READING_FILE_LINES;
    if (!line.trim()) return;
    const timestamp = parseLogTimestamp(line);
    if (!timestamp || timestamp < cutoffTime) return;
    if (filterLevel === 'warn-and-error') {
      const level = getLogLevel(line);
      if (level !== null && level < 40) return;
    }
    matchingLines.push(line);
  }, {
    encoding: 'utf8',
    crlfDelay: Infinity,
  });
  return matchingLines.slice(Math.max(0, matchingLines.length - maxLines));
}

export async function exportRecentLogs(options: Partial<LogExportOptions> = {}, signal?: AbortSignal): Promise<ExportedLogs> {
  const { logWindowMinutes = 15, maxLinesPerFile = 500, filterLevel = 'all' } = options;
  const logsPath = path.join(getDataPath(), 'logs');
  const cutoffTime = new Date(Date.now() - logWindowMinutes * 60 * 1000);
  const now = new Date();
  const exportedFiles: ExportedLogFile[] = [];
  let totalLines = 0;

  const processLogDirectory = async (dirPath: string, prefix = '') => {
    try {
      const entries = await fs.readdir(dirPath);
      const logFiles = entries.filter((f) => f.endsWith('.log')).sort((a, b) => {
        const getOrder = (name: string) => {
          if (name === 'mindstone-rebel.log') return 0;
          const match = name.match(/mindstone-rebel\.(\d+)\.log/);
          return match ? parseInt(match[1], 10) : 999;
        };
        return getOrder(a) - getOrder(b);
      });
      for (const filename of logFiles) {
        // Stop reading further files if the bundle deadline already fired.
        if (signal?.aborted) return;
        const filePath = path.join(dirPath, filename);
        try {
          const stat = await fs.stat(filePath);
          if (stat.mtimeMs < cutoffTime.getTime()) continue;
        } catch {
          continue;
        }
        const lines = await readRecentLogLines(filePath, cutoffTime, maxLinesPerFile, filterLevel, signal);
        if (lines.length > 0) {
          const processedLines = deduplicateLogs(lines);
          const displayName = prefix ? `${prefix}/${filename}` : filename;
          exportedFiles.push({ filename: displayName, content: redactSensitiveData(processedLines.join('\n')), lineCount: processedLines.length });
          totalLines += processedLines.length;
        }
      }
    } catch (error) {
      log.warn({ err: error, dirPath }, 'Failed to read logs directory');
    }
  };

  await processLogDirectory(logsPath);
  await processLogDirectory(path.join(logsPath, 'sessions'), 'sessions');
  return { files: exportedFiles, totalLines, timeWindow: { start: cutoffTime.toISOString(), end: now.toISOString() } };
}

export async function generateDiagnosticBundle(
  settings: AppSettings,
  options: Partial<LogExportOptions> = {},
  _sessionContext?: DiagnosticSessionContext,
): Promise<{ content: string; filename: string }> {
  const { logWindowMinutes = 15 } = options;
  const userData = getDataPath();
  const assembled = await assembleDesktopBundle({
    settings,
    options: { logWindowMinutes },
    paths: { userData, logs: path.join(userData, 'logs'), sessions: path.join(userData, 'sessions'), sentry: path.join(userData, 'sentry') },
    appInfo: { version: getAppVersion(), platform: process.platform, arch: process.arch, isPackaged: isPackaged(), electronVersion: process.versions.electron || 'N/A', nodeVersion: process.versions.node },
    collectors: await buildDesktopBundleCollectors(),
    logger: createScopedLogger({ service: 'diagnosticBundle' }),
  });
  const logSummary = generateLogSummary([], []);
  const markdown = formatDesktopBundleAsMarkdownReport(assembled, logSummary);
  const content = applyFinalSanitization(markdown);
  const timestamp = assembled.manifest.generated;
  const filename = `mindstone-diagnostics-${timestamp.replace(/[:.]/g, '').slice(0, 15)}.md`;
  log.info({ filename, contentLength: content.length, capabilities: assembled.manifest.capabilities }, 'Diagnostic bundle generated');
  return { content, filename };
}

/**
 * Single source of truth for desktop bundle collectors. Both the MD download
 * (`generateDiagnosticBundle`) and the ZIP download (`generateDiagnosticZipBundle`)
 * use this factory so they assemble identical data; only the rendering differs.
 */
async function buildDesktopBundleCollectors(): Promise<
  Parameters<typeof assembleDesktopBundle>[0]['collectors']
> {
  const { captureRamSnapshot } = await import('./ramTelemetryService');
  const { getPerfStatsIfNotable } = await import('./perfAccumulator');
  return {
    // runSystemHealthCheck has no AbortSignal seam, but its internal checks are
    // individually bounded by safeCheck (5s each); the per-collector deadline
    // bounds the outer await. Cancellable collectors below forward the signal.
    runSystemHealthCheck: (s) => runSystemHealthCheck(s, { tier: 'full' }),
    resolveMcpConfigPath,
    readMcpConfig: async (configPath) => JSON.parse(await fs.readFile(configPath, 'utf-8')),
    gatherRecentSessions: (sessionsPath, opts, signal) => gatherRecentSessions(sessionsPath, opts, signal),
    countTotalSessions,
    gatherContinuityDiagnostics: gatherDesktopContinuityDiagnostics,
    captureRamSnapshot,
    gatherSentryScope,
    gatherChiefOfStaffReadme,
    gatherElectronStoreFiles,
    // Live HEAD-only reachability probe so the bundle can answer "no connection?"
    // even when the workspace/health collector hangs on a slow cloud mount.
    refreshProviderReachability: async () => {
      const { refreshProviderReachabilityCache } = await import(
        '@core/services/diagnostics/providerReachabilitySnapshot'
      );
      return refreshProviderReachabilityCache();
    },
    exportRecentLogs: (opts, signal) => exportRecentLogs(opts, signal),
    gatherTurnLogs: (logsPath, opts, signal) => gatherTurnLogs(logsPath, opts, signal),
    getPerfStatsIfNotable: () => getPerfStatsIfNotable() ?? undefined,
    getCostWaterfallByOutcome: async (opts) => {
      const { getCostWaterfallByOutcome } = await import('@core/services/diagnostics/costWaterfall');
      return getCostWaterfallByOutcome(opts);
    },
    gatherDiagnosticEvents: async (): Promise<readonly Record<string, unknown>[]> => {
      try {
        const {
          getDiagnosticEventsLedgerReader,
          flushDiagnosticEventsLedger,
        } = await import('@core/services/diagnosticEventsLedger');
        const { MAX_DIAGNOSTIC_EVENTS, MAX_DIAGNOSTIC_EVENTS_BYTES } = await import('@core/services/diagnostics/manifest');
        await flushDiagnosticEventsLedger();
        const reader = getDiagnosticEventsLedgerReader();
        if (!reader) return [];
        const entries = await reader.readRecent({ limit: MAX_DIAGNOSTIC_EVENTS, maxBytes: MAX_DIAGNOSTIC_EVENTS_BYTES });
        return entries as unknown as readonly Record<string, unknown>[];
      } catch (err) {
        log.warn({ err }, 'Failed to gather diagnostic events for bundle');
        return [];
      }
    },
    getAutoUpdateForensicsSnapshot: () => {
      try {
        const { getAutoUpdateForensicsSnapshot } = require('./autoUpdateStateStore');
        return getAutoUpdateForensicsSnapshot({ platform: process.platform });
      } catch (err) {
        log.warn({ err }, 'Failed to gather auto-update forensics snapshot');
        return undefined;
      }
    },
    getFsExhaustionSnapshot: () => {
      try {
        const { getFsExhaustionSnapshot } = require('@core/utils/gracefulFsObservability') as typeof import('@core/utils/gracefulFsObservability');
        return getFsExhaustionSnapshot();
      } catch (err) {
        log.warn({ err }, 'Failed to gather fs-exhaustion snapshot');
        return undefined;
      }
    },
    getStoreBreakdown: async () => {
      try {
        return await gatherStoreBreakdown(getDataPath());
      } catch (err) {
        log.warn({ err }, 'Failed to gather store breakdown');
        return undefined;
      }
    },
    getProcessSupervisionSnapshot: () => {
      try {
        const { getProcessSupervisionSnapshot } = require('./gracefulShutdown') as typeof import('./gracefulShutdown');
        return getProcessSupervisionSnapshot();
      } catch (err) {
        log.warn({ err }, 'Failed to gather process supervision snapshot');
        return undefined;
      }
    },
    getCloudOutboxSnapshot: () => {
      try {
        const { cloudOutbox } = require('./cloud/cloudOutbox') as typeof import('./cloud/cloudOutbox');
        const status = cloudOutbox.getStatus();
        if (typeof status?.pending !== 'number') return undefined;
        const entries = cloudOutbox.getAll();
        let oldestAgeMs: number | undefined;
        if (entries.length > 0) {
          const now = Date.now();
          let oldest = Number.POSITIVE_INFINITY;
          for (const entry of entries) {
            if (typeof entry.enqueuedAt === 'number' && entry.enqueuedAt < oldest) oldest = entry.enqueuedAt;
          }
          if (Number.isFinite(oldest)) oldestAgeMs = Math.max(0, now - oldest);
        }
        return {
          pending: status.pending,
          ...(oldestAgeMs !== undefined && { oldestAgeMs }),
        };
      } catch (err) {
        log.warn({ err }, 'Failed to gather cloud outbox snapshot');
        return undefined;
      }
    },
  };
}

export interface GatherTurnLogsOptions { maxFiles?: number }

export async function gatherTurnLogs(logsPath: string, options?: GatherTurnLogsOptions, signal?: AbortSignal): Promise<TurnLogFile[]> {
  const maxFiles = options?.maxFiles ?? MAX_TURN_LOGS;
  const sessionsDir = path.join(logsPath, 'sessions');
  try {
    await fs.access(sessionsDir);
  } catch {
    log.debug({ sessionsDir }, 'Session logs directory does not exist');
    return [];
  }
  try {
    const entries = await fs.readdir(sessionsDir, { withFileTypes: true });
    // Bound the stat fan-out + retry each on EMFILE: this runs DURING diagnostic
    // bundle capture (i.e. when the user is reporting the app is broken and FD
    // pressure is already high), and stats every .log before the maxFiles slice,
    // so an unbounded Promise.all here is self-amplifying under pressure.
    const logEntries = entries.filter((entry) => entry.isFile() && entry.name.endsWith('.log'));
    const filesWithStats = await mapWithConcurrencyLimit(logEntries, 8, async (entry) => {
      const filePath = path.join(sessionsDir, entry.name);
      try {
        const stat = await withRetryOnEmfile(() => fs.stat(filePath));
        return { name: entry.name, path: filePath, mtimeMs: stat.mtimeMs, size: stat.size };
      } catch {
        return null;
      }
    });
    const result: TurnLogFile[] = [];
    for (const file of filesWithStats.filter((f): f is NonNullable<typeof f> => f !== null).sort((a, b) => b.mtimeMs - a.mtimeMs).slice(0, maxFiles)) {
      // Stop reading further files once the bundle deadline fires.
      if (signal?.aborted) break;
      try {
        // S1: pass the signal to the in-flight read so it aborts mid-read too.
        result.push({ filename: file.name, content: redactSensitiveData(await fs.readFile(file.path, { encoding: 'utf-8', signal })), sizeBytes: file.size });
      } catch (err) {
        log.warn({ err, filename: file.name }, 'Failed to read turn log file');
      }
    }
    return result;
  } catch (error) {
    log.warn({ err: error, sessionsDir }, 'Failed to gather turn logs');
    return [];
  }
}

export interface GatherRecentSessionsOptions { maxSessions?: number }

export async function gatherRecentSessions(sessionsPath: string, options?: GatherRecentSessionsOptions, signal?: AbortSignal): Promise<SessionExcerpt[]> {
  const maxSessions = options?.maxSessions ?? MAX_RECENT_SESSIONS;
  try {
    await fs.access(sessionsPath);
  } catch {
    log.debug({ sessionsPath }, 'Sessions directory does not exist');
    return [];
  }
  try {
    const entries = await fs.readdir(sessionsPath, { withFileTypes: true });
    const sessions: Array<{ session: AgentSession; mtimeMs: number }> = [];
    for (const entry of entries.filter((entry) => entry.isFile() && entry.name.endsWith('.json') && entry.name !== 'index.json')) {
      // Unbounded session hydration is the prime hang suspect — bail out as
      // soon as the bundle deadline fires so we don't keep loading files for a
      // section that's already been abandoned.
      if (signal?.aborted) break;
      try {
        const filePath = path.join(sessionsPath, entry.name);
        // Hydrate through the session-store boundary (coerces messages/eventsByTurn)
        // so a malformed/partial-write file can't feed a non-array field into the
        // excerpt readers — same boundary as the main session loads.
        // S1: pass the signal to the in-flight read so it aborts mid-read too.
        sessions.push({ session: hydrateSessionArraysOnly(await fs.readFile(filePath, { encoding: 'utf-8', signal })), mtimeMs: (await fs.stat(filePath)).mtimeMs });
      } catch {
        // Skip invalid session files.
      }
    }
    return sessions
      .sort((a, b) => (b.session.updatedAt || b.mtimeMs) - (a.session.updatedAt || a.mtimeMs))
      .slice(0, maxSessions)
      .map(({ session }) => buildDesktopSessionExcerpt(session));
  } catch (error) {
    log.warn({ err: error, sessionsPath }, 'Failed to gather recent sessions');
    return [];
  }
}

async function countTotalSessions(sessionsPath: string): Promise<number | null> {
  try {
    const index = JSON.parse(await fs.readFile(path.join(sessionsPath, 'index.json'), 'utf-8')) as { sessions?: unknown[] };
    return Array.isArray(index.sessions) ? index.sessions.length : null;
  } catch {
    return null;
  }
}

export async function gatherSentryScope(sentryPath: string): Promise<SentryScopeSummary | null> {
  const scopeFilePath = path.join(sentryPath, 'scope_v3.json');
  try {
    await fs.access(scopeFilePath);
    const redactedScope = redactSentryScope(JSON.parse(await fs.readFile(scopeFilePath, 'utf-8'))) as Record<string, unknown>;
    const summary: SentryScopeSummary = {
      breadcrumbs: Array.isArray(redactedScope.breadcrumbs) ? redactedScope.breadcrumbs.slice(-50) : [],
      lastError: typeof redactedScope.lastError === 'string' ? redactedScope.lastError : undefined,
      tags: typeof redactedScope.tags === 'object' && redactedScope.tags !== null ? (redactedScope.tags as Record<string, string>) : undefined,
    };
    if (Array.isArray(redactedScope.breadcrumbs) && redactedScope.breadcrumbs.length > 50) summary.truncatedCount = redactedScope.breadcrumbs.length - 50;
    return summary;
  } catch {
    return null;
  }
}

export async function gatherChiefOfStaffReadme(settings: AppSettings): Promise<string | null> {
  const baseDir = settings.coreDirectory;
  if (!baseDir) return null;
  const cosSpace = settings.spaces?.find((s) => s.type === 'chief-of-staff' || s.path.toLowerCase().replace(/\/$/, '') === 'chief-of-staff');
  const chiefOfStaffDir = cosSpace ? path.join(baseDir, cosSpace.path.replace(/\/$/, '')) : path.join(baseDir, 'Chief-of-Staff');
  for (const filename of ['README.md', 'AGENTS.md']) {
    try {
      return redactChiefOfStaffReadme(await fs.readFile(path.join(chiefOfStaffDir, filename), 'utf-8'));
    } catch {
      // Try the next legacy filename.
    }
  }
  return null;
}

async function tailFile(filePath: string, maxLines: number): Promise<string[]> {
  try {
    return (await fs.readFile(filePath, 'utf-8')).split('\n').filter((line) => line.trim()).slice(-maxLines);
  } catch {
    return [];
  }
}

/**
 * Walk the top-level userData directory and report each file's size and mtime,
 * sorted by size descending and capped at {@link MAX_STORE_BREAKDOWN_ENTRIES}.
 * Subdirectories are skipped — sessions/, logs/, etc. each have their own
 * dedicated collector path. Hidden files and lock-files are filtered out.
 */
export async function gatherStoreBreakdown(userDataPath: string): Promise<StoreBreakdownSnapshot | undefined> {
  let entries: import('node:fs').Dirent[];
  try {
    entries = await fs.readdir(userDataPath, { withFileTypes: true });
  } catch {
    return undefined;
  }
  const fileStats: StoreBreakdownEntry[] = [];
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    if (entry.name.startsWith('.')) continue;
    if (entry.name.endsWith('.lock')) continue;
    const filePath = path.join(userDataPath, entry.name);
    try {
      const stat = await fs.stat(filePath);
      fileStats.push({ name: entry.name, bytes: stat.size, mtimeMs: stat.mtimeMs });
    } catch {
      // Skip files we can't stat — best-effort.
    }
  }
  if (fileStats.length === 0) return undefined;
  const totalBytes = fileStats.reduce((sum, e) => sum + e.bytes, 0);
  const sorted = [...fileStats].sort((a, b) => b.bytes - a.bytes);
  const truncated = sorted.length > MAX_STORE_BREAKDOWN_ENTRIES;
  return {
    entries: sorted.slice(0, MAX_STORE_BREAKDOWN_ENTRIES),
    totalBytes,
    truncated,
  };
}

export async function gatherElectronStoreFiles(userDataPath: string): Promise<Record<string, unknown>> {
  const result: Record<string, unknown> = {};
  const readJsonFile = async (filename: string): Promise<unknown | null> => {
    try {
      return JSON.parse(await fs.readFile(path.join(userDataPath, filename), 'utf-8'));
    } catch {
      return null;
    }
  };
  for (const filename of ['tool-usage.json', 'pending-tool-approvals.json', 'meeting-bot-pending.json', 'physical-recording-pending.json', 'app-install-integrity.json']) {
    const value = await readJsonFile(filename);
    if (value !== null) result[filename] = sanitizeJsonForExport(value);
  }
  const costLines = await tailFile(path.join(userDataPath, 'cost-ledger.jsonl'), MAX_COST_LEDGER_ENTRIES);
  if (costLines.length > 0) result['cost-ledger.jsonl'] = costLines.map((line) => {
    try { return sanitizeJsonForExport(JSON.parse(line)); } catch { return null; }
  }).filter((entry) => entry !== null);
  const automations = await readJsonFile('automations.json');
  if (automations !== null && typeof automations === 'object') {
    const sanitized = sanitizeJsonForExport(automations) as Record<string, unknown>;
    if (Array.isArray(sanitized.automations)) {
      sanitized.automations = (sanitized.automations as Array<Record<string, unknown>>).map((automation) => Array.isArray(automation.runs) && automation.runs.length > 10 ? { ...automation, runs: automation.runs.slice(-10), _runsBeforeTruncation: automation.runs.length } : automation);
    }
    result['automations.json'] = sanitized;
  }
  for (const filename of ['clean-exit-flag.json', 'auto-update-state.json']) {
    const value = await readJsonFile(filename);
    if (value !== null) result[filename] = value;
  }
  return result;
}

export async function gatherDesktopContinuityDiagnostics(): Promise<DesktopContinuityFile[]> {
  const MAX_OUTBOX_ENTRIES = 200;
  const MAX_CONTINUITY_SESSIONS = 200;
  const MAX_WORKSPACE_MANIFEST_ENTRIES = 200;
  const files: DesktopContinuityFile[] = [];
  let cloudOutbox: typeof import('./cloud/cloudOutbox').cloudOutbox;
  let cloudWorkspaceSync: typeof import('./cloud/cloudWorkspaceSync').cloudWorkspaceSync;
  let getAllContinuityStates: typeof import('./cloud/cloudContinuityMetadata').getAllContinuityStates;
  let getLastSessionTombstoneSyncAt: typeof import('./cloud/cloudContinuityMetadata').getLastSessionTombstoneSyncAt;
  try {
    ({ cloudOutbox } = await import('./cloud/cloudOutbox'));
    ({ cloudWorkspaceSync } = await import('./cloud/cloudWorkspaceSync'));
    ({ getAllContinuityStates, getLastSessionTombstoneSyncAt } = await import('./cloud/cloudContinuityMetadata'));
  } catch (error) {
    log.warn({ err: error }, 'Failed to load continuity modules for diagnostic ZIP');
    return files;
  }
  try {
    const outboxStatus = cloudOutbox.getStatus();
    const outboxEntries = cloudOutbox.getAll();
    const entries = outboxEntries.slice(0, MAX_OUTBOX_ENTRIES).map((entry) => ({ entryIdHash: hashForExport(entry.id), sessionIdHash: hashForExport(entry.sessionId), op: entry.op, status: entry.status, attempts: entry.attempts, enqueuedAt: entry.enqueuedAt, nextRetryAt: entry.nextRetryAt, hasLastError: Boolean(entry.lastError) }));
    files.push({ path: 'continuity/outbox-state.json', description: `Cloud outbox snapshot (${outboxStatus.pending} pending)`, truncated: outboxEntries.length > entries.length, content: { status: outboxStatus, totalEntries: outboxEntries.length, entries, truncated: outboxEntries.length > entries.length } });
  } catch (error) {
    log.warn({ err: error }, 'Failed to gather continuity outbox diagnostics');
  }
  try {
    const manifest = cloudWorkspaceSync._getLastPushedManifest();
    const manifestEntries = Array.from(manifest.entries());
    const sampledManifest = manifestEntries.slice(0, MAX_WORKSPACE_MANIFEST_ENTRIES).map(([relativePath, entry]) => ({ relativePathHash: hashForExport(relativePath), extension: path.extname(relativePath), mtime: entry.mtime, size: entry.size, hashPrefix: entry.hash.slice(0, 12) }));
    files.push({ path: 'continuity/workspace-sync-history.json', description: `Workspace sync snapshot (${manifest.size} tracked files)`, truncated: manifestEntries.length > sampledManifest.length, content: { lastSyncAt: cloudWorkspaceSync._getLastSyncAt(), manifestEntryCount: manifest.size, sampledManifest, truncated: manifestEntries.length > sampledManifest.length } });
  } catch (error) {
    log.warn({ err: error }, 'Failed to gather workspace sync diagnostics');
  }
  try {
    const continuityStates = getAllContinuityStates();
    const entries = Object.entries(continuityStates);
    const sessions = entries.slice(0, MAX_CONTINUITY_SESSIONS).map(([sessionId, state]) => ({ sessionIdHash: hashForExport(sessionId), state: state.state, lastCloudActivityAt: state.lastCloudActivityAt ?? null, cloudPinnedAt: state.cloudPinnedAt ?? null }));
    files.push({ path: 'continuity/state-machine-transitions.json', description: `Continuity state map (${entries.length} sessions)`, truncated: entries.length > sessions.length, content: { lastSessionTombstoneSyncAt: getLastSessionTombstoneSyncAt(), totalSessions: entries.length, cloudActiveCount: entries.filter(([, state]) => state.state === 'cloud_active').length, localOnlyCount: entries.filter(([, state]) => state.state === 'local_only').length, sessions, truncated: entries.length > sessions.length } });
  } catch (error) {
    log.warn({ err: error }, 'Failed to gather continuity metadata diagnostics');
  }
  try {
    const { getPayloadHistogramSnapshot } = await import('./cloud/cloudServiceClient');
    files.push({
      path: 'continuity/payload-histogram.json',
      description: 'Desktop cloud payload-size histogram (24h)',
      content: getPayloadHistogramSnapshot(),
    });
  } catch (error) {
    log.warn({ err: error }, 'Failed to gather payload histogram diagnostics');
  }
  return files;
}

export function packageDesktopZip(assembled: AssembledDesktopBundle): { buffer: Buffer; filename: string } {
  const zip = new AdmZip();
  for (const [filename, content] of assembled.files.entries()) zip.addFile(filename, Buffer.from(content, 'utf-8'));
  const buffer = zip.toBuffer();
  log.info({ filename: assembled.filename, sizeBytes: buffer.length, capabilities: assembled.manifest.capabilities, filesCount: Object.keys(assembled.manifest.contents).length }, 'Diagnostic ZIP bundle generated');
  return { buffer, filename: assembled.filename };
}

export async function generateDiagnosticZipBundle(settings: AppSettings, options?: DiagnosticBundleOptions): Promise<{ buffer: Buffer; filename: string; partial?: boolean; unavailableSections?: string[] }> {
  const userData = getDataPath();
  const assembled = await assembleDesktopBundle({
    settings,
    options,
    paths: { userData, logs: path.join(userData, 'logs'), sessions: path.join(userData, 'sessions'), sentry: path.join(userData, 'sentry') },
    appInfo: { version: getAppVersion(), platform: process.platform, arch: process.arch, isPackaged: isPackaged(), electronVersion: process.versions.electron || 'N/A', nodeVersion: process.versions.node },
    collectors: await buildDesktopBundleCollectors(),
    logger: createScopedLogger({ service: 'diagnosticBundle' }),
  });
  const packaged = packageDesktopZip(assembled);
  return {
    ...packaged,
    ...(assembled.manifest.partial ? { partial: true } : {}),
    ...(assembled.manifest.timedOut && assembled.manifest.timedOut.length > 0
      ? { unavailableSections: assembled.manifest.timedOut }
      : {}),
  };
}

/** Per-file byte cap for the minimal fallback's cheap store reads. These two
 * files are small by nature (a few KB); the cap is a defensive ceiling so a
 * pathologically-grown file can't bloat the fallback or slow the parse. */
const CHEAP_STORE_FILE_MAX_BYTES = 256 * 1024;

/**
 * Reads ONLY the two smallest forensic store files — `clean-exit-flag.json` and
 * `auto-update-state.json` — byte-capped and AbortSignal-aware. Deliberately
 * NOT the full {@link gatherElectronStoreFiles} (which reads tool-usage, pending
 * approvals, meeting stores, the WHOLE cost ledger, automations — any of which
 * can hang under the heap/IO pressure that caused the original bug). Used by the
 * minimal always-succeeds fallback.
 */
export async function readCheapStoreFiles(userDataPath: string, signal?: AbortSignal): Promise<Record<string, unknown>> {
  const result: Record<string, unknown> = {};
  for (const filename of ['clean-exit-flag.json', 'auto-update-state.json']) {
    if (signal?.aborted) break;
    try {
      const filePath = path.join(userDataPath, filename);
      // Cap the read: stat first, bail if the file is unexpectedly large.
      const stat = await fs.stat(filePath);
      if (stat.size > CHEAP_STORE_FILE_MAX_BYTES) {
        log.warn({ filename, sizeBytes: stat.size, cap: CHEAP_STORE_FILE_MAX_BYTES }, 'Skipping oversized cheap store file in minimal fallback');
        continue;
      }
      const raw = await fs.readFile(filePath, { encoding: 'utf-8', signal });
      result[filename] = JSON.parse(raw);
    } catch (err) {
      log.debug({ err, filename }, 'Cheap store file unavailable for minimal fallback');
    }
  }
  return result;
}

/**
 * Minimal, always-succeeds fallback ZIP — recent error logs + the cheap,
 * byte-capped clean-exit / auto-update store reads only. Used when the full
 * bundle hangs or throws, so the renderer can always get *something* out. The
 * collectors here are the proven-bounded subset; assembly is itself
 * deadline-guarded.
 */
export async function generateMinimalDiagnosticZipBundle(): Promise<{ buffer: Buffer; filename: string; partial: boolean }> {
  const userData = getDataPath();
  const assembled = await assembleMinimalDesktopBundle({
    appInfo: { version: getAppVersion(), platform: process.platform, arch: process.arch, isPackaged: isPackaged(), electronVersion: process.versions.electron || 'N/A', nodeVersion: process.versions.node },
    userDataPath: userData,
    collectors: {
      exportRecentLogs: (opts, signal) => exportRecentLogs(opts, signal),
      readCheapStoreFiles,
    },
    logger: createScopedLogger({ service: 'diagnosticBundle' }),
  });
  const packaged = packageDesktopZip(assembled);
  return { ...packaged, partial: true };
}
