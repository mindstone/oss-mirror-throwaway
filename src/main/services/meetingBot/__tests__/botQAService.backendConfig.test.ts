import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mockState = vi.hoisted(() => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
  resolveMeetingBotBackendConfig: vi.fn(() => ({
    configured: false as const,
    missing: ['url', 'authKey'] as Array<'url' | 'authKey'>,
  })),
  getBackendAuthHeader: vi.fn(() => 'mock-auth-header'),
}));

vi.mock('@core/logger', () => ({
  createScopedLogger: () => mockState.logger,
}));

vi.mock('@core/broadcastService', () => ({
  getBroadcastService: vi.fn(() => ({
    send: vi.fn(),
  })),
}));

vi.mock('@core/services/operatorRegistry', () => ({
  listAvailable: vi.fn(async () => []),
  listAvailableWithDiagnostics: vi.fn(async () => ({ operators: [], failures: [] })),
  getById: vi.fn(() => undefined),
  invalidateOperatorRegistry: vi.fn(),
}));

vi.mock('@core/services/settingsStore', () => ({
  setSettingsStoreAdapter: vi.fn(),
  getSettings: vi.fn(() => ({ meetingBot: {} })),
}));

vi.mock('@core/services/meetingTriggerDetector', () => ({
  GO_AHEAD_IN_TEXT_RE: /go\s+ahead/i,
  createMeetingTriggerDetector: vi.fn(() => ({
    ingestSegment: vi.fn(),
    on: vi.fn(),
    off: vi.fn(),
    hasPendingAccumulation: vi.fn(() => false),
    getAccumulationSpeaker: vi.fn(() => null),
    beginAccumulation: vi.fn(),
    appendToAccumulation: vi.fn(),
    cancelAccumulation: vi.fn(),
    dispose: vi.fn(),
  })),
  classifyHighSignalUtterance: vi.fn(() => null),
  extractFollowUpAfterConfirmation: vi.fn(() => null),
  extractQuestion: vi.fn((text: string) => text),
  isConfirmationPhrase: vi.fn(() => false),
  matchesDiscardTrigger: vi.fn(() => false),
  matchesStopTrigger: vi.fn(() => false),
  matchesTrigger: vi.fn(() => false),
  stripTriggerPrefix: vi.fn(() => null),
}));

vi.mock('@core/services/meetingVoiceService', () => ({
  getMeetingVoiceInstructions: vi.fn(() => ''),
}));

vi.mock('@core/services/meetingBotBackendConfig', () => ({
  MEETING_BOT_BACKEND_CONFIG_MISSING_REASON: 'meeting_bot_backend_config_missing',
  meetingBotBackendConfigMissingLogContext: (missing: Array<'url' | 'authKey'>) => ({
    service: 'meetingBot',
    reason: 'meeting_bot_backend_config_missing',
    missing,
  }),
  resolveMeetingBotBackendConfig: mockState.resolveMeetingBotBackendConfig,
}));

vi.mock('../backendAuth', () => ({
  getBackendAuthHeader: mockState.getBackendAuthHeader,
}));

vi.mock('../botVoiceService', () => ({
  speakInMeeting: vi.fn(async () => true),
  setAvatarState: vi.fn(),
  stopSpeaking: vi.fn(),
}));

vi.mock('../meetingBotRuntimeRegistry', () => ({
  getActiveBotState: vi.fn(() => null),
}));

vi.mock('../botSpeakingStateRegistry', () => ({
  registerSetBotSpeakingState: vi.fn(),
  registerShouldAbortSpeaking: vi.fn(),
}));

vi.mock('../../behindTheScenesClient', () => ({
  callBehindTheScenesWithAuth: vi.fn(async () => ({ content: [{ text: '' }] })),
}));

vi.mock('../transcriptStorage', () => ({
  saveLiveTranscript: vi.fn(async () => ({ success: true, filePath: '/tmp/live-transcript.md' })),
  appendToLiveTranscript: vi.fn(async () => ({ success: true, newSegmentsWritten: 1 })),
}));

vi.mock('../pendingTranscriptsStore', () => ({
  updateLiveTranscriptPath: vi.fn(),
  getPendingTranscript: vi.fn(() => null),
}));

vi.mock('../conversationStateService', () => ({
  formatMeetingContext: vi.fn(() => ''),
}));

vi.mock('../../meetingCoachPromptResolver', () => ({
  resolveMeetingCoachPrompt: vi.fn(() => ({
    prompt: '',
    contentHash: 'empty',
    source: 'file-body',
  })),
}));

import { fetchChatMessagesFromBackend, sendChatToMeeting } from '../botQAService';

describe('botQAService backend config fail-closed behavior', () => {
  beforeEach(() => {
    mockState.resolveMeetingBotBackendConfig.mockReturnValue({
      configured: false,
      missing: ['url', 'authKey'],
    });
    mockState.getBackendAuthHeader.mockClear();
    mockState.logger.debug.mockClear();
    mockState.logger.info.mockClear();
    mockState.logger.warn.mockClear();
    mockState.logger.error.mockClear();
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it('sendChatToMeeting returns a typed not-configured result before auth or fetch', async () => {
    const result = await sendChatToMeeting('bot-1', 'Hello from chat');

    expect(result).toEqual({
      success: false,
      error: 'Meeting bot backend not configured',
      rateLimited: undefined,
    });
    expect(mockState.getBackendAuthHeader).not.toHaveBeenCalled();
    expect(global.fetch).not.toHaveBeenCalled();
    expect(mockState.logger.error).toHaveBeenCalledWith(
      {
        service: 'meetingBot',
        reason: 'meeting_bot_backend_config_missing',
        missing: ['url', 'authKey'],
        botId: 'bot-1',
      },
      'Meeting bot backend config missing; refusing chat backend request',
    );
  });

  it('fetchChatMessagesFromBackend returns an empty typed result before auth or fetch', async () => {
    const result = await fetchChatMessagesFromBackend('bot-1');

    expect(result).toEqual([]);
    expect(mockState.getBackendAuthHeader).not.toHaveBeenCalled();
    expect(global.fetch).not.toHaveBeenCalled();
    expect(mockState.logger.error).toHaveBeenCalledWith(
      {
        service: 'meetingBot',
        reason: 'meeting_bot_backend_config_missing',
        missing: ['url', 'authKey'],
        botId: 'bot-1',
      },
      'Meeting bot backend config missing; refusing chat backend request',
    );
  });
});
