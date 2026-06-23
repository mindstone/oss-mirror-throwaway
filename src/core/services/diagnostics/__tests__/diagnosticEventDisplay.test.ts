import { describe, expect, it } from 'vitest';

import { getFriendlyEventDisplay } from '../diagnosticEventDisplay';
import {
  DIAGNOSTIC_EVENT_SCHEMA_VERSION,
  type DiagnosticEventEntry,
  type DiagnosticEventKind,
} from '../manifest';

const DIAGNOSTIC_EVENT_KINDS = [
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

type MissingDiagnosticEventKind = Exclude<DiagnosticEventKind, (typeof DIAGNOSTIC_EVENT_KINDS)[number]>;
type UnknownDiagnosticEventKind = Exclude<(typeof DIAGNOSTIC_EVENT_KINDS)[number], DiagnosticEventKind>;

const allKindsCovered: MissingDiagnosticEventKind extends never ? true : never = true;
const noUnknownKinds: UnknownDiagnosticEventKind extends never ? true : never = true;

const VALID_TONES = ['info', 'warning', 'success', 'destructive'] as const;

const EVENT_BY_KIND: { [K in DiagnosticEventKind]: Extract<DiagnosticEventEntry, { kind: K }> } = {
  cooldown_enter: cooldownEnter(100, 'api'),
  cooldown_exit: {
    ...baseEvent(200),
    kind: 'cooldown_exit',
    data: { scope: 'api', reason: 'success' },
  },
  tool_advisory: {
    ...baseEvent(300),
    kind: 'tool_advisory',
    data: { advisory: 'soft_budget', totalToolCalls: 3 },
  },
  known_condition: knownCondition(400, 'warning'),
  tool_call_error: {
    ...baseEvent(500),
    kind: 'tool_call_error',
    data: {
      toolNameHash: 'a1b2c3d4e5f60718',
      isRepeatOfNormalizedSignature: false,
      turnCallIndex: 1,
    },
  },
  mcp_transition: {
    ...baseEvent(600),
    kind: 'mcp_transition',
    data: {
      transition: 'connect',
      restartCount: 0,
      consecutiveFailures: 0,
    },
  },
  auth_event: {
    ...baseEvent(700),
    kind: 'auth_event',
    data: {
      transition: 'refresh_failure',
      provider: 'google',
      errorCode: 'invalid_grant',
      needsReconnect: true,
      accountSlugHash: 'a1b2c3d4e5f60718',
    },
  },
  streaming_invariant: {
    ...baseEvent(800),
    kind: 'streaming_invariant',
    data: {
      violation: 'orphan_tool_use',
      occurrenceCount: 1,
      repaired: true,
    },
  },
  abort_event: {
    ...baseEvent(900),
    kind: 'abort_event',
    data: {
      reason: 'user_cancel',
      durationBucketMs: 1_000,
    },
  },
  watchdog_judge_decision: {
    ...baseEvent(950),
    kind: 'watchdog_judge_decision',
    data: {
      decision: 'extended',
      additionalMs: 900_000,
      priorExtensionCount: 1,
      elapsedMs: 240_000,
      silentMs: 120_000,
      toolName: 'mcp.web.search',
    },
  },
  judge_decision_stale_skip: {
    ...baseEvent(975),
    kind: 'judge_decision_stale_skip',
    data: {
      boundToolUseId: 'toolu_stale',
      decision: 'kill',
    },
  },
  subagent_internal_timeout_recovered: {
    ...baseEvent(985),
    kind: 'subagent_internal_timeout_recovered',
    data: {
      toolUseId: 'toolu_subagent_1',
      agentName: 'forager',
      elapsedMs: 165_000,
      priorTimeoutCount: 0,
    },
  },
  approval_stuck: {
    ...baseEvent(1000),
    kind: 'approval_stuck',
    data: {
      approvalKind: 'tool',
      ageBucketMinutes: 5,
      queueDepth: 1,
    },
  },
  health_check_timing: {
    ...baseEvent(1100),
    kind: 'health_check_timing',
    data: { checkIdHash: 'a1b2c3d4e5f60718', durationBucketMs: 1000, status: 'pass' },
  },
  provider_reachability_change: {
    ...baseEvent(1200),
    kind: 'provider_reachability_change',
    data: { provider: 'anthropic', status: 'reachable' },
  },
  embedding_index_health: {
    ...baseEvent(1300),
    kind: 'embedding_index_health',
    data: { component: 'semantic_index', transition: 'fresh_to_stale', ageBucketHours: 24 },
  },
  worker_stats_pre_turn: {
    ...baseEvent(1400),
    kind: 'worker_stats_pre_turn',
    data: {
      since: 'app_start',
      appStartedAt: 1_700_000_000_000,
      spawnCount: 1,
      restartCount: 0,
      currentlyRestarting: false,
    },
  },
  auto_update_state_change: {
    ...baseEvent(1500),
    kind: 'auto_update_state_change',
    data: { transition: 'check_succeeded', platform: 'darwin' },
  },
  fsevents_leak_sweep: {
    ...baseEvent(1550),
    kind: 'fsevents_leak_sweep',
    data: { sweptCount: 2, trigger: 'immediate_exit', exitReason: 'graceful-shutdown-complete' },
  },
  quit_deadlock_detected: {
    ...baseEvent(1575),
    kind: 'quit_deadlock_detected',
    data: { tier: 'mac_tier2', platform: 'darwin' },
  },
  settings_drift_observation: {
    ...baseEvent(1600),
    kind: 'settings_drift_observation',
    data: {
      field: 'active_provider',
      surfaceA: 'desktop',
      surfaceB: 'cloud',
      diffKind: 'a_b_differ_enum',
    },
  },
  cost_outcome_resolution: {
    ...baseEvent(1700),
    kind: 'cost_outcome_resolution',
    data: {
      costEntryId: 'test-cost-entry-id-1',
      ledgerRowTs: 1650,
      outcome: { kind: 'success' },
    },
  },
  cost_outcome_resolution_lost: {
    ...baseEvent(1800),
    kind: 'cost_outcome_resolution_lost',
    data: {
      costEntryId: 'test-cost-entry-id-2',
      lagMs: 70_000,
      rotationStraddled: true,
    },
  },
  cost_outcome_resolution_unmatched: {
    ...baseEvent(1900),
    kind: 'cost_outcome_resolution_unmatched',
    data: {
      costEntryId: 'test-cost-entry-id-3',
      outcome: { kind: 'failed', reason: 'parse_error' },
    },
  },
  continuity_transition: {
    ...baseEvent(2000),
    kind: 'continuity_transition',
    data: {
      family: 'outbox_stall',
      message: 'stuck-outbox',
      reason: 'stuck-outbox',
      level: 'warning',
      sessionIdHash: 'session_abc123',
    },
  },
  events_per_kind_cap_engaged: {
    ...baseEvent(2100),
    kind: 'events_per_kind_cap_engaged',
    data: {
      kind: 'continuity_transition',
      capLimit: 2_000,
      droppedSinceLastWarning: 0,
    },
  },
};

describe('getFriendlyEventDisplay', () => {
  it('returns a display object for every DiagnosticEventKind', () => {
    expect(allKindsCovered).toBe(true);
    expect(noUnknownKinds).toBe(true);

    for (const kind of DIAGNOSTIC_EVENT_KINDS) {
      const display = getFriendlyEventDisplay(EVENT_BY_KIND[kind]);
      expect(display.summary.trim()).not.toBe('');
      expect(VALID_TONES).toContain(display.tone);
    }
  });

  it('produces purposeful (non-fallback) summaries for every kind — non-technical user friendly', () => {
    // Fallback summary pattern: `<snake_case_kind> event recorded.` is rejected
    // because it leaks raw enum names into UI for non-technical knowledge workers.
    for (const kind of DIAGNOSTIC_EVENT_KINDS) {
      const display = getFriendlyEventDisplay(EVENT_BY_KIND[kind]);
      expect(display.summary).not.toMatch(/event recorded\.$/);
      expect(display.summary).not.toContain(kind);
    }
  });

  it.each([
    'tool_advisory',
    'mcp_transition',
    'auth_event',
    'streaming_invariant',
  ] as const)('renders friendly copy (no raw kind name) for %s', (kind) => {
    const display = getFriendlyEventDisplay(EVENT_BY_KIND[kind]);
    expect(display.summary).toMatch(/[A-Z]|Rebel/);
  });

  it('derives safe_eval_cooldown display for safety-eval cooldown_enter', () => {
    const display = getFriendlyEventDisplay(cooldownEnter(100, 'safety-eval'));

    expect(display).toEqual({
      displayKind: 'safe_eval_cooldown',
      summary: 'A safety check paused briefly after hitting a service limit.',
      tone: 'info',
    });
  });

  it('uses the regular cooldown display for api cooldown_enter', () => {
    const display = getFriendlyEventDisplay(cooldownEnter(100, 'api'));

    expect(display).toEqual({
      displayKind: 'cooldown_enter',
      summary: 'Rebel paused requests because a service asked it to slow down.',
      tone: 'warning',
    });
  });

  it.each([
    ['error', 'destructive'],
    ['warning', 'warning'],
    ['info', 'info'],
  ] as const)('maps known_condition level %s to %s tone', (level, tone) => {
    expect(getFriendlyEventDisplay(knownCondition(100, level)).tone).toBe(tone);
  });

  it('uses known_condition data.condition in the summary', () => {
    const display = getFriendlyEventDisplay(knownCondition(100, 'warning'));

    expect(display.summary).toBe('Known issue: model_error');
  });

  it.each([
    ['conversation_title_unavailable', "Couldn't generate a conversation title."],
    ['time_saved_unavailable', "Couldn't estimate time saved."],
    ['bts_structured_output_fallback', 'Falling back to a different response format.'],
  ] as const)('renders friendly known_condition summary for %s', (condition, expected) => {
    const event: Extract<DiagnosticEventEntry, { kind: 'known_condition' }> = {
      ...knownCondition(100, 'info'),
      data: { condition, level: 'info' },
    };
    expect(getFriendlyEventDisplay(event).summary).toBe(expected);
  });

  it('uses the known_condition fallback summary when condition is absent', () => {
    const display = getFriendlyEventDisplay({
      ...knownCondition(100, 'warning'),
      data: {
        level: 'warning',
      },
    } as DiagnosticEventEntry);

    expect(display.summary).toBe('Known issue tracked.');
  });

  it('renders resolved settings drift with a success tone', () => {
    const event: Extract<DiagnosticEventEntry, { kind: 'settings_drift_observation' }> = {
      ...EVENT_BY_KIND.settings_drift_observation,
      data: {
        ...EVENT_BY_KIND.settings_drift_observation.data,
        eventState: 'resolved',
      },
    };

    expect(getFriendlyEventDisplay(event)).toEqual({
      displayKind: 'settings_drift_observation',
      summary: 'Settings drift resolved.',
      tone: 'success',
    });
  });

  it('renders watchdog_judge_decision correctly based on decision', () => {
    const extendedEvent = {
      ...EVENT_BY_KIND.watchdog_judge_decision,
      data: {
        ...EVENT_BY_KIND.watchdog_judge_decision.data,
        decision: 'extended' as const,
        additionalMs: 900_000,
      }
    };
    expect(getFriendlyEventDisplay(extendedEvent).summary).toBe('Time check granted 15 more minutes.');

    const failedEvent = {
      ...extendedEvent,
      data: { ...extendedEvent.data, decision: 'failed_extended' as const, additionalMs: 600_000 }
    };
    expect(getFriendlyEventDisplay(failedEvent).summary).toBe('Time check unreachable — granted 10 more minutes anyway.');

    const toolCancelledEvent = {
      ...extendedEvent,
      data: { ...extendedEvent.data, decision: 'tool_cancelled' as const }
    };
    expect(getFriendlyEventDisplay(toolCancelledEvent).summary).toBe('Time check stopped a single tool and let the response continue.');

    const autoExtendedFirstCall = {
      ...extendedEvent,
      data: {
        ...extendedEvent.data,
        decision: 'auto_extended' as const,
        reason: 'auto_extend_first_call_modest_silence' as const,
      },
    };
    expect(getFriendlyEventDisplay(autoExtendedFirstCall).summary).toBe(
      'Time check auto-extended because this looked like early normal progress.',
    );

    const autoExtendedSubagent = {
      ...extendedEvent,
      data: {
        ...extendedEvent.data,
        decision: 'auto_extended' as const,
        reason: 'auto_extend_active_subagent_recent_activity' as const,
      },
    };
    expect(getFriendlyEventDisplay(autoExtendedSubagent).summary).toBe(
      'Time check auto-extended because a subagent still looked active.',
    );
  });

  it('renders watchdog_judge_decision injection suspicion variants when present', () => {
    const baseWatchdogEvent = {
      ...EVENT_BY_KIND.watchdog_judge_decision,
      data: {
        ...EVENT_BY_KIND.watchdog_judge_decision.data,
        decision: 'failed_extended' as const,
        additionalMs: 600_000,
      },
    };

    const absent = getFriendlyEventDisplay(baseWatchdogEvent);
    expect(absent.summary).toBe('Time check unreachable — granted 10 more minutes anyway.');

    const noneEvent = {
      ...baseWatchdogEvent,
      data: { ...baseWatchdogEvent.data, injectionSuspected: 'none' as const },
    };
    expect(getFriendlyEventDisplay(noneEvent).summary).toBe(
      'Time check unreachable — granted 10 more minutes anyway. Injection suspicion: none.',
    );

    const warnEvent = {
      ...baseWatchdogEvent,
      data: { ...baseWatchdogEvent.data, injectionSuspected: 'warn' as const },
    };
    expect(getFriendlyEventDisplay(warnEvent).summary).toBe(
      'Time check unreachable — granted 10 more minutes anyway. Injection suspicion: warning.',
    );

    const overrideEvent = {
      ...baseWatchdogEvent,
      data: { ...baseWatchdogEvent.data, injectionSuspected: 'override' as const },
    };
    expect(getFriendlyEventDisplay(overrideEvent).summary).toBe(
      'Time check unreachable — granted 10 more minutes anyway. Injection suspicion: override.',
    );
  });

  it('renders judge_decision_stale_skip as an info diagnostic for kill decisions', () => {
    expect(getFriendlyEventDisplay(EVENT_BY_KIND.judge_decision_stale_skip)).toEqual({
      displayKind: 'judge_decision_stale_skip',
      summary: 'A time check result was ignored because the tool had already finished.',
      tone: 'info',
    });
  });

  it('renders judge_decision_stale_skip with extension copy for stale extend decisions', () => {
    const event: Extract<DiagnosticEventEntry, { kind: 'judge_decision_stale_skip' }> = {
      ...EVENT_BY_KIND.judge_decision_stale_skip,
      data: { boundToolUseId: 'toolu_stale_extend', decision: 'extend' },
    };
    expect(getFriendlyEventDisplay(event)).toEqual({
      displayKind: 'judge_decision_stale_skip',
      summary: 'A time check extension was ignored because the tool had already finished.',
      tone: 'info',
    });
  });

  it('renders judge_decision_stale_skip with extension copy for stale failed_extended decisions', () => {
    const event: Extract<DiagnosticEventEntry, { kind: 'judge_decision_stale_skip' }> = {
      ...EVENT_BY_KIND.judge_decision_stale_skip,
      data: { boundToolUseId: 'toolu_stale_failed', decision: 'failed_extended' },
    };
    expect(getFriendlyEventDisplay(event)).toEqual({
      displayKind: 'judge_decision_stale_skip',
      summary: 'A time check extension was ignored because the tool had already finished.',
      tone: 'info',
    });
  });

  it('renders subagent_internal_timeout_recovered with the agent name when present', () => {
    expect(getFriendlyEventDisplay(EVENT_BY_KIND.subagent_internal_timeout_recovered)).toEqual({
      displayKind: 'subagent_internal_timeout_recovered',
      summary: 'Subagent "forager" ran out of time and the response continued without it.',
      tone: 'info',
    });
  });

  it('renders subagent_internal_timeout_recovered with the unnamed fallback when no agentName', () => {
    const event: Extract<DiagnosticEventEntry, { kind: 'subagent_internal_timeout_recovered' }> = {
      ...EVENT_BY_KIND.subagent_internal_timeout_recovered,
      data: {
        toolUseId: 'toolu_subagent_no_name',
        elapsedMs: 200_000,
        priorTimeoutCount: 1,
      },
    };
    expect(getFriendlyEventDisplay(event)).toEqual({
      displayKind: 'subagent_internal_timeout_recovered',
      summary: 'A subagent ran out of time and the response continued without it.',
      tone: 'info',
    });
  });

  it('renders abort_event with brand voice for watchdog reasons, and NEVER renders reason', () => {
    const judgeKilledEvent = {
      ...EVENT_BY_KIND.abort_event,
      data: { ...EVENT_BY_KIND.abort_event.data, reason: 'judge_killed' as const }
    };
    const display1 = getFriendlyEventDisplay(judgeKilledEvent);
    expect(display1.summary).toBe('A time check stopped the response after sustained silence.');
    expect(display1.summary).not.toContain('judge_killed');

    const consecutiveEvent = {
      ...EVENT_BY_KIND.abort_event,
      data: { ...EVENT_BY_KIND.abort_event.data, reason: 'consecutive_fail_open_cap' as const }
    };
    const display2 = getFriendlyEventDisplay(consecutiveEvent);
    expect(display2.summary).toBe('A time check stopped the response after failing to connect multiple times.');
    expect(display2.summary).not.toContain('consecutive_fail_open_cap');

    const toolCapEvent = {
      ...EVENT_BY_KIND.abort_event,
      data: { ...EVENT_BY_KIND.abort_event.data, reason: 'tool_cancelled_cap' as const }
    };
    expect(getFriendlyEventDisplay(toolCapEvent).summary).toBe('A tool kept getting stuck, so the response was stopped.');

    const unresponsiveEvent = {
      ...EVENT_BY_KIND.abort_event,
      data: { ...EVENT_BY_KIND.abort_event.data, reason: 'tool_cancel_unresponsive' as const }
    };
    expect(getFriendlyEventDisplay(unresponsiveEvent).summary).toBe('A cancelled tool did not stop cleanly, so the response was stopped.');

    const repeatedTimeoutEvent = {
      ...EVENT_BY_KIND.abort_event,
      data: { ...EVENT_BY_KIND.abort_event.data, reason: 'tool_repeated_timeout' as const }
    };
    expect(getFriendlyEventDisplay(repeatedTimeoutEvent).summary).toBe('A subagent kept running out of time, so the response was stopped.');

    const defaultAbort = {
      ...EVENT_BY_KIND.abort_event,
      data: { ...EVENT_BY_KIND.abort_event.data, reason: 'user_cancel' as const }
    };
    const display3 = getFriendlyEventDisplay(defaultAbort);
    expect(display3.summary).toBe('A response stopped before finishing.');
    expect(display3.summary).not.toContain('user_cancel');
  });

  it('renders a warning when a diagnostic event kind engages its cap', () => {
    expect(getFriendlyEventDisplay(EVENT_BY_KIND.events_per_kind_cap_engaged)).toEqual({
      displayKind: 'events_per_kind_cap_engaged',
      summary: 'Diagnostic ledger ceiling engaged for "continuity_transition" (cap: 2000). New events still recorded.',
      tone: 'warning',
    });
  });
});

function knownCondition(
  ts: number,
  level: Extract<DiagnosticEventEntry, { kind: 'known_condition' }>['data']['level'],
): Extract<DiagnosticEventEntry, { kind: 'known_condition' }> {
  return {
    ...baseEvent(ts),
    kind: 'known_condition',
    data: {
      condition: 'model_error',
      level,
    },
  };
}

function cooldownEnter(
  ts: number,
  scope: Extract<DiagnosticEventEntry, { kind: 'cooldown_enter' }>['data']['scope'],
): Extract<DiagnosticEventEntry, { kind: 'cooldown_enter' }> {
  return {
    ...baseEvent(ts),
    kind: 'cooldown_enter',
    data: {
      scope,
      untilMs: ts + 1000,
      retryAfterProvided: false,
      durationMs: 1000,
    },
  };
}

function baseEvent(ts: number) {
  return {
    v: DIAGNOSTIC_EVENT_SCHEMA_VERSION,
    ts,
    surface: 'desktop' as const,
  };
}
