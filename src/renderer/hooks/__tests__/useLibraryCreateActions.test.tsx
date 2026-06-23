// @vitest-environment happy-dom

import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  useLibraryCreateActions,
  type UseLibraryCreateActionsOptions,
} from '../useLibraryCreateActions';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type Mounted = {
  root: Root;
  container: HTMLDivElement;
  rerender: (options: UseLibraryCreateActionsOptions) => void;
  unmount: () => void;
  getResult: () => ReturnType<typeof useLibraryCreateActions>;
};

function mountHook(options: UseLibraryCreateActionsOptions): Mounted {
  let latestResult: ReturnType<typeof useLibraryCreateActions> | null = null;

  const Harness = (props: UseLibraryCreateActionsOptions) => {
    latestResult = useLibraryCreateActions(props);
    return null;
  };

  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);

  act(() => {
    root.render(<Harness {...options} />);
  });

  return {
    root,
    container,
    rerender: (nextOptions) => {
      act(() => {
        root.render(<Harness {...nextOptions} />);
      });
    },
    unmount: () => {
      act(() => {
        root.unmount();
      });
      container.remove();
    },
    getResult: () => {
      if (!latestResult) {
        throw new Error('Hook result was not captured');
      }
      return latestResult;
    },
  };
}

function buildOptions(overrides: Partial<UseLibraryCreateActionsOptions> = {}): UseLibraryCreateActionsOptions {
  return {
    startFreshSession: vi.fn(() => 'session-1'),
    setSessionDraft: vi.fn(),
    canCreateAdditionalSpaces: true,
    setActiveSurface: vi.fn(),
    openSettingsDialog: vi.fn(async () => undefined),
    requestPendingSpacesAction: vi.fn(),
    showToast: vi.fn(),
    ...overrides,
  };
}

describe('useLibraryCreateActions', () => {
  let mounted: Mounted | null = null;

  afterEach(() => {
    mounted?.unmount();
    mounted = null;
    try {
      vi.runOnlyPendingTimers();
    } catch {
      // Ignore when fake timers were not enabled for the test.
    }
    vi.useRealTimers();
    document.body.innerHTML = '';
    vi.clearAllMocks();
  });

  it('creates a memory-prefilled session using "Remember this: "', () => {
    const options = buildOptions();
    mounted = mountHook(options);

    act(() => {
      mounted?.getResult().createMemory();
    });

    expect(options.startFreshSession).toHaveBeenCalledTimes(1);
    expect(options.startFreshSession).toHaveBeenCalledWith({ showHistory: true });
    expect(options.setSessionDraft).toHaveBeenCalledWith('session-1', 'Remember this: ');
  });

  it('guards against rapid double-click session creation', () => {
    vi.useFakeTimers();
    const startFreshSession = vi
      .fn()
      .mockReturnValueOnce('session-1')
      .mockReturnValueOnce('session-2');
    const options = buildOptions({ startFreshSession });
    mounted = mountHook(options);

    act(() => {
      const result = mounted?.getResult();
      result?.createMemory();
      result?.createMemory();
    });

    expect(startFreshSession).toHaveBeenCalledTimes(1);
    expect(options.setSessionDraft).toHaveBeenCalledTimes(1);

    act(() => {
      vi.advanceTimersByTime(300);
    });

    act(() => {
      mounted?.getResult().createMemory();
    });

    expect(startFreshSession).toHaveBeenCalledTimes(2);
    expect(options.setSessionDraft).toHaveBeenCalledTimes(2);
  });

  it('blocks Add space from Library when entitlement is unavailable', () => {
    const options = buildOptions({ canCreateAdditionalSpaces: false });
    mounted = mountHook(options);

    act(() => {
      mounted?.getResult().addSpaceFromLibrary();
    });

    expect(options.showToast).toHaveBeenCalledWith({
      title: 'Additional spaces require a Teams license. Contact hello@mindstone.com to upgrade.',
    });
    expect(options.setActiveSurface).not.toHaveBeenCalled();
    expect(options.requestPendingSpacesAction).not.toHaveBeenCalled();
    expect(options.openSettingsDialog).not.toHaveBeenCalled();
  });

  it('opens Settings and queues a pending add-space intent when allowed', () => {
    const options = buildOptions({ canCreateAdditionalSpaces: true });
    mounted = mountHook(options);

    act(() => {
      mounted?.getResult().addSpaceFromLibrary();
    });

    expect(options.setActiveSurface).toHaveBeenCalledWith('settings');
    expect(options.requestPendingSpacesAction).toHaveBeenCalledWith('add');
    expect(options.openSettingsDialog).toHaveBeenCalledWith('spaces', 'spaces', {
      source: 'link',
      interactionType: 'programmatic',
    });
  });
});
