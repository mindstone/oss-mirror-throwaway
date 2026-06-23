/**
 * Focused test for fail-closed behavior in Plaud recording save path.
 *
 * When sensitivity guard returns 'stage' but writeToPending returns null
 * (CoS unavailable), savePlaudRecording must throw — NOT fall through
 * to a direct write.
 *
 * This test verifies the behavior through syncPlaudRecordings, which
 * catches the error from savePlaudRecording.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { PlaudSyncState } from '../types';

// Mock electron app
vi.mock('electron', () => ({
  app: {
    getPath: () => '/mock/userData',
  },
}));

// Mock fs/promises
const mockFs = {
  readFile: vi.fn(),
  writeFile: vi.fn(),
  mkdir: vi.fn(),
  readdir: vi.fn(),
  stat: vi.fn(),
  unlink: vi.fn(),
  access: vi.fn(),
};
vi.mock('node:fs/promises', () => ({
  default: mockFs,
  ...mockFs,
}));

// Mock plaudAuthService
vi.mock('../plaudAuthService', () => ({
  getPlaudConfigDir: vi.fn(() => '/mock/userData/plaud'),
  isPlaudConnected: vi.fn(() => Promise.resolve(true)),
  ensureValidToken: vi.fn(() => Promise.resolve()),
}));

// Mock plaudApiClient
const mockApiClient = {
  fetchAllPlaudFiles: vi.fn(),
  fetchPlaudFileDetails: vi.fn(async (fileId: string) => ({
    id: fileId,
    presigned_url: 'https://example.com/audio.mp3',
    source_list: [] as unknown[],
    note_list: [] as unknown[],
    duration: 120_000,
    name: 'default.mp3',
    created_at: '2026-04-15T10:00:00Z',
    start_at: '2026-04-15T10:00:00Z',
    serial_number: 'SN-default',
  })),
  downloadAudioFile: vi.fn(),
  fileExists: vi.fn(),
};
vi.mock('../plaudApiClient', () => mockApiClient);

// Mock inboxStore
vi.mock('../../inboxStore', () => ({
  addInboxItem: vi.fn(),
}));

// Mock transcriptEventBus
const mockEmitTranscriptSaved = vi.fn();
vi.mock('../../meetingBot/transcriptEventBus', () => ({
  emitTranscriptSaved: mockEmitTranscriptSaved,
  deferTranscriptSaved: vi.fn(),
  emitTranscriptDistributionReady: vi.fn(),
}));

// Mock settingsStore
vi.mock('@core/services/settingsStore', () => ({
  setSettingsStoreAdapter: vi.fn(),
  getSettings: () => ({
    coreDirectory: '/mock/workspace',
    claude: { apiKey: 'test-key' },
    voice: { provider: 'openai-whisper', openaiApiKey: 'test-key' },
  }),
}));

// Mock behindTheScenesClient
vi.mock('../../behindTheScenesClient', () => ({
  callBehindTheScenesWithAuth: vi.fn(() => Promise.resolve({
    content: [{ type: 'text', text: 'Test Title' }],
  })),
}));

// Mock spaceService
vi.mock('../../spaceService', () => ({
  scanSpaces: vi.fn(() => Promise.resolve([{
    name: 'Chief of Staff',
    path: 'Chief-of-Staff',
    absolutePath: '/mock/workspace/Chief-of-Staff',
    type: 'chief-of-staff',
    sharing: 'private',
  }])),
  getSpaceDisplayName: vi.fn(() => 'Chief of Staff'),
}));

// Mock the Rebel auth boundary
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


// Mock transcript storage. The kernel's adapter (buildSaveMeetingSourceDeps)
// invokes both `findTranscriptByStableId` (dedup) and `getUniqueFilePath`
// (allow-path); plaudSyncService imports both as named exports. Without the
// `getUniqueFilePath` mock, the module-level import lands as `undefined` and
// the kernel throws before reaching writeToPending.
vi.mock('../../meetingBot/transcriptStorage', () => ({
  findTranscriptByStableId: vi.fn(() => Promise.resolve(null)),
  getUniqueFilePath: vi.fn(async (filePath: string) => filePath),
}));

// Mock calendar enrichment (kernel calls it during the save pipeline).
vi.mock('../../calendar/calendarEnrichment', () => ({
  enrichMeetingFromCalendarCache: vi.fn(() => Promise.resolve({ matched: false })),
}));

// Mock sensitivity guard — STAGE decision
const mockEvaluateTranscriptForSharedSpace = vi.fn(
  () => Promise.resolve({ decision: 'stage' as const, summary: 'Sensitive content' })
);
vi.mock('../../meetingBot/transcriptSensitivityGuard', () => ({
  evaluateTranscriptForSharedSpace: mockEvaluateTranscriptForSharedSpace,
  broadcastTranscriptStagingEvents: vi.fn(),
}));

// Mock cosPendingService — null (CoS unavailable)
const mockWriteToPending = vi.fn(() => Promise.resolve(null));
vi.mock('../../safety/cosPendingService', () => ({
  writeToPending: mockWriteToPending,
}));

// Mock axios (for transcription)
vi.mock('axios', () => ({
  default: {
    post: vi.fn(() => Promise.resolve({ data: { text: 'Test transcript' } })),
  },
}));

// Mock local STT
vi.mock('../../localSttService', () => ({
  isModelReady: vi.fn(() => Promise.resolve(false)),
  transcribeWithLocalModel: vi.fn(),
}));

// Mock providerKeys
vi.mock('@shared/utils/providerKeys', () => ({
  getProviderKey: vi.fn(() => 'test-openai-key'),
}));

// Mock audioChunking
vi.mock('@core/services/audioChunking', () => ({
  isChunkingRequired: vi.fn(() => false),
  MAX_FILE_SIZE_BYTES: 20 * 1024 * 1024,
}));

// Mock costLedgerService
vi.mock('@core/services/costLedgerService', () => ({
  appendCostEntry: vi.fn(() => ({ costEntryId: 'test-cost-entry-id' })),
}));

// Mock tracking
vi.mock('@core/tracking', () => ({
  getTracker: () => ({ track: vi.fn() }),
}));

// Mock sttPricingCalculator
vi.mock('@shared/utils/sttPricingCalculator', () => ({
  calculateSttCost: vi.fn(() => 0.01),
}));

describe('savePlaudRecording fail-closed', () => {
  let syncModule: typeof import('../plaudSyncService');

  beforeEach(async () => {
    vi.clearAllMocks();

    // Default file operations
    mockFs.writeFile.mockResolvedValue(undefined);
    mockFs.mkdir.mockResolvedValue(undefined);
    mockFs.readdir.mockResolvedValue([]);
    mockFs.unlink.mockResolvedValue(undefined);
    mockFs.stat.mockResolvedValue({ size: 1024 * 1024 }); // 1MB

    // Guard: stage decision, writeToPending returns null
    mockEvaluateTranscriptForSharedSpace.mockResolvedValue({ decision: 'stage', summary: 'Sensitive' });
    mockWriteToPending.mockResolvedValue(null);

    // Dynamic import — module state is fresh since mocks are in place
    syncModule = await import('../plaudSyncService');
  });

  afterEach(() => {
    syncModule.stopPeriodicSync();
  });

  it('blocks direct write and counts as error when guard requires staging but CoS is unavailable', async () => {
    const syncState: PlaudSyncState = {
      lastSyncTime: null,
      processedFileIds: [],
      failureCounts: {},
      notifiedFileIds: [],
      abandonedFileIds: [],
    };

    const metaJson = JSON.stringify({
      id: 'file-sensitive',
      start_at: '2026-04-15T10:00:00Z',
      duration: 120000,
    });

    // Route readFile calls: 1=sync state, 2=audio, 3=meta
    let callIndex = 0;
    mockFs.readFile.mockImplementation(() => {
      callIndex++;
      if (callIndex === 1) return Promise.resolve(JSON.stringify(syncState));
      if (callIndex === 2) return Promise.resolve(Buffer.from('audio data'));
      if (callIndex === 3) return Promise.resolve(metaJson);
      return Promise.reject(new Error('ENOENT'));
    });

    mockApiClient.fileExists.mockResolvedValue(true);
    mockApiClient.fetchAllPlaudFiles.mockResolvedValue([{
      id: 'file-sensitive',
      name: 'sensitive.mp3',
      created_at: '2026-04-15T10:00:00Z',
      start_at: '2026-04-15T10:00:00Z',
      duration: 120000,
      serial_number: 'SN123',
    }]);

    syncModule.initializePlaudSyncService({ getSyncIntervalMinutes: () => 15 });
    const result = await syncModule.syncPlaudRecordings();

    // The throw from savePlaudRecording should be caught → error count
    expect(result.errors).toBe(1);
    expect(result.synced).toBe(0);

    // No transcript saved event (write was blocked)
    expect(mockEmitTranscriptSaved).not.toHaveBeenCalled();

    // Verify writeToPending WAS called (the guard tried to stage)
    expect(mockWriteToPending).toHaveBeenCalled();

    // Verify NO direct file write occurred (only sync state writes)
    const nonStateWrites = mockFs.writeFile.mock.calls.filter(
      (call) => typeof call[0] === 'string' && !call[0].includes('sync-state.json') && !call[0].includes('.meta.json')
    );
    expect(nonStateWrites).toHaveLength(0);
  });

  it('blocks direct write on the Plaud-supplied branch when guard requires staging but CoS is unavailable', async () => {
    // Same FOX-3043 invariant as above, but with Plaud's server-side
    // transcript path instead of local STT. Both branches must converge on
    // the same savePlaudRecording adapter, so the guard fires identically.
    const syncState: PlaudSyncState = {
      lastSyncTime: null,
      processedFileIds: [],
      failureCounts: {},
      notifiedFileIds: [],
      abandonedFileIds: [],
    };

    let callIndex = 0;
    mockFs.readFile.mockImplementation(() => {
      callIndex++;
      if (callIndex === 1) return Promise.resolve(JSON.stringify(syncState));
      if (callIndex === 2) return Promise.resolve(JSON.stringify({
        id: 'file-plaud-sensitive',
        start_at: '2026-04-15T10:00:00Z',
        duration: 120_000,
      }));
      return Promise.reject(new Error('ENOENT'));
    });

    mockApiClient.fileExists.mockResolvedValue(false);
    const file = {
      id: 'file-plaud-sensitive',
      name: 'sensitive-plaud.mp3',
      created_at: '2026-04-15T10:00:00Z',
      start_at: '2026-04-15T10:00:00Z',
      duration: 120_000,
      serial_number: 'SN-PLAUD',
    };
    mockApiClient.fetchAllPlaudFiles.mockResolvedValue([file]);
    mockApiClient.fetchPlaudFileDetails.mockResolvedValue({
      ...file,
      presigned_url: 'https://example.com/plaud.mp3',
      source_list: [
        { text: 'Plaud-supplied transcript with sensitive content.', start_time: 0, end_time: 60 },
        { text: 'More sensitive content.', start_time: 60, end_time: 120 },
      ] as unknown[],
      note_list: [] as unknown[],
    });

    syncModule.initializePlaudSyncService({ getSyncIntervalMinutes: () => 15 });
    const result = await syncModule.syncPlaudRecordings();

    expect(result.errors).toBe(1);
    expect(result.synced).toBe(0);

    // Plaud-supplied branch should NOT have called downloadAudioFile or axios
    expect(mockApiClient.downloadAudioFile).not.toHaveBeenCalled();
    expect(mockEmitTranscriptSaved).not.toHaveBeenCalled();
    expect(mockWriteToPending).toHaveBeenCalled();

    const nonStateWrites = mockFs.writeFile.mock.calls.filter(
      (call) => typeof call[0] === 'string' && !call[0].includes('sync-state.json') && !call[0].includes('.meta.json')
    );
    expect(nonStateWrites).toHaveLength(0);
  });
});
