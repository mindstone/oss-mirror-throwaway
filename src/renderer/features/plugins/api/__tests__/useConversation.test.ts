// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@renderer/test-utils/hookTestHarness';

// Controllable mock store state
let mockSessionSummaries: Array<{
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

let storeSubscribers: Set<() => void>;

vi.mock('@renderer/features/agent-session/store/sessionStore', () => {
  storeSubscribers = new Set();
  return {
    getSessionStoreState: () => ({
      sessionSummaries: mockSessionSummaries,
    }),
    subscribeToSessionStore: (cb: () => void) => {
      storeSubscribers.add(cb);
      return () => storeSubscribers.delete(cb);
    },
  };
});

// Must import after mock setup
const { useConversation } = await import('../useConversation');

function makeSummary(overrides: Partial<typeof mockSessionSummaries[0]> = {}) {
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

describe('useConversation', () => {
  beforeEach(() => {
    mockSessionSummaries = [makeSummary()];
  });

  afterEach(() => {
    storeSubscribers.clear();
  });

  it('returns the conversation for a valid, non-private session', () => {
    const { result, unmount } = renderHook(() => useConversation('session-1'));
    expect(result.current).not.toBeNull();
    expect(result.current!.id).toBe('session-1');
    expect(result.current!.title).toBe('Test Chat');
    expect(result.current!.origin).toBe('manual');
    unmount();
  });

  it('returns null for a non-existent session', () => {
    const { result, unmount } = renderHook(() => useConversation('nonexistent'));
    expect(result.current).toBeNull();
    unmount();
  });

  it('returns null for a private session', () => {
    mockSessionSummaries = [makeSummary({ privateMode: true })];
    const { result, unmount } = renderHook(() => useConversation('session-1'));
    expect(result.current).toBeNull();
    unmount();
  });

  it('returns summary with deletedAt for deleted sessions', () => {
    mockSessionSummaries = [makeSummary({ deletedAt: 5000 })];
    const { result, unmount } = renderHook(() => useConversation('session-1'));
    expect(result.current).not.toBeNull();
    expect(result.current!.deletedAt).toBe(5000);
    unmount();
  });

  it('includes new fields: origin, deletedAt, resolvedAt', () => {
    mockSessionSummaries = [makeSummary({ origin: 'automation', resolvedAt: 3000 })];
    const { result, unmount } = renderHook(() => useConversation('session-1'));
    expect(result.current!.origin).toBe('automation');
    expect(result.current!.resolvedAt).toBe(3000);
    expect(result.current!.deletedAt).toBeNull();
    unmount();
  });

  it('does not expose internal fields like privateMode or activeTurnId', () => {
    const { result, unmount } = renderHook(() => useConversation('session-1'));
    expect(result.current).not.toHaveProperty('privateMode');
    expect(result.current).not.toHaveProperty('activeTurnId');
    unmount();
  });

  it('re-renders when store changes', () => {
    const { result, unmount } = renderHook(() => useConversation('session-1'));
    expect(result.current!.title).toBe('Test Chat');

    mockSessionSummaries = [makeSummary({ title: 'Renamed Chat' })];
    act(() => {
      for (const sub of storeSubscribers) sub();
    });

    expect(result.current!.title).toBe('Renamed Chat');
    unmount();
  });

  it('transitions to null when session becomes private', () => {
    const { result, unmount } = renderHook(() => useConversation('session-1'));
    expect(result.current).not.toBeNull();

    mockSessionSummaries = [makeSummary({ privateMode: true })];
    act(() => {
      for (const sub of storeSubscribers) sub();
    });

    expect(result.current).toBeNull();
    unmount();
  });

  it('finds the correct session among multiple', () => {
    mockSessionSummaries = [
      makeSummary({ id: 'session-1', title: 'First' }),
      makeSummary({ id: 'session-2', title: 'Second' }),
    ];
    const { result, unmount } = renderHook(() => useConversation('session-2'));
    expect(result.current!.title).toBe('Second');
    unmount();
  });
});
