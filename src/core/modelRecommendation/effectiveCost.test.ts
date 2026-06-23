import { describe, expect, it } from 'vitest';

import type { ActiveProvider } from '@shared/types/settings';
import type { ProfileConnectivityState } from '@shared/utils/connectivityHelpers';
import { getCatalogPricingMap } from '@shared/data/modelCatalog';

import {
  compareEffectiveCost,
  effectiveCost,
  MissingPricingError,
  rawUsdScalar,
} from './effectiveCost';
import type {
  EffectiveCost,
  RecommendationCandidateKey,
  RecommendationInput,
} from './types';

// ---------------------------------------------------------------------------
// Builders
// ---------------------------------------------------------------------------

function makeInput(overrides: {
  activeProvider?: ActiveProvider | undefined;
  codexConnected?: boolean;
  hasOpenRouterOAuth?: boolean;
  managedAllowedModels?: readonly string[];
}): RecommendationInput {
  const connectivity: ProfileConnectivityState = {
    codexConnected: overrides.codexConnected ?? false,
    openRouterConnected: overrides.hasOpenRouterOAuth ?? false,
  };
  return {
    activeProvider: overrides.activeProvider,
    connectivity,
    managedAllowedModels: overrides.managedAllowedModels ?? [],
  };
}

function candidate(
  overrides: Partial<RecommendationCandidateKey> & Pick<RecommendationCandidateKey, 'optionValue'>,
): RecommendationCandidateKey {
  return {
    providerType: overrides.providerType ?? 'openai',
    routeSurface: overrides.routeSurface ?? 'api-key',
    normalizedModelId: overrides.normalizedModelId ?? overrides.optionValue,
    optionValue: overrides.optionValue,
  };
}

const ALL_PROVIDERS: (ActiveProvider | undefined)[] = [
  'anthropic',
  'openrouter',
  'codex',
  'mindstone',
  undefined,
];

// ---------------------------------------------------------------------------
// rawUsdScalar — the documented 4:1 representative-turn proxy (Cost-F2)
// ---------------------------------------------------------------------------

describe('rawUsdScalar', () => {
  it('weights input 4:1 against output (per-MTok)', () => {
    expect(rawUsdScalar({ input: 5, output: 30, cacheRead: 0.5, cacheCreation: 5 })).toBe(50);
    expect(rawUsdScalar({ input: 0, output: 0, cacheRead: 0, cacheCreation: 0 })).toBe(0);
  });

  it('matches the live gpt-5.5 catalog pricing', () => {
    const pricing = getCatalogPricingMap()['gpt-5.5'];
    expect(pricing).toBeDefined();
    // 4*5 + 1*30 = 50
    expect(rawUsdScalar(pricing!)).toBe(50);
  });
});

// ---------------------------------------------------------------------------
// GPT-5.5 bare form — flips on codexConnected, NOT activeProvider (Cost-F3)
// ---------------------------------------------------------------------------

describe('effectiveCost — GPT-5.5 bare form (gpt-5.5)', () => {
  const gpt = candidate({ optionValue: 'gpt-5.5', providerType: 'openai', routeSurface: 'api-key' });

  it('flips to flat on codexConnected:true under EVERY active provider', () => {
    for (const provider of ALL_PROVIDERS) {
      const cost = effectiveCost(gpt, makeInput({ activeProvider: provider, codexConnected: true }));
      expect(cost).toEqual({ kind: 'flat' });
    }
  });

  it('stays paid on codexConnected:false even when activeProvider:"codex" (negative)', () => {
    const cost = effectiveCost(gpt, makeInput({ activeProvider: 'codex', codexConnected: false }));
    expect(cost).toEqual({ kind: 'paid', usd: 50 });
  });

  it('a non-codex active provider with codexConnected:true still flips', () => {
    const cost = effectiveCost(
      gpt,
      makeInput({ activeProvider: 'anthropic', codexConnected: true }),
    );
    expect(cost).toEqual({ kind: 'flat' });
  });

  it('stays paid on codexConnected:false under every active provider', () => {
    for (const provider of ALL_PROVIDERS) {
      const cost = effectiveCost(gpt, makeInput({ activeProvider: provider, codexConnected: false }));
      expect(cost).toEqual({ kind: 'paid', usd: 50 });
    }
  });
});

// ---------------------------------------------------------------------------
// Slash-id form — mindstone => flat, personal OR token => metered, else paid
// ---------------------------------------------------------------------------

describe('effectiveCost — slash-id form (anthropic/claude-opus-4-8)', () => {
  const slash = candidate({
    optionValue: 'anthropic/claude-opus-4-8',
    providerType: 'openrouter',
    routeSurface: 'pool',
  });
  // catalog: input 5.28, output 26.38 => 4*5.28 + 26.38 = 47.5
  const expectedUsd = 4 * 5.28 + 26.38;

  it('flips to flat (subscription) under activeProvider:"mindstone" WHEN allowlisted', () => {
    const cost = effectiveCost(
      slash,
      makeInput({ activeProvider: 'mindstone', managedAllowedModels: ['anthropic/claude-opus-4-8'] }),
    );
    expect(cost).toEqual({ kind: 'flat' });
  });

  it('is metered (pool) with a personal OpenRouter token off-Mindstone', () => {
    for (const provider of ['openrouter', 'anthropic', 'codex', undefined] as const) {
      const cost = effectiveCost(
        slash,
        makeInput({ activeProvider: provider, hasOpenRouterOAuth: true }),
      );
      expect(cost).toEqual({ kind: 'metered' });
    }
  });

  it('is paid with no token and not on Mindstone', () => {
    const cost = effectiveCost(
      slash,
      makeInput({ activeProvider: 'anthropic', hasOpenRouterOAuth: false }),
    );
    expect(cost).toEqual({ kind: 'paid', usd: expectedUsd });
  });

  // F1 (Stage 5): a NON-allowlisted slash row under mindstone is NOT flat — it is
  // priced as the route the user would actually need (the model isn't usable on the
  // plan, so flat-pricing it would float an unusable row above genuine plan rows).
  it('is NOT flat under mindstone when NOT in the managed allow-list — priced pay-per-use without a personal token', () => {
    const cost = effectiveCost(
      slash,
      makeInput({ activeProvider: 'mindstone', managedAllowedModels: ['openai/gpt-5.5'] }),
    );
    expect(cost).toEqual({ kind: 'paid', usd: expectedUsd });
  });

  it('is metered under mindstone when NOT allowlisted but the user has a personal OpenRouter token', () => {
    const cost = effectiveCost(
      slash,
      makeInput({
        activeProvider: 'mindstone',
        hasOpenRouterOAuth: true,
        managedAllowedModels: ['openai/gpt-5.5'],
      }),
    );
    expect(cost).toEqual({ kind: 'metered' });
  });
});

// ---------------------------------------------------------------------------
// Bare Claude — stays paid under EVERY provider state
// ---------------------------------------------------------------------------

describe('effectiveCost — bare claude-opus-4-8 stays paid everywhere', () => {
  const bareClaude = candidate({
    optionValue: 'claude-opus-4-8',
    providerType: 'anthropic',
    routeSurface: 'api-key',
  });
  // catalog: input 5, output 25 => 4*5 + 25 = 45
  const expectedUsd = 45;

  it('is paid under every provider × codex × OR-token combination', () => {
    for (const provider of ALL_PROVIDERS) {
      for (const codexConnected of [true, false]) {
        for (const hasOpenRouterOAuth of [true, false]) {
          const cost = effectiveCost(
            bareClaude,
            makeInput({ activeProvider: provider, codexConnected, hasOpenRouterOAuth }),
          );
          expect(cost).toEqual({ kind: 'paid', usd: expectedUsd });
        }
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Local-row short-circuit (defensive) — Cost-F3
// ---------------------------------------------------------------------------

describe('effectiveCost — routeSurface:"local" short-circuit', () => {
  it('returns free for a routeSurface:"local" row BEFORE consulting the helper', () => {
    // Bare provider:'local' DeepSeek row has zero pricing; the helper would NOT
    // return `local` for the bare id, so the short-circuit is what makes it free.
    const localRow = candidate({
      optionValue: 'deepseek-v4-flash',
      providerType: 'openrouter', // arbitrary; routeSurface is what triggers it
      routeSurface: 'local',
      normalizedModelId: 'deepseek-v4-flash',
    });
    for (const provider of ALL_PROVIDERS) {
      expect(effectiveCost(localRow, makeInput({ activeProvider: provider }))).toEqual({
        kind: 'free',
      });
    }
  });

  it('returns free for an ollama: option value via the helper', () => {
    const ollama = candidate({
      optionValue: 'ollama:llama3.2',
      providerType: 'openrouter',
      routeSurface: 'api-key',
    });
    expect(effectiveCost(ollama, makeInput({}))).toEqual({ kind: 'free' });
  });
});

// ---------------------------------------------------------------------------
// Missing-pricing guard — no eligible paid row may silently produce undefined
// ---------------------------------------------------------------------------

describe('effectiveCost — missing pricing guard', () => {
  it('throws MissingPricingError when a paid candidate has no catalog pricing', () => {
    const unknown = candidate({
      optionValue: 'mystery-model-9000',
      providerType: 'openai',
      routeSurface: 'api-key',
    });
    expect(() => effectiveCost(unknown, makeInput({ activeProvider: 'anthropic' }))).toThrow(
      MissingPricingError,
    );
  });

  it('every recommendable bare/slash frontier id resolves pricing on the paid path', () => {
    // No eligible row should hit the paid path with missing pricing.
    const paidPathRows = [
      'gpt-5.5',
      'openai/gpt-5.5',
      'claude-opus-4-8',
      'anthropic/claude-opus-4-8',
      'deepseek/deepseek-v4-flash',
      'gemini-3.1-pro',
      'google/gemini-3.1-pro-preview',
    ];
    for (const optionValue of paidPathRows) {
      const row = candidate({ optionValue, routeSurface: 'api-key' });
      // Force the paid path: no provider/codex/OR signals that could flip it.
      const cost = effectiveCost(row, makeInput({ activeProvider: 'anthropic' }));
      // Slash-id with no token under anthropic => paid; bare => paid. Both must
      // carry a finite usd (never undefined/NaN).
      expect(cost.kind === 'paid' || cost.kind === 'metered' || cost.kind === 'flat').toBe(true);
      if (cost.kind === 'paid') {
        expect(Number.isFinite(cost.usd)).toBe(true);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Ordering — metered below flat and above paid; cheaper path chosen
// ---------------------------------------------------------------------------

describe('compareEffectiveCost — cost ordering', () => {
  const free: EffectiveCost = { kind: 'free' };
  const flat: EffectiveCost = { kind: 'flat' };
  const metered: EffectiveCost = { kind: 'metered' };
  const paidCheap: EffectiveCost = { kind: 'paid', usd: 10 };
  const paidPricey: EffectiveCost = { kind: 'paid', usd: 50 };

  it('orders free < flat < metered < paid', () => {
    expect(compareEffectiveCost(free, flat)).toBeLessThan(0);
    expect(compareEffectiveCost(flat, metered)).toBeLessThan(0);
    // metered ranks below flat...
    expect(compareEffectiveCost(metered, flat)).toBeGreaterThan(0);
    // ...and above paid.
    expect(compareEffectiveCost(metered, paidCheap)).toBeLessThan(0);
    expect(compareEffectiveCost(paidCheap, metered)).toBeGreaterThan(0);
  });

  it('breaks paid ties by usd', () => {
    expect(compareEffectiveCost(paidCheap, paidPricey)).toBeLessThan(0);
    expect(compareEffectiveCost(paidPricey, paidCheap)).toBeGreaterThan(0);
    expect(compareEffectiveCost(paidCheap, paidCheap)).toBe(0);
  });

  it('treats equal non-paid kinds as equal', () => {
    expect(compareEffectiveCost(flat, flat)).toBe(0);
    expect(compareEffectiveCost(metered, metered)).toBe(0);
  });

  it('two providers connected ⇒ the cheaper effective path wins (GPT-5.5: codex-flat beats raw paid)', () => {
    const gptBare = candidate({ optionValue: 'gpt-5.5', routeSurface: 'api-key' });
    // User with codex connected: bare GPT-5.5 is flat.
    const flatCost = effectiveCost(gptBare, makeInput({ activeProvider: 'mindstone', codexConnected: true }));
    // The same model without codex would be paid $50.
    const paidCost = effectiveCost(gptBare, makeInput({ activeProvider: 'anthropic', codexConnected: false }));
    expect(flatCost).toEqual({ kind: 'flat' });
    expect(paidCost).toEqual({ kind: 'paid', usd: 50 });
    // The codex-connected (flat) path is cheaper.
    expect(compareEffectiveCost(flatCost, paidCost)).toBeLessThan(0);
  });

  it('slash-id Mindstone (flat) beats slash-id metered which beats paid (same model, different user)', () => {
    const slash = candidate({
      optionValue: 'anthropic/claude-opus-4-8',
      providerType: 'openrouter',
      routeSurface: 'pool',
    });
    const mindstone = effectiveCost(
      slash,
      makeInput({ activeProvider: 'mindstone', managedAllowedModels: ['anthropic/claude-opus-4-8'] }),
    );
    const pool = effectiveCost(slash, makeInput({ activeProvider: 'openrouter', hasOpenRouterOAuth: true }));
    const paid = effectiveCost(slash, makeInput({ activeProvider: 'anthropic' }));
    expect(mindstone).toEqual({ kind: 'flat' });
    expect(pool).toEqual({ kind: 'metered' });
    expect(paid.kind).toBe('paid');
    expect(compareEffectiveCost(mindstone, pool)).toBeLessThan(0);
    expect(compareEffectiveCost(pool, paid)).toBeLessThan(0);
  });
});
