/**
 * Provider Route Plan — leaf type module.
 *
 * Contains the `ProviderRoutePlan` union and related leaf plan types, with no
 * runtime imports
 * of `providerAuthPlan` or `providerRoutePlan` so that downstream modules
 * (notably `providerAuthPlan.ts`'s `applyAuthPlanToEnv`) can import this
 * type without creating a runtime circular dependency.
 *
 * The full plan materializer + runtime context types live in
 * `providerRoutePlan.ts`, which depends on this module.
 */

import type { ProviderAuthPlan, ResolvedAuthLabel } from './providerAuthPlanTypes';
import type {
  DispatchableRouteDecision,
  ProviderRouteHeaderTuples,
  TerminalRouteDecision,
} from './providerRouteDecision';

interface ProviderRoutePlanBase {
  auth: ProviderAuthPlan;
  headers: ProviderRouteHeaderTuples;
  proxyBaseURL: string | null;
  endpoint?: { baseURL: string };
  resolvedAuthLabel: ResolvedAuthLabel;
  proxyRequired: boolean;
  invalidReason: string | null;
}

export type DispatchableRoutePlan = ProviderRoutePlanBase & {
  decision: DispatchableRouteDecision;
};

export type TerminalRoutePlan = ProviderRoutePlanBase & {
  decision: TerminalRouteDecision;
};

export type ProviderRoutePlan = DispatchableRoutePlan | TerminalRoutePlan;

export function isTerminalRoutePlan(
  plan: ProviderRoutePlan,
): plan is TerminalRoutePlan {
  return plan.decision.kind === 'terminal';
}
