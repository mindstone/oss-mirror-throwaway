// @vitest-environment happy-dom

import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SpaceInfo } from '@shared/ipc/schemas/library';
import { useAtlasSpaces } from '../useAtlasSpaces';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const mockUseSpacesData = vi.hoisted(() => vi.fn());

 
vi.mock('@renderer/hooks/useSpacesData', () => ({
  useSpacesData: mockUseSpacesData,
}));

function makeSpace(overrides: Partial<SpaceInfo> = {}): SpaceInfo {
  return {
    name: 'General',
    displayName: 'General',
    path: 'work/Acme/General',
    absolutePath: '/workspace/work/Acme/General',
    sourcePath: '/external/General',
    type: 'company',
    isSymlink: true,
    hasReadme: true,
    sharing: 'company-wide',
    status: 'ok',
    ...overrides,
  } as SpaceInfo;
}

function renderProbe(filePaths: string[], coreDirectory: string | null): {
  root: Root;
  container: HTMLDivElement;
  observed: ReturnType<typeof useAtlasSpaces>[];
} {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  const observed: ReturnType<typeof useAtlasSpaces>[] = [];

  const Probe = () => {
    observed.push(useAtlasSpaces(filePaths, coreDirectory));
    return null;
  };

  act(() => {
    root.render(<Probe />);
  });

  return { root, container, observed };
}

describe('useAtlasSpaces', () => {
  let mounted: { root: Root; container: HTMLDivElement } | null = null;

  beforeEach(() => {
    mockUseSpacesData.mockReturnValue({
      spaces: [makeSpace()],
      loading: false,
      ready: true,
      error: false,
      parseWarnings: [],
      refresh: vi.fn(),
    });
  });

  afterEach(() => {
    if (mounted) {
      act(() => mounted?.root.unmount());
      mounted.container.remove();
      mounted = null;
    }
    vi.clearAllMocks();
  });

  it('reads Spaces through useSpacesData and maps symlink source paths for Atlas coloring', () => {
    const result = renderProbe(['/external/General/note.md'], '/workspace');
    mounted = result;

    expect(mockUseSpacesData).toHaveBeenCalledWith('/workspace');
    expect(result.observed.at(-1)?.spaceNameMap.get('/external/General/note.md')).toBe('General');
  });
});
