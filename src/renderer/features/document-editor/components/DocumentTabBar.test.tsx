// @vitest-environment happy-dom

import React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DocumentTabBar } from './DocumentTabBar';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

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

describe('DocumentTabBar', () => {
  let mounted: Mounted | null = null;

  afterEach(() => {
    mounted?.unmount();
    mounted = null;
    document.body.innerHTML = '';
  });

  it('renders the open-file button and calls onOpenFileDialog', () => {
    const onOpenFileDialog = vi.fn();
    mounted = mount(
      <DocumentTabBar
        tabs={[{ id: 'a', path: '/tmp/a.md', title: 'a.md' }]}
        activeTabId="a"
        onTabClick={vi.fn()}
        onTabClose={vi.fn()}
        onTabMouseDown={vi.fn()}
        onOpenFileDialog={onOpenFileDialog}
      />,
    );

    const openButton = mounted.container.querySelector('[data-testid="document-tabbar-open-file"]');
    expect(openButton).toBeInstanceOf(HTMLButtonElement);

    act(() => {
      (openButton as HTMLButtonElement).click();
    });

    expect(onOpenFileDialog).toHaveBeenCalledTimes(1);
  });
});
