import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppSettings } from '@shared/types';

vi.mock('@core/logger', () => ({
  createScopedLogger: () => ({
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
  getTurnContext: vi.fn(() => undefined),
}));

vi.mock('@core/services/costLedgerService', () => ({
  appendCostEntry: vi.fn(() => ({ costEntryId: 'test-cost-entry-id' })),
}));

vi.mock('@core/services/apiRateLimitCooldown', () => ({
  apiRateLimitCooldown: {
    isActive: () => false,
    isAvailable: () => true,
    remainingMs: () => 0,
    activate: vi.fn(),
    recordRateLimit: vi.fn(),
    recordSuccess: vi.fn(),
  },
  safetyEvalRateLimitCooldown: {
    isActive: () => false,
    isAvailable: () => true,
    remainingMs: () => 0,
    activate: vi.fn(),
    recordRateLimit: vi.fn(),
    recordSuccess: vi.fn(),
  },
}));

import {
  callWithModelAuthAware,
  createBtsRoutePlan,
  registerManagedKeyAvailability,
  registerBtsProxyProviders,
  declareNoBtsProxy,
} from '../behindTheScenesClient';

type AppSettingsWithManagedKey = AppSettings & { hasManagedKey?: boolean };

function createMindstoneSettings(
  overrides: Partial<AppSettingsWithManagedKey> = {},
): AppSettingsWithManagedKey {
  return {
    activeProvider: 'mindstone',
    coreDirectory: '/tmp/test',
    claude: {
      apiKey: 'fake-anthropic-key',
      oauthToken: null,
      authMethod: 'api-key',
      model: 'claude-sonnet-4-6',
    },
    openRouter: {
      enabled: true,
      oauthToken: null,
      selectedModel: 'deepseek/deepseek-v4-flash',
    },
    providerKeys: {},
    customProviders: [],
    localModel: {
      activeProfileId: null,
      profiles: [],
    },
    ...overrides,
  } as AppSettingsWithManagedKey;
}

function btsOptions() {
  return {
    messages: [{ role: 'user' as const, content: 'test' }],
    maxTokens: 32,
    codexConnectivity: 'unknown' as const,
  };
}

describe('behindTheScenesClient managed-key registration boundary', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    fetchSpy = vi.spyOn(globalThis, 'fetch');
    registerManagedKeyAvailability(() => false);
    declareNoBtsProxy();
  });

  afterEach(() => {
    fetchSpy.mockRestore();
    vi.restoreAllMocks();
  });

  it('routes Mindstone BTS calls through mindstone-managed-key when registered availability is true', async () => {
    registerManagedKeyAvailability(() => true);
    const plan = await createBtsRoutePlan(
      createMindstoneSettings(),
      'deepseek/deepseek-v4-flash',
      btsOptions(),
      'memory',
    );

    expect(plan.decision.kind).toBe('dispatchable');
    expect(plan.decision.transport).toBe('openrouter-proxy');
    expect(plan.decision.credentialSource).toBe('mindstone-managed-key');
    expect(plan.decision.wireModelId).toBe('deepseek/deepseek-v4-flash');
  });

  it('stays fail-closed with missing-mindstone-credentials when registered availability is false', async () => {
    registerManagedKeyAvailability(() => false);
    const plan = await createBtsRoutePlan(
      createMindstoneSettings(),
      'deepseek/deepseek-v4-flash',
      btsOptions(),
      'memory',
    );

    expect(plan.decision.kind).toBe('terminal');
    expect(plan.decision.transport).toBe('no-credentials');
    expect(plan.decision.credentialSource).toBe('missing-mindstone');
    // Mindstone-specific reason, not the OpenRouter one (so BTS surfaces a Mindstone message).
    expect(plan.decision.invalidReason).toBe('missing-mindstone-credentials');
  });

  it('preserves caller-injected hasManagedKey=true over a registered false provider', async () => {
    registerManagedKeyAvailability(() => false);
    const plan = await createBtsRoutePlan(
      createMindstoneSettings({ hasManagedKey: true }),
      'deepseek/deepseek-v4-flash',
      btsOptions(),
      'memory',
    );

    expect(plan.decision.kind).toBe('dispatchable');
    expect(plan.decision.transport).toBe('openrouter-proxy');
    expect(plan.decision.credentialSource).toBe('mindstone-managed-key');
  });

  it('preserves caller-injected hasManagedKey=false over a registered true provider', async () => {
    registerManagedKeyAvailability(() => true);
    const plan = await createBtsRoutePlan(
      createMindstoneSettings({ hasManagedKey: false }),
      'deepseek/deepseek-v4-flash',
      btsOptions(),
      'memory',
    );

    expect(plan.decision.kind).toBe('terminal');
    expect(plan.decision.transport).toBe('no-credentials');
    expect(plan.decision.credentialSource).toBe('missing-mindstone');
    expect(plan.decision.invalidReason).toBe('missing-mindstone-credentials');
  });

  it('sends slash-form model over BTS HTTP path for direct core callers when managed key availability is registered', async () => {
    registerManagedKeyAvailability(() => true);
    registerBtsProxyProviders({ url: () => 'http://127.0.0.1:9999', auth: () => 'proxy-auth-token' });
    fetchSpy.mockResolvedValueOnce(
      new Response(JSON.stringify({
        content: [{ type: 'text', text: 'ok' }],
        model: 'deepseek/deepseek-v4-flash',
        usage: { input_tokens: 10, output_tokens: 5 },
      }), { status: 200, headers: { 'content-type': 'application/json' } }),
    );

    await callWithModelAuthAware(
      createMindstoneSettings(),
      'deepseek/deepseek-v4-flash',
      btsOptions(),
      { category: 'safety' },
    );

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0];
    expect(url).toBe('http://127.0.0.1:9999/v1/messages');
    const body = JSON.parse(String(init?.body)) as { model?: string };
    expect(body.model).toBe('deepseek/deepseek-v4-flash');
  });
});
