// @vitest-environment happy-dom
/**
 * Tests for DoneSubsectionRow — the "Done (N)" disclosure row shown beneath a
 * folder's active conversations. Mirrors FolderHeaderRow's keyboard contract
 * (Enter/Space toggle, ArrowRight expand-when-collapsed, ArrowLeft
 * collapse-when-expanded) and the `e.target !== e.currentTarget` guard.
 */

import { describe, it, expect, vi } from 'vitest';
import React, { act as reactAct } from 'react';
import * as ReactDOMClient from 'react-dom/client';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

import { DoneSubsectionRow } from '../DoneSubsectionRow';

interface RenderResult {
  container: HTMLElement;
  unmount: () => void;
  rerender: (element: React.ReactElement) => void;
}

function renderComponent(element: React.ReactElement): RenderResult {
  const container = document.createElement('div');
  document.body.appendChild(container);
  let root: any;

  reactAct(() => {
    root = ReactDOMClient.createRoot(container);
    root.render(element);
  });

  return {
    container,
    unmount: () => {
      reactAct(() => root.unmount());
      document.body.removeChild(container);
    },
    rerender: (next: React.ReactElement) => {
      reactAct(() => root.render(next));
    },
  };
}

function getWrapper(container: HTMLElement): HTMLElement {
  const wrapper = container.querySelector('[role="button"][aria-expanded]');
  if (!wrapper) throw new Error('Done subsection wrapper not found');
  return wrapper as HTMLElement;
}

const baseProps = {
  folderId: 'folder-1',
  folderName: 'My Folder',
  doneCount: 3,
  isCollapsed: true,
  onToggle: vi.fn(),
};

describe('DoneSubsectionRow', () => {
  it('renders the "Done (N)" label and accessible attributes', () => {
    const { container, unmount } = renderComponent(
      React.createElement(DoneSubsectionRow, { ...baseProps, onToggle: vi.fn() }),
    );

    const wrapper = getWrapper(container);
    expect(wrapper.textContent).toContain('Done (3)');
    expect(wrapper.getAttribute('aria-label')).toBe('Done conversations in My Folder, 3 items');
    expect(wrapper.getAttribute('aria-expanded')).toBe('false');
    expect(wrapper.getAttribute('tabindex')).toBe('0');

    unmount();
  });

  it('reflects aria-expanded=true when expanded', () => {
    const { container, unmount } = renderComponent(
      React.createElement(DoneSubsectionRow, { ...baseProps, isCollapsed: false, onToggle: vi.fn() }),
    );
    const wrapper = getWrapper(container);
    expect(wrapper.getAttribute('aria-expanded')).toBe('true');
    unmount();
  });

  it('toggles on click', () => {
    const onToggle = vi.fn();
    const { container, unmount } = renderComponent(
      React.createElement(DoneSubsectionRow, { ...baseProps, onToggle }),
    );
    const wrapper = getWrapper(container);
    reactAct(() => {
      wrapper.click();
    });
    expect(onToggle).toHaveBeenCalledWith('folder-1');
    unmount();
  });

  it('toggles on Enter and Space pressed on the wrapper', () => {
    const onToggle = vi.fn();
    const { container, unmount } = renderComponent(
      React.createElement(DoneSubsectionRow, { ...baseProps, onToggle }),
    );
    const wrapper = getWrapper(container);

    const enter = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true });
    reactAct(() => {
      wrapper.dispatchEvent(enter);
    });
    expect(onToggle).toHaveBeenCalledWith('folder-1');
    expect(enter.defaultPrevented).toBe(true);

    onToggle.mockClear();
    const space = new KeyboardEvent('keydown', { key: ' ', code: 'Space', bubbles: true, cancelable: true });
    reactAct(() => {
      wrapper.dispatchEvent(space);
    });
    expect(onToggle).toHaveBeenCalledWith('folder-1');
    expect(space.defaultPrevented).toBe(true);

    unmount();
  });

  it('ArrowRight expands when collapsed; ArrowLeft is a no-op when collapsed', () => {
    const onToggle = vi.fn();
    const { container, unmount } = renderComponent(
      React.createElement(DoneSubsectionRow, { ...baseProps, isCollapsed: true, onToggle }),
    );
    const wrapper = getWrapper(container);

    reactAct(() => {
      wrapper.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true }));
    });
    expect(onToggle).toHaveBeenCalledWith('folder-1');

    onToggle.mockClear();
    reactAct(() => {
      wrapper.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true, cancelable: true }));
    });
    expect(onToggle).not.toHaveBeenCalled();

    unmount();
  });

  it('ArrowLeft collapses when expanded; ArrowRight is a no-op when expanded', () => {
    const onToggle = vi.fn();
    const { container, unmount } = renderComponent(
      React.createElement(DoneSubsectionRow, { ...baseProps, isCollapsed: false, onToggle }),
    );
    const wrapper = getWrapper(container);

    reactAct(() => {
      wrapper.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true, cancelable: true }));
    });
    expect(onToggle).toHaveBeenCalledWith('folder-1');

    onToggle.mockClear();
    reactAct(() => {
      wrapper.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true }));
    });
    expect(onToggle).not.toHaveBeenCalled();

    unmount();
  });

  it('does NOT toggle for keydowns bubbled from a descendant (guard)', () => {
    const onToggle = vi.fn();
    const { container, unmount } = renderComponent(
      React.createElement(DoneSubsectionRow, { ...baseProps, onToggle }),
    );
    const wrapper = getWrapper(container);
    const child = wrapper.querySelector('span');
    if (!child) throw new Error('Label span not found');

    const event = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true });
    reactAct(() => {
      child.dispatchEvent(event);
    });
    expect(onToggle).not.toHaveBeenCalled();

    unmount();
  });
});
