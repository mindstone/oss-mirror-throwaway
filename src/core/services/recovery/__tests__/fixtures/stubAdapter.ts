import type { AgentEvent, AgentTurnMessage, AppSettings } from '@shared/types';
import { stripAgentTurnMessagesForSkeleton } from '@core/rebelCore/skeletonStripping';

import type {
  AgentLoopOptions,
  AgentLoopOutcome,
  ErrorContext,
  RecoveryAdapter,
  RecoveryProfile,
  SkeletonOptions,
  SummaryOptions,
  TurnFallbackInfo,
} from '../../recoveryAdapter';
import type { RecoveryOutboundEvent } from '../../recoveryEvents';
import type { LongContextFallbackTarget } from '../../recoveryStateMachine';

export interface StubAdapterCall {
  name: string;
  args: unknown[];
}

interface StubAdapterOptions {
  outcomes?: AgentLoopOutcome[];
  settings?: Partial<AppSettings> & { recovery?: { recoveryModelProfileId?: string | null } };
  profiles?: RecoveryProfile[];
  fallbackTarget?: LongContextFallbackTarget | null;
  intelligentSummary?: { olderSummary: string | null; recentMessages: AgentTurnMessage[] } | Error;
  legacySummary?: string | null | Error;
  skeletonMessages?: AgentTurnMessage[];
  recoveryProfilePreference?: { profileId: string | null; configuredId: string | null };
  dispatchThrows?: boolean;
  sharedCooldownActive?: boolean;
}

export interface StubRecoveryAdapter extends RecoveryAdapter {
  calls: StubAdapterCall[];
  dispatchedEvents: RecoveryOutboundEvent[];
  enqueueOutcome(outcome: AgentLoopOutcome): void;
}

const defaultSettings = (): Pick<AppSettings, 'claude'> & Partial<AppSettings> & { recovery?: { recoveryModelProfileId?: string | null } } => ({
  claude: {
    model: 'claude-sonnet-4-6',
    thinkingModel: undefined,
    permissionMode: 'bypassPermissions',
    executablePath: null,
    planMode: false,
    extendedContext: false,
    thinkingEffort: 'medium',
    apiKey: 'test-key',
    oauthToken: null,
    authMethod: 'api-key',
  },
  recovery: { recoveryModelProfileId: null },
});

export function makeMessage(
  role: AgentTurnMessage['role'],
  text: string,
  id = `${role}-${text.slice(0, 8)}`,
): AgentTurnMessage {
  return {
    id,
    turnId: 'turn-test',
    role,
    text,
    createdAt: 1,
  };
}

export function createStubRecoveryAdapter(options: StubAdapterOptions = {}): StubRecoveryAdapter {
  const calls: StubAdapterCall[] = [];
  const dispatchedEvents: RecoveryOutboundEvent[] = [];
  const outcomes = [...(options.outcomes ?? [])];
  const settings = { ...defaultSettings(), ...options.settings };
  const profiles = options.profiles ?? [];
  const fallbackTarget = options.fallbackTarget ?? null;

  const record = (name: string, ...args: unknown[]): void => {
    calls.push({ name, args });
  };

  return {
    calls,
    dispatchedEvents,
    enqueueOutcome(outcome: AgentLoopOutcome): void {
      outcomes.push(outcome);
    },
    recordFallback(turnId: string, fallback: TurnFallbackInfo): void {
      record('recordFallback', turnId, fallback);
    },
    clearAccumulator(turnId: string): void {
      record('clearAccumulator', turnId);
    },
    clearRendererBarrierMarker(turnId: string): void {
      record('clearRendererBarrierMarker', turnId);
    },
    dispatchEvent(turnId: string, event: RecoveryOutboundEvent): void {
      record('dispatchEvent', turnId, event);
      if (options.dispatchThrows) {
        throw new Error(`dispatch failed for ${event.type}`);
      }
      dispatchedEvents.push(event);
    },
    forwardOriginalEvent(turnId: string, event: AgentEvent): void {
      record('forwardOriginalEvent', turnId, event);
    },
    getSettings() {
      record('getSettings');
      return settings;
    },
    getAvailableProfiles(): ReadonlyArray<RecoveryProfile> {
      record('getAvailableProfiles');
      return profiles;
    },
    resolveLongContextFallbackTarget(): LongContextFallbackTarget | null {
      record('resolveLongContextFallbackTarget');
      return fallbackTarget;
    },
    getRecoveryProfilePreference(): { profileId: string | null; configuredId: string | null } {
      record('getRecoveryProfilePreference');
      if (options.recoveryProfilePreference) {
        return options.recoveryProfilePreference;
      }
      if (fallbackTarget?.kind === 'profile') {
        return {
          profileId: fallbackTarget.profileId ?? null,
          configuredId: fallbackTarget.profileId ?? null,
        };
      }
      const configuredId = typeof settings.claude?.longContextFallbackProfileId === 'string'
        ? settings.claude.longContextFallbackProfileId
        : null;
      return {
        profileId: configuredId,
        configuredId,
      };
    },
    async invokeAgentLoop(
      prompt: string,
      agentLoopOptions: AgentLoopOptions,
      onEvent: (event: AgentEvent) => void,
    ): Promise<AgentLoopOutcome> {
      record('invokeAgentLoop', prompt, agentLoopOptions);
      onEvent({ type: 'status', message: 'stub invoke', timestamp: Date.now() });
      return outcomes.shift() ?? { kind: 'success', result: 'ok' };
    },
    reportError(err: unknown, ctx: ErrorContext): void {
      record('reportError', err, ctx);
    },
    reportKnownCondition(condition, ctx): void {
      record('reportKnownCondition', condition, ctx);
    },
    emitTelemetryCounter(counter, tags): void {
      record('emitTelemetryCounter', counter, tags);
    },
    isSharedCooldownActiveFor(profile): boolean {
      record('isSharedCooldownActiveFor', profile);
      return options.sharedCooldownActive ?? false;
    },
    emitCostEstimate(payload): void {
      record('emitCostEstimate', payload);
    },
    async generateIntelligentSummary(
      messages: AgentTurnMessage[],
      summaryOptions: SummaryOptions,
    ): Promise<{ olderSummary: string | null; recentMessages: AgentTurnMessage[] }> {
      record('generateIntelligentSummary', messages, summaryOptions);
      if (options.intelligentSummary instanceof Error) {
        throw options.intelligentSummary;
      }
      return options.intelligentSummary ?? { olderSummary: 'older summary', recentMessages: messages.slice(-1) };
    },
    async generateLegacyCompactionSummary(
      messages: AgentTurnMessage[],
      largeToolNames: string[],
    ): Promise<string | null> {
      record('generateLegacyCompactionSummary', messages, largeToolNames);
      if (options.legacySummary instanceof Error) {
        throw options.legacySummary;
      }
      return Object.prototype.hasOwnProperty.call(options, 'legacySummary')
        ? options.legacySummary ?? null
        : 'legacy summary';
    },
    buildSkeletonMessages(messages: AgentTurnMessage[], skeletonOptions: SkeletonOptions): AgentTurnMessage[] {
      record('buildSkeletonMessages', messages, skeletonOptions);
      return options.skeletonMessages ?? stripAgentTurnMessagesForSkeleton(messages).messages;
    },
  };
}
