/**
 * PendingRecordingsList + PendingRecordingRow component tests.
 * Tests rendering, expand/collapse, actions, and the per-session indicator.
 */

import React from 'react';
import { render, fireEvent, waitFor, act } from '@testing-library/react-native';
import { Alert } from 'react-native';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

jest.mock('expo-router', () => ({
  useRouter: () => ({ push: jest.fn() }),
}));

jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 44, bottom: 34, left: 0, right: 0 }),
}));

jest.mock('expo-audio', () => ({
  createAudioPlayer: jest.fn(() => ({
    play: jest.fn(),
    pause: jest.fn(),
    remove: jest.fn(),
    addListener: jest.fn(),
  })),
  setAudioModeAsync: jest.fn().mockResolvedValue(undefined),
}));

// Mock cloudClient to avoid network calls
jest.mock('../../../cloud-client/src/cloudClient', () => ({
  getSessions: jest.fn().mockResolvedValue({ sessions: [], totalCount: 0 }),
  getSession: jest.fn(),
}));

// ---------------------------------------------------------------------------
// Store access
// ---------------------------------------------------------------------------

const { useOfflineQueueStore, useSessionStore, initOfflineQueueStore } = require('@rebel/cloud-client');
const { _resetOfflineQueueStore } = require('../../../cloud-client/src/offlineQueue/offlineQueueStore');

function createMockStorage() {
  return {
    saveSnapshot: jest.fn().mockResolvedValue(undefined),
    loadSnapshot: jest.fn().mockResolvedValue([]),
    savePayloadFromUri: jest.fn().mockResolvedValue('file:///mock/payload.m4a'),
    getPayloadUri: jest.fn().mockResolvedValue('file:///mock/payload.m4a'),
    deletePayload: jest.fn().mockResolvedValue(undefined),
    listPayloadIds: jest.fn().mockResolvedValue([]),
  };
}

function mockConsumer() {
  return jest.fn().mockResolvedValue({ success: true });
}

// ---------------------------------------------------------------------------
// Imports (after mocks)
// ---------------------------------------------------------------------------

import { PendingRecordingsList } from '../components/PendingRecordingsList';
import { PendingRecordingRow } from '../components/PendingRecordingRow';
import type { QueueItem } from '@rebel/cloud-client';

// ---------------------------------------------------------------------------
// Test data
// ---------------------------------------------------------------------------

function createQueueItem(overrides: Partial<QueueItem> = {}): QueueItem {
  return {
    id: `item-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    type: 'voice-transcription',
    status: 'pending',
    enqueuedAt: Date.now() - 120_000, // 2 min ago
    attempts: 0,
    nextRetryAt: 0,
    isPermanentFailure: false,
    payloadUri: 'file:///mock/recording.m4a',
    payloadExt: 'm4a',
    metadata: {
      sessionId: 'session-1',
      durationMs: 12_000,
      mimeType: 'audio/mp4',
    },
    ...overrides,
  };
}

function createTextQueueItem(overrides: Partial<QueueItem> = {}): QueueItem {
  return {
    id: `text-item-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    type: 'text-message',
    status: 'pending',
    enqueuedAt: Date.now() - 120_000,
    attempts: 0,
    nextRetryAt: 0,
    isPermanentFailure: false,
    metadata: {
      sessionId: 'session-1',
      prompt: 'Queued text',
    },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

beforeEach(() => {
  _resetOfflineQueueStore();
  initOfflineQueueStore(createMockStorage(), mockConsumer());

  useSessionStore.setState({
    sessions: [
      { id: 'session-1', title: 'Planning Meeting' },
      { id: 'session-2', title: 'Weekly Sync' },
    ],
    isLoading: false,
    error: null,
  });
});

afterEach(() => {
  _resetOfflineQueueStore();
});

// ---------------------------------------------------------------------------
// PendingRecordingRow tests
// ---------------------------------------------------------------------------

describe('PendingRecordingRow', () => {
  it('renders duration, session name, and status', () => {
    const item = createQueueItem({
      id: 'row-1',
      metadata: { sessionId: 'session-1', durationMs: 12_000 },
    });

    const { getByText } = render(
      <PendingRecordingRow
        item={item}
        sessionName="Planning Meeting"
        isPlaying={false}
        onTogglePlay={jest.fn()}
        onRetry={jest.fn()}
        onDelete={jest.fn()}
      />,
    );

    expect(getByText('0:12')).toBeTruthy();
    expect(getByText('Planning Meeting')).toBeTruthy();
    expect(getByText('Waiting in line')).toBeTruthy();
  });

  it('shows "New conversation" when sessionName is null', () => {
    const item = createQueueItem({
      id: 'row-2',
      metadata: { sessionId: null, durationMs: 5_000 },
    });

    const { getByText } = render(
      <PendingRecordingRow
        item={item}
        sessionName={null}
        isPlaying={false}
        onTogglePlay={jest.fn()}
        onRetry={jest.fn()}
        onDelete={jest.fn()}
      />,
    );

    expect(getByText('New conversation')).toBeTruthy();
  });

  it('shows "Paused — will retry shortly" status for failed-transient items', () => {
    const item = createQueueItem({
      id: 'row-3',
      lastError: 'Network error',
    });

    const { getByText, getByTestId } = render(
      <PendingRecordingRow
        item={item}
        sessionName="Planning Meeting"
        isPlaying={false}
        onTogglePlay={jest.fn()}
        onRetry={jest.fn()}
        onDelete={jest.fn()}
      />,
    );

    expect(getByText('Paused — will retry shortly')).toBeTruthy();
    // Retry button should be visible
    expect(getByTestId('pending-recording-retry-row-3')).toBeTruthy();
  });

  it('shows a calm generic retry prompt for a permanent failure with no errorCategory', () => {
    const item = createQueueItem({
      id: 'row-4',
      isPermanentFailure: true,
      lastError: 'Something went wrong',
    });

    const { getByText } = render(
      <PendingRecordingRow
        item={item}
        sessionName="Planning Meeting"
        isPlaying={false}
        onTogglePlay={jest.fn()}
        onRetry={jest.fn()}
        onDelete={jest.fn()}
      />,
    );

    expect(getByText("Couldn't send — tap retry")).toBeTruthy();
  });

  it('shows "this recording couldn\'t be processed" for genuine permanent (bad-input) failures', () => {
    const item = createQueueItem({
      id: 'row-permanent',
      isPermanentFailure: true,
      lastError: 'Unsupported audio format',
      errorCategory: 'permanent',
    });

    const { getByText } = render(
      <PendingRecordingRow
        item={item}
        sessionName="Planning Meeting"
        isPlaying={false}
        onTogglePlay={jest.fn()}
        onRetry={jest.fn()}
        onDelete={jest.fn()}
      />,
    );

    expect(getByText("This recording couldn't be processed")).toBeTruthy();
  });

  it.each(['temporary', 'network'] as const)(
    'shows a connection-trouble retry prompt for retry-exhausted %s failures',
    (errorCategory) => {
      const item = createQueueItem({
        id: `row-${errorCategory}`,
        isPermanentFailure: true,
        lastError: 'Gave up after retries',
        errorCategory,
      });

      const { getByText } = render(
        <PendingRecordingRow
          item={item}
          sessionName="Planning Meeting"
          isPlaying={false}
          onTogglePlay={jest.fn()}
          onRetry={jest.fn()}
          onDelete={jest.fn()}
        />,
      );

      expect(getByText("Couldn't send to the cloud — tap retry")).toBeTruthy();
    },
  );

  it('shows a "ran out of time" retry prompt for timeout (stale-sweep) failures', () => {
    const item = createQueueItem({
      id: 'row-timeout',
      isPermanentFailure: true,
      lastError: 'Stale sweep',
      errorCategory: 'timeout',
    });

    const { getByText } = render(
      <PendingRecordingRow
        item={item}
        sessionName="Planning Meeting"
        isPlaying={false}
        onTogglePlay={jest.fn()}
        onRetry={jest.fn()}
        onDelete={jest.fn()}
      />,
    );

    expect(getByText("Couldn't send this in time — tap retry")).toBeTruthy();
  });

  it('shows voice settings guidance for provider auth failures', () => {
    const item = createQueueItem({
      id: 'row-provider-auth',
      isPermanentFailure: true,
      lastError: "Your voice API key isn't working.",
      errorCategory: 'provider-auth',
    });

    const { getByText } = render(
      <PendingRecordingRow
        item={item}
        sessionName="Planning Meeting"
        isPlaying={false}
        onTogglePlay={jest.fn()}
        onRetry={jest.fn()}
        onDelete={jest.fn()}
      />,
    );

    expect(getByText('Check voice settings')).toBeTruthy();
  });

  it('shows reconnect guidance for terminalized cloud-auth (auth) failures', () => {
    const item = createQueueItem({
      id: 'row-auth',
      isPermanentFailure: true,
      lastError: 'Authentication expired',
      errorCategory: 'auth',
    });

    const { getByText } = render(
      <PendingRecordingRow
        item={item}
        sessionName="Planning Meeting"
        isPlaying={false}
        onTogglePlay={jest.fn()}
        onRetry={jest.fn()}
        onDelete={jest.fn()}
      />,
    );

    expect(getByText('Reconnect to send')).toBeTruthy();
  });

  it('shows billing guidance for voice provider billing failures', () => {
    const item = createQueueItem({
      id: 'row-billing',
      isPermanentFailure: true,
      lastError: 'Your voice provider account has run out of credits.',
      errorCategory: 'billing',
    });

    const { getByText } = render(
      <PendingRecordingRow
        item={item}
        sessionName="Planning Meeting"
        isPlaying={false}
        onTogglePlay={jest.fn()}
        onRetry={jest.fn()}
        onDelete={jest.fn()}
      />,
    );

    expect(getByText('Check voice billing')).toBeTruthy();
  });

  it('shows "Sending…" for processing items', () => {
    const item = createQueueItem({
      id: 'row-5',
      status: 'processing',
    });

    const { getByText } = render(
      <PendingRecordingRow
        item={item}
        sessionName="Planning Meeting"
        isPlaying={false}
        onTogglePlay={jest.fn()}
        onRetry={jest.fn()}
        onDelete={jest.fn()}
      />,
    );

    expect(getByText('Sending…')).toBeTruthy();
  });

  it('calls onTogglePlay when play button is pressed', () => {
    const onTogglePlay = jest.fn();
    const item = createQueueItem({ id: 'row-6' });

    const { getByTestId } = render(
      <PendingRecordingRow
        item={item}
        sessionName="Planning Meeting"
        isPlaying={false}
        onTogglePlay={onTogglePlay}
        onRetry={jest.fn()}
        onDelete={jest.fn()}
      />,
    );

    fireEvent.press(getByTestId('pending-recording-play-row-6'));
    expect(onTogglePlay).toHaveBeenCalledWith('row-6', 'file:///mock/recording.m4a');
  });

  it('calls onDelete when delete button is pressed', () => {
    const onDelete = jest.fn();
    const item = createQueueItem({ id: 'row-7' });

    const { getByTestId } = render(
      <PendingRecordingRow
        item={item}
        sessionName="Planning Meeting"
        isPlaying={false}
        onTogglePlay={jest.fn()}
        onRetry={jest.fn()}
        onDelete={onDelete}
      />,
    );

    fireEvent.press(getByTestId('pending-recording-delete-row-7'));
    expect(onDelete).toHaveBeenCalledWith('row-7');
  });

  it('calls onRetry when retry button is pressed on failed item', () => {
    const onRetry = jest.fn();
    const item = createQueueItem({ id: 'row-8', lastError: 'Network error' });

    const { getByTestId } = render(
      <PendingRecordingRow
        item={item}
        sessionName="Planning Meeting"
        isPlaying={false}
        onTogglePlay={jest.fn()}
        onRetry={onRetry}
        onDelete={jest.fn()}
      />,
    );

    fireEvent.press(getByTestId('pending-recording-retry-row-8'));
    expect(onRetry).toHaveBeenCalledWith('row-8');
  });
});

// ---------------------------------------------------------------------------
// PendingRecordingsList tests
// ---------------------------------------------------------------------------

describe('PendingRecordingsList', () => {
  it('renders nothing when queue only has text-message items', async () => {
    const storage = createMockStorage();
    storage.loadSnapshot.mockResolvedValue([
      createTextQueueItem({ id: 'text-only-1' }),
    ]);

    _resetOfflineQueueStore();
    initOfflineQueueStore(storage, mockConsumer());

    await act(async () => {
      await useOfflineQueueStore.getState().init();
    });

    const { queryByTestId } = render(<PendingRecordingsList />);
    expect(queryByTestId('pending-recordings-section')).toBeNull();
  });

  it('counts only voice items when queue contains mixed types', async () => {
    const storage = createMockStorage();
    storage.loadSnapshot.mockResolvedValue([
      createQueueItem({ id: 'voice-1', metadata: { sessionId: 'session-1', durationMs: 5000 } }),
      createTextQueueItem({ id: 'text-1' }),
    ]);

    _resetOfflineQueueStore();
    initOfflineQueueStore(storage, mockConsumer());

    await act(async () => {
      await useOfflineQueueStore.getState().init();
    });

    const { getByText } = render(<PendingRecordingsList />);
    expect(getByText('1 recording waiting in the wings')).toBeTruthy();
  });

  it('renders nothing when queue is empty', async () => {
    await act(async () => {
      await useOfflineQueueStore.getState().init();
    });

    const { queryByTestId } = render(<PendingRecordingsList />);
    expect(queryByTestId('pending-recordings-section')).toBeNull();
  });

  it('renders collapsed summary with correct count', async () => {
    const storage = createMockStorage();
    const items = [
      createQueueItem({ id: 'a', metadata: { sessionId: 'session-1', durationMs: 5000 } }),
      createQueueItem({ id: 'b', metadata: { sessionId: 'session-2', durationMs: 8000 } }),
    ];
    storage.loadSnapshot.mockResolvedValue(items);

    _resetOfflineQueueStore();
    initOfflineQueueStore(storage, mockConsumer());

    await act(async () => {
      await useOfflineQueueStore.getState().init();
    });

    const { getByText, getByTestId } = render(<PendingRecordingsList />);

    expect(getByTestId('pending-recordings-section')).toBeTruthy();
    expect(getByText('2 recordings waiting in the wings')).toBeTruthy();
  });

  it('renders singular text for a single recording', async () => {
    const storage = createMockStorage();
    const items = [
      createQueueItem({ id: 'single', metadata: { sessionId: 'session-1', durationMs: 3000 } }),
    ];
    storage.loadSnapshot.mockResolvedValue(items);

    _resetOfflineQueueStore();
    initOfflineQueueStore(storage, mockConsumer());

    await act(async () => {
      await useOfflineQueueStore.getState().init();
    });

    const { getByText } = render(<PendingRecordingsList />);
    expect(getByText('1 recording waiting in the wings')).toBeTruthy();
  });

  it('expands and shows recording rows when toggle is pressed', async () => {
    const storage = createMockStorage();
    const items = [
      createQueueItem({ id: 'expand-1', metadata: { sessionId: 'session-1', durationMs: 12000 } }),
    ];
    storage.loadSnapshot.mockResolvedValue(items);

    _resetOfflineQueueStore();
    initOfflineQueueStore(storage, mockConsumer());

    await act(async () => {
      await useOfflineQueueStore.getState().init();
    });

    const { getByTestId } = render(<PendingRecordingsList />);

    // Toggle expand
    fireEvent.press(getByTestId('pending-recordings-toggle'));

    // Should show the recording row
    await waitFor(() => {
      expect(getByTestId('pending-recording-row-expand-1')).toBeTruthy();
    });
  });

  it('shows session names from session store', async () => {
    const storage = createMockStorage();
    const items = [
      createQueueItem({ id: 'name-1', metadata: { sessionId: 'session-1', durationMs: 5000 } }),
    ];
    storage.loadSnapshot.mockResolvedValue(items);

    _resetOfflineQueueStore();
    initOfflineQueueStore(storage, mockConsumer());

    await act(async () => {
      await useOfflineQueueStore.getState().init();
    });

    const { getByTestId, getByText } = render(<PendingRecordingsList />);

    fireEvent.press(getByTestId('pending-recordings-toggle'));

    await waitFor(() => {
      expect(getByText('Planning Meeting')).toBeTruthy();
    });
  });

  it('shows "Retry all" when there are failed items', async () => {
    const storage = createMockStorage();
    const items = [
      createQueueItem({ id: 'fail-1', lastError: 'Network error', metadata: { sessionId: 'session-1', durationMs: 5000 } }),
    ];
    storage.loadSnapshot.mockResolvedValue(items);

    _resetOfflineQueueStore();
    initOfflineQueueStore(storage, mockConsumer());

    await act(async () => {
      await useOfflineQueueStore.getState().init();
    });

    const { getByTestId, getByText } = render(<PendingRecordingsList />);

    fireEvent.press(getByTestId('pending-recordings-toggle'));

    await waitFor(() => {
      expect(getByText('Retry all')).toBeTruthy();
    });
  });

  it('shows delete confirmation when delete is pressed', async () => {
    const alertSpy = jest.spyOn(Alert, 'alert');

    const storage = createMockStorage();
    const items = [
      createQueueItem({ id: 'del-1', metadata: { sessionId: 'session-1', durationMs: 5000 } }),
    ];
    storage.loadSnapshot.mockResolvedValue(items);

    _resetOfflineQueueStore();
    initOfflineQueueStore(storage, mockConsumer());

    await act(async () => {
      await useOfflineQueueStore.getState().init();
    });

    const { getByTestId } = render(<PendingRecordingsList />);

    // Expand first
    fireEvent.press(getByTestId('pending-recordings-toggle'));

    await waitFor(() => {
      expect(getByTestId('pending-recording-delete-del-1')).toBeTruthy();
    });

    fireEvent.press(getByTestId('pending-recording-delete-del-1'));

    expect(alertSpy).toHaveBeenCalledWith(
      'Delete recording?',
      expect.any(String),
      expect.any(Array),
    );

    alertSpy.mockRestore();
  });

  it('shows clear all confirmation when clear all is pressed', async () => {
    const alertSpy = jest.spyOn(Alert, 'alert');

    const storage = createMockStorage();
    const items = [
      createQueueItem({ id: 'clr-1', metadata: { sessionId: 'session-1', durationMs: 5000 } }),
    ];
    storage.loadSnapshot.mockResolvedValue(items);

    _resetOfflineQueueStore();
    initOfflineQueueStore(storage, mockConsumer());

    await act(async () => {
      await useOfflineQueueStore.getState().init();
    });

    const { getByTestId } = render(<PendingRecordingsList />);

    // Expand first
    fireEvent.press(getByTestId('pending-recordings-toggle'));

    await waitFor(() => {
      expect(getByTestId('pending-recordings-clear-all')).toBeTruthy();
    });

    fireEvent.press(getByTestId('pending-recordings-clear-all'));

    expect(alertSpy).toHaveBeenCalledWith(
      'Clear all recordings?',
      expect.any(String),
      expect.any(Array),
    );

    alertSpy.mockRestore();
  });
});
