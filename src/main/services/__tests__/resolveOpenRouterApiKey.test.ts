/**
 * Tests for resolveOpenRouterApiKey — the fallback chain that makes
 * OpenRouter work on both desktop (encrypted store) and cloud/mobile
 * (settings synced via dual-write).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockLoadOpenRouterTokens = vi.fn();
const mockGetSettings = vi.fn();

vi.mock('@core/services/tokenStorage/openRouterTokenStorage', () => ({
  loadOpenRouterTokens: (...args: unknown[]) => mockLoadOpenRouterTokens(...args),
}));

vi.mock('@core/services/settingsStore', () => ({
  setSettingsStoreAdapter: vi.fn(),
  getSettings: (...args: unknown[]) => mockGetSettings(...args),
}));

import { resolveOpenRouterApiKey } from '../localModelProxyServer';

beforeEach(() => {
  vi.clearAllMocks();
  mockGetSettings.mockReturnValue({ providerKeys: {} });
});

describe('resolveOpenRouterApiKey', () => {
  it('returns token from encrypted store when available (desktop path)', () => {
    mockLoadOpenRouterTokens.mockReturnValue({ apiKey: 'fake-or-desktop-key' });
    expect(resolveOpenRouterApiKey()).toBe('fake-or-desktop-key');
  });

  it('falls back to settings.openRouter.oauthToken when encrypted store is empty (cloud/mobile path)', () => {
    mockLoadOpenRouterTokens.mockReturnValue(null);
    mockGetSettings.mockReturnValue({
      providerKeys: {},
      openRouter: { enabled: true, oauthToken: 'fake-or-cloud-key', selectedModel: 'openai/gpt-5.5' },
    });
    expect(resolveOpenRouterApiKey()).toBe('fake-or-cloud-key');
  });

  it('returns null when neither encrypted store nor settings have a token', () => {
    mockLoadOpenRouterTokens.mockReturnValue(null);
    mockGetSettings.mockReturnValue({ providerKeys: {}, openRouter: { enabled: true, oauthToken: null } });
    expect(resolveOpenRouterApiKey()).toBeNull();
  });

  it('prefers encrypted store over settings (desktop always wins)', () => {
    mockLoadOpenRouterTokens.mockReturnValue({ apiKey: 'fake-or-desktop-key' });
    mockGetSettings.mockReturnValue({
      providerKeys: {},
      openRouter: { enabled: true, oauthToken: 'fake-or-cloud-key' },
    });
    expect(resolveOpenRouterApiKey()).toBe('fake-or-desktop-key');
  });

  it('handles missing openRouter settings gracefully', () => {
    mockLoadOpenRouterTokens.mockReturnValue(null);
    mockGetSettings.mockReturnValue({ providerKeys: {} });
    expect(resolveOpenRouterApiKey()).toBeNull();
  });
});
