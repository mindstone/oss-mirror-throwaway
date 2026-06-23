import type {
  InboundAuthorContext,
  InboundAuthorGate,
  InboundAuthorGateResult,
  InboundAuthorPolicy,
  InboundAuthorPrincipal,
} from './types';

function getPrincipal(ctx: InboundAuthorContext): InboundAuthorPrincipal {
  if (ctx.principal) {
    return ctx.principal;
  }

  return {
    kind: ctx.principalKind,
    normalizedAuthorId: ctx.normalizedAuthorId,
  };
}

function getPolicyValuesByConnector(
  policyRecord: Record<string, string[]>,
  connector: string,
): ReadonlyArray<string> {
  return policyRecord[connector] ?? [];
}

function isAuthorInPolicyRecord(
  policyRecord: Record<string, string[]>,
  ctx: InboundAuthorContext,
  normalizedAuthorId: string,
): boolean {
  return getPolicyValuesByConnector(policyRecord, ctx.connector).includes(normalizedAuthorId);
}

function decision(
  gateId: string,
  gateDecision: InboundAuthorGateResult['decision'],
  reason: string,
): InboundAuthorGateResult {
  return { decision: gateDecision, gateId, reason };
}

export const SLACK_INBOUND_AUTHOR_GATE: InboundAuthorGate = {
  id: 'slack_owner_allowlist',
  description:
    'Slack inbound author admission gate with blocklist, owner, allowlist, trusted-surface, and agent-allowlist checks.',
  evaluate(ctx, policy) {
    const principal = getPrincipal(ctx);
    const ownerNormalizedAuthorId = policy.ownerNormalizedAuthorId?.trim();

    if (isAuthorInPolicyRecord(policy.blocklist, ctx, principal.normalizedAuthorId)) {
      return decision(this.id, 'deny', 'blocklist');
    }

    if (policy.mode === 'legacyPermissive') {
      return decision(this.id, 'allow', 'legacy_permissive');
    }

    if (
      principal.kind === 'human'
      && ownerNormalizedAuthorId
      && principal.normalizedAuthorId === ownerNormalizedAuthorId
    ) {
      return decision(this.id, 'allow', 'owner');
    }

    if (
      policy.mode === 'allowlist'
      && isAuthorInPolicyRecord(policy.allowlist, ctx, principal.normalizedAuthorId)
    ) {
      return decision(this.id, 'allow', 'allowlist');
    }

    if (
      policy.mode === 'allowlist'
      && ctx.surfaceTrusted === true
      && principal.kind === 'human'
    ) {
      return decision(this.id, 'allow', 'surface_trusted');
    }

    if (
      principal.kind === 'agent'
      && isAuthorInPolicyRecord(policy.agentAllowlist, ctx, principal.normalizedAuthorId)
    ) {
      return decision(this.id, 'allow', 'agent_allowlist');
    }

    return decision(this.id, 'deny', 'not_owner_or_allowlisted');
  },
};
