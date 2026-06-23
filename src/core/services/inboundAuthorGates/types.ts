/**
 * Inbound author admission gates.
 *
 * Boundary note: this module decides whether inbound authors may trigger
 * Rebel. It is intentionally separate from `connectorApprovalGates`, which
 * governs outbound tool approvals.
 */

import type {
  InboundAuthorConnector,
  InboundAuthorContext as SharedInboundAuthorContext,
  InboundAuthorPolicy as SharedInboundAuthorPolicy,
  PolicyMode,
  PrincipalKind,
} from '@rebel/shared';

export interface InboundAuthorPrincipal {
  kind: PrincipalKind;
  normalizedAuthorId: string;
}

/**
 * Shared inbound-author context, with optional convenience fields for gate
 * authors.
 */
export interface InboundAuthorContext extends SharedInboundAuthorContext {
  principal?: InboundAuthorPrincipal;
  surfaceTrusted?: boolean;
}

/**
 * Shared policy shape, with optional owner identity injected by the caller.
 */
export interface InboundAuthorPolicy extends SharedInboundAuthorPolicy {
  ownerNormalizedAuthorId?: string;
}

export interface InboundAuthorGateResult {
  decision: 'allow' | 'deny' | 'pass';
  gateId: string;
  reason?: string;
}

export interface InboundAuthorGate {
  id: string;
  description: string;
  evaluate: (
    ctx: InboundAuthorContext,
    policy: InboundAuthorPolicy,
  ) => InboundAuthorGateResult;
}

export interface InboundAuthorDecision {
  decision: 'allow' | 'deny';
  gateId: string;
  reason: string;
  policyRevision: string;
}

export type { InboundAuthorConnector, PolicyMode, PrincipalKind };
