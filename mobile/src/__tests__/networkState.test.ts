import { renderHook, act } from '@testing-library/react-native';
import { useNetworkState } from '../hooks/useNetworkState';

// ---------------------------------------------------------------------------
// NetInfo mock
// ---------------------------------------------------------------------------

type NetInfoCallback = (state: {
  isConnected: boolean | null;
  isInternetReachable: boolean | null;
}) => void;

let netInfoCallback: NetInfoCallback | null = null;

jest.mock('@react-native-community/netinfo', () => ({
  addEventListener: jest.fn((callback: NetInfoCallback) => {
    netInfoCallback = callback;
    return jest.fn(); // unsubscribe
  }),
  fetch: jest.fn().mockResolvedValue({ isConnected: true, isInternetReachable: true }),
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function simulateNetInfo(state: { isConnected: boolean | null; isInternetReachable: boolean | null }) {
  if (netInfoCallback) {
    netInfoCallback(state);
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('useNetworkState', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    netInfoCallback = null;
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('starts with optimistic online state', () => {
    const { result } = renderHook(() => useNetworkState());
    expect(result.current.isOnline).toBe(true);
    expect(result.current.isConnected).toBe(true);
  });

  it('isConnected=true, isInternetReachable=true → isOnline=true immediately', () => {
    const { result } = renderHook(() => useNetworkState());

    act(() => {
      simulateNetInfo({ isConnected: true, isInternetReachable: true });
      jest.advanceTimersByTime(300); // debounce
    });

    expect(result.current.isOnline).toBe(true);
    expect(result.current.isInternetReachable).toBe(true);
    expect(result.current.isConnected).toBe(true);
  });

  it('isConnected=true, isInternetReachable=false (captive portal) → isOnline=false after debounce', () => {
    const { result } = renderHook(() => useNetworkState());

    act(() => {
      simulateNetInfo({ isConnected: true, isInternetReachable: false });
      jest.advanceTimersByTime(300); // debounce
    });

    expect(result.current.isOnline).toBe(false);
    expect(result.current.isInternetReachable).toBe(false);
    expect(result.current.isConnected).toBe(true);
  });

  it('isConnected=false → isOnline=false regardless of isInternetReachable', () => {
    const { result } = renderHook(() => useNetworkState());

    act(() => {
      simulateNetInfo({ isConnected: false, isInternetReachable: null });
      jest.advanceTimersByTime(300);
    });

    expect(result.current.isOnline).toBe(false);
    expect(result.current.isConnected).toBe(false);
  });

  it('isConnected=true, isInternetReachable=null → isOnline=true for 3s, then false', () => {
    const { result } = renderHook(() => useNetworkState());

    act(() => {
      simulateNetInfo({ isConnected: true, isInternetReachable: null });
      jest.advanceTimersByTime(300); // debounce
    });

    // During grace window: isOnline should be true
    expect(result.current.isOnline).toBe(true);
    expect(result.current.isInternetReachable).toBeNull();

    // After 3s grace: isOnline should be false
    act(() => {
      jest.advanceTimersByTime(3000);
    });

    expect(result.current.isOnline).toBe(false);
    expect(result.current.isInternetReachable).toBeNull();
  });

  it('grace window resets when isInternetReachable becomes true', () => {
    const { result } = renderHook(() => useNetworkState());

    // Start with null (grace window starts)
    act(() => {
      simulateNetInfo({ isConnected: true, isInternetReachable: null });
      jest.advanceTimersByTime(300);
    });

    expect(result.current.isOnline).toBe(true);

    // Before grace expires, reachable becomes true
    act(() => {
      simulateNetInfo({ isConnected: true, isInternetReachable: true });
      jest.advanceTimersByTime(300);
    });

    expect(result.current.isOnline).toBe(true);

    // Even after 3s, still online because isInternetReachable is now true
    act(() => {
      jest.advanceTimersByTime(3000);
    });

    expect(result.current.isOnline).toBe(true);
  });

  it('debounces rapid toggles (300ms)', () => {
    const { result } = renderHook(() => useNetworkState());

    // Rapid toggles within 300ms
    act(() => {
      simulateNetInfo({ isConnected: false, isInternetReachable: false });
      jest.advanceTimersByTime(100);
      simulateNetInfo({ isConnected: true, isInternetReachable: true });
      jest.advanceTimersByTime(100);
      simulateNetInfo({ isConnected: false, isInternetReachable: false });
      jest.advanceTimersByTime(100);
      // Only the last state should apply after debounce
      simulateNetInfo({ isConnected: true, isInternetReachable: true });
      jest.advanceTimersByTime(300);
    });

    // Final state should win
    expect(result.current.isOnline).toBe(true);
    expect(result.current.isConnected).toBe(true);
    expect(result.current.isInternetReachable).toBe(true);
  });
});
