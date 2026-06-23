import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MAX_AUTOMATION_RUN_HISTORY } from '@core/constants';
import type {
  AutomationDefinition,
  AutomationDefinitionInput,
  AutomationRun,
} from '@shared/types';
import { AutomationSchedule } from '@shared/utils/automationSchedule';

// BLOCKER 3 (R6 Stage 2 refinement): allow tests to inject persisted state
// before adapter construction so migration paths can be exercised. The
// `__seedNextStore` hook installs a one-shot seed used by the next
// MemoryStore constructor (per-test), and the `__pendingReloadState` hook
// supplies the state read by `reload()` when post-archive-restore is
// simulated.
let _seedNextStore: Record<string, unknown> | null = null;
let _pendingReloadState: Record<string, unknown> | null = null;
// When set, the next MemoryStore construction throws a CloudStoreLoadError —
// simulating a corrupt-but-real backing file (conf `clearInvalidConfig:false`
// semantics) so the adapter's read-only corrupt-construct guard is exercised.
let _throwNextStoreLoad = false;

vi.mock('../electronStoreShim', () => {
  // Mirror the real shim's named export so the adapter's
  // `error instanceof CloudStoreLoadError` corrupt-construct guard type-checks
  // and behaves identically under the mock.
  class CloudStoreLoadError extends Error {
    readonly path: string;
    readonly reason: string;
    constructor(filePath: string, cause: unknown) {
      const reason = cause instanceof Error ? cause.message : String(cause);
      super(`Cloud settings load failed for ${filePath}: ${reason}`);
      this.name = 'CloudStoreLoadError';
      this.path = filePath;
      this.reason = reason;
    }
  }

  class MemoryStore<T extends Record<string, unknown>> {
    store: T;

    constructor(options: { name: string; defaults: T }) {
      if (_throwNextStoreLoad) {
        _throwNextStoreLoad = false;
        throw new CloudStoreLoadError(`/data/${options.name}.json`, new SyntaxError('corrupt'));
      }
      if (_seedNextStore !== null) {
        // Match electronStoreShim.ts merge semantics: defaults THEN persisted.
        this.store = { ...structuredClone(options.defaults), ...structuredClone(_seedNextStore) } as T;
        _seedNextStore = null;
      } else {
        this.store = structuredClone(options.defaults);
      }
    }

    reload(): void {
      if (_pendingReloadState !== null) {
        this.store = { ...this.store, ...structuredClone(_pendingReloadState) } as T;
        _pendingReloadState = null;
      }
    }
  }

  function reloadAllStores() {
    // No-op: tests drive reload via __pendingReloadState + adapter.refresh().
  }

  return { default: MemoryStore, reloadAllStores, CloudStoreLoadError };
});

import { CloudAutomationStoreAdapter, runCloudAutomationStoreEagerMigration } from '../cloudAutomationStore';

const DAILY_SCHEDULE: AutomationDefinitionInput['schedule'] = AutomationSchedule.daily({
  time: '09:00',
});

function createRun(
  overrides: Partial<AutomationRun> &
    Pick<AutomationRun, 'id' | 'automationId' | 'status'>,
): AutomationRun {
  const startedAt = overrides.startedAt ?? 1_000;
  return {
    id: overrides.id,
    automationId: overrides.automationId,
    startedAt,
    completedAt: overrides.completedAt ?? startedAt + 100,
    status: overrides.status,
    trigger: overrides.trigger ?? 'schedule',
    sessionId: overrides.sessionId ?? null,
    error: overrides.error ?? null,
  };
}

describe('CloudAutomationStoreAdapter', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-03-15T12:00:00.000Z'));
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  describe('corrupt-construct guard (F1 cross-surface)', () => {
    it('does NOT throw on a corrupt backing file, runs read-only on in-memory state, and never holds a live store to persist into', () => {
      _throwNextStoreLoad = true;
      // Construction must not crash even though the shim threw CloudStoreLoadError.
      const store = new CloudAutomationStoreAdapter();

      // No live backing store was retained (the throw was caught → store stays
      // null), so `persist()` is a guaranteed no-op: nothing can be written over
      // the preserved corrupt file.
      expect((store as unknown as { store: unknown }).store).toBeNull();
      expect((store as unknown as { readOnly: boolean }).readOnly).toBe(true);

      // In-memory state still serves the session (continuity), and a write
      // (upsert) does not throw despite the read-only latch.
      const created = store.upsertDefinition({ schedule: DAILY_SCHEDULE, name: 'x' });
      expect(created.id).toBeTruthy();
      expect(store.getState().definitions.length).toBe(1);
    });
  });

  it('upsertDefinition() creates a new definition with generated id, timestamps, and defaults', () => {
    const store = new CloudAutomationStoreAdapter();
    vi.spyOn(crypto, 'randomUUID').mockReturnValue(
      'generated-id' as `${string}-${string}-${string}-${string}-${string}`,
    );

    const created = store.upsertDefinition({
      schedule: DAILY_SCHEDULE,
      name: '   ',
      description: '  ',
    });

    expect(created).toMatchObject({
      id: 'generated-id',
      name: 'Untitled automation',
      description: undefined,
      filePath: '',
      enabled: true,
      catchUpIfMissed: true,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      lastRunAt: null,
      lastSuccessAt: null,
      lastRunStatus: undefined,
      nextRunAt: null,
    });

    const state = store.getState();
    expect(state.definitions).toHaveLength(1);
    expect(state.definitions[0]).toEqual(created);
  });

  it('upsertDefinition() updates an existing definition by id and preserves createdAt', () => {
    const store = new CloudAutomationStoreAdapter();

    const original = store.upsertDefinition({
      id: 'def-1',
      name: 'Original',
      filePath: '/tmp/original.md',
      enabled: false,
      catchUpIfMissed: false,
      schedule: DAILY_SCHEDULE,
    });

    vi.setSystemTime(new Date('2026-03-15T12:05:00.000Z'));

    const updated = store.upsertDefinition({
      id: 'def-1',
      name: 'Updated',
      schedule: AutomationSchedule.weekly({ daysOfWeek: [1, 3], time: '10:15' }),
      enabled: true,
    });

    expect(updated.id).toBe(original.id);
    expect(updated.createdAt).toBe(original.createdAt);
    expect(updated.updatedAt).toBe(Date.now());
    expect(updated.name).toBe('Updated');
    expect(updated.schedule).toEqual({
      type: 'weekly',
      daysOfWeek: [1, 3],
      time: '10:15',
    });
    expect(updated.filePath).toBe('/tmp/original.md');

    const [storedDefinition] = store.getState().definitions;
    expect(storedDefinition).toEqual(updated);
  });

  it('persists and normalises finishLine on create and update', () => {
    const store = new CloudAutomationStoreAdapter();

    const created = store.upsertDefinition({
      id: 'finish-line-def',
      name: 'Finish line def',
      schedule: DAILY_SCHEDULE,
      finishLine: 'criterion',
    });

    expect(created.finishLine).toBe('criterion');
    expect(store.getState().definitions[0].finishLine).toBe('criterion');

    const updated = store.upsertDefinition({
      id: 'finish-line-def',
      schedule: DAILY_SCHEDULE,
      finishLine: '   updated   ',
    });

    expect(updated.finishLine).toBe('updated');

    const cleared = store.upsertDefinition({
      id: 'finish-line-def',
      schedule: DAILY_SCHEDULE,
      finishLine: '   ',
    });

    expect(cleared.finishLine).toBeUndefined();
  });

  it('CT-0 preserves executor and scriptModule on create and update', () => {
    const store = new CloudAutomationStoreAdapter();

    const created = store.upsertDefinition({
      id: 'script-def',
      name: 'Script definition',
      schedule: DAILY_SCHEDULE,
      executor: 'script',
      scriptModule: 'module.create',
    });

    expect(store.getState().definitions[0]).toMatchObject({
      id: created.id,
      executor: 'script',
      scriptModule: 'module.create',
    });

    store.upsertDefinition({
      id: created.id,
      schedule: DAILY_SCHEDULE,
      executor: 'script',
      scriptModule: 'module.update',
    });

    expect(store.getState().definitions[0]).toMatchObject({
      id: created.id,
      executor: 'script',
      scriptModule: 'module.update',
    });
  });

  it('deleteDefinition() removes the definition and associated runs, and triggers callback', () => {
    const store = new CloudAutomationStoreAdapter();
    const onChange = vi.fn<(definitions: AutomationDefinition[]) => void>();

    store.setOnDefinitionChange(onChange);
    store.upsertDefinition({ id: 'keep', name: 'Keep', schedule: DAILY_SCHEDULE });
    store.upsertDefinition({ id: 'remove', name: 'Remove', schedule: DAILY_SCHEDULE });
    store.recordRun(createRun({ id: 'run-1', automationId: 'remove', status: 'success' }));
    store.recordRun(createRun({ id: 'run-2', automationId: 'keep', status: 'failure' }));
    onChange.mockClear();

    const nextState = store.deleteDefinition('remove');

    expect(nextState.definitions.map((d) => d.id)).toEqual(['keep']);
    expect(nextState.runs).toHaveLength(1);
    expect(nextState.runs[0].automationId).toBe('keep');
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith(nextState.definitions);
  });

  it('recordRun() records runs, caps run history at MAX_AUTOMATION_RUN_HISTORY, and updates definition run fields', () => {
    const store = new CloudAutomationStoreAdapter();
    store.upsertDefinition({ id: 'def-1', name: 'Tracked', schedule: DAILY_SCHEDULE });

    const successRun = createRun({
      id: 'run-success',
      automationId: 'def-1',
      status: 'success',
      startedAt: 10_000,
      completedAt: 11_000,
    });
    store.recordRun(successRun);

    const failureCount = MAX_AUTOMATION_RUN_HISTORY + 1;
    for (let i = 1; i <= failureCount; i += 1) {
      store.recordRun(
        createRun({
          id: `run-failure-${i}`,
          automationId: 'def-1',
          status: 'failure',
          startedAt: 20_000 + i,
          completedAt: 30_000 + i,
        }),
      );
    }

    const state = store.getState();
    expect(state.runs).toHaveLength(MAX_AUTOMATION_RUN_HISTORY);
    expect(state.runs[0].id).toBe(`run-failure-${failureCount}`);

    const definition = state.definitions.find((d) => d.id === 'def-1');
    expect(definition).toBeDefined();
    expect(definition).toMatchObject({
      lastRunStatus: 'failure',
      lastRunAt: 30_000 + failureCount,
      lastSuccessAt: 11_000,
    });
  });

  it('recordRun() preserves lastRunAt when advanceScheduleSlot is false', () => {
    const store = new CloudAutomationStoreAdapter();
    store.upsertDefinition({
      id: 'once-def',
      name: 'Once definition',
      schedule: AutomationSchedule.once({ dateTime: '2026-03-15T08:00:00.000Z' }),
    });

    store.recordRun(
      createRun({
        id: 'blocked-once-run',
        automationId: 'once-def',
        status: 'provider_not_ready',
        startedAt: 10_000,
        completedAt: 10_100,
      }),
      { advanceScheduleSlot: false },
    );

    const definition = store.getState().definitions.find((d) => d.id === 'once-def');
    expect(definition?.lastRunStatus).toBe('provider_not_ready');
    expect(definition?.lastRunAt).toBeNull();
  });

  it('setOnDefinitionChange() fires on both upsert and delete', () => {
    const store = new CloudAutomationStoreAdapter();
    const onChange = vi.fn<(definitions: AutomationDefinition[]) => void>();

    store.setOnDefinitionChange(onChange);

    store.upsertDefinition({
      id: 'callback-target',
      name: 'Callback target',
      schedule: DAILY_SCHEDULE,
    });
    store.deleteDefinition('callback-target');

    expect(onChange).toHaveBeenCalledTimes(2);
    expect(onChange.mock.calls[0][0].map((d) => d.id)).toEqual(['callback-target']);
    expect(onChange.mock.calls[1][0]).toEqual([]);
  });

  it('upsertDefinition() removes a matching quarantine envelope', () => {
    _seedNextStore = {
      version: 1,
      definitions: [],
      runs: [],
      quarantined: [
        {
          definition: {
            id: 'foo',
            name: 'Previously quarantined',
            schedule: { type: 'event' },
          },
          reason: 'event branch missing eventType',
          quarantinedAt: Date.now(),
        },
      ],
      sessionTypeFilter: 'all',
      cloud_automation_store_v: 99,
    };
    const store = new CloudAutomationStoreAdapter();

    store.upsertDefinition({
      id: 'foo',
      name: 'Recovered',
      schedule: AutomationSchedule.daily({ time: '09:00' }),
    });

    const state = store.getState();
    expect(state.definitions.map((definition) => definition.id)).toEqual(['foo']);
    expect(state.quarantined).toEqual([]);
  });

  it('runNow() returns null', async () => {
    const store = new CloudAutomationStoreAdapter();
    await expect(store.runNow('def-1')).resolves.toBeNull();
  });

  // BLOCKER 3 + BLOCKER 5 (R6 Stage 2 refinement)
  describe('runEagerMigration', () => {
    const validDef: AutomationDefinition = {
      id: 'valid-def',
      name: 'Valid',
      filePath: 'auto.md',
      schedule: AutomationSchedule.daily({ time: '09:00' }),
      enabled: true,
      createdAt: 1_000,
      updatedAt: 1_000,
    };
    const invalidDef = {
      id: 'invalid-def',
      name: 'Invalid',
      filePath: 'auto.md',
      // event branch missing eventType — fromUntrusted should quarantine.
      schedule: { type: 'event' } as unknown as AutomationDefinition['schedule'],
      enabled: true,
      createdAt: 1_000,
      updatedAt: 1_000,
    };

    it('passes valid definitions through unchanged', () => {
      _seedNextStore = {
        version: 1,
        definitions: [structuredClone(validDef)],
        runs: [],
        quarantined: [],
        sessionTypeFilter: 'all',
        // sentinel absent → migration runs.
      };
      const store = new CloudAutomationStoreAdapter();
      const state = store.getState();
      expect(state.definitions).toHaveLength(1);
      expect(state.definitions[0].id).toBe('valid-def');
      expect(state.quarantined).toHaveLength(0);
    });

    it('quarantines invalid definitions and preserves valid ones', () => {
      _seedNextStore = {
        version: 1,
        definitions: [structuredClone(validDef), structuredClone(invalidDef)],
        runs: [],
        quarantined: [],
        sessionTypeFilter: 'all',
      };
      const store = new CloudAutomationStoreAdapter();
      const state = store.getState();
      expect(state.definitions.map((d) => d.id)).toEqual(['valid-def']);
      expect(state.quarantined).toHaveLength(1);
      expect(state.quarantined[0].reason).toMatch(/eventType|missing/i);
    });

    // BLOCKER 3A regression
    it('triggers migration on archive without cloud_automation_store_v sentinel', () => {
      _seedNextStore = {
        version: 1,
        definitions: [structuredClone(invalidDef)],
        runs: [],
        quarantined: [],
        sessionTypeFilter: 'all',
        // sentinel ABSENT → defaults seed `cloud_automation_store_v: 0`,
        // gate evaluates `0 < STORE_VERSION` → migration runs.
      };
      const store = new CloudAutomationStoreAdapter();
      // Migration ran: invalid def quarantined.
      expect(store.getState().definitions).toHaveLength(0);
      expect(store.getState().quarantined).toHaveLength(1);
    });

    it('skips re-migration when sentinel is at current STORE_VERSION', () => {
      _seedNextStore = {
        version: 1,
        definitions: [structuredClone(invalidDef)],
        runs: [],
        quarantined: [],
        sessionTypeFilter: 'all',
        cloud_automation_store_v: 99, // pretend already migrated to a later version
      };
      const store = new CloudAutomationStoreAdapter();
      // Migration skipped: invalid def remains untouched in definitions.
      expect(store.getState().definitions).toHaveLength(1);
      expect(store.getState().quarantined).toHaveLength(0);
    });

    // BLOCKER 3B regression
    it('refresh() re-reads disk state before migration so reload-restored payloads are migrated', () => {
      // Initial state: empty + migrated.
      _seedNextStore = {
        version: 1,
        definitions: [],
        runs: [],
        quarantined: [],
        sessionTypeFilter: 'all',
        cloud_automation_store_v: 99,
      };
      const store = new CloudAutomationStoreAdapter();
      expect(store.getState().definitions).toHaveLength(0);

      // Simulate archive restore: disk now has the invalid def + sentinel absent.
      _pendingReloadState = {
        version: 1,
        definitions: [structuredClone(invalidDef)],
        runs: [],
        quarantined: [],
        sessionTypeFilter: 'all',
        cloud_automation_store_v: 0,
      };

      // Pre-fix: adapter.runEagerMigration() would still see the empty cached state.
      // Post-fix: refresh() re-reads disk then migration sees + quarantines invalid def.
      // Caller ergonomics: route handler calls reloadAllStores() then
      // runCloudAutomationStoreEagerMigration() which now wraps refresh() + migrate.
      // We simulate the reload here directly.
      // Manually trigger reload on the underlying mocked store via private access.
      // Mock's reload() consumes _pendingReloadState.
      const internal = store as unknown as { store: { reload(): void } };
      internal.store.reload();

      runCloudAutomationStoreEagerMigration();

      const state = store.getState();
      expect(state.definitions).toHaveLength(0);
      expect(state.quarantined).toHaveLength(1);
      expect(state.quarantined[0].reason).toMatch(/eventType|missing/i);
    });

    it('reentrancy guard: re-entry while migrating skips without re-running', () => {
      const store = new CloudAutomationStoreAdapter();
      // Backdate sentinel + add an invalid def so the version gate would NOT
      // short-circuit on re-entry. With reentrancy guard active (isMigrating
      // = true), the second call still returns early, leaving the invalid
      // def untouched — proving the guard is what's blocking.
      const internal = store as unknown as {
        state: (typeof store extends { getState(): infer S } ? S : never) & {
          cloud_automation_store_v?: number;
        };
        isMigrating: boolean;
      };
      internal.state = {
        ...internal.state,
        definitions: [structuredClone(invalidDef)],
        cloud_automation_store_v: 0,
      };
      internal.isMigrating = true;
      const before = store.getState();
      store.runEagerMigration();
      // Untouched: still has the invalid def, sentinel still 0.
      expect(store.getState()).toBe(before);
      expect(store.getState().definitions).toHaveLength(1);
      internal.isMigrating = false;
    });
  });
});
