#!/usr/bin/env npx tsx
/**
 * validate:fast group: anti-rot / source-policy / config-hygiene guards (batched).
 *
 * 9 import-safe guards run in ONE process via guardFromMain (scripts/lib/
 * guard-group-runner.ts), collapsing 9 `node --import tsx` boots into 1 — same
 * checks, same coverage, fail-closed. Third batched group (docs/plans/
 * 260618_git-safe-sync-speedup); see source-policy-chokepoints.ts / registry-parity.ts.
 *
 * Every member was verified (read-only static-analysis pass) as a SAFE one-token
 * conversion: a parameterless `main(): void` containing all the work, gated behind
 * an `invokedDirectly` / `import.meta.url===` / `process.argv[1]===` check so import
 * is inert; `process.argv` used ONLY in that guard (no behaviour-affecting flag
 * parsing); no process.chdir / env writes / timers / subprocess spawns / shared
 * mutable module state. Guards that needed a `run()` extraction, an adapter for a
 * non-`number|void` return, flag-threading, or used the `if (!process.env.VITEST)`
 * pseudo-guard (NOT import-safe under the batch runner) were deliberately excluded.
 *
 * Members registered in `loadGroupExpansions()` (scripts/run-validate-fast.ts) so
 * the step-identity baseline flattens per-guard. Regenerate the baseline in the
 * same commit: `npx tsx scripts/run-validate-fast.ts --write-step-baseline`.
 */
import { guardFromMain, runGroupAsCli, type GuardGroupMember } from '../lib/guard-group-runner';

import { main as huskyPrePushFastTier } from '../check-husky-pre-push-fast-tier';
import { main as oauthSetupGuidance } from '../check-oauth-setup-guidance';
import { main as rendererOauthSetupGuidance } from '../check-renderer-oauth-setup-guidance';
import { main as noLegacyEvalTokens } from '../check-no-legacy-eval-tokens';
import { main as escapeHatches } from '../check-escape-hatches';
import { main as directSessionPuts } from '../check-direct-session-puts';
import { main as agentErrorEmitCallers } from '../check-agent-error-emit-callers';
// NOTE: check-bound-bts-eval-contracts stays standalone — it imports an evals/
// manifest, which would cascade extra tsconfig.node.json includes to type-check.
import { main as noRawIpcInvoke } from '../check-no-raw-ipc-invoke';
import { main as agentEventManifest } from '../check-agent-event-manifest';
import { main as commitMarkerDetection } from '../check-commit-marker-detection';

export const GROUP_NAME = 'validate:anti-rot-source-checks';

/** `name` MUST equal the guard's original validate:fast STEPS name. */
export const GUARDS: readonly GuardGroupMember[] = [
  guardFromMain('check-husky-pre-push-fast-tier', huskyPrePushFastTier, 'npx tsx scripts/check-husky-pre-push-fast-tier.ts'),
  guardFromMain('check-oauth-setup-guidance', oauthSetupGuidance, 'npx tsx scripts/check-oauth-setup-guidance.ts'),
  guardFromMain('check-renderer-oauth-setup-guidance', rendererOauthSetupGuidance, 'npx tsx scripts/check-renderer-oauth-setup-guidance.ts'),
  guardFromMain('check-no-legacy-eval-tokens', noLegacyEvalTokens, 'npx tsx scripts/check-no-legacy-eval-tokens.ts'),
  guardFromMain('validate:escape-hatches', escapeHatches, 'npm run validate:escape-hatches'),
  guardFromMain('validate:direct-session-puts', directSessionPuts, 'npm run validate:direct-session-puts'),
  guardFromMain('validate:agent-error-emit-callers', agentErrorEmitCallers, 'npm run validate:agent-error-emit-callers'),
  guardFromMain('check-no-raw-ipc-invoke', noRawIpcInvoke, 'npx tsx scripts/check-no-raw-ipc-invoke.ts'),
  guardFromMain('validate:r2-manifest-guard', agentEventManifest, 'npm run validate:r2-manifest-guard'),
  guardFromMain('check-commit-marker-detection', commitMarkerDetection, 'npx tsx scripts/check-commit-marker-detection.ts'),
];

/** Member names — consumed by run-validate-fast.ts `loadGroupExpansions()`. */
export const GUARD_NAMES: readonly string[] = GUARDS.map((g) => g.name);

runGroupAsCli(import.meta.url, GROUP_NAME, GUARDS);
