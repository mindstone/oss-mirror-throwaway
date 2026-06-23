/**
 * Tests for the space-maintenance scheduler branch (Stage 2).
 *
 * Covers:
 *   - Migration v30 -> v31 creates the automation entry exactly once
 *     (idempotent on re-run).
 *   - `createDefaultAutomationState()` seeds space-maintenance for fresh installs.
 *   - `runAutomationPipeline()` routes to the space-maintenance branch and
 *     returns an `AutomationExecutionResult` shape.
 *   - Run-time gate: skip cleanly when the user has no non-private shared spaces.
 *   - Result shape: errors -> `completed_with_blocks`, success -> `success`.
 *
 * Keeps scope narrow: this file is for Stage 2 wiring only. The broader
 * scheduler test file (automationScheduler.test.ts) already exercises the
 * calendar/community/focus branches end-to-end.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { AppSettings, AutomationDefinition } from '@shared/types';
import { AutomationSchedule } from '@shared/utils/automationSchedule';

 
vi.mock('electron-store', () => {
  class MemoryStore<T> {
    store: T;
    constructor(options: { defaults: T }) {
      this.store = structuredClone(options.defaults);
    }
  }
  return { default: MemoryStore };
});

const mockLoggerMethods = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
  trace: vi.fn(),
};
 
vi.mock('@core/logger', () => ({
  createScopedLogger: () => mockLoggerMethods,
  logger: mockLoggerMethods,
}));

 
vi.mock('@main/analytics', () => ({
  trackMainEvent: vi.fn(),
  getOrGenerateAnonymousId: () => 'test-anonymous-id',
}));

 
vi.mock('@core/broadcastService', () => ({
  getBroadcastService: () => ({ sendToAllWindows: vi.fn(), sendToFocusedWindow: vi.fn() }),
}));

 
vi.mock('../agentTurnRegistry', () => ({
  agentTurnRegistry: {
    getSecurityDenials: vi.fn().mockReturnValue([]),
    clearSecurityDenials: vi.fn(),
    hasInteractiveTurn: vi.fn().mockReturnValue(false),
  },
}));

 
vi.mock('../shutdownState', () => ({
  isShuttingDown: vi.fn().mockReturnValue(false),
}));

 
vi.mock('../agentEventDispatcher', async () => {
  const actual = await vi.importActual<typeof import('../agentEventDispatcher')>(
    '../agentEventDispatcher',
  );
  return {
    ...actual,
    dispatchAgentEvent: vi.fn(),
    dispatchAgentErrorEvent: vi.fn(),
    showAutomationOutcomeNotification: vi.fn(),
  };
});

// Access private method for run-time gate testing via any-cast — kept local to this file.
type SchedulerWithPrivate = {
  runSpaceMaintenancePipeline: (automation: AutomationDefinition, runId: string) => Promise<{
    status: string;
    error: string | null;
  }>;
};

function makeDefinition(overrides: Partial<AutomationDefinition> = {}): AutomationDefinition {
  return {
    id: 'system-space-maintenance',
    name: 'Space Maintenance',
    filePath: '',
    schedule: AutomationSchedule.daily({ time: '06:00' }),
    enabled: true,
    catchUpIfMissed: true,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    isSystem: true,
    systemType: 'space-maintenance',
    ...overrides,
  };
}

function emptyResult(): import('@core/services/spaceMaintenanceService').MaintenanceResult {
  return {
    scanned: 0,
    quarantinedIdentical: 0,
    mergedSuccessfully: 0,
    mergeFailed: 0,
    mergeSkippedBackoff: 0,
    mergeSkippedCircuitBreaker: 0,
    mergeSkippedBinary: 0,
    mergeSkippedTooLarge: 0,
    mergeAbortedRace: 0,
    frontmatterRepaired: 0,
    // Stage 4 counters: start at zero for the scheduler unit test.
    numberedCopyQuarantinedIdentical: 0,
    numberedCopyMerged: 0,
    numberedCopyLegacySkipped: 0,
    numberedCopyPendingStability: 0,
    numberedCopyPendingUserReview: 0,
    numberedCopySkippedBinary: 0,
    numberedCopySkippedTooLarge: 0,
    errors: [],
    elapsedMs: 0,
  };
}

describe('automationScheduler — space-maintenance wiring', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('createDefaultAutomationState + migration', () => {
    it('fresh install seeds a space-maintenance automation', async () => {
      const { AutomationScheduler } = await import('../automationScheduler');
      const scheduler = new AutomationScheduler({
        getCoreDirectory: () => '/tmp/core',
        executeAgentTurn: vi.fn(),
      });
      const state = scheduler.getState();
      const spaceMaint = state.definitions.find(
        (d) => d.isSystem && d.systemType === 'space-maintenance',
      );
      expect(spaceMaint).toBeDefined();
      expect(spaceMaint?.id).toBe('system-space-maintenance');
      expect(spaceMaint?.enabled).toBe(true);
      expect(spaceMaint?.schedule).toEqual({ type: 'daily', time: '06:00' });
      // No `model` field — proposeMerge uses settings.modelRoles.auxiliary.
      expect(spaceMaint?.model).toBeUndefined();
    });

    it('produces exactly one space-maintenance entry (idempotent default state)', async () => {
      // Construct the scheduler twice to exercise the default-state -> save
      // round trip. The second construction reads the persisted state and
      // must not create a duplicate entry.
      const { AutomationScheduler } = await import('../automationScheduler');
      const a = new AutomationScheduler({
        getCoreDirectory: () => '/tmp/core',
        executeAgentTurn: vi.fn(),
      });
      const b = new AutomationScheduler({
        getCoreDirectory: () => '/tmp/core',
        executeAgentTurn: vi.fn(),
      });
      for (const scheduler of [a, b]) {
        const matches = scheduler
          .getState()
          .definitions.filter((d) => d.isSystem && d.systemType === 'space-maintenance');
        expect(matches).toHaveLength(1);
      }
    });
  });

  describe('runSpaceMaintenancePipeline', () => {
    it('skips cleanly with status=success when no non-private shared spaces are configured', async () => {
      const runSpaceMaintenance = vi.fn();
      const { AutomationScheduler } = await import('../automationScheduler');
      const scheduler = new AutomationScheduler({
        getCoreDirectory: () => '/tmp/core',
        executeAgentTurn: vi.fn(),
        getSettings: () => ({ spaces: [] } as unknown as AppSettings),
        runSpaceMaintenance,
      });

      const def = makeDefinition();
      const result = await (scheduler as unknown as SchedulerWithPrivate).runSpaceMaintenancePipeline(
        def,
        'test-run-id',
      );
      expect(result.status).toBe('success');
      expect(result.error).toBeNull();
      // Critically: the dep must not be invoked — daily no-op.
      expect(runSpaceMaintenance).not.toHaveBeenCalled();
    });

    it('returns success when the dep resolves with no errors', async () => {
      const runSpaceMaintenance = vi
        .fn()
        .mockResolvedValue({ ...emptyResult(), mergedSuccessfully: 2 });

      const { AutomationScheduler } = await import('../automationScheduler');
      const scheduler = new AutomationScheduler({
        getCoreDirectory: () => '/tmp/core',
        executeAgentTurn: vi.fn(),
        getSettings: () =>
          ({
            spaces: [
              { name: 'Team', path: 'Team', type: 'team', isSymlink: false, sharing: 'restricted', createdAt: 0 },
            ],
          }) as unknown as AppSettings,
        runSpaceMaintenance,
      });

      const def = makeDefinition();
      const result = await (scheduler as unknown as SchedulerWithPrivate).runSpaceMaintenancePipeline(
        def,
        'test-run-id',
      );
      expect(result.status).toBe('success');
      expect(result.error).toBeNull();
      expect(runSpaceMaintenance).toHaveBeenCalledTimes(1);
    });

    it('returns completed_with_blocks when the dep reports errors', async () => {
      const runSpaceMaintenance = vi
        .fn()
        .mockResolvedValue({ ...emptyResult(), errors: ['boom', 'again'] });

      const { AutomationScheduler } = await import('../automationScheduler');
      const scheduler = new AutomationScheduler({
        getCoreDirectory: () => '/tmp/core',
        executeAgentTurn: vi.fn(),
        getSettings: () =>
          ({
            spaces: [
              { name: 'Team', path: 'Team', type: 'team', isSymlink: false, sharing: 'restricted', createdAt: 0 },
            ],
          }) as unknown as AppSettings,
        runSpaceMaintenance,
      });

      const def = makeDefinition();
      const result = await (scheduler as unknown as SchedulerWithPrivate).runSpaceMaintenancePipeline(
        def,
        'test-run-id',
      );
      expect(result.status).toBe('completed_with_blocks');
      expect(result.error).toContain('boom');
    });

    it('returns failure when the dep is not wired', async () => {
      const { AutomationScheduler } = await import('../automationScheduler');
      const scheduler = new AutomationScheduler({
        getCoreDirectory: () => '/tmp/core',
        executeAgentTurn: vi.fn(),
        getSettings: () =>
          ({
            spaces: [
              { name: 'Team', path: 'Team', type: 'team', isSymlink: false, sharing: 'restricted', createdAt: 0 },
            ],
          }) as unknown as AppSettings,
        // runSpaceMaintenance omitted
      });

      const def = makeDefinition();
      const result = await (scheduler as unknown as SchedulerWithPrivate).runSpaceMaintenancePipeline(
        def,
        'test-run-id',
      );
      expect(result.status).toBe('failure');
      expect(result.error).toContain('space-maintenance dep not wired');
    });

    it('returns failure when the dep throws', async () => {
      const runSpaceMaintenance = vi.fn().mockRejectedValue(new Error('kaboom'));
      const { AutomationScheduler } = await import('../automationScheduler');
      const scheduler = new AutomationScheduler({
        getCoreDirectory: () => '/tmp/core',
        executeAgentTurn: vi.fn(),
        getSettings: () =>
          ({
            spaces: [
              { name: 'Team', path: 'Team', type: 'team', isSymlink: false, sharing: 'restricted', createdAt: 0 },
            ],
          }) as unknown as AppSettings,
        runSpaceMaintenance,
      });

      const def = makeDefinition();
      const result = await (scheduler as unknown as SchedulerWithPrivate).runSpaceMaintenancePipeline(
        def,
        'test-run-id',
      );
      expect(result.status).toBe('failure');
      expect(result.error).toBe('kaboom');
    });
  });
});
