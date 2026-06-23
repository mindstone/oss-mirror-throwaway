import { z } from 'zod';

import { nativeLivenessSnapshotSchema } from '@core/services/nativeLivenessSnapshotSchema';

export type KnownCondition =
  | 'model_error'
  | 'codex_disconnected_bts'
  | 'runtime_activity_mapper_failure'
  | 'cloud_outbox_stuck'
  | 'bts_profile_missing'
  | 'bts_summary_failure'
  | 'bts_quip_failure'
  | 'bts_warmup_failure'
  | 'bridge_recent_events_failure'
  | 'bridge_recent_logs_failure'
  | 'bridge_log_file_paths_failure'
  | 'pass_through_redaction_policy'
  | 'providers_reachability_recovered'
  | 'conversation_title_unavailable'
  | 'time_saved_unavailable'
  | 'codex_auth_destructive_disconnect'
  | 'bts_structured_output_fallback'
  | 'recovery_tool_input_too_large'
  | 'recovery_managed_model_not_allowed'
  | 'recovery_billing_quota'
  | 'recovery_empty_result_anomaly'
  | 'recovery_pause_detection_missed'
  | 'recovery_unknown_error'
  | 'recovery_pipeline_summary_generation_failed'
  | 'recovery_pipeline_agent_loop_error_before_recovery'
  | 'recovery_pipeline_agent_loop_error_after_recovery'
  | 'recovery_pipeline_long_context_fallback_failed'
  | 'recovery_pipeline_depth_limit_reached'
  | 'recovery_pipeline_attempt_limit_reached'
  | 'recovery_pipeline_no_qualifying_profile'
  | 'recovery_pipeline_rate_limited'
  | 'recovery_pipeline_no_messages_to_compact'
  | 'agent_watchdog_self_resolved'
  | 'agent_watchdog_stalled'
  | 'agent_watchdog_auto_abort'
  | 'all_providers_unreachable'
  | 'cloud_connection_degraded'
  | 'cloud_connection_degraded_escalated'
  | 'cloud_connection_recovered'
  | 'microsoft_oauth_no_pending_callback'
  | 'cloud_sync_boot_rehab_summary'
  | 'cloud_sync_tombstone_applied'
  | 'cloud_pressure_capability_missing'
  | 'fd_pressure_elevated'
  | 'fd_pressure_critical'
  | 'sentry_oversized_event_detected'
  | 'cloud_self_update_credentials_missing'
  | 'codex_proxy_claude_leak'
  | 'codex_proxy_unsupported_model'
  | 'quit_deadlock_detected'
  | 'update_external_force_kill_fired'
  | 'file_index_fts_degraded'
  | 'file_index_semantic_search_failed'
  | 'route_tag_gate_model_mismatch'
  | 'route_facts_binding_mismatch'
  | 'session_index_collapse_detected'
  | 'corrupt_session_file_skipped';

type FingerprintResolver<TContext> = {
  bivarianceHack(context: TContext): readonly string[];
}['bivarianceHack'];

/**
 * Sink policy for `level: 'info'` conditions (Stage 4 of
 * docs/plans/260610_improve-sentry-noise/PLAN.md):
 *
 * - `'ledger-only'` — telemetry. `captureKnownCondition` skips the Sentry
 *   capture entirely; the on-device diagnostic-events ledger (which records
 *   `{condition, level}` ONLY — extras are NOT persisted) is the sink, plus a
 *   breadcrumb that rides on the next real Sentry event. The condition never
 *   creates issue-stream volume.
 * - `'issue-stream'` — an explicit, reviewed declaration that this info-level
 *   condition still needs fleet-level Sentry visibility (e.g. it carries
 *   diagnostically-valuable extras with no other fleet sink).
 *
 * The discriminated union below makes an info entry WITHOUT a sink
 * adjudication fail to compile, and forbids `sink` on warning/error entries
 * (their Sentry delivery is implied — warnings are sweep-visible, errors
 * page).
 */
export type ConditionSink = 'ledger-only' | 'issue-stream';

interface ConditionMetaBase<TContext = unknown> {
  readonly owner: string;
  readonly description: string;
  readonly fingerprint: readonly string[] | FingerprintResolver<TContext>;
  readonly addedAt: string;
  readonly expectedDegraded?: { readonly until: string; readonly reason: string };
  readonly deprecatedAt?: string;
  readonly removableAfter?: string;
  readonly contextSchema?: z.ZodSchema<TContext>;
  readonly dedupeAdvisory?: string;
}

export type ConditionMeta<TContext = unknown> =
  | (ConditionMetaBase<TContext> & {
      readonly level: 'info';
      /** REQUIRED for info entries — see {@link ConditionSink}. */
      readonly sink: ConditionSink;
    })
  | (ConditionMetaBase<TContext> & {
      readonly level: 'warning' | 'error';
      readonly sink?: never;
    });

const ISO8601_Z_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;
const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

function assertStrictIso8601Z(value: string, fieldPath: string): void {
  if (!ISO8601_Z_PATTERN.test(value)) {
    throw new Error(`${fieldPath} must be a strict ISO8601 UTC timestamp with Z suffix`);
  }

  const timestamp = Date.parse(value);
  if (Number.isNaN(timestamp)) {
    throw new Error(`${fieldPath} must be a valid ISO8601 UTC timestamp`);
  }

  const canonical = new Date(timestamp).toISOString();
  const normalizedInput = value.includes('.') ? value : value.replace('Z', '.000Z');
  if (canonical !== normalizedInput) {
    throw new Error(`${fieldPath} must be a canonical ISO8601 UTC timestamp`);
  }
}

function addThirtyDays(value: string): string {
  const derived = new Date(Date.parse(value) + THIRTY_DAYS_MS).toISOString();
  return derived.endsWith('.000Z') ? derived.replace('.000Z', 'Z') : derived;
}

export function defineKnownConditions<const T extends Record<KnownCondition, ConditionMeta>>(
  input: T,
): T {
  const output = { ...input };

  for (const condition of Object.keys(output) as KnownCondition[]) {
    const meta = output[condition];
    assertStrictIso8601Z(meta.addedAt, `${condition}.addedAt`);

    if (meta.expectedDegraded) {
      assertStrictIso8601Z(meta.expectedDegraded.until, `${condition}.expectedDegraded.until`);
    }

    if (meta.deprecatedAt) {
      assertStrictIso8601Z(meta.deprecatedAt, `${condition}.deprecatedAt`);

      const removableAfter = meta.removableAfter ?? addThirtyDays(meta.deprecatedAt);
      assertStrictIso8601Z(removableAfter, `${condition}.removableAfter`);

      if (!meta.removableAfter) {
        output[condition] = {
          ...meta,
          removableAfter,
        };
      }
    } else if (meta.removableAfter) {
      assertStrictIso8601Z(meta.removableAfter, `${condition}.removableAfter`);
    }
  }

  return output;
}

export const KNOWN_CONDITIONS = defineKnownConditions({
  model_error: {
    owner: '@core',
    description: 'Wrapped LLM provider failure in turnErrorRecovery',
    fingerprint: (ctx: { kind: string; provider?: string; upstreamProvider?: string }) => [
      'model-error',
      ctx.kind,
      ctx.provider ?? 'unknown',
      ctx.upstreamProvider ?? 'none',
    ],
    level: 'warning',
    addedAt: '2026-05-03T00:00:00Z',
    contextSchema: z.object({
      kind: z.string(),
      provider: z.string().optional(),
      upstreamProvider: z.string().optional(),
    }),
  },
  codex_disconnected_bts: {
    owner: '@bts',
    description:
      'CodexDisconnectedBtsError — provider disconnect during BTS turn. Ledger-only since Stage 4 (260610 improve-sentry-noise): the historical error-level storms (REBEL-4Z6, 13.8k ev/1 user) are old builds; the current info variant is dedup-capped expected-degradation telemetry.',
    fingerprint: ['codex-disconnected-bts'],
    level: 'info',
    sink: 'ledger-only',
    addedAt: '2026-05-03T00:00:00Z',
    dedupeAdvisory: 'caller-side per-session + 5-min unscoped time-window via shouldCaptureCodexBtsDisconnect',
  },
  codex_auth_destructive_disconnect: {
    owner: '@core',
    description:
      'Codex auth disconnected due to a destructive token-state cause (refresh auth failure, malformed refresh response, corrupt-read destructive delete, or sync-null deletion guard attempt).',
    fingerprint: (ctx: {
      cause: 'refresh_auth_failure' | 'refresh_malformed_response' | 'corrupt_read' | 'sync_null_deletion_attempted';
      source:
        | 'codex_auth_core'
        | 'codex_sync_channel'
        | 'codex_sync_route'
        | 'secure_token_store'
        | 'cloud_router_sync_guard';
      surface: 'desktop' | 'cloud' | 'mobile' | 'unknown';
    }) => [
      'codex-auth-destructive-disconnect',
      ctx.cause,
      ctx.source,
      ctx.surface,
    ],
    level: 'warning',
    addedAt: '2026-06-11T00:00:00Z',
    contextSchema: z.object({
      cause: z.enum([
        'refresh_auth_failure',
        'refresh_malformed_response',
        'corrupt_read',
        'sync_null_deletion_attempted',
      ]),
      source: z.enum([
        'codex_auth_core',
        'codex_sync_channel',
        'codex_sync_route',
        'secure_token_store',
        'cloud_router_sync_guard',
      ]),
      surface: z.enum(['desktop', 'cloud', 'mobile', 'unknown']),
      httpStatus: z.number().int().optional(),
    }),
  },
  runtime_activity_mapper_failure: {
    owner: '@core',
    description: 'RuntimeActivityEvent mapper failure (S7 placeholder)',
    fingerprint: ['runtime-activity-mapper-failure'],
    level: 'error',
    addedAt: '2026-05-03T00:00:00Z',
  },
  cloud_outbox_stuck: {
    owner: '@cloud',
    description:
      'Cloud session outbox failed to drain after stall threshold; recoverable via throttled retry in outboxStallMonitor',
    fingerprint: ['cloud-outbox-stuck'],
    level: 'warning',
    addedAt: '2026-05-03T00:00:00Z',
  },
  bts_profile_missing: {
    owner: '@core',
    description:
      'BTS routing input referenced a profile that is missing/disabled/incomplete; sanitized and degraded to role default',
    fingerprint: (ctx: { role: string; profileState: string; missingProfileId: string }) => [
      'bts-profile-missing',
      ctx.role,
      ctx.profileState,
    ],
    level: 'warning',
    addedAt: '2026-05-18T00:00:00.000Z',
    contextSchema: z.object({
      role: z.string(),
      profileState: z.enum(['missing', 'disabled', 'incomplete', 'empty-id']),
      missingProfileId: z.string(),
    }),
  },
  bts_summary_failure: {
    owner: '@bts',
    description:
      'Behind-the-scenes conversation-summary generation failed (conversationSummaryService catch). Previously silent in Sentry.',
    fingerprint: ['bts-summary-failure'],
    level: 'warning',
    addedAt: '2026-05-05T00:00:00Z',
  },
  bts_quip_failure: {
    owner: '@bts',
    description:
      'Behind-the-scenes quip-generation failed (quipGeneratorService catch). User-experience polish only — info level, ledger-only since Stage 4 (260610 improve-sentry-noise).',
    fingerprint: ['bts-quip-failure'],
    level: 'info',
    sink: 'ledger-only',
    addedAt: '2026-05-05T00:00:00Z',
  },
  bts_warmup_failure: {
    owner: '@bts',
    description:
      'Behind-the-scenes prompt-cache warmup failed (promptCacheWarmupService catch). Slows next turn but recoverable.',
    fingerprint: ['bts-warmup-failure'],
    level: 'warning',
    addedAt: '2026-05-05T00:00:00Z',
  },
  bridge_recent_events_failure: {
    owner: '@main',
    description: 'Bundled inbox bridge failed to read or format recent diagnostic events.',
    fingerprint: ['bridge-recent-events-failure'],
    level: 'warning',
    addedAt: '2026-05-06T00:00:00Z',
  },
  bridge_recent_logs_failure: {
    owner: '@main',
    description: 'Bundled inbox bridge failed to read recent raw application log lines.',
    fingerprint: ['bridge-recent-logs-failure'],
    level: 'warning',
    addedAt: '2026-05-06T00:00:00Z',
  },
  bridge_log_file_paths_failure: {
    owner: '@main',
    description: 'Bundled inbox bridge failed to read recent log file metadata.',
    fingerprint: ['bridge-log-file-paths-failure'],
    level: 'warning',
    addedAt: '2026-05-06T00:00:00Z',
  },
  pass_through_redaction_policy: {
    owner: '@main',
    description:
      'Raw recent-log pass-through policy acknowledged for diagnostics; revisit after any secret-leak incident. Ledger-only since Stage 4 (260610 improve-sentry-noise): once-per-process acknowledgment whose context is all literal constants — the registry entry itself is the durable record.',
    fingerprint: ['pass-through-redaction-policy'],
    level: 'info',
    sink: 'ledger-only',
    addedAt: '2026-05-06T00:00:00Z',
    contextSchema: z.object({
      policy: z.literal('raw-pass-through'),
      userOverride: z.literal(true),
      revisitTrigger: z.literal('secret-leak-incident'),
    }),
  },
  conversation_title_unavailable: {
    owner: '@core',
    description:
      'Auto-title generation returned null on the second (retry) attempt. Falls back to "New conversation" silently — recovery is observable via Recent Activity only. Ledger-only since Stage 4 (260610 improve-sentry-noise).',
    fingerprint: ['conversation-title-unavailable'],
    level: 'info',
    sink: 'ledger-only',
    addedAt: '2026-05-11T00:00:00Z',
  },
  time_saved_unavailable: {
    owner: '@core',
    description:
      'Time-saved estimation failed (caught exception, non-JSON model response, or invalid estimate). The TimeSavedSummary card silently does not render — recovery is observable via Recent Activity only. Ledger-only since Stage 4 (260610 improve-sentry-noise; was REBEL-5K3, 2.4k ev/14d).',
    fingerprint: ['time-saved-unavailable'],
    level: 'info',
    sink: 'ledger-only',
    addedAt: '2026-05-11T00:00:00Z',
  },
  bts_structured_output_fallback: {
    owner: '@bts',
    description:
      'Behind-the-scenes structured-output call fell back to the default auxiliary model (JSON-capability error or parse failure). Auto-recovery — surfaced for diagnostic-bundle observability only. Ledger-only since Stage 4 (260610 improve-sentry-noise; was REBEL-5PN, 6.8k ev/14d of pure fallback telemetry).',
    fingerprint: ['bts-structured-output-fallback'],
    level: 'info',
    sink: 'ledger-only',
    addedAt: '2026-05-11T00:00:00Z',
  },
  recovery_tool_input_too_large: {
    owner: '@core',
    description:
      'Recovery dispatcher: tool call input bytes exceeded the size cap; user-facing card emitted with size guidance. Non-retryable.',
    fingerprint: (ctx: { toolName: string; possiblyMutated: boolean }) => [
      'recovery-tool-input-too-large',
      ctx.toolName,
      ctx.possiblyMutated ? 'mutated' : 'pristine',
    ],
    level: 'warning',
    addedAt: '2026-05-26T00:00:00Z',
    contextSchema: z.object({
      toolName: z.string(),
      possiblyMutated: z.boolean(),
    }),
  },
  recovery_managed_model_not_allowed: {
    owner: '@core',
    description:
      'Recovery dispatcher: managed-plan policy denied the requested model. User can retry with an allowed model from the surfaced list.',
    fingerprint: (ctx: { provider: string }) => [
      'recovery-managed-model-not-allowed',
      ctx.provider,
    ],
    level: 'warning',
    addedAt: '2026-05-26T00:00:00Z',
    contextSchema: z.object({
      provider: z.string(),
    }),
  },
  recovery_billing_quota: {
    owner: '@core',
    description:
      'Recovery dispatcher: billing/quota failure (e.g. 429 insufficient_quota). Non-retryable; surfaces a specific user-facing card.',
    fingerprint: (ctx: { provider: string }) => [
      'recovery-billing-quota',
      ctx.provider,
    ],
    level: 'warning',
    addedAt: '2026-05-26T00:00:00Z',
    contextSchema: z.object({
      provider: z.string(),
    }),
  },
  recovery_empty_result_anomaly: {
    owner: '@core',
    description:
      'Recovery dispatcher: SDK reported zero text + zero tool calls; classified for recovery strategy. Sub-classifications track which recovery branch fired.',
    fingerprint: (ctx: { classification: string }) => [
      'recovery-empty-result-anomaly',
      ctx.classification,
    ],
    level: 'warning',
    addedAt: '2026-05-26T00:00:00Z',
    contextSchema: z.object({
      classification: z.enum([
        'text_recovery',
        'tool_recovery',
        'zero_output_no_recovery',
        'retry_failed_no_recovery',
        // Provider safety classifier refused the request (stop_reason:
        // 'refusal', e.g. Fable 5) — auto-retry skipped, honest refusal
        // message shown instead of "try asking again".
        'refusal',
      ]),
    }),
    dedupeAdvisory:
      '5 classifications today — keep separate fingerprints to track recovery effectiveness per kind',
  },
  recovery_pause_detection_missed: {
    owner: '@core',
    description:
      'Recovery dispatcher: empty_result_anomaly fired while user-question-pending was set; pause-detection regression suspected (260420 Stage 1 missed signal).',
    fingerprint: ['recovery-pause-detection-missed'],
    level: 'warning',
    addedAt: '2026-05-26T00:00:00Z',
  },
  recovery_unknown_error: {
    owner: '@core',
    description:
      'Recovery dispatcher: error reached the generic non-ModelError fallthrough without matching any classified handler. Symptomatic of classifier coverage gap (cluster 1 — see Stage 4 ErrorClassification).',
    fingerprint: ['recovery-unknown-error'],
    level: 'error',
    addedAt: '2026-05-26T00:00:00Z',
  },
  recovery_pipeline_summary_generation_failed: {
    owner: '@core',
    description:
      'Recovery pipeline: genuine empty-skeleton failure (skeleton stripping produced no messages) + the defensive unhandled `idle`/`skeleton` state. RESERVED for these two cases only — post-recovery agent-loop errors now route to `recovery_pipeline_agent_loop_error_after_recovery` (REBEL-5BM re-label). Stable, registry-owned fingerprint.',
    fingerprint: (ctx: { phase: 'pre_activity' | 'post_activity' }) => [
      'recovery-pipeline-summary-generation-failed',
      ctx.phase,
    ],
    level: 'warning',
    addedAt: '2026-05-27T00:00:00Z',
    contextSchema: z.object({
      phase: z.enum(['pre_activity', 'post_activity']),
    }),
  },
  recovery_pipeline_agent_loop_error_after_recovery: {
    owner: '@core',
    description:
      'Recovery pipeline: compaction/summary succeeded and recovery had already started, but a subsequent agent-loop call failed with a non-overflow error (provider/auth/rate-limit/stream error on a post-recovery attempt, including the depth-4 recovery model\'s own loop error). Previously mislabelled `summary_generation_failed`; split out for REBEL-5BM so the underlying error is no longer hidden behind a compaction-failure label. Carries the threaded error string + errorKind/provider/rawError in `extra`.',
    fingerprint: (ctx: { phase: 'pre_activity' | 'post_activity' }) => [
      'recovery-pipeline-agent-loop-error-after-recovery',
      ctx.phase,
    ],
    level: 'warning',
    addedAt: '2026-05-31T00:00:00Z',
    contextSchema: z.object({
      phase: z.enum(['pre_activity', 'post_activity']),
    }),
  },
  recovery_pipeline_agent_loop_error_before_recovery: {
    owner: '@core',
    description:
      'Recovery pipeline: the first agent-loop call failed with a non-overflow error before recovery had a chance to engage. Stage 5b — stable, registry-owned fingerprint replaces raw `captureException`.',
    fingerprint: (ctx: { phase: 'pre_activity' | 'post_activity' }) => [
      'recovery-pipeline-agent-loop-error-before-recovery',
      ctx.phase,
    ],
    level: 'warning',
    addedAt: '2026-05-27T00:00:00Z',
    contextSchema: z.object({
      phase: z.enum(['pre_activity', 'post_activity']),
    }),
  },
  recovery_pipeline_long_context_fallback_failed: {
    owner: '@core',
    description:
      'Recovery pipeline: a long-context fallback attempt errored with a non-overflow failure. Pre-fix this surfaced as `summary_generation_failed`; post-fix it is correctly labelled. Re-leveled info→warning in Stage 4 (260610 improve-sentry-noise): the capture only fires on TERMINAL failure (captureExhaustion via dispatchFailure — when depth-4 escalation did NOT rescue the turn), it is in the REBEL-5BM real-defect family, and it carries errorKind/provider/rawError extras — same shape and level as its terminal recovery_pipeline_* siblings. The original "info because depth-4 may still recover" rationale described the state-machine transition, not the capture site.',
    fingerprint: (ctx: { phase: 'pre_activity' | 'post_activity' }) => [
      'recovery-pipeline-long-context-fallback-failed',
      ctx.phase,
    ],
    level: 'warning',
    addedAt: '2026-05-27T00:00:00Z',
    contextSchema: z.object({
      phase: z.enum(['pre_activity', 'post_activity']),
    }),
  },
  recovery_pipeline_depth_limit_reached: {
    owner: '@core',
    description:
      'Recovery pipeline: every compaction depth and the depth-4 recovery model exhausted (or depth-4 already attempted). Stage 5b — stable, registry-owned fingerprint replaces raw `captureException`.',
    fingerprint: (ctx: { phase: 'pre_activity' | 'post_activity' }) => [
      'recovery-pipeline-depth-limit-reached',
      ctx.phase,
    ],
    level: 'warning',
    addedAt: '2026-05-27T00:00:00Z',
    contextSchema: z.object({
      phase: z.enum(['pre_activity', 'post_activity']),
    }),
  },
  recovery_pipeline_attempt_limit_reached: {
    owner: '@core',
    description:
      'Recovery pipeline: per-depth attempt budget exhausted before reaching depth-4. Stage 5b — stable, registry-owned fingerprint replaces raw `captureException`.',
    fingerprint: (ctx: { phase: 'pre_activity' | 'post_activity' }) => [
      'recovery-pipeline-attempt-limit-reached',
      ctx.phase,
    ],
    level: 'warning',
    addedAt: '2026-05-27T00:00:00Z',
    contextSchema: z.object({
      phase: z.enum(['pre_activity', 'post_activity']),
    }),
  },
  recovery_pipeline_no_qualifying_profile: {
    owner: '@core',
    description:
      'Recovery pipeline: no recovery profile satisfies the `supportsLargeContext` requirement at depth-4. Stage 5b — stable, registry-owned fingerprint replaces raw `captureException`.',
    fingerprint: (ctx: { phase: 'pre_activity' | 'post_activity' }) => [
      'recovery-pipeline-no-qualifying-profile',
      ctx.phase,
    ],
    level: 'warning',
    addedAt: '2026-05-27T00:00:00Z',
    contextSchema: z.object({
      phase: z.enum(['pre_activity', 'post_activity']),
    }),
  },
  recovery_pipeline_rate_limited: {
    owner: '@core',
    description:
      'Recovery pipeline: depth-4 skipped because the recovery profile rides on a rate-limit pool that already tripped (per-profile `rateLimited` flag or shared cooldown). Stage 5b — stable, registry-owned fingerprint replaces raw `captureException`.',
    fingerprint: (ctx: { phase: 'pre_activity' | 'post_activity' }) => [
      'recovery-pipeline-rate-limited',
      ctx.phase,
    ],
    level: 'warning',
    addedAt: '2026-05-27T00:00:00Z',
    contextSchema: z.object({
      phase: z.enum(['pre_activity', 'post_activity']),
    }),
  },
  recovery_pipeline_no_messages_to_compact: {
    owner: '@core',
    description:
      'Recovery pipeline: compaction was unable to proceed because no messages survived to compact. Stage 5b — stable, registry-owned fingerprint replaces raw `captureException`.',
    fingerprint: (ctx: { phase: 'pre_activity' | 'post_activity' }) => [
      'recovery-pipeline-no-messages-to-compact',
      ctx.phase,
    ],
    level: 'warning',
    addedAt: '2026-05-27T00:00:00Z',
    contextSchema: z.object({
      phase: z.enum(['pre_activity', 'post_activity']),
    }),
  },
  agent_watchdog_self_resolved: {
    owner: '@core',
    description:
      'Agent-turn watchdog fired but the turn completed successfully after the stall (REBEL-N4). Success telemetry — recorded ledger-only via recordKnownConditionLedgerOnly plus the analytics rail (resolution-time buckets); deliberately NEVER captured to Sentry. See docs/plans/260610_improve-sentry-noise/PLAN.md Stage 2.',
    fingerprint: ['agent-watchdog-self-resolved'],
    level: 'info',
    sink: 'ledger-only',
    addedAt: '2026-06-10T00:00:00Z',
  },
  agent_watchdog_stalled: {
    owner: '@core',
    description:
      'Agent turn watchdog triggered — agent/SDK output stalled past the first-trigger threshold (REBEL-1AD). Sweep-visible warning with rich process/raw-stream diagnostics in extra; replaces the raw captureException in agentTurnExecute (260610 improve-sentry-noise Stage 2).',
    fingerprint: ['agent-watchdog-stalled'],
    level: 'warning',
    addedAt: '2026-06-10T00:00:00Z',
    dedupeAdvisory:
      'caller-side: captured only on first trigger (level 1), suppressed while a tool is in flight or the stream is actively emitting deltas (REBEL-1AD gates in agentTurnExecute)',
  },
  agent_watchdog_auto_abort: {
    owner: '@core',
    description:
      'Agent-turn watchdog auto-aborted the turn after sustained silence at the phase-aware ceiling (REBEL-NQ / REBEL-RD). Sweep-visible warning; replaces the raw captureMessage in agentTurnExecute (260610 improve-sentry-noise Stage 2 — note captureMessage→captureException regroups the Sentry issue).',
    fingerprint: ['agent-watchdog-auto-abort'],
    level: 'warning',
    addedAt: '2026-06-10T00:00:00Z',
  },
  all_providers_unreachable: {
    owner: '@core',
    description:
      'EVERY fresh-probed AI provider is unreachable for this user (edge-triggered on the non-all→all_unreachable verdict transition). The "truly cannot reach any AI host" cohort signal — e.g. a fully-offline user, or a user whose DNS resolution is entirely down. NOTE: requires every fresh provider unreachable; a PARTIAL block where one probed-but-unused endpoint stays reachable (e.g. FOX-3513, where api.openai.com survived while the user\'s actual providers were down) yields partially_unreachable and does NOT fire — that case needs an active-providers-only verdict (tracked follow-up). Structural extras only; no PII. Flap-pair partner of providers_reachability_recovered.',
    fingerprint: ['all-providers-unreachable'],
    level: 'warning',
    addedAt: '2026-06-21T00:00:00Z',
    contextSchema: z.object({
      extra: z
        .object({
          providerCount: z.number().int(),
          unreachableProviders: z.array(z.string()),
          consideredProviders: z.array(z.string()),
          errorCodes: z.record(z.string(), z.string()),
        })
        .strict(),
    }),
    dedupeAdvisory:
      'edge-triggered: once per all-unreachable EPISODE (not per observation), plus a min-interval guard against flapping; recovery (definite non-all verdict) ends the episode and only emits the ledger-only recovered event if the episode actually emitted a warning',
  },
  cloud_connection_degraded: {
    owner: '@cloud',
    description:
      'Cloud connection entered the degraded state (healthy→degraded edge on cloudFailureCooldown). Open degraded state — flap-pair partner of cloud_connection_recovered (already ledger-only). Ledger-only since Stage 4 (260610 improve-sentry-noise; taxonomy disposition is suppress-at-capture): the skip breadcrumb carries the transition extras onto the next real event, and cloud_connection_degraded_escalated (warning, same extras) marks sustained incidents in the issue stream.',
    fingerprint: ['cloud-connection-degraded'],
    level: 'info',
    sink: 'ledger-only',
    addedAt: '2026-06-11T00:00:00Z',
    dedupeAdvisory:
      'edge-triggered by cloudFailureCooldown state transitions (once per healthy→degraded edge); flapping connections emit one degraded/recovered pair per flap',
  },
  cloud_connection_degraded_escalated: {
    owner: '@cloud',
    description:
      'Cloud connection degradation crossed an escalation-level threshold while already degraded (sustained consecutive failures). Sweep-visible warning; replaces the raw captureMessage in cloudConnectionReconcilerSingleton (260610 improve-sentry-noise Stage 3 — captureMessage→captureException regroups the Sentry issue).',
    fingerprint: ['cloud-connection-degraded-escalated'],
    level: 'warning',
    addedAt: '2026-06-11T00:00:00Z',
    dedupeAdvisory:
      'edge-triggered: once per escalation-level crossing (levels 0–3) within a degraded episode',
  },
  cloud_connection_recovered: {
    owner: '@cloud',
    description:
      'Cloud connection recovered after a degraded period. Success telemetry — recorded ledger-only via recordKnownConditionLedgerOnly plus an info breadcrumb (recovery context rides on the next real Sentry event); deliberately NEVER captured to Sentry. See docs/plans/260610_improve-sentry-noise/PLAN.md Stage 3.',
    fingerprint: ['cloud-connection-recovered'],
    level: 'info',
    sink: 'ledger-only',
    addedAt: '2026-06-11T00:00:00Z',
  },
  providers_reachability_recovered: {
    owner: '@core',
    description:
      'Provider reachability recovered after an all-providers-unreachable episode. Success telemetry — ledger-only via recordKnownConditionLedgerOnly plus an info breadcrumb; deliberately NEVER captured to Sentry. Flap-pair partner of all_providers_unreachable.',
    fingerprint: ['providers-reachability-recovered'],
    level: 'info',
    sink: 'ledger-only',
    addedAt: '2026-06-21T00:00:00Z',
  },
  microsoft_oauth_no_pending_callback: {
    owner: '@main',
    description:
      'Microsoft OAuth callback arrived but no auth was pending (in-memory or persisted) — a ghost/duplicate callback, e.g. a stale browser tab re-firing the mindstone:// protocol URL. Handled by ignoring the callback; the uptime/cold-start context rides on the skip breadcrumb. Replaces the raw info captureMessage in microsoftAuthService (260610 improve-sentry-noise Stage 5).',
    fingerprint: ['microsoft-oauth-no-pending-callback'],
    level: 'info',
    sink: 'ledger-only',
    addedAt: '2026-06-11T00:00:00Z',
  },
  cloud_sync_boot_rehab_summary: {
    owner: '@cloud',
    description:
      'Cloud-sync outbox boot rehabilitation re-enqueued terminal-failed entries at startup (count telemetry: rehabilitated/skipped). Pure telemetry — the per-entry detail is already logged at the call site. Replaces the raw info captureMessage in cloudOutbox (260610 improve-sentry-noise Stage 5).',
    fingerprint: ['cloud-sync-boot-rehab-summary'],
    level: 'info',
    sink: 'ledger-only',
    addedAt: '2026-06-11T00:00:00Z',
  },
  cloud_sync_tombstone_applied: {
    owner: '@cloud',
    description:
      'Cloud-sync applied a confirmed session tombstone (local session deleted to converge with a cloud-side deletion). Audit telemetry for "my session disappeared" investigations — the session-hash/proof context rides on the skip breadcrumb and the call-site log line; a quarantine snapshot is taken before deletion. Replaces the raw info captureMessage in cloudOutbox (260610 improve-sentry-noise Stage 5).',
    fingerprint: ['cloud-sync-tombstone-applied'],
    level: 'info',
    sink: 'ledger-only',
    addedAt: '2026-06-11T00:00:00Z',
  },
  cloud_pressure_capability_missing: {
    owner: '@cloud',
    description:
      'Connected cloud instance does not expose the pressure capability in health-probe responses (old cloud build). Once-per-desktop-session cohort telemetry. Replaces the raw info captureMessage in cloudConnectionReconcilerSingleton (260610 improve-sentry-noise Stage 5).',
    fingerprint: ['cloud-pressure-capability-missing'],
    level: 'info',
    sink: 'ledger-only',
    addedAt: '2026-06-11T00:00:00Z',
    dedupeAdvisory: 'caller-side: once per desktop session (module-level latch in cloudConnectionReconcilerSingleton)',
  },
  fd_pressure_elevated: {
    owner: '@main',
    description:
      'FD pressure crossed an elevated band (50% or 75%) in perfDiagnosticService. PROMOTED to fleet visibility 2026-06-21 (was ledger-only): the fd-leak incident (REBEL-66M) had this signal but it was invisible to the fleet, so the leak was diagnosed only after the user ran lsof against prod. Volume is bounded by the caller-side once-per-band-per-launch guard (≤2 events/launch across the 50/75 bands) and most users never cross 50%, so the issue-stream cost is small relative to the early-warning value. fd_pressure_critical (90%) was already warning.',
    fingerprint: ['fd-pressure-elevated'],
    level: 'warning',
    addedAt: '2026-06-11T00:00:00Z',
    dedupeAdvisory: 'caller-side once-per-band-per-process (50/75 bands each emit at most once per launch)',
  },
  fd_pressure_critical: {
    owner: '@main',
    description:
      'FD pressure crossed the 90% critical band in perfDiagnosticService. Warning issue-stream signal. Accepted-may-page under the current unfiltered Rebel Error rule until alert-level filtering changes.',
    fingerprint: ['fd-pressure-critical'],
    level: 'warning',
    addedAt: '2026-06-11T00:00:00Z',
    dedupeAdvisory: 'caller-side once-per-band-per-process (90% emits at most once per launch)',
  },
  sentry_oversized_event_detected: {
    owner: '@main',
    description:
      'Main-process Sentry beforeSend observed an oversized serialized event payload (event item only) and emitted section-size attribution telemetry. Ledger-only by design: this is pre-drop forensics, never an issue-stream event.',
    fingerprint: ['sentry-oversized-event-detected'],
    level: 'info',
    sink: 'ledger-only',
    addedAt: '2026-06-11T00:00:00Z',
    contextSchema: z.object({
      extra: z.object({
        eventSizeBytes: z.number().int().nonnegative(),
        thresholdBytes: z.number().int().positive(),
        sentryHardCapBytes: z.number().int().positive(),
        topSections: z.array(
          z.object({
            section: z.string().regex(/^(breadcrumbs|contexts|extra\.[A-Za-z0-9_.-]{1,64})$/),
            sizeBytes: z.number().int().nonnegative(),
          }),
        ),
      }),
    }),
    dedupeAdvisory: 'caller-side emits on every oversized event (no time-window dedupe; each event can differ)',
  },
  cloud_self_update_credentials_missing: {
    owner: '@cloud',
    description:
      "Cloud self-update cycle skipped because Fly credentials are missing (FLY_API_TOKEN / app-name env) — a known-degraded BYOK config that self-heals when the desktop next bootstraps the token. issue-stream BY DESIGN: the cloud service has no diagnostic ledger, and the grouped issue's event count IS the fleet 'cohort stuck without credentials' signal (one event per affected instance per process — caller throttles per cause). Fingerprint preserves the pre-registry grouping ['cloud.self_update.failed', cause]. Replaces the info arm of the raw captureMessage in selfUpdateScheduler (260610 improve-sentry-noise Stage 5).",
    fingerprint: (ctx: { cause: 'fly-token-missing' | 'fly-env-missing' }) => [
      'cloud.self_update.failed',
      ctx.cause,
    ],
    level: 'info',
    sink: 'issue-stream',
    addedAt: '2026-06-11T00:00:00Z',
    contextSchema: z.object({
      cause: z.enum(['fly-token-missing', 'fly-env-missing']),
    }),
    dedupeAdvisory: 'caller-side: capturedCauses once-per-cause-per-process throttle in selfUpdateScheduler',
  },
  codex_proxy_claude_leak: {
    owner: '@core',
    description:
      'A Claude-dialect model reached the Codex proxy egress and was remapped to a Codex model. Self-healing routing backstop, not an outage: the egress is killed-by-construction (branded CodexEgressModel) and the turn self-heals via remap before the wire — so this is a sweep-visible, non-paging diagnostic that a providerRouting/executor guard let slip, NOT a user-visible failure. Demoted from error-level captureException to warning (260612 sentry-telemetry-tidy; REBEL-540/67V family). Fingerprint preserves the pre-registry grouping [\'codex-proxy-claude-leak\', route] for historical continuity.',
    fingerprint: (ctx: { route: 'route-resolved' | 'codex-turn' }) => [
      'codex-proxy-claude-leak',
      ctx.route,
    ],
    level: 'warning',
    addedAt: '2026-06-12T00:00:00Z',
    contextSchema: z.object({
      route: z.enum(['route-resolved', 'codex-turn']),
    }),
  },
  codex_proxy_unsupported_model: {
    owner: '@core',
    description:
      'A Codex-unsupported model reached the Codex proxy egress and was remapped to a supported Codex model. Self-healing routing backstop, not an outage: the egress is killed-by-construction (branded CodexEgressModel) and the turn self-heals via remap before the wire — so this is a sweep-visible, non-paging diagnostic that a providerRouting/executor guard let slip, NOT a user-visible failure. Demoted from error-level captureException to warning (260612 sentry-telemetry-tidy; REBEL-540/67V family). Fingerprint preserves the pre-registry grouping [\'codex-proxy-unsupported-model\', route] for historical continuity.',
    fingerprint: (ctx: { route: 'route-resolved' | 'codex-turn' }) => [
      'codex-proxy-unsupported-model',
      ctx.route,
    ],
    level: 'warning',
    addedAt: '2026-06-12T00:00:00Z',
    contextSchema: z.object({
      route: z.enum(['route-resolved', 'codex-turn']),
    }),
  },
  quit_deadlock_detected: {
    owner: '@main',
    description:
      'A quit/install fallback fired because the quit sequence did not complete in its budget — a telemetry-blind quit-deadlock class (FOX-3487 Electron-≥41 fsevents/TSFN teardown hang; docs/plans/260617_bricked-state-0448-electron42). Sweep-visible warning, keyed distinctly per tier (macOS Tier-1/Tier-2, Windows force-exit, graceful-shutdown 10s race) so it does NOT collude with the relaunch-watchdog telemetry. The on-device diagnostic-events ledger entry (kind: quit_deadlock_detected) is written FIRST and survives process exit even when this companion Sentry capture is lost; the flush is bounded so it can never extend an already-hung quit.',
    fingerprint: (ctx: { tier: 'mac_tier1' | 'mac_tier2' | 'win' | 'graceful_10s' }) => [
      'quit-deadlock-detected',
      ctx.tier,
    ],
    level: 'warning',
    addedAt: '2026-06-18T00:00:00Z',
    // The native-liveness snapshot is additive + optional: the synchronous
    // native-resource snapshot captured at the macOS quit-deadlock boundary
    // (Stage 1 of docs/plans/260622_pin-quit-deadlock-blocker/PLAN.md).
    // Counts/bools only; each field fail-open-nullable.
    //
    // IMPORTANT — the schema validates the ACTUALLY-EMITTED Sentry context
    // shape, not a hypothetical top-level field. `emitQuitDeadlockDetected`
    // (src/main/services/quitDeadlockTelemetry.ts) calls captureKnownCondition
    // with `{ tier, tags, extra: { nativeLiveness } }`, and
    // captureKnownCondition.safeParse()s that whole object — so the snapshot
    // must be validated under `extra.nativeLiveness`. A prior version validated
    // a top-level `nativeLiveness` that was never sent, so the emitted nested
    // shape went entirely unchecked. The schema is NON-strict at the top level
    // (it must tolerate the ordinary ErrorReporterCaptureContext keys the
    // condition carries — `tags`, fingerprint, etc.), but the nested snapshot
    // is the shared `.strict()` schema (rejects unknown snapshot fields). The
    // shared schema is the SAME one the diagnostic-events ledger persists,
    // imported from its own dependency-free module to avoid a
    // knownConditions↔ledger import cycle.
    contextSchema: z.object({
      tier: z.enum(['mac_tier1', 'mac_tier2', 'win', 'graceful_10s']),
      extra: z
        .object({
          nativeLiveness: nativeLivenessSnapshotSchema.optional(),
        })
        .optional(),
    }),
  },
  update_external_force_kill_fired: {
    owner: '@main',
    description:
      'The detached relaunch watchdog had to SIGTERM/SIGKILL the old app PID because it outlived the kill budget after quitAndInstall — the FOX-3487 Electron-≥41 native TSFN env-teardown hang that the in-process Tier-1/Tier-2 force-exit nets cannot escape (they run on the wedged event loop / re-enter the hanging teardown via app.exit). This is the field-signal that the new OUT-OF-PROCESS kill net ACTUALLY fired, emitted on next-launch consumption of the watchdog telemetry. Distinct from quit_deadlock_detected (which fires from the in-process tiers): a confirmation+tuning signal post-deploy, keyed by signal so TERM (graceful escalation) vs KILL (hard escalation) are separable. See docs/plans/260622_mac-update-quit-force-kill.',
    fingerprint: (ctx: { signal: string }) => ['update.external_force_kill', ctx.signal],
    level: 'warning',
    addedAt: '2026-06-22T00:00:00Z',
    contextSchema: z.object({
      signal: z.enum(['TERM', 'KILL']),
    }),
  },
  file_index_fts_degraded: {
    owner: '@core',
    description:
      'FTS (keyword) index unavailable; hybrid file search degraded to vector-only ranking. phase: create|verify (build-time) | runtime (per-query hybrid fallback). Vector + name search remain functional; self-heals on rebuild. See docs/plans/260618_semantic-index-error-surfacing/PLAN.md.',
    fingerprint: (ctx: { phase: string }) => ['file-index-fts-degraded', ctx.phase],
    level: 'warning',
    addedAt: '2026-06-18T00:00:00Z',
    contextSchema: z.object({ phase: z.enum(['create', 'verify', 'runtime']) }),
  },
  file_index_semantic_search_failed: {
    owner: '@core',
    description:
      'File semantic search failed after the index and embedding step were available. Not-ready states are returned via semanticSearchWithStatus; this captures only unexpected runtime failures that would otherwise collapse to no results.',
    fingerprint: () => ['file-index-semantic-search-failed'],
    level: 'warning',
    addedAt: '2026-06-18T00:00:00Z',
  },
  route_tag_gate_model_mismatch: {
    owner: '@core',
    description:
      'WS1b-2 proxy integrity gate (OBSERVABILITY-ONLY): the inbound request body.model differs from the executor-minted x-route-wire-model witness (= decision.wireModelId). The request STILL PROCEEDS — this is a telemetry signal, NOT a rejection. The divergence is NOT yet a reliable corruption signal because legitimate cases exist: non-route-table subagent OpenRouter legacy-id delegations intentionally stream the RESOLVED model while wireModelId carries a cross-model LEGACY_OR_MODEL_REMAP target (e.g. body deepseek-chat-v3-0324 vs wire deepseek-v3.2; see agentTool resolveSubAgentDispatchBodyModel + subAgentProxyRouting.test.ts). WS1b-2 emits this to CHARACTERIZE the legitimate body≠wire set before any fail-closed promotion (see deprecation criterion in localModelProxyServer.applyRouteTagGate). Sweep-visible warning. See docs/plans/260620_ws1-routing-authority-spine.',
    fingerprint: (ctx: { route: 'route-tag-gate' }) => ['route-tag-gate-model-mismatch', ctx.route],
    level: 'warning',
    addedAt: '2026-06-20T00:00:00Z',
    contextSchema: z.object({ route: z.literal('route-tag-gate') }),
  },
  route_facts_binding_mismatch: {
    owner: '@core',
    description:
      'WS4b proxy route-facts BINDING failure (billing-correctness, fail-safe): a route-facts carrier (x-route-facts) verified its HMAC under the session secret (AUTHENTIC) but its facts.routeId does NOT equal the request\'s independent per-request anchor x-route-id (or that anchor is absent). The carrier is therefore NOT bound to THIS request — a stale or mis-threaded same-session carrier. The proxy DOES NOT consume the carrier for billing; it falls back to legacy re-derivation (the facts-absent path), so a personal request can never be charged to managed (or vice-versa) on a mis-attached carrier. Telemetry-only signal; the request proceeds re-derived. On a localhost x-proxy-auth-gated boundary the realistic cause is an accidental mis-threaded carrier (a bug threading a previous turn\'s carrier), not an external forger. See localModelProxyServer.verifyInboundRouteFacts + appendRouteTagHeaders (providerRouteHeaders.ts).',
    fingerprint: (ctx: { route: 'route-facts' }) => ['route-facts-binding-mismatch', ctx.route],
    level: 'warning',
    addedAt: '2026-06-21T00:00:00Z',
    contextSchema: z.object({ route: z.literal('route-facts') }),
  },
  session_index_collapse_detected: {
    owner: '@core',
    description:
      'loadIndexOnlySync detected a valid-but-collapsed session index: many on-disk session files are missing from the index (orphanCount > SUSPECT_COLLAPSE_ORPHAN_THRESHOLD = 50) — the no-crash twin of the 260616 incident (67 entries while ~2,882 files on disk). The fast path falls back to a full load that recovers the orphans (self-heals), so this is warning-level, not error. A fleet-wide spike in this issue\'s event count means a released regression is collapsing indexes. The catastrophic crash-during-load path is captured separately at error (fingerprint session-store-load-failed). Counts only — never titles/paths/ids. See docs/plans/260616_folders-appear-empty-index-collapse/PLAN.md + docs/plans/260621_session-collapse-canary/PLAN.md.',
    fingerprint: ['session-index-collapse-detected'],
    level: 'warning',
    addedAt: '2026-06-21T00:00:00Z',
    // Counts-only by construction (review F1): `extra` is strict — exactly the
    // three numeric counts, no titles/paths/ids. An object-literal call with any
    // other `extra` key fails to compile (TS excess-property check); a
    // variable-passed PII key fails runtime safeParse → captureKnownCondition
    // fails open to a vanilla capture (observable via its warn), never silent.
    contextSchema: z
      .object({
        extra: z
          .object({
            indexCount: z.number(),
            orphanCount: z.number(),
            fileCount: z.number(),
          })
          .strict(),
      })
      .passthrough(),
    dedupeAdvisory:
      'Fires only on the pathology (orphanCount > 50), never in steady state, so it carries no steady-state volume. It can recur once per boot until the user\'s index self-heals via the next successful full-load persist; the fleet signal is the issue event count, so per-boot recurrence on a single affected machine is acceptable and no extra dedupe is added.',
  },
  corrupt_session_file_skipped: {
    owner: '@core',
    description:
      'H2 (260621 monitoring): incrementalSessionStore.loadSessionFile / loadSessionFileSync hit a NON-ENOENT failure reading or hydrating a session file (corrupt JSON, unreadable, hydrate throw). The lenient loader returns null and skips the session — previously a SILENT data-loss (the session vanishes from the visible corpus with no signal), which is the class that needed the user\'s .zip. Warning-level so a fleet spike (a released regression corrupting session files) is visible; counts/operation only, never titles/paths/ids/content.',
    fingerprint: (ctx: { operation: string }) => ['corrupt-session-file-skipped', ctx.operation],
    level: 'warning',
    addedAt: '2026-06-21T00:00:00Z',
    contextSchema: z
      .object({
        extra: z
          .object({
            operation: z.string(),
            errorCode: z.string().optional(),
          })
          .strict(),
      })
      .passthrough(),
    dedupeAdvisory:
      'Fingerprinted by operation (loadSessionFile / loadSessionFileSync). A user with many corrupt files emits one issue per operation; the fleet signal is the event count. No per-file dedupe — distinct corrupt files are distinct losses worth counting.',
  },
}) satisfies Record<KnownCondition, ConditionMeta>;
