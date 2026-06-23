import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

vi.mock('node:child_process', () => ({
  execFile: vi.fn(),
}));

import { execFile } from 'node:child_process';
import { GLOB_TOOL_DEFINITION, executeGlob } from '../tools/globTool';
import type { BuiltinToolContext } from '../types';
import {
  setCloudLivenessProbe,
  __resetCloudLivenessProbeForTesting,
  type CloudHealthVerdict,
} from '@core/services/cloudLivenessProbe';
import {
  setCloudSymlinkIndexingEnabled,
  __resetCloudSymlinkIndexingForTests,
} from '@core/services/cloudSymlinkIndexing';
import {
  setWorkspaceFsExecutor,
  __resetWorkspaceFsExecutorForTesting,
} from '@core/services/boundedWorkspaceFs';
import { realFsExecutor } from '@core/services/__tests__/workspaceFsExecutorDoubles';

const mockExecFile = vi.mocked(execFile);

let tmpDir: string;

function makeContext(overrides: Partial<BuiltinToolContext> = {}): BuiltinToolContext {
  return {
    cwd: tmpDir,
    ...overrides,
  };
}

function mockNoExternalCommands() {
  mockExecFile.mockImplementation((_cmd, _args, _opts, callback) => {
    if (typeof callback === 'function') {
      const err = new Error('spawn ENOENT') as NodeJS.ErrnoException;
      err.code = 'ENOENT';
      (callback as (error: Error | null, stdout: string, stderr: string) => void)(err, '', '');
    }
    return {} as ReturnType<typeof execFile>;
  });
}

async function buildFixtureTree(root: string): Promise<void> {
  await fs.mkdir(path.join(root, 'src'), { recursive: true });
  await fs.mkdir(path.join(root, 'src', 'components'), { recursive: true });
  await fs.mkdir(path.join(root, 'tests'), { recursive: true });
  await fs.mkdir(path.join(root, '.hidden'), { recursive: true });
  await fs.writeFile(path.join(root, 'README.md'), '# fixture\n');
  await fs.writeFile(path.join(root, 'src', 'a.ts'), 'export const a = 1;\n');
  await fs.writeFile(path.join(root, 'src', 'b.ts'), 'export const b = 2;\n');
  await fs.writeFile(path.join(root, 'src', 'index.tsx'), 'export {};\n');
  await fs.writeFile(path.join(root, 'src', 'components', 'Button.tsx'), 'export {};\n');
  await fs.writeFile(path.join(root, 'tests', 'a.test.ts'), 'test();\n');
  await fs.writeFile(path.join(root, 'tests', 'b.test.ts'), 'test();\n');
  await fs.writeFile(path.join(root, '.hidden', 'secret.ts'), 'export {};\n');
}

describe('GLOB_TOOL_DEFINITION', () => {
  it('declares the expected schema shape', () => {
    expect(GLOB_TOOL_DEFINITION.name).toBe('Glob');
    expect(GLOB_TOOL_DEFINITION.input_schema.required).toEqual(['pattern']);
    expect(GLOB_TOOL_DEFINITION.input_schema.properties).toHaveProperty('pattern');
    expect(GLOB_TOOL_DEFINITION.input_schema.properties).toHaveProperty('path');
    expect(GLOB_TOOL_DEFINITION.input_schema.properties).toHaveProperty('maxResults');
    expect(GLOB_TOOL_DEFINITION.input_schema.properties).toHaveProperty('includeHidden');
    expect(GLOB_TOOL_DEFINITION.input_schema.properties).toHaveProperty('followSymlinks');
    expect(GLOB_TOOL_DEFINITION.input_schema.properties).toHaveProperty('sortBy');
  });
});

describe('executeGlob (tier-3 Node walker)', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    mockNoExternalCommands();
    tmpDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'glob-test-')));
    await buildFixtureTree(tmpDir);
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  });

  it('rejects a missing input', async () => {
    const result = await executeGlob(null, makeContext());
    expect(result.isError).toBe(true);
    expect(result.output).toContain('valid input');
  });

  it('rejects an empty pattern', async () => {
    const result = await executeGlob({ pattern: '   ' }, makeContext());
    expect(result.isError).toBe(true);
    expect(result.output).toContain('non-empty pattern');
  });

  it('rejects a non-existent directory', async () => {
    const result = await executeGlob(
      { pattern: '**/*.ts', path: path.join(tmpDir, 'no-such-dir') },
      makeContext(),
    );
    expect(result.isError).toBe(true);
    expect(result.output).toMatch(/Directory not found|Path is outside/);
  });

  it('matches `**/*.ts` recursively, excluding tsx', async () => {
    const result = await executeGlob({ pattern: '**/*.ts' }, makeContext());
    expect(result.isError).toBe(false);
    expect(result.output).toContain('src/a.ts');
    expect(result.output).toContain('src/b.ts');
    expect(result.output).toContain('tests/a.test.ts');
    expect(result.output).toContain('tests/b.test.ts');
    expect(result.output).not.toContain('index.tsx');
    expect(result.output).not.toContain('Button.tsx');
  });

  it('matches brace expansion `{src,tests}/**/*.ts`', async () => {
    const result = await executeGlob({ pattern: '{src,tests}/**/*.ts' }, makeContext());
    expect(result.isError).toBe(false);
    expect(result.output).toContain('src/a.ts');
    expect(result.output).toContain('tests/a.test.ts');
  });

  it('honours leading `!` negation in the harness', async () => {
    const result = await executeGlob({ pattern: '!**/*.test.ts' }, makeContext());
    expect(result.isError).toBe(false);
    expect(result.output).toContain('src/a.ts');
    expect(result.output).not.toContain('tests/a.test.ts');
    expect(result.output).not.toContain('tests/b.test.ts');
  });

  it('skips hidden files unless includeHidden is true', async () => {
    const without = await executeGlob({ pattern: '**/*.ts' }, makeContext());
    expect(without.output).not.toContain('.hidden');

    const withHidden = await executeGlob(
      { pattern: '**/*.ts', includeHidden: true },
      makeContext(),
    );
    expect(withHidden.isError).toBe(false);
    expect(withHidden.output).toContain('.hidden/secret.ts');
  });

  it('caps results at maxResults and reports truncation', async () => {
    for (let i = 0; i < 30; i++) {
      await fs.writeFile(path.join(tmpDir, `extra-${i}.ts`), 'export {};\n');
    }
    const result = await executeGlob(
      { pattern: '**/*.ts', maxResults: 5 },
      makeContext(),
    );
    expect(result.isError).toBe(false);
    expect(result.output).toMatch(/more match(es)? omitted/);
  });

  it('sorts by name by default', async () => {
    const result = await executeGlob({ pattern: 'src/*.ts' }, makeContext());
    expect(result.isError).toBe(false);
    const lines = result.output.split('\n').filter((l) => /^src\//.test(l));
    expect(lines).toEqual([...lines].sort());
  });

  it('rejects a recursive walk that would escape via symlink', async () => {
    const escapeTarget = await fs.realpath(
      await fs.mkdtemp(path.join(os.tmpdir(), 'glob-escape-')),
    );
    try {
      await fs.writeFile(path.join(escapeTarget, 'secret.ts'), 'leak');
      await fs.symlink(escapeTarget, path.join(tmpDir, 'escape-link'));
      const result = await executeGlob({ pattern: '**/*.ts' }, makeContext());
      expect(result.isError).toBe(false);
      expect(result.output).not.toContain('secret.ts');
    } finally {
      await fs.rm(escapeTarget, { recursive: true, force: true }).catch(() => {});
    }
  });

  it('returns an empty-result message when the pattern matches nothing', async () => {
    const result = await executeGlob(
      { pattern: '**/*.totally-nonexistent-extension' },
      makeContext(),
    );
    expect(result.isError).toBe(false);
    expect(result.output).toMatch(/No files matching/);
  });
});

describe('executeGlob iteration-2 fixes', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    mockNoExternalCommands();
    tmpDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'glob-iter2-')));
    await buildFixtureTree(tmpDir);
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  });

  it('rejects an unclosed bracket pattern up front', async () => {
    const result = await executeGlob({ pattern: '[unclosed' }, makeContext());
    expect(result.isError).toBe(true);
    expect(result.output).toMatch(/Invalid glob pattern/);
  });

  it('rejects an unclosed brace pattern up front', async () => {
    const result = await executeGlob({ pattern: '{unclosed' }, makeContext());
    expect(result.isError).toBe(true);
    expect(result.output).toMatch(/Invalid glob pattern/);
  });

  it('skips symlinked files in tier-3 when followSymlinks is false', async () => {
    const escapeTarget = await fs.realpath(
      await fs.mkdtemp(path.join(os.tmpdir(), 'glob-fl-')),
    );
    try {
      await fs.writeFile(path.join(escapeTarget, 'extern.ts'), 'leak');
      // Symlink-to-file inside the workspace (always-allowed; tests followSymlinks contract)
      await fs.writeFile(path.join(tmpDir, 'real.ts'), 'real');
      await fs.symlink(path.join(tmpDir, 'real.ts'), path.join(tmpDir, 'linked.ts'));
      // Symlink-to-dir
      const innerDir = path.join(tmpDir, 'inner');
      await fs.mkdir(innerDir, { recursive: true });
      await fs.writeFile(path.join(innerDir, 'inside.ts'), 'real');
      await fs.symlink(innerDir, path.join(tmpDir, 'inner-link'));

      const withSymlinks = await executeGlob(
        { pattern: '**/*.ts', followSymlinks: true },
        makeContext(),
      );
      expect(withSymlinks.isError).toBe(false);
      expect(withSymlinks.output).toContain('linked.ts');

      const withoutSymlinks = await executeGlob(
        { pattern: '**/*.ts', followSymlinks: false },
        makeContext(),
      );
      expect(withoutSymlinks.isError).toBe(false);
      expect(withoutSymlinks.output).not.toContain('linked.ts');
      expect(withoutSymlinks.output).not.toContain('inner-link');
    } finally {
      await fs.rm(escapeTarget, { recursive: true, force: true }).catch(() => {});
    }
  });

  it('filters zone-escaping paths returned by the rg backend', async () => {
    if (process.platform === 'win32') return;
    const escapeTarget = await fs.realpath(
      await fs.mkdtemp(path.join(os.tmpdir(), 'glob-rg-escape-')),
    );
    try {
      await fs.writeFile(path.join(escapeTarget, 'leak.ts'), 'leak');
      const insidePath = path.join(tmpDir, 'src', 'a.ts');

      mockExecFile.mockImplementation((cmd, _args, _opts, callback) => {
        if (typeof callback === 'function') {
          if (cmd === 'rg') {
            const stdout = [insidePath, path.join(escapeTarget, 'leak.ts')].join('\n');
            (callback as (err: Error | null, stdout: string, stderr: string) => void)(
              null,
              stdout,
              '',
            );
          } else {
            const err = new Error('ENOENT') as NodeJS.ErrnoException;
            err.code = 'ENOENT';
            (callback as (err: Error | null, stdout: string, stderr: string) => void)(err, '', '');
          }
        }
        return {} as ReturnType<typeof execFile>;
      });

      const result = await executeGlob({ pattern: '**/*.ts' }, makeContext());
      expect(result.isError).toBe(false);
      expect(result.output).toContain('src/a.ts');
      expect(result.output).not.toContain('leak.ts');
    } finally {
      await fs.rm(escapeTarget, { recursive: true, force: true }).catch(() => {});
    }
  });

  it('annotates find partial results with traversal-error truncation', async () => {
    if (process.platform === 'win32') return;
    mockExecFile.mockImplementation((cmd, _args, _opts, callback) => {
      if (typeof callback === 'function') {
        if (cmd === 'rg') {
          const err = new Error('ENOENT') as NodeJS.ErrnoException;
          err.code = 'ENOENT';
          (callback as (err: Error | null, stdout: string, stderr: string) => void)(err, '', '');
        } else if (cmd === 'find') {
          const stdout = path.join(tmpDir, 'src', 'a.ts');
          const error = Object.assign(new Error('partial'), { code: 1 as unknown }) as NodeJS.ErrnoException;
          (callback as (err: Error | null, stdout: string, stderr: string) => void)(
            error,
            stdout,
            'find: ./denied: Permission denied\n',
          );
        }
      }
      return {} as ReturnType<typeof execFile>;
    });
    const result = await executeGlob({ pattern: '**/*.ts' }, makeContext());
    expect(result.isError).toBe(false);
    expect(result.output).toContain('src/a.ts');
    expect(result.output).toMatch(/results may be incomplete/);
    expect(result.output).toMatch(/traversal errors/);
  });
});

describe('executeGlob (tier-1 rg backend)', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    tmpDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'glob-rg-test-')));
    await buildFixtureTree(tmpDir);
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  });

  it('parses rg --files output', async () => {
    if (process.platform === 'win32') return;
    mockExecFile.mockImplementation((cmd, _args, _opts, callback) => {
      if (typeof callback === 'function') {
        if (cmd === 'rg') {
          const stdout = [
            path.join(tmpDir, 'src', 'a.ts'),
            path.join(tmpDir, 'src', 'b.ts'),
          ].join('\n');
          (callback as (err: Error | null, stdout: string, stderr: string) => void)(
            null,
            stdout,
            '',
          );
        } else {
          const err = new Error('ENOENT') as NodeJS.ErrnoException;
          err.code = 'ENOENT';
          (callback as (err: Error | null, stdout: string, stderr: string) => void)(err, '', '');
        }
      }
      return {} as ReturnType<typeof execFile>;
    });

    const result = await executeGlob({ pattern: '**/*.ts' }, makeContext());
    expect(result.isError).toBe(false);
    expect(result.output).toContain('src/a.ts');
    expect(result.output).toContain('src/b.ts');
  });

  it('treats rg exit code 1 as zero matches', async () => {
    if (process.platform === 'win32') return;
    mockExecFile.mockImplementation((cmd, _args, _opts, callback) => {
      if (typeof callback === 'function') {
        if (cmd === 'rg') {
          const err = Object.assign(new Error('Command failed'), {
            code: 1 as unknown,
          }) as NodeJS.ErrnoException;
          (callback as (err: Error | null, stdout: string, stderr: string) => void)(err, '', '');
        } else {
          const err = new Error('ENOENT') as NodeJS.ErrnoException;
          err.code = 'ENOENT';
          (callback as (err: Error | null, stdout: string, stderr: string) => void)(err, '', '');
        }
      }
      return {} as ReturnType<typeof execFile>;
    });

    const result = await executeGlob({ pattern: 'no-such' }, makeContext());
    expect(result.isError).toBe(false);
    expect(result.output).toMatch(/No files matching/);
  });
});

describe('executeGlob (tier-2 find backend)', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    tmpDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'glob-find-test-')));
    await buildFixtureTree(tmpDir);
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  });

  it('falls back to find with picomatch post-filter', async () => {
    if (process.platform === 'win32') return;
    mockExecFile.mockImplementation((cmd, _args, _opts, callback) => {
      if (typeof callback === 'function') {
        if (cmd === 'rg') {
          const err = new Error('ENOENT') as NodeJS.ErrnoException;
          err.code = 'ENOENT';
          (callback as (err: Error | null, stdout: string, stderr: string) => void)(err, '', '');
        } else if (cmd === 'find') {
          const stdout = [
            path.join(tmpDir, 'README.md'),
            path.join(tmpDir, 'src', 'a.ts'),
            path.join(tmpDir, 'src', 'b.ts'),
            path.join(tmpDir, 'src', 'index.tsx'),
            path.join(tmpDir, 'tests', 'a.test.ts'),
          ].join('\n');
          (callback as (err: Error | null, stdout: string, stderr: string) => void)(
            null,
            stdout,
            '',
          );
        }
      }
      return {} as ReturnType<typeof execFile>;
    });

    const result = await executeGlob({ pattern: '**/*.ts' }, makeContext());
    expect(result.isError).toBe(false);
    expect(result.output).toContain('src/a.ts');
    expect(result.output).toContain('src/b.ts');
    expect(result.output).toContain('tests/a.test.ts');
    expect(result.output).not.toContain('index.tsx');
    expect(result.output).not.toContain('README.md');
  });
});

// ── Stage 9: cloud-symlink policy (no hang on incidental dead cloud mounts) ──
describe('executeGlob (cloud-symlink policy)', () => {
  const isCloudPath = (p: string) => p.toLowerCase().includes('/dropbox/');

  function installVerdict(verdict: CloudHealthVerdict): void {
    setCloudLivenessProbe({
      probeHealth: async () => verdict,
      getCachedVerdict: (target) => (isCloudPath(target) ? verdict : 'unknown'),
    });
  }

  /** Create `<tmpDir>/cloud-store/Dropbox/<name>` (classified cloud) with a marker. */
  async function makeCloudDir(name: string): Promise<string> {
    const cloudDir = path.join(tmpDir, 'cloud-store', 'Dropbox', name);
    await fs.mkdir(cloudDir, { recursive: true });
    await fs.writeFile(path.join(cloudDir, 'in-cloud.ts'), 'export const cloud = 1;\n');
    return cloudDir;
  }

  beforeEach(async () => {
    vi.clearAllMocks();
    mockNoExternalCommands(); // force the tier-3 Node walker (real fs)
    __resetCloudSymlinkIndexingForTests();
    __resetCloudLivenessProbeForTesting();
    // S4.1a: an ADMITTED cloud symlink's stat/realpath take the boundary's cloud lane.
    // Wire a HEALTHY (real-fs) executor so the real `Dropbox/` stand-in dereferences as
    // a live mount (the incidental-skip / dead-symlink tests never reach a cloud-lane op).
    setWorkspaceFsExecutor(realFsExecutor);
    tmpDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'glob-cloud-')));
    await fs.mkdir(path.join(tmpDir, 'workspace'), { recursive: true });
    await fs.writeFile(path.join(tmpDir, 'workspace', 'local.ts'), 'export const local = 1;\n');
  });

  afterEach(async () => {
    __resetCloudSymlinkIndexingForTests();
    __resetCloudLivenessProbeForTesting();
    __resetWorkspaceFsExecutorForTesting();
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  });

  it('Node tier skips an incidental cloud symlink but still finds local results', async () => {
    const cloudDir = await makeCloudDir('General');
    await fs.symlink(cloudDir, path.join(tmpDir, 'workspace', 'General'));

    const result = await executeGlob(
      { pattern: '**/*.ts', path: path.join(tmpDir, 'workspace') },
      makeContext(),
    );
    expect(result.isError).toBe(false);
    expect(result.output).toContain('local.ts'); // local found
    expect(result.output).not.toContain('in-cloud.ts'); // cloud subtree skipped
  });

  it('Node tier does NOT hang on a DEAD (dangling) cloud symlink and still finds local results', async () => {
    // Target points into a Dropbox path that does not exist — classified cloud
    // readlink-only, so the walker never stats the missing target (no hang).
    const deadTarget = path.join(tmpDir, 'nope', 'Dropbox', 'Dead');
    await fs.symlink(deadTarget, path.join(tmpDir, 'workspace', 'Dead'));

    const result = await executeGlob(
      { pattern: '**/*.ts', path: path.join(tmpDir, 'workspace') },
      makeContext(),
    );
    expect(result.isError).toBe(false);
    expect(result.output).toContain('local.ts');
  });

  it('Node tier descends into an ADMITTED healthy cloud symlink (flag on + healthy verdict)', async () => {
    setCloudSymlinkIndexingEnabled(true);
    installVerdict('healthy');
    const cloudDir = await makeCloudDir('General');
    await fs.symlink(cloudDir, path.join(tmpDir, 'workspace', 'General'));

    const result = await executeGlob(
      { pattern: '**/*.ts', path: path.join(tmpDir, 'workspace') },
      makeContext(),
    );
    expect(result.isError).toBe(false);
    expect(result.output).toContain('local.ts');
    expect(result.output).toContain('in-cloud.ts'); // admitted → descended
  });

  it('rg tier args exclude an incidental cloud symlink', async () => {
    if (process.platform === 'win32') return;
    const cloudDir = await makeCloudDir('General');
    await fs.symlink(cloudDir, path.join(tmpDir, 'workspace', 'General'));

    let rgArgs: string[] | null = null;
    mockExecFile.mockImplementation((cmd, args, _opts, callback) => {
      if (cmd === 'rg') rgArgs = args as string[];
      if (typeof callback === 'function') {
        (callback as (e: Error | null, o: string, s: string) => void)(null, '', '');
      }
      return {} as ReturnType<typeof execFile>;
    });

    await executeGlob(
      { pattern: '**/*.ts', path: path.join(tmpDir, 'workspace') },
      makeContext(),
    );
    expect(rgArgs).not.toBeNull();
    expect(rgArgs!).toContain('!General');
    expect(rgArgs!).toContain('!General/**');
  });

  it('explicit named-cloud ROOT carve-out: rg args carry NO cloud exclusions', async () => {
    if (process.platform === 'win32') return;
    const cloudDir = await makeCloudDir('NamedFolder');

    let rgArgs: string[] | null = null;
    mockExecFile.mockImplementation((cmd, args, _opts, callback) => {
      if (cmd === 'rg') rgArgs = args as string[];
      if (typeof callback === 'function') {
        (callback as (e: Error | null, o: string, s: string) => void)(null, '', '');
      }
      return {} as ReturnType<typeof execFile>;
    });

    // Search rooted AT the named cloud folder — must still search it (no exclusions).
    await executeGlob({ pattern: '**/*.ts', path: cloudDir }, makeContext({ allowedSymlinkTargets: [cloudDir] }));
    expect(rgArgs).not.toBeNull();
    expect(rgArgs!.some((a) => a.startsWith('!') && a.includes('NamedFolder'))).toBe(false);
  });

  it('F2: find tier with a basename-matching pattern over a DEAD cloud symlink does not hang or return the symlink', async () => {
    // The narrow residual hang: in the `find` tier, a pruned cloud symlink that
    // was still PRINTED would survive a basename-matching pattern (`**`) and reach
    // `verifyNoSymlinkEscape → fs.realpath()` on the dead mount (no timeout). We
    // drive the REAL `find` through the mock so the genuine prune args + matcher +
    // zone-filter pipeline runs end-to-end; the dead symlink must never be returned
    // (and thus never realpath'd).
    if (process.platform === 'win32') return;
    const { execFile: realExecFile } = (await vi.importActual<typeof import('node:child_process')>(
      'node:child_process',
    ));

    // A DEAD cloud symlink (dangling Dropbox target) at the workspace root.
    const deadTarget = path.join(tmpDir, 'nope', 'Dropbox', 'General');
    await fs.symlink(deadTarget, path.join(tmpDir, 'workspace', 'General'));

    mockExecFile.mockImplementation((cmd, args, opts, callback) => {
      const cb = callback as (e: Error | null, o: string, s: string) => void;
      if (cmd === 'rg') {
        // Force the find tier.
        const err = new Error('ENOENT') as NodeJS.ErrnoException;
        err.code = 'ENOENT';
        cb(err, '', '');
        return {} as ReturnType<typeof execFile>;
      }
      if (cmd === 'find') {
        // Run the REAL find with the args globTool built (incl. the prune branch).
        return realExecFile(cmd, args as string[], opts as object, cb) as ReturnType<typeof execFile>;
      }
      cb(null, '', '');
      return {} as ReturnType<typeof execFile>;
    });

    // A basename-matching pattern: `**` matches `General` itself in the old code.
    const result = await Promise.race([
      executeGlob({ pattern: '**', path: path.join(tmpDir, 'workspace') }, makeContext()),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('HANG: find tier did not return')), 8_000)),
    ]);
    expect(result.isError).toBe(false);
    expect(result.output).toContain('local.ts'); // local result preserved
    // The dead cloud symlink must NOT be returned (so it is never realpath'd).
    expect(result.output).not.toMatch(/(^|\n)General(\n|$)/);
  });
});
