import { describe, it, expect, vi, beforeEach } from 'vitest';
import path from 'node:path';
import { parseNavigationUrl, formatNavigationUrl } from '@shared/navigation/urlParser';

vi.mock('electron-store', () => ({
  default: class {
    store: Record<string, unknown> = {};
    get = vi.fn((key: string) => this.store[key]);
    set = vi.fn((key: string, value: unknown) => { this.store[key] = value; });
    delete = vi.fn((key: string) => { delete this.store[key]; });
    has = vi.fn((key: string) => key in this.store);
  },
}));

// `resolveSpaceLink` now reads through the S4.1f `boundedWorkspaceFs` boundary. The LOCAL lane
// maps the stat via `toWorkspaceStat`, which calls `isDirectory()`/`isFile()`/`isSymbolicLink()`
// (METHODS) and exposes them as PROPERTIES — so the stat stub must be a COMPLETE `fs.Stats` shape
// (see {@link makeStat}). A partial `{ isDirectory }` throws inside `toWorkspaceStat` → the
// boundary returns `error` → the resolver collapses to `file-not-found`.
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

/** A complete `fs.Stats`-shaped stub (predicate METHODS) so the boundary's `toWorkspaceStat`
 *  produces a proper `WorkspaceStat` and the migrated LOCAL read lane resolves correctly. */
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

const CORE_DIR = '/users/test/workspace';

function makeSpace(overrides: Partial<SpaceInfo> & { name: string }): SpaceInfo {
  return {
    path: overrides.path ?? `work/company/${overrides.name}`,
    absolutePath: overrides.absolutePath ?? path.join(CORE_DIR, 'work', 'company', overrides.name),
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

/**
 * Full pipeline: absolute path → space link → URL → parse → resolve → absolute path.
 * This tests the entire flow a real user would experience:
 * 1. Rebel generates a link from an absolute file path (filePathToSpaceLink)
 * 2. The link is formatted as a rebel://space/ URL (formatNavigationUrl)
 * 3. A different user clicks it → URL is parsed (parseNavigationUrl)
 * 4. The parsed target is resolved to their local path (resolveSpaceLink)
 */
describe('space link full pipeline', () => {
  it('round-trips: absolute path → URL → parsed target → resolved path', async () => {
    const space = makeSpace({
      name: 'Exec',
      displayName: 'Mindstone Exec',
      absolutePath: path.join(CORE_DIR, 'work', 'company', 'Exec'),
    });
    const originalFile = path.join(space.absolutePath, 'memory', 'topics', 'Q1.md');

    // Step 1: File path → space link
    mockMatchPathToSpace.mockReturnValue(space);
    const spaceLink = await spaceService.filePathToSpaceLink(originalFile, CORE_DIR, [space]);
    expect(spaceLink).not.toBeNull();
    expect(spaceLink!.spaceName).toBe('Mindstone Exec');
    expect(spaceLink!.relativePath).toBe('memory/topics/Q1.md');

    // Step 2: Space link → URL
    const url = formatNavigationUrl({
      type: 'space',
      spaceName: spaceLink!.spaceName,
      filePath: spaceLink!.relativePath,
    });
    expect(url).toContain('rebel://space/');
    expect(url).toContain('Mindstone%20Exec');

    // Step 3: URL → parsed target
    const parsed = parseNavigationUrl(url);
    expect(parsed).not.toBeNull();
    expect(parsed!.type).toBe('space');
    if (parsed!.type !== 'space') throw new Error('unexpected');
    expect(parsed!.spaceName).toBe('Mindstone Exec');
    expect(parsed!.filePath).toBe('memory/topics/Q1.md');

    // Step 4: Parsed target → resolved absolute path (on recipient's machine)
    mockFsStat.mockResolvedValue(makeStat(false));
    const resolved = await spaceService.resolveSpaceLink(
      { spaceName: parsed!.spaceName, filePath: parsed!.filePath },
      CORE_DIR,
      [space],
    );
    expect(resolved).toEqual({ absolutePath: originalFile, space });
  });

  it('round-trips: folder path', async () => {
    const space = makeSpace({
      name: 'General',
      displayName: 'Mindstone General',
    });
    const folderPath = path.join(space.absolutePath, 'skills', 'weekly-report');

    mockMatchPathToSpace.mockReturnValue(space);
    const spaceLink = await spaceService.filePathToSpaceLink(folderPath, CORE_DIR, [space]);
    expect(spaceLink).not.toBeNull();

    const url = formatNavigationUrl({
      type: 'space',
      spaceName: spaceLink!.spaceName,
      folderPath: spaceLink!.relativePath,
    });

    const parsed = parseNavigationUrl(url);
    expect(parsed).not.toBeNull();
    if (parsed!.type !== 'space') throw new Error('unexpected');
    expect(parsed!.folderPath).toBe('skills/weekly-report');

    mockFsStat.mockResolvedValue(makeStat(true));
    const resolved = await spaceService.resolveSpaceLink(
      { spaceName: parsed!.spaceName, folderPath: parsed!.folderPath },
      CORE_DIR,
      [space],
    );
    expect(resolved).toEqual({ absolutePath: folderPath, space });
  });

  it('private spaces produce null link (no URL generated)', async () => {
    const privateSpace = makeSpace({
      name: 'Chief-of-Staff',
      type: 'chief-of-staff',
    });
    const filePath = path.join(privateSpace.absolutePath, 'memory', 'personal.md');

    mockMatchPathToSpace.mockReturnValue(privateSpace);
    const spaceLink = await spaceService.filePathToSpaceLink(filePath, CORE_DIR, [privateSpace]);
    expect(spaceLink).toBeNull();
  });

  it('workspace-relative path is correct for IPC handler simulation', async () => {
    const space = makeSpace({
      name: 'Exec',
      displayName: 'Mindstone Exec',
      absolutePath: path.join(CORE_DIR, 'work', 'company', 'Exec'),
    });

    mockFsStat.mockResolvedValue(makeStat(false));
    const resolved = await spaceService.resolveSpaceLink(
      { spaceName: 'Mindstone Exec', filePath: 'memory/Q1.md' },
      CORE_DIR,
      [space],
    );

    // Simulate what the IPC handler does: path.relative(coreDirectory, absolutePath)
    expect(resolved).not.toHaveProperty('error');
    if ('error' in resolved) throw new Error('unexpected');
    const workspaceRelative = path.relative(CORE_DIR, resolved.absolutePath);
    expect(workspaceRelative).toBe(path.join('work', 'company', 'Exec', 'memory', 'Q1.md'));
  });
});
