import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mintLeaseOwnerIdentity } from '@core/setCrossProcessLease';
import { DesktopFileLockLease } from '../crossProcessLeaseImpl';

type LockPayload = {
  pid: number;
  epochMs: number;
  nonce?: string;
};

const TEST_SCOPE = 'refresh:google:GoogleWorkspace-alpha';

function lockFilePathForScope(lockRootPath: string, scope: string): string {
  const [, provider = 'unknown', ...rest] = scope.split(':');
  const accountKey = rest.length > 0 ? rest.join(':') : scope;
  const accountHash = createHash('sha256').update(accountKey).digest('hex').slice(0, 16);
  return path.join(lockRootPath, `${provider}__${accountHash}.lock`);
}

async function readLockPayload(lockRootPath: string, scope: string): Promise<LockPayload | null> {
  const lockPath = lockFilePathForScope(lockRootPath, scope);
  try {
    const raw = await fs.readFile(lockPath, 'utf8');
    return JSON.parse(raw) as LockPayload;
  } catch (error) {
    if ((error as NodeJS.ErrnoException | null)?.code === 'ENOENT') {
      return null;
    }
    throw error;
  }
}

describe('DesktopFileLockLease', () => {
  let lockRootPath = '';

  beforeEach(async () => {
    lockRootPath = await fs.mkdtemp(path.join(os.tmpdir(), 'cross-process-lease-'));
  });

  afterEach(async () => {
    await fs.rm(lockRootPath, { recursive: true, force: true });
  });

  it('release() does not unlink a successor lock when lock ownership changed', async () => {
    const leaseA = new DesktopFileLockLease({
      lockRootPath,
      now: () => 1_000,
      pid: 1111,
      nonceFactory: () => 'nonce-a',
      isPidAlive: () => true,
    });
    const leaseB = new DesktopFileLockLease({
      lockRootPath,
      now: () => 80_000,
      pid: 2222,
      nonceFactory: () => 'nonce-b',
      isPidAlive: () => true,
    });

    const handleA = await leaseA.acquire(TEST_SCOPE, 10_000);
    expect(handleA).not.toBeNull();
    const handleB = await leaseB.acquire(TEST_SCOPE, 10_000);
    expect(handleB).not.toBeNull();

    if (!handleA) throw new Error('Expected handleA');
    await leaseA.release(handleA);

    await expect(readLockPayload(lockRootPath, TEST_SCOPE)).resolves.toEqual({
      pid: 2222,
      epochMs: 80_000,
      nonce: 'nonce-b',
    });
  });

  it('release() unlinks lock when identity matches pid + epoch + nonce', async () => {
    const lease = new DesktopFileLockLease({
      lockRootPath,
      now: () => 5_000,
      pid: 3333,
      nonceFactory: () => 'nonce-match',
      isPidAlive: () => true,
    });

    const handle = await lease.acquire(TEST_SCOPE, 5_000);
    expect(handle).not.toBeNull();
    if (!handle) throw new Error('Expected lease handle');

    await lease.release(handle);
    await expect(readLockPayload(lockRootPath, TEST_SCOPE)).resolves.toBeNull();
  });

  it('stale reclaim does not unlink a concurrently-written successor lock', async () => {
    const lockPath = lockFilePathForScope(lockRootPath, TEST_SCOPE);
    await fs.mkdir(lockRootPath, { recursive: true });
    await fs.writeFile(lockPath, JSON.stringify({
      pid: 7777,
      epochMs: 1_000,
      nonce: 'stale-lock',
    }), 'utf8');

    let swappedToSuccessor = false;
    const lease = new DesktopFileLockLease({
      lockRootPath,
      now: () => 70_000,
      pid: 4444,
      nonceFactory: () => 'candidate-lock',
      isPidAlive: () => {
        if (!swappedToSuccessor) {
          swappedToSuccessor = true;
          writeFileSync(lockPath, JSON.stringify({
            pid: 8888,
            epochMs: 70_000,
            nonce: 'successor-lock',
          }), 'utf8');
          return false;
        }
        return true;
      },
    });

    await expect(lease.acquire(TEST_SCOPE, 5_000)).resolves.toBeNull();
    await expect(readLockPayload(lockRootPath, TEST_SCOPE)).resolves.toEqual({
      pid: 8888,
      epochMs: 70_000,
      nonce: 'successor-lock',
    });
  });

  it('acquire() returns null when a fresh lock already exists', async () => {
    const lockPath = lockFilePathForScope(lockRootPath, TEST_SCOPE);
    await fs.mkdir(lockRootPath, { recursive: true });
    await fs.writeFile(lockPath, JSON.stringify({
      pid: 9999,
      epochMs: 10_000,
      nonce: 'fresh-lock',
    }), 'utf8');

    const lease = new DesktopFileLockLease({
      lockRootPath,
      now: () => 20_000,
      pid: 1010,
      nonceFactory: () => 'unused',
      isPidAlive: () => true,
    });

    await expect(lease.acquire(TEST_SCOPE, 5_000)).resolves.toBeNull();
    await expect(readLockPayload(lockRootPath, TEST_SCOPE)).resolves.toEqual({
      pid: 9999,
      epochMs: 10_000,
      nonce: 'fresh-lock',
    });
  });

  it.each([
    {
      name: 'pid is no longer alive',
      initial: { pid: 1212, epochMs: 55_000, nonce: 'dead-pid' },
      nowMs: 55_500,
      isPidAlive: () => false,
    },
    {
      name: 'lock age exceeds stale threshold',
      initial: { pid: 1313, epochMs: 1_000, nonce: 'old-epoch' },
      nowMs: 70_000,
      isPidAlive: () => true,
    },
  ])('acquire() succeeds when prior lock is stale because $name', async ({ initial, nowMs, isPidAlive }) => {
    const lockPath = lockFilePathForScope(lockRootPath, TEST_SCOPE);
    await fs.mkdir(lockRootPath, { recursive: true });
    await fs.writeFile(lockPath, JSON.stringify(initial), 'utf8');

    const lease = new DesktopFileLockLease({
      lockRootPath,
      now: () => nowMs,
      pid: 1414,
      nonceFactory: () => `new-${nowMs}`,
      isPidAlive,
    });

    const handle = await lease.acquire(TEST_SCOPE, 5_000);
    expect(handle).not.toBeNull();
    // Ownership identity is opaque on the handle — assert via the minted
    // identity rather than reaching into pid/epochMs/nonce siblings (rec #35).
    expect(handle?.owner).toBe(
      mintLeaseOwnerIdentity({ pid: 1414, epochMs: nowMs, nonce: `new-${nowMs}` }),
    );
  });

  it('release() proves ownership via the opaque handle identity, not scope alone', async () => {
    // A handle whose opaque owner identity matches the on-disk lock releases
    // it; a same-scope handle minted with a different owner identity does not.
    const lease = new DesktopFileLockLease({
      lockRootPath,
      now: () => 5_000,
      pid: 3333,
      nonceFactory: () => 'nonce-real',
      isPidAlive: () => true,
    });

    const handle = await lease.acquire(TEST_SCOPE, 5_000);
    expect(handle).not.toBeNull();
    if (!handle) throw new Error('Expected lease handle');

    // Forged handle: same scope, different owner identity. Must not unlink.
    const forged = {
      ...handle,
      owner: mintLeaseOwnerIdentity({ pid: 3333, epochMs: 5_000, nonce: 'nonce-forged' }),
    };
    await lease.release(forged);
    await expect(readLockPayload(lockRootPath, TEST_SCOPE)).resolves.not.toBeNull();

    // Genuine handle releases the lock.
    await lease.release(handle);
    await expect(readLockPayload(lockRootPath, TEST_SCOPE)).resolves.toBeNull();
  });
});
