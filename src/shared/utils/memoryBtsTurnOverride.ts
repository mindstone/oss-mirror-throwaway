import type { AuxiliaryTurnConfig, SingleModelAuxiliaryTurnConfig } from './auxiliaryTurnConfig';
import { resolveAuxiliaryTurnModelOverrides } from './auxiliaryTurnConfig';
import { resolveBtsModel } from './btsModelResolver';
import { DEFAULT_AUXILIARY_MODEL } from './modelNormalization';
import { decodePrefixed, PROFILE_PREFIX } from './modelChoiceCodec';

type MemoryBtsSettings = Parameters<typeof resolveBtsModel>[0];

export interface MemoryBtsTurnOverride {
  memoryBts: string;
  auxiliaryTurnConfig: SingleModelAuxiliaryTurnConfig;
  modelOverride?: string;
  /**
   * Working-profile override for the memory-update turn.
   * `''` explicitly SUPPRESSES the active working profile so a plain-model BTS
   * turn actually EXECUTES on the configured BTS model (e.g. `gpt-5.4-mini`)
   * rather than inheriting the active working profile's model (e.g. Codex
   * gpt-5.5) — see FOX-3481 Stage 2. A real profile id PINS that profile as the
   * working profile (the `bts-profile` branch, where the user explicitly chose
   * a profile). Required (not optional) for kill-by-construction parity with
   * `thinkingModelOverride`: a future return branch can't silently omit it and
   * thereby revert to inheriting the active working profile.
   */
  workingProfileOverrideId: string;
  /**
   * Memory-update turns are auxiliary background turns that MUST run single-model
   * (no planning leg). `''` explicitly suppresses the thinking model so the turn
   * never inherits the user's global (possibly Claude) thinking model and never
   * spins a planning leg the active provider can't serve (FOX-3481 / REBEL-673).
   * Required (not optional) so a future return branch can't silently re-introduce
   * the inherit-undefined gap.
   */
  thinkingModelOverride: string;
  source: 'bts-model' | 'bts-profile' | 'profile-decode-fallback';
}

export function resolveMemoryBtsTurnOverride(settings: MemoryBtsSettings): MemoryBtsTurnOverride {
  const memoryBts = resolveBtsModel(settings, 'memory');

  if (!memoryBts.startsWith(PROFILE_PREFIX)) {
    const auxiliaryTurnConfig = { mode: 'single_model', model: memoryBts } satisfies AuxiliaryTurnConfig;
    const overrides = resolveAuxiliaryTurnModelOverrides(auxiliaryTurnConfig);
    return {
      memoryBts,
      auxiliaryTurnConfig,
      modelOverride: overrides.modelOverride,
      // '' suppresses the active working profile so the memory turn runs on the
      // configured BTS model, not the active working profile's model (FOX-3481 Stage 2).
      workingProfileOverrideId: overrides.workingProfileOverrideId ?? '',
      thinkingModelOverride: overrides.thinkingModelOverride,
      source: 'bts-model',
    };
  }

  const decoded = decodePrefixed(memoryBts);
  if (decoded?.kind === 'profile' && decoded.profileId) {
    const auxiliaryTurnConfig = { mode: 'single_model', model: memoryBts } satisfies AuxiliaryTurnConfig;
    const overrides = resolveAuxiliaryTurnModelOverrides(auxiliaryTurnConfig);
    return {
      memoryBts,
      auxiliaryTurnConfig,
      modelOverride: overrides.modelOverride,
      workingProfileOverrideId: overrides.workingProfileOverrideId ?? decoded.profileId,
      thinkingModelOverride: overrides.thinkingModelOverride,
      source: 'bts-profile',
    };
  }

  const globalBts = resolveBtsModel(settings);
  const fallbackModel = globalBts.startsWith(PROFILE_PREFIX) ? DEFAULT_AUXILIARY_MODEL : globalBts;
  const auxiliaryTurnConfig = { mode: 'single_model', model: fallbackModel } satisfies AuxiliaryTurnConfig;
  const overrides = resolveAuxiliaryTurnModelOverrides(auxiliaryTurnConfig);
  return {
    memoryBts,
    auxiliaryTurnConfig,
    modelOverride: overrides.modelOverride,
    // '' suppresses the active working profile so the memory turn runs on the
    // resolved fallback BTS model, not the active working profile's model (FOX-3481 Stage 2).
    workingProfileOverrideId: overrides.workingProfileOverrideId ?? '',
    thinkingModelOverride: overrides.thinkingModelOverride,
    source: 'profile-decode-fallback',
  };
}
