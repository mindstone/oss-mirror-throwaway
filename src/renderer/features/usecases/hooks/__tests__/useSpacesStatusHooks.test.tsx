// @vitest-environment happy-dom

import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SpaceInfo } from '@shared/ipc/schemas/library';
import { useCompanyValuesStatus } from '../useCompanyValuesStatus';
import { usePersonalGoalsStatus } from '../usePersonalGoalsStatus';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const mockUseSpacesData = vi.hoisted(() => vi.fn());
const mockUseSettingsSafe = vi.hoisted(() => vi.fn());

 
vi.mock('@renderer/hooks/useSpacesData', () => ({
  useSpacesData: mockUseSpacesData,
}));

 
vi.mock('@renderer/features/settings', () => ({
  useSettingsSafe: mockUseSettingsSafe,
}));

function recentDate(): string {
  return new Date(Date.now() - 5 * 24 * 60 * 60 * 1000).toISOString();
}

function makeSpace(overrides: Partial<SpaceInfo>): SpaceInfo {
  return {
    name: 'Space',
    path: 'work/Space',
    absolutePath: '/workspace/work/Space',
    type: 'company',
    isSymlink: false,
    hasReadme: true,
    sharing: 'company-wide',
    status: 'ok',
    ...overrides,
  } as SpaceInfo;
}

function mountProbe(): {
  root: Root;
  container: HTMLDivElement;
  observed: Array<{
    company: ReturnType<typeof useCompanyValuesStatus>;
    goals: ReturnType<typeof usePersonalGoalsStatus>;
  }>;
} {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  const observed: Array<{
    company: ReturnType<typeof useCompanyValuesStatus>;
    goals: ReturnType<typeof usePersonalGoalsStatus>;
  }> = [];

  const Probe = () => {
    observed.push({
      company: useCompanyValuesStatus(),
      goals: usePersonalGoalsStatus(),
    });
    return null;
  };

  act(() => {
    root.render(<Probe />);
  });

  return { root, container, observed };
}

describe('Spaces status hooks', () => {
  let mounted: { root: Root; container: HTMLDivElement } | null = null;

  beforeEach(() => {
    mockUseSettingsSafe.mockReturnValue({ settings: { coreDirectory: '/workspace' } });
    mockUseSpacesData.mockReturnValue({
      spaces: [
        makeSpace({ type: 'chief-of-staff', goalsLastReviewed: recentDate() }),
        makeSpace({ name: 'Company', path: 'work/Company', valuesLastReviewed: undefined }),
      ],
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

  it('reads shared Spaces data via useSpacesData for goals and company-values status', () => {
    const result = mountProbe();
    mounted = result;

    expect(mockUseSpacesData).toHaveBeenCalledWith('/workspace');
    expect(mockUseSpacesData).toHaveBeenCalledTimes(2);
    expect(result.observed.at(-1)?.goals.status).toBe('current');
    expect(result.observed.at(-1)?.company.spacesNeedingValues).toEqual([
      expect.objectContaining({
        spacePath: 'work/Company',
        spaceName: 'Company',
        status: 'not_set',
      }),
    ]);
  });
});
