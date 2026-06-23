/**
 * Stage 5 — runId propagation + migration concurrency mutex.
 *
 * Verifies that every `MigrationStep` emitted during a single call to
 * `migrateToCloud()` carries the same `runId`, that separate runs produce
 * distinct `runId`s, and that overlapping migrations reject with the
 * `MIGRATION_IN_PROGRESS` error rather than silently stomping on each other.
 *
 * See planning doc:
 *   docs/plans/260419_cloud_setup_adaptive_sizing_and_honest_progress.md
 *   (Stage 5 — Honest workspace progress + Review-Driven Amendments: mutex)
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Mocks — must be defined before the migrateToCloud import.
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

// Tar mock that immediately ends so uploadWorkspaceFiles exits cleanly.
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
  getDataPath: () => '/tmp/mock-user-data-runid',
}));

vi.mock('@main/utils/testIsolation', () => ({
  getSuperMcpOAuthTokensDir: () => '/tmp/mock-oauth-tokens-runid',
}));

import {
  migrateToCloud,
  isMigrationInFlight,
  MigrationInProgressError,
  type MigrationOptions,
  type MigrationStep,
} from '../cloudMigrationService';
import type { AppSettings } from '@shared/types';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createSettings(): AppSettings {
  return {
    // Intentionally point at a non-existent path so the workspace walk
    // produces zero files (we don't care about the workspace phase here —
    // we only care about the runId and mutex behaviour).
    coreDirectory: '/tmp/nonexistent-rebel-workspace-runid',
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

function baseOptions(overrides?: Partial<MigrationOptions>): MigrationOptions {
  return {
    cloudUrl: 'https://rebel-test.fly.dev',
    cloudToken: 'bridge-token-abc',
    getSettings: () => createSettings(),
    loadSessions: () => [],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('migrateToCloud — runId propagation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockPatch.mockResolvedValue({ success: true });
    mockPut.mockResolvedValue({ success: true });
    mockPost.mockResolvedValue({ success: true });
    mockPostStream.mockResolvedValue({ success: true, fileCount: 0, archiveSize: 0 });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('decorates every MigrationStep with a single UUID-shaped runId', async () => {
    const steps: MigrationStep[] = [];
    await migrateToCloud(baseOptions({ onProgress: (s) => steps.push({ ...s }) }));

    expect(steps.length).toBeGreaterThan(0);

    // Every step has a runId
    for (const step of steps) {
      expect(typeof step.runId).toBe('string');
      expect(step.runId).toBeTruthy();
    }

    // All runIds are identical within the run
    const unique = new Set(steps.map((s) => s.runId));
    expect(unique.size).toBe(1);

    // UUID v4 shape (not strict — matches node:crypto randomUUID output)
    const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    expect(steps[0].runId).toMatch(UUID_RE);
  });

  it('produces distinct runIds for two serial migrations', async () => {
    const stepsA: MigrationStep[] = [];
    const stepsB: MigrationStep[] = [];

    await migrateToCloud(baseOptions({ onProgress: (s) => stepsA.push({ ...s }) }));
    await migrateToCloud(baseOptions({ onProgress: (s) => stepsB.push({ ...s }) }));

    expect(stepsA[0].runId).toBeTruthy();
    expect(stepsB[0].runId).toBeTruthy();
    expect(stepsA[0].runId).not.toBe(stepsB[0].runId);
  });
});

describe('migrateToCloud — concurrency mutex', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockPatch.mockResolvedValue({ success: true });
    mockPut.mockResolvedValue({ success: true });
    mockPost.mockResolvedValue({ success: true });
    mockPostStream.mockResolvedValue({ success: true, fileCount: 0, archiveSize: 0 });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('rejects an overlapping migration with MIGRATION_IN_PROGRESS', async () => {
    // Gate the first migration's patch so the second call lands while it is
    // still in-flight.
    let release!: () => void;
    const pending = new Promise<void>((resolve) => { release = resolve; });
    mockPatch.mockImplementation(async () => {
      await pending;
      return { success: true };
    });

    const first = migrateToCloud(baseOptions());

    // Give the first migration a tick to set the mutex.
    await new Promise((r) => setImmediate(r));
    expect(isMigrationInFlight()).toBe(true);

    await expect(migrateToCloud(baseOptions())).rejects.toBeInstanceOf(MigrationInProgressError);

    // Let the first migration finish and confirm the mutex clears.
    release();
    await first;
    expect(isMigrationInFlight()).toBe(false);
  });

  it('releases the mutex after a successful migration so a follow-up run is allowed', async () => {
    await migrateToCloud(baseOptions());
    expect(isMigrationInFlight()).toBe(false);

    // A second run should proceed normally (no MIGRATION_IN_PROGRESS).
    await expect(migrateToCloud(baseOptions())).resolves.toBeDefined();
  });

  it('releases the mutex even when a phase throws internally', async () => {
    // Settings patch rejects — migrateToCloud catches and continues, but the
    // mutex must still clear in `finally`.
    mockPatch.mockRejectedValueOnce(new Error('Boom'));

    await migrateToCloud(baseOptions());
    expect(isMigrationInFlight()).toBe(false);

    await expect(migrateToCloud(baseOptions())).resolves.toBeDefined();
  });

  it('MigrationInProgressError carries the MIGRATION_IN_PROGRESS code', () => {
    const err = new MigrationInProgressError();
    expect(err.code).toBe('MIGRATION_IN_PROGRESS');
    expect(err.name).toBe('MigrationInProgressError');
  });
});
