// @vitest-environment happy-dom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LibrarySearchResults } from '../LibrarySearchResults';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe('LibrarySearchResults empty state honesty (Bug-2)', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    document.body.innerHTML = '';
    vi.restoreAllMocks();
  });

  const baseProps = {
    results: [],
    selectedIndex: 0,
    editorPath: null,
    workspaceRoot: '/ws',
    query: 'nope',
    onSelectResult: vi.fn(),
    onHoverResult: vi.fn(),
  };

  it('shows the incomplete-Library hint on an empty search when the tree is partial', () => {
    act(() => {
      root.render(<LibrarySearchResults {...baseProps} isPartialTree />);
    });
    expect(container.querySelector('[data-testid="library-incomplete-hint"]')).toBeTruthy();
    expect(container.textContent).toContain('No files match');
  });

  it('does not show the incomplete-Library hint when the tree is complete', () => {
    act(() => {
      root.render(<LibrarySearchResults {...baseProps} isPartialTree={false} />);
    });
    expect(container.querySelector('[data-testid="library-incomplete-hint"]')).toBeNull();
  });
});
