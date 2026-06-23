import { describe, expect, it } from 'vitest';
import {
  FLY_VM_TIER_CATALOG,
  getDefaultTier,
  getDisplayLabels,
  getTierById,
  getTierFromGuest,
  summarizeTierMatch,
  toFlyGuestConfig,
  type VmTier,
} from '../vmTierCatalog';

function requireTier(id: VmTier['id']): VmTier {
  const tier = getTierById(id);
  if (!tier) {
    throw new Error(`Expected ${id} tier to exist`);
  }
  return tier;
}

describe('vmTierCatalog', () => {
  it('returns standard tier by id', () => {
    const tier = getTierById('standard');
    expect(tier?.id).toBe('standard');
    expect(tier?.label).toBe('Standard');
  });

  it('returns undefined for unknown id', () => {
    expect(getTierById('unknown')).toBeUndefined();
  });

  it('returns the tier marked as default', () => {
    const defaultTier = getDefaultTier();
    expect(defaultTier.id).toBe('standard');
    expect(defaultTier.isDefault).toBe(true);
  });

  it('maps standard tier to Fly guest config', () => {
    const standardTier = getTierById('standard');
    expect(standardTier).toBeDefined();
    if (!standardTier) {
      throw new Error('Expected standard tier to exist');
    }
    expect(toFlyGuestConfig(standardTier)).toEqual({
      cpu_kind: 'shared',
      cpus: 4,
      memory_mb: 4096,
    });
  });

  it('matches guest machines to the highest dominated tier', () => {
    const cases: Array<{
      guest: { cpuKind?: string; cpus?: number; memoryMb?: number };
      expectedTierId: VmTier['id'] | undefined;
      expectedState: 'exact' | 'approx' | 'none';
      expectedExceeds: Array<'cpus' | 'memoryMb'>;
    }> = [
      {
        guest: { cpuKind: 'shared', cpus: 4, memoryMb: 4096 },
        expectedTierId: 'standard',
        expectedState: 'exact',
        expectedExceeds: [],
      },
      {
        guest: { cpuKind: 'performance', cpus: 2, memoryMb: 4096 },
        expectedTierId: 'faster',
        expectedState: 'exact',
        expectedExceeds: [],
      },
      {
        guest: { cpuKind: 'performance', cpus: 4, memoryMb: 8192 },
        expectedTierId: 'heavy-work',
        expectedState: 'exact',
        expectedExceeds: [],
      },
      {
        guest: { cpuKind: 'performance', cpus: 2, memoryMb: 8192 },
        expectedTierId: 'faster',
        expectedState: 'approx',
        expectedExceeds: ['memoryMb'],
      },
      {
        guest: { cpuKind: 'performance', cpus: 4, memoryMb: 4096 },
        expectedTierId: 'faster',
        expectedState: 'approx',
        expectedExceeds: ['cpus'],
      },
      {
        guest: { cpuKind: 'shared', cpus: 8, memoryMb: 16384 },
        expectedTierId: 'standard',
        expectedState: 'approx',
        expectedExceeds: ['cpus', 'memoryMb'],
      },
      {
        guest: { cpuKind: 'performance', cpus: 8, memoryMb: 16384 },
        expectedTierId: 'heavy-work',
        expectedState: 'approx',
        expectedExceeds: ['cpus', 'memoryMb'],
      },
      {
        guest: { cpuKind: 'shared', cpus: 1, memoryMb: 256 },
        expectedTierId: undefined,
        expectedState: 'none',
        expectedExceeds: [],
      },
      {
        guest: { cpuKind: 'shared', memoryMb: 4096 },
        expectedTierId: undefined,
        expectedState: 'none',
        expectedExceeds: [],
      },
      {
        guest: { cpuKind: 'turbo', cpus: 4, memoryMb: 4096 },
        expectedTierId: undefined,
        expectedState: 'none',
        expectedExceeds: [],
      },
    ];

    for (const testCase of cases) {
      const tier = getTierFromGuest(testCase.guest);
      expect(tier?.id).toBe(testCase.expectedTierId);
      expect(summarizeTierMatch(tier, testCase.guest)).toEqual({
        state: testCase.expectedState,
        exceeds: testCase.expectedExceeds,
      });
    }
  });

  it('returns none for non-numeric guest fields', () => {
    const guest = { cpuKind: 'shared', cpus: '4' as unknown as number, memoryMb: 4096 };
    const tier = getTierFromGuest(guest);
    expect(tier).toBeUndefined();
    expect(summarizeTierMatch(tier, guest)).toEqual({ state: 'none', exceeds: [] });
  });

  it('keeps default tier exactly aligned with previous hardcoded provisioning guest config', () => {
    const defaultTier = getDefaultTier();
    const guest = toFlyGuestConfig(defaultTier);
    expect(guest).toEqual({ cpu_kind: 'shared', cpus: 4, memory_mb: 4096 });
  });

  it('defines exactly one default tier in the catalog', () => {
    const defaults = FLY_VM_TIER_CATALOG.filter((tier) => tier.isDefault);
    expect(defaults).toHaveLength(1);
    expect(defaults[0].id).toBe('standard');
  });

  it('derives display labels from catalog memory and price ordering', () => {
    expect(getDisplayLabels(requireTier('standard'))).toEqual({
      workingRoom: 'Standard',
      speedRank: 1,
    });
    expect(getDisplayLabels(requireTier('faster'))).toEqual({
      workingRoom: 'Standard',
      speedRank: 2,
    });
    expect(getDisplayLabels(requireTier('heavy-work'))).toEqual({
      workingRoom: 'Double',
      speedRank: 3,
    });
  });
});
