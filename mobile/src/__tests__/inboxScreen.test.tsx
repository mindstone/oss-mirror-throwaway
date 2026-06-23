/**
 * InboxScreen tests — item display, detail modal, empty state, and home today banner behavior.
 */

import React from 'react';
import { render, fireEvent, waitFor } from '@testing-library/react-native';

const mockPush = jest.fn();
const mockSetParams = jest.fn();
let mockSearchParams: Record<string, string> = {};
const mockWebSocketSend = jest.fn();
const mockWebSocketClose = jest.fn();
const mockWebSocket = jest.fn().mockImplementation(() => ({
  onopen: null,
  onmessage: null,
  onerror: null,
  onclose: null,
  readyState: 0,
  send: mockWebSocketSend,
  close: mockWebSocketClose,
}));
Object.assign(mockWebSocket, { OPEN: 1, CONNECTING: 0 });
const originalWebSocket = global.WebSocket;
const mockHandleApprove = jest.fn();
const mockHandleDeny = jest.fn();
const mockHandleExecuteStagedCall = jest.fn();
const mockHandleRejectStagedCall = jest.fn();
const mockApproveMemoryWrite = jest.fn();
const mockSkipMemoryWrite = jest.fn();

jest.mock('expo-router', () => ({
  useRouter: () => ({ push: mockPush, setParams: mockSetParams }),
  useLocalSearchParams: () => mockSearchParams,
}));

jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

// Mock @react-navigation/native — HomeScreen uses useIsFocused to focus-gate
// the FloatingOrbs; in tests we don't have a NavigationContainer.
jest.mock('@react-navigation/native', () => ({
  useIsFocused: () => false,
}));

jest.mock('../../src/hooks/useApprovalActions', () => ({
  useApprovalActions: () => ({
    handleApprove: mockHandleApprove,
    handleDeny: mockHandleDeny,
    handleExecute: mockHandleExecuteStagedCall,
    handleReject: mockHandleRejectStagedCall,
    approveMemoryWrite: mockApproveMemoryWrite,
    skipMemoryWrite: mockSkipMemoryWrite,
    actionError: null,
    clearError: jest.fn(),
  }),
}));

const { initAuthStore, configure, useInboxStore, useAuthStore, useSessionStore, useApprovalStore } =
  require('@rebel/cloud-client');

beforeAll(() => {
  global.WebSocket = mockWebSocket as unknown as typeof WebSocket;
  initAuthStore({
    getToken: jest.fn().mockResolvedValue(null),
    setToken: jest.fn().mockResolvedValue(undefined),
    clearToken: jest.fn().mockResolvedValue(undefined),
  });
});

afterAll(() => {
  global.WebSocket = originalWebSocket;
});

import InboxScreen from '../../app/(tabs)/inbox';
import HomeScreen from '../../app/(tabs)/index';
import type { InboxItem, InboxHistoryEntry } from '@rebel/cloud-client';

function mockInboxItem(overrides: Partial<InboxItem> = {}): InboxItem {
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

function mockHistoryEntry(overrides: Partial<InboxHistoryEntry> = {}): InboxHistoryEntry {
  const now = Date.now();
  return {
    id: `hist-${now}`,
    title: 'Completed Task',
    text: 'Was executed',
    addedAt: now - 60_000,
    references: [],
    executedAt: now,
    sessionId: 'session-abc',
    mode: 'execute' as const,
    ...overrides,
  };
}

beforeEach(() => {
  useInboxStore.setState({
    items: [],
    history: [],
    isLoading: false,
    error: null,
    fetchInbox: jest.fn(),
    addItem: jest.fn(),
    deleteItem: jest.fn(),
    archiveItem: jest.fn(),
    snoozeItem: jest.fn(),
    setQuadrant: jest.fn(),
    setStatus: jest.fn(),
    setTags: jest.fn(),
    executeItem: jest.fn(),
    handleInboxEvent: jest.fn(),
  });
  useSessionStore.setState({
    sessions: [],
    isLoading: false,
    error: null,
    fetchSessions: jest.fn(),
  });
  useApprovalStore.setState({
    toolApprovals: [],
    stagedCalls: [],
    memoryApprovals: [],
    isLoading: false,
    error: null,
    fetchPending: jest.fn(),
  });
  useAuthStore.setState({
    cloudUrl: 'https://my-rebel.fly.dev',
    token: 'tok',
    isPaired: true,
    isValidating: false,
    error: null,
  });
  configure({ cloudUrl: 'https://my-rebel.fly.dev', token: 'tok' });
  mockPush.mockClear();
  mockSetParams.mockClear();
  mockSearchParams = {};
  mockWebSocket.mockClear();
  mockWebSocketSend.mockClear();
  mockWebSocketClose.mockClear();
  mockHandleApprove.mockReset();
  mockHandleDeny.mockReset();
  mockHandleExecuteStagedCall.mockReset();
  mockHandleRejectStagedCall.mockReset();
  mockApproveMemoryWrite.mockReset();
  mockSkipMemoryWrite.mockReset();
});

describe('InboxScreen', () => {
  describe('empty state', () => {
    it('shows empty state when no items', () => {
      const { getByText } = render(<InboxScreen />);
      expect(getByText('Nothing for today. Enjoy the calm.')).toBeTruthy();
      expect(getByText('Nothing else this week.')).toBeTruthy();
    });
  });

  describe('header', () => {
    it('shows title and item count', () => {
      useInboxStore.setState({
        items: [
          mockInboxItem({ id: '1', title: 'A' }),
          mockInboxItem({ id: '2', title: 'B' }),
        ],
      });

      const { getByText } = render(<InboxScreen />);
      expect(getByText('Actions')).toBeTruthy();
      expect(getByText('2 items')).toBeTruthy();
    });

    it('shows singular "item" for one item', () => {
      useInboxStore.setState({
        items: [mockInboxItem({ id: '1', title: 'Only One' })],
      });

      const { getByText } = render(<InboxScreen />);
      expect(getByText('1 item')).toBeTruthy();
    });

    it('does not show count when no active items', () => {
      const { queryByText } = render(<InboxScreen />);
      expect(queryByText(/\d+ items?/)).toBeNull();
    });

    it('does not show an add-item input', () => {
      const { queryByPlaceholderText, queryByLabelText } = render(<InboxScreen />);
      expect(queryByPlaceholderText('Add something to the pile…')).toBeNull();
      expect(queryByLabelText('Switch to typing')).toBeNull();
      expect(queryByLabelText('Tap to add by voice')).toBeNull();
    });
  });

  describe('temporal sections', () => {
    // Pin to a Wednesday so all three buckets (Today / This Week / Later) are reachable.
    // On Friday the "This Week" window is zero (weekEnd = todayEnd), causing flaky failures.
    const WEDNESDAY = new Date('2026-03-25T12:00:00Z'); // a Wednesday

    beforeEach(() => { jest.useFakeTimers({ now: WEDNESDAY }); });
    afterEach(() => { jest.useRealTimers(); });

    it('groups items into Today, This Week, and Later', () => {
      const now = WEDNESDAY.getTime();
      useInboxStore.setState({
        items: [
          mockInboxItem({ id: 'today', title: 'Today task', addedAt: now, dueBy: now + 30 * 60 * 1000 }),
          mockInboxItem({ id: 'week', title: 'This week task', addedAt: now, dueBy: now + 2 * 24 * 60 * 60 * 1000 }),
          mockInboxItem({ id: 'later', title: 'Later task', addedAt: now, dueBy: now + 14 * 24 * 60 * 60 * 1000 }),
        ],
      });

      const { getByText } = render(<InboxScreen />);
      expect(getByText('Today')).toBeTruthy();
      expect(getByText('This Week')).toBeTruthy();
      expect(getByText('Later')).toBeTruthy();
    });

    it('hides empty temporal sections', () => {
      const now = WEDNESDAY.getTime();
      useInboxStore.setState({
        items: [
          mockInboxItem({ id: 'today-only', title: 'Only today', addedAt: now, dueBy: now + 30 * 60 * 1000 }),
        ],
      });

      const { getByText, queryByText } = render(<InboxScreen />);
      expect(getByText('Today')).toBeTruthy();
      expect(queryByText('This Week')).toBeNull();
      expect(queryByText('Later')).toBeNull();
    });
  });

  describe('item display (compact cards)', () => {
    it('shows item title', () => {
      useInboxStore.setState({
        items: [mockInboxItem({ id: '1', title: 'My Task' })],
      });

      const { getByText } = render(<InboxScreen />);
      expect(getByText('My Task')).toBeTruthy();
    });

    it('shows urgency label for urgent+important items', () => {
      useInboxStore.setState({
        items: [mockInboxItem({ id: '1', title: 'Top priority', urgent: true, important: true })],
      });

      const { getByText } = render(<InboxScreen />);
      expect(getByText('Urgent')).toBeTruthy();
    });

    it('shows "Important" label for important-only items', () => {
      useInboxStore.setState({
        items: [mockInboxItem({ id: '1', title: 'Needs attention', urgent: false, important: true })],
      });

      const { getByText } = render(<InboxScreen />);
      expect(getByText('Important')).toBeTruthy();
    });

    it('shows no urgency label for urgent-only items', () => {
      useInboxStore.setState({
        items: [mockInboxItem({ id: '1', title: 'Urgent Only', urgent: true, important: false })],
      });

      const { queryByText } = render(<InboxScreen />);
      expect(queryByText('Urgent')).toBeNull();
      expect(queryByText('Important')).toBeNull();
    });

    it('shows executing indicator for running items', () => {
      useInboxStore.setState({
        items: [mockInboxItem({ id: '1', title: 'Running', executingSessionId: 'sess-1' })],
      });

      // The executing text uses getProcessingQuip() which is random — just check the indicator renders
      const { getByText } = render(<InboxScreen />);
      expect(getByText('Running')).toBeTruthy();
    });

    it('does not show inline action buttons on cards', () => {
      useInboxStore.setState({
        items: [mockInboxItem({ id: '1', title: 'Task' })],
      });

      const { queryByText } = render(<InboxScreen />);
      // Inline "Review", "Archive", "Delete" buttons were removed from cards
      // (they're only in the detail modal now)
      expect(queryByText('Archive')).toBeNull();
    });

    it('does not show inline context input on cards', () => {
      useInboxStore.setState({
        items: [mockInboxItem({ id: '1', title: 'Task' })],
      });

      const { queryByPlaceholderText } = render(<InboxScreen />);
      expect(queryByPlaceholderText(/e\.g\.|Add context/i)).toBeNull();
    });

    it('starts the turn in the background when executing from detail modal', async () => {
      const executeItem = jest.fn().mockResolvedValue({
        sessionId: 'sess-1',
        prompt: 'Handle this',
      });
      useInboxStore.setState({
        items: [mockInboxItem({ id: '1', title: 'Task to execute' })],
        executeItem,
      });

      const { getByText, getByTestId } = render(<InboxScreen />);
      fireEvent.press(getByText('Task to execute'));
      fireEvent.press(getByTestId('inbox-detail-execute-button'));

      await waitFor(() => {
        expect(executeItem).toHaveBeenCalledWith('1', undefined);
        expect(mockWebSocket).toHaveBeenCalledWith(expect.stringContaining('/api/agent/turn?token='));
        expect(mockPush).not.toHaveBeenCalled();
        expect(getByText('Rebel is on it \u2713')).toBeTruthy();
      });
    });
  });

  describe('archived section', () => {
    it('shows archived toggle when archived items exist', () => {
      useInboxStore.setState({
        items: [mockInboxItem({ id: '1', title: 'Archived Task', archived: true })],
      });

      const { getByText } = render(<InboxScreen />);
      expect(getByText(/Archived \(1\)/)).toBeTruthy();
    });

    it('shows history entries with "View" link', () => {
      useInboxStore.setState({
        history: [mockHistoryEntry({ id: 'h1', title: 'Done Task', sessionId: 'sess-xyz' })],
      });

      const { getByText } = render(<InboxScreen />);
      fireEvent.press(getByText(/Archived \(1\)/));
      expect(getByText('Done Task')).toBeTruthy();
      expect(getByText('View →')).toBeTruthy();
    });

    it('navigates to conversation when history item pressed', () => {
      useInboxStore.setState({
        history: [mockHistoryEntry({ id: 'h1', title: 'Done Task', sessionId: 'sess-xyz' })],
      });

      const { getByText } = render(<InboxScreen />);
      fireEvent.press(getByText(/Archived \(1\)/));
      fireEvent.press(getByText('View →'));

      expect(mockPush).toHaveBeenCalledWith('/conversation/sess-xyz');
    });

    it('uses autoCompleted for the "Handled by Rebel" section', () => {
      const now = Date.now();
      useInboxStore.setState({
        items: [
          mockInboxItem({
            id: 'auto',
            title: 'Auto done',
            archived: true,
            archivedAt: now,
            autoCompleted: true,
            executingSessionId: 'sess-auto',
          }),
          mockInboxItem({
            id: 'manual',
            title: 'Manual done',
            archived: true,
            archivedAt: now,
            autoCompleted: false,
            executingSessionId: 'sess-manual',
          }),
        ],
      });

      const { getByText, queryByText } = render(<InboxScreen />);
      expect(getByText(/Handled by Rebel \(1\)/)).toBeTruthy();

      fireEvent.press(getByText(/Handled by Rebel \(1\)/));
      expect(getByText('Auto done')).toBeTruthy();
      expect(queryByText('Manual done')).toBeNull();
    });
  });

  describe('loading state', () => {
    it('shows loading spinner when loading with no items', () => {
      useInboxStore.setState({ isLoading: true, items: [] });
      const { UNSAFE_getByType } = render(<InboxScreen />);
      const { ActivityIndicator } = require('react-native');
      expect(UNSAFE_getByType(ActivityIndicator)).toBeTruthy();
    });
  });

  describe('error state', () => {
    it('shows error with retry when error and no items', () => {
      useInboxStore.setState({ error: 'Network fail', items: [] });

      const { getByText } = render(<InboxScreen />);
      expect(getByText('Network fail')).toBeTruthy();
      expect(getByText('Retry')).toBeTruthy();
    });

    it('calls fetchInbox on retry', () => {
      const fetchInbox = jest.fn();
      useInboxStore.setState({ error: 'Network fail', items: [], fetchInbox });

      const { getByText } = render(<InboxScreen />);
      fireEvent.press(getByText('Retry'));

      expect(fetchInbox).toHaveBeenCalled();
    });

    it('shows inline error banner when error with existing items', () => {
      useInboxStore.setState({
        error: 'Sync failed',
        items: [mockInboxItem({ id: '1', title: 'Existing' })],
      });

      const { getByText } = render(<InboxScreen />);
      expect(getByText('Sync failed')).toBeTruthy();
      expect(getByText('Existing')).toBeTruthy();
    });
  });

  describe('deep-link from Today cards', () => {
    it('auto-opens detail modal when focusItemId param matches an item', () => {
      const item = mockInboxItem({ id: 'focus-target', title: 'Focus Me' });
      useInboxStore.setState({ items: [item] });
      mockSearchParams = { focusItemId: 'focus-target' };

      const { getByTestId } = render(<InboxScreen />);
      expect(getByTestId('inbox-detail-execute-button')).toBeTruthy();
      expect(mockSetParams).toHaveBeenCalledWith({ focusItemId: undefined });
    });

    it('clears focusItemId param even when item is not found', () => {
      useInboxStore.setState({ items: [mockInboxItem({ id: 'other', title: 'Other' })] });
      mockSearchParams = { focusItemId: 'deleted-item' };

      const { queryByTestId } = render(<InboxScreen />);
      expect(queryByTestId('inbox-detail-execute-button')).toBeNull();
      expect(mockSetParams).toHaveBeenCalledWith({ focusItemId: undefined });
    });
  });
});

describe('InboxScreen approval section', () => {
  it('shows approval section when tool approvals exist', () => {
    useApprovalStore.setState({
      toolApprovals: [
        { toolUseID: 'a1', turnId: 't1', toolName: 'exec_cmd', input: { cmd: 'ls' }, timestamp: Date.now(), sessionId: 's1' },
      ],
      stagedCalls: [],
      fetchPending: jest.fn(),
    });

    const { getByText, getByTestId } = render(<InboxScreen />);
    expect(getByTestId('inbox-approval-section')).toBeTruthy();
    expect(getByText('Needs your OK')).toBeTruthy();
    expect(getByText('exec_cmd')).toBeTruthy();
  });

  it('shows approval section when staged calls exist', () => {
    useApprovalStore.setState({
      toolApprovals: [],
      stagedCalls: [
        {
          id: 'sc1',
          sessionId: 's1',
          turnId: 't1',
          displayName: 'file_write',
          riskLevel: 'high',
          reason: 'Writes to disk',
          toolCategory: 'filesystem',
          mcpPayload: { server: 'fs', tool: 'write', args: { path: '/tmp/test' } },
        },
      ],
      fetchPending: jest.fn(),
    });

    const { getByText, getByTestId } = render(<InboxScreen />);
    expect(getByTestId('inbox-approval-section')).toBeTruthy();
    expect(getByText('file_write')).toBeTruthy();
  });

  it('shows approval section when memory approvals exist', () => {
    useApprovalStore.setState({
      toolApprovals: [],
      stagedCalls: [],
      memoryApprovals: [
        {
          toolUseId: 'mem-1',
          originalTurnId: 't1',
          originalSessionId: 's1',
          spaceName: 'Knowledge',
          spacePath: '/knowledge',
          filePath: 'memory.md',
          summary: 'Save summary',
          contentPreview: 'A short preview',
          timestamp: Date.now(),
          sharing: 'private',
          isNewFile: true,
          blockedBy: 'unknown',
        },
      ],
      fetchPending: jest.fn(),
    });

    const { getByTestId, getByText } = render(<InboxScreen />);
    expect(getByTestId('inbox-approval-section')).toBeTruthy();
    expect(getByTestId('approvals-memory-card-mem-1')).toBeTruthy();
    expect(getByText(/Knowledge/)).toBeTruthy();
  });

  it('fires memory save/skip callbacks', () => {
    const memoryApproval = {
      toolUseId: 'mem-2',
      originalTurnId: 't2',
      originalSessionId: 's2',
      spaceName: 'Knowledge',
      spacePath: '/knowledge',
      filePath: 'decision.md',
      summary: 'Save decision',
      contentPreview: 'Decision preview',
      timestamp: Date.now(),
      sharing: 'private',
      isNewFile: false,
      blockedBy: 'unknown',
    };

    useApprovalStore.setState({
      toolApprovals: [],
      stagedCalls: [],
      memoryApprovals: [memoryApproval],
      fetchPending: jest.fn(),
    });
    useInboxStore.setState({ items: [] });

    const { getByTestId } = render(<InboxScreen />);
    fireEvent.press(getByTestId('approvals-memory-save-button-mem-2'));
    fireEvent.press(getByTestId('approvals-memory-skip-button-mem-2'));

    expect(mockApproveMemoryWrite).toHaveBeenCalledWith(expect.objectContaining({ toolUseId: 'mem-2' }));
    expect(mockSkipMemoryWrite).toHaveBeenCalledWith(expect.objectContaining({ toolUseId: 'mem-2' }));
  });

  it('shows approvals above inbox items with section headers', () => {
    useApprovalStore.setState({
      toolApprovals: [
        { toolUseID: 'a1', turnId: 't1', toolName: 'run_cmd', input: {}, timestamp: Date.now() },
      ],
      stagedCalls: [],
      fetchPending: jest.fn(),
    });
    useInboxStore.setState({
      items: [mockInboxItem({ id: '1', title: 'My Task' })],
    });

    const { getByText } = render(<InboxScreen />);
    expect(getByText('Needs your OK')).toBeTruthy();
    expect(getByText('Actions')).toBeTruthy();
    expect(getByText('My Task')).toBeTruthy();
  });

  it('shows approvals without showing empty state when no inbox items', () => {
    useApprovalStore.setState({
      toolApprovals: [
        { toolUseID: 'a1', turnId: 't1', toolName: 'run_cmd', input: {}, timestamp: Date.now() },
      ],
      stagedCalls: [],
      fetchPending: jest.fn(),
    });
    useInboxStore.setState({ items: [] });

    const { getByText, queryByText } = render(<InboxScreen />);
    expect(getByText('Needs your OK')).toBeTruthy();
    expect(queryByText('Nothing for today. Enjoy the calm.')).toBeNull();
  });

  it('shows memory approvals alongside inbox items in ListHeaderComponent', () => {
    useApprovalStore.setState({
      toolApprovals: [],
      stagedCalls: [],
      memoryApprovals: [
        {
          toolUseId: 'mem-4',
          originalTurnId: 't4',
          originalSessionId: 's4',
          spaceName: 'Research',
          spacePath: '/research',
          filePath: 'findings.md',
          summary: 'Save findings',
          contentPreview: 'Findings preview',
          timestamp: Date.now(),
          sharing: 'private',
          isNewFile: false,
          blockedBy: 'unknown',
        },
      ],
      fetchPending: jest.fn(),
    });
    useInboxStore.setState({
      items: [mockInboxItem({ id: '1', title: 'My Task' })],
    });

    const { getByText } = render(<InboxScreen />);
    expect(getByText('Needs your OK')).toBeTruthy();
    expect(getByText('Actions')).toBeTruthy();
    expect(getByText('My Task')).toBeTruthy();
    expect(getByText(/Research/)).toBeTruthy();
  });

  it('shows memory approvals without showing empty state when no inbox items', () => {
    useApprovalStore.setState({
      toolApprovals: [],
      stagedCalls: [],
      memoryApprovals: [
        {
          toolUseId: 'mem-3',
          originalTurnId: 't3',
          originalSessionId: 's3',
          spaceName: 'Knowledge',
          spacePath: '/knowledge',
          filePath: 'notes.md',
          summary: 'Save notes',
          contentPreview: 'Notes preview',
          timestamp: Date.now(),
          sharing: 'private',
          isNewFile: false,
          blockedBy: 'unknown',
        },
      ],
      fetchPending: jest.fn(),
    });
    useInboxStore.setState({ items: [] });

    const { getByText, queryByText } = render(<InboxScreen />);
    expect(getByText('Needs your OK')).toBeTruthy();
    expect(getByText(/Knowledge/)).toBeTruthy();
    expect(queryByText('Nothing for today. Enjoy the calm.')).toBeNull();
  });

  it('hides approval section when no approvals', () => {
    useInboxStore.setState({
      items: [mockInboxItem({ id: '1', title: 'My Task' })],
    });

    const { queryByTestId, queryByText } = render(<InboxScreen />);
    expect(queryByTestId('inbox-approval-section')).toBeNull();
    // "Actions" section header only shown when approvals exist alongside inbox items
    expect(queryByText('Needs your OK')).toBeNull();
  });
});

describe('HomeScreen today banner + handled card', () => {
  it('shows today cards for items due today', () => {
    const now = Date.now();
    useInboxStore.setState({
      items: [
        mockInboxItem({ id: 'today-1', title: 'Today task', urgent: true, dueBy: now + 45 * 60 * 1000 }),
        mockInboxItem({ id: 'later-1', title: 'Later task', dueBy: now + 10 * 24 * 60 * 60 * 1000 }),
        mockInboxItem({ id: 'archived', title: 'Archived today', archived: true, dueBy: now + 30 * 60 * 1000 }),
      ],
      fetchInbox: jest.fn(),
    });

    const { getByTestId, getByText } = render(<HomeScreen />);
    expect(getByTestId('today-cards-section')).toBeTruthy();
    expect(getByText('Today task')).toBeTruthy();
  });

  it('shows approval today card when approvals are pending', () => {
    useInboxStore.setState({
      items: [mockInboxItem({ id: 'today-1', title: 'Today task', urgent: true, dueBy: Date.now() + 45 * 60 * 1000 })],
      fetchInbox: jest.fn(),
    });
    useApprovalStore.setState({
      toolApprovals: [
        { toolUseID: 'a1', turnId: 't1', toolName: 'run_cmd', input: {}, timestamp: Date.now() },
      ],
      stagedCalls: [
        {
          id: 's1',
          toolUseID: 'u1',
          turnId: 't2',
          toolName: 'write_file',
          input: {},
          timestamp: Date.now(),
        },
      ],
      fetchPending: jest.fn(),
    });

    const { getByTestId } = render(<HomeScreen />);
    expect(getByTestId('today-card-approval')).toBeTruthy();
    expect(getByTestId('today-card-inbox')).toBeTruthy();
  });

  it('hides today banner when no today actions and no pending approvals', () => {
    useInboxStore.setState({
      items: [mockInboxItem({ id: 'future-1', title: 'Future task', dueBy: Date.now() + 14 * 24 * 60 * 60 * 1000 })],
      fetchInbox: jest.fn(),
    });

    const { queryByTestId } = render(<HomeScreen />);
    expect(queryByTestId('home-today-banner')).toBeNull();
  });

  it('shows handled-by-Rebel card for today auto-completed items and supports expand + dismiss', () => {
    const now = Date.now();
    useInboxStore.setState({
      items: [
        mockInboxItem({
          id: 'handled-today',
          title: 'Auto finished today',
          archived: true,
          autoCompleted: true,
          completedAt: now,
        }),
        mockInboxItem({
          id: 'handled-yesterday',
          title: 'Auto finished yesterday',
          archived: true,
          autoCompleted: true,
          completedAt: now - 24 * 60 * 60 * 1000,
        }),
      ],
      fetchInbox: jest.fn(),
    });

    const { getByText, getByTestId, queryByText, queryByTestId } = render(<HomeScreen />);
    expect(getByText('While you were away, Rebel handled 1 item.')).toBeTruthy();
    expect(getByText('Consider it done. That one is off your plate.')).toBeTruthy();
    expect(queryByText('Auto finished today')).toBeNull();

    fireEvent.press(getByTestId('home-handled-by-rebel-toggle'));
    expect(getByText('Auto finished today')).toBeTruthy();

    fireEvent.press(getByTestId('home-handled-by-rebel-dismiss'));
    expect(queryByTestId('home-handled-by-rebel-card')).toBeNull();
  });
});
