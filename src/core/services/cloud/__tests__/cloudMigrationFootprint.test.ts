
 
vi.mock('@core/logger', () => ({
  createScopedLogger: () => ({
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    trace: vi.fn(),
  }),
}));

import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {
  getCloudMigrationFootprint,
  type FootprintClock,
} from '../cloudMigrationFootprint';

/**
 * Tests for cloudMigrationFootprint.
 *
 * Uses `fs.mkdtemp(os.tmpdir())` for filesystem fixtures (lifecycle tied to
 * the test runner — no repo-level fixture required). Clock is injected so
 * timeouts are deterministic without real setTimeouts.
 */

let tempRoot: string;

beforeEach(async () => {
  tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'cloud-footprint-test-'));
});

afterEach(async () => {
  await fs.rm(tempRoot, { recursive: true, force: true });
});

class FakeClock implements FootprintClock {
  private ms = 0;
  now(): number {
    return this.ms;
  }
  advance(delta: number): void {
    this.ms += delta;
  }
}

async function makeDirTree(
  root: string,
  tree: Record<string, string | Record<string, string>>,
): Promise<void> {
  await fs.mkdir(root, { recursive: true });
  for (const [name, contents] of Object.entries(tree)) {
    const p = path.join(root, name);
    if (typeof contents === 'string') {
      await fs.writeFile(p, contents, 'utf8');
    } else {
      await fs.mkdir(p, { recursive: true });
      await makeDirTree(p, contents);
    }
  }
}

describe('getCloudMigrationFootprint', () => {
  // ------------------------------------------------------------------------
  // measured_zero
  // ------------------------------------------------------------------------

  it('returns measured_zero for empty workspace + empty userData', async () => {
    const workspace = path.join(tempRoot, 'workspace');
    const userData = path.join(tempRoot, 'userData');
    await fs.mkdir(workspace, { recursive: true });
    await fs.mkdir(userData, { recursive: true });

    const result = await getCloudMigrationFootprint({
      coreDirectory: workspace,
      userDataPath: userData,
    });

    expect(result.kind).toBe('measured_zero');
    if (result.kind === 'measured_zero') {
      expect(result.totalBytes).toBe(0);
      expect(result.workspaceBytes).toBe(0);
      expect(result.appDataBytes).toBe(0);
    }
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('returns measured_zero when workspace skip-listed files are the only content', async () => {
    const workspace = path.join(tempRoot, 'workspace');
    const userData = path.join(tempRoot, 'userData');
    await fs.mkdir(userData, { recursive: true });
    // .git and node_modules should be skipped → zero
    await makeDirTree(workspace, {
      '.git': { 'HEAD': 'ref: refs/heads/main' },
      'node_modules': { 'foo.js': 'x'.repeat(10_000) },
    });

    const result = await getCloudMigrationFootprint({
      coreDirectory: workspace,
      userDataPath: userData,
    });

    expect(result.kind).toBe('measured_zero');
    if (result.kind === 'measured_zero') {
      expect(result.workspaceBytes).toBe(0);
      expect(result.appDataBytes).toBe(0);
    }
  });

  // ------------------------------------------------------------------------
  // measured_nonzero
  // ------------------------------------------------------------------------

  it('sums workspace bytes, skipping skip-list directories', async () => {
    const workspace = path.join(tempRoot, 'workspace');
    const userData = path.join(tempRoot, 'userData');
    await fs.mkdir(userData, { recursive: true });

    // 1234 bytes that count + 10k bytes in node_modules that don't
    const counted = 'x'.repeat(1234);
    const uncounted = 'y'.repeat(10_000);
    await makeDirTree(workspace, {
      'README.md': counted,
      'sub': { 'a.txt': counted }, // 1234 more
      'node_modules': { 'pkg.js': uncounted },
      '.git': { 'HEAD': uncounted },
    });

    const result = await getCloudMigrationFootprint({
      coreDirectory: workspace,
      userDataPath: userData,
    });

    expect(result.kind).toBe('measured_nonzero');
    if (result.kind === 'measured_nonzero') {
      expect(result.workspaceBytes).toBe(2468);
      expect(result.appDataBytes).toBe(0);
      expect(result.totalBytes).toBe(2468);
    }
  });

  it('sums userData bytes, skipping APP_DATA_SKIP entries', async () => {
    const userData = path.join(tempRoot, 'userData');
    // `Cache` and `logs` are in APP_DATA_SKIP; `meetingCache` is not.
    await makeDirTree(userData, {
      'Cache': { 'index': 'x'.repeat(10_000) },
      'logs': { 'app.log': 'y'.repeat(10_000) },
      'meetingCache': { 'index.json': '{}' }, // 2 bytes
      'app-settings.json': '{"foo":"bar"}', // in APP_DATA_SKIP
    });

    const result = await getCloudMigrationFootprint({
      userDataPath: userData,
    });

    expect(result.kind).toBe('measured_nonzero');
    if (result.kind === 'measured_nonzero') {
      expect(result.appDataBytes).toBe(2);
      expect(result.totalBytes).toBe(2);
      // workspace should be omitted since coreDirectory wasn't provided
      expect('workspaceBytes' in result ? result.workspaceBytes : undefined).toBeUndefined();
    }
  });

  it('includes both workspace and app data in totalBytes', async () => {
    const workspace = path.join(tempRoot, 'workspace');
    const userData = path.join(tempRoot, 'userData');
    await makeDirTree(workspace, {
      'a.txt': 'x'.repeat(100),
    });
    await makeDirTree(userData, {
      'store': { 'data.json': '{}' }, // 2 bytes
    });

    const result = await getCloudMigrationFootprint({
      coreDirectory: workspace,
      userDataPath: userData,
    });

    expect(result.kind).toBe('measured_nonzero');
    if (result.kind === 'measured_nonzero') {
      expect(result.workspaceBytes).toBe(100);
      expect(result.appDataBytes).toBe(2);
      expect(result.totalBytes).toBe(102);
    }
  });

  it('handles null/undefined/blank coreDirectory by measuring only userData', async () => {
    const userData = path.join(tempRoot, 'userData');
    await makeDirTree(userData, { 'a.json': '{}' });

    for (const coreDirectory of [null, undefined, '', '   ']) {
      const result = await getCloudMigrationFootprint({
        coreDirectory,
        userDataPath: userData,
      });
      expect(result.kind).toBe('measured_nonzero');
      if (result.kind === 'measured_nonzero') {
        expect('workspaceBytes' in result ? result.workspaceBytes : undefined).toBeUndefined();
        expect(result.appDataBytes).toBe(2);
      }
    }
  });

  // ------------------------------------------------------------------------
  // unknown_partial: ENOENT on root is handled gracefully
  // ------------------------------------------------------------------------

  it('treats a missing coreDirectory as workspaceBytes=0, not a partial', async () => {
    const userData = path.join(tempRoot, 'userData');
    await fs.mkdir(userData, { recursive: true });
    const ghostWorkspace = path.join(tempRoot, 'does-not-exist');

    const result = await getCloudMigrationFootprint({
      coreDirectory: ghostWorkspace,
      userDataPath: userData,
    });

    expect(result.kind).toBe('measured_zero');
    if (result.kind === 'measured_zero') {
      expect(result.workspaceBytes).toBe(0);
    }
  });

  // ------------------------------------------------------------------------
  // unknown_partial: userDataPath missing/empty/nonexistent must not be
  // silently collapsed to "zero" — it's a mount error we can't see past.
  // ------------------------------------------------------------------------

  it('returns unknown_partial/mount_error when userDataPath is empty', async () => {
    const result = await getCloudMigrationFootprint({
      userDataPath: '',
    });
    expect(result.kind).toBe('unknown_partial');
    if (result.kind === 'unknown_partial') {
      expect(result.reason).toBe('mount_error');
      expect(result.partialBytes).toBe(0);
    }
    expect(typeof result.durationMs).toBe('number');
  });

  it('returns unknown_partial/mount_error when userDataPath is whitespace', async () => {
    const result = await getCloudMigrationFootprint({
      userDataPath: '   ',
    });
    expect(result.kind).toBe('unknown_partial');
    if (result.kind === 'unknown_partial') {
      expect(result.reason).toBe('mount_error');
      expect(result.partialBytes).toBe(0);
    }
  });

  it('returns unknown_partial/mount_error when userDataPath does not exist', async () => {
    const ghost = path.join(tempRoot, 'no-such-userdata');
    const result = await getCloudMigrationFootprint({
      userDataPath: ghost,
    });
    expect(result.kind).toBe('unknown_partial');
    if (result.kind === 'unknown_partial') {
      expect(result.reason).toBe('mount_error');
    }
  });

  // ------------------------------------------------------------------------
  // unknown_partial: EACCES on a subtree reports the partial instead of
  // silently continuing as if the subtree were empty. `partialBytes` must
  // reflect what WAS readable.
  // ------------------------------------------------------------------------

  it('continues walking siblings on EACCES but returns unknown_partial with accumulated partialBytes', async () => {
    const workspace = path.join(tempRoot, 'workspace');
    const userData = path.join(tempRoot, 'userData');
    await makeDirTree(workspace, {
      'counted.txt': 'x'.repeat(100),
      'forbidden': { 'blocked.txt': 'secret' },
      'also-counted.txt': 'y'.repeat(50),
    });
    await fs.mkdir(userData, { recursive: true });

    const originalReaddir = fs.readdir.bind(fs);
    const spy = vi
      .spyOn(fs, 'readdir')
      .mockImplementation((async (p: unknown, opts: unknown) => {
        const str = typeof p === 'string' ? p : String(p);
        if (str.endsWith(path.join('workspace', 'forbidden'))) {
          const err = new Error('permission denied') as NodeJS.ErrnoException;
          err.code = 'EACCES';
          throw err;
        }
        return (originalReaddir as unknown as (
          path: unknown,
          options: unknown,
        ) => Promise<unknown>)(p, opts);
      }) as unknown as typeof fs.readdir);

    try {
      const result = await getCloudMigrationFootprint({
        coreDirectory: workspace,
        userDataPath: userData,
      });
      expect(result.kind).toBe('unknown_partial');
      if (result.kind === 'unknown_partial') {
        expect(result.reason).toBe('permission');
        // 100 + 50 bytes from the sibling files we *could* read.
        expect(result.partialBytes).toBe(150);
      }
    } finally {
      spy.mockRestore();
    }
  });

  // ------------------------------------------------------------------------
  // Reason priority: permission > mount_error > symlink_cycle > timeout.
  // When multiple reasons are observed, the highest-priority wins.
  // ------------------------------------------------------------------------

  it('prefers permission over mount_error when both are observed', async () => {
    const workspace = path.join(tempRoot, 'workspace');
    const userData = path.join(tempRoot, 'userData');
    await makeDirTree(workspace, {
      'ok.txt': 'x',
      'busy': { 'a.txt': 'a' },
      'forbidden': { 'b.txt': 'b' },
    });
    await fs.mkdir(userData, { recursive: true });

    const originalReaddir = fs.readdir.bind(fs);
    const spy = vi
      .spyOn(fs, 'readdir')
      .mockImplementation((async (p: unknown, opts: unknown) => {
        const str = typeof p === 'string' ? p : String(p);
        if (str.endsWith(path.join('workspace', 'busy'))) {
          const err = new Error('resource busy') as NodeJS.ErrnoException;
          err.code = 'EBUSY';
          throw err;
        }
        if (str.endsWith(path.join('workspace', 'forbidden'))) {
          const err = new Error('permission denied') as NodeJS.ErrnoException;
          err.code = 'EACCES';
          throw err;
        }
        return (originalReaddir as unknown as (
          path: unknown,
          options: unknown,
        ) => Promise<unknown>)(p, opts);
      }) as unknown as typeof fs.readdir);

    try {
      const result = await getCloudMigrationFootprint({
        coreDirectory: workspace,
        userDataPath: userData,
      });
      expect(result.kind).toBe('unknown_partial');
      if (result.kind === 'unknown_partial') {
        expect(result.reason).toBe('permission');
      }
    } finally {
      spy.mockRestore();
    }
  });

  // ------------------------------------------------------------------------
  // unknown_partial: symlink cycle detection
  // ------------------------------------------------------------------------

  it('does not flag directory-symlink aliases as a cycle (regression: 260422)', async () => {
    // Two directory symlinks pointing at the SAME target directory (walked
    // at different times, never overlapping on the recursion path) are
    // aliases, not cycles. The DFS ancestor-set check should allow the
    // second walk to proceed cleanly.
    if (process.platform === 'win32') return;

    const workspace = path.join(tempRoot, 'workspace');
    const userData = path.join(tempRoot, 'userData');
    await fs.mkdir(workspace, { recursive: true });
    await fs.mkdir(userData, { recursive: true });

    // shared/: real directory with 100 bytes of content.
    const shared = path.join(workspace, 'shared');
    await fs.mkdir(shared);
    await fs.writeFile(path.join(shared, 'a.txt'), 'x'.repeat(100), 'utf8');
    // Two sibling dir symlinks pointing at `shared`.
    await fs.symlink(shared, path.join(workspace, 'alias1'), 'dir');
    await fs.symlink(shared, path.join(workspace, 'alias2'), 'dir');

    const result = await getCloudMigrationFootprint({
      coreDirectory: workspace,
      userDataPath: userData,
    });

    expect(result.kind).toBe('measured_nonzero');
    if (result.kind === 'measured_nonzero') {
      // 100 (real) + 100 (alias1 walked) + 100 (alias2 walked) = 300.
      expect(result.workspaceBytes).toBe(300);
      expect(result.totalBytes).toBe(300);
    }
  });

  it('does not flag file-symlink aliases as a cycle (regression: 260422)', async () => {
    // Two symlinks pointing to the same file (e.g. CLAUDE.md -> AGENTS.md
    // plus rebel-system/CLAUDE.md -> same target) must NOT trigger the
    // symlink_cycle guard. They're aliases, not cycles — file aliases
    // cannot cause an infinite walk.
    if (process.platform === 'win32') return;

    const workspace = path.join(tempRoot, 'workspace');
    const userData = path.join(tempRoot, 'userData');
    await fs.mkdir(workspace, { recursive: true });
    await fs.mkdir(userData, { recursive: true });

    // AGENTS.md: real file, 100 bytes.
    const agentsPath = path.join(workspace, 'AGENTS.md');
    await fs.writeFile(agentsPath, 'x'.repeat(100), 'utf8');
    // CLAUDE.md: symlink pointing to AGENTS.md (same directory).
    await fs.symlink('AGENTS.md', path.join(workspace, 'CLAUDE.md'));
    // Second symlink aliasing the same target in a subdirectory.
    const subdir = path.join(workspace, 'sub');
    await fs.mkdir(subdir);
    await fs.symlink(agentsPath, path.join(subdir, 'CLAUDE.md'));

    const result = await getCloudMigrationFootprint({
      coreDirectory: workspace,
      userDataPath: userData,
    });

    // Must be measured_nonzero — two file aliases are not a cycle.
    expect(result.kind).toBe('measured_nonzero');
    if (result.kind === 'measured_nonzero') {
      // 100 (real file) + 100 (symlink 1) + 100 (symlink 2) = 300.
      // Double-counting aliases matches uploader behaviour (the uploader
      // treats each symlink as its own upload path).
      expect(result.workspaceBytes).toBe(300);
      expect(result.totalBytes).toBe(300);
    }
  });

  it('detects a symlink cycle and reports unknown_partial/symlink_cycle', async () => {
    // Some CI filesystems (rare) lack symlink support — skip on Windows to be safe.
    if (process.platform === 'win32') return;

    const workspace = path.join(tempRoot, 'workspace');
    const userData = path.join(tempRoot, 'userData');
    await fs.mkdir(workspace, { recursive: true });
    await fs.mkdir(userData, { recursive: true });

    // Create a → b → a cycle by having each directory contain a symlink to the other.
    const dirA = path.join(workspace, 'a');
    const dirB = path.join(workspace, 'b');
    await fs.mkdir(dirA);
    await fs.mkdir(dirB);
    // Place a content file so there's something before we hit the cycle
    await fs.writeFile(path.join(dirA, 'x.txt'), 'hello');
    await fs.symlink(dirB, path.join(dirA, 'toB'), 'dir');
    await fs.symlink(dirA, path.join(dirB, 'toA'), 'dir');

    const result = await getCloudMigrationFootprint({
      coreDirectory: workspace,
      userDataPath: userData,
      timeoutMs: 1000,
    });

    expect(result.kind).toBe('unknown_partial');
    if (result.kind === 'unknown_partial') {
      expect(result.reason).toBe('symlink_cycle');
      expect(result.partialBytes).toBeGreaterThanOrEqual(0);
    }
  });

  // ------------------------------------------------------------------------
  // unknown_partial: timeout (via injected clock)
  // ------------------------------------------------------------------------

  it('reports timeout via injected clock', async () => {
    const workspace = path.join(tempRoot, 'workspace');
    const userData = path.join(tempRoot, 'userData');
    // Populate with enough files that the walk has at least one iteration to trip on.
    await makeDirTree(workspace, {
      'a.txt': 'x',
      'b.txt': 'x',
      'c.txt': 'x',
    });
    await fs.mkdir(userData, { recursive: true });

    // Clock that jumps past the deadline immediately on the *second* now() call.
    // The first now() establishes `started`; the second is called before the walk.
    let calls = 0;
    const clock: FootprintClock = {
      now: () => {
        calls += 1;
        // First call sets `started`, returns 0.
        // All subsequent calls return 10_000 — far past the 1s timeout.
        return calls <= 1 ? 0 : 10_000;
      },
    };

    const result = await getCloudMigrationFootprint({
      coreDirectory: workspace,
      userDataPath: userData,
      timeoutMs: 1000,
      clock,
    });

    expect(result.kind).toBe('unknown_partial');
    if (result.kind === 'unknown_partial') {
      expect(result.reason).toBe('timeout');
    }
  });

  // ------------------------------------------------------------------------
  // unknown_partial: permission denied (mocked via fs spy)
  // ------------------------------------------------------------------------

  it('reports permission when readdir throws EACCES', async () => {
    const workspace = path.join(tempRoot, 'workspace');
    const userData = path.join(tempRoot, 'userData');
    await makeDirTree(workspace, {
      'a.txt': 'x',
      'forbidden': { 'blocked.txt': 'secret' },
    });
    await fs.mkdir(userData, { recursive: true });

    const originalReaddir = fs.readdir.bind(fs);
    // Cast to a permissive signature — fs.readdir is heavily overloaded and
    // the narrow Dirent<NonSharedBuffer> return type from the default overload
    // doesn't match Dirent<string>. We only care about the EACCES branch here.
    const spy = vi
      .spyOn(fs, 'readdir')
      .mockImplementation((async (p: unknown, opts: unknown) => {
        const str = typeof p === 'string' ? p : String(p);
        if (str.endsWith(path.join('workspace', 'forbidden'))) {
          const err = new Error('permission denied') as NodeJS.ErrnoException;
          err.code = 'EACCES';
          throw err;
        }
        // Delegate to the real implementation; the cast is necessary because
        // vi.spyOn narrows to a specific overload of the target method.
        return (originalReaddir as unknown as (
          path: unknown,
          options: unknown,
        ) => Promise<unknown>)(p, opts);
      }) as unknown as typeof fs.readdir);

    try {
      const result = await getCloudMigrationFootprint({
        coreDirectory: workspace,
        userDataPath: userData,
      });
      expect(result.kind).toBe('unknown_partial');
      if (result.kind === 'unknown_partial') {
        expect(result.reason).toBe('permission');
      }
    } finally {
      spy.mockRestore();
    }
  });

  // ------------------------------------------------------------------------
  // Broken symlinks inside the workspace are skipped quietly
  // ------------------------------------------------------------------------

  it('skips broken symlinks without partialing', async () => {
    if (process.platform === 'win32') return;

    const workspace = path.join(tempRoot, 'workspace');
    const userData = path.join(tempRoot, 'userData');
    await makeDirTree(workspace, {
      'a.txt': 'x'.repeat(100),
    });
    await fs.symlink(
      path.join(workspace, 'does-not-exist'),
      path.join(workspace, 'broken'),
    );
    await fs.mkdir(userData, { recursive: true });

    const result = await getCloudMigrationFootprint({
      coreDirectory: workspace,
      userDataPath: userData,
    });

    expect(result.kind).toBe('measured_nonzero');
    if (result.kind === 'measured_nonzero') {
      expect(result.workspaceBytes).toBe(100);
    }
  });

  // ------------------------------------------------------------------------
  // durationMs is present on all outcomes
  // ------------------------------------------------------------------------

  it('always returns durationMs', async () => {
    const userData = path.join(tempRoot, 'userData');
    await fs.mkdir(userData, { recursive: true });

    const clock = new FakeClock();
    clock.advance(5);
    const result = await getCloudMigrationFootprint({
      userDataPath: userData,
      clock,
    });
    expect(typeof result.durationMs).toBe('number');
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  // ------------------------------------------------------------------------
  // A3 benchmark: a 5000-file synthetic workspace must scan within the
  // default 2s budget. This validates the Stage 1 cap choice in assumption
  // A3 of the planning doc.
  //
  // If this test flakes on slow CI (e.g. under heavy io contention), set
  // REBEL_SLOW_DISK=1 to skip. We keep it ON by default so regressions in
  // the walk's per-file cost become visible.
  // ------------------------------------------------------------------------

  it.skipIf(process.env.REBEL_SLOW_DISK === '1')(
    'scans a 5000-file synthetic workspace within the 2s default budget (A3)',
    async () => {
      const workspace = path.join(tempRoot, 'bench-workspace');
      const userData = path.join(tempRoot, 'bench-userData');
      await fs.mkdir(workspace, { recursive: true });
      await fs.mkdir(userData, { recursive: true });

      const fileCount = 5000;
      const filesPerDir = 100;
      const dirCount = Math.ceil(fileCount / filesPerDir);
      const fileContent = 'x'.repeat(32); // 32 bytes per file → 160 KB total

      for (let d = 0; d < dirCount; d++) {
        const subdir = path.join(workspace, `dir-${d}`);
        await fs.mkdir(subdir);
        const batch: Array<Promise<void>> = [];
        for (let i = 0; i < filesPerDir; i++) {
          const idx = d * filesPerDir + i;
          if (idx >= fileCount) break;
          batch.push(
            fs.writeFile(path.join(subdir, `file-${i}.txt`), fileContent),
          );
        }
        await Promise.all(batch);
      }

      const expectedBytes = fileCount * fileContent.length;

      // Use the real clock (default) — the whole point of this benchmark is
      // to assert real wall-clock behaviour against the 2s budget. The
      // returned `durationMs` comes from the same clock the timeout check
      // uses, so it is the authoritative elapsed-time measurement.
      const result = await getCloudMigrationFootprint({
        coreDirectory: workspace,
        userDataPath: userData,
      });

      expect(result.kind).toBe('measured_nonzero');
      if (result.kind === 'measured_nonzero') {
        expect(result.totalBytes).toBe(expectedBytes);
        expect(result.workspaceBytes).toBe(expectedBytes);
        expect(result.appDataBytes).toBe(0);
      }
      expect(result.durationMs).toBeLessThan(2000);
    },
    30_000,
  );
});
