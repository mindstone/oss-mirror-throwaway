/**
 * sourceMetadataStore — R2 search-never-fs-checks-cloud-entries (Stage 4b,
 * 260619_cloud-symlink-indexing).
 *
 * What these lock:
 *  - `searchSources` RETAINS entries under a cloud space WITHOUT calling
 *    `fs.access` on them (spy-asserted) — the index is the source of truth for a
 *    cloud entry's searchability;
 *  - a DEAD-mount search (fs.access would hang/reject for the cloud path) does NOT
 *    hang and does NOT prune the cloud entries;
 *  - LOCAL entries keep their existing `fs.access` existence check (a genuinely
 *    missing local file is still pruned).
 *
 * The cloud-space containment predicate is mocked here (its mechanics are tested
 * in cloudSpaceContainment.test.ts); this test focuses on the search-path
 * behaviour the mock drives.
 */
import { afterEach, describe, it, expect, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { initTestPlatformConfig } from '@core/__tests__/testHelpers';

const stubLogger = {
  info: vi.fn(),
  debug: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
};

const mockAccess = vi.fn<(filePath: string) => Promise<void>>();

// Cloud paths the containment mock should classify as "under a cloud space".
const CLOUD_PREFIX = '/workspace/General/'; // a cloud-symlinked space

const setupModule = async () => {
  vi.resetModules();
  mockAccess.mockReset();
  mockAccess.mockResolvedValue(undefined);
  await initTestPlatformConfig();
  vi.doMock('node:fs/promises', () => ({
    default: { access: mockAccess },
    access: mockAccess,
  }));
  vi.doMock('electron-store', () => {
    class MemoryStore<T extends Record<string, unknown>> {
      store: T;
      constructor(options: { defaults: T }) {
        this.store = structuredClone(options.defaults);
      }
      get(key: keyof T) {
        return this.store[key];
      }
      set(key: keyof T, value: T[keyof T]) {
        this.store[key] = value;
      }
    }
    return { default: MemoryStore };
  });
  vi.doMock('@core/logger', () => ({
    createScopedLogger: () => stubLogger,
  }));
  // Containment mock: a path under CLOUD_PREFIX is "under a cloud space".
  vi.doMock('@core/services/cloudSpaceContainment', () => ({
    isUnderCloudSpace: (p: string) => p.startsWith(CLOUD_PREFIX),
  }));
  const store = await import('../../../core/services/sourceMetadataStore');
  store.clearStore();
  return store;
};

const FM = (participant: string, date: string) => `---
source_type: meeting
participants:
  - "${participant}"
occurred_at: ${date}
---
# Meeting`;

describe('sourceMetadataStore — R2 cloud retain on search', () => {
  it('retains cloud entries WITHOUT fs.access-ing them, prunes a genuinely-missing LOCAL entry', async () => {
    const store = await setupModule();
    store.indexSource(`${CLOUD_PREFIX}meeting-cloud.md`, 'General/meeting-cloud.md', FM('Alice', '2026-01-15'), Date.now());
    store.indexSource('/workspace/Local/meeting-local.md', 'Local/meeting-local.md', FM('Bob', '2026-01-16'), Date.now());

    // The local file is MISSING; the cloud file would error too (dead mount) — but
    // it must never be fs-checked at all.
    mockAccess.mockImplementation(async (filePath: string) => {
      if (filePath.startsWith(CLOUD_PREFIX)) {
        throw Object.assign(new Error('ENOENT (dead mount)'), { code: 'ENOENT' });
      }
      // Local file missing → prune.
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    });

    const result = await store.searchSources({});

    // Cloud entry retained; local entry pruned.
    const paths = result.sources.map((s) => s.filePath).sort();
    expect(paths).toEqual([`${CLOUD_PREFIX}meeting-cloud.md`]);

    // fs.access was NEVER called on the cloud path.
    const accessedCloud = mockAccess.mock.calls.some(([p]) => p.startsWith(CLOUD_PREFIX));
    expect(accessedCloud).toBe(false);
    // fs.access WAS called on the local path (existing cheap check preserved).
    const accessedLocal = mockAccess.mock.calls.some(([p]) => p === '/workspace/Local/meeting-local.md');
    expect(accessedLocal).toBe(true);
  });

  it('a dead-mount search does not hang and does not prune cloud entries', async () => {
    const store = await setupModule();
    store.indexSource(`${CLOUD_PREFIX}a.md`, 'General/a.md', FM('Alice', '2026-01-15'), Date.now());
    store.indexSource(`${CLOUD_PREFIX}b.md`, 'General/b.md', FM('Bob', '2026-01-16'), Date.now());

    // Simulate a dead mount: fs.access NEVER settles. If the cloud entries were
    // fs-checked, this would hang the test (timeout). It must not be called.
    mockAccess.mockImplementation(() => new Promise<void>(() => {}));

    // Bounded by the test runner; resolves quickly because cloud entries skip access.
    const result = await store.searchSources({});

    expect(result.sources.map((s) => s.filePath).sort()).toEqual([
      `${CLOUD_PREFIX}a.md`,
      `${CLOUD_PREFIX}b.md`,
    ]);
    expect(mockAccess).not.toHaveBeenCalled();
  });

  it('local entries that exist are kept; the cheap fs.access check still runs for them', async () => {
    const store = await setupModule();
    store.indexSource('/workspace/Local/exists.md', 'Local/exists.md', FM('Carol', '2026-01-17'), Date.now());
    mockAccess.mockResolvedValue(undefined); // local file exists

    const result = await store.searchSources({});
    expect(result.sources.map((s) => s.filePath)).toEqual(['/workspace/Local/exists.md']);
    expect(mockAccess).toHaveBeenCalledWith('/workspace/Local/exists.md');
  });
});

/**
 * R2 with the REAL cloud-space containment, entries stored under the RESOLVED
 * cloud realpath (`~/Library/CloudStorage/…`) — the DOMINANT stored form (what
 * `fileIndexService.indexFileInternal` keys metadata under via `fs.realpath`).
 *
 * The describe block above mocks `isUnderCloudSpace` to a workspace-symlink prefix,
 * which masked the Stage-4b silent no-op: the real containment matched ONLY the
 * symlink prefix, so canonical-realpath entries fell through as `'local'` and got
 * fs-checked (the search-time hang the gate is meant to kill). Here we use the REAL
 * containment built from a real temp symlink and feed it canonical-form entries —
 * red against the symlink-only code, green once containment matches both forms.
 */
describe('sourceMetadataStore — R2 cloud retain with REAL containment (canonical-realpath form)', () => {
  let scratch: string;
  let workspaceRoot: string;
  let cloudTarget: string;

  const setupRealContainmentModule = async () => {
    vi.resetModules();
    mockAccess.mockReset();
    mockAccess.mockResolvedValue(undefined);
    await initTestPlatformConfig();
    // NOTE: only `node:fs/promises` (the async `access` the search uses) is mocked.
    // `node:fs` stays REAL so `cloudSpaceContainment`'s readlink-only build works on
    // the real temp symlink we create.
    vi.doMock('node:fs/promises', () => ({
      default: { access: mockAccess },
      access: mockAccess,
    }));
    vi.doMock('electron-store', () => {
      class MemoryStore<T extends Record<string, unknown>> {
        store: T;
        constructor(options: { defaults: T }) {
          this.store = structuredClone(options.defaults);
        }
        get(key: keyof T) {
          return this.store[key];
        }
        set(key: keyof T, value: T[keyof T]) {
          this.store[key] = value;
        }
      }
      return { default: MemoryStore };
    });
    vi.doMock('@core/logger', () => ({
      createScopedLogger: () => stubLogger,
    }));
    // The other describe block registers a `doMock` of cloudSpaceContainment that
    // survives `resetModules`; un-mock it so we exercise the REAL containment here.
    vi.doUnmock('@core/services/cloudSpaceContainment');
    // REAL containment + a stub liveness probe so the verdict resolves.
    const containment = await import('../../../core/services/cloudSpaceContainment');
    const probe = await import('../../../core/services/cloudLivenessProbe');
    probe.setCloudLivenessProbe({
      probeHealth: async () => 'degraded',
      getCachedVerdict: () => 'degraded',
    });
    containment.configureCloudSpaceContainment(workspaceRoot, [
      { name: 'General', path: 'General', type: 'other', isSymlink: true, createdAt: 0 },
    ]);
    const store = await import('../../../core/services/sourceMetadataStore');
    store.clearStore();
    return { store, containment };
  };

  afterEach(() => {
    if (scratch) fs.rmSync(scratch, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('retains a CANONICAL-realpath cloud entry WITHOUT fs.access-ing it; still prunes a missing local entry', async () => {
    scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'smeta-cloud-'));
    workspaceRoot = path.join(scratch, 'workspace');
    fs.mkdirSync(workspaceRoot, { recursive: true });
    cloudTarget = path.join(
      scratch,
      'Library',
      'CloudStorage',
      'GoogleDrive-test@example.com',
      'Shared drives',
      'General',
    );
    fs.symlinkSync(cloudTarget, path.join(workspaceRoot, 'General'));

    const { store, containment } = await setupRealContainmentModule();

    // Entry as STORED by indexFileInternal: under the RESOLVED cloud target, NOT
    // the workspace symlink path.
    const canonicalEntry = path.join(cloudTarget, 'meeting-cloud.md');
    expect(containment.isUnderCloudSpace(canonicalEntry)).toBe(true); // both forms now match
    store.indexSource(canonicalEntry, 'General/meeting-cloud.md', FM('Alice', '2026-01-15'), Date.now());
    store.indexSource('/workspace/Local/meeting-local.md', 'Local/meeting-local.md', FM('Bob', '2026-01-16'), Date.now());

    // Dead mount: fs.access on the cloud path would NEVER settle (a hang). The local
    // file is genuinely missing.
    mockAccess.mockImplementation(async (filePath: string) => {
      if (filePath.startsWith(cloudTarget)) {
        return new Promise<void>(() => {}); // never settles → would hang if checked
      }
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    });

    const result = await store.searchSources({});

    // Cloud entry retained (canonical form), local entry pruned.
    expect(result.sources.map((s) => s.filePath).sort()).toEqual([canonicalEntry]);
    // fs.access NEVER touched the dead cloud mount.
    const accessedCloud = mockAccess.mock.calls.some(([p]) => p.startsWith(cloudTarget));
    expect(accessedCloud).toBe(false);
    // The local entry's cheap fs.access still ran.
    const accessedLocal = mockAccess.mock.calls.some(([p]) => p === '/workspace/Local/meeting-local.md');
    expect(accessedLocal).toBe(true);
  });
});
