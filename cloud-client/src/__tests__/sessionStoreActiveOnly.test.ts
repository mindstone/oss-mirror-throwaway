/**
 * Tests for sessionStore activeOnly filtering (Stage 6).
 *
 * Verifies that fetchSessions() passes activeOnly: true to the cloud client,
 * so only cloud_active sessions are returned from the cloud service.
 */

import { useSessionStore } from '../stores/sessionStore';

vi.mock('../cloudClient', async () => {
  const actual = await vi.importActual<typeof import('../cloudClient')>('../cloudClient');
  return {
    ...actual,
    getSessions: vi.fn(),
    getSession: vi.fn(),
    getContinuityMap: vi.fn(),
  };
});

import * as cloudClient from '../cloudClient';
const mockedGetSessions = vi.mocked(cloudClient.getSessions);

const mockSummary = (id: string, updatedAt = Date.now()) => ({
  id,
  title: `Session ${id}`,
  createdAt: updatedAt - 1000,
  updatedAt,
  resolvedAt: null,
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

beforeEach(() => {
  useSessionStore.setState({
    sessions: [],
    isLoading: false,
    error: null,
    currentSession: null,
    isLoadingSession: false,
    _lastFetchOptions: undefined,
  });
  mockedGetSessions.mockClear();
});

describe('sessionStore activeOnly filtering', () => {
  it('passes activeOnly: true when explicitly requested', async () => {
    mockedGetSessions.mockResolvedValueOnce({ sessions: [mockSummary('a')], totalCount: 1 });

    await useSessionStore.getState().fetchSessions({ activeOnly: true });

    expect(mockedGetSessions).toHaveBeenCalledWith({ activeOnly: true });
  });

  it('passes no filter when called without options', async () => {
    mockedGetSessions.mockResolvedValueOnce({ sessions: [mockSummary('a')], totalCount: 1 });

    await useSessionStore.getState().fetchSessions();

    expect(mockedGetSessions).toHaveBeenCalledWith(undefined);
  });

  it('stores only the returned sessions (server-side filtered)', async () => {
    const cloudActive = { ...mockSummary('cloud-active', 2000), doneAt: null };
    mockedGetSessions.mockResolvedValueOnce({ sessions: [cloudActive], totalCount: 1 });

    await useSessionStore.getState().fetchSessions({ activeOnly: true });

    const { sessions } = useSessionStore.getState();
    expect(sessions).toHaveLength(1);
    expect(sessions[0].id).toBe('cloud-active');
  });

  it('handles empty session list gracefully', async () => {
    mockedGetSessions.mockResolvedValueOnce({ sessions: [], totalCount: 0 });

    await useSessionStore.getState().fetchSessions();

    const { sessions, isLoading, error } = useSessionStore.getState();
    expect(sessions).toHaveLength(0);
    expect(isLoading).toBe(false);
    expect(error).toBeNull();
  });

  it('handles fetch error gracefully', async () => {
    mockedGetSessions.mockRejectedValueOnce(new Error('Network error'));

    await useSessionStore.getState().fetchSessions();

    const { sessions, isLoading, error } = useSessionStore.getState();
    expect(sessions).toHaveLength(0);
    expect(isLoading).toBe(false);
    expect(error).toBe('Network error');
  });
});
