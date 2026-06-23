/**
 * Stage 2 of 260505_typed_provider_capability_matrix: provider-walk regression
 * tests for the predicates in `providerFeatureGuards.ts`.
 *
 * For each predicate, walk every `OpenAIProviderType` value and assert the
 * expected return value. The provider-walk shape is the post-migration safety
 * net: it catches "the predicate dispatch is wrong for one transport" before
 * that wrong answer silently fans a feature into a provider that doesn't
 * support it.
 *
 * Note: `emitsStrictResponseFormat` and `takesResponsesApiRoute` are
 * codex-INDEPENDENT — they mirror the pre-migration provider-only checks. The
 * Codex short-circuit at `doCreate` / `doStream` adapts emission to the Codex
 * Responses API; broadening the predicates with a `codexMode` axis would have
 * been a behavior change, not a mechanical migration.
 */

import { describe, it, expect } from 'vitest';
import type { OpenAIProviderType } from '@core/rebelCore/clients/openaiClientTypes';
import {
  emitsStrictResponseFormat,
  nonChatModelGuardEnabled,
  supportsInlineImageContent,
  takesResponsesApiRoute,
} from '@core/rebelCore/providerFeatureGuards';

const ALL_PROVIDER_TYPES: readonly OpenAIProviderType[] = [
  'openai',
  'together',
  'cerebras',
  'other',
] as const;

describe('emitsStrictResponseFormat', () => {
  it('returns true for openai-native', () => {
    expect(emitsStrictResponseFormat('openai')).toBe(true);
  });

  it.each(['together', 'cerebras', 'other'] as const)(
    'returns false for %s',
    (providerType) => {
      expect(emitsStrictResponseFormat(providerType)).toBe(false);
    },
  );
});

describe('takesResponsesApiRoute', () => {
  it('returns true for openai-native', () => {
    expect(takesResponsesApiRoute('openai')).toBe(true);
  });

  it.each(['together', 'cerebras', 'other'] as const)(
    'returns false for %s',
    (providerType) => {
      expect(takesResponsesApiRoute(providerType)).toBe(false);
    },
  );
});

describe('nonChatModelGuardEnabled', () => {
  it('returns true for openai', () => {
    expect(nonChatModelGuardEnabled('openai')).toBe(true);
  });

  it.each(['together', 'cerebras', 'other'] as const)(
    'returns false for %s',
    (providerType) => {
      expect(nonChatModelGuardEnabled(providerType)).toBe(false);
    },
  );
});

describe('supportsInlineImageContent (fail-closed vision gate)', () => {
  it('returns true only for openai-native', () => {
    expect(supportsInlineImageContent('openai')).toBe(true);
  });

  it.each(['together', 'cerebras', 'other'] as const)(
    'fails closed (false) for %s — incl. local/openrouter/google-compat collapsed to "other"',
    (providerType) => {
      expect(supportsInlineImageContent(providerType)).toBe(false);
    },
  );
});

describe('provider-walk completeness', () => {
  it('every provider type is covered by every predicate (no missing branches)', () => {
    for (const providerType of ALL_PROVIDER_TYPES) {
      // Each call must return a boolean (no thrown assertNever).
      expect(typeof emitsStrictResponseFormat(providerType)).toBe('boolean');
      expect(typeof takesResponsesApiRoute(providerType)).toBe('boolean');
      expect(typeof nonChatModelGuardEnabled(providerType)).toBe('boolean');
      expect(typeof supportsInlineImageContent(providerType)).toBe('boolean');
    }
  });
});
