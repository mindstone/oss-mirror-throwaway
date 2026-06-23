import { describe, expect, it } from 'vitest';

import {
  CONSERVATIVE_STRATEGY,
  estimateRAMUsage,
  resolveStrategy,
  TURBO_QUANT_STRATEGY,
} from '../inferenceStrategy';
import type { LocalModelCatalogEntry, OllamaCapabilities } from '../ollamaTypes';
import { OLLAMA_PORT } from '../ollamaTypes';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const qwen14b: LocalModelCatalogEntry = {
  id: 'qwen3.5-14b',
  ollamaTag: 'qwen3.5:14b',
  displayName: 'Qwen 3.5 14B',
  description: 'Test model',
  downloadSizeGB: 9,
  minRAMGB: 16,
  recommendedRAMGB: 24,
  toolCallingScore: 98.5,
  contextWindowDefault: 32_000,
  contextWindowMax: 128_000,
  badge: 'recommended',
};

const qwen4b: LocalModelCatalogEntry = {
  id: 'qwen3.5-4b',
  ollamaTag: 'qwen3.5:4b',
  displayName: 'Qwen 3.5 4B',
  description: 'Lightweight test model',
  downloadSizeGB: 2.5,
  minRAMGB: 8,
  recommendedRAMGB: 16,
  toolCallingScore: 97.5,
  contextWindowDefault: 32_000,
  contextWindowMax: 64_000,
  badge: 'lightweight',
};

const turboCapabilities: OllamaCapabilities = {
  version: '0.9.8',
  turboQuantSupported: true,
  kvCacheTypes: ['f16', 'q4_0', 'q8_0', 'turbo3'],
};

const oldCapabilities: OllamaCapabilities = {
  version: '0.8.0',
  turboQuantSupported: false,
  kvCacheTypes: ['f16', 'q4_0', 'q8_0'],
};

// ---------------------------------------------------------------------------
// Tests: Strategy selection
// ---------------------------------------------------------------------------

describe('resolveStrategy', () => {
  describe('strategy selection', () => {
    it('selects TurboQuant when capabilities support it', () => {
      const result = resolveStrategy(36, qwen14b, 32_000, turboCapabilities);
      expect(result.strategy.id).toBe('turbo-default');
      expect(result.strategy.kvCacheType).toBe('turbo3');
    });

    it('selects conservative when Ollama version is too old', () => {
      const result = resolveStrategy(36, qwen14b, 32_000, oldCapabilities);
      expect(result.strategy.id).toBe('conservative');
      expect(result.strategy.kvCacheType).toBe('q4_0');
    });

    it('defaults to TurboQuant when capabilities are unknown (optimistic)', () => {
      const result = resolveStrategy(36, qwen14b, 32_000);
      expect(result.strategy.id).toBe('turbo-default');
    });

    it('selects conservative when version meets minimum but turboQuant not supported', () => {
      const caps: OllamaCapabilities = {
        version: '0.9.8',
        turboQuantSupported: false,
        kvCacheTypes: ['f16', 'q4_0'],
      };
      const result = resolveStrategy(36, qwen14b, 32_000, caps);
      expect(result.strategy.id).toBe('conservative');
    });

    it('selects TurboQuant when turbo3 is in kvCacheTypes even if turboQuantSupported is false', () => {
      const caps: OllamaCapabilities = {
        version: '0.9.8',
        turboQuantSupported: false,
        kvCacheTypes: ['f16', 'q4_0', 'turbo3'],
      };
      const result = resolveStrategy(36, qwen14b, 32_000, caps);
      expect(result.strategy.id).toBe('turbo-default');
    });
  });

  describe('context window clamping', () => {
    it('honors desired context when RAM is sufficient', () => {
      const result = resolveStrategy(36, qwen14b, 64_000, turboCapabilities);
      expect(result.effectiveContextWindow).toBe(64_000);
    });

    it('clamps to contextWindowMax when desired exceeds it', () => {
      const result = resolveStrategy(64, qwen14b, 200_000, turboCapabilities);
      expect(result.effectiveContextWindow).toBe(128_000);
    });

    it('clamps context window down when RAM is tight', () => {
      // 14 GB machine with 14B model and TurboQuant — 128K doesn't fit, should clamp
      // At 128K: est ≈ 9 + (9*0.2*4)/5 + 4 = 14.44 > 14 → must reduce
      const result = resolveStrategy(14, qwen14b, 128_000, turboCapabilities);
      expect(result.effectiveContextWindow).toBeLessThan(128_000);
      expect(result.effectiveContextWindow).toBeGreaterThanOrEqual(qwen14b.contextWindowDefault);
    });

    it('returns default context when RAM is at minRAMGB boundary', () => {
      const result = resolveStrategy(16, qwen14b, 128_000, turboCapabilities);
      // At min RAM, context should be clamped towards default
      expect(result.effectiveContextWindow).toBeGreaterThanOrEqual(qwen14b.contextWindowDefault);
    });

    it('does not go below contextWindowDefault', () => {
      // Very tight RAM
      const result = resolveStrategy(16, qwen14b, 128_000, oldCapabilities);
      expect(result.effectiveContextWindow).toBeGreaterThanOrEqual(qwen14b.contextWindowDefault);
    });
  });

  describe('Ollama env vars', () => {
    it('always includes OLLAMA_HOST', () => {
      const result = resolveStrategy(36, qwen14b, 32_000);
      expect(result.ollamaEnv.OLLAMA_HOST).toBe(`127.0.0.1:${OLLAMA_PORT}`);
    });

    it('includes strategy-specific env vars for TurboQuant', () => {
      const result = resolveStrategy(36, qwen14b, 32_000, turboCapabilities);
      expect(result.ollamaEnv.OLLAMA_KV_CACHE_TYPE).toBe('turbo3');
      expect(result.ollamaEnv.OLLAMA_NUM_PARALLEL).toBe('1');
    });

    it('includes strategy-specific env vars for conservative', () => {
      const result = resolveStrategy(36, qwen14b, 32_000, oldCapabilities);
      expect(result.ollamaEnv.OLLAMA_KV_CACHE_TYPE).toBe('q4_0');
    });
  });
});

// ---------------------------------------------------------------------------
// Tests: RAM estimation
// ---------------------------------------------------------------------------

describe('estimateRAMUsage', () => {
  it('returns expected value for 14B model at default context with TurboQuant', () => {
    const ram = estimateRAMUsage(qwen14b, 32_000, TURBO_QUANT_STRATEGY);
    // Model weights (9) + KV cache base (9 * 0.2 * 1 = 1.8) / 5.0 (0.36) + OS (4) ≈ 13.36
    expect(ram).toBeCloseTo(13.36, 1);
  });

  it('returns expected value for 14B model at default context with conservative', () => {
    const ram = estimateRAMUsage(qwen14b, 32_000, CONSERVATIVE_STRATEGY);
    // Model weights (9) + KV cache base (1.8) / 1.0 + OS (4) = 14.8
    expect(ram).toBeCloseTo(14.8, 1);
  });

  it('scales with context window', () => {
    const ram32k = estimateRAMUsage(qwen14b, 32_000, TURBO_QUANT_STRATEGY);
    const ram64k = estimateRAMUsage(qwen14b, 64_000, TURBO_QUANT_STRATEGY);
    const ram128k = estimateRAMUsage(qwen14b, 128_000, TURBO_QUANT_STRATEGY);

    expect(ram64k).toBeGreaterThan(ram32k);
    expect(ram128k).toBeGreaterThan(ram64k);
  });

  it('TurboQuant uses significantly less RAM than conservative at large context', () => {
    const turboRAM = estimateRAMUsage(qwen14b, 128_000, TURBO_QUANT_STRATEGY);
    const conservRAM = estimateRAMUsage(qwen14b, 128_000, CONSERVATIVE_STRATEGY);

    // TurboQuant should use roughly 5× less KV cache
    expect(turboRAM).toBeLessThan(conservRAM);
    expect(conservRAM - turboRAM).toBeGreaterThan(3); // significant difference in GB
  });

  it('returns expected value for lightweight model', () => {
    const ram = estimateRAMUsage(qwen4b, 32_000, TURBO_QUANT_STRATEGY);
    // Model weights (2.5) + KV cache (2.5 * 0.2 * 1 / 5.0 = 0.1) + OS (4) = 6.6
    expect(ram).toBeCloseTo(6.6, 1);
  });
});
