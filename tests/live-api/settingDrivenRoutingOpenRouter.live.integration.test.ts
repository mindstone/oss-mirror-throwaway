/**
 * Gated live-LLM integration test — SETTING-driven routing (openrouter-proxy).
 *
 * Drives the production behind-the-scenes seam (`callWithModelAuthAware` →
 * `createBtsRoutePlan` → `openrouter-proxy` transport → loopback proxy →
 * OpenRouter) using AppSettings whose `activeProvider: 'openrouter'` SETTING —
 * and NOT an explicit `ModelProfile` — selects the provider/auth axis.
 *
 * Gating contract:
 *  - Gated SOLELY on `TEST_OPENROUTER_API_KEY` (loaded from `.env.test` by
 *    vitest.setup.ts). Absent key -> the whole describe SKIPS, never fails, so
 *    CI without secrets stays green.
 *  - The real key enters only through the `describeLiveApi` callback and is
 *    written into the pure settings object field that production routing reads:
 *    `openRouter.oauthToken`. No assertion renders the raw Authorization value.
 */
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { AppSettings } from '@shared/types';
import { unsafeAssertRoutingModelId } from '@shared/utils/modelChoiceCodec';
import {
  callWithModelAuthAware,
  createBtsRoutePlan,
  registerManagedKeyAvailability,
  registerBtsProxyProviders,
  declareNoBtsProxy,
} from '@core/services/behindTheScenesClient';
import { describeLiveApi } from '../../src/test-utils/liveApiHarness';

const MODEL = unsafeAssertRoutingModelId('deepseek/deepseek-v4-flash');
const LIVE_TIMEOUT_MS = 60_000;
const MAX_TOKENS = 64;
let liveOpenRouterKey = '';
let nextPort = 50140;

/**
 * Minimal AppSettings built from a pure object literal. `activeProvider` drives
 * the provider axis; `openRouter.oauthToken` is the credential source read by
 * `selectProviderMode` and materialized into OpenRouter proxy auth. There is
 * intentionally NO `localModel` profile so routing is setting-driven.
 */
function makeSettings(apiKey: string): AppSettings {
  return {
    activeProvider: 'openrouter',
    coreDirectory: '/tmp/test',
    models: {
      apiKey: 'dummy-anthropic-key-not-used',
      oauthToken: null,
      authMethod: 'api-key',
      model: 'claude-sonnet-4-6',
    },
    openRouter: { enabled: true, oauthToken: apiKey, selectedModel: null },
    providerKeys: {},
    customProviders: [],
    localModel: { activeProfileId: null, profiles: [] },
  } as unknown as AppSettings;
}

function makeContrastSettings(apiKey: string): AppSettings {
  return {
    ...makeSettings(apiKey),
    activeProvider: 'anthropic',
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

vi.mock('@core/services/settingsStore', () => ({
  setSettingsStoreAdapter: vi.fn(),
  getSettings: () => makeSettings(liveOpenRouterKey),
}));

vi.mock('@core/services/tokenStorage/openRouterTokenStorage', () => ({
  loadOpenRouterTokens: vi.fn(() => null),
}));

vi.mock('@core/codexAuth', () => ({
  CODEX_ENDPOINT_URL: 'https://chatgpt.com/backend-api/codex',
  getCodexAuthProvider: vi.fn(() => ({
    isConnected: vi.fn(() => false),
    getAccessToken: vi.fn(async () => 'codex-token'),
    getAccountId: vi.fn(() => 'org_123'),
    forceRefreshToken: vi.fn(async () => 'codex-token-refreshed'),
    getStatus: vi.fn(() => ({ connected: false })),
  })),
}));

import { proxyManager, type ModelRouteTable } from '@main/services/localModelProxyServer';

beforeEach(() => {
  registerManagedKeyAvailability(() => false);
  declareNoBtsProxy();
});

afterEach(async () => {
  registerManagedKeyAvailability(() => false);
  declareNoBtsProxy();
  await proxyManager.stop();
  nextPort += 10;
});

describeLiveApi(
  {
    provider: 'openrouter',
    label: 'Setting-driven openrouter-proxy routing — live integration',
    envVar: 'TEST_OPENROUTER_API_KEY',
    model: MODEL,
  },
  ({ key }) => {
  liveOpenRouterKey = key;

  it(
    'activeProvider:openrouter SETTING (no profile) drives a real openrouter-proxy call',
    async () => {
      const settings = makeSettings(key);

      // Deterministic causation control: same OpenRouter credential and model,
      // but a different activeProvider setting routes away from OpenRouter.
      const contrastPlan = await createBtsRoutePlan(
        makeContrastSettings(key),
        MODEL,
        btsOptions(),
        'memory',
      );
      expect(contrastPlan.decision.transport).not.toBe('openrouter-proxy');

      const routeTable: ModelRouteTable = { routes: new Map() };
      await proxyManager.startMultiRoute(routeTable, nextPort++);
      const proxyUrl = proxyManager.getUrl();
      const proxyAuth = proxyManager.getAuthToken();
      expect(proxyUrl).toBeTruthy();
      expect(proxyAuth).toBeTruthy();
      registerBtsProxyProviders({ url: () => proxyUrl, auth: () => proxyAuth });

      const plan = await createBtsRoutePlan(settings, MODEL, btsOptions(), 'memory');
      expect(plan.decision.kind).toBe('dispatchable');
      expect(plan.decision.provider).toBe('openrouter');
      expect(plan.decision.transport).toBe('openrouter-proxy');
      expect(plan.decision.dispatchPath).toBe('local-proxy-passthrough');
      expect(plan.decision.modelDialect).toBe('openrouter-prefixed');
      expect(plan.decision.resolvedFrom).toBe('settings');
      expect(plan.decision.profileId).toBeNull();
      expect(plan.decision.credentialSource).toBe('openrouter-oauth-token');
      expect(plan.resolvedAuthLabel).toBe('openrouter');
      expect(plan.proxyRequired).toBe(true);
      expect(plan.auth.kind).toBe('openrouter');
      expect(plan.auth.credentialSource).toBe('openrouter-oauth-token');
      expect(plan.auth.credentialStatus).toBe('available');

      const authHeader = plan.headers.find(([name]) => name === 'authorization')?.[1];
      expect(authHeader?.startsWith('Bearer ')).toBe(true);
      expect(authHeader?.length ?? 0).toBeGreaterThan('Bearer '.length);
      expect(plan.headers).toContainEqual(['x-openrouter-turn', 'true']);

      const response = await callWithModelAuthAware(settings, MODEL, btsOptions(), {
        category: 'memory',
      });

      expect(response._resolvedAuth).toBe('openrouter');
      expect(response._resolvedModel).toBe(MODEL);
      expect(response.model).toBeTruthy();

      expect(Array.isArray(response.content)).toBe(true);
      expect(response.content.length).toBeGreaterThan(0);
      const textBlocks = response.content.filter((block) => block.type === 'text');
      expect(textBlocks.length).toBeGreaterThan(0);
      expect(
        textBlocks
          .map((block) => block.text ?? '')
          .join('')
          .trim().length,
      ).toBeGreaterThan(0);

      expect(response.usage).toBeDefined();
      expect(typeof response.usage?.input_tokens).toBe('number');
      expect(typeof response.usage?.output_tokens).toBe('number');
      expect(response.usage!.input_tokens).toBeGreaterThan(0);
      expect(response.usage!.output_tokens).toBeGreaterThan(0);
    },
    LIVE_TIMEOUT_MS,
  );
  },
);
