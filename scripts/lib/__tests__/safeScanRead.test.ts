import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { readFileToleratingVanished } from '../safeScanRead.js';

// ESM module namespaces are non-configurable, so `vi.spyOn(fs, 'readFileSync')`
// cannot redefine the property. To deterministically simulate a coded read
// error (ENOENT / EACCES) without relying on real-filesystem timing or
// permission tricks, mock `node:fs` with a `readFileSync` that delegates to a
// per-test hook. Every other fs symbol stays the real one (importActual), so
// real file reads in the "normal file" test still work.
let readFileSyncHook: ((p: string) => void) | null = null;

vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
  return {
    ...actual,
    readFileSync: ((p: any, ...rest: any[]): any => {
      if (readFileSyncHook && typeof p === 'string') {
        readFileSyncHook(p); // may throw (ENOENT / EACCES) to simulate the race
      }
      return (actual.readFileSync as any)(p, ...rest);
    }) as typeof actual.readFileSync,
  };
});

function codedError(code: string): NodeJS.ErrnoException {
  const err = new Error(`${code}: simulated`) as NodeJS.ErrnoException;
  err.code = code;
  return err;
}

afterEach(() => {
  readFileSyncHook = null;
});

describe('readFileToleratingVanished', () => {
  it('returns null when the read fails with ENOENT (file vanished mid-scan)', () => {
    readFileSyncHook = () => {
      throw codedError('ENOENT');
    };
    expect(readFileToleratingVanished('/any/path/that/vanished.ts')).toBeNull();
  });

  it('returns null for a path that genuinely does not exist (real ENOENT)', () => {
    const missing = path.join(os.tmpdir(), `safe-scan-read-missing-${Date.now()}-${Math.random()}.txt`);
    expect(readFileToleratingVanished(missing)).toBeNull();
  });

  it('rethrows a non-ENOENT coded error (EACCES) — present-but-unreadable stays fail-closed', () => {
    readFileSyncHook = () => {
      throw codedError('EACCES');
    };
    expect(() => readFileToleratingVanished('/present/but/unreadable.ts')).toThrow(/EACCES/);
  });

  it('rethrows the original error object unchanged (preserves the code)', () => {
    const original = codedError('EBUSY');
    readFileSyncHook = () => {
      throw original;
    };
    try {
      readFileToleratingVanished('/present/but/busy.ts');
      expect.unreachable('expected readFileToleratingVanished to throw');
    } catch (err) {
      expect(err).toBe(original);
      expect((err as NodeJS.ErrnoException).code).toBe('EBUSY');
    }
  });

  it('returns the contents of a normal, readable file', () => {
    const tmp = path.join(os.tmpdir(), `safe-scan-read-ok-${Date.now()}-${Math.random()}.txt`);
    const contents = 'hello\nworld\n';
    fs.writeFileSync(tmp, contents, 'utf8');
    try {
      expect(readFileToleratingVanished(tmp)).toBe(contents);
    } finally {
      fs.rmSync(tmp, { force: true });
    }
  });
});
