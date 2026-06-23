/**
 * Lightweight subprocess probe helper.
 *
 * Wraps `execFile` from `node:child_process` with sane defaults for
 * probing external tools (Python, uvx, where.exe, etc.):
 * - Non-zero exit returns a result object instead of rejecting (like execa's `reject: false`)
 * - Spawn failures (ENOENT, EACCES, timeout) still reject/throw
 * - Merges caller `env` with `process.env` (execFile replaces env by default)
 * - Always passes `encoding: 'utf-8'` and `windowsHide: true`
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export interface ProbeResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface ProbeOptions {
  env?: Record<string, string>;
  timeout?: number;
}

/**
 * Run a subprocess probe. Returns `{ exitCode, stdout, stderr }` for both
 * zero and non-zero exits. Only rejects on spawn failure or timeout.
 */
export async function runProbe(
  file: string,
  args: string[],
  opts?: ProbeOptions
): Promise<ProbeResult> {
  try {
    const { stdout, stderr } = await execFileAsync(file, args, {
      encoding: 'utf-8',
      windowsHide: true,
      timeout: opts?.timeout,
      env: opts?.env ? { ...process.env, ...opts.env } : undefined,
    });
    return { exitCode: 0, stdout, stderr };
  } catch (err: unknown) {
    // execFile rejects on non-zero exit with an error carrying code/stdout/stderr.
    // `code` is a number (exit code) for non-zero exits, a string for spawn
    // failures ('ENOENT', 'EACCES'), and null for timeouts/signals.
    const e = err as { code?: number | string; stdout?: string; stderr?: string };
    if (typeof e.code === 'number') {
      return {
        exitCode: e.code,
        stdout: e.stdout ?? '',
        stderr: e.stderr ?? '',
      };
    }
    // Genuine spawn failure (ENOENT, EACCES) or timeout — rethrow
    throw err;
  }
}
