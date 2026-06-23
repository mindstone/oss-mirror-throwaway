import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import type { PlaudSyncState } from '../types';
import _path from 'node:path';

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

// Mock logger

// Mock plaudAuthService
const mockAuthService = {
  getPlaudConfigDir: vi.fn(() => '/mock/userData/plaud'),
  isPlaudConnected: vi.fn(() => Promise.resolve(true)),
  ensureValidToken: vi.fn(() => Promise.resolve()),
};
vi.mock('../plaudAuthService', () => mockAuthService);

// Mock plaudApiClient
const mockApiClient = {
  fetchPlaudFiles: vi.fn(),
  fetchAllPlaudFiles: vi.fn(),
  fetchPlaudFileDetails: vi.fn(),
  downloadAudioFile: vi.fn(),
  fileExists: vi.fn(),
};
vi.mock('../plaudApiClient', () => mockApiClient);

// Mock inboxStore
const mockAddInboxItem = vi.fn();
vi.mock('../../inboxStore', () => ({
  addInboxItem: mockAddInboxItem,
}));

// Mock transcriptEventBus
const mockEmitTranscriptSaved = vi.fn();
const mockEmitTranscriptDistributionReady = vi.fn();
const mockDeferTranscriptSaved = vi.fn();
vi.mock('../../meetingBot/transcriptEventBus', () => ({
  emitTranscriptSaved: mockEmitTranscriptSaved,
  deferTranscriptSaved: mockDeferTranscriptSaved,
  emitTranscriptDistributionReady: mockEmitTranscriptDistributionReady,
}));

// Mock transcriptStorage. plaudSyncService imports both `findTranscriptByStableId`
// and `getUniqueFilePath` and feeds them into the kernel's adapter. Without
// these mocks the kernel hits the real implementations: findTranscriptByStableId
// walks year/month/day folders via fs.readdir, and getUniqueFilePath retries
// 100x against the bare mockFs.access (which resolves to undefined, looking
// like the file always exists), eventually throwing "Too many file collisions"
// and short-circuiting the save before emitTranscriptSaved.
vi.mock('../../meetingBot/transcriptStorage', () => ({
  findTranscriptByStableId: vi.fn(() => Promise.resolve(null)),
  getUniqueFilePath: vi.fn(async (filePath: string) => filePath),
}));

// Mock calendar enrichment (kernel calls it during the save pipeline).
vi.mock('../../calendar/calendarEnrichment', () => ({
  enrichMeetingFromCalendarCache: vi.fn(() => Promise.resolve({ matched: false })),
}));

// Mock settingsStore
vi.mock('@core/services/settingsStore', () => ({
  setSettingsStoreAdapter: vi.fn(),
  getSettings: () => ({
    coreDirectory: '/mock/workspace',
    claude: { apiKey: 'test-key' },
    voice: { openaiApiKey: 'test-openai-key' },
    meetingBot: { physicalMeetingSpaceId: null },
  }),
}));

vi.mock('@shared/utils/providerKeys', () => ({
  getProviderKey: vi.fn(() => 'test-openai-key'),
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
    slug: 'chief-of-staff',
    type: 'chief-of-staff',
  }])),
  getSpaceDisplayName: vi.fn((space: { name: string }) => space.name),
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


// Mock transcript sensitivity guard (default: allow all saves)
const mockEvaluateTranscriptForSharedSpace = vi.fn(() => Promise.resolve({ decision: 'allow' as const }));
const mockBroadcastTranscriptStagingEvents = vi.fn();
vi.mock('../../meetingBot/transcriptSensitivityGuard', () => ({
  evaluateTranscriptForSharedSpace: mockEvaluateTranscriptForSharedSpace,
  broadcastTranscriptStagingEvents: mockBroadcastTranscriptStagingEvents,
}));

// Mock cosPendingService
const mockWriteToPending = vi.fn(() => Promise.resolve(null));
vi.mock('../../safety/cosPendingService', () => ({
  writeToPending: mockWriteToPending,
}));

// Mock axios
const mockAxiosPost = vi.fn(() => Promise.resolve({ data: { text: 'Test transcript' } }));
vi.mock('axios', () => ({
  default: {
    post: mockAxiosPost,
  },
}));

// Mock local STT so tests are deterministic across machines
vi.mock('../../localSttService', () => ({
  isModelReady: vi.fn(() => Promise.resolve(false)),
  transcribeWithLocalModel: vi.fn(),
}));

// Mock cost ledger so we can assert the Plaud-supplied zero-cost emit
const mockAppendCostEntry = vi.fn(() => ({ costEntryId: 'test-cost-entry-id' }));
vi.mock('@core/services/costLedgerService', () => ({
  appendCostEntry: mockAppendCostEntry,
}));

// Mock tracker so we can assert the 'STT Transcription Completed' event
const mockTrack = vi.fn();
vi.mock('@core/tracking', () => ({
  getTracker: () => ({ track: mockTrack }),
}));

// Mock STT pricing so the local-STT branch's cost calc returns a real number
vi.mock('@shared/utils/sttPricingCalculator', () => ({
  calculateSttCost: vi.fn(() => 0.01),
}));

// Test helpers
function createMockSyncState(overrides: Partial<PlaudSyncState> = {}): PlaudSyncState {
  return {
    lastSyncTime: null,
    processedFileIds: [],
    failureCounts: {},
    ...overrides,
  };
}

describe('plaudSyncService', () => {
  let syncModule: typeof import('../plaudSyncService');

  beforeAll(async () => {
    syncModule = await import('../plaudSyncService');
  });

  beforeEach(() => {
    vi.clearAllMocks();
    // Default: sync state file doesn't exist
    mockFs.readFile.mockRejectedValue(new Error('ENOENT'));
    mockFs.writeFile.mockResolvedValue(undefined);
    mockFs.mkdir.mockResolvedValue(undefined);
    mockFs.readdir.mockResolvedValue([]);
    mockFs.unlink.mockResolvedValue(undefined);
    // Default: stat returns small file size (under 20MB limit)
    mockFs.stat.mockResolvedValue({ size: 1024 * 1024 }); // 1MB
    // Default: axios transcription succeeds
    mockAxiosPost.mockResolvedValue({ data: { text: 'Test transcript' } });
    // Default: Plaud file details return an empty source_list so the selector
    // returns fallback_local and the local-STT path runs (matches pre-Stage-2
    // behaviour for tests that don't care about the Plaud-supplied branch).
    mockApiClient.fetchPlaudFileDetails.mockImplementation(async (fileId: string) => ({
      id: fileId,
      presigned_url: 'https://example.com/audio.mp3',
      source_list: [],
      note_list: [],
      duration: 60_000,
      name: 'default.mp3',
      created_at: '2026-01-13T10:00:00Z',
      start_at: '2026-01-13T10:00:00Z',
      serial_number: 'SN-default',
    }));
  });

  afterEach(() => {
    syncModule.stopPeriodicSync();
  });

  describe('inProgressFileId restart semantics', () => {
    it('marks file as processed when staging files are gone and not in processedFileIds', async () => {
      // Setup: inProgressFileId set, but staging files gone
      const savedState = createMockSyncState({
        inProgressFileId: 'file-123',
        processedFileIds: [],
      });
      mockFs.readFile.mockResolvedValueOnce(JSON.stringify(savedState));
      
      // Staging files don't exist
      mockApiClient.fileExists.mockResolvedValue(false);
      
      // No new files to process
      mockApiClient.fetchAllPlaudFiles.mockResolvedValue([]);
      
      // Initialize and run sync
      syncModule.initializePlaudSyncService({
        getSyncIntervalMinutes: () => 15,
      });
      
      await syncModule.syncPlaudRecordings();
      
      // Should have saved state with file marked as processed
      const savedCalls = mockFs.writeFile.mock.calls;
      const lastSave = savedCalls.find(call => 
        call[0].includes('sync-state.json')
      );
      expect(lastSave).toBeDefined();
      
      const savedData = JSON.parse(lastSave![1]);
      expect(savedData.processedFileIds).toContain('file-123');
      expect(savedData.inProgressFileId).toBeUndefined();
    });

    it('retries when staging files still exist', async () => {
      const savedState = createMockSyncState({
        inProgressFileId: 'file-456',
        processedFileIds: [],
      });
      mockFs.readFile
        .mockResolvedValueOnce(JSON.stringify(savedState))
        .mockResolvedValueOnce(Buffer.from('audio data')) // audio file for transcription
        .mockResolvedValueOnce(JSON.stringify({ // meta file
          id: 'file-456',
          start_at: '2026-01-13T10:00:00Z',
          duration: 60000,
        }));
      
      // Staging files exist
      mockApiClient.fileExists.mockResolvedValue(true);
      
      // File is in the list from API
      mockApiClient.fetchAllPlaudFiles.mockResolvedValue([{
        id: 'file-456',
        name: 'test.mp3',
        created_at: '2026-01-13T10:00:00Z',
        start_at: '2026-01-13T10:00:00Z',
        duration: 60000,
        serial_number: 'SN123',
      }]);
      
      syncModule.initializePlaudSyncService({
        getSyncIntervalMinutes: () => 15,
      });
      
      await syncModule.syncPlaudRecordings();
      
      // File should have been processed (transcript event emitted)
      expect(mockEmitTranscriptSaved).toHaveBeenCalled();
    });

    it('clears inProgressFileId even when file already in processedFileIds', async () => {
      const savedState = createMockSyncState({
        inProgressFileId: 'file-789',
        processedFileIds: ['file-789'], // Already processed
      });
      mockFs.readFile.mockResolvedValueOnce(JSON.stringify(savedState));
      mockApiClient.fileExists.mockResolvedValue(false);
      mockApiClient.fetchAllPlaudFiles.mockResolvedValue([]);
      
      syncModule.initializePlaudSyncService({
        getSyncIntervalMinutes: () => 15,
      });
      
      await syncModule.syncPlaudRecordings();
      
      // inProgressFileId should be cleared, processedFileIds unchanged
      const savedCalls = mockFs.writeFile.mock.calls;
      const lastSave = savedCalls.find(call => 
        call[0].includes('sync-state.json')
      );
      expect(lastSave).toBeDefined();
      
      const savedData = JSON.parse(lastSave![1]);
      expect(savedData.inProgressFileId).toBeUndefined();
      // Should not duplicate
      expect(savedData.processedFileIds.filter((id: string) => id === 'file-789').length).toBe(1);
    });
  });

  describe('auth failure notification throttling', () => {
    it('notifies user on first auth failure', async () => {
      mockFs.readFile.mockResolvedValueOnce(JSON.stringify(createMockSyncState()));
      mockAuthService.ensureValidToken.mockRejectedValueOnce(new Error('401 Unauthorized'));
      
      syncModule.initializePlaudSyncService({
        getSyncIntervalMinutes: () => 15,
      });
      
      await syncModule.syncPlaudRecordings();
      
      expect(mockAddInboxItem).toHaveBeenCalledWith(
        expect.objectContaining({
          title: 'Plaud connection expired',
        })
      );
    });

    it('throttles auth failure notifications within 24 hours', async () => {
      const recentNotification = new Date(Date.now() - 1000 * 60 * 60).toISOString(); // 1 hour ago
      mockFs.readFile.mockResolvedValueOnce(JSON.stringify(createMockSyncState({
        lastAuthNotificationAt: recentNotification,
      })));
      mockAuthService.ensureValidToken.mockRejectedValueOnce(new Error('refresh token expired'));
      
      syncModule.initializePlaudSyncService({
        getSyncIntervalMinutes: () => 15,
      });
      
      await syncModule.syncPlaudRecordings();
      
      // Should NOT have added inbox item
      expect(mockAddInboxItem).not.toHaveBeenCalledWith(
        expect.objectContaining({
          title: 'Plaud connection expired',
        })
      );
    });

    it('notifies again after 24 hours', async () => {
      const oldNotification = new Date(Date.now() - 1000 * 60 * 60 * 25).toISOString(); // 25 hours ago
      mockFs.readFile.mockResolvedValueOnce(JSON.stringify(createMockSyncState({
        lastAuthNotificationAt: oldNotification,
      })));
      mockAuthService.ensureValidToken.mockRejectedValueOnce(new Error('401 Unauthorized'));
      
      syncModule.initializePlaudSyncService({
        getSyncIntervalMinutes: () => 15,
      });
      
      await syncModule.syncPlaudRecordings();
      
      expect(mockAddInboxItem).toHaveBeenCalledWith(
        expect.objectContaining({
          title: 'Plaud connection expired',
        })
      );
    });
  });

  describe('audio+meta atomicity', () => {
    it('regenerates meta when audio exists but meta is missing', async () => {
      mockFs.readFile.mockResolvedValueOnce(JSON.stringify(createMockSyncState()));
      
      // Audio exists, meta doesn't
      mockApiClient.fileExists
        .mockResolvedValueOnce(false) // stagingFilesExist check
        .mockResolvedValueOnce(true)  // audio exists
        .mockResolvedValueOnce(false); // meta doesn't exist
      
      mockApiClient.fetchAllPlaudFiles.mockResolvedValue([{
        id: 'file-new',
        name: 'test.mp3',
        created_at: '2026-01-13T10:00:00Z',
        start_at: '2026-01-13T10:00:00Z',
        duration: 60000,
        serial_number: 'SN123',
      }]);
      
      mockApiClient.fetchPlaudFileDetails.mockResolvedValue({
        id: 'file-new',
        presigned_url: 'https://example.com/audio.mp3',
      });
      
      syncModule.initializePlaudSyncService({
        getSyncIntervalMinutes: () => 15,
      });
      
      await syncModule.syncPlaudRecordings();
      
      // Should have written meta file
      expect(mockFs.writeFile).toHaveBeenCalledWith(
        expect.stringContaining('file-new.meta.json'),
        expect.any(String)
      );
    });
  });

  describe('failure tracking', () => {
    it('adds inbox notification after 2 failures', async () => {
      mockFs.readFile
        .mockResolvedValueOnce(JSON.stringify(createMockSyncState({
          failureCounts: { 'file-fail': 1 }, // Already failed once
        })))
        .mockResolvedValueOnce(JSON.stringify({ // meta file
          id: 'file-fail',
          start_at: '2026-01-13T10:00:00Z',
          duration: 60000,
        }));
      
      mockApiClient.fileExists.mockResolvedValue(true);
      mockApiClient.fetchAllPlaudFiles.mockResolvedValue([{
        id: 'file-fail',
        name: 'test.mp3',
        created_at: '2026-01-13T10:00:00Z',
        start_at: '2026-01-13T10:00:00Z',
        duration: 60000,
        serial_number: 'SN123',
      }]);
      
      // Make transcription fail
      mockAxiosPost.mockRejectedValueOnce(new Error('Transcription failed'));
      
      syncModule.initializePlaudSyncService({
        getSyncIntervalMinutes: () => 15,
      });
      
      await syncModule.syncPlaudRecordings();
      
      // Should have added inbox item for failure
      expect(mockAddInboxItem).toHaveBeenCalledWith(
        expect.objectContaining({
          title: 'Plaud recording import struggling',
          source: expect.objectContaining({
            kind: 'text',
            label: 'Plaud',
          }),
          category: 'system',
        })
      );
    });

    it('does not notify on first failure', async () => {
      mockFs.readFile
        .mockResolvedValueOnce(JSON.stringify(createMockSyncState()))
        .mockResolvedValueOnce(JSON.stringify({ // meta file
          id: 'file-fail',
          start_at: '2026-01-13T10:00:00Z',
          duration: 60000,
        }));
      
      mockApiClient.fileExists.mockResolvedValue(true);
      mockApiClient.fetchAllPlaudFiles.mockResolvedValue([{
        id: 'file-fail',
        name: 'test.mp3',
        created_at: '2026-01-13T10:00:00Z',
        start_at: '2026-01-13T10:00:00Z',
        duration: 60000,
        serial_number: 'SN123',
      }]);
      
      // Make transcription fail
      mockAxiosPost.mockRejectedValueOnce(new Error('Transcription failed'));
      
      syncModule.initializePlaudSyncService({
        getSyncIntervalMinutes: () => 15,
      });
      
      await syncModule.syncPlaudRecordings();
      
      // Should NOT have added warning inbox item (only 1 failure)
      expect(mockAddInboxItem).not.toHaveBeenCalledWith(
        expect.objectContaining({
          title: 'Plaud recording import struggling',
        })
      );
    });
  });

  describe('processedFileIds tracking', () => {
    it('marks file as processed only after successful processing', async () => {
      mockFs.readFile
        .mockResolvedValueOnce(JSON.stringify(createMockSyncState()))
        .mockResolvedValueOnce(Buffer.from('audio data')) // audio file
        .mockResolvedValueOnce(JSON.stringify({ // meta file
          id: 'file-success',
          start_at: '2026-01-13T10:00:00Z',
          duration: 60000,
        }));
      
      mockApiClient.fileExists.mockResolvedValue(true);
      mockApiClient.fetchAllPlaudFiles.mockResolvedValue([{
        id: 'file-success',
        name: 'test.mp3',
        created_at: '2026-01-13T10:00:00Z',
        start_at: '2026-01-13T10:00:00Z',
        duration: 60000,
        serial_number: 'SN123',
      }]);
      
      syncModule.initializePlaudSyncService({
        getSyncIntervalMinutes: () => 15,
      });
      
      await syncModule.syncPlaudRecordings();
      
      // Should have saved with file in processedFileIds
      const savedCalls = mockFs.writeFile.mock.calls;
      const finalSave = savedCalls.filter(call => 
        call[0].includes('sync-state.json')
      ).pop();
      
      expect(finalSave).toBeDefined();
      const savedData = JSON.parse(finalSave![1]);
      expect(savedData.processedFileIds).toContain('file-success');
    });

    it('does not mark file as processed on failure', async () => {
      mockFs.readFile
        .mockResolvedValueOnce(JSON.stringify(createMockSyncState()))
        .mockResolvedValueOnce(Buffer.from('audio data')) // audio file
        .mockResolvedValueOnce(JSON.stringify({ // meta file
          id: 'file-fail',
          start_at: '2026-01-13T10:00:00Z',
          duration: 60000,
        }));
      
      mockApiClient.fileExists.mockResolvedValue(true);
      mockApiClient.fetchAllPlaudFiles.mockResolvedValue([{
        id: 'file-fail',
        name: 'test.mp3',
        created_at: '2026-01-13T10:00:00Z',
        start_at: '2026-01-13T10:00:00Z',
        duration: 60000,
        serial_number: 'SN123',
      }]);
      
      // Make transcription fail
      mockAxiosPost.mockRejectedValueOnce(new Error('Transcription failed'));
      
      syncModule.initializePlaudSyncService({
        getSyncIntervalMinutes: () => 15,
      });
      
      await syncModule.syncPlaudRecordings();
      
      // Should NOT have file in processedFileIds
      const savedCalls = mockFs.writeFile.mock.calls;
      const finalSave = savedCalls.filter(call => 
        call[0].includes('sync-state.json')
      ).pop();
      
      expect(finalSave).toBeDefined();
      const savedData = JSON.parse(finalSave![1]);
      expect(savedData.processedFileIds).not.toContain('file-fail');
    });
  });

  describe('transient vs permanent error classification', () => {
    it('classifies fetch failed as transient', () => {
      expect(syncModule.isTransientError(new TypeError('fetch failed'))).toBe(true);
    });

    it('classifies ECONNRESET as transient', () => {
      const err = new Error('connection reset');
      (err as NodeJS.ErrnoException).code = 'ECONNRESET';
      expect(syncModule.isTransientError(err)).toBe(true);
    });

    it('classifies ECONNABORTED as transient', () => {
      const err = new Error('timeout of 1800000ms exceeded');
      (err as NodeJS.ErrnoException).code = 'ECONNABORTED';
      expect(syncModule.isTransientError(err)).toBe(true);
    });

    it('classifies ETIMEDOUT as transient', () => {
      const err = new Error('connect ETIMEDOUT');
      (err as NodeJS.ErrnoException).code = 'ETIMEDOUT';
      expect(syncModule.isTransientError(err)).toBe(true);
    });

    it('classifies 503 as transient', () => {
      expect(syncModule.isTransientError(new Error('503 Service Unavailable'))).toBe(true);
    });

    it('classifies 429 rate limit as transient', () => {
      expect(syncModule.isTransientError(new Error('429 rate limit exceeded'))).toBe(true);
    });

    it('classifies auth errors as permanent', () => {
      expect(syncModule.isTransientError(new Error('401 Unauthorized'))).toBe(false);
    });

    it('classifies 404 as permanent', () => {
      expect(syncModule.isTransientError(new Error('404 Not Found'))).toBe(false);
    });

    it('classifies generic errors as permanent', () => {
      expect(syncModule.isTransientError(new Error('No workspace configured'))).toBe(false);
    });

    it('does not count transient errors toward abandonment', async () => {
      // Even with MAX_RETRY_ATTEMPTS-1 permanent failures, a transient error
      // should NOT push the file into abandonedFileIds. We test indirectly:
      // if all 6 failures are transient (network), the file must never be abandoned.
       
      (mockFs.readFile as any).mockImplementation((filePath: string) => {
        if (filePath.includes('sync-state.json')) {
          return Promise.resolve(JSON.stringify(createMockSyncState()));
        }
        return Promise.reject(new Error('ENOENT'));
      });
      mockApiClient.fileExists.mockResolvedValue(false);
      mockApiClient.fetchAllPlaudFiles.mockResolvedValue([{
        id: 'file-net', name: 'test.mp3', created_at: '2026-01-13T10:00:00Z',
        start_at: '2026-01-13T10:00:00Z', duration: 60000, serial_number: 'SN123',
      }]);
      mockApiClient.fetchPlaudFileDetails.mockRejectedValue(new TypeError('fetch failed'));

      syncModule.initializePlaudSyncService({ getSyncIntervalMinutes: () => 15 });

      // Run sync 6 times (more than MAX_RETRY_ATTEMPTS=5) — all transient
      for (let i = 0; i < 6; i++) {
        await syncModule.syncPlaudRecordings();
      }

      const savedCalls = mockFs.writeFile.mock.calls;
      const finalSave = savedCalls.filter(call =>
        call[0].includes('sync-state.json')
      ).pop();
      expect(finalSave).toBeDefined();
      const savedData = JSON.parse(finalSave![1]);
      // Transient errors should never cause abandonment, even after 6 attempts
      expect(savedData.abandonedFileIds ?? []).not.toContain('file-net');
      // Failure count stays at 0 (transient errors don't increment)
      expect(savedData.failureCounts['file-net']).toBe(0);
    });
  });

  describe('abandoned file re-examination', () => {
    it('re-examines abandoned files after 24h cooldown', async () => {
      const oldTimestamp = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString(); // 25h ago
       
      (mockFs.readFile as any).mockImplementation((filePath: string) => {
        if (filePath.includes('sync-state.json')) {
          return Promise.resolve(JSON.stringify({
            lastSyncTime: null,
            processedFileIds: [],
            failureCounts: { 'file-old': 5 },
            notifiedFileIds: [],
            abandonedFileIds: ['file-old'],
            abandonedAt: { 'file-old': oldTimestamp },
          }));
        }
        return Promise.reject(new Error('ENOENT'));
      });

      mockApiClient.fileExists.mockResolvedValue(false);
      mockApiClient.fetchAllPlaudFiles.mockResolvedValue([]);

      syncModule.initializePlaudSyncService({ getSyncIntervalMinutes: () => 15 });
      await syncModule.syncPlaudRecordings();

      const savedCalls = mockFs.writeFile.mock.calls;
      const saves = savedCalls.filter(call =>
        call[0].includes('sync-state.json')
      );
      const reexamineSave = saves.find(call => {
        const data = JSON.parse(call[1]);
        return !(data.abandonedFileIds ?? []).includes('file-old');
      });
      expect(reexamineSave).toBeDefined();
      const data = JSON.parse(reexamineSave![1]);
      expect(data.failureCounts['file-old']).toBe(0);
    });

    it('does not re-examine recently abandoned files', async () => {
      const recentTimestamp = new Date(Date.now() - 1 * 60 * 60 * 1000).toISOString(); // 1h ago
       
      (mockFs.readFile as any).mockImplementation((filePath: string) => {
        if (filePath.includes('sync-state.json')) {
          return Promise.resolve(JSON.stringify({
            lastSyncTime: null,
            processedFileIds: [],
            failureCounts: { 'file-recent': 5 },
            notifiedFileIds: [],
            abandonedFileIds: ['file-recent'],
            abandonedAt: { 'file-recent': recentTimestamp },
          }));
        }
        return Promise.reject(new Error('ENOENT'));
      });

      mockApiClient.fileExists.mockResolvedValue(false);
      mockApiClient.fetchAllPlaudFiles.mockResolvedValue([]);

      syncModule.initializePlaudSyncService({ getSyncIntervalMinutes: () => 15 });
      await syncModule.syncPlaudRecordings();

      const savedCalls = mockFs.writeFile.mock.calls;
      const finalSave = savedCalls.filter(call =>
        call[0].includes('sync-state.json')
      ).pop();
      expect(finalSave).toBeDefined();
      const savedData = JSON.parse(finalSave![1]);
      expect(savedData.abandonedFileIds).toContain('file-recent');
    });

    it('re-examines legacy abandoned files without timestamps', async () => {
      mockFs.readFile.mockResolvedValueOnce(JSON.stringify(createMockSyncState({
        abandonedFileIds: ['file-legacy'],
        failureCounts: { 'file-legacy': 10 },
      })));

      mockApiClient.fileExists.mockResolvedValue(false);
      mockApiClient.fetchAllPlaudFiles.mockResolvedValue([]);

      syncModule.initializePlaudSyncService({ getSyncIntervalMinutes: () => 15 });
      await syncModule.syncPlaudRecordings();

      const savedCalls = mockFs.writeFile.mock.calls;
      const reexamineSave = savedCalls.filter(call =>
        call[0].includes('sync-state.json')
      ).find(call => {
        const data = JSON.parse(call[1]);
        return !(data.abandonedFileIds ?? []).includes('file-legacy');
      });
      expect(reexamineSave).toBeDefined();
    });
  });

  // Fail-closed test for the sensitivity guard is in plaudSavePlaudRecordingFailClosed.test.ts
  // as an isolated unit test to avoid mock-ordering complexity in this integration test.

  describe('Plaud server-side transcript (source_list) branch', () => {
    function plaudFile(id = 'file-plaud') {
      return {
        id,
        name: 'meeting.mp3',
        created_at: '2026-05-01T10:00:00Z',
        start_at: '2026-05-01T10:00:00Z',
        duration: 120_000,
        serial_number: 'SN-PLAUD',
      };
    }

    function completeSourceList() {
      return [
        { text: 'First sentence from Plaud.', start_time: 0, end_time: 60 },
        { text: 'Second sentence from Plaud.', start_time: 60, end_time: 120 },
      ];
    }

    it('(a) skips download + transcribeAudio when Plaud transcript is complete', async () => {
      mockFs.readFile.mockResolvedValueOnce(JSON.stringify(createMockSyncState()));
      mockApiClient.fileExists.mockResolvedValue(false);
      const file = plaudFile('file-a');
      mockApiClient.fetchAllPlaudFiles.mockResolvedValue([file]);
      mockApiClient.fetchPlaudFileDetails.mockResolvedValue({
        ...file,
        presigned_url: 'https://example.com/a.mp3',
        source_list: completeSourceList(),
        note_list: [],
      });
      mockFs.readFile.mockResolvedValueOnce(JSON.stringify({
        id: file.id,
        name: file.name,
        created_at: file.created_at,
        start_at: file.start_at,
        duration: file.duration,
        serial_number: file.serial_number,
      }));

      syncModule.initializePlaudSyncService({ getSyncIntervalMinutes: () => 15 });
      const result = await syncModule.syncPlaudRecordings();

      expect(result.synced).toBe(1);
      expect(result.errors).toBe(0);
      expect(mockApiClient.downloadAudioFile).not.toHaveBeenCalled();
      expect(mockAxiosPost).not.toHaveBeenCalled();
      expect(mockEmitTranscriptSaved).toHaveBeenCalled();
    });

    it('(b) falls through to local STT when Plaud source_list is absent', async () => {
      mockFs.readFile
        .mockResolvedValueOnce(JSON.stringify(createMockSyncState()))
        .mockResolvedValueOnce(Buffer.from('audio data'))
        .mockResolvedValueOnce(JSON.stringify({
          id: 'file-b',
          start_at: '2026-05-01T10:00:00Z',
          duration: 60_000,
        }));
      mockApiClient.fileExists.mockResolvedValue(true);
      mockApiClient.fetchAllPlaudFiles.mockResolvedValue([plaudFile('file-b')]);
      // Default beforeEach mock returns source_list: [] — fallback_local.

      syncModule.initializePlaudSyncService({ getSyncIntervalMinutes: () => 15 });
      const result = await syncModule.syncPlaudRecordings();

      expect(result.synced).toBe(1);
      expect(mockAxiosPost).toHaveBeenCalled();
      expect(mockEmitTranscriptSaved).toHaveBeenCalled();
    });

    it('(c) defers to next sync when Plaud transcript is not_ready (no save, no processedFileIds push)', async () => {
      mockFs.readFile.mockResolvedValueOnce(JSON.stringify(createMockSyncState()));
      mockApiClient.fileExists.mockResolvedValue(false);
      const file = {
        ...plaudFile('file-c'),
        created_at: new Date().toISOString(),
      };
      mockApiClient.fetchAllPlaudFiles.mockResolvedValue([file]);
      // Coverage 30s of 120s → not_ready
      mockApiClient.fetchPlaudFileDetails.mockResolvedValue({
        ...file,
        presigned_url: 'https://example.com/c.mp3',
        source_list: [{ text: 'Partial.', start_time: 0, end_time: 30 }],
        note_list: [],
      });

      syncModule.initializePlaudSyncService({ getSyncIntervalMinutes: () => 15 });
      const result = await syncModule.syncPlaudRecordings();

      expect(result.synced).toBe(0);
      expect(result.errors).toBe(0);
      expect(mockApiClient.downloadAudioFile).not.toHaveBeenCalled();
      expect(mockAxiosPost).not.toHaveBeenCalled();
      expect(mockEmitTranscriptSaved).not.toHaveBeenCalled();

      const savedCalls = mockFs.writeFile.mock.calls;
      const finalSave = savedCalls.filter(call => typeof call[0] === 'string' && call[0].includes('sync-state.json')).pop();
      expect(finalSave).toBeDefined();
      const savedData = JSON.parse(finalSave![1]);
      expect(savedData.processedFileIds).not.toContain('file-c');
    });

    it('(d) falls through to local STT when Plaud source_list is malformed', async () => {
      mockFs.readFile
        .mockResolvedValueOnce(JSON.stringify(createMockSyncState()))
        .mockResolvedValueOnce(Buffer.from('audio data'))
        .mockResolvedValueOnce(JSON.stringify({
          id: 'file-d',
          start_at: '2026-05-01T10:00:00Z',
          duration: 60_000,
        }));
      mockApiClient.fileExists.mockResolvedValue(true);
      const file = plaudFile('file-d');
      mockApiClient.fetchAllPlaudFiles.mockResolvedValue([file]);
      mockApiClient.fetchPlaudFileDetails.mockResolvedValue({
        ...file,
        presigned_url: 'https://example.com/d.mp3',
        source_list: [{ text: 42 }, { not_text: 'oops' }],
        note_list: [],
      });

      syncModule.initializePlaudSyncService({ getSyncIntervalMinutes: () => 15 });
      const result = await syncModule.syncPlaudRecordings();

      expect(result.synced).toBe(1);
      expect(mockAxiosPost).toHaveBeenCalled();
      expect(mockEmitTranscriptSaved).toHaveBeenCalled();
    });

    it('(e) emits zero-cost ledger entry on the Plaud-supplied branch', async () => {
      mockFs.readFile.mockResolvedValueOnce(JSON.stringify(createMockSyncState()));
      mockApiClient.fileExists.mockResolvedValue(false);
      const file = plaudFile('file-e');
      mockApiClient.fetchAllPlaudFiles.mockResolvedValue([file]);
      mockApiClient.fetchPlaudFileDetails.mockResolvedValue({
        ...file,
        presigned_url: 'https://example.com/e.mp3',
        source_list: completeSourceList(),
        note_list: [],
      });
      mockFs.readFile.mockResolvedValueOnce(JSON.stringify({
        id: file.id,
        name: file.name,
        created_at: file.created_at,
        start_at: file.start_at,
        duration: file.duration,
        serial_number: file.serial_number,
      }));

      syncModule.initializePlaudSyncService({ getSyncIntervalMinutes: () => 15 });
      await syncModule.syncPlaudRecordings();

      expect(mockAppendCostEntry).toHaveBeenCalledWith(
        expect.objectContaining({
          cost: 0,
          cat: 'stt',
          m: 'plaud-supplied',
          outcome: { kind: 'auxiliary_success' },
        }),
      );
    });

    it('(f) fires STT Transcription Completed tracker event with provider plaud-supplied', async () => {
      mockFs.readFile.mockResolvedValueOnce(JSON.stringify(createMockSyncState()));
      mockApiClient.fileExists.mockResolvedValue(false);
      const file = plaudFile('file-f');
      mockApiClient.fetchAllPlaudFiles.mockResolvedValue([file]);
      mockApiClient.fetchPlaudFileDetails.mockResolvedValue({
        ...file,
        presigned_url: 'https://example.com/f.mp3',
        source_list: completeSourceList(),
        note_list: [],
      });
      mockFs.readFile.mockResolvedValueOnce(JSON.stringify({
        id: file.id,
        name: file.name,
        created_at: file.created_at,
        start_at: file.start_at,
        duration: file.duration,
        serial_number: file.serial_number,
      }));

      syncModule.initializePlaudSyncService({ getSyncIntervalMinutes: () => 15 });
      await syncModule.syncPlaudRecordings();

      expect(mockTrack).toHaveBeenCalledWith(
        'STT Transcription Completed',
        expect.objectContaining({
          costUsd: 0,
          model: 'plaud-supplied',
          provider: 'plaud-supplied',
          source: 'plaud',
        }),
      );
    });

    it('(g) writes .meta.json sentinel BEFORE setting inProgressFileId on the Plaud branch', async () => {
      mockFs.readFile.mockResolvedValueOnce(JSON.stringify(createMockSyncState()));
      mockApiClient.fileExists.mockResolvedValue(false);
      const file = plaudFile('file-g');
      mockApiClient.fetchAllPlaudFiles.mockResolvedValue([file]);
      mockApiClient.fetchPlaudFileDetails.mockResolvedValue({
        ...file,
        presigned_url: 'https://example.com/g.mp3',
        source_list: completeSourceList(),
        note_list: [],
      });
      mockFs.readFile.mockResolvedValueOnce(JSON.stringify({
        id: file.id,
        name: file.name,
        created_at: file.created_at,
        start_at: file.start_at,
        duration: file.duration,
        serial_number: file.serial_number,
      }));

      syncModule.initializePlaudSyncService({ getSyncIntervalMinutes: () => 15 });
      await syncModule.syncPlaudRecordings();

      const writeCalls = mockFs.writeFile.mock.calls;
      const metaIdx = writeCalls.findIndex(c => typeof c[0] === 'string' && c[0].includes(`${file.id}.meta.json`));
      const inProgressIdx = writeCalls.findIndex(c => {
        if (typeof c[0] !== 'string' || !c[0].includes('sync-state.json')) return false;
        try { return JSON.parse(c[1]).inProgressFileId === file.id; } catch { return false; }
      });
      expect(metaIdx).toBeGreaterThanOrEqual(0);
      expect(inProgressIdx).toBeGreaterThanOrEqual(0);
      expect(metaIdx).toBeLessThan(inProgressIdx);
    });

    it('(h) skips processing when fileDetails.id mismatches the listed file id', async () => {
      mockFs.readFile.mockResolvedValueOnce(JSON.stringify(createMockSyncState()));
      mockApiClient.fileExists.mockResolvedValue(false);
      const file = plaudFile('file-h');
      mockApiClient.fetchAllPlaudFiles.mockResolvedValue([file]);
      mockApiClient.fetchPlaudFileDetails.mockResolvedValue({
        ...file,
        id: 'other-file-id',
        presigned_url: 'https://example.com/h.mp3',
        source_list: completeSourceList(),
        note_list: [],
      });

      syncModule.initializePlaudSyncService({ getSyncIntervalMinutes: () => 15 });
      const result = await syncModule.syncPlaudRecordings();

      expect(result.synced).toBe(0);
      expect(result.errors).toBe(0);
      expect(mockApiClient.downloadAudioFile).not.toHaveBeenCalled();
      expect(mockAxiosPost).not.toHaveBeenCalled();
      expect(mockEmitTranscriptSaved).not.toHaveBeenCalled();

      const savedCalls = mockFs.writeFile.mock.calls;
      const finalSave = savedCalls
        .filter((call) => typeof call[0] === 'string' && call[0].includes('sync-state.json'))
        .pop();
      expect(finalSave).toBeDefined();
      const savedData = JSON.parse(finalSave![1]);
      expect(savedData.processedFileIds).not.toContain(file.id);
      expect(savedData.failureCounts[file.id] ?? 0).toBe(0);
    });
  });

  describe('retranscribePlaudMeeting', () => {
    it('always uses local STT even when Plaud source_list is complete', async () => {
      const meetingFilePath = '/mock/workspace/meeting.md';
      const existingMeetingFile = `---
source_uid: plaud_abc123
stored_at: 2026-05-23
---

# Existing title

## Full Content

Old transcript body
`;

      mockFs.readFile
        .mockResolvedValueOnce(existingMeetingFile)
        .mockResolvedValueOnce(Buffer.from('audio bytes'));
      mockApiClient.fetchPlaudFileDetails.mockResolvedValue({
        id: 'abc123',
        name: 'meeting.mp3',
        created_at: '2026-05-24T10:00:00Z',
        start_at: '2026-05-24T10:00:00Z',
        serial_number: 'SN-ABC',
        duration: 120_000,
        presigned_url: 'https://example.com/retranscribe.mp3',
        source_list: [
          { text: 'Plaud transcript that should not be reused.', start_time: 0, end_time: 120 },
        ],
        note_list: [],
      });

      const result = await syncModule.retranscribePlaudMeeting(meetingFilePath);

      expect(result.success).toBe(true);
      expect(mockApiClient.downloadAudioFile).toHaveBeenCalledWith(
        'https://example.com/retranscribe.mp3',
        expect.stringContaining('retranscribe_abc123.mp3'),
      );
      expect(mockAxiosPost).toHaveBeenCalled();

      const rewriteCall = mockFs.writeFile.mock.calls.find(
        (call) => call[0] === meetingFilePath,
      );
      expect(rewriteCall).toBeDefined();
      const rewrittenMarkdown = String(rewriteCall![1]);
      expect(rewrittenMarkdown).toContain('Test transcript');
      expect(rewrittenMarkdown).not.toContain('Plaud transcript that should not be reused.');
    });
  });
});
