import { describe, expect, it } from 'vitest';
import {
  CODEX_AUXILIARY_MODEL_OPTIONS,
  CODEX_MAIN_MODEL_OPTIONS,
} from '../codexModels';
import { PROVIDER_PRESETS } from '../modelProviderPresets';
import { OR_MODEL_CATALOG } from '../openRouterModels';
import {
  type CatalogEntry,
  deriveAnthropicCatalog,
  deriveCodexCatalog,
  deriveGeminiCatalog,
  deriveOpenRouterCatalog,
  normalizeModelId,
  PROVIDER_CATALOGS,
} from '../providerCatalogs';
import { MODEL_OPTIONS } from '../../utils/modelNormalization';

describe('normalizeModelId', () => {
  it('strips the [1m] extended-context suffix', () => {
    expect(normalizeModelId('claude-sonnet-4-6[1m]')).toBe('claude-sonnet-4-6');
  });

  it('strips a case-insensitive [1m] suffix', () => {
    expect(normalizeModelId('claude-sonnet-4-6[1M]')).toBe('claude-sonnet-4-6');
  });

  it('lowercases mixed-case input', () => {
    expect(normalizeModelId('Claude-Sonnet-4-6')).toBe('claude-sonnet-4-6');
  });

  it('trims surrounding whitespace', () => {
    expect(normalizeModelId('  claude-sonnet-4-6  ')).toBe('claude-sonnet-4-6');
  });

  it('handles whitespace + mixed case + [1m] together', () => {
    expect(normalizeModelId('  Claude-Sonnet-4-6[1m]  ')).toBe('claude-sonnet-4-6');
  });

  it('is idempotent on already-canonical IDs', () => {
    expect(normalizeModelId('claude-sonnet-4-6')).toBe('claude-sonnet-4-6');
    expect(normalizeModelId(normalizeModelId('Claude-Sonnet-4-6[1m]'))).toBe(
      'claude-sonnet-4-6',
    );
  });
});

describe('deriveAnthropicCatalog', () => {
  const catalog = deriveAnthropicCatalog();

  it('returns the same length as MODEL_OPTIONS', () => {
    expect(catalog.length).toBe(MODEL_OPTIONS.length);
  });

  it('stamps every entry with providerType "anthropic" and routeSurface "api-key"', () => {
    for (const entry of catalog) {
      expect(entry.providerType).toBe('anthropic');
      expect(entry.routeSurface).toBe('api-key');
    }
  });

  it('emits one entry per source MODEL_OPTIONS row, keyed by model id', () => {
    const sourceModels = MODEL_OPTIONS.map(o => normalizeModelId(o.value)).sort();
    const derivedModels = catalog.map(e => e.model).sort();
    expect(derivedModels).toEqual(sourceModels);
  });

  it('strips the [1m] suffix from emitted model IDs', () => {
    for (const entry of catalog) {
      expect(entry.model.endsWith('[1m]')).toBe(false);
    }
  });

  it('preserves isMainModel / isAuxiliaryModel from MODEL_OPTIONS', () => {
    for (const option of MODEL_OPTIONS) {
      const derived = catalog.find(e => e.model === normalizeModelId(option.value));
      expect(derived).toBeDefined();
      expect(derived?.isMainModel).toBe(option.isMainModel);
      expect(derived?.isAuxiliaryModel).toBe(option.isAuxiliaryModel);
    }
  });

  it('marks haiku rows as non-reasoning and other rows as reasoning', () => {
    for (const entry of catalog) {
      const expected = !/haiku/i.test(entry.model);
      expect(entry.reasoning).toBe(expected);
    }
  });

  it('marks every Anthropic entry as JSON and tool-use compatible', () => {
    for (const entry of catalog) {
      expect(entry.jsonSupport).toBe('compatible');
      expect(entry.toolUseSupport).toBe('compatible');
    }
  });
});

describe('deriveCodexCatalog', () => {
  const catalog = deriveCodexCatalog();
  const sourceLength =
    CODEX_MAIN_MODEL_OPTIONS.length + CODEX_AUXILIARY_MODEL_OPTIONS.length;

  it('returns the same length as CODEX_MAIN_MODEL_OPTIONS + CODEX_AUXILIARY_MODEL_OPTIONS', () => {
    expect(catalog.length).toBe(sourceLength);
  });

  it('stamps every entry with providerType "openai" and routeSurface "subscription"', () => {
    for (const entry of catalog) {
      expect(entry.providerType).toBe('openai');
      expect(entry.routeSurface).toBe('subscription');
    }
  });

  it('flags main vs auxiliary entries based on the source array they came from', () => {
    for (const option of CODEX_MAIN_MODEL_OPTIONS) {
      const derived = catalog.find(e => e.model === normalizeModelId(option.value));
      expect(derived?.isMainModel).toBe(true);
      expect(derived?.isAuxiliaryModel).toBe(false);
    }
    for (const option of CODEX_AUXILIARY_MODEL_OPTIONS) {
      const derived = catalog.find(e => e.model === normalizeModelId(option.value));
      expect(derived?.isMainModel).toBe(false);
      expect(derived?.isAuxiliaryModel).toBe(true);
    }
  });

  it('enriches capability fields from PROVIDER_PRESETS.openai.models when available', () => {
    const gpt55 = catalog.find(e => e.model === 'gpt-5.5');
    const gpt55Preset = PROVIDER_PRESETS.openai.models.find(m => m.value === 'gpt-5.5');
    expect(gpt55Preset).toBeDefined();
    expect(gpt55?.contextWindow).toBe(gpt55Preset?.contextWindow);
    expect(gpt55?.maxOutputTokens).toBe(gpt55Preset?.maxOutputTokens);
  });

  it('marks gpt-4.1 family as reasoning:false (matching PROVIDER_PRESETS.openai.models)', () => {
    const gpt41 = catalog.find(e => e.model === 'gpt-4.1');
    expect(gpt41?.reasoning).toBe(false);
  });

  it('marks every Codex entry as JSON and tool-use compatible', () => {
    for (const entry of catalog) {
      expect(entry.jsonSupport).toBe('compatible');
      expect(entry.toolUseSupport).toBe('compatible');
    }
  });
});

describe('deriveGeminiCatalog', () => {
  const catalog = deriveGeminiCatalog();
  const source = PROVIDER_PRESETS.google.models;

  it('returns the same length as PROVIDER_PRESETS.google.models', () => {
    expect(catalog.length).toBe(source.length);
  });

  it('stamps every entry with providerType "google" and routeSurface "api-key"', () => {
    for (const entry of catalog) {
      expect(entry.providerType).toBe('google');
      expect(entry.routeSurface).toBe('api-key');
    }
  });

  it('passes through description / context window / max output / reasoning fields', () => {
    for (const option of source) {
      const derived = catalog.find(e => e.model === normalizeModelId(option.value));
      expect(derived).toBeDefined();
      if (option.description) expect(derived?.description).toBe(option.description);
      if (option.contextWindow !== undefined) {
        expect(derived?.contextWindow).toBe(option.contextWindow);
      }
      if (option.maxOutputTokens !== undefined) {
        expect(derived?.maxOutputTokens).toBe(option.maxOutputTokens);
      }
      if (option.reasoning !== undefined) {
        expect(derived?.reasoning).toBe(option.reasoning);
      }
    }
  });

  it('marks every Gemini entry as JSON and tool-use compatible', () => {
    for (const entry of catalog) {
      expect(entry.jsonSupport).toBe('compatible');
      expect(entry.toolUseSupport).toBe('compatible');
    }
  });
});

describe('deriveOpenRouterCatalog', () => {
  const catalog = deriveOpenRouterCatalog();

  it('returns the same length as OR_MODEL_CATALOG', () => {
    expect(catalog.length).toBe(OR_MODEL_CATALOG.length);
  });

  it('stamps every entry with providerType "openrouter" and routeSurface "pool"', () => {
    for (const entry of catalog) {
      expect(entry.providerType).toBe('openrouter');
      expect(entry.routeSurface).toBe('pool');
    }
  });

  it('preserves OR-format model IDs (`provider/model`)', () => {
    for (const entry of catalog) {
      expect(entry.model).toContain('/');
    }
  });

  it('preserves isMainModel / isAuxiliaryModel / auxiliaryHint from OR_MODEL_CATALOG', () => {
    for (const option of OR_MODEL_CATALOG) {
      const derived = catalog.find(e => e.model === normalizeModelId(option.id));
      expect(derived).toBeDefined();
      expect(derived?.isMainModel).toBe(option.isMainModel);
      expect(derived?.isAuxiliaryModel).toBe(option.isAuxiliaryModel);
      if (option.auxiliaryHint) {
        expect(derived?.auxiliaryHint).toBe(option.auxiliaryHint);
      }
    }
  });

  it('leaves OpenRouter JSON and tool-use support unknown', () => {
    for (const entry of catalog) {
      expect(entry.jsonSupport).toBeUndefined();
      expect(entry.toolUseSupport).toBeUndefined();
    }
  });
});

describe('PROVIDER_CATALOGS shape and freezing', () => {
  it('exposes exactly the four expected provider keys', () => {
    expect(Object.keys(PROVIDER_CATALOGS).sort()).toEqual([
      'anthropic',
      'google',
      'openai',
      'openrouter',
    ]);
  });

  it('matches the per-derive-function output for each provider', () => {
    expect(PROVIDER_CATALOGS.anthropic.length).toBe(deriveAnthropicCatalog().length);
    expect(PROVIDER_CATALOGS.openai.length).toBe(deriveCodexCatalog().length);
    expect(PROVIDER_CATALOGS.google.length).toBe(deriveGeminiCatalog().length);
    expect(PROVIDER_CATALOGS.openrouter.length).toBe(deriveOpenRouterCatalog().length);
  });

  it('freezes the top-level Record', () => {
    expect(Object.isFrozen(PROVIDER_CATALOGS)).toBe(true);
    expect(() => {
      // @ts-expect-error — runtime freeze check, attempt to mutate readonly record
      PROVIDER_CATALOGS.anthropic = [];
    }).toThrow(TypeError);
  });

  it('freezes each provider array', () => {
    for (const key of ['anthropic', 'openai', 'google', 'openrouter'] as const) {
      expect(Object.isFrozen(PROVIDER_CATALOGS[key])).toBe(true);
      expect(() => {
        // @ts-expect-error — runtime freeze check, attempt to push into readonly array
        PROVIDER_CATALOGS[key].push({} as CatalogEntry);
      }).toThrow(TypeError);
    }
  });

  it('freezes individual catalog entries', () => {
    for (const key of ['anthropic', 'openai', 'google', 'openrouter'] as const) {
      const [first] = PROVIDER_CATALOGS[key];
      if (!first) continue;
      expect(Object.isFrozen(first)).toBe(true);
      expect(() => {
        first.label = 'mutated';
      }).toThrow(TypeError);
    }
  });
});

describe('PROVIDER_CATALOGS single source of truth — propagation from sources', () => {
  it('derives every MODEL_OPTIONS row into PROVIDER_CATALOGS.anthropic (no filtering)', () => {
    for (const option of MODEL_OPTIONS) {
      const derived = PROVIDER_CATALOGS.anthropic.find(
        e => e.model === normalizeModelId(option.value),
      );
      expect(derived, `expected MODEL_OPTIONS entry ${option.value} in catalog`).toBeDefined();
    }
  });

  it('derives every CODEX_MAIN_MODEL_OPTIONS row into PROVIDER_CATALOGS.openai with isMainModel=true', () => {
    for (const option of CODEX_MAIN_MODEL_OPTIONS) {
      const derived = PROVIDER_CATALOGS.openai.find(
        e => e.model === normalizeModelId(option.value),
      );
      expect(derived).toBeDefined();
      expect(derived?.isMainModel).toBe(true);
    }
  });

  it('derives every CODEX_AUXILIARY_MODEL_OPTIONS row into PROVIDER_CATALOGS.openai with isAuxiliaryModel=true', () => {
    for (const option of CODEX_AUXILIARY_MODEL_OPTIONS) {
      const derived = PROVIDER_CATALOGS.openai.find(
        e => e.model === normalizeModelId(option.value),
      );
      expect(derived).toBeDefined();
      expect(derived?.isAuxiliaryModel).toBe(true);
    }
  });

  it('derives every PROVIDER_PRESETS.google.models row into PROVIDER_CATALOGS.google', () => {
    for (const option of PROVIDER_PRESETS.google.models) {
      const derived = PROVIDER_CATALOGS.google.find(
        e => e.model === normalizeModelId(option.value),
      );
      expect(derived).toBeDefined();
    }
  });

  it('derives every OR_MODEL_CATALOG row into PROVIDER_CATALOGS.openrouter', () => {
    for (const option of OR_MODEL_CATALOG) {
      const derived = PROVIDER_CATALOGS.openrouter.find(
        e => e.model === normalizeModelId(option.id),
      );
      expect(derived).toBeDefined();
    }
  });
});
