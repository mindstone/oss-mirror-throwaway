/**
 * ============================================================================
 * Promote pre-flight — IMPURE fact gathering (feeds the pure verdict library)
 * ============================================================================
 *
 * The "gather the facts" wiring for the CI-triggered production promote (see
 * docs/plans/260619_ci-triggered-promote/PLAN.md, Stage 2a). It runs the git/gh
 * I/O that the PURE, fail-closed verdict library (scripts/promote-preflight.ts)
 * deliberately does NOT do, and produces the `PromotePreflightFacts` that
 * `evaluatePromotePreflight` consumes.
 *
 * DESIGN: DEPENDENCY-INJECTED + FAIL-CLOSED (mirrors scripts/check-certified-promote.ts).
 * - Dependency-injected: every subprocess goes through an injected
 *   `exec(cmd) => { success, output, error? }`, so the whole gather is
 *   exhaustively unit-testable with a mocked exec — no real git/gh in tests.
 * - Fail-closed: a promote advances PRODUCTION. Every fact the gather could NOT
 *   determine is returned as `null`, and the pure verdict library blocks on any
 *   null. Any thrown error while gathering a fact collapses that fact to `null`
 *   (never an optimistic true). The pure parsers (parsePackageJsonVersion,
 *   evaluateBetaCertification) are exported and tested directly.
 *
 * IMPORTANT: reuses `isCleanFastForward` and the pure changelog/version checks
 * from the proven scripts rather than reimplementing them. The fast-forward fact
 * is computed via the EXPORTED `isCleanFastForward(base, target, cwd)` from
 * release-to-production.ts; it is injected through `deps.isCleanFastForward` so
 * tests can stub it (the production default wires the real one).
 *
 * FRESHNESS [GPT F1]: `gatherPromoteFacts` FIRST refreshes `origin/main` + `origin/dev` from the
 * live remote (a read-only `git fetch` refspec — no `main` advance, no push, no working-tree
 * change) so eligibility is proven against the LIVE production target, not a stale local checkout.
 * REPO BINDING [GPT F2]: every `gh` command is passed an explicit `--repo <ownerRepo>` (threaded in
 * via `deps.ownerRepo`, hard-bound to the canonical production repo by the driver) so the cert proof
 * and the PATCH target the same repo, never a mix of explicit-PATCH + implicit-`gh`-context.
 */

import { isCleanFastForward } from './release-to-production';
import { changelogHasVersionHeading, type PromotePreflightFacts } from './promote-preflight';

/** Result shape of an injected command runner — mirrors release-to-production.ts's private `exec`. */
export interface ExecResult {
  success: boolean;
  output: string;
  error?: string;
  exitCode?: number;
}

/**
 * Per-command execution overrides. Both optional so existing single-arg callers and
 * single-arg mock impls stay valid (a function taking fewer args is assignable to `ExecFn`).
 * Used by the production-advance step, which runs a `git push` that triggers the pre-push gate:
 *  - `timeoutMs` raises the default runner timeout so the hook's gate isn't killed mid-push,
 *  - `env` threads `REBEL_CERTIFIED_PROMOTE_SHA` so the pre-push hook takes the certified-promote
 *    fast path (skips the redundant heavy local suites, keeps the safety gate).
 */
export interface ExecOpts {
  /** Per-command timeout override (ms). Defaults to the runner's standard timeout. */
  timeoutMs?: number;
  /** Extra environment variables merged OVER process.env for THIS command only. */
  env?: Record<string, string>;
}

/** The injected command runner. Takes a full command string, never throws to the caller in normal use. */
export type ExecFn = (cmd: string, opts?: ExecOpts) => ExecResult;

/**
 * Canonical git oid: 40-char (SHA-1) or 64-char (SHA-256) lowercase hex, no whitespace.
 * Mirrors check-certified-promote.ts / promote-preflight.ts OID_RE. We validate the SHA shape in
 * THIS impure layer too, before interpolating it into any `git show ${sha}:…` command — defense in
 * depth, independent of the pure verdict's own identity gate.
 */
const OID_RE = /^[0-9a-f]{40}([0-9a-f]{24})?$/;

function isCanonicalOid(value: string): boolean {
  return typeof value === 'string' && OID_RE.test(value);
}

/**
 * A single job from `gh run view <id> --json jobs`. `conclusion` is null while the job
 * has not reached a terminal state (gh reports `conclusion: null` for queued/in-progress).
 */
export interface GhJob {
  name: string;
  status?: string;
  conclusion: string | null;
}

/** A run row from `gh run list ... --json databaseId,headSha,status,conclusion`. */
interface GhRun {
  databaseId: number;
  headSha: string;
  status: string;
  conclusion: string | null;
}

/** The beta-certification bar. `'publish-success'` = the manual-promote bar (PROMOTE §3). */
export type BetaCertBar = 'publish-success' | 'fully-green';

/**
 * Dependencies for {@link gatherPromoteFacts}. Everything impure is injected so the
 * gather is unit-testable end-to-end with a mock `exec`.
 */
export interface GatherPromoteDeps {
  /** Injected command runner (git/gh). */
  exec: ExecFn;
  /** Repo root passed to `isCleanFastForward` (which runs its own bounded git). */
  repoRoot: string;
  /**
   * The canonical `<owner>/<repo>` (e.g. `mindstone/rebel-app`), resolved + hard-bound by the
   * driver BEFORE gathering. Threaded through so EVERY `gh` command targets the SAME explicit repo
   * the ref-update PATCH later targets — the certification proof, the watch, and the PATCH must all
   * be about one repo, not a mix of explicit-PATCH + implicit-`gh`-context [GPT F2]. Required.
   */
  ownerRepo: string;
  /**
   * Fast-forward check — defaults to the proven exported `isCleanFastForward` from
   * release-to-production.ts. Injectable so tests can stub it without touching real git.
   */
  isCleanFastForward?: (baseRef: string, targetRef: string, cwd: string) => boolean;
}

// -----------------------------------------------------------------------------
// PURE PARSERS (exported, tested directly)
// -----------------------------------------------------------------------------

/**
 * Parse a package.json string and return its `.version` IFF it is a string.
 * Returns null on parse error, missing version, or non-string version. Fail-closed:
 * an unreadable/odd version becomes null, which the verdict library blocks on.
 */
export function parsePackageJsonVersion(jsonStr: string): string | null {
  try {
    const parsed = JSON.parse(jsonStr) as { version?: unknown };
    return typeof parsed.version === 'string' ? parsed.version : null;
  } catch {
    return null;
  }
}

/** Lowercase-substring match helper (job-name drift tolerant). */
function nameIncludes(job: GhJob, needle: string): boolean {
  return typeof job.name === 'string' && job.name.toLowerCase().includes(needle.toLowerCase());
}

/** Case-insensitive exact-name match (after trimming). Used where a substring would over-match. */
function nameEquals(job: GhJob, exact: string): boolean {
  return typeof job.name === 'string' && job.name.trim().toLowerCase() === exact.toLowerCase();
}

/**
 * A job group is "required, found, and all-success" iff:
 *  - at least one job matches the predicate (else `found: false` → caller fails CLOSED to null),
 *  - AND every matched job concluded `'success'` (a single non-success matched job ⇒ not all-success).
 *
 * This is the conservative reading: e.g. if macOS has both arm64 and x64 builds, BOTH must be
 * success — a green arm64 with a failed x64 must not pass.
 */
function jobGroupAllSuccess(
  jobs: GhJob[],
  predicate: (job: GhJob) => boolean
): { found: boolean; allSuccess: boolean } {
  const matched = jobs.filter(predicate);
  if (matched.length === 0) return { found: false, allSuccess: false };
  return { found: true, allSuccess: matched.every((j) => j.conclusion === 'success') };
}

/**
 * Evaluate beta certification from a run's jobs, fail-closed.
 *
 * `null` if `jobs` is null/empty (could not determine).
 *
 * For `'publish-success'` (the manual-promote bar — PROMOTE_BETA_TO_PRODUCTION.md §3) we require,
 * all concluded `'success'`:
 *  - the `Publish to Google Cloud Storage` job,
 *  - the validate-and-test job (`Validate & Test / validate`),
 *  - all three platform builds (macOS / Windows / Linux).
 *
 * Matching is by case-insensitive name substring (defensive against minor job-name drift). If a
 * REQUIRED job group can't be found at all, we return `null` rather than a false pass — an absent
 * required job is "could not determine", not "passed". If a required job is found but not all of its
 * matched jobs are `'success'`, we return `false` (genuinely not certified).
 *
 * `'fully-green'` (the stricter overnight-chain bar) is intentionally left for a later stage; it is
 * NOT used by the Stage-2 manual command. We fail CLOSED (`null`) until it's implemented so a caller
 * can never accidentally treat an unimplemented bar as a pass.
 */
export function evaluateBetaCertification(jobs: GhJob[] | null, bar: BetaCertBar): boolean | null {
  if (!jobs || jobs.length === 0) return null;

  // Overnight-chain clean-green logic lives in scripts/lib/ci-clean-green.ts; keep this legacy bar
  // fail-closed until a future orchestrator wires that fact in explicitly.
  if (bar !== 'publish-success') return null;

  // The validate job is specifically "Validate & Test / validate". Match on the EXACT name (not a
  // substring) so we don't sweep in the legitimately-skipped "Validate & Test / Validate Release
  // Changelog" (a substring of which would otherwise drag the group to a false block) or the
  // multiple shard "test (N)" jobs.
  const validate = jobGroupAllSuccess(jobs, (j) => nameEquals(j, 'validate & test / validate'));
  const publish = jobGroupAllSuccess(jobs, (j) => nameIncludes(j, 'publish to google cloud storage'));
  // Platform builds: keyed off the "Build <platform>" job names. Each platform may have >1 build
  // (e.g. macOS arm64 + x64); jobGroupAllSuccess requires every matched build for the platform.
  const macBuild = jobGroupAllSuccess(jobs, (j) => nameIncludes(j, 'build mac'));
  const winBuild = jobGroupAllSuccess(jobs, (j) => nameIncludes(j, 'build win'));
  const linuxBuild = jobGroupAllSuccess(jobs, (j) => nameIncludes(j, 'build linux'));

  const groups = [validate, publish, macBuild, winBuild, linuxBuild];

  // Fail-closed on job-name drift: if any required group is entirely absent, we genuinely
  // could not determine certification → null (the verdict library blocks).
  if (groups.some((g) => !g.found)) return null;

  // All required groups found: certified iff every one is all-success.
  return groups.every((g) => g.allSuccess);
}

// -----------------------------------------------------------------------------
// FACT GATHERING (impure, via injected exec — each fact fail-closed to null)
// -----------------------------------------------------------------------------

/** Run an injected command and return trimmed output on success, else null. Never throws. */
function execOutput(exec: ExecFn, cmd: string): string | null {
  try {
    const result = exec(cmd);
    return result.success ? result.output.trim() : null;
  } catch {
    return null;
  }
}

/** Run an injected command and return whether it succeeded. Never throws (throw ⇒ false). */
function execOk(exec: ExecFn, cmd: string): boolean {
  try {
    return exec(cmd).success === true;
  } catch {
    return false;
  }
}

/**
 * Run an injected PREDICATE command (one whose exit status IS the answer, e.g.
 * `git merge-base --is-ancestor` / `git rev-parse --verify`) as a TRI-STATE:
 *  - `true`  — exit 0 (the predicate holds),
 *  - `false` — the EXPECTED negative exit (1) — git's documented "not an ancestor" / "no such object",
 *  - `null`  — any other failure (exit 128 = bad repo / missing ref, timeout, undefined exit, or a
 *             thrown exec). These are "could not determine", NOT a determinate false → fail-closed.
 *
 * Distinguishing exit 1 from exit 128 matters: a determinate `false` lets the verdict say *why* it
 * blocked ("SHA is not on dev"), whereas `null` says "couldn't check" — both block, but the report
 * is honest. When `exitCode` is unavailable on a failure, we conservatively return `null`.
 */
function execPredicate(exec: ExecFn, cmd: string): boolean | null {
  try {
    const result = exec(cmd);
    if (result.success) return true;
    return result.exitCode === 1 ? false : null;
  } catch {
    return null;
  }
}

/**
 * Parse the raw text of a `.gitmodules` file into the submodule (path, branch) pairs.
 * Branch defaults to `main` when a submodule declares none. Returns null if the content is empty
 * or yields no submodules, so the submodule gate fails CLOSED. Pure — exported for direct testing.
 *
 * IMPORTANT: the caller reads `.gitmodules` AT THE CERTIFIED SHA (`git show <sha>:.gitmodules`), not
 * the working tree — the facts must describe the SHA's tree, so a `.gitmodules` that changed after
 * the SHA can't make us miss (or invent) a submodule the SHA actually pins.
 */
export function parseSubmoduleConfig(
  gitmodulesContent: string
): Array<{ path: string; branch: string }> | null {
  if (!gitmodulesContent) return null;

  // Group into [submodule "<name>"] sections; collect path + branch per section.
  const byName = new Map<string, { path?: string; branch: string }>();
  let currentName: string | null = null;

  for (const rawLine of gitmodulesContent.split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#') || line.startsWith(';')) continue;

    const sectionMatch = /^\[submodule\s+"([^"]+)"\]$/.exec(line);
    if (sectionMatch) {
      currentName = sectionMatch[1];
      if (!byName.has(currentName)) byName.set(currentName, { branch: 'main' });
      continue;
    }

    if (!currentName) continue;
    const kvMatch = /^(\w+)\s*=\s*(.+)$/.exec(line);
    if (!kvMatch) continue;
    const key = kvMatch[1].toLowerCase();
    const value = kvMatch[2].trim();
    const entry = byName.get(currentName);
    if (!entry) continue;
    if (key === 'path') entry.path = value;
    else if (key === 'branch' && value) entry.branch = value;
  }

  const result = Array.from(byName.values())
    .filter((e): e is { path: string; branch: string } => typeof e.path === 'string' && e.path.length > 0)
    .map((e) => ({ path: e.path, branch: e.branch }));

  return result.length > 0 ? result : null;
}

/**
 * Parse the gitlink commit oid for `submodulePath` out of `git ls-tree <sha> <path>` output.
 * Expected line shape: `160000 commit <oid>\t<path>`. Returns null if the line is absent,
 * not a gitlink (mode 160000), or has no oid.
 */
export function parseGitlinkOid(lsTreeOutput: string): string | null {
  const line = lsTreeOutput.split('\n').map((l) => l.trim()).find((l) => l.length > 0);
  if (!line) return null;
  // `<mode> <type> <oid>\t<path>`
  const match = /^160000\s+commit\s+([0-9a-f]{40}([0-9a-f]{24})?)\s/.exec(line);
  return match ? match[1] : null;
}

/** SHA resolves to a real commit object in this repo. Tri-state: bad object ⇒ false, error ⇒ null. */
function gatherShaIsValidCommit(exec: ExecFn, sha: string): boolean | null {
  // `^{commit}` ensures it's a commit object, not just any object.
  return execPredicate(exec, `git rev-parse --verify ${sha}^{commit}`);
}

/** SHA is an ancestor of origin/dev (genuinely on the dev line). Tri-state (exit 1 ⇒ false, else null). */
function gatherShaIsAncestorOfDev(exec: ExecFn, sha: string): boolean | null {
  return execPredicate(exec, `git merge-base --is-ancestor ${sha} origin/dev`);
}

/** package.json version at a ref via `git show <ref>:package.json`. null if unreadable/unparseable. */
function gatherVersionAtRef(exec: ExecFn, ref: string): string | null {
  const content = execOutput(exec, `git show ${ref}:package.json`);
  if (content === null) return null;
  return parsePackageJsonVersion(content);
}

/**
 * Beta certification for THIS exact SHA: find the dev release.yml run whose headSha matches,
 * read its jobs, and evaluate the `'publish-success'` bar. null on any gh failure, no matching
 * run, parse failure, or jobs that can't be read (fail-closed).
 */
function gatherBetaCertified(exec: ExecFn, sha: string, ownerRepo: string): boolean | null {
  const listOut = execOutput(
    exec,
    `gh run list --repo ${ownerRepo} --workflow release.yml --branch dev --commit ${sha} --json databaseId,headSha,status,conclusion`
  );
  if (listOut === null) return null;

  let runs: GhRun[];
  try {
    const parsed = JSON.parse(listOut);
    if (!Array.isArray(parsed)) return null;
    runs = parsed as GhRun[];
  } catch {
    return null;
  }

  // Pick the run whose headSha matches the certified SHA exactly (don't trust list ordering).
  const run = runs.find((r) => r.headSha === sha);
  if (!run || typeof run.databaseId !== 'number') return null;

  const viewOut = execOutput(exec, `gh run view ${run.databaseId} --repo ${ownerRepo} --json jobs`);
  if (viewOut === null) return null;

  let jobs: GhJob[] | null;
  try {
    const parsed = JSON.parse(viewOut) as { jobs?: unknown };
    jobs = Array.isArray(parsed.jobs) ? (parsed.jobs as GhJob[]) : null;
  } catch {
    return null;
  }

  return evaluateBetaCertification(jobs, 'publish-success');
}

/**
 * Changelog `## v<version>` heading present AT THE SHA, submodule-aware: read the rebel-system
 * gitlink pinned by the SHA's tree, then read help-for-humans/changelog.md at THAT submodule
 * commit. null if the SHA version is unknown, the ls-tree fails, the gitlink can't be parsed, or
 * the submodule show fails.
 */
function gatherChangelogHeadingAtSha(exec: ExecFn, sha: string, shaVersion: string | null): boolean | null {
  if (!shaVersion) return null;

  const lsTree = execOutput(exec, `git ls-tree ${sha} rebel-system`);
  if (lsTree === null) return null;

  const subOid = parseGitlinkOid(lsTree);
  if (!subOid) return null;

  // Read the changelog at the pinned submodule commit (inside the submodule's own object store).
  const content = execOutput(exec, `git -C rebel-system show ${subOid}:help-for-humans/changelog.md`);
  if (content === null) return null;

  return changelogHasVersionHeading(content, shaVersion);
}

/**
 * Submodule-resolvability gate (defense-in-depth; catches the OSS-squash orphan case).
 *
 * For every submodule the SHA pins, verify its pinned oid is reachable from its tracked remote
 * branch:
 *  - read the pinned oid from the SHA's tree (`git ls-tree <sha> <path>`),
 *  - fetch the submodule's remote,
 *  - check `git -C <path> merge-base --is-ancestor <oid> origin/<branch>`.
 *
 * Returns:
 *  - `true`  iff ALL submodules' pins resolve (reachable),
 *  - `false` if any pin is genuinely NOT reachable (e.g. rebel-system's orphaned pin after the
 *            OSS squash) — a determinate "stale pin" that must block,
 *  - `null`  if we genuinely could not determine (modules unreadable, a pin oid can't be parsed,
 *            or a fetch failed — the latter means "unknown reachability", not "unreachable").
 */
function gatherSubmodulePointersResolve(exec: ExecFn, sha: string): boolean | null {
  // Read .gitmodules AT THE SHA (not the working tree) so the submodule set matches the SHA's tree.
  const gitmodulesAtSha = execOutput(exec, `git show ${sha}:.gitmodules`);
  if (gitmodulesAtSha === null) return null; // can't read the SHA's .gitmodules → undeterminable

  const submodules = parseSubmoduleConfig(gitmodulesAtSha);
  if (submodules === null || submodules.length === 0) return null;

  let allReachable = true;

  for (const { path, branch } of submodules) {
    const lsTree = execOutput(exec, `git ls-tree ${sha} ${path}`);
    if (lsTree === null) return null; // can't read the pin → undeterminable

    const oid = parseGitlinkOid(lsTree);
    if (!oid) return null; // pin not a parseable gitlink → undeterminable

    // Refresh the remote-tracking ref explicitly (an `+refs/heads/<b>:refs/remotes/origin/<b>`
    // refspec, not a bare `fetch origin <b>` which only updates FETCH_HEAD) so the subsequent
    // ancestry check is against a fresh `origin/<branch>`, not stale local state. A fetch failure
    // means we cannot KNOW reachability → fail-closed to null (not a determinate "unreachable").
    if (!execOk(exec, `git -C ${path} fetch --quiet origin +refs/heads/${branch}:refs/remotes/origin/${branch}`)) {
      return null;
    }

    // Reachable from the tracked remote branch? An orphaned pin (history rewrite) is NOT.
    // Tri-state: exit 1 ⇒ determinate not-reachable (false); any other failure ⇒ undeterminable (null).
    const reachable = execPredicate(exec, `git -C ${path} merge-base --is-ancestor ${oid} origin/${branch}`);
    if (reachable === null) return null; // couldn't determine this pin → whole gate undeterminable
    if (reachable === false) {
      allReachable = false; // determinate: this pin is stale/orphaned → the gate must report false
    }
  }

  return allReachable;
}

/**
 * Gather all promote pre-flight facts via injected git/gh, fail-closed. Every fact the gather could
 * not determine is `null`; the pure verdict library (evaluatePromotePreflight) blocks on any null.
 * The returned object is exactly the `PromotePreflightFacts` the verdict library consumes.
 */
export function gatherPromoteFacts(
  certifiedSha: string,
  deps: GatherPromoteDeps
): PromotePreflightFacts {
  const { exec, repoRoot, ownerRepo } = deps;
  const cleanFastForward = deps.isCleanFastForward ?? isCleanFastForward;

  // FRESHNESS [GPT F1]: the eligibility proof must describe the LIVE production target, not a
  // possibly-stale local checkout. We later PATCH the live `main` ref, so refresh `origin/main` and
  // `origin/dev` FIRST — before any fact that reads them (`origin/main:package.json`,
  // `merge-base --is-ancestor <sha> origin/dev`, `isCleanFastForward('origin/main', …)`). An
  // explicit refspec updates the remote-tracking refs (not just FETCH_HEAD). This is a READ-ONLY
  // remote-ref refresh — it never touches `main`, never pushes, never mutates the working tree — so
  // it is safe (and desirable, for an accurate preview) to run in dry-run/--explain-json too.
  //
  // FAIL-CLOSED on a FAILED refresh [GPT F1 round-2]: if the fetch fails we CANNOT prove live state,
  // so every fact that reads `origin/main`/`origin/dev` (main version, dev-ancestry, fast-forward) is
  // forced to `null` below and the verdict blocks. We must NOT trust stale-but-readable local refs:
  // `force=false` only guards a non-fast-forward, NOT a stale version-ahead proof. Facts that don't
  // read those refs (shaVersion@SHA, beta-cert via live gh, changelog@SHA, submodule reachability via
  // its own per-pin fetches) are unaffected by a failed top-level refresh.
  const refreshed = execOk(
    exec,
    'git fetch --quiet origin +refs/heads/main:refs/remotes/origin/main +refs/heads/dev:refs/remotes/origin/dev'
  );

  // OID guard (defense in depth): a malformed/non-canonical SHA must NOT be interpolated into
  // `git show ${sha}:…` / `git ls-tree ${sha} …` etc. Refuse to run any git/gh against it — report
  // a determinate `shaIsValidCommit: false` (the pure verdict's sha-valid gate also rejects it
  // independently) and leave every SHA-dependent fact null. main-version is the one fact that
  // doesn't depend on the candidate SHA, so we still read it.
  if (!isCanonicalOid(certifiedSha)) {
    return {
      certifiedSha,
      shaIsValidCommit: false,
      shaIsAncestorOfDev: null,
      betaCertified: null,
      changelogHeadingAtSha: null,
      mainIsAncestorOfSha: null,
      submodulePointersResolve: null,
      shaVersion: null,
      // origin/main read only if the refresh succeeded (else stale → null); moot here anyway
      // since shaIsValidCommit:false already blocks, but never present a stale ref as a fact.
      mainVersion: refreshed ? gatherVersionAtRef(exec, 'origin/main') : null,
    };
  }

  // Versions first — the changelog-at-SHA read depends on the SHA's version.
  const shaVersion = gatherVersionAtRef(exec, certifiedSha);
  // origin/main version only if the refresh succeeded — else we'd compare against a stale main.
  const mainVersion = refreshed ? gatherVersionAtRef(exec, 'origin/main') : null;

  // Fast-forward fact via the proven helper; isolate a throw to null (fail-closed). Also null if the
  // refresh failed — a FF check against a stale origin/main is not a live-state proof.
  let mainIsAncestorOfSha: boolean | null;
  if (!refreshed) {
    mainIsAncestorOfSha = null;
  } else {
    try {
      mainIsAncestorOfSha = cleanFastForward('origin/main', certifiedSha, repoRoot);
    } catch {
      mainIsAncestorOfSha = null;
    }
  }

  return {
    certifiedSha,
    shaIsValidCommit: gatherShaIsValidCommit(exec, certifiedSha),
    // dev-ancestry only if the refresh succeeded — else origin/dev may be stale.
    shaIsAncestorOfDev: refreshed ? gatherShaIsAncestorOfDev(exec, certifiedSha) : null,
    betaCertified: gatherBetaCertified(exec, certifiedSha, ownerRepo),
    changelogHeadingAtSha: gatherChangelogHeadingAtSha(exec, certifiedSha, shaVersion),
    mainIsAncestorOfSha,
    submodulePointersResolve: gatherSubmodulePointersResolve(exec, certifiedSha),
    shaVersion,
    mainVersion,
  };
}
