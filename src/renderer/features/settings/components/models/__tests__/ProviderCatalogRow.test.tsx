// @vitest-environment happy-dom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ProviderCatalogRow } from '../ProviderCatalogRow';
import { THINKING_LEVELS } from '../profileHelpers';

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
beforeEach(() => {
  mounted.length = 0;
});
afterEach(() => {
  mounted.forEach((m) => m.unmount());
  mounted.length = 0;
});

const opus = { value: 'opus-4.7', label: 'Opus 4.7' };
const haiku = { value: 'haiku-4.5', label: 'Haiku 4.5' };

function fireKeyDown(el: Element, key: string) {
  act(() => {
    el.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));
  });
}

function fireClick(el: Element) {
  act(() => {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
  });
}

describe('ProviderCatalogRow', () => {
  it('renders one effort button per THINKING_LEVELS entry when reasoning is supported', () => {
    const m = mount(
      <ProviderCatalogRow
        model={opus}
        providerLabel="Anthropic"
        billingSource="pay-per-use"
        effort="medium"
        reasoning
        onEffortChange={() => {}}
      />,
    );
    mounted.push(m);

    THINKING_LEVELS.forEach((level) => {
      expect(
        m.container.querySelector(
          `[data-testid="settings-models-catalog-effort-${opus.value}-${level.value}"]`,
        ),
      ).not.toBeNull();
    });
  });

  it('renders provider and billing labels', () => {
    const m = mount(
      <ProviderCatalogRow
        model={opus}
        providerLabel="OpenRouter"
        billingSource="pool"
        effort="medium"
        reasoning
        onEffortChange={() => {}}
      />,
    );
    mounted.push(m);

    expect(m.container.textContent).toContain('OpenRouter');
    expect(m.container.textContent).toContain('Credits');
  });

  it('renders optional capability badges in the metadata line', () => {
    const m = mount(
      <ProviderCatalogRow
        model={opus}
        providerLabel="Anthropic"
        billingSource="pay-per-use"
        effort="medium"
        reasoning
        capabilityBadges={<span data-testid="catalog-capability-badges">JSON</span>}
        onEffortChange={() => {}}
      />,
    );
    mounted.push(m);

    expect(
      m.container.querySelector('[data-testid="catalog-capability-badges"]'),
    ).not.toBeNull();
    expect(m.container.textContent).toContain('JSON');
  });

  it('marks the active level with aria-pressed=true', () => {
    const m = mount(
      <ProviderCatalogRow
        model={opus}
        providerLabel="Anthropic"
        billingSource="pay-per-use"
        effort="high"
        reasoning
        onEffortChange={() => {}}
      />,
    );
    mounted.push(m);

    const high = m.container.querySelector(
      `[data-testid="settings-models-catalog-effort-${opus.value}-high"]`,
    );
    const medium = m.container.querySelector(
      `[data-testid="settings-models-catalog-effort-${opus.value}-medium"]`,
    );
    expect(high?.getAttribute('aria-pressed')).toBe('true');
    expect(medium?.getAttribute('aria-pressed')).toBe('false');
  });

  it('calls onEffortChange on click', () => {
    const onChange = vi.fn();
    const m = mount(
      <ProviderCatalogRow
        model={opus}
        providerLabel="Anthropic"
        billingSource="pay-per-use"
        effort="medium"
        reasoning
        onEffortChange={onChange}
      />,
    );
    mounted.push(m);

    const high = m.container.querySelector(
      `[data-testid="settings-models-catalog-effort-${opus.value}-high"]`,
    )!;
    fireClick(high);
    expect(onChange).toHaveBeenCalledWith('high');
  });

  it('Arrow-Right wraps from last level to first and calls onEffortChange', () => {
    const onChange = vi.fn();
    const lastLevel = THINKING_LEVELS[THINKING_LEVELS.length - 1]!.value;
    const firstLevel = THINKING_LEVELS[0]!.value;
    const m = mount(
      <ProviderCatalogRow
        model={opus}
        providerLabel="Anthropic"
        billingSource="pay-per-use"
        effort={lastLevel}
        reasoning
        onEffortChange={onChange}
      />,
    );
    mounted.push(m);

    const lastBtn = m.container.querySelector(
      `[data-testid="settings-models-catalog-effort-${opus.value}-${lastLevel}"]`,
    )!;
    fireKeyDown(lastBtn, 'ArrowRight');
    expect(onChange).toHaveBeenCalledWith(firstLevel);
  });

  it('Arrow-Left wraps from first level to last', () => {
    const onChange = vi.fn();
    const firstLevel = THINKING_LEVELS[0]!.value;
    const lastLevel = THINKING_LEVELS[THINKING_LEVELS.length - 1]!.value;
    const m = mount(
      <ProviderCatalogRow
        model={opus}
        providerLabel="Anthropic"
        billingSource="pay-per-use"
        effort={firstLevel}
        reasoning
        onEffortChange={onChange}
      />,
    );
    mounted.push(m);

    const firstBtn = m.container.querySelector(
      `[data-testid="settings-models-catalog-effort-${opus.value}-${firstLevel}"]`,
    )!;
    fireKeyDown(firstBtn, 'ArrowLeft');
    expect(onChange).toHaveBeenCalledWith(lastLevel);
  });

  it('renders "No reasoning" for non-reasoning models with no effort buttons', () => {
    const m = mount(
      <ProviderCatalogRow
        model={haiku}
        providerLabel="Anthropic"
        billingSource="pay-per-use"
        effort={undefined}
        reasoning={false}
        onEffortChange={() => {}}
      />,
    );
    mounted.push(m);

    expect(m.container.textContent).toContain('No reasoning');
    expect(
      m.container.querySelector(
        `[data-testid="settings-models-catalog-effort-${haiku.value}-medium"]`,
      ),
    ).toBeNull();
  });
});
