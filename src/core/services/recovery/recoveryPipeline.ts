import type { AgentEvent, AgentTurnMessage } from '@shared/types';
import { createScopedLogger } from '@core/logger';
import { ignoreBestEffortCleanup } from '@shared/utils/intentionalSwallow';
import {
  buildEnhancedPrompt,
  buildEnhancedPromptWithWindow,
  sanitizeTaskContext,
} from '@core/utils/compactionUtils';

import type {
  AgentLoopErrorOutcome,
  AgentLoopOptions,
  RecoveryAdapter,
  RecoveryProfile,
} from './recoveryAdapter';
import {
  DEFAULT_RECOVERY_REVEAL_DURATION_MS,
  makeRecoveryCompactingEvent,
  makeRecoveryDepth4AttemptingEvent,
  makeRecoveryFailedEvent,
  makeRecoveryFallbackAttemptingEvent,
  makeRecoveryFallbackSucceededEvent,
  makeRecoveryLastResortSkippedEvent,
  makeRecoveryRetryingEvent,
  makeRecoverySkeletonAttemptingEvent,
  makeRecoveryStartedEvent,
  makeRecoverySucceededEvent,
  makeRecoverySummaryReadyEvent,
} from './recoveryEvents';
import {
  canEnterDepth4,
  type ExhaustedReason,
  type LongContextFallbackTarget,
  type RecoveryContext,
  type RecoveryOutcome,
  type RecoveryPhase,
  type RecoveryState,
  transition,
} from './recoveryStateMachine';
import type { RecoveryOutboundEvent } from './recoveryEvents';

const log = createScopedLogger({ service: 'recoveryPipeline' });

// See docs/project/ARCHITECTURE_CONTEXT_OVERFLOW_RECOVERY.md — Intent & Design Rationale (REBEL-5BM).
export interface RunRecoveryPipelineInput {
  phase: RecoveryPhase;
  prompt: string;
  agentLoopOptions: AgentLoopOptions;
  enableRecovery: boolean;
  ctx: RecoveryContext;
  adapter: RecoveryAdapter;
  abortSignal: AbortSignal;
  /** Main-process reveal delay between summary_ready and retrying. Defaults to 3000ms. */
  revealDurationMs?: number;
}

function terminalOutcome(
  state: RecoveryState,
  totalCalls: number,
  exhaustedReason: ExhaustedReason,
  kind: RecoveryOutcome['kind'] = 'failure_terminal',
): RecoveryOutcome {
  return { kind, totalCalls, finalState: state, exhaustedReason };
}

function getTargetLabel(target: NonNullable<RecoveryContext['longContextFallbackTarget']>): string {
  if (target.kind === 'profile') return target.profileName ?? target.profileId ?? 'recovery profile';
  return target.modelName ?? 'recovery model';
}

function safeDispatch(
  adapter: RecoveryAdapter,
  turnId: string,
  event: RecoveryOutboundEvent,
): void {
  try {
    adapter.dispatchEvent(turnId, event);
  } catch (err) {
    log.warn({ err, turnId, eventType: event.type }, 'recovery event dispatch failed; continuing');
  }
}

async function abortAwareSleep(ms: number, signal: AbortSignal): Promise<void> {
  if (ms <= 0 || signal.aborted) return;
  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

function pickRecoveryProfile(
  profiles: ReadonlyArray<RecoveryProfile>,
  preferredProfileId: string | null | undefined,
): RecoveryProfile | null {
  if (preferredProfileId) {
    return profiles.find((profile) => profile.id === preferredProfileId && profile.supportsLargeContext !== false) ?? null;
  }
  return profiles.find((profile) => profile.supportsLargeContext !== false) ?? null;
}

function firstTextMessage(messages: ReadonlyArray<AgentTurnMessage>, fallback: string): string {
  return messages.find((message) => message.role === 'user' && message.text.trim().length > 0)?.text ?? fallback;
}

/**
 * Diagnostic detail lifted off the failing agent-loop outcome (REBEL-5BM).
 * Carries the underlying error plus the classification fields the surface
 * adapter pulled from the error event so the known-condition capture is no
 * longer a bare label with the real cause dropped.
 */
interface RecoveryErrorDetail {
  error?: unknown;
  errorKind?: string;
  provider?: string;
  rawError?: string;
}

function errorDetailFromOutcome(outcome: AgentLoopErrorOutcome): RecoveryErrorDetail {
  return {
    error: outcome.error,
    errorKind: outcome.errorKind,
    provider: outcome.provider,
    rawError: outcome.rawError,
  };
}

function captureExhaustion(
  adapter: RecoveryAdapter,
  ctx: RecoveryContext,
  exhaustedReason: ExhaustedReason,
  detail?: RecoveryErrorDetail,
): void {
  if (exhaustedReason === 'aborted' || exhaustedReason === 'recovery_disabled') {
    return;
  }
  const condition = `recovery_pipeline_${exhaustedReason}` as const;
  adapter.reportKnownCondition(condition, {
    turnId: ctx.turnId,
    sessionId: ctx.sessionId,
    depth: ctx.depth,
    attempt: ctx.attempt,
    exhaustedReason,
    phase: ctx.phase,
    error: detail?.error,
    ...(detail?.errorKind ? { errorKind: detail.errorKind } : {}),
    ...(detail?.provider ? { provider: detail.provider } : {}),
    ...(detail?.rawError ? { rawError: detail.rawError } : {}),
  });

  // Detection (workstream β / M2): when a turn exhausts recovery on a network/transport/server_error
  // class failure, evaluate whether EVERY provider is unreachable and emit an edge-triggered signal.
  // Lazy + fire-and-forget so it never blocks or throws the terminal path, and core/recovery tests
  // that don't mock it aren't forced to load the network code.
  void import('../diagnostics/providerReachabilityTelemetry')
    .then((m) => m.evaluateAndRecordReachability(detail?.errorKind))
    .catch((err) => {
      ignoreBestEffortCleanup(err, {
        operation: 'providerReachabilityTelemetry.evaluateAndRecordReachability',
        reason: 'fire-and-forget M2 edge telemetry must never block recovery exhaustion',
      });
    });
}

function dispatchFailure(
  adapter: RecoveryAdapter,
  ctx: RecoveryContext,
  state: RecoveryState,
  totalCalls: number,
  exhaustedReason: ExhaustedReason,
  detail?: RecoveryErrorDetail,
): RecoveryOutcome {
  safeDispatch(adapter, ctx.turnId, makeRecoveryFailedEvent(ctx, totalCalls, exhaustedReason));
  adapter.emitTelemetryCounter('recovery_terminal_failure', {
    depth: ctx.depth,
    attempt: ctx.attempt,
    exhaustedReason,
  });
  captureExhaustion(adapter, ctx, exhaustedReason, detail);
  return terminalOutcome(state, totalCalls, exhaustedReason);
}

async function buildCompactionPrompt(
  input: RunRecoveryPipelineInput,
  ctx: RecoveryContext,
  prompt: string,
  messages: AgentTurnMessage[],
  depth: number,
  toolSuggestions: Array<{ toolName: string; currentSize: number; suggestedLimit: number }>,
): Promise<{ prompt: string; summary: string } | null> {
  const settings = input.adapter.getSettings();
  const taskContext = sanitizeTaskContext(firstTextMessage(messages, ctx.originalPrompt || prompt));
  const largeToolNames = toolSuggestions.map((suggestion) => suggestion.toolName);

  try {
    const { olderSummary, recentMessages } = await input.adapter.generateIntelligentSummary(messages, {
      settings,
      taskContext,
      depth,
    });
    if (input.abortSignal.aborted) return null;
    const summary = olderSummary ?? '';
    return {
      summary,
      prompt: buildEnhancedPromptWithWindow(
        ctx.originalPrompt || prompt,
        summary,
        recentMessages,
        depth,
        toolSuggestions,
      ),
    };
  } catch (error) {
    log.warn({ err: error }, 'Intelligent recovery summary failed; trying legacy summary');
    let legacySummary: string | null;
    try {
      legacySummary = await input.adapter.generateLegacyCompactionSummary(messages, largeToolNames);
    } catch (legacyError) {
      log.warn({ err: legacyError }, 'Legacy recovery summary failed; falling back to skeleton recovery');
      return null;
    }
    if (input.abortSignal.aborted) return null;
    if (!legacySummary) return null;
    return {
      summary: legacySummary,
      prompt: buildEnhancedPrompt(ctx.originalPrompt || prompt, legacySummary, depth, toolSuggestions),
    };
  }
}

export async function runRecoveryPipeline(input: RunRecoveryPipelineInput): Promise<RecoveryOutcome> {
  let state: RecoveryState = { kind: 'idle' };
  let ctx: RecoveryContext = {
    ...input.ctx,
    phase: input.phase,
    enableRecovery: input.enableRecovery,
    longContextFallbackTarget: input.adapter.resolveLongContextFallbackTarget(),
  };
  let prompt = input.prompt;
  let totalCalls = 0;
  let started = false;
  let recoveryStartedAtMs: number | null = null;
  let lastAttemptedFallbackTarget: LongContextFallbackTarget | null = null;
  let agentLoopOptions: AgentLoopOptions = {
    ...input.agentLoopOptions,
    metadata: { ...(input.agentLoopOptions.metadata ?? {}), turnId: input.ctx.turnId },
  };
  const revealDurationMs = input.revealDurationMs ?? DEFAULT_RECOVERY_REVEAL_DURATION_MS;

  while (true) {
    if (input.abortSignal.aborted) {
      state = transition(state, { kind: 'abort' }, ctx);
      return dispatchFailure(input.adapter, ctx, state, totalCalls, 'aborted');
    }

    totalCalls += 1;
    const outcome = await input.adapter.invokeAgentLoop(prompt, agentLoopOptions, (_event: AgentEvent) => {
      // Surface adapters own non-recovery event forwarding. The pipeline only
      // consumes terminal outcome classification and emits recovery events.
    });

    if (outcome.kind === 'success') {
      if (started) {
        if (lastAttemptedFallbackTarget !== null) {
          safeDispatch(input.adapter, ctx.turnId, makeRecoveryFallbackSucceededEvent(ctx, totalCalls, lastAttemptedFallbackTarget));
          lastAttemptedFallbackTarget = null;
        }
        const totalDurationMs = recoveryStartedAtMs === null ? 0 : Date.now() - recoveryStartedAtMs;
        safeDispatch(input.adapter, ctx.turnId, makeRecoverySucceededEvent(ctx, totalCalls, ctx.depth, totalDurationMs));
      }
      lastAttemptedFallbackTarget = null;
      return {
        kind: 'success',
        totalCalls,
        finalState: { kind: 'terminal_success', outcome: { kind: 'success', totalCalls, finalState: state } },
      };
    }

    let skipOverflowTransition = false;

    if (outcome.kind === 'error_non_overflow') {
      const wasFallbackAttempt = lastAttemptedFallbackTarget !== null;
      lastAttemptedFallbackTarget = null;
      const errorDetail = errorDetailFromOutcome(outcome);

      // For pre_activity fallback failures, route through the state-machine
      // `fallback_failed` transition so depth-4 (recovery model) can retry,
      // matching the existing recoveryStateMachine.ts contract. The wired
      // transition was previously dead code from the pipeline's perspective —
      // pre-fix every fallback failure was misclassified as
      // `summary_generation_failed` and never escalated.
      if (wasFallbackAttempt && ctx.phase === 'pre_activity' && started) {
        const fallbackTarget = ctx.longContextFallbackTarget ?? { kind: 'model' as const };
        const nextState = transition(
          { kind: 'long_context_fallback', target: fallbackTarget },
          { kind: 'fallback_failed' },
          ctx,
        );
        if (nextState.kind === 'recovery_model') {
          ctx = { ...ctx, longContextFallbackAttempted: true };
          state = nextState;
          skipOverflowTransition = true;
          // Fall through to the switch below; the `recovery_model` case
          // performs the depth-4 setup and continues the loop.
        } else if (nextState.kind === 'terminal_failure') {
          return dispatchFailure(
            input.adapter,
            ctx,
            nextState,
            totalCalls,
            nextState.exhaustedReason,
            errorDetail,
          );
        } else {
          // Unexpected state from `fallback_failed` transition — fail closed
          // with the corrected label.
          const exhaustedReason: ExhaustedReason = 'long_context_fallback_failed';
          state = {
            kind: 'terminal_failure',
            reason: 'Agent loop failed during long-context fallback attempt.',
            exhaustedReason,
          };
          return dispatchFailure(input.adapter, ctx, state, totalCalls, exhaustedReason, errorDetail);
        }
      } else {
        // REBEL-5BM: when recovery had already `started`, compaction/summary
        // succeeded and the failure is a post-recovery agent-loop error
        // (provider/auth/rate-limit/stream), so it is labelled
        // `agent_loop_error_after_recovery` — NOT `summary_generation_failed`
        // (which is now reserved for genuine empty-skeleton + the defensive
        // unhandled-state cases). The `!started` first-call error keeps its
        // `agent_loop_error_before_recovery` label.
        const exhaustedReason: ExhaustedReason = wasFallbackAttempt
          ? 'long_context_fallback_failed'
          : started
            ? 'agent_loop_error_after_recovery'
            : 'agent_loop_error_before_recovery';
        state = {
          kind: 'terminal_failure',
          reason: 'Agent loop failed before recovery completed.',
          exhaustedReason,
        };
        if (!started) {
          input.adapter.emitTelemetryCounter('recovery_terminal_failure', {
            depth: ctx.depth,
            attempt: ctx.attempt,
            exhaustedReason,
          });
          captureExhaustion(input.adapter, ctx, exhaustedReason, errorDetail);
          return terminalOutcome(state, totalCalls, exhaustedReason);
        }
        return dispatchFailure(input.adapter, ctx, state, totalCalls, exhaustedReason, errorDetail);
      }
    } else {
      // outcome.kind === 'overflow' — clear the now-stale fallback target;
      // the overflow path will reset it via the long_context_fallback case
      // below (or the depth-4 path) if a new fallback attempt is queued.
      lastAttemptedFallbackTarget = null;
    }

    if (!input.enableRecovery) {
      if (outcome.kind === 'overflow') {
        input.adapter.forwardOriginalEvent(ctx.turnId, {
          type: 'context_overflow',
          originalPrompt: outcome.originalPrompt ?? ctx.originalPrompt ?? prompt,
          timestamp: Date.now(),
        });
      }
      state = transition(state, { kind: 'overflow' }, { ...ctx, enableRecovery: false });
      return terminalOutcome(state, totalCalls, 'recovery_disabled');
    }

    if (!started) {
      started = true;
      recoveryStartedAtMs = Date.now();
      safeDispatch(input.adapter, ctx.turnId, makeRecoveryStartedEvent(ctx, totalCalls));
    }

    const overflowMessages = outcome.kind === 'overflow'
      ? (outcome.messages ?? ctx.messages ?? [])
      : (ctx.messages ?? []);
    const overflowOriginalPrompt = outcome.kind === 'overflow' ? outcome.originalPrompt : undefined;
    const overflowToolSuggestions = outcome.kind === 'overflow' ? outcome.toolSuggestions : undefined;
    if (!skipOverflowTransition) {
      state = transition(state, { kind: 'overflow' }, { ...ctx, messages: overflowMessages });
    }

    switch (state.kind) {
      case 'long_context_fallback': {
        const target = ctx.longContextFallbackTarget ?? state.target;
        const targetLabel = getTargetLabel(target);
        input.adapter.recordFallback(ctx.turnId, {
          type: target.kind,
          from: agentLoopOptions.modelOverride ?? 'current',
          to: targetLabel,
          reason: 'context-overflow-long-context-fallback',
        });
        safeDispatch(input.adapter, ctx.turnId, makeRecoveryFallbackAttemptingEvent(ctx, totalCalls, target));
        // 260508 Stage 2 (R2-3): re-arm the renderer's `answer_phase_started`
        // barrier marker before the fallback attempt fires so the next
        // assistant_delta of the recovered turn re-emits the marker and
        // the renderer's thinking buffer is cleared at the right moment.
        input.adapter.clearRendererBarrierMarker(ctx.turnId);
        ctx = { ...ctx, longContextFallbackAttempted: true };
        agentLoopOptions = target.kind === 'profile'
          ? { ...agentLoopOptions, workingProfileOverrideId: target.profileId, modelOverride: undefined }
          : { ...agentLoopOptions, modelOverride: target.modelName };
        lastAttemptedFallbackTarget = target;
        state = { kind: 'idle' };
        continue;
      }

      case 'compacting': {
        ctx = { ...ctx, depth: state.depth, attempt: state.attempt };
        safeDispatch(input.adapter, ctx.turnId, makeRecoveryCompactingEvent(ctx, totalCalls));

        if (overflowMessages.length === 0) {
          state = transition(state, { kind: 'compact_failed', payload: { allowSkeleton: true } }, ctx);
        } else {
          const compacted = await buildCompactionPrompt(
            input,
            ctx,
            overflowOriginalPrompt ?? prompt,
            [...overflowMessages],
            state.depth,
            overflowToolSuggestions ?? [],
          );
          if (input.abortSignal.aborted) {
            state = transition(state, { kind: 'abort' }, ctx);
            return dispatchFailure(input.adapter, ctx, state, totalCalls, 'aborted');
          }
          if (compacted) {
            prompt = compacted.prompt;
            if (input.abortSignal.aborted) {
              state = transition(state, { kind: 'abort' }, ctx);
              return dispatchFailure(input.adapter, ctx, state, totalCalls, 'aborted');
            }
            safeDispatch(input.adapter, ctx.turnId, makeRecoverySummaryReadyEvent(ctx, totalCalls, compacted.summary, revealDurationMs));
            await abortAwareSleep(revealDurationMs, input.abortSignal);
            if (input.abortSignal.aborted) {
              state = transition(state, { kind: 'abort' }, ctx);
              return dispatchFailure(input.adapter, ctx, state, totalCalls, 'aborted');
            }
            input.adapter.clearAccumulator(ctx.turnId);
            if (input.abortSignal.aborted) {
              state = transition(state, { kind: 'abort' }, ctx);
              return dispatchFailure(input.adapter, ctx, state, totalCalls, 'aborted');
            }
            safeDispatch(input.adapter, ctx.turnId, makeRecoveryRetryingEvent(ctx, totalCalls, prompt.length));
            state = { kind: 'idle' };
            agentLoopOptions = { ...agentLoopOptions, resetConversation: true };
            continue;
          }
          state = transition(state, { kind: 'compact_failed', payload: { allowSkeleton: true } }, ctx);
        }

        if (state.kind === 'skeleton') {
          log.info(
            { turnId: ctx.turnId, sessionId: ctx.sessionId, depth: ctx.depth, messageCount: overflowMessages.length },
            'Recovery skeleton fallback attempting'
          );
          safeDispatch(input.adapter, ctx.turnId, makeRecoverySkeletonAttemptingEvent(ctx, totalCalls, overflowMessages.length));
          const skeletonMessages = input.adapter.buildSkeletonMessages([...overflowMessages], {
            originalPrompt: ctx.originalPrompt,
            depth: ctx.depth,
          });
          if (skeletonMessages.length === 0) {
            state = {
              kind: 'terminal_failure',
              reason: 'Skeleton recovery produced no messages.',
              exhaustedReason: 'summary_generation_failed',
            };
            return dispatchFailure(input.adapter, ctx, state, totalCalls, 'summary_generation_failed');
          }
          ctx = { ...ctx, skeletonAttempted: true, messages: skeletonMessages };
          input.adapter.clearAccumulator(ctx.turnId);
          state = { kind: 'idle' };
          agentLoopOptions = { ...agentLoopOptions, resetConversation: true, recoveryMessages: skeletonMessages };
          continue;
        }

        if (state.kind === 'terminal_failure') {
          return dispatchFailure(input.adapter, ctx, state, totalCalls, state.exhaustedReason);
        }
        continue;
      }

      case 'recovery_model': {
        if (!canEnterDepth4(ctx)) {
          state = { kind: 'terminal_failure', reason: 'Depth-4 recovery already attempted.', exhaustedReason: 'depth_limit_reached' };
          return dispatchFailure(input.adapter, ctx, state, totalCalls, 'depth_limit_reached');
        }

        // Depth-4 intentionally uses the same profile preference as the
        // long-context fallback setting: the unified ladder's final rung is the
        // configured long-context model/profile acting as the recovery
        // recompactor. See docs/plans/260503_unified_recovery_pipeline.md
        // Strategic Shape #2.
        const recoveryProfilePreference = input.adapter.getRecoveryProfilePreference();
        const profile = pickRecoveryProfile(input.adapter.getAvailableProfiles(), recoveryProfilePreference.profileId);
        if (recoveryProfilePreference.configuredId !== null && recoveryProfilePreference.profileId === null) {
          log.warn(
            {
              turnId: ctx.turnId,
              sessionId: ctx.sessionId,
              configuredProfileId: recoveryProfilePreference.configuredId,
              selectedProfileId: profile?.id ?? null,
            },
            'Configured recovery profile is unavailable; auto-picked recovery profile'
          );
        }
        if (!profile) {
          safeDispatch(input.adapter, ctx.turnId, makeRecoveryLastResortSkippedEvent(ctx, totalCalls, 'no_qualifying_profile'));
          input.adapter.emitTelemetryCounter('recovery_skipped', { reason: 'no_qualifying_profile', depth: ctx.depth });
          state = { kind: 'terminal_failure', reason: 'No qualifying recovery profile.', exhaustedReason: 'no_qualifying_profile' };
          return terminalOutcome(state, totalCalls, 'no_qualifying_profile', 'failure_skipped');
        }
        if (profile.rateLimited || input.adapter.isSharedCooldownActiveFor(profile)) {
          safeDispatch(input.adapter, ctx.turnId, makeRecoveryLastResortSkippedEvent(ctx, totalCalls, 'rate_limited'));
          input.adapter.emitTelemetryCounter('recovery_skipped', { reason: 'rate_limited', depth: ctx.depth });
          state = { kind: 'terminal_failure', reason: 'Recovery profile rate limited.', exhaustedReason: 'rate_limited' };
          return terminalOutcome(state, totalCalls, 'rate_limited', 'failure_skipped');
        }

        ctx = { ...ctx, isRecoveryModelAttempt: true, depth: 4, attempt: 1 };
        input.adapter.emitCostEstimate({
          model: profile.model,
          profileId: profile.id,
          estimatedCost: 'high',
          recoveryDepth: 4,
        });
        input.adapter.emitTelemetryCounter('recovery_depth_4_invocation', { profileId: profile.id, depth: 4 });
        input.adapter.recordFallback(ctx.turnId, {
          type: 'profile',
          from: agentLoopOptions.modelOverride ?? 'current',
          to: profile.name,
          reason: 'context-overflow-recovery-model',
        });
        safeDispatch(input.adapter, ctx.turnId, makeRecoveryDepth4AttemptingEvent(ctx, totalCalls, profile.id, profile.name));
        // 260508 Stage 2 (R2-3): re-arm the renderer's `answer_phase_started`
        // barrier marker before the depth-4 last-resort attempt so the next
        // assistant_delta of the recovered turn re-emits the marker.
        input.adapter.clearRendererBarrierMarker(ctx.turnId);
        agentLoopOptions = { ...agentLoopOptions, workingProfileOverrideId: profile.id, resetConversation: true };
        state = { kind: 'idle' };
        continue;
      }

      case 'terminal_failure':
        return dispatchFailure(input.adapter, ctx, state, totalCalls, state.exhaustedReason);

      case 'terminal_success':
        if (started && lastAttemptedFallbackTarget !== null) {
          safeDispatch(input.adapter, ctx.turnId, makeRecoveryFallbackSucceededEvent(ctx, totalCalls, lastAttemptedFallbackTarget));
          lastAttemptedFallbackTarget = null;
        }
        safeDispatch(
          input.adapter,
          ctx.turnId,
          makeRecoverySucceededEvent(
            ctx,
            totalCalls,
            ctx.depth,
            recoveryStartedAtMs === null ? 0 : Date.now() - recoveryStartedAtMs,
          ),
        );
        return { ...state.outcome, totalCalls, finalState: state };

      case 'idle':
      case 'skeleton':
        state = { kind: 'terminal_failure', reason: `Unhandled recovery state: ${state.kind}`, exhaustedReason: 'summary_generation_failed' };
        return dispatchFailure(input.adapter, ctx, state, totalCalls, 'summary_generation_failed');
    }
  }
}
