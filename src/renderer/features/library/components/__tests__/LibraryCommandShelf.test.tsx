// @vitest-environment happy-dom

import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AppSettings } from '@shared/types';
import { LibraryCommandShelf } from '../LibraryCommandShelf';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const BASE_SETTINGS = {
  coreDirectory: '/workspace',
} as AppSettings;

type Mounted = {
  container: HTMLDivElement;
  root: Root;
  props: React.ComponentProps<typeof LibraryCommandShelf>;
  unmount: () => void;
};

function mountShelf(overrides?: Partial<React.ComponentProps<typeof LibraryCommandShelf>>): Mounted {
  const props: React.ComponentProps<typeof LibraryCommandShelf> = {
    lens: { filter: 'everything', view: 'cards' },
    searchQuery: '',
    onSearchChange: vi.fn(),
    searchDisabled: false,
    sortBy: 'name',
    setBrowseLens: vi.fn(),
    onSortByChange: vi.fn(),
    orientationTipDismissed: true,
    dismissOrientationTip: vi.fn(),
    settings: BASE_SETTINGS,
    selectedWorkspaceItem: null,
    showHiddenFiles: false,
    onToggleHiddenFiles: vi.fn(),
    onRefresh: vi.fn(),
    refreshDisabled: false,
    onCreateFile: vi.fn(),
    onCreateFolder: vi.fn(),
    onCreateSkill: vi.fn(),
    onCreateMemory: vi.fn(),
    onAddSpace: vi.fn(),
    canCreateAdditionalSpaces: true,
    createActionPending: false,
    hasRecentFiles: false,
    recentDrawerOpen: false,
    onToggleRecentDrawer: vi.fn(),
    workspaceDirectoryLabel: '/workspace',
    filesLabel: '0 files',
    syncLabel: 'Synced',
    indexedFilesLabel: '0 files indexed',
    indexedFilesCount: 0,
    totalFilesCount: 0,
    pendingFilesCount: 0,
    isIndexing: false,
    isIndexWatching: true,
    onPauseResumeIndex: vi.fn(),
    onDeleteIndex: vi.fn(),
    onReindex: vi.fn(),
    enhancementProgress: { totalChunks: 0, enhancedChunks: 0, isRunning: false, isPaused: false },
    onPauseResumeEnhancement: vi.fn(),
    onStartEnhancement: vi.fn(),
    hasApiKey: false,
    lastIndexedAt: null,
    indexState: 'not_started',
    isChiefActive: false,
    ...overrides,
  };

  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(<LibraryCommandShelf {...props} />);
  });

  return {
    container,
    root,
    props,
    unmount: () => {
      act(() => {
        root.unmount();
      });
      container.remove();
    },
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

describe('LibraryCommandShelf', () => {
  let mounted: Mounted | null = null;

  afterEach(() => {
    mounted?.unmount();
    mounted = null;
    document.body.innerHTML = '';
    vi.clearAllMocks();
  });

  it('uses direct New skill action in Skills filter', () => {
    const onCreateSkill = vi.fn();
    mounted = mountShelf({
      lens: { filter: 'skills', view: 'cards' },
      onCreateSkill,
    });

    const primaryButton = mounted.container.querySelector('[data-testid="library-create-menu-button"]');
    expect(primaryButton?.textContent).toContain('New skill');
    click(primaryButton);
    expect(onCreateSkill).toHaveBeenCalledTimes(1);
    expect(document.querySelector('[data-testid="library-create-file-option"]')).toBeNull();
  });

  it('uses direct Add memory action in Memory filter', () => {
    const onCreateMemory = vi.fn();
    mounted = mountShelf({
      lens: { filter: 'memory', view: 'cards' },
      onCreateMemory,
    });

    const primaryButton = mounted.container.querySelector('[data-testid="library-create-menu-button"]');
    expect(primaryButton?.textContent).toContain('Add memory');
    click(primaryButton);
    expect(onCreateMemory).toHaveBeenCalledTimes(1);
  });

  it('disables direct create while a library create action is pending', () => {
    const onCreateMemory = vi.fn();
    mounted = mountShelf({
      lens: { filter: 'memory', view: 'cards' },
      onCreateMemory,
      createActionPending: true,
    });

    const primaryButton = mounted.container.querySelector('[data-testid="library-create-menu-button"]');
    expect((primaryButton as HTMLButtonElement | null)?.disabled).toBe(true);
    act(() => {
      (primaryButton as HTMLButtonElement | null)?.click();
    });
    expect(onCreateMemory).not.toHaveBeenCalled();
  });

  it('uses direct Add space action in Spaces filter', () => {
    const onAddSpace = vi.fn();
    mounted = mountShelf({
      lens: { filter: 'spaces', view: 'cards' },
      onAddSpace,
    });

    const primaryButton = mounted.container.querySelector('[data-testid="library-create-menu-button"]');
    expect(primaryButton?.textContent).toContain('Add space');
    click(primaryButton);
    expect(onAddSpace).toHaveBeenCalledTimes(1);
  });

  it('disables Add space when entitlement is unavailable', () => {
    const onAddSpace = vi.fn();
    mounted = mountShelf({
      lens: { filter: 'spaces', view: 'cards' },
      onAddSpace,
      canCreateAdditionalSpaces: false,
    });

    const primaryButton = mounted.container.querySelector('[data-testid="library-create-menu-button"]');
    expect(primaryButton?.textContent).toContain('Add space');
    expect((primaryButton as HTMLButtonElement | null)?.disabled).toBe(true);
    act(() => {
      (primaryButton as HTMLButtonElement | null)?.click();
    });
    expect(onAddSpace).not.toHaveBeenCalled();
  });

  it('keeps New menu behavior in Everything filter', () => {
    const onCreateFile = vi.fn();
    mounted = mountShelf({
      lens: { filter: 'everything', view: 'cards' },
      onCreateFile,
    });

    const primaryButton = mounted.container.querySelector('[data-testid="library-create-menu-button"]');
    expect(primaryButton?.textContent).toContain('New');
    expect(primaryButton?.getAttribute('aria-haspopup')).toBe('menu');
    click(primaryButton);
    expect(onCreateFile).toHaveBeenCalledTimes(0);
  });

  it('orders secondary actions as info before refresh', () => {
    mounted = mountShelf();

    const infoButton = mounted.container.querySelector('[data-testid="library-overflow-inline-info"]');
    const refreshButton = mounted.container.querySelector('[data-testid="library-overflow-inline-refresh"]');
    expect(infoButton).toBeTruthy();
    expect(refreshButton).toBeTruthy();
    if (!(infoButton instanceof Element) || !(refreshButton instanceof Element)) {
      throw new Error('Expected info and refresh buttons');
    }
    expect(infoButton.compareDocumentPosition(refreshButton) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0);
  });
});
