import { describe, it, expect, vi } from 'vitest';
import { mapRecallStatus, mapRecallStatusToUiState } from '../meetingBotService';

// Mock dependencies that meetingBotService imports
vi.mock('electron', () => ({
  BrowserWindow: { getAllWindows: () => [] },
}));
vi.mock('@core/services/settingsStore', () => ({
  setSettingsStoreAdapter: vi.fn(),
  getSettings: () => ({}),
  settingsStore: { set: vi.fn() },
}));
vi.mock('@core/rebelAuth', () => ({
  getRebelAuthProvider: () => ({
      onAuthStateChange: vi.fn(() => () => {}),
      getAccessToken: vi.fn(async () => null),
      invalidateAccessToken: vi.fn(),
      initializeAuth: vi.fn(async () => ({ isAuthenticated: false, user: null, isLoading: false })),
      setPostLoginCallback: vi.fn(),
      getCachedAuthConfig: vi.fn(() => null),
      requestAuthConfigRefresh: vi.fn(async () => {}),
      refreshLicenseTier: vi.fn(async () => 'free'),
      clearCachedProviderKey: vi.fn(),
      getSharedDriveConfig: vi.fn(() => null),
      getSubscriptionState: vi.fn(() => null),
      getManagedAllowanceResetsAt: vi.fn(() => undefined),
      getAuthState: () => ({ user: null }),
  }),
  setRebelAuthProvider: vi.fn(),
  NULL_REBEL_AUTH_PROVIDER: {},
}));


describe('mapRecallStatus', () => {
  describe('maps joining/waiting statuses to scheduled', () => {
    it('maps "ready" to "scheduled"', () => {
      expect(mapRecallStatus('ready')).toBe('scheduled');
    });

    it('maps "joining_call" to "scheduled"', () => {
      expect(mapRecallStatus('joining_call')).toBe('scheduled');
    });

    it('maps "in_waiting_room" to "scheduled"', () => {
      expect(mapRecallStatus('in_waiting_room')).toBe('scheduled');
    });
  });

  describe('maps in-call statuses to in_meeting', () => {
    it('maps "in_call_not_recording" to "in_meeting"', () => {
      expect(mapRecallStatus('in_call_not_recording')).toBe('in_meeting');
    });

    it('maps "in_call_recording" to "in_meeting"', () => {
      expect(mapRecallStatus('in_call_recording')).toBe('in_meeting');
    });
  });

  describe('maps post-call statuses to processing', () => {
    it('maps "call_ended" to "processing"', () => {
      expect(mapRecallStatus('call_ended')).toBe('processing');
    });

    it('maps "processing" to "processing"', () => {
      expect(mapRecallStatus('processing')).toBe('processing');
    });
  });

  describe('maps completion statuses to ready', () => {
    it('maps "done" to "ready"', () => {
      expect(mapRecallStatus('done')).toBe('ready');
    });

    it('maps "analysis_done" to "ready"', () => {
      expect(mapRecallStatus('analysis_done')).toBe('ready');
    });
  });

  describe('maps failure statuses to failed', () => {
    it('maps "fatal" to "failed"', () => {
      expect(mapRecallStatus('fatal')).toBe('failed');
    });

    it('maps "analysis_failed" to "failed"', () => {
      expect(mapRecallStatus('analysis_failed')).toBe('failed');
    });

    it('maps "media_expired" to "failed"', () => {
      expect(mapRecallStatus('media_expired')).toBe('failed');
    });

    it('maps "recording_permission_denied" to "failed"', () => {
      expect(mapRecallStatus('recording_permission_denied')).toBe('failed');
    });
  });

  describe('defaults unknown statuses to scheduled for dedup safety', () => {
    it('maps "unknown" to "scheduled"', () => {
      expect(mapRecallStatus('unknown')).toBe('scheduled');
    });

    it('maps a future unknown status to "scheduled"', () => {
      expect(mapRecallStatus('some_future_status')).toBe('scheduled');
    });
  });
});

describe('mapRecallStatusToUiState', () => {
  it('maps "in_call_not_recording" to "recording"', () => {
    expect(mapRecallStatusToUiState('in_call_not_recording')).toBe('recording');
  });

  it('maps "in_call_recording" to "recording"', () => {
    expect(mapRecallStatusToUiState('in_call_recording')).toBe('recording');
  });

  it('does not trigger joining timeout for "in_call_not_recording"', () => {
    const expiredJoiningTime = Date.now() - (5 * 60 * 1000); // 5 minutes ago
    expect(mapRecallStatusToUiState('in_call_not_recording', expiredJoiningTime)).toBe('recording');
  });

  it('maps "joining_call" to "joining"', () => {
    expect(mapRecallStatusToUiState('joining_call')).toBe('joining');
  });

  it('maps "in_waiting_room" to "joining"', () => {
    expect(mapRecallStatusToUiState('in_waiting_room')).toBe('joining');
  });

  it('maps "fatal" to "rejected"', () => {
    expect(mapRecallStatusToUiState('fatal')).toBe('rejected');
  });

  it('triggers joining timeout for joining states', () => {
    const expiredJoiningTime = Date.now() - (5 * 60 * 1000);
    expect(mapRecallStatusToUiState('joining_call', expiredJoiningTime)).toBe('waiting_too_long');
  });

  it('triggers waiting room timeout for prolonged waiting', () => {
    const expiredWaitingTime = Date.now() - (3 * 60 * 1000); // 3 minutes ago
    expect(mapRecallStatusToUiState('in_waiting_room', undefined, expiredWaitingTime)).toBe('waiting_too_long');
  });
});
