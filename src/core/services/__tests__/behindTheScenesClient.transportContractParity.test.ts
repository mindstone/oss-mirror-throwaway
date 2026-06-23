 
/**
 * BTS transport contract parity test (plan 260509)
 *
 * Single fixture run through every dispatchable BTS transport to verify each
 * one correctly populates structured-output enforcement on the wire. Closes
 * the bug class identified in
 * `docs-private/investigations/260509_bts_output_format_dropped_codex_proxy.md`:
 * future contributors adding a new transport (or modifying an existing one)
 * must declare what enforcement that path provides for `outputFormat`.
 *
 * Structurally enforced via `Record<DispatchableTransport, TransportContract>`
 * — TypeScript fails compilation if a future transport is added to the union
 * without a corresponding contract entry here.
 *
 * Scope: BTS-client → wire boundary. The proxy → upstream side of each
 * proxy-routed transport is covered by
 * `src/main/services/__tests__/localModelProxyServer.codexSubscription.test.ts`
 * and `src/main/services/__tests__/localModelProxyServer.outputFormat.test.ts`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppSettings } from '@shared/types';
import { brandRouteWireModel } from '@shared/utils/wireModelId';
import { setSettingsStoreAdapter } from '@core/services/settingsStore';
import { createAuthEnvUtilsMock } from '@core/utils/__tests__/authEnvUtilsMock';

vi.mock('@core/logger', () => ({
  createScopedLogger: () => ({
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
  getTurnContext: vi.fn(() => undefined),
}));

vi.mock('@core/services/costLedgerService', () => ({
  appendCostEntry: vi.fn(() => ({ costEntryId: 'test-cost-entry-id' })),
}));

vi.mock('../codexAuthCore', () => ({
  isCodexConnected: vi.fn(() => false),
}));

vi.mock('@core/utils/authEnvUtils', () =>
  createAuthEnvUtilsMock({ hasValidAuth: false, isDirectAnthropicConfig: true }),
);

vi.mock('@core/utils/systemUtils', () => ({
  setupNodeEnvironment: vi.fn().mockResolvedValue('/usr/bin'),
}));

import {
  callBehindTheScenesWithAuth,
  registerBtsProxyProviders,
  declareNoBtsProxy,
} from '../behindTheScenesClient';
import { hasValidAuth, isDirectAnthropicConfig, isUsingOpenRouter } from '@core/utils/authEnvUtils';
import { ProviderRouter } from '@core/rebelCore/providerRouting';
import type { DispatchableRouteDecision } from '@core/rebelCore/providerRouteDecision';
import type { DispatchableTransport } from '@core/rebelCore/providerRouteDecision';

// ─── Shared fixture ────────────────────────────────────────────────────────

const FIXTURE_SCHEMA = {
  type: 'object',
  properties: {
    estimate_minutes_low: { type: 'number' },
    estimate_minutes_high: { type: 'number' },
    confidence: { type: 'string', enum: ['low', 'medium', 'high'] },
  },
  required: ['estimate_minutes_low', 'estimate_minutes_high', 'confidence'],
  additionalProperties: false,
} as const;

const FIXTURE_OPTIONS = {
  messages: [{ role: 'user' as const, content: 'How long did this take?' }],
  temperature: 0.2,
  outputFormat: { type: 'json_schema' as const, schema: FIXTURE_SCHEMA },
};

function setSettings(overrides: Partial<AppSettings>): AppSettings {
  const settings = {
    activeProvider: 'anthropic',
    coreDirectory: '/tmp/test',
    models: { apiKey: null, model: 'claude-sonnet-4-6' },
    behindTheScenesModel: undefined,
    providerKeys: {},
    customProviders: [],
    localModel: { activeProfileId: null, profiles: [] },
    ...overrides,
  } as AppSettings;
  setSettingsStoreAdapter({
    getSettings: () => settings,
    updateSettings: () => {},
    updateSettingsAtomic: () => {},
  });
  return settings;
}

function makeAnthropicSuccess(): Response {
  return new Response(JSON.stringify({
    content: [{ type: 'text', text: '{"estimate_minutes_low":1,"estimate_minutes_high":2,"confidence":"low"}' }],
    model: 'claude-sonnet-4-6',
    usage: { input_tokens: 10, output_tokens: 5 },
  }), { status: 200, headers: { 'content-type': 'application/json' } });
}

function makeOpenAICompatSuccess(): Response {
  return new Response(JSON.stringify({
    choices: [{ message: { role: 'assistant', content: '{"estimate_minutes_low":1,"estimate_minutes_high":2,"confidence":"low"}' }, finish_reason: 'stop' }],
    model: 'gpt-5.5',
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
  }), { status: 200, headers: { 'content-type': 'application/json' } });
}

// ─── Per-transport contract type ───────────────────────────────────────────

interface TransportInvocation {
  url: string | URL | Request;
  body: Record<string, unknown>;
  headers: Record<string, string>;
}

interface TransportContract {
  /**
   * Human-readable note about why this transport handles output_format
   * the way it does. Surfaces in test names so future contributors see
   * the invariant they're acknowledging.
   */
  description: string;
  /** Drives the dispatcher to actually pick this transport. */
  setup: (registerSpy: (decision: DispatchableRouteDecision) => void) => {
    settings: AppSettings;
    response: Response;
  };
  /** Invariants the transport must satisfy on the outbound wire request. */
  assertWire: (invocation: TransportInvocation) => void;
}

// ─── Per-transport contracts (one entry per `DispatchableTransport`) ───────

const TRANSPORT_CONTRACTS: Record<DispatchableTransport, TransportContract> = {
  'anthropic-direct': {
    description:
      'Anthropic API native — output_format and structured-output beta header forwarded as-is.',
    setup: () => {
      vi.mocked(hasValidAuth).mockReturnValue(true);
      vi.mocked(isDirectAnthropicConfig).mockReturnValue(true);
      const settings = setSettings({
        activeProvider: 'anthropic',
        models: { apiKey: 'fake-anthropic-key', model: 'claude-sonnet-4-6' } as AppSettings['models'],
        behindTheScenesModel: 'claude-sonnet-4-6',
      });
      return { settings, response: makeAnthropicSuccess() };
    },
    assertWire: ({ url, body, headers }) => {
      expect(url).toBe('https://api.anthropic.com/v1/messages');
      expect(headers['anthropic-beta']).toBe('structured-outputs-2025-11-13');
      expect(body.output_format).toEqual({ type: 'json_schema', schema: FIXTURE_SCHEMA });
      expect(body.temperature).toBe(0.2);
      expect(body.stream).toBe(false);
    },
  },

  'codex-proxy': {
    description:
      'Codex subscription routed through localhost proxy; output_format flows verbatim to the proxy, which translates to OpenAI response_format on the upstream Codex Responses request.',
    setup: () => {
      registerBtsProxyProviders({ url: () => 'http://127.0.0.1:9999', auth: () => 'test-proxy-token' });
      const settings = setSettings({
        activeProvider: 'anthropic',
        models: { apiKey: null, model: 'claude-sonnet-4-6' } as AppSettings['models'],
        providerKeys: { openai: 'fake-shared-openai' },
        behindTheScenesModel: 'profile:codex-bts',
        localModel: {
          activeProfileId: null,
          profiles: [
            {
              id: 'codex-bts',
              name: 'Codex BTS',
              authSource: 'codex-subscription',
              providerType: 'openai',
              serverUrl: 'https://api.openai.com/v1',
              model: 'gpt-5.5',
              createdAt: 0,
            },
          ],
        },
      });
      return {
        settings,
        response: new Response(
          JSON.stringify({
            content: [
              {
                type: 'text',
                text: '{"estimate_minutes_low":1,"estimate_minutes_high":2,"confidence":"low"}',
              },
            ],
            model: 'gpt-5.5',
            usage: { input_tokens: 10, output_tokens: 5 },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
      };
    },
    assertWire: ({ url, body, headers }) => {
      expect(url).toBe('http://127.0.0.1:9999/v1/messages');
      expect(headers['x-codex-turn']).toBe('true');
      expect(headers['x-proxy-auth']).toBe('test-proxy-token');
      expect(headers['anthropic-beta']).toBe('structured-outputs-2025-11-13');
      expect(body.output_format).toEqual({ type: 'json_schema', schema: FIXTURE_SCHEMA });
      expect(body.temperature).toBe(0.2);
      expect(body.stream).toBe(false);
    },
  },

  'openrouter-proxy': {
    description:
      'OpenRouter routed through localhost proxy; output_format passes through unchanged on the Anthropic-shaped body.',
    setup: () => {
      registerBtsProxyProviders({ url: () => 'http://127.0.0.1:9999', auth: () => 'test-proxy-token' });
      vi.mocked(isUsingOpenRouter).mockReturnValue(true);
      vi.mocked(isDirectAnthropicConfig).mockReturnValue(false);
      const settings = setSettings({
        activeProvider: 'openrouter',
        openRouter: { enabled: true, oauthToken: 'fake-or-key', selectedModel: 'anthropic/claude-sonnet-4' },
        behindTheScenesModel: 'anthropic/claude-sonnet-4',
      });
      return { settings, response: makeAnthropicSuccess() };
    },
    assertWire: ({ url, body, headers }) => {
      expect(url).toBe('http://127.0.0.1:9999/v1/messages');
      expect(headers['x-openrouter-turn']).toBe('true');
      expect(headers['x-proxy-auth']).toBe('test-proxy-token');
      expect(headers['anthropic-beta']).toBe('structured-outputs-2025-11-13');
      expect(body.output_format).toEqual({ type: 'json_schema', schema: FIXTURE_SCHEMA });
      expect(body.temperature).toBe(0.2);
      expect(body.stream).toBe(false);
    },
  },

  'anthropic-compatible-local-proxy': {
    description:
      'Raw Anthropic passthrough through localhost proxy. BTS routing for `role=bts` never naturally selects this transport (Google profiles route to openai-compatible-http per providerRouting.ts:543), so a synthetic dispatch decision is injected via ProviderRouter.forBTS spy. The contract pinned: when this transport IS dispatched, the proxy-bound POST body preserves output_format/temperature byte-for-byte.',
    setup: (registerSpy) => {
      registerBtsProxyProviders({ url: () => 'http://127.0.0.1:9999', auth: () => 'test-proxy-token' });
      vi.mocked(hasValidAuth).mockReturnValue(true);
      vi.mocked(isDirectAnthropicConfig).mockReturnValue(true);
      const settings = setSettings({
        activeProvider: 'anthropic',
        models: { apiKey: 'fake-anthropic-key', model: 'claude-sonnet-4-6' } as AppSettings['models'],
        behindTheScenesModel: 'claude-sonnet-4-6',
      });
      registerSpy({
        kind: 'dispatchable',
        transport: 'anthropic-compatible-local-proxy',
        dispatchPath: 'local-proxy-passthrough',
        provider: 'profile',
        modelDialect: 'profile-ref',
        role: 'bts',
        routeScope: 'normal-turn',
        canonicalModelId: 'claude-sonnet-4-6',
        wireModelId: brandRouteWireModel('claude-sonnet-4-6'),
        profileId: null,
        resolvedFrom: 'settings',
        codexConnectivity: 'unknown',
        fallbackHint: null,
        credentialSource: 'profile-api-key',
        invalidReason: 'none',
      });
      return { settings, response: makeAnthropicSuccess() };
    },
    assertWire: ({ url, body, headers }) => {
      expect(url).toBe('http://127.0.0.1:9999/v1/messages');
      expect(headers['x-proxy-auth']).toBe('test-proxy-token');
      expect(headers['anthropic-beta']).toBe('structured-outputs-2025-11-13');
      expect(body.output_format).toEqual({ type: 'json_schema', schema: FIXTURE_SCHEMA });
      expect(body.temperature).toBe(0.2);
    },
  },

  'local-openai-compatible-http': {
    description:
      'Local OpenAI-compat profile (e.g. Ollama). Intentionally degraded to response_format=json_object for broad provider compatibility — schema enforcement requires per-provider gating that is out of scope. Updating this assertion requires deliberate review.',
    setup: () => {
      vi.mocked(hasValidAuth).mockReturnValue(false);
      vi.mocked(isDirectAnthropicConfig).mockReturnValue(false);
      const settings = setSettings({
        activeProvider: 'anthropic',
        models: { apiKey: null, model: 'claude-sonnet-4-6' } as AppSettings['models'],
        behindTheScenesModel: 'profile:local-llm',
        localModel: {
          activeProfileId: null,
          profiles: [
            {
              id: 'local-llm',
              name: 'Local LLM',
              providerType: 'local',
              serverUrl: 'http://127.0.0.1:11434/v1',
              model: 'llama-3.1-8b',
              createdAt: 0,
            },
          ],
        },
      });
      return { settings, response: makeOpenAICompatSuccess() };
    },
    assertWire: ({ url, body }) => {
      expect(typeof url === 'string' ? url : url.toString()).toContain('http://127.0.0.1:11434');
      expect(body.response_format).toEqual({ type: 'json_object' });
      expect(body.output_format).toBeUndefined();
      expect(body.temperature).toBe(0.2);
    },
  },

  'openai-compatible-http': {
    description:
      'OpenAI-compatible HTTP profile-direct (OpenAI, Together, etc.). Same intentionally degraded behavior as local-openai-compatible-http (json_object only), with first-party OpenAI reasoning-model sampling params stripped for Chat Completions.',
    setup: () => {
      vi.mocked(hasValidAuth).mockReturnValue(false);
      vi.mocked(isDirectAnthropicConfig).mockReturnValue(false);
      const settings = setSettings({
        activeProvider: 'anthropic',
        models: { apiKey: null, model: 'claude-sonnet-4-6' } as AppSettings['models'],
        providerKeys: { openai: 'fake-openai' },
        behindTheScenesModel: 'profile:openai-direct',
        localModel: {
          activeProfileId: null,
          profiles: [
            {
              id: 'openai-direct',
              name: 'OpenAI Direct',
              providerType: 'openai',
              serverUrl: 'https://api.openai.com/v1',
              model: 'gpt-5.5',
              createdAt: 0,
            },
          ],
        },
      });
      return { settings, response: makeOpenAICompatSuccess() };
    },
    assertWire: ({ url, body }) => {
      expect(typeof url === 'string' ? url : url.toString()).toContain('https://api.openai.com');
      expect(body.response_format).toEqual({ type: 'json_object' });
      expect(body.output_format).toBeUndefined();
      expect(body.temperature).toBeUndefined();
    },
  },
};

// ─── Driver — runs every contract through the same dispatch ────────────────

describe('BTS transport contract parity for output_format / temperature', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(hasValidAuth).mockReturnValue(false);
    vi.mocked(isDirectAnthropicConfig).mockReturnValue(true);
    vi.mocked(isUsingOpenRouter).mockReturnValue(false);
    fetchSpy = vi.spyOn(globalThis, 'fetch');
    declareNoBtsProxy();
  });

  afterEach(() => {
    fetchSpy.mockRestore();
    vi.restoreAllMocks();
  });

  for (const [transport, contract] of Object.entries(TRANSPORT_CONTRACTS) as Array<
    [DispatchableTransport, TransportContract]
  >) {
    it(`${transport}: ${contract.description}`, async () => {
      let forBtsSpy: ReturnType<typeof vi.spyOn> | undefined;
      const registerSpy = (decision: DispatchableRouteDecision) => {
        forBtsSpy = vi.spyOn(ProviderRouter, 'forBTS').mockReturnValueOnce(decision);
      };

      const { settings, response } = contract.setup(registerSpy);
      fetchSpy.mockResolvedValueOnce(response);

      try {
        await callBehindTheScenesWithAuth(
          settings,
          { ...FIXTURE_OPTIONS, codexConnectivity: 'connected' },
          { category: 'timeSaved' },
        );
      } finally {
        forBtsSpy?.mockRestore();
      }

      expect(fetchSpy).toHaveBeenCalledOnce();
      const [url, init] = fetchSpy.mock.calls[0];
      const body = JSON.parse(init?.body as string) as Record<string, unknown>;
      const headers = (init?.headers as Record<string, string>) ?? {};

      contract.assertWire({ url, body, headers });
    });
  }

  // Compile-time exhaustiveness: TypeScript fails if a future
  // DispatchableTransport is added without a TRANSPORT_CONTRACTS entry.
  it('compile-time exhaustiveness — every DispatchableTransport has a contract entry', () => {
    const _exhaustive: Record<DispatchableTransport, TransportContract> = TRANSPORT_CONTRACTS;
    expect(Object.keys(_exhaustive).length).toBeGreaterThanOrEqual(6);
  });

  // ─── Strict-mode propagation (Item 2 follow-up) ───────────────────────────
  // BehindTheScenesRequestOptions.outputFormat now exposes `strict?` and
  // `name?`. Verify they reach the wire on the codex-proxy path (the user-
  // visible repro path); the proxy-side translator is covered by
  // localModelProxyServer.codexSubscription.test.ts.
  it('codex-proxy: forwards optional name and strict on output_format when callers opt in', async () => {
    const { settings, response } = TRANSPORT_CONTRACTS['codex-proxy'].setup(() => {});
    fetchSpy.mockResolvedValueOnce(response);

    await callBehindTheScenesWithAuth(
      settings,
      {
        ...FIXTURE_OPTIONS,
        outputFormat: {
          type: 'json_schema',
          schema: FIXTURE_SCHEMA,
          name: 'time_saved_estimate',
          strict: true,
        },
        codexConnectivity: 'connected',
      },
      { category: 'timeSaved' },
    );

    expect(fetchSpy).toHaveBeenCalledOnce();
    const [, init] = fetchSpy.mock.calls[0];
    const body = JSON.parse(init?.body as string) as Record<string, unknown>;
    expect(body.output_format).toEqual({
      type: 'json_schema',
      schema: FIXTURE_SCHEMA,
      name: 'time_saved_estimate',
      strict: true,
    });
  });

  it('openai-compatible-http: strips temperature for OpenAI reasoning models and preserves it for non-reasoning models', async () => {
    for (const fixture of [
      { model: 'gpt-5.5', reasoningEffort: undefined, expectedTemperature: undefined },
      { model: 'gpt-4.1', reasoningEffort: 'high' as const, expectedTemperature: 0.2 },
    ]) {
      const settings = setSettings({
        activeProvider: 'anthropic',
        models: { apiKey: null, model: 'claude-sonnet-4-6' } as AppSettings['models'],
        providerKeys: { openai: 'fake-openai' },
        behindTheScenesModel: 'profile:openai-direct',
        localModel: {
          activeProfileId: null,
          profiles: [
            {
              id: 'openai-direct',
              name: 'OpenAI Direct',
              providerType: 'openai',
              serverUrl: 'https://api.openai.com/v1',
              model: fixture.model,
              reasoningEffort: fixture.reasoningEffort,
              createdAt: 0,
            },
          ],
        },
      });
      fetchSpy.mockResolvedValueOnce(makeOpenAICompatSuccess());

      await callBehindTheScenesWithAuth(
        settings,
        {
          codexConnectivity: 'unknown', messages: FIXTURE_OPTIONS.messages, temperature: 0.2 },
        { category: 'timeSaved' },
      );

      const [, init] = fetchSpy.mock.calls.at(-1)!;
      const body = JSON.parse(init?.body as string) as Record<string, unknown>;
      expect(body.model).toBe(fixture.model);
      expect(body.temperature).toBe(fixture.expectedTemperature);
      expect(body.reasoning_effort).toBeUndefined();
    }
  });
});
