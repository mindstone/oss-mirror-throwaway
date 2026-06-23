import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import { symlinkSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { LS_TOOL_DEFINITION, executeLs } from '../tools/lsTool';
import type { BuiltinToolContext } from '../types';
import {
  setWorkspaceFsExecutor,
  __resetWorkspaceFsExecutorForTesting,
  type WorkspaceFsExecutor,
  type WorkspaceFsExecResult,
} from '@core/services/boundedWorkspaceFs';
import {
  configureCloudSpaceContainment,
  __resetCloudSpaceContainmentForTests,
} from '@core/services/cloudSpaceContainment';
import type { SpaceConfig } from '@shared/types/settings';

let tmpDir: string;

const CLOUD_TARGET = '/private/var/CloudStorageTest/Library/CloudStorage/GoogleDrive-test@example.com/MySpace';

/** Build a stub executor whose every op resolves to the same result. */
function lsStubExecutor<T>(result: WorkspaceFsExecResult<T>): WorkspaceFsExecutor {
  const op = () => Promise.resolve(result as WorkspaceFsExecResult<never>);
  return {
    stat: op,
    lstat: op,
    realpath: op,
    readlink: op,
    readdir: op,
    readdirWithFileTypes: op,
    readFile: op,
    readFileBytes: op,
    access: op,
  } as unknown as WorkspaceFsExecutor;
}

const DIR_STAT: WorkspaceFsExecResult<unknown> = {
  ok: true,
  value: { mtimeMs: 0, ctimeMs: 0, size: 0, isDirectory: true, isFile: false, isSymbolicLink: false },
};

function makeContext(overrides: Partial<BuiltinToolContext> = {}): BuiltinToolContext {
  return {
    cwd: tmpDir,
    ...overrides,
  };
}

async function buildFixtureTree(root: string): Promise<void> {
  await fs.mkdir(path.join(root, 'src'), { recursive: true });
  await fs.mkdir(path.join(root, 'src', 'components'), { recursive: true });
  await fs.mkdir(path.join(root, 'tests'), { recursive: true });
  await fs.mkdir(path.join(root, '.hidden'), { recursive: true });
  await fs.writeFile(path.join(root, 'README.md'), '# fixture\n');
  await fs.writeFile(path.join(root, 'src', 'a.ts'), 'export const a = 1;\n');
  await fs.writeFile(path.join(root, 'src', 'index.ts'), 'export {};\n');
  await fs.writeFile(path.join(root, 'src', 'components', 'Button.tsx'), 'export {};\n');
  await fs.writeFile(path.join(root, 'tests', 'a.test.ts'), 'test();\n');
  await fs.writeFile(path.join(root, '.hidden', 'secret.ts'), 'export {};\n');
}

describe('LS_TOOL_DEFINITION', () => {
  it('declares the expected schema', () => {
    expect(LS_TOOL_DEFINITION.name).toBe('LS');
    expect(LS_TOOL_DEFINITION.input_schema.required).toEqual(['path']);
    expect(LS_TOOL_DEFINITION.input_schema.properties).toHaveProperty('path');
    expect(LS_TOOL_DEFINITION.input_schema.properties).toHaveProperty('recursive');
    expect(LS_TOOL_DEFINITION.input_schema.properties).toHaveProperty('includeHidden');
    expect(LS_TOOL_DEFINITION.input_schema.properties).toHaveProperty('followSymlinks');
  });
});

describe('executeLs', () => {
  beforeEach(async () => {
    tmpDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'ls-test-')));
    await buildFixtureTree(tmpDir);
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  });

  it('rejects null input', async () => {
    const result = await executeLs(null, makeContext());
    expect(result.isError).toBe(true);
    expect(result.output).toContain('valid input');
  });

  it('rejects empty path', async () => {
    const result = await executeLs({ path: '   ' }, makeContext());
    expect(result.isError).toBe(true);
    expect(result.output).toContain('non-empty path');
  });

  it('reports a missing directory', async () => {
    const result = await executeLs(
      { path: path.join(tmpDir, 'nope') },
      makeContext(),
    );
    expect(result.isError).toBe(true);
    expect(result.output).toMatch(/Directory not found|Path is outside/);
  });

  it('rejects a file path with the not-a-directory error', async () => {
    const result = await executeLs(
      { path: path.join(tmpDir, 'README.md') },
      makeContext(),
    );
    expect(result.isError).toBe(true);
    expect(result.output).toMatch(/not a directory/);
  });

  it('lists a directory non-recursively', async () => {
    const result = await executeLs({ path: tmpDir }, makeContext());
    expect(result.isError).toBe(false);
    expect(result.output).toContain('README.md');
    expect(result.output).toContain('src/');
    expect(result.output).toContain('tests/');
    expect(result.output).not.toContain('Button.tsx');
    expect(result.output).not.toContain('.hidden');
  });

  it('omits hidden entries unless includeHidden is true', async () => {
    const without = await executeLs({ path: tmpDir }, makeContext());
    expect(without.output).not.toContain('.hidden');

    const withHidden = await executeLs(
      { path: tmpDir, includeHidden: true },
      makeContext(),
    );
    expect(withHidden.output).toContain('.hidden');
  });

  it('annotates entries with file/directory metadata', async () => {
    const result = await executeLs({ path: tmpDir }, makeContext());
    expect(result.output).toMatch(/README\.md\s+\(file,\s+\d+\s+bytes,/);
    expect(result.output).toMatch(/src\/\s+\(directory,/);
  });

  it('lists recursively when recursive: true', async () => {
    const result = await executeLs(
      { path: tmpDir, recursive: true },
      makeContext(),
    );
    expect(result.isError).toBe(false);
    expect(result.output).toContain('src/a.ts');
    expect(result.output).toContain('src/components/Button.tsx');
    expect(result.output).toContain('tests/a.test.ts');
  });

  it('skips hidden subtrees in recursive mode unless includeHidden', async () => {
    const without = await executeLs(
      { path: tmpDir, recursive: true },
      makeContext(),
    );
    expect(without.output).not.toContain('.hidden');

    const withHidden = await executeLs(
      { path: tmpDir, recursive: true, includeHidden: true },
      makeContext(),
    );
    expect(withHidden.output).toContain('.hidden/secret.ts');
  });

  it('does not enumerate symlink targets that escape the workspace', async () => {
    const escapeTarget = await fs.realpath(
      await fs.mkdtemp(path.join(os.tmpdir(), 'ls-escape-')),
    );
    try {
      await fs.writeFile(path.join(escapeTarget, 'leak.txt'), 'leak');
      await fs.symlink(escapeTarget, path.join(tmpDir, 'escape-link'));
      const result = await executeLs(
        { path: tmpDir, recursive: true },
        makeContext(),
      );
      expect(result.isError).toBe(false);
      expect(result.output).not.toContain('leak.txt');
    } finally {
      await fs.rm(escapeTarget, { recursive: true, force: true }).catch(() => {});
    }
  });

  it('reports a symlink to a workspace file with kind=symlink', async () => {
    const target = path.join(tmpDir, 'src', 'a.ts');
    const link = path.join(tmpDir, 'a-link');
    await fs.symlink(target, link);
    const result = await executeLs({ path: tmpDir }, makeContext());
    expect(result.isError).toBe(false);
    expect(result.output).toMatch(/a-link/);
  });

  it('lists an entry count in the header line', async () => {
    const result = await executeLs({ path: tmpDir }, makeContext());
    expect(result.output.split('\n')[0]).toMatch(/\d+ (entry|entries)/);
  });

  it('skips symlinked entries in recursive mode when followSymlinks is false', async () => {
    const innerDir = path.join(tmpDir, 'inner');
    await fs.mkdir(innerDir, { recursive: true });
    await fs.writeFile(path.join(innerDir, 'inside.ts'), 'real');
    await fs.writeFile(path.join(tmpDir, 'real.ts'), 'real');
    await fs.symlink(path.join(tmpDir, 'real.ts'), path.join(tmpDir, 'linked.ts'));
    await fs.symlink(innerDir, path.join(tmpDir, 'inner-link'));

    const withSymlinks = await executeLs(
      { path: tmpDir, recursive: true, followSymlinks: true },
      makeContext(),
    );
    expect(withSymlinks.isError).toBe(false);
    expect(withSymlinks.output).toContain('linked.ts');

    const withoutSymlinks = await executeLs(
      { path: tmpDir, recursive: true, followSymlinks: false },
      makeContext(),
    );
    expect(withoutSymlinks.isError).toBe(false);
    expect(withoutSymlinks.output).not.toContain('linked.ts');
    expect(withoutSymlinks.output).not.toContain('inner-link/inside.ts');
  });

  // S3: LS routes its dereferencing fs through the bounded boundary so a dead cloud
  // mount degrades instead of hanging. A `reconnecting` outcome surfaces an honest
  // degraded signal (never a hang, never a silent "empty directory").
  describe('cloud lane — bounded + degraded on reconnecting', () => {
    let cloudDir: string;

    beforeEach(() => {
      const cloudLink = path.join(tmpDir, 'CloudSpace');
      symlinkSync(CLOUD_TARGET, cloudLink);
      configureCloudSpaceContainment(tmpDir, [
        { path: 'CloudSpace', isSymlink: true } as unknown as SpaceConfig,
      ]);
      cloudDir = cloudLink;
    });

    afterEach(() => {
      __resetWorkspaceFsExecutorForTesting();
      __resetCloudSpaceContainmentForTests();
    });

    it('fails closed (isError) at the security gate when the whole cloud dir is reconnecting', async () => {
      setWorkspaceFsExecutor(lsStubExecutor({ ok: false, reason: 'timeout' }));
      const result = await executeLs({ path: cloudDir }, makeContext());
      expect(result.isError).toBe(true);
      expect(result.output).toMatch(/reconnecting/i);
    });

    it('reports "reconnecting" (isError) when access times out but the path resolves', async () => {
      // realpath succeeds (mount alive enough to pass the symlink-escape check) but
      // the access probe times out → the entry-point check degrades, not hangs.
      setWorkspaceFsExecutor({
        ...lsStubExecutor({ ok: false, reason: 'timeout' }),
        realpath: (p: string) => Promise.resolve({ ok: true, value: p }),
      } as unknown as WorkspaceFsExecutor);
      const result = await executeLs({ path: cloudDir }, makeContext());
      expect(result.isError).toBe(true);
      expect(result.output).toMatch(/reconnecting/i);
    });

    it('lists the directory but renders per-entry reconnecting state when entry metadata times out', async () => {
      // The dir itself is reachable (access/stat/readdir ok) but each entry's lstat
      // times out → the listing succeeds with a per-entry degraded marker.
      setWorkspaceFsExecutor({
        realpath: (p: string) => Promise.resolve({ ok: true, value: p }),
        access: () => Promise.resolve({ ok: true, value: true }),
        stat: () => Promise.resolve(DIR_STAT as WorkspaceFsExecResult<never>),
        readdir: () => Promise.resolve({ ok: true, value: ['report.md'] as unknown as never }),
        lstat: () => Promise.resolve({ ok: false, reason: 'timeout' }),
        readdirWithFileTypes: () => Promise.resolve({ ok: true, value: [] as unknown as never }),
        readFile: () => Promise.resolve({ ok: true, value: '' as unknown as never }),
        readFileBytes: () => Promise.resolve({ ok: true, value: Buffer.alloc(0) as unknown as never }),
      } as unknown as WorkspaceFsExecutor);
      const result = await executeLs({ path: cloudDir }, makeContext());
      expect(result.isError).toBe(false);
      expect(result.output).toContain('report.md');
      expect(result.output).toMatch(/reconnecting/i);
    });

    it('fails closed (isError) when the directory listing (readdir) times out [F3]', async () => {
      setWorkspaceFsExecutor({
        ...lsStubExecutor({ ok: false, reason: 'timeout' }),
        realpath: (p: string) => Promise.resolve({ ok: true, value: p }),
        access: () => Promise.resolve({ ok: true, value: true }),
        stat: () => Promise.resolve(DIR_STAT as WorkspaceFsExecResult<never>),
        readdir: () => Promise.resolve({ ok: false, reason: 'timeout' }),
      } as unknown as WorkspaceFsExecutor);
      const result = await executeLs({ path: cloudDir }, makeContext());
      expect(result.isError).toBe(true);
      expect(result.output).toMatch(/reconnecting/i);
    });

    it('renders reconnecting for a symlink entry whose target stat times out [F3]', async () => {
      const symlinkLstat: WorkspaceFsExecResult<unknown> = {
        ok: true,
        value: { mtimeMs: 0, ctimeMs: 0, size: 0, isDirectory: false, isFile: false, isSymbolicLink: true },
      };
      setWorkspaceFsExecutor({
        realpath: (p: string) => Promise.resolve({ ok: true, value: p }),
        access: () => Promise.resolve({ ok: true, value: true }),
        // The root dir reports a directory; the symlink ENTRY's resolve-stat times out.
        stat: (p: string) =>
          Promise.resolve(
            p === cloudDir
              ? (DIR_STAT as WorkspaceFsExecResult<never>)
              : ({ ok: false, reason: 'timeout' } as WorkspaceFsExecResult<never>),
          ),
        lstat: () => Promise.resolve(symlinkLstat as WorkspaceFsExecResult<never>),
        readlink: () => Promise.resolve({ ok: true, value: '/some/target' as unknown as never }),
        readdir: () => Promise.resolve({ ok: true, value: ['alias'] as unknown as never }),
        readdirWithFileTypes: () => Promise.resolve({ ok: true, value: [] as unknown as never }),
        readFile: () => Promise.resolve({ ok: true, value: '' as unknown as never }),
        readFileBytes: () => Promise.resolve({ ok: true, value: Buffer.alloc(0) as unknown as never }),
      } as unknown as WorkspaceFsExecutor);
      const result = await executeLs({ path: cloudDir }, makeContext());
      expect(result.isError).toBe(false);
      expect(result.output).toContain('alias');
      expect(result.output).toMatch(/reconnecting/i);
    });
  });
});
