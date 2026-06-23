/**
 * Proxy Upstream Timeout Tests (TDD — FOX-2656)
 *
 * These tests reproduce the bug where alt-model API timeouts are too long:
 * - Non-streaming: 5 minute timeout (should be ~10s)
 * - Streaming: No first-byte/first-chunk timeout (should be ~10s/~15s)
 *
 * Written RED-first per TDD.md: all tests should FAIL against the current code
 * and PASS after the fix is implemented.
 *
 * Bug evidence: User asked "What's the time?" with Gemini Flash selected.
 * Turn took 96 seconds because the proxy waited ~40s before giving up on Gemini.
 */

import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from 'vitest';
import http from 'node:http';
import type { ModelProfile } from '@shared/types';

vi.mock('@core/services/settingsStore', () => ({
  setSettingsStoreAdapter: vi.fn(),
  getSettings: () => ({ providerKeys: {} }),
}));

import {
  proxyManager,
  getUpstreamTimeouts,
  _setUpstreamTimeoutsScaleForTesting,
  _resetUpstreamTimeoutsScaleForTesting,
} from '../localModelProxyServer';

/**
 * Scale factor applied to all upstream timeouts for these integration tests.
 * Production timeouts (30s/45s/90s) are too long to wait through repeatedly in
 * real-I/O tests — see docs/plans/260428_proxy_upstream_timeout_test_speedup.md.
 *
 * Under scale = 1/30:
 *   default tier: firstByteMs=1000ms, firstChunkMs=1500ms, streamChunkMs=3000ms
 *   high tier:    firstByteMs=5000ms, firstChunkMs=~6700ms (200_000/30)
 *
 * Implementer note: if these scaled timeouts ever flake on CI, relax to 1/15
 * (still under target wall-clock budget).
 */
const TIMEOUT_SCALE = 1 / 30;

afterAll(() => {
  _resetUpstreamTimeoutsScaleForTesting();
});

// ── Helpers ────────────────────────────────────────────────────────

function makeProfile(overrides: Partial<ModelProfile> & { id: string; name: string }): ModelProfile {
  return {
    serverUrl: 'http://127.0.0.1:0', // Will be replaced per-test with mock server URL
    createdAt: Date.now(),
    model: 'gemini-2.5-flash',
    ...overrides,
  };
}

function makeAnthropicBody(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    model: 'gemini-2.5-flash',
    max_tokens: 1024,
    messages: [{ role: 'user', content: 'What is the time?' }],
    stream: false,
    ...overrides,
  });
}

function sendToProxy(
  proxyUrl: string,
  body: string,
  authToken: string,
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
        },
      },
      (res) => {
        let data = '';
        res.on('data', (chunk) => (data += chunk));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: data }));
      },
    );
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

function sendToProxyWithTurn(
  proxyUrl: string,
  body: string,
  authToken: string,
  turnId: string,
): Promise<{ status: number; body: string }> {
  let routedModel = '';
  try { routedModel = (JSON.parse(body) as { model?: string }).model ?? ''; } catch { /* leave empty */ }
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
          'X-Routed-Turn-Id': turnId,
          'X-Routed-Model': routedModel,
          Host: '127.0.0.1',
        },
      },
      (res) => {
        let data = '';
        res.on('data', (chunk) => (data += chunk));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: data }));
      },
    );
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

/**
 * Create a mock upstream HTTP server that delays its response.
 * Used to simulate a slow/stalled model API.
 */
function createDelayedUpstream(delayMs: number, options?: {
  /** If true, send headers immediately but delay the body (simulates streaming stall) */
  sendHeadersImmediately?: boolean;
  /** If true, respond with SSE streaming format */
  streaming?: boolean;
}): Promise<{ server: http.Server; port: number; url: string }> {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      // Collect request body (required to prevent connection reset)
      let _body = '';
      req.on('data', (chunk) => { _body += chunk; });
      req.on('end', () => {
        if (options?.sendHeadersImmediately) {
          // Send headers immediately, delay body (simulates model that accepts connection but stalls)
          if (options.streaming) {
            res.writeHead(200, {
              'Content-Type': 'text/event-stream',
              'Cache-Control': 'no-cache',
              'Connection': 'keep-alive',
            });
          } else {
            res.writeHead(200, { 'Content-Type': 'application/json' });
          }
          // Body never arrives within the test window
          setTimeout(() => {
            if (options.streaming) {
              res.write('data: {"id":"chatcmpl-test","object":"chat.completion.chunk","created":1,"model":"gemini-2.5-flash","choices":[{"index":0,"delta":{"role":"assistant","content":"Hello"},"finish_reason":null}]}\n\n');
              res.write('data: [DONE]\n\n');
            } else {
              res.end(JSON.stringify({
                id: 'chatcmpl-test',
                object: 'chat.completion',
                model: 'gemini-2.5-flash',
                choices: [{ index: 0, message: { role: 'assistant', content: 'Hello' }, finish_reason: 'stop' }],
                usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
              }));
            }
            res.end();
          }, delayMs);
        } else {
          // Delay everything (headers + body) — simulates completely unresponsive API
          setTimeout(() => {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
              id: 'chatcmpl-test',
              object: 'chat.completion',
              model: 'gemini-2.5-flash',
              choices: [{ index: 0, message: { role: 'assistant', content: 'Hello' }, finish_reason: 'stop' }],
              usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
            }));
          }, delayMs);
        }
      });
    });

    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as { port: number };
      resolve({
        server,
        port: addr.port,
        url: `http://127.0.0.1:${addr.port}`,
      });
    });
  });
}

// ── Tests ──────────────────────────────────────────────────────────

let testPort = 19900;

describe('FOX-2656: proxy upstream timeout (TDD — should fail before fix)', () => {
  beforeEach(() => {
    _setUpstreamTimeoutsScaleForTesting(TIMEOUT_SCALE);
  });

  afterEach(async () => {
    _resetUpstreamTimeoutsScaleForTesting();
    proxyManager.clearBaseProfile();
    await proxyManager.stop();
    testPort += 10;
  });

  describe('non-streaming: slow upstream should be aborted promptly', () => {
    it('should abort a non-streaming request within 3s when upstream does not respond', async () => {
      // Create a mock upstream that delays beyond the scaled 1s first-byte timeout.
      const upstream = await createDelayedUpstream(2_000);

      try {
        const profile = makeProfile({
          id: 'gemini-flash',
          name: 'Gemini 2.5 Flash',
          serverUrl: upstream.url,
        });

        const proxyUrl = await proxyManager.startSingleProfile(profile, testPort);
        const token = proxyManager.getAuthToken()!;
        const body = makeAnthropicBody();

        const start = Date.now();
        const result = await sendToProxy(proxyUrl, body, token);
        const elapsed = Date.now() - start;

        // The proxy should abort and return an error within ~3s (1s scaled timeout + margin)
        expect(elapsed).toBeLessThan(3_000);
        // Should get a 500 error, not a 200 success
        expect(result.status).toBe(500);
      } finally {
        upstream.server.close();
      }
    }, 5_000);
  });

  describe('streaming: first-byte timeout should abort promptly', () => {
    it('should abort a streaming request within 3s when upstream does not send headers', async () => {
      // Create a mock upstream that delays everything beyond the scaled 1s first-byte timeout.
      const upstream = await createDelayedUpstream(2_000);

      try {
        const profile = makeProfile({
          id: 'gemini-flash',
          name: 'Gemini 2.5 Flash',
          serverUrl: upstream.url,
        });

        const proxyUrl = await proxyManager.startSingleProfile(profile, testPort);
        const token = proxyManager.getAuthToken()!;
        // stream: true triggers the streaming path
        const body = makeAnthropicBody({ stream: true });

        const start = Date.now();
        const result = await sendToProxy(proxyUrl, body, token);
        const elapsed = Date.now() - start;

        // The proxy should abort within ~3s (1s scaled first-byte timeout + margin)
        expect(elapsed).toBeLessThan(3_000);
        expect(result.status).toBeGreaterThanOrEqual(400);
      } finally {
        upstream.server.close();
      }
    }, 5_000);
  });

  describe('streaming: first-chunk timeout should abort promptly after headers', () => {
    it('should abort within 4.5s when upstream sends headers but no data chunks', async () => {
      // Create a mock upstream that sends headers immediately but delays body beyond the scaled 1.5s first-chunk timeout.
      // This simulates a model that accepts the connection but stalls on first token
      const upstream = await createDelayedUpstream(2_500, {
        sendHeadersImmediately: true,
        streaming: true,
      });

      try {
        const profile = makeProfile({
          id: 'gemini-flash',
          name: 'Gemini 2.5 Flash',
          serverUrl: upstream.url,
        });

        const proxyUrl = await proxyManager.startSingleProfile(profile, testPort);
        const token = proxyManager.getAuthToken()!;
        const body = makeAnthropicBody({ stream: true });

        const start = Date.now();
        const _result = await sendToProxy(proxyUrl, body, token);
        const elapsed = Date.now() - start;

        // The proxy should abort within ~4.5s (1.5s scaled first-chunk timeout + margin)
        expect(elapsed).toBeLessThan(4_500);
      } finally {
        upstream.server.close();
      }
    }, 6_000);
  });

  describe('fast upstream should still work normally', () => {
    it('should complete successfully when upstream responds quickly (control test — should always pass)', async () => {
      // Create a mock upstream that responds in 100ms
      const upstream = await createDelayedUpstream(100);

      try {
        const profile = makeProfile({
          id: 'gemini-flash',
          name: 'Gemini 2.5 Flash',
          serverUrl: upstream.url,
        });

        const proxyUrl = await proxyManager.startSingleProfile(profile, testPort);
        const token = proxyManager.getAuthToken()!;
        const body = makeAnthropicBody();

        const start = Date.now();
        const result = await sendToProxy(proxyUrl, body, token);
        const elapsed = Date.now() - start;

        // Fast upstream: should complete well within timeout
        expect(elapsed).toBeLessThan(5_000);
        expect(result.status).toBe(200);

        const parsed = JSON.parse(result.body);
        expect(parsed.content).toBeDefined();
      } finally {
        upstream.server.close();
      }
    }, 10_000);
  });

  describe('reasoning model: extended first-byte timeout', () => {
    // Reasoning-effort verification: under TIMEOUT_SCALE = 1/30, the default tier's
    // firstByteMs is 1000 ms and high tier's firstByteMs is 5000 ms. We pick a
    // 1500 ms upstream delay so the test FAILS (times out at 1000 ms) without
    // reasoningEffort='high' and SUCCEEDS (well under 5000 ms) with it. This proves
    // the high-tier extension actually applies — see Reviewer Iteration Log in
    // docs/plans/260428_proxy_upstream_timeout_test_speedup.md.
    it('should succeed with 1.5s delay when reasoningEffort is high (would fail with base timeout)', async () => {
      const upstream = await createDelayedUpstream(1_500);

      try {
        const profile = makeProfile({
          id: 'gpt-5-2-thinking',
          name: 'GPT-5.2 Thinking',
          model: 'gpt-5.2',
          serverUrl: upstream.url,
          reasoningEffort: 'high',
        });

        const proxyUrl = await proxyManager.startSingleProfile(profile, testPort);
        const token = proxyManager.getAuthToken()!;
        const body = makeAnthropicBody({ model: 'gpt-5.2' });

        const start = Date.now();
        const result = await sendToProxy(proxyUrl, body, token);
        const elapsed = Date.now() - start;

        // Should succeed because 1.5s is within the scaled 5s timeout for 'high' reasoning.
        expect(result.status).toBe(200);
        expect(elapsed).toBeGreaterThan(1_000); // Confirm it actually waited past the scaled default timeout.
        expect(elapsed).toBeLessThan(4_000); // But not too long.
      } finally {
        upstream.server.close();
      }
    }, 6_000);
  });
});

describe('getUpstreamTimeouts', () => {
  it('returns base timeouts when no reasoning effort is set', () => {
    const result = getUpstreamTimeouts(undefined);
    expect(result.firstByteMs).toBe(30_000);
    expect(result.firstChunkMs).toBe(45_000);
  });

  it('scales timeouts for low reasoning effort', () => {
    const result = getUpstreamTimeouts('low');
    expect(result.firstByteMs).toBe(45_000);
    expect(result.firstChunkMs).toBe(60_000);
  });

  it('scales timeouts for medium reasoning effort', () => {
    const result = getUpstreamTimeouts('medium');
    expect(result.firstByteMs).toBe(90_000);
    expect(result.firstChunkMs).toBe(120_000);
  });

  it('scales timeouts for high reasoning effort', () => {
    const result = getUpstreamTimeouts('high');
    expect(result.firstByteMs).toBe(150_000);
    expect(result.firstChunkMs).toBe(200_000);
  });

  it('scales timeouts for xhigh reasoning effort', () => {
    const result = getUpstreamTimeouts('xhigh');
    expect(result.firstByteMs).toBe(240_000);
    expect(result.firstChunkMs).toBe(300_000);
  });
});

describe('circuit breaker: consecutive timeouts trip fast-fail', () => {
  beforeEach(() => {
    _setUpstreamTimeoutsScaleForTesting(TIMEOUT_SCALE);
  });

  afterEach(async () => {
    _resetUpstreamTimeoutsScaleForTesting();
    proxyManager.clearBaseProfile();
    await proxyManager.stop();
    testPort += 10;
  });

  it('should return 503 immediately after 3 consecutive timeouts for the same turn', async () => {
    const upstream = await createDelayedUpstream(2_000);

    try {
      const profile = makeProfile({
        id: 'slow-model',
        name: 'Slow Model',
        serverUrl: upstream.url,
      });
      const routeModel = profile.model ?? 'gemini-2.5-flash';

      const turnId = 'test-turn-cb';
      await proxyManager.addRoutes(turnId, {
        routes: new Map([[routeModel, profile]]),
      });

      const proxyUrl = proxyManager.getUrl()!;
      const token = proxyManager.getAuthToken()!;

      const sendWithTurn = () => sendToProxyWithTurn(
        proxyUrl,
        makeAnthropicBody({ stream: true, model: routeModel }),
        token,
        turnId,
      );

      for (let i = 0; i < 3; i++) {
        const result = await sendWithTurn();
        expect(result.status).toBeGreaterThanOrEqual(400);
      }

      const start = Date.now();
      const result = await sendWithTurn();
      const elapsed = Date.now() - start;

      expect(elapsed).toBeLessThan(1_000);
      expect(result.status).toBe(503);

      const body = JSON.parse(result.body);
      expect(body.error.message).toContain('3 consecutive attempts');
    } finally {
      proxyManager.removeRoutes('test-turn-cb');
      upstream.server.close();
    }
  }, 15_000);

  it('should reset counter on successful response', async () => {
    const slowUpstream = await createDelayedUpstream(2_000);
    const fastUpstream = await createDelayedUpstream(100);

    try {
      const slowProfile = makeProfile({
        id: 'slow-for-reset',
        name: 'Slow',
        serverUrl: slowUpstream.url,
      });
      const slowRouteModel = slowProfile.model ?? 'gemini-2.5-flash';

      const fastProfile = makeProfile({
        id: 'fast-for-reset',
        name: 'Fast',
        serverUrl: fastUpstream.url,
      });
      const fastRouteModel = fastProfile.model ?? 'gemini-2.5-flash';

      const turnId1 = 'test-turn-reset-1';
      const turnId2 = 'test-turn-reset-2';

      await proxyManager.addRoutes(turnId1, {
        routes: new Map([[slowRouteModel, slowProfile]]),
      });

      await proxyManager.addRoutes(turnId2, {
        routes: new Map([[fastRouteModel, fastProfile]]),
      });

      const proxyUrl = proxyManager.getUrl()!;
      const token = proxyManager.getAuthToken()!;
      const body = makeAnthropicBody({ stream: true, model: slowRouteModel });

      for (let i = 0; i < 2; i++) {
        await sendToProxyWithTurn(proxyUrl, body, token, turnId1).catch(() => {
          // Expected: slow upstream may cause ECONNRESET when proxy times out
        });
      }

      const result = await sendToProxyWithTurn(proxyUrl, body, token, turnId2);
      expect(result.status).toBe(200);
    } finally {
      proxyManager.removeRoutes('test-turn-reset-1');
      proxyManager.removeRoutes('test-turn-reset-2');
      slowUpstream.server.close();
      fastUpstream.server.close();
    }
  }, 15_000);
});

// ── Reasoning content forwarding ───────────────────────────────────

/**
 * Create a mock upstream that returns reasoning_content in its response.
 * Tests that the proxy translates OpenAI reasoning_content into Anthropic thinking blocks.
 */
function createReasoningUpstream(options: {
  reasoning: string;
  content: string;
  streaming?: boolean;
}): Promise<{ server: http.Server; port: number; url: string }> {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (chunk) => { body += chunk; });
      req.on('end', () => {
        const parsed = JSON.parse(body);

        if (parsed.stream) {
          res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive',
          });
          // Reasoning chunks first
          res.write(`data: ${JSON.stringify({
            id: 'chatcmpl-reason',
            object: 'chat.completion.chunk',
            created: 1,
            model: 'o3',
            choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }],
          })}\n\n`);
          res.write(`data: ${JSON.stringify({
            id: 'chatcmpl-reason',
            object: 'chat.completion.chunk',
            created: 1,
            model: 'o3',
            choices: [{ index: 0, delta: { reasoning_content: options.reasoning }, finish_reason: null }],
          })}\n\n`);
          // Then regular content
          res.write(`data: ${JSON.stringify({
            id: 'chatcmpl-reason',
            object: 'chat.completion.chunk',
            created: 1,
            model: 'o3',
            choices: [{ index: 0, delta: { content: options.content }, finish_reason: null }],
          })}\n\n`);
          res.write(`data: ${JSON.stringify({
            id: 'chatcmpl-reason',
            object: 'chat.completion.chunk',
            created: 1,
            model: 'o3',
            choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
            usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
          })}\n\n`);
          res.write('data: [DONE]\n\n');
          res.end();
        } else {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            id: 'chatcmpl-reason',
            object: 'chat.completion',
            model: 'o3',
            choices: [{
              index: 0,
              message: {
                role: 'assistant',
                reasoning_content: options.reasoning,
                content: options.content,
              },
              finish_reason: 'stop',
            }],
            usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
          }));
        }
      });
    });

    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as { port: number };
      resolve({ server, port: addr.port, url: `http://127.0.0.1:${addr.port}` });
    });
  });
}

describe('reasoning_content → thinking block translation', () => {
  afterEach(async () => {
    proxyManager.clearBaseProfile();
    await proxyManager.stop();
    testPort += 10;
  });

  it('non-streaming: translates reasoning_content into a thinking content block', async () => {
    const upstream = await createReasoningUpstream({
      reasoning: 'Let me think about this step by step...',
      content: 'The answer is 42.',
    });

    try {
      const profile = makeProfile({
        id: 'o3-test',
        name: 'o3',
        model: 'o3',
        serverUrl: upstream.url,
      });

      const proxyUrl = await proxyManager.startSingleProfile(profile, testPort);
      const token = proxyManager.getAuthToken()!;
      const body = makeAnthropicBody({ model: 'o3', stream: false });

      const result = await sendToProxy(proxyUrl, body, token);
      expect(result.status).toBe(200);

      const parsed = JSON.parse(result.body);
      expect(parsed.content).toHaveLength(2);
      expect(parsed.content[0]).toMatchObject({
        type: 'thinking',
        thinking: 'Let me think about this step by step...',
      });
      expect(parsed.content[1]).toMatchObject({
        type: 'text',
        text: 'The answer is 42.',
      });
    } finally {
      upstream.server.close();
    }
  }, 10_000);

  it('streaming: translates reasoning_content deltas into thinking block events', async () => {
    const upstream = await createReasoningUpstream({
      reasoning: 'Step 1: analyze the question',
      content: 'Here is my answer.',
      streaming: true,
    });

    try {
      const profile = makeProfile({
        id: 'o3-test',
        name: 'o3',
        model: 'o3',
        serverUrl: upstream.url,
      });

      const proxyUrl = await proxyManager.startSingleProfile(profile, testPort);
      const token = proxyManager.getAuthToken()!;
      const body = makeAnthropicBody({ model: 'o3', stream: true });

      const result = await sendToProxy(proxyUrl, body, token);

      // Parse SSE events from the streaming response
      const events = result.body
        .split('\n\n')
        .filter((line) => line.startsWith('event:'))
        .map((block) => {
          const eventLine = block.split('\n').find((l) => l.startsWith('event:'));
          const dataLine = block.split('\n').find((l) => l.startsWith('data:'));
          return {
            event: eventLine?.replace('event: ', ''),
            data: dataLine ? JSON.parse(dataLine.replace('data: ', '')) : null,
          };
        });

      // Find thinking block events
      const thinkingStart = events.find(
        (e) => e.event === 'content_block_start' && e.data?.content_block?.type === 'thinking'
      );
      const thinkingDelta = events.find(
        (e) => e.event === 'content_block_delta' && e.data?.delta?.type === 'thinking_delta'
      );
      const textStart = events.find(
        (e) => e.event === 'content_block_start' && e.data?.content_block?.type === 'text'
      );
      const textDelta = events.find(
        (e) => e.event === 'content_block_delta' && e.data?.delta?.type === 'text_delta'
      );

      expect(thinkingStart).toBeDefined();
      expect(thinkingDelta?.data.delta.thinking).toBe('Step 1: analyze the question');
      expect(textStart).toBeDefined();
      expect(textDelta?.data.delta.text).toBe('Here is my answer.');

      // Thinking block should come before text block
      const thinkingIdx = thinkingStart!.data.index;
      const textIdx = textStart!.data.index;
      expect(thinkingIdx).toBeLessThan(textIdx);
    } finally {
      upstream.server.close();
    }
  }, 10_000);

  it('streaming: assembles multiple reasoning_content deltas into a single thinking block', async () => {
    const upstream = await createCustomStreamingUpstream([
      { delta: { role: 'assistant' }, finish_reason: null },
      { delta: { reasoning_content: 'First, ' }, finish_reason: null },
      { delta: { reasoning_content: 'I need to ' }, finish_reason: null },
      { delta: { reasoning_content: 'think carefully.' }, finish_reason: null },
      { delta: { content: 'Done.' }, finish_reason: null },
      { delta: {}, finish_reason: 'stop' },
    ]);

    try {
      const profile = makeProfile({ id: 'o3-multi', name: 'o3', model: 'o3', serverUrl: upstream.url });
      const proxyUrl = await proxyManager.startSingleProfile(profile, testPort);
      const token = proxyManager.getAuthToken()!;

      const result = await sendToProxy(proxyUrl, makeAnthropicBody({ model: 'o3', stream: true }), token);
      const events = parseSSEEvents(result.body);

      const thinkingStarts = events.filter((e) => e.event === 'content_block_start' && e.data?.content_block?.type === 'thinking');
      const thinkingDeltas = events.filter((e) => e.event === 'content_block_delta' && e.data?.delta?.type === 'thinking_delta');

      // Only one thinking block opened despite three reasoning deltas
      expect(thinkingStarts).toHaveLength(1);
      expect(thinkingDeltas).toHaveLength(3);
      expect(thinkingDeltas.map((e) => e.data.delta.thinking).join('')).toBe('First, I need to think carefully.');
    } finally {
      upstream.server.close();
    }
  }, 10_000);

  it('streaming: empty string reasoning_content is skipped (no thinking block)', async () => {
    const upstream = await createCustomStreamingUpstream([
      { delta: { role: 'assistant' }, finish_reason: null },
      { delta: { reasoning_content: '' }, finish_reason: null },
      { delta: { content: 'Just the answer.' }, finish_reason: null },
      { delta: {}, finish_reason: 'stop' },
    ]);

    try {
      const profile = makeProfile({ id: 'o3-empty', name: 'o3', model: 'o3', serverUrl: upstream.url });
      const proxyUrl = await proxyManager.startSingleProfile(profile, testPort);
      const token = proxyManager.getAuthToken()!;

      const result = await sendToProxy(proxyUrl, makeAnthropicBody({ model: 'o3', stream: true }), token);
      const events = parseSSEEvents(result.body);

      const thinkingEvents = events.filter(
        (e) => e.data?.content_block?.type === 'thinking' || e.data?.delta?.type === 'thinking_delta'
      );
      expect(thinkingEvents).toHaveLength(0);

      const textDelta = events.find((e) => e.data?.delta?.type === 'text_delta');
      expect(textDelta?.data.delta.text).toBe('Just the answer.');
    } finally {
      upstream.server.close();
    }
  }, 10_000);

  it('non-streaming: reasoning-only response (no text content) produces only a thinking block', async () => {
    const upstream = await createCustomNonStreamingUpstream({
      reasoning_content: 'Deep analysis of the problem...',
      content: null,
    });

    try {
      const profile = makeProfile({ id: 'o3-reason-only', name: 'o3', model: 'o3', serverUrl: upstream.url });
      const proxyUrl = await proxyManager.startSingleProfile(profile, testPort);
      const token = proxyManager.getAuthToken()!;

      const result = await sendToProxy(proxyUrl, makeAnthropicBody({ model: 'o3', stream: false }), token);
      expect(result.status).toBe(200);

      const parsed = JSON.parse(result.body);
      expect(parsed.content).toHaveLength(1);
      expect(parsed.content[0]).toMatchObject({
        type: 'thinking',
        thinking: 'Deep analysis of the problem...',
      });
    } finally {
      upstream.server.close();
    }
  }, 10_000);
});

// ── Edge case test helpers ─────────────────────────────────────────

function createCustomStreamingUpstream(
  chunks: Array<{ delta: Record<string, unknown>; finish_reason: string | null }>,
): Promise<{ server: http.Server; port: number; url: string }> {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      let _body = '';
      req.on('data', (c) => { _body += c; });
      req.on('end', () => {
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
        for (const chunk of chunks) {
          res.write(`data: ${JSON.stringify({
            id: 'chatcmpl-edge', object: 'chat.completion.chunk', created: 1, model: 'o3',
            choices: [{ index: 0, ...chunk }],
            ...(chunk.finish_reason ? { usage: { prompt_tokens: 5, completion_tokens: 10, total_tokens: 15 } } : {}),
          })}\n\n`);
        }
        res.write('data: [DONE]\n\n');
        res.end();
      });
    });
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as { port: number };
      resolve({ server, port: addr.port, url: `http://127.0.0.1:${addr.port}` });
    });
  });
}

function createCustomNonStreamingUpstream(
  message: { reasoning_content?: string | null; content: string | null },
): Promise<{ server: http.Server; port: number; url: string }> {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      let _body = '';
      req.on('data', (c) => { _body += c; });
      req.on('end', () => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          id: 'chatcmpl-edge', object: 'chat.completion', model: 'o3',
          choices: [{ index: 0, message: { role: 'assistant', ...message }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 5, completion_tokens: 10, total_tokens: 15 },
        }));
      });
    });
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as { port: number };
      resolve({ server, port: addr.port, url: `http://127.0.0.1:${addr.port}` });
    });
  });
}

function parseSSEEvents(body: string): Array<{ event: string; data: any }> {
  return body
    .split('\n\n')
    .filter((block) => block.startsWith('event:'))
    .map((block) => {
      const eventLine = block.split('\n').find((l) => l.startsWith('event:'));
      const dataLine = block.split('\n').find((l) => l.startsWith('data:'));
      return {
        event: eventLine?.replace('event: ', '') ?? '',
        data: dataLine ? JSON.parse(dataLine.replace('data: ', '')) : null,
      };
    });
}
