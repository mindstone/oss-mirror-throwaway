import type { AgentTurnMessage } from '@shared/types';
import { MAX_COMPACTION_ATTEMPTS, MAX_COMPACTION_DEPTH } from '@core/utils/compactionUtils';

export { MAX_COMPACTION_ATTEMPTS, MAX_COMPACTION_DEPTH };

export type RecoveryPhase = 'pre_activity' | 'post_activity';

export type ExhaustedReason =
  | 'depth_limit_reached'
  | 'attempt_limit_reached'
  | 'no_qualifying_profile'
  | 'rate_limited'
  | 'recovery_disabled'
  | 'no_messages_to_compact'
  | 'summary_generation_failed'
  | 'agent_loop_error_before_recovery'
  | 'agent_loop_error_after_recovery'
  | 'long_context_fallback_failed'
  | 'aborted';

export interface LongContextFallbackTarget {
  kind: 'model' | 'profile';
  modelName?: string;
  profileId?: string;
  profileName?: string;
}

export interface RecoveryOutcome {
  kind: 'success' | 'failure_terminal' | 'failure_skipped';
  totalCalls: number;
  finalState: RecoveryState;
  exhaustedReason?: ExhaustedReason;
}

export type RecoveryState =
  | { kind: 'idle' }
  | { kind: 'long_context_fallback'; target: LongContextFallbackTarget }
  | { kind: 'compacting'; depth: number; attempt: number }
  | { kind: 'skeleton'; attempt: number }
  | { kind: 'recovery_model'; profileId: string }
  | { kind: 'terminal_success'; outcome: RecoveryOutcome }
  | { kind: 'terminal_failure'; reason: string; exhaustedReason: ExhaustedReason };

export interface RecoveryContext {
  phase: RecoveryPhase;
  depth: number;
  attempt: number;
  longContextFallbackAttempted: boolean;
  skeletonAttempted: boolean;
  isRecoveryModelAttempt: boolean;
  enableRecovery: boolean;
  sessionId: string;
  turnId: string;
  originalSessionId: string;
  originalPrompt: string;
  abortSignal: AbortSignal;
  messages?: ReadonlyArray<AgentTurnMessage>;
  longContextFallbackTarget?: LongContextFallbackTarget | null;
}

export interface RecoveryEvent {
  kind:
    | 'overflow'
    | 'fallback_failed'
    | 'compact_succeeded'
    | 'compact_failed'
    | 'summary_generated'
    | 'skeleton_succeeded'
    | 'recovery_model_succeeded'
    | 'recovery_model_failed'
    | 'abort'
    | 'no_qualifying_profile'
    | 'rate_limited';
  payload?: Record<string, unknown>;
}

const terminalFailure = (
  reason: string,
  exhaustedReason: ExhaustedReason,
): RecoveryState => ({ kind: 'terminal_failure', reason, exhaustedReason });

const terminalSuccess = (state: RecoveryState): RecoveryState => ({
  kind: 'terminal_success',
  outcome: { kind: 'success', totalCalls: 0, finalState: state },
});

export function canEnterDepth4(ctx: RecoveryContext): boolean {
  return ctx.isRecoveryModelAttempt !== true;
}

export function shouldSkipDepth4(_ctx: RecoveryContext, hasQualifyingProfile: boolean): boolean {
  return hasQualifyingProfile === false;
}

function enterDepth4OrFail(ctx: RecoveryContext): RecoveryState {
  if (!canEnterDepth4(ctx)) {
    return terminalFailure('Depth-4 recovery already attempted.', 'depth_limit_reached');
  }
  return { kind: 'recovery_model', profileId: 'pending' };
}

function nextCompactionState(depth: number, attempt: number, ctx: RecoveryContext): RecoveryState {
  if (attempt < MAX_COMPACTION_ATTEMPTS) {
    return { kind: 'compacting', depth, attempt: attempt + 1 };
  }

  if (depth < MAX_COMPACTION_DEPTH) {
    return { kind: 'compacting', depth: depth + 1, attempt: 1 };
  }

  return enterDepth4OrFail(ctx);
}

export function transition(
  state: RecoveryState,
  event: RecoveryEvent,
  ctx: RecoveryContext,
): RecoveryState {
  if (event.kind === 'abort' || ctx.abortSignal.aborted) {
    return terminalFailure('Recovery aborted.', 'aborted');
  }

  if (!ctx.enableRecovery && event.kind === 'overflow') {
    return terminalFailure('Recovery disabled.', 'recovery_disabled');
  }

  if (event.kind === 'no_qualifying_profile') {
    return terminalFailure('No qualifying recovery profile.', 'no_qualifying_profile');
  }

  if (event.kind === 'rate_limited') {
    return terminalFailure('Recovery model rate limited.', 'rate_limited');
  }

  if (event.kind === 'compact_succeeded' || event.kind === 'summary_generated' || event.kind === 'skeleton_succeeded' || event.kind === 'recovery_model_succeeded') {
    return terminalSuccess(state);
  }

  if (event.kind === 'recovery_model_failed') {
    return terminalFailure('Recovery model failed.', 'depth_limit_reached');
  }

  switch (state.kind) {
    case 'idle': {
      if (event.kind !== 'overflow') return state;

      if (ctx.phase === 'pre_activity') {
        if (!ctx.longContextFallbackAttempted) {
          if (ctx.longContextFallbackTarget) {
            return {
              kind: 'long_context_fallback',
              target: ctx.longContextFallbackTarget,
            };
          }
          return { kind: 'compacting', depth: ctx.depth + 1, attempt: 1 };
        }
        return enterDepth4OrFail(ctx);
      }

      if (ctx.depth >= MAX_COMPACTION_DEPTH) {
        return enterDepth4OrFail(ctx);
      }

      return { kind: 'compacting', depth: ctx.depth + 1, attempt: 1 };
    }

    case 'long_context_fallback': {
      if (event.kind !== 'fallback_failed' && event.kind !== 'overflow') return state;
      if (ctx.phase === 'pre_activity') return enterDepth4OrFail(ctx);
      return { kind: 'compacting', depth: ctx.depth + 1, attempt: 1 };
    }

    case 'compacting': {
      if (event.kind === 'compact_failed' || event.kind === 'fallback_failed' || event.kind === 'overflow') {
        const allowSkeleton = event.payload?.allowSkeleton === true;
        if (allowSkeleton && !ctx.skeletonAttempted) {
          return { kind: 'skeleton', attempt: 1 };
        }
        return nextCompactionState(state.depth, state.attempt, ctx);
      }
      return state;
    }

    case 'skeleton': {
      if (event.kind === 'compact_failed' || event.kind === 'fallback_failed' || event.kind === 'overflow') {
        return enterDepth4OrFail(ctx);
      }
      return state;
    }

    case 'recovery_model': {
      if (event.kind === 'overflow') {
        return terminalFailure('Depth-4 recovery already attempted.', 'depth_limit_reached');
      }
      return state;
    }

    case 'terminal_failure':
    case 'terminal_success':
      return state;
  }
}
