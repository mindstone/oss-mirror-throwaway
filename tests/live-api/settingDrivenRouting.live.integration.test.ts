/**
 * Gated live-LLM integration test — SETTING-driven routing (anthropic-direct).
 *
 * Drives the production behind-the-scenes seam (`callWithModelAuthAware` →
 * `createBtsRoutePlan` → `anthropic-direct` transport) using AppSettings whose
 * `activeProvider: 'anthropic'` SETTING — and NOT an explicit `ModelProfile` —
 * selects the provider/auth axis. This is the flagship gap the deterministic
 * corpus cannot cover: that the activeProvider SETTING drives a real, metered
 * anthropic-direct request end-to-end, and that a present-but-invalid key
 * fails closed with a CLASSIFIED auth error rather than crashing/hanging.
 *
 * Why this exists (docs/plans/260529_ci-live-eval-harness/PLAN.md §Amendments,
 * subagent_reports/260529_seam-spike.md):
 *  - The pilot (`openrouterDeepSeek.live.integration.test.ts`) drives routing
 *    from an explicit `ModelProfile`, which BYPASSES `selectProviderMode` — so
 *    it does not prove the *setting* drives routing. This test closes that gap.
 *  - The spike established: `activeProvider:'anthropic'` + api-key (no profile)
 *    → `transport:'anthropic-direct'` / `proxyRequired:false`. The adapter
 *    `fetch`es `https://api.anthropic.com/v1/messages` directly, so the call is
 *    live-callable from a plain vitest test with no proxy/IPC/Electron.
 *
 * Gating contract:
 *  - Gated SOLELY on `process.env.TEST_ANTHROPIC_API_KEY` (loaded from
 *    `.env.test` by vitest.setup.ts). Absent key → the whole describe SKIPS,
 *    never fails, so CI without secrets stays green.
 *  - The gate intentionally does NOT touch any auth-shape helper
 *    (getAuthForDirectUse / getApiKeyForDirectUse / hasDirectAuth) and never
 *    READS a `settings.claude.*` field. Settings are built via a pure object
 *    literal where `models: { apiKey: ... }` is a WRITE (property assignment),
 *    so scripts/check-integration-test-provider-gates.ts reports no violation.
 */
import { afterEach, beforeEach, expect, it } from 'vitest';
import type { AppSettings } from '@shared/types';
import { ModelError } from '@core/rebelCore/modelErrors';
import {
  callWithModelAuthAware,
  createBtsRoutePlan,
  registerManagedKeyAvailability,
  declareNoBtsProxy,
} from '@core/services/behindTheScenesClient';
import { describeLiveApi } from '../../src/test-utils/liveApiHarness';

// Cheapest flagship Anthropic model. A tiny maxTokens keeps cost ~$1e-4.
const MODEL = 'claude-haiku-4-5';
const MAX_TOKENS = 32;
const LIVE_TIMEOUT_MS = 60_000;

// An obviously-bogus key. Anthropic 401s any invalid key pre-generation, so this
// cell is effectively free. Intentionally given a neutral, non-provider-prefixed
// literal: the contract under test is "invalid key -> classified 401", not the key
// shape, and a realistic provider-style literal trips the test-token drift pre-push
// guard (260419 postmortem). No client-side key-format gate, so it is still sent + rejected.
const BOGUS_KEY = 'fake-invalid-anthropic-key-000000000000000000000000000000';

/**
 * Minimal AppSettings built from a pure object literal. `activeProvider`
 * drives the provider axis; `models: { apiKey }` is a WRITE (so the
 * provider-gate AST check does not flag it) supplying the credential the
 * anthropic-direct transport reads from `plan.auth`. There is intentionally
 * NO `localModel` profile so routing is driven solely by the setting.
 */
function makeSettings(apiKey: string): AppSettings {
  return {
    activeProvider: 'anthropic',
    coreDirectory: '/tmp/test',
    models: {
      apiKey,
      oauthToken: null,
      authMethod: 'api-key',
      model: 'claude-sonnet-4-6',
    },
    openRouter: { enabled: false, oauthToken: null, selectedModel: null },
    providerKeys: {},
    customProviders: [],
    localModel: { activeProfileId: null, profiles: [] },
  } as unknown as AppSettings;
}

/**
 * Contrast settings IDENTICAL to makeSettings EXCEPT activeProvider is flipped
 * to 'openrouter' (with an OpenRouter token present). This is the deterministic
 * causation control for FIX 1: it proves the `activeProvider` SETTING — not just
 * "native Claude model + Anthropic key" — is the load-bearing cause of the
 * anthropic-direct route. Same haiku model + same Anthropic key, only the
 * provider setting differs. Confirmed at runtime: this yields
 * transport:'openrouter-proxy' (NOT 'anthropic-direct'), whereas the
 * activeProvider:'anthropic' build yields 'anthropic-direct'.
 *
 * The OpenRouter token is a dummy used ONLY for routing (no live call is made
 * against the contrast settings), so it never touches the network.
 */
function makeContrastSettings(apiKey: string): AppSettings {
  return {
    activeProvider: 'openrouter',
    coreDirectory: '/tmp/test',
    models: {
      apiKey,
      oauthToken: null,
      authMethod: 'api-key',
      model: 'claude-sonnet-4-6',
    },
    openRouter: { enabled: true, oauthToken: 'or-routing-only-dummy-token', selectedModel: null },
    providerKeys: {},
    customProviders: [],
    localModel: { activeProfileId: null, profiles: [] },
  } as unknown as AppSettings;
}

function btsOptions() {
  return {
    messages: [{ role: 'user' as const, content: 'Reply with exactly: pong' }],
    system: 'You are a terse assistant. Reply with a single word.',
    maxTokens: MAX_TOKENS,
    codexConnectivity: 'unknown' as const,
  };
}

beforeEach(() => {
  // anthropic-direct reads neither the proxy URL nor managed-key availability,
  // but the BTS module-level providers must be registered (mirror
  // behindTheScenesClient.managedKeyRegistration.test.ts) so plan
  // materialization is inert rather than reaching into unregistered globals.
  registerManagedKeyAvailability(() => false);
  declareNoBtsProxy();
});

afterEach(() => {
  registerManagedKeyAvailability(() => false);
  declareNoBtsProxy();
});

describeLiveApi(
  {
    provider: 'anthropic',
    label: 'Setting-driven anthropic-direct routing — live integration',
    envVar: 'TEST_ANTHROPIC_API_KEY',
    model: MODEL,
  },
  ({ key }) => {
  it(
    'activeProvider:anthropic SETTING (no profile) drives a real anthropic-direct call',
    async () => {
      const settings = makeSettings(key);

      // CAUSATION CONTROL (deterministic, NO live call). Prove the
      // `activeProvider` SETTING is the load-bearing cause of the route — not
      // merely "native Claude model + an Anthropic key present". We build
      // settings IDENTICAL to the happy path except activeProvider is flipped to
      // 'openrouter', and assert the route plan CHANGES away from
      // anthropic-direct. If a regression routed native Claude direct regardless
      // of the setting (e.g. the REBEL-538 native-Claude bypass), this contrast
      // would still be anthropic-direct and fail here. Runtime-confirmed:
      // activeProvider:'openrouter' + OpenRouter token → 'openrouter-proxy'.
      const contrastPlan = await createBtsRoutePlan(
        makeContrastSettings(key),
        MODEL,
        btsOptions(),
        'memory',
      );
      expect(contrastPlan.decision.transport).not.toBe('anthropic-direct');
      expect(contrastPlan.decision.transport).toBe('openrouter-proxy');

      // Routing guard: the SETTING (no explicit profile) must resolve to the
      // DIRECT anthropic path — no proxy. A future routing change that silently
      // requires the proxy fails loudly here. createBtsRoutePlan runs the same
      // ProviderRouter.forBTS the live call uses.
      const plan = await createBtsRoutePlan(settings, MODEL, btsOptions(), 'memory');
      expect(plan.decision.kind).toBe('dispatchable');
      expect(plan.decision.transport).toBe('anthropic-direct');
      expect(plan.proxyRequired).toBe(false);
      expect(plan.resolvedAuthLabel).toBe('api-key');
      // The SETTING (not a profile) drove this, with the api-key credential.
      // resolvedFrom:'settings' + credentialSource:'anthropic-api-key' together
      // with the contrast above pin the activeProvider setting as the cause.
      expect(plan.decision.resolvedFrom).toBe('settings');
      expect(plan.decision.credentialSource).toBe('anthropic-api-key');

      // The real, metered round-trip driven by the SETTING.
      const response = await callWithModelAuthAware(settings, MODEL, btsOptions(), {
        category: 'memory',
      });

      // Routing/health asserts (NOT answer quality). _resolvedAuth==='api-key'
      // proves the SETTING routed to the metered anthropic-api credential;
      // _resolvedModel is the model the BTS route SELECTED (route-selection
      // signal — the requested/resolved model string, NOT proof Anthropic served
      // it).
      expect(response._resolvedAuth).toBe('api-key');
      expect(response._resolvedModel).toContain('haiku');

      // response.model is the UPSTREAM-returned model (the Anthropic adapter sets
      // it from data.model — what Anthropic actually served). This is the served
      // signal _resolvedModel cannot give. Anthropic returns the dated haiku id.
      expect(response.model).toBeTruthy();
      expect(response.model).toContain('haiku');

      // Well-formed: non-empty content with at least one text block.
      expect(Array.isArray(response.content)).toBe(true);
      expect(response.content.length).toBeGreaterThan(0);
      const textBlocks = response.content.filter((b) => b.type === 'text');
      expect(textBlocks.length).toBeGreaterThan(0);

      // Real usage was metered.
      expect(response.usage).toBeDefined();
      expect(response.usage!.input_tokens).toBeGreaterThan(0);
      expect(response.usage!.output_tokens).toBeGreaterThan(0);
    },
    LIVE_TIMEOUT_MS,
  );

  it(
    'present-but-invalid key fails closed with a CLASSIFIED auth/401 error',
    async () => {
      const settings = makeSettings(BOGUS_KEY);

      // Routing is identical to the happy path — a valid vs invalid key are
      // indistinguishable at the routing layer (both → anthropic-direct /
      // api-key). Only a live 401 + error classification proves fail-closed.
      const plan = await createBtsRoutePlan(settings, MODEL, btsOptions(), 'memory');
      expect(plan.decision.kind).toBe('dispatchable');
      expect(plan.decision.transport).toBe('anthropic-direct');

      // Must reject with a classified ModelError, not hang/crash/timeout.
      let caught: unknown;
      try {
        await callWithModelAuthAware(settings, MODEL, btsOptions(), { category: 'memory' });
        throw new Error('expected callWithModelAuthAware to reject on invalid key');
      } catch (err) {
        caught = err;
      }

      // Distinguish provider-unreachable from a fail-closed failure. A reachable
      // Anthropic API returns 401 → classifyHttpError → ModelError('auth', 401).
      // But raw fetch() failures (DNS/TLS/outage/restricted CI network) are NOT
      // classified: withTransientRetry retries then rethrows the original
      // TypeError. Reachability is part of harness-health, so we still fail — but
      // with a CLEAR message so a future scheduled-CI network blip is
      // diagnosable rather than a confusing "expected ModelError" assertion.
      if (!(caught instanceof ModelError)) {
        throw new Error(
          'provider unreachable (network/transport) — not a wrong-key ' +
            'classification failure. The Anthropic API could not be reached, so ' +
            'the 401 fail-closed path was never exercised. This is a ' +
            'harness-health / reachability problem, not a routing regression. ' +
            `Underlying error: ${caught instanceof Error ? `${caught.name}: ${caught.message}` : String(caught)}`,
        );
      }

      const modelError = caught;
      // classifyHttpError maps status 401 → kind 'auth' (modelErrors.ts).
      expect(modelError.kind).toBe('auth');
      expect(modelError.status).toBe(401);
    },
    LIVE_TIMEOUT_MS,
  );
  },
);
