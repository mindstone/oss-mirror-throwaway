import { describe, expect, it } from 'vitest';
import type { ActiveProvider, AppSettings, ModelProfile } from '@shared/types';
import { createProfileConnectivity } from '@shared/utils/connectivityHelpers';
import { resolveRoleAssignment, resolveAllRoleAssignments } from '../roleAssignment';
import { resolveDefaultModelForRole, type ModelRole } from '../modelRoleResolver';

function makeProfile(overrides: Partial<ModelProfile> = {}): ModelProfile {
  return {
    id: 'p-1',
    name: 'My GPT 5.5',
    providerType: 'openai',
    serverUrl: 'https://api.openai.com/v1',
    model: 'gpt-5.5',
    apiKey: 'fake',
    enabled: true,
    createdAt: 1_700_000_000_000,
    ...overrides,
  };
}

function makeSettings(overrides: Partial<AppSettings> = {}): AppSettings {
  return {
    activeProvider: 'anthropic',
    models: {
      apiKey: 'fake-anthropic-key',
      model: 'claude-sonnet-4-6',
      authMethod: 'api-key',
      permissionMode: 'bypassPermissions',
      planMode: true,
      thinkingEffort: 'high',
      extendedContext: false,
    } as AppSettings['models'],
    localModel: { profiles: [], activeProfileId: null },
    ...overrides,
  } as AppSettings;
}

describe('resolveRoleAssignment — working role', () => {
  it('reports ok with model source when only `models.model` is set', () => {
    const settings = makeSettings();
    const a = resolveRoleAssignment('working', settings);
    expect(a.status).toEqual({ kind: 'ok', source: 'model' });
    expect(a.primary).toEqual({ kind: 'model', modelId: 'claude-sonnet-4-6' });
    expect(a.effectiveModelId).toBe('claude-sonnet-4-6');
    expect(a.warning).toBeNull();
  });

  it('reports ok with profile source when workingProfileId points at a usable profile', () => {
    const profile = makeProfile({ id: 'w-1', model: 'gpt-5.5' });
    const settings = makeSettings({
      models: {
        apiKey: 'fake-key',
        model: 'claude-sonnet-4-6',
        workingProfileId: 'w-1',
        authMethod: 'api-key',
        permissionMode: 'bypassPermissions',
        planMode: true,
        thinkingEffort: 'high',
        extendedContext: false,
      } as AppSettings['models'],
      localModel: { profiles: [profile], activeProfileId: null },
    });
    const a = resolveRoleAssignment('working', settings);
    expect(a.status).toEqual({ kind: 'ok', source: 'profile' });
    expect(a.primary).toEqual({ kind: 'profile', profileId: 'w-1' });
    expect(a.effectiveModelId).toBe('gpt-5.5');
  });

  it('reports missing-profile when workingProfileId points at a deleted profile and no model fallback exists', () => {
    const settings = makeSettings({
      models: {
        apiKey: 'fake-key',
        workingProfileId: 'deleted',
        model: '',
        authMethod: 'api-key',
        permissionMode: 'bypassPermissions',
        planMode: true,
        thinkingEffort: 'high',
        extendedContext: false,
      } as AppSettings['models'],
      localModel: { profiles: [], activeProfileId: null },
    });
    const a = resolveRoleAssignment('working', settings);
    expect(a.status).toEqual({ kind: 'missing-profile', profileId: 'deleted' });
    expect(a.warning).toBe('Selected profile is no longer available. Pick another model before Rebel can use this role.');
    expect(a.warning).not.toContain('default');
    expect(a.warningCta).toBe('Pick another model');
    expect(a.effectiveModelId).toBeNull();
  });

  it('reports incomplete-profile when workingProfileId references an unselectable profile and no model fallback exists', () => {
    const profile = makeProfile({ id: 'w-broken', serverUrl: '', providerType: 'openai' });
    const settings = makeSettings({
      models: {
        apiKey: 'fake-key',
        workingProfileId: 'w-broken',
        model: '',
        authMethod: 'api-key',
        permissionMode: 'bypassPermissions',
        planMode: true,
        thinkingEffort: 'high',
        extendedContext: false,
      } as AppSettings['models'],
      localModel: { profiles: [profile], activeProfileId: null },
    });
    const a = resolveRoleAssignment('working', settings);
    expect(a.status).toEqual({ kind: 'incomplete-profile', profileId: 'w-broken' });
    expect(a.warningCta).toBe('Finish setup');
  });

  it('reports profile-unavailable-model-active when an unusable working profile has a model fallback', () => {
    const profile = makeProfile({ id: 'w-broken', name: 'Broken profile', serverUrl: '', model: 'gpt-5.5' });
    const settings = makeSettings({
      models: {
        apiKey: 'fake-key',
        workingProfileId: 'w-broken',
        model: 'claude-sonnet-4-6',
        authMethod: 'api-key',
        permissionMode: 'bypassPermissions',
        planMode: true,
        thinkingEffort: 'high',
        extendedContext: false,
      } as AppSettings['models'],
      localModel: { profiles: [profile], activeProfileId: null },
    });

    const a = resolveRoleAssignment('working', settings);

    expect(a.status).toEqual({ kind: 'profile-unavailable-model-active', profileId: 'w-broken' });
    expect(a.display.modelLabel).toBe('Sonnet 4.6');
    expect(a.warning).toBe('Selected profile is unavailable. Using Sonnet 4.6 for now.');
    expect(a.warningCta).toBe('Review profile');
    expect(a.effectiveModelId).toBe('claude-sonnet-4-6');
  });

  it('reports assigned-but-disconnected when the selected profile exists but its source connection is offline', () => {
    const profile = makeProfile({
      id: 'codex-disconnected',
      name: 'ChatGPT Pro GPT 5.5',
      providerType: 'openai',
      routeSurface: 'subscription',
      authSource: 'codex-subscription',
      profileSource: 'connection',
      serverUrl: 'https://api.openai.com/v1',
    });
    const settings = makeSettings({
      models: {
        apiKey: 'fake-key',
        model: 'claude-sonnet-4-6',
        workingProfileId: profile.id,
        authMethod: 'api-key',
        permissionMode: 'bypassPermissions',
        planMode: true,
        thinkingEffort: 'high',
        extendedContext: false,
      } as AppSettings['models'],
      localModel: { profiles: [profile], activeProfileId: null },
    });

    const a = resolveRoleAssignment('working', settings, {
      profiles: [profile],
      connectivity: createProfileConnectivity({ codexConnected: false }),
    });

    expect(a.status).toEqual({
      kind: 'assigned-but-disconnected',
      profileId: 'codex-disconnected',
      providerLabel: 'ChatGPT Pro',
    });
    expect(a.warning).toBe('Reconnect ChatGPT Pro to use this role.');
    expect(a.effectiveModelId).toBeNull();
  });
});

describe('resolveRoleAssignment — thinking role', () => {
  it('reports the user-bug case: stale thinkingProfileId + valid thinkingModel = missing-profile', () => {
    const settings = makeSettings({
      models: {
        apiKey: 'fake-key',
        model: 'claude-sonnet-4-6',
        thinkingModel: 'claude-opus-4-7',
        thinkingProfileId: 'deleted-profile',
        authMethod: 'api-key',
        permissionMode: 'bypassPermissions',
        planMode: true,
        thinkingEffort: 'high',
        extendedContext: false,
      } as AppSettings['models'],
      localModel: { profiles: [], activeProfileId: null },
    });
    const a = resolveRoleAssignment('thinking', settings);
    expect(a.status).toEqual({ kind: 'missing-profile', profileId: 'deleted-profile' });
    expect(a.warning).toBe('Selected profile is no longer available. Pick another model before Rebel can use this role.');
    expect(a.warning).not.toContain('default');
    expect(a.warningCta).toBe('Pick another model');
    expect(a.effectiveModelId).toBeNull();
  });

  it('reports profile-unavailable-model-active when an unusable thinking profile has a model fallback', () => {
    const profile = makeProfile({ id: 't-broken', name: 'Stale thinking profile', enabled: false });
    const settings = makeSettings({
      models: {
        apiKey: 'fake-key',
        model: 'claude-sonnet-4-6',
        thinkingModel: 'claude-opus-4-7',
        thinkingProfileId: 't-broken',
        authMethod: 'api-key',
        permissionMode: 'bypassPermissions',
        planMode: true,
        thinkingEffort: 'high',
        extendedContext: false,
      } as AppSettings['models'],
      localModel: { profiles: [profile], activeProfileId: null },
    });

    const a = resolveRoleAssignment('thinking', settings);

    expect(a.status).toEqual({ kind: 'profile-unavailable-model-active', profileId: 't-broken' });
    expect(a.display.modelLabel).toBe('Opus 4.7');
    expect(a.warning).toBe('Selected profile is unavailable. Using Opus 4.7 for now.');
    expect(a.warningCta).toBe('Review profile');
    expect(a.effectiveModelId).toBe('claude-opus-4-7');
  });

  it('reports off when neither thinkingProfileId nor thinkingModel is set', () => {
    const settings = makeSettings();
    const a = resolveRoleAssignment('thinking', settings);
    expect(a.primary).toEqual({ kind: 'off' });
    expect(a.status).toEqual({ kind: 'off' });
    expect(a.warning).toBeNull();
  });

  it('reports ok when thinkingModel resolves via catalog', () => {
    const settings = makeSettings({
      models: {
        apiKey: 'fake-key',
        model: 'claude-sonnet-4-6',
        thinkingModel: 'claude-opus-4-7',
        authMethod: 'api-key',
        permissionMode: 'bypassPermissions',
        planMode: true,
        thinkingEffort: 'high',
        extendedContext: false,
      } as AppSettings['models'],
    });
    const a = resolveRoleAssignment('thinking', settings);
    expect(a.status).toEqual({ kind: 'ok', source: 'model' });
    expect(a.effectiveModelId).toBe('claude-opus-4-7');
  });
});

describe('resolveRoleAssignment — background role', () => {
  it('decodes profile: prefix on behindTheScenesModel', () => {
    const profile = makeProfile({ id: 'fast-1', model: 'gpt-4.1-mini' });
    const settings = makeSettings({
      behindTheScenesModel: 'profile:fast-1',
      localModel: { profiles: [profile], activeProfileId: null },
    });
    const a = resolveRoleAssignment('background', settings);
    expect(a.primary).toEqual({ kind: 'profile', profileId: 'fast-1' });
    expect(a.status).toEqual({ kind: 'ok', source: 'profile' });
    expect(a.effectiveModelId).toBe('gpt-4.1-mini');
  });

  it('decodes a bare model string', () => {
    const settings = makeSettings({ behindTheScenesModel: 'claude-haiku-4-5' });
    const a = resolveRoleAssignment('background', settings);
    expect(a.primary).toEqual({ kind: 'model', modelId: 'claude-haiku-4-5' });
    expect(a.status).toEqual({ kind: 'ok', source: 'model' });
  });

  it('flags a stale profile reference via behindTheScenesModel', () => {
    const settings = makeSettings({
      behindTheScenesModel: 'profile:deleted-fast',
      localModel: { profiles: [], activeProfileId: null },
    });
    const a = resolveRoleAssignment('background', settings);
    expect(a.status.kind).toBe('missing-profile');
    expect(a.warning).toBe('Selected profile is no longer available. Pick another model before Rebel can use this role.');
    expect(a.warning).not.toContain('default');
    expect(a.warningCta).toBe('Pick another model');
    expect(a.effectiveModelId).toBeNull();
  });
});

describe('resolveRoleAssignment — recovery role', () => {
  it('returns auto when neither field is set', () => {
    const settings = makeSettings();
    const a = resolveRoleAssignment('recovery', settings);
    expect(a.primary).toEqual({ kind: 'auto' });
    expect(a.status).toEqual({ kind: 'auto' });
    expect(a.effectiveModelId).toBeNull();
  });

  it('returns model when longContextFallbackModel is set', () => {
    const settings = makeSettings({
      models: {
        apiKey: 'fake-key',
        model: 'claude-sonnet-4-6',
        longContextFallbackModel: 'claude-opus-4-7',
        authMethod: 'api-key',
        permissionMode: 'bypassPermissions',
        planMode: true,
        thinkingEffort: 'high',
        extendedContext: false,
      } as AppSettings['models'],
    });
    const a = resolveRoleAssignment('recovery', settings);
    expect(a.primary).toEqual({ kind: 'model', modelId: 'claude-opus-4-7' });
    expect(a.effectiveModelId).toBe('claude-opus-4-7');
  });

  it('returns missing-profile when longContextFallbackProfileId points at a deleted profile', () => {
    const settings = makeSettings({
      models: {
        apiKey: 'fake-key',
        longContextFallbackProfileId: 'deleted-recovery',
        authMethod: 'api-key',
        permissionMode: 'bypassPermissions',
        planMode: true,
        thinkingEffort: 'high',
        extendedContext: false,
      } as AppSettings['models'],
      localModel: { profiles: [], activeProfileId: null },
    });
    const a = resolveRoleAssignment('recovery', settings);
    expect(a.status.kind).toBe('missing-profile');
  });
});

describe('resolveRoleAssignment — runtime parity for effective model availability', () => {
  const runtimeCases: Array<{
    name: string;
    uiRole: 'working' | 'thinking' | 'background';
    runtimeRole: ModelRole;
    settings: AppSettings;
    profiles: ModelProfile[];
  }> = [
    {
      name: 'deleted thinking profile with thinkingModel still set',
      uiRole: 'thinking',
      runtimeRole: 'thinking',
      profiles: [],
      settings: makeSettings({
        models: {
          model: 'claude-sonnet-4-6',
          thinkingModel: 'claude-opus-4-7',
          thinkingProfileId: 'deleted-thinking',
        } as AppSettings['models'],
        localModel: { profiles: [], activeProfileId: null },
      }),
    },
    {
      name: 'unusable thinking profile with thinkingModel fallback',
      uiRole: 'thinking',
      runtimeRole: 'thinking',
      profiles: [makeProfile({ id: 'unusable-thinking', enabled: false })],
      settings: makeSettings({
        models: {
          model: 'claude-sonnet-4-6',
          thinkingModel: 'claude-opus-4-7',
          thinkingProfileId: 'unusable-thinking',
        } as AppSettings['models'],
        localModel: {
          profiles: [makeProfile({ id: 'unusable-thinking', enabled: false })],
          activeProfileId: null,
        },
      }),
    },
    {
      name: 'unusable thinking profile without thinkingModel fallback',
      uiRole: 'thinking',
      runtimeRole: 'thinking',
      profiles: [makeProfile({ id: 'unusable-thinking-no-model', serverUrl: '' })],
      settings: makeSettings({
        models: {
          model: 'claude-sonnet-4-6',
          thinkingModel: '',
          thinkingProfileId: 'unusable-thinking-no-model',
        } as AppSettings['models'],
        localModel: {
          profiles: [makeProfile({ id: 'unusable-thinking-no-model', serverUrl: '' })],
          activeProfileId: null,
        },
      }),
    },
    {
      name: 'deleted working profile with working model still set',
      uiRole: 'working',
      runtimeRole: 'working',
      profiles: [],
      settings: makeSettings({
        models: {
          model: 'claude-sonnet-4-6',
          workingProfileId: 'deleted-working',
        } as AppSettings['models'],
        localModel: { profiles: [], activeProfileId: null },
      }),
    },
    {
      name: 'unusable working profile with model fallback',
      uiRole: 'working',
      runtimeRole: 'working',
      profiles: [makeProfile({ id: 'unusable-working', serverUrl: '' })],
      settings: makeSettings({
        models: {
          model: 'claude-sonnet-4-6',
          workingProfileId: 'unusable-working',
        } as AppSettings['models'],
        localModel: {
          profiles: [makeProfile({ id: 'unusable-working', serverUrl: '' })],
          activeProfileId: null,
        },
      }),
    },
    {
      name: 'unusable working profile without model fallback',
      uiRole: 'working',
      runtimeRole: 'working',
      profiles: [makeProfile({ id: 'unusable-working-no-model', serverUrl: '' })],
      settings: makeSettings({
        models: {
          model: '',
          workingProfileId: 'unusable-working-no-model',
        } as AppSettings['models'],
        localModel: {
          profiles: [makeProfile({ id: 'unusable-working-no-model', serverUrl: '' })],
          activeProfileId: null,
        },
      }),
    },
    {
      name: 'background profile maps to runtime background role',
      uiRole: 'background',
      runtimeRole: 'background',
      profiles: [makeProfile({ id: 'fast-profile', model: 'gpt-4.1-mini' })],
      settings: makeSettings({
        behindTheScenesModel: 'profile:fast-profile',
        localModel: {
          profiles: [makeProfile({ id: 'fast-profile', model: 'gpt-4.1-mini' })],
          activeProfileId: null,
        },
      }),
    },
    {
      name: 'deleted background profile maps to runtime background failure',
      uiRole: 'background',
      runtimeRole: 'background',
      profiles: [],
      settings: makeSettings({
        behindTheScenesModel: 'profile:deleted-fast',
        localModel: { profiles: [], activeProfileId: null },
      }),
    },
    {
      name: 'unusable background profile maps to runtime background failure',
      uiRole: 'background',
      runtimeRole: 'background',
      profiles: [makeProfile({ id: 'unusable-fast', enabled: false })],
      settings: makeSettings({
        behindTheScenesModel: 'profile:unusable-fast',
        localModel: {
          profiles: [makeProfile({ id: 'unusable-fast', enabled: false })],
          activeProfileId: null,
        },
      }),
    },
    {
      name: 'healthy thinking profile matches runtime effective model',
      uiRole: 'thinking',
      runtimeRole: 'thinking',
      profiles: [makeProfile({ id: 'good-thinking', model: 'claude-opus-4-7' })],
      settings: makeSettings({
        models: {
          model: 'claude-sonnet-4-6',
          thinkingProfileId: 'good-thinking',
        } as AppSettings['models'],
        localModel: {
          profiles: [makeProfile({ id: 'good-thinking', model: 'claude-opus-4-7' })],
          activeProfileId: null,
        },
      }),
    },
  ];

  it.each(runtimeCases)('$name', ({ uiRole, runtimeRole, settings, profiles }) => {
    const assignment = resolveRoleAssignment(uiRole, settings, { profiles });
    const runtime = resolveDefaultModelForRole(runtimeRole, settings, profiles);

    expect(assignment.effectiveModelId).toBe(runtime.ok ? runtime.model : null);
    expect(assignment.effectiveModelId !== null).toBe(runtime.ok);
  });
});

describe('resolveRoleAssignment — fallback decoding', () => {
  it('decodes thinkingFallback to a fallback ModelChoice', () => {
    const settings = makeSettings({
      models: {
        apiKey: 'fake-key',
        thinkingModel: 'claude-opus-4-7',
        thinkingFallback: 'model:claude-sonnet-4-6',
        authMethod: 'api-key',
        permissionMode: 'bypassPermissions',
        planMode: true,
        thinkingEffort: 'high',
        extendedContext: false,
      } as AppSettings['models'],
    });
    const a = resolveRoleAssignment('thinking', settings);
    expect(a.fallback).toEqual({ kind: 'model', modelId: 'claude-sonnet-4-6' });
    expect(a.fallbackDisplay).not.toBeNull();
    expect(a.fallbackDisplay?.modelLabel).toBe('Sonnet 4.6');
    expect(a.fallbackDisplay?.providerLabel).toBe('Anthropic');
  });
});

describe('resolveAllRoleAssignments', () => {
  it('returns the four roles with the user-bug case showing missing-profile only on Thinking', () => {
    const settings = makeSettings({
      models: {
        apiKey: 'fake-key',
        model: 'claude-sonnet-4-6',
        thinkingModel: 'claude-opus-4-7',
        thinkingProfileId: 'deleted-profile',
        authMethod: 'api-key',
        permissionMode: 'bypassPermissions',
        planMode: true,
        thinkingEffort: 'high',
        extendedContext: false,
      } as AppSettings['models'],
      localModel: { profiles: [], activeProfileId: null },
    });

    const all = resolveAllRoleAssignments(settings);
    expect(all.working.status).toEqual({ kind: 'ok', source: 'model' });
    expect(all.thinking.status).toEqual({ kind: 'missing-profile', profileId: 'deleted-profile' });
    expect(all.background.status.kind).toBe('ok');
    expect(all.recovery.status).toEqual({ kind: 'auto' });
  });
});

describe('resolveRoleAssignment — mindstone subscription billing', () => {
  it('reports billingSource=subscription when mindstone is active and the role resolves to an OpenRouter-catalog model', () => {
    const settings = makeSettings({
      activeProvider: 'mindstone',
      models: {
        apiKey: 'fake-key',
        model: 'anthropic/claude-sonnet-4-6',
        authMethod: 'api-key',
        permissionMode: 'bypassPermissions',
        planMode: true,
        thinkingEffort: 'high',
        extendedContext: false,
      } as AppSettings['models'],
    });
    const a = resolveRoleAssignment('working', settings);
    expect(a.status).toEqual({ kind: 'ok', source: 'model' });
    expect(a.display.billingSource).toBe('subscription');
    expect(a.display.providerLabel).toBe('OpenRouter');
  });

  it('regression: reports billingSource=pool when openrouter is active and the role resolves to the same OR-catalog model', () => {
    const settings = makeSettings({
      activeProvider: 'openrouter',
      models: {
        apiKey: 'fake-key',
        model: 'anthropic/claude-sonnet-4-6',
        authMethod: 'api-key',
        permissionMode: 'bypassPermissions',
        planMode: true,
        thinkingEffort: 'high',
        extendedContext: false,
      } as AppSettings['models'],
    });
    const a = resolveRoleAssignment('working', settings);
    expect(a.status).toEqual({ kind: 'ok', source: 'model' });
    expect(a.display.billingSource).toBe('pool');
  });
});

describe('resolveRoleAssignment — activeProvider display characterization', () => {
  function displaySnapshotFor(
    activeProvider: ActiveProvider | undefined,
    settingsOverrides: Partial<AppSettings> = {},
  ) {
    const settings = makeSettings({
      activeProvider,
      models: {
        apiKey: 'fake-key',
        model: '',
        authMethod: 'api-key',
        permissionMode: 'bypassPermissions',
        planMode: true,
        thinkingEffort: 'high',
        extendedContext: false,
      } as AppSettings['models'],
      localModel: { profiles: [], activeProfileId: null },
      ...settingsOverrides,
    });
    const assignment = resolveRoleAssignment('working', settings);
    return {
      activeProvider,
      primary: assignment.primary,
      display: assignment.display,
      status: assignment.status,
      effectiveModelId: assignment.effectiveModelId,
      isUncatalogued: assignment.isUncatalogued,
    };
  }

  it('snapshots provider-dependent default working model display', () => {
    // CHARACTERIZATION: documents current behavior, not necessarily desired.
    expect(([undefined, 'anthropic', 'openrouter', 'codex', 'mindstone'] as const)
      .map((activeProvider) => displaySnapshotFor(activeProvider))).toMatchInlineSnapshot(`
        [
          {
            "activeProvider": undefined,
            "display": {
              "billingSource": "pay-per-use",
              "modelLabel": "Sonnet 4.6",
              "providerLabel": "Anthropic",
            },
            "effectiveModelId": "claude-sonnet-4-6",
            "isUncatalogued": false,
            "primary": {
              "kind": "model",
              "modelId": "claude-sonnet-4-6",
            },
            "status": {
              "kind": "ok",
              "source": "model",
            },
          },
          {
            "activeProvider": "anthropic",
            "display": {
              "billingSource": "pay-per-use",
              "modelLabel": "Sonnet 4.6",
              "providerLabel": "Anthropic",
            },
            "effectiveModelId": "claude-sonnet-4-6",
            "isUncatalogued": false,
            "primary": {
              "kind": "model",
              "modelId": "claude-sonnet-4-6",
            },
            "status": {
              "kind": "ok",
              "source": "model",
            },
          },
          {
            "activeProvider": "openrouter",
            "display": {
              "billingSource": "pool",
              "modelLabel": "GPT-5.5",
              "providerLabel": "OpenRouter",
            },
            "effectiveModelId": "openai/gpt-5.5",
            "isUncatalogued": false,
            "primary": {
              "kind": "model",
              "modelId": "openai/gpt-5.5",
            },
            "status": {
              "kind": "ok",
              "source": "model",
            },
          },
          {
            "activeProvider": "codex",
            "display": {
              "billingSource": "subscription",
              "modelLabel": "GPT-5.5",
              "providerLabel": "ChatGPT Pro",
            },
            "effectiveModelId": "gpt-5.5",
            "isUncatalogued": false,
            "primary": {
              "kind": "model",
              "modelId": "gpt-5.5",
            },
            "status": {
              "kind": "ok",
              "source": "model",
            },
          },
          {
            "activeProvider": "mindstone",
            "display": {
              "billingSource": "subscription",
              "modelLabel": "DeepSeek V4 Flash",
              "providerLabel": "OpenRouter",
            },
            "effectiveModelId": "deepseek/deepseek-v4-flash",
            "isUncatalogued": false,
            "primary": {
              "kind": "model",
              "modelId": "deepseek/deepseek-v4-flash",
            },
            "status": {
              "kind": "ok",
              "source": "model",
            },
          },
        ]
      `);
  });

  it('snapshots provider-dependent uncatalogued bare-model display', () => {
    // CHARACTERIZATION: documents current behavior, not necessarily desired.
    expect((['anthropic', 'openrouter', 'codex', 'mindstone'] as const)
      .map((activeProvider) => displaySnapshotFor(activeProvider, {
        models: {
          apiKey: 'fake-key',
          model: 'openai/gpt-5.5',
          authMethod: 'api-key',
          permissionMode: 'bypassPermissions',
          planMode: true,
          thinkingEffort: 'high',
          extendedContext: false,
        } as AppSettings['models'],
      }))).toMatchInlineSnapshot(`
        [
          {
            "activeProvider": "anthropic",
            "display": {
              "billingSource": "pool",
              "modelLabel": "GPT-5.5",
              "providerLabel": "OpenRouter",
            },
            "effectiveModelId": "openai/gpt-5.5",
            "isUncatalogued": true,
            "primary": {
              "kind": "model",
              "modelId": "openai/gpt-5.5",
            },
            "status": {
              "kind": "ok",
              "source": "model",
            },
          },
          {
            "activeProvider": "openrouter",
            "display": {
              "billingSource": "pool",
              "modelLabel": "GPT-5.5",
              "providerLabel": "OpenRouter",
            },
            "effectiveModelId": "openai/gpt-5.5",
            "isUncatalogued": false,
            "primary": {
              "kind": "model",
              "modelId": "openai/gpt-5.5",
            },
            "status": {
              "kind": "ok",
              "source": "model",
            },
          },
          {
            "activeProvider": "codex",
            "display": {
              "billingSource": "pool",
              "modelLabel": "GPT-5.5",
              "providerLabel": "OpenRouter",
            },
            "effectiveModelId": "openai/gpt-5.5",
            "isUncatalogued": true,
            "primary": {
              "kind": "model",
              "modelId": "openai/gpt-5.5",
            },
            "status": {
              "kind": "ok",
              "source": "model",
            },
          },
          {
            "activeProvider": "mindstone",
            "display": {
              "billingSource": "subscription",
              "modelLabel": "GPT-5.5",
              "providerLabel": "OpenRouter",
            },
            "effectiveModelId": "openai/gpt-5.5",
            "isUncatalogued": false,
            "primary": {
              "kind": "model",
              "modelId": "openai/gpt-5.5",
            },
            "status": {
              "kind": "ok",
              "source": "model",
            },
          },
        ]
      `);
  });

  it('snapshots virtual-profile unwrap and billing display under activeProvider variants', () => {
    // CHARACTERIZATION: documents current behavior, not necessarily desired.
    const virtualProfile = makeProfile({
      id: '__virtual-working',
      name: 'Virtual working',
      model: 'claude-opus-4-7',
      providerType: 'anthropic',
      isVirtual: true,
    });

    expect((['anthropic', 'openrouter', 'codex', 'mindstone'] as const).map((activeProvider) => {
      const settings = makeSettings({
        activeProvider,
        models: {
          apiKey: 'fake-key',
          model: '',
          workingProfileId: virtualProfile.id,
          authMethod: 'api-key',
          permissionMode: 'bypassPermissions',
          planMode: true,
          thinkingEffort: 'high',
          extendedContext: false,
        } as AppSettings['models'],
        localModel: { profiles: [virtualProfile], activeProfileId: null },
      });
      const assignment = resolveRoleAssignment('working', settings);
      return {
        activeProvider,
        primary: assignment.primary,
        display: assignment.display,
        status: assignment.status,
        effectiveModelId: assignment.effectiveModelId,
        isUncatalogued: assignment.isUncatalogued,
      };
    })).toMatchInlineSnapshot(`
      [
        {
          "activeProvider": "anthropic",
          "display": {
            "billingSource": "pay-per-use",
            "modelLabel": "Opus 4.7",
            "providerLabel": "Anthropic",
          },
          "effectiveModelId": "claude-opus-4-7",
          "isUncatalogued": false,
          "primary": {
            "kind": "model",
            "modelId": "claude-opus-4-7",
          },
          "status": {
            "kind": "ok",
            "source": "model",
          },
        },
        {
          "activeProvider": "openrouter",
          "display": {
            "billingSource": "pay-per-use",
            "modelLabel": "Opus 4.7",
            "providerLabel": "Anthropic",
          },
          "effectiveModelId": "claude-opus-4-7",
          "isUncatalogued": false,
          "primary": {
            "kind": "model",
            "modelId": "claude-opus-4-7",
          },
          "status": {
            "kind": "ok",
            "source": "model",
          },
        },
        {
          "activeProvider": "codex",
          "display": {
            "billingSource": "pay-per-use",
            "modelLabel": "Opus 4.7",
            "providerLabel": "Anthropic",
          },
          "effectiveModelId": "claude-opus-4-7",
          "isUncatalogued": false,
          "primary": {
            "kind": "model",
            "modelId": "claude-opus-4-7",
          },
          "status": {
            "kind": "ok",
            "source": "model",
          },
        },
        {
          "activeProvider": "mindstone",
          "display": {
            "billingSource": "pay-per-use",
            "modelLabel": "Opus 4.7",
            "providerLabel": "Anthropic",
          },
          "effectiveModelId": "claude-opus-4-7",
          "isUncatalogued": false,
          "primary": {
            "kind": "model",
            "modelId": "claude-opus-4-7",
          },
          "status": {
            "kind": "ok",
            "source": "model",
          },
        },
      ]
    `);
  });
});
