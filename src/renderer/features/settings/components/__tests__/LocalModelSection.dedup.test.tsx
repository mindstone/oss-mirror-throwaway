// @vitest-environment happy-dom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { PROVIDER_CATALOGS } from '@shared/data/providerCatalogs';
import { materializeCatalogProfile } from '@shared/utils/catalogMaterialization';
import type { ModelProfile } from '@shared/types';
import { LocalModelSection, resolveWizardSaveProfiles } from '../LocalModelSection';

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

function makeProfile(overrides: Partial<ModelProfile>): ModelProfile {
  return {
    id: 'profile-1',
    name: 'Custom model',
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

describe('LocalModelSection — provider catalog dedup and gates', () => {
  const mounted: Mounted[] = [];

  afterEach(() => {
    for (const instance of mounted) instance.unmount();
    mounted.length = 0;
    document.body.innerHTML = '';
    vi.restoreAllMocks();
  });

  it('renders the locked empty state when no provider or custom profile is available', () => {
    const view = mount(
      <LocalModelSection
        profiles={[]}
        onProfilesChange={() => {}}
        providerKeys={{}}
        settings={{ models: { apiKey: null } }}
      />,
    );
    mounted.push(view);

    expect(view.container.textContent).toContain(
      'No models yet. Connect a provider above to get started.',
    );
  });

  it('keeps direct OpenAI API profiles separate from ChatGPT Pro subscription catalog rows', () => {
    const codexModel = PROVIDER_CATALOGS.openai[0]!;
    const view = mount(
      <LocalModelSection
        profiles={[
          makeProfile({
            id: 'direct-openai',
            name: 'Direct OpenAI API',
            providerType: 'openai',
            routeSurface: 'api-key',
            model: codexModel.model,
          }),
        ]}
        onProfilesChange={() => {}}
        providerKeys={{}}
        settings={{ models: { apiKey: null } }}
        codexConnected
      />,
    );
    mounted.push(view);

    expect(view.container.textContent).toContain('ChatGPT Pro');
    const codexToggle = view.container.querySelector<HTMLButtonElement>(
      '[data-testid="settings-models-catalog-chatgpt-pro-toggle"]',
    );
    act(() => {
      codexToggle?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    });
    expect(
      view.container.querySelector(`[data-testid="settings-models-catalog-row-${codexModel.model}"]`),
    ).not.toBeNull();
    expect(view.container.textContent).toContain('Direct OpenAI API');
  });

  it('suppresses an Anthropic catalog row when a disabled user profile owns the same key', () => {
    const anthropicModel = PROVIDER_CATALOGS.anthropic[0]!;
    const view = mount(
      <LocalModelSection
        profiles={[
          makeProfile({
            id: 'disabled-claude',
            name: 'My Claude',
            providerType: 'anthropic',
            routeSurface: 'api-key',
            model: anthropicModel.model,
            enabled: false,
          }),
        ]}
        onProfilesChange={() => {}}
        providerKeys={{}}
        settings={{ models: { apiKey: 'fake-ant-test' } }}
      />,
    );
    mounted.push(view);

    expect(view.container.textContent).toContain('Available');
    expect(view.container.textContent).toContain('My Claude');
    expect(
      view.container.querySelector(`[data-testid="settings-models-catalog-row-${anthropicModel.model}"]`),
    ).toBeNull();
  });

  it('does not render Anthropic catalog rows when only OpenRouter is connected', () => {
    const anthropicModel = PROVIDER_CATALOGS.anthropic[0]!;
    const openRouterModel = PROVIDER_CATALOGS.openrouter[0]!;
    const view = mount(
      <LocalModelSection
        profiles={[]}
        onProfilesChange={() => {}}
        providerKeys={{}}
        settings={{ models: { apiKey: null } }}
        openRouterConnected
      />,
    );
    mounted.push(view);

    expect(view.container.textContent).toContain('OpenRouter');
    expect(view.container.textContent).toContain('Credits');
    const openRouterToggle = view.container.querySelector<HTMLButtonElement>(
      '[data-testid="settings-models-catalog-openrouter-toggle"]',
    );
    act(() => {
      openRouterToggle?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    });
    expect(
      view.container.querySelector(`[data-testid="settings-models-catalog-row-${openRouterModel.model}"]`),
    ).not.toBeNull();
    expect(
      view.container.querySelector(`[data-testid="settings-models-catalog-row-${anthropicModel.model}"]`),
    ).toBeNull();
  });

  it('keeps broken auth sections visible with a reconnect CTA and hides curated rows', () => {
    const codexModel = PROVIDER_CATALOGS.openai[0]!;
    const onReconnect = vi.fn();
    const view = mount(
      <LocalModelSection
        profiles={[]}
        onProfilesChange={() => {}}
        providerKeys={{}}
        settings={{ models: { apiKey: null } }}
        codexNeedsReconnect
        onReconnectCodex={onReconnect}
      />,
    );
    mounted.push(view);

    expect(view.container.textContent).toContain('Not ready: reconnect ChatGPT Pro');
    expect(
      view.container.querySelector(`[data-testid="settings-models-catalog-row-${codexModel.model}"]`),
    ).toBeNull();
    const button = view.container.querySelector<HTMLButtonElement>(
      '[data-testid="settings-models-reconnect-chatgpt-pro"]',
    );
    expect(button).not.toBeNull();
    act(() => {
      button?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(onReconnect).toHaveBeenCalledTimes(1);
  });

  it('treats connection-profile duplicates as idempotent at the save boundary', () => {
    const entry = PROVIDER_CATALOGS.openai[0]!;
    const existing = materializeCatalogProfile(entry, { id: 'existing-connection' });
    const duplicate = materializeCatalogProfile(entry, { id: 'duplicate-connection' });

    const resolution = resolveWizardSaveProfiles(duplicate, 'add', [existing]);

    expect(resolution.profiles).toEqual([existing]);
    expect(resolution.justAddedId).toBe(existing.id);
  });
});
