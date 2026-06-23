// @vitest-environment happy-dom

import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useNewSessionActions } from '../useNewSessionActions';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type HookResult = ReturnType<typeof useNewSessionActions>;

type Mounted = {
  unmount: () => void;
  getResult: () => HookResult;
};

function mountHook(config: Parameters<typeof useNewSessionActions>[0]): Mounted {
  let latest: HookResult | null = null;

  const Harness = () => {
    latest = useNewSessionActions(config);
    return null;
  };

  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);

  act(() => {
    root.render(<Harness />);
  });

  return {
    unmount: () => {
      act(() => {
        root.unmount();
      });
      container.remove();
    },
    getResult: () => {
      if (!latest) {
        throw new Error('Hook result not captured');
      }
      return latest;
    },
  };
}

describe('useNewSessionActions', () => {
  let mounted: Mounted | null = null;

  afterEach(() => {
    mounted?.unmount();
    mounted = null;
    document.body.innerHTML = '';
    vi.clearAllMocks();
  });

  it('flushes pending composer drafts before resetting session state', () => {
    const callOrder: string[] = [];
    const resetSessionState = vi.fn(() => {
      callOrder.push('reset');
      return 'session-123';
    });
    const flushComposerDraft = vi.fn(() => {
      callOrder.push('flush');
    });

    const setActiveSurface = vi.fn();
    const setShowConversation = vi.fn();
    const setIsTextMode = vi.fn();
    const setFlowHistoryOpen = vi.fn();

    mounted = mountHook({
      resetSessionState,
      flushComposerDraft,
      setActiveSurface,
      setShowConversation,
      setIsTextMode,
      setFlowHistoryOpen,
    });

    let sessionId = '';
    act(() => {
      sessionId = mounted?.getResult().startFreshSession({ showHistory: true }) ?? '';
    });

    expect(sessionId).toBe('session-123');
    expect(callOrder.slice(0, 2)).toEqual(['flush', 'reset']);
    expect(setActiveSurface).toHaveBeenCalledWith('sessions');
    expect(setShowConversation).toHaveBeenCalledWith(true);
    expect(setIsTextMode).toHaveBeenCalledWith(true);
    expect(setFlowHistoryOpen).toHaveBeenCalledWith(true);
  });

  it('keeps flow history untouched when showHistory is omitted', () => {
    const setFlowHistoryOpen = vi.fn();

    mounted = mountHook({
      resetSessionState: vi.fn(() => 'session-1'),
      setActiveSurface: vi.fn(),
      setShowConversation: vi.fn(),
      setIsTextMode: vi.fn(),
      setFlowHistoryOpen,
    });

    act(() => {
      mounted?.getResult().startFreshSession();
    });

    expect(setFlowHistoryOpen).not.toHaveBeenCalled();
  });
});
