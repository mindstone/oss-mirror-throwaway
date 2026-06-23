import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import properLockfile from 'proper-lockfile';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  setWorkspaceFileSystemFactory,
  type WorkspaceDirectoryEntry,
  type WorkspaceFileSystem,
  type WorkspacePathStat,
} from '@core/workspaceFileSystem';
import {
  _resetOperatorDiaryStoreForTests,
  appendDiary,
  readDiary,
} from '../operatorDiaryStore';

class RealWorkspaceFileSystem implements WorkspaceFileSystem {
  private resolve(root: string, target: string): string {
    const resolvedRoot = path.resolve(root);
    const resolved = path.resolve(resolvedRoot, target);
    if (!resolved.startsWith(resolvedRoot)) {
      throw new Error('Path traversal not allowed');
    }
    return resolved;
  }

  async listDirectory(): Promise<WorkspaceDirectoryEntry[]> {
    return [];
  }

  async realPath(root: string, target: string): Promise<string> {
    return fs.realpath(this.resolve(root, target));
  }

  async stat(root: string, target: string): Promise<WorkspacePathStat> {
    const stat = await fs.stat(this.resolve(root, target));
    return { isDirectory: stat.isDirectory(), mtimeMs: stat.mtimeMs, sizeBytes: stat.size };
  }

  async readFile(root: string, target: string): Promise<string> {
    return fs.readFile(this.resolve(root, target), 'utf-8');
  }

  async writeFile(root: string, target: string, content: string | Uint8Array): Promise<void> {
    const resolved = this.resolve(root, target);
    await fs.mkdir(path.dirname(resolved), { recursive: true });
    await fs.writeFile(resolved, content);
  }

  async appendFile(root: string, target: string, content: string | Uint8Array): Promise<void> {
    const resolved = this.resolve(root, target);
    await fs.mkdir(path.dirname(resolved), { recursive: true });
    await fs.appendFile(resolved, content);
  }

  async renameFile(root: string, source: string, target: string): Promise<void> {
    await fs.rename(this.resolve(root, source), this.resolve(root, target));
  }

  async deleteFile(root: string, target: string): Promise<void> {
    await fs.rm(this.resolve(root, target), { force: true });
  }

  async exists(root: string, target: string): Promise<boolean> {
    try {
      await fs.access(this.resolve(root, target));
      return true;
    } catch {
      return false;
    }
  }
}

let tempRoot: string;

describe('operatorDiaryStore', () => {
  beforeEach(async () => {
    tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'operator-diary-'));
    setWorkspaceFileSystemFactory(() => new RealWorkspaceFileSystem());
    _resetOperatorDiaryStoreForTests();
  });

  afterEach(async () => {
    await fs.rm(tempRoot, { recursive: true, force: true });
  });

  it('returns empty string when diary file does not exist', async () => {
    await expect(readDiary('skeptical-engineer', tempRoot)).resolves.toBe('');
  });

  it('serializes diary appends with a lockfile and surfaces lock contention', async () => {
    await appendDiary('skeptical-engineer', tempRoot, 'first entry');
    await appendDiary('skeptical-engineer', tempRoot, 'second entry');
    await expect(readDiary('skeptical-engineer', tempRoot)).resolves.toBe('first entry\n\nsecond entry\n');

    const diaryLockPath = path.join(tempRoot, 'operators', 'skeptical-engineer', 'diary.md.lock');
    await fs.writeFile(diaryLockPath, '', 'utf-8');
    const release = await properLockfile.lock(diaryLockPath, { retries: { retries: 0 }, realpath: false });
    try {
      await expect(appendDiary('skeptical-engineer', tempRoot, 'blocked entry')).rejects.toThrow();
    } finally {
      await release();
    }
  });

  it('serializes first-time concurrent diary appends without truncation', async () => {
    await Promise.all([
      appendDiary('skeptical-engineer', tempRoot, 'first concurrent entry'),
      appendDiary('skeptical-engineer', tempRoot, 'second concurrent entry'),
      appendDiary('skeptical-engineer', tempRoot, 'third concurrent entry'),
    ]);

    const diary = await readDiary('skeptical-engineer', tempRoot);
    expect(diary).toContain('first concurrent entry');
    expect(diary).toContain('second concurrent entry');
    expect(diary).toContain('third concurrent entry');
    expect(diary.split('\n').filter((line) => line.includes('concurrent entry'))).toHaveLength(3);
    await expect(fs.readFile(
      path.join(tempRoot, 'operators', 'skeptical-engineer', 'diary.md'),
      'utf-8',
    )).resolves.toBe(diary);
  });

  it('preserves diary content across separate write batches', async () => {
    await appendDiary('skeptical-engineer', tempRoot, 'session one');
    const firstRead = await readDiary('skeptical-engineer', tempRoot);
    expect(firstRead).toBe('session one\n');

    await appendDiary('skeptical-engineer', tempRoot, 'session two');
    await expect(readDiary('skeptical-engineer', tempRoot)).resolves.toBe('session one\n\nsession two\n');
  });

});
