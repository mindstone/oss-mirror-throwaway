/**
 * Council Routing Tests
 *
 * Tests header-based routing used by council/ad-hoc route-table turns.
 * Imports directly from localModelProxyServer — no reimplementation.
 *
 * Covers:
 * - SDK_MODEL_ALIASES: known alias set for passthrough detection
 * - CouncilErrorCallback: real-time error surfacing from proxy
 * - Security: auth token and host header validation
 * - Integration: route resolution via real HTTP proxy
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import http from 'node:http';
import type { ModelProfile } from '@shared/types';

vi.mock('@core/services/settingsStore', () => ({
  setSettingsStoreAdapter: vi.fn(),
  getSettings: () => ({
    providerKeys: {},
    claude: { apiKey: 'fake-ant-test-key' },
    models: { apiKey: 'fake-ant-test-key' },
  }),
}));

import {
  SDK_MODEL_ALIASES,
  proxyManager,
  type ModelRouteTable,
} from '../localModelProxyServer';

// ── Helpers ────────────────────────────────────────────────────────

function makeProfile(overrides: Partial<ModelProfile> & { id: string; name: string }): ModelProfile {
  return {
    serverUrl: 'http://localhost:11434',
    createdAt: Date.now(),
    model: 'test-model',
    ...overrides,
  };
}

function makeAnthropicBody(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    model: 'test-model',
    max_tokens: 1024,
    messages: [{ role: 'user', content: 'Hello' }],
    stream: false,
    ...overrides,
  });
}

function sendToProxy(
  proxyUrl: string,
  body: string,
  authToken: string,
  headers: Record<string, string> = {}
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const url = new URL(`${proxyUrl}/v1/messages`);
    const req = http.request(
      {
        hostname: url.hostname,
        port: url.port,
        path: url.pathname,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Proxy-Auth': authToken,
          Host: '127.0.0.1',
          ...headers,
        },
      },
      (res) => {
        let data = '';
        res.on('data', (chunk) => (data += chunk));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: data }));
      }
    );
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

function fakeOpenAIResponse(model = 'test-model') {
  return {
    ok: true,
    status: 200,
    headers: new Headers({ 'content-type': 'application/json' }),
    json: async () => ({
      id: 'chatcmpl-test',
      object: 'chat.completion',
      created: Date.now(),
      model,
      choices: [{ index: 0, message: { role: 'assistant', content: 'Response' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    }),
    text: async () => '',
  };
}

// ── Unit Tests: SDK_MODEL_ALIASES ────────────────────────────────

describe('SDK_MODEL_ALIASES', () => {
  it('contains all known SDK model aliases including semantic tier names', () => {
    expect(SDK_MODEL_ALIASES.has('sonnet')).toBe(true);
    expect(SDK_MODEL_ALIASES.has('opus')).toBe(true);
    expect(SDK_MODEL_ALIASES.has('haiku')).toBe(true);
    expect(SDK_MODEL_ALIASES.has('best')).toBe(true);
    expect(SDK_MODEL_ALIASES.has('inherit')).toBe(true);
    expect(SDK_MODEL_ALIASES.has('planner')).toBe(true);
    // Semantic tier aliases (used by proxy-routed agents and internal subagents)
    expect(SDK_MODEL_ALIASES.has('working')).toBe(true);
    expect(SDK_MODEL_ALIASES.has('thinking')).toBe(true);
    expect(SDK_MODEL_ALIASES.has('fast')).toBe(true);
  });

  it('does not contain arbitrary model names', () => {
    expect(SDK_MODEL_ALIASES.has('gpt-5.2')).toBe(false);
    expect(SDK_MODEL_ALIASES.has('deepseek-r1')).toBe(false);
    expect(SDK_MODEL_ALIASES.has('claude-sonnet-4-5')).toBe(false);
  });
});

// ── Integration Tests: CouncilErrorCallback ──────────────────────

let testPort = 19900;

describe('CouncilErrorCallback', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    fetchSpy = vi.spyOn(global, 'fetch');
  });

  afterEach(async () => {
    proxyManager.removeRoutes('__test__');
    proxyManager.clearBaseProfile();
    await proxyManager.stop();
    fetchSpy.mockRestore();
    testPort += 10;
  });

  it('fires callback on council member request failure', async () => {
    const errorCallback = vi.fn();
    const profile = makeProfile({ id: 'gpt52', name: 'GPT-5.2', model: 'gpt-5.2' });
    const routeTable: ModelRouteTable = { routes: new Map([['gpt-5.2', profile]]) };

    await proxyManager.addRoutes('__test__', routeTable, errorCallback, testPort);
    const proxyUrl = proxyManager.getUrl()!;
    const token = proxyManager.getAuthToken()!;

    // Mock upstream to fail
    fetchSpy.mockRejectedValue(new Error('Connection refused'));

    const body = makeAnthropicBody({
      model: 'sonnet',
      system: 'Council member.',
    });
    const res = await sendToProxy(proxyUrl, body, token, {
      'x-routed-turn-id': '__test__',
      'x-routed-model': 'gpt-5.2',
    });

    expect(res.status).toBe(500);
    expect(errorCallback).toHaveBeenCalledTimes(1);
    expect(errorCallback).toHaveBeenCalledWith('gpt-5.2', expect.stringContaining('Connection refused'));
  });

  it('truncates long error messages to 120 chars', async () => {
    const errorCallback = vi.fn();
    const profile = makeProfile({ id: 'gpt52', name: 'GPT-5.2', model: 'gpt-5.2' });
    const routeTable: ModelRouteTable = { routes: new Map([['gpt-5.2', profile]]) };

    await proxyManager.addRoutes('__test__', routeTable, errorCallback, testPort);
    const proxyUrl = proxyManager.getUrl()!;
    const token = proxyManager.getAuthToken()!;

    const longError = 'X'.repeat(200);
    fetchSpy.mockRejectedValue(new Error(longError));

    const body = makeAnthropicBody({
      model: 'sonnet',
      system: 'Council member.',
    });
    await sendToProxy(proxyUrl, body, token, {
      'x-routed-turn-id': '__test__',
      'x-routed-model': 'gpt-5.2',
    });

    expect(errorCallback).toHaveBeenCalledTimes(1);
    const [, errorMsg] = errorCallback.mock.calls[0];
    expect(errorMsg.length).toBeLessThanOrEqual(123); // 120 + '...'
  });

  it('does not fire callback for passthrough (lead agent) requests', async () => {
    const errorCallback = vi.fn();
    const profile = makeProfile({ id: 'gpt52', name: 'GPT-5.2', model: 'gpt-5.2' });
    const routeTable: ModelRouteTable = { routes: new Map([['gpt-5.2', profile]]) };

    await proxyManager.addRoutes('__test__', routeTable, errorCallback, testPort);
    const proxyUrl = proxyManager.getUrl()!;
    const token = proxyManager.getAuthToken()!;

    // Claude model — passthrough, even if it fails
    fetchSpy.mockImplementation(async () => ({
      ok: false,
      status: 500,
      text: async () => '{"error": "server error"}',
      body: null,
      headers: new Headers({ 'content-type': 'application/json' }),
    }) as unknown as Response);

    const body = makeAnthropicBody({ model: 'claude-sonnet-4-5' });
    await sendToProxy(proxyUrl, body, token);

    expect(errorCallback).not.toHaveBeenCalled();
  });

  it('callback is cleared on proxy stop', async () => {
    const errorCallback = vi.fn();
    const profile = makeProfile({ id: 'gpt52', name: 'GPT-5.2', model: 'gpt-5.2' });
    const routeTable: ModelRouteTable = { routes: new Map([['gpt-5.2', profile]]) };

    await proxyManager.addRoutes('__test__', routeTable, errorCallback, testPort);
    await proxyManager.stop();

    // Start a new proxy without callback — should not fire old callback
    await proxyManager.addRoutes('__test2__', routeTable, undefined, testPort + 1);
    const proxyUrl = proxyManager.getUrl()!;
    const token = proxyManager.getAuthToken()!;

    fetchSpy.mockRejectedValue(new Error('fail'));
    const body = makeAnthropicBody({
      model: 'sonnet',
      system: 'Council member.',
    });
    await sendToProxy(proxyUrl, body, token, {
      'x-routed-turn-id': '__test2__',
      'x-routed-model': 'gpt-5.2',
    });

    expect(errorCallback).not.toHaveBeenCalled();
  });
});

// ── Integration Tests: Security ──────────────────────────────────

describe('proxy security', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    fetchSpy = vi.spyOn(global, 'fetch').mockImplementation(async () =>
      fakeOpenAIResponse() as unknown as Response
    );
  });

  afterEach(async () => {
    proxyManager.clearBaseProfile();
    await proxyManager.stop();
    fetchSpy.mockRestore();
    testPort += 10;
  });

  it('rejects requests without auth token', async () => {
    const profile = makeProfile({ id: 'test', name: 'Test' });
    const proxyUrl = await proxyManager.startSingleProfile(profile, testPort);
    const body = makeAnthropicBody();

    const res = await new Promise<{ status: number; body: string }>((resolve, reject) => {
      const url = new URL(`${proxyUrl}/v1/messages`);
      const req = http.request(
        {
          hostname: url.hostname,
          port: url.port,
          path: url.pathname,
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Host: '127.0.0.1' },
        },
        (res) => {
          let data = '';
          res.on('data', (chunk) => (data += chunk));
          res.on('end', () => resolve({ status: res.statusCode ?? 0, body: data }));
        }
      );
      req.on('error', reject);
      req.write(body);
      req.end();
    });

    expect(res.status).toBe(401);
  });

  it('rejects requests with wrong auth token', async () => {
    const profile = makeProfile({ id: 'test', name: 'Test' });
    await proxyManager.startSingleProfile(profile, testPort);
    const body = makeAnthropicBody();

    const res = await sendToProxy(proxyManager.getUrl()!, body, 'wrong-token');
    expect(res.status).toBe(403);
  });

  it('rejects requests with invalid Host header', async () => {
    const profile = makeProfile({ id: 'test', name: 'Test' });
    const proxyUrl = await proxyManager.startSingleProfile(profile, testPort);
    const token = proxyManager.getAuthToken()!;
    const body = makeAnthropicBody();

    const res = await new Promise<{ status: number; body: string }>((resolve, reject) => {
      const url = new URL(`${proxyUrl}/v1/messages`);
      const req = http.request(
        {
          hostname: url.hostname,
          port: url.port,
          path: url.pathname,
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Proxy-Auth': token,
            Host: 'evil.com',
          },
        },
        (res) => {
          let data = '';
          res.on('data', (chunk) => (data += chunk));
          res.on('end', () => resolve({ status: res.statusCode ?? 0, body: data }));
        }
      );
      req.on('error', reject);
      req.write(body);
      req.end();
    });

    expect(res.status).toBe(403);
  });

  it('accepts requests with valid auth and localhost host', async () => {
    const profile = makeProfile({ id: 'test', name: 'Test' });
    await proxyManager.startSingleProfile(profile, testPort);
    const token = proxyManager.getAuthToken()!;
    const body = makeAnthropicBody();

    const res = await sendToProxy(proxyManager.getUrl()!, body, token);
    expect(res.status).toBe(200);
  });
});

// ── Integration Tests: Multi-route routing ───────────────────────

describe('multi-route proxy routing', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;
  let capturedUrls: string[] = [];

  beforeEach(() => {
    capturedUrls = [];
    fetchSpy = vi.spyOn(global, 'fetch').mockImplementation(async (url, _init) => {
      capturedUrls.push(String(url));
      if (String(url).includes('anthropic.com')) {
        return {
          ok: true,
          status: 200,
          headers: new Headers({ 'content-type': 'application/json' }),
          text: async () => JSON.stringify({
            id: 'msg_test', type: 'message', role: 'assistant',
            content: [{ type: 'text', text: 'Hello' }],
            model: 'claude-sonnet-4-5', stop_reason: 'end_turn',
            usage: { input_tokens: 10, output_tokens: 5 },
          }),
          body: null,
        } as unknown as Response;
      }
      return fakeOpenAIResponse() as unknown as Response;
    });
  });

  afterEach(async () => {
    proxyManager.removeRoutes('__test__');
    proxyManager.clearBaseProfile();
    await proxyManager.stop();
    fetchSpy.mockRestore();
    testPort += 10;
  });

  it('routes requests by x-routed-model header to the correct profile endpoint', async () => {
    const gptProfile = makeProfile({
      id: 'gpt52', name: 'GPT-5.2', model: 'gpt-5.2',
      serverUrl: 'http://localhost:11111',
    });
    const routeTable: ModelRouteTable = { routes: new Map([['gpt-5.2', gptProfile]]) };

    await proxyManager.addRoutes('__test__', routeTable, undefined, testPort);
    const proxyUrl = proxyManager.getUrl()!;
    const token = proxyManager.getAuthToken()!;

    const body = makeAnthropicBody({
      model: 'sonnet',
      system: 'You are a council member.',
    });
    await sendToProxy(proxyUrl, body, token, {
      'x-routed-turn-id': '__test__',
      'x-routed-model': 'gpt-5.2',
    });

    expect(capturedUrls).toHaveLength(1);
    expect(capturedUrls[0]).toContain('localhost:11111');
  });

  it('passes through Claude model requests to Anthropic API', async () => {
    const gptProfile = makeProfile({
      id: 'gpt52', name: 'GPT-5.2', model: 'gpt-5.2',
      serverUrl: 'http://localhost:11111',
    });
    const routeTable: ModelRouteTable = { routes: new Map([['gpt-5.2', gptProfile]]) };

    await proxyManager.addRoutes('__test__', routeTable, undefined, testPort);
    const proxyUrl = proxyManager.getUrl()!;
    const token = proxyManager.getAuthToken()!;

    const body = makeAnthropicBody({ model: 'claude-sonnet-4-5' });
    const res = await sendToProxy(proxyUrl, body, token);

    expect(res.status).toBe(200);
    expect(capturedUrls).toHaveLength(1);
    expect(capturedUrls[0]).toContain('anthropic.com');
  });

  it('returns 400 for unknown model in multi-route mode', async () => {
    const gptProfile = makeProfile({
      id: 'gpt52', name: 'GPT-5.2', model: 'gpt-5.2',
      serverUrl: 'http://localhost:11111',
    });
    const routeTable: ModelRouteTable = { routes: new Map([['gpt-5.2', gptProfile]]) };

    await proxyManager.addRoutes('__test__', routeTable, undefined, testPort);
    const proxyUrl = proxyManager.getUrl()!;
    const token = proxyManager.getAuthToken()!;

    // Non-council, non-Claude, non-base-profile model → 400
    const body = makeAnthropicBody({ model: 'unknown-model-xyz' });
    const res = await sendToProxy(proxyUrl, body, token);

    expect(res.status).toBe(400);
    expect(res.body).toContain('No route configured');
  });

  it('passes through SDK alias models in multi-route mode', async () => {
    const gptProfile = makeProfile({
      id: 'gpt52', name: 'GPT-5.2', model: 'gpt-5.2',
      serverUrl: 'http://localhost:11111',
    });
    const routeTable: ModelRouteTable = { routes: new Map([['gpt-5.2', gptProfile]]) };

    await proxyManager.addRoutes('__test__', routeTable, undefined, testPort);
    const proxyUrl = proxyManager.getUrl()!;
    const token = proxyManager.getAuthToken()!;

    // SDK alias without routing tag — should passthrough to Anthropic
    const body = makeAnthropicBody({ model: 'sonnet' });
    const res = await sendToProxy(proxyUrl, body, token);

    expect(res.status).toBe(200);
    expect(capturedUrls).toHaveLength(1);
    expect(capturedUrls[0]).toContain('anthropic.com');
  });

  it('forwards request body without prompt-route mutation', async () => {
    const capturedBodies: Record<string, unknown>[] = [];
    fetchSpy.mockRestore();
    fetchSpy = vi.spyOn(global, 'fetch').mockImplementation(async (_url, init) => {
      if (init?.body) {
        capturedBodies.push(JSON.parse(init.body as string));
      }
      return fakeOpenAIResponse() as unknown as Response;
    });

    const gptProfile = makeProfile({
      id: 'gpt52', name: 'GPT-5.2', model: 'gpt-5.2',
      serverUrl: 'http://localhost:11111',
    });
    const routeTable: ModelRouteTable = { routes: new Map([['gpt-5.2', gptProfile]]) };

    await proxyManager.addRoutes('__test__', routeTable, undefined, testPort);
    const proxyUrl = proxyManager.getUrl()!;
    const token = proxyManager.getAuthToken()!;

    const body = makeAnthropicBody({
      model: 'sonnet',
      system: 'You are a council member.',
    });
    await sendToProxy(proxyUrl, body, token, {
      'x-routed-turn-id': '__test__',
      'x-routed-model': 'gpt-5.2',
    });

    expect(capturedBodies).toHaveLength(1);
    expect(JSON.stringify(capturedBodies[0])).toContain('You are a council member.');
  });
});
