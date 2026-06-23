import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

const execFileSyncMock = vi.hoisted(() => vi.fn());

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return {
    ...actual,
    execFileSync: execFileSyncMock,
  };
});

import { parseOutcome } from '../outcome-schema.ts';

const tempDirs: string[] = [];

function createTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'parse-outcome-git-guard-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  execFileSyncMock.mockReset();
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
});

describe('parseOutcome git-discovery guard', () => {
  it('does not invoke git cat-file when repoRoot lacks .git', () => {
    const nonRepoRoot = createTempDir();
    const commitHash = 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef';

    expect(() =>
      parseOutcome(
        {
          outcome: 'auto_committed',
          commit_hash: commitHash,
        },
        { repoRoot: nonRepoRoot },
      ),
    ).toThrow(new RegExp(`repoRoot ${nonRepoRoot} is not a git repository`));

    const gitCatFileCalls = execFileSyncMock.mock.calls.filter(
      (call) => call[0] === 'git' && Array.isArray(call[1]) && call[1][0] === 'cat-file',
    );
    expect(gitCatFileCalls).toEqual([]);
  });
});
