import { describe, expect, it } from 'vitest';
import {
  InboundAuthorPolicySchema,
  InboundAuthorPolicySchemaVersion,
  InboundAuthorContextSchema,
  InboundAuthorDecisionSchema,
  SlackRecentSenderDtoSchema,
} from '../types/inboundAuthorPolicy';

describe('inboundAuthorPolicy schemas', () => {
  it('accepts a valid schema-v1 inbound policy object', () => {
    const parsed = InboundAuthorPolicySchema.parse({
      inboundAuthorPolicySchemaVersion: InboundAuthorPolicySchemaVersion,
      policyRevision: 1,
      mode: 'ownerOnly',
      allowlist: {},
      blocklist: {},
      surfaceTrusted: {},
      agentAllowlist: {},
      notices: {
        upgradeReviewPending: false,
      },
    });

    expect(parsed.mode).toBe('ownerOnly');
  });

  it('rejects missing required schema-v1 policy fields', () => {
    const parsed = InboundAuthorPolicySchema.safeParse({
      inboundAuthorPolicySchemaVersion: InboundAuthorPolicySchemaVersion,
      policyRevision: 1,
      mode: 'ownerOnly',
      blocklist: {},
      surfaceTrusted: {},
      agentAllowlist: {},
      notices: {
        upgradeReviewPending: false,
      },
    });

    expect(parsed.success).toBe(false);
  });

  it('parses inbound author context and decision contracts', () => {
    const context = InboundAuthorContextSchema.parse({
      connector: 'slack',
      teamId: 'T123',
      surfaceId: 'C456',
      principalKind: 'human',
      normalizedAuthorId: 'U123ABC',
    });
    const decision = InboundAuthorDecisionSchema.parse({
      kind: 'drop',
      gate: {
        id: 'owner-only',
        reason: 'not-owner',
      },
    });

    expect(context.connector).toBe('slack');
    expect(decision.gate.id).toBe('owner-only');
  });

  it('parses recent sender dto objects', () => {
    const parsed = SlackRecentSenderDtoSchema.parse({
      principalKey: 'slack:T123:human:U123ABC',
      kind: 'human',
      authorId: 'u123abc',
      normalizedAuthorId: 'U123ABC',
      displayName: 'Ada',
      handle: 'ada',
      teamId: 'T123',
      lastSeenAt: 1_714_000_000_000,
      attemptCount: 3,
      channelIds: ['C1', 'C2'],
      lastChannelType: 'channel',
    });

    expect(parsed.attemptCount).toBe(3);
  });
});
