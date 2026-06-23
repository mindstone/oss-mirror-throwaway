#!/usr/bin/env npx tsx
/**
 * validate:fast group: source-policy chokepoint guards (batched).
 *
 * These are import-safe (Bucket A) anti-rot chokepoint guards: each scans the
 * source tree for a banned pattern / required shape and signals its verdict by
 * returning or via `process.exit`. Batching them into ONE process (this file is
 * a single `STEPS` entry) collapses ~11 `node --import tsx` boots into 1,
 * recovering ~10×0.35s of tsx/esbuild boot tax — with NO loss of coverage:
 * `guardFromMain` runs each guard's UNCHANGED `main()` with `process.exit`
 * intercepted, fail-closed (see scripts/lib/guard-group-runner.ts).
 *
 * Adding/removing a guard here changes the step-identity baseline: the group's
 * members are registered in `loadGroupExpansions()` (scripts/run-validate-fast.ts)
 * so the set-equality registry test flattens to per-guard identities — a
 * silently dropped guard fails that test. Regenerate the baseline in the same
 * commit: `npx tsx scripts/run-validate-fast.ts --write-step-baseline`.
 *
 * To run standalone: `npx tsx scripts/groups/source-policy-chokepoints.ts`
 * To rerun ONE guard standalone: see the rerun hint printed on failure.
 */
import { guardFromMain, runGroupAsCli, type GuardGroupMember } from '../lib/guard-group-runner';

import { main as roleResolutionChokepoint } from '../check-role-resolution-chokepoint';
import { main as appExitChokepoint } from '../check-app-exit-chokepoint';
import { main as fseventsContainment } from '../check-fsevents-containment';
import { main as capabilityResolutionDispatchSeam } from '../check-capability-resolution-dispatch-seam';
import { main as willQuitPreventdefaultChokepoint } from '../check-will-quit-preventdefault-chokepoint';
import { main as agentToolBodyModelSource } from '../check-agent-tool-body-model-source';
import { main as agentTurnDispatchChokepoint } from '../check-agent-turn-dispatch-chokepoint';
import { main as safetyDirCallSites } from '../check-safety-dir-call-sites';
import { main as trustedToolWriteNormalization } from '../check-trusted-tool-write-normalization';
import { main as failopenScopeReaders } from '../check-failopen-scope-readers';
import { main as pathrootStartswithContainment } from '../check-pathroot-startswith-containment';
import { main as safetyEvalRetryTransience } from '../check-safety-eval-retry-transience';

export const GROUP_NAME = 'validate:source-policy-chokepoints';

/**
 * Members. `name` MUST equal the guard's original validate:fast STEPS name so
 * the flattened step-identity baseline stays traceable to each guard.
 */
export const GUARDS: readonly GuardGroupMember[] = [
  guardFromMain('check-role-resolution-chokepoint', roleResolutionChokepoint, 'npx tsx scripts/check-role-resolution-chokepoint.ts'),
  guardFromMain('check-app-exit-chokepoint', appExitChokepoint, 'npx tsx scripts/check-app-exit-chokepoint.ts'),
  guardFromMain('check-fsevents-containment', fseventsContainment, 'npx tsx scripts/check-fsevents-containment.ts'),
  guardFromMain('check-capability-resolution-dispatch-seam', capabilityResolutionDispatchSeam, 'npx tsx scripts/check-capability-resolution-dispatch-seam.ts'),
  guardFromMain('check-will-quit-preventdefault-chokepoint', willQuitPreventdefaultChokepoint, 'npx tsx scripts/check-will-quit-preventdefault-chokepoint.ts'),
  guardFromMain('check-agent-tool-body-model-source', agentToolBodyModelSource, 'npx tsx scripts/check-agent-tool-body-model-source.ts'),
  guardFromMain('check-agent-turn-dispatch-chokepoint', agentTurnDispatchChokepoint, 'npx tsx scripts/check-agent-turn-dispatch-chokepoint.ts'),
  guardFromMain('check-safety-dir-call-sites', safetyDirCallSites, 'npx tsx scripts/check-safety-dir-call-sites.ts'),
  guardFromMain('check-trusted-tool-write-normalization', trustedToolWriteNormalization, 'npx tsx scripts/check-trusted-tool-write-normalization.ts'),
  guardFromMain('check-failopen-scope-readers', failopenScopeReaders, 'npx tsx scripts/check-failopen-scope-readers.ts'),
  guardFromMain('check-pathroot-startswith-containment', pathrootStartswithContainment, 'npx tsx scripts/check-pathroot-startswith-containment.ts'),
  guardFromMain('check-safety-eval-retry-transience', safetyEvalRetryTransience, 'npx tsx scripts/check-safety-eval-retry-transience.ts'),
];

/** Member names — consumed by run-validate-fast.ts `loadGroupExpansions()`. */
export const GUARD_NAMES: readonly string[] = GUARDS.map((g) => g.name);

runGroupAsCli(import.meta.url, GROUP_NAME, GUARDS);
