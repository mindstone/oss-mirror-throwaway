import { renderHook, act } from '@testing-library/react';
import { mockFullSession } from './helpers';

let capturedOnEvent: ((event: unknown) => void) | null = null;
let capturedOnClose: ((code: number, reason: string) => void) | null = null;
const mockSocketClose = vi.fn();

vi.mock('../cloudClient', async () => {
  const actual = await vi.importActual<typeof import('../cloudClient')>('../cloudClient');
  return {
    ...actual,
    createAgentTurnSocket: vi.fn((_req: unknown, onEvent: (event: unknown) => void, _onError: (err: Error) => void, onClose: (code: number, reason: string) => void) => {
      capturedOnEvent = onEvent;
      capturedOnClose = onClose;
      return { close: mockSocketClose };
    }),
    stopTurn: vi.fn().mockResolvedValue(undefined),
  };
});

const mockFetchSession = vi.fn();
const mockFetchSessions = vi.fn();
const mockSnapshotCompletedSteps = vi.fn();
const mockSnapshotMissionTask = vi.fn();
const mockApplyEventIfNew = vi.fn();
let mockCurrentSession: ReturnType<typeof mockFullSession> | null = null;
const subscribers = new Set<() => void>();

vi.mock('../stores/sessionStore', () => ({
  useSessionStore: Object.assign(
    (selector: (state: { currentSession: unknown }) => unknown) => selector({ currentSession: mockCurrentSession }),
    {
      getState: () => ({
        currentSession: mockCurrentSession,
        error: null,
        fetchSession: mockFetchSession,
        fetchSessions: mockFetchSessions,
        snapshotCompletedSteps: mockSnapshotCompletedSteps,
        snapshotMissionTask: mockSnapshotMissionTask,
        applyEventIfNew: mockApplyEventIfNew,
      }),
      subscribe: (listener: () => void) => {
        subscribers.add(listener);
        return () => subscribers.delete(listener);
      },
      setState: vi.fn(),
    },
  ),
}));

import { useAgentTurn } from '../hooks/useAgentTurn';
import { stopTurn as mockStopTurnImport } from '../cloudClient';
const mockStopTurn = mockStopTurnImport as unknown as ReturnType<typeof vi.fn>;

const setMockCurrentSession = (session: ReturnType<typeof mockFullSession> | null) => {
  mockCurrentSession = session;
  subscribers.forEach((listener) => listener());
};

beforeEach(() => {
  capturedOnEvent = null;
  capturedOnClose = null;
  mockSocketClose.mockClear();
  mockFetchSession.mockReset();
  mockFetchSessions.mockReset();
  mockFetchSessions.mockResolvedValue(undefined);
  mockSnapshotCompletedSteps.mockReset();
  mockSnapshotMissionTask.mockReset();
  mockApplyEventIfNew.mockReset();
  mockApplyEventIfNew.mockReturnValue(true);
  mockStopTurn.mockClear();
  mockCurrentSession = null;
  subscribers.clear();
});

describe('useAgentTurn reducer orchestration integration', () => {
  const start = () => {
    const hook = renderHook(() => useAgentTurn());
    act(() => hook.result.current.startTurn('session-1', 'Hello'));
    return hook;
  };

  it('preserves reducer state while recovery polling starts after a WS drop mid-stream', async () => {
    vi.useFakeTimers();
    mockFetchSession.mockImplementation(async () => setMockCurrentSession(mockFullSession({ id: 'session-1', isBusy: true, activeTurnId: 'turn-1' })));
    const { result } = start();

    act(() => {
      capturedOnEvent!({ type: 'turn_started', turnId: 'turn-1' });
      capturedOnEvent!({ type: 'tool', stage: 'start', toolName: 'Read' });
      capturedOnEvent!({ type: 'tool', stage: 'end', toolName: 'Read' });
      capturedOnEvent!({ type: 'assistant_delta', text: 'partial' });
    });

    await act(async () => {
      capturedOnClose!(1006, '');
      await vi.advanceTimersByTimeAsync(0);
    });

    expect(result.current.isSending).toBe(true);
    expect(result.current.statusText).toBe('Rebel is still working...');
    expect(result.current.completedSteps).toHaveLength(1);
    vi.useRealTimers();
  });

  it('clears the stop-retry timer when a terminal event flips isSending false', async () => {
    vi.useFakeTimers();
    mockFetchSession.mockResolvedValue(undefined);
    const { result } = start();

    act(() => capturedOnEvent!({ type: 'turn_started', turnId: 'turn-1' }));
    await act(async () => {
      result.current.handleStop();
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(mockStopTurn).toHaveBeenCalledTimes(1);

    await act(async () => {
      capturedOnEvent!({ type: 'result', text: 'Done' });
      await vi.advanceTimersByTimeAsync(0);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });

    expect(result.current.isSending).toBe(false);
    expect(mockStopTurn).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });

  it('runs terminal refresh and clears streaming/optimistic messages only after stable session data lands', async () => {
    mockFetchSession.mockImplementation(async () => setMockCurrentSession(mockFullSession({ id: 'session-1', isBusy: false, activeTurnId: null })));
    const { result } = start();

    act(() => capturedOnEvent!({ type: 'assistant_delta', text: 'partial' }));
    expect(result.current.streamingText).toBe('partial');
    expect(result.current.optimisticMessages).toHaveLength(1);

    await act(async () => {
      capturedOnEvent!({ type: 'result', text: 'Done' });
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(mockFetchSession).toHaveBeenCalledWith('session-1');
    expect(mockFetchSessions).toHaveBeenCalled();
    expect(result.current.streamingText).toBe('');
    expect(result.current.optimisticMessages).toHaveLength(0);
  });
});
