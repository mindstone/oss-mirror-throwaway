import { mkdtempSync } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { countLibraryItems } from '../fileTreeService';

describe('countLibraryItems', () => {
  let tmpRoot: string;

  beforeEach(() => {
    tmpRoot = mkdtempSync(path.join(os.tmpdir(), 'rebel-fts-'));
  });

  afterEach(async () => {
    await fs.rm(tmpRoot, { recursive: true, force: true });
  });

  it('returns zero counts for an empty workspace', async () => {
    await expect(countLibraryItems(tmpRoot, false)).resolves.toEqual({
      totalFiles: 0,
      totalDirs: 0,
      truncated: false,
    });
  });

  it('counts files and subdirectories without counting the root directory', async () => {
    const subdir = path.join(tmpRoot, 'subdir');
    await fs.mkdir(subdir);
    await Promise.all([
      fs.writeFile(path.join(tmpRoot, 'one.txt'), 'one'),
      fs.writeFile(path.join(tmpRoot, 'two.txt'), 'two'),
      fs.writeFile(path.join(tmpRoot, 'three.txt'), 'three'),
      fs.writeFile(path.join(subdir, 'four.txt'), 'four'),
    ]);

    await expect(countLibraryItems(tmpRoot, false)).resolves.toEqual({
      totalFiles: 4,
      totalDirs: 1,
      truncated: false,
    });
  });

  it('honors the hidden-file toggle for files and directories', async () => {
    const hiddenDir = path.join(tmpRoot, '.hidden-dir');
    await fs.mkdir(hiddenDir);
    await Promise.all([
      fs.writeFile(path.join(tmpRoot, 'visible.txt'), 'visible'),
      fs.writeFile(path.join(tmpRoot, '.hidden.txt'), 'hidden'),
      fs.writeFile(path.join(hiddenDir, 'inside-hidden.txt'), 'inside'),
    ]);

    await expect(countLibraryItems(tmpRoot, false)).resolves.toEqual({
      totalFiles: 1,
      totalDirs: 0,
      truncated: false,
    });

    await expect(countLibraryItems(tmpRoot, true)).resolves.toEqual({
      totalFiles: 3,
      totalDirs: 1,
      truncated: false,
    });
  });

  it('does not count node_modules directories or their contents', async () => {
    const dependencyDir = path.join(tmpRoot, 'node_modules', 'dependency');
    await fs.mkdir(dependencyDir, { recursive: true });
    await Promise.all([
      fs.writeFile(path.join(tmpRoot, 'app.ts'), 'export {};'),
      fs.writeFile(path.join(dependencyDir, 'index.js'), 'module.exports = {};'),
    ]);

    await expect(countLibraryItems(tmpRoot, true)).resolves.toEqual({
      totalFiles: 1,
      totalDirs: 0,
      truncated: false,
    });
  });

  it('reports truncation when a subdirectory cannot be read', async () => {
    const readable = path.join(tmpRoot, 'readable');
    const unreadable = path.join(tmpRoot, 'unreadable');
    await fs.mkdir(readable);
    await fs.mkdir(unreadable);
    await Promise.all([
      fs.writeFile(path.join(readable, 'ok.md'), 'ok'),
      fs.writeFile(path.join(unreadable, 'hidden.md'), 'hidden'),
    ]);

    let chmodSucceeded = false;
    try {
      await fs.chmod(unreadable, 0o000);
      try {
        await fs.readdir(unreadable);
      } catch {
        chmodSucceeded = true;
      }
    } catch {
      // Some filesystems/environments do not support this permission change.
    }

    let stats: Awaited<ReturnType<typeof countLibraryItems>> | null = null;
    try {
      stats = await countLibraryItems(tmpRoot, false);
    } finally {
      try {
        await fs.chmod(unreadable, 0o755);
      } catch {
        // Best-effort restore before afterEach cleanup.
      }
    }

    expect(stats).not.toBeNull();
    if (!stats) throw new Error('countLibraryItems did not return stats');

    expect(stats.totalFiles).toBeGreaterThanOrEqual(1);
    expect(stats.totalDirs).toBeGreaterThanOrEqual(1);

    if (chmodSucceeded) {
      expect(stats).toEqual({
        totalFiles: 1,
        totalDirs: 2,
        truncated: true,
      });
    } else {
      expect(stats.truncated).toBe(false);
    }
  });
});
