import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock session store with controllable sessionSummaries
let mockSessionSummaries: Array<{ id: string; privateMode?: boolean }> = [];

vi.mock('@renderer/features/agent-session/store/sessionStore', () => ({
  getSessionStoreState: () => ({
    sessionSummaries: mockSessionSummaries,
  }),
  subscribeToSessionStore: vi.fn(),
}));

import { isSessionPrivate } from '../sessionPrivacyGuard';

describe('isSessionPrivate', () => {
  beforeEach(() => {
    mockSessionSummaries = [];
  });

  it('returns false for a non-private session', () => {
    mockSessionSummaries = [{ id: 'session-1', privateMode: false }];
    expect(isSessionPrivate('session-1')).toBe(false);
  });

  it('returns true for a private session', () => {
    mockSessionSummaries = [{ id: 'session-1', privateMode: true }];
    expect(isSessionPrivate('session-1')).toBe(true);
  });

  it('returns true (safe default) when session is not found', () => {
    mockSessionSummaries = [{ id: 'other-session', privateMode: false }];
    expect(isSessionPrivate('missing-session')).toBe(true);
  });

  it('returns false when privateMode is undefined (legacy sessions)', () => {
    mockSessionSummaries = [{ id: 'session-1' }];
    expect(isSessionPrivate('session-1')).toBe(false);
  });

  it('returns true when sessionSummaries is empty', () => {
    mockSessionSummaries = [];
    expect(isSessionPrivate('any-id')).toBe(true);
  });

  it('finds the correct session among multiple', () => {
    mockSessionSummaries = [
      { id: 'public-1', privateMode: false },
      { id: 'private-1', privateMode: true },
      { id: 'public-2', privateMode: false },
    ];
    expect(isSessionPrivate('public-1')).toBe(false);
    expect(isSessionPrivate('private-1')).toBe(true);
    expect(isSessionPrivate('public-2')).toBe(false);
  });
});
