import { z } from 'zod';
import { defineInvokeChannel, OAuthSetupGuidanceSchema } from '../schemas/common';

const HubSpotAccountSchema = z.object({
  email: z.string(),
  hubId: z.number(),
  status: z.enum(['active', 'expired', 'error']),
  scopeTier: z.enum(['readonly', 'full']).optional(),
});

export const hubspotChannels = {
  'hubspot:get-accounts': defineInvokeChannel({
    channel: 'hubspot:get-accounts',
    request: z.void(),
    response: z.object({
      accounts: z.array(HubSpotAccountSchema),
    }),
    description: 'Get all connected HubSpot accounts with status',
  }),

  'hubspot:start-auth': defineInvokeChannel({
    channel: 'hubspot:start-auth',
    // Request object is optional for backwards compatibility with existing callers
    request: z.object({
      scopeTier: z.enum(['readonly', 'full']).optional(),
    }).optional(),
    response: z.object({
      success: z.boolean(),
      email: z.string().optional(),
      error: z.string().optional(),
      setupGuidance: OAuthSetupGuidanceSchema.optional(),
    }),
    description: 'Start OAuth flow to connect a new HubSpot account',
  }),

  'hubspot:remove-account': defineInvokeChannel({
    channel: 'hubspot:remove-account',
    request: z.object({
      email: z.string(),
    }),
    response: z.object({
      success: z.boolean(),
      error: z.string().optional(),
    }),
    description: 'Remove a connected HubSpot account',
  }),

  'hubspot:cancel-auth': defineInvokeChannel({
    channel: 'hubspot:cancel-auth',
    request: z.void(),
    response: z.void(),
    description: 'Cancel any pending OAuth flow',
  }),
};
