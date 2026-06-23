/**
 * ConversationsScreen tests -- flat list, navigation, empty states, busy indicators.
 */

import React from 'react';
import { render, fireEvent, waitFor, cleanup } from '@testing-library/react-native';
import { mockSessionSummary } from './helpers';

const mockPush = jest.fn();
jest.mock('expo-router', () => ({
  useRouter: () => ({ push: mockPush }),
}));

jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 44, bottom: 34, left: 0, right: 0 }),
}));

jest.mock('@react-navigation/bottom-tabs', () => ({
  useBottomTabBarHeight: () => 49,
}));

jest.mock('react-native-reanimated', () => {
  const Reanimated = require('react-native-reanimated/mock');
  Reanimated.default.call = () => {};
  return {
    ...Reanimated,
    useReducedMotion: () => false,
  };
});

jest.mock('../../src/components/PendingRecordingsList', () => ({
  PendingRecordingsList: () => null,
}));

// Mock useQueuedCountBySessionId — returns map-based counts for testing badges
const mockQueuedCounts: Record<string, number> = {};
jest.mock('../../src/hooks/useQueuedCountBySessionId', () => ({
  useQueuedCountBySessionId: (sessionId: string) => mockQueuedCounts[sessionId] ?? 0,
}));

jest.mock('../../src/components/SwipeableRow', () => ({
  SwipeableRow: ({ children }: { children: React.ReactNode }) => children,
}));

jest.mock('../../src/hooks/usePulseAnimation', () => ({
  usePulseAnimation: () => ({ opacity: 1 }),
}));

jest.mock('../../../cloud-client/src/cloudClient', () => ({
  getSessions: jest.fn().mockResolvedValue({ sessions: [], totalCount: 0 }),
  getSession: jest.fn(),
  updateSession: jest.fn().mockResolvedValue(undefined),
}));

const { useSessionStore, initOfflineQueueStore } = require('@rebel/cloud-client');
const { _resetOfflineQueueStore } = require('../../../cloud-client/src/offlineQueue/offlineQueueStore');
const cloudClient = require('../../../cloud-client/src/cloudClient');

import ConversationsScreen from '../../app/(tabs)/conversations';

function createMockQueueStorage() {
  return {
    saveSnapshot: jest.fn().mockResolvedValue(undefined),
    loadSnapshot: jest.fn().mockResolvedValue([]),
    savePayloadFromUri: jest.fn().mockResolvedValue('file:///mock/payload.m4a'),
    getPayloadUri: jest.fn().mockResolvedValue('file:///mock/payload.m4a'),
    deletePayload: jest.fn().mockResolvedValue(undefined),
    listPayloadIds: jest.fn().mockResolvedValue([]),
  };
}

afterEach(() => {
  cleanup();
  jest.restoreAllMocks();
});

beforeEach(() => {
  _resetOfflineQueueStore();
  initOfflineQueueStore(createMockQueueStorage(), jest.fn());
  useSessionStore.setState({
    sessions: [],
    isLoading: false,
    error: null,
    currentSession: null,
    isLoadingSession: false,
  });
  mockPush.mockClear();
  cloudClient.getSessions.mockClear();
  cloudClient.updateSession.mockClear();
  // Reset queued counts
  for (const key of Object.keys(mockQueuedCounts)) {
    delete mockQueuedCounts[key];
  }
});

describe('ConversationsScreen', () => {
  describe('empty state', () => {
    it('shows generic empty state when no sessions', async () => {
      cloudClient.getSessions.mockResolvedValueOnce({ sessions: [], totalCount: 0 });

      const { getByText } = render(<ConversationsScreen />);
      await waitFor(() => {
        expect(getByText('No conversations yet')).toBeTruthy();
        expect(getByText('Start one and see where it goes.')).toBeTruthy();
      });
    });
  });

  describe('flat list', () => {
    const sessions = [
      mockSessionSummary({ id: 'a', title: 'First', doneAt: null, updatedAt: Date.now() - 2000 }),
      mockSessionSummary({ id: 'b', title: 'Second', doneAt: null, updatedAt: Date.now() - 1000 }),
      mockSessionSummary({ id: 'c', title: 'Third', doneAt: null, updatedAt: Date.now() }),
    ];

    it('shows all non-deleted sessions in a single list', async () => {
      cloudClient.getSessions.mockResolvedValueOnce({ sessions, totalCount: sessions.length });

      const { getByText, queryByText } = render(<ConversationsScreen />);
      await waitFor(() => expect(getByText('First')).toBeTruthy());
      expect(getByText('Second')).toBeTruthy();
      expect(getByText('Third')).toBeTruthy();
      // No filter tabs
      expect(queryByText('Pinned')).toBeNull();
      expect(queryByText('Other')).toBeNull();
      expect(queryByText('Deleted')).toBeNull();
    });

    it('excludes deleted sessions', async () => {
      const withDeleted = [
        ...sessions,
        mockSessionSummary({ id: 'd', title: 'Deleted One', deletedAt: Date.now() }),
      ];
      cloudClient.getSessions.mockResolvedValueOnce({ sessions: withDeleted, totalCount: withDeleted.length });

      const { getByText, queryByText } = render(<ConversationsScreen />);
      await waitFor(() => expect(getByText('First')).toBeTruthy());
      expect(queryByText('Deleted One')).toBeNull();
    });

    it('excludes cached background sessions from the active list', async () => {
      const withBackground = [
        mockSessionSummary({ id: 'manual-active', title: 'Manual Active', doneAt: null }),
        mockSessionSummary({
          id: 'automation-source-capture--cached',
          title: 'Source Capture',
          doneAt: null,
        }),
      ];
      cloudClient.getSessions.mockResolvedValueOnce({
        sessions: withBackground,
        totalCount: withBackground.length,
      });

      const { getByText, queryByText } = render(<ConversationsScreen />);
      await waitFor(() => expect(getByText('Manual Active')).toBeTruthy());
      expect(queryByText('Source Capture')).toBeNull();
    });

    it('floats busy sessions to the top', async () => {
      const mixed = [
        mockSessionSummary({ id: 'idle', title: 'Idle', updatedAt: Date.now() }),
        mockSessionSummary({ id: 'busy', title: 'Busy One', isBusy: true, updatedAt: Date.now() - 5000 }),
      ];
      cloudClient.getSessions.mockResolvedValueOnce({ sessions: mixed, totalCount: mixed.length });

      const { getAllByText, getByText } = render(<ConversationsScreen />);
      await waitFor(() => expect(getByText('Busy One')).toBeTruthy());
      // Busy session should appear despite older updatedAt
      expect(getByText('Idle')).toBeTruthy();
    });

    it('filters sessions by title and preview with debounced search', async () => {
      const searchable = [
        mockSessionSummary({ id: 's1', title: 'Quarterly Planning', preview: 'Roadmap and risks' }),
        mockSessionSummary({ id: 's2', title: 'Weekly Sync', preview: 'Budget review and hiring' }),
      ];
      cloudClient.getSessions.mockResolvedValueOnce({ sessions: searchable, totalCount: searchable.length });

      const { getByTestId, getByText, queryByText } = render(<ConversationsScreen />);
      await waitFor(() => expect(getByText('Quarterly Planning')).toBeTruthy());

      fireEvent.changeText(getByTestId('conversations-search-input'), 'budget');

      await waitFor(() => {
        expect(getByText('Weekly Sync')).toBeTruthy();
        expect(queryByText('Quarterly Planning')).toBeNull();
      }, { timeout: 3000 });
    });

    it('clears search query and restores the full list', async () => {
      const searchable = [
        mockSessionSummary({ id: 's1', title: 'Design Review', preview: 'Chat through options' }),
        mockSessionSummary({ id: 's2', title: 'Launch Plan', preview: 'Messaging and timeline' }),
      ];
      cloudClient.getSessions.mockResolvedValueOnce({ sessions: searchable, totalCount: searchable.length });

      const { getByTestId, getByText, queryByText } = render(<ConversationsScreen />);
      await waitFor(() => expect(getByText('Design Review')).toBeTruthy());

      const input = getByTestId('conversations-search-input');
      fireEvent.changeText(input, 'launch');

      await waitFor(() => {
        expect(getByText('Launch Plan')).toBeTruthy();
        expect(queryByText('Design Review')).toBeNull();
      }, { timeout: 3000 });

      fireEvent.press(getByTestId('conversations-search-clear-button'));

      await waitFor(() => {
        expect(getByText('Design Review')).toBeTruthy();
        expect(getByText('Launch Plan')).toBeTruthy();
      });
    });

    it('shows a no-results state when search has no matches', async () => {
      const searchable = [
        mockSessionSummary({ id: 's1', title: 'Product Notes', preview: 'Weekly recap' }),
      ];
      cloudClient.getSessions.mockResolvedValueOnce({ sessions: searchable, totalCount: searchable.length });

      const { getByTestId, getByText } = render(<ConversationsScreen />);
      await waitFor(() => expect(getByText('Product Notes')).toBeTruthy());

      fireEvent.changeText(getByTestId('conversations-search-input'), 'nope');

      await waitFor(() => {
        expect(getByTestId('conversations-search-empty-state')).toBeTruthy();
      }, { timeout: 3000 });
    });
  });

  describe('session row', () => {
    it('shows session title and preview', async () => {
      const sessions = [
        mockSessionSummary({ id: 's1', title: 'My Conversation', preview: 'Last message' }),
      ];
      cloudClient.getSessions.mockResolvedValueOnce({ sessions, totalCount: sessions.length });

      const { getByText } = render(<ConversationsScreen />);
      await waitFor(() => {
        expect(getByText('My Conversation')).toBeTruthy();
        expect(getByText('Last message')).toBeTruthy();
      });
    });

    it('navigates to conversation on press', async () => {
      const sessions = [
        mockSessionSummary({ id: 'nav-1', title: 'Navigate Me' }),
      ];
      cloudClient.getSessions.mockResolvedValueOnce({ sessions, totalCount: sessions.length });

      const { getByText } = render(<ConversationsScreen />);
      await waitFor(() => expect(getByText('Navigate Me')).toBeTruthy());

      fireEvent.press(getByText('Navigate Me'));
      expect(mockPush).toHaveBeenCalledWith('/conversation/nav-1');
    });

    it('shows busy indicator for active sessions', async () => {
      const sessions = [
        mockSessionSummary({ id: 'busy-1', title: 'Busy', isBusy: true }),
      ];
      cloudClient.getSessions.mockResolvedValueOnce({ sessions, totalCount: sessions.length });

      const { getByText } = render(<ConversationsScreen />);
      await waitFor(() => expect(getByText('Busy')).toBeTruthy());
    });
  });

  // Stage 4: the Star bug fix — row icon reads starredAt, and the action sheet
  // splits a true Star (starredAt) from Mark-as-done (doneAt).
  describe('star vs done (Star-bug fix)', () => {
    it('shows the row star icon only when starredAt is set', async () => {
      const sessions = [
        // Active-but-not-starred: starredAt null → NO star icon
        mockSessionSummary({ id: 'active', title: 'Active Only', doneAt: null, starredAt: null }),
        // Truly starred → star icon
        mockSessionSummary({ id: 'starred', title: 'Starred One', starredAt: Date.now() }),
      ];
      cloudClient.getSessions.mockResolvedValueOnce({ sessions, totalCount: sessions.length });

      const { getByText, getAllByTestId } = render(<ConversationsScreen />);
      await waitFor(() => expect(getByText('Active Only')).toBeTruthy());

      // Exactly one star icon — for the starred session only.
      const icons = getAllByTestId('conversations-item-starred-icon');
      expect(icons).toHaveLength(1);
    });

    it('long-press "Add to Starred" writes starredAt only (not doneAt)', async () => {
      const ActionSheetIOS = require('react-native').ActionSheetIOS;
      const sheetSpy = jest.spyOn(ActionSheetIOS, 'showActionSheetWithOptions').mockImplementation(() => {});

      const sessions = [mockSessionSummary({ id: 'star-me', title: 'Star Me', starredAt: null })];
      cloudClient.getSessions.mockResolvedValue({ sessions, totalCount: sessions.length });

      const { getByText, getByTestId } = render(<ConversationsScreen />);
      await waitFor(() => expect(getByText('Star Me')).toBeTruthy());

      fireEvent(getByTestId('conversations-item-star-me'), 'onLongPress');

      const [options, callback] = sheetSpy.mock.calls[0] as [
        { options: string[] },
        (index: number) => void,
      ];
      // Star is the 2nd action (index 2): Cancel, Mark as done, Add to Starred, Delete
      expect(options.options).toEqual(['Cancel', 'Mark as done', 'Add to Starred', 'Delete']);
      callback(2);

      await waitFor(() => expect(cloudClient.updateSession).toHaveBeenCalled());
      const patch = cloudClient.updateSession.mock.calls[0][1];
      expect(patch).toHaveProperty('starredAt');
      expect(typeof patch.starredAt).toBe('number');
      expect(patch).not.toHaveProperty('doneAt');

      sheetSpy.mockRestore();
    });

    it('does not render background rows from activeOnly results', async () => {
      const sessions = [
        mockSessionSummary({
          id: 'automation-source-capture--star-background',
          title: 'Source Capture',
          starredAt: null,
        }),
      ];
      cloudClient.getSessions.mockResolvedValue({ sessions, totalCount: sessions.length });

      const { queryByText, queryByTestId } = render(<ConversationsScreen />);
      await waitFor(() => expect(cloudClient.getSessions).toHaveBeenCalled());

      expect(queryByText('Source Capture')).toBeNull();
      expect(queryByTestId('conversations-item-automation-source-capture--star-background')).toBeNull();
    });

    it('long-press "Mark as done" writes canonical doneAt', async () => {
      const ActionSheetIOS = require('react-native').ActionSheetIOS;
      const sheetSpy = jest.spyOn(ActionSheetIOS, 'showActionSheetWithOptions').mockImplementation(() => {});

      const sessions = [mockSessionSummary({ id: 'done-me', title: 'Done Me', doneAt: null })];
      cloudClient.getSessions.mockResolvedValue({ sessions, totalCount: sessions.length });

      const { getByText, getByTestId } = render(<ConversationsScreen />);
      await waitFor(() => expect(getByText('Done Me')).toBeTruthy());

      fireEvent(getByTestId('conversations-item-done-me'), 'onLongPress');

      const [, callback] = sheetSpy.mock.calls[0] as [
        { options: string[] },
        (index: number) => void,
      ];
      // Mark as done is the 1st action (index 1).
      callback(1);

      await waitFor(() => expect(cloudClient.updateSession).toHaveBeenCalled());
      const patch = cloudClient.updateSession.mock.calls[0][1];
      expect(patch.doneAt).toEqual(expect.any(Number));
      expect(patch.doneAt).toBeGreaterThan(0);
      // resolvedAt co-written + distinct from lifecycle semantics, but present.
      expect(patch.resolvedAt).toEqual(expect.any(Number));

      sheetSpy.mockRestore();
    });
  });

  describe('error handling', () => {
    it('shows error with retry button', async () => {
      cloudClient.getSessions.mockRejectedValueOnce(new Error('Server down'));

      const { getByText } = render(<ConversationsScreen />);
      await waitFor(() => {
        expect(getByText('Server down')).toBeTruthy();
        expect(getByText('Retry')).toBeTruthy();
      });
    });

    it('retries on button press', async () => {
      cloudClient.getSessions.mockRejectedValueOnce(new Error('Fail'));
      const sessions = [mockSessionSummary({ id: 'retry-1', title: 'Recovered' })];
      cloudClient.getSessions.mockResolvedValueOnce({ sessions, totalCount: sessions.length });

      const { getByText } = render(<ConversationsScreen />);
      await waitFor(() => expect(getByText('Retry')).toBeTruthy());

      fireEvent.press(getByText('Retry'));
      await waitFor(() => expect(getByText('Recovered')).toBeTruthy());
    });
  });

  describe('pull to refresh', () => {
    it('fetches sessions on mount', async () => {
      cloudClient.getSessions.mockResolvedValueOnce({ sessions: [], totalCount: 0 });
      render(<ConversationsScreen />);
      await waitFor(() => expect(cloudClient.getSessions).toHaveBeenCalledTimes(1));
    });
  });

  describe('queued badge', () => {
    it('shows "Queued (3)" badge when 3 items target a session', async () => {
      const sessions = [
        mockSessionSummary({ id: 'q-1', title: 'Queued Session' }),
      ];
      mockQueuedCounts['q-1'] = 3;
      cloudClient.getSessions.mockResolvedValueOnce({ sessions, totalCount: sessions.length });

      const { getByText, getByTestId } = render(<ConversationsScreen />);
      await waitFor(() => expect(getByText('Queued Session')).toBeTruthy());

      expect(getByTestId('conversations-item-queued-badge-q-1')).toBeTruthy();
      expect(getByText('3')).toBeTruthy();
    });

    it('hides badge when 0 queued items', async () => {
      const sessions = [
        mockSessionSummary({ id: 'no-q', title: 'Clean Session' }),
      ];
      mockQueuedCounts['no-q'] = 0;
      cloudClient.getSessions.mockResolvedValueOnce({ sessions, totalCount: sessions.length });

      const { getByText, queryByTestId } = render(<ConversationsScreen />);
      await waitFor(() => expect(getByText('Clean Session')).toBeTruthy());

      expect(queryByTestId('conversations-item-queued-badge-no-q')).toBeNull();
    });

    it('shows different counts for different sessions', async () => {
      const sessions = [
        mockSessionSummary({ id: 's-a', title: 'Session A' }),
        mockSessionSummary({ id: 's-b', title: 'Session B' }),
      ];
      mockQueuedCounts['s-a'] = 2;
      mockQueuedCounts['s-b'] = 5;
      cloudClient.getSessions.mockResolvedValueOnce({ sessions, totalCount: sessions.length });

      const { getByText, getByTestId } = render(<ConversationsScreen />);
      await waitFor(() => expect(getByText('Session A')).toBeTruthy());

      expect(getByTestId('conversations-item-queued-badge-s-a')).toBeTruthy();
      expect(getByTestId('conversations-item-queued-badge-s-b')).toBeTruthy();
      expect(getByText('2')).toBeTruthy();
      expect(getByText('5')).toBeTruthy();
    });
  });
});
