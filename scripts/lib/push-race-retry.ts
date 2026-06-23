/**
 * Push-race classification + auto-retry decision for git-safe-sync.
 *
 * Stage 7 of docs/plans/260611_prepush-gate-speedup/PLAN.md (see the
 * `2026-06-11 18:15` Decision Log entry — the consolidated spec): when a push
 * loses the fetch→push race to another machine's push, git-safe-sync respawns
 * ITSELF once as a fresh process (`--retry-leg`) instead of re-entering its
 * 2k-line sync body in-process. The fresh-process shape avoids every traced
 * re-entrancy hazard (lock self-contention, once-only timing finalization,
 * the autostash pop living in a `finally` inside the body, backup-branch
 * naming collisions).
 *
 * This module holds the pure, unit-testable pieces:
 *
 *   1. `classifyPushFailure` — structured failure classification. NEVER the
 *      old bare-substring heuristic: `'[rejected]'` is a substring of
 *      `'[remote rejected]'` (a hook/policy decline, NOT a race), and the
 *      pre-push hook's stderr (the full validate gate, including this very
 *      script's tests) can legitimately contain words like
 *      "non-fast-forward". Race classification requires BOTH a specific
 *      rejection status line AND evidence the remote tip actually moved
 *      between our fetch and the failed push. Two status-line shapes qualify:
 *      a plain `[rejected] (non-fast-forward | fetch first)`, and — on a
 *      ruleset-protected branch — a `[remote rejected]` line whose reason is
 *      a `cannot lock ref … is at X but expected Y` compare-and-swap (CAS)
 *      miss. Generic `[remote rejected]` (hook/policy decline) stays non-race;
 *      the CAS exception is anchored to its own status line so hook stderr
 *      that merely echoes the phrase can't trip it (see CAS_REF_LOCK_LINE).
 *   2. `decidePushRetry` — the retry decision matrix (default-ON, with
 *      `--no-retry` / env opt-outs; conservative: autostash disables it).
 *   3. `buildRetryLegSpawnPlan` — the self-respawn argv/env. `--retry-leg`
 *      is appended exactly once, and GIT_SAFE_SYNC_RETRY_DEPTH provides a
 *      belt-and-braces bound so even a mangled flag can't loop.
 */

/** Hidden internal flag marking the respawned retry leg. */
export const RETRY_LEG_FLAG = '--retry-leg';

/** Env opt-out: any non-empty value disables the auto-retry. */
export const NO_RETRY_ENV = 'GIT_SAFE_SYNC_NO_RETRY';

/**
 * Env depth guard: set to 1 on the spawned retry leg. The decision matrix
 * refuses to retry at depth ≥ 1 even if `--retry-leg` got lost, so a single
 * retry is bounded by construction AND by environment.
 */
export const RETRY_DEPTH_ENV = 'GIT_SAFE_SYNC_RETRY_DEPTH';

export type PushRejectionShape =
  | 'non-ff-rejected'
  | 'remote-rejected'
  | 'cas-ref-lock'
  | 'other';

export type PushFailureKind = 'race-non-ff' | 'non-race';

export interface RemoteTipEvidence {
  /**
   * The remote-tracking ref's sha at push time — i.e. the remote tip we
   * fetched and merged. A failed push leaves it untouched, so it can be
   * resolved after the failure. Null if unresolvable.
   */
  fetchedRemoteTip: string | null;
  /**
   * The remote branch tip observed AFTER the failed push (one `git
   * ls-remote`). Null if the probe failed (network, etc.).
   */
  observedRemoteTip: string | null;
}

export interface PushFailureClassification {
  kind: PushFailureKind;
  rejectionShape: PushRejectionShape;
  /** 'unknown' when either tip could not be resolved (⇒ never a race). */
  remoteMoved: boolean | 'unknown';
  /** Human/telemetry-readable one-liner explaining the verdict. */
  reason: string;
}

/**
 * Matches git's per-ref non-fast-forward rejection status line:
 *
 *     ! [rejected]        dev -> dev (non-fast-forward)
 *     ! [rejected]        dev -> dev (fetch first)
 *
 * Anchored on `! [rejected]` followed by a `(non-fast-forward)` /
 * `(fetch first)` reason on the SAME line. `! [remote rejected] …` can never
 * match: after `!` the bracket content starts with `remote`, and this regex
 * requires the bracket to open directly with `rejected]`.
 */
const NON_FF_REJECTED_LINE = /^\s*!\s*\[rejected\][^\n]*\((?:non-fast-forward|fetch first)\)/m;

/**
 * Matches git's remote-side rejection status line (pre-receive/update hook
 * declines, push protection, protected refs):
 *
 *     ! [remote rejected] dev -> dev (pre-receive hook declined)
 *
 * Checked FIRST and conservatively: if any ref was remote-rejected, the
 * failure is never classified as a race, even if another line looks non-FF.
 */
const REMOTE_REJECTED_LINE = /^\s*!\s*\[remote rejected\]/m;

/**
 * Matches GitHub's compare-and-swap (CAS) ref-lock rejection on a single git
 * per-ref status line. On a ruleset-protected branch (e.g. `dev` with "Changes
 * must be made through a pull request", which we hold bypass on), a LOST PUSH
 * RACE is surfaced as a `[remote rejected]` line — NOT a plain
 * `[rejected] (non-fast-forward)` — with the reason:
 *
 *     ! [remote rejected] dev -> dev (cannot lock ref 'refs/heads/dev': is at <newSHA> but expected <oldSHA>)
 *
 * That `is at X but expected Y` IS the lost compare-and-swap: `expected` is the
 * tip we fetched and tried to swap against, `is at` is where the remote
 * actually moved to. So the two SHAs are direct, atomic proof the remote tip
 * moved between our fetch and our push — stronger than the post-hoc
 * `ls-remote` probe (no TOCTOU window). Because it wears `[remote rejected]`
 * clothing, the generic REMOTE_REJECTED_LINE check would otherwise misfile it
 * as a policy decline and the auto-retry would never fire (the very gap this
 * matcher closes). A genuine policy decline (`pre-receive hook declined`, push
 * protection, GH013 rule violations) does NOT carry the `cannot lock ref …
 * expected` reason on its status line, so it still falls through to
 * REMOTE_REJECTED_LINE → non-race.
 *
 * CRITICAL — anchored to the `! [remote rejected]` status line and confined to
 * that one line (`[^\n]`). `cleanedStderr` also contains the pre-push hook's
 * own stderr (the full validate gate + this very test file), so a free-floating
 * scan for the CAS words would let hook/test/log output that merely *echoes*
 * the phrase get promoted to a race — the exact "hook stderr echoes race-like
 * text" trap this module's header warns about. Git emits the ref-lock reason on
 * one physical status line (terminal soft-wrap is cosmetic, not a real newline),
 * so single-line anchoring loses no real shape; if a future git wraps it, we
 * simply fall through to non-race (safe: no auto-retry, never a false retry).
 * The captured SHAs are validated by `normalizeSha` (exactly 40 hex); anything
 * else falls back to the ls-remote evidence rather than guessing.
 */
const CAS_REF_LOCK_LINE =
  /^\s*!\s*\[remote rejected\][^\n]*\bcannot lock ref\b[^\n]*?\bis at\s+([0-9a-f]{7,40})\b[^\n]*?\bbut expected\s+([0-9a-f]{7,40})\b/im;

function normalizeSha(sha: string | null): string | null {
  // Exactly 40 hex chars: both evidence probes (`git rev-parse`, `git
  // ls-remote`) emit full shas, and accepting abbreviations would let an
  // abbreviated-vs-full sha of the SAME tip classify as "moved" (exec-review
  // probe A11). Anything shorter normalizes to null ⇒ remoteMoved 'unknown'
  // ⇒ fail-closed non-race.
  const trimmed = sha?.trim().toLowerCase() ?? '';
  return /^[0-9a-f]{40}$/.test(trimmed) ? trimmed : null;
}

/**
 * Classifies a failed `git push`. `kind === 'race-non-ff'` requires BOTH:
 *   - a qualifying rejection status-line shape — either a plain non-FF
 *     `[rejected]` line, OR a CAS `[remote rejected] … cannot lock ref … is at
 *     X but expected Y` line (the protected-branch race; generic
 *     `[remote rejected]` policy declines do NOT qualify), AND
 *   - evidence the remote tip actually moved vs the tip we fetched.
 * Everything else — including "we can't tell whether the remote moved" — is
 * 'non-race' (fail-closed: no auto-retry on uncertain classification).
 */
export function classifyPushFailure(
  cleanedStderr: string,
  evidence: RemoteTipEvidence,
): PushFailureClassification {
  const fetched = normalizeSha(evidence.fetchedRemoteTip);
  const observed = normalizeSha(evidence.observedRemoteTip);
  const remoteMoved: boolean | 'unknown' =
    fetched && observed ? fetched !== observed : 'unknown';

  // CAS ref-lock race — checked BEFORE the generic [remote rejected] decline,
  // because a lost compare-and-swap on a protected branch arrives wearing
  // [remote rejected] clothing but IS a race (see CAS_REF_LOCK_REASON). Prefer
  // the SHAs embedded in the reason (atomic with the failure) over the ls-remote
  // probe; fall back to ls-remote evidence when the embedded SHAs aren't a clean
  // 40-hex pair. Fail-closed: unverifiable movement ⇒ non-race (no auto-retry).
  const cas = CAS_REF_LOCK_LINE.exec(cleanedStderr);
  if (cas) {
    const isAt = normalizeSha(cas[1]);
    const expected = normalizeSha(cas[2]);
    const embeddedMoved: boolean | null = isAt && expected ? isAt !== expected : null;
    const casMoved: boolean | 'unknown' = embeddedMoved !== null ? embeddedMoved : remoteMoved;
    if (casMoved === true) {
      return {
        kind: 'race-non-ff',
        rejectionShape: 'cas-ref-lock',
        remoteMoved: casMoved,
        reason:
          'compare-and-swap ref-lock rejection and the remote tip moved — lost push race (CAS)',
      };
    }
    return {
      kind: 'non-race',
      rejectionShape: 'cas-ref-lock',
      remoteMoved: casMoved,
      reason:
        casMoved === 'unknown'
          ? 'CAS ref-lock rejection but remote movement could not be verified'
          : 'CAS ref-lock rejection but the remote tip did not move',
    };
  }

  if (REMOTE_REJECTED_LINE.test(cleanedStderr)) {
    return {
      kind: 'non-race',
      rejectionShape: 'remote-rejected',
      remoteMoved,
      reason: 'remote-side rejection (hook/policy decline) — not a push race',
    };
  }

  if (NON_FF_REJECTED_LINE.test(cleanedStderr)) {
    if (remoteMoved === true) {
      return {
        kind: 'race-non-ff',
        rejectionShape: 'non-ff-rejected',
        remoteMoved,
        reason: 'non-fast-forward rejection and the remote tip moved — lost push race',
      };
    }
    return {
      kind: 'non-race',
      rejectionShape: 'non-ff-rejected',
      remoteMoved,
      reason:
        remoteMoved === 'unknown'
          ? 'non-fast-forward rejection but remote movement could not be verified'
          : 'non-fast-forward rejection but the remote tip did not move',
    };
  }

  return {
    kind: 'non-race',
    rejectionShape: 'other',
    remoteMoved,
    reason: 'push failure does not match a non-fast-forward rejection',
  };
}

export interface PushRetryDecisionInput {
  failureKind: PushFailureKind;
  /** True iff this run actually created an autostash (GPT F5: conservative). */
  autostashCreated: boolean;
  /** True iff this process IS the respawned retry leg (`--retry-leg`). */
  isRetryLeg: boolean;
  /** True iff `--no-retry` was passed. */
  noRetryFlag: boolean;
  env: Record<string, string | undefined>;
}

export interface PushRetryDecision {
  retry: boolean;
  reason: string;
}

/** Parses GIT_SAFE_SYNC_RETRY_DEPTH; unset/garbage/negative ⇒ 0. */
export function parseRetryDepth(value: string | undefined): number {
  const parsed = Number.parseInt(value ?? '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

/**
 * The retry decision matrix. Retry iff the failure is a classified race AND
 * no autostash was created AND this is not already the retry leg (flag OR
 * depth env) AND no opt-out is active. Default-ON otherwise.
 */
export function decidePushRetry(input: PushRetryDecisionInput): PushRetryDecision {
  if (input.failureKind !== 'race-non-ff') {
    return { retry: false, reason: 'failure is not a classified push race' };
  }
  if (input.isRetryLeg) {
    return { retry: false, reason: 'already the retry leg — single retry bound' };
  }
  if (parseRetryDepth(input.env[RETRY_DEPTH_ENV]) >= 1) {
    return { retry: false, reason: `${RETRY_DEPTH_ENV} depth guard — single retry bound` };
  }
  if (input.noRetryFlag) {
    return { retry: false, reason: '--no-retry' };
  }
  if (input.env[NO_RETRY_ENV]) {
    return { retry: false, reason: `${NO_RETRY_ENV} is set` };
  }
  if (input.autostashCreated) {
    return {
      retry: false,
      reason: 'an autostash was created this run — conservative, re-run manually',
    };
  }
  return { retry: true, reason: 'lost push race — retrying once in a fresh run' };
}

export interface RetryLegSpawnPlan {
  command: string;
  args: string[];
  env: Record<string, string | undefined>;
}

/**
 * Builds the self-respawn invocation: same node binary, same loader hooks
 * (`execArgv` carries tsx's --require/--import when launched via `npx tsx`),
 * same script, same CLI args, plus `--retry-leg` appended EXACTLY once, with
 * the depth env incremented. Pure so the mechanics are unit-testable; the
 * caller passes the result straight to `spawnSync(..., { stdio: 'inherit' })`.
 */
export function buildRetryLegSpawnPlan(opts: {
  execPath: string;
  execArgv: readonly string[];
  scriptPath: string;
  scriptArgs: readonly string[];
  env: Record<string, string | undefined>;
}): RetryLegSpawnPlan {
  const args = [
    ...opts.execArgv,
    opts.scriptPath,
    // Defensive de-dupe: scriptArgs should never already contain the flag
    // (a retry leg never respawns), but "appended exactly once" must hold
    // even if flags got mangled upstream.
    ...opts.scriptArgs.filter((arg) => arg !== RETRY_LEG_FLAG),
    RETRY_LEG_FLAG,
  ];
  return {
    command: opts.execPath,
    args,
    env: {
      ...opts.env,
      [RETRY_DEPTH_ENV]: String(parseRetryDepth(opts.env[RETRY_DEPTH_ENV]) + 1),
    },
  };
}
