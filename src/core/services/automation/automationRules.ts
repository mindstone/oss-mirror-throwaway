import type { Scheduler, SchedulerTimerHandle } from '@core/scheduler';
import type { ProviderCredentialState } from '@core/utils/validateProviderCredentials';
import type { AutomationAdmissionBlock, AutomationProviderReadinessSummary } from '@shared/types';

export const MAX_TIMEOUT_MS = 2147483647;

export const INTERACTIVE_DEFERRAL_DEFAULTS = {
  MAX_DEFERRAL_MS: 5 * 60 * 1000,
  POLL_INTERVAL_MS: 2000,
  GRACE_MS: 5000,
} as const;

export interface RateLimitCooldownDecision {
  shouldDefer: boolean;
  deferMs: number;
  reason: string | null;
}

export type ProviderReadinessDecision =
  | { status: 'ready' }
  | {
      status: 'blocked';
      reason: AutomationAdmissionBlock;
    };

export function evaluateProviderReadinessRule(args: {
  credentialState: ProviderCredentialState;
}): ProviderReadinessDecision {
  const block = (
    reason: Omit<AutomationAdmissionBlock, 'source'>,
  ): ProviderReadinessDecision => ({
    status: 'blocked',
    reason: {
      source: 'provider-readiness',
      ...reason,
    },
  });

  switch (args.credentialState.kind) {
    case 'anthropic':
      if (args.credentialState.status === 'missing') {
        return block({
          code: 'anthropic_missing_api_key',
          errorKind: 'connection-not-configured',
          headlineClass: 'auth',
          provider: 'anthropic',
          message: 'Authentication is missing. Please add an API key in Settings.',
        });
      }
      return { status: 'ready' };
    case 'openrouter':
      if (args.credentialState.status === 'missing') {
        return block({
          code: 'openrouter_disconnected',
          errorKind: 'connection-not-configured',
          headlineClass: 'auth',
          provider: 'openrouter',
          message: 'OpenRouter is disconnected. Reconnect it in Settings, or switch to another provider.',
        });
      }
      return { status: 'ready' };
    case 'codex':
      if (args.credentialState.status === 'disconnected') {
        return block({
          code: 'codex_disconnected',
          errorKind: 'connection-not-configured',
          headlineClass: 'auth',
          provider: 'codex',
          message: 'ChatGPT Pro is disconnected. Reconnect it in Settings, or switch to another provider.',
        });
      }
      return { status: 'ready' };
    case 'local':
    case 'mindstone':
      return { status: 'ready' };
    default: {
      const _exhaustive: never = args.credentialState;
      void _exhaustive;
      return { status: 'ready' };
    }
  }
}

export interface ProviderReadinessSummaryInput {
  readiness: ProviderReadinessDecision;
  runs: ReadonlyArray<{
    automationId: string;
    startedAt: number;
    completedAt?: number | null;
    admissionBlock?: AutomationAdmissionBlock;
  }>;
  definitions: ReadonlyArray<{
    id: string;
    enabled: boolean;
    schedule: { type: string };
    executor?: 'llm' | 'script';
  }>;
}

export interface ProviderReadinessEligibleAutomation {
  enabled: boolean;
  schedule: { type: string };
  executor?: 'llm' | 'script';
}

export function isProviderReadinessEligibleAutomation(
  definition: ProviderReadinessEligibleAutomation,
): boolean {
  return (
    definition.enabled
    && definition.schedule.type !== 'event'
    && (definition.executor ?? 'llm') === 'llm'
  );
}

export function summarizeProviderReadinessBlocks(
  input: ProviderReadinessSummaryInput,
): AutomationProviderReadinessSummary {
  if (input.readiness.status === 'ready') {
    return {
      readiness: 'ready',
      affectedAutomationCount: 0,
      affectedAutomationIds: [],
      blockedRunCount: 0,
      sinceMs: null,
      cause: null,
    };
  }
  const blockedReason = input.readiness.reason;

  const affectedAutomationIds = input.definitions
    .filter((definition) => isProviderReadinessEligibleAutomation(definition))
    .map((definition) => definition.id)
    .sort();
  const affectedIds = new Set(affectedAutomationIds);

  const matchingBlockedRuns = input.runs.filter((run) =>
    affectedIds.has(run.automationId)
      && run.admissionBlock?.source === 'provider-readiness'
      && run.admissionBlock.code === blockedReason.code,
  );

  const sinceMs =
    matchingBlockedRuns.length > 0
      ? Math.min(...matchingBlockedRuns.map((run) => run.completedAt ?? run.startedAt))
      : null;

  return {
    readiness: 'blocked',
    affectedAutomationCount: affectedAutomationIds.length,
    affectedAutomationIds,
    blockedRunCount: matchingBlockedRuns.length,
    sinceMs,
    cause: blockedReason,
  };
}

export function evaluateRateLimitCooldownRule(args: {
  isAvailable: boolean;
  remainingMs: number;
  reason?: string;
}): RateLimitCooldownDecision {
  if (args.isAvailable) {
    return { shouldDefer: false, deferMs: 0, reason: null };
  }

  return {
    shouldDefer: true,
    deferMs: Math.max(0, args.remainingMs),
    reason: args.reason ?? 'API rate-limit cooldown active',
  };
}

export function shouldSkipDueToActiveRun(isRunning: boolean): boolean {
  return isRunning;
}

export interface AutomationRunDeduper {
  isRunning(automationId: string): boolean;
  tryStart(automationId: string): boolean;
  finish(automationId: string): void;
}

export function createAutomationRunDeduper(
  backingSet: Set<string> = new Set<string>(),
): AutomationRunDeduper {
  return {
    isRunning(automationId: string): boolean {
      return backingSet.has(automationId);
    },
    tryStart(automationId: string): boolean {
      if (backingSet.has(automationId)) {
        return false;
      }
      backingSet.add(automationId);
      return true;
    },
    finish(automationId: string): void {
      backingSet.delete(automationId);
    },
  };
}

export interface InteractiveTurnDeferralResult {
  deferred: boolean;
  deferredMs: number;
  timedOut: boolean;
  shuttingDown: boolean;
}

export interface InteractiveTurnDeferralOptions {
  hasInteractiveTurn: () => boolean;
  isShuttingDown: () => boolean;
  scheduler: Pick<Scheduler, 'sleep' | 'now' | 'deferUntilVisible'>;
  waitForVisible?: boolean;
  maxDeferralMs?: number;
  pollIntervalMs?: number;
  graceMs?: number;
}

export async function waitForInteractiveTurnToSettle(
  options: InteractiveTurnDeferralOptions,
): Promise<InteractiveTurnDeferralResult> {
  const {
    hasInteractiveTurn,
    isShuttingDown,
    scheduler,
    waitForVisible = false,
    maxDeferralMs = INTERACTIVE_DEFERRAL_DEFAULTS.MAX_DEFERRAL_MS,
    pollIntervalMs = INTERACTIVE_DEFERRAL_DEFAULTS.POLL_INTERVAL_MS,
    graceMs = INTERACTIVE_DEFERRAL_DEFAULTS.GRACE_MS,
  } = options;

  const start = scheduler.now();
  const deadline = start + maxDeferralMs;

  const waitForVisibilityIfNeeded = async (): Promise<'visible' | 'timeout' | 'aborted'> => {
    if (!waitForVisible) return 'visible';
    const remainingMs = Math.max(0, deadline - scheduler.now());
    return scheduler.deferUntilVisible({ timeoutMs: remainingMs });
  };

  const initialVisibility = await waitForVisibilityIfNeeded();
  if (initialVisibility === 'timeout') {
    return {
      deferred: true,
      deferredMs: scheduler.now() - start,
      timedOut: true,
      shuttingDown: false,
    };
  }
  if (initialVisibility === 'aborted') {
    return {
      deferred: true,
      deferredMs: scheduler.now() - start,
      timedOut: false,
      shuttingDown: true,
    };
  }

  while (hasInteractiveTurn() && scheduler.now() < deadline && !isShuttingDown()) {
    await scheduler.sleep(pollIntervalMs);
  }

  if (isShuttingDown()) {
    return {
      deferred: true,
      deferredMs: scheduler.now() - start,
      timedOut: false,
      shuttingDown: true,
    };
  }

  if (scheduler.now() >= deadline) {
    return {
      deferred: true,
      deferredMs: scheduler.now() - start,
      timedOut: true,
      shuttingDown: false,
    };
  }

  await scheduler.sleep(graceMs);

  while (hasInteractiveTurn() && scheduler.now() < deadline && !isShuttingDown()) {
    await scheduler.sleep(pollIntervalMs);

    if (isShuttingDown()) {
      return {
        deferred: true,
        deferredMs: scheduler.now() - start,
        timedOut: false,
        shuttingDown: true,
      };
    }

    if (!hasInteractiveTurn()) {
      await scheduler.sleep(graceMs);
    }
  }

  if (isShuttingDown()) {
    return {
      deferred: true,
      deferredMs: scheduler.now() - start,
      timedOut: false,
      shuttingDown: true,
    };
  }

  const finalVisibility = await waitForVisibilityIfNeeded();
  if (finalVisibility === 'timeout') {
    return {
      deferred: true,
      deferredMs: scheduler.now() - start,
      timedOut: true,
      shuttingDown: false,
    };
  }
  if (finalVisibility === 'aborted') {
    return {
      deferred: true,
      deferredMs: scheduler.now() - start,
      timedOut: false,
      shuttingDown: true,
    };
  }

  return {
    deferred: true,
    deferredMs: scheduler.now() - start,
    timedOut: scheduler.now() >= deadline,
    shuttingDown: false,
  };
}

export interface ScheduleDefinitionWithMaxTimeoutResult {
  nextRunAt: number;
  delayMs: number;
  chained: boolean;
}

export interface ScheduleDefinitionWithMaxTimeoutOptions<TDefinition> {
  definitionId: string;
  timers: Map<string, SchedulerTimerHandle>;
  scheduler: Pick<Scheduler, 'registerTimeout' | 'clear' | 'now'>;
  getDefinitionById: (definitionId: string) => TDefinition | undefined;
  calculateNextRunAt: (definition: TDefinition, fromMs: number) => number | null;
  onNextRunAt?: (definition: TDefinition, nextRunAt: number) => void;
  onFire: (definition: TDefinition) => void;
  onDropped?: (
    definitionId: string,
    reason: 'missing-definition' | 'no-next-run',
  ) => void;
  maxTimeoutMs?: number;
}

export function scheduleDefinitionWithMaxTimeout<TDefinition>(
  options: ScheduleDefinitionWithMaxTimeoutOptions<TDefinition>,
): ScheduleDefinitionWithMaxTimeoutResult | null {
  const {
    definitionId,
    timers,
    scheduler,
    getDefinitionById,
    calculateNextRunAt,
    onNextRunAt,
    onFire,
    onDropped,
    maxTimeoutMs = MAX_TIMEOUT_MS,
  } = options;

  const existingTimer = timers.get(definitionId);
  if (existingTimer) {
    scheduler.clear(existingTimer);
    timers.delete(definitionId);
  }

  const initialNow = scheduler.now();
  const initialDefinition = getDefinitionById(definitionId);
  if (!initialDefinition) {
    onDropped?.(definitionId, 'missing-definition');
    return null;
  }

  const initialNextRunAt = calculateNextRunAt(initialDefinition, initialNow);
  if (initialNextRunAt === null) {
    onDropped?.(definitionId, 'no-next-run');
    return null;
  }
  onNextRunAt?.(initialDefinition, initialNextRunAt);

  const scheduleAt = (targetRunAt: number): void => {
    const now = scheduler.now();
    const delayMs = Math.max(0, targetRunAt - now);
    const shouldChain = delayMs > maxTimeoutMs;
    const timeoutMs = shouldChain ? maxTimeoutMs : delayMs;

    const timer = scheduler.registerTimeout(() => {
      if (shouldChain) {
        const freshDefinition = getDefinitionById(definitionId);
        if (!freshDefinition) {
          timers.delete(definitionId);
          onDropped?.(definitionId, 'missing-definition');
          return;
        }

        const refreshedNextRunAt = calculateNextRunAt(freshDefinition, scheduler.now());
        if (refreshedNextRunAt === null) {
          timers.delete(definitionId);
          onDropped?.(definitionId, 'no-next-run');
          return;
        }

        onNextRunAt?.(freshDefinition, refreshedNextRunAt);
        scheduleAt(refreshedNextRunAt);
        return;
      }

      timers.delete(definitionId);
      const freshDefinition = getDefinitionById(definitionId);
      if (!freshDefinition) {
        onDropped?.(definitionId, 'missing-definition');
        return;
      }
      onFire(freshDefinition);
    }, timeoutMs);

    const previousTimer = timers.get(definitionId);
    if (previousTimer) {
      scheduler.clear(previousTimer);
    }
    timers.set(definitionId, timer);
  };

  scheduleAt(initialNextRunAt);

  const initialDelayMs = Math.max(0, initialNextRunAt - initialNow);
  return {
    nextRunAt: initialNextRunAt,
    delayMs: initialDelayMs,
    chained: initialDelayMs > maxTimeoutMs,
  };
}
