import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { validateGitCommitExists } from '../validate-git-commit';

const tempDirs: string[] = [];

function createTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'validate-git-commit-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  vi.restoreAllMocks();
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
});

describe('validateGitCommitExists', () => {
  it('does not invoke git cat-file when repoRoot lacks .git', () => {
    const runGitCatFile = vi.fn();
    const nonRepoRoot = createTempDir();

    expect(() => validateGitCommitExists(nonRepoRoot, 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef', runGitCatFile)).toThrow(
      new RegExp(`repoRoot ${nonRepoRoot} is not a git repository`),
    );

    expect(runGitCatFile).not.toHaveBeenCalled();
  });
});
