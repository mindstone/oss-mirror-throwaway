/**
 * Agent Event Dispatcher — Core
 *
 * Platform-agnostic event dispatch: sends events to the renderer (via EventWindow),
 * accumulates them in the context accumulator, routes to event listeners,
 * and triggers auto-title generation on result events.
 *
 * Desktop-specific side effects (dock badge, OS notifications) live in the
 * @main/ decorator that wraps this module.
 */

import type { EventWindow } from '@core/types';
import { fireAndForget } from '@shared/utils/fireAndForget';
import type { AgentEvent, AgentTurnMessage } from '@shared/types';
import { classifySessionKind, shouldSkipCheckpointing, hasFixedTitle } from '@shared/sessionKind';
import type { AgentErrorKind } from '@shared/utils/agentErrorCatalog';
import { createScopedLogger } from '@core/logger';
import { getErrorMessage } from '@core/utils/getErrorMessage';
import { redactAndTruncateRawError } from '@core/utils/redactRawError';
import { getTracker } from '@core/tracking';
import { classifyHttpError, ModelError } from '@core/rebelCore/modelErrors';
import { ownerForRecoveryKind, type RecoveryOwner } from './turnErrorRecoveryOwnership';
import type { ProviderCredentialSource } from '@shared/types/providerRoute';
import {
  humanizeRoleResolutionFailure,
  isRoleResolutionFailure,
  parseRoleResolutionFailureFromRawError,
} from '@core/rebelCore/modelRoleResolver';
import {
  classifyBillingSubtype,
  extractRetryAfterMs,
  isBillingMessage,
  isRateLimitMessage,
  isTransientError,
} from '@shared/utils/friendlyErrors';
import { getErrorKind } from '@shared/utils/agentErrorCatalog';
import {
  classifyErrorUx,
  humanizeAgentError,
  HUMANIZER_SAFE_FALLBACK,
  setHumanizerFailureObserver,
  type ClassifyErrorUxInput,
  type HumanizerFailureReport,
} from '@rebel/shared';
import { invariant } from '@shared/utils/invariant';

const log = createScopedLogger({ service: 'agentEventDispatcher' });
const HUMANIZER_OWNED_KINDS = ['rate_limit'] as const satisfies readonly AgentErrorKind[];
const HUMANIZER_OWNED_KIND_SET = new Set<AgentErrorKind>(HUMANIZER_OWNED_KINDS);

// ---------------------------------------------------------------------------
// I2 emit-boundary fence (260529 error-emit-funnel, Stage 2; hardened Stage 5).
//
// The wire contract is that `errorKind` is *omitted entirely* when the kind is
// `'unknown'` — never emitted as the literal string `'unknown'`. The renderer's
// `isFollowOnClassifiedError` supersede guard keys on `event.errorKind !==
// undefined` (`conversationState.ts`), so an event that carried
// `errorKind: 'unknown'` would make a generic unknown follow-on eligible to
// supersede a classified prior — silently reintroducing F3 (the transient
// stamp would be dropped). The event-construction spread
// (`...(errorKind !== 'unknown' ? { errorKind } : {})`) enforces this today;
// this fence guards against a future edit that breaks the omission.
//
// Stage 5 (GPT-5.5 review): the fence is NO LONGER a hard `invariant` throw
// sitting before the dispatch `try`. A hard throw on the error-dispatch path is
// fail-closed-by-crash — it would drop the very error event the funnel exists to
// surface. Instead the response is gated on the environment (mirroring
// `errorReporter.ts`'s `NODE_ENV === 'test'` gate):
//   - test/CI (`NODE_ENV === 'test'`): throw, so a violating edit fails loudly
//     before merge.
//   - prod/dev: NORMALIZE in place (strip the offending `errorKind` so the
//     event is wire-correct — exactly the shape the omission spread would have
//     produced, every other field left intact) and the error STILL surfaces;
//     report the violation observably; then return so the caller proceeds into
//     the dispatch. The error event must never be dropped.
// The net invariant holds both ways: no event ever leaves with
// `errorKind: 'unknown'`, AND prod never drops the error event.
function enforceErrorKindWireContract(
  event: AgentEvent,
  ctx: { turnId: string; provider: string | undefined },
): void {
  if (!('errorKind' in event) || event.errorKind !== 'unknown') return;

  if (process.env.NODE_ENV === 'test') {
    // Loud failure in test/CI so a violating edit cannot merge.
    invariant(
      false,
      "agentEventDispatcher: emitted error event must omit `errorKind` when the kind is 'unknown' (I2 wire contract)",
    );
  }

  // Production / dev: normalize so the event is wire-correct, then report.
  // Reporting is wrapped in try/catch so logging can never block the dispatch
  // path (errorReporter.ts never-block-the-capture precedent).
  delete (event as { errorKind?: unknown }).errorKind;
  try {
    log.warn(
      {
        turnId: ctx.turnId,
        ...(ctx.provider ? { provider: ctx.provider } : {}),
        layer: 'dispatcher',
      },
      "I2 wire-contract violation normalized: stripped errorKind:'unknown' from emitted error event (the error still surfaces)",
    );
  } catch {
    // Observability only — never block the error-dispatch path.
  }
}

/**
 * Test-only handle on the I2 emit-boundary fence. Lets the dispatcher tests
 * exercise both gated branches (test-env throw, prod-env normalize+report)
 * against a planted `errorKind: 'unknown'` event, which the normal
 * construction spread can never produce.
 */
export const __enforceErrorKindWireContractForTests = enforceErrorKindWireContract;

function shouldAssertHumanizerOwnedOverrideViolation(): boolean {
  const nodeEnv = process.env.NODE_ENV;
  return nodeEnv === 'development' || nodeEnv === 'test';
}

function enforceHumanizerOwnedOverrideContract(
  errorKind: AgentErrorKind,
  hasHumanizedOverride: boolean,
  opts: DispatchAgentErrorEventOptions | undefined,
  ctx: { turnId: string; provider: string | undefined },
): void {
  if (!hasHumanizedOverride) return;
  if (!HUMANIZER_OWNED_KIND_SET.has(errorKind)) return;
  if (opts?.intentionalCopyOverrideForKind === errorKind) return;

  log.warn(
    {
      turnId: ctx.turnId,
      errorKind,
      provider: ctx.provider,
      intentionalCopyOverrideForKind: opts?.intentionalCopyOverrideForKind,
      humanizerOwnedKinds: HUMANIZER_OWNED_KINDS,
      layer: 'dispatcher',
    },
    'humanizedOverride used for a humanizer-owned kind without an explicit intentional marker',
  );

  if (shouldAssertHumanizerOwnedOverrideViolation()) {
    invariant(
      false,
      `agentEventDispatcher: humanizedOverride for ${errorKind} requires intentionalCopyOverrideForKind:${errorKind} (humanizer-owned kind)`,
    );
  }
}

// ---------------------------------------------------------------------------
// Humanizer failure observer — wired once at module init.
//
// `humanizeAgentError` lives in `@rebel/shared`, which is platform-agnostic and
// cannot import `@core/logger` or `@core/tracking` directly. Stage 1 exposes a
// DI hook (`setHumanizerFailureObserver`) so the dispatcher — the primary
// caller — can forward humanizer-internal failures to Pino + tracker.
//
// Wiring happens at module load (import is the first touch-point of the
// dispatcher from both `src/main/index.ts` and `cloud-service/src/bootstrap.ts`),
// guarded so a second import cannot re-wire. The dispatcher also has its own
// try/catch around `humanizeAgentError` to guarantee the error event still
// fires even if the humanizer ever propagates a throw; this observer is the
// observability path for *humanizer-internal* failures specifically.
//
// See: docs/plans/260421_classification_driven_error_humanizer.md — Stage 2.
let _humanizerObserverWired = false;

export function wireHumanizerFailureObserver(): void {
  if (_humanizerObserverWired) return;
  _humanizerObserverWired = true;
  setHumanizerFailureObserver((report: HumanizerFailureReport) => {
    const { err, inputKind, errorKind } = report;
    log.warn(
      { err, inputKind, errorKind, layer: 'humanizer' },
      'humanizeAgentError threw; safe fallback returned',
    );
    try {
      getTracker().track('ai_error_humanization_failed', {
        layer: 'humanizer',
        inputKind,
        ...(errorKind ? { errorKind } : {}),
      });
    } catch (trackingError) {
      log.debug(
        { err: trackingError, layer: 'humanizer' },
        'tracker.track failed for ai_error_humanization_failed',
      );
    }
  });
}

wireHumanizerFailureObserver();

/**
 * Reset the module-level observer-wired guard. Test-only helper — pair with
 * `__clearHumanizerFailureObserverForTests()` in `@rebel/shared` when the test
 * needs to verify the wiring path.
 */
export function __resetHumanizerObserverWiredFlagForTests(): void {
  _humanizerObserverWired = false;
}
import { agentTurnRegistry } from './agentTurnRegistry';
import { getTurnCheckpointManager } from '@core/services/turnCheckpointService';

import {
  sanitizeEventForMainAccumulation,
  sanitizeEventForRenderer,
} from '@shared/utils/eventSanitization';
import { assertEventHasSeq } from '@shared/utils/eventIdentity';
import { nextContentUpdatedAt } from '@shared/utils/sessionTimestamps';
import { sendSequencedAgentEventToWindow } from './agentEventBroadcast';
export { sanitizeEventForMainAccumulation, sanitizeEventForRenderer };
export { broadcastSequencedAgentEvent, sendSequencedAgentEventToWindow } from './agentEventBroadcast';

// ---------------------------------------------------------------------------
// Stage 2 of the 260508 active-work CPU/GPU rebuild — desktop-renderer-IPC-only
// `answer_phase_started` lifecycle marker (R2-3 / R2-4 / R3-arbiter-1).
//
// The dispatcher previously broadcast every `assistant_delta` to the renderer
// via `webContents.send('agent:event', …)`. The renderer never consumed the
// payload — it only used the *first* delta of each turn as a barrier signal
// to clear its transient thinking buffer. Stage 2 collapses this into a
// single per-turn lifecycle marker emitted via `dispatchRendererOnlyAgentEvent`,
// while CLI listeners and cloud SSE subscribers continue to receive deltas
// verbatim (they do consume the payload).
//
// `answerPhaseStartedTurnIds` tracks per-turn idempotency for the marker.
// Cleared on terminal events (result/error), turn_superseded, the turn-end
// listener path AND on the registry's `cleanupTurn` / `cleanupForRetry` /
// `releaseActiveSession` paths — so retries and recovery loops can re-emit
// the marker on the next answer phase (F16 invariant).
//
// SCOPE / WINDOW MODEL: the set is module-scoped (process-singleton).
// Rebel's desktop main process owns exactly one user-facing BrowserWindow
// (see `coreStartup.ts`). The marker fan-out targets the `win` argument
// passed to the dispatcher, so even if a future change introduced a second
// window the sentinel would still correctly idempotently fire one marker
// per turn — but BOTH windows would receive it. If multi-window with
// per-window turn isolation ever becomes a requirement, the sentinel needs
// to be re-keyed by `(turnId, windowId)`. Stale-delta race: a late
// `assistant_delta` from attempt N can re-stamp the sentinel after the
// recovery pipeline's `clearAnswerPhaseStartedSentinel` call cleared it
// on attempt N+1; because `clearThinkingBuffer` is idempotent (R2-5
// fallback) the user-visible impact is benign — at worst the marker fires
// one extra time across a retry boundary.
// ---------------------------------------------------------------------------
const answerPhaseStartedTurnIds = new Set<string>();

/**
 * Lifecycle event types that are emitted to the desktop renderer ONLY and
 * bypass the listener/subscriber fan-out and the main accumulator. The
 * F16 permanent counter / invariant test uses this list as the exemption set
 * for the "no dispatch without a renderer subscriber" guard (R2-8).
 *
 * Plan reference: docs/plans/260508_active_work_cpu_gpu_architectural_rebuild.md Stage 2 (R2-8).
 */
export const RENDERER_ONLY_LIFECYCLE_EVENTS = ['answer_phase_started'] as const;

/**
 * Event types that legitimately have NO renderer subscriber post-Stage-2
 * (the renderer doesn't react to them) but are still fanned out to CLI /
 * cloud SSE / mobile WS. The F16 counter must NOT flag these as "send and
 * forget" anomalies (R2-8 exemption list).
 *
 * Plan reference: docs/plans/260508_active_work_cpu_gpu_architectural_rebuild.md Stage 2 (R2-8).
 */
export const KNOWN_NO_RENDERER_SUBSCRIBER = ['assistant_delta', 'thinking_delta'] as const;

type RendererOnlyLifecycleEventType = typeof RENDERER_ONLY_LIFECYCLE_EVENTS[number];

/**
 * Lifecycle event payloads that bypass the listener/subscriber fan-out and the
 * main accumulator. Surfaces via `dispatchRendererOnlyAgentEvent`. Add new
 * renderer-only markers by extending `RENDERER_ONLY_LIFECYCLE_EVENTS`.
 */
type RendererOnlyLifecycleEvent = Extract<AgentEvent, { type: RendererOnlyLifecycleEventType }>;

// ---------------------------------------------------------------------------
// F16 permanent regression guard — Stage 2 close (260508 plan).
//
// Per-event-type runtime counters that mirror the compile-time type-wall
// (`Exclude<AgentEvent, { type: 'error' | RendererOnlyLifecycleEventType }>`)
// at runtime. Together they form a defense-in-depth against the
// "send-and-forget channel class" regression the plan calls out:
//
//   * Type-wall: prevents NEW callers from dispatching error / renderer-only
//     lifecycle events through the wrong export.
//   * Counter: detects when an EXISTING dispatch path goes orphan at runtime
//     because a future change removes the last consumer of an event type
//     without removing the dispatch.
//
// `getDeadEventTypes()` applies the R2-8 exemption set
// (`RENDERER_ONLY_LIFECYCLE_EVENTS` ∪ `KNOWN_NO_RENDERER_SUBSCRIBER`) so the
// intentionally-asymmetric paths (`answer_phase_started`, `assistant_delta`,
// `thinking_delta`) can't trigger false positives.
//
// Counters are gated on `REBEL_PERF_MODE=1` at module load and toggleable via
// `setDispatcherCountersEnabledForTests` so unit tests can observe behavior
// without polluting the production hot path.
// ---------------------------------------------------------------------------
let dispatcherCountersEnabled: boolean = (() => {
  try {
    if (typeof process !== 'undefined' && process.env?.REBEL_PERF_MODE === '1') {
      return true;
    }
  } catch {
    /* process may be undefined in browser-like contexts */
  }
  return false;
})();

const eventsDispatchedTotal: Record<string, number> = Object.create(null);
const eventsWithActiveSubscriberTotal: Record<string, number> = Object.create(null);

const F16_EXEMPTION_SET: ReadonlySet<string> = new Set<string>([
  ...RENDERER_ONLY_LIFECYCLE_EVENTS,
  ...KNOWN_NO_RENDERER_SUBSCRIBER,
]);

const recordDispatcherCounters = (
  eventType: string,
  hadActiveSubscriber: boolean,
): void => {
  if (!dispatcherCountersEnabled) return;
  eventsDispatchedTotal[eventType] = (eventsDispatchedTotal[eventType] ?? 0) + 1;
  if (hadActiveSubscriber) {
    eventsWithActiveSubscriberTotal[eventType] =
      (eventsWithActiveSubscriberTotal[eventType] ?? 0) + 1;
  }
};

/**
 * F16 dispatcher counter snapshot. Per-event-type breakdown:
 *   * `eventsDispatchedTotal[type]` — number of events past `stampSeq` that
 *     went through `dispatchAgentEventInternal` for this type.
 *   * `eventsWithActiveSubscriberTotal[type]` — events for which AT LEAST ONE
 *     observable consumer existed at dispatch time (alive `EventWindow`,
 *     single-slot CLI listener, or non-empty cloud-SSE/mobile-WS subscriber set).
 *
 * Counters increment only when `dispatcherCountersEnabled` is true (driven
 * by `REBEL_PERF_MODE=1` at module load, or `setDispatcherCountersEnabledForTests`
 * in unit tests). Returns defensive copies so callers can't mutate module state.
 */
export interface DispatcherCounters {
  eventsDispatchedTotal: Record<string, number>;
  eventsWithActiveSubscriberTotal: Record<string, number>;
}

export const getDispatcherCounters = (): DispatcherCounters => ({
  eventsDispatchedTotal: { ...eventsDispatchedTotal },
  eventsWithActiveSubscriberTotal: { ...eventsWithActiveSubscriberTotal },
});

export const resetDispatcherCounters = (): void => {
  for (const k of Object.keys(eventsDispatchedTotal)) {
    delete eventsDispatchedTotal[k];
  }
  for (const k of Object.keys(eventsWithActiveSubscriberTotal)) {
    delete eventsWithActiveSubscriberTotal[k];
  }
  // Reset the periodic logger's sustained-set tracking too — otherwise a
  // previously-seen dead event type that re-occurs after reset would falsely
  // register as "sustained" on the next tick (warn instead of info), breaking
  // the contract that "after reset, all counter-derived state is fresh."
  f16PreviousDeadTypes = new Set();
};

export const setDispatcherCountersEnabledForTests = (enabled: boolean): void => {
  dispatcherCountersEnabled = enabled;
};

/**
 * F16 dead-channel detector. Returns event types that have been dispatched
 * but never had an observable consumer across the counter window — i.e.,
 * candidates for "send-and-forget" regression. Applies the R2-8 exemption
 * set so `answer_phase_started` (renderer-only by design), `assistant_delta`,
 * and `thinking_delta` (intentionally CLI/cloud-only post-Stage-2) cannot
 * register as dead. A non-empty result is the hand-off to investigation:
 * either the dispatch should be removed, or a missing consumer wired up.
 *
 * Intended consumers: the in-process F16 periodic logger (started below)
 * AND ad-hoc monitoring / CI assertions. The plan calls for "ratio > 0% for
 * >1 minute" as the warning trigger.
 */
export const getDeadEventTypes = (): string[] => {
  const dead: string[] = [];
  for (const type of Object.keys(eventsDispatchedTotal)) {
    if (F16_EXEMPTION_SET.has(type)) continue;
    const dispatched = eventsDispatchedTotal[type] ?? 0;
    const withSub = eventsWithActiveSubscriberTotal[type] ?? 0;
    if (dispatched > 0 && withSub === 0) dead.push(type);
  }
  return dead;
};

// ---------------------------------------------------------------------------
// F16 periodic logger — closes the plan's "log once per minute under
// REBEL_PERF_MODE; warning when ratio > 0% for >1 minute" contract.
//
// Tracks the dead-event set across consecutive 60s ticks. A warning fires
// only after the SAME event type stays dead for ≥2 ticks (≈≥1 minute
// continuous), which is the plan's "for >1 minute" guard. Single-tick blips
// still emit an info-level log so monitoring has the raw signal, but only
// sustained violations escalate to warn.
//
// Auto-starts on module load when `REBEL_PERF_MODE=1` (the same gate that
// enables counter increments). Test environments don't set the env var, so
// the interval never starts there. `startF16PeriodicLogger` /
// `stopF16PeriodicLogger` give explicit start/stop control for explicit
// callers (tests verifying the logger path, future bootstrap reorganisation).
// ---------------------------------------------------------------------------
const F16_PERIODIC_INTERVAL_MS = 60_000;

let f16PeriodicLoggerHandle: ReturnType<typeof setInterval> | null = null;
let f16PreviousDeadTypes: ReadonlySet<string> = new Set();

export function startF16PeriodicLogger(intervalMs: number = F16_PERIODIC_INTERVAL_MS): void {
  if (f16PeriodicLoggerHandle !== null) return;
  f16PeriodicLoggerHandle = setInterval(() => {
    const dead = getDeadEventTypes();
    if (dead.length === 0) {
      f16PreviousDeadTypes = new Set();
      return;
    }
    const sustained = dead.filter((t) => f16PreviousDeadTypes.has(t));
    if (sustained.length > 0) {
      log.warn(
        {
          sustainedDeadEventTypes: sustained,
          deadEventTypes: dead,
          counters: getDispatcherCounters(),
          intervalMs,
          layer: 'dispatcher',
          regressionGuard: 'F16',
        },
        'F16: events dispatched without any consumer for >1 minute (send-and-forget regression candidate)',
      );
    } else {
      log.info(
        {
          deadEventTypes: dead,
          counters: getDispatcherCounters(),
          intervalMs,
          layer: 'dispatcher',
          regressionGuard: 'F16',
        },
        'F16: events dispatched without consumer in last interval (single-tick observation)',
      );
    }
    f16PreviousDeadTypes = new Set(dead);
  }, intervalMs);
  // Allow the process to exit even if the interval is alive — perf-mode logging
  // should never pin the event loop. `setInterval` returns a NodeJS.Timeout in
  // node and a number in browsers; only the node variant has `unref`.
  const handle = f16PeriodicLoggerHandle as { unref?: () => void } | null;
  if (handle && typeof handle.unref === 'function') {
    handle.unref();
  }
}

export function stopF16PeriodicLogger(): void {
  if (f16PeriodicLoggerHandle !== null) {
    clearInterval(f16PeriodicLoggerHandle);
    f16PeriodicLoggerHandle = null;
  }
  f16PreviousDeadTypes = new Set();
}

if (dispatcherCountersEnabled) {
  startF16PeriodicLogger();
}

/**
 * Clear the `answer_phase_started` sentinel for a turn. Exported so the
 * recovery pipeline (long-context fallback / recovery model) can re-arm the
 * marker before retrying — the next `assistant_delta` of the recovered turn
 * must re-emit the renderer barrier (R2-5 fallback covers any case where
 * the renderer re-mounts and misses both the marker AND the recovery
 * sentinel-clear).
 */
export function clearAnswerPhaseStartedSentinel(turnId: string): boolean {
  return answerPhaseStartedTurnIds.delete(turnId);
}

/**
 * Test-only helper for verifying the sentinel set is empty across a clean run.
 */
export function __peekAnswerPhaseStartedSentinelForTests(): ReadonlySet<string> {
  return new Set(answerPhaseStartedTurnIds);
}

agentTurnRegistry.subscribeTurnCleanup((turnId) => {
  answerPhaseStartedTurnIds.delete(turnId);
});

/**
 * Options controlling error-event dispatch beyond the automatic classification
 * + humanization pipeline.
 *
 * ## Naming conventions
 *
 * **`*Override`** — authoritatively *replaces* a value the dispatcher would
 * otherwise compute. Use when the caller already knows the correct answer and
 * the classifier/humanizer should step aside. Only set if you intend to
 * suppress the dispatcher's own derivation for that field.
 *   - `humanizedOverride` — when provided as a non-empty, non-whitespace
 *     string, bespoke user-facing copy bypasses `humanizeAgentError`.
 *     Empty, whitespace-only, or `undefined` values fall through to the
 *     humanizer so a caller can't accidentally emit a blank banner.
 *   - `intentionalCopyOverrideForKind` — explicit marker required when
 *     overriding copy for a humanizer-owned kind (currently `rate_limit`).
 *     Without this marker the dispatcher logs a structured warning and
 *     asserts in dev/test.
 *   - `errorKindOverride` — pins the classification kind, skipping
 *     `deriveErrorKind`.
 *   - `providerOverride` — authoritatively sets the provider, replacing any
 *     value extracted from the raw error (also fills it in when missing).
 *   - `rateLimitMetaOverride` — caller-known Retry-After data; only used when
 *     the emitted event is a rate-limit error (pair with
 *     `errorKindOverride: 'rate_limit'`, ignored otherwise).
 *   - `timestampOverride` — preserves a pre-captured error time instead of
 *     stamping `Date.now()` at dispatch.
 *
 * **`*Diagnostic`** — structured metadata attached to the emitted event for
 * user-facing UI branches and telemetry. These are additive, not
 * substitutive: they don't change the primary error copy, they enrich it.
 *   - `timeoutDiagnostic` — timeout phase + hint for the Retry/Slow surface.
 *   - `watchdogDiagnostic` — stall pattern + duration for watchdog auto-aborts.
 *
 * **Unsuffixed booleans** — `isTransient` and `markActionable` are simple
 * boolean knobs on dispatcher behaviour (event shape + registry bookkeeping),
 * not overrides of computed values.
 *
 * See docs/plans/260420_inline_error_dispatch_migration.md for the rationale
 * behind centralising these opts through `dispatchAgentErrorEvent`.
 */
type DispatchAgentErrorEventOptions = {
  humanizedOverride?: string;
  intentionalCopyOverrideForKind?: AgentErrorKind;
  isTransient?: boolean;
  errorKindOverride?: AgentErrorKind;
  providerOverride?: string;
  settingsContext?: ClassifyErrorUxInput['settingsContext'];
  markActionable?: boolean;
  timeoutDiagnostic?: Extract<AgentEvent, { type: 'error' }>['timeoutDiagnostic'];
  watchdogDiagnostic?: Extract<AgentEvent, { type: 'error' }>['watchdogDiagnostic'];
  rateLimitMetaOverride?: Extract<AgentEvent, { type: 'error' }>['rateLimitMeta'];
  /**
   * Route-aware caller supplies this when the failing turn was rejected by
   * the managed-tier allowlist. The dispatcher only forwards this onto
   * `managedModelMeta` for `managed_model_not_allowed`-classified errors;
   * it is dropped for other error kinds. See
   * docs/plans/260513a_subscription_consumer_audit_gaps.md § G3.
   */
  managedModelMetaOverride?: Extract<AgentEvent, { type: 'error' }>['managedModelMeta'];
  timestampOverride?: number;
  /** Route credential source for telemetry and scope-aware copy branches. */
  credentialSource?: ProviderCredentialSource;
  /** Optional limit attribution override when the caller has route-level certainty. */
  limitScopeOverride?: Extract<AgentEvent, { type: 'error' }>['limitScope'];
  /**
   * Route-aware caller supplies this when the failing turn used the
   * Mindstone-managed subscription credential. The dispatcher only forwards
   * this onto `billingMeta.managedSubscription` for billing-classified errors;
   * it is dropped for other error kinds. See
   * docs/plans/260513a_subscription_consumer_audit_gaps.md § E.
   */
  billingManagedSubscription?: { tier: string; resetsAt?: string };
  recoveryOwner?: RecoveryOwner;
  /**
   * Stage 5b (multi-provider failover observability): the credential source that
   * was rate-limited when all failover candidates were exhausted.
   * Only emitted on the terminal exhaustion error — transparent hops do not
   * dispatch an error event and do not populate this field.
   */
  rateLimitProvider?: string;
  /**
   * Stage 5b: why failover stopped — 'all-providers-rate-limited' (all usable
   * credential candidates have 429'd) or 'partial-output' (the turn had already
   * produced output, making a restart unsafe).
   */
  failoverReason?: 'all-providers-rate-limited' | 'partial-output' | 'all-providers-rate-limited-after-partial';
};

type ErrorLimitScope = Extract<AgentEvent, { type: 'error' }>['limitScope'];
type ErrorHeadlineClass = Extract<AgentEvent, { type: 'error' }>['headlineClass'];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

// getErrorMessage imported from @core/utils/getErrorMessage.ts

function getRawErrorMessage(error: unknown): string {
  if (isRecord(error) && typeof error.__rawMessage === 'string') {
    return error.__rawMessage;
  }
  return '';
}

function getErrorProvider(error: unknown): string | undefined {
  if (isRecord(error) && typeof error.provider === 'string') {
    return error.provider;
  }
  return undefined;
}

function getUnsupportedModelId(error: unknown): string | undefined {
  if (!isRecord(error)) return undefined;
  if (typeof error.wireModel === 'string') return error.wireModel;
  if (typeof error.wireModelId === 'string') return error.wireModelId;
  return undefined;
}

// FOX-3494: structured route detail a ConnectionNotConfiguredError can carry so
// classifyErrorUx can lead with a model-aware "switch to a GPT model" recovery
// (and repair the correct settings slot) without changing the error class.
function getRouteInvalidReason(error: unknown): string | undefined {
  if (isRecord(error) && typeof error.invalidReason === 'string') return error.invalidReason;
  return undefined;
}

const CHIEF_OF_STAFF_REASONS = ['reconnecting', 'unreadable', 'missing-after-setup'] as const;
type ChiefOfStaffReason = (typeof CHIEF_OF_STAFF_REASONS)[number];

// 260622 Stage 3: the `chief-of-staff-unavailable` cause, carried on the routed
// error by the turn-admission gate so `classifyErrorUx` can distinguish a dead
// cloud mount (`reconnecting`) from an unreadable file (`unreadable`) from a
// genuinely-absent file after onboarding (`missing-after-setup`).
function getChiefOfStaffReason(error: unknown): ChiefOfStaffReason | undefined {
  if (
    isRecord(error) &&
    typeof error.__chiefOfStaffReason === 'string' &&
    (CHIEF_OF_STAFF_REASONS as readonly string[]).includes(error.__chiefOfStaffReason)
  ) {
    return error.__chiefOfStaffReason as ChiefOfStaffReason;
  }
  return undefined;
}

const ROUTE_ROLES = ['execution', 'planning', 'bts', 'subagent'] as const;
type RouteRoleForUx = (typeof ROUTE_ROLES)[number];

function getFailedRouteRole(error: unknown): RouteRoleForUx | undefined {
  if (
    isRecord(error) &&
    typeof error.failedRole === 'string' &&
    (ROUTE_ROLES as readonly string[]).includes(error.failedRole)
  ) {
    return error.failedRole as RouteRoleForUx;
  }
  return undefined;
}

function extractUpstreamProvider(error: unknown, rawMessage: string): string | undefined {
  if (isRecord(error) && typeof error.upstreamProvider === 'string') {
    return error.upstreamProvider;
  }

  const trimmedMessage = rawMessage.trim();
  if (!trimmedMessage) {
    return undefined;
  }

  const jsonStartIndex = trimmedMessage.indexOf('{');
  const jsonCandidate = jsonStartIndex >= 0 ? trimmedMessage.slice(jsonStartIndex) : trimmedMessage;

  try {
    const parsed = JSON.parse(jsonCandidate);
    if (!isRecord(parsed) || !isRecord(parsed.error) || !isRecord(parsed.error.metadata)) {
      return undefined;
    }

    return typeof parsed.error.metadata.provider_name === 'string'
      ? parsed.error.metadata.provider_name
      : undefined;
  } catch {
    return undefined;
  }
}

function extractStatusFromMessage(message: string): number | undefined {
  const match = message.match(
    /^\s*(?:API Error:\s*|HTTP\s+|.*proxy error\s*\()?(?<status>\d{3})(?:\)|\b)/i,
  );
  const status = match?.groups?.status;
  if (!status) return undefined;

  const parsed = Number(status);
  return Number.isInteger(parsed) ? parsed : undefined;
}

function extractStatusCode(rawError: unknown, message: string): number | undefined {
  if (isRecord(rawError) && typeof rawError.status === 'number') {
    return rawError.status;
  }

  return extractStatusFromMessage(message);
}

function stripLeadingStatusPrefix(message: string, status: number): string {
  return message.replace(new RegExp(`^\\s*${status}\\s+(?=[{\\[])`), '');
}

function extractProviderFromMessage(message: string): string | undefined {
  const lower = message.toLowerCase();

  if (lower.includes('openrouter')) return 'OpenRouter';
  if (lower.includes('anthropic') || lower.includes('claude')) return 'Anthropic';
  if (lower.includes('openai') || lower.includes('gpt') || lower.includes('codex')) return 'OpenAI';
  if (lower.includes('google') || lower.includes('gemini')) return 'Google';
  if (lower.includes('cerebras')) return 'Cerebras';
  if (lower.includes('together')) return 'Together';

  return undefined;
}

function extractRoleResolutionFailure(rawError: unknown, rawMessage: string): ReturnType<typeof parseRoleResolutionFailureFromRawError> {
  if (rawError instanceof ModelError && isRoleResolutionFailure(rawError.details?.roleResolutionFailure)) {
    return rawError.details.roleResolutionFailure;
  }
  return parseRoleResolutionFailureFromRawError(rawMessage);
}

function isAuthMessage(message: string): boolean {
  const lower = message.toLowerCase();
  return (
    lower.includes('invalid x-api-key') ||
    lower.includes('authentication_error') ||
    lower.includes('unauthorized') ||
    lower.includes('invalid api key') ||
    lower.includes('api key') ||
    lower.includes('401')
  );
}

function deriveHeadlineClass(input: {
  errorKind: AgentErrorKind;
  limitScope: ErrorLimitScope;
}): ErrorHeadlineClass {
  const { errorKind, limitScope } = input;

  if (errorKind === 'auth' || errorKind === 'connection-not-configured') {
    return 'auth';
  }
  if (errorKind === 'managed_model_not_allowed' || errorKind === 'unsupported_model') {
    return 'subscription_entitlement';
  }
  if (limitScope === 'plan') {
    return 'subscription_entitlement';
  }
  if (errorKind === 'rate_limit') {
    return 'rate_limit';
  }
  if (errorKind === 'billing') {
    return 'billing_quota';
  }
  return 'other';
}

function deriveErrorKind(
  rawError: unknown,
  message: string,
  provider: string | undefined,
  override?: AgentErrorKind,
): AgentErrorKind {
  if (override) {
    return override;
  }

  const catalogKind = getErrorKind(rawError);
  if (catalogKind !== 'unknown') {
    return catalogKind;
  }

  const status = extractStatusCode(rawError, message);
  if (status != null) {
    const classifiedKind = classifyHttpError(
      status,
      stripLeadingStatusPrefix(message, status),
      provider,
    ).kind;
    // `abort` and `tool_input_too_large` are internal ModelError kinds that
    // don't exist in the renderer's AgentErrorKind union; collapse to
    // 'unknown' at this boundary. Callers that need the specific kind pass
    // `errorKindOverride` via dispatchAgentErrorEvent instead.
    if (classifiedKind === 'abort' || classifiedKind === 'tool_input_too_large') {
      return 'unknown';
    }
    return classifiedKind;
  }

  if (isBillingMessage(message)) return 'billing';
  if (isRateLimitMessage(message)) return 'rate_limit';
  if (isAuthMessage(message)) return 'auth';

  return 'unknown';
}

/**
 * Merge persisted session messages with accumulated turn messages,
 * deduplicating by message ID. Ensures title generation sees up-to-date
 * messages even when renderer persistence hasn't flushed yet.
 */
function mergeSessionMessages(
  persisted: AgentTurnMessage[],
  accumulated: AgentTurnMessage[],
): AgentTurnMessage[] {
  if (accumulated.length === 0) return persisted;
  if (persisted.length === 0) return accumulated;
  const seen = new Set(persisted.map((m) => m.id));
  return [...persisted, ...accumulated.filter((m) => !seen.has(m.id))];
}

/**
 * Build grounded activity lines for the activity-summary generator from a turn's
 * accumulated events. Each line describes exactly one real tool call (name +
 * trimmed detail) so the model can only reference work that actually happened
 * (no-fabrication constraint, Stage 2b eval). Synthetic and pre-turn-context
 * tool events are excluded — they are host-seeded, not work the agent did.
 * @internal Exported for unit tests (activity-summary grounding helpers).
 */
export function deriveActivityLinesForTurn(events: readonly AgentEvent[]): string[] {
  const lines: string[] = [];
  const seen = new Set<string>();
  for (const event of events) {
    if (event.type !== 'tool' || event.stage !== 'start') continue;
    if (event._origin === 'synthetic-plan-seed' || event._origin === 'pre-turn-context') continue;
    const detail = (event.detail ?? '').trim().replace(/\s+/g, ' ');
    const line = detail ? `${event.toolName}: ${detail}` : event.toolName;
    if (seen.has(line)) continue;
    seen.add(line);
    lines.push(line);
  }
  return lines;
}

/**
 * Extract the final answer text from the turn's accumulated messages, if any.
 * @internal Exported for unit tests (activity-summary grounding helpers).
 */
export function deriveAnswerSnippetForTurn(messages: AgentTurnMessage[], turnId: string): string | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message.turnId !== turnId) continue;
    if ((message.role === 'result' || message.role === 'assistant') && message.text.trim()) {
      return message.text.trim();
    }
  }
  return undefined;
}

/**
 * Best-effort turn duration (ms) for activity-summary gating only: earliest
 * accumulated event timestamp for the turn → the result timestamp. Returns
 * undefined when no earlier timestamp is available (gating then relies on the
 * tool/file signals instead).
 * @internal Exported for unit tests (activity-summary grounding helpers).
 */
export function deriveTurnDurationMs(events: readonly AgentEvent[], resultTimestamp: number): number | undefined {
  let earliest = Number.POSITIVE_INFINITY;
  for (const event of events) {
    const ts = (event as { timestamp?: number }).timestamp;
    if (typeof ts === 'number' && ts < earliest) earliest = ts;
  }
  if (!Number.isFinite(earliest) || typeof resultTimestamp !== 'number') return undefined;
  const duration = resultTimestamp - earliest;
  return duration > 0 ? duration : undefined;
}

/**
 * Extract the raw user request text from a (possibly XML-wrapped) turn prompt.
 * @internal Exported for unit tests (activity-summary grounding helpers).
 */
export function extractUserRequestText(turnPrompt: string | undefined): string | undefined {
  if (!turnPrompt) return undefined;
  const match = turnPrompt.match(/<user-request>\s*([\s\S]*?)\s*<\/user-request>/);
  const text = (match ? match[1] : turnPrompt).trim();
  return text || undefined;
}

const TURN_PROGRESS_EVENT_TYPES: ReadonlySet<AgentEvent['type']> = new Set<AgentEvent['type']>([
  'assistant',
  'assistant_delta',
  'thinking_delta',
  'tool',
  'result',
  'user_question',
  'user_question_answered',
]);

function shouldTrackTurnProgress(event: AgentEvent): boolean {
  return TURN_PROGRESS_EVENT_TYPES.has(event.type);
}

/**
 * Dispatch an agent event to the renderer and/or registered listeners.
 * Accumulates events for all turns (needed for context overflow recovery).
 * Memory updates are triggered separately only for renderer turns.
 */
function dispatchAgentEventInternal(
  win: EventWindow | null,
  turnId: string,
  event: AgentEvent,
): void {
  // Look up the session ID for this turn (used for routing events to non-active sessions)
  const sessionId = agentTurnRegistry.getRendererSession(turnId);

  if (shouldTrackTurnProgress(event)) {
    agentTurnRegistry.markTurnProgress(turnId);
  }

  // Streaming deltas are transient UI data — dispatcher contract per the
  // 260508 plan Stage 2 (R3-arbiter-1):
  //   * Desktop renderer: payload IS NOT broadcast over `agent:event`. The
  //     renderer never consumed the bytes (the answer-phase Markdown card
  //     reconciliates from rolled-up `assistant` events). Instead, on the
  //     FIRST delta of each turn we emit a single per-turn
  //     `answer_phase_started` lifecycle marker via
  //     `dispatchRendererOnlyAgentEvent` so the renderer can clear its
  //     transient thinking buffer once.
  //   * CLI listeners (single-slot `getEventListener`) still receive the
  //     full stamped delta — TTFT profiling and chunk-by-chunk
  //     `headlessRunner` consumers depend on it.
  //   * Cloud SSE / mobile WS subscribers (multi-subscriber
  //     `notifyTurnEventSubscribers`) still receive the full stamped
  //     delta — that's how their UI streams text.
  if (event.type === 'assistant_delta') {
    const accumulator = agentTurnRegistry.getOrCreateAccumulator(turnId, sessionId);
    const stampedDeltaEvent = accumulator.stampSeq(event, sessionId);
    assertEventHasSeq(stampedDeltaEvent, 'dispatcher.assistantDelta.beforeIPC');

    // Stage 2 (DI-1.5 #3): the sentinel set is desktop-only state. Cloud /
    // headless dispatch passes `win === null`; `dispatchRendererOnlyAgentEvent`
    // would no-op for those callers anyway, but populating the set there
    // would silently leak desktop barrier-marker bookkeeping into surfaces
    // that never consume it (and would never clear it on terminal cleanup
    // because the registry-cleanup path runs in the same process). Gate the
    // stamping on actual desktop renderer presence.
    if (win && !win.isDestroyed() && !answerPhaseStartedTurnIds.has(turnId)) {
      answerPhaseStartedTurnIds.add(turnId);
      const marker: Extract<AgentEvent, { type: 'answer_phase_started' }> = {
        type: 'answer_phase_started',
        timestamp: stampedDeltaEvent.timestamp,
      };
      dispatchRendererOnlyAgentEvent(win, turnId, marker, sessionId);
    }

    const listener = agentTurnRegistry.getEventListener(turnId);
    const subscribers = agentTurnRegistry.getEventSubscribers(turnId);
    const hadActiveSubscriber =
      !!listener || (subscribers ? subscribers.size > 0 : false);
    if (listener) {
      try {
        listener(stampedDeltaEvent);
      } catch (error) {
        log.error(
          { err: error, turnId, eventType: event.type },
          'Event listener failed for assistant_delta'
        );
      }
    }
    notifyTurnEventSubscribers(turnId, stampedDeltaEvent);
    recordDispatcherCounters(event.type, hadActiveSubscriber);
    return;
  }

  // Always accumulate events for all turns (needed for context overflow recovery).
  // Previously only accumulated for renderer turns, but background services
  // need accumulated messages to generate compaction summaries.
  //
  // IMPORTANT: We sanitize events before accumulating in the main process to prevent
  // OOM from large tool outputs and persisted inline image bytes. Renderer IPC uses
  // its own sanitizer below so webContents.send never carries image bytes that have
  // corresponding image refs.
  //
  // Lazy accumulation: events are pushed O(1) into the accumulator. The full
  // ConversationStateShape is derived only when a consumer calls getConversationShape()
  // (title generation on result events, context overflow recovery, etc.).
  const accumulator = agentTurnRegistry.getOrCreateAccumulator(turnId, sessionId);
  const stampedFullEvent = accumulator.stampSeq(event, sessionId);
  if (stampedFullEvent.type !== 'thinking_delta') {
    const sanitizedEvent = sanitizeEventForMainAccumulation(stampedFullEvent);
    accumulator.appendEvent(sanitizedEvent, sessionId);
  }
  assertEventHasSeq(stampedFullEvent, 'dispatcher.beforeIPC');

  if (win && !win.isDestroyed()) {
    const rendererEvent = sanitizeEventForRenderer(stampedFullEvent);
    if (assertEventHasSeq(rendererEvent, 'dispatcher.afterRendererSanitize')) {
      sendSequencedAgentEventToWindow(win, { turnId, event: rendererEvent, sessionId });
    }
  }

  // Stage 2 (260508): clear the `answer_phase_started` sentinel on terminal
  // events and turn_superseded so retries / supersede + restart re-emit the
  // marker on the next answer phase. The registry-cleanup callback is the
  // belt; this is the braces — covers cases where the dispatcher fires the
  // terminal event but the registry cleanup is deferred (e.g. after auto-
  // continue or when the user-question pending flag preserves accumulator
  // state).
  if (
    stampedFullEvent.type === 'result'
    || stampedFullEvent.type === 'error'
    || stampedFullEvent.type === 'turn_superseded'
  ) {
    answerPhaseStartedTurnIds.delete(turnId);
  }

  // Terminal checkpoint: on result/error, capture the accumulator's shape
  // SYNCHRONOUSLY (so we have a stable snapshot even if downstream cleanup
  // deletes the accumulator) and fire-and-forget the async write through the
  // checkpoint manager. This is the main-process safety net that guarantees
  // the final turn state reaches disk even when the renderer's debounced
  // save never flushes.
  // See: docs/plans/260426_main_process_turn_checkpointing.md § Stage 2 (Part B).
  if (stampedFullEvent.type === 'result' || stampedFullEvent.type === 'error') {
    const checkpointManager = getTurnCheckpointManager();
    if (
      checkpointManager
      && sessionId
      && !shouldSkipCheckpointing(classifySessionKind(sessionId))
    ) {
      // Stage 2 (docs/plans/260501_memory_update_session_routing_and_event_dedup.md):
      // checkpointTerminal can first-write sessions even when admission skipped
      // periodic checkpointing, so gate terminal checkpointing on the same
      // delete-eligible predicate.
      // Capture shape NOW — before any consumer/cleanup path can delete the
      // accumulator. The manager treats the captured shape as immutable input.
      const capturedShape = accumulator.getConversationShape();
      void checkpointManager
        .checkpointTerminal(turnId, sessionId, capturedShape)
        .catch((err) => {
          log.error({ err, turnId, sessionId }, 'Terminal checkpoint failed');
        });
    }
  }

  // Auto-generate title on turn completion (fire-and-forget).
  //
  // Gate on session-kind, NOT on a live window. Headless agent runs (win === null)
  // still first-write + persist their session via the terminal checkpoint above,
  // so a persistable headless conversation must get a content title too — without
  // this it would keep the 'New Agent Run' placeholder forever (the original bug;
  // see docs/plans/260529_fix-headless-agent-run-title/PLAN.md). We title exactly
  // the set we persist (shouldSkipCheckpointing) and additionally exclude
  // fixed-title kinds (hasFixedTitle — e.g. use-case discovery, which gets the
  // deterministic 'Use-case ideas' title and must never be Haiku-titled). The
  // live-window requirement is hoisted down to guard only the renderer IPC notify
  // — the cloud path (agentTurnSubmissionService) is window-agnostic for the same reason.
  if (stampedFullEvent.type === 'result' && sessionId) {
    const isE2E = process.env.REBEL_E2E_TEST_MODE === '1';
    const titleSessionKind = classifySessionKind(sessionId);
    // Skip kinds we don't persist (shouldSkipCheckpointing) AND kinds that carry
    // a fixed title (hasFixedTitle — e.g. use-case discovery). The hasFixedTitle
    // guard is what prevents a Haiku call on those kinds *regardless* of the
    // fire-and-forget checkpoint race: if the terminal checkpoint hasn't landed
    // when we read the session, the title would default to the placeholder and
    // (without this guard) look eligible — firing the model on private content.
    if (!isE2E && !shouldSkipCheckpointing(titleSessionKind) && !hasFixedTitle(titleSessionKind)) {
      const capturedSessionId = sessionId;
      const accumulatedMessages = accumulator.getConversationShape().messages;
      const capturedTurnPrompt = agentTurnRegistry.getTurnPrompt(turnId);
      fireAndForget((async () => {
        try {
          const { getIncrementalSessionStore } = await import('./incrementalSessionStore');
          const { processAutoTitle, isDefaultOrFallbackTitle } = await import('./conversationTitleService');
          const { getSettings } = await import('./settingsStore');
          const store = getIncrementalSessionStore();
          const persistedSession = await store.getSession(capturedSessionId);

          const persistedMessages = persistedSession?.messages ?? [];
          const mergedMessages = mergeSessionMessages(persistedMessages, accumulatedMessages);

          // Ensure user message exists for title generation.
          // The accumulator only sees events dispatched through the event dispatcher —
          // the user message is added by the renderer via IPC and may not have been
          // persisted yet when auto-title fires (renderer save is debounced ~300ms).
          // Use immutable spread — mergeSessionMessages can return array references.
          let finalMessages = mergedMessages;
          const hasUserMessage = mergedMessages.some((m) => m.role === 'user');
          if (!hasUserMessage && capturedTurnPrompt) {
            // Extract raw user text from effectivePrompt's XML wrapper if present.
            // The turn prompt stores post-context-assembly text (with <meeting-context>,
            // <relevant-files>, etc.); cloud stores the raw user prompt.
            const userRequestMatch = capturedTurnPrompt.match(
              /<user-request>\s*([\s\S]*?)\s*<\/user-request>/,
            );
            const userText = userRequestMatch ? userRequestMatch[1].trim() : capturedTurnPrompt;
            if (userText) {
              finalMessages = [
                {
                  id: `auto-title-user-${turnId}`,
                  turnId,
                  role: 'user' as const,
                  text: userText,
                  createdAt: Date.now(),
                },
                ...mergedMessages,
              ];
            }
          }

          // Build session shape with full metadata for processAutoTitle
          const sessionForTitle = {
            id: capturedSessionId,
            title: persistedSession?.title ?? 'New Agent Run',
            messages: finalMessages,
            eventsByTurn: persistedSession?.eventsByTurn ?? {},
            autoTitleGeneratedAt: persistedSession?.autoTitleGeneratedAt,
            autoTitleTurnCount: persistedSession?.autoTitleTurnCount,
          };

          const result = await processAutoTitle(sessionForTitle, {
            getSettings,
            getCurrentSession: async () => {
              const fresh = await store.getSession(capturedSessionId);
              return fresh ? { title: fresh.title, messages: fresh.messages } : null;
            },
          });
          if (!result) return;

          const generatedAt = Date.now();
          const titlePersisted = await store.updateSession(capturedSessionId, (current) => {
            if (!current) return null;
            // For initial: check title is still default/fallback.
            // For re-title: check autoTitleGeneratedAt is still set (not manually renamed).
            if (result.reason === 'initial' && !isDefaultOrFallbackTitle(current.title, current.messages)) {
              return null;
            }
            if (result.reason === 'retitle' && current.autoTitleGeneratedAt == null) {
              return null;
            }
            const monotonicUpdatedAt = Math.max(
              generatedAt,
              nextContentUpdatedAt(current.updatedAt),
            );
            return {
              ...current,
              title: result.title,
              autoTitleGeneratedAt: generatedAt,
              autoTitleTurnCount: result.turnCount,
              updatedAt: monotonicUpdatedAt,
            };
          });
          if (!titlePersisted) return;

          // Renderer notify is the ONLY window-dependent step. Headless runs
          // (win === null) skip it; the renderer reads the persisted title on
          // next load.
          if (win && !win.isDestroyed()) {
            win.webContents.send('session:title-generated', {
              sessionId: capturedSessionId,
              title: result.title,
              autoTitleGeneratedAt: generatedAt,
              autoTitleTurnCount: result.turnCount,
            });
          }
        } catch (err) {
          log.warn({ err, sessionId: capturedSessionId }, 'Auto-title generation failed');
        }
      })(), 'agentEventDispatcher.autoTitleOnResult');
    }

    // Auto-generate a one-sentence activity summary on turn completion
    // (fire-and-forget). This is the SINGLE call site (F1): the shared core
    // dispatcher covers desktop AND cloud, so the cloud submission path must NOT
    // add a second call site — `maybeGenerateActivitySummaryForTurn` is
    // idempotent (in-flight Set + persisted preflight + apply-time recheck) so
    // even if cloud traverses this path more than once per turn, the BTS model
    // is hit at most once. Generation is gated to substantial turns only and
    // failures fall back silently to the renderer's deterministic count-line.
    //
    // Capture the grounding shape SYNCHRONOUSLY here — before any consumer /
    // registry cleanup can delete the accumulator.
    if (process.env.REBEL_E2E_TEST_MODE !== '1' && !shouldSkipCheckpointing(classifySessionKind(sessionId))) {
      const capturedSessionId = sessionId;
      const capturedTurnId = turnId;
      const resultToolMetrics = stampedFullEvent.toolMetrics;
      const shape = accumulator.getConversationShape();
      const activityLines = deriveActivityLinesForTurn(shape.eventsByTurn[turnId] ?? []);
      const answerSnippet = deriveAnswerSnippetForTurn(shape.messages, turnId);
      const turnRequest = extractUserRequestText(agentTurnRegistry.getTurnPrompt(turnId));
      const durationMs = deriveTurnDurationMs(shape.eventsByTurn[turnId] ?? [], stampedFullEvent.timestamp);

      const summaryWin = win;
      fireAndForget((async () => {
        try {
          const { maybeGenerateActivitySummaryForTurn } = await import('./activitySummaryService');
          const { getIncrementalSessionStore } = await import('./incrementalSessionStore');
          const { getSettings } = await import('./settingsStore');
          const store = getIncrementalSessionStore();

          const summary = await maybeGenerateActivitySummaryForTurn(
            {
              sessionId: capturedSessionId,
              turnId: capturedTurnId,
              toolMetrics: resultToolMetrics
                ? {
                    totalToolCalls: resultToolMetrics.totalToolCalls,
                    filesCreated: resultToolMetrics.filesCreated,
                    filesEdited: resultToolMetrics.filesEdited,
                  }
                : undefined,
              durationMs,
              activityLines,
              turnRequest,
              answerSnippet,
            },
            {
              getSettings,
              getPersistedSummary: async (sid, tid) => {
                const fresh = await store.getSession(sid);
                return fresh?.activitySummaryByTurn?.[tid] ?? null;
              },
              persistSummary: async (sid, tid, sentence) => {
                const generatedAt = Date.now();
                return store.updateSession(sid, (current) => {
                  if (!current) return null;
                  // Apply-time recheck (F1): never clobber an existing summary.
                  if (current.activitySummaryByTurn?.[tid]) return null;
                  return {
                    ...current,
                    activitySummaryByTurn: {
                      ...(current.activitySummaryByTurn ?? {}),
                      [tid]: sentence,
                    },
                    updatedAt: Math.max(generatedAt, nextContentUpdatedAt(current.updatedAt)),
                  };
                });
              },
            },
          );

          // Live swap-in (mirrors `session:title-generated`): notify the renderer
          // so the collapsed disclosure label repaints from the deterministic
          // count-line to the AI sentence WITHOUT a reload. Only emitted on a
          // fresh, persisted generation (`summary` is null when gated out,
          // idempotency-skipped, or failed). Renderer notify is the ONLY
          // window-dependent step — headless runs skip it and read the persisted
          // summary on next load. Rides the cloud event channel automatically
          // (only `agent:event` is excluded — cloudEventBroadcaster).
          if (summary && summaryWin && !summaryWin.isDestroyed()) {
            summaryWin.webContents.send('session:activity-summary-generated', {
              sessionId: capturedSessionId,
              turnId: capturedTurnId,
              summary,
            });
          }
        } catch (err) {
          log.warn({ err, sessionId: capturedSessionId }, 'Activity summary generation failed');
        }
      })(), 'agentEventDispatcher.activitySummaryOnResult');
    }
  }

  const listener = agentTurnRegistry.getEventListener(turnId);
  // Snapshot subscriber set BEFORE notify — `notifyTurnEventSubscribers` does
  // not mutate the set, but `cleanupTurn` calls (e.g. on terminal events) may
  // run synchronously inside subscriber bodies. Capturing here gives F16 the
  // true at-dispatch consumer count.
  const subscribers = agentTurnRegistry.getEventSubscribers(turnId);
  const hadActiveSubscriber =
    (win !== null && !win.isDestroyed())
    || !!listener
    || (subscribers ? subscribers.size > 0 : false);
  if (listener) {
    try {
      listener(stampedFullEvent);
    } catch (error) {
      log.error(
        { err: error, turnId, eventType: stampedFullEvent.type },
        'Automation event listener failed'
      );
    }
    if (stampedFullEvent.type === 'result') {
      agentTurnRegistry.deleteEventListener(turnId);
    }
  }

  notifyTurnEventSubscribers(turnId, stampedFullEvent);
  recordDispatcherCounters(stampedFullEvent.type, hadActiveSubscriber);
}

/**
 * Public dispatcher for non-error agent events. Error events must route
 * through `dispatchAgentErrorEvent` to guarantee correct classification,
 * humanization, and analytics. Enforced at compile-time via this narrowed
 * signature — see docs/plans/260420_inline_error_dispatch_migration.md Stage 3.
 *
 * Renderer-only lifecycle events (`RENDERER_ONLY_LIFECYCLE_EVENTS`) are also
 * excluded from this public surface because they MUST flow through the
 * dedicated `dispatchRendererOnlyAgentEvent` helper to guarantee no
 * accumulator append, no listener fan-out, and no subscriber broadcast
 * (Stage 2 R2-3 / R2-4 contract). Accidental routing through this path
 * would silently violate the desktop-only contract.
 */
export const dispatchAgentEvent = (
  win: EventWindow | null,
  turnId: string,
  event: Exclude<AgentEvent, { type: 'error' | RendererOnlyLifecycleEventType }>,
): void => dispatchAgentEventInternal(win, turnId, event);

/**
 * Dispatch a desktop-renderer-IPC-only lifecycle event. Used for events whose
 * contract is "the renderer needs a barrier signal but no other consumer
 * cares" — currently `answer_phase_started` (Stage 2 of the 260508 active-work
 * CPU/GPU rebuild). NEVER hits:
 *   * the main-process accumulator (events are not seq-stamped — the marker
 *     is replay-derivable from the first non-stamped `assistant` event of
 *     each turn; see expected-desktop.json fixtures 08/09/14/15)
 *   * the single-slot CLI listener (`agentTurnRegistry.getEventListener`)
 *   * the multi-subscriber cloud-SSE/mobile-WS fan-out
 *     (`notifyTurnEventSubscribers`)
 *   * the auto-title generation pipeline
 *
 * If you find yourself wanting to add accumulation/listener side effects,
 * the event probably doesn't belong on this path — it should route through
 * `dispatchAgentEvent` instead.
 */
function dispatchRendererOnlyAgentEvent(
  win: EventWindow | null,
  turnId: string,
  event: RendererOnlyLifecycleEvent,
  sessionId: string | undefined,
): void {
  if (win && !win.isDestroyed()) {
    // eslint-disable-next-line no-restricted-syntax -- renderer-only lifecycle marker is intentionally unsequenced and never accumulated.
    win.webContents.send('agent:event', { turnId, event, sessionId });
  }
}

/**
 * Fan events out to multi-subscribers registered via
 * `agentTurnRegistry.subscribeTurnEvents()`. Each subscriber is isolated in
 * its own try/catch so a failing subscriber can't break others or the
 * single-slot listener path above.
 */
function notifyTurnEventSubscribers(turnId: string, event: AgentEvent): void {
  const subscribers = agentTurnRegistry.getEventSubscribers(turnId);
  if (!subscribers || subscribers.size === 0) return;
  for (const subscriber of subscribers) {
    try {
      subscriber(event);
    } catch (error) {
      log.warn(
        { err: error, turnId, eventType: event.type },
        'Turn event subscriber failed'
      );
    }
  }
}

export function dispatchAgentErrorEvent(
  win: EventWindow | null,
  turnId: string,
  rawError: unknown,
  opts?: DispatchAgentErrorEventOptions,
): { ok: boolean; dispatchedErrorKind?: AgentErrorKind } {
  const rawMessage = getRawErrorMessage(rawError);
  const fallbackMessage = getErrorMessage(rawError);
  const message = rawMessage || fallbackMessage || 'Unknown error';
  const provider = opts?.providerOverride ?? getErrorProvider(rawError) ?? extractProviderFromMessage(message);
  const errorKind = deriveErrorKind(rawError, message, provider, opts?.errorKindOverride);
  const limitScope = opts?.limitScopeOverride ?? (rawError instanceof ModelError ? rawError.limitScope : undefined);
  const credentialSource = opts?.credentialSource;
  const headlineClass = deriveHeadlineClass({ errorKind, limitScope });
  const humanizedOverride = opts?.humanizedOverride;
  const hasHumanizedOverride = Boolean(humanizedOverride && humanizedOverride.trim().length > 0);
  enforceHumanizerOwnedOverrideContract(errorKind, hasHumanizedOverride, opts, { turnId, provider });
  const roleResolutionFailure = extractRoleResolutionFailure(rawError, rawMessage);
  const upstreamProviderName = errorKind === 'billing'
    ? extractUpstreamProvider(rawError, rawMessage)
    : undefined;
  const billingMeta = errorKind === 'billing'
    ? {
        subtype: classifyBillingSubtype(rawMessage || message),
        ...(upstreamProviderName ? { upstreamProviderName } : {}),
        ...(rawMessage ? { rawError: rawMessage } : {}),
        ...(opts?.billingManagedSubscription
          ? { managedSubscription: opts.billingManagedSubscription }
          : {}),
      }
    : undefined;

  // Diagnostic: log full billing-error context at the dispatch boundary so we
  // can correlate banner copy with the underlying provider error body. Bounded
  // truncation prevents log blowup; never logs API keys.
  if (errorKind === 'billing') {
    log.warn(
      {
        turnId,
        provider,
        upstreamProviderName,
        billingSubtype: billingMeta?.subtype,
        message: message.slice(0, 500),
        rawMessage: rawMessage ? rawMessage.slice(0, 2000) : undefined,
        errorKindOverride: opts?.errorKindOverride,
        humanizedOverridePresent: hasHumanizedOverride,
        rawErrorStatus:
          isRecord(rawError) && typeof rawError.status === 'number' ? rawError.status : undefined,
        rawErrorKind:
          isRecord(rawError) && typeof rawError.kind === 'string' ? rawError.kind : undefined,
      },
      'dispatchAgentErrorEvent billing-error diagnostic',
    );
  }

  const rateLimitMeta = errorKind === 'rate_limit'
    ? (opts?.rateLimitMetaOverride ?? {
        rawError: message || undefined,
        retryAfterMs: extractRetryAfterMs(message),
        ...(rawError instanceof ModelError && rawError.resetAtMs ? { resetAtMs: rawError.resetAtMs } : {}),
      })
    : undefined;

  // Managed-tier allowlist rejection metadata. Populated only for
  // `managed_model_not_allowed`-classified errors, mirroring the
  // billingMeta/rateLimitMeta pattern. Prefer the caller's override (route-
  // aware paths in turnErrorRecovery.ts can supply richer context). Otherwise
  // lift the structured `details.managedModelNotAllowed` payload off any
  // `ModelError` rawError, preserving the verbatim upstream body alongside
  // the requested/allowed fields. See planning doc § G3.
  const managedModelMeta = errorKind === 'managed_model_not_allowed'
    ? (opts?.managedModelMetaOverride ?? (rawError instanceof ModelError && rawError.details?.managedModelNotAllowed
        ? { ...rawError.details.managedModelNotAllowed, ...(rawMessage ? { rawError: rawMessage } : {}) }
        : (rawMessage ? { rawError: rawMessage } : {})))
    : undefined;

  // Classification-first humanization (Stage 2). Prefer the caller-supplied
  // `humanizedOverride` (bespoke copy — e.g., `handleBillingError`'s hand-
  // written fallback string). Otherwise route through `humanizeAgentError`
  // so the discriminated-union input carries `errorKind` + metadata — this
  // eliminates the classification-blind substring cascade that previously
  // mis-copy'd an OpenAI `insufficient_quota` as "That request was too large".
  //
  // The truthy-plus-trim check (rather than `!== undefined`) is a
  // defense-in-depth guard: a caller that accidentally passes
  // `humanizedOverride: ''` or `'   '` (e.g., from `someErr.message` on an
  // upstream `new Error()`, or whitespace-only text) falls through to the
  // humanizer instead of emitting a blank error banner. `.trim()` is used
  // for the guard only — the emitted copy is still the original,
  // untrimmed string, so legitimate messages that happen to have padding
  // reach the user verbatim. All 22 migrated callers normalise empty
  // strings at their source already; this centralises the invariant so no
  // future caller has to remember.
  //
  // The belt-and-braces try/catch on top of `humanizeAgentError`'s own
  // try/catch guarantees an error event still fires even if the humanizer
  // ever propagates a throw (e.g., a type mismatch). The humanizer itself
  // returns `HUMANIZER_SAFE_FALLBACK` on its internal failures and notifies
  // the observer wired above; this outer catch is the dispatcher-layer
  // safety net for anything that might slip past that.
  let humanizedCopy: string;
  if (hasHumanizedOverride && humanizedOverride !== undefined) {
    humanizedCopy = humanizedOverride;
  } else if (roleResolutionFailure) {
    humanizedCopy = humanizeRoleResolutionFailure(roleResolutionFailure);
  } else {
    try {
      humanizedCopy = errorKind !== 'unknown'
        ? humanizeAgentError({
            kind: 'classified',
            errorKind,
            rawMessage: message,
            provider,
            upstreamProviderName,
            limitScope,
            billingMeta,
            rateLimitMeta,
            managedModelMeta,
          })
        : humanizeAgentError({
            kind: 'unclassified',
            rawMessage: message,
            provider,
          });
    } catch (humanizeErrorThrown) {
      log.warn(
        { err: humanizeErrorThrown, turnId, errorKind, provider, layer: 'dispatcher' },
        'humanizeAgentError threw in dispatcher; using safe fallback',
      );
      try {
        getTracker().track('ai_error_humanization_failed', { layer: 'dispatcher' });
      } catch (trackingError) {
        log.debug(
          { err: trackingError, layer: 'dispatcher' },
          'tracker.track failed for ai_error_humanization_failed',
        );
      }
      humanizedCopy = HUMANIZER_SAFE_FALLBACK;
    }
  }

  // Capture the raw upstream body once, redacted + truncated for persistence.
  // This is the diagnostic floor for all error kinds: the existing
  // `rateLimitMeta.rawError` / `billingMeta.rawError` paths only populate
  // the raw body for two specific kinds, so any other kind ('unknown', '5xx',
  // 'auth', 'timeout') previously dropped the upstream text entirely. Eval
  // diagnostics fall back to this top-level field. See the planning doc:
  // docs/plans/260429_eval_reliability_judge_panel.md § S2.
  // Source `rawMessage` carries the verbatim upstream body when an opaque
  // wrapper (e.g. ModelError) preserved it; otherwise we fall through to the
  // computed `message`. This function only fires for `errorSource: 'main'`
  // (hardcoded below), which is the constraint the planning doc describes —
  // renderer-originated errors never reach this path so we don't need a
  // runtime guard.
  const rawErrorBodyForPersistence = rawMessage || message;
  const persistedRawError = redactAndTruncateRawError(rawErrorBodyForPersistence);
  // Defensive: never let a classifier defect drop the user-visible error
  // event. If classifyErrorUx throws, log + emit a tracker counter and
  // continue with `resolution = undefined`. Downstream consumers already
  // treat resolution as optional.
  let resolution: ReturnType<typeof classifyErrorUx> | undefined;
  try {
    resolution = classifyErrorUx({
      errorKind,
      // Display-safe message for the banner: `fallbackMessage` is the error's clean
      // `.message` (for a ModelError this is the EXTRACTED provider message, not the raw
      // `__rawMessage` diagnostic body), redacted before it can reach user-facing copy.
      // Using the raw `message` here would surface the litellm/proxy wrapper AND bypass
      // redaction (cross-family review F1/F3).
      rawMessage: redactAndTruncateRawError(fallbackMessage) ?? '',
      provider,
      upstreamProviderName,
      limitScope,
      billingMeta,
      rateLimitMeta,
      settingsContext: opts?.settingsContext,
      unsupportedModelId: getUnsupportedModelId(rawError),
      invalidReason: getRouteInvalidReason(rawError),
      failedRole: getFailedRouteRole(rawError),
      chiefOfStaffReason: getChiefOfStaffReason(rawError),
    });
  } catch (err) {
    log.warn(
      {
        err,
        turnId,
        errorKind,
        ...(provider ? { provider } : {}),
        layer: 'dispatcher',
      },
      'classifyErrorUx threw; omitting resolution from error event'
    );
    try {
      getTracker().track('ai_error_resolution_classification_failed', {
        turnId,
        errorKind,
        layer: 'dispatcher',
      });
    } catch {
      // Tracker is best-effort; never let observability sink the event.
    }
    resolution = undefined;
  }

  // F4: default `isTransient` from classification when the caller did not set
  // it, so the conversation reducer can recover trajectory on classified
  // transient drops (`server_error` / `network`) and unclassified-but-text-
  // recognised transient drops without every error path needing to thread
  // `isTransient` explicitly. Only ever set `true` via defaulting — never
  // `false` — so downstream consumers that fall back to `errorKind`-based
  // retry decisions (e.g. `memoryUpdateService`'s `isMemoryUpdateRetryableError`
  // switch) keep their existing behavior for kinds like `rate_limit` and
  // `message_timeout` that aren't connection drops but are still retryable for
  // memory updates.
  //
  // Related: docs/plans/260503_turn_error_trajectory_preservation.md.
  let resolvedIsTransient: boolean | undefined;
  let isTransientSource:
    | 'caller'
    | 'classified-server-error'
    | 'classified-network'
    | 'unclassified-regex'
    | 'none' = 'none';
  if (opts?.isTransient !== undefined) {
    resolvedIsTransient = opts.isTransient;
    isTransientSource = 'caller';
  } else if (errorKind === 'server_error') {
    resolvedIsTransient = true;
    isTransientSource = 'classified-server-error';
  } else if (errorKind === 'network') {
    resolvedIsTransient = true;
    isTransientSource = 'classified-network';
  } else if (errorKind === 'unknown') {
    if (isTransientError(message)) {
      resolvedIsTransient = true;
      isTransientSource = 'unclassified-regex';
    } else {
      resolvedIsTransient = undefined;
    }
  } else {
    resolvedIsTransient = undefined;
  }

  // Stage 6 observability: when the dispatcher *defaults* a terminal error to
  // transient (classified transient or unclassified-regex paths), emit a Pino
  // info log and a tracker event so we can monitor firing rate and detect
  // over-tagging in production. Caller-set values are skipped — those are
  // explicit legacy paths and don't represent the new defaulting behavior we
  // want to watch.
  if (resolvedIsTransient === true && isTransientSource !== 'caller') {
    log.info(
      {
        turnId,
        errorKind,
        ...(provider ? { provider } : {}),
        isTransientSource,
        layer: 'dispatcher',
      },
      'Trajectory recovery eligible: dispatcher defaulted isTransient=true',
    );
    try {
      getTracker().track('ai_transient_error_classified', {
        ...(errorKind !== 'unknown' ? { errorKind } : {}),
        ...(provider ? { provider } : {}),
        source: isTransientSource,
      });
    } catch (trackingError) {
      log.debug(
        { err: trackingError, turnId, errorKind },
        'Failed to track ai_transient_error_classified',
      );
    }
  }

  const event: AgentEvent = {
    type: 'error',
    error: humanizedCopy,
    // Internal diagnostic only: redacted/truncated above. User-copy and
    // analytics leak guarantees live in the copy + `ai_error_shown` paths.
    ...(persistedRawError ? { rawError: persistedRawError } : {}),
    ...(resolvedIsTransient !== undefined ? { isTransient: resolvedIsTransient } : {}),
    ...(errorKind !== 'unknown' ? { errorKind } : {}),
    resolution,
    ...(rateLimitMeta ? { rateLimitMeta } : {}),
    ...(billingMeta ? { billingMeta } : {}),
    ...(managedModelMeta ? { managedModelMeta } : {}),
    ...(provider ? { provider } : {}),
    ...(opts?.timeoutDiagnostic ? { timeoutDiagnostic: opts.timeoutDiagnostic } : {}),
    ...(opts?.watchdogDiagnostic ? { watchdogDiagnostic: opts.watchdogDiagnostic } : {}),
    errorSource: 'main',
    ...(limitScope ? { limitScope } : {}),
    ...(credentialSource ? { credentialSource } : {}),
    headlineClass,
    timestamp: opts?.timestampOverride ?? Date.now(),
  };

  // I2 emit-boundary fence (260529 error-emit-funnel, Stage 2; hardened
  // Stage 5). Enforce the wire contract before dispatch: throw in test/CI,
  // normalize-and-report in prod (never drop the error event). See
  // `enforceErrorKindWireContract`.
  enforceErrorKindWireContract(event, { turnId, provider });

  try {
    dispatchAgentEventInternal(win, turnId, event);

    // Default-true for the two error kinds where the user must act before the
    // turn can succeed: `billing` (add credit, switch provider) and
    // `managed_model_not_allowed` (switch to an allowed model or upgrade the
    // tier). Both are subscription/quota-style failures that the UI must
    // surface prominently — silently treating them as transient would loop
    // the user back into the same rejection. Other kinds (rate_limit,
    // server_error, timeout, etc.) stay opt-in via explicit `markActionable:
    // true` because they're typically retryable without user intervention.
    // See docs/plans/260513a_subscription_consumer_audit_gaps.md § G3.
    const shouldMarkActionable =
      opts?.markActionable === true ||
      ((errorKind === 'billing' || errorKind === 'managed_model_not_allowed') &&
        opts?.markActionable !== false);
    if (shouldMarkActionable) {
      agentTurnRegistry.markActionableErrorDispatched(turnId);
    }

    const telemetryOwner = opts?.recoveryOwner ?? ownerForRecoveryKind(errorKind);
    // FOX-3494 (#5): the route-target `provider` field alone masked this incident
    // for a week (it stamped Anthropic for a ChatGPT-Pro user). Attach the true
    // route culprit — the invalidReason, the failed route role, and the model that
    // could not be served — so a recurrence is diagnosable from telemetry without
    // re-deriving it from logs. Only emitted when present (route terminals carry
    // them; most errors don't), so existing dashboards keyed on errorKind/
    // headlineClass/provider are unaffected (errorKind/headlineClass are unchanged
    // by Option Y — the actionable claude-* terminal stays
    // connection-not-configured / headlineClass:auth).
    const routeInvalidReason = getRouteInvalidReason(rawError);
    const failedRouteRole = getFailedRouteRole(rawError);
    const unsupportedModelIdForTelemetry = getUnsupportedModelId(rawError);
    try {
      getTracker().track('ai_error_shown', {
        errorKind,
        owner: telemetryOwner,
        headlineClass,
        ...(limitScope ? { limitScope } : {}),
        ...(credentialSource ? { credentialSource } : {}),
        ...(errorKind === 'billing' && billingMeta ? { billingSubtype: billingMeta.subtype } : {}),
        ...(provider ? { provider } : {}),
        ...(billingMeta?.upstreamProviderName ? { upstreamProvider: billingMeta.upstreamProviderName } : {}),
        ...(routeInvalidReason ? { routeInvalidReason } : {}),
        ...(failedRouteRole ? { failedRouteRole } : {}),
        ...(unsupportedModelIdForTelemetry ? { unsupportedModelId: unsupportedModelIdForTelemetry } : {}),
        // Stage 5b: multi-provider failover exhaustion fields (only on terminal error)
        ...(opts?.rateLimitProvider ? { rateLimitProvider: opts.rateLimitProvider } : {}),
        ...(opts?.failoverReason ? { failoverReason: opts.failoverReason } : {}),
      });
    } catch (trackingError) {
      log.debug({ err: trackingError, turnId, errorKind }, 'Failed to track ai_error_shown');
    }

    return {
      ok: true,
      ...(errorKind !== 'unknown' ? { dispatchedErrorKind: errorKind } : {}),
    };
  } catch (err) {
    log.warn(
      { err, turnId, errorKind, provider },
      'Failed to dispatch agent error event'
    );
    return { ok: false };
  }
}
