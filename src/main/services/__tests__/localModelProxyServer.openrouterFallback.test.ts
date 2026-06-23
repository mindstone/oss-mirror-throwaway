/**
 * OpenRouter Fallback Routing Tests
 *
 * Tests the OpenRouter fallback mechanism for multi-route proxy mode.
 * When ad-hoc routes are active and the turn has OpenRouter fallback enabled,
 * unmatched models and Claude-family models should route through OpenRouter
 * instead of returning 400 or going to the Anthropic API.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import http from 'node:http';
import type { ModelProfile } from '@shared/types';

vi.mock('@core/services/settingsStore', () => ({
  setSettingsStoreAdapter: vi.fn(),
  // models.apiKey satisfies the Anthropic passthrough auth gate; claude stays
  // populated to preserve the legacy fixture shape these tests were built with.
  getSettings: () => ({
    claude: { apiKey: 'fake-test-anthropic-key' },
    models: { apiKey: 'fake-test-anthropic-key' },
    providerKeys: {},
  }),
}));

vi.mock('@core/services/tokenStorage/openRouterTokenStorage', () => ({
  loadOpenRouterTokens: vi.fn(() => ({ apiKey: 'fake-or-test-key', refreshToken: null })),
}));

import {
  proxyManager,
  type ModelRouteTable,
} from '../localModelProxyServer';

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
        res.on('data', (chunk: Buffer) => (data += chunk));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: data }));
      }
    );
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

let nextPort = 49400;
let fetchSpy: ReturnType<typeof vi.spyOn>;
let capturedUrls: string[] = [];

function fakeOpenRouterResponse(): Partial<Response> {
  return {
    ok: true,
    status: 200,
    headers: new Headers({ 'content-type': 'application/json' }),
    text: () => Promise.resolve(JSON.stringify({
      id: 'msg_test',
      type: 'message',
      role: 'assistant',
      content: [{ type: 'text', text: 'Hello from OpenRouter' }],
      model: 'anthropic/claude-opus-4.7',
      usage: { input_tokens: 10, output_tokens: 5 },
    })),
    body: null,
  };
}

function fakeAnthropicResponse(): Partial<Response> {
  return {
    ok: true,
    status: 200,
    headers: new Headers({ 'content-type': 'application/json' }),
    text: () => Promise.resolve(JSON.stringify({
      id: 'msg_test',
      type: 'message',
      role: 'assistant',
      content: [{ type: 'text', text: 'Hello from Anthropic' }],
      model: 'claude-opus-4.6',
      usage: { input_tokens: 10, output_tokens: 5 },
    })),
    body: null,
  };
}

beforeEach(() => {
  capturedUrls = [];
  fetchSpy = vi.spyOn(global, 'fetch').mockImplementation(async (url) => {
    capturedUrls.push(typeof url === 'string' ? url : url.toString());
    if (capturedUrls[capturedUrls.length - 1].includes('openrouter.ai')) {
      return fakeOpenRouterResponse() as unknown as Response;
    }
    return fakeAnthropicResponse() as unknown as Response;
  });
});

afterEach(async () => {
  fetchSpy.mockRestore();
  await proxyManager.stop();
});

describe('OpenRouter fallback routing', () => {
  it('fails closed when fallback turn requests omit x-routed-model (anthropic/claude-* model)', async () => {
    const gptProfile = makeProfile({ id: 'gpt52', name: 'GPT-5.2', model: 'gpt-5.2' });
    const routeTable: ModelRouteTable = { routes: new Map([['gpt-5.2', gptProfile]]) };

    await proxyManager.addRoutes('__or_test__', routeTable, undefined, nextPort++, true);
    const proxyUrl = proxyManager.getUrl()!;
    const token = proxyManager.getAuthToken()!;

    const body = makeAnthropicBody({ model: 'anthropic/claude-opus-4.7' });
    const res = await sendToProxy(proxyUrl, body, token, { 'x-routed-turn-id': '__or_test__' });

    expect(res.status).toBe(400);
    expect(JSON.parse(res.body)).toEqual({
      error: 'route_required',
      message: 'Missing x-routed-model header for route-table turn request',
    });
    expect(capturedUrls).toHaveLength(0);
  });

  it('fails closed when fallback turn requests omit x-routed-model (bare claude-* model)', async () => {
    const gptProfile = makeProfile({ id: 'gpt52', name: 'GPT-5.2', model: 'gpt-5.2' });
    const routeTable: ModelRouteTable = { routes: new Map([['gpt-5.2', gptProfile]]) };

    await proxyManager.addRoutes('__or_test__', routeTable, undefined, nextPort++, true);
    const proxyUrl = proxyManager.getUrl()!;
    const token = proxyManager.getAuthToken()!;

    const body = makeAnthropicBody({ model: 'claude-sonnet-4-5' });
    const res = await sendToProxy(proxyUrl, body, token, { 'x-routed-turn-id': '__or_test__' });

    expect(res.status).toBe(400);
    expect(JSON.parse(res.body)).toEqual({
      error: 'route_required',
      message: 'Missing x-routed-model header for route-table turn request',
    });
    expect(capturedUrls).toHaveLength(0);
  });

  it('fails closed when fallback turn requests omit x-routed-model (unmatched model)', async () => {
    const gptProfile = makeProfile({ id: 'gpt52', name: 'GPT-5.2', model: 'gpt-5.2' });
    const routeTable: ModelRouteTable = { routes: new Map([['gpt-5.2', gptProfile]]) };

    await proxyManager.addRoutes('__or_test__', routeTable, undefined, nextPort++, true);
    const proxyUrl = proxyManager.getUrl()!;
    const token = proxyManager.getAuthToken()!;

    const body = makeAnthropicBody({ model: 'openai/gpt-5.5' });
    const res = await sendToProxy(proxyUrl, body, token, { 'x-routed-turn-id': '__or_test__' });

    expect(res.status).toBe(400);
    expect(JSON.parse(res.body)).toEqual({
      error: 'route_required',
      message: 'Missing x-routed-model header for route-table turn request',
    });
    expect(capturedUrls).toHaveLength(0);
  });

  it('still returns 400 when fallback is NOT active and x-routed-model is missing', async () => {
    const gptProfile = makeProfile({ id: 'gpt52', name: 'GPT-5.2', model: 'gpt-5.2' });
    const routeTable: ModelRouteTable = { routes: new Map([['gpt-5.2', gptProfile]]) };

    await proxyManager.addRoutes('__or_test__', routeTable, undefined, nextPort++);
    const proxyUrl = proxyManager.getUrl()!;
    const token = proxyManager.getAuthToken()!;

    const body = makeAnthropicBody({ model: 'unknown-model-xyz' });
    const res = await sendToProxy(proxyUrl, body, token, { 'x-routed-turn-id': '__or_test__' });

    expect(res.status).toBe(400);
    expect(JSON.parse(res.body)).toEqual({
      error: 'route_required',
      message: 'Missing x-routed-model header for route-table turn request',
    });
    expect(capturedUrls).toHaveLength(0);
  });

  it('still fails closed for claude-* when fallback is NOT active and x-routed-model is missing', async () => {
    const gptProfile = makeProfile({ id: 'gpt52', name: 'GPT-5.2', model: 'gpt-5.2' });
    const routeTable: ModelRouteTable = { routes: new Map([['gpt-5.2', gptProfile]]) };

    await proxyManager.addRoutes('__or_test__', routeTable, undefined, nextPort++);
    const proxyUrl = proxyManager.getUrl()!;
    const token = proxyManager.getAuthToken()!;

    const body = makeAnthropicBody({ model: 'claude-sonnet-4-5' });
    const res = await sendToProxy(proxyUrl, body, token, { 'x-routed-turn-id': '__or_test__' });

    expect(res.status).toBe(400);
    expect(JSON.parse(res.body)).toEqual({
      error: 'route_required',
      message: 'Missing x-routed-model header for route-table turn request',
    });
    expect(capturedUrls).toHaveLength(0);
  });

  it('clears fallback state on removeRoutes', async () => {
    const gptProfile = makeProfile({ id: 'gpt52', name: 'GPT-5.2', model: 'gpt-5.2' });
    const routeTable: ModelRouteTable = { routes: new Map([['gpt-5.2', gptProfile]]) };

    await proxyManager.addRoutes('__or_test__', routeTable, undefined, nextPort++, true);
    proxyManager.removeRoutes('__or_test__');

    // Re-add without fallback to keep proxy alive
    await proxyManager.addRoutes('__or_test2__', routeTable);
    const proxyUrl = proxyManager.getUrl()!;
    const token = proxyManager.getAuthToken()!;

    // Route through the old turn ID (should be cleared)
    const body = makeAnthropicBody({ model: 'anthropic/claude-opus-4.7' });
    const res = await sendToProxy(proxyUrl, body, token, { 'x-routed-turn-id': '__or_test__' });

    // Without turn routes, falls through — should NOT go to OpenRouter
    // (turn routes were removed, so turn-scoped lookup fails, then isAnthropicModel matches → passthrough to Anthropic)
    expect(capturedUrls).toHaveLength(1);
    expect(capturedUrls[0]).toContain('anthropic.com');
  });

  it('routes ad-hoc matched models through their profile even with fallback active', async () => {
    const gptProfile = makeProfile({
      id: 'gpt52', name: 'GPT-5.2', model: 'gpt-5.2',
      serverUrl: 'http://localhost:11111',
    });
    const routeTable: ModelRouteTable = { routes: new Map([['gpt-5.2', gptProfile]]) };

    await proxyManager.addRoutes('__or_test__', routeTable, undefined, nextPort++, true);
    const proxyUrl = proxyManager.getUrl()!;
    const token = proxyManager.getAuthToken()!;

    const body = makeAnthropicBody({
      model: 'sonnet',
      system: 'Council member.',
    });
    await sendToProxy(proxyUrl, body, token, {
      'x-routed-turn-id': '__or_test__',
      'x-routed-model': 'gpt-5.2',
    });
    // Should route to the profile's server, not OpenRouter
    expect(capturedUrls).toHaveLength(1);
    expect(capturedUrls[0]).toContain('localhost:11111');
  });
});
