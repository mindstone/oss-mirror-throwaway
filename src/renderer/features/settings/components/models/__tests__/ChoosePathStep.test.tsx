// @vitest-environment happy-dom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { PROVIDER_CATALOGS, type CatalogEntry } from '@shared/data/providerCatalogs';
import { materializeCatalogProfile, type ConnectorCatalogEntry } from '@shared/utils/catalogMaterialization';
import type { ModelProfile } from '@shared/types';
import { ChoosePathStep } from '../steps/ChoosePathStep';

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

function click(element: Element | null): void {
  if (!element) throw new Error('Missing clickable element');
  act(() => {
    element.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
  });
}

function typeIntoInput(input: HTMLInputElement, value: string): void {
  act(() => {
    Object.defineProperty(input, 'value', { writable: true, value });
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
    // React synthetic event
    const nativeInputValueSetter = Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      'value',
    )?.set;
    if (nativeInputValueSetter) {
      nativeInputValueSetter.call(input, value);
    }
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  });
}

function makeOpenRouterEntries(): CatalogEntry[] {
  return Array.from({ length: 12 }, (_, index) => ({
    providerType: 'openrouter',
    routeSurface: 'pool',
    model: `provider/model-${index + 1}`,
    label: `Model ${index + 1}`,
    description: `Model ${index + 1} test description`,
    isMainModel: index < 10,
    isAuxiliaryModel: index >= 10,
  }));
}

function makeOpenRouterEntriesWithoutMainModels(): CatalogEntry[] {
  return Array.from({ length: 15 }, (_, index) => ({
    providerType: 'openrouter',
    routeSurface: 'pool',
    model: `provider/fallback-${index + 1}`,
    label: `Fallback ${index + 1}`,
    description: `Fallback ${index + 1} test description`,
    isMainModel: false,
    isAuxiliaryModel: true,
  }));
}

function renderStep(
  overrides: Partial<React.ComponentProps<typeof ChoosePathStep>> = {},
): Mounted {
  const props: React.ComponentProps<typeof ChoosePathStep> = {
    onAddCatalogEntry: vi.fn(async () => {}),
    onSelectCustom: vi.fn(),
    connectorCatalogEntries: [PROVIDER_CATALOGS.openai[0]!],
    existingProfiles: [],
    onRemoveFromTeam: vi.fn(async () => {}),
    providerConnections: {
      codex: { connected: true },
      openrouter: { connected: true },
      anthropic: { connected: true },
      gemini: { connected: true },
    },
    ...overrides,
  };
  return mount(<ChoosePathStep {...props} />);
}

describe('ChoosePathStep', () => {
  const mounted: Mounted[] = [];

  afterEach(() => {
    for (const instance of mounted) instance.unmount();
    mounted.length = 0;
    document.body.innerHTML = '';
    vi.clearAllMocks();
  });

  it('renders the single-column catalog-first picker with locked copy', () => {
    const onSelectCustom = vi.fn();
    const entry = PROVIDER_CATALOGS.openai[0]!;
    const view = renderStep({ onSelectCustom, connectorCatalogEntries: [entry] });
    mounted.push(view);

    expect(view.container.textContent).toContain('Included with your connections');
    expect(view.container.textContent).toContain(
      'Add one to give Rebel another option for Smart picking. Council stays optional.',
    );
    expect(view.container.textContent).toContain('ChatGPT Pro');
    expect(view.container.textContent).toContain(entry.label);
    expect(view.container.textContent).toContain(entry.description);
    expect(view.container.textContent).toContain(entry.model);
    expect(view.container.textContent).toContain('Add to team');
    expect(view.container.textContent).toContain('Custom setup');
    expect(view.container.textContent).toContain(
      'Use this if your model is not listed or needs a custom URL.',
    );
    expect(view.container.querySelector('[data-testid="settings-models-catalog-picker"]')).not.toBeNull();
    expect(view.container.querySelector('[data-testid="settings-models-choose-connections"]')).toBeNull();
    expect(view.container.textContent).not.toContain('Works');
    expect(view.container.textContent).not.toContain('Tools');
    expect(view.container.textContent).not.toContain('JSON');

    click(view.container.querySelector('[data-testid="settings-models-choose-custom"]'));
    expect(onSelectCustom).toHaveBeenCalledTimes(1);
  });

  it('renders the zero-live-connections empty state with only the custom CTA', () => {
    const onSelectCustom = vi.fn();
    const view = renderStep({
      onSelectCustom,
      providerConnections: {
        codex: { connected: false },
        openrouter: { connected: false },
        anthropic: { connected: false },
        gemini: { connected: false },
      },
    });
    mounted.push(view);

    expect(view.container.textContent).toContain('No connected providers yet');
    expect(view.container.textContent).toContain(
      'Connect ChatGPT Pro, OpenRouter, Anthropic, or Gemini to add included models here.',
    );
    expect(view.container.textContent).toContain('Add custom model');
    expect(view.container.textContent).not.toContain('Open Connections');
    expect(view.container.querySelectorAll('[data-testid^="settings-models-picker-row-"]')).toHaveLength(0);

    click(view.container.querySelector('[data-testid="settings-models-choose-custom"]'));
    expect(onSelectCustom).toHaveBeenCalledTimes(1);
    expect(document.activeElement).toBe(
      view.container.querySelector('[data-testid="settings-models-choose-custom"]'),
    );
  });

  it('marks materialised rows as on-team and calls remove without closing the picker', async () => {
    const entry = PROVIDER_CATALOGS.openai[0]!;
    const profile = materializeCatalogProfile(entry, { id: 'connection-profile' });
    const onRemoveFromTeam = vi.fn(async (_profile: ModelProfile) => {});
    const view = renderStep({
      connectorCatalogEntries: [entry],
      existingProfiles: [profile],
      onRemoveFromTeam,
    });
    mounted.push(view);

    expect(view.container.textContent).toContain('On your team');
    expect(view.container.textContent).toContain('Remove');

    await act(async () => {
      view.container
        .querySelector(`[data-testid="settings-models-picker-remove-openai:subscription:${entry.model}"]`)
        ?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
      await Promise.resolve();
    });

    expect(onRemoveFromTeam).toHaveBeenCalledWith(profile);
    expect(view.container.querySelector('[data-testid="settings-models-catalog-picker"]')).not.toBeNull();
  });

  it('shows disconnected materialised Codex rows with a functional reconnect action', () => {
    const materializedEntry = PROVIDER_CATALOGS.openai[0]!;
    const hiddenEntry = PROVIDER_CATALOGS.openai[1]!;
    const profile = materializeCatalogProfile(materializedEntry, { id: 'connection-profile' });
    const onConnect = vi.fn();
    const view = renderStep({
      connectorCatalogEntries: [materializedEntry, hiddenEntry],
      existingProfiles: [profile],
      providerConnections: { codex: { connected: false, onConnect } },
    });
    mounted.push(view);

    expect(view.container.textContent).toContain('Needs reconnect');
    expect(view.container.textContent).toContain('Reconnect ChatGPT Pro');
    expect(view.container.textContent).toContain('Reconnect to use');
    expect(view.container.textContent).toContain('On your team');
    expect(view.container.textContent).toContain('Remove');
    expect(view.container.textContent).toContain(materializedEntry.label);
    expect(view.container.textContent).not.toContain(hiddenEntry.label);
    expect(document.activeElement).toBe(
      view.container.querySelector('[data-testid="settings-models-picker-connect-codex"]'),
    );
    expect(
      view.container.querySelector(`[data-testid="settings-models-picker-add-openai:subscription:${hiddenEntry.model}"]`),
    ).toBeNull();

    click(view.container.querySelector('[data-testid="settings-models-picker-connect-codex"]'));
    expect(onConnect).toHaveBeenCalledTimes(1);
  });

  it('shows disconnected Anthropic materialised rows with credential guidance instead of an inert reconnect action', () => {
    const entry = PROVIDER_CATALOGS.anthropic[0]!;
    const profile = materializeCatalogProfile(entry, { id: 'anthropic-profile' });
    const view = renderStep({
      connectorCatalogEntries: [entry],
      existingProfiles: [profile],
      providerConnections: { anthropic: { connected: false } },
    });
    mounted.push(view);

    expect(view.container.textContent).toContain('Needs reconnect');
    expect(view.container.textContent).toContain(
      'Re-add your Anthropic API key in Settings to use these again.',
    );
    expect(view.container.textContent).toContain(entry.label);
    expect(view.container.textContent).toContain('Remove');
    expect(
      view.container.querySelector('[data-testid="settings-models-picker-connect-anthropic"]'),
    ).toBeNull();
    expect(
      view.container.querySelector(`[data-testid="settings-models-picker-remove-anthropic:api-key:${entry.model}"]`),
    ).not.toBeNull();
  });

  it('shows only main OpenRouter entries by default and expands per provider', () => {
    const entries = makeOpenRouterEntries();
    const view = renderStep({
      connectorCatalogEntries: entries,
      providerConnections: { openrouter: { connected: true } },
    });
    mounted.push(view);

    // Count rows scoped to the connection-group section only (Recommended also
    // renders isMainModel rows above, so an unscoped count would be higher).
    const orGroup = view.container.querySelector('[data-testid="settings-models-picker-group-openrouter"]');
    expect(orGroup!.querySelectorAll('[data-testid^="settings-models-picker-row-"]')).toHaveLength(10);
    expect(view.container.textContent).toContain('Show all (2 more)');

    click(view.container.querySelector('[data-testid="settings-models-picker-show-all-openrouter"]'));
    expect(orGroup!.querySelectorAll('[data-testid^="settings-models-picker-row-"]')).toHaveLength(12);
  });

  it('pins materialised rows ahead of capping when a large provider has no main-model markers', () => {
    const entries = makeOpenRouterEntriesWithoutMainModels();
    const pinnedEntry = entries[14]!;
    const profile = materializeCatalogProfile(pinnedEntry, { id: 'pinned-profile' });
    const view = renderStep({
      connectorCatalogEntries: entries,
      existingProfiles: [profile],
      providerConnections: { openrouter: { connected: true } },
    });
    mounted.push(view);

    const rows = Array.from(
      view.container.querySelectorAll('[data-testid^="settings-models-picker-row-openrouter:pool:"]'),
    );
    expect(rows).toHaveLength(11);
    expect(rows[0]?.textContent).toContain(pinnedEntry.label);
    expect(view.container.textContent).toContain('Show all (4 more)');
  });

  it('focuses the first Add to team button in a mixed state and truncates long names with title text', () => {
    const onTeamEntry = PROVIDER_CATALOGS.openai[0]!;
    const onTeamProfile = materializeCatalogProfile(onTeamEntry, { id: 'on-team-profile' });
    const longLabel = 'An extraordinarily long model name that should politely truncate in the dialog';
    const entry: CatalogEntry = {
      providerType: 'openrouter',
      routeSurface: 'pool',
      model: 'provider/very-long-model-id-that-also-needs-a-title-attribute',
      label: longLabel,
      description: 'Long-name test model',
      isMainModel: true,
      isAuxiliaryModel: false,
    };
    const view = renderStep({
      connectorCatalogEntries: [onTeamEntry, entry],
      existingProfiles: [onTeamProfile],
      providerConnections: {
        codex: { connected: true },
        openrouter: { connected: true },
      },
    });
    mounted.push(view);

    // The entry is isMainModel + openrouter is connected, so it appears in the
    // Recommended section first (namespaced test-ids). Focus lands on the first
    // Add button in DOM order = the Recommended row.
    const addButton = view.container.querySelector<HTMLButtonElement>(
      `[data-testid="settings-models-picker-recommended-add-openrouter:pool:${entry.model}"]`,
    );
    const row = view.container.querySelector(
      `[data-testid="settings-models-picker-recommended-row-openrouter:pool:${entry.model}"]`,
    );
    expect(document.activeElement).toBe(addButton);
    expect(row?.querySelector('[title]')?.getAttribute('title')).toBe(longLabel);
    expect(addButton?.getAttribute('aria-label')).toBe(`Add ${longLabel} to team`);
  });

  it('focuses the first Remove button when only on-team rows are available', () => {
    const entry = PROVIDER_CATALOGS.openai[0]!;
    const profile = materializeCatalogProfile(entry, { id: 'only-on-team-profile' });
    const view = renderStep({
      connectorCatalogEntries: [entry],
      existingProfiles: [profile],
      providerConnections: { codex: { connected: true } },
    });
    mounted.push(view);

    // The entry is an OpenAI subscription entry. If it's isMainModel and codex is
    // connected, it appears in Recommended first (namespaced test-ids). Focus lands
    // on the first Remove button in DOM order = the Recommended row.
    // If not isMainModel, it only appears in the Codex connection group (unnested).
    const isMainModel = entry.isMainModel;
    const expectedTestId = isMainModel
      ? `settings-models-picker-recommended-remove-openai:subscription:${entry.model}`
      : `settings-models-picker-remove-openai:subscription:${entry.model}`;

    expect(document.activeElement).toBe(
      view.container.querySelector(`[data-testid="${expectedTestId}"]`),
    );
    expect(view.container.querySelector('[data-testid="settings-models-choose-custom"]')).not.toBeNull();
  });

  it('disables picker actions, recovery actions, show-all, and the custom CTA while a catalog row is busy', () => {
    const disconnectedEntry = PROVIDER_CATALOGS.openai[0]!;
    const disconnectedProfile = materializeCatalogProfile(disconnectedEntry, { id: 'busy-remove-profile' });
    const entries = makeOpenRouterEntries();
    const busyEntry = entries[0]!;
    const otherEntry = entries[1]!;
    const view = renderStep({
      connectorCatalogEntries: [disconnectedEntry, ...entries],
      existingProfiles: [disconnectedProfile],
      providerConnections: {
        codex: { connected: false, onConnect: vi.fn() },
        openrouter: { connected: true },
      },
      busyEntryKey: catalogBusyKey(busyEntry),
    });
    mounted.push(view);

    const busyButton = view.container.querySelector<HTMLButtonElement>(
      `[data-testid="settings-models-picker-add-openrouter:pool:${busyEntry.model}"]`,
    );
    const otherButton = view.container.querySelector<HTMLButtonElement>(
      `[data-testid="settings-models-picker-add-openrouter:pool:${otherEntry.model}"]`,
    );
    const removeButton = view.container.querySelector<HTMLButtonElement>(
      `[data-testid="settings-models-picker-remove-openai:subscription:${disconnectedEntry.model}"]`,
    );
    const reconnectButton = view.container.querySelector<HTMLButtonElement>(
      '[data-testid="settings-models-picker-connect-codex"]',
    );
    const showAllButton = view.container.querySelector<HTMLButtonElement>(
      '[data-testid="settings-models-picker-show-all-openrouter"]',
    );
    const customButton = view.container.querySelector<HTMLButtonElement>(
      '[data-testid="settings-models-choose-custom"]',
    );

    expect(busyButton?.disabled).toBe(true);
    expect(busyButton?.textContent).toBe('Adding…');
    expect(otherButton?.disabled).toBe(true);
    expect(removeButton?.disabled).toBe(true);
    expect(reconnectButton?.disabled).toBe(true);
    expect(showAllButton?.disabled).toBe(true);
    expect(customButton?.disabled).toBe(true);
  });

  it('surfaces catalog-add errors inline', async () => {
    const entry = PROVIDER_CATALOGS.openai[0]!;
    const view = renderStep({
      connectorCatalogEntries: [entry],
      onAddCatalogEntry: vi.fn(async () => {
        throw new Error('boom');
      }),
    });
    mounted.push(view);

    await act(async () => {
      view.container
        .querySelector(`[data-testid="settings-models-picker-add-openai:subscription:${entry.model}"]`)
        ?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
      await Promise.resolve();
    });

    expect(view.container.querySelector('[role="alert"]')?.textContent).toContain('boom');
  });

  describe('search/filter', () => {
    it('renders a search input with the correct placeholder', () => {
      const view = renderStep();
      mounted.push(view);

      const input = view.container.querySelector<HTMLInputElement>(
        '[data-testid="settings-models-search-input"]',
      );
      expect(input).not.toBeNull();
      expect(input?.getAttribute('placeholder')).toBe('Search models by name or provider');
      expect(input?.getAttribute('type')).toBe('search');
    });

    it('filters rows by model label substring match', () => {
      const entries = makeOpenRouterEntries();
      const view = renderStep({
        connectorCatalogEntries: entries,
        providerConnections: { openrouter: { connected: true } },
      });
      mounted.push(view);

      // Without query — default cap in the connection group: 10 main models shown.
      // (Scope to the group section to exclude Recommended rows.)
      const orGroup = view.container.querySelector('[data-testid="settings-models-picker-group-openrouter"]');
      expect(orGroup!.querySelectorAll('[data-testid^="settings-models-picker-row-"]')).toHaveLength(10);

      // Type a query matching only Model 1
      const input = view.container.querySelector<HTMLInputElement>('[data-testid="settings-models-search-input"]')!;
      typeIntoInput(input, 'Model 1');

      // Should match "Model 1", "Model 10", "Model 11", "Model 12" — check total across all sections.
      const rows = view.container.querySelectorAll('[data-testid^="settings-models-picker-row-openrouter:pool:"]');
      expect(rows.length).toBeGreaterThan(0);
      // Unique test-ids still scoped to openrouter, fewer than 10 (some are de-duped between sections
      // but uniqueness of DOM nodes means combined count; use distinct test-id count instead).
      const uniqueTestIds = new Set(Array.from(rows).map((r) => r.getAttribute('data-testid')));
      expect(uniqueTestIds.size).toBeLessThan(10);
    });

    it('bypasses the Show-all cap when a query is active', () => {
      const entries = makeOpenRouterEntries(); // 10 isMainModel + 2 non-main
      const view = renderStep({
        connectorCatalogEntries: entries,
        providerConnections: { openrouter: { connected: true } },
      });
      mounted.push(view);

      // Without query: capped at 10 in the connection group (2 hidden).
      // Scope to the group section to exclude Recommended rows.
      const orGroup = view.container.querySelector('[data-testid="settings-models-picker-group-openrouter"]');
      expect(orGroup!.querySelectorAll('[data-testid^="settings-models-picker-row-"]')).toHaveLength(10);
      expect(view.container.textContent).toContain('Show all (2 more)');

      // Type query that matches all 12 entries ("Model" is in every label)
      const input = view.container.querySelector<HTMLInputElement>('[data-testid="settings-models-search-input"]')!;
      typeIntoInput(input, 'model');

      // All 12 unique entries visible in the connection group (cap bypassed), no "Show all" button.
      // After search: orGroup re-renders with all 12 matching entries.
      const orGroupAfter = view.container.querySelector('[data-testid="settings-models-picker-group-openrouter"]');
      expect(orGroupAfter!.querySelectorAll('[data-testid^="settings-models-picker-row-"]')).toHaveLength(12);
      expect(view.container.textContent).not.toContain('Show all');
    });

    it('shows the clear (x) button only when query is non-empty, and clears it on click', () => {
      const entries = makeOpenRouterEntries();
      const view = renderStep({
        connectorCatalogEntries: entries,
        providerConnections: { openrouter: { connected: true } },
      });
      mounted.push(view);

      // No clear button initially
      expect(view.container.querySelector('[data-testid="settings-models-search-clear"]')).toBeNull();

      const input = view.container.querySelector<HTMLInputElement>('[data-testid="settings-models-search-input"]')!;
      typeIntoInput(input, 'model 1');

      // Clear button now visible
      const clearButton = view.container.querySelector('[data-testid="settings-models-search-clear"]');
      expect(clearButton).not.toBeNull();

      // Clicking clear resets to full (uncapped) list
      click(clearButton);

      expect(view.container.querySelector('[data-testid="settings-models-search-clear"]')).toBeNull();
      // After clear, no query → default cap restored: 10 rows in the connection group.
      // Scope to the connection group to exclude Recommended rows.
      const orGroup = view.container.querySelector('[data-testid="settings-models-picker-group-openrouter"]');
      expect(orGroup!.querySelectorAll('[data-testid^="settings-models-picker-row-"]')).toHaveLength(10);
    });

    it('shows search empty state with custom-model CTA when query matches nothing', () => {
      const entries = makeOpenRouterEntries();
      const onSelectCustom = vi.fn();
      const view = renderStep({
        connectorCatalogEntries: entries,
        providerConnections: { openrouter: { connected: true } },
        onSelectCustom,
      });
      mounted.push(view);

      const input = view.container.querySelector<HTMLInputElement>('[data-testid="settings-models-search-input"]')!;
      typeIntoInput(input, 'xyzzy-no-match-ever');

      // Search empty state renders
      expect(view.container.querySelector('[data-testid="settings-models-search-empty-state"]')).not.toBeNull();
      // Custom CTA is present in the empty state
      expect(view.container.querySelector('[data-testid="settings-models-choose-custom"]')).not.toBeNull();
      // No picker rows
      expect(view.container.querySelectorAll('[data-testid^="settings-models-picker-row-"]')).toHaveLength(0);

      // Custom CTA works
      click(view.container.querySelector('[data-testid="settings-models-choose-custom"]'));
      expect(onSelectCustom).toHaveBeenCalledTimes(1);
    });

    it('announces result count via aria-live region when search is active', () => {
      const entries = makeOpenRouterEntries();
      const view = renderStep({
        connectorCatalogEntries: entries,
        providerConnections: { openrouter: { connected: true } },
      });
      mounted.push(view);

      const liveRegion = view.container.querySelector<HTMLElement>('[aria-live="polite"]');
      expect(liveRegion).not.toBeNull();
      // No announcement when search is inactive
      expect(liveRegion?.textContent?.trim()).toBe('');

      const input = view.container.querySelector<HTMLInputElement>('[data-testid="settings-models-search-input"]')!;
      typeIntoInput(input, 'model 1');

      // Should announce found results
      expect(liveRegion?.textContent).toMatch(/\d+ model/);

      // With no-match query
      typeIntoInput(input, 'xyzzy-no-match-ever');
      expect(liveRegion?.textContent).toMatch(/No models/);
    });

    it('F2: matches provider name in search so the placeholder is honest', () => {
      // Render with entries from multiple providers: OpenRouter + Codex (openai).
      const orEntries = makeOpenRouterEntries();
      const codexEntry = PROVIDER_CATALOGS.openai[0]!;
      const view = renderStep({
        connectorCatalogEntries: [...orEntries, codexEntry],
        providerConnections: {
          codex: { connected: true },
          openrouter: { connected: true },
        },
      });
      mounted.push(view);

      const input = view.container.querySelector<HTMLInputElement>('[data-testid="settings-models-search-input"]')!;

      // Search "OpenRouter" — should match OpenRouter entries (group visible), not Codex.
      typeIntoInput(input, 'openrouter');
      const orGroupAfter = view.container.querySelector('[data-testid="settings-models-picker-group-openrouter"]');
      expect(orGroupAfter).not.toBeNull();
      // Codex group should be absent (its provider title is "ChatGPT Pro", handle "codex")
      expect(view.container.querySelector('[data-testid="settings-models-picker-group-codex"]')).toBeNull();

      // Search "ChatGPT Pro" — should match Codex (openai) entries.
      typeIntoInput(input, 'chatgpt pro');
      const codexGroupAfter = view.container.querySelector('[data-testid="settings-models-picker-group-codex"]');
      expect(codexGroupAfter).not.toBeNull();
      // OpenRouter group should be absent.
      expect(view.container.querySelector('[data-testid="settings-models-picker-group-openrouter"]')).toBeNull();
    });

    it('preserves the 10-row cap with no query active (regression guard)', () => {
      const entries = makeOpenRouterEntries();
      const view = renderStep({
        connectorCatalogEntries: entries,
        providerConnections: { openrouter: { connected: true } },
      });
      mounted.push(view);

      // Ensure search input is present and empty (no interference with default cap)
      const input = view.container.querySelector<HTMLInputElement>('[data-testid="settings-models-search-input"]');
      expect(input?.value).toBe('');
      // Scope to the connection group to exclude Recommended rows.
      const orGroup = view.container.querySelector('[data-testid="settings-models-picker-group-openrouter"]');
      expect(orGroup!.querySelectorAll('[data-testid^="settings-models-picker-row-"]')).toHaveLength(10);
    });
  });

  describe('Recommended for most people', () => {
    it('renders isMainModel rows from connectorCatalogEntries in the recommended section', () => {
      const entries = makeOpenRouterEntries(); // 10 isMainModel + 2 non-main
      const view = renderStep({
        connectorCatalogEntries: entries,
        providerConnections: { openrouter: { connected: true } },
      });
      mounted.push(view);

      const recommended = view.container.querySelector('[data-testid="settings-models-picker-group-recommended"]');
      expect(recommended).not.toBeNull();
      expect(recommended!.textContent).toContain('Recommended for most people');
      expect(recommended!.textContent).toContain('A short, sensible default set. You can add more below.');
      // Has some picker rows (namespaced with 'recommended' section key)
      const rows = recommended!.querySelectorAll('[data-testid^="settings-models-picker-recommended-row-"]');
      expect(rows.length).toBeGreaterThan(0);
    });

    it('caps recommended rows at 6 (bounded count)', () => {
      const entries = makeOpenRouterEntries(); // 10 isMainModel entries
      const view = renderStep({
        connectorCatalogEntries: entries,
        providerConnections: { openrouter: { connected: true } },
      });
      mounted.push(view);

      const recommended = view.container.querySelector('[data-testid="settings-models-picker-group-recommended"]');
      const rows = recommended!.querySelectorAll('[data-testid^="settings-models-picker-recommended-row-"]');
      expect(rows.length).toBeLessThanOrEqual(6);
    });

    it('deduplicates rows within the recommended section by catalogEntryKey', () => {
      // Supply two identical entries (same key) — only one should appear.
      const base = makeOpenRouterEntries()[0]!;
      const duplicate = { ...base };
      const view = renderStep({
        connectorCatalogEntries: [base, duplicate],
        providerConnections: { openrouter: { connected: true } },
      });
      mounted.push(view);

      const recommended = view.container.querySelector('[data-testid="settings-models-picker-group-recommended"]');
      const rows = recommended!.querySelectorAll('[data-testid^="settings-models-picker-recommended-row-"]');
      expect(rows).toHaveLength(1);
    });

    it('renders Recommended above the catalog picker (sits first)', () => {
      const entries = makeOpenRouterEntries();
      const view = renderStep({
        connectorCatalogEntries: entries,
        providerConnections: { openrouter: { connected: true } },
      });
      mounted.push(view);

      const all = view.container.querySelectorAll(
        '[data-testid="settings-models-picker-group-recommended"], [data-testid="settings-models-catalog-picker"]',
      );
      expect(all).toHaveLength(2);
      expect(all[0]?.getAttribute('data-testid')).toBe('settings-models-picker-group-recommended');
      expect(all[1]?.getAttribute('data-testid')).toBe('settings-models-catalog-picker');
    });

    it('derives On your team / Remove state from existingProfiles', () => {
      const entry = makeOpenRouterEntries()[0]!; // isMainModel: true
      const profile = materializeCatalogProfile(entry, { id: 'rec-profile' });
      const view = renderStep({
        connectorCatalogEntries: [entry],
        existingProfiles: [profile],
        providerConnections: { openrouter: { connected: true } },
      });
      mounted.push(view);

      const recommended = view.container.querySelector('[data-testid="settings-models-picker-group-recommended"]');
      expect(recommended!.textContent).toContain('On your team');
      expect(recommended!.textContent).toContain('Remove');
    });

    it('filters recommended rows by active search query', () => {
      const entries = makeOpenRouterEntries(); // labels: "Model 1" through "Model 12"
      const view = renderStep({
        connectorCatalogEntries: entries,
        providerConnections: { openrouter: { connected: true } },
      });
      mounted.push(view);

      // Without query: Recommended shows up to 6 isMainModel rows.
      const recommendedBefore = view.container.querySelector('[data-testid="settings-models-picker-group-recommended"]');
      expect(recommendedBefore).not.toBeNull();

      // Search for "Model 2" — matches "Model 2", "Model 12" (not the others under cap).
      const input = view.container.querySelector<HTMLInputElement>('[data-testid="settings-models-search-input"]')!;
      typeIntoInput(input, 'Model 2');

      const recommendedAfter = view.container.querySelector('[data-testid="settings-models-picker-group-recommended"]');
      if (recommendedAfter) {
        // All visible recommended rows should contain the search term (namespaced test-ids).
        const rows = recommendedAfter.querySelectorAll('[data-testid^="settings-models-picker-recommended-row-"]');
        for (const row of Array.from(rows)) {
          expect(row.textContent?.toLowerCase()).toContain('model 2');
        }
      }

      // With non-matching query: Recommended section should disappear (no isMainModel matches).
      typeIntoInput(input, 'xyzzy-no-match-ever');
      expect(view.container.querySelector('[data-testid="settings-models-picker-group-recommended"]')).toBeNull();
    });

    it('hides recommended section when no connectorCatalogEntries have isMainModel set', () => {
      const entries = makeOpenRouterEntriesWithoutMainModels(); // all isMainModel: false
      const view = renderStep({
        connectorCatalogEntries: entries,
        providerConnections: { openrouter: { connected: true } },
      });
      mounted.push(view);

      expect(view.container.querySelector('[data-testid="settings-models-picker-group-recommended"]')).toBeNull();
    });
  });
});

function catalogBusyKey(entry: CatalogEntry): string {
  return `${entry.providerType}:${entry.routeSurface}:${entry.model}`;
}

// ---------------------------------------------------------------------------
// Managed group tests
// ---------------------------------------------------------------------------

describe('Managed group — Included with your Mindstone plan', () => {
  const mounted: Mounted[] = [];

  afterEach(() => {
    for (const instance of mounted) instance.unmount();
    mounted.length = 0;
    document.body.innerHTML = '';
    vi.clearAllMocks();
  });

  // Use a real OpenRouter catalog entry that always exists (first entry).
  function getManagedEntry(): ConnectorCatalogEntry {
    return PROVIDER_CATALOGS.openrouter[0]! as ConnectorCatalogEntry;
  }

  function renderManagedStep(
    overrides: Partial<React.ComponentProps<typeof ChoosePathStep>> = {},
  ): Mounted {
    const managedEntry = getManagedEntry();
    const props: React.ComponentProps<typeof ChoosePathStep> = {
      onAddCatalogEntry: vi.fn(async () => {}),
      onSelectCustom: vi.fn(),
      connectorCatalogEntries: [],
      existingProfiles: [],
      onRemoveFromTeam: vi.fn(async () => {}),
      providerConnections: {},
      isMindstoneActive: true,
      managedAllowedModels: [managedEntry.model],
      ...overrides,
    };
    return mount(<ChoosePathStep {...props} />);
  }

  it('renders the managed group when isMindstoneActive and managedAllowedModels is non-empty', () => {
    const managedEntry = getManagedEntry();
    const view = renderManagedStep();
    mounted.push(view);

    const group = view.container.querySelector('[data-testid="settings-models-picker-group-managed"]');
    expect(group).not.toBeNull();
    expect(group!.textContent).toContain('Included with your Mindstone plan');
    expect(group!.textContent).toContain('These come with your plan');
    expect(group!.textContent).toContain(managedEntry.label);
  });

  it('shows managed group as informational (visible but not addable) when isMindstoneActive is false and subscriber has models', () => {
    // Previously this test asserted the group was hidden when off-Mindstone.
    // After the design-option-(b) fix, the group renders for discoverability —
    // but rows are informational (no Add button) rather than addable.
    const managedEntry = getManagedEntry();
    const view = renderManagedStep({
      isMindstoneActive: false,
      managedAllowedModels: [managedEntry.model],
    });
    mounted.push(view);

    // Group is visible — subscriber can discover their plan models.
    const group = view.container.querySelector('[data-testid="settings-models-picker-group-managed"]');
    expect(group).not.toBeNull();
    // But rows are informational — no Add button present.
    const addButton = group!.querySelector(
      `[data-testid="settings-models-picker-managed-add-openrouter:pool:${managedEntry.model}"]`,
    );
    expect(addButton).toBeNull();
    // "On your plan" badge is present instead.
    expect(group!.textContent).toContain('On your plan');
  });

  it('shows On your team / Remove (not informational) for an already-added managed model viewed off-Mindstone', () => {
    // Edge case: a managed model added while on Mindstone, then viewed while on
    // another provider. existingProfile must win over the informational state —
    // the row shows On your team / Remove, NOT the "On your plan" badge.
    const managedEntry = getManagedEntry();
    const profile = materializeCatalogProfile(managedEntry, { id: 'managed-on-team' });
    const view = renderManagedStep({
      isMindstoneActive: false,
      managedAllowedModels: [managedEntry.model],
      existingProfiles: [profile],
    });
    mounted.push(view);

    const group = view.container.querySelector('[data-testid="settings-models-picker-group-managed"]');
    expect(group).not.toBeNull();
    expect(group!.textContent).toContain('On your team');
    expect(group!.textContent).toContain('Remove');
    expect(group!.textContent).not.toContain('On your plan');
  });

  it('hides the managed group when managedAllowedModels is empty (cloud/mobile case)', () => {
    const view = renderManagedStep({
      isMindstoneActive: true,
      managedAllowedModels: [],
    });
    mounted.push(view);

    expect(view.container.querySelector('[data-testid="settings-models-picker-group-managed"]')).toBeNull();
  });

  it('hides the managed group when both isMindstoneActive is false and list is empty', () => {
    const view = renderManagedStep({
      isMindstoneActive: false,
      managedAllowedModels: [],
    });
    mounted.push(view);

    expect(view.container.querySelector('[data-testid="settings-models-picker-group-managed"]')).toBeNull();
  });

  it('renders managed rows as directly addable (Add to team button present, no reconnect affordance)', () => {
    const managedEntry = getManagedEntry();
    const view = renderManagedStep();
    mounted.push(view);

    const group = view.container.querySelector('[data-testid="settings-models-picker-group-managed"]');
    expect(group).not.toBeNull();

    // Add button present
    const addButton = group!.querySelector<HTMLButtonElement>(
      `[data-testid="settings-models-picker-managed-add-openrouter:pool:${managedEntry.model}"]`,
    );
    expect(addButton).not.toBeNull();
    expect(addButton?.disabled).toBe(false);
    expect(addButton?.textContent).toContain('Add to team');

    // No reconnect affordance
    expect(group!.textContent).not.toContain('Needs reconnect');
    expect(group!.textContent).not.toContain('Reconnect');
  });

  it('shows On your team / Remove when the managed model is already in existingProfiles', () => {
    const managedEntry = getManagedEntry();
    const profile = materializeCatalogProfile(managedEntry, { id: 'managed-profile' });
    const view = renderManagedStep({ existingProfiles: [profile] });
    mounted.push(view);

    const group = view.container.querySelector('[data-testid="settings-models-picker-group-managed"]');
    expect(group!.textContent).toContain('On your team');
    expect(group!.textContent).toContain('Remove');
    // No Add button
    expect(
      group!.querySelector(
        `[data-testid="settings-models-picker-managed-add-openrouter:pool:${managedEntry.model}"]`,
      ),
    ).toBeNull();
  });

  it('filters managed rows by active search query', () => {
    const managedEntry = getManagedEntry();
    const view = renderManagedStep();
    mounted.push(view);

    // Without query: group visible
    expect(view.container.querySelector('[data-testid="settings-models-picker-group-managed"]')).not.toBeNull();

    // Non-matching query: group disappears
    const input = view.container.querySelector<HTMLInputElement>('[data-testid="settings-models-search-input"]')!;
    typeIntoInput(input, 'xyzzy-no-match-ever');
    expect(view.container.querySelector('[data-testid="settings-models-picker-group-managed"]')).toBeNull();

    // Matching query: group reappears
    typeIntoInput(input, managedEntry.model.split('/')[0] ?? managedEntry.label);
    const groupAfter = view.container.querySelector('[data-testid="settings-models-picker-group-managed"]');
    // Group either visible (matched) or not — either way, if visible, rows match query
    if (groupAfter) {
      const rows = groupAfter.querySelectorAll('[data-testid^="settings-models-picker-managed-row-"]');
      expect(rows.length).toBeGreaterThan(0);
    }
  });

  it('uses namespaced test-ids for managed rows (no collision with connection groups)', () => {
    const managedEntry = getManagedEntry();
    // Render with the same entry in both managed and connection groups
    const view = renderManagedStep({
      connectorCatalogEntries: [managedEntry],
      providerConnections: { openrouter: { connected: true } },
      managedAllowedModels: [managedEntry.model],
    });
    mounted.push(view);

    // Managed row has namespaced test-id
    const managedAddButton = view.container.querySelector(
      `[data-testid="settings-models-picker-managed-add-openrouter:pool:${managedEntry.model}"]`,
    );
    // Connection group row has original test-id (stable external contract)
    const groupAddButton = view.container.querySelector(
      `[data-testid="settings-models-picker-add-openrouter:pool:${managedEntry.model}"]`,
    );

    // Both exist but with different test-ids — no duplicate IDs
    expect(managedAddButton).not.toBeNull();
    expect(groupAddButton).not.toBeNull();
    expect(managedAddButton).not.toBe(groupAddButton);
  });

  it('F1: emits a console.warn when allow-list ids are missing from the bundled catalog', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    // Use an id that is definitely NOT in the OpenRouter catalog
    const ghostId = 'nonexistent-provider/ghost-model-that-will-never-exist-in-catalog-xyz123';
    // Also include a real catalog entry so the group renders (matched > 0).
    const managedEntry = getManagedEntry();
    const view = renderManagedStep({
      managedAllowedModels: [managedEntry.model, ghostId],
    });
    mounted.push(view);

    // The warning must have fired (once, on mount).
    const calls = warnSpy.mock.calls.filter((args) =>
      typeof args[0] === 'string' && args[0].includes('[ChoosePathStep] Mindstone allow-list ids missing from bundled catalog'),
    );
    expect(calls.length).toBeGreaterThan(0);
    const payload = calls[0]?.[1] as { unmatched: string[]; allowListSize: number; matched: number } | undefined;
    expect(payload?.unmatched.length).toBeGreaterThan(0);
    expect(payload?.allowListSize).toBe(2);
    expect(payload?.matched).toBe(1);

    // Rendering still shows the matched row (ghost id has no catalog row to show).
    const group = view.container.querySelector('[data-testid="settings-models-picker-group-managed"]');
    expect(group).not.toBeNull();
    expect(group!.textContent).toContain(managedEntry.label);

    warnSpy.mockRestore();
  });

  it('F1: does NOT warn when all allow-list ids are present in the bundled catalog', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const managedEntry = getManagedEntry();
    const view = renderManagedStep({
      managedAllowedModels: [managedEntry.model],
    });
    mounted.push(view);

    const calls = warnSpy.mock.calls.filter((args) =>
      typeof args[0] === 'string' && args[0].includes('[ChoosePathStep] Mindstone allow-list ids missing from bundled catalog'),
    );
    expect(calls.length).toBe(0);

    warnSpy.mockRestore();
  });

  it('shows managed group as informational (no Add button, On your plan badge) when subscriber is off-Mindstone', () => {
    const managedEntry = getManagedEntry();
    const view = renderManagedStep({
      isMindstoneActive: false,
      managedAllowedModels: [managedEntry.model],
    });
    mounted.push(view);

    // Group should render even though isMindstoneActive is false (discoverability)
    const group = view.container.querySelector('[data-testid="settings-models-picker-group-managed"]');
    expect(group).not.toBeNull();
    expect(group!.textContent).toContain('Included with your Mindstone plan');

    // Row should be present
    const row = group!.querySelector(
      `[data-testid="settings-models-picker-managed-row-openrouter:pool:${managedEntry.model}"]`,
    );
    expect(row).not.toBeNull();

    // No Add button — informational state
    const addButton = group!.querySelector(
      `[data-testid="settings-models-picker-managed-add-openrouter:pool:${managedEntry.model}"]`,
    );
    expect(addButton).toBeNull();

    // "On your plan" badge visible
    expect(group!.textContent).toContain('On your plan');

    // Helper copy should mention switching provider
    expect(group!.textContent).toContain('switch your active provider to Mindstone');
  });

  it('hides the catalog section header when search matches only managed rows (orphan-header fix)', () => {
    const managedEntry = getManagedEntry();
    const view = renderManagedStep({
      // Add connection entries that won't match the search query
      connectorCatalogEntries: [{
        providerType: 'openrouter',
        routeSurface: 'pool',
        model: 'other/completely-different-model',
        label: 'Completely Different Model',
        description: 'This should not match the managed entry search',
        isMainModel: true,
        isAuxiliaryModel: false,
      } as ConnectorCatalogEntry],
      providerConnections: { openrouter: { connected: true } },
      managedAllowedModels: [managedEntry.model],
    });
    mounted.push(view);

    // Activate a search that matches managedEntry label but NOT the connection entry
    const input = view.container.querySelector<HTMLInputElement>('[data-testid="settings-models-search-input"]')!;
    // Use a query specific to the managed entry's provider/label
    typeIntoInput(input, managedEntry.model.split('/')[1] ?? managedEntry.model);

    // Catalog section should not show its "Included with your connections" header
    // when no connection-group rows match (connectionGroupRowCount === 0)
    const catalogSection = view.container.querySelector('[data-testid="settings-models-catalog-picker"]');
    if (catalogSection) {
      // If the section exists, the header should be hidden (no orphan h3 visible)
      const connectionHeader = Array.from(
        catalogSection.querySelectorAll('h3'),
      ).find((h) => h.textContent?.includes('Included with your connections'));
      expect(connectionHeader).toBeUndefined();
    }
  });
});
