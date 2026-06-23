// @vitest-environment happy-dom

import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppSettings } from '@shared/types';
import type { SpaceInfo } from '@shared/ipc/schemas/library';
import {
  ONBOARDING_ORGANISATION_SEED_FAILURE_TOAST,
  useOnboardingFlow,
  type OnboardingFlowActions,
  type OnboardingFlowState,
} from '../useOnboardingFlow';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const mockShowToast = vi.hoisted(() => vi.fn());
const mockRecordRendererBreadcrumb = vi.hoisted(() => vi.fn());
const mockFetchSpaces = vi.hoisted(() => vi.fn());
const mockGetSpacesSnapshotFor = vi.hoisted(() => vi.fn());
const mockInvalidateSpaces = vi.hoisted(() => vi.fn());

 
vi.mock('@renderer/components/ui', () => ({
  useToast: () => ({ showToast: mockShowToast }),
}));

 
vi.mock('@renderer/src/sentry', () => ({
  recordRendererBreadcrumb: (...args: unknown[]) => mockRecordRendererBreadcrumb(...args),
}));

 
vi.mock('@renderer/hooks/useSpacesData', () => ({
  fetchSpaces: mockFetchSpaces,
  getSpacesSnapshotFor: mockGetSpacesSnapshotFor,
  invalidateSpaces: mockInvalidateSpaces,
}));

 
vi.mock('@renderer/src/tracking', () => ({
  tracking: {
    onboarding: {
      stepCompleted: vi.fn(),
      completed: vi.fn(),
      stageCompleted: vi.fn(),
      stepViewed: vi.fn(),
      toolAuthError: vi.fn(),
    },
  },
}));

type HarnessApi = {
  state: OnboardingFlowState;
  actions: OnboardingFlowActions;
};

type Mounted = {
  root: Root;
  container: HTMLDivElement;
  unmount: () => void;
};

function makeSettings(): AppSettings {
  return {
    onboardingCompleted: false,
    coreDirectory: '/workspace',
    companyName: 'Acme',
    activeProvider: 'anthropic',
    claude: { apiKey: null },
    openRouter: { oauthToken: null },
    voice: {
      provider: 'local-parakeet',
      openaiApiKey: null,
      elevenlabsApiKey: null,
    },
  } as AppSettings;
}

function makeSpace(): SpaceInfo {
  return {
    name: 'General',
    path: 'work/Acme/General',
    absolutePath: '/workspace/work/Acme/General',
    type: 'company',
    isSymlink: false,
    hasReadme: true,
    description: 'General description',
    sharing: 'company-wide',
    status: 'ok',
  } as SpaceInfo;
}

function mountHarness(completeOnboarding: () => Promise<void>, apiRef: { current: HarnessApi | null }): Mounted {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);

  const Harness = () => {
    const api = useOnboardingFlow({
      isOpen: false,
      draftSettings: makeSettings(),
      completeOnboarding,
    });
    apiRef.current = api;
    return null;
  };

  act(() => {
    root.render(<Harness />);
  });

  return {
    root,
    container,
    unmount: () => {
      act(() => root.unmount());
      container.remove();
    },
  };
}

async function flushEffects() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe('useOnboardingFlow organisation seed self-heal', () => {
  let mounted: Mounted | null = null;
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;
  const completeOnboarding = vi.fn<() => Promise<void>>();
  const updateSpaceFrontmatter = vi.fn();

  beforeEach(() => {
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    completeOnboarding.mockReset();
    completeOnboarding.mockResolvedValue(undefined);
    updateSpaceFrontmatter.mockReset();
    mockShowToast.mockReset();
    mockRecordRendererBreadcrumb.mockReset();
    mockFetchSpaces.mockReset();
    mockFetchSpaces.mockResolvedValue(undefined);
    mockGetSpacesSnapshotFor.mockReset();
    mockGetSpacesSnapshotFor.mockReturnValue({
      spaces: [],
      ready: true,
      error: false,
      parseWarnings: [],
    });
    mockInvalidateSpaces.mockReset();

    Object.defineProperty(window, 'libraryApi', {
      configurable: true,
      value: {
        detectGoogleDrive: vi.fn().mockResolvedValue({ installed: false }),
        detectOnedrive: vi.fn().mockResolvedValue({ installed: false, configured: false }),
        updateSpaceFrontmatter,
      },
    });
    Object.defineProperty(window, 'permissionsApi', {
      configurable: true,
      value: {
        getMicrophoneStatus: vi.fn().mockResolvedValue('granted'),
        checkFileAccess: vi.fn().mockResolvedValue({ hasAccess: true }),
      },
    });
    Object.defineProperty(window, 'dashboardApi', {
      configurable: true,
      value: {
        generateUseCases: vi.fn().mockResolvedValue({ success: true, useCases: [] }),
      },
    });
  });

  afterEach(() => {
    mounted?.unmount();
    mounted = null;
    consoleErrorSpy.mockRestore();
    document.body.innerHTML = '';
    vi.clearAllMocks();
  });

  it('keeps onboarding complete when the frontmatter seed fails and surfaces a toast plus breadcrumb', async () => {
    let seedAttempted = false;
    updateSpaceFrontmatter.mockImplementation(async () => {
      seedAttempted = true;
      return { success: false, error: 'Disk said no.' };
    });
    completeOnboarding.mockImplementation(async () => {
      // Seed runs BEFORE completeOnboarding so the wizard does not close
      // until the frontmatter write has at least been attempted. See
      // completeOnboardingWithOrganisationSeed in useOnboardingFlow.ts.
      expect(seedAttempted).toBe(true);
    });

    const apiRef: { current: HarnessApi | null } = { current: null };
    mounted = mountHarness(completeOnboarding, apiRef);

    await act(async () => {
      apiRef.current?.actions.addConnectedSpace(makeSpace());
    });
    await flushEffects();

    await act(async () => {
      await apiRef.current?.actions.handleFinish();
    });
    await flushEffects();

    expect(completeOnboarding).toHaveBeenCalledTimes(1);
    expect(updateSpaceFrontmatter).toHaveBeenCalledWith({
      spacePath: 'work/Acme/General',
      updates: {
        organisation_name: 'Acme',
      },
    });
    expect(apiRef.current?.state.completionError).toBeNull();
    expect(mockShowToast).toHaveBeenCalledWith(
      expect.objectContaining({
        title: ONBOARDING_ORGANISATION_SEED_FAILURE_TOAST,
        variant: 'warning',
      }),
    );
    expect(mockRecordRendererBreadcrumb).toHaveBeenCalledWith(
      expect.objectContaining({
        category: 'onboarding.organisation-seed',
        level: 'error',
        message: 'Onboarding: failed to seed organisation_name on first work space',
        data: expect.objectContaining({
          companyName: 'Acme',
          spacePath: 'work/Acme/General',
          error: 'Disk said no.',
        }),
      }),
    );
  });

  it('invalidates the shared Spaces cache after a successful organisation seed write', async () => {
    updateSpaceFrontmatter.mockResolvedValue({ success: true });

    const apiRef: { current: HarnessApi | null } = { current: null };
    mounted = mountHarness(completeOnboarding, apiRef);

    await act(async () => {
      apiRef.current?.actions.addConnectedSpace(makeSpace());
    });
    await flushEffects();

    await act(async () => {
      await apiRef.current?.actions.handleFinish();
    });
    await flushEffects();

    expect(updateSpaceFrontmatter).toHaveBeenCalledTimes(1);
    expect(mockInvalidateSpaces).toHaveBeenCalledWith('/workspace');
  });
});
