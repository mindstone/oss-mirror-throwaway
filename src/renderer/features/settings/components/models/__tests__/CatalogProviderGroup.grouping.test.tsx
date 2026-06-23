// @vitest-environment happy-dom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PROVIDER_CATALOGS, type CatalogEntry } from '@shared/data/providerCatalogs';
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

const mounted: Mounted[] = [];

afterEach(() => {
  mounted.forEach((instance) => instance.unmount());
  mounted.length = 0;
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});

function renderGroup({
  entries,
  title = 'ChatGPT Pro',
  providerName = title,
}: {
  entries: readonly CatalogEntry[];
  title?: string;
  providerName?: string;
}) {
  return (
    <CatalogProviderGroup
      title={title}
      providerName={providerName}
      entries={entries}
      billingSource="subscription"
      defaultExpanded
      onModelEffortChange={() => {}}
    />
  );
}

function getRow(container: HTMLElement, model: string): HTMLElement {
  const row = container.querySelector<HTMLElement>(
    `[data-testid="settings-models-catalog-row-${model}"]`,
  );
  expect(row).not.toBeNull();
  return row!;
}

describe('CatalogProviderGroup grouping and capabilities', () => {
  it('splits Codex entries into Recommended and Faster / lighter groups', () => {
    const codexEntries = PROVIDER_CATALOGS.openai;
    const mainEntries = codexEntries.filter((entry) => entry.isMainModel);
    const auxEntries = codexEntries.filter((entry) => entry.isAuxiliaryModel);
    expect(mainEntries).toHaveLength(6);
    expect(auxEntries).toHaveLength(7);

    const view = mount(renderGroup({ entries: codexEntries }));
    mounted.push(view);

    expect(view.container.textContent).toContain('Recommended');
    expect(view.container.textContent).toContain('Faster / lighter');

    const renderedRows = Array.from(
      view.container.querySelectorAll<HTMLElement>(
        '[data-testid^="settings-models-catalog-row-"]',
      ),
    );
    expect(renderedRows).toHaveLength(codexEntries.length);
    expect(renderedRows.slice(0, mainEntries.length).map((row) => row.textContent)).toEqual(
      mainEntries.map((entry) => expect.stringContaining(entry.label)),
    );
    expect(renderedRows.slice(mainEntries.length).map((row) => row.textContent)).toEqual(
      auxEntries.map((entry) => expect.stringContaining(entry.label)),
    );
  });

  it('skips grouping headers for Gemini entries because only one group exists', () => {
    const view = mount(
      renderGroup({
        title: 'Gemini',
        providerName: 'Gemini',
        entries: PROVIDER_CATALOGS.google,
      }),
    );
    mounted.push(view);

    expect(view.container.textContent).not.toContain('Recommended');
    expect(view.container.textContent).not.toContain('Faster / lighter');
    expect(
      view.container.querySelectorAll('[data-testid^="settings-models-catalog-row-"]'),
    ).toHaveLength(PROVIDER_CATALOGS.google.length);
  });

  it('skips the Recommended header for a provider with only auxiliary models', () => {
    const auxOnlyEntries: readonly CatalogEntry[] = [
      {
        providerType: 'openai',
        routeSurface: 'subscription',
        model: 'gpt-fast-mini',
        label: 'GPT Fast Mini',
        isMainModel: false,
        isAuxiliaryModel: true,
        reasoning: false,
        jsonSupport: 'compatible',
        toolUseSupport: 'compatible',
      },
    ];

    const view = mount(renderGroup({ entries: auxOnlyEntries }));
    mounted.push(view);

    expect(view.container.textContent).not.toContain('Recommended');
    expect(view.container.textContent).not.toContain('Faster / lighter');
    expect(getRow(view.container, 'gpt-fast-mini').textContent).toContain('GPT Fast Mini');
  });

  it('renders capability badges for each catalog row', () => {
    const capabilityEntries: readonly CatalogEntry[] = [
      {
        providerType: 'anthropic',
        routeSurface: 'api-key',
        model: 'thinking-model',
        label: 'Thinking Model',
        isMainModel: true,
        isAuxiliaryModel: false,
        reasoning: true,
        jsonSupport: 'compatible',
        toolUseSupport: 'compatible',
      },
      {
        providerType: 'anthropic',
        routeSurface: 'api-key',
        model: 'plain-model',
        label: 'Plain Model',
        isMainModel: false,
        isAuxiliaryModel: true,
        reasoning: false,
        jsonSupport: 'compatible',
        toolUseSupport: 'compatible',
      },
    ];

    const view = mount(renderGroup({ entries: capabilityEntries }));
    mounted.push(view);

    for (const entry of capabilityEntries) {
      expect(getRow(view.container, entry.model).textContent).toContain('Works');
    }
  });

  it('maps reasoning true, false, and undefined to Thinking, No Thinking, and no thinking badge', () => {
    const reasoningEntries: readonly CatalogEntry[] = [
      {
        providerType: 'anthropic',
        routeSurface: 'api-key',
        model: 'reasoning-true',
        label: 'Reasoning True',
        isMainModel: true,
        isAuxiliaryModel: false,
        reasoning: true,
      },
      {
        providerType: 'anthropic',
        routeSurface: 'api-key',
        model: 'reasoning-false',
        label: 'Reasoning False',
        isMainModel: false,
        isAuxiliaryModel: true,
        reasoning: false,
      },
      {
        providerType: 'openrouter',
        routeSurface: 'pool',
        model: 'reasoning-unknown',
        label: 'Reasoning Unknown',
        isMainModel: false,
        isAuxiliaryModel: true,
      },
    ];

    const view = mount(renderGroup({ entries: reasoningEntries }));
    mounted.push(view);

    expect(getRow(view.container, 'reasoning-true').textContent).toContain('Thinking');
    expect(getRow(view.container, 'reasoning-false').textContent).toContain('No Thinking');
    expect(getRow(view.container, 'reasoning-unknown').textContent).not.toContain('Thinking');
  });

  it('renders JSON and Tools badges from compatible static support metadata', () => {
    const entries: readonly CatalogEntry[] = [
      {
        providerType: 'google',
        routeSurface: 'api-key',
        model: 'json-tools-model',
        label: 'JSON Tools Model',
        isMainModel: true,
        isAuxiliaryModel: false,
        jsonSupport: 'compatible',
        toolUseSupport: 'compatible',
      },
    ];

    const view = mount(renderGroup({ title: 'Gemini', providerName: 'Gemini', entries }));
    mounted.push(view);

    const rowText = getRow(view.container, 'json-tools-model').textContent;
    expect(rowText).toContain('JSON');
    expect(rowText).toContain('Tools');
  });

  it('does not render JSON or Tools badges for OpenRouter entries without static metadata', () => {
    const entries: readonly CatalogEntry[] = [
      {
        providerType: 'openrouter',
        routeSurface: 'pool',
        model: 'anthropic/claude-openrouter',
        label: 'Claude via OpenRouter',
        isMainModel: true,
        isAuxiliaryModel: false,
      },
    ];

    const view = mount(renderGroup({ title: 'OpenRouter', providerName: 'OpenRouter', entries }));
    mounted.push(view);

    const rowText = getRow(view.container, 'anthropic/claude-openrouter').textContent;
    expect(rowText).toContain('Works');
    expect(rowText).not.toContain('JSON');
    expect(rowText).not.toContain('Tools');
  });
});
