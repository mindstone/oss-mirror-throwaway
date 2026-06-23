// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, waitFor, within } from '@testing-library/react';

/**
 * RTL harness for web-companion `ConversationsScreen`. Stage 4 (260614 done-state
 * rename) focus: the Star-bug fix — the row star icon reads `starredAt`, the
 * menu's Star toggles `starredAt` only, and "Mark as done" (renamed from
 * "Archive") writes the canonical `doneAt`.
 */

const mockFetchSessions = vi.fn(async () => undefined);
const mockUpdateSession = vi.fn(async () => undefined);
const mockNavigate = vi.fn();

interface MockSessionState {
  sessions: unknown[];
  isLoading: boolean;
  error: string | null;
  fetchSessions: typeof mockFetchSessions;
}

const sessionState: MockSessionState = {
  sessions: [],
  isLoading: false,
  error: null,
  fetchSessions: mockFetchSessions,
};

vi.mock('react-router-dom', () => ({
  useNavigate: () => mockNavigate,
}));

vi.mock('@rebel/cloud-client', () => ({
  useSessionStore: Object.assign(
    <T,>(selector?: (s: MockSessionState) => T) =>
      (selector ? selector(sessionState) : sessionState),
    { getState: () => sessionState },
  ),
  updateSession: (...args: unknown[]) => mockUpdateSession(...(args as [])),
  deleteSession: vi.fn(async () => undefined),
  formatRelativeTime: () => 'just now',
}));

import { ConversationsScreen } from '../ConversationsScreen';

function makeSession(overrides: Record<string, unknown> = {}) {
  const now = Date.now();
  return {
    id: 'sess-1',
    title: 'Test',
    createdAt: now - 1000,
    updatedAt: now,
    resolvedAt: null,
    preview: 'hello',
    messageCount: 1,
    activeTurnId: null,
    isBusy: false,
    lastError: null,
    doneAt: null,
    starredAt: null,
    deletedAt: null,
    origin: 'manual',
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  sessionState.sessions = [];
  sessionState.isLoading = false;
  sessionState.error = null;
});

afterEach(() => {
  cleanup();
});

describe('ConversationsScreen — Star vs Done (Stage 4 Star-bug fix)', () => {
  it('shows the row star icon only when starredAt is set', async () => {
    sessionState.sessions = [
      makeSession({ id: 'active', title: 'Active Only', doneAt: null, starredAt: null }),
      makeSession({ id: 'starred', title: 'Starred One', starredAt: Date.now() }),
    ];

    const { getByText, getByTestId } = render(<ConversationsScreen />);
    await waitFor(() => expect(getByText('Active Only')).toBeTruthy());

    // The active-but-not-starred row has no star icon.
    const activeRow = getByTestId('session-item-active');
    expect(within(activeRow).queryByLabelText('Starred')).toBeNull();
    // The truly-starred row shows it.
    const starredRow = getByTestId('session-item-starred');
    expect(within(starredRow).getByLabelText('Starred')).toBeTruthy();
  });

  it('menu Star toggles starredAt only (not doneAt)', async () => {
    sessionState.sessions = [makeSession({ id: 'sess-1', title: 'Star Me', starredAt: null })];

    const { getByText, getByLabelText } = render(<ConversationsScreen />);
    await waitFor(() => expect(getByText('Star Me')).toBeTruthy());

    fireEvent.click(getByLabelText('Session actions'));
    fireEvent.click(getByText('Add to Starred'));

    await waitFor(() => expect(mockUpdateSession).toHaveBeenCalled());
    const [, patch] = mockUpdateSession.mock.calls[0] as unknown as [string, Record<string, unknown>];
    expect(patch).toHaveProperty('starredAt');
    expect(typeof patch.starredAt).toBe('number');
    expect(patch).not.toHaveProperty('doneAt');
  });

  it('menu "Mark as done" writes canonical doneAt', async () => {
    sessionState.sessions = [makeSession({ id: 'sess-1', title: 'Done Me', doneAt: null })];

    const { getByText, getByLabelText } = render(<ConversationsScreen />);
    await waitFor(() => expect(getByText('Done Me')).toBeTruthy());

    fireEvent.click(getByLabelText('Session actions'));
    fireEvent.click(getByText('Mark as done'));

    await waitFor(() => expect(mockUpdateSession).toHaveBeenCalled());
    const [, patch] = mockUpdateSession.mock.calls[0] as unknown as [string, Record<string, unknown>];
    expect(patch.doneAt).toEqual(expect.any(Number));
    expect(patch.doneAt as number).toBeGreaterThan(0);
    expect(patch.resolvedAt).toEqual(expect.any(Number));
  });
});
