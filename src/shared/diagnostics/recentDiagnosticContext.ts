import { z } from 'zod';

export const DiagnosticEventKindSchema = z.enum([
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

export const DiagnosticEventEntrySchema = z
  .object({
    v: z.number().int(),
    ts: z.number().int(),
    surface: z.enum(['desktop', 'cloud', 'mobile', 'unknown']),
    tid: z.string().optional(),
    sid: z.string().optional(),
    kind: DiagnosticEventKindSchema,
    data: z.record(z.string(), z.unknown()),
  })
  .passthrough();

export const RecentDiagnosticContextSchema = z.object({
  windowHours: z.number().int().min(1).max(168),
  limit: z.number().int().min(1).max(20),
  nowMs: z.number().int(),
  counts: z.partialRecord(DiagnosticEventKindSchema, z.number().int()).nullable(),
  lastTimes: z.partialRecord(DiagnosticEventKindSchema, z.number().int()).nullable(),
  entriesByKind: z.partialRecord(DiagnosticEventKindSchema, z.array(DiagnosticEventEntrySchema)),
  totalEvents: z.number().int(),
  readerAvailable: z.boolean(),
});

export type DiagnosticEventKind = z.infer<typeof DiagnosticEventKindSchema>;
export type DiagnosticEventEntry = z.infer<typeof DiagnosticEventEntrySchema>;
export type RecentDiagnosticContext = z.infer<typeof RecentDiagnosticContextSchema>;
