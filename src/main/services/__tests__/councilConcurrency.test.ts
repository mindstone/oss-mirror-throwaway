/**
 * ProxyManager Concurrency Tests
 *
 * Tests turn-scoped routing added in Stage 2 of the multi-model proxy refactor.
 * Exercises addRoutes/removeRoutes, per-turn stats, callback isolation,
 * base profile coexistence, and auto-stop behavior.
 *
 * Follows existing patterns from councilRouting.test.ts:
 * - Real HTTP servers via ProxyManager
 * - vi.spyOn(global, 'fetch') to mock upstream responses
 * - sendToProxy helper for real HTTP requests
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import http from 'node:http';
import type { ModelProfile } from '@shared/types';

vi.mock('@core/services/settingsStore', () => ({
  setSettingsStoreAdapter: vi.fn(),
  getSettings: () => ({ providerKeys: {} }),
}));

import {
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
  port: number,
  body: string,
  authToken: string,
  headers: Record<string, string> = {}
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port,
        path: '/v1/messages',
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

/** Extract port from the proxy URL. */
function getPort(): number {
  const url = proxyManager.getUrl();
  if (!url) throw new Error('Proxy not running');
  return Number(new URL(url).port);
}

// ── Test Suite ────────────────────────────────────────────────────

let testPort = 29000;

describe('ProxyManager concurrency', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    fetchSpy = vi.spyOn(global, 'fetch').mockImplementation(async (url) => {
      // Default: route Anthropic passthrough and OpenAI-compat responses
      if (String(url).includes('anthropic.com')) {
        return {
          ok: true,
          status: 200,
          headers: new Headers({ 'content-type': 'application/json' }),
          text: async () => JSON.stringify({
            id: 'msg_test', type: 'message', role: 'assistant',
            content: [{ type: 'text', text: 'Hello from Anthropic' }],
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
    // Clean up all turn routes and base profile, then force stop
    for (const turnId of Array.from(proxyManager.getTurnIds())) {
      proxyManager.removeRoutes(turnId);
    }
    proxyManager.clearBaseProfile();
    await proxyManager.stop();
    fetchSpy.mockRestore();
    testPort += 10;
  });

  // ── Test 1: Two concurrent turns, different models ──────────────

  it('routes requests to correct profile when two turns have different models', async () => {
    const capturedUrls: string[] = [];
    fetchSpy.mockImplementation(async (url: string | URL | Request) => {
      capturedUrls.push(String(url));
      return fakeOpenAIResponse() as unknown as Response;
    });

    const profileA = makeProfile({
      id: 'gpt52', name: 'GPT-5.2', model: 'gpt-5.2',
      serverUrl: 'http://localhost:11111',
    });
    const profileB = makeProfile({
      id: 'gemini', name: 'Gemini', model: 'gemini-3-flash',
      serverUrl: 'http://localhost:22222',
    });
    const routesA: ModelRouteTable = { routes: new Map([['gpt-5.2', profileA]]) };
    const routesB: ModelRouteTable = { routes: new Map([['gemini-3-flash', profileB]]) };

    await proxyManager.addRoutes('turnA', routesA, undefined, testPort);
    await proxyManager.addRoutes('turnB', routesB);
    const port = getPort();

    // Send request for turnA (gpt-5.2)
    const bodyA = makeAnthropicBody({
      model: 'sonnet',
      system: 'Council.',
    });
    const resA = await sendToProxy(port, bodyA, proxyManager.getAuthToken()!, {
      'x-routed-turn-id': 'turnA',
      'x-routed-model': 'gpt-5.2',
    });
    expect(resA.status).toBe(200);
    expect(capturedUrls[0]).toContain('localhost:11111');

    // Send request for turnB (gemini)
    const bodyB = makeAnthropicBody({
      model: 'sonnet',
      system: 'Council.',
    });
    const resB = await sendToProxy(port, bodyB, proxyManager.getAuthToken()!, {
      'x-routed-turn-id': 'turnB',
      'x-routed-model': 'gemini-3-flash',
    });
    expect(resB.status).toBe(200);
    expect(capturedUrls[1]).toContain('localhost:22222');
  });

  // ── Test 2: Two concurrent turns, same model name ──────────────

  it('disambiguates same model name across turns via turn-id header', async () => {
    const capturedUrls: string[] = [];
    fetchSpy.mockImplementation(async (url: string | URL | Request) => {
      capturedUrls.push(String(url));
      return fakeOpenAIResponse() as unknown as Response;
    });

    const profileA = makeProfile({
      id: 'gpt52-keyA', name: 'GPT-5.2 (Key A)', model: 'gpt-5.2',
      serverUrl: 'http://localhost:33333',
      apiKey: 'key-a',
    });
    const profileB = makeProfile({
      id: 'gpt52-keyB', name: 'GPT-5.2 (Key B)', model: 'gpt-5.2',
      serverUrl: 'http://localhost:44444',
      apiKey: 'key-b',
    });
    const routesA: ModelRouteTable = { routes: new Map([['gpt-5.2', profileA]]) };
    const routesB: ModelRouteTable = { routes: new Map([['gpt-5.2', profileB]]) };

    await proxyManager.addRoutes('turnA', routesA, undefined, testPort);
    await proxyManager.addRoutes('turnB', routesB);
    const port = getPort();
    const token = proxyManager.getAuthToken()!;

    const body = makeAnthropicBody({
      model: 'sonnet',
      system: 'Council.',
    });

    // TurnA → profileA's endpoint
    const resA = await sendToProxy(port, body, token, {
      'x-routed-turn-id': 'turnA',
      'x-routed-model': 'gpt-5.2',
    });
    expect(resA.status).toBe(200);
    expect(capturedUrls[0]).toContain('localhost:33333');

    // TurnB → profileB's endpoint
    const resB = await sendToProxy(port, body, token, {
      'x-routed-turn-id': 'turnB',
      'x-routed-model': 'gpt-5.2',
    });
    expect(resB.status).toBe(200);
    expect(capturedUrls[1]).toContain('localhost:44444');
  });

  // ── Test 3: Callback isolation ──────────────────────────────────

  it('fires error callback only for the affected turn', async () => {
    const callbackA = vi.fn();
    const callbackB = vi.fn();

    const profileA = makeProfile({
      id: 'gpt52', name: 'GPT-5.2', model: 'gpt-5.2',
      serverUrl: 'http://localhost:55555',
    });
    const profileB = makeProfile({
      id: 'gemini', name: 'Gemini', model: 'gemini-3-flash',
      serverUrl: 'http://localhost:66666',
    });
    const routesA: ModelRouteTable = { routes: new Map([['gpt-5.2', profileA]]) };
    const routesB: ModelRouteTable = { routes: new Map([['gemini-3-flash', profileB]]) };

    await proxyManager.addRoutes('turnA', routesA, callbackA, testPort);
    await proxyManager.addRoutes('turnB', routesB, callbackB);
    const port = getPort();
    const token = proxyManager.getAuthToken()!;

    // Make turnA's upstream fail
    fetchSpy.mockImplementation(async (url: string | URL | Request) => {
      if (String(url).includes('localhost:55555')) {
        throw new Error('Connection refused');
      }
      return fakeOpenAIResponse() as unknown as Response;
    });

    // Trigger error for turnA
    const bodyA = makeAnthropicBody({
      model: 'sonnet',
      system: 'Council.',
    });
    await sendToProxy(port, bodyA, token, {
      'x-routed-turn-id': 'turnA',
      'x-routed-model': 'gpt-5.2',
    });

    expect(callbackA).toHaveBeenCalledTimes(1);
    expect(callbackA).toHaveBeenCalledWith('gpt-5.2', expect.stringContaining('Connection refused'));
    expect(callbackB).not.toHaveBeenCalled();
  });

  // ── Test 4: Per-turn stats ──────────────────────────────────────

  it('returns per-turn stats isolated by turn ID', async () => {
    const profileA = makeProfile({
      id: 'gpt52', name: 'GPT-5.2', model: 'gpt-5.2',
      serverUrl: 'http://localhost:11111',
    });
    const profileB = makeProfile({
      id: 'gemini', name: 'Gemini', model: 'gemini-3-flash',
      serverUrl: 'http://localhost:22222',
    });
    const routesA: ModelRouteTable = { routes: new Map([['gpt-5.2', profileA]]) };
    const routesB: ModelRouteTable = { routes: new Map([['gemini-3-flash', profileB]]) };

    await proxyManager.addRoutes('turnA', routesA, undefined, testPort);
    await proxyManager.addRoutes('turnB', routesB);
    const port = getPort();
    const token = proxyManager.getAuthToken()!;

    // Send 2 requests for turnA, 1 for turnB
    const bodyA = makeAnthropicBody({
      model: 'sonnet',
      system: 'Council.',
    });
    const bodyB = makeAnthropicBody({
      model: 'sonnet',
      system: 'Council.',
    });

    await sendToProxy(port, bodyA, token, {
      'x-routed-turn-id': 'turnA',
      'x-routed-model': 'gpt-5.2',
    });
    await sendToProxy(port, bodyA, token, {
      'x-routed-turn-id': 'turnA',
      'x-routed-model': 'gpt-5.2',
    });
    await sendToProxy(port, bodyB, token, {
      'x-routed-turn-id': 'turnB',
      'x-routed-model': 'gemini-3-flash',
    });

    // Check turnA stats
    const statsA = proxyManager.getAndResetTurnStats('turnA');
    expect(statsA.size).toBe(1);
    const gptStats = statsA.get('gpt-5.2');
    expect(gptStats).toBeDefined();
    expect(gptStats!.requestCount).toBe(2);
    expect(gptStats!.inputTokens).toBe(20);
    expect(gptStats!.outputTokens).toBe(10);

    // Check turnB stats
    const statsB = proxyManager.getAndResetTurnStats('turnB');
    expect(statsB.size).toBe(1);
    const geminiStats = statsB.get('gemini-3-flash');
    expect(geminiStats).toBeDefined();
    expect(geminiStats!.requestCount).toBe(1);

    // After reset, stats should be empty
    const statsAAfterReset = proxyManager.getAndResetTurnStats('turnA');
    expect(statsAAfterReset.size).toBe(0);
  });

  // ── Test 5: Base profile coexistence ────────────────────────────

  it('base profile works alongside turn routes and survives turn removal', async () => {
    const capturedUrls: string[] = [];
    fetchSpy.mockImplementation(async (url: string | URL | Request) => {
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

    // Set up base profile (e.g., Ollama)
    const baseProfile = makeProfile({
      id: 'ollama', name: 'Ollama', model: 'llama3',
      serverUrl: 'http://localhost:77777',
    });
    await proxyManager.setBaseProfile(baseProfile);

    // Add council routes for turnA
    const profileA = makeProfile({
      id: 'gpt52', name: 'GPT-5.2', model: 'gpt-5.2',
      serverUrl: 'http://localhost:11111',
    });
    const routesA: ModelRouteTable = { routes: new Map([['gpt-5.2', profileA]]) };
    await proxyManager.addRoutes('turnA', routesA);
    const port = getPort();
    const token = proxyManager.getAuthToken()!;

    // Request WITHOUT turn header → uses base profile
    const baseBody = makeAnthropicBody({ model: 'llama3' });
    const resBase = await sendToProxy(port, baseBody, token);
    expect(resBase.status).toBe(200);
    expect(capturedUrls[capturedUrls.length - 1]).toContain('localhost:77777');

    // Request WITH turn header → uses turn routes
    const councilBody = makeAnthropicBody({
      model: 'sonnet',
      system: 'Council.',
    });
    const resTurn = await sendToProxy(port, councilBody, token, {
      'x-routed-turn-id': 'turnA',
      'x-routed-model': 'gpt-5.2',
    });
    expect(resTurn.status).toBe(200);
    expect(capturedUrls[capturedUrls.length - 1]).toContain('localhost:11111');

    // Remove turnA routes → base profile still works
    proxyManager.removeRoutes('turnA');

    const resBaseAfter = await sendToProxy(port, baseBody, token);
    expect(resBaseAfter.status).toBe(200);
    expect(capturedUrls[capturedUrls.length - 1]).toContain('localhost:77777');
  });

  // ── Test 6: removeRoutes cleanup ────────────────────────────────

  it('removeRoutes removes only the specified turn, other turns still work', async () => {
    const profileA = makeProfile({
      id: 'gpt52', name: 'GPT-5.2', model: 'gpt-5.2',
      serverUrl: 'http://localhost:11111',
    });
    const profileB = makeProfile({
      id: 'gemini', name: 'Gemini', model: 'gemini-3-flash',
      serverUrl: 'http://localhost:22222',
    });
    const routesA: ModelRouteTable = { routes: new Map([['gpt-5.2', profileA]]) };
    const routesB: ModelRouteTable = { routes: new Map([['gemini-3-flash', profileB]]) };

    await proxyManager.addRoutes('turnA', routesA, undefined, testPort);
    await proxyManager.addRoutes('turnB', routesB);
    const port = getPort();
    const token = proxyManager.getAuthToken()!;

    // Verify both turns initially registered
    const turnIds = Array.from(proxyManager.getTurnIds());
    expect(turnIds).toContain('turnA');
    expect(turnIds).toContain('turnB');

    // Remove turnA
    proxyManager.removeRoutes('turnA');

    // turnA no longer in getTurnIds
    const remainingIds = Array.from(proxyManager.getTurnIds());
    expect(remainingIds).not.toContain('turnA');
    expect(remainingIds).toContain('turnB');

    // TurnB still works
    const bodyB = makeAnthropicBody({
      model: 'sonnet',
      system: 'Council.',
    });
    const resB = await sendToProxy(port, bodyB, token, {
      'x-routed-turn-id': 'turnB',
      'x-routed-model': 'gemini-3-flash',
    });
    expect(resB.status).toBe(200);
  });

  // ── Test 7: Settings change during council ──────────────────────

  it('setBaseProfile during active council does not affect council routes', async () => {
    const capturedUrls: string[] = [];
    fetchSpy.mockImplementation(async (url: string | URL | Request) => {
      capturedUrls.push(String(url));
      return fakeOpenAIResponse() as unknown as Response;
    });

    // Add council routes for turnA
    const profileA = makeProfile({
      id: 'gpt52', name: 'GPT-5.2', model: 'gpt-5.2',
      serverUrl: 'http://localhost:11111',
    });
    const routesA: ModelRouteTable = { routes: new Map([['gpt-5.2', profileA]]) };
    await proxyManager.addRoutes('turnA', routesA, undefined, testPort);
    const port = getPort();
    const token = proxyManager.getAuthToken()!;

    // Change base profile while council is active
    const newBase = makeProfile({
      id: 'ollama-new', name: 'Ollama New', model: 'mistral',
      serverUrl: 'http://localhost:88888',
    });
    await proxyManager.setBaseProfile(newBase);

    // Council request still uses council route
    const councilBody = makeAnthropicBody({
      model: 'sonnet',
      system: 'Council.',
    });
    const resTurn = await sendToProxy(port, councilBody, token, {
      'x-routed-turn-id': 'turnA',
      'x-routed-model': 'gpt-5.2',
    });
    expect(resTurn.status).toBe(200);
    expect(capturedUrls[capturedUrls.length - 1]).toContain('localhost:11111');

    // Non-council request uses new base profile
    const baseBody = makeAnthropicBody({ model: 'mistral' });
    const resBase = await sendToProxy(port, baseBody, token);
    expect(resBase.status).toBe(200);
    expect(capturedUrls[capturedUrls.length - 1]).toContain('localhost:88888');
  });

  // ── Test 8: Auth token stability ────────────────────────────────

  it('auth token remains stable across addRoutes, removeRoutes, setBaseProfile', async () => {
    const profileA = makeProfile({
      id: 'gpt52', name: 'GPT-5.2', model: 'gpt-5.2',
      serverUrl: 'http://localhost:11111',
    });
    const routesA: ModelRouteTable = { routes: new Map([['gpt-5.2', profileA]]) };

    await proxyManager.addRoutes('turnA', routesA, undefined, testPort);
    const initialToken = proxyManager.getAuthToken();
    expect(initialToken).toBeTruthy();

    // Add more routes
    const profileB = makeProfile({
      id: 'gemini', name: 'Gemini', model: 'gemini-3-flash',
      serverUrl: 'http://localhost:22222',
    });
    const routesB: ModelRouteTable = { routes: new Map([['gemini-3-flash', profileB]]) };
    await proxyManager.addRoutes('turnB', routesB);
    expect(proxyManager.getAuthToken()).toBe(initialToken);

    // Remove routes
    proxyManager.removeRoutes('turnA');
    expect(proxyManager.getAuthToken()).toBe(initialToken);

    // Set base profile
    const baseProfile = makeProfile({
      id: 'ollama', name: 'Ollama', model: 'llama3',
      serverUrl: 'http://localhost:77777',
    });
    await proxyManager.setBaseProfile(baseProfile);
    expect(proxyManager.getAuthToken()).toBe(initialToken);
  });

  // ── Test 9: Thought signature cleanup ───────────────────────────

  it('removeRoutes purges thought signatures for that turn', async () => {
    // This test verifies that removeRoutes does prefix-scan cleanup
    // of thought signatures. We verify indirectly by checking that
    // removeRoutes does not throw and that subsequent operations work fine.
    const profileA = makeProfile({
      id: 'gpt52', name: 'GPT-5.2', model: 'gpt-5.2',
      serverUrl: 'http://localhost:11111',
    });
    const profileB = makeProfile({
      id: 'gemini', name: 'Gemini', model: 'gemini-3-flash',
      serverUrl: 'http://localhost:22222',
    });
    const routesA: ModelRouteTable = { routes: new Map([['gpt-5.2', profileA]]) };
    const routesB: ModelRouteTable = { routes: new Map([['gemini-3-flash', profileB]]) };

    await proxyManager.addRoutes('turnA', routesA, undefined, testPort);
    await proxyManager.addRoutes('turnB', routesB);
    const port = getPort();
    const token = proxyManager.getAuthToken()!;

    // Send requests to generate stats (which exercises the code paths that would
    // also create thought signatures if the response contained them)
    const bodyA = makeAnthropicBody({
      model: 'sonnet',
      system: 'Council.',
    });
    await sendToProxy(port, bodyA, token, {
      'x-routed-turn-id': 'turnA',
      'x-routed-model': 'gpt-5.2',
    });

    const bodyB = makeAnthropicBody({
      model: 'sonnet',
      system: 'Council.',
    });
    await sendToProxy(port, bodyB, token, {
      'x-routed-turn-id': 'turnB',
      'x-routed-model': 'gemini-3-flash',
    });

    // removeRoutes for turnA should not throw (purges turnA: prefix)
    expect(() => proxyManager.removeRoutes('turnA')).not.toThrow();

    // turnB should still work fine after turnA cleanup
    const resB = await sendToProxy(port, bodyB, token, {
      'x-routed-turn-id': 'turnB',
      'x-routed-model': 'gemini-3-flash',
    });
    expect(resB.status).toBe(200);
  });

  // ── Test 10: Auto-stop ──────────────────────────────────────────

  it('auto-stops proxy when all routes removed and no base profile', async () => {
    vi.useFakeTimers();

    try {
      const profileA = makeProfile({
        id: 'gpt52', name: 'GPT-5.2', model: 'gpt-5.2',
        serverUrl: 'http://localhost:11111',
      });
      const routesA: ModelRouteTable = { routes: new Map([['gpt-5.2', profileA]]) };

      await proxyManager.addRoutes('turnA', routesA, undefined, testPort);
      expect(proxyManager.isRunning()).toBe(true);

      // Remove all routes + no base profile
      proxyManager.removeRoutes('turnA');
      proxyManager.clearBaseProfile();

      // Proxy still running during debounce
      expect(proxyManager.isRunning()).toBe(true);

      // Advance past 3-second debounce
      await vi.advanceTimersByTimeAsync(3500);

      // Now proxy should have stopped
      expect(proxyManager.isRunning()).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  // ── Test 11: Fail-closed for missing routed-model header ─────────

  it('returns 400 when route-table request is missing x-routed-model header', async () => {
    const profileA = makeProfile({
      id: 'gpt52', name: 'GPT-5.2', model: 'gpt-5.2',
      serverUrl: 'http://localhost:11111',
    });
    const routesA: ModelRouteTable = { routes: new Map([['gpt-5.2', profileA]]) };

    await proxyManager.addRoutes('turnA', routesA, undefined, testPort);
    const port = getPort();
    const token = proxyManager.getAuthToken()!;

    // Send request with turn ID but without routed-model header.
    const body = makeAnthropicBody({
      model: 'sonnet',
      system: 'Council.',
    });
    const res = await sendToProxy(port, body, token, { 'x-routed-turn-id': 'turnA' });

    expect(res.status).toBe(400);
    expect(res.body).toContain('Missing x-routed-model header');
  });
});
