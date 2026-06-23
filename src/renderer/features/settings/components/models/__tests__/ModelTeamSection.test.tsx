// @vitest-environment happy-dom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { RoleAssignment } from '@core/rebelCore/roleAssignment';
import type { AppSettings, ModelProfile } from '@shared/types';
import { getRoutingEligibleProfiles } from '@shared/utils/routingProfiles';
import type { ManagedAllowListState } from '@shared/utils/councilProfiles';
import {
  appendRendererOptimisticTurnStartedEvent,
  clearCurrentSessionEvents,
  useSessionStore,
} from '@renderer/features/agent-session/store/sessionStore';
import { ModelTeamSection } from '../ModelTeamSection';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type Mounted = {
  container: HTMLDivElement;
  root: Root;
  unmount: () => void;
};

const MID_TURN_ID = 'settings-model-team-mid-turn';

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

describe('ModelTeamSection', () => {
  let mounted: Mounted | null = null;
  let onSettingsChange: ReturnType<typeof vi.fn<(updates: Partial<AppSettings>) => void>>;
  let onProfilesChange: ReturnType<typeof vi.fn<(profiles: ModelProfile[]) => void>>;
  let onAddModel: ReturnType<typeof vi.fn<() => void>>;
  let onOpenProfileManager: ReturnType<typeof vi.fn<(profileId: string) => void>>;

  beforeEach(() => {
    onSettingsChange = vi.fn<(updates: Partial<AppSettings>) => void>();
    onProfilesChange = vi.fn<(profiles: ModelProfile[]) => void>();
    onAddModel = vi.fn<() => void>();
    onOpenProfileManager = vi.fn<(profileId: string) => void>();
    act(() => {
      clearCurrentSessionEvents();
      useSessionStore.setState({ isBusy: false, activeTurnId: null, sessionSummaries: [] });
    });
  });

  afterEach(() => {
    mounted?.unmount();
    mounted = null;
    clearCurrentSessionEvents();
    document.body.innerHTML = '';
  });

  function renderSection(
    profiles: ModelProfile[] = [],
    options: {
      settings?: AppSettings;
      assignment?: RoleAssignment;
      managedAllowListState?: ManagedAllowListState;
    } = {},
  ): Mounted {
    const settings = options.settings ?? makeSettings(profiles);
    mounted = mount(
      <ModelTeamSection
        settings={settings}
        workingAssignment={options.assignment ?? workingAssignment}
        profiles={profiles}
        onSettingsChange={onSettingsChange}
        onProfilesChange={onProfilesChange}
        onAddModel={onAddModel}
        onOpenProfileManager={onOpenProfileManager}
        managedAllowListState={options.managedAllowListState}
      />,
    );
    return mounted;
  }

  it('renders the working-model-only state with annotation, empty copy, and count math', () => {
    const m = renderSection();

    expect(m.container.querySelector('h2')?.textContent).toBe('Optional model team');
    expect(m.container.textContent).toContain('Claude Sonnet 4.6');
    expect(m.container.textContent).toContain('your main model — always in the pool');
    expect(m.container.textContent).toContain('Just your main model for now — add another to give Rebel choices.');
    expect(m.container.querySelector('[data-testid="settings-model-team-routing-count"]')?.textContent)
      .toContain('Smart picking pool: 1 model');
  });

  it('uses the runtime fallback model as the main member when the selected working profile is unavailable', () => {
    const brokenSelectedProfile = makeProfile({
      id: 'broken-working',
      name: 'Broken working profile',
      serverUrl: '',
      model: 'gpt-5.5',
    });
    const profiles = [brokenSelectedProfile];
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

    const m = renderSection(profiles, { settings, assignment });
    const workingRow = m.container.querySelector('[data-testid="settings-model-team-row-working"]');

    expect(workingRow?.textContent).toContain('Sonnet 4.6');
    expect(workingRow?.textContent).toContain('claude-sonnet-4-6');
    expect(workingRow?.textContent).not.toContain('Broken working profile');
    expect(workingRow?.textContent).not.toContain('gpt-5.5');
  });

  it('renders multi-member Council and Smart picking chips correctly', () => {
    const profiles = [
      makeProfile({ id: 'council-only', name: 'Council only', councilEnabled: true }),
      makeProfile({ id: 'smart-only', name: 'Smart only', routingEligible: true }),
      makeProfile({ id: 'both', name: 'Both', councilEnabled: true, routingEligible: true }),
    ];
    const m = renderSection(profiles);

    expect(m.container.querySelector('[data-testid="settings-model-team-council-only-council"]')?.getAttribute('aria-pressed')).toBe('true');
    expect(m.container.querySelector('[data-testid="settings-model-team-council-only-smart-picking"]')?.getAttribute('aria-pressed')).toBe('false');
    expect(m.container.querySelector('[data-testid="settings-model-team-smart-only-council"]')?.getAttribute('aria-pressed')).toBe('false');
    expect(m.container.querySelector('[data-testid="settings-model-team-smart-only-smart-picking"]')?.getAttribute('aria-pressed')).toBe('true');
    expect(m.container.querySelector('[data-testid="settings-model-team-both-council"]')?.getAttribute('aria-pressed')).toBe('true');
    expect(m.container.querySelector('[data-testid="settings-model-team-both-smart-picking"]')?.getAttribute('aria-pressed')).toBe('true');
  });

  it('shows the no-effect Notice when Smart picking is on with zero non-working eligible profiles', () => {
    const m = renderSection([], { settings: makeSettings([], true) });

    expect(m.container.querySelector('[data-testid="settings-model-team-no-effect-notice"]')?.textContent)
      .toContain('Smart picking is on, but Rebel needs at least one extra model to pick between.');
    expect(m.container.querySelector('[data-testid="settings-model-team-no-effect-notice"]')?.getAttribute('role'))
      .toBe('note');
  });

  it('shows the off-but-eligible Notice and turns Smart picking on', () => {
    const profile = makeProfile({ id: 'smart', routingEligible: true });
    const m = renderSection([profile], { settings: makeSettings([profile], false) });

    expect(m.container.querySelector('[data-testid="settings-model-team-off-notice"]')?.textContent)
      .toContain('Smart picking is off, so these models are waiting politely.');

    click(m.container.querySelector('[data-testid="settings-model-team-turn-on"]'));

    expect(onSettingsChange).toHaveBeenCalledWith({
      experimental: { adaptiveRoutingEnabled: true },
    });
  });

  it('warns when duplicate Smart-picking-eligible profiles share the same model', () => {
    const profiles = [
      makeProfile({ id: 'first', model: 'same-model', routingEligible: true }),
      makeProfile({ id: 'second', model: 'same-model', routingEligible: true }),
    ];
    const m = renderSection(profiles, { settings: makeSettings(profiles, true) });

    expect(m.container.querySelector('[data-testid="settings-model-team-duplicate-notice"]')?.textContent)
      .toContain('Two profiles use the same model. Rebel will only choose one of them while Smart picking is on.');

    click(m.container.querySelector('[data-testid="settings-model-team-open-profile-manager"]'));
    expect(onOpenProfileManager).toHaveBeenCalledWith('first');
  });

  it('suppresses the duplicate Smart picking warning when Smart picking is off', () => {
    const profiles = [
      makeProfile({ id: 'first', model: 'same-model', routingEligible: true }),
      makeProfile({ id: 'second', model: 'same-model', routingEligible: true }),
    ];
    const m = renderSection(profiles, { settings: makeSettings(profiles, false) });

    expect(m.container.querySelector('[data-testid="settings-model-team-duplicate-notice"]')).toBeNull();
  });

  it('writes the master toggle through to adaptiveRoutingEnabled', () => {
    const m = renderSection();
    const toggle = m.container.querySelector<HTMLInputElement>('[data-testid="settings-model-team-smart-picking-toggle"]');
    if (!toggle) throw new Error('Missing Smart picking toggle');

    changeToggle(toggle, true);

    expect(onSettingsChange).toHaveBeenCalledWith({
      experimental: { adaptiveRoutingEnabled: true },
    });
  });

  it('invokes the Add a model to your team deep-link handler', () => {
    const m = renderSection();

    click(m.container.querySelector('[data-testid="settings-model-team-add-model"]'));

    expect(onAddModel).toHaveBeenCalledTimes(1);
  });

  it('keeps working-model row chips passive', () => {
    const m = renderSection();

    click(m.container.querySelector('[data-testid="settings-model-team-working-council"]'));
    click(m.container.querySelector('[data-testid="settings-model-team-working-smart-picking"]'));

    expect(onProfilesChange).not.toHaveBeenCalled();
    expect(onSettingsChange).not.toHaveBeenCalled();
    expect(m.container.querySelector('[data-testid="settings-model-team-working-smart-picking"]')?.getAttribute('aria-label'))
      .toBe('Smart picking: included');
  });

  it('keeps UI, councilService, and routingProfiles aligned on the team member set', async () => {
    const council = makeProfile({ id: 'council', name: 'Council', councilEnabled: true, model: 'council-model' });
    const routing = makeProfile({ id: 'routing', name: 'Routing', routingEligible: true, model: 'routing-model' });
    const profiles = [council, routing];
    const settings = makeSettings(profiles, true);
    const m = renderSection(profiles, { settings });
    const councilServicePath = pathToFileURL(`${process.cwd()}/src/main/services/councilService.ts`).href;
    const councilService = await import(councilServicePath) as {
      getCouncilProfiles: (nextSettings: AppSettings) => ModelProfile[];
    };

    const councilIds = councilService.getCouncilProfiles(settings).map((profile) => profile.id);
    const routingIds = getRoutingEligibleProfiles(settings).map((profile) => profile.id);
    const renderedProfileIds = Array.from(
      m.container.querySelectorAll<HTMLElement>('[data-testid="settings-model-team-row"][data-profile-id]'),
    ).map((row) => row.dataset.profileId);
    const renderedMemberIds = [
      m.container.querySelector<HTMLElement>('[data-testid="settings-model-team-row-working"]')?.dataset.memberId,
      ...renderedProfileIds,
    ].filter((id): id is string => Boolean(id));

    expect(councilIds).toEqual(['council']);
    expect(routingIds).toEqual(['routing']);
    expect(renderedMemberIds).toEqual(['working-model', 'council', 'routing']);
    expect(new Set(renderedMemberIds)).toEqual(new Set(['working-model', ...councilIds, ...routingIds]));
  });

  it('keeps disabled Council profiles visible with disabled membership controls', async () => {
    const disabledCouncil = makeProfile({
      id: 'disabled-council',
      name: 'Disabled Council',
      councilEnabled: true,
      enabled: false,
    });
    const profiles = [disabledCouncil];
    const settings = makeSettings(profiles, true);
    const m = renderSection(profiles, { settings });
    const councilServicePath = pathToFileURL(`${process.cwd()}/src/main/services/councilService.ts`).href;
    const councilService = await import(councilServicePath) as {
      getCouncilProfiles: (nextSettings: AppSettings) => ModelProfile[];
    };

    expect(councilService.getCouncilProfiles(settings).map((profile) => profile.id)).toEqual([]);
    expect(m.container.querySelector('[data-profile-id="disabled-council"]')).not.toBeNull();
    expect(m.container.textContent).toContain('Disabled Council');
    expect(m.container.querySelector('[data-testid="settings-model-team-disabled-council-council"]')?.getAttribute('aria-disabled'))
      .toBe('true');
  });

  it('uses runtime model-based working-model dedupe for Smart picking pool count', () => {
    const workingModelId = workingAssignment.effectiveModelId ?? 'claude-sonnet-4-6';
    const sameModelProfile = makeProfile({
      id: 'same-as-working',
      name: 'Same as working',
      model: workingModelId,
      routingEligible: true,
    });
    const profiles = [sameModelProfile];
    const settings = makeSettings(profiles, true);
    const runtimePoolCount = getRoutingEligibleProfiles(settings).length;
    const m = renderSection(profiles, { settings });

    expect(runtimePoolCount).toBe(1);
    expect(m.container.querySelector('[data-testid="settings-model-team-row-working"]')).toBeNull();
    expect(m.container.querySelector('[data-testid="settings-model-team-routing-count"]')?.textContent)
      .toContain('Smart picking pool: 1 model');
    expect(m.container.querySelector('[data-testid="settings-model-team-no-effect-notice"]')?.textContent)
      .toContain('Smart picking is on, but Rebel needs at least one extra model to pick between.');
  });

  it('documents Council × Smart picking composition at the settings layer', () => {
    const both = makeProfile({
      id: 'both',
      name: 'Council and Smart',
      councilEnabled: true,
      routingEligible: true,
    });
    const m = renderSection([both], { settings: makeSettings([both], true) });

    expect(m.container.querySelector('[data-testid="settings-model-team-both-council"]')?.getAttribute('aria-pressed')).toBe('true');
    expect(m.container.querySelector('[data-testid="settings-model-team-both-smart-picking"]')?.getAttribute('aria-pressed')).toBe('true');
    expect(getRoutingEligibleProfiles(makeSettings([both], true)).map((profile) => profile.id)).toEqual(['both']);
  });

  it('disables member chips with the live mid-turn tooltip', () => {
    const profile = makeProfile({
      id: 'mid-turn-member',
      name: 'Mid-turn member',
      councilEnabled: true,
      routingEligible: true,
    });
    act(() => {
      appendRendererOptimisticTurnStartedEvent(MID_TURN_ID);
      useSessionStore.setState({ activeTurnId: MID_TURN_ID, sessionSummaries: [] });
    });
    const m = renderSection([profile], { settings: makeSettings([profile], true) });

    const council = m.container.querySelector<HTMLElement>('[data-testid="settings-model-team-mid-turn-member-council"]');
    expect(council?.getAttribute('aria-disabled')).toBe('true');
    act(() => {
      council?.focus();
    });
    expect(document.body.querySelector('[role="tooltip"]')?.textContent).toContain(
      'Edits apply to your next turn.',
    );
  });

  it('keeps member chips interactive when no turn is in flight', () => {
    const profile = makeProfile({
      id: 'idle-member',
      name: 'Idle member',
      councilEnabled: false,
      routingEligible: true,
    });
    const m = renderSection([profile], { settings: makeSettings([profile], true) });

    const council = m.container.querySelector<HTMLElement>('[data-testid="settings-model-team-idle-member-council"]');
    expect(council?.getAttribute('aria-disabled')).toBeNull();
    click(council);
    expect(onProfilesChange).toHaveBeenCalledWith([
      expect.objectContaining({ id: 'idle-member', councilEnabled: true }),
    ]);
  });

  it('prefers company-managed member tooltip over the mid-turn tooltip', () => {
    const profile = makeProfile({
      id: 'managed-mid-turn-member',
      name: 'Managed mid-turn member',
      companyManaged: true,
      councilEnabled: true,
    });
    act(() => {
      appendRendererOptimisticTurnStartedEvent(MID_TURN_ID);
      useSessionStore.setState({ activeTurnId: MID_TURN_ID, sessionSummaries: [] });
    });
    const m = renderSection([profile], { settings: makeSettings([profile], true) });

    const council = m.container.querySelector<HTMLElement>('[data-testid="settings-model-team-managed-mid-turn-member-council"]');
    expect(council?.getAttribute('aria-disabled')).toBe('true');
    act(() => {
      council?.focus();
    });
    const tooltipText = document.body.querySelector('[role="tooltip"]')?.textContent;
    expect(tooltipText).toContain('Managed by your company. Contact your admin to change.');
    expect(tooltipText).not.toContain('Edits apply to your next turn.');
  });

  it('prefers company-managed member tooltip when managed, disabled, and mid-turn conditions all apply', () => {
    const profile = makeProfile({
      id: 'managed-disabled-mid-turn-member',
      name: 'Managed disabled mid-turn member',
      companyManaged: true,
      enabled: false,
      councilEnabled: true,
      routingEligible: true,
    });
    act(() => {
      appendRendererOptimisticTurnStartedEvent(MID_TURN_ID);
      useSessionStore.setState({ activeTurnId: MID_TURN_ID, sessionSummaries: [] });
    });
    const m = renderSection([profile], { settings: makeSettings([profile], true) });

    const council = m.container.querySelector<HTMLElement>('[data-testid="settings-model-team-managed-disabled-mid-turn-member-council"]');
    expect(council?.getAttribute('aria-disabled')).toBe('true');
    act(() => {
      council?.focus();
    });
    const tooltipText = document.body.querySelector('[role="tooltip"]')?.textContent;
    expect(tooltipText).toContain('Managed by your company. Contact your admin to change.');
    expect(tooltipText).not.toContain('Enable this profile first.');
    expect(tooltipText).not.toContain('Edits apply to your next turn.');
  });

  it('prefers profile-disabled member tooltip over the mid-turn tooltip', () => {
    const profile = makeProfile({
      id: 'disabled-mid-turn-member',
      name: 'Disabled mid-turn member',
      enabled: false,
      routingEligible: true,
    });
    act(() => {
      appendRendererOptimisticTurnStartedEvent(MID_TURN_ID);
      useSessionStore.setState({ activeTurnId: MID_TURN_ID, sessionSummaries: [] });
    });
    const m = renderSection([profile], { settings: makeSettings([profile], true) });

    const smartPicking = m.container.querySelector<HTMLElement>('[data-testid="settings-model-team-disabled-mid-turn-member-smart-picking"]');
    expect(smartPicking?.getAttribute('aria-disabled')).toBe('true');
    act(() => {
      smartPicking?.focus();
    });
    const tooltipText = document.body.querySelector('[role="tooltip"]')?.textContent;
    expect(tooltipText).toContain('Enable this profile first.');
    expect(tooltipText).not.toContain('Edits apply to your next turn.');
  });

  it('matches snapshot when managed mode has zero eligible council survivors', () => {
    const profiles = [
      makeProfile({
        id: 'managed-zero',
        name: 'Managed zero survivor',
        providerType: 'openrouter',
        model: 'openai/gpt-5.9',
        councilEnabled: true,
        routingEligible: true,
      }),
    ];
    const settings = makeSettings(profiles, true);
    settings.activeProvider = 'mindstone';
    const m = renderSection(profiles, {
      settings,
      managedAllowListState: { kind: 'ready', allowed: ['openai/gpt-5.5'] },
    });

    expect(m.container.querySelector('[data-testid="settings-model-team-managed-zero-survivor-notice"]'))
      .not.toBeNull();
    expect(m.container.innerHTML).toMatchSnapshot();
  });

  it('matches snapshot when managed mode has one eligible survivor', () => {
    const profiles = [
      makeProfile({
        id: 'managed-keep',
        name: 'Managed keep',
        providerType: 'openrouter',
        model: 'openai/gpt-5.5',
        councilEnabled: true,
      }),
      makeProfile({
        id: 'managed-skip',
        name: 'Managed skip',
        providerType: 'openrouter',
        model: 'openai/gpt-5.9',
        councilEnabled: true,
      }),
    ];
    const settings = makeSettings(profiles, true);
    settings.activeProvider = 'mindstone';
    const m = renderSection(profiles, {
      settings,
      managedAllowListState: { kind: 'ready', allowed: ['openai/gpt-5.5'] },
    });

    expect(m.container.querySelector('[data-testid="settings-model-team-managed-zero-survivor-notice"]'))
      .toBeNull();
    expect(
      m.container.querySelector('[data-testid="settings-model-team-managed-skip-council"]')
        ?.getAttribute('aria-disabled'),
    ).toBe('true');
    expect(m.container.innerHTML).toMatchSnapshot();
  });

  it('matches snapshot when managed allow-list is unavailable and membership stays editable', () => {
    const profiles = [
      makeProfile({
        id: 'managed-unavailable',
        name: 'Managed unavailable',
        providerType: 'openrouter',
        model: 'openai/gpt-5.9',
        councilEnabled: true,
      }),
    ];
    const settings = makeSettings(profiles, true);
    settings.activeProvider = 'mindstone';
    const m = renderSection(profiles, {
      settings,
      managedAllowListState: { kind: 'unavailable' },
    });

    expect(m.container.querySelector('[data-testid="settings-model-team-managed-zero-survivor-notice"]'))
      .toBeNull();
    expect(
      m.container.querySelector('[data-testid="settings-model-team-managed-unavailable-council"]')
        ?.getAttribute('aria-disabled'),
    ).toBeNull();
    expect(m.container.innerHTML).toMatchSnapshot();
  });
});
