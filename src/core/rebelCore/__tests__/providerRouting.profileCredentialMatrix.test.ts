import { describe, expect, it, vi } from 'vitest';
import type { ModelProfile } from '@shared/types';
import { resolveConnectionCredentials } from '@shared/utils/connectionCredentials';

vi.mock('@core/logger', () => ({
  createScopedLogger: () => ({
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

import { ProviderRouter, type ProviderRouteSettings } from '../providerRouting';
import type {
  ProviderCredentialSource,
  ProviderInvalidReason,
  ProviderRouteDecision,
} from '../providerRouteDecision';

/**
 * B3 profile-credential reachability matrix — the 260513-shape regression net.
 *
 * The fragility this backstops: profile credential classification is split between
 * `profileDecision()` (providerRouting.ts — the OpenRouter shared-OAuth intercept and
 * the `resolveProfileApiKey()` fall-through after it) and the client-side
 * `resolveConnectionCredentials()` (shared/utils/connectionCredentials.ts).
 * There was no single net asserting "a profile route is dispatchable IFF its
 * credential is actually reachable."
 *
 * The 260513 incident shape: an OpenRouter profile authenticates via the shared
 * `settings.openRouter.oauthToken`, NOT a per-profile API key. If the router
 * classified reachability through the api-key resolver alone (as the legacy path
 * did), the OAuth token was invisible — the route fell to
 * `missing-profile-credentials` even though the credential WAS reachable. The 260513
 * fix wired OAuth resolution for connection-managed profiles; the 260611 fix
 * generalised it to ANY keyless OpenRouter profile (user-added custom models get
 * `profileSource: undefined`/`'user'`, not `'connection'`, so they were left
 * dead-ending — see the `openrouter+user / oauth present` rows below). This matrix
 * asserts dispatchability tracks the SAME reachability the client-side resolver sees,
 * so the divergence cannot regress silently.
 *
 * Non-vacuousness: each row pins both (a) whether the route is dispatchable and
 * (b) the exact terminal invalidReason/credentialSource. If the OAuth-invisible bug
 * regressed, the `openrouter+connection / oauth present` row would flip from
 * dispatchable→terminal (and `resolveConnectionCredentials` would diverge from the
 * router) — the `reachabilityMatchesResolver` assertion below would go RED. A pair of
 * explicit guard tests at the bottom prove the matrix would catch a divergence by
 * deliberately constructing the bug shape and asserting the test would fail on it.
 */

interface MatrixRow {
  readonly name: string;
  readonly profile: ModelProfile;
  readonly settings: ProviderRouteSettings;
  readonly codexConnectivity?: 'connected' | 'disconnected';
  /** Whether the credential is actually reachable (drives the dispatchable IFF). */
  readonly credentialReachable: boolean;
  readonly expectDispatchable: boolean;
  readonly expectedCredentialSource: ProviderCredentialSource;
  readonly expectedInvalidReason: ProviderInvalidReason;
  /** Whether resolveConnectionCredentials should agree the credential is reachable. */
  readonly resolverReachable: boolean;
}

function baseSettings(overrides: Partial<ProviderRouteSettings> = {}): ProviderRouteSettings {
  return {
    activeProvider: 'anthropic',
    models: { apiKey: 'fake-ant-test', oauthToken: null, authMethod: 'api-key', model: 'claude-sonnet-4-6' },
    openRouter: { enabled: false, oauthToken: null, selectedModel: 'anthropic/claude-sonnet-4.6' },
    localModel: { activeProfileId: null, profiles: [] },
    providerKeys: {},
    ...overrides,
  };
}

function withProfile(profile: ModelProfile, settings: ProviderRouteSettings): ProviderRouteSettings {
  return {
    ...settings,
    localModel: { activeProfileId: null, profiles: [profile] },
  };
}

function profile(overrides: Partial<ModelProfile> & Pick<ModelProfile, 'id'>): ModelProfile {
  return {
    name: overrides.name ?? overrides.id,
    serverUrl: '',
    createdAt: 1,
    ...overrides,
  };
}

const rows: readonly MatrixRow[] = [
  // ── openrouter + connection (the 260513 shape) ──────────────────────────────
  {
    name: 'openrouter+connection / oauth present',
    profile: profile({
      id: 'or-conn',
      providerType: 'openrouter',
      profileSource: 'connection',
      serverUrl: 'https://openrouter.ai/api/v1',
      model: 'anthropic/claude-sonnet-4.6',
    }),
    settings: baseSettings({ openRouter: { enabled: true, oauthToken: 'or-oauth-token', selectedModel: '' } }),
    credentialReachable: true,
    expectDispatchable: true,
    expectedCredentialSource: 'openrouter-oauth-token',
    expectedInvalidReason: 'none',
    resolverReachable: true,
  },
  {
    name: 'openrouter+connection / oauth absent',
    profile: profile({
      id: 'or-conn',
      providerType: 'openrouter',
      profileSource: 'connection',
      serverUrl: 'https://openrouter.ai/api/v1',
      model: 'anthropic/claude-sonnet-4.6',
    }),
    settings: baseSettings({ openRouter: { enabled: false, oauthToken: null, selectedModel: '' } }),
    credentialReachable: false,
    expectDispatchable: false,
    expectedCredentialSource: 'missing-openrouter',
    expectedInvalidReason: 'missing-openrouter-credentials',
    resolverReachable: false,
  },
  // ── openrouter + per-profile key (user source) ──────────────────────────────
  {
    name: 'openrouter+user / per-profile key present',
    profile: profile({
      id: 'or-user',
      providerType: 'openrouter',
      profileSource: 'user',
      serverUrl: 'https://openrouter.ai/api/v1',
      model: 'anthropic/claude-sonnet-4.6',
      apiKey: 'or-profile-key',
    }),
    settings: baseSettings(),
    credentialReachable: true,
    expectDispatchable: true,
    expectedCredentialSource: 'profile-api-key',
    expectedInvalidReason: 'none',
    resolverReachable: true,
  },
  {
    // No per-profile key AND no OAuth ⇒ unreachable. As of the 260611 fix the
    // terminal reason is `missing-openrouter` (not `missing-profile`): a keyless
    // OpenRouter profile of ANY profileSource resolves through the shared OAuth
    // channel, so the right "you're not connected" signal is the OpenRouter one.
    name: 'openrouter+user / per-profile key absent, no oauth',
    profile: profile({
      id: 'or-user',
      providerType: 'openrouter',
      profileSource: 'user',
      serverUrl: 'https://openrouter.ai/api/v1',
      model: 'anthropic/claude-sonnet-4.6',
    }),
    settings: baseSettings(),
    credentialReachable: false,
    expectDispatchable: false,
    expectedCredentialSource: 'missing-openrouter',
    expectedInvalidReason: 'missing-openrouter-credentials',
    resolverReachable: false,
  },
  // ── openrouter + user-added custom model + OAuth present (the 260611 shape) ──
  // A user who has OAuth'd to OpenRouter then adds a custom model gets a profile
  // with profileSource 'user' (or undefined — the wizard's buildProfile never
  // stamps it) and NO per-profile key (OpenRouter's preset is OAuth-only). The
  // account-wide OAuth token must authenticate it, exactly as it does for
  // connection-managed profiles. Before the fix these dead-ended at
  // missing-profile-credentials ("asks for an API key, doesn't work after OAuth").
  {
    name: 'openrouter+user / oauth present (user-added custom model)',
    profile: profile({
      id: 'or-user-oauth',
      providerType: 'openrouter',
      profileSource: 'user',
      serverUrl: 'https://openrouter.ai/api/v1',
      model: 'x-ai/grok-4',
    }),
    settings: baseSettings({ openRouter: { enabled: true, oauthToken: 'or-oauth-token', selectedModel: '' } }),
    credentialReachable: true,
    expectDispatchable: true,
    expectedCredentialSource: 'openrouter-oauth-token',
    expectedInvalidReason: 'none',
    resolverReachable: true,
  },
  {
    // The literal wizard output: profileSource omitted entirely.
    name: 'openrouter+undefined-source / oauth present (literal wizard output)',
    profile: profile({
      id: 'or-undef-oauth',
      providerType: 'openrouter',
      serverUrl: 'https://openrouter.ai/api/v1',
      model: 'x-ai/grok-4',
    }),
    settings: baseSettings({ openRouter: { enabled: true, oauthToken: 'or-oauth-token', selectedModel: '' } }),
    credentialReachable: true,
    expectDispatchable: true,
    expectedCredentialSource: 'openrouter-oauth-token',
    expectedInvalidReason: 'none',
    resolverReachable: true,
  },
  {
    // Whitespace-only OAuth token must read as MISSING — the router's
    // hasOpenRouterCredentials() sanitizes before the presence check, matching
    // the client resolver (normalizeApiKey) and the profileSource migration.
    // A raw truthiness check would wrongly dispatch a blank token (260611 F1).
    name: 'openrouter+user / whitespace-only oauth (treated as missing)',
    profile: profile({
      id: 'or-user-blank-oauth',
      providerType: 'openrouter',
      profileSource: 'user',
      serverUrl: 'https://openrouter.ai/api/v1',
      model: 'x-ai/grok-4',
    }),
    settings: baseSettings({ openRouter: { enabled: true, oauthToken: '   ', selectedModel: '' } }),
    credentialReachable: false,
    expectDispatchable: false,
    expectedCredentialSource: 'missing-openrouter',
    expectedInvalidReason: 'missing-openrouter-credentials',
    resolverReachable: false,
  },
  {
    // BYOK via the shared providerKeys.openrouter channel: an explicit key skips
    // the OAuth intercept and routes profile-direct. Locks BYOK precedence.
    name: 'openrouter+user / providerKeys.openrouter present, no oauth (BYOK)',
    profile: profile({
      id: 'or-user-providerkey',
      providerType: 'openrouter',
      profileSource: 'user',
      serverUrl: 'https://openrouter.ai/api/v1',
      model: 'x-ai/grok-4',
    }),
    settings: baseSettings({ providerKeys: { openrouter: 'or-shared-key' } }),
    credentialReachable: true,
    expectDispatchable: true,
    expectedCredentialSource: 'profile-api-key',
    expectedInvalidReason: 'none',
    resolverReachable: true,
  },
  {
    // BYOK wins over OAuth: with BOTH a shared providerKeys.openrouter key AND an
    // OAuth token present, the explicit key takes precedence (OAuth intercept is
    // skipped). Pins the precedence ordering.
    name: 'openrouter+user / providerKeys.openrouter AND oauth present (BYOK wins)',
    profile: profile({
      id: 'or-user-providerkey-oauth',
      providerType: 'openrouter',
      profileSource: 'user',
      serverUrl: 'https://openrouter.ai/api/v1',
      model: 'x-ai/grok-4',
    }),
    settings: baseSettings({
      providerKeys: { openrouter: 'or-shared-key' },
      openRouter: { enabled: true, oauthToken: 'or-oauth-token', selectedModel: '' },
    }),
    credentialReachable: true,
    expectDispatchable: true,
    expectedCredentialSource: 'profile-api-key',
    expectedInvalidReason: 'none',
    resolverReachable: true,
  },
  // ── anthropic profile (settings key present vs absent) ──────────────────────
  {
    name: 'anthropic profile / settings api-key present',
    profile: profile({ id: 'ant', providerType: 'anthropic', profileSource: 'connection', serverUrl: '', model: 'claude-sonnet-4-6' }),
    settings: baseSettings({ models: { apiKey: 'fake-ant-test', oauthToken: null, authMethod: 'api-key', model: 'claude-sonnet-4-6' } }),
    credentialReachable: true,
    expectDispatchable: true,
    expectedCredentialSource: 'anthropic-api-key',
    expectedInvalidReason: 'none',
    // Managed anthropic profiles read the Anthropic settings key, not a per-profile key.
    resolverReachable: true,
  },
  {
    name: 'anthropic profile / settings api-key absent',
    profile: profile({ id: 'ant', providerType: 'anthropic', profileSource: 'connection', serverUrl: '', model: 'claude-sonnet-4-6' }),
    settings: baseSettings({ models: { apiKey: null, oauthToken: null, authMethod: 'api-key', model: 'claude-sonnet-4-6' } }),
    credentialReachable: false,
    expectDispatchable: false,
    expectedCredentialSource: 'missing-anthropic',
    expectedInvalidReason: 'missing-anthropic-credentials',
    resolverReachable: false,
  },
  {
    // E2b edge (c) — the `getApiKey` (models-only) vs `resolveModelSettings`
    // read-asymmetry the SCOPE NOTE flagged. Settings carry ONLY a legacy
    // `claude.apiKey` (no `models.apiKey`). CURRENT BEHAVIOUR: the asymmetry is
    // CLOSED — neither side reads legacy `claude.*`. The router's `getApiKey`
    // reads `settings.models.apiKey` only; the client's credential ladder uses
    // `resolveModelSettings(settings)`, which (unlike the separate
    // `materializeModelsFromLegacy`) also reads `models.*` only. Both fail closed
    // to `missing-anthropic`, so this is a NON-divergent row living in the main
    // matrix — pinning that legacy `claude.apiKey` is invisible to BOTH today
    // (WS1c must not "reconcile" by teaching one side to read legacy without the
    // other; pinning it here makes a one-sided change go RED).
    name: 'anthropic profile / only legacy claude.apiKey present (legacy read closed on both sides)',
    profile: profile({ id: 'ant-legacy', providerType: 'anthropic', profileSource: 'connection', serverUrl: '', model: 'claude-sonnet-4-6' }),
    settings: baseSettings({
      models: { apiKey: null, oauthToken: null, authMethod: 'api-key', model: 'claude-sonnet-4-6' },
      // Legacy namespace carrying the only credential. Typed via cast — the
      // ProviderRouteSettings boundary intentionally does not surface `claude`.
      ...({ claude: { apiKey: 'legacy-claude-key' } } as Partial<ProviderRouteSettings>),
    }),
    credentialReachable: false,
    expectDispatchable: false,
    expectedCredentialSource: 'missing-anthropic',
    expectedInvalidReason: 'missing-anthropic-credentials',
    resolverReachable: false,
  },
  // ── openai profile key present vs absent ────────────────────────────────────
  {
    name: 'openai profile / per-profile key present',
    profile: profile({
      id: 'oai',
      providerType: 'openai',
      serverUrl: 'https://api.openai.com/v1',
      model: 'gpt-5.5',
      apiKey: 'fake-openai-key',
    }),
    settings: baseSettings(),
    credentialReachable: true,
    expectDispatchable: true,
    expectedCredentialSource: 'openai-api-key',
    expectedInvalidReason: 'none',
    resolverReachable: true,
  },
  {
    name: 'openai profile / key absent',
    profile: profile({
      id: 'oai',
      providerType: 'openai',
      serverUrl: 'https://api.openai.com/v1',
      model: 'gpt-5.5',
    }),
    settings: baseSettings(),
    credentialReachable: false,
    expectDispatchable: false,
    expectedCredentialSource: 'missing-profile',
    expectedInvalidReason: 'missing-profile-credentials',
    resolverReachable: false,
  },
  // ── together profile (shared providerKeys reachability) ─────────────────────
  {
    name: 'together profile / shared providerKeys key present',
    profile: profile({
      id: 'tog',
      providerType: 'together',
      serverUrl: 'https://api.together.xyz/v1',
      model: 'deepseek-ai/DeepSeek-V3',
    }),
    settings: baseSettings({ providerKeys: { together: 'fake-together-key' } }),
    credentialReachable: true,
    expectDispatchable: true,
    expectedCredentialSource: 'profile-api-key',
    expectedInvalidReason: 'none',
    resolverReachable: true,
  },
  {
    name: 'together profile / no key anywhere',
    profile: profile({
      id: 'tog',
      providerType: 'together',
      serverUrl: 'https://api.together.xyz/v1',
      model: 'deepseek-ai/DeepSeek-V3',
    }),
    settings: baseSettings(),
    credentialReachable: false,
    expectDispatchable: false,
    expectedCredentialSource: 'missing-profile',
    expectedInvalidReason: 'missing-profile-credentials',
    resolverReachable: false,
  },
  // ── codex-subscription profile (session reachability via connectivity) ──────
  {
    name: 'codex-subscription profile / connected',
    profile: profile({
      id: 'codex',
      providerType: 'openai',
      authSource: 'codex-subscription',
      profileSource: 'auto',
      serverUrl: 'https://api.openai.com/v1',
      model: 'gpt-5.5',
    }),
    settings: baseSettings(),
    codexConnectivity: 'connected',
    credentialReachable: true,
    expectDispatchable: true,
    expectedCredentialSource: 'codex-subscription',
    expectedInvalidReason: 'none',
    resolverReachable: true,
  },
  {
    name: 'codex-subscription profile / disconnected',
    profile: profile({
      id: 'codex',
      providerType: 'openai',
      authSource: 'codex-subscription',
      profileSource: 'auto',
      serverUrl: 'https://api.openai.com/v1',
      model: 'gpt-5.5',
    }),
    settings: baseSettings(),
    codexConnectivity: 'disconnected',
    credentialReachable: false,
    expectDispatchable: false,
    expectedCredentialSource: 'missing-codex',
    expectedInvalidReason: 'codex-disconnected-bts-blocked',
    // resolveConnectionCredentials only sees a codex session when codexMode is passed;
    // a disconnected codex profile has no reachable credential.
    resolverReachable: false,
  },
  // ── local / none (no credential required) ───────────────────────────────────
  {
    name: 'local profile / no credential required',
    profile: profile({
      id: 'local',
      providerType: 'local',
      serverUrl: 'http://localhost:1234/v1',
      model: 'llama-3',
    }),
    settings: baseSettings(),
    credentialReachable: true,
    expectDispatchable: true,
    expectedCredentialSource: 'local-none',
    expectedInvalidReason: 'none',
    // local connection profiles intentionally return {} (no credential) and are reachable.
    resolverReachable: true,
  },
];

/**
 * Asserts a profile route is dispatchable IFF its credential is reachable, and
 * carries the correct credentialSource/invalidReason in either branch.
 */
function assertReachabilityInvariant(decision: ProviderRouteDecision, row: MatrixRow): void {
  expect(decision.profileId).toBe(row.profile.id);
  expect(decision.credentialSource).toBe(row.expectedCredentialSource);
  expect(decision.invalidReason).toBe(row.expectedInvalidReason);

  if (row.expectDispatchable) {
    expect(decision.kind).toBe('dispatchable');
    expect(decision.invalidReason).toBe('none');
    // dispatchable IFF reachable
    expect(row.credentialReachable).toBe(true);
  } else {
    expect(decision.kind).toBe('terminal');
    expect(decision.invalidReason).not.toBe('none');
    // terminal IFF NOT reachable
    expect(row.credentialReachable).toBe(false);
  }

  // The router's dispatchability must track the SAME reachability the client-side
  // credential resolver computes. This is the SSOT-divergence guard: if the two
  // sides disagree (the 260513 OAuth-invisible bug), this assertion goes RED.
  expect(decision.kind === 'dispatchable').toBe(row.credentialReachable);
}

describe('B3 profile-credential reachability matrix (260513 regression net)', () => {
  it.each(rows.map((row) => ({ ...row })))('forTurn $name', (row) => {
    const settings = withProfile(row.profile, row.settings);
    const decision = ProviderRouter.forTurn({
      settings,
      model: `profile:${row.profile.id}`,
      profile: row.profile,
      codexConnectivity: row.codexConnectivity ?? 'unknown',
    });
    assertReachabilityInvariant(decision, row);
  });

  // BTS and subagent forward bare settings; reachability must hold identically.
  it.each(rows.map((row) => ({ ...row })))('forBTS $name', (row) => {
    const settings = withProfile(row.profile, row.settings);
    const decision = ProviderRouter.forBTS({
      settings,
      model: `profile:${row.profile.id}`,
      profile: row.profile,
      codexConnectivity: row.codexConnectivity ?? 'unknown',
    });
    expect(decision.credentialSource).toBe(row.expectedCredentialSource);
    expect(decision.kind === 'dispatchable').toBe(row.credentialReachable);
  });

  it.each(rows.map((row) => ({ ...row })))('forSubagent $name', (row) => {
    const settings = withProfile(row.profile, row.settings);
    const decision = ProviderRouter.forSubagent({
      settings,
      model: `profile:${row.profile.id}`,
      profile: row.profile,
      codexConnectivity: row.codexConnectivity ?? 'unknown',
    });
    expect(decision.credentialSource).toBe(row.expectedCredentialSource);
    expect(decision.kind === 'dispatchable').toBe(row.credentialReachable);
  });

  // SSOT cross-check: resolveConnectionCredentials (the client-side resolver) must
  // agree on reachability for the same profile+settings. The 260513 bug was exactly
  // a divergence between this resolver and the router's profileDecision().
  it.each(rows.map((row) => ({ ...row })))('resolveConnectionCredentials agrees on reachability — $name', (row) => {
    const settings = withProfile(row.profile, row.settings);
    const codexMode = row.codexConnectivity === 'connected' ? 'connected' : undefined;
    let resolverSeesCredential: boolean;
    try {
      const creds = resolveConnectionCredentials(row.profile, settings as never, codexMode);
      resolverSeesCredential = Boolean(
        creds.apiKey || creds.oauthToken || creds.sessionMode === 'codex' ||
        // local connection profiles intentionally return {} but ARE reachable
        (row.profile.providerType === 'local'),
      );
    } catch {
      // ConnectionNotConfiguredError ⇒ no reachable credential
      resolverSeesCredential = false;
    }
    expect(resolverSeesCredential).toBe(row.resolverReachable);
    // The two sides MUST agree — this is the divergence net.
    expect(resolverSeesCredential).toBe(row.credentialReachable);
  });
});

/**
 * Non-vacuousness proof. These tests deliberately construct the 260513 bug shape and
 * assert that the matrix's reachability invariant WOULD reject it. If someone weakened
 * the matrix into a tautology, these guards would fail because the bad shape would
 * (wrongly) pass `assertReachabilityInvariant`.
 */
describe('B3 matrix is non-vacuous', () => {
  it('rejects an OAuth-reachable OpenRouter-connection route that the router marked terminal (the 260513 bug)', () => {
    const orConnProfile = profile({
      id: 'or-conn-bug',
      providerType: 'openrouter',
      profileSource: 'connection',
      serverUrl: 'https://openrouter.ai/api/v1',
      model: 'anthropic/claude-sonnet-4.6',
    });
    const settings = withProfile(
      orConnProfile,
      baseSettings({ openRouter: { enabled: true, oauthToken: 'or-oauth-token', selectedModel: '' } }),
    );
    // The real (fixed) router yields a dispatchable decision here.
    const decision = ProviderRouter.forTurn({
      codexConnectivity: 'unknown',
      settings,
      model: `profile:${orConnProfile.id}`,
      profile: orConnProfile,
    });
    expect(decision.kind).toBe('dispatchable');

    // Simulate the regressed router: api-key resolver is blind to the OAuth token,
    // so it falls to missing-profile-credentials even though OAuth IS reachable.
    const regressedDecision: ProviderRouteDecision = {
      ...decision,
      kind: 'terminal',
      transport: 'no-credentials',
      dispatchPath: 'none',
      credentialSource: 'missing-profile',
      invalidReason: 'missing-profile-credentials',
    };
    const buggyRow: MatrixRow = {
      name: 'regressed',
      profile: orConnProfile,
      settings,
      credentialReachable: true, // OAuth token IS reachable
      expectDispatchable: true,
      expectedCredentialSource: 'openrouter-oauth-token',
      expectedInvalidReason: 'none',
      resolverReachable: true,
    };
    // The invariant must FAIL on the regressed (terminal) decision — proving the net
    // would catch the bug rather than vacuously passing.
    expect(() => assertReachabilityInvariant(regressedDecision, buggyRow)).toThrow();
  });

  /**
   * DOCUMENTED, INTENTIONAL divergence (Stage E2b boundary): a non-managed Anthropic profile
   * carrying a per-profile `apiKey`. The router (`profileDecision`) keys Anthropic reachability
   * on the GLOBAL settings credential and ignores `profile.apiKey`, so it is TERMINAL; the client
   * resolver (`resolveCredentialsForProfile`) honours the per-profile key, so it is REACHABLE.
   * This is the one place the router and client deliberately disagree — and it is UNREACHABLE in
   * practice because the profile wizard excludes Anthropic BYOK profiles
   * (`WizardProviderType = Exclude<ModelProviderType, 'anthropic' | 'local'>`). This test pins the
   * divergence so it is observable: if a BYOK-Anthropic-profile flow is ever added, this test must
   * be revisited and the router's Anthropic branch routed through the chokepoint (Stage E2b).
   */
  it('pins the intentional router/client divergence for a per-profile Anthropic key (unsupported config)', () => {
    const anthropicByokProfile = profile({
      id: 'ant-byok',
      providerType: 'anthropic',
      profileSource: 'user',
      serverUrl: '',
      model: 'claude-sonnet-4-6',
      apiKey: 'per-profile-ant-key',
    });
    // No global Anthropic settings credential.
    const settings = withProfile(
      anthropicByokProfile,
      baseSettings({ models: { apiKey: null, oauthToken: null, authMethod: 'api-key', model: 'claude-sonnet-4-6' } }),
    );

    // Router: ignores the per-profile key → terminal / missing-anthropic.
    const decision = ProviderRouter.forTurn({
      codexConnectivity: 'unknown',
      settings,
      model: `profile:${anthropicByokProfile.id}`,
      profile: anthropicByokProfile,
    });
    expect(decision.kind).toBe('terminal');
    expect(decision.credentialSource).toBe('missing-anthropic');

    // Client: honours the per-profile key → reachable.
    const creds = resolveConnectionCredentials(anthropicByokProfile, settings as never);
    expect(creds.apiKey).toBe('per-profile-ant-key');
  });

  /**
   * E2b edge (a): `anthropic-oauth-token` reachability. The matrix's other
   * anthropic rows only exercise the api-key path; this pins the OAuth path AND
   * the router/client divergence on it. An anthropic profile with NO settings
   * api-key but a settings OAuth token (`authMethod: 'oauth-token'`):
   *  - Router (`profileDecision`): keys reachability on the GLOBAL settings
   *    credential and recognises the OAuth token (via the single authority
   *    `classifyAnthropicSettingsCredential`) → DISPATCHABLE, `anthropic-oauth-token`.
   *  - Client (`resolveCredentialsForProfile`, managed-anthropic branch): reads
   *    ONLY `resolveModelSettings(settings).apiKey` — it never inspects the
   *    Anthropic OAuth token — so it is UNREACHABLE (throws).
   * They DIVERGE, and the divergence is INTENTIONAL + HARMLESS: nothing dispatches an
   * Anthropic profile through the client resolver (Anthropic goes anthropic-direct via
   * `createDirectAnthropicClient`, never `createOpenAIClientFromProfile` / the proxy bearer
   * path that consume this verdict). The client arm is deliberately kept api-key-only so it
   * cannot mis-project an Anthropic OAuth token as an OpenAI-style bearer (WS1c AUTH review).
   * This is the inverse shape of the per-profile-key pin above (router reachable / client not,
   * vs client reachable / router not). NOTE: Claude Max OAuth was deprecated April 2026
   * (`anthropic-oauth-token` is a legacy credentialSource), so this edge is largely vestigial —
   * but the router branch still classifies it, so it must be locked.
   */
  it('pins the intentional router/client divergence for an anthropic-oauth-token route (E2b edge a)', () => {
    const anthropicOAuthProfile = profile({
      id: 'ant-oauth',
      providerType: 'anthropic',
      profileSource: 'connection',
      serverUrl: '',
      model: 'claude-sonnet-4-6',
    });
    const settings = withProfile(
      anthropicOAuthProfile,
      baseSettings({ models: { apiKey: null, oauthToken: 'ant-oauth-token', authMethod: 'oauth-token', model: 'claude-sonnet-4-6' } }),
    );

    // Router: recognises the settings OAuth token → dispatchable / anthropic-oauth-token.
    const decision = ProviderRouter.forTurn({
      codexConnectivity: 'unknown',
      settings,
      model: `profile:${anthropicOAuthProfile.id}`,
      profile: anthropicOAuthProfile,
    });
    expect(decision.kind).toBe('dispatchable');
    expect(decision.credentialSource).toBe('anthropic-oauth-token');

    // Client: blind to the Anthropic OAuth token (api-key-only ladder) → unreachable.
    let clientReachable = true;
    try {
      const creds = resolveConnectionCredentials(anthropicOAuthProfile, settings as never);
      clientReachable = Boolean(creds.apiKey || creds.oauthToken || creds.sessionMode === 'codex');
    } catch {
      clientReachable = false;
    }
    expect(clientReachable).toBe(false);
  });

  it('rejects a route marked dispatchable when its credential is NOT reachable', () => {
    const oaiProfile = profile({
      id: 'oai-bug',
      providerType: 'openai',
      serverUrl: 'https://api.openai.com/v1',
      model: 'gpt-5.5',
    });
    const settings = withProfile(oaiProfile, baseSettings());
    const decision = ProviderRouter.forTurn({
      codexConnectivity: 'unknown',
      settings,
      model: `profile:${oaiProfile.id}`,
      profile: oaiProfile,
    });
    expect(decision.kind).toBe('terminal');

    // Simulate a regression that wrongly dispatches with no key.
    const regressedDecision: ProviderRouteDecision = {
      ...decision,
      kind: 'dispatchable',
      transport: 'openai-compatible-http',
      dispatchPath: 'direct-provider',
      credentialSource: 'openai-api-key',
      invalidReason: 'none',
    };
    const buggyRow: MatrixRow = {
      name: 'regressed-dispatchable',
      profile: oaiProfile,
      settings,
      credentialReachable: false,
      expectDispatchable: false,
      expectedCredentialSource: 'missing-profile',
      expectedInvalidReason: 'missing-profile-credentials',
      resolverReachable: false,
    };
    expect(() => assertReachabilityInvariant(regressedDecision, buggyRow)).toThrow();
  });
});
