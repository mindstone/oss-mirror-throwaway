// Use `pathe` (not `node:path`) so this module is safe to import from
// renderer code. `toBestFileLink` pulls `relativePortablePath` into
// MessageMarkdown preprocessors — running in the browser without Node built-ins.
// `pathe` normalizes all output to forward slashes, which matches this
// module's existing post-processing (`.replace(/\\/g, '/')`) — no behaviour
// change for existing callers.
import path from 'pathe';

/**
 * Normalize OS path separators to forward slashes (POSIX).
 * Use for paths that cross process boundaries (IPC, cloud, storage).
 * Does NOT resolve or normalize path segments (no . or .. handling).
 */
export function toPortablePath(value: string): string {
  return value.replace(/\\/g, '/');
}

/**
 * Compute a relative path with POSIX separators.
 * Wraps path.relative() + forward-slash normalization.
 * Use when the result will cross IPC, cloud, or storage boundaries.
 */
export function relativePortablePath(from: string, to: string): string {
  return path.relative(from, to).replace(/\\/g, '/');
}

/**
 * Join path segments using forward slashes.
 * Use for constructing logical/relative paths that will be stored or sent over IPC.
 * Delegates to path.posix.join for correct segment resolution.
 */
export function joinPortablePath(...parts: string[]): string {
  return path.posix.join(...parts.filter(Boolean));
}
