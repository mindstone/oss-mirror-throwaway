/**
 * Untracked-vs-incoming collision detection for git-safe-sync's
 * untracked-tolerance gate (see scripts/git-safe-sync.ts `checkSafety` +
 * docs/plans/260611_sync-untracked-tolerance/PLAN.md).
 *
 * git-safe-sync proceeds with a non-colliding untracked working tree left in
 * place (no abort, no autostash). "Collide" = the incoming merge would refuse
 * to proceed because of this untracked path — i.e. `git merge` errors with
 * "The following untracked working tree files would be overwritten" or
 * "Updating the following directories would lose untracked files in them".
 *
 * Why prefix matching (not exact): `git status --porcelain` (default
 * `-unormal`) collapses a fully-untracked directory to a single `dir/` entry,
 * while the incoming-paths set lists individual files (`dir/file`). So an
 * untracked `dir/` collides with an incoming `dir/file`, and — the inverse —
 * an untracked file `x` collides with an incoming `x/child`. We therefore
 * compare on `/`-segment prefixes in BOTH directions, after normalising the
 * trailing slash git appends to collapsed untracked directories.
 */

/** Strip the single trailing slash git appends to a collapsed untracked dir. */
function normalize(path: string): string {
  return path.endsWith('/') ? path.slice(0, -1) : path;
}

/**
 * True iff untracked path `a` and incoming path `b` would collide. Either being
 * a path-prefix of the other (on `/` boundaries) counts — that covers
 * exact match, untracked-dir-over-incoming-file, and untracked-file-under-
 * incoming-dir. The `+ '/'` guard prevents `node` matching `nodejs`.
 */
function pathsCollide(a: string, b: string): boolean {
  const na = normalize(a);
  const nb = normalize(b);
  return na === nb || na.startsWith(nb + '/') || nb.startsWith(na + '/');
}

/**
 * Partition untracked paths into those safe to leave in place (`tolerable`) and
 * those the incoming merge would clash with (`colliding`).
 *
 * @param untracked untracked working-tree paths (porcelain, surrounding quotes
 *                  already stripped — must be the SAME representation as
 *                  `incoming`).
 * @param incoming  incoming-merge paths in the same representation, or `null`
 *                  when the set could not be computed — then EVERY untracked
 *                  path is treated as colliding (fail closed; never tolerate
 *                  dirt we couldn't check against).
 */
export function partitionUntrackedByCollision(
  untracked: readonly string[],
  incoming: ReadonlySet<string> | null,
): { tolerable: string[]; colliding: string[] } {
  if (incoming === null) {
    return { tolerable: [], colliding: [...untracked] };
  }
  const incomingList = [...incoming];
  const tolerable: string[] = [];
  const colliding: string[] = [];
  for (const u of untracked) {
    if (incomingList.some((inc) => pathsCollide(u, inc))) {
      colliding.push(u);
    } else {
      tolerable.push(u);
    }
  }
  return { tolerable, colliding };
}
