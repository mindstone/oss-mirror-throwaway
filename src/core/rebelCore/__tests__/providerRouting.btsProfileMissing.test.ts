import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ModelProfile } from '@shared/types';
import { KNOWN_CONDITIONS } from '@core/sentry/knownConditions';
import {
  forTurnWithFallback,
  ProviderRouter,
  type ProviderRouteSettings,
} from '../providerRouting';
import { materializePlanRuntime } from '../providerRoutePlan';
import type { ProviderRouteDecision, ProviderRouteRole } from '../providerRouteDecision';

const loggerMock = vi.hoisted(() => ({
  debug: vi.fn(),
  error: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
}));

const captureKnownConditionMock = vi.hoisted(() => vi.fn());

vi.mock('@core/logger', () => ({
  createScopedLogger: () => loggerMock,
}));

vi.mock('@core/sentry/captureKnownCondition', () => ({
  captureKnownCondition: captureKnownConditionMock,
}));

function profile(overrides: Partial<ModelProfile> = {}): ModelProfile {
  return {
    id: 'abc',
    name: 'Profile ABC',
    providerType: 'anthropic',
    serverUrl: '',
    model: 'claude-sonnet-4-6',
    apiKey: 'fake-profile-test',
    createdAt: 1,
    ...overrides,
  };
}

function settings(overrides: Partial<ProviderRouteSettings> = {}): ProviderRouteSettings {
  return {
    activeProvider: 'anthropic',
    models: {
      apiKey: 'fake-ant-test',
      authMethod: 'api-key',
      model: 'claude-sonnet-4-6',
      oauthToken: null,
      workingFallback: undefined,
    },
    openRouter: {
      enabled: false,
      oauthToken: null,
      selectedModel: 'anthropic/claude-sonnet-4.6',
    },
    localModel: { activeProfileId: null, profiles: [] },
    providerKeys: {},
    behindTheScenesModel: 'profile:abc',
    ...overrides,
  };
}

function expectNoProfileLeak(decision: ProviderRouteDecision, staleReference: string): void {
  expect(decision.wireModelId).not.toBe(staleReference);
  expect(decision.canonicalModelId).not.toBe(staleReference);
  expect(decision.wireModelId).not.toMatch(/^profile:/);
  expect(decision.canonicalModelId).not.toMatch(/^profile:/);
}

function expectSanitized(args: {
  decision: ProviderRouteDecision;
  staleReference: string;
  role: ProviderRouteRole;
  profileState: 'missing' | 'disabled' | 'incomplete' | 'empty-id';
  missingProfileId: string;
}): void {
  expectNoProfileLeak(args.decision, args.staleReference);

  expect(loggerMock.warn).toHaveBeenCalledTimes(1);
  expect(loggerMock.warn).toHaveBeenCalledWith(
    {
      siteId: 'providerRouting:sanitizeStaleProfileReference',
      role: args.role,
      missingProfileId: args.missingProfileId,
      profileState: args.profileState,
    },
    '[routeDecision] Routing input references unusable profile; clearing stale BTS setting and degrading to role default',
  );

  expect(captureKnownConditionMock).toHaveBeenCalledTimes(1);
  const [condition, context, error] = captureKnownConditionMock.mock.calls[0] ?? [];
  expect(condition).toBe('bts_profile_missing');
  expect(context).toEqual({
    role: args.role,
    profileState: args.profileState,
    missingProfileId: args.missingProfileId,
  });
  expect(error).toBeInstanceOf(Error);
  expect(error.message).toMatch(/Routing input references unusable profile.*role=.*profileState=.*profileId=/);
  expect(error.message).toContain(`role=${args.role}`);
  expect(error.message).toContain(`profileState=${args.profileState}`);
  expect(error.message).toContain(`profileId=${args.missingProfileId}`);
}

function expectNoSanitize(): void {
  expect(loggerMock.warn).not.toHaveBeenCalled();
  expect(captureKnownConditionMock).not.toHaveBeenCalled();
}

describe('ProviderRouter stale profile reference sanitization', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('registers the bts_profile_missing known condition', () => {
    expect(KNOWN_CONDITIONS.bts_profile_missing).toMatchObject({
      owner: '@core',
      level: 'warning',
      addedAt: '2026-05-18T00:00:00.000Z',
    });
  });

  describe('forBTS provider matrix', () => {
    it('sanitizes a missing BTS profile before Anthropic routing', () => {
      const decision = ProviderRouter.forBTS({
        codexConnectivity: 'unknown',
        settings: settings(),
      });

      expect(decision.provider).toBe('anthropic');
      expect(decision.wireModelId).toBe('claude-haiku-4-5');
      expect(decision.canonicalModelId).toBe('claude-haiku-4-5');
      expect(decision.resolvedFrom).not.toBe('working-profile');
      expectSanitized({
        decision,
        staleReference: 'profile:abc',
        role: 'bts',
        profileState: 'missing',
        missingProfileId: 'abc',
      });
    });

    it('sanitizes a missing BTS profile before OpenRouter routing', () => {
      const decision = ProviderRouter.forBTS({
        codexConnectivity: 'unknown',
        settings: settings({
          activeProvider: 'openrouter',
          openRouter: {
            enabled: true,
            oauthToken: 'or-token',
            selectedModel: 'anthropic/claude-sonnet-4.6',
          },
        }),
      });

      expect(decision.provider).toBe('openrouter');
      expectSanitized({
        decision,
        staleReference: 'profile:abc',
        role: 'bts',
        profileState: 'missing',
        missingProfileId: 'abc',
      });
    });

    it('sanitizes a missing BTS profile before Codex-connected routing', () => {
      const decision = ProviderRouter.forBTS({
        settings: settings({ activeProvider: 'codex' }),
        codexConnectivity: 'connected',
      });

      expect(decision.provider).toBe('anthropic');
      expectSanitized({
        decision,
        staleReference: 'profile:abc',
        role: 'bts',
        profileState: 'missing',
        missingProfileId: 'abc',
      });
    });

    it('sanitizes a missing BTS profile before Codex-disconnected terminal routing', () => {
      const decision = ProviderRouter.forBTS({
        settings: settings({
          activeProvider: 'codex',
          models: {
            apiKey: null,
            authMethod: 'api-key',
            model: 'claude-sonnet-4-6',
            oauthToken: null,
          },
        }),
        codexConnectivity: 'disconnected',
      });

      expect(decision.kind).toBe('terminal');
      expect(decision.invalidReason).toBe('missing-anthropic-credentials');
      expectSanitized({
        decision,
        staleReference: 'profile:abc',
        role: 'bts',
        profileState: 'missing',
        missingProfileId: 'abc',
      });
    });

    it('sanitizes a missing BTS profile before no-credentials terminal routing', () => {
      const decision = ProviderRouter.forBTS({
        codexConnectivity: 'unknown',
        settings: settings({
          models: {
            apiKey: null,
            authMethod: 'api-key',
            model: 'claude-sonnet-4-6',
            oauthToken: null,
          },
        }),
      });

      expect(decision.kind).toBe('terminal');
      expect(decision.invalidReason).toBe('missing-anthropic-credentials');
      expect(decision.wireModelId).toBe('claude-haiku-4-5');
      expect(decision.resolvedFrom).not.toBe('working-profile');
      expectSanitized({
        decision,
        staleReference: 'profile:abc',
        role: 'bts',
        profileState: 'missing',
        missingProfileId: 'abc',
      });
    });
  });

  it('classifies disabled BTS profiles and degrades', () => {
    const decision = ProviderRouter.forBTS({
      codexConnectivity: 'unknown',
      settings: settings({
        localModel: { activeProfileId: null, profiles: [profile({ enabled: false })] },
      }),
    });

    expectSanitized({
      decision,
      staleReference: 'profile:abc',
      role: 'bts',
      profileState: 'disabled',
      missingProfileId: 'abc',
    });
  });

  it('classifies incomplete BTS profiles and degrades', () => {
    const decision = ProviderRouter.forBTS({
      codexConnectivity: 'unknown',
      settings: settings({
        localModel: { activeProfileId: null, profiles: [profile({ model: '' })] },
      }),
    });

    expectSanitized({
      decision,
      staleReference: 'profile:abc',
      role: 'bts',
      profileState: 'incomplete',
      missingProfileId: 'abc',
    });
  });

  it('classifies an empty profile id and degrades', () => {
    const decision = ProviderRouter.forBTS({
      codexConnectivity: 'unknown',
      settings: settings({ behindTheScenesModel: 'profile:' }),
    });

    expectSanitized({
      decision,
      staleReference: 'profile:',
      role: 'bts',
      profileState: 'empty-id',
      missingProfileId: '<empty>',
    });
  });

  it('trims whitespace-only profile ids before classifying them as empty-id', () => {
    const decision = ProviderRouter.forBTS({
      codexConnectivity: 'unknown',
      settings: settings({ behindTheScenesModel: 'profile:   ' }),
    });

    expectSanitized({
      decision,
      staleReference: 'profile:   ',
      role: 'bts',
      profileState: 'empty-id',
      missingProfileId: '<empty>',
    });
  });

  it('sanitizes model-prefixed profile-like BTS settings before they leak to the wire', () => {
    const decision = ProviderRouter.forBTS({
      codexConnectivity: 'unknown',
      settings: settings({ behindTheScenesModel: 'model:profile:abc' }),
      model: null,
    });

    expectSanitized({
      decision,
      staleReference: 'profile:abc',
      role: 'bts',
      profileState: 'missing',
      missingProfileId: 'abc',
    });
  });

  it('sanitizes model-prefixed profile-like BTS settings even when the colliding profile id exists', () => {
    const decision = ProviderRouter.forBTS({
      codexConnectivity: 'unknown',
      settings: settings({
        behindTheScenesModel: 'model:profile:abc',
        localModel: { activeProfileId: null, profiles: [profile()] },
      }),
      model: null,
    });

    // Decision: degrade the defensive collision instead of preserving it. The
    // lossy per-site string contract would otherwise route bare 'profile:abc'
    // as a wire model after resolveFastRole, recreating the original leak.
    expectSanitized({
      decision,
      staleReference: 'profile:abc',
      role: 'bts',
      profileState: 'missing',
      missingProfileId: 'abc',
    });
  });

  it('sanitizes caller-resolved stale overrides without mutating the override map', () => {
    const behindTheScenesOverrides = { summarization: 'profile:missing' };
    const routeSettings = settings({
      behindTheScenesModel: 'model:gpt-5.5-mini',
      behindTheScenesOverrides,
    });

    const decision = ProviderRouter.forBTS({
      codexConnectivity: 'unknown',
      settings: routeSettings,
      model: 'profile:missing',
    });

    expect(routeSettings.behindTheScenesOverrides).toBe(behindTheScenesOverrides);
    expect(routeSettings.behindTheScenesOverrides).toEqual({ summarization: 'profile:missing' });
    expectSanitized({
      decision,
      staleReference: 'profile:missing',
      role: 'bts',
      profileState: 'missing',
      missingProfileId: 'missing',
    });
  });

  it('does not let a stale global BTS profile override an explicit BTS model', () => {
    const decision = ProviderRouter.forBTS({
      codexConnectivity: 'unknown',
      settings: settings({ behindTheScenesModel: 'profile:missing' }),
      model: 'gpt-5.5-mini',
    });

    expect(decision.wireModelId).toBe('gpt-5.5-mini');
    expect(decision.canonicalModelId).toBe('gpt-5.5-mini');
    expectNoSanitize();
  });

  it('does not let a stale global BTS profile override an explicit turn model', () => {
    const decision = ProviderRouter.forTurn({
      codexConnectivity: 'unknown',
      settings: settings({ behindTheScenesModel: 'profile:missing' }),
      model: 'gpt-5.5-mini',
    });

    expect(decision.wireModelId).toBe('gpt-5.5-mini');
    expect(decision.canonicalModelId).toBe('gpt-5.5-mini');
    expectNoSanitize();
  });

  it('still sanitizes a stale global BTS profile when no explicit BTS model is set', () => {
    const decision = ProviderRouter.forBTS({
      codexConnectivity: 'unknown',
      settings: settings({ behindTheScenesModel: 'profile:missing' }),
      model: null,
    });

    expectSanitized({
      decision,
      staleReference: 'profile:missing',
      role: 'bts',
      profileState: 'missing',
      missingProfileId: 'missing',
    });
  });

  it('still sanitizes explicit stale BTS profile input when the global BTS setting is a model', () => {
    const decision = ProviderRouter.forBTS({
      codexConnectivity: 'unknown',
      settings: settings({ behindTheScenesModel: 'gpt-5.5-mini' }),
      model: 'profile:missing',
    });

    expectSanitized({
      decision,
      staleReference: 'profile:missing',
      role: 'bts',
      profileState: 'missing',
      missingProfileId: 'missing',
    });
  });

  it('sanitizes forTurn stale profile references symmetrically', () => {
    const decision = ProviderRouter.forTurn({
      codexConnectivity: 'unknown',
      settings: settings({ behindTheScenesModel: 'model:claude-haiku-4-5' }),
      model: 'profile:missing',
    });

    expectSanitized({
      decision,
      staleReference: 'profile:missing',
      role: 'execution',
      profileState: 'missing',
      missingProfileId: 'missing',
    });
  });

  it('sanitizes forSubagent stale profile references symmetrically', () => {
    const decision = ProviderRouter.forSubagent({
      codexConnectivity: 'unknown',
      settings: settings({ behindTheScenesModel: 'model:claude-haiku-4-5' }),
      model: 'profile:missing',
      routedModel: 'profile:missing',
    });

    expect(decision.routedModel).toBe('profile:missing');
    expectSanitized({
      decision,
      staleReference: 'profile:missing',
      role: 'subagent',
      profileState: 'missing',
      missingProfileId: 'missing',
    });
  });

  it('sanitizes profile references rebuilt from encoded fallback settings', async () => {
    const routeSettings = settings({
      behindTheScenesModel: 'model:claude-haiku-4-5',
      models: {
        apiKey: 'fake-ant-test',
        authMethod: 'api-key',
        model: 'claude-sonnet-4-6',
        oauthToken: null,
        workingFallback: 'profile:missing',
      },
    });
    const inFlightPlan = await materializePlanRuntime(ProviderRouter.forTurn({
      codexConnectivity: 'unknown',
      settings: routeSettings,
      model: 'gpt-5.5',
    }));
    vi.clearAllMocks();

    const decision = forTurnWithFallback(
      {
        settings: routeSettings,
        model: 'gpt-5.5',
        codexConnectivity: 'unknown',
      },
      { kind: 'codex-rate-limit-tier', tier: 'standard' },
      inFlightPlan,
    );

    expect(decision.fallbackHint).toEqual({ kind: 'codex-rate-limit-tier', tier: 'standard' });
    expectSanitized({
      decision,
      staleReference: 'profile:missing',
      role: 'execution',
      profileState: 'missing',
      missingProfileId: 'missing',
    });
  });

  it('does not sanitize a routable profile reference', () => {
    const decision = ProviderRouter.forBTS({
      codexConnectivity: 'unknown',
      settings: settings({
        localModel: { activeProfileId: null, profiles: [profile()] },
      }),
    });

    expect(decision.wireModelId).toBe('claude-sonnet-4-6');
    expectNoSanitize();
  });

  it('sanitizes a stale profile reference arriving directly as input.model (Fix 2 end-to-end)', () => {
    const decision = ProviderRouter.forBTS({
      codexConnectivity: 'unknown',
      settings: settings({ behindTheScenesModel: 'model:claude-haiku-4-5' }),
      model: 'profile:abc',
    });

    expect(decision.wireModelId).toBe('claude-haiku-4-5');
    expect(decision.resolvedFrom).not.toBe('working-profile');
    expectSanitized({
      decision,
      staleReference: 'profile:abc',
      role: 'bts',
      profileState: 'missing',
      missingProfileId: 'abc',
    });
  });

  it('preserves a routable global BTS profile when sanitize fires for a per-task override (Fix 4)', () => {
    const opusValid = profile({ id: 'opus-valid', model: 'claude-opus-4-7' });
    const routeSettings = settings({
      behindTheScenesModel: 'profile:opus-valid',
      localModel: { activeProfileId: null, profiles: [opusValid] },
    });
    const decision = ProviderRouter.forBTS({
      codexConnectivity: 'unknown',
      settings: routeSettings,
      model: 'profile:stale',
    });

    // The global preference was not the stale reference, so the cleared-settings
    // cascade still resolves to its configured profile model (claude-opus-4-7).
    expect(decision.wireModelId).toBe('claude-opus-4-7');
    expect(decision.canonicalModelId).toBe('claude-opus-4-7');
    expectSanitized({
      decision,
      staleReference: 'profile:stale',
      role: 'bts',
      profileState: 'missing',
      missingProfileId: 'stale',
    });
  });

  it('does NOT hijack BTS routing via working-profile after sanitize fires (Fix 5)', () => {
    const workingOpus = profile({ id: 'opus-id', model: 'claude-opus-4-7' });
    const decision = ProviderRouter.forBTS({
      codexConnectivity: 'unknown',
      settings: settings({
        models: { workingProfileId: 'opus-id' },
        behindTheScenesModel: 'profile:stale',
        localModel: { activeProfileId: null, profiles: [workingOpus] },
      }),
    });

    // Without Fix 5, resolveProfile would promote workingProfileId to
    // claude-opus-4-7 (10x cost regression) once sanitize cleared input.model.
    expect(decision.wireModelId).toBe('claude-haiku-4-5');
    expect(decision.canonicalModelId).toBe('claude-haiku-4-5');
    expect(decision.resolvedFrom).not.toBe('working-profile');
    expect(decision.profileId).toBeNull();
    expectSanitized({
      decision,
      staleReference: 'profile:stale',
      role: 'bts',
      profileState: 'missing',
      missingProfileId: 'stale',
    });
  });
});
