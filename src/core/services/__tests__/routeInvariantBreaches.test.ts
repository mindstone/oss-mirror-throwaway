import { unsafeAssertRoutingModelId } from '@shared/utils/modelChoiceCodec';
import { brandRouteWireModel } from '@shared/utils/wireModelId';
import { assertNever } from '@shared/utils/assertNever';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppSettings } from '@shared/types';
import {
  sanitizeDecisionForCapture,
  type ProviderRouteDecision,
  type ProviderRouteInvalidReason,
} from '@core/rebelCore/providerRouteDecision';
import type { AgentToolContext } from '@core/rebelCore/types';
import type { DispatchableRoutePlan, ProviderRoutePlan } from '@core/rebelCore/providerRoutePlanTypes';
import { ConnectionNotConfiguredError, UnsupportedModelError } from '@shared/utils/connectionCredentials';

const materializePlanRuntimeMock = vi.hoisted(() => vi.fn());
const captureExceptionWithScopeMock = vi.hoisted(() => vi.fn());

vi.mock('@core/logger', () => ({
  createScopedLogger: () => ({
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
  getTurnContext: () => null,
}));

vi.mock('@core/rebelCore/providerRoutePlan', async () => {
  const actual = await vi.importActual<typeof import('@core/rebelCore/providerRoutePlan')>('@core/rebelCore/providerRoutePlan');
  return {
    ...actual,
    materializePlanRuntime: materializePlanRuntimeMock,
  };
});

vi.mock('@core/errorReporter', () => ({
  getErrorReporter: () => ({
    captureException: vi.fn(),
    captureMessage: vi.fn(),
    addBreadcrumb: vi.fn(),
    captureExceptionWithScope: captureExceptionWithScopeMock,
  }),
}));

import { callBehindTheScenesWithAuth } from '../behindTheScenesClient';
import { executeAgentTool } from '@core/rebelCore/agentTool';
import { assertDispatchableQueryOptionsPlan } from '@main/services/agentTurnExecutor';

function makeSettings(): AppSettings {
  return {
    activeProvider: 'anthropic',
    claude: {
      apiKey: 'fake-ant-test',
      oauthToken: null,
      authMethod: 'api-key',
      model: unsafeAssertRoutingModelId('claude-sonnet-4-6'),
    },
    openRouter: {
      enabled: false,
      oauthToken: null,
      selectedModel: 'anthropic/claude-sonnet-4-6',
    },
    localModel: {
      activeProfileId: null,
      profiles: [],
    },
    providerKeys: {},
    customProviders: [],
    coreDirectory: '/tmp/test-core',
  } as unknown as AppSettings;
}

function makeImpossibleDispatchablePlan(
  role: DispatchableRoutePlan['decision']['role'],
): DispatchableRoutePlan {
  return {
    decision: {
      kind: 'dispatchable',
      provider: 'anthropic',
      transport: 'no-credentials',
      dispatchPath: 'direct-provider',
      modelDialect: 'anthropic-native',
      role,
      routeScope: 'normal-turn',
      routedModel: null,
      canonicalModelId: 'claude-haiku-4-5',
      wireModelId: brandRouteWireModel('claude-haiku-4-5'),
      profileId: null,
      resolvedFrom: 'settings',
      codexConnectivity: 'unknown',
      fallbackHint: null,
      credentialSource: 'anthropic-api-key',
      invalidReason: 'none',
    } as unknown as DispatchableRoutePlan['decision'],
    auth: {
      kind: 'api-key',
      resolvedAuthLabel: 'api-key',
      credentialSource: 'anthropic-api-key',
      credentialStatus: 'available',
      apiKey: 'fake-ant-test',
      env: [['ANTHROPIC_API_KEY', 'fake-ant-test']],
    },
    headers: [],
    proxyBaseURL: null,
    resolvedAuthLabel: 'api-key',
    proxyRequired: false,
    invalidReason: null,
  };
}

type RecoverableTerminalReason = Exclude<ProviderRouteInvalidReason, 'proxy-dialect-in-direct-anthropic'>;

const RECOVERABLE_REASON_EXPECTATIONS: ReadonlyArray<{
  reason: RecoverableTerminalReason;
  message: string;
  provider: string;
}> = [
  {
    reason: 'missing-anthropic-credentials',
    provider: 'Anthropic',
    message: 'Anthropic needs an API key. Add it in Settings to continue.',
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
  {
    // FOX-3494 (Option Y): stays a ConnectionNotConfiguredError (carrying the
    // actionable claude-* detail), so it is exercised by the
    // ConnectionNotConfigured recoverable-reason test below.
    reason: 'missing-anthropic-credentials-for-claude-model',
    provider: 'ChatGPT Pro',
    message:
      "You're connected to ChatGPT Pro, but the selected model — claude-sonnet-4-6 — runs on Anthropic, which isn't connected. Your message is safe.",
  },
];

function makeTerminalPlanForExecutor(invalidReason: ProviderRouteInvalidReason): ProviderRoutePlan {
  const baseDecision = {
    kind: 'terminal',
    dispatchPath: 'none',
    role: 'execution',
    routeScope: 'normal-turn',
    routedModel: null,
    canonicalModelId: 'claude-sonnet-4-6',
    resolvedFrom: 'settings',
    codexConnectivity: 'unknown',
    fallbackHint: null,
  } as const;

  switch (invalidReason) {
    case 'missing-anthropic-credentials':
    case 'missing-anthropic-credentials-for-claude-model':
      return {
        decision: {
          ...baseDecision,
          provider: 'anthropic',
          transport: 'no-credentials',
          modelDialect: 'anthropic-native',
          wireModelId: brandRouteWireModel('claude-sonnet-4-6'),
          profileId: null,
          credentialSource: 'missing-anthropic',
          invalidReason,
        },
        auth: {
          kind: 'none',
          resolvedAuthLabel: 'none',
          credentialSource: 'missing-anthropic',
          credentialStatus: 'missing',
          env: [],
        },
        headers: [],
        proxyBaseURL: null,
        resolvedAuthLabel: 'none',
        proxyRequired: false,
        invalidReason,
      } as unknown as ProviderRoutePlan;
    case 'missing-openrouter-credentials':
      return {
        decision: {
          ...baseDecision,
          provider: 'openrouter',
          transport: 'no-credentials',
          modelDialect: 'openrouter-prefixed',
          wireModelId: brandRouteWireModel('openai/gpt-5.5'),
          profileId: null,
          credentialSource: 'missing-openrouter',
          invalidReason,
        },
        auth: {
          kind: 'none',
          resolvedAuthLabel: 'none',
          credentialSource: 'missing-openrouter',
          credentialStatus: 'missing',
          env: [],
        },
        headers: [],
        proxyBaseURL: null,
        resolvedAuthLabel: 'none',
        proxyRequired: false,
        invalidReason,
      } as unknown as ProviderRoutePlan;
    case 'missing-mindstone-credentials':
      return {
        decision: {
          ...baseDecision,
          provider: 'openrouter',
          transport: 'no-credentials',
          modelDialect: 'openrouter-prefixed',
          wireModelId: brandRouteWireModel('openai/gpt-5.5'),
          profileId: null,
          credentialSource: 'missing-mindstone',
          invalidReason,
        },
        auth: {
          kind: 'none',
          resolvedAuthLabel: 'none',
          credentialSource: 'missing-mindstone',
          credentialStatus: 'missing',
          env: [],
        },
        headers: [],
        proxyBaseURL: null,
        resolvedAuthLabel: 'none',
        proxyRequired: false,
        invalidReason,
      } as unknown as ProviderRoutePlan;
    case 'missing-codex-connection':
      return {
        decision: {
          ...baseDecision,
          provider: 'codex',
          transport: 'no-credentials',
          modelDialect: 'openai-compatible',
          wireModelId: brandRouteWireModel('gpt-5.5'),
          profileId: null,
          credentialSource: 'missing-codex',
          invalidReason,
        },
        auth: {
          kind: 'none',
          resolvedAuthLabel: 'none',
          credentialSource: 'missing-codex',
          credentialStatus: 'missing',
          env: [],
        },
        headers: [],
        proxyBaseURL: null,
        resolvedAuthLabel: 'none',
        proxyRequired: false,
        invalidReason,
      } as unknown as ProviderRoutePlan;
    case 'missing-profile-credentials':
      return {
        decision: {
          ...baseDecision,
          provider: 'profile',
          transport: 'no-credentials',
          modelDialect: 'profile-ref',
          wireModelId: brandRouteWireModel('openai/gpt-5.5'),
          profileId: 'profile-missing-key',
          credentialSource: 'missing-profile',
          invalidReason,
        },
        auth: {
          kind: 'none',
          resolvedAuthLabel: 'none',
          credentialSource: 'missing-profile',
          credentialStatus: 'missing',
          env: [],
        },
        headers: [],
        proxyBaseURL: null,
        resolvedAuthLabel: 'none',
        proxyRequired: false,
        invalidReason,
      } as unknown as ProviderRoutePlan;
    case 'codex-disconnected-bts-blocked':
      return {
        decision: {
          ...baseDecision,
          provider: 'codex',
          transport: 'fail-closed-codex-disconnected',
          modelDialect: 'openai-compatible',
          wireModelId: brandRouteWireModel('gpt-5.5'),
          profileId: null,
          credentialSource: 'missing-codex',
          invalidReason,
        },
        auth: {
          kind: 'none',
          resolvedAuthLabel: 'none',
          credentialSource: 'missing-codex',
          credentialStatus: 'missing',
          env: [],
        },
        headers: [],
        proxyBaseURL: null,
        resolvedAuthLabel: 'none',
        proxyRequired: false,
        invalidReason,
      } as unknown as ProviderRoutePlan;
    case 'codex-unsupported-model':
      return {
        decision: {
          ...baseDecision,
          provider: 'codex',
          transport: 'no-credentials',
          modelDialect: 'openai-compatible',
          wireModelId: brandRouteWireModel('gpt-5.5-pro'),
          profileId: null,
          credentialSource: 'missing-codex',
          invalidReason,
        },
        auth: {
          kind: 'none',
          resolvedAuthLabel: 'none',
          credentialSource: 'missing-codex',
          credentialStatus: 'missing',
          env: [],
        },
        headers: [],
        proxyBaseURL: null,
        resolvedAuthLabel: 'none',
        proxyRequired: false,
        invalidReason,
      } as unknown as ProviderRoutePlan;
    case 'proxy-dialect-in-direct-anthropic':
      return {
        decision: {
          ...baseDecision,
          provider: 'anthropic',
          transport: 'no-credentials',
          modelDialect: 'openrouter-prefixed',
          wireModelId: brandRouteWireModel('openai/gpt-5.5'),
          profileId: null,
          credentialSource: 'anthropic-api-key',
          invalidReason,
        },
        auth: {
          kind: 'api-key',
          resolvedAuthLabel: 'api-key',
          credentialSource: 'anthropic-api-key',
          credentialStatus: 'available',
          apiKey: 'fake-ant-test',
          env: [['ANTHROPIC_API_KEY', 'fake-ant-test']],
        },
        headers: [],
        proxyBaseURL: null,
        resolvedAuthLabel: 'api-key',
        proxyRequired: false,
        invalidReason,
      } as unknown as ProviderRoutePlan;
    default:
      return assertNever(invalidReason, 'ProviderRouteInvalidReason in makeTerminalPlanForExecutor');
  }
}

function expectConnectionNotConfiguredTerminalThrow(plan: ProviderRoutePlan, expected: {
  message: string;
  provider: string;
}): void {
  try {
    assertDispatchableQueryOptionsPlan(plan);
    throw new Error('Expected ConnectionNotConfiguredError');
  } catch (error) {
    expect(error).toBeInstanceOf(ConnectionNotConfiguredError);
    if (!(error instanceof ConnectionNotConfiguredError)) {
      throw error;
    }
    expect(error.message).toBe(expected.message);
    expect(error.provider).toBe(expected.provider);
  }
}

function expectUnsupportedModelTerminalThrow(plan: ProviderRoutePlan, expected: {
  message: string;
  provider: string;
  wireModel: string;
}): void {
  try {
    assertDispatchableQueryOptionsPlan(plan);
    throw new Error('Expected UnsupportedModelError');
  } catch (error) {
    expect(error).toBeInstanceOf(UnsupportedModelError);
    if (!(error instanceof UnsupportedModelError)) {
      throw error;
    }
    expect(error.message).toBe(expected.message);
    expect(error.provider).toBe(expected.provider);
    expect(error.wireModel).toBe(expected.wireModel);
  }
}

function makeAgentToolContext(): AgentToolContext {
  return {
    agents: {
      researcher: {
        description: 'Research helper',
        prompt: 'You are a focused sub-agent.',
        model: 'inherit',
      },
    },
    client: {} as AgentToolContext['client'],
    settings: makeSettings(),
    parentModel: unsafeAssertRoutingModelId('claude-sonnet-4-6'),
    parentMaxTokens: 1024,
    parentEffort: 'low',
    codexConnectivity: 'unknown',
  };
}

function installCaptureCollector(): Array<{
  tags: Record<string, string>;
  contexts: Record<string, Record<string, unknown>>;
}> {
  const capturePayloads: Array<{
    tags: Record<string, string>;
    contexts: Record<string, Record<string, unknown>>;
  }> = [];

  captureExceptionWithScopeMock.mockImplementation((_error: unknown, mutateScope: (scope: {
    setTag(key: string, value: string): void;
    setContext(name: string, context: Record<string, unknown>): void;
  }) => void) => {
    const tags: Record<string, string> = {};
    const contexts: Record<string, Record<string, unknown>> = {};
    mutateScope({
      setTag(key, value) {
        tags[key] = value;
      },
      setContext(name, context) {
        contexts[name] = context;
      },
    });
    capturePayloads.push({ tags, contexts });
  });

  return capturePayloads;
}

describe('route invariant breach capture', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('S4 captures BTS dispatchable-narrow breach with sanitized decision context', async () => {
    const impossiblePlan = makeImpossibleDispatchablePlan('bts');
    materializePlanRuntimeMock.mockResolvedValue(impossiblePlan);
    const capturePayloads = installCaptureCollector();

    await expect(callBehindTheScenesWithAuth(makeSettings(), {
      codexConnectivity: 'unknown',
      messages: [{ role: 'user', content: 'test' }],
    })).rejects.toThrow(/unhandled discriminant.*BTS transport/);

    expect(captureExceptionWithScopeMock).toHaveBeenCalledTimes(1);
    expect(capturePayloads[0]?.tags).toMatchObject({
      area: 'routing',
      invariant: 'dispatchable-narrow',
      subInvariant: 'narrow-breached',
    });

    const expectedDecisionContext = sanitizeDecisionForCapture(
      impossiblePlan.decision as unknown as ProviderRouteDecision,
    );
    expect(capturePayloads[0]?.contexts.decision).toEqual(expectedDecisionContext);
    expect(capturePayloads[0]?.contexts.decision.credentialSource).toBe('<credential-source-redacted>');
    expect(capturePayloads[0]?.contexts.decision.credentialSource).not.toBe('anthropic-api-key');
  });

  it('S4 captures sub-agent dispatch breach with default narrow-breached subInvariant', async () => {
    const impossiblePlan = makeImpossibleDispatchablePlan('subagent');
    materializePlanRuntimeMock.mockResolvedValue(impossiblePlan);
    const capturePayloads = installCaptureCollector();

    const result = await executeAgentTool(
      { agent: 'researcher', prompt: 'Investigate routing invariants' },
      makeAgentToolContext(),
    );

    expect(result.isError).toBe(true);
    expect(captureExceptionWithScopeMock).toHaveBeenCalledTimes(1);
    expect(capturePayloads[0]?.tags).toMatchObject({
      area: 'routing',
      invariant: 'dispatchable-narrow',
      subInvariant: 'narrow-breached',
    });

    const expectedDecisionContext = sanitizeDecisionForCapture(
      impossiblePlan.decision as unknown as ProviderRouteDecision,
    );
    expect(capturePayloads[0]?.contexts.decision).toEqual(expectedDecisionContext);
    expect(capturePayloads[0]?.contexts.decision.credentialSource).toBe('<credential-source-redacted>');
    expect(capturePayloads[0]?.contexts.decision.credentialSource).not.toBe('anthropic-api-key');
  });

  it.each(
    // codex-unsupported-model is the only recoverable reason that throws
    // UnsupportedModelError; FOX-3494's claude-* reason stays a
    // ConnectionNotConfiguredError (Option Y) so it is exercised here too.
    RECOVERABLE_REASON_EXPECTATIONS.filter(({ reason }) => reason !== 'codex-unsupported-model'),
  )(
    'S4 throws ConnectionNotConfiguredError without capture for recoverable reason: $reason',
    ({ reason, message, provider }) => {
      const terminalPlan = makeTerminalPlanForExecutor(reason);
      installCaptureCollector();

      expectConnectionNotConfiguredTerminalThrow(terminalPlan, { message, provider });
      expect(captureExceptionWithScopeMock).not.toHaveBeenCalled();
    },
  );

  it('S4 throws UnsupportedModelError without capture for codex unsupported-model terminal route', () => {
    const terminalPlan = makeTerminalPlanForExecutor('codex-unsupported-model');
    installCaptureCollector();

    expectUnsupportedModelTerminalThrow(terminalPlan, {
      message: 'ChatGPT Pro doesn\'t support gpt-5.5-pro. Pick a different model in Settings.',
      provider: 'ChatGPT Pro',
      wireModel: 'gpt-5.5-pro',
    });
    expect(captureExceptionWithScopeMock).not.toHaveBeenCalled();
  });

  it('S4 (FOX-3494) throws ConnectionNotConfiguredError carrying the actionable claude-* detail, without capture, for primary-turn claude-* under connected codex (execution role)', () => {
    const terminalPlan = makeTerminalPlanForExecutor('missing-anthropic-credentials-for-claude-model');
    installCaptureCollector();

    let thrown: unknown;
    try {
      assertDispatchableQueryOptionsPlan(terminalPlan);
      throw new Error('Expected ConnectionNotConfiguredError');
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(ConnectionNotConfiguredError);
    expect(thrown).not.toBeInstanceOf(UnsupportedModelError);
    const cnc = thrown as ConnectionNotConfiguredError;
    expect(cnc.message).toBe(
      "You're connected to ChatGPT Pro, but the selected model — claude-sonnet-4-6 — runs on Anthropic, which isn't connected. Your message is safe.",
    );
    expect(cnc.provider).toBe('ChatGPT Pro');
    expect(cnc.invalidReason).toBe('missing-anthropic-credentials-for-claude-model');
    expect(cnc.wireModel).toBe('claude-sonnet-4-6');
    expect(cnc.failedRole).toBe('execution');
    expect(captureExceptionWithScopeMock).not.toHaveBeenCalled();
  });

  it('S4 captures executor terminal-plan-reached breach and rethrows for non-recoverable reason', () => {
    const terminalPlan = makeTerminalPlanForExecutor('proxy-dialect-in-direct-anthropic');
    const capturePayloads = installCaptureCollector();

    expect(() => assertDispatchableQueryOptionsPlan(terminalPlan)).toThrow(
      /Cannot build SDK query options for terminal route plan/,
    );

    expect(captureExceptionWithScopeMock).toHaveBeenCalledTimes(1);
    expect(capturePayloads[0]?.tags).toMatchObject({
      area: 'routing',
      invariant: 'dispatchable-narrow',
      subInvariant: 'terminal-plan-reached',
    });

    const expectedDecisionContext = sanitizeDecisionForCapture(
      terminalPlan.decision as unknown as ProviderRouteDecision,
    );
    expect(capturePayloads[0]?.contexts.decision).toEqual(expectedDecisionContext);
    expect(capturePayloads[0]?.contexts.decision.credentialSource).toBe('<credential-source-redacted>');
    expect(capturePayloads[0]?.contexts.decision.credentialSource).not.toBe('missing-anthropic');
  });
});
