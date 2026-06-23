/**
 * Proxy Upstream Activity Marking Tests
 *
 * Verifies that Responses API streaming paths in the proxy mark upstream
 * activity via agentTurnRegistry.markUpstreamActivity() for EVERY parsed
 * SSE event — including events the translator drops (returns null).
 *
 * This is the core defense against false watchdog aborts during GPT-5.5
 * reasoning phases: the model sends reasoning SSE events that the translator
 * correctly drops, but the watchdog must know the upstream is still alive.
 *
 * Invariant: "No translated output ≠ no upstream activity."
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import http from 'node:http';
import type { ModelProfile } from '@shared/types';

// Mock settingsStore — profile needs a resolved API key to trigger Responses API path
vi.mock('@core/services/settingsStore', () => ({
  setSettingsStoreAdapter: vi.fn(),
  getSettings: () => ({
    providerKeys: { openai: 'test-key-for-responses-api' },
  }),
}));

// Spy on agentTurnRegistry.markUpstreamActivity
const mockMarkUpstreamActivity = vi.fn();
vi.mock('../agentTurnRegistry', () => ({
  agentTurnRegistry: {
    markUpstreamActivity: (...args: unknown[]) => mockMarkUpstreamActivity(...args),
  },
}));

import { proxyManager } from '../localModelProxyServer';

// ── Helpers ────────────────────────────────────────────────────────

function makeProfile(overrides: Partial<ModelProfile> & { id: string; name: string }): ModelProfile {
  return {
    serverUrl: 'http://127.0.0.1:0',
    createdAt: Date.now(),
    model: 'gpt-5.5',
    providerType: 'openai',
    reasoningEffort: 'high',
    ...overrides,
  };
}

/**
 * Create a mock upstream that serves Responses API SSE events.
 * Sends a mix of events: some the translator handles and some it drops.
 * The path is /v1/responses (what buildResponsesUrl generates).
 */
function createResponsesApiUpstream(events: Array<{ event: string; data: Record<string, unknown> }>): Promise<{
  server: http.Server;
  port: number;
  url: string;
  receivedRequests: Array<{ url: string; body: string }>;
}> {
  const receivedRequests: Array<{ url: string; body: string }> = [];

  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (chunk) => { body += chunk; });
      req.on('end', () => {
        receivedRequests.push({ url: req.url ?? '', body });

        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          'Connection': 'keep-alive',
        });

        // Send all SSE events
        for (const evt of events) {
          res.write(`event: ${evt.event}\ndata: ${JSON.stringify(evt.data)}\n\n`);
        }

        res.end();
      });
    });

    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as { port: number };
      resolve({
        server,
        port: addr.port,
        url: `http://127.0.0.1:${addr.port}`,
        receivedRequests,
      });
    });
  });
}

function sendToProxyStreaming(
  proxyUrl: string,
  body: string,
  authToken: string,
  turnId: string,
  routedModel: string,
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

// ── Tests ──────────────────────────────────────────────────────────

describe('proxy upstream activity marking (Responses API streaming)', () => {
  afterEach(async () => {
    mockMarkUpstreamActivity.mockClear();
    proxyManager.clearBaseProfile();
    await proxyManager.stop();
    // Brief delay to let the port fully release between tests
    await new Promise(r => setTimeout(r, 50));
  });

  it('marks upstream activity for every parsed SSE event, including those the translator drops', async () => {
    // Mix of events: response.created (translated) and response.reasoning.delta (dropped)
    const sseEvents = [
      // response.created — translator handles this
      {
        event: 'response.created',
        data: {
          type: 'response.created',
          response: {
            id: 'resp_001',
            status: 'in_progress',
            model: 'gpt-5.5',
            output: [],
            usage: null,
          },
        },
      },
      // response.reasoning.delta — translator drops this (returns null)
      {
        event: 'response.reasoning.delta',
        data: {
          type: 'response.reasoning.delta',
          content_index: 0,
          delta: 'thinking about the problem...',
        },
      },
      // Another reasoning event — also dropped
      {
        event: 'response.reasoning.delta',
        data: {
          type: 'response.reasoning.delta',
          content_index: 0,
          delta: 'considering the constraints...',
        },
      },
      // response.output_item.added — translator handles this
      {
        event: 'response.output_item.added',
        data: {
          type: 'response.output_item.added',
          output_index: 0,
          item: { type: 'message', role: 'assistant', content: [] },
        },
      },
      // response.content_part.added — translator handles
      {
        event: 'response.content_part.added',
        data: {
          type: 'response.content_part.added',
          output_index: 0,
          content_index: 0,
          part: { type: 'output_text', text: '' },
        },
      },
      // response.output_text.delta — translator handles
      {
        event: 'response.output_text.delta',
        data: {
          type: 'response.output_text.delta',
          output_index: 0,
          content_index: 0,
          delta: 'Hello!',
        },
      },
      // response.completed — translator handles
      {
        event: 'response.completed',
        data: {
          type: 'response.completed',
          response: {
            id: 'resp_001',
            status: 'completed',
            model: 'gpt-5.5',
            output: [
              {
                type: 'message',
                role: 'assistant',
                content: [{ type: 'output_text', text: 'Hello!' }],
              },
            ],
            usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
          },
        },
      },
    ];

    const upstream = await createResponsesApiUpstream(sseEvents);
    const turnId = 'test-turn-upstream-activity';

    try {
      const profile = makeProfile({
        id: 'gpt55-reasoning',
        name: 'GPT-5.5 Reasoning',
        model: 'gpt-5.5',
        serverUrl: upstream.url,
        providerType: 'openai',
        reasoningEffort: 'high',
        apiKey: 'test-key',
      });

      await proxyManager.addRoutes(turnId, {
        routes: new Map([['gpt-5.5', profile]]),
      });

      const proxyUrl = proxyManager.getUrl()!;
      const token = proxyManager.getAuthToken()!;

      // Request with tools + reasoning_effort triggers the Responses API path
      const body = JSON.stringify({
        model: 'gpt-5.5',
        max_tokens: 1024,
        messages: [{ role: 'user', content: 'Hello' }],
        tools: [{ name: 'test_tool', description: 'A test tool', input_schema: { type: 'object' } }],
        stream: true,
      });

      await sendToProxyStreaming(proxyUrl, body, token, turnId, 'gpt-5.5');

      // markUpstreamActivity should have been called for EVERY parsed SSE event (7 total)
      // This includes the 2 reasoning events that the translator drops
      expect(mockMarkUpstreamActivity).toHaveBeenCalledWith(turnId);
      expect(mockMarkUpstreamActivity.mock.calls.length).toBe(sseEvents.length);
    } finally {
      proxyManager.removeRoutes(turnId);
      upstream.server.close();
    }
  }, 15_000);

  it('marks upstream activity only with the provided turnId, not for other turns', async () => {
    // Verify that upstream activity is attributed to the correct turnId
    const sseEvents = [
      {
        event: 'response.created',
        data: {
          type: 'response.created',
          response: {
            id: 'resp_002',
            status: 'in_progress',
            model: 'gpt-5.5',
            output: [],
            usage: null,
          },
        },
      },
      {
        event: 'response.completed',
        data: {
          type: 'response.completed',
          response: {
            id: 'resp_002',
            status: 'completed',
            model: 'gpt-5.5',
            output: [
              {
                type: 'message',
                role: 'assistant',
                content: [{ type: 'output_text', text: 'Hi' }],
              },
            ],
            usage: { input_tokens: 5, output_tokens: 2, total_tokens: 7 },
          },
        },
      },
    ];

    const upstream = await createResponsesApiUpstream(sseEvents);
    const turnId = 'test-turn-specific-id';

    try {
      const profile = makeProfile({
        id: 'gpt55-specific-turn',
        name: 'GPT-5.5 Specific Turn',
        model: 'gpt-5.5',
        serverUrl: upstream.url,
        providerType: 'openai',
        reasoningEffort: 'high',
        apiKey: 'test-key',
      });

      await proxyManager.addRoutes(turnId, {
        routes: new Map([['gpt-5.5', profile]]),
      });

      const proxyUrl = proxyManager.getUrl()!;
      const token = proxyManager.getAuthToken()!;

      const body = JSON.stringify({
        model: 'gpt-5.5',
        max_tokens: 1024,
        messages: [{ role: 'user', content: 'Hello' }],
        tools: [{ name: 'test_tool', description: 'A test tool', input_schema: { type: 'object' } }],
        stream: true,
      });

      await sendToProxyStreaming(proxyUrl, body, token, turnId, 'gpt-5.5');

      // All calls should use the correct turnId
      expect(mockMarkUpstreamActivity).toHaveBeenCalledWith(turnId);
      for (const call of mockMarkUpstreamActivity.mock.calls) {
        expect(call[0]).toBe(turnId);
      }
      // Should have been called once per SSE event
      expect(mockMarkUpstreamActivity.mock.calls.length).toBe(sseEvents.length);
    } finally {
      proxyManager.removeRoutes(turnId);
      upstream.server.close();
    }
  }, 15_000);
});
