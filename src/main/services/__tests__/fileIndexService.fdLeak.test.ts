/**
 * Tests for the FD-leak fix in `fileIndexService.ts`
 * (see `docs-private/investigations/260428_emfile_fd_leak.md`).
 *
 * Covers:
 *  1. `ReadTableHandle` ref-counted lease lifecycle (acquire / release / retire)
 *  2. `clearIndexInternal` ad-hoc connection close in try/finally
 *
 * Tests run against the exported `ReadTableHandle` class plus a focused
 * mock for the LanceDB `connect` / `dropTable` flow used by the
 * "currentIndex is null" branch of `clearIndex()`.
 */

import { beforeAll, beforeEach, afterEach, describe, expect, it, vi } from 'vitest';

// ── Module-level mocks (same pattern as indexHealthService.test.ts) ──
// All vi.mock disables: this service's transitive dependency tree pulls in
// Electron APIs and the LanceDB native module; DI through every internal
// site would require restructuring fileIndexService more widely than
// Phase 1 allows.
 
vi.mock('@core/platform', () => ({
  getPlatformConfig: () => ({ isPackaged: false, userDataPath: '/tmp/test-fd-leak', version: '0.0.0' }),
}));
 
vi.mock('@core/lazyElectron', () => ({
  onElectronAppEvent: vi.fn(),
}));
 
vi.mock('../embeddingService', () => ({
  generateEmbedding: vi.fn(),
  generateEmbeddings: vi.fn(),
  generateQueryEmbedding: vi.fn(),
  getEmbeddingDimensions: vi.fn(() => 384),
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
  tryConvertToWorkspacePath: vi.fn(() => null),
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

// LanceDB mock — the service loads it via `nativeRequire` which goes through
// `createRequire(...)`, so we have to intercept that path (matches the
// pattern in indexHealthService.test.ts).
const mockLanceDBClose = vi.fn();
const mockLanceDBDropTable = vi.fn();
const mockLanceDBTableNames = vi.fn();
const mockLanceDBConnect = vi.fn();

 
vi.mock('node:module', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:module')>();
  return {
    ...actual,
    createRequire: vi.fn().mockImplementation((from: string) => {
      const realRequire = actual.createRequire(from);
      return (modulePath: string) => {
        if (modulePath === '@lancedb/lancedb') {
          return {
            connect: (dbPath: string) => mockLanceDBConnect(dbPath),
          };
        }
        return realRequire(modulePath);
      };
    }),
  };
});

// fs.access / unlink stubs so the database-directory probe + metadata
// cleanup succeed without touching the real filesystem.
 
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    default: {
      ...actual,
      access: vi.fn(async () => undefined),
      unlink: vi.fn(async () => undefined),
    },
    access: vi.fn(async () => undefined),
    unlink: vi.fn(async () => undefined),
  };
});

// ── 1. ReadTableHandle lifecycle ─────────────────────────────────────

describe('ReadTableHandle — ref-counted lease lifecycle', () => {
  let ReadTableHandle: typeof import('../fileIndexService').ReadTableHandle;

  beforeAll(async () => {
    const mod = await import('../fileIndexService');
    ReadTableHandle = mod.ReadTableHandle;
  });

  it('acquire() returns the underlying table and increments refcount', () => {
    const table = { close: vi.fn(), id: 'table-A' };
    const handle = new ReadTableHandle(table as never);

    expect(handle._getRefsForTesting()).toBe(0);
    const got = handle.acquire();
    expect(got).toBe(table);
    expect(handle._getRefsForTesting()).toBe(1);

    handle.acquire();
    expect(handle._getRefsForTesting()).toBe(2);
  });

  it('release() decrements refcount but does NOT close while not retired', async () => {
    const close = vi.fn();
    const handle = new ReadTableHandle({ close } as never);

    handle.acquire();
    handle.acquire();
    expect(handle._getRefsForTesting()).toBe(2);

    await handle.release();
    expect(handle._getRefsForTesting()).toBe(1);
    expect(close).not.toHaveBeenCalled();

    await handle.release();
    expect(handle._getRefsForTesting()).toBe(0);
    expect(close).not.toHaveBeenCalled();
  });

  it('retire() with no in-flight readers closes immediately', async () => {
    const close = vi.fn();
    const handle = new ReadTableHandle({ close } as never);

    expect(handle._isRetiredForTesting()).toBe(false);
    await handle.retire();
    expect(handle._isRetiredForTesting()).toBe(true);
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('retire() with in-flight readers defers close until last release', async () => {
    const close = vi.fn();
    const handle = new ReadTableHandle({ close } as never);

    handle.acquire();
    handle.acquire();
    expect(handle._getRefsForTesting()).toBe(2);

    // Retire while readers are leasing — close MUST be deferred.
    await handle.retire();
    expect(handle._isRetiredForTesting()).toBe(true);
    expect(close).not.toHaveBeenCalled();

    // First release — refcount drops to 1, still no close.
    await handle.release();
    expect(close).not.toHaveBeenCalled();

    // Last release — close fires now.
    await handle.release();
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('retire() is idempotent (second call awaits same close, no double-close)', async () => {
    const close = vi.fn();
    const handle = new ReadTableHandle({ close } as never);

    await handle.retire();
    await handle.retire();
    await handle.retire();

    expect(close).toHaveBeenCalledTimes(1);
  });

  it('release() called more times than acquire() is safe (logs warn, no throw)', async () => {
    const close = vi.fn();
    const handle = new ReadTableHandle({ close } as never);

    // Defensive double-release path. Must not throw.
    await expect(handle.release()).resolves.toBeUndefined();
    await expect(handle.release()).resolves.toBeUndefined();

    expect(handle._getRefsForTesting()).toBe(0);
    expect(close).not.toHaveBeenCalled();
  });

  it('a close() that throws is caught, not propagated, and not retried', async () => {
    const close = vi.fn(() => {
      throw new Error('close failed');
    });
    const handle = new ReadTableHandle({ close } as never);

    await expect(handle.retire()).resolves.toBeUndefined();
    expect(close).toHaveBeenCalledTimes(1);

    // Subsequent retire() awaits the same closing promise — no second call.
    await handle.retire();
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('handles an async close() that returns a Promise', async () => {
    let resolveClose!: () => void;
    const closePromise = new Promise<void>((r) => {
      resolveClose = r;
    });
    const close = vi.fn(() => closePromise);
    const handle = new ReadTableHandle({ close } as never);

    const retirePromise = handle.retire();
    expect(close).toHaveBeenCalledTimes(1);
    expect(handle._isClosingForTesting()).toBe(true);

    resolveClose();
    await retirePromise;
    expect(handle._isClosingForTesting()).toBe(true); // closing promise is settled but reference kept
  });

  it('a missing close() method on the table is tolerated (no throw)', async () => {
    const handle = new ReadTableHandle({} as never);
    await expect(handle.retire()).resolves.toBeUndefined();
  });

  it('retire-while-acquired then release waits for close to complete', async () => {
    let resolveClose!: () => void;
    const closePromise = new Promise<void>((r) => {
      resolveClose = r;
    });
    const close = vi.fn(() => closePromise);
    const handle = new ReadTableHandle({ close } as never);

    handle.acquire();
    await handle.retire();
    expect(close).not.toHaveBeenCalled();

    // Release triggers the close now.
    const releasePromise = handle.release();
    expect(close).toHaveBeenCalledTimes(1);

    // The release await chain should also block on the close.
    let released = false;
    void releasePromise.then(() => { released = true; });

    // Microtask flush before resolveClose — release should NOT have settled.
    await Promise.resolve();
    expect(released).toBe(false);

    resolveClose();
    await releasePromise;
    expect(released).toBe(true);
  });
});

// ── 1b. ReadTableHandle.waitForDrain — Phase 1 review fix-up ─────────
//
// `waitForDrain` is the bounded-wait hook used by shutdown paths
// (`closeIndexInternal`, `clearIndexInternal`) to give in-flight readers
// a chance to release before the read connection is closed underneath
// them. Without this drain, a long-running `semanticSearch` /
// `getFileEmbeddings` could be torn down mid-read at workspace switch
// or app close — see `docs-private/investigations/260428_emfile_fd_leak.md`
// review feedback item #1.

describe('ReadTableHandle.waitForDrain — bounded shutdown drain', () => {
  let ReadTableHandle: typeof import('../fileIndexService').ReadTableHandle;

  beforeAll(async () => {
    const mod = await import('../fileIndexService');
    ReadTableHandle = mod.ReadTableHandle;
  });

  it('returns drained:true immediately when no readers are leasing', async () => {
    const close = vi.fn();
    const handle = new ReadTableHandle({ close } as never);

    const result = await handle.waitForDrain(1000);
    expect(result).toEqual({ drained: true, remainingRefs: 0 });
  });

  it('awaits the in-flight close promise when fast-pathing on already-idle handle', async () => {
    let resolveClose!: () => void;
    const closePromise = new Promise<void>((r) => {
      resolveClose = r;
    });
    const close = vi.fn(() => closePromise);
    const handle = new ReadTableHandle({ close } as never);

    // Kick off a retire — it starts the close but doesn't await its
    // completion (we're using promises, not awaits).
    const retirePromise = handle.retire();

    // Now waitForDrain on an already-zero-ref but actively-closing handle.
    // It should block until the close settles, not return immediately.
    let drained = false;
    void handle.waitForDrain(1000).then((r) => {
      if (r.drained) drained = true;
    });

    // Flush microtasks. waitForDrain must NOT have resolved yet because
    // the close promise is still pending.
    await Promise.resolve();
    await Promise.resolve();
    expect(drained).toBe(false);

    resolveClose();
    await retirePromise;
    // Allow the waitForDrain microtask chain to complete.
    await new Promise((r) => setTimeout(r, 10));
    expect(drained).toBe(true);
  });

  it('returns drained:true when readers release within the timeout', async () => {
    const close = vi.fn();
    const handle = new ReadTableHandle({ close } as never);

    handle.acquire();
    await handle.retire();
    expect(close).not.toHaveBeenCalled();

    // Schedule a release 30 ms in — well inside the 1000 ms timeout.
    setTimeout(() => {
      void handle.release();
    }, 30);

    const result = await handle.waitForDrain(1000);
    expect(result.drained).toBe(true);
    expect(result.remainingRefs).toBe(0);
    // Close should have fired (release found refs == 0 && retired).
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('returns drained:false with remainingRefs when timeout fires before readers release', async () => {
    const close = vi.fn();
    const handle = new ReadTableHandle({ close } as never);

    handle.acquire();
    handle.acquire();
    expect(handle._getRefsForTesting()).toBe(2);

    // Don't release. Use a short timeout so the test is fast.
    const result = await handle.waitForDrain(100);

    expect(result.drained).toBe(false);
    expect(result.remainingRefs).toBe(2);
    // Close must NOT have been called — the handle is still in use.
    expect(close).not.toHaveBeenCalled();
  });
});

// ── 1c. semanticSearch fallback null-check — Phase 1 review fix-up ────
//
// When `currentIndex.readTable` is null but `currentIndex.table` is non-
// null (rare bootstrap window between createTable and readTable open),
// `semanticSearch` falls through to the write table without a lease. A
// concurrent `clearIndex` between the embedding-generation await and the
// query could pull the rug out — fail-closed defensive null-check.
//
// We test the contract on the public `semanticSearch` export by driving
// the module's internal state via `initializeIndex` then triggering
// `clearIndex` between the embedding await and the search query. Mocking
// the embedding service is the natural seam: it's already mocked at module
// scope above, so we override its return on a per-test basis.

describe('semanticSearch — write-fallback null-check on concurrent clearIndex', () => {
  // We exercise the module-level state by hooking generateQueryEmbedding to
  // run a microtask-yielding callback that can mutate the index reference.

  beforeAll(async () => {
    const { setEmbeddingGeneratorFactory } = await import('@core/embeddingGenerator');
    const embeddingMod = await import('../embeddingService');
    setEmbeddingGeneratorFactory(() => ({
      generateEmbedding: (text: string) => embeddingMod.generateEmbedding(text),
      generateQueryEmbedding: (text: string) => embeddingMod.generateQueryEmbedding(text),
      generateEmbeddings: (texts: string[]) => embeddingMod.generateEmbeddings(texts),
    }));
  });

  beforeEach(async () => {
    // Reset both module state and the embedding mock so each test starts
    // from a clean baseline regardless of earlier suite ordering.
    const fileIndexMod = await import('../fileIndexService');
    const embeddingMod = await import('../embeddingService');
    fileIndexMod._setCurrentIndexForTesting(null);
    (embeddingMod.generateQueryEmbedding as ReturnType<typeof vi.fn>).mockReset();
  });

  afterEach(async () => {
    // Belt-and-braces: ensure currentIndex is null even if a test fails
    // mid-flight, so downstream describe blocks (e.g. the ad-hoc clearIndex
    // tests) hit the no-currentIndex branch they expect.
    const fileIndexMod = await import('../fileIndexService');
    fileIndexMod._setCurrentIndexForTesting(null);
  });

  it('returns [] when no current index is set (early-out branch, not post-await)', async () => {
    const fileIndexMod = await import('../fileIndexService');
    const embeddingMod = await import('../embeddingService');

    const result = await fileIndexMod.semanticSearch('hello world');
    expect(result).toEqual([]);
    // generateQueryEmbedding should NOT be called when there's no current
    // index — the early-out fires before we'd burn a CPU-bound embedding
    // pass. (Pre-existing behaviour; this asserts we didn't accidentally
    // demote it to a post-await check.)
    expect(embeddingMod.generateQueryEmbedding as ReturnType<typeof vi.fn>).not.toHaveBeenCalled();
  });

  it('returns [] when capturedIndex.table is nulled DURING the embedding await (post-await mismatch path)', async () => {
    const fileIndexMod = await import('../fileIndexService');
    const embeddingMod = await import('../embeddingService');

    // Set up the bootstrap window: a non-null write table, null readTable.
    // The write-fallback path in semanticSearch is what this test
    // exercises — there's no lease protecting it, so the post-await
    // null-check is the only defense against a concurrent clearIndex.
    const writeTableMock = {
      query: vi.fn(() => {
        throw new Error('semanticSearch must NOT touch the write table after the post-await null-check fires');
      }),
      countRows: vi.fn(),
      close: vi.fn(),
    };
    const fakeIndex = {
      connection: {} as never,
      readConnection: {} as never,
      table: writeTableMock,
      readTable: null,
      workspacePath: '/tmp/fake-workspace',
      indexedMtimes: new Map<string, number>(),
      lastIndexedAt: null,
      metadata: {} as never,
      indexedFilesCount: 0,
      ftsStatus: 'unavailable' as const,
    };
    fileIndexMod._setCurrentIndexForTesting(fakeIndex as never);

    // Drive `generateQueryEmbedding` to mutate currentIndex.table = null
    // mid-flight. This is the exact race the null-check guards against:
    // a concurrent `clearIndex` that runs between the embedding await
    // and the table query.
    const generateQueryEmbeddingMock = embeddingMod.generateQueryEmbedding as ReturnType<typeof vi.fn>;
    generateQueryEmbeddingMock.mockImplementationOnce(async () => {
      // Yield a microtask so we're genuinely awaiting, then null the
      // table on the SAME currentIndex reference (matches what
      // clearIndexInternal does).
      await Promise.resolve();
      const live = fileIndexMod._getCurrentIndexForTesting();
      if (live) {
        live.table = null;
      }
      return new Float32Array(384);
    });

    const result = await fileIndexMod.semanticSearch('hello world');

    // Fail-closed contract: the post-await null-check returns [] without
    // touching the (now-null) write table. If the null-check regresses,
    // writeTableMock.query would throw and the test would fail loudly.
    expect(result).toEqual([]);
    expect(generateQueryEmbeddingMock).toHaveBeenCalledTimes(1);
    expect(writeTableMock.query).not.toHaveBeenCalled();
  });

  it('returns [] when currentIndex is REPLACED by a different object during the embedding await', async () => {
    const fileIndexMod = await import('../fileIndexService');
    const embeddingMod = await import('../embeddingService');

    // Same bootstrap window: write-fallback path (readTable: null).
    const originalWriteTable = {
      query: vi.fn(() => {
        throw new Error('semanticSearch must NOT touch the original write table after a workspace swap');
      }),
      countRows: vi.fn(),
      close: vi.fn(),
    };
    const originalIndex = {
      connection: {} as never,
      readConnection: {} as never,
      table: originalWriteTable,
      readTable: null,
      workspacePath: '/tmp/original-workspace',
      indexedMtimes: new Map<string, number>(),
      lastIndexedAt: null,
      metadata: {} as never,
      indexedFilesCount: 0,
      ftsStatus: 'unavailable' as const,
    };
    fileIndexMod._setCurrentIndexForTesting(originalIndex as never);

    // Drive `generateQueryEmbedding` to swap currentIndex to a different
    // object — simulates a workspace switch racing the in-flight search.
    const generateQueryEmbeddingMock = embeddingMod.generateQueryEmbedding as ReturnType<typeof vi.fn>;
    generateQueryEmbeddingMock.mockImplementationOnce(async () => {
      await Promise.resolve();
      const replacementIndex = {
        ...originalIndex,
        workspacePath: '/tmp/replacement-workspace',
        table: { query: vi.fn(), countRows: vi.fn(), close: vi.fn() },
      };
      fileIndexMod._setCurrentIndexForTesting(replacementIndex as never);
      return new Float32Array(384);
    });

    const result = await fileIndexMod.semanticSearch('hello world');

    expect(result).toEqual([]);
    expect(generateQueryEmbeddingMock).toHaveBeenCalledTimes(1);
    expect(originalWriteTable.query).not.toHaveBeenCalled();
  });
});

// ── 2. clearIndexInternal — ad-hoc connection close ──────────────────

describe('clearIndexInternal — ad-hoc connection close on the no-currentIndex path', () => {
  let clearIndex: typeof import('../fileIndexService').clearIndex;

  beforeAll(async () => {
    const mod = await import('../fileIndexService');
    clearIndex = mod.clearIndex;
  });

  beforeEach(() => {
    mockLanceDBClose.mockReset();
    mockLanceDBDropTable.mockReset().mockResolvedValue(undefined);
    mockLanceDBTableNames.mockReset().mockResolvedValue(['file_embeddings']);
    mockLanceDBConnect.mockReset().mockResolvedValue({
      tableNames: mockLanceDBTableNames,
      dropTable: mockLanceDBDropTable,
      close: mockLanceDBClose,
    });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('closes the ad-hoc LanceDB connection in finally on success', async () => {
    await clearIndex('/tmp/test-workspace');

    expect(mockLanceDBConnect).toHaveBeenCalledTimes(1);
    expect(mockLanceDBDropTable).toHaveBeenCalledTimes(1);
    expect(mockLanceDBClose).toHaveBeenCalledTimes(1);
  });

  it('closes the ad-hoc LanceDB connection in finally even when dropTable rejects', async () => {
    mockLanceDBDropTable.mockRejectedValueOnce(new Error('dropTable failed'));

    // The implementation logs at error level and rethrows, but the connection
    // close must still fire (try/finally).
    await expect(clearIndex('/tmp/test-workspace')).rejects.toThrow('dropTable failed');

    expect(mockLanceDBConnect).toHaveBeenCalledTimes(1);
    expect(mockLanceDBClose).toHaveBeenCalledTimes(1);
  });

  it('still closes when tableNames() rejects (close fires from finally)', async () => {
    mockLanceDBTableNames.mockRejectedValueOnce(new Error('tableNames failed'));

    await expect(clearIndex('/tmp/test-workspace')).rejects.toThrow('tableNames failed');

    expect(mockLanceDBClose).toHaveBeenCalledTimes(1);
    expect(mockLanceDBDropTable).not.toHaveBeenCalled();
  });

  it('does not crash when connection.close() itself rejects (logged + swallowed)', async () => {
    mockLanceDBClose.mockRejectedValueOnce(new Error('close failed'));

    // Successful path — clearIndex should resolve even though close throws.
    await expect(clearIndex('/tmp/test-workspace')).resolves.toBeUndefined();

    expect(mockLanceDBConnect).toHaveBeenCalledTimes(1);
    expect(mockLanceDBClose).toHaveBeenCalledTimes(1);
  });
});
