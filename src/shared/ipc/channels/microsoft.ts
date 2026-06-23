import { z } from 'zod';
import { defineInvokeChannel, OAuthSetupGuidanceSchema } from '../schemas/common';

const MicrosoftAccountSchema = z.object({
  email: z.string(),
  displayName: z.string().optional(),
  status: z.enum(['active', 'expired', 'error']),
});

export const microsoftChannels = {
  'microsoft:get-accounts': defineInvokeChannel({
    channel: 'microsoft:get-accounts',
    request: z.void(),
    response: z.object({
      accounts: z.array(MicrosoftAccountSchema),
    }),
    description: 'Get all connected Microsoft 365 accounts with status',
  }),

  'microsoft:start-auth': defineInvokeChannel({
    channel: 'microsoft:start-auth',
    request: z.void(),
    response: z.object({
      success: z.boolean(),
      email: z.string().optional(),
      error: z.string().optional(),
      setupGuidance: OAuthSetupGuidanceSchema.optional(),
    }),
    description: 'Start OAuth flow to connect a Microsoft 365 account',
  }),

  'microsoft:remove-account': defineInvokeChannel({
    channel: 'microsoft:remove-account',
    request: z.object({
      email: z.string(),
    }),
    response: z.object({
      success: z.boolean(),
      error: z.string().optional(),
    }),
    description: 'Remove a connected Microsoft 365 account',
  }),

  'microsoft:cancel-auth': defineInvokeChannel({
    channel: 'microsoft:cancel-auth',
    request: z.void(),
    response: z.void(),
    description: 'Cancel any pending OAuth flow',
  }),

  'microsoft:is-connected': defineInvokeChannel({
    channel: 'microsoft:is-connected',
    request: z.void(),
    response: z.object({
      connected: z.boolean(),
    }),
    description: 'Check if a Microsoft 365 account is connected',
  }),

  'microsoft:start-auth-sharepoint': defineInvokeChannel({
    channel: 'microsoft:start-auth-sharepoint',
    request: z.void(),
    response: z.object({
      success: z.boolean(),
      email: z.string().optional(),
      error: z.string().optional(),
      setupGuidance: OAuthSetupGuidanceSchema.optional(),
    }),
    description: 'Start incremental consent OAuth flow to add SharePoint permissions to an existing Microsoft 365 account',
  }),
};
