/**
 * Path Safety Utilities
 *
 * Defensive helpers for validating filesystem paths before they reach any
 * `fs.*` call. Centralises the "is this path shape suspicious?" decision
 * so every caller gets the same rejections without reinventing them.
 *
 * Rejects (before any syscall):
 *  1. Windows UNC paths (`\\server\share`)
 *  2. Windows device namespaces (`\\?\`, `\\.\`)
 *  3. URL forms (`file://`, `data:`, `http:`, etc.)
 *  4. Null bytes (poison syscall injection)
 *  5. Parent-directory escapes (`..` segments), absolute paths when
 *     a relative path was expected
 *
 * Confines (after `realpath`):
 *  - `assertWithinRoot()` — throw if the resolved path escapes an allowlisted root.
 *
 * This module has NO shared code with super-mcp's `isPathWithinTarget()` in
 * `super-mcp/src/handlers/materializeOutput.ts`; the two packages have
 * separate `tsconfig.json` roots and cannot share imports. The logic is
 * documented in both places; keep them in sync when changes are made.
 *
 * Planning doc: docs/plans/260423_agent_to_tool_file_ref_sentinel.md
 */

import path from 'node:path';

/**
 * Thrown by `rejectDangerousPath` / `assertWithinRoot` when a path fails
 * validation. Carries a machine-readable `reason` code in addition to the
 * human message so callers can branch without string-matching.
 */
export class PathSafetyError extends Error {
  readonly reason:
    | 'unc_path'
    | 'device_path'
    | 'url_scheme'
    | 'null_byte'
    | 'absolute_path'
    | 'parent_escape'
    | 'root_escape'
    | 'empty_path'
    | 'too_long';

  constructor(reason: PathSafetyError['reason'], message: string) {
    super(message);
    this.name = 'PathSafetyError';
    this.reason = reason;
  }
}

/** Hard cap on path length — well above any realistic use, below OS limits. */
const MAX_PATH_LENGTH = 4096;

/**
 * Detect Windows UNC paths (`\\server\share\…`) and device namespaces
 * (`\\?\…`, `\\.\…`). These forms can reference remote shares, raw devices,
 * and named pipes — never desirable targets for agent-driven reads.
 *
 * Matches regardless of host OS because attackers / malicious MCP servers
 * can construct these strings on any platform.
 */
export function isWindowsDangerousPath(raw: string): boolean {
  // Normalise forward slashes to backslashes for detection
  // (Windows treats both as separators; some tools emit forward slashes).
  const normalised = raw.replace(/\//g, '\\');
  if (normalised.startsWith('\\\\?\\')) return true;
  if (normalised.startsWith('\\\\.\\')) return true;
  if (normalised.startsWith('\\\\')) return true; // UNC share
  return false;
}

/**
 * Detect URL-scheme forms (`file://`, `data:`, `http:`, `https:`, etc.)
 * that should never be accepted where a filesystem path is expected.
 */
function hasUrlScheme(raw: string): boolean {
  // A scheme is [a-zA-Z][a-zA-Z0-9+.-]*:  at the start of the string.
  // We reject ALL schemes, not just dangerous ones, because filesystem paths
  // never legitimately start with one and the downside of rejecting a rare
  // legitimate-looking input is trivial compared to the upside of blocking
  // `file://`, `data:`, and similar.
  return /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(raw);
}

/**
 * Validate a raw path BEFORE any filesystem call. Throws `PathSafetyError`
 * with a typed `reason` if the path matches any dangerous shape.
 *
 * Options:
 *  - `allowAbsolute` (default false): if false, absolute paths are rejected.
 *    Most agent-driven inputs should be relative to a known root.
 *
 * Does NOT resolve symlinks or touch the filesystem — call `fs.realpath` +
 * `assertWithinRoot` after this for sandbox confinement.
 */
export function rejectDangerousPath(
  raw: string,
  options: { allowAbsolute?: boolean } = {},
): void {
  if (typeof raw !== 'string' || raw.length === 0) {
    throw new PathSafetyError('empty_path', 'path must be a non-empty string');
  }

  if (raw.length > MAX_PATH_LENGTH) {
    throw new PathSafetyError(
      'too_long',
      `path exceeds max length of ${MAX_PATH_LENGTH} characters`,
    );
  }

  if (raw.includes('\0')) {
    throw new PathSafetyError('null_byte', 'path contains a null byte');
  }

  if (isWindowsDangerousPath(raw)) {
    // Distinguish UNC vs device for observability.
    const normalised = raw.replace(/\//g, '\\');
    if (normalised.startsWith('\\\\?\\') || normalised.startsWith('\\\\.\\')) {
      throw new PathSafetyError('device_path', 'Windows device paths are not allowed');
    }
    throw new PathSafetyError('unc_path', 'Windows UNC paths are not allowed');
  }

  if (hasUrlScheme(raw)) {
    throw new PathSafetyError('url_scheme', 'URL-form paths are not allowed');
  }

  if (!options.allowAbsolute && path.isAbsolute(raw)) {
    throw new PathSafetyError(
      'absolute_path',
      'absolute paths are not allowed; expected a relative path',
    );
  }

  // Check normalized segments for parent-escape. We normalize with POSIX
  // rules because we already rejected Windows-specific forms above; the
  // remaining input is either POSIX or a Windows path that uses forward
  // slashes (which POSIX normalize handles correctly).
  const segments = raw.replace(/\\/g, '/').split('/');
  if (segments.some((s) => s === '..')) {
    throw new PathSafetyError(
      'parent_escape',
      'parent-directory (..) segments are not allowed',
    );
  }
}

/**
 * Confine a resolved path to an allowlisted root directory. Call AFTER
 * `fs.realpath` (or `fs.realpathSync`) so that symlinks pointing outside
 * the root are rejected.
 *
 * Both arguments must be absolute and already-resolved. Trailing separators
 * are handled idempotently.
 *
 * Throws `PathSafetyError('root_escape')` if the resolved path is not a
 * descendant of (or equal to) the root.
 */
/**
 * Boolean lexical-containment predicate: is `resolved` the root itself or a
 * descendant of it? This is the **approved containment helper** — call it
 * instead of hand-rolling `resolved.startsWith(root + path.sep)`, which is a
 * recurring bug shape: a bare `startsWith(root)` (without the trailing `path.sep`)
 * treats a sibling like `/a/bc` as inside `/a/b`, and forgetting the
 * `=== root` case rejects the root itself.
 * See docs-private/postmortems/260531_bug_4_use_shared_lexical_containment_20d3d2c_p3_postmortem.md
 *
 * Both arguments must be absolute and already-resolved (call AFTER `fs.realpath`
 * for symlink-safe confinement); throws `PathSafetyError('root_escape')` on a
 * non-absolute argument — a contract violation, never silently `false`.
 */
export function isWithinRoot(resolved: string, root: string): boolean {
  if (!path.isAbsolute(resolved) || !path.isAbsolute(root)) {
    throw new PathSafetyError(
      'root_escape',
      'path containment check requires both arguments to be absolute paths',
    );
  }

  // Normalise without following symlinks (caller is expected to have done
  // realpath already; this step just strips `.` and duplicate separators).
  const normalisedResolved = path.normalize(resolved);
  const normalisedRoot = path.normalize(root);

  // Equal is OK (the root itself is within itself).
  if (normalisedResolved === normalisedRoot) return true;

  // Ensure descendant: resolved must start with `${root}${sep}` (the trailing
  // separator is what makes `/a/bc` NOT a descendant of `/a/b`).
  const rootWithSep = normalisedRoot.endsWith(path.sep)
    ? normalisedRoot
    : normalisedRoot + path.sep;

  return normalisedResolved.startsWith(rootWithSep);
}

export function assertWithinRoot(resolved: string, root: string): void {
  if (!isWithinRoot(resolved, root)) {
    throw new PathSafetyError(
      'root_escape',
      `path ${resolved} is not within root ${root}`,
    );
  }
}
