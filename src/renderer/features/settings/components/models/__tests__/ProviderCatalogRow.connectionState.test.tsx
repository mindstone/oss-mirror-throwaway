// @vitest-environment happy-dom
import React, { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CatalogEntry } from '@shared/data/providerCatalogs';
import type { ModelProfile } from '@shared/types';
import { CODEX_WORKING_PROFILE_ID } from '@shared/utils/codexDefaults';
import { CatalogProviderGroup } from '../CatalogProviderGroup';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

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

function fireClick(el: Element | null) {
  act(() => {
    el?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
  });
}

const catalogEntry: CatalogEntry = {
  providerType: 'openai',
  routeSurface: 'subscription',
  model: 'gpt-5.5',
  label: 'GPT-5.5',
  isMainModel: true,
  isAuxiliaryModel: false,
  reasoning: true,
};

function makeProfile(overrides: Partial<ModelProfile> = {}): ModelProfile {
  return {
    id: overrides.id ?? 'profile-1',
    name: overrides.name ?? 'GPT-5.5',
    providerType: overrides.providerType ?? 'openai',
    routeSurface: overrides.routeSurface ?? 'subscription',
    serverUrl: 'https://api.openai.com/v1',
    model: overrides.model ?? 'gpt-5.5',
    enabled: true,
    createdAt: 1,
    ...overrides,
  };
}

function renderCatalog(
  existingProfiles: readonly ModelProfile[] = [],
  onRemoveFromTeam: (profile: ModelProfile) => void = () => {},
  overrides: Partial<React.ComponentProps<typeof CatalogProviderGroup>> = {},
) {
  return (
    <CatalogProviderGroup
      title="ChatGPT Pro"
      providerName="ChatGPT Pro"
      entries={[catalogEntry]}
      billingSource="subscription"
      defaultExpanded
      existingProfiles={existingProfiles}
      onRemoveFromTeam={onRemoveFromTeam}
      onModelEffortChange={() => {}}
      {...overrides}
    />
  );
}

describe('ProviderCatalogRow connection state', () => {
  let mounted: Mounted | null = null;

  afterEach(() => {
    mounted?.unmount();
    mounted = null;
    document.body.innerHTML = '';
    vi.restoreAllMocks();
  });

  it('renders no On your team chip when no connection-managed profile matches', () => {
    mounted = mount(renderCatalog());

    expect(mounted.container.textContent).not.toContain('On your team');
    expect(
      mounted.container.querySelector('[data-testid="settings-models-catalog-remove-gpt-5.5"]'),
    ).toBeNull();
  });

  it('renders On your team and Remove for a matching connection-managed profile', () => {
    mounted = mount(renderCatalog([makeProfile({ profileSource: 'connection' })]));

    expect(mounted.container.textContent).toContain('On your team');
    expect(mounted.container.textContent).toContain('Remove');
  });

  it('keeps a disconnected provider row visible when a matching managed profile exists', () => {
    mounted = mount(renderCatalog(
      [makeProfile({ profileSource: 'connection' })],
      () => {},
      { reconnectRequired: true, onReconnect: () => {} },
    ));

    expect(
      mounted.container.querySelector('[data-testid="settings-models-catalog-row-gpt-5.5"]'),
    ).not.toBeNull();
    expect(mounted.container.textContent).toContain('On your team');
    expect(mounted.container.textContent).toContain('Remove');
    expect(mounted.container.textContent).toContain('Reconnect ChatGPT Pro to use');
  });

  it('hides a disconnected provider row when no managed profile matches', () => {
    mounted = mount(renderCatalog(
      [],
      () => {},
      { reconnectRequired: true, onReconnect: () => {} },
    ));

    expect(mounted.container.textContent).toContain('Not ready: reconnect ChatGPT Pro');
    expect(
      mounted.container.querySelector('[data-testid="settings-models-catalog-row-gpt-5.5"]'),
    ).toBeNull();
    expect(mounted.container.textContent).not.toContain('On your team');
  });

  it('marks matching Codex auto-profiles as On your team', () => {
    mounted = mount(renderCatalog([
      makeProfile({
        id: CODEX_WORKING_PROFILE_ID,
        profileSource: 'auto',
        authSource: 'codex-subscription',
      }),
    ]));

    expect(mounted.container.textContent).toContain('On your team');
    expect(mounted.container.textContent).toContain('Remove');
  });

  it('removes the matching connection-managed profile and returns the row to plain state', () => {
    function Harness() {
      const [profiles, setProfiles] = useState<ModelProfile[]>([
        makeProfile({ profileSource: 'connection' }),
      ]);
      return renderCatalog(profiles, (profile) => {
        setProfiles((current) => current.filter((candidate) => candidate.id !== profile.id));
      });
    }

    mounted = mount(<Harness />);

    expect(mounted.container.textContent).toContain('On your team');
    fireClick(
      mounted.container.querySelector('[data-testid="settings-models-catalog-remove-gpt-5.5"]'),
    );

    expect(mounted.container.textContent).not.toContain('On your team');
    expect(mounted.container.textContent).not.toContain('Remove');
  });

  it('does not mark a matching user-added profile as On your team', () => {
    mounted = mount(renderCatalog([makeProfile({ profileSource: 'user' })]));

    expect(mounted.container.textContent).not.toContain('On your team');
    expect(
      mounted.container.querySelector('[data-testid="settings-models-catalog-remove-gpt-5.5"]'),
    ).toBeNull();
  });
});
