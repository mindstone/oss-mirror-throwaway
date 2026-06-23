import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  asCloudMeetingSessionId,
  asCompanionConversationId,
  asLocalRecordingId,
} from '@rebel/cloud-client';
import {
  rehydrateActiveRecordingIds,
  rehydrateCompanionSessionId,
  useActiveRecordingStore,
} from '../stores/activeRecordingStore';

const COMPANION_SESSION_KEY = '@rebel/active-recording-companion-session-id';
const CLOUD_SESSION_KEY = '@rebel/active-recording-cloud-session-id';

function resetStore(): void {
  useActiveRecordingStore.setState({
    isActive: false,
    meetingSessionId: null,
    startTime: null,
    title: null,
    companionSessionId: null,
    cloudSessionId: null,
    recordingNotice: null,
  });
}

beforeEach(async () => {
  resetStore();
  await AsyncStorage.clear();
  jest.clearAllMocks();
});

describe('activeRecordingStore cloud session persistence', () => {
  it('setCompanionSessionId persists companionSessionId to AsyncStorage', () => {
    useActiveRecordingStore.getState().setCompanionSessionId(asCompanionConversationId('companion-session-1'));

    expect(useActiveRecordingStore.getState().companionSessionId).toBe('companion-session-1');
    expect(AsyncStorage.setItem).toHaveBeenCalledWith(COMPANION_SESSION_KEY, 'companion-session-1');
  });

  it('setCloudSessionId persists cloudSessionId to AsyncStorage', () => {
    useActiveRecordingStore.getState().setCloudSessionId(asCloudMeetingSessionId('cloud-session-1'));

    expect(useActiveRecordingStore.getState().cloudSessionId).toBe('cloud-session-1');
    expect(AsyncStorage.setItem).toHaveBeenCalledWith(CLOUD_SESSION_KEY, 'cloud-session-1');
  });

  it('setRecordingNotice stores non-blocking recording notices', () => {
    useActiveRecordingStore.getState().setRecordingNotice('Saving locally');
    expect(useActiveRecordingStore.getState().recordingNotice).toBe('Saving locally');
  });

  it('clearRecording resets cloudSessionId and removes persisted keys', () => {
    useActiveRecordingStore.setState({
      isActive: true,
      meetingSessionId: asLocalRecordingId('meeting-local-1'),
      startTime: 123,
      title: 'Meeting',
      companionSessionId: asCompanionConversationId('companion-1'),
      cloudSessionId: asCloudMeetingSessionId('cloud-session-1'),
      recordingNotice: null,
    });

    useActiveRecordingStore.getState().clearRecording();

    const state = useActiveRecordingStore.getState();
    expect(state.isActive).toBe(false);
    expect(state.companionSessionId).toBeNull();
    expect(state.cloudSessionId).toBeNull();
    expect(AsyncStorage.removeItem).toHaveBeenCalledWith(COMPANION_SESSION_KEY);
    expect(AsyncStorage.removeItem).toHaveBeenCalledWith(CLOUD_SESSION_KEY);
  });

  it('rehydrateActiveRecordingIds restores companion and cloud session IDs when active', async () => {
    await AsyncStorage.setItem(COMPANION_SESSION_KEY, 'companion-1');
    await AsyncStorage.setItem(CLOUD_SESSION_KEY, 'cloud-session-1');
    useActiveRecordingStore.setState({
      isActive: true,
      meetingSessionId: asLocalRecordingId('meeting-local-1'),
      startTime: 123,
      title: 'Meeting',
      companionSessionId: null,
      cloudSessionId: null,
      recordingNotice: null,
    });

    await rehydrateActiveRecordingIds();

    const state = useActiveRecordingStore.getState();
    expect(state.companionSessionId).toBe('companion-1');
    expect(state.cloudSessionId).toBe('cloud-session-1');
  });

  it('rehydrateCompanionSessionId alias rehydrates both IDs for one-release compatibility', async () => {
    await AsyncStorage.setItem(COMPANION_SESSION_KEY, 'companion-1');
    await AsyncStorage.setItem(CLOUD_SESSION_KEY, 'cloud-session-1');
    useActiveRecordingStore.setState({
      isActive: true,
      meetingSessionId: asLocalRecordingId('meeting-local-1'),
      startTime: 123,
      title: 'Meeting',
      companionSessionId: null,
      cloudSessionId: null,
      recordingNotice: null,
    });

    await rehydrateCompanionSessionId();

    const state = useActiveRecordingStore.getState();
    expect(state.companionSessionId).toBe('companion-1');
    expect(state.cloudSessionId).toBe('cloud-session-1');
  });

  it('rehydrateActiveRecordingIds restores IDs when store is inactive and preserves persisted keys', async () => {
    await AsyncStorage.setItem(COMPANION_SESSION_KEY, 'companion-1');
    await AsyncStorage.setItem(CLOUD_SESSION_KEY, 'cloud-session-1');
    resetStore();

    await rehydrateActiveRecordingIds();

    const state = useActiveRecordingStore.getState();
    expect(state.companionSessionId).toBe('companion-1');
    expect(state.cloudSessionId).toBe('cloud-session-1');
    expect(AsyncStorage.removeItem).not.toHaveBeenCalledWith(COMPANION_SESSION_KEY);
    expect(AsyncStorage.removeItem).not.toHaveBeenCalledWith(CLOUD_SESSION_KEY);
    await expect(AsyncStorage.getItem(COMPANION_SESSION_KEY)).resolves.toBe('companion-1');
    await expect(AsyncStorage.getItem(CLOUD_SESSION_KEY)).resolves.toBe('cloud-session-1');
  });

  it('rehydrateActiveRecordingIds is a no-op when store is inactive and no persisted IDs exist', async () => {
    resetStore();

    await rehydrateActiveRecordingIds();

    const state = useActiveRecordingStore.getState();
    expect(state.companionSessionId).toBeNull();
    expect(state.cloudSessionId).toBeNull();
    expect(AsyncStorage.setItem).not.toHaveBeenCalled();
    expect(AsyncStorage.removeItem).not.toHaveBeenCalled();
  });

  it('rehydrateActiveRecordingIds does not clobber existing companionSessionId in memory', async () => {
    await AsyncStorage.setItem(COMPANION_SESSION_KEY, 'persisted-companion');
    await AsyncStorage.setItem(CLOUD_SESSION_KEY, 'persisted-cloud');
    useActiveRecordingStore.setState({
      isActive: false,
      meetingSessionId: null,
      startTime: null,
      title: null,
      companionSessionId: asCompanionConversationId('memory-companion'),
      cloudSessionId: null,
      recordingNotice: null,
    });

    await rehydrateActiveRecordingIds();

    const state = useActiveRecordingStore.getState();
    expect(state.companionSessionId).toBe('memory-companion');
    expect(state.cloudSessionId).toBe('persisted-cloud');
  });
});
