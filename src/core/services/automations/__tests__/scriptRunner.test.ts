import type { AutomationDefinition } from '@shared/types';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { clearAutomationScripts, registerAutomationScript } from '../scriptRegistry';
import { runAutomationScript, SCRIPT_DEFAULT_TIMEOUT_MS } from '../scriptRunner';
import type { AutomationScriptFn, ScriptAutomationLogger } from '../types';
import { AutomationSchedule } from '@shared/utils/automationSchedule';

type LogEntry = {
  level: 'debug' | 'info' | 'warn' | 'error';
  obj: Record<string, unknown>;
  message: string;
};

function createAutomation(overrides: Partial<AutomationDefinition> = {}): AutomationDefinition {
  return {
    id: 'automation-1',
    name: 'Test automation',
    filePath: '/tmp/test-automation.md',
    schedule: AutomationSchedule.daily({
      time: '09:00',
      additionalTimes: ['14:00'],
    }),
    enabled: true,
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

function createLogger(
  overrides: Partial<ScriptAutomationLogger> = {},
): { log: ScriptAutomationLogger; entries: LogEntry[] } {
  const entries: LogEntry[] = [];

  const push = (level: LogEntry['level']) => (obj: Record<string, unknown>, message: string) => {
    entries.push({ level, obj, message });
  };

  const baseLog: ScriptAutomationLogger = {
    debug: push('debug'),
    info: push('info'),
    warn: push('warn'),
    error: push('error'),
  };

  return {
    log: { ...baseLog, ...overrides },
    entries,
  };
}

describe('runAutomationScript', () => {
  afterEach(() => {
    vi.useRealTimers();
    clearAutomationScripts();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('returns success when a registered script completes with a summary', async () => {
    const { log, entries } = createLogger();

    registerAutomationScript('script.success', async (ctx) => {
      expect(ctx.runId).toBe('run-1');
      expect(ctx.trigger).toBe('manual');

      return {
        summary: 'Completed successfully',
        output: { rowsProcessed: 3 },
      };
    });

    const outcome = await runAutomationScript({
      automation: createAutomation({
        executor: 'script',
        scriptModule: 'script.success',
      }),
      runId: 'run-1',
      trigger: 'manual',
      log,
    });

    expect(outcome).toEqual({
      status: 'success',
      summary: 'Completed successfully',
      output: { rowsProcessed: 3 },
    });
    expect(entries.filter((entry) => entry.level === 'info')).toHaveLength(2);
  });

  it('returns MISSING_SCRIPT_MODULE when scriptModule is absent', async () => {
    const { log, entries } = createLogger();

    const outcome = await runAutomationScript({
      automation: createAutomation({
        executor: 'script',
        scriptModule: undefined,
      }),
      runId: 'run-2',
      trigger: 'scheduled',
      log,
    });

    expect(outcome).toEqual({
      status: 'failure',
      errorCode: 'MISSING_SCRIPT_MODULE',
      errorMessage: 'Automation "automation-1" is missing a scriptModule identifier.',
    });
    expect(entries.at(-1)).toMatchObject({
      level: 'warn',
      message: 'Automation script run is missing scriptModule.',
    });
  });

  it('returns UNKNOWN_SCRIPT_MODULE when no script is registered', async () => {
    const { log } = createLogger();

    const outcome = await runAutomationScript({
      automation: createAutomation({
        executor: 'script',
        scriptModule: 'script.unknown',
      }),
      runId: 'run-3',
      trigger: 'event',
      log,
    });

    expect(outcome).toEqual({
      status: 'failure',
      errorCode: 'UNKNOWN_SCRIPT_MODULE',
      errorMessage: 'No automation script is registered for "script.unknown".',
    });
  });

  it('returns SCRIPT_THREW when the script throws', async () => {
    const { log, entries } = createLogger();

    registerAutomationScript('script.failure', async () => {
      throw new Error('kaboom');
    });

    const outcome = await runAutomationScript({
      automation: createAutomation({
        executor: 'script',
        scriptModule: 'script.failure',
      }),
      runId: 'run-4',
      trigger: 'catchup',
      log,
    });

    expect(outcome).toEqual({
      status: 'failure',
      errorCode: 'SCRIPT_THREW',
      errorMessage: 'kaboom',
    });
    expect(entries.at(-1)).toMatchObject({
      level: 'error',
      message: 'Automation script run failed.',
    });
  });

  it('runner returns normalized failure when structuredClone throws', async () => {
    const { log, entries } = createLogger();

    vi.stubGlobal('structuredClone', () => {
      throw new Error('clone exploded');
    });

    registerAutomationScript('script.clone-failure', async () => ({
      summary: 'This should never run',
    }));

    const outcome = await runAutomationScript({
      automation: createAutomation({
        executor: 'script',
        scriptModule: 'script.clone-failure',
      }),
      runId: 'run-clone-failure',
      trigger: 'manual',
      log,
    });

    expect(outcome).toEqual({
      status: 'failure',
      errorCode: 'SCRIPT_THREW',
      errorMessage: 'Runner internal error: clone exploded',
    });
    expect(entries.at(-1)).toMatchObject({
      level: 'error',
      message: 'Script runner unexpected error',
    });
  });

  it('runner does not throw when logger throws', async () => {
    const { log } = createLogger({
      info: () => {
        throw new Error('logger exploded');
      },
    });

    registerAutomationScript('script.logger-safe', async (ctx) => {
      ctx.log.info({ phase: 'script' }, 'Logging from the script should be safe.');

      return {
        summary: 'Completed despite broken logger',
      };
    });

    const outcome = await runAutomationScript({
      automation: createAutomation({
        executor: 'script',
        scriptModule: 'script.logger-safe',
      }),
      runId: 'run-logger-safe',
      trigger: 'manual',
      log,
    });

    expect(outcome).toEqual({
      status: 'success',
      summary: 'Completed despite broken logger',
    });
  });

  it('runner distinguishes sync throw from Promise.reject', async () => {
    const { log } = createLogger();

    registerAutomationScript(
      'script.sync-throw',
      ((() => {
        throw new Error('sync kaboom');
      }) as unknown) as AutomationScriptFn,
    );
    registerAutomationScript('script.promise-reject', () => Promise.reject(new Error('reject kaboom')));

    const syncOutcome = await runAutomationScript({
      automation: createAutomation({
        executor: 'script',
        scriptModule: 'script.sync-throw',
      }),
      runId: 'run-sync-throw',
      trigger: 'manual',
      log,
    });

    const rejectOutcome = await runAutomationScript({
      automation: createAutomation({
        executor: 'script',
        scriptModule: 'script.promise-reject',
      }),
      runId: 'run-promise-reject',
      trigger: 'manual',
      log,
    });

    expect(syncOutcome).toEqual({
      status: 'failure',
      errorCode: 'SCRIPT_THREW',
      errorMessage: 'sync kaboom',
    });
    expect(rejectOutcome).toEqual({
      status: 'failure',
      errorCode: 'SCRIPT_THREW',
      errorMessage: 'reject kaboom',
    });
  });

  it('returns INVALID_EXECUTOR when called with an unknown executor', async () => {
    const { log, entries } = createLogger();

    const outcome = await runAutomationScript({
      automation: createAutomation({
        executor: 'fetcher' as never,
        scriptModule: 'script.future',
      }),
      runId: 'run-5',
      trigger: 'manual',
      log,
    });

    expect(outcome).toEqual({
      status: 'failure',
      errorCode: 'INVALID_EXECUTOR',
      errorMessage: 'runAutomationScript expected executor "script" but received "fetcher".',
    });
    expect(entries.at(-1)).toMatchObject({
      level: 'warn',
      message: 'Automation script run received an invalid executor.',
      obj: expect.objectContaining({
        executor: 'fetcher',
      }),
    });
  });

  it('passes a frozen automation snapshot to scripts so mutations cannot affect scheduler state', async () => {
    const { log } = createLogger();
    const automation = createAutomation({
      executor: 'script',
      scriptModule: 'script.mutation',
      schedule: AutomationSchedule.daily({
        time: '11:30',
        additionalTimes: ['16:45'],
      }),
    });

    let topLevelMutationError: unknown;
    let nestedMutationError: unknown;

    registerAutomationScript('script.mutation', async (ctx) => {
      expect(Object.isFrozen(ctx.automation)).toBe(true);
      expect(Object.isFrozen(ctx.automation.schedule)).toBe(true);

      try {
        (ctx.automation as AutomationDefinition).name = 'Mutated name';
      } catch (error) {
        topLevelMutationError = error;
      }

      try {
        if (ctx.automation.schedule.type === 'daily') {
          ctx.automation.schedule.time = '18:00';
        }
      } catch (error) {
        nestedMutationError = error;
      }

      return {
        summary: 'Mutation attempt blocked',
      };
    });

    const outcome = await runAutomationScript({
      automation,
      runId: 'run-6',
      trigger: 'manual',
      log,
    });

    expect(outcome).toEqual({
      status: 'success',
      summary: 'Mutation attempt blocked',
    });
    expect(topLevelMutationError).toBeInstanceOf(TypeError);
    expect(nestedMutationError).toBeInstanceOf(TypeError);
    expect(automation.name).toBe('Test automation');
    expect(automation.schedule).toEqual({
      type: 'daily',
      time: '11:30',
      additionalTimes: ['16:45'],
    });
  });

  it('runner normalizes null/undefined summary/output', async () => {
    const { log } = createLogger();

    registerAutomationScript(
      'script.nullish-result',
      (async () => ({ summary: null, output: undefined })) as unknown as AutomationScriptFn,
    );

    const outcome = await runAutomationScript({
      automation: createAutomation({
        executor: 'script',
        scriptModule: 'script.nullish-result',
      }),
      runId: 'run-nullish-result',
      trigger: 'manual',
      log,
    });

    expect(outcome).toEqual({ status: 'success' });
    expect(outcome).not.toHaveProperty('summary');
    expect(outcome).not.toHaveProperty('output');
  });

  it('fails with SCRIPT_THREW when a script exceeds the 30s timeout', async () => {
    vi.useFakeTimers();
    const { log } = createLogger();

    registerAutomationScript('script.timeout', () => new Promise<never>(() => undefined));

    const outcomePromise = runAutomationScript({
      automation: createAutomation({
        executor: 'script',
        scriptModule: 'script.timeout',
      }),
      runId: 'run-timeout',
      trigger: 'manual',
      log,
    });

    await vi.advanceTimersByTimeAsync(SCRIPT_DEFAULT_TIMEOUT_MS);
    const outcome = await outcomePromise;

    expect(outcome).toMatchObject({
      status: 'failure',
      errorCode: 'SCRIPT_THREW',
    });
    if (outcome.status === 'failure') {
      expect(outcome.errorMessage).toMatch(/30s|timeout/i);
    }
  });

  it('clears the timeout timer when a script succeeds before the deadline', async () => {
    vi.useFakeTimers();
    const { log } = createLogger();

    registerAutomationScript(
      'script.fast-success',
      () =>
        new Promise((resolve) => {
          setTimeout(() => {
            resolve({ summary: 'done quickly' });
          }, 100);
        }),
    );

    const outcomePromise = runAutomationScript({
      automation: createAutomation({
        executor: 'script',
        scriptModule: 'script.fast-success',
      }),
      runId: 'run-fast-success',
      trigger: 'manual',
      log,
    });

    await vi.advanceTimersByTimeAsync(200);
    const outcome = await outcomePromise;

    expect(outcome).toEqual({
      status: 'success',
      summary: 'done quickly',
    });
    expect(vi.getTimerCount()).toBe(0);
  });
});
