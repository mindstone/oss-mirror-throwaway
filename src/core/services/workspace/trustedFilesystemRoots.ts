import * as fs from 'node:fs';
import path from 'node:path';

import type { AppSettings } from '@shared/types';

/**
 * Trusted filesystem roots used by both:
 *
 * 1. The agent's built-in `Read`/`Write`/`Edit` tools, via
 *    {@link getAllowedSymlinkTargets}. The output is consumed by
 *    `verifyNoSymlinkEscape` in `src/core/rebelCore/builtinTools.ts`. That
 *    function adds `cwd` and `<homePath>/mcp-servers` itself, so we MUST NOT
 *    add them here — doing so would silently widen built-in trust.
 *
 * 2. The MCP sandbox env (e.g. Runway's `RUNWAY_ALLOWED_ROOT`), via
 *    {@link getMcpSandboxAncestorRoots} + {@link getDeepestCommonAncestor}.
 *    Connectors don't self-augment with workspace/`mcp-servers`, so the MCP
 *    helper bakes those in explicitly.
 *
 * Single shared source of truth for the underlying inputs (settings.spaces +
 * rebelSystemRoot); separate output shapes per consumer.
 */

/**
 * Pure: returns the trust list shape that `verifyNoSymlinkEscape` expects.
 *
 * Byte-identical to the inline literal historically built at the
 * `BuiltinToolContext` / `AgentToolContext` construction sites.
 *
 * Order: space symlink targets in declaration order, then `rebelSystemRoot`.
 * Entries with falsy `sourcePath` are dropped, as is `rebelSystemRoot` when
 * unset. No filesystem I/O.
 *
 * Whitespace-only `rebelSystemRoot` (e.g. `'   '`) is included verbatim to
 * preserve byte-identical compatibility with the prior inline literal —
 * the original `context.rebelSystemRoot ? [context.rebelSystemRoot] : []`
 * check is truthy for any non-empty string. Falsy values (`''`, `undefined`,
 * `null` cast through `as unknown as string`) are omitted.
 */
export function getAllowedSymlinkTargets(
  settings: Pick<AppSettings, 'spaces'>,
  opts: { rebelSystemRoot?: string },
): string[] {
  const spaceSymlinkTargets: string[] = [];
  for (const space of settings.spaces ?? []) {
    if (space.isSymlink && space.sourcePath) {
      spaceSymlinkTargets.push(space.sourcePath);
    }
  }
  return [
    ...spaceSymlinkTargets,
    ...(opts.rebelSystemRoot ? [opts.rebelSystemRoot] : []),
  ];
}

function stripTrailingSeparator(input: string): string {
  if (input.length <= 1) return input;
  const parsedRoot = path.parse(input).root;
  let normalized = input;
  while (
    normalized.length > parsedRoot.length &&
    normalized.endsWith(path.sep)
  ) {
    normalized = normalized.slice(0, -1);
  }
  return normalized;
}

/**
 * Filesystem-aware: returns the list of roots used to compute the MCP
 * sandbox's deepest-common-ancestor.
 *
 * Output order: `[coreDirectory, <homePath>/mcp-servers, ...spaceSymlinkTargets]`.
 * Workspace-first ordering matters because callers may surface the first
 * entry as a UI hint when DCA collapses.
 *
 * **Why no `rebelSystemRoot`** (deliberate divergence from
 * {@link getAllowedSymlinkTargets}): the agent's built-in `Read`/`Write`/`Edit`
 * tools legitimately read bundled config under `rebel-system/`, so that
 * helper includes it. The MCP sandbox path is for connectors that operate on
 * **user data** (Runway media, etc.); they have no need for the bundled
 * `rebel-system` directory. Worse, in packaged installs `rebelSystemRoot`
 * resolves under `process.resourcesPath` (e.g.
 * `/Applications/<App>.app/Contents/Resources/rebel-system`) while user
 * workspace roots live under `/Users/<user>/...` — feeding both into the DCA
 * collapses to `/`, the helper returns `null`, and the caller falls back to
 * `os.tmpdir()`. That recreates the original "Runway can't write user files"
 * bug for every packaged user. See the F-1 fix in
 * `docs/plans/260520_runway_sandbox_central_trusted_roots.md`.
 *
 * Processing applied per input:
 *   1. Trim leading/trailing whitespace (SF-5 — defends against stray
 *      newlines in user-edited config values).
 *   2. Drop empty strings.
 *   3. Drop paths containing a NUL byte (`\0`) — `fs.existsSync` and
 *      `fs.realpathSync` throw `ERR_INVALID_ARG_VALUE` synchronously on
 *      NUL bytes and that throw escapes the per-input try/catch below;
 *      filtering up front is the cheapest fail-soft.
 *   4. Filter out paths that don't exist (SF-1 — prevents the connector's
 *      `realpathSync(root)` from throwing on first-run `<homePath>/mcp-servers`).
 *      `existsSync` itself is wrapped in a try/catch and treated as
 *      non-existent on any throw, mirroring the realpath fail-soft below.
 *   5. Realpath-canonicalise (SF-2 — matches the connector's own canonicalisation
 *      so DCA over realpathed roots aligns with realpathed input arguments).
 *      On EACCES/ENOENT/ENOTDIR/ELOOP/EMFILE/etc., falls back to the lexical
 *      normalised path.
 *   6. Dedup. Case-sensitive on POSIX (case-conflicting paths can co-exist
 *      on case-sensitive APFS), case-insensitive on Windows.
 *
 * Deviates from "pure" on purpose: `existsSync` + `realpathSync` are required
 * to match the connector's runtime semantics. Both run at MCP spawn time, not
 * in the agent hot path.
 *
 * TOCTOU note: the `existsSync` check + `realpathSync` resolution is
 * non-atomic. If a trusted root is renamed/deleted/unmounted between the
 * existence check and the realpath call, the helper falls back to the
 * lexical normalised path. This is an availability concern (downstream
 * consumers may attempt realpath on a stale path) and not a security
 * guarantee — the connector still does its own realpath on every input
 * before the prefix check.
 */
export function getMcpSandboxAncestorRoots(
  settings: Pick<AppSettings, 'spaces'>,
  opts: { homePath?: string; coreDirectory?: string },
): string[] {
  const spaceSymlinkTargets: string[] = [];
  for (const space of settings.spaces ?? []) {
    if (space.isSymlink && space.sourcePath) {
      spaceSymlinkTargets.push(space.sourcePath);
    }
  }

  const mcpServersDir = opts.homePath ? path.join(opts.homePath, 'mcp-servers') : undefined;

  const candidates: Array<string | undefined> = [
    opts.coreDirectory,
    mcpServersDir,
    ...spaceSymlinkTargets,
  ];

  const isWindows = process.platform === 'win32';
  const seen = new Set<string>();
  const out: string[] = [];

  for (const candidate of candidates) {
    if (typeof candidate !== 'string') continue;
    const trimmed = candidate.trim();
    if (trimmed.length === 0) continue;
    if (trimmed.includes('\0')) continue;

    let exists: boolean;
    try {
      exists = fs.existsSync(trimmed);
    } catch {
      exists = false;
    }
    if (!exists) continue;

    let canonical: string;
    try {
      canonical = fs.realpathSync.native(trimmed);
    } catch {
      canonical = path.normalize(trimmed);
    }

    const normalized = stripTrailingSeparator(path.normalize(canonical));
    const key = isWindows ? normalized.toLowerCase() : normalized;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(normalized);
  }

  return out;
}

/**
 * Pure: deepest path that is an ancestor (or equal) of every input.
 *
 * Returns `null` when:
 *   - `paths` is empty
 *   - inputs span different filesystem roots (cross-drive on Windows,
 *     mismatched UNC shares, etc.)
 *   - the DCA would collapse to a filesystem root that the consumer cannot
 *     safely use as a sandbox boundary: POSIX `/`, Windows drive root
 *     `C:\`, or UNC share root `\\server\share\`. The connector's
 *     `path.startsWith(root + path.sep)` check breaks for all three (each
 *     produces a `//`/`C:\\`/`\\server\share\\` double-separator artefact).
 *
 * Walks segments using `path[pathStyle]` exclusively — never the default
 * `path` module — so behaviour is deterministic across OSes for tests with
 * explicit Windows fixtures.
 */
export function getDeepestCommonAncestor(
  paths: string[],
  opts?: { pathStyle?: 'posix' | 'win32' },
): string | null {
  if (paths.length === 0) return null;

  const pathStyle = opts?.pathStyle ?? (process.platform === 'win32' ? 'win32' : 'posix');
  const p = pathStyle === 'win32' ? path.win32 : path.posix;
  const isWindows = pathStyle === 'win32';
  const compareKey = (s: string) => (isWindows ? s.toLowerCase() : s);

  const parsed: Array<{ root: string; segments: string[] }> = paths.map((raw) => {
    const normalized = p.normalize(raw);
    const root = p.parse(normalized).root;
    let body = normalized.slice(root.length);
    while (body.endsWith(p.sep)) body = body.slice(0, -1);
    while (body.startsWith(p.sep)) body = body.slice(1);
    const segments = body.length > 0 ? body.split(p.sep).filter((s) => s.length > 0) : [];
    return { root, segments };
  });

  const first = parsed[0];
  if (!first) return null;
  const firstRootKey = compareKey(first.root);
  if (parsed.some((entry) => compareKey(entry.root) !== firstRootKey)) {
    return null;
  }

  const minLen = Math.min(...parsed.map((entry) => entry.segments.length));
  const commonSegments: string[] = [];
  for (let i = 0; i < minLen; i++) {
    const reference = first.segments[i];
    if (reference === undefined) break;
    const referenceKey = compareKey(reference);
    const allMatch = parsed.every((entry) => {
      const segment = entry.segments[i];
      return segment !== undefined && compareKey(segment) === referenceKey;
    });
    if (allMatch) {
      commonSegments.push(reference);
    } else {
      break;
    }
  }

  if (commonSegments.length === 0) return null;

  const root = first.root;
  const rootEndsWithSep = root.endsWith(p.sep);
  return rootEndsWithSep
    ? root + commonSegments.join(p.sep)
    : root + p.sep + commonSegments.join(p.sep);
}
