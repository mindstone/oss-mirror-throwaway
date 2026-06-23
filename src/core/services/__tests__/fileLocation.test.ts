import { beforeEach, describe, expect, it, vi } from 'vitest';
import { setPlatformConfig } from '@core/platform';
import { SpaceInfoSchema, type SpaceInfo } from '@shared/ipc/schemas/library';

const { mockLogger } = vi.hoisted(() => ({
  mockLogger: {
    warn: vi.fn(),
  },
}));

 
vi.mock('@core/logger', () => ({
  createScopedLogger: () => mockLogger,
}));

import { FileLocationResolverError, resolveFileLocation } from '../fileLocation';

const CORE_DIRECTORY = '/tmp/workspace';
const NON_TEMP_CORE_DIRECTORY = '/Users/test/workspace';

function makeSpace(overrides: Partial<SpaceInfo> = {}): SpaceInfo {
  return SpaceInfoSchema.parse({
    name: 'General',
    path: 'General',
    absolutePath: `${CORE_DIRECTORY}/General`,
    type: 'team',
    isSymlink: false,
    hasReadme: true,
    ...overrides,
  });
}

describe('resolveFileLocation', () => {
  beforeEach(() => {
    mockLogger.warn.mockReset();
    setPlatformConfig({
      userDataPath: '/Users/test-user-data',
      appPath: '/tmp/test-app',
      tempPath: '/tmp/test-temp',
      logsPath: '/tmp/test-logs',
      homePath: '/Users/test-home',
      documentsPath: '/tmp/test-documents',
      desktopPath: '/tmp/test-desktop',
      appDataPath: '/tmp/test-appData',
      version: '0.0.0-test',
      isPackaged: false,
      platform: process.platform,
      totalMemoryBytes: 36 * 1024 * 1024 * 1024,
      arch: process.arch,
      surface: 'desktop',
      isOss: false,
    });
  });

  it('resolves absolute input to in-space location', async () => {
    const spaces = [makeSpace()];
    const result = await resolveFileLocation(
      '/tmp/workspace/General/skills/workflows/demo/SKILL.md',
      spaces,
      { coreDirectory: CORE_DIRECTORY },
    );

    expect(result).toEqual({
      kind: 'in-space',
      spaceName: 'General',
      spaceWorkspacePath: 'General',
      spaceRelativePath: 'skills/workflows/demo/SKILL.md',
      workspaceRelativePath: 'General/skills/workflows/demo/SKILL.md',
      fileName: 'SKILL.md',
      absolutePath: '/tmp/workspace/General/skills/workflows/demo/SKILL.md',
    });
  });

  it('resolves workspace-relative input to in-space location', async () => {
    const spaces = [makeSpace()];
    const result = await resolveFileLocation(
      'General/skills/workflows/demo/SKILL.md',
      spaces,
      { coreDirectory: CORE_DIRECTORY },
    );

    expect(result).toEqual({
      kind: 'in-space',
      spaceName: 'General',
      spaceWorkspacePath: 'General',
      spaceRelativePath: 'skills/workflows/demo/SKILL.md',
      workspaceRelativePath: 'General/skills/workflows/demo/SKILL.md',
      fileName: 'SKILL.md',
      absolutePath: '/tmp/workspace/General/skills/workflows/demo/SKILL.md',
    });
  });

  it('uses sourcePath root for symlinked spaces', async () => {
    const spaces = [
      makeSpace({
        name: 'Acme',
        path: 'work/Acme',
        absolutePath: '/tmp/workspace/work/Acme',
        sourcePath: '/mnt/gdrive/acme',
      }),
    ];

    const result = await resolveFileLocation('/mnt/gdrive/acme/skills/workflows/demo/SKILL.md', spaces, {
      coreDirectory: CORE_DIRECTORY,
    });

    expect(result).toEqual({
      kind: 'in-space',
      spaceName: 'Acme',
      spaceWorkspacePath: 'work/Acme',
      spaceRelativePath: 'skills/workflows/demo/SKILL.md',
      workspaceRelativePath: 'work/Acme/skills/workflows/demo/SKILL.md',
      fileName: 'SKILL.md',
      absolutePath: '/mnt/gdrive/acme/skills/workflows/demo/SKILL.md',
    });
  });

  it('falls back to path-prefix matching when display name changed', async () => {
    const spaces = [
      makeSpace({
        displayName: 'General (Renamed)',
      }),
    ];

    const result = await resolveFileLocation('General/skills/demo.md', spaces, {
      coreDirectory: CORE_DIRECTORY,
    });

    expect(result).toEqual({
      kind: 'in-space',
      spaceName: 'General (Renamed)',
      spaceWorkspacePath: 'General',
      spaceRelativePath: 'skills/demo.md',
      workspaceRelativePath: 'General/skills/demo.md',
      fileName: 'demo.md',
      absolutePath: '/tmp/workspace/General/skills/demo.md',
    });
  });

  it.each([
    {
      name: 'temp',
      inputPath: '/tmp/random/temp.md',
      opts: { coreDirectory: CORE_DIRECTORY },
      expectedCategory: 'temp',
    },
    {
      name: 'system',
      inputPath: '/opt/rebel-system/config/system.md',
      opts: { coreDirectory: CORE_DIRECTORY },
      expectedCategory: 'system',
    },
    {
      name: 'inbox',
      inputPath: '/Users/test-user-data/inbox/action.md',
      opts: { coreDirectory: CORE_DIRECTORY },
      expectedCategory: 'inbox',
    },
    {
      name: 'mcp_servers',
      inputPath: '/Users/test-home/mcp-servers/custom/build.ts',
      opts: { coreDirectory: CORE_DIRECTORY },
      expectedCategory: 'mcp_servers',
    },
    {
      name: 'outside',
      inputPath: '/opt/external/outside.md',
      opts: { coreDirectory: CORE_DIRECTORY },
      expectedCategory: 'outside',
    },
    {
      name: 'workspace_root',
      inputPath: '/Users/test/workspace/notes/random.md',
      opts: { coreDirectory: NON_TEMP_CORE_DIRECTORY },
      expectedCategory: 'workspace_root',
    },
    {
      name: 'unknown',
      inputPath: 'relative/mystery.md',
      opts: {},
      expectedCategory: 'unknown',
    },
  ] as const)(
    'populates outsideCategory=$name for unmatched paths',
    async ({ inputPath, opts, expectedCategory }) => {
      const result = await resolveFileLocation(inputPath, [makeSpace()], opts);
      expect(result.kind).toBe('outside-workspace');
      if (result.kind !== 'outside-workspace') {
        throw new Error('Expected outside-workspace result');
      }
      expect(result.outsideCategory).toBe(expectedCategory);
      expect(result.fileName).toBe(pathBasenamePortable(inputPath));
      expect(result.absolutePath.length).toBeGreaterThan(0);
    },
  );

  it('gives temp precedence over rebel-system when both classifications match', async () => {
    const result = await resolveFileLocation('/tmp/workspace/rebel-system/config/system.md', [makeSpace()], {
      coreDirectory: CORE_DIRECTORY,
    });

    expect(result).toEqual({
      kind: 'outside-workspace',
      absolutePath: '/tmp/workspace/rebel-system/config/system.md',
      fileName: 'system.md',
      outsideCategory: 'temp',
    });
  });

  it('normalizes windows separators before matching', async () => {
    const spaces = [
      makeSpace({
        name: 'Acme',
        path: 'work/Acme',
        absolutePath: '/tmp/workspace/work/Acme',
      }),
    ];

    const result = await resolveFileLocation('work\\Acme\\file.md', spaces, {
      coreDirectory: CORE_DIRECTORY,
    });

    expect(result).toEqual({
      kind: 'in-space',
      spaceName: 'Acme',
      spaceWorkspacePath: 'work/Acme',
      spaceRelativePath: 'file.md',
      workspaceRelativePath: 'work/Acme/file.md',
      fileName: 'file.md',
      absolutePath: '/tmp/workspace/work/Acme/file.md',
    });
  });

  it('uses longest-prefix match when spaces overlap', async () => {
    const spaces = [
      makeSpace({
        name: 'work',
        path: 'work',
        absolutePath: '/tmp/workspace/work',
      }),
      makeSpace({
        name: 'Acme',
        path: 'work/Acme',
        absolutePath: '/tmp/workspace/work/Acme',
      }),
    ];

    const result = await resolveFileLocation('/tmp/workspace/work/Acme/skill.md', spaces, {
      coreDirectory: CORE_DIRECTORY,
    });

    expect(result.kind).toBe('in-space');
    if (result.kind !== 'in-space') {
      throw new Error('Expected in-space result');
    }
    expect(result.spaceWorkspacePath).toBe('work/Acme');
    expect(result.workspaceRelativePath).toBe('work/Acme/skill.md');
    expect(result.fileName).toBe('skill.md');
  });

  it.each([
    './General/skills/foo.md',
    'General/./skills/foo.md',
    'General/skills/../skills/foo.md',
    'General/skills/foo.md/',
  ])('normalizes dot segments for "%s"', async (inputPath) => {
    const result = await resolveFileLocation(inputPath, [makeSpace()], {
      coreDirectory: CORE_DIRECTORY,
    });

    expect(result).toEqual({
      kind: 'in-space',
      spaceName: 'General',
      spaceWorkspacePath: 'General',
      spaceRelativePath: 'skills/foo.md',
      workspaceRelativePath: 'General/skills/foo.md',
      fileName: 'foo.md',
      absolutePath: '/tmp/workspace/General/skills/foo.md',
    });
  });

  it('rejects folder-only space path ("General/")', async () => {
    await expect(resolveFileLocation('General/', [makeSpace()], {
      coreDirectory: CORE_DIRECTORY,
    })).rejects.toBeInstanceOf(FileLocationResolverError);
  });

  it('rejects dot-only path ("./")', async () => {
    await expect(resolveFileLocation('./', [makeSpace()], {
      coreDirectory: CORE_DIRECTORY,
    })).rejects.toBeInstanceOf(FileLocationResolverError);
  });

  it('rejects empty path ("")', async () => {
    await expect(resolveFileLocation('', [makeSpace()], {
      coreDirectory: CORE_DIRECTORY,
    })).rejects.toBeInstanceOf(FileLocationResolverError);
  });

  it('normalizes relative escape and classifies as outside-workspace', async () => {
    const result = await resolveFileLocation('../outside/foo.md', [makeSpace()], {
      coreDirectory: CORE_DIRECTORY,
    });

    expect(result).toEqual({
      kind: 'outside-workspace',
      absolutePath: '/tmp/outside/foo.md',
      fileName: 'foo.md',
      outsideCategory: 'outside',
    });
  });

  it.each([
    {
      inputPath: '..',
      expectedAbsolutePath: '/tmp',
      expectedFileName: 'tmp',
    },
    {
      inputPath: '..\\outside\\foo.md',
      expectedAbsolutePath: '/tmp/outside/foo.md',
      expectedFileName: 'foo.md',
    },
  ])('classifies escape path "$inputPath" as outside-workspace', async ({ inputPath, expectedAbsolutePath, expectedFileName }) => {
    const result = await resolveFileLocation(inputPath, [makeSpace()], {
      coreDirectory: CORE_DIRECTORY,
    });

    expect(result).toEqual({
      kind: 'outside-workspace',
      absolutePath: expectedAbsolutePath,
      fileName: expectedFileName,
      outsideCategory: 'outside',
    });
  });

  it('emits structured warn when falling back to outside-workspace', async () => {
    const result = await resolveFileLocation('/etc/passwd', [makeSpace()], {
      coreDirectory: '/home/user/workspace',
    });

    expect(result).toEqual({
      kind: 'outside-workspace',
      absolutePath: '/etc/passwd',
      fileName: 'passwd',
      outsideCategory: 'outside',
    });
    expect(mockLogger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        pendingDestination: '/etc/passwd',
        originalSpace: undefined,
        coreDirectory: '/home/user/workspace',
      }),
      'FileLocation derivation fell back to outside-workspace',
    );
  });
});

function pathBasenamePortable(inputPath: string): string {
  const normalized = inputPath.replace(/\\/g, '/');
  const parts = normalized.split('/').filter(Boolean);
  return parts[parts.length - 1] ?? '';
}
