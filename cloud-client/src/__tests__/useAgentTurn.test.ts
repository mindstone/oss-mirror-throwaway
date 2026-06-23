/**
 * useAgentTurn hook tests — decoupled WS lifecycle.
 *
 * Verifies that unexpected WS close/error does NOT blindly clear isSending,
 * and instead checks session status server-side.
 */

import { renderHook, act } from '@testing-library/react';
import { mockFullSession } from './helpers';

// --- Mock cloudClient ---
let capturedOnEvent: ((event: unknown) => void) | null = null;
let capturedOnError: ((err: Error) => void) | null = null;
let capturedOnClose: ((code: number, reason: string) => void) | null = null;
let capturedRequest: Record<string, unknown> | null = null;
const mockSocketClose = vi.fn();

vi.mock('../cloudClient', async () => {
  const actual = await vi.importActual<typeof import('../cloudClient')>('../cloudClient');
  return {
    ...actual,
    createAgentTurnSocket: vi.fn(
      (
        req: unknown,
        onEvent: (event: unknown) => void,
        onError: (err: Error) => void,
        onClose: (code: number, reason: string) => void,
      ) => {
        capturedRequest = req as Record<string, unknown>;
        capturedOnEvent = onEvent;
        capturedOnError = onError;
        capturedOnClose = onClose;
        return { close: mockSocketClose };
      },
    ),
    stopTurn: vi.fn().mockResolvedValue(undefined),
  };
});

// --- Mock sessionStore ---
// We need fine control over fetchSession and currentSession
const mockFetchSession = vi.fn();
const mockFetchSessions = vi.fn();
const mockSnapshotCompletedSteps = vi.fn();
const mockSnapshotMissionTask = vi.fn();
const mockRecordAppliedSeq = vi.fn();
let mockCurrentSession: ReturnType<typeof mockFullSession> | null = null;
const subscribers = new Set<() => void>();

vi.mock('../stores/sessionStore', () => ({
  useSessionStore: Object.assign(
    // The hook form: useSessionStore(selector) — used for subscribing to currentSession
    (selector: (state: { currentSession: unknown }) => unknown) => {
      // Return the selected value from our mock state
      return selector({ currentSession: mockCurrentSession });
    },
    {
      getState: () => ({
        currentSession: mockCurrentSession,
        fetchSession: mockFetchSession,
        fetchSessions: mockFetchSessions,
        snapshotCompletedSteps: mockSnapshotCompletedSteps,
        snapshotMissionTask: mockSnapshotMissionTask,
        applyEventIfNew: mockRecordAppliedSeq,
        recordAppliedSeq: mockRecordAppliedSeq,
      }),
      subscribe: (listener: () => void) => {
        subscribers.add(listener);
        return () => subscribers.delete(listener);
      },
      setState: vi.fn(),
    },
  ),
}));

import { useAgentTurn, shouldSuppressStatus } from '../hooks/useAgentTurn';
import { stopTurn as mockStopTurnImport } from '../cloudClient';
const mockStopTurn = mockStopTurnImport as unknown as ReturnType<typeof vi.fn>;

function setMockCurrentSession(session: ReturnType<typeof mockFullSession> | null) {
  mockCurrentSession = session;
  // Notify subscribers so the useEffect in the hook re-evaluates
  subscribers.forEach((fn) => fn());
}

beforeEach(() => {
  capturedOnEvent = null;
  capturedOnError = null;
  capturedOnClose = null;
  capturedRequest = null;
  mockCurrentSession = null;
  mockSocketClose.mockClear();
  mockFetchSession.mockReset();
  mockFetchSessions.mockReset();
  mockFetchSessions.mockResolvedValue(undefined);
  mockSnapshotCompletedSteps.mockReset();
  mockSnapshotMissionTask.mockReset();
  mockRecordAppliedSeq.mockReset();
  mockRecordAppliedSeq.mockReturnValue(true);
  subscribers.clear();
});

describe('useAgentTurn — decoupled WS lifecycle', () => {
  function startTurnAndGetCallbacks() {
    const { result, rerender } = renderHook(() => useAgentTurn());

    act(() => {
      result.current.startTurn('session-1', 'Hello');
    });

    expect(capturedOnEvent).not.toBeNull();
    expect(capturedOnClose).not.toBeNull();

    return { result, rerender };
  }

  it('records applied seq for streamed continuity events', () => {
    startTurnAndGetCallbacks();

    act(() => {
      capturedOnEvent!({ type: 'status', message: 'Working...', seq: 7 });
    });

    expect(mockRecordAppliedSeq).toHaveBeenCalledWith(
      'session-1',
      expect.objectContaining({ type: 'status', seq: 7 }),
    );
  });

  it('includes a clientTurnId in each startTurn socket request', () => {
    startTurnAndGetCallbacks();
    expect(capturedRequest).toEqual(expect.objectContaining({
      sessionId: 'session-1',
      prompt: 'Hello',
      clientTurnId: expect.any(String),
    }));
    expect((capturedRequest?.clientTurnId as string).trim().length).toBeGreaterThan(0);
  });

  it('skips applying seq-tracked events when recordAppliedSeq returns false', () => {
    mockRecordAppliedSeq.mockReturnValueOnce(false);
    const { result } = startTurnAndGetCallbacks();

    act(() => {
      capturedOnEvent!({ type: 'status', message: 'Late status update', seq: 4 });
    });

    expect(result.current.statusText).toBeNull();
  });

  it('clears isSending normally on result event', async () => {
    mockFetchSession.mockResolvedValue(undefined);
    const { result } = startTurnAndGetCallbacks();

    expect(result.current.isSending).toBe(true);

    // Simulate result event
    await act(async () => {
      capturedOnEvent!({ type: 'result', text: 'Done', usage: '$0.01' });
      // Allow the fetchSession/fetchSessions promises to settle
      await new Promise((r) => setTimeout(r, 0));
    });

    expect(result.current.isSending).toBe(false);
  });

  it('does not clear isSending on unexpected WS close when turn may still be running', async () => {
    // fetchSession returns a busy session
    mockFetchSession.mockImplementation(async () => {
      setMockCurrentSession(mockFullSession({ id: 'session-1', isBusy: true, activeTurnId: 'turn-1' }));
    });

    const { result } = startTurnAndGetCallbacks();
    expect(result.current.isSending).toBe(true);

    // Simulate turn_started so the hook knows a turn is active
    act(() => {
      capturedOnEvent!({ type: 'turn_started', turnId: 'turn-1' });
    });

    // Simulate abnormal WS close (code 1006)
    await act(async () => {
      capturedOnClose!(1006, '');
      await new Promise((r) => setTimeout(r, 0));
    });

    // isSending should stay true — turn is still running server-side
    expect(result.current.isSending).toBe(true);
    expect(mockFetchSession).toHaveBeenCalledWith('session-1');
  });

  it('clears isSending when session shows turn completed after WS close', async () => {
    // fetchSession returns a non-busy session (turn completed)
    mockFetchSession.mockImplementation(async () => {
      setMockCurrentSession(mockFullSession({ id: 'session-1', isBusy: false, activeTurnId: null }));
    });

    const { result } = startTurnAndGetCallbacks();
    expect(result.current.isSending).toBe(true);

    act(() => {
      capturedOnEvent!({ type: 'turn_started', turnId: 'turn-1' });
    });

    // Simulate abnormal WS close
    await act(async () => {
      capturedOnClose!(1006, '');
      await new Promise((r) => setTimeout(r, 0));
    });

    // isSending should be cleared — turn completed server-side
    expect(result.current.isSending).toBe(false);
  });

  it('keeps isSending when session shows turn still running after WS close', async () => {
    // fetchSession returns a busy session
    mockFetchSession.mockImplementation(async () => {
      setMockCurrentSession(mockFullSession({ id: 'session-1', isBusy: true, activeTurnId: 'turn-1' }));
    });

    const { result } = startTurnAndGetCallbacks();

    act(() => {
      capturedOnEvent!({ type: 'turn_started', turnId: 'turn-1' });
    });

    // Simulate abnormal WS close
    await act(async () => {
      capturedOnClose!(1006, '');
      await new Promise((r) => setTimeout(r, 0));
    });

    expect(result.current.isSending).toBe(true);
    expect(result.current.statusText).toBe('Rebel is still working...');
  });

  it('clears isSending via event channel when session transitions to not busy', async () => {
    // First, fetchSession returns busy (turn still running)
    mockFetchSession.mockImplementation(async () => {
      setMockCurrentSession(mockFullSession({ id: 'session-1', isBusy: true, activeTurnId: 'turn-1' }));
    });

    const { result, rerender } = startTurnAndGetCallbacks();

    act(() => {
      capturedOnEvent!({ type: 'turn_started', turnId: 'turn-1' });
    });

    // Simulate abnormal WS close — hook enters "awaiting event channel" state
    await act(async () => {
      capturedOnClose!(1006, '');
      await new Promise((r) => setTimeout(r, 0));
    });

    expect(result.current.isSending).toBe(true);
    expect(result.current.statusText).toBe('Rebel is still working...');

    // Now simulate the event channel notifying that the session is no longer busy
    act(() => {
      setMockCurrentSession(mockFullSession({ id: 'session-1', isBusy: false, activeTurnId: null }));
      rerender();
    });

    expect(result.current.isSending).toBe(false);
  });

  it('ignores normal WS close (code 1000)', async () => {
    const { result } = startTurnAndGetCallbacks();

    act(() => {
      capturedOnEvent!({ type: 'turn_started', turnId: 'turn-1' });
    });

    // Simulate normal close
    await act(async () => {
      capturedOnClose!(1000, 'Normal closure');
      await new Promise((r) => setTimeout(r, 0));
    });

    // fetchSession should NOT have been called for normal close
    expect(mockFetchSession).not.toHaveBeenCalled();
    // isSending stays true (waiting for result event, not the close event)
    expect(result.current.isSending).toBe(true);
  });

  it('does not clear isSending on WS error when turn may still be running', async () => {
    // fetchSession returns a busy session
    mockFetchSession.mockImplementation(async () => {
      setMockCurrentSession(mockFullSession({ id: 'session-1', isBusy: true, activeTurnId: 'turn-1' }));
    });

    const { result } = startTurnAndGetCallbacks();

    act(() => {
      capturedOnEvent!({ type: 'turn_started', turnId: 'turn-1' });
    });

    // Simulate WS error
    await act(async () => {
      capturedOnError!(new Error('Connection lost'));
      await new Promise((r) => setTimeout(r, 0));
    });

    // isSending should stay true — turn is still running server-side
    expect(result.current.isSending).toBe(true);
    expect(mockFetchSession).toHaveBeenCalledWith('session-1');
  });
});

describe('useAgentTurn — recovery polling', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function startTurnAndGetCallbacks() {
    const { result, rerender } = renderHook(() => useAgentTurn());

    act(() => {
      result.current.startTurn('session-1', 'Hello');
    });

    expect(capturedOnEvent).not.toBeNull();
    expect(capturedOnClose).not.toBeNull();

    return { result, rerender };
  }

  it('starts recovery polling when session is busy after WS close', async () => {
    const setIntervalSpy = vi.spyOn(globalThis, 'setInterval');

    // fetchSession returns a busy session
    mockFetchSession.mockImplementation(async () => {
      setMockCurrentSession(mockFullSession({ id: 'session-1', isBusy: true, activeTurnId: 'turn-1' }));
    });

    const { result } = startTurnAndGetCallbacks();

    act(() => {
      capturedOnEvent!({ type: 'turn_started', turnId: 'turn-1' });
    });

    // Simulate abnormal WS close
    await act(async () => {
      capturedOnClose!(1006, '');
      await vi.advanceTimersByTimeAsync(0);
    });

    expect(result.current.isSending).toBe(true);
    expect(result.current.statusText).toBe('Rebel is still working...');

    // Verify setInterval was called with the recovery poll interval
    const recoveryCall = setIntervalSpy.mock.calls.find(
      (call) => call[1] === 5_000,
    );
    expect(recoveryCall).toBeDefined();

    setIntervalSpy.mockRestore();
  });

  it('stops recovery polling when session becomes not busy via poll', async () => {
    const clearIntervalSpy = vi.spyOn(globalThis, 'clearInterval');

    let pollCallCount = 0;
    mockFetchSession.mockImplementation(async () => {
      pollCallCount++;
      if (pollCallCount <= 1) {
        // Initial check + first poll: still busy
        setMockCurrentSession(mockFullSession({ id: 'session-1', isBusy: true, activeTurnId: 'turn-1' }));
      } else {
        // Second poll: session completed
        setMockCurrentSession(mockFullSession({ id: 'session-1', isBusy: false, activeTurnId: null }));
      }
    });

    const { result } = startTurnAndGetCallbacks();

    act(() => {
      capturedOnEvent!({ type: 'turn_started', turnId: 'turn-1' });
    });

    // Simulate abnormal WS close → triggers checkAndUpdateSessionStatus
    await act(async () => {
      capturedOnClose!(1006, '');
      await vi.advanceTimersByTimeAsync(0);
    });

    expect(result.current.isSending).toBe(true);
    clearIntervalSpy.mockClear();

    // Advance to first poll (5s) — still busy
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
    });

    // Advance to second poll (10s) — session completed
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
    });

    // clearInterval should have been called to stop polling
    expect(clearIntervalSpy).toHaveBeenCalled();

    clearIntervalSpy.mockRestore();
  });

  it('stops recovery polling when new startTurn is called', async () => {
    const clearIntervalSpy = vi.spyOn(globalThis, 'clearInterval');

    mockFetchSession.mockImplementation(async () => {
      setMockCurrentSession(mockFullSession({ id: 'session-1', isBusy: true, activeTurnId: 'turn-1' }));
    });

    const { result } = startTurnAndGetCallbacks();

    act(() => {
      capturedOnEvent!({ type: 'turn_started', turnId: 'turn-1' });
    });

    // Simulate abnormal WS close → triggers recovery polling
    await act(async () => {
      capturedOnClose!(1006, '');
      await vi.advanceTimersByTimeAsync(0);
    });

    expect(result.current.isSending).toBe(true);
    clearIntervalSpy.mockClear();

    // Start a new turn — should clear old recovery polling
    act(() => {
      result.current.startTurn('session-1', 'New question');
    });

    expect(clearIntervalSpy).toHaveBeenCalled();

    clearIntervalSpy.mockRestore();
  });

  it('stops recovery polling after max polls reached', async () => {
    const clearIntervalSpy = vi.spyOn(globalThis, 'clearInterval');

    // Session always busy
    mockFetchSession.mockImplementation(async () => {
      setMockCurrentSession(mockFullSession({ id: 'session-1', isBusy: true, activeTurnId: 'turn-1' }));
    });

    const { result } = startTurnAndGetCallbacks();

    act(() => {
      capturedOnEvent!({ type: 'turn_started', turnId: 'turn-1' });
    });

    // Simulate abnormal WS close → triggers recovery polling
    await act(async () => {
      capturedOnClose!(1006, '');
      await vi.advanceTimersByTimeAsync(0);
    });

    expect(result.current.isSending).toBe(true);
    clearIntervalSpy.mockClear();

    // Advance through all 12 polls (60s total)
    for (let i = 0; i < 12; i++) {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(5_000);
      });
    }

    // clearInterval should have been called after hitting max
    expect(clearIntervalSpy).toHaveBeenCalled();
    // I3 fix: isSending is now cleared after recovery poll exhaustion to prevent
    // permanently stuck sending state. An error is surfaced to the user instead.
    expect(result.current.isSending).toBe(false);
    expect(result.current.error).toBe('Lost connection to Rebel. Your work is saved — check back shortly.');

    clearIntervalSpy.mockRestore();
  });

  it('stops recovery polling when event channel delivers completion', async () => {
    const clearIntervalSpy = vi.spyOn(globalThis, 'clearInterval');

    mockFetchSession.mockImplementation(async () => {
      setMockCurrentSession(mockFullSession({ id: 'session-1', isBusy: true, activeTurnId: 'turn-1' }));
    });

    const { result, rerender } = startTurnAndGetCallbacks();

    act(() => {
      capturedOnEvent!({ type: 'turn_started', turnId: 'turn-1' });
    });

    // Simulate abnormal WS close → triggers recovery polling
    await act(async () => {
      capturedOnClose!(1006, '');
      await vi.advanceTimersByTimeAsync(0);
    });

    expect(result.current.isSending).toBe(true);
    clearIntervalSpy.mockClear();

    // Simulate event channel delivering completion (isBusy→false via store)
    act(() => {
      setMockCurrentSession(mockFullSession({ id: 'session-1', isBusy: false, activeTurnId: null }));
      rerender();
    });

    // isSending should be cleared
    expect(result.current.isSending).toBe(false);
    // clearInterval should have been called to stop recovery polling
    expect(clearIntervalSpy).toHaveBeenCalled();

    clearIntervalSpy.mockRestore();
  });
});

describe('useAgentTurn — completedSteps and thinkingHeadline', () => {
  function startTurnAndGetCallbacks() {
    const { result, rerender } = renderHook(() => useAgentTurn());
    act(() => {
      result.current.startTurn('session-1', 'Hello');
    });
    return { result, rerender };
  }

  it('accumulates completedSteps on tool start/end', () => {
    const { result } = startTurnAndGetCallbacks();

    act(() => {
      capturedOnEvent!({ type: 'tool', stage: 'start', toolName: 'google-calendar' });
    });
    expect(result.current.completedSteps).toHaveLength(0);
    expect(result.current.statusText).toBe('Using google-calendar...');

    act(() => {
      capturedOnEvent!({ type: 'tool', stage: 'end' });
    });
    expect(result.current.completedSteps).toHaveLength(1);
    expect(result.current.completedSteps[0].label).toBe('google-calendar');
    expect(result.current.statusText).toBeNull();
  });

  it('prefers tool start detail over tool end detail when completing a step', () => {
    const { result } = startTurnAndGetCallbacks();
    const startDetail = JSON.stringify({ file_path: '/workspace/src/index.ts' });
    const endDetail = JSON.stringify({ output: 'file contents' });

    act(() => {
      capturedOnEvent!({
        type: 'tool',
        stage: 'start',
        toolName: 'read_file',
        detail: startDetail,
        toolUseId: 'tool-1',
      });
    });

    act(() => {
      capturedOnEvent!({
        type: 'tool',
        stage: 'end',
        toolName: 'read_file',
        detail: endDetail,
        toolUseId: 'tool-1',
      });
    });

    expect(result.current.completedSteps).toHaveLength(1);
    expect(result.current.completedSteps[0]).toMatchObject({
      label: 'read_file',
      toolName: 'read_file',
      toolUseId: 'tool-1',
      detail: startDetail,
    });
  });

  it('accumulates multiple sequential tools', () => {
    const { result } = startTurnAndGetCallbacks();

    act(() => {
      capturedOnEvent!({ type: 'tool', stage: 'start', toolName: 'search' });
    });
    act(() => {
      capturedOnEvent!({ type: 'tool', stage: 'end' });
    });
    act(() => {
      capturedOnEvent!({ type: 'tool', stage: 'start', toolName: 'read-file' });
    });
    act(() => {
      capturedOnEvent!({ type: 'tool', stage: 'end' });
    });

    expect(result.current.completedSteps).toHaveLength(2);
    expect(result.current.completedSteps[0].label).toBe('search');
    expect(result.current.completedSteps[1].label).toBe('read-file');
  });

  it('flushes pending tool on overlapping start', () => {
    const { result } = startTurnAndGetCallbacks();

    act(() => {
      capturedOnEvent!({ type: 'tool', stage: 'start', toolName: 'tool-a' });
    });
    // Another start before end — should flush tool-a
    act(() => {
      capturedOnEvent!({ type: 'tool', stage: 'start', toolName: 'tool-b' });
    });

    expect(result.current.completedSteps).toHaveLength(1);
    expect(result.current.completedSteps[0].label).toBe('tool-a');

    act(() => {
      capturedOnEvent!({ type: 'tool', stage: 'end' });
    });
    expect(result.current.completedSteps).toHaveLength(2);
    expect(result.current.completedSteps[1].label).toBe('tool-b');
  });

  it('handles tool end with toolName but no prior start', () => {
    const { result } = startTurnAndGetCallbacks();

    act(() => {
      capturedOnEvent!({ type: 'tool', stage: 'end', toolName: 'file-search' });
    });

    expect(result.current.completedSteps).toHaveLength(1);
    expect(result.current.completedSteps[0].label).toBe('file-search');
  });

  it('keeps completedSteps on result until next turn starts', async () => {
    mockFetchSession.mockResolvedValue(undefined);
    const { result } = startTurnAndGetCallbacks();

    act(() => {
      capturedOnEvent!({ type: 'tool', stage: 'start', toolName: 'search' });
    });
    act(() => {
      capturedOnEvent!({ type: 'tool', stage: 'end' });
    });
    expect(result.current.completedSteps).toHaveLength(1);

    await act(async () => {
      capturedOnEvent!({ type: 'result', text: 'Done' });
      await new Promise((r) => setTimeout(r, 0));
    });

    expect(result.current.completedSteps).toHaveLength(1);

    act(() => {
      result.current.startTurn('session-1', 'Next turn');
    });

    expect(result.current.completedSteps).toHaveLength(0);
  });

  it('snapshots completedSteps for the active turn before fetching session data on result', async () => {
    mockFetchSession.mockResolvedValue(undefined);
    const { result } = startTurnAndGetCallbacks();

    act(() => {
      capturedOnEvent!({ type: 'turn_started', turnId: 'turn-1' });
      capturedOnEvent!({ type: 'tool', stage: 'start', toolName: 'search' });
      capturedOnEvent!({ type: 'tool', stage: 'end' });
    });

    await act(async () => {
      capturedOnEvent!({ type: 'result', text: 'Done' });
      await new Promise((r) => setTimeout(r, 0));
    });

    expect(mockSnapshotCompletedSteps).toHaveBeenCalledWith(
      'turn-1',
      expect.arrayContaining([
        expect.objectContaining({ label: 'search', toolName: 'search' }),
      ]),
    );

    const snapshotCallOrder = mockSnapshotCompletedSteps.mock.invocationCallOrder[0];
    const fetchSessionCallOrder = mockFetchSession.mock.invocationCallOrder[0];
    expect(snapshotCallOrder).toBeLessThan(fetchSessionCallOrder);

    expect(result.current.completedSteps).toHaveLength(1);
  });

  it('tracks mission context from MissionSet start and end events, then clears it on result', async () => {
    mockFetchSession.mockResolvedValue(undefined);
    const { result } = startTurnAndGetCallbacks();

    act(() => {
      capturedOnEvent!({ type: 'turn_started', turnId: 'turn-1' });
      capturedOnEvent!({
        type: 'tool',
        stage: 'start',
        toolName: 'MissionSet',
        detail: JSON.stringify({ goal: 'Draft launch brief', done_criteria: 'Send for review' }),
      });
    });

    expect(result.current.missionContext).toEqual({
      goal: 'Draft launch brief',
      doneCriteria: 'Send for review',
      constraints: undefined,
    });

    act(() => {
      capturedOnEvent!({
        type: 'tool',
        stage: 'end',
        toolName: 'MissionSet',
        detail: JSON.stringify({ mission: { goal: 'Finalize launch brief', constraints: 'Use approved messaging' } }),
      });
    });

    expect(result.current.missionContext).toEqual({
      goal: 'Finalize launch brief',
      doneCriteria: undefined,
      constraints: 'Use approved messaging',
    });

    await act(async () => {
      capturedOnEvent!({ type: 'result', text: 'Done' });
      await new Promise((r) => setTimeout(r, 0));
    });

    expect(mockSnapshotMissionTask).toHaveBeenCalledWith(
      'turn-1',
      {
        goal: 'Finalize launch brief',
        doneCriteria: undefined,
        constraints: 'Use approved messaging',
      },
      [],
      { hasMissionSet: true, touchedTaskIds: [] },
    );
    expect(result.current.missionContext).toBeNull();
  });

  it('uses TodoWrite tasks until TaskList end data arrives', () => {
    const { result } = startTurnAndGetCallbacks();

    act(() => {
      capturedOnEvent!({
        type: 'tool',
        stage: 'start',
        toolName: 'TodoWrite',
        detail: JSON.stringify({
          todos: [
            { id: 'todo-1', content: 'Gather notes', status: 'in_progress' },
          ],
        }),
      });
    });

    expect(result.current.taskProgress).toEqual([
      { id: 'todo-1', title: 'Gather notes', status: 'in_progress' },
    ]);

    act(() => {
      capturedOnEvent!({
        type: 'tool',
        stage: 'start',
        toolName: 'TaskList',
        detail: JSON.stringify({}),
      });
      capturedOnEvent!({
        type: 'tool',
        stage: 'end',
        toolName: 'TaskList',
        detail: JSON.stringify({
          tasks: [
            { id: 'task-1', title: 'Gather notes', status: 'completed' },
            { id: 'task-2', title: 'Draft summary', status: 'pending' },
          ],
        }),
      });
    });

    expect(result.current.taskProgress).toEqual([
      { id: 'task-1', title: 'Gather notes', status: 'completed' },
      { id: 'task-2', title: 'Draft summary', status: 'pending' },
    ]);

    act(() => {
      capturedOnEvent!({
        type: 'tool',
        stage: 'start',
        toolName: 'TodoWrite',
        detail: JSON.stringify({
          todos: [
            { id: 'todo-2', content: 'Should not overwrite', status: 'completed' },
          ],
        }),
      });
    });

    expect(result.current.taskProgress).toEqual([
      { id: 'task-1', title: 'Gather notes', status: 'completed' },
      { id: 'task-2', title: 'Draft summary', status: 'pending' },
    ]);
  });

  it('clears task progress on error', async () => {
    mockFetchSession.mockResolvedValue(undefined);
    const { result } = startTurnAndGetCallbacks();

    act(() => {
      capturedOnEvent!({
        type: 'tool',
        stage: 'start',
        toolName: 'TodoWrite',
        detail: JSON.stringify({
          todos: [{ id: 'todo-1', content: 'Investigate issue', status: 'in_progress' }],
        }),
      });
    });

    expect(result.current.taskProgress).toEqual([
      { id: 'todo-1', title: 'Investigate issue', status: 'in_progress' },
    ]);

    await act(async () => {
      capturedOnEvent!({ type: 'error', error: 'Boom' });
      await new Promise((r) => setTimeout(r, 0));
    });

    expect(result.current.taskProgress).toEqual([]);
    expect(mockSnapshotMissionTask).not.toHaveBeenCalled();
  });

  it('shows statusText in thinkingHeadline when present', () => {
    const { result } = startTurnAndGetCallbacks();

    act(() => {
      capturedOnEvent!({ type: 'tool', stage: 'start', toolName: 'gmail' });
    });

    expect(result.current.thinkingHeadline).toBe('Using gmail...');
  });

  it('falls back to quip in thinkingHeadline when no statusText', () => {
    const { result } = startTurnAndGetCallbacks();

    // isSending=true, streamingText='', statusText=null → should show quip
    expect(result.current.thinkingHeadline).toBeTruthy();
    expect(result.current.thinkingHeadline).not.toBe('');
  });

  it('returns empty thinkingHeadline when streaming', () => {
    const { result } = startTurnAndGetCallbacks();

    act(() => {
      capturedOnEvent!({ type: 'assistant_delta', text: 'Hello' });
    });

    expect(result.current.thinkingHeadline).toBe('');
  });
});

describe('useAgentTurn — stop retry escalation', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mockStopTurn.mockClear();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function startTurnAndGetCallbacks() {
    const { result, rerender } = renderHook(() => useAgentTurn());
    act(() => {
      result.current.startTurn('session-1', 'Hello');
    });
    expect(capturedOnEvent).not.toBeNull();
    return { result, rerender };
  }

  it('retries stop after 10s to trigger server-side force-kill', async () => {
    const { result } = startTurnAndGetCallbacks();

    act(() => {
      capturedOnEvent!({ type: 'turn_started', turnId: 'turn-1' });
    });

    mockStopTurn.mockClear();
    await act(async () => {
      result.current.handleStop();
      await vi.advanceTimersByTimeAsync(0);
    });

    // First stop call
    expect(mockStopTurn).toHaveBeenCalledTimes(1);
    expect(mockStopTurn).toHaveBeenCalledWith('turn-1');

    // Advance 10s — re-stop should fire
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });

    expect(mockStopTurn).toHaveBeenCalledTimes(2);
  });

  it('surfaces an error when initial stop request fails', async () => {
    mockStopTurn.mockRejectedValueOnce(new Error('stop failed'));
    const { result } = startTurnAndGetCallbacks();

    act(() => {
      capturedOnEvent!({ type: 'turn_started', turnId: 'turn-1' });
    });

    await act(async () => {
      result.current.handleStop();
      await vi.advanceTimersByTimeAsync(0);
    });

    expect(result.current.error).toBe('Couldn\'t stop Rebel — it may still be working.');
  });

  it('surfaces an error when retry stop request fails', async () => {
    mockStopTurn
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('retry stop failed'));

    const { result } = startTurnAndGetCallbacks();

    act(() => {
      capturedOnEvent!({ type: 'turn_started', turnId: 'turn-1' });
    });

    await act(async () => {
      result.current.handleStop();
      await vi.advanceTimersByTimeAsync(0);
    });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });

    expect(mockStopTurn).toHaveBeenCalledTimes(2);
    expect(result.current.error).toBe('Couldn\'t stop Rebel — it may still be working.');
  });

  it('does not retry stop if turn completed before 10s', async () => {
    mockFetchSession.mockResolvedValue(undefined);
    const { result } = startTurnAndGetCallbacks();

    act(() => {
      capturedOnEvent!({ type: 'turn_started', turnId: 'turn-1' });
    });

    mockStopTurn.mockClear();
    await act(async () => {
      result.current.handleStop();
      await vi.advanceTimersByTimeAsync(0);
    });

    expect(mockStopTurn).toHaveBeenCalledTimes(1);

    // Turn completes before the 10s timer
    await act(async () => {
      capturedOnEvent!({ type: 'result', text: 'Done' });
      await vi.advanceTimersByTimeAsync(0);
    });

    // activeTurnIdRef is now null, so retry should no-op
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });

    expect(mockStopTurn).toHaveBeenCalledTimes(1);
  });

  it('clears retry timer when a new turn starts', async () => {
    const { result } = startTurnAndGetCallbacks();

    act(() => {
      capturedOnEvent!({ type: 'turn_started', turnId: 'turn-1' });
    });

    mockStopTurn.mockClear();
    await act(async () => {
      result.current.handleStop();
      await vi.advanceTimersByTimeAsync(0);
    });

    expect(mockStopTurn).toHaveBeenCalledTimes(1);

    // Start a new turn before the retry fires
    act(() => {
      result.current.startTurn('session-1', 'New question');
    });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });

    // Should not have retried the old stop
    expect(mockStopTurn).toHaveBeenCalledTimes(1);
  });

  it('clears retry timer on closeSocket', async () => {
    const { result } = startTurnAndGetCallbacks();

    act(() => {
      capturedOnEvent!({ type: 'turn_started', turnId: 'turn-1' });
    });

    mockStopTurn.mockClear();
    await act(async () => {
      result.current.handleStop();
      await vi.advanceTimersByTimeAsync(0);
    });

    expect(mockStopTurn).toHaveBeenCalledTimes(1);

    // Close socket (unmount)
    act(() => {
      result.current.closeSocket();
    });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });

    // Should not have retried
    expect(mockStopTurn).toHaveBeenCalledTimes(1);
  });
});

describe('useAgentTurn — subAgentItems', () => {
  function startTurnAndGetCallbacks() {
    const { result, rerender } = renderHook(() => useAgentTurn());
    act(() => {
      result.current.startTurn('session-1', 'Hello');
    });
    return { result, rerender };
  }

  it('starts empty, populates on Task tool start event', () => {
    const { result } = startTurnAndGetCallbacks();

    expect(result.current.subAgentItems).toHaveLength(0);

    act(() => {
      capturedOnEvent!({
        type: 'tool',
        stage: 'start',
        toolName: 'Task',
        toolUseId: 'tool-sa-1',
        detail: JSON.stringify({
          subagent_type: 'reviewer-gpt5.5-high',
          description: 'Review the implementation',
          prompt: 'Please review the code changes',
        }),
      });
    });

    expect(result.current.subAgentItems).toHaveLength(1);
    expect(result.current.subAgentItems[0]).toMatchObject({
      toolUseId: 'tool-sa-1',
      label: 'Reviewer Gpt5.5 High',
      subagentType: 'reviewer-gpt5.5-high',
      summary: 'Review the implementation',
      status: 'running',
      isBackground: false,
    });
  });

  it('updates to completed on Task tool end event', () => {
    const { result } = startTurnAndGetCallbacks();

    act(() => {
      capturedOnEvent!({
        type: 'tool',
        stage: 'start',
        toolName: 'Task',
        toolUseId: 'tool-sa-2',
        detail: JSON.stringify({
          subagent_type: 'implementer',
          description: 'Implement the feature',
        }),
      });
    });

    expect(result.current.subAgentItems[0].status).toBe('running');

    act(() => {
      capturedOnEvent!({
        type: 'tool',
        stage: 'end',
        toolName: 'Task',
        toolUseId: 'tool-sa-2',
        detail: 'Implementation complete',
      });
    });

    expect(result.current.subAgentItems).toHaveLength(1);
    expect(result.current.subAgentItems[0]).toMatchObject({
      toolUseId: 'tool-sa-2',
      status: 'completed',
      result: 'Implementation complete',
    });
    expect(result.current.subAgentItems[0].durationMs).toBeDefined();
    expect(result.current.subAgentItems[0].completedAt).toBeDefined();
  });

  it('detects background agent from end event detail', () => {
    const { result } = startTurnAndGetCallbacks();

    act(() => {
      capturedOnEvent!({
        type: 'tool',
        stage: 'start',
        toolName: 'Agent',
        toolUseId: 'tool-bg-1',
        detail: JSON.stringify({
          agent: 'background-worker',
          prompt: 'Process data in background',
        }),
      });
    });

    act(() => {
      capturedOnEvent!({
        type: 'tool',
        stage: 'end',
        toolName: 'Agent',
        toolUseId: 'tool-bg-1',
        detail: 'Async agent launched successfully',
      });
    });

    expect(result.current.subAgentItems).toHaveLength(1);
    expect(result.current.subAgentItems[0]).toMatchObject({
      toolUseId: 'tool-bg-1',
      status: 'running',
      isBackground: true,
    });
    // Should not have completedAt or durationMs
    expect(result.current.subAgentItems[0].completedAt).toBeUndefined();
    expect(result.current.subAgentItems[0].durationMs).toBeUndefined();
  });

  it('detects background agent with "working in the background" pattern', () => {
    const { result } = startTurnAndGetCallbacks();

    act(() => {
      capturedOnEvent!({
        type: 'tool',
        stage: 'start',
        toolName: 'Task',
        toolUseId: 'tool-bg-2',
        detail: JSON.stringify({ subagent_type: 'async-worker' }),
      });
    });

    act(() => {
      capturedOnEvent!({
        type: 'tool',
        stage: 'end',
        toolName: 'Task',
        toolUseId: 'tool-bg-2',
        detail: 'Agent is working in the background',
      });
    });

    expect(result.current.subAgentItems[0]).toMatchObject({
      status: 'running',
      isBackground: true,
    });
  });

  it('preserves subAgentItems after turn result (not cleared)', async () => {
    mockFetchSession.mockResolvedValue(undefined);
    const { result } = startTurnAndGetCallbacks();

    act(() => {
      capturedOnEvent!({
        type: 'tool',
        stage: 'start',
        toolName: 'Task',
        toolUseId: 'tool-sa-persist',
        detail: JSON.stringify({ subagent_type: 'reviewer' }),
      });
    });

    act(() => {
      capturedOnEvent!({
        type: 'tool',
        stage: 'end',
        toolName: 'Task',
        toolUseId: 'tool-sa-persist',
        detail: 'Review done',
      });
    });

    expect(result.current.subAgentItems).toHaveLength(1);

    await act(async () => {
      capturedOnEvent!({ type: 'result', text: 'Done' });
      await new Promise((r) => setTimeout(r, 0));
    });

    // subAgentItems should be preserved after turn result
    expect(result.current.subAgentItems).toHaveLength(1);
    expect(result.current.subAgentItems[0].status).toBe('completed');
  });

  it('clears subAgentItems on next turn start', async () => {
    mockFetchSession.mockResolvedValue(undefined);
    const { result } = startTurnAndGetCallbacks();

    act(() => {
      capturedOnEvent!({
        type: 'tool',
        stage: 'start',
        toolName: 'Task',
        toolUseId: 'tool-sa-clear',
        detail: JSON.stringify({ subagent_type: 'implementer' }),
      });
    });

    expect(result.current.subAgentItems).toHaveLength(1);

    await act(async () => {
      capturedOnEvent!({ type: 'result', text: 'Done' });
      await new Promise((r) => setTimeout(r, 0));
    });

    // Still present after result
    expect(result.current.subAgentItems).toHaveLength(1);

    // Start new turn — should clear
    act(() => {
      result.current.startTurn('session-1', 'Next question');
    });

    expect(result.current.subAgentItems).toHaveLength(0);
  });

  it('tracks multiple subagents simultaneously', () => {
    const { result } = startTurnAndGetCallbacks();

    // Start first subagent
    act(() => {
      capturedOnEvent!({
        type: 'tool',
        stage: 'start',
        toolName: 'Task',
        toolUseId: 'tool-multi-1',
        detail: JSON.stringify({ subagent_type: 'planner' }),
      });
    });

    // Start second subagent (MCP-namespaced)
    act(() => {
      capturedOnEvent!({
        type: 'tool',
        stage: 'start',
        toolName: 'mcp_server/Task',
        toolUseId: 'tool-multi-2',
        detail: JSON.stringify({ subagent_type: 'implementer' }),
      });
    });

    expect(result.current.subAgentItems).toHaveLength(2);
    expect(result.current.subAgentItems[0].label).toBe('Planner');
    expect(result.current.subAgentItems[1].label).toBe('Implementer');

    // Complete first subagent
    act(() => {
      capturedOnEvent!({
        type: 'tool',
        stage: 'end',
        toolName: 'Task',
        toolUseId: 'tool-multi-1',
        detail: 'Planning complete',
      });
    });

    expect(result.current.subAgentItems[0].status).toBe('completed');
    expect(result.current.subAgentItems[1].status).toBe('running');

    // Complete second subagent
    act(() => {
      capturedOnEvent!({
        type: 'tool',
        stage: 'end',
        toolName: 'mcp_server/Task',
        toolUseId: 'tool-multi-2',
        detail: 'Implementation done',
      });
    });

    expect(result.current.subAgentItems).toHaveLength(2);
    expect(result.current.subAgentItems[0].status).toBe('completed');
    expect(result.current.subAgentItems[1].status).toBe('completed');
  });

  it('also adds Task/Agent tool events to completedSteps (no filtering)', () => {
    const { result } = startTurnAndGetCallbacks();

    act(() => {
      capturedOnEvent!({
        type: 'tool',
        stage: 'start',
        toolName: 'Task',
        toolUseId: 'tool-both-1',
        detail: JSON.stringify({ subagent_type: 'reviewer' }),
      });
    });

    act(() => {
      capturedOnEvent!({
        type: 'tool',
        stage: 'end',
        toolName: 'Task',
        toolUseId: 'tool-both-1',
        detail: 'Review done',
      });
    });

    // Should appear in BOTH subAgentItems and completedSteps
    expect(result.current.subAgentItems).toHaveLength(1);
    expect(result.current.completedSteps).toHaveLength(1);
    expect(result.current.completedSteps[0].toolName).toBe('Task');
  });
});

describe('shouldSuppressStatus', () => {
  it('suppresses "Agent initialized" status messages', () => {
    expect(shouldSuppressStatus('Agent initialized with model claude-opus-4-20250514 (tools: 12) • Session abc-123')).toBe(true);
  });

  it('suppresses "Context compacted" status messages', () => {
    expect(shouldSuppressStatus('Context compacted to manage token limits.')).toBe(true);
  });

  it('does not suppress tool usage status messages', () => {
    expect(shouldSuppressStatus('Using Read...')).toBe(false);
  });

  it('does not suppress empty strings', () => {
    expect(shouldSuppressStatus('')).toBe(false);
  });

  it('does not suppress arbitrary user-visible status messages', () => {
    expect(shouldSuppressStatus('Rebel is still working...')).toBe(false);
    expect(shouldSuppressStatus('Thinking...')).toBe(false);
  });
});

describe('useAgentTurn — delta tracking (hasMissionSet, touchedTaskIds)', () => {
  function startTurnAndGetCallbacks() {
    const { result, rerender } = renderHook(() => useAgentTurn());
    act(() => {
      result.current.startTurn('session-1', 'Hello');
    });
    return { result, rerender };
  }

  it('tracks hasMissionSet when MissionSet start event arrives', () => {
    const { result } = startTurnAndGetCallbacks();

    expect(result.current.hasMissionSet).toBe(false);

    act(() => {
      capturedOnEvent!({
        type: 'tool',
        stage: 'start',
        toolName: 'MissionSet',
        detail: JSON.stringify({ goal: 'Ship it' }),
      });
    });

    expect(result.current.hasMissionSet).toBe(true);
  });

  it('tracks hasMissionSet when MissionSet end event arrives', () => {
    const { result } = startTurnAndGetCallbacks();

    act(() => {
      capturedOnEvent!({
        type: 'tool',
        stage: 'start',
        toolName: 'MissionSet',
        detail: JSON.stringify({ goal: 'Ship it' }),
      });
      capturedOnEvent!({
        type: 'tool',
        stage: 'end',
        toolName: 'MissionSet',
        detail: JSON.stringify({ mission: { goal: 'Ship it' } }),
      });
    });

    expect(result.current.hasMissionSet).toBe(true);
  });

  it('tracks touchedTaskIds from TaskCreate end events', () => {
    const { result } = startTurnAndGetCallbacks();

    expect(result.current.touchedTaskIds).toEqual([]);

    act(() => {
      capturedOnEvent!({
        type: 'tool',
        stage: 'start',
        toolName: 'TaskCreate',
        detail: JSON.stringify({ title: 'Task A', status: 'pending' }),
      });
      capturedOnEvent!({
        type: 'tool',
        stage: 'end',
        toolName: 'TaskCreate',
        detail: JSON.stringify({
          task: { id: 'task-1', title: 'Task A', status: 'pending' },
          tasks: [{ id: 'task-1', title: 'Task A', status: 'pending' }],
        }),
      });
    });

    expect(result.current.touchedTaskIds).toEqual(['task-1']);
  });

  it('tracks touchedTaskIds from TaskUpdate end events', () => {
    const { result } = startTurnAndGetCallbacks();

    act(() => {
      capturedOnEvent!({
        type: 'tool',
        stage: 'start',
        toolName: 'TaskUpdate',
        detail: JSON.stringify({ id: 'task-2', status: 'in_progress' }),
      });
      capturedOnEvent!({
        type: 'tool',
        stage: 'end',
        toolName: 'TaskUpdate',
        detail: JSON.stringify({
          task: { id: 'task-2', title: 'Task B', status: 'in_progress' },
          tasks: [{ id: 'task-2', title: 'Task B', status: 'in_progress' }],
        }),
      });
    });

    expect(result.current.touchedTaskIds).toEqual(['task-2']);
  });

  it('deduplicates touchedTaskIds (first-touch only)', () => {
    const { result } = startTurnAndGetCallbacks();

    act(() => {
      capturedOnEvent!({
        type: 'tool',
        stage: 'start',
        toolName: 'TaskUpdate',
        detail: '{}',
      });
      capturedOnEvent!({
        type: 'tool',
        stage: 'end',
        toolName: 'TaskUpdate',
        detail: JSON.stringify({
          task: { id: 'task-1', title: 'Task A', status: 'in_progress' },
          tasks: [{ id: 'task-1', title: 'Task A', status: 'in_progress' }],
        }),
      });
    });

    act(() => {
      capturedOnEvent!({
        type: 'tool',
        stage: 'start',
        toolName: 'TaskUpdate',
        detail: '{}',
      });
      capturedOnEvent!({
        type: 'tool',
        stage: 'end',
        toolName: 'TaskUpdate',
        detail: JSON.stringify({
          task: { id: 'task-1', title: 'Task A', status: 'completed' },
          tasks: [{ id: 'task-1', title: 'Task A', status: 'completed' }],
        }),
      });
    });

    // Should contain task-1 only once
    expect(result.current.touchedTaskIds).toEqual(['task-1']);
  });

  it('TaskCreate end event updates taskProgress from snapshot', () => {
    const { result } = startTurnAndGetCallbacks();

    act(() => {
      capturedOnEvent!({
        type: 'tool',
        stage: 'start',
        toolName: 'TaskCreate',
        detail: '{}',
      });
      capturedOnEvent!({
        type: 'tool',
        stage: 'end',
        toolName: 'TaskCreate',
        detail: JSON.stringify({
          task: { id: 'task-1', title: 'Task A', status: 'pending' },
          tasks: [
            { id: 'task-1', title: 'Task A', status: 'pending' },
            { id: 'task-2', title: 'Task B', status: 'in_progress' },
          ],
        }),
      });
    });

    expect(result.current.taskProgress).toEqual([
      { id: 'task-1', title: 'Task A', status: 'pending' },
      { id: 'task-2', title: 'Task B', status: 'in_progress' },
    ]);
  });

  it('TaskUpdate end event updates taskProgress from snapshot', () => {
    const { result } = startTurnAndGetCallbacks();

    act(() => {
      capturedOnEvent!({
        type: 'tool',
        stage: 'start',
        toolName: 'TaskUpdate',
        detail: '{}',
      });
      capturedOnEvent!({
        type: 'tool',
        stage: 'end',
        toolName: 'TaskUpdate',
        detail: JSON.stringify({
          task: { id: 'task-1', title: 'Task A', status: 'completed' },
          tasks: [
            { id: 'task-1', title: 'Task A', status: 'completed' },
            { id: 'task-2', title: 'Task B', status: 'in_progress' },
          ],
        }),
      });
    });

    expect(result.current.taskProgress).toEqual([
      { id: 'task-1', title: 'Task A', status: 'completed' },
      { id: 'task-2', title: 'Task B', status: 'in_progress' },
    ]);
  });

  it('resets hasMissionSet and touchedTaskIds on new turn', () => {
    const { result } = startTurnAndGetCallbacks();

    act(() => {
      capturedOnEvent!({
        type: 'tool',
        stage: 'start',
        toolName: 'MissionSet',
        detail: JSON.stringify({ goal: 'Ship it' }),
      });
      capturedOnEvent!({
        type: 'tool',
        stage: 'end',
        toolName: 'MissionSet',
        detail: JSON.stringify({ mission: { goal: 'Ship it' } }),
      });
    });

    act(() => {
      capturedOnEvent!({
        type: 'tool',
        stage: 'start',
        toolName: 'TaskCreate',
        detail: '{}',
      });
      capturedOnEvent!({
        type: 'tool',
        stage: 'end',
        toolName: 'TaskCreate',
        detail: JSON.stringify({
          task: { id: 'task-1', title: 'Task A', status: 'pending' },
          tasks: [{ id: 'task-1', title: 'Task A', status: 'pending' }],
        }),
      });
    });

    expect(result.current.hasMissionSet).toBe(true);
    expect(result.current.touchedTaskIds).toEqual(['task-1']);

    // Start new turn
    act(() => {
      result.current.startTurn('session-1', 'Next turn');
    });

    expect(result.current.hasMissionSet).toBe(false);
    expect(result.current.touchedTaskIds).toEqual([]);
  });

  it('snapshotMissionTask receives hasMissionSet and touchedTaskIds on result', async () => {
    mockFetchSession.mockResolvedValue(undefined);
    const { result } = startTurnAndGetCallbacks();

    act(() => {
      capturedOnEvent!({ type: 'turn_started', turnId: 'turn-delta-1' });
      capturedOnEvent!({
        type: 'tool',
        stage: 'start',
        toolName: 'MissionSet',
        detail: JSON.stringify({ goal: 'Test goal' }),
      });
      capturedOnEvent!({
        type: 'tool',
        stage: 'end',
        toolName: 'MissionSet',
        detail: JSON.stringify({ mission: { goal: 'Test goal' } }),
      });
      capturedOnEvent!({
        type: 'tool',
        stage: 'start',
        toolName: 'TaskCreate',
        detail: '{}',
      });
      capturedOnEvent!({
        type: 'tool',
        stage: 'end',
        toolName: 'TaskCreate',
        detail: JSON.stringify({
          task: { id: 'task-1', title: 'Task A', status: 'pending' },
          tasks: [{ id: 'task-1', title: 'Task A', status: 'pending' }],
        }),
      });
    });

    await act(async () => {
      capturedOnEvent!({ type: 'result', text: 'Done' });
      await new Promise((r) => setTimeout(r, 0));
    });

    expect(mockSnapshotMissionTask).toHaveBeenCalledWith(
      'turn-delta-1',
      { goal: 'Test goal', doneCriteria: undefined, constraints: undefined },
      [{ id: 'task-1', title: 'Task A', status: 'pending' }],
      { hasMissionSet: true, touchedTaskIds: ['task-1'] },
    );
  });

  it('TodoWrite is suppressed once TaskCreate snapshot has been seen', () => {
    const { result } = startTurnAndGetCallbacks();

    // TaskCreate end event establishes snapshot
    act(() => {
      capturedOnEvent!({
        type: 'tool',
        stage: 'start',
        toolName: 'TaskCreate',
        detail: '{}',
      });
      capturedOnEvent!({
        type: 'tool',
        stage: 'end',
        toolName: 'TaskCreate',
        detail: JSON.stringify({
          task: { id: 'task-1', title: 'Real task', status: 'pending' },
          tasks: [{ id: 'task-1', title: 'Real task', status: 'pending' }],
        }),
      });
    });

    expect(result.current.taskProgress).toEqual([
      { id: 'task-1', title: 'Real task', status: 'pending' },
    ]);

    // TodoWrite should not overwrite
    act(() => {
      capturedOnEvent!({
        type: 'tool',
        stage: 'start',
        toolName: 'TodoWrite',
        detail: JSON.stringify({
          todos: [{ id: 'todo-1', content: 'Legacy task', status: 'in_progress' }],
        }),
      });
    });

    expect(result.current.taskProgress).toEqual([
      { id: 'task-1', title: 'Real task', status: 'pending' },
    ]);
  });
});

describe('useAgentTurn — status message filtering', () => {
  function startTurnAndGetCallbacks() {
    const { result, rerender } = renderHook(() => useAgentTurn());
    act(() => {
      result.current.startTurn('session-1', 'Hello');
    });
    return { result, rerender };
  }

  it('does not set statusText for suppressed status messages', () => {
    const { result } = startTurnAndGetCallbacks();

    act(() => {
      capturedOnEvent!({ type: 'status', message: 'Agent initialized with model claude-opus-4-20250514 (tools: 5) • Session xyz' });
    });

    // statusText should remain null — suppressed message
    expect(result.current.statusText).toBeNull();
  });

  it('sets statusText for non-suppressed status messages', () => {
    const { result } = startTurnAndGetCallbacks();

    act(() => {
      capturedOnEvent!({ type: 'status', message: 'Processing your request...' });
    });

    expect(result.current.statusText).toBe('Processing your request...');
  });

  it('does not filter tool case status messages (Using X...)', () => {
    const { result } = startTurnAndGetCallbacks();

    act(() => {
      capturedOnEvent!({ type: 'tool', stage: 'start', toolName: 'Read' });
    });

    // Tool status is set via case 'tool', not case 'status' — should NOT be filtered
    expect(result.current.statusText).toBe('Using Read...');
  });
});
