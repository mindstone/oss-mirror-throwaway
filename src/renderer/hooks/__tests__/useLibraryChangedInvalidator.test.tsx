// @vitest-environment happy-dom
import React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SpaceInfo } from '@shared/ipc/schemas/library';
import { __resetSpacesCacheForTests, useSpacesData } from '../useSpacesData';
import {
  __resetLibraryChangedInvalidatorForTests,
  useLibraryChangedInvalidator,
} from '../useLibraryChangedInvalidator';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type LibraryChangedEvent = {
  timestamp: number;
  affectsTree: boolean;
  changedPath?: string;
  source?: 'user' | 'watcher';
};

const makeSpace = (name: string, overrides: Partial<SpaceInfo> = {}): SpaceInfo => ({
  name,
  path: name,
  absolutePath: `/core/${name}`,
  type: 'project',
  isSymlink: false,
  hasReadme: true,
  status: 'ok',
  ...overrides,
});

describe('useLibraryChangedInvalidator', () => {
  let container: HTMLDivElement;
  let root: Root;
  let listeners: Array<(event: LibraryChangedEvent) => void>;
  let unsubscribeCalls: number;
  let scanSpaces: ReturnType<typeof vi.fn>;
  let rootMounted: boolean;

  beforeEach(() => {
    vi.useFakeTimers();
    __resetSpacesCacheForTests();
    __resetLibraryChangedInvalidatorForTests();
    listeners = [];
    unsubscribeCalls = 0;
    scanSpaces = vi.fn().mockResolvedValue({ success: true, spaces: [makeSpace('Shared')] });

    (window as unknown as {
      api: {
        onLibraryChanged: (callback: (event: LibraryChangedEvent) => void) => () => void;
      };
      libraryApi: {
        scanSpaces: typeof scanSpaces;
      };
    }).api = {
      onLibraryChanged: vi.fn((callback: (event: LibraryChangedEvent) => void) => {
        listeners.push(callback);
        return () => {
          unsubscribeCalls += 1;
          listeners = listeners.filter((listener) => listener !== callback);
        };
      }),
    };
    (window as unknown as { libraryApi: { scanSpaces: typeof scanSpaces } }).libraryApi = {
      scanSpaces,
    };

    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    rootMounted = true;
  });

  afterEach(() => {
    if (rootMounted) {
      act(() => { root.unmount(); });
    }
    container.remove();
    __resetLibraryChangedInvalidatorForTests();
    __resetSpacesCacheForTests();
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  const emitLibraryChanged = (event: Partial<LibraryChangedEvent> = {}) => {
    for (const listener of listeners) {
      listener({
        timestamp: Date.now(),
        affectsTree: false,
        source: 'watcher',
        ...event,
      });
    }
  };

  const mountProbe = async (coreDirectory = '/core') => {
    const Probe: React.FC = () => {
      useSpacesData(coreDirectory);
      useLibraryChangedInvalidator();
      return null;
    };

    await act(async () => {
      root.render(<Probe />);
      await Promise.resolve();
      await Promise.resolve();
    });
  };

  const flushThrottle = async () => {
    await act(async () => {
      vi.advanceTimersByTime(2_000);
      await Promise.resolve();
      await Promise.resolve();
    });
  };

  it('T1A.I1 subscribes once and coalesces rapid events into one refetch', async () => {
    const Probe: React.FC = () => {
      useSpacesData('/core');
      useLibraryChangedInvalidator();
      useLibraryChangedInvalidator();
      useLibraryChangedInvalidator();
      return null;
    };

    await act(async () => {
      root.render(<Probe />);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(window.api.onLibraryChanged).toHaveBeenCalledTimes(1);
    expect(listeners).toHaveLength(1);
    expect(scanSpaces).toHaveBeenCalledTimes(1);

    act(() => {
      for (let index = 0; index < 50; index += 1) {
        emitLibraryChanged({ affectsTree: true });
      }
    });

    expect(scanSpaces).toHaveBeenCalledTimes(1);

    await act(async () => {
      vi.advanceTimersByTime(1_999);
      await Promise.resolve();
    });
    expect(scanSpaces).toHaveBeenCalledTimes(1);

    await act(async () => {
      vi.advanceTimersByTime(1);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(scanSpaces).toHaveBeenCalledTimes(2);
    expect(scanSpaces.mock.calls[1]).toEqual([]);

    act(() => { root.unmount(); });
    rootMounted = false;
    expect(unsubscribeCalls).toBe(1);
    expect(listeners).toHaveLength(0);
  });

  it('flushes invalidation immediately for user-source events', async () => {
    await mountProbe();
    expect(scanSpaces).toHaveBeenCalledTimes(1);

    act(() => {
      emitLibraryChanged({ affectsTree: true, source: 'user' });
    });

    await act(async () => {
      vi.advanceTimersByTime(50);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(scanSpaces).toHaveBeenCalledTimes(2);
    expect(scanSpaces.mock.calls[1]).toEqual([]);
  });

  it('keeps watcher-source events behind the 2s throttle', async () => {
    await mountProbe();
    expect(scanSpaces).toHaveBeenCalledTimes(1);

    act(() => {
      emitLibraryChanged({ affectsTree: true, source: 'watcher' });
    });

    await act(async () => {
      vi.advanceTimersByTime(1_999);
      await Promise.resolve();
    });
    expect(scanSpaces).toHaveBeenCalledTimes(1);

    await act(async () => {
      vi.advanceTimersByTime(1);
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(scanSpaces).toHaveBeenCalledTimes(2);
  });

  it('invalidates when a workspace-relative Space README changes', async () => {
    scanSpaces.mockResolvedValue({ success: true, spaces: [makeSpace('MySpace')] });
    await mountProbe();
    expect(scanSpaces).toHaveBeenCalledTimes(1);

    act(() => {
      emitLibraryChanged({ affectsTree: false, changedPath: 'MySpace/README.md' });
    });
    await flushThrottle();

    expect(scanSpaces).toHaveBeenCalledTimes(2);
  });

  it('invalidates when an absolute Space README changes', async () => {
    scanSpaces.mockResolvedValue({
      success: true,
      spaces: [makeSpace('MySpace', { path: 'MySpace', absolutePath: '/workspace/MySpace' })],
    });
    await mountProbe('/workspace');
    expect(scanSpaces).toHaveBeenCalledTimes(1);

    act(() => {
      emitLibraryChanged({ affectsTree: false, changedPath: '/workspace/MySpace/README.md' });
    });
    await flushThrottle();

    expect(scanSpaces).toHaveBeenCalledTimes(2);
  });

  it('invalidates when a README changes under a symlinked Space sourcePath', async () => {
    scanSpaces.mockResolvedValue({
      success: true,
      spaces: [
        makeSpace('MySpace', {
          path: 'MySpace',
          absolutePath: '/workspace/MySpace',
          sourcePath: '/external/CloudDrive/Real',
        }),
      ],
    });
    await mountProbe('/workspace');
    expect(scanSpaces).toHaveBeenCalledTimes(1);

    act(() => {
      emitLibraryChanged({ affectsTree: false, changedPath: '/external/CloudDrive/Real/README.md' });
    });
    await flushThrottle();

    expect(scanSpaces).toHaveBeenCalledTimes(2);
  });

  it('does not invalidate for unrelated non-README changes', async () => {
    scanSpaces.mockResolvedValue({ success: true, spaces: [makeSpace('MySpace')] });
    await mountProbe();
    expect(scanSpaces).toHaveBeenCalledTimes(1);

    act(() => {
      emitLibraryChanged({ affectsTree: false, changedPath: 'OtherFile.md' });
    });
    await flushThrottle();

    expect(scanSpaces).toHaveBeenCalledTimes(1);
  });

  it('only invalidates non-README Space changes when the tree was affected', async () => {
    scanSpaces.mockResolvedValue({ success: true, spaces: [makeSpace('MySpace')] });
    await mountProbe();
    expect(scanSpaces).toHaveBeenCalledTimes(1);

    act(() => {
      emitLibraryChanged({ affectsTree: false, changedPath: 'MySpace/Notes/page.md' });
    });
    await flushThrottle();
    expect(scanSpaces).toHaveBeenCalledTimes(1);

    act(() => {
      emitLibraryChanged({ affectsTree: true, changedPath: 'MySpace/Notes/page.md' });
    });
    await flushThrottle();
    expect(scanSpaces).toHaveBeenCalledTimes(2);
  });
});
