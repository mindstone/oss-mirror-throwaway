import { beforeEach, describe, expect, it, vi } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import type { MemoryUpdateStatus } from '@shared/types';
import type { SpaceInfo as SpaceServiceInfo } from '../spaceService';

const { storeState, scanSpacesMock, logInfoMock, logWarnMock } = vi.hoisted(() => ({
  storeState: { value: undefined as Record<string, unknown> | undefined },
  scanSpacesMock: vi.fn(),
  logInfoMock: vi.fn(),
  logWarnMock: vi.fn(),
}));

vi.mock('@core/storeFactory', () => ({
  createStore: ({ defaults }: { defaults: Record<string, unknown> }) => {
    if (!storeState.value) {
      storeState.value = JSON.parse(JSON.stringify(defaults));
    }

    return {
      get store() {
        return storeState.value ?? (storeState.value = JSON.parse(JSON.stringify(defaults)));
      },
      set store(next: Record<string, unknown>) {
        storeState.value = next;
      },
    };
  },
}));

vi.mock('@core/logger', () => ({
  createScopedLogger: () => ({
    info: (...args: unknown[]) => logInfoMock(...args),
    debug: vi.fn(),
    warn: (...args: unknown[]) => logWarnMock(...args),
    error: vi.fn(),
  }),
  logger: {
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock('../spaceService', () => ({
  scanSpaces: (...args: unknown[]) => scanSpacesMock(...args),
}));

let memoryHistoryStore: typeof import('../memoryHistoryStore');

const CHIEF_OF_STAFF_SPACE: SpaceServiceInfo = {
  name: 'Chief-of-Staff',
  displayName: 'Chief of Staff',
  path: 'chief-of-staff',
  absolutePath: '/workspace/chief-of-staff',
  type: 'chief-of-staff',
  isSymlink: false,
  hasReadme: true,
};

function buildStatus(filePath: string): MemoryUpdateStatus {
  return {
    originalTurnId: 'turn-1',
    status: 'success',
    timestamp: Date.now(),
    entityUpdates: [
      {
        entity: 'Chief of Staff',
        visibility: 'private',
        action: 'created',
        summary: 'Remember this forever.',
        filePath,
      },
    ],
  };
}

function buildLegacyEntry(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'memory-entry',
    timestamp: 1_000,
    sessionId: 'session-1',
    turnId: 'turn-1',
    entity: 'Known Space',
    visibility: 'shared',
    action: 'updated',
    summary: 'Known summary.',
    filePath: 'memory/topics/known.md',
    ...overrides,
  };
}

describe('memoryHistoryStore path normalization', () => {
  beforeEach(async () => {
    vi.resetModules();
    storeState.value = undefined;
    scanSpacesMock.mockReset();
    logInfoMock.mockReset();
    logWarnMock.mockReset();
    memoryHistoryStore = await import('../memoryHistoryStore');
    memoryHistoryStore.clearSpacesCache();
  });

  it('normalizeWriteFilePath prefixes bare memory paths using matching entity space', () => {
    const normalized = memoryHistoryStore.normalizeWriteFilePath(
      'memory/topics/partnerships.md',
      'Chief of Staff',
      '/workspace',
      [CHIEF_OF_STAFF_SPACE],
    );

    expect(normalized).toBe('chief-of-staff/memory/topics/partnerships.md');
  });

  it('normalizeWriteFilePath leaves already-prefixed paths unchanged and normalizes absolutes', () => {
    const alreadyPrefixed = memoryHistoryStore.normalizeWriteFilePath(
      'chief-of-staff/memory/topics/partnerships.md',
      'Chief of Staff',
      '/workspace',
      [CHIEF_OF_STAFF_SPACE],
    );
    expect(alreadyPrefixed).toBe('chief-of-staff/memory/topics/partnerships.md');

    const absolutePath = memoryHistoryStore.normalizeWriteFilePath(
      '/workspace/memory/topics/partnerships.md',
      'Chief of Staff',
      '/workspace',
      [CHIEF_OF_STAFF_SPACE],
    );
    expect(absolutePath).toBe('chief-of-staff/memory/topics/partnerships.md');
  });

  it('addMemoryHistoryEntries normalizes incoming file paths when workspace path is provided', async () => {
    scanSpacesMock.mockResolvedValue([CHIEF_OF_STAFF_SPACE]);

    await memoryHistoryStore.addMemoryHistoryEntries(
      buildStatus('memory/topics/partnerships.md'),
      'session-1',
      'Source Capture',
      '/workspace',
    );

    const { entries } = memoryHistoryStore.getMemoryHistory({ limit: 10 });
    expect(entries[0]?.filePath).toBe('chief-of-staff/memory/topics/partnerships.md');

    const normalizationLog = logInfoMock.mock.calls.find(([payload]) => (
      typeof payload === 'object'
      && payload !== null
      && 'event' in (payload as Record<string, unknown>)
      && (payload as Record<string, unknown>).event === 'MEMORY_HISTORY_PATH_NORMALIZED'
    ));
    expect(normalizationLog).toBeDefined();
  });

  it('repairMemoryHistoryEntryPath updates entries by id and is idempotent', async () => {
    scanSpacesMock.mockResolvedValue([CHIEF_OF_STAFF_SPACE]);
    await memoryHistoryStore.addMemoryHistoryEntries(
      buildStatus('memory/topics/partnerships.md'),
      'session-1',
      'Source Capture',
      '/workspace',
    );

    const { entries } = memoryHistoryStore.getMemoryHistory({ limit: 10 });
    const entryId = entries[0]?.id;
    expect(entryId).toBeDefined();

    const firstResult = memoryHistoryStore.repairMemoryHistoryEntryPath(
      entryId ?? '',
      'chief-of-staff/memory/topics/partnerships.md',
    );
    const secondResult = memoryHistoryStore.repairMemoryHistoryEntryPath(
      entryId ?? '',
      'chief-of-staff/memory/topics/partnerships.md',
    );

    expect(firstResult).toBe(true);
    expect(secondResult).toBe(true);
    const updatedEntry = memoryHistoryStore.getMemoryHistory({ limit: 10 }).entries[0];
    expect(updatedEntry?.filePath).toBe('chief-of-staff/memory/topics/partnerships.md');
  });

  it('repairStaleFilePathsIfNeeded migrates stale memory/ entries once per space snapshot', async () => {
    const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), 'memory-history-repair-'));
    try {
      const repairedRelativePath = 'chief-of-staff/memory/topics/partnerships.md';
      const repairedAbsolutePath = path.join(workspaceRoot, repairedRelativePath);
      await mkdir(path.dirname(repairedAbsolutePath), { recursive: true });
      await writeFile(repairedAbsolutePath, '# Partnerships\n', 'utf-8');

      const scopedSpace = {
        ...CHIEF_OF_STAFF_SPACE,
        absolutePath: path.join(workspaceRoot, 'chief-of-staff'),
      };
      scanSpacesMock.mockResolvedValue([scopedSpace]);

      await memoryHistoryStore.addMemoryHistoryEntries(
        buildStatus('memory/topics/partnerships.md'),
        'session-1',
        'Source Capture',
      );

      const firstRepair = await memoryHistoryStore.repairStaleFilePathsIfNeeded(workspaceRoot);
      expect(firstRepair).toMatchObject({
        repaired: 1,
        totalScanned: 1,
        skipped: false,
      });
      expect(memoryHistoryStore.getMemoryHistory({ limit: 10 }).entries[0]?.filePath).toBe(repairedRelativePath);

      const secondRepair = await memoryHistoryStore.repairStaleFilePathsIfNeeded(workspaceRoot);
      expect(secondRepair).toEqual({
        repaired: 0,
        totalScanned: 0,
        skipped: true,
      });
    } finally {
      await rm(workspaceRoot, { recursive: true, force: true });
    }
  });

  it('normalizes malformed legacy entity and summary fields at the read boundary', () => {
    const missingEntity = buildLegacyEntry({
      id: 'missing-entity',
      timestamp: 4_000,
      summary: 'Existing summary.',
    });
    delete missingEntity.entity;

    const blankEntity = buildLegacyEntry({
      id: 'blank-entity',
      timestamp: 3_000,
      entity: '   ',
    });

    const missingSummary = buildLegacyEntry({
      id: 'missing-summary',
      timestamp: 2_000,
      entity: 'Research',
    });
    delete missingSummary.summary;

    const blankSummary = buildLegacyEntry({
      id: 'blank-summary',
      timestamp: 1_000,
      entity: 'Sales',
      summary: '',
    });

    const validEntry = buildLegacyEntry({
      id: 'valid-entry',
      timestamp: 500,
      entity: 'Product',
      summary: 'Roadmap note.',
    });

    storeState.value = {
      version: 1,
      entries: [missingEntity, blankEntity, missingSummary, blankSummary, validEntry],
      lastPruned: 0,
      backfillCompleted: false,
    };

    const { entries } = memoryHistoryStore.getMemoryHistory({ limit: 10 });
    const byId = new Map(entries.map((entry) => [entry.id, entry]));

    expect(byId.get('missing-entity')).toMatchObject({
      entity: 'Memory',
      summary: 'Existing summary.',
    });
    expect(byId.get('blank-entity')?.entity).toBe('Memory');
    expect(byId.get('missing-summary')?.summary).toBe('Memory entry');
    expect(byId.get('blank-summary')?.summary).toBe('Memory entry');
    expect(byId.get('valid-entry')).toMatchObject({
      entity: 'Product',
      summary: 'Roadmap note.',
    });
    expect(entries.every((entry) => typeof entry.entity === 'string' && entry.entity.trim().length > 0)).toBe(true);
    expect(entries.every((entry) => typeof entry.summary === 'string' && entry.summary.trim().length > 0)).toBe(true);

    const singleEntry = memoryHistoryStore.getMemoryHistoryEntry('missing-summary');
    expect(singleEntry?.summary).toBe('Memory entry');

    const normalizationLog = logWarnMock.mock.calls.find(([payload]) => (
      typeof payload === 'object'
      && payload !== null
      && (payload as Record<string, unknown>).event === 'MEMORY_HISTORY_LEGACY_ENTRIES_NORMALIZED'
    ));
    expect(normalizationLog).toBeDefined();
    expect(normalizationLog?.[0]).toMatchObject({
      event: 'MEMORY_HISTORY_LEGACY_ENTRIES_NORMALIZED',
      normalizedCount: 4,
      entityDefaultedCount: 2,
      summaryDefaultedCount: 2,
      totalEntries: 5,
      persisted: true,
    });
    expect(normalizationLog?.[1]).toBe('Normalized malformed legacy memory history entries');

    logWarnMock.mockClear();
    memoryHistoryStore.getMemoryHistory({ limit: 10 });
    const repeatedNormalizationLog = logWarnMock.mock.calls.find(([payload]) => (
      typeof payload === 'object'
      && payload !== null
      && (payload as Record<string, unknown>).event === 'MEMORY_HISTORY_LEGACY_ENTRIES_NORMALIZED'
    ));
    expect(repeatedNormalizationLog).toBeUndefined();
  });

  it('does not try to normalize incompatible future-version store shapes', () => {
    const futureState = {
      version: 999,
      entries: { changed: 'shape' },
      lastPruned: 0,
      backfillCompleted: false,
    };
    storeState.value = futureState;

    expect(() => memoryHistoryStore.isBackfillCompleted()).not.toThrow();
    expect(storeState.value).toBe(futureState);

    const normalizationLog = logWarnMock.mock.calls.find(([payload]) => (
      typeof payload === 'object'
      && payload !== null
      && (payload as Record<string, unknown>).event === 'MEMORY_HISTORY_LEGACY_ENTRIES_NORMALIZED'
    ));
    expect(normalizationLog).toBeUndefined();
  });
});
