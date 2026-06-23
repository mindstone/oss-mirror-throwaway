/**
 * Snapshot-path precedence regression test (FOX-3438).
 *
 * The renderer builds meeting status not only from live broadcasts but also from the
 * `meeting-bot:get-current-status` snapshot on mount / recovery poll / a second window
 * (MeetingStatusContext.tsx:212). The snapshot MUST mirror the live broadcast semantics
 * (localRecordingService.broadcastStatus vs broadcastBackgroundStatus), or a renderer
 * that fetches the snapshot DURING UPLOAD re-enters the high-precedence active
 * `recording_local`/`local_recording` state and then rejects the low-precedence
 * `uploading_local`/`desktop_sdk` broadcasts — leaving the recording mic (and its infinite
 * pulse animation) stuck forever.
 *
 * So: high-precedence active state ONLY while capturing; upload-only returns the
 * low-precedence upload snapshot; idle returns the desktop-SDK fallback.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  registeredHandlers: new Map<string, (event: unknown, payload: unknown) => unknown>(),
  getLocalRecordingStatus: vi.fn(),
  getPhysicalRecordingStatus: vi.fn(),
  getActiveBotState: vi.fn(),
  getDesktopSdkStatus: vi.fn(),
}));

vi.mock('../utils/registerHandler', () => ({
  registerHandler: (channel: string, handler: (event: unknown, payload: unknown) => unknown) => {
    mocks.registeredHandlers.set(channel, handler);
  },
}));

vi.mock('@core/logger', () => ({
  createScopedLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

vi.mock('../../services/meetingBot/meetingBotService', () => ({
  getActiveBotState: mocks.getActiveBotState,
  setActiveBotCoach: vi.fn(),
  setPresenceMode: vi.fn(),
  computeCaptionsActive: vi.fn(),
  getActiveCollaboratorBotId: vi.fn(),
}));

vi.mock('../../services/meetingBot/desktopSdkService', () => ({
  startRecording: vi.fn(),
  stopRecording: vi.fn(),
  getCurrentMeeting: vi.fn(),
  getCurrentMeetingStatus: mocks.getDesktopSdkStatus,
  isDesktopSdkInitialized: vi.fn(),
  skipCurrentMeeting: vi.fn(),
  getTeamsUrlPermissionStatus: vi.fn(),
  requestTeamsUrlPermission: vi.fn(),
}));

vi.mock('../../services/meetingBot/pendingTranscriptsStore', () => ({
  getPendingTranscripts: vi.fn(() => []),
  getPendingTranscript: vi.fn(),
  updatePendingTranscriptCoachSelection: vi.fn(),
  updatePendingTranscriptPresenceMode: vi.fn(),
}));

vi.mock('../../services/meetingBot/externalProviders', () => ({
  testProviderConnection: vi.fn(),
  triggerManualSync: vi.fn(),
}));

vi.mock('../../services/meetingBot/recallApiKeyTester', () => ({ testRecallApiKey: vi.fn() }));

vi.mock('../../services/meetingBot/recorderInstallation', () => ({ isRecorderInstalled: vi.fn() }));

vi.mock('../../services/meetingBot/localRecordingService', () => ({
  isLocalRecordingSupported: vi.fn(),
  isLocalRecordingEnabled: vi.fn(),
  checkPermissions: vi.fn(),
  requestPermissions: vi.fn(),
  startLocalRecording: vi.fn(),
  stopLocalRecording: vi.fn(),
  getLocalRecordingStatus: mocks.getLocalRecordingStatus,
  fetchLocalRecordingTranscript: vi.fn(),
  isLocalRecordingCapturing: vi.fn(),
  setLocalRecordingCoach: vi.fn(),
  setLocalRecordingPresenceMode: vi.fn(),
  getLocalRecordingCoachState: vi.fn(),
}));

vi.mock('../../services/physicalRecording', () => ({
  getPhysicalRecordingStatus: mocks.getPhysicalRecordingStatus,
}));

vi.mock('../../services/meetingBot/botQAService', () => ({
  setKnowledgeAccess: vi.fn(),
  isKnowledgeAccessEnabled: vi.fn(),
  requestStopSpeaking: vi.fn(),
  isBotSpeaking: vi.fn(),
  hasPendingResponse: vi.fn(),
  triggerSpeakPendingResponse: vi.fn(),
  chatPendingResponse: vi.fn(),
  getPendingContributionPreview: vi.fn(),
  dismissPendingContribution: vi.fn(),
}));

import { registerMeetingBotHandlers } from '../meetingBotHandlers';

function localStatus(over: Record<string, unknown>) {
  return {
    isRecording: false,
    isCapturing: false,
    isUploading: false,
    uploadId: 'up_1',
    meetingTitle: 'Standup',
    meetingUrl: 'https://meet.example/abc',
    startTime: new Date(Date.now() - 60_000).toISOString(),
    ...over,
  };
}

describe('meeting-bot:get-current-status snapshot precedence (FOX-3438)', () => {
  beforeEach(() => {
    mocks.registeredHandlers.clear();
    mocks.getLocalRecordingStatus.mockReset();
    mocks.getPhysicalRecordingStatus.mockReset();
    mocks.getActiveBotState.mockReset();
    mocks.getDesktopSdkStatus.mockReset();
    // No physical recording, no cloud bot, neutral SDK fallback by default.
    mocks.getPhysicalRecordingStatus.mockReturnValue(undefined);
    mocks.getActiveBotState.mockReturnValue(null);
    mocks.getDesktopSdkStatus.mockReturnValue({ state: 'no_meetings', source: 'desktop_sdk' });
    registerMeetingBotHandlers({ getMeetingBotService: () => null });
  });

  function callStatus() {
    const handler = mocks.registeredHandlers.get('meeting-bot:get-current-status');
    expect(handler).toBeDefined();
    return handler?.(null, undefined) as { state?: string; source?: string };
  }

  it('returns recording_local / local_recording (high precedence) ONLY while capturing', () => {
    mocks.getLocalRecordingStatus.mockReturnValue(
      localStatus({ isRecording: true, isCapturing: true, isUploading: false }),
    );
    const result = callStatus();
    expect(result.state).toBe('recording_local');
    expect(result.source).toBe('local_recording');
  });

  it('returns uploading_local / desktop_sdk (low precedence) when upload-only (not capturing)', () => {
    // This is the stuck-state bug: isRecording is still true (capturing OR uploading),
    // but capture has stopped — the snapshot must NOT claim the active recording state.
    mocks.getLocalRecordingStatus.mockReturnValue(
      localStatus({ isRecording: true, isCapturing: false, isUploading: true }),
    );
    const result = callStatus();
    expect(result.state).toBe('uploading_local');
    expect(result.source).toBe('desktop_sdk');
  });

  it('falls through to the desktop-SDK snapshot when neither capturing nor uploading', () => {
    mocks.getLocalRecordingStatus.mockReturnValue(
      localStatus({ isRecording: false, isCapturing: false, isUploading: false }),
    );
    const result = callStatus();
    expect(result.state).toBe('no_meetings');
    expect(result.source).toBe('desktop_sdk');
  });
});
