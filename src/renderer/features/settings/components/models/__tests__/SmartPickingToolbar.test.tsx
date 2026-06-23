// @vitest-environment happy-dom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { RoleAssignment } from '@core/rebelCore/roleAssignment';
import type { AppSettings, ModelProfile } from '@shared/types';
import { createProfileConnectivity, type ProfileConnectivity } from '@shared/utils/connectivityHelpers';
import { SmartPickingToolbar } from '../SmartPickingToolbar';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type Mounted = {
  container: HTMLDivElement;
  root: Root;
  unmount: () => void;
};

const workingAssignment: RoleAssignment = {
  role: 'working',
  label: 'Working',
  primary: { kind: 'model', modelId: 'claude-sonnet-4-6' },
  fallback: null,
  status: { kind: 'ok', source: 'model' },
  display: {
    modelLabel: 'Claude Sonnet 4.6',
    providerLabel: 'Anthropic',
    billingSource: 'pay-per-use',
  },
  fallbackDisplay: null,
  effectiveModelId: 'claude-sonnet-4-6',
  warning: null,
  warningCta: null,
};

function makeProfile(overrides: Partial<ModelProfile> = {}): ModelProfile {
  return {
    id: overrides.id ?? 'profile-1',
    name: overrides.name ?? 'OpenAI / GPT-5.5',
    providerType: overrides.providerType ?? 'openai',
    serverUrl: overrides.serverUrl ?? 'https://api.openai.com/v1',
    model: overrides.model ?? 'gpt-5.5',
    apiKey: 'fake-test-token',
    enabled: true,
    createdAt: 1,
    ...overrides,
  };
}

function makeSettings(
  profiles: ModelProfile[] = [],
  adaptiveRoutingEnabled = false,
): AppSettings {
  return {
    activeProvider: 'anthropic',
    experimental: { adaptiveRoutingEnabled },
    localModel: { activeProfileId: null, profiles },
    models: { apiKey: 'fake-test-token' },
  } as AppSettings;
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
      act(() => root.unmount());
      container.remove();
    },
  };
}

function click(element: Element | null): void {
  act(() => {
    element?.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  });
}

function changeToggle(input: HTMLInputElement, checked: boolean): void {
  act(() => {
    if (input.checked !== checked) {
      input.click();
    }
  });
}

describe('SmartPickingToolbar', () => {
  let mounted: Mounted | null = null;
  let onSettingsChange: ReturnType<typeof vi.fn<(updates: Partial<AppSettings>) => void>>;
  let onAddModel: ReturnType<typeof vi.fn<() => void>>;
  let onOpenProfileManager: ReturnType<typeof vi.fn<(profileId: string) => void>>;

  beforeEach(() => {
    onSettingsChange = vi.fn<(updates: Partial<AppSettings>) => void>();
    onAddModel = vi.fn<() => void>();
    onOpenProfileManager = vi.fn<(profileId: string) => void>();
  });

  afterEach(() => {
    mounted?.unmount();
    mounted = null;
    document.body.innerHTML = '';
  });

  function renderToolbar(
    profiles: ModelProfile[] = [],
    options: {
      settings?: AppSettings;
      assignment?: RoleAssignment;
      connectivity?: ProfileConnectivity;
    } = {},
  ): Mounted {
    const settings = options.settings ?? makeSettings(profiles);
    mounted = mount(
      <SmartPickingToolbar
        settings={settings}
        profiles={profiles}
        workingAssignment={options.assignment ?? workingAssignment}
        connectivity={options.connectivity}
        onSettingsChange={onSettingsChange}
        onAddModel={onAddModel}
        onOpenProfileManager={onOpenProfileManager}
      />,
    );
    return mounted;
  }

  it('renders the toolbar with title, master toggle, and main-model-only pool count', () => {
    const m = renderToolbar();

    expect(m.container.querySelector('h3')?.textContent).toBe('Smart model picking');
    expect(m.container.querySelector('[data-testid="settings-smart-picking-pool-count"]')?.textContent)
      .toContain('Smart picking pool: 1 model');
    expect(m.container.querySelector<HTMLInputElement>('[data-testid="settings-smart-picking-master-toggle"]')?.checked)
      .toBe(false);
  });

  it('excludes disconnected connection-managed profiles from the pool count', () => {
    const profiles = [
      makeProfile({
        id: 'openrouter-dead',
        name: 'OpenRouter GPT',
        providerType: 'openrouter',
        routeSurface: 'pool',
        profileSource: 'connection',
        routingEligible: true,
      }),
    ];
    const m = renderToolbar(profiles, {
      connectivity: createProfileConnectivity({ openRouterConnected: false }),
    });

    expect(m.container.querySelector('[data-testid="settings-smart-picking-pool-count"]')?.textContent)
      .toContain('Smart picking pool: 1 model');
  });

  it('shows the no-effect Notice when Smart picking is on but only the main model is in the pool', () => {
    const m = renderToolbar([], { settings: makeSettings([], true) });

    const notice = m.container.querySelector('[data-testid="settings-smart-picking-no-effect-notice"]');
    expect(notice?.textContent).toContain('Smart picking is on, but Rebel needs at least one extra model to pick between.');

    click(m.container.querySelector('[data-testid="settings-smart-picking-notice-add-model"]'));
    expect(onAddModel).toHaveBeenCalledTimes(1);
  });

  it('counts the runtime fallback model when the selected working profile is unavailable', () => {
    const brokenSelectedProfile = makeProfile({
      id: 'broken-working',
      name: 'Broken working profile',
      serverUrl: '',
      model: 'gpt-5.5',
    });
    const fallbackTeamProfile = makeProfile({
      id: 'fallback-team-member',
      name: 'Fallback team member',
      model: 'claude-sonnet-4-6',
      routingEligible: true,
    });
    const profiles = [brokenSelectedProfile, fallbackTeamProfile];
    const settings = {
      ...makeSettings(profiles, true),
      models: {
        model: 'claude-sonnet-4-6',
        workingProfileId: brokenSelectedProfile.id,
      },
      localModel: { activeProfileId: null, profiles },
    } as AppSettings;
    const assignment: RoleAssignment = {
      role: 'working',
      label: 'Working',
      primary: { kind: 'profile', profileId: brokenSelectedProfile.id },
      fallback: null,
      status: { kind: 'profile-unavailable-model-active', profileId: brokenSelectedProfile.id },
      display: {
        modelLabel: 'Claude Sonnet 4.6',
        providerLabel: 'Anthropic',
        billingSource: 'pay-per-use',
      },
      fallbackDisplay: null,
      effectiveModelId: 'claude-sonnet-4-6',
      warning: 'Selected profile is unavailable. Using Claude Sonnet 4.6 for now.',
      warningCta: 'Review profile',
    };

    const m = renderToolbar(profiles, { settings, assignment });

    expect(m.container.querySelector('[data-testid="settings-smart-picking-pool-count"]')?.textContent)
      .toContain('Smart picking pool: 1 model');
  });

  it('shows the off-but-eligible Notice and lets the user turn Smart picking on', () => {
    const profile = makeProfile({ id: 'smart', routingEligible: true });
    const m = renderToolbar([profile], { settings: makeSettings([profile], false) });

    expect(m.container.querySelector('[data-testid="settings-smart-picking-off-notice"]')?.textContent)
      .toContain("Smart picking is off, so these models won't be chosen automatically.");

    click(m.container.querySelector('[data-testid="settings-smart-picking-turn-on"]'));

    expect(onSettingsChange).toHaveBeenCalledWith({
      experimental: { adaptiveRoutingEnabled: true },
    });
  });

  it('warns when duplicate Smart-picking-eligible profiles share provider + surface + model', () => {
    const profiles = [
      makeProfile({ id: 'first', model: 'same-model', routeSurface: 'api-key', routingEligible: true }),
      makeProfile({ id: 'second', model: 'same-model', routeSurface: 'api-key', routingEligible: true }),
    ];
    const m = renderToolbar(profiles, { settings: makeSettings(profiles, true) });

    expect(m.container.querySelector('[data-testid="settings-smart-picking-duplicate-notice"]')?.textContent)
      .toContain('Two profiles use the same model. Rebel will only choose one of them while Smart picking is on.');

    click(m.container.querySelector('[data-testid="settings-smart-picking-open-profile-manager"]'));
    expect(onOpenProfileManager).toHaveBeenCalledWith('first');
  });

  it('does not warn when duplicate model IDs use different routing surfaces', () => {
    const profiles = [
      makeProfile({
        id: 'api-key',
        providerType: 'openai',
        routeSurface: 'api-key',
        model: 'gpt-5.5',
        routingEligible: true,
      }),
      makeProfile({
        id: 'subscription',
        providerType: 'openai',
        routeSurface: 'subscription',
        authSource: 'codex-subscription',
        model: 'gpt-5.5',
        routingEligible: true,
      }),
    ];
    const m = renderToolbar(profiles, { settings: makeSettings(profiles, true) });

    expect(m.container.querySelector('[data-testid="settings-smart-picking-duplicate-notice"]')).toBeNull();
  });

  it('suppresses the duplicate Smart picking warning when Smart picking is off', () => {
    const profiles = [
      makeProfile({ id: 'first', model: 'same-model', routingEligible: true }),
      makeProfile({ id: 'second', model: 'same-model', routingEligible: true }),
    ];
    const m = renderToolbar(profiles, { settings: makeSettings(profiles, false) });

    expect(m.container.querySelector('[data-testid="settings-smart-picking-duplicate-notice"]')).toBeNull();
  });

  it('writes the master toggle through to adaptiveRoutingEnabled', () => {
    const m = renderToolbar();
    const toggle = m.container.querySelector<HTMLInputElement>('[data-testid="settings-smart-picking-master-toggle"]');
    if (!toggle) throw new Error('Missing Smart picking toggle');

    changeToggle(toggle, true);

    expect(onSettingsChange).toHaveBeenCalledWith({
      experimental: { adaptiveRoutingEnabled: true },
    });
  });

  it('dedupes the working model from the routing-eligible pool count', () => {
    const workingModelId = workingAssignment.effectiveModelId ?? 'claude-sonnet-4-6';
    const sameModelProfile = makeProfile({
      id: 'same-as-working',
      name: 'Same as working',
      model: workingModelId,
      routingEligible: true,
    });
    const profiles = [sameModelProfile];
    const settings = makeSettings(profiles, true);
    const m = renderToolbar(profiles, { settings });

    expect(m.container.querySelector('[data-testid="settings-smart-picking-pool-count"]')?.textContent)
      .toContain('Smart picking pool: 1 model');
    expect(m.container.querySelector('[data-testid="settings-smart-picking-no-effect-notice"]')?.textContent)
      .toContain('Smart picking is on, but Rebel needs at least one extra model to pick between.');
  });

  it('counts an eligible non-working profile + the working model as a 2-model pool', () => {
    const profile = makeProfile({ id: 'extra', model: 'gpt-5.5', routingEligible: true });
    const m = renderToolbar([profile], { settings: makeSettings([profile], true) });

    expect(m.container.querySelector('[data-testid="settings-smart-picking-pool-count"]')?.textContent)
      .toContain('Smart picking pool: 2 models');
    expect(m.container.querySelector('[data-testid="settings-smart-picking-no-effect-notice"]')).toBeNull();
  });
});
