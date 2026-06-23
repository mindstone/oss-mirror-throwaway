/**
 * Migration + eager-migration + quarantine tests for AutomationScheduler.
 *
 * Covers BLOCKERs 2, 4, and 5 from the R6 (Schedule Algebra) Stage 2 Phase 5
 * review:
 *   - BLOCKER 2: v31→v32 framework migration must not throw on malformed
 *     legacy data (otherwise `migrateStore.ts:263-280` catch-and-replace
 *     wipes the user's automation list).
 *   - BLOCKER 4: when a definition is upserted with an ID matching a
 *     quarantined entry, the quarantine entry is removed atomically.
 *   - BLOCKER 5: eager migration with mixed valid/invalid persisted
 *     definitions; reentrancy guard.
 *
 * Uses an injectable storeFactory so the test can pre-populate the
 * automation store with vNN state before the AutomationScheduler runs its
 * migration framework.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AutomationDefinition, AutomationStoreState } from '@shared/types';

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
    getRendererSession: vi.fn().mockReturnValue(null),
    getTurnCategory: vi.fn().mockReturnValue('automation'),
    getEventListener: vi.fn().mockReturnValue(null),
    deleteEventListener: vi.fn(),
    getOrCreateAccumulator: vi.fn().mockReturnValue({
      appendEvent: vi.fn(),
      getConversationShape: vi.fn().mockReturnValue({ messages: [] }),
    }),
    clearToolCalls: vi.fn(),
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

// -------------------------------------------------------------------------
// Injectable store-factory helper (per-test)
// -------------------------------------------------------------------------

type StoreShape = AutomationStoreState & { version: number; quarantined?: unknown[] };

let _seedState: StoreShape | null = null;

class SeededTestStore<T extends Record<string, unknown>> {
  store: T;
  constructor(opts?: { defaults?: T; name?: string }) {
    if (opts?.name === 'automations' && _seedState !== null) {
      this.store = structuredClone(_seedState as unknown as T);
    } else {
      this.store = structuredClone((opts?.defaults ?? ({} as T)) as T);
    }
  }
  get<K extends keyof T>(key: K): T[K] {
    return this.store[key];
  }
  set(keyOrObj: string | Partial<T>, value?: unknown): void {
    if (typeof keyOrObj === 'string') {
      (this.store as Record<string, unknown>)[keyOrObj] = value;
    } else {
      Object.assign(this.store, keyOrObj);
    }
  }
  has(key: string): boolean {
    return key in this.store;
  }
  delete(key: string): void {
    delete (this.store as Record<string, unknown>)[key];
  }
  clear(): void {
    this.store = {} as T;
  }
  get path(): string {
    return '/tmp/test-stores/seeded.json';
  }
  onDidChange(_k: keyof T, _cb: () => void): () => void {
    return () => {};
  }
  onDidAnyChange(_cb: () => void): () => void {
    return () => {};
  }
  reload(): void {
    /* no-op */
  }
}

async function installSeededStoreFactory(): Promise<void> {
  const { setStoreFactory } = await import('@core/storeFactory');
  type FactoryOptions = Parameters<Parameters<typeof setStoreFactory>[0]>[0];
  setStoreFactory(((opts: FactoryOptions) =>
    new SeededTestStore(opts as { defaults?: Record<string, unknown>; name?: string })) as unknown as Parameters<
    typeof setStoreFactory
  >[0]);
}

// -------------------------------------------------------------------------
// Helpers
// -------------------------------------------------------------------------

function makeDef(overrides: Partial<AutomationDefinition>): AutomationDefinition {
  return {
    id: overrides.id ?? 'test-def',
    name: overrides.name ?? 'Test',
    filePath: overrides.filePath ?? 'auto.md',
    schedule: (overrides.schedule ?? {
      type: 'daily',
      time: '09:00',
    }) as AutomationDefinition['schedule'],
    enabled: overrides.enabled ?? true,
    catchUpIfMissed: overrides.catchUpIfMissed ?? true,
    createdAt: overrides.createdAt ?? 1_000,
    updatedAt: overrides.updatedAt ?? 1_000,
    isSystem: overrides.isSystem,
    systemType: overrides.systemType,
    accessRules: overrides.accessRules,
    ...(overrides.model !== undefined ? { model: overrides.model } : {}),
    ...(overrides.thinkingModel !== undefined ? { thinkingModel: overrides.thinkingModel } : {}),
  };
}

describe('AutomationScheduler — migrations + eager migration + quarantine', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    _seedState = null;
  });

  afterEach(() => {
    _seedState = null;
  });

  describe('v33→v35 Chief-of-Staff hygiene automation', () => {
    it('adds the system automation to existing stores without duplicating user automations', async () => {
      const validUserAutomation: AutomationDefinition = makeDef({
        id: 'valid-user-automation',
        name: 'Valid user automation',
        schedule: { type: 'daily', time: '08:00' } as AutomationDefinition['schedule'],
      });

      _seedState = {
        version: 33,
        definitions: [validUserAutomation],
        runs: [],
        quarantined: [
          {
            reason: 'invalid_schedule',
            quarantinedAt: 1_000,
            definition: { id: 'system-chief-of-staff-hygiene' },
          },
        ],
        sessionTypeFilter: 'all',
      } as StoreShape;

      await installSeededStoreFactory();
      const { AutomationScheduler } = await import('../automationScheduler');
      const scheduler = new AutomationScheduler({
        getCoreDirectory: () => '/tmp/core',
        executeAgentTurn: vi.fn(),
      });

      const state = scheduler.getState();
      expect(state.version).toBe(37);
      expect(state.definitions.map((definition) => definition.id)).toContain('valid-user-automation');
      const matches = state.definitions.filter(
        (definition) => definition.isSystem && definition.systemType === 'chief-of-staff-hygiene',
      );
      expect(matches).toHaveLength(1);
      expect(matches[0]).toMatchObject({
        id: 'system-chief-of-staff-hygiene',
        filePath: '',
        enabled: true,
        catchUpIfMissed: true,
        schedule: { type: 'weekly', daysOfWeek: [0], time: '06:20' },
      });
      expect(state.quarantined).toEqual([]);
    });

    it('migrates existing daily Chief-of-Staff hygiene definitions to weekly cadence', async () => {
      _seedState = {
        version: 34,
        definitions: [
          makeDef({
            id: 'system-chief-of-staff-hygiene',
            name: 'Chief-of-Staff Hygiene',
            filePath: '',
            schedule: { type: 'daily', time: '06:20' } as AutomationDefinition['schedule'],
            isSystem: true,
            systemType: 'chief-of-staff-hygiene',
          }),
        ],
        runs: [],
        quarantined: [],
        sessionTypeFilter: 'all',
      } as StoreShape;

      await installSeededStoreFactory();
      const { AutomationScheduler } = await import('../automationScheduler');
      const scheduler = new AutomationScheduler({
        getCoreDirectory: () => '/tmp/core',
        executeAgentTurn: vi.fn(),
      });

      const state = scheduler.getState();
      expect(state.version).toBe(37);
      expect(state.definitions[0]).toMatchObject({
        id: 'system-chief-of-staff-hygiene',
        description: 'Weekly cleanup for private profile context',
        schedule: { type: 'weekly', daysOfWeek: [0], time: '06:20' },
      });
    });

  });

  describe('v35→v36 Source Capture feedback access', () => {
    it('adds read-only feedback calibration permission to existing Source Capture access rules', async () => {
      _seedState = {
        version: 35,
        definitions: [
          makeDef({
            id: 'system-source-capture',
            name: 'Source Capture',
            filePath: 'rebel-system/skills/memory/source-capture/AUTOMATION.md',
            isSystem: true,
            systemType: 'source-capture',
            accessRules: 'ALLOWED ACTIONS:\n- Use rebel_inbox_add to notify the user of newly captured high-value sources',
          }),
        ],
        runs: [],
        quarantined: [],
        sessionTypeFilter: 'all',
      } as StoreShape;

      await installSeededStoreFactory();
      const { AutomationScheduler } = await import('../automationScheduler');
      const scheduler = new AutomationScheduler({
        getCoreDirectory: () => '/tmp/core',
        executeAgentTurn: vi.fn(),
      });

      const state = scheduler.getState();
      expect(state.version).toBe(37);
      expect(state.definitions[0]?.accessRules).toContain('rebel_inbox_feedback');
      expect(state.definitions[0]?.accessRules).toContain('Do not use it to create keyword blacklists');
    });
  });

  describe('v36→v37 stale Sonnet scrub', () => {
    it('scrubs the v26-era hardcoded claude-sonnet-4-6 model from system Source Capture', async () => {
      _seedState = {
        version: 36,
        definitions: [
          makeDef({
            id: 'system-source-capture',
            name: 'Source Capture',
            isSystem: true,
            systemType: 'source-capture',
            model: 'claude-sonnet-4-6',
          }),
        ],
        runs: [],
        quarantined: [],
        sessionTypeFilter: 'all',
      } as StoreShape;

      await installSeededStoreFactory();
      const { AutomationScheduler } = await import('../automationScheduler');
      const scheduler = new AutomationScheduler({
        getCoreDirectory: () => '/tmp/core',
        executeAgentTurn: vi.fn(),
      });

      const state = scheduler.getState();
      expect(state.version).toBe(37);
      expect(state.definitions[0]?.model).toBeUndefined();
    });

    it('scrubs the OpenRouter id-space twin (anthropic/claude-sonnet-4-6) too', async () => {
      _seedState = {
        version: 36,
        definitions: [
          makeDef({
            id: 'system-source-capture',
            name: 'Source Capture',
            isSystem: true,
            systemType: 'source-capture',
            model: 'anthropic/claude-sonnet-4-6',
          }),
        ],
        runs: [],
        quarantined: [],
        sessionTypeFilter: 'all',
      } as StoreShape;

      await installSeededStoreFactory();
      const { AutomationScheduler } = await import('../automationScheduler');
      const scheduler = new AutomationScheduler({
        getCoreDirectory: () => '/tmp/core',
        executeAgentTurn: vi.fn(),
      });

      const state = scheduler.getState();
      expect(state.definitions[0]?.model).toBeUndefined();
    });

    it('preserves Source Capture model when user has set a different value', async () => {
      _seedState = {
        version: 36,
        definitions: [
          makeDef({
            id: 'system-source-capture',
            name: 'Source Capture',
            isSystem: true,
            systemType: 'source-capture',
            model: 'gpt-5.5',
          }),
        ],
        runs: [],
        quarantined: [],
        sessionTypeFilter: 'all',
      } as StoreShape;

      await installSeededStoreFactory();
      const { AutomationScheduler } = await import('../automationScheduler');
      const scheduler = new AutomationScheduler({
        getCoreDirectory: () => '/tmp/core',
        executeAgentTurn: vi.fn(),
      });

      const state = scheduler.getState();
      const sourceCapture = state.definitions.find((d) => d.id === 'system-source-capture');
      expect(sourceCapture?.model).toBe('gpt-5.5');
    });

    it('preserves user-created automations even when they explicitly use claude-sonnet-4-6', async () => {
      _seedState = {
        version: 36,
        definitions: [
          makeDef({
            id: 'user-custom-automation',
            name: 'My research automation',
            isSystem: false,
            model: 'claude-sonnet-4-6',
          }),
        ],
        runs: [],
        quarantined: [],
        sessionTypeFilter: 'all',
      } as StoreShape;

      await installSeededStoreFactory();
      const { AutomationScheduler } = await import('../automationScheduler');
      const scheduler = new AutomationScheduler({
        getCoreDirectory: () => '/tmp/core',
        executeAgentTurn: vi.fn(),
      });

      const state = scheduler.getState();
      const userAutomation = state.definitions.find((d) => d.id === 'user-custom-automation');
      expect(userAutomation?.model).toBe('claude-sonnet-4-6');
    });

    it('preserves Sonnet on system automations that are not Source Capture', async () => {
      _seedState = {
        version: 36,
        definitions: [
          makeDef({
            id: 'system-other-automation',
            name: 'Daily Wins & Learnings',
            isSystem: true,
            systemType: 'wins-learnings-uncover',
            model: 'claude-sonnet-4-6',
          }),
        ],
        runs: [],
        quarantined: [],
        sessionTypeFilter: 'all',
      } as StoreShape;

      await installSeededStoreFactory();
      const { AutomationScheduler } = await import('../automationScheduler');
      const scheduler = new AutomationScheduler({
        getCoreDirectory: () => '/tmp/core',
        executeAgentTurn: vi.fn(),
      });

      const state = scheduler.getState();
      const otherAutomation = state.definitions.find((d) => d.id === 'system-other-automation');
      expect(otherAutomation?.model).toBe('claude-sonnet-4-6');
    });
  });

  // -----------------------------------------------------------------------
  // BLOCKER 2 regression: v31→v32 migration with malformed every_n_days
  // schedule must not throw → must not trigger framework createDefault().
  // -----------------------------------------------------------------------
  describe('BLOCKER 2 — v31→v32 with bad data preserves user data', () => {
    it('v24→v25 with null source-capture schedule preserves other user automations instead of resetting defaults', async () => {
      const malformedSourceCapture: AutomationDefinition = {
        id: 'source-capture-bad-schedule',
        name: 'Source Capture with bad schedule',
        filePath: 'rebel-system/skills/memory/source-capture/AUTOMATION.md',
        schedule: null as unknown as AutomationDefinition['schedule'],
        enabled: true,
        catchUpIfMissed: true,
        createdAt: 1_000,
        updatedAt: 1_000,
        isSystem: true,
        systemType: 'source-capture',
      };
      const validUserAutomation: AutomationDefinition = makeDef({
        id: 'valid-user-automation',
        name: 'Valid user automation',
        schedule: { type: 'daily', time: '08:00' } as AutomationDefinition['schedule'],
      });

      _seedState = {
        version: 23,
        definitions: [malformedSourceCapture, validUserAutomation],
        runs: [],
        quarantined: [],
        sessionTypeFilter: 'all',
      } as StoreShape;

      await installSeededStoreFactory();
      const { AutomationScheduler } = await import('../automationScheduler');
      const scheduler = new AutomationScheduler({
        getCoreDirectory: () => '/tmp/core',
        executeAgentTurn: vi.fn(),
      });

      const state = scheduler.getState();
      expect(state.definitions.map((d) => d.id)).toContain('valid-user-automation');
      expect(state.definitions.find((d) => d.id === 'valid-user-automation')?.schedule).toEqual({
        type: 'daily',
        time: '08:00',
      });
      expect(state.definitions.map((d) => d.id)).not.toContain('source-capture-bad-schedule');
      expect(
        state.quarantined.some(
          (entry) =>
            (entry.definition as { id?: string } | null)?.id ===
            'source-capture-bad-schedule',
        ),
      ).toBe(true);
    });

    it('per-definition try/catch keeps malformed defs intact for eager migration to quarantine', async () => {
      // Seed v31 state (pre-v31→v32) with an `every_n_days` schedule that
      // would throw inside `ScheduleConstructors.everyNDays` (intervalDays
      // out of range fails the tightened Stage 1 schema).
      const malformed: AutomationDefinition = makeDef({
        id: 'mcp-broken',
        name: 'MCP-broken every_n_days',
        schedule: {
          type: 'every_n_days',
          intervalDays: 0, // rejected by tightened schema
          time: '09:00',
        } as unknown as AutomationDefinition['schedule'],
        createdAt: 1_700_000_000_000,
        updatedAt: 1_700_000_000_000,
      });
      const valid: AutomationDefinition = makeDef({
        id: 'sane',
        name: 'Sane daily',
        schedule: { type: 'daily', time: '08:00' } as AutomationDefinition['schedule'],
      });

      _seedState = {
        version: 31,
        definitions: [malformed, valid],
        runs: [],
        quarantined: [],
        sessionTypeFilter: 'all',
      } as StoreShape;

      await installSeededStoreFactory();
      const { AutomationScheduler } = await import('../automationScheduler');
      const scheduler = new AutomationScheduler({
        getCoreDirectory: () => '/tmp/core',
        executeAgentTurn: vi.fn(),
      });

      const state = scheduler.getState();
      // BLOCKER 2: user automations are preserved (NOT replaced with createDefault).
      const seededIds = state.definitions.map((d) => d.id);
      expect(seededIds).toContain('sane');
      // The valid one is preserved verbatim.
      expect(state.definitions.find((d) => d.id === 'sane')?.schedule).toEqual({
        type: 'daily',
        time: '08:00',
      });
      // The malformed one has been quarantined by the post-framework eager pass.
      expect(state.definitions.map((d) => d.id)).not.toContain('mcp-broken');
      const quarantine = state.quarantined.find(
        (entry) =>
          (entry.definition as { id?: string } | null)?.id === 'mcp-broken',
      );
      expect(quarantine).toBeDefined();
    });
  });

  // -----------------------------------------------------------------------
  // BLOCKER 4 regression: upsert with an ID matching a quarantine envelope
  // removes the orphan envelope.
  // -----------------------------------------------------------------------
  describe('BLOCKER 4 — quarantined system-default ID collision', () => {
    it('upsertDefinition with an ID matching a quarantined entry removes the quarantine envelope', async () => {
      const quarantinedDef = makeDef({
        id: 'system-default-x',
        name: 'Quarantined system default',
        schedule: { type: 'event' } as unknown as AutomationDefinition['schedule'],
        isSystem: true,
        systemType: 'wins-learnings-uncover',
      });

      _seedState = {
        version: 33,
        definitions: [],
        runs: [],
        quarantined: [
          {
            definition: quarantinedDef,
            reason: 'event branch missing eventType',
            quarantinedAt: 1_700_000_000_000,
          },
        ],
        sessionTypeFilter: 'all',
      } as StoreShape;

      await installSeededStoreFactory();
      const { AutomationScheduler } = await import('../automationScheduler');
      const { AutomationSchedule } = await import('@shared/utils/automationSchedule');

      const scheduler = new AutomationScheduler({
        getCoreDirectory: () => '/tmp/core',
        executeAgentTurn: vi.fn(),
      });

      // Pre-state: live def absent, quarantine contains the system-default ID.
      let preLiveCount = scheduler
        .getState()
        .definitions.filter((d) => d.id === 'system-default-x').length;
      expect(preLiveCount).toBe(0);
      expect(
        scheduler
          .getState()
          .quarantined.some(
            (entry) =>
              (entry.definition as { id?: string } | null)?.id ===
              'system-default-x',
          ),
      ).toBe(true);

      // Onboarding-style upsert with the same ID.
      scheduler.upsertDefinition({
        id: 'system-default-x',
        name: 'Daily Wins & Learnings',
        filePath: 'rebel-system/skills/operations/wins-and-learnings-uncover/SKILL.md',
        schedule: AutomationSchedule.daily({ time: '09:30' }),
        enabled: true,
        isSystem: true,
        systemType: 'wins-learnings-uncover',
      });

      // Post-state: definition is live AND no orphan quarantine entry.
      preLiveCount = scheduler
        .getState()
        .definitions.filter((d) => d.id === 'system-default-x').length;
      expect(preLiveCount).toBe(1);
      expect(
        scheduler
          .getState()
          .quarantined.some(
            (entry) =>
              (entry.definition as { id?: string } | null)?.id ===
              'system-default-x',
          ),
      ).toBe(false);
    });
  });

  // -----------------------------------------------------------------------
  // BLOCKER 5 — eager migration coverage: mixed valid / repair / quarantine,
  // reentrancy guard, idempotence on re-run.
  // -----------------------------------------------------------------------
  describe('BLOCKER 5 — eager migration coverage', () => {
    it('mixed corpus: valid passes through, legacy event.trigger repairs, missing-eventType quarantines, valid daily count preserved', async () => {
      const sane: AutomationDefinition = makeDef({
        id: 'sane',
        schedule: { type: 'daily', time: '09:00' } as AutomationDefinition['schedule'],
      });
      const legacyEvent = makeDef({
        id: 'legacy-event',
        schedule: {
          type: 'event',
          trigger: 'transcript-ready',
        } as unknown as AutomationDefinition['schedule'],
      });
      const broken = makeDef({
        id: 'broken-event',
        schedule: { type: 'event' } as unknown as AutomationDefinition['schedule'],
      });

      _seedState = {
        version: 33,
        definitions: [sane, legacyEvent, broken],
        runs: [],
        quarantined: [],
        sessionTypeFilter: 'all',
      } as StoreShape;

      await installSeededStoreFactory();
      const { AutomationScheduler } = await import('../automationScheduler');
      const scheduler = new AutomationScheduler({
        getCoreDirectory: () => '/tmp/core',
        executeAgentTurn: vi.fn(),
      });

      const state = scheduler.getState();
      // Sane definition preserved unchanged.
      const sanePost = state.definitions.find((d) => d.id === 'sane');
      expect(sanePost?.schedule).toEqual({ type: 'daily', time: '09:00' });

      // Legacy event repaired: now uses canonical `eventType`.
      const repaired = state.definitions.find((d) => d.id === 'legacy-event');
      expect(repaired?.schedule).toEqual({
        type: 'event',
        eventType: 'transcript-ready',
      });

      // Broken event quarantined.
      expect(state.definitions.map((d) => d.id)).not.toContain('broken-event');
      const quarantineHit = state.quarantined.find(
        (entry) =>
          (entry.definition as { id?: string } | null)?.id === 'broken-event',
      );
      expect(quarantineHit).toBeDefined();
    });

    it('reentrancy guard: re-entering eager migration while a pass is in flight returns without re-running', async () => {
      _seedState = {
        version: 33,
        definitions: [makeDef({ id: 'sane' })],
        runs: [],
        quarantined: [],
        sessionTypeFilter: 'all',
      } as StoreShape;

      await installSeededStoreFactory();
      const { AutomationScheduler } = await import('../automationScheduler');
      const scheduler = new AutomationScheduler({
        getCoreDirectory: () => '/tmp/core',
        executeAgentTurn: vi.fn(),
      });

      // Probe the private method via a typed cast for the reentrancy assertion.
      type Internal = {
        isMigratingScheduleDefinitions: boolean;
        runEagerScheduleMigration: (
          state: AutomationStoreState,
          src: number | null,
        ) => AutomationStoreState;
      };
      const internal = scheduler as unknown as Internal;

      const before = scheduler.getState();
      internal.isMigratingScheduleDefinitions = true;
      const after = internal.runEagerScheduleMigration(before, null);
      internal.isMigratingScheduleDefinitions = false;
      // No-op when reentering during an in-flight pass.
      expect(after).toBe(before);
    });

    // R6 Stage 3 task #6: idempotence test. After scheduler init runs the
    // eager migration once, re-running it must be a structural no-op — same
    // returned state reference (the function early-exits when `changed ===
    // false`), no extra quarantine envelopes, no migration log emissions.
    // Catches future refactors that accidentally reformat repaired schedules
    // on each pass, churn quarantine timestamps, or duplicate envelopes.
    it('idempotence: re-running runEagerScheduleMigration on a mixed corpus is a structural no-op', async () => {
      const sane: AutomationDefinition = makeDef({
        id: 'sane',
        schedule: { type: 'daily', time: '09:00' } as AutomationDefinition['schedule'],
      });
      const legacyEvent = makeDef({
        id: 'legacy-event',
        schedule: {
          type: 'event',
          trigger: 'transcript-ready',
        } as unknown as AutomationDefinition['schedule'],
      });
      const broken = makeDef({
        id: 'broken-event',
        schedule: { type: 'event' } as unknown as AutomationDefinition['schedule'],
      });

      _seedState = {
        version: 33,
        definitions: [sane, legacyEvent, broken],
        runs: [],
        quarantined: [],
        sessionTypeFilter: 'all',
      } as StoreShape;

      await installSeededStoreFactory();
      const { AutomationScheduler } = await import('../automationScheduler');
      const scheduler = new AutomationScheduler({
        getCoreDirectory: () => '/tmp/core',
        executeAgentTurn: vi.fn(),
      });

      // Snapshot post-first-pass state. By the time the test gets here, the
      // first eager-migration pass has already run during scheduler init.
      const firstPass = scheduler.getState();
      expect(firstPass.definitions.map((d) => d.id).sort()).toEqual([
        'legacy-event',
        'sane',
        'system-chief-of-staff-hygiene',
      ]);
      expect(firstPass.quarantined).toHaveLength(1);
      expect(
        (firstPass.quarantined[0].definition as { id?: string } | null)?.id,
      ).toBe('broken-event');
      const quarantineCountAfterFirst = firstPass.quarantined.length;
      const quarantinedAtAfterFirst = firstPass.quarantined[0].quarantinedAt;

      // Reset migration log so we can prove no warn was emitted on pass 2.
      mockLoggerMethods.warn.mockClear();

      // Probe the private method via the same typed cast pattern.
      type Internal = {
        runEagerScheduleMigration: (
          state: AutomationStoreState,
          src: number | null,
        ) => AutomationStoreState;
      };
      const internal = scheduler as unknown as Internal;

      const secondPass = internal.runEagerScheduleMigration(firstPass, null);

      // Idempotence #1: same reference (function early-exits when `changed`
      // is false). This is the structural assertion.
      expect(secondPass).toBe(firstPass);

      // Idempotence #2: no new quarantine envelopes; existing one untouched.
      expect(secondPass.quarantined).toHaveLength(quarantineCountAfterFirst);
      expect(secondPass.quarantined[0].quarantinedAt).toBe(quarantinedAtAfterFirst);

      // Idempotence #3: definitions identical to first pass.
      expect(secondPass.definitions).toBe(firstPass.definitions);

      // Idempotence #4: no migration warns emitted on the no-op pass. The
      // warn.mockClear() above ensures we only count post-clear warns.
      const migrationWarns = mockLoggerMethods.warn.mock.calls.filter(
        (call) => {
          const message = call[1];
          return (
            typeof message === 'string' &&
            (message.includes('Automation schedule migrated on load') ||
              message.includes('Automation schedule quarantined on migration'))
          );
        },
      );
      expect(migrationWarns).toHaveLength(0);
    });
  });
});
