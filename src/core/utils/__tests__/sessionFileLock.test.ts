import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  LockAcquireTimeout,
  createSessionLockManager,
  defaultIsProcessAlive,
  getSessionLockFileName,
} from '../sessionFileLock';

describe('sessionFileLock', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'session-file-lock-'));
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it('acquires and releases a per-session lock', async () => {
    const manager = createSessionLockManager({
      locksDirectory: tempDir,
      isProcessAlive: () => true,
      now: Date.now,
    });

    const handle = await manager.acquirePerSession('session-1', {
      pid: 123,
      startedAt: Date.now(),
      ownerKind: 'cli',
    });

    const lockPath = path.join(tempDir, getSessionLockFileName('session-1'));
    await expect(fs.stat(lockPath)).resolves.toMatchObject({ mode: expect.any(Number) });
    await handle.release();
    await expect(fs.stat(lockPath)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('retries while a lock is held, then acquires after release', async () => {
    const manager = createSessionLockManager({
      locksDirectory: tempDir,
      isProcessAlive: () => true,
      now: Date.now,
    });
    const first = await manager.acquirePerSession('session-2', {
      pid: 1,
      startedAt: Date.now(),
      ownerKind: 'cli',
    });

    const secondPromise = manager.acquirePerSession('session-2', {
      pid: 2,
      startedAt: Date.now(),
      ownerKind: 'cli',
      maxRetryMs: 500,
    });
    setTimeout(() => void first.release(), 25);
    const second = await secondPromise;
    await second.release();
  });

  it('reclaims an old lock when the owning process is definitely dead', async () => {
    const lockPath = path.join(tempDir, getSessionLockFileName('stale-session'));
    await fs.mkdir(tempDir, { recursive: true });
    await fs.writeFile(lockPath, JSON.stringify({
      pid: 99_999,
      startedAt: Date.now() - 120_000,
      ownerKind: 'cli',
    }));

    const manager = createSessionLockManager({
      locksDirectory: tempDir,
      isProcessAlive: () => false,
      now: Date.now,
    });

    const handle = await manager.acquirePerSession('stale-session', {
      pid: 123,
      startedAt: Date.now(),
      ownerKind: 'cli',
    });
    await handle.release();
  });

  it('default liveness returns false for ESRCH and true for EPERM/EACCES', () => {
    const kill = vi.spyOn(process, 'kill');
    kill.mockImplementationOnce(() => {
      throw Object.assign(new Error('missing'), { code: 'ESRCH' });
    });
    expect(defaultIsProcessAlive(123)).toBe(false);
    kill.mockImplementationOnce(() => {
      throw Object.assign(new Error('permission'), { code: 'EPERM' });
    });
    expect(defaultIsProcessAlive(123)).toBe(true);
    kill.mockImplementationOnce(() => {
      throw Object.assign(new Error('access'), { code: 'EACCES' });
    });
    expect(defaultIsProcessAlive(123)).toBe(true);
  });

  it('does not reclaim EPERM locks', async () => {
    const lockPath = path.join(tempDir, getSessionLockFileName('eperm-session'));
    await fs.mkdir(tempDir, { recursive: true });
    await fs.writeFile(lockPath, JSON.stringify({
      pid: 123,
      startedAt: Date.now() - 120_000,
      ownerKind: 'desktop',
    }));
    vi.spyOn(process, 'kill').mockImplementation(() => {
      throw Object.assign(new Error('permission'), { code: 'EPERM' });
    });

    const manager = createSessionLockManager({
      locksDirectory: tempDir,
      isProcessAlive: defaultIsProcessAlive,
      now: Date.now,
    });

    await expect(manager.acquirePerSession('eperm-session', {
      pid: 456,
      startedAt: Date.now(),
      ownerKind: 'cli',
      maxRetryMs: 20,
    })).rejects.toBeInstanceOf(LockAcquireTimeout);
    await expect(fs.stat(lockPath)).resolves.toBeDefined();
  });

  it('does not reclaim young locks even when the PID is dead', async () => {
    const lockPath = path.join(tempDir, getSessionLockFileName('young-session'));
    await fs.mkdir(tempDir, { recursive: true });
    await fs.writeFile(lockPath, JSON.stringify({
      pid: 123,
      startedAt: Date.now(),
      ownerKind: 'cli',
    }));
    const manager = createSessionLockManager({
      locksDirectory: tempDir,
      isProcessAlive: () => false,
      now: Date.now,
    });

    await expect(manager.acquirePerSession('young-session', {
      pid: 456,
      startedAt: Date.now(),
      ownerKind: 'cli',
      maxRetryMs: 20,
    })).rejects.toBeInstanceOf(LockAcquireTimeout);
    await expect(fs.stat(lockPath)).resolves.toBeDefined();
  });

  it('throws a diagnostic timeout when acquisition exceeds maxRetryMs', async () => {
    const manager = createSessionLockManager({
      locksDirectory: tempDir,
      isProcessAlive: () => true,
      now: Date.now,
    });
    const first = await manager.acquireGlobalIndex({
      pid: 1,
      startedAt: Date.now(),
      ownerKind: 'desktop',
    });

    await expect(manager.acquireGlobalIndex({
      pid: 2,
      startedAt: Date.now(),
      ownerKind: 'cli',
      maxRetryMs: 20,
    })).rejects.toMatchObject({
      name: 'LockAcquireTimeout',
      existingPid: 1,
    });
    await first.release();
  });

  it('supports synchronous index lock acquisition for beforeunload saves', async () => {
    const manager = createSessionLockManager({
      locksDirectory: tempDir,
      isProcessAlive: () => true,
      now: Date.now,
    });

    const handle = manager.acquireGlobalIndexSync({
      pid: 123,
      startedAt: Date.now(),
      ownerKind: 'desktop',
    });

    await expect(manager.acquireGlobalIndex({
      pid: 456,
      startedAt: Date.now(),
      ownerKind: 'cli',
      maxRetryMs: 20,
    })).rejects.toBeInstanceOf(LockAcquireTimeout);

    handle.release();

    const next = await manager.acquireGlobalIndex({
      pid: 456,
      startedAt: Date.now(),
      ownerKind: 'cli',
      maxRetryMs: 200,
    });
    await next.release();
  });

  it('uses path.join-compatible hashed filenames', () => {
    const id = 'session/with\\separators';
    const expected = `${createHash('sha256').update(id).digest('hex').slice(0, 16)}.lock`;
    expect(getSessionLockFileName(id)).toBe(expected);
    expect(path.basename(path.join(tempDir, getSessionLockFileName(id)))).toBe(expected);
  });
});
