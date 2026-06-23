// @vitest-environment happy-dom

import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { getByTestId } from '@testing-library/dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Info, RefreshCw } from 'lucide-react';
import { tracking } from '@renderer/src/tracking';
import { LibraryLensBar, type LibraryLensOverflowAction } from '../LibraryLensBar';
import type { LibraryLens, LibrarySortOption } from '../../types/lens';
import type { FacetOption } from '../../hooks/useFilterFacets';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type Mounted = {
  container: HTMLDivElement;
  root: Root;
  rerender: (next: React.ReactElement) => void;
  unmount: () => void;
};

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
    rerender: (next) => {
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

type RenderOptions = {
  lens?: LibraryLens;
  facets?: readonly FacetOption[];
  searchQuery?: string;
  sortBy?: LibrarySortOption;
  orientationTipDismissed?: boolean;
  revealedFoldersCount?: number;
  disabled?: boolean;
  primaryActions?: React.ReactNode;
  overflowActions?: readonly LibraryLensOverflowAction[];
};

function renderLensBar(overrides: RenderOptions = {}) {
  const setBrowseLens = vi.fn();
  const onSearchQueryChange = vi.fn();
  const onSortByChange = vi.fn();
  const dismissOrientationTip = vi.fn();

  const props = {
    lens: overrides.lens ?? { filter: 'spaces', view: 'folders' },
    facets: overrides.facets ?? [],
    searchQuery: overrides.searchQuery ?? '',
    sortBy: overrides.sortBy ?? 'name',
    setBrowseLens,
    onSearchQueryChange,
    onSortByChange,
    orientationTipDismissed: overrides.orientationTipDismissed ?? false,
    dismissOrientationTip,
    revealedFoldersCount: overrides.revealedFoldersCount,
    disabled: overrides.disabled ?? false,
    primaryActions: overrides.primaryActions,
    overflowActions: overrides.overflowActions,
  } as const;

  const mounted = mount(<LibraryLensBar {...props} />);

  return {
    ...mounted,
    props,
    setBrowseLens,
    onSearchQueryChange,
    onSortByChange,
    dismissOrientationTip,
  };
}

function click(element: Element | null): void {
  if (!element) {
    throw new Error('Expected element to exist');
  }
  act(() => {
    element.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
    element.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    element.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    element.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
}

describe('LibraryLensBar', () => {
  let lensChangedSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    lensChangedSpy = vi.spyOn(tracking.library, 'lensChanged').mockImplementation(() => undefined);
  });

  afterEach(() => {
    lensChangedSpy.mockRestore();
    vi.useRealTimers();
    document.body.innerHTML = '';
    vi.clearAllMocks();
  });

  it('uses radiogroup/radio semantics with aria-checked', () => {
    const mounted = renderLensBar({
      lens: { filter: 'memory', view: 'cards' },
      orientationTipDismissed: true,
    });

    const radiogroups = mounted.container.querySelectorAll('[role="radiogroup"]');
    expect(radiogroups).toHaveLength(2);

    const memoryChip = mounted.container.querySelector('[data-testid="library-filter-chip-memory"]');
    const cardsChip = mounted.container.querySelector('[data-testid="library-view-chip-cards"]');
    const skillsChip = mounted.container.querySelector('[data-testid="library-filter-chip-skills"]');

    expect(memoryChip?.getAttribute('role')).toBe('radio');
    expect(memoryChip?.getAttribute('aria-checked')).toBe('true');
    expect(cardsChip?.getAttribute('role')).toBe('radio');
    expect(cardsChip?.getAttribute('aria-checked')).toBe('true');
    expect(skillsChip?.getAttribute('aria-checked')).toBe('false');

    mounted.unmount();
  });

  it('exposes Stage-2 lens bar test ids', () => {
    const mounted = renderLensBar({
      lens: { filter: 'spaces', view: 'folders' },
      orientationTipDismissed: false,
    });

    expect(getByTestId(mounted.container, 'library-lens-bar')).toBeTruthy();
    expect(getByTestId(mounted.container, 'library-filter-chip-everything')).toBeTruthy();
    expect(getByTestId(mounted.container, 'library-view-chip-folders')).toBeTruthy();
    expect(getByTestId(mounted.container, 'library-view-chip-cards')).toBeTruthy();
    expect(getByTestId(mounted.container, 'library-view-chip-atlas')).toBeTruthy();
    expect(mounted.container.querySelector('[data-testid="library-view-chip-list"]')).toBeNull();
    expect(getByTestId(mounted.container, 'library-lens-search-input')).toBeTruthy();
    expect(mounted.container.querySelector('[data-testid="library-orientation-tip"]')).toBeNull();

    mounted.unmount();
  });

  it('preserves search → sort → actions DOM order at narrow widths', () => {
    const originalInnerWidth = window.innerWidth;
    Object.defineProperty(window, 'innerWidth', { value: 840, configurable: true });
    act(() => {
      window.dispatchEvent(new Event('resize'));
    });

    const mounted = renderLensBar({
      lens: { filter: 'everything', view: 'cards' },
      sortBy: 'recent',
      orientationTipDismissed: true,
      primaryActions: <div data-testid="library-lens-actions-slot">Actions</div>,
    });

    const searchInput = getByTestId(mounted.container, 'library-lens-search-input');
    const sortSelect = getByTestId(mounted.container, 'library-lens-sort-select');
    const actionsSlot = getByTestId(mounted.container, 'library-lens-actions-slot');

    expect(searchInput.compareDocumentPosition(sortSelect) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0);
    expect(sortSelect.compareDocumentPosition(actionsSlot) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0);

    Object.defineProperty(window, 'innerWidth', { value: originalInnerWidth, configurable: true });

    mounted.unmount();
  });

  it('opens and closes overflow menu actions in compact mode', () => {
    const onInfo = vi.fn();
    const onRefresh = vi.fn();
    const mounted = renderLensBar({
      lens: { filter: 'spaces', view: 'cards' },
      sortBy: 'name',
      orientationTipDismissed: true,
      primaryActions: <button type="button">Add memory</button>,
      overflowActions: [
        {
          id: 'info',
          label: 'Show Library info',
          icon: Info,
          onClick: onInfo,
          indicator: 'indexing',
        },
        {
          id: 'refresh',
          label: 'Refresh files',
          icon: RefreshCw,
          onClick: onRefresh,
        },
      ],
    });

    const trigger = getByTestId(mounted.container, 'library-overflow-menu-trigger');
    expect(trigger.getAttribute('aria-expanded')).toBe('false');

    click(trigger);
    expect(trigger.getAttribute('aria-expanded')).toBe('true');
    expect(getByTestId(document.body, 'library-overflow-menu')).toBeTruthy();

    click(getByTestId(document.body, 'library-overflow-menu-item-info'));
    expect(onInfo).toHaveBeenCalledTimes(1);
    expect(document.body.querySelector('[data-testid="library-overflow-menu"]')).toBeNull();

    click(trigger);
    click(getByTestId(document.body, 'library-overflow-menu-item-refresh'));
    expect(onRefresh).toHaveBeenCalledTimes(1);
    expect(document.body.querySelector('[data-testid="library-overflow-menu"]')).toBeNull();

    mounted.unmount();
  });

  it('clicking chips mutates browse lens by axis and tracks lensChanged', () => {
    const mounted = renderLensBar({
      lens: { filter: 'spaces', view: 'folders' },
      orientationTipDismissed: false,
    });

    const skillsChip = mounted.container.querySelector('[data-testid="library-filter-chip-skills"]');
    const cardsChip = mounted.container.querySelector('[data-testid="library-view-chip-cards"]');
    expect(skillsChip).toBeTruthy();
    expect(cardsChip).toBeTruthy();

    act(() => {
      skillsChip?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(mounted.setBrowseLens).toHaveBeenCalledTimes(1);
    const filterUpdater = mounted.setBrowseLens.mock.calls[0][0] as (prev: LibraryLens) => LibraryLens;
    expect(filterUpdater({ filter: 'spaces', view: 'folders' })).toEqual({ filter: 'skills', view: 'folders' });
    expect(lensChangedSpy).toHaveBeenCalledWith({
      filter: 'skills',
      view: 'folders',
      axis: 'filter',
    });
    expect(mounted.dismissOrientationTip).toHaveBeenCalledTimes(1);

    act(() => {
      cardsChip?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(mounted.setBrowseLens).toHaveBeenCalledTimes(2);
    const viewUpdater = mounted.setBrowseLens.mock.calls[1][0] as (prev: LibraryLens) => LibraryLens;
    expect(viewUpdater({ filter: 'spaces', view: 'folders' })).toEqual({ filter: 'spaces', view: 'cards' });
    expect(lensChangedSpy).toHaveBeenCalledWith({
      filter: 'spaces',
      view: 'cards',
      axis: 'view',
    });

    mounted.unmount();
  });

  it('renders filter trigger inside search field when facets > 1', () => {
    const mounted = renderLensBar({
      lens: { filter: 'skills', view: 'cards' },
      facets: [
        { id: 'all', label: 'All', count: 10, ariaLabel: 'Show all', tooltip: 'All · 10 skills' },
        {
          id: 'communication',
          label: 'Communication',
          count: 6,
          ariaLabel: 'Show communication skills',
          tooltip: 'Communication · 6 skills',
        },
      ],
      orientationTipDismissed: true,
    });

    const searchField = getByTestId(mounted.container, 'library-lens-search-field');
    const filterTrigger = getByTestId(mounted.container, 'library-filter-trigger');
    expect(searchField.contains(filterTrigger)).toBe(true);

    mounted.unmount();
  });

  it('opens filter popover on trigger click and closes on chip selection', () => {
    const mounted = renderLensBar({
      lens: { filter: 'skills', view: 'cards', facet: 'communication' },
      facets: [
        { id: 'all', label: 'All', count: 10, ariaLabel: 'Show all', tooltip: 'All · 10 skills' },
        {
          id: 'communication',
          label: 'Communication',
          count: 6,
          ariaLabel: 'Show communication skills',
          tooltip: 'Communication · 6 skills',
        },
        { id: 'research', label: 'Research', count: 4, ariaLabel: 'Show research skills', tooltip: 'Research · 4 skills' },
      ],
      orientationTipDismissed: true,
    });

    const trigger = getByTestId(mounted.container, 'library-filter-trigger');
    click(trigger);

    expect(getByTestId(document.body, 'library-filter-popover')).toBeTruthy();
    const communicationChip = getByTestId(document.body, 'library-facet-chip-communication');
    expect(communicationChip?.getAttribute('aria-checked')).toBe('true');

    const researchChip = document.body.querySelector('[data-testid="library-facet-chip-research"]');
    if (!(researchChip instanceof HTMLElement)) {
      throw new Error('Research facet chip not found');
    }
    click(researchChip);

    expect(mounted.setBrowseLens).toHaveBeenCalledTimes(1);
    const selectFacetUpdater = mounted.setBrowseLens.mock.calls[0][0] as (prev: LibraryLens) => LibraryLens;
    expect(selectFacetUpdater({
      filter: 'skills',
      view: 'cards',
      facet: 'communication',
    })).toEqual({
      filter: 'skills',
      view: 'cards',
      facet: 'research',
    });
    expect(document.body.querySelector('[data-testid="library-filter-popover"]')).toBeNull();

    click(trigger);
    const allChip = document.body.querySelector('[data-testid="library-facet-chip-all"]');
    if (!(allChip instanceof HTMLElement)) {
      throw new Error('All facet chip not found');
    }
    click(allChip);

    expect(mounted.setBrowseLens).toHaveBeenCalledTimes(2);
    const clearFacetUpdater = mounted.setBrowseLens.mock.calls[1][0] as (prev: LibraryLens) => LibraryLens;
    expect(clearFacetUpdater({
      filter: 'skills',
      view: 'cards',
      facet: 'research',
    })).toEqual({
      filter: 'skills',
      view: 'cards',
      facet: undefined,
    });
    expect(document.body.querySelector('[data-testid="library-filter-popover"]')).toBeNull();

    mounted.unmount();
  });

  it('does not render filter trigger when facets are only "all"', () => {
    const mounted = renderLensBar({
      lens: { filter: 'skills', view: 'cards' },
      facets: [
        { id: 'all', label: 'All', count: 10, ariaLabel: 'Show all', tooltip: 'All · 10 skills' },
      ],
      orientationTipDismissed: true,
    });

    expect(mounted.container.querySelector('[data-testid="library-filter-trigger"]')).toBeNull();

    mounted.unmount();
  });

  it('sets aria-expanded and aria-haspopup on the filter trigger', () => {
    const mounted = renderLensBar({
      lens: { filter: 'skills', view: 'cards' },
      facets: [
        { id: 'all', label: 'All', count: 10, ariaLabel: 'Show all', tooltip: 'All · 10 skills' },
        {
          id: 'communication',
          label: 'Communication',
          count: 6,
          ariaLabel: 'Show communication skills',
          tooltip: 'Communication · 6 skills',
        },
      ],
      orientationTipDismissed: true,
    });

    const trigger = getByTestId(mounted.container, 'library-filter-trigger');
    expect(trigger.getAttribute('aria-haspopup')).toBe('dialog');
    expect(trigger.getAttribute('aria-expanded')).toBe('false');

    click(trigger);
    expect(trigger.getAttribute('aria-expanded')).toBe('true');

    mounted.unmount();
  });

  it('normalizes stale sort state when the active view changes', () => {
    const mounted = renderLensBar({
      lens: { filter: 'spaces', view: 'cards' },
      sortBy: 'recent',
      orientationTipDismissed: true,
    });

    expect(mounted.onSortByChange).toHaveBeenCalledWith('name');

    mounted.rerender(
      <LibraryLensBar
        {...mounted.props}
        lens={{ filter: 'spaces', view: 'folders' }}
        sortBy="recent"
      />,
    );

    expect(mounted.onSortByChange).toHaveBeenCalledTimes(1);
    expect(mounted.onSortByChange).toHaveBeenCalledWith('name');

    mounted.unmount();
  });

  it('resets sort to the destination filter default when filters switch', () => {
    const mounted = renderLensBar({
      lens: { filter: 'spaces', view: 'cards' },
      sortBy: 'name',
      orientationTipDismissed: true,
    });
    expect(mounted.onSortByChange).not.toHaveBeenCalled();

    mounted.rerender(
      <LibraryLensBar
        {...mounted.props}
        lens={{ filter: 'memory', view: 'cards' }}
        sortBy="name"
      />,
    );

    expect(mounted.onSortByChange).toHaveBeenCalledTimes(1);
    expect(mounted.onSortByChange).toHaveBeenCalledWith('recent');

    mounted.unmount();
  });

  it('resets sort to the lens default when the view changes within the same filter (Memory folders → cards)', () => {
    const mounted = renderLensBar({
      lens: { filter: 'memory', view: 'folders' },
      sortBy: 'name',
      orientationTipDismissed: true,
    });
    expect(mounted.onSortByChange).not.toHaveBeenCalled();

    mounted.rerender(
      <LibraryLensBar
        {...mounted.props}
        lens={{ filter: 'memory', view: 'cards' }}
        sortBy="name"
      />,
    );

    expect(mounted.onSortByChange).toHaveBeenCalledTimes(1);
    expect(mounted.onSortByChange).toHaveBeenCalledWith('recent');

    mounted.unmount();
  });

  it("preserves user sort when only the search query changes", () => {
    const mounted = renderLensBar({
      lens: { filter: 'memory', view: 'cards' },
      sortBy: 'recent',
      orientationTipDismissed: true,
    });
    expect(mounted.onSortByChange).not.toHaveBeenCalled();

    mounted.rerender(
      <LibraryLensBar
        {...mounted.props}
        searchQuery="weekly summary"
        sortBy="recent"
      />,
    );

    expect(mounted.onSortByChange).not.toHaveBeenCalled();

    mounted.unmount();
  });

  it('resets to filter default sort on first mount for memory when persisted sort is alphabetical', () => {
    const mounted = renderLensBar({
      lens: { filter: 'memory', view: 'cards' },
      sortBy: 'name',
      orientationTipDismissed: true,
    });

    expect(mounted.onSortByChange).toHaveBeenCalledTimes(1);
    expect(mounted.onSortByChange).toHaveBeenCalledWith('recent');

    mounted.unmount();
  });

  it('shows filter-aware sort options for cards view', () => {
    const mounted = renderLensBar({
      lens: { filter: 'skills', view: 'cards' },
      sortBy: 'name',
      orientationTipDismissed: true,
    });

    const options = Array.from(
      mounted.container.querySelectorAll('[data-testid="library-lens-sort-select"] option'),
    ).map((option) => option.textContent?.trim());
    expect(options).toEqual(['Suggested', 'Most used', 'Most polished', 'A-Z']);

    mounted.rerender(
      <LibraryLensBar
        {...mounted.props}
        lens={{ filter: 'memory', view: 'cards' }}
        sortBy="name"
      />,
    );
    const memoryOptions = Array.from(
      mounted.container.querySelectorAll('[data-testid="library-lens-sort-select"] option'),
    ).map((option) => option.textContent?.trim());
    expect(memoryOptions).toEqual(['Most recent', 'Date created', 'Alphabetical']);

    mounted.rerender(
      <LibraryLensBar
        {...mounted.props}
        lens={{ filter: 'memory', view: 'cards' }}
        searchQuery="weekly"
        sortBy="name"
      />,
    );
    const memorySearchOptions = Array.from(
      mounted.container.querySelectorAll('[data-testid="library-lens-sort-select"] option'),
    ).map((option) => option.textContent?.trim());
    expect(memorySearchOptions).toEqual([
      'Most relevant',
      'Most recent',
      'Date created',
      'Alphabetical',
    ]);

    mounted.unmount();
  });

  it('supports arrow-key navigation across segmented chips', () => {
    const mounted = renderLensBar({
      lens: { filter: 'spaces', view: 'folders' },
      orientationTipDismissed: true,
    });

    const spacesChip = mounted.container.querySelector('[data-testid="library-filter-chip-spaces"]') as HTMLButtonElement | null;
    expect(spacesChip).toBeTruthy();

    act(() => {
      spacesChip?.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    });

    expect(mounted.setBrowseLens).toHaveBeenCalledTimes(1);
    const updater = mounted.setBrowseLens.mock.calls[0][0] as (prev: LibraryLens) => LibraryLens;
    // Filter order is now spaces, plugins, skills, memory, everything (260521 v3.1).
    expect(updater({ filter: 'spaces', view: 'folders' })).toEqual({
      filter: 'plugins',
      view: 'folders',
      facet: undefined,
    });

    mounted.unmount();
  });

  it('keeps orientation guidance screen-reader only (no visible Notice chrome)', () => {
    const mounted = renderLensBar({ orientationTipDismissed: false });

    expect(mounted.container.querySelector('[data-testid="library-orientation-tip"]')).toBeNull();
    expect(mounted.container.querySelector('button[aria-label="Dismiss notice"]')).toBeNull();
    expect(mounted.dismissOrientationTip).not.toHaveBeenCalled();

    mounted.unmount();
  });

  it('renders live sentence + transient suffix and clears suffix after timeout', () => {
    vi.useFakeTimers();
    const mounted = renderLensBar({
      lens: { filter: 'spaces', view: 'folders' },
      orientationTipDismissed: true,
      revealedFoldersCount: 3,
    });

    const sentence = mounted.container.querySelector('[data-testid="library-lens-sentence"]');
    expect(sentence?.getAttribute('role')).toBe('status');
    expect(sentence?.getAttribute('aria-live')).toBe('polite');
    expect(sentence?.textContent).toContain('Showing Spaces as Folders');
    expect(sentence?.textContent).toContain('3 more folders revealed');

    act(() => {
      vi.advanceTimersByTime(3300);
    });

    expect(sentence?.textContent).not.toContain('3 more folders revealed');

    mounted.unmount();
  });

  it('hides sort dropdown when view is atlas', () => {
    const mounted = renderLensBar({
      lens: { filter: 'everything', view: 'atlas' },
      orientationTipDismissed: true,
    });

    expect(mounted.container.querySelector('[data-testid="library-lens-sort-select"]')).toBeNull();

    mounted.unmount();
  });

  it('applies the chip-owned focus outline style', () => {
    const mounted = renderLensBar({
      lens: { filter: 'spaces', view: 'folders' },
      orientationTipDismissed: true,
    });

    const chip = getByTestId(mounted.container, 'library-filter-chip-everything') as HTMLButtonElement;
    act(() => {
      chip.focus();
    });

    const style = window.getComputedStyle(chip);
    expect(document.activeElement).toBe(chip);
    const outlineWidth = style.outlineWidth || '2px';
    const outlineStyle = style.outlineStyle || 'solid';
    const boxShadow = style.boxShadow || 'none';
    const outlineColor = style.outlineColor || 'var(--color-brand-indigo)';
    expect(outlineWidth).toBe('2px');
    expect(outlineStyle).toBe('solid');
    expect(boxShadow).toBe('none');
    expect(
      outlineColor === 'var(--color-brand-indigo)'
      || outlineColor.startsWith('rgb('),
    ).toBe(true);

    mounted.unmount();
  });
});
