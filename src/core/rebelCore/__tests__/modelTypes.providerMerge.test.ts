import { describe, expect, it } from 'vitest';
import { ZERO_TOKEN_USAGE, addUsage, type TokenUsage } from '../modelTypes';

const usage = (overrides: Partial<TokenUsage>): TokenUsage => ({
  ...ZERO_TOKEN_USAGE,
  ...overrides,
});

describe('addUsage provider merge semantics', () => {
  it('single-call: providersSeen captures the provider', () => {
    const merged = addUsage(
      { ...ZERO_TOKEN_USAGE },
      usage({ openRouterProvider: 'Fireworks' }),
    );

    expect(merged.providersSeen).toEqual(['Fireworks']);
  });

  it('two same-provider calls stay deduped', () => {
    const first = addUsage(
      { ...ZERO_TOKEN_USAGE },
      usage({ openRouterProvider: 'Fireworks' }),
    );
    const second = addUsage(
      first,
      usage({ openRouterProvider: 'Fireworks' }),
    );

    expect(second.providersSeen).toEqual(['Fireworks']);
  });

  it('three-provider handoff preserves ordered history and first-wins openRouterProvider', () => {
    const first = addUsage(
      { ...ZERO_TOKEN_USAGE },
      usage({ openRouterProvider: 'Fireworks' }),
    );
    const second = addUsage(
      first,
      usage({ openRouterProvider: 'DeepInfra' }),
    );
    const third = addUsage(
      second,
      usage({ openRouterProvider: 'Together' }),
    );

    expect(third.providersSeen).toEqual(['Fireworks', 'DeepInfra', 'Together']);
    expect(third.openRouterProvider).toBe('Fireworks');
  });

  it('openRouterProvider and fulfillmentProvider.name both contribute to providersSeen', () => {
    const first = addUsage(
      { ...ZERO_TOKEN_USAGE },
      usage({
        openRouterProvider: 'Fireworks',
        fulfillmentProvider: {
          name: 'Fireworks',
          transport: 'openrouter',
          source: 'or-body',
        },
      }),
    );
    const second = addUsage(
      first,
      usage({
        fulfillmentProvider: {
          name: 'DeepInfra',
          transport: 'openai-direct',
          source: 'response-headers-hints',
        },
      }),
    );

    expect(second.providersSeen).toEqual(['Fireworks', 'DeepInfra']);
    expect(second.fulfillmentProvider).toEqual({
      name: 'Fireworks',
      transport: 'openrouter',
      source: 'or-body',
    });
  });

  it('no-provider merge yields empty providersSeen and undefined openRouterProvider', () => {
    const merged = addUsage(
      { ...ZERO_TOKEN_USAGE },
      { ...ZERO_TOKEN_USAGE },
    );

    expect(merged.providersSeen).toEqual([]);
    expect(merged.openRouterProvider).toBeUndefined();
  });
});

describe('addUsage exactCostUsd merge semantics', () => {
  it('sums exactCostUsd when both sides have it', () => {
    const merged = addUsage(
      usage({ exactCostUsd: 0.25 }),
      usage({ exactCostUsd: 0.75 }),
    );

    expect(merged.exactCostUsd).toBe(1);
  });

  it('returns undefined when left has exactCostUsd but right does not (asymmetric)', () => {
    const merged = addUsage(
      usage({ exactCostUsd: 0.25 }),
      // No exactCostUsd on the right side (ZERO_TOKEN_USAGE has it as 0;
      // omit-it case is when callers pass a usage-event-shaped object without it).
      { inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0 },
    );

    expect(merged.exactCostUsd).toBeUndefined();
  });

  it('returns undefined when right has exactCostUsd but left does not', () => {
    const merged = addUsage(
      { inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0 },
      usage({ exactCostUsd: 0.5 }),
    );

    expect(merged.exactCostUsd).toBeUndefined();
  });

  it('returns undefined when neither side has exactCostUsd', () => {
    const merged = addUsage(
      { inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0 },
      { inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0 },
    );

    expect(merged.exactCostUsd).toBeUndefined();
  });

  it('ZERO_TOKEN_USAGE-shaped left + bare-event-shaped right yields undefined (real-world subAgent flow)', () => {
    // This mirrors agentTool.ts:1551-1552 where existing ?? ZERO_TOKEN_USAGE merges
    // with the bare 4-field event.usage; ZERO has exactCostUsd: 0 but the event lacks
    // the key entirely → merge result is undefined (asymmetric semantics preserved).
    const merged = addUsage(
      { ...ZERO_TOKEN_USAGE },
      { inputTokens: 100, outputTokens: 50, cacheCreationTokens: 0, cacheReadTokens: 0 },
    );

    expect(merged.exactCostUsd).toBeUndefined();
  });
});
