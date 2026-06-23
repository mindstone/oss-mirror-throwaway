/**
 * Turn Pipeline — barrel export (R1 Stage 1)
 *
 * Re-exports types only. NO value re-exports of phase impls.
 *
 * Stage 1 acceptance criterion (Round 4 finding #8): a structural test asserts
 * `index.ts` exports only `export type ...` declarations. This closes the
 * "phase impl re-exported through index" bypass for the phase-to-phase ESLint
 * rule — even if a future agent attempts to re-export an impl from here, the
 * structural test fails before the lint rule has a chance to.
 *
 * Future agents: do NOT add `export {` (value-export) lines to this file. If
 * you need to share a value across phase modules, put it in `runPhase.ts`
 * (the SOLE always-importable shared value module — see eslint.config.mjs
 * phase-to-phase rule allow-list).
 */

export type {
  // Phase identity
  PhaseName,
  // Cleanup
  TurnCleanupReason,
  TurnCleanupKey,
  CleanupFn,
  AttemptCleanupFnsRecord,
  TerminalCleanupFnsRecord,
  // Result envelope
  TurnPhaseResult,
  TurnPhaseError,
  TurnRecoveryDirective,
  TurnCompletionDirective,
  // Phase outputs
  AdmittedTurn,
  TurnContext,
  RoleTargetDescriptor,
  RuntimeContextModelHalf,
  RuntimeContextRoutingHalf,
  RuntimeContextData,
  TurnRuntimeHandles,
  HookGraph,
  TurnQueryOutcome,
  // Mutable bags
  MutableTrackingCounters,
  MutableWatchdogDiagnostics,
  RawStreamTrackerSnapshot,
  // Watchdog deps
  WatchdogStartDeps,
  WatchdogRegistryHandle,
  WatchdogApproval,
  // Recovery context split
  TurnCompletionBaseContext,
  RuntimePhaseAccumulator,
  ResolvedRuntimePhaseAccumulator,
  ErrorRecoveryFieldCoverage,
  TurnRetryFn,
  // Observability
  TurnPhaseLogEvent,
} from './types';
