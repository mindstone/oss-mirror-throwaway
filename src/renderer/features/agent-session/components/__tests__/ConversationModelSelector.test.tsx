// @vitest-environment happy-dom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { PROVIDER_CATALOGS } from '@shared/data/providerCatalogs';
import type { AppSettings, ModelProfile } from '@shared/types';
import { ConversationModelSelector } from '../ConversationModelSelector';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const mocks = vi.hoisted(() => {
  const setSessionModelOverrides = vi.fn();
  const sessionState: {
    sessionWorkingModel: string | undefined;
    sessionThinkingModel: string | undefined;
    sessionWorkingProfileId: string | undefined;
    sessionThinkingProfileId: string | undefined;
    sessionThinkingEffort: string | undefined;
    setSessionModelOverrides: typeof setSessionModelOverrides;
  } = {
    sessionWorkingModel: undefined,
    sessionThinkingModel: undefined,
    sessionWorkingProfileId: undefined,
    sessionThinkingProfileId: undefined,
    sessionThinkingEffort: undefined,
    setSessionModelOverrides,
  };
  return {
    draftSettings: {} as Partial<AppSettings>,
    setSessionModelOverrides,
    sessionState,
  };
});

 
vi.mock('@renderer/features/settings', () => ({
  useSettingsSafe: () => ({
    draftSettings: mocks.draftSettings,
    settings: mocks.draftSettings,
  }),
}));

 
vi.mock('../../store/sessionStore', () => ({
  useSessionStore: <T,>(selector: (state: typeof mocks.sessionState) => T): T => selector(mocks.sessionState),
}));

interface Mounted {
  container: HTMLDivElement;
  unmount: () => void;
}

function mount(ui: React.ReactElement): Mounted {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root: Root = createRoot(container);
  act(() => {
    root.render(ui);
  });
  return {
    container,
    unmount: () => {
      act(() => {
        root.unmount();
      });
      container.remove();
    },
  };
}

function makeProfile(overrides: Partial<ModelProfile>): ModelProfile {
  return {
    id: 'profile-1',
    name: 'Custom profile',
    providerType: 'openai',
    routeSurface: 'api-key',
    serverUrl: 'https://example.test/v1',
    model: 'gpt-5.6',
    apiKey: 'test-key',
    createdAt: 1_700_000_000_000,
    enabled: true,
    ...overrides,
  };
}

async function renderSelector(codexConnected: boolean): Promise<Mounted> {
  Object.defineProperty(window, 'codexApi', {
    configurable: true,
    value: {
      status: vi.fn(async () => ({ connected: codexConnected })),
    },
  });
  const mounted = mount(<ConversationModelSelector hasMessages={false} isExpanded />);
  await act(async () => {
    await Promise.resolve();
  });
  return mounted;
}

function workingSelect(container: HTMLElement): HTMLSelectElement {
  const select = container.querySelector<HTMLSelectElement>('#conv-working-model');
  if (!select) throw new Error('Working select not rendered');
  return select;
}

function thinkingSelect(container: HTMLElement): HTMLSelectElement {
  const select = container.querySelector<HTMLSelectElement>('#conv-thinking-model');
  if (!select) throw new Error('Thinking select not rendered');
  return select;
}

function offOptionLabel(select: HTMLSelectElement): string {
  return select.querySelector<HTMLOptionElement>('option[value=""]')?.textContent ?? '';
}

function optgroupLabels(select: HTMLSelectElement): string[] {
  return Array.from(select.querySelectorAll('optgroup')).map((group) => group.label);
}

describe('ConversationModelSelector provider catalog optgroups', () => {
  const mounted: Mounted[] = [];

  beforeEach(() => {
    mocks.draftSettings = {};
    mocks.setSessionModelOverrides.mockReset();
    mocks.sessionState.sessionWorkingModel = undefined;
    mocks.sessionState.sessionThinkingModel = undefined;
    mocks.sessionState.sessionWorkingProfileId = undefined;
    mocks.sessionState.sessionThinkingProfileId = undefined;
    mocks.sessionState.sessionThinkingEffort = undefined;
  });

  afterEach(() => {
    for (const instance of mounted) instance.unmount();
    mounted.length = 0;
    document.body.innerHTML = '';
    vi.restoreAllMocks();
  });

  it('builds provider optgroups from PROVIDER_CATALOGS and drops the hardcoded Claude group', async () => {
    mocks.draftSettings = {
      models: { apiKey: 'fake-ant-test' },
      providerKeys: { google: 'google-test-key' },
      openRouter: { oauthToken: 'or-token' },
      localModel: { profiles: [] },
    } as unknown as Partial<AppSettings>;

    const view = await renderSelector(true);
    mounted.push(view);

    const labels = optgroupLabels(workingSelect(view.container));
    expect(labels).toEqual(['Special', 'ChatGPT Pro', 'OpenRouter', 'Anthropic', 'Gemini']);
    expect(labels).not.toContain('Claude');
  });

  it('gates Anthropic on Anthropic API key even when OpenRouter is connected', async () => {
    mocks.draftSettings = {
      models: { apiKey: null },
      openRouter: { oauthToken: 'or-token' },
      localModel: { profiles: [] },
    } as unknown as Partial<AppSettings>;

    const view = await renderSelector(false);
    mounted.push(view);

    const labels = optgroupLabels(workingSelect(view.container));
    expect(labels).toEqual(['Special', 'OpenRouter']);
    expect(labels).not.toContain('Anthropic');
  });

  it('renders user profiles under the shared Your Models optgroup', async () => {
    mocks.draftSettings = {
      localModel: {
        profiles: [
          makeProfile({
            id: 'custom-gemini',
            name: 'My Gemini',
            providerType: 'google',
            routeSurface: 'api-key',
            model: 'gemini-2.5-pro-experimental',
          }),
        ],
      },
    } as unknown as Partial<AppSettings>;

    const view = await renderSelector(false);
    mounted.push(view);

    const select = workingSelect(view.container);
    expect(optgroupLabels(select)).toEqual(['Special', 'Your Models']);
    expect(select.textContent).toContain('My Gemini');
    expect(optgroupLabels(select)).not.toContain('Custom');
  });

  it('omits disconnected connection-managed profiles from the picker', async () => {
    mocks.draftSettings = {
      openRouter: { oauthToken: null },
      localModel: {
        profiles: [
          makeProfile({
            id: 'dead-openrouter',
            name: 'Disconnected OpenRouter',
            providerType: 'openrouter',
            routeSurface: 'pool',
            profileSource: 'connection',
            model: 'openai/gpt-5.5',
            serverUrl: 'https://openrouter.ai/api/v1',
          }),
          makeProfile({
            id: 'user-openai',
            name: 'User OpenAI',
            profileSource: 'user',
          }),
        ],
      },
    } as unknown as Partial<AppSettings>;

    const view = await renderSelector(false);
    mounted.push(view);

    const select = workingSelect(view.container);
    expect(select.textContent).toContain('User OpenAI');
    expect(select.textContent).not.toContain('Disconnected OpenRouter');
  });

  it('refreshes Codex connectivity on visibility changes', async () => {
    let codexConnected = true;
    Object.defineProperty(window, 'codexApi', {
      configurable: true,
      value: {
        status: vi.fn(async () => ({ connected: codexConnected })),
      },
    });
    mocks.draftSettings = {
      localModel: {
        profiles: [
          makeProfile({
            id: 'codex-connection',
            name: 'ChatGPT Pro GPT 5.5',
            providerType: 'openai',
            routeSurface: 'subscription',
            authSource: 'codex-subscription',
            profileSource: 'connection',
            model: 'gpt-5.5',
            serverUrl: 'https://api.openai.com/v1',
          }),
        ],
      },
    } as unknown as Partial<AppSettings>;

    const view = mount(<ConversationModelSelector hasMessages={false} isExpanded />);
    mounted.push(view);
    await act(async () => {
      await Promise.resolve();
    });
    expect(workingSelect(view.container).textContent).toContain('ChatGPT Pro GPT 5.5');

    codexConnected = false;
    await act(async () => {
      document.dispatchEvent(new Event('visibilitychange'));
      await Promise.resolve();
    });

    expect(workingSelect(view.container).textContent).not.toContain('ChatGPT Pro GPT 5.5');
  });

  it('dedups catalog options when a user profile owns the same composite key', async () => {
    const anthropicModel = PROVIDER_CATALOGS.anthropic[0]!;
    mocks.draftSettings = {
      models: { apiKey: 'fake-ant-test' },
      localModel: {
        profiles: [
          makeProfile({
            id: 'custom-claude',
            name: 'My Claude',
            providerType: 'anthropic',
            routeSurface: 'api-key',
            model: anthropicModel.model,
          }),
        ],
      },
    } as unknown as Partial<AppSettings>;

    const view = await renderSelector(false);
    mounted.push(view);

    const select = workingSelect(view.container);
    const anthropicGroup = Array.from(select.querySelectorAll('optgroup')).find(
      (group) => group.label === 'Anthropic',
    );
    expect(anthropicGroup?.textContent).not.toContain(anthropicModel.label);
    expect(select.textContent).toContain('My Claude');
  });

  it('advanced picker model selection updates the working session override', async () => {
    mocks.draftSettings = {
      models: { apiKey: 'fake-ant-test' },
      localModel: { profiles: [] },
    } as unknown as Partial<AppSettings>;

    const view = await renderSelector(false);
    mounted.push(view);

    const select = workingSelect(view.container);
    act(() => {
      select.value = 'claude-opus-4-7';
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });

    expect(mocks.setSessionModelOverrides).toHaveBeenCalledWith({
      workingModel: 'claude-opus-4-7',
      workingProfileId: undefined,
      thinkingModel: undefined,
      thinkingProfileId: undefined,
      thinkingEffort: undefined,
    });
  });

  it('advanced picker profile selection persists profile id and resolved model', async () => {
    const profile = makeProfile({
      id: 'custom-gemini',
      name: 'My Gemini',
      providerType: 'google',
      routeSurface: 'api-key',
      model: 'gemini-2.5-pro-experimental',
    });
    mocks.draftSettings = {
      localModel: { profiles: [profile] },
    } as unknown as Partial<AppSettings>;

    const view = await renderSelector(false);
    mounted.push(view);

    const select = workingSelect(view.container);
    act(() => {
      select.value = `profile:${profile.id}`;
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });

    expect(mocks.setSessionModelOverrides).toHaveBeenCalledWith({
      workingModel: 'gemini-2.5-pro-experimental',
      workingProfileId: profile.id,
      thinkingModel: undefined,
      thinkingProfileId: undefined,
      thinkingEffort: undefined,
    });
  });

  it('uses canonical resolved profile display for the Global working label', async () => {
    const profile = makeProfile({
      id: 'global-working',
      name: 'Global GPT',
      model: 'gpt-5.5',
    });
    mocks.draftSettings = {
      models: { workingProfileId: profile.id },
      localModel: { profiles: [profile], activeProfileId: null },
    } as unknown as Partial<AppSettings>;

    const view = await renderSelector(false);
    mounted.push(view);

    expect(offOptionLabel(workingSelect(view.container))).toBe('Global (Global GPT)');
  });

  it('shows the Global thinking label as inherited working when no thinking role is configured', async () => {
    mocks.draftSettings = {
      models: { model: 'claude-haiku-4-5' },
      localModel: { profiles: [], activeProfileId: null },
    } as unknown as Partial<AppSettings>;

    const view = await renderSelector(false);
    mounted.push(view);

    expect(offOptionLabel(workingSelect(view.container))).toBe('Global (Haiku 4.5)');
    expect(offOptionLabel(thinkingSelect(view.container))).toBe('Global (Haiku 4.5)');
  });

  it('marks the profile-resolved global Maximum tier as selected by default', async () => {
    const profile = makeProfile({
      id: 'profile-gpt55',
      name: 'GPT 5.5',
      model: 'gpt-5.5',
    });
    mocks.draftSettings = {
      models: {
        workingProfileId: profile.id,
        thinkingModel: 'claude-opus-4-8',
        thinkingEffort: 'xhigh',
      },
      localModel: { profiles: [profile], activeProfileId: null },
    } as unknown as Partial<AppSettings>;

    const view = await renderSelector(false);
    mounted.push(view);

    expect(view.container.querySelector('[data-testid="quality-tier-maximum"]')?.getAttribute('aria-checked')).toBe('true');
  });

  it('treats a disconnected nameless global profile as null-effective for label and tier matching', async () => {
    const profile = makeProfile({
      id: 'disconnected-gpt55',
      name: '',
      providerType: 'openai',
      routeSurface: 'subscription',
      authSource: 'codex-subscription',
      profileSource: 'connection',
      model: 'gpt-5.5',
    });
    mocks.draftSettings = {
      models: {
        workingProfileId: profile.id,
        thinkingModel: 'claude-opus-4-8',
        thinkingEffort: 'xhigh',
      },
      localModel: { profiles: [profile], activeProfileId: null },
    } as unknown as Partial<AppSettings>;

    const view = await renderSelector(false);
    mounted.push(view);

    expect(offOptionLabel(workingSelect(view.container))).toBe('Global (gpt-5.5)');
    expect(view.container.querySelector('[data-testid="quality-tier-maximum"]')?.getAttribute('aria-checked')).toBe('false');
    expect(view.container.querySelector('[data-testid="quality-slider"]')?.textContent).toContain('Custom');
  });
});

describe('ConversationModelSelector effort-only post-recovery label', () => {
  const mounted: Mounted[] = [];

  beforeEach(() => {
    mocks.draftSettings = {};
    mocks.setSessionModelOverrides.mockReset();
    mocks.sessionState.sessionWorkingModel = undefined;
    mocks.sessionState.sessionThinkingModel = undefined;
    mocks.sessionState.sessionWorkingProfileId = undefined;
    mocks.sessionState.sessionThinkingProfileId = undefined;
    mocks.sessionState.sessionThinkingEffort = undefined;
  });

  afterEach(() => {
    for (const instance of mounted) instance.unmount();
    mounted.length = 0;
    document.body.innerHTML = '';
    vi.restoreAllMocks();
  });

  async function mountLocked(): Promise<Mounted> {
    Object.defineProperty(window, 'codexApi', {
      configurable: true,
      value: { status: vi.fn(async () => ({ connected: false })) },
    });
    const view = mount(<ConversationModelSelector hasMessages isExpanded={false} />);
    await act(async () => {
      await Promise.resolve();
    });
    return view;
  }

  function lockedLabelText(container: HTMLElement): string {
    return container.querySelector('[data-testid="locked-state-label"]')?.textContent ?? '';
  }

  it('renders the default tier name plus an effort qualifier (not "Custom") when only a non-default effort remains', async () => {
    // Post-FOX-3494 recovery: all model/profile overrides cleared, effort preserved.
    // Global default (Sonnet + high effort) → Balanced tier; session has "xhigh" → qualifier shows.
    mocks.draftSettings = {
      models: { apiKey: 'fake-ant-test', model: 'claude-sonnet-4-6', thinkingEffort: 'high' },
      localModel: { profiles: [], activeProfileId: null },
    } as unknown as Partial<AppSettings>;
    mocks.sessionState.sessionThinkingEffort = 'xhigh';

    const view = await mountLocked();
    mounted.push(view);

    const text = lockedLabelText(view.container);
    expect(text).not.toContain('Custom');
    expect(text).toContain('·');
    expect(text).toContain('Maximum thinking');
    // Default tier (Balanced) name renders alongside the qualifier — matches the
    // Chief Designer's target copy "Using: Balanced · …".
    expect(text).toContain('Balanced');
  });

  it('omits the effort qualifier when the preserved effort matches the global default (renders null — nothing to show)', async () => {
    mocks.draftSettings = {
      models: { apiKey: 'fake-ant-test', model: 'claude-sonnet-4-6', thinkingEffort: 'high' },
      localModel: { profiles: [], activeProfileId: null },
    } as unknown as Partial<AppSettings>;
    mocks.sessionState.sessionThinkingEffort = 'high';

    const view = await mountLocked();
    mounted.push(view);

    // Effort matches the global default → overridesMatchGlobalDefault → component returns null.
    expect(view.container.querySelector('[data-testid="locked-state-label"]')).toBeNull();
  });

  it('still renders "Custom" for a genuine model override (unchanged behaviour)', async () => {
    mocks.draftSettings = {
      models: { apiKey: 'fake-ant-test', model: 'claude-sonnet-4-6' },
      localModel: { profiles: [], activeProfileId: null },
    } as unknown as Partial<AppSettings>;
    // A working-model override that doesn't match any tier → Custom branch.
    mocks.sessionState.sessionWorkingModel = 'claude-opus-4-7';
    mocks.sessionState.sessionThinkingModel = undefined;
    mocks.sessionState.sessionThinkingEffort = undefined;

    const view = await mountLocked();
    mounted.push(view);

    const text = lockedLabelText(view.container);
    expect(text).toContain('Custom');
    expect(text).not.toContain('·');
  });
});

describe('ConversationModelSelector handleSaveAsDefault', () => {
  const mounted: Mounted[] = [];

  beforeEach(() => {
    mocks.draftSettings = {};
    mocks.setSessionModelOverrides.mockReset();
    mocks.sessionState.sessionWorkingModel = undefined;
    mocks.sessionState.sessionThinkingModel = undefined;
    mocks.sessionState.sessionWorkingProfileId = undefined;
    mocks.sessionState.sessionThinkingProfileId = undefined;
    mocks.sessionState.sessionThinkingEffort = undefined;
  });

  afterEach(() => {
    for (const instance of mounted) instance.unmount();
    mounted.length = 0;
    document.body.innerHTML = '';
    vi.restoreAllMocks();
  });

  it('writes the new defaults into the models namespace and never resurrects the legacy claude block', async () => {
    mocks.draftSettings = {
      models: { apiKey: 'fake-ant-test', model: 'claude-sonnet-4-6' },
      providerKeys: { google: 'google-test-key' },
      openRouter: { oauthToken: 'or-token' },
      localModel: { profiles: [], activeProfileId: null },
    } as unknown as Partial<AppSettings>;
    mocks.sessionState.sessionWorkingModel = 'claude-opus-4-7';

    const getMock = vi.fn(async () => ({
      ...(mocks.draftSettings as AppSettings),
    }));
    const updateMock = vi.fn(async (next: AppSettings) => next);

    Object.defineProperty(window, 'codexApi', {
      configurable: true,
      value: { status: vi.fn(async () => ({ connected: false })) },
    });
    Object.defineProperty(window, 'settingsApi', {
      configurable: true,
      value: { get: getMock, update: updateMock },
    });

    const view = mount(<ConversationModelSelector hasMessages={false} isExpanded />);
    mounted.push(view);

    await act(async () => {
      await Promise.resolve();
    });

    const button = view.container.querySelector<HTMLButtonElement>(
      '[data-testid="save-as-default-button"]',
    );
    expect(button).not.toBeNull();

    await act(async () => {
      button?.click();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(updateMock).toHaveBeenCalledTimes(1);
    const payload = updateMock.mock.calls[0]?.[0] as AppSettings & {
      models?: Record<string, unknown>;
      claude?: unknown;
    };
    expect(payload.models?.model).toBe('claude-opus-4-7');
    expect(payload.models?.workingProfileId).toBeNull();
    expect(payload.models?.thinkingProfileId).toBeNull();
    // Legacy claude block must not be touched/written by the save-as-default path.
    expect(payload.claude).toBeUndefined();
  });
});
