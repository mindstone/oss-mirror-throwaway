// @vitest-environment happy-dom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { LocalModelSection } from '../LocalModelSection';
import type { ModelProfile } from '@shared/types';
import { createProfileConnectivity } from '@shared/utils/connectivityHelpers';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

interface Mounted {
  container: HTMLDivElement;
  root: Root;
  unmount: () => void;
  render: (ui: React.ReactElement) => void;
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
    render: (next) => {
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
    enabled: true,
    ...overrides,
  };
}

describe('LocalModelSection — Active / Available / Needs setup IA', () => {
  let mounted: Mounted[] = [];

  beforeEach(() => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    for (const instance of mounted) instance.unmount();
    mounted = [];
    document.body.innerHTML = '';
    vi.restoreAllMocks();
  });

  function renderWith(
    profiles: ModelProfile[],
    props: Partial<Omit<React.ComponentProps<typeof LocalModelSection>, 'profiles' | 'onProfilesChange'>> = {},
  ): Mounted {
    const onChange = vi.fn();
    const m = mount(
      <LocalModelSection
        profiles={profiles}
        onProfilesChange={onChange}
        providerKeys={{}}
        customProviders={[]}
        {...props}
      />,
    );
    mounted.push(m);
    return m;
  }

  it('renders the "Added by you" heading instead of "Your Models"', () => {
    const m = renderWith([makeProfile({ id: 'a' })]);

    expect(m.container.textContent).toContain('Added by you');
    expect(m.container.textContent).not.toContain('Your Models');
  });

  it('renders "Included with your connections" disclosure as collapsed by default', () => {
    const m = renderWith([makeProfile({ id: 'a' })], {
      codexConnected: true,
      openRouterConnected: true,
      providerKeys: { google: 'fake-google-key' },
      settings: { models: { apiKey: 'fake-ant-key' } },
    });

    const disclosure = m.container.querySelector<HTMLElement>(
      '[data-section="connectionCatalog"]',
    );
    expect(disclosure).not.toBeNull();
    const toggle = disclosure?.querySelector<HTMLButtonElement>('[data-advanced-toggle]');
    expect(toggle?.textContent).toContain('Included with your connections');
    expect(toggle?.getAttribute('aria-expanded')).toBe('false');
    const content = disclosure?.querySelector<HTMLElement>('[data-advanced-content]');
    expect(content?.style.display).toBe('none');
  });

  it('expands "Included with your connections" disclosure when its toggle is clicked, revealing the catalog accordions', () => {
    const m = renderWith([makeProfile({ id: 'a' })], {
      codexConnected: true,
      openRouterConnected: true,
      providerKeys: { google: 'fake-google-key' },
      settings: { models: { apiKey: 'fake-ant-key' } },
    });

    const disclosure = m.container.querySelector<HTMLElement>(
      '[data-section="connectionCatalog"]',
    );
    const toggle = disclosure?.querySelector<HTMLButtonElement>('[data-advanced-toggle]');
    const content = disclosure?.querySelector<HTMLElement>('[data-advanced-content]');

    act(() => {
      toggle?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    });

    expect(toggle?.getAttribute('aria-expanded')).toBe('true');
    expect(content?.style.display).not.toBe('none');
    const catalogToggles = Array.from(
      disclosure?.querySelectorAll<HTMLElement>(
        '[data-testid^="settings-models-catalog-"][data-testid$="-toggle"]',
      ) ?? [],
    ).map((node) => node.getAttribute('data-testid'));
    expect(catalogToggles).toEqual([
      'settings-models-catalog-chatgpt-pro-toggle',
      'settings-models-catalog-openrouter-toggle',
      'settings-models-catalog-anthropic-toggle',
      'settings-models-catalog-gemini-toggle',
    ]);
  });

  it('exposes per-provider catalog data-section ids so search/deep-links can target a specific catalog and trigger the disclosure auto-expand', () => {
    const m = renderWith([makeProfile({ id: 'a' })], {
      codexConnected: true,
      openRouterConnected: true,
      providerKeys: { google: 'fake-google-key' },
      settings: { models: { apiKey: 'fake-ant-key' } },
    });

    const codexCatalog = m.container.querySelector('[data-section="codexCatalog"]');
    const openRouterCatalog = m.container.querySelector('[data-section="openrouterCatalog"]');
    const anthropicCatalog = m.container.querySelector('[data-section="anthropicCatalog"]');
    const geminiCatalog = m.container.querySelector('[data-section="geminiCatalog"]');
    expect(codexCatalog).not.toBeNull();
    expect(openRouterCatalog).not.toBeNull();
    expect(anthropicCatalog).not.toBeNull();
    expect(geminiCatalog).not.toBeNull();

    // Each per-provider catalog must live INSIDE the connectionCatalog
    // disclosure so useScrollToSection's [data-advanced-section] walk
    // hits the disclosure toggle and expands it before scrolling.
    const disclosure = m.container.querySelector('[data-section="connectionCatalog"]');
    expect(disclosure?.contains(codexCatalog)).toBe(true);
    expect(disclosure?.contains(openRouterCatalog)).toBe(true);
    expect(disclosure?.contains(anthropicCatalog)).toBe(true);
    expect(disclosure?.contains(geminiCatalog)).toBe(true);
  });

  it('renders BillingSourceLegend inside LocalModelSection', () => {
    const m = renderWith([makeProfile({ id: 'a' })]);

    const legends = m.container.querySelectorAll('[aria-label="Billing source legend"]');
    expect(legends.length).toBe(1);
    const legend = legends[0] as HTMLElement;
    const title = m.container.querySelector<HTMLElement>(
      '[data-testid="settings-models-section-title-user-added"]',
    );
    expect(title).not.toBeNull();
    expect(
      legend.compareDocumentPosition(title as HTMLElement)
        & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it('renders only the Active section when all profiles are enabled and configured', () => {
    const profiles = [
      makeProfile({ id: 'a' }),
      makeProfile({ id: 'b', model: 'gpt-5.4-mini' }),
    ];
    const m = renderWith(profiles);
    expect(
      m.container.querySelector('[data-testid="settings-models-section-active"]'),
    ).not.toBeNull();
    expect(
      m.container.querySelector('[data-testid="settings-models-section-available"]'),
    ).toBeNull();
    expect(
      m.container.querySelector('[data-testid="settings-models-section-needs-setup"]'),
    ).toBeNull();
  });

  it('puts disabled-but-configured profiles into the Available section', () => {
    const profiles = [
      makeProfile({ id: 'a' }),
      makeProfile({ id: 'b', enabled: false }),
    ];
    const m = renderWith(profiles);
    expect(
      m.container.querySelector('[data-testid="settings-models-section-active"]'),
    ).not.toBeNull();
    expect(
      m.container.querySelector('[data-testid="settings-models-section-available"]'),
    ).not.toBeNull();
  });

  it('puts auto:* profiles without serverUrl into the Needs setup section', () => {
    const profiles = [
      makeProfile({ id: 'a' }),
      makeProfile({
        id: 'auto:gpt-future',
        providerType: 'other',
        serverUrl: '',
        apiKey: undefined,
        model: 'gpt-future',
        enabled: false,
        contextWindow: 200_000,
        contextWindowSource: 'auto',
        lastLearnedContextWindow: 200_000,
        contextWindowLearnedAt: 1_700_000_500_000,
      }),
    ];
    const m = renderWith(profiles);
    expect(
      m.container.querySelector('[data-testid="settings-models-section-needs-setup"]'),
    ).not.toBeNull();
    expect(
      m.container.querySelector('[data-testid="settings-models-needs-setup-row-auto:gpt-future"]'),
    ).not.toBeNull();
  });

  it('hides the Needs setup section when there are no needs-setup profiles', () => {
    const profiles = [makeProfile({ id: 'a' })];
    const m = renderWith(profiles);
    expect(
      m.container.querySelector('[data-testid="settings-models-section-needs-setup"]'),
    ).toBeNull();
  });

  it('caps Needs setup at 5 rows by default and reveals all on Show all', () => {
    const profiles: ModelProfile[] = [];
    profiles.push(makeProfile({ id: 'active' }));
    for (let i = 0; i < 7; i += 1) {
      profiles.push(
        makeProfile({
          id: `auto:m-${i}`,
          providerType: 'other',
          serverUrl: '',
          apiKey: undefined,
          model: `m-${i}`,
          enabled: false,
          contextWindowLearnedAt: 1_700_000_000_000 + i * 1_000,
        }),
      );
    }
    const m = renderWith(profiles);
    const list = m.container.querySelector(
      '[data-testid="settings-models-needs-setup-list"]',
    );
    expect(list).not.toBeNull();
    expect(list?.children.length).toBe(5);
    const showAllButton = m.container.querySelector<HTMLButtonElement>(
      '[data-testid="settings-models-needs-setup-show-all"]',
    );
    expect(showAllButton).not.toBeNull();
    expect(showAllButton?.textContent).toContain('Show all (7)');
    act(() => {
      showAllButton?.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    });
    const expandedList = m.container.querySelector(
      '[data-testid="settings-models-needs-setup-list"]',
    );
    expect(expandedList?.children.length).toBe(7);
  });

  it('sorts Needs setup by contextWindowLearnedAt descending', () => {
    const profiles: ModelProfile[] = [
      makeProfile({
        id: 'auto:old',
        providerType: 'other',
        serverUrl: '',
        apiKey: undefined,
        model: 'old',
        enabled: false,
        contextWindowLearnedAt: 1_700_000_000_000,
      }),
      makeProfile({
        id: 'auto:new',
        providerType: 'other',
        serverUrl: '',
        apiKey: undefined,
        model: 'new',
        enabled: false,
        contextWindowLearnedAt: 1_800_000_000_000,
      }),
    ];
    const m = renderWith(profiles);
    const list = m.container.querySelector(
      '[data-testid="settings-models-needs-setup-list"]',
    );
    const rows = Array.from(list?.children ?? []) as HTMLElement[];
    expect(rows[0]?.getAttribute('data-testid')).toBe(
      'settings-models-needs-setup-row-auto:new',
    );
    expect(rows[1]?.getAttribute('data-testid')).toBe(
      'settings-models-needs-setup-row-auto:old',
    );
  });

  it('renders connection-managed profiles in a separate From your connections bucket grouped by provider', () => {
    const profiles: ModelProfile[] = [
      makeProfile({
        id: 'user-openai',
        name: 'User OpenAI profile',
        profileSource: 'user',
      }),
      makeProfile({
        id: 'connection-codex',
        name: 'GPT-5.5 from ChatGPT Pro',
        profileSource: 'connection',
        routeSurface: 'subscription',
        authSource: 'codex-subscription',
      }),
      makeProfile({
        id: 'connection-anthropic',
        name: 'Claude from Anthropic',
        profileSource: 'connection',
        providerType: 'anthropic',
        routeSurface: 'api-key',
        serverUrl: 'https://api.anthropic.com/v1',
        model: 'claude-sonnet-4-6',
      }),
    ];

    const m = renderWith(profiles);
    const bucket = m.container.querySelector<HTMLElement>(
      '[data-testid="settings-models-section-connections"]',
    );
    const userAddedSection = m.container.querySelector<HTMLElement>(
      '[data-testid="settings-models-section-user-added"]',
    );

    expect(bucket).not.toBeNull();
    expect(userAddedSection).not.toBeNull();
    expect(bucket?.textContent).toContain('From your connections');
    expect(bucket?.textContent).toContain('From ChatGPT Pro');
    expect(bucket?.textContent).toContain('From Anthropic');
    expect(bucket?.querySelector('[data-profile-id="connection-codex"]')).not.toBeNull();
    expect(bucket?.querySelector('[data-profile-id="connection-anthropic"]')).not.toBeNull();
    expect(bucket?.querySelector('[data-profile-id="user-openai"]')).toBeNull();
    expect(userAddedSection?.contains(bucket)).toBe(false);
    expect(bucket?.contains(userAddedSection)).toBe(false);
    expect(bucket?.parentElement).toBe(userAddedSection?.parentElement);
  });

  it('keeps connection-managed profiles out of the Added by you Active bucket', () => {
    const profiles: ModelProfile[] = [
      makeProfile({
        id: 'user-active',
        name: 'User active profile',
        profileSource: 'user',
      }),
      makeProfile({
        id: 'connection-active',
        name: 'Connection active profile',
        profileSource: 'connection',
        routeSurface: 'subscription',
        authSource: 'codex-subscription',
      }),
    ];

    const m = renderWith(profiles);
    const activeSection = m.container.querySelector<HTMLElement>(
      '[data-testid="settings-models-section-active"]',
    );
    const connectionSection = m.container.querySelector<HTMLElement>(
      '[data-testid="settings-models-section-connections"]',
    );

    expect(activeSection?.querySelector('[data-profile-id="user-active"]')).not.toBeNull();
    expect(activeSection?.querySelector('[data-profile-id="connection-active"]')).toBeNull();
    expect(connectionSection?.querySelector('[data-profile-id="connection-active"]')).not.toBeNull();
  });

  it('hides the From your connections bucket when there are no connection-managed profiles', () => {
    const m = renderWith([
      makeProfile({ id: 'legacy-profile', profileSource: undefined }),
      makeProfile({ id: 'user-profile', profileSource: 'user' }),
    ]);

    expect(
      m.container.querySelector('[data-testid="settings-models-section-connections"]'),
    ).toBeNull();
  });

  // Regression guard: this fixture is already in post-migration shape.
  it('shows OpenRouter pool profiles stamped as connection-managed under From your connections', () => {
    const m = renderWith([
      makeProfile({
        id: 'or-connection-profile',
        providerType: 'openrouter',
        routeSurface: 'pool',
        profileSource: 'connection',
        apiKey: undefined,
      }),
    ]);

    const bucket = m.container.querySelector<HTMLElement>(
      '[data-testid="settings-models-section-connections"]',
    );
    expect(bucket).not.toBeNull();
    expect(bucket?.querySelector('[data-profile-id="or-connection-profile"]')).not.toBeNull();
  });

  it('keeps user-added profiles out of the From your connections bucket', () => {
    const m = renderWith([
      makeProfile({ id: 'user-profile', name: 'Definitely user-added' }),
      makeProfile({
        id: 'connection-profile',
        name: 'Definitely connection-managed',
        profileSource: 'connection',
        routeSurface: 'subscription',
        authSource: 'codex-subscription',
      }),
    ]);

    const bucket = m.container.querySelector<HTMLElement>(
      '[data-testid="settings-models-section-connections"]',
    );
    expect(bucket?.textContent).toContain('Definitely connection-managed');
    expect(bucket?.textContent).not.toContain('Definitely user-added');
  });

  it('marks disconnected connection-managed profiles as needing setup in the connections bucket', () => {
    const m = renderWith(
      [
        makeProfile({
          id: 'connection-openrouter',
          name: 'OpenRouter managed profile',
          providerType: 'openrouter',
          routeSurface: 'pool',
          profileSource: 'connection',
        }),
      ],
      {
        profileConnectivity: createProfileConnectivity({ openRouterConnected: false }),
      },
    );

    const bucket = m.container.querySelector<HTMLElement>(
      '[data-testid="settings-models-section-connections"]',
    );
    expect(bucket?.textContent).toContain('OpenRouter managed profile');
    expect(bucket?.textContent).toContain('Needs setup');
  });

});
