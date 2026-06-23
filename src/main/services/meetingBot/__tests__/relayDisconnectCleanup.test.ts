 
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PendingTranscript } from '@shared/ipc/channels/meetingBot';
import type { RelayClientCallbacks } from '../relayClient';

const BOT_ID = 'bot-relay-cleanup-test';
const TEST_MEETING_URL = 'https://zoom.us/j/123456789';

const mockState = vi.hoisted(() => ({
  pendingTranscripts: new Map<string, PendingTranscript>(),
  stopStateTracking: vi.fn(),
  resetBotCoachState: vi.fn(),
  stopBotQA: vi.fn(),
  updatePendingTranscriptConversationState: vi.fn(),
  capturedRelayCallbacks: null as RelayClientCallbacks | null,
}));

function makePendingTranscript(
  overrides: Partial<PendingTranscript> & { botId: string; meetingUrl: string }
): PendingTranscript {
  const now = new Date().toISOString();
  const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
  return {
    status: 'in_meeting',
    scheduledAt: now,
    createdAt: now,
    expiresAt,
    ...overrides,
  } as PendingTranscript;
}

function mockJsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as Response;
}

vi.mock('electron', () => ({
  BrowserWindow: { getAllWindows: () => [] },
}));

vi.mock('@core/services/settingsStore', () => ({
  getSettings: () => ({
    userFirstName: 'Test',
    meetingBot: {},
  }),
  updateSettings: vi.fn(),
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
      getAuthState: () => ({
        user: {
          id: 'user-1',
          name: 'Test User',
        },
      }),
  }),
  setRebelAuthProvider: vi.fn(),
  NULL_REBEL_AUTH_PROVIDER: {},
}));

vi.mock('@core/services/meetingBotBackendConfig', async () => {
  const actual = await vi.importActual<typeof import('@core/services/meetingBotBackendConfig')>(
    '@core/services/meetingBotBackendConfig',
  );
  return {
    ...actual,
    resolveMeetingBotBackendConfig: vi.fn(() => ({
      configured: true,
      url: 'https://test.backend',
      authKey: 'test-key',
    })),
  };
});

vi.mock('../pendingTranscriptsStore', () => ({
  getPendingTranscripts: () => Array.from(mockState.pendingTranscripts.values()),
  getPendingTranscript: (botId: string) => mockState.pendingTranscripts.get(botId),
  addPendingTranscript: (transcript: Partial<PendingTranscript> & { botId: string; meetingUrl: string }) => {
    const stored = makePendingTranscript(transcript);
    mockState.pendingTranscripts.set(stored.botId, stored);
  },
  updatePendingTranscriptStatus: vi.fn(),
  removePendingTranscript: (botId: string) => mockState.pendingTranscripts.delete(botId),
  cleanupExpiredTranscripts: vi.fn(),
  getTranscriptsNeedingCheck: () => [],
  getTranscriptsNeedingSave: () => [],
  getTranscriptsNeedingAnalysis: () => [],
  getTranscriptsNeedingAsyncUpgrade: () => [],
  getTimedOutAsyncUpgrades: () => [],
  markTranscriptSaved: vi.fn(),
  markTranscriptStaged: vi.fn(),
  incrementSaveAttempts: vi.fn(),
  incrementConsecutiveErrors: vi.fn(),
  resetConsecutiveErrors: vi.fn(),
  updateLastRetryAt: vi.fn(),
  updateTranscriptQuality: vi.fn(),
  updateAsyncUpgradeStatus: vi.fn(),
  scheduleAnalysis: vi.fn(),
  setNextRetryTime: vi.fn(),
  markExhaustedTranscriptsAsFailed: () => 0,
  resetTransientFailedTranscripts: () => 0,
  updateRelayBotId: vi.fn(),
  updateRecordingStartTime: vi.fn(),
  updatePendingTranscriptCoachSelection: vi.fn(),
  updatePendingTranscriptPresenceMode: vi.fn(),
  updatePendingTranscriptConversationState: mockState.updatePendingTranscriptConversationState,
}));

vi.mock('../desktopSdkService', () => ({
  getCurrentMeeting: () => null,
  broadcastCollaboratorStateIfPresent: () => false,
  setCollaboratorInfo: vi.fn(),
  broadcastCollaboratorFromPendingTranscript: vi.fn(),
}));

vi.mock('../localRecordingService', () => ({
  isLocalRecordingCapturing: () => false,
}));

vi.mock('../relayClient', () => ({
  connectToRelay: vi.fn((_botId: string, _sessionToken: string, _relayUrl: string, callbacks: RelayClientCallbacks) => {
    mockState.capturedRelayCallbacks = callbacks;
  }),
  disconnectFromRelay: vi.fn(),
  getRelayClient: vi.fn(),
}));

vi.mock('../botQAService', () => ({
  startBotQA: vi.fn(),
  stopBotQA: mockState.stopBotQA,
  processTranscriptSegment: vi.fn(),
  clearProactivePending: vi.fn(),
  rehydrateTranscriptBuffer: vi.fn(),
  startLocalTranscriptBuffer: vi.fn(),
}));

vi.mock('../botVoiceService', () => ({
  announceJoin: vi.fn(),
  announceLeaveAndWait: vi.fn(),
}));

vi.mock('../../liveCoachService', () => ({
  resetBotCoachState: mockState.resetBotCoachState,
  setCoachStartTime: vi.fn(),
}));

vi.mock('../conversationStateService', () => ({
  startStateTracking: vi.fn(),
  stopStateTracking: mockState.stopStateTracking,
}));

vi.mock('../transcriptStorage', () => ({
  saveTranscript: vi.fn(),
  cleanTranscriptText: vi.fn(),
  upgradeTranscriptQuality: vi.fn(),
  upgradeExistingLiveTranscript: vi.fn(),
  readLiveTranscriptFrontmatter: vi.fn(),
  parseLiveTranscriptSegments: vi.fn(),
}));

vi.mock('../meetingAnalysisService', () => ({
  triggerMeetingAnalysis: vi.fn(),
}));

vi.mock('../transcriptEventBus', () => ({
  emitTranscriptSaved: vi.fn(),
  deferTranscriptSaved: vi.fn(),
  emitTranscriptDistributionReady: vi.fn(),
}));

const mockFetch = vi.fn(async (input: string | URL, init?: RequestInit) => {
  const url = typeof input === 'string' ? input : input.toString();
  const method = init?.method ?? 'GET';

  if (url.endsWith('/api/bot') && method === 'POST') {
    return mockJsonResponse({
      success: true,
      botId: BOT_ID,
      sessionToken: 'session-token',
      relayUrl: `wss://relay.example/relay/${BOT_ID}`,
      isOwner: true,
    });
  }

  if (url.includes(`/api/bot/${BOT_ID}/status`) && method === 'GET') {
    return mockJsonResponse({
      status: 'in_call_recording',
    });
  }

  if (url.endsWith('/api/bot/cancel') && method === 'POST') {
    return mockJsonResponse({ success: true });
  }

  return mockJsonResponse({});
});

vi.stubGlobal('fetch', mockFetch);

import { createMeetingBotService, getActiveBotState } from '../meetingBotService';

describe('relay disconnect cleanup', () => {
  beforeEach(() => {
    mockState.pendingTranscripts.clear();
    mockState.capturedRelayCallbacks = null;
    mockState.stopStateTracking.mockReset();
    mockState.resetBotCoachState.mockReset();
    mockState.stopBotQA.mockReset();
    mockState.updatePendingTranscriptConversationState.mockReset();
    mockFetch.mockClear();
  });

  it('cleans up tracking/coach state on permanent disconnect and avoids conversation-state double write later', async () => {
    const service = createMeetingBotService();
    mockState.stopStateTracking.mockReturnValue({ streak: 3 });

    const sendResult = await service.sendBot({
      meetingUrl: TEST_MEETING_URL,
      meetingTitle: 'Relay cleanup test',
    });

    expect(sendResult.success).toBe(true);
    expect(sendResult.botId).toBe(BOT_ID);
    expect(mockState.capturedRelayCallbacks).not.toBeNull();

    mockState.capturedRelayCallbacks!.onDisconnected!('server_closed', 1000, false);

    expect(mockState.stopStateTracking).toHaveBeenCalledTimes(1);
    expect(mockState.stopStateTracking).toHaveBeenCalledWith(BOT_ID);
    expect(mockState.updatePendingTranscriptConversationState).toHaveBeenCalledTimes(1);
    expect(mockState.updatePendingTranscriptConversationState).toHaveBeenCalledWith(
      BOT_ID,
      JSON.stringify({ streak: 3 }),
    );
    expect(mockState.resetBotCoachState).toHaveBeenCalledTimes(1);
    expect(mockState.stopBotQA).toHaveBeenCalledTimes(1);
    expect(getActiveBotState()?.botId).toBe(BOT_ID);

    const cancelResult = await service.cancelBot(BOT_ID);
    expect(cancelResult.success).toBe(true);

    expect(mockState.stopStateTracking).toHaveBeenCalledTimes(1);
    expect(mockState.updatePendingTranscriptConversationState).toHaveBeenCalledTimes(1);
  });

  it('does not run permanent cleanup on transient disconnects', async () => {
    const service = createMeetingBotService();
    mockState.stopStateTracking.mockReturnValue({ streak: 7 });

    const sendResult = await service.sendBot({
      meetingUrl: TEST_MEETING_URL,
      meetingTitle: 'Transient relay disconnect test',
    });

    expect(sendResult.success).toBe(true);
    expect(sendResult.botId).toBe(BOT_ID);
    expect(mockState.capturedRelayCallbacks).not.toBeNull();

    mockState.capturedRelayCallbacks!.onDisconnected!('temporary_network_drop', 1006, true);

    expect(mockState.stopStateTracking).not.toHaveBeenCalled();
    expect(mockState.updatePendingTranscriptConversationState).not.toHaveBeenCalled();
    expect(mockState.resetBotCoachState).not.toHaveBeenCalled();
    expect(mockState.stopBotQA).not.toHaveBeenCalled();
    expect(getActiveBotState()?.botId).toBe(BOT_ID);

    await service.cancelBot(BOT_ID);
  });
});
