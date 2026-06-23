/**
 * Child-process environment helpers for Sentry Autopilot.
 *
 * Cron / tmux / non-login shells often run with an incomplete `PATH` (missing
 * `/usr/bin` etc.), so `git`/`npm`/`tmux` become undiscoverable for autopilot
 * subprocesses. The first fix (`process.env.PATH || fallback`) only helped when
 * PATH was missing ENTIRELY; the real failure mode is PATH set-but-incomplete.
 *
 * `buildChildPath` always guarantees the standard system dirs are present while
 * preserving any operator/VM-specific entries (and order). Centralized + unit
 * tested here so a third call site can't reintroduce the partial-PATH bug.
 * See docs-private/postmortems/260531_always_append_standard_paths_to_path_ee9b596_p3_postmortem.md
 */

/** Standard system bin dirs that must always be discoverable for subprocesses. */
export const STANDARD_SYSTEM_PATHS = ['/usr/local/bin', '/usr/bin', '/bin'] as const;

/**
 * Build a PATH string for autopilot child processes: inherited entries first
 * (preserving operator/VM customizations + order), then any STANDARD_SYSTEM_PATHS
 * not already present. De-duplicates so an already-complete PATH stays clean.
 *
 * Handles every env shape: unset (`undefined`) → standard paths only; empty
 * string → standard paths only; set-complete → unchanged; set-incomplete →
 * missing standard dirs appended.
 *
 * Pure: callers pass `process.env.PATH` explicitly (no hidden env read) so the
 * unset case is testable.
 */
export function buildChildPath(inheritedPath: string | undefined): string {
  const seen = new Set<string>();
  const ordered: string[] = [];
  const inherited = inheritedPath ? inheritedPath.split(':') : [];
  for (const entry of [...inherited, ...STANDARD_SYSTEM_PATHS]) {
    if (entry && !seen.has(entry)) {
      seen.add(entry);
      ordered.push(entry);
    }
  }
  return ordered.join(':');
}
