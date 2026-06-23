import * as childProcess from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { parseOutcome } from '../outcome-schema.ts';

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const tempDirs: string[] = [];

function createTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sentry-autopilot-parse-outcome-'));
  tempDirs.push(dir);
  return dir;
}

function headCommit(): string {
  return childProcess.execFileSync('git', ['rev-parse', 'HEAD'], { cwd: REPO_ROOT, encoding: 'utf8' }).trim();
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

describe('parseOutcome', () => {
  it('accepts auto_committed outcomes when the commit exists', () => {
    const commitHash = headCommit();

    const parsed = parseOutcome(
      {
        outcome: 'auto_committed',
        commit_hash: commitHash,
      },
      { repoRoot: REPO_ROOT },
    );

    expect(parsed).toMatchObject({
      outcome: 'auto_committed',
      commit_hash: commitHash,
    });
  });

  it('throws when auto_committed references a non-existent commit hash', () => {
    expect(() =>
      parseOutcome(
        {
          outcome: 'auto_committed',
          commit_hash: 'ffffffffffffffffffffffffffffffffffffffff',
        },
        { repoRoot: REPO_ROOT },
      ),
    ).toThrow(/does not exist in/);
  });

  it('bypasses commit existence check when skipCommitValidation is true (canary-only escape hatch)', () => {
    const bogusHash = 'ffffffffffffffffffffffffffffffffffffffff';

    const parsed = parseOutcome(
      {
        outcome: 'auto_committed',
        commit_hash: bogusHash,
      },
      { repoRoot: REPO_ROOT, skipCommitValidation: true },
    );

    expect(parsed).toMatchObject({
      outcome: 'auto_committed',
      commit_hash: bogusHash,
    });
  });

  it('throws a distinct error when repoRoot is not a git repository', () => {
    const nonRepoRoot = createTempDir();
    const commitHash = headCommit();

    expect(() =>
      parseOutcome(
        {
          outcome: 'auto_committed',
          commit_hash: commitHash,
        },
        { repoRoot: nonRepoRoot },
      ),
    ).toThrow(new RegExp(`repoRoot ${nonRepoRoot} is not a git repository`));
  });

  it('throws a distinct error when git executable is missing', () => {
    const commitHash = headCommit();
    const originalPath = process.env.PATH;
    const emptyBinDir = createTempDir();
    process.env.PATH = emptyBinDir;

    try {
      expect(() =>
        parseOutcome(
          {
            outcome: 'auto_committed',
            commit_hash: commitHash,
          },
          { repoRoot: REPO_ROOT },
        ),
      ).toThrow(/git executable not found while validating commit/);
    } finally {
      process.env.PATH = originalPath;
    }
  });

  it('preserves raw input in Error.cause and avoids message payload leaks on parse failure', () => {
    const objectPayload = { payload: 'super-secret-token', nested: { value: 42 } };
    const primitivePayload = 'not json';

    let objectError: (Error & { cause?: unknown }) | undefined;
    let primitiveError: (Error & { cause?: unknown }) | undefined;

    try {
      parseOutcome(objectPayload, { repoRoot: REPO_ROOT });
    } catch (error) {
      objectError = error as Error & { cause?: unknown };
    }

    try {
      parseOutcome(primitivePayload, { repoRoot: REPO_ROOT });
    } catch (error) {
      primitiveError = error as Error & { cause?: unknown };
    }

    expect(objectError).toBeInstanceOf(Error);
    expect(objectError?.cause).toBe(objectPayload);
    expect(objectError?.message).not.toContain('super-secret-token');
    expect(objectError?.message).not.toContain(JSON.stringify(objectPayload));

    expect(primitiveError).toBeInstanceOf(Error);
    expect(primitiveError?.cause).toBe(primitivePayload);
    expect(primitiveError?.message).not.toContain(primitivePayload);
  });
});
