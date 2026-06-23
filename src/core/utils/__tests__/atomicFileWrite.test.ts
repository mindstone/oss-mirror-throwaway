import { afterEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
 
vi.mock('atomically', async () => {
  const actual = await vi.importActual<typeof import('atomically')>('atomically');
  return {
    ...actual,
    writeFile: vi.fn(actual.writeFile),
    writeFileSync: vi.fn(actual.writeFileSync),
  };
});
import { writeFile as atomicallyWriteFile, writeFileSync as atomicallyWriteFileSync } from 'atomically';
import { atomicWriteFile, atomicWriteFileSync } from '../atomicFileWrite';

const tempDirs: string[] = [];
const atomicallyWriteFileMock = vi.mocked(atomicallyWriteFile);
const atomicallyWriteFileSyncMock = vi.mocked(atomicallyWriteFileSync);

function createTempFilePath(filename: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atomic-file-write-'));
  tempDirs.push(dir);
  return path.join(dir, filename);
}

function createErrnoError(message: string, code: string): NodeJS.ErrnoException {
  const error = new Error(message) as NodeJS.ErrnoException;
  error.code = code;
  return error;
}

describe('atomicFileWrite', () => {
  afterEach(() => {
    vi.clearAllMocks();
    for (const dir of tempDirs.splice(0)) {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {
        // Best-effort temp cleanup for tests.
      }
    }
  });

  it('writes data durably on the happy path', async () => {
    const filePath = createTempFilePath('happy-path.json');
    const payload = JSON.stringify({ ok: true });

    const asyncResult = await atomicWriteFile(filePath, payload);
    expect(asyncResult).toEqual({ durable: true });
    expect(fs.readFileSync(filePath, 'utf8')).toBe(payload);

    const syncPayload = JSON.stringify({ ok: 'sync' });
    const syncResult = atomicWriteFileSync(filePath, syncPayload);
    expect(syncResult).toEqual({ durable: true });
    expect(fs.readFileSync(filePath, 'utf8')).toBe(syncPayload);
  });

  it.each(['ENOSPC', 'EACCES', 'EROFS', 'EPERM', 'EBUSY'])(
    'classifies %s disk errors',
    async (errorCode) => {
      atomicallyWriteFileMock.mockRejectedValueOnce(
        createErrnoError(`${errorCode} failure`, errorCode)
      );

      const result = await atomicWriteFile('/tmp/atomic-write-error.json', 'data');
      expect(result).toEqual({
        durable: false,
        error: `${errorCode} failure`,
        errorCode,
      });
    }
  );

  it('returns errors instead of throwing for async and sync writes', async () => {
    atomicallyWriteFileMock.mockRejectedValueOnce(createErrnoError('disk full', 'ENOSPC'));
    atomicallyWriteFileSyncMock.mockImplementationOnce(() => {
      throw createErrnoError('file busy', 'EBUSY');
    });

    await expect(atomicWriteFile('/tmp/atomic-write-async-error.json', 'data')).resolves.toEqual({
      durable: false,
      error: 'disk full',
      errorCode: 'ENOSPC',
    });

    let syncResult: ReturnType<typeof atomicWriteFileSync> | undefined;
    expect(() => {
      syncResult = atomicWriteFileSync('/tmp/atomic-write-sync-error.json', 'data');
    }).not.toThrow();
    expect(syncResult).toEqual({
      durable: false,
      error: 'file busy',
      errorCode: 'EBUSY',
    });
  });
});
