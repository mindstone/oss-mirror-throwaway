import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';

vi.mock('electron', () => ({
  app: { getPath: () => '/mock/userData' },
}));

const mockFs = {
  readFile: vi.fn(),
  writeFile: vi.fn(),
  mkdir: vi.fn(),
  readdir: vi.fn(),
  stat: vi.fn(),
  unlink: vi.fn(),
  access: vi.fn(),
};
vi.mock('node:fs/promises', () => ({ default: mockFs, ...mockFs }));

const mockAuthService = {
  getPlaudConfigDir: vi.fn(() => '/mock/userData/plaud'),
  isPlaudConnected: vi.fn(() => Promise.resolve(true)),
  ensureValidToken: vi.fn(() => Promise.resolve()),
};
vi.mock('../plaudAuthService', () => mockAuthService);

const mockApiClient = {
  fetchPlaudFiles: vi.fn(),
  fetchAllPlaudFiles: vi.fn(() => Promise.resolve([])),
  fetchPlaudFileDetails: vi.fn(),
  downloadAudioFile: vi.fn(),
  fileExists: vi.fn(() => Promise.resolve(false)),
};
vi.mock('../plaudApiClient', () => mockApiClient);

const mockAddInboxItem = vi.fn();
vi.mock('../../inboxStore', () => ({ addInboxItem: mockAddInboxItem }));

vi.mock('../../meetingBot/transcriptEventBus', () => ({
  emitTranscriptSaved: vi.fn(),
  deferTranscriptSaved: vi.fn(),
  emitTranscriptDistributionReady: vi.fn(),
}));

vi.mock('../../meetingBot/transcriptStorage', () => ({
  findTranscriptByStableId: vi.fn(() => Promise.resolve(null)),
  getUniqueFilePath: vi.fn(async (filePath: string) => filePath),
}));

vi.mock('../../calendar/calendarEnrichment', () => ({
  enrichMeetingFromCalendarCache: vi.fn(() => Promise.resolve({ matched: false })),
}));

vi.mock('@core/services/settingsStore', () => ({
  setSettingsStoreAdapter: vi.fn(),
  getSettings: () => ({
    coreDirectory: '/mock/workspace',
    claude: { apiKey: 'test-key' },
    voice: { openaiApiKey: 'test-openai-key' },
    meetingBot: { physicalMeetingSpaceId: null },
  }),
}));

vi.mock('../../behindTheScenesClient', () => ({
  callBehindTheScenesWithAuth: vi.fn(() => Promise.resolve({
    content: [{ type: 'text', text: 'Test Title' }],
  })),
}));

vi.mock('../../spaceService', () => ({
  scanSpaces: vi.fn(() => Promise.resolve([])),
  getSpaceDisplayName: vi.fn((space: { name: string }) => space.name),
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
      getAuthState: () => ({ user: { email: 'test@example.com' } }),
  }),
  setRebelAuthProvider: vi.fn(),
  NULL_REBEL_AUTH_PROVIDER: {},
}));

vi.mock('../../meetingBot/transcriptSensitivityGuard', () => ({
  evaluateTranscriptForSharedSpace: vi.fn(() => Promise.resolve({ decision: 'allow' as const })),
  broadcastTranscriptStagingEvents: vi.fn(),
}));

vi.mock('../../safety/cosPendingService', () => ({
  writeToPending: vi.fn(() => Promise.resolve(null)),
}));

vi.mock('axios', () => ({ default: { post: vi.fn() } }));

vi.mock('../../localSttService', () => ({
  isModelReady: vi.fn(() => Promise.resolve(false)),
  transcribeWithLocalModel: vi.fn(),
}));

describe('plaudSyncService periodic sync lifecycle (REBEL-5K0 regression)', () => {
  let syncModule: typeof import('../plaudSyncService');

  beforeAll(async () => {
    syncModule = await import('../plaudSyncService');
  });

  beforeEach(() => {
    vi.clearAllMocks();
    mockFs.readFile.mockRejectedValue(new Error('ENOENT'));
    mockFs.writeFile.mockResolvedValue(undefined);
    mockFs.mkdir.mockResolvedValue(undefined);
    mockFs.readdir.mockResolvedValue([]);
    mockFs.unlink.mockResolvedValue(undefined);
    mockFs.stat.mockResolvedValue({ size: 1024 * 1024 });
    mockAuthService.isPlaudConnected.mockResolvedValue(true);
    mockAuthService.ensureValidToken.mockResolvedValue(undefined);
  });

  afterEach(() => {
    syncModule.stopPeriodicSync();
    vi.useRealTimers();
  });

  it('arms the periodic timer even when ensureValidToken throws at startup', async () => {
    mockAuthService.ensureValidToken.mockRejectedValueOnce(
      new Error('fetch failed')
    );

    syncModule.initializePlaudSyncService({ getSyncIntervalMinutes: () => 15 });

    vi.useFakeTimers();
    await syncModule.startPeriodicSync();

    mockAuthService.ensureValidToken.mockResolvedValue(undefined);

    await vi.advanceTimersByTimeAsync(15 * 60 * 1000 + 5_000);

    expect(mockApiClient.fetchAllPlaudFiles.mock.calls.length).toBeGreaterThanOrEqual(1);
  });

  it('recovers within one interval after the user re-authenticates without an app restart', async () => {
    mockAuthService.ensureValidToken.mockRejectedValueOnce(
      new Error('Token refresh failed: 503 Service Unavailable')
    );

    syncModule.initializePlaudSyncService({ getSyncIntervalMinutes: () => 15 });

    vi.useFakeTimers();
    await syncModule.startPeriodicSync();

    expect(mockApiClient.fetchAllPlaudFiles.mock.calls.length).toBe(0);

    await vi.advanceTimersByTimeAsync(15 * 60 * 1000 + 5_000);

    expect(mockApiClient.fetchAllPlaudFiles.mock.calls.length).toBeGreaterThanOrEqual(1);
  });

  it('does not arm the periodic timer when no Plaud account is connected', async () => {
    mockAuthService.isPlaudConnected.mockResolvedValue(false);

    syncModule.initializePlaudSyncService({ getSyncIntervalMinutes: () => 15 });

    vi.useFakeTimers();
    await syncModule.startPeriodicSync();

    await vi.advanceTimersByTimeAsync(60 * 60 * 1000);

    expect(mockApiClient.fetchAllPlaudFiles.mock.calls.length).toBe(0);
  });

  it('arms the timer and ticks on schedule when auth succeeds at startup', async () => {
    syncModule.initializePlaudSyncService({ getSyncIntervalMinutes: () => 15 });

    vi.useFakeTimers();
    await syncModule.startPeriodicSync();

    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(15 * 60 * 1000 + 5_000);

    expect(mockApiClient.fetchAllPlaudFiles.mock.calls.length).toBeGreaterThanOrEqual(1);
  });
});
