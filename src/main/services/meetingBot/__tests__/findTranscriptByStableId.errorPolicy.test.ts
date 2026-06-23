import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { findTranscriptByStableId } from '../transcriptStorage';

describe('findTranscriptByStableId error policy', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('treats ENOTDIR from date-folder readdir as benign and continues', async () => {
    const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'meeting-source-enotdir-'));
    const monthFolder = path.join(tmpRoot, 'memory', 'sources', '2026', '05-May');

    await fs.mkdir(monthFolder, { recursive: true });
    await fs.writeFile(path.join(monthFolder, '17'), 'not a directory', 'utf-8');

    try {
      await expect(
        findTranscriptByStableId(tmpRoot, 'missing-id', 'recall', new Date('2026-05-17T12:00:00.000Z')),
      ).resolves.toBeNull();
    } finally {
      await fs.rm(tmpRoot, { recursive: true, force: true });
    }
  });

  it('propagates EACCES from directory reads (fail-closed)', async () => {
    const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'meeting-source-eacces-'));
    const sourcesDir = path.join(tmpRoot, 'memory', 'sources');
    await fs.mkdir(sourcesDir, { recursive: true });

    const eaccesError = Object.assign(new Error('permission denied'), { code: 'EACCES' });
    const originalReaddir = fs.readdir.bind(fs);
    vi.spyOn(fs, 'readdir').mockImplementation((async (...args: any[]) => {
      const [targetPath] = args;
      if (String(targetPath) === sourcesDir) {
        throw eaccesError;
      }
      return originalReaddir(args[0], args[1]);
    }) as typeof fs.readdir);

    try {
      await expect(findTranscriptByStableId(tmpRoot, 'missing-id', 'recall')).rejects.toMatchObject({
        code: 'EACCES',
      });
    } finally {
      await fs.rm(tmpRoot, { recursive: true, force: true });
    }
  });

  it('propagates EPERM from directory reads (fail-closed)', async () => {
    const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'meeting-source-eperm-'));
    const sourcesDir = path.join(tmpRoot, 'memory', 'sources');
    await fs.mkdir(sourcesDir, { recursive: true });

    const epermError = Object.assign(new Error('operation not permitted'), { code: 'EPERM' });
    const originalReaddir = fs.readdir.bind(fs);
    vi.spyOn(fs, 'readdir').mockImplementation((async (...args: any[]) => {
      const [targetPath] = args;
      if (String(targetPath) === sourcesDir) {
        throw epermError;
      }
      return originalReaddir(args[0], args[1]);
    }) as typeof fs.readdir);

    try {
      await expect(findTranscriptByStableId(tmpRoot, 'missing-id', 'recall')).rejects.toMatchObject({
        code: 'EPERM',
      });
    } finally {
      await fs.rm(tmpRoot, { recursive: true, force: true });
    }
  });
});
