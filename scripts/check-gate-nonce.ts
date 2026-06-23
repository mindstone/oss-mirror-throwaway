#!/usr/bin/env npx tsx
/**
 * ⚠️ SHELVED / DORMANT (260607). `.husky/pre-push` only invokes this when
 * `$REBEL_PREPUSH_GATE_OK` is set, and nothing sets it today — the nonce does
 * NOT fix the push race (see scripts/lib/gate-nonce.ts "WHY THIS IS SHELVED"
 * and docs/project/PREPUSH_GATE_AND_RECEIPTS.md). Retained as a merge-queue
 * primitive. The logic below is correct and verified for that future use.
 *
 * Pre-push fast-path decision (called from `.husky/pre-push`).
 *
 * Decides whether `git-safe-sync` already ran the full gate on THIS exact tree
 * moments ago (outside the push lock) and handed this push a single-use nonce —
 * in which case the hook may skip re-running `validate:fast` + tiered vitest.
 *
 * Exit codes (the hook branches on these):
 *   0  → valid nonce; hook MAY skip the expensive steps. The sidecar is consumed
 *        (single-use) before we exit so it can never be replayed.
 *   1  → no / invalid / expired / mismatched nonce; hook MUST run the full gate.
 *
 * This fails SAFE in every direction: any thrown error, git failure, dirty tree,
 * tree/HEAD/upstream/submodule mismatch, missing env token, or absent sidecar
 * yields exit 1 (full gate). A manual `git push` (no `REBEL_PREPUSH_GATE_OK`
 * env) therefore always runs the full gate.
 *
 * Usage: `npx tsx scripts/check-gate-nonce.ts <required-tier:1|2|3>`
 * The required tier is passed in FROM the hook so tier derivation has a single
 * source of truth (the shell), avoiding drift.
 *
 * @see scripts/lib/gate-nonce.ts
 * @see docs/project/PREPUSH_GATE_AND_RECEIPTS.md
 */
import {
  NONCE_ENV_VAR,
  computeTreeBinding,
  consumeNonceSidecar,
  readNonceSidecar,
  verifyNonce,
  type Tier,
} from './lib/gate-nonce';
import { gitCapture } from './lib/git-exec.js';

function repoRoot(): string {
  return gitCapture(['rev-parse', '--show-toplevel']).trim();
}

function parseTier(arg: string | undefined): Tier {
  if (arg === '1' || arg === '2' || arg === '3') return Number(arg) as Tier;
  // Unknown/missing → assume the most demanding tier so a malformed call can
  // never *loosen* the tier check; it just fails safe to the full gate.
  return 3;
}

function main(): void {
  const requiredTier = parseTier(process.argv[2]);
  const root = repoRoot();
  const envToken = process.env[NONCE_ENV_VAR];
  const sidecar = readNonceSidecar(root);
  const currentBinding = computeTreeBinding(root, requiredTier);

  const result = verifyNonce({
    envToken,
    sidecar,
    currentBinding,
    requiredTier,
    nowMs: Date.now(),
  });

  if (result.ok) {
    // Single-use: the sidecar MUST be gone before we authorise the fast-path,
    // or it could be replayed by a later push. A failed delete fails closed.
    const consumed = consumeNonceSidecar(root);
    if (!consumed) {
      console.error('pre-push: gate nonce valid but its sidecar could not be deleted — running full gate to prevent replay');
      process.exit(1);
    }
    console.error(`✓ pre-push fast-path: ${result.reason} — skipping validate:fast + vitest (already validated)`);
    process.exit(0);
  }

  // Only noisy when a handoff was attempted but didn't match — that's worth
  // seeing. A bare manual push (no env token) stays quiet.
  if (envToken) {
    console.error(`pre-push: gate nonce present but not honored (${result.reason}) — running full gate`);
  }
  process.exit(1);
}

try {
  main();
} catch (err) {
  // Fail safe: any error means "run the full gate".
  console.error(`pre-push: gate-nonce check errored (${err instanceof Error ? err.message : String(err)}) — running full gate`);
  process.exit(1);
}
