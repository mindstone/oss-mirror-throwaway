/**
 * Inference Strategy Resolution
 *
 * Pure functions that map {model + RAM + context window + Ollama capabilities}
 * to {strategy + effective context + Ollama env vars}. No Electron dependencies.
 *
 * TurboQuant (6× KV cache reduction) is the default when available.
 * Falls back to conservative q4_0 when Ollama version doesn't support it.
 */

import type { InferenceStrategy, LocalModelCatalogEntry, OllamaCapabilities } from './ollamaTypes';
import { OLLAMA_PORT } from './ollamaTypes';

// ---------------------------------------------------------------------------
// Strategy constants
// ---------------------------------------------------------------------------

export const TURBO_QUANT_STRATEGY: InferenceStrategy = {
  id: 'turbo-default',
  label: 'TurboQuant (recommended)',
  kvCacheType: 'turbo3',
  contextMultiplier: 5.0,
  minOllamaVersion: '0.9.8',
  ollamaEnv: {
    OLLAMA_KV_CACHE_TYPE: 'turbo3',
    OLLAMA_NUM_PARALLEL: '1',
  },
};

export const CONSERVATIVE_STRATEGY: InferenceStrategy = {
  id: 'conservative',
  label: 'Standard',
  kvCacheType: 'q4_0',
  contextMultiplier: 1.0,
  ollamaEnv: {
    OLLAMA_KV_CACHE_TYPE: 'q4_0',
    OLLAMA_NUM_PARALLEL: '1',
  },
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Overhead reserved for the OS and other processes (GB). */
const OS_HEADROOM_GB = 4;

/**
 * Simple semver "greater-than-or-equal" comparison.
 * Only handles versions in the form "X.Y.Z".
 */
function semverGte(version: string, minimum: string): boolean {
  const parse = (v: string) => v.split('.').map(Number);
  const [aMaj = 0, aMin = 0, aPat = 0] = parse(version);
  const [bMaj = 0, bMin = 0, bPat = 0] = parse(minimum);
  if (aMaj !== bMaj) return aMaj > bMaj;
  if (aMin !== bMin) return aMin > bMin;
  return aPat >= bPat;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface ResolvedStrategy {
  strategy: InferenceStrategy;
  effectiveContextWindow: number;
  estimatedRAMGB: number;
  ollamaEnv: Record<string, string>;
}

/**
 * Estimate RAM usage for a model at a given context window with a given strategy.
 *
 * Rough formula:
 *   model weights (≈ downloadSizeGB) + KV cache (proportional to context / contextMultiplier) + OS headroom
 *
 * The KV cache cost scales linearly with context window tokens. At 32K context
 * a 14B Q4 model uses ~2-3 GB of KV cache without compression, so we use
 * downloadSizeGB * 0.2 * (contextWindow / 32000) as a rough KV cache estimate
 * then divide by the strategy's contextMultiplier (TurboQuant compresses ~5×).
 */
export function estimateRAMUsage(
  modelEntry: LocalModelCatalogEntry,
  contextWindow: number,
  strategy: InferenceStrategy,
): number {
  const modelWeightsGB = modelEntry.downloadSizeGB;
  const kvCacheBaseGB = modelEntry.downloadSizeGB * 0.2 * (contextWindow / 32_000);
  const kvCacheGB = kvCacheBaseGB / strategy.contextMultiplier;
  return modelWeightsGB + kvCacheGB + OS_HEADROOM_GB;
}

/**
 * Resolve the best inference strategy for the given system and model.
 *
 * 1. Prefer TurboQuant if capabilities support it (or unknown — optimistic default).
 * 2. Fall back to conservative if Ollama version is known and too old.
 * 3. Clamp context window so estimated RAM fits available memory.
 */
export function resolveStrategy(
  totalMemoryGB: number,
  modelEntry: LocalModelCatalogEntry,
  desiredContextWindow: number,
  ollamaCapabilities?: OllamaCapabilities,
): ResolvedStrategy {
  // --- Pick strategy ---
  let strategy: InferenceStrategy;

  if (ollamaCapabilities) {
    const meetsVersion =
      TURBO_QUANT_STRATEGY.minOllamaVersion == null ||
      semverGte(ollamaCapabilities.version, TURBO_QUANT_STRATEGY.minOllamaVersion);
    const supportsTurbo =
      ollamaCapabilities.turboQuantSupported ||
      ollamaCapabilities.kvCacheTypes.includes('turbo3');

    strategy = meetsVersion && supportsTurbo ? TURBO_QUANT_STRATEGY : CONSERVATIVE_STRATEGY;
  } else {
    // Optimistic: assume TurboQuant when capabilities unknown
    strategy = TURBO_QUANT_STRATEGY;
  }

  // --- Clamp context window ---
  const availableForModel = totalMemoryGB - OS_HEADROOM_GB;
  let effectiveContextWindow = Math.min(desiredContextWindow, modelEntry.contextWindowMax);

  // Binary-search-style clamp: reduce context until RAM fits
  while (effectiveContextWindow > modelEntry.contextWindowDefault) {
    const est = estimateRAMUsage(modelEntry, effectiveContextWindow, strategy);
    if (est <= totalMemoryGB) break;
    effectiveContextWindow = Math.max(
      modelEntry.contextWindowDefault,
      Math.floor(effectiveContextWindow * 0.75),
    );
  }

  // If still too much RAM at default context, ensure we don't go below default
  if (availableForModel < modelEntry.downloadSizeGB) {
    effectiveContextWindow = modelEntry.contextWindowDefault;
  }

  const estimatedRAMGB = estimateRAMUsage(modelEntry, effectiveContextWindow, strategy);

  // --- Build Ollama env ---
  const ollamaEnv: Record<string, string> = {
    ...strategy.ollamaEnv,
    OLLAMA_HOST: `127.0.0.1:${OLLAMA_PORT}`,
  };

  return { strategy, effectiveContextWindow, estimatedRAMGB, ollamaEnv };
}
