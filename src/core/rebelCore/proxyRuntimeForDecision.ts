import {
  isProxyDispatch,
  isRouteTableDispatch,
  type ProviderRouteDecision,
} from './providerRouteDecision';

export interface ProxyRuntimeManager {
  baseURL: string | null;
  authToken: string | null;
}

export interface ProxyRuntimeForDecisionResult {
  proxyBaseURL: string | null;
  proxyAuthToken: string | null;
  routedModel: string | null;
}

export function proxyRuntimeForDecision(
  decision: ProviderRouteDecision,
  proxyManager: ProxyRuntimeManager,
): ProxyRuntimeForDecisionResult {
  const proxyBaseURL = isProxyDispatch(decision.dispatchPath) ? proxyManager.baseURL : null;
  const proxyAuthToken = proxyBaseURL ? proxyManager.authToken : null;
  const routedModel = isRouteTableDispatch(decision.dispatchPath) ? decision.canonicalModelId : null;
  return {
    proxyBaseURL,
    proxyAuthToken,
    routedModel,
  };
}
