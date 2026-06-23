import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createClientForModel, createClientFromRoutePlan } from '../../clientFactory';
import { AnthropicClient } from '../anthropicClient';
import { OpenAIClient } from '../openaiClient';
import { ProviderRouter } from '../../providerRouting';
import { materializePlanRuntime } from '../../providerRoutePlan';
import { isTerminalRoutePlan } from '../../providerRoutePlanTypes';
import type { CreateParams } from '../../modelClient';
import type { AppSettings } from '@shared/types';
import type { ModelProfile } from '@shared/types/settings';
import {
  decodePrefixed,
  unsafeAssertRoutingModelId,
  type RoutingModelId,
} from '@shared/utils/modelChoiceCodec';
import { brandRouteWireModel } from '@shared/utils/wireModelId';

type CapturedRequest = {
  url: string;
  body: Record<string, unknown>;
};

const BASE_CREATE_PARAMS = {
  systemPrompt: 'You are a terse assistant.',
  messages: [{ role: 'user' as const, content: 'Reply ok.' }],
  maxTokens: 8,
};

function makeSettings(overrides: Partial<AppSettings> = {}): AppSettings {
  return {
    coreDirectory: null,
    mcpConfigFile: null,
    onboardingCompleted: true,
    userEmail: null,
    onboardingFirstCompletedAt: null,
    activeProvider: 'anthropic',
    voice: { enabled: false },
    // Runtime auth resolves from the canonical `models` namespace ONLY (since commit
    // 0cef1cb681, C2b-1 — `settingsAccessorsPure.getApiKey` reads `settings.models`, no
    // legacy `settings.claude` fallback). Production materializes `models` from legacy
    // `claude` at bootstrap/normalization; this isolated integration test bypasses that,
    // so it sets `models` directly. Kept `models`-only (no `claude` block) on purpose so
    // an accidental future re-introduction of a `claude` runtime fallback would fail here.
    models: {
      apiKey: 'test-anthropic-key',
      oauthToken: null,
      authMethod: 'api-key',
      model: 'claude-sonnet-4-6',
      permissionMode: 'plan',
      executablePath: null,
      planMode: true,
      extendedContext: false,
    },
    diagnostics: { enabled: false },
    localModel: { profiles: [], activeProfileId: null },
    ...overrides,
  } as unknown as AppSettings;
}

function makeOpenRouterProfile(model: RoutingModelId): ModelProfile {
  return {
    id: 'openrouter-profile',
    name: 'OpenRouter profile',
    providerType: 'openrouter',
    serverUrl: 'https://openrouter.ai/api/v1',
    apiKey: 'test-openrouter-key',
    model,
    enabled: true,
    createdAt: 0,
  };
}

// F1 PROBE (260608, throwaway diagnostic — remove if F1 is REFUTED): a
// Google (Gemini) profile. providerType:'google' routes to transport
// 'anthropic-compatible-local-proxy' (providerRouting.ts:802-805) whose headers
// OMIT x-openrouter-turn (providerRouteHeaders.ts:96), so the proxy
// AnthropicClient is non-passthrough (isOpenRouterPassthrough=false).
function makeGoogleProfile(model: string): ModelProfile {
  return {
    id: 'google-profile',
    name: 'Gemini profile',
    providerType: 'google',
    serverUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    apiKey: 'test-gemini-key',
    model,
    enabled: true,
    createdAt: 0,
  } as ModelProfile;
}

function anthropicMessageResponse(model: string): Response {
  return new Response(JSON.stringify({
    id: 'msg_test',
    type: 'message',
    role: 'assistant',
    model,
    content: [{ type: 'text', text: 'ok' }],
    stop_reason: 'end_turn',
    stop_sequence: null,
    usage: { input_tokens: 1, output_tokens: 1 },
  }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

function openAiChatResponse(model: string): Response {
  return new Response(JSON.stringify({
    id: 'chatcmpl_test',
    object: 'chat.completion',
    created: 1,
    model,
    choices: [{
      index: 0,
      message: { role: 'assistant', content: 'ok' },
      finish_reason: 'stop',
    }],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

function decodeStoredModelForRouting(storedValue: string): RoutingModelId {
  const decoded = decodePrefixed(storedValue);
  if (!decoded) {
    throw new Error(`No model choice decoded from ${storedValue}`);
  }
  if (decoded.kind === 'profile') {
    throw new Error(`Profile reference ${decoded.profileId} must resolve before provider wire egress`);
  }
  return decoded.modelId;
}

async function createWithModel(model: RoutingModelId, client: { create(params: CreateParams): Promise<unknown> }): Promise<void> {
  await client.create({
    ...BASE_CREATE_PARAMS,
    model,
  });
}

describe('model-id lifecycle integration: storage codec to provider wire body', () => {
  let capturedRequests: CapturedRequest[];
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    capturedRequests = [];
    fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url: string | URL | Request, init?: RequestInit) => {
      const urlText = typeof url === 'string' ? url : url instanceof URL ? url.toString() : url.url;
      const bodyText = typeof init?.body === 'string' ? init.body : '';
      const parsedBody = bodyText ? JSON.parse(bodyText) as Record<string, unknown> : {};
      capturedRequests.push({ url: urlText, body: parsedBody });

      if (urlText.includes('/chat/completions')) {
        return openAiChatResponse(String(parsedBody.model));
      }
      return anthropicMessageResponse(String(parsedBody.model));
    });
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  it('bare Anthropic id reaches direct Anthropic unchanged', async () => {
    const model = decodeStoredModelForRouting('claude-sonnet-4-6');
    const client = await createClientForModel({ model, settings: makeSettings() });
    expect(client).toBeInstanceOf(AnthropicClient);

    await createWithModel(model, client);

    expect(capturedRequests).toHaveLength(1);
    expect(capturedRequests[0].body.model).toBe('claude-sonnet-4-6');
  });

  // 260606 reconciliation — the facade (createClientForModel) delegates to CENTRAL provider
  // routing (providerRouting.ts `case 'anthropic'`), which since the direct-anthropic-dialect
  // fix distinguishes a FOREIGN/proxy dialect from a matching native self-prefix. So the
  // "260529 fail-closed guard" is preserved but made precise: it fails closed only on genuinely
  // foreign/malformed prefixes (the stale-OpenRouter-settings hazard it exists to stop), NOT on a
  // single matching `anthropic/<native Claude>` self-prefix — which the route normalizes to a
  // bare wire id and dispatches native (consistent with the profile-Anthropic / Codex arms and
  // the documented wire boundary; see providerRouteDecision.resolveDirectAnthropicModel
  // and providerRouteDecision.test.ts). The `anthropic/` -> native strip also remains as
  // defense-in-depth at the AnthropicClient wire boundary (anthropicClient.resolveAnthropicWireModel).
  it('model-prefixed FOREIGN dialect reaching direct Anthropic (no proxy) fails closed', async () => {
    const model = decodeStoredModelForRouting('model:openai/gpt-5.5');
    await expect(createClientForModel({ model, settings: makeSettings() })).rejects.toMatchObject({
      __routingCause: 'proxy-dialect-in-direct-anthropic',
    });
  });

  it('model-prefixed nested/non-native anthropic dialect reaching direct Anthropic (no proxy) fails closed', async () => {
    const nested = decodeStoredModelForRouting('model:anthropic/anthropic/claude-opus-4.7');
    await expect(createClientForModel({ model: nested, settings: makeSettings() })).rejects.toMatchObject({
      __routingCause: 'proxy-dialect-in-direct-anthropic',
    });
  });

  it('model-prefixed matching anthropic/ self-prefix reaching direct Anthropic (no proxy) normalizes + dispatches native', async () => {
    const model = decodeStoredModelForRouting('model:anthropic/claude-opus-4.7');
    const client = await createClientForModel({ model, settings: makeSettings() });
    expect(client).toBeInstanceOf(AnthropicClient);

    await createWithModel(model, client);

    // The wire body carries the bare native id, NOT the `anthropic/`-prefixed form.
    expect(capturedRequests).toHaveLength(1);
    expect(capturedRequests[0].body.model).toBe('claude-opus-4-7');
  });

  it('OpenRouter OpenAI-compatible profile preserves slash model ids unchanged on the wire', async () => {
    const model = decodeStoredModelForRouting('anthropic/claude-opus-4.7');
    const profile = makeOpenRouterProfile(model);
    const client = await createClientForModel({ model, profile, settings: makeSettings() });
    expect(client).toBeInstanceOf(OpenAIClient);

    await createWithModel(model, client);

    expect(capturedRequests).toHaveLength(1);
    expect(capturedRequests[0].url).toBe('https://openrouter.ai/api/v1/chat/completions');
    expect(capturedRequests[0].body.model).toBe('anthropic/claude-opus-4.7');
  });

  it('OpenRouter Anthropic-proxy passthrough preserves slash model ids unchanged on the wire', async () => {
    const model = unsafeAssertRoutingModelId('anthropic/claude-opus-4.7');
    const client = await createClientForModel({
      model,
      settings: makeSettings(),
      proxyConfig: {
        baseURL: 'http://127.0.0.1:34567',
        defaultHeaders: { 'x-openrouter-turn': 'true' },
      },
    });
    expect(client).toBeInstanceOf(AnthropicClient);

    await createWithModel(model, client);

    expect(capturedRequests).toHaveLength(1);
    expect(capturedRequests[0].body.model).toBe('anthropic/claude-opus-4.7');
  });

  it('profile-prefixed storage values stop at ProfileRef and do not reach provider wire egress', async () => {
    const decoded = decodePrefixed('profile:openrouter-profile');
    expect(decoded).toEqual({ kind: 'profile', profileId: 'openrouter-profile' });

    expect(() => decodeStoredModelForRouting('profile:openrouter-profile')).toThrow(
      'must resolve before provider wire egress',
    );
    expect(capturedRequests).toEqual([]);
  });

  // ── REBEL-5N8: sub-agent route-table dispatch vs streamed-model divergence ──
  //
  // Reproduces Sentry 7484245991 (`area=sub-agent-dispatch`, `agent=model-gpt-5-5`,
  // `model=openai/gpt-5.5`, `activeProvider=openrouter`).
  //
  // A model-team / ad-hoc agent (adHocAgentService) is generated as
  //   { model: 'working', routedModel: 'openai/gpt-5.5', routingMode: 'ad-hoc' }
  // queryOptionsBuilder stamps routingMode='ad-hoc' → routeScope='ad-hoc'
  // (a route-table scope). In agentTool.executeAgentTool the sub-agent client is
  // built from `routeModel` (= agentDef.model = 'working'), while runAgentLoop is
  // called streaming a SEPARATELY-resolved `model` (the 'working' alias resolved
  // under activeProvider=openrouter → 'openai/gpt-5.5').
  //
  // ProviderRouter.forSubagent coerces every route-table-scope decision to
  // transport 'anthropic-compatible-local-proxy' (coerceToRouteTable), whose
  // headers DELIBERATELY omit `x-openrouter-turn` (the proxy resolves the real
  // backend from the `x-routed-model` header). So createClientFromRoutePlan
  // builds an AnthropicClient with isOpenRouterPassthrough=false. Streaming the
  // slash-prefixed `model='openai/gpt-5.5'` to that client trips the
  // last-line-of-defense throw in resolveAnthropicWireModel (anthropicClient.ts:764).
  //
  // This test drives the EXACT agentTool dispatch chain (forSubagent →
  // materializePlanRuntime → createClientFromRoutePlan) with the bug's values.
  // REBEL-5N8 FIX (Stage 1): agentTool now streams the route-table-safe BODY
  // MODEL sourced from the SAME plan that built the client
  // (`dispatchablePlan.decision.wireModelId` = 'working'), NOT the separately-
  // resolved foreign slug. The concrete backend rides only in `x-routed-model`.
  // Streaming the plan's wireModelId to the proxy AnthropicClient therefore does
  // NOT trip the direct-Anthropic routing-mismatch guard.
  it('route-table (ad-hoc) sub-agent streams the route-table-safe body model and does NOT trip the direct-Anthropic routing-mismatch guard', async () => {
    // Values mirror agentTool.executeAgentTool for agent `model-gpt-5-5`:
    //   agentDef.model = 'working', agentDef.routedModel = 'openai/gpt-5.5',
    //   routeScope = 'ad-hoc' (route-table).
    const routeModel = 'working'; // agentDef.model — what the CLIENT is built from
    const routedModelForTransport = 'openai/gpt-5.5'; // agentDef.routedModel

    const settings = makeSettings({
      activeProvider: 'openrouter',
      openRouter: {
        enabled: true,
        oauthToken: 'test-openrouter-oauth',
        selectedModel: 'openai/gpt-5.5',
      },
    } as unknown as Partial<AppSettings>);

    const baseDecision = ProviderRouter.forSubagent({
      model: routeModel,
      settings,
      routeScope: 'ad-hoc',
      routedModel: routedModelForTransport,
      codexConnectivity: 'unknown',
    });

    // The local model proxy supplies baseURL + identity headers at runtime
    // (mirrors ctx.proxyConfig in production sub-agent dispatch).
    const plan = await materializePlanRuntime(baseDecision, {
      turnId: 'turn-rebel-5n8',
      agentId: 'model-gpt-5-5',
      routedModel: routedModelForTransport,
      proxyBaseURL: 'http://127.0.0.1:34567',
      proxyAuthToken: 'proxy-token',
      anthropicApiKey: null,
      anthropicOAuthToken: null,
      openRouterOAuthToken: 'test-openrouter-oauth',
    });

    expect(plan.decision.kind).toBe('dispatchable');
    // Narrow ProviderRoutePlan → DispatchableRoutePlan via the exported guard,
    // mirroring agentTool.ts:1331-1334 (createClientFromRoutePlan requires the
    // dispatchable plan, not the union; narrowing on plan.decision.kind alone
    // does not narrow `plan`).
    if (isTerminalRoutePlan(plan)) throw new Error('expected dispatchable plan');
    // Route-table coercion forces the local-proxy transport (no x-openrouter-turn).
    expect(plan.decision.transport).toBe('anthropic-compatible-local-proxy');
    expect(plan.decision.dispatchPath).toBe('local-proxy-route-table');

    const subClient = createClientFromRoutePlan(plan, settings);
    expect(subClient).toBeInstanceOf(AnthropicClient);

    // POST-FIX: agentTool streams the plan's route-table-safe body model, NOT the
    // foreign slug. Mirror that here by sourcing the streamed model from the plan.
    const bodyModel: RoutingModelId = unsafeAssertRoutingModelId(plan.decision.wireModelId);
    expect(bodyModel).not.toContain('/'); // route-table-safe (bare); the foreign slug rides x-routed-model
    expect(bodyModel).toBe('working');

    // runAgentLoop streams that route-table-safe body model to this client.
    // CORRECT behaviour: the request reaches the proxy without the client
    // rejecting a foreign-prefixed id as a "routing mismatch".
    await expect(createWithModel(bodyModel, subClient)).resolves.not.toThrow();

    // And it should actually hit the wire (proxy / OpenRouter), not fail before egress.
    expect(capturedRequests).toHaveLength(1);
  });

  // ── F1 sibling class (260608): non-route-table profile-backed Google proxy ──
  //
  // A NON-route-table (normal-turn) profile-backed Google dispatch builds an
  // 'anthropic-compatible-local-proxy' client WITHOUT x-openrouter-turn
  // (isOpenRouterPassthrough=false), dispatchPath 'local-proxy-passthrough'
  // (NOT route-table). Post-fix, bodyModel stays the resolved `model`
  // (agentTool.ts, gate fires only for route-table scope). These two tests pin
  // the wire-boundary behaviour for that path:
  //   (a) the realistic (bare-id) Google config reaches the wire unharmed;
  //   (b) a slash-form misconfig fails CLOSED at the wire (the last-line guard).
  // The corresponding SEAM-level assertion (that agentTool's broadened backstop
  // converts (b) into a classified area=sub-agent-dispatch routing error BEFORE
  // the wire) lives in subAgentProxyRouting.test.ts ("(Stage 5) non-route-table
  // local-proxy-passthrough ... broadened seam backstop"); here we lock the
  // wire-level fail-closed contract that the seam guard front-runs.

  // (a) Realistic config: a Google PRESET profile carries a BARE id
  //     ('gemini-2.5-flash', modelProviderPresets.ts:309). Bare id => no slash =>
  //     resolveAnthropicWireModel does NOT throw. This is the only Google config
  //     the product UI produces. Expectation: builds non-passthrough proxy client,
  //     reaches the wire, NO throw.
  it('non-route-table Google profile with a BARE gemini id builds a non-passthrough proxy client and does NOT throw', async () => {
    const model = unsafeAssertRoutingModelId('gemini-2.5-flash');
    const profile = makeGoogleProfile('gemini-2.5-flash');
    const settings = makeSettings({
      activeProvider: 'google',
      localModel: { profiles: [profile], activeProfileId: profile.id },
    } as unknown as Partial<AppSettings>);

    const baseDecision = ProviderRouter.forSubagent({
      model,
      profile,
      settings,
      routeScope: 'normal-turn',
      codexConnectivity: 'unknown',
    });
    expect(baseDecision.transport).toBe('anthropic-compatible-local-proxy');
    // NON-route-table — this is the F1 path.
    expect(baseDecision.dispatchPath).toBe('local-proxy-passthrough');

    const plan = await materializePlanRuntime(baseDecision, {
      turnId: 'turn-f1a',
      agentId: 'gemini-subagent',
      routedModel: null,
      proxyBaseURL: 'http://127.0.0.1:34567',
      proxyAuthToken: 'proxy-token',
      anthropicApiKey: 'test-anthropic-key',
      anthropicOAuthToken: null,
      openRouterOAuthToken: null,
      profileApiKey: 'test-gemini-key',
    });
    if (isTerminalRoutePlan(plan)) throw new Error('expected dispatchable plan');

    const subClient = createClientFromRoutePlan(plan, settings, { routeProfile: profile });
    expect(subClient).toBeInstanceOf(AnthropicClient);

    // Post-fix bodyModel for non-route-table = resolved `model` (bare). No throw.
    await expect(createWithModel(model, subClient)).resolves.not.toThrow();
    expect(capturedRequests).toHaveLength(1);
    expect(capturedRequests[0].body.model).toBe('gemini-2.5-flash');
  });

  // (b) Adversarial / misconfig config: force a SLASH-form id onto a Google
  //     profile ('google/gemini-2.5-flash'). This is NOT a shape the product UI
  //     produces (google presets are bare; slash 'google/gemini-*' ids belong to
  //     OpenRouter profiles, which route via openrouter-proxy => passthrough). A
  //     user hand-typing a slash id into a Google profile's manual model field
  //     reaches the non-passthrough proxy AnthropicClient.
  //
  //     STAGE 3 (class-killer): `createClientFromRoutePlan` now fails CLOSED at the
  //     shared client-build seam with a CLASSIFIED routing error
  //     (`__agentErrorKind:'routing'`, `__routingCause:'non-passthrough-anthropic-slash-body'`)
  //     BEFORE building the client / reaching the wire — so the invalid pairing is
  //     unreachable from every dispatch door, not just sub-agents. The wire guard
  //     (resolveAnthropicWireModel) stays as the last-ditch defense.
  it('non-route-table Google profile with a forced SLASH id fails closed at the client-build SEAM (Stage 3, classified routing error, no wire request)', async () => {
    const model = unsafeAssertRoutingModelId('google/gemini-2.5-flash');
    const profile = makeGoogleProfile('google/gemini-2.5-flash');
    const settings = makeSettings({
      activeProvider: 'google',
      localModel: { profiles: [profile], activeProfileId: profile.id },
    } as unknown as Partial<AppSettings>);

    const baseDecision = ProviderRouter.forSubagent({
      model,
      profile,
      settings,
      routeScope: 'normal-turn',
      codexConnectivity: 'unknown',
    });
    // The transport/scope opening is real: non-passthrough local-proxy, non-route-table.
    expect(baseDecision.transport).toBe('anthropic-compatible-local-proxy');
    expect(baseDecision.dispatchPath).toBe('local-proxy-passthrough');

    const plan = await materializePlanRuntime(baseDecision, {
      turnId: 'turn-f1b',
      agentId: 'gemini-subagent',
      routedModel: null,
      proxyBaseURL: 'http://127.0.0.1:34567',
      proxyAuthToken: 'proxy-token',
      anthropicApiKey: 'test-anthropic-key',
      anthropicOAuthToken: null,
      openRouterOAuthToken: null,
      profileApiKey: 'test-gemini-key',
    });
    if (isTerminalRoutePlan(plan)) throw new Error('expected dispatchable plan');

    // SEAM backstop throws the classified routing error here — the client is never built.
    expect(() => createClientFromRoutePlan(plan, settings, { routeProfile: profile }))
      .toThrowError(/routing mismatch/);
    try {
      createClientFromRoutePlan(plan, settings, { routeProfile: profile });
      throw new Error('expected createClientFromRoutePlan to throw');
    } catch (err) {
      const e = err as Error & { __agentErrorKind?: string; __routingCause?: string };
      expect(e.__agentErrorKind).toBe('routing');
      expect(e.__routingCause).toBe('non-passthrough-anthropic-slash-body');
    }
    // Caught before the wire: nothing ever reached fetch.
    expect(capturedRequests).toHaveLength(0);
  });

  // ── Stage 3 (memory-BTS class-kill): the seam backstop covers EVERY
  //    non-passthrough Anthropic transport and dispatch door, not just the
  //    sub-agent local-proxy one. Materialize codex-proxy + anthropic-direct plans
  //    with a slash body model → the shared seam throws a classified routing error
  //    BEFORE the wire. Positive controls: openrouter-proxy slash body (passthrough)
  //    still builds; route-table alias body still builds.

  it('codex-proxy plan with a slash body model fails closed at the SEAM (classified routing, no wire request)', async () => {
    const model = unsafeAssertRoutingModelId('deepseek/deepseek-v4-flash');
    const settings = makeSettings({ activeProvider: 'codex' } as unknown as Partial<AppSettings>);

    // Materialize a codex-proxy decision directly (the route arm now terminals such
    // a model, so we synthesize the dispatchable plan the seam must still defend).
    const baseDecision = ProviderRouter.forSubagent({
      model: unsafeAssertRoutingModelId('gpt-5.5'),
      settings,
      routeScope: 'normal-turn',
      codexConnectivity: 'connected',
    });
    expect(baseDecision.transport).toBe('codex-proxy');
    const plan = await materializePlanRuntime(baseDecision, {
      turnId: 'turn-codex-slash',
      agentId: 'codex-subagent',
      routedModel: null,
      proxyBaseURL: 'http://127.0.0.1:34567',
      proxyAuthToken: 'proxy-token',
      anthropicApiKey: null,
      anthropicOAuthToken: null,
      openRouterOAuthToken: null,
    });
    if (isTerminalRoutePlan(plan)) throw new Error('expected dispatchable plan');
    // Force the invalid {codex-proxy × slash body} pairing the seam must reject.
    const codexSlashPlan = {
      ...plan,
      decision: { ...plan.decision, wireModelId: brandRouteWireModel(model) },
    } as typeof plan;

    try {
      createClientFromRoutePlan(codexSlashPlan, settings);
      throw new Error('expected createClientFromRoutePlan to throw');
    } catch (err) {
      const e = err as Error & { __agentErrorKind?: string; __routingCause?: string };
      expect(e.message).toMatch(/routing mismatch/);
      expect(e.__agentErrorKind).toBe('routing');
      expect(e.__routingCause).toBe('non-passthrough-anthropic-slash-body');
    }
    expect(capturedRequests).toHaveLength(0);
  });

  it('anthropic-direct plan with a slash body model fails closed at the SEAM (classified routing, no wire request)', async () => {
    const model = unsafeAssertRoutingModelId('claude-opus-4-8');
    const settings = makeSettings();

    const baseDecision = ProviderRouter.forSubagent({
      model,
      settings,
      routeScope: 'normal-turn',
      codexConnectivity: 'unknown',
    });
    expect(baseDecision.transport).toBe('anthropic-direct');
    const plan = await materializePlanRuntime(baseDecision, {
      turnId: 'turn-direct-slash',
      agentId: 'direct-subagent',
      routedModel: null,
      proxyBaseURL: null,
      proxyAuthToken: null,
      anthropicApiKey: 'test-anthropic-key',
      anthropicOAuthToken: null,
      openRouterOAuthToken: null,
    });
    if (isTerminalRoutePlan(plan)) throw new Error('expected dispatchable plan');
    const directSlashPlan = {
      ...plan,
      decision: { ...plan.decision, wireModelId: brandRouteWireModel('foo/bar-model') },
    } as typeof plan;

    try {
      createClientFromRoutePlan(directSlashPlan, settings);
      throw new Error('expected createClientFromRoutePlan to throw');
    } catch (err) {
      const e = err as Error & { __agentErrorKind?: string; __routingCause?: string };
      expect(e.message).toMatch(/routing mismatch/);
      expect(e.__agentErrorKind).toBe('routing');
      expect(e.__routingCause).toBe('non-passthrough-anthropic-slash-body');
    }
    expect(capturedRequests).toHaveLength(0);
  });

  it('positive control — openrouter-proxy (passthrough) plan with a slash body still builds (NOT a routing error)', async () => {
    const model = unsafeAssertRoutingModelId('anthropic/claude-opus-4.7');
    const settings = makeSettings({
      activeProvider: 'openrouter',
      openRouter: { enabled: true, oauthToken: 'test-openrouter-oauth', selectedModel: 'anthropic/claude-opus-4.7' },
    } as unknown as Partial<AppSettings>);

    const baseDecision = ProviderRouter.forSubagent({
      model,
      settings,
      routeScope: 'normal-turn',
      codexConnectivity: 'unknown',
    });
    expect(baseDecision.transport).toBe('openrouter-proxy');
    const plan = await materializePlanRuntime(baseDecision, {
      turnId: 'turn-or-slash',
      agentId: 'or-subagent',
      routedModel: null,
      proxyBaseURL: 'http://127.0.0.1:34567',
      proxyAuthToken: 'proxy-token',
      anthropicApiKey: null,
      anthropicOAuthToken: null,
      openRouterOAuthToken: 'test-openrouter-oauth',
    });
    if (isTerminalRoutePlan(plan)) throw new Error('expected dispatchable plan');
    // Passthrough transport (x-openrouter-turn) — slash is tolerated; seam must NOT fire.
    const client = createClientFromRoutePlan(plan, settings);
    expect(client).toBeInstanceOf(AnthropicClient);
    await expect(createWithModel(model, client)).resolves.not.toThrow();
    expect(capturedRequests).toHaveLength(1);
    expect(capturedRequests[0].body.model).toBe('anthropic/claude-opus-4.7');
  });

  it('positive control — route-table alias body (`working`) still builds (seam guard sits AFTER the route-table early-return)', async () => {
    const settings = makeSettings({
      activeProvider: 'openrouter',
      openRouter: { enabled: true, oauthToken: 'test-openrouter-oauth', selectedModel: 'openai/gpt-5.5' },
    } as unknown as Partial<AppSettings>);

    const baseDecision = ProviderRouter.forSubagent({
      model: 'working',
      settings,
      routeScope: 'ad-hoc',
      routedModel: 'openai/gpt-5.5',
      codexConnectivity: 'unknown',
    });
    const plan = await materializePlanRuntime(baseDecision, {
      turnId: 'turn-rt-positive',
      agentId: 'model-gpt-5-5',
      routedModel: 'openai/gpt-5.5',
      proxyBaseURL: 'http://127.0.0.1:34567',
      proxyAuthToken: 'proxy-token',
      anthropicApiKey: null,
      anthropicOAuthToken: null,
      openRouterOAuthToken: 'test-openrouter-oauth',
    });
    if (isTerminalRoutePlan(plan)) throw new Error('expected dispatchable plan');
    expect(plan.decision.dispatchPath).toBe('local-proxy-route-table');
    expect(plan.decision.wireModelId).toBe('working'); // alias body, no slash → guard exempt
    // Route-table early-return builds via the proxy config; seam guard never reached.
    const client = createClientFromRoutePlan(plan, settings);
    expect(client).toBeInstanceOf(AnthropicClient);
  });
});
