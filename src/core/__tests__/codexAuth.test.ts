import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CodexAuthProvider } from '@core/codexAuth';

let setCodexAuthProvider: typeof import('@core/codexAuth').setCodexAuthProvider;
let getCodexAuthProvider: typeof import('@core/codexAuth').getCodexAuthProvider;
let NULL_CODEX_AUTH_PROVIDER: typeof import('@core/codexAuth').NULL_CODEX_AUTH_PROVIDER;

describe('CodexAuthProvider boundary', () => {
  beforeEach(async () => {
    vi.resetModules();
    const mod = await import('@core/codexAuth');
    setCodexAuthProvider = mod.setCodexAuthProvider;
    getCodexAuthProvider = mod.getCodexAuthProvider;
    NULL_CODEX_AUTH_PROVIDER = mod.NULL_CODEX_AUTH_PROVIDER;
  });

  it('throws when provider is not registered', () => {
    expect(() => getCodexAuthProvider()).toThrow('CodexAuthProvider not registered');
  });

  it('returns disconnected status when null provider is registered', () => {
    setCodexAuthProvider(NULL_CODEX_AUTH_PROVIDER);
    expect(getCodexAuthProvider().isConnected()).toBe(false);
  });

  it('returns the registered provider implementation', () => {
    const mockProvider: CodexAuthProvider = {
      isConnected: () => true,
      getAccessToken: vi.fn(async () => 'mock-token'),
      getAccountId: vi.fn(() => 'org_mock'),
      forceRefreshToken: vi.fn(async () => 'mock-token-refreshed'),
      getStatus: vi.fn(() => ({ connected: true, accountEmail: 'mock@example.com' })),
    };

    setCodexAuthProvider(mockProvider);
    expect(getCodexAuthProvider().isConnected()).toBe(true);
  });
});
