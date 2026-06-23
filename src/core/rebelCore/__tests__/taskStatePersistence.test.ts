import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createTaskStore } from '../taskState';
import type { RebelCoreTaskStoreInternal } from '../taskState';

/** Helper to create a mission-owned task via the internal API (public `createTask` doesn't accept `owner`). */
const seedMissionTask = (store: RebelCoreTaskStoreInternal, title: string, notes: string): void => {
  const id = String(store._getNextTaskId());
  const now = Date.now();
  store._setRawTask(id, { id, title, owner: 'mission', status: 'pending', notes, createdAt: now, updatedAt: now });
  store._setNextTaskId(store._getNextTaskId() + 1);
};

// ---------------------------------------------------------------------------
// Mocks — must be declared before imports that use them
// ---------------------------------------------------------------------------

const mockReadFile = vi.fn();
const mockWriteFile = vi.fn();
const mockMkdir = vi.fn();
const mockRename = vi.fn();
const loggerMocks = vi.hoisted(() => ({
  info: vi.fn(),
  warn: vi.fn(),
  debug: vi.fn(),
  error: vi.fn(),
  trace: vi.fn(),
  fatal: vi.fn(),
}));

vi.mock('node:fs/promises', () => ({
  default: {
    readFile: (...args: unknown[]) => mockReadFile(...args),
    writeFile: (...args: unknown[]) => mockWriteFile(...args),
    mkdir: (...args: unknown[]) => mockMkdir(...args),
    rename: (...args: unknown[]) => mockRename(...args),
  },
}));

vi.mock('@core/utils/dataPaths', () => ({
  getDataPath: () => '/tmp/test-data',
}));

vi.mock('@core/logger', () => ({
  createScopedLogger: () => ({
    info: loggerMocks.info,
    warn: loggerMocks.warn,
    debug: loggerMocks.debug,
    error: loggerMocks.error,
    trace: loggerMocks.trace,
    fatal: loggerMocks.fatal,
  }),
}));

// Import under test — AFTER all vi.mock calls
import { loadTaskBoard, saveTaskBoard } from '../taskStatePersistence';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a minimal v1 persisted task board. */
function makeV1Data(tasks: Record<string, unknown>[], nextTaskId: number) {
  return {
    version: 1,
    lastUpdated: Date.now(),
    state: { tasks, nextTaskId },
  };
}

/** Build a minimal v2 persisted task board. */
function makeV2Data(
  state: {
    tasks: Record<string, unknown>[];
    nextTaskId: number;
    archivedTurns?: unknown;
    nextTurnNumber?: number;
  },
) {
  return {
    version: 2,
    lastUpdated: Date.now(),
    state,
  };
}

/** Minimal task fixture. */
function makeTask(id: string, title: string, status = 'completed') {
  return { id, title, status, createdAt: 1000, updatedAt: 2000 };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('taskStatePersistence', () => {
  let store: RebelCoreTaskStoreInternal;

  beforeEach(() => {
    vi.clearAllMocks();
    store = createTaskStore();
    mockMkdir.mockResolvedValue(undefined);
    mockWriteFile.mockResolvedValue(undefined);
    mockRename.mockResolvedValue(undefined);
  });

  // -------------------------------------------------------------------------
  // loadTaskBoard
  // -------------------------------------------------------------------------

  describe('loadTaskBoard — missing file', () => {
    it('returns false when file does not exist (first turn)', async () => {
      const error = new Error('ENOENT') as NodeJS.ErrnoException;
      error.code = 'ENOENT';
      mockReadFile.mockRejectedValue(error);

      const result = await loadTaskBoard('session-1', store);

      expect(result.loaded).toBe(false);
      expect(store.listTasks()).toHaveLength(0);
      expect(store.getArchivedTurns()).toHaveLength(0);
    });
  });

  describe('loadTaskBoard — v1 migration', () => {
    it('archives v1 tasks so active store starts clean', async () => {
      const v1 = makeV1Data(
        [makeTask('1', 'Task A'), makeTask('2', 'Task B')],
        3,
      );
      mockReadFile.mockResolvedValue(JSON.stringify(v1));

      const result = await loadTaskBoard('session-1', store);

      expect(result.loaded).toBe(true);
      // Active store is empty after migration
      expect(store.listTasks()).toHaveLength(0);
      // Archive has one turn with the v1 tasks
      const archived = store.getArchivedTurns();
      expect(archived).toHaveLength(1);
      expect(archived[0].tasks).toHaveLength(2);
      expect(archived[0].tasks.map((t) => t.title)).toEqual(['Task A', 'Task B']);
      // nextTaskId preserved — new tasks start after v1's last ID
      expect(store._getNextTaskId()).toBe(3);
    });

    it('returns false for malformed v1 state', async () => {
      const v1 = { version: 1, lastUpdated: Date.now(), state: { invalid: true } };
      mockReadFile.mockResolvedValue(JSON.stringify(v1));

      expect((await loadTaskBoard('session-1', store)).loaded).toBe(false);
      expect(store.listTasks()).toHaveLength(0);
    });
  });

  describe('loadTaskBoard — v2 current version', () => {
    it('loads active tasks and archive from v2 data', async () => {
      const v2 = makeV2Data({
        tasks: [makeTask('3', 'Active Task', 'in_progress')],
        nextTaskId: 4,
        archivedTurns: [
          { turnNumber: 1, tasks: [makeTask('1', 'Archived A'), makeTask('2', 'Archived B')] },
        ],
        nextTurnNumber: 2,
      });
      mockReadFile.mockResolvedValue(JSON.stringify(v2));

      const result = await loadTaskBoard('session-1', store);

      expect(result.loaded).toBe(true);
      expect(store.listTasks()).toHaveLength(1);
      expect(store.listTasks()[0].title).toBe('Active Task');
      const archived = store.getArchivedTurns();
      expect(archived).toHaveLength(1);
      expect(archived[0].tasks).toHaveLength(2);
      expect(store._getNextTaskId()).toBe(4);
    });

    it('returns false for malformed v2 state', async () => {
      const v2 = { version: 2, lastUpdated: Date.now(), state: { invalid: true } };
      mockReadFile.mockResolvedValue(JSON.stringify(v2));

      expect((await loadTaskBoard('session-1', store)).loaded).toBe(false);
    });
  });

  describe('loadTaskBoard — orphaned sub-agent recovery', () => {
    it('marks v2 orphaned in-progress sub-agent tasks as blocked with an interruption note', async () => {
      const v2 = makeV2Data({
        tasks: [
          {
            id: '1',
            title: 'Delegated to researcher',
            owner: 'main/researcher',
            status: 'in_progress',
            createdAt: 1000,
            updatedAt: 2000,
          },
        ],
        nextTaskId: 2,
      });
      mockReadFile.mockResolvedValue(JSON.stringify(v2));

      const result = await loadTaskBoard('session-recovery', store);

      expect(result.loaded).toBe(true);
      expect(result.recoveredCount).toBe(1);
      expect(store.getTask('1')).toMatchObject({
        id: '1',
        status: 'blocked',
        notes: 'Interrupted by restart',
      });

      const recoveryLog = loggerMocks.info.mock.calls.find(
        (call) => call[1] === 'task:recovery:orphans-marked',
      );
      expect(recoveryLog).toBeDefined();
      expect(recoveryLog?.[0]).toMatchObject({
        sessionId: 'session-recovery',
        count: 1,
        taskIds: ['1'],
        namespaces: ['main/researcher'],
        parentTurnIds: [],
      });
    });

    it('does not log or mutate state when no orphaned sub-agent tasks are present', async () => {
      const v2 = makeV2Data({
        tasks: [
          {
            id: '1',
            title: 'Main task',
            owner: 'main',
            status: 'in_progress',
            createdAt: 1000,
            updatedAt: 2000,
          },
          {
            id: '2',
            title: 'Completed delegated task',
            owner: 'main/researcher',
            status: 'completed',
            createdAt: 1001,
            updatedAt: 2001,
          },
        ],
        nextTaskId: 3,
      });
      mockReadFile.mockResolvedValue(JSON.stringify(v2));

      const result = await loadTaskBoard('session-no-recovery', store);

      expect(result.loaded).toBe(true);
      expect(result.recoveredCount).toBe(0);
      expect(store.getTask('1')?.status).toBe('in_progress');
      expect(store.getTask('2')?.status).toBe('completed');
      expect(
        loggerMocks.info.mock.calls.some((call) => call[1] === 'task:recovery:orphans-marked'),
      ).toBe(false);
    });

    it('only recovers non-main in-progress owners in mixed task sets', async () => {
      const v2 = makeV2Data({
        tasks: [
          {
            id: '1',
            title: 'Main in progress',
            owner: 'main',
            status: 'in_progress',
            createdAt: 1000,
            updatedAt: 2000,
          },
          {
            id: '2',
            title: 'Sub-agent in progress',
            owner: 'main/researcher',
            status: 'in_progress',
            createdAt: 1001,
            updatedAt: 2001,
          },
          {
            id: '3',
            title: 'Implicit main owner',
            status: 'in_progress',
            createdAt: 1002,
            updatedAt: 2002,
          },
        ],
        nextTaskId: 4,
      });
      mockReadFile.mockResolvedValue(JSON.stringify(v2));

      const result = await loadTaskBoard('session-mixed-recovery', store);

      expect(result.loaded).toBe(true);
      expect(result.recoveredCount).toBe(1);
      expect(store.getTask('1')?.status).toBe('in_progress');
      expect(store.getTask('2')?.status).toBe('blocked');
      expect(store.getTask('3')?.status).toBe('in_progress');
    });

    it('recovers only owners matching main/<segment> namespace pattern', async () => {
      const v2 = makeV2Data({
        tasks: [
          {
            id: '1',
            title: 'Trailing slash only',
            owner: 'main/',
            status: 'in_progress',
            createdAt: 1000,
            updatedAt: 2000,
          },
          {
            id: '2',
            title: 'Uppercase main prefix',
            owner: 'MAIN/something',
            status: 'in_progress',
            createdAt: 1001,
            updatedAt: 2001,
          },
          {
            id: '3',
            title: 'Mission-owned namespace',
            owner: 'mission/something',
            status: 'in_progress',
            createdAt: 1002,
            updatedAt: 2002,
          },
          {
            id: '4',
            title: 'Single-level sub-agent namespace',
            owner: 'main/sub-agent-1',
            status: 'in_progress',
            createdAt: 1003,
            updatedAt: 2003,
          },
          {
            id: '5',
            title: 'Nested sub-agent namespace',
            owner: 'main/sub-agent-1/turn-X/sub-2',
            status: 'in_progress',
            createdAt: 1004,
            updatedAt: 2004,
          },
        ],
        nextTaskId: 6,
      });
      mockReadFile.mockResolvedValue(JSON.stringify(v2));

      const result = await loadTaskBoard('session-owner-pattern', store);

      expect(result.loaded).toBe(true);
      expect(result.recoveredCount).toBe(2);
      expect(store.getTask('1')?.status).toBe('in_progress');
      expect(store.getTask('2')?.status).toBe('in_progress');
      expect(store.getTask('3')?.status).toBe('in_progress');
      expect(store.getTask('4')?.status).toBe('blocked');
      expect(store.getTask('5')?.status).toBe('blocked');
    });

    it('appends interruption note without clobbering existing notes', async () => {
      const v2 = makeV2Data({
        tasks: [
          {
            id: '1',
            title: 'Delegated task with notes',
            owner: 'main/researcher',
            status: 'in_progress',
            notes: 'Waiting for child result',
            createdAt: 1000,
            updatedAt: 2000,
          },
        ],
        nextTaskId: 2,
      });
      mockReadFile.mockResolvedValue(JSON.stringify(v2));

      const result = await loadTaskBoard('session-append-notes', store);

      expect(result.loaded).toBe(true);
      expect(result.recoveredCount).toBe(1);
      expect(store.getTask('1')?.notes).toBe('Waiting for child result\nInterrupted by restart');
    });

    it('keeps recovery idempotent when interruption note already exists as an exact line', async () => {
      const v2 = makeV2Data({
        tasks: [
          {
            id: '1',
            title: 'Already recovered delegated task',
            owner: 'main/researcher',
            status: 'blocked',
            notes: 'Context preserved\nInterrupted by restart',
            createdAt: 1000,
            updatedAt: 2000,
          },
        ],
        nextTaskId: 2,
      });
      mockReadFile.mockResolvedValue(JSON.stringify(v2));

      const result = await loadTaskBoard('session-idempotent-recovery', store);

      expect(result).toEqual({
        loaded: true,
        recoveredCount: 0,
      });
      expect(store.getTask('1')?.notes).toBe('Context preserved\nInterrupted by restart');
      expect(
        loggerMocks.info.mock.calls.some((call) => call[1] === 'task:recovery:orphans-marked'),
      ).toBe(false);
    });

    it('appends interruption note when existing notes only include substring mention', async () => {
      const v2 = makeV2Data({
        tasks: [
          {
            id: '1',
            title: 'Delegated task with quoted marker',
            owner: 'main/researcher',
            status: 'in_progress',
            notes: 'Need to ask why "Interrupted by restart" appears in copy',
            createdAt: 1000,
            updatedAt: 2000,
          },
        ],
        nextTaskId: 2,
      });
      mockReadFile.mockResolvedValue(JSON.stringify(v2));

      const result = await loadTaskBoard('session-append-notes-substring', store);

      expect(result).toEqual({
        loaded: true,
        recoveredCount: 1,
      });
      expect(store.getTask('1')?.notes).toBe(
        'Need to ask why "Interrupted by restart" appears in copy\nInterrupted by restart',
      );
    });
  });

  describe('loadTaskBoard — future version', () => {
    it('returns false for version 3 without modifying store', async () => {
      const future = {
        version: 3,
        lastUpdated: Date.now(),
        state: {
          tasks: [makeTask('1', 'Future task', 'pending')],
          nextTaskId: 2,
        },
      };
      mockReadFile.mockResolvedValue(JSON.stringify(future));

      const result = await loadTaskBoard('session-1', store);

      expect(result.loaded).toBe(false);
      expect(store.listTasks()).toHaveLength(0);
      expect(store.getArchivedTurns()).toHaveLength(0);
    });

    it('returns false for very high version numbers', async () => {
      const future = {
        version: 99,
        lastUpdated: Date.now(),
        state: { tasks: [], nextTaskId: 1 },
      };
      mockReadFile.mockResolvedValue(JSON.stringify(future));

      expect((await loadTaskBoard('session-1', store)).loaded).toBe(false);
    });
  });

  describe('loadTaskBoard — corrupt file recovery', () => {
    it('returns false for invalid JSON', async () => {
      mockReadFile.mockResolvedValue('not json {{{');

      const result = await loadTaskBoard('session-1', store);

      expect(result.loaded).toBe(false);
      expect(store.listTasks()).toHaveLength(0);
    });

    it('returns false when parsed value is not an object', async () => {
      mockReadFile.mockResolvedValue('"just a string"');

      expect((await loadTaskBoard('session-1', store)).loaded).toBe(false);
    });

    it('returns false for unrecognized version (0)', async () => {
      const data = { version: 0, lastUpdated: Date.now(), state: { tasks: [], nextTaskId: 1 } };
      mockReadFile.mockResolvedValue(JSON.stringify(data));

      expect((await loadTaskBoard('session-1', store)).loaded).toBe(false);
    });

    it('returns false on read errors other than ENOENT', async () => {
      mockReadFile.mockRejectedValue(new Error('EACCES'));

      expect((await loadTaskBoard('session-1', store)).loaded).toBe(false);
    });
  });

  describe('loadTaskBoard — malformed archivedTurns graceful degradation', () => {
    it('discards non-array archivedTurns but keeps active tasks', async () => {
      const v2 = makeV2Data({
        tasks: [makeTask('1', 'Active Task', 'pending')],
        nextTaskId: 2,
        archivedTurns: 'not-an-array' as unknown,
        nextTurnNumber: 1,
      });
      mockReadFile.mockResolvedValue(JSON.stringify(v2));

      const result = await loadTaskBoard('session-1', store);

      expect(result.loaded).toBe(true);
      expect(store.listTasks()).toHaveLength(1);
      expect(store.listTasks()[0].title).toBe('Active Task');
      expect(store.getArchivedTurns()).toHaveLength(0);
    });

    it('discards archivedTurns with malformed entries', async () => {
      const v2 = makeV2Data({
        tasks: [makeTask('1', 'Active Task', 'pending')],
        nextTaskId: 2,
        archivedTurns: [
          { turnNumber: 1, tasks: [makeTask('0', 'Old')] },
          { turnNumber: 'not-a-number', tasks: [] }, // malformed entry
        ],
        nextTurnNumber: 3,
      });
      mockReadFile.mockResolvedValue(JSON.stringify(v2));

      const result = await loadTaskBoard('session-1', store);

      expect(result.loaded).toBe(true);
      expect(store.listTasks()).toHaveLength(1);
      // Entire archive discarded because one entry is malformed
      expect(store.getArchivedTurns()).toHaveLength(0);
    });

    it('discards archivedTurns entries missing tasks array', async () => {
      const v2 = makeV2Data({
        tasks: [makeTask('1', 'Active Task', 'pending')],
        nextTaskId: 2,
        archivedTurns: [{ turnNumber: 1 }], // missing tasks
        nextTurnNumber: 2,
      });
      mockReadFile.mockResolvedValue(JSON.stringify(v2));

      const result = await loadTaskBoard('session-1', store);

      expect(result.loaded).toBe(true);
      expect(store.listTasks()).toHaveLength(1);
      expect(store.getArchivedTurns()).toHaveLength(0);
    });

    it('accepts valid empty archivedTurns array', async () => {
      const v2 = makeV2Data({
        tasks: [makeTask('1', 'Active Task', 'pending')],
        nextTaskId: 2,
        archivedTurns: [],
        nextTurnNumber: 1,
      });
      mockReadFile.mockResolvedValue(JSON.stringify(v2));

      const result = await loadTaskBoard('session-1', store);

      expect(result.loaded).toBe(true);
      expect(store.listTasks()).toHaveLength(1);
      expect(store.getArchivedTurns()).toHaveLength(0);
    });

    it('still recovers orphaned in-progress sub-agent tasks when archivedTurns is malformed', async () => {
      const v2 = makeV2Data({
        tasks: [
          {
            id: '1',
            title: 'Delegated task',
            owner: 'main/researcher',
            status: 'in_progress',
            createdAt: 1000,
            updatedAt: 2000,
          },
        ],
        nextTaskId: 2,
        archivedTurns: 'broken' as unknown,
      });
      mockReadFile.mockResolvedValue(JSON.stringify(v2));

      const result = await loadTaskBoard('session-malformed-archive-recovery', store);

      expect(result).toEqual({
        loaded: true,
        recoveredCount: 1,
      });
      expect(store.getTask('1')).toMatchObject({
        status: 'blocked',
        notes: 'Interrupted by restart',
      });
    });
  });

  // -------------------------------------------------------------------------
  // saveTaskBoard
  // -------------------------------------------------------------------------

  describe('saveTaskBoard — atomic writes', () => {
    it('writes to temp file then renames to final path', async () => {
      store.createTask({ title: 'Test task' });

      await saveTaskBoard('session-1', store);

      // writeFile should target the .tmp path
      expect(mockWriteFile).toHaveBeenCalledOnce();
      const writePath = mockWriteFile.mock.calls[0][0] as string;
      expect(writePath).toMatch(/\.json\.tmp$/);

      // rename should move .tmp → final
      expect(mockRename).toHaveBeenCalledOnce();
      const [srcPath, destPath] = mockRename.mock.calls[0] as [string, string];
      expect(srcPath).toBe(writePath);
      expect(destPath).toBe(writePath.replace(/\.tmp$/, ''));
    });

    it('creates directory lazily before writing', async () => {
      store.createTask({ title: 'Test task' });

      await saveTaskBoard('session-1', store);

      expect(mockMkdir).toHaveBeenCalledOnce();
      expect(mockMkdir).toHaveBeenCalledWith(expect.any(String), { recursive: true });
    });
  });

  describe('saveTaskBoard — serialization', () => {
    it('writes version 2 format with full state including archive', async () => {
      store.createTask({ title: 'Turn 1 Task' });
      store.archiveTurn();
      store.createTask({ title: 'Turn 2 Task' });

      let capturedData = '';
      mockWriteFile.mockImplementation((_path: string, data: string) => {
        capturedData = data;
        return Promise.resolve();
      });

      await saveTaskBoard('session-1', store);

      const parsed = JSON.parse(capturedData);
      expect(parsed.version).toBe(2);
      expect(parsed.lastUpdated).toBeTypeOf('number');
      expect(parsed.state.tasks).toHaveLength(1);
      expect(parsed.state.tasks[0].title).toBe('Turn 2 Task');
      expect(parsed.state.archivedTurns).toHaveLength(1);
      expect(parsed.state.archivedTurns[0].tasks[0].title).toBe('Turn 1 Task');
      expect(parsed.state.nextTurnNumber).toBe(2);
    });

    it('handles empty store (no tasks, no archive)', async () => {
      let capturedData = '';
      mockWriteFile.mockImplementation((_path: string, data: string) => {
        capturedData = data;
        return Promise.resolve();
      });

      await saveTaskBoard('session-1', store);

      const parsed = JSON.parse(capturedData);
      expect(parsed.version).toBe(2);
      expect(parsed.state.tasks).toHaveLength(0);
      expect(parsed.state.archivedTurns).toHaveLength(0);
      expect(parsed.state.nextTaskId).toBe(1);
    });
  });

  // -------------------------------------------------------------------------
  // Round-trip: save → load
  // -------------------------------------------------------------------------

  describe('v2 round-trip', () => {
    it('save then load preserves active tasks and archive', async () => {
      // Build state: 1 archived turn + active tasks
      store.createTask({ title: 'Turn 1 Task A' });
      store.createTask({ title: 'Turn 1 Task B' });
      store.archiveTurn();
      store.createTask({ title: 'Turn 2 Task C' });

      // Capture the serialized data
      let savedData = '';
      mockWriteFile.mockImplementation((_path: string, data: string) => {
        savedData = data;
        return Promise.resolve();
      });
      await saveTaskBoard('session-1', store);

      // Load into a fresh store
      mockReadFile.mockResolvedValue(savedData);
      const freshStore = createTaskStore();
      const result = await loadTaskBoard('session-1', freshStore);

      expect(result.loaded).toBe(true);
      // Active tasks preserved
      expect(freshStore.listTasks()).toHaveLength(1);
      expect(freshStore.listTasks()[0].title).toBe('Turn 2 Task C');
      // Archive preserved
      const archived = freshStore.getArchivedTurns();
      expect(archived).toHaveLength(1);
      expect(archived[0].tasks).toHaveLength(2);
      expect(archived[0].tasks.map((t) => t.title)).toEqual(['Turn 1 Task A', 'Turn 1 Task B']);
      // ID counter preserved
      expect(freshStore._getNextTaskId()).toBe(4);
    });
  });

  // -------------------------------------------------------------------------
  // Archive accumulation across multiple save/load cycles
  // -------------------------------------------------------------------------

  describe('archive accumulation across save/load cycles', () => {
    it('preserves and grows archive across three turns', async () => {
      let savedData = '';
      mockWriteFile.mockImplementation((_path: string, data: string) => {
        savedData = data;
        return Promise.resolve();
      });

      // --- Turn 1 ---
      const store1 = createTaskStore();
      store1.createTask({ title: 'T1-A' });
      store1.createTask({ title: 'T1-B' });
      await saveTaskBoard('session-1', store1);

      // --- Turn 2 ---
      // Load turn 1 state, archive it, create new tasks
      mockReadFile.mockResolvedValue(savedData);
      const store2 = createTaskStore();
      await loadTaskBoard('session-1', store2);
      // The lifecycle (Stage 3) would call archiveTurn() after loading
      store2.archiveTurn();
      store2.createTask({ title: 'T2-C' });
      await saveTaskBoard('session-1', store2);

      // --- Turn 3 ---
      mockReadFile.mockResolvedValue(savedData);
      const store3 = createTaskStore();
      await loadTaskBoard('session-1', store3);
      store3.archiveTurn();
      store3.createTask({ title: 'T3-D' });

      // Verify accumulation: 2 archived turns + 1 active task
      const archived = store3.getArchivedTurns();
      expect(archived).toHaveLength(2);
      expect(store3.listTasks()).toHaveLength(1);
      expect(store3.listTasks()[0].title).toBe('T3-D');

      // IDs remain monotonic across all turns
      const allArchivedIds = archived.flatMap((t) => t.tasks.map((task) => Number(task.id)));
      const activeIds = store3.listTasks().map((t) => Number(t.id));
      const allIds = [...allArchivedIds, ...activeIds];
      const uniqueIds = new Set(allIds);
      expect(uniqueIds.size).toBe(allIds.length); // no duplicates

      // Save and verify final persisted data
      await saveTaskBoard('session-1', store3);
      const finalParsed = JSON.parse(savedData);
      expect(finalParsed.state.archivedTurns).toHaveLength(2);
      expect(finalParsed.state.tasks).toHaveLength(1);
      expect(finalParsed.version).toBe(2);
    });
  });

  // -------------------------------------------------------------------------
  // Turn lifecycle integration (mirrors rebelCoreQuery flow)
  // -------------------------------------------------------------------------

  describe('turn lifecycle integration — load → archive → seed → save round-trip', () => {
    it('simulates full multi-turn lifecycle with archive accumulation', async () => {
      let savedData = '';
      mockWriteFile.mockImplementation((_path: string, data: string) => {
        savedData = data;
        return Promise.resolve();
      });

      // === Turn 1: fresh session (no persisted file) ===
      const enoent = new Error('ENOENT') as NodeJS.ErrnoException;
      enoent.code = 'ENOENT';
      mockReadFile.mockRejectedValueOnce(enoent);

      const turn1Store = createTaskStore();
      await loadTaskBoard('session-lifecycle', turn1Store);

      // Archive after load — no-op on first turn (empty store)
      const priorCount1 = turn1Store.listTasks().length;
      turn1Store.archiveTurn();
      expect(priorCount1).toBe(0);
      expect(turn1Store.listTasks()).toHaveLength(0);
      expect(turn1Store.getArchivedTurns()).toHaveLength(0);

      // Seed mission + tasks (simulates planning phase)
      seedMissionTask(turn1Store, 'Mission: Research competitors', 'goal');
      turn1Store.createTask({ title: 'Gather market data' });
      turn1Store.createTask({ title: 'Analyze pricing' });
      expect(turn1Store.listTasks()).toHaveLength(3);

      // Save at turn end
      await saveTaskBoard('session-lifecycle', turn1Store);

      // === Turn 2: loads turn 1, archives, seeds fresh ===
      mockReadFile.mockResolvedValueOnce(savedData);
      const turn2Store = createTaskStore();
      const loaded2 = await loadTaskBoard('session-lifecycle', turn2Store);
      expect(loaded2.loaded).toBe(true);
      expect(turn2Store.listTasks()).toHaveLength(3); // turn 1 tasks loaded

      // Archive — this is the key lifecycle step from rebelCoreQuery
      const priorCount2 = turn2Store.listTasks().length;
      turn2Store.archiveTurn();
      expect(priorCount2).toBe(3);

      // Active store is now clean
      expect(turn2Store.listTasks()).toHaveLength(0);
      // Archive has turn 1
      expect(turn2Store.getArchivedTurns()).toHaveLength(1);
      expect(turn2Store.getArchivedTurns()[0].tasks).toHaveLength(3);

      // hasMissionGoalTask equivalent — clean store means no mission found
      const hasMission = turn2Store.listTasks().some(
        (t) => t.owner === 'mission' && t.notes === 'goal',
      );
      expect(hasMission).toBe(false); // seedTaskStoreFromPlan will run

      // Seed new turn's tasks (fresh planning)
      seedMissionTask(turn2Store, 'Mission: Draft proposal', 'goal');
      turn2Store.createTask({ title: 'Write executive summary' });

      // Verify nextTaskId continuity — IDs continue from turn 1
      const turn2Tasks = turn2Store.listTasks();
      const turn2Ids = turn2Tasks.map((t) => Number(t.id));
      expect(Math.min(...turn2Ids)).toBeGreaterThan(3); // greater than turn 1's max ID

      // Save turn 2
      await saveTaskBoard('session-lifecycle', turn2Store);

      // === Turn 3: verify accumulation across 3 turns ===
      mockReadFile.mockResolvedValueOnce(savedData);
      const turn3Store = createTaskStore();
      await loadTaskBoard('session-lifecycle', turn3Store);

      // Archive turn 2's tasks
      turn3Store.archiveTurn();

      // Active store clean
      expect(turn3Store.listTasks()).toHaveLength(0);

      // Archive now has 2 turns (most recent first from getArchivedTurns)
      const allArchived = turn3Store.getArchivedTurns();
      expect(allArchived).toHaveLength(2);

      // Turn numbers are sequential
      const turnNumbers = allArchived.map((t) => t.turnNumber).sort((a, b) => a - b);
      expect(turnNumbers[0]).toBeLessThan(turnNumbers[1]);

      // Total archived task count matches turns 1 + 2
      const totalArchivedTasks = allArchived.reduce((sum, t) => sum + t.tasks.length, 0);
      expect(totalArchivedTasks).toBe(5); // 3 from turn 1 + 2 from turn 2

      // Seed turn 3 fresh
      seedMissionTask(turn3Store, 'Mission: Review feedback', 'goal');
      turn3Store.createTask({ title: 'Compile responses' });
      turn3Store.createTask({ title: 'Prioritize action items' });
      turn3Store.createTask({ title: 'Update roadmap' });

      // All IDs unique across all turns
      const archivedIds = allArchived.flatMap((t) => t.tasks.map((task) => Number(task.id)));
      const activeIds = turn3Store.listTasks().map((t) => Number(t.id));
      const allIds = [...archivedIds, ...activeIds];
      expect(new Set(allIds).size).toBe(allIds.length); // no duplicates

      // Save and reload to verify full round-trip
      await saveTaskBoard('session-lifecycle', turn3Store);
      mockReadFile.mockResolvedValueOnce(savedData);
      const verifyStore = createTaskStore();
      await loadTaskBoard('session-lifecycle', verifyStore);

      expect(verifyStore.listTasks()).toHaveLength(4); // turn 3's active tasks
      expect(verifyStore.getArchivedTurns()).toHaveLength(2); // turns 1 & 2
      expect(verifyStore._getNextTaskId()).toBeGreaterThanOrEqual(10); // 3+2+4=9 tasks minimum
    });

    it('verifies buildSyntheticPlanSeedMessages sees only current-turn tasks after archive', async () => {
      let savedData = '';
      mockWriteFile.mockImplementation((_path: string, data: string) => {
        savedData = data;
        return Promise.resolve();
      });

      // Turn 1: create some tasks
      const turn1Store = createTaskStore();
      seedMissionTask(turn1Store, 'Old mission', 'goal');
      turn1Store.createTask({ title: 'Old task A' });
      turn1Store.createTask({ title: 'Old task B' });
      await saveTaskBoard('session-synth', turn1Store);

      // Turn 2: load → archive → seed fresh
      mockReadFile.mockResolvedValueOnce(savedData);
      const turn2Store = createTaskStore();
      await loadTaskBoard('session-synth', turn2Store);
      turn2Store.archiveTurn();

      // Seed new turn — simulates seedTaskStoreFromPlan
      seedMissionTask(turn2Store, 'New mission', 'goal');
      turn2Store.createTask({ title: 'New task X' });

      // listTasks() returns only current-turn tasks (what buildSyntheticPlanSeedMessages uses)
      const currentTasks = turn2Store.listTasks();
      expect(currentTasks).toHaveLength(2);
      expect(currentTasks.every((t) => t.title.startsWith('New'))).toBe(true);

      // Old tasks are only in archive
      const archived = turn2Store.getArchivedTurns();
      expect(archived).toHaveLength(1);
      expect(archived[0].tasks.every((t) => t.title.startsWith('Old'))).toBe(true);
    });
  });
});
