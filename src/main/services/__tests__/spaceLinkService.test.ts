import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import fsp from 'node:fs/promises';
import {
  setWorkspaceFsExecutor,
  __resetWorkspaceFsExecutorForTesting,
} from '@core/services/boundedWorkspaceFs';
import { realFsExecutorWith } from '@core/services/__tests__/workspaceFsExecutorDoubles';
import {
  configureCloudSpaceContainment,
  __resetCloudSpaceContainmentForTests,
} from '@core/services/cloudSpaceContainment';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock('electron-store', () => ({
  default: class {
    store: Record<string, unknown> = {};
    get = vi.fn((key: string) => this.store[key]);
    set = vi.fn((key: string, value: unknown) => { this.store[key] = value; });
    delete = vi.fn((key: string) => { delete this.store[key]; });
    has = vi.fn((key: string) => key in this.store);
  },
}));

// `resolveSpaceLink` now reads through the S4.1f `boundedWorkspaceFs` boundary
// (`boundedStat` → `workspaceFs.stat`). For a LOCAL path with no cloud-lane executor wired,
// the boundary takes the bare-fs LOCAL lane (`import fsp from 'node:fs/promises'`), so the
// stat stays interceptable here — but the boundary maps the result through `toWorkspaceStat`,
// which calls `isDirectory()`/`isFile()`/`isSymbolicLink()` (METHODS on fs.Stats) and exposes
// them as PROPERTIES on the returned `WorkspaceStat`. So the mock MUST return a complete
// `fs.Stats`-shaped object (all three predicate methods + the numeric fields), not a partial
// `{ isDirectory }` — a partial throws inside `toWorkspaceStat` → the boundary returns `error`
// → the resolver's catch collapses to `file-not-found`. Use {@link makeStat}.
const mockFsStat = vi.fn();
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    default: {
      ...actual,
      stat: (...args: unknown[]) => mockFsStat(...args),
    },
  };
});

const mockMatchPathToSpace = vi.fn();
vi.mock('../safety/memoryWriteHook', () => ({
  matchPathToSpace: (...args: unknown[]) => mockMatchPathToSpace(...args),
}));

const spaceService = await import('../spaceService');
type SpaceInfo = import('../spaceService').SpaceInfo;

/**
 * A complete `fs.Stats`-shaped stub. The boundary's `toWorkspaceStat` calls all three
 * predicate METHODS, so a partial `{ isDirectory }` throws there. Returning the full shape
 * lets the LOCAL lane produce a proper `WorkspaceStat` (predicates as PROPERTIES), exercising
 * the migrated read path exactly as production does for a local link target.
 */
function makeStat(isDir: boolean) {
  return {
    isDirectory: () => isDir,
    isFile: () => !isDir,
    isSymbolicLink: () => false,
    mtimeMs: 1,
    ctimeMs: 1,
    size: 0,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const CORE_DIR = '/users/test/workspace';

function makeSpace(overrides: Partial<SpaceInfo> & { name: string }): SpaceInfo {
  const name = overrides.name;
  return {
    path: overrides.path ?? `work/company/${name}`,
    absolutePath: overrides.absolutePath ?? path.join(CORE_DIR, 'work', 'company', name),
    type: overrides.type ?? 'team',
    isSymlink: false,
    hasReadme: true,
    displayName: overrides.displayName,
    frontmatter: overrides.frontmatter,
    ...overrides,
  };
}

beforeEach(() => {
  mockFsStat.mockReset();
  mockMatchPathToSpace.mockReset();
});

// ═══════════════════════════════════════════════════════════════════════════
// resolveSpaceByName
// ═══════════════════════════════════════════════════════════════════════════

describe('resolveSpaceByName', () => {
  it('matches by display name (case-insensitive)', async () => {
    const space = makeSpace({ name: 'Exec', displayName: 'Mindstone Exec' });
    const result = await spaceService.resolveSpaceByName('mindstone exec', CORE_DIR, [space]);
    expect(result).toBe(space);
  });

  it('trims whitespace from search name', async () => {
    const space = makeSpace({ name: 'Exec', displayName: 'Mindstone Exec' });
    const result = await spaceService.resolveSpaceByName('  Mindstone Exec  ', CORE_DIR, [space]);
    expect(result).toBe(space);
  });

  it('falls back to folder name when display name does not match', async () => {
    const space = makeSpace({ name: 'General', displayName: 'Company General' });
    const result = await spaceService.resolveSpaceByName('General', CORE_DIR, [space]);
    expect(result).toBe(space);
  });

  it('returns null when no space matches', async () => {
    const space = makeSpace({ name: 'Exec', displayName: 'Mindstone Exec' });
    const result = await spaceService.resolveSpaceByName('NonExistent', CORE_DIR, [space]);
    expect(result).toBeNull();
  });

  it('returns null for empty name', async () => {
    const result = await spaceService.resolveSpaceByName('', CORE_DIR, []);
    expect(result).toBeNull();
  });

  it('returns null for whitespace-only name', async () => {
    const result = await spaceService.resolveSpaceByName('   ', CORE_DIR, []);
    expect(result).toBeNull();
  });

  it('returns first match and logs warning when ambiguous', async () => {
    const space1 = makeSpace({ name: 'Exec1', path: 'work/a/Exec1', displayName: 'Exec' });
    const space2 = makeSpace({ name: 'Exec2', path: 'work/b/Exec2', displayName: 'Exec' });
    const result = await spaceService.resolveSpaceByName('Exec', CORE_DIR, [space1, space2]);
    expect(result).toBe(space1);
  });

  it('prefers display name match over folder name match', async () => {
    const byDisplay = makeSpace({ name: 'Folder1', displayName: 'Target' });
    const byFolder = makeSpace({ name: 'Target', displayName: 'Other Display' });
    const result = await spaceService.resolveSpaceByName('Target', CORE_DIR, [byDisplay, byFolder]);
    expect(result).toBe(byDisplay);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// resolveSpaceLink
// ═══════════════════════════════════════════════════════════════════════════

describe('resolveSpaceLink', () => {
  const space = makeSpace({
    name: 'Exec',
    displayName: 'Mindstone Exec',
    absolutePath: path.join(CORE_DIR, 'work', 'company', 'Exec'),
  });

  it('resolves space root when no filePath or folderPath given', async () => {
    const result = await spaceService.resolveSpaceLink(
      { spaceName: 'Mindstone Exec' },
      CORE_DIR,
      [space],
    );
    expect(result).toEqual({ absolutePath: space.absolutePath, space });
  });

  it('resolves space + file path to absolute path', async () => {
    const expectedPath = path.join(space.absolutePath, 'memory', 'topics', 'Q1.md');
    mockFsStat.mockResolvedValue(makeStat(false));

    const result = await spaceService.resolveSpaceLink(
      { spaceName: 'Mindstone Exec', filePath: 'memory/topics/Q1.md' },
      CORE_DIR,
      [space],
    );
    expect(result).toEqual({ absolutePath: expectedPath, space });
  });

  it('resolves folder path', async () => {
    const expectedPath = path.join(space.absolutePath, 'memory', 'topics');
    mockFsStat.mockResolvedValue(makeStat(true));

    const result = await spaceService.resolveSpaceLink(
      { spaceName: 'Mindstone Exec', folderPath: 'memory/topics' },
      CORE_DIR,
      [space],
    );
    expect(result).toEqual({ absolutePath: expectedPath, space });
  });

  it('returns space-not-found for unknown space', async () => {
    const result = await spaceService.resolveSpaceLink(
      { spaceName: 'NonExistent', filePath: 'file.md' },
      CORE_DIR,
      [],
    );
    expect(result).toEqual({ error: 'space-not-found' });
  });

  it('returns file-not-found when target does not exist', async () => {
    mockFsStat.mockRejectedValue(new Error('ENOENT'));

    const result = await spaceService.resolveSpaceLink(
      { spaceName: 'Mindstone Exec', filePath: 'memory/missing.md' },
      CORE_DIR,
      [space],
    );
    expect(result).toEqual({ error: 'file-not-found' });
  });

  it('returns path-invalid for traversal attempt', async () => {
    const result = await spaceService.resolveSpaceLink(
      { spaceName: 'Mindstone Exec', filePath: '../../etc/passwd' },
      CORE_DIR,
      [space],
    );
    expect(result).toEqual({ error: 'path-invalid' });
  });

  it('returns path-invalid when filePath points to a directory', async () => {
    mockFsStat.mockResolvedValue(makeStat(true));

    const result = await spaceService.resolveSpaceLink(
      { spaceName: 'Mindstone Exec', filePath: 'memory/topics' },
      CORE_DIR,
      [space],
    );
    expect(result).toEqual({ error: 'path-invalid' });
  });

  it('returns path-invalid when folderPath points to a file', async () => {
    mockFsStat.mockResolvedValue(makeStat(false));

    const result = await spaceService.resolveSpaceLink(
      { spaceName: 'Mindstone Exec', folderPath: 'memory/topics/Q1.md' },
      CORE_DIR,
      [space],
    );
    expect(result).toEqual({ error: 'path-invalid' });
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// filePathToSpaceLink
// ═══════════════════════════════════════════════════════════════════════════

describe('filePathToSpaceLink', () => {
  it('converts absolute path to space link', async () => {
    const space = makeSpace({ name: 'Exec', displayName: 'Mindstone Exec' });
    mockMatchPathToSpace.mockReturnValue(space);

    const filePath = path.join(space.absolutePath, 'memory', 'topics', 'Q1.md');
    const result = await spaceService.filePathToSpaceLink(filePath, CORE_DIR, [space]);

    expect(result).toEqual({
      spaceName: 'Mindstone Exec',
      relativePath: path.join('memory', 'topics', 'Q1.md'),
    });
  });

  it('returns null for paths outside any space', async () => {
    mockMatchPathToSpace.mockReturnValue(null);

    const result = await spaceService.filePathToSpaceLink('/tmp/random/file.md', CORE_DIR, []);
    expect(result).toBeNull();
  });

  it('returns null for chief-of-staff spaces', async () => {
    const space = makeSpace({ name: 'Chief-of-Staff', type: 'chief-of-staff' });
    mockMatchPathToSpace.mockReturnValue(space);

    const filePath = path.join(space.absolutePath, 'memory', 'file.md');
    const result = await spaceService.filePathToSpaceLink(filePath, CORE_DIR, [space]);
    expect(result).toBeNull();
  });

  it('returns null for spaces with sharing=private', async () => {
    const space = makeSpace({
      name: 'Private',
      frontmatter: { sharing: 'private' } as SpaceInfo['frontmatter'],
    });
    mockMatchPathToSpace.mockReturnValue(space);

    const filePath = path.join(space.absolutePath, 'memory', 'file.md');
    const result = await spaceService.filePathToSpaceLink(filePath, CORE_DIR, [space]);
    expect(result).toBeNull();
  });

  it('returns null for empty filePath', async () => {
    const result = await spaceService.filePathToSpaceLink('', CORE_DIR);
    expect(result).toBeNull();
  });

  it('uses folder name as spaceName when no display name set', async () => {
    const space = makeSpace({ name: 'Research' });
    mockMatchPathToSpace.mockReturnValue(space);

    const filePath = path.join(space.absolutePath, 'notes.md');
    const result = await spaceService.filePathToSpaceLink(filePath, CORE_DIR, [space]);

    expect(result).toEqual({
      spaceName: 'Research',
      relativePath: 'notes.md',
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// resolveSpaceLink — S4.1f cloud-reconnecting degrade (executor-double seam)
// ═══════════════════════════════════════════════════════════════════════════
//
// The migrated resolver reads through the bounded boundary's CLOUD lane when the target is
// cloud-classified (containment). A dead mount → the executor times out → the boundary maps it
// to `reconnecting` → `boundedStat` throws → the resolver's catch degrades to `file-not-found`
// (the reviewed-acceptable behaviour for a read-only resolver: the link just doesn't resolve;
// no write/delete follows). Driven with a REAL cloud-symlink space (target under home, so the
// path classifies cloud) + a wired executor whose `stat` times out — the same harness as the
// S4.1f write-path bounding tests.
describe('resolveSpaceLink — cloud reconnecting degrades to file-not-found', () => {
  let tmpRoot: string;
  let homeTmpRoot: string;
  let workspace: string;
  let cloudTarget: string;

  beforeEach(async () => {
    tmpRoot = await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), 'rebel-spacelink-')));
    workspace = path.join(tmpRoot, 'workspace');
    await fsp.mkdir(workspace);
    // Cloud target under HOME with a `Dropbox/` segment → pattern-cloud + write-safe.
    homeTmpRoot = await fsp.realpath(await fsp.mkdtemp(path.join(os.homedir(), '.rebel-spacelink-test-')));
    cloudTarget = path.join(homeTmpRoot, 'Dropbox', 'Shared', 'Exec');
    await fsp.mkdir(cloudTarget, { recursive: true });
    __resetCloudSpaceContainmentForTests();
  });

  afterEach(async () => {
    __resetWorkspaceFsExecutorForTesting();
    __resetCloudSpaceContainmentForTests();
    await fsp.rm(tmpRoot, { recursive: true, force: true }).catch(() => {});
    await fsp.rm(homeTmpRoot, { recursive: true, force: true }).catch(() => {});
  });

  it('a reconnecting cloud stat → file-not-found (resolver degrades, never hangs)', async () => {
    // Register a cloud-symlink space so the joined target path classifies cloud (containment).
    const link = path.join(workspace, 'Exec');
    await fsp.symlink(cloudTarget, link);
    configureCloudSpaceContainment(workspace, [
      { name: 'Exec', path: 'Exec', type: 'other', isSymlink: true, sourcePath: cloudTarget, createdAt: 0 } as never,
    ]);
    // Executor whose stat times out → boundary maps to `reconnecting`.
    setWorkspaceFsExecutor(realFsExecutorWith({ stat: () => Promise.resolve({ ok: false, reason: 'timeout' }) }));

    const space = {
      name: 'Exec',
      path: 'Exec',
      absolutePath: link,
      type: 'other',
      isSymlink: true,
      hasReadme: false,
      displayName: 'Exec',
    } as unknown as SpaceInfo;

    const result = await spaceService.resolveSpaceLink(
      { spaceName: 'Exec', filePath: 'memory/Q1.md' },
      workspace,
      [space],
    );

    expect(result).toEqual({ error: 'file-not-found' });
  });
});
