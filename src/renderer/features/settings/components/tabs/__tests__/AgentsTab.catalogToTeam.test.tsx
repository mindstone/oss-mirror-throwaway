// @vitest-environment happy-dom
 

import React, { act, useEffect, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_LOCAL_MODEL_SETTINGS,
  DEFAULT_OPENROUTER_SETTINGS,
  type AppSettings,
  type ModelSettings,
} from '@shared/types';
import { PROVIDER_CATALOGS } from '@shared/data/providerCatalogs';
import { materializeCatalogProfile } from '@shared/utils/catalogMaterialization';
import { AgentsTab } from '../AgentsTab';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('@renderer/features/flow-panels/FlowPanelsProvider', () => ({
  useFlowPanels: () => ({
    navigateToLibraryLens: vi.fn(),
  }),
}));

vi.mock('@renderer/hooks/useOpenRouterSetup', () => ({
  useOpenRouterSetup: () => ({
    handleConnect: vi.fn(),
    handleDisconnect: vi.fn(async () => {}),
  }),
}));

vi.mock('@renderer/components/ui', async () => {
  const actual = await vi.importActual<typeof import('@renderer/components/ui')>('@renderer/components/ui');
  return {
    ...actual,
    useToast: () => ({
      showToast: vi.fn(),
    }),
  };
});

vi.mock('../ProviderLogos', () => ({
  OpenRouterLogo: () => <span aria-hidden="true">OR</span>,
  OpenAILogo: () => <span aria-hidden="true">OA</span>,
  AnthropicLogo: () => <span aria-hidden="true">AN</span>,
}));

vi.mock('../ClaudeMaxSetupDialog', () => ({
  ClaudeMaxSetupDialog: () => null,
}));

vi.mock('@renderer/components/OpenRouterPrivacyModal', () => ({
  OpenRouterPrivacyModal: () => null,
}));

vi.mock('../LocalInferenceSection', () => ({
  LocalInferenceSection: () => <div data-testid="local-inference-section" />,
}));

vi.mock('../BtsTaskOverrides', () => ({
  BtsTaskOverrides: () => <div data-testid="bts-task-overrides" />,
}));

vi.mock('../LocalSttModelSection', () => ({
  LocalSttModelSection: () => <div data-testid="local-stt-model-section" />,
}));

interface Mounted {
  container: HTMLDivElement;
  root: Root;
  unmount: () => void;
}

type SettingsOverrides = Partial<Omit<AppSettings, 'claude' | 'models' | 'openRouter' | 'localModel'>> & {
  claude?: Partial<ModelSettings>;
  models?: Partial<ModelSettings>;
  openRouter?: Partial<NonNullable<AppSettings['openRouter']>>;
  localModel?: Partial<NonNullable<AppSettings['localModel']>>;
};

function makeSettings(overrides: SettingsOverrides = {}): AppSettings {
  const {
    claude: claudeOverrides,
    models: modelsOverrides,
    openRouter: openRouterOverrides,
    localModel: localModelOverrides,
    ...rootOverrides
  } = overrides;
  const baseModels: ModelSettings = {
    apiKey: 'fake-anthropic-key',
    oauthToken: null,
    authMethod: 'api-key',
    model: 'openai/gpt-5.5',
    permissionMode: 'bypassPermissions',
    executablePath: null,
    planMode: false,
    extendedContext: true,
    thinkingEffort: 'high',
  };
  const base: AppSettings = {
    coreDirectory: null,
    mcpConfigFile: null,
    onboardingCompleted: false,
    userEmail: null,
    onboardingFirstCompletedAt: null,
    voice: {
      provider: 'openai-whisper',
      openaiApiKey: null,
      elevenlabsApiKey: null,
      model: 'gpt-4o-mini-transcribe-2025-12-15',
      ttsVoice: null,
      activationHotkey: null,
      activationHotkeyVoiceMode: true,
    },
    claude: baseModels,
    models: { ...baseModels },
    diagnostics: { debugBreadcrumbsUntil: null },
    openRouter: {
      ...DEFAULT_OPENROUTER_SETTINGS,
      enabled: true,
      oauthToken: 'or-token',
      selectedModel: 'openai/gpt-5.5',
    },
    providerKeys: { google: 'fake-google-key' },
    localModel: { ...DEFAULT_LOCAL_MODEL_SETTINGS, profiles: [] },
    activeProvider: 'openrouter',
  } as AppSettings;

  return {
    ...base,
    ...rootOverrides,
    ...(claudeOverrides ? { claude: { ...base.models, ...claudeOverrides } } : {}),
    models:
      modelsOverrides === undefined
        ? { ...base.models, ...(claudeOverrides ?? {}) }
        : ({
            ...(base.models ?? {}),
            ...modelsOverrides,
          } as ModelSettings),
    openRouter:
      openRouterOverrides === undefined
        ? base.openRouter
        : ({
            ...base.openRouter,
            ...openRouterOverrides,
          } as AppSettings['openRouter']),
    localModel:
      localModelOverrides === undefined
        ? base.localModel
        : ({
            ...base.localModel,
            ...localModelOverrides,
          } as AppSettings['localModel']),
  };
}

function mount(ui: React.ReactElement): Mounted {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(ui);
  });
  return {
    container,
    root,
    unmount: () => {
      act(() => {
        root.unmount();
      });
      container.remove();
    },
  };
}

async function flushAsyncWork(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
  });
}

function click(element: Element | null): void {
  if (!element) throw new Error('Missing clickable element');
  act(() => {
    element.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
  });
}

function Harness({
  initialSettings,
  onSettings,
}: {
  initialSettings: AppSettings;
  onSettings: (settings: AppSettings) => void;
}) {
  const [settings, setSettings] = useState(initialSettings);

  useEffect(() => {
    onSettings(settings);
  }, [onSettings, settings]);

  return (
    <AgentsTab
      draftSettings={settings}
      updateDraft={(key, value) => {
        setSettings((prev) => ({ ...prev, [key]: value }));
      }}
      updateClaude={(key, value) => {
        setSettings((prev) => ({
          ...prev,
          models: {
            ...prev.models,
            [key]: value,
          } as ModelSettings,
        }));
      }}
      updateVoice={(key, value) => {
        setSettings((prev) => ({
          ...prev,
          voice: { ...prev.voice, [key]: value },
        }));
      }}
      markKeySticky={vi.fn()}
    />
  );
}

describe('AgentsTab catalog-to-team flow', () => {
  let mounted: Mounted | null = null;
  let latestSettings = makeSettings();
  let codexConnected = true;
  const codexEntry = PROVIDER_CATALOGS.openai[0]!;

  beforeEach(() => {
    latestSettings = makeSettings();
    codexConnected = true;
    Object.assign(window, {
      codexApi: {
        status: vi.fn(async () => ({ connected: codexConnected, accountEmail: 'test@example.com' })),
        login: vi.fn(async () => ({ success: true })),
        logout: vi.fn(async () => {}),
      },
      settingsApi: {
        update: vi.fn(async () => {}),
        validateClaudeKey: vi.fn(async () => ({ ok: true })),
        testModelChoice: vi.fn(async () => ({ success: true })),
      },
    });
  });

  afterEach(() => {
    mounted?.unmount();
    mounted = null;
    document.body.innerHTML = '';
    vi.clearAllMocks();
  });

  function renderWithSettings(settings: AppSettings = makeSettings()): Mounted {
    const view = mount(
      <Harness
        initialSettings={settings}
        onSettings={(next) => {
          latestSettings = next;
        }}
      />,
    );
    mounted = view;
    return view;
  }

  async function openCatalogPicker(view: Mounted): Promise<void> {
    click(view.container.querySelector('[data-testid="settings-models-add-button"]'));
    await flushAsyncWork();
    expect(document.body.querySelector('[data-testid="settings-models-choose-path-step"]')).not.toBeNull();
    expect(document.body.querySelector('[data-testid="settings-models-catalog-picker"]')).not.toBeNull();
  }

  it('adds a connected-provider catalog model to settings and the From your connections bucket', async () => {
    const view = renderWithSettings();
    await flushAsyncWork();

    await openCatalogPicker(view);
    expect(document.body.querySelector(
      `[data-testid="settings-models-picker-add-openai:subscription:${codexEntry.model}"]`,
    )?.textContent).toBe('Add to team');

    await act(async () => {
      document.body
        .querySelector(`[data-testid="settings-models-picker-add-openai:subscription:${codexEntry.model}"]`)
        ?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
      await Promise.resolve();
    });
    await flushAsyncWork();

    expect(document.body.querySelector('[data-testid="settings-models-wizard-dialog"]')).toBeNull();
    const profiles = latestSettings.localModel?.profiles ?? [];
    expect(profiles).toHaveLength(1);
    expect(profiles[0]).toEqual(expect.objectContaining({
      profileSource: 'connection',
      providerType: 'openai',
      routeSurface: 'subscription',
      model: codexEntry.model,
      // Non-premium rows keep Smart Picking membership on by default.
      routingEligible: true,
    }));
    expect(view.container.querySelector('[data-testid="settings-models-section-connections"]')?.textContent)
      .toContain('From your connections');

    await openCatalogPicker(view);
    expect(document.body.textContent).toContain('On your team');
  });

  // SKIPPED while Claude Fable 5 access is withdrawn (2026-06): Fable is the only
  // premium always-on catalog model, and it is hidden from the picker (isMainModel/
  // isAuxiliaryModel false), so this add-flow path isn't reachable. The
  // routingEligible:false behavior for premium always-on models still lives in the
  // code; un-skip this (and restore Fable's catalog flags) when access returns.
  it.skip('adds a premium always-on catalog model with Smart Picking OFF by default (GPT stage-12 review F3)', async () => {
    const view = renderWithSettings();
    await flushAsyncWork();

    await openCatalogPicker(view);
    const fableAddButton = document.body.querySelector(
      '[data-testid="settings-models-picker-add-anthropic:api-key:claude-fable-5"]',
    );
    expect(fableAddButton?.textContent).toBe('Add to team');

    await act(async () => {
      fableAddButton?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
      await Promise.resolve();
    });
    await flushAsyncWork();

    const profiles = latestSettings.localModel?.profiles ?? [];
    expect(profiles).toHaveLength(1);
    expect(profiles[0]).toEqual(expect.objectContaining({
      profileSource: 'connection',
      providerType: 'anthropic',
      routeSurface: 'api-key',
      model: 'claude-fable-5',
      // Premium 2x-cost class: on the team, but NOT silently in Smart
      // Picking — the user chips it on explicitly in ModelTeamSection.
      routingEligible: false,
    }));
  });

  it('keeps rapid double-clicks idempotent', async () => {
    const view = renderWithSettings();
    await flushAsyncWork();
    await openCatalogPicker(view);

    const addButton = document.body.querySelector(
      `[data-testid="settings-models-picker-add-openai:subscription:${codexEntry.model}"]`,
    );
    await act(async () => {
      addButton?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
      addButton?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
      await Promise.resolve();
    });
    await flushAsyncWork();

    const matchingProfiles = (latestSettings.localModel?.profiles ?? []).filter(
      (profile) =>
        profile.profileSource === 'connection' &&
        profile.providerType === 'openai' &&
        profile.routeSurface === 'subscription' &&
        profile.model === codexEntry.model,
    );
    expect(matchingProfiles).toHaveLength(1);
    const row = view.container.querySelector<HTMLElement>(
      `[data-profile-id="${matchingProfiles[0]?.id}"]`,
    );
    expect(row?.className).toContain('justAdded');
  });

  it('routes custom-model path to provider step and hides back in edit mode', async () => {
    const existingProfile = materializeCatalogProfile(codexEntry, { id: 'existing-codex-profile' });
    const view = renderWithSettings(makeSettings({
      localModel: { profiles: [existingProfile] },
    }));
    await flushAsyncWork();

    click(view.container.querySelector('[data-testid="settings-models-add-button"]'));
    await flushAsyncWork();
    click(document.body.querySelector('[data-testid="settings-models-choose-custom"]'));
    await flushAsyncWork();
    expect(document.body.textContent).toContain('Pick a provider to add a model from.');
    expect(document.body.querySelector('[data-testid="settings-models-wizard-back-button"]')).not.toBeNull();

    click(document.body.querySelector('[data-testid="settings-models-wizard-cancel-button"]'));
    await flushAsyncWork();

    const editButton = view.container.querySelector(
      '[data-testid="settings-models-profile-edit-existing-codex-profile"]',
    );
    click(editButton);
    await flushAsyncWork();
    expect(document.body.textContent).toContain('Edit model profile');
    expect(document.body.querySelector('[data-testid="settings-models-wizard-back-button"]')).toBeNull();
  });

  it('removes a materialised catalog profile from the picker', async () => {
    const existingProfile = materializeCatalogProfile(codexEntry, { id: 'existing-codex-profile' });
    const view = renderWithSettings(makeSettings({
      localModel: { profiles: [existingProfile] },
    }));
    await flushAsyncWork();

    await openCatalogPicker(view);
    await act(async () => {
      document.body
        .querySelector(`[data-testid="settings-models-picker-remove-openai:subscription:${codexEntry.model}"]`)
        ?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
      await Promise.resolve();
    });
    await flushAsyncWork();

    expect(latestSettings.localModel?.profiles ?? []).toHaveLength(0);
    expect(document.body.querySelector(
      `[data-testid="settings-models-picker-add-openai:subscription:${codexEntry.model}"]`,
    )).not.toBeNull();
  });

  it('reflects disconnect and reconnect lifecycle for connection-managed profiles', async () => {
    const existingProfile = materializeCatalogProfile(codexEntry, { id: 'existing-codex-profile' });
    const view = renderWithSettings(makeSettings({
      localModel: { profiles: [existingProfile] },
    }));
    await flushAsyncWork();

    expect(view.container.querySelector(
      '[data-testid="settings-models-profile-reconnect-existing-codex-profile"]',
    )).toBeNull();

    codexConnected = false;
    await act(async () => {
      document.dispatchEvent(new Event('visibilitychange'));
      await Promise.resolve();
    });
    await flushAsyncWork();

    expect(view.container.querySelector(
      '[data-testid="settings-models-profile-reconnect-existing-codex-profile"]',
    )?.textContent).toBe('Reconnect ChatGPT Pro');
    const codexCatalog = view.container.querySelector<HTMLElement>(
      '[data-testid="settings-models-catalog-chatgpt-pro"]',
    );
    expect(codexCatalog).not.toBeNull();
    expect(codexCatalog?.textContent).toContain('Not ready: reconnect ChatGPT Pro');
    expect(codexCatalog?.textContent).toContain('Reconnect ChatGPT Pro to use');
    expect(codexCatalog?.querySelector(
      `[data-testid="settings-models-catalog-row-${codexEntry.model}"]`,
    )).not.toBeNull();
    expect(codexCatalog?.querySelector(
      `[data-testid="settings-models-catalog-remove-${codexEntry.model}"]`,
    )?.textContent).toContain('Remove');

    codexConnected = true;
    await act(async () => {
      document.dispatchEvent(new Event('visibilitychange'));
      await Promise.resolve();
    });
    await flushAsyncWork();

    expect(view.container.querySelector(
      '[data-testid="settings-models-profile-reconnect-existing-codex-profile"]',
    )).toBeNull();
  });
});
