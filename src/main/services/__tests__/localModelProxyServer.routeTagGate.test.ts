/**
 * WS1b-2 proxy integrity-gate ingress contract tests.
 *
 * The executor emits three headers (`x-route-tag` digest, `x-route-id` anchor,
 * `x-route-wire-model` plaintext witness) on every proxy-dispatch request. The
 * proxy's gate (`applyRouteTagGate`, run at the top of `handleMessagesRequest`)
 * fail-closes ONLY on model-mismatch and emits telemetry-only on scheme anomalies.
 *
 * These tests pin that asymmetry per ingress class:
 *  - tag present + valid + matching wire model → request PROCEEDS (200, upstream hit).
 *  - body.model ≠ x-route-wire-model         → FAIL-CLOSED (409, NO upstream hit).
 *  - absent / malformed tag                  → request PROCEEDS + warn telemetry.
 *  - turnOpenRouterFallback turn             → NO scheme-anomaly warning.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import http from 'node:http';

const logWarnMock = vi.hoisted(() => vi.fn());
const logErrorMock = vi.hoisted(() => vi.fn());

const mockSettings: {
  models?: { apiKey?: string };
  providerKeys?: Record<string, string>;
  activeProvider?: string;
  openRouter?: { oauthToken?: string };
} = {
  models: { apiKey: 'fake-test-anthropic-key' },
  providerKeys: {},
};

vi.mock('@core/logger', () => ({
  createScopedLogger: () => ({
    info: vi.fn(),
    debug: vi.fn(),
    warn: logWarnMock,
    error: logErrorMock,
  }),
}));

vi.mock('@core/services/settingsStore', () => ({
  setSettingsStoreAdapter: vi.fn(),
  getSettings: () => mockSettings,
}));

vi.mock('@core/services/tokenStorage/openRouterTokenStorage', () => ({
  loadOpenRouterTokens: vi.fn(() => ({ apiKey: 'fake-or-test-key', refreshToken: null })),
}));

import { proxyManager, type ModelRouteTable } from '../localModelProxyServer';
import {
  ROUTE_ID_HEADER,
  ROUTE_TAG_HEADER,
  ROUTE_WIRE_MODEL_HEADER,
} from '@core/rebelCore/providerRouteHeaders';
import { computeRouteTag, type RouteTagFacts } from '@core/rebelCore/providerRouteTag';

const ENV_BACKUP = process.env.ANTHROPIC_API_KEY;
const CLAUDE_MODEL = 'claude-sonnet-4-5';

function factsFor(overrides: Partial<RouteTagFacts> = {}): RouteTagFacts {
  return {
    routeId: 'turn-gate',
    provider: 'anthropic',
    transport: 'anthropic-compatible-local-proxy',
    wireModelId: CLAUDE_MODEL,
    credentialSource: 'anthropic-api-key',
    billingSource: 'pay-per-use',
    role: 'execution',
    profileId: null,
    ...overrides,
  };
}

function makeBody(model = CLAUDE_MODEL): string {
  return JSON.stringify({
    model,
    max_tokens: 1024,
    messages: [{ role: 'user', content: 'Hello' }],
    stream: false,
  });
}

function sendToProxy(
  proxyUrl: string,
  body: string,
  authToken: string,
  headers: Record<string, string> = {},
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const url = new URL(`${proxyUrl}/v1/messages`);
    const req = http.request(
      {
        hostname: url.hostname,
        port: url.port,
        path: url.pathname,
        method: 'POST',
        agent: false,
        headers: {
          'Content-Type': 'application/json',
          'X-Proxy-Auth': authToken,
          Host: '127.0.0.1',
          Connection: 'close',
          ...headers,
        },
      },
      (res) => {
        let data = '';
        res.on('data', (chunk: Buffer) => (data += chunk));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: data }));
      },
    );
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

function fakeAnthropicResponse(): Partial<Response> {
  return {
    ok: true,
    status: 200,
    headers: new Headers({ 'content-type': 'application/json' }),
    text: () =>
      Promise.resolve(
        JSON.stringify({
          id: 'msg_test',
          type: 'message',
          role: 'assistant',
          content: [{ type: 'text', text: 'pong' }],
          model: CLAUDE_MODEL,
          usage: { input_tokens: 1, output_tokens: 1 },
        }),
      ),
    body: null,
  };
}

let nextPort = 49850;
let fetchSpy: ReturnType<typeof vi.spyOn>;
let upstreamCalls: string[] = [];

function gateWarnCalls(): unknown[][] {
  return logWarnMock.mock.calls.filter(
    (call) => typeof call[1] === 'string' && call[1].includes('[ROUTE-TAG-GATE]'),
  );
}

beforeEach(() => {
  logWarnMock.mockReset();
  logErrorMock.mockReset();
  upstreamCalls = [];
  mockSettings.models = { apiKey: 'fake-test-anthropic-key' };
  mockSettings.providerKeys = {};
  mockSettings.activeProvider = 'openrouter';
  mockSettings.openRouter = { oauthToken: 'fake-or-oauth' };
  delete process.env.ANTHROPIC_API_KEY;
  process.env.ANTHROPIC_API_KEY = 'fake-test-anthropic-key';

  fetchSpy = vi.spyOn(global, 'fetch').mockImplementation(async (url) => {
    upstreamCalls.push(typeof url === 'string' ? url : url.toString());
    return fakeAnthropicResponse() as unknown as Response;
  });
});

afterEach(async () => {
  fetchSpy.mockRestore();
  await proxyManager.stop();
  if (ENV_BACKUP === undefined) delete process.env.ANTHROPIC_API_KEY;
  else process.env.ANTHROPIC_API_KEY = ENV_BACKUP;
});

describe('WS1b-2 proxy route-tag gate', () => {
  it('present + valid tag with matching wire model → request PROCEEDS (200, upstream hit)', async () => {
    const routeTable: ModelRouteTable = { routes: new Map() };
    await proxyManager.startMultiRoute(routeTable, nextPort++);
    const proxyUrl = proxyManager.getUrl()!;
    const token = proxyManager.getAuthToken()!;

    const tag = computeRouteTag(factsFor());
    const res = await sendToProxy(proxyUrl, makeBody(CLAUDE_MODEL), token, {
      [ROUTE_TAG_HEADER]: tag,
      [ROUTE_ID_HEADER]: 'turn-gate',
      [ROUTE_WIRE_MODEL_HEADER]: CLAUDE_MODEL,
    });

    expect(res.status).toBe(200);
    expect(upstreamCalls).toHaveLength(1);
    // A current, well-formed tag is no anomaly → no gate telemetry.
    expect(gateWarnCalls()).toHaveLength(0);
  });

  it('body.model ≠ x-route-wire-model → request PROCEEDS (200, upstream hit) + telemetry emitted (NEVER rejects)', async () => {
    const routeTable: ModelRouteTable = { routes: new Map() };
    await proxyManager.startMultiRoute(routeTable, nextPort++);
    const proxyUrl = proxyManager.getUrl()!;
    const token = proxyManager.getAuthToken()!;

    // The executor decided CLAUDE_MODEL, but the body carries a DIFFERENT model.
    // WS1b-2 is observability-only: legitimate cross-model divergences exist
    // (non-route-table subagent OR remaps), so the gate must NOT reject — it only
    // emits a distinguishable WARN model-mismatch telemetry signal.
    const tag = computeRouteTag(factsFor());
    const res = await sendToProxy(proxyUrl, makeBody('claude-opus-4-7'), token, {
      [ROUTE_TAG_HEADER]: tag,
      [ROUTE_ID_HEADER]: 'turn-gate',
      [ROUTE_WIRE_MODEL_HEADER]: CLAUDE_MODEL,
    });

    // PROCEEDS — request reaches the upstream, no rejection.
    expect(res.status).toBe(200);
    expect(upstreamCalls).toHaveLength(1);
    // Distinguishable model-mismatch WARN telemetry was emitted.
    const warns = gateWarnCalls();
    expect(warns.some((c) => typeof c[1] === 'string' && c[1].includes('model-mismatch'))).toBe(true);
    expect(logWarnMock).toHaveBeenCalledWith(
      expect.objectContaining({ inboundBodyModel: 'claude-opus-4-7', taggedWireModel: CLAUDE_MODEL }),
      expect.stringContaining('model-mismatch'),
    );
  });

  it('LEGITIMATE non-route-table subagent OR cross-model remap (body deepseek-chat-v3-0324 / wire deepseek-v3.2) → PROCEEDS, no rejection', async () => {
    // Pins the regression the coordinator review caught: agentTool intentionally
    // streams the RESOLVED model for non-route-table subagent OR delegations while
    // wireModelId carries the cross-model LEGACY_OR_MODEL_REMAP target. A
    // fail-closed gate would break this legitimate passthrough turn.
    const routeTable: ModelRouteTable = { routes: new Map() };
    await proxyManager.startMultiRoute(routeTable, nextPort++);
    const proxyUrl = proxyManager.getUrl()!;
    const token = proxyManager.getAuthToken()!;

    const bodyModel = 'deepseek/deepseek-chat-v3-0324';
    const wireModelId = 'deepseek/deepseek-v3.2';
    // Tag minted over the executor's facts (wireModelId = the remapped target).
    const tag = computeRouteTag(factsFor({ wireModelId }));
    const res = await sendToProxy(proxyUrl, makeBody(bodyModel), token, {
      [ROUTE_TAG_HEADER]: tag,
      [ROUTE_ID_HEADER]: 'turn-subagent-or',
      [ROUTE_WIRE_MODEL_HEADER]: wireModelId,
    });

    // The gate (which runs BEFORE route resolution) does NOT reject: there is no
    // 409 / ROUTE_TAG rejection. The request flows PAST the gate into normal route
    // resolution (which, for an unregistered deepseek model on an empty route
    // table, returns its own 400 — a separate concern from the gate).
    expect(res.status).not.toBe(409);
    expect(res.body).not.toContain('ROUTE_TAG');
    // It DOES emit the model-mismatch characterization signal (telemetry-only).
    expect(logWarnMock).toHaveBeenCalledWith(
      expect.objectContaining({ inboundBodyModel: bodyModel, taggedWireModel: wireModelId }),
      expect.stringContaining('model-mismatch'),
    );
  });

  it('absent tag → request PROCEEDS (200, upstream hit) + telemetry emitted', async () => {
    const routeTable: ModelRouteTable = { routes: new Map() };
    await proxyManager.startMultiRoute(routeTable, nextPort++);
    const proxyUrl = proxyManager.getUrl()!;
    const token = proxyManager.getAuthToken()!;

    // No route-tag headers at all (legacy / dropped-header path).
    const res = await sendToProxy(proxyUrl, makeBody(CLAUDE_MODEL), token);

    expect(res.status).toBe(200);
    expect(upstreamCalls).toHaveLength(1);
    const warns = gateWarnCalls();
    expect(warns).toHaveLength(1);
    expect(warns[0][0]).toMatchObject({ inspection: 'absent' });
  });

  it('malformed tag → request PROCEEDS (200) + telemetry emitted (not a rejection)', async () => {
    const routeTable: ModelRouteTable = { routes: new Map() };
    await proxyManager.startMultiRoute(routeTable, nextPort++);
    const proxyUrl = proxyManager.getUrl()!;
    const token = proxyManager.getAuthToken()!;

    const res = await sendToProxy(proxyUrl, makeBody(CLAUDE_MODEL), token, {
      [ROUTE_TAG_HEADER]: 'not-a-valid-tag',
      [ROUTE_ID_HEADER]: 'turn-gate',
      // No wire-model witness → model-mismatch path is not taken; only scheme telemetry.
    });

    expect(res.status).toBe(200);
    expect(upstreamCalls).toHaveLength(1);
    const warns = gateWarnCalls();
    expect(warns).toHaveLength(1);
    expect(warns[0][0]).toMatchObject({ inspection: 'malformed' });
  });

  it('turnOpenRouterFallback turn → NO scheme-anomaly warning even with an absent tag', async () => {
    // OR-fallback turn: the gate (which runs BEFORE route resolution) whitelists
    // the scheme telemetry for this turn. The eventual route-resolution status
    // (route-required 400 here, since no x-routed-model is sent) is a separate
    // concern from the gate — what we assert is that the gate did NOT warn.
    mockSettings.activeProvider = 'openrouter';
    const routeTable: ModelRouteTable = { routes: new Map() };
    await proxyManager.addRoutes('turn-or-fallback', routeTable, undefined, nextPort++, true);
    const proxyUrl = proxyManager.getUrl()!;
    const token = proxyManager.getAuthToken()!;

    await sendToProxy(proxyUrl, makeBody(CLAUDE_MODEL), token, {
      'x-routed-turn-id': 'turn-or-fallback',
      // No route-tag headers → would be an `absent` anomaly on a normal turn.
    });

    // Whitelisted: NO scheme-anomaly telemetry for an OR-fallback turn.
    expect(gateWarnCalls()).toHaveLength(0);
  });

  it('control: a NON-fallback turn with the same absent-tag request DOES warn (whitelist is the only difference)', async () => {
    const routeTable: ModelRouteTable = { routes: new Map() };
    // openRouterFallback = false → NOT whitelisted.
    await proxyManager.addRoutes('turn-normal', routeTable, undefined, nextPort++, false);
    const proxyUrl = proxyManager.getUrl()!;
    const token = proxyManager.getAuthToken()!;

    await sendToProxy(proxyUrl, makeBody(CLAUDE_MODEL), token, {
      'x-routed-turn-id': 'turn-normal',
    });

    const warns = gateWarnCalls();
    expect(warns).toHaveLength(1);
    expect(warns[0][0]).toMatchObject({ inspection: 'absent' });
  });
});
