import { z } from 'zod';
import { defineInvokeChannel, OAuthSetupGuidanceSchema } from '../schemas/common';

export const SLACK_WORKSPACE_CHANGED_CHANNEL = 'slack:workspace-changed' as const;
export const SLACK_WORKSPACE_DISCONNECTED_CHANNEL = 'slack:workspace-disconnected' as const;

export const SlackWorkspaceStatusSchema = z.enum([
  'connected',
  'needs_reconnect',
  'disconnecting',
  'disconnected',
]);

export const SlackWorkspaceChangedSchema = z.object({
  teamId: z.string(),
  teamName: z.string(),
  status: SlackWorkspaceStatusSchema,
  peerInstanceCount: z.number().int().nonnegative().optional(),
  reason: z.enum(['tokens_revoked', 'invalid_auth']).optional(),
  occurredAt: z.number(),
});

export const SlackWorkspaceDisconnectedSchema = z.object({
  teamId: z.string(),
  reason: z.enum(['tokens_revoked', 'invalid_auth', 'manual_disconnect']),
  occurredAt: z.number(),
});

const SlackWorkspaceSchema = z.object({
  teamId: z.string(),
  teamName: z.string(),
});

const SlackResolvedUserSchema = z.object({
  id: z.string(),
  displayName: z.string().optional(),
  realName: z.string().optional(),
  email: z.string().optional(),
});

const SlackResolvedAuthorSchema = z.object({
  id: z.string().regex(/^[UW][A-Z0-9]+$/, 'Slack user IDs start with U or W and use uppercase alphanumerics'),
  teamId: z.string().min(1),
  displayName: z.string().optional(),
  realName: z.string().optional(),
  handle: z.string().optional(),
  email: z.string().optional(),
});

export const SlackResolveAuthorInputErrorCodeSchema = z.enum([
  'no_workspace',
  'not_found',
  'ambiguous',
  'rate_limited',
  'transport_error',
  'invalid_input',
  'auth_failed',
  'deactivated',
]);

const SlackResolveAuthorInputResponseSchema = z.discriminatedUnion('outcome', [
  z.object({
    outcome: z.literal('resolved'),
    author: SlackResolvedAuthorSchema,
  }),
  z.object({
    outcome: z.literal('error'),
    code: SlackResolveAuthorInputErrorCodeSchema,
    message: z.string(),
    candidates: z.array(SlackResolvedAuthorSchema).optional(),
  }),
]);
export type SlackResolveAuthorInputResponse = z.infer<typeof SlackResolveAuthorInputResponseSchema>;

export const slackChannels = {
  'slack:get-workspaces': defineInvokeChannel({
    channel: 'slack:get-workspaces',
    request: z.void(),
    response: z.object({
      workspaces: z.array(SlackWorkspaceSchema),
    }),
    description: 'Get all connected Slack workspaces',
  }),

  'slack:start-auth': defineInvokeChannel({
    channel: 'slack:start-auth',
    request: z.void(),
    response: z.object({
      success: z.boolean(),
      teamName: z.string().optional(),
      error: z.string().optional(),
      setupGuidance: OAuthSetupGuidanceSchema.optional(),
    }),
    description: 'Start OAuth flow to connect a Slack workspace',
  }),

  'slack:remove-workspace': defineInvokeChannel({
    channel: 'slack:remove-workspace',
    request: z.object({
      teamId: z.string(),
    }),
    response: z.object({
      success: z.boolean(),
      error: z.string().optional(),
    }),
    description: 'Remove a connected Slack workspace',
  }),

  'slack:resolve-user': defineInvokeChannel({
    channel: 'slack:resolve-user',
    request: z.object({
      userId: z.string(),
      packageId: z.string().optional(),
      teamId: z.string().optional(),
    }),
    response: z.object({
      success: z.boolean(),
      user: SlackResolvedUserSchema.optional(),
      error: z.string().optional(),
    }),
    description: 'Resolve a Slack user ID to display metadata for approval UI',
  }),

  'slack:cancel-auth': defineInvokeChannel({
    channel: 'slack:cancel-auth',
    request: z.void(),
    response: z.void(),
    description: 'Cancel pending OAuth flow',
  }),

  'slack:resolve-author-input': defineInvokeChannel({
    channel: 'slack:resolve-author-input',
    request: z.object({
      query: z.string().min(1),
      teamId: z.string().min(1).optional(),
    }),
    response: SlackResolveAuthorInputResponseSchema,
    description:
      'Resolve a free-text Slack author entry (raw ID, @handle, display name, email) to a canonical [UW]… user ID for the allowlist/blocklist UI.',
  }),
};
