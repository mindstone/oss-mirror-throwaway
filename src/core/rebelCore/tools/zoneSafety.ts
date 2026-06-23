/**
 * Zone-safety helpers for built-in file tools.
 *
 * Pure module split lifted verbatim from `builtinTools.ts` so that
 * `globTool.ts`, `lsTool.ts`, and other future zone-aware tool files can
 * import these helpers without circular imports through `builtinTools.ts`.
 *
 * Behaviour is unchanged from the original implementation; the canonical
 * location for the docstring rationale is preserved here so the helpers
 * remain discoverable on their own.
 *
 * Post-lexical symlink-escape guard. After {@link import('../toolPathResolver').resolveToolPath}
 * accepts a path lexically, we must confirm the physical path (following
 * symlinks on existing ancestors) still lands inside one of the allowed
 * zones.
 *
 * Why: `path.resolve` + prefix comparison doesn't detect a symlink like
 * `~/mcp-servers/foo-mcp/src -> /etc`, which would let the agent read/write
 * `/etc/passwd` through an allowed-looking path.
 *
 * Strategy: realpath() the deepest existing ancestor of `resolvedPath`, then
 * verify that the realpath is prefixed by either (a) the cwd, or (b)
 * `<homePath>/mcp-servers/<project>/`. Files that don't exist yet (common
 * for Write) fall back to their parent dir; parent dirs that don't exist
 * yet fall back further, capped at the allow-zone root.
 *
 * All `realpath` work routes through the {@link workspaceFs} boundary (PLAN.md
 * SYNTHESIS Stage S3): a cloud-symlinked path is realpath'd in the bounded,
 * killable child pool, so a dead Drive mount can never hang this security check
 * on the turn path. A `reconnecting` outcome FAILS CLOSED (deny) — we never
 * authorise a path whose physical identity we cannot verify. Local paths take the
 * byte-identical bare-fs lane.
 */

import path from 'node:path';
import { createScopedLogger } from '@core/logger';
import { workspaceFs } from '@core/services/boundedWorkspaceFs';

const log = createScopedLogger({ service: 'builtin-file-tool' });

// Canonicalize a potentially-non-existent zone root. We realpath as much of
// the path as exists; missing tail segments are appended unchanged. Needed
// because macOS /tmp → /private/tmp etc. would otherwise break the prefix
// check between the zone roots and the realpath'd target.
export const canonicalizeZoneRoot = async (p: string): Promise<string> => {
  const resolved = path.resolve(p);
  const outcome = await workspaceFs.realpath(resolved);
  if (outcome.status === 'ok') return outcome.value;
  if (outcome.status === 'reconnecting') {
    // Cloud zone root on a reconnecting mount: we cannot canonicalize it, so we
    // cannot use it to AUTHORISE a path. Fail closed (deny) rather than fall back
    // to an unverified prefix — consistent with the non-ENOENT throw below.
    throw new Error(
      `Path validation failed: cannot canonicalize zone root — cloud drive reconnecting (${resolved})`,
    );
  }
  // outcome.status === 'error'
  if (outcome.error.code !== 'ENOENT') throw outcome.error;
  // ENOENT: walk up until we find an existing ancestor, then re-append the tail.
  const parent = path.dirname(resolved);
  if (parent === resolved) return resolved;
  const canonicalParent = await canonicalizeZoneRoot(parent);
  return path.join(canonicalParent, path.basename(resolved));
};

const isInsideZone = (realPath: string, zoneRoot: string): boolean => {
  const rel = path.relative(zoneRoot, realPath);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
};

export const verifyNoSymlinkEscape = async (
  resolvedPath: string,
  opts: { cwd?: string; homePath?: string; allowedSymlinkTargets?: string[] },
): Promise<void> => {
  const workspaceRoot = await canonicalizeZoneRoot(opts.cwd ?? process.cwd());
  const mcpServersRoot = opts.homePath
    ? await canonicalizeZoneRoot(path.join(opts.homePath, 'mcp-servers'))
    : null;

  // Find the deepest existing ancestor and realpath it.
  let candidate = resolvedPath;
  let realAncestor: string | null = null;
  // Guard against pathological paths by capping ascent at 64 segments.
  for (let i = 0; i < 64; i++) {
    const outcome = await workspaceFs.realpath(candidate);
    if (outcome.status === 'ok') {
      realAncestor = outcome.value;
      break;
    }
    if (outcome.status === 'reconnecting') {
      // Cloud path on a reconnecting mount: we CANNOT verify its physical identity,
      // so we must not authorise it on lexical validation alone. Fail closed (deny) —
      // a dead mount can never become a symlink-escape bypass, and (unlike today's
      // bare realpath) it can never hang the turn either.
      throw new Error(
        'Path validation failed: cannot verify filesystem identity — cloud drive reconnecting',
      );
    }
    // outcome.status === 'error'
    if (outcome.error.code === 'ENOENT') {
      // Security note (S3 review F2): a cloud-lane ENOENT means the executor got a
      // DEFINITIVE answer — the mount was responsive enough to say "no such entry".
      // A WEDGED mount instead yields `reconnecting` (handled above → fail closed),
      // never ENOENT, so this walk-up cannot smuggle a dead-mount path through. The
      // ascent may cross out of a cloud space into a real local ancestor and accept
      // on lexical validation; that is the pre-existing "missing-tail" residual
      // (a dangling symlink target has no live location to escape to), unchanged by
      // this routing — NOT a new weakening. This contract rests on
      // boundedWorkspaceFs mapping timeout→reconnecting and real fs errors→error.
      const parent = path.dirname(candidate);
      if (parent === candidate) break; // reached filesystem root
      candidate = parent;
      continue;
    }
    // Permission, loop, etc — fail closed.
    throw new Error(`Path validation failed: cannot verify filesystem identity: ${outcome.error.message}`);
  }

  if (realAncestor === null) {
    // Nothing on disk to check against — accept lexical validation.
    return;
  }

  const realAncestorResolved = path.resolve(realAncestor);

  if (isInsideZone(realAncestorResolved, workspaceRoot)) return;
  if (mcpServersRoot && isInsideZone(realAncestorResolved, mcpServersRoot)) return;

  // Space symlink targets: when a Space is a symlink to an external folder
  // (e.g. Google Drive), the realpath resolves outside the workspace root.
  // The user explicitly configured these paths, so they are trusted.
  if (opts.allowedSymlinkTargets) {
    for (const target of opts.allowedSymlinkTargets) {
      // Trusted targets are themselves cloud-folder paths (a Space's sourcePath),
      // so canonicalizing one routes through the bounded boundary and can throw
      // (reconnecting / fs error). A target we cannot canonicalize cannot CONFIRM
      // this path — skip it and try the next, rather than aborting the whole check.
      // This keeps a HEALTHY cloud Space usable when a DIFFERENT trusted Space is
      // mid-reconnect; if no target confirms, we still fall through to the deny
      // below (fail closed). [S3 review SHOULD-1]
      let canonicalTarget: string;
      try {
        canonicalTarget = await canonicalizeZoneRoot(target);
      } catch (err) {
        log.debug(
          { target, err: (err as Error).message },
          'Skipping a trusted symlink target that could not be canonicalized (cloud reconnecting / fs error)',
        );
        continue;
      }
      if (isInsideZone(realAncestorResolved, canonicalTarget)) return;
    }
  }

  log.warn(
    {
      lexicalPath: resolvedPath,
      realPath: realAncestorResolved,
      reason: 'symlink-escape',
    },
    'Rejected file-tool path — realpath resolved outside all allowed zones (symlink escape)',
  );
  throw new Error(
    `Path realpath resolves outside allowed zones. ` +
      `This can happen when a directory along the path is a symbolic link pointing elsewhere.`,
  );
};
