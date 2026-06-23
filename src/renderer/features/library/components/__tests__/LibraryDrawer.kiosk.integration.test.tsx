// @vitest-environment happy-dom

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import React, { act, createRef } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AppSettings } from '@shared/types';
import { LibraryDrawer, type LibraryDrawerHandle } from '../LibraryDrawer';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('@renderer/utils/librarySearch', () => ({
  addRecentFile: vi.fn(),
  getRecentFiles: vi.fn(() => []),
}));

vi.mock('@renderer/src/tracking', () => ({
  tracking: {
    library: {
      opened: vi.fn(),
    },
  },
}));

vi.mock('../../providers/LibraryNavigatorProvider', () => ({
  LibraryNavigatorProvider: ({
    children,
    onBrowseLensInteraction,
  }: {
    children: React.ReactNode;
    onBrowseLensInteraction?: () => void;
  }) => (
    <div data-testid="mock-library-provider">
      <button
        type="button"
        data-testid="mock-lens-chip"
        onClick={() => onBrowseLensInteraction?.()}
      >
        Lens chip
      </button>
      <input data-testid="mock-library-search-input" />
      {children}
    </div>
  ),
  useLibraryNavigator: () => ({
    getSkillExamplePaths: () => undefined,
    getSkillQualityData: () => undefined,
    getSkillMetadata: () => undefined,
  }),
}));

vi.mock('../LibraryNavigator', () => ({
  LibraryNavigator: ({ kioskLevel }: { kioskLevel?: string }) => (
    <div data-testid="mock-library-navigator" data-kiosk-level={kioskLevel}>
      <button type="button" data-testid="mock-tree-item">
        Tree item
      </button>
    </div>
  ),
}));

vi.mock('../LibraryDialogs', () => ({
  LibraryDialogs: () => <div data-testid="mock-library-dialogs" />,
}));

vi.mock('../RenameFileDialog', () => ({
  RenameFileDialog: () => null,
}));

vi.mock('@renderer/features/document-editor', async () => {
  const ReactLocal = await vi.importActual<typeof import('react')>('react');

  type MockEditorProps = {
    onToggleKioskMode?: () => void;
    onActiveDocumentChange?: (path: string | null) => void;
  };

  const MockEditor = ReactLocal.forwardRef((props: MockEditorProps, ref) => {
    const activePathRef = ReactLocal.useRef<string | null>(null);

    ReactLocal.useImperativeHandle(ref, () => ({
      openDocument: async (path: string) => {
        activePathRef.current = path;
        props.onActiveDocumentChange?.(path);
        return true;
      },
      closeAllDocuments: async () => {
        activePathRef.current = null;
        props.onActiveDocumentChange?.(null);
        return true;
      },
      getActiveDocumentPath: () => activePathRef.current,
    }));

    return (
      <div data-testid="mock-unified-document-editor">
        <button
          type="button"
          data-testid="mock-kiosk-toggle"
          onClick={() => props.onToggleKioskMode?.()}
        >
          Toggle kiosk
        </button>
      </div>
    );
  });
  MockEditor.displayName = 'MockUnifiedDocumentEditor';

  return {
    UnifiedDocumentEditor: MockEditor,
  };
});

type Mounted = {
  container: HTMLDivElement;
  root: Root;
  drawerRef: React.RefObject<LibraryDrawerHandle | null>;
  unmount: () => void;
};

function mountDrawer({
  floatingEditorMode = false,
}: {
  floatingEditorMode?: boolean;
} = {}): Mounted {
  const container = document.createElement('div');
  if (floatingEditorMode) {
    container.classList.add('app-shell--library-editor-open');
  }
  document.body.appendChild(container);
  const root = createRoot(container);
  const drawerRef = createRef<LibraryDrawerHandle>();

  act(() => {
    root.render(
      <LibraryDrawer
        ref={drawerRef}
        open
        settings={{ coreDirectory: '/workspace' } as AppSettings}
        showToast={vi.fn()}
        emitLog={vi.fn()}
        floatingEditorMode={floatingEditorMode}
      />,
    );
  });

  return {
    container,
    root,
    drawerRef,
    unmount: () => {
      act(() => root.unmount());
      container.remove();
    },
  };
}

function getDrawerKioskLevel(container: HTMLDivElement): string | null {
  return container.querySelector('[data-testid="library-drawer"]')?.getAttribute('data-kiosk-level') ?? null;
}

function getResizeHandle(container: HTMLDivElement): HTMLDivElement | null {
  const handle = container.querySelector('[data-testid="library-resize-handle"]');
  return handle instanceof HTMLDivElement ? handle : null;
}

function getNavigatorPane(container: HTMLDivElement): HTMLDivElement | null {
  const pane = container.querySelector('[data-testid="library-navigator-pane"]');
  return pane instanceof HTMLDivElement ? pane : null;
}

function getNavigatorWidthPercent(container: HTMLDivElement): number {
  const pane = getNavigatorPane(container);
  if (!pane) {
    throw new Error('Navigator pane was not rendered');
  }
  const flex = pane.style.flex;
  const match = flex.match(/([0-9.]+)%/);
  if (!match) {
    throw new Error(`Navigator pane flex did not contain a percentage: "${flex}"`);
  }
  return parseFloat(match[1]);
}

async function openEditor(mounted: Mounted): Promise<void> {
  await act(async () => {
    await mounted.drawerRef.current?.openFile('/workspace/notes.md');
  });
}

describe('LibraryDrawer kiosk integration', () => {
  let mounted: Mounted | null = null;

  afterEach(() => {
    mounted?.unmount();
    mounted = null;
    document.body.innerHTML = '';
    localStorage.clear();
    vi.clearAllMocks();
  });

  it('uses wide-rail CSS bounds that permit resizing', () => {
    const cssPath = join(
      process.cwd(),
      'src/renderer/features/library/components/LibrarySplitLayout.module.css',
    );
    const css = readFileSync(cssPath, 'utf8');
    expect(css).toContain(".splitLayout[data-editor-open='true'][data-kiosk-level='wide'] .navigatorPane");
    expect(css).toContain('min-width: 160px;');
    expect(css).toContain('max-width: 45%;');
    expect(css).not.toContain('min-width: var(--library-kiosk-rail-width);');
    expect(css).not.toContain('max-width: var(--library-kiosk-rail-width);');
  });

  it('uses spacing tokens for the main truncation notice margin', () => {
    const cssPath = join(
      process.cwd(),
      'src/renderer/features/library/components/LibraryDrawer.module.css',
    );
    const css = readFileSync(cssPath, 'utf8');
    const mainNoticeRule = css.match(/\.mainTruncationNotice\s*\{[^}]*\}/);

    expect(mainNoticeRule?.[0]).toContain('margin: 0 0 var(--space-2);');
    expect(mainNoticeRule?.[0]).not.toContain('margin: 0 0 8px;');
  });

  it('mounts the extracted split layout with navigator and editor panes for a typical open file', async () => {
    mounted = mountDrawer();
    await openEditor(mounted);

    expect(mounted.container.querySelector('[data-testid="mock-library-provider"]')).not.toBeNull();
    expect(mounted.container.querySelector('[data-testid="library-drawer"]')).not.toBeNull();
    expect(getNavigatorPane(mounted.container)).not.toBeNull();
    expect(mounted.container.querySelector('[data-testid="mock-library-navigator"]')).not.toBeNull();
    expect(mounted.container.querySelector('[data-testid="mock-library-dialogs"]')).not.toBeNull();
    expect(mounted.container.querySelector('[data-testid="mock-unified-document-editor"]')).not.toBeNull();
    expect(getResizeHandle(mounted.container)).not.toBeNull();
  });

  it('clears wide kiosk when a lens-bar interaction occurs', async () => {
    mounted = mountDrawer();
    await openEditor(mounted);

    expect(getDrawerKioskLevel(mounted.container)).toBe('off');

    const kioskToggle = mounted.container.querySelector('[data-testid="mock-kiosk-toggle"]');
    act(() => {
      kioskToggle?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(getDrawerKioskLevel(mounted.container)).toBe('wide');

    const lensChip = mounted.container.querySelector('[data-testid="mock-lens-chip"]');
    act(() => {
      lensChip?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(getDrawerKioskLevel(mounted.container)).toBe('off');
  });

  it('exits kiosk on Escape when focus is in the tree rail', async () => {
    mounted = mountDrawer();
    await openEditor(mounted);

    const kioskToggle = mounted.container.querySelector('[data-testid="mock-kiosk-toggle"]');
    act(() => {
      kioskToggle?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(getDrawerKioskLevel(mounted.container)).toBe('wide');

    const treeItem = mounted.container.querySelector('[data-testid="mock-tree-item"]');
    if (!(treeItem instanceof HTMLButtonElement)) {
      throw new Error('Tree item was not rendered');
    }

    act(() => {
      treeItem.focus();
    });
    expect(document.activeElement).toBe(treeItem);

    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });

    expect(getDrawerKioskLevel(mounted.container)).toBe('off');
  });

  it('does not steal Escape from the search input while kiosk is active', async () => {
    mounted = mountDrawer();
    await openEditor(mounted);

    const kioskToggle = mounted.container.querySelector('[data-testid="mock-kiosk-toggle"]');
    act(() => {
      kioskToggle?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(getDrawerKioskLevel(mounted.container)).toBe('wide');

    const searchInput = mounted.container.querySelector('[data-testid="mock-library-search-input"]');
    if (!(searchInput instanceof HTMLInputElement)) {
      throw new Error('Search input was not rendered');
    }

    act(() => {
      searchInput.focus();
    });
    expect(document.activeElement).toBe(searchInput);

    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });

    expect(getDrawerKioskLevel(mounted.container)).toBe('wide');
  });

  it('shows the resize handle in off and wide kiosk levels, but hides it in zen', async () => {
    mounted = mountDrawer();
    await openEditor(mounted);

    expect(getResizeHandle(mounted.container)).not.toBeNull();

    const kioskToggle = mounted.container.querySelector('[data-testid="mock-kiosk-toggle"]');
    act(() => {
      kioskToggle?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(getDrawerKioskLevel(mounted.container)).toBe('wide');
    expect(getResizeHandle(mounted.container)).not.toBeNull();

    act(() => {
      kioskToggle?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(getDrawerKioskLevel(mounted.container)).toBe('zen');
    expect(getResizeHandle(mounted.container)).toBeNull();
  });

  it('keeps wide-mode resize available while editor is floating', async () => {
    mounted = mountDrawer({ floatingEditorMode: true });
    await openEditor(mounted);
    expect(mounted.container.classList.contains('app-shell--library-editor-open')).toBe(true);

    const offPane = getNavigatorPane(mounted.container);
    expect(offPane?.style.flex ?? '').toBe('');
    expect(getResizeHandle(mounted.container)).not.toBeNull();

    const kioskToggle = mounted.container.querySelector('[data-testid="mock-kiosk-toggle"]');
    act(() => {
      kioskToggle?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(getDrawerKioskLevel(mounted.container)).toBe('wide');
    expect(getResizeHandle(mounted.container)).not.toBeNull();
    expect(getNavigatorWidthPercent(mounted.container)).toBeCloseTo(22, 1);
  });

  it('uses default focus width, persists drag resizing in wide mode, and restores on remount', async () => {
    localStorage.removeItem('library:navigator-width-focus');

    mounted = mountDrawer();
    await openEditor(mounted);

    const kioskToggle = mounted.container.querySelector('[data-testid="mock-kiosk-toggle"]');
    act(() => {
      kioskToggle?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(getDrawerKioskLevel(mounted.container)).toBe('wide');
    expect(getNavigatorWidthPercent(mounted.container)).toBeCloseTo(22, 1);

    const drawer = mounted.container.querySelector('[data-testid="library-drawer"]');
    if (!(drawer instanceof HTMLDivElement)) {
      throw new Error('Library drawer was not rendered');
    }
    Object.defineProperty(drawer, 'getBoundingClientRect', {
      configurable: true,
      value: () => ({
        x: 0,
        y: 0,
        top: 0,
        left: 0,
        right: 1000,
        bottom: 700,
        width: 1000,
        height: 700,
        toJSON: () => ({}),
      }),
    });

    const resizeHandle = getResizeHandle(mounted.container);
    if (!resizeHandle) {
      throw new Error('Resize handle was not rendered in wide mode');
    }

    act(() => {
      resizeHandle.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, clientX: 200 }));
    });
    act(() => {
      document.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: 300 }));
    });
    act(() => {
      document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    });

    const resizedPercent = getNavigatorWidthPercent(mounted.container);
    expect(resizedPercent).toBeCloseTo(32, 1);
    expect(parseFloat(localStorage.getItem('library:navigator-width-focus') ?? '')).toBeCloseTo(32, 1);

    mounted.unmount();
    mounted = mountDrawer();
    await openEditor(mounted);

    const remountToggle = mounted.container.querySelector('[data-testid="mock-kiosk-toggle"]');
    act(() => {
      remountToggle?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(getDrawerKioskLevel(mounted.container)).toBe('wide');
    expect(getNavigatorWidthPercent(mounted.container)).toBeCloseTo(32, 1);
  });

  it('resets focus-mode and normal-mode widths to defaults from the resize handle', async () => {
    localStorage.setItem('library-split-width', '61');
    localStorage.setItem('library:navigator-width-focus', '34');

    mounted = mountDrawer();
    await openEditor(mounted);

    expect(getNavigatorWidthPercent(mounted.container)).toBeCloseTo(61, 1);

    const offHandle = getResizeHandle(mounted.container);
    if (!offHandle) {
      throw new Error('Resize handle was not rendered in off mode');
    }
    act(() => {
      offHandle.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true }));
    });
    expect(getNavigatorWidthPercent(mounted.container)).toBeCloseTo(50, 1);
    expect(localStorage.getItem('library-split-width')).toBe('50');

    const kioskToggle = mounted.container.querySelector('[data-testid="mock-kiosk-toggle"]');
    act(() => {
      kioskToggle?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(getDrawerKioskLevel(mounted.container)).toBe('wide');
    expect(getNavigatorWidthPercent(mounted.container)).toBeCloseTo(34, 1);

    const wideHandle = getResizeHandle(mounted.container);
    if (!wideHandle) {
      throw new Error('Resize handle was not rendered in wide mode');
    }
    act(() => {
      wideHandle.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    });
    expect(getNavigatorWidthPercent(mounted.container)).toBeCloseTo(22, 1);
    expect(localStorage.getItem('library:navigator-width-focus')).toBe('22');
  });
});
