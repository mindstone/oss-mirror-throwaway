import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AutomationScheduler as SchedulerService } from '../../services/automationScheduler';

const { handlers, logger } = vi.hoisted(() => ({
  handlers: new Map<string, (...args: any[]) => any>(),
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    trace: vi.fn(),
  },
}));

vi.mock('../utils/registerHandler', () => ({
  registerHandler: (channel: string, fn: (...args: any[]) => any) => {
    handlers.set(channel, fn);
  },
}));

vi.mock('@core/services/settingsStore', () => ({
  getSettings: vi.fn(() => ({ coreDirectory: null })),
}));

vi.mock('../../utils/automationFileValidation', () => ({
  validateAutomationFilePath: vi.fn(),
}));

vi.mock('@core/logger', () => ({
  createScopedLogger: () => logger,
}));

import { registerAutomationsHandlers } from '../automationsHandlers';

describe('registerAutomationsHandlers', () => {
  beforeEach(() => {
    handlers.clear();
    vi.clearAllMocks();
  });

  const getUpsertHandler = () => {
    const handler = handlers.get('automations:upsert');
    if (!handler) {
      throw new Error('automations:upsert handler was not registered');
    }
    return handler;
  };

  const getStateHandler = () => {
    const handler = handlers.get('automations:state');
    if (!handler) {
      throw new Error('automations:state handler was not registered');
    }
    return handler;
  };

  it('accepts update patches that omit schedule', async () => {
    const existingDefinition = {
      id: 'auto-1',
      name: 'Existing automation',
      filePath: 'existing.md',
      schedule: { type: 'daily', time: '09:00' },
      enabled: true,
    };
    const upsertDefinition = vi.fn((patch: Record<string, unknown>) => ({
      ...existingDefinition,
      ...patch,
    }));

    registerAutomationsHandlers({
      getScheduler: () =>
        ({
          getState: () => ({ definitions: [existingDefinition], runs: [] }),
          upsertDefinition,
        }) as unknown as SchedulerService,
    });

    const result = await getUpsertHandler()({} as never, {
      id: 'auto-1',
      enabled: false,
    });

    expect(result).toMatchObject({
      id: 'auto-1',
      enabled: false,
    });
    expect(upsertDefinition).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'auto-1',
        enabled: false,
      }),
    );
    expect(upsertDefinition.mock.calls[0]?.[0]).not.toHaveProperty('schedule');
  });

  it('preserves script executor fields across automations upsert + state round-trip', async () => {
    let definitions: Array<Record<string, unknown>> = [];
    const upsertDefinition = vi.fn((patch: Record<string, unknown>) => {
      const next = {
        id: 'script-auto-1',
        name: 'Cloud script automation',
        filePath: '',
        schedule: { type: 'daily', time: '09:00' },
        enabled: true,
        ...patch,
      };
      definitions = [next];
      return next;
    });

    registerAutomationsHandlers({
      getScheduler: () =>
        ({
          getState: () => ({ definitions, runs: [] }),
          upsertDefinition,
        }) as unknown as SchedulerService,
    });

    const payload = {
      id: 'script-auto-1',
      name: 'Cloud script automation',
      filePath: '',
      schedule: { type: 'daily', time: '09:00' },
      enabled: true,
      executor: 'script',
      scriptModule: 'foo',
      executeIn: 'cloud',
      timezone: 'UTC',
    } as const;

    const upserted = await getUpsertHandler()({} as never, payload);
    const state = getStateHandler()({} as never);

    expect(upsertDefinition).toHaveBeenCalledWith(expect.objectContaining(payload));
    expect(upserted).toMatchObject(payload);
    expect(state.definitions).toContainEqual(expect.objectContaining(payload));
  });

  describe('IPC repair shapes (R6 Stage 3 refinement)', () => {
    const setupSchedulerForUpsert = (
      definitions: Array<Record<string, unknown>> = [],
      upsertFn = vi.fn((patch: Record<string, unknown>) => ({ id: 'new-id', ...patch })),
    ) => {
      registerAutomationsHandlers({
        getScheduler: () =>
          ({
            getState: () => ({ definitions, runs: [] }),
            upsertDefinition: upsertFn,
          }) as unknown as SchedulerService,
      });
      return upsertFn;
    };

    it('normalises event_type (snake_case canonical) to eventType before upsert', async () => {
      const upsertDefinition = setupSchedulerForUpsert();

      await getUpsertHandler()({} as never, {
        name: 'Event Auto',
        filePath: 'auto.md',
        schedule: { type: 'event', event_type: 'transcript-ready' },
      } as never);

      expect(upsertDefinition).toHaveBeenCalledTimes(1);
      const passed = upsertDefinition.mock.calls[0]?.[0] as Record<string, unknown> | undefined;
      expect(passed?.schedule).toEqual({ type: 'event', eventType: 'transcript-ready' });
    });

    it('normalises legacy trigger alias to eventType before upsert', async () => {
      const upsertDefinition = setupSchedulerForUpsert();

      await getUpsertHandler()({} as never, {
        name: 'Legacy Trigger Auto',
        filePath: 'auto.md',
        schedule: { type: 'event', trigger: 'transcript-ready' },
      } as never);

      expect(upsertDefinition).toHaveBeenCalledTimes(1);
      const passed = upsertDefinition.mock.calls[0]?.[0] as Record<string, unknown> | undefined;
      expect(passed?.schedule).toEqual({ type: 'event', eventType: 'transcript-ready' });
    });

    it('backfills missing every_n_days anchorDate from existingCreatedAt on update', async () => {
      const existingCreatedAt = Date.UTC(2025, 4, 5, 12, 0, 0);
      const existingDefinition = {
        id: 'auto-interval',
        name: 'Existing interval automation',
        filePath: 'existing.md',
        schedule: { type: 'daily', time: '09:00' },
        enabled: true,
        createdAt: existingCreatedAt,
      };
      const upsertDefinition = setupSchedulerForUpsert([existingDefinition]);

      await getUpsertHandler()({} as never, {
        id: 'auto-interval',
        schedule: { type: 'every_n_days', intervalDays: 3, time: '09:00' },
      } as never);

      expect(upsertDefinition).toHaveBeenCalledTimes(1);
      const passed = upsertDefinition.mock.calls[0]?.[0] as Record<string, unknown> | undefined;
      expect(passed?.schedule).toEqual({
        type: 'every_n_days',
        intervalDays: 3,
        time: '09:00',
        anchorDate: '2025-05-05',
      });
    });

    it('rejects event schedules missing eventType, event_type, and trigger before upsert', async () => {
      const upsertDefinition = setupSchedulerForUpsert();

      await expect(
        getUpsertHandler()({} as never, {
          name: 'Bad Event',
          filePath: 'auto.md',
          schedule: { type: 'event' },
        } as never),
      ).rejects.toThrow(/Invalid schedule \(eventType\): event schedule is missing eventType/);

      expect(upsertDefinition).not.toHaveBeenCalled();
      expect(logger.warn).toHaveBeenCalledWith(
        { id: undefined, reason: 'missing-field' },
        'Rejected automation upsert: schedule validation failed',
      );
    });

    it('rejects unknown schedule types before upsert', async () => {
      const upsertDefinition = setupSchedulerForUpsert();

      await expect(
        getUpsertHandler()({} as never, {
          name: 'Bad Type',
          filePath: 'auto.md',
          schedule: { type: 'unknown' },
        } as never),
      ).rejects.toThrow(/Invalid schedule \(type\): schedule\.type "unknown" is not a recognised AutomationSchedule branch/);

      expect(upsertDefinition).not.toHaveBeenCalled();
      expect(logger.warn).toHaveBeenCalledWith(
        { id: undefined, reason: 'unknown-type' },
        'Rejected automation upsert: schedule validation failed',
      );
    });
  });

  it('rejects malformed payloads before calling the scheduler', async () => {
    const upsertDefinition = vi.fn();

    registerAutomationsHandlers({
      getScheduler: () =>
        ({
          getState: () => ({ definitions: [], runs: [] }),
          upsertDefinition,
        }) as unknown as SchedulerService,
    });

    await expect(
      getUpsertHandler()({} as never, {
        id: 'auto-1',
        executor: 'mystery',
      }),
    ).rejects.toThrow();

    expect(upsertDefinition).not.toHaveBeenCalled();
  });
});
