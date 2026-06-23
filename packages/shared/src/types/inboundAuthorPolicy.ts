import { z } from 'zod';

export const PrincipalKindSchema = z.enum(['human', 'agent', 'unknown']);
export type PrincipalKind = z.infer<typeof PrincipalKindSchema>;

export const InboundAuthorConnectorSchema = z.enum(['slack', 'teams', 'email', 'whatsapp', 'discord']);
export type InboundAuthorConnector = z.infer<typeof InboundAuthorConnectorSchema>;

export const ExternalPrincipalSchema = z.object({
  kind: PrincipalKindSchema,
  normalizedAuthorId: z.string(),
});
export type ExternalPrincipal = z.infer<typeof ExternalPrincipalSchema>;

export const InboundAuthorContextSchema = z.object({
  connector: InboundAuthorConnectorSchema,
  teamId: z.string(),
  surfaceId: z.string(),
  principalKind: PrincipalKindSchema,
  normalizedAuthorId: z.string(),
});
export type InboundAuthorContext = z.infer<typeof InboundAuthorContextSchema>;

export const InboundAuthorDecisionSchema = z.object({
  kind: z.enum(['allow', 'drop']),
  gate: z.object({
    id: z.string(),
    reason: z.string(),
  }),
});
export type InboundAuthorDecision = z.infer<typeof InboundAuthorDecisionSchema>;

export const PolicyModeSchema = z.enum(['ownerOnly', 'allowlist', 'legacyPermissive']);
export type PolicyMode = z.infer<typeof PolicyModeSchema>;

export const InboundAuthorPolicySchemaVersion = 1 as const;
export type InboundAuthorPolicySchemaVersion = typeof InboundAuthorPolicySchemaVersion;

export const InboundAuthorPolicySchema = z.object({
  inboundAuthorPolicySchemaVersion: z.literal(InboundAuthorPolicySchemaVersion),
  policyRevision: z.number().int().nonnegative(),
  mode: PolicyModeSchema,
  allowlist: z.record(z.string(), z.array(z.string())),
  blocklist: z.record(z.string(), z.array(z.string())),
  surfaceTrusted: z.record(z.string(), z.array(z.string())),
  agentAllowlist: z.record(z.string(), z.array(z.string())),
  notices: z.object({
    upgradeReviewPending: z.boolean(),
  }),
});
export type InboundAuthorPolicy = z.infer<typeof InboundAuthorPolicySchema>;

export const SlackRecentSenderKindSchema = z.enum(['human', 'agent']);
export type SlackRecentSenderKind = z.infer<typeof SlackRecentSenderKindSchema>;

export const SlackRecentSenderChannelTypeSchema = z.enum(['im', 'mpim', 'channel']);
export type SlackRecentSenderChannelType = z.infer<typeof SlackRecentSenderChannelTypeSchema>;

export const SlackRecentSenderDtoSchema = z.object({
  principalKey: z.string(),
  kind: SlackRecentSenderKindSchema,
  authorId: z.string(),
  normalizedAuthorId: z.string(),
  displayName: z.string().optional(),
  handle: z.string().optional(),
  teamId: z.string(),
  lastSeenAt: z.number(),
  attemptCount: z.number().int().nonnegative(),
  channelIds: z.array(z.string()),
  lastChannelType: SlackRecentSenderChannelTypeSchema,
});
export type SlackRecentSenderDto = z.infer<typeof SlackRecentSenderDtoSchema>;
