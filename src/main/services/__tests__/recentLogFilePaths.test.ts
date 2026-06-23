import path from 'node:path';
import { tmpdir } from 'node:os';
import { promises as fs } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  listRecentLogFilePaths,
  type LogFilePathsFsLike,
} from '../recentLogFilePaths';

let tempDir: string;

beforeEach(async () => {
  tempDir = await fs.mkdtemp(path.join(tmpdir(), 'recent-log-file-paths-'));
});

afterEach(async () => {
  await fs.rm(tempDir, { recursive: true, force: true });
});

describe('listRecentLogFilePaths', () => {
  it('returns an empty result for an empty log directory', async () => {
    const result = await listRecentLogFilePaths({ resolveLogDir: () => tempDir });

    expect(result).toEqual({
      logDir: tempDir,
      files: [],
      totalBytes: 0,
      errors: [],
    });
  });

  it('returns one file entry with size and mtime metadata', async () => {
    const filePath = await writeLogFile('mindstone-rebel.log', 'hello logs', 1);
    const stats = await fs.stat(filePath);

    const result = await listRecentLogFilePaths({ resolveLogDir: () => tempDir });

    expect(result.files).toEqual([
      {
        path: filePath,
        basename: 'mindstone-rebel.log',
        size: Buffer.byteLength('hello logs', 'utf8'),
        mtimeMs: stats.mtimeMs,
        mtimeIso: new Date(stats.mtimeMs).toISOString(),
      },
    ]);
    expect(result.totalBytes).toBe(Buffer.byteLength('hello logs', 'utf8'));
    expect(result.errors).toEqual([]);
  });

  it('orders active and rotated log files newest-first and sums total bytes', async () => {
    await writeLogFile('mindstone-rebel.3.log', 'oldest', 1);
    await writeLogFile('mindstone-rebel.2.log', 'middle', 2);
    await writeLogFile('mindstone-rebel.1.log', 'newer', 3);
    await writeLogFile('mindstone-rebel.log', 'newest', 4);

    const result = await listRecentLogFilePaths({ resolveLogDir: () => tempDir });

    expect(result.files.map((file) => file.basename)).toEqual([
      'mindstone-rebel.log',
      'mindstone-rebel.1.log',
      'mindstone-rebel.2.log',
      'mindstone-rebel.3.log',
    ]);
    expect(result.totalBytes).toBe(
      Buffer.byteLength('oldestmiddlenewernewest', 'utf8'),
    );
  });

  it('uses the same filename filter as recent log tailing', async () => {
    await writeLogFile('mindstone-rebel.log', 'active', 2);
    await writeLogFile('mindstone-rebel.1.log', 'rotated', 1);
    await fs.writeFile(path.join(tempDir, 'mindstone-rebel.log.tmp'), 'tmp', 'utf8');
    await fs.writeFile(path.join(tempDir, 'random-app.log'), 'random', 'utf8');
    await fs.writeFile(path.join(tempDir, 'mindstone-rebel.99.log.gz'), 'gz', 'utf8');
    await fs.writeFile(path.join(tempDir, 'mindstone-rebel.log-backup.txt'), 'backup', 'utf8');

    const result = await listRecentLogFilePaths({ resolveLogDir: () => tempDir });

    expect(result.files.map((file) => file.basename)).toEqual([
      'mindstone-rebel.log',
      'mindstone-rebel.1.log',
    ]);
  });

  it('does not traverse per-turn session logs', async () => {
    await fs.mkdir(path.join(tempDir, 'sessions'), { recursive: true });
    await fs.writeFile(path.join(tempDir, 'sessions', 'per-turn-1.log'), 'session', 'utf8');
    await writeLogFile('mindstone-rebel.log', 'main', 1);

    const result = await listRecentLogFilePaths({ resolveLogDir: () => tempDir });

    expect(result.files.map((file) => file.basename)).toEqual(['mindstone-rebel.log']);
  });

  it('captures ENOENT races during stat without throwing', async () => {
    const missingPath = path.join(tempDir, 'mindstone-rebel.log');
    const fsLike: LogFilePathsFsLike = {
      readdir: async () => ['mindstone-rebel.log'],
      stat: async () => {
        const err = new Error('rotated away') as NodeJS.ErrnoException;
        err.code = 'ENOENT';
        throw err;
      },
    };

    const result = await listRecentLogFilePaths({
      resolveLogDir: () => tempDir,
      fs: fsLike,
    });

    expect(result.files).toEqual([]);
    expect(result.totalBytes).toBe(0);
    expect(result.errors).toEqual([{ path: missingPath, reason: 'ENOENT' }]);
  });

  it('returns ISO 8601 mtime strings', async () => {
    await writeLogFile('mindstone-rebel.log', 'dated', 1);

    const result = await listRecentLogFilePaths({ resolveLogDir: () => tempDir });

    expect(result.files[0].mtimeIso).toMatch(
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/,
    );
  });

  it('never throws on log-directory-level failures', async () => {
    const fsLike: LogFilePathsFsLike = {
      readdir: async () => {
        throw new Error('cannot read dir');
      },
      stat: (filePath) => fs.stat(filePath),
    };

    const result = await listRecentLogFilePaths({
      resolveLogDir: () => tempDir,
      fs: fsLike,
    });

    expect(result).toEqual({
      logDir: tempDir,
      files: [],
      totalBytes: 0,
      errors: [{ path: 'logDir', reason: 'cannot read dir' }],
    });
  });
});

async function writeLogFile(name: string, content: string, mtimeOrder = 1): Promise<string> {
  const filePath = path.join(tempDir, name);
  await fs.writeFile(filePath, content, 'utf8');
  await setMtime(filePath, mtimeOrder);
  return filePath;
}

async function setMtime(filePath: string, order: number): Promise<void> {
  const date = new Date(1_700_000_000_000 + order * 1000);
  await fs.utimes(filePath, date, date);
}
