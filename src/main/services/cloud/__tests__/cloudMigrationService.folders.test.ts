// RED until Stage 4 (upload wiring in cloudMigrationService.migrateToCloud).
//
// Bug Mode red→green: this asserts the missing carrier — that migration PUTs
// the folders document to `/api/sessions/folders` AFTER the per-session PUTs.
// On current code NO such PUT is ever made (folders.json reaches the cloud
// through no path — see PLAN.md Root Cause), so the assertion below fails for
// the RIGHT reason: the folders carrier does not exist yet.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Mocks (mirror cloudMigrationService.test.ts)
// ---------------------------------------------------------------------------

const mockPatch = vi.fn();
const mockPut = vi.fn();
const mockPost = vi.fn();
const mockPostStream = vi.fn();
const mockDisconnect = vi.fn();
vi.mock('../cloudServiceClient', () => ({
  CloudServiceClient: class MockCloudServiceClient {
    patch = mockPatch;
    put = mockPut;
    post = mockPost;
    postStream = mockPostStream;
    disconnect = mockDisconnect;
  },
}));

vi.mock('tar', () => {
  const { PassThrough } = require('node:stream');
  return {
    create: vi.fn(() => {
      const stream = new PassThrough();
      process.nextTick(() => stream.end());
      return stream;
    }),
  };
});

vi.mock('@main/utils/dataPaths', () => ({
  getDataPath: () => '/tmp/mock-user-data',
}));

vi.mock('@main/utils/testIsolation', () => ({
  getSuperMcpOAuthTokensDir: () => '/tmp/mock-oauth-tokens',
}));

import { migrateToCloud, type MigrationOptions } from '../cloudMigrationService';
import type { AgentSession, AppSettings } from '@shared/types';
import type { FolderStoreData } from '@shared/ipc/schemas/folders';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createSettings(): AppSettings {
  return {
    coreDirectory: '/Users/me/Documents/Rebel',
    cloudInstance: {
      mode: 'cloud',
      cloudUrl: 'https://rebel-test.fly.dev',
      cloudToken: 'test-token',
    },
    onboardingCompleted: true,
    userEmail: 'user@example.com',
    mcpConfigFile: null,
    userFirstName: 'Test',
    onboardingFirstCompletedAt: 1700000000000,
    voice: {
      provider: 'openai-whisper',
      openaiApiKey: null,
      elevenlabsApiKey: null,
      model: 'whisper-1',
      ttsVoice: null,
      activationHotkey: null,
      activationHotkeyVoiceMode: false,
    },
    claude: { apiKey: '', model: 'claude-sonnet-4-20250514' },
    diagnostics: { sentryEnabled: true },
  } as unknown as AppSettings;
}

function createSession(id: string): AgentSession {
  return {
    id,
    title: `Session ${id}`,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    messages: [],
    eventsByTurn: {},
    activeTurnId: null,
    isBusy: false,
    lastError: null,
    resolvedAt: null,
  } as unknown as AgentSession;
}

// A populated store with an EMPTY folder (no members) + 2 memberships, so the
// carrier must transmit the WHOLE document (folder defs are independent of
// membership — Option A; see PLAN.md F2 empty-folder survival).
function createPopulatedFolders(): FolderStoreData {
  return {
    version: 1,
    folders: [
      { id: 'fldr_house', name: 'house', createdAt: 1000, updatedAt: 2000 },
      { id: 'fldr_bloom_it', name: 'Bloom IT', createdAt: 1500, updatedAt: 2500 },
      // EMPTY folder — zero members. Must survive the round-trip.
      { id: 'fldr_empty', name: 'Empty Folder', createdAt: 1700, updatedAt: 1700 },
    ],
    membership: {
      's1': 'fldr_house',
      's2': 'fldr_bloom_it',
    },
  };
}

function createMigrationOptions(overrides?: Partial<MigrationOptions>): MigrationOptions {
  return {
    cloudUrl: 'https://rebel-test.fly.dev',
    cloudToken: 'bridge-token-abc',
    getSettings: () => createSettings(),
    loadSessions: () => [],
    ...overrides,
  };
}

const FOLDERS_PATH = '/api/sessions/folders';

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('migrateToCloud — folders upload (RED until Stage 4)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockPatch.mockResolvedValue({ success: true });
    mockPut.mockResolvedValue({ success: true });
    mockPost.mockResolvedValue({ success: true });
    mockPostStream.mockResolvedValue({ success: true, fileCount: 0 });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('PUTs the populated folders document to /api/sessions/folders', async () => {
    const folders = createPopulatedFolders();
    const options = createMigrationOptions({
      loadSessions: () => [createSession('s1'), createSession('s2')],
      loadFolders: () => folders,
    });

    await migrateToCloud(options);

    const foldersCall = mockPut.mock.calls.find((call) => call[0] === FOLDERS_PATH);
    // RED: no folders carrier exists, so this PUT is never made today.
    expect(foldersCall).toBeDefined();

    const body = foldersCall![1] as FolderStoreData;
    expect(body.version).toBe(1);
    // Whole document carried — empty folder survives.
    expect(body.folders).toHaveLength(3);
    expect(body.folders.map((f) => f.id)).toContain('fldr_empty');
    expect(body.membership).toEqual({ s1: 'fldr_house', s2: 'fldr_bloom_it' });
  });

  it('uploads folders AFTER sessions (membership references already-PUT sessions)', async () => {
    const folders = createPopulatedFolders();
    const options = createMigrationOptions({
      loadSessions: () => [createSession('s1'), createSession('s2')],
      loadFolders: () => folders,
    });

    await migrateToCloud(options);

    const putPaths = mockPut.mock.calls.map((call) => String(call[0]));
    const foldersIndex = putPaths.indexOf(FOLDERS_PATH);
    const lastSessionIndex = Math.max(
      putPaths.lastIndexOf('/api/sessions/s1'),
      putPaths.lastIndexOf('/api/sessions/s2'),
    );

    // RED: foldersIndex is -1 today (no carrier), so the ordering assertion fails.
    expect(foldersIndex).toBeGreaterThan(-1);
    expect(foldersIndex).toBeGreaterThan(lastSessionIndex);
  });

  // Stage 7 — F7 partial migration: a per-session PUT failure must NOT prevent
  // the folders document from being uploaded (folders run last + are guarded).
  it('F7 still uploads folders when a session PUT fails', async () => {
    const folders = createPopulatedFolders();
    mockPut.mockImplementation(async (path: string) => {
      if (path === '/api/sessions/s1') throw new Error('boom');
      return { success: true };
    });
    const options = createMigrationOptions({
      loadSessions: () => [createSession('s1'), createSession('s2')],
      loadFolders: () => folders,
    });

    const result = await migrateToCloud(options);

    expect(mockPut.mock.calls.some((c) => c[0] === FOLDERS_PATH)).toBe(true);
    expect(result.foldersMigrated).toBe(true);
    expect(result.sessionsMigrated).toBe(1); // s2 only
  });

  // F8: a throwing folders PUT must not abort migration; foldersMigrated=false.
  it('F8 a failing folders PUT does not abort migration', async () => {
    const folders = createPopulatedFolders();
    mockPut.mockImplementation(async (path: string) => {
      if (path === FOLDERS_PATH) throw new Error('folders endpoint down');
      return { success: true };
    });
    const options = createMigrationOptions({
      loadSessions: () => [createSession('s1')],
      loadFolders: () => folders,
    });

    const result = await migrateToCloud(options);

    expect(result.sessionsMigrated).toBe(1);
    expect(result.foldersMigrated).toBe(false);
    expect(result.errors.some((e) => e.includes('Folders migration failed'))).toBe(true);
  });

  // A throwing loadFolders is handled gracefully (no abort, no folders PUT).
  it('handles a throwing loadFolders without aborting migration', async () => {
    const options = createMigrationOptions({
      loadSessions: () => [createSession('s1')],
      loadFolders: () => { throw new Error('store unavailable'); },
    });

    const result = await migrateToCloud(options);

    expect(result.sessionsMigrated).toBe(1);
    expect(result.foldersMigrated).toBe(false);
    expect(mockPut.mock.calls.some((c) => c[0] === FOLDERS_PATH)).toBe(false);
  });
});
