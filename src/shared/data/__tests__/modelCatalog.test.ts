import { describe, it, expect } from 'vitest';
import {
  MODEL_CATALOG,
  type ModelProvider,
  getCatalogPricingMap,
  getCatalogAliasMap,
  getCatalogMigrationMap,
  getCatalogEntryById,
  getExtendedContextModelIds,
  isAlwaysOnThinkingCatalogModel,
  isSamplingParamsForbiddenCatalogModel,
  modelSupportsImageInput,
  normalizeModelId,
} from '../modelCatalog';
import {
  getKnownContextWindowForModel,
  getKnownMaxOutputForModel,
} from '../modelProviderPresets';
import type { ModelProviderType } from '../../types';

describe('modelCatalog', () => {
  describe('MODEL_CATALOG integrity', () => {
    it('should have unique model IDs', () => {
      const ids = MODEL_CATALOG.map(e => e.id);
      expect(new Set(ids).size).toBe(ids.length);
    });

    it('should have no duplicate aliases across entries', () => {
      const seen = new Map<string, string>();
      for (const entry of MODEL_CATALOG) {
        for (const alias of entry.aliases ?? []) {
          const existing = seen.get(alias);
          if (existing) {
            throw new Error(`Alias '${alias}' is used by both '${existing}' and '${entry.id}'`);
          }
          seen.set(alias, entry.id);
        }
      }
    });

    it('should not have alias that matches any model ID', () => {
      const ids = new Set(MODEL_CATALOG.map(e => e.id));
      for (const entry of MODEL_CATALOG) {
        for (const alias of entry.aliases ?? []) {
          if (ids.has(alias)) {
            throw new Error(`Alias '${alias}' on entry '${entry.id}' conflicts with a model ID`);
          }
        }
      }
    });

    it('migratesTo targets should be valid model IDs', () => {
      const ids = new Set(MODEL_CATALOG.map(e => e.id));
      for (const entry of MODEL_CATALOG) {
        if (entry.migratesTo) {
          expect(ids.has(entry.migratesTo), `${entry.id} migratesTo '${entry.migratesTo}' which is not a valid model ID`).toBe(true);
        }
      }
    });

    it('migratesTo targets should not themselves have migratesTo (no chains)', () => {
      const entryById = new Map(MODEL_CATALOG.map(e => [e.id, e]));
      for (const entry of MODEL_CATALOG) {
        if (entry.migratesTo) {
          const target = entryById.get(entry.migratesTo);
          expect(target?.migratesTo, `${entry.id} → ${entry.migratesTo} → ${target?.migratesTo} forms a migration chain`).toBeUndefined();
        }
      }
    });

    it('main model entries should have displayLabel', () => {
      for (const entry of MODEL_CATALOG) {
        if (entry.isMainModel) {
          expect(entry.displayLabel, `Main model '${entry.id}' is missing displayLabel`).toBeTruthy();
        }
      }
    });

    it('should have pricing for every catalog entry', () => {
      for (const entry of MODEL_CATALOG) {
        expect(entry.pricing, `Model '${entry.id}' is missing pricing`).toBeDefined();
      }
    });

    // When adding a main model, update this list per docs/project/NEW_MODEL_SUPPORT_PROCESS.md
    // NOTE: claude-fable-5 is intentionally absent — it is isMainModel:false while
    // Fable access is withdrawn (2026-06). Re-add it here when the catalog entry's
    // flag is restored to true.
    it('main-model roster matches NEW_MODEL_SUPPORT_PROCESS.md expectations', () => {
      const mainModels = MODEL_CATALOG.filter(e => e.isMainModel);
      expect(mainModels.map(e => e.id).sort()).toEqual([
        'claude-haiku-4-5',
        'claude-opus-4-6',
        'claude-opus-4-7',
        'claude-opus-4-8',
        'claude-sonnet-4-6',
      ]);
    });

    it('locks Cohere Command A catalog metadata used by OpenAI-compatible eval routing', () => {
      const entry = getCatalogEntryById('command-a-03-2025');

      expect(entry).toBeDefined();
      expect(entry).toMatchObject({
        id: 'command-a-03-2025',
        provider: 'cohere',
        pricing: {
          input: 2.50,
          output: 10.00,
          cacheRead: 2.50,
          cacheCreation: 2.50,
        },
        presets: {
          contextWindow: 256000,
          maxOutputTokens: 8192,
        },
      });
      expect(entry?.presets?.description).toContain('Cohere Command A');
    });

    it('derives Cohere Command A context and max-output limits from MODEL_CATALOG', () => {
      const entry = getCatalogEntryById('command-a-03-2025');

      expect(entry?.presets?.contextWindow).toBe(256000);
      expect(entry?.presets?.maxOutputTokens).toBe(8192);
      expect(getKnownContextWindowForModel('command-a-03-2025')).toBe(entry?.presets?.contextWindow);
      expect(getKnownMaxOutputForModel('command-a-03-2025')).toBe(entry?.presets?.maxOutputTokens);
    });

    it('derives known model limits for every catalog entry that declares preset limits', () => {
      for (const entry of MODEL_CATALOG) {
        if (entry.presets?.contextWindow !== undefined) {
          expect(
            getKnownContextWindowForModel(entry.id),
            `${entry.id} declares presets.contextWindow but is missing from known context derivation`,
          ).toBe(entry.presets.contextWindow);
        }

        if (entry.presets?.maxOutputTokens !== undefined) {
          expect(
            getKnownMaxOutputForModel(entry.id),
            `${entry.id} declares presets.maxOutputTokens but is missing from known max-output derivation`,
          ).toBe(entry.presets.maxOutputTokens);
        }
      }
    });

    it('keeps catalog and profile provider unions broad enough for OpenAI-compatible providers', () => {
      const catalogProviders = ['cohere', 'together'] satisfies ModelProvider[];
      const profileProviders = ['together', 'other', 'local'] satisfies ModelProviderType[];

      expect(catalogProviders).toEqual(['cohere', 'together']);
      expect(profileProviders).toEqual(['together', 'other', 'local']);
    });
  });

  describe('getCatalogPricingMap', () => {
    it('should return a map with all priced models', () => {
      const pricingMap = getCatalogPricingMap();
      expect(Object.keys(pricingMap).length).toBe(MODEL_CATALOG.length);
    });

    it('should include both Anthropic and third-party models', () => {
      const pricingMap = getCatalogPricingMap();
      expect(pricingMap['claude-sonnet-4-6']).toBeDefined();
      expect(pricingMap['gpt-5.5']).toBeDefined();
      expect(pricingMap['gemini-2.5-flash']).toBeDefined();
    });
  });

  describe('getCatalogAliasMap', () => {
    it('should map all aliases to their canonical IDs', () => {
      const aliasMap = getCatalogAliasMap();
      // Check some known aliases
      expect(aliasMap['claude-opus-4-6-20260205']).toBe('claude-opus-4-6');
      expect(aliasMap['claude-opus-4.7']).toBe('claude-opus-4-7');
      expect(aliasMap['claude-opus-4.6']).toBe('claude-opus-4-6');
      expect(aliasMap['gpt-5.2-codex']).toBe('gpt-5.2');
      expect(aliasMap['gemini-3-flash-preview']).toBe('gemini-3-flash');
      expect(aliasMap['deepseek-r1']).toBe('deepseek-reasoner');
    });
  });

  describe('normalizeModelId', () => {
    it('strips dated suffixes and resolves to canonical IDs', () => {
      expect(normalizeModelId('claude-sonnet-4-5-20250929')).toBe('claude-sonnet-4-5');
      expect(normalizeModelId('openai/gpt-5.5-20260301')).toBe('openai/gpt-5.5');
    });

    it('resolves aliases after normalization and lowercases input', () => {
      expect(normalizeModelId('  CLAUDE-OPUS-4.7  ')).toBe('claude-opus-4-7');
      expect(normalizeModelId('claude-opus-4-6-20260205')).toBe('claude-opus-4-6');
    });
  });

  describe('getCatalogMigrationMap', () => {
    it('should include deprecated model IDs', () => {
      const migrations = getCatalogMigrationMap();
      expect(migrations['claude-sonnet-4-5']).toBe('claude-sonnet-4-6');
      expect(migrations['claude-opus-4-5']).toBe('claude-opus-4-8');
      // opus-4-6 and opus-4-7 are current selectable models — should NOT be in migration map
      expect(migrations['claude-opus-4-6']).toBeUndefined();
      expect(migrations['claude-opus-4-7']).toBeUndefined();
    });

    it('should include aliases of deprecated models', () => {
      const migrations = getCatalogMigrationMap();
      expect(migrations['claude-sonnet-4-5-20250929']).toBe('claude-sonnet-4-6');
      expect(migrations['claude-3-opus-20240229']).toBe('claude-opus-4-8');
    });

    it('should include aliases of current models (normalize snapshots)', () => {
      const migrations = getCatalogMigrationMap();
      expect(migrations['claude-haiku-4-5-20251001']).toBe('claude-haiku-4-5');
      expect(migrations['claude-3-5-haiku-20241022']).toBe('claude-haiku-4-5');
    });

    it('should NOT include non-Anthropic models', () => {
      const migrations = getCatalogMigrationMap();
      expect(migrations['gpt-5.2-codex']).toBeUndefined();
      expect(migrations['gemini-3-flash-preview']).toBeUndefined();
    });
  });

  describe('getCatalogEntryById', () => {
    it('should return entry for known model', () => {
      const entry = getCatalogEntryById('claude-sonnet-4-6');
      expect(entry).toBeDefined();
      expect(entry?.provider).toBe('anthropic');
      expect(entry?.pricing?.input).toBe(3.0);
    });

    it('should return undefined for unknown model', () => {
      expect(getCatalogEntryById('unknown-model')).toBeUndefined();
    });
  });

  describe('getExtendedContextModelIds', () => {
    it('should return models that support extended context', () => {
      const ids = getExtendedContextModelIds();
      expect(ids).toContain('claude-opus-4-7');
      expect(ids).toContain('claude-sonnet-4-6');
      expect(ids).not.toContain('claude-haiku-4-5');
    });
  });

  describe('modelSupportsImageInput', () => {
    it('returns false for every catalogued DeepSeek id (text-only family)', () => {
      const deepseekIds = [
        'deepseek-chat',
        'deepseek-reasoner',
        'deepseek-v4-flash',
        'deepseek/deepseek-v4-pro',
        'deepseek/deepseek-v4-flash', // the incident model (managed default working+BTS)
        'deepseek/deepseek-v3.2',
        'deepseek/deepseek-r1-0528',
        'deepseek-ai/deepseek-v4-pro',
        'deepseek-ai/deepseek-v3.2',
      ];
      for (const id of deepseekIds) {
        expect(modelSupportsImageInput(id), `${id} should be text-only`).toBe(false);
      }
    });

    it('every catalog entry in the deepseek family is explicitly marked text-only (family guard)', () => {
      // DeepSeek has never shipped a vision chat model. The id-list test above
      // enumerates today's 9 entries, so a FUTURE deepseek entry added without
      // `supportsImageInput: false` would silently fail open (404 backstop
      // instead of substitution) on the managed default-model family. This
      // property converts the family fact into a guard; if DeepSeek ever ships
      // a vision model, it fires and forces a conscious catalog decision.
      const deepseekEntries = MODEL_CATALOG.filter((e) => /deepseek/i.test(e.id));
      expect(deepseekEntries.length).toBeGreaterThanOrEqual(9); // non-vacuous
      for (const entry of deepseekEntries) {
        expect(
          entry.supportsImageInput,
          `${entry.id} matches /deepseek/i but lacks supportsImageInput: false — mark it (or update this guard if DeepSeek shipped vision)`,
        ).toBe(false);
      }
    });

    it('resolves aliases to the canonical entry', () => {
      expect(modelSupportsImageInput('deepseek-v3')).toBe(false); // alias of deepseek-chat
      expect(modelSupportsImageInput('deepseek-r1')).toBe(false); // alias of deepseek-reasoner
    });

    it('normalizes case, whitespace, [1m] and date suffixes before lookup', () => {
      expect(modelSupportsImageInput('  DeepSeek-Chat  ')).toBe(false);
      expect(modelSupportsImageInput('deepseek-chat-20260101')).toBe(false);
      // [1m] suffix strip path (vision-capable target)
      expect(modelSupportsImageInput('claude-sonnet-4-6[1m]')).toBe(true);
      // dated snapshot of a vision-capable alias
      expect(modelSupportsImageInput('claude-sonnet-4-5-20250929')).toBe(true);
    });

    it('returns true for vision-capable model families', () => {
      expect(modelSupportsImageInput('claude-opus-4-8')).toBe(true);
      expect(modelSupportsImageInput('gpt-5.5')).toBe(true);
      expect(modelSupportsImageInput('gemini-3.1-pro')).toBe(true);
      expect(modelSupportsImageInput('anthropic/claude-sonnet-4-6')).toBe(true); // OR-routed Claude
    });

    it('resolves openRouter legacyIds to the owning entry (GPT stage-2 review F1)', () => {
      // Legacy OR ids are actively remapped in settings (LEGACY_OR_MODEL_REMAP) but
      // can still reach runAgentLoop as the wire model (subAgentProxyRouting.test.ts
      // pins `deepseek/deepseek-chat-v3-0324` as a real loop model). They must
      // resolve to the owning catalog entry's capability, not fail open.
      expect(modelSupportsImageInput('deepseek/deepseek-chat-v3-0324')).toBe(false); // legacy of deepseek/deepseek-v3.2
      expect(modelSupportsImageInput('deepseek/deepseek-r1')).toBe(false); // legacy of deepseek/deepseek-r1-0528
      // Vision-capable owners are unaffected by construction: the resolver only
      // returns false on an explicit supportsImageInput:false mark, so legacy ids
      // of unmarked entries stay true either way (was fail-open true before).
      expect(modelSupportsImageInput('anthropic/claude-opus-4.8')).toBe(true); // legacy of anthropic/claude-opus-4-8
      expect(modelSupportsImageInput('x-ai/grok-3')).toBe(true); // legacy of x-ai/grok-4.20 (vision)
      // minimax m2.5 is now text-only: the historical catalog entry is marked
      // supportsImageInput:false (canonical entry wins over m2.7's legacyId claim),
      // and m2.7 itself is text-only too. (minimax m3 remains vision-capable.)
      expect(modelSupportsImageInput('minimax/minimax-m2.5')).toBe(false);
      // GLM 5.2 is text-only (input_modalities: ['text']); both the catalog id
      // and OR's canonical slug (its legacyId) must report no image support.
      expect(modelSupportsImageInput('z-ai/glm-5.2')).toBe(false);
      expect(modelSupportsImageInput('z-ai/glm-5.2-20260616')).toBe(false); // canonical slug (legacyId)
    });

    it('marks verified text-only models as supportsImageInput:false (catalog audit 260622)', () => {
      // Cross-checked against OpenRouter `architecture.input_modalities` (for OR
      // and direct models with an OR equivalent) plus provider docs. These models
      // do NOT accept image input; fail-open would have sent them image blocks.
      const textOnly = [
        // GLM family (all text-only; the V variants are not in our catalog)
        'z-ai/glm-5.1', 'z-ai/glm-5-turbo', 'z-ai/glm-5', 'z-ai/glm-4.7', 'z-ai/glm-4.7-flash',
        // MiniMax m2.x (m3 IS vision and stays unmarked)
        'minimax/minimax-m2.7', 'minimax/minimax-m2.5',
        // OpenAI reasoning-minis (no image input)
        'o1-mini', 'o3-mini',
        // Cohere Command A (text only)
        'command-a-03-2025',
        // Cerebras-hosted open models (text only)
        'llama3.1-8b', 'llama-3.3-70b', 'gpt-oss-120b', 'qwen-3-32b',
      ];
      for (const id of textOnly) {
        expect(modelSupportsImageInput(id), `${id} should be text-only`).toBe(false);
      }
      // Guard the genuinely vision-capable neighbours so this audit can't over-reach.
      expect(modelSupportsImageInput('minimax/minimax-m3')).toBe(true);
      expect(modelSupportsImageInput('o3')).toBe(true);
      expect(modelSupportsImageInput('o4-mini')).toBe(true);
    });

    it('canonical catalog entries win over another entry\'s legacyIds claim (GPT stage-4 review F1)', () => {
      // Live collision: minimax/minimax-m2.5 is a historical catalog entry
      // (kept for cost calculation) AND a legacyId of minimax/minimax-m2.7.
      // The resolver consults the canonical entry FIRST (see
      // getCatalogEntryByLegacyOpenRouterId's precedence comment) — different
      // from LEGACY_OR_MODEL_REMAP, which actively rewrites ids in SETTINGS.
      // First confirm the collision still exists so this test is exercising
      // a real case, not vacuously passing.
      const canonical = MODEL_CATALOG.find((e) => e.id === 'minimax/minimax-m2.5');
      const legacyOwner = MODEL_CATALOG.find(
        (e) => e.openRouter?.legacyIds?.includes('minimax/minimax-m2.5'),
      );
      expect(canonical).toBeDefined();
      expect(legacyOwner?.id).toBe('minimax/minimax-m2.7');

      // Precedence is unobservable while both resolve the same way, so pin
      // AGREEMENT for every collision instead: if a future capability mark
      // makes a colliding pair diverge, this fails and forces a conscious
      // decision (mark the canonical/historical entry — the legacyIds owner's
      // mark is NOT consulted for the colliding id).
      const canonicalIds = new Set(MODEL_CATALOG.map((e) => e.id));
      const collisions: string[] = [];
      for (const entry of MODEL_CATALOG) {
        for (const legacyId of entry.openRouter?.legacyIds ?? []) {
          if (!canonicalIds.has(legacyId)) continue;
          collisions.push(legacyId);
          const canonicalEntry = MODEL_CATALOG.find((e) => e.id === legacyId);
          expect(
            canonicalEntry?.supportsImageInput !== false,
            `legacyIds collision '${legacyId}' (owner ${entry.id}): the canonical entry wins the `
            + 'capability lookup, but its supportsImageInput mark disagrees with the legacy owner\'s '
            + `(${entry.id}.supportsImageInput=${String(entry.supportsImageInput)}). Mark both entries `
            + 'consistently, or deliberately update the precedence comment + this test.',
          ).toBe(entry.supportsImageInput !== false);
        }
      }
      expect(collisions).toContain('minimax/minimax-m2.5');
    });

    it('resolves legacyIds case-insensitively (map keys are lowercased — Claude stage-4 review F2)', () => {
      // Lookups arrive via normalizeModelId() (lowercases input) and the
      // legacy map lowercases its keys at build, so neither a mixed-case
      // INPUT nor a future mixed-case legacyIds ENTRY can silently miss and
      // fail open. Property over every catalogued legacyId: casing of the
      // input never changes the answer.
      for (const entry of MODEL_CATALOG) {
        for (const legacyId of entry.openRouter?.legacyIds ?? []) {
          expect(
            modelSupportsImageInput(legacyId.toUpperCase()),
            `uppercase lookup of legacyId '${legacyId}' diverged from its lowercase resolution`,
          ).toBe(modelSupportsImageInput(legacyId));
        }
      }
      // Concrete marked case: a shouty legacy deepseek id still resolves false.
      expect(modelSupportsImageInput('DEEPSEEK/DEEPSEEK-R1')).toBe(false);
      expect(modelSupportsImageInput('DeepSeek/DeepSeek-Chat-V3-0324')).toBe(false);
    });

    it('returns true (fail-open by design) for unknown or unresolvable ids', () => {
      expect(modelSupportsImageInput('some-future-model-9000')).toBe(true);
      expect(modelSupportsImageInput('')).toBe(true);
    });
  });

  // Premium cost-consent predicate (GPT stage-12 review F1): every
  // Fable-shaped spelling a profile or agent-supplied id can carry must
  // resolve to true — a miss here silently re-prices the user's work.
  describe('isAlwaysOnThinkingCatalogModel', () => {
    it.each([
      ['canonical direct id', 'claude-fable-5'],
      ['direct id with [1m] suffix', 'claude-fable-5[1m]'],
      ['dated direct spelling', 'claude-fable-5-20260609'],
      ['case/whitespace variants', '  Claude-Fable-5  '],
      ['OpenRouter id (own catalog row, flag via sdkModel hop)', 'anthropic/claude-fable-5'],
      ['OpenRouter id with [1m] suffix', 'anthropic/claude-fable-5[1m]'],
      ['OpenRouter legacy slug (openRouter.legacyIds, NOT in the alias map)', 'anthropic/claude-5-fable-20260609'],
    ])('returns true for %s (%s)', (_label, id) => {
      expect(isAlwaysOnThinkingCatalogModel(id)).toBe(true);
    });

    it('returns false for non-premium models in all the same spellings', () => {
      expect(isAlwaysOnThinkingCatalogModel('claude-opus-4-8')).toBe(false);
      expect(isAlwaysOnThinkingCatalogModel('claude-opus-4-8[1m]')).toBe(false);
      expect(isAlwaysOnThinkingCatalogModel('anthropic/claude-opus-4-8')).toBe(false);
      expect(isAlwaysOnThinkingCatalogModel('anthropic/claude-opus-4.8')).toBe(false); // legacyId spelling
      expect(isAlwaysOnThinkingCatalogModel('gpt-5.5')).toBe(false);
    });

    it('returns false (fail-closed to non-premium) for unknown or empty ids', () => {
      expect(isAlwaysOnThinkingCatalogModel('some-future-model-9000')).toBe(false);
      expect(isAlwaysOnThinkingCatalogModel('')).toBe(false);
    });

    it('agrees with the catalog flag for every catalogued id and alias (exhaustiveness guard)', () => {
      // For each entry, the expected answer is its own flag OR (via the
      // sdkModel hop) the direct row's flag. Covers every alias and legacyId
      // so a future premium model's spellings are caught by construction.
      for (const entry of MODEL_CATALOG) {
        const direct = entry.openRouter?.sdkModel ? getCatalogEntryById(entry.openRouter.sdkModel) : undefined;
        const expected = entry.thinkingAlwaysOn === true || direct?.thinkingAlwaysOn === true;
        const spellings = [entry.id, ...(entry.aliases ?? []), ...(entry.openRouter?.legacyIds ?? [])];
        for (const spelling of spellings) {
          // Skip spellings owned by a DIFFERENT canonical entry (legacyIds
          // collisions like minimax/minimax-m2.5 — canonical entry wins).
          if (spelling !== entry.id && getCatalogEntryById(spelling)) continue;
          expect(
            isAlwaysOnThinkingCatalogModel(spelling),
            `${spelling} (entry ${entry.id}) should resolve thinkingAlwaysOn=${String(expected)}`,
          ).toBe(expected);
        }
      }
    });
  });

  describe('isSamplingParamsForbiddenCatalogModel', () => {
    it.each([
      ['Fable canonical direct id', 'claude-fable-5'],
      ['Fable OpenRouter id', 'anthropic/claude-fable-5'],
      ['Fable OpenRouter legacy slug', 'anthropic/claude-5-fable-20260609'],
      ['Opus 4.8 canonical direct id', 'claude-opus-4-8'],
      ['Opus 4.8 direct dotted alias', 'claude-opus-4.8'],
      ['Opus 4.8 OpenRouter id', 'anthropic/claude-opus-4-8'],
      ['Opus 4.8 OpenRouter legacy dotted id', 'anthropic/claude-opus-4.8'],
      ['Opus 4.7 canonical direct id', 'claude-opus-4-7'],
      ['Opus 4.7 direct dotted alias', 'claude-opus-4.7'],
      ['Opus 4.7 OpenRouter id', 'anthropic/claude-opus-4-7'],
      ['case/whitespace variants', '  Claude-Opus-4.8  '],
    ])('returns true for %s (%s)', (_label, id) => {
      expect(isSamplingParamsForbiddenCatalogModel(id)).toBe(true);
    });

    it('returns false for models that allow sampling params', () => {
      expect(isSamplingParamsForbiddenCatalogModel('claude-opus-4-6')).toBe(false);
      expect(isSamplingParamsForbiddenCatalogModel('claude-sonnet-4-6')).toBe(false);
      expect(isSamplingParamsForbiddenCatalogModel('claude-haiku-4-5')).toBe(false);
      expect(isSamplingParamsForbiddenCatalogModel('gpt-5.5')).toBe(false);
    });

    it('returns false for unknown or empty ids', () => {
      expect(isSamplingParamsForbiddenCatalogModel('some-future-model-9000')).toBe(false);
      expect(isSamplingParamsForbiddenCatalogModel('')).toBe(false);
    });

    it('agrees with the catalog flag for every catalogued id and alias (exhaustiveness guard)', () => {
      for (const entry of MODEL_CATALOG) {
        const direct = entry.openRouter?.sdkModel ? getCatalogEntryById(entry.openRouter.sdkModel) : undefined;
        const expected =
          entry.samplingParamsForbidden === true ||
          entry.thinkingAlwaysOn === true ||
          direct?.samplingParamsForbidden === true ||
          direct?.thinkingAlwaysOn === true;
        const spellings = [entry.id, ...(entry.aliases ?? []), ...(entry.openRouter?.legacyIds ?? [])];
        for (const spelling of spellings) {
          if (spelling !== entry.id && getCatalogEntryById(spelling)) continue;
          expect(
            isSamplingParamsForbiddenCatalogModel(spelling),
            `${spelling} (entry ${entry.id}) should resolve samplingParamsForbidden=${String(expected)}`,
          ).toBe(expected);
        }
      }
    });
  });
});
