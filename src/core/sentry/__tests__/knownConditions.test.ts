import { describe, expect, it } from 'vitest';
import {
  defineKnownConditions,
  KNOWN_CONDITIONS,
  type ConditionMeta,
  type KnownCondition,
} from '@core/sentry/knownConditions';

/**
 * Overridable fields for test fixtures. Deliberately excludes `level`/`sink`
 * so the fixtures stay on the warning branch of the ConditionMeta
 * discriminated union (Partial of the full union would defeat the
 * level↔sink lockstep the type enforces).
 */
type ConditionMetaOverrides = Partial<
  Pick<
    ConditionMeta,
    'owner' | 'description' | 'fingerprint' | 'addedAt' | 'expectedDegraded' | 'deprecatedAt' | 'removableAfter'
  >
>;

function entryFor(condition: KnownCondition, overrides: ConditionMetaOverrides = {}): ConditionMeta {
  return {
    owner: '@test',
    description: `Test metadata for ${condition}`,
    fingerprint: [`test-${condition}`],
    level: 'warning',
    addedAt: '2026-05-03T00:00:00Z',
    ...overrides,
  };
}

function registryWith(
  condition: KnownCondition,
  overrides: ConditionMetaOverrides,
): Record<KnownCondition, ConditionMeta> {
  return {
    model_error: entryFor('model_error', condition === 'model_error' ? overrides : {}),
    codex_disconnected_bts: entryFor(
      'codex_disconnected_bts',
      condition === 'codex_disconnected_bts' ? overrides : {},
    ),
    runtime_activity_mapper_failure: entryFor(
      'runtime_activity_mapper_failure',
      condition === 'runtime_activity_mapper_failure' ? overrides : {},
    ),
    cloud_outbox_stuck: entryFor(
      'cloud_outbox_stuck',
      condition === 'cloud_outbox_stuck' ? overrides : {},
    ),
    bts_profile_missing: entryFor(
      'bts_profile_missing',
      condition === 'bts_profile_missing' ? overrides : {},
    ),
    bts_summary_failure: entryFor(
      'bts_summary_failure',
      condition === 'bts_summary_failure' ? overrides : {},
    ),
    bts_quip_failure: entryFor(
      'bts_quip_failure',
      condition === 'bts_quip_failure' ? overrides : {},
    ),
    bts_warmup_failure: entryFor(
      'bts_warmup_failure',
      condition === 'bts_warmup_failure' ? overrides : {},
    ),
    bridge_recent_events_failure: entryFor(
      'bridge_recent_events_failure',
      condition === 'bridge_recent_events_failure' ? overrides : {},
    ),
    bridge_recent_logs_failure: entryFor(
      'bridge_recent_logs_failure',
      condition === 'bridge_recent_logs_failure' ? overrides : {},
    ),
    bridge_log_file_paths_failure: entryFor(
      'bridge_log_file_paths_failure',
      condition === 'bridge_log_file_paths_failure' ? overrides : {},
    ),
    pass_through_redaction_policy: entryFor(
      'pass_through_redaction_policy',
      condition === 'pass_through_redaction_policy' ? overrides : {},
    ),
    conversation_title_unavailable: entryFor(
      'conversation_title_unavailable',
      condition === 'conversation_title_unavailable' ? overrides : {},
    ),
    time_saved_unavailable: entryFor(
      'time_saved_unavailable',
      condition === 'time_saved_unavailable' ? overrides : {},
    ),
    codex_auth_destructive_disconnect: entryFor(
      'codex_auth_destructive_disconnect',
      condition === 'codex_auth_destructive_disconnect' ? overrides : {},
    ),
    bts_structured_output_fallback: entryFor(
      'bts_structured_output_fallback',
      condition === 'bts_structured_output_fallback' ? overrides : {},
    ),
    recovery_tool_input_too_large: entryFor(
      'recovery_tool_input_too_large',
      condition === 'recovery_tool_input_too_large' ? overrides : {},
    ),
    recovery_managed_model_not_allowed: entryFor(
      'recovery_managed_model_not_allowed',
      condition === 'recovery_managed_model_not_allowed' ? overrides : {},
    ),
    recovery_billing_quota: entryFor(
      'recovery_billing_quota',
      condition === 'recovery_billing_quota' ? overrides : {},
    ),
    recovery_empty_result_anomaly: entryFor(
      'recovery_empty_result_anomaly',
      condition === 'recovery_empty_result_anomaly' ? overrides : {},
    ),
    recovery_pause_detection_missed: entryFor(
      'recovery_pause_detection_missed',
      condition === 'recovery_pause_detection_missed' ? overrides : {},
    ),
    recovery_unknown_error: entryFor(
      'recovery_unknown_error',
      condition === 'recovery_unknown_error' ? overrides : {},
    ),
    recovery_pipeline_summary_generation_failed: entryFor(
      'recovery_pipeline_summary_generation_failed',
      condition === 'recovery_pipeline_summary_generation_failed' ? overrides : {},
    ),
    recovery_pipeline_agent_loop_error_before_recovery: entryFor(
      'recovery_pipeline_agent_loop_error_before_recovery',
      condition === 'recovery_pipeline_agent_loop_error_before_recovery' ? overrides : {},
    ),
    recovery_pipeline_agent_loop_error_after_recovery: entryFor(
      'recovery_pipeline_agent_loop_error_after_recovery',
      condition === 'recovery_pipeline_agent_loop_error_after_recovery' ? overrides : {},
    ),
    recovery_pipeline_long_context_fallback_failed: entryFor(
      'recovery_pipeline_long_context_fallback_failed',
      condition === 'recovery_pipeline_long_context_fallback_failed' ? overrides : {},
    ),
    recovery_pipeline_depth_limit_reached: entryFor(
      'recovery_pipeline_depth_limit_reached',
      condition === 'recovery_pipeline_depth_limit_reached' ? overrides : {},
    ),
    recovery_pipeline_attempt_limit_reached: entryFor(
      'recovery_pipeline_attempt_limit_reached',
      condition === 'recovery_pipeline_attempt_limit_reached' ? overrides : {},
    ),
    recovery_pipeline_no_qualifying_profile: entryFor(
      'recovery_pipeline_no_qualifying_profile',
      condition === 'recovery_pipeline_no_qualifying_profile' ? overrides : {},
    ),
    recovery_pipeline_rate_limited: entryFor(
      'recovery_pipeline_rate_limited',
      condition === 'recovery_pipeline_rate_limited' ? overrides : {},
    ),
    recovery_pipeline_no_messages_to_compact: entryFor(
      'recovery_pipeline_no_messages_to_compact',
      condition === 'recovery_pipeline_no_messages_to_compact' ? overrides : {},
    ),
    agent_watchdog_self_resolved: entryFor(
      'agent_watchdog_self_resolved',
      condition === 'agent_watchdog_self_resolved' ? overrides : {},
    ),
    agent_watchdog_stalled: entryFor(
      'agent_watchdog_stalled',
      condition === 'agent_watchdog_stalled' ? overrides : {},
    ),
    agent_watchdog_auto_abort: entryFor(
      'agent_watchdog_auto_abort',
      condition === 'agent_watchdog_auto_abort' ? overrides : {},
    ),
    cloud_connection_degraded: entryFor(
      'cloud_connection_degraded',
      condition === 'cloud_connection_degraded' ? overrides : {},
    ),
    cloud_connection_degraded_escalated: entryFor(
      'cloud_connection_degraded_escalated',
      condition === 'cloud_connection_degraded_escalated' ? overrides : {},
    ),
    cloud_connection_recovered: entryFor(
      'cloud_connection_recovered',
      condition === 'cloud_connection_recovered' ? overrides : {},
    ),
    microsoft_oauth_no_pending_callback: entryFor(
      'microsoft_oauth_no_pending_callback',
      condition === 'microsoft_oauth_no_pending_callback' ? overrides : {},
    ),
    cloud_sync_boot_rehab_summary: entryFor(
      'cloud_sync_boot_rehab_summary',
      condition === 'cloud_sync_boot_rehab_summary' ? overrides : {},
    ),
    cloud_sync_tombstone_applied: entryFor(
      'cloud_sync_tombstone_applied',
      condition === 'cloud_sync_tombstone_applied' ? overrides : {},
    ),
    cloud_pressure_capability_missing: entryFor(
      'cloud_pressure_capability_missing',
      condition === 'cloud_pressure_capability_missing' ? overrides : {},
    ),
    fd_pressure_elevated: entryFor(
      'fd_pressure_elevated',
      condition === 'fd_pressure_elevated' ? overrides : {},
    ),
    fd_pressure_critical: entryFor(
      'fd_pressure_critical',
      condition === 'fd_pressure_critical' ? overrides : {},
    ),
    sentry_oversized_event_detected: entryFor(
      'sentry_oversized_event_detected',
      condition === 'sentry_oversized_event_detected' ? overrides : {},
    ),
    cloud_self_update_credentials_missing: entryFor(
      'cloud_self_update_credentials_missing',
      condition === 'cloud_self_update_credentials_missing' ? overrides : {},
    ),
    codex_proxy_claude_leak: entryFor(
      'codex_proxy_claude_leak',
      condition === 'codex_proxy_claude_leak' ? overrides : {},
    ),
    codex_proxy_unsupported_model: entryFor(
      'codex_proxy_unsupported_model',
      condition === 'codex_proxy_unsupported_model' ? overrides : {},
    ),
    quit_deadlock_detected: entryFor(
      'quit_deadlock_detected',
      condition === 'quit_deadlock_detected' ? overrides : {},
    ),
    update_external_force_kill_fired: entryFor(
      'update_external_force_kill_fired',
      condition === 'update_external_force_kill_fired' ? overrides : {},
    ),
    file_index_fts_degraded: entryFor(
      'file_index_fts_degraded',
      condition === 'file_index_fts_degraded' ? overrides : {},
    ),
    file_index_semantic_search_failed: entryFor(
      'file_index_semantic_search_failed',
      condition === 'file_index_semantic_search_failed' ? overrides : {},
    ),
    route_tag_gate_model_mismatch: entryFor(
      'route_tag_gate_model_mismatch',
      condition === 'route_tag_gate_model_mismatch' ? overrides : {},
    ),
    route_facts_binding_mismatch: entryFor(
      'route_facts_binding_mismatch',
      condition === 'route_facts_binding_mismatch' ? overrides : {},
    ),
    session_index_collapse_detected: entryFor(
      'session_index_collapse_detected',
      condition === 'session_index_collapse_detected' ? overrides : {},
    ),
    all_providers_unreachable: entryFor(
      'all_providers_unreachable',
      condition === 'all_providers_unreachable' ? overrides : {},
    ),
    providers_reachability_recovered: entryFor(
      'providers_reachability_recovered',
      condition === 'providers_reachability_recovered' ? overrides : {},
    ),
    corrupt_session_file_skipped: entryFor(
      'corrupt_session_file_skipped',
      condition === 'corrupt_session_file_skipped' ? overrides : {},
    ),
  };
}

function defineWith(overrides: ConditionMetaOverrides): Record<KnownCondition, ConditionMeta> {
  return defineKnownConditions(registryWith('model_error', overrides));
}

// ---------------------------------------------------------------------------
// Stage 4 sink-policy compile-time contract (260610 improve-sentry-noise)
// ---------------------------------------------------------------------------
// Type-level tests: these fail `lint:ts` if the ConditionMeta discriminated
// union stops enforcing the sink policy. No runtime assertions needed.

const sinkPolicyInfoEntryWithSinkCompiles: ConditionMeta = {
  owner: '@test',
  description: 'info entries compile when they declare an explicit sink',
  fingerprint: ['sink-policy-fixture'],
  level: 'info',
  sink: 'ledger-only',
  addedAt: '2026-06-11T00:00:00Z',
};
void sinkPolicyInfoEntryWithSinkCompiles;

// @ts-expect-error — info-level entries MUST declare a sink adjudication (Stage 4 sink policy)
const sinkPolicyInfoEntryWithoutSinkFails: ConditionMeta = {
  owner: '@test',
  description: 'info entries without a sink must not compile',
  fingerprint: ['sink-policy-fixture'],
  level: 'info',
  addedAt: '2026-06-11T00:00:00Z',
};
void sinkPolicyInfoEntryWithoutSinkFails;

const sinkPolicyWarningEntryWithSinkFails: ConditionMeta = {
  owner: '@test',
  description: 'warning entries with a sink must not compile',
  fingerprint: ['sink-policy-fixture'],
  level: 'warning',
  // @ts-expect-error — warning/error entries must NOT carry a sink (Sentry delivery is implied)
  sink: 'ledger-only',
  addedAt: '2026-06-11T00:00:00Z',
};
void sinkPolicyWarningEntryWithSinkFails;

describe('defineKnownConditions', () => {
  describe('ISO8601-Z validation', () => {
    it('accepts addedAt without milliseconds', () => {
      expect(() => defineWith({ addedAt: '2026-05-03T00:00:00Z' })).not.toThrow();
    });

    it('accepts addedAt with milliseconds', () => {
      expect(() => defineWith({ addedAt: '2026-05-03T00:00:00.000Z' })).not.toThrow();
    });

    it.each([
      ['offset timestamp', '2026-05-03T00:00:00+00:00'],
      ['date-only timestamp', '2026-05-03'],
      ['timestamp without timezone', '2026-05-03T00:00:00'],
      ['non-date value', 'not-a-date'],
    ])('rejects addedAt with %s', (_label, addedAt) => {
      expect(() => defineWith({ addedAt })).toThrow(/iso8601|UTC timestamp|Z suffix|valid/i);
    });

    it('accepts expectedDegraded.until with strict Z suffix', () => {
      const conditions = defineWith({
        expectedDegraded: {
          until: '2026-06-01T00:00:00Z',
          reason: 'Temporary test condition',
        },
      });

      expect(conditions.model_error.expectedDegraded?.until).toBe('2026-06-01T00:00:00Z');
    });

    it('rejects expectedDegraded.until without time and Z suffix', () => {
      expect(() =>
        defineWith({
          expectedDegraded: {
            until: '2026-06-01',
            reason: 'Temporary test condition',
          },
        }),
      ).toThrow(/iso8601|UTC timestamp|Z suffix|valid/i);
    });

    it('accepts deprecatedAt with strict Z suffix', () => {
      expect(() => defineWith({ deprecatedAt: '2026-05-15T00:00:00Z' })).not.toThrow();
    });
  });

  describe('removableAfter derivation', () => {
    it('derives removableAfter exactly 30 days after deprecatedAt when omitted', () => {
      const conditions = defineWith({ deprecatedAt: '2026-05-03T00:00:00Z' });

      expect(conditions.model_error.removableAfter).toBe('2026-06-02T00:00:00Z');
    });

    it('keeps an explicit removableAfter value when deprecatedAt is present', () => {
      const conditions = defineWith({
        deprecatedAt: '2026-05-03T00:00:00Z',
        removableAfter: '2026-08-01T00:00:00Z',
      });

      expect(conditions.model_error.removableAfter).toBe('2026-08-01T00:00:00Z');
    });

    it('leaves removableAfter undefined when deprecatedAt is absent', () => {
      const conditions = defineWith({ addedAt: '2026-05-03T00:00:00Z' });

      expect(conditions.model_error.removableAfter).toBeUndefined();
    });
  });
});

// ---------------------------------------------------------------------------
// Codex-proxy leak backstops demoted to warning (260612 sentry-telemetry-tidy;
// REBEL-540/67V). These are self-healing routing diagnostics: sweep-visible
// (warning), never error-level/paging.
// ---------------------------------------------------------------------------
describe('codex-proxy leak conditions (REBEL-540/67V)', () => {
  it.each<KnownCondition>(['codex_proxy_claude_leak', 'codex_proxy_unsupported_model'])(
    'resolves %s at warning level (sweep-visible, non-paging) with no sink',
    (condition) => {
      const meta = KNOWN_CONDITIONS[condition];
      expect(meta.level).toBe('warning');
      // warning/error conditions must NOT carry a sink (Sentry delivery implied)
      expect((meta as { sink?: unknown }).sink).toBeUndefined();
    },
  );

  it('preserves the historical [<base>, route] fingerprint grouping per route', () => {
    const claudeMeta = KNOWN_CONDITIONS.codex_proxy_claude_leak;
    const unsupportedMeta = KNOWN_CONDITIONS.codex_proxy_unsupported_model;
    expect(typeof claudeMeta.fingerprint).toBe('function');
    expect(typeof unsupportedMeta.fingerprint).toBe('function');

    const resolve = (
      meta: ConditionMeta,
      route: 'route-resolved' | 'codex-turn',
    ): readonly string[] => {
      if (typeof meta.fingerprint !== 'function') throw new Error('expected dynamic fingerprint');
      return (meta.fingerprint as (ctx: { route: string }) => readonly string[])({ route });
    };

    expect(resolve(claudeMeta, 'route-resolved')).toEqual(['codex-proxy-claude-leak', 'route-resolved']);
    expect(resolve(claudeMeta, 'codex-turn')).toEqual(['codex-proxy-claude-leak', 'codex-turn']);
    expect(resolve(unsupportedMeta, 'route-resolved')).toEqual(['codex-proxy-unsupported-model', 'route-resolved']);
    expect(resolve(unsupportedMeta, 'codex-turn')).toEqual(['codex-proxy-unsupported-model', 'codex-turn']);
  });
});

// ---------------------------------------------------------------------------
// Stage 6 fleet-promote + new captures (260621 monitoring capture-surface)
// ---------------------------------------------------------------------------
describe('Stage 6 fleet visibility (260621 monitoring)', () => {
  it('fd_pressure_elevated is now fleet-visible (warning, no ledger-only sink)', () => {
    const meta = KNOWN_CONDITIONS.fd_pressure_elevated;
    // RED before the promote (was level:'info', sink:'ledger-only').
    expect(meta.level).toBe('warning');
    expect((meta as { sink?: unknown }).sink).toBeUndefined();
  });

  it('cloud_connection_degraded stays ledger-only (the _escalated sibling carries fleet visibility)', () => {
    const base = KNOWN_CONDITIONS.cloud_connection_degraded;
    const escalated = KNOWN_CONDITIONS.cloud_connection_degraded_escalated;
    // Deliberately NOT promoted: promoting the base edge-trigger would add flap
    // noise; the sustained case is already fleet-visible via _escalated.
    expect((base as { sink?: unknown }).sink).toBe('ledger-only');
    expect(escalated.level).toBe('warning');
    expect((escalated as { sink?: unknown }).sink).toBeUndefined();
  });

  it('corrupt_session_file_skipped (H2) is a fleet-visible warning fingerprinted by operation', () => {
    const meta = KNOWN_CONDITIONS.corrupt_session_file_skipped;
    expect(meta.level).toBe('warning');
    expect((meta as { sink?: unknown }).sink).toBeUndefined();
    if (typeof meta.fingerprint !== 'function') throw new Error('expected dynamic fingerprint');
    const resolve = meta.fingerprint as (ctx: { operation: string }) => readonly string[];
    expect(resolve({ operation: 'loadSessionFile' })).toEqual([
      'corrupt-session-file-skipped',
      'loadSessionFile',
    ]);
  });
});

// The out-of-process update force-kill net (260622 mac-update-quit-force-kill):
// a distinct warning-level signal, fingerprinted by signal so TERM vs KILL are
// separable, and grouped distinctly from quit_deadlock_detected (the
// in-process tiers) so the two never collude.
describe('update_external_force_kill_fired (260622 mac-update-quit-force-kill)', () => {
  it('is a fleet-visible warning with no sink', () => {
    const meta = KNOWN_CONDITIONS.update_external_force_kill_fired;
    expect(meta.level).toBe('warning');
    expect((meta as { sink?: unknown }).sink).toBeUndefined();
  });

  it('fingerprints distinctly and keys by signal (TERM and KILL separable)', () => {
    const meta = KNOWN_CONDITIONS.update_external_force_kill_fired;
    if (typeof meta.fingerprint !== 'function') throw new Error('expected dynamic fingerprint');
    const resolve = meta.fingerprint as (ctx: { signal: string }) => readonly string[];
    expect(resolve({ signal: 'TERM' })).toEqual(['update.external_force_kill', 'TERM']);
    expect(resolve({ signal: 'KILL' })).toEqual(['update.external_force_kill', 'KILL']);
    // Separable from each other AND from the in-process quit_deadlock_detected.
    expect(resolve({ signal: 'TERM' })).not.toEqual(resolve({ signal: 'KILL' }));
    expect(resolve({ signal: 'TERM' })[0]).not.toBe('quit-deadlock-detected');
  });

  it('accepts TERM/KILL and rejects none via its context schema', () => {
    const meta = KNOWN_CONDITIONS.update_external_force_kill_fired;
    if (!meta.contextSchema) throw new Error('expected a context schema');
    expect(meta.contextSchema.safeParse({ signal: 'TERM' }).success).toBe(true);
    expect(meta.contextSchema.safeParse({ signal: 'KILL' }).success).toBe(true);
    expect(meta.contextSchema.safeParse({ signal: 'none' }).success).toBe(false);
  });
});

// The native-resource liveness snapshot threaded into quit_deadlock_detected
// (260622 pin-quit-deadlock-blocker): an ADDITIVE, optional context field so
// the next quit-hang names the live-at-quit native modules. Must stay
// back-compat: prior tier-only context (no snapshot) keeps validating.
//
// F1 (260622 stage refinement): the schema must validate the ACTUALLY-EMITTED
// shape. emitQuitDeadlockDetected sends `{ tier, tags, extra: { nativeLiveness } }`
// and captureKnownCondition safeParse()s that whole object — so the snapshot
// is validated under `extra.nativeLiveness`, NOT a top-level key (a prior
// version validated a top-level field that was never sent, so the emitted
// nested shape was unchecked and unknown nested fields slipped through).
describe('quit_deadlock_detected — additive nativeLiveness context (260622)', () => {
  const fullSnapshot = {
    fseventsLiveInstances: 3,
    moonshineSessions: 2,
    superMcpPid: 4242,
    superMcpRunning: true,
    lancedbConnections: { conversation: 1, file: 2, tool: 1 },
    embedding: { workerAlive: false, gpuBackendAlive: false, disposed: true },
  };

  it('still accepts the tier-only context (no snapshot) plus the ordinary Sentry context keys for back-compat', () => {
    const meta = KNOWN_CONDITIONS.quit_deadlock_detected;
    if (!meta.contextSchema) throw new Error('expected a context schema');
    expect(meta.contextSchema.safeParse({ tier: 'mac_tier2' }).success).toBe(true);
    // The condition always emits `tags` — the non-strict top level must tolerate it.
    expect(
      meta.contextSchema.safeParse({
        tier: 'mac_tier2',
        tags: { platform: 'darwin', quit_deadlock_tier: 'mac_tier2' },
      }).success,
    ).toBe(true);
  });

  it('validates a full native-liveness snapshot under the EMITTED extra.nativeLiveness shape (counts + nullable fail-open fields)', () => {
    const meta = KNOWN_CONDITIONS.quit_deadlock_detected;
    if (!meta.contextSchema) throw new Error('expected a context schema');
    // Mirrors exactly what quitDeadlockTelemetry.emitQuitDeadlockDetected sends.
    expect(
      meta.contextSchema.safeParse({
        tier: 'mac_tier2',
        tags: { platform: 'darwin', quit_deadlock_tier: 'mac_tier2' },
        extra: { nativeLiveness: fullSnapshot },
      }).success,
    ).toBe(true);
    // fail-open nulls (a throwing accessor contributes null) are valid.
    expect(
      meta.contextSchema.safeParse({
        tier: 'mac_tier1',
        extra: {
          nativeLiveness: {
            ...fullSnapshot,
            moonshineSessions: null,
            lancedbConnections: { conversation: null, file: null, tool: null },
          },
        },
      }).success,
    ).toBe(true);
  });

  it('REJECTS an unknown nested field in the emitted extra.nativeLiveness snapshot', () => {
    const meta = KNOWN_CONDITIONS.quit_deadlock_detected;
    if (!meta.contextSchema) throw new Error('expected a context schema');
    expect(
      meta.contextSchema.safeParse({
        tier: 'mac_tier2',
        extra: { nativeLiveness: { ...fullSnapshot, bogusField: 1 } },
      }).success,
    ).toBe(false);
    // Unknown nested field inside lancedbConnections is also rejected (strict).
    expect(
      meta.contextSchema.safeParse({
        tier: 'mac_tier2',
        extra: {
          nativeLiveness: {
            ...fullSnapshot,
            lancedbConnections: { conversation: 1, file: 2, tool: 1, bogus: 9 },
          },
        },
      }).success,
    ).toBe(false);
  });

  it('rejects an unknown tier regardless of the snapshot', () => {
    const meta = KNOWN_CONDITIONS.quit_deadlock_detected;
    if (!meta.contextSchema) throw new Error('expected a context schema');
    expect(meta.contextSchema.safeParse({ tier: 'bogus_tier' }).success).toBe(false);
  });
});
