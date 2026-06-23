/**
 * Bug Report Diagnostic Service
 *
 * Deterministic diagnostic gathering for enriched bug reports.
 * Reuses existing logExportService and systemHealthService functions,
 * then applies privacy-safe log field filtering before output.
 *
 * This service provides the "Phase A" deterministic data that can be
 * sent to Sentry even if the LLM analysis phase fails.
 *
 * @see docs/plans/260324_enriched_bug_report_diagnostics.md — Stage 1
 */

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fnvHashHex as hashForDiagnostics } from '@rebel/shared';
import { createScopedLogger } from '@core/logger';
import { getDataPath } from '@core/utils/dataPaths';
import { normalizeUserPaths } from '@core/utils/logRedaction';
import {
  filterLogEntries,
  sanitizeLogMessage,
  extractAnonymizedSessionMeta,
  type AnonymizedSessionMeta,
} from '@core/utils/logFieldFilter';
import type { LogErrorPattern } from '@core/services/diagnostics/manifest';
import { exportRecentLogs, generateLogSummary } from './logExportService';
import { runSystemHealthCheck } from './systemHealthService';
import { getCategorizedCostSummary } from '@core/services/costLedgerService';
import type { SystemHealthReport } from './systemHealthService';
import type { AppSettings } from '@shared/types';
import type { DiagnosticEventEntry } from '@core/services/diagnostics/manifest';
import {
  getProviderReachabilitySnapshot,
  refreshProviderReachabilityCache,
} from '@core/services/diagnostics/providerReachabilitySnapshot';
import type { ProviderReachabilitySnapshot } from '@shared/diagnostics/providerReachabilitySnapshot';
import {
  defaultDiagnosticSectionStates,
  resolveDiagnosticSection,
  type DiagnosticSections,
  type SectionId,
  type SectionState,
} from '@shared/diagnostics/diagnosticBundleSections';
import { getMcpRegistrationStatus, type McpRegistrationStatus } from './coreStartup';
import { getAnalyticsStatus } from '../analytics';
import { getCachedRendererHealth } from '../ipc/miscHandlers';
import type { RendererAnalyticsHealth } from '@shared/ipc/schemas/misc';

const log = createScopedLogger({ service: 'bugReportDiagnostic' });

// ---------------------------------------------------------------------------
// DI for gatherDeterministicDiagnostics
// ---------------------------------------------------------------------------

export interface GatherDeterministicDiagnosticsDeps {
  exportRecentLogs: typeof exportRecentLogs;
  generateLogSummary: typeof generateLogSummary;
  runSystemHealthCheck: typeof runSystemHealthCheck;
  getMcpRegistrationStatus: typeof getMcpRegistrationStatus;
}

const defaultGatherDeterministicDiagnosticsDeps: GatherDeterministicDiagnosticsDeps = {
  exportRecentLogs,
  generateLogSummary,
  runSystemHealthCheck,
  getMcpRegistrationStatus,
};

// =============================================================================
// Types
// =============================================================================

/** Details for a failed/warning health check, so `critical` is self-explaining. */
export interface HealthCheckDetail {
  id: string;
  status: 'fail' | 'warn';
  message: string;
  /** Error code from the check's details (e.g. `ETIMEDOUT` for a hung cloud mount). */
  code?: string;
}

/** Quick health stats extracted from the full health report */
export interface HealthQuickStats {
  status: 'healthy' | 'degraded' | 'critical';
  failedChecks: string[];
  warnChecks: string[];
  /**
   * Reason details for failed/warning checks. Lets the diagnostic explain *why*
   * health is critical (e.g. the workspace probe timing out on a Google Drive
   * mount) without needing the full log dump.
   */
  checkDetails?: HealthCheckDetail[];
}

/** Filtered log file for diagnostic attachment */
export interface FilteredLogFile {
  filename: string;
  /** NDJSON content with only allowlisted fields */
  filteredContent: string;
  lineCount: number;
}

/** Sanitized error pattern (sampleEntry stripped for privacy) */
export interface SafeErrorPattern {
  msg: string;
  level: number;
  count: number;
  firstSeen: string;
  lastSeen: string;
}

/** Cost summary quick stats for bug report diagnostics */
export interface CostQuickStats {
  /** Cost for the last 24 hours */
  last24hCostUsd: number;
  last24hTurns: number;
  last24hByModel: Record<string, number>;
  /** Cost for the last 7 days */
  last7dCostUsd: number;
  last7dTurns: number;
  /** Cache efficiency for the last 24 hours */
  last24hCacheHitRatio: number | null; // percentage, null if no prompt tokens
  last24hTotalInputTokens: number;
  last24hTotalOutputTokens: number;
}

/** Electron store quick stats */
export interface ElectronStoreQuickStats {
  cleanExitFlag: unknown | null;
  autoUpdateState: unknown | null;
  /**
   * App-install integrity (duplicate / translocated bundles). Surfaced under the
   * `auto_update_forensics` section because duplicate bundles are a leading cause
   * of "the update won't install / I'm stuck on an old version". Null when the
   * check hasn't run (non-macOS, or no snapshot yet).
   */
  appInstallIntegrity?: unknown | null;
}

export interface ContinuityDiagnosticsQuickStats {
  outboxState: {
    pending: number;
    failed: number;
    entryCount: number;
    sampleEntries: Array<{
      sessionIdHash: string;
      op: string;
      attempts: number;
      nextRetryAt: number;
      hasLastError: boolean;
    }>;
  };
  workspaceSyncHistory: {
    lastSyncAt: number;
    trackedFileCount: number;
    sampleFiles: Array<{
      relativePathHash: string;
      size: number;
      mtime: number;
      hashPrefix: string;
    }>;
  };
  stateMachineTransitions: {
    cloudActiveCount: number;
    localOnlyCount: number;
    totalSessionCount: number;
    lastSessionTombstoneSyncAt: number | null;
    sampleStates: Array<{
      sessionIdHash: string;
      state: 'local_only' | 'cloud_active';
      lastCloudActivityAt?: number;
      cloudPinnedAt?: number;
    }>;
  };
}

/**
 * Complete deterministic diagnostics gathered for a bug report.
 * All fields are privacy-safe by construction.
 */
export interface DeterministicDiagnostics {
  /** Timestamp when gathering started */
  gatheredAt: string;
  /** Health check quick stats */
  health: HealthQuickStats | null;
  /** Privacy-filtered log files */
  filteredLogs: FilteredLogFile[];
  /** Error patterns with sampleEntry stripped */
  errorPatterns: SafeErrorPattern[];
  /** Anonymized session metadata for recent sessions */
  recentSessions: AnonymizedSessionMeta[];
  /** Electron store quick stats */
  storeStats: ElectronStoreQuickStats;
  /** Continuity quick stats */
  continuity?: ContinuityDiagnosticsQuickStats;
  /** MCP registration status snapshot */
  mcpRegistration?: McpRegistrationStatus;
  /** Analytics health for main and renderer processes */
  analyticsHealth?: {
    main: { state: string; enabled: boolean; error: string | null };
    renderer: RendererAnalyticsHealth | null;
  };
  /** Cost summary quick stats (last 24h and 7d) */
  costStats?: CostQuickStats;
  /** Recent settings drift observations */
  recentDriftObservations?: DiagnosticEventEntry[];
  /** Cached provider reachability snapshot. Reading this never triggers network probes. */
  providerReachability: ProviderReachabilitySnapshot | null;
  /** Per-section include outcome for this bug-report diagnostic payload. */
  sectionStates?: Partial<Record<SectionId, SectionState>>;
}

// =============================================================================
// Internal Helpers
// =============================================================================

const DEFAULT_LOG_WINDOW_MINUTES = 15;
const TOTAL_TIMEOUT_MS = 10_000;
const MAX_RECENT_SESSIONS = 5;

/**
 * Safely read and parse a JSON file from the user data directory.
 * Returns null on any error (missing, unreadable, invalid JSON).
 */
async function readJsonFile(filePath: string): Promise<unknown | null> {
  try {
    const content = await fs.readFile(filePath, 'utf-8');
    return JSON.parse(content);
  } catch {
    return null;
  }
}

/**
 * Extract quick stats from a SystemHealthReport.
 */
function extractHealthQuickStats(report: SystemHealthReport): HealthQuickStats {
  const failedChecks: string[] = [];
  const warnChecks: string[] = [];
  const checkDetails: HealthCheckDetail[] = [];

  for (const [checkId, checkResult] of Object.entries(report.checks)) {
    if (checkResult.status !== 'fail' && checkResult.status !== 'warn') continue;
    if (checkResult.status === 'fail') {
      failedChecks.push(checkId);
    } else {
      warnChecks.push(checkId);
    }
    // Capture the reason (id/status/message + a safe error code) but NOT the raw
    // details object, which can contain user paths.
    const rawCode = (checkResult.details as Record<string, unknown> | undefined)?.code;
    checkDetails.push({
      id: checkId,
      status: checkResult.status,
      // Check messages can embed user paths (e.g. "Writable at <userDataPath>")
      // — normalise before this lands in the bundle / Sentry. Guard non-string
      // messages (defensive; the type says string but be robust).
      message:
        typeof checkResult.message === 'string'
          ? normalizeUserPaths(checkResult.message)
          : checkResult.message,
      code: typeof rawCode === 'string' ? rawCode : undefined,
    });
  }

  return {
    status: report.status,
    failedChecks,
    warnChecks,
    checkDetails,
  };
}

/**
 * Strip sampleEntry from error patterns (it contains raw log data) AND sanitize
 * the `msg` stem at the source so the resulting `SafeErrorPattern` is privacy-safe
 * by construction.
 *
 * Why sanitize here rather than relying on a downstream pass: the deterministic
 * fallback summary renders these patterns and then the WHOLE assembled markdown is
 * run through `sanitizeLogMessage` as a defense-in-depth pass. That blanket pass's
 * quoted-string rule used to collapse every `"<msg>"` to `"[content-redacted]"` —
 * gutting the single most useful section of the fallback exactly when Phase B has
 * already failed (see docs/plans/260606_bug-report-data-quality/PLAN.md, Stage C).
 * Sanitizing the stem here (stripping embedded content but keeping the structural
 * message stem, codes, and counts) lets the fallback render it WITHOUT surrounding
 * quotes so the stem survives — while the blanket pass remains as a backstop.
 */
function sanitizeErrorPatterns(patterns: LogErrorPattern[]): SafeErrorPattern[] {
  return patterns.map(({ msg, level, count, firstSeen, lastSeen }) => ({
    msg: sanitizeLogMessage(msg),
    level,
    count,
    firstSeen,
    lastSeen,
  }));
}

/**
 * Race a promise against a timeout, returning a fallback on timeout.
 */
function withTimeout<T>(promise: Promise<T>, ms: number, fallback: T): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((resolve) => setTimeout(() => resolve(fallback), ms)),
  ]);
}

// =============================================================================
// Main Gathering Function
// =============================================================================

/**
 * Gather deterministic diagnostics for a bug report.
 *
 * Each step runs independently — if one fails, the others still produce data.
 * The entire operation has a 10s timeout; individual steps fail gracefully.
 *
 * @param settings - App settings (needed for health check)
 * @param options - Optional overrides
 * @returns DeterministicDiagnostics with all gathered (and privacy-filtered) data
 */
export async function gatherDeterministicDiagnostics(
  settings: AppSettings,
  options?: {
    logWindowMinutes?: number;
    includeEnrichedDiagnostics?: boolean;
    attachContinuityDiagnostics?: boolean;
    diagnosticSections?: DiagnosticSections;
  },
  deps: GatherDeterministicDiagnosticsDeps = defaultGatherDeterministicDiagnosticsDeps,
): Promise<DeterministicDiagnostics> {
  const logWindowMinutes = options?.logWindowMinutes ?? DEFAULT_LOG_WINDOW_MINUTES;
  const startTime = Date.now();
  const sectionStates = defaultDiagnosticSectionStates();
  const isEnabled = (sectionId: SectionId): boolean => {
    const resolution = resolveDiagnosticSection(options, sectionId);
    if (!resolution.enabled) {
      sectionStates[sectionId] = resolution.omittedState ?? 'omitted_by_option';
      return false;
    }
    return true;
  };

  log.info({ logWindowMinutes }, 'Starting deterministic diagnostic gathering');

  // Initialize result with safe defaults
  const result: DeterministicDiagnostics = {
    gatheredAt: new Date().toISOString(),
    health: null,
    filteredLogs: [],
    errorPatterns: [],
    recentSessions: [],
    storeStats: {
      cleanExitFlag: null,
      autoUpdateState: null,
    },
    continuity: undefined,
    providerReachability: null,
    sectionStates,
  };

  // Run all gathering steps in parallel, each with its own error handling.
  // The total timeout guards against the entire operation taking too long.
  const gatheringPromise = Promise.all([
    // Step 0: Provider reachability. Refresh with a bounded live probe (HEAD-only,
    // no secrets, classifies tls/dns/timeout) so the bundle can actually answer
    // "is this reachable right now?" — the cache-only read left this `unavailable`
    // on machines that never probed (the gap in Yannick's "no connection" report).
    // Bounded by REACHABILITY_REFRESH_BUDGET_MS and the outer TOTAL_TIMEOUT_MS;
    // falls back to whatever is cached if the refresh times out or throws.
    (async () => {
      if (!isEnabled('provider_reachability')) return;
      try {
        const REACHABILITY_REFRESH_BUDGET_MS = 6000;
        try {
          await Promise.race([
            refreshProviderReachabilityCache(),
            new Promise<void>((resolve) =>
              setTimeout(resolve, REACHABILITY_REFRESH_BUDGET_MS),
            ),
          ]);
        } catch (refreshErr) {
          log.warn(
            { err: refreshErr },
            'Provider reachability refresh failed; falling back to cached snapshot',
          );
        }
        const snapshot = getProviderReachabilitySnapshot();
        const providerCount = Object.keys(snapshot.providers ?? {}).length;
        if (snapshot.snapshotPresent && providerCount > 0) {
          result.providerReachability = snapshot;
          sectionStates.provider_reachability = 'included';
          log.info({ providerCount }, 'Provider reachability snapshot gathered');
        } else {
          sectionStates.provider_reachability = 'unavailable';
        }
      } catch (err) {
        log.warn({ err }, 'Failed to read provider reachability snapshot');
        sectionStates.provider_reachability = 'reader_unavailable';
      }
    })(),

    // Step 1: Health quick stats
    (async () => {
      try {
        const healthReport = await deps.runSystemHealthCheck(settings, { tier: 'quick' });
        result.health = extractHealthQuickStats(healthReport);
        log.info({ status: result.health.status }, 'Health quick stats gathered');
      } catch (err) {
        log.warn({ err }, 'Failed to gather health quick stats');
      }
    })(),

    // Step 2: Recent logs → filtered + error patterns
    (async () => {
      if (!isEnabled('recent_logs')) return;
      try {
        const exportedLogs = await deps.exportRecentLogs({ logWindowMinutes });

        // Apply privacy filter to each log file
        result.filteredLogs = exportedLogs.files.map((file) => ({
          filename: file.filename,
          filteredContent: filterLogEntries(file.content),
          lineCount: file.lineCount,
        }));

        // Generate log summary from raw logs (before filtering) for error patterns
        const logSummary = deps.generateLogSummary(exportedLogs.files, []);
        result.errorPatterns = sanitizeErrorPatterns(logSummary.errorPatterns);

        log.info(
          { fileCount: result.filteredLogs.length, patternCount: result.errorPatterns.length },
          'Logs gathered and filtered',
        );
        sectionStates.recent_logs = result.filteredLogs.length > 0 || result.errorPatterns.length > 0 ? 'included' : 'empty';
      } catch (err) {
        log.warn({ err }, 'Failed to gather and filter logs');
        sectionStates.recent_logs = 'reader_unavailable';
      }
    })(),

    // Step 3: Anonymized session metadata
    (async () => {
      try {
        const sessionsPath = path.join(getDataPath(), 'sessions');
        const entries = await fs.readdir(sessionsPath, { withFileTypes: true });

        const sessionFiles = entries.filter(
          (entry) =>
            entry.isFile() &&
            entry.name.endsWith('.json') &&
            entry.name !== 'index.json',
        );

        // Read sessions and sort by modification time
        const sessions: Array<{ session: Record<string, unknown>; mtimeMs: number }> = [];
        for (const entry of sessionFiles) {
          try {
            const filePath = path.join(sessionsPath, entry.name);
            const content = await fs.readFile(filePath, 'utf-8');
            const session = JSON.parse(content) as Record<string, unknown>;
            const stat = await fs.stat(filePath);
            sessions.push({ session, mtimeMs: stat.mtimeMs });
          } catch {
            // Skip invalid session files
          }
        }

        // Sort by updatedAt descending, take the most recent
        sessions.sort((a, b) => {
          const aTime = typeof a.session.updatedAt === 'number' ? a.session.updatedAt : a.mtimeMs;
          const bTime = typeof b.session.updatedAt === 'number' ? b.session.updatedAt : b.mtimeMs;
          return bTime - aTime;
        });

        result.recentSessions = sessions.slice(0, MAX_RECENT_SESSIONS).map(({ session }) =>
          extractAnonymizedSessionMeta(session as Parameters<typeof extractAnonymizedSessionMeta>[0]),
        );

        log.info({ count: result.recentSessions.length }, 'Session metadata gathered');
      } catch (err) {
        log.warn({ err }, 'Failed to gather session metadata');
      }
    })(),

    // Step 4: Electron store quick stats
    (async () => {
      try {
        const userDataPath = getDataPath();
        const [cleanExitFlag, autoUpdateState, appInstallIntegrity] = await Promise.all([
          readJsonFile(path.join(userDataPath, 'clean-exit-flag.json')),
          readJsonFile(path.join(userDataPath, 'auto-update-state.json')),
          readJsonFile(path.join(userDataPath, 'app-install-integrity.json')),
        ]);
        const includeAutoUpdateForensics = isEnabled('auto_update_forensics');
        result.storeStats = {
          cleanExitFlag,
          autoUpdateState: includeAutoUpdateForensics ? autoUpdateState : null,
          appInstallIntegrity: includeAutoUpdateForensics ? appInstallIntegrity : null,
        };
        sectionStates.auto_update_forensics = includeAutoUpdateForensics
          ? (autoUpdateState || appInstallIntegrity ? 'included' : 'empty')
          : sectionStates.auto_update_forensics;
        log.info('Electron store quick stats gathered');
      } catch (err) {
        log.warn({ err }, 'Failed to gather Electron store quick stats');
      }
    })(),

    // Step 5: Cost summary quick stats (last 24h and 7d)
    (async () => {
      if (!isEnabled('cost_summary')) return;
      try {
        const now = Date.now();
        const ms24h = 24 * 60 * 60 * 1000;
        const ms7d = 7 * 24 * 60 * 60 * 1000;

        const [last24h, last7d] = await Promise.all([
          getCategorizedCostSummary({ startTs: now - ms24h }),
          getCategorizedCostSummary({ startTs: now - ms7d }),
        ]);

        const promptTokens24h = last24h.totalInputTokens + last24h.totalCacheCreationTokens + last24h.totalCacheReadTokens;
        result.costStats = {
          last24hCostUsd: last24h.total,
          last24hTurns: last24h.turnCount,
          last24hByModel: last24h.byModel,
          last7dCostUsd: last7d.total,
          last7dTurns: last7d.turnCount,
          last24hCacheHitRatio: promptTokens24h > 0
            ? Math.round((last24h.totalCacheReadTokens / promptTokens24h) * 1000) / 10
            : null,
          last24hTotalInputTokens: last24h.totalInputTokens,
          last24hTotalOutputTokens: last24h.totalOutputTokens,
        };
        log.info({ last24hCost: last24h.total, last7dCost: last7d.total }, 'Cost quick stats gathered');
        sectionStates.cost_summary = last24h.turnCount > 0 || last7d.turnCount > 0 ? 'included' : 'empty';
      } catch (err) {
        log.warn({ err }, 'Failed to gather cost quick stats');
        sectionStates.cost_summary = 'reader_unavailable';
      }
    })(),

    // Step 6: Continuity/outbox/workspace quick stats
    (async () => {
      if (!isEnabled('continuity_trail')) return;
      try {
        const { cloudOutbox } = await import('./cloud/cloudOutbox');
        const { cloudWorkspaceSync } = await import('./cloud/cloudWorkspaceSync');
        const {
          getAllContinuityStates,
          getLastSessionTombstoneSyncAt,
        } = await import('./cloud/cloudContinuityMetadata');

        const outboxStatus = cloudOutbox.getStatus();
        const outboxEntries = cloudOutbox.getAll();
        const sampleOutboxEntries = outboxEntries.slice(0, 20).map((entry) => ({
          sessionIdHash: hashForDiagnostics(entry.sessionId),
          op: entry.op,
          attempts: entry.attempts,
          nextRetryAt: entry.nextRetryAt,
          hasLastError: Boolean(entry.lastError),
        }));

        const manifest = cloudWorkspaceSync._getLastPushedManifest();
        const sampleFiles = Array.from(manifest.entries())
          .slice(0, 20)
          .map(([relativePath, entry]) => ({
            relativePathHash: hashForDiagnostics(relativePath),
            size: entry.size,
            mtime: entry.mtime,
            hashPrefix: entry.hash.slice(0, 12),
          }));

        const continuityStates = getAllContinuityStates();
        const entries = Object.entries(continuityStates);
        const sampleStates = entries.slice(0, 20).map(([sessionId, state]) => ({
          sessionIdHash: hashForDiagnostics(sessionId),
          state: state.state,
          ...(typeof state.lastCloudActivityAt === 'number' ? { lastCloudActivityAt: state.lastCloudActivityAt } : {}),
          ...(typeof state.cloudPinnedAt === 'number' ? { cloudPinnedAt: state.cloudPinnedAt } : {}),
        }));

        result.continuity = {
          outboxState: {
            pending: outboxStatus.pending,
            failed: outboxStatus.failed,
            entryCount: outboxEntries.length,
            sampleEntries: sampleOutboxEntries,
          },
          workspaceSyncHistory: {
            lastSyncAt: cloudWorkspaceSync._getLastSyncAt(),
            trackedFileCount: manifest.size,
            sampleFiles,
          },
          stateMachineTransitions: {
            cloudActiveCount: entries.filter(([, state]) => state.state === 'cloud_active').length,
            localOnlyCount: entries.filter(([, state]) => state.state === 'local_only').length,
            totalSessionCount: entries.length,
            lastSessionTombstoneSyncAt: getLastSessionTombstoneSyncAt(),
            sampleStates,
          },
        };

        log.info({ outboxEntries: outboxEntries.length, continuityStates: entries.length }, 'Continuity quick stats gathered');
        sectionStates.continuity_trail = outboxEntries.length > 0 || manifest.size > 0 || entries.length > 0 ? 'included' : 'empty';
      } catch (err) {
        log.warn({ err }, 'Failed to gather continuity quick stats');
        sectionStates.continuity_trail = 'reader_unavailable';
      }
    })(),

    // Step 7: Recent drift observations
    (async () => {
      if (!isEnabled('settings_drift')) return;
      try {
        const { getDiagnosticEventsLedgerReader } = await import('@core/services/diagnosticEventsLedger');
        const reader = getDiagnosticEventsLedgerReader();
        if (reader) {
          const events = await reader.readRecent({ limit: 1000, maxBytes: 5 * 1024 * 1024 });
          result.recentDriftObservations = events.filter(e => e.kind === 'settings_drift_observation');
          log.info({ count: result.recentDriftObservations.length }, 'Recent drift observations gathered');
          sectionStates.settings_drift = result.recentDriftObservations.length > 0 ? 'included' : 'empty';
        } else {
          sectionStates.settings_drift = 'reader_unavailable';
        }
      } catch (err) {
        log.warn({ err }, 'Failed to gather recent drift observations');
        sectionStates.settings_drift = 'reader_unavailable';
      }
    })(),
  ]);

  for (const sectionId of ['health_timing', 'index_health', 'pre_turn_worker', 'recent_events'] as const) {
    if (isEnabled(sectionId)) sectionStates[sectionId] = 'unavailable';
  }

  // Apply total timeout
  await withTimeout(gatheringPromise, TOTAL_TIMEOUT_MS, undefined);

  // MCP registration status — synchronous snapshot, no timeout needed
  try {
    const mcpStatus = deps.getMcpRegistrationStatus();
    if (mcpStatus.lifecycle !== 'not_started') {
      result.mcpRegistration = mcpStatus;
    }
  } catch {
    // Non-fatal — MCP status unavailable
  }

  // Analytics health — synchronous snapshot from main + cached renderer state
  try {
    const mainStatus = getAnalyticsStatus();
    result.analyticsHealth = {
      main: {
        state: mainStatus.state,
        enabled: mainStatus.enabled,
        error: mainStatus.error ?? null,
      },
      renderer: getCachedRendererHealth(),
    };
  } catch {
    // Non-fatal — analytics status unavailable
  }

  const elapsed = Date.now() - startTime;
  log.info(
    {
      elapsed,
      hasHealth: result.health !== null,
      logFileCount: result.filteredLogs.length,
      errorPatternCount: result.errorPatterns.length,
      sessionCount: result.recentSessions.length,
    },
    'Deterministic diagnostic gathering complete',
  );

  return result;
}

// =============================================================================
// Update Forensics (Stage 0 stubs — wired up in Stage 3)
// =============================================================================
//
// Why split into async-gather + sync-attach?
//
// `Sentry.withScope(callback)` is synchronous. If async I/O were performed
// inside the callback, attachments could be added AFTER `captureMessage`
// returns, and the Sentry transport could ship the event without them.
//
// Stage 3 will:
//   1. `await gatherUpdateForensics(...)` BEFORE entering `withScope` —
//      this is where all file reads, size caps, and privacy scrubs happen.
//   2. Call `attachUpdateForensicsToScope(scope, bundle)` INSIDE `withScope` —
//      this is purely synchronous: it iterates the gathered bundle and calls
//      `scope.addAttachment(...)` for each item plus the manifest.
//
// See `docs/plans/260428_install_completion_contract.md` (Stage 0 + Stage 3,
// critical issue C3 in the Phase 2 critique).

/**
 * A single forensic attachment for a Sentry bug report.
 *
 * `data` is `Buffer | string` so binary plist files (e.g. `ShipItState.plist`)
 * can be attached as bytes while text files can be attached as strings.
 */
export interface UpdateForensicsAttachment {
  filename: string;
  data: Buffer | string;
  contentType?: string;
}

/**
 * Manifest entry recording the outcome of attempting to gather one forensic file.
 *
 * Allows reviewers to see which files were attached, missing, or failed —
 * even when an individual gather step fails silently.
 */
export interface UpdateForensicsManifestEntry {
  filename: string;
  status: 'attached' | 'missing' | 'failed';
  error?: string;
}

/**
 * The output of `gatherUpdateForensics()` — a synchronous payload ready to
 * be attached inside a `Sentry.withScope` callback.
 */
export interface UpdateForensicsBundle {
  attachments: UpdateForensicsAttachment[];
  manifest: UpdateForensicsManifestEntry[];
}

/**
 * Minimal Sentry `Scope` shape needed for `attachUpdateForensicsToScope`.
 *
 * Stage 0 keeps the type local to avoid a new direct dependency on
 * `@sentry/electron/main` from this module; Stage 3 may refine if the
 * implementer needs additional scope capabilities.
 */
export interface SentryScopeForAttachment {
  addAttachment(attachment: {
    filename: string;
    data: Buffer | string | Uint8Array;
    contentType?: string;
  }): void;
}

/** Hard cap on the raw bytes of `auto-update-state.json` attached when JSON parse fails. */
const MAX_AUTO_UPDATE_STATE_RAW_BYTES = 64 * 1024;
/** Hard cap on the bytes attached from `ShipIt_stderr.log` (last N bytes if larger). */
const MAX_SHIPIT_STDERR_BYTES = 200 * 1024;

/**
 * Replace `$HOME` and literal `/Users/<segment>/` path prefixes with `~/` so the
 * forensic attachments don't leak the local username into Sentry.
 *
 * The split-and-join approach handles the env-var case without regex escaping;
 * the regex catches the residual `/Users/<x>/` patterns even if `$HOME` is unset
 * or differs from the actual path prefix in the captured logs.
 */
function scrubHomePath(text: string): string {
  const home = process.env.HOME;
  let out = text;
  if (home && home.length > 0) {
    out = out.split(home).join('~');
  }
  // Catch literal /Users/<segment>/ patterns even when HOME is unset
  out = out.replace(/\/Users\/[^/\s]+\//g, '~/');
  return out;
}

/**
 * Read the last N bytes of a file. Returns the bytes (or the entire file if it
 * is smaller than N). Throws if the file is missing or unreadable.
 */
async function readLastBytes(filePath: string, maxBytes: number): Promise<Buffer> {
  const stat = await fs.stat(filePath);
  if (stat.size <= maxBytes) {
    return await fs.readFile(filePath);
  }
  const handle = await fs.open(filePath, 'r');
  try {
    const buffer = Buffer.alloc(maxBytes);
    const offset = stat.size - maxBytes;
    const { bytesRead } = await handle.read(buffer, 0, maxBytes, offset);
    return bytesRead === maxBytes ? buffer : buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

/** True when a Buffer looks like an Apple binary plist (starts with `bplist`). */
function isBinaryPlist(buf: Buffer): boolean {
  if (buf.length < 6) return false;
  return buf.slice(0, 6).toString('utf8') === 'bplist';
}

/**
 * Gather all available update-forensics files for a bug report.
 *
 * Best-effort: every per-file read is guarded with try/catch and recorded in
 * the manifest with `status: 'attached' | 'missing' | 'failed'`. This function
 * never throws — callers should still wrap the call in their own try/catch as
 * a defence-in-depth measure (see `bugReportHandlers.ts`).
 *
 * Reads:
 *   - `<userData>/auto-update-state.json` — JSON parse; on failure, attach raw
 *     bytes (≤ 64 KB) under filename `auto-update-state.raw.json`.
 *   - `<userData>/auto-update-watchdog-telemetry.json` — raw text if present.
 *   - `<userData>/update-install-marker.json` — raw text if present.
 *
 * macOS only:
 *   - `~/Library/Caches/<bundleId>.ShipIt/ShipIt_stderr.log` (last 200 KB).
 *   - `~/Library/Caches/<bundleId>.ShipIt/ShipItState.plist` (raw bytes; binary
 *     plists are attached as-is, XML plists are scrubbed first).
 *
 * Privacy scrub (`scrubHomePath`) is applied to all macOS text attachments
 * AND to JSON-parsed payloads from `auto-update-state.json` etc. before they
 * reach Sentry — the goal is to strip `/Users/<username>/` path prefixes that
 * commonly appear in error messages, paths, and telemetry strings.
 *
 * @param opts.userDataPath Resolved Electron userData directory.
 * @param opts.bundleId Result of `app.getBundleId()` — used for the macOS
 *   ShipIt cache path. Caller is responsible for choosing the right value
 *   in dev vs packaged contexts.
 */
export async function gatherUpdateForensics(opts: {
  userDataPath: string;
  bundleId: string;
}): Promise<UpdateForensicsBundle> {
  const { userDataPath, bundleId } = opts;
  const attachments: UpdateForensicsAttachment[] = [];
  const manifest: UpdateForensicsManifestEntry[] = [];

  // -------------------------------------------------------------------------
  // <userData>/auto-update-state.json (JSON; on parse failure, attach raw)
  // -------------------------------------------------------------------------
  const autoUpdateStatePath = path.join(userDataPath, 'auto-update-state.json');
  try {
    const raw = await fs.readFile(autoUpdateStatePath, 'utf-8');
    try {
      // Parse to validate JSON, then re-serialize with scrub applied so any
      // embedded `/Users/<x>/` paths don't reach Sentry verbatim.
      const parsed = JSON.parse(raw);
      const scrubbed = scrubHomePath(JSON.stringify(parsed, null, 2));
      attachments.push({
        filename: 'auto-update-state.json',
        data: scrubbed,
        contentType: 'application/json',
      });
      manifest.push({ filename: 'auto-update-state.json', status: 'attached' });
    } catch (parseErr) {
      // Truncate raw bytes to keep payload bounded; still useful for forensics.
      const bytes = Buffer.from(raw, 'utf-8');
      const slice = bytes.length > MAX_AUTO_UPDATE_STATE_RAW_BYTES
        ? bytes.subarray(0, MAX_AUTO_UPDATE_STATE_RAW_BYTES)
        : bytes;
      const scrubbed = scrubHomePath(slice.toString('utf-8'));
      attachments.push({
        filename: 'auto-update-state.raw.json',
        data: scrubbed,
        contentType: 'text/plain',
      });
      manifest.push({
        filename: 'auto-update-state.json',
        status: 'failed',
        error: 'parse',
      });
      void parseErr;
    }
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code === 'ENOENT') {
      manifest.push({ filename: 'auto-update-state.json', status: 'missing' });
    } else {
      manifest.push({
        filename: 'auto-update-state.json',
        status: 'failed',
        error: toForensicsError(err),
      });
    }
  }

  // -------------------------------------------------------------------------
  // <userData>/auto-update-watchdog-telemetry.json — attach as text if present
  // -------------------------------------------------------------------------
  const watchdogTelemetryPath = path.join(userDataPath, 'auto-update-watchdog-telemetry.json');
  await readAndAttachTextFile(
    watchdogTelemetryPath,
    'auto-update-watchdog-telemetry.json',
    'application/json',
    attachments,
    manifest,
  );

  // -------------------------------------------------------------------------
  // <userData>/update-install-marker.json — attach as text if present
  // -------------------------------------------------------------------------
  const installMarkerPath = path.join(userDataPath, 'update-install-marker.json');
  await readAndAttachTextFile(
    installMarkerPath,
    'update-install-marker.json',
    'application/json',
    attachments,
    manifest,
  );

  // -------------------------------------------------------------------------
  // macOS-only: ShipIt log + plist
  // -------------------------------------------------------------------------
  if (process.platform === 'darwin') {
    const shipItCacheDir = bundleId
      ? path.join(os.homedir(), 'Library', 'Caches', `${bundleId}.ShipIt`)
      : null;

    if (!shipItCacheDir) {
      manifest.push({
        filename: 'ShipIt_stderr.log',
        status: 'failed',
        error: 'bundleId-resolution-failed',
      });
      manifest.push({
        filename: 'ShipItState.plist',
        status: 'failed',
        error: 'bundleId-resolution-failed',
      });
    } else {
      // ShipIt_stderr.log — read last 200 KB, scrub, attach as text
      const stderrLogPath = path.join(shipItCacheDir, 'ShipIt_stderr.log');
      try {
        const tail = await readLastBytes(stderrLogPath, MAX_SHIPIT_STDERR_BYTES);
        const scrubbed = scrubHomePath(tail.toString('utf-8'));
        attachments.push({
          filename: 'ShipIt_stderr.log',
          data: scrubbed,
          contentType: 'text/plain',
        });
        manifest.push({ filename: 'ShipIt_stderr.log', status: 'attached' });
      } catch (err) {
        const code = (err as NodeJS.ErrnoException)?.code;
        if (code === 'ENOENT') {
          manifest.push({ filename: 'ShipIt_stderr.log', status: 'missing' });
        } else {
          manifest.push({
            filename: 'ShipIt_stderr.log',
            status: 'failed',
            error: toForensicsError(err),
          });
        }
      }

      // ShipItState.plist — read raw; binary plist attached as-is, XML scrubbed
      const plistPath = path.join(shipItCacheDir, 'ShipItState.plist');
      try {
        const buf = await fs.readFile(plistPath);
        const data: Buffer | string = isBinaryPlist(buf)
          ? buf
          : scrubHomePath(buf.toString('utf-8'));
        attachments.push({
          filename: 'ShipItState.plist',
          data,
          contentType: 'application/x-plist',
        });
        manifest.push({ filename: 'ShipItState.plist', status: 'attached' });
      } catch (err) {
        const code = (err as NodeJS.ErrnoException)?.code;
        if (code === 'ENOENT') {
          manifest.push({ filename: 'ShipItState.plist', status: 'missing' });
        } else {
          manifest.push({
            filename: 'ShipItState.plist',
            status: 'failed',
            error: toForensicsError(err),
          });
        }
      }
    }
  }

  return { attachments, manifest };
}

/**
 * Coerce an arbitrary thrown value into a short manifest-friendly error string.
 * Prefers `error.code` (e.g. `EACCES`, `EPERM`) when present; otherwise falls
 * back to the message. Never returns the raw stack — manifest is user-visible
 * in Sentry and we don't want absolute paths or stack frames there.
 */
function toForensicsError(err: unknown): string {
  if (err && typeof err === 'object') {
    const code = (err as { code?: unknown }).code;
    if (typeof code === 'string' && code.length > 0) return code;
    const message = (err as { message?: unknown }).message;
    if (typeof message === 'string' && message.length > 0) return message;
  }
  return String(err);
}

/**
 * Helper: read a file as UTF-8 text, push to attachments+manifest with the
 * appropriate status. Used for the `<userData>/...` JSON files which are
 * attached raw (not parsed) — corruption of these files isn't a hard failure.
 */
async function readAndAttachTextFile(
  filePath: string,
  filename: string,
  contentType: string,
  attachments: UpdateForensicsAttachment[],
  manifest: UpdateForensicsManifestEntry[],
): Promise<void> {
  try {
    const text = await fs.readFile(filePath, 'utf-8');
    attachments.push({
      filename,
      data: scrubHomePath(text),
      contentType,
    });
    manifest.push({ filename, status: 'attached' });
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code === 'ENOENT') {
      manifest.push({ filename, status: 'missing' });
    } else {
      manifest.push({ filename, status: 'failed', error: toForensicsError(err) });
    }
  }
}

/**
 * Attach a previously-gathered forensics bundle to a Sentry scope.
 *
 * MUST stay synchronous — this runs inside `Sentry.withScope(callback)`, and
 * any async work would race with `captureMessage`. All I/O happens in
 * `gatherUpdateForensics` BEFORE `withScope` is entered.
 *
 * Each `addAttachment` call is wrapped in try/catch so one failed attachment
 * (e.g. a Sentry SDK quirk on a particular MIME type) doesn't prevent the
 * others from attaching. A final attachment of the manifest itself gives
 * reviewers a deterministic record of which files were attached/missing/failed.
 */
export function attachUpdateForensicsToScope(
  scope: SentryScopeForAttachment,
  bundle: UpdateForensicsBundle,
): void {
  for (const attachment of bundle.attachments) {
    try {
      scope.addAttachment({
        filename: attachment.filename,
        data: attachment.data,
        contentType: attachment.contentType,
      });
    } catch (err) {
      log.warn(
        { err, filename: attachment.filename },
        'Failed to attach update forensics file to Sentry scope',
      );
    }
  }

  // Manifest itself — always attached, even if every file read failed, so
  // reviewers can see WHICH file failed and how.
  try {
    scope.addAttachment({
      filename: 'update-forensics-manifest.json',
      data: JSON.stringify(bundle.manifest, null, 2),
      contentType: 'application/json',
    });
  } catch (err) {
    log.warn({ err }, 'Failed to attach update-forensics-manifest.json');
  }
}
