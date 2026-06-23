// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@renderer/test-utils/hookTestHarness';

// Controllable mock store state
let mockStoreState: {
  currentSessionId: string;
  showConversation: boolean;
  privateMode: boolean;
  sessionSummaries: Array<{
    id: string;
    title: string | null;
    createdAt: number;
    updatedAt: number;
    isBusy: boolean;
    messageCount: number;
    preview: string;
    doneAt: number | null;
    starredAt: number | null;
    origin: string;
    deletedAt: number | null;
    resolvedAt: number | null;
    privateMode?: boolean;
    activeTurnId: string | null;
  }>;
};

let storeSubscribers: Set<() => void>;

vi.mock('@renderer/features/agent-session/store/sessionStore', () => {
  storeSubscribers = new Set();
  return {
    getSessionStoreState: () => mockStoreState,
    subscribeToSessionStore: (cb: () => void) => {
      storeSubscribers.add(cb);
      return () => storeSubscribers.delete(cb);
    },
  };
});

// Must import after mock setup
const { useActiveSession } = await import('../useActiveSession');

function makeSummary(overrides: Partial<typeof mockStoreState.sessionSummaries[0]> = {}) {
  return {
    id: 'session-1',
    title: 'Test Chat',
    createdAt: 1000,
    updatedAt: 2000,
    isBusy: false,
    messageCount: 5,
    preview: 'Hello world',
    doneAt: null,
    starredAt: null,
    origin: 'manual',
    deletedAt: null,
    resolvedAt: null,
    privateMode: false,
    activeTurnId: null,
    ...overrides,
  };
}

describe('useActiveSession', () => {
  beforeEach(() => {
    mockStoreState = {
      currentSessionId: 'session-1',
      showConversation: true,
      privateMode: false,
      sessionSummaries: [makeSummary()],
    };
  });

  afterEach(() => {
    storeSubscribers.clear();
  });

  it('returns the current session when viewing a conversation', () => {
    const { result, unmount } = renderHook(() => useActiveSession());
    expect(result.current).not.toBeNull();
    expect(result.current!.id).toBe('session-1');
    expect(result.current!.title).toBe('Test Chat');
    expect(result.current!.isCurrentSession).toBe(true);
    expect(result.current!.origin).toBe('manual');
    unmount();
  });

  it('returns null when showConversation is false', () => {
    mockStoreState.showConversation = false;
    const { result, unmount } = renderHook(() => useActiveSession());
    expect(result.current).toBeNull();
    unmount();
  });

  it('returns null when current session is private (store-level privateMode)', () => {
    mockStoreState.privateMode = true;
    const { result, unmount } = renderHook(() => useActiveSession());
    expect(result.current).toBeNull();
    unmount();
  });

  it('returns null when current session summary has privateMode', () => {
    mockStoreState.sessionSummaries = [makeSummary({ privateMode: true })];
    const { result, unmount } = renderHook(() => useActiveSession());
    expect(result.current).toBeNull();
    unmount();
  });

  it('returns null when currentSessionId has no matching summary', () => {
    mockStoreState.currentSessionId = 'nonexistent';
    const { result, unmount } = renderHook(() => useActiveSession());
    expect(result.current).toBeNull();
    unmount();
  });

  it('includes activeTurnId from the summary', () => {
    mockStoreState.sessionSummaries = [makeSummary({ activeTurnId: 'turn-42' })];
    const { result, unmount } = renderHook(() => useActiveSession());
    expect(result.current!.activeTurnId).toBe('turn-42');
    unmount();
  });

  it('includes isBusy from the summary', () => {
    mockStoreState.sessionSummaries = [makeSummary({ isBusy: true })];
    const { result, unmount } = renderHook(() => useActiveSession());
    expect(result.current!.isBusy).toBe(true);
    unmount();
  });

  it('re-renders when store notifies subscribers', () => {
    const { result, unmount } = renderHook(() => useActiveSession());
    expect(result.current!.title).toBe('Test Chat');

    // Update the store
    mockStoreState.sessionSummaries = [makeSummary({ title: 'Updated Title', updatedAt: 3000 })];
    act(() => {
      for (const sub of storeSubscribers) sub();
    });

    expect(result.current!.title).toBe('Updated Title');
    unmount();
  });

  it('transitions from session to null when showConversation becomes false', () => {
    const { result, unmount } = renderHook(() => useActiveSession());
    expect(result.current).not.toBeNull();

    mockStoreState.showConversation = false;
    act(() => {
      for (const sub of storeSubscribers) sub();
    });

    expect(result.current).toBeNull();
    unmount();
  });
});
