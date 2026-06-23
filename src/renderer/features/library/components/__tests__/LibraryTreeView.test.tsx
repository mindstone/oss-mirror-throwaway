// @vitest-environment happy-dom

import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FileNode } from '@shared/types';
import { LibraryTreeView, type LibraryTreeViewProps } from '../LibraryTreeView';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type Mounted = {
  container: HTMLDivElement;
  root: Root;
  unmount: () => void;
};

const SAMPLE_TREE: FileNode[] = [
  {
    kind: 'directory',
    name: 'docs',
    path: '/workspace/docs',
    children: [
      {
        kind: 'file',
        name: 'AGENTS.md',
        path: '/workspace/docs/AGENTS.md',
      },
    ],
  },
];

function makeProps(overrides: Partial<LibraryTreeViewProps> = {}): LibraryTreeViewProps {
  return {
    nodes: SAMPLE_TREE,
    expandedDirectories: { '/workspace/docs': true },
    selectedPath: null,
    activePath: null,
    focusedPath: null,
    renamingPath: null,
    draggingNodePath: null,
    dropTarget: null,
    libraryRootAbsolute: '/workspace',
    onSelectNode: vi.fn(),
    onFocusNode: vi.fn(),
    onToggleExpand: vi.fn(),
    onContextMenu: vi.fn(),
    onConfirmRename: vi.fn().mockResolvedValue(undefined),
    onCancelRename: vi.fn(),
    onDragStart: vi.fn(),
    onDragOver: vi.fn(),
    onDragLeave: vi.fn(),
    onDrop: vi.fn(),
    onDragEnd: vi.fn(),
    isFileFavorite: vi.fn(() => false),
    onToggleFileFavorite: vi.fn(),
    ...overrides,
  };
}

function mountTree(props: LibraryTreeViewProps): Mounted {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);

  act(() => {
    root.render(<LibraryTreeView {...props} />);
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

describe('LibraryTreeView compact density', () => {
  let mounted: Mounted | null = null;

  afterEach(() => {
    mounted?.unmount();
    mounted = null;
    document.body.innerHTML = '';
    vi.clearAllMocks();
  });

  it('hides folder count badges and kebab actions in compact density', () => {
    mounted = mountTree(makeProps({ density: 'compact' }));

    expect(
      mounted.container.querySelectorAll('[data-testid="library-tree-item-more-button"]').length,
    ).toBe(0);
    expect(
      mounted.container.querySelectorAll('[data-testid="library-tree-item-count-badge"]').length,
    ).toBe(0);
  });

  it('sets compact tree list min-width to max-content for horizontal overflow safety', () => {
    mounted = mountTree(makeProps({ density: 'compact' }));

    const rootList = mounted.container.querySelector('[data-testid="library-tree"] ul');
    expect(rootList).not.toBeNull();
    expect((rootList as HTMLUListElement).style.minWidth).toBe('max-content');
  });
});
