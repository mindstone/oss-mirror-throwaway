import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import properLockfile, { type LockOptions as ProperLockOptions } from 'proper-lockfile';
import { app } from 'electron';

const DEFAULT_STALE_MS = 90_000;
const DEFAULT_UPDATE_MS = 5_000;
const DEFAULT_RETRIES = { retries: 5, minTimeout: 100, maxTimeout: 500 };

let userDataDirOverride: string | null = null;

function resolveStaleMs(override?: number): number {
  if (typeof override === 'number') {
    return override;
  }

  const envValue = process.env.HUBSPOT_REFRESH_LOCK_STALE_MS;
  if (!envValue) {
    return DEFAULT_STALE_MS;
  }

  const parsed = Number(envValue);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return DEFAULT_STALE_MS;
  }

  return parsed;
}

function resolveUserDataDir(): string {
  if (userDataDirOverride) {
    return userDataDirOverride;
  }
  return app.getPath('userData');
}

function getConfigDir(): string {
  return path.join(resolveUserDataDir(), 'mcp', 'hubspot');
}

function getAccountsPath(): string {
  return path.join(getConfigDir(), 'accounts.json');
}

function sanitizeEmail(email: string): string {
  return email.replace(/[^a-zA-Z0-9]/g, '-');
}

function getTokenPath(email: string): string {
  return path.join(getConfigDir(), 'credentials', `${sanitizeEmail(email)}.token.json`);
}

export class RefreshLockFailedError extends Error {
  readonly tokenPath: string;
  readonly cause?: unknown;

  constructor(tokenPath: string, message = `Failed to acquire credential lock for ${tokenPath}`, cause?: unknown) {
    super(message);
    this.tokenPath = tokenPath;
    this.cause = cause;
    this.name = 'RefreshLockFailedError';
  }
}

export class LockReleaseFailedError extends RefreshLockFailedError {
  constructor(tokenPath: string, cause?: unknown) {
    super(tokenPath, `Failed to release credential lock for ${tokenPath}`, cause);
    this.name = 'LockReleaseFailedError';
  }
}

export interface HubSpotCredentialLockOptions {
  staleMs?: number;
  updateMs?: number;
  retries?: ProperLockOptions['retries'];
  realpath?: boolean;
}

/**
 * Host mirror of the OSS lock primitive:
 * - proper-lockfile defaults (stale/update/retries)
 * - lock-compromised hard-fail semantics
 * - lock-dir heartbeat assertions before/after critical section
 */
export async function withHubSpotCredentialLock<T>(
  lockPath: string,
  fn: (assertLockHealthy: () => void) => Promise<T>,
  opts: HubSpotCredentialLockOptions = {},
): Promise<T> {
  const tracker: { error?: Error } = {};
  let release: (() => Promise<void>) | undefined;
  let primaryError: unknown;

  try {
    const releaseFn = await properLockfile.lock(lockPath, {
      stale: resolveStaleMs(opts.staleMs),
      update: opts.updateMs ?? DEFAULT_UPDATE_MS,
      retries: opts.retries ?? DEFAULT_RETRIES,
      realpath: opts.realpath ?? false,
      onCompromised: (err: Error) => {
        tracker.error = err;
      },
    });
    release = async () => {
      await releaseFn();
    };
  } catch (error) {
    throw new RefreshLockFailedError(lockPath, undefined, error);
  }

  try {
    const lockDirPath = `${lockPath}.lock`;
    const assertLockHealthy = (): void => {
      if (tracker.error) {
        throw new RefreshLockFailedError(
          lockPath,
          `Credential lock was compromised for ${lockPath}`,
          tracker.error,
        );
      }
      if (!fs.existsSync(lockDirPath)) {
        throw new RefreshLockFailedError(
          lockPath,
          `Credential lock directory disappeared for ${lockPath}`,
          new Error(`Lock directory missing: ${lockDirPath}`),
        );
      }
    };

    assertLockHealthy();
    const result = await fn(assertLockHealthy);
    assertLockHealthy();
    return result;
  } catch (error) {
    primaryError = error;
    throw error;
  } finally {
    if (release) {
      try {
        await release();
      } catch (releaseError) {
        if (primaryError === undefined) {
          throw new LockReleaseFailedError(lockPath, releaseError);
        }
      }
    }
  }
}

/**
 * Accounts lock MUST be outermost. Token/email lock is acquired inside.
 * This preserves the same lock ordering invariant as the OSS manager.
 */
export async function withAccountsAndEmailLock<T>(
  email: string | undefined,
  fn: () => Promise<T>,
): Promise<T> {
  return withAccountsAndEmailLocks(email ? [email] : [], fn);
}

/**
 * Accounts lock MUST be outermost. Token/email locks are acquired inside in
 * deterministic order. This mirrors the OSS HubSpot manager and prevents
 * cross-process deadlocks when a full accounts.json rewrite touches multiple
 * account records.
 */
export async function withAccountsAndEmailLocks<T>(
  emails: string[],
  fn: () => Promise<T>,
): Promise<T> {
  const configDir = getConfigDir();
  await fsp.mkdir(configDir, { recursive: true, mode: 0o700 });

  const accountsPath = getAccountsPath();
  const lockEmails = [...new Set(emails.filter((email) => email.length > 0))].sort();
  if (lockEmails.length === 0) {
    return withHubSpotCredentialLock(accountsPath, async () => fn());
  }

  const credentialsDir = path.join(configDir, 'credentials');
  await fsp.mkdir(credentialsDir, { recursive: true, mode: 0o700 });

  const withEmailLockAt = async (index: number): Promise<T> => {
    if (index >= lockEmails.length) {
      return fn();
    }
    return withHubSpotCredentialLock(getTokenPath(lockEmails[index]), async () =>
      withEmailLockAt(index + 1),
    );
  };

  return withHubSpotCredentialLock(accountsPath, async () => withEmailLockAt(0));
}

export const _testOnly = {
  resolveStaleMs,
  getConfigDir,
  getAccountsPath,
  getTokenPath,
  sanitizeEmail,
  withAccountsAndEmailLocks,
  configureUserDataDirForTests: (userDataDir: string | null) => {
    userDataDirOverride = userDataDir;
  },
};
