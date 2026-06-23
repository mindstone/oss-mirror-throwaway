import { describe, expect, it } from 'vitest';
import {
  computeSupportsReasoningReplay,
  getThinkingRetentionTurns,
} from '../reasoningCapability';

describe('computeSupportsReasoningReplay', () => {
  it.each([
    {
      name: 'returns true for DS4 preset even when model name is absent',
      profile: { presetKey: 'local:ds4' },
      modelName: undefined,
      expected: true,
    },
    {
      name: 'returns true for deepseek model name when profile is absent',
      profile: undefined,
      modelName: 'deepseek-v4-flash',
      expected: true,
    },
    {
      // The production OpenRouter/Mindstone DeepSeek backends are slash-prefixed;
      // a bare `^deepseek-` test misses these. `deepseek/deepseek-v4-flash` is the
      // OpenRouter BTS default + Mindstone working/BTS fallback.
      name: 'returns true for slash-prefixed OpenRouter deepseek (the route-table gap)',
      profile: undefined,
      modelName: 'deepseek/deepseek-v4-flash',
      expected: true,
    },
    {
      name: 'returns true for deepseek-ai/ prefixed (Together) deepseek',
      profile: undefined,
      modelName: 'deepseek-ai/deepseek-v4-pro',
      expected: true,
    },
    {
      name: 'returns false for a non-deepseek model on a deepseek-named provider (last segment governs)',
      profile: undefined,
      modelName: 'deepseek-ai/some-other-model',
      expected: false,
    },
    {
      name: 'returns false for a non-deepseek slash-prefixed model',
      profile: null,
      modelName: 'openai/gpt-5.5',
      expected: false,
    },
    {
      name: 'returns true for case-insensitive deepseek prefix',
      profile: { presetKey: 'custom:unknown' },
      modelName: 'DeepSeek-R1',
      expected: true,
    },
    {
      name: 'returns false for non-DS4 preset and non-deepseek model',
      profile: { presetKey: 'local:lm-studio' },
      modelName: 'gpt-4o-mini',
      expected: false,
    },
    {
      name: 'returns false when neither profile nor model name is present',
      profile: null,
      modelName: undefined,
      expected: false,
    },
  ])('$name', ({ profile, modelName, expected }) => {
    expect(computeSupportsReasoningReplay(profile, modelName)).toBe(expected);
  });
});

describe('getThinkingRetentionTurns', () => {
  it('returns 50 when supportsReasoningReplay is true', () => {
    expect(getThinkingRetentionTurns(true)).toBe(50);
  });

  it('returns 2 when supportsReasoningReplay is false', () => {
    expect(getThinkingRetentionTurns(false)).toBe(2);
  });
});
