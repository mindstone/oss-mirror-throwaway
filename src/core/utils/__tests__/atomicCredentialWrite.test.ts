import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { atomicCredentialWrite, sweepStaleTemps } from '@core/utils/atomicCredentialWrite';

describe('atomicCredentialWrite', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'atomic-credential-write-'));
  });

  afterEach(async () => {
    await fsp.rm(tempDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('enforces 0o600 on existing files via post-rename chmod', async () => {
    const targetPath = path.join(tempDir, 'accounts.json');
    await fsp.writeFile(targetPath, JSON.stringify({ accounts: [] }), { encoding: 'utf8' });

    if (process.platform !== 'win32') {
      await fsp.chmod(targetPath, 0o644);
    }

    await atomicCredentialWrite(targetPath, JSON.stringify({ accounts: [{ email: '[external-email]' }] }, null, 2), {
      mode: 0o600,
    });

    if (process.platform !== 'win32') {
      const mode = (await fsp.stat(targetPath)).mode & 0o777;
      expect(mode).toBe(0o600);
    }
  });

  it('surfaces rename failures, leaves original untouched, and cleans temp files', async () => {
    const targetPath = path.join(tempDir, 'accounts.json');
    const originalBody = JSON.stringify({ accounts: [{ email: 'before@example.com' }] }, null, 2);
    await fsp.writeFile(targetPath, originalBody, { encoding: 'utf8' });

    const renameSpy = vi.spyOn(fs, 'renameSync');
    const originalRename = fs.renameSync.bind(fs);
    renameSpy.mockImplementation((oldPath, newPath) => {
      if (String(newPath) === targetPath) {
        const err = new Error('disk full') as NodeJS.ErrnoException;
        err.code = 'ENOSPC';
        throw err;
      }
      return originalRename(oldPath, newPath);
    });

    await expect(
      atomicCredentialWrite(targetPath, JSON.stringify({ accounts: [{ email: 'after@example.com' }] }, null, 2))
    ).rejects.toMatchObject({ code: 'ENOSPC' });

    const afterBody = await fsp.readFile(targetPath, 'utf8');
    expect(afterBody).toBe(originalBody);

    const leftovers = await fsp.readdir(tempDir);
    expect(leftovers.filter((entry) => entry.includes('.tmp.'))).toEqual([]);
  });

  it('fsyncs file contents before rename', async () => {
    const targetPath = path.join(tempDir, 'token.json');
    const fsyncSpy = vi.spyOn(fs, 'fsyncSync');

    await atomicCredentialWrite(targetPath, JSON.stringify({ access_token: 'abc' }, null, 2));

    expect(fsyncSpy).toHaveBeenCalled();
  });

  it('fails closed when a pre-existing symlink occupies the temp path', async () => {
    if (process.platform === 'win32') {
      // Symlink behavior is platform/privilege-dependent on Windows.
      return;
    }

    const targetPath = path.join(tempDir, 'accounts.json');
    const victimPath = path.join(tempDir, 'victim.txt');
    const beforeContents = 'do-not-overwrite';
    await fsp.writeFile(victimPath, beforeContents, 'utf8');

    const randomBytes = Buffer.from('010203040506', 'hex');
    vi.spyOn(crypto, 'randomBytes').mockImplementation(
      ((size: number, callback?: (error: Error | null, buffer: Buffer) => void) => {
        if (callback) {
          callback(null, randomBytes);
          return;
        }
        expect(size).toBe(6);
        return randomBytes;
      }) as typeof crypto.randomBytes,
    );
    const tempPath = `${targetPath}.tmp.${process.pid}.${randomBytes.toString('hex')}`;
    await fsp.symlink(victimPath, tempPath);

    await expect(
      atomicCredentialWrite(targetPath, JSON.stringify({ accounts: [{ email: 'after@example.com' }] }, null, 2)),
    ).rejects.toThrow();

    expect(await fsp.readFile(victimPath, 'utf8')).toBe(beforeContents);
    await expect(fsp.access(targetPath)).rejects.toThrow();
  });

  it('rejects when the target credential path is a pre-existing symlink (CREDENTIAL_SYMLINK_REJECTED)', async () => {
    if (process.platform === 'win32') {
      // Symlink behavior is platform/privilege-dependent on Windows.
      return;
    }

    const targetPath = path.join(tempDir, 'accounts.json');
    const victimPath = path.join(tempDir, 'victim.txt');
    const beforeContents = 'do-not-write-through';
    await fsp.writeFile(victimPath, beforeContents, 'utf8');
    // Make the TARGET itself a symlink (distinct from the temp-path symlink test above).
    await fsp.symlink(victimPath, targetPath);

    await expect(
      atomicCredentialWrite(targetPath, JSON.stringify({ accounts: [{ email: 'after@example.com' }] }, null, 2)),
    ).rejects.toMatchObject({ code: 'CREDENTIAL_SYMLINK_REJECTED' });

    // The symlink victim must be untouched (no write-through).
    expect(await fsp.readFile(victimPath, 'utf8')).toBe(beforeContents);
  });

  it('writes normally when the target does not yet exist (ENOENT target passes the guard)', async () => {
    const targetPath = path.join(tempDir, 'fresh', 'token.json');
    const body = JSON.stringify({ access_token: 'xyz' }, null, 2);

    await atomicCredentialWrite(targetPath, body);

    expect(await fsp.readFile(targetPath, 'utf8')).toBe(body);
  });
});

describe('sweepStaleTemps', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'atomic-credential-sweep-'));
  });

  afterEach(async () => {
    await fsp.rm(tempDir, { recursive: true, force: true });
  });

  it('removes stale .tmp files older than five minutes', async () => {
    const stale = path.join(tempDir, 'accounts.json.tmp.123.stale');
    const fresh = path.join(tempDir, 'accounts.json.tmp.123.fresh');

    await fsp.writeFile(stale, 'stale', 'utf8');
    await fsp.writeFile(fresh, 'fresh', 'utf8');

    const oldDate = new Date(Date.now() - 6 * 60 * 1000);
    await fsp.utimes(stale, oldDate, oldDate);

    await sweepStaleTemps(tempDir);

    await expect(fsp.access(stale)).rejects.toThrow();
    await expect(fsp.access(fresh)).resolves.toBeUndefined();
  });
});
