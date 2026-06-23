import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';

type StoreState = {
  completed: boolean;
  completedAt: number | null;
  lastRunAt: number | null;
};

let storeState: StoreState;

vi.mock('@core/storeFactory', () => ({
  createStore: vi.fn(() => ({
    get: (key: keyof StoreState) => storeState[key],
    set: (key: keyof StoreState, value: StoreState[keyof StoreState]) => {
      storeState[key] = value as never;
    },
    has: (key: keyof StoreState) => key in storeState,
    delete: (key: keyof StoreState) => {
      delete (storeState as Partial<StoreState>)[key];
    },
    clear: () => {
      storeState = { completed: false, completedAt: null, lastRunAt: null };
    },
    get store() {
      return storeState;
    },
    set store(value: StoreState) {
      storeState = value;
    },
    path: '/tmp/test-drive-history-migration.json',
  })),
}));

const {
  runDriveHistoryMigration,
  resetDriveHistoryMigrationStateForTests,
} = await import('../driveHistoryMigration');

describe('runDriveHistoryMigration', () => {
  let workspaceDir: string;

  beforeEach(async () => {
    storeState = { completed: false, completedAt: null, lastRunAt: null };
    resetDriveHistoryMigrationStateForTests();
    workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), 'drive-history-migration-'));
  });

  afterEach(async () => {
    await fs.rm(workspaceDir, { recursive: true, force: true });
  });

  it('trashes .rebel/history directories for shared spaces and marks migration complete', async () => {
    const sharedA = path.join(workspaceDir, 'shared-a');
    const sharedB = path.join(workspaceDir, 'shared-b');
    const historyA = path.join(sharedA, '.rebel', 'history');
    await fs.mkdir(historyA, { recursive: true });
    await fs.mkdir(sharedB, { recursive: true });

    const moveToTrash = vi.fn(async () => undefined);
    const result = await runDriveHistoryMigration(workspaceDir, {
      listSharedSpaceRoots: async () => [sharedA, sharedB],
      moveToTrash,
    });

    expect(result.attempted).toBe(true);
    expect(result.foundHistoryDirs).toBe(1);
    expect(result.trashedHistoryDirs).toBe(1);
    expect(result.errors).toEqual([]);
    expect(moveToTrash).toHaveBeenCalledWith(historyA);
    expect(storeState.completed).toBe(true);
    expect(storeState.completedAt).toEqual(expect.any(Number));
  });

  it('is idempotent after completion marker is written', async () => {
    const shared = path.join(workspaceDir, 'shared');
    const history = path.join(shared, '.rebel', 'history');
    await fs.mkdir(history, { recursive: true });

    const moveToTrash = vi.fn(async () => undefined);
    await runDriveHistoryMigration(workspaceDir, {
      listSharedSpaceRoots: async () => [shared],
      moveToTrash,
    });

    const second = await runDriveHistoryMigration(workspaceDir, {
      listSharedSpaceRoots: async () => [shared],
      moveToTrash,
    });

    expect(second.attempted).toBe(false);
    expect(second.skippedBecauseAlreadyCompleted).toBe(true);
    expect(moveToTrash).toHaveBeenCalledTimes(1);
  });

  it('emits telemetry counters for the migration run', async () => {
    const shared = path.join(workspaceDir, 'shared');
    const history = path.join(shared, '.rebel', 'history');
    await fs.mkdir(history, { recursive: true });

    const emitTelemetry = vi.fn();
    await runDriveHistoryMigration(workspaceDir, {
      listSharedSpaceRoots: async () => [shared],
      moveToTrash: async () => undefined,
      emitTelemetry,
    });

    expect(emitTelemetry).toHaveBeenCalledWith(
      'drive_history_migration_run',
      expect.objectContaining({
        scanned_space_count: 1,
        found_history_dir_count: 1,
        trashed_history_dir_count: 1,
        error_count: 0,
        completed: true,
      }),
    );
  });

  it('does not mark complete when trashing fails and retries on next run', async () => {
    const shared = path.join(workspaceDir, 'shared');
    const history = path.join(shared, '.rebel', 'history');
    await fs.mkdir(history, { recursive: true });

    const moveToTrash = vi
      .fn<(_: string) => Promise<void>>()
      .mockRejectedValueOnce(new Error('permission denied'))
      .mockResolvedValueOnce(undefined);

    const first = await runDriveHistoryMigration(workspaceDir, {
      listSharedSpaceRoots: async () => [shared],
      moveToTrash,
    });

    expect(first.attempted).toBe(true);
    expect(first.errors).toHaveLength(1);
    expect(storeState.completed).toBe(false);
    expect(storeState.completedAt).toBeNull();

    const second = await runDriveHistoryMigration(workspaceDir, {
      listSharedSpaceRoots: async () => [shared],
      moveToTrash,
    });

    expect(second.attempted).toBe(true);
    expect(second.errors).toEqual([]);
    expect(storeState.completed).toBe(true);
    expect(storeState.completedAt).toEqual(expect.any(Number));
    expect(moveToTrash).toHaveBeenCalledTimes(2);
  });
});
