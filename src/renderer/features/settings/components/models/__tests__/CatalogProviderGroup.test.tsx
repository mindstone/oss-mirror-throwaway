// @vitest-environment happy-dom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CatalogEntry } from '@shared/data/providerCatalogs';
import { ProviderCatalogRow } from '../ProviderCatalogRow';
import { CatalogProviderGroup } from '../CatalogProviderGroup';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

interface Mounted {
  container: HTMLDivElement;
  render: (ui: React.ReactElement) => void;
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

function fireClick(el: Element) {
  act(() => {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
  });
}

const entries: readonly CatalogEntry[] = [
  {
    providerType: 'anthropic',
    routeSurface: 'api-key',
    model: 'claude-opus-4-7',
    label: 'Claude Opus 4.7',
    isMainModel: true,
    isAuxiliaryModel: false,
    reasoning: true,
  },
  {
    providerType: 'anthropic',
    routeSurface: 'api-key',
    model: 'claude-sonnet-4-6',
    label: 'Claude Sonnet 4.6',
    isMainModel: true,
    isAuxiliaryModel: false,
    reasoning: true,
  },
  {
    providerType: 'anthropic',
    routeSurface: 'api-key',
    model: 'claude-haiku-4-5',
    label: 'Claude Haiku 4.5',
    isMainModel: true,
    isAuxiliaryModel: false,
    reasoning: false,
  },
  {
    providerType: 'anthropic',
    routeSurface: 'api-key',
    model: 'claude-auxiliary',
    label: 'Claude Auxiliary',
    isMainModel: false,
    isAuxiliaryModel: true,
    reasoning: false,
  },
];

function renderGroup(overrides: Partial<React.ComponentProps<typeof CatalogProviderGroup>> = {}) {
  return (
    <CatalogProviderGroup
      title="Anthropic"
      providerName="Anthropic"
      entries={entries}
      billingSource="pay-per-use"
      onModelEffortChange={() => {}}
      {...overrides}
    />
  );
}

describe('CatalogProviderGroup', () => {
  const mounted: Mounted[] = [];

  afterEach(() => {
    for (const instance of mounted) instance.unmount();
    mounted.length = 0;
    document.body.innerHTML = '';
    vi.restoreAllMocks();
  });

  it('renders a collapsed summary with provider name, model count, and representative names', () => {
    const view = mount(renderGroup());
    mounted.push(view);

    expect(view.container.textContent).toContain('Anthropic');
    expect(view.container.textContent).toContain('4 models');
    expect(view.container.textContent).toContain('Claude Opus 4.7');
    expect(view.container.textContent).toContain('Claude Sonnet 4.6');
    expect(view.container.textContent).toContain('Claude Haiku 4.5');
    expect(
      view.container.querySelector('[data-testid="settings-models-catalog-row-claude-auxiliary"]'),
    ).toBeNull();
  });

  it('click expands to the full model list', () => {
    const view = mount(renderGroup());
    mounted.push(view);

    const toggle = view.container.querySelector<HTMLButtonElement>(
      '[data-testid="settings-models-catalog-anthropic-toggle"]',
    )!;
    fireClick(toggle);

    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(
      view.container.querySelector('[data-testid="settings-models-catalog-row-claude-auxiliary"]'),
    ).not.toBeNull();
  });

  it('reveals thinking effort controls only after Advanced tuning is opened', () => {
    const view = mount(renderGroup({ defaultExpanded: true }));
    mounted.push(view);

    expect(
      view.container.querySelector(
        '[data-testid="settings-models-catalog-effort-claude-opus-4-7-medium"]',
      ),
    ).toBeNull();
    expect(view.container.textContent).not.toContain('No reasoning');

    const advanced = view.container.querySelector<HTMLButtonElement>(
      '[data-testid="settings-models-catalog-anthropic-advanced-toggle"]',
    )!;
    fireClick(advanced);

    expect(
      view.container.querySelector(
        '[data-testid="settings-models-catalog-effort-claude-opus-4-7-medium"]',
      ),
    ).not.toBeNull();
    expect(view.container.textContent).toContain('No reasoning');
  });

  it('auto-expands reconnect groups and keeps healthy groups collapsed by default', () => {
    const healthy = mount(renderGroup({ defaultExpanded: false }));
    mounted.push(healthy);
    const healthyToggle = healthy.container.querySelector<HTMLButtonElement>(
      '[data-testid="settings-models-catalog-anthropic-toggle"]',
    )!;
    expect(healthyToggle.getAttribute('aria-expanded')).toBe('false');

    const reconnect = mount(
      renderGroup({
        defaultExpanded: true,
        reconnectRequired: true,
        entries: [],
        onReconnect: () => {},
      }),
    );
    mounted.push(reconnect);
    const reconnectToggle = reconnect.container.querySelector<HTMLButtonElement>(
      '[data-testid="settings-models-catalog-anthropic-toggle"]',
    )!;
    expect(reconnectToggle.getAttribute('aria-expanded')).toBe('true');
    expect(reconnect.container.textContent).toContain('Not ready: reconnect Anthropic');
  });

  it('does not re-apply the same smart default after a user toggle', () => {
    const view = mount(renderGroup({ defaultExpanded: true }));
    mounted.push(view);
    const toggle = view.container.querySelector<HTMLButtonElement>(
      '[data-testid="settings-models-catalog-anthropic-toggle"]',
    )!;

    fireClick(toggle);
    expect(toggle.getAttribute('aria-expanded')).toBe('false');

    view.render(renderGroup({ defaultExpanded: true }));
    expect(
      view.container
        .querySelector<HTMLButtonElement>('[data-testid="settings-models-catalog-anthropic-toggle"]')
        ?.getAttribute('aria-expanded'),
    ).toBe('false');

    view.render(renderGroup({ defaultExpanded: false }));
    view.render(renderGroup({ defaultExpanded: true }));
    expect(
      view.container
        .querySelector<HTMLButtonElement>('[data-testid="settings-models-catalog-anthropic-toggle"]')
        ?.getAttribute('aria-expanded'),
    ).toBe('true');
  });

  it('ProviderCatalogRow hides controls and no-reasoning text when showEffortControl is false', () => {
    const view = mount(
      <ProviderCatalogRow
        model={{ value: 'claude-haiku-4-5', label: 'Claude Haiku 4.5' }}
        providerLabel="Anthropic"
        billingSource="pay-per-use"
        effort={undefined}
        reasoning={false}
        showEffortControl={false}
        onEffortChange={() => {}}
      />,
    );
    mounted.push(view);

    expect(view.container.textContent).not.toContain('No reasoning');
    expect(
      view.container.querySelector(
        '[data-testid="settings-models-catalog-effort-claude-haiku-4-5-medium"]',
      ),
    ).toBeNull();
  });

  it('updates aria-expanded on toggle and mounts the transition panel class', () => {
    const view = mount(renderGroup());
    mounted.push(view);
    const toggle = view.container.querySelector<HTMLButtonElement>(
      '[data-testid="settings-models-catalog-anthropic-toggle"]',
    )!;

    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    fireClick(toggle);
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    const panel = view.container.querySelector<HTMLElement>(
      '[data-testid="settings-models-catalog-anthropic-panel"]',
    );
    expect(panel?.className).toContain('panelOuter');
  });
});
