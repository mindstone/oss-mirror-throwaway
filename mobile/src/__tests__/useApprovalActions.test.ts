import { renderHook } from '@testing-library/react-native';
import { asCloudMeetingSessionId, asCompanionConversationId } from '@rebel/cloud-client';
import { useActiveRecordingStore } from '../stores/activeRecordingStore';

const mockUseBaseApprovalActions = jest.fn<unknown, unknown[]>((config: unknown) => config);

jest.mock('@rebel/cloud-client', () => ({
  // Pure live-meeting id casts (zero-import module) so a future pure cast added
  // there needs no mock edit. See meetingRecordingContext.test.tsx for rationale.
  ...(jest.requireActual('../../../cloud-client/src/types/liveMeetingIds') as typeof import('../../../cloud-client/src/types/liveMeetingIds')),
  useApprovalActions: (...args: unknown[]) => mockUseBaseApprovalActions(...args),
  createLogger: () => ({
    info: jest.fn(),
    warn: jest.fn(),
    debug: jest.fn(),
    error: jest.fn(),
  }),
}));

jest.mock('../utils/haptics', () => ({
  hapticSuccess: jest.fn(),
  hapticWarning: jest.fn(),
}));

import { useApprovalActions } from '../hooks/useApprovalActions';

type ApprovalHookConfig = {
  getContinuationTurnMetadata?: (targetSessionId: string) => Record<string, unknown>;
};

function getMetadataForTargetSession(targetSessionId: string): Record<string, unknown> {
  const { result } = renderHook(() => useApprovalActions());
  const config = result.current as ApprovalHookConfig;
  return config.getContinuationTurnMetadata?.(targetSessionId) ?? {};
}

describe('mobile useApprovalActions continuation metadata', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    useActiveRecordingStore.setState({
      isActive: false,
      meetingSessionId: null,
      startTime: null,
      title: null,
      companionSessionId: null,
      cloudSessionId: null,
    });
  });

  it('returns meeting fields when active recording session matches continuation target', () => {
    useActiveRecordingStore.setState({
      isActive: true,
      companionSessionId: asCompanionConversationId('session-a'),
      cloudSessionId: asCloudMeetingSessionId('cloud-meet-123'),
    });

    const metadata = getMetadataForTargetSession('session-a');
    expect(metadata).toEqual({
      meetingSessionId: 'cloud-meet-123',
      recordingActive: true,
    });
  });

  it('omits meeting fields when active recording session does not match continuation target', () => {
    useActiveRecordingStore.setState({
      isActive: true,
      companionSessionId: asCompanionConversationId('session-a'),
      cloudSessionId: asCloudMeetingSessionId('cloud-meet-123'),
    });

    const metadata = getMetadataForTargetSession('session-b');
    expect(metadata).toEqual({});
  });

  it('omits meeting fields when no recording is active', () => {
    useActiveRecordingStore.setState({
      isActive: false,
      companionSessionId: asCompanionConversationId('session-a'),
      cloudSessionId: asCloudMeetingSessionId('cloud-meet-123'),
    });

    const metadata = getMetadataForTargetSession('session-a');
    expect(metadata).toEqual({});
  });
});
