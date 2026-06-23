// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  renderHook,
  act,
  flushAsync,
  createMockWindowApi,
  setupFakeTimers,
  cleanupFakeTimers,
} from '@renderer/test-utils';
import { useOpenRouterSetup, TIMEOUT_HINT_MS } from '../useOpenRouterSetup';
import type { SetupPhase } from '../useOpenRouterSetup';

type SetupResult =
  | { outcome: 'success'; maskedKey: string }
  | { outcome: 'cancelled' }
  | { outcome: 'error'; error: string };

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

let mockApi: {
  setupToken: ReturnType<typeof vi.fn>;
  cancelSetup: ReturnType<typeof vi.fn>;
  disconnect: ReturnType<typeof vi.fn>;
};

beforeEach(() => {
  setupFakeTimers();
  mockApi = createMockWindowApi('openRouterApi', {
    setupToken: vi.fn(() => new Promise<SetupResult>(() => {})),
    cancelSetup: vi.fn(),
    disconnect: vi.fn(() => Promise.resolve()),
  });
});

afterEach(() => {
  cleanupFakeTimers();
  vi.restoreAllMocks();
});

describe('useOpenRouterSetup', () => {
  describe('exports', () => {
    it('exports TIMEOUT_HINT_MS as 45000', () => {
      expect(TIMEOUT_HINT_MS).toBe(45_000);
    });

    it('SetupPhase type includes waiting', () => {
      const phases: SetupPhase[] = ['idle', 'connecting', 'waiting', 'success', 'error'];
      expect(phases).toHaveLength(5);
    });
  });

  describe('initial state', () => {
    it('starts in idle phase with no loading or waiting message', () => {
      const { result } = renderHook(() => useOpenRouterSetup(false));

      expect(result.current.phase).toBe('idle');
      expect(result.current.isLoading).toBe(false);
      expect(result.current.waitingMessage).toBeNull();
      expect(result.current.error).toBeNull();
      expect(result.current.maskedToken).toBeNull();
      expect(result.current.buttonLabel).toBe('Connect');
    });

    it('starts in success phase when hasToken is true', () => {
      const { result } = renderHook(() => useOpenRouterSetup(true));

      expect(result.current.phase).toBe('success');
      expect(result.current.isLoading).toBe(false);
    });
  });

  describe('connect flow', () => {
    it('transitions to connecting phase on handleConnect', () => {
      const { result } = renderHook(() => useOpenRouterSetup(false));

      act(() => {
        result.current.handleConnect();
      });

      expect(result.current.phase).toBe('connecting');
      expect(result.current.isLoading).toBe(true);
      expect(result.current.buttonLabel).toBe('Connecting\u2026');
      expect(result.current.waitingMessage).toBeNull();
      expect(mockApi.setupToken).toHaveBeenCalledOnce();
    });

    it('ignores handleConnect when already connecting', () => {
      const { result } = renderHook(() => useOpenRouterSetup(false));

      act(() => {
        result.current.handleConnect();
      });
      act(() => {
        result.current.handleConnect();
      });

      expect(mockApi.setupToken).toHaveBeenCalledOnce();
    });
  });

  describe('timeout → waiting phase', () => {
    it('transitions to waiting after TIMEOUT_HINT_MS', () => {
      const { result } = renderHook(() => useOpenRouterSetup(false));

      act(() => {
        result.current.handleConnect();
      });
      expect(result.current.phase).toBe('connecting');

      act(() => {
        vi.advanceTimersByTime(TIMEOUT_HINT_MS);
      });

      expect(result.current.phase).toBe('waiting');
      expect(result.current.isLoading).toBe(true);
      expect(result.current.waitingMessage).toBe(
        'Still waiting? Sometimes OpenRouter forgets to let us know. Try connecting again.',
      );
      expect(result.current.buttonLabel).toBe('Connecting\u2026');
    });

    it('does not transition before TIMEOUT_HINT_MS', () => {
      const { result } = renderHook(() => useOpenRouterSetup(false));

      act(() => {
        result.current.handleConnect();
      });
      act(() => {
        vi.advanceTimersByTime(TIMEOUT_HINT_MS - 1);
      });

      expect(result.current.phase).toBe('connecting');
      expect(result.current.waitingMessage).toBeNull();
    });
  });

  describe('success flow', () => {
    it('transitions to success when setupToken resolves with success', async () => {
      const deferred = createDeferred<SetupResult>();
      mockApi.setupToken.mockReturnValueOnce(deferred.promise);

      const { result } = renderHook(() => useOpenRouterSetup(false));

      act(() => {
        result.current.handleConnect();
      });
      expect(result.current.phase).toBe('connecting');

      deferred.resolve({ outcome: 'success', maskedKey: 'sk-...abc' });
      await flushAsync();

      expect(result.current.phase).toBe('success');
      expect(result.current.maskedToken).toBe('sk-...abc');
      expect(result.current.error).toBeNull();
      expect(result.current.isLoading).toBe(false);
      expect(result.current.buttonLabel).toBe('Connected (sk-...abc)');
    });

    it('transitions to success when setupToken resolves during waiting phase', async () => {
      const deferred = createDeferred<SetupResult>();
      mockApi.setupToken.mockReturnValueOnce(deferred.promise);

      const { result } = renderHook(() => useOpenRouterSetup(false));

      act(() => {
        result.current.handleConnect();
      });
      act(() => {
        vi.advanceTimersByTime(TIMEOUT_HINT_MS);
      });
      expect(result.current.phase).toBe('waiting');

      deferred.resolve({ outcome: 'success', maskedKey: 'sk-...late' });
      await flushAsync();

      expect(result.current.phase).toBe('success');
      expect(result.current.maskedToken).toBe('sk-...late');
      expect(result.current.isLoading).toBe(false);
      expect(result.current.waitingMessage).toBeNull();
    });

    it('clears timeout on success', async () => {
      const deferred = createDeferred<SetupResult>();
      mockApi.setupToken.mockReturnValueOnce(deferred.promise);

      const { result } = renderHook(() => useOpenRouterSetup(false));

      act(() => {
        result.current.handleConnect();
      });

      deferred.resolve({ outcome: 'success', maskedKey: 'sk-...xyz' });
      await flushAsync();

      expect(result.current.phase).toBe('success');

      // Advancing timers should NOT change phase back to waiting
      act(() => {
        vi.advanceTimersByTime(TIMEOUT_HINT_MS);
      });
      expect(result.current.phase).toBe('success');
    });
  });

  describe('cancelled flow', () => {
    it('returns to idle when setupToken resolves with cancelled', async () => {
      const deferred = createDeferred<SetupResult>();
      mockApi.setupToken.mockReturnValueOnce(deferred.promise);

      const { result } = renderHook(() => useOpenRouterSetup(false));

      act(() => {
        result.current.handleConnect();
      });

      deferred.resolve({ outcome: 'cancelled' });
      await flushAsync();

      expect(result.current.phase).toBe('idle');
      expect(result.current.error).toBeNull();
    });
  });

  describe('error flow', () => {
    it('transitions to error when setupToken resolves with error', async () => {
      const deferred = createDeferred<SetupResult>();
      mockApi.setupToken.mockReturnValueOnce(deferred.promise);

      const { result } = renderHook(() => useOpenRouterSetup(false));

      act(() => {
        result.current.handleConnect();
      });

      deferred.resolve({ outcome: 'error', error: 'Token validation failed' });
      await flushAsync();

      expect(result.current.phase).toBe('error');
      expect(result.current.error).toBe('Token validation failed');
      expect(result.current.buttonLabel).toBe('Try again');
    });

    it('transitions to error when setupToken resolves with error during waiting phase', async () => {
      const deferred = createDeferred<SetupResult>();
      mockApi.setupToken.mockReturnValueOnce(deferred.promise);

      const { result } = renderHook(() => useOpenRouterSetup(false));

      act(() => {
        result.current.handleConnect();
      });
      act(() => {
        vi.advanceTimersByTime(TIMEOUT_HINT_MS);
      });
      expect(result.current.phase).toBe('waiting');

      deferred.resolve({ outcome: 'error', error: 'Expired token' });
      await flushAsync();

      expect(result.current.phase).toBe('error');
      expect(result.current.error).toBe('Expired token');
      expect(result.current.isLoading).toBe(false);
      expect(result.current.waitingMessage).toBeNull();
    });

    it('transitions to error when setupToken throws', async () => {
      const deferred = createDeferred<SetupResult>();
      mockApi.setupToken.mockReturnValueOnce(deferred.promise);

      const { result } = renderHook(() => useOpenRouterSetup(false));

      act(() => {
        result.current.handleConnect();
      });

      deferred.reject(new Error('Network failure'));
      await flushAsync();

      expect(result.current.phase).toBe('error');
      expect(result.current.error).toBe("Couldn't connect. Try again.");
    });
  });

  describe('cancel flow', () => {
    it('returns to idle and calls cancelSetup', () => {
      const { result } = renderHook(() => useOpenRouterSetup(false));

      act(() => {
        result.current.handleConnect();
      });
      expect(result.current.phase).toBe('connecting');

      act(() => {
        result.current.handleCancel();
      });

      expect(result.current.phase).toBe('idle');
      expect(result.current.error).toBeNull();
      expect(result.current.isLoading).toBe(false);
      expect(mockApi.cancelSetup).toHaveBeenCalledOnce();
    });

    it('clears pending timeout on cancel', () => {
      const { result } = renderHook(() => useOpenRouterSetup(false));

      act(() => {
        result.current.handleConnect();
      });
      act(() => {
        result.current.handleCancel();
      });

      // Timeout should not fire after cancel
      act(() => {
        vi.advanceTimersByTime(TIMEOUT_HINT_MS);
      });
      expect(result.current.phase).toBe('idle');
    });
  });

  describe('retry flow', () => {
    it('resets to connecting, calls cancelSetup, and starts new timer', () => {
      const { result } = renderHook(() => useOpenRouterSetup(false));

      act(() => {
        result.current.handleConnect();
      });
      act(() => {
        vi.advanceTimersByTime(TIMEOUT_HINT_MS);
      });
      expect(result.current.phase).toBe('waiting');

      act(() => {
        result.current.handleRetry();
      });

      expect(result.current.phase).toBe('connecting');
      expect(result.current.isLoading).toBe(true);
      expect(result.current.waitingMessage).toBeNull();
      expect(mockApi.cancelSetup).toHaveBeenCalledOnce();
      // setupToken called twice: once for connect, once for retry
      expect(mockApi.setupToken).toHaveBeenCalledTimes(2);
    });

    it('new timer fires after retry', () => {
      const { result } = renderHook(() => useOpenRouterSetup(false));

      act(() => {
        result.current.handleConnect();
      });
      act(() => {
        vi.advanceTimersByTime(TIMEOUT_HINT_MS);
      });
      expect(result.current.phase).toBe('waiting');

      act(() => {
        result.current.handleRetry();
      });
      expect(result.current.phase).toBe('connecting');

      act(() => {
        vi.advanceTimersByTime(TIMEOUT_HINT_MS);
      });
      expect(result.current.phase).toBe('waiting');
    });
  });

  describe('request ID guard', () => {
    it('ignores stale setupToken resolution after cancel', async () => {
      const deferred = createDeferred<SetupResult>();
      mockApi.setupToken.mockReturnValueOnce(deferred.promise);

      const { result } = renderHook(() => useOpenRouterSetup(false));

      act(() => {
        result.current.handleConnect();
      });
      act(() => {
        result.current.handleCancel();
      });
      expect(result.current.phase).toBe('idle');

      // Original setupToken resolves after cancel — should be ignored
      deferred.resolve({ outcome: 'success', maskedKey: 'sk-...stale' });
      await flushAsync();

      expect(result.current.phase).toBe('idle');
      expect(result.current.maskedToken).toBeNull();
    });

    it('ignores stale setupToken resolution after retry', async () => {
      const deferredFirst = createDeferred<SetupResult>();
      const deferredSecond = createDeferred<SetupResult>();
      mockApi.setupToken
        .mockReturnValueOnce(deferredFirst.promise)
        .mockReturnValueOnce(deferredSecond.promise);

      const { result } = renderHook(() => useOpenRouterSetup(false));

      act(() => {
        result.current.handleConnect();
      });
      act(() => {
        result.current.handleRetry();
      });
      expect(result.current.phase).toBe('connecting');

      // First (stale) promise resolves — should be ignored
      deferredFirst.resolve({ outcome: 'success', maskedKey: 'sk-...stale' });
      await flushAsync();
      expect(result.current.phase).toBe('connecting');

      // Second (current) promise resolves — should be applied
      deferredSecond.resolve({ outcome: 'success', maskedKey: 'sk-...current' });
      await flushAsync();
      expect(result.current.phase).toBe('success');
      expect(result.current.maskedToken).toBe('sk-...current');
    });

    it('ignores stale timeout after cancel', () => {
      const { result } = renderHook(() => useOpenRouterSetup(false));

      act(() => {
        result.current.handleConnect();
      });
      act(() => {
        result.current.handleCancel();
      });

      // Timeout from first connect should not fire
      act(() => {
        vi.advanceTimersByTime(TIMEOUT_HINT_MS);
      });
      expect(result.current.phase).toBe('idle');
    });
  });

  describe('external token sync', () => {
    it('transitions to success when hasToken becomes true', () => {
      const { result, rerender } = renderHook(
        (props: { hasToken: boolean }) => useOpenRouterSetup(props.hasToken),
        { initialProps: { hasToken: false } },
      );

      expect(result.current.phase).toBe('idle');

      rerender({ hasToken: true });

      expect(result.current.phase).toBe('success');
      expect(result.current.error).toBeNull();
    });

    it('transitions to idle when hasToken becomes false from success', () => {
      const { result, rerender } = renderHook(
        (props: { hasToken: boolean }) => useOpenRouterSetup(props.hasToken),
        { initialProps: { hasToken: true } },
      );

      expect(result.current.phase).toBe('success');

      rerender({ hasToken: false });

      expect(result.current.phase).toBe('idle');
      expect(result.current.maskedToken).toBeNull();
    });

    it('clears timeout when hasToken becomes true during connecting', () => {
      const { result, rerender } = renderHook(
        (props: { hasToken: boolean }) => useOpenRouterSetup(props.hasToken),
        { initialProps: { hasToken: false } },
      );

      act(() => {
        result.current.handleConnect();
      });
      expect(result.current.phase).toBe('connecting');

      rerender({ hasToken: true });
      expect(result.current.phase).toBe('success');

      // Timeout should not fire
      act(() => {
        vi.advanceTimersByTime(TIMEOUT_HINT_MS);
      });
      expect(result.current.phase).toBe('success');
    });

    it('transitions to success when hasToken becomes true during waiting phase', () => {
      const deferred = createDeferred<SetupResult>();
      mockApi.setupToken.mockReturnValueOnce(deferred.promise);

      const { result, rerender } = renderHook(
        (props: { hasToken: boolean }) => useOpenRouterSetup(props.hasToken),
        { initialProps: { hasToken: false } },
      );

      act(() => {
        result.current.handleConnect();
      });
      expect(result.current.phase).toBe('connecting');

      // Advance into waiting phase
      act(() => {
        vi.advanceTimersByTime(TIMEOUT_HINT_MS);
      });
      expect(result.current.phase).toBe('waiting');

      // External hasToken sync arrives (e.g. settings broadcast)
      rerender({ hasToken: true });
      expect(result.current.phase).toBe('success');
      expect(result.current.error).toBeNull();
      expect(result.current.waitingMessage).toBeNull();
    });
  });

  describe('disconnect flow', () => {
    it('calls disconnect and returns to idle', async () => {
      const { result } = renderHook(() => useOpenRouterSetup(true));

      expect(result.current.phase).toBe('success');

      await act(async () => {
        await result.current.handleDisconnect();
      });

      expect(result.current.phase).toBe('idle');
      expect(result.current.maskedToken).toBeNull();
      expect(result.current.error).toBeNull();
      expect(mockApi.disconnect).toHaveBeenCalledOnce();
    });

    it('returns to idle even if disconnect throws', async () => {
      mockApi.disconnect.mockRejectedValueOnce(new Error('Network error'));

      const { result } = renderHook(() => useOpenRouterSetup(true));

      await act(async () => {
        await result.current.handleDisconnect();
      });

      expect(result.current.phase).toBe('idle');
      expect(result.current.maskedToken).toBeNull();
    });
  });

  describe('unmount cleanup', () => {
    it('invalidates in-flight setup on unmount', async () => {
      const deferred = createDeferred<SetupResult>();
      mockApi.setupToken.mockReturnValueOnce(deferred.promise);

      const { result, unmount } = renderHook(() => useOpenRouterSetup(false));

      act(() => {
        result.current.handleConnect();
      });

      unmount();

      // Resolving after unmount should not throw
      deferred.resolve({ outcome: 'success', maskedKey: 'sk-...after-unmount' });
      await flushAsync();
    });
  });
});
