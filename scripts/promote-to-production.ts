#!/usr/bin/env npx tsx

/**
 * ============================================================================
 * Mindstone Rebel — Promote a beta-certified SHA to PRODUCTION (CI-triggered)
 * ============================================================================
 *
 * The durable `/promote-to-production` driver (see
 * docs/plans/260619_ci-triggered-promote/PLAN.md, Stage 2 / S2c). It advances
 * production `main` to an already-frozen, already-beta-certified SHA via a
 * SINGLE fast-forward `git push`
 * (`git push origin <sha>:refs/heads/main`), which auto-triggers the existing
 * stable `release.yml`. There is no `dev` checkout, no branch switch, no merge
 * commit — so it is concurrency-safe by construction.
 *
 * WHY git push, NOT a gh-API refs PATCH (learned the hard way 260619): on a
 * ruleset-protected `main`, GitHub evaluates bypass for the low-level refs API
 * against the OAuth-APP identity (the gh CLI app), NOT the authenticated user's
 * team membership — so a `gh api PATCH .../git/refs/heads/main` is rejected
 * (masked 403→404) even for a repo admin, while that same user's `git push`
 * (receive-pack) IS honored for the bypass. The Stage-0 spike "validated" the
 * PATCH only on an UNPROTECTED throwaway branch, so it never exercised this.
 * PHASE 1 is therefore a laptop-authenticated push (CI does the build); true
 * off-laptop promotion (Phase 2) needs a GitHub App installation token added as
 * an explicit ruleset bypass actor.
 *
 * ============================================================================
 * SAFETY MODEL (read this before touching the file)
 * ============================================================================
 *
 * Advancing `main` IS a production ship. The driver is therefore built around
 * three independent guards, every one fail-closed:
 *
 *  0. CANONICAL-REPO HARD-BIND (fail-closed) — before anything else, `origin` must
 *     resolve to EXACTLY `mindstone/rebel-app` (CANONICAL_PRODUCTION_REPO); a
 *     fork / wrong-origin checkout is refused (BAD_INPUT). The resolved repo is then
 *     threaded as an explicit `--repo` into EVERY `gh` command — the cert proof, the
 *     run-confirm, and the watch all target the same repo; the advance `git push` goes to
 *     that same hard-bound `origin` [GPT F2/F5].
 *
 *  1. PRE-FLIGHT (pure, fail-closed) — `gatherPromoteFacts` → `evaluatePromotePreflight`.
 *     Eligibility is proven against the LIVE production target: `gatherPromoteFacts`
 *     first refreshes `origin/main` + `origin/dev` from the remote (a read-only fetch)
 *     so the version/FF/on-dev facts reflect live state, not a stale checkout [GPT F1].
 *     Any gate that does not AFFIRMATIVELY pass (un-certified SHA, non-FF,
 *     missing changelog heading at the SHA, version not ahead, SHA not on dev,
 *     orphaned submodule pin, or any "could-not-determine") blocks the promote.
 *     NOT eligible ⇒ print the verdict and exit non-zero WITHOUT touching `main`.
 *
 *  2. HARD HUMAN CHECKPOINT — the shared `confirmReleaseCheckpoint`
 *     (scripts/lib/release-checkpoint.ts), enforced IN CODE (not in the command
 *     markdown, which an autonomous agent could skip). Fail-closed on non-TTY;
 *     the only non-interactive bypass is an exact-version `--confirm-changelog-current`.
 *     This is the ONLY thing gating the DECISION to ship: the advance push DOES run
 *     `.husky/pre-push` (the certified-promote path runs validate:fast + realboot,
 *     skipping only the redundant test:fast/test:perf), but the hook gates the TREE,
 *     not the intent — and Phase 2 / off-laptop will run no local hook at all, so the
 *     checkpoint (not the hook) is the load-bearing human gate on shipping.
 *
 *  3. THE ADVANCE PUSH is FF-only by construction (a plain refspec — no `--force`,
 *     no leading `+`; git rejects a non-fast-forward) AND the repo's `non_fast_forward`
 *     ruleset rule backstops it. It runs WITH the pre-push hook (certified-promote fast
 *     path via REBEL_CERTIFIED_PROMOTE_SHA — never `--no-verify`). A non-FF rejection is
 *     mapped to a human-legible "main moved — re-run" and we exit non-zero; never force.
 *
 * AFTER the push, exit 0 means *shipped*, not "the push returned 0" [GPT F4]:
 * if no stable run starts we exit RUN_NOT_TRIGGERED; if the GCS manifest never
 * advances (watch on) we exit PUBLISH_NOT_CONFIRMED. Both make clear `main` HAS
 * advanced, so the operator knows the live state. The "safe to close your laptop"
 * handoff is emitted only AFTER a stable run is confirmed started [GPT F6].
 *
 * `--dry-run` performs steps 0–2 (the checkpoint auto-proceeds, identical to
 * release-to-production.ts's dry-run) and then logs the exact ref update it
 * WOULD make, without executing it. `--explain-json` prints the gathered facts
 * + verdict as JSON and exits without touching `main` (for backtesting).
 *
 * DRY-RUN / --explain-json GUARANTEE (narrowed honestly [GPT F3]): these modes
 * never advance `main`, never push, and never modify the working tree. They DO
 * perform read-only remote-ref fetches (`git fetch` of origin/main + origin/dev,
 * submodule remote refspecs) so the preview reflects live state — that is
 * intentional and desirable for an accurate preview. "No state mutation" here
 * means no `main` advance / push / working-tree change, NOT "issues zero git/gh".
 *
 * DESIGN: the TESTABLE CORE is `runPromoteToProduction(opts, deps)` — pure of
 * clipanion/process globals; everything impure (exec, the manifest poll, the
 * checkpoint prompt, the clock, sleep) is injected. The clipanion `Command`
 * is thin glue that wires the real implementations. Tests exercise the core
 * with a MOCKED exec and never touch real git/gh/network.
 *
 * ============================================================================
 * RELATED
 * ============================================================================
 * - docs/project/PROMOTE_BETA_TO_PRODUCTION.md — the runbook (this is the new primary path).
 * - .factory/commands/promote-to-production.md — the thin command wrapper.
 * - scripts/release-to-production.ts — the retained emergency/fallback local path.
 * - scripts/promote-preflight.ts / promote-preflight-facts.ts — the pure verdict + fact gathering.
 * - scripts/lib/release-checkpoint.ts — the shared human checkpoint.
 */

import { Cli, Command, Option, UsageError } from 'clipanion';
import { execSync, ExecSyncOptions } from 'child_process';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import * as readline from 'readline';
import {
  fetchManifestVersion,
  selectStableReleaseRun,
  shouldSoftenGcsWarning,
} from './release-to-production';
import { gatherPromoteFacts } from './promote-preflight-facts';
import { evaluatePromotePreflight, type PromotePreflightVerdict } from './promote-preflight';
import type { ExecFn, ExecResult, ExecOpts } from './promote-preflight-facts';
import {
  confirmReleaseCheckpoint,
  CheckpointCancelledError,
} from './lib/release-checkpoint';

/** ANSI color codes for terminal output (mirrors release-to-production.ts). */
const colors = {
  reset: '\x1b[0m',
  bright: '\x1b[1m',
  dim: '\x1b[2m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  red: '\x1b[31m',
  cyan: '\x1b[36m',
  magenta: '\x1b[35m',
} as const;

/** Exit codes (overlap intentionally with release-to-production.ts where meanings match). */
export const PROMOTE_EXIT_CODES = {
  SUCCESS: 0,
  /** Pre-flight blocked the promote (not eligible). */
  NOT_ELIGIBLE: 10,
  /** Human checkpoint was not satisfied / cancelled. */
  USER_CANCELLED: 60,
  /** The ref update was refused as a non-fast-forward (main moved). */
  NOT_FAST_FORWARD: 20,
  /** The ref update failed for some other reason (auth, API, network). */
  REF_UPDATE_FAILED: 40,
  /** Could not derive owner/repo, the SHA arg was malformed, or origin is not the canonical prod repo. */
  BAD_INPUT: 11,
  /**
   * POST-ADVANCE [GPT F4]: `main` HAS advanced, but no stable `release.yml` run appeared within the
   * confirmation window (e.g. the paths-ignore/no-trigger edge). NOT "shipped" — investigate /
   * dispatch the run manually. Distinct non-zero so the overnight chain can't read this as success.
   */
  RUN_NOT_TRIGGERED: 30,
  /**
   * POST-ADVANCE [GPT F4]: `main` advanced AND a run started, but the GCS manifest never advanced to
   * the version within the watch window (or the build completed-failed). NOT "shipped" — the publish
   * did not confirm. Distinct non-zero (vs RUN_NOT_TRIGGERED) so the failure mode is legible.
   */
  PUBLISH_NOT_CONFIRMED: 35,
  UNKNOWN_ERROR: 99,
} as const;

/**
 * The ONLY repo this production driver may advance [GPT F5 — Chief decision: hard-bind]. The driver
 * hardcodes the production GCS manifest URL + production action links, so a generic target is unsafe:
 * a fork / wrong-origin checkout must NOT be able to advance/push `main` and report production-oriented
 * status. `origin` must resolve to EXACTLY this `<owner>/<repo>` or the driver fails closed.
 */
export const CANONICAL_PRODUCTION_REPO = 'mindstone/rebel-app';

/** Canonical git oid: 40-char (SHA-1) or 64-char (SHA-256) lowercase hex, no whitespace. */
const OID_RE = /^[0-9a-f]{40}([0-9a-f]{24})?$/;

export function isCanonicalOid(value: string): boolean {
  return typeof value === 'string' && OID_RE.test(value);
}

// -----------------------------------------------------------------------------
// PURE HELPERS (exported, unit-tested)
// -----------------------------------------------------------------------------

/**
 * GitHub host (case-insensitive). We hard-require it: the derived `owner/repo` is
 * threaded as `--repo` into the `gh` cert-proof/run-confirm/watch commands (which hit
 * the GitHub API) AND used to confirm `origin` is the canonical GitHub repo we push
 * `main` to — so deriving it from a non-GitHub remote (e.g. a GitLab mirror) would be
 * wrong — fail-closed to null instead.
 */
const GITHUB_HOST_RE = /^github\.com$/i;
/** Strict GitHub owner/repo segment charset (alnum, `-`, `_`, `.`). No shell metacharacters. */
const REPO_SEGMENT_RE = /^[A-Za-z0-9._-]+$/;

/** Validate the two derived segments are clean GitHub names; fail-closed to null otherwise. */
function ownerRepoOrNull(owner: string, repo: string): string | null {
  const cleanRepo = repo.replace(/\.git$/, '');
  if (!REPO_SEGMENT_RE.test(owner) || !REPO_SEGMENT_RE.test(cleanRepo)) return null;
  return `${owner}/${cleanRepo}`;
}

/**
 * Derive `<owner>/<repo>` from a `git remote get-url origin` value. Handles both
 * the HTTPS (`https://github.com/owner/repo(.git)`) and SSH
 * (`[external-email]:owner/repo(.git)` / `ssh://[external-email]/owner/repo(.git)`)
 * forms. FAIL-CLOSED to null on anything we can't confidently parse [GPT R1 BLOCKER]:
 *  - the host MUST be `github.com` (a GitLab/other mirror must NOT derive a repo we'd target with `gh`/push),
 *  - EXACTLY two path segments (no nested paths),
 *  - each segment a strict `[A-Za-z0-9._-]+` (no spaces / `;` / newlines / other shell metacharacters
 *    that could be interpolated into the `gh` command).
 * The caller refuses to advance a non-canonical / unparseable `origin` when this returns null.
 */
export function parseOwnerRepoFromRemote(remoteUrl: string): string | null {
  const url = (remoteUrl ?? '').trim();
  if (!url) return null;

  // SSH scp-style: [user@]host:owner/repo(.git)  — host MUST be github.com, exactly two segments.
  const sshScp = /^[^@/\s]+@([^:/\s]+):([^/\s]+)\/([^/\s]+)$/.exec(url);
  if (sshScp) {
    if (!GITHUB_HOST_RE.test(sshScp[1])) return null;
    return ownerRepoOrNull(sshScp[2], sshScp[3]);
  }

  // Schemed: (https|ssh)://[user@]host/owner/repo(.git)  — host MUST be github.com, exactly two segments.
  const schemed = /^(?:https?|ssh):\/\/(?:[^@/\s]+@)?([^/\s]+)\/([^/\s]+)\/([^/\s]+)$/.exec(url);
  if (schemed) {
    if (!GITHUB_HOST_RE.test(schemed[1])) return null;
    return ownerRepoOrNull(schemed[2], schemed[3]);
  }

  return null;
}

/**
 * Classify the result of the main-advance exec (a fast-forward `git push`). A
 * non-fast-forward is the SPECIFIC, recoverable "main moved" case; everything else
 * that isn't success is a generic failure (auth / ruleset / network). Pure — exported
 * for testing.
 *
 * Why a `git push` and not a `gh api PATCH`: on a ruleset-protected `main`, GitHub
 * evaluates bypass for the low-level refs API against the OAuth-app identity, NOT the
 * user's team membership — so the API PATCH is rejected (masked 403→404) while the
 * user's `git push` (receive-pack) IS honored for the bypass. The S0 spike only
 * validated the PATCH on an UNPROTECTED throwaway branch, so it never caught this.
 */
export type RefUpdateOutcome =
  | { kind: 'ok' }
  | { kind: 'not-fast-forward'; detail: string }
  | { kind: 'failed'; detail: string };

/**
 * git's per-ref non-fast-forward rejection status line (`! [rejected] <x> -> main
 * (non-fast-forward)` / `(fetch first)`). ANCHORED to the `! [rejected]` line so hook/test
 * stderr that merely echoes the phrase can't trip it. `! [remote rejected] …` can never match
 * (the bracket opens with `remote`, not `rejected]`). Mirrors scripts/lib/push-race-retry.ts.
 */
const NON_FF_REJECTED_LINE = /^\s*!\s*\[rejected\][^\n]*\((?:non-fast-forward|fetch first)\)/m;

/**
 * git's remote-side rejection status line (ruleset / protected-branch / pre-receive hook decline,
 * push protection). Checked FIRST and conservatively: a remote-rejected push is a permission/policy
 * failure, NEVER "main moved" — so we must not misclassify it as a recoverable non-FF.
 */
const REMOTE_REJECTED_LINE = /^\s*!\s*\[remote rejected\]/m;

export function classifyRefUpdateResult(result: ExecResult): RefUpdateOutcome {
  if (result.success) return { kind: 'ok' };
  const detail = (result.error || result.output || '').trim();
  // CONSERVATIVE FIRST: any `[remote rejected]` (ruleset / protected-branch / hook / permission
  // decline) is a generic failure — NOT "main moved". Checking it before the non-FF match means a
  // permission decline can never be mislabelled "main moved" (which would wrongly tell the operator
  // to re-run). Both still exit non-zero and never force; only the message + recovery hint differ.
  if (REMOTE_REJECTED_LINE.test(detail)) {
    return { kind: 'failed', detail };
  }
  // The SPECIFIC, recoverable "main moved" case: git's anchored `! [rejected] … (non-fast-forward
  // / fetch first)` status line.
  if (NON_FF_REJECTED_LINE.test(detail)) {
    return { kind: 'not-fast-forward', detail };
  }
  return { kind: 'failed', detail };
}

/**
 * Build the EXACT main-advance command string: a fast-forward `git push` of the
 * certified SHA to `origin` `main`. Centralised + exported so the test can assert the
 * precise command, and so dry-run logs and the real call can never drift.
 *
 * - FF-only by construction: a plain refspec (no leading `+`, no `--force`) — git rejects
 *   a non-fast-forward, and the repo's `non_fast_forward` ruleset rule is a server backstop.
 * - Targets `origin` (already hard-bound to the canonical production repo upstream), so no
 *   owner/repo is interpolated into the command.
 * - `sha` is validated as a canonical oid before this is ever called (no injection surface).
 */
export function buildAdvanceMainCommand(sha: string): string {
  return `git push origin ${sha}:refs/heads/main`;
}

/**
 * Parse `gh run list ... --json ...durations...` rows and return the median of the
 * most-recent completed stable runs' wall-clock minutes, for a calibrated ETA.
 * Returns null if we can't compute one (caller falls back to a static estimate).
 * Pure — exported for testing.
 */
export function medianStableRunMinutes(ghRunListJson: string): number | null {
  try {
    const rows = JSON.parse(ghRunListJson) as Array<{
      status?: string;
      conclusion?: string | null;
      createdAt?: string;
      updatedAt?: string;
    }>;
    if (!Array.isArray(rows)) return null;
    const durations: number[] = [];
    for (const r of rows) {
      if (r.status !== 'completed') continue;
      if (!r.createdAt || !r.updatedAt) continue;
      const start = Date.parse(r.createdAt);
      const end = Date.parse(r.updatedAt);
      if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) continue;
      durations.push((end - start) / 60_000);
    }
    if (durations.length === 0) return null;
    durations.sort((a, b) => a - b);
    const mid = Math.floor(durations.length / 2);
    const median =
      durations.length % 2 === 0 ? (durations[mid - 1] + durations[mid]) / 2 : durations[mid];
    return Math.round(median);
  } catch {
    return null;
  }
}

/**
 * The GCS-manifest watch window, in minutes, derived from the calibrated stable-run ETA.
 * A fixed window mis-serves a real spread of stable build times: too short and a normal long
 * build (macOS+Windows+Linux+E2E can run well past 45 min) trips a false soft-timeout
 * (PUBLISH_NOT_CONFIRMED) before publishing; too long and a genuinely stuck build wastes the
 * operator's wait. So scale to the calibration with headroom: `ETA × 1.5`, floored at 45 min
 * (never watch less than the old fixed window) and capped at 180 min (a build past 3× the floor
 * is stuck — stop polling and let the operator investigate). ETA null (no calibration) → the
 * 45-min floor. Pure — exported for testing.
 */
export function computeWatchWindowMinutes(etaMinutes: number | null): number {
  const FLOOR_MIN = 45;
  const CAP_MIN = 180;
  const HEADROOM = 1.5;
  const base = etaMinutes !== null && Number.isFinite(etaMinutes) && etaMinutes > 0 ? etaMinutes : 0;
  return Math.min(CAP_MIN, Math.max(FLOOR_MIN, Math.round(base * HEADROOM)));
}

// -----------------------------------------------------------------------------
// DRIVER CORE (testable; all impurity injected)
// -----------------------------------------------------------------------------

/** Options that mirror the CLI flags, decoupled from clipanion. */
export interface PromoteOptions {
  /** The candidate beta-certified SHA being promoted (the required --commit value). */
  commit: string;
  /** When true: do steps 1–2 then LOG the ref update without executing it. */
  dryRun: boolean;
  /** Whether stdin is an interactive terminal (the checkpoint TTY gate). */
  isTTY: boolean;
  /** The non-interactive changelog acknowledgement value, forwarded to the checkpoint. */
  confirmChangelogCurrent?: string;
  /** When true: print gathered facts + verdict as JSON and exit, touching nothing. */
  explainJson: boolean;
}

/** Injected impurities — exec/clock/sleep/prompt/manifest-fetch, all mockable. */
export interface PromoteDeps {
  /** Injected command runner (git/gh). Never throws to the caller in normal use. */
  exec: ExecFn;
  /** Repo root passed through to the fact gatherer's fast-forward helper. */
  repoRoot: string;
  /** Output adapter — mirrors the release script's `log(message, color?)`. */
  log: (message: string, color?: string) => void;
  /** Reads a single line of input for the interactive TTY checkpoint prompt. */
  promptLine: (question: string) => Promise<string>;
  /** Polls the GCS release manifest for a version. Defaults to the real HTTP fetch. */
  fetchManifestVersion?: (url: string) => Promise<{ ok: true; version: string } | { ok: false; error: string }>;
  /** Monotonic clock in ms (performance.now), injectable for deterministic tests. */
  now?: () => number;
  /** Sleep adapter (ms). Injectable so tests don't actually wait. */
  sleep?: (ms: number) => Promise<void>;
  /** When false, skip the post-update watch loop (tests / fast exits). Default true. */
  watch?: boolean;
  /**
   * Fast-forward check threaded into `gatherPromoteFacts`. Defaults (inside the
   * gatherer) to the proven `isCleanFastForward` from release-to-production.ts,
   * which runs its OWN real git via execSync — so tests MUST inject a stub here to
   * stay off real git (the injected `exec` does not cover that helper's subprocess).
   */
  isCleanFastForward?: (baseRef: string, targetRef: string, cwd: string) => boolean;
}

const GCS_MANIFEST_URL = 'https://storage.googleapis.com/mindstone-rebel/releases/latest.json';

/**
 * Timeout for the main-advance `git push` (Step 4). The push runs the pre-push hook, whose
 * production-tier safety gate (validate:fast etc.) takes minutes — well past the runner's default
 * 30s — so we raise it generously. The operator is watching this step; the separate GCS watch
 * window (calibrated, 45–180 min — see computeWatchWindowMinutes) covers the build itself, not this push.
 */
const ADVANCE_MAIN_TIMEOUT_MS = 25 * 60 * 1000;

/**
 * The driver core. Returns an exit code; never calls process.exit. PURE of
 * clipanion + process globals — everything impure is in `deps`. The ONLY step
 * that can touch `main` is the ref update, and it is reached only after the
 * pre-flight is eligible AND the human checkpoint is satisfied AND we are NOT in
 * dry-run.
 */
export async function runPromoteToProduction(
  opts: PromoteOptions,
  deps: PromoteDeps
): Promise<number> {
  const { exec, repoRoot, log } = deps;
  const c = colors;

  const logInfo = (m: string) => log(`  ℹ️  ${m}`, c.cyan);
  const logSuccess = (m: string) => log(`  ✅ ${m}`, c.green);
  const logWarning = (m: string) => log(`  ⚠️  ${m}`, c.yellow);
  const logError = (m: string) => log(`  ❌ ${m}`, c.red);
  const logSection = (title: string) => {
    log(`\n${'─'.repeat(60)}`, c.dim);
    log(`  ${title}`, c.bright);
    log(`${'─'.repeat(60)}`, c.dim);
  };

  // Header
  log('\n╔════════════════════════════════════════════════════════════╗', c.bright);
  log('║      Mindstone Rebel — Promote Beta to Production          ║', c.bright);
  log('╚════════════════════════════════════════════════════════════╝', c.bright);
  if (opts.dryRun) {
    log('\n  🔍 DRY RUN MODE — main will NOT be advanced\n', c.yellow);
  }

  // --- Step 1: resolve + validate the SHA (fail-closed on a non-canonical oid) ---
  const sha = (opts.commit ?? '').trim();
  if (!isCanonicalOid(sha)) {
    logError(
      `--commit is not a canonical full git oid (40/64 lowercase hex): "${opts.commit}". ` +
        `Pass the full beta-certified SHA. Refusing to touch main.`
    );
    return PROMOTE_EXIT_CODES.BAD_INPUT;
  }

  // --- Step 1b: resolve + HARD-BIND the target repo (BEFORE gathering) [GPT F2/F5] ---
  // Derive <owner>/<repo> from `origin`, then require it EXACTLY equals the canonical production
  // repo. We resolve it FIRST so the SAME explicit repo is threaded into the cert proof, the
  // run-confirm, the watch, AND the advance push — never a mix of explicit-repo + implicit-gh.
  const ownerRepo = resolveOwnerRepo(exec);
  if (!ownerRepo) {
    logError('Could not derive <owner>/<repo> from `git remote get-url origin` — refusing to advance `main`.');
    return PROMOTE_EXIT_CODES.BAD_INPUT;
  }
  if (ownerRepo !== CANONICAL_PRODUCTION_REPO) {
    logError(
      `refusing to promote — origin is not the canonical production repo ` +
        `(origin=${ownerRepo}, expected ${CANONICAL_PRODUCTION_REPO}). ` +
        `This driver hardcodes the production GCS manifest + action URLs; a generic target is unsafe.`
    );
    return PROMOTE_EXIT_CODES.BAD_INPUT;
  }

  // --- Step 2: gather facts → evaluate the pure verdict ---
  logSection('Pre-flight');
  let verdict: PromotePreflightVerdict;
  let facts;
  try {
    facts = gatherPromoteFacts(sha, { exec, repoRoot, ownerRepo, isCleanFastForward: deps.isCleanFastForward });
    verdict = evaluatePromotePreflight(facts);
  } catch (error) {
    // Should not happen (the verdict library is itself fail-closed), but if the
    // gather throws unexpectedly we fail closed rather than touch main.
    logError(`Pre-flight gathering errored (fail-closed, not touching main): ${errMsg(error)}`);
    return PROMOTE_EXIT_CODES.NOT_ELIGIBLE;
  }

  // --explain-json: dump facts + verdict and exit, touching nothing.
  if (opts.explainJson) {
    log(JSON.stringify({ certifiedSha: sha, facts, verdict }, null, 2));
    return verdict.eligible ? PROMOTE_EXIT_CODES.SUCCESS : PROMOTE_EXIT_CODES.NOT_ELIGIBLE;
  }

  // Print the verdict (every gate, for evidence).
  for (const gate of verdict.gates) {
    if (gate.status === 'pass') logSuccess(`${gate.gate}: ${gate.reason}`);
    else logError(`${gate.gate}: ${gate.reason}`);
  }

  if (!verdict.eligible) {
    log('', c.reset);
    logError(verdict.summary);
    logWarning(`Blocked gates: ${verdict.blockers.join(', ')}`);
    logInfo('Not eligible — main was NOT touched. Resolve the blockers (often: cut a fresh beta) and re-run.');
    return PROMOTE_EXIT_CODES.NOT_ELIGIBLE;
  }
  logSuccess(verdict.summary);

  // --- Step 3: the HARD HUMAN CHECKPOINT (shared lib; enforced in code) ---
  // Surface the actor + target so a human confirms the *right* promote.
  const ghActor = execOutput(exec, 'gh api user --jq .login') ?? '<unknown gh actor>';
  const shaVersion = facts.shaVersion ?? '<unknown>';
  logSection('Human Checkpoint');
  logInfo(`gh actor: ${ghActor}`);
  logInfo(`Target: advance main → ${sha} (v${shaVersion})`);

  try {
    await confirmReleaseCheckpoint({
      version: shaVersion,
      confirmChangelogCurrent: opts.confirmChangelogCurrent,
      dryRun: opts.dryRun,
      isTTY: opts.isTTY,
      log,
      promptLine: deps.promptLine,
    });
  } catch (error) {
    if (error instanceof CheckpointCancelledError) {
      logError(error.message);
      return PROMOTE_EXIT_CODES.USER_CANCELLED;
    }
    logError(`Checkpoint errored (fail-closed): ${errMsg(error)}`);
    return PROMOTE_EXIT_CODES.USER_CANCELLED;
  }

  // --- Step 4: the FAST-FORWARD PUSH (the ONLY step that touches main) ---
  // A `git push` (not a gh-API PATCH) because only the user's receive-pack push is honored
  // for the protected-main ruleset bypass — see classifyRefUpdateResult's note. `origin` is
  // already hard-bound to the canonical production repo (Step 1b).
  const advanceCmd = buildAdvanceMainCommand(sha);

  logSection('Advance main (fast-forward push)');
  if (opts.dryRun) {
    logInfo(`DRY RUN: would advance main → ${sha} (fast-forward push, hooks enabled)`);
    logInfo(`DRY RUN: would run: REBEL_CERTIFIED_PROMOTE_SHA=${sha} ${advanceCmd}`);
    logSuccess('DRY RUN complete — main untouched, no run triggered.');
    return PROMOTE_EXIT_CODES.SUCCESS;
  }

  // Run WITH the pre-push hook (never --no-verify — that's the footgun we're killing). Setting
  // REBEL_CERTIFIED_PROMOTE_SHA makes the hook take the certified-promote fast path (skips the
  // redundant heavy local suites for a byte-identical certified FF, keeps the safety gate). The
  // gate can take minutes, so override the runner's default 30s timeout or it'd be killed mid-push.
  logInfo(`Running: ${advanceCmd} (certified promote; the pre-push hook runs the safety gate — this can take a few min)`);
  const refResult = exec(advanceCmd, {
    timeoutMs: ADVANCE_MAIN_TIMEOUT_MS,
    env: { REBEL_CERTIFIED_PROMOTE_SHA: sha },
  });
  const outcome = classifyRefUpdateResult(refResult);
  if (outcome.kind === 'not-fast-forward') {
    logError(
      'main moved since pre-flight — the fast-forward push was rejected. ' +
        'This is NOT a clean promotion anymore: re-run pre-flight on a fresh main, ' +
        'or cut a new beta. (Never force this.)'
    );
    return PROMOTE_EXIT_CODES.NOT_FAST_FORWARD;
  }
  if (outcome.kind === 'failed') {
    logError(`Push to main failed (main NOT advanced): ${outcome.detail || '(no detail)'}`);
    logInfo(
      'If this looks like a permission/ruleset decline, you must push as a main-bypass user via ' +
        '`git push` (the gh refs API is NOT a bypass actor on protected main). Also check the pre-push gate output above.'
    );
    return PROMOTE_EXIT_CODES.REF_UPDATE_FAILED;
  }
  logSuccess(`Advanced main → ${sha} (fast-forward push, no merge commit)`);

  // --- Step 7: ref update done — but NOT yet "shipped" [GPT F6] ---
  // The handoff message is deliberately held until a stable run is CONFIRMED started (below). Until
  // then say what's actually true: the ref advanced, and we're confirming CI picked it up.
  log('', c.reset);
  logInfo('ref update complete; confirming CI trigger…');
  const etaMinutes = estimateStableEtaMinutes(exec, ownerRepo);
  logInfo(
    etaMinutes !== null
      ? `~${etaMinutes} min to live (calibrated from recent stable runs); I'll report when the GCS manifest advances.`
      : `~25–30 min to live; I'll report when the GCS manifest advances.`
  );

  // --- Step 6: confirm a stable run actually STARTED (guards the no-trigger edge) [GPT F4] ---
  // `main` has advanced; exit 0 must mean *shipped*, not "the push returned 0". If no stable run
  // appears, the publish chain never started → fail with a distinct non-zero code (RUN_NOT_TRIGGERED)
  // so the overnight chain / operator can't mistake an un-triggered build for a successful ship.
  const runStarted = await confirmStableRunStarted(sha, ownerRepo, {
    exec,
    log,
    now: deps.now,
    sleep: deps.sleep,
  });
  if (!runStarted) {
    logError(
      'main advanced but no stable run triggered — investigate. ' +
        `Check https://github.com/${ownerRepo}/actions and dispatch release.yml manually if needed.`
    );
    return PROMOTE_EXIT_CODES.RUN_NOT_TRIGGERED;
  }

  // A run is confirmed started — NOW the local handoff is genuinely complete.
  log('', c.reset);
  logSuccess('handoff complete — local work done, safe to close your laptop');

  // --- Step 8: watch the stable run to terminal via the GCS manifest poll [GPT F4] ---
  // When `watch` is disabled (tests / fast exits) we stop here: the run is confirmed started, which
  // is the success bar we can assert without polling. With watch on, success additionally requires
  // the GCS manifest to advance to the version; if it never does (or the build completed-failed) we
  // fail with PUBLISH_NOT_CONFIRMED — main has advanced + a run started, but the publish is unproven.
  if (deps.watch !== false) {
    const published = await watchGcsManifest(sha, shaVersion, ownerRepo, etaMinutes, {
      exec,
      log,
      fetchManifestVersion: deps.fetchManifestVersion ?? fetchManifestVersion,
      now: deps.now ?? (() => performance.now()),
      sleep: deps.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms))),
    });
    if (!published) {
      logError(
        'main advanced and a stable run started, but the GCS publish was not confirmed within the ' +
          `watch window — investigate https://github.com/${ownerRepo}/actions (esp. publish-to-gcs).`
      );
      return PROMOTE_EXIT_CODES.PUBLISH_NOT_CONFIRMED;
    }
  }

  return PROMOTE_EXIT_CODES.SUCCESS;
}

// -----------------------------------------------------------------------------
// internal helpers (impure, but injected-exec only)
// -----------------------------------------------------------------------------

function errMsg(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Run an injected command and return trimmed output on success, else null. Never throws. */
function execOutput(exec: ExecFn, cmd: string): string | null {
  try {
    const result = exec(cmd);
    return result.success ? result.output.trim() : null;
  } catch {
    return null;
  }
}

/** Derive owner/repo from the live `origin` remote (fail-closed to null). */
function resolveOwnerRepo(exec: ExecFn): string | null {
  const url = execOutput(exec, 'git remote get-url origin');
  if (!url) return null;
  return parseOwnerRepoFromRemote(url);
}

/** A static fallback ETA, calibrated from recent stable runs when cheaply available. */
function estimateStableEtaMinutes(exec: ExecFn, ownerRepo: string): number | null {
  const out = execOutput(
    exec,
    `gh run list --repo ${ownerRepo} --workflow release.yml --branch main --limit 5 --json status,conclusion,createdAt,updatedAt`
  );
  if (out === null) return null;
  return medianStableRunMinutes(out);
}

interface RunStartedDeps {
  exec: ExecFn;
  log: (message: string, color?: string) => void;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

/**
 * Confirm a stable `release.yml` run actually started for the new main SHA — a
 * user-token ref update should trigger `on: push`, but the paths-ignore edge (or
 * an API quirk) could suppress it. Poll a bounded window.
 *
 * Returns `true` iff a matching stable run was observed; `false` if none appeared within the window
 * [GPT F4]. The caller turns `false` into a distinct non-zero exit (RUN_NOT_TRIGGERED) — a
 * post-advance "no trigger" must NOT be reported as a successful ship.
 */
async function confirmStableRunStarted(sha: string, ownerRepo: string, deps: RunStartedDeps): Promise<boolean> {
  const { exec, log } = deps;
  const now = deps.now ?? (() => performance.now());
  const sleep = deps.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const c = colors;
  const logInfo = (m: string) => log(`  ℹ️  ${m}`, c.cyan);
  const logSuccess = (m: string) => log(`  ✅ ${m}`, c.green);
  const logWarning = (m: string) => log(`  ⚠️  ${m}`, c.yellow);

  const windowMs = 3 * 60 * 1000;
  const intervalMs = 15 * 1000;
  const startedAt = now();
  logInfo('Confirming a stable build run started on main...');

  while (now() - startedAt < windowMs) {
    const out = execOutput(
      exec,
      `gh run list --repo ${ownerRepo} --workflow release.yml --branch main --limit 5 --json databaseId,headSha,status,conclusion`
    );
    if (out !== null) {
      const run = selectStableReleaseRun(out, sha);
      if (run !== null) {
        logSuccess(
          `Stable run started: id ${run.databaseId} (status ${run.status}) — https://github.com/${ownerRepo}/actions/runs/${run.databaseId}`
        );
        return true;
      }
    }
    const remaining = windowMs - (now() - startedAt);
    if (remaining <= 0) break;
    await sleep(Math.min(intervalMs, remaining));
  }

  logWarning(
    'main was advanced but no stable release.yml run appeared within the confirmation window. ' +
      'This can be the paths-ignore/no-trigger edge — check ' +
      `https://github.com/${ownerRepo}/actions and dispatch release.yml manually if needed.`
  );
  return false;
}

interface WatchDeps {
  exec: ExecFn;
  log: (message: string, color?: string) => void;
  fetchManifestVersion: (url: string) => Promise<{ ok: true; version: string } | { ok: false; error: string }>;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
}

/**
 * Watch the GCS release manifest until it advances to the released version, or
 * the window expires. Mirrors release-to-production.ts's verifyPublishedToGcs
 * poll (same URL, cadence, and soften-if-still-running behaviour).
 *
 * Returns `true` iff the manifest advanced to `releasedVersion` (the publish is confirmed). Returns
 * `false` if it did not — INCLUDING the "still running past the window" soft case: a build that
 * hasn't published yet is not a confirmed ship, so the driver must NOT exit 0 [GPT F4]. The soft
 * vs. hard distinction is preserved in the OPERATOR-FACING message (still-running = "not a failure
 * yet, keep watching"; otherwise = a publish that did not complete), but the success bit is the same:
 * not-yet-published ⇒ `false` ⇒ PUBLISH_NOT_CONFIRMED.
 */
async function watchGcsManifest(
  sha: string,
  releasedVersion: string,
  ownerRepo: string,
  etaMinutes: number | null,
  deps: WatchDeps
): Promise<boolean> {
  const { exec, log, fetchManifestVersion: fetchManifest, now, sleep } = deps;
  const c = colors;
  const logInfo = (m: string) => log(`  ℹ️  ${m}`, c.cyan);
  const logSuccess = (m: string) => log(`  ✅ ${m}`, c.green);
  const logWarning = (m: string) => log(`  ⚠️  ${m}`, c.yellow);
  log(`\n${'─'.repeat(60)}`, c.dim);
  log('  Verify Published to GCS', c.bright);
  log(`${'─'.repeat(60)}`, c.dim);

  // Window scales to the calibrated stable-run ETA (floor 45 / cap 180) so a normal long build
  // doesn't trip a false soft-timeout before it publishes — see computeWatchWindowMinutes.
  const timeoutMinutes = computeWatchWindowMinutes(etaMinutes);
  const timeoutMs = timeoutMinutes * 60 * 1000;
  const intervalMs = 30 * 1000;
  const startedAt = now();
  let lastSeenVersion = '<unknown>';
  let lastError: string | null = null;
  const formatVersion = (v: string) => (v === '<unknown>' ? v : `v${v}`);

  try {
    logInfo(`Polling ${GCS_MANIFEST_URL} for v${releasedVersion} (up to ${timeoutMinutes} min, every 30s)`);
    while (now() - startedAt < timeoutMs) {
      const result = await fetchManifest(GCS_MANIFEST_URL);
      if (result.ok) {
        lastError = null;
        lastSeenVersion = result.version;
        if (result.version === releasedVersion) {
          const elapsedSeconds = Math.round((now() - startedAt) / 1000);
          logSuccess(`GCS manifest advanced to v${releasedVersion} (${elapsedSeconds}s after push)`);
          return true;
        }
      } else {
        lastError = result.error;
      }
      const remainingMs = timeoutMs - (now() - startedAt);
      if (remainingMs <= 0) break;
      await sleep(Math.min(intervalMs, remainingMs));
    }
  } catch (error) {
    lastError = errMsg(error);
  }

  // Did not advance: soften the MESSAGE to "still running" iff a matching stable run is
  // queued/in_progress — but the publish is still unconfirmed, so we return `false` either way.
  const runListOut = execOutput(
    exec,
    `gh run list --repo ${ownerRepo} --workflow release.yml --branch main --limit 3 --json databaseId,headSha,status,conclusion`
  );
  const stableRun = runListOut !== null ? selectStableReleaseRun(runListOut, sha) : null;
  if (shouldSoftenGcsWarning(stableRun)) {
    const runUrl = `https://github.com/${ownerRepo}/actions/runs/${stableRun.databaseId}`;
    logInfo(
      `Stable build still running after the ${timeoutMinutes}-min poll window — not a manifest failure yet ` +
        `(stable build times vary; a queued/large run can still exceed the calibrated window). Inspect ${runUrl}.`
    );
    logInfo(`Last seen GCS version: ${formatVersion(lastSeenVersion)}`);
    if (lastError !== null) logInfo(`Last transport error: ${lastError}`);
    return false;
  }

  logWarning('GCS MANIFEST DID NOT ADVANCE');
  logWarning(`Released version: v${releasedVersion}`);
  logWarning(`Last seen version: ${formatVersion(lastSeenVersion)}`);
  if (lastError !== null) logWarning(`Last transport error: ${lastError}`);
  logWarning(
    'main is at the certified SHA, but the GCS publish has not completed — inspect ' +
      `https://github.com/${ownerRepo}/actions (esp. publish-to-gcs).`
  );
  return false;
}

// -----------------------------------------------------------------------------
// CLIPANION GLUE (thin — wires the real impurities into runPromoteToProduction)
// -----------------------------------------------------------------------------

/** Real exec adapter — execSync wrapper matching the injected `ExecFn`/`ExecResult` shape. */
function realExec(repoRoot: string): ExecFn {
  return (command: string, opts?: ExecOpts): ExecResult => {
    const options: ExecSyncOptions = {
      cwd: repoRoot,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: opts?.timeoutMs ?? 30_000,
      // Lift the stdout cap above Node's 1 MB default: this driver captures noisy
      // output (pre-push hook / `git push` / `gh run watch`), which can exceed
      // 1 MB and would otherwise throw ENOBUFS. Same fix class as the overnight
      // chain's realExec (backtest finding F-BT1); exceeding the cap fails closed.
      maxBuffer: 64 * 1024 * 1024,
      // Merge per-command env OVER the inherited process.env (used to set
      // REBEL_CERTIFIED_PROMOTE_SHA for the certified-promote push).
      env: opts?.env ? { ...process.env, ...opts.env } : process.env,
    };
    try {
      const output = execSync(command, options) as string;
      return { success: true, output: output.trim() };
    } catch (error: unknown) {
      const err = error as { status?: number; stdout?: Buffer; stderr?: Buffer; message?: string };
      return {
        success: false,
        output: err.stdout?.toString().trim() || '',
        error: err.stderr?.toString().trim() || err.message || 'Unknown error',
        exitCode: err.status,
      };
    }
  };
}

class PromoteToProductionCommand extends Command {
  static paths = [['promote-to-production'], ['promote'], Command.Default];

  static usage = Command.Usage({
    description: 'Promote a beta-certified SHA to production via a fast-forward update of main',
    details: `
      Advances production 'main' to an already-frozen, beta-certified SHA via a single
      fast-forward 'git push origin <sha>:refs/heads/main' (the user's push is the identity
      honored for the protected-main ruleset bypass; the gh refs API is not), which auto-triggers
      the stable release.yml build. No dev checkout, no branch switch — concurrency-safe. Phase 1:
      laptop-authenticated push, CI does the build (true off-laptop is Phase 2).

      SAFETY:
      • Pure fail-closed pre-flight — un-certified / non-FF / missing-changelog / version-not-ahead
        / SHA-not-on-dev / orphaned-submodule all BLOCK without touching main.
      • Hard human checkpoint (enforced in code) — fail-closed on non-TTY; only an exact-version
        --confirm-changelog-current bypasses it non-interactively. --yes does NOT skip it.
      • The push is FF-only (plain refspec, no --force; the non_fast_forward ruleset rule backstops
        it) — a non-fast-forward is mapped to "main moved — re-run" and never forced.
      • Runs WITH the pre-push hook (certified-promote fast path via REBEL_CERTIFIED_PROMOTE_SHA;
        never --no-verify).

      --dry-run does the pre-flight + checkpoint then LOGS the ref update without executing it.
      --explain-json prints the facts + verdict as JSON and exits, touching nothing.
    `,
    examples: [
      ['Preview a promote (no main change)', 'npx tsx scripts/promote-to-production.ts --commit <sha> --dry-run'],
      ['Inspect the pre-flight verdict as JSON', 'npx tsx scripts/promote-to-production.ts --commit <sha> --explain-json'],
      ['Promote (real — requires the human checkpoint)', 'npx tsx scripts/promote-to-production.ts --commit <sha>'],
    ],
  });

  commit = Option.String('--commit', {
    required: true,
    description: 'The beta-certified SHA to promote (full 40/64-char git oid)',
  });

  dryRun = Option.Boolean('--dry-run', false, {
    description: 'Pre-flight + checkpoint, then LOG (not execute) the ref update — main untouched',
  });

  confirmChangelogCurrent = Option.String('--confirm-changelog-current', {
    description:
      'Non-interactive checkpoint bypass: acknowledge the changelog is current for THIS exact version (must match the SHA version). --yes does NOT skip the checkpoint.',
  });

  explainJson = Option.Boolean('--explain-json', false, {
    description: 'Print gathered facts + verdict as JSON and exit, touching nothing (for backtesting)',
  });

  async execute(): Promise<number> {
    const repoRootResult = realExec(process.cwd())('git rev-parse --show-toplevel');
    const repoRoot = repoRootResult.success ? repoRootResult.output : process.cwd();
    const exec = realExec(repoRoot);

    return runPromoteToProduction(
      {
        commit: this.commit,
        dryRun: this.dryRun,
        isTTY: Boolean(process.stdin.isTTY),
        confirmChangelogCurrent: this.confirmChangelogCurrent,
        explainJson: this.explainJson,
      },
      {
        exec,
        repoRoot,
        log: (message, color) => this.context.stdout.write(`${color ?? colors.reset}${message}${colors.reset}\n`),
        promptLine: (question) => {
          const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
          return new Promise<string>((resolveAnswer) => {
            rl.question(question, (ans) => {
              rl.close();
              resolveAnswer(ans);
            });
          });
        },
      }
    );
  }
}

// -----------------------------------------------------------------------------
// CLI ENTRY POINT
// -----------------------------------------------------------------------------

const cli = new Cli({
  binaryLabel: 'Promote to Production',
  binaryName: 'promote-to-production',
  binaryVersion: '1.0.0',
});

cli.register(PromoteToProductionCommand);

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  cli.runExit(process.argv.slice(2));
}

// Re-export for the runbook/tests that want the UsageError class name parity.
export { UsageError };
