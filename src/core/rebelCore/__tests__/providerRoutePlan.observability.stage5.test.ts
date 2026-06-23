/**
 * Stage 5 — routing observability. Pins that the route-plan log event carries the
 * requested → resolved → provider → credential-source → why record (the visibility
 * safeguard for the auto/no-cap paid-fallback policy, PLAN §8 #3): `canonicalModelId`
 * (requested), `credentialSource` (resolved-route billing identity), and
 * `resolvedFrom` (why), alongside the pre-existing provider/transport/fallbackHint.
 */
import { describe, expect, it, vi } from 'vitest';

const { logInfo, logDebug } = vi.hoisted(() => ({ logInfo: vi.fn(), logDebug: vi.fn() }));

vi.mock('@core/logger', () => ({
  createScopedLogger: () => ({ info: logInfo, debug: logDebug, warn: vi.fn(), error: vi.fn() }),
}));

import { ProviderRouter, type ProviderRouteSettings } from '../providerRouting';
import { materializePlanRuntime } from '../providerRoutePlan';

function anthropicSettings(): ProviderRouteSettings {
  return {
    activeProvider: 'anthropic',
    models: { apiKey: 'fake-anthropic-key', authMethod: 'api-key', model: 'claude-sonnet-4-6' },
    openRouter: { enabled: false, oauthToken: null, selectedModel: 'anthropic/claude-sonnet-4.6' },
    localModel: { activeProfileId: null, profiles: [] },
    providerKeys: {},
  };
}

describe('Stage 5 — route-plan log observability fields', () => {
  it('logs canonicalModelId (requested), credentialSource (resolved identity), and resolvedFrom (why)', async () => {
    logInfo.mockClear();
    logDebug.mockClear();
    const decision = ProviderRouter.forTurn({
      settings: anthropicSettings(),
      model: 'claude-sonnet-4-6',
      codexConnectivity: 'unknown',
    });
    await materializePlanRuntime(decision);

    const logged = [...logInfo.mock.calls, ...logDebug.mock.calls].find(
      ([event]) => event && typeof event === 'object' && 'wireModelId' in event,
    );
    expect(logged).toBeDefined();
    const [event] = logged!;
    expect(event).toMatchObject({
      canonicalModelId: 'claude-sonnet-4-6',
      credentialSource: 'anthropic-api-key',
      resolvedFrom: 'settings',
      provider: 'anthropic',
    });
  });
});
