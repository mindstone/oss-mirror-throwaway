/**
 * Tests for POST /api/openrouter/managed-key — the desktop → cloud managed
 * Mindstone-subscription key sync endpoint (Layer 3 / DI-05 cloud parity).
 *
 * The route delegates to core/main storage; the interesting cases are payload
 * validation and the null-clear branch. Auth is applied by the server.ts bearer
 * gate (codex-token parity), so it is not re-tested here. The key bytes must
 * never appear in any response body or log.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import http from 'node:http';
import { handleOpenRouterManagedKey } from '../routes/openRouterManagedKey';
// eslint-disable-next-line @typescript-eslint/no-restricted-imports -- allowlisted in scripts/check-cross-surface-imports.ts
import {
  clearManagedOpenRouterKey,
  hasManagedOpenRouterKey,
  loadManagedOpenRouterKey,
} from '@main/services/openRouterTokenStorage';

function createMockReq(body: unknown, method: string = 'POST'): http.IncomingMessage {
  const req = new http.IncomingMessage(null as never);
  req.method = method;
  const payload = JSON.stringify(body);
  req.push(payload);
  req.push(null);
  return req;
}

type MockResShape = {
  _status: number;
  _body: unknown;
  _headers: Record<string, string | number>;
};

function createMockRes(): http.ServerResponse & { _status: number; _body: unknown } {
  const res = {
    _status: 0,
    _body: null as unknown,
    _headers: {} as Record<string, string | number>,
    writeHead(this: MockResShape, status: number, headers?: Record<string, string | number>) {
      this._status = status;
      if (headers) Object.assign(this._headers, headers);
      return this;
    },
    end(this: MockResShape, data?: string | Buffer) {
      const str = typeof data === 'string' ? data : data ? data.toString('utf8') : undefined;
      if (str) {
        try {
          this._body = JSON.parse(str);
        } catch {
          this._body = str;
        }
      }
      return this;
    },
    setHeader() { return this; },
    getHeader() { return undefined; },
  } as unknown as http.ServerResponse & { _status: number; _body: unknown };
  return res;
}

describe('POST /api/openrouter/managed-key', () => {
  beforeEach(() => {
    clearManagedOpenRouterKey();
  });

  it('rejects non-POST methods', async () => {
    const req = createMockReq({}, 'GET');
    const res = createMockRes();
    await handleOpenRouterManagedKey(req, res);
    expect(res._status).toBe(405);
  });

  it('rejects missing body', async () => {
    // readBody returns null for empty body.
    const req = new http.IncomingMessage(null as never);
    req.method = 'POST';
    req.push(null);
    const res = createMockRes();
    await handleOpenRouterManagedKey(req, res);
    expect(res._status).toBe(400);
  });

  it('rejects a malformed body (missing apiKey)', async () => {
    const req = createMockReq({ notApiKey: 'x' });
    const res = createMockRes();
    await handleOpenRouterManagedKey(req, res);
    expect(res._status).toBe(400);
    const body = res._body as { error?: { code?: string } };
    expect(body.error?.code).toBe('INVALID_BODY');
  });

  it('rejects an empty-string apiKey', async () => {
    const req = createMockReq({ apiKey: '' });
    const res = createMockRes();
    await handleOpenRouterManagedKey(req, res);
    expect(res._status).toBe(400);
  });

  it('persists a valid apiKey → hasManagedOpenRouterKey() true', async () => {
    expect(hasManagedOpenRouterKey()).toBe(false);
    const req = createMockReq({ apiKey: 'sk-or-managed-abc123' });
    const res = createMockRes();
    await handleOpenRouterManagedKey(req, res);
    expect(res._status).toBe(200);
    expect(hasManagedOpenRouterKey()).toBe(true);
    expect(loadManagedOpenRouterKey()).toBe('sk-or-managed-abc123');
    // Response must never echo the key.
    expect(JSON.stringify(res._body)).not.toContain('sk-or-managed-abc123');
  });

  it('clears the key when apiKey: null', async () => {
    const req1 = createMockReq({ apiKey: 'sk-or-managed-xyz' });
    await handleOpenRouterManagedKey(req1, createMockRes());
    expect(hasManagedOpenRouterKey()).toBe(true);

    const req2 = createMockReq({ apiKey: null });
    const res2 = createMockRes();
    await handleOpenRouterManagedKey(req2, res2);
    expect(res2._status).toBe(200);
    expect(hasManagedOpenRouterKey()).toBe(false);
    expect(loadManagedOpenRouterKey()).toBeNull();
  });
});
