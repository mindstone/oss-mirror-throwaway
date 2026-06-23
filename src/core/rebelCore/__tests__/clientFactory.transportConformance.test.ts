import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import type { AppSettings } from '@shared/types';

/**
 * CHARACTERIZATION tests — per-transport client construction (260622 turn-hang
 * follow-ups, Stage 2).
 *
 * These pin CURRENT behaviour (NOT desired behaviour) for the three transports
 * that all construct `AnthropicClient` via `clientFactory.ts`:
 * `anthropic-direct`, `codex-proxy`, `openrouter-proxy`. They are the safety net
 * the deferred transport-hygiene rebuild (workstream "C" / DIRECTION #13 / ADR
 * `260622_provider-transport-and-error-architecture.md`) must not silently break.
 * If any value here changes, that is a VISIBLE test diff for the rebuild to own.
 *
 * Pinned invariants:
 *   (a) client class chosen per transport;
 *   (b) the TWO-LAYER retry structure, stated precisely:
 *         - codex-proxy passes SDK config `maxRetries: 0` (clientFactory.ts:408 —
 *           subscription-tier rate limits; SDK retries just amplify load);
 *         - anthropic-direct + openrouter-proxy pass NO SDK `maxRetries`
 *           (undefined → the Anthropic SDK's own default; `AnthropicClient` only
 *           forwards `config.maxRetries` to the SDK when defined,
 *           anthropicClient.ts:~1137);
 *         - SEPARATELY, Rebel's `AnthropicClient` wrapper has its own app-level
 *           `MAX_RETRIES = 3` retry loop (anthropicClient.ts:81 / :1203) — a
 *           DISTINCT layer from the SDK-config retries. We deliberately do NOT
 *           assert the SDK constructor `maxRetries === 3` (it would be red: the
 *           SDK default is not 3 and is not forwarded). The wrapper layer is
 *           pinned structurally (the exported `MAX_RETRIES` constant).
 *   (c) sentinel proxy-auth key (PROXY_HANDLES_AUTH_SENTINEL) vs the real
 *       Anthropic key;
 *   (d) the ABSENCE of a Rebel-owned first-byte / stream-idle timeout on the
 *       Anthropic-SDK construction surface today — contrast `OpenAIClient`'s
 *       explicit first-chunk (5min) + idle (90s) + late-reasoning (30s) deadlines
 *       (openaiClient.ts:~92,93,106). A future add of such a deadline on the
 *       Anthropic path becomes a visible test change here.
 *
 * Mocking style mirrors `clientFactory.routePlan.test.ts`: capture the client
 * constructor config via vi.hoisted capturing classes and drive the real route
 * resolver. The (d) absence assertion inspects the captured construction surface
 * only — it NEVER spawns a hanging promise / real fetch.
 */

const clientMocks = vi.hoisted(() => {
  class CapturedAnthropicClient {
    readonly __clientKind = 'anthropic' as const;
    constructor(readonly config: Record<string, unknown>) {}
  }
  class CapturedOpenAIClient {
    readonly __clientKind = 'openai' as const;
    constructor(readonly config: Record<string, unknown>) {}
  }
  return { CapturedAnthropicClient, CapturedOpenAIClient };
});

vi.mock('../clients/anthropicClient', () => ({
  AnthropicClient: clientMocks.CapturedAnthropicClient,
}));

vi.mock('../clients/openaiClient', () => ({
  OpenAIClient: clientMocks.CapturedOpenAIClient,
}));

import { createClientFromRoutePlan } from '../clientFactory';
import { PROXY_HANDLES_AUTH_SENTINEL } from '../proxyAuthContract';
import type { ProviderRouteRuntimeContext } from '../providerRoutePlan';
import { resolveProviderRoutePlan, type ProviderRoutePlanRequest } from '../providerRouting';
import { isTerminalRoutePlan, type DispatchableRoutePlan } from '../providerRoutePlanTypes';

const PROXY_BASE_URL = 'http://127.0.0.1:48999';

// Construction-surface keys that, if present on an AnthropicClient config, would
// indicate a Rebel-owned first-byte / stream-idle / finish deadline had been
// wired onto the Anthropic-SDK path (the contrast with OpenAIClient). Their
// ABSENCE today is the characterized fact.
const REBEL_OWNED_TIMEOUT_CONFIG_KEYS = [
  'firstChunkTimeoutMs',
  'firstByteTimeoutMs',
  'streamIdleTimeoutMs',
  'idleTimeoutMs',
  'finishDeadlineMs',
  'timeoutMs',
  'streamFirstChunkTimeoutMs',
] as const;

function modelSettings(
  overrides: Partial<NonNullable<AppSettings['models']>> = {},
): NonNullable<AppSettings['models']> {
  return {
    apiKey: 'anthropic-test-key',
    oauthToken: null,
    authMethod: 'api-key',
    model: 'claude-sonnet-4-20250514',
    permissionMode: 'plan',
    executablePath: null,
    planMode: true,
    extendedContext: false,
    thinkingEffort: 'high',
    ...overrides,
  };
}

function settings(overrides: Partial<AppSettings> = {}): AppSettings {
  const models = modelSettings(overrides.models);
  return {
    coreDirectory: null,
    mcpConfigFile: null,
    onboardingCompleted: true,
    userEmail: null,
    onboardingFirstCompletedAt: null,
    voice: { enabled: false },
    models,
    diagnostics: { debugBreadcrumbsUntil: null },
    openRouter: {
      enabled: overrides.activeProvider === 'openrouter' || overrides.activeProvider === 'mindstone',
      oauthToken: null,
      selectedModel: 'anthropic/claude-sonnet-4.6',
      ...overrides.openRouter,
    },
    activeProvider: overrides.activeProvider ?? 'anthropic',
    localModel: overrides.localModel ?? { activeProfileId: null, profiles: [] },
    providerKeys: overrides.providerKeys ?? {},
    customProviders: overrides.customProviders,
    experimental: overrides.experimental,
  } as unknown as AppSettings;
}

async function dispatchablePlan(
  request: ProviderRoutePlanRequest,
  runtimeContext: ProviderRouteRuntimeContext = {},
): Promise<DispatchableRoutePlan> {
  const plan = await resolveProviderRoutePlan(request, runtimeContext);
  if (isTerminalRoutePlan(plan)) {
    throw new Error(`Expected dispatchable plan, got ${plan.decision.invalidReason}`);
  }
  return plan;
}

function expectAnthropic(client: unknown): InstanceType<typeof clientMocks.CapturedAnthropicClient> {
  expect(client).toBeInstanceOf(clientMocks.CapturedAnthropicClient);
  if (!(client instanceof clientMocks.CapturedAnthropicClient)) {
    throw new Error('Expected captured Anthropic client');
  }
  return client;
}

describe('per-transport client construction (CHARACTERIZATION — current behaviour)', () => {
  it('characterization: anthropic-direct constructs AnthropicClient with the REAL key, NO SDK maxRetries, and no Rebel-owned timeout on the construction surface', async () => {
    const appSettings = settings(); // carries a real Anthropic key
    const plan = await dispatchablePlan({
      kind: 'forSubagent',
      input: {
        settings: appSettings,
        model: 'claude-sonnet-4-20250514',
        codexConnectivity: 'unknown',
      },
    });

    expect(plan.decision.transport).toBe('anthropic-direct');
    const client = expectAnthropic(createClientFromRoutePlan(plan, appSettings));

    // (a) client class: AnthropicClient.
    expect(client.__clientKind).toBe('anthropic');
    // (c) real Anthropic key — NOT the proxy sentinel.
    expect(client.config.apiKey).toBe('anthropic-test-key');
    expect(client.config.apiKey).not.toBe(PROXY_HANDLES_AUTH_SENTINEL);
    // (b) SDK-config retries: NONE passed → SDK default (AnthropicClient only
    // forwards config.maxRetries when defined). We deliberately do NOT assert
    // an SDK constructor value of 3.
    expect(client.config.maxRetries).toBeUndefined();
    // (d) no Rebel-owned first-byte/idle/finish deadline on the construction surface.
    for (const key of REBEL_OWNED_TIMEOUT_CONFIG_KEYS) {
      expect(client.config).not.toHaveProperty(key);
    }
  });

  it('characterization: codex-proxy constructs AnthropicClient via the proxy sentinel with SDK maxRetries:0 (and no Rebel-owned timeout)', async () => {
    const appSettings = settings({
      activeProvider: 'codex',
      claude: modelSettings({ apiKey: null }),
    } as Partial<AppSettings>);
    const plan = await dispatchablePlan({
      kind: 'forSubagent',
      input: {
        settings: appSettings,
        model: 'gpt-5.5',
        codexConnectivity: 'connected',
      },
    }, { proxyBaseURL: PROXY_BASE_URL, proxyAuthToken: 'proxy-token' });

    expect(plan.decision.transport).toBe('codex-proxy');
    const client = expectAnthropic(createClientFromRoutePlan(plan, appSettings));

    // (a) client class: AnthropicClient (codex traffic speaks the Anthropic
    // Messages format through the local proxy).
    expect(client.__clientKind).toBe('anthropic');
    expect(client.config.baseURL).toBe(PROXY_BASE_URL);
    // (c) sentinel proxy-auth key (proxy injects the real upstream credential).
    expect(client.config.apiKey).toBe(PROXY_HANDLES_AUTH_SENTINEL);
    expect(client.config.defaultHeaders).toMatchObject({ 'x-codex-turn': 'true' });
    // (b) SDK-config retries DISABLED for codex (clientFactory.ts:408).
    expect(client.config.maxRetries).toBe(0);
    // (d) no Rebel-owned first-byte/idle/finish deadline on the construction surface.
    for (const key of REBEL_OWNED_TIMEOUT_CONFIG_KEYS) {
      expect(client.config).not.toHaveProperty(key);
    }
  });

  it('characterization: openrouter-proxy constructs AnthropicClient via the proxy sentinel with NO SDK maxRetries (and no Rebel-owned timeout)', async () => {
    const appSettings = settings({
      activeProvider: 'openrouter',
      claude: modelSettings({ apiKey: null }),
      openRouter: {
        enabled: true,
        oauthToken: 'openrouter-test-token',
        selectedModel: 'anthropic/claude-opus-4.7',
      },
    } as Partial<AppSettings>);
    const plan = await dispatchablePlan({
      kind: 'forSubagent',
      input: {
        settings: appSettings,
        model: 'anthropic/claude-opus-4.7',
        codexConnectivity: 'unknown',
      },
    }, { proxyBaseURL: PROXY_BASE_URL, proxyAuthToken: 'proxy-token' });

    expect(plan.decision.transport).toBe('openrouter-proxy');
    const client = expectAnthropic(createClientFromRoutePlan(plan, appSettings));

    // (a) client class: AnthropicClient (OpenRouter Anthropic-passthrough).
    expect(client.__clientKind).toBe('anthropic');
    expect(client.config.baseURL).toBe(PROXY_BASE_URL);
    // (c) sentinel proxy-auth key.
    expect(client.config.apiKey).toBe(PROXY_HANDLES_AUTH_SENTINEL);
    expect(client.config.defaultHeaders).toMatchObject({ 'x-openrouter-turn': 'true' });
    expect(client.config.provider).toBe('OpenRouter');
    // (b) NO SDK-config maxRetries (unlike codex) → SDK default. The codex `:0`
    // injection is gated on isCodexProxy only.
    expect(client.config.maxRetries).toBeUndefined();
    // (d) no Rebel-owned first-byte/idle/finish deadline on the construction surface.
    for (const key of REBEL_OWNED_TIMEOUT_CONFIG_KEYS) {
      expect(client.config).not.toHaveProperty(key);
    }
  });

  it('characterization: the Rebel-wrapper app-level retry layer (MAX_RETRIES = 3) is a DISTINCT layer from any SDK-config maxRetries', () => {
    // This pins the SECOND retry layer. `AnthropicClient.runWithRetry` loops up
    // to a module-private `MAX_RETRIES` (anthropicClient.ts) on transient errors —
    // independent of the SDK constructor `maxRetries` asserted above. The two are
    // NOT the same number and NOT the same mechanism; characterizing them as ONE
    // layer (the original "3 vs 0" framing) was wrong (GPT F2). `MAX_RETRIES` is
    // module-private (not exported — adding a production export just to test it
    // would be a behaviour-adjacent change tripping the export gates), so we pin
    // its value by reading the source constant. A rebuild that changes the layer
    // makes this a visible test diff.
    const src = readFileSync(
      fileURLToPath(new URL('../clients/anthropicClient.ts', import.meta.url)),
      'utf8',
    );
    expect(src).toMatch(/^const MAX_RETRIES = 3;$/m);
  });
});
