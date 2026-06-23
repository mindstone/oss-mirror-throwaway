// @vitest-environment happy-dom

import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FlowPanelsProvider, useFlowPanels } from '../FlowPanelsProvider';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type FlowPanelsContextSnapshot = ReturnType<typeof useFlowPanels>;

type MountedProvider = {
  getCtx: () => FlowPanelsContextSnapshot;
  unmount: () => void;
};

const mountedProviders: MountedProvider[] = [];

function renderWithProvider(): MountedProvider {
  let ctx: FlowPanelsContextSnapshot | null = null;

  function ContextCapture() {
    ctx = useFlowPanels();
    return null;
  }

  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);

  act(() => {
    root.render(
      <FlowPanelsProvider>
        <ContextCapture />
      </FlowPanelsProvider>,
    );
  });

  const mounted: MountedProvider = {
    getCtx: () => {
      if (!ctx) {
        throw new Error('FlowPanels context was not captured');
      }
      return ctx;
    },
    unmount: () => {
      act(() => {
        root.unmount();
      });
      container.remove();
    },
  };

  mountedProviders.push(mounted);
  return mounted;
}

function expectPendingLens(
  mounted: MountedProvider,
  expectedLens: Record<string, unknown>,
) {
  const pending = mounted.getCtx().pendingLibraryNavigation;
  expect(pending).not.toBeNull();
  expect(pending?.lens).toEqual(expectedLens);
}

describe('FlowPanelsProvider library lens navigation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.localStorage.clear();
  });

  afterEach(() => {
    while (mountedProviders.length > 0) {
      mountedProviders.pop()?.unmount();
    }
    window.localStorage.clear();
    vi.restoreAllMocks();
  });

  it('sets pending library navigation and switches to the library surface', () => {
    const mounted = renderWithProvider();

    expect(mounted.getCtx().activeSurface).toBe('home');

    act(() => {
      mounted.getCtx().navigateToLibraryLens({ filter: 'spaces' });
    });

    expectPendingLens(mounted, { filter: 'spaces' });
    expect(mounted.getCtx().activeSurface).toBe('library');
  });

  it('passes through library-navigation options without legacy tab metadata', () => {
    const mounted = renderWithProvider();

    act(() => {
      mounted.getCtx().navigateToLibraryLens(
        { filter: 'spaces', view: 'atlas' },
        {
          folderPath: 'Chief-of-Staff',
          spaceFilter: 'Team Alpha',
          expandIndexingPanel: true,
          revealInTree: true,
        },
      );
    });

    const pending = mounted.getCtx().pendingLibraryNavigation;
    expect(pending).toEqual({
      lens: { filter: 'spaces', view: 'atlas' },
      folderPath: 'Chief-of-Staff',
      spaceFilter: 'Team Alpha',
      expandIndexingPanel: true,
      revealInTree: true,
    });
  });

  it('navigateToLibraryLens with only filter preserves the current view', () => {
    const mounted = renderWithProvider();

    act(() => {
      mounted.getCtx().navigateToLibraryLens({ filter: 'everything' });
    });

    const pending = mounted.getCtx().pendingLibraryNavigation;
    expect(pending).not.toBeNull();
    expect(pending?.lens.filter).toBe('everything');
    expect(pending?.lens.view).toBeUndefined();
  });

  it('clearPendingLibraryNavigation resets pending state', () => {
    const mounted = renderWithProvider();

    act(() => {
      mounted.getCtx().navigateToLibraryLens({ filter: 'skills', view: 'folders' });
    });

    expect(mounted.getCtx().pendingLibraryNavigation).not.toBeNull();

    act(() => {
      mounted.getCtx().clearPendingLibraryNavigation();
    });

    expect(mounted.getCtx().pendingLibraryNavigation).toBeNull();
  });
});
