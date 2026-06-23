// @vitest-environment happy-dom

import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SpaceInfo } from '@shared/ipc/schemas/library';
import { useBrokenSpacesNotification } from '../useBrokenSpacesNotification';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const mockRefresh = vi.hoisted(() => vi.fn());
const mockUseSpacesData = vi.hoisted(() => vi.fn());

 
vi.mock('@renderer/hooks/useSpacesData', () => ({
  useSpacesData: mockUseSpacesData,
}));

function makeSpace(status: SpaceInfo['status']): SpaceInfo {
  return {
    name: status === 'needs_attention' ? 'Broken' : 'Healthy',
    path: status === 'needs_attention' ? 'work/Broken' : 'work/Healthy',
    absolutePath: status === 'needs_attention' ? '/workspace/work/Broken' : '/workspace/work/Healthy',
    type: 'company',
    isSymlink: false,
    hasReadme: true,
    sharing: 'company-wide',
    status,
    statusMessage: status === 'needs_attention' ? 'Missing description' : undefined,
  } as SpaceInfo;
}

function mountProbe(): {
  root: Root;
  container: HTMLDivElement;
  observed: ReturnType<typeof useBrokenSpacesNotification>[];
} {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  const observed: ReturnType<typeof useBrokenSpacesNotification>[] = [];

  const Probe = () => {
    observed.push(useBrokenSpacesNotification({ coreDirectory: '/workspace' }));
    return null;
  };

  act(() => {
    root.render(<Probe />);
  });

  return { root, container, observed };
}

describe('useBrokenSpacesNotification', () => {
  let mounted: { root: Root; container: HTMLDivElement } | null = null;

  beforeEach(() => {
    mockRefresh.mockResolvedValue(undefined);
    mockUseSpacesData.mockReturnValue({
      spaces: [makeSpace('ok'), makeSpace('needs_attention')],
      loading: false,
      ready: true,
      error: false,
      parseWarnings: [],
      refresh: mockRefresh,
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

  it('derives broken Spaces from useSpacesData and forces refresh when rechecked', async () => {
    const result = mountProbe();
    mounted = result;

    expect(mockUseSpacesData).toHaveBeenCalledWith('/workspace');
    expect(result.observed.at(-1)?.brokenSpaces).toEqual([
      {
        name: 'Broken',
        path: 'work/Broken',
        absolutePath: '/workspace/work/Broken',
        statusMessage: 'Missing description',
      },
    ]);

    await act(async () => {
      await result.observed.at(-1)?.checkForBrokenSpaces();
    });

    expect(mockRefresh).toHaveBeenCalledTimes(1);
  });
});
