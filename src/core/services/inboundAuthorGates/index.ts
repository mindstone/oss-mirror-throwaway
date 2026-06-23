import { createHash } from 'node:crypto';
import { SLACK_INBOUND_AUTHOR_GATE } from './slackInboundAuthorGate';
import type {
  InboundAuthorContext,
  InboundAuthorDecision,
  InboundAuthorGate,
  InboundAuthorPolicy,
} from './types';

const FALLBACK_DENY_GATE_ID = 'fallback_deny';
const FALLBACK_DENY_REASON = 'no_matching_gate';
const MISSING_GATE_REASON = 'gate_returned_no_reason';

export const INBOUND_AUTHOR_GATES: ReadonlyArray<InboundAuthorGate> = [
  SLACK_INBOUND_AUTHOR_GATE,
];

function canonicalizePolicy(value: unknown): unknown {
  if (Array.isArray(value)) {
    const canonicalizedArray = value.map((entry) => canonicalizePolicy(entry));
    if (canonicalizedArray.every((entry) => typeof entry === 'string')) {
      return [...(canonicalizedArray as string[])].sort();
    }
    return canonicalizedArray;
  }

  if (value === null || typeof value !== 'object') {
    return value;
  }

  const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
    a.localeCompare(b),
  );
  const canonicalizedObject: Record<string, unknown> = {};
  for (const [key, nestedValue] of entries) {
    canonicalizedObject[key] = canonicalizePolicy(nestedValue);
  }
  return canonicalizedObject;
}

export function buildInboundAuthorPolicyRevision(policy: InboundAuthorPolicy): string {
  const canonicalPolicy = canonicalizePolicy(policy);
  const serializedPolicy = JSON.stringify(canonicalPolicy);
  const hash = createHash('sha1').update(serializedPolicy, 'utf8').digest('hex');
  return `v${policy.inboundAuthorPolicySchemaVersion}:${hash}`;
}

export function evaluateInboundAuthor(
  ctx: InboundAuthorContext,
  policy: InboundAuthorPolicy,
  gates: ReadonlyArray<InboundAuthorGate> = INBOUND_AUTHOR_GATES,
): InboundAuthorDecision {
  const policyRevision = buildInboundAuthorPolicyRevision(policy);

  for (const gate of gates) {
    const result = gate.evaluate(ctx, policy);
    if (result.decision === 'pass') {
      continue;
    }

    return {
      decision: result.decision,
      gateId: result.gateId,
      reason: result.reason ?? MISSING_GATE_REASON,
      policyRevision,
    };
  }

  return {
    decision: 'deny',
    gateId: FALLBACK_DENY_GATE_ID,
    reason: FALLBACK_DENY_REASON,
    policyRevision,
  };
}

export type {
  InboundAuthorContext,
  InboundAuthorDecision,
  InboundAuthorGate,
  InboundAuthorGateResult,
  InboundAuthorPolicy,
} from './types';
