// @vitest-environment happy-dom
import React from 'react';
import { createRoot } from 'react-dom/client';
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { FlowSurface } from '../../../flow-panels/FlowPanelsProvider';

const mocks = vi.hoisted(() => ({
  inactivityReturnTriggered: vi.fn(),
  userReturnedAfterIdle: vi.fn(),
}));

 
vi.mock('@renderer/src/tracking', () => ({
  tracking: {
    homepage: {
      inactivityReturnTriggered: mocks.inactivityReturnTriggered,
      userReturnedAfterIdle: mocks.userReturnedAfterIdle,
    },
  },
}));

import { useInactivityReturn } from '../useInactivityReturn';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type HookResult<T> = {
  result: { current: T };
  unmount: () => void;
};

function renderHook<T>(hookFn: () => T): HookResult<T> {
  const result = { current: undefined as unknown as T };
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);

  const TestComponent = () => {
    result.current = hookFn();
    return null;
  };

  act(() => {
    root.render(React.createElement(TestComponent));
  });

  return {
    result,
    unmount: () => {
      act(() => root.unmount());
      container.remove();
    },
  };
}

describe('useInactivityReturn', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-11T10:00:00.000Z'));
    mocks.inactivityReturnTriggered.mockClear();
    mocks.userReturnedAfterIdle.mockClear();
  });

  afterEach(() => {
    vi.useRealTimers();
    document.body.replaceChildren();
  });

  it('starts the welcome-back window when the user returns, not while they are away', () => {
    const { result, unmount } = renderHook(() =>
      useInactivityReturn({
        activeSurface: 'sessions' as FlowSurface,
        isBusy: false,
        idleThresholdMs: 15 * 60 * 1000,
      }),
    );

    expect(result.current.isReturningFromIdle).toBe(false);

    act(() => {
      vi.advanceTimersByTime(15 * 60 * 1000 + 30_000);
    });

    expect(mocks.inactivityReturnTriggered).toHaveBeenCalledTimes(1);
    expect(result.current.isReturningFromIdle).toBe(false);

    act(() => {
      vi.advanceTimersByTime(2 * 60 * 1000);
    });

    expect(result.current.isReturningFromIdle).toBe(false);
    expect(mocks.inactivityReturnTriggered).toHaveBeenCalledTimes(1);

    act(() => {
      document.dispatchEvent(new Event('mousemove'));
    });

    expect(mocks.userReturnedAfterIdle).toHaveBeenCalledWith(17 * 60 * 1000 + 30_000, 'sessions');
    expect(result.current.isReturningFromIdle).toBe(true);

    act(() => {
      vi.advanceTimersByTime(30_000);
    });

    expect(result.current.isReturningFromIdle).toBe(false);
    unmount();
  });
});
