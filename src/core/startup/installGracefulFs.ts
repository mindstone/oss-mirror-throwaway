/**
 * Canonical boot-time graceful-fs install.
 *
 * Shared by desktop main, cloud-service, and standalone CLI wrappers.
 * See docs/plans/260516_cross_surface_centralization.md Stage 1.C.
 */

import { createRequire } from 'node:module';

const GRACEFUL_FS_RETRY_DELAY_MS = 1_000;

export interface InstallGracefulFsBootOptions {
  /**
   * When true, a failed first install schedules one delayed retry.
   * Desktop keeps this enabled; cloud keeps it disabled for lighter init.
   */
  readonly retryOnFailure?: boolean;
}

type SerializedInstallError = {
  name?: string;
  message?: string;
  stack?: string;
  code?: unknown;
};

type GracefulFsLeafInstallStash = {
  kind: 'graceful_fs_leaf_install_failed';
  error: SerializedInstallError;
  at: number;
  retry?: {
    status: 'pending' | 'succeeded' | 'failed';
    delayMs: number;
    scheduledAt?: number;
    attemptedAt?: number;
    error?: SerializedInstallError;
  };
};

let hasInstalledGracefulFs = false;
let retryTimerArmed = false;

function serializeInstallError(error: unknown): SerializedInstallError {
  const maybeError = error as NodeJS.ErrnoException | undefined;
  return {
    name: maybeError?.name,
    message: maybeError?.message,
    stack: maybeError?.stack,
    code: maybeError?.code,
  };
}

function getRequireFn(): NodeRequire {
  if (typeof require === 'function') {
    return require;
  }
  return createRequire(import.meta.url);
}

function patchGracefulFs(requireFn: NodeRequire): void {
  const gracefulFs = requireFn('graceful-fs') as {
    gracefulify: (fs: typeof import('node:fs')) => void;
  };
  const fs = requireFn('node:fs') as typeof import('node:fs');
  gracefulFs.gracefulify(fs); // graceful-fs is internally idempotent
}

/**
 * Idempotent per-process install. Returns true on first successful patch.
 */
export function installGracefulFs(): boolean {
  if (hasInstalledGracefulFs) {
    return false;
  }
  patchGracefulFs(getRequireFn());
  hasInstalledGracefulFs = true;
  return true;
}

function scheduleInstallRetry(stash: GracefulFsLeafInstallStash): void {
  if (retryTimerArmed) {
    return;
  }
  retryTimerArmed = true;

  stash.retry = {
    status: 'pending',
    delayMs: GRACEFUL_FS_RETRY_DELAY_MS,
    scheduledAt: Date.now(),
  };

  const retryTimer = setTimeout(() => {
    const g = globalThis as { __REBEL_BOOTSTRAP_LEAF_ERROR__?: GracefulFsLeafInstallStash };
    const currentStash = g.__REBEL_BOOTSTRAP_LEAF_ERROR__ ?? stash;
    try {
      installGracefulFs();
      currentStash.retry = {
        status: 'succeeded',
        delayMs: GRACEFUL_FS_RETRY_DELAY_MS,
        attemptedAt: Date.now(),
      };
      g.__REBEL_BOOTSTRAP_LEAF_ERROR__ = currentStash;
    } catch (retryError) {
      currentStash.retry = {
        status: 'failed',
        delayMs: GRACEFUL_FS_RETRY_DELAY_MS,
        attemptedAt: Date.now(),
        error: serializeInstallError(retryError),
      };
      g.__REBEL_BOOTSTRAP_LEAF_ERROR__ = currentStash;
      if (process.env.REBEL_DEBUG_BOOTSTRAP === '1') {
        console.warn('[installGracefulFs] retry failed:', retryError);
      }
    } finally {
      retryTimerArmed = false;
    }
  }, GRACEFUL_FS_RETRY_DELAY_MS);

  if (typeof retryTimer.unref === 'function') {
    retryTimer.unref();
  }
}

/**
 * Boot-safe install wrapper with kill switch + failure stash.
 */
export function installGracefulFsAtBoot(options: InstallGracefulFsBootOptions = {}): void {
  if (process.env.REBEL_DISABLE_GRACEFUL_FS === '1') {
    return;
  }

  try {
    installGracefulFs();
  } catch (error) {
    const g = globalThis as { __REBEL_BOOTSTRAP_LEAF_ERROR__?: unknown };
    const stash: GracefulFsLeafInstallStash = {
      kind: 'graceful_fs_leaf_install_failed',
      error: serializeInstallError(error),
      at: Date.now(),
    };
    g.__REBEL_BOOTSTRAP_LEAF_ERROR__ = stash;

    if (options.retryOnFailure ?? true) {
      scheduleInstallRetry(stash);
    }

    if (process.env.REBEL_DEBUG_BOOTSTRAP === '1') {
      console.warn('[installGracefulFs] failed:', error);
    }
  }
}
