// @vitest-environment happy-dom

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SpaceInfo } from '@shared/ipc/schemas/library';
import { resolveMemoryEntryPath } from '../resolveMemoryEntryPath';

type StatRequest = string | { target: string; basePath?: string };
type StatResult = { exists: boolean; mtimeMs: number | null; size: number | null };

const statFileMock = vi.fn<(request: StatRequest) => Promise<StatResult>>();

const SPACES: SpaceInfo[] = [
  {
    name: 'Chief-of-Staff',
    path: 'chief-of-staff',
    absolutePath: '/workspace/chief-of-staff',
    type: 'chief-of-staff',
    isSymlink: false,
    hasReadme: true,
    status: 'ok',
  },
  {
    name: 'General',
    path: 'work/Mindstone/General',
    absolutePath: '/workspace/work/Mindstone/General',
    type: 'company',
    isSymlink: false,
    hasReadme: true,
    status: 'ok',
  },
];

function getRequestedPath(request: StatRequest): string {
  return typeof request === 'string' ? request : request.target;
}

describe('resolveMemoryEntryPath', () => {
  beforeEach(() => {
    statFileMock.mockReset();
    (window as unknown as { libraryApi: { statFile: typeof statFileMock } }).libraryApi = {
      statFile: statFileMock,
    };
  });

  it('returns the recorded path when it exists as-is', async () => {
    statFileMock.mockImplementation(async (request: StatRequest) => ({
      exists: getRequestedPath(request) === '/workspace/chief-of-staff/memory/topics/weekly.md',
      mtimeMs: null,
      size: null,
    }));

    const resolved = await resolveMemoryEntryPath({
      recordedFilePath: 'chief-of-staff/memory/topics/weekly.md',
      entity: 'Chief of Staff',
      libraryRootAbsolute: '/workspace',
      spaces: SPACES,
    });

    expect(resolved).toEqual({
      absolutePath: '/workspace/chief-of-staff/memory/topics/weekly.md',
      workspaceRelative: 'chief-of-staff/memory/topics/weekly.md',
      repaired: false,
      effectiveRelativePath: 'chief-of-staff/memory/topics/weekly.md',
    });
  });

  it('repairs missing space prefixes using the matching entity space', async () => {
    statFileMock.mockImplementation(async (request: StatRequest) => ({
      exists: getRequestedPath(request) === '/workspace/chief-of-staff/memory/topics/weekly.md',
      mtimeMs: null,
      size: null,
    }));

    const resolved = await resolveMemoryEntryPath({
      recordedFilePath: 'memory/topics/weekly.md',
      entity: 'Chief of Staff',
      libraryRootAbsolute: '/workspace',
      spaces: SPACES,
    });

    expect(resolved).toEqual({
      absolutePath: '/workspace/chief-of-staff/memory/topics/weekly.md',
      workspaceRelative: 'chief-of-staff/memory/topics/weekly.md',
      repaired: true,
      effectiveRelativePath: 'chief-of-staff/memory/topics/weekly.md',
    });
  });

  it('falls back to other spaces when no entity match exists', async () => {
    statFileMock.mockImplementation(async (request: StatRequest) => ({
      exists: getRequestedPath(request) === '/workspace/work/Mindstone/General/memory/topics/weekly.md',
      mtimeMs: null,
      size: null,
    }));

    const resolved = await resolveMemoryEntryPath({
      recordedFilePath: 'memory/topics/weekly.md',
      entity: 'Unknown Entity',
      libraryRootAbsolute: '/workspace',
      spaces: SPACES,
    });

    expect(resolved).toEqual({
      absolutePath: '/workspace/work/Mindstone/General/memory/topics/weekly.md',
      workspaceRelative: 'work/Mindstone/General/memory/topics/weekly.md',
      repaired: true,
      effectiveRelativePath: 'work/Mindstone/General/memory/topics/weekly.md',
    });
  });

  it('returns null when no candidate path exists on disk', async () => {
    statFileMock.mockResolvedValue({ exists: false, mtimeMs: null, size: null });

    const resolved = await resolveMemoryEntryPath({
      recordedFilePath: 'memory/topics/missing.md',
      entity: 'Chief of Staff',
      libraryRootAbsolute: '/workspace',
      spaces: SPACES,
    });

    expect(resolved).toBeNull();
  });
});
