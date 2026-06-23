/**
 * Tests for POST /api/codex/tokens — the desktop → cloud Codex OAuth token
 * sync endpoint. The route delegates to core storage; the interesting cases
 * are payload validation and the null-clear branch.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import http from 'node:http';
import { handleCodexTokens } from '../routes/codexTokens';
import { clearCodexTokens, loadCodexTokens } from '@core/services/codexTokenStorage';
import { getSettings, updateSettings, applyCodexProviderHeal } from '@core/services/settingsStore/index';

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

describe('POST /api/codex/tokens', () => {
  beforeEach(() => {
    clearCodexTokens({ cause: 'manual_logout', source: 'codex_auth_core' });
  });

  it('rejects non-POST methods', async () => {
    const req = createMockReq({}, 'GET');
    const res = createMockRes();
    await handleCodexTokens(req, res);
    expect(res._status).toBe(405);
  });

  it('rejects missing body', async () => {
    // readBody returns null for empty body.
    const req = new http.IncomingMessage(null as never);
    req.method = 'POST';
    req.push(null);
    const res = createMockRes();
    await handleCodexTokens(req, res);
    expect(res._status).toBe(400);
  });

  it('rejects invalid tokens shape', async () => {
    const req = createMockReq({ tokens: { accessToken: 'only-one-field' } });
    const res = createMockRes();
    await handleCodexTokens(req, res);
    expect(res._status).toBe(400);
    const body = res._body as { error?: { code?: string } };
    expect(body.error?.code).toBe('INVALID_TOKENS');
  });

  it('persists a valid token payload', async () => {
    const tokens = {
      accessToken: 'access-abc',
      refreshToken: 'refresh-xyz',
      expiresAt: Date.now() + 60_000,
      accountId: 'acct_1',
      accountEmail: '[external-email]',
    };
    const req = createMockReq({ tokens });
    const res = createMockRes();
    await handleCodexTokens(req, res);
    expect(res._status).toBe(200);
    expect(loadCodexTokens()).toEqual(tokens);
  });

  // FOX-3494 (MA-3 cross-surface parity): after tokens sync, the route heals a
  // stranded `activeProvider` to 'codex' — the SAME side-effect as desktop
  // `codex:login`, via the SAME shared core helper.
  it('heals a stranded activeProvider to codex after tokens sync (cross-surface parity)', async () => {
    // openrouter-with-no-token is an unambiguous "unusable" shape (the OR arm
    // reads only settings.openRouter.oauthToken, no env-var dependence).
    updateSettings({ activeProvider: 'openrouter', openRouter: { enabled: true, oauthToken: null, selectedModel: '' } });
    expect(getSettings().activeProvider).toBe('openrouter');

    const tokens = {
      accessToken: 'access-heal',
      refreshToken: 'refresh-heal',
      expiresAt: Date.now() + 60_000,
      accountId: 'acct_heal',
    };
    const req = createMockReq({ tokens });
    const res = createMockRes();
    await handleCodexTokens(req, res);

    expect(res._status).toBe(200);
    expect(getSettings().activeProvider).toBe('codex');
  });

  it('parity: cloud route and the desktop helper produce the same heal verdict', () => {
    // Behavioural-parity (Runtime-Safety T-3): both surfaces call the identical
    // exported `applyCodexProviderHeal`, so identical inputs → identical output.
    updateSettings({ activeProvider: 'openrouter', openRouter: { enabled: true, oauthToken: null, selectedModel: '' } });
    const stranded = getSettings();
    const { migrated, healed } = applyCodexProviderHeal(stranded, {
      codexConnected: true,
      hasManagedKey: false,
    });
    expect(healed).toBe(true);
    expect(migrated.activeProvider).toBe('codex');
  });

  it('clears tokens when tokens: null', async () => {
    const tokens = {
      accessToken: 'access-abc',
      refreshToken: 'refresh-xyz',
      expiresAt: Date.now() + 60_000,
      accountId: 'acct_1',
    };
    const req1 = createMockReq({ tokens });
    await handleCodexTokens(req1, createMockRes());
    expect(loadCodexTokens()).not.toBeNull();

    const req2 = createMockReq({ tokens: null });
    const res2 = createMockRes();
    await handleCodexTokens(req2, res2);
    expect(res2._status).toBe(200);
    expect(loadCodexTokens()).toBeNull();
  });
});
