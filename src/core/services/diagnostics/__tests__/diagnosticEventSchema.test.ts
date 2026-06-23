/**
 * Stage 1 (F4 minimal) guard test for the diagnostic-events ledger schema.
 *
 * The whole point of the diagnostic-events feature is "redaction-safe-by-construction":
 * callers cannot accidentally smuggle a free-form string (an error message, a path,
 * a URL) into the persisted ledger because the Zod schema rejects it.
 *
 * If anyone ever weakens the schema by adding a bare `z.string()` field to a
 * `data` payload, this test fails. Loud, deterministic, no humans-in-the-loop.
 *
 * See:
 *   - src/core/services/diagnostics/manifest.ts § DIAGNOSTIC_EVENT_SCHEMA_VERSION
 *   - src/core/services/diagnosticEventsLedger.ts (Zod schema)
 *   - docs/plans/260505_diagnostics_foundations_f1_f5.md (F4 stage)
 */

import { describe, expect, it, vi } from 'vitest';

import {
  ABORT_DURATION_BUCKETS_MS,
  APPROVAL_AGE_BUCKETS_MINUTES,
  DIAGNOSTIC_EVENT_SCHEMA_VERSION,
  bucketAbortDurationMs,
  bucketApprovalAgeMinutes,
  type DiagnosticEventEntry,
} from '../manifest';
import {
  appendDiagnosticEvent,
  diagnosticEventEntrySchema,
  resetDiagnosticEventsLedgerForTests,
  setDiagnosticEventsLedgerWriter,
  setDiagnosticEventsSurface,
} from '@core/services/diagnosticEventsLedger';

// Override the global vitest.setup.ts `vi.mock('@core/logger', …)` so this
// file can exercise the REAL `runWithTurnContext` / `getTurnContext`
// AsyncLocalStorage plumbing that backs the auto-stamp behavior. Without this
// override the global mock returns `undefined` from `getTurnContext`, which
// would defeat the whole purpose of the auto-stamp tests below.
 
vi.mock('@core/logger', async () => {
  const actual = await vi.importActual<typeof import('@core/logger')>('@core/logger');
  return actual;
});

import { runWithTurnContext } from '@core/logger';

const baseFields = {
  v: DIAGNOSTIC_EVENT_SCHEMA_VERSION,
  ts: 1_700_000_000_000,
  surface: 'desktop' as const,
};

describe('diagnostic event schema — happy paths', () => {
  it('accepts cooldown_enter with all required fields', () => {
    const entry: DiagnosticEventEntry = {
      ...baseFields,
      kind: 'cooldown_enter',
      data: {
        scope: 'api',
        untilMs: baseFields.ts + 30_000,
        retryAfterProvided: false,
        durationMs: 30_000,
      },
    };
    expect(diagnosticEventEntrySchema.safeParse(entry).success).toBe(true);
  });

  it('accepts cooldown_exit with success reason', () => {
    const entry: DiagnosticEventEntry = {
      ...baseFields,
      kind: 'cooldown_exit',
      data: { scope: 'safety-eval', reason: 'success' },
    };
    expect(diagnosticEventEntrySchema.safeParse(entry).success).toBe(true);
  });

  it('accepts tool_advisory with valid advisory enum', () => {
    const entry: DiagnosticEventEntry = {
      ...baseFields,
      kind: 'tool_advisory',
      data: { advisory: 'soft_budget', totalToolCalls: 12 },
    };
    expect(diagnosticEventEntrySchema.safeParse(entry).success).toBe(true);
  });

  it('accepts known_condition with valid condition + level', () => {
    const entry: DiagnosticEventEntry = {
      ...baseFields,
      kind: 'known_condition',
      data: { condition: 'model_error', level: 'warning' },
    };
    expect(diagnosticEventEntrySchema.safeParse(entry).success).toBe(true);
  });

  it('accepts optional opaque tid / sid identifiers', () => {
    const entry: DiagnosticEventEntry = {
      ...baseFields,
      tid: 'turn_abc-123',
      sid: 'sess_XYZ_456',
      kind: 'cooldown_exit',
      data: { scope: 'api', reason: 'expired' },
    };
    expect(diagnosticEventEntrySchema.safeParse(entry).success).toBe(true);
  });

  it('accepts cooldown_enter with the new "cloud" scope', () => {
    const entry: DiagnosticEventEntry = {
      ...baseFields,
      kind: 'cooldown_enter',
      data: {
        scope: 'cloud',
        untilMs: baseFields.ts + 60_000,
        retryAfterProvided: false,
        durationMs: 60_000,
      },
    };
    expect(diagnosticEventEntrySchema.safeParse(entry).success).toBe(true);
  });

  it('accepts tool_call_error with hashed tool name and turn-call index', () => {
    const entry: DiagnosticEventEntry = {
      ...baseFields,
      kind: 'tool_call_error',
      data: {
        toolNameHash: 'a1b2c3d4e5f60718',
        isRepeatOfNormalizedSignature: false,
        turnCallIndex: 3,
      },
    };
    expect(diagnosticEventEntrySchema.safeParse(entry).success).toBe(true);
  });

  it('accepts cost_outcome_resolution with closed outcome taxonomy', () => {
    const entry: DiagnosticEventEntry = {
      ...baseFields,
      kind: 'cost_outcome_resolution',
      data: {
        costEntryId: 'test-cost-entry-id-1',
        ledgerRowTs: baseFields.ts,
        ledgerRowSid: 'session-1',
        ledgerRowTid: 'turn-1',
        outcome: { kind: 'aborted', reason: 'user_cancel' },
      },
    };

    expect(diagnosticEventEntrySchema.safeParse(entry).success).toBe(true);
  });

  it('accepts cost_outcome_resolution_lost warning events', () => {
    const entry: DiagnosticEventEntry = {
      ...baseFields,
      kind: 'cost_outcome_resolution_lost',
      data: {
        costEntryId: 'test-cost-entry-id-2',
        lagMs: 70_000,
        rotationStraddled: true,
      },
    };

    expect(diagnosticEventEntrySchema.safeParse(entry).success).toBe(true);
  });

  it('accepts cost_outcome_resolution_unmatched warning events', () => {
    const entry: DiagnosticEventEntry = {
      ...baseFields,
      kind: 'cost_outcome_resolution_unmatched',
      data: {
        costEntryId: 'test-cost-entry-id-3',
        outcome: { kind: 'failed', reason: 'parse_error' },
      },
    };

    expect(diagnosticEventEntrySchema.safeParse(entry).success).toBe(true);
  });

  it('accepts mcp_transition with reason omitted (unknown)', () => {
    const entry: DiagnosticEventEntry = {
      ...baseFields,
      kind: 'mcp_transition',
      data: {
        transition: 'restart',
        restartCount: 2,
        consecutiveFailures: 0,
      },
    };
    expect(diagnosticEventEntrySchema.safeParse(entry).success).toBe(true);
  });

  it('accepts mcp_transition with all optional fields populated', () => {
    const entry: DiagnosticEventEntry = {
      ...baseFields,
      kind: 'mcp_transition',
      data: {
        transition: 'connect',
        reason: 'post-resume',
        serverIdHash: '0123456789abcdef',
        restartCount: 0,
        consecutiveFailures: 0,
      },
    };
    expect(diagnosticEventEntrySchema.safeParse(entry).success).toBe(true);
  });

  it('accepts auth_event refresh_failure with errorCode and provider', () => {
    const entry: DiagnosticEventEntry = {
      ...baseFields,
      kind: 'auth_event',
      data: {
        transition: 'refresh_failure',
        provider: 'google',
        errorCode: 'invalid_grant',
        needsReconnect: true,
        accountSlugHash: 'cafe1234deadbeef',
      },
    };
    expect(diagnosticEventEntrySchema.safeParse(entry).success).toBe(true);
  });

  it('accepts auth_event refresh_success without errorCode', () => {
    const entry: DiagnosticEventEntry = {
      ...baseFields,
      kind: 'auth_event',
      data: {
        transition: 'refresh_success',
        provider: 'microsoft',
        needsReconnect: false,
        accountSlugHash: 'feedfacefeedface',
      },
    };
    expect(diagnosticEventEntrySchema.safeParse(entry).success).toBe(true);
  });

  it('accepts streaming_invariant for orphan_tool_use (repaired)', () => {
    const entry: DiagnosticEventEntry = {
      ...baseFields,
      kind: 'streaming_invariant',
      data: {
        violation: 'orphan_tool_use',
        occurrenceCount: 2,
        repaired: true,
      },
    };
    expect(diagnosticEventEntrySchema.safeParse(entry).success).toBe(true);
  });

  it('accepts streaming_invariant for skeleton_empty_output (not repaired)', () => {
    const entry: DiagnosticEventEntry = {
      ...baseFields,
      kind: 'streaming_invariant',
      data: {
        violation: 'skeleton_empty_output',
        occurrenceCount: 1,
        repaired: false,
      },
    };
    expect(diagnosticEventEntrySchema.safeParse(entry).success).toBe(true);
  });

  it('accepts abort_event for budget_hard at the smallest duration bucket', () => {
    const entry: DiagnosticEventEntry = {
      ...baseFields,
      kind: 'abort_event',
      data: { reason: 'budget_hard', durationBucketMs: 1_000 },
    };
    expect(diagnosticEventEntrySchema.safeParse(entry).success).toBe(true);
  });

  it('accepts abort_event for user_cancel at a mid-range duration bucket', () => {
    const entry: DiagnosticEventEntry = {
      ...baseFields,
      kind: 'abort_event',
      data: { reason: 'user_cancel', durationBucketMs: 30_000 },
    };
    expect(diagnosticEventEntrySchema.safeParse(entry).success).toBe(true);
  });

  it('accepts abort_event for superseded at the largest duration bucket', () => {
    const entry: DiagnosticEventEntry = {
      ...baseFields,
      kind: 'abort_event',
      data: { reason: 'superseded', durationBucketMs: 600_000 },
    };
    expect(diagnosticEventEntrySchema.safeParse(entry).success).toBe(true);
  });

  it('accepts abort_event for judge_killed', () => {
    const entry: DiagnosticEventEntry = {
      ...baseFields,
      kind: 'abort_event',
      data: { reason: 'judge_killed', durationBucketMs: 120_000 },
    };
    expect(diagnosticEventEntrySchema.safeParse(entry).success).toBe(true);
  });

  it('accepts abort_event for consecutive_fail_open_cap', () => {
    const entry: DiagnosticEventEntry = {
      ...baseFields,
      kind: 'abort_event',
      data: { reason: 'consecutive_fail_open_cap', durationBucketMs: 120_000 },
    };
    expect(diagnosticEventEntrySchema.safeParse(entry).success).toBe(true);
  });

  it('accepts abort_event for tool-level watchdog fallback reasons', () => {
    const capEntry: DiagnosticEventEntry = {
      ...baseFields,
      kind: 'abort_event',
      data: { reason: 'tool_cancelled_cap', durationBucketMs: 120_000 },
    };
    expect(diagnosticEventEntrySchema.safeParse(capEntry).success).toBe(true);

    const unresponsiveEntry: DiagnosticEventEntry = {
      ...baseFields,
      kind: 'abort_event',
      data: { reason: 'tool_cancel_unresponsive', durationBucketMs: 120_000 },
    };
    expect(diagnosticEventEntrySchema.safeParse(unresponsiveEntry).success).toBe(true);
  });

  it('accepts watchdog_judge_decision for explicit extension', () => {
    const entry: DiagnosticEventEntry = {
      ...baseFields,
      kind: 'watchdog_judge_decision',
      data: {
        decision: 'extended',
        additionalMs: 15 * 60_000,
        priorExtensionCount: 1,
        elapsedMs: 1_500_000,
        silentMs: 1_400_000,
        toolName: 'mcp.web.search',
      },
    };
    expect(diagnosticEventEntrySchema.safeParse(entry).success).toBe(true);
  });

  it('accepts watchdog_judge_decision fail-open extension with cause', () => {
    const entry: DiagnosticEventEntry = {
      ...baseFields,
      kind: 'watchdog_judge_decision',
      data: {
        decision: 'failed_extended',
        additionalMs: 10 * 60_000,
        cause: 'request_failed',
        priorExtensionCount: 2,
        elapsedMs: 1_500_000,
        silentMs: 1_400_000,
      },
    };
    expect(diagnosticEventEntrySchema.safeParse(entry).success).toBe(true);
  });

  it('accepts watchdog_judge_decision for tool cancellation', () => {
    const entry: DiagnosticEventEntry = {
      ...baseFields,
      kind: 'watchdog_judge_decision',
      data: {
        decision: 'tool_cancelled',
        priorExtensionCount: 2,
        elapsedMs: 1_500_000,
        silentMs: 1_400_000,
        toolName: 'mcp.web.search',
      },
    };
    expect(diagnosticEventEntrySchema.safeParse(entry).success).toBe(true);
  });

  it('accepts watchdog_judge_decision for deterministic auto-extension with a closed reason enum', () => {
    const entry: DiagnosticEventEntry = {
      ...baseFields,
      kind: 'watchdog_judge_decision',
      data: {
        decision: 'auto_extended',
        additionalMs: 15 * 60_000,
        reason: 'auto_extend_first_call_modest_silence',
        priorExtensionCount: 0,
        elapsedMs: 1_500_000,
        silentMs: 1_400_000,
        toolName: 'Task',
      },
    };
    expect(diagnosticEventEntrySchema.safeParse(entry).success).toBe(true);
  });

  it('accepts watchdog_judge_decision injection suspicion values and absent field', () => {
    const levels = ['none', 'warn', 'override'] as const;

    for (const injectionSuspected of levels) {
      const entry: DiagnosticEventEntry = {
        ...baseFields,
        kind: 'watchdog_judge_decision',
        data: {
          decision: 'failed_extended',
          additionalMs: 10 * 60_000,
          injectionSuspected,
          priorExtensionCount: 1,
          elapsedMs: 1_500_000,
          silentMs: 1_400_000,
        },
      };
      expect(diagnosticEventEntrySchema.safeParse(entry).success).toBe(true);
    }

    const absentEntry: DiagnosticEventEntry = {
      ...baseFields,
      kind: 'watchdog_judge_decision',
      data: {
        decision: 'extended',
        additionalMs: 15 * 60_000,
        priorExtensionCount: 1,
        elapsedMs: 1_500_000,
        silentMs: 1_400_000,
      },
    };
    expect(diagnosticEventEntrySchema.safeParse(absentEntry).success).toBe(true);
  });

  it('accepts judge_decision_stale_skip for stale kill decisions', () => {
    const entry: DiagnosticEventEntry = {
      ...baseFields,
      kind: 'judge_decision_stale_skip',
      data: {
        boundToolUseId: 'toolu_stale',
        decision: 'kill',
      },
    };
    expect(diagnosticEventEntrySchema.safeParse(entry).success).toBe(true);
  });

  it('accepts judge_decision_stale_skip for stale extend decisions', () => {
    const entry: DiagnosticEventEntry = {
      ...baseFields,
      kind: 'judge_decision_stale_skip',
      data: {
        boundToolUseId: 'toolu_stale_extend',
        decision: 'extend',
      },
    };
    expect(diagnosticEventEntrySchema.safeParse(entry).success).toBe(true);
  });

  it('accepts judge_decision_stale_skip for stale failed_extended decisions', () => {
    const entry: DiagnosticEventEntry = {
      ...baseFields,
      kind: 'judge_decision_stale_skip',
      data: {
        boundToolUseId: 'toolu_stale_failed',
        decision: 'failed_extended',
      },
    };
    expect(diagnosticEventEntrySchema.safeParse(entry).success).toBe(true);
  });

  it('rejects judge_decision_stale_skip for unknown decision values', () => {
    const entry = {
      ...baseFields,
      kind: 'judge_decision_stale_skip' as const,
      data: {
        boundToolUseId: 'toolu_stale',
        decision: 'tool_cancelled',
      },
    } as unknown as DiagnosticEventEntry;
    expect(diagnosticEventEntrySchema.safeParse(entry).success).toBe(false);
  });

  it('rejects watchdog_judge_decision with non-literal additionalMs', () => {
    const entry: DiagnosticEventEntry = {
      ...baseFields,
      kind: 'watchdog_judge_decision',
      data: {
        decision: 'extended',
        additionalMs: 17 * 60_000, // Not in {10,15,30,45,60}*60_000
        priorExtensionCount: 0,
        elapsedMs: 1_500_000,
        silentMs: 1_400_000,
      },
    };
    expect(diagnosticEventEntrySchema.safeParse(entry).success).toBe(false);
  });

  it('accepts subagent_internal_timeout_recovered with all fields', () => {
    const entry: DiagnosticEventEntry = {
      ...baseFields,
      kind: 'subagent_internal_timeout_recovered',
      data: {
        toolUseId: 'toolu_subagent_1',
        agentName: 'forager',
        elapsedMs: 165_000,
        priorTimeoutCount: 0,
      },
    };
    expect(diagnosticEventEntrySchema.safeParse(entry).success).toBe(true);
  });

  it('accepts subagent_internal_timeout_recovered without an agentName', () => {
    const entry: DiagnosticEventEntry = {
      ...baseFields,
      kind: 'subagent_internal_timeout_recovered',
      data: {
        toolUseId: 'toolu_subagent_2',
        elapsedMs: 200_000,
        priorTimeoutCount: 1,
      },
    };
    expect(diagnosticEventEntrySchema.safeParse(entry).success).toBe(true);
  });

  it('rejects subagent_internal_timeout_recovered with extra unknown fields', () => {
    const malformed = {
      ...baseFields,
      kind: 'subagent_internal_timeout_recovered',
      data: {
        toolUseId: 'toolu_subagent_3',
        agentName: 'forager',
        elapsedMs: 200_000,
        priorTimeoutCount: 0,
        rawErrorMessage: 'should be rejected',
      },
    };
    expect(diagnosticEventEntrySchema.safeParse(malformed).success).toBe(false);
  });

  it('rejects subagent_internal_timeout_recovered with negative priorTimeoutCount', () => {
    const malformed = {
      ...baseFields,
      kind: 'subagent_internal_timeout_recovered',
      data: {
        toolUseId: 'toolu_subagent_4',
        elapsedMs: 200_000,
        priorTimeoutCount: -1,
      },
    };
    expect(diagnosticEventEntrySchema.safeParse(malformed).success).toBe(false);
  });

  it('accepts abort_event for the new tool_repeated_timeout reason', () => {
    const entry: DiagnosticEventEntry = {
      ...baseFields,
      kind: 'abort_event',
      data: { reason: 'tool_repeated_timeout', durationBucketMs: 600_000 },
    };
    expect(diagnosticEventEntrySchema.safeParse(entry).success).toBe(true);
  });

  it('accepts approval_stuck for tool kind at smallest bucket', () => {
    const entry: DiagnosticEventEntry = {
      ...baseFields,
      kind: 'approval_stuck',
      data: { approvalKind: 'tool', ageBucketMinutes: 5, queueDepth: 1 },
    };
    expect(diagnosticEventEntrySchema.safeParse(entry).success).toBe(true);
  });

  it('accepts approval_stuck for memory kind at largest bucket', () => {
    const entry: DiagnosticEventEntry = {
      ...baseFields,
      kind: 'approval_stuck',
      data: { approvalKind: 'memory', ageBucketMinutes: 240, queueDepth: 3 },
    };
    expect(diagnosticEventEntrySchema.safeParse(entry).success).toBe(true);
  });

  it('accepts settings_drift_observation with observed and resolved states', () => {
    const observed: DiagnosticEventEntry = {
      ...baseFields,
      kind: 'settings_drift_observation',
      data: {
        field: 'active_provider',
        surfaceA: 'desktop',
        surfaceB: 'cloud',
        diffKind: 'a_b_differ_enum',
        eventState: 'observed',
      },
    };
    const resolved: DiagnosticEventEntry = {
      ...observed,
      data: {
        ...observed.data,
        eventState: 'resolved',
      },
    };

    expect(diagnosticEventEntrySchema.safeParse(observed).success).toBe(true);
    expect(diagnosticEventEntrySchema.safeParse(resolved).success).toBe(true);
  });

  it('accepts quit_deadlock_detected for each tier with a closed platform enum', () => {
    const tiers = ['mac_tier1', 'mac_tier2', 'win', 'graceful_10s'] as const;
    for (const tier of tiers) {
      const entry: DiagnosticEventEntry = {
        ...baseFields,
        kind: 'quit_deadlock_detected',
        data: { tier, platform: 'darwin' },
      };
      expect(diagnosticEventEntrySchema.safeParse(entry).success).toBe(true);
    }
  });

  it('rejects quit_deadlock_detected with an unknown tier', () => {
    const malformed = {
      ...baseFields,
      kind: 'quit_deadlock_detected',
      data: { tier: 'linux_systemd', platform: 'linux' },
    };
    expect(diagnosticEventEntrySchema.safeParse(malformed).success).toBe(false);
  });

  it('rejects quit_deadlock_detected with extra free-form fields (no smuggling)', () => {
    const malformed = {
      ...baseFields,
      kind: 'quit_deadlock_detected',
      data: { tier: 'win', platform: 'win32', message: 'hung on fsevents teardown' },
    };
    expect(diagnosticEventEntrySchema.safeParse(malformed).success).toBe(false);
  });

  it('accepts quit_deadlock_detected with the additive nativeLiveness snapshot (260622)', () => {
    const entry: DiagnosticEventEntry = {
      ...baseFields,
      kind: 'quit_deadlock_detected',
      data: {
        tier: 'mac_tier2',
        platform: 'darwin',
        nativeLiveness: {
          fseventsLiveInstances: 3,
          moonshineSessions: 2,
          superMcpPid: 4242,
          superMcpRunning: true,
          lancedbConnections: { conversation: 1, file: 2, tool: 1 },
          embedding: { workerAlive: false, gpuBackendAlive: false, disposed: true },
        },
      },
    };
    expect(diagnosticEventEntrySchema.safeParse(entry).success).toBe(true);
  });

  it('accepts quit_deadlock_detected nativeLiveness with fail-open nulls but rejects unknown snapshot fields', () => {
    const withNulls: DiagnosticEventEntry = {
      ...baseFields,
      kind: 'quit_deadlock_detected',
      data: {
        tier: 'mac_tier1',
        platform: 'darwin',
        nativeLiveness: {
          fseventsLiveInstances: null,
          moonshineSessions: null,
          superMcpPid: null,
          superMcpRunning: null,
          lancedbConnections: { conversation: null, file: null, tool: null },
          embedding: { workerAlive: null, gpuBackendAlive: null, disposed: null },
        },
      },
    };
    expect(diagnosticEventEntrySchema.safeParse(withNulls).success).toBe(true);

    const withSmuggledField = {
      ...baseFields,
      kind: 'quit_deadlock_detected',
      data: {
        tier: 'mac_tier2',
        platform: 'darwin',
        nativeLiveness: {
          fseventsLiveInstances: 1,
          moonshineSessions: 0,
          superMcpPid: null,
          superMcpRunning: false,
          lancedbConnections: { conversation: 0, file: 0, tool: 0 },
          embedding: { workerAlive: false, gpuBackendAlive: false, disposed: true },
          stack: 'should-not-be-allowed',
        },
      },
    };
    expect(diagnosticEventEntrySchema.safeParse(withSmuggledField).success).toBe(false);
  });

  it('accepts events_per_kind_cap_engaged with a closed kind enum and zero drops', () => {
    const entry: DiagnosticEventEntry = {
      ...baseFields,
      kind: 'events_per_kind_cap_engaged',
      data: {
        kind: 'continuity_transition',
        capLimit: 2_000,
        droppedSinceLastWarning: 0,
      },
    };

    expect(diagnosticEventEntrySchema.safeParse(entry).success).toBe(true);
  });
});

describe('diagnostic event schema — new-variant rejection guards', () => {
  it('rejects tool_call_error with a non-hex tool-name hash', () => {
    const malformed = {
      ...baseFields,
      kind: 'tool_call_error',
      data: {
        toolNameHash: 'not-a-hash-at-all',
        isRepeatOfNormalizedSignature: false,
        turnCallIndex: 1,
      },
    };
    expect(diagnosticEventEntrySchema.safeParse(malformed).success).toBe(false);
  });

  it('rejects tool_call_error with the wrong hash length (32 hex)', () => {
    const malformed = {
      ...baseFields,
      kind: 'tool_call_error',
      data: {
        toolNameHash: 'a1b2c3d4e5f6071800000000aaaaaaaa',
        isRepeatOfNormalizedSignature: false,
        turnCallIndex: 1,
      },
    };
    expect(diagnosticEventEntrySchema.safeParse(malformed).success).toBe(false);
  });

  it('rejects tool_call_error with non-positive turnCallIndex', () => {
    const malformed = {
      ...baseFields,
      kind: 'tool_call_error',
      data: {
        toolNameHash: 'a1b2c3d4e5f60718',
        isRepeatOfNormalizedSignature: false,
        turnCallIndex: 0,
      },
    };
    expect(diagnosticEventEntrySchema.safeParse(malformed).success).toBe(false);
  });

  it('rejects mcp_transition with an unknown transition kind', () => {
    const malformed = {
      ...baseFields,
      kind: 'mcp_transition',
      data: {
        transition: 'reboot',
        restartCount: 0,
        consecutiveFailures: 0,
      },
    };
    expect(diagnosticEventEntrySchema.safeParse(malformed).success).toBe(false);
  });

  it('rejects mcp_transition with an unknown reason (must use closed enum)', () => {
    const malformed = {
      ...baseFields,
      kind: 'mcp_transition',
      data: {
        transition: 'restart',
        reason: 'because-i-felt-like-it',
        restartCount: 0,
        consecutiveFailures: 0,
      },
    };
    expect(diagnosticEventEntrySchema.safeParse(malformed).success).toBe(false);
  });

  it('rejects mcp_transition with a free-form reason like "unknown"', () => {
    const malformed = {
      ...baseFields,
      kind: 'mcp_transition',
      data: {
        transition: 'restart',
        reason: 'unknown',
        restartCount: 0,
        consecutiveFailures: 0,
      },
    };
    expect(diagnosticEventEntrySchema.safeParse(malformed).success).toBe(false);
  });

  it('rejects auth_event missing the required provider', () => {
    const malformed = {
      ...baseFields,
      kind: 'auth_event',
      data: {
        transition: 'refresh_failure',
        errorCode: 'invalid_grant',
        needsReconnect: true,
        accountSlugHash: 'cafe1234deadbeef',
      },
    };
    expect(diagnosticEventEntrySchema.safeParse(malformed).success).toBe(false);
  });

  it('rejects auth_event with an unknown provider', () => {
    const malformed = {
      ...baseFields,
      kind: 'auth_event',
      data: {
        transition: 'refresh_failure',
        provider: 'meta',
        errorCode: 'invalid_grant',
        needsReconnect: true,
        accountSlugHash: 'cafe1234deadbeef',
      },
    };
    expect(diagnosticEventEntrySchema.safeParse(malformed).success).toBe(false);
  });

  it('rejects auth_event with a non-hex accountSlugHash', () => {
    const malformed = {
      ...baseFields,
      kind: 'auth_event',
      data: {
        transition: 'refresh_success',
        provider: 'google',
        needsReconnect: false,
        accountSlugHash: 'greg-work-com',
      },
    };
    expect(diagnosticEventEntrySchema.safeParse(malformed).success).toBe(false);
  });

  it('rejects streaming_invariant with an unknown violation kind', () => {
    const malformed = {
      ...baseFields,
      kind: 'streaming_invariant',
      data: {
        violation: 'mystery_meat',
        occurrenceCount: 1,
        repaired: false,
      },
    };
    expect(diagnosticEventEntrySchema.safeParse(malformed).success).toBe(false);
  });

  it('rejects streaming_invariant with extra unknown fields', () => {
    const malformed = {
      ...baseFields,
      kind: 'streaming_invariant',
      data: {
        violation: 'orphan_tool_use',
        occurrenceCount: 1,
        repaired: true,
        rawErrorMessage: 'orphan id_42 had no matching tool_result',
      },
    };
    expect(diagnosticEventEntrySchema.safeParse(malformed).success).toBe(false);
  });

  it('rejects streaming_invariant with non-positive occurrenceCount', () => {
    const malformed = {
      ...baseFields,
      kind: 'streaming_invariant',
      data: {
        violation: 'orphan_tool_result',
        occurrenceCount: 0,
        repaired: true,
      },
    };
    expect(diagnosticEventEntrySchema.safeParse(malformed).success).toBe(false);
  });

  it('rejects abort_event with an unknown reason', () => {
    const malformed = {
      ...baseFields,
      kind: 'abort_event',
      data: { reason: 'mysterious_aliens', durationBucketMs: 1_000 },
    };
    expect(diagnosticEventEntrySchema.safeParse(malformed).success).toBe(false);
  });

  it('rejects abort_event with a non-bucketed durationBucketMs (raw ms leak)', () => {
    const malformed = {
      ...baseFields,
      kind: 'abort_event',
      data: { reason: 'user_cancel', durationBucketMs: 12_345 },
    };
    expect(diagnosticEventEntrySchema.safeParse(malformed).success).toBe(false);
  });

  it('rejects abort_event with extra unknown fields (no error message smuggling)', () => {
    const malformed = {
      ...baseFields,
      kind: 'abort_event',
      data: {
        reason: 'budget_hard',
        durationBucketMs: 30_000,
        message: 'tool budget exceeded — should not be here',
      },
    };
    expect(diagnosticEventEntrySchema.safeParse(malformed).success).toBe(false);
  });

  it('rejects watchdog_judge_decision with an unknown failure cause', () => {
    const malformed = {
      ...baseFields,
      kind: 'watchdog_judge_decision',
      data: {
        decision: 'failed_extended',
        additionalMs: 60_000,
        cause: 'network_glitch',
        priorExtensionCount: 1,
        elapsedMs: 240_000,
        silentMs: 110_000,
      },
    };
    expect(diagnosticEventEntrySchema.safeParse(malformed).success).toBe(false);
  });

  it('rejects watchdog_judge_decision with invalid toolName format', () => {
    const malformed = {
      ...baseFields,
      kind: 'watchdog_judge_decision',
      data: {
        decision: 'extended',
        additionalMs: 120_000,
        priorExtensionCount: 0,
        elapsedMs: 120_000,
        silentMs: 60_000,
        toolName: 'mcp web search with spaces',
      },
    };
    expect(diagnosticEventEntrySchema.safeParse(malformed).success).toBe(false);
  });

  it('rejects watchdog_judge_decision with an unknown auto-extend reason', () => {
    const malformed = {
      ...baseFields,
      kind: 'watchdog_judge_decision',
      data: {
        decision: 'auto_extended',
        additionalMs: 15 * 60_000,
        reason: 'auto_extend_maybe',
        priorExtensionCount: 0,
        elapsedMs: 120_000,
        silentMs: 60_000,
      },
    };
    expect(diagnosticEventEntrySchema.safeParse(malformed).success).toBe(false);
  });

  it('rejects approval_stuck with an unknown approvalKind', () => {
    const malformed = {
      ...baseFields,
      kind: 'approval_stuck',
      data: { approvalKind: 'plugin_install', ageBucketMinutes: 5, queueDepth: 1 },
    };
    expect(diagnosticEventEntrySchema.safeParse(malformed).success).toBe(false);
  });

  it('rejects approval_stuck with a non-bucketed ageBucketMinutes (raw age leak)', () => {
    const malformed = {
      ...baseFields,
      kind: 'approval_stuck',
      data: { approvalKind: 'tool', ageBucketMinutes: 27, queueDepth: 1 },
    };
    expect(diagnosticEventEntrySchema.safeParse(malformed).success).toBe(false);
  });

  it('rejects approval_stuck with non-positive queueDepth', () => {
    const malformed = {
      ...baseFields,
      kind: 'approval_stuck',
      data: { approvalKind: 'tool', ageBucketMinutes: 5, queueDepth: 0 },
    };
    expect(diagnosticEventEntrySchema.safeParse(malformed).success).toBe(false);
  });

  it('rejects events_per_kind_cap_engaged with non-zero droppedSinceLastWarning', () => {
    const malformed = {
      ...baseFields,
      kind: 'events_per_kind_cap_engaged',
      data: {
        kind: 'continuity_transition',
        capLimit: 2_000,
        droppedSinceLastWarning: 1,
      },
    };
    expect(diagnosticEventEntrySchema.safeParse(malformed).success).toBe(false);
  });

  it('rejects events_per_kind_cap_engaged with an unknown engaged kind', () => {
    const malformed = {
      ...baseFields,
      kind: 'events_per_kind_cap_engaged',
      data: {
        kind: 'made_up_kind',
        capLimit: 2_000,
        droppedSinceLastWarning: 0,
      },
    };
    expect(diagnosticEventEntrySchema.safeParse(malformed).success).toBe(false);
  });
});

describe('bucketAbortDurationMs', () => {
  it('returns the smallest bucket for zero or negative input', () => {
    expect(bucketAbortDurationMs(0)).toBe(ABORT_DURATION_BUCKETS_MS[0]);
    expect(bucketAbortDurationMs(-50)).toBe(ABORT_DURATION_BUCKETS_MS[0]);
  });
  it('returns the smallest bucket for a value at the boundary', () => {
    expect(bucketAbortDurationMs(1_000)).toBe(1_000);
  });
  it('rounds up to the next bucket for in-between values', () => {
    expect(bucketAbortDurationMs(1_001)).toBe(10_000);
    expect(bucketAbortDurationMs(15_000)).toBe(30_000);
    expect(bucketAbortDurationMs(60_000)).toBe(120_000);
  });
  it('saturates to the largest bucket for overflow values', () => {
    expect(bucketAbortDurationMs(10 * 60_000)).toBe(600_000);
    expect(bucketAbortDurationMs(60 * 60_000)).toBe(600_000);
  });
  it('handles non-finite input by returning the smallest bucket', () => {
    expect(bucketAbortDurationMs(Number.NaN)).toBe(ABORT_DURATION_BUCKETS_MS[0]);
    expect(bucketAbortDurationMs(Number.POSITIVE_INFINITY)).toBe(ABORT_DURATION_BUCKETS_MS[0]);
  });
});

describe('bucketApprovalAgeMinutes', () => {
  it('returns null for ages below the smallest bucket', () => {
    expect(bucketApprovalAgeMinutes(0)).toBeNull();
    expect(bucketApprovalAgeMinutes(4.9)).toBeNull();
  });
  it('returns the bucket exactly at boundary', () => {
    expect(bucketApprovalAgeMinutes(5)).toBe(5);
    expect(bucketApprovalAgeMinutes(15)).toBe(15);
    expect(bucketApprovalAgeMinutes(60)).toBe(60);
    expect(bucketApprovalAgeMinutes(240)).toBe(240);
  });
  it('returns the largest bucket already crossed for in-between values', () => {
    expect(bucketApprovalAgeMinutes(7)).toBe(5);
    expect(bucketApprovalAgeMinutes(20)).toBe(15);
    expect(bucketApprovalAgeMinutes(120)).toBe(60);
  });
  it('saturates at the largest bucket for overflow values', () => {
    expect(bucketApprovalAgeMinutes(10_000)).toBe(APPROVAL_AGE_BUCKETS_MINUTES[APPROVAL_AGE_BUCKETS_MINUTES.length - 1]);
  });
  it('handles non-finite input by returning null', () => {
    expect(bucketApprovalAgeMinutes(Number.NaN)).toBeNull();
    expect(bucketApprovalAgeMinutes(Number.POSITIVE_INFINITY)).toBeNull();
  });
});

describe('diagnostic event ledger — auto-stamp tid / sid from turn context', () => {
  it('stamps tid/sid on emitted events when runWithTurnContext is active', async () => {
    const captured: DiagnosticEventEntry[] = [];
    setDiagnosticEventsSurface('desktop');
    setDiagnosticEventsLedgerWriter({
      append(entry) {
        captured.push(entry);
      },
    });
    try {
      await runWithTurnContext(
        { turnId: 'turn_auto_42', sessionId: 'sess_auto_99' },
        async () => {
          appendDiagnosticEvent({
            kind: 'tool_advisory',
            data: { advisory: 'soft_budget', totalToolCalls: 5 },
          });
        },
      );
      expect(captured.length).toBe(1);
      expect(captured[0].tid).toBe('turn_auto_42');
      expect(captured[0].sid).toBe('sess_auto_99');
    } finally {
      resetDiagnosticEventsLedgerForTests();
    }
  });

  it('does NOT overwrite caller-supplied tid/sid', async () => {
    const captured: DiagnosticEventEntry[] = [];
    setDiagnosticEventsSurface('desktop');
    setDiagnosticEventsLedgerWriter({
      append(entry) {
        captured.push(entry);
      },
    });
    try {
      await runWithTurnContext(
        { turnId: 'turn_outer', sessionId: 'sess_outer' },
        async () => {
          appendDiagnosticEvent({
            tid: 'turn_caller_wins',
            sid: 'sess_caller_wins',
            kind: 'tool_advisory',
            data: { advisory: 'hard_budget', totalToolCalls: 30 },
          });
        },
      );
      expect(captured.length).toBe(1);
      expect(captured[0].tid).toBe('turn_caller_wins');
      expect(captured[0].sid).toBe('sess_caller_wins');
    } finally {
      resetDiagnosticEventsLedgerForTests();
    }
  });

  it('omits tid/sid when no turn context is active (background emit)', () => {
    const captured: DiagnosticEventEntry[] = [];
    setDiagnosticEventsSurface('desktop');
    setDiagnosticEventsLedgerWriter({
      append(entry) {
        captured.push(entry);
      },
    });
    try {
      appendDiagnosticEvent({
        kind: 'cooldown_exit',
        data: { scope: 'api', reason: 'success' },
      });
      expect(captured.length).toBe(1);
      expect(captured[0].tid).toBeUndefined();
      expect(captured[0].sid).toBeUndefined();
    } finally {
      resetDiagnosticEventsLedgerForTests();
    }
  });
});

describe('diagnostic event schema — redaction-safe-by-construction guard', () => {
  it('rejects an unknown extra string field on cooldown_enter.data', () => {
    const malformed = {
      ...baseFields,
      kind: 'cooldown_enter',
      data: {
        scope: 'api',
        untilMs: baseFields.ts + 30_000,
        retryAfterProvided: false,
        durationMs: 30_000,
        message: 'rate limit hit at /v1/messages with token=hunter2',
      },
    };
    expect(diagnosticEventEntrySchema.safeParse(malformed).success).toBe(false);
  });

  it('rejects an unknown extra string field on tool_advisory.data', () => {
    const malformed = {
      ...baseFields,
      kind: 'tool_advisory',
      data: {
        advisory: 'hard_budget',
        totalToolCalls: 30,
        toolName: 'bash',
        message: 'Tool budget reached',
      },
    };
    expect(diagnosticEventEntrySchema.safeParse(malformed).success).toBe(false);
  });

  it('rejects free-form strings smuggled through known_condition.data.condition', () => {
    const malformed = {
      ...baseFields,
      kind: 'known_condition',
      data: { condition: 'whoops bad input with spaces & symbols!!!', level: 'error' },
    };
    expect(diagnosticEventEntrySchema.safeParse(malformed).success).toBe(false);
  });

  it('rejects valid-shaped but unknown known_condition keys (must be in registry)', () => {
    const malformed = {
      ...baseFields,
      kind: 'known_condition',
      data: { condition: 'plausible_looking_but_unregistered_condition', level: 'warning' },
    };
    expect(diagnosticEventEntrySchema.safeParse(malformed).success).toBe(false);
  });

  it('rejects unknown enum values on cooldown_exit.reason', () => {
    const malformed = {
      ...baseFields,
      kind: 'cooldown_exit',
      data: { scope: 'api', reason: 'because the user complained' },
    };
    expect(diagnosticEventEntrySchema.safeParse(malformed).success).toBe(false);
  });

  it('rejects unknown enum values on tool_advisory.advisory', () => {
    const malformed = {
      ...baseFields,
      kind: 'tool_advisory',
      data: { advisory: 'something_we_made_up', totalToolCalls: 1 },
    };
    expect(diagnosticEventEntrySchema.safeParse(malformed).success).toBe(false);
  });

  it('rejects free-form id strings (e.g. raw URLs) in tid / sid metadata', () => {
    const malformed = {
      ...baseFields,
      tid: 'https://api.openai.com/v1/messages?key=hunter2',
      kind: 'cooldown_enter',
      data: {
        scope: 'api',
        untilMs: baseFields.ts + 30_000,
        retryAfterProvided: false,
        durationMs: 30_000,
      },
    };
    expect(diagnosticEventEntrySchema.safeParse(malformed).success).toBe(false);
  });

  it('rejects negative numeric counters', () => {
    const malformed = {
      ...baseFields,
      kind: 'tool_advisory',
      data: { advisory: 'consecutive_error', totalToolCalls: -1 },
    };
    expect(diagnosticEventEntrySchema.safeParse(malformed).success).toBe(false);
  });

  it('rejects an unknown kind discriminator', () => {
    const malformed = {
      ...baseFields,
      kind: 'feature_flag_change',
      data: { flag: 'x', value: true },
    };
    expect(diagnosticEventEntrySchema.safeParse(malformed).success).toBe(false);
  });
});

describe('diagnostic event schema — version invariants', () => {
  it('exposes a positive integer schema version', () => {
    expect(Number.isInteger(DIAGNOSTIC_EVENT_SCHEMA_VERSION)).toBe(true);
    expect(DIAGNOSTIC_EVENT_SCHEMA_VERSION).toBeGreaterThan(0);
  });

  it('rejects entries with a non-positive `v`', () => {
    const malformed = {
      ...baseFields,
      v: 0,
      kind: 'cooldown_exit',
      data: { scope: 'api', reason: 'success' },
    };
    expect(diagnosticEventEntrySchema.safeParse(malformed).success).toBe(false);
  });
});
