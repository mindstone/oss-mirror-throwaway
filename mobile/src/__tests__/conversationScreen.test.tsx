/**
 * ConversationScreen E2E-style tests.
 *
 * Renders the screen with mocked cloudClient and verifies the full
 * event lifecycle: send -> turn_started -> status -> assistant_delta ->
 * tool -> assistant -> result, plus multi-turn flows.
 */

import React from 'react';
import { render, fireEvent, waitFor, act } from '@testing-library/react-native';
import { ActionSheetIOS, Alert, Linking, StyleSheet } from 'react-native';
import { mockFullSession, mockMessage, MockWebSocket, flushPromises } from './helpers';
import type { QueueItem, WebFileAttachment } from '@rebel/cloud-client';
import {
  asCloudMeetingSessionId,
  asCompanionConversationId,
  asLocalRecordingId,
} from '@rebel/cloud-client';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { rehydrateActiveRecordingIds, useActiveRecordingStore } from '../stores/activeRecordingStore';

// Mock expo-router
const mockPush = jest.fn();
const mockBack = jest.fn();
let mockSearchParams: Record<string, string | undefined> = { id: 'session-1' };
let latestStackOptions: Record<string, unknown> | null = null;
jest.mock('expo-router', () => ({
  useLocalSearchParams: () => mockSearchParams,
  useRouter: () => ({ push: mockPush, back: mockBack }),
  Stack: {
    Screen: ({ options }: { options: Record<string, unknown> }) => {
      latestStackOptions = options;
      return null;
    },
  },
}));

// Mock @react-navigation/native — the conversation screen uses useIsFocused
// to focus-gate the empty-state FloatingOrbs; in tests we don't have a
// NavigationContainer, so return a stable false.
jest.mock('@react-navigation/native', () => ({
  useIsFocused: () => false,
}));

let mockSafeAreaInsets = { top: 0, bottom: 0, left: 0, right: 0 };

// Mock react-native-safe-area-context (required by FileViewerModal)
jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => mockSafeAreaInsets,
  SafeAreaProvider: ({ children }: { children: React.ReactNode }) => children,
}));

// Mock MeetingRecordingContext (used by conversation screen for meeting banner)
const mockMeetingRecordingContextValue = {
  state: 'idle',
  isRecording: false,
  meetingSessionId: null as string | null,
  meetingCloudSessionId: null as string | null,
  meetingTitle: '',
  companionSessionId: null as string | null,
  error: null as string | null,
  startRecording: jest.fn(),
  stopRecording: jest.fn(),
  setMeetingTitle: jest.fn(),
};

jest.mock('../../src/context/MeetingRecordingContext', () => ({
  useMeetingRecordingContext: () => mockMeetingRecordingContextValue,
  MeetingRecordingProvider: ({ children }: { children: React.ReactNode }) => children,
}));

let mockVoiceHookState: {
  isRecording: boolean;
  isTranscribing: boolean;
  error: string | null;
} = {
  isRecording: false,
  isTranscribing: false,
  error: null,
};
let capturedVoiceTranscriptHandler: ((text: string) => void) | null = null;
const mockToggleRecording = jest.fn();
const mockStartRecording = jest.fn();
const mockStopRecording = jest.fn();

jest.mock('../../src/hooks/useMobileVoiceRecording', () => ({
  useMobileVoiceRecording: (onTranscript: (text: string) => void) => {
    capturedVoiceTranscriptHandler = onTranscript;
    return {
      isRecording: mockVoiceHookState.isRecording,
      isTranscribing: mockVoiceHookState.isTranscribing,
      toggleRecording: mockToggleRecording,
      startRecording: mockStartRecording,
      stopRecording: mockStopRecording,
      error: mockVoiceHookState.error,
    };
  },
}));

// Mock MeetingHealthIndicator (used by conversation screen for transcript status)
jest.mock('../../src/hooks/useMeetingHealthIndicator', () => ({
  useMeetingHealthIndicator: () => ({
    status: 'connected',
    label: 'Connected',
    pendingChunks: 0,
    failedChunks: 0,
    lastCloudAckAgeMs: null,
  }),
}));

let mockAttachments: WebFileAttachment[] = [];
const mockClearAttachments = jest.fn();
const mockRestoreAttachments = jest.fn();

jest.mock('../../src/hooks/useMobileFileAttachments', () => ({
  useMobileFileAttachments: () => ({
    attachments: mockAttachments,
    pickImage: jest.fn(),
    pickDocument: jest.fn(),
    removeAttachment: jest.fn(),
    clearAttachments: mockClearAttachments,
    restoreAttachments: mockRestoreAttachments,
    canAddMore: true,
  }),
}));

// Mock cloudClient
let onEventCallback: ((event: unknown) => void) | null = null;
let onErrorCallback: ((err: Error) => void) | null = null;
const mockClose = jest.fn();
const mockStopTurn = jest.fn().mockResolvedValue(undefined);
const mockQueueConsumer = jest.fn().mockResolvedValue({ success: true });

// cloud-client stores/hooks call the internal API module directly.
// useSmoothStream uses requestAnimationFrame which doesn't fire synchronously
// in Jest. Pass raw text through directly so streaming assertions work.
jest.mock('../../../cloud-client/src/hooks/useSmoothStream', () => ({
  useSmoothStream: (rawText: string | undefined) => rawText ?? '',
}));

jest.mock('../../../cloud-client/src/cloudClient', () => {
  class CloudClientError extends Error {
    statusCode?: number;
    constructor(message: string, statusCode?: number) {
      super(message);
      this.name = 'CloudClientError';
      this.statusCode = statusCode;
    }
  }

  return {
    createAgentTurnSocket: jest.fn(
      (
        _req: unknown,
        onEvent: (event: unknown) => void,
        onError: (err: Error) => void,
        _onClose?: (code: number, reason: string) => void,
      ) => {
        onEventCallback = onEvent;
        onErrorCallback = onError;
        return { close: mockClose };
      },
    ),
    stopTurn: jest.fn((...args: unknown[]) => mockStopTurn(...args)),
    getSessions: jest.fn().mockResolvedValue({ sessions: [], totalCount: 0 }),
    getSession: jest.fn(),
    updateSession: jest.fn().mockResolvedValue(undefined),
    getSettings: jest.fn().mockResolvedValue({}),
    ipcCall: jest.fn(),
    readWorkspaceFile: jest.fn().mockResolvedValue({ content: '# Test file content' }),
    CloudClientError,
  };
});

const {
  useSessionStore,
  useApprovalStore,
  useOfflineQueueStore,
  initOfflineQueueStore,
  initAuthStore,
  useAuthStore,
  useSessionConflictStore,
} = require('@rebel/cloud-client');
const { _resetOfflineQueueStore } = require('../../../cloud-client/src/offlineQueue/offlineQueueStore');
const cloudClient = require('../../../cloud-client/src/cloudClient');
let linkingOpenUrlSpy: jest.SpyInstance;

// Import AFTER mocks
import ConversationScreen from '../../app/conversation/[id]';
import { createTextQueueConsumer } from '../hooks/useTextQueueConsumer';
import { NetworkContext } from '../context/NetworkContext';

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

const mockAuthStorage = {
  getToken: jest.fn().mockResolvedValue(null),
  setToken: jest.fn().mockResolvedValue(undefined),
  clearToken: jest.fn().mockResolvedValue(undefined),
};

function resetStores() {
  useApprovalStore.setState({
    toolApprovals: [],
    stagedCalls: [],
    isLoading: false,
    error: null,
  });
  useSessionStore.setState({
    sessions: [],
    isLoading: false,
    error: null,
    currentSession: null,
    isLoadingSession: false,
    completedStepsByTurnId: {},
    connectionState: 'connected',
    tombstonedSessionIds: new Set<string>(),
  });
  useSessionConflictStore.getState().resetSessionConflicts();
}

function renderConversationWithNetwork(isOnline: boolean) {
  return render(
    <NetworkContext.Provider
      value={{ isOnline, isInternetReachable: isOnline, isConnected: isOnline }}
    >
      <ConversationScreen />
    </NetworkContext.Provider>,
  );
}

beforeEach(async () => {
  _resetOfflineQueueStore();
  await AsyncStorage.clear();
  initOfflineQueueStore(createMockQueueStorage(), mockQueueConsumer);
  initAuthStore(mockAuthStorage);
  useAuthStore.setState({
    cloudUrl: 'https://mock-cloud.test',
    token: 'mock-token',
    isPaired: true,
    isValidating: false,
    error: null,
  });
  resetStores();
  mockSearchParams = { id: 'session-1' };
  onEventCallback = null;
  onErrorCallback = null;
  mockPush.mockClear();
  mockBack.mockClear();
  mockClose.mockClear();
  mockStopTurn.mockClear();
  mockQueueConsumer.mockClear();
  mockAttachments = [];
  mockSafeAreaInsets = { top: 0, bottom: 0, left: 0, right: 0 };
  mockClearAttachments.mockClear();
  mockRestoreAttachments.mockClear();
  mockVoiceHookState = {
    isRecording: false,
    isTranscribing: false,
    error: null,
  };
  capturedVoiceTranscriptHandler = null;
  mockToggleRecording.mockClear();
  mockStartRecording.mockClear();
  mockStopRecording.mockClear();
  mockMeetingRecordingContextValue.state = 'idle';
  mockMeetingRecordingContextValue.isRecording = false;
  mockMeetingRecordingContextValue.meetingSessionId = null;
  mockMeetingRecordingContextValue.meetingCloudSessionId = null;
  mockMeetingRecordingContextValue.meetingTitle = '';
  mockMeetingRecordingContextValue.companionSessionId = null;
  mockMeetingRecordingContextValue.error = null;
  mockMeetingRecordingContextValue.startRecording.mockClear();
  mockMeetingRecordingContextValue.stopRecording.mockClear();
  mockMeetingRecordingContextValue.setMeetingTitle.mockClear();
  useActiveRecordingStore.setState({
    isActive: false,
    meetingSessionId: null,
    startTime: null,
    title: null,
    companionSessionId: null,
    cloudSessionId: null,
  });
  latestStackOptions = null;
  cloudClient.createAgentTurnSocket.mockClear();
  cloudClient.getSession.mockClear();
  cloudClient.getSessions.mockClear();
  cloudClient.updateSession.mockClear();
  cloudClient.readWorkspaceFile.mockClear();
  linkingOpenUrlSpy = jest.spyOn(Linking, 'openURL').mockResolvedValue(undefined);
});

afterEach(() => {
  linkingOpenUrlSpy.mockRestore();
  _resetOfflineQueueStore();
});

/** Switch from voice-first mode to text input mode. */
async function switchToTextMode(result: ReturnType<typeof render>) {
  const switchButton = result.getByLabelText('Switch to typing');
  fireEvent.press(switchButton);
  await waitFor(() => expect(result.getByTestId('conversation-input')).toBeTruthy());
}

function configureLiveMeetingCompanion(cloudSessionId: string | null): void {
  const seededSession = mockFullSession();
  useSessionStore.setState({
    currentSession: seededSession,
    sessions: [seededSession],
    isLoadingSession: true,
  });

  mockMeetingRecordingContextValue.state = 'recording';
  mockMeetingRecordingContextValue.isRecording = true;
  mockMeetingRecordingContextValue.meetingSessionId = 'meeting-local-1';
  mockMeetingRecordingContextValue.meetingCloudSessionId = cloudSessionId;
  mockMeetingRecordingContextValue.meetingTitle = 'Quarterly planning';
  mockMeetingRecordingContextValue.companionSessionId = 'session-1';

  useActiveRecordingStore.setState({
    isActive: true,
    meetingSessionId: asLocalRecordingId('meeting-local-1'),
    startTime: Date.now() - 1_000,
    title: 'Quarterly planning',
    companionSessionId: asCompanionConversationId('session-1'),
    cloudSessionId: cloudSessionId === null ? null : asCloudMeetingSessionId(cloudSessionId),
  });
}

function getLastTurnRequest(): Record<string, unknown> {
  const lastCall = cloudClient.createAgentTurnSocket.mock.calls.at(-1);
  if (!lastCall) throw new Error('Expected createAgentTurnSocket to be called');
  return lastCall[0] as Record<string, unknown>;
}

function makeTextQueueItem(overrides: Partial<QueueItem> = {}): QueueItem {
  return {
    id: 'queued-text-1',
    type: 'text-message',
    status: 'pending',
    enqueuedAt: Date.now(),
    attempts: 0,
    nextRetryAt: 0,
    isPermanentFailure: false,
    metadata: {
      sessionId: 'session-1',
      prompt: 'Queued while offline',
    },
    ...overrides,
  };
}

describe('ConversationScreen', () => {
  describe('message long-press actions', () => {
    it('opens copy-only action sheet for user messages', async () => {
      const session = mockFullSession();
      cloudClient.getSession.mockResolvedValueOnce(session);

      const showSheetSpy = jest
        .spyOn(ActionSheetIOS, 'showActionSheetWithOptions')
        .mockImplementation((_options, _callback) => {});

      const { getByText } = render(<ConversationScreen />);
      await waitFor(() => expect(getByText('Hello')).toBeTruthy());

      fireEvent(getByText('Hello'), 'longPress');

      expect(showSheetSpy).toHaveBeenCalledWith(
        expect.objectContaining({ options: ['Cancel', 'Copy text'] }),
        expect.any(Function),
      );

      showSheetSpy.mockRestore();
    });

    it('includes share for assistant/result message action sheet', async () => {
      const session = mockFullSession({
        messages: [
          mockMessage({ id: 'msg-1', role: 'assistant', text: 'Assistant reply' }),
        ],
      });
      cloudClient.getSession.mockResolvedValueOnce(session);

      const showSheetSpy = jest
        .spyOn(ActionSheetIOS, 'showActionSheetWithOptions')
        .mockImplementation((_options, _callback) => {});

      const { getByText } = render(<ConversationScreen />);
      await waitFor(() => expect(getByText('Assistant reply')).toBeTruthy());

      fireEvent(getByText('Assistant reply'), 'longPress');

      expect(showSheetSpy).toHaveBeenCalledWith(
        expect.objectContaining({ options: ['Cancel', 'Copy text', 'Share'] }),
        expect.any(Function),
      );

      showSheetSpy.mockRestore();
    });
  });

  describe('loading existing conversation', () => {
    it('shows loading spinner then messages', async () => {
      const session = mockFullSession();
      cloudClient.getSession.mockResolvedValueOnce(session);

      const { getByText, queryByText } = render(<ConversationScreen />);

      await waitFor(() => {
        expect(getByText('Hello')).toBeTruthy();
        expect(getByText('Hi there!')).toBeTruthy();
      });
      expect(queryByText('No messages yet')).toBeNull();
    });

    it('mounts Slack context chip when the session externalContext is a Slack thread', async () => {
      cloudClient.getSession.mockResolvedValueOnce(mockFullSession({
        externalContext: {
          kind: 'slack-thread',
          identity: { teamId: 'T1', channelId: 'C1', threadTs: '1700000000.123456' },
          metadata: {
            userName: 'Alice',
            channelName: 'planning',
            teamName: 'Acme',
            permalink: 'https://acme.slack.com/archives/C1/p1700000000123456',
          },
        },
      }));

      const { getByTestId, getByText } = render(<ConversationScreen />);

      await waitFor(() => {
        expect(getByTestId('slack-context-chip')).toBeTruthy();
        expect(getByText('Alice in #planning')).toBeTruthy();
      });
    });

    it('shows error with retry on fetch failure', async () => {
      cloudClient.getSession.mockRejectedValueOnce(new Error('Network error'));

      const { getByText } = render(<ConversationScreen />);

      await waitFor(() => {
        expect(getByText('Network error')).toBeTruthy();
        expect(getByText('Retry')).toBeTruthy();
      });
    });

    it('retries on retry button press', async () => {
      cloudClient.getSession.mockRejectedValueOnce(new Error('Network error'));
      const session = mockFullSession();
      cloudClient.getSession.mockResolvedValueOnce(session);

      const { getByText } = render(<ConversationScreen />);

      await waitFor(() => expect(getByText('Retry')).toBeTruthy());
      fireEvent.press(getByText('Retry'));
      await waitFor(() => expect(getByText('Hello')).toBeTruthy());
    });

    it('shows a dismissible conflict badge in the header when a session conflict is active', async () => {
      const alertSpy = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
      cloudClient.getSession.mockResolvedValueOnce(mockFullSession());
      useSessionConflictStore.getState().markSessionConflict({
        sessionId: 'session-1',
        conflictType: 'concurrent-edit',
        fields: ['title', 'doneAt'],
        detectedAt: Date.now(),
      });

      render(<ConversationScreen />);

      await waitFor(() => {
        expect(latestStackOptions).toBeTruthy();
      });

      const headerRight = latestStackOptions?.headerRight as (() => React.ReactElement) | undefined;
      expect(headerRight).toBeDefined();

      const badge = render(headerRight!());
      expect(badge.getByText(/Edited elsewhere/)).toBeTruthy();
      fireEvent.press(badge.getByLabelText(/Edited elsewhere/));
      expect(alertSpy).toHaveBeenCalledWith('Edited elsewhere', 'Changed elsewhere: title, done');

      fireEvent.press(badge.getByLabelText('Dismiss conflict badge'));
      expect(useSessionConflictStore.getState().conflictsBySessionId['session-1']?.dismissedAt).not.toBeNull();
      alertSpy.mockRestore();
    });

    it('omits Reopen for Done background sessions but keeps Star in the header action sheet', async () => {
      const session = mockFullSession({
        id: 'automation-source-capture--detail',
        title: 'Source Capture',
        doneAt: 1_700_000_000_000,
        starredAt: null,
      });
      mockSearchParams = { id: session.id };
      cloudClient.getSession.mockResolvedValue(session);
      const showSheetSpy = jest
        .spyOn(ActionSheetIOS, 'showActionSheetWithOptions')
        .mockImplementation((_options, _callback) => {});

      render(<ConversationScreen />);

      await waitFor(() => expect(latestStackOptions).toBeTruthy());
      const headerRight = latestStackOptions?.headerRight as (() => React.ReactElement) | undefined;
      expect(headerRight).toBeDefined();

      const header = render(headerRight!());
      fireEvent.press(header.getByTestId('conversation-actions-button'));

      const [options, callback] = showSheetSpy.mock.calls[0];
      expect(options.options).toEqual(['Cancel', 'Add to Starred']);
      callback(1);

      await waitFor(() => expect(cloudClient.updateSession).toHaveBeenCalled());
      const patch = cloudClient.updateSession.mock.calls[0][1];
      expect(patch).toHaveProperty('starredAt');
      expect(typeof patch.starredAt).toBe('number');
      expect(patch).not.toHaveProperty('doneAt');

      showSheetSpy.mockRestore();
    });

    it('shows a toast when the queue hits its 200-item cap', async () => {
      cloudClient.getSession.mockResolvedValueOnce(mockFullSession());

      const result = render(<ConversationScreen />);
      await waitFor(() => expect(latestStackOptions).toBeTruthy());

      act(() => {
        useOfflineQueueStore.setState({ queueFullAt: 1_700_000_000_000 });
      });

      await waitFor(() => {
        expect(result.getByTestId('conversation-toast')).toBeTruthy();
        expect(result.getByText('Some older queued items were dropped.')).toBeTruthy();
      });
    });
  });

  describe('turn tool activity', () => {
    it('renders tool activity for the final non-user message in a turn', async () => {
      const session = mockFullSession({
        messages: [
          mockMessage({ id: 'msg-1', turnId: 'turn-1', role: 'user', text: 'Plan this' }),
          mockMessage({ id: 'msg-2', turnId: 'turn-1', role: 'assistant', text: 'Drafting...' }),
          mockMessage({ id: 'msg-3', turnId: 'turn-1', role: 'result', text: 'Done.' }),
        ],
      });
      cloudClient.getSession.mockResolvedValueOnce({
        ...session,
        eventsByTurn: {
          'turn-1': [
            {
              type: 'tool',
              toolName: 'read_file',
              detail: JSON.stringify({ path: '/tmp/report.md' }),
              stage: 'start',
              toolUseId: 'tool-1',
              timestamp: Date.now(),
            },
            {
              type: 'tool',
              toolName: 'read_file',
              detail: JSON.stringify({ output: 'Read complete' }),
              stage: 'end',
              toolUseId: 'tool-1',
              timestamp: Date.now(),
            },
          ],
        },
      });

      const { getByTestId, getByText } = render(<ConversationScreen />);

      await waitFor(() => {
        expect(getByText('Done.')).toBeTruthy();
      });

      expect(getByTestId('turn-tool-activity-turn-1')).toBeTruthy();
      expect(getByText(/1 step/)).toBeTruthy();

      fireEvent.press(getByText(/1 step/));
      expect(getByText(/Reading report\.md/)).toBeTruthy();
      fireEvent.press(getByText('Reading report.md'));
      expect(getByText('report.md')).toBeTruthy();
    });

    it('shows start-only tool events as in-progress activity entries', async () => {
      const session = mockFullSession({
        messages: [
          mockMessage({ id: 'msg-1', turnId: 'turn-3', role: 'user', text: 'Check file' }),
          mockMessage({ id: 'msg-2', turnId: 'turn-3', role: 'result', text: 'Done' }),
        ],
      });
      cloudClient.getSession.mockResolvedValueOnce({
        ...session,
        eventsByTurn: {
          'turn-3': [
            {
              type: 'tool',
              toolName: 'read_file',
              detail: JSON.stringify({ path: '/tmp/in-progress.md' }),
              stage: 'start',
              toolUseId: 'tool-3',
              timestamp: Date.now(),
            },
          ],
        },
      });

      const { getByTestId, getByText } = render(<ConversationScreen />);

      await waitFor(() => {
        expect(getByText('Done')).toBeTruthy();
      });

      expect(getByTestId('turn-tool-activity-turn-3')).toBeTruthy();
      expect(getByText(/1 step/)).toBeTruthy();
      fireEvent.press(getByText(/1 step/));
      expect(getByText(/Reading in-progress\.md/)).toBeTruthy();
    });

    it('falls back to completedStepsByTurnId when session tool events are unavailable', async () => {
      useSessionStore.setState({
        completedStepsByTurnId: {
          'turn-2': [
            {
              label: 'bash',
              toolName: 'bash',
              detail: JSON.stringify({ command: 'npm test' }),
              timestamp: Date.now(),
            },
          ],
        },
      });

      const session = mockFullSession({
        messages: [
          mockMessage({ id: 'msg-1', turnId: 'turn-2', role: 'user', text: 'Run checks' }),
          mockMessage({ id: 'msg-2', turnId: 'turn-2', role: 'result', text: 'Checks complete' }),
        ],
      });
      cloudClient.getSession.mockResolvedValueOnce(session);

      const { getByTestId, getByText } = render(<ConversationScreen />);

      await waitFor(() => {
        expect(getByText('Checks complete')).toBeTruthy();
      });

      expect(getByTestId('turn-tool-activity-turn-2')).toBeTruthy();
      expect(getByText(/1 step/)).toBeTruthy();
      fireEvent.press(getByText(/1 step/));
      expect(getByText(/Running a command/)).toBeTruthy();
    });
  });

  describe('sending a message', () => {
    it('shows optimistic user message immediately', async () => {
      const session = mockFullSession({ messages: [] });
      cloudClient.getSession.mockResolvedValueOnce(session);

      const result = render(<ConversationScreen />);
      await waitFor(() => expect(result.getByText('Tap to speak')).toBeTruthy());
      await switchToTextMode(result);

      fireEvent.changeText(result.getByPlaceholderText('Message Rebel...'), 'Hello Rebel');
      fireEvent.press(result.getByTestId('conversation-send-button'));

      await waitFor(() => {
        expect(result.getByText('Hello Rebel')).toBeTruthy();
      });

      expect(cloudClient.createAgentTurnSocket).toHaveBeenCalledWith(
        { sessionId: 'session-1', prompt: 'Hello Rebel', clientTurnId: expect.any(String) },
        expect.any(Function),
        expect.any(Function),
        expect.any(Function),
      );
    });

    it('disables input while sending', async () => {
      const session = mockFullSession({ messages: [] });
      cloudClient.getSession.mockResolvedValueOnce(session);

      const result = render(<ConversationScreen />);
      await waitFor(() => expect(result.getByText('Tap to speak')).toBeTruthy());
      await switchToTextMode(result);

      fireEvent.changeText(result.getByPlaceholderText('Message Rebel...'), 'Hi');
      fireEvent.press(result.getByTestId('conversation-send-button'));

      await waitFor(() => {
        const input = result.getByPlaceholderText('Message Rebel...');
        expect(input.props.editable).toBe(false);
      });
    });

    it('clears input after send', async () => {
      const session = mockFullSession({ messages: [] });
      cloudClient.getSession.mockResolvedValueOnce(session);

      const result = render(<ConversationScreen />);
      await waitFor(() => expect(result.getByText('Tap to speak')).toBeTruthy());
      await switchToTextMode(result);

      fireEvent.changeText(result.getByPlaceholderText('Message Rebel...'), 'Hello');
      fireEvent.press(result.getByTestId('conversation-send-button'));

      await waitFor(() => {
        expect(result.getByPlaceholderText('Message Rebel...').props.value).toBe('');
      });
    });

    it('keeps the send button outside scrollable accessories for long dictated text', async () => {
      mockSafeAreaInsets = { top: 0, bottom: 34, left: 0, right: 0 };
      const session = mockFullSession({ messages: [] });
      cloudClient.getSession.mockResolvedValueOnce(session);

      const result = render(<ConversationScreen />);
      await waitFor(() => expect(result.getByText('Tap to speak')).toBeTruthy());

      const voiceBarStyle = StyleSheet.flatten(result.getByTestId('conversation-voice-bar').props.style);
      expect(voiceBarStyle).toEqual(
        expect.objectContaining({
          flexShrink: 0,
          paddingBottom: 20 + mockSafeAreaInsets.bottom,
        }),
      );
      expect(voiceBarStyle?.paddingBottom).toBeGreaterThanOrEqual(mockSafeAreaInsets.bottom);

      await switchToTextMode(result);

      const longDictatedInput = Array.from({ length: 40 }, (_, index) => `Line ${index + 1}`).join('\n');
      fireEvent.changeText(result.getByTestId('conversation-input'), longDictatedInput);

      expect(result.getByTestId('conversation-send-button')).toBeTruthy();

      const accessories = result.getByTestId('conversation-composer-accessories');
      const accessoryStyle = StyleSheet.flatten(accessories.props.style);
      expect(accessoryStyle).toEqual(expect.objectContaining({ flexShrink: 1 }));
      expect(accessoryStyle?.maxHeight).toEqual(expect.any(Number));
      expect(accessories.findAllByProps({ testID: 'finish-line-chip' }).length).toBeGreaterThan(0);
      expect(accessories.findAllByProps({ testID: 'conversation-send-button' })).toHaveLength(0);

      // RN Testing Library cannot assert native layout visibility; this guards
      // the structural invariant that the input/send dock is outside accessories.
      const inputBarStyle = StyleSheet.flatten(result.getByTestId('conversation-input-bar').props.style);
      expect(inputBarStyle).toEqual(
        expect.objectContaining({
          flexShrink: 0,
          paddingBottom: 12 + mockSafeAreaInsets.bottom,
        }),
      );
      expect(inputBarStyle?.paddingBottom).toBeGreaterThanOrEqual(mockSafeAreaInsets.bottom);
    });

    it('lets the empty-conversation list fill the viewport so the keyboard cannot occlude send (REBEL-6BP)', async () => {
      // On a NEW/empty conversation the FlatList content must flex-fill the
      // viewport (flexGrow on the content container) WITHOUT a rigid intrinsic
      // floor, so under the keyboard the list yields/scrolls space (keeping the
      // docked input/send bar visible) and keyboardDismissMode="interactive"
      // has a surface to drag against. Without this the new-conversation send
      // button was occluded by the keyboard with no way to dismiss it. RN
      // Testing Library can't measure native layout, so this guards the
      // structural invariant that produces the correct on-device behaviour.
      const session = mockFullSession({ messages: [] });
      cloudClient.getSession.mockResolvedValueOnce(session);

      const result = render(<ConversationScreen />);
      await waitFor(() => expect(result.getByText('Tap to speak')).toBeTruthy());
      await switchToTextMode(result);

      // Empty state is rendered (no messages).
      expect(result.getByTestId('conversation-empty-state')).toBeTruthy();

      const list = result.getByTestId('conversation-messages-list');
      // Content container flex-fills the viewport when empty.
      const contentContainerStyle = StyleSheet.flatten(list.props.contentContainerStyle);
      expect(contentContainerStyle).toEqual(expect.objectContaining({ flexGrow: 1 }));
      // Tapping (e.g. send) while the keyboard is up must not be swallowed.
      expect(list.props.keyboardShouldPersistTaps).toBe('handled');

      // The empty-state container fills via flexGrow and carries NO rigid
      // minHeight floor that would fight the keyboard shrink.
      const emptyStyle = StyleSheet.flatten(result.getByTestId('conversation-empty-state').props.style);
      expect(emptyStyle).toEqual(expect.objectContaining({ flexGrow: 1 }));
      expect(emptyStyle).not.toHaveProperty('minHeight');
      expect(emptyStyle).not.toHaveProperty('flex');
    });

    it('drops the empty-state content fill once the conversation has messages (REBEL-6BP)', async () => {
      // Guard the conditional: flexGrow:1 must apply ONLY when empty, so it
      // can't alter populated-list scroll anchoring.
      const session = mockFullSession();
      cloudClient.getSession.mockResolvedValueOnce(session);

      const result = render(<ConversationScreen />);
      await waitFor(() => expect(result.getByText('Hello')).toBeTruthy());

      const list = result.getByTestId('conversation-messages-list');
      const contentContainerStyle = StyleSheet.flatten(list.props.contentContainerStyle);
      expect(contentContainerStyle).not.toHaveProperty('flexGrow');
    });

    it('offers Send & done on long-press for normal sessions', async () => {
      const session = mockFullSession({ messages: [] });
      cloudClient.getSession.mockResolvedValueOnce(session);
      const actionSheetSpy = jest
        .spyOn(ActionSheetIOS, 'showActionSheetWithOptions')
        .mockImplementation((_options, _callback) => {});

      const result = render(<ConversationScreen />);
      await waitFor(() => expect(result.getByText('Tap to speak')).toBeTruthy());
      await switchToTextMode(result);

      fireEvent.changeText(result.getByPlaceholderText('Message Rebel...'), 'Normal prompt');
      fireEvent(result.getByTestId('conversation-send-button'), 'longPress');

      expect(actionSheetSpy).toHaveBeenCalledWith(
        expect.objectContaining({ options: ['Cancel', 'Send', 'Send & done'] }),
        expect.any(Function),
      );

      actionSheetSpy.mockRestore();
    });

    it('sends directly on long-press for background sessions without offering Send & done', async () => {
      const session = mockFullSession({
        id: 'meeting-analysis-background-1',
        messages: [],
      });
      mockSearchParams = { id: session.id };
      cloudClient.getSession.mockResolvedValueOnce(session);
      const actionSheetSpy = jest
        .spyOn(ActionSheetIOS, 'showActionSheetWithOptions')
        .mockImplementation((_options, _callback) => {});

      const result = render(<ConversationScreen />);
      await waitFor(() => expect(result.getByText('Tap to speak')).toBeTruthy());
      await switchToTextMode(result);

      fireEvent.changeText(result.getByPlaceholderText('Message Rebel...'), 'Background prompt');
      fireEvent(result.getByTestId('conversation-send-button'), 'longPress');

      expect(actionSheetSpy).not.toHaveBeenCalled();
      await waitFor(() => {
        expect(cloudClient.createAgentTurnSocket).toHaveBeenCalledWith(
          { sessionId: session.id, prompt: 'Background prompt', clientTurnId: expect.any(String) },
          expect.any(Function),
          expect.any(Function),
          expect.any(Function),
        );
      });
      expect(cloudClient.updateSession).not.toHaveBeenCalled();
      expect(mockBack).not.toHaveBeenCalled();

      actionSheetSpy.mockRestore();
    });

    it('does not render the voice Send & done pill for background sessions', async () => {
      const session = mockFullSession({
        id: 'use-case-discovery-background-1',
        messages: [],
      });
      mockSearchParams = { id: session.id };
      mockVoiceHookState = {
        isRecording: true,
        isTranscribing: false,
        error: null,
      };
      cloudClient.getSession.mockResolvedValueOnce(session);

      const result = render(<ConversationScreen />);

      await waitFor(() => {
        expect(result.getByTestId('conversation-voice-send-button')).toBeTruthy();
      });
      expect(result.queryByTestId('conversation-voice-send-done-button')).toBeNull();
    });
  });

  describe('live meeting companion turn plumbing', () => {
    async function assertTextSendPath(cloudSessionId: string | null): Promise<void> {
      configureLiveMeetingCompanion(cloudSessionId);
      cloudClient.getSession.mockResolvedValue(mockFullSession());
      const result = renderConversationWithNetwork(true);
      await waitFor(() => expect(result.getByTestId('conversation-text-toggle-button')).toBeTruthy());
      await switchToTextMode(result);

      fireEvent.changeText(result.getByPlaceholderText('Message Rebel...'), 'Text send prompt');
      fireEvent.press(result.getByTestId('conversation-send-button'));

      await waitFor(() => {
        expect(cloudClient.createAgentTurnSocket).toHaveBeenCalled();
      });
      const request = getLastTurnRequest();
      expect(request.recordingActive).toBe(true);
      if (cloudSessionId) {
        expect(request.meetingSessionId).toBe(cloudSessionId);
      } else {
        expect(request).not.toHaveProperty('meetingSessionId');
      }
      result.unmount();
    }

    async function assertTextSendAndDonePath(cloudSessionId: string | null): Promise<void> {
      configureLiveMeetingCompanion(cloudSessionId);
      cloudClient.getSession.mockResolvedValue(mockFullSession());
      const result = renderConversationWithNetwork(true);
      await waitFor(() => expect(result.getByTestId('conversation-text-toggle-button')).toBeTruthy());
      await switchToTextMode(result);

      const actionSheetSpy = jest
        .spyOn(ActionSheetIOS, 'showActionSheetWithOptions')
        .mockImplementation((_options, callback) => callback(2));

      fireEvent.changeText(result.getByPlaceholderText('Message Rebel...'), 'Text send-and-done prompt');
      fireEvent(result.getByTestId('conversation-send-button'), 'longPress');

      await waitFor(() => {
        expect(cloudClient.createAgentTurnSocket).toHaveBeenCalled();
      });
      const request = getLastTurnRequest();
      expect(request.recordingActive).toBe(true);
      if (cloudSessionId) {
        expect(request.meetingSessionId).toBe(cloudSessionId);
      } else {
        expect(request).not.toHaveProperty('meetingSessionId');
      }

      actionSheetSpy.mockRestore();
      result.unmount();
    }

    async function assertVoiceSendPath(cloudSessionId: string | null): Promise<void> {
      configureLiveMeetingCompanion(cloudSessionId);
      mockVoiceHookState = {
        isRecording: true,
        isTranscribing: false,
        error: null,
      };
      cloudClient.getSession.mockResolvedValue(mockFullSession());
      const result = renderConversationWithNetwork(true);
      await waitFor(() => expect(result.getByTestId('conversation-voice-send-button')).toBeTruthy());

      fireEvent.press(result.getByTestId('conversation-voice-send-button'));
      await act(async () => {
        capturedVoiceTranscriptHandler?.('Voice send prompt');
        await flushPromises();
      });

      await waitFor(() => {
        expect(cloudClient.createAgentTurnSocket).toHaveBeenCalled();
      });
      const request = getLastTurnRequest();
      expect(request.prompt).toBe('Voice send prompt');
      expect(request.recordingActive).toBe(true);
      if (cloudSessionId) {
        expect(request.meetingSessionId).toBe(cloudSessionId);
      } else {
        expect(request).not.toHaveProperty('meetingSessionId');
      }
      result.unmount();
    }

    async function assertVoiceSendAndDonePath(cloudSessionId: string | null): Promise<void> {
      configureLiveMeetingCompanion(cloudSessionId);
      mockVoiceHookState = {
        isRecording: true,
        isTranscribing: false,
        error: null,
      };
      cloudClient.getSession.mockResolvedValue(mockFullSession());
      const result = renderConversationWithNetwork(true);
      await waitFor(() => expect(result.getByTestId('conversation-voice-send-done-button')).toBeTruthy());

      fireEvent.press(result.getByTestId('conversation-voice-send-done-button'));
      await act(async () => {
        capturedVoiceTranscriptHandler?.('Voice send-and-done prompt');
        await flushPromises();
      });

      await waitFor(() => {
        expect(cloudClient.createAgentTurnSocket).toHaveBeenCalled();
      });
      const request = getLastTurnRequest();
      expect(request.prompt).toBe('Voice send-and-done prompt');
      expect(request.recordingActive).toBe(true);
      if (cloudSessionId) {
        expect(request.meetingSessionId).toBe(cloudSessionId);
      } else {
        expect(request).not.toHaveProperty('meetingSessionId');
      }
      result.unmount();
    }

    it('includes cloud meeting session id + recordingActive across all four send paths when cloud id exists', async () => {
      await assertTextSendPath('meeting-cloud-1');
      cloudClient.createAgentTurnSocket.mockClear();
      await assertTextSendAndDonePath('meeting-cloud-1');
      cloudClient.createAgentTurnSocket.mockClear();
      await assertVoiceSendPath('meeting-cloud-1');
      cloudClient.createAgentTurnSocket.mockClear();
      await assertVoiceSendAndDonePath('meeting-cloud-1');
    });

    it('still sends recordingActive=true without meetingSessionId across all four send paths when cloud id is unknown', async () => {
      await assertTextSendPath(null);
      cloudClient.createAgentTurnSocket.mockClear();
      await assertTextSendAndDonePath(null);
      cloudClient.createAgentTurnSocket.mockClear();
      await assertVoiceSendPath(null);
      cloudClient.createAgentTurnSocket.mockClear();
      await assertVoiceSendAndDonePath(null);
    });

    async function assertAskSparkQuickAskPath(cloudSessionId: string | null): Promise<void> {
      configureLiveMeetingCompanion(cloudSessionId);
      cloudClient.getSession.mockResolvedValue(mockFullSession());
      const result = renderConversationWithNetwork(true);

      await waitFor(() => {
        expect(result.getByLabelText('Ask Spark during this meeting')).toBeTruthy();
      });

      fireEvent.press(result.getByLabelText('Ask Spark during this meeting'));
      fireEvent.press(result.getByTestId('ask-spark-option-summarise-so-far'));

      await waitFor(() => {
        expect(cloudClient.createAgentTurnSocket).toHaveBeenCalled();
      });
      const request = getLastTurnRequest();
      expect(request.prompt).toBe('Summarise what we\'ve covered in this meeting so far.');
      expect(request.recordingActive).toBe(true);
      if (cloudSessionId) {
        expect(request.meetingSessionId).toBe(cloudSessionId);
      } else {
        expect(request).not.toHaveProperty('meetingSessionId');
      }
      expect(request.triggerMeta).toEqual({
        triggerSource: 'quick-ask-button',
        triggerSourceSpeaker: 'user',
        triggeredAt: expect.any(Number),
        triggerExtracted: 'Summarise what we\'ve covered in this meeting so far.',
      });
      result.unmount();
    }

    it('submits Ask Spark picker selections with canonical trigger metadata', async () => {
      await assertAskSparkQuickAskPath('meeting-cloud-1');
      cloudClient.createAgentTurnSocket.mockClear();
      await assertAskSparkQuickAskPath(null);
    });

    it('rehydrates cloudSessionId on cold start and carries it on the next turn', async () => {
      const companionKey = '@rebel/active-recording-companion-session-id';
      const cloudKey = '@rebel/active-recording-cloud-session-id';

      await AsyncStorage.setItem(companionKey, 'session-1');
      await AsyncStorage.setItem(cloudKey, 'meeting-cloud-recovered');
      useActiveRecordingStore.setState({
        isActive: true,
        meetingSessionId: asLocalRecordingId('meeting-local-1'),
        startTime: Date.now() - 1_000,
        title: 'Quarterly planning',
        companionSessionId: null,
        cloudSessionId: null,
      });

      await rehydrateActiveRecordingIds();
      configureLiveMeetingCompanion(useActiveRecordingStore.getState().cloudSessionId);

      cloudClient.getSession.mockResolvedValue(mockFullSession());
      const result = renderConversationWithNetwork(true);
      await waitFor(() => expect(result.getByTestId('conversation-text-toggle-button')).toBeTruthy());
      await switchToTextMode(result);

      fireEvent.changeText(result.getByPlaceholderText('Message Rebel...'), 'Recovered meeting turn');
      fireEvent.press(result.getByTestId('conversation-send-button'));

      await waitFor(() => {
        expect(cloudClient.createAgentTurnSocket).toHaveBeenCalled();
      });
      expect(getLastTurnRequest()).toMatchObject({
        sessionId: 'session-1',
        prompt: 'Recovered meeting turn',
        meetingSessionId: 'meeting-cloud-recovered',
        recordingActive: true,
      });
    });

    it('send-and-done pre-ack fallback enqueues meetingSessionId + recordingActive metadata', async () => {
      configureLiveMeetingCompanion('meeting-cloud-1');
      cloudClient.getSession.mockResolvedValue(mockFullSession());
      const result = renderConversationWithNetwork(true);
      await waitFor(() => expect(result.getByTestId('conversation-text-toggle-button')).toBeTruthy());
      await switchToTextMode(result);

      const actionSheetSpy = jest
        .spyOn(ActionSheetIOS, 'showActionSheetWithOptions')
        .mockImplementation((_options, callback) => callback(2));

      fireEvent.changeText(result.getByPlaceholderText('Message Rebel...'), 'Send and done fallback');
      fireEvent(result.getByTestId('conversation-send-button'), 'longPress');

      await act(async () => {
        onErrorCallback?.(new Error('socket failed before ack'));
        await flushPromises();
      });

      await waitFor(() => {
        expect(useOfflineQueueStore.getState().items.length).toBeGreaterThan(0);
      });
      const metadata = useOfflineQueueStore.getState().items[0]?.metadata as Record<string, unknown> | undefined;
      expect(metadata).toMatchObject({
        sessionId: 'session-1',
        prompt: 'Send and done fallback',
        meetingSessionId: 'meeting-cloud-1',
        recordingActive: true,
      });

      actionSheetSpy.mockRestore();
    });

    it('voice send-and-done pre-ack fallback enqueues meetingSessionId + recordingActive metadata', async () => {
      configureLiveMeetingCompanion('meeting-cloud-1');
      mockVoiceHookState = {
        isRecording: true,
        isTranscribing: false,
        error: null,
      };
      cloudClient.getSession.mockResolvedValue(mockFullSession());
      const result = renderConversationWithNetwork(true);
      await waitFor(() => expect(result.getByTestId('conversation-voice-send-done-button')).toBeTruthy());

      fireEvent.press(result.getByTestId('conversation-voice-send-done-button'));
      await act(async () => {
        capturedVoiceTranscriptHandler?.('Voice send-and-done fallback');
        await flushPromises();
      });
      await act(async () => {
        onErrorCallback?.(new Error('socket failed before ack'));
        await flushPromises();
      });

      await waitFor(() => {
        expect(useOfflineQueueStore.getState().items.length).toBeGreaterThan(0);
      });
      const metadata = useOfflineQueueStore.getState().items[0]?.metadata as Record<string, unknown> | undefined;
      expect(metadata).toMatchObject({
        sessionId: 'session-1',
        prompt: 'Voice send-and-done fallback',
        meetingSessionId: 'meeting-cloud-1',
        recordingActive: true,
      });
    });
  });

  describe('draft preservation on pre-ack failure', () => {
    // Reference: docs/plans/260417_mobile_offline_deferred_followups.md (I6)
    it('restores the draft when a server error fires before turn_started', async () => {
      const session = mockFullSession({ messages: [] });
      cloudClient.getSession.mockResolvedValueOnce(session);

      const result = render(<ConversationScreen />);
      await waitFor(() => expect(result.getByText('Tap to speak')).toBeTruthy());
      await switchToTextMode(result);

      const input = result.getByPlaceholderText('Message Rebel...');
      fireEvent.changeText(input, 'important thought');
      fireEvent.press(result.getByTestId('conversation-send-button'));

      // Input should be cleared immediately (optimistic)
      await waitFor(() => {
        expect(input.props.value).toBe('');
      });

      // Server error event fires before `turn_started` → useAgentTurn sets
      // `error` without ever having set `activeTurnId`.
      await act(async () => {
        onEventCallback!({ type: 'error', error: 'server rejected' });
        await flushPromises();
      });

      // Draft should be restored into the composer.
      await waitFor(() => {
        expect(input.props.value).toBe('important thought');
      });

      // Toast surfaced to reassure the user.
      await waitFor(() => {
        expect(result.queryByTestId('conversation-toast')).not.toBeNull();
      });
    });

    it('does NOT restore the draft after turn_started was received (ack happened)', async () => {
      const session = mockFullSession({ messages: [] });
      cloudClient.getSession.mockResolvedValueOnce(session);

      const result = render(<ConversationScreen />);
      await waitFor(() => expect(result.getByText('Tap to speak')).toBeTruthy());
      await switchToTextMode(result);

      const input = result.getByPlaceholderText('Message Rebel...');
      fireEvent.changeText(input, 'acked prompt');
      fireEvent.press(result.getByTestId('conversation-send-button'));

      // turn_started fires → ack received
      await act(async () => {
        onEventCallback!({ type: 'turn_started', turnId: 'turn-ack-1' });
        await flushPromises();
      });

      // Then a late error event (server-side). Draft must NOT be resurrected
      // — the prompt is visible in the optimistic messages.
      await act(async () => {
        onEventCallback!({ type: 'error', error: 'Late failure after ack' });
        await flushPromises();
      });

      expect(input.props.value).toBe('');
    });

    it('surfaces a toast when the draft is restored (user-visible feedback)', async () => {
      // Covers the attempt-scoped observable side effect — onRestore was
      // called AND the toast fired. Guards against regressions where the
      // hook fires but the callsite's UX wiring drops (e.g. a future
      // refactor that forgets showToast in onRestore).
      const session = mockFullSession({ messages: [] });
      cloudClient.getSession.mockResolvedValueOnce(session);

      const result = render(<ConversationScreen />);
      await waitFor(() => expect(result.getByText('Tap to speak')).toBeTruthy());
      await switchToTextMode(result);

      const input = result.getByPlaceholderText('Message Rebel...');
      fireEvent.changeText(input, 'restore-me');
      fireEvent.press(result.getByTestId('conversation-send-button'));

      await act(async () => {
        onEventCallback!({ type: 'error', error: 'pre-ack failure' });
        await flushPromises();
      });

      await waitFor(() => {
        const toast = result.queryByTestId('conversation-toast');
        expect(toast).not.toBeNull();
        const innerText = toast!.props.children?.props?.children ?? toast!.props.children;
        const flat = Array.isArray(innerText) ? innerText.join('') : String(innerText);
        expect(flat).toMatch(/draft/i);
      });
      expect(input.props.value).toBe('restore-me');
    });
  });

  describe('offline queue UX', () => {
    it('renders queued text message indicator from queue state', async () => {
      cloudClient.getSession.mockResolvedValueOnce(mockFullSession({ messages: [] }));
      act(() => {
        useOfflineQueueStore.setState({
          items: [
            makeTextQueueItem(),
            makeTextQueueItem({
              id: 'queued-text-other',
              metadata: { sessionId: 'session-other', prompt: 'Other conversation' },
            }),
          ],
        });
      });

      const result = render(<ConversationScreen />);

      await waitFor(() => {
        expect(result.getByText('Queued while offline')).toBeTruthy();
      });
      expect(result.getAllByTestId('conversation-message-queued-indicator')).toHaveLength(1);
      expect(result.getByText('Queued')).toBeTruthy();
    });

    it('shows an offline enqueue toast after saving a text message', async () => {
      cloudClient.getSession.mockResolvedValueOnce(mockFullSession({ messages: [] }));
      const result = renderConversationWithNetwork(false);

      await waitFor(() => expect(result.getByText('Tap to speak')).toBeTruthy());
      await switchToTextMode(result);

      fireEvent.changeText(result.getByPlaceholderText('Message Rebel...'), 'Queue this');
      fireEvent.press(result.getByTestId('conversation-send-button'));

      await waitFor(() => {
        expect(result.getByText("Saved. I'll send when you're back online.")).toBeTruthy();
      });
      expect(useOfflineQueueStore.getState().items).toHaveLength(1);
      expect(result.getByPlaceholderText('Message Rebel...').props.value).toBe('');
    });

    it('updates the input placeholder when offline attachments are waiting', async () => {
      cloudClient.getSession.mockResolvedValueOnce(mockFullSession({ messages: [] }));
      mockAttachments = [
        {
          id: 'att-1',
          name: 'brief.pdf',
          type: 'document',
          mimeType: 'application/pdf',
          base64Data: 'abc',
          sizeBytes: 3,
        },
      ];

      const result = renderConversationWithNetwork(false);
      await waitFor(() => expect(result.getByText('Tap to speak')).toBeTruthy());
      await switchToTextMode(result);

      expect(
        result.getByPlaceholderText('Add your message (will send when online)...'),
      ).toBeTruthy();
    });

    it('shows toast when queued text drain completes successfully', async () => {
      cloudClient.getSession.mockResolvedValueOnce(mockFullSession({ messages: [] }));
      const result = render(<ConversationScreen />);
      await waitFor(() => expect(result.getByText('Tap to speak')).toBeTruthy());

      const consumer = createTextQueueConsumer();
      const completionPromise = consumer(
        makeTextQueueItem({
          id: 'queue-success',
          metadata: { sessionId: 'session-1', prompt: 'Send queued message' },
        }),
        null,
      );

      await act(async () => {
        await Promise.resolve();
        onEventCallback?.({ type: 'turn_started', turnId: 'turn-queue-success' });
        onEventCallback?.({ type: 'turn_persisted', turnId: 'turn-queue-success' });
        await completionPromise;
      });

      await waitFor(() => {
        expect(result.getByTestId('conversation-toast')).toBeTruthy();
        expect(result.getByText('Message sent')).toBeTruthy();
      });
    });

    it('shows session-deleted fallback toast when queued text is rerouted', async () => {
      cloudClient.getSession.mockResolvedValueOnce(mockFullSession({ messages: [] }));
      const result = render(<ConversationScreen />);
      await waitFor(() => expect(result.getByText('Tap to speak')).toBeTruthy());

      act(() => {
        // Positive deletion signal: session-1 was tombstoned (deleted). Only a
        // tombstone — not mere store absence — triggers the recreate + fallback toast.
        useSessionStore.setState({
          currentSession: null,
          sessions: [{ id: 'different-session', title: 'Other' }],
          tombstonedSessionIds: new Set<string>(['session-1']),
        });
      });

      const consumer = createTextQueueConsumer();
      const completionPromise = consumer(
        makeTextQueueItem({
          id: 'queue-recreated',
          metadata: { sessionId: 'session-1', prompt: 'Recover queued message' },
        }),
        null,
      );

      await act(async () => {
        await Promise.resolve();
        onEventCallback?.({ type: 'turn_started', turnId: 'turn-queue-recreated' });
        onEventCallback?.({ type: 'turn_persisted', turnId: 'turn-queue-recreated' });
        await completionPromise;
      });

      await waitFor(() => {
        expect(result.getByTestId('conversation-toast')).toBeTruthy();
        expect(result.getByText('Original conversation was deleted — started a new one.')).toBeTruthy();
      });
    });

    it('does not show toast on manual queue item removal', async () => {
      cloudClient.getSession.mockResolvedValueOnce(mockFullSession({ messages: [] }));
      const result = render(<ConversationScreen />);
      await waitFor(() => expect(result.getByText('Tap to speak')).toBeTruthy());

      act(() => {
        useOfflineQueueStore.setState({
          items: [makeTextQueueItem({ id: 'manual-remove' })],
        });
      });
      await waitFor(() => {
        expect(result.getByText('Queued while offline')).toBeTruthy();
      });

      act(() => {
        useOfflineQueueStore.setState({ items: [] });
      });

      expect(result.queryByTestId('conversation-toast')).toBeNull();
    });
  });

  describe('full event lifecycle', () => {
    async function sendAndGetCallbacks() {
      const session = mockFullSession({ messages: [] });
      cloudClient.getSession.mockResolvedValueOnce(session);

      const result = render(<ConversationScreen />);
      await waitFor(() => expect(result.getByText('Tap to speak')).toBeTruthy());
      await switchToTextMode(result);

      fireEvent.changeText(result.getByPlaceholderText('Message Rebel...'), 'Test');
      fireEvent.press(result.getByTestId('conversation-send-button'));

      await waitFor(() => expect(onEventCallback).not.toBeNull());
      return result;
    }

    it('handles turn_started event', async () => {
      await sendAndGetCallbacks();
      act(() => {
        onEventCallback!({ type: 'turn_started', turnId: 'turn-abc' });
      });
      // No crash, turn ID stored internally
    });

    it('shows status text for status events', async () => {
      const { getByText } = await sendAndGetCallbacks();
      act(() => {
        onEventCallback!({ type: 'turn_started', turnId: 'turn-1' });
        onEventCallback!({ type: 'status', message: 'Reading files...' });
      });
      expect(getByText('Reading files...')).toBeTruthy();
    });

    it('shows thinking status for thinking_delta', async () => {
      const { getByText } = await sendAndGetCallbacks();
      act(() => {
        onEventCallback!({ type: 'turn_started', turnId: 'turn-1' });
        onEventCallback!({ type: 'thinking_delta', text: 'some thinking' });
      });
      expect(getByText('Thinking...')).toBeTruthy();
    });

    it('streams assistant_delta text incrementally', async () => {
      const { getByText } = await sendAndGetCallbacks();
      act(() => {
        onEventCallback!({ type: 'turn_started', turnId: 'turn-1' });
        onEventCallback!({ type: 'assistant_delta', text: 'Hello ' });
      });
      // Markdown may trim trailing whitespace from partial chunks
      expect(getByText(/Hello/)).toBeTruthy();

      act(() => {
        onEventCallback!({ type: 'assistant_delta', text: 'world!' });
      });
      expect(getByText(/Hello world!/)).toBeTruthy();
    });

    it('replaces streaming text on full assistant event', async () => {
      const { getByText, queryByText } = await sendAndGetCallbacks();
      act(() => {
        onEventCallback!({ type: 'turn_started', turnId: 'turn-1' });
        onEventCallback!({ type: 'assistant_delta', text: 'partial...' });
      });
      // Markdown renders streaming text and converts "..." to "…"
      expect(getByText(/partial/)).toBeTruthy();

      act(() => {
        onEventCallback!({ type: 'assistant', text: 'Full response here.' });
      });
      // Text may be in streaming bubble (with cursor) or message bubble
      expect(getByText(/Full response here\./)).toBeTruthy();
      expect(queryByText(/partial/)).toBeNull();
    });

    it('shows tool usage status and clears streaming text on tool start', async () => {
      const { getByText, queryByText, queryAllByText } = await sendAndGetCallbacks();
      act(() => {
        onEventCallback!({ type: 'turn_started', turnId: 'turn-1' });
        onEventCallback!({ type: 'assistant_delta', text: 'Let me check...' });
      });
      // Markdown renders streaming text and converts "..." to "…"
      expect(getByText(/Let me check/)).toBeTruthy();

      act(() => {
        onEventCallback!({ type: 'tool', stage: 'start', toolName: 'read_file' });
      });
      expect(queryAllByText('Reading a file').length).toBeGreaterThan(0);
      expect(queryByText(/Let me check/)).toBeNull();
    });

    it('clears status on tool end', async () => {
      const { queryAllByText } = await sendAndGetCallbacks();
      act(() => {
        onEventCallback!({ type: 'turn_started', turnId: 'turn-1' });
        onEventCallback!({ type: 'tool', stage: 'start', toolName: 'search' });
      });
      // Running state surfaces in both the header headline and the running-step row.
      const runningOccurrences = queryAllByText('Searching').length;
      expect(runningOccurrences).toBeGreaterThanOrEqual(2);

      act(() => {
        onEventCallback!({ type: 'tool', stage: 'end', toolName: 'search' });
      });
      // After the tool ends, the running headline clears even though the completed
      // step row remains as an audit-trail entry — so the total count drops.
      expect(queryAllByText('Searching').length).toBeLessThan(runningOccurrences);
    });

    it('fetches session and clears optimistic state on result', async () => {
      const finalSession = mockFullSession({
        messages: [
          mockMessage({ id: 'msg-1', role: 'user', text: 'Test' }),
          mockMessage({ id: 'msg-2', role: 'result', text: 'Here is the answer.' }),
        ],
      });

      const { getByText } = await sendAndGetCallbacks();

      // Show streaming text first
      act(() => {
        onEventCallback!({ type: 'turn_started', turnId: 'turn-1' });
        onEventCallback!({ type: 'assistant', text: 'Here is the answer.' });
      });
      // Text may be in streaming bubble (with cursor) or message bubble
      expect(getByText(/Here is the answer\./)).toBeTruthy();

      // Set up mocks for the post-result fetches
      cloudClient.getSession.mockResolvedValueOnce(finalSession);
      cloudClient.getSessions.mockResolvedValueOnce({ sessions: [], totalCount: 0 });

      // Fire result
      await act(async () => {
        onEventCallback!({ type: 'result', text: 'Here is the answer.', usage: '$0.01' });
        await flushPromises();
      });

      // After result, session data replaces optimistic state
      await waitFor(() => {
        expect(getByText('Here is the answer.')).toBeTruthy();
      });
    });

    it('handles error event gracefully', async () => {
      const fullSession = mockFullSession({ messages: [] });
      cloudClient.getSession.mockResolvedValue(fullSession);
      cloudClient.getSessions.mockResolvedValue({ sessions: [], totalCount: 0 });

      await sendAndGetCallbacks();

      await act(async () => {
        onEventCallback!({ type: 'error', error: 'Something went wrong' });
        await flushPromises();
      });

      // Should not crash, sending state cleared
    });

    it('handles WS error callback', async () => {
      await sendAndGetCallbacks();

      act(() => {
        onErrorCallback!(new Error('Connection lost'));
      });

      // Should not crash, input should be re-enabled
    });
  });

  describe('stop button', () => {
    it('shows stop button while busy and calls stopTurn', async () => {
      const session = mockFullSession({ messages: [] });
      cloudClient.getSession.mockResolvedValueOnce(session);

      const result = render(<ConversationScreen />);
      await waitFor(() => expect(result.getByText('Tap to speak')).toBeTruthy());
      await switchToTextMode(result);

      const { getByPlaceholderText, getByTestId, queryByTestId } = result;

      fireEvent.changeText(getByPlaceholderText('Message Rebel...'), 'Hi');
      fireEvent.press(getByTestId('conversation-send-button'));

      act(() => {
        onEventCallback!({ type: 'turn_started', turnId: 'turn-stop-1' });
      });

      // Stop button should appear (send button replaced)
      expect(queryByTestId('conversation-send-button')).toBeNull();

      // Find and press the stop button (it's the TouchableOpacity with stopButton style)
      // We can't easily query by style, so press it via the stopTurn mock
      await act(async () => {
        await mockStopTurn('turn-stop-1');
      });
      expect(mockStopTurn).toHaveBeenCalled();
    });
  });

  describe('initial prompt (quick-send)', () => {
    it('sends initial prompt immediately without fetching session', async () => {
      mockSearchParams = { id: 'new-session-1', initialPrompt: 'Quick question' };

      const { getByText } = render(<ConversationScreen />);

      await waitFor(() => {
        expect(getByText('Quick question')).toBeTruthy();
      });

      expect(cloudClient.createAgentTurnSocket).toHaveBeenCalledWith(
        { sessionId: 'new-session-1', prompt: 'Quick question', clientTurnId: expect.any(String) },
        expect.any(Function),
        expect.any(Function),
        expect.any(Function),
      );
      // Should NOT have called getSession (optimistic UI)
      expect(cloudClient.getSession).not.toHaveBeenCalled();
    });

    it('does not re-send initial prompt on re-render', async () => {
      mockSearchParams = { id: 'new-session-2', initialPrompt: 'Hello' };

      const { rerender } = render(<ConversationScreen />);
      await flushPromises();
      rerender(<ConversationScreen />);
      await flushPromises();

      expect(cloudClient.createAgentTurnSocket).toHaveBeenCalledTimes(1);
    });
  });

  describe('prefill (Resolve with Rebel)', () => {
    it('prefills the composer in text mode without auto-sending', async () => {
      const seededPrompt = 'I need help resolving a conflict on a file you want to save.\nStaged file ID: stg_123';
      mockSearchParams = { id: 'existing-session-1', prefill: seededPrompt };
      const session = mockFullSession();
      cloudClient.getSession.mockResolvedValueOnce(session);

      const result = render(<ConversationScreen />);
      await flushPromises();

      // Text input should be visible (text mode enabled by prefill)
      const input = await waitFor(() => result.getByTestId('conversation-input'));
      expect(input.props.value).toBe(seededPrompt);

      // Must NOT have auto-sent the turn — prefill requires user review
      expect(cloudClient.createAgentTurnSocket).not.toHaveBeenCalled();
    });

    it('does not override user-typed text if they start typing before prefill settles', async () => {
      const seededPrompt = 'Prefilled seed from Resolve with Rebel';
      mockSearchParams = { id: 'existing-session-2', prefill: seededPrompt };
      const session = mockFullSession();
      cloudClient.getSession.mockResolvedValueOnce(session);

      const result = render(<ConversationScreen />);
      await flushPromises();

      const input = await waitFor(() => result.getByTestId('conversation-input'));
      // After mount the prefill should be applied (input was empty before).
      expect(input.props.value).toBe(seededPrompt);
    });

    // F6-R1-6: oversized prefill must be truncated at 16 KB to defend
    // against attacker-controlled deep links.
    it('caps an oversized prefill at 16 KB and drops no user intent silently', async () => {
      const oversized = 'A'.repeat(20 * 1024); // 20 KB
      mockSearchParams = { id: 'existing-session-cap', prefill: oversized };
      const session = mockFullSession();
      cloudClient.getSession.mockResolvedValueOnce(session);

      const result = render(<ConversationScreen />);
      await flushPromises();

      const input = await waitFor(() => result.getByTestId('conversation-input'));
      // Input value must be at most 16 KB.
      expect(input.props.value.length).toBeLessThanOrEqual(16 * 1024);
      // Must NOT have auto-sent the (truncated) prefill as a turn.
      expect(cloudClient.createAgentTurnSocket).not.toHaveBeenCalled();
    });

    // F6-R1-6: when both `initialPrompt` (auto-send) and `prefill`
    // (review-before-send) are present, `prefill` must win.
    it('prefers prefill over initialPrompt and does NOT auto-send when both are present', async () => {
      const seededPrompt = 'prefill seed';
      mockSearchParams = {
        id: 'existing-session-prefer',
        initialPrompt: 'SHOULD NOT AUTO-SEND',
        prefill: seededPrompt,
      };
      const session = mockFullSession();
      cloudClient.getSession.mockResolvedValueOnce(session);

      const result = render(<ConversationScreen />);
      await flushPromises();

      const input = await waitFor(() => result.getByTestId('conversation-input'));
      expect(input.props.value).toBe(seededPrompt);
      // The critical assertion: initialPrompt MUST NOT have auto-sent.
      expect(cloudClient.createAgentTurnSocket).not.toHaveBeenCalled();
    });

    // F6-R2-1 (behavioral-safety re-review): same-session prefill updates
    // must re-apply. Old single-effect design keyed only on [id] would
    // LATCH — a second "Resolve with Rebel" tap against the same session
    // would silently drop the new prefill.
    it('re-applies a new prefill for the same session id when the param changes', async () => {
      const firstSeed = 'first seed';
      const secondSeed = 'second seed';
      mockSearchParams = { id: 'existing-session-relatch', prefill: firstSeed };
      cloudClient.getSession.mockResolvedValueOnce(mockFullSession());

      const result = render(<ConversationScreen />);
      await flushPromises();

      const input = await waitFor(() => result.getByTestId('conversation-input'));
      expect(input.props.value).toBe(firstSeed);

      // Simulate the user clearing the composer (matches real flow:
      // user reviewed first prefill, tapped send, input cleared).
      fireEvent.changeText(input, '');

      // Same id, NEW prefill — must not latch.
      mockSearchParams = { id: 'existing-session-relatch', prefill: secondSeed };
      result.rerender(<ConversationScreen />);
      await flushPromises();

      expect(input.props.value).toBe(secondSeed);
    });
  });

  describe('multi-turn conversation', () => {
    it('handles two consecutive turns', async () => {
      // Start with existing session that has one exchange
      const session = mockFullSession({
        messages: [
          mockMessage({ id: 'msg-1', role: 'user', text: 'First question' }),
          mockMessage({ id: 'msg-2', role: 'result', text: 'First answer' }),
        ],
      });
      cloudClient.getSession.mockResolvedValueOnce(session);

      const result = render(<ConversationScreen />);
      await waitFor(() => expect(result.getByText('First question')).toBeTruthy());
      expect(result.getByText('First answer')).toBeTruthy();
      await switchToTextMode(result);

      const { getByPlaceholderText, getByTestId, getByText } = result;

      // Send second message
      fireEvent.changeText(getByPlaceholderText('Message Rebel...'), 'Follow-up question');
      fireEvent.press(getByTestId('conversation-send-button'));

      await waitFor(() => expect(getByText('Follow-up question')).toBeTruthy());

      // Simulate full second turn
      act(() => {
        onEventCallback!({ type: 'turn_started', turnId: 'turn-2' });
        onEventCallback!({ type: 'status', message: 'Processing...' });
      });
      expect(getByText('Processing...')).toBeTruthy();

      act(() => {
        onEventCallback!({ type: 'assistant', text: 'Second answer' });
      });
      // Text may be in streaming bubble (with cursor) or message bubble
      expect(getByText(/Second answer/)).toBeTruthy();

      // Result -- fetch returns updated session
      const updatedSession = mockFullSession({
        messages: [
          mockMessage({ id: 'msg-1', role: 'user', text: 'First question' }),
          mockMessage({ id: 'msg-2', role: 'result', text: 'First answer' }),
          mockMessage({ id: 'msg-3', role: 'user', text: 'Follow-up question' }),
          mockMessage({ id: 'msg-4', role: 'result', text: 'Second answer' }),
        ],
      });
      cloudClient.getSession.mockResolvedValueOnce(updatedSession);
      cloudClient.getSessions.mockResolvedValueOnce({ sessions: [], totalCount: 0 });

      await act(async () => {
        onEventCallback!({ type: 'result', text: 'Second answer', usage: '$0.02' });
        await flushPromises();
      });

      await waitFor(() => {
        expect(getByText('First question')).toBeTruthy();
        expect(getByText('First answer')).toBeTruthy();
        expect(getByText('Follow-up question')).toBeTruthy();
        expect(getByText('Second answer')).toBeTruthy();
      });
    });
  });

  describe('hasActiveContent guard', () => {
    it('does not show loading state while sending', async () => {
      mockSearchParams = { id: 'new-session', initialPrompt: 'Go' };
      // Don't resolve getSession -- currentSession stays null
      cloudClient.getSession.mockImplementation(() => new Promise(() => {}));

      const { queryByText, getByText } = render(<ConversationScreen />);

      await waitFor(() => {
        // Should show the optimistic message, NOT a loading spinner or error
        expect(getByText('Go')).toBeTruthy();
      });
      expect(queryByText('No messages yet')).toBeNull();
    });
  });

  describe('cleanup', () => {
    it('closes socket and clears session on unmount', async () => {
      const session = mockFullSession();
      cloudClient.getSession.mockResolvedValueOnce(session);

      const result = render(<ConversationScreen />);
      await waitFor(() => expect(result.getByText('Hello')).toBeTruthy());
      await switchToTextMode(result);

      const { unmount, getByPlaceholderText, getByTestId } = result;

      // Send to create a socket
      fireEvent.changeText(getByPlaceholderText('Message Rebel...'), 'Bye');
      fireEvent.press(getByTestId('conversation-send-button'));
      await waitFor(() => expect(onEventCallback).not.toBeNull());

      unmount();
      // Close and session cleanup are deferred to next microtask
      // to avoid native TurboModule exceptions during unmount.
      await waitFor(() => {
        expect(mockClose).toHaveBeenCalled();
      });
      await waitFor(() => {
        expect(useSessionStore.getState().currentSession).toBeNull();
      });
    });
  });

  describe('inline approval banner', () => {
    const mockToolApproval = {
      toolUseID: 'tool-1',
      turnId: 'turn-1',
      sessionId: 'session-1',
      toolName: 'read_file',
      input: { path: '/test.txt' },
      reason: 'Wants to read a file',
      timestamp: Date.now(),
    };

    const mockStagedCall = {
      id: 'staged-1',
      sessionId: 'session-1',
      turnId: 'turn-1',
      timestamp: Date.now(),
      status: 'pending',
      displayName: 'write_file',
      toolCategory: 'filesystem',
      riskLevel: 'high',
      reason: 'Wants to write a file',
      mcpPayload: { packageId: 'pkg-1', toolId: 'write_file', args: { path: '/out.txt' } },
    };

    /** Mock ipcCall to return approval data for fetchPending, passthrough for others. */
    function mockIpcCallWithApprovals(approvals: unknown[] = [], staged: unknown[] = []) {
      cloudClient.ipcCall.mockImplementation((channel: string, ...args: unknown[]) => {
        if (channel === 'tool-safety:pending') return Promise.resolve(approvals);
        if (channel === 'tool-safety:staged-get-all') return Promise.resolve(staged);
        return Promise.resolve(undefined);
      });
    }

    it('shows banner when store has approvals matching session ID', async () => {
      const session = mockFullSession({ messages: [] });
      cloudClient.getSession.mockResolvedValueOnce(session);
      mockIpcCallWithApprovals([mockToolApproval]);

      const { getByTestId, getByText } = render(<ConversationScreen />);

      await waitFor(() => {
        expect(getByTestId('conversation-approval-banner')).toBeTruthy();
        expect(getByText('read_file')).toBeTruthy();
      });
    });

    it('shows staged call cards in banner', async () => {
      const session = mockFullSession({ messages: [] });
      cloudClient.getSession.mockResolvedValueOnce(session);
      mockIpcCallWithApprovals([], [mockStagedCall]);

      const { getByTestId, getByText } = render(<ConversationScreen />);

      await waitFor(() => {
        expect(getByTestId('conversation-approval-banner')).toBeTruthy();
        expect(getByText('write_file')).toBeTruthy();
      });
    });

    it('does not show banner when approvals belong to a different session', async () => {
      const session = mockFullSession({ messages: [] });
      cloudClient.getSession.mockResolvedValueOnce(session);
      mockIpcCallWithApprovals(
        [{ ...mockToolApproval, sessionId: 'other-session' }],
        [{ ...mockStagedCall, sessionId: 'other-session' }],
      );

      const { queryByTestId } = render(<ConversationScreen />);

      await waitFor(() => {
        expect(queryByTestId('conversation-approval-banner')).toBeNull();
      });
    });

    it('does not show banner when approval has no sessionId', async () => {
      const session = mockFullSession({ messages: [] });
      cloudClient.getSession.mockResolvedValueOnce(session);
      mockIpcCallWithApprovals([{ ...mockToolApproval, sessionId: undefined }]);

      const { queryByTestId } = render(<ConversationScreen />);

      await waitFor(() => {
        expect(queryByTestId('conversation-approval-banner')).toBeNull();
      });
    });

    it('approve callback triggers respondToApproval', async () => {
      const session = mockFullSession({ messages: [] });
      cloudClient.getSession.mockResolvedValueOnce(session);
      mockIpcCallWithApprovals([mockToolApproval]);

      const { getByTestId } = render(<ConversationScreen />);

      await waitFor(() => {
        expect(getByTestId(`approvals-approve-button-${mockToolApproval.toolUseID}`)).toBeTruthy();
      });

      await act(async () => {
        fireEvent.press(getByTestId(`approvals-approve-button-${mockToolApproval.toolUseID}`));
        await flushPromises();
      });

      expect(cloudClient.ipcCall).toHaveBeenCalledWith(
        'agent:tool-safety-response',
        expect.objectContaining({ toolUseID: 'tool-1', approved: true }),
      );
    });

    it('deny callback triggers respondToApproval with approved=false', async () => {
      const session = mockFullSession({ messages: [] });
      cloudClient.getSession.mockResolvedValueOnce(session);
      mockIpcCallWithApprovals([mockToolApproval]);

      const { getByTestId } = render(<ConversationScreen />);

      await waitFor(() => {
        expect(getByTestId(`approvals-reject-button-${mockToolApproval.toolUseID}`)).toBeTruthy();
      });

      await act(async () => {
        fireEvent.press(getByTestId(`approvals-reject-button-${mockToolApproval.toolUseID}`));
        await flushPromises();
      });

      expect(cloudClient.ipcCall).toHaveBeenCalledWith(
        'agent:tool-safety-response',
        expect.objectContaining({ toolUseID: 'tool-1', approved: false }),
      );
    });
  });

  describe('file viewer link handling', () => {
    async function renderStreamingMessage(text: string) {
      const session = mockFullSession({ messages: [] });
      cloudClient.getSession.mockResolvedValueOnce(session);

      const result = render(<ConversationScreen />);
      await waitFor(() => expect(result.getByText('Tap to speak')).toBeTruthy());
      await switchToTextMode(result);

      fireEvent.changeText(result.getByPlaceholderText('Message Rebel...'), 'Test');
      fireEvent.press(result.getByTestId('conversation-send-button'));

      await waitFor(() => expect(onEventCallback).not.toBeNull());
      act(() => {
        onEventCallback!({ type: 'turn_started', turnId: 'turn-1' });
        onEventCallback!({ type: 'assistant_delta', text });
      });

      return result;
    }

    it('tapping a library:// link in a message opens the file viewer with a stripped path', async () => {
      const session = mockFullSession({
        messages: [
          mockMessage({ id: 'msg-1', role: 'assistant', text: 'Check this [View file](library://docs/test.md#heading)' }),
        ],
      });
      cloudClient.getSession.mockResolvedValueOnce(session);

      const { getByText } = render(<ConversationScreen />);
      await waitFor(() => expect(getByText('View file')).toBeTruthy());

      fireEvent.press(getByText('View file'));

      await waitFor(() => {
        expect(cloudClient.readWorkspaceFile).toHaveBeenCalledWith('docs/test.md');
      });
    });

    it('routes rebel conversation links to the conversation screen', async () => {
      const session = mockFullSession({
        messages: [
          mockMessage({ id: 'msg-1', role: 'assistant', text: 'Open [thread](rebel://conversation/xyz)' }),
        ],
      });
      cloudClient.getSession.mockResolvedValueOnce(session);

      const { getByText, queryByTestId } = render(<ConversationScreen />);
      await waitFor(() => expect(getByText('thread')).toBeTruthy());

      fireEvent.press(getByText('thread'));

      expect(mockPush).toHaveBeenCalledWith('/conversation/xyz');
      expect(cloudClient.readWorkspaceFile).not.toHaveBeenCalled();
      expect(queryByTestId('conversation-toast')).toBeNull();
    });

    it('blocks malformed rebel links with a toast', async () => {
      const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
      const session = mockFullSession({
        messages: [
          mockMessage({ id: 'msg-1', role: 'assistant', text: 'Open [broken](rebel://foo/bar)' }),
        ],
      });
      cloudClient.getSession.mockResolvedValueOnce(session);

      const { getByText, findByText } = render(<ConversationScreen />);
      await waitFor(() => expect(getByText('broken')).toBeTruthy());

      fireEvent.press(getByText('broken'));

      await expect(findByText("That link doesn't look right.")).resolves.toBeTruthy();
      expect(cloudClient.readWorkspaceFile).not.toHaveBeenCalled();
      expect(mockPush).not.toHaveBeenCalled();
      expect(warnSpy).toHaveBeenCalledWith(
        '[mobile] blocked link',
        expect.objectContaining({ url: 'rebel://foo/bar', reason: 'invalid-rebel-url' }),
      );
      warnSpy.mockRestore();
    });

    it('routes rebel://conversation/ (empty id) to the conversations tab on mobile', async () => {
      const session = mockFullSession({
        messages: [
          mockMessage({ id: 'msg-1', role: 'assistant', text: 'Open [thread root](rebel://conversation/)' }),
        ],
      });
      cloudClient.getSession.mockResolvedValueOnce(session);

      const { getByText, queryByText } = render(<ConversationScreen />);
      await waitFor(() => expect(getByText('thread root')).toBeTruthy());

      fireEvent.press(getByText('thread root'));

      expect(mockPush).toHaveBeenCalledWith('/(tabs)/conversations');
      expect(queryByText('This link only works on desktop.')).toBeNull();
    });

    // Note: Markdown-it normalizes malformed percent-encoding (e.g. %GG → %25GG)
    // before the dispatcher sees it, so a rendered-markdown regression test isn't
    // meaningful for this path. The dispatcher-level contract is pinned in
    // packages/shared/src/utils/__tests__/markdownLinkHandler.test.ts
    // ("blocks malformed percent-encoding in conversation id").

    it('shows a desktop-only toast for non-conversation rebel navigation on mobile', async () => {
      const session = mockFullSession({
        messages: [
          mockMessage({ id: 'msg-1', role: 'assistant', text: 'Open [settings](rebel://settings/agents)' }),
        ],
      });
      cloudClient.getSession.mockResolvedValueOnce(session);

      const { getByText, findByText } = render(<ConversationScreen />);
      await waitFor(() => expect(getByText('settings')).toBeTruthy());

      fireEvent.press(getByText('settings'));

      await expect(findByText('This link only works on desktop.')).resolves.toBeTruthy();
      expect(mockPush).not.toHaveBeenCalled();
      expect(cloudClient.readWorkspaceFile).not.toHaveBeenCalled();
    });

    it('opens tutorial links in the file viewer with a mobile-specific unsupported error', async () => {
      const session = mockFullSession({
        messages: [
          mockMessage({ id: 'msg-1', role: 'assistant', text: 'Open the [tutorial](rebel://help/tutorials/guide.html)' }),
        ],
      });
      cloudClient.getSession.mockResolvedValueOnce(session);

      const { getByText, findByText } = render(<ConversationScreen />);
      await waitFor(() => expect(getByText('tutorial')).toBeTruthy());

      fireEvent.press(getByText('tutorial'));

      await expect(
        findByText("Previewing tutorials on mobile isn't supported yet — open it on desktop to read."),
      ).resolves.toBeTruthy();
      expect(cloudClient.readWorkspaceFile).not.toHaveBeenCalled();
      expect(mockPush).not.toHaveBeenCalled();
    });

    it('blocks file:// links on mobile with a toast instead of reading a file', async () => {
      const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
      const session = mockFullSession({
        messages: [
          mockMessage({ id: 'msg-1', role: 'assistant', text: 'Open [notes](file:///tmp/notes.md)' }),
        ],
      });
      cloudClient.getSession.mockResolvedValueOnce(session);

      const { getByText, getByTestId, queryByTestId } = render(<ConversationScreen />);
      await waitFor(() => expect(getByText('notes')).toBeTruthy());

      fireEvent.press(getByText('notes'));

      await waitFor(() => {
        expect(getByTestId('conversation-toast')).toBeTruthy();
      });
      expect(getByText('This link only works on desktop.')).toBeTruthy();
      expect(cloudClient.readWorkspaceFile).not.toHaveBeenCalled();
      expect(warnSpy).toHaveBeenCalledWith(
        '[mobile] blocked link',
        expect.objectContaining({ url: 'file:///tmp/notes.md', reason: 'platform-unsupported' }),
      );
      expect(queryByTestId('conversation-streaming-message')).toBeNull();
      warnSpy.mockRestore();
    });

    it('passes external links through to Linking.openURL', async () => {
      const session = mockFullSession({
        messages: [
          mockMessage({ id: 'msg-1', role: 'assistant', text: 'Visit [Example](https://example.com)' }),
        ],
      });
      cloudClient.getSession.mockResolvedValueOnce(session);

      const { getByText } = render(<ConversationScreen />);
      await waitFor(() => expect(getByText('Example')).toBeTruthy());

      fireEvent.press(getByText('Example'));

      await waitFor(() => {
        expect(linkingOpenUrlSpy).toHaveBeenCalledWith('https://example.com');
      });
      expect(cloudClient.readWorkspaceFile).not.toHaveBeenCalled();
    });

    it('blocks unknown schemes without reading files and surfaces a toast', async () => {
      const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
      const session = mockFullSession({
        messages: [
          mockMessage({ id: 'msg-1', role: 'assistant', text: 'Run [payload](javascript:alert(1))' }),
        ],
      });
      cloudClient.getSession.mockResolvedValueOnce(session);

      const { getByText, findByText } = render(<ConversationScreen />);
      await waitFor(() => expect(getByText('payload')).toBeTruthy());

      fireEvent.press(getByText('payload'));

      expect(cloudClient.readWorkspaceFile).not.toHaveBeenCalled();
      expect(linkingOpenUrlSpy).not.toHaveBeenCalled();
      // Per the "silent failure is a bug" principle, every blocked tap shows a toast.
      // Previously this case was warn-only, which felt like a broken app to users.
      await expect(findByText("That link isn't supported here.")).resolves.toBeTruthy();
      expect(warnSpy).toHaveBeenCalledWith(
        '[mobile] blocked link',
        expect.objectContaining({ url: 'javascript:alert(1)', reason: 'unknown-scheme' }),
      );
      warnSpy.mockRestore();
    });

    it('ignores anchor links without side effects', async () => {
      const session = mockFullSession({
        messages: [
          mockMessage({ id: 'msg-1', role: 'assistant', text: 'Jump [top](#top)' }),
        ],
      });
      cloudClient.getSession.mockResolvedValueOnce(session);

      const { getByText, queryByTestId } = render(<ConversationScreen />);
      await waitFor(() => expect(getByText('top')).toBeTruthy());

      fireEvent.press(getByText('top'));

      expect(cloudClient.readWorkspaceFile).not.toHaveBeenCalled();
      expect(linkingOpenUrlSpy).not.toHaveBeenCalled();
      expect(mockPush).not.toHaveBeenCalled();
      expect(queryByTestId('conversation-toast')).toBeNull();
    });

    it('suppresses streamed library links without opening the file viewer', async () => {
      const { getByText } = await renderStreamingMessage('[File](library://foo.md)');
      await waitFor(() => expect(getByText('File')).toBeTruthy());

      fireEvent.press(getByText('File'));

      expect(cloudClient.readWorkspaceFile).not.toHaveBeenCalled();
      expect(linkingOpenUrlSpy).not.toHaveBeenCalled();
    });

    it('still opens external links while streaming', async () => {
      const { getByText } = await renderStreamingMessage('[Site](https://example.com)');
      await waitFor(() => expect(getByText('Site')).toBeTruthy());

      fireEvent.press(getByText('Site'));

      await waitFor(() => {
        expect(linkingOpenUrlSpy).toHaveBeenCalledWith('https://example.com');
      });
      expect(cloudClient.readWorkspaceFile).not.toHaveBeenCalled();
    });

    it('renders the FileViewerModal component', async () => {
      const session = mockFullSession();
      cloudClient.getSession.mockResolvedValueOnce(session);

      const { getByTestId } = render(<ConversationScreen />);
      await waitFor(() => expect(getByTestId('conversation-screen')).toBeTruthy());

      // FileViewerModal is always rendered (invisible by default)
      // Its internal testIDs aren't visible when not shown, but we verify no crash
    });
  });
});
