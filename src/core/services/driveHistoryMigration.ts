import fs from 'node:fs/promises';
import path from 'node:path';
import { createStore } from '@core/storeFactory';
import type { KeyValueStore } from '@core/store';
import { createScopedLogger } from '@core/logger';

const log = createScopedLogger({ service: 'driveHistoryMigration' });

type MigrationStoreState = {
  completed: boolean;
  completedAt: number | null;
  lastRunAt: number | null;
};

const createDefaultState = (): MigrationStoreState => ({
  completed: false,
  completedAt: null,
  lastRunAt: null,
});

let _store: KeyValueStore<MigrationStoreState> | null = null;

function getStore(): KeyValueStore<MigrationStoreState> {
  if (!_store) {
    _store = createStore<MigrationStoreState>({
      name: 'drive-history-migration',
      defaults: createDefaultState(),
    });
  }
  return _store;
}

export interface DriveHistoryMigrationDeps {
  listSharedSpaceRoots: (coreDirectory: string) => Promise<string[]>;
  moveToTrash: (absolutePath: string) => Promise<void>;
  emitTelemetry?: (event: string, properties: Record<string, string | number | boolean | null>) => void;
}

export interface DriveHistoryMigrationResult {
  attempted: boolean;
  skippedBecauseAlreadyCompleted: boolean;
  scannedSpaces: number;
  foundHistoryDirs: number;
  trashedHistoryDirs: number;
  errors: Array<{ path: string; error: string }>;
}

export interface DriveHistoryMigrationOptions {
  signal?: AbortSignal;
}

async function existsDirectory(targetPath: string): Promise<boolean> {
  try {
    const stat = await fs.stat(targetPath);
    return stat.isDirectory();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return false;
    }
    throw error;
  }
}

function markCompleted(now: number): void {
  const store = getStore();
  store.set('completed', true);
  store.set('completedAt', now);
  store.set('lastRunAt', now);
}

function markIncompleteRun(now: number): void {
  const store = getStore();
  store.set('completed', false);
  store.set('lastRunAt', now);
}

export function resetDriveHistoryMigrationStateForTests(): void {
  _store = null;
}

export async function runDriveHistoryMigration(
  coreDirectory: string,
  deps: DriveHistoryMigrationDeps,
  options: DriveHistoryMigrationOptions = {},
): Promise<DriveHistoryMigrationResult> {
  const signal = options.signal;
  const store = getStore();
  if (store.get('completed')) {
    return {
      attempted: false,
      skippedBecauseAlreadyCompleted: true,
      scannedSpaces: 0,
      foundHistoryDirs: 0,
      trashedHistoryDirs: 0,
      errors: [],
    };
  }

  let aborted = false;
  let candidateSpaceRoots: string[] = [];
  if (signal?.aborted) {
    aborted = true;
  } else {
    candidateSpaceRoots = await deps.listSharedSpaceRoots(coreDirectory);
    if (signal?.aborted) {
      aborted = true;
    }
  }

  let foundHistoryDirs = 0;
  let trashedHistoryDirs = 0;
  const errors: Array<{ path: string; error: string }> = [];

  for (const spaceRoot of candidateSpaceRoots) {
    if (signal?.aborted) {
      aborted = true;
      break;
    }
    const historyPath = path.join(spaceRoot, '.rebel', 'history');
    try {
      if (signal?.aborted) {
        aborted = true;
        break;
      }
      const exists = await existsDirectory(historyPath);
      if (signal?.aborted) {
        aborted = true;
        break;
      }
      if (!exists) {
        continue;
      }
      if (signal?.aborted) {
        aborted = true;
        break;
      }
      foundHistoryDirs += 1;
      await deps.moveToTrash(historyPath);
      trashedHistoryDirs += 1;
      if (signal?.aborted) {
        aborted = true;
        break;
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      errors.push({ path: historyPath, error: message });
      log.warn({ err: error, historyPath }, 'Failed to trash legacy drive history directory');
    }
  }

  const finishedAt = Date.now();
  const completed = !aborted && errors.length === 0;
  if (completed) {
    markCompleted(finishedAt);
  } else {
    // Leave marker incomplete so startup retries migration on next launch.
    markIncompleteRun(finishedAt);
  }

  deps.emitTelemetry?.('drive_history_migration_run', {
    scanned_space_count: candidateSpaceRoots.length,
    found_history_dir_count: foundHistoryDirs,
    trashed_history_dir_count: trashedHistoryDirs,
    error_count: errors.length,
    completed,
  });

  if (aborted) {
    log.info(
      { candidateSpaces: candidateSpaceRoots.length, foundHistoryDirs, trashedHistoryDirs },
      'Drive history migration aborted before completion',
    );
  } else if (errors.length > 0) {
    log.warn({ errors: errors.slice(0, 5) }, 'Drive history migration completed with partial failures');
  } else {
    log.info(
      { candidateSpaces: candidateSpaceRoots.length, foundHistoryDirs, trashedHistoryDirs },
      'Drive history migration completed',
    );
  }

  return {
    attempted: true,
    skippedBecauseAlreadyCompleted: false,
    scannedSpaces: candidateSpaceRoots.length,
    foundHistoryDirs,
    trashedHistoryDirs,
    errors,
  };
}
