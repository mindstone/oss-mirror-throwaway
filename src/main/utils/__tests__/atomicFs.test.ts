import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { writeFileAtomic } from '../atomicFs';

describe('writeFileAtomic', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'atomic-fs-'));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('writes a new file', async () => {
    const filePath = path.join(tmpDir, 'new.txt');
    await writeFileAtomic(filePath, 'hello');
    expect(await fs.readFile(filePath, 'utf8')).toBe('hello');
  });

  it('overwrites an existing file', async () => {
    const filePath = path.join(tmpDir, 'existing.txt');
    await fs.writeFile(filePath, 'old content', 'utf8');
    await writeFileAtomic(filePath, 'new content');
    expect(await fs.readFile(filePath, 'utf8')).toBe('new content');
  });

  it('creates parent directories if needed', async () => {
    const filePath = path.join(tmpDir, 'nested', 'deep', 'file.txt');
    await writeFileAtomic(filePath, 'nested content');
    expect(await fs.readFile(filePath, 'utf8')).toBe('nested content');
  });

  it('cleans up temp file on write failure', async () => {
    const dirPath = path.join(tmpDir, 'readonly');
    await fs.mkdir(dirPath);
    const filePath = path.join(dirPath, 'subdir', 'file.txt');
    await fs.mkdir(path.join(dirPath, 'subdir'));
    await writeFileAtomic(filePath, 'content');
    const entries = await fs.readdir(path.join(dirPath, 'subdir'));
    expect(entries.filter((entry) => entry.endsWith('.tmp'))).toHaveLength(0);
  });
});
