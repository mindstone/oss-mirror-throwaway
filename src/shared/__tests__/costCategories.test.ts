import { describe, expect, it } from 'vitest';
import {
  COST_CATEGORY_REGISTRY,
  COST_GROUP_KEYS,
  COST_GROUP_LABELS,
  type CostGroupKey,
  type CostCategoryKey,
  type AuxiliaryCostCategory,
  groupForCategory,
  labelForCategory,
  descForCategory,
  categoriesForGroup,
  ALL_KNOWN_CATEGORIES,
} from '../costCategories';

/**
 * Registry completeness tests — structural guards for cost category integrity.
 *
 * These tests ensure:
 * 1. The registry itself is well-formed (required fields, valid groups)
 * 2. Derived types are correct (AuxiliaryCostCategory filters by kind)
 * 3. Lookup helpers work for all known categories + graceful fallbacks
 * 4. No gaps between the registry and its derived helpers
 *
 * @see src/shared/costCategories.ts — the single source of truth
 * @see docs/plans/260406_cost_tracking_audit_and_hardening.md — Stage 3
 */

const allCategoryKeys = Object.keys(COST_CATEGORY_REGISTRY) as CostCategoryKey[];

describe('COST_CATEGORY_REGISTRY structure', () => {
  it('has at least one entry', () => {
    expect(allCategoryKeys.length).toBeGreaterThan(0);
  });

  it.each(allCategoryKeys)('entry "%s" has required fields (kind, group, label)', (cat) => {
    const entry = COST_CATEGORY_REGISTRY[cat];
    expect(entry).toHaveProperty('kind');
    expect(entry).toHaveProperty('group');
    expect(entry).toHaveProperty('label');
    expect(['auxiliary', 'turn', 'legacy']).toContain(entry.kind);
    expect(typeof entry.label).toBe('string');
    expect(entry.label.length).toBeGreaterThan(0);
  });

  it.each(allCategoryKeys)('entry "%s" has a valid CostGroupKey', (cat) => {
    const entry = COST_CATEGORY_REGISTRY[cat];
    expect(COST_GROUP_KEYS).toContain(entry.group);
  });

  it('every CostGroupKey has a label in COST_GROUP_LABELS', () => {
    for (const group of COST_GROUP_KEYS) {
      expect(COST_GROUP_LABELS[group]).toBeDefined();
      expect(typeof COST_GROUP_LABELS[group]).toBe('string');
    }
  });
});

describe('AuxiliaryCostCategory type correctness', () => {
  it('only includes entries with kind: "auxiliary"', () => {
    // This is a compile-time check — the type should only include auxiliary categories.
    // We verify at runtime that every auxiliary entry can be assigned to the type.
    const auxiliaryKeys = allCategoryKeys.filter(
      (cat) => COST_CATEGORY_REGISTRY[cat].kind === 'auxiliary'
    );

    // Verify we have auxiliary categories
    expect(auxiliaryKeys.length).toBeGreaterThan(0);

    // Verify each one is assignable (TypeScript would catch type errors at compile time;
    // this runtime check documents the expected set)
    for (const key of auxiliaryKeys) {
      const _typeCheck: AuxiliaryCostCategory = key as AuxiliaryCostCategory;
      expect(_typeCheck).toBe(key);
    }
  });

  it('does not include non-auxiliary entries', () => {
    const nonAuxiliaryKeys = allCategoryKeys.filter(
      (cat) => COST_CATEGORY_REGISTRY[cat].kind !== 'auxiliary'
    );

    expect(nonAuxiliaryKeys.length).toBeGreaterThan(0);
    // These should NOT be assignable to AuxiliaryCostCategory.
    // We verify the registry kind is not 'auxiliary' for each.
    for (const key of nonAuxiliaryKeys) {
      expect(COST_CATEGORY_REGISTRY[key].kind).not.toBe('auxiliary');
    }
  });
});

describe('groupForCategory()', () => {
  it.each(allCategoryKeys)('returns the correct group for known category "%s"', (cat) => {
    const expected = COST_CATEGORY_REGISTRY[cat].group;
    expect(groupForCategory(cat)).toBe(expected);
  });

  it('returns "housekeeping" for unknown strings', () => {
    expect(groupForCategory('totally-unknown-category')).toBe('housekeeping');
    expect(groupForCategory('')).toBe('housekeeping');
    expect(groupForCategory('future-feature-xyz')).toBe('housekeeping');
  });
});

describe('labelForCategory()', () => {
  it.each(allCategoryKeys)('returns a label for known category "%s"', (cat) => {
    const label = labelForCategory(cat);
    expect(typeof label).toBe('string');
    expect(label.length).toBeGreaterThan(0);
    // Should match the registry label exactly
    expect(label).toBe(COST_CATEGORY_REGISTRY[cat].label);
  });

  it('returns a formatted fallback for unknown strings', () => {
    expect(labelForCategory('new-feature')).toBe('New feature');
    expect(labelForCategory('some_category')).toBe('Some category');
    expect(labelForCategory('x')).toBe('X');
  });
});

describe('descForCategory()', () => {
  it('returns descriptions for categories that have them', () => {
    const withDesc = allCategoryKeys.filter((cat) => {
      const entry = COST_CATEGORY_REGISTRY[cat];
      return 'desc' in entry && entry.desc !== undefined;
    });
    expect(withDesc.length).toBeGreaterThan(0);

    for (const cat of withDesc) {
      expect(typeof descForCategory(cat)).toBe('string');
    }
  });

  it('returns undefined for unknown categories', () => {
    expect(descForCategory('unknown-category')).toBeUndefined();
  });
});

describe('categoriesForGroup()', () => {
  it.each([...COST_GROUP_KEYS] as CostGroupKey[])(
    'returns non-empty array for group "%s"',
    (group) => {
      const cats = categoriesForGroup(group);
      expect(Array.isArray(cats)).toBe(true);
      expect(cats.length).toBeGreaterThan(0);
      // Every returned category should actually belong to this group
      for (const cat of cats) {
        expect(groupForCategory(cat)).toBe(group);
      }
    }
  );

  it('every known category appears in exactly one group', () => {
    const seen = new Set<string>();
    for (const group of COST_GROUP_KEYS) {
      for (const cat of categoriesForGroup(group)) {
        expect(seen.has(cat)).toBe(false);
        seen.add(cat);
      }
    }
    // Every registry key should have been seen
    for (const cat of allCategoryKeys) {
      expect(seen.has(cat)).toBe(true);
    }
  });
});

describe('ALL_KNOWN_CATEGORIES completeness', () => {
  it('contains every registry key', () => {
    for (const cat of allCategoryKeys) {
      expect(ALL_KNOWN_CATEGORIES.has(cat)).toBe(true);
    }
  });

  it('has the same size as the registry', () => {
    expect(ALL_KNOWN_CATEGORIES.size).toBe(allCategoryKeys.length);
  });
});

describe('no gaps between registry and derived helpers', () => {
  it('groupForCategory covers all registry entries without gaps', () => {
    const groupedCategories = new Set<string>();
    for (const group of COST_GROUP_KEYS) {
      for (const cat of categoriesForGroup(group)) {
        groupedCategories.add(cat);
      }
    }

    // Every registry key should appear in at least one group
    for (const cat of allCategoryKeys) {
      expect(groupedCategories.has(cat)).toBe(true);
    }

    // And nothing extra should appear (no phantom categories from stale data)
    expect(groupedCategories.size).toBe(allCategoryKeys.length);
  });
});
