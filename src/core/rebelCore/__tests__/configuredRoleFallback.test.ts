import { describe, expect, it } from 'vitest';
import type { AppSettings, ModelProfile } from '@shared/types';
import {
  annotateModelRuntimeRole,
  getModelRuntimeRoleMetadata,
  isConfiguredRoleFallbackEligibleError,
  resolveConfiguredRoleFallback,
} from '../configuredRoleFallback';

function makeProfile(overrides: Partial<ModelProfile> = {}): ModelProfile {
  return {
    id: 'profile-a',
    name: 'Profile A',
    serverUrl: 'https://api.example.com/v1',
    model: 'gpt-5.4-mini',
    createdAt: Date.now(),
    ...overrides,
  };
}

describe('configuredRoleFallback', () => {
  it('accepts recoverable operational errors and blocks rate_limit unless explicitly allowed', () => {
    expect(isConfiguredRoleFallbackEligibleError({ errorKind: 'server_error' })).toBe(true);
    expect(isConfiguredRoleFallbackEligibleError({ errorKind: 'model_unavailable' })).toBe(true);
    expect(isConfiguredRoleFallbackEligibleError({ errorKind: 'network' })).toBe(false);
    expect(isConfiguredRoleFallbackEligibleError({ errorKind: 'rate_limit' })).toBe(false);
    expect(isConfiguredRoleFallbackEligibleError({ errorKind: 'rate_limit', allowRateLimit: true })).toBe(true);
  });

  it('rejects network-down shaped failures even when classified as server_error', () => {
    expect(isConfiguredRoleFallbackEligibleError({
      errorKind: 'server_error',
      errorMessage: 'connect ECONNREFUSED 127.0.0.1:443',
    })).toBe(false);
  });

  it('accepts text-classified rate-limit errors (errorKind missing/unknown but message matches) when allowRateLimit is true', () => {
    // The handler in turnErrorRecovery enters via isRateLimitMessage() OR
    // errorKind === 'rate_limit'. Without text-message matching here, the
    // resolver silently rejected text-classified 429s as skip_not_recoverable
    // even though the handler had already authorised the rate-limit path.
    expect(isConfiguredRoleFallbackEligibleError({
      errorKind: undefined,
      errorMessage: 'HTTP 429 Too Many Requests',
      allowRateLimit: true,
    })).toBe(true);
    expect(isConfiguredRoleFallbackEligibleError({
      errorKind: 'unknown',
      errorMessage: 'taking a quick breather, try again shortly',
      allowRateLimit: true,
    })).toBe(true);
  });

  it('still rejects text-classified rate-limit errors when allowRateLimit is false', () => {
    // Non-rate-limit handlers (alt-model, thinking-model, server-error) call
    // resolveConfiguredRoleFallback with allowRateLimit:false. They must not
    // accidentally promote a text-matching message into a rate-limit fallback.
    expect(isConfiguredRoleFallbackEligibleError({
      errorKind: undefined,
      errorMessage: 'HTTP 429 Too Many Requests',
      allowRateLimit: false,
    })).toBe(false);
    expect(isConfiguredRoleFallbackEligibleError({
      errorKind: 'unknown',
      errorMessage: 'rate limit hit',
    })).toBe(false);
  });

  it('resolves model fallback from settings for recoverable working errors', () => {
    const settings = {
      models: {
        model: 'gpt-5.5',
        workingFallback: 'model:gpt-5.4-mini',
      },
    } as Partial<AppSettings>;

    const decision = resolveConfiguredRoleFallback({
      role: 'working',
      settings,
      availableProfiles: [],
      errorKind: 'server_error',
      currentModel: 'gpt-5.5',
    });

    expect(decision).toEqual({
      kind: 'use_fallback',
      role: 'working',
      target: {
        kind: 'model',
        model: 'gpt-5.4-mini',
        encoded: 'model:gpt-5.4-mini',
      },
    });
  });

  it('resolves profile fallback when target profile is routable', () => {
    const profile = makeProfile({ id: 'backup-profile', model: 'gpt-5.5-mini' });
    const settings = {
      models: {
        workingFallback: 'profile:backup-profile',
      },
      localModel: {
        profiles: [profile],
        activeProfileId: null,
      },
    } as Partial<AppSettings>;

    const decision = resolveConfiguredRoleFallback({
      role: 'working',
      settings,
      availableProfiles: [profile],
      errorKind: 'model_unavailable',
      currentModel: 'gpt-5.5',
    });

    expect(decision).toEqual({
      kind: 'use_fallback',
      role: 'working',
      target: {
        kind: 'profile',
        profileId: 'backup-profile',
        profile,
        encoded: 'profile:backup-profile',
      },
    });
  });

  it('resolves configured background profile fallback for model_unavailable errors', () => {
    const backup = makeProfile({ id: 'bg-backup', model: 'gpt-5.4-mini' });
    const settings = {
      backgroundFallback: 'profile:bg-backup',
      localModel: {
        profiles: [backup],
        activeProfileId: null,
      },
    } as Partial<AppSettings>;

    const decision = resolveConfiguredRoleFallback({
      role: 'background',
      settings,
      availableProfiles: [backup],
      errorKind: 'model_unavailable',
      currentModel: 'gpt-5.5',
      currentProfileId: 'codex-primary',
    });

    expect(decision).toEqual({
      kind: 'use_fallback',
      role: 'background',
      target: {
        kind: 'profile',
        profileId: 'bg-backup',
        profile: backup,
        encoded: 'profile:bg-backup',
      },
    });
  });

  it('skips when fallback points to same effective target or was already attempted', () => {
    const sameTarget = resolveConfiguredRoleFallback({
      role: 'working',
      settings: { models: { workingFallback: 'model:gpt-5.5' } } as Partial<AppSettings>,
      errorKind: 'server_error',
      currentModel: 'gpt-5.5',
    });
    expect(sameTarget).toEqual({ kind: 'skip', role: 'working', reason: 'skip_same_target' });

    const attempted = resolveConfiguredRoleFallback({
      role: 'working',
      settings: { models: { workingFallback: 'model:gpt-5.4-mini' } } as Partial<AppSettings>,
      attempted: true,
      errorKind: 'server_error',
      currentModel: 'gpt-5.5',
    });
    expect(attempted).toEqual({ kind: 'skip', role: 'working', reason: 'skip_already_attempted' });
  });

  it('skips non-recoverable errors and unroutable profile fallbacks', () => {
    const nonRecoverable = resolveConfiguredRoleFallback({
      role: 'thinking',
      settings: { models: { thinkingFallback: 'model:gpt-5.5' } } as Partial<AppSettings>,
      errorKind: 'invalid_request',
      currentModel: 'claude-opus-4-7',
    });
    expect(nonRecoverable).toEqual({ kind: 'skip', role: 'thinking', reason: 'skip_not_recoverable' });

    const unroutable = resolveConfiguredRoleFallback({
      role: 'working',
      settings: { models: { workingFallback: 'profile:missing' } } as Partial<AppSettings>,
      availableProfiles: [makeProfile({ id: 'different-profile' })],
      errorKind: 'server_error',
      currentModel: 'gpt-5.5',
    });
    expect(unroutable).toEqual({ kind: 'skip', role: 'working', reason: 'skip_unroutable' });
  });

  it('annotates and reads runtime role metadata without mutating user-visible message text', () => {
    const error = new Error('planner overloaded');
    annotateModelRuntimeRole(error, { role: 'thinking', model: 'claude-opus-4-7', phase: 'planning' });

    expect(error.message).toBe('planner overloaded');
    expect(getModelRuntimeRoleMetadata(error)).toEqual({
      role: 'thinking',
      model: 'claude-opus-4-7',
      phase: 'planning',
    });
  });
});
