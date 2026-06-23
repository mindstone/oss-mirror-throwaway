// @vitest-environment happy-dom
/**
 * Regression tests for FolderHeaderRow — keyboard-activation guard.
 *
 * FOX-3070: When the wrapper row is in rename mode, space characters typed
 * into the inner <input> were swallowed because the wrapper's onKeyDown
 * preventDefault'd bubbled Space events (it was intended to handle Space as
 * row keyboard-activation). The fix guards the wrapper handler against
 * events that did not originate on the wrapper itself.
 */

import { describe, it, expect, vi } from 'vitest';
import React from 'react';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const ReactDOMClient = require('react-dom/client');
const { act: reactAct } = require('react');

import { FolderHeaderRow } from '../FolderHeaderRow';
import type { ConversationFolder } from '@shared/ipc/schemas/folders';

function makeFolder(overrides: Partial<ConversationFolder> = {}): ConversationFolder {
  return {
    id: 'folder-1',
    name: 'My Folder',
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  };
}

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
  if (!wrapper) throw new Error('Folder wrapper not found');
  return wrapper as HTMLElement;
}

function getRenameInput(container: HTMLElement): HTMLInputElement {
  const input = container.querySelector('input[aria-label="Folder name"]');
  if (!input) throw new Error('Rename input not found');
  return input as HTMLInputElement;
}

describe('FolderHeaderRow — keyboard-activation guard (FOX-3070)', () => {
  it('does NOT preventDefault Space keydowns bubbled from the rename input', () => {
    const folder = makeFolder();
    const onToggleCollapse = vi.fn();
    const onRename = vi.fn();

    const { container, unmount } = renderComponent(
      React.createElement(FolderHeaderRow, {
        folder,
        allFolders: [folder],
        childCount: 0,
        isCollapsed: true,
        isDone: false,
        onToggleCollapse,
        onToggleDone: vi.fn(),
        onRename,
        onDelete: vi.fn(),
        isEditing: true,
        onStartEdit: vi.fn(),
        onCancelEdit: vi.fn(),
      }),
    );

    const input = getRenameInput(container);
    // Dispatch a bubbling Space keydown from the input. If the wrapper's
    // handler incorrectly consumes this, defaultPrevented will become true.
    const event = new KeyboardEvent('keydown', {
      key: ' ',
      code: 'Space',
      bubbles: true,
      cancelable: true,
    });

    reactAct(() => {
      input.dispatchEvent(event);
    });

    expect(event.defaultPrevented).toBe(false);
    expect(onToggleCollapse).not.toHaveBeenCalled();

    unmount();
  });

  it('does NOT toggle collapse for Arrow keys bubbled from the rename input (caret movement)', () => {
    const folder = makeFolder();
    const onToggleCollapse = vi.fn();

    const { container, rerender, unmount } = renderComponent(
      React.createElement(FolderHeaderRow, {
        folder,
        allFolders: [folder],
        childCount: 0,
        isCollapsed: true,
        isDone: false,
        onToggleCollapse,
        onToggleDone: vi.fn(),
        onRename: vi.fn(),
        onDelete: vi.fn(),
        isEditing: true,
        onStartEdit: vi.fn(),
        onCancelEdit: vi.fn(),
      }),
    );

    const input = getRenameInput(container);
    reactAct(() => {
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true }));
    });
    expect(onToggleCollapse).not.toHaveBeenCalled();

    rerender(
      React.createElement(FolderHeaderRow, {
        folder,
        allFolders: [folder],
        childCount: 0,
        isCollapsed: false,
        isDone: false,
        onToggleCollapse,
        onToggleDone: vi.fn(),
        onRename: vi.fn(),
        onDelete: vi.fn(),
        isEditing: true,
        onStartEdit: vi.fn(),
        onCancelEdit: vi.fn(),
      }),
    );

    const input2 = getRenameInput(container);
    reactAct(() => {
      input2.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true, cancelable: true }));
    });
    expect(onToggleCollapse).not.toHaveBeenCalled();

    unmount();
  });

  it('does NOT invoke onToggleCollapse for Enter keydowns bubbled from the rename input', () => {
    const folder = makeFolder();
    const onToggleCollapse = vi.fn();
    const onRename = vi.fn();
    const onCancelEdit = vi.fn();

    const { container, unmount } = renderComponent(
      React.createElement(FolderHeaderRow, {
        folder,
        allFolders: [folder],
        childCount: 0,
        isCollapsed: true,
        isDone: false,
        onToggleCollapse,
        onToggleDone: vi.fn(),
        onRename,
        onDelete: vi.fn(),
        isEditing: true,
        onStartEdit: vi.fn(),
        onCancelEdit,
      }),
    );

    const input = getRenameInput(container);
    const event = new KeyboardEvent('keydown', {
      key: 'Enter',
      bubbles: true,
      cancelable: true,
    });

    reactAct(() => {
      input.dispatchEvent(event);
    });

    expect(onToggleCollapse).not.toHaveBeenCalled();

    unmount();
  });

  it('still toggles collapse when Space is pressed on the wrapper itself (non-editing)', () => {
    const folder = makeFolder();
    const onToggleCollapse = vi.fn();

    const { container, unmount } = renderComponent(
      React.createElement(FolderHeaderRow, {
        folder,
        allFolders: [folder],
        childCount: 0,
        isCollapsed: true,
        isDone: false,
        onToggleCollapse,
        onToggleDone: vi.fn(),
        onRename: vi.fn(),
        onDelete: vi.fn(),
        isEditing: false,
      }),
    );

    const wrapper = getWrapper(container);
    const event = new KeyboardEvent('keydown', {
      key: ' ',
      code: 'Space',
      bubbles: true,
      cancelable: true,
    });

    reactAct(() => {
      wrapper.dispatchEvent(event);
    });

    expect(onToggleCollapse).toHaveBeenCalledWith(folder.id);
    expect(event.defaultPrevented).toBe(true);

    unmount();
  });

  it('still toggles collapse when Enter is pressed on the wrapper itself (non-editing)', () => {
    const folder = makeFolder();
    const onToggleCollapse = vi.fn();

    const { container, unmount } = renderComponent(
      React.createElement(FolderHeaderRow, {
        folder,
        allFolders: [folder],
        childCount: 0,
        isCollapsed: true,
        isDone: false,
        onToggleCollapse,
        onToggleDone: vi.fn(),
        onRename: vi.fn(),
        onDelete: vi.fn(),
        isEditing: false,
      }),
    );

    const wrapper = getWrapper(container);
    const event = new KeyboardEvent('keydown', {
      key: 'Enter',
      bubbles: true,
      cancelable: true,
    });

    reactAct(() => {
      wrapper.dispatchEvent(event);
    });

    expect(onToggleCollapse).toHaveBeenCalledWith(folder.id);

    unmount();
  });

  it('still handles ArrowRight/ArrowLeft when pressed on the wrapper itself', () => {
    const folder = makeFolder();
    const onToggleCollapse = vi.fn();

    // Collapsed -> ArrowRight should expand
    const { container, rerender, unmount } = renderComponent(
      React.createElement(FolderHeaderRow, {
        folder,
        allFolders: [folder],
        childCount: 0,
        isCollapsed: true,
        isDone: false,
        onToggleCollapse,
        onToggleDone: vi.fn(),
        onRename: vi.fn(),
        onDelete: vi.fn(),
        isEditing: false,
      }),
    );

    const wrapper = getWrapper(container);
    const rightEvent = new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true });
    reactAct(() => {
      wrapper.dispatchEvent(rightEvent);
    });
    expect(onToggleCollapse).toHaveBeenCalledWith(folder.id);

    onToggleCollapse.mockClear();

    // Expanded -> ArrowLeft should collapse
    rerender(
      React.createElement(FolderHeaderRow, {
        folder,
        allFolders: [folder],
        childCount: 0,
        isCollapsed: false,
        isDone: false,
        onToggleCollapse,
        onToggleDone: vi.fn(),
        onRename: vi.fn(),
        onDelete: vi.fn(),
        isEditing: false,
      }),
    );

    const wrapper2 = getWrapper(container);
    const leftEvent = new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true, cancelable: true });
    reactAct(() => {
      wrapper2.dispatchEvent(leftEvent);
    });
    expect(onToggleCollapse).toHaveBeenCalledWith(folder.id);

    unmount();
  });

  it('uses the done hover button without toggling folder collapse', () => {
    const folder = makeFolder();
    const onToggleCollapse = vi.fn();
    const onToggleDone = vi.fn();

    const { container, unmount } = renderComponent(
      React.createElement(FolderHeaderRow, {
        folder,
        allFolders: [folder],
        childCount: 2,
        isCollapsed: true,
        isDone: false,
        onToggleCollapse,
        onToggleDone,
        onRename: vi.fn(),
        onDelete: vi.fn(),
        isEditing: false,
      }),
    );

    const button = container.querySelector('button[aria-label="Mark folder My Folder as done"]');
    if (!button) throw new Error('Done button not found');

    reactAct(() => {
      (button as HTMLButtonElement).click();
    });

    expect(onToggleDone).toHaveBeenCalledWith(folder.id);
    expect(onToggleCollapse).not.toHaveBeenCalled();

    unmount();
  });
});
