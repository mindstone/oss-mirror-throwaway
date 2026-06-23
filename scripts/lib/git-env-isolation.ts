/**
 * Single source of truth for isolating git-shelling code (especially test
 * fixtures) from the REAL repository via the environment.
 *
 * THE HAZARD (proven by spike; see docs/plans/260609_core-bare-corruption-guard):
 * git resolves which repository to operate on from `GIT_DIR` (and friends)
 * BEFORE falling back to `cwd`. When vitest runs INSIDE the `.husky/pre-push`
 * hook, git exports `GIT_DIR` / `GIT_WORK_TREE` / `GIT_INDEX_FILE` / … pointing
 * at the real repo. A fixture that spawns git with `cwd=<tempdir>` but inherits
 * those vars then mutates the REAL repo — e.g. `git config core.bare true`
 * lands in the shared `.git/config`, and under `extensions.worktreeConfig=true`
 * that flips EVERY sibling worktree into "bare" ("fatal: this operation must be
 * run in a work tree"). Plain `git init` re-inits the real repo and subsequent
 * `git add`/`commit` create stray commits in it.
 *
 * THE FIX: scrub the location-redirect vars so git falls back to `cwd`. Done
 * once at the shared test seam (`vitest.setup.ts`) this isolates every
 * git-shelling fixture by construction — present and future — instead of
 * relying on each fixture to remember (the team had re-derived this scrub in at
 * least three separate fixtures before this consolidation).
 *
 * We deliberately scrub ONLY the location-redirect vars, not identity/config
 * vars (GIT_AUTHOR_*, GIT_COMMITTER_*, GIT_CONFIG_GLOBAL, …): those don't
 * redirect which repo is targeted, and fixtures legitimately set them.
 *
 * `scripts/check-core-bare.ts` remains the runtime backstop that detects the
 * corrupted state if a leak ever slips past this seam.
 */

/**
 * Environment variables git uses to LOCATE the repository it operates on.
 * Any of these, if inherited, overrides `cwd`-based discovery and can redirect
 * a fixture's git command at the real repo. Identity/config vars are excluded
 * on purpose (they don't change which repo is targeted).
 */
/** Minimal shape of an environment map (assignable from `process.env`). */
export type EnvLike = Record<string, string | undefined>;

export const GIT_LOCATION_ENV_KEYS = [
  'GIT_DIR',
  'GIT_WORK_TREE',
  'GIT_INDEX_FILE',
  'GIT_OBJECT_DIRECTORY',
  'GIT_ALTERNATE_OBJECT_DIRECTORIES',
  'GIT_COMMON_DIR',
  'GIT_PREFIX',
  'GIT_NAMESPACE',
] as const;

/**
 * Delete the git location-redirect vars from `env` (defaults to `process.env`),
 * mutating it in place, and return it. After this call, git invocations resolve
 * the repository from their `cwd`, so a fixture pointed at a tempdir stays there.
 */
export function scrubGitLocationEnv(env: EnvLike = process.env): EnvLike {
  for (const key of GIT_LOCATION_ENV_KEYS) {
    delete env[key];
  }
  return env;
}

/**
 * Return a shallow copy of `base` (defaults to `process.env`) with the git
 * location-redirect vars removed — for passing as the `env` of a single child
 * git process without mutating the caller's environment.
 */
export function gitIsolatedEnv(base: EnvLike = process.env): EnvLike {
  return scrubGitLocationEnv({ ...base });
}
