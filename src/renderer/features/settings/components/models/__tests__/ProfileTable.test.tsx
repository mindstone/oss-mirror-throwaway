// @vitest-environment happy-dom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ProfileTable } from '../ProfileTable';
import type { CustomProvider, ModelProfile } from '@shared/types';
import type { TestStateEntry } from '../useProfileTester';
import {
  appendRendererOptimisticTurnStartedEvent,
  clearCurrentSessionEvents,
  useSessionStore,
} from '@renderer/features/agent-session/store/sessionStore';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

interface Mounted {
  container: HTMLDivElement;
  root: Root;
  unmount: () => void;
  render: (ui: React.ReactElement) => void;
}

const MID_TURN_ID = 'settings-profile-table-mid-turn';

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
    render: (next: React.ReactElement) => {
      act(() => {
        root.render(next);
      });
    },
    unmount: () => {
      act(() => {
        root.unmount();
      });
      container.remove();
    },
  };
}

function makeProfile(overrides: Partial<ModelProfile> = {}): ModelProfile {
  return {
    id: 'p-1',
    name: 'OpenAI / GPT-5.5',
    providerType: 'openai',
    serverUrl: 'https://api.openai.com/v1',
    model: 'gpt-5.5',
    apiKey: 'fake-abc',
    createdAt: 1_700_000_000_000,
    ...overrides,
  };
}

const BASE_HANDLERS = {
  onProfilesChange: vi.fn(),
  onToggleEnabled: vi.fn(),
  onTest: vi.fn(),
  onEdit: vi.fn(),
  onRequestDelete: vi.fn(),
  onConfirmDelete: vi.fn(),
  onHighlightDone: vi.fn(),
};

function defaults(
  overrides: Partial<React.ComponentProps<typeof ProfileTable>> = {},
): React.ComponentProps<typeof ProfileTable> {
  return {
    profiles: [],
    customProviders: [],
    testState: {},
    onProfilesChange: BASE_HANDLERS.onProfilesChange,
    justAddedId: null,
    deleteConfirmId: null,
    onToggleEnabled: BASE_HANDLERS.onToggleEnabled,
    onTest: BASE_HANDLERS.onTest,
    onEdit: BASE_HANDLERS.onEdit,
    onRequestDelete: BASE_HANDLERS.onRequestDelete,
    onConfirmDelete: BASE_HANDLERS.onConfirmDelete,
    onHighlightDone: BASE_HANDLERS.onHighlightDone,
    ...overrides,
  };
}

function getMembershipChip(
  container: HTMLElement,
  profileId: string,
  chip: 'council' | 'smart-picking',
): HTMLElement {
  const element = container.querySelector<HTMLElement>(
    `[data-testid="settings-models-profile-membership-${profileId}-${chip}"]`,
  );
  if (!element) throw new Error(`Missing ${chip} chip for ${profileId}`);
  return element;
}

function click(element: Element | null): void {
  act(() => {
    element?.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  });
}

function keyDown(element: Element | null, key: string): void {
  act(() => {
    element?.dispatchEvent(new window.KeyboardEvent('keydown', { key, bubbles: true }));
  });
}

describe('ProfileTable', () => {
  let mounted: Mounted[] = [];

  beforeEach(() => {
    for (const key of Object.keys(BASE_HANDLERS) as (keyof typeof BASE_HANDLERS)[]) {
      BASE_HANDLERS[key].mockClear();
    }
    act(() => {
      clearCurrentSessionEvents();
      useSessionStore.setState({ isBusy: false, activeTurnId: null, sessionSummaries: [] });
    });
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    for (const instance of mounted) {
      instance.unmount();
    }
    mounted = [];
    clearCurrentSessionEvents();
    document.body.innerHTML = '';
  });

  it('renders one row per profile with name, model ID, and provider label', () => {
    const profiles = [
      makeProfile({ id: 'a', name: 'OpenAI / GPT-5.5', model: 'gpt-5.5' }),
      makeProfile({
        id: 'b',
        name: 'Together Llama',
        providerType: 'together',
        model: 'meta-llama/Llama-3.3-70B',
        serverUrl: 'https://api.together.xyz/v1',
      }),
    ];

    const m = mount(<ProfileTable {...defaults({ profiles })} />);
    mounted.push(m);

    const rows = m.container.querySelectorAll<HTMLTableRowElement>(
      '[data-testid="settings-models-profile-row"]',
    );
    expect(rows.length).toBe(2);
    expect(rows[0]?.getAttribute('data-profile-id')).toBe('a');
    expect(rows[0]?.textContent).toContain('OpenAI / GPT-5.5');
    expect(rows[0]?.textContent).toContain('gpt-5.5');
    expect(rows[0]?.textContent).toContain('OpenAI');

    expect(rows[1]?.textContent).toContain('Together Llama');
    expect(rows[1]?.textContent).toContain('Together AI');
    expect(rows[1]?.textContent).toContain('meta-llama/Llama-3.3-70B');
  });

  // The thinking pill must show the EFFECTIVE thinking level (what actually
  // reaches the wire), not the raw configured effort — otherwise a profile whose
  // thinking is suppressed still advertises e.g. "High". (Sentry REBEL-5RJ; the
  // auto-detect self-heal made the raw display lie.)
  it('shows "No reasoning" when thinking was auto-detected incompatible (suppressed at egress)', () => {
    const profile = makeProfile({
      id: 'gw',
      reasoningEffort: 'high',
      thinkingCompatibility: 'incompatible',
    });
    const m = mount(<ProfileTable {...defaults({ profiles: [profile] })} />);
    mounted.push(m);

    const row = m.container.querySelector<HTMLTableRowElement>(
      '[data-testid="settings-models-profile-row"]',
    );
    expect(row?.textContent).toContain('No reasoning');
    expect(row?.textContent).not.toContain('High');
  });

  it('shows the configured thinking level for a healthy thinking-capable profile', () => {
    const profile = makeProfile({
      id: 'ok',
      reasoningEffort: 'high',
      thinkingCompatibility: 'compatible',
    });
    const m = mount(<ProfileTable {...defaults({ profiles: [profile] })} />);
    mounted.push(m);

    const row = m.container.querySelector<HTMLTableRowElement>(
      '[data-testid="settings-models-profile-row"]',
    );
    expect(row?.textContent).toContain('High');
    expect(row?.textContent).not.toContain('No reasoning');
  });

  it('uses local preset labels for local:* preset profiles', () => {
    const profile = makeProfile({
      id: 'local-ds4',
      providerType: 'other',
      presetKey: 'local:ds4',
      serverUrl: 'http://127.0.0.1:8000/v1',
      model: 'deepseek-v4-flash',
    });
    const m = mount(<ProfileTable {...defaults({ profiles: [profile] })} />);
    mounted.push(m);

    const row = m.container.querySelector<HTMLTableRowElement>(
      '[data-testid="settings-models-profile-row"]',
    );
    expect(row?.textContent).toContain('DS4 (local)');
  });

  it('shows a reconnect CTA for disconnected connection-managed rows', () => {
    const onReconnect = vi.fn();
    const profile = makeProfile({
      id: 'connection-openrouter',
      providerType: 'openrouter',
      routeSurface: 'pool',
      profileSource: 'connection',
      serverUrl: 'https://openrouter.ai/api/v1',
      model: 'openai/gpt-5.5',
    });

    const m = mount(
      <ProfileTable
        {...defaults({
          profiles: [profile],
          needsSetupProfileIds: new Set([profile.id]),
          getReconnectHandler: () => onReconnect,
        })}
      />,
    );
    mounted.push(m);

    const button = m.container.querySelector<HTMLButtonElement>(
      '[data-testid="settings-models-profile-reconnect-connection-openrouter"]',
    );
    expect(button?.textContent).toBe('Reconnect OpenRouter');
    click(button);
    expect(onReconnect).toHaveBeenCalledTimes(1);
  });

  it('renders nothing when there are no profiles', () => {
    const m = mount(<ProfileTable {...defaults({ profiles: [] })} />);
    mounted.push(m);
    expect(
      m.container.querySelector('[data-testid="settings-models-profile-table"]'),
    ).toBeNull();
  });

  it('hides Edit and Delete buttons for companyManaged profiles', () => {
    const profile = makeProfile({ id: 'managed-1', companyManaged: true });
    const m = mount(<ProfileTable {...defaults({ profiles: [profile] })} />);
    mounted.push(m);

    expect(
      m.container.querySelector('[data-testid="settings-models-profile-edit-managed-1"]'),
    ).toBeNull();
    expect(
      m.container.querySelector('[data-testid="settings-models-profile-delete-managed-1"]'),
    ).toBeNull();
    // Test button still available for managed profiles.
    expect(
      m.container.querySelector('[data-testid="settings-models-profile-test-managed-1"]'),
    ).not.toBeNull();
    // Managed badge surfaces in the row.
    expect(m.container.textContent).toContain('Managed');
  });

  it('toggles Council membership through onProfilesChange', () => {
    const onProfilesChange = vi.fn();
    const baseProfile = makeProfile({ id: 'council-toggle', councilEnabled: false });
    const ui = (profile: ModelProfile) => (
      <ProfileTable
        {...defaults({
          profiles: [profile],
          onProfilesChange,
        })}
      />
    );
    const m = mount(ui(baseProfile));
    mounted.push(m);

    click(getMembershipChip(m.container, 'council-toggle', 'council'));
    expect(onProfilesChange).toHaveBeenCalledTimes(1);
    expect(onProfilesChange.mock.calls[0]?.[0]).toEqual([
      expect.objectContaining({ id: 'council-toggle', councilEnabled: true }),
    ]);

    m.render(ui({ ...baseProfile, councilEnabled: true }));
    click(getMembershipChip(m.container, 'council-toggle', 'council'));
    expect(onProfilesChange).toHaveBeenCalledTimes(2);
    expect(onProfilesChange.mock.calls[1]?.[0]).toEqual([
      expect.objectContaining({ id: 'council-toggle', councilEnabled: false }),
    ]);
  });

  it('toggles Smart picking membership through onProfilesChange', () => {
    const onProfilesChange = vi.fn();
    const baseProfile = makeProfile({ id: 'smart-toggle', routingEligible: false });
    const ui = (profile: ModelProfile) => (
      <ProfileTable
        {...defaults({
          profiles: [profile],
          onProfilesChange,
        })}
      />
    );
    const m = mount(ui(baseProfile));
    mounted.push(m);

    click(getMembershipChip(m.container, 'smart-toggle', 'smart-picking'));
    expect(onProfilesChange).toHaveBeenCalledTimes(1);
    expect(onProfilesChange.mock.calls[0]?.[0]).toEqual([
      expect.objectContaining({ id: 'smart-toggle', routingEligible: true }),
    ]);

    m.render(ui({ ...baseProfile, routingEligible: true }));
    click(getMembershipChip(m.container, 'smart-toggle', 'smart-picking'));
    expect(onProfilesChange).toHaveBeenCalledTimes(2);
    expect(onProfilesChange.mock.calls[1]?.[0]).toEqual([
      expect.objectContaining({ id: 'smart-toggle', routingEligible: false }),
    ]);
  });

  it('preserves hidden profiles when a filtered table writes membership changes', () => {
    const onProfilesChange = vi.fn();
    const visible = makeProfile({ id: 'visible', councilEnabled: false });
    const hidden = makeProfile({ id: 'hidden', name: 'Hidden sibling' });
    const m = mount(
      <ProfileTable
        {...defaults({
          profiles: [visible],
          allProfiles: [visible, hidden],
          onProfilesChange,
        })}
      />,
    );
    mounted.push(m);

    click(getMembershipChip(m.container, 'visible', 'council'));
    expect(onProfilesChange.mock.calls[0]?.[0]).toEqual([
      expect.objectContaining({ id: 'visible', councilEnabled: true }),
      expect.objectContaining({ id: 'hidden' }),
    ]);
  });

  it('shows both membership chips with on and off styling in healthy rows', () => {
    const profile = makeProfile({
      id: 'healthy-membership',
      councilEnabled: true,
      routingEligible: false,
    });
    const m = mount(<ProfileTable {...defaults({ profiles: [profile] })} />);
    mounted.push(m);

    const council = getMembershipChip(m.container, 'healthy-membership', 'council');
    const smartPicking = getMembershipChip(m.container, 'healthy-membership', 'smart-picking');
    expect(council.getAttribute('aria-pressed')).toBe('true');
    expect(council.className).toMatch(/membershipChipOn/);
    expect(smartPicking.getAttribute('aria-pressed')).toBe('false');
    expect(smartPicking.className).toMatch(/membershipChipOff/);
  });

  it('keeps interactive membership chips outside live status regions', () => {
    const profile = makeProfile({
      id: 'a11y-membership',
      councilEnabled: true,
      routingEligible: true,
      chatCompatibility: 'compatible',
    });
    const m = mount(<ProfileTable {...defaults({ profiles: [profile] })} />);
    mounted.push(m);

    expect(m.container.querySelector('[role="status"]')).not.toBeNull();
    expect(getMembershipChip(m.container, 'a11y-membership', 'council').closest('[role="status"]'))
      .toBeNull();
    expect(
      getMembershipChip(m.container, 'a11y-membership', 'smart-picking').closest('[role="status"]'),
    ).toBeNull();
  });

  it('disables membership chips with a company-managed tooltip', () => {
    const profile = makeProfile({ id: 'managed-membership', companyManaged: true });
    const m = mount(<ProfileTable {...defaults({ profiles: [profile] })} />);
    mounted.push(m);

    const council = getMembershipChip(m.container, 'managed-membership', 'council');
    expect(council.getAttribute('aria-disabled')).toBe('true');
    act(() => {
      council.focus();
    });
    expect(document.body.querySelector('[role="tooltip"]')?.textContent).toContain(
      'Managed by your company. Contact your admin to change.',
    );
  });

  it('disables membership chips when the profile itself is disabled', () => {
    const profile = makeProfile({ id: 'disabled-membership', enabled: false });
    const m = mount(<ProfileTable {...defaults({ profiles: [profile] })} />);
    mounted.push(m);

    const smartPicking = getMembershipChip(m.container, 'disabled-membership', 'smart-picking');
    expect(smartPicking.getAttribute('aria-disabled')).toBe('true');
    act(() => {
      smartPicking.focus();
    });
    expect(document.body.querySelector('[role="tooltip"]')?.textContent).toContain(
      'Enable this profile first.',
    );
  });

  it('disables membership chips with the live mid-turn tooltip', () => {
    const profile = makeProfile({ id: 'mid-turn-membership' });
    act(() => {
      appendRendererOptimisticTurnStartedEvent(MID_TURN_ID);
      useSessionStore.setState({ activeTurnId: MID_TURN_ID, sessionSummaries: [] });
    });
    const m = mount(<ProfileTable {...defaults({ profiles: [profile] })} />);
    mounted.push(m);

    const council = getMembershipChip(m.container, 'mid-turn-membership', 'council');
    expect(council.getAttribute('aria-disabled')).toBe('true');
    act(() => {
      council.focus();
    });
    expect(document.body.querySelector('[role="tooltip"]')?.textContent).toContain(
      'Edits apply to your next turn.',
    );
  });

  it('keeps membership chips interactive when no turn is in flight', () => {
    const onProfilesChange = vi.fn();
    const profile = makeProfile({ id: 'idle-membership' });
    const m = mount(<ProfileTable {...defaults({ profiles: [profile], onProfilesChange })} />);
    mounted.push(m);

    const council = getMembershipChip(m.container, 'idle-membership', 'council');
    expect(council.getAttribute('aria-disabled')).toBeNull();
    click(council);
    expect(onProfilesChange).toHaveBeenCalledTimes(1);
  });

  it('prefers company-managed tooltip over the mid-turn tooltip', () => {
    const profile = makeProfile({ id: 'managed-mid-turn', companyManaged: true });
    act(() => {
      appendRendererOptimisticTurnStartedEvent(MID_TURN_ID);
      useSessionStore.setState({ activeTurnId: MID_TURN_ID, sessionSummaries: [] });
    });
    const m = mount(<ProfileTable {...defaults({ profiles: [profile] })} />);
    mounted.push(m);

    const council = getMembershipChip(m.container, 'managed-mid-turn', 'council');
    expect(council.getAttribute('aria-disabled')).toBe('true');
    act(() => {
      council.focus();
    });
    const tooltipText = document.body.querySelector('[role="tooltip"]')?.textContent;
    expect(tooltipText).toContain('Managed by your company. Contact your admin to change.');
    expect(tooltipText).not.toContain('Edits apply to your next turn.');
  });

  it('prefers company-managed tooltip when managed, disabled, mid-turn, and orphaned-provider conditions all apply', () => {
    const profile = makeProfile({
      id: 'all-disabled-reasons',
      companyManaged: true,
      enabled: false,
      providerType: 'other',
      customProviderId: 'missing-provider',
    });
    act(() => {
      appendRendererOptimisticTurnStartedEvent(MID_TURN_ID);
      useSessionStore.setState({ activeTurnId: MID_TURN_ID, sessionSummaries: [] });
    });
    const m = mount(<ProfileTable {...defaults({ profiles: [profile], customProviders: [] })} />);
    mounted.push(m);

    const council = getMembershipChip(m.container, 'all-disabled-reasons', 'council');
    expect(council.getAttribute('aria-disabled')).toBe('true');
    act(() => {
      council.focus();
    });
    const tooltipText = document.body.querySelector('[role="tooltip"]')?.textContent;
    expect(tooltipText).toContain('Managed by your company. Contact your admin to change.');
    expect(tooltipText).not.toContain('Enable this profile first.');
    expect(tooltipText).not.toContain('Edits apply to your next turn.');
    expect(tooltipText).not.toContain('Fix this profile’s provider first.');
  });

  it('prefers profile-disabled tooltip over the mid-turn tooltip', () => {
    const profile = makeProfile({ id: 'disabled-mid-turn', enabled: false });
    act(() => {
      appendRendererOptimisticTurnStartedEvent(MID_TURN_ID);
      useSessionStore.setState({ activeTurnId: MID_TURN_ID, sessionSummaries: [] });
    });
    const m = mount(<ProfileTable {...defaults({ profiles: [profile] })} />);
    mounted.push(m);

    const smartPicking = getMembershipChip(m.container, 'disabled-mid-turn', 'smart-picking');
    expect(smartPicking.getAttribute('aria-disabled')).toBe('true');
    act(() => {
      smartPicking.focus();
    });
    const tooltipText = document.body.querySelector('[role="tooltip"]')?.textContent;
    expect(tooltipText).toContain('Enable this profile first.');
    expect(tooltipText).not.toContain('Edits apply to your next turn.');
  });

  it('supports keyboard focus and Enter/Space toggles for membership chips', () => {
    const onProfilesChange = vi.fn();
    const profile = makeProfile({ id: 'keyboard-membership' });
    const m = mount(
      <ProfileTable {...defaults({ profiles: [profile], onProfilesChange })} />,
    );
    mounted.push(m);

    const council = getMembershipChip(m.container, 'keyboard-membership', 'council');
    const smartPicking = getMembershipChip(m.container, 'keyboard-membership', 'smart-picking');

    act(() => {
      council.focus();
    });
    expect(document.activeElement).toBe(council);
    keyDown(council, 'Enter');
    expect(onProfilesChange.mock.calls[0]?.[0]).toEqual([
      expect.objectContaining({ id: 'keyboard-membership', councilEnabled: true }),
    ]);

    act(() => {
      smartPicking.focus();
    });
    expect(document.activeElement).toBe(smartPicking);
    keyDown(smartPicking, ' ');
    expect(onProfilesChange.mock.calls[1]?.[0]).toEqual([
      expect.objectContaining({ id: 'keyboard-membership', routingEligible: true }),
    ]);
  });

  it('dims the row when enabled is false (className + aria-disabled)', () => {
    const profile = makeProfile({ id: 'disabled-1', enabled: false });
    const m = mount(<ProfileTable {...defaults({ profiles: [profile] })} />);
    mounted.push(m);
    const row = m.container.querySelector<HTMLTableRowElement>(
      '[data-testid="settings-models-profile-row"]',
    );
    expect(row?.getAttribute('aria-disabled')).toBe('true');
    expect(row?.className).toMatch(/disabled/);
  });

  it('fires onTest when the Test button is clicked for a normal profile', () => {
    const profile = makeProfile({ id: 'p-test' });
    const m = mount(<ProfileTable {...defaults({ profiles: [profile] })} />);
    mounted.push(m);

    const testButton = m.container.querySelector<HTMLButtonElement>(
      '[data-testid="settings-models-profile-test-p-test"]',
    );
    act(() => {
      testButton?.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    });
    expect(BASE_HANDLERS.onTest).toHaveBeenCalledTimes(1);
    expect(BASE_HANDLERS.onTest.mock.calls[0]?.[0]).toMatchObject({ id: 'p-test' });
  });

  it('auto-highlights when justAddedId matches and clears via onHighlightDone after 1.2s', () => {
    const profile = makeProfile({ id: 'new-row' });
    const m = mount(
      <ProfileTable {...defaults({ profiles: [profile], justAddedId: 'new-row' })} />,
    );
    mounted.push(m);

    const row = m.container.querySelector<HTMLTableRowElement>(
      '[data-testid="settings-models-profile-row"]',
    );
    expect(row?.className).toMatch(/justAdded/);
    expect(BASE_HANDLERS.onHighlightDone).not.toHaveBeenCalled();

    act(() => {
      vi.advanceTimersByTime(1200);
    });
    expect(BASE_HANDLERS.onHighlightDone).toHaveBeenCalledTimes(1);
  });

  it('shows "Provider removed" and disables Test for orphaned customProviderId', () => {
    const profile = makeProfile({
      id: 'orphaned-1',
      providerType: 'other',
      customProviderId: 'cp-missing',
    });
    const customProviders: CustomProvider[] = [];
    const m = mount(
      <ProfileTable
        {...defaults({ profiles: [profile], customProviders })}
      />,
    );
    mounted.push(m);

    expect(m.container.textContent).toContain('Provider removed');
    // The test "button" for orphaned profiles is now a focusable span wrapper
    // around a disabled button (so the tooltip can fire on hover/focus).
    const testWrapper = m.container.querySelector<HTMLElement>(
      '[data-testid="settings-models-profile-test-orphaned-1"]',
    );
    expect(testWrapper).not.toBeNull();
    expect(testWrapper?.getAttribute('aria-disabled')).toBe('true');
    const innerButton = testWrapper?.querySelector('button');
    expect((innerButton as HTMLButtonElement | null)?.disabled).toBe(true);
  });

  it('requires two clicks to delete: first click surfaces confirm, second triggers onConfirmDelete', () => {
    const profile = makeProfile({ id: 'dangerous' });
    const ui = (deleteConfirmId: string | null) => (
      <ProfileTable
        {...defaults({
          profiles: [profile],
          deleteConfirmId,
        })}
      />
    );
    const m = mount(ui(null));
    mounted.push(m);

    let deleteButton = m.container.querySelector<HTMLButtonElement>(
      '[data-testid="settings-models-profile-delete-dangerous"]',
    );
    act(() => {
      deleteButton?.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    });
    expect(BASE_HANDLERS.onRequestDelete).toHaveBeenCalledTimes(1);
    expect(BASE_HANDLERS.onRequestDelete).toHaveBeenLastCalledWith('dangerous');
    expect(BASE_HANDLERS.onConfirmDelete).not.toHaveBeenCalled();

    // Parent sets deleteConfirmId to the row's id; re-render shows confirm variant.
    m.render(ui('dangerous'));
    deleteButton = m.container.querySelector<HTMLButtonElement>(
      '[data-testid="settings-models-profile-delete-dangerous"]',
    );
    expect(deleteButton?.textContent?.toLowerCase()).toContain('delete');
    act(() => {
      deleteButton?.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    });
    expect(BASE_HANDLERS.onConfirmDelete).toHaveBeenCalledTimes(1);
    expect(BASE_HANDLERS.onConfirmDelete).toHaveBeenLastCalledWith('dangerous');
  });

  it('toggles enabled state via the enable checkbox', () => {
    const profile = makeProfile({ id: 'p-toggle' });
    const m = mount(<ProfileTable {...defaults({ profiles: [profile] })} />);
    mounted.push(m);

    const checkbox = m.container.querySelector<HTMLInputElement>(
      '[data-testid="settings-models-profile-enabled-p-toggle"]',
    );
    act(() => {
      // Simulate real toggle: React fires onChange when the checked prop flips.
      checkbox?.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    });
    expect(BASE_HANDLERS.onToggleEnabled).toHaveBeenCalledTimes(1);
    expect(BASE_HANDLERS.onToggleEnabled).toHaveBeenCalledWith('p-toggle');
  });

  it('surfaces an in-flight test spinner in the status cell', () => {
    const profile = makeProfile({ id: 'p-running' });
    const testState: Record<string, TestStateEntry> = {
      'p-running': { testing: true },
    };
    const m = mount(
      <ProfileTable {...defaults({ profiles: [profile], testState })} />,
    );
    mounted.push(m);
    expect(m.container.textContent).toContain('Testing');
  });

  it('offers model research after a successful test for a model lacking routing notes', () => {
    // An unknown custom model id (no catalog default, no per-profile notes) is
    // the legitimate target for the "Research this model" affordance.
    const profile = makeProfile({ id: 'p-enrich', name: 'GPT Researcher', model: 'my-local-model' });
    const testState: Record<string, TestStateEntry> = {
      'p-enrich': {
        testing: false,
        result: { success: true, latencyMs: 123 },
      },
    };
    const received: unknown[] = [];
    const handler = (event: Event) => {
      received.push((event as CustomEvent).detail);
    };
    window.addEventListener('rebel:start-model-profile-enrichment', handler);

    const m = mount(
      <ProfileTable {...defaults({ profiles: [profile], testState })} />,
    );
    mounted.push(m);

    const enrichButton = m.container.querySelector<HTMLButtonElement>(
      '[data-testid="settings-models-profile-enrich-p-enrich"]',
    );
    expect(enrichButton?.textContent).toContain('Research this model');
    expect(enrichButton?.getAttribute('title')).toBe(
      'Looks up what this model is good at, so Rebel knows when to use it.',
    );

    act(() => {
      enrichButton?.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    });

    expect(received).toEqual([
      expect.objectContaining({
        profileId: 'p-enrich',
        profileName: 'GPT Researcher',
        prompt: expect.stringContaining('Use profile ID "p-enrich".'),
      }),
    ]);
    expect((received[0] as { prompt?: string }).prompt).toContain(
      'Research the model "GPT Researcher" (my-local-model)',
    );

    window.removeEventListener('rebel:start-model-profile-enrichment', handler);
  });

  it('hides the research button for a catalog model that already ships routing notes', () => {
    // gpt-5.5 has a MODEL_CAPABILITY_DEFAULTS entry, so the planner already has
    // routing guidance — no need to nag the user to research it.
    const profile = makeProfile({ id: 'p-catalog', name: 'OpenAI / GPT-5.5', model: 'gpt-5.5' });
    const testState: Record<string, TestStateEntry> = {
      'p-catalog': {
        testing: false,
        result: { success: true, latencyMs: 123 },
      },
    };
    const m = mount(
      <ProfileTable {...defaults({ profiles: [profile], testState })} />,
    );
    mounted.push(m);

    expect(
      m.container.querySelector('[data-testid="settings-models-profile-enrich-p-catalog"]'),
    ).toBeNull();
  });

  it('hides the research button for a direct OpenAI o-series profile (bare-key fix)', () => {
    // A direct OpenAI o3 profile carries the BARE model id `o3`. Before the
    // bare-key fix, MODEL_CAPABILITY_DEFAULTS keyed it as `openai/o3`, so
    // getModelCapabilityDefaults('o3') returned undefined → the button nagged.
    // Now the bare `o3` entry resolves, so the button hides like any catalog model.
    const profile = makeProfile({ id: 'p-o3', name: 'OpenAI / o3', model: 'o3' });
    const testState: Record<string, TestStateEntry> = {
      'p-o3': {
        testing: false,
        result: { success: true, latencyMs: 123 },
      },
    };
    const m = mount(
      <ProfileTable {...defaults({ profiles: [profile], testState })} />,
    );
    mounted.push(m);

    expect(
      m.container.querySelector('[data-testid="settings-models-profile-enrich-p-o3"]'),
    ).toBeNull();
  });

  it('hides the research button when the profile already has its own routing notes', () => {
    const profile = makeProfile({
      id: 'p-noted',
      name: 'Custom endpoint',
      model: 'my-local-model',
      modelNotes: 'Fast local model; good for drafting.',
    });
    const testState: Record<string, TestStateEntry> = {
      'p-noted': {
        testing: false,
        result: { success: true, latencyMs: 123 },
      },
    };
    const m = mount(
      <ProfileTable {...defaults({ profiles: [profile], testState })} />,
    );
    mounted.push(m);

    expect(
      m.container.querySelector('[data-testid="settings-models-profile-enrich-p-noted"]'),
    ).toBeNull();
  });

  it('renders a functional enable toggle for company-managed rows that fires onToggleEnabled', () => {
    // DECIDED (PLAN.md): company-managed profiles keep a functional enable/disable toggle.
    // Only edit/delete are gated on !companyManaged; the toggle is ungated by design.
    const profile = makeProfile({ id: 'cm-toggle', companyManaged: true });
    const m = mount(<ProfileTable {...defaults({ profiles: [profile] })} />);
    mounted.push(m);

    const toggle = m.container.querySelector<HTMLInputElement>(
      '[data-testid="settings-models-profile-enabled-cm-toggle"]',
    );
    expect(toggle).not.toBeNull();
    expect(toggle?.tagName.toLowerCase()).toBe('input');
    expect(toggle?.type).toBe('checkbox');

    act(() => {
      toggle?.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    });
    expect(BASE_HANDLERS.onToggleEnabled).toHaveBeenCalledTimes(1);
    expect(BASE_HANDLERS.onToggleEnabled).toHaveBeenCalledWith('cm-toggle');
  });
});
