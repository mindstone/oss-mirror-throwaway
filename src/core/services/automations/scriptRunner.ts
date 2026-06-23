import type { AutomationDefinition } from '@shared/types';
import { getAutomationScript } from './scriptRegistry';
import type {
  ScriptAutomationContext,
  ScriptAutomationLogger,
  ScriptAutomationResult,
  ScriptRunOutcome,
} from './types';

export const SCRIPT_DEFAULT_TIMEOUT_MS = 30_000;

export interface RunScriptAutomationInput {
  readonly automation: AutomationDefinition;
  readonly runId: string;
  readonly trigger: ScriptAutomationContext['trigger'];
  readonly signal?: AbortSignal;
  readonly log: ScriptAutomationLogger;
}

function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) {
    return value;
  }

  for (const child of Object.values(value as Record<string, unknown>)) {
    deepFreeze(child);
  }

  return Object.freeze(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasOwn(obj: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(obj, key);
}

function extractErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim().length > 0) {
    return error.message;
  }

  if (typeof error === 'string' && error.trim().length > 0) {
    return error;
  }

  try {
    return JSON.stringify(error) ?? 'Unknown script error';
  } catch {
    return String(error);
  }
}

function safeExtractErrorMessage(error: unknown): string {
  try {
    return extractErrorMessage(error);
  } catch {
    return 'unknown error';
  }
}

function makeSafeLogger(log: ScriptAutomationLogger): ScriptAutomationLogger {
  return {
    debug: (obj, message) => {
      try {
        log.debug(obj, message);
      } catch {
        // Swallow logger failures so the runner keeps its never-throws contract.
      }
    },
    info: (obj, message) => {
      try {
        log.info(obj, message);
      } catch {
        // Swallow logger failures so the runner keeps its never-throws contract.
      }
    },
    warn: (obj, message) => {
      try {
        log.warn(obj, message);
      } catch {
        // Swallow logger failures so the runner keeps its never-throws contract.
      }
    },
    error: (obj, message) => {
      try {
        log.error(obj, message);
      } catch {
        // Swallow logger failures so the runner keeps its never-throws contract.
      }
    },
  };
}

function normalizeSuccessResult(
  result: unknown,
  log: ScriptAutomationLogger,
  automation: AutomationDefinition,
): ScriptRunOutcome {
  if (result == null) {
    return { status: 'success' };
  }

  if (isRecord(result) && (hasOwn(result, 'summary') || hasOwn(result, 'output'))) {
    const normalized: Extract<ScriptRunOutcome, { status: 'success' }> = { status: 'success' };

    if (typeof result.summary === 'string') {
      normalized.summary = result.summary;
    }

    if (isRecord(result.output)) {
      normalized.output = result.output;
    }

    return normalized;
  }

  log.debug(
    {
      automationId: automation.id,
      returnType: Array.isArray(result) ? 'array' : typeof result,
    },
    'Automation script returned an unexpected result shape; normalizing to success.',
  );

  return { status: 'success' };
}

function createFrozenAutomationSnapshot(automation: AutomationDefinition): Readonly<AutomationDefinition> {
  return deepFreeze(structuredClone(automation));
}

/**
 * Execute a script automation.
 *
 * Never throws. Exceptions from the registered script, missing module references, and unknown
 * executor values are all captured as `{ status: 'failure', errorCode, errorMessage }`.
 *
 * The `automation` passed into the script's context is frozen via `Object.freeze` + a shallow
 * deep-freeze of nested object fields known to be referenced by scripts. This prevents scripts
 * from mutating scheduler state (B7 from the plan critique synthesis).
 */
export async function runAutomationScript(input: RunScriptAutomationInput): Promise<ScriptRunOutcome> {
  const safeLog = makeSafeLogger(input.log);

  try {
    const startedAt = Date.now();
    const normalizedExecutor = input.automation.executor ?? 'llm';

    if (normalizedExecutor !== 'script') {
      safeLog.warn(
        {
          automationId: input.automation.id,
          runId: input.runId,
          executor: normalizedExecutor,
        },
        'Automation script run received an invalid executor.',
      );

      return {
        status: 'failure',
        errorCode: 'INVALID_EXECUTOR',
        errorMessage: `runAutomationScript expected executor "script" but received "${normalizedExecutor}".`,
      };
    }

    const scriptModule = input.automation.scriptModule;
    if (typeof scriptModule !== 'string' || scriptModule.trim().length === 0) {
      safeLog.warn(
        {
          automationId: input.automation.id,
          runId: input.runId,
        },
        'Automation script run is missing scriptModule.',
      );

      return {
        status: 'failure',
        errorCode: 'MISSING_SCRIPT_MODULE',
        errorMessage: `Automation "${input.automation.id}" is missing a scriptModule identifier.`,
      };
    }

    const script = getAutomationScript(scriptModule);
    if (!script) {
      safeLog.warn(
        {
          automationId: input.automation.id,
          runId: input.runId,
          scriptModule,
        },
        'Automation script module is not registered.',
      );

      return {
        status: 'failure',
        errorCode: 'UNKNOWN_SCRIPT_MODULE',
        errorMessage: `No automation script is registered for "${scriptModule}".`,
      };
    }

    safeLog.info(
      {
        automationId: input.automation.id,
        runId: input.runId,
        trigger: input.trigger,
        scriptModule,
      },
      'Starting automation script run.',
    );

    const context: ScriptAutomationContext = {
      automation: createFrozenAutomationSnapshot(input.automation),
      runId: input.runId,
      trigger: input.trigger,
      signal: input.signal,
      log: safeLog,
    };

    try {
      // NOTE: This timeout only bounds the scheduler's view of the run. PR 1 does not yet
      // propagate an AbortController into script code, so a timed-out script may keep running
      // in the background even after the scheduler records a failure and allows the next run.
      // Any orphaned side effects are therefore the script author's responsibility to avoid.
      let timerHandle: ReturnType<typeof setTimeout> | undefined;
      const scriptPromise = Promise.resolve()
        .then(() => script(context))
        .finally(() => {
          if (timerHandle) {
            clearTimeout(timerHandle);
          }
        });
      const timeoutPromise = new Promise<never>((_, reject) => {
        timerHandle = setTimeout(() => {
          reject(new Error('Script exceeded 30s timeout'));
        }, SCRIPT_DEFAULT_TIMEOUT_MS);
      });

      const result = await Promise.race([scriptPromise, timeoutPromise]);
      const outcome = normalizeSuccessResult(result as ScriptAutomationResult | unknown, safeLog, input.automation);

      safeLog.info(
        {
          automationId: input.automation.id,
          runId: input.runId,
          durationMs: Date.now() - startedAt,
          status: outcome.status,
          scriptModule,
        },
        'Automation script run finished.',
      );

      return outcome;
    } catch (error) {
      const errorMessage = safeExtractErrorMessage(error);

      safeLog.error(
        {
          automationId: input.automation.id,
          runId: input.runId,
          durationMs: Date.now() - startedAt,
          scriptModule,
          errorMessage,
          errorStack: error instanceof Error ? error.stack : undefined,
        },
        'Automation script run failed.',
      );

      return {
        status: 'failure',
        errorCode: 'SCRIPT_THREW',
        errorMessage,
      };
    }
  } catch (error) {
    const errorMessage = safeExtractErrorMessage(error);

    try {
      safeLog.error(
        {
          automationId: input.automation?.id,
          runId: input.runId,
          err: errorMessage,
        },
        'Script runner unexpected error',
      );
    } catch {
      // Swallow even safe logger failures so the runner still returns a normalized outcome.
    }

    return {
      status: 'failure',
      errorCode: 'SCRIPT_THREW',
      errorMessage: `Runner internal error: ${errorMessage}`,
    };
  }
}
