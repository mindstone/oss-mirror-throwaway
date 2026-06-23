/**
 * Stage 5 — cloud:migrate broadcast round-trip.
 *
 * The `'cloud:migration-progress'` IPC channel is a raw broadcast without a
 * Zod schema, so nothing automatic guards it against silent field drops if
 * `MigrationStep` gains a new optional field. This test is the enforcement
 * mechanism: we build a `MigrationStep` with every optional field populated,
 * drive it through the `cloud:migrate` handler's `onProgress` forwarder, and
 * assert the payload delivered to `BrowserWindow.webContents.send` still
 * contains every field.
 *
 * See planning doc:
 *   docs/plans/260419_cloud_setup_adaptive_sizing_and_honest_progress.md
 *   (Stage 5 — Honest workspace progress; FMM row "cloudHandlers.ts broadcast")
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { AppSettings } from '@shared/types';
import type { MigrationStep } from '@shared/cloudMigrationTypes';

// ---------------------------------------------------------------------------
// Handler capture + electron BrowserWindow mock
// ---------------------------------------------------------------------------
const handlers = new Map<string, (...args: unknown[]) => unknown>();

vi.mock('@core/handlerRegistry', () => ({
  getHandlerRegistry: () => ({
    register: (channel: string, handler: (...args: unknown[]) => unknown) => {
      handlers.set(channel, handler);
    },
  }),
}));

const mockSend = vi.fn();
const mockWindow = {
  webContents: { send: mockSend },
};
const getAllWindows = vi.fn(() => [mockWindow]);

vi.mock('electron', () => ({
  BrowserWindow: { getAllWindows },
}));

vi.mock('../../services/authTokenStorage', () => ({
  loadSessionToken: () => null,
}));

vi.mock('@core/services/mindstoneApiUrl', () => ({
  MINDSTONE_API_URL: 'https://test.rebel.mindstone.com',
}));

vi.mock('@core/rebelAuth', () => ({
  getRebelAuthProvider: () => ({
      getAuthState: vi.fn(() => ({ isAuthenticated: false, user: null, isLoading: false })),
      onAuthStateChange: vi.fn(() => () => {}),
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
      getAccessToken: () => Promise.resolve('jwt-token-123'),
  }),
  setRebelAuthProvider: vi.fn(),
  NULL_REBEL_AUTH_PROVIDER: {},
}));


// Stub the other cloud-touching modules so the handler registration path
// doesn't try to pull in real implementations.
vi.mock('../../services/cloud/cloudRouter', () => ({
  cloudRouter: { syncNow: vi.fn().mockResolvedValue({ success: true }) },
}));

vi.mock('../../services/cloud/cloudOutbox', () => ({
  cloudOutbox: {
    clearAll: vi.fn(),
    getStatus: vi.fn().mockReturnValue({ pending: 0, failed: 0 }),
  },
}));

// ---------------------------------------------------------------------------
// migrateToCloud mock — the handler invokes onProgress; we make the mock
// invoke it with a canonical step so we can inspect what lands in send().
// ---------------------------------------------------------------------------
type MigrateCall = {
  opts: { onProgress?: (step: MigrationStep) => void };
};

const migrateCalls: MigrateCall[] = [];
const mockMigrateToCloud = vi.fn(async (opts: MigrateCall['opts']) => {
  migrateCalls.push({ opts });
  return { errors: [] };
});

vi.mock('../../services/cloud/cloudMigrationService', () => ({
  migrateToCloud: (opts: MigrateCall['opts']) => mockMigrateToCloud(opts),
}));

// ---------------------------------------------------------------------------
// Settings helpers
// ---------------------------------------------------------------------------
let settings: Partial<AppSettings>;
const getSettings = () => settings as AppSettings;
const updateSettings = vi.fn((patch: Partial<AppSettings>) => {
  Object.assign(settings, patch);
});

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------
beforeEach(async () => {
  handlers.clear();
  migrateCalls.length = 0;
  mockSend.mockReset();
  getAllWindows.mockImplementation(() => [mockWindow]);
  mockMigrateToCloud.mockClear();
  settings = {
    cloudInstance: {
      mode: 'cloud',
      cloudUrl: 'https://rebel-test.fly.dev',
      cloudToken: 'token',
    },
  };

  const { registerCloudHandlers } = await import('../cloudHandlers');
  registerCloudHandlers({ getSettings, updateSettings });
});

function invoke(channel: string, ...args: unknown[]) {
  const handler = handlers.get(channel);
  if (!handler) throw new Error(`No handler registered for ${channel}`);
  return handler(null, ...args);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('cloud:migrate — broadcast round-trip', () => {
  it('forwards every MigrationStep field intact to webContents.send', async () => {
    const fullStep: Required<MigrationStep> = {
      phase: 'workspace',
      message: 'Uploading workspace... 240/900 MB sent',
      progress: 17.5,
      current: 251_658_240,
      total: 943_718_400,
      bytesTotal: 943_718_400,
      live: true,
      runId: '11111111-2222-3333-4444-555555555555',
    };

    // When the handler calls migrateToCloud, synchronously invoke the
    // onProgress callback with our canonical step.
    mockMigrateToCloud.mockImplementationOnce(async (opts) => {
      opts.onProgress?.(fullStep);
      return { errors: [] };
    });

    await invoke('cloud:migrate');

    // Filter to just the migration-progress channel — the handler also
    // broadcasts `cloud:outbox-changed` on success, which we ignore here.
    const progressCalls = mockSend.mock.calls.filter(
      (call) => call[0] === 'cloud:migration-progress',
    );
    expect(progressCalls).toHaveLength(1);

    const payload = progressCalls[0][1] as MigrationStep;
    // Every field survived the broadcast construction.
    expect(payload.phase).toBe(fullStep.phase);
    expect(payload.message).toBe(fullStep.message);
    expect(payload.progress).toBe(fullStep.progress);
    expect(payload.current).toBe(fullStep.current);
    expect(payload.total).toBe(fullStep.total);
    expect(payload.bytesTotal).toBe(fullStep.bytesTotal);
    expect(payload.live).toBe(fullStep.live);
    expect(payload.runId).toBe(fullStep.runId);
  });

  it('preserves minimal MigrationStep shape (undefined optional fields stay undefined)', async () => {
    const minimal: MigrationStep = {
      phase: 'settings',
      message: 'Migrating settings and API keys...',
      progress: 0,
    };

    mockMigrateToCloud.mockImplementationOnce(async (opts) => {
      opts.onProgress?.(minimal);
      return { errors: [] };
    });

    await invoke('cloud:migrate');

    const progressCalls = mockSend.mock.calls.filter(
      (call) => call[0] === 'cloud:migration-progress',
    );
    expect(progressCalls).toHaveLength(1);
    const payload = progressCalls[0][1] as MigrationStep;
    expect(payload.phase).toBe('settings');
    expect(payload.message).toBe(minimal.message);
    expect(payload.progress).toBe(0);
    expect(payload.current).toBeUndefined();
    expect(payload.total).toBeUndefined();
    expect(payload.bytesTotal).toBeUndefined();
    expect(payload.live).toBeUndefined();
    expect(payload.runId).toBeUndefined();
  });

  it('broadcasts one send() per MigrationStep across multiple progress events', async () => {
    const steps: MigrationStep[] = [
      { phase: 'settings', message: 'Start', progress: 0, runId: 'run-1' },
      { phase: 'workspace', message: 'Mid', progress: 15, runId: 'run-1', live: true },
      { phase: 'complete', message: 'Done', progress: 100, runId: 'run-1' },
    ];

    mockMigrateToCloud.mockImplementationOnce(async (opts) => {
      for (const s of steps) opts.onProgress?.(s);
      return { errors: [] };
    });

    await invoke('cloud:migrate');

    const progressCalls = mockSend.mock.calls.filter(
      (call) => call[0] === 'cloud:migration-progress',
    );
    expect(progressCalls).toHaveLength(steps.length);
    const runIds = progressCalls.map((call) => (call[1] as MigrationStep).runId);
    expect(new Set(runIds)).toEqual(new Set(['run-1']));
  });

  it('sends to every BrowserWindow returned by getAllWindows', async () => {
    const secondSend = vi.fn();
    getAllWindows.mockImplementationOnce(() => [
      mockWindow,
      { webContents: { send: secondSend } },
    ]);

    mockMigrateToCloud.mockImplementationOnce(async (opts) => {
      opts.onProgress?.({ phase: 'workspace', message: 'tick', progress: 15, runId: 'r' });
      return { errors: [] };
    });

    await invoke('cloud:migrate');

    const primaryProgressCalls = mockSend.mock.calls.filter(
      (call) => call[0] === 'cloud:migration-progress',
    );
    const secondaryProgressCalls = secondSend.mock.calls.filter(
      (call) => call[0] === 'cloud:migration-progress',
    );
    expect(primaryProgressCalls).toHaveLength(1);
    expect(secondaryProgressCalls).toHaveLength(1);
    expect(primaryProgressCalls[0][1]).toEqual(secondaryProgressCalls[0][1]);
  });
});
