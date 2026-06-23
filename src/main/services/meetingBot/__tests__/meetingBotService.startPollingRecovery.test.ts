import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mockState = vi.hoisted(() => ({
  unsavedTranscripts: [] as Array<{ botId: string }>,
  resetCount: 0,
  authUser: { id: 'user-1', name: 'Recovery Tester' } as { id: string; name: string } | null,
  resetTransientFailedTranscripts: vi.fn(() => 0),
  getTranscriptsNeedingSave: vi.fn(() => [] as Array<{ botId: string }>),
}));

vi.mock('electron', () => ({
  BrowserWindow: {
    getAllWindows: vi.fn(() => []),
  },
}));

vi.mock('@core/logger', () => ({
  createScopedLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

vi.mock('@core/meetingSource/saveMeetingSource', () => ({
  notifyDistributionReady: vi.fn(),
}));

vi.mock('@core/services/operatorRegistry', () => ({
  listAvailable: vi.fn(async () => []),
  listAvailableWithDiagnostics: vi.fn(async () => ({ operators: [], failures: [] })),
  getById: vi.fn(() => undefined),
  invalidateOperatorRegistry: vi.fn(),
}));

vi.mock('@core/services/settingsStore', () => ({
  getSettings: vi.fn(() => ({ meetingBot: {} })),
  updateSettings: vi.fn(),
  setSettingsStoreAdapter: vi.fn(),
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
      getAuthState: vi.fn(() => (mockState.authUser ? { user: mockState.authUser } : null)),
  }),
  setRebelAuthProvider: vi.fn(),
  NULL_REBEL_AUTH_PROVIDER: {},
}));

vi.mock('../pendingTranscriptsStore', () => {
  mockState.resetTransientFailedTranscripts.mockImplementation(() => mockState.resetCount);
  mockState.getTranscriptsNeedingSave.mockImplementation(() => mockState.unsavedTranscripts);

  return {
    getPendingTranscripts: vi.fn(() => []),
    getPendingTranscript: vi.fn(() => null),
    addPendingTranscript: vi.fn(),
    updatePendingTranscriptStatus: vi.fn(),
    removePendingTranscript: vi.fn(() => true),
    cleanupExpiredTranscripts: vi.fn(),
    getTranscriptsNeedingCheck: vi.fn(() => []),
    getTranscriptsNeedingSave: mockState.getTranscriptsNeedingSave,
    getTranscriptsNeedingAnalysis: vi.fn(() => []),
    getTranscriptsNeedingAsyncUpgrade: vi.fn(() => []),
    getTimedOutAsyncUpgrades: vi.fn(() => []),
    markTranscriptSaved: vi.fn(),
    markTranscriptStaged: vi.fn(),
    incrementSaveAttempts: vi.fn(() => 0),
    incrementConsecutiveErrors: vi.fn(() => 0),
    resetConsecutiveErrors: vi.fn(),
    updateLastRetryAt: vi.fn(),
    updateTranscriptQuality: vi.fn(),
    updateAsyncUpgradeStatus: vi.fn(),
    scheduleAnalysis: vi.fn(),
    setNextRetryTime: vi.fn(),
    markExhaustedTranscriptsAsFailed: vi.fn(() => 0),
    resetTransientFailedTranscripts: mockState.resetTransientFailedTranscripts,
    updateRelayBotId: vi.fn(),
    updateRecordingStartTime: vi.fn(),
    updatePendingTranscriptCoachSelection: vi.fn(),
    updatePendingTranscriptPresenceMode: vi.fn(),
    updatePendingTranscriptConversationState: vi.fn(),
  };
});

vi.mock('../transcriptStorage', () => ({
  saveTranscript: vi.fn(async () => ({ success: true })),
  cleanTranscriptText: vi.fn((text: string) => text),
  upgradeTranscriptQuality: vi.fn(async () => ({ success: true })),
  upgradeExistingLiveTranscript: vi.fn(async () => ({ success: true })),
  readLiveTranscriptFrontmatter: vi.fn(async () => ({ success: false })),
  parseLiveTranscriptSegments: vi.fn(async () => ({ success: true, segments: [] })),
}));

vi.mock('../meetingAnalysisService', () => ({
  triggerMeetingAnalysis: vi.fn(async () => ({ success: true })),
}));

vi.mock('../transcriptEventBus', () => ({
  emitTranscriptDistributionReady: vi.fn(),
  emitTranscriptSaved: vi.fn(),
  deferTranscriptSaved: vi.fn(),
}));

vi.mock('@core/services/meetingBotBackendConfig', async () => {
  const actual = await vi.importActual<typeof import('@core/services/meetingBotBackendConfig')>(
    '@core/services/meetingBotBackendConfig',
  );
  return {
    ...actual,
    resolveMeetingBotBackendConfig: vi.fn(() => ({
      configured: true,
      url: 'https://backend.example',
      authKey: 'test-key',
    })),
  };
});

vi.mock('../backendAuth', () => ({
  generateBackendAuthHeader: vi.fn(() => 'auth-header'),
}));

vi.mock('../desktopSdkService', () => ({
  broadcastCollaboratorStateIfPresent: vi.fn(() => false),
  setCollaboratorInfo: vi.fn(),
  broadcastCollaboratorFromPendingTranscript: vi.fn(),
}));

vi.mock('../meetingBotRuntimeRegistry', () => ({
  registerActiveBotStateProvider: vi.fn(),
  getCurrentMeeting: vi.fn(() => null),
  isLocalRecordingCapturing: vi.fn(() => false),
}));

vi.mock('../relayClient', () => ({
  connectToRelay: vi.fn(),
  disconnectFromRelay: vi.fn(),
  getRelayClient: vi.fn(() => null),
}));

vi.mock('../botQAService', () => ({
  startBotQA: vi.fn(),
  stopBotQA: vi.fn(),
  processTranscriptSegment: vi.fn(),
  clearProactivePending: vi.fn(),
  rehydrateTranscriptBuffer: vi.fn(),
  startLocalTranscriptBuffer: vi.fn(),
  fetchChatMessagesFromBackend: vi.fn(async () => []),
}));

vi.mock('../botVoiceService', () => ({
  announceJoin: vi.fn(async () => undefined),
  announceLeaveAndWait: vi.fn(async () => undefined),
}));

vi.mock('../../liveCoachService', () => ({
  resetBotCoachState: vi.fn(),
  setCoachStartTime: vi.fn(),
}));

vi.mock('../../meetingCoachPromptResolver', () => ({
  resolveMeetingCoachPrompt: vi.fn(() => ''),
}));

vi.mock('../conversationStateService', () => ({
  startStateTracking: vi.fn(),
  stopStateTracking: vi.fn(() => null),
}));

vi.stubGlobal('fetch', vi.fn(async () => ({
  ok: true,
  status: 200,
  statusText: 'OK',
  json: async () => ({ success: true, status: 'in_call_recording' }),
  text: async () => '',
})));

import { createMeetingBotService } from '../meetingBotService';

describe('meetingBotService startup recovery', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mockState.unsavedTranscripts = [];
    mockState.resetCount = 0;
    mockState.authUser = { id: 'user-1', name: 'Recovery Tester' };
    mockState.resetTransientFailedTranscripts.mockClear();
    mockState.getTranscriptsNeedingSave.mockClear();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('reprocesses transcripts immediately after startup reset', () => {
    mockState.resetCount = 1;
    mockState.unsavedTranscripts = [{ botId: 'bot-reset' }];

    const service = createMeetingBotService();
    const processSpy = vi
      .spyOn(service, 'processAndSaveTranscript')
      .mockResolvedValue({ success: true, filePath: '/tmp/recovered.md' });

    service.startPolling();

    expect(mockState.resetTransientFailedTranscripts).toHaveBeenCalledTimes(1);
    expect(mockState.getTranscriptsNeedingSave).toHaveBeenCalledTimes(1);
    expect(processSpy).toHaveBeenCalledWith('bot-reset');

    service.stopPolling();
  });

  it('defers startup recovery when not authenticated yet', () => {
    mockState.resetCount = 1;
    mockState.unsavedTranscripts = [{ botId: 'bot-reset' }];
    // No authenticated user at startup → getUserId() returns null.
    mockState.authUser = null;

    const service = createMeetingBotService();
    const processSpy = vi
      .spyOn(service, 'processAndSaveTranscript')
      .mockResolvedValue({ success: true, filePath: '/tmp/recovered.md' });

    service.startPolling();

    // Reset still runs (re-arms the transcript), but the immediate reprocess is deferred.
    expect(mockState.resetTransientFailedTranscripts).toHaveBeenCalledTimes(1);
    expect(processSpy).not.toHaveBeenCalled();

    service.stopPolling();
  });
});
