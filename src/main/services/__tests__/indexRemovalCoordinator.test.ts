import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  configureIndexRemovalCoordinator,
  __resetIndexRemovalCoordinatorForTests,
  removeMetadataStoresEntry,
  removeVectorIndexEntry,
  removeVectorIndexEntries,
  removeIndexedEntry,
  removeIndexedEntries,
  type CoordinatorRemovalReason,
  type IndexRemovalRemovers,
} from '../indexRemovalCoordinator';

const WS = '/ws';
const ABS = '/ws/memory/sources/a.md';

// `CoordinatorRemovalReason` is now EXACTLY the strict Stage-1 `RemovalReason`
// (Stage 4c F2/R4): the loose `{ absence; proof? }` alias is gone. A bare fs-absence
// (no proof) is `absence-unverified` — for a LOCAL path (these tests, no containment
// configured) it purges as before; a CLOUD path would RETAIN. An authorized cloud
// purge requires `absence-authorized` + an `AbsenceProof` (compile-checked in the
// .type-test). These behaviour-preserving cases use local paths, so the removal
// proceeds regardless of the absence kind.
const WATCHER_UNLINK: CoordinatorRemovalReason = { kind: 'watcher-unlink' };
const ABSENCE: CoordinatorRemovalReason = { kind: 'absence-unverified' };
const HYGIENE: CoordinatorRemovalReason = { kind: 'hygiene' };
const REPLACEMENT: CoordinatorRemovalReason = { kind: 'replacement' };

function makeMockRemovers(overrides?: Partial<IndexRemovalRemovers>): {
  removers: IndexRemovalRemovers;
  spies: {
    removeSource: ReturnType<typeof vi.fn>;
    isSourcePath: ReturnType<typeof vi.fn>;
    removeEntity: ReturnType<typeof vi.fn>;
    removeFileFromIndex: ReturnType<typeof vi.fn>;
    removeFilesFromIndex: ReturnType<typeof vi.fn>;
  };
} {
  const spies = {
    removeSource: vi.fn<(filePath: string) => void>(),
    isSourcePath: vi.fn<(filePath: string, ws: string) => boolean>(() => true),
    removeEntity: vi.fn<(filePath: string) => void>(),
    removeFileFromIndex: vi.fn(async () => {}),
    removeFilesFromIndex: vi.fn(async (paths: string[]) => paths.length),
  };
  const removers: IndexRemovalRemovers = {
    removeSource: spies.removeSource,
    isSourcePath: spies.isSourcePath as unknown as IndexRemovalRemovers['isSourcePath'],
    removeEntity: spies.removeEntity,
    removeFileFromIndex: spies.removeFileFromIndex as unknown as IndexRemovalRemovers['removeFileFromIndex'],
    removeFilesFromIndex: spies.removeFilesFromIndex as unknown as IndexRemovalRemovers['removeFilesFromIndex'],
    ...overrides,
  };
  return { removers, spies };
}

describe('indexRemovalCoordinator', () => {
  afterEach(() => {
    __resetIndexRemovalCoordinatorForTests();
    vi.restoreAllMocks();
  });

  describe('inert no-op default (unwired)', () => {
    it('never throws and removes nothing when unconfigured', async () => {
      __resetIndexRemovalCoordinatorForTests();
      // Each entrypoint must be a safe no-op (no throw) on the hot path.
      expect(() =>
        removeMetadataStoresEntry(ABS, WATCHER_UNLINK, { workspacePath: WS }),
      ).not.toThrow();
      await expect(removeVectorIndexEntry(ABS, WATCHER_UNLINK)).resolves.toBeUndefined();
      await expect(removeVectorIndexEntries([ABS], HYGIENE)).resolves.toBe(0);
      await expect(removeIndexedEntry(ABS, ABSENCE, { workspacePath: WS })).resolves.toBeUndefined();
      await expect(removeIndexedEntries([ABS], ABSENCE, { workspacePath: WS })).resolves.toBe(0);
    });
  });

  describe('watcher-unlink (queueFileRemove shape): metadata now, vectors later', () => {
    it('removes from source (incl. portable-relative) + entity but NOT vectors in the metadata phase', () => {
      const { removers, spies } = makeMockRemovers();
      configureIndexRemovalCoordinator(removers);

      removeMetadataStoresEntry(ABS, WATCHER_UNLINK, {
        workspacePath: WS,
        alsoRemoveSourcePortableRelative: true,
      });

      // queueFileRemove removed BOTH the absolute and the portable-relative source key.
      expect(spies.removeSource).toHaveBeenCalledTimes(2);
      expect(spies.removeSource).toHaveBeenCalledWith(ABS);
      expect(spies.removeSource).toHaveBeenCalledWith('memory/sources/a.md');
      expect(spies.removeEntity).toHaveBeenCalledTimes(1);
      expect(spies.removeEntity).toHaveBeenCalledWith(ABS);
      // No vector removal in the metadata phase (that happens later in processItem).
      expect(spies.removeFileFromIndex).not.toHaveBeenCalled();
    });

    it('removes from vectors in the later phase (processItem shape)', async () => {
      const { removers, spies } = makeMockRemovers();
      configureIndexRemovalCoordinator(removers);

      await removeVectorIndexEntry(ABS, WATCHER_UNLINK, { skipReadRefresh: true });

      expect(spies.removeFileFromIndex).toHaveBeenCalledTimes(1);
      expect(spies.removeFileFromIndex).toHaveBeenCalledWith(ABS, { skipReadRefresh: true });
    });

    it('does NOT remove the portable-relative source key when not opted in (cleanupStaleEntries shape)', () => {
      const { removers, spies } = makeMockRemovers();
      configureIndexRemovalCoordinator(removers);

      removeMetadataStoresEntry(ABS, ABSENCE, {
        workspacePath: WS,
        stores: { source: true, entity: true, vectorIndex: false },
      });

      expect(spies.removeSource).toHaveBeenCalledTimes(1);
      expect(spies.removeSource).toHaveBeenCalledWith(ABS);
      expect(spies.removeEntity).toHaveBeenCalledTimes(1);
    });

    it('skips the source removal when isSourcePath is false (preserving the guard)', () => {
      const { removers, spies } = makeMockRemovers({
        isSourcePath: vi.fn(() => false) as unknown as IndexRemovalRemovers['isSourcePath'],
      });
      configureIndexRemovalCoordinator(removers);

      removeMetadataStoresEntry(ABS, WATCHER_UNLINK, {
        workspacePath: WS,
        alsoRemoveSourcePortableRelative: true,
      });

      expect(spies.removeSource).not.toHaveBeenCalled();
      // entity is unconditional, as in the call-sites.
      expect(spies.removeEntity).toHaveBeenCalledTimes(1);
    });
  });

  describe('per-store selectivity (cleanupStaleEntries defensive branch)', () => {
    it('entity-only selection removes ONLY entity (source untouched)', () => {
      const { removers, spies } = makeMockRemovers();
      configureIndexRemovalCoordinator(removers);

      removeMetadataStoresEntry(ABS, ABSENCE, {
        workspacePath: WS,
        stores: { source: false, entity: true, vectorIndex: false },
      });

      expect(spies.removeSource).not.toHaveBeenCalled();
      expect(spies.removeEntity).toHaveBeenCalledTimes(1);
    });
  });

  describe('hygiene (purgeRebel/purgeConflict shape): LanceDB ONLY', () => {
    it('routes a batch removal to vectors and never touches metadata stores', async () => {
      const { removers, spies } = makeMockRemovers();
      configureIndexRemovalCoordinator(removers);

      const paths = ['/ws/.rebel/x.md', '/ws/y (1).md'];
      const removed = await removeVectorIndexEntries(paths, HYGIENE, {
        skipReadRefresh: false,
        skipOptimize: true,
      });

      expect(removed).toBe(2);
      expect(spies.removeFilesFromIndex).toHaveBeenCalledWith(paths, {
        skipReadRefresh: false,
        skipOptimize: true,
      });
      expect(spies.removeSource).not.toHaveBeenCalled();
      expect(spies.removeEntity).not.toHaveBeenCalled();
    });
  });

  describe('combined entrypoints (decide once, apply to all selected stores)', () => {
    it('removeIndexedEntry applies metadata THEN vectors for an absence removal', async () => {
      const { removers, spies } = makeMockRemovers();
      configureIndexRemovalCoordinator(removers);
      const order: string[] = [];
      spies.removeEntity.mockImplementation(() => order.push('entity'));
      spies.removeFileFromIndex.mockImplementation(async () => {
        order.push('vector');
      });

      await removeIndexedEntry(ABS, ABSENCE, { workspacePath: WS });

      // All three stores hit, metadata before LanceDB (no half-purge window).
      expect(spies.removeSource).toHaveBeenCalled();
      expect(spies.removeEntity).toHaveBeenCalled();
      expect(spies.removeFileFromIndex).toHaveBeenCalledWith(ABS, { skipReadRefresh: undefined });
      expect(order).toEqual(['entity', 'vector']);
    });

    it('removeIndexedEntries does per-path metadata then ONE batch vector delete', async () => {
      const { removers, spies } = makeMockRemovers();
      configureIndexRemovalCoordinator(removers);

      const paths = ['/ws/memory/sources/a.md', '/ws/memory/sources/b.md'];
      const removed = await removeIndexedEntries(paths, ABSENCE, { workspacePath: WS });

      expect(removed).toBe(2);
      expect(spies.removeSource).toHaveBeenCalledTimes(2); // one per path (portable-relative not opted in)
      expect(spies.removeEntity).toHaveBeenCalledTimes(2);
      expect(spies.removeFilesFromIndex).toHaveBeenCalledTimes(1);
      expect(spies.removeFilesFromIndex).toHaveBeenCalledWith(paths, {
        skipReadRefresh: undefined,
        skipOptimize: undefined,
      });
    });
  });

  describe('replacement reason is accepted (gating-exempt classification)', () => {
    it('routes a replacement vector removal like any other (4a behavior-preserving)', async () => {
      const { removers, spies } = makeMockRemovers();
      configureIndexRemovalCoordinator(removers);
      await removeVectorIndexEntry(ABS, REPLACEMENT, { skipReadRefresh: true });
      expect(spies.removeFileFromIndex).toHaveBeenCalledWith(ABS, { skipReadRefresh: true });
    });
  });
});
