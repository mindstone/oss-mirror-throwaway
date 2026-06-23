/**
 * Voice recording tests — covers the full voice-first flow:
 * mic tap → record → stop → transcribe → auto-send turn.
 *
 * Uses mocked expo-audio and cloud transcription to verify the
 * real control flow without needing a microphone or network.
 */

import React from 'react';
import { render, fireEvent, waitFor, act } from '@testing-library/react-native';
import { mockFullSession, mockMessage, flushPromises } from './helpers';

// --- Mock expo-audio ---
let mockRecordingStatusCallback: ((status: { isFinished: boolean; hasError: boolean; url?: string }) => void) | null = null;
const mockRecorderPrepare = jest.fn().mockResolvedValue(undefined);
const mockRecorderRecord = jest.fn();
const mockRecorderStop = jest.fn().mockResolvedValue(undefined);
let mockRecorderUri: string | null = null;
let mockRecorderIsRecording = false;

jest.mock('expo-audio', () => ({
  RecordingPresets: { HIGH_QUALITY: {} },
  requestRecordingPermissionsAsync: jest.fn().mockResolvedValue({ granted: true }),
  setAudioModeAsync: jest.fn().mockResolvedValue(undefined),
  createAudioPlayer: jest.fn(() => ({
    play: jest.fn(),
    pause: jest.fn(),
    remove: jest.fn(),
    addListener: jest.fn(),
  })),
  useAudioRecorder: jest.fn((_preset: unknown, onStatus: (status: unknown) => void) => {
    mockRecordingStatusCallback = onStatus;
    return {
      prepareToRecordAsync: mockRecorderPrepare,
      record: mockRecorderRecord,
      stop: mockRecorderStop,
      get uri() { return mockRecorderUri; },
      get isRecording() { return mockRecorderIsRecording; },
    };
  }),
}));

// --- Mock expo-router ---
const mockPush = jest.fn();
let mockSearchParams: Record<string, string> = { id: 'session-voice-1' };
jest.mock('expo-router', () => ({
  useLocalSearchParams: () => mockSearchParams,
  useRouter: () => ({ push: mockPush }),
  Stack: { Screen: () => null },
}));

// --- Mock expo-file-system/legacy for native upload + TTS temp file ---
const mockUploadAsync = jest.fn();
jest.mock('expo-file-system/legacy', () => ({
  uploadAsync: (...args: unknown[]) => mockUploadAsync(...args),
  writeAsStringAsync: jest.fn().mockResolvedValue(undefined),
  deleteAsync: jest.fn().mockResolvedValue(undefined),
  getFreeDiskStorageAsync: jest.fn().mockResolvedValue(1024 * 1024 * 1024),
  cacheDirectory: '/tmp/mock-cache/',
  FileSystemUploadType: { BINARY_CONTENT: 0, MULTIPART: 1 },
  EncodingType: { Base64: 'base64' },
}));

// --- Mock react-native-safe-area-context (required by FileViewerModal) ---
jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
  SafeAreaProvider: ({ children }: { children: React.ReactNode }) => children,
}));

// --- Mock @react-navigation/native — ConversationScreen uses useIsFocused
// to focus-gate the empty-state FloatingOrbs; no NavigationContainer in tests. ---
jest.mock('@react-navigation/native', () => ({
  useIsFocused: () => false,
}));

// --- Mock MeetingRecordingContext (used by conversation screen for meeting banner) ---
jest.mock('../../src/context/MeetingRecordingContext', () => ({
  useMeetingRecordingContext: () => ({
    state: 'idle',
    isRecording: false,
    meetingSessionId: null,
    meetingCloudSessionId: null,
    meetingTitle: '',
    companionSessionId: null,
    error: null,
    startRecording: jest.fn(),
    stopRecording: jest.fn(),
    setMeetingTitle: jest.fn(),
  }),
  MeetingRecordingProvider: ({ children }: { children: React.ReactNode }) => children,
}));

// --- Mock cloud client ---
let onEventCallback: ((event: unknown) => void) | null = null;
const mockClose = jest.fn();

let mockOn401Callback: (() => void) | null = null;
jest.mock('../../../cloud-client/src/cloudClient', () => ({
  createAgentTurnSocket: jest.fn(
    (_req: unknown, onEvent: (event: unknown) => void) => {
      onEventCallback = onEvent;
      return { close: mockClose };
    },
  ),
  stopTurn: jest.fn().mockResolvedValue(undefined),
  getSessions: jest.fn().mockResolvedValue({ sessions: [], totalCount: 0 }),
  getSession: jest.fn(),
  transcribe: jest.fn(),
  textToSpeech: jest.fn().mockResolvedValue(new ArrayBuffer(0)),
  readWorkspaceFile: jest.fn().mockResolvedValue({ content: '' }),
  ipcCall: jest.fn(),
  configure: jest.fn(),
  clearConfig: jest.fn(),
  checkHealth: jest.fn().mockResolvedValue({ status: 'ok' }),
  getSettings: jest.fn().mockResolvedValue({}),
  onUnauthorized: jest.fn((cb: () => void) => { mockOn401Callback = cb; }),
  fireUnauthorized: jest.fn(() => { mockOn401Callback?.(); }),
}));

const cloudClient = require('../../../cloud-client/src/cloudClient');

const { useSessionStore, initAuthStore, useAuthStore, initOfflineQueueStore } = require('@rebel/cloud-client');
const { _resetOfflineQueueStore } = require('../../../cloud-client/src/offlineQueue/offlineQueueStore');

// Initialise auth store with mock storage before rendering any components
const mockStorage = {
  getToken: jest.fn().mockResolvedValue(null),
  setToken: jest.fn().mockResolvedValue(undefined),
  clearToken: jest.fn().mockResolvedValue(undefined),
};
initAuthStore(mockStorage);

import ConversationScreen from '../../app/conversation/[id]';

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

function resetState() {
  useSessionStore.setState({
    sessions: [],
    isLoading: false,
    error: null,
    currentSession: null,
    isLoadingSession: false,
    _lastFetchOptions: undefined,
  });
  useAuthStore.setState({
    cloudUrl: 'https://mock-cloud.test',
    token: 'mock-token',
    isPaired: true,
  });
  mockSearchParams = { id: 'session-voice-1' };
  onEventCallback = null;
  mockRecorderUri = null;
  mockRecorderIsRecording = false;
  mockRecordingStatusCallback = null;
  mockUploadAsync.mockReset();
  mockUploadAsync.mockResolvedValue({ status: 200, headers: {}, body: '{}' });
  mockClose.mockClear();
  mockRecorderPrepare.mockClear();
  mockRecorderRecord.mockClear();
  mockRecorderStop.mockClear();
  cloudClient.createAgentTurnSocket.mockClear();
  cloudClient.getSession.mockClear();
}

let fakeTime: number;
let dateNowSpy: jest.SpyInstance;

beforeEach(() => {
  _resetOfflineQueueStore();
  initOfflineQueueStore(createMockQueueStorage(), jest.fn());
  resetState();
  fakeTime = Date.now();
  dateNowSpy = jest.spyOn(Date, 'now').mockImplementation(() => fakeTime);
});

afterEach(() => {
  dateNowSpy.mockRestore();
});

/** Simulate enough time for a valid recording (>500ms). */
function advanceRecordingTime() {
  fakeTime += 1000;
}

/** Start recording, advance time, fire status callback with audio URL. */
async function recordAndFinish(getByTestId: (id: string) => ReturnType<typeof render>['getByTestId'] extends (id: string) => infer R ? R : never) {
  // Start recording
  await act(async () => {
    fireEvent.press(getByTestId('conversation-mic-button'));
    await flushPromises();
  });

  advanceRecordingTime();

  // Simulate recording finished
  await act(async () => {
    mockRecorderUri = 'file:///tmp/test-audio.m4a';
    mockRecordingStatusCallback?.({
      isFinished: true,
      hasError: false,
      url: 'file:///tmp/test-audio.m4a',
    });
    await flushPromises();
  });
}

describe('voice recording flow', () => {
  it('shows voice-first UI by default with "Tap to speak"', async () => {
    const session = mockFullSession({ messages: [] });
    cloudClient.getSession.mockResolvedValueOnce(session);

    const { getByText, getByTestId, queryByPlaceholderText } = render(<ConversationScreen />);
    await waitFor(() => expect(getByText('Tap to speak')).toBeTruthy());

    expect(getByTestId('conversation-mic-button')).toBeTruthy();
    expect(queryByPlaceholderText('Message Rebel...')).toBeNull();
  });

  it('starts recording on mic button press', async () => {
    const session = mockFullSession({ messages: [] });
    cloudClient.getSession.mockResolvedValueOnce(session);

    const { getByText, getByTestId } = render(<ConversationScreen />);
    await waitFor(() => expect(getByText('Tap to speak')).toBeTruthy());

    await act(async () => {
      fireEvent.press(getByTestId('conversation-mic-button'));
      await flushPromises();
    });

    expect(mockRecorderPrepare).toHaveBeenCalled();
    expect(mockRecorderRecord).toHaveBeenCalled();
  });

  it('shows "Tap to send" hint and send button while recording', async () => {
    const session = mockFullSession({ messages: [] });
    cloudClient.getSession.mockResolvedValueOnce(session);

    const { getByText, getByTestId } = render(<ConversationScreen />);
    await waitFor(() => expect(getByText('Tap to speak')).toBeTruthy());

    await act(async () => {
      fireEvent.press(getByTestId('conversation-mic-button'));
      await flushPromises();
    });

    await waitFor(() => expect(getByText('Tap to send')).toBeTruthy());
    expect(getByTestId('conversation-voice-send-button')).toBeTruthy();
  });

  it('transcribes and fills input instead of auto-sending', async () => {
    const session = mockFullSession({ messages: [] });
    cloudClient.getSession.mockResolvedValueOnce(session);
    mockUploadAsync.mockResolvedValueOnce({
      status: 200, headers: {}, body: JSON.stringify({ transcript: 'Hello from voice' }),
    });

    const { getByText, getByTestId, getByPlaceholderText, getByDisplayValue } = render(<ConversationScreen />);
    await waitFor(() => expect(getByText('Tap to speak')).toBeTruthy());

    await recordAndFinish(getByTestId);

    await waitFor(() => {
      expect(mockUploadAsync).toHaveBeenCalled();
    });
    expect(mockUploadAsync).toHaveBeenCalledWith(
      'https://mock-cloud.test/api/voice/transcribe?sessionId=session-voice-1&durationMs=1000',
      'file:///tmp/test-audio.m4a',
      expect.objectContaining({
        httpMethod: 'POST',
        headers: expect.objectContaining({
          Authorization: 'Bearer mock-token',
          'Content-Type': 'audio/mp4',
        }),
      }),
    );

    // Should switch to text mode and fill input, not auto-send
    await waitFor(() => {
      expect(getByDisplayValue('Hello from voice')).toBeTruthy();
    });
    expect(cloudClient.createAgentTurnSocket).not.toHaveBeenCalled();
  });

  it('shows "Transcribing..." while processing audio', async () => {
    const session = mockFullSession({ messages: [] });
    cloudClient.getSession.mockResolvedValueOnce(session);

    // Delay upload so we can check intermediate state
    let resolveUpload!: (value: { status: number; headers: Record<string, string>; body: string }) => void;
    mockUploadAsync.mockImplementation(() => new Promise((r) => { resolveUpload = r; }));

    const { getByText, getByTestId } = render(<ConversationScreen />);
    await waitFor(() => expect(getByText('Tap to speak')).toBeTruthy());

    await recordAndFinish(getByTestId);

    // Should show transcribing state
    await waitFor(() => expect(getByText('Transcribing…')).toBeTruthy());

    // Resolve upload
    await act(async () => {
      resolveUpload({ status: 200, headers: {}, body: JSON.stringify({ transcript: 'Done' }) });
      await flushPromises();
    });
  });

  it('shows error when transcription fails', async () => {
    const session = mockFullSession({ messages: [] });
    cloudClient.getSession.mockResolvedValueOnce(session);
    mockUploadAsync.mockRejectedValue(new Error('Network error'));

    const { getByText, getByTestId } = render(<ConversationScreen />);
    await waitFor(() => expect(getByText('Tap to speak')).toBeTruthy());

    await recordAndFinish(getByTestId);

    await waitFor(() => expect(getByText('Transcription failed. Try again.')).toBeTruthy(), { timeout: 5000 });
    expect(cloudClient.createAgentTurnSocket).not.toHaveBeenCalled();
  });

  it('shows error when transcript is empty', async () => {
    const session = mockFullSession({ messages: [] });
    cloudClient.getSession.mockResolvedValueOnce(session);
    mockUploadAsync.mockResolvedValueOnce({
      status: 200, headers: {}, body: JSON.stringify({ transcript: '   ' }),
    });

    const { getByText, getByTestId } = render(<ConversationScreen />);
    await waitFor(() => expect(getByText('Tap to speak')).toBeTruthy());

    await recordAndFinish(getByTestId);

    await waitFor(() => expect(getByText("Didn't catch that. Try again?")).toBeTruthy());
    expect(cloudClient.createAgentTurnSocket).not.toHaveBeenCalled();
  });

  it('fills input with voice transcript for user review', async () => {
    const session = mockFullSession({ messages: [] });
    cloudClient.getSession.mockResolvedValueOnce(session);
    mockUploadAsync.mockResolvedValueOnce({
      status: 200, headers: {}, body: JSON.stringify({ transcript: 'Schedule a meeting' }),
    });

    const { getByText, getByTestId, getByDisplayValue, getByLabelText } = render(<ConversationScreen />);
    await waitFor(() => expect(getByText('Tap to speak')).toBeTruthy());

    await recordAndFinish(getByTestId);

    // Transcript should fill the text input (switched to text mode)
    await waitFor(() => expect(getByDisplayValue('Schedule a meeting')).toBeTruthy());
    // Text mode should be active ("Switch to voice" button visible)
    expect(getByLabelText('Switch to voice')).toBeTruthy();
  });

  it('switches to text mode and back', async () => {
    const session = mockFullSession({ messages: [] });
    cloudClient.getSession.mockResolvedValueOnce(session);

    const { getByText, getByLabelText, getByPlaceholderText, queryByText } = render(<ConversationScreen />);
    await waitFor(() => expect(getByText('Tap to speak')).toBeTruthy());

    // Switch to text mode
    fireEvent.press(getByLabelText('Switch to typing'));
    expect(getByPlaceholderText('Message Rebel...')).toBeTruthy();
    expect(queryByText('Tap to speak')).toBeNull();

    // Switch back to voice mode
    fireEvent.press(getByLabelText('Switch to voice'));
    await waitFor(() => expect(getByText('Tap to speak')).toBeTruthy());
  });

  it('does not process recording twice', async () => {
    const session = mockFullSession({ messages: [] });
    cloudClient.getSession.mockResolvedValueOnce(session);
    mockUploadAsync.mockResolvedValue({
      status: 200, headers: {}, body: JSON.stringify({ transcript: 'Only once' }),
    });

    const { getByText, getByTestId } = render(<ConversationScreen />);
    await waitFor(() => expect(getByText('Tap to speak')).toBeTruthy());

    await act(async () => {
      fireEvent.press(getByTestId('conversation-mic-button'));
      await flushPromises();
    });

    advanceRecordingTime();

    // Both the status callback and fallback path fire
    await act(async () => {
      mockRecorderUri = 'file:///tmp/test.m4a';
      mockRecordingStatusCallback?.({
        isFinished: true,
        hasError: false,
        url: 'file:///tmp/test.m4a',
      });
      await flushPromises();
    });

    // Fire again (simulates fallback from stopRecording)
    await act(async () => {
      mockRecordingStatusCallback?.({
        isFinished: true,
        hasError: false,
        url: 'file:///tmp/test.m4a',
      });
      await flushPromises();
    });

    // uploadAsync should only be called once, not twice
    expect(mockUploadAsync).toHaveBeenCalledTimes(1);
  });

  it('handles recording error gracefully', async () => {
    const session = mockFullSession({ messages: [] });
    cloudClient.getSession.mockResolvedValueOnce(session);

    const { getByText, getByTestId } = render(<ConversationScreen />);
    await waitFor(() => expect(getByText('Tap to speak')).toBeTruthy());

    await act(async () => {
      fireEvent.press(getByTestId('conversation-mic-button'));
      await flushPromises();
    });

    // Simulate recording error
    await act(async () => {
      mockRecordingStatusCallback?.({
        isFinished: false,
        hasError: true,
      });
      await flushPromises();
    });

    await waitFor(() => expect(getByText('Recording failed unexpectedly.')).toBeTruthy());
    expect(mockUploadAsync).not.toHaveBeenCalled();
  });

  it('handles recorder.stop() failure gracefully', async () => {
    const session = mockFullSession({ messages: [] });
    cloudClient.getSession.mockResolvedValueOnce(session);
    mockRecorderStop.mockRejectedValueOnce(new Error('Stop failed'));

    const { getByText, getByTestId } = render(<ConversationScreen />);
    await waitFor(() => expect(getByText('Tap to speak')).toBeTruthy());

    // Start recording
    await act(async () => {
      fireEvent.press(getByTestId('conversation-mic-button'));
      await flushPromises();
    });

    advanceRecordingTime();

    // Stop recording via send button — recorder.stop() will reject
    await act(async () => {
      fireEvent.press(getByTestId('conversation-voice-send-button'));
      await flushPromises();
    });

    await waitFor(() => expect(getByText('Recording failed. Try again.')).toBeTruthy());
    expect(mockUploadAsync).not.toHaveBeenCalled();
  });

  it('shows error when not connected to cloud', async () => {
    const session = mockFullSession({ messages: [] });
    cloudClient.getSession.mockResolvedValueOnce(session);
    useAuthStore.setState({ cloudUrl: null, token: null, isPaired: false });

    const { getByText, getByTestId } = render(<ConversationScreen />);
    await waitFor(() => expect(getByText('Tap to speak')).toBeTruthy());

    await recordAndFinish(getByTestId);

    await waitFor(() => expect(getByText('Not connected to cloud.')).toBeTruthy());
    expect(mockUploadAsync).not.toHaveBeenCalled();
  });

  it('fires centralized unauthorized handler on 401 response from transcription', async () => {
    const session = mockFullSession({ messages: [] });
    cloudClient.getSession.mockResolvedValueOnce(session);
    mockUploadAsync.mockResolvedValueOnce({ status: 401, headers: {}, body: '{"error":"Unauthorized"}' });

    const { getByText, getByTestId } = render(<ConversationScreen />);
    await waitFor(() => expect(getByText('Tap to speak')).toBeTruthy());

    await recordAndFinish(getByTestId);

    await waitFor(() => expect(getByText('Session expired. Please re-pair.')).toBeTruthy());
    expect(cloudClient.fireUnauthorized).toHaveBeenCalled();
  });

  it('shows error on non-2xx server response', async () => {
    const session = mockFullSession({ messages: [] });
    cloudClient.getSession.mockResolvedValueOnce(session);
    mockUploadAsync.mockResolvedValue({ status: 500, headers: {}, body: '{"error":"Internal error"}' });

    const { getByText, getByTestId } = render(<ConversationScreen />);
    await waitFor(() => expect(getByText('Tap to speak')).toBeTruthy());

    await recordAndFinish(getByTestId);

    await waitFor(() => expect(getByText('Transcription failed. Try again.')).toBeTruthy(), { timeout: 5000 });
  });

  it('retries a transient 404 in the direct-upload fallback instead of failing fast', async () => {
    // REBEL-6BJ / FOX-3516 regression guard: a 404 (deploy window / version
    // skew on /api/voice/transcribe) must be retried, not treated as a
    // permanent failure that drops the recording. First attempt 404, retry
    // succeeds with a transcript.
    const session = mockFullSession({ messages: [] });
    cloudClient.getSession.mockResolvedValueOnce(session);
    mockUploadAsync
      .mockResolvedValueOnce({ status: 404, headers: {}, body: '{"error":"Not found"}' })
      .mockResolvedValueOnce({
        status: 200, headers: {}, body: JSON.stringify({ transcript: 'Recovered after 404' }),
      });

    const { getByText, getByTestId, getByDisplayValue } = render(<ConversationScreen />);
    await waitFor(() => expect(getByText('Tap to speak')).toBeTruthy());

    await recordAndFinish(getByTestId);

    // Retried (called twice) and ultimately succeeded.
    await waitFor(() => expect(mockUploadAsync).toHaveBeenCalledTimes(2), { timeout: 5000 });
    await waitFor(() => expect(getByDisplayValue('Recovered after 404')).toBeTruthy(), { timeout: 5000 });
  });

  it('does not retry a permanent 400 in the direct-upload fallback', async () => {
    // 400 (malformed request) is genuinely permanent — re-sending the same
    // bytes cannot succeed, so it must fail fast without a retry.
    const session = mockFullSession({ messages: [] });
    cloudClient.getSession.mockResolvedValueOnce(session);
    mockUploadAsync.mockResolvedValue({ status: 400, headers: {}, body: '{"error":"Bad request"}' });

    const { getByText, getByTestId } = render(<ConversationScreen />);
    await waitFor(() => expect(getByText('Tap to speak')).toBeTruthy());

    await recordAndFinish(getByTestId);

    await waitFor(() => expect(getByText('Transcription failed. Try again.')).toBeTruthy(), { timeout: 5000 });
    // Permanent → no retry: exactly one upload attempt.
    expect(mockUploadAsync).toHaveBeenCalledTimes(1);
  });

  it('auto-starts recording when autoRecord=true is in URL params', async () => {
    mockSearchParams = { id: 'session-auto-1', autoRecord: 'true' };
    const session = mockFullSession({ id: 'session-auto-1', messages: [] });
    cloudClient.getSession.mockResolvedValueOnce(session);

    render(<ConversationScreen />);

    // The mount effect should auto-start recording
    await waitFor(() => {
      expect(mockRecorderPrepare).toHaveBeenCalled();
      expect(mockRecorderRecord).toHaveBeenCalled();
    });
  });

  it('shows "Edit first" button during recording that triggers edit flow', async () => {
    const session = mockFullSession({ messages: [] });
    cloudClient.getSession.mockResolvedValueOnce(session);
    mockUploadAsync.mockResolvedValueOnce({
      status: 200, headers: {}, body: JSON.stringify({ transcript: 'Edit me please' }),
    });

    const { getByText, getByTestId, getByDisplayValue } = render(<ConversationScreen />);
    await waitFor(() => expect(getByText('Tap to speak')).toBeTruthy());

    // Start recording
    await act(async () => {
      fireEvent.press(getByTestId('conversation-mic-button'));
      await flushPromises();
    });

    // Verify edit button is visible during recording
    expect(getByTestId('conversation-voice-edit-button')).toBeTruthy();
    expect(getByText('Edit first')).toBeTruthy();

    advanceRecordingTime();

    // Press "Edit first" to stop and edit
    await act(async () => {
      fireEvent.press(getByTestId('conversation-voice-edit-button'));
      await flushPromises();
    });

    // Simulate recording finished
    await act(async () => {
      mockRecorderUri = 'file:///tmp/test-edit.m4a';
      mockRecordingStatusCallback?.({
        isFinished: true,
        hasError: false,
        url: 'file:///tmp/test-edit.m4a',
      });
      await flushPromises();
    });

    // Should switch to text mode and fill input (edit intent), not auto-send
    await waitFor(() => {
      expect(getByDisplayValue('Edit me please')).toBeTruthy();
    });
    expect(cloudClient.createAgentTurnSocket).not.toHaveBeenCalled();
  });

  it('sends transcript immediately when "Send" button is pressed during recording', async () => {
    const session = mockFullSession({ messages: [] });
    cloudClient.getSession.mockResolvedValueOnce(session);
    mockUploadAsync.mockResolvedValueOnce({
      status: 200, headers: {}, body: JSON.stringify({ transcript: 'Send this now' }),
    });

    const { getByText, getByTestId } = render(<ConversationScreen />);
    await waitFor(() => expect(getByText('Tap to speak')).toBeTruthy());

    // Start recording
    await act(async () => {
      fireEvent.press(getByTestId('conversation-mic-button'));
      await flushPromises();
    });

    advanceRecordingTime();

    // Press "Send" button to stop and send immediately
    await act(async () => {
      fireEvent.press(getByTestId('conversation-voice-send-button'));
      await flushPromises();
    });

    // Simulate recording finished
    await act(async () => {
      mockRecorderUri = 'file:///tmp/test-send.m4a';
      mockRecordingStatusCallback?.({
        isFinished: true,
        hasError: false,
        url: 'file:///tmp/test-send.m4a',
      });
      await flushPromises();
    });

    // Should auto-send (create agent turn socket), not put text in input
    await waitFor(() => {
      expect(cloudClient.createAgentTurnSocket).toHaveBeenCalledTimes(1);
      expect(cloudClient.createAgentTurnSocket).toHaveBeenCalledWith(
        expect.objectContaining({ prompt: 'Send this now' }),
        expect.any(Function),
        expect.anything(),
        expect.any(Function),
      );
    });
  });

  it('starts in text mode when compose=text param is set', async () => {
    mockSearchParams = { id: 'session-text-1', compose: 'text' };

    const { getByPlaceholderText, queryByText } = render(<ConversationScreen />);

    // Should show text input immediately without recording
    await waitFor(() => {
      expect(getByPlaceholderText('Message Rebel...')).toBeTruthy();
    });
    // Voice hint should not be visible
    expect(queryByText('Tap to speak')).toBeNull();
    // Should not auto-start recording
    expect(mockRecorderPrepare).not.toHaveBeenCalled();
    expect(mockRecorderRecord).not.toHaveBeenCalled();
    // Should not fetch session (it doesn't exist yet)
    expect(cloudClient.getSession).not.toHaveBeenCalled();
  });
});
