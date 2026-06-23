/**
 * HomeScreen tests -- quick-send, recent sessions, today banner, and voice recording UI.
 */

import React from 'react';
import { render, fireEvent } from '@testing-library/react-native';
import { mockSessionSummary } from './helpers';

const mockPush = jest.fn();
jest.mock('expo-router', () => ({
  useRouter: () => ({ push: mockPush }),
}));

// Mock @react-navigation/native — HomeScreen uses useIsFocused to focus-gate
// the FloatingOrbs; in tests we don't have a NavigationContainer.
jest.mock('@react-navigation/native', () => ({
  useIsFocused: () => false,
}));

jest.mock('../../../cloud-client/src/cloudClient', () => ({
  // Defaults used by store effects; individual tests can override as needed.
  getSessions: jest.fn().mockResolvedValue({ sessions: [], totalCount: 0 }),
  ipcCall: jest.fn().mockResolvedValue([]),
}));

const { initAuthStore, useSessionStore, useApprovalStore, useAuthStore, useInboxStore } = require('@rebel/cloud-client');

function mockInboxItem(overrides: Record<string, unknown> = {}) {
  const now = Date.now();
  return {
    id: `inbox-${now}-${Math.random().toString(36).slice(2, 6)}`,
    title: 'Test Item',
    text: 'Some description',
    addedAt: now,
    references: [],
    ...overrides,
  };
}

beforeAll(() => {
  initAuthStore({
    getToken: jest.fn().mockResolvedValue(null),
    setToken: jest.fn().mockResolvedValue(undefined),
    clearToken: jest.fn().mockResolvedValue(undefined),
  });
});

import HomeScreen from '../../app/(tabs)/index';

beforeEach(() => {
  useSessionStore.setState({
    sessions: [],
    isLoading: false,
    error: null,
    currentSession: null,
    isLoadingSession: false,
    // Prevent HomeScreen's mount effect from clobbering test-controlled state.
    fetchSessions: jest.fn(),
  });
  useApprovalStore.setState({
    toolApprovals: [],
    stagedCalls: [],
    memoryApprovals: [],
    isLoading: false,
    error: null,
    // Prevent HomeScreen's mount effect from clobbering test-controlled state.
    fetchPending: jest.fn(),
  });
  useInboxStore.setState({
    items: [],
    fetchInbox: jest.fn(),
  });
  useAuthStore.setState({
    cloudUrl: 'https://my-rebel.fly.dev',
    token: 'tok',
    isPaired: true,
    isValidating: false,
    error: null,
  });
  mockPush.mockClear();
});

describe('HomeScreen', () => {
  describe('greeting', () => {
    it('renders a greeting header', () => {
      const { getByTestId } = render(<HomeScreen />);
      // Rebel greetings are random personality-forward quips (see rebelGreeting.ts);
      // we just verify the greeting testID exists rather than checking specific text.
      expect(getByTestId('home-greeting')).toBeTruthy();
    });
  });

  describe('recent sessions', () => {
    it('shows up to 4 recent sessions', () => {
      const sessions = Array.from({ length: 6 }, (_, i) =>
        mockSessionSummary({ id: `s${i}`, title: `Session ${i}`, updatedAt: Date.now() - i * 1000 }),
      );
      useSessionStore.setState({ sessions });

      const { getByText, queryByText } = render(<HomeScreen />);
      expect(getByText('Session 0')).toBeTruthy();
      expect(getByText('Session 3')).toBeTruthy();
      expect(queryByText('Session 4')).toBeNull();
    });

    it('shows both Active and Done sessions in Recent', () => {
      useSessionStore.setState({
        sessions: [
          mockSessionSummary({ id: 'done-1', title: 'Done Session', doneAt: Date.now() }),
          mockSessionSummary({ id: 'active-1', title: 'Active Session', doneAt: null }),
        ],
      });

      const { getByText } = render(<HomeScreen />);
      expect(getByText('Done Session')).toBeTruthy();
      expect(getByText('Active Session')).toBeTruthy();
    });

    it('excludes deleted sessions from Recent', () => {
      useSessionStore.setState({
        sessions: [
          mockSessionSummary({ id: 'alive-1', title: 'Alive Session', deletedAt: null }),
          mockSessionSummary({ id: 'deleted-1', title: 'Deleted Session', deletedAt: Date.now() }),
        ],
      });

      const { getByText, queryByText } = render(<HomeScreen />);
      expect(getByText('Alive Session')).toBeTruthy();
      expect(queryByText('Deleted Session')).toBeNull();
    });

    it('excludes cached background sessions from Recent', () => {
      useSessionStore.setState({
        sessions: [
          mockSessionSummary({ id: 'manual-1', title: 'Manual Session', deletedAt: null }),
          mockSessionSummary({
            id: 'automation-source-capture--recent',
            title: 'Source Capture',
            deletedAt: null,
          }),
        ],
      });

      const { getByText, queryByText } = render(<HomeScreen />);
      expect(getByText('Manual Session')).toBeTruthy();
      expect(queryByText('Source Capture')).toBeNull();
    });

    it('navigates to session on press', () => {
      useSessionStore.setState({
        sessions: [mockSessionSummary({ id: 'nav-test', title: 'Go Here' })],
      });

      const { getByText } = render(<HomeScreen />);
      fireEvent.press(getByText('Go Here'));
      expect(mockPush).toHaveBeenCalledWith('/conversation/nav-test');
    });
  });

  describe('today cards', () => {
    it('shows today cards section when actions are due today', () => {
      useInboxStore.setState({
        items: [mockInboxItem({ urgent: true, dueBy: Date.now() + 60 * 60 * 1000 })],
      });

      const { getByTestId } = render(<HomeScreen />);
      expect(getByTestId('today-cards-section')).toBeTruthy();
    });

    it('shows approval today card when approvals are pending', () => {
      useApprovalStore.setState({
        toolApprovals: [
          { toolUseID: 'a1', turnId: 't1', toolName: 'exec', input: {}, timestamp: Date.now() },
          { toolUseID: 'a2', turnId: 't2', toolName: 'write', input: {}, timestamp: Date.now() },
        ],
        stagedCalls: [],
        memoryApprovals: [],
      });

      const { getByTestId } = render(<HomeScreen />);
      expect(getByTestId('today-card-approval')).toBeTruthy();
    });

    it('hides today cards section when no today actions and no approvals', () => {
      useInboxStore.setState({ items: [] });
      const { queryByTestId } = render(<HomeScreen />);
      expect(queryByTestId('today-cards-section')).toBeNull();
    });

    it('navigates to inbox tab on today card press', () => {
      useApprovalStore.setState({
        toolApprovals: [{ toolUseID: 'a1', turnId: 't1', toolName: 'exec', input: {}, timestamp: Date.now() }],
        stagedCalls: [],
        memoryApprovals: [],
      });

      const { getByTestId } = render(<HomeScreen />);
      fireEvent.press(getByTestId('today-card-approval'));
      expect(mockPush).toHaveBeenCalledWith('/(tabs)/inbox');
    });
  });

  describe('quick-start chips', () => {
    it('shows quick-start chips for empty state when no sessions', () => {
      useSessionStore.setState({ sessions: [] });
      useApprovalStore.setState({
        toolApprovals: [],
        stagedCalls: [],
        memoryApprovals: [],
      });
      useInboxStore.setState({ items: [] });

      const { getByTestId } = render(<HomeScreen />);
      expect(getByTestId('quick-start-chips')).toBeTruthy();
      expect(getByTestId('quick-start-chip-new-conversation')).toBeTruthy();
    });
  });

  describe('active sessions', () => {
    it('shows active (busy) sessions section', () => {
      useSessionStore.setState({
        sessions: [
          mockSessionSummary({ id: 'busy-1', title: 'Running Task', isBusy: true }),
          mockSessionSummary({ id: 'idle-1', title: 'Done', isBusy: false }),
        ],
      });

      const { getByText, getAllByText } = render(<HomeScreen />);
      expect(getByText('Active')).toBeTruthy();
      // "Running Task" appears in both Active and Recent sections
      expect(getAllByText('Running Task').length).toBeGreaterThanOrEqual(1);
    });

    it('excludes cached background sessions from Active', () => {
      useSessionStore.setState({
        sessions: [
          mockSessionSummary({
            id: 'automation-source-capture--busy',
            title: 'Source Capture',
            isBusy: true,
          }),
        ],
      });

      const { queryByText, queryByTestId } = render(<HomeScreen />);
      expect(queryByText('Source Capture')).toBeNull();
      expect(queryByTestId('home-active-sessions-list')).toBeNull();
    });
  });

});
