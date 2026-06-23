import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { collectSafeSnapshotFiles } from '../safeSnapshotCopy';

describe('collectSafeSnapshotFiles', () => {
  let tmpRoot: string;

  beforeEach(async () => {
    tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'rebel-safe-snapshot-'));
  });

  afterEach(async () => {
    await fs.rm(tmpRoot, { recursive: true, force: true });
  });

  it('collects regular files in a directory and reports no failure', async () => {
    const dir = path.join(tmpRoot, 'space');
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, 'a.json'), '{"a":1}', 'utf8');
    await fs.writeFile(path.join(dir, 'b.json'), '{"b":2}', 'utf8');

    const result = await collectSafeSnapshotFiles(tmpRoot, 'space');

    expect(result.failure).toBeUndefined();
    expect(result.files.map((f) => f.relativePath).sort()).toEqual([
      'space/a.json',
      'space/b.json',
    ]);
  });

  it('does not fail when the directory contains a cloud-looking symlink — the symlink is skipped and the walk is treated complete (Rec-1 F1)', async () => {
    if (process.platform === 'win32') return;
    const dir = path.join(tmpRoot, 'space');
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, 'a.json'), '{"a":1}', 'utf8');

    // A nested symlink whose realpath looks like a cloud mount (Dropbox).
    // Pre-fix the default-on cloud-skip pushes a 'cloud-symlink-skipped'
    // truncation reason → `isSafeWalkComplete` is false → the collector
    // returns a `directory_walk_incomplete` failure, which migration export
    // turns into a hard source-walk-failed/space-walk-failed error.
    const cloudTarget = path.join(tmpRoot, 'Dropbox', 'linked-folder');
    await fs.mkdir(cloudTarget, { recursive: true });
    await fs.writeFile(path.join(cloudTarget, 'cloud.json'), '{"cloud":true}', 'utf8');
    await fs.symlink(cloudTarget, path.join(dir, 'cloud-link'));

    const result = await collectSafeSnapshotFiles(tmpRoot, 'space');

    // The walk is treated complete (no failure), the real file is collected,
    // and the cloud file (reachable only through the symlink) is NOT.
    expect(result.failure).toBeUndefined();
    expect(result.files.map((f) => f.relativePath)).toEqual(['space/a.json']);
    expect(result.files.some((f) => f.relativePath.includes('cloud.json'))).toBe(false);
  });
});
