import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { StandaloneSecureTokenStore } from '../standaloneSecureTokenStore';

const { warn } = vi.hoisted(() => ({
  warn: vi.fn(),
}));

vi.mock('@core/logger', () => ({
  createScopedLogger: () => ({
    warn,
    error: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    trace: vi.fn(),
    fatal: vi.fn(),
    child: vi.fn(),
    isLevelEnabled: vi.fn(() => false),
  }),
}));

const backingStore = {
  get: () => undefined,
  set: () => {},
  delete: () => {},
  has: () => false,
};

const ENV_KEYS = [
  'REBEL_AUTH_API_KEY',
  'REBEL_FLY_API_KEY',
  'REBEL_DIGITALOCEAN_API_KEY',
  'REBEL_DIGITALOCEAN_OAUTH_TOKENS_JSON',
  'REBEL_OPENROUTER_API_KEY',
  'REBEL_CODEX_TOKENS_JSON',
] as const;

function clearEnv(): void {
  for (const key of ENV_KEYS) {
    delete process.env[key];
  }
}

describe('StandaloneSecureTokenStore env mappings', () => {
  beforeEach(() => {
    clearEnv();
    warn.mockClear();
  });

  afterEach(() => {
    clearEnv();
  });

  it('reads auth token from explicit auth mapping', () => {
    process.env.REBEL_AUTH_API_KEY = 'session-token';
    const store = new StandaloneSecureTokenStore();
    const token = store.read({
      store: backingStore,
      namespace: 'auth-tokens',
      key: 'encryptedSessionToken',
      kind: 'auth-session-token',
      validate: (value) => value === 'session-token',
    });
    expect(token).toBe('session-token');
  });

  it('reads fly token from explicit fly mapping', () => {
    process.env.REBEL_FLY_API_KEY = 'fly-token';
    const store = new StandaloneSecureTokenStore();
    const token = store.read({
      store: backingStore,
      namespace: 'fly-tokens',
      key: 'encryptedFlyApiToken',
      kind: 'fly-api-token',
      validate: (value) => value === 'fly-token',
    });
    expect(token).toBe('fly-token');
  });

  it('reads provider API token from explicit provider mapping', () => {
    process.env.REBEL_DIGITALOCEAN_API_KEY = 'do-api-token';
    const store = new StandaloneSecureTokenStore();
    const token = store.read({
      store: backingStore,
      namespace: 'digitalocean-tokens',
      key: 'encryptedApiToken',
      kind: 'provider-api-token:digitalocean',
      validate: (value) => value === 'do-api-token',
    });
    expect(token).toBe('do-api-token');
  });

  it('reads provider OAuth payload from explicit provider mapping', () => {
    const oauthPayload = JSON.stringify({
      accessToken: 'access',
      refreshToken: 'refresh',
      expiresAt: Date.now() + 60_000,
    });
    process.env.REBEL_DIGITALOCEAN_OAUTH_TOKENS_JSON = oauthPayload;
    const store = new StandaloneSecureTokenStore();
    const token = store.read({
      store: backingStore,
      namespace: 'digitalocean-tokens',
      key: 'encryptedOAuthTokens',
      kind: 'provider-oauth-token:digitalocean',
      validate: (value) => value === oauthPayload,
    });
    expect(token).toBe(oauthPayload);
  });

  it('transforms OpenRouter API key env value to JSON token shape', () => {
    process.env.REBEL_OPENROUTER_API_KEY = 'or-key';
    const store = new StandaloneSecureTokenStore();
    const token = store.read({
      store: backingStore,
      namespace: 'openrouter-oauth-tokens',
      key: 'encryptedTokens',
      kind: 'openrouter-oauth-token',
      validate: (value) => {
        const parsed = JSON.parse(value) as { apiKey?: string };
        return parsed.apiKey === 'or-key';
      },
    });
    expect(token).toBe(JSON.stringify({ apiKey: 'or-key' }));
  });

  it('reads codex token payload from explicit codex mapping', () => {
    const payload = JSON.stringify({
      accessToken: 'access',
      refreshToken: 'refresh',
      expiresAt: Date.now() + 60_000,
      accountId: 'acct_123',
    });
    process.env.REBEL_CODEX_TOKENS_JSON = payload;
    const store = new StandaloneSecureTokenStore();
    const token = store.read({
      store: backingStore,
      namespace: 'codex-oauth-tokens',
      key: 'encryptedTokens',
      kind: 'codex-oauth-token',
      validate: (value) => value === payload,
    });
    expect(token).toBe(payload);
  });

  it('returns null loudly for unknown namespace/key mappings', () => {
    const store = new StandaloneSecureTokenStore();
    const token = store.read({
      store: backingStore,
      namespace: 'unknown-tokens',
      key: 'encryptedUnknown',
      kind: 'unknown',
      validate: () => true,
    });

    expect(token).toBeNull();
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ namespace: 'unknown-tokens', key: 'encryptedUnknown' }),
      'Standalone CLI token store has no env mapping for namespace/key',
    );
  });
});
