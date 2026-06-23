import { describe, expect, it } from 'vitest';

import type { AppSettings } from '@shared/types';
import type { AuxiliaryTurnConfig } from '../auxiliaryTurnConfig';
import {
  createActiveWorkingSingleModelAuxiliaryTurnConfig,
  resolveAuxiliaryTurnModelOverrides,
} from '../auxiliaryTurnConfig';
import { resolveMemoryBtsTurnOverride } from '../memoryBtsTurnOverride';
import { DEFAULT_AUXILIARY_MODEL, resolvePlanModeTarget } from '../modelNormalization';

/**
 * FOX-3481 / REBEL-673 — memory-update turns must be single-model auxiliary turns:
 *   - `thinkingModelOverride: ''` suppresses the thinking model so the turn never
 *     inherits the user's global (possibly Claude) thinking model and spins a
 *     planning leg the active provider can't serve.
 *   - `workingProfileOverrideId: ''` (for plain-model BTS) suppresses the active
 *     working profile so the turn actually executes on the configured BTS model.
 * Both fields are required on the contract (kill-by-construction).
 */
describe('resolveMemoryBtsTurnOverride — single-model suppression contract (FOX-3481)', () => {
  it('plain-model BTS: suppresses thinking + working profile, pins the model', () => {
    const result = resolveMemoryBtsTurnOverride({
      behindTheScenesModel: 'gpt-5.4-mini',
      behindTheScenesOverrides: {},
    });
    expect(result.source).toBe('bts-model');
    expect(result.auxiliaryTurnConfig).toEqual({ mode: 'single_model', model: 'gpt-5.4-mini' });
    expect(result.modelOverride).toBe('gpt-5.4-mini');
    expect(result.thinkingModelOverride).toBe('');
    expect(result.workingProfileOverrideId).toBe('');
  });

  it('profile-encoded BTS: pins the chosen profile, still suppresses thinking', () => {
    const result = resolveMemoryBtsTurnOverride({
      behindTheScenesModel: 'profile:dash-bts',
      behindTheScenesOverrides: {},
    });
    expect(result.source).toBe('bts-profile');
    expect(result.auxiliaryTurnConfig).toEqual({ mode: 'single_model', model: 'profile:dash-bts' });
    expect(result.modelOverride).toBeUndefined();
    expect(result.workingProfileOverrideId).toBe('dash-bts');
    expect(result.thinkingModelOverride).toBe('');
  });

  it('unset BTS (last-resort fallback): suppresses thinking + working profile', () => {
    const result = resolveMemoryBtsTurnOverride({
      behindTheScenesModel: undefined,
      behindTheScenesOverrides: {},
    });
    expect(result.source).toBe('bts-model');
    expect(result.auxiliaryTurnConfig).toEqual({ mode: 'single_model', model: DEFAULT_AUXILIARY_MODEL });
    expect(result.thinkingModelOverride).toBe('');
    expect(result.workingProfileOverrideId).toBe('');
  });

  it('every branch sets both suppression fields (no inherit-undefined gap)', () => {
    const cases = [
      { behindTheScenesModel: 'gpt-5.4-mini', behindTheScenesOverrides: {} },
      { behindTheScenesModel: 'profile:dash-bts', behindTheScenesOverrides: {} },
      { behindTheScenesModel: undefined, behindTheScenesOverrides: {} },
    ];
    for (const settings of cases) {
      const result = resolveMemoryBtsTurnOverride(settings);
      expect(result.auxiliaryTurnConfig.mode).toBe('single_model');
      expect(typeof result.thinkingModelOverride).toBe('string');
      expect(typeof result.workingProfileOverrideId).toBe('string');
    }
  });
});

describe('AuxiliaryTurnConfig — explicit model-decision contract', () => {
  it('requires a mode declaration at compile time', () => {
    const singleModel: AuxiliaryTurnConfig = { mode: 'single_model', model: 'gpt-5.4-mini' };
    const explicitPlanning: AuxiliaryTurnConfig = {
      mode: 'explicit_planning',
      planningModel: 'claude-opus-4-8',
      reason: 'background turn intentionally needs a planning leg',
    };
    const inheritUserSession: AuxiliaryTurnConfig = {
      mode: 'inherit_user_session',
      reason: 'continuation should preserve the user-session model semantics',
    };
    // @ts-expect-error: an auxiliary turn without a declared mode does not compile.
    const missingMode: AuxiliaryTurnConfig = { model: 'gpt-5.4-mini' };

    expect(singleModel.mode).toBe('single_model');
    expect(explicitPlanning.mode).toBe('explicit_planning');
    expect(inheritUserSession.mode).toBe('inherit_user_session');
    expect(missingMode).toEqual({ model: 'gpt-5.4-mini' });
  });

  it('maps single_model declarations to a pinned model with no planning leg', () => {
    expect(resolveAuxiliaryTurnModelOverrides({ mode: 'single_model', model: 'gpt-5.4-mini' }))
      .toEqual({
        modelOverride: 'gpt-5.4-mini',
        workingProfileOverrideId: '',
        thinkingModelOverride: '',
      });
  });

  it('maps profile single_model declarations to a working profile with no planning leg', () => {
    expect(resolveAuxiliaryTurnModelOverrides({ mode: 'single_model', model: 'profile:dash-bts' }))
      .toEqual({
        modelOverride: undefined,
        workingProfileOverrideId: 'dash-bts',
        thinkingModelOverride: '',
      });
  });

  it('maps explicit_planning declarations to an explicit thinking override, never inherit-undefined', () => {
    expect(resolveAuxiliaryTurnModelOverrides({
      mode: 'explicit_planning',
      planningModel: 'claude-opus-4-8',
      reason: 'intentional plan-mode background analysis',
    })).toEqual({ thinkingModelOverride: 'claude-opus-4-8' });
  });

  it('maps inherit_user_session declarations to explicit inheritance for user-session continuations', () => {
    expect(resolveAuxiliaryTurnModelOverrides({
      mode: 'inherit_user_session',
      reason: 'approval re-eval resumes the original user session',
    })).toEqual({
      modelOverride: undefined,
      workingProfileOverrideId: undefined,
      thinkingModelOverride: undefined,
    });
  });

  it('declares active working profile helper turns as single-model profile turns', () => {
    const config = createActiveWorkingSingleModelAuxiliaryTurnConfig({
      models: { model: 'gpt-5.4-mini', workingProfileId: 'codex-working' },
      localModel: {
        profiles: [
          { id: 'codex-working', name: 'Codex', providerType: 'codex', model: 'gpt-5.5' },
        ],
      },
    } as unknown as AppSettings);

    expect(config).toEqual({ mode: 'single_model', model: 'profile:codex-working' });
    expect(resolveAuxiliaryTurnModelOverrides(config)).toEqual({
      modelOverride: undefined,
      workingProfileOverrideId: 'codex-working',
      thinkingModelOverride: '',
    });
  });

  it('declares active working model helper turns without consulting BTS fallback', () => {
    const config = createActiveWorkingSingleModelAuxiliaryTurnConfig({
      activeProvider: 'codex',
      behindTheScenesModel: undefined,
      behindTheScenesOverrides: {},
      models: { model: 'gpt-5.5' },
      localModel: { profiles: [] },
    } as unknown as AppSettings);

    expect(config).toEqual({ mode: 'single_model', model: 'gpt-5.5' });
    expect(resolveAuxiliaryTurnModelOverrides(config)).toEqual({
      modelOverride: 'gpt-5.5',
      workingProfileOverrideId: '',
      thinkingModelOverride: '',
    });
  });
});

/**
 * Characterization of the plan-mode gate the suppression relies on: '' suppresses
 * (single-model), undefined inherits (the pre-fix leak that enabled a Claude
 * planning leg for a Codex user with a Claude thinking model configured).
 */
describe('resolvePlanModeTarget — thinkingModelOverride semantics (FOX-3481 seam)', () => {
  it("'' suppresses plan mode even with a distinct (Claude) thinking model configured", () => {
    const target = resolvePlanModeTarget({
      workingModel: 'gpt-5.4-mini',
      thinkingModelOverride: '',
      thinkingProfileModel: 'claude-opus-4-8',
      settingsThinkingModel: 'claude-opus-4-8',
    });
    expect(target).toBeNull();
  });

  it('undefined inherits a distinct thinking model → plan mode ON (the pre-fix leak)', () => {
    const target = resolvePlanModeTarget({
      workingModel: 'gpt-5.4-mini',
      thinkingModelOverride: undefined,
      thinkingProfileModel: undefined,
      settingsThinkingModel: 'claude-opus-4-8',
    });
    expect(target).not.toBeNull();
  });
});
