/**
 * Typed model-eligibility authority over route decisions (Stage 3).
 *
 * This module is a PURE TYPED VIEW over the route decision the engine already
 * computes — it is NOT a second/third resolver. `eligible()` obtains exactly
 * ONE `ProviderRouteDecision` from the existing `ProviderRouter` chokepoint and
 * `eligibilityFromDecision()` maps that decision to a typed result. The view
 * computes nothing `routeDecision` does not already compute:
 *
 *   - `dispatchable` decision  -> `{ kind: 'eligible' }`
 *   - `terminal` decision      -> `{ kind: 'ineligible' }`, where `source` is a
 *                                 pure TOTAL function of `invalidReason`.
 *
 * Guardrails (PLAN Stage 3, F1/F2):
 *   - `connectedProviders` is carried in `RouteEligibilityContext` so the
 *     future prioritised-model-config shape is visible, but it is INERT today:
 *     it MUST NOT influence the verdict. Today's verdict is the
 *     active-provider-only `routeDecision` output. Broadening eligibility to a
 *     connected set would compute a new fact outside `routeDecision` (the
 *     third-resolver pathology C2 forbids). The correct future path is to
 *     extend `routeDecision` itself, not to branch here.
 *   - Single-now: only `eligible(candidate, ctx)` + `eligibilityFromDecision`
 *     are exported. No list-taking `resolveTopEligibleModelCandidate` — the
 *     result *type* is list-ready, the *function* is single-candidate.
 *   - `retryAfter?` exists in the type but is always omitted now (no backoff
 *     store — out of scope).
 *
 * See docs/plans/260604_routing-ssot-divergence/PLAN.md (Stage 3).
 */
import type { ActiveProvider } from '@shared/types';
import type { RoutingModelId } from '@shared/utils/modelChoiceCodec';
import {
  assertNever,
  buildTerminalReconnectMessage,
  isDispatchableDecision,
  type CodexConnectivity,
  type DispatchableRouteDecision,
  type ProviderRouteDecision,
  type ProviderRouteInvalidReason,
  type ProviderRouteRole,
} from './providerRouteDecision';
import {
  ProviderRouter,
  type ProviderRouteSettings,
} from './providerRouting';

/**
 * Why a candidate is ineligible, in product/UX vocabulary. A pure projection of
 * the routing engine's `ProviderRouteInvalidReason` (see `eligibilitySourceForReason`).
 */
export type EligibilitySource =
  | 'credentials'
  | 'provider'
  | 'rate-limit'
  | 'subscription'
  | 'profile'
  | 'route';

/**
 * Typed eligibility verdict for ONE candidate. List-ready (composes under a
 * future `.find(eligible)`) but produced one candidate at a time.
 */
export type ModelEligibilityResult =
  | { kind: 'eligible'; routePlan: DispatchableRouteDecision }
  | {
      kind: 'ineligible';
      /** Human-facing reason (the recoverable reconnect message where available, else the raw reason code). */
      reason: string;
      /** Product-vocabulary source of the verdict, a pure total function of `invalidReason`. */
      source: EligibilitySource;
      /** Backoff hint — present in the type but always omitted now (no backoff store; out of scope). */
      retryAfter?: number;
    };

/** A single model to test for eligibility, in neutral routing vocabulary. */
export interface ModelCandidate {
  /** The routing model id to evaluate (typed; C6). */
  model: RoutingModelId;
  /** Routing role this candidate is being considered for. */
  role: ProviderRouteRole;
}

/**
 * Context for a single eligibility check. Mirrors the active-provider routing
 * inputs; `connectedProviders` is carried for the future shape but INERT today.
 */
export interface RouteEligibilityContext {
  /** Full route settings — the single source of truth the engine routes from. */
  settings: ProviderRouteSettings;
  /** The active provider (also derivable from `settings`; carried for the future-feature shape). */
  activeProvider?: ActiveProvider;
  /**
   * Providers currently connected. INERT today: carried so the future
   * prioritised-model-config shape is visible, but MUST NOT influence the
   * verdict (F1/C2). The verdict is the active-provider-only `routeDecision`.
   */
  connectedProviders?: readonly ActiveProvider[];
  /** Codex connectivity, forwarded to the route decision. */
  codexConnectivity: CodexConnectivity;
  /** Managed (Mindstone subscription) key availability, forwarded so `selectProviderMode` (invariant #3) sees it. */
  hasManagedKey?: boolean;
}

/**
 * Exhaustive, by-construction mapping from every `ProviderRouteInvalidReason`
 * to its product-vocabulary `EligibilitySource`. The `assertNever` default makes
 * adding a new invalid reason a COMPILE ERROR until it is mapped here.
 */
function eligibilitySourceForReason(reason: ProviderRouteInvalidReason): EligibilitySource {
  switch (reason) {
    case 'missing-anthropic-credentials':
    case 'missing-openrouter-credentials':
      return 'credentials';
    case 'missing-mindstone-credentials':
      return 'subscription';
    case 'missing-codex-connection':
    case 'codex-disconnected-bts-blocked':
      return 'provider';
    case 'codex-unsupported-model':
    case 'missing-anthropic-credentials-for-claude-model':
    case 'proxy-dialect-in-direct-anthropic':
      return 'route';
    case 'missing-profile-credentials':
      return 'profile';
    default:
      return assertNever(reason, 'ProviderRouteInvalidReason');
  }
}

/** Human-facing reason for a terminal decision: the recoverable reconnect message where available, else the raw code. */
function reasonMessageForDecision(reason: ProviderRouteInvalidReason, decision: ProviderRouteDecision): string {
  // `proxy-dialect-in-direct-anthropic` is non-recoverable; buildTerminalReconnectMessage throws for it.
  if (reason === 'proxy-dialect-in-direct-anthropic') {
    return reason;
  }
  if (decision.kind === 'terminal') {
    return buildTerminalReconnectMessage(decision).message;
  }
  return reason;
}

/**
 * PURE mapper: project a route decision the engine already computed onto the
 * typed eligibility result. Computes no new fact.
 */
export function eligibilityFromDecision(decision: ProviderRouteDecision): ModelEligibilityResult {
  if (isDispatchableDecision(decision)) {
    return { kind: 'eligible', routePlan: decision };
  }
  const reason = decision.invalidReason;
  return {
    kind: 'ineligible',
    reason: reasonMessageForDecision(reason, decision),
    source: eligibilitySourceForReason(reason),
    // retryAfter intentionally omitted (no backoff store — out of scope).
  };
}

/**
 * Single-candidate eligibility authority. Obtains EXACTLY ONE
 * `ProviderRouteDecision` from the existing `ProviderRouter` chokepoint (by
 * role) and maps it via `eligibilityFromDecision`. Delegates entirely to
 * `routeDecision`/`selectProviderMode` — adds no parallel resolution.
 *
 * `connectedProviders` is read from `ctx` for the future shape but is NOT used
 * in the verdict (F1/C2).
 */
export function eligible(candidate: ModelCandidate, ctx: RouteEligibilityContext): ModelEligibilityResult {
  const settings: ProviderRouteSettings = {
    ...ctx.settings,
    ...(ctx.activeProvider !== undefined ? { activeProvider: ctx.activeProvider } : {}),
    ...(ctx.hasManagedKey !== undefined ? { hasManagedKey: ctx.hasManagedKey } : {}),
  };

  const baseInput = {
    settings,
    model: candidate.model,
    codexConnectivity: ctx.codexConnectivity,
  } as const;

  let decision: ProviderRouteDecision;
  switch (candidate.role) {
    case 'execution':
    case 'planning':
      decision = ProviderRouter.forTurn({ ...baseInput, role: candidate.role });
      break;
    case 'bts':
      decision = ProviderRouter.forBTS({ ...baseInput });
      break;
    case 'subagent':
      decision = ProviderRouter.forSubagent({ ...baseInput });
      break;
    default:
      return assertNever(candidate.role, 'ProviderRouteRole');
  }

  return eligibilityFromDecision(decision);
}
