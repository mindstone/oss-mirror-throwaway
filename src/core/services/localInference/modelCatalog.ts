/**
 * Local Model Catalog
 *
 * Curated list of models validated for local inference with Rebel.
 * Sorted by recommendation priority. Pure data + filter functions — no Electron dependencies.
 */

import type { LocalModelCatalogEntry } from './ollamaTypes';

// ---------------------------------------------------------------------------
// Catalog
// ---------------------------------------------------------------------------

export const LOCAL_MODEL_CATALOG: LocalModelCatalogEntry[] = [
  {
    id: 'qwen3.6-35b-a3b',
    ollamaTag: 'qwen3.6:35b',
    displayName: 'Qwen 3.6 35B',
    description: 'Best local model — fast MoE architecture, only 3 B params active per token.',
    downloadSizeGB: 24,
    minRAMGB: 32,
    recommendedRAMGB: 48,
    toolCallingScore: 99,
    contextWindowDefault: 32_000,
    contextWindowMax: 262_000,
    badge: 'recommended',
  },
  {
    id: 'qwen3.5-9b',
    ollamaTag: 'qwen3.5:9b',
    displayName: 'Qwen 3.5 9B',
    description: 'Best tool calling for 16 GB machines — solid all-rounder.',
    downloadSizeGB: 6.6,
    minRAMGB: 16,
    recommendedRAMGB: 24,
    toolCallingScore: 98.5,
    contextWindowDefault: 32_000,
    contextWindowMax: 256_000,
  },
  {
    id: 'qwen3.5-4b',
    ollamaTag: 'qwen3.5:4b',
    displayName: 'Qwen 3.5 4B',
    description: 'Lightweight model that fits on 8–16 GB machines.',
    downloadSizeGB: 3.5,
    minRAMGB: 8,
    recommendedRAMGB: 16,
    toolCallingScore: 97.5,
    contextWindowDefault: 32_000,
    contextWindowMax: 256_000,
    badge: 'lightweight',
  },
  {
    id: 'gemma4-e4b',
    ollamaTag: 'gemma4:e4b',
    displayName: 'Gemma 4 E4B',
    description: 'Strong reasoning model from Google — good for analysis tasks.',
    downloadSizeGB: 3.3,
    minRAMGB: 8,
    recommendedRAMGB: 16,
    toolCallingScore: 88,
    contextWindowDefault: 32_000,
    contextWindowMax: 128_000,
    badge: 'reasoning',
  },
];

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

/**
 * Check whether a model can run on a system with the given total RAM.
 * Uses `minRAMGB` as the threshold.
 */
export function isModelSuitableForSystem(
  entry: LocalModelCatalogEntry,
  totalMemoryGB: number,
): boolean {
  return totalMemoryGB >= entry.minRAMGB;
}

/**
 * Return catalog entries suitable for the given system RAM, sorted by priority:
 *   1. 'recommended' badge first
 *   2. Then by descending toolCallingScore
 */
export function getRecommendedModels(totalMemoryGB: number): LocalModelCatalogEntry[] {
  return LOCAL_MODEL_CATALOG
    .filter((entry) => isModelSuitableForSystem(entry, totalMemoryGB))
    .sort((a, b) => {
      // 'recommended' badge sorts first
      if (a.badge === 'recommended' && b.badge !== 'recommended') return -1;
      if (b.badge === 'recommended' && a.badge !== 'recommended') return 1;
      // Then by tool calling score (descending)
      return (b.toolCallingScore ?? 0) - (a.toolCallingScore ?? 0);
    });
}

/**
 * Look up a catalog entry by its Ollama tag (e.g. `'qwen3.5:14b'`).
 */
export function getCatalogEntryByTag(ollamaTag: string): LocalModelCatalogEntry | undefined {
  return LOCAL_MODEL_CATALOG.find((entry) => entry.ollamaTag === ollamaTag);
}
