import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { getDataPath } from '@core/utils/dataPaths';
import type { CrossProcessLease, LeaseHandle } from '@core/setCrossProcessLease';
import { mintLeaseOwnerIdentity, ownerIdentityEquals, parseLeaseOwnerIdentity } from '@core/setCrossProcessLease';

const DEFAULT_STALE_AFTER_MS = 60_000;
const MAX_ACQUIRE_ATTEMPTS = 3;

type LockPayload = {
  pid: number;
  epochMs: number;
  ttlMs: number;
  nonce: string;
};

function hashScope(scope: string): string {
  return createHash('sha256').update(scope).digest('hex').slice(0, 24);
}

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | null)?.code === 'ENOENT';
}

function isPidAlive(pid: number): boolean {
  if (!Number.isFinite(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function safeReadPayload(lockPath: string): Promise<LockPayload | null> {
  try {
    const raw = await fs.readFile(lockPath, 'utf8');
    const parsed = JSON.parse(raw) as Partial<LockPayload>;
    if (
      typeof parsed.pid !== 'number'
      || typeof parsed.epochMs !== 'number'
      || typeof parsed.ttlMs !== 'number'
      || typeof parsed.nonce !== 'string'
    ) {
      return null;
    }
    return {
      pid: parsed.pid,
      epochMs: parsed.epochMs,
      ttlMs: parsed.ttlMs,
      nonce: parsed.nonce,
    };
  } catch (error) {
    if (isMissing(error)) return null;
    return null;
  }
}

export class CloudFileLockLease implements CrossProcessLease {
  private readonly rootPath: string;
  private readonly now: () => number;
  private readonly staleAfterMs: number;

  constructor(options: {
    rootPath?: string;
    now?: () => number;
    staleAfterMs?: number;
  } = {}) {
    this.rootPath = options.rootPath ?? path.join(getDataPath(), '.token-sync-leases');
    this.now = options.now ?? Date.now;
    this.staleAfterMs = options.staleAfterMs ?? DEFAULT_STALE_AFTER_MS;
  }

  async acquire(scope: string, ttlMs: number): Promise<LeaseHandle | null> {
    await fs.mkdir(this.rootPath, { recursive: true });
    const lockPath = this.resolveLockPath(scope);

    for (let attempt = 0; attempt < MAX_ACQUIRE_ATTEMPTS; attempt += 1) {
      const epochMs = this.now();
      const nonce = randomBytes(16).toString('hex');
      const payload: LockPayload = {
        pid: process.pid,
        epochMs,
        ttlMs,
        nonce,
      };

      try {
        const handle = await fs.open(lockPath, 'wx', 0o600);
        try {
          await handle.writeFile(JSON.stringify(payload), 'utf8');
        } finally {
          await handle.close();
        }

        return {
          scope,
          acquiredAtMs: epochMs,
          ttlMs,
          owner: mintLeaseOwnerIdentity({
            pid: payload.pid,
            epochMs: payload.epochMs,
            nonce: payload.nonce,
          }),
        };
      } catch (error) {
        if ((error as NodeJS.ErrnoException | null)?.code !== 'EEXIST') {
          throw error;
        }

        const existing = await safeReadPayload(lockPath);
        if (!existing) {
          await fs.unlink(lockPath).catch(() => undefined);
          continue;
        }

        const expiredByTtl = this.now() - existing.epochMs > existing.ttlMs;
        const expiredByStale = this.now() - existing.epochMs > this.staleAfterMs;
        const stale = expiredByTtl || expiredByStale || !isPidAlive(existing.pid);
        if (!stale) {
          return null;
        }

        await fs.unlink(lockPath).catch(() => undefined);
      }
    }

    return null;
  }

  async release(handle: LeaseHandle): Promise<void> {
    const lockPath = this.resolveLockPath(handle.scope);
    const existing = await safeReadPayload(lockPath);
    if (!existing) return;

    // Ownership is proven by comparing opaque identities — release cannot
    // derive ownership from `scope` alone.
    const existingOwner = parseLeaseOwnerIdentity({
      pid: existing.pid,
      epochMs: existing.epochMs,
      nonce: existing.nonce,
    });
    if (!ownerIdentityEquals(existingOwner, handle.owner)) {
      return;
    }

    await fs.unlink(lockPath).catch((error) => {
      if (!isMissing(error)) {
        throw error;
      }
    });
  }

  async whoHolds(scope: string): Promise<{ pid: number; epochMs: number } | null> {
    const existing = await safeReadPayload(this.resolveLockPath(scope));
    if (!existing) return null;

    const expired = this.now() - existing.epochMs > existing.ttlMs;
    if (expired) {
      await fs.unlink(this.resolveLockPath(scope)).catch(() => undefined);
      return null;
    }

    return {
      pid: existing.pid,
      epochMs: existing.epochMs,
    };
  }

  private resolveLockPath(scope: string): string {
    return path.join(this.rootPath, `${hashScope(scope)}.lock`);
  }
}
