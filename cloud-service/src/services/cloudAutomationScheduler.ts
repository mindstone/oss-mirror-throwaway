/**
 * Cloud Automation Scheduler
 *
 * Lightweight scheduler (~250 LOC) that runs `executeIn: 'cloud'` automations
 * on the cloud service. Reads definitions from the cloud automation store,
 * calculates next run times using shared scheduling logic, and executes turns
 * via the same `executeAgentTurn` used by the rest of the cloud service.
 *
 * Design decisions:
 * - Uses `setTimeout` with timer chaining for Node's ~24.8 day max.
 * - Uses the definition's `timezone` field for correct local-time scheduling.
 * - Recalculates all timers from definitions on boot (no timer state persistence).
 * - No catch-up logic: if the machine was down during a scheduled time, the
 *   next run fires at the next scheduled window.
 */

import { randomUUID } from 'node:crypto';
import type { AgentSession, AutomationDefinition, AutomationRun, AgentEvent } from '@shared/types';
import { createScopedLogger } from '@core/logger';
import { fireAndForget } from '@shared/utils/fireAndForget';
import { getScheduler } from '@core/scheduler';
import {
  createAutomationRunDeduper,
  evaluateProviderReadinessRule,
  evaluateRateLimitCooldownRule,
  isProviderReadinessEligibleAutomation,
  scheduleDefinitionWithMaxTimeout,
  shouldSkipDueToActiveRun,
  waitForInteractiveTurnToSettle,
} from '@core/services/automation/automationRules';
import { apiRateLimitCooldown } from '@core/services/apiRateLimitCooldown';
import { agentTurnRegistry } from '@core/services/agentTurnRegistry';
import { getAutomationScript } from '@core/services/automations/scriptRegistry';
import { runAutomationScript } from '@core/services/automations/scriptRunner';
import type { ScriptAutomationLogger } from '@core/services/automations/types';
import { getIncrementalSessionStore } from '@core/services/incrementalSessionStore';
import { normalizeFinishLine } from '@core/utils/finishLine';
import { derivePolicy } from '@core/services/turnPolicy';
import type { ProviderCredentialState } from '@core/utils/validateProviderCredentials';
import { calculateNextRunAt } from '@shared/utils/automationScheduling';
import type { CloudAutomationStoreAdapter } from '../cloudAutomationStore';
import type { TurnPolicy } from '@core/types/turnPolicy';

const log = createScopedLogger({ service: 'cloudAutomationScheduler' });
const PROVIDER_READINESS_RETRY_TICK_MS = 60_000;

function canRunHere(definition: AutomationDefinition): boolean {
  const executor = definition.executor ?? 'llm';
  if (executor === 'script') {
    const moduleId = definition.scriptModule;
    return typeof moduleId === 'string' && moduleId.trim().length > 0 && getAutomationScript(moduleId) !== undefined;
  }

  return true;
}

function getUnknownExecutorError(definition: AutomationDefinition): string {
  return `Unknown executor: ${String(definition.executor)}`;
}

function getCloudRuntimeMissingScriptError(moduleId: string): string {
  return `No automation script is registered for "${moduleId}".`;
}

const scriptLog: ScriptAutomationLogger = log.child({ subcomponent: 'script' });

export interface CloudAutomationSchedulerDeps {
  /** Returns current automation definitions from the cloud store */
  getDefinitions: () => AutomationDefinition[];
  /** Snapshot current provider credential state for readiness gating. */
  getProviderCredentialState?: () => ProviderCredentialState | null;
  /** Executes an agent turn (same signature as desktop's runAutomationAgentTurn) */
  executeAgentTurn: (
    turnId: string,
    prompt: string,
    options: {
      sessionId: string;
      onEvent: (event: AgentEvent) => void;
      modelOverride?: string;
      thinkingModelOverride?: string;
      policy?: TurnPolicy;
    },
  ) => Promise<void>;
  /** Store adapter for recording run results */
  store: CloudAutomationStoreAdapter;
}

export class CloudAutomationScheduler {
  private timers = new Map<string, NodeJS.Timeout>();
  private running = new Set<string>();
  private readonly scheduler = getScheduler();
  private readonly runDeduper = createAutomationRunDeduper(this.running);
  private deps: CloudAutomationSchedulerDeps;

  constructor(deps: CloudAutomationSchedulerDeps) {
    this.deps = deps;
  }

  /**
   * Start the scheduler: schedule timers for all cloud-selected definitions.
   * Should be called once during bootstrap after the store is initialized.
   */
  start(): void {
    const definitions = this.deps.getDefinitions();
    this.warnOnDroppedCloudDefinitions(definitions);
    const cloudEnabledDefinitions = definitions.filter((definition) => definition.executeIn === 'cloud' && definition.enabled);
    const cloudDefinitions = this.getCloudDefinitions(definitions);
    for (const def of cloudEnabledDefinitions) {
      this.scheduleDefinition(def);
    }
    log.info(
      {
        cloudSelectedCount: cloudEnabledDefinitions.length,
        runnableCount: cloudDefinitions.length,
      },
      'Cloud automation scheduler started',
    );
  }

  /**
   * Stop all timers (used during shutdown).
   */
  stop(): void {
    for (const timer of this.timers.values()) {
      this.scheduler.clear(timer);
    }
    this.timers.clear();
    log.info({}, 'Cloud automation scheduler stopped');
  }

  /**
   * Called when definitions change (upsert/delete via IPC handler).
   * Reschedules timers for affected automations.
   */
  onDefinitionsChanged(definitions: AutomationDefinition[]): void {
    // Cancel all existing timers
    for (const timer of this.timers.values()) {
      this.scheduler.clear(timer);
    }
    this.timers.clear();

    this.warnOnDroppedCloudDefinitions(definitions);
    const cloudEnabledDefinitions = definitions.filter((definition) => definition.executeIn === 'cloud' && definition.enabled);
    const cloudDefs = this.getCloudDefinitions(definitions);
    for (const def of cloudEnabledDefinitions) {
      this.scheduleDefinition(def);
    }
    log.info(
      {
        cloudSelectedCount: cloudEnabledDefinitions.length,
        runnableCount: cloudDefs.length,
      },
      'Cloud automation scheduler rescheduled definitions',
    );
  }

  // ---------------------------------------------------------------------------
  // Private
  // ---------------------------------------------------------------------------

  private getCloudDefinitions(definitions = this.deps.getDefinitions()): AutomationDefinition[] {
    return definitions.filter(
      (d) => d.executeIn === 'cloud' && d.enabled && canRunHere(d),
    );
  }

  private warnOnDroppedCloudDefinitions(definitions: AutomationDefinition[]): void {
    for (const definition of definitions) {
      if (definition.executeIn !== 'cloud' || !definition.enabled || definition.executor !== 'script') {
        continue;
      }

      const moduleId = typeof definition.scriptModule === 'string' ? definition.scriptModule.trim() : '';
      if (moduleId.length === 0 || getAutomationScript(moduleId) !== undefined) {
        continue;
      }

      log.warn(
        {
          automationId: definition.id,
          automationName: definition.name,
          scriptModule: moduleId,
        },
        'Dropping cloud automation — no automation script is registered for this scriptModule on this cloud runtime',
      );
    }
  }

  private scheduleDefinition(definition: AutomationDefinition): void {
    this.clearTimer(definition.id);

    if (definition.executor === 'script') {
      const moduleId = typeof definition.scriptModule === 'string' ? definition.scriptModule.trim() : '';
      if (moduleId.length === 0) {
        const now = Date.now();
        this.deps.store.recordRun({
          id: randomUUID(),
          automationId: definition.id,
          startedAt: now,
          completedAt: now,
          status: 'failure',
          trigger: 'schedule',
          sessionId: null,
          error: `Automation "${definition.id}" is missing a scriptModule identifier.`,
        });
        return;
      }

      if (!canRunHere(definition)) {
        const now = Date.now();
        const error = getCloudRuntimeMissingScriptError(moduleId);
        log.warn(
          {
            automationId: definition.id,
            automationName: definition.name,
            scriptModule: moduleId,
            err: error,
          },
          'Refusing to schedule cloud automation — script module not registered',
        );
        this.deps.store.recordRun({
          id: randomUUID(),
          automationId: definition.id,
          startedAt: now,
          completedAt: now,
          status: 'failure',
          trigger: 'schedule',
          sessionId: null,
          error,
        });
        return;
      }
    }

    // Event-triggered automations don't use timers on cloud (no event sources)
    if (definition.schedule.type === 'event') {
      return;
    }

    const scheduled = scheduleDefinitionWithMaxTimeout<AutomationDefinition>({
      definitionId: definition.id,
      timers: this.timers,
      scheduler: this.scheduler,
      getDefinitionById: (id) => {
        const freshDefinition = this.deps
          .getDefinitions()
          .find((d) => d.id === id && d.executeIn === 'cloud' && d.enabled);
        if (freshDefinition) return freshDefinition;
        if (id === definition.id && definition.executeIn === 'cloud' && definition.enabled) {
          return definition;
        }
        return undefined;
      },
      calculateNextRunAt: (freshDefinition, fromMs) => {
        if (freshDefinition.schedule.type === 'event') return null;
        return calculateNextRunAt(freshDefinition, fromMs, freshDefinition.timezone);
      },
      onNextRunAt: (freshDefinition, nextRunAt) => {
        // Mirror nextRunAt back into the cloud store so desktops listening on
        // the slim delta channel can render accurate upcoming-run timestamps.
        this.deps.store.updateDefinitionNextRunAt(freshDefinition.id, nextRunAt);
      },
      onFire: (freshDefinition) => {
        fireAndForget(
          this.executeDefinition(freshDefinition),
          'cloud.automationScheduler.executeScheduledDefinition',
        );
      },
      onDropped: (definitionId) => {
        this.timers.delete(definitionId);
      },
    });

    if (!scheduled) {
      return;
    }

    log.info(
      {
        automationId: definition.id,
        automationName: definition.name,
        executeIn: Math.round(scheduled.delayMs / 1000),
        delayMs: scheduled.delayMs,
        nextRunAt: scheduled.nextRunAt,
        timezone: definition.timezone ?? 'system',
      },
      'Scheduled cloud automation',
    );
  }

  private clearTimer(id: string): void {
    const timer = this.timers.get(id);
    if (timer) {
      this.scheduler.clear(timer);
      this.timers.delete(id);
    }
  }

  private deferDefinition(definition: AutomationDefinition, delayMs: number, reason: string): void {
    this.clearTimer(definition.id);

    const delay = Math.max(0, delayMs);
    const timer = this.scheduler.registerTimeout(() => {
      const freshDef = this.deps.getDefinitions().find((d) => d.id === definition.id);
      if (!freshDef || freshDef.executeIn !== 'cloud' || !freshDef.enabled) {
        this.timers.delete(definition.id);
        log.info(
          {
            automationId: definition.id,
            automationName: definition.name,
            reason: 'no-longer-cloud-selected-or-disabled',
          },
          'Deferred cloud automation skipped',
        );
        return;
      }

      fireAndForget(
        this.executeDefinition(freshDef),
        'cloud.automationScheduler.executeDeferredDefinition',
      );
    }, delay);
    this.timers.set(definition.id, timer);

    log.info(
      {
        automationId: definition.id,
        automationName: definition.name,
        executeIn: Math.round(delay / 1000),
        delayMs: delay,
        reason,
      },
      'Deferred cloud automation',
    );
  }

  private async executeDefinition(definition: AutomationDefinition): Promise<void> {
    // Prevent concurrent runs of the same automation
    if (shouldSkipDueToActiveRun(this.runDeduper.isRunning(definition.id))) {
      log.info(
        {
          automationId: definition.id,
          automationName: definition.name,
          reason: 'already-running',
        },
        'Skipping cloud automation',
      );
      return;
    }

    // Re-read definition to ensure it's still cloud-selected and enabled
    let current = this.deps
      .getDefinitions()
      .find((d) => d.id === definition.id);
    if (!current || current.executeIn !== 'cloud' || !current.enabled) {
      log.info(
        {
          automationId: definition.id,
          automationName: definition.name,
          reason: 'no-longer-cloud-selected-or-disabled',
        },
        'Skipping cloud automation',
      );
      // Reschedule in case it was re-enabled as local
      return;
    }

    const credentialState = this.deps.getProviderCredentialState?.() ?? null;
    if (credentialState && isProviderReadinessEligibleAutomation(current)) {
      const providerReadiness = evaluateProviderReadinessRule({ credentialState });
      if (providerReadiness.status === 'blocked') {
        const now = Date.now();
        this.deps.store.recordRun({
          id: randomUUID(),
          automationId: current.id,
          startedAt: now,
          completedAt: now,
          status: 'provider_not_ready',
          trigger: 'schedule',
          sessionId: null,
          error: providerReadiness.reason.message,
          admissionBlock: providerReadiness.reason,
          errorKind: providerReadiness.reason.errorKind,
          headlineClass: providerReadiness.reason.headlineClass,
        }, {
          advanceScheduleSlot: current.schedule.type !== 'once',
        });
        if (current.schedule.type === 'once') {
          this.deferDefinition(
            current,
            PROVIDER_READINESS_RETRY_TICK_MS,
            'Provider readiness blocked once automation; retrying on scheduler tick',
          );
        } else {
          this.scheduleDefinition(current);
        }
        return;
      }
    }

    const rateLimitDecision = evaluateRateLimitCooldownRule({
      isAvailable: apiRateLimitCooldown.isAvailable(),
      remainingMs: apiRateLimitCooldown.remainingMs(),
    });
    if (rateLimitDecision.shouldDefer) {
      this.deferDefinition(
        current,
        rateLimitDecision.deferMs,
        rateLimitDecision.reason ?? 'API rate-limit cooldown active',
      );
      return;
    }

    if (agentTurnRegistry.hasInteractiveTurn()) {
      const result = await waitForInteractiveTurnToSettle({
        hasInteractiveTurn: () => agentTurnRegistry.hasInteractiveTurn(),
        isShuttingDown: () => false,
        scheduler: this.scheduler,
      });

      // Re-validate after deferral: the automation may have been disabled,
      // switched to local, or started by another trigger while waiting.
      const freshAfterDeferral = this.deps
        .getDefinitions()
        .find((d) => d.id === definition.id);
      if (!freshAfterDeferral || freshAfterDeferral.executeIn !== 'cloud' || !freshAfterDeferral.enabled) {
        log.info(
          {
            automationId: definition.id,
            automationName: definition.name,
            reason: 'no-longer-cloud-selected-or-disabled',
            deferredMs: result.deferredMs,
          },
          'Skipping cloud automation after deferral',
        );
        return;
      }
      if (shouldSkipDueToActiveRun(this.runDeduper.isRunning(definition.id))) {
        log.info(
          {
            automationId: definition.id,
            automationName: freshAfterDeferral.name,
            reason: 'already-running',
            deferredMs: result.deferredMs,
          },
          'Skipping cloud automation after deferral',
        );
        return;
      }
      current = freshAfterDeferral;
    }

    const runId = randomUUID();
    const startedAt = Date.now();

    if (!this.runDeduper.tryStart(definition.id)) {
      log.info(
        {
          automationId: definition.id,
          automationName: current.name,
          reason: 'already-running',
        },
        'Skipping cloud automation',
      );
      return;
    }
    log.info(
      {
        automationId: current.id,
        automationName: current.name,
        runId,
        executor: current.executor ?? 'llm',
      },
      'Executing cloud automation',
    );

    let status: 'success' | 'failure' = 'success';
    let errorMessage: string | null = null;
    let sessionId: string | null = null;
    // Capture the latest result event's toolMetrics so we can classify
    // all-tool-failure automations as failure (mirrors desktop behavior).
    // Without this, validator-stripped parameter mismatches (e.g., maxResults
    // vs max_results) cause silent "success" on cloud. See REBEL-1BK.
    let lastToolMetrics: { totalToolCalls: number; failedToolCalls: number } | undefined;
    let lastErrorKind: Extract<AgentEvent, { type: 'error' }>['errorKind'] | undefined;
    let lastRawError: string | undefined;

    try {
      if (current.executor === 'script') {
        const outcome = await runAutomationScript({
          automation: current,
          runId,
          trigger: 'scheduled',
          log: scriptLog,
        });

        if (outcome.status === 'failure') {
          status = 'failure';
          errorMessage = outcome.errorMessage;
        }
      } else if (current.executor !== undefined && current.executor !== 'llm') {
        status = 'failure';
        errorMessage = getUnknownExecutorError(current);
        log.warn(
          {
            automationId: current.id,
            automationName: current.name,
            executor: current.executor,
            err: errorMessage,
          },
          'Refusing to execute cloud automation — unknown executor',
        );
      } else {
        const automationType = current.systemType ?? current.id;
        sessionId = `automation-${automationType}--${randomUUID()}`;
        const turnId = randomUUID();

        // Read the automation skill file content
        const { readAutomationPrompt } = await import('./cloudAutomationPrompt');
        const prompt = await readAutomationPrompt(current);
        const hasModelOverride = !!current.model;
        const hasThinkingOverride = !!current.thinkingModel;
        const modelOverrides: { modelOverride?: string; thinkingModelOverride?: string } =
          hasModelOverride && !hasThinkingOverride
            ? { modelOverride: current.model, thinkingModelOverride: '' }
            : hasModelOverride && hasThinkingOverride
              ? { modelOverride: current.model, thinkingModelOverride: current.thinkingModel }
              : hasThinkingOverride
                ? { thinkingModelOverride: current.thinkingModel }
                : {};

        await seedAutomationSessionFinishLine(sessionId, current);

        await this.deps.executeAgentTurn(turnId, prompt, {
          sessionId,
          onEvent: (event: AgentEvent) => {
            if (event.type === 'result' && event.toolMetrics) {
              lastToolMetrics = {
                totalToolCalls: event.toolMetrics.totalToolCalls,
                failedToolCalls: event.toolMetrics.failedToolCalls,
              };
            } else if (event.type === 'error') {
              lastErrorKind = event.errorKind;
              // rawError is already redacted upstream; keep cloud run records bounded.
              lastRawError = event.rawError?.slice(0, 200);
            }
          },
          policy: derivePolicy('automation'),
          ...modelOverrides,
        });

        // Classify runs where every tool call failed as `failure`. Only applies
        // when the turn itself didn't throw — thrown errors are handled below.
        if (
          status === 'success' &&
          lastToolMetrics &&
          lastToolMetrics.totalToolCalls > 0 &&
          lastToolMetrics.failedToolCalls === lastToolMetrics.totalToolCalls
        ) {
          status = 'failure';
          errorMessage =
            lastToolMetrics.failedToolCalls === 1
              ? "The automation couldn't complete — its only tool call failed."
              : `The automation couldn't complete — all ${lastToolMetrics.failedToolCalls} tool calls failed.`;
          log.warn(
            {
              automationId: current.id,
              automationName: current.name,
              runId,
              failedToolCalls: lastToolMetrics.failedToolCalls,
              totalToolCalls: lastToolMetrics.totalToolCalls,
            },
            'Run classified as failure: all tool calls failed',
          );
          // Sentry capture so ops can alert on this pattern. Best effort.
          try {
            const { getErrorReporter } = await import('@core/errorReporter');
            getErrorReporter().captureMessage(
              'Automation classified as failure: all tool calls failed',
              {
                level: 'warning',
                tags: {
                  classification: 'automation_all_tools_failed',
                  automationId: definition.id,
                  surface: 'cloud',
                },
                extra: {
                  runId,
                  sessionId,
                  failedToolCalls: lastToolMetrics.failedToolCalls,
                  totalToolCalls: lastToolMetrics.totalToolCalls,
                },
              },
            );
          } catch {
            // Best effort
          }
        }
      }
    } catch (err) {
      status = 'failure';
      errorMessage = err instanceof Error ? err.message : String(err);
      log.error(
        {
          automationId: current.id,
          automationName: current.name,
          runId,
          err: errorMessage,
        },
        'Cloud automation execution failed',
      );
    } finally {
      this.runDeduper.finish(definition.id);

      // Record the run result
      const completedAt = Date.now();
      const run: AutomationRun = {
        id: runId,
        automationId: definition.id,
        startedAt,
        completedAt,
        status,
        trigger: 'schedule',
        sessionId,
        error: errorMessage,
        ...(lastErrorKind ? { errorKind: lastErrorKind } : {}),
        ...(lastRawError ? { rawError: lastRawError } : {}),
      };
      this.deps.store.recordRun(run);

      // Reschedule for the next occurrence
      const freshDef = this.deps
        .getDefinitions()
        .find((d) => d.id === definition.id);
      if (freshDef && freshDef.executeIn === 'cloud' && freshDef.enabled) {
        if (freshDef.executor === 'script' && !canRunHere(freshDef)) {
          this.timers.delete(definition.id);
          const moduleId = typeof freshDef.scriptModule === 'string' ? freshDef.scriptModule.trim() : '';
          log.info(
            {
              automationId: freshDef.id,
              automationName: freshDef.name,
              scriptModule: moduleId,
              reason: 'script-module-not-registered',
            },
            'Not rescheduling cloud automation — will reschedule on next definitions change',
          );
        } else {
          this.scheduleDefinition(freshDef);
        }
      }

      log.info(
        {
          automationId: current.id,
          automationName: current.name,
          runId,
          status,
          durationMs: completedAt - startedAt,
        },
        'Cloud automation completed',
      );
    }
  }
}

// Mirrors `seedAutomationSessionFinishLine` in
// `src/main/services/automationScheduler.ts`. Pre-writes the automation's
// finish-line criterion onto the session record so the executor's
// session-fallback path resolves it on the spawn turn AND on subsequent
// user-reply turns within the same session, instead of threading the
// criterion through `executeAgentTurn` options (which would invert
// precedence relative to per-session edits).
async function seedAutomationSessionFinishLine(
  sessionId: string,
  automation: AutomationDefinition,
): Promise<void> {
  const finishLine = normalizeFinishLine(automation.finishLine);
  if (!finishLine) return;
  try {
    const now = Date.now();
    await getIncrementalSessionStore().updateSession(sessionId, (existing) => {
      if (existing) {
        if (existing.finishLine !== undefined) {
          return null;
        }
        return {
          ...existing,
          finishLine,
          updatedAt: now,
        };
      }
      const shell: AgentSession = {
        id: sessionId,
        title: automation.name,
        createdAt: now,
        updatedAt: now,
        messages: [],
        eventsByTurn: {},
        activeTurnId: null,
        isBusy: false,
        lastError: null,
        resolvedAt: null,
        origin: 'automation',
        automationId: automation.id,
        finishLine,
      };
      return shell;
    });
  } catch (err) {
    log.warn(
      { err, sessionId, automationId: automation.id },
      'Failed to seed automation finish line on session record',
    );
  }
}
