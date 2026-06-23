/**
 * Cross-platform process tree kill utility.
 *
 * On POSIX (macOS/Linux): uses process group kill via negative PID.
 * Requires the child to be spawned with `detached: true` so it becomes
 * a session leader (setsid). Child processes inherit the PGID, so
 * `process.kill(-pid)` terminates the entire tree.
 *
 * On Windows: uses `taskkill /pid <pid> /t /f` to kill the process tree.
 *
 * Extracted from superMcpHttpManager.ts for reuse across Bash tool,
 * MCP spawning, and other process lifecycle management.
 */

import { exec } from 'node:child_process';
import { createScopedLogger } from '@core/logger';

const log = createScopedLogger({ service: 'processKill' });

/**
 * Kill an entire process tree rooted at the given PID.
 *
 * The child MUST have been spawned with `detached: true` on POSIX for
 * process group kill to work. On Windows, `taskkill /t` handles trees
 * regardless of detached mode.
 */
export async function killProcessTree(pid: number): Promise<void> {
  if (process.platform === 'win32') {
    return new Promise((resolve) => {
      exec(`taskkill /pid ${pid} /t /f`, (error) => {
        if (error) {
          const code = (error as { code?: number }).code;
          if (code !== 128 && code !== 1) {
            log.debug({ pid, err: error.message }, 'taskkill failed');
          }
        }
        resolve();
      });
    });
  }

  // POSIX: process group kill, then fallback to pkill + direct kill.
  try {
    process.kill(-pid, 'SIGKILL');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') {
      log.debug({ pid, err: (error as Error).message }, 'Process group kill failed');
    }
  }

  return new Promise((resolve) => {
    exec(`pkill -KILL -P ${pid} 2>/dev/null`, () => {
      try { process.kill(pid, 'SIGKILL'); } catch { /* already dead */ }
      resolve();
    });
  });
}

/**
 * Graceful process tree kill: SIGTERM first, escalate to SIGKILL after grace period.
 *
 * ALWAYS escalates to SIGKILL after the grace period. We intentionally do NOT
 * short-circuit based on the leader PID dying, because shell descendants can
 * survive after the leader exits (the exact failure mode this utility fixes).
 *
 * The child MUST have been spawned with `detached: true` on POSIX.
 */
export async function killProcessTreeGracefully(
  pid: number,
  options: { gracePeriodMs?: number; onEscalated?: () => void } = {},
): Promise<void> {
  const { gracePeriodMs = 5_000, onEscalated } = options;

  if (process.platform === 'win32') {
    return killProcessTree(pid);
  }

  // Step 1: SIGTERM to process group
  try {
    process.kill(-pid, 'SIGTERM');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return;
    log.debug({ pid, err: (error as Error).message }, 'Process group SIGTERM failed');
  }

  // Step 2: Always wait grace period, then escalate to SIGKILL.
  // We do NOT check if the leader PID is dead — shell descendants can survive
  // after the shell exits, keeping stdio FDs open.
  await new Promise<void>((resolve, reject) => {
    setTimeout(() => {
      Promise.resolve()
        .then(async () => {
          onEscalated?.();
          await killProcessTree(pid);
        })
        .then(resolve, reject);
    }, gracePeriodMs);
  });
}
