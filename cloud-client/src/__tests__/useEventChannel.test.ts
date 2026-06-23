/**
 * useEventChannel hook tests -- connect, reconnect, backoff, isPaired guard, forceReconnect.
 */

import { renderHook, act } from '@testing-library/react';
import { initAuthStore, useAuthStore } from '../auth/createAuthStore';
import type { TokenStorage } from '../auth/types';

// Initialise auth store with a no-op storage adapter for tests
const noopStorage: TokenStorage = {
  getToken: async () => null,
  setToken: async () => {},
  clearToken: async () => {},
};
initAuthStore(noopStorage);

// Mock cloudClient
let onEventCb: ((ch: string, args: unknown[]) => void) | null = null;
let onErrorCb: (() => void) | null = null;
let onCloseCb: (() => void) | null = null;
let onOpenCb: (() => void) | null = null;
const { mockClose, mockLogInfo } = vi.hoisted(() => ({
  mockClose: vi.fn(),
  mockLogInfo: vi.fn(),
}));

vi.mock('../cloudClient', async () => {
  const actual = await vi.importActual<typeof import('../cloudClient')>('../cloudClient');
  return {
    ...actual,
    isConfigured: vi.fn().mockReturnValue(true),
    createEventSocket: vi.fn(
      (onEvent: (ch: string, args: unknown[]) => void, onError: () => void, onClose: () => void, onOpen?: () => void) => {
        onEventCb = onEvent;
        onErrorCb = onError;
        onCloseCb = onClose;
        onOpenCb = onOpen ?? null;
        return { close: mockClose };
      },
    ),
    configure: vi.fn(),
    clearConfig: vi.fn(),
  };
});

vi.mock('../utils/logger', () => ({
  createLogger: () => ({
    info: mockLogInfo,
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

import * as cloudClient from '../cloudClient';
const mockedCreateEventSocket = vi.mocked(cloudClient.createEventSocket);
const mockedIsConfigured = vi.mocked(cloudClient.isConfigured);

import { useEventChannel } from '../hooks/useEventChannel';

/**
 * Seed Math.random to a fixed value for deterministic jitter in tests.
 * The jitter formula is `baseDelay * (0.8 + Math.random() * 0.4)`.
 * With Math.random() = 0.5 → multiplier = 1.0 → delay equals base delay.
 */
let mathRandomSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.useFakeTimers();
  mathRandomSpy = vi.spyOn(Math, 'random').mockReturnValue(0.5);
  useAuthStore.setState({ isPaired: true, cloudUrl: 'https://test.fly.dev', token: 'tok' });
  onEventCb = null;
  onErrorCb = null;
  onCloseCb = null;
  onOpenCb = null;
  mockClose.mockClear();
  mockedCreateEventSocket.mockClear();
  mockedIsConfigured.mockReturnValue(true);
  mockLogInfo.mockClear();
});

afterEach(() => {
  mathRandomSpy.mockRestore();
  vi.useRealTimers();
});

describe('useEventChannel', () => {
  it('connects when paired', () => {
    const handler = vi.fn();
    renderHook(() => useEventChannel(handler));

    expect(mockedCreateEventSocket).toHaveBeenCalledTimes(1);
  });

  it('does not connect when not paired', () => {
    useAuthStore.setState({ isPaired: false });
    const handler = vi.fn();
    renderHook(() => useEventChannel(handler));

    expect(mockedCreateEventSocket).not.toHaveBeenCalled();
  });

  it('forwards events to handler', () => {
    const handler = vi.fn();
    renderHook(() => useEventChannel(handler));

    act(() => {
      onEventCb!('cloud:session-changed', [{ sessionId: 's1', action: 'upserted' }]);
    });

    expect(handler).toHaveBeenCalledWith('cloud:session-changed', [{ sessionId: 's1', action: 'upserted' }]);
  });

  it('reconnects with backoff after close', () => {
    const handler = vi.fn();
    renderHook(() => useEventChannel(handler));

    expect(mockedCreateEventSocket).toHaveBeenCalledTimes(1);

    // Simulate close
    act(() => {
      onCloseCb!();
    });

    // Should schedule reconnect after 1s (base delay, jitter factor = 1.0 with random=0.5)
    expect(mockedCreateEventSocket).toHaveBeenCalledTimes(1);
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(mockedCreateEventSocket).toHaveBeenCalledTimes(2);
  });

  it('increases backoff exponentially', () => {
    const handler = vi.fn();
    renderHook(() => useEventChannel(handler));

    // First close -> 1s backoff (jitter factor = 1.0)
    act(() => { onCloseCb!(); });
    act(() => { vi.advanceTimersByTime(1000); });
    expect(mockedCreateEventSocket).toHaveBeenCalledTimes(2);

    // Second close -> 2s backoff
    act(() => { onCloseCb!(); });
    act(() => { vi.advanceTimersByTime(1999); });
    expect(mockedCreateEventSocket).toHaveBeenCalledTimes(2);
    act(() => { vi.advanceTimersByTime(1); });
    expect(mockedCreateEventSocket).toHaveBeenCalledTimes(3);

    // Third close -> 4s backoff
    act(() => { onCloseCb!(); });
    act(() => { vi.advanceTimersByTime(3999); });
    expect(mockedCreateEventSocket).toHaveBeenCalledTimes(3);
    act(() => { vi.advanceTimersByTime(1); });
    expect(mockedCreateEventSocket).toHaveBeenCalledTimes(4);
  });

  it('resets backoff on successful message', () => {
    const handler = vi.fn();
    renderHook(() => useEventChannel(handler));

    // Close once -> retry count becomes 1
    act(() => { onCloseCb!(); });
    act(() => { vi.advanceTimersByTime(1000); });
    expect(mockedCreateEventSocket).toHaveBeenCalledTimes(2);

    // Receive a message (resets backoff)
    act(() => { onEventCb!('test', []); });

    // Close again -> should use base 1s delay again (not 2s)
    act(() => { onCloseCb!(); });
    act(() => { vi.advanceTimersByTime(1000); });
    expect(mockedCreateEventSocket).toHaveBeenCalledTimes(3);
  });

  it('does not reconnect after unpair', () => {
    const handler = vi.fn();
    renderHook(() => useEventChannel(handler));

    // Unpair
    act(() => {
      useAuthStore.setState({ isPaired: false });
    });

    // Simulate close
    act(() => { onCloseCb!(); });
    act(() => { vi.advanceTimersByTime(30_000); });

    // Should not have reconnected (still just the initial connect)
    expect(mockedCreateEventSocket).toHaveBeenCalledTimes(1);
  });

  it('cleans up on unmount', async () => {
    const handler = vi.fn();
    const { unmount } = renderHook(() => useEventChannel(handler));

    unmount();
    // Close is deferred to next microtask to avoid native TurboModule exceptions
    await vi.waitFor(() => {
      expect(mockClose).toHaveBeenCalled();
    });
  });

  it('caps backoff at 30 seconds', () => {
    const handler = vi.fn();
    renderHook(() => useEventChannel(handler));

    // Close 10 times to hit the cap (2^10 = 1024s, should be capped at 30s)
    for (let i = 0; i < 10; i++) {
      act(() => { onCloseCb!(); });
      act(() => { vi.advanceTimersByTime(30_000); });
    }

    // After many retries, backoff should be capped at 30s, not growing further
    const callCount = mockedCreateEventSocket.mock.calls.length;
    act(() => { onCloseCb!(); });
    act(() => { vi.advanceTimersByTime(30_000); });
    expect(mockedCreateEventSocket).toHaveBeenCalledTimes(callCount + 1);
  });

  it('resets backoff on open (not just on message)', () => {
    const handler = vi.fn();
    renderHook(() => useEventChannel(handler));

    // Close once -> reconnect after 1s
    act(() => { onCloseCb!(); });
    act(() => { vi.advanceTimersByTime(1000); });
    expect(mockedCreateEventSocket).toHaveBeenCalledTimes(2);

    // Trigger onOpen (resets backoff to 0)
    act(() => { onOpenCb!(); });

    // Close again -> should use base 1s delay (backoff was reset on open)
    act(() => { onCloseCb!(); });
    act(() => { vi.advanceTimersByTime(999); });
    expect(mockedCreateEventSocket).toHaveBeenCalledTimes(2);
    act(() => { vi.advanceTimersByTime(1); });
    expect(mockedCreateEventSocket).toHaveBeenCalledTimes(3);
  });

  it('logs sse_reconnect with reconnect attempt, backoff, and disconnected duration', () => {
    const handler = vi.fn();
    renderHook(() => useEventChannel(handler));

    act(() => { onOpenCb!(); });
    act(() => { onCloseCb!(); });
    act(() => { vi.advanceTimersByTime(1000); });
    act(() => { onOpenCb!(); });

    expect(mockLogInfo).toHaveBeenCalledWith('sse_reconnect', expect.objectContaining({
      attemptNum: 1,
      backoffMs: 1000,
      disconnectedDurationMs: expect.any(Number),
    }));
  });

  it('applies jitter to reconnect delay', () => {
    // With random=0.0 → multiplier = 0.8, so 1000ms * 0.8 = 800ms
    mathRandomSpy.mockReturnValue(0.0);

    const handler = vi.fn();
    renderHook(() => useEventChannel(handler));

    act(() => { onCloseCb!(); });

    // At 799ms, should not have reconnected
    act(() => { vi.advanceTimersByTime(799); });
    expect(mockedCreateEventSocket).toHaveBeenCalledTimes(1);

    // At 800ms, should reconnect
    act(() => { vi.advanceTimersByTime(1); });
    expect(mockedCreateEventSocket).toHaveBeenCalledTimes(2);
  });

  describe('forceReconnect', () => {
    it('is a no-op when already connected', () => {
      const handler = vi.fn();
      const { result } = renderHook(() => useEventChannel(handler));

      // Trigger onOpen to mark as connected
      act(() => { onOpenCb!(); });

      // Call forceReconnect — should not create a new socket
      act(() => { result.current.forceReconnect(); });
      expect(mockedCreateEventSocket).toHaveBeenCalledTimes(1);
    });

    it('reconnects immediately when disconnected', () => {
      const handler = vi.fn();
      const { result } = renderHook(() => useEventChannel(handler));

      // Simulate close — schedules reconnect on timer
      act(() => { onCloseCb!(); });
      expect(mockedCreateEventSocket).toHaveBeenCalledTimes(1);

      // Call forceReconnect — should connect immediately (no timer wait)
      act(() => { result.current.forceReconnect(); });
      expect(mockedCreateEventSocket).toHaveBeenCalledTimes(2);
    });

    it('does not create duplicate sockets (intentional close prevents competing reconnect)', async () => {
      const handler = vi.fn();
      const { result } = renderHook(() => useEventChannel(handler));

      // Mark socket as connected
      act(() => { onOpenCb!(); });
      // Simulate disconnection by triggering close
      act(() => { onCloseCb!(); });
      // Now we're disconnected and a reconnect timer is scheduled
      expect(mockedCreateEventSocket).toHaveBeenCalledTimes(1);

      // Call forceReconnect — it sets intentionalCloseRef, then connects immediately
      act(() => { result.current.forceReconnect(); });
      expect(mockedCreateEventSocket).toHaveBeenCalledTimes(2);

      // The old close callback from forceReconnect's queueMicrotask fires —
      // it should NOT schedule another reconnect because intentionalCloseRef was set
      await act(async () => {
        await vi.waitFor(() => {
          // mockClose may or may not be called depending on socket state,
          // but the key assertion is no extra createEventSocket calls
        });
      });

      // Advance all timers — no competing reconnect should fire
      act(() => { vi.advanceTimersByTime(30_000); });
      expect(mockedCreateEventSocket).toHaveBeenCalledTimes(2);
    });

    it('is a no-op when not paired', () => {
      const handler = vi.fn();
      const { result } = renderHook(() => useEventChannel(handler));

      // Unpair
      act(() => { useAuthStore.setState({ isPaired: false }); });

      // Call forceReconnect — should be a no-op
      act(() => { result.current.forceReconnect(); });
      // Only the initial connect from mount (before unpair re-render)
      expect(mockedCreateEventSocket).toHaveBeenCalledTimes(1);
    });
  });

  describe('onReconnect callback', () => {
    it('calls onReconnect on reconnection but not on initial connect', () => {
      const handler = vi.fn();
      const onReconnect = vi.fn();
      renderHook(() => useEventChannel(handler, undefined, onReconnect));

      // Initial connect — trigger onOpen
      act(() => { onOpenCb!(); });
      expect(onReconnect).not.toHaveBeenCalled();

      // Close and reconnect
      act(() => { onCloseCb!(); });
      act(() => { vi.advanceTimersByTime(1000); });
      // Second onOpen — this is a reconnect
      act(() => { onOpenCb!(); });
      expect(onReconnect).toHaveBeenCalledTimes(1);
    });
  });
});
