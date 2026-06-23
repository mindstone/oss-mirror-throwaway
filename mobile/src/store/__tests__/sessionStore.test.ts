// NOTE: cloud-client stores import their API from `../cloudClient` (internal module),
// not from the package re-export. Mock the internal module so store methods use the mocks.
jest.mock('../../../../cloud-client/src/cloudClient', () => ({
  getSessions: jest.fn(),
  getSession: jest.fn(),
}));

const { useSessionStore } = require('@rebel/cloud-client');
const cloudClient = require('../../../../cloud-client/src/cloudClient');

afterEach(() => {
  useSessionStore.setState({
    sessions: [],
    isLoading: false,
    error: null,
    currentSession: null,
    isLoadingSession: false,
    _lastFetchOptions: undefined,
  });
  jest.clearAllMocks();
});

const mockSummary = (id: string, updatedAt = Date.now()) => ({
  id,
  title: `Session ${id}`,
  createdAt: updatedAt - 1000,
  updatedAt,
  preview: 'hello',
  messageCount: 2,
  activeTurnId: null,
  isBusy: false,
  lastError: null,
  doneAt: null,
  starredAt: null,
  deletedAt: null,
  origin: 'manual',
  usage: { costUsd: 0, inputTokens: 0, outputTokens: 0, turnCount: 1 },
});

describe('sessionStore', () => {
  it('starts empty', () => {
    expect(useSessionStore.getState().sessions).toEqual([]);
  });

  it('fetches sessions and sorts by updatedAt desc', async () => {
    const s1 = mockSummary('a', 1000);
    const s2 = mockSummary('b', 2000);
    cloudClient.getSessions.mockResolvedValueOnce({ sessions: [s1, s2], totalCount: 2 });

    await useSessionStore.getState().fetchSessions();
    const { sessions, isLoading } = useSessionStore.getState();
    expect(isLoading).toBe(false);
    expect(sessions.map((s: { id: string }) => s.id)).toEqual(['b', 'a']);
  });

  it('passes options to getSessions', async () => {
    cloudClient.getSessions.mockResolvedValueOnce({ sessions: [], totalCount: 0 });

    await useSessionStore.getState().fetchSessions({ activeOnly: true });
    expect(cloudClient.getSessions).toHaveBeenCalledWith({ activeOnly: true });
  });

  it('fetches all sessions when no options provided', async () => {
    cloudClient.getSessions.mockResolvedValueOnce({ sessions: [], totalCount: 0 });

    await useSessionStore.getState().fetchSessions();
    expect(cloudClient.getSessions).toHaveBeenCalledWith(undefined);
  });

  it('handles empty cloud sessions gracefully', async () => {
    cloudClient.getSessions.mockResolvedValueOnce({ sessions: [], totalCount: 0 });

    await useSessionStore.getState().fetchSessions();
    const { sessions, isLoading, error } = useSessionStore.getState();
    expect(sessions).toEqual([]);
    expect(isLoading).toBe(false);
    expect(error).toBeNull();
  });

  it('includes all sessions returned by the server', async () => {
    const s1 = mockSummary('a');
    const s2 = { ...mockSummary('b'), deletedAt: Date.now() };
    cloudClient.getSessions.mockResolvedValueOnce({ sessions: [s1, s2], totalCount: 2 });

    await useSessionStore.getState().fetchSessions();
    expect(useSessionStore.getState().sessions).toHaveLength(2);
  });

  it('handles fetch error', async () => {
    cloudClient.getSessions.mockRejectedValueOnce(new Error('Network fail'));

    await useSessionStore.getState().fetchSessions();
    const { error, isLoading } = useSessionStore.getState();
    expect(isLoading).toBe(false);
    expect(error).toBe('Network fail');
  });

  it('fetches a single session', async () => {
    const raw = { id: 'x', title: 'Test', messages: [], activeTurnId: null, isBusy: false, lastError: null };
    cloudClient.getSession.mockResolvedValueOnce(raw);

    await useSessionStore.getState().fetchSession('x');
    expect(useSessionStore.getState().currentSession).toEqual({
      ...raw,
        toolEventsByTurn: undefined,
    });
  });

  it('removes deleted session on event', async () => {
    useSessionStore.setState({ sessions: [mockSummary('a'), mockSummary('b')] });

    await useSessionStore.getState().handleSessionChanged('a', 'deleted');
    expect(useSessionStore.getState().sessions.map((s: { id: string }) => s.id)).toEqual(['b']);
  });
});
