/**
 * F2 + F4 (round 3): stores that NORMALIZED raw data to the current version
 * before calling `migrateStore` used to hide present-but-unversioned REAL data
 * from the hardened Case-2 protection, leaving it writable so a later save could
 * overwrite it. These tests use the REAL `migrateStore` (no mock) with a seeded
 * in-memory store to prove:
 *
 *   - non-empty version-less data is NOT overwritten and the store goes
 *     read-only (F2: skillUsageStore, useCaseLibraryStore);
 *   - empty `{}` still initializes fresh and is writable (no false positive);
 *   - skillUsage v1 data migrates cleanly to current (F4: migration-key
 *     off-by-one renumber).
 *
 * Temp-dir / in-memory only via initTestPlatformConfig — never real userData.
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
    return '/tmp/test-stores/x.json';
  }
  onDidChange(): () => void {
    return () => {};
  }
  onDidAnyChange(): () => void {
    return () => {};
  }
  reload(): void {}
}

const seedReal = async <T extends Record<string, unknown>>(
  seeded: T,
): Promise<{ store: SeededStore<T> }> => {
  vi.resetModules();
  await initTestPlatformConfig();
  const store = new SeededStore<T>(seeded);
  const { setStoreFactory } = await import('@core/storeFactory');
  setStoreFactory(() => store as unknown as never);
  // Point store backups at an isolated temp dir (never real userData).
  process.env.REBEL_USER_DATA = '/tmp/rebel-test-r3-backups';
  return { store };
};

describe('F2: normalize-before-migrate bypass fixed (version-less real data preserved)', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    delete process.env.REBEL_USER_DATA;
  });

  it('skillUsageStore: NON-EMPTY version-less data is preserved (read-only), not overwritten', async () => {
    // Real skills, but the `version` field is missing (corrupted/lost). Pre-fix
    // this was normalized to the current version → skipped migrateStore → stayed
    // writable. Post-fix migrateStore classifies it as non-empty version-less →
    // corrupted/read-only and the on-disk data is preserved.
    const seeded = {
      skills: [{ skillName: 'real-skill', usageCount: 7, lastUsedAt: 1, firstUsedAt: 1, recentSessionIds: [] }],
      lastUpdatedAt: 1,
    } as unknown as Record<string, unknown>;

    const { store } = await seedReal(seeded);
    const sk = await import('../skillUsageStore');

    // Reading returns the degraded (defaults) view this session...
    const all = sk.getAllSkillUsage();
    expect(all.length).toBe(0);
    // ...but the on-disk data is preserved (NOT overwritten with defaults).
    expect((store.data as { skills: unknown[] }).skills.length).toBe(1);
    expect(store.writes).toHaveLength(0);

    // A write is blocked (read-only).
    sk.recordSkillUsage('new-skill');
    expect((store.data as { skills: Array<{ skillName: string }> }).skills[0].skillName).toBe('real-skill');
    expect(store.writes).toHaveLength(0);
  });

  it('skillUsageStore: empty {} still initializes fresh and is writable (no false positive)', async () => {
    const { store } = await seedReal({} as Record<string, unknown>);
    const sk = await import('../skillUsageStore');

    sk.recordSkillUsage('first-skill');
    // Fresh init: the write went through.
    const skills = (store.data as { skills?: Array<{ skillName: string }> }).skills ?? [];
    expect(skills.some((s) => s.skillName === 'first-skill')).toBe(true);
  });

  it('useCaseLibraryStore: NON-EMPTY version-less data is preserved (read-only), not overwritten', async () => {
    const seeded = {
      useCases: [
        { id: 'uc1', title: 'Real', description: '', prompt: 'p', icon: '✨', qualityRating: 85, embedding: [], generatedAt: 1, isNew: false, newUntil: 0, usageCount: 4, lastUsedAt: null, firstUsedAt: 1, dismissedFromCoach: false },
      ],
      lastUpdatedAt: 1,
      migrationComplete: true,
    } as unknown as Record<string, unknown>;

    const { store } = await seedReal(seeded);
    const uc = await import('../../../main/services/useCaseLibraryStore');

    const all = uc.getAllUseCases();
    expect(all.length).toBe(0); // degraded in-memory
    expect((store.data as { useCases: unknown[] }).useCases.length).toBe(1); // preserved
    expect(store.writes).toHaveLength(0);

    // Write blocked.
    uc.recordUseCaseUsage('uc1');
    expect((store.data as { useCases: Array<{ usageCount: number }> }).useCases[0].usageCount).toBe(4);
    expect(store.writes).toHaveLength(0);
  });

  it('useCaseLibraryStore: empty {} initializes fresh (persists defaults, NOT read-only)', async () => {
    // Empty {} is the fresh-init shape: migrateStore returns corrupted +
    // shouldPersist:true, so loadInternal persists normalized defaults (a write)
    // and does NOT enter read-only. Contrast with the version-less case above,
    // which records ZERO writes (preserved). Avoids the embedding-service
    // dependency of forceAddUseCase by asserting the init persist directly.
    const { store } = await seedReal({} as Record<string, unknown>);
    const uc = await import('../../../main/services/useCaseLibraryStore');

    const all = uc.getAllUseCases(); // triggers fresh init
    expect(all.length).toBe(0);
    // Fresh init persisted defaults (distinguishes from version-less preserve).
    expect(store.writes.length).toBeGreaterThanOrEqual(1);
  });
});

describe('F4: skillUsage migration off-by-one fixed (v1 migrates cleanly)', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    delete process.env.REBEL_USER_DATA;
  });

  it('migrates a v1 skill-usage store to current, preserving real skills and staying writable', async () => {
    const seeded = {
      version: 1,
      skills: [{ skillName: 'kept-skill', usageCount: 2, lastUsedAt: 5, firstUsedAt: 5, recentSessionIds: ['s1'] }],
      lastUpdatedAt: 5,
    } as unknown as Record<string, unknown>;

    const { store } = await seedReal(seeded);
    const sk = await import('../skillUsageStore');

    // Pre-fix: v1 threw "Missing migration from v1 to v2" -> corrupted -> read-only.
    // Post-fix: migrates and preserves the real skill.
    const all = sk.getAllSkillUsage();
    expect(all.some((s) => s.skillName === 'kept-skill')).toBe(true);
    // Persisted at the migrated current version.
    expect((store.data as { version: number }).version).toBeGreaterThanOrEqual(2);

    // Writable (not read-only) — a new skill records successfully.
    sk.recordSkillUsage('added-after-migration');
    const skills = (store.data as { skills: Array<{ skillName: string }> }).skills;
    expect(skills.some((s) => s.skillName === 'added-after-migration')).toBe(true);
    expect(skills.some((s) => s.skillName === 'kept-skill')).toBe(true);
  });
});
