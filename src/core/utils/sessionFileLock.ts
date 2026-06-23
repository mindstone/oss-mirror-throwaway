import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { OwnerKind } from '@core/services/superMcpOwnerRegistry';

export interface LockAcquireOptions {
  pid: number;
  startedAt: number;
  ownerKind: OwnerKind;
  maxRetryMs?: number;
  staleLockMinAgeMs?: number;
}

export interface SessionLockHandle {
  release(): Promise<void>;
}

export interface SyncSessionLockHandle {
  release(): void;
}

export interface SessionLockManager {
  acquirePerSession(sessionId: string, opts: LockAcquireOptions): Promise<SessionLockHandle>;
  acquireGlobalIndex(opts: LockAcquireOptions): Promise<SessionLockHandle>;
  acquirePerSessionSync(sessionId: string, opts: LockAcquireOptions): SyncSessionLockHandle;
  acquireGlobalIndexSync(opts: LockAcquireOptions): SyncSessionLockHandle;
}

type LockPayload = Pick<LockAcquireOptions, 'pid' | 'startedAt' | 'ownerKind'>;

export class LockAcquireTimeout extends Error {
  readonly lockPath: string;
  readonly existingPid: number | undefined;
  readonly ageMs: number | undefined;

  constructor(args: { lockPath: string; existingPid?: number; ageMs?: number }) {
    super(
      `Timed out acquiring session lock ${args.lockPath}`
      + (args.existingPid !== undefined ? ` held by pid ${args.existingPid}` : '')
      + (args.ageMs !== undefined ? ` (age ${args.ageMs}ms)` : ''),
    );
    this.name = 'LockAcquireTimeout';
    this.lockPath = args.lockPath;
    this.existingPid = args.existingPid;
    this.ageMs = args.ageMs;
  }
}

export function defaultIsProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ESRCH') return false;
    if (code === 'EPERM' || code === 'EACCES') return true;
    return true;
  }
}

export function getSessionLockFileName(sessionId: string): string {
  return `${createHash('sha256').update(sessionId).digest('hex').slice(0, 16)}.lock`;
}

export function createSessionLockManager(deps: {
  locksDirectory: string;
  isProcessAlive: (pid: number) => boolean;
  now: () => number;
}): SessionLockManager {
  const ensureDirectory = async (): Promise<void> => {
    await fs.promises.mkdir(deps.locksDirectory, { recursive: true, mode: 0o700 });
    await fs.promises.chmod(deps.locksDirectory, 0o700).catch(() => undefined);
  };

  const acquire = async (
    lockPath: string,
    opts: LockAcquireOptions,
  ): Promise<SessionLockHandle> => {
    await ensureDirectory();
    const startedAt = deps.now();
    const maxRetryMs = opts.maxRetryMs ?? 200;
    const staleLockMinAgeMs = opts.staleLockMinAgeMs ?? 60_000;
    let lastExisting: LockPayload | null = null;

    while (deps.now() - startedAt <= maxRetryMs) {
      const payload: LockPayload = {
        pid: opts.pid,
        startedAt: opts.startedAt,
        ownerKind: opts.ownerKind,
      };

      try {
        const handle = await fs.promises.open(lockPath, lockOpenFlags(), 0o600);
        try {
          await handle.writeFile(JSON.stringify(payload), 'utf8');
          await handle.chmod(0o600).catch(() => undefined);
        } catch (err) {
          await handle.close().catch(() => undefined);
          await fs.promises.unlink(lockPath).catch(() => undefined);
          throw err;
        }
        await handle.close();
        return {
          release: async () => {
            await releaseIfOwned(lockPath, payload);
          },
        };
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code !== 'EEXIST') {
          throw err;
        }

        lastExisting = await readLockPayload(lockPath);
        if (lastExisting) {
          const ageMs = deps.now() - lastExisting.startedAt;
          if (ageMs >= staleLockMinAgeMs && !safeIsProcessAlive(deps.isProcessAlive, lastExisting.pid)) {
            await fs.promises.unlink(lockPath).catch((unlinkErr) => {
              if ((unlinkErr as NodeJS.ErrnoException).code !== 'ENOENT') throw unlinkErr;
            });
            continue;
          }
        }

        await delay(randomJitterMs());
      }
    }

    throw new LockAcquireTimeout({
      lockPath,
      existingPid: lastExisting?.pid,
      ageMs: lastExisting ? deps.now() - lastExisting.startedAt : undefined,
    });
  };

  const ensureDirectorySync = (): void => {
    fs.mkdirSync(deps.locksDirectory, { recursive: true, mode: 0o700 });
    try {
      fs.chmodSync(deps.locksDirectory, 0o700);
    } catch {
      // Best-effort permission hardening; unsupported filesystems should not block locking.
    }
  };

  const acquireSync = (
    lockPath: string,
    opts: LockAcquireOptions,
  ): SyncSessionLockHandle => {
    ensureDirectorySync();
    const startedAt = deps.now();
    const maxRetryMs = opts.maxRetryMs ?? 200;
    const staleLockMinAgeMs = opts.staleLockMinAgeMs ?? 60_000;
    let lastExisting: LockPayload | null = null;

    while (deps.now() - startedAt <= maxRetryMs) {
      const payload: LockPayload = {
        pid: opts.pid,
        startedAt: opts.startedAt,
        ownerKind: opts.ownerKind,
      };

      try {
        const fd = fs.openSync(lockPath, lockOpenFlags(), 0o600);
        try {
          fs.writeFileSync(fd, JSON.stringify(payload), 'utf8');
          try {
            fs.fchmodSync(fd, 0o600);
          } catch {
            // Best-effort permission hardening; unsupported filesystems should not block locking.
          }
        } catch (err) {
          try {
            fs.closeSync(fd);
          } catch {
            // Ignore close failure while preserving the original write error.
          }
          try {
            fs.unlinkSync(lockPath);
          } catch (unlinkErr) {
            if ((unlinkErr as NodeJS.ErrnoException).code !== 'ENOENT') throw unlinkErr;
          }
          throw err;
        }
        fs.closeSync(fd);
        return {
          release: () => {
            releaseIfOwnedSync(lockPath, payload);
          },
        };
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code !== 'EEXIST') {
          throw err;
        }

        lastExisting = readLockPayloadSync(lockPath);
        if (lastExisting) {
          const ageMs = deps.now() - lastExisting.startedAt;
          if (ageMs >= staleLockMinAgeMs && !safeIsProcessAlive(deps.isProcessAlive, lastExisting.pid)) {
            try {
              fs.unlinkSync(lockPath);
            } catch (unlinkErr) {
              if ((unlinkErr as NodeJS.ErrnoException).code !== 'ENOENT') throw unlinkErr;
            }
            continue;
          }
        }

        sleepSync(randomJitterMs());
      }
    }

    throw new LockAcquireTimeout({
      lockPath,
      existingPid: lastExisting?.pid,
      ageMs: lastExisting ? deps.now() - lastExisting.startedAt : undefined,
    });
  };

  return {
    acquirePerSession: (sessionId, opts) =>
      acquire(path.join(deps.locksDirectory, getSessionLockFileName(sessionId)), opts),
    acquireGlobalIndex: (opts) => acquire(path.join(deps.locksDirectory, 'index.lock'), opts),
    acquirePerSessionSync: (sessionId, opts) =>
      acquireSync(path.join(deps.locksDirectory, getSessionLockFileName(sessionId)), opts),
    acquireGlobalIndexSync: (opts) => acquireSync(path.join(deps.locksDirectory, 'index.lock'), opts),
  };
}

function lockOpenFlags(): number {
  let flags = fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY;
  if (process.platform !== 'win32' && typeof fs.constants.O_NOFOLLOW === 'number') {
    flags |= fs.constants.O_NOFOLLOW;
  }
  return flags;
}

async function readLockPayload(lockPath: string): Promise<LockPayload | null> {
  try {
    const raw = await fs.promises.readFile(lockPath, 'utf8');
    const parsed = JSON.parse(raw) as Partial<LockPayload>;
    if (
      typeof parsed.pid === 'number'
      && typeof parsed.startedAt === 'number'
      && typeof parsed.ownerKind === 'string'
    ) {
      return {
        pid: parsed.pid,
        startedAt: parsed.startedAt,
        ownerKind: parsed.ownerKind as LockPayload['ownerKind'],
      };
    }
  } catch {
    return null;
  }
  return null;
}

async function releaseIfOwned(lockPath: string, payload: LockPayload): Promise<void> {
  const current = await readLockPayload(lockPath);
  if (
    current
    && current.pid === payload.pid
    && current.startedAt === payload.startedAt
    && current.ownerKind === payload.ownerKind
  ) {
    await fs.promises.unlink(lockPath).catch((err) => {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    });
  }
}

function readLockPayloadSync(lockPath: string): LockPayload | null {
  try {
    const raw = fs.readFileSync(lockPath, 'utf8');
    const parsed = JSON.parse(raw) as Partial<LockPayload>;
    if (
      typeof parsed.pid === 'number'
      && typeof parsed.startedAt === 'number'
      && typeof parsed.ownerKind === 'string'
    ) {
      return {
        pid: parsed.pid,
        startedAt: parsed.startedAt,
        ownerKind: parsed.ownerKind as LockPayload['ownerKind'],
      };
    }
  } catch {
    return null;
  }
  return null;
}

function releaseIfOwnedSync(lockPath: string, payload: LockPayload): void {
  const current = readLockPayloadSync(lockPath);
  if (
    current
    && current.pid === payload.pid
    && current.startedAt === payload.startedAt
    && current.ownerKind === payload.ownerKind
  ) {
    try {
      fs.unlinkSync(lockPath);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
  }
}

function safeIsProcessAlive(isProcessAlive: (pid: number) => boolean, pid: number): boolean {
  try {
    return isProcessAlive(pid);
  } catch {
    return true;
  }
}

function randomJitterMs(): number {
  return 5 + Math.floor(Math.random() * 16);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function sleepSync(ms: number): void {
  const signal = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(signal, 0, 0, ms);
}
