/**
 * Real-migration coverage for the achievements store (F4 from the round-2
 * review). The `storeWrites` fixtures were moved to version:3 (write tests, no
 * migration), which removed v1/v2 starting-point coverage. This file restores
 * it and proves the migration-key renumber {2,3} -> {1,2} (the off-by-one this
 * batch surfaced and fixed) actually migrates v1 and v2 stores cleanly.
 *
 * Uses the real `migrateStore` via `initTestPlatformConfig` + a seeded in-memory
 * store factory — never real userData, no version bumps.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { initTestPlatformConfig } from '@core/__tests__/testHelpers';

class SeededStore<T extends Record<string, unknown>> {
  data: T;
  writes: T[] = [];
  constructor(seeded: T) {
    this.data = structuredClone(seeded);
  }
  get store(): T {
    return this.data;
  }
  set store(value: T) {
    this.writes.push(structuredClone(value));
    this.data = value;
  }
  get<K extends keyof T>(key: K, def?: T[K]): T[K] | undefined {
    const v = this.data[key];
    return v !== undefined ? v : def;
  }
  set<K extends keyof T>(keyOrObj: K | Partial<T>, value?: T[K]): void {
    if (typeof keyOrObj === 'string') (this.data as Record<string, unknown>)[keyOrObj] = value;
    else Object.assign(this.data, keyOrObj);
    this.writes.push(structuredClone(this.data));
  }
  has(key: string): boolean {
    return key in this.data;
  }
  delete(key: string): void {
    delete (this.data as Record<string, unknown>)[key];
  }
  clear(): void {}
  get path(): string {
    return '/tmp/test-achievements.json';
  }
  onDidChange(): () => void {
    return () => {};
  }
  onDidAnyChange(): () => void {
    return () => {};
  }
  reload(): void {}
}

const seed = async (seeded: Record<string, unknown>): Promise<{ store: SeededStore<Record<string, unknown>>; mod: typeof import('../achievementsStore') }> => {
  vi.resetModules();
  await initTestPlatformConfig();
  const store = new SeededStore(seeded);
  const { setStoreFactory } = await import('@core/storeFactory');
  setStoreFactory(() => store as unknown as never);
  const { setBroadcastService } = await import('@core/broadcastService');
  setBroadcastService({ sendToAllWindows: () => {}, sendToFocusedWindow: () => {} });
  const mod = await import('../achievementsStore');
  return { store, mod };
};

describe('achievementsStore migrations (F4: keys renumbered {2,3} -> {1,2})', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('migrates a v1 store cleanly to v3 (no longer throws -> corrupted/read-only)', async () => {
    const v1 = {
      version: 1,
      streaks: { current: 4, longest: 9, lastActiveDate: '2026-06-10', freezesUsedThisWeek: 0, weekStartDate: '2026-06-08' },
      badges: { first_session: { unlockedAt: 100, notified: true } },
      evidence: { collected: [], bySignal: {} },
      tier: { current: 'practitioner', unlockedAt: 50, progressEvidence: [] },
    } as unknown as Record<string, unknown>;

    const { store, mod } = await seed(v1);

    // Reading streaks triggers init+migration. Pre-fix this threw "Missing
    // migration from v1 to v2" -> corrupted -> read-only; post-fix it migrates.
    const streak = mod.getStreakData();
    expect(streak.current).toBe(4); // real v1 data preserved through migration
    // Migrated, persisted at v3 with the additive fields present.
    expect((store.data as { version: number }).version).toBe(3);
    const counters = (store.data as { counters?: Record<string, number> }).counters;
    expect(counters).toBeDefined();
    expect(counters?.nightSessions).toBe(0);
    expect(counters?.totalSkillInvocations).toBe(0);
    // A write succeeds (NOT read-only) — proving migration didn't degrade.
    mod.incrementSessionCount(false);
    expect((store.data as { counters: Record<string, number> }).counters.totalSessions).toBe(1);
  });

  it('migrates a v2 store to v3 running the CORRECT (v2->v3) step, preserving counters', async () => {
    const v2 = {
      version: 2,
      streaks: { current: 0, longest: 0, lastActiveDate: '', freezesUsedThisWeek: 0, weekStartDate: '' },
      badges: {},
      evidence: { collected: [], bySignal: {} },
      tier: { current: 'explorer', unlockedAt: 0, progressEvidence: [] },
      onboarding: { completedDays: [3], journeyStartedAt: 123 },
      counters: { totalSessions: 7, voiceSessions: 2, weekendSessions: 1, totalTimeSavedMinutes: 42 },
    } as unknown as Record<string, unknown>;

    const { store, mod } = await seed(v2);

    mod.getStreakData(); // trigger migration
    expect((store.data as { version: number }).version).toBe(3);
    const counters = (store.data as { counters: Record<string, number> }).counters;
    // Pre-fix the v2 store ran the WRONG fn (v1->v2) and stopped; post-fix it
    // runs v2->v3, which preserves existing counters AND adds the new ones.
    expect(counters.totalSessions).toBe(7); // preserved
    expect(counters.totalTimeSavedMinutes).toBe(42); // preserved
    expect(counters.nightSessions).toBe(0); // added by v2->v3
    expect(counters.totalAutomationsCreated).toBe(0); // added by v2->v3
    // onboarding preserved
    expect((store.data as { onboarding: { completedDays: number[] } }).onboarding.completedDays).toEqual([3]);
  });
});
