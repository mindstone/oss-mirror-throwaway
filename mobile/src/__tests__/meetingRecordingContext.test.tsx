import React from 'react';
import { Text } from 'react-native';
import { act, fireEvent, render, waitFor } from '@testing-library/react-native';
import {
  asCloudMeetingSessionId,
  asCompanionConversationId,
  asLocalRecordingId,
  type CompanionConversationId,
} from '@rebel/cloud-client';
import { MeetingRecordingProvider, useMeetingRecordingContext } from '../context/MeetingRecordingContext';
import { useActiveRecordingStore } from '../stores/activeRecordingStore';

const mockUpdateMeetingManifest = jest.fn().mockResolvedValue(null);
const mockStartRecording = jest.fn().mockResolvedValue(true);
const mockStopRecording = jest.fn();

jest.mock('../utils/meetingManifest', () => ({
  updateMeetingManifest: (...args: unknown[]) => mockUpdateMeetingManifest(...args),
}));

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
}));

jest.mock('../hooks/useMeetingRecording', () => ({
  useMeetingRecording: () => ({
    state: 'recording',
    isRecording: true,
    meetingSessionId: 'meeting-local-1',
    error: null,
    startRecording: mockStartRecording,
    stopRecording: mockStopRecording,
  }),
}));

function Probe() {
  const ctx = useMeetingRecordingContext();
  return <Text testID="meeting-cloud-session-id">{ctx.meetingCloudSessionId ?? 'null'}</Text>;
}

function StartRecordingProbe() {
  const ctx = useMeetingRecordingContext();
  return (
    <Text
      testID="start-recording"
      onPress={() => {
        void ctx.startRecording('Meeting Title', 'companion-2');
      }}
    >
      Start recording
    </Text>
  );
}

beforeEach(() => {
  jest.clearAllMocks();
  useActiveRecordingStore.setState({
    isActive: true,
    meetingSessionId: asLocalRecordingId('meeting-local-1'),
    startTime: 123,
    title: 'Meeting',
    companionSessionId: asCompanionConversationId('companion-1'),
    cloudSessionId: asCloudMeetingSessionId('cloud-session-1'),
    recordingNotice: null,
  });
});

describe('MeetingRecordingContext', () => {
  it('exposes meetingCloudSessionId from activeRecordingStore', async () => {
    const result = render(
      <MeetingRecordingProvider>
        <Probe />
      </MeetingRecordingProvider>,
    );

    await waitFor(() => {
      expect(result.getByTestId('meeting-cloud-session-id').props.children).toBe('cloud-session-1');
    });
  });

  it('uses setCompanionSessionId store action when syncing companion session id', async () => {
    const originalSetCompanionSessionId = useActiveRecordingStore.getState().setCompanionSessionId;
    const setCompanionSessionIdSpy = jest.fn();
    useActiveRecordingStore.setState({
      companionSessionId: asCompanionConversationId('companion-1'),
      setCompanionSessionId: setCompanionSessionIdSpy as unknown as (
        companionSessionId: CompanionConversationId | null,
      ) => void,
    });

    try {
      const result = render(
        <MeetingRecordingProvider>
          <StartRecordingProbe />
        </MeetingRecordingProvider>,
      );
      fireEvent.press(result.getByTestId('start-recording'));

      await waitFor(() => {
        expect(setCompanionSessionIdSpy).toHaveBeenCalledWith('companion-2');
      });
    } finally {
      act(() => {
        useActiveRecordingStore.setState({ setCompanionSessionId: originalSetCompanionSessionId });
      });
    }
  });
});
