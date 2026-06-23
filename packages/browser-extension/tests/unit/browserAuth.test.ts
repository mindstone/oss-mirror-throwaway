import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  generateClientId,
  mintSessionTokenFromBootToken,
  readBootTokenFileFromBundle,
} from '../../src/lib/browserAuth';

const bootToken = {
  schemaVersion: 1 as const,
  routerToken: 'router-token',
  bridgeOrigin: 'http://127.0.0.1:52320',
  port: 52320,
  startedAt: '2026-04-23T12:00:00.000Z',
  installSessionId: 'inst_123456',
};

describe('browserAuth helpers', () => {
  beforeEach(() => {
    vi.stubGlobal('chrome', {
      runtime: {
        id: 'abcdefghijklmnopabcdefghijklmnop',
        getURL: vi.fn((relativePath: string) => `chrome-extension://test/${relativePath}`),
      },
      storage: {
        local: {
          get: vi.fn(async () => ({})),
          set: vi.fn(async () => undefined),
        },
        session: {
          get: vi.fn(async () => ({})),
          set: vi.fn(async () => undefined),
          remove: vi.fn(async () => undefined),
        },
      },
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('generates browser-scoped client ids', () => {
    expect(generateClientId()).toMatch(/^browser-[0-9a-f]{16}$/);
  });

  it('reads the bundled boot-token file', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        status: 200,
        json: async () => bootToken,
      })),
    );

    const result = await readBootTokenFileFromBundle();

    expect(result).toEqual({ ok: true, bootToken });
  });

  it('treats a missing boot-token file as boot-token-missing', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: false,
        status: 404,
      })),
    );

    const result = await readBootTokenFileFromBundle();

    expect(result).toEqual({ ok: false, kind: 'boot-token-missing' });
  });

  it('mints a browser-extension token without sending a fingerprint', async () => {
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => ({
      ok: true,
      status: 200,
      headers: new Headers(),
      json: async () => ({ ok: true, token: 'minted-token' }),
      text: async () => '',
    }));

    const result = await mintSessionTokenFromBootToken({
      bootToken,
      clientId: 'browser-0123456789abcdef',
      extensionId: 'abcdefghijklmnopabcdefghijklmnop',
      fetchImpl: fetchMock as unknown as typeof fetch,
    });

    expect(result).toEqual({
      ok: true,
      kind: 'connected',
      token: 'minted-token',
      installSessionId: 'inst_123456',
      port: 52320,
    });

    const [, init] = fetchMock.mock.calls[0] ?? [];
    const parsedBody = JSON.parse(String(init?.body));
    expect(parsedBody).toEqual({
      appId: 'browser-extension',
      clientId: 'browser-0123456789abcdef',
      extensionId: 'abcdefghijklmnopabcdefghijklmnop',
      installSessionId: 'inst_123456',
    });
    expect(parsedBody).not.toHaveProperty('fingerprint');
    expect((init?.headers as Record<string, string>).authorization).toBe('Bearer router-token');
  });

  it('classifies 403 responses as mint-forbidden', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: false,
        status: 403,
        headers: new Headers(),
        json: async () => ({ reason: 'install-session-revoked' }),
      })),
    );

    const result = await mintSessionTokenFromBootToken({
      bootToken,
      clientId: 'browser-0123456789abcdef',
      extensionId: 'abcdefghijklmnopabcdefghijklmnop',
    });

    expect(result).toEqual({
      ok: false,
      kind: 'mint-forbidden',
      reason: 'install-session-revoked',
    });
  });

  it('classifies 429 responses as mint-rate-limited', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: false,
        status: 429,
        headers: new Headers({ 'Retry-After': '7' }),
        json: async () => ({ reason: 'rate-limited' }),
      })),
    );

    const result = await mintSessionTokenFromBootToken({
      bootToken,
      clientId: 'browser-0123456789abcdef',
      extensionId: 'abcdefghijklmnopabcdefghijklmnop',
    });

    expect(result).toEqual({
      ok: false,
      kind: 'mint-rate-limited',
      retryAfterMs: 7_000,
    });
  });

  it('classifies a 404 mint plus 404 health check as port-stale', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: false,
        status: 404,
        headers: new Headers(),
        json: async () => ({ reason: 'not-found' }),
      })
      .mockResolvedValueOnce({
        ok: false,
        status: 404,
      });
    vi.stubGlobal('fetch', fetchMock);

    const result = await mintSessionTokenFromBootToken({
      bootToken,
      clientId: 'browser-0123456789abcdef',
      extensionId: 'abcdefghijklmnopabcdefghijklmnop',
    });

    expect(result).toEqual({ ok: false, kind: 'port-stale' });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
