import type { AgentEvent, AgentSession, AgentTurnMessage } from './agent';

// =============================================================================
// User Tasks (Scratchpad Tasks Panel)
// =============================================================================

export type UserTaskStatus = 'todo' | 'in_progress' | 'done' | 'cancelled';

export type UserTaskPriority = 'urgent' | 'high' | 'medium' | 'low' | 'none';

export interface UserTask {
  id: string;
  title: string;
  description?: string;
  status: UserTaskStatus;
  dueDate?: number | null;
  priority?: UserTaskPriority;
  labels?: string[];
  // Sync fields for Linear/external systems
  externalId?: string | null;
  externalUrl?: string | null;
  syncSource?: string | null;
  syncedAt?: number | null;
  // Metadata
  createdAt: number;
  updatedAt: number;
  completedAt?: number | null;
}

export interface UserTasksState {
  version: number;
  tasks: UserTask[];
}

/**
 * Event types that can trigger automations.
 * - 'transcript-ready': Any meeting transcript saved (Rebel Notetaker or external provider)
 * - 'transcript-ready:rebel': Only Rebel Notetaker transcripts
 * - 'transcript-ready:external': Only external provider transcripts (Fireflies, Fathom)
 * - 'transcript-distribution-ready': Transcript is at final quality and ready for distribution to spaces
 */
export const AUTOMATION_EVENT_TYPES = [
  'transcript-ready',
  'transcript-ready:rebel',
  'transcript-ready:external',
  'transcript-distribution-ready',
] as const;
export type AutomationEventType = typeof AUTOMATION_EVENT_TYPES[number];

/**
 * The 7-branch shape of an automation schedule.
 *
 * Mirrored by `z.infer<typeof AutomationScheduleSchema>` in
 * `src/shared/ipc/schemas/automations.ts` (re-exported as
 * `AutomationScheduleUnbranded`). The two declarations are kept structurally
 * identical by a compile-time drift guard
 * (`_AutomationScheduleDualDeclarationDriftGuard`) co-located with the
 * schema. Exported for that guard; consumers should use the branded
 * `AutomationSchedule` instead.
 */
export type AutomationScheduleShape =
  | { type: 'hourly'; minute: number }
  | { type: 'daily'; time: string; additionalTimes?: string[] }
  | { type: 'every_n_days'; intervalDays: number; time: string; anchorDate: string }
  | { type: 'weekly'; daysOfWeek: number[]; time: string }
  | { type: 'monthly'; daysOfMonth: number[]; time: string; runOnLastDayIfShorter?: boolean }
  | { type: 'once'; dateTime: string }
  | { type: 'event'; eventType: AutomationEventType };

export type AutomationSchedule = AutomationScheduleShape & {
  readonly __brand: 'AutomationSchedule';
};

export interface AutomationScheduleQuarantineEntry {
  definition: unknown;
  reason: string;
  quarantinedAt: number;
  sourceVersion?: number;
}

export const AUTOMATION_RUN_STATUSES = [
  'pending',
  'running',
  'success',
  'completed_with_blocks',
  'failure',
  'provider_not_ready',
  'blocked_by_security',
  'cancelled',
] as const;
export type AutomationRunStatus = typeof AUTOMATION_RUN_STATUSES[number];

export const AUTOMATION_ADMISSION_BLOCK_SOURCES = [
  'provider-readiness',
] as const;
export type AutomationAdmissionBlockSource = typeof AUTOMATION_ADMISSION_BLOCK_SOURCES[number];

export const AUTOMATION_ADMISSION_BLOCK_CODES = [
  'anthropic_missing_api_key',
  'openrouter_disconnected',
  'codex_disconnected',
] as const;
export type AutomationAdmissionBlockCode = typeof AUTOMATION_ADMISSION_BLOCK_CODES[number];

export interface AutomationAdmissionBlock {
  source: AutomationAdmissionBlockSource;
  code: AutomationAdmissionBlockCode;
  errorKind: 'connection-not-configured' | 'rate_limit';
  headlineClass: 'auth' | 'subscription_entitlement';
  provider: 'anthropic' | 'openrouter' | 'codex';
  message: string;
}

export interface AutomationProviderReadinessSummary {
  readiness: 'ready' | 'blocked';
  /**
   * Enabled, schedule/catch-up-eligible LLM automations that would be gated by
   * the current provider credential state, even if no blocked run exists yet.
   */
  affectedAutomationCount: number;
  affectedAutomationIds: string[];
  /**
   * Historical footprint for the current readiness cause.
   */
  blockedRunCount: number;
  sinceMs: number | null;
  cause: AutomationAdmissionBlock | null;
}

export const AUTOMATION_TRIGGERS = [
  'schedule',
  'manual',
  'launch',
  'catch-up',
  'event',
  'rules-update',
] as const;
export type AutomationTrigger = typeof AUTOMATION_TRIGGERS[number];

export const SYSTEM_AUTOMATION_TYPES = [
  'use-case-refresh',
  'wins-learnings-uncover',
  'community-highlights',
  'calendar-sync',
  'source-capture',
  'transcript-analysis',
  'transcript-distribution',
  'morning-triage',
  'community-video-recs',
  'focus-weekly-prep',
  'focus-monthly-review',
  'space-maintenance',
  'chief-of-staff-hygiene',
] as const;
export type SystemAutomationType = typeof SYSTEM_AUTOMATION_TYPES[number];

export const ACCESS_RULES_STATUSES = [
  'pending_review',
  'approved',
  'update_suggested',
  'generation_failed',
] as const;
export type AccessRulesStatus = typeof ACCESS_RULES_STATUSES[number];

export interface BlockedAction {
  toolId: string;
  toolName: string;
  reason: string;
  timestamp: number;
}

/** A persistent tool approval grant scoped to a specific automation */
export interface AutomationToolGrant {
  id: string;
  toolId: string;
  createdAt: number;
  createdFrom: 'approval' | 'manual';
}

export interface AutomationDefinition {
  id: string;
  name: string;
  description?: string;
  filePath: string;
  schedule: AutomationSchedule;
  enabled: boolean;
  /** If true, run automation on app launch/resume if scheduled time was missed. Default: true for daily+, false for hourly */
  catchUpIfMissed?: boolean;
  createdAt: number;
  updatedAt: number;
  lastRunStatus?: AutomationRunStatus;
  lastRunAt?: number | null;
  lastSuccessAt?: number | null;
  nextRunAt?: number | null;
  /** System automations are created by Rebel, not the user */
  isSystem?: boolean;
  /** Type of system automation for special handling */
  systemType?: SystemAutomationType;
  /** @deprecated Migrated to Safety Prompt. Kept for migration compatibility. */
  accessRules?: string;
  /** @deprecated Migrated to Safety Prompt. Kept for migration compatibility. */
  accessRulesStatus?: AccessRulesStatus;
  /** @deprecated Migrated to Safety Prompt. Kept for migration compatibility. */
  toolApprovalGrants?: AutomationToolGrant[];
  /** Where this automation executes. Default: 'local' (desktop). */
  executeIn?: 'local' | 'cloud';
  /** User's IANA timezone for cloud scheduling (captured when executeIn is set to 'cloud'). */
  timezone?: string;
  /**
   * Which executor runs this automation.
   * `undefined` is semantically equivalent to `'llm'` — it is NOT a third meaningful state.
   * Do not introduce branches that treat `undefined` differently from `'llm'` (e.g., `executor === 'llm'` literal checks).
   * Prefer `(automation.executor ?? 'llm') === 'llm'` or exhaustive switches that normalize `undefined → 'llm'`.
   */
  executor?: 'llm' | 'script';
  /**
   * Script module identifier to run when `executor === 'script'`.
   * Kept optional here for additive persistence compatibility; runtime validation happens at dispatch time.
   */
  scriptModule?: string;
  /** Optional per-automation working model override. */
  model?: string;
  /** Optional per-automation thinking model override. */
  thinkingModel?: string;
  /**
   * Default success criterion inherited by sessions spawned from this
   * automation. See `docs/plans/260515_finish_line.md`.
   */
  finishLine?: string;
}

export interface AutomationRunTokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
}

export interface AutomationRun {
  id: string;
  automationId: string;
  startedAt: number;
  completedAt?: number | null;
  status: AutomationRunStatus;
  trigger: AutomationTrigger;
  sessionId?: string | null;
  error?: string | null;
  eventsByTurn?: Record<string, AgentEvent[]>;
  messages?: AgentTurnMessage[];
  session?: AgentSession | null;
  /** Details of tool calls blocked by safety evaluation */
  blockedActions?: BlockedAction[];
  /** Aggregated token usage across all turns in this run */
  tokenUsage?: AutomationRunTokenUsage;
  /** Estimated cost in USD based on token usage (approximate, uses hardcoded model pricing) */
  estimatedCostUsd?: number;
  /** Period start anchor (epoch ms) for Focus automations — Monday 00:00 (weekly) or 1st-of-month 00:00 (monthly) */
  targetPeriodStart?: number;
  /**
   * Scheduler-side admission block metadata for runs that never spawned an agent turn.
   * Used by aggregate readiness surfacing in the automations panel.
   */
  admissionBlock?: AutomationAdmissionBlock;
  /** Optional structural error metadata mirrored from terminal error events. */
  errorKind?: Extract<AgentEvent, { type: 'error' }>['errorKind'];
  limitScope?: Extract<AgentEvent, { type: 'error' }>['limitScope'];
  credentialSource?: Extract<AgentEvent, { type: 'error' }>['credentialSource'];
  headlineClass?: Extract<AgentEvent, { type: 'error' }>['headlineClass'];
  /** Top-level raw upstream error body (already redacted/truncated upstream). */
  rawError?: string;
  /** Cached from rate-limit metadata when present for reset-window deferral checks. */
  rateLimitResetAtMs?: number;
}

/** Session type filter for sidebar - 'all' shows both conversations and automations */
export type SessionTypeFilter = 'all' | 'conversations' | 'automations';

export type AutomationStoreState = {
  version: number;
  definitions: AutomationDefinition[];
  runs: AutomationRun[];
  quarantined: AutomationScheduleQuarantineEntry[];
  /** Session type filter for sidebar (default: 'all') */
  sessionTypeFilter: SessionTypeFilter;
};

export type AutomationDefinitionInput = Partial<
  Omit<AutomationDefinition, 'createdAt' | 'updatedAt' | 'lastRunStatus' | 'lastRunAt' | 'lastSuccessAt' | 'nextRunAt'>
> & {
  id?: string;
  schedule: AutomationSchedule;
};

/**
 * Slim cloud→desktop delta for cloud-executed automations.
 *
 * Cloud is the executor for `executeIn: 'cloud'` automations but desktop owns
 * the automations store. Instead of pushing a full `automation:state` snapshot
 * (which would overwrite desktop's local-mode `runs[]`), cloud emits per-event
 * deltas that the desktop scheduler merges into its in-memory state without
 * touching timers or rescheduling.
 *
 * See `docs-private/investigations/260515_cloud_automation_bugs.md` § BUG 1+11.
 */
export type CloudAutomationDelta =
  | {
      type: 'automation-run-recorded';
      automationId: string;
      lastRunAt: number;
      lastRunStatus: AutomationRunStatus;
      lastSuccessAt?: number | null;
      run: AutomationRun;
    }
  | {
      type: 'automation-next-run-updated';
      automationId: string;
      nextRunAt: number;
    };
