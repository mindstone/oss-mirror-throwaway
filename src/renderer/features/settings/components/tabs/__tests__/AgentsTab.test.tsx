// @vitest-environment happy-dom
 

import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_LOCAL_MODEL_SETTINGS, DEFAULT_OPENROUTER_SETTINGS, type AppSettings, type ModelProfile, type ModelSettings } from '@shared/types';
import { CODEX_WORKING_PROFILE_ID } from '@shared/utils/codexDefaults';
import { AgentsTab } from '../AgentsTab';
import type { TestResult } from '../../models/useProfileTester';
import {
  BTS_DETAILS_HAS_RENDERED_KEY,
  BTS_DETAILS_USER_PREFERENCE_KEY,
} from '../../../hooks/useFirstRenderOpenState';

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
    BillingBadge: ({ source }: { source: string }) => <span data-testid={`billing-badge-${source}`}>{source}</span>,
    Button: ({
      children,
      ...props
    }: React.ButtonHTMLAttributes<HTMLButtonElement>) => <button {...props}>{children}</button>,
    Tooltip: ({
      children,
    }: {
      content: React.ReactNode;
      children: React.ReactElement;
    }) => children,
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

vi.mock('../LocalModelSection', () => ({
  LocalModelSection: () => <div data-testid="local-model-section" />,
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

vi.mock('../SettingRow', () => ({
  SettingRow: ({
    label,
    htmlFor,
    children,
    ...props
  }: {
    label: string;
    htmlFor?: string;
    children: React.ReactNode;
  } & React.HTMLAttributes<HTMLLabelElement>) => (
    <label htmlFor={htmlFor} {...props}>
      <span>{label}</span>
      {children}
    </label>
  ),
}));

vi.mock('../SettingSection', () => ({
  SettingSection: ({
    title,
    description,
    children,
    advanced,
    defaultExpanded,
    open,
    onOpenChange,
    ...props
  }: {
    title: string;
    description?: string;
    children: React.ReactNode;
    advanced?: boolean;
    defaultExpanded?: boolean;
    open?: boolean;
    onOpenChange?: (open: boolean) => void;
  } & React.HTMLAttributes<HTMLElement>) => {
    const expanded = open ?? defaultExpanded ?? false;

    if (advanced) {
      return (
        <section aria-label={title} data-advanced-section {...props}>
          <button
            type="button"
            data-advanced-toggle
            aria-expanded={expanded}
            onClick={() => onOpenChange?.(!expanded)}
          >
            {title}
          </button>
          {description && <p>{description}</p>}
          <div
            data-advanced-content
            data-expanded={expanded || undefined}
            style={{ display: expanded ? undefined : 'none' }}
          >
            {children}
          </div>
        </section>
      );
    }

    return (
      <section aria-label={title} {...props}>
        {description && <p>{description}</p>}
        {children}
      </section>
    );
  },
}));

vi.mock('../SubscriptionSection', () => ({
  SubscriptionSection: () => <div data-testid="subscription-section" />,
}));

vi.mock('@renderer/hooks/useSubscriptionState', () => ({
  useSubscriptionState: () => ({
    subscription: null,
    phase: 'ready',
    isActive: false,
    isPastDueWithinGrace: false,
    refresh: vi.fn(async () => {}),
  }),
}));

type Mounted = {
  container: HTMLDivElement;
  root: Root;
  unmount: () => void;
};

type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T) => void;
};

function createDeferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((innerResolve) => {
    resolve = innerResolve;
  });
  return { promise, resolve };
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
    models: {
      apiKey: null,
      oauthToken: null,
      authMethod: 'api-key',
      model: 'openai/gpt-5.5',
      permissionMode: 'bypassPermissions',
      executablePath: null,
      planMode: false,
      extendedContext: true,
      thinkingEffort: 'high',
    },
    diagnostics: { debugBreadcrumbsUntil: null },
    openRouter: {
      ...DEFAULT_OPENROUTER_SETTINGS,
      enabled: true,
      oauthToken: 'or-token',
      selectedModel: 'openai/gpt-5.5',
    },
    localModel: { ...DEFAULT_LOCAL_MODEL_SETTINGS },
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
            ...base.models,
            ...modelsOverrides,
          } as ModelSettings),
    openRouter:
      openRouterOverrides === undefined
        ? base.openRouter
        : {
            ...base.openRouter,
            ...openRouterOverrides,
          } as AppSettings['openRouter'],
    localModel:
      localModelOverrides === undefined
        ? base.localModel
        : {
            ...base.localModel,
            ...localModelOverrides,
          } as AppSettings['localModel'],
  };
}

const codexWorkingProfile: ModelProfile = {
  id: CODEX_WORKING_PROFILE_ID,
  name: 'GPT-5.5 (ChatGPT Pro)',
  authSource: 'codex-subscription',
  providerType: 'openai',
  serverUrl: 'https://api.openai.com/v1',
  model: 'gpt-5.5',
  createdAt: 0,
};

const customProfile: ModelProfile = {
  id: 'custom-openai-profile',
  name: 'Research Gateway',
  providerType: 'openai',
  serverUrl: 'https://gateway.example.com/v1',
  model: 'gpt-4.1',
  createdAt: 1,
};

function getYourModelOptions(container: HTMLDivElement, selectId: string): string[] {
  const select = container.querySelector(`#${selectId}`);

  if (!select) {
    throw new Error(`Missing select ${selectId}\n${container.innerHTML}`);
  }

  const options = select.querySelectorAll(
    'optgroup[label="Your Models"] option',
  );
  return Array.from(options).map(option => option.textContent ?? '');
}

function getSettingRowForSelect(select: HTMLSelectElement | null, container: HTMLDivElement, selectId: string): HTMLElement {
  const label = container.querySelector(`label[for="${selectId}"]`) as HTMLLabelElement | null;
  const row =
    label?.parentElement?.parentElement?.parentElement ??
    label ??
    select?.parentElement?.parentElement ??
    null;

  if (!row) {
    throw new Error(`Missing row for ${selectId}\n${container.innerHTML}`);
  }

  return row as HTMLElement;
}

async function _openAdvancedOptions(container: HTMLDivElement): Promise<void> {
  const button = container.querySelector('[data-section="model"] [data-advanced-section] > [data-advanced-toggle]') as HTMLButtonElement | null;

  expect(button).not.toBeNull();

  act(() => {
    button?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
  });

  await flushAsyncWork();
}

describe('AgentsTab', () => {
  let mounted: Mounted | null = null;

  beforeEach(() => {
    Object.assign(window, {
      codexApi: {
        status: vi.fn(async () => ({ connected: false })),
        login: vi.fn(async () => ({ success: false })),
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
    window.localStorage.clear();
    vi.clearAllMocks();
  });

  it('shows the Claude optgroup when OpenRouter is active and Anthropic is reachable via OpenRouter credentials', async () => {
    mounted = mount(
      <AgentsTab
        draftSettings={makeSettings()}
        updateDraft={vi.fn()}
        updateClaude={vi.fn()}
        updateVoice={vi.fn()}
        markKeySticky={vi.fn()}
      />
    );

    await flushAsyncWork();

    const thinkingSelect = mounted.container.querySelector('#thinking-model');
    const claudeGroup = thinkingSelect?.querySelector('optgroup[label="Claude (API key)"]');

    expect(claudeGroup).not.toBeNull();
    expect(claudeGroup?.querySelectorAll('option').length).toBeGreaterThan(0);
  });

  it('renders the agreed AgentsTab IA order with three top-level model job rows', async () => {
    mounted = mount(
      <AgentsTab
        draftSettings={makeSettings()}
        updateDraft={vi.fn()}
        updateClaude={vi.fn()}
        updateVoice={vi.fn()}
        markKeySticky={vi.fn()}
      />
    );

    await flushAsyncWork();

    const sectionOrder = Array.from(mounted.container.children)
      .filter((node): node is HTMLElement => node instanceof HTMLElement && node.hasAttribute('data-section'))
      .map((section) => section.getAttribute('data-section'));

    expect(sectionOrder).toEqual([
      'providerKeys',
      'model',
      'defaultModelJobs',
      'behindTheScenesDetails',
      'advancedModelOptions',
      'heroChoiceRunMode',
      'dailySparkMode',
    ]);

    const roleRows = mounted.container.querySelectorAll(
      '[data-testid="settings-role-row-working"], [data-testid="settings-role-row-thinking"], [data-testid="settings-role-row-background"], [data-testid="settings-role-row-recovery"]',
    );
    expect(Array.from(roleRows).map((row) => row.getAttribute('data-testid'))).toEqual([
      'settings-role-row-thinking',
      'settings-role-row-working',
      'settings-role-row-background',
    ]);

    expect(mounted.container.querySelector('[data-testid="settings-role-row-recovery"]')).toBeNull();

    for (const label of ['Planner', 'Main work', 'Behind the Scenes']) {
      const matches = Array.from(roleRows).filter((node) =>
        node.textContent?.includes(label),
      );
      expect(matches.length, label).toBe(1);
    }

    expect(mounted.container.textContent).toContain('When conversations get long, fall back to:');
    expect(mounted.container.querySelector<HTMLSelectElement>('#long-context-fallback-model')).not.toBeNull();
  });

  it('hides codex-gpt-5.5 auto-profile from the three ModelTierRow optgroups when activeProvider is anthropic', async () => {
    mounted = mount(
      <AgentsTab
        draftSettings={makeSettings({
          activeProvider: 'anthropic',
          openRouter: {
            ...DEFAULT_OPENROUTER_SETTINGS,
            enabled: false,
            oauthToken: null,
          },
          localModel: {
            ...DEFAULT_LOCAL_MODEL_SETTINGS,
            profiles: [codexWorkingProfile, customProfile],
          },
        })}
        updateDraft={vi.fn()}
        updateClaude={vi.fn()}
        updateVoice={vi.fn()}
        markKeySticky={vi.fn()}
      />
    );

    await flushAsyncWork();

    for (const selectId of ['thinking-model', 'claude-model', 'behind-the-scenes-model']) {
      const optionTexts = getYourModelOptions(mounted.container, selectId);

      expect(optionTexts.some(text => text.startsWith('GPT-5.5 (ChatGPT Pro)'))).toBe(false);
      expect(optionTexts.some(text => text.startsWith('Research Gateway'))).toBe(true);
    }
  });

  it('hides codex-gpt-5.5 auto-profile from the long-context fallback dropdown when activeProvider is anthropic', async () => {
    mounted = mount(
      <AgentsTab
        draftSettings={makeSettings({
          activeProvider: 'anthropic',
          openRouter: {
            ...DEFAULT_OPENROUTER_SETTINGS,
            enabled: false,
            oauthToken: null,
          },
          localModel: {
            ...DEFAULT_LOCAL_MODEL_SETTINGS,
            profiles: [codexWorkingProfile, customProfile],
          },
        })}
        updateDraft={vi.fn()}
        updateClaude={vi.fn()}
        updateVoice={vi.fn()}
        markKeySticky={vi.fn()}
      />
    );

    await flushAsyncWork();

    const optionTexts = getYourModelOptions(mounted.container, 'long-context-fallback-model');

    expect(optionTexts.some(text => text.includes('GPT-5.5 (ChatGPT Pro)'))).toBe(false);
    expect(optionTexts.some(text => text.includes('Research Gateway'))).toBe(true);
  });

  it('shows all profiles when activeProvider is codex', async () => {
    mounted = mount(
      <AgentsTab
        draftSettings={makeSettings({
          activeProvider: 'codex',
          localModel: {
            ...DEFAULT_LOCAL_MODEL_SETTINGS,
            profiles: [codexWorkingProfile, customProfile],
          },
        })}
        updateDraft={vi.fn()}
        updateClaude={vi.fn()}
        updateVoice={vi.fn()}
        markKeySticky={vi.fn()}
      />
    );

    await flushAsyncWork();

    for (const selectId of ['thinking-model', 'claude-model', 'behind-the-scenes-model']) {
      const optionTexts = getYourModelOptions(mounted.container, selectId);

      expect(optionTexts.some(text => text.startsWith('GPT-5.5 (ChatGPT Pro)'))).toBe(true);
      expect(optionTexts.some(text => text.startsWith('Research Gateway'))).toBe(true);
    }

    const recoveryOptions = getYourModelOptions(mounted.container, 'long-context-fallback-model');
    expect(recoveryOptions.some(text => text.includes('GPT-5.5 (ChatGPT Pro)'))).toBe(true);
    expect(recoveryOptions.some(text => text.includes('Research Gateway'))).toBe(true);
  });

  it('opens Behind the Scenes details on the first render and sets the first-render flag', async () => {
    expect(window.localStorage.getItem(BTS_DETAILS_HAS_RENDERED_KEY)).toBeNull();

    mounted = mount(
      <AgentsTab
        draftSettings={makeSettings()}
        updateDraft={vi.fn()}
        updateClaude={vi.fn()}
        updateVoice={vi.fn()}
        markKeySticky={vi.fn()}
      />
    );

    await flushAsyncWork();

    const section = mounted.container.querySelector('[data-testid="settings-bts-details-section"]');
    const content = section?.querySelector<HTMLElement>('[data-advanced-content]');
    const toggle = section?.querySelector<HTMLButtonElement>('[data-advanced-toggle]');

    expect(toggle?.getAttribute('aria-expanded')).toBe('true');
    expect(content?.style.display).not.toBe('none');
    expect(window.localStorage.getItem(BTS_DETAILS_HAS_RENDERED_KEY)).toBe('true');
  });

  it('honours a stored collapsed preference for Behind the Scenes details after first render', async () => {
    window.localStorage.setItem(BTS_DETAILS_HAS_RENDERED_KEY, 'true');
    window.localStorage.setItem(BTS_DETAILS_USER_PREFERENCE_KEY, 'closed');

    mounted = mount(
      <AgentsTab
        draftSettings={makeSettings()}
        updateDraft={vi.fn()}
        updateClaude={vi.fn()}
        updateVoice={vi.fn()}
        markKeySticky={vi.fn()}
      />
    );

    await flushAsyncWork();

    const section = mounted.container.querySelector('[data-testid="settings-bts-details-section"]');
    const content = section?.querySelector<HTMLElement>('[data-advanced-content]');
    const toggle = section?.querySelector<HTMLButtonElement>('[data-advanced-toggle]');

    expect(toggle?.getAttribute('aria-expanded')).toBe('false');
    expect(content?.style.display).toBe('none');
  });

  it('honours a stored open preference for Behind the Scenes details after first render', async () => {
    window.localStorage.setItem(BTS_DETAILS_HAS_RENDERED_KEY, 'true');
    window.localStorage.setItem(BTS_DETAILS_USER_PREFERENCE_KEY, 'open');

    mounted = mount(
      <AgentsTab
        draftSettings={makeSettings()}
        updateDraft={vi.fn()}
        updateClaude={vi.fn()}
        updateVoice={vi.fn()}
        markKeySticky={vi.fn()}
      />
    );

    await flushAsyncWork();

    const section = mounted.container.querySelector('[data-testid="settings-bts-details-section"]');
    const content = section?.querySelector<HTMLElement>('[data-advanced-content]');
    const toggle = section?.querySelector<HTMLButtonElement>('[data-advanced-toggle]');

    expect(toggle?.getAttribute('aria-expanded')).toBe('true');
    expect(content?.style.display).not.toBe('none');
  });

  it('shows inline missing-profile status on the thinking row when the stored profile is hidden after switch to anthropic', async () => {
    mounted = mount(
      <AgentsTab
        draftSettings={makeSettings({
          activeProvider: 'anthropic',
          openRouter: {
            ...DEFAULT_OPENROUTER_SETTINGS,
            enabled: false,
            oauthToken: null,
          },
          models: {
            thinkingProfileId: CODEX_WORKING_PROFILE_ID,
            thinkingModel: undefined,
          },
          localModel: {
            ...DEFAULT_LOCAL_MODEL_SETTINGS,
            profiles: [codexWorkingProfile, customProfile],
          },
        })}
        updateDraft={vi.fn()}
        updateClaude={vi.fn()}
        updateVoice={vi.fn()}
        markKeySticky={vi.fn()}
      />
    );

    await flushAsyncWork();

    const thinkingSelect = mounted.container.querySelector('#thinking-model') as HTMLSelectElement | null;
    const thinkingRow = getSettingRowForSelect(thinkingSelect, mounted.container, 'thinking-model');

    expect(thinkingSelect).not.toBeNull();
    expect(thinkingSelect?.value).toBe(`profile:${CODEX_WORKING_PROFILE_ID}`);
    expect(thinkingRow.textContent).toContain('Profile no longer available');
    expect(thinkingRow.textContent)
      .toContain('Selected profile is no longer available. Pick another model before Rebel can use this role.');
    expect(thinkingRow.textContent).not.toContain('Using default model for now');
    expect(thinkingRow.textContent).toContain('Pick another model');
    expect(thinkingRow.querySelector('[data-testid^="billing-badge-"]')).toBeNull();
  });

  it('shows missing-profile status on the Behind the Scenes row when the global BTS profile is deleted', async () => {
    mounted = mount(
      <AgentsTab
        draftSettings={makeSettings({
          activeProvider: 'anthropic',
          openRouter: {
            ...DEFAULT_OPENROUTER_SETTINGS,
            enabled: false,
            oauthToken: null,
          },
          behindTheScenesModel: 'profile:deleted-fast',
          localModel: {
            ...DEFAULT_LOCAL_MODEL_SETTINGS,
            profiles: [],
          },
        })}
        updateDraft={vi.fn()}
        updateClaude={vi.fn()}
        updateVoice={vi.fn()}
        markKeySticky={vi.fn()}
      />
    );

    await flushAsyncWork();

    const btsSelect = mounted.container.querySelector('#behind-the-scenes-model') as HTMLSelectElement | null;
    const btsRow = getSettingRowForSelect(btsSelect, mounted.container, 'behind-the-scenes-model');

    expect(btsSelect).not.toBeNull();
    expect(btsSelect?.value).toBe('profile:deleted-fast');
    expect(btsRow.textContent).toContain('Profile no longer available');
    expect(btsRow.textContent)
      .toContain('Selected profile is no longer available. Pick another model before Rebel can use this role.');
    expect(btsRow.textContent).not.toContain('Using default model for now');
    expect(btsRow.textContent).toContain('Pick another model');
  });

  it('shows a scoped recovery warning when the long-context fallback profile is deleted', async () => {
    mounted = mount(
      <AgentsTab
        draftSettings={makeSettings({
          activeProvider: 'anthropic',
          openRouter: {
            ...DEFAULT_OPENROUTER_SETTINGS,
            enabled: false,
            oauthToken: null,
          },
          models: {
            longContextFallbackProfileId: 'deleted-recovery-profile',
            longContextFallbackModel: undefined,
          },
          localModel: {
            ...DEFAULT_LOCAL_MODEL_SETTINGS,
            profiles: [],
          },
        })}
        updateDraft={vi.fn()}
        updateClaude={vi.fn()}
        updateVoice={vi.fn()}
        markKeySticky={vi.fn()}
      />
    );

    await flushAsyncWork();

    const fallbackSelect = mounted.container.querySelector<HTMLSelectElement>('#long-context-fallback-model');
    const recoveryWarning = mounted.container.querySelector<HTMLElement>(
      '[data-testid="settings-role-row-working-secondary-fallback-warning"]',
    );
    const recoveryCta = mounted.container.querySelector<HTMLButtonElement>(
      '[data-testid="settings-role-row-working-secondary-fallback-cta"]',
    );

    expect(fallbackSelect).not.toBeNull();
    expect(fallbackSelect?.value).toBe('profile:deleted-recovery-profile');
    expect(recoveryWarning?.textContent)
      .toContain('Recovery fallback is unavailable. Pick another fallback for long conversations.');
    expect(recoveryCta?.textContent).toContain('Pick fallback');

    act(() => {
      recoveryCta?.click();
    });

    expect(document.activeElement).toBe(fallbackSelect);
  });

  it('does not show a recovery warning when the long-context fallback is healthy', async () => {
    mounted = mount(
      <AgentsTab
        draftSettings={makeSettings({
          activeProvider: 'anthropic',
          openRouter: {
            ...DEFAULT_OPENROUTER_SETTINGS,
            enabled: false,
            oauthToken: null,
          },
          models: {
            longContextFallbackProfileId: customProfile.id,
            longContextFallbackModel: undefined,
          },
          localModel: {
            ...DEFAULT_LOCAL_MODEL_SETTINGS,
            profiles: [customProfile],
          },
        })}
        updateDraft={vi.fn()}
        updateClaude={vi.fn()}
        updateVoice={vi.fn()}
        markKeySticky={vi.fn()}
      />
    );

    await flushAsyncWork();

    const fallbackSelect = mounted.container.querySelector<HTMLSelectElement>('#long-context-fallback-model');

    expect(fallbackSelect).not.toBeNull();
    expect(fallbackSelect?.value).toBe(`profile:${customProfile.id}`);
    expect(mounted.container.querySelector(
      '[data-testid="settings-role-row-working-secondary-fallback-warning"]',
    )).toBeNull();
    expect(mounted.container.querySelector(
      '[data-testid="settings-role-row-working-secondary-fallback-cta"]',
    )).toBeNull();
  });

  it('shows reconnect guidance instead of missing-profile copy when a selected connection-managed role is disconnected', async () => {
    const disconnectedCodexProfile: ModelProfile = {
      id: 'materialised-codex-profile',
      name: 'ChatGPT Pro GPT-5.5',
      authSource: 'codex-subscription',
      providerType: 'openai',
      routeSurface: 'subscription',
      profileSource: 'connection',
      serverUrl: 'https://api.openai.com/v1',
      model: 'gpt-5.5',
      createdAt: 1,
      enabled: true,
    };

    mounted = mount(
      <AgentsTab
        draftSettings={makeSettings({
          models: {
            workingProfileId: disconnectedCodexProfile.id,
            model: undefined,
          },
          localModel: {
            ...DEFAULT_LOCAL_MODEL_SETTINGS,
            profiles: [disconnectedCodexProfile],
          },
        })}
        updateDraft={vi.fn()}
        updateClaude={vi.fn()}
        updateVoice={vi.fn()}
        markKeySticky={vi.fn()}
      />,
    );

    await flushAsyncWork();

    const workingSelect = mounted.container.querySelector('#claude-model') as HTMLSelectElement | null;
    const workingRow = getSettingRowForSelect(workingSelect, mounted.container, 'claude-model');

    expect(workingSelect).not.toBeNull();
    expect(workingSelect?.value).toBe(`profile:${disconnectedCodexProfile.id}`);
    expect(workingRow.textContent).toContain('Selected: ChatGPT Pro GPT-5.5 · ChatGPT Pro');
    expect(workingRow.textContent).toContain('Reconnect ChatGPT Pro to use this role.');
    expect(workingRow.textContent).not.toContain('This profile is no longer available. Using default model for now.');
  });

  it('keeps an uncatalogued working model visible in the unified picker', async () => {
    mounted = mount(
      <AgentsTab
        draftSettings={makeSettings({
          activeProvider: 'anthropic',
          openRouter: {
            ...DEFAULT_OPENROUTER_SETTINGS,
            enabled: false,
            oauthToken: null,
          },
          models: {
            model: 'gpt-5.4-mini',
          },
          localModel: {
            ...DEFAULT_LOCAL_MODEL_SETTINGS,
            profiles: [customProfile],
          },
        })}
        updateDraft={vi.fn()}
        updateClaude={vi.fn()}
        updateVoice={vi.fn()}
        markKeySticky={vi.fn()}
      />
    );

    await flushAsyncWork();

    const workingSelect = mounted.container.querySelector('#claude-model') as HTMLSelectElement | null;
    const workingRow = getSettingRowForSelect(workingSelect, mounted.container, 'claude-model');

    expect(workingSelect).not.toBeNull();
    expect(workingSelect?.value).toBe('gpt-5.4-mini');
    expect(workingRow.textContent).toContain('Selected: GPT-5.4 mini');
  });

  it('keeps an uncatalogued background fallback visible in the unified fallback picker', async () => {
    mounted = mount(
      <AgentsTab
        draftSettings={makeSettings({
          activeProvider: 'anthropic',
          openRouter: {
            ...DEFAULT_OPENROUTER_SETTINGS,
            enabled: false,
            oauthToken: null,
          },
          backgroundFallback: 'model:openai/gpt-5.4-mini',
          localModel: {
            ...DEFAULT_LOCAL_MODEL_SETTINGS,
            profiles: [customProfile],
          },
        })}
        updateDraft={vi.fn()}
        updateClaude={vi.fn()}
        updateVoice={vi.fn()}
        markKeySticky={vi.fn()}
      />
    );

    await flushAsyncWork();

    const fallbackSelect = mounted.container.querySelector('#behind-the-scenes-model-fallback') as HTMLSelectElement | null;
    const backgroundRow = getSettingRowForSelect(fallbackSelect, mounted.container, 'behind-the-scenes-model-fallback');

    expect(fallbackSelect).not.toBeNull();
    expect(fallbackSelect?.value).toBe('openai/gpt-5.4-mini');
    expect(backgroundRow.textContent).toContain('openai/gpt-5.4-mini');
  });

  it('suppresses the "Using X" BTS helper when the selected profile is a hidden Codex auto-profile after provider switch', async () => {
    mounted = mount(
      <AgentsTab
        draftSettings={makeSettings({
          activeProvider: 'anthropic',
          openRouter: {
            ...DEFAULT_OPENROUTER_SETTINGS,
            enabled: false,
            oauthToken: null,
          },
          behindTheScenesModel: `profile:${CODEX_WORKING_PROFILE_ID}`,
          localModel: {
            ...DEFAULT_LOCAL_MODEL_SETTINGS,
            profiles: [codexWorkingProfile, customProfile],
          },
        })}
        updateDraft={vi.fn()}
        updateClaude={vi.fn()}
        updateVoice={vi.fn()}
        markKeySticky={vi.fn()}
      />
    );

    await flushAsyncWork();

    // Helper "Using GPT-5.5 (ChatGPT Pro)." must NOT render when the profile is hidden,
    // because the ModelTierRow's stale-value hint already explains the state.
    expect(mounted.container.textContent).not.toMatch(/Using GPT-5\.4.*\(ChatGPT Pro\)/);
    expect(mounted.container.textContent).not.toMatch(/Using custom model/);
  });

  it('excludes incomplete auto-only profiles (no serverUrl) from Working / Thinking / Background dropdowns', async () => {
    // Phase 6 Refinement Cycle 1, Bug 2: an auto-learned profile that lacks
    // connection details (serverUrl/apiKey) appears in the Needs-setup bucket
    // of LocalModelSection but must NOT be selectable in the routing dropdowns.
    const incompleteAutoProfile: ModelProfile = {
      id: 'auto:gpt-future',
      name: 'gpt-future',
      providerType: 'other',
      serverUrl: '',
      apiKey: undefined,
      model: 'gpt-future',
      enabled: false,
      contextWindow: 200_000,
      contextWindowSource: 'auto',
      lastLearnedContextWindow: 200_000,
      contextWindowOverflowCount: 1,
      createdAt: 1_700_000_000_000,
    };
    mounted = mount(
      <AgentsTab
        draftSettings={makeSettings({
          activeProvider: 'anthropic',
          openRouter: {
            ...DEFAULT_OPENROUTER_SETTINGS,
            enabled: false,
            oauthToken: null,
          },
          localModel: {
            ...DEFAULT_LOCAL_MODEL_SETTINGS,
            profiles: [incompleteAutoProfile, customProfile],
          },
        })}
        updateDraft={vi.fn()}
        updateClaude={vi.fn()}
        updateVoice={vi.fn()}
        markKeySticky={vi.fn()}
      />
    );

    await flushAsyncWork();

    for (const selectId of ['claude-model', 'thinking-model', 'behind-the-scenes-model']) {
      const optionTexts = getYourModelOptions(mounted.container, selectId);
      expect(optionTexts.some(text => text.includes('gpt-future'))).toBe(false);
      expect(optionTexts.some(text => text.includes('Research Gateway'))).toBe(true);
    }
  });

  it('selecting a profile in the working picker emits model storage updates', async () => {
    const updateClaude = vi.fn();
    mounted = mount(
      <AgentsTab
        draftSettings={makeSettings({
          activeProvider: 'anthropic',
          openRouter: {
            ...DEFAULT_OPENROUTER_SETTINGS,
            enabled: false,
            oauthToken: null,
          },
          models: {
            model: 'claude-sonnet-4-6',
          },
          localModel: {
            ...DEFAULT_LOCAL_MODEL_SETTINGS,
            profiles: [customProfile],
          },
        })}
        updateDraft={vi.fn()}
        updateClaude={updateClaude}
        updateVoice={vi.fn()}
        markKeySticky={vi.fn()}
      />
    );

    await flushAsyncWork();

    const workingSelect = mounted.container.querySelector<HTMLSelectElement>('#claude-model');
    expect(workingSelect).not.toBeNull();

    act(() => {
      workingSelect!.value = `profile:${customProfile.id}`;
      workingSelect!.dispatchEvent(new Event('change', { bubbles: true }));
    });

    expect(updateClaude).toHaveBeenCalledWith('workingProfileId', customProfile.id);
    expect(updateClaude).toHaveBeenCalledWith('model', undefined);
  });

  it('writes long-context fallback model and profile fields from the Main work sub-line picker', async () => {
    const updateClaude = vi.fn();
    mounted = mount(
      <AgentsTab
        draftSettings={makeSettings({
          activeProvider: 'anthropic',
          openRouter: {
            ...DEFAULT_OPENROUTER_SETTINGS,
            enabled: false,
            oauthToken: null,
          },
          models: {
            longContextFallbackProfileId: customProfile.id,
            longContextFallbackModel: undefined,
          },
          localModel: {
            ...DEFAULT_LOCAL_MODEL_SETTINGS,
            profiles: [customProfile],
          },
        })}
        updateDraft={vi.fn()}
        updateClaude={updateClaude}
        updateVoice={vi.fn()}
        markKeySticky={vi.fn()}
      />
    );

    await flushAsyncWork();

    const fallbackSelect = mounted.container.querySelector<HTMLSelectElement>('#long-context-fallback-model');
    expect(fallbackSelect).not.toBeNull();

    act(() => {
      fallbackSelect!.value = 'claude-sonnet-4-6';
      fallbackSelect!.dispatchEvent(new Event('change', { bubbles: true }));
    });

    expect(updateClaude).toHaveBeenCalledWith('longContextFallbackModel', 'claude-sonnet-4-6');
    expect(updateClaude).toHaveBeenCalledWith('longContextFallbackProfileId', undefined);

    mounted.unmount();
    mounted = null;
    updateClaude.mockClear();

    mounted = mount(
      <AgentsTab
        draftSettings={makeSettings({
          activeProvider: 'anthropic',
          openRouter: {
            ...DEFAULT_OPENROUTER_SETTINGS,
            enabled: false,
            oauthToken: null,
          },
          models: {
            longContextFallbackModel: 'claude-sonnet-4-6',
            longContextFallbackProfileId: undefined,
          },
          localModel: {
            ...DEFAULT_LOCAL_MODEL_SETTINGS,
            profiles: [customProfile],
          },
        })}
        updateDraft={vi.fn()}
        updateClaude={updateClaude}
        updateVoice={vi.fn()}
        markKeySticky={vi.fn()}
      />
    );

    await flushAsyncWork();

    const profileFallbackSelect = mounted.container.querySelector<HTMLSelectElement>('#long-context-fallback-model');
    expect(profileFallbackSelect).not.toBeNull();

    act(() => {
      profileFallbackSelect!.value = `profile:${customProfile.id}`;
      profileFallbackSelect!.dispatchEvent(new Event('change', { bubbles: true }));
    });

    expect(updateClaude).toHaveBeenCalledWith('longContextFallbackProfileId', customProfile.id);
    expect(updateClaude).toHaveBeenCalledWith('longContextFallbackModel', undefined);
  });

  it('clears long-context fallback fields when Off is picked in the Main work sub-line picker', async () => {
    const updateClaude = vi.fn();
    mounted = mount(
      <AgentsTab
        draftSettings={makeSettings({
          activeProvider: 'anthropic',
          openRouter: {
            ...DEFAULT_OPENROUTER_SETTINGS,
            enabled: false,
            oauthToken: null,
          },
          models: {
            longContextFallbackModel: 'gpt-4',
            longContextFallbackProfileId: '',
          },
          localModel: {
            ...DEFAULT_LOCAL_MODEL_SETTINGS,
            profiles: [customProfile],
          },
        })}
        updateDraft={vi.fn()}
        updateClaude={updateClaude}
        updateVoice={vi.fn()}
        markKeySticky={vi.fn()}
      />
    );

    await flushAsyncWork();

    expect(mounted.container.textContent).toContain('When conversations get long, fall back to:');
    const fallbackSelect = mounted.container.querySelector<HTMLSelectElement>('#long-context-fallback-model');
    expect(fallbackSelect).not.toBeNull();

    act(() => {
      fallbackSelect!.value = '';
      fallbackSelect!.dispatchEvent(new Event('change', { bubbles: true }));
    });

    expect(updateClaude).toHaveBeenCalledWith('longContextFallbackModel', undefined);
    expect(updateClaude).toHaveBeenCalledWith('longContextFallbackProfileId', undefined);
  });

  it('does not write inline test state after unmount when the probe resolves late', async () => {
    const deferred = createDeferred<TestResult>();
    const testModelChoice = vi.fn(() => deferred.promise);
    const settingsApi = window.settingsApi as typeof window.settingsApi & {
      testModelChoice: typeof testModelChoice;
    };
    settingsApi.testModelChoice = testModelChoice;

    mounted = mount(
      <AgentsTab
        draftSettings={makeSettings({
          activeProvider: 'anthropic',
          openRouter: {
            ...DEFAULT_OPENROUTER_SETTINGS,
            enabled: false,
            oauthToken: null,
          },
          models: {
            model: 'future-private-model',
          },
          localModel: {
            ...DEFAULT_LOCAL_MODEL_SETTINGS,
            profiles: [customProfile],
          },
        })}
        updateDraft={vi.fn()}
        updateClaude={vi.fn()}
        updateVoice={vi.fn()}
        markKeySticky={vi.fn()}
      />
    );

    await flushAsyncWork();

    const button = mounted.container.querySelector<HTMLButtonElement>(
      '[data-testid="settings-role-row-working-inline-test"]',
    );
    expect(button).not.toBeNull();

    act(() => {
      button?.click();
    });
    expect(testModelChoice).toHaveBeenCalledOnce();

    mounted.unmount();
    mounted = null;

    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      deferred.resolve({ success: false, error: 'Late audition result.' });
      await deferred.promise;
      await Promise.resolve();

      const warnings = consoleError.mock.calls.map((args) => args.join(' ')).join('\n');
      expect(warnings).not.toMatch(/state update|unmounted|act/i);
    } finally {
      consoleError.mockRestore();
    }
  });

  describe('BackupConnectionsSection gate (F2 — render-level JSX gate)', () => {
    it('does NOT render BackupConnectionsSection when active provider is disconnected (codex not connected)', async () => {
      // activeProvider=codex, codexApi returns connected=false → isActiveProviderConnected=false → no section
      mounted = mount(
        <AgentsTab
          draftSettings={makeSettings({
            activeProvider: 'codex',
            experimental: { multiProviderRoutingEnabled: true },
            openRouter: { ...DEFAULT_OPENROUTER_SETTINGS, enabled: false, oauthToken: null },
          })}
          updateDraft={vi.fn()}
          updateClaude={vi.fn()}
          updateVoice={vi.fn()}
          markKeySticky={vi.fn()}
        />
      );
      await flushAsyncWork();
      // codexApi.status mock returns connected=false (see beforeEach)
      expect(
        mounted.container.querySelector('[data-testid="settings-backup-connections-section"]'),
      ).toBeNull();
    });

    it('renders BackupConnectionsSection when active provider is connected (openrouter with token)', async () => {
      // activeProvider=openrouter, token present → isActiveProviderConnected=true → section visible
      mounted = mount(
        <AgentsTab
          draftSettings={makeSettings({
            activeProvider: 'openrouter',
            experimental: { multiProviderRoutingEnabled: true },
            openRouter: { ...DEFAULT_OPENROUTER_SETTINGS, enabled: true, oauthToken: 'tok' },
          })}
          updateDraft={vi.fn()}
          updateClaude={vi.fn()}
          updateVoice={vi.fn()}
          markKeySticky={vi.fn()}
        />
      );
      await flushAsyncWork();
      expect(
        mounted.container.querySelector('[data-testid="settings-backup-connections-section"]'),
      ).not.toBeNull();
    });

    it('does NOT render BackupConnectionsSection when activeProvider is undefined', async () => {
      mounted = mount(
        <AgentsTab
          draftSettings={makeSettings({
            activeProvider: undefined as unknown as AppSettings['activeProvider'],
            experimental: { multiProviderRoutingEnabled: true },
          })}
          updateDraft={vi.fn()}
          updateClaude={vi.fn()}
          updateVoice={vi.fn()}
          markKeySticky={vi.fn()}
        />
      );
      await flushAsyncWork();
      expect(
        mounted.container.querySelector('[data-testid="settings-backup-connections-section"]'),
      ).toBeNull();
    });

    it('does NOT render BackupConnectionsSection when multiProviderRoutingEnabled flag is off', async () => {
      mounted = mount(
        <AgentsTab
          draftSettings={makeSettings({
            activeProvider: 'openrouter',
            experimental: { multiProviderRoutingEnabled: false },
            openRouter: { ...DEFAULT_OPENROUTER_SETTINGS, enabled: true, oauthToken: 'tok' },
          })}
          updateDraft={vi.fn()}
          updateClaude={vi.fn()}
          updateVoice={vi.fn()}
          markKeySticky={vi.fn()}
        />
      );
      await flushAsyncWork();
      expect(
        mounted.container.querySelector('[data-testid="settings-backup-connections-section"]'),
      ).toBeNull();
    });
  });

  describe('Personalisation › Daily Spark mode', () => {
    it('renders the Daily Spark section with data-section="dailySparkMode"', async () => {
      mounted = mount(
        <AgentsTab
          draftSettings={makeSettings()}
          updateDraft={vi.fn()}
          updateClaude={vi.fn()}
          updateVoice={vi.fn()}
          markKeySticky={vi.fn()}
        />
      );
      await flushAsyncWork();
      const section = mounted.container.querySelector('[data-section="dailySparkMode"]');
      expect(section).not.toBeNull();
      expect(section?.textContent).toContain('Daily Spark');
      expect(section?.textContent).toContain('Personalisation');
    });

    it('renders three Daily Spark options (Every day / Mondays only / Off)', async () => {
      mounted = mount(
        <AgentsTab
          draftSettings={makeSettings()}
          updateDraft={vi.fn()}
          updateClaude={vi.fn()}
          updateVoice={vi.fn()}
          markKeySticky={vi.fn()}
        />
      );
      await flushAsyncWork();

      const trigger = mounted.container.querySelector<HTMLButtonElement>(
        '[data-section="dailySparkMode"] button[aria-haspopup="listbox"]',
      );
      expect(trigger).not.toBeNull();
      act(() => {
        trigger?.click();
      });
      await flushAsyncWork();

      const labels = Array.from(document.querySelectorAll('[role="option"]'))
        .map((el) => el.textContent ?? '')
        .filter(Boolean);
      expect(labels.some((l) => l.includes('Every day'))).toBe(true);
      expect(labels.some((l) => l.includes('Mondays only'))).toBe(true);
      expect(labels.some((l) => l.includes('Off'))).toBe(true);
    });

    it('calls updateDraft("dailySparkMode", value) when an option is selected', async () => {
      const updateDraft = vi.fn();
      mounted = mount(
        <AgentsTab
          draftSettings={makeSettings()}
          updateDraft={updateDraft}
          updateClaude={vi.fn()}
          updateVoice={vi.fn()}
          markKeySticky={vi.fn()}
        />
      );
      await flushAsyncWork();

      const trigger = mounted.container.querySelector<HTMLButtonElement>(
        '[data-section="dailySparkMode"] button[aria-haspopup="listbox"]',
      );
      act(() => {
        trigger?.click();
      });
      await flushAsyncWork();

      const subtleOption = Array.from(document.querySelectorAll<HTMLElement>('[role="option"]')).find((el) =>
        (el.textContent ?? '').includes('Mondays only'),
      );
      expect(subtleOption).not.toBeUndefined();
      act(() => {
        subtleOption?.click();
      });
      await flushAsyncWork();

      expect(updateDraft).toHaveBeenCalledWith('dailySparkMode', 'subtle');
    });
  });
});
