/**
 * Meeting recording background behavior tests — verifies that:
 * 1. AppState transitions (background/inactive) do NOT stop recording
 * 2. startRecording calls configureForBackgroundRecording()
 * 3. Cleanup/reset calls configureForIdle()
 */

 

// --- Mock audioSessionManager to track calls ---
const mockConfigureForBackgroundRecording = jest.fn().mockResolvedValue(undefined);
const mockConfigureForIdle = jest.fn().mockResolvedValue(undefined);

jest.mock('../utils/audioSessionManager', () => ({
  configureForBackgroundRecording: (...args: unknown[]) => mockConfigureForBackgroundRecording(...args),
  configureForIdle: (...args: unknown[]) => mockConfigureForIdle(...args),
}));

// --- Mock expo-audio — override useAudioRecorder for status callback capture ---
let recorderStatusCallback: ((status: { isFinished: boolean; hasError: boolean; url?: string }) => void) | null = null;
const mockRecorder = {
  isRecording: false,
  uri: null as string | null,
  record: jest.fn(),
  stop: jest.fn().mockResolvedValue(undefined),
  prepareToRecordAsync: jest.fn().mockResolvedValue(undefined),
};

jest.mock('expo-audio', () => {
  const original = jest.requireActual('../../__mocks__/expo-audio.js');
  return {
    ...original,
    useAudioRecorder: jest.fn((_preset: unknown, onStatus: (status: unknown) => void) => {
      recorderStatusCallback = onStatus;
      return mockRecorder;
    }),
  };
});

// --- Mock expo-file-system/legacy ---
jest.mock('expo-file-system/legacy', () => ({
  getFreeDiskStorageAsync: jest.fn().mockResolvedValue(1024 * 1024 * 1024), // 1GB
  writeAsStringAsync: jest.fn().mockResolvedValue(undefined),
  copyAsync: jest.fn().mockResolvedValue(undefined),
  deleteAsync: jest.fn().mockResolvedValue(undefined),
  makeDirectoryAsync: jest.fn().mockResolvedValue(undefined),
  getInfoAsync: jest.fn().mockResolvedValue({ exists: true, isDirectory: true }),
  readAsStringAsync: jest.fn().mockResolvedValue('{}'),
  documentDirectory: '/mock-documents/',
  cacheDirectory: '/mock-cache/',
  FileSystemUploadType: { BINARY_CONTENT: 0, MULTIPART: 1 },
}));

// --- Mock widgetDataSync ---
const mockSetWidgetRecordingState = jest.fn();
const mockGetWidgetRecordingState = jest.fn<boolean | null, unknown[]>(() => null);

jest.mock('../services/widgetDataSync', () => ({
  setWidgetRecordingState: (...args: unknown[]) => mockSetWidgetRecordingState(...args),
  getWidgetRecordingState: (...args: unknown[]) => mockGetWidgetRecordingState(...args),
}));

// --- Mock @rebel/cloud-client ---
const mockEnqueue = jest.fn().mockResolvedValue(undefined);
const mockEnqueueOrThrow = jest.fn().mockResolvedValue(undefined);
const mockDrain = jest.fn().mockResolvedValue(undefined);

class MockQueueFullError extends Error {
  maxSize: number;
  constructor(maxSize: number) {
    super(`Queue is full (max ${maxSize})`);
    this.name = 'QueueFullError';
    this.maxSize = maxSize;
  }
}

jest.mock('@rebel/cloud-client', () => ({
  // Pull the real, pure live-meeting id casts (zero-import module — does NOT pull
  // in the heavy barrel) so a future pure cast added there needs no mock edit.
  ...(jest.requireActual('../../../cloud-client/src/types/liveMeetingIds') as typeof import('../../../cloud-client/src/types/liveMeetingIds')),
  createLogger: () => ({
    info: jest.fn(),
    warn: jest.fn(),
    debug: jest.fn(),
    error: jest.fn(),
  }),
  useAuthStore: {
    getState: () => ({
      cloudUrl: 'https://mock-cloud.test',
      token: 'mock-token',
    }),
  },
  QueueFullError: MockQueueFullError,
  useOfflineQueueStore: {
    getState: () => ({
      isInitialized: true,
      enqueue: mockEnqueue,
      enqueueOrThrow: mockEnqueueOrThrow,
      drain: mockDrain,
    }),
  },
}));

const mockFetch = jest.fn().mockResolvedValue({
  ok: true,
  status: 201,
  json: async () => ({ sessionId: 'cloud-session-1' }),
});
global.fetch = mockFetch as unknown as typeof fetch;

// --- Mock useNetworkState ---
jest.mock('../hooks/useNetworkState', () => ({
  useNetworkState: () => ({ isOnline: true }),
}));

// --- Mock meetingManifest ---
jest.mock('../utils/meetingManifest', () => ({
  generateMeetingLocalId: jest.fn().mockReturnValue('local-meeting-123'),
  createMeetingManifest: jest.fn().mockResolvedValue(undefined),
  updateMeetingManifest: jest.fn().mockResolvedValue(undefined),
  saveMeetingChunkToDisk: jest.fn().mockResolvedValue('/mock-documents/chunk.m4a'),
}));

// --- Mock @react-native-community/netinfo ---
jest.mock('@react-native-community/netinfo', () => ({
  addEventListener: jest.fn(() => jest.fn()),
  fetch: jest.fn().mockResolvedValue({ isConnected: true }),
}));

import { renderHook, act } from '@testing-library/react-native';
import { AppState, type AppStateStatus } from 'react-native';
import { useMeetingRecording } from '../hooks/useMeetingRecording';
import { useActiveRecordingStore } from '../stores/activeRecordingStore';

// Capture AppState listener via spy
let appStateCallback: ((state: AppStateStatus) => void) | null = null;
const mockSubscription = { remove: jest.fn() };

beforeEach(() => {
  jest.clearAllMocks();
  appStateCallback = null;
  recorderStatusCallback = null;
  mockRecorder.isRecording = false;
  mockRecorder.uri = null;
  mockRecorder.record.mockClear();
  mockRecorder.stop.mockClear();
  mockRecorder.prepareToRecordAsync.mockClear();
  mockConfigureForBackgroundRecording.mockClear();
  mockConfigureForIdle.mockClear();
  mockSetWidgetRecordingState.mockClear();
  mockGetWidgetRecordingState.mockReset();
  mockGetWidgetRecordingState.mockReturnValue(null);
  mockEnqueue.mockClear();
  mockEnqueueOrThrow.mockClear();
  mockDrain.mockClear();
  mockFetch.mockClear();
  mockSubscription.remove.mockClear();
  useActiveRecordingStore.setState({
    isActive: false,
    meetingSessionId: null,
    startTime: null,
    title: null,
    companionSessionId: null,
    cloudSessionId: null,
    recordingNotice: null,
  });

  // Spy on AppState.addEventListener to capture the callback
  jest.spyOn(AppState, 'addEventListener').mockImplementation((event, callback) => {
    if (event === 'change') {
      appStateCallback = callback;
    }
    return mockSubscription;
  });
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe('meeting recording background behavior', () => {
  describe('AppState transitions during recording', () => {
    it('clears stale widget recording flag when app becomes active and hook is idle', async () => {
      const { result } = renderHook(() => useMeetingRecording());

      expect(result.current.state).toBe('idle');
      mockGetWidgetRecordingState.mockReturnValue(true);

      await act(async () => {
        appStateCallback?.('active');
      });

      expect(mockSetWidgetRecordingState).toHaveBeenCalledWith(false);
    });

    it('clears stale widget recording flag on cold-start mount when app is already active and hook is idle', async () => {
      // Simulate the crash-relaunch scenario: AppState is already 'active'
      // when the hook mounts, so no 'change' event will fire — reconciliation
      // MUST run on mount.
      const originalCurrentState = AppState.currentState;
      Object.defineProperty(AppState, 'currentState', {
        configurable: true,
        get: () => 'active',
      });

      mockGetWidgetRecordingState.mockReturnValue(true);
      try {
        renderHook(() => useMeetingRecording());
        expect(mockSetWidgetRecordingState).toHaveBeenCalledWith(false);
      } finally {
        Object.defineProperty(AppState, 'currentState', {
          configurable: true,
          get: () => originalCurrentState,
        });
      }
    });

    it('does NOT reconcile widget on mount when hook is idle but widget flag is already false', async () => {
      const originalCurrentState = AppState.currentState;
      Object.defineProperty(AppState, 'currentState', {
        configurable: true,
        get: () => 'active',
      });

      mockGetWidgetRecordingState.mockReturnValue(false);
      try {
        renderHook(() => useMeetingRecording());
        expect(mockSetWidgetRecordingState).not.toHaveBeenCalled();
      } finally {
        Object.defineProperty(AppState, 'currentState', {
          configurable: true,
          get: () => originalCurrentState,
        });
      }
    });

    it('does NOT stop recording when AppState transitions to background', async () => {
      const { result } = renderHook(() => useMeetingRecording());

      // Start recording
      await act(async () => {
        mockRecorder.isRecording = true;
        await result.current.startRecording('Test Meeting');
      });

      expect(result.current.state).toBe('recording');
      const stopSpy = mockRecorder.stop;
      stopSpy.mockClear();

      // Simulate AppState → background
      await act(async () => {
        appStateCallback?.('background');
      });

      // Recording should NOT have been stopped
      expect(stopSpy).not.toHaveBeenCalled();
      expect(result.current.state).toBe('recording');
    });

    it('does NOT stop recording when AppState transitions to inactive', async () => {
      const { result } = renderHook(() => useMeetingRecording());

      // Start recording
      await act(async () => {
        mockRecorder.isRecording = true;
        await result.current.startRecording('Test Meeting');
      });

      expect(result.current.state).toBe('recording');
      const stopSpy = mockRecorder.stop;
      stopSpy.mockClear();

      // Simulate AppState → inactive
      await act(async () => {
        appStateCallback?.('inactive');
      });

      // Recording should NOT have been stopped
      expect(stopSpy).not.toHaveBeenCalled();
      expect(result.current.state).toBe('recording');
    });

    it('does NOT stop recording on multiple background/inactive/active cycles', async () => {
      const { result } = renderHook(() => useMeetingRecording());

      // Start recording
      await act(async () => {
        mockRecorder.isRecording = true;
        await result.current.startRecording('Test Meeting');
      });

      const stopSpy = mockRecorder.stop;
      stopSpy.mockClear();

      // Simulate realistic cycle: active → inactive → background → active
      await act(async () => { appStateCallback?.('inactive'); });
      await act(async () => { appStateCallback?.('background'); });
      await act(async () => { appStateCallback?.('active'); });

      // Recording should still be active through all transitions
      expect(stopSpy).not.toHaveBeenCalled();
      expect(result.current.state).toBe('recording');
    });
  });

  describe('audio session configuration', () => {
    it('calls configureForBackgroundRecording() when starting a recording', async () => {
      const { result } = renderHook(() => useMeetingRecording());

      await act(async () => {
        mockRecorder.isRecording = true;
        await result.current.startRecording('Test Meeting');
      });

      expect(mockConfigureForBackgroundRecording).toHaveBeenCalledTimes(1);
    });

    it('calls configureForIdle() when resetting to idle after stop', async () => {
      const { result } = renderHook(() => useMeetingRecording());

      // Start recording
      await act(async () => {
        mockRecorder.isRecording = true;
        await result.current.startRecording('Test Meeting');
      });

      mockConfigureForIdle.mockClear();

      // Stop recording — simulate chunk rotation completing
      mockRecorder.uri = 'file:///mock/chunk.m4a';
      await act(async () => {
        mockRecorder.stop.mockImplementationOnce(async () => {
          mockRecorder.isRecording = false;
        });
        result.current.stopRecording();
      });

      // configureForIdle is called in resetToIdle
      expect(mockConfigureForIdle).toHaveBeenCalled();
    });

    it('calls configureForIdle() on unmount cleanup', async () => {
      const { unmount } = renderHook(() => useMeetingRecording());

      mockConfigureForIdle.mockClear();

      // Unmount triggers cleanup
      unmount();

      // configureForIdle is called asynchronously in cleanup via queueMicrotask
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
      });

      expect(mockConfigureForIdle).toHaveBeenCalled();
    });
  });

  describe('eager cloud session creation', () => {
    it('creates cloud meeting session on start tap without blocking recording', async () => {
      const { result } = renderHook(() => useMeetingRecording());

      await act(async () => {
        mockRecorder.isRecording = true;
        await result.current.startRecording('Test Meeting');
      });

      expect(result.current.state).toBe('recording');
      expect(mockFetch).toHaveBeenCalledWith(
        'https://mock-cloud.test/api/meeting/session/create',
        expect.objectContaining({
          method: 'POST',
          headers: expect.objectContaining({
            'X-Idempotency-Key': expect.stringContaining('meeting-local-meeting-123'),
          }),
        }),
      );
      expect(useActiveRecordingStore.getState().cloudSessionId).toBe('cloud-session-1');
    });

    it('shows conflict notice on create-session 409 while keeping recording active', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 409,
        json: async () => ({ error: { code: 'MEETING_SESSION_IDEMPOTENCY_CONFLICT' } }),
      });
      const { result } = renderHook(() => useMeetingRecording());

      await act(async () => {
        mockRecorder.isRecording = true;
        await result.current.startRecording('Test Meeting');
      });

      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
      });

      expect(result.current.state).toBe('recording');
      expect(useActiveRecordingStore.getState().recordingNotice).toBe("Couldn't reuse existing recording — please stop and start a new one");
    });
  });
});
