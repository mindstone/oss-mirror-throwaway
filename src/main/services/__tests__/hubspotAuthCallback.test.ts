import http from 'node:http';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mockGetPath = vi.fn<(name: string) => string>();
const mockOpenExternal = vi.fn().mockResolvedValue(undefined);

vi.mock('electron', () => ({
  app: {
    getPath: (name: string) => mockGetPath(name),
  },
  shell: {
    openExternal: (url: string) => mockOpenExternal(url),
  },
}));

import { cancelHubSpotAuth, startHubSpotAuth } from '../hubspotAuthService';

type HttpResponse = {
  statusCode: number;
  headers: http.IncomingHttpHeaders;
  body: string;
};

const HUBSPOT_TOKEN_URL = 'https://api.hubapi.com/oauth/v1/token';
const HUBSPOT_TOKEN_INFO_URL = 'https://api.hubapi.com/oauth/v1/access-tokens';
const CALLBACK_PORTS = [8081, 8082, 8083, 8084];

async function requestLocal(
  port: number,
  requestPath: string,
  options: {
    method?: 'GET' | 'POST';
    headers?: Record<string, string>;
    body?: string;
  } = {},
): Promise<HttpResponse> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port,
        path: requestPath,
        method: options.method ?? 'GET',
        headers: options.headers,
      },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => { body += chunk; });
        res.on('end', () => {
          resolve({
            statusCode: res.statusCode ?? 0,
            headers: res.headers,
            body,
          });
        });
      },
    );

    req.on('error', reject);
    if (options.body) req.write(options.body);
    req.end();
  });
}

async function waitForAuthUrl(): Promise<URL> {
  for (let i = 0; i < 40; i++) {
    const call = mockOpenExternal.mock.calls.at(-1);
    if (call && typeof call[0] === 'string') {
      return new URL(call[0]);
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('Timed out waiting for HubSpot auth URL');
}

function parseRedirect(authUrl: URL): { port: number; state: string } {
  const redirectUri = authUrl.searchParams.get('redirect_uri');
  const state = authUrl.searchParams.get('state');
  if (!redirectUri || !state) {
    throw new Error('Missing redirect_uri or state in auth URL');
  }
  const parsedRedirect = new URL(redirectUri);
  return {
    port: Number(parsedRedirect.port),
    state,
  };
}

async function reserveCallbackPort(): Promise<{ server: http.Server; port: number }> {
  for (const port of CALLBACK_PORTS) {
    const server = http.createServer((_req, res) => {
      res.statusCode = 200;
      res.end('occupied');
    });

    try {
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, '127.0.0.1', () => resolve());
      });
      return { server, port };
    } catch {
      try { server.close(); } catch { /* ignore */ }
    }
  }
  throw new Error('No callback port available to reserve');
}

describe('hubspot callback hardening', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'hubspot-auth-callback-'));
    mockGetPath.mockReturnValue(tempDir);
    mockOpenExternal.mockClear();

    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) => {
      const requestUrl = typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url;

      if (requestUrl.startsWith(HUBSPOT_TOKEN_URL)) {
        return new Response(JSON.stringify({
          access_token: 'access-token',
          refresh_token: 'refresh-token',
          expires_in: 3600,
          token_type: 'bearer',
        }), { status: 200 });
      }

      if (requestUrl.startsWith(HUBSPOT_TOKEN_INFO_URL)) {
        return new Response(JSON.stringify({
          user: 'integration@example.com',
          hub_id: 123,
          scopes: ['oauth'],
        }), { status: 200 });
      }

      throw new Error(`Unexpected fetch URL: ${requestUrl}`);
    }));
  });

  afterEach(async () => {
    cancelHubSpotAuth();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    await fsp.rm(tempDir, { recursive: true, force: true });
  });

  it('binds callback server to 127.0.0.1', async () => {
    const listenSpy = vi.spyOn(http.Server.prototype, 'listen');
    const authPromise = startHubSpotAuth('client-id', 'client-secret');
    await waitForAuthUrl();

    const listenCall = listenSpy.mock.calls.find(
      (call) => typeof call[0] === 'number' && typeof call[1] === 'string',
    );
    expect(listenCall?.[1]).toBe('127.0.0.1');

    cancelHubSpotAuth();
    await expect(authPromise).rejects.toThrow(/cancelled/i);
  });

  it('generates CSRF state and consumes it on /complete-auth', async () => {
    const authPromise = startHubSpotAuth('client-id', 'client-secret');
    const authUrl = await waitForAuthUrl();
    const { port, state } = parseRedirect(authUrl);

    expect(state).toMatch(/^[a-f0-9]{32}$/);

    const callbackResponse = await requestLocal(
      port,
      `/callback?code=oauth-code-123&state=${encodeURIComponent(state)}`,
    );
    expect(callbackResponse.statusCode).toBe(200);

    const completeResponse = await requestLocal(port, '/complete-auth', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Origin: `http://127.0.0.1:${port}`,
      },
      body: JSON.stringify({ code: 'oauth-code-123', state }),
    });

    expect(completeResponse.statusCode).toBe(200);
    expect(JSON.parse(completeResponse.body)).toMatchObject({ success: true, email: 'integration@example.com' });
    await expect(authPromise).resolves.toBe('integration@example.com');
  });

  it('sets a 5-minute timeout that shuts down pending auth', async () => {
    const timeoutSpy = vi.spyOn(globalThis, 'setTimeout');
    const authPromise = startHubSpotAuth('client-id', 'client-secret');
    await waitForAuthUrl();

    const timeoutCall = timeoutSpy.mock.calls.find((call) => call[1] === 5 * 60 * 1000);
    expect(timeoutCall).toBeDefined();
    const timeoutHandler = timeoutCall?.[0] as (() => void) | undefined;
    expect(timeoutHandler).toBeTypeOf('function');

    timeoutHandler?.();
    await expect(authPromise).rejects.toThrow('OAuth flow timed out');
  });

  it('handles callback port collisions by trying the next configured port', async () => {
    const { server: occupiedServer, port: occupiedPort } = await reserveCallbackPort();
    const authPromise = startHubSpotAuth('client-id', 'client-secret');

    try {
      const authUrl = await waitForAuthUrl();
      const { port } = parseRedirect(authUrl);

      expect(port).not.toBe(occupiedPort);
      expect(CALLBACK_PORTS).toContain(port);
    } finally {
      cancelHubSpotAuth();
      await expect(authPromise).rejects.toThrow(/cancelled/i);
      await new Promise<void>((resolve) => occupiedServer.close(() => resolve()));
    }
  });

  it('validates Content-Type and Origin on /complete-auth POST', async () => {
    const authPromise = startHubSpotAuth('client-id', 'client-secret');
    const authUrl = await waitForAuthUrl();
    const { port, state } = parseRedirect(authUrl);

    await requestLocal(port, `/callback?code=oauth-code-123&state=${encodeURIComponent(state)}`);

    const invalidContentType = await requestLocal(port, '/complete-auth', {
      method: 'POST',
      headers: {
        'Content-Type': 'text/plain',
        Origin: `http://127.0.0.1:${port}`,
      },
      body: JSON.stringify({ code: 'oauth-code-123', state }),
    });
    expect(invalidContentType.statusCode).toBe(400);

    const invalidOrigin = await requestLocal(port, '/complete-auth', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Origin: 'http://evil.example',
      },
      body: JSON.stringify({ code: 'oauth-code-123', state }),
    });
    expect(invalidOrigin.statusCode).toBe(403);

    cancelHubSpotAuth();
    await expect(authPromise).rejects.toThrow(/cancelled/i);
  });

  it('includes security headers on callback responses', async () => {
    const authPromise = startHubSpotAuth('client-id', 'client-secret');
    const authUrl = await waitForAuthUrl();
    const { port, state } = parseRedirect(authUrl);

    const callbackResponse = await requestLocal(
      port,
      `/callback?code=oauth-code-123&state=${encodeURIComponent(state)}`,
    );
    expect(callbackResponse.headers['cache-control']).toBe('no-store');
    expect(callbackResponse.headers['x-content-type-options']).toBe('nosniff');
    expect(callbackResponse.headers['referrer-policy']).toBe('no-referrer');

    const invalidPost = await requestLocal(port, '/complete-auth', {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain' },
      body: JSON.stringify({ code: 'oauth-code-123', state }),
    });
    expect(invalidPost.headers['cache-control']).toBe('no-store');
    expect(invalidPost.headers['x-content-type-options']).toBe('nosniff');
    expect(invalidPost.headers['referrer-policy']).toBe('no-referrer');

    cancelHubSpotAuth();
    await expect(authPromise).rejects.toThrow(/cancelled/i);
  });

  it('escapes HTML in error pages', async () => {
    const authPromise = startHubSpotAuth('client-id', 'client-secret');
    const authRejection = authPromise.then(
      () => {
        throw new Error('Expected HubSpot auth to reject');
      },
      (error) => error as Error,
    );
    const authUrl = await waitForAuthUrl();
    const { port, state } = parseRedirect(authUrl);
    const injected = '<script>alert("xss")</script>';

    const response = await requestLocal(
      port,
      `/callback?error=${encodeURIComponent(injected)}&state=${encodeURIComponent(state)}`,
    );

    expect(response.statusCode).toBe(400);
    expect(response.body).not.toContain(injected);
    expect(response.body).toContain('&lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt;');
    const rejection = await authRejection;
    expect(rejection.message).toContain('HubSpot OAuth error');
  });

  it('uses JSON.stringify for success-page JS payload interpolation', async () => {
    const authPromise = startHubSpotAuth('client-id', 'client-secret');
    const authUrl = await waitForAuthUrl();
    const { port, state } = parseRedirect(authUrl);
    const trickyCode = `abc"');window.injected=true;//`;

    const response = await requestLocal(
      port,
      `/callback?code=${encodeURIComponent(trickyCode)}&state=${encodeURIComponent(state)}`,
    );

    expect(response.statusCode).toBe(200);
    expect(response.body).toContain('body: JSON.stringify({ code:');
    expect(response.body).toContain(JSON.stringify(trickyCode));
    expect(response.body).not.toContain(`code: '${trickyCode}'`);

    cancelHubSpotAuth();
    await expect(authPromise).rejects.toThrow(/cancelled/i);
  });
});
