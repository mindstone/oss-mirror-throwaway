import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mocks – declared before imports so vi.mock hoisting works correctly
// ---------------------------------------------------------------------------

vi.mock('@core/logger', () => ({
  createScopedLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

const mockFetchLatestTag = vi.fn();
const mockIsCloudVersionCurrent = vi.fn();

vi.mock('@core/services/cloudUpdateService', () => ({
  fetchLatestTag: (...args: unknown[]) => mockFetchLatestTag(...args),
  isCloudVersionCurrent: (...args: unknown[]) => mockIsCloudVersionCurrent(...args),
}));

const mockUpdateMachineConfig = vi.fn();

vi.mock('@core/services/flyApiClient', () => ({
  updateMachineConfig: (...args: unknown[]) => mockUpdateMachineConfig(...args),
}));

const mockGetActiveTurnCount = vi.fn();

vi.mock('@core/services/agentTurnRegistry', () => ({
  agentTurnRegistry: {
    getActiveTurnCount: () => mockGetActiveTurnCount(),
  },
}));

const mockCaptureMessage = vi.fn();
const mockCaptureException = vi.fn();

vi.mock('@core/errorReporter', () => ({
  getErrorReporter: () => ({
    captureException: (...args: unknown[]) => mockCaptureException(...args),
    captureMessage: (...args: unknown[]) => mockCaptureMessage(...args),
    addBreadcrumb: vi.fn(),
  }),
}));

const mockWriteFile = vi.fn();

vi.mock('node:fs/promises', () => ({
  default: {
    writeFile: (...args: unknown[]) => mockWriteFile(...args),
  },
}));

// The scheduler's startup calls applyFlyRestartPolicyMigration (Stage B of
// docs/plans/260510_cloud_image_rollback_defense_in_depth.md). This test
// suite predates that migration and only cares about the update-cycle
// behavior, so we stub the migration to a no-op. Migration's own behavior
// is covered by `cloud-service/src/services/__tests__/flyRestartPolicyMigration.test.ts`.
vi.mock('../services/flyRestartPolicyMigration', () => ({
  applyFlyRestartPolicyMigration: vi.fn().mockResolvedValue({ outcome: 'already-migrated' }),
}));

// ---------------------------------------------------------------------------
// Import under test (after mocks are set up)
// ---------------------------------------------------------------------------

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  startSelfUpdateScheduler,
  stopSelfUpdateScheduler,
} from '../selfUpdateScheduler';
import { createQuarantinedTagsStore } from '../services/quarantinedTagsStore';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Set __BUILD_COMMIT__ global. Pass undefined to simulate dev mode. */
function setBuildCommit(value: string | undefined): void {
  (globalThis as Record<string, unknown>).__BUILD_COMMIT__ = value;
}

function defaultConfig() {
  return {
    getSettings: () => ({ cloudUpdateChannel: 'stable' as const }),
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('selfUpdateScheduler', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();

    // Sensible defaults for every test
    setBuildCommit('abc1234');
    mockFetchLatestTag.mockResolvedValue({ tag: 'prod-def5678' });
    mockIsCloudVersionCurrent.mockReturnValue(false);
    mockGetActiveTurnCount.mockReturnValue(0);
    mockUpdateMachineConfig.mockResolvedValue({ success: true, restarted: true });
    mockWriteFile.mockResolvedValue(undefined);

    // Default: no Fly env vars (VM provider)
    delete process.env.FLY_APP_NAME;
    delete process.env.FLY_MACHINE_ID;
    delete process.env.FLY_API_TOKEN;
  });

  afterEach(() => {
    stopSelfUpdateScheduler();
    vi.useRealTimers();
    // Clean up global
    delete (globalThis as Record<string, unknown>).__BUILD_COMMIT__;
  });

  // -----------------------------------------------------------------------
  // Guard: __BUILD_COMMIT__
  // -----------------------------------------------------------------------

  it('skips when __BUILD_COMMIT__ is undefined', async () => {
    setBuildCommit(undefined);
    startSelfUpdateScheduler(defaultConfig());

    // Advance past max jitter + some margin
    await vi.advanceTimersByTimeAsync(31 * 60 * 1000);

    expect(mockFetchLatestTag).not.toHaveBeenCalled();
  });

  it('skips when __BUILD_COMMIT__ is "unknown"', async () => {
    setBuildCommit('unknown');
    startSelfUpdateScheduler(defaultConfig());

    await vi.advanceTimersByTimeAsync(31 * 60 * 1000);

    expect(mockFetchLatestTag).not.toHaveBeenCalled();
  });

  // -----------------------------------------------------------------------
  // Already up-to-date
  // -----------------------------------------------------------------------

  it('skips when isCloudVersionCurrent() returns true', async () => {
    mockIsCloudVersionCurrent.mockReturnValue(true);
    startSelfUpdateScheduler(defaultConfig());

    await vi.advanceTimersByTimeAsync(31 * 60 * 1000);

    expect(mockFetchLatestTag).toHaveBeenCalled();
    expect(mockUpdateMachineConfig).not.toHaveBeenCalled();
    expect(mockWriteFile).not.toHaveBeenCalled();
    // Already-up-to-date is an expected/self-healing path → no failure capture.
    expect(mockCaptureMessage).not.toHaveBeenCalled();
  });

  // -----------------------------------------------------------------------
  // Active turns deferral
  // -----------------------------------------------------------------------

  it('defers when agentTurnRegistry.getActiveTurnCount() > 0', async () => {
    mockGetActiveTurnCount.mockReturnValue(2);
    startSelfUpdateScheduler(defaultConfig());

    await vi.advanceTimersByTimeAsync(31 * 60 * 1000);

    expect(mockFetchLatestTag).toHaveBeenCalled();
    expect(mockIsCloudVersionCurrent).toHaveBeenCalled();
    expect(mockUpdateMachineConfig).not.toHaveBeenCalled();
    expect(mockWriteFile).not.toHaveBeenCalled();
    // Deferral is expected behaviour → no failure capture.
    expect(mockCaptureMessage).not.toHaveBeenCalled();
  });

  // -----------------------------------------------------------------------
  // Fly path
  // -----------------------------------------------------------------------

  it('Fly: calls updateMachineConfig with correct image when env vars set', async () => {
    process.env.FLY_APP_NAME = 'rebel-test-app';
    process.env.FLY_MACHINE_ID = 'machine-123';
    process.env.FLY_API_TOKEN = 'fly-token-secret';

    startSelfUpdateScheduler(defaultConfig());
    await vi.advanceTimersByTimeAsync(31 * 60 * 1000);

    expect(mockUpdateMachineConfig).toHaveBeenCalledWith(
      'fly-token-secret',
      'rebel-test-app',
      'machine-123',
      expect.any(Function),
    );

    // Verify the patcher produces the correct image
    const patcher = mockUpdateMachineConfig.mock.calls[0][3];
    const result = patcher({ existing: 'config' });
    expect(result).toEqual({
      existing: 'config',
      image: 'ghcr.io/mindstone/rebel-cloud:prod-def5678',
    });
  });

  it('Fly: skips AND captures fly-token-missing when FLY_API_TOKEN is absent', async () => {
    process.env.FLY_APP_NAME = 'rebel-test-app';
    process.env.FLY_MACHINE_ID = 'machine-123';
    // FLY_API_TOKEN intentionally not set

    startSelfUpdateScheduler(defaultConfig());
    await vi.advanceTimersByTimeAsync(31 * 60 * 1000);

    expect(mockUpdateMachineConfig).not.toHaveBeenCalled();
    // Known-degraded config (desktop bootstraps the token) → 'info', not paging.
    // Since 260610 improve-sentry-noise Stage 5 this routes through the
    // known-conditions registry (cloud_self_update_credentials_missing,
    // sink: 'issue-stream') — wrapped captureException, registry-owned
    // level/fingerprint (fingerprint preserved from the old raw capture).
    expect(mockCaptureMessage).not.toHaveBeenCalled();
    expect(mockCaptureException).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({
        level: 'info',
        fingerprint: ['cloud.self_update.failed', 'fly-token-missing'],
        tags: expect.objectContaining({ cause: 'fly-token-missing', provider: 'fly' }),
        _knownConditionWrapped: true,
      }),
    );
  });

  it('Fly: skips AND captures fly-env-missing when FLY_MACHINE_ID is absent', async () => {
    process.env.FLY_APP_NAME = 'rebel-test-app';
    process.env.FLY_API_TOKEN = 'fly-token-secret';
    // FLY_MACHINE_ID intentionally not set

    startSelfUpdateScheduler(defaultConfig());
    await vi.advanceTimersByTimeAsync(31 * 60 * 1000);

    expect(mockUpdateMachineConfig).not.toHaveBeenCalled();
    expect(mockCaptureMessage).not.toHaveBeenCalled();
    expect(mockCaptureException).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({
        level: 'info',
        fingerprint: ['cloud.self_update.failed', 'fly-env-missing'],
        tags: expect.objectContaining({ cause: 'fly-env-missing' }),
        _knownConditionWrapped: true,
      }),
    );
  });

  it('Fly: captures fly-update-failed when updateMachineConfig fails', async () => {
    process.env.FLY_APP_NAME = 'rebel-test-app';
    process.env.FLY_MACHINE_ID = 'machine-123';
    process.env.FLY_API_TOKEN = 'fly-token-secret';
    mockUpdateMachineConfig.mockResolvedValue({ success: false, error: 'HTTP 500 boom' });

    startSelfUpdateScheduler(defaultConfig());
    await vi.advanceTimersByTimeAsync(31 * 60 * 1000);

    expect(mockUpdateMachineConfig).toHaveBeenCalledOnce();
    expect(mockCaptureMessage).toHaveBeenCalledWith(
      'cloud.self_update.failed',
      expect.objectContaining({
        fingerprint: ['cloud.self_update.failed', 'fly-update-failed'],
        tags: expect.objectContaining({ cause: 'fly-update-failed', provider: 'fly' }),
        extra: expect.objectContaining({ error: 'HTTP 500 boom' }),
      }),
    );
  });

  // -----------------------------------------------------------------------
  // VM path
  // -----------------------------------------------------------------------

  it('VM: writes both .update-signal and rebel-cloud.tag files', async () => {
    // No FLY_APP_NAME → VM provider
    startSelfUpdateScheduler(defaultConfig());
    await vi.advanceTimersByTimeAsync(31 * 60 * 1000);

    expect(mockWriteFile).toHaveBeenCalledTimes(2);
    expect(mockWriteFile).toHaveBeenCalledWith(
      expect.stringContaining('rebel-cloud.tag'),
      'prod-def5678',
      'utf-8',
    );
    expect(mockWriteFile).toHaveBeenCalledWith(
      expect.stringContaining('.update-signal'),
      'prod-def5678',
      'utf-8',
    );
  });

  it('VM: captures vm-signal-write-failed when writing the signal files throws', async () => {
    // No FLY_APP_NAME → VM provider
    mockWriteFile.mockRejectedValue(new Error('EACCES: read-only /data'));

    startSelfUpdateScheduler(defaultConfig());
    await vi.advanceTimersByTimeAsync(31 * 60 * 1000);

    expect(mockCaptureMessage).toHaveBeenCalledWith(
      'cloud.self_update.failed',
      expect.objectContaining({
        fingerprint: ['cloud.self_update.failed', 'vm-signal-write-failed'],
        tags: expect.objectContaining({ cause: 'vm-signal-write-failed', provider: 'vm' }),
      }),
    );
  });

  // -----------------------------------------------------------------------
  // Rate-limited / error handling
  // -----------------------------------------------------------------------

  it('handles fetchLatestTag rate-limited response gracefully (no capture)', async () => {
    mockFetchLatestTag.mockResolvedValue({ rateLimited: true });

    startSelfUpdateScheduler(defaultConfig());
    await vi.advanceTimersByTimeAsync(31 * 60 * 1000);

    expect(mockIsCloudVersionCurrent).not.toHaveBeenCalled();
    expect(mockUpdateMachineConfig).not.toHaveBeenCalled();
    expect(mockWriteFile).not.toHaveBeenCalled();
    // Rate-limit is transient/self-healing → must NOT capture (would be noise).
    expect(mockCaptureMessage).not.toHaveBeenCalled();
  });

  it('captures tag-resolve-failed when fetchLatestTag returns an error', async () => {
    mockFetchLatestTag.mockResolvedValue({ error: 'Network error' });

    startSelfUpdateScheduler(defaultConfig());
    await vi.advanceTimersByTimeAsync(31 * 60 * 1000);

    expect(mockIsCloudVersionCurrent).not.toHaveBeenCalled();
    expect(mockUpdateMachineConfig).not.toHaveBeenCalled();
    expect(mockWriteFile).not.toHaveBeenCalled();
    expect(mockCaptureMessage).toHaveBeenCalledWith(
      'cloud.self_update.failed',
      expect.objectContaining({
        fingerprint: ['cloud.self_update.failed', 'tag-resolve-failed'],
        tags: expect.objectContaining({ cause: 'tag-resolve-failed' }),
        extra: expect.objectContaining({ error: 'Network error' }),
      }),
    );
  });

  // -----------------------------------------------------------------------
  // Timer cleanup
  // -----------------------------------------------------------------------

  it('cleans up timers on stopSelfUpdateScheduler()', async () => {
    startSelfUpdateScheduler(defaultConfig());

    // Stop before any timer fires
    stopSelfUpdateScheduler();

    // Advance well past all timers
    await vi.advanceTimersByTimeAsync(7 * 60 * 60 * 1000);

    expect(mockFetchLatestTag).not.toHaveBeenCalled();
  });

  // -----------------------------------------------------------------------
  // Channel reads from settings
  // -----------------------------------------------------------------------

  it('passes cloudUpdateChannel from settings to fetchLatestTag', async () => {
    const config = {
      getSettings: () => ({ cloudUpdateChannel: 'beta' as const }),
    };

    startSelfUpdateScheduler(config);
    await vi.advanceTimersByTimeAsync(31 * 60 * 1000);

    expect(mockFetchLatestTag).toHaveBeenCalledWith('beta');
  });

  // -----------------------------------------------------------------------
  // Quarantine guard (Stage F of
  // docs/plans/260510_cloud_image_rollback_defense_in_depth.md)
  // -----------------------------------------------------------------------

  it('skips the update cycle when the latest tag is in the quarantine list', async () => {
    process.env.FLY_APP_NAME = 'rebel-test-app';
    process.env.FLY_MACHINE_ID = 'machine-123';
    process.env.FLY_API_TOKEN = 'fly-token-secret';

    // Set up REBEL_USER_DATA so the scheduler reads quarantine from a real
    // temp dir we control.
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sched-quarantine-'));
    process.env.REBEL_USER_DATA = tmpDir;
    const quarantineStore = createQuarantinedTagsStore({ dataPath: tmpDir });
    quarantineStore.addRejected('ghcr.io/mindstone/rebel-cloud:prod-def5678', {
      ttlMs: 7 * 24 * 60 * 60 * 1000,
      now: Date.now(),
    });

    startSelfUpdateScheduler(defaultConfig());
    await vi.advanceTimersByTimeAsync(31 * 60 * 1000);

    expect(mockFetchLatestTag).toHaveBeenCalled();
    expect(mockUpdateMachineConfig).not.toHaveBeenCalled();
    // Quarantine skip is an intentional safety hold, not a failure → no capture.
    expect(mockCaptureMessage).not.toHaveBeenCalled();

    fs.rmSync(tmpDir, { recursive: true, force: true });
    delete process.env.REBEL_USER_DATA;
  });

  it('proceeds normally when the quarantine list is empty', async () => {
    process.env.FLY_APP_NAME = 'rebel-test-app';
    process.env.FLY_MACHINE_ID = 'machine-123';
    process.env.FLY_API_TOKEN = 'fly-token-secret';

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sched-no-quarantine-'));
    process.env.REBEL_USER_DATA = tmpDir;

    startSelfUpdateScheduler(defaultConfig());
    await vi.advanceTimersByTimeAsync(31 * 60 * 1000);

    expect(mockUpdateMachineConfig).toHaveBeenCalledOnce();

    fs.rmSync(tmpDir, { recursive: true, force: true });
    delete process.env.REBEL_USER_DATA;
  });

  it('captures quarantine-read-failed (and still fails-open) when the quarantine file is corrupt', async () => {
    process.env.FLY_APP_NAME = 'rebel-test-app';
    process.env.FLY_MACHINE_ID = 'machine-123';
    process.env.FLY_API_TOKEN = 'fly-token-secret';

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sched-corrupt-quarantine-'));
    process.env.REBEL_USER_DATA = tmpDir;
    // Present-but-unparseable quarantine file — the store would silently return
    // [] (guard disabled). The scheduler's corruption probe must surface it.
    fs.writeFileSync(path.join(tmpDir, 'quarantined-image-tags.json'), '{ this is not json', 'utf-8');

    startSelfUpdateScheduler(defaultConfig());
    await vi.advanceTimersByTimeAsync(31 * 60 * 1000);

    expect(mockCaptureMessage).toHaveBeenCalledWith(
      'cloud.self_update.failed',
      expect.objectContaining({
        level: 'warning',
        fingerprint: ['cloud.self_update.failed', 'quarantine-read-failed'],
        tags: expect.objectContaining({ cause: 'quarantine-read-failed' }),
      }),
    );
    // Fail-open: the update still proceeds (the watchdog is the backstop).
    expect(mockUpdateMachineConfig).toHaveBeenCalledOnce();

    fs.rmSync(tmpDir, { recursive: true, force: true });
    delete process.env.REBEL_USER_DATA;
  });

  it('proceeds when the quarantine entry is for a different tag (suffix match is exact)', async () => {
    process.env.FLY_APP_NAME = 'rebel-test-app';
    process.env.FLY_MACHINE_ID = 'machine-123';
    process.env.FLY_API_TOKEN = 'fly-token-secret';

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sched-other-quarantine-'));
    process.env.REBEL_USER_DATA = tmpDir;
    const quarantineStore = createQuarantinedTagsStore({ dataPath: tmpDir });
    quarantineStore.addRejected('ghcr.io/mindstone/rebel-cloud:prod-OLDBAD', {
      ttlMs: 7 * 24 * 60 * 60 * 1000,
      now: Date.now(),
    });

    startSelfUpdateScheduler(defaultConfig());
    await vi.advanceTimersByTimeAsync(31 * 60 * 1000);

    expect(mockUpdateMachineConfig).toHaveBeenCalledOnce();

    fs.rmSync(tmpDir, { recursive: true, force: true });
    delete process.env.REBEL_USER_DATA;
  });
});
