/**
 * Turn Pipeline — Type Contracts (R1 Stage 1)
 *
 * Pure leaf-types module for the typed phase pipeline that decomposes
 * `agentTurnExecutor.ts`. NO imports of phase-impl modules. The orchestrator
 * + every phase imports from here.
 *
 * Design intent (locked in by plan, do not regress):
 *   - Four-state `TurnPhaseResult<T>`: failures must declare recovery
 *     (`failed-recoverable`) or completion (`failed-terminal`); silent drop
 *     is unrepresentable.
 *   - Phase payloads are pure value types: no functions, no Maps, no shared
 *     mutable state, no SDK client instances. Hook arrays in `HookGraph`
 *     are the SOLE documented payload-purity exception (mounting hooks IS
 *     the side effect of `turnHookGraphBuilder`).
 *   - Closures (`buildQueryOptions`, `applyRoutePlan`, `createPromptOrGenerator`)
 *     and SDK clients (`directExecutionClient`, `directPlanningClient`)
 *     live in orchestrator-owned bags constructed AFTER phases return.
 *   - Cleanup keys are exhaustively typed: `Record<TurnCleanupKey,
 *     CleanupFn | null>` for both attempt-scope and terminal-scope. Adding a
 *     new key without registering it in BOTH records is a TS compile error.
 *   - `ErrorRecoveryContext` is built from `TurnCompletionBaseContext`
 *     (always-available at admission entry) + `RuntimePhaseAccumulator`
 *     (built by phases, discriminated `'pre-runtime' | 'runtime-ready'`).
 *
 * See:
 *   - `docs/plans/260427_refactor_agent_turn_executor_pipeline.md`
 *   - `docs/plans/260427_r1_stage0_working_notes.md`
 */

import type { EventWindow } from '@core/types';
import type { TurnSessionLogger } from '@core/logger';
import type { AppSettings } from '@shared/types';
import type { ModelProfile } from '@shared/types/settings';
import type {
  TurnParams,
  QueryRouterContext,
} from '@core/rebelCore/queryRouter';
import type {
  ProviderRoutePlan,
  ProviderRouteRuntimeContext,
} from '@core/rebelCore/providerRoutePlan';
import type { ProviderRouterTurnInput } from '@core/rebelCore/providerRouting';
import type { ProviderRouteDecision } from '@core/rebelCore/providerRouteDecision';
import type { resolveModelConfig } from '@shared/utils/modelNormalization';
import type {
  TurnRetryOverrides,
  ErrorRecoveryContext,
} from '@main/services/turnErrorRecovery';

// ---------------------------------------------------------------------------
// SECTION: Phase identity
// ---------------------------------------------------------------------------

/**
 * Names of the typed phases the orchestrator iterates through.
 *
 * Order matters: each phase's output may feed downstream phases through the
 * orchestrator (never directly between phase modules).
 */
export type PhaseName =
  | 'admission'
  | 'preTurnContext'
  | 'modelMcp'
  | 'routingProxy'
  | 'hookGraph'
  | 'primaryQueryShell'
  | 'completion';

// ---------------------------------------------------------------------------
// SECTION: Cleanup reasons
// ---------------------------------------------------------------------------

/**
 * Every cleanup-reason string passed to `completeTurnCleanup(turnId, reason)`.
 *
 * Plan F3 enumerated 14 terminal exits in the executor (Stage 0 working notes
 * § A) plus the catch-block routes through `turnErrorRecovery.dispatchErrorRecovery`,
 * which uses additional reason strings for billing / fallback / graceful-degradation
 * paths. The Round-4 `'pre-runtime-failure'` reason is added for the runPhase
 * wrapper's pre-runtime-context throw path (finding #4).
 *
 * If a future agent adds a new cleanup reason, list it here so the orchestrator
 * switch and corpus tests stay exhaustive.
 */
export type TurnCleanupReason =
  // Admission / preflight terminals (F3 #1-4)
  | 'missing-core-directory'
  | 'codex-not-connected'
  | 'openrouter-not-connected'
  | 'mindstone-key-missing'
  | 'missing-auth'
  // Chief-of-Staff instructions unreadable at admission (desktop only, 260622 Stage 3)
  | 'chief-of-staff-unavailable'
  // Council eligibility terminal (subscription-tier zero-survivor block)
  | 'council_blocked'
  // Generic abort terminal — used by F3 #4, #5, #6, #12, #13 + many recovery paths
  | 'aborted'
  // Post-MCP / model-finalization terminals (F3 #7)
  | 'invalid-core-directory'
  // Hook-setup terminal (F3 #8)
  | 'profile-incompatible'
  // Routing-proxy terminals (F3 #9-11)
  | 'council-proxy-failed'
  | 'council-proxy-missing-auth'
  | 'openrouter-proxy-failed'
  // Primary-query-shell terminals (F3 #14, success arm reused)
  | 'completed'
  | 'hook-stopped'
  | 'watchdog-aborted'
  // turnErrorRecovery dispatched terminals (verified via grep on recovery module)
  | 'upstream-abort'
  | 'tool-input-too-large'
  | 'completed-max-200k-fallback'
  | 'completed-thinking-model-fallback'
  | 'alt-model-error'
  | 'completed-altmodel-fallback'
  | 'altmodel-fallback-failed'
  | 'server-error'
  | 'billing-error'
  | 'rate-limit'
  | 'completed-pause-coerced'
  | 'completed-graceful-degradation'
  | 'completed-graceful-degradation-from-tools'
  | 'completed-zero-output-no-recovery'
  // Round 4 finding #4: minimum-viable recovery for pre-runtime phase throws
  | 'pre-runtime-failure';

// ---------------------------------------------------------------------------
// SECTION: Recovery directives + completion directives
// ---------------------------------------------------------------------------

/**
 * Typed envelope for the catch-block error reaching `turnCompletion`.
 *
 * Stage 1 keeps this minimal — the existing `ErrorRecoveryContext` shape in
 * `turnErrorRecovery.ts` is the source of truth for handler logic. The wrapper
 * preserves the original error and adds phase metadata for diagnostics.
 */
export interface TurnPhaseError {
  readonly phase: PhaseName;
  /** Original thrown value (may be `Error`, `string`, or untyped). */
  readonly cause: unknown;
  /** Indicates the phase returned `failed-*` rather than throwing. */
  readonly synthetic?: boolean;
  /** Optional message for log breadcrumbs. */
  readonly message?: string;
}

/**
 * What the orchestrator should do with a `failed-recoverable` result.
 *
 * `RouteRebuildHint` (R4) is one variant inside this; other variants cover
 * recursive retry, cooldown-then-retry, overflow-compaction handoff, and
 * abort acknowledgement. See plan F3.
 *
 * Stages 3-9 keep using the existing `ErrorRecoveryContext` /
 * `dispatchErrorRecovery` shape internally — this directive type is the
 * orchestrator-boundary contract only.
 */
export type TurnRecoveryDirective =
  | { readonly kind: 'recursive-retry'; readonly overrides?: TurnRetryOverrides }
  | { readonly kind: 'cooldown-then-retry'; readonly waitMs: number; readonly overrides?: TurnRetryOverrides }
  | { readonly kind: 'overflow-compaction-handoff'; readonly compactionPrompt: string }
  | { readonly kind: 'abort-acknowledge' }
  | { readonly kind: 'terminal-error-dispatch'; readonly humanizedMessage: string };

/**
 * What the orchestrator should do with a `terminal` or `failed-terminal`
 * result. The `reason` is exactly the string passed to `completeTurnCleanup`.
 */
export interface TurnCompletionDirective {
  readonly reason: TurnCleanupReason;
  /** Optional humanized message for the synthetic terminal event. */
  readonly humanizedMessage?: string;
}

// ---------------------------------------------------------------------------
// SECTION: TurnPhaseResult<T> — four-state discriminated union (Round 2)
// ---------------------------------------------------------------------------

/**
 * The four-state result every phase returns.
 *
 *   - `ok`               — phase produced its typed output; orchestrator continues.
 *   - `terminal`         — phase decided the turn ends now (admission preflight,
 *                          query-success arm, etc.). Orchestrator runs cleanup and stops.
 *   - `failed-recoverable` — phase failed; orchestrator passes the error to
 *                          `turnCompletion` with a recovery directive (model swap,
 *                          provider swap, retry, etc.).
 *   - `failed-terminal`  — phase failed; orchestrator runs cleanup with the
 *                          completion directive's reason (no retry possible).
 *
 * Required fields per arm:
 *   - `failed-recoverable` REQUIRES `recovery`.
 *   - `failed-terminal`  REQUIRES `completion`.
 *   - `terminal`         REQUIRES `reason`.
 *
 * The TS contract test in `turnPipeline.types.test.ts` asserts that
 * "failed-without-recovery" is unrepresentable.
 */
export type TurnPhaseResult<T> =
  | { readonly status: 'ok'; readonly value: T }
  | { readonly status: 'terminal'; readonly reason: TurnCleanupReason; readonly humanizedMessage?: string }
  | { readonly status: 'failed-recoverable'; readonly error: TurnPhaseError; readonly recovery: TurnRecoveryDirective }
  | { readonly status: 'failed-terminal'; readonly error: TurnPhaseError; readonly completion: TurnCompletionDirective };

// ---------------------------------------------------------------------------
// SECTION: Mutable bags (round-4 reviewer-convergent stage-acceptance amendment)
// ---------------------------------------------------------------------------

/**
 * Tracking counters mutated progressively by the primary query shell.
 *
 * Allocated once at admission entry; the SAME reference is passed into Stages
 * 4/5/9 and read by `turnCompletion.handleError` at recovery dispatch time.
 *
 * Per Stage 0 working notes § B.2: 6 fields.
 */
export interface MutableTrackingCounters {
  messageCount: number;
  receivedResultMessage: boolean;
  lastMessageType: string | undefined;
  lastToolName: string | undefined;
  mcpMode: string | undefined;
  hasMedia: boolean;
}

/**
 * Watchdog diagnostics mutated by the watchdog interval body when auto-abort
 * fires (or by the orchestrator when it observes diagnostic state from the
 * watchdog tracker).
 *
 * Allocated at admission entry and held by `TurnCompletionBaseContext` so
 * recovery dispatch always reads the current values.
 *
 * Per Stage 0 working notes § B.3: 9 fields.
 */
export interface MutableWatchdogDiagnostics {
  abortedByWatchdog: boolean;
  /**
   * Stage 1a (260617_bricked-state-0448-electron42): true when the abort was the
   * earlier, interactive-gated `awaiting_api` hard-stall ceiling (request sent,
   * no first token). Sub-case of `abortedByWatchdog`. Threaded into
   * `ErrorRecoveryContext` so BOTH terminal exit paths — the post-loop branch
   * AND the AbortError catch path (`handleAbortErrors`) — emit the recognised
   * retryable `message_timeout` terminal instead of generic watchdog copy.
   */
  abortedByAwaitingApiStall: boolean;
  watchdogFired: boolean;
  watchdogFiredAt: number | undefined;
  maxWatchdogLevel: number;
  watchdogLevel: number;
  effectiveAbortMs: number;
  rawStreamEventCount: number;
  rawStreamLastEventType: string | null;
  rawStreamLastEventAgeMs: number | null;
}

/**
 * Snapshot shape returned by the orchestrator's raw-stream tracker.
 * Produced by a closure read; mirrored into `MutableWatchdogDiagnostics` by
 * the watchdog body.
 */
export interface RawStreamTrackerSnapshot {
  readonly lastEventType: string | null;
  readonly lastTimestamp: number | null;
  readonly eventCount: number;
}

// ---------------------------------------------------------------------------
// SECTION: Phase output payload types (pure value-types only)
// ---------------------------------------------------------------------------

/**
 * Stage 2 output. Carries everything the rest of the pipeline needs about
 * "this turn was admitted" — ids, settings, derived flags, sanitized prompts.
 *
 * The `abortController` is a class instance (allowed: read-only reference to
 * an orchestrator-owned object — purity rule covers shared mutable state and
 * SDK clients, not the lifecycle controller).
 */
export interface AdmittedTurn {
  readonly turnId: string;
  readonly win: EventWindow | null;
  readonly abortController: AbortController;
  readonly settings: AppSettings;
  readonly codexConnectedAtTurnStart: boolean;
  readonly rendererSessionId: string | null;
  readonly effectiveResetConversation: boolean;
  readonly unleashedMode: boolean;
  readonly finishLine: string | undefined;
  readonly councilModeRequested: boolean;
  readonly prompts: {
    readonly promptForContext: string;
    readonly promptWithoutOurComponents: string;
    readonly promptWithoutOurComponentsOrUnleashed: string;
    readonly explicitDesignContextRequested: boolean;
    readonly explicitOurComponentsRequested: boolean;
  };
  /**
   * 260622 Stage 3 (F2 TOCTOU convergence): the Chief-of-Staff README body the
   * DESKTOP admission gate already read via the single killable bounder, threaded
   * forward so `resolveSystemPrompt` does NOT re-read it (kills the double-read /
   * TOCTOU window). Present ONLY when admission read CoS as `ok` (desktop turns);
   * `undefined` on cloud/headless (`win === null`, no gate) and on first-run
   * admit-without-content — in which case `resolveSystemPrompt` reads as before.
   */
  readonly prefetchedChiefOfStaffContent?: string;
}

/**
 * Stage 5 output. Pure-value: `sourcePathMap` is a sorted-tuple
 * `Array<[string, string]>` (NOT a Map) so the payload remains R7-pure.
 *
 * The orchestrator constructs a Map from this if downstream consumers need
 * O(1) lookup.
 */
export interface TurnContext {
  readonly effectivePrompt: string;
  readonly promptWithAttachments: string;
  readonly hasMedia: boolean;
  readonly contextSections: ReadonlyArray<{
    readonly kind: string;
    readonly content: string;
  }>;
  readonly attachmentPayloads: ReadonlyArray<unknown>;
  readonly sourcePathMap: ReadonlyArray<readonly [string, string]>;
  readonly skillModelResolution?: ReadonlyArray<unknown>;
  readonly skillEffortRecommendations?: ReadonlyArray<unknown>;
  readonly totalAttachments: number;
}

/**
 * Pure descriptor for a role-target client (execution / planning).
 *
 * Stage 7 returns descriptors; the orchestrator instantiates SDK clients
 * (`directExecutionClient`, `directPlanningClient`) into `TurnRuntimeHandles`
 * from route-plan-backed client creation AFTER the phase returns.
 *
 * No SDK client instances live in the phase payload — the R7-purity rule.
 */
export interface RoleTargetDescriptor {
  readonly provider: string;
  readonly modelId: string;
  readonly headers: ReadonlyArray<readonly [string, string]>;
  readonly envOverride?: Readonly<Record<string, string>>;
}

/**
 * Stage 6 output (model + MCP + base capability).
 *
 * Per plan F11 purity table: 12 fields, no closures, no SDK clients.
 */
export interface RuntimeContextModelHalf {
  readonly modelConfig: ReturnType<typeof resolveModelConfig>;
  readonly mcpServers: ReadonlyArray<unknown>;
  readonly mcpMode: string | undefined;
  readonly baseSystemPrompt: string;
  readonly baseCapabilityResolution: Readonly<Record<string, unknown>>;
  readonly profileResolution: Readonly<{
    readonly activeProfile: ModelProfile | null | undefined;
    readonly thinkingProfile: ModelProfile | null;
    readonly workingProfile: ModelProfile | null;
  }>;
  readonly effectiveThinkingEffort: string | undefined;
  readonly effectiveThinkingModel: string | undefined;
  readonly extendedContextEnabled: boolean;
  readonly planModeEnabled: boolean;
  readonly thinkingModelOverride: string | undefined;
  readonly requestedModel: string;
}

/**
 * Stage 7 output (routing + proxies + final-prompt overlay + role descriptors).
 *
 * Per plan F11 purity table: 10 fields, no closures, no SDK clients.
 */
export interface RuntimeContextRoutingHalf {
  readonly councilConfig: Readonly<Record<string, unknown>> | undefined;
  readonly adHocConfig: Readonly<Record<string, unknown>> | undefined;
  readonly claudeSubagentConfig: Readonly<Record<string, unknown>> | undefined;
  readonly executionRoleTarget: RoleTargetDescriptor;
  readonly planningRoleTarget: RoleTargetDescriptor;
  readonly providerRoutePlan: ProviderRoutePlan;
  readonly routeInput: ProviderRouterTurnInput;
  /**
   * The orchestrator invokes this with a decision to materialize the route
   * plan's runtime context. Pure function (no SDK client instances captured).
   */
  readonly routeRuntimeContextForDecision: (decision: ProviderRouteDecision) => ProviderRouteRuntimeContext;
  readonly isDirectRoleProfile: boolean;
  /** Final system prompt with council/ad-hoc/Claude-subagent suffix overlay. */
  readonly finalSystemPrompt: string;
}

/**
 * Combined runtime context — sum of Stage 6 and Stage 7 outputs.
 *
 * The orchestrator constructs `buildQueryOptions`, `applyRoutePlan`, and
 * `createPromptOrGenerator` closures from this + `TurnRuntimeHandles` after
 * Stage 7 returns.
 */
export interface RuntimeContextData {
  readonly modelHalf: RuntimeContextModelHalf;
  readonly routingHalf: RuntimeContextRoutingHalf;
}

/**
 * Orchestrator-owned bag of SDK client instances (Round 3 — moved out of
 * phase payload to preserve R7-purity).
 *
 * Lifecycle: instantiated by orchestrator AFTER Stage 7 returns via
 * route-plan-backed client creation for the execution and planning role
 * targets. Passed into
 * `routerContext` builder in `turnPrimaryQueryShell`. Disposed when the turn
 * ends (the SDK client itself has no explicit `.close()` — GC handles it).
 *
 * Phase payloads MUST NOT contain SDK client instances. Adding one is a
 * structural regression (caught by the routingHalf structural test in
 * Stage 7 acceptance).
 */
export interface TurnRuntimeHandles {
  readonly directExecutionClient: unknown | undefined;
  readonly directPlanningClient: unknown | undefined;
}

/**
 * Stage 8 output. The SOLE documented payload-purity exception:
 * `RebelCoreHooks.hooks` arrays carry function references because mounting
 * hooks IS the side effect of `turnHookGraphBuilder`.
 *
 * The function references are immutable closures over modelHalf+routingHalf
 * +`TurnRuntimeHandles` (passed in via input). No other phase has functions
 * in payloads.
 */
export interface HookGraph {
  readonly rebelCoreHooks: Readonly<Record<string, ReadonlyArray<unknown>>>;
  readonly toolSafetyEnabled: boolean;
  readonly memoryWriteEnabled: boolean;
  readonly autoContinueEnabled: boolean;
}

/**
 * Stage 9 output. Captures the primary-query result + statistics.
 */
export interface TurnQueryOutcome {
  readonly outcome: 'success' | 'aborted' | 'hook-stopped' | 'watchdog-aborted' | 'timeout';
  readonly messageCount: number;
  readonly receivedResultMessage: boolean;
  readonly lastMessageType: string | undefined;
  readonly lastToolName: string | undefined;
  readonly hasMedia: boolean;
  readonly cleanupReason: TurnCleanupReason;
}

// ---------------------------------------------------------------------------
// SECTION: TurnCleanupKey + cleanup-fn record types (Round 4 finding #5)
// ---------------------------------------------------------------------------

export type {
  TurnCleanupKey,
  CleanupFn,
  AttemptCleanupFnsRecord,
  TerminalCleanupFnsRecord,
} from './cleanupTypes';

// ---------------------------------------------------------------------------
// SECTION: TurnCompletionBaseContext + RuntimePhaseAccumulator (Round 4 #4)
// ---------------------------------------------------------------------------

/**
 * Read-only handle exposing the agentTurnRegistry getters the watchdog needs.
 * NOT a write handle — the watchdog never mutates registry state.
 *
 * Stage 4 (`turnWatchdog.ts`) consumes this via `WatchdogStartDeps`.
 */
export interface WatchdogRegistryHandle {
  readonly getUpstreamActivity: (turnId: string) => number | undefined;
  readonly getCloseCallback: (turnId: string) => (() => void) | undefined;
  readonly getTurnModel: (turnId: string) => string | undefined;
  readonly getTurnExtendedContext: (turnId: string) => boolean | undefined;
}

/**
 * Approval (tool / memory) shape the watchdog inspects to decide whether the
 * turn is "waiting for the user to approve" — used in the early-return arm of
 * the watchdog interval body.
 *
 * Kept minimal here (only the field the watchdog actually reads); the real
 * approval shape lives in `toolSafetyService.ts`.
 */
export interface WatchdogApproval {
  readonly turnId: string;
}

/**
 * Per Stage 0 working notes § C: enumerated against the watchdog interval
 * body in `agentTurnExecutor.ts:2946-3160`. ~22 callbacks total (Round 4
 * raised this from "~14" after Opus cross-referenced the actual closure
 * reads).
 *
 * Stage 4 (`turnWatchdog.ts`) consumes this. Adding a new closure read in
 * the watchdog without adding a typed callback here forces a type error;
 * a structural test asserts the interface size matches the watchdog body's
 * distinct closure reads.
 */
export interface WatchdogStartDeps {
  /** WatchdogTracker instance — read-only reference (lifecycle owned by orchestrator). */
  readonly tracker: unknown;
  readonly abortController: AbortController;
  readonly registryHandle: WatchdogRegistryHandle;
  readonly turnId: string;
  readonly logger: TurnSessionLogger;

  // Activity & age (read-only callbacks — orchestrator scope)
  readonly getLastActivityAgeMs: () => number;
  readonly getMessageCount: () => number;
  readonly getMcpMode: () => string | undefined;
  readonly getPhase: () => string;
  readonly getIsComplexTurn: () => boolean;
  readonly getIsAwaitingFirstResponse: () => boolean;
  readonly getActiveSubagentCount: () => number;
  readonly getRawStreamSnapshot: () => RawStreamTrackerSnapshot;

  // Round 4 — newly-enumerated reads from watchdog interval body
  readonly getIsAutomation: () => boolean;
  readonly getPendingToolApprovalsForTurn: () => ReadonlyArray<WatchdogApproval>;
  readonly getPendingMemoryApprovalsForTurn: () => ReadonlyArray<WatchdogApproval>;
  readonly getUpstreamServerCount: () => number;
  readonly getHasMedia: () => boolean;
  readonly getTotalAttachments: () => number;

  // Mutable diagnostics — same reference held by `TurnCompletionBaseContext.watchdogDiagnostics`
  readonly diagnostics: MutableWatchdogDiagnostics;

  // Side-effect emitters (orchestrator-owned)
  readonly emitStatusEvent: (level: number, phase: string, elapsedSeconds: number) => void;
  readonly captureSentryMessage: (message: string, ctx: Record<string, unknown>) => void;
  readonly captureSentryException: (err: Error, ctx: Record<string, unknown>) => void;
  readonly reportMcpError: (err: Error, ctx: Record<string, unknown>) => void;
  /** Returns the primary close-callback used for force-kill if watchdog escalates. */
  readonly getCloseCallback: () => (() => void) | undefined;
}

/**
 * Recursive-retry callback wired by the orchestrator. Phase 3 (`turnCompletion`)
 * passes this through to `ErrorRecoveryContext.retryTurn`.
 */
export type TurnRetryFn = (overrides?: TurnRetryOverrides) => Promise<void>;

/**
 * Always-initialized at orchestrator entry, BEFORE any phase runs.
 *
 * Used by `turnCompletion.handleError` to build a "minimum viable recovery
 * context" when phases throw before runtime context is ready (Round 4 #4).
 *
 * Per Stage 0 working notes § B.1: 15 static-at-entry fields, plus 2
 * mutable-bag references (allocated at entry, fields populate progressively).
 */
export interface TurnCompletionBaseContext {
  readonly turnId: string;
  readonly win: EventWindow | null;
  readonly turnLogger: TurnSessionLogger;
  readonly abortController: AbortController;
  readonly settings: AppSettings;
  readonly rendererSessionId: string | null;
  /** Subset of turnOptions; full shape held by orchestrator scope. */
  readonly turnOptions:
    | {
        readonly resetConversation?: boolean;
        readonly modelOverride?: string;
        readonly longContextFallbackAttempted?: boolean;
        readonly rateLimitFallbackAttempted?: boolean;
        readonly configuredRoleFallbackAttempted?: Partial<Record<'working' | 'thinking' | 'background', boolean>>;
        readonly sessionType?: string;
      }
    | undefined;
  readonly prompt: string;
  readonly retryTurn: TurnRetryFn;
  /**
   * Bag allocated at admission entry; the SAME reference is passed into
   * Stages 4/5/9 and `turnCompletion.handleError` reads the current values
   * at recovery dispatch time.
   */
  readonly trackingCounters: MutableTrackingCounters;
  /** Same shape pattern as `trackingCounters`. */
  readonly watchdogDiagnostics: MutableWatchdogDiagnostics;
  readonly effectiveResetConversation: boolean;
  readonly availableProfiles: ReadonlyArray<ModelProfile>;
  readonly thinkingProfile: ModelProfile | null;
  readonly workingProfile: ModelProfile | null;
  readonly requestedModelForTurn: string;
  readonly getLastActivityAgeMs: () => number;
  readonly getMessageTimeoutMs: () => number;
  /** Returns true while a tool (or subagent Task) is in flight. Wired from the
   *  watchdog (`watchdogTracker.toolInFlightSince`) so Layer 1 (timeoutAsyncIterator)
   *  re-arms during tool execution. See REBEL-1AF. */
  readonly isToolInFlight?: () => boolean;
}

/**
 * Phase-built recovery accumulator.
 *
 * Discriminated `'pre-runtime' | 'runtime-ready'`:
 *   - `'pre-runtime'` — admission/preTurn/modelMcp threw; full
 *     `ErrorRecoveryContext` cannot be built; orchestrator routes to a
 *     "minimum viable recovery" terminal cleanup with reason
 *     `'pre-runtime-failure'`.
 *   - `'runtime-ready'` — routingProxy completed; full `ErrorRecoveryContext`
 *     can be built from `TurnCompletionBaseContext` + this accumulator.
 *
 * Per Stage 0 working notes § B.4: 15 phase-built fields in `'runtime-ready'`.
 */
export type RuntimePhaseAccumulator =
  | {
      readonly stage: 'pre-runtime';
      readonly modelConfig?: undefined;
      readonly queryOptions?: undefined;
      readonly providerRoutePlan?: undefined;
    }
  | {
      readonly stage: 'runtime-ready';
      // Phase-built (Stage 0 § B.4)
      readonly error: unknown;
      readonly modelConfig: ReturnType<typeof resolveModelConfig>;
      readonly extendedContextEnabled: boolean;
      readonly queryOptions: Omit<TurnParams, 'prompt'>;
      readonly buildQueryOptions: (mc?: ReturnType<typeof resolveModelConfig>) => Omit<TurnParams, 'prompt'>;
      readonly createPromptOrGenerator: (conversationContext?: string) => TurnParams['prompt'];
      readonly routerContext: QueryRouterContext | undefined;
      readonly thinkingModelOverride: string | undefined;
      readonly plan: ProviderRoutePlan;
      readonly routeInput: ProviderRouterTurnInput;
      readonly routeRuntimeContextForDecision: (decision: ProviderRouteDecision) => ProviderRouteRuntimeContext;
      readonly applyRoutePlan: (plan: ProviderRoutePlan) => void;
      readonly activeProfile: (ModelProfile & { id?: string }) | null | undefined;
      readonly isDirectRoleProfile: boolean;
      readonly altModelFallbackAttempted: boolean;
      readonly nestedFallbackQueryAttempted: boolean;
    };

/**
 * Helper alias for the runtime-ready arm — useful in TS contract tests that
 * assert `keyof ErrorRecoveryContext ⊆ keyof (TurnCompletionBaseContext &
 * ResolvedRuntimePhaseAccumulator)`.
 */
export type ResolvedRuntimePhaseAccumulator = Extract<
  RuntimePhaseAccumulator,
  { stage: 'runtime-ready' }
>;

/**
 * Compile-time check: every field in `ErrorRecoveryContext` (the existing
 * shape in `turnErrorRecovery.ts`) is covered by the union of
 * `TurnCompletionBaseContext` and the resolved runtime accumulator, plus the
 * mutable bags' fields.
 *
 * If a future agent adds a new field to `ErrorRecoveryContext` without placing
 * it in either bucket OR one of the two mutable bags, the assignability test
 * in `turnPipeline.types.test.ts` fails at compile time.
 */
export type ErrorRecoveryFieldCoverage = keyof ErrorRecoveryContext extends
  | keyof TurnCompletionBaseContext
  | keyof ResolvedRuntimePhaseAccumulator
  | keyof MutableTrackingCounters
  | keyof MutableWatchdogDiagnostics
  ? true
  : false;

// ---------------------------------------------------------------------------
// SECTION: Phase-boundary observability (F12)
// ---------------------------------------------------------------------------

/**
 * Typed phase-boundary log event. Emitted by `runPhase()` on entry / exit and
 * by the orchestrator on terminal exits.
 *
 * Replay corpus rows assert log counts AND order, not just `[ROUTER]`.
 *
 * Per plan F12.
 */
export type TurnPhaseLogEvent =
  | {
      readonly type: 'entry';
      readonly phaseName: PhaseName;
      readonly turnId: string;
      readonly sessionId: string | null;
      readonly attempt: number;
    }
  | {
      readonly type: 'exit';
      readonly phaseName: PhaseName;
      readonly turnId: string;
      readonly status: TurnPhaseResult<unknown>['status'];
      readonly durationMs: number;
      readonly terminalKind?: TurnCleanupReason;
      readonly recoveryKind?: TurnRecoveryDirective['kind'];
    }
  | {
      readonly type: 'terminal';
      readonly phaseName: PhaseName;
      readonly turnId: string;
      readonly cleanupReason: TurnCleanupReason;
    };
