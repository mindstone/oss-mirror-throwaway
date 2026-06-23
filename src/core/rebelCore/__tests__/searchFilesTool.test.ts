import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { executeSearchFiles, SEARCH_FILES_TOOL_DEFINITION } from '../tools/searchFilesTool';
import type { BuiltinToolContext } from '../types';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import os from 'node:os';
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

// ── Mock child_process ─────────────────────────────────────────────────

vi.mock('node:child_process', () => ({
  execFile: vi.fn(),
}));

// Import after mock
import { execFile } from 'node:child_process';
const mockExecFile = vi.mocked(execFile);

// ── Test helpers ───────────────────────────────────────────────────────

let tmpDir: string;

async function createTmpDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'searchfiles-test-'));
}

function makeContext(overrides: Partial<BuiltinToolContext> = {}): BuiltinToolContext {
  return {
    cwd: tmpDir,
    ...overrides,
  };
}

/** Simulate execFile callback for success. */
function mockExecFileSuccess(stdout: string, stderr = '') {
  mockExecFile.mockImplementation((_cmd, _args, _opts, callback) => {
    if (typeof callback === 'function') {
      (callback as (error: Error | null, stdout: string, stderr: string) => void)(null, stdout, stderr);
    }
    return {} as ReturnType<typeof execFile>;
  });
}

/** Simulate execFile callback for ENOENT (command not found). */
function mockExecFileEnoent() {
  mockExecFile.mockImplementation((_cmd, _args, _opts, callback) => {
    if (typeof callback === 'function') {
      const err = new Error('spawn rg ENOENT') as NodeJS.ErrnoException;
      err.code = 'ENOENT';
      (callback as (error: Error | null, stdout: string, stderr: string) => void)(err, '', '');
    }
    return {} as ReturnType<typeof execFile>;
  });
}

/** Simulate execFile callback for exit code 1 (no matches). */
function mockExecFileNoMatches() {
  mockExecFile.mockImplementation((_cmd, _args, _opts, callback) => {
    if (typeof callback === 'function') {
      // Node.js child_process uses numeric exit codes on the error object
      const err = Object.assign(new Error('Command failed'), { code: 1 as unknown }) as NodeJS.ErrnoException;
      (callback as (error: Error | null, stdout: string, stderr: string) => void)(err, '', '');
    }
    return {} as ReturnType<typeof execFile>;
  });
}

/** Simulate execFile with different behavior for rg vs grep. */
function mockExecFileByCommand(handlers: Record<string, (callback: (err: Error | null, stdout: string, stderr: string) => void) => void>) {
  mockExecFile.mockImplementation((cmd, _args, _opts, callback) => {
    const handler = handlers[cmd as string];
    if (handler && typeof callback === 'function') {
      handler(callback as (err: Error | null, stdout: string, stderr: string) => void);
    }
    return {} as ReturnType<typeof execFile>;
  });
}

// ── Fixtures ───────────────────────────────────────────────────────────

function makeRgJsonOutput(searchPath: string) {
  return [
    `{"type":"match","data":{"path":{"text":"${searchPath}/src/hello.ts"},"line_number":10,"lines":{"text":"export function hello() {"}}}`,
    `{"type":"match","data":{"path":{"text":"${searchPath}/src/utils.ts"},"line_number":25,"lines":{"text":"  return hello(name);"}}}`,
  ].join('\n');
}

function makeGrepOutput(searchPath: string) {
  return [
    `${searchPath}/src/hello.ts:10:export function hello() {`,
    `${searchPath}/src/utils.ts:25:  return hello(name);`,
  ].join('\n');
}

function extractTotalMatches(output: string): number | null {
  const match = /^Found (\d+) match(?:es)? in /m.exec(output);
  return match ? Number.parseInt(match[1], 10) : null;
}

function countOpenFds(): number | null {
  if (process.platform === 'win32') return null;
  try {
    return fsSync.readdirSync('/dev/fd').length;
  } catch {
    return null;
  }
}

// ── Tests ──────────────────────────────────────────────────────────────

describe('SEARCH_FILES_TOOL_DEFINITION', () => {
  it('has correct name and required fields', () => {
    expect(SEARCH_FILES_TOOL_DEFINITION.name).toBe('SearchFiles');
    expect(SEARCH_FILES_TOOL_DEFINITION.input_schema.required).toEqual(['pattern']);
    expect(SEARCH_FILES_TOOL_DEFINITION.input_schema.properties).toHaveProperty('pattern');
    expect(SEARCH_FILES_TOOL_DEFINITION.input_schema.properties).toHaveProperty('path');
    expect(SEARCH_FILES_TOOL_DEFINITION.input_schema.properties).toHaveProperty('maxResults');
    expect(SEARCH_FILES_TOOL_DEFINITION.input_schema.properties).toHaveProperty('caseSensitive');
    expect(SEARCH_FILES_TOOL_DEFINITION.input_schema.properties).toHaveProperty('followSymlinks');
    expect(SEARCH_FILES_TOOL_DEFINITION.input_schema.properties).toHaveProperty('includeHidden');
  });
});

describe('executeSearchFiles', () => {
  let originalPlatform: PropertyDescriptor | undefined;

  beforeEach(async () => {
    vi.clearAllMocks();
    originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform');
    tmpDir = await createTmpDir();
    // Create a minimal file so the directory is non-empty
    await fs.writeFile(path.join(tmpDir, 'placeholder.txt'), 'placeholder\n');
  });

  afterEach(async () => {
    if (originalPlatform) {
      Object.defineProperty(process, 'platform', originalPlatform);
    }
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  });

  // ── Input Validation ─────────────────────────────────────────────

  it('rejects null input', async () => {
    const result = await executeSearchFiles(null, makeContext());
    expect(result.isError).toBe(true);
    expect(result.output).toContain('requires a valid input');
  });

  it('rejects missing pattern', async () => {
    const result = await executeSearchFiles({}, makeContext());
    expect(result.isError).toBe(true);
    expect(result.output).toContain('requires a search pattern');
  });

  it('rejects empty pattern', async () => {
    const result = await executeSearchFiles({ pattern: '  ' }, makeContext());
    expect(result.isError).toBe(true);
    expect(result.output).toContain('requires a search pattern');
  });

  // ── Invalid path ─────────────────────────────────────────────────

  it('returns error for non-existent directory', async () => {
    const result = await executeSearchFiles(
      { pattern: 'hello', path: '/nonexistent/path/to/nowhere' },
      makeContext(),
    );
    expect(result.isError).toBe(true);
    expect(result.output).toContain('Directory not found');
  });

  // ── rg happy path ───────────────────────────────────────────────

  it('parses rg JSON output correctly', async () => {
    mockExecFileSuccess(makeRgJsonOutput(tmpDir));

    const result = await executeSearchFiles(
      { pattern: 'hello' },
      makeContext(),
    );

    expect(result.isError).toBe(false);
    expect(result.output).toContain('Found 2 matches in 2 files');
    expect(result.output).toContain('src/hello.ts');
    expect(result.output).toContain('src/utils.ts');
    expect(result.output).toContain('Line 10');
    expect(result.output).toContain('Line 25');
  });

  // ── rg no matches ───────────────────────────────────────────────

  it('returns "No matches found" when rg finds nothing (exit code 1)', async () => {
    mockExecFileNoMatches();

    const result = await executeSearchFiles(
      { pattern: 'nonexistentpattern' },
      makeContext(),
    );

    expect(result.isError).toBe(false);
    expect(result.output).toContain('No matches found');
  });

  // ── grep fallback ──────────────────────────────────────────────

  it('falls back to grep when rg is not available', async () => {
    mockExecFileByCommand({
      rg: (cb) => {
        const err = new Error('spawn rg ENOENT') as NodeJS.ErrnoException;
        err.code = 'ENOENT';
        cb(err, '', '');
      },
      grep: (cb) => {
        cb(null, makeGrepOutput(tmpDir), '');
      },
    });

    const result = await executeSearchFiles(
      { pattern: 'hello' },
      makeContext(),
    );

    expect(result.isError).toBe(false);
    expect(result.output).toContain('Found 2 matches in 2 files');
    expect(result.output).toContain('src/hello.ts');
    expect(result.output).toContain('src/utils.ts');
  });

  // ── Node.js fallback ────────────────────────────────────────────

  it('falls back to Node.js when rg and grep are unavailable', async () => {
    // Create test files
    await fs.mkdir(path.join(tmpDir, 'src'), { recursive: true });
    await fs.writeFile(path.join(tmpDir, 'src', 'main.ts'), 'function searchableContent() {\n  return true;\n}\n');
    await fs.writeFile(path.join(tmpDir, 'src', 'utils.ts'), 'const x = 1;\nfunction searchableContent() {\n  return false;\n}\n');

    // Both rg and grep fail with ENOENT
    mockExecFileEnoent();

    const result = await executeSearchFiles(
      { pattern: 'searchableContent' },
      makeContext(),
    );

    expect(result.isError).toBe(false);
    expect(result.output).toContain('Found');
    expect(result.output).toContain('searchableContent');
  });

  it('F3: Node fallback surfaces a truncation signal for a tree deeper than the walker depth cap', async () => {
    // `safeWalkDirectory` caps depth at 12 (DEFAULT_SAFE_WALK_LIMITS.MAX_DEPTH).
    // The old hand-rolled walker had no depth cap; the new one does, so a deep
    // tree is now truncated — and that incompleteness MUST be surfaced, not
    // silently swallowed (AGENTS.md silent-failure rule).
    let dir = tmpDir;
    for (let i = 0; i < 16; i++) {
      dir = path.join(dir, `level${i}`);
    }
    await fs.mkdir(dir, { recursive: true });
    // Put a match shallow so we still produce output to attach the note to.
    await fs.writeFile(path.join(tmpDir, 'shallow.txt'), 'deepNeedle here\n');
    // A match buried below the depth cap is unreachable, but the SIGNAL is the point.
    await fs.writeFile(path.join(dir, 'buried.txt'), 'deepNeedle here\n');

    mockExecFileEnoent(); // force the Node tier (real fs)

    const result = await executeSearchFiles(
      { pattern: 'deepNeedle' },
      makeContext(),
    );
    expect(result.isError).toBe(false);
    // Shallow match found, and the depth-cap truncation is surfaced (not silent).
    expect(result.output).toContain('shallow.txt');
    expect(result.output).toMatch(/results may be incomplete/);
    expect(result.output).toMatch(/depth/);
  });

  it('F3: Node fallback keeps clean output (no truncation note) for a shallow complete tree', async () => {
    await fs.mkdir(path.join(tmpDir, 'src'), { recursive: true });
    await fs.writeFile(path.join(tmpDir, 'src', 'main.ts'), 'cleanNeedle\n');
    mockExecFileEnoent();

    const result = await executeSearchFiles(
      { pattern: 'cleanNeedle' },
      makeContext(),
    );
    expect(result.isError).toBe(false);
    expect(result.output).toContain('cleanNeedle');
    expect(result.output).not.toMatch(/results may be incomplete/);
  });

  // ── Result truncation ───────────────────────────────────────────

  it('truncates results when exceeding maxResults', async () => {
    // Generate many rg JSON match lines
    const manyMatches = Array.from({ length: 10 }, (_, i) =>
      `{"type":"match","data":{"path":{"text":"${tmpDir}/file.ts"},"line_number":${i + 1},"lines":{"text":"match line ${i + 1}"}}}`,
    ).join('\n');

    mockExecFileSuccess(manyMatches);

    const result = await executeSearchFiles(
      { pattern: 'match', maxResults: 3 },
      makeContext(),
    );

    expect(result.isError).toBe(false);
    expect(result.output).toContain('Found 10 matches');
    expect(result.output).toContain('7 more results omitted');
  });

  // ── Case insensitivity ──────────────────────────────────────────

  it('passes -i flag when caseSensitive is false', async () => {
    mockExecFileSuccess('');

    await executeSearchFiles(
      { pattern: 'Hello', caseSensitive: false },
      makeContext(),
    );

    // Check that rg was called with -i flag
    expect(mockExecFile).toHaveBeenCalled();
    const args = mockExecFile.mock.calls[0]![1] as string[];
    expect(args).toContain('-i');
  });

  it('does not pass -i flag when caseSensitive is true', async () => {
    mockExecFileSuccess('');

    await executeSearchFiles(
      { pattern: 'Hello', caseSensitive: true },
      makeContext(),
    );

    expect(mockExecFile).toHaveBeenCalled();
    const args = mockExecFile.mock.calls[0]![1] as string[];
    expect(args).not.toContain('-i');
  });

  // ── Option injection prevention ─────────────────────────────────

  it('handles patterns starting with - via -e flag', async () => {
    mockExecFileSuccess('');

    await executeSearchFiles(
      { pattern: '--malicious' },
      makeContext(),
    );

    expect(mockExecFile).toHaveBeenCalled();
    const args = mockExecFile.mock.calls[0]![1] as string[];
    const eIndex = args.indexOf('-e');
    expect(eIndex).toBeGreaterThan(-1);
    expect(args[eIndex + 1]).toBe('--malicious');

    // Check -- separates flags from path
    const dashDashIndex = args.indexOf('--');
    expect(dashDashIndex).toBeGreaterThan(eIndex);
  });

  // ── Windows skips rg/grep ───────────────────────────────────────

  it('skips rg and grep on Windows, goes straight to Node.js', async () => {
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });

    await fs.writeFile(path.join(tmpDir, 'test.txt'), 'hello world\ngoodbye world\n');

    // Track if execFile is called
    let execFileCalled = false;
    mockExecFile.mockImplementation((_cmd, _args, _opts, callback) => {
      execFileCalled = true;
      if (typeof callback === 'function') {
        const err = new Error('ENOENT') as NodeJS.ErrnoException;
        err.code = 'ENOENT';
        (callback as (error: Error | null, stdout: string, stderr: string) => void)(err, '', '');
      }
      return {} as ReturnType<typeof execFile>;
    });

    const result = await executeSearchFiles(
      { pattern: 'hello' },
      makeContext(),
    );

    expect(result.isError).toBe(false);
    expect(result.output).toContain('hello world');
    // rg and grep should not be called on Windows
    expect(execFileCalled).toBe(false);
  });

  // ── Path resolution ─────────────────────────────────────────────

  it('resolves relative path from cwd', async () => {
    // Create a real subdirectory
    const subDir = path.join(tmpDir, 'src', 'lib');
    await fs.mkdir(subDir, { recursive: true });
    await fs.writeFile(path.join(subDir, 'test.ts'), 'test content\n');

    mockExecFileSuccess('');

    await executeSearchFiles(
      { pattern: 'test', path: 'src/lib' },
      makeContext(),
    );

    // The search path passed to rg should be the resolved absolute path
    expect(mockExecFile).toHaveBeenCalled();
    const args = mockExecFile.mock.calls[0]![1] as string[];
    const lastArg = args[args.length - 1];
    expect(lastArg).toBe(path.join(tmpDir, 'src', 'lib'));
  });

  // ── Node.js fallback skips excluded dirs ────────────────────────

  it('Node.js fallback skips node_modules and .git', async () => {
    // Create files including in excluded dirs
    await fs.mkdir(path.join(tmpDir, 'src'), { recursive: true });
    await fs.mkdir(path.join(tmpDir, 'node_modules', 'pkg'), { recursive: true });
    await fs.mkdir(path.join(tmpDir, '.git', 'objects'), { recursive: true });
    await fs.writeFile(path.join(tmpDir, 'src', 'app.ts'), 'findThisPattern\n');
    await fs.writeFile(path.join(tmpDir, 'node_modules', 'pkg', 'index.js'), 'findThisPattern\n');
    await fs.writeFile(path.join(tmpDir, '.git', 'objects', 'data'), 'findThisPattern\n');

    mockExecFileEnoent();

    const result = await executeSearchFiles(
      { pattern: 'findThisPattern' },
      makeContext(),
    );

    expect(result.isError).toBe(false);
    expect(result.output).toContain('Found 1 match');
    expect(result.output).toContain('src/app.ts');
    expect(result.output).not.toContain('node_modules');
    expect(result.output).not.toContain('.git');
  });

  // ── rg includes --follow flag for symlinks ──────────────────────

  it('passes --follow flag to rg when followSymlinks is true', async () => {
    mockExecFileSuccess('');

    await executeSearchFiles(
      { pattern: 'test', followSymlinks: true },
      makeContext(),
    );

    expect(mockExecFile).toHaveBeenCalled();
    const args = mockExecFile.mock.calls[0]![1] as string[];
    expect(args).toContain('--follow');
  });

  it('does not pass --follow flag when followSymlinks is false', async () => {
    mockExecFileSuccess('');

    await executeSearchFiles(
      { pattern: 'test', followSymlinks: false },
      makeContext(),
    );

    expect(mockExecFile).toHaveBeenCalled();
    const args = mockExecFile.mock.calls[0]![1] as string[];
    expect(args).not.toContain('--follow');
  });

  // ── Default maxResults caps at 200 ──────────────────────────────

  it('caps maxResults at 200', async () => {
    mockExecFileSuccess('');

    await executeSearchFiles(
      { pattern: 'test', maxResults: 500 },
      makeContext(),
    );

    // rg should get maxResults + 1 = 201 as --max-count
    expect(mockExecFile).toHaveBeenCalled();
    const args = mockExecFile.mock.calls[0]![1] as string[];
    const maxCountIdx = args.indexOf('--max-count');
    expect(args[maxCountIdx + 1]).toBe('201');
  });

  // ── rg --hidden flag ────────────────────────────────────────────

  it('passes --hidden flag to rg when includeHidden is true', async () => {
    mockExecFileSuccess('');

    await executeSearchFiles(
      { pattern: 'test', includeHidden: true },
      makeContext(),
    );

    expect(mockExecFile).toHaveBeenCalled();
    const args = mockExecFile.mock.calls[0]![1] as string[];
    expect(args).toContain('--hidden');
  });

  it('does not leak file descriptors in Node fallback when match overflow threshold is exceeded', async () => {
    const beforeFds = countOpenFds();
    if (beforeFds == null) {
      return;
    }

    const fixtureDir = path.join(tmpDir, 'many-files');
    await fs.mkdir(fixtureDir, { recursive: true });

    const fileCount = 220;
    for (let i = 0; i < fileCount; i++) {
      await fs.writeFile(path.join(fixtureDir, `file-${i}.txt`), `leak-target line ${i}\n`);
    }

    mockExecFileEnoent();

    const result = await executeSearchFiles(
      { pattern: 'leak-target', path: fixtureDir, maxResults: 5 },
      makeContext(),
    );

    expect(result.isError).toBe(false);

    const afterFds = countOpenFds();
    if (afterFds == null) {
      return;
    }

    // Runtime may open/close a couple of descriptors during test execution.
    expect(afterFds - beforeFds).toBeLessThanOrEqual(3);
  });

  it('stops scanning additional files after match overflow threshold is exceeded', async () => {
    const fixtureDir = path.join(tmpDir, 'overflow-threshold');
    await fs.mkdir(fixtureDir, { recursive: true });

    const fileCount = 220;
    for (let i = 0; i < fileCount; i++) {
      await fs.writeFile(path.join(fixtureDir, `file-${i}.txt`), `threshold-target line ${i}\n`);
    }

    mockExecFileEnoent();

    const result = await executeSearchFiles(
      { pattern: 'threshold-target', path: fixtureDir, maxResults: 5 },
      makeContext(),
    );

    expect(result.isError).toBe(false);
    const totalMatches = extractTotalMatches(result.output);
    expect(totalMatches).not.toBeNull();
    expect(totalMatches).toBeLessThanOrEqual(106);
  });

  it('Node fallback keeps normal output formatting for sub-threshold searches', async () => {
    const fixtureDir = path.join(tmpDir, 'sub-threshold');
    await fs.mkdir(fixtureDir, { recursive: true });
    await fs.writeFile(path.join(fixtureDir, 'a.txt'), 'sub-threshold-target\n');
    await fs.writeFile(path.join(fixtureDir, 'b.txt'), 'sub-threshold-target\n');

    mockExecFileEnoent();

    const result = await executeSearchFiles(
      { pattern: 'sub-threshold-target', path: fixtureDir, maxResults: 5 },
      makeContext(),
    );

    expect(result.isError).toBe(false);
    expect(result.output).toContain('Found 2 matches in 2 files');
    expect(result.output).not.toContain('more results omitted');
  });

  it('Node fallback treats files with null bytes in first 512 bytes as binary (skip)', async () => {
    const fixtureDir = path.join(tmpDir, 'binary-first-512');
    await fs.mkdir(fixtureDir, { recursive: true });
    await fs.writeFile(path.join(fixtureDir, 'binary.bin'), Buffer.from('binary-needle\0payload', 'utf8'));

    mockExecFileEnoent();

    const result = await executeSearchFiles(
      { pattern: 'binary-needle', path: fixtureDir, maxResults: 10 },
      makeContext(),
    );

    expect(result.isError).toBe(false);
    expect(result.output).toContain('No matches found');
  });

  it('Node fallback treats large files with null bytes after 512 bytes as text', async () => {
    const fixtureDir = path.join(tmpDir, 'binary-after-512');
    await fs.mkdir(fixtureDir, { recursive: true });
    const largeTextWithLateNull = `late-null-needle\n${'a'.repeat(700)}\0tail`;
    await fs.writeFile(path.join(fixtureDir, 'large.txt'), largeTextWithLateNull, 'utf8');

    mockExecFileEnoent();

    const result = await executeSearchFiles(
      { pattern: 'late-null-needle', path: fixtureDir, maxResults: 10 },
      makeContext(),
    );

    expect(result.isError).toBe(false);
    expect(result.output).toContain('Found 1 match in 1 file');
  });

  it('Node fallback handles empty files as text (no false binary classification)', async () => {
    const fixtureDir = path.join(tmpDir, 'empty-file');
    await fs.mkdir(fixtureDir, { recursive: true });
    await fs.writeFile(path.join(fixtureDir, 'empty.txt'), '', 'utf8');
    await fs.writeFile(path.join(fixtureDir, 'match.txt'), 'empty-file-needle\n', 'utf8');

    mockExecFileEnoent();

    const result = await executeSearchFiles(
      { pattern: 'empty-file-needle', path: fixtureDir, maxResults: 10 },
      makeContext(),
    );

    expect(result.isError).toBe(false);
    expect(result.output).toContain('Found 1 match in 1 file');
    expect(result.output).toContain('match.txt');
  });

  it('Node fallback treats unreadable files as binary and skips them', async () => {
    if (process.platform === 'win32') {
      return;
    }

    const fixtureDir = path.join(tmpDir, 'unreadable-file');
    await fs.mkdir(fixtureDir, { recursive: true });
    const readablePath = path.join(fixtureDir, 'readable.txt');
    const unreadablePath = path.join(fixtureDir, 'unreadable.txt');
    await fs.writeFile(readablePath, 'permission-needle\n', 'utf8');
    await fs.writeFile(unreadablePath, 'permission-needle\n', 'utf8');
    await fsSync.promises.chmod(unreadablePath, 0);

    mockExecFileEnoent();

    const result = await executeSearchFiles(
      { pattern: 'permission-needle', path: fixtureDir, maxResults: 10 },
      makeContext(),
    );

    await fsSync.promises.chmod(unreadablePath, 0o644).catch(() => {});

    expect(result.isError).toBe(false);
    expect(result.output).toContain('Found 1 match in 1 file');
    expect(result.output).toContain('readable.txt');
    expect(result.output).not.toContain('unreadable.txt');
  });

  it('Node fallback still searches plain text files', async () => {
    const fixtureDir = path.join(tmpDir, 'plain-text');
    await fs.mkdir(fixtureDir, { recursive: true });
    await fs.writeFile(path.join(fixtureDir, 'text.txt'), 'plain-text-needle\n', 'utf8');

    mockExecFileEnoent();

    const result = await executeSearchFiles(
      { pattern: 'plain-text-needle', path: fixtureDir, maxResults: 10 },
      makeContext(),
    );

    expect(result.isError).toBe(false);
    expect(result.output).toContain('Found 1 match in 1 file');
    expect(result.output).toContain('text.txt');
  });
});

// ── Stage 9: cloud-symlink policy (no hang on incidental dead cloud mounts) ──
describe('executeSearchFiles (cloud-symlink policy)', () => {
  let originalPlatform: PropertyDescriptor | undefined;
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
    await fs.writeFile(path.join(cloudDir, 'in-cloud.txt'), 'cloud-needle\n');
    return cloudDir;
  }

  beforeEach(async () => {
    vi.clearAllMocks();
    originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform');
    __resetCloudSymlinkIndexingForTests();
    __resetCloudLivenessProbeForTesting();
    // S4.1a: an ADMITTED cloud symlink's stat/realpath now take the boundary's cloud
    // lane. Wire a HEALTHY (real-fs) executor so the real `Dropbox/` stand-in is
    // dereferenced as a live mount (the incidental-skip / dead-symlink tests never
    // reach a cloud-lane op, so the executor is inert for them).
    setWorkspaceFsExecutor(realFsExecutor);
    tmpDir = await fs.realpath(await createTmpDir());
    await fs.mkdir(path.join(tmpDir, 'workspace'), { recursive: true });
    await fs.writeFile(path.join(tmpDir, 'workspace', 'local.txt'), 'local-needle\n');
  });

  afterEach(async () => {
    if (originalPlatform) {
      Object.defineProperty(process, 'platform', originalPlatform);
    }
    __resetCloudSymlinkIndexingForTests();
    __resetCloudLivenessProbeForTesting();
    __resetWorkspaceFsExecutorForTesting();
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  });

  it('Node tier skips an incidental cloud symlink but still finds local matches', async () => {
    const cloudDir = await makeCloudDir('General');
    await fs.symlink(cloudDir, path.join(tmpDir, 'workspace', 'General'));
    mockExecFileEnoent(); // force the Node tier (real fs)

    const result = await executeSearchFiles(
      { pattern: 'needle', path: path.join(tmpDir, 'workspace') },
      makeContext(),
    );
    expect(result.isError).toBe(false);
    expect(result.output).toContain('local.txt'); // local match found
    expect(result.output).not.toContain('in-cloud.txt'); // cloud subtree skipped
  });

  it('Node tier does NOT hang on a DEAD (dangling) cloud symlink and still finds local matches', async () => {
    const deadTarget = path.join(tmpDir, 'nope', 'Dropbox', 'Dead');
    await fs.symlink(deadTarget, path.join(tmpDir, 'workspace', 'Dead'));
    mockExecFileEnoent();

    const result = await executeSearchFiles(
      { pattern: 'needle', path: path.join(tmpDir, 'workspace') },
      makeContext(),
    );
    expect(result.isError).toBe(false);
    expect(result.output).toContain('local.txt');
  });

  it('Node tier descends into an ADMITTED healthy cloud symlink (flag on + healthy verdict)', async () => {
    setCloudSymlinkIndexingEnabled(true);
    installVerdict('healthy');
    const cloudDir = await makeCloudDir('General');
    await fs.symlink(cloudDir, path.join(tmpDir, 'workspace', 'General'));
    mockExecFileEnoent();

    const result = await executeSearchFiles(
      { pattern: 'needle', path: path.join(tmpDir, 'workspace') },
      makeContext(),
    );
    expect(result.isError).toBe(false);
    expect(result.output).toContain('local.txt');
    expect(result.output).toContain('in-cloud.txt'); // admitted → descended
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

    await executeSearchFiles(
      { pattern: 'needle', path: path.join(tmpDir, 'workspace') },
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

    await executeSearchFiles({ pattern: 'needle', path: cloudDir }, makeContext());
    expect(rgArgs).not.toBeNull();
    expect(rgArgs!.some((a) => a.startsWith('!') && a.includes('NamedFolder'))).toBe(false);
  });
});
