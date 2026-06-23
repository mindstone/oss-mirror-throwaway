/**
 * Bug B — meeting-bot transcript retry storm (the DNS-starvation amplifier).
 *
 * Covers:
 *  (i) a `fetch failed` (network) save error now ENFORCES backoff via
 *      setNextRetryTime (and anchors the retry window) instead of being retried
 *      every poll with no spacing. Attempt count is intentionally NOT incremented
 *      (the 24h window is the cap). RED on the old behaviour, where `fetch failed`
 *      was classified transient → setNextRetryTime never called → parallel storm.
 *  (ii) the startup recovery fan-out is concurrency-capped (≤ 3 in flight) instead
 *      of firing processAndSaveTranscript for every unsaved transcript in parallel.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mockState = vi.hoisted(() => ({
  authUser: { id: 'user-1', name: 'Storm Tester' } as { id: string; name: string } | null,
  backendConfig: {
    configured: true as const,
    url: 'https://backend.example',
    authKey: 'test-key',
  } as
    | { configured: true; url: string; authKey: string }
    | { configured: false; missing: Array<'url' | 'authKey'> },
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
  pending: new Map<string, Record<string, unknown>>(),
  unsavedTranscripts: [] as Array<{ botId: string }>,
  setNextRetryTime: vi.fn(),
  ensureRetryWindowStarted: vi.fn(),
  incrementSaveAttempts: vi.fn(() => 1),
  updateLastRetryAt: vi.fn(),
}));

vi.mock('electron', () => ({
  BrowserWindow: { getAllWindows: vi.fn(() => []) },
}));

vi.mock('@core/logger', () => ({
  createScopedLogger: () => mockState.logger,
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

vi.mock('../pendingTranscriptsStore', () => ({
  getPendingTranscripts: vi.fn(() => []),
  getPendingTranscript: vi.fn((botId: string) => mockState.pending.get(botId) ?? null),
  addPendingTranscript: vi.fn(),
  updatePendingTranscriptStatus: vi.fn(),
  removePendingTranscript: vi.fn(() => true),
  cleanupExpiredTranscripts: vi.fn(),
  getTranscriptsNeedingCheck: vi.fn(() => []),
  getTranscriptsNeedingSave: vi.fn(() => mockState.unsavedTranscripts),
  getTranscriptsNeedingAnalysis: vi.fn(() => []),
  getTranscriptsNeedingAsyncUpgrade: vi.fn(() => []),
  getTimedOutAsyncUpgrades: vi.fn(() => []),
  markTranscriptSaved: vi.fn(),
  markTranscriptStaged: vi.fn(),
  incrementSaveAttempts: mockState.incrementSaveAttempts,
  incrementConsecutiveErrors: vi.fn(() => 0),
  resetConsecutiveErrors: vi.fn(),
  updateLastRetryAt: mockState.updateLastRetryAt,
  updateTranscriptQuality: vi.fn(),
  updateAsyncUpgradeStatus: vi.fn(),
  scheduleAnalysis: vi.fn(),
  setNextRetryTime: mockState.setNextRetryTime,
  ensureRetryWindowStarted: mockState.ensureRetryWindowStarted,
  markExhaustedTranscriptsAsFailed: vi.fn(() => 0),
  resetTransientFailedTranscripts: vi.fn(() => 0),
  updateRelayBotId: vi.fn(),
  updateRecordingStartTime: vi.fn(),
  updatePendingTranscriptCoachSelection: vi.fn(),
  updatePendingTranscriptPresenceMode: vi.fn(),
  updatePendingTranscriptConversationState: vi.fn(),
}));

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
    resolveMeetingBotBackendConfig: vi.fn(() => mockState.backendConfig),
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

import { createMeetingBotService } from '../meetingBotService';

describe('meetingBotService Bug B — fetch-failed enforces backoff', () => {
  beforeEach(() => {
    mockState.authUser = { id: 'user-1', name: 'Storm Tester' };
    mockState.pending = new Map();
    mockState.unsavedTranscripts = [];
    mockState.setNextRetryTime.mockClear();
    mockState.ensureRetryWindowStarted.mockClear();
    mockState.incrementSaveAttempts.mockClear();
    mockState.updateLastRetryAt.mockClear();
    mockState.backendConfig = {
      configured: true,
      url: 'https://backend.example',
      authKey: 'test-key',
    };
    mockState.logger.debug.mockClear();
    mockState.logger.info.mockClear();
    mockState.logger.warn.mockClear();
    mockState.logger.error.mockClear();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('a `fetch failed` save error schedules backoff WITHOUT counting an attempt (storm killed)', async () => {
    mockState.pending.set('bot-net', {
      botId: 'bot-net',
      status: 'ready',
      meetingTitle: 'Network outage meeting',
      clientSecret: 'secret',
    });
    // Simulate the DNS-starvation symptom: every outbound fetch rejects with the
    // canonical undici network error.
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new Error('fetch failed');
    }));

    const service = createMeetingBotService();
    const result = await service.processAndSaveTranscript('bot-net');

    expect(result.success).toBe(false);
    // The fix: backoff is enforced so it is NOT re-fetched on the very next poll.
    expect(mockState.setNextRetryTime).toHaveBeenCalledWith('bot-net');
    // And the retry window is anchored to the first failure (so it can exhaust later).
    expect(mockState.ensureRetryWindowStarted).toHaveBeenCalledWith('bot-net');
    // Attempt is deliberately NOT incremented — a multi-hour outage must not burn
    // through MAX_SAVE_ATTEMPTS and prematurely mark a recoverable transcript failed.
    expect(mockState.incrementSaveAttempts).not.toHaveBeenCalled();
  });

  it('"not authenticated" remains the only no-backoff transient (auth initializes a beat after boot)', async () => {
    mockState.pending.set('bot-auth', {
      botId: 'bot-auth',
      status: 'ready',
      meetingTitle: 'Auth-not-ready meeting',
      clientSecret: 'secret',
    });
    // No authenticated user → backendFetch throws "User not authenticated".
    mockState.authUser = null;

    const service = createMeetingBotService();
    const result = await service.processAndSaveTranscript('bot-auth');

    expect(result.success).toBe(false);
    expect(mockState.setNextRetryTime).not.toHaveBeenCalled();
    expect(mockState.ensureRetryWindowStarted).not.toHaveBeenCalled();
    expect(mockState.incrementSaveAttempts).not.toHaveBeenCalled();
  });

  it('surfaces missing backend config and does not call fetch', async () => {
    mockState.pending.set('bot-config-missing', {
      botId: 'bot-config-missing',
      status: 'ready',
      meetingTitle: 'Config missing meeting',
      meetingUrl: 'https://example.com/meeting',
      clientSecret: 'secret',
    });
    mockState.backendConfig = {
      configured: false,
      missing: ['url', 'authKey'],
    };
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);

    const service = createMeetingBotService();
    const result = await service.processAndSaveTranscript('bot-config-missing');

    expect(result).toEqual({
      success: false,
      error: 'Meeting bot backend is not configured',
    });
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(mockState.logger.error).toHaveBeenCalledWith(
      {
        service: 'meetingBot',
        reason: 'meeting_bot_backend_config_missing',
        missing: ['url', 'authKey'],
      },
      'Meeting bot backend config missing; refusing backend request',
    );
  });
});

describe('meetingBotService Bug B — startup recovery concurrency cap', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mockState.authUser = { id: 'user-1', name: 'Storm Tester' };
    mockState.pending = new Map();
    mockState.unsavedTranscripts = [];
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('caps the startup recovery fan-out at 3 concurrent processAndSaveTranscript', async () => {
    // 12 unsaved transcripts from a previous session.
    mockState.unsavedTranscripts = Array.from({ length: 12 }, (_, i) => ({ botId: `bot-${i}` }));

    const service = createMeetingBotService();

    let inFlight = 0;
    let maxInFlight = 0;
    const resolvers: Array<() => void> = [];

    vi.spyOn(service, 'processAndSaveTranscript').mockImplementation(async () => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise<void>((resolve) => resolvers.push(() => {
        inFlight -= 1;
        resolve();
      }));
      return { success: true, filePath: '/tmp/x.md' };
    });

    service.startPolling();

    // Let the bounded workers start and reach their first await.
    await Promise.resolve();
    await Promise.resolve();

    expect(maxInFlight).toBeLessThanOrEqual(3);
    expect(maxInFlight).toBeGreaterThan(0);

    // Drain so the fire-and-forget promise can settle without unhandled rejection.
    while (resolvers.length > 0) {
      const next = resolvers.shift();
      next?.();
      await Promise.resolve();
      await Promise.resolve();
    }

    service.stopPolling();
  });
});
