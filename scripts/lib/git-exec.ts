import { execFileSync, execSync } from 'node:child_process';

export const DEFAULT_GIT_MAXBUFFER = 256 * 1024 * 1024;

interface GitCaptureOptions {
  cwd?: string;
  maxBuffer?: number;
  encoding?: BufferEncoding;
  env?: NodeJS.ProcessEnv;
}

/**
 * Capture git stdout with the repo-wide buffer policy.
 *
 * Node's child_process capture helpers default maxBuffer to 1 MiB, which can
 * throw ENOBUFS for repo-sized git output such as `git ls-files`. All git
 * capture in scripts/** should route through this helper; a CI guard will
 * enforce that chokepoint.
 *
 * `stdio` defaults to ['ignore','pipe','pipe']: stdin closed, stdout captured
 * (returned), stderr captured into the thrown error rather than echoed to the
 * parent console. (Node's default stdio for exec*Sync ALSO inherits stderr to
 * the parent, so a capture helper that omitted this would leak git `fatal:`
 * noise on callers' swallowed-error paths.)
 */
export function gitCapture(args: string[], opts: GitCaptureOptions = {}): string {
  return execFileSync('git', args, {
    cwd: opts.cwd,
    encoding: opts.encoding ?? 'utf8',
    maxBuffer: opts.maxBuffer ?? DEFAULT_GIT_MAXBUFFER,
    stdio: ['ignore', 'pipe', 'pipe'],
    ...(opts.env ? { env: opts.env } : {}),
  }) as string;
}

/**
 * String-command variant for existing `execSync('git ...')` call sites.
 * Same stdio policy as {@link gitCapture}.
 */
export function gitCaptureShell(command: string, opts: GitCaptureOptions = {}): string {
  return execSync(command, {
    cwd: opts.cwd,
    encoding: opts.encoding ?? 'utf8',
    maxBuffer: opts.maxBuffer ?? DEFAULT_GIT_MAXBUFFER,
    stdio: ['ignore', 'pipe', 'pipe'],
  }) as string;
}
