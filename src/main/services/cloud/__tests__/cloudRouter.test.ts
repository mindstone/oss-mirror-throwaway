import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentSession, AppSettings } from '@shared/types';
import { hashSessionId } from '@shared/trackingTypes';
import type { FileLocation } from '@rebel/shared';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

// Mock cloudEventChannel to prevent real WebSocket connections during tests.
// cloudRouter lazy-imports this module; mocking avoids leaked async from ws.
const cloudEventChannelMock = vi.hoisted(() => ({
  connect: vi.fn(),
  disconnect: vi.fn(),
  reconnectNow: vi.fn(),
  onApprovalReceived: vi.fn(),
  onMemoryApprovalReceived: vi.fn(),
  onSessionChanged: vi.fn(),
  onInboxChanged: vi.fn(),
  onReconnect: vi.fn(),
  onStagedFilesChanged: vi.fn(),
}));

vi.mock('../cloudEventChannel', () => ({
  cloudEventChannel: {
    ...cloudEventChannelMock,
    get isConnected() { return false; },
  },
}));

const mockAddPendingMemoryApproval = vi.hoisted(() => vi.fn());
vi.mock('../../safety/pendingApprovalsStore', () => ({
  addPendingMemoryApproval: (...args: unknown[]) => mockAddPendingMemoryApproval(...args),
}));

const scanSpacesMock = vi.hoisted(() => vi.fn());
vi.mock('../../spaceService', () => ({
  scanSpaces: (...args: unknown[]) => scanSpacesMock(...args),
}));

const resolveFileLocationMock = vi.hoisted(() => vi.fn());
vi.mock('@core/services/fileLocation', () => ({
  resolveFileLocation: (...args: unknown[]) => resolveFileLocationMock(...args),
  FileLocationResolverError: class FileLocationResolverError extends Error {
    readonly code: string;
    readonly inputPath: string;

    constructor(code: string, inputPath: string, message: string) {
      super(message);
      this.name = 'FileLocationResolverError';
      this.code = code;
      this.inputPath = inputPath;
    }
  },
}));

const loggerMock = vi.hoisted(() => ({
  info: vi.fn(),
  debug: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}));
 
vi.mock('@core/logger', () => ({
  createScopedLogger: vi.fn(() => loggerMock),
  logger: loggerMock,
}));

// Mock CloudServiceClient
const mockGet = vi.fn();
const mockPost = vi.fn();
const mockPut = vi.fn();
const mockPatch = vi.fn();
const mockDelete = vi.fn();
const mockStartAgentTurn = vi.fn();
const mockHealthCheck = vi.fn();
const mockDisconnect = vi.fn();

// Mock incrementalSessionStore for pull sync tests
const mockGetSession = vi.fn().mockResolvedValue(null);
const mockListSessions = vi.fn().mockReturnValue([]);
const mockGetSessionIds = vi.fn().mockReturnValue([]);
const mockUpsertSession = vi.fn().mockResolvedValue(undefined);
type MockSessionUpsertOutcome = 'persisted' | 'dropped-tombstoned' | 'dropped-read-only';
const mockUpsertSessionWithOutcome = vi.fn(async (_session: unknown): Promise<MockSessionUpsertOutcome> => 'persisted');
const mockDeleteSession = vi.fn().mockResolvedValue(undefined);
vi.mock('../../incrementalSessionStore', () => ({
  getIncrementalSessionStore: () => ({
    getSession: mockGetSession,
    listSessions: mockListSessions,
    getSessionIds: mockGetSessionIds,
    upsertSession: mockUpsertSession,
    upsertSessionWithOutcome: mockUpsertSessionWithOutcome,
    deleteSession: mockDeleteSession,
  }),
}));

const mockOnSessionsSaved = vi.fn().mockResolvedValue(undefined);
vi.mock('../../conversationIndexService', () => ({
  onSessionsSaved: (...args: unknown[]) => mockOnSessionsSaved(...args),
}));

// NOTE: We intentionally do NOT vi.mock('@core/broadcastService') here.
// vitest's setupFile imports the real module and calls setBroadcastService()
// before any per-file vi.mock would apply. The Layer C self-echo tests below
// install a spy via the real boundary-interface setter (`setBroadcastService`)
// in their own beforeEach, which the production handler picks up correctly.

vi.mock('../../safety', () => ({
  clearPendingApprovalsForSession: vi.fn(),
}));

// Mock settingsStore for pullSettings tests
const mockUpdateSettings = vi.fn();
vi.mock('@core/services/settingsStore', () => ({
  setSettingsStoreAdapter: vi.fn(),
  updateSettings: (...args: unknown[]) => mockUpdateSettings(...args),
}));

// Mock cloudSyncMetadata
const mockSyncedSessions = new Set<string>();
const mockMarkCloudSynced = vi.fn((id: string) => { mockSyncedSessions.add(id); });
vi.mock('../cloudSyncMetadata', () => ({
  markCloudSynced: (...args: unknown[]) => mockMarkCloudSynced(...args as [string]),
  isCloudSynced: vi.fn((id: string) => mockSyncedSessions.has(id)),
  removeCloudSyncMetadata: vi.fn((id: string) => { mockSyncedSessions.delete(id); }),
  loadCloudSyncMetadata: vi.fn(),
  flushCloudSyncMetadata: vi.fn(),
}));

// Mock cloudOutbox
const mockOutboxGetAll = vi.fn().mockReturnValue([]);
const mockOutboxEnqueue = vi.fn();
const mockOutboxLoad = vi.fn();
const mockOutboxOnConnectionChanged = vi.fn();
const mockOutboxDrain = vi.fn().mockResolvedValue({ ok: 0, failed: 0, authFailures: 0 });
const mockOutboxFlush = vi.fn();
const mockOutboxGetStatus = vi.fn().mockReturnValue({ pending: 0, failed: 0 });
const mockOutboxSuppressTombstonedUpserts = vi.fn().mockReturnValue([]);
const mockOutboxRecordCloudUpdatedAt = vi.fn();
const mockOutboxRecordLastPushedSeq = vi.fn();
const mockOutboxGetLastPushedSeq = vi.fn().mockReturnValue(undefined);
const mockOutboxHasPendingDelete = vi.fn().mockReturnValue(false);
const mockOutboxGetPendingDeleteSessionIds = vi.fn().mockReturnValue(new Set<string>());
vi.mock('../cloudOutbox', () => ({
  pushFullSessionWithCapabilityGate: async (client: { put: (path: string, body: unknown) => Promise<unknown> }, session: { id: string; maxSeq?: number; cloudUpdatedAt?: number }) => {
    const result = await client.put(`/api/sessions/${encodeURIComponent(session.id)}`, session);
    const response = result && typeof result === 'object' ? result as { serverSeq?: unknown; cloudUpdatedAt?: unknown } : {};
    return {
      serverSeq: typeof response.serverSeq === 'number' ? response.serverSeq : session.maxSeq ?? 0,
      cloudUpdatedAt: typeof response.cloudUpdatedAt === 'number' ? response.cloudUpdatedAt : session.cloudUpdatedAt ?? 0,
    };
  },
  cloudOutbox: {
    getAll: (...args: unknown[]) => mockOutboxGetAll(...args),
    enqueue: (...args: unknown[]) => mockOutboxEnqueue(...args),
    load: (...args: unknown[]) => mockOutboxLoad(...args),
    onConnectionChanged: (...args: unknown[]) => mockOutboxOnConnectionChanged(...args),
    drain: (...args: unknown[]) => mockOutboxDrain(...args),
    flush: (...args: unknown[]) => mockOutboxFlush(...args),
    getStatus: (...args: unknown[]) => mockOutboxGetStatus(...args),
    suppressTombstonedUpserts: (...args: unknown[]) => mockOutboxSuppressTombstonedUpserts(...args),
    recordCloudUpdatedAt: (...args: unknown[]) => mockOutboxRecordCloudUpdatedAt(...args),
    recordLastPushedSeq: (...args: unknown[]) => mockOutboxRecordLastPushedSeq(...args),
    getLastPushedSeq: (...args: unknown[]) => mockOutboxGetLastPushedSeq(...args),
    hasPendingDelete: (...args: unknown[]) => mockOutboxHasPendingDelete(...args),
    getPendingDeleteSessionIds: (...args: unknown[]) => mockOutboxGetPendingDeleteSessionIds(...args),
  },
}));

// Mock cloudContinuityMetadata
const mockMarkCloudActive = vi.hoisted(() => vi.fn());
const mockMarkLocalOnly = vi.hoisted(() => vi.fn());
const mockTouchCloudActivity = vi.hoisted(() => vi.fn());
const mockFlushContinuityMetadata = vi.hoisted(() => vi.fn().mockResolvedValue({ success: true }));
const mockRemoveContinuityMetadata = vi.hoisted(() => vi.fn());
const mockRestoreContinuityEntrySnapshot = vi.hoisted(() => vi.fn());
const mockGetAllContinuityStates = vi.hoisted(() => vi.fn(() => ({})));
const mockGetStaleCloudSessions = vi.hoisted(() => vi.fn(() => [] as string[]));
const mockGetContinuityEntry = vi.fn<(sessionId: string) => {
  state?: 'cloud_active' | 'local_only';
  lastCloudActivityAt?: number;
  cloudPinnedAt?: number;
  cloudRemovalIntent?: { requestedAt: number; requestedBy: 'user' | 'retention-policy'; source?: 'desktop' | 'mobile' | 'web' | 'cloud' };
} | null>(() => null);
let mockLastSessionTombstoneSyncAt: number | null = null;
vi.mock('../cloudContinuityMetadata', () => ({
  isCloudActive: vi.fn(() => false),
  getContinuityEntry: mockGetContinuityEntry,
  markCloudActive: mockMarkCloudActive,
  markLocalOnly: mockMarkLocalOnly,
  touchCloudActivity: mockTouchCloudActivity,
  removeContinuityMetadata: mockRemoveContinuityMetadata,
  restoreContinuityEntrySnapshot: mockRestoreContinuityEntrySnapshot,
  loadContinuityMetadata: vi.fn(),
  getAllContinuityStates: mockGetAllContinuityStates,
  getStaleCloudSessions: mockGetStaleCloudSessions,
  getLastSessionTombstoneSyncAt: vi.fn(() => mockLastSessionTombstoneSyncAt),
  setLastSessionTombstoneSyncAt: vi.fn((timestamp: number) => { mockLastSessionTombstoneSyncAt = timestamp; }),
  flushContinuityMetadata: mockFlushContinuityMetadata,
}));

vi.mock('../cloudServiceClient', () => {
  const MockCloudServiceError = class CloudServiceError extends Error {
    code: string;
    statusCode?: number;
    constructor(message: string, code: string, statusCode?: number) {
      super(message);
      this.name = 'CloudServiceError';
      this.code = code;
      this.statusCode = statusCode;
    }
  };

  return {
    CloudServiceClient: class MockCloudServiceClient {
      constructor(_url: string, _token: string) {
        // Constructor args ignored in mock
      }
      get = mockGet;
      post = mockPost;
      put = mockPut;
      patch = mockPatch;
      delete = mockDelete;
      startAgentTurn = mockStartAgentTurn;
      healthCheck = mockHealthCheck;
      disconnect = mockDisconnect;
    },
    CloudServiceError: MockCloudServiceError,
  };
});

// ---------------------------------------------------------------------------
// Import after mocks
// ---------------------------------------------------------------------------

import { CloudRouter, type CloudRouterConfig } from '../cloudRouter';
import { cloudFailureCooldown } from '../cloudFailureCooldown';
import { CloudServiceError } from '../cloudServiceClient';
import { resetSessionSeqIndexForTests } from '@core/services/sessionSeqIndex';
import { GC_GRACE_WINDOW_MS, runStateMapGC } from '@core/services/cloudContinuityStateService';
import { getErrorReporter } from '@core/errorReporter';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createSettings(overrides?: Record<string, unknown>): AppSettings {
  return {
    coreDirectory: '/data/workspace',
    mcpConfigFile: null,
    onboardingCompleted: true,
    userEmail: null,
    onboardingFirstCompletedAt: null,
    voice: {} as AppSettings['voice'],
    claude: {} as AppSettings['claude'],
    diagnostics: {} as AppSettings['diagnostics'],
    ...overrides,
  } as AppSettings;
}

function createCloudSettings(): AppSettings {
  return createSettings({
    coreDirectory: '/Users/me/Documents/Core',
    mcpConfigFile: '/Users/me/Library/rebel/mcp/super-mcp-router.json',
    cloudInstance: {
      mode: 'cloud',
      cloudUrl: 'https://rebel-test.fly.dev',
      cloudToken: 'placeholder',
    },
  });
}

function createLocalSettings(): AppSettings {
  return createSettings({
    cloudInstance: {
      mode: 'local',
    },
  });
}

function createConfig(settings: AppSettings): CloudRouterConfig {
  return { getSettings: () => settings };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

// Mock global fetch so auto-wake health polling doesn't make real requests
const mockFetch = vi.fn().mockRejectedValue(new Error('mocked network error'));
vi.stubGlobal('fetch', mockFetch);

// updateConnection()/init() kicks off an unawaited fire-and-forget cascade that FANS OUT
// after the initial pull (cloudRouter.ts ~1118: pullChangedSessions().then(() =>
// runLifecycleCheck + triggerStagingBridgeSync + pushSessionsToCloud + pullInboxChanges().then(
// pushInboxToCloud))), each awaiting client.get + dynamic imports. disconnect() clears
// timers/handles but does NOT cancel or await this in-flight cascade, and the mock
// CloudServiceClient shares ONE module-level mockGet across instances — so a straggler call
// from THIS test bleeds into the NEXT and consumes its queued mock*Once values (the intermittent
// pullChangedSessions/pushSessionsToCloud flake: passes in isolation, fails a different test each
// big vitest-related batch run). A FIXED tick count is load-sensitive; instead drain until the
// cascade is QUIESCENT — poll the call-count fingerprint of every mock the cascade can touch and
// stop only once it's unchanged for 10 consecutive ticks (5 can false-quiesce across a stalled
// dynamic-import gap under load), capped at 500. Throw if it never settles, so a regression is a
// loud failure here rather than a silent straggler bleeding into the next test.
const WATCHED_CASCADE_MOCKS = [
  mockGet, mockPost, mockPut, mockPatch, mockDelete,
  mockGetSession, mockListSessions, mockGetSessionIds,
  mockUpsertSession, mockUpsertSessionWithOutcome, mockDeleteSession,
  mockOutboxDrain, mockOutboxGetStatus, mockOutboxSuppressTombstonedUpserts,
  mockOutboxGetPendingDeleteSessionIds, mockFlushContinuityMetadata,
  scanSpacesMock, resolveFileLocationMock,
];
async function drainCloudRouterCascade(): Promise<void> {
  const fingerprint = () => WATCHED_CASCADE_MOCKS.map((m) => m.mock.calls.length).join(':');
  let previous = fingerprint();
  let quietTicks = 0;
  for (let tick = 0; tick < 500; tick += 1) {
    // Flush microtasks (chained .then / awaited dynamic imports) then a macrotask.
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
    const next = fingerprint();
    quietTicks = next === previous ? quietTicks + 1 : 0;
    previous = next;
    if (quietTicks >= 10) return;
  }
  throw new Error('cloudRouter test: fire-and-forget cascade did not quiesce within 500 ticks');
}

describe('CloudRouter', () => {
  let router: CloudRouter;
  const CLOUD_LOCATION: FileLocation = {
    kind: 'in-space',
    spaceName: 'General',
    spaceWorkspacePath: 'General',
    spaceRelativePath: 'notes.md',
    workspaceRelativePath: 'General/notes.md',
    fileName: 'notes.md',
    absolutePath: '/data/workspace/General/notes.md',
  };

  beforeEach(() => {
    router = new CloudRouter();
    vi.clearAllMocks();
    // clearAllMocks() resets call history but does NOT drain queued
    // mockResolvedValueOnce values. The async client/session mocks below are
    // queued one-shot per test, so a value queued-but-not-consumed by a prior
    // (async) test can leak into the next under parallel load — the source of an
    // intermittent pushSessionsToCloud flake (a leaked /api/sessions summaries
    // response made cloud look up-to-date → 0 pushes; the test passes in
    // isolation, flakes only in the big vitest-related batch). Reset their queues
    // and re-establish defaults so every test starts clean. (Same class as the
    // toolSafetyService shared-mock-isolation hardening.)
    mockGet.mockReset();
    // Defense-in-depth alongside the afterEach drain: the other HTTP verbs are shared
    // module-level mocks too, so drain their *Once queues each test (no default to restore —
    // they're bare vi.fn()). A test's unconsumed mockResolvedValueOnce would otherwise survive
    // clearAllMocks() (which only clears call history) and leak into the next test.
    mockPost.mockReset();
    mockPut.mockReset();
    mockPatch.mockReset();
    mockDelete.mockReset();
    mockGetSession.mockReset();
    mockGetSession.mockResolvedValue(null);
    mockUpsertSession.mockResolvedValue(undefined);
    mockUpsertSessionWithOutcome.mockImplementation(async (): Promise<MockSessionUpsertOutcome> => 'persisted');
    resetSessionSeqIndexForTests();
    cloudFailureCooldown.reset();
    mockFetch.mockRejectedValue(new Error('mocked network error'));
    mockLastSessionTombstoneSyncAt = null;
    mockOutboxSuppressTombstonedUpserts.mockReturnValue([]);
    mockOutboxHasPendingDelete.mockReturnValue(false);
    mockOutboxGetPendingDeleteSessionIds.mockReturnValue(new Set<string>());
    mockGetContinuityEntry.mockReturnValue(null);
    mockGetAllContinuityStates.mockReturnValue({});
    mockGetStaleCloudSessions.mockReturnValue([]);
    mockFlushContinuityMetadata.mockResolvedValue({ success: true });
    scanSpacesMock.mockResolvedValue([
      {
        name: 'General',
        path: 'General',
        absolutePath: '/data/workspace/General',
        type: 'personal',
        isSymlink: false,
        hasReadme: true,
      },
    ]);
    resolveFileLocationMock.mockResolvedValue(CLOUD_LOCATION);
  });

  afterEach(async () => {
    router.disconnect();
    cloudFailureCooldown.reset();
    // Drain the unawaited fire-and-forget cascade that updateConnection()/init() kicks off
    // (see WATCHED_CASCADE_MOCKS / drainCloudRouterCascade above) until it goes quiescent, so a
    // straggler client call can't bleed into the next test and consume its queued mock*Once
    // values. A drain to quiescence is load-robust where the old fixed 30-tick drain was not.
    // (beforeEach mock-resets alone can't fix this — a concurrent stale call eats the
    // freshly-queued values mid-test.) useRealTimers() guards against a fake-timer block
    // leaking and hanging the real-setTimeout drain.
    vi.useRealTimers();
    await drainCloudRouterCascade();
  });

  // =========================================================================
  // shouldRouteToCloud
  // =========================================================================

  describe('shouldRouteToCloud', () => {
    it('returns false when router is not initialized', () => {
      expect(router.shouldRouteToCloud('sessions:load')).toBe(false);
    });

    it('returns false when cloud mode is disabled (local mode)', () => {
      router.init(createConfig(createLocalSettings()));
      expect(router.shouldRouteToCloud('sessions:load')).toBe(false);
    });

    it('returns false when cloudInstance is not set', () => {
      router.init(createConfig(createSettings()));
      expect(router.shouldRouteToCloud('sessions:load')).toBe(false);
    });

    it('returns false when cloudUrl is missing', () => {
      router.init(createConfig(createSettings({
        cloudInstance: { mode: 'cloud', cloudToken: 'token' },
      })));
      expect(router.shouldRouteToCloud('sessions:load')).toBe(false);
    });

    it('returns false when cloudToken is missing', () => {
      router.init(createConfig(createSettings({
        cloudInstance: { mode: 'cloud', cloudUrl: 'https://test.fly.dev' },
      })));
      expect(router.shouldRouteToCloud('sessions:load')).toBe(false);
    });

    it('returns true for allowlisted channels when cloud mode enabled', () => {
      router.init(createConfig(createCloudSettings()));

      // Only dual-write channels remain in CLOUD_CHANNEL_POLICIES after Phase C
      const allowlisted = [
        'agent:tool-safety-response',
        'settings:update',
        'automations:upsert',
        'automations:delete',
      ];

      for (const channel of allowlisted) {
        expect(router.shouldRouteToCloud(channel)).toBe(true);
      }
    });

    it('returns false for non-allowlisted channels when cloud mode enabled', () => {
      router.init(createConfig(createCloudSettings()));

      const notAllowed = [
        // agent:turn and agent:stop-turn removed in Phase A
        'agent:turn', 'agent:stop-turn',
        // All data channels removed in Phase C (desktop runs locally, syncs via outbox)
        'sessions:load', 'sessions:list', 'sessions:get', 'sessions:upsert', 'sessions:delete',
        'settings:get',
        'library:list-files', 'library:read-file', 'library:write-file',
        'inbox:load', 'memory:get-history', 'automations:state',
        // Non-cloud channels
        'app:quit', 'voice:start', 'permissions:check',
        'localStt:start', 'physicalRecording:start',
        'settings:choose-directory', 'demo:start',
        'version:check', 'misc:open-url',
        'unknown:channel',
      ];

      for (const channel of notAllowed) {
        expect(router.shouldRouteToCloud(channel)).toBe(false);
      }
    });

    it('reflects settings changes dynamically', () => {
      let settings = createLocalSettings();
      router.init({ getSettings: () => settings });

      expect(router.shouldRouteToCloud('settings:update')).toBe(false);

      // Switch to cloud mode (cache must be refreshed, as in real app via onDidAnyChange)
      settings = createCloudSettings();
      router.refreshCloudModeCache();
      expect(router.shouldRouteToCloud('settings:update')).toBe(true);

      // Switch back to local
      settings = createLocalSettings();
      router.refreshCloudModeCache();
      expect(router.shouldRouteToCloud('settings:update')).toBe(false);
    });
  });

  // =========================================================================
  // forward — HTTP routing
  // =========================================================================

  describe('forward — HTTP routing', () => {
    beforeEach(() => {
      router.init(createConfig(createCloudSettings()));
    });

    it('maps settings:update to PATCH /api/settings and strips local-only fields', async () => {
      mockPatch.mockResolvedValue({ success: true });
      const patch = {
        voice: { provider: 'openai-whisper' },
        cloudInstance: { mode: 'cloud', cloudToken: 'secret' },
        mcpConfigFile: '/Users/me/Library/rebel/mcp/super-mcp-router.json',
        coreDirectory: '/Users/me/Documents/Workspace/Core',
        localModel: {
          activeProfileId: null,
          profiles: [
            {
              id: 'connection-profile',
              name: 'Connection profile',
              providerType: 'anthropic',
              profileSource: 'connection',
              serverUrl: 'https://api.anthropic.com/v1',
              model: 'claude-sonnet-4-6',
              createdAt: 1,
            },
          ],
        },
      };
      const result = await router.forward('settings:update', [patch]);
      // cloudInstance, mcpConfigFile, coreDirectory should be stripped before forwarding
      expect(mockPatch).toHaveBeenCalledWith('/api/settings', {
        voice: { provider: 'openai-whisper' },
        localModel: {
          activeProfileId: null,
          profiles: [
            expect.objectContaining({
              id: 'connection-profile',
              providerType: 'anthropic',
              profileSource: 'connection',
            }),
          ],
        },
      });
      // Result should have local-only fields merged back from local settings
      expect(result).toEqual({
        success: true,
        cloudInstance: expect.objectContaining({ mode: 'cloud' }),
        mcpConfigFile: expect.any(String),
        coreDirectory: expect.any(String),
      });
    });

    it('maps health:check to GET /api/health', async () => {
      mockGet.mockResolvedValue({ status: 'ok' });
      const result = await router.forward('health:check', []);
      expect(mockGet).toHaveBeenCalledWith('/api/health');
      expect(result).toEqual({ status: 'ok' });
    });

    it('forwards non-REST channels via generic /api/ipc/:channel endpoint', async () => {
      mockPost.mockResolvedValue({ ok: true });
      const result = await router.forward('automations:upsert', [{ id: 'auto-1' }]);
      expect(mockPost).toHaveBeenCalledWith('/api/ipc/automations%3Aupsert', { params: [{ id: 'auto-1' }] });
      expect(result).toEqual({ ok: true });
    });
  });

  describe('post-cloud session hooks', () => {
    beforeEach(() => {
      router.init(createConfig(createCloudSettings()));
    });

    it('does not mark synced or index when a cloudRouter session upsert write is refused', async () => {
      const session: AgentSession = {
        id: 'sess-refused-post-cloud-hook',
        title: 'Refused',
        createdAt: 1000,
        updatedAt: 2000,
        messages: [],
        eventsByTurn: {},
        activeTurnId: null,
        isBusy: false,
        lastError: null,
        resolvedAt: null,
      };
      mockUpsertSessionWithOutcome.mockResolvedValueOnce('dropped-tombstoned');

      await (router as unknown as {
        runPostCloudHooks(channel: string, args: unknown[]): Promise<void>;
      }).runPostCloudHooks('sessions:upsert', [session]);

      expect(mockUpsertSessionWithOutcome).toHaveBeenCalledWith(session);
      expect(mockMarkCloudActive).not.toHaveBeenCalled();
      expect(mockTouchCloudActivity).not.toHaveBeenCalled();
      expect(mockMarkCloudSynced).not.toHaveBeenCalled();
      expect(mockOnSessionsSaved).not.toHaveBeenCalled();
    });
  });

  // =========================================================================
  // forward — error handling
  // =========================================================================

  describe('forward — error handling', () => {
    beforeEach(() => {
      vi.useFakeTimers();
      router.init(createConfig(createCloudSettings()));
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('returns CLOUD_UNAVAILABLE for CLOUD_UNREACHABLE errors', async () => {
      mockGet.mockRejectedValue(new CloudServiceError('Connection refused', 'CLOUD_UNREACHABLE'));
      const promise = router.forward('health:check', []);
      // Fast-forward through auto-wake health polling delays
      for (let i = 0; i < 25; i++) await vi.advanceTimersByTimeAsync(3_000);
      const result = await promise as Record<string, unknown>;
      expect(result).toHaveProperty('error');
      const error = result.error as { code: string; message: string };
      expect(error.code).toBe('CLOUD_UNAVAILABLE');
    });

    it('returns CLOUD_UNAVAILABLE for TIMEOUT errors', async () => {
      mockGet.mockRejectedValue(new CloudServiceError('Request timed out', 'TIMEOUT'));
      const promise = router.forward('health:check', []);
      for (let i = 0; i < 25; i++) await vi.advanceTimersByTimeAsync(3_000);
      const result = await promise as Record<string, unknown>;
      expect(result).toHaveProperty('error');
      const error = result.error as { code: string; message: string };
      expect(error.code).toBe('CLOUD_UNAVAILABLE');
    });

    it('returns cloud error code for other CloudServiceErrors', async () => {
      mockGet.mockRejectedValue(new CloudServiceError('Not found', 'NOT_FOUND', 404));
      const result = await router.forward('health:check', []) as Record<string, unknown>;
      expect(result).toHaveProperty('error');
      const error = result.error as { code: string; message: string };
      expect(error.code).toBe('NOT_FOUND');
    });

    it('returns CLOUD_FORWARD_ERROR for unexpected errors', async () => {
      mockGet.mockRejectedValue(new Error('Something unexpected'));
      const result = await router.forward('health:check', []) as Record<string, unknown>;
      expect(result).toHaveProperty('error');
      const error = result.error as { code: string; message: string };
      expect(error.code).toBe('CLOUD_FORWARD_ERROR');
    });

    it('returns CLOUD_NOT_CONFIGURED when client cannot be created', async () => {
      // Init with settings that have no cloud config
      const settingsRouter = new CloudRouter();
      settingsRouter.init(createConfig(createSettings()));
      const result = await settingsRouter.forward('health:check', []) as Record<string, unknown>;
      expect(result).toHaveProperty('error');
      const error = result.error as { code: string; message: string };
      expect(error.code).toBe('CLOUD_NOT_CONFIGURED');
    });
  });

  // =========================================================================
  // updateConnection / disconnect
  // =========================================================================

  describe('connection lifecycle', () => {
    it('updateConnection creates a new client', async () => {
      router.init(createConfig(createCloudSettings()));
      await router.updateConnection('https://new-cloud.fly.dev', 'new-token');
      // Old client should be disconnected
      // (can't easily verify this without internal access, but disconnect is called)
    });

    it('does not reconnect when cloud URL and token are unchanged', async () => {
      router.init(createConfig(createCloudSettings()));
      await router.updateConnection('https://cloud.fly.dev', 'token');
      await new Promise(resolve => setTimeout(resolve, 0));

      mockDisconnect.mockClear();
      cloudEventChannelMock.disconnect.mockClear();
      cloudEventChannelMock.connect.mockClear();
      mockOutboxOnConnectionChanged.mockClear();

      await router.updateConnection('https://cloud.fly.dev', 'token');

      expect(mockDisconnect).not.toHaveBeenCalled();
      expect(cloudEventChannelMock.disconnect).not.toHaveBeenCalled();
      expect(cloudEventChannelMock.connect).not.toHaveBeenCalled();
      expect(mockOutboxOnConnectionChanged).not.toHaveBeenCalled();
    });

    it('reconnects when cloud URL or token changes', async () => {
      router.init(createConfig(createCloudSettings()));
      await router.updateConnection('https://cloud.fly.dev', 'token');
      await new Promise(resolve => setTimeout(resolve, 0));

      mockDisconnect.mockClear();
      cloudEventChannelMock.disconnect.mockClear();
      cloudEventChannelMock.connect.mockClear();
      mockOutboxOnConnectionChanged.mockClear();

      await router.updateConnection('https://cloud.fly.dev', 'new-token');

      expect(mockDisconnect).toHaveBeenCalledTimes(1);
      expect(cloudEventChannelMock.disconnect).toHaveBeenCalledTimes(1);
      expect(cloudEventChannelMock.connect).toHaveBeenCalledWith('https://cloud.fly.dev', 'new-token');
      expect(mockOutboxOnConnectionChanged).toHaveBeenCalledWith('https://cloud.fly.dev');

      mockDisconnect.mockClear();
      cloudEventChannelMock.disconnect.mockClear();
      cloudEventChannelMock.connect.mockClear();
      mockOutboxOnConnectionChanged.mockClear();

      await router.updateConnection('https://second-cloud.fly.dev', 'new-token');

      expect(mockDisconnect).toHaveBeenCalledTimes(1);
      expect(cloudEventChannelMock.disconnect).toHaveBeenCalledTimes(1);
      expect(cloudEventChannelMock.connect).toHaveBeenCalledWith('https://second-cloud.fly.dev', 'new-token');
      expect(mockOutboxOnConnectionChanged).toHaveBeenCalledWith('https://second-cloud.fly.dev');
    });

    it('reconnects after an explicit disconnect even when URL and token are unchanged', async () => {
      router.init(createConfig(createCloudSettings()));
      await router.updateConnection('https://cloud.fly.dev', 'token');
      router.disconnect();

      mockDisconnect.mockClear();
      cloudEventChannelMock.disconnect.mockClear();
      cloudEventChannelMock.connect.mockClear();
      mockOutboxOnConnectionChanged.mockClear();

      await router.updateConnection('https://cloud.fly.dev', 'token');

      expect(mockDisconnect).not.toHaveBeenCalled();
      expect(cloudEventChannelMock.connect).toHaveBeenCalledWith('https://cloud.fly.dev', 'token');
      expect(mockOutboxOnConnectionChanged).toHaveBeenCalledWith('https://cloud.fly.dev');
    });

    it('disconnect cleans up the client', async () => {
      router.init(createConfig(createCloudSettings()));
      // Force client creation
      await router.updateConnection('https://cloud.fly.dev', 'token');
      router.disconnect();
      // Disconnect should have been called on the client
      expect(mockDisconnect).toHaveBeenCalled();
    });

    it('persists cloud memory approvals with recomputed location and dual-written spacePath', async () => {
      router.init(createConfig(createCloudSettings()));
      await router.updateConnection('https://cloud.fly.dev', 'token');

      const interceptor = cloudEventChannelMock.onMemoryApprovalReceived.mock.calls[0]?.[0] as
        | ((approval: Record<string, unknown>) => Promise<void>)
        | undefined;
      expect(interceptor).toBeDefined();

      mockAddPendingMemoryApproval.mockClear();
      await interceptor?.({
        toolUseId: 'tool-cloud-memory-1',
        originalTurnId: 'orig-turn-1',
        originalSessionId: 'orig-session-1',
        turnId: 'turn-1',
        sessionId: 'session-1',
        filePath: '/data/workspace/General/notes.md',
        spaceName: 'General',
        destination: {
          path: '/data/workspace/General/notes.md',
          spaceName: 'General',
          spacePath: '',
          sharing: 'restricted',
        },
      });

      expect(mockAddPendingMemoryApproval).toHaveBeenCalledWith(
        expect.objectContaining({
          toolUseId: 'tool-cloud-memory-1',
          filePath: '/data/workspace/General/notes.md',
          spacePath: 'General/notes.md',
          location: CLOUD_LOCATION,
        }),
      );
    });

    // =======================================================================
    // MA4: updateConnection() setup-interleaving race. Concurrent/rapid calls
    // (fire-and-forget from the settings handler) must not interleave their
    // async setup, and a direct disconnect() during setup must not resurrect
    // the connection. Enforced by the connection-epoch guards after each await.
    // docs/plans/260618_updateconnection-setup-race/PLAN.md
    // =======================================================================

    const settleMicrotasks = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

    function connectionState(r: CloudRouter): { url: string | null; token: string | null; client: unknown } {
      const internal = r as unknown as {
        connectedCloudUrl: string | null;
        connectedCloudToken: string | null;
        httpClient: unknown;
      };
      return { url: internal.connectedCloudUrl, token: internal.connectedCloudToken, client: internal.httpClient };
    }

    it('serializes interleaved updateConnection calls — last requested wins, no mixed state', async () => {
      router.init(createConfig(createCloudSettings()));
      cloudEventChannelMock.connect.mockClear();

      // Fire two updateConnections back-to-back without awaiting the first: both
      // run their synchronous disconnect() (bumping the epoch) before either's
      // first await resolves, so the earlier call must bail at its first guard.
      const pA = router.updateConnection('https://a.fly.dev', 'tokA');
      const pB = router.updateConnection('https://b.fly.dev', 'tokB');
      await Promise.all([pA, pB]);
      await settleMicrotasks();

      // Only B completed setup: the event channel connected exactly once, with B's
      // creds, and the live connection state is entirely B's (no A/B mix).
      const connectCalls = cloudEventChannelMock.connect.mock.calls;
      expect(connectCalls).toEqual([['https://b.fly.dev', 'tokB']]);
      const state = connectionState(router);
      expect(state.url).toBe('https://b.fly.dev');
      expect(state.token).toBe('tokB');
      expect(state.client).not.toBeNull();

      router.disconnect();
    });

    it('a direct disconnect() during updateConnection setup does not resurrect the connection', async () => {
      router.init(createConfig(createCloudSettings()));
      cloudEventChannelMock.connect.mockClear();

      const pA = router.updateConnection('https://a.fly.dev', 'tokA');
      router.disconnect(); // direct teardown mid-setup (bumps the epoch)
      await pA;
      await settleMicrotasks();

      // A must have bailed before installing anything: no event-channel connect,
      // and the connection state stays torn down.
      expect(cloudEventChannelMock.connect).not.toHaveBeenCalled();
      const state = connectionState(router);
      expect(state.client).toBeNull();
      expect(state.url).toBeNull();
      expect(state.token).toBeNull();
    });
  });

  // =========================================================================
  // settings merge
  // =========================================================================

  describe('settings merge', () => {
    it('preserves local-only fields on settings:get (cloudInstance, mcpConfigFile, coreDirectory)', async () => {
      router.init(createConfig(createCloudSettings()));
      mockGet.mockResolvedValue({
        coreDirectory: '/data/workspace',
        mcpConfigFile: '/data/mcp/super-mcp-router.json',
        voice: {},
        cloudInstance: { mode: 'should-be-overwritten' },
      });

      const result = await router.forward('settings:get', []) as Record<string, unknown>;
      // Local values should override cloud values
      expect(result.cloudInstance).toEqual({
        mode: 'cloud',
        cloudUrl: 'https://rebel-test.fly.dev',
        cloudToken: 'placeholder',
      });
      expect(result.mcpConfigFile).toBe('/Users/me/Library/rebel/mcp/super-mcp-router.json');
      expect(result.coreDirectory).toBe('/Users/me/Documents/Core');
    });
  });

  // =========================================================================
  // pullChangedSessions — additive-only delete logic
  // =========================================================================

  describe('pullChangedSessions', () => {
    beforeEach(() => {
      mockSyncedSessions.clear();
      mockListSessions.mockReturnValue([]);
      mockGet.mockResolvedValue([]);
      mockGetSession.mockResolvedValue(null);
      mockGetSession.mockClear();
      mockUpsertSession.mockResolvedValue(undefined);
      mockUpsertSessionWithOutcome.mockImplementation(async (): Promise<MockSessionUpsertOutcome> => 'persisted');
      mockDeleteSession.mockResolvedValue(undefined);
    });

    async function initCloudRouter(): Promise<CloudRouter> {
      const r = new CloudRouter();
      r.init(createConfig(createCloudSettings()));
      // Spy on pullChangedSessions to deterministically await the fire-and-forget
      // initial pull triggered inside updateConnection (no arbitrary setTimeout).
      const pullSpy = vi.spyOn(r, 'pullChangedSessions');
      await r.updateConnection('https://rebel-test.fly.dev', 'placeholder');
      for (const result of pullSpy.mock.results) {
        if (result.type === 'return') await (result.value as Promise<void>).catch(() => {});
      }
      pullSpy.mockRestore();
      // Let cascaded .then() callbacks (push, inbox, lifecycle) start and settle
      await new Promise(resolve => setTimeout(resolve, 0));
      // Reset mock call counts so tests start fresh after the initial pull
      mockGet.mockReset();
      mockGet.mockResolvedValue([]);
      mockListSessions.mockClear();
      mockListSessions.mockReturnValue([]);
      mockDeleteSession.mockClear();
      mockUpsertSession.mockClear();
      mockUpsertSessionWithOutcome.mockClear();
      mockMarkCloudSynced.mockClear();
      mockOnSessionsSaved.mockClear();
      return r;
    }

    it('keeps local-only sessions that are not on cloud', async () => {
      const r = await initCloudRouter();

      // Local has a session that was never synced to cloud
      mockListSessions.mockReturnValue([
        { id: 'local-only-1', updatedAt: 1000 },
      ]);
      // Cloud has no sessions
      mockGet.mockResolvedValue([]);

      await r.pullChangedSessions();

      // Should NOT delete the local-only session
      expect(mockDeleteSession).not.toHaveBeenCalled();
      r.disconnect();
    });

    it('never deletes local sessions even if missing from cloud (additive-only)', async () => {
      const r = await initCloudRouter();

      // Mark session as previously synced
      mockSyncedSessions.add('cloud-deleted-1');

      mockListSessions.mockReturnValue([
        { id: 'cloud-deleted-1', updatedAt: 1000 },
      ]);
      // Cloud no longer has the session
      mockGet.mockResolvedValue([]);

      await r.pullChangedSessions();

      // Cloud sync is additive-only — must NEVER delete local sessions
      expect(mockDeleteSession).not.toHaveBeenCalled();
      r.disconnect();
    });

    it('upserts sessions that are new on cloud', async () => {
      const r = await initCloudRouter();

      mockListSessions.mockReturnValue([]);
      // Cloud has a new session
      mockGet
        .mockResolvedValueOnce([{ id: 'new-cloud-1', updatedAt: 2000 }])
        .mockResolvedValueOnce({ id: 'new-cloud-1', updatedAt: 2000, messages: [] });

      await r.pullChangedSessions();

      expect(mockUpsertSessionWithOutcome).toHaveBeenCalled();
      r.disconnect();
    });

    it('suppresses cloud upserts in pullChangedSessions for sessions with pending local outbox deletes', async () => {
      const r = await initCloudRouter();
      const syncSpy = vi.spyOn(r, 'syncSessionFromCloud').mockResolvedValue({
        sessionId: 'sess-allowed',
        updatedLocal: true,
      });

      mockOutboxGetPendingDeleteSessionIds.mockReturnValue(new Set(['sess-pending-delete']));
      mockListSessions.mockReturnValue([]);
      mockGet.mockImplementation(async (path: string) => {
        if (path.startsWith('/api/sessions?summaries=true')) {
          return [
            { id: 'sess-pending-delete', updatedAt: 2000 },
            { id: 'sess-allowed', updatedAt: 2000 },
          ];
        }
        if (path.startsWith('/api/sessions/tombstones')) {
          return { tombstones: [], serverNow: Date.now() };
        }
        return [];
      });
      loggerMock.info.mockClear();

      await r.pullChangedSessions();

      expect(syncSpy).toHaveBeenCalledTimes(1);
      expect(syncSpy).toHaveBeenCalledWith('sess-allowed', expect.any(Number));
      expect(syncSpy).not.toHaveBeenCalledWith('sess-pending-delete', expect.any(Number));
      expect(loggerMock.info).toHaveBeenCalledWith(
        expect.objectContaining({ pendingDeletesTotal: 1, suppressedPendingDeletes: 1 }),
        'pullChangedSessions: suppressed cloud upserts with pending local delete outbox entries',
      );
      r.disconnect();
    });

    it('emits breadcrumb when pull suppression affects 10+ sessions', async () => {
      const r = await initCloudRouter();
      const syncSpy = vi.spyOn(r, 'syncSessionFromCloud').mockResolvedValue({
        sessionId: 'sess-allowed',
        updatedLocal: true,
      });
      const addBreadcrumbSpy = vi.spyOn(getErrorReporter(), 'addBreadcrumb');
      const suppressedIds = Array.from({ length: 10 }, (_, index) => `sess-pending-${index + 1}`);

      mockOutboxGetPendingDeleteSessionIds.mockReturnValue(new Set(suppressedIds));
      mockListSessions.mockReturnValue([]);
      mockGet.mockImplementation(async (path: string) => {
        if (path.startsWith('/api/sessions?summaries=true')) {
          return [
            ...suppressedIds.map((id) => ({ id, updatedAt: 2000 })),
            { id: 'sess-allowed', updatedAt: 2000 },
          ];
        }
        if (path.startsWith('/api/sessions/tombstones')) {
          return { tombstones: [], serverNow: Date.now() };
        }
        return [];
      });

      await r.pullChangedSessions();

      expect(syncSpy).toHaveBeenCalledTimes(1);
      expect(syncSpy).toHaveBeenCalledWith('sess-allowed', expect.any(Number));
      expect(addBreadcrumbSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          category: 'cloud-pull-mass-suppression',
          message: expect.stringContaining('Suppressed 10 cloud upserts'),
          data: expect.objectContaining({
            pendingDeletesTotal: 10,
            suppressedPendingDeletes: 10,
          }),
        }),
      );
      r.disconnect();
    });

    it('resumes normal pull behavior after outbox delete drains', async () => {
      const r = await initCloudRouter();
      const syncSpy = vi.spyOn(r, 'syncSessionFromCloud').mockResolvedValue({
        sessionId: 'sess-resume',
        updatedLocal: true,
      });

      mockListSessions.mockReturnValue([]);
      mockGet.mockImplementation(async (path: string) => {
        if (path.startsWith('/api/sessions?summaries=true')) {
          return [{ id: 'sess-resume', updatedAt: 2000 }];
        }
        if (path.startsWith('/api/sessions/tombstones')) {
          return { tombstones: [], serverNow: Date.now() };
        }
        return [];
      });

      mockOutboxGetPendingDeleteSessionIds.mockReturnValue(new Set(['sess-resume']));
      await r.pullChangedSessions();
      expect(syncSpy).not.toHaveBeenCalledWith('sess-resume', expect.any(Number));

      syncSpy.mockClear();
      mockOutboxGetPendingDeleteSessionIds.mockReturnValue(new Set());
      await r.pullChangedSessions();
      expect(syncSpy).toHaveBeenCalledTimes(1);
      expect(syncSpy).toHaveBeenCalledWith('sess-resume', expect.any(Number));

      r.disconnect();
    });

    it('applies pulled tombstones by deleting matching local sessions', async () => {
      const r = await initCloudRouter();

      mockListSessions.mockReturnValue([{ id: 'ghost', updatedAt: 1000 }]);
      mockGetSession.mockResolvedValue({ id: 'ghost', updatedAt: 2000, messages: [] });
      mockGet.mockImplementation(async (path: string) => {
        if (path.startsWith('/api/sessions?summaries=true')) {
          return [{ id: 'ghost', updatedAt: 2000 }];
        }
        if (path.startsWith('/api/sessions/ghost')) {
          return { id: 'ghost', updatedAt: 2000, messages: [] };
        }
        if (path.startsWith('/api/sessions/tombstones')) {
          return {
            tombstones: [
              {
                sessionId: 'ghost',
                deletedAt: 2100,
                deletedBy: 'mobile',
                ttlExpiresAt: Date.now() + 60_000,
              },
            ],
          };
        }
        return [];
      });

      await r.pullChangedSessions();

      expect(mockDeleteSession).toHaveBeenCalledWith('ghost', { intent: 'user-delete' });
      r.disconnect();
    });

    it('preserves ALL local sessions regardless of cloud state (additive-only)', async () => {
      const r = await initCloudRouter();

      // local-only: never synced
      // cloud-synced: was synced, still on cloud
      // cloud-deleted: was synced, no longer on cloud
      mockSyncedSessions.add('cloud-synced');
      mockSyncedSessions.add('cloud-deleted');

      mockListSessions.mockReturnValue([
        { id: 'local-only', updatedAt: 1000 },
        { id: 'cloud-synced', updatedAt: 1000 },
        { id: 'cloud-deleted', updatedAt: 1000 },
      ]);
      // Cloud only has cloud-synced
      mockGet.mockResolvedValue([
        { id: 'cloud-synced', updatedAt: 1000 },
      ]);

      await r.pullChangedSessions();

      // Cloud sync is additive-only — must NEVER delete any local session
      expect(mockDeleteSession).not.toHaveBeenCalled();
      r.disconnect();
    });

    it('marks sessions as cloud-synced after syncing from cloud', async () => {
      const r = await initCloudRouter();

      mockListSessions.mockReturnValue([]);
      mockGet
        .mockResolvedValueOnce([{ id: 'from-cloud', updatedAt: 2000 }])
        .mockResolvedValueOnce({ id: 'from-cloud', updatedAt: 2000, messages: [] });

      await r.pullChangedSessions();

      expect(mockMarkCloudSynced).toHaveBeenCalledWith('from-cloud');
      r.disconnect();
    });

    it('unwraps { sessions, totalCount } response format from cloud', async () => {
      const r = await initCloudRouter();

      mockListSessions.mockReturnValue([]);
      // Cloud returns wrapped format (since d1f2ffabd)
      mockGet
        .mockResolvedValueOnce({ sessions: [{ id: 'wrapped-1', updatedAt: 3000 }], totalCount: 1 })
        .mockResolvedValueOnce({ id: 'wrapped-1', updatedAt: 3000, messages: [] });

      await r.pullChangedSessions();

      expect(mockUpsertSessionWithOutcome).toHaveBeenCalled();
      r.disconnect();
    });

    // =======================================================================
    // F1: connection-epoch supersession — a pull that began under a now-torn-
    // down connection (disconnect / account switch) must NOT write stale-account
    // data locally, and must release the mutex so the next connection pulls fresh.
    // docs/plans/260618_cloudrouter-disconnect-race/PLAN.md
    // =======================================================================

    const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

    it('discards a stale session pull after disconnect — no upsert applied (epoch supersession)', async () => {
      const r = await initCloudRouter();
      const syncSpy = vi.spyOn(r, 'syncSessionFromCloud');

      let resolveSummaries!: (value: unknown) => void;
      mockListSessions.mockReturnValue([]);
      mockGet.mockReset();
      mockGet.mockImplementation((path: string) => {
        if (path.startsWith('/api/sessions?summaries=true')) {
          return new Promise((resolve) => { resolveSummaries = resolve; });
        }
        if (path.startsWith('/api/sessions/tombstones')) {
          return Promise.resolve({ tombstones: [], serverNow: Date.now() });
        }
        return Promise.resolve([]);
      });

      const pull = r.pullChangedSessions();   // parks at the summaries GET
      await tick();                            // let executePullSync reach the await
      r.disconnect();                          // epoch++, mutex released
      resolveSummaries([{ id: 'stale-cloud-1', updatedAt: 2000 }]); // resolve the stale GET
      await pull;

      // The connection changed mid-pull, so the cloud results are discarded
      // BEFORE the upsert loop — no stale-account session is written locally.
      expect(syncSpy).not.toHaveBeenCalled();
      expect(mockUpsertSessionWithOutcome).not.toHaveBeenCalled();
    });

    it('releases the sync mutex on disconnect so the next connection pulls fresh (fix B)', async () => {
      const r = await initCloudRouter();

      let summariesCalls = 0;
      let resolveFirst!: (value: unknown) => void;
      mockListSessions.mockReturnValue([]);
      mockGet.mockReset();
      mockGet.mockImplementation((path: string) => {
        if (path.startsWith('/api/sessions?summaries=true')) {
          summariesCalls += 1;
          if (summariesCalls === 1) return new Promise((resolve) => { resolveFirst = resolve; });
          return Promise.resolve([]);
        }
        if (path.startsWith('/api/sessions/tombstones')) {
          return Promise.resolve({ tombstones: [], serverNow: Date.now() });
        }
        return Promise.resolve([]);
      });

      const pullA = r.pullChangedSessions();
      await tick();                            // A parked at GET #1
      expect(summariesCalls).toBe(1);
      r.disconnect();                          // releases the mutex

      const pullB = r.pullChangedSessions();   // must NOT coalesce onto the orphaned A
      await tick();
      expect(summariesCalls).toBe(2);          // fresh pull issued → mutex was released

      resolveFirst([]);                        // let the orphaned A settle (superseded)
      await Promise.all([pullA, pullB]);
    });

    it('orphaned superseded sync does not clobber a newer sync mutex (identity guard, fix C)', async () => {
      const r = await initCloudRouter();

      let summariesCalls = 0;
      let resolveA!: (value: unknown) => void;
      let resolveB!: (value: unknown) => void;
      mockListSessions.mockReturnValue([]);
      mockGet.mockReset();
      mockGet.mockImplementation((path: string) => {
        if (path.startsWith('/api/sessions?summaries=true')) {
          summariesCalls += 1;
          if (summariesCalls === 1) return new Promise((resolve) => { resolveA = resolve; });
          if (summariesCalls === 2) return new Promise((resolve) => { resolveB = resolve; });
          return Promise.resolve([]);
        }
        if (path.startsWith('/api/sessions/tombstones')) {
          return Promise.resolve({ tombstones: [], serverNow: Date.now() });
        }
        return Promise.resolve([]);
      });

      const pullA = r.pullChangedSessions();
      await tick();                            // A parked (GET #1)
      r.disconnect();                          // mutex released
      const pullB = r.pullChangedSessions();   // claims the mutex (GET #2)
      await tick();
      expect(summariesCalls).toBe(2);

      resolveA([]);                            // A resolves superseded; its finally must NOT null B's slot
      await pullA;
      await tick();

      const pullC = r.pullChangedSessions();   // should coalesce onto the live B (no GET #3)
      await tick();
      expect(summariesCalls).toBe(2);          // B's mutex intact → C coalesced, no fresh pull

      resolveB([]);                            // let B (and coalesced C) finish
      await Promise.all([pullB, pullC]);
    });

    it('releases the inbox sync mutex on disconnect so the next pull runs fresh (inbox parity)', async () => {
      const r = await initCloudRouter();
      // Drain any inbox pull kicked off by the initial connect cascade.
      for (let i = 0; i < 10; i++) await tick();

      let indexCalls = 0;
      let resolveFirst!: (value: unknown) => void;
      mockPost.mockReset();
      mockPost.mockImplementation((path: string) => {
        if (path.includes('load-index')) {
          indexCalls += 1;
          if (indexCalls === 1) return new Promise((resolve) => { resolveFirst = resolve; });
          return Promise.resolve({ entries: [], deletedIds: [], history: [] });
        }
        return Promise.resolve(null);
      });

      const pullA = r.pullInboxChanges();
      await tick();                            // A parked at the inbox index fetch
      expect(indexCalls).toBe(1);
      r.disconnect();                          // releases activeInboxSyncPromise

      const pullB = r.pullInboxChanges();      // must run fresh, not coalesce
      await tick();
      expect(indexCalls).toBe(2);              // fresh inbox pull issued → mutex released

      resolveFirst({ entries: [], deletedIds: [], history: [] });
      await Promise.allSettled([pullA, pullB]);
    });

    it('does not advance the tombstone cursor when disconnect lands during the tombstone fetch (MA1)', async () => {
      const r = await initCloudRouter();

      let resolveTombstones!: (value: unknown) => void;
      let tombstoneRequested = false;
      mockListSessions.mockReturnValue([]);
      mockGet.mockReset();
      mockGet.mockImplementation((path: string) => {
        if (path.startsWith('/api/sessions?summaries=true')) return Promise.resolve([]);
        if (path.startsWith('/api/sessions/tombstones')) {
          tombstoneRequested = true;
          return new Promise((resolve) => { resolveTombstones = resolve; });
        }
        return Promise.resolve([]);
      });

      const pull = r.pullChangedSessions();
      // Wait until execution actually reaches the (parked) tombstone fetch.
      for (let i = 0; i < 20 && !tombstoneRequested; i++) await tick();
      expect(tombstoneRequested).toBe(true);

      r.disconnect(); // epoch++ DURING the tombstone fetch
      resolveTombstones({
        tombstones: [{ sessionId: 's1', deletedAt: 999_000 }],
        serverNow: 999_999,
      });
      await pull;

      // The stale-account tombstone response is discarded INSIDE
      // refreshSessionTombstones: no local delete, and (the MA1-discriminating
      // assertion) the persisted tombstone cursor is NOT advanced to the stale
      // serverNow — which would otherwise suppress upserts for the new account.
      expect(mockDeleteSession).not.toHaveBeenCalled();
      expect(mockLastSessionTombstoneSyncAt).not.toBe(999_999);
    });

    it('discards a per-session upsert when disconnect lands during the syncSessionFromCloud fetch', async () => {
      const r = await initCloudRouter();

      let resolveSession!: (value: unknown) => void;
      let sessionFetchRequested = false;
      mockListSessions.mockReturnValue([]);
      mockGet.mockReset();
      mockGet.mockImplementation((path: string) => {
        if (path.startsWith('/api/sessions?summaries=true')) {
          return Promise.resolve([{ id: 'sess-x', updatedAt: 5000 }]); // one upsert candidate
        }
        if (path.startsWith('/api/sessions/tombstones')) {
          return Promise.resolve({ tombstones: [], serverNow: Date.now() });
        }
        if (path.startsWith('/api/sessions/')) {
          // The per-session fetch inside syncSessionFromCloud — park it.
          sessionFetchRequested = true;
          return new Promise((resolve) => { resolveSession = resolve; });
        }
        return Promise.resolve([]);
      });

      const pull = r.pullChangedSessions();
      for (let i = 0; i < 20 && !sessionFetchRequested; i++) await tick();
      expect(sessionFetchRequested).toBe(true);

      r.disconnect(); // epoch++ DURING syncSessionFromCloud's own per-session fetch
      resolveSession({ id: 'sess-x', updatedAt: 5000, messages: [] });
      await pull;

      // syncSessionFromCloud bails before its write block — no stale-account
      // session content is upserted locally.
      expect(mockUpsertSessionWithOutcome).not.toHaveBeenCalled();
    });
  });

  // =========================================================================
  // pullSettings — deep-compare guard
  // =========================================================================

  describe('pullSettings', () => {
    beforeEach(() => {
      mockUpdateSettings.mockClear();
    });

    it('is a no-op — desktop is the sole settings authority', async () => {
      const localSettings = createCloudSettings();
      const r = new CloudRouter();
      r.init(createConfig(localSettings));
      // Provide empty responses for background tasks triggered by updateConnection
      mockGet.mockResolvedValue([]);
      mockListSessions.mockReturnValue([]);
      await r.updateConnection('https://rebel-test.fly.dev', 'placeholder');
      // Let fire-and-forget background tasks from updateConnection settle
      await new Promise((resolve) => setTimeout(resolve, 100));

      const callsBefore = mockGet.mock.calls.length;
      await r.pullSettings();

      // pullSettings must never write to local settings
      expect(mockUpdateSettings).not.toHaveBeenCalled();
      // Should not make any additional fetch calls
      expect(mockGet.mock.calls.length).toBe(callsBefore);
      r.disconnect();
    });
  });

  // =========================================================================
  // syncSessionFromCloud — updatedAt guard
  // =========================================================================

  describe('syncSessionFromCloud — updatedAt guard', () => {
    async function initCloudRouter(): Promise<CloudRouter> {
      // Ensure clean mock state for background pulls triggered by updateConnection
      mockGet.mockResolvedValue([]);
      mockListSessions.mockReturnValue([]);
      const r = new CloudRouter();
      r.init(createConfig(createCloudSettings()));
      const pullSpy = vi.spyOn(r, 'pullChangedSessions');
      await r.updateConnection('https://rebel-test.fly.dev', 'placeholder');
      for (const result of pullSpy.mock.results) {
        if (result.type === 'return') await (result.value as Promise<void>).catch(() => {});
      }
      pullSpy.mockRestore();
      await new Promise((resolve) => setTimeout(resolve, 0));
      return r;
    }

    beforeEach(() => {
      mockGetSession.mockResolvedValue(null);
      mockUpsertSession.mockClear();
      mockUpsertSessionWithOutcome.mockClear();
      mockMarkCloudSynced.mockClear();
      mockMarkCloudActive.mockClear();
      mockTouchCloudActivity.mockClear();
      mockOnSessionsSaved.mockClear();
    });

    it('suppresses cloud upserts in syncSessionFromCloud (WS path) for sessions with pending local outbox deletes', async () => {
      const r = await initCloudRouter();

      mockOutboxHasPendingDelete.mockReturnValue(true);
      mockOutboxHasPendingDelete.mockClear();
      mockGet.mockClear();
      mockUpsertSession.mockClear();
      mockUpsertSessionWithOutcome.mockClear();
      loggerMock.info.mockClear();

      const result = await r.syncSessionFromCloud('sess-ws-pending-delete');

      expect(result).toEqual({ sessionId: 'sess-ws-pending-delete', updatedLocal: false });
      expect(mockOutboxHasPendingDelete).toHaveBeenCalledWith('sess-ws-pending-delete');
      expect(mockGet).not.toHaveBeenCalled();
      expect(mockUpsertSession).not.toHaveBeenCalled();
      expect(mockUpsertSessionWithOutcome).not.toHaveBeenCalled();
      expect(loggerMock.info).toHaveBeenCalledWith(
        { sessionIdHash: hashSessionId('sess-ws-pending-delete') },
        'syncSessionFromCloud skipped: pending local outbox delete (resurrection prevention)',
      );
      r.disconnect();
    });

    it('skips upsert and indexing when local session has newer updatedAt, still calls metadata', async () => {
      const r = await initCloudRouter();

      // Local session is newer
      mockGetSession.mockResolvedValue({ id: 'sess-1', updatedAt: 3000 });
      // Cloud session is older
      mockGet.mockResolvedValue({ id: 'sess-1', updatedAt: 2000 });

      await r.syncSessionFromCloud('sess-1');

      expect(mockUpsertSession).not.toHaveBeenCalled();
      expect(mockUpsertSessionWithOutcome).not.toHaveBeenCalled();
      expect(mockOnSessionsSaved).not.toHaveBeenCalled();
      expect(mockMarkCloudSynced).not.toHaveBeenCalled();
      expect(mockMarkCloudActive).toHaveBeenCalledWith('sess-1');
      expect(mockTouchCloudActivity).toHaveBeenCalledWith('sess-1');
      r.disconnect();
    });

    it('skips upsert and indexing when local session has same updatedAt (desktop wins ties), still calls metadata', async () => {
      const r = await initCloudRouter();

      // Same updatedAt — desktop wins ties
      mockGetSession.mockResolvedValue({ id: 'sess-2', updatedAt: 2000 });
      mockGet.mockResolvedValue({ id: 'sess-2', updatedAt: 2000 });

      await r.syncSessionFromCloud('sess-2');

      expect(mockUpsertSession).not.toHaveBeenCalled();
      expect(mockUpsertSessionWithOutcome).not.toHaveBeenCalled();
      expect(mockOnSessionsSaved).not.toHaveBeenCalled();
      expect(mockMarkCloudSynced).not.toHaveBeenCalled();
      expect(mockMarkCloudActive).toHaveBeenCalledWith('sess-2');
      expect(mockTouchCloudActivity).toHaveBeenCalledWith('sess-2');
      r.disconnect();
    });

    it('performs upsert and indexes when local session has older updatedAt, calls metadata', async () => {
      const r = await initCloudRouter();

      // Local is older
      mockGetSession.mockResolvedValue({ id: 'sess-3', updatedAt: 1000 });
      const cloudSession = { id: 'sess-3', updatedAt: 2000 };
      mockGet.mockResolvedValue(cloudSession);

      await r.syncSessionFromCloud('sess-3');

      expect(mockUpsertSessionWithOutcome).toHaveBeenCalledWith(cloudSession);
      expect(mockOnSessionsSaved).toHaveBeenCalledWith([cloudSession]);
      expect(mockMarkCloudSynced).toHaveBeenCalledWith('sess-3');
      expect(mockMarkCloudActive).toHaveBeenCalledWith('sess-3');
      expect(mockTouchCloudActivity).toHaveBeenCalledWith('sess-3');
      r.disconnect();
    });

    it('performs upsert and indexes when no local session exists (new cloud-originated session), calls metadata', async () => {
      const r = await initCloudRouter();

      // No local session
      mockGetSession.mockResolvedValue(null);
      const cloudSession = { id: 'sess-4', updatedAt: 2000 };
      mockGet.mockResolvedValue(cloudSession);

      await r.syncSessionFromCloud('sess-4');

      expect(mockUpsertSessionWithOutcome).toHaveBeenCalledWith(cloudSession);
      expect(mockOnSessionsSaved).toHaveBeenCalledWith([cloudSession]);
      expect(mockMarkCloudSynced).toHaveBeenCalledWith('sess-4');
      expect(mockMarkCloudActive).toHaveBeenCalledWith('sess-4');
      expect(mockTouchCloudActivity).toHaveBeenCalledWith('sess-4');
      r.disconnect();
    });

    it('merges turns when local has turns not present on cloud', async () => {
      const r = await initCloudRouter();

      // Local has turns A and B
      mockGetSession.mockResolvedValue({
        id: 'sess-5',
        updatedAt: 1000,
        messages: [
          { id: 'msg-1', turnId: 'turn-a', role: 'user', text: 'hi', createdAt: 100 },
          { id: 'msg-2', turnId: 'turn-b', role: 'user', text: 'bye', createdAt: 200 },
        ],
        eventsByTurn: { 'turn-a': [], 'turn-b': [] },
      });
      // Cloud only has turn A (turn B not pushed yet) + new turn C, and is "newer"
      mockGet.mockResolvedValue({
        id: 'sess-5',
        updatedAt: 2000,
        messages: [
          { id: 'msg-1', turnId: 'turn-a', role: 'user', text: 'hi', createdAt: 100 },
          { id: 'msg-3', turnId: 'turn-c', role: 'assistant', text: 'cloud turn', createdAt: 300 },
        ],
        eventsByTurn: { 'turn-a': [], 'turn-c': [] },
      });

      await r.syncSessionFromCloud('sess-5');

      // Should merge: local turns A+B merged with cloud turn C
      expect(mockUpsertSessionWithOutcome).toHaveBeenCalledTimes(1);
      const mergedSession = mockUpsertSessionWithOutcome.mock.calls[0][0] as AgentSession;
      expect(mergedSession.messages).toHaveLength(3); // A + B + C
      expect(mergedSession.messages.map((m: { turnId: string }) => m.turnId)).toEqual(['turn-a', 'turn-b', 'turn-c']);
      expect(mergedSession.updatedAt).toBe(300); // content-derived: last message createdAt (not Math.max of session timestamps)
      // Metadata side effects still run
      expect(mockMarkCloudSynced).toHaveBeenCalledWith('sess-5');
      expect(mockMarkCloudActive).toHaveBeenCalledWith('sess-5');
      r.disconnect();
    });

    it('allows upsert when cloud has all local turns plus new ones', async () => {
      const r = await initCloudRouter();

      // Local has turn A only
      mockGetSession.mockResolvedValue({
        id: 'sess-6',
        updatedAt: 1000,
        messages: [
          { id: 'msg-1', turnId: 'turn-a', role: 'user', text: 'hi', createdAt: 100 },
        ],
        eventsByTurn: { 'turn-a': [] },
      });
      // Cloud has turn A + new turn B, and is newer
      const cloudSession = {
        id: 'sess-6',
        updatedAt: 2000,
        messages: [
          { id: 'msg-1', turnId: 'turn-a', role: 'user', text: 'hi', createdAt: 100 },
          { id: 'msg-2', turnId: 'turn-b', role: 'assistant', text: 'cloud reply', createdAt: 200 },
        ],
        eventsByTurn: { 'turn-a': [], 'turn-b': [] },
      };
      mockGet.mockResolvedValue(cloudSession);

      await r.syncSessionFromCloud('sess-6');

      // Should upsert — cloud is a superset of local turns
      expect(mockUpsertSessionWithOutcome).toHaveBeenCalledWith(cloudSession);
      expect(mockOnSessionsSaved).toHaveBeenCalledWith([cloudSession]);
      r.disconnect();
    });

    // F2 (260618 fix-autotitle-cloud-livesync refinement): exercise the real
    // full-replacement pull branch ("No local-only turns — safe to accept cloud
    // version") end-to-end, asserting the resolved title AND both auto-title
    // metadata fields actually reach upsertSessionWithOutcome (not just the helper
    // in isolation). Local title is auto-overwritable, cloud carries a real title
    // + metadata → both adopted together on the written session.
    it('full-replacement pull: resolved title + both auto-title metadata fields reach upsertSessionWithOutcome', async () => {
      const r = await initCloudRouter();

      // Local has only turn-a, title is an auto-overwritable default → cloud title wins.
      mockGetSession.mockResolvedValue({
        id: 'sess-autotitle',
        updatedAt: 1000,
        title: 'New conversation',
        messages: [
          { id: 'msg-1', turnId: 'turn-a', role: 'user', text: 'hi', createdAt: 100 },
        ],
        eventsByTurn: { 'turn-a': [] },
      });
      // Cloud has the same turn-a (no local-only turns), is newer, and carries a
      // real auto-generated title plus its paired metadata.
      const cloudSession = {
        id: 'sess-autotitle',
        updatedAt: 2000,
        title: 'Quarterly Planning Sync',
        autoTitleGeneratedAt: 1_700_000_888_888,
        autoTitleTurnCount: 2,
        messages: [
          { id: 'msg-1', turnId: 'turn-a', role: 'user', text: 'hi', createdAt: 100 },
        ],
        eventsByTurn: { 'turn-a': [] },
      };
      mockGet.mockResolvedValue(cloudSession);

      await r.syncSessionFromCloud('sess-autotitle');

      expect(mockUpsertSessionWithOutcome).toHaveBeenCalledTimes(1);
      const written = mockUpsertSessionWithOutcome.mock.calls[0][0] as AgentSession;
      expect(written.title).toBe('Quarterly Planning Sync');
      expect(written.autoTitleGeneratedAt).toBe(1_700_000_888_888);
      expect(written.autoTitleTurnCount).toBe(2);
      r.disconnect();
    });
  });

  describe('Stage B continuity sync ordering + intent plumbing', () => {
    async function initCloudRouter(): Promise<CloudRouter> {
      mockGet.mockResolvedValue([]);
      mockListSessions.mockReturnValue([]);
      const r = new CloudRouter();
      r.init(createConfig(createCloudSettings()));
      const pullSpy = vi.spyOn(r, 'pullChangedSessions');
      await r.updateConnection('https://rebel-test.fly.dev', 'placeholder');
      for (const result of pullSpy.mock.results) {
        if (result.type === 'return') await (result.value as Promise<void>).catch(() => {});
      }
      pullSpy.mockRestore();
      await new Promise((resolve) => setTimeout(resolve, 0));
      mockGet.mockReset();
      mockGetSession.mockReset();
      mockUpsertSession.mockReset();
      mockUpsertSessionWithOutcome.mockReset();
      mockUpsertSessionWithOutcome.mockImplementation(async (): Promise<MockSessionUpsertOutcome> => 'persisted');
      mockMarkCloudActive.mockReset();
      mockMarkLocalOnly.mockReset();
      mockRestoreContinuityEntrySnapshot.mockReset();
      mockFlushContinuityMetadata.mockResolvedValue({ success: true });
      mockGetAllContinuityStates.mockReturnValue({});
      mockGetStaleCloudSessions.mockReturnValue([]);
      loggerMock.warn.mockClear();
      loggerMock.info.mockClear();
      return r;
    }

    async function pushContinuityMapForTest(r: CloudRouter): Promise<{ putSpy: ReturnType<typeof vi.fn>; payload: Record<string, unknown> }> {
      const putSpy = vi.fn().mockResolvedValue({ ok: true });
      const pushMethod = (
        r as unknown as {
          pushContinuityStateMap: (
            client: { put: (path: string, payload: unknown) => Promise<unknown> },
            force?: boolean,
          ) => Promise<void>;
        }
      ).pushContinuityStateMap.bind(r);

      await pushMethod({ put: putSpy }, true);
      return {
        putSpy,
        payload: (putSpy.mock.calls[0]?.[1] as Record<string, unknown>) ?? {},
      };
    }

    it('race regression: pushContinuityStateMap sees cloud_active during syncSessionFromCloud interleave', async () => {
      const r = await initCloudRouter();
      const continuityState: Record<string, { state: 'local_only' | 'cloud_active'; cloudRemovalIntent?: { requestedAt: number; requestedBy: 'user' | 'retention-policy' } }> = {};

      mockGetContinuityEntry.mockImplementation((id: string) => continuityState[id] ?? null);
      mockMarkCloudActive.mockImplementation((id: string) => {
        continuityState[id] = { state: 'cloud_active' };
      });
      mockMarkLocalOnly.mockImplementation(() => {});
      mockGetAllContinuityStates.mockImplementation(() => ({ ...continuityState }));
      mockGetSessionIds.mockReturnValue(['race-session']);
      mockGetSession.mockResolvedValue(null);
      mockGet.mockResolvedValue({
        id: 'race-session',
        updatedAt: 2_000,
        messages: [],
        eventsByTurn: {},
      });

      let releaseUpsert: (() => void) | undefined;
      mockUpsertSessionWithOutcome.mockImplementation(() => new Promise<MockSessionUpsertOutcome>((resolve) => {
        releaseUpsert = () => resolve('persisted');
      }));

      const syncPromise = r.syncSessionFromCloud('race-session');
      for (let i = 0; i < 10 && mockMarkCloudActive.mock.calls.length === 0; i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
      expect(mockMarkCloudActive).toHaveBeenCalledWith('race-session');

      const { payload } = await pushContinuityMapForTest(r);
      const entry = payload['race-session'] as { state?: string } | undefined;
      expect(entry?.state).toBe('cloud_active');

      if (releaseUpsert) {
        releaseUpsert();
      }
      await syncPromise;
      r.disconnect();
    });

    it('rolls back continuity metadata snapshot when upsert throws after markCloudActive', async () => {
      const r = await initCloudRouter();

      mockGetContinuityEntry.mockReturnValue(null);
      mockGetSession.mockResolvedValue(null);
      mockGet.mockResolvedValue({
        id: 'sess-rollback',
        updatedAt: 2_000,
        messages: [],
        eventsByTurn: {},
      });
      mockUpsertSessionWithOutcome.mockRejectedValueOnce(new Error('upsert failed'));

      await expect(r.syncSessionFromCloud('sess-rollback')).rejects.toThrow('upsert failed');
      expect(mockMarkCloudActive).toHaveBeenCalledWith('sess-rollback');
      expect(mockRestoreContinuityEntrySnapshot).toHaveBeenCalledWith('sess-rollback', null);
      r.disconnect();
    });

    it('rolls back to pre-existing continuity entry when upsert fails after promotion', async () => {
      const r = await initCloudRouter();

      const continuityState: Record<string, {
        state: 'local_only' | 'cloud_active';
        cloudRemovalIntent?: { requestedAt: number; requestedBy: 'user' | 'retention-policy'; source?: 'desktop' | 'mobile' | 'web' | 'cloud' };
      }> = {
        'sess-rollback-existing': {
          state: 'cloud_active',
          cloudRemovalIntent: {
            requestedAt: 12_345,
            requestedBy: 'user',
            source: 'desktop',
          },
        },
      };

      mockGetContinuityEntry.mockImplementation((id: string) => continuityState[id] ?? null);
      mockMarkCloudActive.mockImplementation((id: string) => {
        const existing = continuityState[id];
        continuityState[id] = {
          ...(existing ?? { state: 'cloud_active' }),
          state: 'cloud_active',
          cloudRemovalIntent: undefined,
        };
      });
      mockRestoreContinuityEntrySnapshot.mockImplementation((id: string, snapshot: {
        state?: 'local_only' | 'cloud_active';
        cloudRemovalIntent?: { requestedAt: number; requestedBy: 'user' | 'retention-policy'; source?: 'desktop' | 'mobile' | 'web' | 'cloud' };
      } | null) => {
        if (!snapshot || !snapshot.state) {
          delete continuityState[id];
          return;
        }
        continuityState[id] = {
          state: snapshot.state,
          ...(snapshot.cloudRemovalIntent ? { cloudRemovalIntent: { ...snapshot.cloudRemovalIntent } } : {}),
        };
      });
      mockGetSession.mockResolvedValue(null);
      mockGet.mockResolvedValue({
        id: 'sess-rollback-existing',
        updatedAt: 2_000,
        messages: [],
        eventsByTurn: {},
      });
      mockUpsertSessionWithOutcome.mockRejectedValueOnce(new Error('upsert failed'));

      await expect(r.syncSessionFromCloud('sess-rollback-existing')).rejects.toThrow('upsert failed');

      const reloadedEntry = continuityState['sess-rollback-existing'];
      expect(reloadedEntry).toEqual({
        state: 'cloud_active',
        cloudRemovalIntent: {
          requestedAt: 12_345,
          requestedBy: 'user',
          source: 'desktop',
        },
      });
      r.disconnect();
    });

    it('logs cloud-sync-mark flush failures and continues syncing', async () => {
      const r = await initCloudRouter();

      mockGetContinuityEntry.mockReturnValue(null);
      mockGetSession.mockResolvedValue(null);
      mockGet.mockResolvedValue({
        id: 'sess-flush-failure',
        updatedAt: 2_000,
        messages: [],
        eventsByTurn: {},
      });
      mockUpsertSessionWithOutcome.mockImplementation(async (): Promise<MockSessionUpsertOutcome> => 'persisted');
      mockFlushContinuityMetadata.mockResolvedValueOnce({
        success: false,
        error: new Error('disk unavailable'),
      });

      const result = await r.syncSessionFromCloud('sess-flush-failure');

      expect(result).toEqual({ sessionId: 'sess-flush-failure', updatedLocal: true });
      expect(mockUpsertSessionWithOutcome).toHaveBeenCalled();
      expect(loggerMock.warn).toHaveBeenCalledWith(
        expect.objectContaining({
          phase: 'cloud-sync-mark',
          sessionIdHash: expect.any(String),
          errorMessage: 'disk unavailable',
        }),
        'Failed to flush continuity metadata after cloud mark',
      );
      r.disconnect();
    });

    it('lifecycle demotions use retention-policy intent and cloud GC does not delete', async () => {
      const r = await initCloudRouter();
      const continuityState: Record<string, {
        state: 'local_only' | 'cloud_active';
        cloudRemovalIntent?: { requestedAt: number; requestedBy: 'user' | 'retention-policy'; source?: 'desktop' };
      }> = {
        'stale-session': { state: 'cloud_active' },
      };

      mockGetStaleCloudSessions.mockReturnValue(['stale-session']);
      mockMarkLocalOnly.mockImplementation((sessionId: string, _reason: string, intent: 'user' | 'retention-policy' | 'inferred') => {
        continuityState[sessionId] = {
          state: 'local_only',
          ...(intent === 'inferred'
            ? {}
            : {
              cloudRemovalIntent: {
                requestedAt: Date.now(),
                requestedBy: intent,
                source: 'desktop',
              },
            }),
        };
      });
      mockGetAllContinuityStates.mockImplementation(() => ({ ...continuityState }));
      mockGetSessionIds.mockReturnValue(['stale-session']);
      (
        r as unknown as { firstPullCompleted: boolean }
      ).firstPullCompleted = true;

      const runLifecycle = (
        r as unknown as { runLifecycleCheck: () => Promise<void> }
      ).runLifecycleCheck.bind(r);
      await runLifecycle();
      expect(mockMarkLocalOnly).toHaveBeenCalledWith('stale-session', 'cloud-disabled', 'retention-policy');

      const { payload } = await pushContinuityMapForTest(r);
      const staleEntry = payload['stale-session'] as {
        state?: string;
        cloudRemovalIntent?: { requestedBy?: string };
      } | undefined;
      expect(staleEntry?.state).toBe('local_only');
      expect(staleEntry?.cloudRemovalIntent?.requestedBy).toBe('retention-policy');

      const deleteSession = vi.fn().mockResolvedValue(undefined);
      const gcOutcome = await runStateMapGC(
        payload as Record<string, { state: 'local_only' | 'cloud_active'; cloudRemovalIntent?: { requestedBy: 'user' | 'retention-policy'; requestedAt: number } }>,
        {
          listSessions: () => [{ id: 'stale-session', updatedAt: Date.now() - (GC_GRACE_WINDOW_MS + 1_000) }],
          deleteSession,
        },
        { emit: vi.fn() },
      );

      expect(deleteSession).not.toHaveBeenCalled();
      expect(gcOutcome.deleted).toEqual([]);
      expect(gcOutcome.protected).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            sessionId: 'stale-session',
            reason: 'retention-policy-visibility-only',
          }),
        ]),
      );
      r.disconnect();
    });

    it('explicit user demotion emits user intent and cloud GC deletes after grace', async () => {
      const r = await initCloudRouter();
      const continuityState: Record<string, {
        state: 'local_only' | 'cloud_active';
        cloudRemovalIntent?: { requestedAt: number; requestedBy: 'user' | 'retention-policy'; source?: 'desktop' };
      }> = {};

      mockMarkLocalOnly.mockImplementation((sessionId: string, _reason: string, intent: 'user' | 'retention-policy' | 'inferred') => {
        continuityState[sessionId] = {
          state: 'local_only',
          ...(intent === 'inferred'
            ? {}
            : {
              cloudRemovalIntent: {
                requestedAt: Date.now(),
                requestedBy: intent,
                source: 'desktop',
              },
            }),
        };
      });
      mockGetAllContinuityStates.mockImplementation(() => ({ ...continuityState }));
      mockGetSessionIds.mockReturnValue(['session-user']);

      const { markLocalOnly } = await import('../cloudContinuityMetadata');
      markLocalOnly('session-user', 'manual-reset', 'user');

      const { payload } = await pushContinuityMapForTest(r);
      const entry = payload['session-user'] as {
        state?: string;
        cloudRemovalIntent?: { requestedBy?: string };
      } | undefined;
      expect(entry?.state).toBe('local_only');
      expect(entry?.cloudRemovalIntent?.requestedBy).toBe('user');

      const deleteSession = vi.fn().mockResolvedValue(undefined);
      const gcOutcome = await runStateMapGC(
        payload as Record<string, { state: 'local_only' | 'cloud_active'; cloudRemovalIntent?: { requestedBy: 'user' | 'retention-policy'; requestedAt: number } }>,
        {
          listSessions: () => [{ id: 'session-user', updatedAt: Date.now() - (GC_GRACE_WINDOW_MS + 1_000) }],
          deleteSession,
        },
        { emit: vi.fn() },
      );

      expect(deleteSession).toHaveBeenCalledWith('session-user', { intent: 'hygiene' });
      expect(gcOutcome.deleted).toContain('session-user');
      r.disconnect();
    });

    it('enrichment default sessions emit local_only without cloudRemovalIntent', async () => {
      const r = await initCloudRouter();

      mockGetAllContinuityStates.mockReturnValue({});
      mockGetSessionIds.mockReturnValue(['session-inferred']);

      const { putSpy, payload } = await pushContinuityMapForTest(r);
      expect(putSpy).toHaveBeenCalledWith('/api/continuity/state', expect.any(Object));
      expect(payload['session-inferred']).toEqual({ state: 'local_only' });
      expect((payload['session-inferred'] as { cloudRemovalIntent?: unknown }).cloudRemovalIntent).toBeUndefined();
      expect(loggerMock.info).toHaveBeenCalledWith(
        expect.objectContaining({
          entries: 1,
          withUserIntent: 0,
          withRetentionIntent: 0,
          inferredOnly: 1,
        }),
        'Pushed continuity state map to cloud',
      );
      r.disconnect();
    });
  });

  // =========================================================================
  // syncSessionFromCloud — cloudUpdatedAt propagation to outbox tracker
  // =========================================================================

  describe('syncSessionFromCloud — cloudUpdatedAt propagation', () => {
    async function initCloudRouter(): Promise<CloudRouter> {
      mockGet.mockResolvedValue([]);
      const r = new CloudRouter();
      r.init(createConfig(createCloudSettings()));
      mockHealthCheck.mockResolvedValue(true);
      await r.updateConnection('https://rebel-test.fly.dev', 'placeholder');
      await new Promise((resolve) => setTimeout(resolve, 0));
      mockGet.mockClear();
      mockOutboxRecordCloudUpdatedAt.mockClear();
      return r;
    }

    it('propagates cloudUpdatedAt to outbox tracker when skipping upsert (local newer)', async () => {
      const r = await initCloudRouter();

      mockGetSession.mockResolvedValue({ id: 'sess-prop-1', updatedAt: 5000 });
      mockGet.mockResolvedValue({ id: 'sess-prop-1', updatedAt: 3000, cloudUpdatedAt: 4500 });

      await r.syncSessionFromCloud('sess-prop-1');

      expect(mockUpsertSession).not.toHaveBeenCalled();
      expect(mockUpsertSessionWithOutcome).not.toHaveBeenCalled();
      expect(mockOutboxRecordCloudUpdatedAt).toHaveBeenCalledWith('sess-prop-1', 4500);
      r.disconnect();
    });

    it('propagates cloudUpdatedAt to outbox tracker on full upsert (no local session)', async () => {
      const r = await initCloudRouter();

      mockGetSession.mockResolvedValue(null);
      mockGet.mockResolvedValue({ id: 'sess-prop-2', updatedAt: 2000, cloudUpdatedAt: 3000 });

      await r.syncSessionFromCloud('sess-prop-2');

      expect(mockUpsertSessionWithOutcome).toHaveBeenCalled();
      expect(mockOutboxRecordCloudUpdatedAt).toHaveBeenCalledWith('sess-prop-2', 3000);
      r.disconnect();
    });

    it('does not propagate when cloud session has no cloudUpdatedAt', async () => {
      const r = await initCloudRouter();

      mockGetSession.mockResolvedValue({ id: 'sess-prop-3', updatedAt: 5000 });
      mockGet.mockResolvedValue({ id: 'sess-prop-3', updatedAt: 3000 });

      await r.syncSessionFromCloud('sess-prop-3');

      expect(mockOutboxRecordCloudUpdatedAt).not.toHaveBeenCalled();
      r.disconnect();
    });
  });

  // =========================================================================
  // pushSessionsToCloud — outbox delete guard
  // =========================================================================

  describe('pushSessionsToCloud', () => {
    let r: CloudRouter;

    beforeEach(async () => {
      r = new CloudRouter();
      r.init(createConfig(createCloudSettings()));
      // Simulate successful connection so getOrCreateClient returns a client
      mockHealthCheck.mockResolvedValue(true);
      mockGet.mockResolvedValue([]);
      mockPost.mockResolvedValue({ ok: true });
      mockPut.mockResolvedValue({ ok: true });
      await r.updateConnection('https://rebel-test.fly.dev', 'placeholder');
      await new Promise((resolve) => setTimeout(resolve, 0));
      // Clear background-call noise from updateConnection's fire-and-forget syncs.
      mockGet.mockClear();
      mockPut.mockClear();
      mockGet.mockResolvedValue([]);
    });

    afterEach(() => {
      r.disconnect();
    });

    it('pushes all cloud_active sessions regardless of outbox state (GC is state-map-driven)', async () => {
      const { getAllContinuityStates } = await import('../cloudContinuityMetadata');
      (getAllContinuityStates as ReturnType<typeof vi.fn>).mockReturnValue({
        'sess-keep': { state: 'cloud_active' },
        'sess-also-active': { state: 'cloud_active' },
      });

      // Cloud returns no summaries (both sessions "missing")
      mockGet.mockResolvedValueOnce([]);

      // Local store has both sessions
      mockListSessions.mockReturnValue([
        { id: 'sess-keep', updatedAt: 100 },
        { id: 'sess-also-active', updatedAt: 100 },
      ]);
      mockGetSession
        .mockResolvedValueOnce({ id: 'sess-keep', updatedAt: 100 })
        .mockResolvedValueOnce({ id: 'sess-also-active', updatedAt: 100 });

      await r.pushSessionsToCloud();

      // Both cloud_active sessions should be pushed — no outbox-based filtering
      const putCalls = mockPut.mock.calls.filter(
        (c: unknown[]) => typeof c[0] === 'string' && (c[0] as string).includes('/api/sessions/'),
      );
      expect(putCalls).toHaveLength(2);
    });

    it('pushes all cloud_active sessions when outbox has no deletes', async () => {
      const { getAllContinuityStates } = await import('../cloudContinuityMetadata');
      (getAllContinuityStates as ReturnType<typeof vi.fn>).mockReturnValue({
        'sess-a': { state: 'cloud_active' },
        'sess-b': { state: 'cloud_active' },
      });

      mockOutboxGetAll.mockReturnValue([]);

      // Cloud returns no summaries (both sessions "missing")
      mockGet.mockResolvedValueOnce([]);

      mockListSessions.mockReturnValue([
        { id: 'sess-a', updatedAt: 100 },
        { id: 'sess-b', updatedAt: 100 },
      ]);
      mockGetSession
        .mockResolvedValueOnce({ id: 'sess-a', updatedAt: 100 })
        .mockResolvedValueOnce({ id: 'sess-b', updatedAt: 100 });

      await r.pushSessionsToCloud();

      const putCalls = mockPut.mock.calls.filter(
        (c: unknown[]) => typeof c[0] === 'string' && (c[0] as string).includes('/api/sessions/'),
      );
      expect(putCalls).toHaveLength(2);
    });

    it('pushes cloud_active sessions even when outbox has failed entries (GC is state-map-driven)', async () => {
      const { getAllContinuityStates } = await import('../cloudContinuityMetadata');
      (getAllContinuityStates as ReturnType<typeof vi.fn>).mockReturnValue({
        'sess-ok': { state: 'cloud_active' },
        'sess-also-ok': { state: 'cloud_active' },
      });

      mockGet.mockResolvedValueOnce([]);
      mockListSessions.mockReturnValue([
        { id: 'sess-ok', updatedAt: 100 },
        { id: 'sess-also-ok', updatedAt: 100 },
      ]);
      mockGetSession
        .mockResolvedValueOnce({ id: 'sess-ok', updatedAt: 100 })
        .mockResolvedValueOnce({ id: 'sess-also-ok', updatedAt: 100 });

      await r.pushSessionsToCloud();

      const putCalls = mockPut.mock.calls.filter(
        (c: unknown[]) => typeof c[0] === 'string' && (c[0] as string).includes('/api/sessions/'),
      );
      expect(putCalls).toHaveLength(2);
    });

    it('does not skip sessions with pending outbox upserts', async () => {
      const { getAllContinuityStates } = await import('../cloudContinuityMetadata');
      (getAllContinuityStates as ReturnType<typeof vi.fn>).mockReturnValue({
        'sess-upsert': { state: 'cloud_active' },
      });

      mockOutboxGetAll.mockReturnValue([
        { sessionId: 'sess-upsert', op: 'upsert', status: 'pending' },
      ]);

      mockGet.mockResolvedValueOnce([]);
      mockListSessions.mockReturnValue([
        { id: 'sess-upsert', updatedAt: 100 },
      ]);
      mockGetSession.mockResolvedValue({ id: 'sess-upsert', updatedAt: 100 });

      await r.pushSessionsToCloud();

      const putCalls = mockPut.mock.calls.filter(
        (c: unknown[]) => typeof c[0] === 'string' && (c[0] as string).includes('/api/sessions/'),
      );
      expect(putCalls).toHaveLength(1);
    });

    it('unwraps { sessions, totalCount } response and skips up-to-date sessions', async () => {
      const { getAllContinuityStates } = await import('../cloudContinuityMetadata');
      (getAllContinuityStates as ReturnType<typeof vi.fn>).mockReturnValue({
        'sess-current': { state: 'cloud_active' },
      });

      // Cloud returns wrapped format with session already up-to-date
      mockGet.mockResolvedValueOnce({
        sessions: [{ id: 'sess-current', updatedAt: 200 }],
        totalCount: 1,
      });

      mockListSessions.mockReturnValue([
        { id: 'sess-current', updatedAt: 200 },
      ]);

      await r.pushSessionsToCloud();

      // Session is already up-to-date on cloud — should NOT push
      const putCalls = mockPut.mock.calls.filter(
        (c: unknown[]) => typeof c[0] === 'string' && (c[0] as string).includes('/api/sessions/'),
      );
      expect(putCalls).toHaveLength(0);
    });
  });

  // =========================================================================
  // drainOutbox — tombstone suppression
  // =========================================================================

  describe('drainOutbox tombstone suppression', () => {
    it('records a partial-failure drain outcome as cooldown failure', async () => {
      const r = new CloudRouter();
      r.init(createConfig(createCloudSettings()));
      mockOutboxDrain.mockResolvedValueOnce({ ok: 1, failed: 1, authFailures: 0, sampleError: new Error('network error') });

      await r.drainOutbox();

      expect(cloudFailureCooldown._getState().consecutiveFailures).toBe(1);
      expect(cloudFailureCooldown.getDegradedSince()).not.toBeNull();
      r.disconnect();
    });

    it('suppresses tombstoned upserts before draining', async () => {
      const r = new CloudRouter();
      r.init(createConfig(createCloudSettings()));

      mockGet.mockImplementation(async (path: string) => {
        if (path.startsWith('/api/sessions/tombstones')) {
          return {
            tombstones: [
              {
                sessionId: 'sess-tombstoned',
                deletedAt: 123,
                deletedBy: 'mobile',
                ttlExpiresAt: Date.now() + 60_000,
              },
            ],
          };
        }
        return [];
      });

      mockOutboxSuppressTombstonedUpserts.mockImplementation((predicate: (sessionId: string) => boolean) => {
        return predicate('sess-tombstoned') ? ['sess-tombstoned'] : [];
      });

      await r.drainOutbox();

      expect(mockOutboxSuppressTombstonedUpserts).toHaveBeenCalledTimes(1);
      expect(mockOutboxDrain).toHaveBeenCalledTimes(1);
      r.disconnect();
    });

    it('uses serverNow cursor on first empty tombstone sync response', async () => {
      const r = new CloudRouter();
      r.init(createConfig(createCloudSettings()));

      const serverNow = 987_654_321;
      mockGet.mockImplementation(async (path: string) => {
        if (path.startsWith('/api/sessions/tombstones')) {
          return { tombstones: [], serverNow };
        }
        return [];
      });

      await r.drainOutbox();

      expect(mockLastSessionTombstoneSyncAt).toBe(serverNow);
      expect(r.getTombstoneStats().lastSuccessfulSyncAt).toEqual(expect.any(Number));
      expect(mockOutboxDrain).toHaveBeenCalledTimes(1);
      r.disconnect();
    });
  });

  describe('refreshSessionTombstones error handling', () => {
    it('keeps 429 tombstone sync failures debug-only and continues draining', async () => {
      const r = new CloudRouter();
      r.init(createConfig(createCloudSettings()));

      mockGet.mockRejectedValue(new CloudServiceError('Too Many Requests', 'RATE_LIMITED', 429));

      await expect(r.drainOutbox()).resolves.toBeUndefined();

      // Narrow the matcher: assert specifically that no tombstone-related warns fired,
      // rather than no warns anywhere (which would be fragile to unrelated module logs).
      const tombstoneWarns = loggerMock.warn.mock.calls.filter((call) => {
        const msg = typeof call[1] === 'string' ? call[1] : '';
        return msg.includes('tombstone');
      });
      expect(tombstoneWarns).toHaveLength(0);
      expect(loggerMock.debug).toHaveBeenCalledWith(
        'Session tombstone sync rate-limited; continuing with cached tombstones',
      );
      expect(r.getTombstoneStats()).toMatchObject({
        tombstoneMissingCount: 0,
        tombstoneRateLimitedCount: 1,
        lastSuccessfulSyncAt: null,
      });
      expect(mockOutboxDrain).toHaveBeenCalledTimes(1);
      r.disconnect();
    });

    it('warns once on the first tombstone 404 and continues draining', async () => {
      const r = new CloudRouter();
      r.init(createConfig(createCloudSettings()));

      mockGet.mockRejectedValue(new CloudServiceError('Not Found', 'NOT_FOUND', 404));

      await expect(r.drainOutbox()).resolves.toBeUndefined();

      const endpoint404Warns = loggerMock.warn.mock.calls.filter(
        (call) => call[1] === 'Session tombstone endpoint returned 404 — continuing with cached tombstones (suppressing further occurrences this session)',
      );

      expect(endpoint404Warns).toHaveLength(1);
      expect(endpoint404Warns[0]?.[0]).toMatchObject({
        statusCode: 404,
        path: expect.stringContaining('/api/sessions/tombstones'),
      });
      expect(mockOutboxDrain).toHaveBeenCalledTimes(1);
      r.disconnect();
    });

    it('does not warn again on repeated tombstone 404 responses in the same session', async () => {
      const r = new CloudRouter();
      r.init(createConfig(createCloudSettings()));

      mockGet.mockRejectedValue(new CloudServiceError('Not Found', 'NOT_FOUND', 404));

      await expect(r.drainOutbox()).resolves.toBeUndefined();
      await expect(r.drainOutbox()).resolves.toBeUndefined();

      const endpoint404Warns = loggerMock.warn.mock.calls.filter(
        (call) => call[1] === 'Session tombstone endpoint returned 404 — continuing with cached tombstones (suppressing further occurrences this session)',
      );

      const repeat404Debugs = loggerMock.debug.mock.calls.filter(
        (call) => call[1] === 'Session tombstone endpoint 404 (repeat)',
      );

      expect(endpoint404Warns).toHaveLength(1);
      expect(repeat404Debugs).toHaveLength(1);
      expect(repeat404Debugs[0]?.[0]).toMatchObject({ statusCode: 404 });
      expect(mockOutboxDrain).toHaveBeenCalledTimes(2);
      r.disconnect();
    });

    it('recovers cleanly when a tombstone 404 is followed by a successful sync', async () => {
      const r = new CloudRouter();
      r.init(createConfig(createCloudSettings()));

      const tombstones = [
        {
          sessionId: 'sess-recovered',
          deletedAt: 1_234,
          deletedBy: 'mobile' as const,
          ttlExpiresAt: Date.now() + 60_000,
        },
      ];
      const serverNow = 9_876_543;
      const refreshSessionTombstones = (
        r as unknown as {
          refreshSessionTombstones: (client: { get: typeof mockGet }) => Promise<typeof tombstones>;
        }
      ).refreshSessionTombstones.bind(r);

      mockGet
        .mockRejectedValueOnce(new CloudServiceError('Not Found', 'NOT_FOUND', 404))
        .mockResolvedValueOnce({ tombstones, serverNow });

      await expect(refreshSessionTombstones({ get: mockGet })).resolves.toEqual([]);
      expect(r.getTombstoneStats().lastSuccessfulSyncAt).toBeNull();
      await expect(refreshSessionTombstones({ get: mockGet })).resolves.toEqual(tombstones);

      const endpoint404Warns = loggerMock.warn.mock.calls.filter(
        (call) => call[1] === 'Session tombstone endpoint returned 404 — continuing with cached tombstones (suppressing further occurrences this session)',
      );

      expect(endpoint404Warns).toHaveLength(1);
      expect(mockLastSessionTombstoneSyncAt).toBe(serverNow);
      expect(r.getTombstoneStats().lastSuccessfulSyncAt).toEqual(expect.any(Number));
      r.disconnect();
    });

    it('increments tombstoneMissingCount for each sequential 404 response', async () => {
      const r = new CloudRouter();
      r.init(createConfig(createCloudSettings()));

      const refreshSessionTombstones = (
        r as unknown as {
          refreshSessionTombstones: (client: { get: typeof mockGet }) => Promise<unknown[]>;
        }
      ).refreshSessionTombstones.bind(r);

      mockGet.mockRejectedValue(new CloudServiceError('Not Found', 'NOT_FOUND', 404));

      await expect(refreshSessionTombstones({ get: mockGet })).resolves.toEqual([]);
      await expect(refreshSessionTombstones({ get: mockGet })).resolves.toEqual([]);

      expect(r.getTombstoneStats()).toMatchObject({
        tombstoneMissingCount: 2,
        tombstoneRateLimitedCount: 0,
        lastSuccessfulSyncAt: null,
      });
      r.disconnect();
    });

    it('rethrows non-404/429 tombstone errors to the drainOutbox safety-net catch', async () => {
      const r = new CloudRouter();
      r.init(createConfig(createCloudSettings()));

      mockGet.mockRejectedValue(new CloudServiceError('Server Error', 'SERVER_ERROR', 500));

      await expect(r.drainOutbox()).resolves.toBeUndefined();

      expect(loggerMock.warn).toHaveBeenCalledWith(
        expect.objectContaining({
          err: expect.objectContaining({
            code: 'SERVER_ERROR',
            statusCode: 500,
          }),
        }),
        'Failed to refresh/suppress tombstones before outbox drain',
      );
      expect(mockOutboxDrain).toHaveBeenCalledTimes(1);
      r.disconnect();
    });
  });

  // =========================================================================
  // onLocalSessionDeleted — cloud tombstone propagation
  // =========================================================================

  describe('onLocalSessionDeleted', () => {
    it('enqueues a delete op and drains outbox for cloud-known sessions', async () => {
      const r = new CloudRouter();
      r.init(createConfig(createCloudSettings()));

      const { removeContinuityMetadata } = await import('../cloudContinuityMetadata');
      const { removeCloudSyncMetadata } = await import('../cloudSyncMetadata');
      mockGetContinuityEntry.mockReturnValue({
        state: 'cloud_active',
        lastCloudActivityAt: Date.now(),
      });

      await r.onLocalSessionDeleted('sess-delete');
      await new Promise((resolve) => setTimeout(resolve, 20));

      expect(mockOutboxEnqueue).toHaveBeenCalledWith('sess-delete', 'delete', { durable: true });
      expect(mockOutboxDrain).toHaveBeenCalled();
      expect(removeCloudSyncMetadata).toHaveBeenCalledWith('sess-delete');
      expect(removeContinuityMetadata).toHaveBeenCalledWith('sess-delete');
      r.disconnect();
    });

    it('does nothing for sessions with no cloud continuity metadata', async () => {
      const r = new CloudRouter();
      r.init(createConfig(createCloudSettings()));

      mockGetContinuityEntry.mockReturnValue(null);

      await r.onLocalSessionDeleted('sess-local-only');

      expect(mockOutboxEnqueue).not.toHaveBeenCalledWith('sess-local-only', 'delete', { durable: true });
      expect(mockOutboxDrain).not.toHaveBeenCalled();
      r.disconnect();
    });

    it('forces tombstone enqueue for cleanup-origin deletes even without continuity metadata', async () => {
      const r = new CloudRouter();
      r.init(createConfig(createCloudSettings()));
      mockGetContinuityEntry.mockReturnValue(null);
      const addBreadcrumbSpy = vi.spyOn(getErrorReporter(), 'addBreadcrumb');

      await r.onLocalSessionDeleted('sess-cleanup', { source: 'cleanupLeakedSessions' });

      expect(mockOutboxEnqueue).toHaveBeenCalledWith('sess-cleanup', 'delete', { durable: true });
      expect(addBreadcrumbSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          category: 'cleanup-tombstone-enqueued',
          data: expect.objectContaining({
            sessionIdHash: expect.any(String),
          }),
        }),
      );
      r.disconnect();
    });
  });

  // =========================================================================
  // onLocalSessionsSaved — sync flush on demotion
  // =========================================================================

  describe('onLocalSessionsSaved — demotion flush', () => {
    it('classifies done-without-prior-cloud-pin demotion intent as inferred', async () => {
      const r = new CloudRouter();
      r.init(createConfig(createCloudSettings()));

      const { isCloudActive } = await import('../cloudContinuityMetadata');
      (isCloudActive as ReturnType<typeof vi.fn>).mockReturnValue(true);
      mockGetContinuityEntry.mockReturnValue({
        state: 'cloud_active',
      });

      // Done session (doneAt set) demotes; no prior cloudPinnedAt → 'inferred'.
      r.onLocalSessionsSaved([{ id: 'sess-inferred', doneAt: Date.now(), messages: [{ id: 'm1' }] } as unknown as { id: string }]);

      await new Promise((resolve) => setTimeout(resolve, 50));

      expect(mockMarkLocalOnly).toHaveBeenCalledWith('sess-inferred', 'cloud-disabled', 'inferred');
      r.disconnect();
    });

    it('classifies explicit mark-done demotion intent as user when prior cloud-pin exists', async () => {
      const r = new CloudRouter();
      r.init(createConfig(createCloudSettings()));

      const { isCloudActive } = await import('../cloudContinuityMetadata');
      (isCloudActive as ReturnType<typeof vi.fn>).mockReturnValue(true);
      mockGetContinuityEntry.mockReturnValue({
        state: 'cloud_active',
        cloudPinnedAt: Date.now() - 1_000,
      });

      // Done session (doneAt set) + prior cloudPinnedAt → explicit user mark-done.
      r.onLocalSessionsSaved([{ id: 'sess-user-unpin', doneAt: Date.now(), messages: [{ id: 'm1' }] } as unknown as { id: string }]);

      await new Promise((resolve) => setTimeout(resolve, 50));

      expect(mockMarkLocalOnly).toHaveBeenCalledWith('sess-user-unpin', 'cloud-disabled', 'user');
      r.disconnect();
    });

    it('flushes continuity metadata when sessions are demoted (no outbox delete — GC is state-map-driven)', async () => {
      const r = new CloudRouter();
      r.init(createConfig(createCloudSettings()));

      const { isCloudActive } = await import('../cloudContinuityMetadata');
      // Session is currently cloud_active but now marked Done (doneAt set)
      (isCloudActive as ReturnType<typeof vi.fn>).mockReturnValue(true);

      r.onLocalSessionsSaved([{ id: 'sess-demote', doneAt: Date.now() } as unknown as { id: string }]);

      // Give the async IIFE time to execute
      await new Promise((r) => setTimeout(r, 50));

      expect(mockFlushContinuityMetadata).toHaveBeenCalled();
      // No outbox delete — cloud GC is driven by the state map push
      expect(mockOutboxEnqueue).not.toHaveBeenCalledWith('sess-demote', 'delete', { durable: true });
      r.disconnect();
    });

    it('does not flush when no sessions are demoted', async () => {
      const r = new CloudRouter();
      r.init(createConfig(createCloudSettings()));

      const { isCloudActive } = await import('../cloudContinuityMetadata');
      // No sessions are cloud_active, so no demotions
      (isCloudActive as ReturnType<typeof vi.fn>).mockReturnValue(false);

      r.onLocalSessionsSaved([{ id: 'sess-local', doneAt: null } as unknown as { id: string }]);

      await new Promise((r) => setTimeout(r, 50));

      expect(mockFlushContinuityMetadata).not.toHaveBeenCalled();
      r.disconnect();
    });

    it('promotes pinned sessions to cloud_active (no outbox delete guard — GC is state-map-driven)', async () => {
      const r = new CloudRouter();
      r.init(createConfig(createCloudSettings()));

      const { isCloudActive } = await import('../cloudContinuityMetadata');
      (isCloudActive as ReturnType<typeof vi.fn>).mockReturnValue(false);

      // Star toggle reopens the session (doneAt null = Active), triggering onLocalSessionsSaved
      r.onLocalSessionsSaved([
        { id: 'sess-star', doneAt: null } as unknown as { id: string },
      ]);

      await new Promise((r) => setTimeout(r, 50));

      // With state-map-driven GC, pinned sessions are promoted (no pendingDeleteIds guard)
      expect(mockMarkCloudActive).toHaveBeenCalledWith('sess-star');
      expect(mockOutboxEnqueue).toHaveBeenCalledWith('sess-star', 'upsert');
      r.disconnect();
    });
  });

  // =========================================================================
  // Layer C — self-echo dedup for cloud session-changed events
  // (260427_sidebar_concurrent_swap_groundup_fix.md)
  // =========================================================================

  describe('cloud session-changed self-echo dedup', () => {
    // Local broadcast spy. Installed via the boundary interface
    // (`setBroadcastService`) rather than vi.mock because vitest's setupFile
    // imports the real module before any per-file vi.mock would take effect,
    // and the production handler ends up using the real boundary state.
    let broadcastSpy: ReturnType<typeof vi.fn>;

    beforeEach(async () => {
      const { setBroadcastService } = await import('@core/broadcastService');
      broadcastSpy = vi.fn();
      setBroadcastService({
        sendToAllWindows: broadcastSpy as unknown as (channel: string, ...args: unknown[]) => void,
        sendToFocusedWindow: vi.fn() as unknown as (channel: string, ...args: unknown[]) => void,
      });
    });

    /**
     * Capture the `onSessionChanged` handler that cloudRouter registers during
     * `updateConnection`, so we can invoke it directly with a synthetic event
     * and assert on broadcast suppression behavior.
     */
    async function initRouterAndCaptureHandler(): Promise<{
      router: CloudRouter;
      handler: (event: { action: 'upserted' | 'deleted'; sessionId: string }) => Promise<void>;
    }> {
      mockGet.mockResolvedValue([]);
      mockListSessions.mockReturnValue([]);
      cloudEventChannelMock.onSessionChanged.mockClear();

      const router = new CloudRouter();
      router.init(createConfig(createCloudSettings()));
      mockHealthCheck.mockResolvedValue(true);

      const pullSpy = vi.spyOn(router, 'pullChangedSessions');
      await router.updateConnection('https://rebel-test.fly.dev', 'placeholder');
      for (const result of pullSpy.mock.results) {
        if (result.type === 'return') await (result.value as Promise<void>).catch(() => {});
      }
      pullSpy.mockRestore();
      await new Promise((resolve) => setTimeout(resolve, 0));

      // Reset mocks AFTER initial pull settles so each test starts clean.
      mockGet.mockReset();
      mockGet.mockResolvedValue(null);
      mockGetSession.mockReset();
      mockUpsertSession.mockClear();
      mockUpsertSessionWithOutcome.mockClear();
      broadcastSpy.mockClear();
      mockOutboxEnqueue.mockClear();

      const handler = cloudEventChannelMock.onSessionChanged.mock.calls.at(-1)?.[0] as
        | ((event: { action: 'upserted' | 'deleted'; sessionId: string }) => Promise<void>)
        | undefined;
      if (!handler) {
        throw new Error('onSessionChanged handler was not registered');
      }
      return { router, handler };
    }

    it('suppresses self-echo broadcast within TTL when no local update', async () => {
      const { router, handler } = await initRouterAndCaptureHandler();

      // Simulate a local save that pushes to cloud (marks recently-pushed).
      router.onLocalSessionsSaved([
        { id: 'sess-echo', doneAt: null } as unknown as { id: string },
      ]);

      // Cloud echo arrives: cloud's session matches local exactly so
      // syncSessionFromCloud's skipUpsert path runs — updatedLocal: false.
      mockGetSession.mockResolvedValue({ id: 'sess-echo', updatedAt: 5000 });
      mockGet.mockResolvedValue({ id: 'sess-echo', updatedAt: 5000 });

      await handler({ action: 'upserted', sessionId: 'sess-echo' });

      const broadcastCalls = broadcastSpy.mock.calls.filter(
        ([channel]) => channel === 'cloud:sessions-synced',
      );
      expect(broadcastCalls).toHaveLength(0);
      router.disconnect();
    });

    it('still broadcasts within TTL when cloud carried a real update (cross-device update during our TTL)', async () => {
      const { router, handler } = await initRouterAndCaptureHandler();

      router.onLocalSessionsSaved([
        { id: 'sess-real-update', doneAt: null } as unknown as { id: string },
      ]);

      // Cloud echo arrives within TTL but cloud's version is newer than local's:
      // syncSessionFromCloud takes the "no local-only turns -> accept cloud"
      // path, runs upsertSession, returns updatedLocal: true.
      mockGetSession.mockResolvedValue({ id: 'sess-real-update', updatedAt: 1000 });
      mockGet.mockResolvedValue({ id: 'sess-real-update', updatedAt: 5000 });

      await handler({ action: 'upserted', sessionId: 'sess-real-update' });

      const broadcastCalls = broadcastSpy.mock.calls.filter(
        ([channel]) => channel === 'cloud:sessions-synced',
      );
      expect(broadcastCalls).toHaveLength(1);
      expect(broadcastCalls[0][1]).toEqual({
        upserted: ['sess-real-update'],
        deleted: [],
      });
      router.disconnect();
    });

    it('broadcasts non-self / cross-device updates that were never pushed by us', async () => {
      const { router, handler } = await initRouterAndCaptureHandler();

      // No prior call to onLocalSessionsSaved for this session — so it is NOT
      // in the recently-pushed set. Even with updatedLocal: false, we still
      // broadcast (because suppression requires both conditions).
      mockGetSession.mockResolvedValue({ id: 'sess-foreign', updatedAt: 5000 });
      mockGet.mockResolvedValue({ id: 'sess-foreign', updatedAt: 5000 });

      await handler({ action: 'upserted', sessionId: 'sess-foreign' });

      const broadcastCalls = broadcastSpy.mock.calls.filter(
        ([channel]) => channel === 'cloud:sessions-synced',
      );
      expect(broadcastCalls).toHaveLength(1);
      expect(broadcastCalls[0][1]).toEqual({
        upserted: ['sess-foreign'],
        deleted: [],
      });
      router.disconnect();
    });

    it('TTL expiry: stale recently-pushed marks no longer suppress the broadcast', async () => {
      const { router, handler } = await initRouterAndCaptureHandler();

      // Push so 'sess-ttl' is initially marked recently-pushed.
      router.onLocalSessionsSaved([
        { id: 'sess-ttl', doneAt: null } as unknown as { id: string },
      ]);

      // Simulate TTL expiry by reaching into the private map and rewriting the
      // mark's timestamp to a value older than SELF_ECHO_TTL_MS. Avoids fake
      // timers (which would interfere with the awaits used inside init).
      const internal = router as unknown as {
        recentlyPushedSessions: Map<string, number>;
      };
      expect(internal.recentlyPushedSessions.has('sess-ttl')).toBe(true);
      internal.recentlyPushedSessions.set('sess-ttl', Date.now() - 6_000);

      // Cloud echo arrives now (same content, no local update).
      mockGetSession.mockResolvedValue({ id: 'sess-ttl', updatedAt: 5000 });
      mockGet.mockResolvedValue({ id: 'sess-ttl', updatedAt: 5000 });

      await handler({ action: 'upserted', sessionId: 'sess-ttl' });

      const broadcastCalls = broadcastSpy.mock.calls.filter(
        ([channel]) => channel === 'cloud:sessions-synced',
      );
      // Mark is stale → suppression no longer applies → broadcast fires.
      expect(broadcastCalls).toHaveLength(1);
      router.disconnect();
    });

    it('pull-sync broadcast path remains unaffected — distinct from WS-event suppression', async () => {
      // The pull-sync code path (`executePullSync` ~ cloudRouter.ts:1370) emits
      // its own `cloud:sessions-synced` broadcast independently of the WS event
      // handler's. Self-echo suppression is scoped to the WS handler only, so
      // the pull-sync broadcast must always fire even when sessions are in the
      // recently-pushed set.
      const { router } = await initRouterAndCaptureHandler();

      // Mark a session as recently-pushed (would suppress on the WS path).
      router.onLocalSessionsSaved([
        { id: 'sess-pull', doneAt: null } as unknown as { id: string },
      ]);
      // Let the async IIFE in onLocalSessionsSaved settle.
      await new Promise((resolve) => setTimeout(resolve, 0));

      // Set up an empty pull (no cloud changes, no tombstones) so we exercise
      // executePullSync's broadcast call without other side effects.
      mockGet.mockReset();
      mockGet.mockImplementation(async (path: string) => {
        if (path.startsWith('/api/sessions?summaries=true')) {
          return [];
        }
        if (path.startsWith('/api/sessions/tombstones')) {
          return { tombstones: [], serverNow: Date.now() };
        }
        return [];
      });
      mockListSessions.mockReturnValue([]);
      broadcastSpy.mockClear();

      await router.pullChangedSessions();

      const broadcastCalls = broadcastSpy.mock.calls.filter(
        ([channel]) => channel === 'cloud:sessions-synced',
      );
      // Pull-sync must broadcast regardless of recently-pushed marks.
      expect(broadcastCalls).toHaveLength(1);
      expect(broadcastCalls[0][1]).toEqual({
        upserted: [],
        deleted: [],
      });
      router.disconnect();
    });
  });
});
