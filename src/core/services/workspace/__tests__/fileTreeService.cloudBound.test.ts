/**
 * S4.1b (was Stage 7 site b) — fileTreeService degrades (does not hang) when an
 * ADMITTED cloud subtree's read comes back cloud-UNAVAILABLE. The Stage-7 bespoke
 * `runCloudBoundedFsOp` timer is RETIRED: cloud reads are now bounded inside the
 * `WorkspaceFileSystem` impl (electron + guardedPath → the killable-pool boundary),
 * which surfaces a dead/unreachable mount as a thrown `CloudReconnecting`
 * `WorkspaceFileSystemError` rather than a hanging promise. This suite therefore
 * verifies fileTreeService's CONTRACT with that boundary: an admitted cloud symlink is
 * descended, and a `CloudReconnecting` (or any error) from its `listDirectory` degrades
 * the node to unavailable / incomplete — never blocks. (The dead-mount→reconnecting
 * bounding itself is proven at the boundary/impl level.) Flag OFF stays byte-identical
 * (cloud excluded as `cloudSkip`, never descended).
 *
 * Admission resolution itself is mocked here (covered by the safeWalkDirectory admission
 * suite); we drive the symlink's resolved target via the WorkspaceFileSystem mock so the
 * real `shouldSkipCloudSymlinkTarget` flags it as cloud, then control whether it's
 * admitted, and assert the degradation behaviour.
 */
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// A Google-Drive-classified target so the real `shouldSkipCloudSymlinkTarget` (pattern)
// flags the symlink as a cloud mount → fileTreeService consults admission for it.
const CLOUD_TARGET =
  '/Users/test/Library/CloudStorage/GoogleDrive-user@example.com/Shared drives/Company Memories';

// S4.1b: this suite's focus is fileTreeService's DEGRADATION when an admitted cloud
// subtree's read comes back cloud-unavailable — NOT admission resolution (that is the
// safeWalkDirectory admission suite's job). So we mock the admission decision directly
// and drive the symlink's resolved target via the WorkspaceFileSystem mock. This avoids
// the readlink/`node:fs` mock entirely (whose async-factory timing is fragile under this
// suite's deep import graph), keeping the test about the boundary CONTRACT.
const mockAdmission = vi.hoisted(() => vi.fn<(symlinkPath: string) => 'admit' | 'skip'>());
vi.mock('@core/services/cloudSymlinkIndexing', () => ({
  resolveCloudSymlinkAdmission: (p: string) => mockAdmission(p),
  isCloudSymlinkIndexingEnabled: () => true,
  setCloudSymlinkIndexingEnabled: vi.fn(),
  __resetCloudSymlinkIndexingForTests: vi.fn(),
}));

const {
  setWorkspaceFileSystemFactory,
} = await import('@core/workspaceFileSystem');

/** Mimics the CloudReconnecting WorkspaceFileSystemError the real impl/boundary throws
 *  on a dead cloud mount. fileTreeService's catch handles it generically. */
function cloudReconnectingError(): Error {
  return Object.assign(new Error('cloud mount unavailable'), {
    name: 'WorkspaceFileSystemError',
    code: 'CloudReconnecting',
  });
}
type WorkspaceDirectoryEntry = import('@core/workspaceFileSystem').WorkspaceDirectoryEntry;
type WorkspaceFileSystem = import('@core/workspaceFileSystem').WorkspaceFileSystem;
type WorkspacePathStat = import('@core/workspaceFileSystem').WorkspacePathStat;
const { buildFileTree } = await import('../fileTreeService');

class MockWorkspaceFileSystem implements WorkspaceFileSystem {
  public listDirectoryMock = vi.fn<
    (workspaceRoot: string, targetPath: string) => Promise<WorkspaceDirectoryEntry[]>
  >();
  public realPathMock = vi.fn<(workspaceRoot: string, targetPath: string) => Promise<string>>();
  public statMock = vi.fn<(workspaceRoot: string, targetPath: string) => Promise<WorkspacePathStat>>();
  listDirectory(r: string, t: string): Promise<WorkspaceDirectoryEntry[]> {
    return this.listDirectoryMock(r, t);
  }
  realPath(r: string, t: string): Promise<string> {
    return this.realPathMock(r, t);
  }
  stat(r: string, t: string): Promise<WorkspacePathStat> {
    return this.statMock(r, t);
  }
  async readFile(): Promise<string> {
    throw new Error('unused');
  }
  async writeFile(): Promise<void> {
    throw new Error('unused');
  }
  async deleteFile(): Promise<void> {
    throw new Error('unused');
  }
  async exists(): Promise<boolean> {
    throw new Error('unused');
  }
}

describe('buildFileTree — S4.1b admitted-cloud degradation (site b)', () => {
  const workspaceRoot = path.resolve('/workspace');

  beforeEach(() => {
    mockAdmission.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('an admitted cloud subtree whose listDirectory comes back UNAVAILABLE (CloudReconnecting) DEGRADES (does not hang)', async () => {
    mockAdmission.mockReturnValue('admit'); // flag on + healthy verdict → descend
    const fsmock = new MockWorkspaceFileSystem();
    fsmock.realPathMock.mockImplementation(async (_root, targetPath) => {
      if (targetPath === '.') return workspaceRoot;
      if (targetPath === 'Company Memories') return CLOUD_TARGET;
      return path.join(workspaceRoot, targetPath);
    });
    fsmock.statMock.mockImplementation(async (_root, targetPath) => {
      if (targetPath === 'Company Memories') return { isDirectory: true, mtimeMs: 1 };
      return { isDirectory: false, mtimeMs: 1 };
    });
    fsmock.listDirectoryMock.mockImplementation(async (_root, targetPath) => {
      if (targetPath === '.') {
        return [
          { name: 'local.md', isDirectory: false, isSymbolicLink: false },
          { name: 'Company Memories', isDirectory: false, isSymbolicLink: true },
        ];
      }
      // The admitted cloud subtree's read comes back cloud-UNAVAILABLE: the boundary
      // (inside the real impl) killed the wedged child and surfaced CloudReconnecting.
      // fileTreeService must degrade the node, not hang or wipe it.
      throw cloudReconnectingError();
    });
    setWorkspaceFileSystemFactory(() => fsmock);

    const { nodes: tree, metadata } = await buildFileTree(workspaceRoot, workspaceRoot, 0, true);

    // The build COMPLETED (did not hang). The admitted cloud node is present (admission
    // descended into it) and degraded to unavailable/empty.
    const cloudNode = tree.find((n) => n.name === 'Company Memories');
    expect(cloudNode).toBeDefined();
    // The unavailable subtree makes the walk incomplete, not a hang.
    expect(metadata.complete).toBe(false);
    expect(metadata.unavailableNodes).toBeGreaterThan(0);
    // The local file is still present (the unavailable cloud subtree didn't block it).
    expect(tree.some((n) => n.name === 'local.md')).toBe(true);
  });

  it('not admitted (flag OFF / skip): the cloud symlink is excluded (cloudSkip) and listDirectory is never called on it (byte-identical)', async () => {
    mockAdmission.mockReturnValue('skip'); // flag off (or unhealthy) → not admitted
    const fsmock = new MockWorkspaceFileSystem();
    fsmock.realPathMock.mockImplementation(async (_root, targetPath) => {
      if (targetPath === '.') return workspaceRoot;
      if (targetPath === 'Company Memories') return CLOUD_TARGET;
      return path.join(workspaceRoot, targetPath);
    });
    fsmock.statMock.mockImplementation(async (_root, targetPath) => {
      if (targetPath === 'Company Memories') return { isDirectory: true, mtimeMs: 1 };
      return { isDirectory: false, mtimeMs: 1 };
    });
    fsmock.listDirectoryMock.mockImplementation(async (_root, targetPath) => {
      if (targetPath === '.') {
        return [{ name: 'Company Memories', isDirectory: false, isSymbolicLink: true }];
      }
      return [{ name: 'should-not-be-walked.md', isDirectory: false, isSymbolicLink: false }];
    });
    setWorkspaceFileSystemFactory(() => fsmock);

    const { nodes: tree, metadata } = await buildFileTree(workspaceRoot, workspaceRoot, 0, true);

    const cloudNode = tree.find((n) => n.name === 'Company Memories');
    expect(cloudNode).toMatchObject({ name: 'Company Memories', kind: 'directory' });
    expect((cloudNode as { children?: unknown[] }).children).toHaveLength(0);
    // Never recursed into the cloud target → no listDirectory for it.
    const cloudListCalls = fsmock.listDirectoryMock.mock.calls.filter(
      ([, targetPath]) => targetPath === 'Company Memories',
    );
    expect(cloudListCalls).toHaveLength(0);
    // Skipping a cloud mount with the flag off is a deliberate COMPLETE result.
    expect(metadata.complete).toBe(true);
  });
});
