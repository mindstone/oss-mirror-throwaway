/**
 * WS4b — proxy CONSUMES the signed route-facts carrier (`x-route-facts`).
 *
 * WS4a made the executor EMIT a signed, decodable facts carrier; WS4b has the
 * proxy VERIFY + DECODE it (`verifyRouteFacts` under the shared `x-proxy-auth`
 * secret) and TRUST the facts instead of independently re-deriving
 * `isManagedMode` / "is Anthropic passthrough". These tests pin the consumption
 * contract:
 *
 *  - facts present + valid → drive isManagedMode from `facts.credentialSource`
 *    (managed key vs personal key), even when it DISAGREES with `activeProvider`
 *    (proves the facts are consumed, not re-derived). When they AGREE, the result
 *    equals re-derivation (parity).
 *  - facts absent / invalid (bad-signature) → FALL BACK to re-derivation
 *    (`activeProvider === 'mindstone'`) — behaviour-preserving (WS4c, not WS4b,
 *    makes the gate fail-closed).
 *  - `turnOpenRouterFallback` runtime override → the override decides, NOT the
 *    carried facts: a managed-key carrier on an OR-fallback turn whose user is on
 *    personal OpenRouter still uses the PERSONAL key (facts are not consumed on
 *    the override path).
 *  - the managed allow-list still gates after isManagedMode is determined.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import http from 'node:http';
import type { ManagedProviderInfo } from '@shared/types/managedProvider';

const logWarnMock = vi.hoisted(() => vi.fn());
const logErrorMock = vi.hoisted(() => vi.fn());
const getCachedAuthConfigMock = vi.hoisted(() => vi.fn());
const loadManagedOpenRouterKeyMock = vi.hoisted(() => vi.fn<() => string | null>(() => 'fake-managed-key'));
const loadOpenRouterTokensMock = vi.hoisted(() =>
  vi.fn<() => { apiKey: string; refreshToken: string | null } | null>(() => ({
    apiKey: 'fake-personal-or-key',
    refreshToken: null,
  })),
);

// Mutable settings the tests flip to exercise re-derivation vs facts divergence.
const mockSettings: { activeProvider?: string; claude?: { apiKey?: string }; models?: { apiKey?: string }; providerKeys?: Record<string, string>; openRouter?: { oauthToken?: string } } = {
  activeProvider: 'openrouter',
  claude: { apiKey: 'fake-ant-key' },
  models: { apiKey: 'fake-ant-key' },
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

// `loadOpenRouterTokens` (personal key) and `loadManagedOpenRouterKey` (managed key)
// live in DIFFERENT modules — mock each in its real source so the proxy resolves
// the right one per isManagedMode.
vi.mock('@core/services/tokenStorage/openRouterTokenStorage', () => ({
  loadOpenRouterTokens: loadOpenRouterTokensMock,
}));

vi.mock('../openRouterTokenStorage', () => ({
  loadOpenRouterTokens: loadOpenRouterTokensMock,
  loadManagedOpenRouterKey: loadManagedOpenRouterKeyMock,
}));

vi.mock('@core/rebelAuth', () => ({
  getRebelAuthProvider: () => ({
    getAuthState: vi.fn(() => ({ isAuthenticated: false, user: null, isLoading: false })),
    onAuthStateChange: vi.fn(() => () => {}),
    getAccessToken: vi.fn(async () => null),
    invalidateAccessToken: vi.fn(),
    initializeAuth: vi.fn(async () => ({ isAuthenticated: false, user: null, isLoading: false })),
    setPostLoginCallback: vi.fn(),
    requestAuthConfigRefresh: vi.fn(async () => {}),
    refreshLicenseTier: vi.fn(async () => 'free'),
    clearCachedProviderKey: vi.fn(),
    getSharedDriveConfig: vi.fn(() => null),
    getSubscriptionState: vi.fn(() => null),
    getManagedAllowanceResetsAt: vi.fn(() => undefined),
    getCachedAuthConfig: getCachedAuthConfigMock,
  }),
  setRebelAuthProvider: vi.fn(),
  NULL_REBEL_AUTH_PROVIDER: {},
}));

import { proxyManager, type ModelRouteTable } from '../localModelProxyServer';
import { ROUTE_FACTS_HEADER, ROUTE_ID_HEADER, ROUTE_WIRE_MODEL_HEADER } from '@core/rebelCore/providerRouteHeaders';
import { signRouteFacts, type RouteTagFacts } from '@core/rebelCore/providerRouteTag';
import { billingSourceForCredentialSource } from '@core/rebelCore/providerBillingSource';
import type { ProviderCredentialSource } from '@shared/types/providerRoute';

const OR_MODEL = 'anthropic/claude-sonnet-4';
// The per-request route anchor the executor emits on every proxy path
// (`appendRouteTagHeaders` → x-route-id), from the SAME routeId it signs into the
// carrier. The proxy binds the carrier to the request by this anchor: a request
// that consumes facts MUST present x-route-id === facts.routeId, else the carrier is
// treated as stale/mis-threaded and re-derivation kicks in (billing-correctness).
const ROUTE_ANCHOR = 'turn-facts';

function factsFor(credentialSource: ProviderCredentialSource, overrides: Partial<RouteTagFacts> = {}): RouteTagFacts {
  return {
    routeId: ROUTE_ANCHOR,
    provider: 'openrouter',
    transport: 'openrouter-proxy',
    wireModelId: OR_MODEL,
    credentialSource,
    // Use the CANONICAL billing axis for the credential source so the carrier is
    // internally consistent (decodeFacts now rejects a billingSource that disagrees
    // with credentialSource, e.g. managed-key + pool). Managed → subscription;
    // personal OAuth → pool; BYOK → pay-per-use; etc.
    billingSource: billingSourceForCredentialSource(credentialSource),
    role: 'execution',
    profileId: null,
    ...overrides,
  };
}

/** Headers that bind a consumed carrier to its request: the carrier + its route anchor. */
function boundCarrierHeaders(carrier: string, routeId = ROUTE_ANCHOR): Record<string, string> {
  return { [ROUTE_FACTS_HEADER]: carrier, [ROUTE_ID_HEADER]: routeId };
}

function makeBody(model = OR_MODEL): string {
  return JSON.stringify({
    model,
    max_tokens: 1024,
    messages: [{ role: 'user', content: 'Hello' }],
    stream: false,
  });
}

function makeManagedProviderInfo(overrides: Partial<ManagedProviderInfo> = {}): ManagedProviderInfo {
  return {
    provider: 'openrouter',
    keyHash: 'fake-key-hash',
    allowedModels: [],
    defaultModels: { working: OR_MODEL, thinking: 'openai/gpt-5', bts: 'openai/gpt-4o-mini' },
    creditLimitMonthly: 0,
    creditUsedMonthly: 0,
    ...overrides,
  };
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

function fakeOpenRouterResponse(): Partial<Response> {
  const body = {
    id: 'msg_test',
    type: 'message',
    role: 'assistant',
    model: OR_MODEL,
    content: [{ type: 'text', text: 'pong' }],
    stop_reason: 'end_turn',
    usage: { input_tokens: 1, output_tokens: 1 },
  };
  return {
    ok: true,
    status: 200,
    headers: new Headers({ 'content-type': 'application/json' }),
    text: () => Promise.resolve(JSON.stringify(body)),
    json: () => Promise.resolve(body),
  };
}

let nextPort = 49870;
let fetchSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  logWarnMock.mockReset();
  logErrorMock.mockReset();
  getCachedAuthConfigMock.mockReset();
  getCachedAuthConfigMock.mockReturnValue({ managedProvider: makeManagedProviderInfo(), hasManagedKey: true });
  loadManagedOpenRouterKeyMock.mockReset();
  loadManagedOpenRouterKeyMock.mockReturnValue('fake-managed-key');
  loadOpenRouterTokensMock.mockReset();
  loadOpenRouterTokensMock.mockReturnValue({ apiKey: 'fake-personal-or-key', refreshToken: null });
  mockSettings.activeProvider = 'openrouter';
  fetchSpy = vi.spyOn(global, 'fetch').mockImplementation(async () => fakeOpenRouterResponse() as unknown as Response);
});

afterEach(async () => {
  fetchSpy.mockRestore();
  await proxyManager.stop();
});

function urlOf(url: unknown): string {
  return typeof url === 'string' ? url : String(url);
}

/** Read the Bearer token the proxy injected on its egress fetch to OpenRouter. */
function egressBearer(): string | undefined {
  const call = (fetchSpy.mock.calls as unknown[][]).find((c) => urlOf(c[0]).includes('openrouter.ai'));
  if (!call) return undefined;
  const init = call[1] as RequestInit | undefined;
  const headers = (init?.headers ?? {}) as Record<string, string>;
  const auth = headers.authorization ?? headers.Authorization;
  return auth?.replace(/^Bearer\s+/i, '');
}

function egressHitHost(host: string): boolean {
  return (fetchSpy.mock.calls as unknown[][]).some((c) => urlOf(c[0]).includes(host));
}

describe('WS4b proxy route-facts consumption (openrouter-turn)', () => {
  it('facts present+valid (managed) → uses MANAGED key even when activeProvider=openrouter (facts WIN over re-derivation)', async () => {
    // Re-derivation would say personal (activeProvider=openrouter); facts say managed.
    mockSettings.activeProvider = 'openrouter';
    const routeTable: ModelRouteTable = { routes: new Map() };
    await proxyManager.startMultiRoute(routeTable, nextPort++);
    const proxyUrl = proxyManager.getUrl()!;
    const token = proxyManager.getAuthToken()!;

    const carrier = signRouteFacts(factsFor('mindstone-managed-key'), token);
    const res = await sendToProxy(proxyUrl, makeBody(), token, {
      'x-openrouter-turn': 'true',
      ...boundCarrierHeaders(carrier),
    });

    expect(res.status).toBe(200);
    expect(loadManagedOpenRouterKeyMock).toHaveBeenCalled();
    expect(egressBearer()).toBe('fake-managed-key');
  });

  it('facts present+valid (personal) → uses PERSONAL key even when activeProvider=mindstone (facts WIN over re-derivation)', async () => {
    // Re-derivation would say managed (activeProvider=mindstone); facts say personal.
    mockSettings.activeProvider = 'mindstone';
    const routeTable: ModelRouteTable = { routes: new Map() };
    await proxyManager.startMultiRoute(routeTable, nextPort++);
    const proxyUrl = proxyManager.getUrl()!;
    const token = proxyManager.getAuthToken()!;

    const carrier = signRouteFacts(factsFor('openrouter-oauth-token'), token);
    const res = await sendToProxy(proxyUrl, makeBody(), token, {
      'x-openrouter-turn': 'true',
      ...boundCarrierHeaders(carrier),
    });

    expect(res.status).toBe(200);
    expect(loadManagedOpenRouterKeyMock).not.toHaveBeenCalled();
    expect(egressBearer()).toBe('fake-personal-or-key');
  });

  it('facts present+valid agreeing with settings → same decision as re-derivation (parity)', async () => {
    mockSettings.activeProvider = 'mindstone';
    const routeTable: ModelRouteTable = { routes: new Map() };
    await proxyManager.startMultiRoute(routeTable, nextPort++);
    const proxyUrl = proxyManager.getUrl()!;
    const token = proxyManager.getAuthToken()!;

    const carrier = signRouteFacts(factsFor('mindstone-managed-key'), token);
    const res = await sendToProxy(proxyUrl, makeBody(), token, {
      'x-openrouter-turn': 'true',
      ...boundCarrierHeaders(carrier),
    });

    expect(res.status).toBe(200);
    expect(egressBearer()).toBe('fake-managed-key');
  });

  it('facts ABSENT → falls back to re-derivation (activeProvider=mindstone → managed key)', async () => {
    mockSettings.activeProvider = 'mindstone';
    const routeTable: ModelRouteTable = { routes: new Map() };
    await proxyManager.startMultiRoute(routeTable, nextPort++);
    const proxyUrl = proxyManager.getUrl()!;
    const token = proxyManager.getAuthToken()!;

    // No x-route-facts header → re-derive.
    const res = await sendToProxy(proxyUrl, makeBody(), token, { 'x-openrouter-turn': 'true' });

    expect(res.status).toBe(200);
    expect(egressBearer()).toBe('fake-managed-key');
  });

  it('facts ABSENT → falls back to re-derivation (activeProvider=openrouter → personal key)', async () => {
    mockSettings.activeProvider = 'openrouter';
    const routeTable: ModelRouteTable = { routes: new Map() };
    await proxyManager.startMultiRoute(routeTable, nextPort++);
    const proxyUrl = proxyManager.getUrl()!;
    const token = proxyManager.getAuthToken()!;

    const res = await sendToProxy(proxyUrl, makeBody(), token, { 'x-openrouter-turn': 'true' });

    expect(res.status).toBe(200);
    expect(egressBearer()).toBe('fake-personal-or-key');
  });

  it('facts INVALID (bad signature, wrong key) → falls back to re-derivation + telemetry', async () => {
    mockSettings.activeProvider = 'mindstone';
    const routeTable: ModelRouteTable = { routes: new Map() };
    await proxyManager.startMultiRoute(routeTable, nextPort++);
    const proxyUrl = proxyManager.getUrl()!;
    const token = proxyManager.getAuthToken()!;

    // Sign the (personal) facts with the WRONG secret → MAC won't verify under the
    // proxy's real token → bad-signature → fall back to re-derivation (managed).
    // (x-route-id present so the only failure reason is the bad MAC, not binding.)
    const carrier = signRouteFacts(factsFor('openrouter-oauth-token'), 'a-different-secret');
    const res = await sendToProxy(proxyUrl, makeBody(), token, {
      'x-openrouter-turn': 'true',
      ...boundCarrierHeaders(carrier),
    });

    expect(res.status).toBe(200);
    // Re-derived managed (NOT the forged personal facts).
    expect(egressBearer()).toBe('fake-managed-key');
    // Verification failure surfaced as telemetry.
    expect(
      logWarnMock.mock.calls.some(
        ([payload, message]) =>
          typeof message === 'string'
          && message.includes('[ROUTE-FACTS]')
          && (payload as { reason?: unknown }).reason === 'bad-signature',
      ),
    ).toBe(true);
  });

  it('managed allow-list STILL enforced when isManagedMode comes from facts (model not allowed → 403)', async () => {
    // Facts say managed; the requested model is NOT in the managed allow-list.
    // NOTE (binding contract): the body model here (claude-opus-4) intentionally
    // DIFFERS from the carrier's wireModelId (OR_MODEL = claude-sonnet-4) — a model
    // divergence. Binding is by ROUTE-ID, not model: because x-route-id ===
    // facts.routeId the carrier is bound to THIS request and the managed facts are
    // consumed despite the model divergence (model mismatch is telemetry-only). The
    // managed allow-list then rejects the un-allowed model → 403. This is the
    // legitimate "bound carrier, diverging model" case (subagent/remap), NOT the
    // stale/mis-threaded carrier the route-id binding rejects.
    mockSettings.activeProvider = 'openrouter';
    getCachedAuthConfigMock.mockReturnValue({
      managedProvider: makeManagedProviderInfo({ defaultModels: { working: 'openai/gpt-5' } }),
      hasManagedKey: true,
    });
    const routeTable: ModelRouteTable = { routes: new Map() };
    await proxyManager.startMultiRoute(routeTable, nextPort++);
    const proxyUrl = proxyManager.getUrl()!;
    const token = proxyManager.getAuthToken()!;

    const carrier = signRouteFacts(factsFor('mindstone-managed-key'), token);
    const res = await sendToProxy(proxyUrl, makeBody('anthropic/claude-opus-4'), token, {
      'x-openrouter-turn': 'true',
      ...boundCarrierHeaders(carrier),
    });

    expect(res.status).toBe(403);
    expect(JSON.parse(res.body)).toMatchObject({
      error: { code: 'MANAGED_MODEL_NOT_ALLOWED', requested: 'anthropic/claude-opus-4' },
    });
    expect(egressBearer()).toBeUndefined();
  });
});

describe('WS4b proxy route-facts REQUEST BINDING (billing-correctness)', () => {
  // The bug this guards: verifyRouteFacts proves a carrier is AUTHENTIC (signed by
  // us this session) but NOT that it is FOR THIS request. A same-session carrier
  // signed for a managed route can be stale-threaded / mis-attached onto a DIFFERENT
  // (personal) request, flipping billing (personal request charged to managed, or
  // vice-versa). The proxy binds by the per-request anchor x-route-id (===
  // facts.routeId on a correctly-threaded carrier): on mismatch the carrier is NOT
  // consumed for billing, re-derivation kicks in (fail-safe), and binding telemetry
  // is emitted. Model divergence is NOT a binding failure (telemetry-only).

  it('managed carrier whose route-id binds to a DIFFERENT (personal) request → REJECTED, re-derives personal + binding telemetry', async () => {
    // User is on personal OpenRouter (re-derivation → personal). A managed-key carrier
    // signed for route "turn-managed" is presented on a request whose anchor is the
    // DIFFERENT personal route "turn-personal" → not bound → must NOT consume managed.
    mockSettings.activeProvider = 'openrouter';
    const routeTable: ModelRouteTable = { routes: new Map() };
    await proxyManager.startMultiRoute(routeTable, nextPort++);
    const proxyUrl = proxyManager.getUrl()!;
    const token = proxyManager.getAuthToken()!;

    const managedCarrier = signRouteFacts(
      factsFor('mindstone-managed-key', { routeId: 'turn-managed' }),
      token,
    );
    const res = await sendToProxy(proxyUrl, makeBody(), token, {
      'x-openrouter-turn': 'true',
      // The request's independent anchor is a DIFFERENT route than the carrier's.
      ...boundCarrierHeaders(managedCarrier, 'turn-personal'),
    });

    expect(res.status).toBe(200);
    // Billing fell back to re-derivation (personal), NOT the mis-threaded managed facts.
    expect(loadManagedOpenRouterKeyMock).not.toHaveBeenCalled();
    expect(egressBearer()).toBe('fake-personal-or-key');
    // The binding failure is observable.
    expect(
      logWarnMock.mock.calls.some(
        ([payload, message]) =>
          typeof message === 'string'
          && message.includes('[ROUTE-FACTS]')
          && message.includes('does not bind')
          && (payload as { factsRouteId?: unknown }).factsRouteId === 'turn-managed'
          && (payload as { requestRouteAnchor?: unknown }).requestRouteAnchor === 'turn-personal',
      ),
    ).toBe(true);
  });

  it('managed carrier with NO x-route-id anchor on the request → REJECTED, re-derives + binding telemetry', async () => {
    // A carrier present but no per-request anchor to bind it to → cannot prove it is
    // for this request → fail-safe re-derivation (the executor ALWAYS emits x-route-id
    // alongside the carrier, so a carrier-without-anchor is an anomaly).
    mockSettings.activeProvider = 'openrouter';
    const routeTable: ModelRouteTable = { routes: new Map() };
    await proxyManager.startMultiRoute(routeTable, nextPort++);
    const proxyUrl = proxyManager.getUrl()!;
    const token = proxyManager.getAuthToken()!;

    const managedCarrier = signRouteFacts(factsFor('mindstone-managed-key'), token);
    const res = await sendToProxy(proxyUrl, makeBody(), token, {
      'x-openrouter-turn': 'true',
      // Carrier present, but NO x-route-id anchor.
      [ROUTE_FACTS_HEADER]: managedCarrier,
    });

    expect(res.status).toBe(200);
    expect(loadManagedOpenRouterKeyMock).not.toHaveBeenCalled();
    expect(egressBearer()).toBe('fake-personal-or-key');
    expect(
      logWarnMock.mock.calls.some(
        ([payload, message]) =>
          typeof message === 'string'
          && message.includes('[ROUTE-FACTS]')
          && message.includes('does not bind')
          && (payload as { requestRouteAnchor?: unknown }).requestRouteAnchor === null,
      ),
    ).toBe(true);
  });

  it('LEGITIMATE divergence: carrier bound by route-id, body model DIFFERS from wireModelId → NOT rejected (facts consumed)', async () => {
    // Subagent dispatch + cross-model remaps make body.model ≠ facts.wireModelId.
    // This must NOT be a binding failure: route-id matches → facts are consumed (the
    // managed key is used), proving model divergence is telemetry-only, never a reject.
    mockSettings.activeProvider = 'openrouter'; // re-derivation would say personal
    const routeTable: ModelRouteTable = { routes: new Map() };
    await proxyManager.startMultiRoute(routeTable, nextPort++);
    const proxyUrl = proxyManager.getUrl()!;
    const token = proxyManager.getAuthToken()!;

    // Carrier wireModelId = OR_MODEL (claude-sonnet-4); body model is a DIFFERENT,
    // managed-allowed model. routeId binds. The managed allow-list permits OR_MODEL
    // by default (makeManagedProviderInfo working = OR_MODEL), and we also allow the
    // diverging body model so the request reaches OR egress with the MANAGED key.
    getCachedAuthConfigMock.mockReturnValue({
      managedProvider: makeManagedProviderInfo({
        defaultModels: { working: 'anthropic/claude-3.5-sonnet' },
      }),
      hasManagedKey: true,
    });
    const carrier = signRouteFacts(factsFor('mindstone-managed-key'), token);
    const res = await sendToProxy(proxyUrl, makeBody('anthropic/claude-3.5-sonnet'), token, {
      'x-openrouter-turn': 'true',
      ...boundCarrierHeaders(carrier),
    });

    expect(res.status).toBe(200);
    // Facts WERE consumed despite the body/wire model divergence (binding is by route-id).
    expect(loadManagedOpenRouterKeyMock).toHaveBeenCalled();
    expect(egressBearer()).toBe('fake-managed-key');
    // No binding-failure telemetry for this legitimate divergence.
    expect(
      logWarnMock.mock.calls.some(
        ([, message]) => typeof message === 'string' && message.includes('does not bind'),
      ),
    ).toBe(false);
  });
});

describe('WS4b route-facts WIRE-MODEL defense-in-depth (carrier/witness mis-pairing)', () => {
  // `x-route-wire-model` (the plaintext witness) and `facts.wireModelId` are BOTH
  // minted from the SAME RouteTagFacts, so on a correctly-threaded request they ALWAYS
  // agree. A verified carrier whose wireModelId disagrees with the present witness is a
  // carrier/witness mis-pairing (e.g. a stale carrier riding alongside fresh
  // witness/anchor headers) → treat as a binding failure and re-derive. PRESENT-ONLY:
  // an ABSENT witness must NOT reject (legacy/partial callers).

  it('present + MISMATCHED witness → REJECTED, re-derives + wire-model binding telemetry', async () => {
    // Re-derivation → personal (activeProvider=openrouter). A managed carrier whose
    // wireModelId is OR_MODEL rides a request whose witness header is a DIFFERENT model
    // → mis-pairing → facts NOT consumed, re-derive personal.
    mockSettings.activeProvider = 'openrouter';
    const routeTable: ModelRouteTable = { routes: new Map() };
    await proxyManager.startMultiRoute(routeTable, nextPort++);
    const proxyUrl = proxyManager.getUrl()!;
    const token = proxyManager.getAuthToken()!;

    const carrier = signRouteFacts(factsFor('mindstone-managed-key'), token);
    const res = await sendToProxy(proxyUrl, makeBody(), token, {
      'x-openrouter-turn': 'true',
      ...boundCarrierHeaders(carrier),
      // Witness header disagrees with the carrier's wireModelId (OR_MODEL).
      [ROUTE_WIRE_MODEL_HEADER]: 'anthropic/claude-opus-4.7',
    });

    expect(res.status).toBe(200);
    expect(loadManagedOpenRouterKeyMock).not.toHaveBeenCalled();
    expect(egressBearer()).toBe('fake-personal-or-key');
    expect(
      logWarnMock.mock.calls.some(
        ([payload, message]) =>
          typeof message === 'string'
          && message.includes('[ROUTE-FACTS]')
          && message.includes('does not match the x-route-wire-model witness')
          && (payload as { factsWireModel?: unknown }).factsWireModel === OR_MODEL
          && (payload as { taggedWireModel?: unknown }).taggedWireModel === 'anthropic/claude-opus-4.7',
      ),
    ).toBe(true);
  });

  it('present + MATCHING witness → consumed (facts win)', async () => {
    mockSettings.activeProvider = 'openrouter'; // re-derivation would say personal
    const routeTable: ModelRouteTable = { routes: new Map() };
    await proxyManager.startMultiRoute(routeTable, nextPort++);
    const proxyUrl = proxyManager.getUrl()!;
    const token = proxyManager.getAuthToken()!;

    const carrier = signRouteFacts(factsFor('mindstone-managed-key'), token);
    const res = await sendToProxy(proxyUrl, makeBody(), token, {
      'x-openrouter-turn': 'true',
      ...boundCarrierHeaders(carrier),
      [ROUTE_WIRE_MODEL_HEADER]: OR_MODEL, // matches facts.wireModelId
    });

    expect(res.status).toBe(200);
    expect(loadManagedOpenRouterKeyMock).toHaveBeenCalled();
    expect(egressBearer()).toBe('fake-managed-key');
    expect(
      logWarnMock.mock.calls.some(
        ([, message]) => typeof message === 'string' && message.includes('does not match the x-route-wire-model witness'),
      ),
    ).toBe(false);
  });

  it('ABSENT witness → consumed (present-only check does not reject legacy/partial callers)', async () => {
    mockSettings.activeProvider = 'openrouter'; // re-derivation would say personal
    const routeTable: ModelRouteTable = { routes: new Map() };
    await proxyManager.startMultiRoute(routeTable, nextPort++);
    const proxyUrl = proxyManager.getUrl()!;
    const token = proxyManager.getAuthToken()!;

    const carrier = signRouteFacts(factsFor('mindstone-managed-key'), token);
    // boundCarrierHeaders sets ONLY x-route-facts + x-route-id — NO x-route-wire-model.
    const res = await sendToProxy(proxyUrl, makeBody(), token, {
      'x-openrouter-turn': 'true',
      ...boundCarrierHeaders(carrier),
    });

    expect(res.status).toBe(200);
    // Facts still consumed (managed) — absent witness is not a rejection.
    expect(loadManagedOpenRouterKeyMock).toHaveBeenCalled();
    expect(egressBearer()).toBe('fake-managed-key');
  });
});

describe('WS4b resolveRouteProfile step-2 — re-derives isAnthropicModel; does NOT consume facts', () => {
  // The Anthropic-passthrough decision (step-2) is DELIBERATELY re-derived from the
  // model string and NOT driven by `facts.transport`. `anthropic-compatible-local-proxy`
  // is OVERLOADED: a Google (Gemini) PRIMARY profile emits that same transport
  // (providerRouting.ts ~1182), so consuming it would mis-route a Google turn to
  // Anthropic. `isAnthropicModel` is a benign, settings-free model-syntax check —
  // re-deriving it is correct and behaviour-preserving.
  const ENV_BACKUP = process.env.ANTHROPIC_API_KEY;
  beforeEach(() => {
    process.env.ANTHROPIC_API_KEY = 'fake-test-anthropic-key';
  });
  afterEach(() => {
    if (ENV_BACKUP === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = ENV_BACKUP;
  });

  it('Claude model + facts present → Anthropic passthrough via re-derivation (egress to anthropic.com)', async () => {
    const routeTable: ModelRouteTable = { routes: new Map() };
    await proxyManager.startMultiRoute(routeTable, nextPort++);
    const proxyUrl = proxyManager.getUrl()!;
    const token = proxyManager.getAuthToken()!;

    const claudeModel = 'claude-sonnet-4-5';
    const carrier = signRouteFacts(
      factsFor('anthropic-api-key', {
        provider: 'anthropic',
        transport: 'anthropic-compatible-local-proxy',
        wireModelId: claudeModel,
      }),
      token,
    );
    const res = await sendToProxy(proxyUrl, makeBody(claudeModel), token, {
      [ROUTE_FACTS_HEADER]: carrier,
    });

    expect(res.status).toBe(200);
    // isAnthropicModel('claude-sonnet-4-5') === true → passthrough to Anthropic.
    expect(egressHitHost('anthropic.com')).toBe(true);
  });

  it('Claude model + facts ABSENT → re-derivation still routes Anthropic passthrough (behaviour-preserving)', async () => {
    const routeTable: ModelRouteTable = { routes: new Map() };
    await proxyManager.startMultiRoute(routeTable, nextPort++);
    const proxyUrl = proxyManager.getUrl()!;
    const token = proxyManager.getAuthToken()!;

    const res = await sendToProxy(proxyUrl, makeBody('claude-sonnet-4-5'), token);

    expect(res.status).toBe(200);
    expect(egressHitHost('anthropic.com')).toBe(true);
  });

  it('REGRESSION: Google/Gemini PRIMARY profile (anthropic-compatible-local-proxy facts) is NOT mis-routed to Anthropic', async () => {
    // The overloaded-transport bug: a Google primary profile emits transport
    // `anthropic-compatible-local-proxy`. If step-2 consumed `facts.transport` it
    // would return profile:null (Anthropic passthrough) and send this Gemini turn to
    // anthropic.com — breaking it and risking an Anthropic-key charge. With
    // re-derivation, isAnthropicModel('gemini-2.5-pro') === false → the request
    // falls through to the Google currentProfile (step-3), NEVER Anthropic.
    const googleProfile = {
      id: 'gemini-primary',
      name: 'Gemini 2.5 Pro',
      providerType: 'google' as const,
      serverUrl: 'http://127.0.0.1:59999/gemini-egress',
      model: 'gemini-2.5-pro',
      createdAt: Date.now(),
    };
    await proxyManager.startSingleProfile(googleProfile, nextPort++);
    const proxyUrl = proxyManager.getUrl()!;
    const token = proxyManager.getAuthToken()!;

    // A facts carrier that DESCRIBES the Google route as anthropic-compatible-local-proxy
    // (exactly what providerRouting emits for a Google primary). If consumed, step-2
    // would wrongly treat this as Anthropic passthrough.
    const carrier = signRouteFacts(
      factsFor('profile-api-key', {
        provider: 'profile',
        transport: 'anthropic-compatible-local-proxy',
        wireModelId: 'gemini-2.5-pro',
        profileId: 'gemini-primary',
      }),
      token,
    );
    await sendToProxy(proxyUrl, makeBody('gemini-2.5-pro'), token, {
      [ROUTE_FACTS_HEADER]: carrier,
    });

    // The crux: the Gemini turn was NEVER sent to Anthropic. Step-2 re-derived
    // isAnthropicModel=false and fell through to the Google profile route. (We do
    // not assert the downstream Google egress succeeds — the mocked profile server
    // is irrelevant; the regression guard is purely "did NOT hit anthropic.com".)
    expect(egressHitHost('anthropic.com')).toBe(false);
  });
});

describe('WS4b turnOpenRouterFallback override — carried facts do not influence the override turn', () => {
  // NOTE on reachability: the `profile === null/undefined` → OpenRouter override leg
  // (handleMessagesRequest ~4346/4360) is guarded upstream by `resolveRouteProfile`
  // step-1, which fail-closes (route-required 400) for any registered turn whose
  // `x-routed-model` is missing or not in its table — exactly as the existing
  // `openrouterFallback.test.ts` suite documents (none of those reach OR egress
  // either). The override leg is therefore a defensive fallback reached only via a
  // no-turn-table state the public API can't construct in a unit test. What IS
  // reachable — and what these tests pin — is the INVARIANT the WS4b wiring must
  // preserve: a fallback turn's route resolution is NOT influenced by carried facts
  // (the wiring passes `null` facts into `resolveRouteProfile` AND into
  // `handleOpenRouterPassthrough` whenever the override is active). We assert the
  // route-resolution outcome on a fallback turn is identical with and without a
  // (managed-claiming) facts carrier present.

  it('fallback turn: managed-claiming facts carrier does NOT change route resolution (still route-required 400)', async () => {
    mockSettings.activeProvider = 'openrouter';
    const routeTable: ModelRouteTable = { routes: new Map() };
    await proxyManager.addRoutes('turn-or-fallback', routeTable, undefined, nextPort++, true);
    const proxyUrl = proxyManager.getUrl()!;
    const token = proxyManager.getAuthToken()!;

    // A managed-claiming carrier (would flip isManagedMode IF consumed on this turn).
    const carrier = signRouteFacts(
      factsFor('mindstone-managed-key', { transport: 'anthropic-compatible-local-proxy', provider: 'anthropic' }),
      token,
    );
    const res = await sendToProxy(proxyUrl, makeBody('claude-sonnet-4-5'), token, {
      'x-routed-turn-id': 'turn-or-fallback',
      'x-routed-model': 'claude-sonnet-4-5',
      [ROUTE_FACTS_HEADER]: carrier,
    });

    // Route resolution is unaffected by the carried facts (step-1 still governs).
    expect(res.status).toBe(400);
    expect(JSON.parse(res.body)).toMatchObject({ error: 'route_required' });
    // The managed key resolver was NEVER consulted — facts were not consumed on the
    // fallback turn (the override invariant: the override decides, not the facts).
    expect(loadManagedOpenRouterKeyMock).not.toHaveBeenCalled();
  });

  it('control: same fallback turn WITHOUT a facts carrier behaves identically (route-required 400)', async () => {
    mockSettings.activeProvider = 'openrouter';
    const routeTable: ModelRouteTable = { routes: new Map() };
    await proxyManager.addRoutes('turn-or-fallback-2', routeTable, undefined, nextPort++, true);
    const proxyUrl = proxyManager.getUrl()!;
    const token = proxyManager.getAuthToken()!;

    const res = await sendToProxy(proxyUrl, makeBody('claude-sonnet-4-5'), token, {
      'x-routed-turn-id': 'turn-or-fallback-2',
      'x-routed-model': 'claude-sonnet-4-5',
    });

    // Identical outcome to the facts-present case → facts do not influence the turn.
    expect(res.status).toBe(400);
    expect(JSON.parse(res.body)).toMatchObject({ error: 'route_required' });
    expect(loadManagedOpenRouterKeyMock).not.toHaveBeenCalled();
  });
});
