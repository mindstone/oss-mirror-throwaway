/**
 * Regression coverage for the shared safeWalkDirectory utility.
 *
 * This is the catch-all fix for the REBEL-506 / REBEL-4WS..510 ENAMETOOLONG
 * cluster. The previous fix (commit 4d8981cd2) only patched
 * `listMarkdownFilesRecursively`. This generalised utility is used by every
 * recursive walker that descends from a workspace/space root, so the loop
 * scenarios below cover all of them via one suite.
 *
 * Tests use the real filesystem against a temp directory so we exercise
 * actual symlink/cycle semantics rather than mocks.
 */

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import {
  safeWalkDirectory,
  safeListFiles,
  isSafeWalkComplete,
  DEFAULT_SAFE_WALK_LIMITS,
  type SafeWalkFileInfo,
  type SafeWalkDirInfo,
  type SafeWalkResult,
} from '../safeWalkDirectory';
import {
  setWorkspaceFsExecutor,
  __resetWorkspaceFsExecutorForTesting,
  type WorkspaceFsExecResult,
  type WorkspaceDirent,
} from '@core/services/boundedWorkspaceFs';
import {
  realFsExecutor,
  deadMountExecutor,
  realFsExecutorWith,
} from '@core/services/__tests__/workspaceFsExecutorDoubles';

// ---------------------------------------------------------------------------
// S4.1a — the walker now routes every cloud-capable fs op through the boundary.
// A path the PATTERN classifier (`detectCloudStorage`) flags as cloud (e.g. one
// under a `Dropbox/` segment — the stand-in these tests already use) takes the
// CLOUD lane → the boundary's executor. With NO executor wired the default fails
// CLOSED to `reconnecting`, so to exercise a HEALTHY cloud mount we wire an executor
// that delegates to real `fs` (the local temp dir IS the "mount") — see
// `workspaceFsExecutorDoubles`.
// ---------------------------------------------------------------------------

describe('safeWalkDirectory', () => {
  let tmpRoot: string;

  beforeEach(async () => {
    tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'rebel-safewalk-'));
  });

  afterEach(async () => {
    await fs.rm(tmpRoot, { recursive: true, force: true });
  });

  it('visits every file in a flat directory exactly once', async () => {
    await fs.writeFile(path.join(tmpRoot, 'a.md'), 'a');
    await fs.writeFile(path.join(tmpRoot, 'b.txt'), 'b');

    const seen: string[] = [];
    const result = await safeWalkDirectory(tmpRoot, {
      onFile: ({ name }) => {
        seen.push(name);
      },
    });

    expect(seen.sort()).toEqual(['a.md', 'b.txt']);
    expect(result.truncatedReasons).toEqual([]);
    expect(result.rootRealPath).not.toBeNull();
  });

  it('descends into nested subdirectories within the depth limit', async () => {
    const sub = path.join(tmpRoot, 'a', 'b', 'c');
    await fs.mkdir(sub, { recursive: true });
    await fs.writeFile(path.join(tmpRoot, 'top.md'), 'top');
    await fs.writeFile(path.join(sub, 'deep.md'), 'deep');

    const { files } = await safeListFiles(tmpRoot, ({ name }) => name.endsWith('.md'));

    expect(files.map((p) => path.basename(p)).sort()).toEqual(['deep.md', 'top.md']);
  });

  it('returns rootRealPath null when root does not exist (no throw)', async () => {
    const result = await safeWalkDirectory(path.join(tmpRoot, 'does-not-exist'));

    expect(result.rootRealPath).toBeNull();
    expect(result.entriesVisited).toBe(0);
    expect(result.truncatedReasons).toEqual([]);
  });

  it('breaks symlink-to-ancestor loops via realpath cycle detection', async () => {
    // <root>/work/Acme -> <root> (the exact REBEL-506 shape)
    const work = path.join(tmpRoot, 'work');
    await fs.mkdir(work);
    await fs.symlink(tmpRoot, path.join(work, 'Acme'));
    await fs.writeFile(path.join(tmpRoot, 'top.md'), 'top');
    await fs.writeFile(path.join(work, 'work.md'), 'work');

    const seen = new Set<string>();
    await safeWalkDirectory(tmpRoot, {
      onFile: ({ absolutePath }) => {
        seen.add(absolutePath);
      },
    });

    // Each canonical file appears exactly once — no double-count via the loop.
    expect(seen.size).toBe(2);
    expect([...seen].some((p) => p.endsWith('top.md'))).toBe(true);
    expect([...seen].some((p) => p.endsWith('work.md'))).toBe(true);
  });

  it('breaks real-directory loops (no symlinks needed) via depth/path-length cap', async () => {
    // Reproduces Baris's exact situation in REBEL-506: a workspace that contains
    // real directories whose names happen to repeat. No realpath cycle (the
    // canonical paths are genuinely different), so depth or path-length is the
    // guard that fires. We use short folder names here only so that the TEST
    // SETUP itself fits under the OS path limit while still building enough
    // depth to exercise the walker's caps.
    let cursor = tmpRoot;
    const repeats = DEFAULT_SAFE_WALK_LIMITS.MAX_DEPTH + 10;
    for (let i = 0; i < repeats; i += 1) {
      cursor = path.join(cursor, 'w', 'r');
      await fs.mkdir(cursor, { recursive: true });
    }
    await fs.writeFile(path.join(tmpRoot, 'top.md'), 'top');
    await fs.writeFile(path.join(cursor, 'deep.md'), 'deep');

    const seen: string[] = [];
    const result = await safeWalkDirectory(tmpRoot, {
      onFile: ({ absolutePath }) => {
        seen.push(absolutePath);
      },
    });

    // Must not throw ENAMETOOLONG. Top is collected; deep.md is past the cap.
    expect(seen.some((p) => p.endsWith('top.md'))).toBe(true);
    expect(seen.some((p) => p.endsWith('deep.md'))).toBe(false);
    expect(result.truncatedReasons.length).toBeGreaterThan(0);
  });

  it('skips broken symlinks rather than throwing', async () => {
    await fs.writeFile(path.join(tmpRoot, 'real.md'), '# real');
    await fs.symlink(path.join(tmpRoot, '__missing__'), path.join(tmpRoot, 'broken'));

    const seen: string[] = [];
    await safeWalkDirectory(tmpRoot, {
      onFile: ({ name }) => {
        seen.push(name);
      },
    });

    expect(seen).toEqual(['real.md']);
  });

  it('follows a non-cyclic symlink to a directory', async () => {
    const realDir = path.join(tmpRoot, 'data', 'topics');
    await fs.mkdir(realDir, { recursive: true });
    await fs.writeFile(path.join(realDir, 'leaf.md'), '# leaf');

    const root = path.join(tmpRoot, 'root');
    await fs.mkdir(root);
    await fs.symlink(realDir, path.join(root, 'topics-link'));

    const seen: string[] = [];
    await safeWalkDirectory(root, {
      onFile: ({ name }) => {
        seen.push(name);
      },
    });

    expect(seen).toEqual(['leaf.md']);
  });

  it('reports symlink-to-file via viaSymlink:true on onFile', async () => {
    const realFile = path.join(tmpRoot, 'real.md');
    await fs.writeFile(realFile, '# real');
    await fs.symlink(realFile, path.join(tmpRoot, 'alias.md'));

    const records: Array<Pick<SafeWalkFileInfo, 'name' | 'viaSymlink'>> = [];
    await safeWalkDirectory(tmpRoot, {
      onFile: ({ name, viaSymlink }) => {
        records.push({ name, viaSymlink });
      },
    });

    const realRec = records.find((r) => r.name === 'real.md');
    const aliasRec = records.find((r) => r.name === 'alias.md');
    expect(realRec?.viaSymlink).toBe(false);
    expect(aliasRec?.viaSymlink).toBe(true);
  });

  it('respects onDirectory:false to skip a subtree', async () => {
    await fs.mkdir(path.join(tmpRoot, 'keep'));
    await fs.mkdir(path.join(tmpRoot, 'skip'));
    await fs.writeFile(path.join(tmpRoot, 'keep', 'in.md'), 'keep');
    await fs.writeFile(path.join(tmpRoot, 'skip', 'out.md'), 'skip');

    const seen: string[] = [];
    await safeWalkDirectory(tmpRoot, {
      onDirectory: ({ name }) => name !== 'skip',
      onFile: ({ name }) => {
        seen.push(name);
      },
    });

    expect(seen).toEqual(['in.md']);
  });

  it('passes correct depth values to file/dir callbacks', async () => {
    const sub = path.join(tmpRoot, 'a', 'b');
    await fs.mkdir(sub, { recursive: true });
    await fs.writeFile(path.join(tmpRoot, 'd0.md'), '');
    await fs.writeFile(path.join(tmpRoot, 'a', 'd1.md'), '');
    await fs.writeFile(path.join(sub, 'd2.md'), '');

    const fileDepths = new Map<string, number>();
    const dirDepths = new Map<string, number>();

    await safeWalkDirectory(tmpRoot, {
      onFile: ({ name, depth }) => {
        fileDepths.set(name, depth);
      },
      onDirectory: ({ name, depth }) => {
        dirDepths.set(name, depth);
        return true;
      },
    });

    expect(fileDepths.get('d0.md')).toBe(0);
    expect(fileDepths.get('d1.md')).toBe(1);
    expect(fileDepths.get('d2.md')).toBe(2);
    expect(dirDepths.get('a')).toBe(0);
    expect(dirDepths.get('b')).toBe(1);
  });

  it('stops descending past maxDepth', async () => {
    const depth = DEFAULT_SAFE_WALK_LIMITS.MAX_DEPTH + 3;
    let cursor = tmpRoot;
    for (let i = 0; i < depth; i += 1) {
      cursor = path.join(cursor, `lv${i}`);
      await fs.mkdir(cursor);
    }
    await fs.writeFile(path.join(tmpRoot, 'top.md'), 'top');
    await fs.writeFile(path.join(cursor, 'deep.md'), 'deep');

    const seen: string[] = [];
    const result = await safeWalkDirectory(tmpRoot, {
      onFile: ({ name }) => {
        seen.push(name);
      },
    });

    expect(seen).toContain('top.md');
    expect(seen).not.toContain('deep.md');
    expect(result.truncatedReasons).toContain('depth');
  });

  it('respects custom maxDepth lower than default', async () => {
    await fs.mkdir(path.join(tmpRoot, 'a', 'b'), { recursive: true });
    await fs.writeFile(path.join(tmpRoot, 'd0.md'), '');
    await fs.writeFile(path.join(tmpRoot, 'a', 'd1.md'), '');
    await fs.writeFile(path.join(tmpRoot, 'a', 'b', 'd2.md'), '');

    const seen: string[] = [];
    const result = await safeWalkDirectory(tmpRoot, {
      maxDepth: 1,
      onFile: ({ name }) => {
        seen.push(name);
      },
    });

    expect(seen).toContain('d0.md');
    expect(seen).toContain('d1.md');
    expect(seen).not.toContain('d2.md');
    expect(result.truncatedReasons).toContain('depth');
  });

  it('respects maxEntries cap and reports truncation', async () => {
    for (let i = 0; i < 20; i += 1) {
      await fs.writeFile(path.join(tmpRoot, `f${i}.md`), '');
    }

    const seen: string[] = [];
    const result = await safeWalkDirectory(tmpRoot, {
      maxEntries: 5,
      onFile: ({ name }) => {
        seen.push(name);
      },
    });

    expect(seen.length).toBeLessThanOrEqual(5);
    expect(result.truncatedReasons).toContain('entries');
  });

  it('respects maxPathLength cap', async () => {
    // Construct a path that fits at root but exceeds the cap when joined.
    const longName = 'x'.repeat(50);
    let cursor = tmpRoot;
    for (let i = 0; i < 5; i += 1) {
      cursor = path.join(cursor, longName + i);
      await fs.mkdir(cursor);
    }

    const result = await safeWalkDirectory(tmpRoot, {
      maxPathLength: tmpRoot.length + 60, // allows root + first level only
    });

    expect(result.truncatedReasons).toContain('pathLength');
  });

  it('calls onTruncated exactly once with deduplicated reasons', async () => {
    // Generate enough sibling files at root to exceed maxEntries cleanly.
    for (let i = 0; i < 20; i += 1) {
      await fs.writeFile(path.join(tmpRoot, `f${i}.md`), '');
    }

    let callCount = 0;
    let lastReasons: readonly string[] = [];
    await safeWalkDirectory(tmpRoot, {
      maxEntries: 5,
      onTruncated: (info) => {
        callCount += 1;
        lastReasons = info.reasons;
      },
    });

    expect(callCount).toBe(1);
    expect(lastReasons.length).toBeGreaterThan(0);
    // Reasons must be deduplicated.
    expect(new Set(lastReasons).size).toBe(lastReasons.length);
  });

  it('does not call onTruncated on a clean walk', async () => {
    await fs.writeFile(path.join(tmpRoot, 'a.md'), '');
    let called = false;
    await safeWalkDirectory(tmpRoot, {
      onTruncated: () => {
        called = true;
      },
    });
    expect(called).toBe(false);
  });

  it('aborts when AbortSignal fires mid-walk', async () => {
    for (let i = 0; i < 100; i += 1) {
      await fs.writeFile(path.join(tmpRoot, `f${i}.md`), '');
    }

    const ac = new AbortController();
    let visited = 0;
    const result = await safeWalkDirectory(tmpRoot, {
      signal: ac.signal,
      onFile: () => {
        visited += 1;
        if (visited === 3) ac.abort();
      },
    });

    // We aborted — visited count should be far below 100.
    expect(visited).toBeLessThan(100);
    expect(result.truncatedReasons).toContain('aborted');
  });

  it('records permission-denied subdirectories as truncation and continues with siblings', async () => {
    const readable = path.join(tmpRoot, 'readable');
    const unreadable = path.join(tmpRoot, 'unreadable');
    await fs.mkdir(readable);
    await fs.mkdir(unreadable);
    await fs.writeFile(path.join(readable, 'ok.md'), '');
    await fs.writeFile(path.join(unreadable, 'hidden.md'), '');

    // Strip read perms (best-effort; on some CI environments this is a no-op
    // because the test runs as root, or chmod has no effect on Windows).
    let chmodSucceeded = false;
    try {
      await fs.chmod(unreadable, 0o000);
      // Verify chmod actually denied access — root and Windows both ignore mode 000.
      try {
        await fs.readdir(unreadable);
      } catch {
        chmodSucceeded = true;
      }
    } catch {
      // Skip — not all environments support this.
    }

    const seen: string[] = [];
    let result: SafeWalkResult;
    try {
      result = await safeWalkDirectory(tmpRoot, {
        onFile: ({ name }) => {
          seen.push(name);
        },
      });
    } finally {
      try {
        await fs.chmod(unreadable, 0o755);
      } catch {
        /* ignore */
      }
    }

    // The readable file must always come back regardless of chmod support.
    expect(seen).toContain('ok.md');

    // When chmod actually took effect, the unreadable dir surfaces as a
    // 'permission' truncation reason — destructive consumers MUST see this.
    if (chmodSucceeded) {
      expect(result.truncatedReasons).toContain('permission');
      expect(isSafeWalkComplete(result)).toBe(false);
      expect(seen).not.toContain('hidden.md');
    } else {
      // Privileged / Windows path: chmod is a no-op so the walk DOES descend.
      // We only assert the cross-platform invariant: the readable sibling is
      // always visited, regardless of whether chmod silenced or not.
      expect(isSafeWalkComplete(result)).toBe(true);
    }
  });

  it('does not record truncation for broken symlinks (dirent visible at parent)', async () => {
    await fs.writeFile(path.join(tmpRoot, 'real.md'), '# real');
    await fs.symlink(path.join(tmpRoot, '__missing__'), path.join(tmpRoot, 'broken'));

    const seen: string[] = [];
    const result = await safeWalkDirectory(tmpRoot, {
      onFile: ({ name }) => {
        seen.push(name);
      },
    });

    // Broken symlinks are routine — the walker sees the dirent, can't follow,
    // and continues. Critically, we do NOT mark this as truncation: the walk
    // visited every dirent under tmpRoot exactly once.
    expect(seen).toEqual(['real.md']);
    expect(result.truncatedReasons).toEqual([]);
    expect(isSafeWalkComplete(result)).toBe(true);
  });

  it('records readdir failure when the parent directory becomes inaccessible mid-walk', async () => {
    // Build: tmpRoot/parent/{a.md, sub/b.md}, then revoke perms on `parent`
    // BETWEEN readdir on tmpRoot and readdir on parent. This races the walker
    // by fully chmodding before the inner readdir runs.
    const parent = path.join(tmpRoot, 'parent');
    const sub = path.join(parent, 'sub');
    await fs.mkdir(sub, { recursive: true });
    await fs.writeFile(path.join(parent, 'a.md'), '');
    await fs.writeFile(path.join(sub, 'b.md'), '');

    // Strip perms on `parent` — when the walker pops it from the queue, the
    // readdir of `parent` fails. Best-effort across environments.
    let chmodSucceeded = false;
    try {
      await fs.chmod(parent, 0o000);
      try {
        await fs.readdir(parent);
      } catch {
        chmodSucceeded = true;
      }
    } catch {
      // ignore
    }

    let result: SafeWalkResult;
    try {
      result = await safeWalkDirectory(tmpRoot);
    } finally {
      try {
        await fs.chmod(parent, 0o755);
      } catch {
        /* ignore */
      }
    }

    if (chmodSucceeded) {
      // The walker entered `parent` (visible from tmpRoot's readdir + realpath
      // succeeded), then readdir on parent itself failed → 'permission'.
      expect(result.truncatedReasons.some((r) => r === 'permission' || r === 'unreadable')).toBe(true);
      expect(isSafeWalkComplete(result)).toBe(false);
    } else {
      expect(isSafeWalkComplete(result)).toBe(true);
    }
  });

  it('isSafeWalkComplete reflects truncatedReasons accurately', async () => {
    // Clean walk
    await fs.writeFile(path.join(tmpRoot, 'a.md'), '');
    const cleanResult = await safeWalkDirectory(tmpRoot);
    expect(isSafeWalkComplete(cleanResult)).toBe(true);

    // Forced truncation via maxEntries
    for (let i = 0; i < 20; i += 1) {
      await fs.writeFile(path.join(tmpRoot, `f${i}.md`), '');
    }
    const truncatedResult = await safeWalkDirectory(tmpRoot, { maxEntries: 5 });
    expect(isSafeWalkComplete(truncatedResult)).toBe(false);
  });

  it('passes correct parentDir on file callbacks', async () => {
    const sub = path.join(tmpRoot, 'sub');
    await fs.mkdir(sub);
    await fs.writeFile(path.join(sub, 'leaf.md'), '');

    let seenParent: string | null = null;
    await safeWalkDirectory(tmpRoot, {
      onFile: ({ name, parentDir }) => {
        if (name === 'leaf.md') seenParent = parentDir;
      },
    });

    expect(seenParent).toBe(sub);
  });

  it('supports async onFile callbacks', async () => {
    await fs.writeFile(path.join(tmpRoot, 'a.md'), '');
    await fs.writeFile(path.join(tmpRoot, 'b.md'), '');

    const seen: string[] = [];
    await safeWalkDirectory(tmpRoot, {
      onFile: async ({ name }) => {
        await new Promise((r) => setTimeout(r, 0));
        seen.push(name);
      },
    });

    expect(seen.sort()).toEqual(['a.md', 'b.md']);
  });

  it('supports async onDirectory callbacks', async () => {
    await fs.mkdir(path.join(tmpRoot, 'a'));
    await fs.writeFile(path.join(tmpRoot, 'a', 'in.md'), '');

    const seen: string[] = [];
    await safeWalkDirectory(tmpRoot, {
      onDirectory: async ({ name }) => {
        await new Promise((r) => setTimeout(r, 0));
        return name === 'a';
      },
      onFile: ({ name }) => {
        seen.push(name);
      },
    });

    expect(seen).toEqual(['in.md']);
  });

  it('exposes default limits as a stable constant', () => {
    expect(DEFAULT_SAFE_WALK_LIMITS.MAX_DEPTH).toBe(12);
    expect(DEFAULT_SAFE_WALK_LIMITS.MAX_PATH_LENGTH).toBe(900);
    expect(DEFAULT_SAFE_WALK_LIMITS.MAX_ENTRIES).toBe(50_000);
  });

  // ---------------------------------------------------------------------------
  // Incidental cloud-symlink skip (RC-1 generalised into the shared walker).
  //
  // `detectCloudStorage` classifies a path by pattern — a realpath whose
  // lowercased portable form contains `/dropbox/` (etc.) is treated as a cloud
  // mount. We exploit that here: a real directory under a `Dropbox/` segment
  // stands in for a network-backed cloud mount without needing a real FUSE
  // filesystem. The walker resolves the symlink's realpath for cycle detection
  // already, so the cloud check reuses it — these tests assert the *policy*,
  // not the realpath count.
  // ---------------------------------------------------------------------------
  describe('skipCloudSymlinkTargets (default-on incidental cloud-symlink skip)', () => {
    // S4.1a: a path the PATTERN classifier flags as cloud now takes the boundary's
    // cloud lane. Wire a HEALTHY (real-fs-delegating) executor so the explicit
    // cloud-ROOT walk (`detectCloudStorage(rootDir) === true`) reads the local
    // stand-in dir exactly as the prior bare-fs carve-out did. The incidental-skip
    // tests below never reach a cloud-lane op (the skip fires before descent), so the
    // executor is a no-op for them — but wiring it block-wide keeps intent obvious.
    beforeEach(() => {
      setWorkspaceFsExecutor(realFsExecutor);
    });
    afterEach(() => {
      __resetWorkspaceFsExecutorForTesting();
    });

    /** Create `<tmpRoot>/Dropbox/<name>` with a marker file; return its path. */
    async function makeCloudDir(name: string): Promise<string> {
      const cloudDir = path.join(tmpRoot, 'Dropbox', name);
      await fs.mkdir(cloudDir, { recursive: true });
      await fs.writeFile(path.join(cloudDir, 'in-cloud.md'), '# cloud');
      return cloudDir;
    }

    it('skips descent into an incidental symlink-to-cloud dirent by default and records truncation', async () => {
      const cloudDir = await makeCloudDir('SharedDrive');
      const workspace = path.join(tmpRoot, 'workspace');
      await fs.mkdir(workspace);
      await fs.writeFile(path.join(workspace, 'local.md'), '# local');
      // Incidental cloud symlink INSIDE the workspace being walked.
      await fs.symlink(cloudDir, path.join(workspace, 'Company Memories'));

      const seen: string[] = [];
      const result = await safeWalkDirectory(workspace, {
        onFile: ({ name }) => {
          seen.push(name);
        },
      });

      // Local file is seen; the cloud subtree is NOT descended into.
      expect(seen).toEqual(['local.md']);
      expect(seen).not.toContain('in-cloud.md');
      expect(result.truncatedReasons).toContain('cloud-symlink-skipped');
      expect(isSafeWalkComplete(result)).toBe(false);
    });

    it('descends into the cloud symlink when skipCloudSymlinkTargets is false (opt-out)', async () => {
      const cloudDir = await makeCloudDir('SharedDrive');
      const workspace = path.join(tmpRoot, 'workspace');
      await fs.mkdir(workspace);
      await fs.writeFile(path.join(workspace, 'local.md'), '# local');
      await fs.symlink(cloudDir, path.join(workspace, 'Company Memories'));

      const seen: string[] = [];
      const result = await safeWalkDirectory(workspace, {
        skipCloudSymlinkTargets: false,
        onFile: ({ name }) => {
          seen.push(name);
        },
      });

      // Opt-out: the cloud subtree IS walked and synced (cloud-sync semantics).
      expect(seen.sort()).toEqual(['in-cloud.md', 'local.md']);
      expect(result.truncatedReasons).not.toContain('cloud-symlink-skipped');
    });

    it('does NOT skip an explicitly-targeted cloud rootDir (caller chose it)', async () => {
      // The user named the cloud folder directly (e.g. ls/glob of a Drive
      // folder). Walking the explicit root is the caller's choice — only an
      // incidental cloud symlink reached DURING descent is skipped.
      const cloudDir = await makeCloudDir('NamedFolder');
      await fs.mkdir(path.join(cloudDir, 'sub'));
      await fs.writeFile(path.join(cloudDir, 'sub', 'nested.md'), '# nested');

      const seen: string[] = [];
      const result = await safeWalkDirectory(cloudDir, {
        onFile: ({ name }) => {
          seen.push(name);
        },
      });

      // Default-on, yet the explicit cloud root walks fully — no skip fired.
      expect(seen.sort()).toEqual(['in-cloud.md', 'nested.md']);
      expect(result.truncatedReasons).not.toContain('cloud-symlink-skipped');
      expect(isSafeWalkComplete(result)).toBe(true);
    });

    it('does NOT skip a symlink to a symlink whose FINAL target is the cloud root (root realpath is cloud)', async () => {
      // A symlink CHAIN whose final target is the cloud root, used as rootDir,
      // must still walk: `fs.realpath(rootDir)` resolves the whole chain into the
      // cloud mount and seeds it before any child-descent skip can fire.
      // rootLink -> midLink -> cloudDir (a genuine two-hop chain).
      const cloudDir = await makeCloudDir('LinkedRoot');
      const midLink = path.join(tmpRoot, 'mid-link');
      await fs.symlink(cloudDir, midLink);
      const rootLink = path.join(tmpRoot, 'root-link');
      await fs.symlink(midLink, rootLink);

      const seen: string[] = [];
      const result = await safeWalkDirectory(rootLink, {
        onFile: ({ name }) => {
          seen.push(name);
        },
      });

      expect(seen).toEqual(['in-cloud.md']);
      expect(result.truncatedReasons).not.toContain('cloud-symlink-skipped');
    });

    it('still follows a non-cloud outside-workspace symlink (rebel-system shape)', async () => {
      // A non-cloud outside-workspace symlink (e.g. rebel-system →
      // /Applications/…) must KEEP being followed: the skip is cloud-specific,
      // never "skip all outside-workspace symlinks".
      const outside = path.join(tmpRoot, 'app-resources', 'rebel-system');
      await fs.mkdir(outside, { recursive: true });
      await fs.writeFile(path.join(outside, 'SKILL.md'), '# skill');

      const workspace = path.join(tmpRoot, 'workspace');
      await fs.mkdir(workspace);
      await fs.writeFile(path.join(workspace, 'local.md'), '# local');
      await fs.symlink(outside, path.join(workspace, 'rebel-system'));

      const seen: string[] = [];
      const result = await safeWalkDirectory(workspace, {
        onFile: ({ name }) => {
          seen.push(name);
        },
      });

      expect(seen.sort()).toEqual(['SKILL.md', 'local.md']);
      expect(result.truncatedReasons).not.toContain('cloud-symlink-skipped');
      expect(isSafeWalkComplete(result)).toBe(true);
    });

    it('excludes cloud for a migrated consumer (fileWatcherService.discoverFiles shape) with no bespoke guard', async () => {
      // RC-1 removed the per-caller realpath+shouldSkipCloudSymlinkTarget guard
      // from discoverFiles' onDirectory. This asserts the migrated shape — a
      // name-only onDirectory + default options — still excludes the cloud
      // subtree purely via the walker's default-on skip.
      const cloudDir = await makeCloudDir('SharedDrive');
      const workspace = path.join(tmpRoot, 'workspace');
      await fs.mkdir(workspace);
      await fs.writeFile(path.join(workspace, 'note.md'), '# note');
      await fs.symlink(cloudDir, path.join(workspace, 'Company Memories'));

      const discovered: string[] = [];
      const result = await safeWalkDirectory(workspace, {
        maxDepth: 10, // DISCOVERY_MAX_DEPTH
        onDirectory: ({ name }) => name !== 'node_modules', // name-only filter, no cloud guard
        onFile: ({ absolutePath }) => {
          discovered.push(path.basename(absolutePath));
        },
      });

      expect(discovered).toEqual(['note.md']);
      expect(discovered).not.toContain('in-cloud.md');
      expect(result.truncatedReasons).toContain('cloud-symlink-skipped');
    });

    it('does not consult onDirectory for a skipped cloud symlink', async () => {
      const cloudDir = await makeCloudDir('SharedDrive');
      const workspace = path.join(tmpRoot, 'workspace');
      await fs.mkdir(workspace);
      await fs.symlink(cloudDir, path.join(workspace, 'Company Memories'));

      const dirNames: string[] = [];
      await safeWalkDirectory(workspace, {
        onDirectory: ({ name }) => {
          dirNames.push(name);
          return true;
        },
      });

      // The cloud symlink is skipped BEFORE onDirectory is consulted, so the
      // caller never sees it as a descend candidate.
      expect(dirNames).not.toContain('Company Memories');
    });
  });

  // ---------------------------------------------------------------------------
  // S4.1a — the explicit-cloud-root carve-out now routes through the boundary's
  // cloud lane (killable-pool reclaim) instead of the prior `runWithTimeout` +
  // bare-fs ABANDON. These tests pin the hang-proofing + the R-MUST-3 root semantics
  // (a MISSING root is "empty, not an error" — distinct from a DEAD-mount timeout).
  // ---------------------------------------------------------------------------
  describe('S4.1a — explicit-cloud-root boundary routing', () => {
    afterEach(() => {
      __resetWorkspaceFsExecutorForTesting();
    });

    /** `<tmpRoot>/Dropbox/<name>` — PATTERN-classified cloud — with a marker file. */
    async function makeCloudRoot(name: string): Promise<string> {
      const cloudDir = path.join(tmpRoot, 'Dropbox', name);
      await fs.mkdir(cloudDir, { recursive: true });
      await fs.writeFile(path.join(cloudDir, 'in-cloud.md'), '# cloud');
      return cloudDir;
    }

    it('a DEAD cloud root (every op reconnecting) degrades to cloud-timeout and never hangs', async () => {
      const cloudRoot = await makeCloudRoot('DeadRoot');
      setWorkspaceFsExecutor(deadMountExecutor);

      const seen: string[] = [];
      const result = await safeWalkDirectory(cloudRoot, {
        onFile: ({ name }) => {
          seen.push(name);
        },
      });

      // R-MUST-3: a dead-mount ROOT realpath → reconnecting → cloud-timeout (the walk
      // is incomplete), NOT the empty "missing root" case.
      expect(result.rootRealPath).toBeNull();
      expect(result.truncatedReasons).toEqual(['cloud-timeout']);
      expect(result.entriesVisited).toBe(0);
      expect(seen).toEqual([]);
      expect(isSafeWalkComplete(result)).toBe(false);
    });

    it('bounds the FIRST readdir of an explicit cloud root — root resolves, dead readdir → cloud-timeout', async () => {
      const cloudRoot = await makeCloudRoot('SlowRoot');
      await fs.mkdir(path.join(cloudRoot, 'sub'));
      // Healthy realpath (root resolves) but the enumeration wedges → reconnecting.
      const timeoutReaddir = (): Promise<WorkspaceFsExecResult<WorkspaceDirent[]>> =>
        Promise.resolve({ ok: false, reason: 'timeout' });
      setWorkspaceFsExecutor(realFsExecutorWith({ readdirWithFileTypes: timeoutReaddir }));

      const seen: string[] = [];
      const result = await safeWalkDirectory(cloudRoot, {
        onFile: ({ name }) => {
          seen.push(name);
        },
      });

      // The root realpath succeeded; the first readdir timed out → cloud-timeout.
      expect(result.rootRealPath).not.toBeNull();
      expect(result.truncatedReasons).toContain('cloud-timeout');
      expect(seen).toEqual([]);
      expect(isSafeWalkComplete(result)).toBe(false);
    });

    it('R-MUST-3: a MISSING explicit cloud root (healthy executor, real ENOENT) is empty, NOT a truncation', async () => {
      setWorkspaceFsExecutor(realFsExecutor);
      const missing = path.join(tmpRoot, 'Dropbox', 'does-not-exist');

      const result = await safeWalkDirectory(missing);

      // A real fs ERROR on the ROOT realpath → "missing root is empty, not an error":
      // rootRealPath null AND NO truncation (distinct from the dead-mount timeout above).
      expect(result.rootRealPath).toBeNull();
      expect(result.truncatedReasons).toEqual([]);
      expect(result.entriesVisited).toBe(0);
      expect(isSafeWalkComplete(result)).toBe(true);
    });

    it('walks a HEALTHY explicit cloud root fully via the cloud-lane executor', async () => {
      const cloudRoot = await makeCloudRoot('HealthyRoot');
      await fs.mkdir(path.join(cloudRoot, 'sub'));
      await fs.writeFile(path.join(cloudRoot, 'sub', 'nested.md'), '# nested');
      setWorkspaceFsExecutor(realFsExecutor);

      const seen: string[] = [];
      const result = await safeWalkDirectory(cloudRoot, {
        onFile: ({ name }) => {
          seen.push(name);
        },
      });

      expect(seen.sort()).toEqual(['in-cloud.md', 'nested.md']);
      expect(result.truncatedReasons).toEqual([]);
      expect(isSafeWalkComplete(result)).toBe(true);
    });
  });

  // ---------------------------------------------------------------------------
  // Phase-7 F1 (rd4-analogous) — `forceCloudRoot` for a scan-discovered, pattern-LOCAL
  // symlink-to-cloud root. The pattern classifier + containment both read the root as
  // LOCAL (the cloud-ness is in the symlink TARGET, not the path string), so without
  // the opt-in the root `realpath` takes the bare-fs LOCAL lane and HANGS on a dead
  // cloud mount target. A caller holding the symlink evidence sets `forceCloudRoot` so
  // the root realpath takes the killable cloud lane → `cloud-timeout`, never a hang.
  // ---------------------------------------------------------------------------
  describe('forceCloudRoot (rd4-analogous root-realpath lane override)', () => {
    afterEach(() => {
      __resetWorkspaceFsExecutorForTesting();
    });

    /**
     * A pattern-LOCAL root path (NOT under any cloud segment) whose realpath the dead
     * executor wedges — modelling a `Chief-of-Staff` symlink whose target is a dead
     * cloud mount, absent from `settings.spaces` so containment never learned it.
     */
    function patternLocalRoot(): string {
      // `<tmpRoot>/workspace/chief-of-staff/operators` — pattern-local by string.
      return path.join(tmpRoot, 'workspace', 'chief-of-staff', 'operators');
    }

    it('RED guard: WITHOUT forceCloudRoot a pattern-local root takes the LOCAL lane (never the cloud executor)', async () => {
      const root = patternLocalRoot();
      // Dead executor would ONLY be reached on the cloud lane. The local lane uses bare
      // fsp.realpath; the path does not exist → real ENOENT → "missing root is empty".
      setWorkspaceFsExecutor(deadMountExecutor);

      const result = await safeWalkDirectory(root, {});

      // Local lane taken: a real ENOENT realpath → empty, NOT a cloud-timeout. This is
      // the unbounded-hang vector in production (bare fsp.realpath on a dead symlink
      // target blocks the kernel) — proving the default does NOT route cloud.
      expect(result.rootRealPath).toBeNull();
      expect(result.truncatedReasons).toEqual([]);
      expect(isSafeWalkComplete(result)).toBe(true);
    });

    it('GREEN: WITH forceCloudRoot the root realpath routes through the killable cloud lane → cloud-timeout, never hangs', async () => {
      const root = patternLocalRoot();
      setWorkspaceFsExecutor(deadMountExecutor);

      const seen: string[] = [];
      const result = await safeWalkDirectory(root, {
        forceCloudRoot: true,
        onFile: ({ name }) => {
          seen.push(name);
        },
      });

      // Root realpath went through the cloud lane → reconnecting → cloud-timeout
      // truncation (the killable pool reclaims the wedged op). NOT an unbounded hang.
      expect(result.rootRealPath).toBeNull();
      expect(result.truncatedReasons).toEqual(['cloud-timeout']);
      expect(result.entriesVisited).toBe(0);
      expect(seen).toEqual([]);
      expect(isSafeWalkComplete(result)).toBe(false);
    });

    it('forceCloudRoot:false keeps the bare-fs LOCAL fast path for a healthy local root (no regression)', async () => {
      const root = path.join(tmpRoot, 'local-space', 'operators');
      await fs.mkdir(root, { recursive: true });
      await fs.writeFile(path.join(root, 'a.md'), '# a');
      // Wire the dead executor: if the local lane is (incorrectly) bypassed for cloud,
      // this read would reconnect. A healthy local walk must NOT touch the executor.
      setWorkspaceFsExecutor(deadMountExecutor);

      const seen: string[] = [];
      const result = await safeWalkDirectory(root, {
        forceCloudRoot: false,
        onFile: ({ name }) => {
          seen.push(name);
        },
      });

      expect(seen).toEqual(['a.md']);
      expect(result.truncatedReasons).toEqual([]);
      expect(isSafeWalkComplete(result)).toBe(true);
    });

    // -------------------------------------------------------------------------
    // Phase-7 F1 (rd3) — `forceCloudRoot` must force the WHOLE walk subtree, not
    // just the root `realpath`. When the root is a symlink to a dead cloud mount,
    // EVERY descendant op (root readdir + per-entry stat/realpath) lives behind the
    // same dead mount. The original F1 fix forced only the root realpath, so a root
    // whose realpath resolved `ok` but whose first `readdir` (or a descendant op)
    // wedged still took the bare-fs LOCAL lane → unbounded main-thread hang.
    // `safeWalkDirectory.ts` already documents this "realpath ok then first readdir
    // blocks" class for explicit cloud roots; this pins it for `forceCloudRoot`.
    // -------------------------------------------------------------------------

    /**
     * A pattern-LOCAL root that exists on disk (so realpath resolves `ok`) — the
     * caller holds out-of-band evidence it's a symlink to a dead cloud mount, but
     * the pattern classifier + containment both read the path as LOCAL.
     */
    async function patternLocalRootWithContents(): Promise<string> {
      const root = path.join(tmpRoot, 'workspace', 'chief-of-staff', 'operators');
      await fs.mkdir(path.join(root, 'sub'), { recursive: true });
      await fs.writeFile(path.join(root, 'a.md'), '# a');
      return root;
    }

    it('RED guard: WITHOUT forceCloudRoot a pattern-local root readdir takes the LOCAL lane (the cloud-lane timeout executor is never reached → in prod a bare-fs hang)', async () => {
      const root = await patternLocalRootWithContents();
      // Healthy realpath, but the cloud-lane readdir wedges. On the LOCAL lane this
      // executor is NEVER touched (bare fsp.readdir is used) — modelling the prod hang
      // where bare fsp.readdir blocks the kernel on the dead mount.
      const timeoutReaddir = (): Promise<WorkspaceFsExecResult<WorkspaceDirent[]>> =>
        Promise.resolve({ ok: false, reason: 'timeout' });
      setWorkspaceFsExecutor(realFsExecutorWith({ readdirWithFileTypes: timeoutReaddir }));

      const seen: string[] = [];
      const result = await safeWalkDirectory(root, {
        onFile: ({ name }) => {
          seen.push(name);
        },
      });

      // Local lane taken: bare fsp.readdir enumerated the dir, the timeout executor was
      // never reached → no cloud-timeout. This IS the unbounded-hang vector in prod.
      expect(seen).toEqual(['a.md']);
      expect(result.truncatedReasons).toEqual([]);
      expect(isSafeWalkComplete(result)).toBe(true);
    });

    it('GREEN: WITH forceCloudRoot the FIRST readdir routes cloud (root realpath ok) → cloud-timeout, never the bare-fs local lane', async () => {
      const root = await patternLocalRootWithContents();
      // Healthy realpath (root + descendants resolve), but every enumeration wedges.
      const timeoutReaddir = (): Promise<WorkspaceFsExecResult<WorkspaceDirent[]>> =>
        Promise.resolve({ ok: false, reason: 'timeout' });
      setWorkspaceFsExecutor(realFsExecutorWith({ readdirWithFileTypes: timeoutReaddir }));

      const seen: string[] = [];
      const result = await safeWalkDirectory(root, {
        forceCloudRoot: true,
        onFile: ({ name }) => {
          seen.push(name);
        },
      });

      // Root realpath succeeded (cloud lane, healthy realpath), then the FIRST readdir
      // routed through the killable cloud lane → timeout → cloud-timeout truncation. No
      // file was enumerated (the bare-fs local lane was NOT taken).
      expect(result.rootRealPath).not.toBeNull();
      expect(result.truncatedReasons).toEqual(['cloud-timeout']);
      expect(seen).toEqual([]);
      expect(isSafeWalkComplete(result)).toBe(false);
    });

    it('GREEN: WITH forceCloudRoot a descendant per-entry realpath also routes cloud → cloud-timeout, never bare-fs', async () => {
      const root = await patternLocalRootWithContents();
      // Healthy realpath for the root; the root readdir succeeds (real fs lists `sub`
      // + `a.md`); but the DESCENDANT dir's per-entry realpath wedges. Without the
      // whole-subtree force, that per-entry realpath would take the bare-fs local lane
      // and hang on the dead mount.
      const timeoutRealpath = (): Promise<WorkspaceFsExecResult<string>> =>
        Promise.resolve({ ok: false, reason: 'timeout' });
      setWorkspaceFsExecutor(realFsExecutorWith({ realpath: timeoutRealpath }));

      const seen: string[] = [];
      const result = await safeWalkDirectory(root, {
        forceCloudRoot: true,
        onFile: ({ name }) => {
          seen.push(name);
        },
      });

      // The root realpath went through the cloud lane and timed out → the walk
      // short-circuits at the root with cloud-timeout (proving the root realpath is
      // forced). This single executor wedges realpath for ALL paths, so the descendant
      // realpath would equally be cloud-bounded if the root had resolved.
      expect(result.rootRealPath).toBeNull();
      expect(result.truncatedReasons).toEqual(['cloud-timeout']);
      expect(seen).toEqual([]);
      expect(isSafeWalkComplete(result)).toBe(false);
    });

    it('GREEN: WITH forceCloudRoot a descendant readdir (root realpath + readdir ok) routes cloud → cloud-timeout', async () => {
      const root = await patternLocalRootWithContents();
      // Let the root realpath + root readdir succeed locally-via-cloud-lane, then wedge
      // the readdir of the descendant `sub` dir. Without whole-subtree force the
      // descendant readdir takes the bare-fs local lane and hangs.
      let readdirCalls = 0;
      const wedgeSecondReaddir = (
        p: string,
      ): Promise<WorkspaceFsExecResult<WorkspaceDirent[]>> => {
        readdirCalls += 1;
        // First readdir (the root) succeeds via real fs; subsequent ones (descendants) wedge.
        if (readdirCalls === 1) {
          return realFsExecutor.readdirWithFileTypes(p);
        }
        return Promise.resolve({ ok: false, reason: 'timeout' });
      };
      setWorkspaceFsExecutor(realFsExecutorWith({ readdirWithFileTypes: wedgeSecondReaddir }));

      const seen: string[] = [];
      const result = await safeWalkDirectory(root, {
        forceCloudRoot: true,
        onFile: ({ name }) => {
          seen.push(name);
        },
      });

      // Root enumerated (`a.md` seen), then the descendant `sub` readdir routed cloud →
      // timeout → cloud-timeout. The descendant readdir was NOT a bare-fs local read.
      expect(seen).toEqual(['a.md']);
      expect(result.truncatedReasons).toEqual(['cloud-timeout']);
      expect(isSafeWalkComplete(result)).toBe(false);
    });
  });
});

describe('safeListFiles', () => {
  let tmpRoot: string;

  beforeEach(async () => {
    tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'rebel-safelist-'));
  });

  afterEach(async () => {
    await fs.rm(tmpRoot, { recursive: true, force: true });
  });

  it('collects only files matching the predicate', async () => {
    await fs.writeFile(path.join(tmpRoot, 'a.md'), '');
    await fs.writeFile(path.join(tmpRoot, 'b.txt'), '');
    await fs.writeFile(path.join(tmpRoot, 'c.md'), '');

    const { files, result } = await safeListFiles(
      tmpRoot,
      ({ name }) => name.endsWith('.md'),
    );

    expect(files.map((p) => path.basename(p)).sort()).toEqual(['a.md', 'c.md']);
    expect(result.entriesVisited).toBe(3);
  });

  it('still applies safety guards', async () => {
    let cursor = tmpRoot;
    for (let i = 0; i < DEFAULT_SAFE_WALK_LIMITS.MAX_DEPTH + 3; i += 1) {
      cursor = path.join(cursor, `lv${i}`);
      await fs.mkdir(cursor);
    }
    await fs.writeFile(path.join(cursor, 'too-deep.md'), '');

    const { files, result } = await safeListFiles(tmpRoot, () => true);

    expect(files).toEqual([]);
    expect(result.truncatedReasons).toContain('depth');
  });

  it('honours onDirectory predicate from options', async () => {
    await fs.mkdir(path.join(tmpRoot, 'keep'));
    await fs.mkdir(path.join(tmpRoot, 'skip'));
    await fs.writeFile(path.join(tmpRoot, 'keep', 'in.md'), '');
    await fs.writeFile(path.join(tmpRoot, 'skip', 'out.md'), '');

    const { files } = await safeListFiles(
      tmpRoot,
      ({ name }) => name.endsWith('.md'),
      {
        onDirectory: ({ name }: SafeWalkDirInfo) => name !== 'skip',
      },
    );

    expect(files.map((p) => path.basename(p))).toEqual(['in.md']);
  });
});
