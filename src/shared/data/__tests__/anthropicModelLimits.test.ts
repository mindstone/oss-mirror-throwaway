/**
 * Anthropic per-model context-window + max-output-token registry.
 *
 * These tests are the single source of truth for the limits we send to the
 * Anthropic API. Mismatches here cause `400 invalid_request_error: max_tokens >
 * <limit>` errors at runtime — which is the bug that motivated adding the
 * `claude-haiku-4-5` entry. See:
 *   docs/project/DIAGNOSE_ONE_OF_MY_CONVERSATIONS.md
 */
import { describe, expect, it } from 'vitest';
import {
  ANTHROPIC_MODEL_LIMITS,
  getAnthropicContextWindow,
  getAnthropicMaxOutput,
  normalizeForAnthropicMatch,
} from '../anthropicModelLimits';
import { MODEL_CATALOG } from '../modelCatalog';

/**
 * Family-level fallback rules in ANTHROPIC_MODEL_LIMITS (indices 5–8). These
 * match hypothetical future siblings (e.g. claude-opus-4-9) that lack an
 * explicit row — first-match wins, so a new main model silently gets wrong
 * limits (200K/64K instead of 1M/128K) unless an explicit rule is added above.
 */
const GENERIC_FALLBACK_SIBLING_IDS = [
  'claude-opus-4-9',
  'claude-sonnet-4-7',
  'claude-haiku-4-6',
  'claude-3-5-sonnet-20990101',
] as const;

function isGenericFallbackPattern(pattern: RegExp): boolean {
  return GENERIC_FALLBACK_SIBLING_IDS.some((id) => pattern.test(id));
}

function findFirstMatchingLimitRule(modelId: string) {
  const cleaned = normalizeForAnthropicMatch(modelId);
  return ANTHROPIC_MODEL_LIMITS.find((entry) => entry.pattern.test(cleaned));
}

const EXPLICIT_LIMITS_FAILURE =
  'new main model needs an explicit ANTHROPIC_MODEL_LIMITS row — see docs/project/NEW_MODEL_SUPPORT_PROCESS.md step 8';

describe('getAnthropicMaxOutput', () => {
  it('returns 128K for Claude Opus 4.7', () => {
    expect(getAnthropicMaxOutput('claude-opus-4-7')).toBe(128_000);
    expect(getAnthropicMaxOutput('claude-opus-4-7-20250101')).toBe(128_000);
  });

  it('returns 128K for Claude Opus 4.6', () => {
    expect(getAnthropicMaxOutput('claude-opus-4-6')).toBe(128_000);
  });

  it('returns 64K for Claude Sonnet 4.6', () => {
    expect(getAnthropicMaxOutput('claude-sonnet-4-6')).toBe(64_000);
  });

  it('returns 64K for Claude Haiku 4.5 (alias and dated variants)', () => {
    expect(getAnthropicMaxOutput('claude-haiku-4-5')).toBe(64_000);
    expect(getAnthropicMaxOutput('claude-haiku-4-5-20251001')).toBe(64_000);
    expect(getAnthropicMaxOutput('claude-haiku-4-5-20241022')).toBe(64_000);
  });

  it('returns 64K for older Claude Opus 4 variants', () => {
    expect(getAnthropicMaxOutput('claude-opus-4-20250514')).toBe(64_000);
  });

  it('returns 64K for older Claude Sonnet 4 variants', () => {
    expect(getAnthropicMaxOutput('claude-sonnet-4-20250514')).toBe(64_000);
  });

  it('returns 16K for older Claude Haiku 4 variants (pre-4.5 fallback)', () => {
    expect(getAnthropicMaxOutput('claude-haiku-4-20250414')).toBe(16_000);
  });

  it('returns 8.192K for Claude 3.x', () => {
    expect(getAnthropicMaxOutput('claude-3-5-sonnet-20241022')).toBe(8_192);
  });

  it('returns null for non-Claude model ids', () => {
    expect(getAnthropicMaxOutput('gpt-5.5')).toBeNull();
    expect(getAnthropicMaxOutput('gemini-3.1-pro-preview')).toBeNull();
  });

  it('handles OpenRouter-prefixed Claude ids', () => {
    expect(getAnthropicMaxOutput('anthropic/claude-haiku-4-5')).toBe(64_000);
    expect(getAnthropicMaxOutput('anthropic/claude-opus-4-7')).toBe(128_000);
  });

  it('handles dot-format version numbers (Claude only)', () => {
    expect(getAnthropicMaxOutput('claude-haiku-4.5')).toBe(64_000);
  });

  it('strips the [1m] extended-context suffix', () => {
    expect(getAnthropicMaxOutput('claude-opus-4-7[1m]')).toBe(128_000);
  });
});

describe('getAnthropicContextWindow', () => {
  it('returns 1M for Opus 4.6 / 4.7 and Sonnet 4.6', () => {
    expect(getAnthropicContextWindow('claude-opus-4-7')).toBe(1_000_000);
    expect(getAnthropicContextWindow('claude-opus-4-6')).toBe(1_000_000);
    expect(getAnthropicContextWindow('claude-sonnet-4-6')).toBe(1_000_000);
  });

  it('returns 200K for Haiku 4.5', () => {
    expect(getAnthropicContextWindow('claude-haiku-4-5')).toBe(200_000);
    expect(getAnthropicContextWindow('claude-haiku-4-5-20251001')).toBe(200_000);
  });

  it('returns 200K for older Opus 4 / Sonnet 4 / Haiku 4 / Claude 3', () => {
    expect(getAnthropicContextWindow('claude-opus-4-20250514')).toBe(200_000);
    expect(getAnthropicContextWindow('claude-sonnet-4-20250514')).toBe(200_000);
    expect(getAnthropicContextWindow('claude-haiku-4-20250414')).toBe(200_000);
    expect(getAnthropicContextWindow('claude-3-5-sonnet-20241022')).toBe(200_000);
  });

  it('returns null for non-Claude model ids', () => {
    expect(getAnthropicContextWindow('gpt-5.5')).toBeNull();
  });

  it('returns 1M for Claude Opus 4.8', () => {
    expect(getAnthropicContextWindow('claude-opus-4-8')).toBe(1_000_000);
  });

  it('returns 1M context / 128K output for Claude Fable 5 (incl. OR-prefixed and [1m] variants)', () => {
    expect(getAnthropicContextWindow('claude-fable-5')).toBe(1_000_000);
    expect(getAnthropicMaxOutput('claude-fable-5')).toBe(128_000);
    expect(getAnthropicMaxOutput('anthropic/claude-fable-5')).toBe(128_000);
    expect(getAnthropicMaxOutput('claude-fable-5[1m]')).toBe(128_000);
  });
});

describe('anthropic main-model limits registry coverage', () => {
  const anthropicMainModels = MODEL_CATALOG.filter(
    (e) => e.provider === 'anthropic' && e.isMainModel,
  );

  it('every anthropic isMainModel catalog entry resolves via an explicit limits row (not family fallback)', () => {
    for (const entry of anthropicMainModels) {
      const rule = findFirstMatchingLimitRule(entry.id);
      expect(
        rule,
        `${entry.id}: no ANTHROPIC_MODEL_LIMITS rule matched — ${EXPLICIT_LIMITS_FAILURE}`,
      ).toBeDefined();
      expect(
        isGenericFallbackPattern(rule!.pattern),
        `${entry.id}: matched generic family fallback ${rule!.pattern} — ${EXPLICIT_LIMITS_FAILURE}`,
      ).toBe(false);
    }
  });

  it('pins exact context-window and max-output limits for current main models', () => {
    const expected: Record<string, { contextWindow: number; maxOutputTokens: number }> = {
      'claude-fable-5': { contextWindow: 1_000_000, maxOutputTokens: 128_000 },
      'claude-opus-4-8': { contextWindow: 1_000_000, maxOutputTokens: 128_000 },
      'claude-opus-4-7': { contextWindow: 1_000_000, maxOutputTokens: 128_000 },
      'claude-opus-4-6': { contextWindow: 1_000_000, maxOutputTokens: 128_000 },
      'claude-sonnet-4-6': { contextWindow: 1_000_000, maxOutputTokens: 64_000 },
      'claude-haiku-4-5': { contextWindow: 200_000, maxOutputTokens: 64_000 },
    };

    for (const [modelId, limits] of Object.entries(expected)) {
      const rule = findFirstMatchingLimitRule(modelId);
      expect(rule, `${modelId}: ${EXPLICIT_LIMITS_FAILURE}`).toBeDefined();
      expect(rule!.contextWindow, `${modelId} contextWindow`).toBe(limits.contextWindow);
      expect(rule!.maxOutputTokens, `${modelId} maxOutputTokens`).toBe(limits.maxOutputTokens);
      expect(getAnthropicContextWindow(modelId)).toBe(limits.contextWindow);
      expect(getAnthropicMaxOutput(modelId)).toBe(limits.maxOutputTokens);
    }
  });
});
