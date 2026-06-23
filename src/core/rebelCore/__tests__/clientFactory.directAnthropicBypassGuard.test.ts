import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppSettings } from '@shared/types';

const warnMock = vi.hoisted(() => vi.fn());

vi.mock('@core/logger', () => ({
  createScopedLogger: () => ({
    info: vi.fn(),
    debug: vi.fn(),
    warn: warnMock,
    error: vi.fn(),
  }),
}));

import { createModelClient } from '../clientFactory';
import { AnthropicClient } from '../clients/anthropicClient';

/**
 * F2 bypass guard (260604): the no-profile direct-Anthropic branch of
 * createModelClient() resolves auth via getAuthForDirectUse(), which is
 * auth-shape-only and ignores `activeProvider`. A caller bypassing the route-plan
 * path with a non-direct activeProvider + a stale `claude.apiKey` is the B1
 * raw-key-as-route shape (260419). The guard surfaces a dev-warning WITHOUT
 * changing routing behaviour (no throw, no reroute) so legitimate legacy
 * direct-Anthropic callers are unaffected.
 */
function makeSettings(overrides: { activeProvider?: AppSettings['activeProvider']; apiKey?: string | null } = {}): AppSettings {
  return {
    activeProvider: overrides.activeProvider,
    models: {
      apiKey: overrides.apiKey ?? 'fake-ant-stale-key',
      oauthToken: null,
      authMethod: 'api-key',
      model: 'claude-sonnet-4-6',
      workingProfileId: null,
    },
    localModel: { profiles: [], activeProfileId: null },
    providerKeys: {},
  } as unknown as AppSettings;
}

describe('createModelClient PRECEDENCE 2 direct-Anthropic bypass guard (F2)', () => {
  beforeEach(() => {
    warnMock.mockClear();
  });

  it('does NOT warn for a legitimate direct-Anthropic config (activeProvider undefined)', () => {
    const client = createModelClient({ settings: makeSettings({ activeProvider: undefined }) });
    expect(client).toBeInstanceOf(AnthropicClient);
    expect(warnMock).not.toHaveBeenCalled();
  });

  it('does NOT warn for an explicit anthropic activeProvider', () => {
    const client = createModelClient({ settings: makeSettings({ activeProvider: 'anthropic' }) });
    expect(client).toBeInstanceOf(AnthropicClient);
    expect(warnMock).not.toHaveBeenCalled();
  });

  it('warns when a non-direct provider reaches the bypass with a stale Anthropic key (B1 shape)', () => {
    // activeProvider=openrouter but a stale claude.apiKey lingers — the exact B1
    // shape. Behaviour is preserved (a client is still returned) but the guard fires.
    const client = createModelClient({ settings: makeSettings({ activeProvider: 'openrouter' }) });
    expect(client).toBeInstanceOf(AnthropicClient); // behaviour-preserving: no throw/reroute
    expect(warnMock).toHaveBeenCalledTimes(1);
    expect(warnMock.mock.calls[0][0]).toMatchObject({
      site: 'clientFactory:precedence-2-direct-anthropic',
      activeProvider: 'openrouter',
    });
  });

  it('warns for codex activeProvider hitting the bypass', () => {
    createModelClient({ settings: makeSettings({ activeProvider: 'codex' }) });
    expect(warnMock).toHaveBeenCalledTimes(1);
    expect(warnMock.mock.calls[0][0]).toMatchObject({ activeProvider: 'codex' });
  });
});
