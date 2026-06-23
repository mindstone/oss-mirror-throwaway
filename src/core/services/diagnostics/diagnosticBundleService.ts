import { fnvHashHex } from '@rebel/shared';
import type { AppSettings } from '@shared/types';
import { getErrorReporter } from '@core/errorReporter';
import { runWithTimeout } from '@core/utils/withTimeout';
import {
  DIAGNOSTIC_SECTION_IDS,
  defaultDiagnosticSectionStates,
  resolveDiagnosticSection,
  type SectionId,
  type SectionState,
} from '@shared/diagnostics/diagnosticBundleSections';
import { sanitizeJsonForExport, redactObjectDeep, redactMcpEnvVars } from '@core/utils/logRedaction';
import type { ProviderReachabilitySnapshot } from '@shared/diagnostics/providerReachabilitySnapshot';
import { ignoreBestEffortCleanup } from '@shared/utils/intentionalSwallow';
import {
  CLOUD_MAX_SESSIONS_IN_SELF_DIAGNOSTICS,
  CLOUD_MAX_TOMBSTONES_IN_SELF_DIAGNOSTICS,
  CLOUD_SELF_DIAGNOSTICS_MAX_BYTES,
  DEFAULT_AGENT_GUIDANCE,
  DEFAULT_AGENT_GUIDANCE_NO_LOGS,
  DEFAULT_LOG_WINDOW_MINUTES,
  DIAGNOSTIC_BUNDLE_DEADLINE_MS,
  DIAGNOSTIC_COLLECTOR_TIMEOUT_MS,
  DIAGNOSTIC_MANIFEST_SCHEMA_VERSION,
  MAX_COST_LEDGER_ENTRIES,
  MAX_LINES_PER_LOG_FILE,
  MAX_RECENT_SESSIONS,
  MAX_TURN_LOGS,
  type CloudDiagnosticCheckResult,
  type CloudLegacyDiagnosticsBundle,
  type CloudSelfDiagnosticsBundle,
  type DiagnosticAppInfo,
  type DiagnosticBundleOptions,
  type DiagnosticEventEntry,
  type DiagnosticEventKind,
  type DiagnosticFileEntry,
  type AssembledDesktopBundle,
  type DiagnosticManifest,
  type DiagnosticPerfStats,
  type DiagnosticSessionSummary,
  type LogSummary,
  type MobileDiagnosticsBundle,
  type MobileDiagnosticsSourceBundle,
  type SentryScopeSummary,
  type SessionExcerpt,
  type SessionsIndex,
  type TurnLogFile,
} from './manifest';
import { formatBundleReadme } from './manifestFormatters';
import { generateLogSummary, type ExportedLogFileLike } from './logSummary';
import { computeBundleParams, computeCapabilities, computeQuickStats, type HealthReportLike } from './quickStats';
import { redactSensitiveData } from './redaction';
import { normalizeCloudSessionSummaries, buildMobileSessionsIndex, type MobileSessionLike } from './sessionIndexTypes';
import { clipUtf8Tail, payloadBytes } from './utf8';

/**
 * Minimal logger seam for the diagnostic-bundle service. Kept deliberately
 * narrow (just the one `warn(obj, msg)` call shape used at the collector-timeout
 * site) so this module never statically imports the Node-only `@core/logger`
 * (pino / `node:fs` / `import.meta`), which would drag the desktop logger into
 * the React Native bundle graph and break the mobile build (Hermes can't parse
 * `import.meta`). Desktop callers inject the real `createScopedLogger`; the
 * mobile + cloud assembly paths don't use it and default to {@link NOOP_LOGGER}.
 */
export interface DiagnosticBundleLogger {
  warn(obj: Record<string, unknown>, msg: string): void;
}

const NOOP_LOGGER: DiagnosticBundleLogger = { warn: () => {} };

export interface DesktopExportedLogs {
  files: ExportedLogFileLike[];
  totalLines: number;
  timeWindow: { start: string; end: string };
}

export interface DesktopContinuityFile {
  path: string;
  content: unknown;
  description: string;
  truncated?: boolean;
}

export interface DesktopBundleCollectors {
  /**
   * Collectors marked with an optional trailing `signal: AbortSignal` parameter
   * forward it to their underlying `fs`/I/O so background work can stop when the
   * per-collector deadline fires (mitigates the abandoned-promise residual, A7).
   * Collectors that do cheap synchronous store reads, or whose I/O cannot honour
   * an `AbortSignal`, leave it unused — the deadline still bounds the *await*,
   * and sequential wrapping bounds the residual to ≤1 lingering promise.
   */
  runSystemHealthCheck: (settings: AppSettings, signal?: AbortSignal) => Promise<HealthReportLike>;
  resolveMcpConfigPath: (settings: AppSettings) => string | null;
  readMcpConfig: (configPath: string) => Promise<unknown>;
  gatherRecentSessions: (sessionsPath: string, options: { maxSessions: number }, signal?: AbortSignal) => Promise<SessionExcerpt[]>;
  countTotalSessions: (sessionsPath: string) => Promise<number | null>;
  gatherContinuityDiagnostics: () => Promise<DesktopContinuityFile[]>;
  captureRamSnapshot: () => unknown;
  gatherSentryScope: (sentryPath: string) => Promise<SentryScopeSummary | null>;
  gatherChiefOfStaffReadme: (settings: AppSettings) => Promise<string | null>;
  gatherElectronStoreFiles: (userDataPath: string) => Promise<Record<string, unknown>>;
  exportRecentLogs: (options: { logWindowMinutes: number; maxLinesPerFile: number; filterLevel: 'all' | 'warn-and-error' }, signal?: AbortSignal) => Promise<DesktopExportedLogs>;
  gatherTurnLogs: (logsPath: string, options: { maxFiles: number }, signal?: AbortSignal) => Promise<TurnLogFile[]>;
  getPerfStatsIfNotable: () => DiagnosticPerfStats | undefined;
  getCostWaterfallByOutcome?: (options: { since: number }) => Promise<unknown>;
  /**
   * Optional. Returns recent diagnostic-events ledger entries (oldest-first)
   * to embed under `events.jsonl`. When omitted (or returning empty) the
   * file is simply not written; callers/tests don't have to provide it.
   */
  gatherDiagnosticEvents?: () => Promise<readonly Record<string, unknown>[]>;
  /** Optional. Snapshot of auto-update state and install marker. */
  getAutoUpdateForensicsSnapshot?: () => import('./manifest').AutoUpdateForensics | undefined;
  /**
   * Optional. EMFILE / graceful-fs pressure snapshot from
   * {@link import('@core/utils/gracefulFsObservability').getFsExhaustionSnapshot}.
   * Embedded in `quickStats.fsExhaustion` only when there's something to report.
   */
  getFsExhaustionSnapshot?: () => import('./manifest').FsExhaustionSnapshot | undefined;
  /**
   * Optional. Top-level userData store-file size breakdown. Sorted by bytes
   * descending and capped at `MAX_STORE_BREAKDOWN_ENTRIES` by the collector.
   */
  getStoreBreakdown?: () => Promise<import('./manifest').StoreBreakdownSnapshot | undefined>;
  /**
   * Optional. Main-process supervision counters derived from the existing
   * `clean-exit-flag.json` store. Cheap synchronous read.
   */
  getProcessSupervisionSnapshot?: () => import('./manifest').ProcessSupervisionSnapshot | undefined;
  /**
   * Optional. Cloud-outbox pending count + oldest queue age (computed from
   * the durable outbox's enqueue timestamps).
   */
  getCloudOutboxSnapshot?: () => import('./manifest').CloudOutboxSnapshot | undefined;
  /**
   * Optional. Live provider/cloud reachability probe (HEAD-only, no secrets,
   * classifies tls/dns/timeout). Runs FIRST and on its own deadline so a hung
   * filesystem/health collector can't suppress it — this is the section that
   * answers "no connection?" for the user. Desktop-only; the cloud self-diag
   * path intentionally leaves provider_reachability `unavailable`.
   */
  refreshProviderReachability?: (signal?: AbortSignal) => Promise<unknown>;
}

export interface AssembleDesktopBundleInput {
  settings: AppSettings;
  options?: DiagnosticBundleOptions;
  collectors: DesktopBundleCollectors;
  paths: { userData: string; logs: string; sessions: string; sentry: string };
  appInfo: DiagnosticAppInfo;
  now?: () => number;
  /** Overall bundle deadline override (ms). Defaults to {@link DIAGNOSTIC_BUNDLE_DEADLINE_MS}. Test seam. */
  deadlineMs?: number;
  /** Per-collector deadline override (ms). Defaults to {@link DIAGNOSTIC_COLLECTOR_TIMEOUT_MS}. Test seam. */
  collectorTimeoutMs?: number;
  /**
   * Injected logger for the collector-timeout breadcrumb. Desktop callers pass
   * `createScopedLogger({ service: 'diagnosticBundle' })`; defaults to a no-op
   * so this module stays free of the Node-only `@core/logger` import (keeps the
   * RN bundle graph clean). See {@link DiagnosticBundleLogger}.
   */
  logger?: DiagnosticBundleLogger;
}

// Re-export from manifest to preserve the public API for existing consumers.
export type { AssembledDesktopBundle } from './manifest';

interface DesktopBundleState {
  /**
   * Injected logger for the collector-timeout breadcrumb (see {@link DiagnosticBundleLogger}).
   * Desktop callers pass the real pino-backed logger; defaults to {@link NOOP_LOGGER}.
   */
  logger: DiagnosticBundleLogger;
  healthReport: HealthReportLike | null;
  sessionExcerpts: SessionExcerpt[];
  mainLogs: ExportedLogFileLike[];
  turnLogs: TurnLogFile[];
  logSummary: LogSummary | null;
  contents: Record<string, DiagnosticFileEntry>;
  truncated: boolean;
  files: Map<string, string>;
  /** Diagnostic events already loaded for events.jsonl, used to summarize counts/last-times in quickStats. */
  diagnosticEvents: DiagnosticEventEntry[];
  sectionStates: Record<SectionId, SectionState>;
  /**
   * Sections whose collector hit the per-collector or top-level deadline.
   * Insertion-ordered Set → surfaced as `manifest.timedOut` so the bundle is
   * self-describing about timeouts (distinct from `empty`).
   */
  timedOutSections: Set<SectionId>;
  /**
   * Set once ANY collector times out. Subsequent `collectWithDeadline` calls
   * short-circuit — they skip invoking their work entirely and resolve to the
   * timeout sentinel + mark their sections unavailable. This is what bounds the
   * abandoned-promise residual to ≤1: once one heavy non-cancellable collector
   * is abandoned, we stop starting more, so at most that single promise lingers
   * (A7). Cancellable collectors also honour the AbortSignal as defence in depth.
   */
  deadlineTripped: boolean;
}

/**
 * Number of ms remaining before the overall bundle deadline. Per-collector
 * timeouts are clamped to this so a late collector cannot push assembly past
 * the top-level ceiling. When the deadline has already passed the remaining
 * budget is 0 → the collector times out immediately (its section is marked
 * `unavailable`) rather than being awaited.
 */
function remainingBudgetMs(deadlineAt: number, now: () => number): number {
  return Math.max(0, deadlineAt - now());
}

/**
 * Total mapping from `DiagnosticEventKind` to the bundle `SectionId` the kind
 * routes into. Kinds with no dedicated section route to `'recent_events'`,
 * which is the catch-all bucket. Stage 4 of the bundle wiring consolidation
 * makes this total (was Partial<>) so adding a new event kind without
 * placing it under a section becomes a build error rather than silently
 * falling through to recent_events. The reconciliation script
 * (`scripts/check-diagnostic-event-kinds.ts`) verifies this map covers
 * every kind in the canonical literal list.
 */
const EVENT_KIND_TO_SECTION: Record<DiagnosticEventKind, SectionId> = {
  // Routed to dedicated sections that have their own collectors / bundle entries:
  provider_reachability_change: 'provider_reachability',
  health_check_timing: 'health_timing',
  embedding_index_health: 'index_health',
  worker_stats_pre_turn: 'pre_turn_worker',
  auto_update_state_change: 'auto_update_forensics',
  // Quit-deadlock fallbacks are part of the quit/install forensic story —
  // group them with the auto-update forensics section for incident triage.
  quit_deadlock_detected: 'auto_update_forensics',
  settings_drift_observation: 'settings_drift',
  cost_outcome_resolution: 'cost_summary',
  cost_outcome_resolution_lost: 'cost_summary',
  cost_outcome_resolution_unmatched: 'cost_summary',
  continuity_transition: 'continuity_trail',
  // Catch-all bucket — kinds with no dedicated section land in
  // `recent_events` and get rendered there for triage:
  cooldown_enter: 'recent_events',
  cooldown_exit: 'recent_events',
  tool_advisory: 'recent_events',
  known_condition: 'recent_events',
  tool_call_error: 'recent_events',
  mcp_transition: 'recent_events',
  auth_event: 'recent_events',
  streaming_invariant: 'recent_events',
  abort_event: 'recent_events',
  watchdog_judge_decision: 'recent_events',
  judge_decision_stale_skip: 'recent_events',
  subagent_internal_timeout_recovered: 'recent_events',
  approval_stuck: 'recent_events',
  events_per_kind_cap_engaged: 'recent_events',
  fsevents_leak_sweep: 'recent_events',
};

const EVENT_BACKED_SECTIONS = new Set<SectionId>([
  'provider_reachability',
  'health_timing',
  'index_health',
  'pre_turn_worker',
  'settings_drift',
  'cost_summary',
  'continuity_trail',
  'recent_events',
]);

// Sections that participate in EVENT_BACKED_SECTIONS for ledger-event routing
// but also have their own dedicated collector path that owns the section state
// (e.g. continuity_trail's gatherContinuityDiagnostics / readContinuityStateMap;
// cost_summary's getCostWaterfallByOutcome; provider_reachability's dedicated
// live HEAD-only probe in assembleDesktopBundle). When the events reader fails
// or is missing we must not overwrite the state these collectors already set —
// for provider_reachability this is exactly what kept a hung health/workspace
// collector from suppressing the "no connection?" answer.
const EVENT_RESET_EXEMPT_SECTIONS = new Set<SectionId>([
  'continuity_trail',
  'cost_summary',
  'provider_reachability',
]);

function markSectionOmittedByOptions(
  sectionStates: Record<SectionId, SectionState>,
  options: DiagnosticBundleOptions | undefined,
  sectionIds: readonly SectionId[] = DIAGNOSTIC_SECTION_IDS,
): void {
  for (const sectionId of sectionIds) {
    const resolution = resolveDiagnosticSection(options, sectionId);
    if (!resolution.enabled && resolution.omittedState) sectionStates[sectionId] = resolution.omittedState;
  }
}

function isSectionEnabled(
  sectionStates: Record<SectionId, SectionState>,
  options: DiagnosticBundleOptions | undefined,
  sectionId: SectionId,
): boolean {
  const resolution = resolveDiagnosticSection(options, sectionId);
  if (!resolution.enabled) {
    sectionStates[sectionId] = resolution.omittedState ?? 'omitted_by_option';
    return false;
  }
  return true;
}

function captureSectionReaderUnavailable(sectionId: SectionId, error: unknown, surface: 'desktop' | 'cloud' | 'mobile'): void {
  getErrorReporter().captureException(error instanceof Error ? error : new Error(String(error)), {
    tags: {
      diagnosticSection: sectionId,
      diagnosticSurface: surface,
    },
    level: 'warning',
  });
}

function isNonEmptyObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value) && Object.keys(value as Record<string, unknown>).length > 0;
}

const PENDING_APPROVAL_CONTENT_KEYS = new Set([
  'content',
  'contentPreview',
  'summary',
  'rawContent',
  'raw_content',
  'rawText',
  'capturedContent',
  'captured_content',
  'rawPayload',
]);

function redactPendingApprovalContentFields(value: unknown): unknown {
  if (value === null || value === undefined) return value;

  let copy: unknown;
  try {
    copy = JSON.parse(JSON.stringify(value));
  } catch {
    return value;
  }

  const redact = (current: unknown): unknown => {
    if (Array.isArray(current)) {
      return current.map((entry) => redact(entry));
    }
    if (!current || typeof current !== 'object') {
      return current;
    }

    const record = current as Record<string, unknown>;
    for (const key of Object.keys(record)) {
      if (PENDING_APPROVAL_CONTENT_KEYS.has(key)) {
        record[key] = '***REDACTED***';
        continue;
      }
      record[key] = redact(record[key]);
    }
    return record;
  };

  return redact(copy);
}

function sanitizeStoreFileForBundle(filename: string, content: unknown): unknown {
  if (filename === 'pending-tool-approvals.json') {
    return redactPendingApprovalContentFields(content);
  }
  return content;
}

function filterDiagnosticEventsForSections(
  events: readonly Record<string, unknown>[],
  sectionStates: Record<SectionId, SectionState>,
  options: DiagnosticBundleOptions | undefined,
): readonly Record<string, unknown>[] {
  const enabledSections = new Set<SectionId>();
  for (const sectionId of EVENT_BACKED_SECTIONS) {
    if (isSectionEnabled(sectionStates, options, sectionId)) enabledSections.add(sectionId);
  }

  if (enabledSections.size === 0) return [];

  const counts = new Map<SectionId, number>();
  const filtered = events.filter((entry) => {
    const kind = entry['kind'];
    // EVENT_KIND_TO_SECTION is a total mapping; unknown / non-string kinds
    // (defensive guard against an upstream schema regression) fall back to
    // recent_events so we still surface them for triage.
    const sectionId: SectionId = typeof kind === 'string' && (kind as DiagnosticEventKind) in EVENT_KIND_TO_SECTION
      ? EVENT_KIND_TO_SECTION[kind as DiagnosticEventKind]
      : 'recent_events';
    if (!enabledSections.has(sectionId)) return false;
    counts.set(sectionId, (counts.get(sectionId) ?? 0) + 1);
    if (sectionId !== 'recent_events' && enabledSections.has('recent_events')) {
      counts.set('recent_events', (counts.get('recent_events') ?? 0) + 1);
    }
    return true;
  });

  for (const sectionId of enabledSections) {
    const count = counts.get(sectionId) ?? 0;
    if (count > 0) sectionStates[sectionId] = 'included';
    else if (sectionStates[sectionId] !== 'included') sectionStates[sectionId] = 'empty';
  }
  return filtered;
}

const VALID_DIAGNOSTIC_EVENT_KINDS: ReadonlySet<DiagnosticEventKind> = new Set<DiagnosticEventKind>([
  'cooldown_enter',
  'cooldown_exit',
  'tool_advisory',
  'known_condition',
  'tool_call_error',
  'mcp_transition',
  'auth_event',
  'streaming_invariant',
  'abort_event',
  'watchdog_judge_decision',
  'judge_decision_stale_skip',
  'subagent_internal_timeout_recovered',
  'approval_stuck',
  'health_check_timing',
  'provider_reachability_change',
  'embedding_index_health',
  'worker_stats_pre_turn',
  'auto_update_state_change',
  'fsevents_leak_sweep',
  'quit_deadlock_detected',
  'settings_drift_observation',
  'cost_outcome_resolution',
  'cost_outcome_resolution_lost',
  'cost_outcome_resolution_unmatched',
  'continuity_transition',
  'events_per_kind_cap_engaged',
]);

/**
 * The bundle collector returns `Record<string, unknown>[]` to avoid coupling
 * the boundary to the rich variant union. quickStats only needs `kind` + `ts`,
 * so narrow defensively here without re-running Zod parse.
 */
function narrowDiagnosticEventsForSummary(
  raw: readonly Record<string, unknown>[],
): DiagnosticEventEntry[] {
  const out: DiagnosticEventEntry[] = [];
  for (const entry of raw) {
    const kind = entry['kind'];
    const ts = entry['ts'];
    if (typeof kind === 'string' && typeof ts === 'number' && VALID_DIAGNOSTIC_EVENT_KINDS.has(kind as DiagnosticEventKind)) {
      out.push(entry as unknown as DiagnosticEventEntry);
    }
  }
  return out;
}

function normaliseUserPaths(value: string): string {
  return value
    .replace(/\/Users\/[^/\s"]+/g, '~')
    .replace(/\/home\/[^/\s"]+/g, '~')
    .replace(/[A-Z]:\\Users\\[^\\"]+/gi, '~');
}

export function redactSettingsForDiagnostics(settings: AppSettings): Record<string, unknown> {
  const redacted = redactObjectDeep(settings) as Record<string, unknown>;
  const normalizePaths = (obj: unknown): unknown => {
    if (obj === null || obj === undefined) return obj;
    if (typeof obj === 'string') return normaliseUserPaths(obj);
    if (Array.isArray(obj)) return obj.map(normalizePaths);
    if (typeof obj === 'object') {
      const result: Record<string, unknown> = {};
      for (const key of Object.keys(obj as Record<string, unknown>)) result[key] = normalizePaths((obj as Record<string, unknown>)[key]);
      return result;
    }
    return obj;
  };
  return normalizePaths(redacted) as Record<string, unknown>;
}

export function redactMcpConfigForDiagnostics(config: unknown): unknown {
  if (config === null || typeof config !== 'object') return config;
  const redacted = JSON.parse(JSON.stringify(config)) as Record<string, unknown>;
  const redactObject = (obj: Record<string, unknown>): void => {
    for (const key of Object.keys(obj)) {
      const value = obj[key];
      if (key === 'env' && typeof value === 'object' && value !== null) {
        for (const envKey of Object.keys(value as Record<string, unknown>)) {
          if (/key|token|secret|password|auth/i.test(envKey)) (value as Record<string, unknown>)[envKey] = '***REDACTED***';
        }
      }
      if (key === 'headers' && typeof value === 'object' && value !== null) {
        for (const headerKey of Object.keys(value as Record<string, unknown>)) {
          if (/auth|key|token|bearer/i.test(headerKey)) (value as Record<string, unknown>)[headerKey] = '***REDACTED***';
        }
      }
      if ((key === 'command' || key === 'args') && typeof value === 'string') obj[key] = normaliseUserPaths(value);
      if (typeof value === 'object' && value !== null) {
        if (Array.isArray(value)) value.forEach((item) => typeof item === 'object' && item !== null && redactObject(item as Record<string, unknown>));
        else redactObject(value as Record<string, unknown>);
      }
    }
  };
  redactObject(redacted);
  return redacted;
}

function addJsonFile(state: DesktopBundleState, filename: string, content: unknown, entry: DiagnosticFileEntry): void {
  state.files.set(filename, JSON.stringify(content, null, 2));
  state.contents[filename] = entry;
}

/**
 * Result of a deadline-guarded collector. `timedOut` callers should NOT process
 * `value` (it is the sentinel) — they should skip their section's success path.
 */
interface CollectorOutcome<T> {
  value: T;
  timedOut: boolean;
}

/**
 * Run a single collector behind a per-collector deadline (clamped to the
 * remaining top-level budget). On timeout: resolve to `onTimeout()` (NEVER
 * throw — call sites already tolerate empty/undefined), mark the owning
 * section(s) `unavailable`, record them in `state.timedOutSections`, and emit
 * a structured `collector_timeout` log (observable, not swallowed — Failure
 * Mode S2-Silent-failure). A collector that *throws* still propagates to the
 * caller's existing `try/catch`; this helper only adds the hang ceiling.
 */
async function collectWithDeadline<T>(
  state: DesktopBundleState,
  args: {
    label: string;
    /** Section(s) marked `unavailable` + recorded as timed-out on deadline. */
    sections: SectionId[];
    deadlineAt: number;
    now: () => number;
    work: (signal: AbortSignal) => Promise<T> | T;
    onTimeout: () => T;
  },
): Promise<CollectorOutcome<T>> {
  const markTimedOut = (reason: 'deadline_tripped' | 'budget_exhausted' | 'timeout', durationMs: number, budgetMs: number): void => {
    state.deadlineTripped = true;
    for (const sectionId of args.sections) {
      // Don't clobber an explicit user/option omission — only sections that
      // were going to be collected get the timeout marker.
      const current = state.sectionStates[sectionId];
      if (current === 'omitted_by_user_toggle' || current === 'omitted_by_option') continue;
      state.sectionStates[sectionId] = 'unavailable';
      state.timedOutSections.add(sectionId);
    }
    state.logger.warn(
      { event: 'collector_timeout', collector: args.label, sections: args.sections, reason, budgetMs, durationMs },
      'Diagnostics collector skipped/abandoned at the deadline; section marked unavailable',
    );
  };

  // Short-circuit: a prior collector already tripped the deadline (bounds the
  // abandoned-promise residual to ≤1 — A7), OR the top-level budget is already
  // exhausted. In both cases DON'T invoke work — resolve to the sentinel.
  const budgetMs = remainingBudgetMs(args.deadlineAt, args.now);
  if (state.deadlineTripped || budgetMs <= 0) {
    markTimedOut(state.deadlineTripped ? 'deadline_tripped' : 'budget_exhausted', 0, budgetMs);
    return { value: args.onTimeout(), timedOut: true };
  }

  const result = await runWithTimeout<T>({
    timeoutMs: budgetMs,
    work: args.work,
    onTimeout: args.onTimeout,
    now: args.now,
  });
  if (result.timedOut) {
    markTimedOut('timeout', result.durationMs, budgetMs);
  }
  return { value: result.value, timedOut: result.timedOut };
}

export async function assembleDesktopBundle(input: AssembleDesktopBundleInput): Promise<AssembledDesktopBundle> {
  const options = {
    logWindowMinutes: input.options?.logWindowMinutes ?? DEFAULT_LOG_WINDOW_MINUTES,
    maxTurnLogs: input.options?.maxTurnLogs ?? MAX_TURN_LOGS,
    maxRecentSessions: input.options?.maxRecentSessions ?? MAX_RECENT_SESSIONS,
    includeErrorsOnly: input.options?.includeErrorsOnly ?? true,
    includeChiefOfStaff: input.options?.includeChiefOfStaff ?? true,
    includeSentryScope: input.options?.includeSentryScope ?? true,
    includeFullLogs: input.options?.includeFullLogs ?? true,
  };
  const now = input.now ?? Date.now;
  const timestamp = new Date(now()).toISOString();
  // Top-level ceiling: even a pathological collector set finalises by here.
  const deadlineAt = now() + (input.deadlineMs ?? DIAGNOSTIC_BUNDLE_DEADLINE_MS);
  const collectorTimeoutMs = input.collectorTimeoutMs ?? DIAGNOSTIC_COLLECTOR_TIMEOUT_MS;
  // Effective per-collector deadline = min(per-collector budget, remaining
  // top-level budget). Computed fresh at each call site via collectorDeadlineAt.
  const collectorDeadlineAt = (): number => Math.min(now() + collectorTimeoutMs, deadlineAt);
  const state: DesktopBundleState = {
    logger: input.logger ?? NOOP_LOGGER,
    healthReport: null,
    sessionExcerpts: [],
    mainLogs: [],
    turnLogs: [],
    logSummary: null,
    contents: {},
    truncated: false,
    files: new Map(),
    diagnosticEvents: [],
    sectionStates: defaultDiagnosticSectionStates(),
    timedOutSections: new Set<SectionId>(),
    deadlineTripped: false,
  };
  markSectionOmittedByOptions(state.sectionStates, input.options);

  // Provider reachability runs FIRST, on its own deadline, and decoupled from
  // the health collector. Previously reachability was only marked
  // `unavailable` when the health check timed out — so on a machine whose
  // workspace probe hangs (e.g. an unresponsive Google Drive mount), the very
  // section that answers "no connection?" was the one we lost. A bounded
  // HEAD-only probe (no secrets) here gives a real tls/dns/timeout verdict even
  // when later collectors trip the bundle deadline.
  const refreshReachability = input.collectors.refreshProviderReachability;
  if (
    refreshReachability &&
    isSectionEnabled(state.sectionStates, input.options, 'provider_reachability')
  ) {
    try {
      const { value: reachability, timedOut } = await collectWithDeadline(state, {
        label: 'refreshProviderReachability',
        sections: ['provider_reachability'],
        deadlineAt: collectorDeadlineAt(),
        now,
        work: (signal) => refreshReachability(signal),
        onTimeout: () => null as unknown,
      });
      if (!timedOut && reachability && typeof reachability === 'object') {
        // Co-locate a support-facing all-unreachable verdict with the raw probe
        // evidence (the file support opens for connectivity triage). Pure
        // derivation; honest about stale/missing data ('inconclusive'). Drives no
        // user copy and no retry/routing decision. Lazy import mirrors the
        // collector's own lazy load of this module (already resolved by here).
        let reachabilityVerdict: unknown;
        try {
          const { detectAllProvidersUnreachable } = await import('./providerReachabilitySnapshot');
          reachabilityVerdict = detectAllProvidersUnreachable(
            reachability as ProviderReachabilitySnapshot,
          );
        } catch (verdictErr) {
          ignoreBestEffortCleanup(verdictErr, {
            operation: 'diagnosticBundle.reachabilityVerdict',
            reason: 'Verdict is a derived convenience; the raw probe data is still embedded if it throws',
          });
        }
        addJsonFile(
          state,
          'provider-reachability.json',
          sanitizeJsonForExport(
            reachabilityVerdict ? { ...reachability, verdict: reachabilityVerdict } : reachability,
          ),
          {
            type: 'structured',
            description:
              'Provider/cloud reachability probe (HEAD-only, no secrets) + all-unreachable verdict',
          },
        );
        state.sectionStates.provider_reachability = 'included';
      }
    } catch (error) {
      ignoreBestEffortCleanup(error, {
        operation: 'diagnosticBundle.refreshProviderReachability',
        reason: 'Bundle continues without reachability if the probe throws; section omission is the documented degradation path',
      });
    }
  }

  try {
    const { value: healthReport, timedOut } = await collectWithDeadline(state, {
      label: 'runSystemHealthCheck',
      // Health drives the timing section; reachability is collected separately
      // above so a health-collector timeout no longer suppresses it.
      sections: ['health_timing'],
      deadlineAt: collectorDeadlineAt(),
      now,
      work: (signal) => input.collectors.runSystemHealthCheck(input.settings, signal),
      onTimeout: () => null as HealthReportLike | null,
    });
    if (!timedOut && healthReport) {
      state.healthReport = healthReport;
      addJsonFile(state, 'health.json', sanitizeJsonForExport(state.healthReport), {
        type: 'structured',
        description: `${Object.keys(state.healthReport.checks).length} health checks`,
      });
    }
  } catch (error) {
    ignoreBestEffortCleanup(error, {
      operation: 'diagnosticBundle.runSystemHealthCheck',
      reason: 'Bundle must continue without health report if collector fails; section omission is the documented degradation path',
    });
  }

  try {
    addJsonFile(state, 'settings.json', sanitizeJsonForExport(redactSettingsForDiagnostics(input.settings)), {
      type: 'config',
      description: 'Application settings (redacted)',
    });
  } catch (error) {
    ignoreBestEffortCleanup(error, {
      operation: 'diagnosticBundle.redactSettings',
      reason: 'Bundle continues without settings.json on serialise/redact failure; user receives partial bundle rather than zero output',
    });
  }

  try {
    const mcpConfigPath = input.collectors.resolveMcpConfigPath(input.settings);
    if (mcpConfigPath) {
      const { value: mcpConfig, timedOut } = await collectWithDeadline(state, {
        label: 'readMcpConfig',
        sections: [],
        deadlineAt: collectorDeadlineAt(),
        now,
        work: () => input.collectors.readMcpConfig(mcpConfigPath),
        onTimeout: () => null as unknown,
      });
      if (!timedOut && mcpConfig !== null) {
        const redactedConfig = redactMcpEnvVars(redactMcpConfigForDiagnostics(mcpConfig));
        addJsonFile(state, 'mcp-config.json', sanitizeJsonForExport(redactedConfig), {
          type: 'config',
          description: 'MCP server configuration (redacted)',
        });
      }
    }
  } catch (error) {
    ignoreBestEffortCleanup(error, {
      operation: 'diagnosticBundle.readMcpConfig',
      reason: 'MCP config may be absent or unreadable; bundle continues without mcp-config.json rather than aborting',
    });
  }

  try {
    // gatherRecentSessions is the prime hang suspect (unbounded session
    // hydration under heap/IO pressure). Deadline-guard it + the count read.
    const { value: sessionExcerpts, timedOut: sessionsTimedOut } = await collectWithDeadline(state, {
      label: 'gatherRecentSessions',
      sections: [],
      deadlineAt: collectorDeadlineAt(),
      now,
      work: (signal) => input.collectors.gatherRecentSessions(input.paths.sessions, { maxSessions: options.maxRecentSessions }, signal),
      onTimeout: () => [] as SessionExcerpt[],
    });
    if (!sessionsTimedOut) {
      state.sessionExcerpts = sessionExcerpts;
      const { value: totalInHistoryRaw } = await collectWithDeadline(state, {
        label: 'countTotalSessions',
        sections: [],
        deadlineAt: collectorDeadlineAt(),
        now,
        work: () => input.collectors.countTotalSessions(input.paths.sessions),
        onTimeout: () => null as number | null,
      });
      const totalInHistory = totalInHistoryRaw ?? state.sessionExcerpts.length;
      const sessionsIndex: SessionsIndex = { count: state.sessionExcerpts.length, totalInHistory, sessions: state.sessionExcerpts };
      addJsonFile(state, 'sessions-index.json', sanitizeJsonForExport(sessionsIndex), {
        type: 'index',
        description: `${state.sessionExcerpts.length} recent sessions (${totalInHistory} total)`,
      });
      if (state.sessionExcerpts.length >= options.maxRecentSessions && totalInHistory > options.maxRecentSessions) state.truncated = true;
    }
  } catch (error) {
    ignoreBestEffortCleanup(error, {
      operation: 'diagnosticBundle.gatherRecentSessions',
      reason: 'Sessions history may be empty or unreadable; bundle continues without sessions-index.json',
    });
  }

  if (isSectionEnabled(state.sectionStates, input.options, 'continuity_trail')) {
    try {
      const { value: continuityFiles, timedOut } = await collectWithDeadline(state, {
        label: 'gatherContinuityDiagnostics',
        sections: ['continuity_trail'],
        deadlineAt: collectorDeadlineAt(),
        now,
        work: () => input.collectors.gatherContinuityDiagnostics(),
        onTimeout: () => [] as DesktopContinuityFile[],
      });
      if (!timedOut) {
        for (const file of continuityFiles) {
          addJsonFile(state, file.path, sanitizeJsonForExport(file.content), {
            type: 'structured',
            description: file.description,
            truncated: file.truncated,
          });
          if (file.truncated) state.truncated = true;
        }
        state.sectionStates.continuity_trail = continuityFiles.length > 0 ? 'included' : 'empty';
      }
    } catch (err) {
      state.sectionStates.continuity_trail = 'reader_unavailable';
      captureSectionReaderUnavailable('continuity_trail', err, 'desktop');
    }
  }

  try {
    const snapshot = input.collectors.captureRamSnapshot();
    addJsonFile(state, 'ram-snapshot.json', snapshot, { type: 'structured', description: 'RAM snapshot' });
  } catch (error) {
    ignoreBestEffortCleanup(error, {
      operation: 'diagnosticBundle.captureRamSnapshot',
      reason: 'RAM snapshot collector may fail on resource pressure; bundle continues without ram-snapshot.json',
    });
  }

  if (options.includeSentryScope) {
    try {
      const { value: sentryScope, timedOut } = await collectWithDeadline(state, {
        label: 'gatherSentryScope',
        sections: [],
        deadlineAt: collectorDeadlineAt(),
        now,
        work: () => input.collectors.gatherSentryScope(input.paths.sentry),
        onTimeout: () => null as SentryScopeSummary | null,
      });
      if (!timedOut && sentryScope) {
        addJsonFile(state, 'sentry-scope.json', sanitizeJsonForExport(sentryScope), {
          type: 'structured',
          description: `${sentryScope.breadcrumbs.length} breadcrumbs`,
          truncated: sentryScope.truncatedCount !== undefined,
        });
      }
    } catch (error) {
      ignoreBestEffortCleanup(error, {
        operation: 'diagnosticBundle.gatherSentryScope',
        reason: 'Sentry scope may be unavailable (offline, not yet initialised); bundle continues without sentry-scope.json',
      });
    }
  }

  if (options.includeChiefOfStaff) {
    try {
      const { value: readme, timedOut } = await collectWithDeadline(state, {
        label: 'gatherChiefOfStaffReadme',
        sections: [],
        deadlineAt: collectorDeadlineAt(),
        now,
        work: () => input.collectors.gatherChiefOfStaffReadme(input.settings),
        onTimeout: () => null as string | null,
      });
      if (!timedOut && readme) {
        state.files.set('rebel-system/README.md', readme);
        state.contents['rebel-system/README.md'] = { type: 'config', description: 'Chief of Staff system prompt (redacted)' };
      }
    } catch (error) {
      ignoreBestEffortCleanup(error, {
        operation: 'diagnosticBundle.gatherChiefOfStaffReadme',
        reason: 'rebel-system submodule may be uninitialised; bundle continues without README.md',
      });
    }
  }

  try {
    const { value: storeFiles, timedOut: storeFilesTimedOut } = await collectWithDeadline(state, {
      label: 'gatherElectronStoreFiles',
      sections: ['auto_update_forensics'],
      deadlineAt: collectorDeadlineAt(),
      now,
      work: () => input.collectors.gatherElectronStoreFiles(input.paths.userData),
      onTimeout: () => ({} as Record<string, unknown>),
    });
    if (!storeFilesTimedOut) {
      for (const [filename, content] of Object.entries(storeFiles)) {
        if (filename === 'auto-update-state.json' && !isSectionEnabled(state.sectionStates, input.options, 'auto_update_forensics')) continue;
        if (content === null || content === undefined) continue;
        const sanitizedContent = sanitizeStoreFileForBundle(filename, content);
        const fileContent = filename === 'cost-ledger.jsonl' && Array.isArray(content)
          ? (content as Record<string, unknown>[]).map((entry) => JSON.stringify(entry)).join('\n')
          : JSON.stringify(sanitizedContent, null, 2);
        state.files.set(filename, fileContent);
        const descriptions: Record<string, string> = {
          'tool-usage.json': 'MCP tool usage statistics',
          'cost-ledger.jsonl': `Last ${MAX_COST_LEDGER_ENTRIES} API cost entries`,
          'automations.json': 'Automation definitions',
          'pending-tool-approvals.json': 'Pending tool approval queue',
          'clean-exit-flag.json': 'Last exit status',
          'meeting-bot-pending.json': 'Meeting bot transcript tracking state',
          'physical-recording-pending.json': 'Physical meeting recording state',
          'auto-update-state.json': 'Auto-update lifecycle state',
          'app-install-integrity.json': 'Duplicate / translocated app-bundle detection',
        };
        state.contents[filename] = { type: 'structured', description: descriptions[filename] ?? filename };
      }
      if (isSectionEnabled(state.sectionStates, input.options, 'auto_update_forensics')) {
        state.sectionStates.auto_update_forensics = storeFiles['auto-update-state.json'] ? 'included' : 'empty';
      }
    }
  } catch (error) {
    ignoreBestEffortCleanup(error, {
      operation: 'diagnosticBundle.gatherElectronStoreFiles',
      reason: 'Electron store files may be locked/missing; bundle continues without per-store snapshots',
    });
  }

  if (isSectionEnabled(state.sectionStates, input.options, 'cost_summary')) {
    if (input.collectors.getCostWaterfallByOutcome) {
      const getCostWaterfall = input.collectors.getCostWaterfallByOutcome;
      try {
        const { value: costWaterfall, timedOut: costTimedOut } = await collectWithDeadline(state, {
          label: 'getCostWaterfallByOutcome',
          sections: ['cost_summary'],
          deadlineAt: collectorDeadlineAt(),
          now,
          work: () => getCostWaterfall({ since: now() - 24 * 60 * 60 * 1000 }),
          onTimeout: () => null as unknown,
        });
        if (costTimedOut) {
          // collectWithDeadline already marked cost_summary 'unavailable'.
        } else {
          const total = isNonEmptyObject(costWaterfall) && isNonEmptyObject(costWaterfall['total'])
            ? costWaterfall['total']
            : null;
          const count = typeof total?.['count'] === 'number' ? total['count'] : 0;
          if (count > 0) {
            addJsonFile(state, 'cost-waterfall.json', sanitizeJsonForExport(costWaterfall), {
              type: 'structured',
              description: 'API cost waterfall by outcome (last 24h)',
            });
            state.sectionStates.cost_summary = 'included';
          } else {
            state.sectionStates.cost_summary = 'empty';
          }
        }
      } catch (err) {
        state.sectionStates.cost_summary = 'reader_unavailable';
        captureSectionReaderUnavailable('cost_summary', err, 'desktop');
      }
    } else {
      state.sectionStates.cost_summary = 'unavailable';
    }
  }

  if (input.collectors.gatherDiagnosticEvents) {
    const gatherDiagnosticEvents = input.collectors.gatherDiagnosticEvents;
    try {
      const { value: rawEvents, timedOut: eventsTimedOut } = await collectWithDeadline(state, {
        label: 'gatherDiagnosticEvents',
        // Diagnostic events feed every event-backed section that isn't owned by
        // a dedicated collector. On timeout, mark those unavailable so the
        // bundle is self-describing (distinct from reader_unavailable=threw).
        sections: [...EVENT_BACKED_SECTIONS].filter((s) => !EVENT_RESET_EXEMPT_SECTIONS.has(s) && isSectionEnabled(state.sectionStates, input.options, s)),
        deadlineAt: collectorDeadlineAt(),
        now,
        work: () => gatherDiagnosticEvents(),
        onTimeout: () => [] as readonly Record<string, unknown>[],
      });
      if (!eventsTimedOut) {
        const events = filterDiagnosticEventsForSections(
          rawEvents,
          state.sectionStates,
          input.options,
        );
        if (events.length > 0) {
          const ledgerJsonl = events.map((entry) => JSON.stringify(entry)).join('\n');
          state.files.set('events.jsonl', ledgerJsonl);
          state.contents['events.jsonl'] = {
            type: 'structured',
            description: `Last ${events.length} diagnostic events (cooldown transitions, tool advisories, known conditions)`,
          };
          state.diagnosticEvents = narrowDiagnosticEventsForSummary(events);
        }
      }
    } catch (err) {
      for (const sectionId of EVENT_BACKED_SECTIONS) {
        if (EVENT_RESET_EXEMPT_SECTIONS.has(sectionId)) continue;
        // A timed-out collector already authoritatively marked this section
        // `unavailable` (recorded in timedOut) — don't clobber it with the
        // events-reader fallback state.
        if (state.timedOutSections.has(sectionId)) continue;
        if (isSectionEnabled(state.sectionStates, input.options, sectionId)) {
          state.sectionStates[sectionId] = 'reader_unavailable';
        }
      }
      captureSectionReaderUnavailable('recent_events', err, 'desktop');
    }
  } else {
    for (const sectionId of EVENT_BACKED_SECTIONS) {
      if (EVENT_RESET_EXEMPT_SECTIONS.has(sectionId)) continue;
      if (state.timedOutSections.has(sectionId)) continue;
      if (isSectionEnabled(state.sectionStates, input.options, sectionId)) {
        state.sectionStates[sectionId] = 'reader_unavailable';
      }
    }
  }

  const recentLogsExplicitlyEnabled = input.options?.diagnosticSections?.recent_logs === true;
  const recentLogsRequested = options.includeFullLogs || options.includeErrorsOnly || options.maxTurnLogs > 0 || recentLogsExplicitlyEnabled;
  const recentLogsEnabled = isSectionEnabled(state.sectionStates, input.options, 'recent_logs') && recentLogsRequested;
  if (recentLogsEnabled && (options.includeFullLogs || recentLogsExplicitlyEnabled)) {
    try {
      const { value: exportedLogs, timedOut } = await collectWithDeadline(state, {
        label: 'exportRecentLogs',
        sections: ['recent_logs'],
        deadlineAt: collectorDeadlineAt(),
        now,
        work: (signal) => input.collectors.exportRecentLogs({ logWindowMinutes: options.logWindowMinutes, maxLinesPerFile: MAX_LINES_PER_LOG_FILE, filterLevel: 'all' }, signal),
        onTimeout: () => ({ files: [], totalLines: 0, timeWindow: { start: timestamp, end: timestamp } } as DesktopExportedLogs),
      });
      if (!timedOut) {
        state.mainLogs = exportedLogs.files;
        const mainLogContent = state.mainLogs.filter((f) => !f.filename.startsWith('sessions/')).map((f) => f.content).join('\n');
        if (mainLogContent.trim()) {
          state.files.set('logs/main.ndjson', mainLogContent);
          state.contents['logs/main.ndjson'] = { type: 'logs', description: `Main process logs (last ${options.logWindowMinutes} min)` };
        }
        state.sectionStates.recent_logs = mainLogContent.trim() ? 'included' : 'empty';
      }
    } catch (err) {
      state.sectionStates.recent_logs = 'reader_unavailable';
      captureSectionReaderUnavailable('recent_logs', err, 'desktop');
    }
  } else if (!recentLogsRequested && state.sectionStates.recent_logs === 'empty') {
    state.sectionStates.recent_logs = 'omitted_by_option';
  }

  // After exportRecentLogs above: if it timed out, recent_logs is already
  // 'unavailable'; don't re-run the turn-log collector for a section we've
  // already abandoned (avoids a second guaranteed-late await).
  if (recentLogsEnabled && state.sectionStates.recent_logs !== 'unavailable') {
    try {
      const { value: turnLogs, timedOut } = await collectWithDeadline(state, {
        label: 'gatherTurnLogs',
        sections: ['recent_logs'],
        deadlineAt: collectorDeadlineAt(),
        now,
        work: (signal) => input.collectors.gatherTurnLogs(input.paths.logs, { maxFiles: options.maxTurnLogs }, signal),
        onTimeout: () => [] as TurnLogFile[],
      });
      if (!timedOut) {
        state.turnLogs = turnLogs;
        for (const turnLog of state.turnLogs) state.files.set(`logs/sessions/${turnLog.filename}`, turnLog.content);
        if (state.turnLogs.length > 0) {
          state.contents['logs/sessions/'] = { type: 'logs', description: `${state.turnLogs.length} turn-specific log files` };
          if (state.turnLogs.length >= options.maxTurnLogs) state.truncated = true;
          state.sectionStates.recent_logs = 'included';
        }
      }
    } catch (err) {
      state.sectionStates.recent_logs = 'reader_unavailable';
      captureSectionReaderUnavailable('recent_logs', err, 'desktop');
    }
  }

  try {
    state.logSummary = generateLogSummary(state.mainLogs, state.turnLogs);
    if (recentLogsEnabled) {
      addJsonFile(state, 'logs/summary.json', sanitizeJsonForExport(state.logSummary), {
        type: 'index',
        description: `${state.logSummary.errorPatterns.length} error patterns, ${state.logSummary.topicTags.length} topic tags`,
      });
    }
  } catch {
    state.logSummary = { timeWindow: { start: timestamp, end: timestamp }, files: [], errorPatterns: [], topicTags: [] };
  }

  // Skip the secondary errors-only view if recent_logs already timed out (the
  // log path is hung — don't start a second guaranteed-late await on it) or if
  // a prior collector tripped the deadline.
  if (options.includeErrorsOnly && recentLogsEnabled && state.sectionStates.recent_logs !== 'unavailable' && !state.deadlineTripped) {
    try {
      // Secondary view — recent_logs section state is owned by the primary
      // export above, so pass no sections (a timeout here is just logged).
      const { value: exportedLogs, timedOut } = await collectWithDeadline(state, {
        label: 'exportRecentLogs.errorsOnly',
        sections: [],
        deadlineAt: collectorDeadlineAt(),
        now,
        work: (signal) => input.collectors.exportRecentLogs({ logWindowMinutes: options.logWindowMinutes, maxLinesPerFile: MAX_LINES_PER_LOG_FILE, filterLevel: 'warn-and-error' }, signal),
        onTimeout: () => ({ files: [], totalLines: 0, timeWindow: { start: timestamp, end: timestamp } } as DesktopExportedLogs),
      });
      if (!timedOut) {
        const errorsContent = exportedLogs.files.filter((f) => !f.filename.startsWith('sessions/')).map((f) => f.content).join('\n');
        if (errorsContent.trim()) {
          state.files.set('logs/errors.ndjson', errorsContent);
          state.contents['logs/errors.ndjson'] = { type: 'logs', description: `Errors and warnings only (last ${options.logWindowMinutes} min)` };
          state.sectionStates.recent_logs = 'included';
        }
      }
    } catch (error) {
      ignoreBestEffortCleanup(error, {
        operation: 'diagnosticBundle.exportRecentLogs.errorsOnly',
        reason: 'Errors-only log export is a secondary view; main log export above already handled the primary section state',
      });
    }
  }

  if (state.sessionExcerpts.length > 0) {
    for (const excerpt of state.sessionExcerpts) state.files.set(`recent-sessions/${excerpt.id}.json`, JSON.stringify(sanitizeJsonForExport(excerpt), null, 2));
    state.contents['recent-sessions/'] = { type: 'structured', description: `${state.sessionExcerpts.length} session excerpts with recent messages` };
  }

  let storeBreakdown: import('./manifest').StoreBreakdownSnapshot | undefined;
  if (input.collectors.getStoreBreakdown) {
    const getStoreBreakdown = input.collectors.getStoreBreakdown;
    try {
      const { value, timedOut } = await collectWithDeadline(state, {
        label: 'getStoreBreakdown',
        sections: [],
        deadlineAt: collectorDeadlineAt(),
        now,
        work: () => getStoreBreakdown(),
        onTimeout: () => undefined as import('./manifest').StoreBreakdownSnapshot | undefined,
      });
      storeBreakdown = timedOut ? undefined : value;
    } catch {
      storeBreakdown = undefined;
    }
  }
  const quickStats = computeQuickStats({
    healthReport: state.healthReport,
    logSummary: state.logSummary,
    sessionExcerpts: state.sessionExcerpts,
    perfStats: input.collectors.getPerfStatsIfNotable(),
    diagnosticEvents: state.diagnosticEvents,
    autoUpdate: input.collectors.getAutoUpdateForensicsSnapshot?.(),
    fsExhaustion: input.collectors.getFsExhaustionSnapshot?.(),
    storeBreakdown,
    processSupervision: input.collectors.getProcessSupervisionSnapshot?.(),
    cloudOutbox: input.collectors.getCloudOutboxSnapshot?.(),
  });
  const timedOut = [...state.timedOutSections];
  const manifest: DiagnosticManifest = {
    schemaVersion: DIAGNOSTIC_MANIFEST_SCHEMA_VERSION,
    generated: timestamp,
    app: input.appInfo,
    capabilities: computeCapabilities({ contents: state.contents, healthReport: state.healthReport, turnLogs: state.turnLogs, sessionExcerpts: state.sessionExcerpts }),
    contents: state.contents,
    quickStats,
    bundleParams: computeBundleParams({ logWindowMinutes: options.logWindowMinutes, maxTurnLogs: options.maxTurnLogs, maxRecentSessions: options.maxRecentSessions, truncated: state.truncated }),
    sections: state.sectionStates,
    // Self-describing timeout record (omitted when nothing timed out — back-compat).
    ...(timedOut.length > 0 ? { timedOut } : {}),
    // A timed-out FULL bundle is still partial — the user must be told sections
    // are missing (the bug is a hang/timeout, not a throw, so this is the COMMON
    // case). Drives generateDiagnosticZipBundle → IPC partial:true → the
    // renderer's "Partial diagnostic bundle" warning toast.
    ...(timedOut.length > 0 ? { partial: true } : {}),
    agentGuidance: recentLogsEnabled ? DEFAULT_AGENT_GUIDANCE : DEFAULT_AGENT_GUIDANCE_NO_LOGS,
  };
  state.files.set('manifest.json', JSON.stringify(manifest, null, 2));
  if (state.logSummary) state.files.set('README.md', formatBundleReadme(manifest, state.logSummary));

  const dateTimeStr = timestamp.replace(/[:.]/g, '').slice(0, 15);
  return { manifest, files: state.files, truncated: state.truncated, filename: `mindstone-diagnostics-${dateTimeStr}.zip` };
}

export interface MinimalDesktopBundleInput {
  appInfo: DiagnosticAppInfo;
  collectors: {
    /**
     * Recent error/warning logs, bounded by line/window caps. AbortSignal-aware.
     */
    exportRecentLogs: DesktopBundleCollectors['exportRecentLogs'];
    /**
     * Reads ONLY the two smallest forensic store files — `clean-exit-flag.json`
     * and `auto-update-state.json` — with a byte cap. MUST NOT call the full
     * `gatherElectronStoreFiles` (which reads tool-usage, pending approvals,
     * meeting stores, the WHOLE cost ledger, automations — any of which can hang
     * under the exact heap/IO pressure that caused the original bug). Keys are
     * the filenames; values are the parsed JSON (or omitted on read failure).
     */
    readCheapStoreFiles: (userDataPath: string, signal?: AbortSignal) => Promise<Record<string, unknown>>;
  };
  /** userData path passed to readCheapStoreFiles. */
  userDataPath: string;
  now?: () => number;
  /** Per-collector deadline override (ms). Test seam. */
  collectorTimeoutMs?: number;
  /**
   * Injected logger for the collector-timeout breadcrumb. Desktop callers pass
   * `createScopedLogger({ service: 'diagnosticBundle' })`; defaults to a no-op.
   * See {@link DiagnosticBundleLogger}.
   */
  logger?: DiagnosticBundleLogger;
}

/**
 * Minimal, always-succeeds desktop bundle. Uses ONLY genuinely cheap, bounded
 * collectors — recent logs (bounded window) + the two smallest forensic store
 * files (clean-exit-flag / auto-update-state, byte-capped) — so the renderer
 * can always get *something* out even when the full bundle's heavy collectors
 * hang. Deliberately does NOT call the full `gatherElectronStoreFiles` (it
 * reads the whole cost ledger, automations, etc. and can hang under the same
 * pressure).
 *
 * Each collector is still deadline-guarded (defense in depth); on timeout the
 * section is recorded and the bundle finalises. The manifest is marked
 * `partial: true` so consumers know this is the reduced fallback, not the full
 * bundle. Intentionally does NOT touch session hydration, MCP config, Sentry
 * scope, continuity, or cost — those are the expensive/hang-prone paths.
 */
export async function assembleMinimalDesktopBundle(input: MinimalDesktopBundleInput): Promise<AssembledDesktopBundle> {
  const now = input.now ?? Date.now;
  const timestamp = new Date(now()).toISOString();
  const collectorTimeoutMs = input.collectorTimeoutMs ?? DIAGNOSTIC_COLLECTOR_TIMEOUT_MS;
  const collectorDeadlineAt = (): number => now() + collectorTimeoutMs;
  const state: DesktopBundleState = {
    logger: input.logger ?? NOOP_LOGGER,
    healthReport: null,
    sessionExcerpts: [],
    mainLogs: [],
    turnLogs: [],
    logSummary: null,
    contents: {},
    truncated: false,
    files: new Map(),
    diagnosticEvents: [],
    // Everything is omitted-by-option in the minimal fallback EXCEPT the two
    // cheap sections we actually collect — those start `empty` so a timeout on
    // them is recorded (collectWithDeadline skips `omitted_by_option` sections).
    sectionStates: defaultDiagnosticSectionStates('omitted_by_option'),
    timedOutSections: new Set<SectionId>(),
    deadlineTripped: false,
  };
  state.sectionStates.auto_update_forensics = 'empty';
  state.sectionStates.recent_logs = 'empty';

  // Cheap, byte-capped store reads: clean-exit-flag + auto-update-state only.
  try {
    const { value: storeFiles, timedOut } = await collectWithDeadline(state, {
      label: 'minimal.readCheapStoreFiles',
      sections: ['auto_update_forensics'],
      deadlineAt: collectorDeadlineAt(),
      now,
      work: (signal) => input.collectors.readCheapStoreFiles(input.userDataPath, signal),
      onTimeout: () => ({} as Record<string, unknown>),
    });
    if (!timedOut) {
      for (const filename of ['clean-exit-flag.json', 'auto-update-state.json']) {
        const content = storeFiles[filename];
        if (content === null || content === undefined) continue;
        state.files.set(filename, JSON.stringify(content, null, 2));
        state.contents[filename] = {
          type: 'structured',
          description: filename === 'clean-exit-flag.json' ? 'Last exit status' : 'Auto-update lifecycle state',
        };
      }
      state.sectionStates.auto_update_forensics = storeFiles['auto-update-state.json'] ? 'included' : 'empty';
    }
  } catch (error) {
    ignoreBestEffortCleanup(error, {
      operation: 'minimalDiagnosticBundle.readCheapStoreFiles',
      reason: 'Minimal fallback continues without store snapshots; logs may still be captured',
    });
  }

  // Recent logs (already bounded by line/window caps).
  try {
    const { value: exportedLogs, timedOut } = await collectWithDeadline(state, {
      label: 'minimal.exportRecentLogs',
      sections: ['recent_logs'],
      deadlineAt: collectorDeadlineAt(),
      now,
      work: (signal) => input.collectors.exportRecentLogs({ logWindowMinutes: DEFAULT_LOG_WINDOW_MINUTES, maxLinesPerFile: MAX_LINES_PER_LOG_FILE, filterLevel: 'warn-and-error' }, signal),
      onTimeout: () => ({ files: [], totalLines: 0, timeWindow: { start: timestamp, end: timestamp } } as DesktopExportedLogs),
    });
    if (!timedOut) {
      state.mainLogs = exportedLogs.files;
      const mainLogContent = state.mainLogs.filter((f) => !f.filename.startsWith('sessions/')).map((f) => f.content).join('\n');
      if (mainLogContent.trim()) {
        state.files.set('logs/errors.ndjson', mainLogContent);
        state.contents['logs/errors.ndjson'] = { type: 'logs', description: `Errors and warnings only (last ${DEFAULT_LOG_WINDOW_MINUTES} min)` };
      }
      state.sectionStates.recent_logs = mainLogContent.trim() ? 'included' : 'empty';
    }
  } catch (error) {
    ignoreBestEffortCleanup(error, {
      operation: 'minimalDiagnosticBundle.exportRecentLogs',
      reason: 'Minimal fallback continues without logs; store snapshots may still be captured',
    });
  }

  state.logSummary = generateLogSummary(state.mainLogs, state.turnLogs);
  const timedOut = [...state.timedOutSections];
  const manifest: DiagnosticManifest = {
    schemaVersion: DIAGNOSTIC_MANIFEST_SCHEMA_VERSION,
    generated: timestamp,
    app: input.appInfo,
    capabilities: computeCapabilities({ contents: state.contents, healthReport: null, turnLogs: [], sessionExcerpts: [] }),
    contents: state.contents,
    quickStats: computeQuickStats({
      healthReport: null,
      logSummary: state.logSummary,
      sessionExcerpts: [],
      diagnosticEvents: [],
    }),
    bundleParams: computeBundleParams({ logWindowMinutes: DEFAULT_LOG_WINDOW_MINUTES, maxTurnLogs: 0, maxRecentSessions: 0, truncated: false }),
    sections: state.sectionStates,
    ...(timedOut.length > 0 ? { timedOut } : {}),
    partial: true,
    agentGuidance: DEFAULT_AGENT_GUIDANCE_NO_LOGS,
  };
  state.files.set('manifest.json', JSON.stringify(manifest, null, 2));
  state.files.set('README.md', formatBundleReadme(manifest, state.logSummary));
  const dateTimeStr = timestamp.replace(/[:.]/g, '').slice(0, 15);
  return { manifest, files: state.files, truncated: false, filename: `mindstone-diagnostics-${dateTimeStr}.zip` };
}

export interface CloudSelfDiagnosticsCollectors {
  readContinuityStateMap: () => Promise<Record<string, { state: 'local_only' | 'cloud_active'; lastCloudActivityAt?: number; cloudPinnedAt?: number }> | null>;
  listTombstones: () => Array<{ sessionId: string; deletedAt: number; deletedBy: string }>;
  getOutboxSnapshot: (deviceScopeKey: string) => CloudSelfDiagnosticsBundle['queueSnapshot'] | null;
  getCatchUpHistoryForDevice: (deviceScopeKey: string) => unknown[];
  getRecentLogs: () => unknown[];
  /**
   * Optional. Returns recent diagnostic-events ledger entries from the cloud
   * surface (oldest-first). Bounded by the caller via `MAX_DIAGNOSTIC_EVENTS_BYTES`.
   */
  getRecentDiagnosticEvents?: () => Promise<readonly Record<string, unknown>[]>;
  /**
   * Optional. Aggregates cloud-side API spend by turn outcome over the last
   * `since` ms. Cloud writes its own cost ledger when serving cloud-routed
   * turns, so this is the *cloud's* spend, not the user's combined total.
   * Mobile users read the cloud bundle as their primary cost-visibility
   * surface, so wiring this collector closes a real visibility gap.
   */
  getCostWaterfallByOutcome?: (options: { since: number }) => Promise<unknown>;
}

export function formatLogBufferAsNdjson(recentLogs: unknown[]): { mainNdjson: string; lineCount: number } {
  const sanitizedLogs = sanitizeJsonForExport(recentLogs);
  if (!Array.isArray(sanitizedLogs)) return { mainNdjson: '', lineCount: 0 };
  const lines = sanitizedLogs.map((entry) => JSON.stringify(entry));
  return { mainNdjson: lines.join('\n'), lineCount: lines.length };
}

export function capSelfDiagnosticsPayload(payload: CloudSelfDiagnosticsBundle): CloudSelfDiagnosticsBundle {
  const originalBytes = payloadBytes(payload);
  if (originalBytes <= CLOUD_SELF_DIAGNOSTICS_MAX_BYTES) return payload;
  const trimmed = JSON.parse(JSON.stringify(payload)) as CloudSelfDiagnosticsBundle;
  trimmed.manifest.truncated = { originalBytes, maxBytes: CLOUD_SELF_DIAGNOSTICS_MAX_BYTES };
  const withoutLogs = { ...trimmed, logs: { mainNdjson: '', lineCount: 0, truncated: true } };
  const bytesWithoutLogs = payloadBytes(withoutLogs);
  const remainingForLogs = Math.max(0, CLOUD_SELF_DIAGNOSTICS_MAX_BYTES - bytesWithoutLogs - 32);
  trimmed.logs.mainNdjson = clipUtf8Tail(trimmed.logs.mainNdjson, remainingForLogs);
  trimmed.logs.lineCount = trimmed.logs.mainNdjson ? trimmed.logs.mainNdjson.split('\n').filter(Boolean).length : 0;
  trimmed.logs.truncated = true;
  if (payloadBytes(trimmed) > CLOUD_SELF_DIAGNOSTICS_MAX_BYTES) trimmed.sessionsIndex.sessions = trimmed.sessionsIndex.sessions.slice(0, 10);
  if (payloadBytes(trimmed) > CLOUD_SELF_DIAGNOSTICS_MAX_BYTES) {
    if (trimmed.catchUpHistory) trimmed.catchUpHistory = [];
    if (trimmed.continuityState) trimmed.continuityState.recentTombstones = [];
  }
  if (payloadBytes(trimmed) > CLOUD_SELF_DIAGNOSTICS_MAX_BYTES) {
    trimmed.logs.mainNdjson = '';
    trimmed.logs.lineCount = 0;
    trimmed.logs.truncated = true;
  }
  if (payloadBytes(trimmed) <= CLOUD_SELF_DIAGNOSTICS_MAX_BYTES) return trimmed;
  return {
    manifest: trimmed.manifest,
    health: trimmed.health,
    sessionsIndex: { count: trimmed.sessionsIndex.count, totalInHistory: trimmed.sessionsIndex.totalInHistory, sessions: [] },
    logs: { mainNdjson: '', lineCount: 0, truncated: true },
    continuityState: trimmed.continuityState
      ? { cloudActiveCount: trimmed.continuityState.cloudActiveCount, localOnlyCount: trimmed.continuityState.localOnlyCount, tombstoneCount: trimmed.continuityState.tombstoneCount, recentTombstones: [] }
      : undefined,
  };
}

export async function assembleCloudSelfDiagnostics(input: {
  deviceScopeKey: string;
  checks: CloudDiagnosticCheckResult[];
  sessions: DiagnosticSessionSummary[];
  collectors: CloudSelfDiagnosticsCollectors;
  appInfo: { version: string; platform: string; nodeVersion: string; uptimeSec: number };
  options?: DiagnosticBundleOptions;
  now?: () => number;
}): Promise<CloudSelfDiagnosticsBundle> {
  const sectionStates = defaultDiagnosticSectionStates();
  markSectionOmittedByOptions(sectionStates, input.options);
  const providerReachabilityEnabled = isSectionEnabled(sectionStates, input.options, 'provider_reachability');
  if (providerReachabilityEnabled) {
    // Cloud egress is not the user's desktop network path, so cloud self
    // diagnostics must not present desktop provider reachability as available.
    sectionStates.provider_reachability = 'unavailable';
  }
  const eventFilterOptions = providerReachabilityEnabled
    ? {
        ...input.options,
        diagnosticSections: {
          ...input.options?.diagnosticSections,
          provider_reachability: false,
        },
      }
    : input.options;
  const continuityEnabled = isSectionEnabled(sectionStates, input.options, 'continuity_trail');
  let continuityStateMap: Awaited<ReturnType<CloudSelfDiagnosticsCollectors['readContinuityStateMap']>> = null;
  let tombstones: Array<{ sessionId: string; deletedAt: number; deletedBy: string }> = [];
  if (continuityEnabled) {
    try {
      continuityStateMap = await input.collectors.readContinuityStateMap();
      tombstones = input.collectors.listTombstones();
    } catch (err) {
      sectionStates.continuity_trail = 'reader_unavailable';
      captureSectionReaderUnavailable('continuity_trail', err, 'cloud');
    }
  }
  const tombstoneSet = new Set(tombstones.map((entry) => entry.sessionId));
  const sortedSessions = [...input.sessions]
    .sort((a, b) => (typeof b.cloudUpdatedAt === 'number' ? b.cloudUpdatedAt : b.updatedAt) - (typeof a.cloudUpdatedAt === 'number' ? a.cloudUpdatedAt : a.updatedAt))
    .slice(0, CLOUD_MAX_SESSIONS_IN_SELF_DIAGNOSTICS);
  const sessionsIndex = {
    count: sortedSessions.length,
    totalInHistory: input.sessions.length,
    sessions: sortedSessions.map((session) => {
      const continuityEntry = continuityStateMap?.[session.id];
      return {
        sessionIdHash: fnvHashHex(session.id),
        updatedAt: session.updatedAt,
        ...(typeof session.cloudUpdatedAt === 'number' ? { cloudUpdatedAt: session.cloudUpdatedAt } : {}),
        ...(typeof session.maxSeq === 'number' ? { maxSeq: session.maxSeq } : {}),
        ...(continuityEntry?.state ? { continuityState: continuityEntry.state } : {}),
        hasTombstone: tombstoneSet.has(session.id),
      };
    }),
  };
  const cloudActiveCount = continuityStateMap ? Object.values(continuityStateMap).filter((entry) => entry.state === 'cloud_active').length : 0;
  const localOnlyCount = continuityStateMap ? Object.values(continuityStateMap).filter((entry) => entry.state === 'local_only').length : 0;
  const recentTombstones = tombstones.slice(-CLOUD_MAX_TOMBSTONES_IN_SELF_DIAGNOSTICS).map((entry) => ({ sessionIdHash: fnvHashHex(entry.sessionId), deletedAt: entry.deletedAt, deletedBy: entry.deletedBy }));
  const failedChecks = input.checks.filter((check) => check.status === 'fail').map((check) => check.id);
  const warnChecks = input.checks.filter((check) => check.status === 'warn').map((check) => check.id);
  const healthStatus: CloudSelfDiagnosticsBundle['health']['status'] = failedChecks.length > 0 ? 'critical' : warnChecks.length > 0 ? 'degraded' : 'healthy';
  const response: CloudSelfDiagnosticsBundle = {
    manifest: {
      schemaVersion: DIAGNOSTIC_MANIFEST_SCHEMA_VERSION,
      generatedAt: new Date(input.now?.() ?? Date.now()).toISOString(),
      source: 'cloud',
      app: { version: input.appInfo.version, platform: input.appInfo.platform, nodeVersion: input.appInfo.nodeVersion },
      limits: { maxBytes: CLOUD_SELF_DIAGNOSTICS_MAX_BYTES, rateLimit: '1/min per device' },
      sections: sectionStates,
    },
    health: { status: healthStatus, failedChecks, warnChecks, checkCount: input.checks.length, uptimeSec: input.appInfo.uptimeSec },
    sessionsIndex,
    logs: { mainNdjson: '', lineCount: 0 },
  };
  if (isSectionEnabled(sectionStates, input.options, 'recent_logs')) {
    try {
      response.logs = formatLogBufferAsNdjson(input.collectors.getRecentLogs());
      sectionStates.recent_logs = response.logs.lineCount > 0 ? 'included' : 'empty';
    } catch (err) {
      sectionStates.recent_logs = 'reader_unavailable';
      captureSectionReaderUnavailable('recent_logs', err, 'cloud');
    }
  }
  if (continuityEnabled && sectionStates.continuity_trail !== 'reader_unavailable') {
    response.continuityState = { cloudActiveCount, localOnlyCount, tombstoneCount: tombstones.length, recentTombstones };
    const outboxSnapshot = input.collectors.getOutboxSnapshot(input.deviceScopeKey);
    const catchUpHistory = input.collectors.getCatchUpHistoryForDevice(input.deviceScopeKey);
    if (outboxSnapshot) response.queueSnapshot = outboxSnapshot;
    if (catchUpHistory.length > 0) response.catchUpHistory = catchUpHistory;
    sectionStates.continuity_trail = (
      cloudActiveCount > 0
      || localOnlyCount > 0
      || tombstones.length > 0
      || Boolean(outboxSnapshot)
      || catchUpHistory.length > 0
    ) ? 'included' : 'empty';
  }
  sectionStates.pre_turn_worker = isSectionEnabled(sectionStates, input.options, 'pre_turn_worker')
    ? 'unavailable'
    : sectionStates.pre_turn_worker;
  sectionStates.auto_update_forensics = isSectionEnabled(sectionStates, input.options, 'auto_update_forensics')
    ? 'unavailable'
    : sectionStates.auto_update_forensics;
  if (isSectionEnabled(sectionStates, input.options, 'cost_summary')) {
    if (input.collectors.getCostWaterfallByOutcome) {
      try {
        const costWaterfall = await input.collectors.getCostWaterfallByOutcome({
          since: (input.now?.() ?? Date.now()) - 24 * 60 * 60 * 1000,
        });
        const total = isNonEmptyObject(costWaterfall) && isNonEmptyObject(costWaterfall['total'])
          ? costWaterfall['total']
          : null;
        const count = typeof total?.['count'] === 'number' ? total['count'] : 0;
        if (count > 0) {
          response.costWaterfall = { surfaceContext: 'cloud', waterfall: sanitizeJsonForExport(costWaterfall) };
          sectionStates.cost_summary = 'included';
        } else {
          sectionStates.cost_summary = 'empty';
        }
      } catch (err) {
        sectionStates.cost_summary = 'reader_unavailable';
        captureSectionReaderUnavailable('cost_summary', err, 'cloud');
      }
    } else {
      sectionStates.cost_summary = 'unavailable';
    }
  }
  if (input.collectors.getRecentDiagnosticEvents) {
    try {
      const events = filterDiagnosticEventsForSections(
        await input.collectors.getRecentDiagnosticEvents(),
        sectionStates,
        eventFilterOptions,
      );
      if (events.length > 0) {
        // Trust the schema-validated reader to have produced typed entries.
        response.recentEvents = events as unknown as CloudSelfDiagnosticsBundle['recentEvents'];
      }
    } catch (err) {
      for (const sectionId of EVENT_BACKED_SECTIONS) {
        if (EVENT_RESET_EXEMPT_SECTIONS.has(sectionId)) continue;
        if (isSectionEnabled(sectionStates, input.options, sectionId) && sectionStates[sectionId] !== 'unavailable') {
          sectionStates[sectionId] = 'reader_unavailable';
        }
      }
      captureSectionReaderUnavailable('recent_events', err, 'cloud');
    }
  } else {
    for (const sectionId of EVENT_BACKED_SECTIONS) {
      if (EVENT_RESET_EXEMPT_SECTIONS.has(sectionId)) continue;
      if (isSectionEnabled(sectionStates, input.options, sectionId) && sectionStates[sectionId] !== 'unavailable') {
        sectionStates[sectionId] = 'reader_unavailable';
      }
    }
  }
  if (providerReachabilityEnabled) {
    sectionStates.provider_reachability = 'unavailable';
  }
  return capSelfDiagnosticsPayload(response);
}

export async function assembleCloudLegacyDiagnostics(input: {
  checks: CloudDiagnosticCheckResult[];
  collectors: { getRecentLogs: () => unknown[]; countSessions: () => Promise<number>; getDiskInfo: () => Promise<{ diskAvailableMB?: number; diskTotalMB?: number }>; getPushTokenCount: () => number };
  appInfo: { version: string; platform: string; nodeVersion: string; uptime: number };
  dataDir: string;
  now?: () => number;
}): Promise<CloudLegacyDiagnosticsBundle> {
  const [recentLogs, sessionCount, diskInfo] = await Promise.all([
    Promise.resolve(input.collectors.getRecentLogs()),
    input.collectors.countSessions(),
    input.collectors.getDiskInfo(),
  ]);
  return {
    generatedAt: new Date(input.now?.() ?? Date.now()).toISOString(),
    version: input.appInfo.version,
    uptime: input.appInfo.uptime,
    platform: input.appInfo.platform,
    nodeVersion: input.appInfo.nodeVersion,
    checks: input.checks,
    recentLogs: sanitizeJsonForExport(recentLogs),
    environment: { dataDir: input.dataDir, pushTokenCount: input.collectors.getPushTokenCount(), sessionCount, ...diskInfo },
  };
}

export function normalizeSessionSummaries(raw: unknown): DiagnosticSessionSummary[] {
  return normalizeCloudSessionSummaries(raw);
}

export interface MobileBundleCollectors {
  getSessions: () => MobileSessionLike[] | undefined;
  getAppVersion: () => string;
  getPlatform: () => string;
  getPlatformVersion: () => string;
  getRuntimeVersion: () => string;
}

function buildMobileHealth(diagnostics: MobileDiagnosticsSourceBundle): MobileDiagnosticsBundle['health'] {
  const hasLogReadWarning = diagnostics.filteredLogs.length === 0 || diagnostics.filteredLogs.startsWith('[Diagnostics error:');
  const queueSnapshot = diagnostics.queueSnapshot;
  const queueHasWarning = Boolean(queueSnapshot && (queueSnapshot.pendingCount > 0 || queueSnapshot.authExpired || queueSnapshot.limitedConnectivity || queueSnapshot.queueFull));
  const connectionState = diagnostics.continuityState?.connectionState ?? 'disconnected';
  const hasConnectionWarning = connectionState !== 'connected';
  const checks = {
    logCollection: {
      status: hasLogReadWarning ? 'warn' : 'pass',
      detail: hasLogReadWarning ? 'Recent logs are unavailable or partially captured.' : `Collected ${diagnostics.logLineCount} filtered log lines.`,
    },
    outboxQueue: {
      status: queueHasWarning ? 'warn' : 'pass',
      detail: queueSnapshot ? `pending=${queueSnapshot.pendingCount}, processing=${queueSnapshot.processingCount}, maxAttempts=${queueSnapshot.maxAttempts}` : 'Queue snapshot unavailable.',
    },
    continuityConnection: { status: hasConnectionWarning ? 'warn' : 'pass', detail: `connectionState=${connectionState}` },
  } as const;
  return { status: Object.values(checks).some((check) => check.status === 'warn') ? 'degraded' : 'healthy', checks };
}

export function assembleMobileBundle(
  diagnostics: MobileDiagnosticsSourceBundle,
  input: { collectors: MobileBundleCollectors; generatedAt?: string; options?: DiagnosticBundleOptions },
): MobileDiagnosticsBundle {
  const sectionStates = defaultDiagnosticSectionStates();
  markSectionOmittedByOptions(sectionStates, input.options);
  if (isSectionEnabled(sectionStates, input.options, 'provider_reachability')) {
    // Mobile cannot report desktop provider reachability because it runs from a
    // different network egress path; keep the section state explicit.
    sectionStates.provider_reachability = 'unavailable';
  }
  if (isSectionEnabled(sectionStates, input.options, 'recent_logs')) {
    sectionStates.recent_logs = diagnostics.logLineCount > 0 ? 'included' : 'empty';
  }
  if (isSectionEnabled(sectionStates, input.options, 'continuity_trail')) {
    sectionStates.continuity_trail = diagnostics.queueSnapshot || diagnostics.continuityState || (diagnostics.catchUpHistory?.length ?? 0) > 0
      ? 'included'
      : 'empty';
  }
  // Mobile recent_events comes from the on-device local buffer (mobile-only,
  // never uploaded). Unlike desktop/cloud, mobile events have their own
  // simpler shape, so we don't run them through filterDiagnosticEventsForSections
  // (which assumes the cloud DiagnosticEventKind taxonomy). The buffer reader
  // is responsible for the size cap — assembleMobileBundle just decides
  // whether the section is included / empty / unavailable.
  if (isSectionEnabled(sectionStates, input.options, 'recent_events')) {
    if (diagnostics.recentEvents === undefined) {
      // Source bundle never tried to load — collector is unavailable on this
      // surface (e.g. unit tests that don't wire the buffer).
      sectionStates.recent_events = 'unavailable';
    } else if (diagnostics.recentEvents.length === 0) {
      sectionStates.recent_events = 'empty';
    } else {
      sectionStates.recent_events = 'included';
    }
  }
  const bundle: MobileDiagnosticsBundle = {
    manifest: {
      schemaVersion: DIAGNOSTIC_MANIFEST_SCHEMA_VERSION,
      generatedAt: input.generatedAt ?? new Date().toISOString(),
      source: 'mobile',
      app: {
        version: input.collectors.getAppVersion() || diagnostics.deviceInfo.appVersion || 'unknown',
        platform: diagnostics.deviceInfo.platform ?? input.collectors.getPlatform(),
        platformVersion: diagnostics.deviceInfo.platformVersion ?? input.collectors.getPlatformVersion(),
        runtimeVersion: diagnostics.deviceInfo.runtimeVersion ?? input.collectors.getRuntimeVersion(),
      },
      sections: sectionStates,
    },
    health: buildMobileHealth(diagnostics),
    sessionsIndex: buildMobileSessionsIndex(input.collectors.getSessions()),
    logs: { mainNdjson: redactSensitiveData(diagnostics.filteredLogs), lineCount: diagnostics.logLineCount },
  };
  if (diagnostics.queueSnapshot) bundle.queueSnapshot = diagnostics.queueSnapshot;
  if (diagnostics.continuityState) bundle.continuityState = diagnostics.continuityState;
  if (diagnostics.catchUpHistory && diagnostics.catchUpHistory.length > 0) bundle.catchUpHistory = diagnostics.catchUpHistory;
  if (
    diagnostics.recentEvents
    && diagnostics.recentEvents.length > 0
    && sectionStates.recent_events === 'included'
  ) {
    bundle.recentEvents = diagnostics.recentEvents;
  }
  return bundle;
}
