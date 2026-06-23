import * as fs from 'node:fs';

/**
 * Canonical ENOENT-tolerant file read for repo-walking scanners.
 *
 * **Origin (Stage 1, commit 642e11d1b9).** The `check-sk-test-token-drift`
 * scanner walks the whole repo (`readdirSync`) and then loops `readFileSync`
 * over every discovered file. A concurrent Vitest fork can delete one of its
 * own throwaway temp files in the window between "listed by the walk" and
 * "read by the loop" — a classic TOCTOU race. The scanner's original
 * fail-closed `catch` re-threw on ANY read error, so that vanished file failed
 * the whole check intermittently. This helper extracts the single, tested
 * discriminator the Stage-1 fix introduced so the three real repo-walking
 * scanners share one implementation instead of duplicating the branch.
 *
 * **The discriminator — two genuinely different error classes:**
 *
 *  - `ENOENT`: the file was enumerated by the directory walk but deleted before
 *    we read it (concurrent deletion / TOCTOU). A file that has vanished cannot
 *    contain committed drift; there is nothing to check. Return `null` so the
 *    caller can skip it (and count it, for observability — the skip must never
 *    be silent). On POSIX a delete/rename of a path surfaces as `ENOENT`.
 *
 *  - Everything else (`EACCES`, `EPERM`, `EBUSY`, binary-decode issues, …): the
 *    file is *present but unreadable*. Stay fail-closed — silently skipping it
 *    would hide drift in a file we genuinely can't read. The original error is
 *    re-thrown UNCHANGED so the caller's existing fail-closed message/handling
 *    (and the precise error code) is preserved.
 *
 * **WARNING — scope is repo-walking scanners only.** Use this ONLY for paths
 * that were just enumerated by a live directory walk / `git ls-files` scan. Do
 * NOT use it to read a known source-of-truth or config file (a fixed path you
 * expect to exist): there, a missing file is a real error that must fail loudly,
 * and this helper cannot distinguish "vanished after enumeration" (benign) from
 * "caller passed a bad/typo'd path" (a bug) — both surface as `ENOENT` and would
 * be silently swallowed as `null`. For fixed-path reads use `fs.readFileSync`
 * directly so the ENOENT propagates.
 *
 * @param absPath Absolute path to the file to read.
 * @returns The file's UTF-8 contents, or `null` if the file vanished
 *   (`ENOENT`) between listing and reading.
 */
export function readFileToleratingVanished(absPath: string): string | null {
  try {
    return fs.readFileSync(absPath, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      // File listed by the walk then deleted before the read — a concurrent
      // deletion / TOCTOU. A vanished file cannot be committed drift.
      return null;
    }
    // Present-but-unreadable: stay fail-closed. Re-throw the ORIGINAL error
    // unchanged so the caller preserves the exact code and can surface it.
    throw err;
  }
}
