import React from 'react';
import { fireEvent, render, waitFor } from '@testing-library/react-native';

const mockSubmitFeedback = jest.fn().mockResolvedValue({ success: true });
const mockEnqueueWithJsonPayload = jest.fn().mockResolvedValue({ id: 'feedback-item' });
const mockLoadJsonPayload = jest.fn().mockResolvedValue(null);
const mockDrain = jest.fn().mockResolvedValue(undefined);
// Mutable queue items the selector hook reads each render. Tests push a
// permanently-failed item to exercise the delivery-unavailable UI.
let mockQueueItems: Array<{ id: string; isPermanentFailure: boolean }> = [];
const mockGetSelfDiagnostics = jest.fn().mockResolvedValue({ manifest: { source: 'cloud' } });
const mockGetSettings = jest.fn();
const mockIpcCall = jest.fn().mockResolvedValue({});
const mockGatherMobileDiagnostics = jest.fn().mockResolvedValue({
  deviceInfo: { platform: 'ios' },
  filteredLogs: 'ok',
  logLineCount: 1,
});

jest.mock('react-native-reanimated', () => {
  const Reanimated = require('react-native-reanimated/mock');
  Reanimated.default.call = () => {};
  return Reanimated;
});

jest.mock('@expo/vector-icons', () => {
  const { Text } = require('react-native');
  return { Feather: ({ name }: { name: string }) => <Text>{name}</Text> };
});

jest.mock('expo-constants', () => ({
  expoConfig: { version: '1.0.0', runtimeVersion: '1.0.0' },
  platform: { ios: { buildNumber: '1' } },
}));

jest.mock('@react-navigation/bottom-tabs', () => ({
  useBottomTabBarHeight: () => 0,
}));

jest.mock('expo-router', () => ({
  useLocalSearchParams: () => ({}),
}));

jest.mock('@rebel/cloud-client', () => ({
  // Pure live-meeting id casts (zero-import module) so a future pure cast added
  // there needs no mock edit. See meetingRecordingContext.test.tsx for rationale.
  ...(jest.requireActual('../../../cloud-client/src/types/liveMeetingIds') as typeof import('../../../cloud-client/src/types/liveMeetingIds')),
  useAuthStore: Object.assign(
    () => ({ cloudUrl: 'https://cloud.example', unpair: jest.fn() }),
    { getState: () => ({ cloudUrl: 'https://cloud.example' }) },
  ),
  useSessionStore: { getState: () => ({ resetStore: jest.fn() }) },
  useInboxStore: { getState: () => ({ resetStore: jest.fn() }) },
  useApprovalStore: { getState: () => ({ resetStore: jest.fn() }) },
  useStagedFilesStore: { getState: () => ({ resetStore: jest.fn() }) },
  // Callable selector hook (the help screen watches the tracked report's
  // permanent-failure flag) plus the static getState used by the submit handler.
  useOfflineQueueStore: Object.assign(
    (selector?: (state: { items: unknown[] }) => unknown) =>
      selector ? selector({ items: mockQueueItems }) : { items: mockQueueItems },
    {
      getState: () => ({
        clearAll: jest.fn(),
        enqueueWithJsonPayloadOrThrow: (...args: unknown[]) => mockEnqueueWithJsonPayload(...args),
        loadJsonPayload: (...args: unknown[]) => mockLoadJsonPayload(...args),
        drain: (...args: unknown[]) => mockDrain(...args),
      }),
    },
  ),
  QueueFullError: class QueueFullError extends Error {},
  checkHealth: jest.fn().mockResolvedValue({ version: '1.0.0' }),
  submitFeedback: (...args: unknown[]) => mockSubmitFeedback(...args),
  getSelfDiagnostics: (...args: unknown[]) => mockGetSelfDiagnostics(...args),
  getSettings: (...args: unknown[]) => mockGetSettings(...args),
  ipcCall: (...args: unknown[]) => mockIpcCall(...args),
  clearKeysForPrefix: jest.fn().mockResolvedValue(undefined),
  buildCacheKeyPrefix: jest.fn(() => 'cache:'),
  createLogger: jest.fn(() => ({
    info: jest.fn(),
    warn: jest.fn(),
    debug: jest.fn(),
    error: jest.fn(),
  })),
}));

jest.mock('../stores/activeRecordingStore', () => ({
  useActiveRecordingStore: () => false,
}));

jest.mock('../hooks/useMobileVoiceRecording', () => ({
  useMobileVoiceRecording: () => ({
    isRecording: false,
    isTranscribing: false,
    startRecording: jest.fn(),
    stopRecording: jest.fn(),
    error: null,
  }),
}));

jest.mock('../hooks/usePulseAnimation', () => ({
  usePulseAnimation: () => ({}),
}));

jest.mock('../utils/haptics', () => ({
  hapticLight: jest.fn(),
  hapticSuccess: jest.fn(),
}));

jest.mock('../utils/mobileDiagnostics', () => ({
  gatherMobileDiagnostics: (...args: unknown[]) => mockGatherMobileDiagnostics(...args),
}));

jest.mock('../utils/diagnosticExport', () => ({
  prepareDiagnosticSharePayload: jest.fn().mockResolvedValue({ markdownFallback: 'diagnostics' }),
}));

jest.mock('../components/MobileModelDownloadCard', () => {
  const { View } = require('react-native');
  return { MobileModelDownloadCard: () => <View /> };
});

jest.mock('../services/widgetDataSync', () => ({ clearWidgetData: jest.fn() }));
jest.mock('../services/widgetBackgroundRefresh', () => ({ unregisterWidgetBackgroundRefresh: jest.fn() }));

import HelpScreen from '../../app/(tabs)/help';
import { QueueFullError } from '@rebel/cloud-client';

describe('HelpScreen diagnostic section toggles', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockQueueItems = [];
    mockEnqueueWithJsonPayload.mockResolvedValue({ id: 'feedback-item' });
    mockLoadJsonPayload.mockResolvedValue(null);
    mockGetSettings.mockResolvedValue({
      meetingBot: {
        triggerPhrase: 'Spark',
      },
    });
  });

  it('passes per-bundle diagnosticSections to mobile and cloud feedback payloads', async () => {
    const screen = render(<HelpScreen />);

    fireEvent.changeText(screen.getByTestId('help-feedback-message-input'), 'Something broke');
    fireEvent.press(screen.getByTestId('help-feedback-type-bug-button'));
    fireEvent(
      screen.getByTestId('help-diagnostic-section-settings_drift-switch'),
      'valueChange',
      false,
    );
    fireEvent(
      screen.getByTestId('help-feedback-server-context-switch'),
      'valueChange',
      true,
    );
    fireEvent.press(screen.getByTestId('help-feedback-submit-button'));

    // The report is now durably ENQUEUED (persist-before-accept) rather than
    // submitted directly; the per-bundle diagnosticSections must flow into the
    // persisted payload, and the mobile + cloud enrichment is still gathered.
    await waitFor(() => expect(mockEnqueueWithJsonPayload).toHaveBeenCalled());
    expect(mockGatherMobileDiagnostics).toHaveBeenCalledWith({
      diagnosticSections: expect.objectContaining({ settings_drift: false }),
    });
    expect(mockGetSelfDiagnostics).toHaveBeenCalledWith({
      include: expect.objectContaining({ settings_drift: false }),
    });
    expect(mockEnqueueWithJsonPayload).toHaveBeenCalledWith(
      'feedback',
      expect.objectContaining({
        diagnosticSections: expect.objectContaining({ settings_drift: false }),
        // Idempotency keys are minted and persisted with the report.
        clientReportId: expect.any(String),
        eventId: expect.stringMatching(/^[0-9a-f]{32}$/),
      }),
      expect.any(Object),
      expect.anything(),
    );
  });

  it('surfaces an honest delivery-unavailable card (with Copy report) when the report permanently fails', async () => {
    // The enqueued item is already terminalized (e.g. 422 = cloud Sentry
    // unconfigured) and its payload is retained on disk for the Copy fallback.
    mockQueueItems = [{ id: 'feedback-item', isPermanentFailure: true }];
    mockLoadJsonPayload.mockResolvedValue({
      message: 'Something broke',
      feedbackType: 'bug',
      urgency: 'medium',
      platform: 'ios',
    });

    const screen = render(<HelpScreen />);
    fireEvent.changeText(screen.getByTestId('help-feedback-message-input'), 'Something broke');
    fireEvent.press(screen.getByTestId('help-feedback-submit-button'));

    // The honest delivery-unavailable card renders off the permanent-failure flag
    // (NOT off the payload load), and the Copy-report action appears once the
    // retained payload is read back.
    await waitFor(() => expect(screen.getByTestId('help-feedback-delivery-unavailable')).toBeTruthy());
    await waitFor(() => expect(screen.getByTestId('help-feedback-copy-report-button')).toBeTruthy());
  });

  it('shows an honest "could not save" error (no false receipt) when the queue is full', async () => {
    mockEnqueueWithJsonPayload.mockRejectedValueOnce(new QueueFullError(100));

    const screen = render(<HelpScreen />);
    fireEvent.changeText(screen.getByTestId('help-feedback-message-input'), 'Something broke');
    fireEvent.press(screen.getByTestId('help-feedback-submit-button'));

    await waitFor(() => expect(screen.getByTestId('help-feedback-submit-error')).toBeTruthy());
    // Never claims success on a failed durable save.
    expect(screen.queryByTestId('help-feedback-success')).toBeNull();
  });

  it('renders the meetings toggle and persists local recording trigger preference', async () => {
    const screen = render(<HelpScreen />);

    const triggerSwitch = await screen.findByTestId('help-meetings-local-recording-trigger-switch');
    expect(triggerSwitch.props.value).toBe(true);

    fireEvent(triggerSwitch, 'valueChange', false);

    await waitFor(() =>
      expect(mockIpcCall).toHaveBeenCalledWith(
        'settings:update',
        expect.objectContaining({
          meetingBot: expect.objectContaining({
            localRecordingTriggerListening: false,
          }),
        }),
      ),
    );
  });
});
