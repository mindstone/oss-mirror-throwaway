/**
 * Server-level auth contract for POST /api/openrouter/managed-key (F2).
 *
 * The route-handler test (`openRouterManagedKeyRoute.test.ts`) bypasses
 * `server.ts` and explicitly does NOT re-test auth. This is a secret-WRITE
 * route, so it must prove that it sits BEHIND the real bearer gate: a
 * missing/wrong bearer returns 401 and the key is never written; a correct
 * bearer writes the key. We boot a minimal server that reproduces the
 * server.ts gate ordering (the real `authorize()` gate BEFORE the route) and
 * drive it over HTTP — mirroring `sessionAssetsRoute.integration.test.ts`.
 */

import http from 'node:http';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parsePath, RouteError, sendRouteError } from '../httpUtils';
import { handleOpenRouterManagedKey } from '../routes/openRouterManagedKey';
// eslint-disable-next-line @typescript-eslint/no-restricted-imports -- allowlisted in scripts/check-cross-surface-imports.ts
import { clearManagedOpenRouterKey, hasManagedOpenRouterKey } from '@main/services/openRouterTokenStorage';

const AUTH_TOKEN = 'managed-key-server-auth-token';
const SECRET_KEY = 'sk-or-managed-server-auth-secret';

function post(args: {
  port: number;
  bearer?: string;
  body: unknown;
}): Promise<{ status: number; body: unknown }> {
  const { port, bearer, body } = args;
  const payload = JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        method: 'POST',
        host: '127.0.0.1',
        port,
        path: '/api/openrouter/managed-key',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload),
          ...(bearer !== undefined ? { Authorization: `Bearer ${bearer}` } : {}),
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c) => chunks.push(c as Buffer));
        res.on('end', () => {
          const raw = Buffer.concat(chunks).toString('utf8');
          let parsed: unknown = raw;
          try { parsed = raw ? JSON.parse(raw) : null; } catch { /* keep raw */ }
          resolve({ status: res.statusCode ?? 0, body: parsed });
        });
      },
    );
    req.on('error', reject);
    req.end(payload);
  });
}

describe('POST /api/openrouter/managed-key — server-level auth gate (F2)', () => {
  let server: http.Server;
  let port: number;
  const originalEnv = { ...process.env };

  beforeEach(async () => {
    clearManagedOpenRouterKey();

    // `authorize()` captures AUTH_TOKEN at module-load, so set env then load a
    // fresh copy (mirrors safetyPromptRoute.test.ts).
    process.env.REBEL_CLOUD_TOKEN = AUTH_TOKEN;
    process.env.NODE_ENV = 'production';
    vi.resetModules();
    const { authorize } = await import('../auth');

    server = http.createServer((req, res) => {
      void (async () => {
        const segments = parsePath(req.url);
        // Reproduce server.ts ordering: bearer gate BEFORE the route dispatch.
        if (!authorize(req)) {
          return sendRouteError(
            res,
            undefined,
            new RouteError('UNAUTHORIZED', { status: 401, message: 'Invalid or missing bearer token' }),
          );
        }
        if (segments[0] === 'api' && segments[1] === 'openrouter' && segments[2] === 'managed-key') {
          return await handleOpenRouterManagedKey(req, res);
        }
        return sendRouteError(res, undefined, new RouteError('NOT_FOUND', { status: 404, message: 'Not Found' }));
      })().catch(() => {
        sendRouteError(res, undefined, new RouteError('INTERNAL_ERROR', { status: 500, message: 'err' }));
      });
    });

    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Failed to bind test server');
    port = address.port;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    clearManagedOpenRouterKey();
    process.env = { ...originalEnv };
  });

  it('rejects a missing bearer with 401 and does NOT write the key', async () => {
    const res = await post({ port, body: { apiKey: SECRET_KEY } });
    expect(res.status).toBe(401);
    expect(hasManagedOpenRouterKey()).toBe(false);
  });

  it('rejects a wrong bearer with 401 and does NOT write the key', async () => {
    const res = await post({ port, bearer: 'wrong-token-of-some-length', body: { apiKey: SECRET_KEY } });
    expect(res.status).toBe(401);
    expect(hasManagedOpenRouterKey()).toBe(false);
  });

  it('accepts a correct bearer → 200 and writes the key', async () => {
    expect(hasManagedOpenRouterKey()).toBe(false);
    const res = await post({ port, bearer: AUTH_TOKEN, body: { apiKey: SECRET_KEY } });
    expect(res.status).toBe(200);
    expect(hasManagedOpenRouterKey()).toBe(true);
    // The key bytes must never appear in the response body.
    expect(JSON.stringify(res.body)).not.toContain(SECRET_KEY);
  });
});
