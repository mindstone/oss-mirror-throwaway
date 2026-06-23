/**
 * Diagnostic Events Ledger — public surface (core, platform-agnostic)
 *
 * Append-only JSONL ledger of structured diagnostic events that capture
 * "something broke / transitioned / fired" without storing user content.
 *
 * Why this exists (F2 from the diagnostics overhaul plan):
 *   - Sentry shows aggregated counts, not "what was happening on THIS device when
 *     the user complained at 14:32".
 *   - pino logs have answers but require humans to grep correlated lines.
 *   - We need a small, redaction-safe-by-construction stream of events that
 *     can be read locally (desktop bundle), via cloud (`/diagnostics/self`),
 *     and (eventually) by an in-app debug surface.
 *
 * Architecture:
 *   - Types and the Zod schema live in core (`src/core/services/diagnosticEventsLedger.ts`).
 *   - The actual fs writer lives in main (`src/main/services/diagnosticEventsLedgerWriter.ts`)
 *     and is registered through a small boundary interface so cloud/tests can
 *     install in-memory or no-op implementations.
 *   - `appendDiagnosticEvent(...)` is `safe`: it never throws into the caller.
 *     If no writer is installed (tests / pre-bootstrap), the call is dropped.
 *
 * Redaction-safe-by-construction:
 *   - Schema rejects bare `z.string()` in any `data` payload.
 *   - All free-form fields must be enums / literals / numbers / booleans.
 *   - See `manifest.ts` § DIAGNOSTIC_EVENT_SCHEMA_VERSION rules for the full
 *     contract.
 */

import { z } from 'zod';

import { getTurnContext } from '@core/logger';
import { KNOWN_CONDITIONS, type KnownCondition } from '@core/sentry/knownConditions';
import {
  DIAGNOSTIC_EVENT_SCHEMA_VERSION,
  MAX_EVENTS_PER_KIND,
  type DiagnosticEventEntry,
  type DiagnosticEventSurface,
  type DiagnosticEventKind,
} from './diagnostics/manifest';
import { nativeLivenessSnapshotSchema } from './nativeLivenessSnapshotSchema';
import {
  ContinuityFamilySchema,
  ContinuityMessageSchema,
  ContinuityReasonSchema,
} from '@shared/diagnostics/continuityTransition';
import { ProviderIdSchema, ProbeErrorCodeSchema } from '@shared/diagnostics/providerReachabilitySnapshot';

// -----------------------------------------------------------------------------
// Zod schema
// -----------------------------------------------------------------------------

const SURFACE: z.ZodType<DiagnosticEventSurface> = z.enum(['desktop', 'cloud', 'mobile', 'unknown']);

/**
 * Opaque short identifier (turn id / session id). Branded numeric/hash strings
 * are allowed; arbitrary free-form strings are NOT — this schema only accepts
 * UUID-shaped or short hex/alphanumeric tokens up to 64 chars to keep the
 * "no user content in `data`" invariant from leaking through metadata.
 */
const OPAQUE_ID = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z0-9_-]+$/u, 'opaque ids must be alphanumeric / `_` / `-`');

const COMMON_FIELDS = {
  v: z.number().int().positive(),
  ts: z.number().int().nonnegative(),
  surface: SURFACE,
  tid: OPAQUE_ID.optional(),
  sid: OPAQUE_ID.optional(),
} as const;

export const DIAGNOSTIC_EVENT_KIND_LITERALS = [
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
] as const satisfies readonly DiagnosticEventKind[];

export const DiagnosticEventKindSchema = z.enum(DIAGNOSTIC_EVENT_KIND_LITERALS);

const COOLDOWN_SCOPE = z.enum(['api', 'safety-eval', 'cloud']);

/** SHA-256-truncated-to-16-hex hash. Mirrors `eventHashing.ts` output. */
const HASH16 = z
  .string()
  .regex(/^[a-f0-9]{16}$/u, 'hashed identifiers must be 16 lowercase hex characters');

const cooldownEnter = z.object({
  ...COMMON_FIELDS,
  kind: z.literal('cooldown_enter'),
  data: z
    .object({
      scope: COOLDOWN_SCOPE,
      untilMs: z.number().int().nonnegative(),
      retryAfterProvided: z.boolean(),
      durationMs: z.number().int().nonnegative(),
    })
    .strict(),
});

const cooldownExit = z.object({
  ...COMMON_FIELDS,
  kind: z.literal('cooldown_exit'),
  data: z
    .object({
      scope: COOLDOWN_SCOPE,
      reason: z.enum(['success', 'reset', 'expired']),
    })
    .strict(),
});

const TOOL_ADVISORY_KIND = z.enum([
  'consecutive_error',
  'global_consecutive_error',
  'soft_budget',
  'hard_budget',
]);

const toolAdvisory = z.object({
  ...COMMON_FIELDS,
  kind: z.literal('tool_advisory'),
  data: z
    .object({
      advisory: TOOL_ADVISORY_KIND,
      totalToolCalls: z.number().int().nonnegative(),
    })
    .strict(),
});

const KNOWN_CONDITION_KEYS = Object.keys(KNOWN_CONDITIONS) as readonly KnownCondition[];
const knownConditionKey = z.enum(
  KNOWN_CONDITION_KEYS as unknown as [KnownCondition, ...KnownCondition[]],
);

const knownCondition = z.object({
  ...COMMON_FIELDS,
  kind: z.literal('known_condition'),
  data: z
    .object({
      condition: knownConditionKey,
      level: z.enum(['info', 'warning', 'error']),
    })
    .strict(),
});

const AUTH_PROVIDER = z.enum([
  'google',
  'microsoft',
  'codex',
  'rebel',
  'openrouter',
  'anthropic',
]);

const AUTH_REFRESH_ERROR_CODE = z.enum([
  'invalid_grant',
  'unauthorized_client',
  'invalid_client',
  'invalid_request',
  'invalid_scope',
  'unsupported_grant_type',
  'access_denied',
  'unknown',
]);

const MCP_LIFECYCLE_TRANSITION = z.enum(['connect', 'disconnect', 'restart', 'error']);

const MCP_TRANSITION_REASON = z.enum([
  'debounced-workspace-change',
  'idle-restart',
  'reconfigure',
  'post-resume',
  'circuit-breaker-reset',
  'spawn-error',
  'health-check-timeout',
  'process-exit',
  'circuit-breaker-active',
]);

const STREAMING_INVARIANT_KIND = z.enum([
  'orphan_tool_use',
  'orphan_tool_result',
  'duplicate_tool_id',
  'skeleton_empty_output',
  'skeleton_no_user_text',
  'skeleton_tool_blocks_leaked',
  'content_block_underflow',
  'sse_on_non_streaming',
]);

const toolCallError = z.object({
  ...COMMON_FIELDS,
  kind: z.literal('tool_call_error'),
  data: z
    .object({
      toolNameHash: HASH16,
      isRepeatOfNormalizedSignature: z.boolean(),
      turnCallIndex: z.number().int().positive(),
    })
    .strict(),
});

const mcpTransition = z.object({
  ...COMMON_FIELDS,
  kind: z.literal('mcp_transition'),
  data: z
    .object({
      transition: MCP_LIFECYCLE_TRANSITION,
      reason: MCP_TRANSITION_REASON.optional(),
      serverIdHash: HASH16.optional(),
      restartCount: z.number().int().nonnegative(),
      consecutiveFailures: z.number().int().nonnegative(),
    })
    .strict(),
});

const authEvent = z.object({
  ...COMMON_FIELDS,
  kind: z.literal('auth_event'),
  data: z
    .object({
      transition: z.enum(['refresh_success', 'refresh_failure']),
      provider: AUTH_PROVIDER,
      errorCode: AUTH_REFRESH_ERROR_CODE.optional(),
      needsReconnect: z.boolean(),
      accountSlugHash: HASH16,
    })
    .strict(),
});

const streamingInvariant = z.object({
  ...COMMON_FIELDS,
  kind: z.literal('streaming_invariant'),
  data: z
    .object({
      violation: STREAMING_INVARIANT_KIND,
      occurrenceCount: z.number().int().positive(),
      repaired: z.boolean(),
    })
    .strict(),
});

const ABORT_REASON = z.enum([
  'user_cancel',
  'superseded',
  'watchdog',
  'judge_killed',
  'consecutive_fail_open_cap',
  'tool_cancelled_cap',
  'tool_cancel_unresponsive',
  'tool_repeated_timeout',
  'budget_hard',
  'budget_soft',
  'shutdown',
]);

const ABORT_DURATION_BUCKET = z.union([
  z.literal(1_000),
  z.literal(10_000),
  z.literal(30_000),
  z.literal(120_000),
  z.literal(600_000),
]);

const abortEvent = z.object({
  ...COMMON_FIELDS,
  kind: z.literal('abort_event'),
  data: z
    .object({
      reason: ABORT_REASON,
      durationBucketMs: ABORT_DURATION_BUCKET,
    })
    .strict(),
});

const WATCHDOG_JUDGE_DECISION = z.enum(['extended', 'failed_extended', 'tool_cancelled', 'auto_extended']);
const WATCHDOG_JUDGE_DECISION_REASON = z.enum([
  'auto_extend_first_call_modest_silence',
  'auto_extend_active_subagent_recent_activity',
]);
const WATCHDOG_JUDGE_INJECTION_SUSPICION = z.enum(['none', 'warn', 'override']);
const WATCHDOG_JUDGE_FAILURE_CAUSE = z.enum([
  'timeout',
  'parse_failed',
  'request_failed',
  'malformed_decision',
  // Provider safety classifier refused the judge call (stop_reason: 'refusal').
  // Mirrors WatchdogJudgeFailureCause in watchdogJudge.ts.
  'refusal',
]);
const TOOL_NAME = z
  .string()
  .min(1)
  .max(200)
  .regex(/^[A-Za-z0-9_./:-]+$/u, 'toolName must be a compact tool identifier');

// Allowed extension increments, mirrored from the Stage 2 judge schema.
// Failed-fall-back uses 10 min (JUDGE_FAIL_OPEN_EXTENSION_MS).
const WATCHDOG_JUDGE_ADDITIONAL_MS = z.union([
  z.literal(10 * 60_000),
  z.literal(15 * 60_000),
  z.literal(30 * 60_000),
  z.literal(45 * 60_000),
  z.literal(60 * 60_000),
]);

const watchdogJudgeDecision = z.object({
  ...COMMON_FIELDS,
  kind: z.literal('watchdog_judge_decision'),
  data: z
    .object({
      decision: WATCHDOG_JUDGE_DECISION,
      additionalMs: WATCHDOG_JUDGE_ADDITIONAL_MS.optional(),
      cause: WATCHDOG_JUDGE_FAILURE_CAUSE.optional(),
      reason: WATCHDOG_JUDGE_DECISION_REASON.optional(),
      injectionSuspected: WATCHDOG_JUDGE_INJECTION_SUSPICION.optional(),
      priorExtensionCount: z.number().int().nonnegative(),
      elapsedMs: z.number().int().nonnegative(),
      silentMs: z.number().int().nonnegative(),
      toolName: TOOL_NAME.optional(),
    })
    .strict(),
});

const judgeDecisionStaleSkip = z.object({
  ...COMMON_FIELDS,
  kind: z.literal('judge_decision_stale_skip'),
  data: z
    .object({
      boundToolUseId: OPAQUE_ID,
      decision: z.enum(['kill', 'extend', 'failed_extended']),
    })
    .strict(),
});

const subagentInternalTimeoutRecovered = z.object({
  ...COMMON_FIELDS,
  kind: z.literal('subagent_internal_timeout_recovered'),
  data: z
    .object({
      toolUseId: OPAQUE_ID,
      agentName: TOOL_NAME.optional(),
      elapsedMs: z.number().int().nonnegative(),
      priorTimeoutCount: z.number().int().nonnegative(),
    })
    .strict(),
});

const APPROVAL_KIND = z.enum(['tool', 'memory']);

const APPROVAL_AGE_BUCKET = z.union([
  z.literal(5),
  z.literal(15),
  z.literal(60),
  z.literal(240),
]);

const approvalStuck = z.object({
  ...COMMON_FIELDS,
  kind: z.literal('approval_stuck'),
  data: z
    .object({
      approvalKind: APPROVAL_KIND,
      ageBucketMinutes: APPROVAL_AGE_BUCKET,
      queueDepth: z.number().int().positive(),
    })
    .strict(),
});

const CHECK_STATUS = z.enum(['pass', 'warn', 'fail', 'skip']);

const HEALTH_CHECK_DURATION_BUCKET = z.union([
  z.literal(500),
  z.literal(1000),
  z.literal(5000),
  z.literal(30000),
]);

const healthCheckTiming = z.object({
  ...COMMON_FIELDS,
  kind: z.literal('health_check_timing'),
  data: z
    .object({
      checkIdHash: HASH16,
      durationBucketMs: HEALTH_CHECK_DURATION_BUCKET,
      status: CHECK_STATUS,
      timedOut: z.boolean().optional(),
    })
    .strict(),
});

const providerReachabilityChange = z.object({
  ...COMMON_FIELDS,
  kind: z.literal('provider_reachability_change'),
  data: z
    .object({
      provider: ProviderIdSchema,
      status: z.enum(['reachable', 'unreachable', 'unknown']),
      errorCode: ProbeErrorCodeSchema.optional(),
      latencyMs: z.number().int().nonnegative().optional(),
    })
    .strict(),
});

const embeddingIndexHealth = z.object({
  ...COMMON_FIELDS,
  kind: z.literal('embedding_index_health'),
  data: z
    .object({
      component: z.enum(['embedding_service', 'semantic_index', 'tool_index']),
      transition: z.enum(['ready_to_unready', 'unready_to_ready', 'fresh_to_stale', 'stale_to_fresh']),
      ageBucketHours: z.union([z.literal(1), z.literal(6), z.literal(24), z.literal(168)]).optional(),
    })
    .strict(),
});

const workerStatsPreTurn = z.object({
  ...COMMON_FIELDS,
  kind: z.literal('worker_stats_pre_turn'),
  data: z
    .object({
      since: z.literal('app_start'),
      appStartedAt: z.number().int().nonnegative(),
      spawnCount: z.number().int().nonnegative(),
      restartCount: z.number().int().nonnegative(),
      lastCrashCategory: z.enum(['oom', 'unhandled_exception', 'sigterm', 'unknown']).optional(),
      lastCrashAt: z.number().int().nonnegative().optional(),
      averagePreTurnDurationBucket: z.enum(['<100ms', '<500ms', '<2s', '>=2s']).optional(),
      currentlyRestarting: z.boolean(),
      persistedLastCrashAt: z.number().int().nonnegative().optional(),
      persistedLastCrashCategory: z.enum(['oom', 'unhandled_exception', 'sigterm', 'unknown']).optional(),
      crashesInLast7Days: z.number().int().nonnegative().optional(),
      totalCrashesAllTime: z.number().int().nonnegative().optional(),
    })
    .strict(),
});

const autoUpdateStateChange = z.object({
  ...COMMON_FIELDS,
  kind: z.literal('auto_update_state_change'),
  data: z
    .object({
      transition: z.enum([
        'check_started',
        'check_succeeded',
        'check_failed',
        'install_attempted',
        'install_succeeded',
        'install_failed',
        'native_watcher_cleanup_timeout',
      ]),
      platform: z.enum(['darwin', 'win32', 'linux']),
      errorCategory: z.enum(['network', 'signature', 'permission', 'lock', 'disk', 'parse', 'ssl', 'no-update', 'unknown']).optional(),
      timeoutMs: z.number().int().positive().optional(),
    })
    .strict(),
});

const fseventsLeakSweep = z.object({
  ...COMMON_FIELDS,
  kind: z.literal('fsevents_leak_sweep'),
  data: z
    .object({
      sweptCount: z.number().int().positive(),
      trigger: z.enum(['immediate_exit', 'will_quit_backstop']),
      exitReason: z.string().min(1).max(120).optional(),
    })
    .strict(),
});

/**
 * Native-resource liveness snapshot captured synchronously at the macOS
 * quit-deadlock boundary (Stage 1 of
 * docs/plans/260622_pin-quit-deadlock-blocker/PLAN.md). The strict Zod schema
 * now lives in its own dependency-free module
 * (`./nativeLivenessSnapshotSchema`) so the Sentry known-conditions registry
 * can share the SAME schema without an import cycle. Re-exported here so
 * existing ledger consumers keep their import path. Counts/bools only — no
 * user content; each field fail-open (`null` = accessor threw, distinct from a
 * real zero). Additive + optional so prior-version ledger entries still
 * validate. Runtime producer: `src/main/services/nativeLivenessSnapshot.ts`.
 */
export { nativeLivenessSnapshotSchema };

const quitDeadlockDetected = z.object({
  ...COMMON_FIELDS,
  kind: z.literal('quit_deadlock_detected'),
  data: z
    .object({
      tier: z.enum(['mac_tier1', 'mac_tier2', 'win', 'graceful_10s']),
      platform: z.enum(['darwin', 'win32', 'linux']),
      nativeLiveness: nativeLivenessSnapshotSchema.optional(),
    })
    .strict(),
});

const settingsDriftObservation = z.object({
  ...COMMON_FIELDS,
  kind: z.literal('settings_drift_observation'),
  data: z
    .object({
      field: z.enum([
        'active_provider',
        'cloud_enabled',
        'voice_enabled',
        'safety_eval_enabled',
        'memory_enabled',
        'auto_continue_enabled',
        'safety_prompt_version',
        'turn_model_profile_id',
      ]),
      surfaceA: SURFACE,
      surfaceB: SURFACE,
      diffKind: z.enum(['a_set_b_unset', 'b_set_a_unset', 'a_b_differ_enum', 'a_b_differ_typed']),
      eventState: z.enum(['observed', 'resolved']).optional(),
    })
    .strict(),
});

// Keep in sync with `FailureReason` in src/shared/costOutcome.ts.
const FAILURE_REASON = z.enum([
  'provider_error',
  'network',
  'timeout',
  'parse_error',
  'tool_loop',
  'truncated',
  'other',
]);

const TURN_OUTCOME = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('success') }).strict(),
  z.object({ kind: z.literal('aborted'), reason: ABORT_REASON }).strict(),
  z.object({ kind: z.literal('quota') }).strict(),
  z.object({
    kind: z.literal('safety_eval_rejected'),
    stage: z.enum(['pre', 'post']),
  }).strict(),
  z.object({ kind: z.literal('tool_budget') }).strict(),
  z.object({ kind: z.literal('failed'), reason: FAILURE_REASON }).strict(),
  z.object({ kind: z.literal('auxiliary_success') }).strict(),
  z.object({ kind: z.literal('auxiliary_failed'), reason: FAILURE_REASON }).strict(),
  z.object({ kind: z.literal('legacy_unknown') }).strict(),
]);

const costOutcomeResolution = z.object({
  ...COMMON_FIELDS,
  kind: z.literal('cost_outcome_resolution'),
  data: z
    .object({
      costEntryId: OPAQUE_ID,
      ledgerRowTs: z.number().int().nonnegative(),
      ledgerRowSid: OPAQUE_ID.optional(),
      ledgerRowTid: OPAQUE_ID.optional(),
      outcome: TURN_OUTCOME,
    })
    .strict(),
});

const costOutcomeResolutionLost = z.object({
  ...COMMON_FIELDS,
  kind: z.literal('cost_outcome_resolution_lost'),
  data: z
    .object({
      costEntryId: OPAQUE_ID,
      lagMs: z.number().int().nonnegative(),
      rotationStraddled: z.boolean(),
    })
    .strict(),
});

const costOutcomeResolutionUnmatched = z.object({
  ...COMMON_FIELDS,
  kind: z.literal('cost_outcome_resolution_unmatched'),
  data: z
    .object({
      costEntryId: OPAQUE_ID,
      outcome: TURN_OUTCOME,
    })
    .strict(),
});

const continuityTransition = z.object({
  ...COMMON_FIELDS,
  kind: z.literal('continuity_transition'),
  data: z
    .object({
      family: ContinuityFamilySchema,
      message: ContinuityMessageSchema,
      reason: ContinuityReasonSchema.optional(),
      level: z.enum(['info', 'warning', 'error']).optional(),
      sessionIdHash: OPAQUE_ID.optional(),
    })
    .strict(),
});

const eventsPerKindCapEngaged = z.object({
  ...COMMON_FIELDS,
  kind: z.literal('events_per_kind_cap_engaged'),
  data: z
    .object({
      kind: DiagnosticEventKindSchema,
      capLimit: z.number().int().positive(),
      droppedSinceLastWarning: z.literal(0),
    })
    .strict(),
});

export const diagnosticEventEntrySchema: z.ZodType<DiagnosticEventEntry> = z.discriminatedUnion(
  'kind',
  [
    cooldownEnter,
    cooldownExit,
    toolAdvisory,
    knownCondition,
    toolCallError,
    mcpTransition,
    authEvent,
    streamingInvariant,
    abortEvent,
    watchdogJudgeDecision,
    judgeDecisionStaleSkip,
    subagentInternalTimeoutRecovered,
    approvalStuck,
    healthCheckTiming,
    providerReachabilityChange,
    embeddingIndexHealth,
    workerStatsPreTurn,
    autoUpdateStateChange,
    fseventsLeakSweep,
    quitDeadlockDetected,
    settingsDriftObservation,
    costOutcomeResolution,
    costOutcomeResolutionLost,
    costOutcomeResolutionUnmatched,
    continuityTransition,
    eventsPerKindCapEngaged,
  ],
);

// -----------------------------------------------------------------------------
// Boundary: writer & reader interfaces
// -----------------------------------------------------------------------------

/**
 * Surface-specific implementation for actually persisting events.
 * Desktop wires this to the main-process fs writer in
 * `src/main/services/diagnosticEventsLedgerWriter.ts`.
 *
 * `append` MUST NOT throw; on internal failure it should swallow and log
 * via pino. The core caller (`appendDiagnosticEvent`) wraps everything in
 * try/catch as belt-and-suspenders, but writers should not rely on that.
 *
 * `flush` is optional and is invoked by the bundle reader before reading
 * `events.jsonl` so that recently-queued events show up in bug reports
 * generated immediately after a failure (Stage 1.6 amendment A9).
 */
export interface DiagnosticEventsLedgerWriter {
  append(entry: DiagnosticEventEntry): void;
  flush?(): Promise<void>;
}

export interface DiagnosticEventsLedgerReader {
  /**
   * Read the most recent entries from the ledger, oldest-first.
   * Caps total bytes streamed at `maxBytes`.
   */
  readRecent(options: { limit: number; maxBytes: number }): Promise<DiagnosticEventEntry[]>;
}

let writer: DiagnosticEventsLedgerWriter | null = null;
let reader: DiagnosticEventsLedgerReader | null = null;
let currentSurface: DiagnosticEventSurface = 'unknown';

// Per-kind sliding-window (monotonic, process-local) counter for the
// MAX_EVENTS_PER_KIND ceiling. Engagement is observable per session;
// the FS-layer rotation handles disk capacity separately.
const perKindCounter = new Map<DiagnosticEventKind, number>();
const engagedKinds = new Set<DiagnosticEventKind>();
let inCapEngagedEmit = false;

function trackEmitForCap(kind: DiagnosticEventKind): { warnEngaged: boolean; capLimit: number } {
  const count = (perKindCounter.get(kind) ?? 0) + 1;
  perKindCounter.set(kind, count);
  const capLimit = MAX_EVENTS_PER_KIND[kind] ?? 1_500;
  if (count > capLimit && !engagedKinds.has(kind)) {
    engagedKinds.add(kind);
    return { warnEngaged: true, capLimit };
  }
  return { warnEngaged: false, capLimit };
}

function resetPerKindCapForTests(): void {
  perKindCounter.clear();
  engagedKinds.clear();
  inCapEngagedEmit = false;
}

export function setDiagnosticEventsLedgerWriter(impl: DiagnosticEventsLedgerWriter | null): void {
  writer = impl;
}

export function setDiagnosticEventsLedgerReader(impl: DiagnosticEventsLedgerReader | null): void {
  reader = impl;
}

export function setDiagnosticEventsSurface(surface: DiagnosticEventSurface): void {
  currentSurface = surface;
}

export function getDiagnosticEventsLedgerReader(): DiagnosticEventsLedgerReader | null {
  return reader;
}

// -----------------------------------------------------------------------------
// Public emit API (safe-by-construction)
// -----------------------------------------------------------------------------

/**
 * Lightweight emitter input — callers don't have to set `v`, `ts`, or `surface`.
 * They are filled in by `appendDiagnosticEvent`.
 */
type EmitInputOf<K extends DiagnosticEventEntry['kind']> = Omit<
  Extract<DiagnosticEventEntry, { kind: K }>,
  'v' | 'ts' | 'surface'
> & {
  ts?: number;
  surface?: DiagnosticEventSurface;
};

export type DiagnosticEventEmitInput =
  | EmitInputOf<'cooldown_enter'>
  | EmitInputOf<'cooldown_exit'>
  | EmitInputOf<'tool_advisory'>
  | EmitInputOf<'known_condition'>
  | EmitInputOf<'tool_call_error'>
  | EmitInputOf<'mcp_transition'>
  | EmitInputOf<'auth_event'>
  | EmitInputOf<'streaming_invariant'>
  | EmitInputOf<'abort_event'>
  | EmitInputOf<'watchdog_judge_decision'>
  | EmitInputOf<'judge_decision_stale_skip'>
  | EmitInputOf<'subagent_internal_timeout_recovered'>
  | EmitInputOf<'approval_stuck'>
  | EmitInputOf<'health_check_timing'>
  | EmitInputOf<'provider_reachability_change'>
  | EmitInputOf<'embedding_index_health'>
  | EmitInputOf<'worker_stats_pre_turn'>
  | EmitInputOf<'auto_update_state_change'>
  | EmitInputOf<'fsevents_leak_sweep'>
  | EmitInputOf<'quit_deadlock_detected'>
  | EmitInputOf<'settings_drift_observation'>
  | EmitInputOf<'cost_outcome_resolution'>
  | EmitInputOf<'cost_outcome_resolution_lost'>
  | EmitInputOf<'cost_outcome_resolution_unmatched'>
  | EmitInputOf<'continuity_transition'>
  | EmitInputOf<'events_per_kind_cap_engaged'>;

/**
 * Append a diagnostic event. Safe-by-construction:
 *   - Callers never get a thrown exception out of this function.
 *   - Validation failures, schema mismatches, missing writer, fs errors —
 *     all are swallowed and logged at the writer level.
 *   - Returns silently if no writer is installed (e.g., in tests, pre-bootstrap).
 *
 * For supported event kinds and required `data` fields, see
 * `DiagnosticEventEntry` in `diagnostics/manifest.ts`.
 */
export function appendDiagnosticEvent(input: DiagnosticEventEmitInput): void {
  try {
    if (!writer) return;

    // Auto-stamp tid/sid from the AsyncLocalStorage turn context. Caller-supplied
    // ids (rare; primarily test fixtures) win. Cooldown / auth / MCP-lifecycle
    // emits commonly run outside `runWithTurnContext()` and will simply have no
    // tid/sid — that's the correct shape for background events.
    const ctx = getTurnContext();
    const inputAny = input as DiagnosticEventEmitInput & { tid?: string; sid?: string };
    const autoStamp: { tid?: string; sid?: string } = {};
    if (ctx?.turnId && !inputAny.tid) autoStamp.tid = ctx.turnId;
    if (ctx?.sessionId && !inputAny.sid) autoStamp.sid = ctx.sessionId;

    const entry = {
      v: DIAGNOSTIC_EVENT_SCHEMA_VERSION,
      ts: input.ts ?? Date.now(),
      surface: input.surface ?? currentSurface,
      ...autoStamp,
      ...input,
    } as DiagnosticEventEntry;

    const parsed = diagnosticEventEntrySchema.safeParse(entry);
    if (!parsed.success) {
      // Validation failures are expected to be rare and indicate a programmer
      // error, not a user-data leak — drop silently and rely on the Vitest
      // guard test to catch schema drift in CI.
      return;
    }

    const { warnEngaged, capLimit } = trackEmitForCap(parsed.data.kind);
    if (warnEngaged && !inCapEngagedEmit) {
      inCapEngagedEmit = true;
      try {
        appendDiagnosticEvent({
          kind: 'events_per_kind_cap_engaged',
          data: { kind: parsed.data.kind, capLimit, droppedSinceLastWarning: 0 },
        });
      } finally {
        inCapEngagedEmit = false;
      }
    }
    writer.append(parsed.data);
  } catch {
    // Belt-and-suspenders: emitters must never throw into the caller.
  }
}

/**
 * Best-effort flush of any queued events. Used by the diagnostic-bundle reader
 * (Stage 1.6 amendment A9) so that bundles generated immediately after a
 * failure include the most recent emits even when the writer has not yet
 * flushed its 50ms batch timer.
 *
 * Never throws into the caller. No-op when no writer is registered or when
 * the registered writer doesn't implement `flush`.
 */
export async function flushDiagnosticEventsLedger(): Promise<void> {
  try {
    await writer?.flush?.();
  } catch {
    // Belt-and-suspenders: bundle assembly must not fail because flush failed.
  }
}

/**
 * Test-only: clear all installed writers/readers and surface state.
 */
export function resetDiagnosticEventsLedgerForTests(): void {
  writer = null;
  reader = null;
  currentSurface = 'unknown';
  resetPerKindCapForTests();
}

// Re-export the union kind so consumers don't have to dig into manifest.ts.
export type { DiagnosticEventKind };
