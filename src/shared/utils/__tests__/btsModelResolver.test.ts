import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import {
  resolveBtsModel,
  BTS_TASK_GROUPS,
  BTS_TASK_GROUP_KEYS,
  type BtsTaskGroup,
} from '../btsModelResolver';
import { DEFAULT_AUXILIARY_MODEL } from '../modelNormalization';
import type { AppSettings } from '@shared/types';

describe('resolveBtsModel', () => {
  const btsModel = 'claude-sonnet-4-6';
  let consoleWarnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    consoleWarnSpy.mockRestore();
  });

  it('returns override when category maps to a group with an override', () => {
    const settings = {
      behindTheScenesModel: btsModel,
      behindTheScenesOverrides: { safety: 'claude-opus-4-7' } as Partial<Record<BtsTaskGroup, string>>,
    };
    expect(resolveBtsModel(settings, 'safety')).toBe('claude-opus-4-7');
  });

  it('falls back to behindTheScenesModel when no override for group', () => {
    const settings = {
      behindTheScenesModel: btsModel,
      behindTheScenesOverrides: { memory: 'claude-opus-4-7' } as Partial<Record<BtsTaskGroup, string>>,
    };
    expect(resolveBtsModel(settings, 'safety')).toBe(btsModel);
  });

  it('falls back to DEFAULT_AUXILIARY_MODEL when no BTS model set', () => {
    const settings = {};
    expect(resolveBtsModel(settings)).toBe(DEFAULT_AUXILIARY_MODEL);
  });

  it('falls back to DEFAULT_AUXILIARY_MODEL when BTS model is undefined', () => {
    const settings = { behindTheScenesModel: undefined };
    expect(resolveBtsModel(settings, 'safety')).toBe(DEFAULT_AUXILIARY_MODEL);
  });

  it('unknown category falls through to BTS model', () => {
    const settings = {
      behindTheScenesModel: btsModel,
      behindTheScenesOverrides: { safety: 'claude-opus-4-7' } as Partial<Record<BtsTaskGroup, string>>,
    };
    expect(resolveBtsModel(settings, 'unknownCategory')).toBe(btsModel);
  });

  it('undefined category returns BTS model', () => {
    const settings = { behindTheScenesModel: btsModel };
    expect(resolveBtsModel(settings, undefined)).toBe(btsModel);
  });

  it('empty overrides object treated as no overrides', () => {
    const settings = {
      behindTheScenesModel: btsModel,
      behindTheScenesOverrides: {} as Partial<Record<BtsTaskGroup, string>>,
    };
    expect(resolveBtsModel(settings, 'safety')).toBe(btsModel);
  });

  it('category with no group mapping falls through to BTS model', () => {
    const settings = {
      behindTheScenesModel: btsModel,
      behindTheScenesOverrides: { safety: 'claude-opus-4-7' } as Partial<Record<BtsTaskGroup, string>>,
    };
    // 'autoContinue' is not mapped to any group
    expect(resolveBtsModel(settings, 'autoContinue')).toBe(btsModel);
  });

  it('profile:<id> values work as overrides', () => {
    const settings = {
      behindTheScenesModel: btsModel,
      behindTheScenesOverrides: { safety: 'profile:abc-123' } as Partial<Record<BtsTaskGroup, string>>,
    };
    expect(resolveBtsModel(settings, 'safety')).toBe('profile:abc-123');
  });

  it('foraging override resolves correctly via resolveBtsModel', () => {
    const settings = {
      behindTheScenesModel: btsModel,
      behindTheScenesOverrides: { foraging: 'profile:abc-123' } as Partial<Record<BtsTaskGroup, string>>,
    };
    expect(resolveBtsModel(settings, 'foraging')).toBe('profile:abc-123');
  });

  describe('category-to-group mappings', () => {
    const override = 'claude-opus-4-7';

    it('safety category maps to safety group', () => {
      const settings = {
        behindTheScenesModel: btsModel,
        behindTheScenesOverrides: { safety: override } as Partial<Record<BtsTaskGroup, string>>,
      };
      expect(resolveBtsModel(settings, 'safety')).toBe(override);
    });

    it('archive-safety category maps to safety group', () => {
      const settings = {
        behindTheScenesModel: btsModel,
        behindTheScenesOverrides: { safety: override } as Partial<Record<BtsTaskGroup, string>>,
      };
      expect(resolveBtsModel(settings, 'archive-safety')).toBe(override);
    });

    it('done-safety category maps to safety group', () => {
      const settings = {
        behindTheScenesModel: btsModel,
        behindTheScenesOverrides: { safety: override } as Partial<Record<BtsTaskGroup, string>>,
      };
      expect(resolveBtsModel(settings, 'done-safety')).toBe(override);
    });

    it('memoryWrite category maps to safety group', () => {
      const settings = {
        behindTheScenesModel: btsModel,
        behindTheScenesOverrides: { safety: override } as Partial<Record<BtsTaskGroup, string>>,
      };
      expect(resolveBtsModel(settings, 'memoryWrite')).toBe(override);
    });

    it('memory category maps to memory group', () => {
      const settings = {
        behindTheScenesModel: btsModel,
        behindTheScenesOverrides: { memory: override } as Partial<Record<BtsTaskGroup, string>>,
      };
      expect(resolveBtsModel(settings, 'memory')).toBe(override);
    });

    it('coaching category maps to coaching group', () => {
      const settings = {
        behindTheScenesModel: btsModel,
        behindTheScenesOverrides: { coaching: override } as Partial<Record<BtsTaskGroup, string>>,
      };
      expect(resolveBtsModel(settings, 'coaching')).toBe(override);
    });

    it('meeting-summary category maps to meetings group', () => {
      const settings = {
        behindTheScenesModel: btsModel,
        behindTheScenesOverrides: { meetings: override } as Partial<Record<BtsTaskGroup, string>>,
      };
      expect(resolveBtsModel(settings, 'meeting-summary')).toBe(override);
    });

    it('meeting-qa category maps to meetings group', () => {
      const settings = {
        behindTheScenesModel: btsModel,
        behindTheScenesOverrides: { meetings: override } as Partial<Record<BtsTaskGroup, string>>,
      };
      expect(resolveBtsModel(settings, 'meeting-qa')).toBe(override);
    });

    it('foraging category maps to foraging group', () => {
      const settings = {
        behindTheScenesModel: btsModel,
        behindTheScenesOverrides: { foraging: override } as Partial<Record<BtsTaskGroup, string>>,
      };
      expect(resolveBtsModel(settings, 'foraging')).toBe(override);
    });
  });

  it('partially filled overrides — set groups resolve, unset groups fall back', () => {
    const settings = {
      behindTheScenesModel: btsModel,
      behindTheScenesOverrides: {
        safety: 'claude-opus-4-7',
        meetings: 'profile:meeting-model',
      } as Partial<Record<BtsTaskGroup, string>>,
    };
    // Set groups resolve to their override
    expect(resolveBtsModel(settings, 'safety')).toBe('claude-opus-4-7');
    expect(resolveBtsModel(settings, 'meeting-summary')).toBe('profile:meeting-model');
    // Unset groups fall back to BTS model
    expect(resolveBtsModel(settings, 'memory')).toBe(btsModel);
    expect(resolveBtsModel(settings, 'coaching')).toBe(btsModel);
  });

  it('empty string override is treated as no override (falsy)', () => {
    const settings = {
      behindTheScenesModel: btsModel,
      behindTheScenesOverrides: { safety: '' } as Partial<Record<BtsTaskGroup, string>>,
    };
    expect(resolveBtsModel(settings, 'safety')).toBe(btsModel);
  });

  describe('Stage 10 tier-aware last-resort', () => {
    const dashWorkingModel = 'deepseek/deepseek-v4-flash';
    const mindstoneBtsModel = 'claude-sonnet-4-6';
    const overrideModel = 'claude-opus-4-7';
    const makeModels = (model: string): AppSettings['models'] => ({ model } as AppSettings['models']);

    it('returns the working model for Mindstone when BTS and per-category overrides are unset', () => {
      expect(resolveBtsModel({
        activeProvider: 'mindstone',
        models: makeModels(dashWorkingModel),
      })).toBe(dashWorkingModel);
    });

    it('falls back to DEFAULT_AUXILIARY_MODEL for Mindstone when the working model is unset', () => {
      expect(resolveBtsModel({
        activeProvider: 'mindstone',
        models: {} as AppSettings['models'],
      })).toBe(DEFAULT_AUXILIARY_MODEL);
    });

    it('falls back to DEFAULT_AUXILIARY_MODEL for Mindstone when the working model is empty or whitespace', () => {
      expect(resolveBtsModel({
        activeProvider: 'mindstone',
        models: makeModels(''),
      })).toBe(DEFAULT_AUXILIARY_MODEL);
      expect(resolveBtsModel({
        activeProvider: 'mindstone',
        models: makeModels('   '),
      })).toBe(DEFAULT_AUXILIARY_MODEL);
    });

    it('keeps DEFAULT_AUXILIARY_MODEL for Anthropic when BTS is unset and a working model is set', () => {
      expect(resolveBtsModel({
        activeProvider: 'anthropic',
        models: makeModels(dashWorkingModel),
      })).toBe(DEFAULT_AUXILIARY_MODEL);
    });

    it('keeps DEFAULT_AUXILIARY_MODEL for Codex when BTS is unset and a working model is set', () => {
      expect(resolveBtsModel({
        activeProvider: 'codex',
        models: makeModels(dashWorkingModel),
      })).toBe(DEFAULT_AUXILIARY_MODEL);
    });

    it('returns the BTS-set valid bare model for Mindstone before reaching last-resort', () => {
      expect(resolveBtsModel({
        activeProvider: 'mindstone',
        behindTheScenesModel: mindstoneBtsModel,
        models: makeModels(dashWorkingModel),
      })).toBe(mindstoneBtsModel);
    });

    it('returns the per-category override for Mindstone when BTS and override are both set', () => {
      expect(resolveBtsModel({
        activeProvider: 'mindstone',
        behindTheScenesModel: mindstoneBtsModel,
        behindTheScenesOverrides: { safety: overrideModel } as Partial<Record<BtsTaskGroup, string>>,
        models: makeModels(dashWorkingModel),
      }, 'safety')).toBe(overrideModel);
    });

    it('returns the per-category override for Mindstone when BTS is unset and category is passed', () => {
      expect(resolveBtsModel({
        activeProvider: 'mindstone',
        behindTheScenesOverrides: { safety: overrideModel } as Partial<Record<BtsTaskGroup, string>>,
        models: makeModels(dashWorkingModel),
      }, 'safety')).toBe(overrideModel);
    });

    it('uses the working model for Mindstone when an override exists but no category is passed', () => {
      expect(resolveBtsModel({
        activeProvider: 'mindstone',
        behindTheScenesOverrides: { safety: overrideModel } as Partial<Record<BtsTaskGroup, string>>,
        models: makeModels(dashWorkingModel),
      })).toBe(dashWorkingModel);
    });
  });

  describe('model: prefix decoding (codec round-trip)', () => {
    // Tracks `modelChoiceCodec.encodePrefixed` which writes `model:<id>` for explicit
    // ModelChoice picks. Without symmetric read-path stripping, the literal
    // `'model:<id>'` string flowed through to the wire (Sentry REBEL-5EZ /
    // 7465697085) and produced provider 400s such as
    // `The 'model:gpt-5.4-mini' model is not supported when using Codex with a ChatGPT account.`

    it('strips the model: prefix from behindTheScenesModel before returning', () => {
      const settings = { behindTheScenesModel: 'model:claude-haiku-4-5' };
      expect(resolveBtsModel(settings)).toBe('claude-haiku-4-5');
    });

    it('strips the model: prefix from OpenRouter-shape prefixed ids', () => {
      const settings = { behindTheScenesModel: 'model:anthropic/claude-haiku-4-5' };
      expect(resolveBtsModel(settings)).toBe('anthropic/claude-haiku-4-5');
    });

    it('strips the model: prefix from a Codex-shape OpenAI id', () => {
      const settings = { behindTheScenesModel: 'model:gpt-5.4-mini' };
      expect(resolveBtsModel(settings)).toBe('gpt-5.4-mini');
    });

    it('preserves profile: prefix as-is so downstream resolvers can route it', () => {
      const settings = { behindTheScenesModel: 'profile:abc-123' };
      expect(resolveBtsModel(settings)).toBe('profile:abc-123');
    });

    it('strips the model: prefix from per-task overrides', () => {
      const settings = {
        behindTheScenesModel: 'claude-haiku-4-5',
        behindTheScenesOverrides: { safety: 'model:claude-opus-4-7' } as Partial<Record<BtsTaskGroup, string>>,
      };
      expect(resolveBtsModel(settings, 'safety')).toBe('claude-opus-4-7');
    });

    it('strips the model: prefix when both global and override are prefixed', () => {
      const settings = {
        behindTheScenesModel: 'model:claude-haiku-4-5',
        behindTheScenesOverrides: { memory: 'model:gpt-5.4-mini' } as Partial<Record<BtsTaskGroup, string>>,
      };
      expect(resolveBtsModel(settings, 'memory')).toBe('gpt-5.4-mini');
      expect(resolveBtsModel(settings)).toBe('claude-haiku-4-5');
    });

    it('falls through to global BTS when override is empty-after-strip (raw "model:")', () => {
      const settings = {
        behindTheScenesModel: 'claude-haiku-4-5',
        behindTheScenesOverrides: { safety: 'model:' } as Partial<Record<BtsTaskGroup, string>>,
      };
      expect(resolveBtsModel(settings, 'safety')).toBe('claude-haiku-4-5');
      expect(consoleWarnSpy).toHaveBeenCalledWith(
        '[resolveBtsModel] btsModelResolver:resolveBtsModel:override rejected by normalizer: empty model id; falling through to global',
        {
          siteId: 'btsModelResolver:resolveBtsModel:override',
          rawTruncated: 'model:',
          rejectionReason: 'empty-model-id',
        },
      );
    });

    it('falls back to DEFAULT_AUXILIARY_MODEL when global BTS is empty-after-strip (raw "model:")', () => {
      const settings = { behindTheScenesModel: 'model:' };
      expect(resolveBtsModel(settings)).toBe(DEFAULT_AUXILIARY_MODEL);
      expect(consoleWarnSpy).toHaveBeenCalledWith(
        '[resolveBtsModel] btsModelResolver:resolveBtsModel:global rejected by normalizer: empty model id; falling through to default',
        {
          siteId: 'btsModelResolver:resolveBtsModel:global',
          rawTruncated: 'model:',
          rejectionReason: 'empty-model-id',
        },
      );
    });

    it('falls through to global BTS when override has an empty profile id', () => {
      const settings = {
        behindTheScenesModel: 'claude-haiku-4-5',
        behindTheScenesOverrides: { safety: 'profile:' } as Partial<Record<BtsTaskGroup, string>>,
      };
      expect(resolveBtsModel(settings, 'safety')).toBe('claude-haiku-4-5');
      expect(consoleWarnSpy).toHaveBeenCalledWith(
        '[resolveBtsModel] btsModelResolver:resolveBtsModel:override rejected by normalizer: empty profile id; falling through to global',
        {
          siteId: 'btsModelResolver:resolveBtsModel:override',
          rawTruncated: 'profile:',
          rejectionReason: 'empty-profile-id',
        },
      );
    });

    it('falls back to DEFAULT_AUXILIARY_MODEL when global BTS is whitespace-only', () => {
      const settings = { behindTheScenesModel: '   ' };
      expect(resolveBtsModel(settings)).toBe(DEFAULT_AUXILIARY_MODEL);
      expect(consoleWarnSpy).toHaveBeenCalledWith(
        '[resolveBtsModel] btsModelResolver:resolveBtsModel:global rejected by normalizer: empty or whitespace input; falling through to default',
        {
          siteId: 'btsModelResolver:resolveBtsModel:global',
          rawTruncated: '   ',
          rejectionReason: 'empty-or-whitespace',
        },
      );
    });

    it('falls back to DEFAULT_AUXILIARY_MODEL and warns when global BTS is a non-string runtime value', () => {
      const settings = { behindTheScenesModel: 42 } as unknown as Parameters<typeof resolveBtsModel>[0];
      expect(resolveBtsModel(settings)).toBe(DEFAULT_AUXILIARY_MODEL);
      expect(consoleWarnSpy).toHaveBeenCalledWith(
        '[resolveBtsModel] btsModelResolver:resolveBtsModel:global rejected non-string input by normalizer: invalid type (not a string); falling through to default',
        {
          siteId: 'btsModelResolver:resolveBtsModel:global',
          rawType: 'number',
          rejectionReason: 'invalid-type',
        },
      );
    });

    it('falls through to global BTS and warns when override is a non-string runtime value', () => {
      const settings = {
        behindTheScenesModel: 'claude-haiku-4-5',
        behindTheScenesOverrides: { safety: 42 },
      } as unknown as Parameters<typeof resolveBtsModel>[0];
      expect(resolveBtsModel(settings, 'safety')).toBe('claude-haiku-4-5');
      expect(consoleWarnSpy).toHaveBeenCalledWith(
        '[resolveBtsModel] btsModelResolver:resolveBtsModel:override rejected non-string input by normalizer: invalid type (not a string); falling through to global',
        {
          siteId: 'btsModelResolver:resolveBtsModel:override',
          rawType: 'number',
          rejectionReason: 'invalid-type',
        },
      );
    });

    it('does NOT strip a prefix that only looks like the codec prefix (e.g. "modelX:")', () => {
      const settings = { behindTheScenesModel: 'modelX:something' };
      expect(resolveBtsModel(settings)).toBe('modelX:something');
    });
  });
});

describe('BTS_TASK_GROUPS', () => {
  it('all group keys have label and description', () => {
    for (const key of BTS_TASK_GROUP_KEYS) {
      const group = BTS_TASK_GROUPS[key];
      expect(group).toBeDefined();
      expect(group.label).toBeTruthy();
      expect(group.description).toBeTruthy();
    }
  });

  it('BTS_TASK_GROUP_KEYS matches BTS_TASK_GROUPS keys', () => {
    const groupKeys = Object.keys(BTS_TASK_GROUPS).sort();
    const exportedKeys = [...BTS_TASK_GROUP_KEYS].sort();
    expect(exportedKeys).toEqual(groupKeys);
  });

  it('contains exactly the expected groups', () => {
    expect(BTS_TASK_GROUP_KEYS).toEqual(
      expect.arrayContaining(['safety', 'memory', 'coaching', 'meetings', 'improvement', 'hero-choice', 'search', 'foraging'])
    );
    expect(BTS_TASK_GROUP_KEYS).toHaveLength(8);
  });
});
