import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { DEFAULT_AUXILIARY_MODEL } from '@shared/utils/modelNormalization';
import { resolveMemoryBtsTurnOverride } from '@shared/utils/memoryBtsTurnOverride';

describe('desktop Stage 5 memory BTS turn override', () => {
  it('routes profile-form BTS through workingProfileOverrideId', () => {
    const result = resolveMemoryBtsTurnOverride({
      behindTheScenesModel: 'profile:dash-bts',
      behindTheScenesOverrides: {},
    });

    expect(result).toMatchObject({
      memoryBts: 'profile:dash-bts',
      auxiliaryTurnConfig: { mode: 'single_model', model: 'profile:dash-bts' },
      modelOverride: undefined,
      workingProfileOverrideId: 'dash-bts',
      source: 'bts-profile',
    });
    // FOX-3481 Stage 1: memory turns are single-model — thinking always suppressed.
    expect(result.thinkingModelOverride).toBe('');
  });

  it('keeps bare model BTS as modelOverride and suppresses the working profile', () => {
    const result = resolveMemoryBtsTurnOverride({
      behindTheScenesModel: 'deepseek/deepseek-v4-flash',
      behindTheScenesOverrides: {},
    });

    expect(result).toMatchObject({
      memoryBts: 'deepseek/deepseek-v4-flash',
      auxiliaryTurnConfig: { mode: 'single_model', model: 'deepseek/deepseek-v4-flash' },
      modelOverride: 'deepseek/deepseek-v4-flash',
      source: 'bts-model',
    });
    // FOX-3481 Stage 2: '' suppresses the active working profile so the plain-model
    // BTS turn runs on the configured BTS model, not the inherited working profile.
    expect(result.workingProfileOverrideId).toBe('');
    // FOX-3481 Stage 1: thinking model suppressed (single-model auxiliary turn).
    expect(result.thinkingModelOverride).toBe('');
  });

  it('preserves last-resort fallback when BTS is unset', () => {
    const result = resolveMemoryBtsTurnOverride({
      behindTheScenesModel: undefined,
      behindTheScenesOverrides: {},
    });

    expect(result).toMatchObject({
      memoryBts: DEFAULT_AUXILIARY_MODEL,
      auxiliaryTurnConfig: { mode: 'single_model', model: DEFAULT_AUXILIARY_MODEL },
      modelOverride: DEFAULT_AUXILIARY_MODEL,
      source: 'bts-model',
    });
    // FOX-3481: unset BTS resolves to a plain model → suppress working profile + thinking.
    expect(result.workingProfileOverrideId).toBe('');
    expect(result.thinkingModelOverride).toBe('');
  });

  it('wires desktop memory turns through the profile-aware override helper', () => {
    const source = readFileSync(new URL('../index.ts', import.meta.url), 'utf8');

    expect(source).toContain('const memoryTurnOverride = resolveMemoryBtsTurnOverride(settings);');
    expect(source).toContain('const memoryAuxiliaryOverrides = resolveAuxiliaryTurnModelOverrides(memoryTurnOverride.auxiliaryTurnConfig);');
    expect(source).toContain('modelOverride: memoryAuxiliaryOverrides.modelOverride');
    // FOX-3481 Stage 2: workingProfileOverrideId must be threaded UNCONDITIONALLY so
    // the '' suppress sentinel reaches the executor. A conditional spread
    // (`...(memoryTurnOverride.workingProfileOverrideId ? {...} : {})`) would drop ''
    // and silently inherit the active working profile — assert it's gone.
    expect(source).toContain('workingProfileOverrideId: memoryAuxiliaryOverrides.workingProfileOverrideId');
    expect(source).not.toContain('...(memoryTurnOverride.workingProfileOverrideId');
    // FOX-3481 Stage 1: memory-update turns must thread the (empty-string) thinking-model
    // suppression into agentLoopOptions so they stay single-model and never inherit a
    // Claude thinking model the active provider can't serve. AgentLoopOptions
    // .thinkingModelOverride is optional, so dropping this wiring line would be caught by
    // neither the type system nor the override-contract unit test — this source assertion
    // is the regression tripwire for the god-module wrapper closure.
    expect(source).toContain('thinkingModelOverride: memoryAuxiliaryOverrides.thinkingModelOverride');
    expect(source).not.toContain('thinkingModelOverride: memoryTurnOverride.thinkingModelOverride');
  });
});
