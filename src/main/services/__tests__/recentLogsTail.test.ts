import path from 'node:path';
import { tmpdir } from 'node:os';
import { promises as fs } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_RECENT_LOGS_BYTES,
  DEFAULT_RECENT_LOGS_LINES,
  MAX_RECENT_LOGS_LINES,
  MAX_TAIL_BYTES_PER_FILE,
  MAX_TOTAL_TAIL_BYTES,
  MIN_RECENT_LOGS_BYTES,
} from '@core/services/diagnostics/recentLogsConstants';
import {
  tailRecentMainLogs,
  type FsLike,
} from '../recentLogsTail';

let tempDir: string;

beforeEach(async () => {
  tempDir = await fs.mkdtemp(path.join(tmpdir(), 'recent-logs-tail-'));
});

afterEach(async () => {
  await fs.rm(tempDir, { recursive: true, force: true });
});

describe('tailRecentMainLogs', () => {
  it('returns empty content for an empty log directory', async () => {
    const result = await tailRecentMainLogs({ resolveLogDir: () => tempDir });

    expect(result).toMatchObject({
      content: '',
      lines: 0,
      bytesReturned: 0,
      bytesAvailable: 0,
      truncated: false,
      filesRead: [],
      errors: [],
    });
  });

  it('returns a single small file in oldest-first line order', async () => {
    const lines = makeLines('current', 10);
    await writeLogFile('mindstone-rebel.log', lines);

    const result = await tailRecentMainLogs({ resolveLogDir: () => tempDir });

    expect(result.content).toBe(lines.join('\n'));
    expect(result.lines).toBe(10);
    expect(result.truncated).toBe(false);
  });

  it('concatenates rotated files chronologically after selecting by newest mtime', async () => {
    const oldest = makeLines('oldest', 10);
    const middle = makeLines('middle', 20);
    const newest = makeLines('newest', 30);
    await writeLogFile('mindstone-rebel.2.log', oldest, 1);
    await writeLogFile('mindstone-rebel.1.log', middle, 2);
    await writeLogFile('mindstone-rebel.log', newest, 3);

    const result = await tailRecentMainLogs({ resolveLogDir: () => tempDir });

    expect(result.content).toBe([...oldest, ...middle, ...newest].join('\n'));
    expect(result.filesRead).toHaveLength(3);
    expect(result.filesRead.map((file) => path.basename(file.path))).toEqual([
      'mindstone-rebel.log',
      'mindstone-rebel.1.log',
      'mindstone-rebel.2.log',
    ]);
  });

  it('strictly includes only the active main log and pino-roll rotated siblings', async () => {
    await writeLogFile('mindstone-rebel.1.log', ['rotated'], 1);
    await writeLogFile('mindstone-rebel.log', ['active'], 2);
    await fs.writeFile(path.join(tempDir, 'mindstone-rebel.log.tmp'), 'tmp\n', 'utf8');
    await fs.writeFile(path.join(tempDir, 'mindstone-rebel.log-backup.txt'), 'backup\n', 'utf8');
    await fs.writeFile(path.join(tempDir, 'mindstone-rebel.99.log.gz'), 'gz\n', 'utf8');
    await fs.writeFile(path.join(tempDir, 'random-app.log'), 'random\n', 'utf8');

    const result = await tailRecentMainLogs({ resolveLogDir: () => tempDir });

    expect(result.content).toBe('rotated\nactive');
    expect(result.filesRead.map((file) => path.basename(file.path))).toEqual([
      'mindstone-rebel.log',
      'mindstone-rebel.1.log',
    ]);
    expect(result.content).not.toContain('tmp');
    expect(result.content).not.toContain('backup');
    expect(result.content).not.toContain('gz');
    expect(result.content).not.toContain('random');
  });

  it('caps a single file at the last 2 MiB before soft response caps', async () => {
    const prefix = 'older-prefix';
    const tail = 't'.repeat(MAX_TAIL_BYTES_PER_FILE);
    await fs.writeFile(path.join(tempDir, 'mindstone-rebel.log'), `${prefix}${tail}`, 'utf8');

    const result = await tailRecentMainLogs({
      resolveLogDir: () => tempDir,
      maxBytes: MAX_TOTAL_TAIL_BYTES,
      maxLines: MAX_RECENT_LOGS_LINES,
    });

    expect(result.bytesReturned).toBe(MAX_TAIL_BYTES_PER_FILE);
    expect(result.content).toBe(tail);
    expect(result.content).not.toContain(prefix);
    expect(result.truncated).toBe(true);
  });

  it('enforces the 4 MiB global budget newest-first', async () => {
    const size = 1.5 * 1024 * 1024;
    for (let index = 0; index < 5; index += 1) {
      const char = String.fromCharCode('A'.charCodeAt(0) + index);
      const logFilePath = path.join(tempDir, `mindstone-rebel.${index + 1}.log`);
      await fs.writeFile(
        logFilePath,
        char.repeat(size),
        'utf8',
      );
      await setMtime(logFilePath, index + 1);
    }

    const result = await tailRecentMainLogs({
      resolveLogDir: () => tempDir,
      maxBytes: MAX_TOTAL_TAIL_BYTES,
      maxLines: MAX_RECENT_LOGS_LINES,
    });

    expect(result.bytesReturned).toBeLessThanOrEqual(MAX_TOTAL_TAIL_BYTES);
    expect(result.filesRead.map((file) => file.bytesRead)).toEqual([
      size,
      size,
      MAX_TOTAL_TAIL_BYTES - size * 2,
    ]);
    expect(result.content).toContain('E');
    expect(result.content).toContain('D');
    expect(result.content).toContain('C');
    expect(result.content).not.toContain('B');
    expect(result.content).not.toContain('A');
    expect(result.truncated).toBe(true);
  });

  it('uses the 256 KiB soft default and honors smaller maxBytes overrides', async () => {
    const content = 's'.repeat(100 * 1024);
    await fs.writeFile(path.join(tempDir, 'mindstone-rebel.log'), content, 'utf8');

    const defaultResult = await tailRecentMainLogs({ resolveLogDir: () => tempDir });
    expect(defaultResult.bytesReturned).toBe(100 * 1024);
    expect(defaultResult.bytesReturned).toBeLessThan(DEFAULT_RECENT_LOGS_BYTES);
    expect(defaultResult.truncated).toBe(false);

    const cappedResult = await tailRecentMainLogs({
      resolveLogDir: () => tempDir,
      maxBytes: 1024,
    });
    expect(cappedResult.bytesReturned).toBeLessThanOrEqual(1024);
    expect(cappedResult.content).toBe(content.slice(-1024));
    expect(cappedResult.truncated).toBe(true);
    expect(cappedResult.bytesAvailable).toBeGreaterThan(cappedResult.bytesReturned);
  });

  it('clamps maxBytes overrides to the supported byte range', async () => {
    await fs.writeFile(path.join(tempDir, 'mindstone-rebel.log'), 'b'.repeat(10 * 1024), 'utf8');

    const minResult = await tailRecentMainLogs({
      resolveLogDir: () => tempDir,
      maxBytes: 0,
    });
    expect(minResult.bytesReturned).toBe(MIN_RECENT_LOGS_BYTES);

    await fs.writeFile(path.join(tempDir, 'mindstone-rebel.log'), 'm'.repeat(5 * 1024 * 1024), 'utf8');
    const maxResult = await tailRecentMainLogs({
      resolveLogDir: () => tempDir,
      maxBytes: 999_999_999,
      maxLines: MAX_RECENT_LOGS_LINES,
    });
    expect(maxResult.bytesReturned).toBeLessThanOrEqual(MAX_TOTAL_TAIL_BYTES);
  });

  it('defaults maxLines on zero and clamps large maxLines to the maximum', async () => {
    const lines = makeLines('line', 2500);
    await writeLogFile('mindstone-rebel.log', lines);

    const defaultResult = await tailRecentMainLogs({
      resolveLogDir: () => tempDir,
      maxLines: 0,
      maxBytes: MAX_TOTAL_TAIL_BYTES,
    });
    expect(defaultResult.lines).toBe(DEFAULT_RECENT_LOGS_LINES);
    expect(defaultResult.content).toBe(lines.slice(-DEFAULT_RECENT_LOGS_LINES).join('\n'));

    const maxResult = await tailRecentMainLogs({
      resolveLogDir: () => tempDir,
      maxLines: 9999,
      maxBytes: MAX_TOTAL_TAIL_BYTES,
    });
    expect(maxResult.lines).toBe(MAX_RECENT_LOGS_LINES);
    expect(maxResult.content).toBe(lines.slice(-MAX_RECENT_LOGS_LINES).join('\n'));
  });

  it('continues when a rotated file disappears between stat and open', async () => {
    await writeLogFile('mindstone-rebel.log', ['current'], 2);
    await writeLogFile('mindstone-rebel.1.log', ['rotated'], 1);
    const fsLike: FsLike = {
      readdir: (dir) => fs.readdir(dir),
      stat: (filePath) => fs.stat(filePath),
      open: async (filePath, flags) => {
        if (filePath.endsWith('mindstone-rebel.1.log')) {
          const err = new Error('rotated away') as NodeJS.ErrnoException;
          err.code = 'ENOENT';
          throw err;
        }
        return fs.open(filePath, flags);
      },
    };

    const result = await tailRecentMainLogs({
      resolveLogDir: () => tempDir,
      fs: fsLike,
    });

    expect(result.content).toBe('current');
    expect(result.errors).toEqual([
      { path: path.join(tempDir, 'mindstone-rebel.1.log'), reason: 'ENOENT' },
    ]);
  });

  it('excludes per-turn session logs', async () => {
    await fs.mkdir(path.join(tempDir, 'sessions'), { recursive: true });
    await fs.writeFile(path.join(tempDir, 'sessions', 'per-turn-1.log'), 'session-only\n', 'utf8');
    await writeLogFile('mindstone-rebel.log', ['main-only']);

    const result = await tailRecentMainLogs({ resolveLogDir: () => tempDir });

    expect(result.content).toBe('main-only');
    expect(result.content).not.toContain('session-only');
  });

  it('preserves multi-byte UTF-8 content', async () => {
    const lines = ['plain', 'emoji 🚀', 'accent café'];
    await writeLogFile('mindstone-rebel.log', lines);

    const result = await tailRecentMainLogs({ resolveLogDir: () => tempDir });

    expect(result.content).toBe(lines.join('\n'));
    expect(result.bytesReturned).toBe(Buffer.byteLength(lines.join('\n'), 'utf8'));
  });

  it('truncates multi-byte UTF-8 content on character boundaries (no replacement chars)', async () => {
    // MIN_RECENT_LOGS_BYTES is 1024, so content must exceed that to trigger truncation.
    const line = '🚀'.repeat(500); // 500 × 4 bytes = 2000 bytes
    await writeLogFile('mindstone-rebel.log', [line]);

    const result = await tailRecentMainLogs({
      resolveLogDir: () => tempDir,
      maxBytes: 1024,
    });

    expect(result.truncated).toBe(true);
    expect(result.bytesReturned).toBeLessThanOrEqual(1024);
    expect(result.content).not.toContain('\uFFFD');
    expect(result.content.length).toBeGreaterThan(0);
  });

  it('trims a 100 KiB single-line file to maxBytes in linear time (260507 quadratic regression guard)', async () => {
    // Pre-fix this took ~25s due to an O(n^2) codepoint shift+join+byteLength loop.
    // Linear accounting completes in single-digit ms; assert <1s with generous CI headroom.
    const content = 's'.repeat(100 * 1024);
    await fs.writeFile(path.join(tempDir, 'mindstone-rebel.log'), content, 'utf8');

    const start = Date.now();
    const result = await tailRecentMainLogs({
      resolveLogDir: () => tempDir,
      maxBytes: 1024,
    });
    const elapsed = Date.now() - start;

    expect(result.bytesReturned).toBeLessThanOrEqual(1024);
    expect(result.content).toBe(content.slice(-1024));
    expect(result.truncated).toBe(true);
    expect(elapsed).toBeLessThan(1000);
  });
});

async function writeLogFile(name: string, lines: readonly string[], mtimeOrder = 1): Promise<void> {
  const filePath = path.join(tempDir, name);
  await fs.writeFile(filePath, `${lines.join('\n')}\n`, 'utf8');
  await setMtime(filePath, mtimeOrder);
}

async function setMtime(filePath: string, order: number): Promise<void> {
  const date = new Date(1_700_000_000_000 + order * 1000);
  await fs.utimes(filePath, date, date);
}

function makeLines(prefix: string, count: number): string[] {
  return Array.from({ length: count }, (_value, index) => `${prefix}-${index + 1}`);
}
