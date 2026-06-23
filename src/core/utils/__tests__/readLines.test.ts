import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { readFileLines, STOP_READING_FILE_LINES } from '../readLines';

const tmpDirs: string[] = [];

async function makeTempDir(): Promise<string> {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'read-lines-test-'));
  tmpDirs.push(dir);
  return dir;
}

function countOpenFds(): number | null {
  if (process.platform === 'win32') return null;
  try {
    return fs.readdirSync('/dev/fd').length;
  } catch {
    return null;
  }
}

afterEach(async () => {
  await Promise.all(tmpDirs.splice(0).map((dir) => fsp.rm(dir, { recursive: true, force: true })));
});

describe('readFileLines', () => {
  it('reads all lines and passes line numbers on normal EOF', async () => {
    const tmpDir = await makeTempDir();
    const filePath = path.join(tmpDir, 'normal.txt');
    await fsp.writeFile(filePath, 'alpha\nbeta\ngamma\n', 'utf8');

    const seen: Array<{ line: string; lineNumber: number }> = [];
    await readFileLines(filePath, (line, lineNumber) => {
      seen.push({ line, lineNumber });
    });

    expect(seen).toEqual([
      { line: 'alpha', lineNumber: 1 },
      { line: 'beta', lineNumber: 2 },
      { line: 'gamma', lineNumber: 3 },
    ]);
  });

  it('supports early exit without leaking file descriptors', async () => {
    const beforeFds = countOpenFds();
    if (beforeFds == null) {
      return;
    }

    const tmpDir = await makeTempDir();
    const filePath = path.join(tmpDir, 'early-exit.txt');
    await fsp.writeFile(filePath, `${Array.from({ length: 400 }, (_, i) => `line-${i}`).join('\n')}\n`, 'utf8');

    let seenCount = 0;
    await readFileLines(filePath, () => {
      seenCount += 1;
      return STOP_READING_FILE_LINES;
    });

    expect(seenCount).toBe(1);

    const afterFds = countOpenFds();
    if (afterFds == null) {
      return;
    }

    expect(afterFds - beforeFds).toBeLessThanOrEqual(3);
  });

  it('destroys resources when line processing throws', async () => {
    const beforeFds = countOpenFds();
    if (beforeFds == null) {
      return;
    }

    const tmpDir = await makeTempDir();
    const filePath = path.join(tmpDir, 'throws.txt');
    await fsp.writeFile(filePath, 'line-one\nline-two\n', 'utf8');

    await expect(
      readFileLines(filePath, () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');

    const afterFds = countOpenFds();
    if (afterFds == null) {
      return;
    }

    expect(afterFds - beforeFds).toBeLessThanOrEqual(3);
  });
});
