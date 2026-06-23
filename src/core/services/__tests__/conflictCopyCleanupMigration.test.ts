import { beforeEach, describe, expect, it, vi } from 'vitest';

type StoreState = {
  surfaced: boolean;
  surfacedAt: number | null;
  lastDetectRunId: string | null;
  completed: boolean;
  completedAt: number | null;
};

const defaults = (): StoreState => ({
  surfaced: false,
  surfacedAt: null,
  lastDetectRunId: null,
  completed: false,
  completedAt: null,
});

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
      storeState = defaults();
    },
    get store() {
      return storeState;
    },
    set store(value: StoreState) {
      storeState = value;
    },
    path: '/tmp/test-conflict-copy-cleanup-migration.json',
  })),
}));

const {
  isConflictCleanupSurfaced,
  isConflictCleanupCompleted,
  markConflictCleanupSurfaced,
  markConflictCleanupCompleted,
  getLastConflictCleanupRunId,
  resetConflictCopyCleanupStateForTests,
} = await import('../conflictCopyCleanupMigration');

describe('conflictCopyCleanupMigration marker', () => {
  beforeEach(() => {
    storeState = defaults();
    resetConflictCopyCleanupStateForTests();
  });

  it('defaults to not surfaced and not completed', () => {
    expect(isConflictCleanupSurfaced()).toBe(false);
    expect(isConflictCleanupCompleted()).toBe(false);
    expect(getLastConflictCleanupRunId()).toBeNull();
  });

  it('marks surfaced once and records the runId', () => {
    markConflictCleanupSurfaced('run-1', 1000);
    expect(isConflictCleanupSurfaced()).toBe(true);
    expect(getLastConflictCleanupRunId()).toBe('run-1');
    // surfacing does NOT imply completion (detection keeps running)
    expect(isConflictCleanupCompleted()).toBe(false);
  });

  it('marks completed independently of surfaced', () => {
    markConflictCleanupCompleted(2000);
    expect(isConflictCleanupCompleted()).toBe(true);
  });
});
