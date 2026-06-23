// @vitest-environment happy-dom

import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { LibraryView } from '../../../types/lens';
import { makeTreeViewProps } from '../viewFixtures';
import { LibraryViewDispatcher } from '../LibraryViewDispatcher';

vi.mock('../FoldersView', () => ({
  FoldersView: () => <div data-testid="dispatched-folders-view">folders</div>,
}));

vi.mock('../CardsView', () => ({
  CardsView: () => <div data-testid="dispatched-cards-view">cards</div>,
}));

vi.mock('../AtlasView', () => ({
  AtlasView: () => <div data-testid="dispatched-atlas-view">atlas</div>,
}));

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type Mounted = {
  container: HTMLDivElement;
  root: Root;
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
    unmount: () => {
      act(() => {
        root.unmount();
      });
      container.remove();
    },
  };
}

const baseDispatcherProps = {
  foldersProps: {
    filter: 'spaces' as const,
    searchQuery: '',
    tree: [],
    treeViewProps: makeTreeViewProps(),
  },
  cardsProps: {
    filter: 'spaces' as const,
    searchQuery: '',
    sortBy: 'name' as const,
    libraryRootAbsolute: '/workspace',
  },
  atlasProps: {
    filter: 'spaces' as const,
    searchQuery: '',
  },
};

describe('LibraryViewDispatcher', () => {
  let mounted: Mounted | null = null;

  afterEach(() => {
    mounted?.unmount();
    mounted = null;
    document.body.innerHTML = '';
  });

  it.each<readonly [LibraryView, string]>([
    ['folders', 'dispatched-folders-view'],
    ['cards', 'dispatched-cards-view'],
    ['atlas', 'dispatched-atlas-view'],
  ])('renders %s via the matching view component', (view, expectedTestId) => {
    mounted = mount(
      <LibraryViewDispatcher
        view={view}
        {...baseDispatcherProps}
      />,
    );

    expect(mounted.container.querySelector(`[data-testid="${expectedTestId}"]`)).toBeTruthy();
  });

  it('throws for an invalid view discriminant', () => {
    const invalidView = 'invalid-view' as unknown as LibraryView;

    expect(() => {
      mounted = mount(
        <LibraryViewDispatcher
          view={invalidView}
          {...baseDispatcherProps}
        />,
      );
    }).toThrow('Unreachable: unhandled discriminant invalid-view');
  });
});
