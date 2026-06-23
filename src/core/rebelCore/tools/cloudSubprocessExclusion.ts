/**
 * cloudSubprocessExclusion — make the subprocess search tiers (`rg`/`find`/`grep`)
 * honor the same incidental-cloud-symlink skip policy the shared Node walker
 * (`safeWalkDirectory`) enforces by default.
 *
 * THE PROBLEM (GPT-F3, Stage 9): a workspace-wide recursive glob or `searchFiles`
 * from a NON-cloud root can wander into an INCIDENTAL cloud symlink (e.g.
 * `work/Mindstone/General → ~/Library/CloudStorage/GoogleDrive-…`). `rg --follow`
 * / `find -L` follow that symlink into a dead/unresponsive FUSE mount and hang the
 * subprocess (and thus the tool call). These tiers BYPASS `safeWalkDirectory`'s
 * default-on `skipCloudSymlinkTargets`, so they get no protection today.
 *
 * THE FIX (consistent with the established policy): before running the subprocess,
 * enumerate the search root's IMMEDIATE entries with `readdirSync` and classify each
 * symlink READLINK-ONLY (`walkToFirstCloudHopViaReadlink` — NEVER `realpath`/`stat`
 * the target, which is the dead-mount touch we must avoid). An incidental cloud
 * symlink that is NOT admitted (flag off, or verdict not `healthy`) becomes an
 * exclusion the caller passes to the subprocess (`rg --glob '!<rel>/**'`,
 * `find … -path '<abs>' -prune`), so the subprocess never descends into the dead
 * mount. The subprocess is independently time-bounded (its existing `timeout`
 * option) as defence-in-depth.
 *
 * The carve-outs match `safeWalkDirectory` exactly:
 *  - **Explicit named-cloud root** — if the search ROOT is itself cloud-classified
 *    (the user/agent explicitly named a cloud folder), we do NOT enumerate it
 *    (that readdir would itself be the hang) and produce NO exclusions — the
 *    caller searches it (bounded by the subprocess timeout). On-demand named-cloud
 *    access keeps working.
 *  - **Admission** — when `isCloudSymlinkIndexingEnabled()` AND the space's verdict
 *    is `healthy`, the cloud symlink is ADMITTED (not excluded) just like the
 *    walker, so a healthy Drive space is still searched.
 *  - **Non-cloud outside-workspace symlinks** (`rebel-system → /Applications/…`)
 *    classify `local-terminus` → never excluded (followed as today).
 *
 * Pure / synchronous-classification: `readdirSync` + `readlinkSync` only on the
 * LOCAL root and LOCAL link inodes; no `electron` import; safe in `src/core/`.
 */
import { readdirSync } from 'node:fs';
import path from 'node:path';
import { detectCloudStorage } from '@core/utils/cloudStorageUtils';
import { walkToFirstCloudHopViaReadlink } from '@core/utils/readlinkChain';
import { resolveCloudSymlinkAdmission } from '@core/services/cloudSymlinkIndexing';
import { isUnderCloudSpace } from '@core/services/cloudSpaceContainment';
import { ignoreBestEffortCleanup } from '@shared/utils/intentionalSwallow';

/**
 * The incidental cloud symlinks found directly under a search root that should be
 * EXCLUDED from a subprocess (`rg`/`find`/`grep`) walk so it never descends into a
 * possibly-dead cloud mount.
 */
export interface CloudExclusion {
  /** Absolute path of the excluded symlink (under the LOCAL search root). */
  readonly absolutePath: string;
  /** Path relative to the search root (forward slashes) — for `rg --glob` patterns. */
  readonly relativePath: string;
}

/**
 * Enumerate the IMMEDIATE entries of `searchPath` and return the incidental cloud
 * symlinks that must be excluded from a subprocess walk.
 *
 * Returns an empty list (no exclusions) when:
 *  - the root is itself cloud-classified (explicit named-cloud carve-out — we must
 *    NOT readdir it), or
 *  - the root can't be enumerated (treat as "no exclusions"; the subprocess will
 *    handle/skip it, bounded by its own timeout), or
 *  - there are no incidental cloud symlinks at the top level.
 *
 * Only the TOP LEVEL is enumerated: a workspace's cloud spaces are symlinks
 * directly under the workspace root (SPACES.md), and excluding the symlink prunes
 * its entire subtree — so a single readdir of the local root is sufficient and
 * keeps the classification cost O(top-level entries). A cloud symlink nested
 * deeper is the rare case; the subprocess timeout is the backstop there.
 */
export function collectIncidentalCloudExclusions(searchPath: string): CloudExclusion[] {
  // Explicit named-cloud root: never readdir a (possibly dead) cloud mount, and
  // never exclude anything under a folder the caller explicitly named. Match BOTH
  // the PATTERN classifier (`detectCloudStorage`) AND CONTAINMENT
  // (`isUnderCloudSpace`): a configured cloud space addressed by its LOGICAL
  // workspace path (e.g. `workspace/General`) is pattern-FALSE but containment-cloud,
  // and the sync `readdirSync` below would follow that symlink into the (possibly
  // dead) mount and block the main thread — exactly the hang the admission default-ON
  // flip would otherwise make a normal search path (S5). Treat it like a named-cloud
  // root: no readdir, no exclusions, and the caller's subprocess `timeout` bounds the
  // search of it.
  if (detectCloudStorage(searchPath).isCloud || isUnderCloudSpace(searchPath)) return [];

  let entries;
  try {
    entries = readdirSync(searchPath, { withFileTypes: true });
  } catch (error) {
    // Unreadable root → no exclusions (the subprocess handles it, bounded by its
    // own timeout). Observable rather than silent: a root we can't enumerate means
    // we couldn't compute exclusions, so the subprocess proceeds without them.
    ignoreBestEffortCleanup(error, {
      operation: 'cloudSubprocessExclusion.enumerateRoot',
      reason: 'Search root could not be enumerated; produce no exclusions and let the time-bounded subprocess handle it.',
    });
    return [];
  }

  const exclusions: CloudExclusion[] = [];
  for (const entry of entries) {
    if (!entry.isSymbolicLink()) continue;
    const absolutePath = path.join(searchPath, entry.name);
    // READLINK-ONLY classification — never touches the (possibly dead) target.
    const classification = walkToFirstCloudHopViaReadlink(absolutePath);
    if (classification.kind !== 'cloud') continue;
    // Admission (flag on + healthy verdict) → search it like a local space.
    if (resolveCloudSymlinkAdmission(absolutePath) === 'admit') continue;
    exclusions.push({
      absolutePath,
      relativePath: entry.name.split(path.sep).join('/'),
    });
  }
  return exclusions;
}

/**
 * Build the extra `rg` glob args that exclude the given incidental cloud symlinks.
 * `rg`'s `--glob !<name>` is gitignore-style and UNANCHORED — it matches the path
 * component `<name>` at ANY depth, not just at the search root. A bare `!<name>`
 * excludes the symlink dir itself and `!<name>/**` excludes its subtree, so the
 * incidental cloud symlink at the root is reliably pruned (the hang goal). The
 * cost is the same over-exclusion documented for grep below: an unrelated LOCAL
 * dir of the same name anywhere deeper is also excluded. Acceptable — cloud space
 * names are distinctive, and over-exclusion only costs completeness, never a hang.
 */
export function buildRgCloudExcludeArgs(exclusions: readonly CloudExclusion[]): string[] {
  const args: string[] = [];
  for (const ex of exclusions) {
    args.push('--glob', `!${ex.relativePath}`);
    args.push('--glob', `!${ex.relativePath}/**`);
  }
  return args;
}

/**
 * Build the extra `find` args that prune the given incidental cloud symlinks.
 * Inserted BEFORE the `-type f` test: `\( -path <abs> -prune -false \) -o`. With
 * `-L` (follow), `find` would otherwise descend through the symlink into the mount.
 *
 * The `-false` matters: `find` has no explicit action in the caller's expression,
 * so it appends an implicit `-print`. A plain `-path X -prune -o` evaluates TRUE
 * for the pruned dir, so that implicit print would EMIT the pruned cloud symlink's
 * own path. If the caller's pattern then matches that basename (`**`, `General`),
 * the path survives the post-filter and reaches `verifyNoSymlinkEscape` →
 * `fs.realpath()` on the (possibly dead) cloud mount with no timeout — a residual
 * instance of the exact hang we're eliminating. Wrapping the prune in
 * `\( … -prune -false \)` makes the branch evaluate FALSE, so the excluded path is
 * pruned (no descent) AND never printed (never realpath'd downstream).
 */
export function buildFindCloudPruneArgs(exclusions: readonly CloudExclusion[]): string[] {
  const args: string[] = [];
  for (const ex of exclusions) {
    args.push('(', '-path', ex.absolutePath, '-prune', '-false', ')', '-o');
  }
  return args;
}

/**
 * Build the extra `grep` args that exclude the given incidental cloud symlinks.
 * `grep -r --exclude-dir=<name>` matches on the directory BASENAME, which is
 * sufficient here: a cloud space symlink sits directly under the (local) search
 * root, so excluding its name stops `grep -L` (follow) descending into the mount.
 * (Basename matching can over-exclude a same-named local dir elsewhere in the
 * tree — acceptable: cloud space names are distinctive, and over-exclusion only
 * costs completeness, never a hang.)
 */
export function buildGrepCloudExcludeArgs(exclusions: readonly CloudExclusion[]): string[] {
  const args: string[] = [];
  for (const ex of exclusions) {
    args.push(`--exclude-dir=${ex.relativePath}`);
  }
  return args;
}
