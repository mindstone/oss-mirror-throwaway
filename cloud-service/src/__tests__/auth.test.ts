import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type http from 'node:http';

vi.mock('@core/logger', () => ({
  createScopedLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

function makeReq(authorization?: string): http.IncomingMessage {
  return { headers: { authorization } } as unknown as http.IncomingMessage;
}

describe('authorize', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  async function loadAuthModule() {
    return import('../auth');
  }

  async function loadAuthorize() {
    const mod = await loadAuthModule();
    return mod.authorize;
  }

  it('rejects when no token configured and NODE_ENV=production', async () => {
    delete process.env.REBEL_CLOUD_TOKEN;
    delete process.env.REBEL_BRIDGE_TOKEN;
    process.env.NODE_ENV = 'production';
    const authorize = await loadAuthorize();
    expect(authorize(makeReq('Bearer something'))).toBe(false);
  });

  it('allows when no token configured and NODE_ENV is not production (dev mode)', async () => {
    delete process.env.REBEL_CLOUD_TOKEN;
    delete process.env.REBEL_BRIDGE_TOKEN;
    delete process.env.NODE_ENV;
    const authorize = await loadAuthorize();
    expect(authorize(makeReq())).toBe(true);
  });

  it('rejects when token configured but request has no auth header', async () => {
    process.env.REBEL_CLOUD_TOKEN = 'test-token-abc';
    const authorize = await loadAuthorize();
    expect(authorize(makeReq())).toBe(false);
  });

  it('rejects when token does not match', async () => {
    process.env.REBEL_CLOUD_TOKEN = 'test-token-abc';
    const authorize = await loadAuthorize();
    expect(authorize(makeReq('Bearer wrong-token'))).toBe(false);
  });

  it('accepts when token matches', async () => {
    process.env.REBEL_CLOUD_TOKEN = 'test-token-abc';
    const authorize = await loadAuthorize();
    expect(authorize(makeReq('Bearer test-token-abc'))).toBe(true);
  });

  it('rejects non-Bearer scheme', async () => {
    process.env.REBEL_CLOUD_TOKEN = 'test-token-abc';
    const authorize = await loadAuthorize();
    expect(authorize(makeReq('Basic test-token-abc'))).toBe(false);
  });

  it('rejects wrong token even in dev mode (NODE_ENV unset)', async () => {
    process.env.REBEL_CLOUD_TOKEN = 'test-token-abc';
    delete process.env.NODE_ENV;
    const authorize = await loadAuthorize();
    expect(authorize(makeReq('Bearer wrong-token'))).toBe(false);
  });

  it('extractBearerTokenFromAuthorizationHeader returns bearer token only', async () => {
    const { extractBearerTokenFromAuthorizationHeader } = await loadAuthModule();
    expect(extractBearerTokenFromAuthorizationHeader('Bearer token-1')).toBe('token-1');
    expect(extractBearerTokenFromAuthorizationHeader('Basic token-1')).toBeNull();
    expect(extractBearerTokenFromAuthorizationHeader(undefined)).toBeNull();
  });

  it('bearerTokenHash is deterministic and does not expose raw token', async () => {
    const { bearerTokenHash } = await loadAuthModule();
    const token = 'sensitive-token-value';
    const hashA = bearerTokenHash(token);
    const hashB = bearerTokenHash(token);
    expect(hashA).toBe(hashB);
    expect(hashA).toMatch(/^[a-f0-9]{64}$/);
    expect(hashA).not.toContain(token);
  });
});
