import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildSettings } from '@core/__tests__/builders/settingsBuilder';
import type { AppSettings, LocalModelSettings } from '@shared/types/settings';
import type { ActiveProvider } from '@shared/types/settings';
import {
  validateProviderCredentials,
  type ProviderCredentialState,
} from '../validateProviderCredentials';

// ---------------------------------------------------------------------------
// Stage 1 — credential/admission TOTALITY gate (cross-module-test-coverage).
//
// The bug-in-waiting: `validateProviderCredentials` (validateProviderCredentials.ts:70,86)
// switches on `settings.activeProvider` with `case 'anthropic': case undefined: default:`
// all collapsing onto the Anthropic credential path. A brand-new `ActiveProvider`
// added to the union (src/shared/types/settings.ts:382) would hit that `default`
// arm and be validated AS ANTHROPIC — with NO compile error and NO existing test
// failure. That is the sibling-table-omission / cross_module_assumption class
// (postmortems 260602_mindstone_managed_key_injection_gap,
// 260606_direct_anthropic_self_prefix_reject_auth_mislabel).
//
// The existing behavioral suite (validateProviderCredentials.test.ts) iterates a
// representative SUBSET of providers; it does NOT enumerate the `ActiveProvider`
// union, so adding a 5th provider reddens nothing there. So does the route-plan
// parity matrix (providerResolution.parityMatrix.test.ts) — a hand-authored
// `cells: RawCell[]` array, not `satisfies Record<ActiveProvider, …>`.
//
// This file replicates the compile-forced-totality pattern proven in
// `settingsStore.providerHealSymmetry.test.ts`
// (`… satisfies Record<ActiveProvider, ProviderHealClass>`): a new provider added
// to the union FAILS TO COMPILE here until its expected credential-validation
// behaviour is explicitly classified, instead of silently inheriting Anthropic.
//
// PER-AXIS ONLY (DA descriptor-smell guard): this map classifies the credential-
// validation axis ALONE — NOT transport assignment (which keys on a different,
// `profile`/`local`-inclusive transport union), heal symmetry, reconnect, or
// error classification. Do NOT merge those axes in here.
// ---------------------------------------------------------------------------

/**
 * The `ProviderCredentialState.kind` each `ActiveProvider` resolves to when that
 * provider is active WITH its representative valid credential present and NO
 * loopback-routable working profile (the loopback profile short-circuits to
 * `kind: 'local'` BEFORE the activeProvider switch — see
 * validateProviderCredentials.ts:66 — so it is deliberately excluded here to
 * exercise each provider's OWN switch arm).
 */
type ExpectedCredentialKind = ProviderCredentialState['kind'];

interface ExpectedCredentialClass {
  /** The credential `kind` this provider's switch arm must produce. */
  kind: ExpectedCredentialKind;
  /**
   * Why this classification — forces a deliberate decision (mirrors the reason
   * strings in providerHealSymmetry's classification).
   */
  reason: string;
  /** Build settings that present this provider's representative VALID credential. */
  valid: () => AppSettings;
  /** The state `validateProviderCredentials` must return for the valid fixture. */
  expectedValid: ProviderCredentialState;
  /** Build settings with the provider active but its credential ABSENT. */
  unconfigured: () => AppSettings;
  /** The state `validateProviderCredentials` must return for the unconfigured fixture. */
  expectedUnconfigured: ProviderCredentialState;
  /** `codexConnected` flag to drive the VALID fixture with. */
  codexConnected: boolean;
  /** `codexConnected` flag to drive the UNCONFIGURED fixture with (defaults to `codexConnected`). */
  codexConnectedUnconfigured?: boolean;
}

const noProfiles = (): LocalModelSettings => ({ profiles: [], activeProfileId: null });

// EXHAUSTIVE over `ActiveProvider`. A new provider added to the union forces a
// compile error here (the `satisfies Record<ActiveProvider, …>` below), so the
// silent `default → Anthropic` fall-through cannot ship unclassified.
const CREDENTIAL_VALIDATION_CLASSIFICATION = {
  anthropic: {
    kind: 'anthropic',
    reason: 'BYOK direct Anthropic API key — the explicit `case "anthropic"` arm.',
    codexConnected: false,
    valid: () =>
      buildSettings({
        activeProvider: 'anthropic',
        claude: { ...buildSettings().models, apiKey: 'real-anthropic-key' },
        localModel: noProfiles(),
      }),
    expectedValid: { kind: 'anthropic', status: 'valid', apiKey: 'real-anthropic-key' },
    unconfigured: () =>
      buildSettings({
        activeProvider: 'anthropic',
        claude: { ...buildSettings().models, apiKey: null },
        localModel: noProfiles(),
      }),
    expectedUnconfigured: { kind: 'anthropic', status: 'missing' },
  },
  openrouter: {
    kind: 'openrouter',
    reason: 'OpenRouter OAuth gateway — validity is the presence of an OAuth token.',
    codexConnected: false,
    valid: () =>
      buildSettings({
        activeProvider: 'openrouter',
        claude: { ...buildSettings().models, apiKey: null },
        localModel: noProfiles(),
        openRouter: { enabled: true, oauthToken: 'or-token', selectedModel: 'anthropic/claude-sonnet-4.6' },
      }),
    expectedValid: { kind: 'openrouter', status: 'valid', oauthToken: 'or-token' },
    unconfigured: () =>
      buildSettings({
        activeProvider: 'openrouter',
        claude: { ...buildSettings().models, apiKey: null },
        localModel: noProfiles(),
        openRouter: { enabled: true, oauthToken: null, selectedModel: 'anthropic/claude-sonnet-4.6' },
      }),
    expectedUnconfigured: { kind: 'openrouter', status: 'missing' },
  },
  codex: {
    kind: 'codex',
    reason: 'ChatGPT Pro subscription — validity is the connected flag, not a stored key.',
    codexConnected: true,
    codexConnectedUnconfigured: false,
    valid: () =>
      buildSettings({
        activeProvider: 'codex',
        claude: { ...buildSettings().models, apiKey: null },
        localModel: noProfiles(),
      }),
    expectedValid: { kind: 'codex', status: 'connected', profile: null },
    unconfigured: () =>
      buildSettings({
        activeProvider: 'codex',
        claude: { ...buildSettings().models, apiKey: null },
        localModel: noProfiles(),
      }),
    expectedUnconfigured: { kind: 'codex', status: 'disconnected' },
  },
  mindstone: {
    kind: 'mindstone',
    reason: 'Mindstone managed subscription — validity is always true at this gate; the managed-key probe is fail-closed downstream.',
    codexConnected: false,
    valid: () =>
      buildSettings({
        activeProvider: 'mindstone',
        claude: { ...buildSettings().models, apiKey: null },
        localModel: noProfiles(),
      }),
    expectedValid: { kind: 'mindstone', status: 'valid' },
    // Mindstone has no "unconfigured" credential state at this gate — the same
    // settings shape always resolves `valid` (downstream probe handles absence).
    unconfigured: () =>
      buildSettings({
        activeProvider: 'mindstone',
        claude: { ...buildSettings().models, apiKey: null },
        localModel: noProfiles(),
      }),
    expectedUnconfigured: { kind: 'mindstone', status: 'valid' },
  },
} satisfies Record<ActiveProvider, ExpectedCredentialClass>;

const originalAnthropicApiKey = process.env.ANTHROPIC_API_KEY;

describe('validateProviderCredentials — credential/admission totality gate', () => {
  beforeEach(() => {
    delete process.env.ANTHROPIC_API_KEY;
  });

  afterEach(() => {
    if (originalAnthropicApiKey === undefined) {
      delete process.env.ANTHROPIC_API_KEY;
    } else {
      process.env.ANTHROPIC_API_KEY = originalAnthropicApiKey;
    }
  });

  it('classifies every ActiveProvider (a new provider fails to compile until classified)', () => {
    // The `satisfies Record<ActiveProvider, …>` above is the real teeth; this
    // guards against an empty/duplicated map and pins the union membership so a
    // silent `default → Anthropic` fall-through can never re-appear unclassified.
    expect(Object.keys(CREDENTIAL_VALIDATION_CLASSIFICATION).sort()).toEqual(
      ['anthropic', 'codex', 'mindstone', 'openrouter'],
    );
  });

  const entries = Object.entries(CREDENTIAL_VALIDATION_CLASSIFICATION) as Array<
    [ActiveProvider, ExpectedCredentialClass]
  >;

  it.each(entries)(
    "provider '%s' with a valid credential resolves to its declared credential kind (NOT the Anthropic default)",
    (provider, cls) => {
      const state = validateProviderCredentials(cls.valid(), cls.codexConnected);
      expect(state.kind, `provider '${provider}' must resolve to kind '${cls.kind}' (${cls.reason})`).toBe(cls.kind);
      expect(state).toEqual(cls.expectedValid);
    },
  );

  it.each(entries)(
    "provider '%s' with NO credential resolves to its declared unconfigured shape",
    (provider, cls) => {
      const state = validateProviderCredentials(
        cls.unconfigured(),
        cls.codexConnectedUnconfigured ?? cls.codexConnected,
      );
      expect(state.kind, `provider '${provider}' unconfigured must resolve to kind '${cls.kind}'`).toBe(cls.kind);
      expect(state).toEqual(cls.expectedUnconfigured);
    },
  );

  it('the `undefined` activeProvider fallback (260602/FOX-3494 path) is deliberately the Anthropic arm', () => {
    // `case undefined` shares the Anthropic arm by design (no active selection ⇒
    // BYOK default). This pins THAT specific intent so the only thing the
    // `default` clause is allowed to absorb is `undefined` — every named provider
    // is forced through the totality map above.
    const settings = buildSettings({
      activeProvider: undefined,
      claude: { ...buildSettings().models, apiKey: null },
      localModel: noProfiles(),
    });
    expect(validateProviderCredentials(settings, true)).toEqual({
      kind: 'anthropic',
      status: 'missing',
    });
  });
});
