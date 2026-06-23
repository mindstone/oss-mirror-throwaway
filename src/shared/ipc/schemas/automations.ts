import { DateTime } from 'luxon';
import { z } from 'zod';
import { AgentEventSchema, AgentSessionSchema, AgentTurnMessageSchema } from './agent';
import { AGENT_ERROR_KINDS } from '@shared/utils/agentErrorCatalog';
import {
  AUTOMATION_ADMISSION_BLOCK_CODES,
  AUTOMATION_ADMISSION_BLOCK_SOURCES,
  ACCESS_RULES_STATUSES,
  AUTOMATION_EVENT_TYPES,
  AUTOMATION_RUN_STATUSES,
  AUTOMATION_TRIGGERS,
  SYSTEM_AUTOMATION_TYPES,
} from '../../types/automations';
import type { AutomationScheduleShape } from '../../types/automations';
import { PROVIDER_CREDENTIAL_SOURCES } from '../../types/providerRoute';
import { FINISH_LINE_MAX_LENGTH } from '@shared/utils/finishLine';

const HHMM_SCHEMA = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'time must be HH:mm 24-hour format');

const ISO_DATE_SCHEMA = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((s) => !Number.isNaN(new Date(`${s}T00:00:00Z`).getTime()), {
    message: 'must be a valid ISO date (YYYY-MM-DD)',
  });

/** Automation schedule schema */
export const AutomationScheduleSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('hourly'),
    minute: z.number().int().min(0).max(59),
  }),
  z.object({
    type: z.literal('daily'),
    time: HHMM_SCHEMA,
    additionalTimes: z.array(HHMM_SCHEMA).optional(),
  }),
  z.object({
    type: z.literal('every_n_days'),
    intervalDays: z.number().int().min(1),
    time: HHMM_SCHEMA,
    anchorDate: ISO_DATE_SCHEMA,
  }),
  z.object({
    type: z.literal('weekly'),
    daysOfWeek: z.array(z.number().int().min(0).max(6)),
    time: HHMM_SCHEMA,
  }),
  z.object({
    type: z.literal('monthly'),
    daysOfMonth: z.array(z.number().int().min(1).max(31)),
    time: HHMM_SCHEMA,
    runOnLastDayIfShorter: z.boolean().optional(),
  }),
  z.object({
    type: z.literal('event'),
    eventType: z.enum([...AUTOMATION_EVENT_TYPES]),
  }),
  z.object({
    type: z.literal('once'),
    dateTime: z.string().refine((s) => DateTime.fromISO(s).isValid, {
      message: 'dateTime must be a valid ISO 8601 datetime',
    }),
  }),
]);
export type AutomationScheduleUnbranded = z.infer<typeof AutomationScheduleSchema>;
export type AutomationSchedule = AutomationScheduleUnbranded & {
  readonly __brand: 'AutomationSchedule';
};

/**
 * Compile-time drift guard between the two `AutomationSchedule` declarations:
 *   - manual 7-branch union `AutomationScheduleShape` in
 *     `src/shared/types/automations.ts`
 *   - `z.infer`-derived `AutomationScheduleUnbranded` here
 *
 * The pair is intentionally redundant — the branded `AutomationSchedule`
 * is mirrored across files so neither has to depend on the other at type
 * resolution time. This bidirectional `extends` assertion fires at compile
 * time if the two ever drift (e.g. someone adds a branch to one without
 * the other). Zero runtime cost.
 *
 * If this evaluates to `never`, `npm run lint:ts` will fail with a clear
 * error pointing at this line; widen the failing side to match.
 */
// `[T]` tuple wrapping is REQUIRED — bare `T extends U` distributes over
// union members and would silently return `true | never` (= `true`) even on
// drift. The tuple form forces a single non-distributive equality check.
// eslint-disable-next-line @typescript-eslint/naming-convention -- intentionally underscore-prefixed to mark a private compile-time-only assertion alias
type _AutomationScheduleDualDeclarationDriftGuard =
  [AutomationScheduleShape] extends [AutomationScheduleUnbranded]
    ? [AutomationScheduleUnbranded] extends [AutomationScheduleShape]
      ? true
      : never
    : never;
// Reference the alias so `noUnusedLocals` keeps the guard live.
const _AUTOMATION_SCHEDULE_DUAL_DECLARATION_DRIFT_GUARD: _AutomationScheduleDualDeclarationDriftGuard = true;
void _AUTOMATION_SCHEDULE_DUAL_DECLARATION_DRIFT_GUARD;

export interface AutomationScheduleQuarantineEntry {
  definition: unknown;
  reason: string;
  quarantinedAt: number;
  sourceVersion?: number;
}

export const AutomationScheduleQuarantineEntrySchema = z.object({
  definition: z.unknown(),
  reason: z.string(),
  quarantinedAt: z.number(),
  sourceVersion: z.number().optional(),
});

/** Access rules status schema */
export const AccessRulesStatusSchema = z.enum([...ACCESS_RULES_STATUSES]);

/** Blocked action schema — details of a tool call blocked by access rules */
export const BlockedActionSchema = z.object({
  toolId: z.string(),
  toolName: z.string(),
  reason: z.string(),
  timestamp: z.number(),
});

export const AutomationAdmissionBlockSchema = z.object({
  source: z.enum([...AUTOMATION_ADMISSION_BLOCK_SOURCES]),
  code: z.enum([...AUTOMATION_ADMISSION_BLOCK_CODES]),
  errorKind: z.enum(['connection-not-configured', 'rate_limit']),
  headlineClass: z.enum(['auth', 'subscription_entitlement']),
  provider: z.enum(['anthropic', 'openrouter', 'codex']),
  message: z.string(),
});

export const AutomationProviderReadinessSummarySchema = z.object({
  readiness: z.enum(['ready', 'blocked']),
  affectedAutomationCount: z.number().int().min(0),
  affectedAutomationIds: z.array(z.string()),
  blockedRunCount: z.number().int().min(0),
  sinceMs: z.number().nullable(),
  cause: AutomationAdmissionBlockSchema.nullable(),
});

/** Automation tool grant schema — a persistent tool approval scoped to an automation */
export const AutomationToolGrantSchema = z.object({
  id: z.string(),
  toolId: z.string(),
  createdAt: z.number(),
  createdFrom: z.enum(['approval', 'manual']),
});

/** Automation definition schema */
export const AutomationDefinitionSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string().optional(),
  filePath: z.string(),
  schedule: AutomationScheduleSchema,
  enabled: z.boolean(),
  catchUpIfMissed: z.boolean().optional(),
  createdAt: z.number(),
  updatedAt: z.number(),
  lastRunStatus: z.enum([...AUTOMATION_RUN_STATUSES]).optional(),
  lastRunAt: z.number().nullable().optional(),
  lastSuccessAt: z.number().nullable().optional(),
  nextRunAt: z.number().nullable().optional(),
  isSystem: z.boolean().optional(),
  systemType: z.enum([...SYSTEM_AUTOMATION_TYPES]).optional(),
  accessRules: z.string().optional(),
  accessRulesStatus: AccessRulesStatusSchema.optional(),
  toolApprovalGrants: z.array(AutomationToolGrantSchema).optional(),
  executeIn: z.enum(['local', 'cloud']).optional(),
  timezone: z.string().optional(),
  executor: z.enum(['llm', 'script']).optional(),
  scriptModule: z.string().optional(),
  model: z.string().optional(),
  thinkingModel: z.string().optional(),
  finishLine: z.string().max(FINISH_LINE_MAX_LENGTH).optional(),
});

/** Automation run schema */
export const AutomationRunSchema = z.object({
  id: z.string(),
  automationId: z.string(),
  startedAt: z.number(),
  completedAt: z.number().nullable().optional(),
  status: z.enum([...AUTOMATION_RUN_STATUSES]),
  trigger: z.enum([...AUTOMATION_TRIGGERS]),
  sessionId: z.string().nullable().optional(),
  error: z.string().nullable().optional(),
  eventsByTurn: z.record(z.string(), z.array(AgentEventSchema)).optional(),
  messages: z.array(AgentTurnMessageSchema).optional(),
  session: AgentSessionSchema.nullable().optional(),
  blockedActions: z.array(BlockedActionSchema).optional(),
  targetPeriodStart: z.number().optional(),
  admissionBlock: AutomationAdmissionBlockSchema.optional(),
  errorKind: z.enum([...AGENT_ERROR_KINDS]).optional(),
  limitScope: z.enum(['provider', 'plan', 'account']).optional(),
  credentialSource: z.enum(PROVIDER_CREDENTIAL_SOURCES).optional(),
  headlineClass: z.enum(['rate_limit', 'billing_quota', 'subscription_entitlement', 'auth', 'other']).optional(),
  rawError: z.string().optional(),
  rateLimitResetAtMs: z.number().optional(),
});

/** Session type filter for sidebar - 'all' shows both conversations and automations */
export const SessionTypeFilterSchema = z.enum(['all', 'conversations', 'automations']);
export type SessionTypeFilter = z.infer<typeof SessionTypeFilterSchema>;

/** Automation store state schema */
export const AutomationStoreStateSchema = z.object({
  version: z.number(),
  definitions: z.array(AutomationDefinitionSchema),
  runs: z.array(AutomationRunSchema),
  quarantined: z.array(AutomationScheduleQuarantineEntrySchema).default([]),
  /** Session type filter for sidebar (default: 'all') */
  sessionTypeFilter: SessionTypeFilterSchema,
});
export type AutomationStoreState = z.infer<typeof AutomationStoreStateSchema>;

/** Automation definition patch (for upsert) */
export const AutomationDefinitionPatchSchema = z.object({
  id: z.string().optional(),
  name: z.string().optional(),
  description: z.string().optional(),
  filePath: z.string().optional(),
  schedule: AutomationScheduleSchema.optional(),
  enabled: z.boolean().optional(),
  catchUpIfMissed: z.boolean().optional(),
  isSystem: z.boolean().optional(),
  systemType: z.enum([...SYSTEM_AUTOMATION_TYPES]).optional(),
  accessRules: z.string().optional(),
  accessRulesStatus: AccessRulesStatusSchema.optional(),
  toolApprovalGrants: z.array(AutomationToolGrantSchema).optional(),
  executeIn: z.enum(['local', 'cloud']).optional(),
  timezone: z.string().optional(),
  executor: z.enum(['llm', 'script']).optional(),
  scriptModule: z.string().optional(),
  model: z.string().optional(),
  thinkingModel: z.string().optional(),
  finishLine: z.string().max(FINISH_LINE_MAX_LENGTH).optional(),
});
