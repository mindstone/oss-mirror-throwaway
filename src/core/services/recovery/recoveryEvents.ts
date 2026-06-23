import { z } from 'zod';

import type {
  ExhaustedReason,
  LongContextFallbackTarget,
  RecoveryContext,
  RecoveryOutcome,
  RecoveryPhase,
  RecoveryState,
} from './recoveryStateMachine';

export type { RecoveryOutcome };

const phaseSchema = z.enum(['pre_activity', 'post_activity']);
export const exhaustedReasonSchema = z.enum([
  'depth_limit_reached',
  'attempt_limit_reached',
  'no_qualifying_profile',
  'rate_limited',
  'recovery_disabled',
  'no_messages_to_compact',
  'summary_generation_failed',
  'agent_loop_error_before_recovery',
  'agent_loop_error_after_recovery',
  'long_context_fallback_failed',
  'aborted',
]);

const recoveryTargetSchema = z.object({
  kind: z.enum(['model', 'profile']),
  profileId: z.string().optional(),
  profileName: z.string().optional(),
  modelName: z.string().optional(),
});

const lastResortReasonSchema = z.enum(['no_qualifying_profile', 'rate_limited']);
export const DEFAULT_RECOVERY_REVEAL_DURATION_MS = 3000;

const base = {
  turnId: z.string(),
  sessionId: z.string(),
  originalSessionId: z.string(),
  depth: z.number().int().min(0).max(4),
  attempt: z.number().int().min(0),
  totalCalls: z.number().int().min(0),
  timestamp: z.number(),
};

export const RecoveryOutboundEventSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('recovery:started'),
    ...base,
    phase: phaseSchema,
  }),
  z.object({
    type: z.literal('recovery:compacting'),
    ...base,
  }),
  z.object({
    type: z.literal('recovery:summary_ready'),
    ...base,
    summary: z.string(),
    revealDurationMs: z.number().int().min(0).optional(),
  }),
  z.object({
    type: z.literal('recovery:retrying'),
    ...base,
  }),
  z.object({
    type: z.literal('recovery:fallback_attempting'),
    ...base,
    target: recoveryTargetSchema,
  }),
  z.object({
    type: z.literal('recovery:fallback_succeeded'),
    ...base,
    target: recoveryTargetSchema,
  }),
  z.object({
    type: z.literal('recovery:skeleton_attempting'),
    ...base,
  }),
  z.object({
    type: z.literal('recovery:depth4_attempting'),
    ...base,
    profileId: z.string(),
    modelName: z.string(),
    costEstimate: z.literal('high'),
  }),
  z.object({
    type: z.literal('recovery:succeeded'),
    ...base,
    finalDepth: z.number().int().min(0).max(4),
    totalDurationMs: z.number().int().min(0),
  }),
  z.object({
    type: z.literal('recovery:failed'),
    ...base,
    error: z.string(),
    exhaustedReason: exhaustedReasonSchema,
  }),
  z.object({
    type: z.literal('recovery:last_resort_skipped'),
    ...base,
    reason: lastResortReasonSchema,
    userFacingTitle: z.string(),
    userFacingMessage: z.string(),
    action: z.string(),
  }),
]);

export type RecoveryOutboundEvent = z.infer<typeof RecoveryOutboundEventSchema>;
export type RecoveryTarget = z.infer<typeof recoveryTargetSchema>;

export const RECOVERY_OUTBOUND_EVENT_TYPES = [
  'recovery:started',
  'recovery:fallback_attempting',
  'recovery:fallback_succeeded',
  'recovery:compacting',
  'recovery:summary_ready',
  'recovery:retrying',
  'recovery:skeleton_attempting',
  'recovery:depth4_attempting',
  'recovery:succeeded',
  'recovery:failed',
  'recovery:last_resort_skipped',
] as const satisfies ReadonlyArray<RecoveryOutboundEvent['type']>;

type MutableEvent = {
  type: RecoveryOutboundEvent['type'];
  turnId: string;
  sessionId: string;
  originalSessionId: string;
  depth: number;
  attempt: number;
  totalCalls: number;
  timestamp: number;
  phase?: RecoveryPhase;
  target?: RecoveryTarget;
  summary?: string;
  revealDurationMs?: number;
  profileId?: string;
  modelName?: string;
  costEstimate?: 'high';
  finalDepth?: number;
  totalDurationMs?: number;
  error?: string;
  exhaustedReason?: ExhaustedReason;
  reason?: 'no_qualifying_profile' | 'rate_limited';
  userFacingTitle?: string;
  userFacingMessage?: string;
  action?: string;
};

function eventBase(ctx: RecoveryContext, totalCalls: number): Omit<MutableEvent, 'type'> {
  return {
    turnId: ctx.turnId,
    sessionId: ctx.sessionId,
    originalSessionId: ctx.originalSessionId,
    depth: ctx.depth,
    attempt: ctx.attempt,
    totalCalls,
    timestamp: Date.now(),
  };
}

function parseEvent(event: MutableEvent): RecoveryOutboundEvent {
  return RecoveryOutboundEventSchema.parse(event);
}

function normalizeTarget(target: LongContextFallbackTarget | RecoveryTarget | string): RecoveryTarget {
  if (typeof target !== 'string') return target;
  return { kind: 'model', modelName: target };
}

function defaultLastResortCopy(reason: 'no_qualifying_profile' | 'rate_limited') {
  if (reason === 'rate_limited') {
    return {
      userFacingTitle: 'Recovery model is cooling down',
      userFacingMessage: 'The recovery model is rate-limited, so Rebel stopped before making the situation more dramatic.',
      action: 'Try again shortly, or choose a different recovery model.',
    };
  }

  return {
    userFacingTitle: 'No recovery model available',
    userFacingMessage: 'Rebel could not find a large-context recovery model for this conversation.',
    action: 'Choose a recovery model in settings, then try again.',
  };
}

export function makeRecoveryStartedEvent(ctx: RecoveryContext, totalCalls: number): RecoveryOutboundEvent {
  return parseEvent({ type: 'recovery:started', ...eventBase(ctx, totalCalls), phase: ctx.phase });
}

export function makeRecoveryCompactingEvent(ctx: RecoveryContext, totalCalls: number, _phase: RecoveryPhase = ctx.phase): RecoveryOutboundEvent {
  return parseEvent({ type: 'recovery:compacting', ...eventBase(ctx, totalCalls) });
}

export function makeRecoverySummaryReadyEvent(
  ctx: RecoveryContext,
  totalCalls: number,
  summary: string,
  revealDurationMs = DEFAULT_RECOVERY_REVEAL_DURATION_MS,
): RecoveryOutboundEvent {
  return parseEvent({ type: 'recovery:summary_ready', ...eventBase(ctx, totalCalls), summary, revealDurationMs });
}

export function makeRecoveryRetryingEvent(ctx: RecoveryContext, totalCalls: number, _promptLength?: number): RecoveryOutboundEvent {
  return parseEvent({ type: 'recovery:retrying', ...eventBase(ctx, totalCalls) });
}

export function makeRecoveryFallbackAttemptingEvent(
  ctx: RecoveryContext,
  totalCalls: number,
  target: LongContextFallbackTarget | RecoveryTarget | string,
): RecoveryOutboundEvent {
  return parseEvent({ type: 'recovery:fallback_attempting', ...eventBase(ctx, totalCalls), target: normalizeTarget(target) });
}

export function makeRecoveryFallbackSucceededEvent(
  ctx: RecoveryContext,
  totalCalls: number,
  target: LongContextFallbackTarget | RecoveryTarget | string = ctx.longContextFallbackTarget ?? 'recovery model',
): RecoveryOutboundEvent {
  return parseEvent({ type: 'recovery:fallback_succeeded', ...eventBase(ctx, totalCalls), target: normalizeTarget(target) });
}

export function makeRecoverySkeletonAttemptingEvent(ctx: RecoveryContext, totalCalls: number, _messageCount?: number): RecoveryOutboundEvent {
  return parseEvent({ type: 'recovery:skeleton_attempting', ...eventBase(ctx, totalCalls) });
}

export function makeRecoveryDepth4AttemptingEvent(
  ctx: RecoveryContext,
  totalCalls: number,
  profileId: string,
  modelName = profileId,
): RecoveryOutboundEvent {
  return parseEvent({
    type: 'recovery:depth4_attempting',
    ...eventBase(ctx, totalCalls),
    profileId,
    modelName,
    costEstimate: 'high',
  });
}

export function makeRecoverySucceededEvent(
  ctx: RecoveryContext,
  totalCalls: number,
  finalDepth = ctx.depth,
  totalDurationMs = 0,
): RecoveryOutboundEvent {
  return parseEvent({ type: 'recovery:succeeded', ...eventBase(ctx, totalCalls), finalDepth, totalDurationMs });
}

export function makeRecoveryFailedEvent(
  ctx: RecoveryContext,
  totalCalls: number,
  exhaustedReason: ExhaustedReason,
  error = `Recovery failed: ${exhaustedReason}`,
): RecoveryOutboundEvent {
  return parseEvent({ type: 'recovery:failed', ...eventBase(ctx, totalCalls), error, exhaustedReason });
}

export function makeRecoveryLastResortSkippedEvent(
  ctx: RecoveryContext,
  totalCalls: number,
  reason: 'no_qualifying_profile' | 'rate_limited',
  copy = defaultLastResortCopy(reason),
): Extract<RecoveryOutboundEvent, { type: 'recovery:last_resort_skipped' }> {
  return parseEvent({
    type: 'recovery:last_resort_skipped',
    ...eventBase(ctx, totalCalls),
    reason,
    ...copy,
  }) as Extract<RecoveryOutboundEvent, { type: 'recovery:last_resort_skipped' }>;
}

export interface RecoveryStateSnapshot {
  turnId: string;
  sessionId: string;
  originalSessionId: string;
  state: RecoveryState;
}
