/**
 * Regression test for the runtime-crash hole at clientFactory.ts where the
 * `OpenAIClient` constructor was passed a raw `ModelProviderType` value (e.g.
 * `'openrouter'`, `'local'`) that fell outside the closed `OpenAIProviderType`
 * union the predicate dispatch in `providerFeatureGuards.ts` understands.
 *
 * Pre-refinement, the cast lied; non-{openai,together,cerebras,other} values
 * flowed through as their literal strings and `assertNever(default)` would
 * crash the moment `emitsStrictResponseFormat` / `takesResponsesApiRoute` /
 * `nonChatModelGuardEnabled` ran on the dispatch. Post-refinement,
 * `normalizeToOpenAIProviderType` collapses every off-list value to `'other'`
 * at the boundary, so the predicates can keep their `assertNever` safety net.
 *
 * The walk constructs a client per `ModelProviderType` value via
 * `createOpenAIClientFromProfile` and then exercises every predicate path that
 * a real request would take (response-format gating, Responses-API routing,
 * non-chat-model guard). Any future drift between the broader provider union
 * and the closed predicate union triggers a thrown `assertNever`, which fails
 * the test.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  createOpenAIClientFromProfile,
} from '@core/rebelCore/clientFactory';
import type { AppSettings } from '@shared/types';
import type { ModelProfile, ModelProviderType } from '@shared/types/settings';
import { unsafeAssertRoutingModelId } from '@shared/utils/modelChoiceCodec';

// `anthropic` is intentionally EXCLUDED: an Anthropic profile must never build an OpenAI client
// (it dispatches anthropic-direct), so `createOpenAIClientFromProfile` fails closed for it — see
// the dedicated guard test below. The predicate-dispatch walk covers every OpenAI-style type.
const ALL_PROVIDER_TYPES: readonly ModelProviderType[] = [
  'openai',
  'google',
  'together',
  'cerebras',
  'openrouter',
  'other',
  'local',
] as const;

const BASE_PARAMS = {
  model: unsafeAssertRoutingModelId('profile-model'),
  systemPrompt: 'You are helpful.',
  messages: [{ role: 'user' as const, content: 'Hello' }],
  maxTokens: 64,
};

const CHAT_COMPLETION_RESPONSE = {
  id: 'c1',
  object: 'chat.completion',
  created: 1,
  model: 'profile-model',
  choices: [
    {
      index: 0,
      message: { role: 'assistant', content: 'ok' },
      finish_reason: 'stop',
    },
  ],
  usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
};

function makeProfile(providerType: ModelProviderType): ModelProfile {
  return {
    id: `profile-${providerType}`,
    name: `Stub ${providerType}`,
    providerType,
    // Per-profile apiKey covers `other` / `local`, which never resolve via the
    // shared providerKeys map (per resolveProfileApiKey).
    apiKey: 'fake-test',
    serverUrl: 'https://example.test/v1',
    enabled: true,
    createdAt: 0,
  };
}

function makeSettings(): AppSettings {
  return {
    providerKeys: {
      openai: 'fake-test',
      together: 'fake-test',
      cerebras: 'fake-test',
      google: 'fake-test',
      openrouter: 'fake-test',
    },
  } as unknown as AppSettings;
}

describe('clientFactory provider normalization', () => {
  let mockFetch: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mockFetch = vi.fn();
    vi.stubGlobal('fetch', mockFetch);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it.each(ALL_PROVIDER_TYPES)(
    'constructs an OpenAIClient for ModelProviderType %s without crashing the predicate dispatch',
    async (providerType) => {
      const client = createOpenAIClientFromProfile(makeProfile(providerType), makeSettings());

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => CHAT_COMPLETION_RESPONSE,
      });

      // Exercise every predicate dispatch path:
      //   - `emitsStrictResponseFormat` runs inside `toOpenAIResponseFormat`
      //     when an outputConfig is present.
      //   - `takesResponsesApiRoute` runs inside `needsResponsesApiRoute`
      //     when the request has tools + reasoning_effort.
      //   - `nonChatModelGuardEnabled` runs inside `assertChatCompatibleModel`.
      // For non-openai providers we keep the request shape simple to avoid
      // routing through Responses (which would 404 against the stub fetch);
      // the predicate is still consulted on every code path.
      await expect(
        client.create({
          ...BASE_PARAMS,
          outputConfig: {
            format: {
              type: 'json_schema' as const,
              name: 'unit-test',
              schema: { type: 'object' as const, properties: {} },
            },
          },
        }),
      ).resolves.toBeDefined();
    },
  );

  // By-construction guard (WS1c AUTH review): an Anthropic profile must NEVER build an OpenAI
  // client — it dispatches anthropic-direct, and projecting an Anthropic credential as an
  // OpenAI-style bearer would be a wrong-protocol credential leak. The guard fires BEFORE any
  // credential resolution, so even the footgun shape (a managed Anthropic profile whose only
  // settings credential is an `anthropic-oauth-token`) is rejected outright.
  it('fails closed for an Anthropic profile (never builds an OpenAI client)', () => {
    const anthropicProfile = makeProfile('anthropic');
    expect(() => createOpenAIClientFromProfile(anthropicProfile, makeSettings())).toThrow(
      /Anthropic profiles dispatch direct/i,
    );
  });

  it('fails closed for a managed Anthropic OAuth-only profile (the wrong-protocol footgun shape)', () => {
    const managedAnthropicOAuthProfile: ModelProfile = {
      id: 'managed-anthropic-oauth',
      name: 'Managed Anthropic (OAuth)',
      providerType: 'anthropic',
      profileSource: 'connection',
      serverUrl: '',
      enabled: true,
      createdAt: 0,
    };
    const oauthOnlySettings = {
      models: { apiKey: null, oauthToken: 'ant-oauth-token', authMethod: 'oauth-token' },
    } as unknown as AppSettings;
    // Must throw the guard error, NOT return a client carrying the Anthropic OAuth token as a bearer.
    expect(() =>
      createOpenAIClientFromProfile(managedAnthropicOAuthProfile, oauthOnlySettings),
    ).toThrow(/Anthropic profiles dispatch direct/i);
  });
});
