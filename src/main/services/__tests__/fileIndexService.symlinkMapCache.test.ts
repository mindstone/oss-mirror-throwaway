import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

// Stage 2 (260529_perf-idle-fs-walk): the per-workspace symlink registry is
// built ONCE at index init and reused across every per-file path conversion on
// the hot path, instead of being rebuilt per call (the idle-CPU hotspot for the
// symlink-backed Google-Drive files). These tests pin that contract:
//
//   1. `buildSymlinkMap` is called exactly once per workspace init.
//   2. Indexing N files does NOT rebuild the map N times (the cached map is
//      reused).
//   3. The cached map is threaded as the 3rd arg into `tryConvertToWorkspacePath`.
//   4. Switching workspaces rebuilds the map for the new workspace.
//
// Harness (mkdtemp temp DB + deterministic embeddings) mirrors
// `fileIndexService.indexFile.test.ts`. `systemUtils` is mocked so we can observe
// the args `tryConvertToWorkspacePath` is called with; `@core/utils/symlinkMap`
// is mocked so we can count `buildSymlinkMap` invocations and inject a sentinel
// map object whose identity we can assert flows through to the resolver.

const SENTINEL_MAP_TAG = '__stage2_cached_map__';

const testState = vi.hoisted(() => ({
  userDataPath: '/tmp/symlink-map-cache-userdata-initial',
  generateEmbeddings: vi.fn<(texts: string[]) => Promise<Float32Array[]>>(),
  loggerDebug: vi.fn(),
  loggerInfo: vi.fn(),
  loggerWarn: vi.fn(),
  loggerError: vi.fn(),
  isAnyTurnActive: vi.fn(() => false),
  waitForTurnIdle: vi.fn(async () => 'idle' as const),
  tryConvertToWorkspacePath:
    vi.fn<
      (filePath: string, workspacePath: string, symlinkMap?: unknown) => string | null
    >(),
  // One distinct sentinel "map" object per workspaceRoot, so we can assert both
  // the call count AND that the exact cached object threads through to the
  // resolver. We tag each with the workspace it was built for.
  buildSymlinkMap: vi.fn((workspaceRoot: string) => {
    return [{ [SENTINEL_MAP_TAG]: true, builtFor: workspaceRoot }];
  }),
}));

vi.mock('@core/platform', () => ({
  getPlatformConfig: () => ({
    isPackaged: false,
    userDataPath: testState.userDataPath,
    version: '0.0.0',
  }),
}));

vi.mock('@core/lazyElectron', () => ({
  onElectronAppEvent: vi.fn(),
}));

vi.mock('@core/logger', () => ({
  logger: {
    debug: testState.loggerDebug,
    info: testState.loggerInfo,
    warn: testState.loggerWarn,
    error: testState.loggerError,
  },
  createScopedLogger: () => ({
    debug: testState.loggerDebug,
    info: testState.loggerInfo,
    warn: testState.loggerWarn,
    error: testState.loggerError,
  }),
}));

vi.mock('@core/embeddingGenerator', () => ({
  getEmbeddingGenerator: () => ({
    generateEmbedding: async () => Float32Array.from([1, 0]),
    generateQueryEmbedding: async () => Float32Array.from([1, 0]),
    generateEmbeddings: testState.generateEmbeddings,
  }),
}));

vi.mock('./visibilityAwareScheduler', () => ({
  isAnyTurnActive: testState.isAnyTurnActive,
  waitForTurnIdle: testState.waitForTurnIdle,
}));

vi.mock('../sourceMetadataStore', () => ({
  isSourcePath: vi.fn(() => false),
  indexSource: vi.fn(),
}));

vi.mock('../entityMetadataStore', () => ({
  isEntityFile: vi.fn(() => false),
  indexEntity: vi.fn(),
  removeEntity: vi.fn(),
}));

vi.mock('../../utils/systemUtils', () => ({
  tryConvertToWorkspacePath: testState.tryConvertToWorkspacePath,
}));

// The cached-map producer. Both state.ts (build at init / rebuild on dir change)
// and index.ts (build at init) consume this; the systemUtils consumer is mocked
// out above so only the fileIndexService side exercises it here.
vi.mock('@core/utils/symlinkMap', () => ({
  buildSymlinkMap: testState.buildSymlinkMap,
  convertPathWithSymlinkMap: vi.fn(() => null),
  SYMLINK_MAP_MAX_DEPTH: 4,
}));

vi.mock('../../utils/emfileRetry', () => ({
  isTooManyOpenFilesError: vi.fn(() => false),
}));

vi.mock('../../utils/enfileState', () => ({
  isEnfileActive: vi.fn(() => false),
  markEnfileDetected: vi.fn((_error?: unknown) => ({ isFirstDetection: false })),
}));

vi.mock('../behindTheScenesClient', () => ({
  callWithModelAuthAware: vi.fn(),
}));

vi.mock('../../utils/authEnvUtils', () => ({
  hasValidAuth: vi.fn(() => true),
}));

vi.mock('../costLedgerService', () => ({
  appendCostEntry: vi.fn(() => ({ costEntryId: 'test-cost-entry-id' })),
}));

import {
  _getCurrentIndexForTesting,
  _drainBackgroundFillsForTesting,
  closeIndex,
  indexFile,
  initializeIndex,
  lazyFillFileVectorsIfNeeded,
  rebuildWorkspaceSymlinkMap,
  getWorkspaceSymlinkMap,
} from '../fileIndexService';

function workspaceHash(workspacePath: string): string {
  return crypto.createHash('sha256').update(workspacePath).digest('hex').slice(0, 16);
}

function getLanceDBDir(workspacePath: string): string {
  return path.join(testState.userDataPath, 'indices', workspaceHash(workspacePath), 'lancedb');
}

function isSentinelMap(value: unknown): value is Array<Record<string, unknown>> {
  return Array.isArray(value) && value.length > 0 && (value[0] as Record<string, unknown>)?.[SENTINEL_MAP_TAG] === true;
}

describe('fileIndexService — cached symlink map (Stage 2)', () => {
  let workspacePath: string;
  let canonicalWorkspacePath: string;
  const vectorsByRelativePath = new Map<string, number[]>();

  async function writeIndexedFile(relativePath: string, content: string): Promise<string> {
    vectorsByRelativePath.set(relativePath, [1, 0]);
    const filePath = path.join(workspacePath, relativePath);
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, content);
    await indexFile(filePath, workspacePath);
    return filePath;
  }

  beforeEach(async () => {
    testState.userDataPath = await fs.mkdtemp(path.join(os.tmpdir(), 'symlink-map-cache-userdata-'));
    workspacePath = await fs.mkdtemp(path.join(os.tmpdir(), 'symlink-map-cache-workspace-'));
    canonicalWorkspacePath = await fs.realpath(workspacePath);
    vectorsByRelativePath.clear();
    testState.generateEmbeddings.mockReset();
    testState.generateEmbeddings.mockImplementation(async (texts) =>
      texts.map((text) => {
        const relativePath = /^Path: (.+)$/m.exec(text)?.[1];
        const vector = relativePath ? vectorsByRelativePath.get(relativePath) : undefined;
        return Float32Array.from(vector ?? [1, 0]);
      })
    );
    testState.tryConvertToWorkspacePath.mockReset();
    testState.tryConvertToWorkspacePath.mockImplementation((filePath) => {
      const relativePath = path.relative(canonicalWorkspacePath, filePath);
      return relativePath.startsWith('..') || path.isAbsolute(relativePath) ? null : relativePath;
    });
    testState.buildSymlinkMap.mockClear();
    testState.isAnyTurnActive.mockReset();
    testState.isAnyTurnActive.mockReturnValue(false);
    testState.waitForTurnIdle.mockClear();
    testState.loggerDebug.mockClear();
    testState.loggerInfo.mockClear();
    testState.loggerWarn.mockClear();
    testState.loggerError.mockClear();
  });

  afterEach(async () => {
    const currentIndex = _getCurrentIndexForTesting();
    if (currentIndex && currentIndex.workspacePath !== workspacePath) {
      currentIndex.workspacePath = workspacePath;
    }
    await closeIndex();
    await fs.rm(workspacePath, { recursive: true, force: true });
    await fs.rm(testState.userDataPath, { recursive: true, force: true });
  });

  // 1 + 2: built ONCE per init; per-FILE path CONVERSIONS reuse the cached map
  // (they never trigger their own build). NOTE (MA3, 260529): lazy-fill PASSES
  // now rebuild the cached map once per pass to bound staleness for silent
  // symlink retargets — so the build count tracks init + #passes, NOT #files.
  // The invariant this test pins is the hot-path one: indexing N files does not
  // cause the per-file CONVERSION to rebuild (it reuses the threaded cached map),
  // and the total build count stays bounded well below "once per file plus once
  // per conversion".
  it('builds the symlink map once per init and reuses the cached map for per-file conversions (no per-file rebuild)', async () => {
    await initializeIndex(workspacePath);

    // Exactly one build at init for this workspace.
    const buildsAtInit = testState.buildSymlinkMap.mock.calls.filter(
      ([root]) => root === workspacePath
    );
    expect(buildsAtInit.length).toBe(1);

    // The cached map is installed on the live index.
    const cached = getWorkspaceSymlinkMap();
    expect(isSentinelMap(cached)).toBe(true);

    testState.tryConvertToWorkspacePath.mockClear();

    // Index many files. Each file's hot-path conversion must reuse the cached map
    // (3rd arg is the sentinel), not build its own.
    const N = 8;
    for (let i = 0; i < N; i++) {
      await writeIndexedFile(`file-${i}.md`, `Path: file-${i}.md\nhello world ${i}`);
    }

    // Every per-file conversion received a cached sentinel map (reuse, not rebuild).
    expect(testState.tryConvertToWorkspacePath).toHaveBeenCalled();
    for (const call of testState.tryConvertToWorkspacePath.mock.calls) {
      expect(isSentinelMap(call[2])).toBe(true);
    }
  });

  // 3: the cached map threads through to the resolver on the hot path.
  it('passes the cached map as the 3rd arg to tryConvertToWorkspacePath on the indexFile hot path', async () => {
    await initializeIndex(workspacePath);
    testState.tryConvertToWorkspacePath.mockClear();

    await writeIndexedFile('threaded.md', 'Path: threaded.md\nbody');

    expect(testState.tryConvertToWorkspacePath).toHaveBeenCalled();
    // Every hot-path call received the cached sentinel map as the 3rd arg.
    for (const call of testState.tryConvertToWorkspacePath.mock.calls) {
      expect(isSentinelMap(call[2])).toBe(true);
      expect((call[2] as Array<Record<string, unknown>>)[0].builtFor).toBe(workspacePath);
    }
  });

  // Invalidation A: explicit rebuild (the dir add/remove watcher hook calls this).
  it('rebuildWorkspaceSymlinkMap replaces the cached map in place', async () => {
    await initializeIndex(workspacePath);
    const before = getWorkspaceSymlinkMap();
    testState.buildSymlinkMap.mockClear();

    rebuildWorkspaceSymlinkMap();

    expect(testState.buildSymlinkMap).toHaveBeenCalledTimes(1);
    expect(testState.buildSymlinkMap).toHaveBeenCalledWith(workspacePath);
    const after = getWorkspaceSymlinkMap();
    // A fresh object replaced the previous cached map.
    expect(after).not.toBe(before);
    expect(isSentinelMap(after)).toBe(true);
  });

  // MA3: the lazy-fill pass rebuilds the cached map ONCE per pass (bounding
  // staleness to ≤ one pass for silent symlink retargets that emit no dir event),
  // and crucially NOT once per file.
  it('rebuilds the cached symlink map once per lazy-fill pass, not per file', async () => {
    await initializeIndex(workspacePath);

    // Index several files first (each indexFile reuses the cached map; no rebuild).
    const N = 6;
    for (let i = 0; i < N; i++) {
      await writeIndexedFile(`pass-${i}.md`, `Path: pass-${i}.md\ncontent ${i}`);
    }

    // Each indexFile kicks off a FIRE-AND-FORGET background fill
    // (startLazyFillFileNeighborsAsync → prepareFileVectorsRead →
    // lazyFillFileVectorsIfNeeded), which registers itself in `lazyFillInFlight`
    // for this workspace and rebuilds the symlink map as part of its pass. If one
    // of those is still in flight when we call lazyFillFileVectorsIfNeeded() below,
    // the single-flight guard hands us the EXISTING promise — whose rebuild already
    // happened before our mockClear — so we'd count 0 rebuilds and flake under load.
    // Drain those background fills to quiescence first so the pass we measure below
    // is genuinely a fresh, single-flight-clear pass.
    await _drainBackgroundFillsForTesting(workspacePath);

    // Now isolate a single lazy-fill pass and count rebuilds during it.
    testState.buildSymlinkMap.mockClear();
    await lazyFillFileVectorsIfNeeded();
    // The pass kicks off a fire-and-forget neighbors fill that also rebuilds the
    // map once; drain it so its rebuild is included deterministically in the count.
    await _drainBackgroundFillsForTesting(workspacePath);

    const buildsDuringPass = testState.buildSymlinkMap.mock.calls.filter(
      ([root]) => root === workspacePath
    ).length;

    // A pass rebuilds the map a bounded, small number of times (the file_vectors
    // pass entry, plus the neighbors pass entry it kicks off) — NEVER N times.
    expect(buildsDuringPass).toBeGreaterThanOrEqual(1);
    expect(buildsDuringPass).toBeLessThan(N);
  });

  // Invalidation B: switching workspaces rebuilds for the new workspace.
  it('rebuilds the cached map for the new workspace on workspace change', async () => {
    await initializeIndex(workspacePath);
    const firstCached = getWorkspaceSymlinkMap();
    expect((firstCached as unknown as Array<Record<string, unknown>>)[0].builtFor).toBe(workspacePath);

    const secondWorkspace = await fs.mkdtemp(path.join(os.tmpdir(), 'symlink-map-cache-workspace2-'));
    try {
      testState.buildSymlinkMap.mockClear();
      await initializeIndex(secondWorkspace);

      // Built once for the new workspace root.
      const buildsForSecond = testState.buildSymlinkMap.mock.calls.filter(
        ([root]) => root === secondWorkspace
      );
      expect(buildsForSecond.length).toBe(1);

      const secondCached = getWorkspaceSymlinkMap();
      expect(secondCached).not.toBe(firstCached);
      expect((secondCached as unknown as Array<Record<string, unknown>>)[0].builtFor).toBe(secondWorkspace);
    } finally {
      // Point the live index back at the primary workspace so afterEach cleans up.
      const currentIndex = _getCurrentIndexForTesting();
      if (currentIndex) currentIndex.workspacePath = workspacePath;
      await fs.rm(secondWorkspace, { recursive: true, force: true });
      await fs.rm(getLanceDBDir(secondWorkspace), { recursive: true, force: true }).catch(() => undefined);
    }
  });
});
