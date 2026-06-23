import crypto from 'node:crypto';
import type { Logger } from '@core/logger';
import type { PrincipalKind } from '@rebel/shared';
import type { InboundAuthorPolicy, PolicyMode } from '@rebel/shared';

export type InboundAuthorDropDecision =
  | 'drop'
  | 'drop_context'
  | 'drop_self_message'
  | 'drop_rate_limited'
  | 'drop_no_owner_identity'
  | 'drop_no_author_identity'
  | 'drop_no_bot_mention'
  | 'drop_metadata_parse_failed';

export interface InboundAuthorDropPolicySummary {
  mode: PolicyMode;
  allowlistSize: number;
  blocklistSize: number;
  surfaceTrustedSize: number;
  agentAllowlistSize: number;
}

export interface InboundAuthorDropLogEntry {
  logger: Logger;
  eventId: string;
  teamIdHash: string;
  principalUserIdHash: string;
  principalKind: PrincipalKind;
  surfaceId: string;
  decision: InboundAuthorDropDecision;
  gateId: string;
  reason: string;
  policyRevision: string;
  policySummary?: InboundAuthorDropPolicySummary;
  extra?: Record<string, unknown>;
  logEvent?: string;
}

function entryCountByConnector(map: Record<string, string[]>): number {
  return Object.values(map).reduce((total, values) => total + values.length, 0);
}

export function hashPrincipalUserId(kind: PrincipalKind, normalizedAuthorId: string): string {
  return crypto.createHash('sha256').update(`${kind}:${normalizedAuthorId}`).digest('hex').slice(0, 12);
}

export function summarizePolicyForLog(policy: InboundAuthorPolicy): InboundAuthorDropPolicySummary {
  return {
    mode: policy.mode,
    allowlistSize: entryCountByConnector(policy.allowlist),
    blocklistSize: entryCountByConnector(policy.blocklist),
    surfaceTrustedSize: entryCountByConnector(policy.surfaceTrusted),
    agentAllowlistSize: entryCountByConnector(policy.agentAllowlist),
  };
}

export function logInboundAuthorDrop(entry: InboundAuthorDropLogEntry): void {
  const logEvent = entry.logEvent ?? 'slack_inbound_dropped_author_policy';
  entry.logger.warn({
    event: logEvent,
    eventId: entry.eventId,
    teamIdHash: entry.teamIdHash,
    principalUserIdHash: entry.principalUserIdHash,
    principalKind: entry.principalKind,
    surfaceId: entry.surfaceId,
    decision: entry.decision,
    gateId: entry.gateId,
    reason: entry.reason,
    policyRevision: entry.policyRevision,
    policySummary: entry.policySummary,
    ...(entry.extra ?? {}),
  }, logEvent);
}
