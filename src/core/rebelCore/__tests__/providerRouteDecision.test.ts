import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { AppSettings, ModelProfile } from '@shared/types';
import { brandRouteWireModel } from '@shared/utils/wireModelId';
import { assertNever } from '@shared/utils/assertNever';
import {
  ConnectionNotConfiguredError,
  UnsupportedModelError,
} from '@shared/utils/connectionCredentials';
import {
  DISPATCHABLE_TRANSPORT_BY_PROVIDER_AND_DIALECT,
  DISPATCH_PATHS,
  MalformedRouteDecisionError,
  assertDispatchableRoutePlan,
  buildRecoverableTerminalRouteError,
  buildTerminalReconnectMessage,
  deriveDispatchPath,
  isRecoverableTerminalReason,
  isDirectDispatch,
  isProxyDispatch,
  isRouteTableDispatch,
  NonDispatchableRoutePlanError,
  validateRouteDecisionShape,
  type DispatchableDispatchPath,
  type DispatchableTransport,
  type ProviderRouteDecision,
  type ProviderRouteInvalidReason,
  type ProviderRouteRole,
  type ProviderRouteScope,
  type ProviderRouteTransport,
  type TerminalRouteDecision,
  type TerminalTransport,
} from '../providerRouteDecision';
import * as providerRouteDecisionModule from '../providerRouteDecision';
import {
  isNativeAnthropicModel,
  resolveDirectAnthropicModel,
} from '../providerRouteDecision';
import { ProviderRouter } from '../providerRouting';
import { ensureDirectAnthropicCapable } from '../ensureDirectAnthropicCapable';

const dirname = path.dirname(fileURLToPath(import.meta.url));
const providerRouteFixtureRoot = path.join(dirname, 'fixtures', 'providerRoutePlan');

const ALL_TRANSPORTS: readonly ProviderRouteTransport[] = [
  'anthropic-direct',
  'anthropic-compatible-local-proxy',
  'openai-compatible-http',
  'local-openai-compatible-http',
  'codex-proxy',
  'openrouter-proxy',
  'no-credentials',
  'fail-closed-codex-disconnected',
];

const ALL_SCOPES: readonly ProviderRouteScope[] = [
  'normal-turn',
  'council',
  'ad-hoc',
  'retry',
  'fallback',
  'eval',
];

const EXPECTED_DISPATCH_PATH_BY_TRANSPORT: Readonly<Record<ProviderRouteTransport, {
  defaultPath: 'direct-provider' | 'local-proxy-passthrough' | 'none';
  routeTablePath?: 'local-proxy-route-table';
}>> = {
  'anthropic-direct': { defaultPath: 'direct-provider' },
  'anthropic-compatible-local-proxy': { defaultPath: 'local-proxy-passthrough', routeTablePath: 'local-proxy-route-table' },
  'openai-compatible-http': { defaultPath: 'direct-provider' },
  'local-openai-compatible-http': { defaultPath: 'direct-provider' },
  'codex-proxy': { defaultPath: 'local-proxy-passthrough' },
  'openrouter-proxy': { defaultPath: 'local-proxy-passthrough' },
  'no-credentials': { defaultPath: 'none' },
  'fail-closed-codex-disconnected': { defaultPath: 'none' },
};

const EXPECTED_DISPATCHABLE_TRANSPORT_BY_PROVIDER_AND_DIALECT = {
  anthropic: { 'anthropic-native': 'anthropic-direct' },
  openrouter: {
    'anthropic-native': 'openrouter-proxy',
    'openrouter-prefixed': 'openrouter-proxy',
    'openai-compatible': 'openrouter-proxy',
  },
  codex: { 'anthropic-native': 'anthropic-direct', 'openai-compatible': 'codex-proxy' },
  local: { 'local-openai-compatible': 'local-openai-compatible-http' },
} as const;

function expectedDispatchPath(transport: ProviderRouteTransport, routeScope: ProviderRouteScope) {
  const mapped = EXPECTED_DISPATCH_PATH_BY_TRANSPORT[transport];
  if (mapped.routeTablePath && (routeScope === 'council' || routeScope === 'ad-hoc')) {
    return mapped.routeTablePath;
  }
  return mapped.defaultPath;
}

function isTerminalTransport(transport: ProviderRouteTransport): transport is TerminalTransport {
  return transport === 'no-credentials' || transport === 'fail-closed-codex-disconnected';
}

function deriveDispatchableTestPath(
  transport: DispatchableTransport,
  routeScope: ProviderRouteScope,
): DispatchableDispatchPath {
  const dispatchPath = deriveDispatchPath(transport, routeScope);
  if (dispatchPath === 'none') {
    throw new Error(`Unexpected terminal dispatchPath for ${transport}`);
  }
  return dispatchPath;
}

function makeDecision(
  transport: ProviderRouteTransport,
  routeScope: ProviderRouteScope,
  role: ProviderRouteRole = 'execution',
): ProviderRouteDecision {
  const base = {
    provider: transport === 'openrouter-proxy' ? 'openrouter' : transport === 'codex-proxy' ? 'codex' : 'anthropic',
    modelDialect: 'anthropic-native',
    role,
    routeScope,
    canonicalModelId: 'claude-sonnet-4-6',
    wireModelId: brandRouteWireModel('claude-sonnet-4-6'),
    profileId: null,
    resolvedFrom: 'settings',
    codexConnectivity: 'unknown',
    fallbackHint: null,
    credentialSource: 'anthropic-api-key',
  } as const;

  if (isTerminalTransport(transport)) {
    return {
      ...base,
      kind: 'terminal',
      transport,
      dispatchPath: 'none',
      credentialSource: 'missing-anthropic',
      invalidReason: 'missing-anthropic-credentials',
    };
  }

  return {
    ...base,
    kind: 'dispatchable',
    transport: transport satisfies DispatchableTransport,
    dispatchPath: deriveDispatchableTestPath(transport, routeScope),
    routedModel: routeScope === 'council' || routeScope === 'ad-hoc' ? 'routed-model' : null,
    invalidReason: 'none',
  };
}

function settings(overrides: {
  activeProvider?: 'anthropic' | 'openrouter' | 'codex';
  claudeApiKey?: string | null;
  claudeOAuthToken?: string | null;
  claudeAuthMethod?: 'api-key' | 'oauth-token';
  claudeModel?: string;
  openRouterToken?: string | null;
  openRouterSelectedModel?: string;
  profiles?: ModelProfile[];
  activeProfileId?: string | null;
  providerKeys?: Record<string, string>;
} = {}): AppSettings {
  const hasOverride = (key: keyof typeof overrides): boolean =>
    Object.hasOwn(overrides, key);

  return {
    activeProvider: overrides.activeProvider ?? 'anthropic',
    models: {
      apiKey: hasOverride('claudeApiKey') ? (overrides.claudeApiKey ?? null) : 'fake-ant-test',
      oauthToken: hasOverride('claudeOAuthToken') ? (overrides.claudeOAuthToken ?? null) : null,
      authMethod: hasOverride('claudeAuthMethod') ? (overrides.claudeAuthMethod ?? 'api-key') : 'api-key',
      model: hasOverride('claudeModel') ? (overrides.claudeModel ?? 'claude-sonnet-4-6') : 'claude-sonnet-4-6',
    },
    openRouter: {
      enabled: (overrides.activeProvider ?? 'anthropic') === 'openrouter',
      oauthToken: overrides.openRouterToken ?? null,
      selectedModel: overrides.openRouterSelectedModel ?? 'anthropic/claude-sonnet-4-6',
    },
    localModel: {
      activeProfileId: overrides.activeProfileId ?? null,
      profiles: overrides.profiles ?? [],
    },
    providerKeys: overrides.providerKeys ?? {},
  } as AppSettings;
}

function buildProfile(overrides: Partial<ModelProfile> = {}): ModelProfile {
  return {
    id: overrides.id ?? 'test-profile',
    name: overrides.name ?? 'Test profile',
    providerType: overrides.providerType ?? 'openai',
    serverUrl: overrides.serverUrl ?? 'https://api.openai.com/v1',
    model: overrides.model ?? 'gpt-5.5',
    apiKey: overrides.apiKey ?? 'profile-key',
    createdAt: overrides.createdAt ?? 1,
    ...(overrides.authSource ? { authSource: overrides.authSource } : {}),
    ...(overrides.routeSurface ? { routeSurface: overrides.routeSurface } : {}),
    ...(overrides.customProviderId ? { customProviderId: overrides.customProviderId } : {}),
  };
}

function loadFixtureDecisions(): ProviderRouteDecision[] {
  const decisions: ProviderRouteDecision[] = [];
  const kinds = ['forTurn', 'forBTS', 'forSubagent'] as const;
  for (const kind of kinds) {
    const fixtureDir = path.join(providerRouteFixtureRoot, kind);
    const fixtureFileNames = fs.readdirSync(fixtureDir)
      .filter((fileName) => fileName.endsWith('.json'))
      .sort((left, right) => left.localeCompare(right));
    for (const fixtureFileName of fixtureFileNames) {
      const fixture = JSON.parse(
        fs.readFileSync(path.join(fixtureDir, fixtureFileName), 'utf8'),
      ) as { input: Record<string, unknown> };
      const normalizedInput = structuredClone(fixture.input) as Record<string, unknown>;
      const maybeSettings = normalizedInput.settings;
      if (typeof maybeSettings === 'object' && maybeSettings !== null && !Array.isArray(maybeSettings)) {
        const settingsRecord = maybeSettings as Record<string, unknown>;
        if (settingsRecord.activeProvider === null) {
          delete settingsRecord.activeProvider;
        }
      }
      switch (kind) {
        case 'forTurn':
          decisions.push(
            ProviderRouter.forTurn(
              normalizedInput as unknown as Parameters<typeof ProviderRouter.forTurn>[0],
            ),
          );
          break;
        case 'forBTS':
          decisions.push(
            ProviderRouter.forBTS(
              normalizedInput as unknown as Parameters<typeof ProviderRouter.forBTS>[0],
            ),
          );
          break;
        case 'forSubagent':
          decisions.push(
            ProviderRouter.forSubagent(
              normalizedInput as unknown as Parameters<typeof ProviderRouter.forSubagent>[0],
            ),
          );
          break;
        default:
          throw new Error(`Unhandled fixture kind: ${kind as never}`);
      }
    }
  }
  return decisions;
}

function googleProfile(overrides: Partial<ModelProfile> = {}): ModelProfile {
  return buildProfile({
    id: 'google-profile',
    name: 'Google profile',
    providerType: 'google',
    serverUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    model: 'gemini-2.5-pro',
    apiKey: 'google-api-key',
    ...overrides,
  });
}

// Keyed by reason so the compiler forces this list to stay exhaustive: adding a new
// ProviderRouteInvalidReason without a key here is a type error (this is what caught
// the missing 'missing-mindstone-credentials' arm during the fix).
const ALL_TERMINAL_INVALID_REASONS_PRESENCE: Record<ProviderRouteInvalidReason, true> = {
  'missing-anthropic-credentials': true,
  'missing-anthropic-credentials-for-claude-model': true,
  'missing-openrouter-credentials': true,
  'missing-mindstone-credentials': true,
  'missing-codex-connection': true,
  'missing-profile-credentials': true,
  'codex-disconnected-bts-blocked': true,
  'codex-unsupported-model': true,
  'proxy-dialect-in-direct-anthropic': true,
};
const ALL_TERMINAL_INVALID_REASONS = Object.keys(
  ALL_TERMINAL_INVALID_REASONS_PRESENCE,
) as ProviderRouteInvalidReason[];

const TERMINAL_RECONNECT_EXPECTATIONS: ReadonlyArray<{
  reason: Exclude<ProviderRouteInvalidReason, 'proxy-dialect-in-direct-anthropic'>;
  provider: string;
  message: string;
}> = [
  {
    reason: 'missing-anthropic-credentials',
    provider: 'Anthropic',
    message: 'Anthropic needs an API key. Add it in Settings to continue.',
  },
  {
    reason: 'missing-anthropic-credentials-for-claude-model',
    provider: 'ChatGPT Pro',
    // wireModelId on the fixture decision is 'claude-sonnet-4-6' (see makeTerminalDecisionForReason default).
    message:
      "You're connected to ChatGPT Pro, but the selected model — claude-sonnet-4-6 — runs on Anthropic, which isn't connected. Your message is safe.",
  },
  {
    reason: 'missing-openrouter-credentials',
    provider: 'OpenRouter',
    message: 'OpenRouter needs reconnecting. Sign in again in Settings to continue.',
  },
  {
    reason: 'missing-mindstone-credentials',
    provider: 'Mindstone',
    message: "Your Mindstone subscription isn't ready yet. Open subscription settings, then try again.",
  },
  {
    reason: 'missing-codex-connection',
    provider: 'ChatGPT Pro',
    message: 'ChatGPT Pro needs reconnecting. Sign in again in Settings to continue.',
  },
  {
    reason: 'missing-profile-credentials',
    provider: 'Profile',
    message: 'This profile is missing a working API key. Add or update it in Settings to continue.',
  },
  {
    reason: 'codex-disconnected-bts-blocked',
    provider: 'ChatGPT Pro',
    message: 'ChatGPT Pro needs reconnecting. Sign in again in Settings to continue.',
  },
  {
    reason: 'codex-unsupported-model',
    provider: 'ChatGPT Pro',
    message: 'ChatGPT Pro doesn\'t support gpt-5.5-pro. Pick a different model in Settings.',
  },
];

function makeTerminalDecisionForReason(
  invalidReason: ProviderRouteInvalidReason,
  wireModelId = 'claude-sonnet-4-6',
): TerminalRouteDecision {
  const base = {
    kind: 'terminal',
    dispatchPath: 'none',
    role: 'execution',
    routeScope: 'normal-turn',
    canonicalModelId: wireModelId,
    wireModelId: brandRouteWireModel(wireModelId),
    profileId: null,
    resolvedFrom: 'settings',
    codexConnectivity: 'unknown',
    fallbackHint: null,
  } as const;

  switch (invalidReason) {
    case 'missing-anthropic-credentials':
    case 'missing-anthropic-credentials-for-claude-model':
      return {
        ...base,
        provider: 'anthropic',
        transport: 'no-credentials',
        modelDialect: 'anthropic-native',
        credentialSource: 'missing-anthropic',
        invalidReason,
      };
    case 'missing-openrouter-credentials':
      return {
        ...base,
        provider: 'openrouter',
        transport: 'no-credentials',
        modelDialect: 'openrouter-prefixed',
        credentialSource: 'missing-openrouter',
        invalidReason,
      };
    case 'missing-mindstone-credentials':
      return {
        ...base,
        provider: 'openrouter',
        transport: 'no-credentials',
        modelDialect: 'openrouter-prefixed',
        credentialSource: 'missing-mindstone',
        invalidReason,
      };
    case 'missing-codex-connection':
      return {
        ...base,
        provider: 'codex',
        transport: 'no-credentials',
        modelDialect: 'openai-compatible',
        credentialSource: 'missing-codex',
        invalidReason,
      };
    case 'missing-profile-credentials':
      return {
        ...base,
        provider: 'profile',
        transport: 'no-credentials',
        modelDialect: 'profile-ref',
        profileId: 'profile-missing-key',
        credentialSource: 'missing-profile',
        invalidReason,
      };
    case 'codex-disconnected-bts-blocked':
      return {
        ...base,
        provider: 'codex',
        transport: 'fail-closed-codex-disconnected',
        modelDialect: 'openai-compatible',
        credentialSource: 'missing-codex',
        invalidReason,
      };
    case 'codex-unsupported-model':
      return {
        ...base,
        provider: 'codex',
        transport: 'no-credentials',
        modelDialect: 'openai-compatible',
        credentialSource: 'missing-codex',
        invalidReason,
      };
    case 'proxy-dialect-in-direct-anthropic':
      return {
        ...base,
        provider: 'anthropic',
        transport: 'no-credentials',
        modelDialect: 'openrouter-prefixed',
        credentialSource: 'anthropic-api-key',
        invalidReason,
      };
    default:
      return assertNever(invalidReason, 'ProviderRouteInvalidReason in makeTerminalDecisionForReason');
  }
}

describe('providerRouteDecision dispatchPath contracts', () => {
  it('F0 locks provider/dialect transport table values to the migrated routeDecision literals', () => {
    expect(DISPATCHABLE_TRANSPORT_BY_PROVIDER_AND_DIALECT).toEqual(
      EXPECTED_DISPATCHABLE_TRANSPORT_BY_PROVIDER_AND_DIALECT,
    );
  });

  it.each(
    ALL_TRANSPORTS.flatMap((transport) => ALL_SCOPES.map((routeScope) => ({
      transport,
      routeScope,
      expectedDispatchPath: expectedDispatchPath(transport, routeScope),
    }))),
  )('F1 $transport / $routeScope => $expectedDispatchPath', ({ transport, routeScope, expectedDispatchPath }) => {
    expect(deriveDispatchPath(transport, routeScope)).toBe(expectedDispatchPath);
  });

  it('F2 populates dispatchPath for all ProviderRouteRole constructors', () => {
    const turnDecision = ProviderRouter.forTurn({
      codexConnectivity: 'unknown', settings: settings(), model: 'claude-sonnet-4-6', role: 'execution' });
    const planningDecision = ProviderRouter.forTurn({
      codexConnectivity: 'unknown', settings: settings(), model: 'claude-sonnet-4-6', role: 'planning' });
    const btsDecision = ProviderRouter.forBTS({
      codexConnectivity: 'unknown', settings: settings(), model: 'claude-haiku-4-5' });
    const subagentDecision = ProviderRouter.forSubagent({
      codexConnectivity: 'unknown', settings: settings(), model: 'claude-sonnet-4-6', routeScope: 'normal-turn' });

    for (const decision of [turnDecision, planningDecision, btsDecision, subagentDecision]) {
      expect(DISPATCH_PATHS).toContain(decision.dispatchPath);
    }
  });

  it.each(
    ALL_TRANSPORTS.flatMap((transport) => ALL_SCOPES.map((routeScope) => ({
      transport,
      routeScope,
      expectedKind: isTerminalTransport(transport) ? 'terminal' : 'dispatchable',
    }))),
  )('R1 $transport / $routeScope => kind=$expectedKind', ({ transport, routeScope, expectedKind }) => {
    const decision = makeDecision(transport, routeScope);
    expect(decision.kind).toBe(expectedKind);
  });

  it.each(ALL_TRANSPORTS)(
    'R2 forTurn transport matrix sets kind for %s',
    (transport) => {
      const decision = makeDecision(transport, 'normal-turn', 'execution');
      expect(['dispatchable', 'terminal']).toContain(decision.kind);
    },
  );

  it.each(ALL_TRANSPORTS)(
    'R3 forBTS transport matrix sets kind for %s',
    (transport) => {
      const decision = makeDecision(transport, 'normal-turn', 'bts');
      expect(['dispatchable', 'terminal']).toContain(decision.kind);
    },
  );

  it.each(ALL_TRANSPORTS)(
    'R4 forSubagent transport matrix sets kind for %s',
    (transport) => {
      const decision = makeDecision(transport, 'normal-turn', 'subagent');
      expect(['dispatchable', 'terminal']).toContain(decision.kind);
    },
  );

  it('R5 forSubagent council + valid credentials routes through local route table', () => {
    const decision = ProviderRouter.forSubagent({
      codexConnectivity: 'unknown',
      settings: settings(),
      model: 'claude-sonnet-4-6',
      routeScope: 'council',
      routedModel: 'claude-sonnet-4-6',
    });
    expect(decision.kind).toBe('dispatchable');
    expect(decision.dispatchPath).toBe('local-proxy-route-table');
    expect(decision.transport).toBe('anthropic-compatible-local-proxy');
  });

  it('R6 forSubagent ad-hoc + valid credentials routes through local route table', () => {
    const decision = ProviderRouter.forSubagent({
      codexConnectivity: 'unknown',
      settings: settings(),
      model: 'claude-sonnet-4-6',
      routeScope: 'ad-hoc',
      routedModel: 'claude-sonnet-4-6',
    });
    expect(decision.kind).toBe('dispatchable');
    expect(decision.dispatchPath).toBe('local-proxy-route-table');
    expect(decision.transport).toBe('anthropic-compatible-local-proxy');
  });

  it('R7 forSubagent council + missing credentials stays terminal', () => {
    const decision = ProviderRouter.forSubagent({
      codexConnectivity: 'unknown',
      settings: settings({ claudeApiKey: null, claudeOAuthToken: null }),
      model: 'claude-sonnet-4-6',
      routeScope: 'council',
      routedModel: 'claude-sonnet-4-6',
    });
    expect(decision.kind).toBe('terminal');
    expect(decision.dispatchPath).toBe('none');
    expect(decision.transport).toBe('no-credentials');
  });

  it('R8 forSubagent normal-turn + valid credentials preserves non-route-table dispatch path', () => {
    const decision = ProviderRouter.forSubagent({
      codexConnectivity: 'unknown',
      settings: settings(),
      model: 'claude-sonnet-4-6',
      routeScope: 'normal-turn',
      routedModel: 'claude-sonnet-4-6',
    });
    expect(decision.kind).toBe('dispatchable');
    expect(decision.dispatchPath).not.toBe('local-proxy-route-table');
    expect(decision.transport).toBe('anthropic-direct');
  });

  it.each([
    {
      routeScope: 'council' as const,
      hasCredentials: true,
      expected: {
        kind: 'dispatchable' as const,
        dispatchPath: 'local-proxy-route-table' as const,
        transport: 'anthropic-compatible-local-proxy' as const,
      },
    },
    {
      routeScope: 'council' as const,
      hasCredentials: false,
      expected: {
        kind: 'terminal' as const,
        dispatchPath: 'none' as const,
        transport: 'no-credentials' as const,
      },
    },
    {
      routeScope: 'ad-hoc' as const,
      hasCredentials: true,
      expected: {
        kind: 'dispatchable' as const,
        dispatchPath: 'local-proxy-route-table' as const,
        transport: 'anthropic-compatible-local-proxy' as const,
      },
    },
    {
      routeScope: 'ad-hoc' as const,
      hasCredentials: false,
      expected: {
        kind: 'terminal' as const,
        dispatchPath: 'none' as const,
        transport: 'no-credentials' as const,
      },
    },
    {
      routeScope: 'normal-turn' as const,
      hasCredentials: true,
      expected: {
        kind: 'dispatchable' as const,
        dispatchPath: 'direct-provider' as const,
        transport: 'anthropic-direct' as const,
      },
    },
  ])(
    'E forSubagent routeScope matrix ($routeScope / hasCredentials=$hasCredentials)',
    ({ routeScope, hasCredentials, expected }) => {
      const decision = ProviderRouter.forSubagent({
        codexConnectivity: 'unknown',
        settings: settings(hasCredentials ? {} : { claudeApiKey: null, claudeOAuthToken: null }),
        model: 'claude-sonnet-4-6',
        routeScope,
        routedModel: 'claude-sonnet-4-6',
      });
      expect(decision.kind).toBe(expected.kind);
      expect(decision.dispatchPath).toBe(expected.dispatchPath);
      expect(decision.transport).toBe(expected.transport);
    },
  );

  it('R11 forTurn council path preserves routedModel line-758 mutation', () => {
    const profile = googleProfile();
    const decision = ProviderRouter.forTurn({
      codexConnectivity: 'unknown',
      settings: settings({ profiles: [profile] }),
      model: profile.model,
      profile,
      routeScope: 'council',
      role: 'execution',
    });

    expect(decision.kind).toBe('dispatchable');
    expect(decision.dispatchPath).toBe('local-proxy-route-table');
    expect(decision.transport).toBe('anthropic-compatible-local-proxy');
    expect(decision.routedModel).toBe(decision.canonicalModelId);
  });

  it('R12 forTurn ad-hoc path preserves routedModel line-758 mutation', () => {
    const profile = googleProfile({ id: 'google-profile-adhoc' });
    const decision = ProviderRouter.forTurn({
      codexConnectivity: 'unknown',
      settings: settings({ profiles: [profile] }),
      model: profile.model,
      profile,
      routeScope: 'ad-hoc',
      role: 'execution',
    });

    expect(decision.kind).toBe('dispatchable');
    expect(decision.dispatchPath).toBe('local-proxy-route-table');
    expect(decision.transport).toBe('anthropic-compatible-local-proxy');
    expect(decision.routedModel).toBe(decision.canonicalModelId);
  });

  it('R13 forBTS baseline remains snapshot-consistent and dispatchable', () => {
    const decision = ProviderRouter.forBTS({
      codexConnectivity: 'unknown',
      settings: settings(),
      model: 'claude-haiku-4-5',
      routeScope: 'normal-turn',
    });

    expect(decision.kind).toBe('dispatchable');
    expect(decision.dispatchPath).toBe('direct-provider');
    expect(decision.transport).toBe('anthropic-direct');
    expect(decision.routedModel ?? null).toBeNull();
  });

  it('R10 forceLocalProxyRouteTable is no longer exported', () => {
    expect(
      (providerRouteDecisionModule as Record<string, unknown>).forceLocalProxyRouteTable,
    ).toBeUndefined();
  });

  it('F3 sub-agent route-table dispatch is produced by ProviderRouter.forSubagent constructor input', () => {
    for (const routeScope of ['council', 'ad-hoc'] as const) {
      const subagentDecision = ProviderRouter.forSubagent({
        codexConnectivity: 'unknown',
        settings: settings(),
        model: 'claude-sonnet-4-6',
        routeScope,
        routedModel: 'claude-sonnet-4-6',
      });
      expect(subagentDecision.kind).toBe('dispatchable');
      expect(subagentDecision.transport).toBe('anthropic-compatible-local-proxy');
      expect(subagentDecision.dispatchPath).toBe('local-proxy-route-table');
    }
  });

  it('helper predicates remain exhaustive over DispatchPath', () => {
    const expected = {
      'direct-provider': { proxy: false, routeTable: false, direct: true },
      'local-proxy-route-table': { proxy: true, routeTable: true, direct: false },
      'local-proxy-passthrough': { proxy: true, routeTable: false, direct: false },
      none: { proxy: false, routeTable: false, direct: false },
    } as const;

    for (const dispatchPath of DISPATCH_PATHS) {
      expect(isProxyDispatch(dispatchPath)).toBe(expected[dispatchPath].proxy);
      expect(isRouteTableDispatch(dispatchPath)).toBe(expected[dispatchPath].routeTable);
      expect(isDirectDispatch(dispatchPath)).toBe(expected[dispatchPath].direct);
    }
  });

  it('assertDispatchableRoutePlan stays exhaustive over DispatchPath literals', () => {
    const expectedByDispatchPath: Readonly<Record<string, { dispatchable: boolean }>> = {
      'direct-provider': { dispatchable: true },
      'local-proxy-route-table': { dispatchable: true },
      'local-proxy-passthrough': { dispatchable: true },
      none: { dispatchable: false },
    };

    for (const dispatchPath of DISPATCH_PATHS) {
      const baseDispatchable = makeDecision('anthropic-direct', 'normal-turn');
      if (baseDispatchable.kind !== 'dispatchable') {
        throw new Error('Expected dispatchable test decision');
      }
      const plan = {
        decision: dispatchPath === 'none'
          ? makeDecision('no-credentials', 'normal-turn')
          : {
              ...baseDispatchable,
              dispatchPath,
            },
      };

      if (expectedByDispatchPath[dispatchPath].dispatchable) {
        expect(() => assertDispatchableRoutePlan(plan)).not.toThrow();
      } else {
        expect(() => assertDispatchableRoutePlan(plan)).toThrow(NonDispatchableRoutePlanError);
      }
    }
  });

  it('assertDispatchableRoutePlan throws for terminal dispatchPath', () => {
    const terminal = { decision: makeDecision('no-credentials', 'normal-turn') };
    expect(() => assertDispatchableRoutePlan(terminal)).toThrow(NonDispatchableRoutePlanError);
    const dispatchable = { decision: makeDecision('anthropic-direct', 'normal-turn') };
    expect(() => assertDispatchableRoutePlan(dispatchable)).not.toThrow();
  });

  describe('terminal invalid reason helpers', () => {
    it.each(ALL_TERMINAL_INVALID_REASONS)(
      'isRecoverableTerminalReason classifies %s',
      (reason) => {
        expect(isRecoverableTerminalReason(reason)).toBe(reason !== 'proxy-dialect-in-direct-anthropic');
      },
    );

    it.each(TERMINAL_RECONNECT_EXPECTATIONS)(
      'buildTerminalReconnectMessage returns provider copy for $reason',
      ({ reason, provider, message }) => {
        const wireModelId = reason === 'codex-unsupported-model' ? 'gpt-5.5-pro' : 'claude-sonnet-4-6';
        const decision = makeTerminalDecisionForReason(reason, wireModelId);
        expect(buildTerminalReconnectMessage(decision)).toEqual({ provider, message });
      },
    );

    it('buildTerminalReconnectMessage includes wireModelId for codex-unsupported-model', () => {
      const decision = makeTerminalDecisionForReason('codex-unsupported-model', 'openai/gpt-5.5-pro');
      const reconnect = buildTerminalReconnectMessage(decision);
      expect(reconnect.message).toContain('openai/gpt-5.5-pro');
      expect(reconnect.provider).toBe('ChatGPT Pro');
    });

    it('buildTerminalReconnectMessage throws for non-recoverable reason', () => {
      const decision = makeTerminalDecisionForReason('proxy-dialect-in-direct-anthropic');
      expect(() => buildTerminalReconnectMessage(decision)).toThrow(
        'buildTerminalReconnectMessage called for non-recoverable reason',
      );
    });

    // FOX-3494 (round-2 M3): the single shared mapper used by clientFactory,
    // agentTurnExecute, and the configured-role fallback. It must agree on the
    // error class AND carry the structured detail for the claude-under-codex
    // reason so the renderer can offer the role-aware switch-to-GPT recovery.
    describe('buildRecoverableTerminalRouteError', () => {
      it('maps missing-anthropic-credentials-for-claude-model → ConnectionNotConfiguredError with detail', () => {
        const decision = {
          ...makeTerminalDecisionForReason('missing-anthropic-credentials-for-claude-model', 'claude-opus-4-8'),
          role: 'planning' as const,
        };
        const error = buildRecoverableTerminalRouteError(decision);
        expect(error).toBeInstanceOf(ConnectionNotConfiguredError);
        const cnc = error as ConnectionNotConfiguredError;
        expect(cnc.invalidReason).toBe('missing-anthropic-credentials-for-claude-model');
        expect(cnc.wireModel).toBe('claude-opus-4-8');
        expect(cnc.failedRole).toBe('planning');
        expect(cnc.provider).toBe('ChatGPT Pro');
      });

      it('maps codex-unsupported-model → UnsupportedModelError', () => {
        const decision = makeTerminalDecisionForReason('codex-unsupported-model', 'gpt-5.5-pro');
        const error = buildRecoverableTerminalRouteError(decision);
        expect(error).toBeInstanceOf(UnsupportedModelError);
        expect((error as UnsupportedModelError).wireModel).toBe('gpt-5.5-pro');
      });

      // Gateway-profile recovery: the generic Anthropic-no-key terminal now carries the
      // structured detail (additive — copy unchanged) so classifyErrorUx can offer a
      // "Use <profile>" recovery when a selectable profile serves this model.
      it('maps missing-anthropic-credentials → ConnectionNotConfiguredError with detail', () => {
        const decision = {
          ...makeTerminalDecisionForReason('missing-anthropic-credentials', 'claude-opus-4-8'),
          role: 'execution' as const,
        };
        const error = buildRecoverableTerminalRouteError(decision);
        expect(error).toBeInstanceOf(ConnectionNotConfiguredError);
        const cnc = error as ConnectionNotConfiguredError;
        expect(cnc.invalidReason).toBe('missing-anthropic-credentials');
        expect(cnc.wireModel).toBe('claude-opus-4-8');
        expect(cnc.failedRole).toBe('execution');
        expect(cnc.provider).toBe('Anthropic');
      });

      it('maps a still-generic recoverable reason → bare ConnectionNotConfiguredError (no switch-model detail)', () => {
        const decision = makeTerminalDecisionForReason('missing-profile-credentials');
        const error = buildRecoverableTerminalRouteError(decision);
        expect(error).toBeInstanceOf(ConnectionNotConfiguredError);
        const cnc = error as ConnectionNotConfiguredError;
        expect(cnc.invalidReason).toBeUndefined();
        expect(cnc.failedRole).toBeUndefined();
      });

      it('maps missing-openrouter-credentials → bare ConnectionNotConfiguredError with display-name provider', () => {
        const decision = makeTerminalDecisionForReason('missing-openrouter-credentials');
        const error = buildRecoverableTerminalRouteError(decision);
        expect(error).toBeInstanceOf(ConnectionNotConfiguredError);
        expect((error as ConnectionNotConfiguredError).provider).toBe('OpenRouter');
      });
    });
  });

  describe('validateRouteDecisionShape', () => {
    it('R14 accepts every decision produced from the snapshot fixture corpus', () => {
      const fixtureDecisions = loadFixtureDecisions();
      expect(fixtureDecisions.length).toBeGreaterThan(0);
      for (const fixtureDecision of fixtureDecisions) {
        expect(() => validateRouteDecisionShape(fixtureDecision)).not.toThrow();
      }
    });

    it.each([
      {},
      { kind: 'dispatchable', transport: 'anthropic-direct', dispatchPath: 'none', invalidReason: 'none' },
      { kind: 'terminal', transport: 'no-credentials', dispatchPath: 'direct-provider', invalidReason: 'missing-anthropic-credentials' },
      { kind: 'dispatchable', transport: 'no-credentials', dispatchPath: 'direct-provider', invalidReason: 'none' },
      { kind: 'terminal', transport: 'no-credentials', dispatchPath: 'none', invalidReason: 'none' },
      { kind: 'unknown', transport: 'anthropic-direct', dispatchPath: 'direct-provider', invalidReason: 'none' },
    ])('R14 rejects malformed shape %j', (malformed) => {
      expect(() => validateRouteDecisionShape(malformed)).toThrow(MalformedRouteDecisionError);
    });

    it('accepts a well-formed dispatchable decision', () => {
      const decision = makeDecision('anthropic-direct', 'normal-turn');
      expect(() => validateRouteDecisionShape(decision)).not.toThrow();
    });

    it('accepts a well-formed terminal decision', () => {
      const decision = makeDecision('no-credentials', 'normal-turn');
      expect(() => validateRouteDecisionShape(decision)).not.toThrow();
    });

    it('rejects non-objects', () => {
      expect(() => validateRouteDecisionShape(null)).toThrow(MalformedRouteDecisionError);
      expect(() => validateRouteDecisionShape('decision')).toThrow(MalformedRouteDecisionError);
      expect(() => validateRouteDecisionShape(42)).toThrow(MalformedRouteDecisionError);
      expect(() => validateRouteDecisionShape([])).toThrow(MalformedRouteDecisionError);
    });

    it('rejects unknown or missing kind', () => {
      expect(() => validateRouteDecisionShape({})).toThrow(MalformedRouteDecisionError);
      expect(() =>
        validateRouteDecisionShape({
          kind: 'mystery',
          transport: 'anthropic-direct',
          dispatchPath: 'direct-provider',
          invalidReason: 'none',
        }),
      ).toThrow(MalformedRouteDecisionError);
    });

    it('rejects dispatchable + dispatchPath "none"', () => {
      expect(() =>
        validateRouteDecisionShape({
          kind: 'dispatchable',
          transport: 'anthropic-direct',
          dispatchPath: 'none',
          invalidReason: 'none',
        }),
      ).toThrow(MalformedRouteDecisionError);
    });

    it('rejects terminal + non-"none" dispatchPath', () => {
      expect(() =>
        validateRouteDecisionShape({
          kind: 'terminal',
          transport: 'no-credentials',
          dispatchPath: 'direct-provider',
          invalidReason: 'no-credentials',
        }),
      ).toThrow(MalformedRouteDecisionError);
    });

    it('rejects terminal + invalidReason "none"', () => {
      expect(() =>
        validateRouteDecisionShape({
          kind: 'terminal',
          transport: 'no-credentials',
          dispatchPath: 'none',
          invalidReason: 'none',
        }),
      ).toThrow(MalformedRouteDecisionError);
    });

    it('rejects dispatchable + non-"none" invalidReason', () => {
      expect(() =>
        validateRouteDecisionShape({
          kind: 'dispatchable',
          transport: 'anthropic-direct',
          dispatchPath: 'direct-provider',
          invalidReason: 'no-credentials',
        }),
      ).toThrow(MalformedRouteDecisionError);
    });

    it('rejects dispatchable + terminal-only transport', () => {
      expect(() =>
        validateRouteDecisionShape({
          kind: 'dispatchable',
          transport: 'no-credentials',
          dispatchPath: 'direct-provider',
          invalidReason: 'none',
        }),
      ).toThrow(MalformedRouteDecisionError);
    });

    it('rejects terminal + dispatchable-only transport', () => {
      expect(() =>
        validateRouteDecisionShape({
          kind: 'terminal',
          transport: 'anthropic-direct',
          dispatchPath: 'none',
          invalidReason: 'no-credentials',
        }),
      ).toThrow(MalformedRouteDecisionError);
    });
  });
});

describe('direct-Anthropic foreign-dialect contract', () => {
  // Truth table for the chokepoint that gates direct-Anthropic dispatch. Slash-form is foreign
  // UNLESS it is a matching `anthropic/<native Claude>` self-prefix, which strips exactly one
  // provider prefix before reaching the bare wire.
  describe('resolveDirectAnthropicModel', () => {
    it.each([
      // [model, kind, wireModel]
      ['anthropic/claude-sonnet-4.6', 'native-claude', 'claude-sonnet-4.6'],
      ['anthropic/claude-haiku-4-5', 'native-claude', 'claude-haiku-4-5'],
      ['claude-sonnet-4-6', 'native-claude', 'claude-sonnet-4-6'],
      ['gpt-5.5', 'bare-non-claude', 'gpt-5.5'],
      ['not-claude', 'bare-non-claude', 'not-claude'],
      ['openai/gpt-5.5', 'foreign-dialect', null],
      ['deepseek/deepseek-v4-flash', 'foreign-dialect', null],
      ['anthropic/anthropic/claude-sonnet-4.6', 'foreign-dialect', null],
      ['anthropic/foo', 'foreign-dialect', null],
      // Pathological spellings (final-review F1): all reject via case-sensitive
      // `startsWith('anthropic/')`/`startsWith('claude-')` + the post-strip slash check.
      ['anthropic/', 'foreign-dialect', null],                       // empty after strip → not native
      ['Anthropic/claude-sonnet-4-6', 'foreign-dialect', null],      // wrong-case provider prefix → not stripped → foreign
      ['anthropic/Claude-sonnet-4-6', 'foreign-dialect', null],      // wrong-case model → not claude-* after strip
      ['anthropic/claude-sonnet-4-6/', 'foreign-dialect', null],     // trailing slash survives strip → still slash-bearing
    ] as const)('%s -> %s', (model, expectedKind, expectedWireModel) => {
      const resolution = resolveDirectAnthropicModel(model);

      expect(resolution.kind).toBe(expectedKind);
      if (expectedKind !== 'foreign-dialect') {
        expect(resolution).toMatchObject({
          kind: expectedKind,
          inputModel: model,
          wireModel: expectedWireModel,
        });
      } else {
        expect(resolution).toEqual({
          kind: 'foreign-dialect',
          inputModel: model,
          invalidReason: 'proxy-dialect-in-direct-anthropic',
        });
      }
    });

    it('isNativeAnthropicModel only accepts bare claude-* ids', () => {
      expect(isNativeAnthropicModel('claude-sonnet-4-6')).toBe(true);
      expect(isNativeAnthropicModel('anthropic/claude-sonnet-4-6')).toBe(false);
      expect(isNativeAnthropicModel('not-claude')).toBe(false);
    });
  });

  // Route-level regression: under direct Anthropic (active provider + api key), every foreign
  // dialect from the Arbitrator corpus must fail closed as proxy-dialect-in-direct-anthropic and
  // be non-capable, while a matching self-prefix is normalized + dispatched.
  describe('ProviderRouter.forTurn direct-Anthropic dialect routing', () => {
    it.each([
      'openai/gpt-5.5',
      'deepseek/deepseek-v4-flash',
      'anthropic/anthropic/claude-sonnet-4.6',
      'anthropic/not-claude',
    ])('rejects foreign dialect %s', (model) => {
      const decision = ProviderRouter.forTurn({
        codexConnectivity: 'unknown', settings: settings(), model });
      expect(decision.kind).toBe('terminal');
      expect(decision.transport).toBe('no-credentials');
      expect(decision.invalidReason).toBe('proxy-dialect-in-direct-anthropic');
      expect(ensureDirectAnthropicCapable(decision)).toEqual({ ok: false, reason: 'no-credentials' });
    });

    it.each([
      ['anthropic/claude-sonnet-4.6', 'claude-sonnet-4-6'],
      ['anthropic/claude-haiku-4-5', 'claude-haiku-4-5'],
    ])('normalizes matching self-prefix %s -> %s and dispatches bare wire', (model, expectedWire) => {
      const decision = ProviderRouter.forTurn({
        codexConnectivity: 'unknown', settings: settings(), model });
      expect(decision.kind).toBe('dispatchable');
      expect(decision.transport).toBe('anthropic-direct');
      expect(decision.modelDialect).toBe('anthropic-native');
      expect(decision.wireModelId).toBe(expectedWire);
      expect(decision.canonicalModelId).toBe(expectedWire);
      expect(ensureDirectAnthropicCapable(decision)).toEqual({ ok: true });
    });
  });
});
