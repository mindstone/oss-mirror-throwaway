import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CodexAuthProvider } from '@core/codexAuth';

let setCodexAuthProvider: typeof import('@core/codexAuth').setCodexAuthProvider;
let NULL_CODEX_AUTH_PROVIDER: typeof import('@core/codexAuth').NULL_CODEX_AUTH_PROVIDER;
let resolveCodexConnectivity: typeof import('../codexConnectivity').resolveCodexConnectivity;

function providerWithConnection(isConnected: boolean): CodexAuthProvider {
  return {
    isConnected: () => isConnected,
    getAccessToken: vi.fn(async () => null),
    getAccountId: vi.fn(() => null),
    forceRefreshToken: vi.fn(async () => null),
    getStatus: vi.fn(() => ({ connected: isConnected })),
  };
}

describe('resolveCodexConnectivity', () => {
  beforeEach(async () => {
    vi.resetModules();
    const codexAuth = await import('@core/codexAuth');
    const codexConnectivity = await import('../codexConnectivity');
    setCodexAuthProvider = codexAuth.setCodexAuthProvider;
    NULL_CODEX_AUTH_PROVIDER = codexAuth.NULL_CODEX_AUTH_PROVIDER;
    resolveCodexConnectivity = codexConnectivity.resolveCodexConnectivity;
  });

  it('returns connected when the registered Codex auth provider is connected', () => {
    setCodexAuthProvider(providerWithConnection(true));

    expect(resolveCodexConnectivity()).toBe('connected');
  });

  it('returns disconnected when the registered Codex auth provider is disconnected', () => {
    setCodexAuthProvider(providerWithConnection(false));

    expect(resolveCodexConnectivity()).toBe('disconnected');
  });

  it('returns disconnected when the null Codex auth provider is registered', () => {
    setCodexAuthProvider(NULL_CODEX_AUTH_PROVIDER);

    expect(resolveCodexConnectivity()).toBe('disconnected');
  });
});
