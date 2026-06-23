import { describe, expect, it } from 'vitest';

import {
  getCatalogEntryByTag,
  getRecommendedModels,
  isModelSuitableForSystem,
  LOCAL_MODEL_CATALOG,
} from '../modelCatalog';

// ---------------------------------------------------------------------------
// Tests: Catalog data integrity
// ---------------------------------------------------------------------------

describe('LOCAL_MODEL_CATALOG', () => {
  it('has exactly 4 entries', () => {
    expect(LOCAL_MODEL_CATALOG).toHaveLength(4);
  });

  it('every entry has required fields', () => {
    for (const entry of LOCAL_MODEL_CATALOG) {
      expect(entry.id).toBeTruthy();
      expect(entry.ollamaTag).toBeTruthy();
      expect(entry.displayName).toBeTruthy();
      expect(entry.downloadSizeGB).toBeGreaterThan(0);
      expect(entry.minRAMGB).toBeGreaterThan(0);
      expect(entry.recommendedRAMGB).toBeGreaterThanOrEqual(entry.minRAMGB);
      expect(entry.contextWindowDefault).toBeGreaterThan(0);
      expect(entry.contextWindowMax).toBeGreaterThanOrEqual(entry.contextWindowDefault);
    }
  });

  it('has unique IDs and tags', () => {
    const ids = LOCAL_MODEL_CATALOG.map((e) => e.id);
    const tags = LOCAL_MODEL_CATALOG.map((e) => e.ollamaTag);
    expect(new Set(ids).size).toBe(ids.length);
    expect(new Set(tags).size).toBe(tags.length);
  });
});

// ---------------------------------------------------------------------------
// Tests: isModelSuitableForSystem
// ---------------------------------------------------------------------------

describe('isModelSuitableForSystem', () => {
  const qwen9b = LOCAL_MODEL_CATALOG.find((e) => e.id === 'qwen3.5-9b')!;
  const qwen4b = LOCAL_MODEL_CATALOG.find((e) => e.id === 'qwen3.5-4b')!;

  it('returns true when RAM meets minimum', () => {
    expect(isModelSuitableForSystem(qwen9b, 16)).toBe(true);
    expect(isModelSuitableForSystem(qwen4b, 8)).toBe(true);
  });

  it('returns true when RAM exceeds minimum', () => {
    expect(isModelSuitableForSystem(qwen9b, 36)).toBe(true);
    expect(isModelSuitableForSystem(qwen4b, 16)).toBe(true);
  });

  it('returns false when RAM is below minimum', () => {
    expect(isModelSuitableForSystem(qwen9b, 15)).toBe(false);
    expect(isModelSuitableForSystem(qwen4b, 7)).toBe(false);
  });

  it('handles exact boundary (minRAMGB)', () => {
    expect(isModelSuitableForSystem(qwen9b, qwen9b.minRAMGB)).toBe(true);
    expect(isModelSuitableForSystem(qwen9b, qwen9b.minRAMGB - 0.1)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Tests: getRecommendedModels
// ---------------------------------------------------------------------------

describe('getRecommendedModels', () => {
  it('48 GB machine sees all models', () => {
    const models = getRecommendedModels(48);
    expect(models).toHaveLength(4);
  });

  it('32 GB machine sees all models', () => {
    const models = getRecommendedModels(32);
    expect(models).toHaveLength(4);
  });

  it('16 GB machine sees models with minRAMGB <= 16', () => {
    const models = getRecommendedModels(16);
    expect(models).toHaveLength(3);
    for (const m of models) {
      expect(m.minRAMGB).toBeLessThanOrEqual(16);
    }
  });

  it('12 GB machine sees only models with minRAMGB <= 12', () => {
    const models = getRecommendedModels(12);
    expect(models).toHaveLength(2);
    for (const m of models) {
      expect(m.minRAMGB).toBeLessThanOrEqual(12);
    }
  });

  it('8 GB machine sees lightweight models', () => {
    const models = getRecommendedModels(8);
    expect(models).toHaveLength(2);
    for (const m of models) {
      expect(m.minRAMGB).toBeLessThanOrEqual(8);
    }
  });

  it('4 GB machine sees no models', () => {
    const models = getRecommendedModels(4);
    expect(models).toHaveLength(0);
  });

  it('recommended badge sorts first', () => {
    const models = getRecommendedModels(48);
    expect(models[0].badge).toBe('recommended');
    expect(models[0].id).toBe('qwen3.6-35b-a3b');
  });

  it('after recommended, models are sorted by descending toolCallingScore', () => {
    const models = getRecommendedModels(48);
    for (let i = 1; i < models.length - 1; i++) {
      expect(models[i].toolCallingScore ?? 0).toBeGreaterThanOrEqual(models[i + 1].toolCallingScore ?? 0);
    }
  });
});

// ---------------------------------------------------------------------------
// Tests: getCatalogEntryByTag
// ---------------------------------------------------------------------------

describe('getCatalogEntryByTag', () => {
  it('returns correct entry for valid tag', () => {
    const entry = getCatalogEntryByTag('qwen3.5:9b');
    expect(entry).toBeDefined();
    expect(entry!.id).toBe('qwen3.5-9b');
  });

  it('returns correct entry for each catalog model', () => {
    for (const catalogEntry of LOCAL_MODEL_CATALOG) {
      const found = getCatalogEntryByTag(catalogEntry.ollamaTag);
      expect(found).toBeDefined();
      expect(found!.id).toBe(catalogEntry.id);
    }
  });

  it('returns undefined for unknown tag', () => {
    expect(getCatalogEntryByTag('nonexistent:model')).toBeUndefined();
  });

  it('returns undefined for empty string', () => {
    expect(getCatalogEntryByTag('')).toBeUndefined();
  });
});
