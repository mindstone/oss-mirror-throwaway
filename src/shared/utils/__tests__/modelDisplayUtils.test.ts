import { describe, expect, it } from 'vitest';
import { shortModelName } from '../modelDisplayUtils';

describe('shortModelName', () => {
  it('removes provider namespace and prettifies known model prefixes', () => {
    expect(shortModelName('openrouter/gpt-5.5')).toBe('GPT-5.5');
    expect(shortModelName('anthropic/claude-sonnet-4-20250514')).toBe('Claude sonnet-4-20250514');
    expect(shortModelName('gemini-2.5-pro')).toBe('Gemini 2.5-pro');
    expect(shortModelName('grok-3-mini')).toBe('Grok 3-mini');
  });

  it('preserves already-short identifiers', () => {
    expect(shortModelName('o3')).toBe('o3');
    expect(shortModelName('custom-model')).toBe('custom-model');
  });
});
