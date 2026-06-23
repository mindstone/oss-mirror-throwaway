import { createHash, randomBytes } from 'node:crypto';
import fs, { type FileHandle } from 'node:fs/promises';
import path from 'node:path';
import { getPlatformConfig } from '@core/platform';
import type { CrossProcessLease, LeaseHandle } from '@core/setCrossProcessLease';
import { describeLeaseOwner, mintLeaseOwnerIdentity, ownerIdentityEquals, parseLeaseOwnerIdentity } from '@core/setCrossProcessLease';
import { ignoreBestEffortCleanup } from '@shared/utils/intentionalSwallow';

const DEFAULT_STALE_AFTER_MS = 60_000;
const MAX_ACQUIRE_ATTEMPTS = 3;

type LockPayload = {
  pid: number;
  epochMs: number;
  nonce?: string;
};

function sha256Hex(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function isMissingFileError(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | null)?.code === 'ENOENT';
}

function defaultIsPidAlive(pid: number): boolean {
  if (!Number.isFinite(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    ignoreBestEffortCleanup(error, {
      operation: 'desktop_file_lock_lease_pid_probe',
      reason: 'pid probe failures are treated as process-not-alive for stale-lock cleanup',
    });
    return false;
  }
}

function defaultNonceFactory(): string {
  return randomBytes(16).toString('hex');
}

async function safeUnlink(filePath: string): Promise<void> {
  try {
    await fs.unlink(filePath);
  } catch (error) {
    if (!isMissingFileError(error)) {
      throw error;
    }
  }
}

export class DesktopFileLockLease implements CrossProcessLease {
  private readonly lockRootPath: string;
  private readonly now: () => number;
  private readonly isPidAlive: (pid: number) => boolean;
  private readonly staleAfterMs: number;
  private readonly pid: number;
  private readonly nonceFactory: () => string;

  constructor(options: {
    lockRootPath?: string;
    now?: () => number;
    isPidAlive?: (pid: number) => boolean;
    staleAfterMs?: number;
    pid?: number;
    nonceFactory?: () => string;
  } = {}) {
    this.lockRootPath = options.lockRootPath
      ?? path.join(getPlatformConfig().userDataPath, '.token-refresh-leases');
    this.now = options.now ?? Date.now;
    this.isPidAlive = options.isPidAlive ?? defaultIsPidAlive;
    this.staleAfterMs = options.staleAfterMs ?? DEFAULT_STALE_AFTER_MS;
    this.pid = options.pid ?? process.pid;
    this.nonceFactory = options.nonceFactory ?? defaultNonceFactory;
  }

  async acquire(scope: string, ttlMs: number): Promise<LeaseHandle | null> {
    const lockFilePath = this.resolveLockPath(scope);
    await fs.mkdir(this.lockRootPath, { recursive: true });

    for (let attempt = 0; attempt < MAX_ACQUIRE_ATTEMPTS; attempt += 1) {
      const epochMs = this.now();
      const lockIdentity: LockPayload = {
        pid: this.pid,
        epochMs,
        nonce: this.nonceFactory(),
      };

      try {
        const fileHandle = await fs.open(lockFilePath, 'wx', 0o600);
        try {
          await fileHandle.writeFile(JSON.stringify(lockIdentity), 'utf8');
        } finally {
          await this.closeFileHandle(fileHandle);
        }

        return {
          scope,
          acquiredAtMs: epochMs,
          ttlMs,
          owner: mintLeaseOwnerIdentity({
            pid: lockIdentity.pid,
            epochMs: lockIdentity.epochMs,
            nonce: lockIdentity.nonce,
          }),
        };
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== 'EEXIST') {
          throw error;
        }

        const reclaimOutcome = await this.tryReclaimStaleLock(lockFilePath);
        if (reclaimOutcome === 'fresh') {
          ignoreBestEffortCleanup(error, {
            operation: 'desktop_file_lock_lease_acquire_existing_lock',
            reason: 'lock file already held by another healthy process',
          });
          return null;
        }

        if (reclaimOutcome === 'reclaimed') {
          continue;
        }

        if (attempt === MAX_ACQUIRE_ATTEMPTS - 1) {
          return null;
        }
      }
    }

    return null;
  }

  async release(handle: LeaseHandle): Promise<void> {
    const lockFilePath = this.resolveLockPath(handle.scope);
    let fileHandle: FileHandle | null = null;
    try {
      fileHandle = await fs.open(lockFilePath, 'r');
    } catch (error) {
      if (isMissingFileError(error)) {
        ignoreBestEffortCleanup(error, {
          operation: 'desktop_file_lock_lease_release_open_missing',
          reason: 'lock file already disappeared before release ran',
        });
        return;
      }
      throw error;
    }

    try {
      const snapshot = await this.readSnapshotFromHandle(fileHandle);
      if (!snapshot) return;

      if (!this.lockBelongsToHandle(snapshot.payload, handle)) {
        const expected = describeLeaseOwner(handle.owner);
        console.warn(
          {
            event: 'desktop_file_lock_lease_release_mismatched_owner',
            scope: handle.scope,
            expected: {
              pid: expected.pid,
              epochMs: expected.epochMs,
              nonce: expected.nonce ?? null,
            },
            actual: snapshot.payload
              ? {
                pid: snapshot.payload.pid,
                epochMs: snapshot.payload.epochMs,
                nonce: snapshot.payload.nonce ?? null,
              }
              : null,
          },
          'Desktop file-lock lease release skipped because ownership changed',
        );
        return;
      }

      await safeUnlink(lockFilePath);
    } finally {
      if (fileHandle) {
        await this.closeFileHandle(fileHandle);
      }
    }
  }

  async whoHolds(scope: string): Promise<{ pid: number; epochMs: number } | null> {
    const snapshot = await this.readSnapshotFromPath(this.resolveLockPath(scope));
    const payload = snapshot?.payload ?? null;
    if (!payload) {
      return null;
    }
    return {
      pid: payload.pid,
      epochMs: payload.epochMs,
    };
  }

  private resolveLockPath(scope: string): string {
    const [, provider = 'unknown', ...rest] = scope.split(':');
    const accountKey = rest.length > 0 ? rest.join(':') : scope;
    const accountHash = sha256Hex(accountKey).slice(0, 16);
    const fileName = `${provider}__${accountHash}.lock`;
    return path.join(this.lockRootPath, fileName);
  }

  private async tryReclaimStaleLock(lockFilePath: string): Promise<'reclaimed' | 'fresh' | 'race'> {
    const staleSnapshot = await this.readSnapshotFromPath(lockFilePath);
    if (!staleSnapshot) return 'race';

    if (!this.isStalePayload(staleSnapshot.payload)) {
      return 'fresh';
    }

    let fileHandle: FileHandle | null = null;
    try {
      fileHandle = await fs.open(lockFilePath, 'r+');
    } catch (error) {
      if (isMissingFileError(error)) {
        ignoreBestEffortCleanup(error, {
          operation: 'desktop_file_lock_lease_reclaim_open_missing',
          reason: 'lock file disappeared while opening stale reclaim verification handle',
        });
        return 'race';
      }
      throw error;
    }

    try {
      const verifiedSnapshot = await this.readSnapshotFromHandle(fileHandle);
      if (!verifiedSnapshot) return 'race';

      if (verifiedSnapshot.raw !== staleSnapshot.raw) {
        return 'race';
      }

      await safeUnlink(lockFilePath);
      return 'reclaimed';
    } finally {
      if (fileHandle) {
        await this.closeFileHandle(fileHandle);
      }
    }
  }

  private isStalePayload(payload: LockPayload | null): boolean {
    if (!payload) return true;
    const staleByAge = this.now() - payload.epochMs > this.staleAfterMs;
    const staleByPid = !this.isPidAlive(payload.pid);
    return staleByAge || staleByPid;
  }

  private lockBelongsToHandle(payload: LockPayload | null, handle: LeaseHandle): boolean {
    if (!payload) return false;
    // Reconstruct the on-disk owner identity and compare it against the
    // handle's opaque identity. Ownership cannot be derived from `scope` alone
    // — the caller must present the handle minted at acquire time.
    const payloadOwner = parseLeaseOwnerIdentity({
      pid: payload.pid,
      epochMs: payload.epochMs,
      nonce: payload.nonce,
    });
    return ownerIdentityEquals(payloadOwner, handle.owner);
  }

  private async readSnapshotFromPath(
    lockFilePath: string,
  ): Promise<{ raw: string; payload: LockPayload | null } | null> {
    try {
      const raw = await fs.readFile(lockFilePath, 'utf8');
      return this.snapshotFromRaw(raw);
    } catch (error) {
      if (isMissingFileError(error)) {
        ignoreBestEffortCleanup(error, {
          operation: 'desktop_file_lock_lease_read_snapshot_path_missing',
          reason: 'lock file vanished during read and should be treated as unheld',
        });
        return null;
      }
      ignoreBestEffortCleanup(error, {
        operation: 'desktop_file_lock_lease_read_snapshot_path_failed',
        reason: 'unable to read lock payload from path; treating lock as unavailable',
      });
      return null;
    }
  }

  private async readSnapshotFromHandle(
    fileHandle: FileHandle,
  ): Promise<{ raw: string; payload: LockPayload | null } | null> {
    try {
      const raw = await fileHandle.readFile({ encoding: 'utf8' });
      return this.snapshotFromRaw(raw);
    } catch (error) {
      ignoreBestEffortCleanup(error, {
        operation: 'desktop_file_lock_lease_read_snapshot_handle_failed',
        reason: 'unable to read lock payload from open file handle; treating lock as unavailable',
      });
      return null;
    }
  }

  private snapshotFromRaw(raw: string): { raw: string; payload: LockPayload | null } {
    return { raw, payload: this.parsePayload(raw) };
  }

  private parsePayload(raw: string): LockPayload | null {
    try {
      const parsed = JSON.parse(raw) as Partial<LockPayload>;
      if (!Number.isFinite(parsed.pid) || !Number.isFinite(parsed.epochMs)) {
        return null;
      }
      if (parsed.nonce !== undefined && typeof parsed.nonce !== 'string') {
        return null;
      }
      return {
        pid: Number(parsed.pid),
        epochMs: Number(parsed.epochMs),
        nonce: typeof parsed.nonce === 'string' ? parsed.nonce : undefined,
      };
    } catch (error) {
      ignoreBestEffortCleanup(error, {
        operation: 'desktop_file_lock_lease_parse_payload',
        reason: 'invalid lock payload is treated as stale for lease recovery',
      });
      return null;
    }
  }

  private async closeFileHandle(fileHandle: FileHandle): Promise<void> {
    try {
      await fileHandle.close();
    } catch (error) {
      ignoreBestEffortCleanup(error, {
        operation: 'desktop_file_lock_lease_close_file_handle',
        reason: 'lock file close is best-effort and should not fail lease operations',
      });
    }
  }
}
