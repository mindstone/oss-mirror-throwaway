// @vitest-environment happy-dom
/**
 * ProviderComparisonCard DOM tests.
 *
 * The repo has no `@testing-library/react`. We render via
 * `react-dom/client` + `act` (same pattern as
 * `FileLocationBadge.test.tsx` and the footprint hook tests).
 *
 * Covers Stage 4 of:
 *   docs/plans/260419_cloud_setup_adaptive_sizing_and_honest_progress.md
 */

import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ProviderComparisonCard } from '../ProviderComparisonCard';
import { CLOUD_PROVIDERS } from '../../../../cloudProviders.config';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// ---------------------------------------------------------------------------
// Render helper
// ---------------------------------------------------------------------------

interface Mounted {
  container: HTMLDivElement;
  root: Root;
  unmount: () => void;
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
      act(() => {
        root.unmount();
      });
      container.remove();
    },
  };
}

const byokProviders = CLOUD_PROVIDERS.filter((p) => !!p.pricing);

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ProviderComparisonCard', () => {
  let mounted: Mounted | null = null;

  beforeEach(() => {
    mounted = null;
  });

  afterEach(() => {
    mounted?.unmount();
    mounted = null;
    document.body.innerHTML = '';
  });

  it('renders one row per BYOK provider and skips managed providers', () => {
    mounted = mount(
      <ProviderComparisonCard
        providers={CLOUD_PROVIDERS}
        recommendedVolumeGb={15}
      />,
    );

    const rows = mounted.container.querySelectorAll('tbody tr');
    expect(rows).toHaveLength(byokProviders.length);

    // Managed `mindstone` provider has no pricing — must be skipped.
    const mindstoneRow = mounted.container.querySelector(
      '[data-testid="provider-comparison-row-mindstone"]',
    );
    expect(mindstoneRow).toBeNull();

    // All three BYOK providers are present.
    for (const id of ['fly', 'digitalocean', 'hetzner'] as const) {
      const row = mounted.container.querySelector(
        `[data-testid="provider-comparison-row-${id}"]`,
      );
      expect(row).not.toBeNull();
    }
  });

  it('renders em-dash for storage when recommendedVolumeGb is null', () => {
    mounted = mount(
      <ProviderComparisonCard
        providers={byokProviders}
        recommendedVolumeGb={null}
      />,
    );

    const flyRow = mounted.container.querySelector(
      '[data-testid="provider-comparison-row-fly"]',
    );
    expect(flyRow).not.toBeNull();
    const cells = flyRow!.querySelectorAll('td');
    // Columns: 0 name, 1 storage, 2 server, 3 blurb.
    expect(cells[1]!.textContent).toBe('\u2014');
    // Header should also omit the "(15 GB)" suffix when no recommendation.
    const storageHeader = mounted.container.querySelectorAll('thead th')[1]!;
    expect(storageHeader.textContent?.trim()).toBe('Storage');
  });

  it('renders provider-specific pricing strings at recommendedVolumeGb=15', () => {
    mounted = mount(
      <ProviderComparisonCard
        providers={byokProviders}
        recommendedVolumeGb={15}
      />,
    );

    const flyStorage = mounted.container
      .querySelector('[data-testid="provider-comparison-row-fly"]')!
      .querySelectorAll('td')[1]!;
    expect(flyStorage.textContent).toBe('~$2.25/mo for 15 GB');

    const doStorage = mounted.container
      .querySelector('[data-testid="provider-comparison-row-digitalocean"]')!
      .querySelectorAll('td')[1]!;
    expect(doStorage.textContent).toBe('~$1.50/mo for 15 GB');

    const hetznerStorage = mounted.container
      .querySelector('[data-testid="provider-comparison-row-hetzner"]')!
      .querySelectorAll('td')[1]!;
    expect(hetznerStorage.textContent).toBe('~€0.66/mo for 15 GB (approx $0.71)');

    // Header should show the recommended size inline.
    const storageHeader = mounted.container.querySelectorAll('thead th')[1]!;
    expect(storageHeader.textContent).toContain('Storage');
    expect(storageHeader.textContent).toContain('(15 GB)');
  });

  it('prefixes server-minimum cost with "+ from"', () => {
    mounted = mount(
      <ProviderComparisonCard
        providers={byokProviders}
        recommendedVolumeGb={15}
      />,
    );

    const flyServer = mounted.container
      .querySelector('[data-testid="provider-comparison-row-fly"]')!
      .querySelectorAll('td')[2]!;
    expect(flyServer.textContent).toBe('+ from $1.94/mo');

    const doServer = mounted.container
      .querySelector('[data-testid="provider-comparison-row-digitalocean"]')!
      .querySelectorAll('td')[2]!;
    expect(doServer.textContent).toBe('+ from $6/mo');
  });

  it('renders best-for blurb per provider', () => {
    mounted = mount(
      <ProviderComparisonCard
        providers={byokProviders}
        recommendedVolumeGb={15}
      />,
    );

    const flyBlurb = mounted.container
      .querySelector('[data-testid="provider-comparison-row-fly"]')!
      .querySelectorAll('td')[3]!;
    expect(flyBlurb.textContent).toBe('Simplest setup. Pay-as-you-go billing.');
  });

  it('fires onSelectProvider when a row is clicked', () => {
    const onSelect = vi.fn();
    mounted = mount(
      <ProviderComparisonCard
        providers={byokProviders}
        recommendedVolumeGb={15}
        onSelectProvider={onSelect}
      />,
    );

    const hetznerRow = mounted.container.querySelector(
      '[data-testid="provider-comparison-row-hetzner"]',
    ) as HTMLTableRowElement | null;
    expect(hetznerRow).not.toBeNull();

    act(() => {
      hetznerRow!.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    });

    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onSelect).toHaveBeenCalledWith('hetzner');
  });

  it('highlights the selected row via aria-selected and data-selected', () => {
    mounted = mount(
      <ProviderComparisonCard
        providers={byokProviders}
        recommendedVolumeGb={15}
        selectedProviderId="fly"
      />,
    );

    const flyRow = mounted.container.querySelector(
      '[data-testid="provider-comparison-row-fly"]',
    );
    const doRow = mounted.container.querySelector(
      '[data-testid="provider-comparison-row-digitalocean"]',
    );

    expect(flyRow?.getAttribute('data-selected')).toBe('true');
    expect(flyRow?.getAttribute('aria-selected')).toBe('true');
    expect(doRow?.getAttribute('data-selected')).toBe('false');
    expect(doRow?.getAttribute('aria-selected')).toBe('false');
  });

  it('renders the latest pricingAsOf footer', () => {
    mounted = mount(
      <ProviderComparisonCard
        providers={byokProviders}
        recommendedVolumeGb={15}
      />,
    );

    const footer = mounted.container.querySelector(
      '[data-testid="cloud-provider-comparison-asof"]',
    );
    expect(footer).not.toBeNull();
    expect(footer!.textContent).toContain('Prices as of 2026-04-19');
    expect(footer!.textContent).toContain('Check provider for latest');
  });

  it('returns null when no providers have pricing', () => {
    const mindstone = CLOUD_PROVIDERS.find((p) => p.id === 'mindstone')!;
    mounted = mount(
      <ProviderComparisonCard
        providers={[mindstone]}
        recommendedVolumeGb={15}
      />,
    );

    // The card renders nothing — no container, no table.
    expect(
      mounted.container.querySelector('[data-testid="cloud-provider-comparison-card"]'),
    ).toBeNull();
  });

  it('does not become clickable when onSelectProvider is omitted', () => {
    mounted = mount(
      <ProviderComparisonCard
        providers={byokProviders}
        recommendedVolumeGb={15}
      />,
    );

    const flyRow = mounted.container.querySelector(
      '[data-testid="provider-comparison-row-fly"]',
    );
    expect(flyRow?.getAttribute('role')).toBeNull();
    expect(flyRow?.getAttribute('tabindex')).toBeNull();
  });
});
