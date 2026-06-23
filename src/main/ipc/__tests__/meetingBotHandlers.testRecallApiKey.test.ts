import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  registeredHandlers: new Map<string, (event: unknown, payload: unknown) => unknown>(),
  testRecallApiKey: vi.fn(),
  isRecorderInstalled: vi.fn(),
}));

vi.mock('../utils/registerHandler', () => ({
  registerHandler: (channel: string, handler: (event: unknown, payload: unknown) => unknown) => {
    mocks.registeredHandlers.set(channel, handler);
  },
}));

vi.mock('@core/logger', () => ({
  createScopedLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

vi.mock('../../services/meetingBot/meetingBotService', () => ({
  getActiveBotState: vi.fn(),
  setActiveBotCoach: vi.fn(),
  setPresenceMode: vi.fn(),
  computeCaptionsActive: vi.fn(),
  getActiveCollaboratorBotId: vi.fn(),
}));

vi.mock('../../services/meetingBot/desktopSdkService', () => ({
  startRecording: vi.fn(),
  stopRecording: vi.fn(),
  getCurrentMeeting: vi.fn(),
  getCurrentMeetingStatus: vi.fn(),
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

vi.mock('../../services/meetingBot/recallApiKeyTester', () => ({
  testRecallApiKey: mocks.testRecallApiKey,
}));

vi.mock('../../services/meetingBot/recorderInstallation', () => ({
  isRecorderInstalled: mocks.isRecorderInstalled,
}));

vi.mock('../../services/meetingBot/localRecordingService', () => ({
  isLocalRecordingSupported: vi.fn(),
  isLocalRecordingEnabled: vi.fn(),
  checkPermissions: vi.fn(),
  requestPermissions: vi.fn(),
  startLocalRecording: vi.fn(),
  stopLocalRecording: vi.fn(),
  getLocalRecordingStatus: vi.fn(),
  fetchLocalRecordingTranscript: vi.fn(),
  isLocalRecordingCapturing: vi.fn(),
  setLocalRecordingCoach: vi.fn(),
  setLocalRecordingPresenceMode: vi.fn(),
  getLocalRecordingCoachState: vi.fn(),
}));

vi.mock('../../services/physicalRecording', () => ({
  getPhysicalRecordingStatus: vi.fn(),
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

describe('meeting-bot:test-recall-api-key handler', () => {
  beforeEach(() => {
    mocks.registeredHandlers.clear();
    mocks.testRecallApiKey.mockReset();
    mocks.isRecorderInstalled.mockReset();
    registerMeetingBotHandlers({ getMeetingBotService: () => null });
  });

  it('returns ok for a valid Recall API key', async () => {
    mocks.testRecallApiKey.mockResolvedValueOnce({
      success: true,
      message: 'Connected. New recordings will go straight to your Recall account.',
    });

    const handler = mocks.registeredHandlers.get('meeting-bot:test-recall-api-key');
    expect(handler).toBeDefined();

    const result = await handler?.(null, { apiKey: 'rk_live_valid' });

    expect(result).toEqual({
      success: true,
      message: 'Connected. New recordings will go straight to your Recall account.',
    });
    expect(mocks.testRecallApiKey).toHaveBeenCalledWith('rk_live_valid');
  });

  it('returns a recoverable error for an invalid Recall API key', async () => {
    mocks.testRecallApiKey.mockResolvedValueOnce({
      success: false,
      recoverable: true,
      error: 'That key did not work. Recall rejected it, so nothing was saved. Check you copied the whole key from your Recall dashboard, then try again.',
    });

    const handler = mocks.registeredHandlers.get('meeting-bot:test-recall-api-key');
    expect(handler).toBeDefined();

    const result = await handler?.(null, { apiKey: 'rk_live_invalid' });

    expect(result).toEqual({
      success: false,
      recoverable: true,
      error: 'That key did not work. Recall rejected it, so nothing was saved. Check you copied the whole key from your Recall dashboard, then try again.',
    });
  });
});

describe('meeting-bot:is-recorder-installed handler', () => {
  beforeEach(() => {
    mocks.registeredHandlers.clear();
    mocks.testRecallApiKey.mockReset();
    mocks.isRecorderInstalled.mockReset();
    registerMeetingBotHandlers({ getMeetingBotService: () => null });
  });

  it('returns recorder installation state from the runtime helper', () => {
    mocks.isRecorderInstalled.mockReturnValueOnce(false);

    const handler = mocks.registeredHandlers.get('meeting-bot:is-recorder-installed');
    expect(handler).toBeDefined();

    const result = handler?.(null, undefined);

    expect(result).toEqual({ installed: false });
    expect(mocks.isRecorderInstalled).toHaveBeenCalledOnce();
  });
});
