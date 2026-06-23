import { create } from 'zustand';
import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  createLogger,
  asCloudMeetingSessionId,
  asCompanionConversationId,
} from '@rebel/cloud-client';
import type {
  LocalRecordingId,
  CloudMeetingSessionId,
  CompanionConversationId,
} from '@rebel/cloud-client';

const COMPANION_SESSION_KEY = '@rebel/active-recording-companion-session-id';
const CLOUD_SESSION_KEY = '@rebel/active-recording-cloud-session-id';
const log = createLogger('activeRecordingStore');

interface ActiveRecordingState {
  isActive: boolean;
  // Three distinct branded ids — see cloud-client/src/types/liveMeetingIds.ts.
  // They cannot be assigned into one another, which is the whole point (rec #21).
  meetingSessionId: LocalRecordingId | null;
  startTime: number | null;
  title: string | null;
  companionSessionId: CompanionConversationId | null;
  cloudSessionId: CloudMeetingSessionId | null;
  recordingNotice: string | null;

  setRecording: (
    meetingSessionId: LocalRecordingId,
    startTime: number,
    title: string,
    companionSessionId?: CompanionConversationId,
  ) => void;
  setCompanionSessionId: (companionSessionId: CompanionConversationId | null) => void;
  setCloudSessionId: (cloudSessionId: CloudMeetingSessionId | null) => void;
  setRecordingNotice: (notice: string | null) => void;
  clearRecording: () => void;
}

function logStorageWriteError(action: 'setItem' | 'removeItem', key: string, err: unknown): void {
  log.warn('AsyncStorage persistence failed', {
    action,
    key,
    err: err instanceof Error ? err.message : String(err),
  });
}

export const useActiveRecordingStore = create<ActiveRecordingState>((set) => ({
  isActive: false,
  meetingSessionId: null,
  startTime: null,
  title: null,
  companionSessionId: null,
  cloudSessionId: null,
  recordingNotice: null,

  setRecording: (meetingSessionId, startTime, title, companionSessionId) => {
    const cid = companionSessionId ?? null;
    set({
      isActive: true,
      meetingSessionId,
      startTime,
      title,
      companionSessionId: cid,
      cloudSessionId: null,
      recordingNotice: null,
    });
    // Persist companionSessionId to AsyncStorage for crash recovery (fire-and-forget)
    if (cid) {
      void AsyncStorage.setItem(COMPANION_SESSION_KEY, cid).catch((err) => {
        logStorageWriteError('setItem', COMPANION_SESSION_KEY, err);
      });
    }
    void AsyncStorage.removeItem(CLOUD_SESSION_KEY).catch((err) => {
      logStorageWriteError('removeItem', CLOUD_SESSION_KEY, err);
    });
  },

  setCompanionSessionId: (companionSessionId) => {
    set({ companionSessionId });
    if (companionSessionId) {
      void AsyncStorage.setItem(COMPANION_SESSION_KEY, companionSessionId).catch((err) => {
        logStorageWriteError('setItem', COMPANION_SESSION_KEY, err);
      });
      return;
    }
    void AsyncStorage.removeItem(COMPANION_SESSION_KEY).catch((err) => {
      logStorageWriteError('removeItem', COMPANION_SESSION_KEY, err);
    });
  },

  setCloudSessionId: (cloudSessionId) => {
    set({ cloudSessionId });
    if (cloudSessionId) {
      void AsyncStorage.setItem(CLOUD_SESSION_KEY, cloudSessionId).catch((err) => {
        logStorageWriteError('setItem', CLOUD_SESSION_KEY, err);
      });
      return;
    }
    void AsyncStorage.removeItem(CLOUD_SESSION_KEY).catch((err) => {
      logStorageWriteError('removeItem', CLOUD_SESSION_KEY, err);
    });
  },

  setRecordingNotice: (recordingNotice) => {
    set({ recordingNotice });
  },

  clearRecording: () => {
    set({
      isActive: false,
      meetingSessionId: null,
      startTime: null,
      title: null,
      companionSessionId: null,
      cloudSessionId: null,
      recordingNotice: null,
    });
    // Clear persisted recording IDs (fire-and-forget)
    void AsyncStorage.removeItem(COMPANION_SESSION_KEY).catch((err) => {
      logStorageWriteError('removeItem', COMPANION_SESSION_KEY, err);
    });
    void AsyncStorage.removeItem(CLOUD_SESSION_KEY).catch((err) => {
      logStorageWriteError('removeItem', CLOUD_SESSION_KEY, err);
    });
  },
}));

/**
 * Rehydrate active recording IDs from AsyncStorage on app start.
 * Call once during app initialization (e.g. in _layout.tsx or MeetingRecordingProvider).
 * Restores persisted IDs into memory when fields are currently unset.
 */
export async function rehydrateActiveRecordingIds(): Promise<void> {
  try {
    const [storedCompanionSessionId, storedCloudSessionId] = await Promise.all([
      AsyncStorage.getItem(COMPANION_SESSION_KEY),
      AsyncStorage.getItem(CLOUD_SESSION_KEY),
    ]);
    if (!storedCompanionSessionId && !storedCloudSessionId) {
      return;
    }

    const state = useActiveRecordingStore.getState();
    const updates: Partial<Pick<ActiveRecordingState, 'companionSessionId' | 'cloudSessionId'>> = {};
    if (storedCompanionSessionId && !state.companionSessionId) {
      // AsyncStorage read boundary: brand the raw persisted string by provenance.
      updates.companionSessionId = asCompanionConversationId(storedCompanionSessionId);
    }
    if (storedCloudSessionId && !state.cloudSessionId) {
      updates.cloudSessionId = asCloudMeetingSessionId(storedCloudSessionId);
    }

    if (Object.keys(updates).length > 0) {
      useActiveRecordingStore.setState(updates);
    }
  } catch (err) {
    log.warn('Failed to rehydrate active recording IDs from AsyncStorage', {
      err: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * @deprecated Use rehydrateActiveRecordingIds instead.
 */
export async function rehydrateCompanionSessionId(): Promise<void> {
  await rehydrateActiveRecordingIds();
}
