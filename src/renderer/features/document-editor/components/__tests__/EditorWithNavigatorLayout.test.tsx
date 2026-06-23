// @vitest-environment happy-dom

import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EditorWithNavigatorLayout, type EditorWithNavigatorLayoutProps } from '../EditorWithNavigatorLayout';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type MountedLayout = {
  root: Root;
  container: HTMLDivElement;
  render: (overrides?: Partial<EditorWithNavigatorLayoutProps>) => void;
};

function getDefaultProps(): EditorWithNavigatorLayoutProps {
  return {
    navigator: <div data-testid="navigator-slot">Navigator</div>,
    editor: <div data-testid="editor-slot">Editor</div>,
    editorHasDocuments: true,
    kioskLevel: 'off',
    navigatorWidthPercent: 50,
    focusNavigatorWidthPercent: 22,
    floatingEditorMode: false,
    isResizing: false,
    onResizeMouseDown: vi.fn(),
    onResizeDoubleClick: vi.fn(),
    onResizeContextMenu: vi.fn(),
  };
}

describe('EditorWithNavigatorLayout', () => {
  let mounted: MountedLayout;

  beforeEach(() => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    const baseProps = getDefaultProps();

    mounted = {
      root,
      container,
      render(overrides) {
        act(() => {
          root.render(
            <EditorWithNavigatorLayout
              {...baseProps}
              {...overrides}
            />,
          );
        });
      },
    };
  });

  afterEach(() => {
    act(() => {
      mounted.root.unmount();
    });
    mounted.container.remove();
    vi.clearAllMocks();
  });

  it('renders navigator and editor slots with layout data attributes', () => {
    mounted.render();

    const layout = mounted.container.querySelector('[data-testid="editor-with-navigator-layout"]');
    const navigatorPane = mounted.container.querySelector('[data-testid="editor-navigator-pane"]');
    const resizeHandle = mounted.container.querySelector('[data-testid="editor-navigator-resize-handle"]');
    const editorSlot = mounted.container.querySelector('[data-testid="editor-slot"]');

    expect(layout).not.toBeNull();
    expect(layout?.getAttribute('data-editor-open')).toBe('true');
    expect(layout?.getAttribute('data-focus-mode')).toBe('false');
    expect(layout?.getAttribute('data-kiosk-level')).toBe('off');
    expect(navigatorPane).not.toBeNull();
    expect(navigatorPane?.querySelector('[data-testid="navigator-slot"]')).not.toBeNull();
    expect(resizeHandle).not.toBeNull();
    expect(editorSlot).not.toBeNull();
  });

  it('shows/hides navigator and resize handle based on kiosk level', () => {
    mounted.render({ kioskLevel: 'off' });
    expect(mounted.container.querySelector('[data-testid="editor-navigator-pane"]')).not.toBeNull();
    expect(mounted.container.querySelector('[data-testid="editor-navigator-resize-handle"]')).not.toBeNull();

    mounted.render({ kioskLevel: 'wide' });
    expect(mounted.container.querySelector('[data-testid="editor-navigator-pane"]')).not.toBeNull();
    expect(mounted.container.querySelector('[data-testid="editor-navigator-resize-handle"]')).not.toBeNull();

    mounted.render({ kioskLevel: 'zen' });
    expect(mounted.container.querySelector('[data-testid="editor-navigator-pane"]')).toBeNull();
    expect(mounted.container.querySelector('[data-testid="editor-navigator-resize-handle"]')).toBeNull();
    expect(mounted.container.querySelector('[data-testid="editor-slot"]')).not.toBeNull();
  });

  it('renders editor-only layout when navigator slot is null', () => {
    mounted.render({ navigator: null });

    expect(mounted.container.querySelector('[data-testid="editor-navigator-pane"]')).toBeNull();
    expect(mounted.container.querySelector('[data-testid="editor-navigator-resize-handle"]')).toBeNull();
    expect(mounted.container.querySelector('[data-testid="editor-slot"]')).not.toBeNull();
  });

  it('uses off/wide width percentages and skips off-width styling when floating', () => {
    mounted.render({ kioskLevel: 'off', floatingEditorMode: false });
    const offPane = mounted.container.querySelector('[data-testid="editor-navigator-pane"]');
    if (!(offPane instanceof HTMLDivElement)) {
      throw new Error('Navigator pane missing in off mode');
    }
    expect(offPane.style.flex).toContain('50%');

    mounted.render({ kioskLevel: 'wide', floatingEditorMode: false });
    const widePane = mounted.container.querySelector('[data-testid="editor-navigator-pane"]');
    if (!(widePane instanceof HTMLDivElement)) {
      throw new Error('Navigator pane missing in wide mode');
    }
    expect(widePane.style.flex).toContain('22%');

    mounted.render({ kioskLevel: 'off', floatingEditorMode: true });
    const floatingOffPane = mounted.container.querySelector('[data-testid="editor-navigator-pane"]');
    if (!(floatingOffPane instanceof HTMLDivElement)) {
      throw new Error('Navigator pane missing in floating off mode');
    }
    expect(floatingOffPane.style.flex).toBe('');
  });
});
