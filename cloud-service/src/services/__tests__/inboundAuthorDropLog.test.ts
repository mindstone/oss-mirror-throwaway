import { describe, expect, it, vi } from 'vitest';
import {
  hashPrincipalUserId,
  logInboundAuthorDrop,
  summarizePolicyForLog,
} from '../inboundAuthorDropLog';

const policySummary = summarizePolicyForLog({
  inboundAuthorPolicySchemaVersion: 1,
  policyRevision: 7,
  mode: 'allowlist',
  allowlist: { slack: ['U123', 'U999'] },
  blocklist: { slack: ['U555'] },
  surfaceTrusted: { slack: ['C123'] },
  agentAllowlist: { slack: ['agent-1', 'agent-2', 'agent-3'] },
  notices: { upgradeReviewPending: false },
});

describe('inboundAuthorDropLog', () => {
  it('hashPrincipalUserId is stable and principal-kind aware', () => {
    const humanHash = hashPrincipalUserId('human', 'U123ABC');
    expect(humanHash).toMatch(/^[a-f0-9]{12}$/);
    expect(hashPrincipalUserId('human', 'U123ABC')).toBe(humanHash);
    expect(hashPrincipalUserId('agent', 'U123ABC')).not.toBe(humanHash);
  });

  it('logs the full structured drop schema', () => {
    const logger = {
      warn: vi.fn(),
    } as any;

    logInboundAuthorDrop({
      logger,
      eventId: 'E1',
      teamIdHash: 'team-hash',
      principalUserIdHash: hashPrincipalUserId('human', 'U999XYZ'),
      principalKind: 'human',
      surfaceId: 'C123',
      decision: 'drop_context',
      gateId: 'slack_owner_allowlist',
      reason: 'not_owner_or_allowlisted',
      policyRevision: 'v1:abc123',
      policySummary,
    });

    expect(logger.warn).toHaveBeenCalledWith(
      {
        event: 'slack_inbound_dropped_author_policy',
        eventId: 'E1',
        teamIdHash: 'team-hash',
        principalUserIdHash: hashPrincipalUserId('human', 'U999XYZ'),
        principalKind: 'human',
        surfaceId: 'C123',
        decision: 'drop_context',
        gateId: 'slack_owner_allowlist',
        reason: 'not_owner_or_allowlisted',
        policyRevision: 'v1:abc123',
        policySummary,
      },
      'slack_inbound_dropped_author_policy',
    );
  });

  it('supports custom log event names and decision discriminators', () => {
    const logger = {
      warn: vi.fn(),
    } as any;

    logInboundAuthorDrop({
      logger,
      eventId: 'E-self',
      teamIdHash: 'team-hash',
      principalUserIdHash: hashPrincipalUserId('agent', 'B_REBEL'),
      principalKind: 'agent',
      surfaceId: 'D123',
      decision: 'drop_self_message',
      gateId: 'self_message',
      reason: 'bot_id_matches_workspace_bot_user_id',
      policyRevision: 'v1:def456',
      policySummary,
      logEvent: 'slack_inbound_dropped_self_message',
    });

    expect(logger.warn).toHaveBeenCalledWith(
      {
        event: 'slack_inbound_dropped_self_message',
        eventId: 'E-self',
        teamIdHash: 'team-hash',
        principalUserIdHash: hashPrincipalUserId('agent', 'B_REBEL'),
        principalKind: 'agent',
        surfaceId: 'D123',
        decision: 'drop_self_message',
        gateId: 'self_message',
        reason: 'bot_id_matches_workspace_bot_user_id',
        policyRevision: 'v1:def456',
        policySummary,
      },
      'slack_inbound_dropped_self_message',
    );
  });

  it('summarizePolicyForLog returns per-map entry counts for operators', () => {
    expect(policySummary).toEqual({
      mode: 'allowlist',
      allowlistSize: 2,
      blocklistSize: 1,
      surfaceTrustedSize: 1,
      agentAllowlistSize: 3,
    });
  });
});
