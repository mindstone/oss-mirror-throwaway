import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mockStore: Record<string, unknown> = {};

vi.mock('@core/lazyElectron', () => ({
  getElectronModule: () => null,
}));

vi.mock('@core/storeFactory', () => ({
  createStore: () => ({
    get(key: string) { return mockStore[key]; },
    set(key: string, value: unknown) { mockStore[key] = value; },
    has(key: string) { return key in mockStore; },
    delete(key: string) { delete mockStore[key]; },
    clear() { for (const key of Object.keys(mockStore)) delete mockStore[key]; },
  }),
}));

vi.mock('@core/errorReporter', () => ({
  getErrorReporter: () => ({
    captureMessage: vi.fn(),
    captureException: vi.fn(),
    addBreadcrumb: vi.fn(),
    captureExceptionWithScope: vi.fn(),
  }),
}));

describe('standalone CLI Codex token safety', () => {
  beforeEach(() => {
    vi.resetModules();
    for (const key of Object.keys(mockStore)) delete mockStore[key];
    process.env.REBEL_SURFACE = 'cli-standalone';
  });

  afterEach(() => {
    delete process.env.REBEL_SURFACE;
  });

  it('returns null without touching encrypted desktop token bytes', async () => {
    const encryptedBlob = Buffer.concat([
      Buffer.from('v10'),
      Buffer.from(JSON.stringify({ accessToken: 'access', refreshToken: 'refresh', expiresAt: Date.now() + 60_000 })),
    ]).toString('base64');
    mockStore.encryptedTokens = encryptedBlob;
    const before = JSON.stringify(mockStore);

    const { loadCodexTokens } = await import('../../../src/core/services/codexTokenStorage');

    expect(loadCodexTokens()).toBeNull();
    expect(JSON.stringify(mockStore)).toBe(before);
    expect(mockStore.encryptedTokens).toBe(encryptedBlob);
  });
});
