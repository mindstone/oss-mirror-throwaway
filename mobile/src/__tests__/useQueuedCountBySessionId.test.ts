/**
 * useQueuedCountBySessionId tests — verify correct count per session ID.
 */

import { renderHook, act } from '@testing-library/react-native';
import type { OfflineQueueState, QueueItem } from '@rebel/cloud-client';

// ---------------------------------------------------------------------------
// Mock offline queue store
// ---------------------------------------------------------------------------

let mockItems: QueueItem[] = [];
const subscribers = new Set<(state: OfflineQueueState) => void>();

const mockStore = {
  getState: () => ({ items: mockItems }) as unknown as OfflineQueueState,
  subscribe: (listener: (state: OfflineQueueState) => void) => {
    subscribers.add(listener);
    return () => { subscribers.delete(listener); };
  },
};

jest.mock('@rebel/cloud-client', () => ({
  useOfflineQueueStore: mockStore,
}));

function emitStoreUpdate() {
  const state = mockStore.getState();
  for (const listener of subscribers) {
    listener(state);
  }
}

function makeQueueItem(overrides: Partial<QueueItem>): QueueItem {
  return {
    id: `item-${Math.random().toString(36).slice(2, 6)}`,
    type: 'text-message',
    status: 'pending',
    enqueuedAt: Date.now(),
    attempts: 0,
    payloadUri: null,
    metadata: {},
    isPermanentFailure: false,
    lastError: undefined,
    ...overrides,
  } as QueueItem;
}

// ---------------------------------------------------------------------------
// Import after mocks
// ---------------------------------------------------------------------------

import { useQueuedCountBySessionId } from '../hooks/useQueuedCountBySessionId';

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('useQueuedCountBySessionId', () => {
  beforeEach(() => {
    mockItems = [];
    subscribers.clear();
  });

  it('returns 0 when queue is empty', () => {
    const { result } = renderHook(() => useQueuedCountBySessionId('session-1'));
    expect(result.current).toBe(0);
  });

  it('returns count of items matching the session ID', () => {
    mockItems = [
      makeQueueItem({ metadata: { sessionId: 'session-1', prompt: 'Hello' } }),
      makeQueueItem({ metadata: { sessionId: 'session-1', prompt: 'World' } }),
      makeQueueItem({ metadata: { sessionId: 'session-2', prompt: 'Other' } }),
    ];

    const { result } = renderHook(() => useQueuedCountBySessionId('session-1'));
    expect(result.current).toBe(2);
  });

  it('excludes permanently failed items from count', () => {
    mockItems = [
      makeQueueItem({ metadata: { sessionId: 'session-1', prompt: 'OK' } }),
      makeQueueItem({ metadata: { sessionId: 'session-1', prompt: 'Bad' }, isPermanentFailure: true }),
    ];

    const { result } = renderHook(() => useQueuedCountBySessionId('session-1'));
    expect(result.current).toBe(1);
  });

  it('returns 0 when no items match', () => {
    mockItems = [
      makeQueueItem({ metadata: { sessionId: 'session-2', prompt: 'Other' } }),
    ];

    const { result } = renderHook(() => useQueuedCountBySessionId('session-1'));
    expect(result.current).toBe(0);
  });

  it('updates when store emits a change', () => {
    mockItems = [];
    const { result } = renderHook(() => useQueuedCountBySessionId('session-1'));
    expect(result.current).toBe(0);

    act(() => {
      mockItems = [
        makeQueueItem({ metadata: { sessionId: 'session-1', prompt: 'New' } }),
      ];
      emitStoreUpdate();
    });

    expect(result.current).toBe(1);
  });

  it('handles multiple sessions independently', () => {
    mockItems = [
      makeQueueItem({ metadata: { sessionId: 'a', prompt: '1' } }),
      makeQueueItem({ metadata: { sessionId: 'a', prompt: '2' } }),
      makeQueueItem({ metadata: { sessionId: 'a', prompt: '3' } }),
      makeQueueItem({ metadata: { sessionId: 'b', prompt: '4' } }),
    ];

    const hookA = renderHook(() => useQueuedCountBySessionId('a'));
    const hookB = renderHook(() => useQueuedCountBySessionId('b'));

    expect(hookA.result.current).toBe(3);
    expect(hookB.result.current).toBe(1);
  });
});
