/**
 * ============================================================================
 * Promote pre-flight — pure, fail-closed gate evaluator
 * ============================================================================
 *
 * The safety core of the CI-triggered production promote (see
 * docs/plans/260619_ci-triggered-promote/PLAN.md, Stage 1). Given facts the
 * caller has already gathered (git/gh), it returns a structured go/no-go verdict
 * over the promote gates.
 *
 * DESIGN: PURE + FAIL-CLOSED.
 * - Pure: the evaluator takes already-computed facts (booleans / version strings)
 *   and does no I/O, so it is exhaustively unit-testable — the same
 *   dependency-injection shape as scripts/check-certified-promote.ts. The impure
 *   "gather the facts" wiring (git rev-parse, gh run list, submodule probes) lives
 *   in the caller (the promote command / overnight orchestrator) and feeds this.
 * - Fail-closed: a promote advances PRODUCTION. Any fact the caller could NOT
 *   determine arrives as `null` and MUST block. The default is "do not promote";
 *   eligibility is granted only when every required gate AFFIRMATIVELY passes.
 *   A thrown error anywhere collapses to a fully-blocked verdict.
 *
 * SCOPE (Stage 1): the gates that qualify a *frozen, beta-certified SHA* for a
 * fast-forward promote — SHA validity, on-dev, beta-certified, changelog heading
 * at the SHA, clean fast-forward, submodule-resolvability, version-ahead. The
 * overnight chain's additional auto-blocking gates (deterministic Sentry gate,
 * clean-green parsing, optional soak/exposure, candidate-binding) extend this in
 * Stage 7 and feed their results in as additional facts/gates there.
 */

import * as semver from 'semver';

export type GateName =
  | 'sha-valid'
  | 'sha-on-dev'
  | 'beta-certified'
  | 'changelog-heading'
  | 'fast-forward'
  | 'submodules-resolve'
  | 'version-ahead'
  | 'internal-error';

/** Canonical git oid: 40-char (SHA-1) or 64-char (SHA-256) lowercase hex, no whitespace. Mirrors check-certified-promote's OID_RE. */
const OID_RE = /^[0-9a-f]{40}([0-9a-f]{24})?$/;
/** Canonical STABLE production version: exactly X.Y.Z — no leading `v`, prerelease, or build metadata. */
const CANONICAL_STABLE_VERSION_RE = /^\d+\.\d+\.\d+$/;

function isCanonicalOid(value: string): boolean {
  return typeof value === 'string' && OID_RE.test(value);
}

export type GateStatus = 'pass' | 'block';

export interface GateResult {
  gate: GateName;
  status: GateStatus;
  reason: string;
}

export interface PromotePreflightVerdict {
  /** true ONLY if every required gate passed. Fail-closed: any null/ambiguous ⇒ false. */
  eligible: boolean;
  /** every gate's result, in evaluation order (stable for reporting/evidence). */
  gates: GateResult[];
  /** names of gates that blocked (empty iff eligible). */
  blockers: GateName[];
  /** one-line, human-legible summary (never a bare "GO" — names what blocked). */
  summary: string;
}

/**
 * Facts gathered by the caller and passed in. Every "could not determine" fact is
 * `null` and blocks (fail-closed). Booleans are the affirmative determination.
 */
export interface PromotePreflightFacts {
  /** the candidate beta-certified SHA being promoted (full 40-char oid; for messages). */
  certifiedSha: string;
  /** SHA resolves to a real commit object in this repo. */
  shaIsValidCommit: boolean | null;
  /** SHA is an ancestor of origin/dev (i.e. genuinely on the dev line). */
  shaIsAncestorOfDev: boolean | null;
  /**
   * Beta certification: the beta release.yml run for THIS exact SHA met the required
   * bar. The caller computes the bar — PROMOTE §3 (publish-to-gcs success) for a manual
   * promote; the stricter fully-green for the overnight chain (Stage 7). null = could
   * not determine (no run / parse failure) ⇒ block.
   */
  betaCertified: boolean | null;
  /** the `## v<version>` heading exists in the changelog AT THE SHA (submodule-aware read). */
  changelogHeadingAtSha: boolean | null;
  /** origin/main is an ancestor of the SHA (a clean fast-forward — production tree == certified tree). */
  mainIsAncestorOfSha: boolean | null;
  /** every submodule pointer baked into the SHA's tree resolves on its remote (no orphaned pins). */
  submodulePointersResolve: boolean | null;
  /** package.json version at the SHA (semver string), or null if unreadable. */
  shaVersion: string | null;
  /** package.json version on origin/main (semver string), or null if unreadable. */
  mainVersion: string | null;
}

/** Build a gate result from a boolean|null fact, fail-closed on null. */
function booleanGate(
  gate: GateName,
  fact: boolean | null,
  passReason: string,
  blockReason: string
): GateResult {
  if (fact === true) return { gate, status: 'pass', reason: passReason };
  if (fact === false) return { gate, status: 'block', reason: blockReason };
  // null / undefined / anything non-true ⇒ fail-closed
  return { gate, status: 'block', reason: `${blockReason} (could not determine — fail-closed)` };
}

/**
 * The sha-valid gate: BOTH a canonical full-hex oid (validated here, independent of the
 * caller) AND the caller's git proof that it's a real commit object. F1: identity must
 * fail closed on its own — a malformed/empty/whitespace/short/non-hex SHA blocks even if
 * the caller asserted `shaIsValidCommit: true`.
 */
function shaValidGate(certifiedSha: string, shaIsValidCommit: boolean | null): GateResult {
  const gate: GateName = 'sha-valid';
  if (!isCanonicalOid(certifiedSha)) {
    return {
      gate,
      status: 'block',
      reason: `certifiedSha is not a canonical full hex oid: "${certifiedSha}" (fail-closed)`,
    };
  }
  return booleanGate(
    gate,
    shaIsValidCommit,
    'SHA is a canonical oid and a valid commit object',
    'SHA is not a valid commit object'
  );
}

/**
 * The version-ahead gate. F2: production requires a CANONICAL STABLE version (exactly X.Y.Z) —
 * prerelease (`0.4.50-beta.1`), leading-`v` (`v0.4.50`), and build-metadata (`0.4.50+sha`) forms
 * all block. Then both must be valid semver AND sha > main.
 */
function versionGate(shaVersion: string | null, mainVersion: string | null): GateResult {
  const gate: GateName = 'version-ahead';
  if (!shaVersion || !mainVersion) {
    return { gate, status: 'block', reason: 'sha or main version unreadable (fail-closed)' };
  }
  if (!CANONICAL_STABLE_VERSION_RE.test(shaVersion) || !CANONICAL_STABLE_VERSION_RE.test(mainVersion)) {
    return {
      gate,
      status: 'block',
      reason: `non-canonical stable version (sha=${shaVersion}, main=${mainVersion}); production requires X.Y.Z (fail-closed)`,
    };
  }
  // Canonical X.Y.Z is always valid semver; compare defensively all the same.
  if (semver.valid(shaVersion) && semver.valid(mainVersion) && semver.compare(shaVersion, mainVersion) > 0) {
    return { gate, status: 'pass', reason: `sha v${shaVersion} > main v${mainVersion}` };
  }
  return {
    gate,
    status: 'block',
    reason: `sha v${shaVersion} is not ahead of main v${mainVersion}`,
  };
}

/**
 * Evaluate the promote pre-flight gates. PURE + FAIL-CLOSED: returns eligible:true
 * only when every gate affirmatively passes; any null fact, false fact, or thrown
 * error yields a blocked verdict.
 */
export function evaluatePromotePreflight(facts: PromotePreflightFacts): PromotePreflightVerdict {
  try {
    const shortSha = (facts.certifiedSha ?? '').slice(0, 12) || '<unknown-sha>';
    const gates: GateResult[] = [
      shaValidGate(facts.certifiedSha, facts.shaIsValidCommit),
      booleanGate(
        'sha-on-dev',
        facts.shaIsAncestorOfDev,
        'SHA is on origin/dev',
        'SHA is not an ancestor of origin/dev'
      ),
      booleanGate(
        'beta-certified',
        facts.betaCertified,
        'beta release for this SHA met the certification bar',
        'beta release for this SHA is not certified'
      ),
      booleanGate(
        'changelog-heading',
        facts.changelogHeadingAtSha,
        'changelog has the version heading at the SHA',
        'changelog is missing the `## v<version>` heading at the SHA'
      ),
      booleanGate(
        'fast-forward',
        facts.mainIsAncestorOfSha,
        'origin/main is an ancestor of the SHA (clean fast-forward)',
        'not a fast-forward — origin/main has diverged from the SHA'
      ),
      booleanGate(
        'submodules-resolve',
        facts.submodulePointersResolve,
        'all submodule pointers at the SHA resolve on their remotes',
        'a submodule pointer at the SHA is unresolvable (orphaned by a history rewrite?) — cut a fresh beta'
      ),
      versionGate(facts.shaVersion, facts.mainVersion),
    ];

    const blockers = gates.filter((g) => g.status === 'block').map((g) => g.gate);
    const eligible = blockers.length === 0;
    const summary = eligible
      ? `ELIGIBLE — all ${gates.length} promote gates passed for ${shortSha}`
      : `BLOCKED (${blockers.length}/${gates.length}) for ${shortSha} — ${blockers.join(', ')}`;

    return { eligible, gates, blockers, summary };
  } catch (error) {
    // Fail-closed: any unexpected error blocks the promote outright. Emit an explicit
    // `internal-error` blocked gate so the "blockers is non-empty iff not eligible"
    // invariant holds (F3) — a consumer gating on `blockers.length === 0` stays safe.
    const reason = error instanceof Error ? error.message : String(error);
    return {
      eligible: false,
      gates: [{ gate: 'internal-error', status: 'block', reason: `evaluation errored (fail-closed): ${reason}` }],
      blockers: ['internal-error'],
      summary: `BLOCKED — pre-flight evaluation errored (fail-closed): ${reason}`,
    };
  }
}

/**
 * Pure changelog check: does `content` contain a `## v<version>` heading?
 * Extracted to share one definition between this pre-flight (reading the changelog
 * AT THE SHA — submodule-aware) and the release script's working-tree check
 * (scripts/release-to-production.ts validateChangelogForRelease). The caller is
 * responsible for resolving + reading the changelog content at the right commit.
 */
export function changelogHasVersionHeading(content: string, version: string): boolean {
  if (!content || !version) return false;
  const pattern = new RegExp(`^## v${version.replace(/\./g, '\\.')}(\\s|$)`, 'm');
  return pattern.test(content);
}
