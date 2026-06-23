/**
 * Regression coverage for listMarkdownFilesRecursively traversal guards.
 *
 * Pre-fix, this walker followed every directory entry without depth, path-
 * length, or symlink-cycle protection. A user with a self-referential
 * workspace symlink (`Mindstone Rebel Chief of Staff/work/Acme ->` ancestor)
 * generated 100+ unique Sentry issues with `ENAMETOOLONG: name too long` —
 * see REBEL-4WS through REBEL-510.
 *
 * These tests use the real fs against a temp directory so we exercise the
 * actual symlink/loop semantics rather than mocks that would just rubber-
 * stamp the implementation.
 */

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import {
  listMarkdownFilesRecursively,
  __listMarkdownTraversalLimits,
} from '../shared';

describe('listMarkdownFilesRecursively', () => {
  let tmpRoot: string;

  beforeEach(async () => {
    tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'rebel-list-md-'));
  });

  afterEach(async () => {
    await fs.rm(tmpRoot, { recursive: true, force: true });
  });

  it('returns all .md files in a small flat directory', async () => {
    await fs.writeFile(path.join(tmpRoot, 'one.md'), '# one');
    await fs.writeFile(path.join(tmpRoot, 'two.md'), '# two');
    await fs.writeFile(path.join(tmpRoot, 'ignored.txt'), 'no');

    const results = await listMarkdownFilesRecursively(tmpRoot);

    const basenames = results.map((p) => path.basename(p)).sort();
    expect(basenames).toEqual(['one.md', 'two.md']);
  });

  it('descends into nested subdirectories within the depth limit', async () => {
    const sub = path.join(tmpRoot, 'a', 'b', 'c');
    await fs.mkdir(sub, { recursive: true });
    await fs.writeFile(path.join(tmpRoot, 'root.md'), '# root');
    await fs.writeFile(path.join(sub, 'deep.md'), '# deep');

    const results = await listMarkdownFilesRecursively(tmpRoot);

    expect(results.map((p) => path.basename(p)).sort()).toEqual(['deep.md', 'root.md']);
  });

  it('does not loop forever when a directory symlinks to its ancestor', async () => {
    // /tmp/.../root/work/Acme -> /tmp/.../root  (self-referential)
    const work = path.join(tmpRoot, 'work');
    await fs.mkdir(work, { recursive: true });
    await fs.symlink(tmpRoot, path.join(work, 'Acme'));

    await fs.writeFile(path.join(tmpRoot, 'root.md'), '# root');
    await fs.writeFile(path.join(work, 'work.md'), '# work');

    // Without the cycle guard, this would either spin forever or throw
    // ENAMETOOLONG. With the guard it returns the unique .md files.
    const results = await listMarkdownFilesRecursively(tmpRoot);
    const basenames = new Set(results.map((p) => path.basename(p)));

    expect(basenames.has('root.md')).toBe(true);
    expect(basenames.has('work.md')).toBe(true);
    // Each path should only appear once (no double-counting via loop)
    expect(results.length).toBe(new Set(results).size);
  });

  it('exposes traversal limits as a module constant', () => {
    expect(__listMarkdownTraversalLimits.MAX_DEPTH).toBeGreaterThan(0);
    expect(__listMarkdownTraversalLimits.MAX_PATH_LENGTH).toBeLessThan(1024);
    expect(__listMarkdownTraversalLimits.MAX_ENTRIES).toBeGreaterThan(1000);
  });

  it('returns empty array when root does not exist', async () => {
    const results = await listMarkdownFilesRecursively(path.join(tmpRoot, 'nope'));
    expect(results).toEqual([]);
  });

  it('skips broken symlinks rather than throwing', async () => {
    await fs.writeFile(path.join(tmpRoot, 'real.md'), '# real');
    await fs.symlink(path.join(tmpRoot, '__missing__'), path.join(tmpRoot, 'broken'));

    const results = await listMarkdownFilesRecursively(tmpRoot);

    expect(results.map((p) => path.basename(p))).toEqual(['real.md']);
  });

  it('follows a non-cyclic directory symlink and returns its .md contents', async () => {
    // Real layout: tmp/data/topics/leaf.md
    // Symlink:     tmp/root/topics-link -> tmp/data/topics
    const dataTopics = path.join(tmpRoot, 'data', 'topics');
    await fs.mkdir(dataTopics, { recursive: true });
    await fs.writeFile(path.join(dataTopics, 'leaf.md'), '# leaf');

    const rootDir = path.join(tmpRoot, 'root');
    await fs.mkdir(rootDir);
    await fs.symlink(dataTopics, path.join(rootDir, 'topics-link'));

    const results = await listMarkdownFilesRecursively(rootDir);

    expect(results.map((p) => path.basename(p))).toEqual(['leaf.md']);
  });

  it('follows a symlink that points directly at a .md file', async () => {
    const realFile = path.join(tmpRoot, 'real.md');
    await fs.writeFile(realFile, '# real');
    await fs.symlink(realFile, path.join(tmpRoot, 'alias.md'));

    const results = await listMarkdownFilesRecursively(tmpRoot);
    const basenames = results.map((p) => path.basename(p)).sort();

    expect(basenames).toContain('real.md');
    expect(basenames).toContain('alias.md');
  });

  it('does not loop when traversing real directories that genuinely nest', async () => {
    // Reproduces the user's situation where a workspace was accidentally
    // copied/moved INSIDE itself. No symlinks — just a real, deep tree that
    // would otherwise overflow PATH_MAX.
    let cursor = tmpRoot;
    for (let i = 0; i < 30; i += 1) {
      cursor = path.join(cursor, 'work', 'Acme');
      await fs.mkdir(cursor, { recursive: true });
    }
    await fs.writeFile(path.join(cursor, 'deep.md'), '# deep');
    await fs.writeFile(path.join(tmpRoot, 'top.md'), '# top');

    // Must not throw ENAMETOOLONG; depth/path-length caps should fire.
    const results = await listMarkdownFilesRecursively(tmpRoot);
    const basenames = results.map((p) => path.basename(p));

    expect(basenames).toContain('top.md');
    // deep.md is past MAX_DEPTH; truncation is the contract.
    expect(basenames).not.toContain('deep.md');
  });

  it('stops descending past the depth limit', async () => {
    // Build N levels where N > MAX_DEPTH; place a .md at the deepest level
    // and a sibling at root. Root sibling must come back; deepest must NOT.
    const depth = __listMarkdownTraversalLimits.MAX_DEPTH + 3;
    let cursor = tmpRoot;
    for (let i = 0; i < depth; i += 1) {
      cursor = path.join(cursor, `lv${i}`);
      await fs.mkdir(cursor);
    }
    await fs.writeFile(path.join(tmpRoot, 'root.md'), '# root');
    await fs.writeFile(path.join(cursor, 'too-deep.md'), '# too-deep');

    const results = await listMarkdownFilesRecursively(tmpRoot);
    const basenames = results.map((p) => path.basename(p));

    expect(basenames).toContain('root.md');
    expect(basenames).not.toContain('too-deep.md');
  });
});
