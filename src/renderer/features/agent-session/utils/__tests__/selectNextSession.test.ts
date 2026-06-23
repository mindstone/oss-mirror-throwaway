import { describe, it, expect } from 'vitest';
import { selectNextSession } from '../selectNextSession';
import type { AgentSessionSidebarEntry } from '../../types';
import type { SessionSections } from '../../hooks/useSessionHistoryView';

// Helper to create a mock sidebar entry
const createEntry = (
  id: string,
  overrides: Partial<AgentSessionSidebarEntry> = {}
): AgentSessionSidebarEntry => ({
  id,
  title: `Session ${id}`,
  preview: 'Preview text',
  timestamp: Date.now(),
  status: 'ready',
  isHistory: true,
  isCorrupted: false,
  isResolved: true,
  resolvedAt: Date.now(),
  isActive: true,
  isStarred: false,
  messageCount: 5,
  ...overrides,
});

// Helper to create sections
const createSections = (
  active: AgentSessionSidebarEntry[] = [],
  starred: AgentSessionSidebarEntry[] = []
): SessionSections => ({
  activeSessions: active,
  starredSessions: starred,
  doneSessions: [],
  deletedSessions: [],
});

describe('selectNextSession', () => {
  describe('with Active sessions', () => {
    it('should select the most recent ready Active session', () => {
      const oldReady = createEntry('old', { timestamp: 1000, status: 'ready' });
      const newReady = createEntry('new', { timestamp: 2000, status: 'ready' });
      const archived = createEntry('archived', { timestamp: 3000 });

      const result = selectNextSession({
        doneSessionId: 'archived',
        sections: createSections([archived, newReady, oldReady]),
      });

      expect(result.session?.id).toBe('new');
      expect(result.reason).toBe('ready-active');
    });

    it('should prefer ready over busy Active sessions', () => {
      const busy = createEntry('busy', { timestamp: 2000, status: 'thinking' });
      const ready = createEntry('ready', { timestamp: 1000, status: 'ready' });

      const result = selectNextSession({
        doneSessionId: 'archived',
        sections: createSections([busy, ready]),
      });

      expect(result.session?.id).toBe('ready');
      expect(result.reason).toBe('ready-active');
    });

    it('should fall back to busy Active if no ready sessions', () => {
      const busy1 = createEntry('busy1', { timestamp: 2000, status: 'thinking' });
      const busy2 = createEntry('busy2', { timestamp: 1000, status: 'thinking' });

      const result = selectNextSession({
        doneSessionId: 'archived',
        sections: createSections([busy1, busy2]),
      });

      expect(result.session?.id).toBe('busy1');
      expect(result.reason).toBe('busy-active');
    });

    it('should exclude the done session from candidates', () => {
      const archived = createEntry('archived', { timestamp: 3000, status: 'ready' });
      const other = createEntry('other', { timestamp: 1000, status: 'ready' });

      const result = selectNextSession({
        doneSessionId: 'archived',
        sections: createSections([archived, other]),
      });

      expect(result.session?.id).toBe('other');
    });
  });

  describe('with Favorites only', () => {
    it('should select ready Favorite when no Active sessions', () => {
      const favorite = createEntry('fav', { timestamp: 1000, status: 'ready', isStarred: true });

      const result = selectNextSession({
        doneSessionId: 'archived',
        sections: createSections([], [favorite]),
      });

      expect(result.session?.id).toBe('fav');
      expect(result.reason).toBe('ready-favorite');
    });

    it('should fall back to busy Favorite if no ready sessions anywhere', () => {
      const busyFavorite = createEntry('fav', { timestamp: 1000, status: 'thinking', isStarred: true });

      const result = selectNextSession({
        doneSessionId: 'archived',
        sections: createSections([], [busyFavorite]),
      });

      expect(result.session?.id).toBe('fav');
      expect(result.reason).toBe('busy-favorite');
    });
  });

  describe('Active takes priority over Favorites', () => {
    it('should select Active over Favorite even if Favorite is more recent', () => {
      const active = createEntry('active', { timestamp: 1000, status: 'ready' });
      const favorite = createEntry('fav', { timestamp: 2000, status: 'ready', isStarred: true });

      const result = selectNextSession({
        doneSessionId: 'archived',
        sections: createSections([active], [favorite]),
      });

      expect(result.session?.id).toBe('active');
      expect(result.reason).toBe('ready-active');
    });

    it('should select busy Active over ready Favorite', () => {
      const busyActive = createEntry('active', { timestamp: 1000, status: 'thinking' });
      const readyFavorite = createEntry('fav', { timestamp: 2000, status: 'ready', isStarred: true });

      const result = selectNextSession({
        doneSessionId: 'archived',
        sections: createSections([busyActive], [readyFavorite]),
      });

      expect(result.session?.id).toBe('active');
      expect(result.reason).toBe('busy-active');
    });
  });

  describe('edge cases', () => {
    it('should return null when no sessions available', () => {
      const result = selectNextSession({
        doneSessionId: 'archived',
        sections: createSections(),
      });

      expect(result.session).toBeNull();
      expect(result.reason).toBe('none');
    });

    it('should return null when only the done session exists', () => {
      const archived = createEntry('archived', { timestamp: 1000 });

      const result = selectNextSession({
        doneSessionId: 'archived',
        sections: createSections([archived]),
      });

      expect(result.session).toBeNull();
      expect(result.reason).toBe('none');
    });

    it('should handle session with messageCount=0 as not ready', () => {
      const noMessages = createEntry('empty', { timestamp: 2000, status: 'ready', messageCount: 0 });
      const withMessages = createEntry('full', { timestamp: 1000, status: 'ready', messageCount: 5 });

      const result = selectNextSession({
        doneSessionId: 'archived',
        sections: createSections([noMessages, withMessages]),
      });

      expect(result.session?.id).toBe('full');
      expect(result.reason).toBe('ready-active');
    });
  });
});
