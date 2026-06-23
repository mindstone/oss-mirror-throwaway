/**
 * S4.1f Stage 2 — libraryHandlers write/create/rename/delete/symlink/import read-path
 * bounding. The data-safety crux: a write-path existence/CAS/security pre-read that hits a
 * `reconnecting` cloud mount must ABORT the operation (fail to the handler's error/`failed`
 * envelope), NEVER degrade to "absent"/"not-a-symlink"/"keep going" and proceed to a
 * destructive op (silent overwrite/delete/corruption).
 *
 * REAL temp-dir fixtures + a wired cloud-lane executor double: a cloud-symlink space
 * (containment-configured, target under home so write-safety passes) makes the space's reads
 * classify cloud; `deadCloudExecutor()` resolves every cloud op to `reconnecting`. LOCAL
 * reads use real fs. Mirrors libraryHandlers.coldCacheScanBound.test.ts.
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';

const registeredHandlers = new Map<string, (event: unknown, request: unknown) => unknown>();
const mockGetSettings = vi.fn();

vi.mock('../utils/registerHandler', () => ({
  registerHandler: vi.fn((channel: string, handler: (event: unknown, request: unknown) => unknown) => {
    registeredHandlers.set(channel, handler);
  }),
}));

vi.mock('@core/services/settingsStore', () => ({
  setSettingsStoreAdapter: vi.fn(),
  getSettings: () => mockGetSettings(),
  updateSettingsAtomic: vi.fn(),
}));

vi.mock('../../tracking', () => ({ mainTracking: { workArtifactCreated: vi.fn() }, trackPrivateSkillCreated: vi.fn() }));

vi.mock('@core/logger', () => {
  const noop = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), trace: vi.fn() };
  return { logger: noop, createScopedLogger: () => noop };
});

vi.mock('@core/platform', () => ({
  getPlatformConfig: () => ({ getPath: () => '/mock/app-data', getVersion: () => '1.0.0', isPackaged: false, appPath: '/mock/app', userDataPath: '/mock/userData' }),
}));

vi.mock('@core/featureGating', () => ({ isFeatureEnabled: vi.fn().mockReturnValue(false) }));
vi.mock('../../services/demoModeService', () => ({ isDemoModeActive: vi.fn().mockReturnValue(false) }));
vi.mock('../../services/fileTreeService', () => ({ buildFileTree: vi.fn(), countLibraryItems: vi.fn() }));
vi.mock('electron-store', () => ({
  default: class {
    store: Record<string, unknown> = {};
    get = vi.fn();
    set = vi.fn();
    delete = vi.fn();
    has = vi.fn();
  },
}));

let registerLibraryHandlers: typeof import('../libraryHandlers').registerLibraryHandlers;
let setWorkspaceFsExecutor: typeof import('@core/services/boundedWorkspaceFs').setWorkspaceFsExecutor;
let __resetWorkspaceFsExecutorForTesting: typeof import('@core/services/boundedWorkspaceFs').__resetWorkspaceFsExecutorForTesting;
let realFsExecutorWith: typeof import('@core/services/__tests__/workspaceFsExecutorDoubles').realFsExecutorWith;
let realFsExecutor: typeof import('@core/services/__tests__/workspaceFsExecutorDoubles').realFsExecutor;
let configureCloudSpaceContainment: typeof import('@core/services/cloudSpaceContainment').configureCloudSpaceContainment;
let __resetCloudSpaceContainmentForTests: typeof import('@core/services/cloudSpaceContainment').__resetCloudSpaceContainmentForTests;

let tmpRoot: string;
let homeTmpRoot: string;
let workspace: string;
let cloudTarget: string;

const handler = (channel: string) => registeredHandlers.get(channel)!;

/** Every cloud-lane op resolves `reconnecting`; LOCAL reads use real fs. */
function deadCloudExecutor() {
  const timeout = () => Promise.resolve({ ok: false, reason: 'timeout' } as const);
  return realFsExecutorWith({
    stat: timeout, lstat: timeout, realpath: timeout, readlink: timeout,
    readdir: timeout, readdirWithFileTypes: timeout, readFile: timeout, readFileBytes: timeout, access: timeout,
  });
}

beforeEach(async () => {
  registeredHandlers.clear();
  ({ registerLibraryHandlers } = await import('../libraryHandlers'));
  ({ setWorkspaceFsExecutor, __resetWorkspaceFsExecutorForTesting } = await import('@core/services/boundedWorkspaceFs'));
  ({ realFsExecutorWith, realFsExecutor } = await import('@core/services/__tests__/workspaceFsExecutorDoubles'));
  ({ configureCloudSpaceContainment, __resetCloudSpaceContainmentForTests } = await import('@core/services/cloudSpaceContainment'));

  __resetWorkspaceFsExecutorForTesting();
  __resetCloudSpaceContainmentForTests();

  // Workspace root is LOCAL (real fs); a cloud-symlink space `General` points at a target
  // under HOME (write-safe) so write-path handlers pass the write-safety guard.
  tmpRoot = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'rebel-lh-s41f-')));
  workspace = path.join(tmpRoot, 'workspace');
  await fs.mkdir(workspace);
  homeTmpRoot = await fs.realpath(await fs.mkdtemp(path.join(os.homedir(), '.rebel-lh-s41f-test-')));
  cloudTarget = path.join(homeTmpRoot, 'Dropbox', 'Shared', 'General');
  await fs.mkdir(cloudTarget, { recursive: true });
  await fs.symlink(cloudTarget, path.join(workspace, 'General'));
  configureCloudSpaceContainment(workspace, [
    { name: 'General', path: 'General', type: 'other', isSymlink: true, sourcePath: cloudTarget, createdAt: 0 } as never,
  ]);

  mockGetSettings.mockReturnValue({
    coreDirectory: workspace,
    spaces: [{ name: 'General', path: 'General', isSymlink: true, sourcePath: cloudTarget }],
  });

  registerLibraryHandlers({
    getSettings: mockGetSettings,
    getSettingsStore: () => ({ store: mockGetSettings() }),
  } as unknown as Parameters<typeof registerLibraryHandlers>[0]);
});

afterEach(async () => {
  __resetWorkspaceFsExecutorForTesting();
  __resetCloudSpaceContainmentForTests();
  await fs.rm(tmpRoot, { recursive: true, force: true }).catch(() => {});
  await fs.rm(homeTmpRoot, { recursive: true, force: true }).catch(() => {});
});

describe('libraryHandlers — S4.1f write-path read bounding (fail-closed on reconnecting)', () => {
  it('write-file CAS: a reconnecting read → {result:"failed"}, NO write (no overwrite-with-stale)', async () => {
    // Existing README in the cloud space; the CAS read (baseContentHash set) reconnects →
    // the handler must return the `failed` envelope, NEVER fall through to fs.writeFile.
    const target = 'General/doc.md';
    await fs.writeFile(path.join(cloudTarget, 'doc.md'), 'ORIGINAL content that must survive');
    setWorkspaceFsExecutor(deadCloudExecutor());

    const res = (await handler('library:write-file')({}, {
      path: target,
      content: 'NEW content',
      baseContentHash: 'deadbeef',
    })) as { result: string };

    expect(res.result).toBe('failed'); // fail-closed, not 'ok'/'conflict'
    expect(await fs.readFile(path.join(cloudTarget, 'doc.md'), 'utf-8')).toBe('ORIGINAL content that must survive');
  });

  it('create-file: a reconnecting collision probe ABORTS — does NOT create over an unreachable existing path', async () => {
    setWorkspaceFsExecutor(deadCloudExecutor());
    await expect(
      Promise.resolve(handler('library:create-file')({}, { parentPath: 'General', fileName: 'new.md' })),
    ).rejects.toThrow();
    // No file created in the (unreachable) cloud space.
    await expect(fs.access(path.join(cloudTarget, 'new.md'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('delete-item: a reconnecting type probe ABORTS — NO blind delete', async () => {
    await fs.writeFile(path.join(cloudTarget, 'keep.md'), 'must survive');
    setWorkspaceFsExecutor(deadCloudExecutor());
    await expect(Promise.resolve(handler('library:delete-item')({}, { itemPath: 'General/keep.md' }))).rejects.toThrow();
    await expect(fs.stat(path.join(cloudTarget, 'keep.md'))).resolves.toBeDefined();
  });

  it('remove-symlink: a reconnecting verify probe ABORTS — NO unlink', async () => {
    setWorkspaceFsExecutor(deadCloudExecutor());
    const res = (await handler('library:remove-symlink')({}, { symlinkPath: 'General' })) as { success: boolean };
    expect(res.success).toBe(false);
    await expect(fs.lstat(path.join(workspace, 'General'))).resolves.toBeDefined(); // symlink intact
  });

  it('import-image-asset (SECURITY): a reconnecting assets-dir lstat FAILS CLOSED — never writes into an unverified dir', async () => {
    // The markdown doc lives in the cloud space; the assets-dir security lstat reconnects →
    // must throw (deny), never read "no dir → safe to write".
    await fs.writeFile(path.join(cloudTarget, 'note.md'), '# note');
    setWorkspaceFsExecutor(deadCloudExecutor());
    await expect(
      Promise.resolve(handler('library:import-image-asset')({}, {
        documentPath: 'General/note.md',
        fileName: 'pic.png',
        mimeType: 'image/png',
        dataBase64: Buffer.from([1, 2, 3]).toString('base64'),
      })),
    ).rejects.toThrow();
  });

  it('error(ENOENT) preserved: write-file CAS on a genuinely-missing LOCAL file is a new-file write (not failed)', async () => {
    // A LOCAL (non-cloud) workspace path that does not exist → ENOENT → new-file write succeeds.
    setWorkspaceFsExecutor(realFsExecutor);
    const res = (await handler('library:write-file')({}, {
      path: 'local-notes.md',
      content: 'hello',
      baseContentHash: 'whatever',
    })) as { result: string };
    expect(res.result).toBe('ok'); // ENOENT → new file, today's behaviour preserved
    expect(await fs.readFile(path.join(workspace, 'local-notes.md'), 'utf-8')).toBe('hello');
  });
});
