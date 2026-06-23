/**
 * OpenRouter Translation Tests
 *
 * Tests the thinking/reasoning translation functions used by the OR passthrough handler:
 * - translateThinkingToReasoning: Anthropic thinking -> OpenRouter reasoning (outbound)
 * - translateReasoningToThinking: OpenRouter reasoning -> Anthropic thinking (inbound SSE)
 */

import { describe, it, expect } from 'vitest';
import {
  translateThinkingToReasoning,
  translateReasoningToThinking,
  injectProviderRouting,
  stripContextManagementForNonAnthropic,
  stripContextManagementBetaFlag,
  stripTopLevelCacheControl,
  addBlockLevelCacheControl,
  prepareFallbackRetryBody,
} from '../localModelProxyServer';

describe('translateThinkingToReasoning', () => {
  it('converts enabled thinking with budget to reasoning', () => {
    const body = JSON.stringify({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 1024,
      messages: [{ role: 'user', content: 'Hello' }],
      thinking: { type: 'enabled', budget_tokens: 10000 },
    });

    const result = JSON.parse(translateThinkingToReasoning(body));
    expect(result).not.toHaveProperty('thinking');
    expect(result).toHaveProperty('reasoning', { max_tokens: 10000 });
    expect(result.model).toBe('claude-sonnet-4-20250514');
    expect(result.messages).toHaveLength(1);
  });

  it('converts adaptive thinking to reasoning with clamped budget', () => {
    const body = JSON.stringify({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 1024,
      messages: [{ role: 'user', content: 'Hello' }],
      thinking: { type: 'adaptive' },
    });

    const result = JSON.parse(translateThinkingToReasoning(body));
    expect(result).not.toHaveProperty('thinking');
    // Adaptive → 80% of max_tokens (min 10K), then clamped to max_tokens - 1
    expect(result).toHaveProperty('reasoning');
    expect(result.reasoning.max_tokens).toBe(1023); // min(10000, 1024 - 1) = 1023
  });

  it('caps adaptive thinking budget at 32K for large max_tokens', () => {
    const body = JSON.stringify({
      model: 'claude-opus-4-7-20250603',
      max_tokens: 128_000,
      messages: [{ role: 'user', content: 'Hello' }],
      thinking: { type: 'adaptive' },
    });

    const result = JSON.parse(translateThinkingToReasoning(body));
    expect(result).not.toHaveProperty('thinking');
    expect(result.reasoning.max_tokens).toBe(32_000); // capped at ADAPTIVE_REASONING_CAP
  });

  it('uses 80% for moderate max_tokens below the cap', () => {
    const body = JSON.stringify({
      model: 'claude-sonnet-4-6-20250514',
      max_tokens: 32_000,
      messages: [{ role: 'user', content: 'Hello' }],
      thinking: { type: 'adaptive' },
    });

    const result = JSON.parse(translateThinkingToReasoning(body));
    expect(result).not.toHaveProperty('thinking');
    expect(result.reasoning.max_tokens).toBe(25_600); // floor(32000 * 0.8), below 32K cap
  });

  it('returns body unchanged when no thinking present', () => {
    const body = JSON.stringify({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 1024,
      messages: [{ role: 'user', content: 'Hello' }],
    });

    expect(translateThinkingToReasoning(body)).toBe(body);
  });
});

describe('translateReasoningToThinking', () => {
  it('converts reasoning content_block_start to thinking', () => {
    const data = JSON.stringify({
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'reasoning', reasoning: 'Let me think...' },
    });

    const result = JSON.parse(translateReasoningToThinking(data));
    expect(result.content_block.type).toBe('thinking');
  });

  it('converts reasoning_delta to thinking_delta', () => {
    const data = JSON.stringify({
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'reasoning_delta', reasoning: 'more thought' },
    });

    const result = JSON.parse(translateReasoningToThinking(data));
    expect(result.delta.type).toBe('thinking_delta');
    expect(result.delta.thinking).toBe('more thought');
    expect(result.delta).not.toHaveProperty('reasoning');
  });

  it('passes through non-reasoning data unchanged', () => {
    const data = JSON.stringify({
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'text', text: '' },
    });

    expect(translateReasoningToThinking(data)).toBe(data);
  });

  it('passes through lines without reasoning keyword', () => {
    const data = JSON.stringify({ type: 'message_start' });
    expect(translateReasoningToThinking(data)).toBe(data);
  });
});

describe('injectProviderRouting', () => {
  it('injects provider.only for DeepSeek models (all non-CN/SGP providers)', () => {
    const body = JSON.stringify({
      model: 'deepseek/deepseek-v3.2',
      messages: [{ role: 'user', content: 'Hello' }],
    });

    const result = JSON.parse(injectProviderRouting(body));
    expect(result.provider).toEqual({
      only: ['DeepInfra', 'Parasail', 'Together', 'Azure', 'SambaNova', 'Fireworks', 'Crusoe', 'BaseTen', 'Nebius', 'AtlasCloud', 'GMICloud'],
    });
    expect(result.provider).not.toHaveProperty('order');
  });

  it('injects provider.only for MiniMax models (all non-CN/SGP providers)', () => {
    const body = JSON.stringify({
      model: 'minimax/minimax-m2.7',
      messages: [{ role: 'user', content: 'Hello' }],
    });

    const result = JSON.parse(injectProviderRouting(body));
    expect(result.provider).toEqual({
      only: ['DekaLLM', 'Fireworks', 'Morph', 'SambaNova', 'Together', 'DeepInfra', 'Chutes', 'AkashML', 'Nebius', 'Parasail', 'AtlasCloud', 'Venice'],
    });
    expect(result.provider.only).not.toContain('MiniMax');
  });

  it('injects provider.only for Z.ai/GLM models', () => {
    const body = JSON.stringify({
      model: 'z-ai/glm-5.1',
      messages: [{ role: 'user', content: 'Hello' }],
    });

    const result = JSON.parse(injectProviderRouting(body));
    expect(result.provider).toEqual({
      only: ['DeepInfra', 'Fireworks', 'AtlasCloud'],
    });
    expect(result.provider).not.toHaveProperty('order');
  });

  it('does not inject provider routing for xAI/Grok models', () => {
    const body = JSON.stringify({
      model: 'x-ai/grok-4.20',
      messages: [{ role: 'user', content: 'Hello' }],
    });

    const result = JSON.parse(injectProviderRouting(body));
    expect(result).not.toHaveProperty('provider');
  });

  it('does not inject provider routing for Anthropic models', () => {
    const body = JSON.stringify({
      model: 'anthropic/claude-sonnet-4.6',
      messages: [{ role: 'user', content: 'Hello' }],
    });

    const result = JSON.parse(injectProviderRouting(body));
    expect(result).not.toHaveProperty('provider');
  });

  it('does not inject provider routing for OpenAI models', () => {
    const body = JSON.stringify({
      model: 'openai/gpt-5.5',
      messages: [{ role: 'user', content: 'Hello' }],
    });

    const result = JSON.parse(injectProviderRouting(body));
    expect(result).not.toHaveProperty('provider');
  });

  it('overrides existing provider field for Chinese-origin models', () => {
    const body = JSON.stringify({
      model: 'deepseek/deepseek-v3.2',
      messages: [{ role: 'user', content: 'Hello' }],
      provider: { order: ['SiliconFlow'] },
    });

    const result = JSON.parse(injectProviderRouting(body));
    expect(result.provider).toEqual({
      only: ['DeepInfra', 'Parasail', 'Together', 'Azure', 'SambaNova', 'Fireworks', 'Crusoe', 'BaseTen', 'Nebius', 'AtlasCloud', 'GMICloud'],
    });
  });

  it('overrides existing provider for MiniMax models (no caller bypass)', () => {
    const body = JSON.stringify({
      model: 'minimax/minimax-m2.7',
      messages: [{ role: 'user', content: 'Hello' }],
      provider: { order: ['MiniMax'], only: ['MiniMax'] },
    });

    const result = JSON.parse(injectProviderRouting(body));
    expect(result.provider).toEqual({
      only: ['DekaLLM', 'Fireworks', 'Morph', 'SambaNova', 'Together', 'DeepInfra', 'Chutes', 'AkashML', 'Nebius', 'Parasail', 'AtlasCloud', 'Venice'],
    });
    // Ensure MiniMax is NOT in the allowlist (privacy policy preserved)
    expect(result.provider.only).not.toContain('MiniMax');
  });

  it('matches model prefixes case-insensitively', () => {
    const body = JSON.stringify({
      model: 'DeepSeek/deepseek-v3.2',
      messages: [{ role: 'user', content: 'Hello' }],
    });

    const result = JSON.parse(injectProviderRouting(body));
    expect(result.provider).toEqual({
      only: ['DeepInfra', 'Parasail', 'Together', 'Azure', 'SambaNova', 'Fireworks', 'Crusoe', 'BaseTen', 'Nebius', 'AtlasCloud', 'GMICloud'],
    });
  });
});

describe('stripContextManagementForNonAnthropic', () => {
  it.each([
    ['openai/gpt-5.5'],
    ['google/gemini-2.5-pro'],
    ['deepseek/deepseek-v4-flash'],
  ])('removes Anthropic-only context_management from produced outbound body for non-Anthropic model %s', (model) => {
    const body = JSON.stringify({
      model,
      max_tokens: 128,
      messages: [{ role: 'user', content: 'Hello' }],
      context_management: { edits: [{ type: 'clear_tool_uses', trigger: { type: 'input_tokens', value: 50000 } }] },
    });

    const result = JSON.parse(stripContextManagementForNonAnthropic(body));

    expect(result).toMatchObject({
      model,
      max_tokens: 128,
      messages: [{ role: 'user', content: 'Hello' }],
    });
    expect(result).not.toHaveProperty('context_management');
  });

  it('strips context_management for GPT models', () => {
    const body = JSON.stringify({
      model: 'openai/gpt-5.5',
      messages: [{ role: 'user', content: 'Hello' }],
      context_management: { clear_tool_uses: { trigger_tokens: 50000 } },
    });

    const result = JSON.parse(stripContextManagementForNonAnthropic(body));
    expect(result).not.toHaveProperty('context_management');
    expect(result.model).toBe('openai/gpt-5.5');
    expect(result.messages).toHaveLength(1);
  });

  it('preserves context_management for Anthropic models (anthropic/ prefix)', () => {
    const body = JSON.stringify({
      model: 'anthropic/claude-sonnet-4-6',
      messages: [{ role: 'user', content: 'Hello' }],
      context_management: { clear_tool_uses: { trigger_tokens: 50000 } },
    });

    const result = JSON.parse(stripContextManagementForNonAnthropic(body));
    expect(result).toHaveProperty('context_management');
  });

  it('preserves context_management for Claude models (claude- prefix)', () => {
    const body = JSON.stringify({
      model: 'claude-sonnet-4-6',
      messages: [{ role: 'user', content: 'Hello' }],
      context_management: { clear_tool_uses: { trigger_tokens: 50000 } },
    });

    const result = JSON.parse(stripContextManagementForNonAnthropic(body));
    expect(result).toHaveProperty('context_management');
  });

  it('returns body unchanged when no context_management present', () => {
    const body = JSON.stringify({
      model: 'openai/gpt-5.5',
      messages: [{ role: 'user', content: 'Hello' }],
    });

    expect(stripContextManagementForNonAnthropic(body)).toBe(body);
  });

  it('strips context_management for other non-Anthropic models', () => {
    const body = JSON.stringify({
      model: 'google/gemini-2.5-pro',
      messages: [{ role: 'user', content: 'Hello' }],
      context_management: { clear_tool_uses: { trigger_tokens: 50000 } },
    });

    const result = JSON.parse(stripContextManagementForNonAnthropic(body));
    expect(result).not.toHaveProperty('context_management');
  });
});

describe('stripContextManagementBetaFlag', () => {
  it.each([
    ['openai/gpt-5.5'],
    ['google/gemini-2.5-pro'],
    ['deepseek/deepseek-v4-flash'],
  ])('removes only Anthropic context-management beta flags for non-Anthropic model %s', (model) => {
    const result = stripContextManagementBetaFlag(
      'some-other-beta, context-management-2025-06-27, compact-2026-01-12, another-flag',
      model,
    );

    expect(result).toBe('some-other-beta,another-flag');
  });

  it('strips context-management flag for non-Anthropic models', () => {
    const result = stripContextManagementBetaFlag(
      'context-management-2025-06-27',
      'openai/gpt-5.5',
    );
    expect(result).toBeUndefined();
  });

  it('preserves other beta flags while stripping context-management', () => {
    const result = stripContextManagementBetaFlag(
      'some-other-beta,context-management-2025-06-27,another-flag',
      'openai/gpt-5.5',
    );
    expect(result).toBe('some-other-beta,another-flag');
  });

  it('strips compact beta for non-Anthropic models', () => {
    const result = stripContextManagementBetaFlag(
      'compact-2026-01-12',
      'openai/gpt-5.5',
    );
    expect(result).toBeUndefined();
  });

  it('strips both managed Anthropic betas for non-Anthropic models', () => {
    const result = stripContextManagementBetaFlag(
      'some-other-beta,compact-2026-01-12,context-management-2025-06-27,another-flag',
      'openai/gpt-5.5',
    );
    expect(result).toBe('some-other-beta,another-flag');
  });

  it('preserves all flags for Anthropic models', () => {
    const result = stripContextManagementBetaFlag(
      'context-management-2025-06-27,compact-2026-01-12',
      'anthropic/claude-sonnet-4-6',
    );
    expect(result).toBe('context-management-2025-06-27,compact-2026-01-12');
  });

  it('preserves all flags for claude- prefix models', () => {
    const result = stripContextManagementBetaFlag(
      'context-management-2025-06-27,compact-2026-01-12',
      'claude-sonnet-4-6',
    );
    expect(result).toBe('context-management-2025-06-27,compact-2026-01-12');
  });

  it('returns undefined header unchanged', () => {
    expect(stripContextManagementBetaFlag(undefined, 'openai/gpt-5.5')).toBeUndefined();
  });
});

describe('stripTopLevelCacheControl', () => {
  it('removes top-level cache_control from request body', () => {
    const body = JSON.stringify({
      model: 'anthropic/claude-opus-4.7',
      cache_control: { type: 'ephemeral' },
      messages: [{ role: 'user', content: 'Hello' }],
      system: [{ type: 'text', text: 'You are helpful.', cache_control: { type: 'ephemeral' } }],
    });

    const result = JSON.parse(stripTopLevelCacheControl(body));
    expect(result).not.toHaveProperty('cache_control');
    expect(result.model).toBe('anthropic/claude-opus-4.7');
    expect(result.messages).toHaveLength(1);
    // Block-level cache_control in system prompt is preserved
    expect(result.system[0].cache_control).toEqual({ type: 'ephemeral' });
  });

  it('returns body unchanged when no top-level cache_control', () => {
    const body = JSON.stringify({
      model: 'anthropic/claude-sonnet-4-6',
      messages: [{ role: 'user', content: 'Hello' }],
    });

    expect(stripTopLevelCacheControl(body)).toBe(body);
  });

  it('preserves all other fields', () => {
    const body = JSON.stringify({
      model: 'anthropic/claude-opus-4.7',
      cache_control: { type: 'ephemeral' },
      max_tokens: 4096,
      thinking: { type: 'enabled', budget_tokens: 10000 },
      messages: [{ role: 'user', content: 'Hello' }],
    });

    const result = JSON.parse(stripTopLevelCacheControl(body));
    expect(result.max_tokens).toBe(4096);
    expect(result.thinking).toEqual({ type: 'enabled', budget_tokens: 10000 });
    expect(result).not.toHaveProperty('cache_control');
  });
});

describe('addBlockLevelCacheControl', () => {
  it('converts string system prompt to block array with cache_control', () => {
    const body = JSON.stringify({
      model: 'anthropic/claude-opus-4.7',
      system: 'You are a helpful assistant.',
      messages: [{ role: 'user', content: 'Hello' }],
    });

    const result = JSON.parse(addBlockLevelCacheControl(body));
    expect(result.system).toEqual([{
      type: 'text',
      text: 'You are a helpful assistant.',
      cache_control: { type: 'ephemeral' },
    }]);
    expect(result.messages).toHaveLength(1);
  });

  it('adds cache_control to last text block in array system prompt', () => {
    const body = JSON.stringify({
      model: 'anthropic/claude-opus-4.7',
      system: [
        { type: 'text', text: 'First block.' },
        { type: 'text', text: 'Second block.' },
      ],
      messages: [{ role: 'user', content: 'Hello' }],
    });

    const result = JSON.parse(addBlockLevelCacheControl(body));
    expect(result.system[0]).not.toHaveProperty('cache_control');
    expect(result.system[1].cache_control).toEqual({ type: 'ephemeral' });
  });

  it('returns body unchanged when no system prompt', () => {
    const body = JSON.stringify({
      model: 'anthropic/claude-opus-4.7',
      messages: [{ role: 'user', content: 'Hello' }],
    });

    expect(addBlockLevelCacheControl(body)).toBe(body);
  });

  it('preserves existing cache_control and overwrites on last text block', () => {
    const body = JSON.stringify({
      model: 'anthropic/claude-opus-4.7',
      system: [
        { type: 'text', text: 'Block with existing cache.', cache_control: { type: 'ephemeral' } },
        { type: 'text', text: 'Last block without cache.' },
      ],
      messages: [],
    });

    const result = JSON.parse(addBlockLevelCacheControl(body));
    expect(result.system[0].cache_control).toEqual({ type: 'ephemeral' });
    expect(result.system[1].cache_control).toEqual({ type: 'ephemeral' });
  });
});

describe('prepareFallbackRetryBody', () => {
  it('adds block-level cache and strips context_management', () => {
    const body = JSON.stringify({
      model: 'anthropic/claude-opus-4.7',
      system: 'You are helpful.',
      messages: [{ role: 'user', content: 'Hello' }],
      context_management: { clear_tool_uses_20250919: { trigger_tokens: 50000 } },
    });

    const result = JSON.parse(prepareFallbackRetryBody(body));
    expect(result.system).toEqual([{
      type: 'text',
      text: 'You are helpful.',
      cache_control: { type: 'ephemeral' },
    }]);
    expect(result).not.toHaveProperty('context_management');
  });

  it('works when context_management is absent', () => {
    const body = JSON.stringify({
      model: 'anthropic/claude-opus-4.7',
      system: 'You are helpful.',
      messages: [],
    });

    const result = JSON.parse(prepareFallbackRetryBody(body));
    expect(result.system).toEqual([{
      type: 'text',
      text: 'You are helpful.',
      cache_control: { type: 'ephemeral' },
    }]);
    expect(result).not.toHaveProperty('context_management');
  });

  it('preserves other fields', () => {
    const body = JSON.stringify({
      model: 'anthropic/claude-opus-4.7',
      system: 'You are helpful.',
      max_tokens: 4096,
      reasoning: { max_tokens: 32000 },
      messages: [{ role: 'user', content: 'Hello' }],
    });

    const result = JSON.parse(prepareFallbackRetryBody(body));
    expect(result.max_tokens).toBe(4096);
    expect(result.reasoning).toEqual({ max_tokens: 32000 });
  });
});
