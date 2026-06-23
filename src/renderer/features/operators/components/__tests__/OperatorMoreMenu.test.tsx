// @vitest-environment happy-dom

import React from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OperatorMoreMenu, type OperatorMoreMenuAction } from '../OperatorMoreMenu';

describe('OperatorMoreMenu', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => { root.unmount(); });
    container.remove();
    vi.clearAllMocks();
  });

  it('opens the menu and dispatches the matching action', async () => {
    const onRename = vi.fn();
    const onDuplicate = vi.fn();
    const onHistory = vi.fn();
    const onRemove = vi.fn();
    const actions: OperatorMoreMenuAction[] = [
      { id: 'rename', label: 'Rename…', icon: 'rename', onSelect: onRename },
      { id: 'duplicate', label: 'Duplicate…', icon: 'duplicate', onSelect: onDuplicate },
      { id: 'history', label: 'History', icon: 'history', onSelect: onHistory },
      { id: 'remove', label: 'Remove', icon: 'remove', onSelect: onRemove, isDanger: true },
    ];
    await act(async () => {
      root.render(<OperatorMoreMenu actions={actions} buttonLabel="More actions for Customer Voice" />);
    });

    const trigger = container.querySelector('[data-testid="operator-card-more-button"]');
    expect(trigger?.getAttribute('aria-expanded')).toBe('false');
    await act(async () => {
      trigger?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    const menuItem = document.body.querySelector('[data-testid="operator-card-more-duplicate"]');
    expect(menuItem).not.toBeNull();
    await act(async () => {
      menuItem?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(onDuplicate).toHaveBeenCalledTimes(1);
    expect(onRename).not.toHaveBeenCalled();
    expect(onHistory).not.toHaveBeenCalled();
    expect(onRemove).not.toHaveBeenCalled();
  });
});
