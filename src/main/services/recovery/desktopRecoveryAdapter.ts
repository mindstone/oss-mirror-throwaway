import type { AgentEvent, AgentTurnMessage, AppSettings } from '@shared/types';
import { createScopedLogger } from '@core/logger';
import { getErrorReporter } from '@core/errorReporter';
import { captureKnownCondition } from '@core/sentry/captureKnownCondition';
import { getTracker } from '@core/tracking';
import type { EventWindow } from '@core/types';
import {
  generateCompactionSummary,
  generateIntelligentSummary,
} from '@core/services/compactionService';
import { apiRateLimitCooldown } from '@core/services/apiRateLimitCooldown';
import { stripAgentTurnMessagesForSkeleton } from '@core/rebelCore/skeletonStripping';
import {
  getContextOverflowFallbackModel,
  getContextOverflowFallbackProfileId,
} from '@core/rebelCore/settingsAccessors';
import { getKnownContextWindowForProfile } from '@shared/data/modelProviderPresets';
import {
  normalizeRecoveryError,
  type AgentLoopOptions,
  type AgentLoopOutcome,
  type RecoveryAdapter,
  type SkeletonOptions,
  type SummaryOptions,
  type TurnFallbackInfo,
} from '@core/services/recovery/recoveryAdapter';
import type { LongContextFallbackTarget } from '@core/services/recovery/recoveryStateMachine';
import { agentTurnRegistry } from '../agentTurnRegistry';
import { clearAnswerPhaseStartedSentinel, dispatchAgentEvent, dispatchAgentErrorEvent } from '../agentEventDispatcher';
import { getTurnAggregator } from '../../tracking';

const log = createScopedLogger({ service: 'desktopRecoveryAdapter' });

type ExecuteAgentTurnFn = typeof import('../agentTurnExecutor').executeAgentTurn;
type ExecuteAgentTurnOptions = NonNullable<Parameters<ExecuteAgentTurnFn>[3]>;

export interface DesktopRecoveryAdapterDeps {
  win: EventWindow | null;
  executeAgentTurn: ExecuteAgentTurnFn;
  getSettings: () => AppSettings;
  onEvent?: (event: AgentEvent) => void;
}

function resolveLongContextFallbackTarget(settings: AppSettings): LongContextFallbackTarget | null {
  const fallbackProfileId = getContextOverflowFallbackProfileId(settings);
  if (fallbackProfileId) {
    const profile = settings.localModel?.profiles.find((candidate) => candidate.id === fallbackProfileId);
    if (profile?.model) {
      return {
        kind: 'profile',
        profileId: profile.id,
        profileName: profile.name,
        modelName: profile.model,
      };
    }
  }

  const fallbackModel = getContextOverflowFallbackModel(settings);
  return fallbackModel ? { kind: 'model', modelName: fallbackModel } : null;
}

function toExecuteOptions(options: AgentLoopOptions): ExecuteAgentTurnOptions {
  return {
    ...options,
    sessionType: options.sessionType as ExecuteAgentTurnOptions['sessionType'],
    memoryWriteHook: options.memoryWriteHook as ExecuteAgentTurnOptions['memoryWriteHook'],
    mcpDenyHook: options.mcpDenyHook as ExecuteAgentTurnOptions['mcpDenyHook'],
    inboundSafetyHook: options.inboundSafetyHook as ExecuteAgentTurnOptions['inboundSafetyHook'],
    routeRebuildHint: options.routeRebuildHint as ExecuteAgentTurnOptions['routeRebuildHint'],
    inFlightProviderRoutePlan: options.inFlightProviderRoutePlan as ExecuteAgentTurnOptions['inFlightProviderRoutePlan'],
  } as ExecuteAgentTurnOptions;
}

function fallbackTypeForRegistry(fallback: TurnFallbackInfo): 'model' | 'context' {
  return fallback.type === 'profile' ? 'model' : fallback.type;
}

export function createDesktopRecoveryAdapter(deps: DesktopRecoveryAdapterDeps): RecoveryAdapter {
  const forwardOriginalEvent = (_turnId: string, event: Exclude<AgentEvent, { type: 'error' }>): void => {
    deps.onEvent?.(event);
  };

  return {
    recordFallback(turnId: string, fallback: TurnFallbackInfo): void {
      agentTurnRegistry.addTurnFallback(turnId, {
        type: fallbackTypeForRegistry(fallback),
        from: fallback.from,
        to: fallback.to,
        reason: fallback.reason,
      });
    },

    clearAccumulator(turnId: string): void {
      agentTurnRegistry.deleteContextAccumulator(turnId);
      agentTurnRegistry.clearContextOverflowDispatched(turnId);
      // Defence-in-depth — recovery callers also invoke
      // `clearRendererBarrierMarker` directly per Stage 2 (R2-3); folding
      // it into `clearAccumulator` covers any future call site that
      // tears down accumulator state without re-arming the marker.
      clearAnswerPhaseStartedSentinel(turnId);
    },

    clearRendererBarrierMarker(turnId: string): void {
      clearAnswerPhaseStartedSentinel(turnId);
    },

    dispatchEvent(turnId: string, event): void {
      dispatchAgentEvent(deps.win, turnId, event);
    },

    forwardOriginalEvent,

    getSettings(): AppSettings {
      return deps.getSettings();
    },

    getAvailableProfiles() {
      return (deps.getSettings().localModel?.profiles ?? []).map((profile) => {
        const contextWindow = getKnownContextWindowForProfile(profile);
        return {
          id: profile.id,
          name: profile.name,
          model: profile.model ?? profile.name,
          supportsLargeContext: contextWindow == null ? false : contextWindow >= 500_000,
        };
      });
    },

    resolveLongContextFallbackTarget(): LongContextFallbackTarget | null {
      return resolveLongContextFallbackTarget(deps.getSettings());
    },

    getRecoveryProfilePreference(): { profileId: string | null; configuredId: string | null } {
      const settings = deps.getSettings();
      const configuredId = getContextOverflowFallbackProfileId(settings) ?? null;
      const target = resolveLongContextFallbackTarget(settings);
      return {
        profileId: target?.kind === 'profile' ? target.profileId ?? null : null,
        configuredId,
      };
    },

    async invokeAgentLoop(
      prompt: string,
      agentLoopOptions: AgentLoopOptions,
      onEvent: (event: AgentEvent) => void,
    ): Promise<AgentLoopOutcome> {
      return new Promise((resolve) => {
        let resolved = false;
        const turnId = agentLoopOptions.metadata?.turnId;
        const effectiveTurnId = typeof turnId === 'string' ? turnId : null;

        if (!effectiveTurnId) {
          resolve({ kind: 'error_non_overflow', error: new Error('Recovery adapter missing turnId metadata.') });
          return;
        }

        const wrappingListener = (event: AgentEvent) => {
          if (event.type === 'context_overflow') {
            if (resolved) return;

            const accumulatedContext = agentTurnRegistry.getContextAccumulator(effectiveTurnId);
            const currentDepth = event.originalPrompt.match(/\[COMPACTION_DEPTH:(\d+)\]/);
            const nextDepth = currentDepth ? Number.parseInt(currentDepth[1], 10) + 1 : 1;
            const aggregator = getTurnAggregator(effectiveTurnId);
            const toolSuggestions = aggregator.getToolLimitSuggestions(nextDepth);

            resolved = true;
            // Preserve Layer 3 lifecycle: remove listener immediately on
            // overflow before resolving, so late terminal events from attempt N
            // cannot satisfy attempt N+1's listener.
            agentTurnRegistry.deleteEventListener(effectiveTurnId);
            resolve({
              kind: 'overflow',
              originalPrompt: event.originalPrompt,
              messages: accumulatedContext?.messages ?? [],
              toolSuggestions,
            });
            return;
          }

          if (event.type === 'error') {
            // In-band error events have already been classified + surfaced by
            // the funnel (dispatchAgentErrorEvent → notifyTurnEventSubscribers /
            // win). Relay them straight to the caller's onEvent sink (e.g. the
            // automation failure-status accumulator) without re-routing through
            // the now error-narrowed `forwardOriginalEvent` seam and without a
            // second funnel dispatch (preserves I9: recovery emits once/turn).
            deps.onEvent?.(event);
          } else {
            forwardOriginalEvent(effectiveTurnId, event);
          }
          onEvent(event);

          if (resolved) return;
          if (event.type === 'result') {
            resolved = true;
            resolve({ kind: 'success', result: event.text });
          } else if (event.type === 'error') {
            resolved = true;
            // REBEL-5BM: thread the classified diagnostic fields off the error
            // event so the recovery known-condition capture carries the real
            // underlying cause. Omitted when absent (never fabricated).
            resolve({
              kind: 'error_non_overflow',
              error: event.error,
              ...(event.errorKind ? { errorKind: event.errorKind } : {}),
              ...(event.provider ? { provider: event.provider } : {}),
              ...(event.rawError ? { rawError: event.rawError } : {}),
            });
          }
        };

        agentTurnRegistry.setEventListener(effectiveTurnId, wrappingListener);

        deps.executeAgentTurn(deps.win, effectiveTurnId, prompt, toExecuteOptions(agentLoopOptions))
          .catch((error) => {
            if (resolved) return;
            // The turn engine rejected without funnel-dispatching a terminal
            // error (an error escaped handleTurnError). Previously this seam
            // hand-built a raw, classification-blind `{type:'error'}` and pushed
            // it through `forwardOriginalEvent`, escaping the funnel type-wall
            // (F3-class bypass). Resolve the recovery outcome with the original
            // error object first (preserves the pipeline's Sentry/telemetry
            // classification), then route the escaped error through the funnel
            // so it surfaces classified (errorKind / isTransient derived) to the
            // window + all subscribers. The funnel synchronously drives the
            // still-registered `wrappingListener`, whose error branch relays the
            // classified event to deps.onEvent (e.g. the automation failure
            // sink) before its `resolved` guard short-circuits the duplicate
            // resolve — preserving I9 (recovery emits once per turn).
            resolved = true;
            resolve({ kind: 'error_non_overflow', error });
            dispatchAgentErrorEvent(deps.win, effectiveTurnId, error);
          });
      });
    },

    reportError(err: unknown, ctx): void {
      getErrorReporter().captureException(err, {
        tags: { area: 'agent', component: 'recovery', legacyComponent: 'compaction' },
        extra: { ...ctx },
      });
    },

    reportKnownCondition(condition, ctx): void {
      const phase = ctx.phase === 'pre_activity' || ctx.phase === 'post_activity'
        ? ctx.phase
        : 'post_activity';
      // REBEL-5BM: normalize the underlying error (string OR Error) into a real
      // redacted Error for Sentry's 3rd arg, plus redacted diagnostic fields
      // for `extra`. Shared helper so the desktop + cloud adapters cannot drift.
      const normalized = normalizeRecoveryError({
        error: ctx.error,
        errorKind: ctx.errorKind,
        provider: ctx.provider,
        rawError: ctx.rawError,
      });
      captureKnownCondition(
        condition,
        {
          phase,
          tags: { component: 'recovery_pipeline', phase },
          extra: {
            turnId: ctx.turnId,
            sessionId: ctx.sessionId,
            depth: ctx.depth,
            attempt: ctx.attempt,
            ...(ctx.exhaustedReason ? { exhaustedReason: ctx.exhaustedReason } : {}),
            ...(normalized.errorString ? { error: normalized.errorString } : {}),
            ...(normalized.errorKind ? { errorKind: normalized.errorKind } : {}),
            ...(normalized.provider ? { provider: normalized.provider } : {}),
            ...(normalized.rawError ? { rawError: normalized.rawError } : {}),
          },
        },
        normalized.error,
      );
    },

    emitTelemetryCounter(counter, tags): void {
      getTracker().track(counter, tags);
    },

    isSharedCooldownActiveFor(_profile): boolean {
      return !apiRateLimitCooldown.isAvailable();
    },

    emitCostEstimate(payload): void {
      log.info(payload, 'recovery.cost_estimate_emitted');
    },

    generateIntelligentSummary(
      messages: AgentTurnMessage[],
      options: SummaryOptions,
    ): Promise<{ olderSummary: string | null; recentMessages: AgentTurnMessage[] }> {
      return generateIntelligentSummary(
        messages,
        options as Parameters<typeof generateIntelligentSummary>[1],
      );
    },

    generateLegacyCompactionSummary(
      messages: AgentTurnMessage[],
      largeToolNames: string[],
    ): Promise<string | null> {
      return generateCompactionSummary(deps.getSettings(), messages, largeToolNames);
    },

    buildSkeletonMessages(messages: AgentTurnMessage[], _options: SkeletonOptions): AgentTurnMessage[] {
      return stripAgentTurnMessagesForSkeleton(messages).messages;
    },
  };
}
