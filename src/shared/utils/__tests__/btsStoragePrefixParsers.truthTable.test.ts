/**
 * Truth-table pin for the `model:` / `profile:` storage-prefix parsers (WS0 Stage 2).
 *
 * Three call sites historically clone the storage-prefix decode logic:
 *   1. `authEnvUtils.ts` → `parseFallbackEncoding` (rate-limit tier fallback)
 *   2. `providerRouting.ts` → `parseFallbackEncoding` (Codex rate-limit fallback)
 *   3. `billingSource.ts` → `resolveBillingSourceForOption` prefix branches
 *
 * The Stage 2 brief asked to consolidate these onto the canonical decoders in
 * `btsModelValueNormalization.ts` (`decodePrefixed` / `normalizeStoredBtsModelValue`
 * / `stripStoredModelPrefix`) ONLY where behaviour is provably identical. This
 * truth table demonstrates — across every probe input — that NONE of the three
 * clones are behaviourally identical to the canonical decoders, so all three are
 * intentionally KEPT (with divergence comments at each site). This test exists so
 * that any future "just use the shared decoder" refactor fails loudly with the
 * exact divergent cell.
 *
 * See WS0 Stage 2 plan + cross-family review (the three canonical decoders are NOT
 * interchangeable with each other either — they differ on trim / null / empty /
 * bare / URI-decode).
 */
import { describe, expect, it } from 'vitest';
import {
  decodePrefixed,
  normalizeStoredBtsModelValue,
  stripStoredModelPrefix,
} from '../btsModelValueNormalization';
import { resolveBillingSourceForOption } from '../billingSource';
import type { AppSettings, ModelProfile } from '../../types';
import { __parseFallbackEncodingAuthEnvForTests } from '@core/utils/authEnvUtils';
import { __parseFallbackEncodingProviderRoutingForTests } from '@core/rebelCore/providerRouting';

/** The probe inputs the Stage 2 brief enumerated, plus URI-encoded forms. */
const PROBE_INPUTS: ReadonlyArray<string | null | undefined> = [
  undefined,
  null,
  '',
  '   ',
  'model:',
  'profile:',
  'model:claude-sonnet-4-6',
  'profile:abc',
  'claude-sonnet-4-6',
  'model:profile:x',
  '  model:claude  ',
  'profile:   ',
  'model:   ',
  'unknown:value',
  'profile:abc%20x',
  'model:gpt%2F5',
];

/** Safe-call wrapper: capture a thrown TypeError as a sentinel so the table is total. */
function safe<T>(fn: () => T): T | { threw: string } {
  try {
    return fn();
  } catch (e) {
    return { threw: e instanceof Error ? e.constructor.name : 'unknown' };
  }
}

describe('btsModelValueNormalization canonical decoders — pinned truth table', () => {
  it('decodePrefixed', () => {
    expect(PROBE_INPUTS.map((i) => [i, decodePrefixed(i)])).toMatchInlineSnapshot(`
      [
        [
          undefined,
          null,
        ],
        [
          null,
          null,
        ],
        [
          "",
          null,
        ],
        [
          "   ",
          null,
        ],
        [
          "model:",
          null,
        ],
        [
          "profile:",
          {
            "kind": "profile",
            "profileId": "",
          },
        ],
        [
          "model:claude-sonnet-4-6",
          {
            "kind": "model",
            "modelId": "claude-sonnet-4-6",
          },
        ],
        [
          "profile:abc",
          {
            "kind": "profile",
            "profileId": "abc",
          },
        ],
        [
          "claude-sonnet-4-6",
          {
            "kind": "model",
            "modelId": "claude-sonnet-4-6",
          },
        ],
        [
          "model:profile:x",
          {
            "kind": "model",
            "modelId": "profile:x",
          },
        ],
        [
          "  model:claude  ",
          {
            "kind": "model",
            "modelId": "claude",
          },
        ],
        [
          "profile:   ",
          {
            "kind": "profile",
            "profileId": "",
          },
        ],
        [
          "model:   ",
          null,
        ],
        [
          "unknown:value",
          {
            "kind": "model",
            "modelId": "unknown:value",
          },
        ],
        [
          "profile:abc%20x",
          {
            "kind": "profile",
            "profileId": "abc%20x",
          },
        ],
        [
          "model:gpt%2F5",
          {
            "kind": "model",
            "modelId": "gpt%2F5",
          },
        ],
      ]
    `);
  });

  it('normalizeStoredBtsModelValue', () => {
    expect(PROBE_INPUTS.map((i) => [i, normalizeStoredBtsModelValue(i)])).toMatchInlineSnapshot(`
      [
        [
          undefined,
          {
            "ok": false,
            "reason": "invalid-type",
          },
        ],
        [
          null,
          {
            "ok": false,
            "reason": "invalid-type",
          },
        ],
        [
          "",
          {
            "ok": false,
            "reason": "empty-or-whitespace",
          },
        ],
        [
          "   ",
          {
            "ok": false,
            "reason": "empty-or-whitespace",
          },
        ],
        [
          "model:",
          {
            "ok": false,
            "reason": "empty-model-id",
          },
        ],
        [
          "profile:",
          {
            "ok": false,
            "reason": "empty-profile-id",
          },
        ],
        [
          "model:claude-sonnet-4-6",
          {
            "kind": "model",
            "modelId": "claude-sonnet-4-6",
            "ok": true,
          },
        ],
        [
          "profile:abc",
          {
            "kind": "profile",
            "ok": true,
            "profileId": "abc",
          },
        ],
        [
          "claude-sonnet-4-6",
          {
            "kind": "model",
            "modelId": "claude-sonnet-4-6",
            "ok": true,
          },
        ],
        [
          "model:profile:x",
          {
            "ok": false,
            "reason": "model-with-profile-prefix",
          },
        ],
        [
          "  model:claude  ",
          {
            "kind": "model",
            "modelId": "claude",
            "ok": true,
          },
        ],
        [
          "profile:   ",
          {
            "ok": false,
            "reason": "empty-profile-id",
          },
        ],
        [
          "model:   ",
          {
            "ok": false,
            "reason": "empty-model-id",
          },
        ],
        [
          "unknown:value",
          {
            "kind": "model",
            "modelId": "unknown:value",
            "ok": true,
          },
        ],
        [
          "profile:abc%20x",
          {
            "kind": "profile",
            "ok": true,
            "profileId": "abc%20x",
          },
        ],
        [
          "model:gpt%2F5",
          {
            "kind": "model",
            "modelId": "gpt%2F5",
            "ok": true,
          },
        ],
      ]
    `);
  });

  it('stripStoredModelPrefix (string-typed input only)', () => {
    // stripStoredModelPrefix takes a non-null `string`; feed only the string probes.
    const stringProbes = PROBE_INPUTS.filter((i): i is string => typeof i === 'string');
    expect(stringProbes.map((i) => [i, stripStoredModelPrefix(i)])).toMatchInlineSnapshot(`
      [
        [
          "",
          "",
        ],
        [
          "   ",
          "   ",
        ],
        [
          "model:",
          null,
        ],
        [
          "profile:",
          "",
        ],
        [
          "model:claude-sonnet-4-6",
          "claude-sonnet-4-6",
        ],
        [
          "profile:abc",
          "abc",
        ],
        [
          "claude-sonnet-4-6",
          "claude-sonnet-4-6",
        ],
        [
          "model:profile:x",
          "profile:x",
        ],
        [
          "  model:claude  ",
          "  model:claude  ",
        ],
        [
          "profile:   ",
          "   ",
        ],
        [
          "model:   ",
          "   ",
        ],
        [
          "unknown:value",
          "unknown:value",
        ],
        [
          "profile:abc%20x",
          "abc%20x",
        ],
        [
          "model:gpt%2F5",
          "gpt%2F5",
        ],
      ]
    `);
  });
});

describe('clone parsers — pinned truth table (KEPT; diverge from canonical)', () => {
  it('authEnvUtils.parseFallbackEncoding', () => {
    expect(
      PROBE_INPUTS.map((i) => [i, safe(() => __parseFallbackEncodingAuthEnvForTests(i as string))]),
    ).toMatchInlineSnapshot(`
      [
        [
          undefined,
          {
            "threw": "TypeError",
          },
        ],
        [
          null,
          {
            "threw": "TypeError",
          },
        ],
        [
          "",
          null,
        ],
        [
          "   ",
          null,
        ],
        [
          "model:",
          null,
        ],
        [
          "profile:",
          null,
        ],
        [
          "model:claude-sonnet-4-6",
          {
            "modelOverride": "claude-sonnet-4-6",
          },
        ],
        [
          "profile:abc",
          {
            "profileOverrideId": "abc",
          },
        ],
        [
          "claude-sonnet-4-6",
          null,
        ],
        [
          "model:profile:x",
          {
            "modelOverride": "profile:x",
          },
        ],
        [
          "  model:claude  ",
          null,
        ],
        [
          "profile:   ",
          {
            "profileOverrideId": "   ",
          },
        ],
        [
          "model:   ",
          {
            "modelOverride": "   ",
          },
        ],
        [
          "unknown:value",
          null,
        ],
        [
          "profile:abc%20x",
          {
            "profileOverrideId": "abc%20x",
          },
        ],
        [
          "model:gpt%2F5",
          {
            "modelOverride": "gpt%2F5",
          },
        ],
      ]
    `);
  });

  it('providerRouting.parseFallbackEncoding', () => {
    expect(
      PROBE_INPUTS.map((i) => [i, __parseFallbackEncodingProviderRoutingForTests(i)]),
    ).toMatchInlineSnapshot(`
      [
        [
          undefined,
          null,
        ],
        [
          null,
          null,
        ],
        [
          "",
          null,
        ],
        [
          "   ",
          null,
        ],
        [
          "model:",
          null,
        ],
        [
          "profile:",
          null,
        ],
        [
          "model:claude-sonnet-4-6",
          {
            "kind": "model",
            "model": "claude-sonnet-4-6",
          },
        ],
        [
          "profile:abc",
          {
            "kind": "profile",
            "profileId": "abc",
          },
        ],
        [
          "claude-sonnet-4-6",
          null,
        ],
        [
          "model:profile:x",
          {
            "kind": "model",
            "model": "profile:x",
          },
        ],
        [
          "  model:claude  ",
          null,
        ],
        [
          "profile:   ",
          null,
        ],
        [
          "model:   ",
          null,
        ],
        [
          "unknown:value",
          null,
        ],
        [
          "profile:abc%20x",
          {
            "kind": "profile",
            "profileId": "abc%20x",
          },
        ],
        [
          "model:gpt%2F5",
          {
            "kind": "model",
            "model": "gpt%2F5",
          },
        ],
      ]
    `);
  });
});

describe('documented divergences — why no clone can adopt the canonical decoder', () => {
  it('canonical decodePrefixed passes BARE values through; both fallback clones return null', () => {
    expect(decodePrefixed('claude-sonnet-4-6')).toEqual({ kind: 'model', modelId: 'claude-sonnet-4-6' });
    expect(__parseFallbackEncodingAuthEnvForTests('claude-sonnet-4-6')).toBeNull();
    expect(__parseFallbackEncodingProviderRoutingForTests('claude-sonnet-4-6')).toBeNull();
  });

  it('canonical decodePrefixed accepts empty profile payload; both fallback clones reject it', () => {
    expect(decodePrefixed('profile:')).toEqual({ kind: 'profile', profileId: '' });
    expect(__parseFallbackEncodingAuthEnvForTests('profile:')).toBeNull();
    expect(__parseFallbackEncodingProviderRoutingForTests('profile:')).toBeNull();
  });

  it('billingSource URI-decodes the prefix payload; canonical decoders never do', () => {
    // decodePrefixed leaves the percent-encoding intact...
    expect(decodePrefixed('profile:abc%20x')).toEqual({ kind: 'profile', profileId: 'abc%20x' });

    // ...whereas billingSource decodeURIComponent's the stripped payload before
    // matching a profile id. A profile stored under the DECODED id ('a b') is found
    // only because of the URI-decode; the raw 'a%20b' is not a profile id. If this
    // site adopted the canonical decoder (no URI-decode) the lookup would miss and
    // return 'pay-per-use' instead of the profile's billing source.
    const profile: ModelProfile = {
      id: 'a b',
      name: 'spaced',
      serverUrl: 'https://api.example.com/v1',
      providerType: 'openrouter',
      model: 'foo/bar',
      createdAt: 0,
    };
    const settings = {
      activeProvider: 'anthropic',
      localModel: { profiles: [profile] },
      openRouter: { oauthToken: null },
    } as unknown as AppSettings;

    // URI-decoded 'a%20b' → 'a b' matches the profile → 'pool' (openrouter, no mindstone).
    expect(resolveBillingSourceForOption('profile:a%20b', settings, false)).toBe('pool');
    // The non-decoded literal 'a b' also matches (already decoded) — same result,
    // confirming the lookup keys on the decoded id.
    expect(resolveBillingSourceForOption('profile:a b', settings, false)).toBe('pool');
    // A percent-encoded id with NO matching profile → 'pay-per-use' fallback.
    expect(resolveBillingSourceForOption('profile:does%20not%20exist', settings, false)).toBe('pay-per-use');
  });
});
