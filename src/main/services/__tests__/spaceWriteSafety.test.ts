import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  WriteOutsideWorkspaceError,
  assertSpaceWriteSafe,
  isProtectedRootName,
  isUnderWin32Path,
} from '../spaceWriteSafety';

let scratchRoot: string;
let realScratchRoot: string;

beforeEach(async () => {
  scratchRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'rebel-space-write-safety-'));
  realScratchRoot = await fs.realpath(scratchRoot);
});

afterEach(async () => {
  await fs.rm(scratchRoot, { recursive: true, force: true });
});

describe('isProtectedRootName', () => {
  it('matches exact protected names case-insensitively', () => {
    for (const name of ['rebel-system', 'REBEL-SYSTEM', 'Rebel-System', 'super-mcp', 'SUPER-MCP']) {
      expect(isProtectedRootName(name)).toBe(true);
    }
  });

  it('matches conflicted-copy / numbered / backup / copy variants', () => {
    const variants = [
      "rebel-system (Greg's MacBook Air's conflicted copy 2026-04-21)",
      'rebel-system 2',
      'rebel-system (1)',
      'rebel-system.backup',
      'rebel-system copy',
      'super-mcp (conflicted copy 2026-04-21)',
      'super-mcp 2',
      'super-mcp.backup',
    ];
    for (const name of variants) {
      expect(isProtectedRootName(name)).toBe(true);
    }
  });

  it('does NOT match false-positive look-alike names', () => {
    const safeNames = [
      'rebel-system-extras',
      'rebel-system-fork',
      'my-rebel-system-fork',
      'rebel-systems',
      'super-mcp-extras',
      'super-mcps',
      '',
      'rebel',
      'super',
    ];
    for (const name of safeNames) {
      expect(isProtectedRootName(name)).toBe(false);
    }
  });

  it('returns false for non-string input', () => {
    expect(isProtectedRootName(undefined as unknown as string)).toBe(false);
    expect(isProtectedRootName(null as unknown as string)).toBe(false);
    expect(isProtectedRootName(123 as unknown as string)).toBe(false);
  });
});

describe('assertSpaceWriteSafe — accepts', () => {
  it('accepts a path inside the workspace and returns its realpath', async () => {
    const workspace = path.join(realScratchRoot, 'workspace');
    const spaceDir = path.join(workspace, 'my-space');
    await fs.mkdir(spaceDir, { recursive: true });

    const resolved = await assertSpaceWriteSafe(workspace, spaceDir, {
      platform: 'darwin',
      homedir: realScratchRoot,
      resourcesPath: '',
    });

    expect(resolved).toBe(spaceDir);
  });

  it('accepts a first-write path (target does not yet exist) when the parent directory is inside the workspace', async () => {
    const workspace = path.join(realScratchRoot, 'workspace');
    const spaceDir = path.join(workspace, 'my-space');
    await fs.mkdir(spaceDir, { recursive: true });
    const newReadme = path.join(spaceDir, 'README.md');

    const resolved = await assertSpaceWriteSafe(workspace, newReadme, {
      platform: 'darwin',
      homedir: realScratchRoot,
      resourcesPath: '',
    });

    expect(resolved).toBe(newReadme);
  });

  it('accepts a symlinked space whose realpath is under the user home (legitimate cloud-shared space)', async () => {
    const workspace = path.join(realScratchRoot, 'workspace');
    await fs.mkdir(workspace, { recursive: true });
    const cloudShared = path.join(realScratchRoot, 'home', 'Dropbox', 'shared-space');
    await fs.mkdir(cloudShared, { recursive: true });
    const symlinkedSpace = path.join(workspace, 'shared');
    await fs.symlink(cloudShared, symlinkedSpace);

    const resolved = await assertSpaceWriteSafe(workspace, symlinkedSpace, {
      platform: 'darwin',
      homedir: path.join(realScratchRoot, 'home'),
      resourcesPath: '',
    });

    expect(resolved).toBe(cloudShared);
  });
});

describe('assertSpaceWriteSafe — rejects', () => {
  it('rejects a path whose realpath is under process.resourcesPath', async () => {
    const workspace = path.join(realScratchRoot, 'workspace');
    await fs.mkdir(workspace, { recursive: true });
    const fakeBundle = path.join(realScratchRoot, 'fake-bundle');
    const bundledRebelSystem = path.join(fakeBundle, 'rebel-system');
    await fs.mkdir(bundledRebelSystem, { recursive: true });
    const rogueSymlink = path.join(workspace, 'rebel-system');
    await fs.symlink(bundledRebelSystem, rogueSymlink);

    await expect(
      assertSpaceWriteSafe(workspace, rogueSymlink, {
        platform: 'darwin',
        homedir: path.join(realScratchRoot, 'home'),
        resourcesPath: fakeBundle,
      }),
    ).rejects.toMatchObject({
      name: 'WriteOutsideWorkspaceError',
      reason: 'under-resources-path',
    });
  });

  it('rejects a path whose realpath is under /Applications/ on darwin', async () => {
    const workspace = path.join(realScratchRoot, 'workspace');
    await fs.mkdir(workspace, { recursive: true });
    const fakeApp = '/Applications/Mindstone Rebel Beta.app/Contents/Resources/rebel-system';

    let caught: unknown = null;
    try {
      await assertSpaceWriteSafe(workspace, fakeApp, {
        platform: 'darwin',
        homedir: path.join(realScratchRoot, 'home'),
        resourcesPath: '',
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(WriteOutsideWorkspaceError);
    expect((caught as WriteOutsideWorkspaceError).reason).toBe('under-applications');
  });

  it('rejects under /System on darwin even when path does not exist', async () => {
    const workspace = path.join(realScratchRoot, 'workspace');
    await fs.mkdir(workspace, { recursive: true });

    await expect(
      assertSpaceWriteSafe(workspace, '/System/Library/Frameworks/Frob.framework/foo', {
        platform: 'darwin',
        homedir: path.join(realScratchRoot, 'home'),
        resourcesPath: '',
      }),
    ).rejects.toMatchObject({
      reason: 'under-system-root',
    });
  });

  it('rejects when realpath escapes workspace and is not under home', async () => {
    // Use a separate tmpdir for the external area so the macOS denylist
    // does NOT see both paths under the same `/private/var/folders/...`
    // subtree (we want the test to exercise the escapes-workspace-and-
    // not-under-home reason, not under-system-root).
    const externalScratch = await fs.mkdtemp(
      path.join(os.tmpdir(), 'rebel-write-safety-external-'),
    );
    try {
      const realExternalScratch = await fs.realpath(externalScratch);
      const workspace = path.join(realScratchRoot, 'workspace');
      await fs.mkdir(workspace, { recursive: true });
      const externalArea = path.join(realExternalScratch, 'somewhere-else');
      await fs.mkdir(externalArea, { recursive: true });
      const symlink = path.join(workspace, 'maybe-space');
      await fs.symlink(externalArea, symlink);

      await expect(
        assertSpaceWriteSafe(workspace, symlink, {
          platform: 'darwin',
          // Force home to a path that does NOT cover externalArea, so we
          // hit the final reject rather than the under-home accept.
          homedir: path.join(realScratchRoot, 'home'),
          resourcesPath: '',
        }),
      ).rejects.toMatchObject({
        reason: 'escapes-workspace-and-not-under-home',
      });
    } finally {
      await fs.rm(externalScratch, { recursive: true, force: true });
    }
  });
});

describe('isUnderWin32Path', () => {
  it('matches an exact win32 root', () => {
    expect(isUnderWin32Path('C:\\Program Files', 'C:\\Program Files')).toBe(true);
  });

  it('matches a child path of a win32 root', () => {
    expect(
      isUnderWin32Path('C:\\Program Files\\Mindstone Rebel\\rebel-system', 'C:\\Program Files'),
    ).toBe(true);
  });

  it('is case-insensitive (Windows is case-insensitive on disk)', () => {
    expect(
      isUnderWin32Path('c:\\program files\\subdir\\foo', 'C:\\Program Files'),
    ).toBe(true);
  });

  it('does not match a sibling that shares a prefix', () => {
    expect(
      isUnderWin32Path('C:\\Program Files (x86)\\foo', 'C:\\Program Files'),
    ).toBe(false);
  });

  it('does not match paths on a different drive', () => {
    expect(isUnderWin32Path('D:\\Program Files\\foo', 'C:\\Program Files')).toBe(false);
  });

  it('returns false for empty root', () => {
    expect(isUnderWin32Path('C:\\Program Files\\foo', '')).toBe(false);
  });
});

describe('assertSpaceWriteSafe — error structure', () => {
  it('error carries workspaceRoot, spacePath, resolvedRealPath, and reason', async () => {
    const workspace = path.join(realScratchRoot, 'workspace');
    await fs.mkdir(workspace, { recursive: true });

    let caught: WriteOutsideWorkspaceError | null = null;
    try {
      await assertSpaceWriteSafe(workspace, '/System/foo', {
        platform: 'darwin',
        homedir: path.join(realScratchRoot, 'home'),
        resourcesPath: '',
      });
    } catch (err) {
      if (err instanceof WriteOutsideWorkspaceError) caught = err;
    }
    expect(caught).not.toBeNull();
    expect(caught?.workspaceRoot).toBe(workspace);
    expect(caught?.spacePath).toBe('/System/foo');
    expect(caught?.resolvedRealPath.length).toBeGreaterThan(0);
    expect(caught?.reason).toBe('under-system-root');
    expect(caught?.message.includes('Refused space write')).toBe(true);
  });
});
