/**
 * ⚠️ SHELVED / DORMANT (260607) — retained as a building block, NOT wired and
 * NOT a push-race fix. Nothing mints a nonce today: `git-safe-sync` does not
 * call `mintAndWriteNonce`, and `.husky/pre-push` only consults this when
 * `$REBEL_PREPUSH_GATE_OK` is set (nothing sets it). It is fully unit-tested
 * and verified, kept in-tree as the verification primitive a future
 * **merge-queue** would use (serialize → validate the queue-head tree →
 * fast-path that one push). Do not treat it as solving the push race — see
 * "WHY THIS IS SHELVED" below and docs/project/PREPUSH_GATE_AND_RECEIPTS.md.
 *
 * WHY THIS IS SHELVED (the race-window argument)
 * ----------------------------------------------
 * The push-race window is [fetch origin/dev → our ref lands]. Safety requires
 * validating the EXACT merged tree (our work + latest origin/dev), which only
 * exists AFTER the post-fetch merge — so validation is irreducibly inside that
 * window. Minting a nonce before the push and fast-pathing the hook merely
 * relocates the ~4-min gate from the hook into git-safe-sync; both are inside
 * the same window, so the race window and the per-retry cost are UNCHANGED. On
 * a hot branch every push re-merges, so the pushed tree differs from any
 * earlier-validated tree and the nonce misses anyway. The genuine race levers
 * are: cut gate time (incremental `validate:ts-ratchet`), a merge-queue, or
 * accept-and-retry. (Original "shrinks the lock to seconds" framing was wrong;
 * caught by the Devil's Advocate, confirmed by an Arbitrator — see
 * docs/plans/260607_prepush-receipt-gate/PLAN.md Decision Log.)
 *
 * --- original design intent (only valid inside a merge-queue) -------------
 * Gate-pass nonce — lets a serialized pusher run the expensive gate ONCE on the
 * queue-head tree, then hand the resulting `git push` a single-use token so the
 * in-lock `.husky/pre-push` hook can fast-path the already-proven steps
 * (`validate:fast` + tiered vitest) for THAT push.
 *
 * WHY A LIVE NONCE AND NOT A DURABLE RECEIPT
 * ------------------------------------------
 * An earlier design keyed a durable `.local` receipt on a `gate_version` hash
 * of the gate-defining files. Phase-2 review (Opus reviewer + Devil's Advocate,
 * convergent) rejected it: a file-list hash cannot provably capture the
 * transitive behaviour of ~87 shelled gate steps + the lockfile, and the gate
 * validates the **working tree + installed deps**, not just `HEAD^{tree}` — so a
 * dirty tree with an unchanged HEAD could match a receipt for un-validated
 * inputs. The nonce avoids the whole class: it is minted by the SAME
 * `git-safe-sync` process that just ran the gate, seconds before the push, and
 * is bound to the exact committed tree + a clean-working-tree assertion. There
 * is no "across time" determinism to trust and no durable artifact to go stale.
 *
 * SAFETY INVARIANTS (the hook fast-paths ONLY if every one holds)
 * ---------------------------------------------------------------
 *  - The env token (set by git-safe-sync on the push spawn) equals the nonce in
 *    the sidecar it just wrote — proves the push's parent is the gate run.
 *  - The committed tree (`HEAD^{tree}`), HEAD, upstream, and submodule pins all
 *    still match what was validated. A race re-merge changes HEAD → tree → miss.
 *  - The working tree (incl. submodules) is CLEAN at consume — the gate's verdict
 *    is about the tree that is actually being pushed, not stray edits.
 *  - The covered tier ≥ the tier this push requires.
 *  - The nonce is within a short TTL and is SINGLE-USE (the hook deletes the
 *    sidecar on consume).
 * A manual `git push` (no env token) never matches, so it always runs the full
 * gate. Any doubt fails safe to the full gate.
 *
 * @see docs/project/PREPUSH_GATE_AND_RECEIPTS.md
 * @see .factory/commands/git-safe-sync-and-push.md
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import { gitCapture } from './git-exec.js';

/** Env var git-safe-sync sets on the `git push` spawn to authorise a fast-path. */
export const NONCE_ENV_VAR = 'REBEL_PREPUSH_GATE_OK';
/** Sidecar path (relative to repo root). `.local/` is gitignored. */
export const NONCE_SIDECAR_REL = '.local/gate-nonce.json';
/** Maximum age of a nonce. Gate-run→push is seconds apart; this is slack insurance. */
export const NONCE_TTL_MS = 10 * 60 * 1000;

/** Tiers mirror `.husky/pre-push`: 1=quick, 2=beta(+upstream), 3=production(+full suite). */
export type Tier = 1 | 2 | 3;

/** Snapshot of the exact state the gate validated / the push will land. */
export interface TreeBinding {
  /** `git rev-parse HEAD`. */
  head_sha: string;
  /** `git rev-parse HEAD^{tree}` — the content address of the committed tree. */
  tree_sha: string;
  /** `git rev-parse @{u}`, or null if no upstream is configured. */
  upstream_sha: string | null;
  /** submodule path → pinned SHA (from `git submodule status`). */
  submodule_shas: Record<string, string>;
  /** Tier the gate run covered (derived identically to the hook, from HEAD + branch). */
  tier_covered: Tier;
  /** True iff the superproject AND every submodule working tree is clean. */
  working_tree_clean: boolean;
}

/** Sidecar payload written by git-safe-sync after a green pre-validate run. */
export interface GateNonceSidecar {
  nonce: string;
  binding: TreeBinding;
  /** ISO-8601 mint time. */
  created_at: string;
  /** PID of the minting git-safe-sync process (diagnostic only). */
  pid: number;
}

export interface VerifyInput {
  /** The value of `process.env[NONCE_ENV_VAR]` at hook time (may be undefined). */
  envToken: string | undefined;
  /** Parsed sidecar, or null if absent/unreadable. */
  sidecar: GateNonceSidecar | null;
  /** Freshly recomputed binding for the CURRENT repo state at hook time. */
  currentBinding: TreeBinding;
  /** Tier this push requires (derived from the current HEAD + branch). */
  requiredTier: Tier;
  /** `Date.now()` at hook time. */
  nowMs: number;
  /** TTL window; defaults to NONCE_TTL_MS. */
  ttlMs?: number;
}

export interface VerifyResult {
  ok: boolean;
  /** Stable, human-readable reason — logged by the hook either way. */
  reason: string;
}

/**
 * PURE verification (no IO) — the heart of the safety contract, unit-tested
 * field-by-field. Returns ok=true ONLY when every invariant above holds.
 */
export function verifyNonce(input: VerifyInput): VerifyResult {
  const { envToken, sidecar, currentBinding, requiredTier, nowMs } = input;
  const ttlMs = input.ttlMs ?? NONCE_TTL_MS;

  if (!envToken) return { ok: false, reason: `${NONCE_ENV_VAR} not set` };
  if (!sidecar) return { ok: false, reason: 'no nonce sidecar present' };
  if (!sidecar.nonce || sidecar.nonce !== envToken) {
    return { ok: false, reason: 'env token does not match sidecar nonce' };
  }
  if (!currentBinding.working_tree_clean) {
    return { ok: false, reason: 'working tree is dirty at push time' };
  }

  const b = sidecar.binding;
  if (b.tree_sha !== currentBinding.tree_sha) {
    return { ok: false, reason: `tree changed since gate (validated ${short(b.tree_sha)}, pushing ${short(currentBinding.tree_sha)})` };
  }
  if (b.head_sha !== currentBinding.head_sha) {
    return { ok: false, reason: 'HEAD changed since gate' };
  }
  if ((b.upstream_sha ?? null) !== (currentBinding.upstream_sha ?? null)) {
    return { ok: false, reason: 'upstream moved since gate' };
  }
  if (!sameSubmodulePins(b.submodule_shas, currentBinding.submodule_shas)) {
    return { ok: false, reason: 'submodule pins changed since gate' };
  }
  if (b.tier_covered < requiredTier) {
    return { ok: false, reason: `gate covered tier ${b.tier_covered} but push requires tier ${requiredTier}` };
  }

  const ageMs = nowMs - Date.parse(sidecar.created_at);
  if (Number.isNaN(ageMs)) return { ok: false, reason: 'unparseable nonce timestamp' };
  // Reject future-dated (clock skew / tampering) and expired nonces alike.
  if (ageMs < -60_000) return { ok: false, reason: 'nonce timestamp is in the future' };
  if (ageMs > ttlMs) return { ok: false, reason: `nonce expired (${Math.round(ageMs / 1000)}s old)` };

  return { ok: true, reason: `gate nonce valid for tree ${short(b.tree_sha)} (tier ${b.tier_covered})` };
}

function sameSubmodulePins(a: Record<string, string>, b: Record<string, string>): boolean {
  const ak = Object.keys(a).sort();
  const bk = Object.keys(b).sort();
  if (ak.length !== bk.length) return false;
  for (let i = 0; i < ak.length; i++) {
    if (ak[i] !== bk[i]) return false;
    if (a[ak[i]] !== b[bk[i]]) return false;
  }
  return true;
}

function short(sha: string): string {
  return sha.slice(0, 9);
}

// ---------------------------------------------------------------------------
// IO helpers (used by git-safe-sync to mint, and by the hook to read/consume).
// ---------------------------------------------------------------------------

function git(repoRoot: string, args: string[]): string {
  return gitCapture(args, { cwd: repoRoot }).trim();
}

function gitOrNull(repoRoot: string, args: string[]): string | null {
  try {
    return git(repoRoot, args);
  } catch {
    return null;
  }
}

/**
 * Parse `git submodule status` → { path: sha }. Leading +/-/U markers stripped.
 *
 * STRICT / fail-closed (review F1): uses `git()` (which throws on a non-zero
 * exit), NOT `gitOrNull()`. A repo with no submodules returns exit 0 + empty
 * output → `{}` legitimately; but a *failed* inspection must never be read as
 * "no submodules" — it throws and the caller (`check-gate-nonce.ts`) fails the
 * nonce closed (→ full gate). Failing open here would let a future merge-queue
 * fast-path a push whose submodule pins were never actually checked.
 */
function readSubmodulePins(repoRoot: string): Record<string, string> {
  const out = git(repoRoot, ['submodule', 'status']);
  const pins: Record<string, string> = {};
  if (!out) return pins;
  for (const line of out.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    // Format: "[+-U ]<sha> <path> (<describe>)"
    const m = trimmed.match(/^[+\-U ]?([0-9a-f]{40})\s+(\S+)/);
    if (m) pins[m[2]] = m[1];
  }
  return pins;
}

/**
 * Clean iff superproject porcelain is empty AND every submodule porcelain is
 * empty. STRICT / fail-closed (review F1): both git calls use `git()` and throw
 * on failure. A failed `submodule foreach` must NOT be read as "clean" — that
 * would fail open. `git status --porcelain` can elide in-submodule file edits
 * depending on config, so each submodule is checked explicitly; empty output
 * (exit 0) ⇒ all clean, any non-zero exit throws → nonce fails closed.
 */
function isWorkingTreeClean(repoRoot: string): boolean {
  const superDirty = git(repoRoot, ['status', '--porcelain']).length > 0;
  if (superDirty) return false;
  const subDirty = git(repoRoot, [
    'submodule',
    'foreach',
    '--quiet',
    '--recursive',
    'git status --porcelain',
  ]);
  return subDirty.length === 0;
}

/**
 * Recompute the binding for the current repo state. `tier` is supplied by the
 * caller (it derives the tier the same way the hook does, from HEAD + branch).
 */
export function computeTreeBinding(repoRoot: string, tier: Tier): TreeBinding {
  return {
    head_sha: git(repoRoot, ['rev-parse', 'HEAD']),
    tree_sha: git(repoRoot, ['rev-parse', 'HEAD^{tree}']),
    upstream_sha: gitOrNull(repoRoot, ['rev-parse', '@{u}']),
    submodule_shas: readSubmodulePins(repoRoot),
    tier_covered: tier,
    working_tree_clean: isWorkingTreeClean(repoRoot),
  };
}

export function mintNonce(): string {
  return randomBytes(24).toString('hex');
}

export function sidecarPath(repoRoot: string): string {
  return resolve(repoRoot, NONCE_SIDECAR_REL);
}

/** git-safe-sync: write the sidecar after a green pre-validate run. */
export function writeNonceSidecar(repoRoot: string, sidecar: GateNonceSidecar): void {
  const p = sidecarPath(repoRoot);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify(sidecar, null, 2), 'utf-8');
}

/** hook: read the sidecar (null if absent/corrupt). */
export function readNonceSidecar(repoRoot: string): GateNonceSidecar | null {
  const p = sidecarPath(repoRoot);
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, 'utf-8')) as GateNonceSidecar;
  } catch {
    return null;
  }
}

/**
 * git-safe-sync: mint a nonce + write the sidecar after a green pre-validate
 * run. Refuses to mint on a dirty tree (construction guard — a nonce must only
 * ever vouch for a clean, committed tree). Returns the nonce to set in the push
 * spawn env (`REBEL_PREPUSH_GATE_OK`).
 */
export function mintAndWriteNonce(
  repoRoot: string,
  tier: Tier,
  nowIso: string,
  pid: number,
): { nonce: string; binding: TreeBinding } {
  const binding = computeTreeBinding(repoRoot, tier);
  if (!binding.working_tree_clean) {
    throw new Error('refusing to mint gate nonce: working tree (or a submodule) is dirty');
  }
  const nonce = mintNonce();
  writeNonceSidecar(repoRoot, { nonce, binding, created_at: nowIso, pid });
  return { nonce, binding };
}

/**
 * hook: delete the sidecar (single-use). Returns true iff the sidecar is gone
 * afterwards. The caller MUST treat `false` as "do not fast-path" (review F2):
 * a sidecar that survives could be replayed by a later push, so a failed delete
 * fails the nonce closed (→ full gate) rather than silently fast-pathing.
 */
export function consumeNonceSidecar(repoRoot: string): boolean {
  try {
    rmSync(sidecarPath(repoRoot), { force: true });
    return !existsSync(sidecarPath(repoRoot));
  } catch {
    return false;
  }
}
