/**
 * Model Limits — OpenRouter Model ID Normalization Tests
 *
 * Verifies that thinking config and effort resolution work correctly for
 * OpenRouter-format model IDs (anthropic/claude-*) in addition to native
 * Anthropic SDK format (claude-*).
 *
 * Regression test for REBEL-4B9: OpenRouter Claude models silently lost
 * thinking and effort because modelLimits only checked for claude-* prefix.
 */

import { describe, it, expect, vi } from 'vitest';
import { getCatalogEntryById, MODEL_CATALOG } from '@shared/data/modelCatalog';
import { getSystemRole } from '../clients/openaiTranslators';
import {
  isAlwaysOnThinkingModel,
  isExtendedContextModel,
  normalizeForCapabilityCheck,
  resolveThinkingConfig,
  resolveEffortForApi,
  resolveModelLimits,
  supportsCompact,
  supportsEffort,
  supportsMaxEffort,
} from '../modelLimits';

vi.mock('@core/logger', () => ({
  createScopedLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

interface CapabilitySnapshot {
  supportsCompact: boolean;
  supportsMaxEffort: boolean;
  isExtendedContextModel: boolean;
  supportsEffort: boolean;
}

function capabilitySnapshot(model: string): CapabilitySnapshot {
  return {
    supportsCompact: supportsCompact(model),
    supportsMaxEffort: supportsMaxEffort(model),
    isExtendedContextModel: isExtendedContextModel(normalizeForCapabilityCheck(model)),
    supportsEffort: supportsEffort(model),
  };
}

function buildVariantForms(baseModel: string): string[] {
  const forms = new Set<string>();
  const maybeDotted = /^claude-/i.test(baseModel)
    ? baseModel.replace(/(\d)-(\d)(?=[^-]*$)/, '$1.$2')
    : baseModel;
  const roots = [baseModel, maybeDotted];
  for (const root of roots) {
    forms.add(root);
    forms.add(`${root}[1m]`);
    forms.add(`anthropic/${root}`);
    forms.add(`${root}-20250430`);
    forms.add(`anthropic/${root}[1m]`);
    forms.add(`anthropic/${root}-20250430`);
    forms.add(`${root}-20250430[1m]`);
    forms.add(`anthropic/${root}-20250430[1m]`);
  }
  return [...forms];
}

describe('model capability invariant baseline — pre-refactor behavior lock', () => {
  const CASES: Array<{ baseModel: string; expected: CapabilitySnapshot }> = [
    {
      // supportsEffort: true via the Stage 2 catalog-driven short-circuit
      // (supportsMaxEffort ⇒ supportsEffort); the family regex alone would
      // miss fable. See docs/plans/260611_fable-5-support/PLAN.md Stage 2.
      baseModel: 'claude-fable-5',
      expected: { supportsCompact: true, supportsMaxEffort: true, isExtendedContextModel: true, supportsEffort: true },
    },
    {
      baseModel: 'claude-opus-4-7',
      expected: { supportsCompact: true, supportsMaxEffort: true, isExtendedContextModel: true, supportsEffort: true },
    },
    {
      baseModel: 'claude-opus-4-6',
      expected: { supportsCompact: true, supportsMaxEffort: true, isExtendedContextModel: true, supportsEffort: true },
    },
    {
      baseModel: 'claude-sonnet-4-6',
      expected: { supportsCompact: true, supportsMaxEffort: false, isExtendedContextModel: true, supportsEffort: true },
    },
    {
      // Now rostered in MODEL_CATALOG with full capability flags (was previously
      // an uncatalogued model exercising the legacy-regex fallback).
      baseModel: 'claude-opus-4-8',
      expected: { supportsCompact: true, supportsMaxEffort: true, isExtendedContextModel: true, supportsEffort: true },
    },
    {
      baseModel: 'claude-haiku-4-5',
      expected: { supportsCompact: false, supportsMaxEffort: false, isExtendedContextModel: false, supportsEffort: false },
    },
    {
      baseModel: 'claude-sonnet-4-5',
      expected: { supportsCompact: false, supportsMaxEffort: false, isExtendedContextModel: false, supportsEffort: true },
    },
    {
      baseModel: 'claude-opus-4-5',
      expected: { supportsCompact: false, supportsMaxEffort: false, isExtendedContextModel: false, supportsEffort: true },
    },
    {
      baseModel: 'claude-sonnet-3-7',
      expected: { supportsCompact: false, supportsMaxEffort: false, isExtendedContextModel: false, supportsEffort: true },
    },
    {
      baseModel: 'gpt-5.5',
      expected: { supportsCompact: false, supportsMaxEffort: false, isExtendedContextModel: false, supportsEffort: true },
    },
    {
      baseModel: 'gemini-2.5-pro',
      expected: { supportsCompact: false, supportsMaxEffort: false, isExtendedContextModel: false, supportsEffort: true },
    },
    {
      baseModel: 'unknown-model-id',
      expected: { supportsCompact: false, supportsMaxEffort: false, isExtendedContextModel: false, supportsEffort: false },
    },
  ];

  it.each(CASES)('locks current gate outputs for $baseModel across variant forms', ({ baseModel, expected }) => {
    for (const model of buildVariantForms(baseModel)) {
      expect(capabilitySnapshot(model), model).toEqual(expected);
    }
  });
});

describe('model capability drift guard — catalog capability flags', () => {
  it.each([
    ['claude-fable-5', { supportsCompact: true, supportsMaxEffort: true, supportsExtendedContext: true }],
    ['claude-opus-4-8', { supportsCompact: true, supportsMaxEffort: true, supportsExtendedContext: true }],
    ['claude-opus-4-7', { supportsCompact: true, supportsMaxEffort: true, supportsExtendedContext: true }],
    ['claude-opus-4-6', { supportsCompact: true, supportsMaxEffort: true, supportsExtendedContext: true }],
    ['claude-sonnet-4-6', { supportsCompact: true, supportsMaxEffort: false, supportsExtendedContext: true }],
    ['claude-haiku-4-5', { supportsCompact: false, supportsMaxEffort: false, supportsExtendedContext: false }],
    ['claude-sonnet-4-5', { supportsCompact: false, supportsMaxEffort: false, supportsExtendedContext: false }],
    ['claude-opus-4-5', { supportsCompact: false, supportsMaxEffort: false, supportsExtendedContext: false }],
  ] as const)('locks capability flags for %s', (modelId, expected) => {
    const entry = getCatalogEntryById(modelId);
    expect(entry).toBeDefined();
    expect({
      supportsCompact: entry?.supportsCompact ?? false,
      supportsMaxEffort: entry?.supportsMaxEffort ?? false,
      supportsExtendedContext: entry?.supportsExtendedContext ?? false,
    }).toEqual(expected);
  });

  it('rostering a brand-new catalog entry (synthetic claude-opus-fake) drives the gates to true', async () => {
    // Uses a permanently-synthetic id (`claude-opus-fake`, never a real model) so
    // this locks the "a freshly-added catalog entry's capability flags beat the
    // legacy regex fallback" mechanism without duplicating any real catalog entry
    // — and without needing an update each time a real Opus version ships.
    vi.resetModules();
    const catalogModule = await import('@shared/data/modelCatalog');
    const modelLimitsModule = await import('../modelLimits');

    // NOTE: push BEFORE the first capability call — getCatalogEntryById lazily
    // builds and caches its id→entry Map on first use, so a push after that
    // first call would be invisible (would fall through to the legacy regex).
    (catalogModule.MODEL_CATALOG as unknown as Array<Record<string, unknown>>).push({
      id: 'claude-opus-fake',
      provider: 'anthropic',
      pricing: { input: 5.0, output: 25.0, cacheRead: 0.50, cacheCreation: 6.25 },
      supportsCompact: true,
      supportsMaxEffort: true,
      supportsExtendedContext: true,
    });

    expect(modelLimitsModule.supportsCompact('claude-opus-fake')).toBe(true);
    expect(modelLimitsModule.supportsMaxEffort('claude-opus-fake')).toBe(true);
    expect(modelLimitsModule.isExtendedContextModel('claude-opus-fake')).toBe(true);

    (catalogModule.MODEL_CATALOG as unknown as Array<Record<string, unknown>>).pop();
    vi.resetModules();
  });
});

describe('supportsEffort behavior lock', () => {
  it.each([
    ['claude-sonnet-3-7', true],
    ['claude-opus-4-7', true],
    // Fable 5: no opus/sonnet regex match — true comes from the catalog-driven
    // supportsMaxEffort short-circuit (Stage 2, docs/plans/260611_fable-5-support).
    ['claude-fable-5', true],
    ['claude-haiku-4-5', false],
    ['anthropic/claude-sonnet-3.7', true],
    ['gpt-5.5', true],
    ['o4-mini', true],
    ['gemini-2.5-pro', true],
    ['gemini-2.5-flash-lite', false],
    ['unknown-model-id', false],
  ])('locks current supportsEffort breadth for %s', (model, expected) => {
    expect(supportsEffort(model)).toBe(expected);
  });
});

describe('resolveThinkingConfig — OpenRouter model IDs', () => {
  it('returns adaptive for anthropic/claude-opus-4.7 with high effort', () => {
    const result = resolveThinkingConfig('high', 'anthropic/claude-opus-4.7', 128_000);
    expect(result).toEqual({ type: 'adaptive' });
  });

  it('returns adaptive for anthropic/claude-opus-4-7 with xhigh effort', () => {
    const result = resolveThinkingConfig('xhigh', 'anthropic/claude-opus-4-7-20250603', 128_000);
    expect(result).toEqual({ type: 'adaptive' });
  });

  it('returns enabled with budget for anthropic/claude-sonnet-4-6', () => {
    const result = resolveThinkingConfig('high', 'anthropic/claude-sonnet-4-6-20250514', 64_000);
    expect(result.type).toBe('enabled');
    if (result.type === 'enabled') {
      expect(result.budget_tokens).toBeGreaterThan(0);
    }
  });

  it('returns disabled for low effort regardless of model', () => {
    const result = resolveThinkingConfig('low', 'anthropic/claude-opus-4-7', 128_000);
    expect(result).toEqual({ type: 'disabled' });
  });

  it('returns disabled for non-Claude OR models', () => {
    const result = resolveThinkingConfig('high', 'openai/gpt-5.4', 32_000);
    expect(result).toEqual({ type: 'disabled' });
  });

  it('matches native SDK format (baseline)', () => {
    const orResult = resolveThinkingConfig('high', 'anthropic/claude-opus-4-7-20250603', 128_000);
    const nativeResult = resolveThinkingConfig('high', 'claude-opus-4-7-20250603', 128_000);
    expect(orResult).toEqual(nativeResult);
  });
});

describe('resolveEffortForApi — OpenRouter model IDs', () => {
  it('returns max for anthropic/claude-opus-4-7 with xhigh', () => {
    const result = resolveEffortForApi('xhigh', 'anthropic/claude-opus-4-7-20250603');
    expect(result).toBe('max');
  });

  it('returns high for anthropic/claude-opus-4-7 with high effort', () => {
    const result = resolveEffortForApi('high', 'anthropic/claude-opus-4-7');
    expect(result).toBe('high');
  });

  it('returns high for anthropic/claude-sonnet-4-6 with high effort', () => {
    const result = resolveEffortForApi('high', 'anthropic/claude-sonnet-4-6-20250514');
    expect(result).toBe('high');
  });

  it('returns effort for OpenAI reasoning models via OpenRouter', () => {
    expect(resolveEffortForApi('high', 'openai/gpt-5.4')).toBe('high');
    expect(resolveEffortForApi('low', 'openai/gpt-5.5')).toBe('low');
  });

  it('returns undefined for non-reasoning OR models', () => {
    expect(resolveEffortForApi('high', 'openai/gpt-4.1')).toBeUndefined();
    expect(resolveEffortForApi('high', 'minimax/minimax-m2.7')).toBeUndefined();
  });

  it('matches native SDK format (baseline)', () => {
    const orResult = resolveEffortForApi('xhigh', 'anthropic/claude-opus-4-7-20250603');
    const nativeResult = resolveEffortForApi('xhigh', 'claude-opus-4-7-20250603');
    expect(orResult).toBe(nativeResult);
  });

  // Non-Claude reasoning models
  it('supports effort for direct OpenAI reasoning models', () => {
    expect(resolveEffortForApi('medium', 'gpt-5.5')).toBe('medium');
    expect(resolveEffortForApi('high', 'gpt-5.4-mini')).toBe('high');
    expect(resolveEffortForApi('low', 'gpt-5-nano')).toBe('low');
  });

  it('supports effort for o-series models', () => {
    expect(resolveEffortForApi('high', 'o3')).toBe('high');
    expect(resolveEffortForApi('medium', 'o4-mini')).toBe('medium');
  });

  it('supports effort for Gemini reasoning models', () => {
    expect(resolveEffortForApi('high', 'gemini-2.5-pro')).toBe('high');
    expect(resolveEffortForApi('medium', 'gemini-3-flash-preview')).toBe('medium');
    expect(resolveEffortForApi('high', 'google/gemini-2.5-flash')).toBe('high');
  });

  it('returns undefined for non-reasoning models', () => {
    expect(resolveEffortForApi('high', 'gpt-4.1')).toBeUndefined();
    expect(resolveEffortForApi('high', 'gpt-4.1-mini')).toBeUndefined();
    expect(resolveEffortForApi('high', 'gemini-2.5-flash-lite')).toBeUndefined();
    expect(resolveEffortForApi('high', 'llama-3.3-70b')).toBeUndefined();
  });

  it('maps xhigh to high for non-Claude models (no max support)', () => {
    expect(resolveEffortForApi('xhigh', 'gpt-5.5')).toBe('high');
    expect(resolveEffortForApi('xhigh', 'gemini-2.5-pro')).toBe('high');
  });
});

describe('effort + thinking routing for catalog-flagged models — Fable 5 (Stage 2)', () => {
  // Stage 2 of docs/plans/260611_fable-5-support/PLAN.md: supportsEffort() derives
  // from the supportsMaxEffort catalog flag (a model supporting effort:max
  // necessarily supports effort), so user effort settings reach the wire for
  // fable instead of being silently dropped by the opus/sonnet family regex.
  it('sends effort for claude-fable-5 (xhigh→max, high, medium)', () => {
    expect(resolveEffortForApi('xhigh', 'claude-fable-5')).toBe('max');
    expect(resolveEffortForApi('high', 'claude-fable-5')).toBe('high');
    expect(resolveEffortForApi('medium', 'claude-fable-5')).toBe('medium');
  });

  it('sends effort for OpenRouter and [1m]-suffixed fable forms', () => {
    expect(resolveEffortForApi('xhigh', 'anthropic/claude-fable-5')).toBe('max');
    expect(resolveEffortForApi('high', 'claude-fable-5[1m]')).toBe('high');
    expect(resolveEffortForApi('medium', 'anthropic/claude-fable-5[1m]')).toBe('medium');
  });

  it('resolves adaptive thinking (with summarized display — Stage 5) for all fable variant forms', () => {
    for (const model of ['claude-fable-5', 'anthropic/claude-fable-5', 'claude-fable-5[1m]']) {
      expect(resolveThinkingConfig('high', model, 128_000), model).toEqual({
        type: 'adaptive',
        display: 'summarized',
      });
    }
  });

  it('preserves behavior for currently-rostered families (refactor invariant 1)', () => {
    // The supportsMaxEffort short-circuit must change nothing for models the
    // family regexes already cover; only fable flips. (Broader variant-form
    // coverage lives in the pre-refactor behavior-lock CASES above.)
    expect(resolveEffortForApi('xhigh', 'claude-opus-4-8')).toBe('max');
    expect(resolveEffortForApi('high', 'claude-sonnet-4-6')).toBe('high');
    expect(resolveEffortForApi('xhigh', 'gpt-5.5')).toBe('high');
    expect(resolveEffortForApi('medium', 'o4-mini')).toBe('medium');
    expect(resolveEffortForApi('high', 'gemini-2.5-pro')).toBe('high');
    expect(resolveEffortForApi('high', 'claude-haiku-4-5')).toBeUndefined();
    expect(resolveEffortForApi('high', 'unknown-model-id')).toBeUndefined();
  });
});

describe('resolveThinkingConfig display opt-in — always-on-thinking models only (Fable 5 Stage 5)', () => {
  // Stage 5 of docs/plans/260611_fable-5-support/PLAN.md: always-on-thinking
  // models (Fable 5) default to thinking display "omitted", which leaves
  // Rebel's reasoning surface empty through long adaptive thinks — opt them
  // in to summarized display. `display` is NEW with Fable/Mythos and is
  // unverified on older models, so the Opus/Sonnet wire shape must stay
  // byte-identical (Refactor Assessment invariant 2): assert the KEY IS
  // ABSENT, not merely undefined — toEqual ignores undefined-valued keys,
  // and key absence (not value) is the wire contract.
  it.each(['claude-fable-5', 'anthropic/claude-fable-5', 'claude-fable-5[1m]'])(
    'returns summarized display for always-on-thinking form %s',
    (model) => {
      const result = resolveThinkingConfig('high', model, 128_000);
      expect(result).toEqual({ type: 'adaptive', display: 'summarized' });
    },
  );

  it.each([
    'claude-opus-4-8',
    'anthropic/claude-opus-4.8',
    'claude-opus-4-7',
    'claude-opus-4-6',
  ])('wire-shape lock: %s stays plain adaptive with NO display key', (model) => {
    const result = resolveThinkingConfig('high', model, 128_000);
    expect(result).toEqual({ type: 'adaptive' });
    expect('display' in result).toBe(false);
    expect(Object.keys(result)).toEqual(['type']);
  });

  it('wire-shape lock: claude-sonnet-4-6 keeps its budget_tokens shape with NO display key', () => {
    const result = resolveThinkingConfig('high', 'claude-sonnet-4-6', 64_000);
    expect(result.type).toBe('enabled');
    expect('display' in result).toBe(false);
    expect(Object.keys(result).sort()).toEqual(['budget_tokens', 'type']);
  });

  it('disabled and non-Claude branches never carry display', () => {
    for (const result of [
      resolveThinkingConfig('low', 'claude-fable-5', 128_000),
      resolveThinkingConfig(undefined, 'claude-fable-5', 128_000),
      resolveThinkingConfig('high', 'openai/gpt-5.4', 32_000),
    ]) {
      expect('display' in result).toBe(false);
    }
  });

  it('the Stage 4 wire-safety assertion accepts adaptive + summarized display', async () => {
    // adaptive-with-display is still `type: 'adaptive'` — the always-on
    // assertion must not regard the new shape as a violation (NODE_ENV=test
    // means a violation would THROW here, so not-throwing is load-bearing).
    const { assertWireSafeForAlwaysOnThinking } = await import('../alwaysOnThinkingWireSafety');
    const body: Record<string, unknown> = {
      model: 'claude-fable-5',
      max_tokens: 4096,
      thinking: resolveThinkingConfig('high', 'claude-fable-5', 128_000),
    };
    expect(() =>
      assertWireSafeForAlwaysOnThinking('claude-fable-5', body, 'stage5-shape-test'),
    ).not.toThrow();
    // And the assertion did not mutate the config (strip arm is prod-only).
    expect(body.thinking).toEqual({ type: 'adaptive', display: 'summarized' });
  });
});

describe('resolveModelLimits — OpenRouter model IDs', () => {
  it('resolves correct token limits for anthropic/claude-opus-4.7', () => {
    const orResult = resolveModelLimits({ model: 'anthropic/claude-opus-4.7' });
    const nativeResult = resolveModelLimits({ model: 'claude-opus-4-7' });
    expect(orResult.maxOutputTokens).toBe(nativeResult.maxOutputTokens);
    expect(orResult.contextWindow).toBe(nativeResult.contextWindow);
  });

  it('resolves correct token limits for anthropic/claude-sonnet-4-6', () => {
    const orResult = resolveModelLimits({ model: 'anthropic/claude-sonnet-4-6-20250514' });
    const nativeResult = resolveModelLimits({ model: 'claude-sonnet-4-6-20250514' });
    expect(orResult.maxOutputTokens).toBe(nativeResult.maxOutputTokens);
    expect(orResult.contextWindow).toBe(nativeResult.contextWindow);
  });

  it('returns Anthropic-specific limits (not defaults) for OR model IDs', () => {
    const result = resolveModelLimits({ model: 'anthropic/claude-opus-4-7' });
    expect(result.maxOutputTokens).toBe(128_000);
    expect(result.contextWindow).toBe(1_000_000);
  });

  // Regression: dot-to-dash normalization must NOT break non-Claude preset lookups
  it('preserves preset lookup for non-Claude dotted models (openai/gpt-5.4)', () => {
    const result = resolveModelLimits({ model: 'openai/gpt-5.4' });
    // Must return preset values, not defaults (32_768 / 200_000)
    expect(result.maxOutputTokens).toBeGreaterThan(32_768);
    expect(result.contextWindow).toBeGreaterThan(200_000);
  });

  it('preserves preset lookup for google/gemini-2.5-pro', () => {
    const result = resolveModelLimits({ model: 'google/gemini-2.5-pro' });
    expect(result.contextWindow).toBeGreaterThan(200_000);
  });
});

describe('supportsCompact — compact_20260112 capability gate (REBEL-51K)', () => {
  it.each([
    'claude-sonnet-4-6-20250514',
    'claude-opus-4-8',
    'claude-opus-4-8-20260115',
    'claude-opus-4-7-20250430',
    'claude-opus-4-6-20250430',
    'claude-fable-5',
    'anthropic/claude-sonnet-4-6',
    'anthropic/claude-opus-4.7',
    'anthropic/claude-opus-4.8',
    'anthropic/claude-fable-5',
  ])('returns true for %s', (model) => {
    // Mirrors Anthropic's advertised capabilities.context_management.compact_20260112.supported
    // (verified via GET /v1/models/<id>?beta=true on 2026-05-30). opus-4-8 added as a REBEL-52B
    // follow-up; fable-5 verified live 2026-06-11 (PLAN.md Stage 3 (e)) — keep this list in
    // lockstep with the supportsCompact allowlist.
    expect(supportsCompact(model)).toBe(true);
  });

  it.each([
    'claude-sonnet-4-20250514',
    'claude-opus-4-20250514',
    'claude-haiku-4-5-20251001',
    'claude-haiku-4-20250414',
    'anthropic/claude-haiku-4-5',
    'claude-3-5-sonnet-20241022',
    'claude-3-haiku-20240307',
    'gpt-5.4',
    'gemini-2.5-pro',
  ])('returns false for %s', (model) => {
    expect(supportsCompact(model)).toBe(false);
  });
});

describe('isAlwaysOnThinkingModel — catalog thinkingAlwaysOn flag (Fable 5 Stage 4)', () => {
  it.each([
    'claude-fable-5',
    'anthropic/claude-fable-5',
    'claude-fable-5[1m]',
    'anthropic/claude-fable-5[1m]',
    // Dated-suffix form resolves via the catalog lookup's suffix strip.
    'claude-fable-5-20260609',
  ])('returns true for %s', (model) => {
    expect(isAlwaysOnThinkingModel(model)).toBe(true);
  });

  it.each([
    'claude-opus-4-8',
    'anthropic/claude-opus-4.8',
    'claude-opus-4-7',
    'claude-sonnet-4-6',
    'claude-haiku-4-5',
    'gpt-5.4',
    'openai/gpt-5.5',
    'gemini-2.5-pro',
    // Unknown/unrostered ids fall back to the legacy regex, which has no
    // always-on arm — legacy fallback is false by construction.
    'claude-totally-unknown-9',
    '',
  ])('returns false for %s', (model) => {
    expect(isAlwaysOnThinkingModel(model)).toBe(false);
  });

  it('only fable-family entries set thinkingAlwaysOn in the catalog today (flag census)', () => {
    expect(getCatalogEntryById('claude-fable-5')?.thinkingAlwaysOn).toBe(true);
    expect(getCatalogEntryById('claude-opus-4-8')?.thinkingAlwaysOn).toBeUndefined();
  });
});

// =========================================================================
// WS2b — reasoning-effort regex → catalog field (`supportsReasoningEffort`)
// =========================================================================
// `supportsEffort()` was a hardcoded family-regex predicate; WS2b moved its
// per-model answer into the catalog field `supportsReasoningEffort` (catalog
// SSOT, regex retained only as the un-rostered fallback). These tests pin the
// invariant: the catalog field reproduces the historical regex EXACTLY over
// every rostered id, and the fallback reproduces it for un-rostered ids.
//
// `referenceSupportsEffort` is the verbatim pre-WS2b predicate (normalize +
// supportsMaxEffort short-circuit + family regexes). The catalog/field-backed
// `supportsEffort()` must equal it everywhere.
describe('WS2b supportsReasoningEffort — catalog field == historical regex (parity)', () => {
  /** Verbatim copy of the pre-WS2b `supportsEffort` regex logic. */
  function referenceSupportsEffort(model: string): boolean {
    let clean = model.replace(/\[1[mM]\]$/, '').trim();
    if (clean.startsWith('anthropic/')) clean = clean.slice('anthropic/'.length);
    if (/^claude-/i.test(clean)) clean = clean.replace(/(\d)\.(\d)/g, '$1-$2');
    // supportsMaxEffort short-circuit (catalog-driven) — resolve via the catalog
    // exactly as the original did.
    if (getCatalogEntryById(clean)?.supportsMaxEffort === true) return true;
    if (/^claude-(opus|sonnet)-/i.test(clean)) return true;
    const bare = clean.includes('/') ? (clean.split('/').pop() ?? clean) : clean;
    if (/^gpt-5/i.test(bare)) return true;
    if (/^o[34]/i.test(bare)) return true;
    if (/^gemini-(2\.5|3)/i.test(bare) && !/flash-lite/i.test(bare)) return true;
    return false;
  }

  it('matches the historical regex for EVERY catalog entry id', () => {
    const disagreements: string[] = [];
    for (const entry of MODEL_CATALOG) {
      if (supportsEffort(entry.id) !== referenceSupportsEffort(entry.id)) {
        disagreements.push(entry.id);
      }
    }
    expect(disagreements).toEqual([]);
  });

  it('field-backed answer agrees with the per-entry catalog flag (no regex leakage for rostered ids)', () => {
    const disagreements: string[] = [];
    for (const entry of MODEL_CATALOG) {
      // Field OR the supportsMaxEffort implication is the rostered SSOT.
      const fieldAnswer = entry.supportsReasoningEffort === true || entry.supportsMaxEffort === true;
      if (supportsEffort(entry.id) !== fieldAnswer) disagreements.push(entry.id);
    }
    expect(disagreements).toEqual([]);
  });

  it('census: exactly the expected number of catalog entries set the field today', () => {
    const fieldSet = MODEL_CATALOG.filter((e) => e.supportsReasoningEffort === true).map((e) => e.id);
    // 55 rostered reasoning-effort models (direct + openrouter rows). If this
    // count changes, a catalog edit altered effort eligibility — confirm intent
    // and update the historical-regex parity above stays green.
    expect(fieldSet.length).toBe(55);
  });

  it('matches the historical regex for un-rostered / legacy ids (regex fallback path)', () => {
    const unrostered = [
      // Claude name-first families (future versions) → true
      'claude-opus-9-9', 'claude-sonnet-7-0', 'claude-sonnet-3.7',
      'anthropic/claude-opus-5-0',
      // Claude haiku / legacy version-first → false
      'claude-haiku-9-9', 'claude-3-5-sonnet-20241022-unrostered',
      // OpenAI gpt-5 / o-series future ids → true; gpt-4.1 / o1 / o5 → varies
      'gpt-5-unreleased', 'gpt-5.9', 'gpt-6', 'gpt-4.1-future',
      'o3-unreleased', 'o4-future', 'o1-unrostered', 'o5-mini',
      'openai/gpt-5-unrostered', 'openai/o3-unrostered',
      // Gemini reasoning vs flash-lite vs 2.0 → varies
      'gemini-2.5-ultra', 'gemini-3.2-pro', 'gemini-2.5-flash-lite-new', 'gemini-2.0-flash-x',
      'google/gemini-3-ultra',
      // Non-reasoning families → false
      'some-random-model', 'llama-9', 'deepseek-future', 'mistral-large', '',
    ];
    const disagreements: Array<{ model: string; got: boolean; want: boolean }> = [];
    for (const model of unrostered) {
      const got = supportsEffort(model);
      const want = referenceSupportsEffort(model);
      if (got !== want) disagreements.push({ model, got, want });
    }
    expect(disagreements).toEqual([]);
  });
});

// =========================================================================
// WS2b — getSystemRole byte-snapshot (OpenAI wire path: developer vs system)
// =========================================================================
// `getSystemRole` is a SEPARATE predicate from `supportsEffort` (it matches
// `o1`, which has no effort param, and operates on the RAW model name without
// prefix normalization) and was intentionally NOT folded onto the catalog
// field. This snapshot pins the developer/system decision over every catalog
// id + alias + openrouter legacyId, so any inadvertent flip (a silent OpenAI
// request-shape regression) fails loudly. The byte-identical decision before ==
// after the WS2b change is the contract.
describe('WS2b getSystemRole — byte-snapshot of the OpenAI role decision (wire path)', () => {
  it('decides system vs developer identically for every catalog id/alias/legacyId', () => {
    const ids = new Set<string>();
    for (const e of MODEL_CATALOG) {
      ids.add(e.id);
      for (const a of e.aliases ?? []) ids.add(a);
      for (const l of e.openRouter?.legacyIds ?? []) ids.add(l);
      if (e.openRouter?.sdkModel) ids.add(e.openRouter.sdkModel);
    }
    const decision: Record<string, 'system' | 'developer'> = {};
    for (const id of [...ids].sort()) decision[id] = getSystemRole(id);
    expect(decision).toMatchSnapshot();
  });

  it('locks the documented divergences from supportsEffort', () => {
    // o1 family: developer role, but NO effort param (divergence from supportsEffort)
    expect(getSystemRole('o1')).toBe('developer');
    expect(getSystemRole('o1-mini')).toBe('developer');
    expect(supportsEffort('o1')).toBe(false);
    // OpenRouter-prefixed gpt-5: getSystemRole sees the raw prefixed id and does
    // NOT strip it ⇒ 'system'; supportsEffort normalizes ⇒ true.
    expect(getSystemRole('openai/gpt-5.5')).toBe('system');
    expect(supportsEffort('openai/gpt-5.5')).toBe(true);
  });
});
