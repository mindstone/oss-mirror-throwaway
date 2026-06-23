/**
 * Diagnostic Bundle Manifest Types
 *
 * Type definitions and constants for the structured diagnostic bundle export.
 * These define the schema for manifest.json, logs/summary.json, and related
 * files included in the diagnostic .zip archive.
 *
 * @see docs/plans/finished/260103_improved_diagnostic_bundle.md for full specification
 */

import type { SectionId, SectionState } from '@shared/diagnostics/diagnosticBundleSections';
import type { ContinuityFamily, ContinuityMessage, ContinuityReason } from '@shared/diagnostics/continuityTransition';
import type { SuperMcpDiagnosticTransitionReason } from '@core/rebelCore/superMcpContract';
import type { CheckStatus } from '../health/types';
// =============================================================================
// Constants: File Inclusion Limits
// =============================================================================

/**
 * Maximum number of turn-specific log files to include from logs/sessions/
 * Limits bundle size while capturing recent agent behavior.
 */
export const MAX_TURN_LOGS = 50;

/**
 * Maximum number of recent session files to include.
 * Sessions are truncated to summary + last N messages.
 */
export const MAX_RECENT_SESSIONS = 5;

/**
 * Maximum messages to include per session excerpt.
 * Full conversation history would bloat the bundle.
 */
export const MAX_MESSAGES_PER_SESSION = 20;

/**
 * Default time window for log collection (in minutes).
 */
export const DEFAULT_LOG_WINDOW_MINUTES = 15;

/**
 * Maximum API cost ledger entries to include.
 */
export const MAX_COST_LEDGER_ENTRIES = 500;

/**
 * Maximum lines per individual log file.
 */
export const MAX_LINES_PER_LOG_FILE = 300;

/**
 * Per-collector deadline for the desktop diagnostics bundle. Each of the 13
 * collectors runs sequentially behind its own timeout so a single hung `fs`/
 * index read (under heap/IO pressure — the "stuck on preparing" incident)
 * cannot stall the whole export. On timeout the section is marked
 * `unavailable` and recorded in `manifest.timedOut`; the bundle continues.
 *
 * Sized generously (12s) so a slow-but-healthy collector under load still
 * completes — the goal is to bound the *hang*, not to clip legitimately slow
 * reads. Sequential wrapping bounds the abandoned-promise residual to at most
 * one timed-out-but-still-running promise at a time (see A7).
 */
export const DIAGNOSTIC_COLLECTOR_TIMEOUT_MS = 12_000;

/**
 * Overall ceiling for desktop bundle assembly. Even a pathological set of
 * collectors that each sit just under the per-collector deadline cannot exceed
 * this; once it fires, assembly finalises with whatever sections completed and
 * marks the rest `unavailable`. Comfortably above a single per-collector
 * timeout so the per-collector path is the normal degradation mechanism and the
 * top-level deadline is the backstop.
 */
export const DIAGNOSTIC_BUNDLE_DEADLINE_MS = 30_000;

/**
 * Maximum events retained in the diagnostic-events ledger before rotation.
 *
 * At ~120 bytes per record this caps a single ledger file at roughly 600 KB,
 * with one rotated `.old` companion → max ~1.2 MB on disk per installation.
 *
 * Sized to retain a few days of failure history for typical users while keeping
 * bundle assembly cheap. If failure storms saturate the ledger the rotation
 * preserves the last `MAX_DIAGNOSTIC_EVENTS` and discards older entries.
 */
export const MAX_DIAGNOSTIC_EVENTS = 5_000;

/**
 * Maximum bytes streamed from the ledger when assembling a diagnostic bundle.
 * Defends against pathological growth between rotations.
 */
export const MAX_DIAGNOSTIC_EVENTS_BYTES = 2 * 1024 * 1024;

/**
 * Maximum accepted lag between a cost ledger row and a late outcome-resolution
 * diagnostic event. Longer gaps are treated as visible degradation.
 */
export const MAX_OUTCOME_RESOLUTION_LAG_MS = 60_000;

/**
 * Patterns for sensitive environment variable names in MCP config.
 * Values matching these patterns should be redacted.
 */
export const SENSITIVE_ENV_VAR_PATTERNS = [
  /api[_-]?key/i,
  /secret/i,
  /token/i,
  /password/i,
  /credential/i,
  /auth/i,
  /bearer/i,
  /private[_-]?key/i,
] as const;

// =============================================================================
// Types: Manifest Structure (manifest.json)
// =============================================================================

/**
 * Application metadata included in manifest.
 */
export interface DiagnosticAppInfo {
  /** Application version string (e.g., "1.2.3") */
  version: string;
  /** OS platform (darwin, win32, linux) */
  platform: NodeJS.Platform;
  /** CPU architecture (arm64, x64) */
  arch: string;
  /** Whether running from packaged app vs dev mode */
  isPackaged: boolean;
  /** Electron version */
  electronVersion: string;
  /** Node.js version */
  nodeVersion: string;
}

/**
 * Content type for files in the bundle.
 */
export type DiagnosticContentType =
  | 'human-readable' // Markdown/text for humans
  | 'structured' // JSON with defined schema
  | 'index' // Metadata/summary file
  | 'logs' // Log entries (NDJSON or plain text)
  | 'config'; // Configuration file

/**
 * Metadata for a single file in the bundle.
 */
export interface DiagnosticFileEntry {
  /** Content type for processing hints */
  type: DiagnosticContentType;
  /** Human-readable description */
  description: string;
  /** Approximate size in bytes (optional) */
  sizeBytes?: number;
  /** Whether content was truncated */
  truncated?: boolean;
}

/**
 * Performance statistics for diagnosing Windows CPU/performance issues.
 */
export interface DiagnosticPerfStats {
  /** Count of slow store writes (>100ms) since app start */
  slowStoreWritesSinceStart: number;
  /** Max store write duration observed (ms) */
  maxStoreWriteMs: number;
  /** Count of slow process spawns (>2000ms) since app start */
  slowSpawnsSinceStart: number;
  /** Max spawn duration observed (ms) */
  maxSpawnMs: number;
  /** App uptime when stats captured (minutes) */
  uptimeMinutes: number;
  /** Platform (win32/darwin/linux) for filtering */
  platform: string;
}

/**
 * Auto-Update forensics snapshot for diagnosing update failures.
 */
export interface AutoUpdateForensics {
  platform: 'darwin' | 'win32' | 'linux';
  lastCheckAt: number | null;
  lastCheckResult: 'available' | 'not-available' | 'error' | null;
  lastErrorAt: number | null;
  lastErrorMessage: string | null;
  recoveryAttempts: Record<string, number>;
  installMarker: {
    hasMarker: boolean;
    updateKey?: string;
    fromVersion?: string;
    targetVersion?: string;
    requestedAt?: number;
  };
}

/**
 * Pre-turn worker statistics for identifying crash loops or performance issues.
 */
export interface PreTurnWorkerStats {
  since: 'app_start';
  appStartedAt: number;
  spawnCount: number;
  restartCount: number;
  lastCrashCategory?: 'oom' | 'unhandled_exception' | 'sigterm' | 'unknown';
  lastCrashAt?: number;
  averagePreTurnDurationBucket?: '<100ms' | '<500ms' | '<2s' | '>=2s';
  currentlyRestarting: boolean;
  persistedLastCrashAt?: number;
  persistedLastCrashCategory?: 'oom' | 'unhandled_exception' | 'sigterm' | 'unknown';
  crashesInLast7Days?: number;
  totalCrashesAllTime?: number;
}

/**
 * Quick statistics for immediate triage.
 */
export interface DiagnosticQuickStats {
  /** Overall health status from SystemHealthReport */
  healthStatus: 'healthy' | 'degraded' | 'critical';
  /** IDs of failed health checks */
  failedChecks: string[];
  /** IDs of warning health checks */
  warnChecks: string[];
  /** Error log count in time window */
  errorCountLast15m: number;
  /** Warning log count in time window */
  warnCountLast15m: number;
  /** Number of recent sessions included */
  sessionCount: number;
  /** Performance stats for Windows diagnosis (optional - only if slow operations recorded) */
  perfStats?: DiagnosticPerfStats;
  /** Pre-turn worker statistics for identifying crash loops or performance issues */
  preTurnWorker?: PreTurnWorkerStats;
  /** Auto-Update forensics snapshot for diagnosing update failures */
  autoUpdate?: AutoUpdateForensics;
  /**
   * Per-kind tally of diagnostic events present in this bundle's events.jsonl.
   * Surfaces the populated ledger in the manifest so support staff opening
   * the bundle see "5 cooldown_enter, 3 mcp_transition" without parsing NDJSON.
   * Omitted when no events were available.
   */
  recentDiagnosticEventCounts?: Partial<Record<DiagnosticEventKind, number>>;
  /**
   * Most-recent timestamp (epoch ms) per kind for the events in this bundle.
   * Lets a triager see at a glance which lifecycle has fired most recently.
   * Omitted when no events were available.
   */
  lastDiagnosticEventTimes?: Partial<Record<DiagnosticEventKind, number>>;
  /**
   * Event kinds that crossed their per-kind write cap during this process
   * lifetime, as observed in the bundle's events window.
   */
  diagnosticEventCapEngagedKinds?: DiagnosticEventKind[];
  /**
   * Snapshot of fs-handle exhaustion (EMFILE / ENFILE) signals observed
   * since process start. Surfaces graceful-fs queue depth and the per-source
   * tag counts so post-incident triage can answer "did this run hit fs
   * pressure, and where?" without reading raw Sentry events.
   * Omitted when no exhaustion has been tagged AND the queue is idle.
   */
  fsExhaustion?: FsExhaustionSnapshot;
  /**
   * Top-level userData store-file size breakdown — sorted by bytes desc.
   * Helps triage "which persistent store blew up" without diffing the bundle's
   * raw JSON files. Omitted when the userData walk fails or yields nothing.
   */
  storeBreakdown?: StoreBreakdownSnapshot;
  /**
   * Lifetime main-process supervision counters: how many startups did NOT
   * follow a clean exit, with the most recent crash timestamp. Reads from
   * the existing clean-exit-flag store so we don't need a second persistence
   * mechanism. Omitted when the store is unreadable or empty.
   */
  processSupervision?: ProcessSupervisionSnapshot;
  /**
   * Aggregated cloud-outbox status — pending count and oldest queue age.
   * Helps answer "is cloud sync stalled?" at a glance. Omitted when the
   * outbox snapshot is unavailable on this surface.
   */
  cloudOutbox?: CloudOutboxSnapshot;
}

/**
 * Source classification for an EMFILE/ENFILE event that escaped graceful-fs.
 * Mirrors {@link import('@core/utils/gracefulFsObservability').FsExhaustionSource}
 * minus the `'unknown'` sentinel — the sentinel never reaches the bundle.
 */
export type FsExhaustionSourceClass =
  | 'graceful_fs_queue'
  | 'emfile_retry_final'
  | 'native_bypass'
  | 'log_event_handler'
  | 'console_message_relay'
  | 'diagnostics_snapshot_refresh';

export interface FsExhaustionSnapshot {
  sourceCounts: Record<FsExhaustionSourceClass, number>;
  lastSource?: FsExhaustionSourceClass;
  lastTaggedAt?: number;
  queueDepth: number;
  queuePeak: number;
  oldestPendingAgeMs?: number;
}

export interface StoreBreakdownEntry {
  /** Filename (top-level under userData) e.g. `cost-ledger.jsonl`. */
  name: string;
  /** Size in bytes. */
  bytes: number;
  /** mtime in epoch ms (last modified). */
  mtimeMs: number;
}

export interface StoreBreakdownSnapshot {
  /** Up to {@link MAX_STORE_BREAKDOWN_ENTRIES} entries, sorted by bytes desc. */
  entries: StoreBreakdownEntry[];
  /** Total bytes across all top-level userData files (pre-truncation). */
  totalBytes: number;
  /** True when more files exist than {@link MAX_STORE_BREAKDOWN_ENTRIES}. */
  truncated: boolean;
}

export interface ProcessSupervisionSnapshot {
  /** True when the previous shutdown was clean (matches `clean-exit-flag.json` content). */
  lastShutdownClean: boolean;
  /** Total non-clean startups recorded in the rolling buffer. */
  totalCrashesAllTime: number;
  /** Crashes within the last 24 hours (recomputed at bundle time from `recentCrashes`). */
  crashesInLast24h: number;
  /** Crashes within the last 7 days (recomputed at bundle time from `recentCrashes`). */
  crashesInLast7Days: number;
  /** Most recent unclean-startup timestamp, epoch ms. Omitted when the buffer is empty. */
  lastCrashAt?: number;
}

export interface CloudOutboxSnapshot {
  /** Count of entries currently waiting to be drained. */
  pending: number;
  /** Age of the oldest queued entry in ms (omitted when queue is empty). */
  oldestAgeMs?: number;
}

/**
 * Cap for {@link StoreBreakdownSnapshot.entries}. Sized so that the largest
 * top-level files (cost-ledger.jsonl, sessions/index.json, automations.json,
 * etc.) all fit even on heavy installs without bloating the manifest.
 */
export const MAX_STORE_BREAKDOWN_ENTRIES = 32;

/**
 * Parameters used to generate this bundle.
 * Helps agents understand truncation/limits applied.
 */
export interface DiagnosticBundleParams {
  /** Log time window in minutes */
  logWindowMinutes: number;
  /** Maximum turn logs included */
  maxTurnLogs: number;
  /** Maximum recent sessions included */
  maxRecentSessions: number;
  /** Whether any content was truncated */
  truncated: boolean;
}

/**
 * Root manifest structure for the diagnostic bundle.
 * This is the entry point for agent analysis.
 */
export interface DiagnosticManifest {
  /** Schema version for future compatibility */
  schemaVersion: number;
  /** ISO timestamp of bundle generation */
  generated: string;
  /** Application information */
  app: DiagnosticAppInfo;
  /** Capabilities/features included in this bundle */
  capabilities: string[];
  /** Index of all files in the bundle */
  contents: Record<string, DiagnosticFileEntry>;
  /** Quick triage statistics */
  quickStats: DiagnosticQuickStats;
  /** Generation parameters */
  bundleParams: DiagnosticBundleParams;
  /** Per-section include outcome for bundle consumers and triage. */
  sections?: Partial<Record<SectionId, SectionState>>;
  /**
   * Sections (or pseudo-sections) whose collector hit the per-collector or
   * top-level deadline and were abandoned. Distinct from `sections[id] ===
   * 'empty'` (collector ran, found nothing) — these timed out, so the bundle
   * is self-describing about WHY a section is missing (Failure Mode
   * S2-Silent-failure). Absent/empty when nothing timed out (back-compat).
   */
  timedOut?: SectionId[];
  /**
   * True when assembly fell back to the minimal "logs + update-state only"
   * path (the full bundle would have hung). The renderer surfaces this as a
   * "partial bundle" outcome.
   */
  partial?: boolean;
  /** Guidance for AI agents analyzing this bundle */
  agentGuidance: string;
}

// =============================================================================
// Types: Log Summary Structure (logs/summary.json)
// =============================================================================

/**
 * Time window for log collection.
 */
export interface LogTimeWindow {
  /** ISO timestamp of earliest log entry */
  start: string;
  /** ISO timestamp of latest log entry */
  end: string;
}

/**
 * Metadata for a single log file in the bundle.
 */
export interface LogFileSummary {
  /** Filename within logs/ directory */
  name: string;
  /** Total line count */
  lineCount: number;
  /** File size in bytes */
  sizeBytes: number;
  /** Count of error-level entries */
  errorCount: number;
  /** Count of warn-level entries */
  warnCount: number;
  /** Timestamp of first entry (optional) */
  firstSeen?: string;
  /** Timestamp of last entry (optional) */
  lastSeen?: string;
}

/**
 * Aggregated error pattern for quick identification.
 * Sample entries MUST be redacted before inclusion.
 */
export interface LogErrorPattern {
  /** Representative message (redacted) */
  msg: string;
  /** Log level (50 = error, 40 = warn) */
  level: number;
  /** Number of occurrences */
  count: number;
  /** First occurrence timestamp */
  firstSeen: string;
  /** Last occurrence timestamp */
  lastSeen: string;
  /** Full sample entry (MUST be redacted) */
  sampleEntry?: Record<string, unknown>;
}

/**
 * Summary of all logs included in the bundle.
 */
export interface LogSummary {
  /** Time window covered by logs */
  timeWindow: LogTimeWindow;
  /** Metadata for each log file */
  files: LogFileSummary[];
  /** Aggregated error patterns for quick triage */
  errorPatterns: LogErrorPattern[];
  /** Auto-generated topic tags based on log content */
  topicTags: string[];
}

/**
 * A turn-specific log file from logs/sessions/.
 * Includes filename, content, and size for bundle inclusion.
 */
export interface TurnLogFile {
  /** Filename (e.g., "session-abc123-turn-xyz789.log") */
  filename: string;
  /** Log file content (sanitized) */
  content: string;
  /** File size in bytes */
  sizeBytes: number;
}

// =============================================================================
// Types: Session Excerpts (recent-sessions/*.json)
// =============================================================================

/**
 * Truncated message for session excerpts.
 * Full content may be truncated to limit bundle size.
 */
export interface SessionMessageExcerpt {
  /** Message ID */
  id: string;
  /** Message role (user, assistant) */
  role: 'user' | 'assistant';
  /** Truncated content (first N characters) */
  contentPreview: string;
  /** Whether content was truncated */
  truncated: boolean;
  /** Original content length */
  originalLength: number;
  /** Timestamp if available */
  timestamp?: number;
  /** Turn ID for correlation with logs */
  turnId?: string;
}

/**
 * Session excerpt for diagnostic bundle.
 * Contains metadata and recent messages, not full history.
 */
export interface SessionExcerpt {
  /** Session ID */
  id: string;
  /** Session title */
  title: string | null;
  /** Creation timestamp */
  createdAt: number;
  /** Last update timestamp */
  updatedAt: number;
  /** Session origin (new, resume, automation, etc.) */
  origin: string;
  /** Total message count in full session */
  totalMessageCount: number;
  /** Total turn count in full session */
  turnCount: number;
  /** API cost in USD */
  costUsd?: number;
  /** Recent messages (truncated to MAX_MESSAGES_PER_SESSION) */
  recentMessages: SessionMessageExcerpt[];
}

/**
 * Index of sessions included in the bundle.
 */
export interface SessionsIndex {
  /** Number of sessions included */
  count: number;
  /** Total sessions in history (may be more than included) */
  totalInHistory: number;
  /** Session excerpts */
  sessions: SessionExcerpt[];
}

// =============================================================================
// Types: Sentry Scope (sentry-scope.json)
// =============================================================================

/**
 * Sentry breadcrumb entry (sanitized).
 */
export interface SentryBreadcrumb {
  /** Breadcrumb category */
  category?: string;
  /** Breadcrumb message (redacted) */
  message?: string;
  /** Breadcrumb level */
  level?: string;
  /** Timestamp */
  timestamp?: number;
  /** Additional data (redacted) */
  data?: Record<string, unknown>;
}

/**
 * Sanitized Sentry scope for diagnostics.
 * User email and other PII must be removed.
 */
export interface SentryScopeSummary {
  /** Recent breadcrumbs (redacted) */
  breadcrumbs: SentryBreadcrumb[];
  /** Last error message (redacted) */
  lastError?: string;
  /** Tags for categorization */
  tags?: Record<string, string>;
  /** Number of breadcrumbs truncated */
  truncatedCount?: number;
}

// =============================================================================
// Types: Bundle Generation Options
// =============================================================================

/**
 * Options for generating a diagnostic bundle.
 */
export interface DiagnosticBundleOptions {
  /** Time window for logs in minutes (default: 15) */
  logWindowMinutes?: number;
  /** Maximum turn logs to include (default: 50) */
  maxTurnLogs?: number;
  /** Maximum recent sessions to include (default: 5) */
  maxRecentSessions?: number;
  /** Include errors-only log file for token efficiency */
  includeErrorsOnly?: boolean;
  /** Include full main process logs */
  includeFullLogs?: boolean;
  /** Include Chief of Staff README (sanitized) */
  includeChiefOfStaff?: boolean;
  /** Include Sentry scope/breadcrumbs */
  includeSentryScope?: boolean;
  /** Legacy all-or-nothing enriched diagnostics toggle. */
  includeEnrichedDiagnostics?: boolean;
  /** Legacy continuity diagnostics opt-in. */
  attachContinuityDiagnostics?: boolean;
  /** Per-bundle section include overrides; does not persist to settings. */
  diagnosticSections?: Partial<Record<SectionId, boolean>>;
}

// =============================================================================
// Constants: Schema Version
// =============================================================================

/**
 * Current manifest schema version.
 * Increment when making breaking changes to the structure.
 */
export const DIAGNOSTIC_MANIFEST_SCHEMA_VERSION = 1;

// =============================================================================
// Types: Diagnostic Events Ledger (events.jsonl)
// =============================================================================

/**
 * Diagnostic event entry — append-only ledger record describing something
 * that broke, transitioned, or fired internally.
 *
 * REDACTION-SAFE-BY-CONSTRUCTION RULES (load-bearing — read before adding a variant):
 *
 *   1. `data` payloads MUST use only enum/literal/number/boolean/branded types.
 *      Bare `string` fields are FORBIDDEN. If something looks like it needs a
 *      free-form string, it almost certainly belongs in Sentry breadcrumbs or
 *      pino logs, NOT here.
 *   2. The following key names are FORBIDDEN in any `data` payload because
 *      they historically carry user content or secrets:
 *      `message`, `stack`, `path`, `body`, `response`, `headers`, `trace`,
 *      `fingerprint`, `email`, `prompt`, `content`, `output`, `text`, `url`.
 *   3. Provider names, condition keys, and surface names MUST come from a
 *      typed enum (e.g., `ProviderId`, `KnownCondition`, `'desktop'|'cloud'|'mobile'`).
 *   4. Timestamps are epoch milliseconds (number); never store ISO strings here.
 *   5. Counts are non-negative finite numbers.
 *   6. Schema version `v` is bumped on any breaking change to a variant.
 *      Additive optional fields (e.g., adding a new optional enum to `data`)
 *      are non-breaking and don't bump `v`.
 *
 * Add a new variant by adding to `DiagnosticEventKind` AND `DiagnosticEventEntry`,
 * then add a Zod schema in `diagnosticEventsLedger.ts`. The Vitest guard test
 * `diagnosticEventSchema.test.ts` will fail if the schema admits a bare string.
 */
export const DIAGNOSTIC_EVENT_SCHEMA_VERSION = 1;

/**
 * Threshold in ms above which a health check emits a timing event.
 */
export const HEALTH_CHECK_SLOW_THRESHOLD_MS = 500;

/**
 * Default timeout for health checks.
 */
export const HEALTH_CHECK_TIMEOUT_MS = 5000;

/**
 * Surface that emitted the event. Mirrors the cross-surface boundary.
 */
export type DiagnosticEventSurface = 'desktop' | 'cloud' | 'mobile' | 'unknown';

/**
 * Cooldown scope — distinguishes the persisted main-API cooldown from the
 * non-persisted safety-eval (Haiku) cooldown, and the cloud failure circuit
 * breaker (added Stage 1a).
 */
export type CooldownScope = 'api' | 'safety-eval' | 'safety-eval-degraded' | 'cloud';

/**
 * Authentication provider key for `auth_event.data.provider`.
 * Strict allowlist — every emit site must pass one of these.
 */
export type AuthProviderKey =
  | 'google'
  | 'microsoft'
  | 'codex'
  | 'rebel'
  | 'openrouter'
  | 'anthropic';

/**
 * OAuth refresh error code for `auth_event.data.errorCode`.
 * Mirrors `OAuthRefreshErrorCode` in `oauthRefreshFailureStore.ts`. `unknown`
 * is the explicit fallback used when the upstream error code is missing or
 * unrecognised (deliberately part of the closed enum so emit-sites don't have
 * to omit the field).
 */
export type AuthRefreshErrorCode =
  | 'invalid_grant'
  | 'unauthorized_client'
  | 'invalid_client'
  | 'invalid_request'
  | 'invalid_scope'
  | 'unsupported_grant_type'
  | 'access_denied'
  | 'unknown';

/**
 * Super-MCP lifecycle transition kind for `mcp_transition.data.transition`.
 * Stage 1a is Super-MCP singleton only (no per-server discriminator).
 */
export type McpLifecycleTransition = 'connect' | 'disconnect' | 'restart' | 'error';

/**
 * Reason for a `mcp_transition` event. Closed enum (additive only), sourced
 * from the Super-MCP seam contract so restart attribution and diagnostic
 * reasons share one authority. When a real reason is unknown at emit time the
 * field is OMITTED rather than coerced.
 */
export type McpTransitionReason = SuperMcpDiagnosticTransitionReason;

/**
 * Streaming-invariant violation kind for `streaming_invariant.data.violation`.
 * Closed enum with reserved values for future detectors that don't have an
 * emit site yet (`content_block_underflow`, `sse_on_non_streaming`,
 * `duplicate_tool_id`).
 */
export type StreamingInvariantKind =
  | 'orphan_tool_use'
  | 'orphan_tool_result'
  | 'duplicate_tool_id'
  | 'skeleton_empty_output'
  | 'skeleton_no_user_text'
  | 'skeleton_tool_blocks_leaked'
  | 'content_block_underflow'
  | 'sse_on_non_streaming';

/**
 * Kind of advisory emitted by the agent-loop circuit breaker.
 * Mirrors `ToolFailureAdvisory.type` exactly to avoid drift.
 */
export type ToolAdvisoryKind =
  | 'consecutive_error'
  | 'global_consecutive_error'
  | 'soft_budget'
  | 'hard_budget';

/**
 * Discriminated union of all diagnostic event variants.
 *
 * INVARIANT: every variant's `data` payload uses only enum/literal/number/boolean.
 * If you find yourself wanting to add `string`, stop and use Sentry/pino instead.
 */
export type DiagnosticEventEntry =
  | DiagnosticCooldownEnterEvent
  | DiagnosticCooldownExitEvent
  | DiagnosticToolAdvisoryEvent
  | DiagnosticKnownConditionEvent
  | DiagnosticToolCallErrorEvent
  | DiagnosticMcpTransitionEvent
  | DiagnosticAuthEvent
  | DiagnosticStreamingInvariantEvent
  | DiagnosticAbortEvent
  | DiagnosticWatchdogJudgeDecisionEvent
  | DiagnosticJudgeDecisionStaleSkipEvent
  | DiagnosticSubagentInternalTimeoutRecoveredEvent
  | DiagnosticApprovalStuckEvent
  | DiagnosticHealthCheckTimingEvent
  | DiagnosticProviderReachabilityChangeEvent
  | DiagnosticEmbeddingIndexEvent
  | DiagnosticPreTurnWorkerStatsEvent
  | DiagnosticAutoUpdateEvent
  | DiagnosticFseventsLeakSweepEvent
  | DiagnosticQuitDeadlockDetectedEvent
  | DiagnosticSettingsDriftEvent
  | DiagnosticCostOutcomeResolutionEvent
  | DiagnosticCostOutcomeResolutionLostEvent
  | DiagnosticCostOutcomeResolutionUnmatchedEvent
  | DiagnosticContinuityTransitionEvent
  | DiagnosticEventsPerKindCapEngagedEvent;

interface DiagnosticEventCommon {
  /** Schema version (currently 1). */
  v: number;
  /** Epoch milliseconds when the event occurred. */
  ts: number;
  /** Surface that emitted the event. */
  surface: DiagnosticEventSurface;
  /** Optional turn id (when emitted within a turn context). Hash-friendly opaque ID. */
  tid?: string;
  /** Optional session id. Hash-friendly opaque ID. */
  sid?: string;
}

export interface DiagnosticCooldownEnterEvent extends DiagnosticEventCommon {
  kind: 'cooldown_enter';
  data: {
    scope: CooldownScope;
    /** Epoch ms when cooldown is expected to end. */
    untilMs: number;
    /** True when a server-provided Retry-After value was used. */
    retryAfterProvided: boolean;
    /** Cooldown duration in ms (capped). */
    durationMs: number;
    /**
     * Why the cooldown was entered. Populated only on safety-eval-degraded scope
     * when the caller can derive it from the upstream error.
     */
    reasonKind?: string;
    /**
     * Absolute epoch-ms when the upstream limit resets (billing / usage-cap case).
     * Not guaranteed even for billing errors.
     */
    resetAtMs?: number;
  };
}

export interface DiagnosticCooldownExitEvent extends DiagnosticEventCommon {
  kind: 'cooldown_exit';
  data: {
    scope: CooldownScope;
    /** Reason for exit. */
    reason: 'success' | 'reset' | 'expired';
  };
}

export interface DiagnosticToolAdvisoryEvent extends DiagnosticEventCommon {
  kind: 'tool_advisory';
  data: {
    advisory: ToolAdvisoryKind;
    /** Total tool calls in the turn at emission time. */
    totalToolCalls: number;
  };
}

export interface DiagnosticKnownConditionEvent extends DiagnosticEventCommon {
  kind: 'known_condition';
  data: {
    /**
     * The KnownCondition enum key — never the raw error message. Typed as a
     * branded string (`KnownConditionKey`) at runtime via the Zod schema; the
     * concrete `KnownCondition` enum from `@core/sentry/knownConditions` is
     * not imported here to avoid a manifest → sentry circular dependency.
     */
    condition: string;
    /** Severity level mirrored from ConditionMeta. */
    level: 'info' | 'warning' | 'error';
  };
}

/**
 * Single tool-call error from the agent loop. Emitted only on `is_error: true`
 * tool results, capped at `MAX_TOOL_CALL_ERROR_EMITS_PER_TURN` per agent-loop
 * invocation. No raw tool name, no error text, no error stack — see
 * `eventHashing.ts` for the hash convention.
 */
export interface DiagnosticToolCallErrorEvent extends DiagnosticEventCommon {
  kind: 'tool_call_error';
  data: {
    /** SHA-256/16-hex of the tool name (built-in or MCP). */
    toolNameHash: string;
    /** True when the same per-tool normalized signature already fired in this turn. */
    isRepeatOfNormalizedSignature: boolean;
    /** Position of this call in the turn (1-based). */
    turnCallIndex: number;
  };
}

/**
 * Super-MCP lifecycle transition. Stage 1a populates Super-MCP singleton
 * lifecycle events only; per-server emits are deferred to Stage 1b and use
 * the optional `serverIdHash` field.
 */
export interface DiagnosticMcpTransitionEvent extends DiagnosticEventCommon {
  kind: 'mcp_transition';
  data: {
    transition: McpLifecycleTransition;
    /** Reason for the transition. Omitted when unknown rather than coerced. */
    reason?: McpTransitionReason;
    /** SHA-256/16-hex of the server id (Stage 1b). */
    serverIdHash?: string;
    /** Cumulative restart count for this manager instance (≥0). */
    restartCount: number;
    /** Consecutive startup failures (≥0). Resets on successful connect. */
    consecutiveFailures: number;
  };
}

/**
 * OAuth-style auth lifecycle event. Stage 1a covers token-refresh transitions
 * only (login flows deferred — no chokepoint exists yet).
 */
export interface DiagnosticAuthEvent extends DiagnosticEventCommon {
  kind: 'auth_event';
  data: {
    transition: 'refresh_success' | 'refresh_failure';
    provider: AuthProviderKey;
    errorCode?: AuthRefreshErrorCode;
    /** True when this transition crosses the needs-reconnect threshold. */
    needsReconnect: boolean;
    /** SHA-256/16-hex of the account slug (e.g. 'Google-greg-work-com'). */
    accountSlugHash: string;
  };
}

/**
 * Streaming-invariant violation observed by a runtime detector. `repaired`
 * distinguishes graceful self-repair (orphan resolution) from fatal-to-turn
 * (skeleton invariant throws).
 */
export interface DiagnosticStreamingInvariantEvent extends DiagnosticEventCommon {
  kind: 'streaming_invariant';
  data: {
    violation: StreamingInvariantKind;
    /** Number of distinct ids/blocks involved (≥1). */
    occurrenceCount: number;
    /** Whether the runtime auto-repaired vs propagated as throw. */
    repaired: boolean;
  };
}

/**
 * Reason a turn was aborted. Closed enum (additive only).
 * - `user_cancel` — explicit user stop.
 * - `superseded` — newer user turn supersedes the in-flight one.
 * - `watchdog` — main-process watchdog (covers pre-turn timeout, stuck stream, etc).
 * - `judge_killed` — watchdog judge explicitly decided to stop the turn.
 * - `consecutive_fail_open_cap` — watchdog judge failed open repeatedly and hit kill cap.
 * - `tool_cancelled_cap` — watchdog cancelled the same tool repeatedly and stopped the turn.
 * - `tool_cancel_unresponsive` — watchdog cancelled a tool but it did not settle cleanly.
 * - `tool_repeated_timeout` — a subagent's internal timeout (per A15) hit the per-tool cap and stopped the turn.
 * - `budget_hard` — agent-loop hard tool-call budget tripped.
 * - `budget_soft` — agent-loop soft budget tripped (advisory only, but recorded).
 * - `shutdown` — main process is exiting.
 */
export type AbortReason =
  | 'user_cancel'
  | 'superseded'
  | 'watchdog'
  | 'judge_killed'
  | 'consecutive_fail_open_cap'
  | 'tool_cancelled_cap'
  | 'tool_cancel_unresponsive'
  | 'tool_repeated_timeout'
  | 'budget_hard'
  | 'budget_soft'
  | 'shutdown';

/**
 * Closed-bucket coarse duration for `abort_event.data.durationBucketMs`.
 * Buckets keep raw latency private while preserving "instant vs slow" signal
 * useful for diagnosing whether a turn aborted early or after long churn.
 */
export const ABORT_DURATION_BUCKETS_MS = [1_000, 10_000, 30_000, 120_000, 600_000] as const;
export type AbortDurationBucketMs = (typeof ABORT_DURATION_BUCKETS_MS)[number];

/**
 * Map a raw turn duration in ms to the closest closed bucket.
 * Returns the smallest bucket that is ≥ the input, or the largest bucket on overflow.
 */
export function bucketAbortDurationMs(durationMs: number): AbortDurationBucketMs {
  if (!Number.isFinite(durationMs) || durationMs <= 0) return ABORT_DURATION_BUCKETS_MS[0];
  for (const bucket of ABORT_DURATION_BUCKETS_MS) {
    if (durationMs <= bucket) return bucket;
  }
  return ABORT_DURATION_BUCKETS_MS[ABORT_DURATION_BUCKETS_MS.length - 1];
}

/**
 * Turn / agent-loop abort lifecycle event. Emitted at the canonical
 * single-emission sites (terminal-lifecycle helper, agent-loop budget throws)
 * so post-incident bundles can answer "why did the turn end?" without raw logs.
 *
 * No raw error message, no tool name, no stack — see `eventHashing.ts` for
 * the redaction convention.
 */
export interface DiagnosticAbortEvent extends DiagnosticEventCommon {
  kind: 'abort_event';
  data: {
    reason: AbortReason;
    /** Coarse-bucketed duration from turn start to abort. Closed enum (no raw ms). */
    durationBucketMs: AbortDurationBucketMs;
  };
}

/**
 * Watchdog judge decision event for non-abort outcomes.
 * - `extended` — judge granted more time.
 * - `failed_extended` — judge call failed and we fail-open extended.
 * - `tool_cancelled` — judge chose kill while a bound tool was active, so only that tool was cancelled.
 * - `auto_extended` — deterministic gate granted more time without calling the judge.
 */
export type WatchdogJudgeDecisionReason =
  | 'auto_extend_first_call_modest_silence'
  | 'auto_extend_active_subagent_recent_activity';
export type WatchdogJudgeInjectionSuspicion = 'none' | 'warn' | 'override';

export interface DiagnosticWatchdogJudgeDecisionEvent extends DiagnosticEventCommon {
  kind: 'watchdog_judge_decision';
  data: {
    decision: 'extended' | 'failed_extended' | 'tool_cancelled' | 'auto_extended';
    additionalMs?: number;
    // 'refusal' = provider safety classifier refused the judge call
    // (stop_reason: 'refusal'). Mirrors WatchdogJudgeFailureCause in
    // watchdogJudge.ts and WATCHDOG_JUDGE_FAILURE_CAUSE in diagnosticEventsLedger.ts.
    cause?: 'timeout' | 'parse_failed' | 'request_failed' | 'malformed_decision' | 'refusal';
    reason?: WatchdogJudgeDecisionReason;
    injectionSuspected?: WatchdogJudgeInjectionSuspicion;
    priorExtensionCount: number;
    elapsedMs: number;
    silentMs: number;
    toolName?: string;
  };
}

/**
 * Watchdog judge decision arrived after the bound tool had already resolved.
 * This is logged as an info diagnostic so stale async judge results can be
 * distinguished from actual tool cancellation. Records the decision the judge
 * returned (kill, extend, or failed_extended) so triagers can see what would
 * have been applied if the bound tool had still been live.
 */
export interface DiagnosticJudgeDecisionStaleSkipEvent extends DiagnosticEventCommon {
  kind: 'judge_decision_stale_skip';
  data: {
    boundToolUseId: string;
    decision: 'kill' | 'extend' | 'failed_extended';
  };
}

/**
 * A subagent's own internal timeout fired (`AgentToolTimeoutError`) and the
 * agent loop converted it into a synthetic `tool_result { is_error: true }`
 * so the parent turn can continue. Info-level: this is the GOOD recovery
 * path, not a failure. See A15 in
 * `docs/plans/260508_tool_level_timeout_and_judge_tuning.md`.
 */
export interface DiagnosticSubagentInternalTimeoutRecoveredEvent extends DiagnosticEventCommon {
  kind: 'subagent_internal_timeout_recovered';
  data: {
    toolUseId: string;
    /** Subagent name (e.g., `forager`). Omitted when the loop did not track a name. */
    agentName?: string;
    elapsedMs: number;
    /** Per-tool-name timeout count BEFORE this event was recorded (≥0). */
    priorTimeoutCount: number;
  };
}

/**
 * Approval-queue age bucket for `approval_stuck.data.ageBucketMinutes`.
 * Closed enum keeps raw ages out of the ledger while preserving meaningful
 * "minutes / hours / overnight" signal.
 */
export const APPROVAL_AGE_BUCKETS_MINUTES = [5, 15, 60, 240] as const;
export type ApprovalAgeBucketMinutes = (typeof APPROVAL_AGE_BUCKETS_MINUTES)[number];

/**
 * Map a raw approval age in minutes to the largest bucket it has crossed.
 * Returns `null` when the request hasn't aged past the smallest bucket yet —
 * the caller should NOT emit in that case.
 */
export function bucketApprovalAgeMinutes(ageMinutes: number): ApprovalAgeBucketMinutes | null {
  if (!Number.isFinite(ageMinutes) || ageMinutes < APPROVAL_AGE_BUCKETS_MINUTES[0]) return null;
  let crossed: ApprovalAgeBucketMinutes = APPROVAL_AGE_BUCKETS_MINUTES[0];
  for (const bucket of APPROVAL_AGE_BUCKETS_MINUTES) {
    if (ageMinutes >= bucket) crossed = bucket;
  }
  return crossed;
}

/**
 * Approval kind for `approval_stuck.data.approvalKind`.
 * - `tool` — pending tool-safety approval.
 * - `memory` — pending memory-write approval.
 */
export type ApprovalKind = 'tool' | 'memory';

/**
 * Stuck approval-queue event. Emitted at most once per (approvalId, bucket)
 * transition by the periodic approvals diagnostic tick — prevents the ledger
 * from filling with noisy tick events while still capturing "this approval
 * has been waiting for 4+ hours and the user clearly forgot".
 *
 * No tool name, no content, no path — only the bucket + queue depth at emit.
 */
export interface DiagnosticApprovalStuckEvent extends DiagnosticEventCommon {
  kind: 'approval_stuck';
  data: {
    approvalKind: ApprovalKind;
    ageBucketMinutes: ApprovalAgeBucketMinutes;
    /** Pending-queue depth at emit time (≥1 — the stuck request itself counts). */
    queueDepth: number;
  };
}

/**
 * Health check timing event. Emitted only when slow (> 500ms) or timed out.
 */
export interface DiagnosticHealthCheckTimingEvent extends DiagnosticEventCommon {
  kind: 'health_check_timing';
  data: {
    checkIdHash: string; // SHA-256/16-hex of CheckResult.id
    durationBucketMs: 500 | 1000 | 5000 | 30000; // closed bucket enum
    status: CheckStatus; // 'pass' | 'warn' | 'fail' | 'skip' (existing enum)
    timedOut?: boolean; // true when HEALTH_CHECK_TIMEOUT_MS fired (status forced to 'fail')
  };
}

/**
 * Provider reachability status change event.
 */
export interface DiagnosticProviderReachabilityChangeEvent extends DiagnosticEventCommon {
  kind: 'provider_reachability_change';
  data: {
    provider: 'anthropic' | 'openai' | 'google' | 'openrouter' | 'codex' | 'rebel-cloud';
    status: 'reachable' | 'unreachable' | 'unknown';
    errorCode?: 'dns' | 'tls' | 'http_4xx' | 'http_5xx' | 'timeout' | 'unknown';
    latencyMs?: number;
  };
}

export interface DiagnosticEmbeddingIndexEvent extends DiagnosticEventCommon {
  kind: 'embedding_index_health';
  data: {
    component: 'embedding_service' | 'semantic_index' | 'tool_index';
    transition: 'ready_to_unready' | 'unready_to_ready' | 'fresh_to_stale' | 'stale_to_fresh';
    ageBucketHours?: 1 | 6 | 24 | 168; // closed bucket; only for stale transitions
  };
}

/**
 * Pre-turn worker statistics emitted once per turn at turn start.
 */
export interface DiagnosticPreTurnWorkerStatsEvent extends DiagnosticEventCommon {
  kind: 'worker_stats_pre_turn';
  data: {
    since: 'app_start';
    appStartedAt: number;
    spawnCount: number;
    restartCount: number;
    lastCrashCategory?: 'oom' | 'unhandled_exception' | 'sigterm' | 'unknown';
    lastCrashAt?: number;
    averagePreTurnDurationBucket?: '<100ms' | '<500ms' | '<2s' | '>=2s';
    currentlyRestarting: boolean;
    persistedLastCrashAt?: number;
    persistedLastCrashCategory?: 'oom' | 'unhandled_exception' | 'sigterm' | 'unknown';
    crashesInLast7Days?: number;
    totalCrashesAllTime?: number;
  };
}

/**
 * Auto-update lifecycle event. Emitted on check/install state transitions.
 */
export interface DiagnosticAutoUpdateEvent extends DiagnosticEventCommon {
  kind: 'auto_update_state_change';
  data: {
    transition: 'check_started' | 'check_succeeded' | 'check_failed' | 'install_attempted' | 'install_succeeded' | 'install_failed' | 'native_watcher_cleanup_timeout';
    platform: 'darwin' | 'win32' | 'linux';
    // Mirrors UpdateErrorCategory in src/main/services/autoUpdateService.ts
    // (core cannot import from main, so the union is duplicated here).
    errorCategory?: 'network' | 'signature' | 'permission' | 'lock' | 'disk' | 'parse' | 'ssl' | 'no-update' | 'unknown';
    timeoutMs?: number;
  };
}

/**
 * Emitted at a point-of-no-return exit when the fsevents leak guard had to
 * force-stop leaked native watcher instances (quit-time SIGABRT class —
 * docs/plans/260611_fsevents-shutdown-crash). Any occurrence is an
 * in-the-wild confirmation of the chokidar-v3 pool leak and feeds the
 * post-ship recurrence canary; the local ledger copy survives even when the
 * companion Sentry capture is lost at process exit.
 */
export interface DiagnosticFseventsLeakSweepEvent extends DiagnosticEventCommon {
  kind: 'fsevents_leak_sweep';
  data: {
    /** Number of leaked native instances the sweep force-stopped (>0). */
    sweptCount: number;
    /** Which point-of-no-return path performed the sweep. */
    trigger: 'immediate_exit' | 'will_quit_backstop';
    /** Final-exit reason string (immediate_exit only), e.g. `graceful-shutdown-complete`. */
    exitReason?: string;
  };
}

/**
 * Quit-deadlock detected — emitted when a quit/install fallback fires because
 * the quit sequence did not complete in its budget (FOX-3487 Electron-≥41
 * fsevents/TSFN teardown hang class; docs/plans/260617_bricked-state-0448-electron42).
 *
 * Load-bearing: this ledger record is written FIRST (before any bounded Sentry
 * flush) so it survives even a process exit where the companion Sentry capture
 * is lost. Keyed by `tier` so the four distinct fallback sites do not collude
 * (and so it stays disjoint from the relaunch-watchdog telemetry, which is
 * about relaunch, not quit-hang).
 */
/**
 * Native-resource liveness snapshot captured synchronously at the macOS
 * quit-deadlock boundary (Stage 1 of
 * docs/plans/260622_pin-quit-deadlock-blocker/PLAN.md). Counts/bools only — no
 * user content. Each field is FAIL-OPEN: `null` means "the accessor threw" and
 * is DISTINCT from a real zero. Correlated across crashes, this NAMES the
 * native subsystem still holding resources at quit so the residual
 * `Worker::JoinThread` blocker can be pinned. Runtime producer:
 * `NativeLivenessSnapshot` in `src/main/services/nativeLivenessSnapshot.ts`.
 */
export interface DiagnosticNativeLivenessSnapshot {
  /** fsevents native instances started-but-not-stopped (the known deadlock culprit). */
  fseventsLiveInstances: number | null;
  /** moonshine onnxruntime InferenceSessions in MAIN (0 or 2) — prime `Worker::JoinThread` suspect. */
  moonshineSessions: number | null;
  /** super-mcp child pid (OS child). A live pid means graceful stop did not complete. */
  superMcpPid: number | null;
  /** Whether the super-mcp child is still running. */
  superMcpRunning: boolean | null;
  /** Per-index open LanceDB connection counts (file index holds 2 when open). */
  lancedbConnections: {
    conversation: number | null;
    file: number | null;
    tool: number | null;
  };
  /** In-main embedding backend flags (heavy holders are out-of-process → weak suspects). */
  embedding: {
    workerAlive: boolean | null;
    gpuBackendAlive: boolean | null;
    disposed: boolean | null;
  };
}

export interface DiagnosticQuitDeadlockDetectedEvent extends DiagnosticEventCommon {
  kind: 'quit_deadlock_detected';
  data: {
    /**
     * Which quit/install fallback fired:
     * - `mac_tier1`: macOS before-quit didn't fire within 3s
     * - `mac_tier2`: macOS app still alive after 8s (force-exit)
     * - `win`: Windows quitAndInstall didn't exit within budget (force-exit)
     * - `graceful_10s`: gracefulShutdownWithStatus hit its 10s race
     */
    tier: 'mac_tier1' | 'mac_tier2' | 'win' | 'graceful_10s';
    platform: 'darwin' | 'win32' | 'linux';
    /**
     * Additive + OPTIONAL native-resource liveness snapshot (260622). Captured
     * at the macOS Tier-1/Tier-2 boundary so the next quit-hang names the
     * live-at-quit native modules. Absent on non-mac tiers and prior-version
     * entries (back-compat).
     */
    nativeLiveness?: DiagnosticNativeLivenessSnapshot;
  };
}

export type SettingsDriftField =
  | 'active_provider'
  | 'cloud_enabled'
  | 'voice_enabled'
  | 'safety_eval_enabled'
  | 'memory_enabled'
  | 'auto_continue_enabled'
  | 'safety_prompt_version'
  | 'turn_model_profile_id';

export interface DiagnosticSettingsDriftEvent extends DiagnosticEventCommon {
  kind: 'settings_drift_observation';
  data: {
    field: SettingsDriftField;
    surfaceA: DiagnosticEventSurface;
    surfaceB: DiagnosticEventSurface;
    diffKind: 'a_set_b_unset' | 'b_set_a_unset' | 'a_b_differ_enum' | 'a_b_differ_typed';
    eventState?: 'observed' | 'resolved';
  };
}

// Keep in sync with `FailureReason` in src/shared/costOutcome.ts.
type DiagnosticFailureReason =
  | 'provider_error'
  | 'network'
  | 'timeout'
  | 'parse_error'
  | 'tool_loop'
  | 'truncated'
  | 'other';

type DiagnosticTurnOutcome =
  | { kind: 'success' }
  | { kind: 'aborted'; reason: AbortReason }
  | { kind: 'quota' }
  | { kind: 'safety_eval_rejected'; stage: 'pre' | 'post' }
  | { kind: 'tool_budget' }
  | { kind: 'failed'; reason: DiagnosticFailureReason }
  | { kind: 'auxiliary_success' }
  | { kind: 'auxiliary_failed'; reason: DiagnosticFailureReason }
  | { kind: 'legacy_unknown' };

export interface DiagnosticCostOutcomeResolutionEvent extends DiagnosticEventCommon {
  kind: 'cost_outcome_resolution';
  data: {
    costEntryId: string;
    ledgerRowTs: number;
    ledgerRowSid?: string;
    ledgerRowTid?: string;
    outcome: DiagnosticTurnOutcome;
  };
}

export interface DiagnosticCostOutcomeResolutionLostEvent extends DiagnosticEventCommon {
  kind: 'cost_outcome_resolution_lost';
  data: {
    costEntryId: string;
    lagMs: number;
    rotationStraddled: boolean;
  };
}

export interface DiagnosticCostOutcomeResolutionUnmatchedEvent extends DiagnosticEventCommon {
  kind: 'cost_outcome_resolution_unmatched';
  data: {
    costEntryId: string;
    outcome: DiagnosticTurnOutcome;
  };
}

/**
 * Continuity breadcrumb mirror emitted when desktop/cloud continuity state,
 * outbox, router, mutex, or merge paths record a Sentry breadcrumb.
 */
export interface DiagnosticContinuityTransitionEvent extends DiagnosticEventCommon {
  kind: 'continuity_transition';
  data: {
    family: ContinuityFamily;
    message: ContinuityMessage;
    reason?: ContinuityReason;
    level?: 'info' | 'warning' | 'error';
    sessionIdHash?: string;
  };
}

export interface DiagnosticEventsPerKindCapEngagedEvent extends DiagnosticEventCommon {
  kind: 'events_per_kind_cap_engaged';
  data: {
    /** The event kind whose process-local counter crossed its cap. */
    kind: DiagnosticEventKind;
    /** Cap value at engagement time. */
    capLimit: number;
    /** Always 0: visible-degradation policy accepts the new write. */
    droppedSinceLastWarning: 0;
  };
}

/**
 * Stage 7 cap: each `runAgentLoop` invocation emits at most this many
 * `tool_call_error` events. Above the cap, we rely on the existing
 * tool_advisory emits to capture systemic failure. Sized so a multi-turn
 * session (10 turns × 200 errors/turn = 2,000 events) stays well below the
 * 5,000-event ledger rotation budget.
 */
export const MAX_TOOL_CALL_ERROR_EMITS_PER_TURN = 200;

/**
 * Discriminator union of all event kinds.
 * Centralizes the list so reducers can switch exhaustively.
 */
export type DiagnosticEventKind = DiagnosticEventEntry['kind'];

const DEFAULT_EVENTS_PER_KIND_CAP = 1_500;

export const MAX_EVENTS_PER_KIND: Record<DiagnosticEventKind, number> = Object.freeze({
  cooldown_enter: DEFAULT_EVENTS_PER_KIND_CAP,
  cooldown_exit: DEFAULT_EVENTS_PER_KIND_CAP,
  tool_advisory: DEFAULT_EVENTS_PER_KIND_CAP,
  known_condition: DEFAULT_EVENTS_PER_KIND_CAP,
  tool_call_error: DEFAULT_EVENTS_PER_KIND_CAP,
  mcp_transition: DEFAULT_EVENTS_PER_KIND_CAP,
  auth_event: DEFAULT_EVENTS_PER_KIND_CAP,
  streaming_invariant: DEFAULT_EVENTS_PER_KIND_CAP,
  abort_event: DEFAULT_EVENTS_PER_KIND_CAP,
  watchdog_judge_decision: DEFAULT_EVENTS_PER_KIND_CAP,
  judge_decision_stale_skip: DEFAULT_EVENTS_PER_KIND_CAP,
  subagent_internal_timeout_recovered: DEFAULT_EVENTS_PER_KIND_CAP,
  approval_stuck: DEFAULT_EVENTS_PER_KIND_CAP,
  health_check_timing: DEFAULT_EVENTS_PER_KIND_CAP,
  provider_reachability_change: DEFAULT_EVENTS_PER_KIND_CAP,
  embedding_index_health: DEFAULT_EVENTS_PER_KIND_CAP,
  worker_stats_pre_turn: DEFAULT_EVENTS_PER_KIND_CAP,
  auto_update_state_change: DEFAULT_EVENTS_PER_KIND_CAP,
  fsevents_leak_sweep: DEFAULT_EVENTS_PER_KIND_CAP,
  quit_deadlock_detected: DEFAULT_EVENTS_PER_KIND_CAP,
  settings_drift_observation: DEFAULT_EVENTS_PER_KIND_CAP,
  cost_outcome_resolution: DEFAULT_EVENTS_PER_KIND_CAP,
  cost_outcome_resolution_lost: DEFAULT_EVENTS_PER_KIND_CAP,
  cost_outcome_resolution_unmatched: DEFAULT_EVENTS_PER_KIND_CAP,
  continuity_transition: 2_000,
  events_per_kind_cap_engaged: DEFAULT_EVENTS_PER_KIND_CAP,
});

/**
 * Default agent guidance text for manifest.json.
 * Provides a recommended workflow for AI agents analyzing the bundle.
 *
 * Two variants: with-logs (the standard bundle) and no-logs (when the
 * bundle was generated with maxTurnLogs=0 and no full/errors-only logs,
 * so logs/* files are absent). The bundle service picks the right one
 * based on whether recent-logs section was actually included.
 */
export const DEFAULT_AGENT_GUIDANCE = `Start with quickStats above. If healthStatus is not 'healthy', examine health.json for failed checks. Then check logs/summary.json for error patterns. Only load logs/main.ndjson if you need full context. For session-specific issues, correlate turnId from logs with recent-sessions/ files.`;

export const DEFAULT_AGENT_GUIDANCE_NO_LOGS = `Start with quickStats above. If healthStatus is not 'healthy', examine health.json for failed checks. This bundle was generated without logs (maxTurnLogs=0), so logs/* files are absent — request a fresh bundle with logs included if log analysis is needed. For session-specific issues, see recent-sessions/ files.`;

/**
 * Available capabilities that can be included in a bundle.
 */
const _DIAGNOSTIC_CAPABILITIES = [
  'health', // SystemHealthReport
  'config', // Settings + MCP config
  'logs', // Main process logs
  'turn-logs', // Per-turn session logs
  'sessions', // Recent session history
  'sentry', // Sentry breadcrumbs
  'chief-of-staff', // System prompt
  'tool-usage', // MCP tool statistics
  'cost-ledger', // API cost tracking
  'automations', // Automation definitions
  'pending-approvals', // Tool approval queue
] as const;

export type DiagnosticCapability = (typeof _DIAGNOSTIC_CAPABILITIES)[number];


// =============================================================================
// Types: Cloud Diagnostics Bundles
// =============================================================================

export type CloudHealthCheckStatus = 'pass' | 'warn' | 'fail' | 'skip';

export interface CloudDiagnosticCheckResult {
  id: string;
  status: CloudHealthCheckStatus;
  message?: string;
  detail?: string;
}

export interface DiagnosticSessionSummary {
  id: string;
  updatedAt: number;
  cloudUpdatedAt?: number;
  maxSeq?: number;
}

export interface CloudSelfDiagnosticsBundle {
  manifest: {
    schemaVersion: number;
    generatedAt: string;
    source: 'cloud';
    app: {
      version: string;
      platform: string;
      nodeVersion: string;
    };
    limits: {
      maxBytes: number;
      rateLimit: string;
    };
    truncated?: {
      originalBytes: number;
      maxBytes: number;
    };
    sections?: Partial<Record<SectionId, SectionState>>;
  };
  health: {
    status: 'healthy' | 'degraded' | 'critical';
    failedChecks: string[];
    warnChecks: string[];
    checkCount: number;
    uptimeSec: number;
  };
  sessionsIndex: {
    count: number;
    totalInHistory: number;
    sessions: CloudSessionIndexEntry[];
  };
  logs: {
    mainNdjson: string;
    lineCount: number;
    truncated?: boolean;
  };
  queueSnapshot?: {
    depth: number;
    lastDrainAt: number;
    lastSeenAt: number;
    lastEscalatedAt: number;
    ageMs: number;
    isStalled: boolean;
  };
  continuityState?: {
    cloudActiveCount: number;
    localOnlyCount: number;
    tombstoneCount: number;
    recentTombstones: Array<{
      sessionIdHash: string;
      deletedAt: number;
      deletedBy: string;
    }>;
  };
  catchUpHistory?: unknown[];
  /**
   * Recent diagnostic-events ledger entries from the cloud surface, oldest-first.
   * Bounded by `MAX_DIAGNOSTIC_EVENTS_BYTES` and elided entirely when empty.
   * Mobile clients read these via /diagnostics/self instead of maintaining a
   * local ledger, since the cloud is the source of truth for remote sessions.
   */
  recentEvents?: DiagnosticEventEntry[];
  /**
   * Cost waterfall aggregated from the cloud-side cost ledger (last 24h),
   * scoped to spend incurred while serving cloud-routed turns. The
   * `surfaceContext: 'cloud'` field signals to consumers (notably mobile,
   * which reads cloud's bundle as its primary cost-visibility surface) that
   * this is cloud-only spend, not the user's combined desktop+cloud total.
   * Elided when the ledger is empty.
   */
  costWaterfall?: {
    surfaceContext: 'cloud';
    waterfall: unknown;
  };
}

export interface CloudLegacyDiagnosticsBundle {
  generatedAt: string;
  version: string;
  uptime: number;
  platform: string;
  nodeVersion: string;
  checks: CloudDiagnosticCheckResult[];
  recentLogs: unknown;
  environment: {
    dataDir: string;
    pushTokenCount: number;
    sessionCount: number;
    diskAvailableMB?: number;
    diskTotalMB?: number;
  };
}

// =============================================================================
// Types: Mobile Diagnostics Bundle
// =============================================================================

export type MobileHealthCheckStatus = 'pass' | 'warn';

export interface MobileDiagnosticsSourceBundle {
  deviceInfo: {
    platform?: string;
    platformVersion?: string;
    appVersion?: string;
    runtimeVersion?: string;
  };
  filteredLogs: string;
  logLineCount: number;
  queueSnapshot?: {
    pendingCount: number;
    processingCount: number;
    countsByType?: Record<string, number>;
    countsByErrorCategory?: Record<string, number>;
    maxAttempts: number;
    oldestAgeMs?: number;
    queueFull: boolean;
    limitedConnectivity: boolean;
    authExpired: boolean;
  };
  continuityState?: {
    connectionState?: string;
    knownSessionCount: number;
    appliedSeqSessionCount: number;
    lastTombstoneSyncAt?: number | null;
  };
  catchUpHistory?: unknown[];
  /**
   * Recent mobile-local diagnostic events (oldest-first), if the on-device
   * buffer at `<documentDirectory>/diagnostic-events/events.jsonl` had any
   * lines. Mobile events have their own simpler shape (NOT
   * `DiagnosticEventEntry`) because mobile uses a different family taxonomy
   * than desktop / cloud — see
   * `mobile/src/storage/diagnosticEventBufferStorage.ts` for the
   * `MobileDiagnosticBufferEvent` schema. These events stay mobile-only and
   * are never uploaded to cloud.
   */
  recentEvents?: readonly Record<string, unknown>[];
}

export interface MobileDiagnosticsBundle {
  manifest: {
    schemaVersion: number;
    generatedAt: string;
    source: 'mobile';
    app: {
      version: string;
      platform: string;
      platformVersion: string;
      runtimeVersion: string;
    };
    sections?: Partial<Record<SectionId, SectionState>>;
  };
  health: {
    status: 'healthy' | 'degraded';
    checks: {
      logCollection: { status: MobileHealthCheckStatus; detail: string };
      outboxQueue: { status: MobileHealthCheckStatus; detail: string };
      continuityConnection: { status: MobileHealthCheckStatus; detail: string };
    };
  };
  sessionsIndex: {
    count: number;
    totalInHistory: number;
    sessions: MobileSessionIndexEntry[];
  };
  logs: {
    mainNdjson: string;
    lineCount: number;
  };
  queueSnapshot?: MobileDiagnosticsSourceBundle['queueSnapshot'];
  continuityState?: MobileDiagnosticsSourceBundle['continuityState'];
  catchUpHistory?: MobileDiagnosticsSourceBundle['catchUpHistory'];
  /** See `MobileDiagnosticsSourceBundle.recentEvents` for shape and rationale. */
  recentEvents?: readonly Record<string, unknown>[];
}

export const CLOUD_SELF_DIAGNOSTICS_MAX_BYTES = 5 * 1024 * 1024;
export const CLOUD_SELF_DIAGNOSTICS_RATE_LIMIT_WINDOW_MS = 60_000;
export const CLOUD_SELF_DIAGNOSTICS_RATE_LIMIT_MAX_HITS = 1;
export const CLOUD_MAX_SESSIONS_IN_SELF_DIAGNOSTICS = 50;
export const CLOUD_MAX_TOMBSTONES_IN_SELF_DIAGNOSTICS = 50;
export const MOBILE_MAX_SESSION_INDEX_ENTRIES = 50;

// Imported structurally from sessionIndexTypes without a runtime import to keep
// manifest.ts as a types/constants-only module.
export interface CloudSessionIndexEntry {
  sessionIdHash: string;
  updatedAt: number;
  cloudUpdatedAt?: number;
  maxSeq?: number;
  continuityState?: 'local_only' | 'cloud_active';
  hasTombstone: boolean;
}

export interface AssembledDesktopBundle {
  manifest: DiagnosticManifest;
  files: Map<string, string>;
  filename: string;
  truncated: boolean;
}

export interface MobileSessionIndexEntry {
  sessionIdHash: string;
  updatedAt: number;
  cloudUpdatedAt?: number;
  /** True when the session is Active (doneAt null/absent). Renamed from `isPinned`. */
  isActive: boolean;
  isDeleted: boolean;
}
