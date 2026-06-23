// RED until Stage 5 (cloudRouter first-sync folders restore + A1 renderer signal).
//
// Bug Mode red→green: on a fresh-machine first-connect pull, folders.json is
// reconstructed NOWHERE and the renderer is signalled NOWHERE (PLAN.md Root
// Cause + Amendment A1). This test drives the pull path and asserts:
//   (i)  the local FolderStore is written (folders.json reconstructed on disk
//        via `getFolderStore().save()`), AND
//   (ii) a `cloud:folders-restored` IPC broadcast is emitted so the renderer
//        Zustand store can re-load (A1 — priming main-process disk alone leaves
//        the sidebar empty until restart).
// Neither exists today, so both assertions fail for the RIGHT reason.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppSettings } from '@shared/types';
import type { FolderStoreData } from '@shared/ipc/schemas/folders';

// ---------------------------------------------------------------------------
// Mocks (subset of cloudRouter.test.ts — just what the pull path touches)
// ---------------------------------------------------------------------------

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
  cloudEventChannel: { ...cloudEventChannelMock, get isConnected() { return false; } },
}));

const loggerMock = vi.hoisted(() => ({
  info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn(),
}));
vi.mock('@core/logger', () => ({
  createScopedLogger: vi.fn(() => loggerMock),
  logger: loggerMock,
}));

// Capture folder-store writes (folders.json reconstruction on disk).
const mockFolderSave = vi.hoisted(() => vi.fn(async (_data: unknown) => {}));
const mockFolderSaveSync = vi.hoisted(() => vi.fn((_data: unknown) => {}));
const mockFolderLoad = vi.hoisted(() =>
  vi.fn<() => FolderStoreData>(() => ({ version: 1, folders: [], membership: {} })),
);
vi.mock('@core/services/folderStore', () => ({
  getFolderStore: () => ({
    load: mockFolderLoad,
    save: mockFolderSave,
    saveSync: mockFolderSaveSync,
  }),
}));

const mockGetSession = vi.fn().mockResolvedValue(null);
const mockListSessions = vi.fn().mockReturnValue([]);
const mockGetSessionIds = vi.fn().mockReturnValue([]);
const mockUpsertSession = vi.fn().mockResolvedValue(undefined);
const mockDeleteSession = vi.fn().mockResolvedValue(undefined);
vi.mock('../../incrementalSessionStore', () => ({
  getIncrementalSessionStore: () => ({
    getSession: mockGetSession,
    listSessions: mockListSessions,
    getSessionIds: mockGetSessionIds,
    upsertSession: mockUpsertSession,
    deleteSession: mockDeleteSession,
  }),
}));

vi.mock('../../conversationIndexService', () => ({
  onSessionsSaved: vi.fn().mockResolvedValue(undefined),
}));

const mockMarkCloudSynced = vi.fn();
vi.mock('../cloudSyncMetadata', () => ({
  markCloudSynced: mockMarkCloudSynced,
  isCloudSynced: vi.fn(() => false),
  removeCloudSyncMetadata: vi.fn(),
  loadCloudSyncMetadata: vi.fn(),
  flushCloudSyncMetadata: vi.fn(),
}));

const mockOutboxGetPendingDeleteSessionIds = vi.fn().mockReturnValue(new Set<string>());
vi.mock('../cloudOutbox', () => ({
  pushFullSessionWithCapabilityGate: vi.fn(),
  cloudOutbox: {
    getAll: vi.fn(() => []),
    enqueue: vi.fn(),
    load: vi.fn(),
    onConnectionChanged: vi.fn(),
    drain: vi.fn().mockResolvedValue({ ok: 0, failed: 0, authFailures: 0 }),
    flush: vi.fn(),
    getStatus: vi.fn(() => ({ pending: 0, failed: 0 })),
    suppressTombstonedUpserts: vi.fn(() => []),
    recordCloudUpdatedAt: vi.fn(),
    recordLastPushedSeq: vi.fn(),
    getLastPushedSeq: vi.fn(() => undefined),
    hasPendingDelete: vi.fn(() => false),
    getPendingDeleteSessionIds: (...args: unknown[]) => mockOutboxGetPendingDeleteSessionIds(...args),
  },
}));

vi.mock('../cloudContinuityMetadata', () => ({
  isCloudActive: vi.fn(() => false),
  getContinuityEntry: vi.fn(() => null),
  markCloudActive: vi.fn(),
  markLocalOnly: vi.fn(),
  touchCloudActivity: vi.fn(),
  removeContinuityMetadata: vi.fn(),
  restoreContinuityEntrySnapshot: vi.fn(),
  loadContinuityMetadata: vi.fn(),
  getAllContinuityStates: vi.fn(() => ({})),
  getStaleCloudSessions: vi.fn(() => []),
  getLastSessionTombstoneSyncAt: vi.fn(() => null),
  setLastSessionTombstoneSyncAt: vi.fn(),
  flushContinuityMetadata: vi.fn().mockResolvedValue({ success: true }),
}));

// ---------------------------------------------------------------------------
// Import after mocks
// ---------------------------------------------------------------------------

import { CloudRouter, type CloudRouterConfig } from '../cloudRouter';
import { cloudFailureCooldown } from '../cloudFailureCooldown';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createCloudSettings(): AppSettings {
  return {
    coreDirectory: '/data/workspace',
    mcpConfigFile: null,
    onboardingCompleted: true,
    userEmail: null,
    onboardingFirstCompletedAt: null,
    voice: {} as AppSettings['voice'],
    claude: {} as AppSettings['claude'],
    diagnostics: {} as AppSettings['diagnostics'],
    cloudInstance: { mode: 'cloud', cloudUrl: 'https://rebel-test.fly.dev', cloudToken: 'placeholder' },
  } as AppSettings;
}

function createConfig(settings: AppSettings): CloudRouterConfig {
  return { getSettings: () => settings };
}

// Cloud doc the fresh machine should restore: 1 folder incl. an EMPTY folder,
// and 1 membership for a session that arrives in the same pull.
const CLOUD_FOLDERS: FolderStoreData = {
  version: 1,
  folders: [
    { id: 'fldr_house', name: 'house', createdAt: 1000, updatedAt: 2000 },
    { id: 'fldr_empty', name: 'Empty', createdAt: 1700, updatedAt: 1700 },
  ],
  membership: { 'cloud-session-1': 'fldr_house' },
};

/** Stub HTTP client: serves session summaries, the session, and the folders doc. */
function makeStubClient() {
  const get = vi.fn(async (path: string) => {
    if (path.startsWith('/api/sessions?summaries=true')) {
      return { sessions: [{ id: 'cloud-session-1', updatedAt: 2000 }], totalCount: 1 };
    }
    if (path === '/api/sessions/folders') {
      return CLOUD_FOLDERS;
    }
    if (path.startsWith('/api/sessions/cloud-session-1')) {
      return { id: 'cloud-session-1', updatedAt: 2000, messages: [], eventsByTurn: {} };
    }
    if (path.startsWith('/api/sessions/tombstones')) {
      return { tombstones: [], serverNow: Date.now() };
    }
    return null;
  });
  return { get, put: vi.fn(), post: vi.fn(), patch: vi.fn(), delete: vi.fn(), disconnect: vi.fn() };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('CloudRouter — folders restore on first-sync pull (RED until Stage 5)', () => {
  let broadcasts: Array<{ channel: string; payload: unknown }>;

  beforeEach(async () => {
    vi.clearAllMocks();
    cloudFailureCooldown.reset();
    mockFolderLoad.mockReturnValue({ version: 1, folders: [], membership: {} });
    mockOutboxGetPendingDeleteSessionIds.mockReturnValue(new Set<string>());
    broadcasts = [];
    const { setBroadcastService } = await import('@core/broadcastService');
    setBroadcastService({
      sendToAllWindows: (channel: string, payload: unknown) => {
        broadcasts.push({ channel, payload });
      },
    } as unknown as Parameters<typeof setBroadcastService>[0]);
  });

  afterEach(() => {
    cloudFailureCooldown.reset();
  });

  it('reconstructs folders.json via the local store on a fresh-machine pull', async () => {
    const router = new CloudRouter();
    router.init(createConfig(createCloudSettings()));
    router._setClientForTests(makeStubClient() as never);

    await router.pullChangedSessions();

    // RED: nothing pulls /api/sessions/folders or writes the store today.
    expect(mockFolderSave).toHaveBeenCalledTimes(1);
    const written = mockFolderSave.mock.calls[0]?.[0] as unknown as FolderStoreData;
    expect(written.version).toBe(1);
    // Empty folder survives the restore.
    expect(written.folders.map((f) => f.id)).toContain('fldr_empty');
    expect(written.membership['cloud-session-1']).toBe('fldr_house');

    router.disconnect();
  });

  it('emits a cloud:folders-restored broadcast so the renderer can re-load (A1)', async () => {
    const router = new CloudRouter();
    router.init(createConfig(createCloudSettings()));
    router._setClientForTests(makeStubClient() as never);

    await router.pullChangedSessions();

    // RED: no such broadcast is wired today — the sidebar stays empty until
    // restart even if disk were primed. This is the user-visible symptom.
    const restored = broadcasts.find((b) => b.channel === 'cloud:folders-restored');
    expect(restored).toBeDefined();

    router.disconnect();
  });

  // Stage 7 — F4: a newer cloud-service returning version:2 must be a no-op on
  // an older desktop: do NOT write the store, do NOT broadcast, do NOT clobber.
  it('F4 newer-cloud version (version:2) ⇒ no save, no broadcast, no clobber', async () => {
    const client = {
      get: vi.fn(async (path: string) => {
        if (path.startsWith('/api/sessions?summaries=true')) {
          return { sessions: [{ id: 'cloud-session-1', updatedAt: 2000 }], totalCount: 1 };
        }
        if (path === '/api/sessions/folders') {
          return { version: 2, folders: [{ id: 'x', name: 'X', createdAt: 1, updatedAt: 1 }], membership: {} };
        }
        if (path.startsWith('/api/sessions/cloud-session-1')) {
          return { id: 'cloud-session-1', updatedAt: 2000, messages: [], eventsByTurn: {} };
        }
        if (path.startsWith('/api/sessions/tombstones')) return { tombstones: [], serverNow: Date.now() };
        return null;
      }),
      put: vi.fn(), post: vi.fn(), patch: vi.fn(), delete: vi.fn(), disconnect: vi.fn(),
    };

    const router = new CloudRouter();
    router.init(createConfig(createCloudSettings()));
    router._setClientForTests(client as never);

    await router.pullChangedSessions();

    expect(mockFolderSave).not.toHaveBeenCalled();
    expect(broadcasts.find((b) => b.channel === 'cloud:folders-restored')).toBeUndefined();

    router.disconnect();
  });

  // Stage 7 — F6: folders the user created on the NEW machine BEFORE first sync
  // must not be silently dropped. Local non-empty ⇒ union (local-only kept).
  it('F6 local folders created pre-sync are preserved (union, not clobbered)', async () => {
    mockFolderLoad.mockReturnValue({
      version: 1,
      folders: [{ id: 'fldr_local', name: 'Local Only', createdAt: 1, updatedAt: 1 }],
      membership: {},
    });

    const router = new CloudRouter();
    router.init(createConfig(createCloudSettings()));
    router._setClientForTests(makeStubClient() as never);

    await router.pullChangedSessions();

    expect(mockFolderSave).toHaveBeenCalledTimes(1);
    const written = mockFolderSave.mock.calls[0]?.[0] as unknown as FolderStoreData;
    const ids = written.folders.map((f) => f.id);
    // Local-only folder preserved AND cloud folders merged in.
    expect(ids).toContain('fldr_local');
    expect(ids).toContain('fldr_house');
    expect(ids).toContain('fldr_empty');

    router.disconnect();
  });
});
