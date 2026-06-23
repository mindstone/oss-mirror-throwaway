/**
 * Data-safety integration tests for the shared `migrateStore` corrupted-branch
 * containment (docs/plans/260616_batch-write-containment-audit).
 *
 * The class being guarded: on a version-bump migration, one malformed persisted
 * item makes the migration throw; `migrateStore`'s catch USED TO return
 * `{ data: createDefault(), status: 'corrupted', shouldPersist: true }`; the
 * caller did `store.store = data` → the user's real store was reset to empty
 * defaults and persisted over their data.
 *
 * These tests prove the fix is non-destructive at the CALLER level: when the
 * migration result is `corrupted`, the store backing (the in-memory stand-in for
 * the on-disk file under `TestMemoryStore`) is NOT overwritten with defaults,
 * the store goes read-only, and later writes are blocked.
 *
 * Strategy: each store imports `migrateStore` from the shared module. We mock
 * ONLY `migrateStore` to deterministically return a `corrupted` result (so we
 * don't depend on any store's real version bump — which the data-safety
 * directive forbids us from triggering), while keeping the real
 * `isReadOnlyMigrationStatus` so the caller's read-only logic runs unchanged.
 * The shared-seam unit test (storeMigration.test.ts) separately proves a REAL
 * throwing migration yields `shouldPersist: false` + observability.
 *
 * ALL state is in-memory via `initTestPlatformConfig` + a seeded store factory —
 * never the real userData dir.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { initTestPlatformConfig } from '@core/__tests__/testHelpers';
import { TestMemoryStore } from '@core/__tests__/TestMemoryStore';
import type { MigrationResultStatus } from '@core/utils/storeMigration';

/**
 * A store stand-in that starts holding the ORIGINAL (old-version, would-not-
 * migrate) data and records every write to `.store`. `lastWrittenStore` lets a
 * test assert whether defaults were ever persisted over the seeded data.
 */
class SeededRecordingStore<T extends Record<string, unknown>> {
  data: T;
  writes: T[] = [];
  constructor(private readonly seeded: T) {
    this.data = structuredClone(seeded);
  }
  get store(): T {
    return this.data;
  }
  set store(value: T) {
    this.writes.push(structuredClone(value));
    this.data = value;
  }
  get<K extends keyof T>(key: K, defaultValue?: T[K]): T[K] | undefined {
    const val = this.data[key];
    return val !== undefined ? val : defaultValue;
  }
  set<K extends keyof T>(keyOrObj: K | Partial<T>, value?: T[K]): void {
    if (typeof keyOrObj === 'string') {
      (this.data as Record<string, unknown>)[keyOrObj] = value;
    } else {
      Object.assign(this.data, keyOrObj);
    }
    this.writes.push(structuredClone(this.data));
  }
  has(key: string): boolean {
    return key in this.data;
  }
  delete(key: string): void {
    delete (this.data as Record<string, unknown>)[key];
  }
  clear(): void {
    this.data = structuredClone(this.seeded);
  }
  get path(): string {
    return '/tmp/test-stores/config.json';
  }
  onDidChange(): () => void {
    return () => {};
  }
  onDidAnyChange(): () => void {
    return () => {};
  }
  reload(): void {}
}

/**
 * Re-init core boundaries, install a seeded store factory, and mock the shared
 * `migrateStore` to return a `corrupted` result. Returns the live store handle so
 * the test can inspect `.data` / `.writes`.
 */
/**
 * Index-store stub that reports `migrationComplete: false` and refuses to flip
 * it true. This forces `inboxStore.getInboxState()` down the LEGACY load path
 * (`loadInboxInternal` → `migrateStore`), which is the corrupted-containment
 * site under test — the modern index path bypasses `migrateStore` entirely.
 */
const makeLegacyForcingIndexStore = (): Record<string, unknown> => {
  const data: Record<string, unknown> = {
    version: 1,
    entries: [],
    history: [],
    migrationComplete: false,
  };
  return {
    get store() {
      return data;
    },
    set store(_v: Record<string, unknown>) {
      /* ignore */
    },
    get(key: string, def?: unknown) {
      const v = data[key];
      return v !== undefined ? v : def;
    },
    set(keyOrObj: string | Record<string, unknown>, value?: unknown) {
      // Pin migrationComplete=false so the legacy path stays active.
      if (keyOrObj === 'migrationComplete') return;
      if (typeof keyOrObj === 'string') data[keyOrObj] = value;
    },
    has: (key: string) => key in data,
    delete: () => {},
    clear: () => {},
    path: '/tmp/test-stores/inbox-index.json',
    onDidChange: () => () => {},
    onDidAnyChange: () => () => {},
    reload: () => {},
  };
};

const setup = async <T extends Record<string, unknown>>(
  seeded: T,
  corruptedDefaults: T,
  targetStoreName: string,
  status: MigrationResultStatus = 'corrupted',
  extraStores: Record<string, Record<string, unknown>> = {},
): Promise<{ store: SeededRecordingStore<T> }> => {
  vi.resetModules();
  await initTestPlatformConfig();

  const store = new SeededRecordingStore<T>(seeded);
  const { setStoreFactory } = await import('@core/storeFactory');
  // Name-aware factory: the store under test gets the seeded old-version data;
  // explicitly-provided sibling stores (e.g. the inbox INDEX store) get their
  // stub; any other sibling gets fresh defaults so it doesn't collide with the
  // target and so unrelated reads don't pollute the write log.
  setStoreFactory((opts: { name?: string } = {}) => {
    if (opts.name === targetStoreName) return store as unknown as never;
    if (opts.name && extraStores[opts.name]) return extraStores[opts.name] as unknown as never;
    return new TestMemoryStore(opts as { defaults?: Record<string, unknown>; name?: string }) as unknown as never;
  });

  // Keep the real isReadOnlyMigrationStatus; override only migrateStore. Vitest
  // resolves the mock id to the canonical absolute module path, so every
  // importer (whether via `@core/...` or a relative path) gets this mock.
  vi.doMock('@core/utils/storeMigration', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@core/utils/storeMigration')>();
    return {
      ...actual,
      migrateStore: vi.fn(() => ({
        data: structuredClone(corruptedDefaults),
        status,
        fromVersion: 1,
        toVersion: 99,
        backupPath: '/tmp/test-backup.json',
        shouldPersist: status === 'migrated' || status === 'fresh',
      })),
    };
  });

  return { store };
};

describe('migrateStore corrupted branch — caller non-destructive parity', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  describe('inboxStore (HIGH)', () => {
    it('does NOT overwrite the on-disk inbox with defaults on a corrupted migration, and goes read-only', async () => {
      const seeded = {
        version: 1,
        items: [
          { id: 'a', title: 'Real task A', status: 'active' },
          { id: 'b', title: 'Real task B', status: 'active' },
        ],
        history: [],
      } as unknown as Record<string, unknown>;
      const corruptedDefaults = { version: 99, items: [], history: [] } as unknown as Record<string, unknown>;

      // Force the LEGACY load path (the one that calls migrateStore): give the
      // inbox-index store a stub that reports migrationComplete=false and ignores
      // attempts to flip it true, so getInboxState falls through to
      // loadInboxInternal (the corrupted-migration containment under test).
      const { store } = await setup(seeded, corruptedDefaults, 'inbox', 'corrupted', {
        'inbox-index': makeLegacyForcingIndexStore(),
      });
      const inbox = await import('../inboxStore');

      // Trigger the legacy load via a read.
      const state = inbox.getInboxState();
      // In-memory degraded view uses defaults this session...
      expect(state.items.length).toBe(0);

      // ...but the ON-DISK (backing) legacy inbox was NOT overwritten with defaults.
      expect((store.data as { items: unknown[] }).items.length).toBe(2);
      expect(store.writes).toHaveLength(0);

      // A subsequent save is blocked (read-only), so the real data stays intact.
      inbox.addInboxItem({ title: 'Should be blocked', category: 'user-request' });
      expect((store.data as { items: unknown[] }).items.length).toBe(2);
    });
  });

  describe('memoryHistoryStore (HIGH)', () => {
    it('does NOT overwrite on-disk memory history with defaults on corrupted, even via the extra normalize-persist condition', async () => {
      const seeded = {
        version: 1,
        entries: [
          { id: 'm1', entity: 'Project', summary: 'Real memory 1', timestamp: 1000 },
          { id: 'm2', entity: 'Project', summary: 'Real memory 2', timestamp: 2000 },
        ],
        lastPruned: 0,
        backfillCompleted: true,
      } as unknown as Record<string, unknown>;
      const corruptedDefaults = {
        version: 99,
        entries: [],
        lastPruned: 0,
        backfillCompleted: false,
      } as unknown as Record<string, unknown>;

      const { store } = await setup(seeded, corruptedDefaults, 'memory-history');
      const mem = await import('../../../main/services/memoryHistoryStore');

      const result = mem.getMemoryHistory();
      expect(result.entries.length).toBe(0); // degraded in-memory

      // On-disk preserved; the `normalizedCount > 0 && !readOnly` clause must NOT fire.
      expect((store.data as { entries: unknown[] }).entries.length).toBe(2);
      expect(store.writes).toHaveLength(0);

      // Read-only: a later approved-memory write is blocked (depends on the
      // caller setting read-only on `corrupted`), so the real entry survives.
      mem.addApprovedMemoryEntry({
        filePath: '/ws/note.md',
        spaceName: 'Project',
        summary: 'new',
        sessionId: 's1',
        isNew: true,
      });
      expect((store.data as { entries: unknown[] }).entries.length).toBe(2);
    });
  });

  describe('automationScheduler (HIGH)', () => {
    it('does NOT overwrite on-disk automations with defaults on corrupted (incl. the post-load provider-aware write)', async () => {
      const seeded = {
        version: 1,
        definitions: [{ id: 'auto-1', name: 'Real automation' }],
        runs: [],
        quarantined: [],
      } as unknown as Record<string, unknown>;
      const corruptedDefaults = {
        version: 99,
        definitions: [],
        runs: [],
        quarantined: [],
      } as unknown as Record<string, unknown>;

      const { store } = await setup(seeded, corruptedDefaults, 'automations');
      // The scheduler class reads getScheduler() in a field initializer; wire a
      // minimal no-op scheduler so construction doesn't throw on unrelated plumbing.
      const { setSchedulerFactory } = await import('@core/scheduler');
      setSchedulerFactory(() => ({
        registerTimeout: () => 0 as unknown as ReturnType<typeof setTimeout>,
        registerInterval: () => 0 as unknown as ReturnType<typeof setTimeout>,
        clear: () => {},
        now: () => Date.now(),
        sleep: async () => {},
        isVisible: () => true,
        deferUntilVisible: async () => 'visible' as const,
      }));
      const mod = await import('../../../main/services/automationScheduler');
      // The scheduler is a class; the load + migration runs in the constructor.
      const SchedulerCtor = (mod as unknown as Record<string, unknown>).AutomationScheduler as
        new (deps: unknown) => unknown;
      expect(SchedulerCtor, 'AutomationScheduler export present').toBeTruthy();
      // Minimal deps: only getCoreDirectory + executeAgentTurn are required; the
      // optional ones being absent triggers graceful (logged) degrade, not a throw.
      new SchedulerCtor({
        getCoreDirectory: () => null,
        executeAgentTurn: async () => {},
      });

      // On-disk definitions preserved; no defaults (or post-load provider-aware
      // state) written over the real file.
      expect((store.data as { definitions: unknown[] }).definitions.length).toBe(1);
      expect(store.writes).toHaveLength(0);
    });
  });

  describe('timeSavedStore (MEDIUM)', () => {
    it('does NOT overwrite on-disk time-saved data with defaults on corrupted, and goes read-only', async () => {
      const seeded = {
        version: 1,
        entries: [{ turnId: 't1', minutes: 30 }],
        acknowledgedMilestones: [],
      } as unknown as Record<string, unknown>;
      const corruptedDefaults = {
        version: 99,
        entries: [],
        acknowledgedMilestones: [],
      } as unknown as Record<string, unknown>;

      const { store } = await setup(seeded, corruptedDefaults, 'time-saved');
      const ts = await import('../timeSavedStore');

      ts.getTimeSavedState(); // trigger init
      expect((store.data as { entries: unknown[] }).entries.length).toBe(1);
      expect(store.writes).toHaveLength(0);

      // Read-only: a milestone ack write is blocked.
      ts.acknowledgeMilestone(60);
      expect((store.data as { acknowledgedMilestones: unknown[] }).acknowledgedMilestones.length).toBe(0);
    });
  });

  describe('toolUsageStore (MEDIUM)', () => {
    it('does NOT overwrite on-disk tool usage with defaults on corrupted, and goes read-only', async () => {
      const seeded = {
        version: 1,
        tools: { Read: { count: 5 } },
      } as unknown as Record<string, unknown>;
      const corruptedDefaults = { version: 99, tools: {} } as unknown as Record<string, unknown>;

      const { store } = await setup(seeded, corruptedDefaults, 'tool-usage');
      const tu = await import('../toolUsageStore');
      tu.__resetToolUsageCacheForTests?.();

      tu.getAllToolUsage(); // trigger load
      // On-disk preserved (double-gated: shouldPersist false AND readOnly).
      expect(Object.keys((store.data as { tools: Record<string, unknown> }).tools)).toContain('Read');
      expect(store.writes).toHaveLength(0);

      // Read-only: recording a tool is blocked from persisting defaults over real data.
      tu.recordToolUsage('Write');
      expect(Object.keys((store.data as { tools: Record<string, unknown> }).tools)).toContain('Read');
    });
  });

  describe('contributionStore (LOW, no prior read-only concept)', () => {
    it('does NOT overwrite on-disk contributions with defaults on corrupted, and blocks the first write', async () => {
      const seeded = {
        version: 1,
        contributions: [{ id: 'c1', status: 'draft', updatedAt: 1 }],
      } as unknown as Record<string, unknown>;
      const corruptedDefaults = { version: 99, contributions: [] } as unknown as Record<string, unknown>;

      const { store } = await setup(seeded, corruptedDefaults, 'connector-contributions');
      const contrib = await import('../contributionStore');
      contrib.__resetContributionCacheForTests?.();

      // Trigger init via a read.
      contrib.listContributions?.();

      // On-disk preserved; backfill (which writes via store.set) was skipped.
      expect((store.data as { contributions: unknown[] }).contributions.length).toBe(1);

      // A write must throw (read-only) rather than clobber the real data.
      expect(() =>
        contrib.createContribution?.({
          connectorName: 'x',
          status: 'draft',
        } as unknown as never),
      ).toThrow();
      expect((store.data as { contributions: unknown[] }).contributions.length).toBe(1);
    });
  });
});

/**
 * F3 — first-touch non-destructive coverage. Here the store's FIRST API call is
 * the WRITER (no prior read). The bug class: `readOnlyMode` defaults to `false`
 * and is only set when load/migration runs; a writer that checks the flag before
 * loading would see a stale `false` and clobber a real file. Each writer must
 * load/migrate first so the corrupted/read-only state is established BEFORE the
 * write decision. (Red before the F1 fixes: each of these wiped the backing.)
 */
describe('migrateStore corrupted branch — FIRST-TOUCH writer non-destructive (F3)', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('timeSavedStore: addTimeSavedEntry as the first touch does NOT overwrite real data', async () => {
    const seeded = {
      version: 1,
      entries: [{ turnId: 't0', minutes: 30 }],
      acknowledgedMilestones: [],
      dailyTotals: {},
    } as unknown as Record<string, unknown>;
    const corruptedDefaults = {
      version: 99,
      entries: [],
      acknowledgedMilestones: [],
      dailyTotals: {},
    } as unknown as Record<string, unknown>;

    const { store } = await setup(seeded, corruptedDefaults, 'time-saved');
    const ts = await import('../timeSavedStore');

    // FIRST touch is the writer — no prior read. (The estimate is never read:
    // the read-only check returns before it's used.)
    const result = ts.addTimeSavedEntry('t-new', 's1', {
      lowMinutes: 1,
      highMinutes: 2,
      confidence: 'low',
      taskType: 'other',
    } as unknown as Parameters<typeof ts.addTimeSavedEntry>[2]);

    expect(result.added).toBe(false); // blocked (read-only)
    expect((store.data as { entries: unknown[] }).entries.length).toBe(1); // real data intact
    expect(store.writes).toHaveLength(0);
  });

  it('achievementsStore: a mutator as the first touch does NOT overwrite real data', async () => {
    const seeded = {
      version: 1,
      streaks: { current: 5, longest: 9, lastActiveDate: '2026-06-10', freezesUsedThisWeek: 0, weekStartDate: '2026-06-08' },
      badges: { real_badge: { unlockedAt: 1, notified: true } },
      evidence: { collected: [], bySignal: {} },
      tier: { current: 'practitioner', unlockedAt: 1, progressEvidence: [] },
    } as unknown as Record<string, unknown>;
    const corruptedDefaults = {
      version: 99,
      streaks: { current: 0, longest: 0, lastActiveDate: '', freezesUsedThisWeek: 0, weekStartDate: '' },
      badges: {},
      evidence: { collected: [], bySignal: {} },
      tier: { current: 'explorer', unlockedAt: 0, progressEvidence: [] },
    } as unknown as Record<string, unknown>;

    const { store } = await setup(seeded, corruptedDefaults, 'achievements');
    const a = await import('../achievementsStore');

    // FIRST touch is the writer — no prior read.
    a.unlockBadge('new_badge');

    // Real on-disk badges preserved; the write was blocked by read-only.
    expect((store.data as { badges: Record<string, unknown> }).badges).toHaveProperty('real_badge');
    expect((store.data as { badges: Record<string, unknown> }).badges).not.toHaveProperty('new_badge');
    expect(store.writes).toHaveLength(0);
  });

  it('toolUsageStore: clearToolUsage as the first touch does NOT overwrite real data', async () => {
    const seeded = {
      version: 1,
      tools: { Read: { count: 5 } },
    } as unknown as Record<string, unknown>;
    const corruptedDefaults = { version: 99, tools: {} } as unknown as Record<string, unknown>;

    const { store } = await setup(seeded, corruptedDefaults, 'tool-usage');
    const tu = await import('../toolUsageStore');
    tu.__resetToolUsageCacheForTests?.();

    // FIRST touch is the clear — no prior read.
    const ok = tu.clearToolUsage();

    expect(ok).toBe(false); // blocked (read-only)
    expect(Object.keys((store.data as { tools: Record<string, unknown> }).tools)).toContain('Read');
    expect(store.writes).toHaveLength(0);
  });

  it('fileConversationStore: clearFileConversations as the first touch does NOT overwrite real data', async () => {
    const seeded = {
      version: 1,
      entries: [{ id: 'e1', filePath: '/ws/a.md', sessionId: 's1', timestamp: 1, source: 'agent' }],
      lastPruned: 0,
    } as unknown as Record<string, unknown>;
    const corruptedDefaults = { version: 99, entries: [], lastPruned: 0 } as unknown as Record<string, unknown>;

    const { store } = await setup(seeded, corruptedDefaults, 'file-conversation');
    const fc = await import('../fileConversationStore');

    // FIRST touch is the clear — no prior read.
    fc.clearFileConversations();

    expect((store.data as { entries: unknown[] }).entries.length).toBe(1); // real data intact
    expect(store.writes).toHaveLength(0);
  });

  it('inboxStore: saveInboxState as the first touch does NOT overwrite real data', async () => {
    const seeded = {
      version: 1,
      items: [
        { id: 'a', title: 'Real A', status: 'active' },
        { id: 'b', title: 'Real B', status: 'active' },
      ],
      history: [],
    } as unknown as Record<string, unknown>;
    const corruptedDefaults = { version: 99, items: [], history: [] } as unknown as Record<string, unknown>;

    // Force the legacy load path (the migrateStore site) via the index-store stub.
    const { store } = await setup(seeded, corruptedDefaults, 'inbox', 'corrupted', {
      'inbox-index': makeLegacyForcingIndexStore(),
    });
    const inbox = await import('../inboxStore');

    // FIRST touch is the writer — saveInboxState with no prior read.
    inbox.saveInboxState({ version: 1, items: [], history: [] } as never);

    // The real legacy inbox was NOT overwritten with the empty payload.
    expect((store.data as { items: unknown[] }).items.length).toBe(2);
    expect(store.writes).toHaveLength(0);
  });

  // ── Round-3 sibling writers (the ones missed in round 2) ──────────────────

  it('timeSavedStore: acknowledgeMilestone (sibling writer) as first touch does NOT write', async () => {
    const seeded = {
      version: 1,
      entries: [{ turnId: 't0', minutes: 30 }],
      acknowledgedMilestones: [],
      dailyTotals: {},
    } as unknown as Record<string, unknown>;
    const corruptedDefaults = {
      version: 99,
      entries: [],
      acknowledgedMilestones: [],
      dailyTotals: {},
    } as unknown as Record<string, unknown>;

    const { store } = await setup(seeded, corruptedDefaults, 'time-saved');
    const ts = await import('../timeSavedStore');

    // FIRST touch is acknowledgeMilestone — a sibling writer that checked the
    // raw flag before init in round 2.
    ts.acknowledgeMilestone(60);

    expect((store.data as { acknowledgedMilestones: unknown[] }).acknowledgedMilestones.length).toBe(0);
    expect((store.data as { entries: unknown[] }).entries.length).toBe(1);
    expect(store.writes).toHaveLength(0);
  });

  it('skillUsageStore: recordSkillUsage as first touch does NOT overwrite real data', async () => {
    const seeded = {
      version: 1,
      skills: [{ skillName: 'real-skill', usageCount: 3, lastUsedAt: 1, firstUsedAt: 1, recentSessionIds: [] }],
      lastUpdatedAt: 1,
    } as unknown as Record<string, unknown>;
    const corruptedDefaults = { version: 99, skills: [], lastUpdatedAt: 0 } as unknown as Record<string, unknown>;

    const { store } = await setup(seeded, corruptedDefaults, 'skill-usage');
    const sk = await import('../skillUsageStore');

    // FIRST touch is the writer — no prior read.
    sk.recordSkillUsage('new-skill', 's1');

    // Real on-disk skill preserved; write blocked by read-only.
    const skills = (store.data as { skills: Array<{ skillName: string }> }).skills;
    expect(skills.some((s) => s.skillName === 'real-skill')).toBe(true);
    expect(skills.some((s) => s.skillName === 'new-skill')).toBe(false);
    expect(store.writes).toHaveLength(0);
  });

  it('useCaseLibraryStore: recordUseCaseUsage as first touch does NOT overwrite real data', async () => {
    const seeded = {
      version: 1,
      useCases: [
        { id: 'uc1', title: 'Real', description: '', prompt: 'p', icon: '✨', qualityRating: 85, embedding: [], generatedAt: 1, isNew: false, newUntil: 0, usageCount: 0, lastUsedAt: null, firstUsedAt: 1, dismissedFromCoach: false },
      ],
      lastUpdatedAt: 1,
      migrationComplete: true,
    } as unknown as Record<string, unknown>;
    const corruptedDefaults = { version: 99, useCases: [], lastUpdatedAt: 0, migrationComplete: false } as unknown as Record<string, unknown>;

    const { store } = await setup(seeded, corruptedDefaults, 'use-case-library');
    const uc = await import('../../../main/services/useCaseLibraryStore');

    // FIRST touch is the writer — no prior read.
    uc.recordUseCaseUsage('uc1');

    // The real use case is unchanged (usageCount still 0 — write was blocked).
    const cases = (store.data as { useCases: Array<{ id: string; usageCount: number }> }).useCases;
    expect(cases.length).toBe(1);
    expect(cases[0].usageCount).toBe(0);
    expect(store.writes).toHaveLength(0);
  });
});
