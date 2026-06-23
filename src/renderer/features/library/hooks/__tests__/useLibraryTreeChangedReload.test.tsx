// @vitest-environment happy-dom

import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useLibraryTreeChangedReload } from '../useLibraryTreeChangedReload';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type LibraryChangedEvent = {
  timestamp: number;
  affectsTree: boolean;
  writerKind?: 'editor' | 'agent' | 'file-watcher' | 'cloud-sync';
  changedPath?: string;
};

describe('useLibraryTreeChangedReload', () => {
  let container: HTMLDivElement;
  let root: Root;
  let listeners: Set<(event: LibraryChangedEvent) => void>;
  let unsubscribeSpy: ReturnType<typeof vi.fn<() => void>>;

  function Probe({
    onTreeChanged,
    enabled = true,
  }: {
    onTreeChanged: () => void;
    enabled?: boolean;
  }) {
    useLibraryTreeChangedReload(onTreeChanged, { enabled });
    return null;
  }

  function emit(event: LibraryChangedEvent): void {
    for (const listener of [...listeners]) {
      listener(event);
    }
  }

  beforeEach(() => {
    listeners = new Set();
    unsubscribeSpy = vi.fn<() => void>();

    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        onLibraryChanged: vi.fn((callback: (event: LibraryChangedEvent) => void) => {
          listeners.add(callback);
          return () => {
            listeners.delete(callback);
            unsubscribeSpy();
          };
        }),
      },
    });

    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
    vi.clearAllMocks();
  });

  it('reloads only when library change affects the tree', () => {
    const onTreeChanged = vi.fn();

    act(() => {
      root.render(<Probe onTreeChanged={onTreeChanged} />);
    });

    act(() => {
      emit({ timestamp: 1, affectsTree: false });
      emit({ timestamp: 2, affectsTree: true });
      emit({ timestamp: 3, affectsTree: false });
    });

    expect(onTreeChanged).toHaveBeenCalledTimes(1);
  });

  it('unsubscribes on unmount', () => {
    const onTreeChanged = vi.fn();

    act(() => {
      root.render(<Probe onTreeChanged={onTreeChanged} />);
    });

    act(() => {
      root.unmount();
    });

    act(() => {
      emit({ timestamp: 1, affectsTree: true });
    });

    expect(unsubscribeSpy).toHaveBeenCalledTimes(1);
    expect(onTreeChanged).not.toHaveBeenCalled();
  });

  it('is a no-op when window.api.onLibraryChanged is unavailable', () => {
    const apiDescriptor = Object.getOwnPropertyDescriptor(window, 'api');
    Object.defineProperty(window, 'api', { configurable: true, value: undefined });

    const onTreeChanged = vi.fn();
    expect(() => {
      act(() => {
        root.render(<Probe onTreeChanged={onTreeChanged} />);
      });
    }).not.toThrow();
    expect(onTreeChanged).not.toHaveBeenCalled();

    if (apiDescriptor) {
      Object.defineProperty(window, 'api', apiDescriptor);
    }
  });

  it('subscribes only while enabled and unsubscribes when disabled', () => {
    const onTreeChanged = vi.fn();

    act(() => {
      root.render(<Probe onTreeChanged={onTreeChanged} enabled={false} />);
    });

    expect(window.api.onLibraryChanged).not.toHaveBeenCalled();

    act(() => {
      root.render(<Probe onTreeChanged={onTreeChanged} enabled />);
    });

    expect(window.api.onLibraryChanged).toHaveBeenCalledTimes(1);

    act(() => {
      emit({ timestamp: 1, affectsTree: true });
    });
    expect(onTreeChanged).toHaveBeenCalledTimes(1);

    act(() => {
      root.render(<Probe onTreeChanged={onTreeChanged} enabled={false} />);
    });

    expect(unsubscribeSpy).toHaveBeenCalledTimes(1);

    act(() => {
      emit({ timestamp: 2, affectsTree: true });
    });
    expect(onTreeChanged).toHaveBeenCalledTimes(1);
  });
});
