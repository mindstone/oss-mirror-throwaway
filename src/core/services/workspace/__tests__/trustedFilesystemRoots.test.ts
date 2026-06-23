import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AppSettings, SpaceConfig } from '@shared/types';

const fsMocks = vi.hoisted(() => ({
  existsSync: null as ((p: string) => boolean) | null,
  realpathNative: null as ((p: string) => string) | null,
}));

vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
  const realpathSyncFn = (p: Parameters<typeof actual.realpathSync>[0]) => actual.realpathSync(p);
  const realpathNativeFn = (p: Parameters<typeof actual.realpathSync.native>[0]): string => {
    if (fsMocks.realpathNative) return fsMocks.realpathNative(String(p));
    return actual.realpathSync.native(p) as string;
  };
  Object.defineProperty(realpathSyncFn, 'native', {
    value: realpathNativeFn,
    writable: true,
    configurable: true,
    enumerable: true,
  });
  return {
    ...actual,
    existsSync: (p: Parameters<typeof actual.existsSync>[0]) => {
      if (fsMocks.existsSync) return fsMocks.existsSync(String(p));
      return actual.existsSync(p);
    },
    realpathSync: realpathSyncFn,
  };
});

import {
  getAllowedSymlinkTargets,
  getDeepestCommonAncestor,
  getMcpSandboxAncestorRoots,
} from '../trustedFilesystemRoots';

function makeSpace(overrides: Partial<SpaceConfig>): SpaceConfig {
  return {
    name: overrides.name ?? 'Test Space',
    path: overrides.path ?? 'test-space',
    type: overrides.type ?? 'work',
    isSymlink: overrides.isSymlink ?? false,
    ...(overrides.sourcePath !== undefined ? { sourcePath: overrides.sourcePath } : {}),
  } as SpaceConfig;
}

function clearFsMocks(): void {
  fsMocks.existsSync = null;
  fsMocks.realpathNative = null;
}

describe('getAllowedSymlinkTargets', () => {
  it('returns an empty array for empty settings with no rebelSystemRoot', () => {
    const settings: Pick<AppSettings, 'spaces'> = {};
    expect(getAllowedSymlinkTargets(settings, {})).toEqual([]);
  });

  it('returns one symlink Space sourcePath followed by rebelSystemRoot', () => {
    const settings: Pick<AppSettings, 'spaces'> = {
      spaces: [
        makeSpace({
          name: 'Chief-of-Staff',
          isSymlink: true,
          sourcePath: '/Users/me/Library/CloudStorage/GoogleDrive/CoS',
        }),
      ],
    };
    expect(
      getAllowedSymlinkTargets(settings, {
        rebelSystemRoot: '/opt/rebel-system',
      }),
    ).toEqual([
      '/Users/me/Library/CloudStorage/GoogleDrive/CoS',
      '/opt/rebel-system',
    ]);
  });

  it('preserves order, drops non-symlink Spaces, and appends rebelSystemRoot', () => {
    const settings: Pick<AppSettings, 'spaces'> = {
      spaces: [
        makeSpace({ name: 'A', isSymlink: true, sourcePath: '/mnt/A' }),
        makeSpace({ name: 'B', isSymlink: false, sourcePath: '/mnt/B-ignored' }),
        makeSpace({ name: 'C', isSymlink: true, sourcePath: '/mnt/C' }),
      ],
    };
    expect(
      getAllowedSymlinkTargets(settings, { rebelSystemRoot: '/opt/rebel-system' }),
    ).toEqual(['/mnt/A', '/mnt/C', '/opt/rebel-system']);
  });

  it('excludes symlink Spaces with empty sourcePath', () => {
    const settings: Pick<AppSettings, 'spaces'> = {
      spaces: [
        makeSpace({ name: 'A', isSymlink: true, sourcePath: '/mnt/A' }),
        makeSpace({ name: 'B', isSymlink: true, sourcePath: '' }),
        makeSpace({ name: 'C', isSymlink: true }),
      ],
    };
    expect(getAllowedSymlinkTargets(settings, {})).toEqual(['/mnt/A']);
  });

  it('omits rebelSystemRoot when not provided', () => {
    const settings: Pick<AppSettings, 'spaces'> = {
      spaces: [makeSpace({ isSymlink: true, sourcePath: '/mnt/X' })],
    };
    expect(getAllowedSymlinkTargets(settings, {})).toEqual(['/mnt/X']);
  });

  describe('rebelSystemRoot falsy/whitespace matrix (byte-identical to inline literal)', () => {
    const settings: Pick<AppSettings, 'spaces'> = {
      spaces: [makeSpace({ isSymlink: true, sourcePath: '/mnt/X' })],
    };

    it('omits empty string', () => {
      expect(
        getAllowedSymlinkTargets(settings, { rebelSystemRoot: '' }),
      ).toEqual(['/mnt/X']);
    });

    it('omits null cast through `as unknown as string`', () => {
      expect(
        getAllowedSymlinkTargets(settings, {
          rebelSystemRoot: null as unknown as string,
        }),
      ).toEqual(['/mnt/X']);
    });

    it('omits undefined', () => {
      expect(
        getAllowedSymlinkTargets(settings, { rebelSystemRoot: undefined }),
      ).toEqual(['/mnt/X']);
    });

    it('INCLUDES whitespace-only `rebelSystemRoot` verbatim (truthy match)', () => {
      expect(
        getAllowedSymlinkTargets(settings, { rebelSystemRoot: '   ' }),
      ).toEqual(['/mnt/X', '   ']);
    });
  });
});

describe('getMcpSandboxAncestorRoots', () => {
  beforeEach(() => {
    fsMocks.existsSync = () => true;
    fsMocks.realpathNative = (p) => p;
  });

  afterEach(() => {
    clearFsMocks();
  });

  it('returns an empty array for empty inputs', () => {
    expect(getMcpSandboxAncestorRoots({}, {})).toEqual([]);
  });

  it('returns all components in workspace-first order with no duplicates (no rebelSystemRoot)', () => {
    const settings: Pick<AppSettings, 'spaces'> = {
      spaces: [
        makeSpace({ isSymlink: true, sourcePath: '/mnt/Drive' }),
      ],
    };
    const result = getMcpSandboxAncestorRoots(settings, {
      homePath: '/Users/me',
      coreDirectory: '/Users/me/Workspace/Core',
    });
    expect(result).toEqual([
      '/Users/me/Workspace/Core',
      path.join('/Users/me', 'mcp-servers'),
      '/mnt/Drive',
    ]);
  });

  it('F-1: never includes rebelSystemRoot, even if a caller smuggles one in via an extra opts key', () => {
    const settings: Pick<AppSettings, 'spaces'> = {
      spaces: [makeSpace({ isSymlink: true, sourcePath: '/Users/me/Spaces/Work' })],
    };
    const result = getMcpSandboxAncestorRoots(
      settings,
      {
        homePath: '/Users/me',
        coreDirectory: '/Users/me/Workspace/Core',
        rebelSystemRoot: '/Applications/Rebel.app/Contents/Resources/rebel-system',
      } as { homePath: string; coreDirectory: string },
    );
    expect(result).not.toContain(
      '/Applications/Rebel.app/Contents/Resources/rebel-system',
    );
    expect(result).toEqual([
      '/Users/me/Workspace/Core',
      path.join('/Users/me', 'mcp-servers'),
      '/Users/me/Spaces/Work',
    ]);
  });

  it('F-1: packaged-install scenario — coreDirectory + Space under user home, DCA stays under /Users (no collapse)', () => {
    const settings: Pick<AppSettings, 'spaces'> = {
      spaces: [
        makeSpace({
          isSymlink: true,
          sourcePath: '/Users/foo/Library/CloudStorage/GoogleDrive/CoS',
        }),
      ],
    };
    const roots = getMcpSandboxAncestorRoots(settings, {
      homePath: '/Users/foo',
      coreDirectory: '/Users/foo/Workspace',
    });
    const dca = getDeepestCommonAncestor(roots, { pathStyle: 'posix' });
    expect(dca).not.toBeNull();
    expect(dca).not.toBe('/');
    expect((dca as string).startsWith('/Users/foo')).toBe(true);
  });

  it('SF-1: filters out non-existent paths (e.g. first-run ~/mcp-servers)', () => {
    const missing = path.join('/Users/me', 'mcp-servers');
    fsMocks.existsSync = (p) => p !== missing;

    const result = getMcpSandboxAncestorRoots({}, {
      homePath: '/Users/me',
      coreDirectory: '/Users/me/Workspace/Core',
    });
    expect(result).toEqual(['/Users/me/Workspace/Core']);
  });

  it('SF-2: realpath-canonicalises symlinked Space sourcePaths', () => {
    const linkPath = '/Users/me/Library/CloudStorage/GoogleDrive/CoS';
    const realPath = '/Volumes/GoogleDrive/My Drive/CoS';
    fsMocks.realpathNative = (p) => (p === linkPath ? realPath : p);

    const settings: Pick<AppSettings, 'spaces'> = {
      spaces: [makeSpace({ isSymlink: true, sourcePath: linkPath })],
    };
    const result = getMcpSandboxAncestorRoots(settings, {});
    expect(result).toEqual([realPath]);
  });

  it('SF-2: falls back to the lexical normalised path when realpath throws', () => {
    const lexical = '/Users/me/Workspace/Core';
    fsMocks.realpathNative = () => {
      const err: NodeJS.ErrnoException = Object.assign(new Error('ENOENT'), {
        code: 'ENOENT',
      });
      throw err;
    };

    const result = getMcpSandboxAncestorRoots({}, { coreDirectory: lexical });
    expect(result).toEqual([path.normalize(lexical)]);
  });

  it.each([
    ['ENOTDIR'],
    ['ELOOP'],
    ['EMFILE'],
    ['EACCES'],
  ])('falls back to the lexical normalised path when realpath throws %s', (code) => {
    const lexical = '/Users/me/Workspace/Core';
    fsMocks.realpathNative = () => {
      const err: NodeJS.ErrnoException = Object.assign(new Error(code), { code });
      throw err;
    };

    const result = getMcpSandboxAncestorRoots({}, { coreDirectory: lexical });
    expect(result).toEqual([path.normalize(lexical)]);
  });

  it('skips NUL-byte-containing paths without throwing and preserves valid roots', () => {
    const validCore = '/Users/me/Workspace/Core';
    const invalid = '/Users/foo\0bar';
    const settings: Pick<AppSettings, 'spaces'> = {
      spaces: [makeSpace({ isSymlink: true, sourcePath: invalid })],
    };

    let result: string[] = [];
    expect(() => {
      result = getMcpSandboxAncestorRoots(settings, { coreDirectory: validCore });
    }).not.toThrow();
    expect(result).toEqual([validCore]);
  });

  it('treats existsSync throws as non-existent (fail-soft) without propagating', () => {
    const validCore = '/Users/me/Workspace/Core';
    const broken = '/Users/me/broken-zone';
    fsMocks.existsSync = (p) => {
      if (p === broken) {
        throw Object.assign(new Error('ERR_INVALID_ARG_VALUE'), {
          code: 'ERR_INVALID_ARG_VALUE',
        });
      }
      return true;
    };

    const settings: Pick<AppSettings, 'spaces'> = {
      spaces: [makeSpace({ isSymlink: true, sourcePath: broken })],
    };

    let result: string[] = [];
    expect(() => {
      result = getMcpSandboxAncestorRoots(settings, { coreDirectory: validCore });
    }).not.toThrow();
    expect(result).toEqual([validCore]);
  });

  it('SF-5: trims leading/trailing whitespace from input roots', () => {
    const raw = '/Users/me/Workspace/Core\n';
    const trimmed = '/Users/me/Workspace/Core';
    fsMocks.existsSync = (p) => p === trimmed;

    const result = getMcpSandboxAncestorRoots({}, { coreDirectory: raw });
    expect(result).toEqual([trimmed]);
  });

  it('SF-11 (POSIX): keeps both case-conflicting paths on a case-sensitive filesystem', () => {
    const settings: Pick<AppSettings, 'spaces'> = {
      spaces: [
        makeSpace({ name: 'A', isSymlink: true, sourcePath: '/Users/foo/MyDocs' }),
        makeSpace({ name: 'B', isSymlink: true, sourcePath: '/Users/foo/mydocs' }),
      ],
    };
    const result = getMcpSandboxAncestorRoots(settings, {});
    if (process.platform === 'win32') {
      expect(result.length).toBe(1);
    } else {
      expect(result).toEqual(['/Users/foo/MyDocs', '/Users/foo/mydocs']);
    }
  });

  it('SF-11 (Windows): dedups case-conflicting paths case-insensitively', () => {
    const originalPlatform = process.platform;
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });

    try {
      const settings: Pick<AppSettings, 'spaces'> = {
        spaces: [
          makeSpace({ name: 'A', isSymlink: true, sourcePath: 'C:\\Users\\Foo\\MyDocs' }),
          makeSpace({ name: 'B', isSymlink: true, sourcePath: 'c:\\users\\foo\\mydocs' }),
        ],
      };
      const result = getMcpSandboxAncestorRoots(settings, {});
      expect(result).toHaveLength(1);
      expect(result[0]).toBe('C:\\Users\\Foo\\MyDocs');
    } finally {
      Object.defineProperty(process, 'platform', {
        value: originalPlatform,
        configurable: true,
      });
    }
  });

  it('drops trailing path separators after normalization', () => {
    const result = getMcpSandboxAncestorRoots({}, { coreDirectory: '/Users/me/Core/' });
    expect(result).toEqual(['/Users/me/Core']);
  });
});

describe('getMcpSandboxAncestorRoots — behavioral integration (real filesystem)', () => {
  let tempRoot: string;

  beforeEach(() => {
    clearFsMocks();
    tempRoot = mkdtempSync(path.join(os.tmpdir(), 'rebel-trusted-roots-'));
  });

  afterEach(() => {
    rmSync(tempRoot, { recursive: true, force: true });
  });

  const symlinkIt = process.platform === 'win32' ? it.skip : it;

  symlinkIt('SF-2: realpath traverses a multi-link symlink chain to the real directory', () => {
    const realDir = path.join(tempRoot, 'real-dir');
    const linkB = path.join(tempRoot, 'link-b');
    const linkA = path.join(tempRoot, 'link-a');
    mkdirSync(realDir);
    symlinkSync(realDir, linkB);
    symlinkSync(linkB, linkA);

    const settings: Pick<AppSettings, 'spaces'> = {
      spaces: [makeSpace({ isSymlink: true, sourcePath: linkA })],
    };

    const result = getMcpSandboxAncestorRoots(settings, {});
    const expectedReal = realpathSync.native(linkA);
    expect(result).toEqual([expectedReal]);
    expect(result[0]).not.toBe(linkA);
  });

  symlinkIt(
    'end-to-end: helper output is connector-compatible (input realpath starts with DCA + sep)',
    () => {
      const realSpaceDir = path.join(tempRoot, 'real-space');
      const linkSpaceDir = path.join(tempRoot, 'link-space');
      mkdirSync(realSpaceDir);
      symlinkSync(realSpaceDir, linkSpaceDir);

      const inputFileName = 'image.png';
      const inputFilePath = path.join(linkSpaceDir, inputFileName);
      writeFileSync(inputFilePath, 'fake-image-bytes');

      const settings: Pick<AppSettings, 'spaces'> = {
        spaces: [makeSpace({ isSymlink: true, sourcePath: linkSpaceDir })],
      };

      const roots = getMcpSandboxAncestorRoots(settings, {});
      const dca = getDeepestCommonAncestor(roots, { pathStyle: 'posix' });
      expect(dca).not.toBeNull();

      const inputReal = realpathSync.native(inputFilePath);
      expect(inputReal.startsWith((dca as string) + path.sep)).toBe(true);
    },
  );
});

describe('getDeepestCommonAncestor', () => {
  it('returns null for an empty array', () => {
    expect(getDeepestCommonAncestor([])).toBeNull();
  });

  it('returns the path itself for a single input (POSIX)', () => {
    expect(getDeepestCommonAncestor(['/a/b'], { pathStyle: 'posix' })).toBe('/a/b');
  });

  it('returns the shared parent for two paths under it (POSIX)', () => {
    expect(
      getDeepestCommonAncestor(['/a/b/c', '/a/b/d'], { pathStyle: 'posix' }),
    ).toBe('/a/b');
  });

  it('returns null when DCA would collapse to POSIX `/`', () => {
    expect(
      getDeepestCommonAncestor(['/a/b', '/c/d'], { pathStyle: 'posix' }),
    ).toBeNull();
  });

  it('returns the path itself for a single short input (POSIX)', () => {
    expect(getDeepestCommonAncestor(['/a'], { pathStyle: 'posix' })).toBe('/a');
  });

  it('returns null for an empty array with explicit win32 style', () => {
    expect(getDeepestCommonAncestor([], { pathStyle: 'win32' })).toBeNull();
  });

  it('returns the shared drive-relative parent (Windows)', () => {
    expect(
      getDeepestCommonAncestor(['C:\\a\\b', 'C:\\a\\c'], { pathStyle: 'win32' }),
    ).toBe('C:\\a');
  });

  it('returns null for cross-drive inputs (Windows)', () => {
    expect(
      getDeepestCommonAncestor(['C:\\a', 'D:\\a'], { pathStyle: 'win32' }),
    ).toBeNull();
  });

  it('returns null when DCA would collapse to the same-drive root (Windows)', () => {
    expect(
      getDeepestCommonAncestor(['C:\\alpha', 'C:\\beta'], { pathStyle: 'win32' }),
    ).toBeNull();
  });

  it('returns the ancestor when one path is an ancestor of another (Windows)', () => {
    expect(
      getDeepestCommonAncestor(['C:\\a\\b', 'C:\\a'], { pathStyle: 'win32' }),
    ).toBe('C:\\a');
  });

  it('returns null for UNC inputs that collapse to the bare share root (Windows)', () => {
    expect(
      getDeepestCommonAncestor(['\\\\server\\share\\a', '\\\\server\\share\\b'], {
        pathStyle: 'win32',
      }),
    ).toBeNull();
  });

  it('returns a UNC sub-path when both inputs share segments below the share root', () => {
    expect(
      getDeepestCommonAncestor(
        ['\\\\server\\share\\team\\x', '\\\\server\\share\\team\\y'],
        { pathStyle: 'win32' },
      ),
    ).toBe('\\\\server\\share\\team');
  });

  it('normalises trailing separators (POSIX)', () => {
    expect(
      getDeepestCommonAncestor(['/a/b/', '/a/b'], { pathStyle: 'posix' }),
    ).toBe('/a/b');
  });

  it('treats Windows paths case-insensitively for prefix matching', () => {
    const result = getDeepestCommonAncestor(['C:\\a', 'c:\\A'], { pathStyle: 'win32' });
    expect(result?.toLowerCase()).toBe('c:\\a');
  });
});
